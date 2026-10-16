/**
 * Unit tests for the planning rules: what a model's `reasoningEfforts` becomes,
 * what is left alone, and what the cleanup command is allowed to delete.
 *
 * Every fixture is a plain object: the planner is pure, so no Cordis runtime, no
 * settings service and no I/O is involved. The two shipped functions the plans
 * are judged against are mirrored here in miniature, with the lines they mirror
 * named — `resolveModelReasoning`'s `thinkingLevelMap` construction
 * (`dsh-llm-pi-ai/lib/index.js:575-580`) and pi-ai's level filter
 * (`@earendil-works/pi-ai/dist/models.js:551-560`) — so a case can assert the
 * level list the picker would actually show, not just the dict.
 *
 * The `input` modality list is not this planner's business: the shipped Models
 * settings page owns that field (`dsh-client-ui-settings-models`,
 * `inputField: "input"`), so the cases here only assert that the planner carries
 * an existing list through untouched. The level source itself — the models.dev
 * document, its union rule and its fetch state machine — is
 * `test/modelsdev.test.mjs`; the command that deletes what this plugin wrote is
 * `test/cleanup.test.mjs`.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_REASONING_EFFORTS,
  THINKING_LEVELS,
  customModelIds,
  defaultReasoningEfforts,
  effortsForLevels,
  isWrittenEfforts,
  planNormalization,
  plannedEfforts,
  withoutRoutes,
} from '../lib/normalize.js'

// --- fixtures ---------------------------------------------------------------

/** The two routes every case uses: the one this plugin owns, and a catalog one. */
const CUSTOM = 'verify-gateway'
const CATALOG = 'openai'

/** A capability map as `lib/index.js` builds it from the models.dev index. */
const catalogOf = (levels, catalogRoutes = [CATALOG]) => ({
  catalogRoutes,
  levels: new Map(Object.entries(levels)),
})

/** A persisted `llm-pi-ai` layer holding the given models on the custom route. */
const snapshotOf = (models, profile = {}) => ({
  providers: { [CUSTOM]: { baseURL: 'https://gateway.example/v1', api: 'openai-completions', models, ...profile } },
})

/** The path op one route's models produce. */
const opFor = (plan, route = CUSTOM) => plan.ops.find((op) => op.path[1] === route)

/**
 * The level list the shipped picker would show for one written dict.
 *
 * Mirrors pi-ai's `getSupportedThinkingLevels`
 * (`@earendil-works/pi-ai/dist/models.js:551-560`) over the map
 * `resolveModelReasoning` builds (`dsh-llm-pi-ai/lib/index.js:575-580`): a level
 * declared with a wire spelling is offered, `off: null` leaves the map's `off`
 * undefined and is therefore offered as "send nothing", and an absent level is
 * mapped to null and dropped.
 */
const pickerLevels = (efforts) => {
  const map = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) map[level] = null
    else if (wire !== null) map[level] = wire
  }
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

// --- the vocabulary ---------------------------------------------------------

