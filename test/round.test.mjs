/**
 * Integration tests for the plugin half: `apply` wired to a stateful stub.
 *
 * `normalizer.test.mjs` and `reclaim.test.mjs` judge planning; this file judges
 * the wiring planning cannot reach — which round runs when, which namespace each
 * write goes to, and what the marker gate means for the deletion. The stub is
 * deliberately thin and hand-written (this package ships no test framework and no
 * dependency on the harness), and it is STATEFUL on purpose: `mutate` applies the
 * ops to the document it serves, so a second round reads what the first one wrote.
 * That is what makes the debounce loop's loop-breaker testable — with a stub that
 * kept answering from the fixture, "the second pass is a no-op" would be a
 * statement about the fixture, not about the plugin. The one thing it does not
 * model is the harness's own schema validation, which has no bearing on the paths
 * this plugin writes.
 *
 * Three things here are load-bearing and easy to break:
 *   - the removal is written to the `llm-pi-ai` namespace and the marker to this
 *     plugin's own row: putting them in one write would route one of them to the
 *     wrong namespace, which is how the marker silently became the thing that was
 *     deleting;
 *   - the marker is written only after a successful removal, so a refused
 *     removal can never leave a marker that claims it happened;
 *   - once the marker is set, no later round may delete an `input` list — that is
 *     the promise the whole one-shot design exists to keep.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { name as PLUGIN_NAME, apply } from '../lib/index.js'
import { DEFAULT_REASONING_EFFORTS, RESIDUAL_INPUT_VERSION } from '../lib/normalize.js'

// --- stubs ------------------------------------------------------------------

/** A shallow-cloned document walk plus the two path ops the plugin emits. */
const applyOps = (document, ops) => {
  const next = structuredClone(document)
  for (const op of ops) {
    const parent = op.path.slice(0, -1).reduce((node, key) => node[key], next)
    const key = op.path[op.path.length - 1]
    if (op.op === 'set') parent[key] = structuredClone(op.value)
    else delete parent[key]
  }
  return next
}

/**
 * One plugin context good enough for `apply`: the services it injects, the three
 * events it listens to, an effect registry and a logger.
 *
 * `settings.describe()` answers the two namespaces the round reads — the
 * adapter's `llm-pi-ai` layer and this plugin's own row, which is where the
 * reclaim marker lives and why both are here — and `settings.mutate()` applies
 * every write to the store behind them, exactly as the harness does.
 */
const contextFor = ({ user, marker, catalog = {}, catalogRoutes = [], providers = [], refusals = 0 }) => {
  const mutations = []
  const logs = []
  const listeners = new Map()
  const state = { user: structuredClone(user), config: marker === undefined ? {} : { residualInputsReclaimed: marker } }
  let refused = 0
  const ctx = {
    get config() {
      return state.config
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: mutations.filter((entry) => entry.ns === 'llm-pi-ai').length + 1,
        autoGenerate: true,
        applies: 'live',
        schema: {},
        value: state.user,
        user: state.user,
      }, {
        ns: PLUGIN_NAME,
        revision: mutations.filter((entry) => entry.ns === PLUGIN_NAME).length + 1,
        autoGenerate: true,
        applies: 'live',
        schema: {},
        value: state.config,
        user: state.config,
      }],
      mutate: async (ns, ops, revision) => {
        if (refused < refusals) {
          refused += 1
          const error = new Error('stub refused the write')
          error.code = 'SETTINGS_CONFLICT'
          throw error
        }
        mutations.push({ ns, ops, revision })
        if (ns === 'llm-pi-ai') state.user = applyOps(state.user, ops)
        else state.config = applyOps(state.config, ops)
      },
    },
    llm: {
      listConfigurableProviders: () => [...catalogRoutes.map((route) => ({ provider: route, declared: false })), ...providers],
      listProviders: () => Object.keys(catalog).map((id) => ({ id })),
      listModels: async (route) => Object.keys(catalog[route] ?? {}).map((id) => ({ id })),
      resolveModelInfo: async (route, model) => {
        const facts = catalog[route]?.[model]
        if (facts === undefined) throw new Error(`no such model: ${route}/${model}`)
        return {
          provider: route,
          id: model,
          name: model,
          ...facts.inputModalities === undefined ? {} : { inputModalities: facts.inputModalities },
          ...facts.reasoning === undefined ? {} : { reasoning: facts.reasoning },
        }
      },
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect: (factory) => factory(),
  }
  return { ctx, mutations, logs, listeners, state }
}

