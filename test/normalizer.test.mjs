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
 * The modality half is judged the same way: the `input` schema (`:973`, with
 * `MODALITIES` at `:279-282`) is mirrored as `isInputLegal`, including the one
 * semantic the schema cannot state — `[]` is legal but means "no declaration"
 * (`declaredInput`, `:292-294`), which is why a written list must never be
 * empty.
 *
 * Run with `npm run test:host`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INPUT_MODALITIES,
  DEFAULT_REASONING_EFFORTS,
  MODALITIES,
  THINKING_LEVELS,
  customModelIds,
  defaultInputModalities,
  effortsForLevels,
  planNormalization,
  plannedModalities,
  twinCapability,
  twinModalities,
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

/**
 * One model's capability fact, as `lib/index.js` captures it. `modalities` is
 * optional because a route may state no modality list at all, which the map
 * carries as `undefined` rather than as an empty declaration.
 */
const reasons = (levels, modalities) => ({ reasoning: true, levels, modalities })
const noReasoning = { reasoning: false, levels: [], modalities: undefined }

/** The path op one route's models produce. */
const opFor = (plan, route = 'my-gateway') => {
  const op = plan.ops.find((entry) => entry.path.join('/') === `providers/${route}/models`)
  assert.ok(op !== undefined, `expected an op for route ${route}, saw ${JSON.stringify(plan.ops)}`)
  return op
}

/** The `reasoningEfforts` a plan writes for the first model of one route. */
const effortsFor = (plan, route = 'my-gateway') => opFor(plan, route).value[0].reasoningEfforts

/** The `input` a plan writes for the first model of one route. */
const inputFor = (plan, route = 'my-gateway') => opFor(plan, route).value[0].input

/**
 * One model entry without its two capability fields, for the "nothing else was
 * touched" comparisons. Built by deleting from a copy rather than by
 * destructuring, so the omitted fields are named once and no binding is left
 * unused.
 */
const withoutCapabilities = (entry) => {
  const rest = { ...entry }
  delete rest.reasoningEfforts
  delete rest.input
  return rest
}

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
    inputDeclared: 0,
    modalityInherited: 0,
    modalityDefaulted: 1,
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

  // Both fields declared, so the opt-out really is the reason nothing is
  // planned — the modality half of the entry is a declaration of its own.
  const plan = planNormalization(snapshotOf([{ id: 'gpt-5', reasoningEfforts: false, input: ['text'] }]), catalog)

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.planned, 0)
  assert.equal(plan.summary.inputDeclared, 1)
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
  // The opt-out is field-scoped: it says this model does not reason, not that
  // the model takes no images, so the input list is filled on both entries.
  assert.deepEqual(models[0].input, [...DEFAULT_INPUT_MODALITIES])
  assert.deepEqual(models[1].input, [...DEFAULT_INPUT_MODALITIES])
  assert.equal(plan.summary.optedOut, 1)
  assert.equal(plan.summary.planned, 1)
  assert.equal(plan.summary.modalityDefaulted, 2)
})

// --- (f) already equal → no ops ---------------------------------------------

test('(f) a model already carrying both computed values produces no ops', () => {
  const plan = planNormalization(
    snapshotOf([{ id: 'internal-model-v3', reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS }, input: ['text', 'image'] }]),
    catalogOf({}),
  )

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.unchanged, 1)
  assert.equal(plan.summary.inputDeclared, 1)
})

test('(f) an inherited value is idempotent on the next pass', () => {
  const catalog = catalogOf({ anthropic: { 'claude-twin': reasons(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], ['text', 'image']) } })
  const first = planNormalization(snapshotOf([{ id: 'claude-twin' }]), catalog)
  assert.equal(first.ops.length, 1)

  // The write is the state the next pass reads, key order included: the same
  // values must plan nothing, or the plugin would rewrite itself forever. Both
  // filled fields are derived here — the dict is recomputed to the same value
  // and the list is now a declaration the next pass preserves.
  const written = opFor(first).value
  const second = planNormalization(snapshotOf(written), catalog)

  assert.deepEqual(second.ops, [])
  assert.equal(second.summary.unchanged, 1)
  assert.equal(second.summary.inputDeclared, 1)
  assert.equal(second.summary.modalityInherited, 0)
  assert.equal(second.summary.modalityDefaulted, 0)
})

