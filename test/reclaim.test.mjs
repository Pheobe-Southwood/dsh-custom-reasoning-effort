/**
 * Unit tests for the one-shot reclaim of the `input` lists the 0.2.x releases
 * of this plugin wrote.
 *
 * Same fixtures as `normalizer.test.mjs` and the same reason for them: the
 * planner is pure, so the cases run against plain objects with no Cordis
 * runtime and no `llm` service. What is being judged here is a DELETION, so
 * every case that must survive is asserted as carefully as every case that must
 * go: the reclaim recognizes exactly the two values the previous release could
 * have written — the twin's own list when the installed catalog agreed on one,
 * `['text', 'image']` otherwise — and leaves everything else, including a list
 * the settings page or the user wrote.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INPUT_MODALITIES,
  DEFAULT_REASONING_EFFORTS,
  RESIDUAL_INPUT_VERSION,
  isResidualInput,
  planResidualInputRemoval,
  planNormalization,
  withoutRoutes,
} from '../lib/normalize.js'

// --- fixtures ---------------------------------------------------------------

/** A persisted `llm-pi-ai` layer holding one custom route. */
const snapshotOf = (models, { route = 'my-gateway', ...profile } = {}) => ({
  providers: {
    [route]: {
      baseURL: 'https://gateway.example/v1',
      api: 'openai-completions',
      models,
      ...profile,
    },
  },
})

/** A capability map as `lib/index.js` builds it. */
const catalogOf = (models, catalogRoutes = Object.keys(models)) => ({ catalogRoutes, models })

/** One model's capability fact, as `lib/index.js` captures it. */
const reasons = (levels, modalities) => ({ reasoning: true, levels, modalities })

/** The path op one route's models produce. */
const opFor = (plan, route = 'my-gateway') => {
  const op = plan.ops.find((entry) => entry.path.join('/') === `providers/${route}/models`)
  assert.ok(op !== undefined, `expected an op for route ${route}, saw ${JSON.stringify(plan.ops)}`)
  return op
}

/** The model ids one route's op carries, for readability in the assertions. */
const idsOf = (plan, route = 'my-gateway') => opFor(plan, route).value.map((entry) => entry.id)

// --- the predicate ----------------------------------------------------------

test('isResidualInput recognizes the fallback and a twin list, set-wise', () => {
  const catalog = catalogOf({ openai: { 'vision-twin': reasons(['low'], ['text', 'image']), 'text-twin': reasons(['low'], ['text']) } })

  // The fallback: no twin describes the id at all.
  assert.equal(isResidualInput(catalog, 'internal-model-v3', ['text', 'image']), true)
  // A twin states the truth, so its list is the residual value for that id.
  assert.equal(isResidualInput(catalog, 'vision-twin', ['text', 'image']), true)
  assert.equal(isResidualInput(catalog, 'text-twin', ['text']), true)
  // Ordering carries no information in this field.
  assert.equal(isResidualInput(catalog, 'vision-twin', ['image', 'text']), true)
  // Another id's twin list is not this id's computed value.
  assert.equal(isResidualInput(catalog, 'text-twin', ['text', 'image']), false)
  assert.equal(isResidualInput(catalog, 'vision-twin', ['text']), false)
})

test('isResidualInput refuses everything the previous release could not have written', () => {
  const catalog = catalogOf({ openai: { 'vision-twin': reasons(['low'], ['text', 'image']) } })

  // An empty list is what the adapter reads as "no declaration" — it is not a
  // value, so there is nothing to reclaim, and `[]` is written by nothing.
  assert.equal(isResidualInput(catalog, 'vision-twin', []), false)
  // Not a list at all.
  assert.equal(isResidualInput(catalog, 'vision-twin', 'text'), false)
  assert.equal(isResidualInput(catalog, 'vision-twin', null), false)
  assert.equal(isResidualInput(catalog, 'vision-twin', undefined), false)
  // A member outside the adapter's vocabulary would have made the previous
  // release's single write fail validation, so no such value is its own.
  assert.equal(isResidualInput(catalog, 'vision-twin', ['vision']), false)
  assert.equal(isResidualInput(catalog, 'vision-twin', ['text', 'audio']), false)
  // A catalog that cannot be read states no modalities, so the fallback is the
  // one recognized value — and it still is.
  for (const broken of [undefined, null, 'nonsense', { models: null }, { catalogRoutes: null, models: [] }]) {
    assert.equal(isResidualInput(broken, 'vision-twin', ['text', 'image']), true, `catalog ${JSON.stringify(broken)}`)
    assert.equal(isResidualInput(broken, 'vision-twin', ['text']), false, `catalog ${JSON.stringify(broken)}`)
  }
  assert.equal(isResidualInput(catalog, '', ['text', 'image']), false, 'an id that is not an id cannot be looked up')
})

