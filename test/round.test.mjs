/**
 * Integration tests for the plugin half: the real pass, mounted on a stateful
 * stub context.
 *
 * `normalizer.test.mjs` and `modelsdev.test.mjs` judge the pieces; this file
 * judges the wiring they cannot reach — which trigger runs a pass, what a
 * refused or failing write does, and what happens to the plugin AFTER a failure.
 * The stub is deliberately thin and hand-written (this package ships no test
 * framework and no dependency on the harness) and it is STATEFUL on purpose:
 * `mutate` applies the ops to the document it serves, so a second pass reads
 * what the first one wrote. That is what makes the settle test real — with a
 * stub that kept answering from the fixture, "the second pass is a no-op" would
 * be a statement about the fixture, not about the plugin.
 *
 * The cases that matter most, because each of them is why this file was
 * rewritten:
 *
 *   - A REFUSED TIMER MUST NOT LATCH. The previous release armed its debounce
 *     through `ctx.effect` and, on a refusal, set a `disposed` flag for the life
 *     of the instance. The harness hot-reloads the profile patch on every
 *     settings write, so one refusal in that window silenced the plugin forever
 *     while its row still read `active` — which is exactly how `gemini-4-argon`
 *     ended up with no picker while its six older siblings kept theirs. The
 *     regression is pinned below: after a refused arm, the plugin still runs.
 *   - THERE IS A THIRD TRIGGER. Events can be missed; the reconcile tick cannot
 *     be, so a pass happens even with no signal at all.
 *   - A FAILURE IS VISIBLE AND DEDUPLICATED. This deployment registers no logger
 *     exporter, so failures also reach the console; and a permanent condition is
 *     reported once, not once per tick.
 *   - THE PLUGIN WRITES TO `llm-pi-ai` AND NOWHERE ELSE. It declares no `Config`
 *     and keeps no marker, which is what an uninstall leaves nothing behind.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { apply, createNormalizer, name as PLUGIN_NAME } from '../lib/index.js'
import { DEFAULT_REASONING_EFFORTS } from '../lib/normalize.js'

// --- fixtures ---------------------------------------------------------------

const CUSTOM = 'verify-gateway'

/** The models.dev document every case fetches, unless it says otherwise. */
const DEV_DOCUMENT = () => ({
  google: {
    models: {
      argon: { id: 'argon', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
      wide: { id: 'wide', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }] },
      'not-reasoning': { id: 'not-reasoning', reasoning: false },
    },
  },
  requesty: {
    models: {
      argon: { id: 'argon', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }] },
    },
  },
})

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 })

/** A transport stub that answers each call with the next queued entry. */
const transport = (answers) => {
  const calls = []
  const fetchImpl = () => {
    calls.push(calls.length)
    const next = answers.shift()
    if (next === undefined) return Promise.reject(new Error('no queued answer'))
    return typeof next === 'function' ? next() : Promise.resolve(next)
  }
  return { fetchImpl, calls }
}

