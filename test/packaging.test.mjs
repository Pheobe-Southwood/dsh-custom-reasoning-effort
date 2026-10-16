/**
 * Packaging invariants: the artifact an installer receives actually carries the
 * sub-package, and the sub-package's Loader row resolves out of it.
 *
 * Testing the working tree would miss the defect this file exists for. Inside
 * the checkout, `effort-memory/` is a plain sibling directory and a developer
 * with `npm install` behind them often has `node_modules/dsh-effort-memory`
 * linked already — so every resolution succeeds locally while a real install
 * fails. The shipped artifact is the only honest subject, so this test:
 *
 *   1. runs a real `npm pack` and reads the tarball (never `npm publish`), into
 *      a temp directory inside the repository;
 *   2. asserts the sub-package and the postinstall script are IN the artifact,
 *      and that no `node_modules/**` entry is;
 *   3. as the installer would, replicates the install state inside the
 *      *extracted* package: `node_modules/<name>/package.json` must NOT exist
 *      yet, and running the postinstall must create it there;
 *   4. resolves the row's bare package name with the very primitive DSH uses —
 *      `createRequire(<package>.package.json).resolve.paths(name)` plus a probe
 *      for `<searchPath>/<name>/package.json`
 *      (`packages/boot/app-boot/src/profile.ts#packageDirFromAnchor`) — and
 *      asserts it lands on the sub-package INSIDE the extracted package;
 *   5. resolves the three specifiers the plugin panel reads through the exports
 *      map (`<name>`, `<name>/package.json`, `<name>/locale/zh.json`).
 *
 * Step 3 is what keeps the whole file non-vacuous: the resolution in step 4 is
 * asserted to be impossible before the postinstall runs and possible after, so
 * the link is proven load-bearing rather than assumed.
 *
 * The child process is spawned with `stdio: 'ignore'` on purpose: a confined
 * sandbox refuses a grandchild with piped stdio (`spawn EPERM`), and the pack
 * destination is known, so there is nothing to read back from the child.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { ensureSubpackageLink, packageRoot as scriptPackageRoot, subpackageLink, SUBPACKAGE_NAME } from '../scripts/link-effort-memory-package.mjs'
import { patchRows } from './cordis-patch.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const subpackage = JSON.parse(readFileSync(join(root, 'effort-memory', 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

/** A temp directory inside the repository, removed by the caller. */
function tempDir(prefix) {
  const base = join(root, '.test-tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

/**
 * `npm pack` this package and extract the tarball into `dest/unpacked`.
 * @param {string} dest - a temp directory to pack into.
 * @returns {{ extract: string, entries: { rel: string, type: string }[] }} the extraction root and the artifact's entries.
 */
function packAndExtract(dest) {
  // A cache inside the workspace: the default one lives under the user profile,
  // which a confined run may not be allowed to write.
  const cache = join(dest, 'cache')
  execFileSync('npm', ['pack', '--pack-destination', dest, '--cache', cache], {
    cwd: root, shell: true, stdio: 'ignore',
  })
  const tarballs = readdirSync(dest).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `npm pack must produce exactly one tarball, saw ${tarballs.join(', ') || '(none)'}`)

  const tar = gunzipSync(readFileSync(join(dest, tarballs[0])))
  const extract = join(dest, 'unpacked')
  mkdirSync(extract, { recursive: true })
  const entries = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const body = tar.subarray(offset + 512, offset + 512 + size)
    const rel = name.replace(/^package\//, '')
    entries.push({ rel, type })
    if (type === '5') {
      mkdirSync(join(extract, rel), { recursive: true })
    } else if (type === '2' || type === '1') {
      // A link is written as its target text: a plain extractor drops it, and
      // the only question asked of it here is whether it dangles.
      mkdirSync(dirname(join(extract, rel)), { recursive: true })
      writeFileSync(join(extract, rel), body.toString('utf8'))
    } else {
      const file = join(extract, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return { extract, entries }
}

/**
 * The primitive `packageDirFromAnchor` implements: walk the require resolution
 * paths of `anchor` and take the first one holding `<name>/package.json`.
 * @param {string} anchor - absolute path of a package.json.
 * @param {string} name - the bare package name to resolve.
 * @returns {string | undefined} the resolved package directory.
 */
function resolveFromAnchor(anchor, name) {
  const searchPaths = createRequire(anchor).resolve.paths(name) ?? []
  return searchPaths.map((searchPath) => join(searchPath, name)).find((candidate) => existsSync(join(candidate, 'package.json')))
}

test('packaging: the sub-package ships, the postinstall links it, and the row resolves out of the artifact', async () => {
  const dir = tempDir('pack-')
  try {
    const { extract, entries } = packAndExtract(dir)
    const rels = entries.map((entry) => entry.rel)

    // 1) Both halves of the delivery must be IN the artifact. A link under
    //    node_modules/ is not a delivery mechanism: pnpm drops the repository's
    //    node_modules/** when it packs a git-hosted package.
    for (const shipped of [
      'effort-memory/package.json',
      'effort-memory/index.js',
      'effort-memory/decide.js',
      'effort-memory/locale/en.json',
      'effort-memory/locale/zh.json',
      'scripts/link-effort-memory-package.mjs',
      'cordis.patch.yml',
    ]) {
      assert.ok(rels.includes(shipped), `the artifact is missing ${shipped}; top-level entries: ${[...new Set(rels.map((rel) => rel.split('/')[0]))].join(', ')}`)
    }
    assert.ok(!rels.some((rel) => rel.startsWith('node_modules/')),
      'the artifact must not carry repository node_modules content: pnpm drops it, and it would mask the real resolution')

    // 2) The artifact's own wiring has to be the wiring under test.
    const shippedManifest = JSON.parse(readFileSync(join(extract, 'package.json'), 'utf8'))
    assert.equal(shippedManifest.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal(shippedManifest.peerDependencies?.[SUBPACKAGE_NAME], 'file:./effort-memory',
      'the peer declaration is what makes the runtime resolution walk the edge')
    assert.deepEqual(
      patchRows(readFileSync(join(extract, 'cordis.patch.yml'), 'utf8')),
      patchRows(patch),
      'the shipped patch must carry the same rows as the working tree',
    )
    assert.equal(
      JSON.parse(readFileSync(join(extract, 'effort-memory', 'package.json'), 'utf8')).name,
      SUBPACKAGE_NAME,
      'the shipped sub-package manifest must declare the row name',
    )

    // 3) No link yet: this is the install state BEFORE the postinstall runs, and
    //    it is the state that produced `failed to import` in a real profile.
    const anchor = join(extract, 'package.json')
    assert.equal(existsSync(join(extract, 'node_modules', SUBPACKAGE_NAME, 'package.json')), false,
      'the artifact must not already carry the link: the postinstall is the only thing that creates it')

    // 4) Run the postinstall exactly as an installer would, inside the
    //    extracted package, and prove the link is what flips the resolution.
    const outcome = await ensureSubpackageLink(extract)
    assert.notEqual(outcome, 'skipped', 'the postinstall must be able to deliver the sub-package')
    assert.equal(existsSync(join(extract, 'node_modules', SUBPACKAGE_NAME, 'package.json')), true,
      'the postinstall must create node_modules/<name>/package.json inside the package')

    // 5) Every row whose name is not this package's must resolve from this
    //    package's anchor — the primitive packageDirFromAnchor uses.
    for (const row of patchRows(patch)) {
      if (row.name === manifest.name) continue
      assert.equal(resolveFromAnchor(anchor, row.name), join(extract, 'node_modules', row.name),
        `row ${row.id} (${row.name}) must resolve to the in-package sub-package;\nsearch paths:\n  ${(createRequire(anchor).resolve.paths(row.name) ?? []).join('\n  ')}`)
    }

    // 6) The plugin panel reads these three specifiers through the exports map;
    //    a missing `./locale/*` or `./package.json` export costs the row its
    //    title and description, silently.
    const require = createRequire(anchor)
    for (const specifier of [SUBPACKAGE_NAME, `${SUBPACKAGE_NAME}/package.json`, `${SUBPACKAGE_NAME}/locale/zh.json`]) {
      const resolved = require.resolve(specifier)
      assert.ok(resolved.startsWith(extract), `${specifier} must resolve inside the extracted package, saw ${resolved}`)
    }
    assert.equal(JSON.parse(readFileSync(require.resolve(`${SUBPACKAGE_NAME}/package.json`), 'utf8')).name, subpackage.name)

    // 7) Nothing in the artifact may reference a path that is not in it.
    for (const entry of entries) {
      if (entry.type !== '2' && entry.type !== '1') continue
      const target = readFileSync(join(extract, entry.rel), 'utf8')
      assert.ok(existsSync(join(extract, dirname(entry.rel), target)), `the artifact's link ${entry.rel} -> ${target} dangles`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the postinstall script resolves the package root from its own location', () => {
  assert.equal(resolve(scriptPackageRoot), resolve(root),
    'the script must resolve the package root from itself, never from the cwd a package manager happens to use')
  assert.deepEqual(subpackageLink(root), {
    path: join(root, 'node_modules', SUBPACKAGE_NAME),
    target: join(root, 'effort-memory'),
  }, 'the link must point at the in-package sub-package directory')
  assert.equal(lstatSync(join(root, 'scripts', 'link-effort-memory-package.mjs')).isFile(), true,
    'the postinstall script must be a real file in the package')
})
