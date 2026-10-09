/**
 * Bundle-wiring check: proves this package mounts both of its components.
 *
 * Parity rules keep the mount honest, and all of them are asserted here:
 *
 *   - the package declares `dsh.bundle.patch`, and `files` ships that patch, so
 *     an npm publish cannot drop the mount rows;
 *   - each row's `name` is the name of the package that ships its code, and its
 *     `id` equals the `name` that host half exports, so the row and the plugin
 *     are recognizably the same thing;
 *   - the second component's row resolves through THIS package: its name is not
 *     a subpath (a subpath is not a package to DSH, so the panel would get no
 *     metadata), the sub-package is shipped by `files`, and the reference that
 *     puts it into the runtime resolution is a peer — never a `dependencies`
 *     entry, which pnpm resolves against the profile directory and fails on.
 *     That last invariant is what `test/packaging.test.mjs` proves on a real
 *     `npm pack` artifact; here it is pinned against silent edits.
 *
 * The patch is parsed by a shape-specific reader rather than a YAML dependency:
 * this package deliberately has no runtime dependencies beyond the harness's own
 * schema library (see below), and the file's shape is one `insert:` list of
 * `id`/`name` scalars (see the file's own comments).
 *
 * Run with `npm run test:mount`.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { patchRows } from './cordis-patch.mjs'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)

const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const subpackage = JSON.parse(await readFile(new URL('effort-memory/package.json', root), 'utf8'))

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

// --- how the sub-package reaches the runtime resolution ---------------------
//
// Three shapes were tried and two of them are install failures, so both are
// pinned as regressions here:
//   - `dependencies: { "dsh-effort-memory": "file:./effort-memory" }` makes pnpm
//     resolve that relative path against the PROFILE directory, where nothing
//     named effort-memory/ exists: the whole install dies;
//   - `bundledDependencies` is recorded as lockfile metadata only, so the entry
//     never joins the dependency graph and nobody installs it;
//   - the peer declaration is what makes DSH's dependencyClosure walk the edge
//     (it reads `dependencies` + `peerDependencies`). Without it the link can
//     exist inside the package and the row still fails to import.
assert.equal(
  manifest.peerDependencies?.['dsh-effort-memory'],
  'file:./effort-memory',
  'the sub-package must be declared as a peer so the runtime resolution walks the edge',
)
assert.equal(
  manifest.dependencies?.['dsh-effort-memory'],
  undefined,
  'a `file:` entry in dependencies is resolved against the profile and fails the install',
)
assert.equal(manifest.bundledDependencies, undefined, 'bundledDependencies never delivers a resolvable package')
assert.equal(manifest.optionalDependencies, undefined, 'optionalDependencies silently drops the `file:` entry')
assert.equal(
  manifest.scripts?.postinstall,
  'node scripts/link-effort-memory-package.mjs',
  'the postinstall inside the installed package is what creates the link',
)

// --- the bundle declaration and the file it points at -----------------------

const declaredPatch = manifest.dsh?.bundle?.patch
assert.equal(declaredPatch, './cordis.patch.yml', 'the bundle must declare its patch file')
assert.ok(
  manifest.files?.includes(declaredPatch.replace(/^\.\//, '')),
  `package.json files must ship ${declaredPatch}: a publish would otherwise drop the only mount row`,
)
for (const shipped of ['effort-memory', 'scripts']) {
  assert.ok(
    manifest.files?.includes(shipped),
    `package.json files must ship ${shipped}: without it the sub-package (or the postinstall that links it) never reaches the install`,
  )
}

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
// whose normalizer never arrives — or a memory whose rules never load.
const libEntries = await readdir(new URL('lib/', root), { withFileTypes: true })
const modules = libEntries.filter((item) => item.isFile() && item.name.endsWith('.js')).map((item) => item.name)
assert.ok(modules.length >= 1, `expected the lib modules to be present, saw ${modules.join(', ')}`)
for (const module of modules) {
  const loaded = await import(new URL(`lib/${module}`, root))
  assert.ok(loaded !== null && typeof loaded === 'object', `lib/${module} must import cleanly`)
}
const memoryEntries = await readdir(new URL('effort-memory/', root), { withFileTypes: true })
const memoryModules = memoryEntries.filter((item) => item.isFile() && item.name.endsWith('.js')).map((item) => item.name)
assert.ok(memoryModules.length >= 1, `expected the sub-package modules to be present, saw ${memoryModules.join(', ')}`)
for (const module of memoryModules) {
  const loaded = await import(new URL(`effort-memory/${module}`, root))
  assert.ok(loaded !== null && typeof loaded === 'object', `effort-memory/${module} must import cleanly`)
}

// --- the patch: one insert, two rows, each matching its own package ---------

const patchText = await readFile(new URL('cordis.patch.yml', root), 'utf8')
const stripped = patchText.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n')

const rows = patchRows(patchText)
assert.deepEqual(
  rows,
  [
    { id: 'custom-reasoning-effort', name: manifest.name },
    { id: 'effort-memory', name: subpackage.name },
  ],
  'the patch inserts the normalizer and the memory, each named after the package that ships it',
)
// Row ids are what the plugin panel writes `disabled` overrides against, so
// they must stay unique and stable — the memory's id is the one the standalone
// dsh-effort-memory bundle used, which is also why a profile that lists both
// cannot boot (a repeated entry id is a Loader failure).
assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'row ids must be unique')
for (const row of rows) {
  assert.ok(!row.name.includes('/'), `${row.name} must be a bare package name: a subpath specifier resolves to no package, so the panel gets no metadata for the row`)
}

const topLevelEntries = stripped
  .split('\n')
  .filter((line) => /^-\s/.test(line) || /^-\s*$/.test(line))
assert.equal(
  topLevelEntries.length,
  1,
  'the patch has exactly one top-level entry (a second one would patch another layer)',
)
assert.match(topLevelEntries[0], /^-\s*insert:\s*$/, 'the only top-level entry is an insert')

const insertedRows = stripped.split('\n').filter((line) => /^\s{4}-\s/.test(line))
assert.equal(insertedRows.length, rows.length, `the insert carries exactly one row per component, saw ${insertedRows.length}`)
assert.equal(
  stripped.match(/^\s{6}config:\s*\{\}\s*$/gm)?.length,
  1,
  'exactly one row carries a config block: only the normalizer keeps a marker there, and an entry with no config has no namespace to write it to',
)

// The sub-package's own half has to be mountable by that row.
const memory = await import(new URL('effort-memory/index.js', root))
assert.equal(memory.name, 'effort-memory', 'the memory host half exports the row id')
assert.equal(typeof memory.apply, 'function', 'the memory host half exports apply')
assert.deepEqual(memory.inject, ['llm', 'sessionController'], 'the memory declares only the two services it cannot run without')
assert.equal(memory.default, undefined, 'no default export: the Loader mounts the named shape')
assert.equal(subpackage.version, manifest.version, 'the sub-package version tracks the root version, so a release cannot ship a stale one')

console.log(`MOUNT CHECK: ALL PASS (${rootPath}, ${modules.length + memoryModules.length} module(s), rows=${rows.map((row) => row.id).join('+')})`)
