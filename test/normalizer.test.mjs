/**
 * Unit tests for the settings normalizer.
 *
 * Every fixture is a plain object: the planner is pure, so no Cordis runtime,
 * no settings service and no `llm` service is involved. The two shipped
 * functions the plans are judged against are mirrored here in miniature, with
 * the lines they mirror named — `resolveModelReasoning`'s `thinkingLevelMap`
 * construction (`dsh-llm-pi-ai/lib/index.js:575-580`) and pi-ai's level filter
 * (`@earendil-works/pi-ai/dist/models.js:551-560`) — so an inheritance case can
 * assert the level list the picker would actually show, not just the dict.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_REASONING_EFFORTS,
  THINKING_LEVELS,
  customModelIds,
  effortsForLevels,
  planNormalization,
  twinCapability,
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

/** One model's capability fact. */
const reasons = (levels) => ({ reasoning: true, levels })
const noReasoning = { reasoning: false, levels: [] }

/** The path op one route's models produce. */
const opFor = (plan, route = 'my-gateway') => {
  const op = plan.ops.find((entry) => entry.path.join('/') === `providers/${route}/models`)
  assert.ok(op !== undefined, `expected an op for route ${route}, saw ${JSON.stringify(plan.ops)}`)
  return op
}

/** The `reasoningEfforts` a plan writes for the first model of one route. */
const effortsFor = (plan, route = 'my-gateway') => opFor(plan, route).value[0].reasoningEfforts

// --- (a) twin with reasoning → inherit --------------------------------------

test('(a) an unambiguous same-id catalog twin supplies its levels', () => {
  // openai/gpt-5 as the installed catalog ships it: off and the extended levels
  // are null-mapped, so the picker offers exactly these four.
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['minimal', 'low', 'medium', 'high']) } })
  const snapshot = snapshotOf([{ id: 'gpt-5' }])

  const plan = planNormalization(snapshot, catalog)

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(effortsFor(plan), {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
  })
  // The twin does not offer `off`, so the dict must not declare it either:
  // an undeclared level is pinned to null and stays out of the picker.
  assert.equal(Object.hasOwn(effortsFor(plan), 'off'), false)
  assert.deepEqual(plan.summary, {
    routes: ['my-gateway'],
    models: 1,
    planned: 1,
    optedOut: 0,
    unchanged: 0,
    inherited: 1,
    defaulted: 0,
    nonReasoning: 0,
  })
})

test('(a) a twin offering off declares it as the valueless wire spelling', () => {
  // deepseek-v4-flash: off is supported (absent from its map), minimal and
  // medium are null-mapped.
  const catalog = catalogOf({ deepseek: { 'deepseek-v4-flash': reasons(['off', 'low', 'high', 'max']) } })

  const plan = planNormalization(snapshotOf([{ id: 'deepseek-v4-flash' }]), catalog)

  assert.deepEqual(effortsFor(plan), { off: null, low: 'low', high: 'high', max: 'max' })
})

// --- (b) twin with reasoning:false → write false ----------------------------

test('(b) a twin that does not reason is inherited as false', () => {
  const catalog = catalogOf({ openai: { 'text-embedding-3-small': noReasoning } })

  const plan = planNormalization(snapshotOf([{ id: 'text-embedding-3-small' }]), catalog)

  assert.equal(plan.ops.length, 1)
  assert.equal(effortsFor(plan), false)
  assert.equal(plan.summary.nonReasoning, 1)
})

// --- (c) no twin → default set ----------------------------------------------

test('(c) no twin falls back to the standard level set', () => {
  const plan = planNormalization(snapshotOf([{ id: 'internal-model-v3' }]), catalogOf({ openai: { 'gpt-5': reasons(['high']) } }))

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(effortsFor(plan), {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  })
  assert.deepEqual(effortsFor(plan), { ...DEFAULT_REASONING_EFFORTS })
  assert.equal(plan.summary.defaulted, 1)
})

test('(c) a model listed by no route at all still gets the standard set', () => {
  const plan = planNormalization(snapshotOf([{ id: 'nothing-knows-me' }]), catalogOf({}))

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(effortsFor(plan), { ...DEFAULT_REASONING_EFFORTS })
})

// --- (d) ambiguous twin → default set ---------------------------------------