/** The persisted layer holding the given models on the custom route. */
const userLayer = (models) => ({
  providers: { [CUSTOM]: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', models } },
})

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
 * One plugin context good enough for `mount`.
 *
 * `effect` is a real registry, because the plugin's own cleanup contract is
 * under test: it records the disposers, can be told to REFUSE a labelled effect
 * (which is what a fiber unloading mid-reload does), and its factory runs
 * immediately, as Cordis runs it.
 *
 * @param options - the fixture and the failure switches.
 * @returns the context and everything a case asserts on.
 */
function contextFor({
  user,
  catalogRoutes = [],
  providers = [],
  conflictOnce = false,
  permanentError = false,
  permanentConflict = false,
  lieOnWrite = false,
  refuseLabels = {},
  config,
} = {}) {
  const mutations = []
  const logs = []
  const listeners = new Map()
  const disposers = []
  const state = { user: structuredClone(user) }
  const refusals = { conflictOnce, permanentError, permanentConflict }
  let conflictsLeft = conflictOnce ? 1 : 0
  let labelRefusals = { ...refuseLabels }

  const ctx = {
    get config() {
      return config
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: mutations.length + 1,
        autoGenerate: true,
        applies: 'live',
        schema: {},
        value: state.user,
        user: state.user,
      }],
      mutate: async (ns, ops, revision) => {
        if (refusals.permanentError) throw new Error('stub refused the write')
        if (refusals.permanentConflict || conflictsLeft > 0) {
          if (conflictsLeft > 0) conflictsLeft -= 1
          const error = new Error('stub conflict')
          error.code = 'SETTINGS_CONFLICT'
          throw error
        }
        mutations.push({ ns, ops, revision })
        if (!lieOnWrite && ns === 'llm-pi-ai') state.user = applyOps(state.user, ops)
      },
    },
    llm: {
      listConfigurableProviders: () => [
        ...catalogRoutes.map((route) => ({ provider: route, declared: false })),
        ...providers,
      ],
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect: (factory, label) => {
      if ((labelRefusals[label] ?? 0) > 0) {
        labelRefusals[label] -= 1
        throw new Error('INACTIVE_EFFECT')
      }
      const produced = factory()
      const dispose = () => {
        const at = disposers.indexOf(dispose)
        if (at >= 0) disposers.splice(at, 1)
        if (typeof produced === 'function') produced()
      }
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    mutations,
    logs,
    listeners,
    state,
    /** Every cleanup still registered on the fiber. */
    liveEffects: () => [...disposers],
    /** Run every registered cleanup; every case that mounts must call this. */
    cleanup: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    mutationsFor: (ns = 'llm-pi-ai') => mutations.filter((entry) => entry.ns === ns),
  }
}

/** Mount the plugin with a queued transport. */
function mountWith(options, normalizerOptions = {}) {
  const stub = contextFor(options)
  const answers = options.answers ?? [jsonResponse(DEV_DOCUMENT())]
  const { fetchImpl, calls } = transport(answers)
  const normalizer = createNormalizer({ fetchImpl, debounceMs: 15, reconcileMs: 10 ** 9, ...normalizerOptions })
  normalizer.mount(stub.ctx)
  return { ...stub, normalizer, calls }
}

/** Wait past the debounce plus slack for the awaited pass. */
const settle = (ms = 80) => delay(ms)

/** The `models` array of the last committed write. */
const writtenModels = (mutations) => mutations[mutations.length - 1]?.ops[0].value

/** Capture `console.warn` for the duration of one awaited block. */
async function capturedWarnings(run) {
  const original = console.warn
  const seen = []
  console.warn = (line) => seen.push(String(line))
  try {
    return await run(seen)
  } finally {
    console.warn = original
  }
}

// --- arming -----------------------------------------------------------------

test('mounting arms a round and writes nothing synchronously', () => {
  const { ctx, mutations, logs, cleanup } = contextFor({ user: userLayer([{ id: 'argon' }]) })
  try {
    apply(ctx)
    assert.deepEqual(mutations, [])
    assert.deepEqual(logs, [])
  } finally {
    cleanup()
  }
})

test('the first pass waits for the capability source, and the fetch completion writes', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]), answers: [() => pending] })
  try {
    await settle(40)
    assert.deepEqual(stub.mutations, [], 'the document must not be stamped with the standard set while models.dev is still arriving')
    assert.equal(stub.normalizer.catalog.state().status, 'pending')

    release(jsonResponse(DEV_DOCUMENT()))
    await settle()
    const written = writtenModels(stub.mutations)
    assert.deepEqual(written[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
      'the union of the two providers’ declarations, with off first')
    assert.equal(stub.mutations.length, 1)
    assert.equal(stub.mutations[0].ns, 'llm-pi-ai')
    assert.equal(stub.mutations[0].revision, 1, 'the write is guarded by the revision it read')
  } finally {
    stub.cleanup()
  }
})

test('an id models.dev does not describe takes the standard set', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'unknown-model' }, { id: 'argon' }]) })
  try {
    await settle()
    const written = writtenModels(stub.mutations)
    assert.deepEqual(written[0].reasoningEfforts, DEFAULT_REASONING_EFFORTS)
    assert.deepEqual(written[1].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' })
    assert.ok(stub.logs.some((entry) => entry.message.includes('1 from models.dev, 1 standard')), `the round reports its sources: ${JSON.stringify(stub.logs)}`)
  } finally {
    stub.cleanup()
  }
})

test('a profile with no custom routes never touches the network', async () => {
  const stub = mountWith({ user: { providers: { openai: { models: [{ id: 'gpt-5' }] } } }, catalogRoutes: ['openai'] })
  try {
    await settle()
    assert.equal(stub.calls.length, 0)
    assert.deepEqual(stub.mutations, [])
  } finally {
    stub.cleanup()
  }
})

// --- the failure the plugin must never repeat -------------------------------

