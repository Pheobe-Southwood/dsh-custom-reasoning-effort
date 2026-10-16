/**
 * Unit tests for the models.dev capability source: how one document becomes a
 * per-id level set, and how the snapshot state machine behaves around it.
 *
 * The document shape is the live one (`https://models.dev/api.json`): an object
 * keyed by provider, each holding a `models` dict, each model carrying
 * `reasoning` and `reasoning_options`. The fixtures are deliberately small and
 * hand-written; the real document's disagreement between providers is the case
 * that matters most here (`gemini-4-argon`'s union), because that rule was
 * chosen by the user rather than derived.
 *
 * The clock and the transport are injected, so every timing case is a
 * deterministic assertion instead of a sleep.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TTL_MS,
  MODELS_DEV_URL,
  buildLevelIndex,
  createLevelCatalog,
  declaredLevels,
} from '../lib/modelsdev.js'

// --- fixtures ---------------------------------------------------------------

/** One models.dev document: two providers disagreeing about one id. */
const document = () => ({
  google: {
    id: 'google',
    models: {
      'gemini-4-argon': {
        id: 'gemini-4-argon',
        name: 'Gemini 4 Argon',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      },
      'toggle-only': { id: 'toggle-only', reasoning: true, reasoning_options: [{ type: 'toggle' }] },
      'budget-only': { id: 'budget-only', reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 0, max: 1000 }] },
      'no-options': { id: 'no-options', reasoning: true },
      'nothing-known': { id: 'nothing-known', reasoning: false },
    },
  },
  requesty: {
    id: 'requesty',
    models: {
      'gemini-4-argon': {
        id: 'gemini-4-argon',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }],
      },
      'budget-with-effort': { id: 'budget-with-effort', reasoning: true, reasoning_options: [{ type: 'budget_tokens' }, { type: 'effort', values: ['high'] }] },
    },
  },
  oddities: {
    id: 'oddities',
    models: {
      'spelled-differently': { id: 'spelled-differently', reasoning_options: [{ type: 'effort', values: ['default', 'unknown-level'] }] },
      'missing-id': { reasoning_options: [{ type: 'effort', values: ['xhigh'] }] },
    },
  },
})

// --- declaredLevels ---------------------------------------------------------

test('declaredLevels reads effort values and maps none onto off', () => {
  assert.deepEqual(declaredLevels([{ type: 'effort', values: ['none', 'low'] }]).sort(), ['low', 'off'])
  assert.deepEqual(declaredLevels([{ type: 'effort', values: ['minimal', 'xhigh', 'max'] }]).sort(), ['max', 'minimal', 'xhigh'])
})

test('declaredLevels ignores every option type that names no level', () => {
  assert.deepEqual(declaredLevels([{ type: 'toggle' }]), [])
  assert.deepEqual(declaredLevels([{ type: 'budget_tokens', min: 0, max: 10 }]), [])
  assert.deepEqual(declaredLevels([{ type: 'effort', values: ['default', 'maximum', 7, null] }]), [],
    'a value this harness cannot express names no level')
  assert.deepEqual(declaredLevels(undefined), [])
  assert.deepEqual(declaredLevels('nonsense'), [])
  assert.deepEqual(declaredLevels([null, 'text', { type: 'effort' }]), [])
})

// --- buildLevelIndex --------------------------------------------------------

test('buildLevelIndex unions every provider’s declaration and always adds off', () => {
  const index = buildLevelIndex(document())
  assert.deepEqual(index.levels.get('gemini-4-argon'), ['off', 'low', 'medium', 'high', 'max'],
    'google’s three levels and requesty’s five become one set, in vocabulary order, with off first')
  assert.equal(index.providers, 3)
  assert.equal(index.models, 9, 'every model record is counted, including the ones that describe no level')
})

test('buildLevelIndex keeps one level from the one provider that declares it', () => {
  const index = buildLevelIndex(document())
  assert.deepEqual(index.levels.get('budget-with-effort'), ['off', 'high'], 'an effort option beside a budget option is still an effort option')
  assert.deepEqual(index.levels.get('missing-id'), ['off', 'xhigh'], 'a model keyed by its dict key still lands under its own id')
})