test('(d) twins that disagree fall back to the standard level set', () => {
  const catalog = catalogOf({
    openai: { 'shared-id': reasons(['minimal', 'low', 'medium', 'high']) },
    anthropic: { 'shared-id': reasons(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) },
  })

  const plan = planNormalization(snapshotOf([{ id: 'shared-id' }]), catalog)

  assert.deepEqual(effortsFor(plan), { ...DEFAULT_REASONING_EFFORTS })
  assert.equal(plan.summary.defaulted, 1)
  assert.equal(plan.summary.inherited, 0)
})

test('(d) a reasoning twin and a non-reasoning twin also disagree', () => {
  const catalog = catalogOf({
    openai: { 'shared-id': reasons(['high']) },
    'some-gateway': { 'shared-id': noReasoning },
  })

  const plan = planNormalization(snapshotOf([{ id: 'shared-id' }]), catalog)

  assert.deepEqual(effortsFor(plan), { ...DEFAULT_REASONING_EFFORTS })
})

test('(d) twins that agree are inherited', () => {
  const catalog = catalogOf({
    openai: { 'shared-id': reasons(['low', 'high']) },
    openrouter: { 'shared-id': reasons(['low', 'high']) },
    together: { 'shared-id': noReasoning },
  })

  assert.deepEqual(twinCapability(catalog, 'shared-id').status, 'ambiguous')
  assert.deepEqual(twinCapability(catalogOf({ openai: { 'shared-id': reasons(['low', 'high']) }, openrouter: { 'shared-id': reasons(['high', 'low']) } }), 'shared-id'), {
    status: 'agreed',
    reasoning: true,
    levels: ['low', 'high'],
  })
})

// --- (e) explicit false → no op ---------------------------------------------

test('(e) an explicit false is an opt-out and is never overwritten', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['high']) } })

  const plan = planNormalization(snapshotOf([{ id: 'gpt-5', reasoningEfforts: false }]), catalog)

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.planned, 0)
})

test('(e) an opted-out model keeps its value while its siblings are filled', () => {
  const plan = planNormalization(
    snapshotOf([{ id: 'my-embedding', reasoningEfforts: false }, { id: 'my-chat' }]),
    catalogOf({}),
  )

  assert.equal(plan.ops.length, 1)
  const models = opFor(plan).value
  assert.equal(models[0].reasoningEfforts, false)
  assert.deepEqual(models[1].reasoningEfforts, { ...DEFAULT_REASONING_EFFORTS })
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.planned, 1)
})

// --- (f) already equal → no ops ---------------------------------------------

test('(f) a model already carrying the computed value produces no ops', () => {
  const plan = planNormalization(
    snapshotOf([{ id: 'internal-model-v3', reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }]),
    catalogOf({}),
  )

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.unchanged, 1)
})

test('(f) an inherited value is idempotent on the next pass', () => {
  const catalog = catalogOf({ anthropic: { 'claude-twin': reasons(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) } })
  const first = planNormalization(snapshotOf([{ id: 'claude-twin' }]), catalog)
  assert.equal(first.ops.length, 1)

  // The write is the state the next pass reads, key order included: the same
  // value must plan nothing, or the plugin would rewrite itself forever.
  const written = opFor(first).value
  const second = planNormalization(snapshotOf(written), catalog)

  assert.deepEqual(second.ops, [])
  assert.equal(second.summary.unchanged, 1)
})

test('(f) a reordered dict is still the same value', () => {
  const plan = planNormalization(
    snapshotOf([{ id: 'internal-model-v3', reasoningEfforts: { max: 'max', high: 'high', off: null, minimal: 'minimal', medium: 'medium', low: 'low', xhigh: 'xhigh' } }]),
    catalogOf({}),
  )

  assert.deepEqual(plan.ops, [])
})

// --- (g) catalog routes are never touched -----------------------------------

test('(g) catalog routes are never touched', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['high']) } })
  const snapshot = {
    providers: {
      openai: {
        apiKeyEnv: 'OPENAI_API_KEY',
        models: [{ id: 'gpt-5' }, { id: 'gpt-4o' }],
      },
      'my-gateway': { baseURL: 'https://gateway.example/v1', models: [{ id: 'gpt-5' }] },
    },
  }

  const plan = planNormalization(snapshot, catalog)

  assert.equal(plan.ops.length, 1, 'only the custom route may be written')
  assert.deepEqual(plan.ops[0].path, ['providers', 'my-gateway', 'models'])
  assert.deepEqual(plan.summary.routes, ['my-gateway'])
  assert.equal(plan.summary.models, 1, 'catalog-route models are not even counted')
})