/** The persisted layer the fixtures below start from: one custom route, two models. */
const userLayer = () => ({
  providers: {
    'verify-gateway': {
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      models: [
        { id: 'my-chat', name: 'My Chat', contextWindow: 8192, input: ['text', 'image'] },
        { id: 'my-narrow-chat', input: ['text'] },
      ],
    },
  },
})

/**
 * The writes one namespace received, in order.
 *
 * Order is the discriminator and it is deterministic: a round reclaims first and
 * fills second, so on an unreclaimed document the first `llm-pi-ai` write is the
 * removal's and the second the fill's. Both look alike — both set a route's whole
 * `models` array — which is exactly why the assertions reach for a position
 * rather than for a shape.
 */
const writesFor = (mutations, ns) => mutations.filter((entry) => entry.ns === ns)

/** Wait past the plugin's debounce, plus slack for the awaited round. */
const settle = async () => {
  await delay(400)
}

// --- arming -----------------------------------------------------------------

test('apply arms one round from the first pass, and nothing runs synchronously', () => {
  const { ctx, logs, mutations } = contextFor({ user: userLayer(), marker: undefined })

  assert.equal(typeof apply, 'function')
  apply(ctx)

  // The first pass is debounced so plugin rows that apply after this one have
  // landed before the settings section is read.
  assert.deepEqual(logs, [])
  assert.deepEqual(mutations, [])
})

// --- the reclaim ------------------------------------------------------------

test('a first round removes the leftover list and writes the marker, each to its own namespace', async () => {
  const { ctx, mutations, state, logs } = contextFor({ user: userLayer(), marker: undefined })
  apply(ctx)
  await settle()

  const [removal, fill] = writesFor(mutations, 'llm-pi-ai')
  assert.ok(removal !== undefined && fill !== undefined, `expected two llm-pi-ai writes, saw ${JSON.stringify(mutations)}`)
  assert.equal(removal.revision, 1, 'the removal is committed against the revision that was read')
  assert.equal(fill.revision, 2, 'the fill re-reads after that write, so it guards the newer revision')
  assert.deepEqual(removal.ops.map((op) => op.path), [['providers', 'verify-gateway', 'models']])
  // The fallback list is the previous release's own value for an id no catalog
  // route describes; the narrower list beside it is the user speaking.
  assert.equal(Object.hasOwn(removal.ops[0].value[0], 'input'), false)
  assert.deepEqual(removal.ops[0].value[1].input, ['text'])

  const markers = writesFor(mutations, PLUGIN_NAME)
  assert.equal(markers.length, 1, 'the marker is written once, after the removal')
  assert.deepEqual(markers[0].ops, [{ op: 'set', path: ['residualInputsReclaimed'], value: RESIDUAL_INPUT_VERSION }])
  assert.equal(markers[0].revision, undefined, 'the marker carries no revision guard: it is this plugin’s own row')

  // The stub applied both, which is what the next round reads.
  assert.deepEqual(state.config, { residualInputsReclaimed: RESIDUAL_INPUT_VERSION })
  assert.equal(Object.hasOwn(state.user.providers['verify-gateway'].models[0], 'input'), false)
  assert.ok(logs.some((entry) => entry.level === 'info' && entry.message.includes('reclaimed')), 'the cleanup is reported')
})

test('a refused removal is never followed by a marker', async () => {
  const { ctx, mutations, logs, state } = contextFor({ user: userLayer(), marker: undefined, refusals: Number.POSITIVE_INFINITY })
  apply(ctx)
  await settle()

  assert.deepEqual(mutations, [], 'nothing reaches the seam')
  assert.deepEqual(state.config, {}, 'the marker must not claim a cleanup that did not happen')
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('skipped one normalization pass')), `the failure must be visible: ${JSON.stringify(logs)}`)
})