test('(f) a reordered dict and a reordered list are still the same values', () => {
  const plan = planNormalization(
    snapshotOf([{
      id: 'internal-model-v3',
      reasoningEfforts: { max: 'max', high: 'high', off: null, minimal: 'minimal', medium: 'medium', low: 'low', xhigh: 'xhigh' },
      input: ['image', 'text'],
    }]),
    catalogOf({}),
  )

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.inputDeclared, 1)
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

// --- (h) ops touch nothing but the two capability fields --------------------

test('(h) ops touch nothing on a model but its capability fields', () => {
  const plan = planNormalization(
    snapshotOf(
      [
        { id: 'gpt-5', name: 'Shared', contextWindow: 400000, input: ['text', 'image'] },
        { id: 'my-embedding', reasoningEfforts: false },
        { id: 'my-chat', compat: { thinkingFormat: 'deepseek' } },
      ],
      { displayName: 'Gateway', defaultMaxTokens: 8192 },
    ),
    catalogOf({ openai: { 'gpt-5': reasons(['minimal', 'low', 'medium', 'high'], ['text', 'image']) } }),
  )

  assert.equal(plan.ops.length, 1)
  const [op] = plan.ops
  assert.equal(op.op, 'set')
  // WHY the whole array: the shipped settings applier only descends through
  // plain objects, so `['providers', route, 'models', '0', 'reasoningEfforts']`
  // would replace the array with an object keyed "0" and the write would be
  // rejected as `models expected array`. This assertion pins the shape that
  // actually works, and the next ones pin what "only the capability fields" means.
  assert.deepEqual(op.path, ['providers', 'my-gateway', 'models'])

  const before = snapshotOf([
    { id: 'gpt-5', name: 'Shared', contextWindow: 400000, input: ['text', 'image'] },
    { id: 'my-embedding', reasoningEfforts: false },
    { id: 'my-chat', compat: { thinkingFormat: 'deepseek' } },
  ]).providers['my-gateway'].models
  assert.equal(op.value.length, before.length)
  op.value.forEach((entry, index) => {
    assert.deepEqual(withoutCapabilities(entry), withoutCapabilities(before[index]), `model ${entry.id} must keep every other field`)
    assert.ok(isSchemaLegal(entry.reasoningEfforts), `model ${entry.id} must carry a legal effort value`)
    assert.ok(isInputLegal(entry.input), `model ${entry.id} must carry a legal input list`)
  })
  // A declared list survives untouched, ordering and all; only the entries that
  // declared nothing gain the field.
  assert.deepEqual(op.value[0].input, ['text', 'image'])
  assert.deepEqual(op.value[1].input, [...DEFAULT_INPUT_MODALITIES])
  assert.deepEqual(Object.keys(op.value[0]), ['id', 'name', 'contextWindow', 'input', 'reasoningEfforts'], 'key order is preserved, the new field appended')
  assert.deepEqual(Object.keys(op.value[1]), ['id', 'reasoningEfforts', 'input'], 'a stored key keeps its place, the filled one is appended')
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
    assert.ok(op.value.every((entry) => isInputLegal(entry.input)))
  }
})

// --- the modality halves of a capability -------------------------------------