test('the level vocabulary is the harness’s, in escalation order', () => {
  assert.deepEqual([...THINKING_LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(Object.keys(DEFAULT_REASONING_EFFORTS), [...THINKING_LEVELS])
  assert.equal(DEFAULT_REASONING_EFFORTS.off, null, 'off is "send nothing", which only null expresses')
  for (const level of THINKING_LEVELS) {
    if (level === 'off') continue
    assert.equal(DEFAULT_REASONING_EFFORTS[level], level, `${level} is spelled with its own name`)
  }
})

test('defaultReasoningEfforts hands back a fresh, mutable copy', () => {
  const first = defaultReasoningEfforts()
  first.max = 'changed'
  assert.equal(defaultReasoningEfforts().max, 'max', 'the frozen standard set is never handed out directly')
})

// --- effortsForLevels -------------------------------------------------------

test('effortsForLevels spells each level as its own name and off as null', () => {
  assert.deepEqual(effortsForLevels(['low', 'off', 'high']), { off: null, low: 'low', high: 'high' })
  assert.deepEqual(Object.keys(effortsForLevels(['max', 'medium'])), ['medium', 'max'], 'the canonical order is the vocabulary order')
  assert.deepEqual(pickerLevels(effortsForLevels(['off', 'low', 'max'])), ['off', 'low', 'max'], 'the picker offers exactly the declared set')
})

test('effortsForLevels refuses a set the schema cannot express', () => {
  assert.equal(effortsForLevels([]), undefined)
  assert.equal(effortsForLevels(['off']), undefined, 'nothing beyond off is not a declaration')
  assert.equal(effortsForLevels(['off', 'bogus']), undefined, 'a level outside the vocabulary is not copied')
  assert.equal(effortsForLevels(undefined), undefined)
})

// --- isWrittenEfforts -------------------------------------------------------
//
// This predicate is the cleanup command's whole safety argument: it decides what
// may be deleted from a user's document, so both directions are pinned here.

test('isWrittenEfforts recognizes exactly this plugin’s handwriting', () => {
  assert.equal(isWrittenEfforts({ off: null, low: 'low', high: 'high' }), true)
  assert.equal(isWrittenEfforts({ ...DEFAULT_REASONING_EFFORTS }), true, 'the standard set is this plugin’s own fallback')
  assert.equal(isWrittenEfforts({ max: 'max' }), true, 'off is not required: the shape is the spelling')
})

test('isWrittenEfforts leaves anything a user could have written alone', () => {
  assert.equal(isWrittenEfforts(false), false, 'the explicit opt-out is a decision, not a leftover')
  assert.equal(isWrittenEfforts({ off: null }), false, 'a set with nothing beyond off is not a declaration')
  assert.equal(isWrittenEfforts({ low: 'low', high: 'HIGH' }), false, 'another spelling is someone else’s declaration')
  assert.equal(isWrittenEfforts({ off: 'none', low: 'low' }), false, 'off carries null in every declaration this plugin writes')
  assert.equal(isWrittenEfforts({ low: 'reasoning_low' }), false)
  assert.equal(isWrittenEfforts({ reasoning: false }), false)
  assert.equal(isWrittenEfforts({}), false)
  assert.equal(isWrittenEfforts(null), false)
  assert.equal(isWrittenEfforts(['low']), false)
})

// --- plannedEfforts ---------------------------------------------------------

test('plannedEfforts uses the level set models.dev declares', () => {
  const { value, source } = plannedEfforts(catalogOf({ 'gemini-4-argon': ['off', 'low', 'medium', 'high'] }), 'gemini-4-argon')
  assert.equal(source, 'models.dev')
  assert.deepEqual(value, { off: null, low: 'low', medium: 'medium', high: 'high' })
})

test('plannedEfforts falls back to the standard set when models.dev names no level', () => {
  const catalog = catalogOf({})
  for (const id of ['gemini-3.8-flash-high', 'LongCat-2.5-Preview']) {
    const { value, source } = plannedEfforts(catalog, id)
    assert.equal(source, 'standard', `${id} is not described anywhere`)
    assert.deepEqual(value, DEFAULT_REASONING_EFFORTS)
  }
  assert.equal(plannedEfforts(catalogOf({ 'only-off': ['off'] }), 'only-off').source, 'standard',
    'an id whose only level is off cannot be declared, so it takes the standard set')
  assert.equal(plannedEfforts(catalogOf({}), '').source, 'standard', 'an empty id names nothing')
  assert.equal(plannedEfforts({ catalogRoutes: [] }, 'anything').source, 'standard', 'a map with no levels at all')
  assert.equal(plannedEfforts(undefined, 'anything').source, 'standard')
})

test('plannedEfforts never declares a model non-reasoning', () => {
  // The user's own `false` opt-out is preserved by the planner (case e); the
  // plugin must not invent one, because a model it cannot describe deserves the
  // picker rather than silence.
  for (const catalog of [catalogOf({}), catalogOf({ x: ['off'] }), undefined]) {
    assert.notEqual(plannedEfforts(catalog, 'x').value, false)
  }
})

// --- customModelIds ---------------------------------------------------------

test('customModelIds covers exactly the custom routes’ ids', () => {
  const snapshot = {
    providers: {
      [CUSTOM]: { models: [{ id: 'a' }, { id: '' }, { id: 'b' }, { noId: true }] },
      [CATALOG]: { models: [{ id: 'catalog-model' }] },
      shapeless: { models: 'not a list' },
    },
  }
  assert.deepEqual([...customModelIds(snapshot, [CATALOG])].sort(), ['a', 'b'])
  assert.deepEqual([...customModelIds({}, [])], [])
  assert.deepEqual([...customModelIds(undefined, [])], [])
})

// --- withoutRoutes ----------------------------------------------------------

test('withoutRoutes drops the named routes and nothing else', () => {
  const snapshot = { providers: { a: { models: [] }, b: { models: [] } }, other: 1 }
  const kept = withoutRoutes(snapshot, new Set(['a']))
  assert.deepEqual(Object.keys(kept.providers), ['b'])
  assert.equal(kept.other, 1, 'the rest of the layer travels through')
  assert.equal(withoutRoutes(snapshot, new Set()), snapshot, 'an empty skip set is the input itself')
  assert.equal(withoutRoutes(snapshot, undefined), snapshot)
})

// --- the plan ---------------------------------------------------------------

test('(a) a models.dev level set is written with off as null', () => {
  const plan = planNormalization(snapshotOf([{ id: 'my-chat' }]), catalogOf({ 'my-chat': ['off', 'low', 'high'] }))
  assert.equal(plan.ops.length, 1)
  assert.deepEqual(plan.ops[0].path, ['providers', CUSTOM, 'models'])
  assert.deepEqual(opFor(plan).value[0].reasoningEfforts, { off: null, low: 'low', high: 'high' })
  assert.deepEqual(pickerLevels(opFor(plan).value[0].reasoningEfforts), ['off', 'low', 'high'], 'the picker shows the declared set')
  assert.equal(plan.summary.planned, 1)
  assert.equal(plan.summary.sourced, 1)
  assert.equal(plan.summary.defaulted, 0)
})

test('(b) an id models.dev does not describe takes the standard set', () => {
  const plan = planNormalization(snapshotOf([{ id: 'unknown-model' }]), catalogOf({}))
  assert.deepEqual(opFor(plan).value[0].reasoningEfforts, DEFAULT_REASONING_EFFORTS)
  assert.deepEqual(pickerLevels(opFor(plan).value[0].reasoningEfforts), [...THINKING_LEVELS], 'every level, off included, is selectable')
  assert.equal(plan.summary.defaulted, 1)
  assert.equal(plan.summary.sourced, 0)
})

test('(c) the entry keeps every other field, key order included', () => {
  const entry = { id: 'my-chat', name: 'My Chat', contextWindow: 8192, input: ['text', 'image'], compat: { supportsStore: false } }
  const plan = planNormalization(snapshotOf([entry]), catalogOf({ 'my-chat': ['low'] }))
  const written = opFor(plan).value[0]
  assert.deepEqual(Object.keys(written), [...Object.keys(entry), 'reasoningEfforts'], 'reasoningEfforts is appended, nothing is reordered')
  for (const [key, value] of Object.entries(entry)) assert.deepEqual(written[key], value)
})

test('(d) several models on one route travel in one op', () => {
  const plan = planNormalization(snapshotOf([{ id: 'a' }, { id: 'b' }]), catalogOf({ a: ['off', 'low'], b: ['off', 'high'] }))
  assert.equal(plan.ops.length, 1, 'one op carries the route’s whole models array')
  assert.deepEqual(opFor(plan).value.map((entry) => entry.reasoningEfforts), [{ off: null, low: 'low' }, { off: null, high: 'high' }])
  assert.equal(plan.summary.models, 2)
})

test('(e) an explicit false is an opt-out, never overwritten', () => {
  const plan = planNormalization(snapshotOf([{ id: 'my-chat', reasoningEfforts: false }]), catalogOf({ 'my-chat': ['off', 'low', 'high'] }))
  assert.deepEqual(plan.ops, [], 'the declaration is a decision, so there is nothing to write')
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.planned, 0)
})

test('(f) a value that already equals the computed one produces no op', () => {
  const settled = { id: 'my-chat', reasoningEfforts: { off: null, low: 'low' } }
  const plan = planNormalization(snapshotOf([settled]), catalogOf({ 'my-chat': ['off', 'low'] }))
  assert.deepEqual(plan.ops, [], 'this is the loop breaker: the plugin’s own write re-triggers it')
  assert.equal(plan.summary.unchanged, 1)

  // …and a value that differs from the computed one is rewritten, because the
  // field is derived state rather than a user declaration. This is also how a
  // model that already carries the standard set narrows to what models.dev says.
  const plan2 = planNormalization(snapshotOf([{ id: 'my-chat', reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }]), catalogOf({ 'my-chat': ['off', 'low'] }))
  assert.equal(plan2.summary.planned, 1, 'a narrower models.dev set replaces the standard set')
  assert.deepEqual(opFor(plan2).value[0].reasoningEfforts, { off: null, low: 'low' })
})

test('(g) a route the installed catalog ships is never touched', () => {
  const snapshot = { providers: { [CATALOG]: { models: [{ id: 'gpt-5' }] }, [CUSTOM]: { models: [{ id: 'my-chat' }] } } }
  const plan = planNormalization(snapshot, catalogOf({ 'my-chat': ['low'], 'gpt-5': ['low'] }))
  assert.deepEqual(plan.ops.map((op) => op.path), [['providers', CUSTOM, 'models']])
  assert.deepEqual(plan.summary.routes, [CUSTOM])
})

test('(h) the op restates the current array and nothing more', () => {
  const models = [{ id: 'a' }, { id: 'b', reasoningEfforts: { off: null, low: 'low' } }, { id: 'c', reasoningEfforts: false }]
  const plan = planNormalization(snapshotOf(models, { displayName: 'Verify' }), catalogOf({ a: ['low'], b: ['off', 'low'] }))
  const written = opFor(plan).value
  assert.equal(written.length, 3, 'every entry stays')
  assert.deepEqual(written[1], models[1], 'an already-correct entry is written back unchanged')
  assert.deepEqual(written[2], models[2], 'the opt-out is carried through')
  assert.equal(plan.summary.planned, 1)
  assert.equal(plan.summary.unchanged, 1)
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.models, 3, 'every id lands in exactly one counter')
  assert.equal(plan.summary.planned + plan.summary.unchanged + plan.summary.optedOut, plan.summary.models)
})