test('(g) a provider layer holding only catalog routes plans nothing', () => {
  const plan = planNormalization(
    { providers: { openai: { models: [{ id: 'gpt-5' }] } } },
    catalogOf({ openai: { 'gpt-5': reasons(['high']) } }),
  )

  assert.deepEqual(plan.ops, [])
  assert.deepEqual(plan.summary.routes, [])
})

// --- (h) ops touch nothing but reasoningEfforts -----------------------------

test('(h) ops touch nothing on a model but reasoningEfforts', () => {
  const plan = planNormalization(
    snapshotOf(
      [
        { id: 'gpt-5', name: 'Shared', contextWindow: 400000, input: ['text', 'image'] },
        { id: 'my-embedding', reasoningEfforts: false },
        { id: 'my-chat', compat: { thinkingFormat: 'deepseek' } },
      ],
      { displayName: 'Gateway', defaultMaxTokens: 8192 },
    ),
    catalogOf({ openai: { 'gpt-5': reasons(['minimal', 'low', 'medium', 'high']) } }),
  )

  assert.equal(plan.ops.length, 1)
  const [op] = plan.ops
  assert.equal(op.op, 'set')
  // WHY the whole array: the shipped settings applier only descends through
  // plain objects, so `['providers', route, 'models', '0', 'reasoningEfforts']`
  // would replace the array with an object keyed "0" and the write would be
  // rejected as `models expected array`. This assertion pins the shape that
  // actually works, and the next one pins what "only reasoningEfforts" means.
  assert.deepEqual(op.path, ['providers', 'my-gateway', 'models'])

  const before = snapshotOf([
    { id: 'gpt-5', name: 'Shared', contextWindow: 400000, input: ['text', 'image'] },
    { id: 'my-embedding', reasoningEfforts: false },
    { id: 'my-chat', compat: { thinkingFormat: 'deepseek' } },
  ]).providers['my-gateway'].models
  assert.equal(op.value.length, before.length)
  op.value.forEach((entry, index) => {
    const { reasoningEfforts: _written, ...rest } = entry
    const { reasoningEfforts: _held, ...original } = before[index]
    assert.deepEqual(rest, original, `model ${entry.id} must keep every other field`)
    assert.equal(
      Object.hasOwn(entry, 'reasoningEfforts'),
      true,
      `model ${entry.id} must carry a value after the pass`,
    )
  })
  assert.deepEqual(Object.keys(op.value[0]), ['id', 'name', 'contextWindow', 'input', 'reasoningEfforts'], 'key order is preserved, the new field appended')
})

test('(h) every op path stops at models and every value is a whole array', () => {
  const plan = planNormalization(
    {
      providers: {
        alpha: { models: [{ id: 'a' }] },
        beta: { models: [{ id: 'b' }] },
      },
    },
    catalogOf({}),
  )

  assert.equal(plan.ops.length, 2)
  for (const op of plan.ops) {
    assert.equal(op.op, 'set')
    assert.equal(op.path.length, 3)
    assert.equal(op.path[0], 'providers')
    assert.equal(op.path[2], 'models')
    assert.equal(op.path.includes('reasoningEfforts'), false, 'the applier cannot reach an array element')
    assert.ok(Array.isArray(op.value))
    assert.ok(op.value.every((entry) => Object.hasOwn(entry, 'reasoningEfforts')))
  }
})

// --- schema legality --------------------------------------------------------

/**
 * The shipped schema in miniature: keys are thinking levels, values are
 * non-empty wire strings, and `null` is lawful on `off` alone
 * (`dsh-llm-pi-ai/lib/index.js:967`, `:571-574`).
 */
const isSchemaLegal = (efforts) => {
  if (efforts === false) return true
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) return false
  const keys = Object.keys(efforts)
  if (keys.length === 0) return false
  if (keys.some((level) => !THINKING_LEVELS.includes(level))) return false
  if (keys.some((level) => (efforts[level] === null ? level !== 'off' : typeof efforts[level] !== 'string' || efforts[level].length === 0))) return false
  return keys.some((level) => level !== 'off')
}

test('every planned value is schema-legal', () => {
  const catalog = catalogOf({
    openai: { 'gpt-5': reasons(['minimal', 'low', 'medium', 'high']), 'text-embedding-3-small': noReasoning },
  })
  const plan = planNormalization(
    snapshotOf([
      { id: 'gpt-5' },
      { id: 'text-embedding-3-small' },
      { id: 'unknown-model' },
      { id: 'opt-out', reasoningEfforts: false },
    ]),
    catalog,
  )

  assert.equal(plan.ops.length, 1)
  for (const entry of opFor(plan).value) assert.ok(isSchemaLegal(entry.reasoningEfforts), `${entry.id} carries an illegal value`)
})