test('twinModalities separates agreement, ambiguity and silence', () => {
  const catalog = catalogOf({
    openai: {
      shared: reasons(['low'], ['text', 'image']),
      silence: reasons(['low']),
      echo: reasons(['low'], ['text', 'text']),
      levels: reasons(['low'], ['text']),
    },
    openrouter: {
      shared: reasons(['low'], ['image', 'text']),
      silence: reasons(['low'], undefined),
      echo: reasons(['low'], ['text']),
      levels: reasons(['high'], ['text']),
    },
    // Only one route describes this id, and it states a set.
    solo: { lonely: reasons(['low'], ['text']) },
  })

  // The two routes state the same SET, so ordering is not a disagreement.
  assert.deepEqual(twinModalities(catalog, 'shared'), { status: 'agreed', modalities: ['text', 'image'] })
  // Duplicates are not a disagreement either: the comparison is on sets.
  assert.deepEqual(twinModalities(catalog, 'echo'), { status: 'agreed', modalities: ['text'] })
  // One route stating nothing leaves the id described in two places and
  // decidable in only one, which is not an agreement.
  assert.deepEqual(twinModalities(catalog, 'silence'), { status: 'unknown', modalities: undefined })
  assert.deepEqual(twinModalities(catalog, 'lonely'), { status: 'agreed', modalities: ['text'] })
  assert.deepEqual(twinModalities(catalog, 'no-such-id'), { status: 'none', modalities: undefined })
  assert.deepEqual(twinModalities(catalogOf({ openai: { 'shared': reasons(['low'], ['text']) }, anthropic: { 'shared': reasons(['low'], ['text', 'image']) } }), 'shared'), { status: 'ambiguous', modalities: undefined })

  // Independence, in both directions: the modality status is never consulted by
  // the reasoning helper, and the level set is never consulted by this one.
  assert.deepEqual(twinCapability(catalog, 'shared'), { status: 'agreed', reasoning: true, levels: ['low'] })
  assert.deepEqual(twinCapability(catalog, 'silence'), { status: 'agreed', reasoning: true, levels: ['low'] })
  assert.deepEqual(twinModalities(catalog, 'levels'), { status: 'agreed', modalities: ['text'] })
  assert.deepEqual(twinCapability(catalog, 'levels'), { status: 'ambiguous', reasoning: false, levels: [] })
})

// --- (i) input modalities: twin → inherit, else the fallback ----------------

test('(i) a vision-capable twin supplies its modality list', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['low', 'high'], ['text', 'image']) } })

  const plan = planNormalization(snapshotOf([{ id: 'gpt-5' }]), catalog)

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.deepEqual(effortsFor(plan), { low: 'low', high: 'high' })
  assert.equal(plan.summary.modalityInherited, 1)
  assert.equal(plan.summary.modalityDefaulted, 0)
})

test('(i) a text-only twin is inherited as text-only', () => {
  const catalog = catalogOf({ openai: { 'gpt-4o-mini': reasons(['low', 'high'], ['text']) } })

  const plan = planNormalization(snapshotOf([{ id: 'gpt-4o-mini' }]), catalog)

  // Capability truth, not the fallback: a text-only builtin model must not gain
  // image input just because it is used through a custom route.
  assert.deepEqual(inputFor(plan), ['text'])
  assert.equal(plan.summary.modalityInherited, 1)
})

test('(i) a non-reasoning twin can still be vision-capable', () => {
  // The two facts are captured and inherited independently, so a twin that does
  // not reason still supplies its modality list.
  const catalog = catalogOf({ openai: { 'vision-lite': { reasoning: false, levels: [], modalities: ['text', 'image'] } } })

  const plan = planNormalization(snapshotOf([{ id: 'vision-lite' }]), catalog)

  assert.equal(effortsFor(plan), false)
  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.equal(plan.summary.nonReasoning, 1)
  assert.equal(plan.summary.modalityInherited, 1)
})

test('(i) no twin falls back to the image-capable default list', () => {
  const plan = planNormalization(snapshotOf([{ id: 'internal-model-v3' }]), catalogOf({ openai: { 'gpt-5': reasons(['high'], ['text', 'image']) } }))

  assert.equal(plan.ops.length, 1)
  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.deepEqual(inputFor(plan), [...DEFAULT_INPUT_MODALITIES])
  assert.equal(plan.summary.modalityDefaulted, 1)
  assert.equal(plan.summary.modalityInherited, 0)
})

test('(i) a twin that states no modalities falls back instead of inventing one', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['high'], undefined) } })

  const plan = planNormalization(snapshotOf([{ id: 'gpt-5' }]), catalog)

  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.equal(plan.summary.modalityDefaulted, 1)
  assert.equal(plan.summary.inherited, 1, 'the reasoning half of the same twin is still inherited')
})