test('a route with nothing to write contributes no op', () => {
  const plan = planNormalization(
    { providers: { [CUSTOM]: { models: [{ id: 'a', reasoningEfforts: false }] }, second: { models: [{ id: 'b' }] } } },
    catalogOf({ a: ['low'], b: ['high'] }),
  )
  assert.deepEqual(plan.ops.map((op) => op.path), [['providers', 'second', 'models']], 'the settled route stays out of the plan')
  assert.deepEqual(plan.summary.routes, [CUSTOM, 'second'], '…but it is still reported as one of this plugin’s routes')
})

test('a shapeless layer plans nothing instead of throwing', () => {
  for (const snapshot of [undefined, null, {}, { providers: null }, { providers: { a: {} } }, { providers: { a: { models: 'x' } } }]) {
    assert.deepEqual(planNormalization(snapshot, catalogOf({})).ops, [])
  }
  const plan = planNormalization({ providers: { a: { models: [{ id: '' }, null, 'text'] } } }, catalogOf({}))
  assert.deepEqual(plan.ops, [], 'entries without a usable id are skipped, not invented')
  assert.equal(plan.summary.models, 0)
})

test('the catalog route set may arrive as a Set as well as a list', () => {
  const snapshot = snapshotOf([{ id: 'my-chat' }])
  assert.deepEqual(planNormalization(snapshot, { catalogRoutes: new Set([CATALOG]), levels: new Map() }).ops.length, 1)
  assert.deepEqual(planNormalization(snapshot, { catalogRoutes: [CUSTOM], levels: new Map() }).summary.routes, [])
})
