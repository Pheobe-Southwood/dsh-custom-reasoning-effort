/**
 * Bundle-wiring check: proves this package mounts itself.
 *
 * Two parity rules keep the mount honest, and both are asserted here:
 *
 *   - the package declares `dsh.bundle.patch`, and `files` ships that patch, so
 *     an npm publish cannot drop the only mount row;
 *   - the patch's row `name` is this package's name, and its `id` equals the
 *     `name` the host half exports, so the row and the plugin are recognizably
 *     the same thing.
 *
 * The patch is parsed by a shape-specific reader rather than a YAML dependency:
 * this package deliberately has no runtime dependencies at all, and the file's
 * shape is one `insert:` list of `id`/`name` scalars (see the file's own
 * comments).
 *
 * Run with `npm run test:mount`.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)

const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

// --- entry points -----------------------------------------------------------

assert.equal(manifest.name, 'dsh-custom-reasoning-effort', 'package name is the published id')
assert.equal(manifest.main, 'lib/index.js', 'main must resolve the Cordis entry')
assert.equal(manifest.exports?.['.'], './lib/index.js', 'exports["."] must resolve the Cordis entry')
assert.equal(
  manifest.exports?.['./client'],
  undefined,
  'this plugin has no client half, so it must not export one',
)
assert.equal(
  manifest.dsh?.client,
  undefined,
  'this plugin has no client half, so it must not declare dsh.client',
)
assert.equal(
  manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0,
  true,
  'a plugin with no runtime dependencies cannot drift with the harness',
)

// --- the bundle declaration and the file it points at -----------------------

const declaredPatch = manifest.dsh?.bundle?.patch
assert.equal(declaredPatch, './cordis.patch.yml', 'the bundle must declare its patch file')
assert.ok(
  manifest.files?.includes(declaredPatch.replace(/^\.\//, '')),
  `package.json files must ship ${declaredPatch}: a publish would otherwise drop the only mount row`,
)

// --- the entry module and its exports --------------------------------------

const entry = await import(new URL('lib/index.js', root))
assert.equal(entry.name, 'custom-reasoning-effort', 'the entry name is the row id')
assert.equal(typeof entry.apply, 'function', 'apply is exported')
assert.deepEqual(
  entry.inject,
  ['llm', 'settings'],
  'the entry declares the catalog and settings services it needs',
)

// Every module must import cleanly: a broken sibling would activate a plugin
// whose normalizer never arrives.
const libEntries = await readdir(new URL('lib/', root), { withFileTypes: true })
const modules = libEntries.filter((item) => item.isFile() && item.name.endsWith('.js')).map((item) => item.name)
assert.ok(modules.length >= 1, `expected the lib modules to be present, saw ${modules.join(', ')}`)
for (const module of modules) {
  const loaded = await import(new URL(`lib/${module}`, root))
  assert.ok(loaded !== null && typeof loaded === 'object', `lib/${module} must import cleanly`)
}

// --- the patch: exactly one insert row, with matching names -----------------

const patchText = await readFile(new URL('cordis.patch.yml', root), 'utf8')

const topLevelEntries = patchText
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .filter((line) => /^-\s/.test(line) || /^-\s*$/.test(line))
assert.equal(
  topLevelEntries.length,
  1,
  'the patch has exactly one top-level entry (a second one would patch another layer)',
)
assert.match(topLevelEntries[0], /^-\s*insert:\s*$/, 'the only top-level entry is an insert')

const insertedRows = patchText
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .filter((line) => /^\s{4}-\s/.test(line))
assert.equal(insertedRows.length, 1, `the insert carries exactly one row, saw ${insertedRows.length}`)

const readScalar = (key) => {
  // A row such as `- id: custom-reasoning-effort` carries its key after a
  // sequence dash, so the dash is part of the scalar line rather than an
  // indentation.
  const match = patchText.match(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.+?)\\s*$`, 'm'))
  return match === null ? undefined : match[1].replace(/^['"]|['"]$/g, '')
}

const rowId = readScalar('id')
const rowName = readScalar('name')
assert.equal(rowName, manifest.name, 'the row name must be the package name so the Loader resolves it')
assert.equal(rowId, 'custom-reasoning-effort', 'the row id is the plugin id this package publishes')
assert.equal(rowId, entry.name, 'the row id must equal the name the host half exports')

console.log(`MOUNT CHECK: ALL PASS (${rootPath}, ${modules.length} lib module(s), row id=${rowId}, name=${rowName})`)
