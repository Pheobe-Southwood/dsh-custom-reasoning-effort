#!/usr/bin/env node
/**
 * Remove everything this plugin wrote into one DSH profile.
 *
 * WHY a standalone command instead of a plugin feature: the plugin cannot run
 * after it has been uninstalled, so "no residue" has to be a step the user can
 * take without it. This script is that step, and it is deliberately the only
 * part of this package that needs a YAML library — the plugin itself imports
 * nothing but Node builtins.
 *
 * WHAT is removed, and why exactly this much:
 *
 *   1. `reasoningEfforts` declarations this plugin wrote, on the models of the
 *      `llm-pi-ai` provider routes. The bound is the plugin's own handwriting
 *      (`isWrittenEfforts` in `lib/normalize.js`): every level spelled as its own
 *      name, `off` as `null`. A hand-written level set with any other spelling,
 *      and the explicit `false` opt-out, are left untouched.
 *   2. The plugin's own row in the profile patch, when all it carries is the
 *      migration marker an older release needed (`residualInputsReclaimed`). A
 *      row carrying anything else is the user's and is left alone, with a note.
 *
 * WHAT is deliberately kept: the plugin's `llm-pi-ai` route itself, its
 * connection facts, and every other field on every model (name, context window,
 * modalities, compat). This command edits two things and nothing else.
 *
 * Formatting is preserved: the file is edited through a YAML document, so
 * comments and key order survive, and the write is atomic (temp file + rename).
 *
 * RUN IT WITH THE HARNESS STOPPED. A running instance holds the same document in
 * memory and may rewrite the file from it, silently undoing this edit.
 *
 * Usage:
 *   node scripts/cleanup.mjs --profile web            # show what would change
 *   node scripts/cleanup.mjs --profile web --write    # apply it
 *   node scripts/cleanup.mjs --profile-dir /path/to/profile --write
 *
 * @module dsh-custom-reasoning-effort/cleanup
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { isWrittenEfforts } from '../lib/normalize.js'

const PLUGIN_ROW_ID = 'custom-reasoning-effort'
const MARKER_FIELD = 'residualInputsReclaimed'
const PI_AI_ROW_ID = 'llm-pi-ai'

/** The command line, parsed by hand: this script has no argument parser. */
function parseArguments(argv) {
  const options = { write: false, json: false, help: false, profile: undefined, profileDir: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write') options.write = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--profile') options.profile = argv[++index]
    else if (argument === '--profile-dir') options.profileDir = argv[++index]
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

/** The profile directory the command operates on. */
function profileDirectory(options) {
  if (typeof options.profileDir === 'string' && options.profileDir.length > 0) return resolve(options.profileDir)
  const profile = typeof options.profile === 'string' && options.profile.length > 0
    ? options.profile
    : process.env.DSH_PROFILE
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new Error('name the profile with --profile <name> (or set DSH_PROFILE), or point at it with --profile-dir <path>')
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'profiles', profile))
}

/** A YAML node's plain JavaScript value, when it is a map. */
function plainValue(node) {
  if (node === undefined || node === null) return undefined
  return typeof node.toJSON === 'function' ? node.toJSON() : node
}

/** A string field of a YAML map node. */
function stringField(node, key) {
  if (!isMap(node)) return undefined
  const value = node.get(key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Delete every declaration this plugin could have written.
 *
 * @param document - the parsed profile patch document.
 * @returns the ids whose declaration was removed.
 */
function stripWrittenEfforts(document) {
  const removed = []
  if (!isSeq(document.contents)) return removed
  for (const row of document.contents.items) {
    if (stringField(row, 'id') !== PI_AI_ROW_ID || !isMap(row)) continue
    const config = row.get('config')
    if (!isMap(config)) continue
    const providers = config.get('providers')
    if (!isMap(providers)) continue
    for (const profile of providers.items) {
      const profileValue = profile.value
      if (!isMap(profileValue)) continue
      const models = profileValue.get('models')
      if (!isSeq(models)) continue
      for (const model of models.items) {
        if (!isMap(model)) continue
        const id = stringField(model, 'id')
        const value = plainValue(model.get('reasoningEfforts'))
        if (id === undefined || !isWrittenEfforts(value)) continue
        model.delete('reasoningEfforts')
        removed.push(id)
      }
    }
  }
  return removed
}

/**
 * Delete this plugin's own rows, when they carry nothing but its marker.
 *
 * @param document - the parsed profile patch document.
 * @returns `{ removed, kept }` — row indices removed, and rows kept because they
 *   carry something this command does not own.
 */
function stripPluginRows(document) {
  const removed = []
  const kept = []
  if (!isSeq(document.contents)) return { removed, kept }
  for (let index = document.contents.items.length - 1; index >= 0; index -= 1) {
    const row = document.contents.items[index]
    if (stringField(row, 'id') !== PLUGIN_ROW_ID || !isMap(row)) continue
    const config = plainValue(row.get('config'))
    const keys = config === null || typeof config !== 'object' ? [] : Object.keys(config)
    if (keys.some((key) => key !== MARKER_FIELD)) {
      kept.push(keys.length === 0 ? '(an empty config)' : keys.join(', '))
      continue
    }
    document.contents.items.splice(index, 1)
    removed.push(index)
  }
  return { removed, kept }
}

const USAGE = `Usage: node scripts/cleanup.mjs [--profile <name> | --profile-dir <path>] [--write] [--json]

Removes what dsh-custom-reasoning-effort wrote into one DSH profile:
  - the reasoningEfforts declarations it filled on custom-provider models
  - its own row in the profile patch, when it carries only the 0.4.0 migration marker

Without --write nothing is modified; the command only reports what it would do.
Run it with the harness stopped: a running instance may rewrite the file from memory.`

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const directory = profileDirectory(options)
  const patchPath = join(directory, 'cordis.patch.yml')
  const before = await readFile(patchPath, 'utf8')
  const document = parseDocument(before, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  })
  if (document.errors.length > 0) throw document.errors[0]

  const models = stripWrittenEfforts(document)
  const rows = stripPluginRows(document)

  const summary = {
    profileDir: directory,
    patchPath,
    models,
    rowsRemoved: rows.removed.length,
    rowsKept: rows.kept,
    written: false,
  }
  const removable = models.length > 0 || rows.removed.length > 0
  if (!removable && rows.kept.length === 0) {
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else process.stdout.write(`Nothing to clean in ${patchPath}: no declaration of this plugin's shape and no marker row.\n`)
    return 0
  }

  // A kept row is a report, not a reason to rewrite the file: nothing about it
  // is this command's to change.
  if (options.write && removable) {
    const next = String(document)
    const temporary = `${patchPath}.tmp-${String(process.pid)}`
    await writeFile(temporary, next, { mode: 0o600 })
    await rename(temporary, patchPath)
    summary.written = true
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  }
  const lines = [
    `${summary.written ? 'Cleaned' : 'Would clean'} ${patchPath}`,
    ...models.length === 0 ? [] : [`  reasoningEfforts removed from ${String(models.length)} model(s): ${models.join(', ')}`],
    ...rows.removed.length === 0 ? [] : ['  the plugin\'s own profile row removed (it held only the 0.4.0 migration marker)'],
    ...rows.kept.length === 0 ? [] : [`  a ${PLUGIN_ROW_ID} row was kept: it carries ${rows.kept.join('; ')}, which this command does not own`],
    ...summary.written || !removable ? [] : ['', 'Nothing was modified. Re-run with --write to apply.', 'Stop the harness first: a running instance may rewrite the file from memory.'],
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

main().then((code) => {
  process.exitCode = code
}, (error) => {
  process.stderr.write(`cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