test('the helpers never invent an illegal dict', () => {
  assert.equal(effortsForLevels([]), undefined)
  assert.equal(effortsForLevels(['off']), undefined)
  assert.equal(effortsForLevels(['off', 'not-a-level']), undefined)
  assert.deepEqual(effortsForLevels(['high']), { high: 'high' })
  assert.deepEqual(effortsForLevels(['max', 'off']), { off: null, max: 'max' })
  for (const levels of [[], ['off'], ['high'], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']]) {
    const dict = effortsForLevels(levels)
    if (dict !== undefined) assert.ok(isSchemaLegal(dict))
  }
})

// --- inheritance reproduces the twin's picker -------------------------------

/**
 * `resolveModelReasoning`'s map construction
 * (`dsh-llm-pi-ai/lib/index.js:575-580`): a declared level keeps its spelling,
 * an undeclared one is pinned to null, and an `off: null` stays out of the map.
 */
const thinkingLevelMap = (efforts) => {
  const map = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) map[level] = null
    else if (wire !== null) map[level] = wire
  }
  return map
}

/**
 * `getSupportedThinkingLevels` (`@earendil-works/pi-ai/dist/models.js:551-560`):
 * null-mapped levels are unsupported, and `xhigh`/`max` need an explicit entry.
 */
const supportedLevels = (map) => THINKING_LEVELS.filter((level) => {
  const mapped = map[level]
  if (mapped === null) return false
  if (level === 'xhigh' || level === 'max') return mapped !== undefined
  return true
})