test('a refused timer is reported and does not disable the plugin', async () => {
  // This is the production failure in miniature: the initial arm is refused
  // (as it is while the harness reloads the profile patch), and the plugin has
  // to keep working. The previous release latched here and went silent forever.
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]), refuseLabels: { 'custom-reasoning-effort:round': 1 } })
  try {
    await settle()
    assert.deepEqual(stub.mutations, [], 'the refused arm ran nothing')
    assert.ok(
      stub.logs.some((entry) => entry.level === 'warn' && entry.message.includes('could not arm the debounced round')),
      `the refusal must be reported: ${JSON.stringify(stub.logs)}`,
    )

    stub.listeners.get('settings/document-updated')('llm-pi-ai')
    await settle()
    assert.equal(stub.mutations.length, 1, 'the next signal still arms a round')
    assert.deepEqual(writtenModels(stub.mutations)[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' })
  } finally {
    stub.cleanup()
  }
})

test('the reconcile tick runs a pass with no event at all', async () => {
  // The self-healing trigger: a missed or refused event can strand a model
  // forever if the only way to run a pass is another event.
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]) }, { debounceMs: 10 ** 9, reconcileMs: 15 })
  try {
    await settle(120)
    assert.equal(stub.mutations.length, 1, 'the tick re-ran the pass and wrote the fill')
  } finally {
    stub.cleanup()
  }
})

test('the reconcile tick stops with the plugin', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]) }, { debounceMs: 10 ** 9, reconcileMs: 15 })
  await settle(60)
  const written = stub.mutations.length
  stub.cleanup()
  await settle(60)
  assert.equal(stub.mutations.length, written, 'a disposed plugin writes nothing more')
})

// --- visible, deduplicated failures ----------------------------------------

test('an unavailable models.dev falls back, warns once, and keeps retrying quietly', async () => {
  const stub = mountWith({
    user: userLayer([{ id: 'argon' }]),
    answers: [new Response('down', { status: 503 })],
  })
  try {
    await capturedWarnings(async (consoleLines) => {
      await settle()
      assert.deepEqual(writtenModels(stub.mutations)[0].reasoningEfforts, DEFAULT_REASONING_EFFORTS,
        'the picker must still appear while the source is unreachable')
      const warnings = stub.logs.filter((entry) => entry.level === 'warn')
      assert.equal(warnings.length, 1, `one warning per cause, not one per pass: ${JSON.stringify(stub.logs)}`)
      assert.match(warnings[0].message, /models\.dev is unavailable \(models\.dev answered 503\)/)
      assert.ok(consoleLines.some((line) => line.startsWith(`[${PLUGIN_NAME}]`)),
        'this deployment registers no logger exporter, so a failure must also reach the console')

      stub.listeners.get('settings/document-updated')('llm-pi-ai')
      await settle()
      assert.equal(stub.logs.filter((entry) => entry.level === 'warn').length, 1, 'the same cause is not reported again')
    })
  } finally {
    stub.cleanup()
  }
})

test('a lying seam is caught by the verification pass', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]), lieOnWrite: true })
  try {
    await capturedWarnings(async () => {
      await settle(150)
      assert.ok(
        stub.logs.some((entry) => entry.level === 'warn' && entry.message.includes('the write landed but')),
        `a write that did not land must be visible: ${JSON.stringify(stub.logs)}`,
      )
      assert.equal(stub.mutations.length, 1, 'the failed verification is reported, not retried in a loop')
    })
  } finally {
    stub.cleanup()
  }
})

test('a revision conflict is retried once and a permanent refusal is warned once', async () => {
  const conflicted = mountWith({ user: userLayer([{ id: 'argon' }]), conflictOnce: true })
  try {
    await settle()
    assert.equal(conflicted.mutations.length, 1, 'the retry re-reads and commits')
    assert.ok(conflicted.logs.every((entry) => entry.level === 'info'), `a transient conflict is not a warning: ${JSON.stringify(conflicted.logs)}`)
  } finally {
    conflicted.cleanup()
  }

  const refused = mountWith({ user: userLayer([{ id: 'argon' }]), permanentError: true })
  try {
    await capturedWarnings(async () => {
      await settle()
      assert.deepEqual(refused.mutations, [])
      const warnings = refused.logs.filter((entry) => entry.level === 'warn')
      assert.equal(warnings.length, 1, 'the permanent refusal is reported once per cause')
      assert.match(warnings[0].message, /skipped one normalization pass \(stub refused the write\)/)

      refused.listeners.get('llm/adapters-updated')()
      await settle()
      assert.equal(refused.logs.filter((entry) => entry.level === 'warn').length, 1, 'a repeat of the same cause stays quiet')
    })
  } finally {
    refused.cleanup()
  }
})