// --- what the plan deletes --------------------------------------------------

test('the fallback list is reclaimed and every other field survives verbatim', () => {
  const route = {
    baseURL: 'https://gateway.example/v1',
    api: 'openai-completions',
    headers: { 'x-gateway': 'self-use' },
    models: [
      { id: 'gemini-3.8-flash-high', name: 'gemini-3.8-flash-high', contextWindow: 272000, input: ['text', 'image'], reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } },
      { id: 'qwen3.8-max', name: 'qwen3.8-max', contextWindow: 272000, input: ['text', 'image'], reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' } },
    ],
  }
  const snapshot = { defaultRoute: 'self-use', providers: { 'self-use': route } }

  const plan = planResidualInputRemoval(snapshot, catalogOf({}))

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(plan.ops[0].path, ['providers', 'self-use', 'models'], 'the op addresses the real route key')
  assert.equal(plan.ops[0].op, 'set')
  const models = opFor(plan, 'self-use').value
  assert.equal(models.length, route.models.length)
  models.forEach((entry, index) => {
    assert.equal(Object.hasOwn(entry, 'input'), false, `${entry.id} must lose the field`)
    assert.deepEqual({ ...entry, input: route.models[index].input }, route.models[index], `${entry.id} must keep every other field and key position`)
  })
  // The reasoning dict is untouched: the cleanup is not a normalization pass.
  assert.deepEqual(models[1].reasoningEfforts, { low: 'low', medium: 'medium', xhigh: 'xhigh' })
  assert.deepEqual(plan.summary, { routes: ['self-use'], models: 2, reclaimed: 2 })
})

test('a twin list is reclaimed on the model that has that twin, and only there', () => {
  const catalog = catalogOf({
    openai: { 'gpt-5': reasons(['low', 'high'], ['text', 'image']) },
    anthropic: { 'claude-text': reasons(['low'], ['text']) },
  })
  const snapshot = snapshotOf([
    { id: 'gpt-5', input: ['text', 'image'] },
    { id: 'claude-text', input: ['text'] },
    { id: 'internal-model-v3', input: ['text', 'image'] },
  ])

  const plan = planResidualInputRemoval(snapshot, catalog)

  assert.deepEqual(idsOf(plan), ['gpt-5', 'claude-text', 'internal-model-v3'])
  for (const entry of opFor(plan).value) assert.equal(Object.hasOwn(entry, 'input'), false)
  assert.deepEqual(plan.summary, { routes: ['my-gateway'], models: 3, reclaimed: 3 })
})

test('a reordered residual is reclaimed as the same value it spells', () => {
  const plan = planResidualInputRemoval(snapshotOf([{ id: 'internal-model-v3', input: ['image', 'text'] }]), catalogOf({}))

  assert.equal(plan.summary.reclaimed, 1)
  assert.equal(Object.hasOwn(opFor(plan).value[0], 'input'), false)
})

// --- what the plan must not delete ------------------------------------------