test('(i) twins disagreeing only about modalities keep the reasoning inheritance', () => {
  // The cross-contamination guard: the reasoning twin agrees, the modality
  // twins do not, and neither fact may decide the other.
  const catalog = catalogOf({
    openai: { 'shared-id': reasons(['low', 'high'], ['text']) },
    anthropic: { 'shared-id': reasons(['low', 'high'], ['text', 'image']) },
  })

  const plan = planNormalization(snapshotOf([{ id: 'shared-id' }]), catalog)

  assert.deepEqual(effortsFor(plan), { low: 'low', high: 'high' })
  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.equal(plan.summary.inherited, 1, 'the reasoning field is not pushed onto the fallback')
  assert.equal(plan.summary.defaulted, 0)
  assert.equal(plan.summary.modalityInherited, 0)
  assert.equal(plan.summary.modalityDefaulted, 1)
})

// --- (j) an explicit list is a judgement ------------------------------------

test('(j) explicit lists are preserved byte for byte', () => {
  const catalog = catalogOf({ openai: { 'my-chat': reasons(['low'], ['text', 'image']) } })

  for (const input of [['text'], ['text', 'image'], ['image', 'text'], ['image']]) {
    // The effort value is already the computed one, so the only thing that
    // could produce a write here is the list — and it must not.
    const plan = planNormalization(snapshotOf([{ id: 'my-chat', reasoningEfforts: { low: 'low' }, input }]), catalog)
    // No op at all: the list is a declaration, so nothing about this entry
    // needs a write — including the reordered `['image', 'text']`, which is
    // never rewritten to be sorted.
    assert.deepEqual(plan.ops, [], `input ${JSON.stringify(input)} must not be rewritten`)
    assert.equal(plan.summary.inputDeclared, 1)
    assert.equal(plan.summary.modalityInherited, 0)
    assert.equal(plan.summary.modalityDefaulted, 0)
  }
})

test('(j) a declared list survives while the sibling field is filled', () => {
  const catalog = catalogOf({})
  const plan = planNormalization(
    snapshotOf([{ id: 'my-chat', input: ['text'] }, { id: 'my-other-chat' }]),
    catalog,
  )

  assert.equal(plan.ops.length, 1)
  const models = opFor(plan).value
  assert.deepEqual(models[0].input, ['text'], 'the declaration is not widened to the fallback')
  assert.deepEqual(models[1].input, ['text', 'image'])
  assert.equal(plan.summary.inputDeclared, 1)
  assert.equal(plan.summary.modalityDefaulted, 1)
})

test('(j) an empty list is not a declaration and is filled', () => {
  const catalog = catalogOf({})

  const plan = planNormalization(snapshotOf([{ id: 'my-chat', input: [] }]), catalog)

  // `[]` is what `declaredInput` reads as "no answer", so filling it is the
  // only thing that can make the model accept an image.
  assert.equal(plan.ops.length, 1)
  assert.deepEqual(inputFor(plan), ['text', 'image'])
  assert.equal(plan.summary.inputDeclared, 0)
  assert.equal(plan.summary.modalityDefaulted, 1)
})

// --- (k) one op carries both fields -----------------------------------------

test('(k) an entry missing both fields produces a single op carrying both', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['low', 'high'], ['text', 'image']) } })

  const plan = planNormalization(snapshotOf([{ id: 'gpt-5' }]), catalog)

  assert.equal(plan.ops.length, 1, 'one model, one route, one write')
  assert.deepEqual(opFor(plan).value[0], {
    id: 'gpt-5',
    reasoningEfforts: { low: 'low', high: 'high' },
    input: ['text', 'image'],
  })
  assert.equal(plan.summary.planned, 1)
  assert.equal(plan.summary.modalityInherited, 1)
})

test('(k) the input list a pass writes is a declaration on the next pass', () => {
  const plan = planNormalization(snapshotOf([{ id: 'internal-model-v3' }]), catalogOf({}))

  const written = opFor(plan).value
  assert.deepEqual(written[0].input, ['text', 'image'])
  const second = planNormalization(snapshotOf(written), catalogOf({}))

  // The loop breaker covers both fields: the list this pass wrote is a
  // non-empty declaration, so the pass its own write triggers plans nothing.
  assert.deepEqual(second.ops, [])
  assert.equal(second.summary.inputDeclared, 1)
  assert.equal(second.summary.modalityDefaulted, 0)
  assert.equal(second.summary.unchanged, 1)
})