test('a twin list is removed only where the catalog states it', async () => {
  const user = {
    providers: {
      'verify-gateway': {
        models: [
          { id: 'vision-twin', input: ['text', 'image'] },
          { id: 'text-twin', input: ['text', 'image'] },
        ],
      },
    },
  }
  const catalog = { openai: { 'vision-twin': { inputModalities: ['text', 'image'] }, 'text-twin': { inputModalities: ['text'] } } }
  const { ctx, mutations, state } = contextFor({ user, marker: undefined, catalog, catalogRoutes: ['openai'] })
  apply(ctx)
  await settle()

  const models = writesFor(mutations, 'llm-pi-ai')[0].ops[0].value
  assert.equal(Object.hasOwn(models[0], 'input'), false, 'the twin states this list, so it is a leftover')
  assert.deepEqual(models[1].input, ['text', 'image'], 'this id’s twin states text-only, so the list is the user’s')
  assert.equal(Object.hasOwn(state.user.providers['verify-gateway'].models[1], 'input'), true)
})

test('the marker turns the reclaim off, so a later round leaves the field alone', async () => {
  const user = {
    providers: {
      'verify-gateway': {
        models: [{ id: 'my-chat', input: ['text', 'image'], reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }],
      },
    },
  }
  // A marker at the current revision is what a finished upgrade leaves behind;
  // the list beside it is then a choice made in the Models page.
  const { ctx, mutations, logs } = contextFor({ user, marker: RESIDUAL_INPUT_VERSION })
  apply(ctx)
  await settle()

  assert.deepEqual(mutations, [], 'nothing to reclaim and nothing to fill, so nothing is written')
  assert.ok(
    logs.every((entry) => entry.message.includes('no legacy input declarations') === false),
    'the cleanup does not even report itself',
  )
})

test('an older marker still reclaims, a newer one does not', async () => {
  const user = { providers: { 'verify-gateway': { models: [{ id: 'my-chat', input: ['text', 'image'] }] } } }

  const old = contextFor({ user, marker: 0 })
  apply(old.ctx)
  await settle()
  assert.equal(Object.hasOwn(writesFor(old.mutations, 'llm-pi-ai')[0].ops[0].value[0], 'input'), false, 'a marker below the revision re-runs the cleanup')

  const fresh = contextFor({ user, marker: RESIDUAL_INPUT_VERSION + 1 })
  apply(fresh.ctx)
  await settle()
  assert.equal(writesFor(fresh.mutations, 'llm-pi-ai').length, 1, 'a newer marker writes the fill and nothing else')
  assert.equal(Object.hasOwn(fresh.state.user.providers['verify-gateway'].models[0], 'input'), true, 'a newer marker must not delete anything')
})

test('a clean document still writes the marker, so a route added later is never swept', async () => {
  const user = { providers: { 'verify-gateway': { models: [{ id: 'my-chat', reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }] } } }
  const { ctx, mutations } = contextFor({ user, marker: undefined })
  apply(ctx)
  await settle()

  assert.deepEqual(writesFor(mutations, 'llm-pi-ai'), [], 'the effort value is already the computed one')
  assert.equal(writesFor(mutations, PLUGIN_NAME)[0].ops[0].value, RESIDUAL_INPUT_VERSION, 'the cleanup is retired even when it had nothing to do')
})

// --- the capability fill ----------------------------------------------------

test('the fill writes only reasoningEfforts, and only when it differs', async () => {
  const user = { providers: { 'verify-gateway': { models: [{ id: 'my-chat', name: 'My Chat' }] } } }
  const { ctx, mutations, state } = contextFor({ user, marker: RESIDUAL_INPUT_VERSION })
  apply(ctx)
  await settle()

  const write = writesFor(mutations, 'llm-pi-ai')[0]
  assert.deepEqual(write.ops[0].value, [{ id: 'my-chat', name: 'My Chat', reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }])
  assert.equal(Object.hasOwn(state.user.providers['verify-gateway'].models[0], 'input'), false, 'no modality list is invented')
})