test('buildLevelIndex reports an id with no usable level as unknown', () => {
  const index = buildLevelIndex(document())
  for (const id of ['toggle-only', 'budget-only', 'no-options', 'nothing-known', 'spelled-differently']) {
    assert.equal(index.levels.has(id), false, `${id} declares no level this harness can offer`)
  }
  assert.ok(![...index.levels.values()].some((levels) => !levels.some((level) => level !== 'off')),
    'no entry ever offers nothing but off: the schema would refuse that dict')
})

test('buildLevelIndex is total over the shapes a document can have', () => {
  for (const input of [undefined, null, 7, 'text', [], { a: null }, { a: { models: null } }, { a: { models: { m: null } } }]) {
    const index = buildLevelIndex(input)
    assert.equal(index.levels.size, 0, `${JSON.stringify(input)} yields no levels`)
  }
  const keyed = buildLevelIndex({ p: { models: { 'from-key': { reasoning_options: [{ type: 'effort', values: ['low'] }] } } } })
  assert.deepEqual([...keyed.levels.keys()], ['from-key'], 'the dict key is the id when the record states none')
})

test('buildLevelIndex hands out frozen level lists', () => {
  const index = buildLevelIndex(document())
  assert.equal(Object.isFrozen(index.levels.get('gemini-4-argon')), true)
})

// --- the snapshot state machine --------------------------------------------

/** A fetch stub that answers each call with the next queued entry. */
function transport(queue) {
  const calls = []
  const fetchImpl = (url, options) => {
    calls.push({ url, options })
    const next = queue.shift()
    if (next === undefined) return Promise.reject(new Error('no queued answer'))
    return typeof next === 'function' ? next(url) : Promise.resolve(next)
  }
  return { fetchImpl, calls }
}

/** One successful JSON answer. */
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** The catalog with an injected clock and transport. */
function catalogWith({ queue = [], now, ttlMs = DEFAULT_TTL_MS, retryMs = 1000, onEvent, fetchImpl, ...rest }) {
  const clock = { value: now ?? 0 }
  const transportStub = transport(queue)
  const catalog = createLevelCatalog({
    // `null` is a real value here: it models a runtime with no fetch at all, so
    // only an omitted option falls back to the queue-backed stub.
    fetchImpl: fetchImpl === undefined ? transportStub.fetchImpl : fetchImpl,
    now: () => clock.value,
    ttlMs,
    retryMs,
    onEvent,
    ...rest,
  })
  return { catalog, clock, calls: transportStub.calls }
}