test('a list that is not the computed value is left exactly as it stands', () => {
  const catalog = catalogOf({
    openai: { 'text-twin': reasons(['low'], ['text']), 'vision-twin': reasons(['low'], ['text', 'image']) },
    anthropic: { 'claude-text': reasons(['low'], ['text']) },
  })
  const cases = [
    // A user's narrower or wider declaration for an id whose twin says otherwise.
    { id: 'text-twin', input: ['text', 'image'] },
    { id: 'vision-twin', input: ['text'] },
    // A catalog whose routes disagree: the previous release fell back, so a
    // list matching one of the twins was never its own value.
    { id: 'claude-text', input: ['text', 'image'] },
    // Values no schema-legal write could have produced.
    { id: 'internal-model-v3', input: ['text', 'audio'] },
    { id: 'internal-model-v3', input: [] },
    { id: 'internal-model-v3', input: 'image' },
    // A model with no list at all.
    { id: 'internal-model-v3' },
  ]

  for (const entry of cases) {
    const plan = planResidualInputRemoval(snapshotOf([entry]), catalog)
    assert.deepEqual(plan.ops, [], `input ${JSON.stringify(entry.input)} on ${entry.id} must survive`)
    assert.deepEqual(plan.summary, { routes: [], models: 0, reclaimed: 0 })
  }
})

test('a conflicting twin pair keeps a list that matches only one of them', () => {
  const catalog = catalogOf({
    openai: { 'shared-id': reasons(['low'], ['text']) },
    anthropic: { 'shared-id': reasons(['low'], ['text', 'image']) },
  })

  // No single list is the computed one, so the previous release wrote the
  // fallback — and only the fallback is recognized.
  const conflicting = planResidualInputRemoval(snapshotOf([{ id: 'shared-id', input: ['text'] }]), catalog)
  assert.deepEqual(conflicting.ops, [], 'the twin that agrees is not enough: the routes must agree with each other')

  const agreed = catalogOf({
    openai: { 'shared-id': reasons(['low'], ['text', 'image']) },
    openrouter: { 'shared-id': reasons(['low'], ['image', 'text']) },
  })
  const inherited = planResidualInputRemoval(snapshotOf([{ id: 'shared-id', input: ['text', 'image'] }]), agreed)
  assert.equal(inherited.summary.reclaimed, 1, 'routes that agree on the SET state a fact, spelling order included')
  const otherOrder = planResidualInputRemoval(snapshotOf([{ id: 'shared-id', input: ['image', 'text'] }]), agreed)
  assert.equal(otherOrder.summary.reclaimed, 1, 'and the stored list is compared the same way')
})

test('a twin that states no modalities keeps only the fallback as a residual', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['high'], undefined) } })

  const fallback = planResidualInputRemoval(snapshotOf([{ id: 'gpt-5', input: ['text', 'image'] }]), catalog)
  assert.equal(fallback.summary.reclaimed, 1, 'the previous release fell back when a twin stated nothing')

  const narrower = planResidualInputRemoval(snapshotOf([{ id: 'gpt-5', input: ['text'] }]), catalog)
  assert.deepEqual(narrower.ops, [], 'a narrower list on such an id is the user speaking, not a leftover')
})

// --- the boundary the normalizer keeps --------------------------------------

test('catalog routes are never swept', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['high'], ['text', 'image']) } })
  const snapshot = {
    providers: {
      openai: { apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5', input: ['text', 'image'] }] },
    },
  }

  const plan = planResidualInputRemoval(snapshot, catalog)

  assert.deepEqual(plan.ops, [], 'the previous release never wrote on a catalog route')
  assert.deepEqual(plan.summary.routes, [])
})

test('only the routes a filtered layer keeps are swept', () => {
  const snapshot = {
    providers: {
      broken: { models: [{ id: 'residual-a', input: ['text', 'image'] }] },
      healthy: { models: [{ id: 'residual-b', input: ['text', 'image'] }] },
    },
  }

  const plan = planResidualInputRemoval(withoutRoutes(snapshot, new Set(['broken'])), catalogOf({}))

  assert.deepEqual(plan.summary.routes, ['healthy'])
  assert.deepEqual(plan.ops[0].path, ['providers', 'healthy', 'models'])
  // The unfiltered layer would have swept both, which is the behaviour the
  // cleanup wants: a route the normalizer must skip is still a route whose
  // leftovers have to go.
  assert.deepEqual(planResidualInputRemoval(snapshot, catalogOf({})).summary.routes, ['broken', 'healthy'])
})