test('the fill inherits a twin’s levels and reports where they came from', async () => {
  const user = { providers: { 'verify-gateway': { models: [{ id: 'gpt-5' }] } } }
  const catalog = { openai: { 'gpt-5': { inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }] } } } }
  const { ctx, mutations, logs } = contextFor({ user, marker: RESIDUAL_INPUT_VERSION, catalog, catalogRoutes: ['openai'] })
  apply(ctx)
  await settle()

  assert.deepEqual(writesFor(mutations, 'llm-pi-ai')[0].ops[0].value[0].reasoningEfforts, {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
  })
  assert.ok(logs.some((entry) => entry.message.includes('1 inherited')), `the round reports the source: ${JSON.stringify(logs)}`)
})

// --- settling and failure modes ---------------------------------------------

test('a re-armed round is a no-op once the write has landed', async () => {
  const { ctx, mutations, listeners } = contextFor({ user: userLayer(), marker: RESIDUAL_INPUT_VERSION })
  apply(ctx)
  await settle()
  const settled = mutations.length
  assert.ok(settled > 0, 'the first round writes')

  // The adapter re-registered its routes, which is what the plugin's own write
  // looks like from this side. The stub has applied that write, so the next
  // round reads the computed values and must produce nothing.
  listeners.get('llm/adapters-updated')()
  await settle()

  assert.equal(mutations.length, settled, 'the computed values are already in place, so the loop settles')
})

test('a settled plugin stays settled across repeated change signals', async () => {
  const { ctx, mutations, listeners } = contextFor({ user: userLayer(), marker: undefined })
  apply(ctx)
  await settle()
  const settled = mutations.length

  for (let round = 0; round < 3; round += 1) {
    listeners.get('settings/document-updated')('llm-pi-ai')
    await settle()
  }

  assert.equal(mutations.length, settled, 'a debounced burst per change, each planning nothing')
})

test('an unrelated namespace change does not arm the round', async () => {
  const { ctx, mutations, listeners } = contextFor({ user: userLayer(), marker: RESIDUAL_INPUT_VERSION })
  apply(ctx)
  await settle()
  const settled = mutations.length

  listeners.get('settings/document-updated')('llm-deepseek')
  await settle()

  assert.equal(mutations.length, settled, 'only this plugin’s namespace is a signal')
})

test('a revision conflict is retried once, and a permanent refusal is reported', async () => {
  const conflicted = contextFor({ user: userLayer(), marker: RESIDUAL_INPUT_VERSION, refusals: 1 })
  apply(conflicted.ctx)
  await settle()
  assert.equal(writesFor(conflicted.mutations, 'llm-pi-ai').length, 1, 'the conflict retries and the retry commits')
  assert.ok(conflicted.logs.every((entry) => entry.level === 'info'), `a transient conflict is not a warning: ${JSON.stringify(conflicted.logs)}`)

  const refused = contextFor({ user: userLayer(), marker: RESIDUAL_INPUT_VERSION, refusals: Number.POSITIVE_INFINITY })
  apply(refused.ctx)
  await settle()
  assert.deepEqual(refused.mutations, [])
  assert.ok(refused.logs.some((entry) => entry.level === 'warn'), 'a permanent refusal is a warning, once per round')
})

test('an unresolvable route is skipped for the fill and still swept by the cleanup', async () => {
  const { ctx, mutations, logs, state } = contextFor({
    user: userLayer(),
    marker: RESIDUAL_INPUT_VERSION,
    providers: [{ provider: 'verify-gateway', error: 'this route cannot be resolved' }],
  })
  apply(ctx)
  await settle()

  assert.deepEqual(writesFor(mutations, 'llm-pi-ai'), [], 'the fill keeps its distance from a route that cannot be written')
  assert.equal(Object.hasOwn(state.user.providers['verify-gateway'].models[0], 'input'), true, 'so the leftover list is left alone too, for this round')
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('unresolvable')), 'the skipped route is named')

  // The other half of the rule: the cleanup does not consult that list at all,
  // because deleting a value cannot be refused for the reason a fill can.
  const sweeping = contextFor({
    user: userLayer(),
    marker: undefined,
    providers: [{ provider: 'verify-gateway', error: 'this route cannot be resolved' }],
  })
  apply(sweeping.ctx)
  await settle()
  assert.equal(Object.hasOwn(sweeping.state.user.providers['verify-gateway'].models[0], 'input'), false, 'the cleanup does not care whether the route resolves')
})