/** Let the in-flight request settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a cold catalog starts one request, reports pending, and then holds the index', async () => {
  const events = []
  const { catalog } = catalogWith({ queue: [jsonResponse(document())], onEvent: (event, detail) => events.push({ event, detail }) })
  assert.equal(catalog.state().status, 'cold', 'nothing is fetched before a round asks')
  assert.equal(catalog.levelsFor('gemini-4-argon'), undefined)

  const asked = catalog.ensure()
  assert.equal(asked.status, 'pending', 'the request is in flight and the round is told to wait')
  assert.equal(catalog.ensure().status, 'pending', 'a second ask does not start a second request')
  await settle()

  const ready = catalog.ensure()
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.levels.get('gemini-4-argon'), ['off', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(catalog.levelsFor('gemini-4-argon'), ['off', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(events.map((entry) => entry.event), ['ready'], 'the completion is announced, which is what re-arms a round')
  assert.equal(events[0].detail.levels.size, 3, 'argon, the budget-with-effort pair and the keyed id are the only describable ones')
})

test('a failed request reports the failure, stays unavailable, and retries on a backoff', async () => {
  const events = []
  const { catalog, clock } = catalogWith({ queue: [new Response('nope', { status: 503 })], retryMs: 1000, onEvent: (event) => events.push(event) })
  catalog.ensure()
  await settle()

  const failed = catalog.ensure()
  assert.equal(failed.status, 'cold')
  assert.equal(failed.attempts, 1)
  assert.match(failed.error, /503/)
  assert.equal(catalog.unavailable, true, 'the round falls back to the standard set while this holds')
  assert.deepEqual(events, ['failed'])

  clock.value += 500
  catalog.ensure()
  await settle()
  assert.equal(catalog.state().attempts, 1, 'the backoff has not elapsed, so nothing was retried')

  clock.value += 1000
  catalog.ensure()
  await settle()
  assert.equal(catalog.state().attempts, 2, 'the retry happens once the backoff has elapsed')
})

test('a document with no usable level is a failure, not an empty answer', async () => {
  const { catalog } = catalogWith({ queue: [jsonResponse({ p: { models: { m: { reasoning_options: [{ type: 'toggle' }] } } } })] })
  catalog.ensure()
  await settle()
  assert.equal(catalog.state().status, 'cold')
  assert.match(catalog.state().error, /no usable model levels/)
  assert.equal(catalog.unavailable, true)
})

test('a stale index is refreshed once the TTL elapses', async () => {
  const { catalog, clock } = catalogWith({ queue: [jsonResponse(document()), jsonResponse({ other: { models: { m: { reasoning_options: [{ type: 'effort', values: ['max'] }] } } } })] })
  catalog.ensure()
  await settle()
  assert.deepEqual(catalog.levelsFor('gemini-4-argon'), ['off', 'low', 'medium', 'high', 'max'])

  clock.value += DEFAULT_TTL_MS - 1
  assert.equal(catalog.ensure().status, 'ready')
  assert.equal(catalog.state().stale, false)
  assert.deepEqual(catalog.levelsFor('gemini-4-argon'), ['off', 'low', 'medium', 'high', 'max'])

  clock.value += 1
  assert.equal(catalog.state().stale, true)
  const during = catalog.ensure()
  assert.equal(during.status, 'ready', 'the stale index keeps answering while the refresh is in flight')
  await settle()
  assert.deepEqual(catalog.levelsFor('gemini-4-argon'), undefined, 'the new document replaces the old one wholesale')
  assert.deepEqual(catalog.levelsFor('m'), ['off', 'max'])
})

test('a runtime with no fetch reports itself unavailable instead of waiting forever', () => {
  const { catalog, calls } = catalogWith({ fetchImpl: null })
  const state = catalog.ensure()
  assert.equal(state.status, 'cold')
  assert.equal(calls.length, 0)
  assert.equal(catalog.unavailable, true, 'the round must fall back to the standard set rather than wait')
})

test('a body above the ceiling is refused instead of buffered', async () => {
  const big = { p: { models: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`m${String(index)}`, { id: `m${String(index)}`, reasoning_options: [{ type: 'effort', values: ['low'] }] }])) } }
  const { catalog } = catalogWith({ queue: [jsonResponse(big)], maxBytes: 16 })
  catalog.ensure()
  await settle()
  assert.equal(catalog.state().status, 'cold')
  assert.match(catalog.state().error, /outgrew 16 bytes/)
})

test('the request asks for compression and names the models.dev document', async () => {
  const { fetchImpl, calls } = transport([jsonResponse(document())])
  const catalog = createLevelCatalog({ fetchImpl, now: () => 0 })
  catalog.ensure()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, MODELS_DEV_URL)
  assert.match(calls[0].options.headers['accept-encoding'], /br/, 'the document is ~5.7 MB raw and ~0.4 MB brotli-encoded')
})

test('refresh bypasses both the TTL and the backoff', async () => {
  const { catalog } = catalogWith({ queue: [new Response('nope', { status: 500 }), jsonResponse(document())], retryMs: 10 ** 9 })
  catalog.ensure()
  await settle()
  assert.equal(catalog.unavailable, true)
  catalog.refresh()
  await settle()
  assert.equal(catalog.state().status, 'ready', 'an explicit refresh is a repair path, so no backoff gates it')
})
