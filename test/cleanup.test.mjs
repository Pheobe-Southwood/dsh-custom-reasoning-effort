/**
 * The cleanup command, exercised as the user runs it: a real child process, a
 * real profile patch file, and a diff of what it left behind.
 *
 * This is the file that keeps the "no residue after uninstall" promise honest.
 * Two properties are load-bearing:
 *
 *   - it removes exactly this plugin's handwriting (`isWrittenEfforts`), which
 *     `normalizer.test.mjs` pins from the other side — a hand-written level set,
 *     a differently spelled one and the explicit `false` must survive;
 *   - it preserves everything else — comments, key order, every other field of
 *     every model, the route's connection facts, and a plugin row that carries
 *     something this command does not own.
 *
 * `--write` is required to modify anything, so the default is a dry run; both
 * paths are asserted.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts', 'cleanup.mjs')

/** A temp directory inside the repository, removed by the caller. */
function tempDir(prefix) {
  const base = join(root, '.test-tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

/**
 * A profile patch carrying everything the command has to judge.
 *
 * Deliberately written the way the harness writes it: with the user's own
 * comments, a `!!js` overlay elsewhere in the file, and the marker row at the
 * bottom, exactly as `configEditor.edit` appends it.
 */
const FIXTURE = `# Your patch layer for this dsh profile.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
    fontSize: 17
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      self-use:
        displayName: 自用
        api: openai-completions
        baseURL: http://127.0.0.1:8317/v1
        models:
          # this one is the plugin's own declaration
          - id: gemini-3.8-flash-high
            name: gemini-3.8-flash-high
            contextWindow: 300000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              high: high
          - id: hand-written
            reasoningEfforts:
              low: reasoning_low
              high: HIGH
          - id: opted-out
            reasoningEfforts: false
          - id: gemini-4-argon
            contextWindow: 300000
        defaultContextWindow: 262144
- id: custom-reasoning-effort
  name: dsh-custom-reasoning-effort
  config:
    residualInputsReclaimed: 1
- id: other-plugin
  config:
    keep: true
`

/** Run the cleanup command and return its stdout, asserting it succeeded. */
function runCleanup(...args) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
}

test('cleanup: a dry run reports what it would do and leaves the file byte-identical', () => {
  const dir = tempDir('cleanup-')
  try {
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, FIXTURE)

    const output = runCleanup('--profile-dir', dir)
    assert.match(output, /^Would clean /)
    assert.match(output, /reasoningEfforts removed from 1 model\(s\): gemini-3\.8-flash-high/)
    assert.match(output, /the plugin's own profile row removed/)
    assert.match(output, /--write/)
    assert.equal(readFileSync(patch, 'utf8'), FIXTURE, 'without --write nothing may change')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: --write removes this plugin’s traces and nothing else', () => {
  const dir = tempDir('cleanup-')
  try {
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, FIXTURE)
    const output = runCleanup('--profile-dir', dir, '--write')
    assert.match(output, /^Cleaned /)

    const after = readFileSync(patch, 'utf8')
    assert.ok(!after.includes('residualInputsReclaimed'), 'the 0.4.0 marker row is gone')
    assert.ok(!after.includes('custom-reasoning-effort'), 'the plugin’s own row is gone entirely')
    assert.ok(!after.includes('off: null'), 'the plugin’s level declaration is gone')

    // Everything else survives verbatim, comments included.
    assert.ok(after.startsWith('# Your patch layer for this dsh profile.\n'))
    assert.ok(after.includes('    preference: system\n    fontSize: 17\n'), 'an unrelated row is untouched')
    assert.ok(after.includes('        displayName: 自用\n'), 'the route keeps its connection facts')
    assert.ok(after.includes("          # this one is the plugin's own declaration\n"), 'comments survive the edit')
    assert.ok(after.includes('            input:\n              - text\n              - image\n'), 'the modality list is not touched')
    assert.ok(after.includes('          - id: hand-written\n            reasoningEfforts:\n              low: reasoning_low\n              high: HIGH\n'),
      'another spelling is the user’s declaration, not a leftover')
    assert.ok(after.includes('          - id: opted-out\n            reasoningEfforts: false\n'), 'the opt-out is a decision, not a leftover')
    assert.ok(after.includes('          - id: gemini-4-argon\n            contextWindow: 300000\n'), 'a model with no declaration is untouched')
    assert.ok(after.includes('- id: other-plugin\n  config:\n    keep: true\n'), 'other rows are untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: a second run finds nothing left to do', () => {
  const dir = tempDir('cleanup-')
  try {
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, FIXTURE)
    runCleanup('--profile-dir', dir, '--write')
    const output = runCleanup('--profile-dir', dir, '--write')
    assert.match(output, /^Nothing to clean /, 'the command is idempotent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: a plugin row carrying more than the marker is left for the user', () => {
  const dir = tempDir('cleanup-')
  try {
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, [
      '- id: custom-reasoning-effort',
      '  name: dsh-custom-reasoning-effort',
      '  config:',
      '    residualInputsReclaimed: 1',
      '    reconcileIntervalMs: 5000',
      '',
    ].join('\n'))
    const output = runCleanup('--profile-dir', dir, '--write')
    assert.match(output, /a custom-reasoning-effort row was kept: it carries residualInputsReclaimed, reconcileIntervalMs/)
    assert.ok(readFileSync(patch, 'utf8').includes('reconcileIntervalMs'), 'the row is the user’s and stays')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: --json reports the same facts in a machine-readable shape', () => {
  const dir = tempDir('cleanup-')
  try {
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, FIXTURE)
    const summary = JSON.parse(runCleanup('--profile-dir', dir, '--json'))
    assert.deepEqual(summary.models, ['gemini-3.8-flash-high'])
    assert.equal(summary.rowsRemoved, 1)
    assert.deepEqual(summary.rowsKept, [])
    assert.equal(summary.written, false)
    assert.equal(summary.patchPath, patch)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: a missing profile and a broken patch fail loudly', () => {
  const dir = tempDir('cleanup-')
  try {
    assert.throws(() => runCleanup('--profile-dir', join(dir, 'nowhere')), /ENOENT/, 'a profile that does not exist is an error')

    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, '- id: [unclosed\n')
    assert.throws(() => runCleanup('--profile-dir', dir), /cleanup failed/)
    assert.equal(readFileSync(patch, 'utf8'), '- id: [unclosed\n', 'a patch it cannot read is never rewritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup: the command and its vocabulary ship with the package', () => {
  assert.equal(existsSync(script), true, 'scripts/cleanup.mjs must be a real file')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(manifest.files.includes('scripts'), 'scripts/ must be in `files`, or the command never reaches an install')
  assert.equal(manifest.scripts.cleanup, 'node scripts/cleanup.mjs', 'npm run cleanup is the documented entry')
  assert.ok(readFileSync(script, 'utf8').includes("from '../lib/normalize.js'"), 'the command shares the planner’s handwriting predicate instead of restating it')
})