// --- the document rules the pass must respect -------------------------------

test('an unresolvable route is skipped and still written around', async () => {
  const user = {
    providers: {
      [CUSTOM]: { models: [{ id: 'argon' }] },
      broken: { models: [{ id: 'argon' }] },
    },
  }
  const stub = mountWith({ user, providers: [{ provider: 'broken', error: 'this route cannot be resolved' }] })
  try {
    await settle()
    assert.deepEqual(stub.mutations.flatMap((entry) => entry.ops.map((op) => op.path[1])), [CUSTOM],
      'the healthy route commits; the unresolvable one is left for the next pass')
    assert.ok(stub.logs.some((entry) => entry.level === 'warn' && entry.message.includes('unresolvable custom route(s)')), 'the skip is named')
  } finally {
    stub.cleanup()
  }
})

test('an explicit false opt-out is carried through untouched', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'argon', reasoningEfforts: false }, { id: 'wide' }]) })
  try {
    await settle()
    const written = writtenModels(stub.mutations)
    assert.equal(written[0].reasoningEfforts, false)
    assert.deepEqual(written[1].reasoningEfforts, DEFAULT_REASONING_EFFORTS, 'an id models.dev only calls non-reasoning still gets the standard set')
  } finally {
    stub.cleanup()
  }
})

test('a write that already landed settles, and repeated signals produce nothing', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]) })
  try {
    await settle()
    const settled = stub.mutations.length
    assert.equal(settled, 1)

    for (let round = 0; round < 3; round += 1) {
      stub.listeners.get('settings/document-updated')('llm-pi-ai')
      await settle()
    }
    assert.equal(stub.mutations.length, settled, 'the computed values are in place, so the loop settles')

    stub.listeners.get('settings/document-updated')('llm-deepseek')
    await settle()
    assert.equal(stub.mutations.length, settled, 'only this plugin’s namespace is a signal')
  } finally {
    stub.cleanup()
  }
})

test('the plugin writes to the adapter’s namespace and nowhere else', async () => {
  const stub = mountWith({ user: userLayer([{ id: 'argon' }]) })
  try {
    await settle()
    assert.ok(stub.mutations.length > 0)
    for (const mutation of stub.mutations) {
      assert.equal(mutation.ns, 'llm-pi-ai', 'no marker, no own config namespace: an uninstall leaves nothing in the profile patch')
    }
  } finally {
    stub.cleanup()
  }
})

test('a spent debounce timer releases its registration instead of piling up', async () => {
  // Two long-lived effects (lifecycle + reconcile) plus at most one armed round:
  // a harness that runs for weeks must not accumulate one passed-over effect per
  // settings write.
  const stub = mountWith({ user: userLayer([{ id: 'argon' }, { id: 'wide' }]) })
  try {
    await settle()
    for (let round = 0; round < 5; round += 1) {
      stub.listeners.get('settings/document-updated')('llm-pi-ai')
      await settle()
    }
    assert.ok(stub.liveEffects().length <= 3, `expected at most three live effects, saw ${String(stub.liveEffects().length)}`)
  } finally {
    stub.cleanup()
    assert.deepEqual(stub.liveEffects(), [], 'disposal clears whatever is left')
  }
})

test('the row config tunes the timers and a stale marker object is ignored', async () => {
  const stub = contextFor({ user: userLayer([{ id: 'argon' }]) })
  const { fetchImpl } = transport([jsonResponse(DEV_DOCUMENT())])
  try {
    // The row config of a profile upgraded from 0.4.0 still carries the retired
    // marker; it must be ignored, while the tuning keys are honoured.
    apply(stub.ctx, { residualInputsReclaimed: 1, debounceMs: 5, reconcileIntervalMs: 10 ** 9, fetchImpl })
    await settle()
    assert.equal(stub.mutations.length, 1, 'the tuning keys are read and the unknown marker key is ignored')
  } finally {
    stub.cleanup()
  }
})

test('a context whose settings namespace is absent is left alone', async () => {
  const stub = contextFor({ user: userLayer([{ id: 'argon' }]) })
  const withoutNamespace = { ...stub.ctx, settings: { describe: () => [] } }
  const normalizer = createNormalizer({ debounceMs: 5, reconcileMs: 10 ** 9 })
  try {
    normalizer.mount(withoutNamespace)
    await settle(40)
    assert.deepEqual(stub.mutations, [], 'nothing is written, and nothing throws')
  } finally {
    stub.cleanup()
  }
})