// --- idempotence ------------------------------------------------------------

test('the layer a pass writes plans nothing on the next pass', () => {
  const catalog = catalogOf({})
  const first = planResidualInputRemoval(snapshotOf([{ id: 'internal-model-v3', input: ['text', 'image'], reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }]), catalog)
  assert.equal(first.summary.reclaimed, 1)

  // What the write leaves behind: the same entries without the list.
  const second = planResidualInputRemoval(snapshotOf(opFor(first).value), catalog)

  assert.deepEqual(second.ops, [])
  assert.deepEqual(second.summary, { routes: [], models: 0, reclaimed: 0 })
})

test('a route with nothing to reclaim contributes no op', () => {
  const plan = planResidualInputRemoval(
    {
      providers: {
        clean: { models: [{ id: 'a', input: ['text'] }, { id: 'b' }] },
        dirty: { models: [{ id: 'c', input: ['text', 'image'] }] },
      },
    },
    catalogOf({}),
  )

  assert.equal(plan.ops.length, 1, 'only the route with a leftover is written')
  assert.deepEqual(plan.ops[0].path, ['providers', 'dirty', 'models'])
  assert.deepEqual(plan.summary, { routes: ['dirty'], models: 1, reclaimed: 1 })
})

// --- fail-safe on unknown shapes --------------------------------------------

test('unknown shapes plan nothing instead of throwing', () => {
  for (const snapshot of [undefined, null, 'nonsense', 42, {}, { providers: null }, { providers: [] }, { providers: { custom: null } }, { providers: { custom: { models: 'nope' } } }]) {
    const plan = planResidualInputRemoval(snapshot, catalogOf({}))
    assert.deepEqual(plan.ops, [], `snapshot ${JSON.stringify(snapshot)} must plan nothing`)
    assert.deepEqual(plan.summary, { routes: [], models: 0, reclaimed: 0 })
  }
})

test('entries that cannot carry an id are left exactly as they are', () => {
  const plan = planResidualInputRemoval(snapshotOf([{ name: 'no id', input: ['text', 'image'] }, null, 'nonsense']), catalogOf({}))

  assert.deepEqual(plan.ops, [])
  assert.deepEqual(plan.summary, { routes: [], models: 0, reclaimed: 0 })
})

// --- the marker's vocabulary ------------------------------------------------

test('the reclaim revision is a positive integer', () => {
  // The value gates a deletion that must never run twice, so it is part of the
  // plugin's stored contract: a marker written at this revision or above
  // disables the cleanup, and `alreadyReclaimed` (lib/index.js) compares the
  // two as numbers.
  assert.equal(Number.isInteger(RESIDUAL_INPUT_VERSION), true)
  assert.ok(RESIDUAL_INPUT_VERSION >= 1)
  assert.deepEqual([...DEFAULT_INPUT_MODALITIES], ['text', 'image'], 'the fallback the reclaim recognizes is the one the previous release used')
})

// --- the two planners do not interfere --------------------------------------

test('the cleanup and the capability fill plan over the same fixture without touching each other', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['low', 'high'], ['text', 'image']) } })
  const snapshot = snapshotOf([
    { id: 'gpt-5', input: ['text', 'image'] },
    { id: 'internal-model-v3', input: ['text', 'image'] },
  ])

  const cleanup = planResidualInputRemoval(snapshot, catalog)
  const fill = planNormalization(snapshot, catalog)

  // The cleanup deletes only `input`; the fill writes only `reasoningEfforts`.
  assert.deepEqual(idsOf(cleanup), ['gpt-5', 'internal-model-v3'])
  assert.deepEqual(opFor(cleanup).value.map((entry) => Object.hasOwn(entry, 'reasoningEfforts')), [false, false])
  assert.deepEqual(opFor(fill).value.map((entry) => entry.input), [['text', 'image'], ['text', 'image']])
  // Both address the same path, so the round that applies them in sequence
  // ends with the list gone and the dict present.
  assert.deepEqual(opFor(cleanup).path, opFor(fill).path)
})
