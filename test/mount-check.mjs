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

// --- runtime dependencies ---------------------------------------------------
//
// The reclaim marker needs a settings namespace of this plugin's own, and the
// settings service derives those from active Loader entries whose runtime
// declares a `Config` schema (`dsh-settings/lib/index.js:539`). That is the one
// reason this package ships a runtime dependency at all, so the set is pinned
// here rather than left to grow: it is the harness's own schema library, versioned
// in lockstep with the harness, and nothing else.
const allowedRuntimeDependencies = ['@deepseek-ai/schemastery']
const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort()
assert.deepEqual(
  runtimeDependencies,
  allowedRuntimeDependencies,
  `the only runtime dependency may be ${allowedRuntimeDependencies.join(', ')}: it is what makes the plugin's own row configurable`,
)
for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
  assert.equal(typeof range, 'string', `${dependency} must pin a range`)
  assert.ok(range.length > 0, `${dependency} must pin a range`)
}
assert.equal(
  manifest.dependencies?.['@deepseek-ai/schemastery'],
  '~3.18.4',
  'the schema library is pinned to the harness-compatible line, so a drift can only come from an explicit edit',
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
  'the entry declares the catalog and settings services it needs — and nothing else: `config` is the entry value the marker is read from, and injecting it would leave the plugin pending forever',
)
assert.equal(typeof entry.Config, 'function', 'the entry declares a Config schema, which is what makes its own row a writable settings namespace')

// --- the row config, which is also the reclaim marker ----------------------
//
// The one-shot cleanup writes `residualInputsReclaimed` into this plugin's own
// row config, so two properties are load-bearing and are asserted here: the
// field exists in the schema (an undeclared path is refused by the settings
// seam), and it is VOLATILE (only schema-declared volatile fields survive a
// settings write). Losing either turns the cleanup into a permanently re-armed
// deletion, which is the one failure mode this plugin must not have.
const configSchema = entry.Config.toJSON()
const configDict = configSchema.refs[configSchema.uid]?.dict ?? {}
const configFieldNames = Object.keys(configDict)
assert.equal(configFieldNames.length, 1, `the marker schema carries exactly one field, saw ${configFieldNames.join(', ')}`)
assert.equal(
  configFieldNames[0],
  'residualInputsReclaimed',
  'the marker field is the one the reclaim reads and writes',
)
assert.equal(
  configSchema.refs[configDict[configFieldNames[0]]]?.meta?.volatile,
  true,
  'the marker must be volatile: a settings write keeps nothing else',
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

// The row must carry a config block, because a Loader entry with no `config`
// has no settings namespace at all: the reclaim marker would have nowhere to be
// written, and the cleanup would re-arm on every boot. An empty mapping is what
// this file ships; the first write adds the marker field to it.
assert.match(
  patchText.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n'),
  /^\s{6}config:\s*\{\}\s*$/m,
  'the row must declare an (empty) config block so the marker has a namespace',
)

console.log(`MOUNT CHECK: ALL PASS (${rootPath}, ${modules.length} lib module(s), row id=${rowId}, name=${rowName})`)