test('an inherited dict reproduces exactly the levels the twin offers', () => {
  const twins = [
    { route: 'openai', id: 'gpt-5', levels: ['minimal', 'low', 'medium', 'high'] },
    { route: 'anthropic', id: 'claude-fable-5', levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { route: 'deepseek', id: 'deepseek-v4-flash', levels: ['off', 'low', 'high', 'max'] },
    { route: 'xai', id: 'grok-4.5', levels: ['low', 'medium', 'high'] },
  ]
  const catalog = catalogOf(Object.fromEntries(twins.map((twin) => [twin.route, { [twin.id]: reasons(twin.levels) }])))
  const plan = planNormalization(snapshotOf(twins.map((twin) => ({ id: twin.id }))), catalog)

  assert.equal(plan.ops.length, 1)
  const written = opFor(plan).value
  twins.forEach((twin, index) => {
    const map = thinkingLevelMap(written[index].reasoningEfforts)
    assert.deepEqual(supportedLevels(map), twin.levels, `${twin.route}/${twin.id} must offer the same levels as its twin`)
  })
})

// --- the custom-route id helper ---------------------------------------------

test('customModelIds collects exactly the custom-route ids', () => {
  const snapshot = {
    providers: {
      openai: { models: [{ id: 'gpt-5' }] },
      'my-gateway': { models: [{ id: 'gpt-5' }, { id: 'my-chat' }, { id: '' }, { notAModel: true }] },
      'not-a-profile': 'nonsense',
    },
  }

  assert.deepEqual([...customModelIds(snapshot, ['openai'])].sort(), ['gpt-5', 'my-chat'])
  assert.deepEqual([...customModelIds(snapshot, new Set(['openai']))].sort(), ['gpt-5', 'my-chat'])
})

// --- dropping unwritable routes ---------------------------------------------

/** The layer the drop cases are judged on: two custom routes, plus a second top-level key. */
const twoRoutes = () => ({
  defaultRoute: 'my-gateway',
  providers: {
    broken: { baseURL: 'https://broken.example/v1', models: [{ id: 'broken-model' }] },
    healthy: { baseURL: 'https://healthy.example/v1', models: [{ id: 'healthy-model' }] },
  },
})

test('withoutRoutes drops exactly the named routes and keeps every other key', () => {
  const snapshot = twoRoutes()
  const brokenProfile = snapshot.providers.broken
  const healthyProfile = snapshot.providers.healthy

  const writable = withoutRoutes(snapshot, new Set(['broken']))

  assert.deepEqual(Object.keys(writable.providers), ['healthy'])
  // A surviving route is carried over by reference, not rebuilt: the planner
  // must see the profile exactly as it was read, or its op would write back a
  // different array than the one it decided about.
  assert.equal(writable.providers.healthy, healthyProfile)
  assert.equal(writable.defaultRoute, snapshot.defaultRoute)
  assert.deepEqual(Object.keys(writable), ['defaultRoute', 'providers'])
  // The input is filtered, never edited: the ops are applied to the real layer,
  // so the dropped route is still in it after the call.
  assert.equal(snapshot.providers.broken, brokenProfile)
  assert.deepEqual(Object.keys(snapshot.providers), ['broken', 'healthy'])
})

test('withoutRoutes drops every route when every route is named', () => {
  const writable = withoutRoutes(twoRoutes(), new Set(['broken', 'healthy']))

  assert.deepEqual(writable.providers, {})
  assert.equal(writable.defaultRoute, 'my-gateway', 'the other top-level keys survive an emptied provider layer')
})

test('withoutRoutes with nothing to drop returns the very input', () => {
  const snapshot = twoRoutes()

  assert.equal(withoutRoutes(snapshot, new Set()), snapshot)
})

test('withoutRoutes returns unreadable shapes unchanged instead of throwing', () => {
  for (const snapshot of [undefined, null, 'nonsense', 42, [], {}, { providers: null }, { providers: [] }, { providers: 'nope' }]) {
    assert.equal(
      withoutRoutes(snapshot, new Set(['broken'])),
      snapshot,
      `snapshot ${JSON.stringify(snapshot) ?? String(snapshot)} must come back untouched`,
    )
  }
  // A skip set that is not a set cannot name a route, so there is nothing to drop.
  const snapshot = twoRoutes()
  assert.equal(withoutRoutes(snapshot, undefined), snapshot)
  assert.equal(withoutRoutes(snapshot, null), snapshot)
  assert.equal(withoutRoutes(snapshot, ['broken']), snapshot)
})

test('a skip set naming no existing route rebuilds the same layer', () => {
  const snapshot = twoRoutes()
  const writable = withoutRoutes(snapshot, new Set(['no-such-route']))

  assert.deepEqual(writable, snapshot, 'no route is lost when no name matches')
  assert.notEqual(writable, snapshot, 'a non-empty skip set rebuilds the layer rather than passing it through')
})

test('planning over a filtered layer normalizes exactly the routes left in it', () => {
  const snapshot = twoRoutes()
  const catalog = catalogOf({ openai: { 'healthy-model': reasons(['low', 'high']) } })

  const plan = planNormalization(withoutRoutes(snapshot, new Set(['broken'])), catalog)

  assert.equal(plan.ops.length, 1, 'the skipped route must produce no op')
  assert.deepEqual(plan.ops[0].path, ['providers', 'healthy', 'models'], 'the op still addresses the real route key')
  assert.deepEqual(plan.summary, {
    routes: ['healthy'],
    models: 1,
    planned: 1,
    optedOut: 0,
    unchanged: 0,
    inherited: 1,
    defaulted: 0,
    nonReasoning: 0,
  })
  assert.deepEqual(effortsFor(plan, 'healthy'), { low: 'low', high: 'high' })

  // The contrast is the reason the filter exists: the unfiltered layer plans a
  // second op for the route the llm service cannot resolve, and since the whole
  // round is one mutation, that op would cost the healthy route its pass.
  const unfiltered = planNormalization(snapshot, catalog)
  assert.deepEqual(unfiltered.summary.routes, ['broken', 'healthy'])
  assert.equal(unfiltered.ops.length, 2)
})

// --- fail-safe on unknown shapes --------------------------------------------

test('unknown shapes plan nothing instead of throwing', () => {
  const catalog = catalogOf({})
  for (const snapshot of [undefined, null, 'nonsense', 42, {}, { providers: null }, { providers: [] }, { providers: { custom: null } }, { providers: { custom: { models: 'nope' } } }]) {
    const plan = planNormalization(snapshot, catalog)
    assert.deepEqual(plan.ops, [], `snapshot ${JSON.stringify(snapshot)} must plan nothing`)
  }
  for (const broken of [undefined, null, 'nonsense', { models: null }, { catalogRoutes: null, models: [] }]) {
    const plan = planNormalization(snapshotOf([{ id: 'a' }]), broken)
    assert.equal(plan.ops.length, 1, `catalog ${JSON.stringify(broken)} must fall back to the default set`)
    assert.deepEqual(effortsFor(plan), { ...DEFAULT_REASONING_EFFORTS })
  }
})

test('entries that cannot carry an id are left exactly as they are', () => {
  const plan = planNormalization(snapshotOf([{ name: 'no id' }, null, 'nonsense']), catalogOf({}))

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.models, 0)
})