test('(k) every id-bearing model lands in exactly one modality bucket', () => {
  const catalog = catalogOf({ openai: { 'gpt-5': reasons(['low'], ['text', 'image']) } })
  const plan = planNormalization(
    snapshotOf([
      { id: 'gpt-5' },
      { id: 'declared', input: ['text'] },
      { id: 'unknown-model' },
      { id: 'opted-out', reasoningEfforts: false },
      { name: 'no id' },
    ]),
    catalog,
  )

  const { models, inputDeclared, modalityInherited, modalityDefaulted } = plan.summary
  assert.equal(models, 4, 'the entry with no id is counted nowhere')
  assert.equal(inputDeclared + modalityInherited + modalityDefaulted, models)
  assert.equal(inputDeclared, 1)
  assert.equal(modalityInherited, 1)
  assert.equal(modalityDefaulted, 2)
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

/**
 * The shipped `input` schema in miniature
 * (`z.array(z.union(MODALITIES))`, `dsh-llm-pi-ai/lib/index.js:973`, with
 * `MODALITIES` at `:279-282`), plus the one semantic the schema cannot state:
 * `[]` is legal but means "states no answer", exactly like an absent field
 * (`declaredInput`, `:292-294`), so a list this plugin writes must never be
 * empty — it would silently undo the fill it was meant to be.
 */
const isInputLegal = (input) => Array.isArray(input)
  && input.length > 0
  && input.every((modality) => MODALITIES.includes(modality))

test('every planned value is schema-legal', () => {
  const catalog = catalogOf({
    openai: {
      'gpt-5': reasons(['minimal', 'low', 'medium', 'high'], ['text', 'image']),
      'text-embedding-3-small': { reasoning: false, levels: [], modalities: ['text'] },
    },
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
  for (const entry of opFor(plan).value) {
    assert.ok(isSchemaLegal(entry.reasoningEfforts), `${entry.id} carries an illegal effort value`)
    assert.ok(isInputLegal(entry.input), `${entry.id} carries an illegal input list`)
  }
  // The vision twin's list is inherited and the text-only twin's is inherited
  // as it stands — capability truth, not the fallback.
  assert.deepEqual(opFor(plan).value[0].input, ['text', 'image'])
  assert.deepEqual(opFor(plan).value[1].input, ['text'])
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

test('the modality helpers never invent an illegal list', () => {
  const unknownTwin = (modalities) => catalogOf({ openai: { weird: { reasoning: true, levels: ['high'], modalities } } })
  const catalogs = [
    undefined,
    null,
    'nonsense',
    { models: null },
    { models: [] },
    // A twin naming a modality this vocabulary does not know states nothing
    // copyable: the write is validated as a whole, so such a member must never
    // reach the document.
    unknownTwin(['vision']),
    unknownTwin('image'),
    unknownTwin([]),
  ]
  for (const catalog of catalogs) {
    const planned = plannedModalities(catalog, 'weird')
    assert.deepEqual(planned.value, [...DEFAULT_INPUT_MODALITIES], `catalog ${JSON.stringify(catalog)} must fall back`)
    assert.ok(isInputLegal(planned.value))
  }
  assert.ok(isInputLegal(defaultInputModalities()))
  // Every returned list is a fresh one: these arrays are written into a settings
  // document, where two entries of one op sharing an instance would be one
  // object in every consumer of that value.
  assert.notEqual(defaultInputModalities(), DEFAULT_INPUT_MODALITIES)
  assert.notEqual(plannedModalities(catalogs[0], 'weird').value, plannedModalities(catalogs[0], 'weird').value)
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
  const catalog = catalogOf({ openai: { 'healthy-model': reasons(['low', 'high'], ['text']) } })

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
    inputDeclared: 0,
    modalityInherited: 1,
    modalityDefaulted: 0,
  })
  assert.deepEqual(effortsFor(plan, 'healthy'), { low: 'low', high: 'high' })
  assert.deepEqual(inputFor(plan, 'healthy'), ['text'])

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
    assert.deepEqual(inputFor(plan), [...DEFAULT_INPUT_MODALITIES], 'a catalog that cannot be read states no modalities')
  }
})

test('entries that cannot carry an id are left exactly as they are', () => {
  const plan = planNormalization(snapshotOf([{ name: 'no id' }, null, 'nonsense']), catalogOf({}))

  assert.deepEqual(plan.ops, [])
  assert.equal(plan.summary.models, 0)
})
