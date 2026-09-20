/**
 * Pure planning for the `llm-pi-ai` settings normalizer.
 *
 * WHY this module is separate: "what should this model's `reasoningEfforts`
 * and `input` be" is derived state computed from exactly two inputs — the
 * persisted `llm-pi-ai` provider layer and the installed catalog's capability
 * facts. Keeping the rules free of `ctx`, of services and of I/O makes them
 * directly testable against plain objects (`test/normalizer.test.mjs`) and keeps
 * the plugin entry (`lib/index.js`) concerned only with reading services,
 * building the capability map and writing settings.
 *
 * WHAT IS FILLED, AND WHY — one route-keyed root cause hides two per-model
 * capability fields, and neither of them can be inherited by a custom provider
 * route (a route key the installed catalog, which is keyed by route, does not
 * ship):
 *
 *   - `reasoningEfforts`. `resolveModelReasoning(provider, entry, base)` in
 *     `dsh-llm-pi-ai/lib/index.js` returns
 *     `{ reasoning: base?.reasoning ?? false }` when the entry declares no
 *     `reasoningEfforts`, and `base` is the installed catalog entry **of that
 *     same model id on that same route**. A custom route has no such entry, so
 *     the model resolves to `reasoning: false`, the model catalog entry carries
 *     no `reasoning`, and the composer's official 推理等级 picker stays hidden.
 *     The per-model `reasoningEfforts` field is the only other lawful source of
 *     that capability, which is what this planner fills.
 *   - `input`. `resolveEntry` resolves modalities as
 *     `input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`
 *     (`dsh-llm-pi-ai/lib/index.js:682`), and `declaredInput` (`:292-294`)
 *     answers `undefined` for an absent OR empty list — `[]` describes a model
 *     that accepts nothing, so it states no answer at all. A custom route has no
 *     `base` either, so every one of its models resolves to the profile default
 *     `["text"]` (`DEFAULT_INPUT`, `:906`; the profile's `defaultInput` defaults
 *     to the same, `:993`). That resolved list is what every modality consumer
 *     reads: the host-side prompt admission gate refuses an attached image with
 *     `MODEL_DOES_NOT_SUPPORT_IMAGES` as soon as the list exists and does not
 *     name `image` (`dsh-api-session-controller/lib/types/commands.js:311-312`),
 *     `read_image` refuses the same way, and the other consumers project images
 *     away for such a model. The per-model `input` field is the only lawful
 *     per-model declaration, so this planner fills that too.
 *
 * SHAPE OF `reasoningEfforts`, settled from `dsh-llm-pi-ai/lib/index.js:967`:
 *
 *   z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))
 *
 * schemastery's `dict(inner, sKey)` takes the VALUE schema first
 * (`schemastery/src/index.ts`, `Schema.extend('dict', (data, { inner, sKey }))`),
 * so the dict is keyed by THINKING LEVEL and each value is the WIRE SPELLING
 * dispatch sends — `{ high: 'high', off: null }`. That direction is also what
 * resolution reads: `const wire = efforts[level]`
 * (`dsh-llm-pi-ai/lib/index.js:568`). `null` is lawful on `off` alone, where it
 * means "supported, send nothing"; every other level needs a non-empty string,
 * the whole field also accepts the literal `false` for a non-reasoning model,
 * and a dict must offer at least one level beyond `off` or resolution throws
 * (`dsh-llm-pi-ai/lib/index.js:566-574`). An ABSENT level means unsupported:
 * resolution pins every undeclared level to `null` in pi-ai's
 * `thinkingLevelMap` (line 578), and pi-ai drops null-mapped levels from the
 * picker (`pi-ai/dist/models.js:551-560`).
 *
 * SHAPE OF `input`, settled from `dsh-llm-pi-ai/lib/index.js:973`:
 *
 *   z.array(z.union(MODALITIES))   // MODALITIES = ['text', 'image'], :279-282
 *
 * TWO TRAPS, both guarded by {@link plannedModalities} rather than by its
 * caller. A list must never be EMPTY: `[]` is schema-legal but, through
 * `declaredInput`, means exactly what an absent field means, so an empty value
 * would silently undo the fill instead of declaring text-only — text-only is
 * written as `['text']`. A list must never name a modality OUTSIDE
 * `text`/`image`: the write is validated as a whole
 * (`dsh-settings/lib/index.js:462`), so one unknown member would reject the
 * round's single mutation, and a stored unknown member makes the owning route
 * fail to resolve at all — which the impure half already skips through
 * `withoutRoutes`.
 */

/**
 * Every pi-ai thinking level a profile may declare, in escalation order.
 * Mirrors `THINKING_LEVELS` in `dsh-llm-pi-ai/lib/index.js:296` and
 * `EXTENDED_THINKING_LEVELS` in `pi-ai/dist/models.js:550`.
 */
export const THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/**
 * The declared dict for a model whose levels are unknown: every level this
 * harness's vocabulary knows, each spelled as the wire value of the same name.
 *
 * WHY all seven: pi-ai's own catalog defaulting only supports `off`..`high`
 * unless `xhigh`/`max` are named explicitly, so a hand-declared gateway model
 * with no catalog twin would otherwise silently lose the two extended levels
 * even though the picker is what the model was missing in the first place.
 * Declaring them is an over-offer against an endpoint that may not serve them;
 * that cost is the ADR's accepted trade-off, and the per-model
 * `reasoningEfforts: false` opt-out is the escape hatch.
 */
export const DEFAULT_REASONING_EFFORTS = Object.freeze({
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/** Whether a value is a plain data object, the only container the settings layers hold. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A fresh, mutable copy of the standard level set. */
export function defaultReasoningEfforts() {
  return { ...DEFAULT_REASONING_EFFORTS }
}

/**
 * The declared dict that reproduces one offered level set.
 *
 * Every offered level is declared with its own name as the wire spelling, and
 * `off` — when the twin offers it — is declared as `null`, "supported, send
 * nothing". Because resolution pins undeclared levels to `null`, the resulting
 * `thinkingLevelMap` maps exactly the offered levels, which is what makes the
 * inherited picker's level list byte-identical to the twin's.
 *
 * The one approximation: a catalog twin may spell a level differently (OpenAI
 * and xAI map `off` to the wire value `'none'`). Identity spellings cannot see
 * those, and omitting the reasoning parameter — which is what `off: null`
 * produces — is the safe generic equivalent of "do not think".
 *
 * @param levels - offered thinking-level ids, in any order.
 * @returns a schema-legal `reasoningEfforts` dict, or `undefined` when the set
 *   cannot be expressed as one (nothing beyond `off`, or no level this
 *   vocabulary knows).
 */
export function effortsForLevels(levels) {
  const offered = THINKING_LEVELS.filter((level) => Array.isArray(levels) && levels.includes(level))
  if (!offered.some((level) => level !== 'off')) return undefined
  const efforts = {}
  for (const level of offered) efforts[level] = level === 'off' ? null : level
  return efforts
}

/** One twin's capability, normalized to a comparable shape. */
function twinOf(capability) {
  return {
    reasoning: capability.reasoning === true,
    levels: Array.isArray(capability.levels)
      ? capability.levels.filter((level) => typeof level === 'string')
      : [],
  }
}

/** Whether two twins describe the same capability. */
function sameCapability(a, b) {
  return a.reasoning === b.reasoning
    && a.levels.length === b.levels.length
    && a.levels.every((level) => b.levels.includes(level))
}

/**
 * What the installed catalog says about one model id.
 *
 * The catalog map is keyed by route, so the same id may be described by several
 * routes. Only a level set every describing route agrees on is a fact; a
 * disagreement means the id names different models in different places, and
 * guessing one of them would be inventing a capability.
 *
 * @param catalog - the capability map: `{ catalogRoutes, models: { route: { id: { reasoning, levels, modalities } } } }`.
 * @param modelId - the bare model id to look up.
 * @returns `{ status: 'none' | 'ambiguous' | 'agreed', reasoning, levels }`.
 */
export function twinCapability(catalog, modelId) {
  const byRoute = isPlainObject(catalog) ? catalog.models : undefined
  if (!isPlainObject(byRoute) || typeof modelId !== 'string' || modelId.length === 0) {
    return { status: 'none', reasoning: false, levels: [] }
  }
  const twins = []
  for (const byId of Object.values(byRoute)) {
    if (!isPlainObject(byId) || !isPlainObject(byId[modelId])) continue
    twins.push(twinOf(byId[modelId]))
  }
  if (twins.length === 0) return { status: 'none', reasoning: false, levels: [] }
  const [first, ...rest] = twins
  if (!rest.every((twin) => sameCapability(twin, first))) {
    return { status: 'ambiguous', reasoning: false, levels: [] }
  }
  return { status: 'agreed', reasoning: first.reasoning, levels: first.levels }
}

/**
 * The `reasoningEfforts` value one custom-route model should carry.
 *
 * A same-id catalog twin supplies the capability when it is unambiguous —
 * including a non-reasoning twin, which is inherited as `false` so a
 * non-reasoning builtin model does not silently gain levels under a custom
 * route. No twin, or twins that disagree, falls back to the standard set.
 *
 * @param catalog - the capability map.
 * @param modelId - the bare model id to look up.
 * @returns `{ value, source }` where `value` is `false` or a declared dict.
 */
export function plannedEfforts(catalog, modelId) {
  const twin = twinCapability(catalog, modelId)
  if (twin.status !== 'agreed') {
    return {
      value: defaultReasoningEfforts(),
      source: twin.status === 'ambiguous' ? 'default-ambiguous' : 'default',
    }
  }
  if (!twin.reasoning || twin.levels.length === 0) return { value: false, source: 'twin-non-reasoning' }
  const inherited = effortsForLevels(twin.levels)
  // A twin that offers nothing beyond `off` has no expressible dict — the
  // schema refuses one — and `false` is the honest legal equivalent: no
  // selectable level, which is exactly what that twin's picker would show.
  if (inherited === undefined) return { value: false, source: 'twin-unexpressible' }
  return { value: inherited, source: 'twin' }
}

/**
 * Every input modality a profile may declare. Mirrors `MODALITIES` in
 * `dsh-llm-pi-ai/lib/index.js:279-282`, which is what the settings schema's
 * `input` member is built from.
 */
export const MODALITIES = Object.freeze(['text', 'image'])

/**
 * The declared list for a model whose modalities are unknown: everything this
 * harness's modality vocabulary can express.
 *
 * WHY over-declare rather than reuse the adapter's own `DEFAULT_INPUT`
 * (`['text']`, `dsh-llm-pi-ai/lib/index.js:906`): that constant answers for a
 * route nobody can interrogate, and there it is deliberately the cautious
 * answer — under-claiming refuses the image up front, over-claiming admits one
 * the provider may reject mid-turn. The trade is different here. The route is
 * one the user just added by hand, its endpoint is unknown to the catalog by
 * definition, and nothing in the product writes this field, so a text-only
 * fallback would leave image input unreachable for every custom model with no
 * in-product way to say otherwise — while an explicit per-model `input` list is
 * a durable declaration the user can write to claim less (README, "Opting a
 * model out"). An endpoint that truly cannot take images rejects them at send
 * time; being unable to send them at all is the bug being fixed.
 */
export const DEFAULT_INPUT_MODALITIES = Object.freeze(['text', 'image'])

/** A fresh, mutable copy of the fallback modality list. */
export function defaultInputModalities() {
  return [...DEFAULT_INPUT_MODALITIES]
}

/**
 * Whether two values name the same set of modalities.
 *
 * WHY set equality rather than `deepEqual`: ordering carries no information in
 * this field — `['image', 'text']` and `['text', 'image']` declare exactly the
 * same thing — so an equivalent list already holds the computed value and must
 * never be rewritten merely to be reordered. Anything that is not an array (an
 * absent field, `[]`, a stored non-list) names no set at all and compares
 * unequal to any non-empty list, which is what lets the same predicate serve
 * both the twin-agreement test and the planner's "does this field already say
 * what the plan computes" test.
 */
function sameModalitySet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((modality) => right.has(modality))
}

/**
 * One twin's declared modalities, normalized to a comparable shape.
 *
 * `undefined` is the answer both for a route that states nothing and for a list
 * whose members this vocabulary does not know: neither may be copied into the
 * settings document, because the write is validated as a whole and a member
 * outside `text`/`image` would reject it. An unknown list is therefore treated
 * as silence rather than as an empty declaration.
 */
function modalitiesOf(capability) {
  const declared = Array.isArray(capability.modalities) ? capability.modalities : []
  const known = [...new Set(declared.filter((modality) => MODALITIES.includes(modality)))]
  return known.length === 0 ? undefined : known
}

/**
 * What the installed catalog says about one model id's input modalities.
 *
 * The modality half of {@link twinCapability}, kept separate on purpose: the
 * two facts are independent — a twin can be non-reasoning yet vision-capable —
 * so agreement on one must never decide the other, and a pair of twins that
 * disagree only about modalities must not push the reasoning field onto the
 * standard set. The agreement rule itself is the same: the catalog map is keyed
 * by route, so an id's modality set is a fact only when every route describing
 * that id states the same one, and a route that states nothing at all leaves
 * the id undecided rather than decided.
 *
 * @param catalog - the capability map: `{ catalogRoutes, models: { route: { id: { reasoning, levels, modalities } } } }`.
 * @param modelId - the bare model id to look up.
 * @returns `{ status: 'none' | 'unknown' | 'ambiguous' | 'agreed', modalities }`,
 *   where `modalities` is `undefined` unless the status is `agreed`.
 */
export function twinModalities(catalog, modelId) {
  const byRoute = isPlainObject(catalog) ? catalog.models : undefined
  if (!isPlainObject(byRoute) || typeof modelId !== 'string' || modelId.length === 0) {
    return { status: 'none', modalities: undefined }
  }
  const twins = []
  for (const byId of Object.values(byRoute)) {
    if (!isPlainObject(byId) || !isPlainObject(byId[modelId])) continue
    twins.push(modalitiesOf(byId[modelId]))
  }
  if (twins.length === 0) return { status: 'none', modalities: undefined }
  // One silent route is enough to make the id undecided: only part of what the
  // catalog knows about it can be copied, and which part is not a fact.
  if (twins.some((twin) => twin === undefined)) return { status: 'unknown', modalities: undefined }
  const [first, ...rest] = twins
  if (!rest.every((twin) => sameModalitySet(twin, first))) return { status: 'ambiguous', modalities: undefined }
  return { status: 'agreed', modalities: first }
}

/**
 * The `input` value one custom-route model should carry.
 *
 * A twin supplies the list when the catalog agrees on it, and a text-only
 * `['text']` twin is inherited like any other — that is capability truth, and
 * copying it is what keeps a text-only builtin model text-only under a custom
 * route. No twin, disagreeing twins and twins that state nothing fall back to
 * {@link DEFAULT_INPUT_MODALITIES}.
 *
 * @param catalog - the capability map.
 * @param modelId - the bare model id to look up.
 * @returns `{ value, source }` where `value` is a fresh, never-empty list whose
 *   members are all in {@link MODALITIES}.
 */
export function plannedModalities(catalog, modelId) {
  const twin = twinModalities(catalog, modelId)
  if (twin.status !== 'agreed') {
    return {
      value: defaultInputModalities(),
      source: twin.status === 'ambiguous' ? 'default-ambiguous' : 'default',
    }
  }
  // A fresh copy per model: this array becomes part of a settings document, and
  // one instance shared by two entries of the same op value would be one object
  // in every consumer of that value.
  return { value: [...twin.modalities], source: 'twin' }
}

/** The catalog's route ids, as a lookup, from either a Set or a list. */
function catalogRouteSet(catalog) {
  const routes = isPlainObject(catalog) ? catalog.catalogRoutes : undefined
  if (routes instanceof Set) return routes
  return new Set(Array.isArray(routes) ? routes.filter((route) => typeof route === 'string') : [])
}

/**
 * The provider routes this plugin owns, as `[route, profile]` pairs.
 *
 * A route is CUSTOM when its key is not an id the installed catalog ships: the
 * catalog is keyed by route, so only such a route lacks an inheritance source.
 * A profile whose `models` is not a list has nothing addressable here — custom
 * routes cannot use `modelOverrides` at all, because pi-ai refuses overrides
 * for a route the installed catalog does not describe
 * (`dsh-llm-pi-ai/lib/index.js:641-645`) — so it is skipped rather than guessed
 * at.
 */
function customProfiles(snapshot, catalogRoutes) {
  const providers = isPlainObject(snapshot) ? snapshot.providers : undefined
  if (!isPlainObject(providers)) return []
  return Object.entries(providers).filter(([route, profile]) => {
    return !catalogRoutes.has(route) && isPlainObject(profile) && Array.isArray(profile.models)
  })
}

/** The non-empty model ids one profile lists. */
function modelIds(profile) {
  return profile.models
    .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => entry.id)
}

/**
 * Every model id this normalizer may need a capability fact for.
 *
 * The catalog map is built from this set, which keeps the interactive query
 * cost proportional to the custom routes the user owns rather than to the size
 * of the installed catalog.
 *
 * @param snapshot - the persisted `llm-pi-ai` provider layer.
 * @param catalogRoutes - the catalog's route ids (Set or list).
 * @returns the bare model ids of every custom-route model.
 */
export function customModelIds(snapshot, catalogRoutes) {
  const routes = catalogRouteSet({ catalogRoutes })
  const ids = new Set()
  for (const [, profile] of customProfiles(snapshot, routes)) {
    for (const id of modelIds(profile)) ids.add(id)
  }
  return ids
}

/**
 * The persisted `llm-pi-ai` layer without the routes that cannot be written.
 *
 * WHY this is decided before planning rather than inside it: whether a route is
 * writable is a fact about the live `llm` service, not about the settings layer,
 * so the impure half names the routes to drop and this module only shapes the
 * snapshot the rules run over. Dropping a route keeps it out of the plan and out
 * of its summary counts and does nothing else: the plan is still applied to the
 * real layer, so every op path, every op value and the revision guard stay
 * exactly what they are for the routes that remain.
 *
 * A shape this cannot read comes back untouched rather than rejected: a layer
 * with no route to drop has nothing to plan, and no caller is served by a throw
 * that only restates its own input.
 *
 * @param snapshot - the persisted `llm-pi-ai` provider layer.
 * @param skipped - the route ids to leave out, as a `Set` of route keys.
 * @returns the layer to plan over, or the input itself when nothing is dropped.
 */
export function withoutRoutes(snapshot, skipped) {
  if (!(skipped instanceof Set) || skipped.size === 0) return snapshot
  const providers = isPlainObject(snapshot) ? snapshot.providers : undefined
  if (!isPlainObject(providers)) return snapshot
  const kept = {}
  for (const [route, profile] of Object.entries(providers)) {
    if (!skipped.has(route)) kept[route] = profile
  }
  return { ...snapshot, providers: kept }
}

/** Structural equality over the JSON-ish values a settings layer holds. */
function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
}

/**
 * Plan one normalization pass over the persisted `llm-pi-ai` layer.
 *
 * The rules, in the order they win:
 *
 *   1. A route the installed catalog ships is never touched (case g).
 *   2. `reasoningEfforts` — a model carrying an explicit `false` is an opt-out
 *      and is never overwritten (case e): that declaration is a decision, not a
 *      gap. Otherwise the value is recomputed: an unambiguous same-id catalog
 *      twin supplies it (cases a, b), and no twin or disagreeing twins fall back
 *      to the standard set (cases c, d).
 *   3. `input` — an explicit non-empty list is a judgement in the same sense and
 *      is preserved as it stands, ordering included. Otherwise the value is
 *      recomputed: an unambiguous same-id twin supplies its own list, a
 *      text-only `['text']` twin included (case i), and no twin, disagreeing
 *      twins or twins that state nothing fall back to
 *      `DEFAULT_INPUT_MODALITIES` (case j).
 *
 *      WHY a declared list is preserved while a declared `reasoningEfforts` dict
 *      is not: each field can only be read through its own shape. A reasoning
 *      dict this planner wrote and a reasoning dict the user wrote are the same
 *      value, so only the explicit `false` — something this planner never writes
 *      — is recognizable as a judgement. `input` has no such sentinel and no
 *      spelling this planner could recognize as its own, so the field's own
 *      presence is the only signal there is, and reading a present list as a
 *      judgement is the interpretation that cannot silently lose a decision.
 *   4. A model whose recomputed value already equals what it holds produces no
 *      op (case f) — for `input`, equality means equality of modality SETS, so a
 *      reordered list is never a reason to write. This is also the loop breaker:
 *      one op carries BOTH fields, the write it produces triggers the very
 *      settings event that re-runs this planner, and the second pass must be a
 *      no-op for both — the list this pass wrote is a non-empty declaration the
 *      next pass preserves, and the dict it wrote is the value the next pass
 *      computes again.
 *
 * WHY the op sets the whole `models` array rather than one index inside it:
 * `SettingsProvider.write()` applies ops with
 * `snapshot.ops.reduce(applyPathOp, current)` (`dsh-settings/lib/index.js:461`),
 * and `applyPathOp` descends only through children its `isPlainObject` accepts
 * (`dsh-settings/lib/index.js:112-148`) — a predicate that is explicitly false
 * for arrays. A path of `['providers', route, 'models', '0', 'reasoningEfforts']`
 * is therefore not a narrow write at all: the array is REPLACED by an object
 * keyed `"0"`, which the `models: z.array(...)` schema then rejects, so the whole
 * write fails. Setting `['providers', route, 'models']` is the deepest op the
 * shipped applier supports, and it stays minimal where it matters: the value is
 * the CURRENT array rebuilt with nothing changed but the capability fields on
 * the affected entries (case h) — no other model field, and no other route
 * field, is restated or dropped.
 *
 * COUNTERS. `planned` counts the models whose `reasoningEfforts` this plan
 * writes, and `inherited` / `defaulted` / `nonReasoning` split those by where
 * the value came from. The modality counters are field-scoped instead, and every
 * entry carrying a usable id lands in exactly one of them: `inputDeclared` (a
 * list the entry already carries and this plan leaves alone),
 * `modalityInherited` (a list copied from an agreeing twin) and
 * `modalityDefaulted` (the fallback). That makes
 * `inputDeclared + modalityInherited + modalityDefaulted === models` an
 * invariant rather than a coincidence, and it is what lets the entry module
 * report how many input lists a write actually filled.
 *
 * @param snapshot - the persisted `llm-pi-ai` provider layer, the same layer
 *   the returned ops are applied to (host side: `describe().user`).
 * @param catalog - the capability map built from the `llm` service.
 * @returns `{ ops, summary }` — ops are path ops for `settings.mutate`, empty
 *   when nothing needs writing.
 */
export function planNormalization(snapshot, catalog) {
  const ops = []
  const summary = {
    routes: [],
    models: 0,
    planned: 0,
    optedOut: 0,
    unchanged: 0,
    inherited: 0,
    defaulted: 0,
    nonReasoning: 0,
    inputDeclared: 0,
    modalityInherited: 0,
    modalityDefaulted: 0,
  }
  const catalogRoutes = catalogRouteSet(catalog)
  for (const [route, profile] of customProfiles(snapshot, catalogRoutes)) {
    summary.routes.push(route)
    let changed = false
    const models = profile.models.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) return entry
      summary.models += 1
      let next = entry

      const current = Object.hasOwn(entry, 'reasoningEfforts') ? entry.reasoningEfforts : undefined
      if (current === false) {
        summary.optedOut += 1
      } else {
        const { value, source } = plannedEfforts(catalog, entry.id)
        if (current !== undefined && deepEqual(current, value)) {
          summary.unchanged += 1
        } else {
          if (value === false) summary.nonReasoning += 1
          else if (source === 'twin') summary.inherited += 1
          else summary.defaulted += 1
          summary.planned += 1
          changed = true
          next = { ...next, reasoningEfforts: value }
        }
      }

      // A non-empty list is this model's declaration and is never overwritten:
      // unlike `reasoningEfforts`, nothing in the field distinguishes a value
      // this planner wrote from one the user wrote. `[]` is NOT a declaration —
      // the adapter reads it exactly like an absent field (`declaredInput`,
      // `dsh-llm-pi-ai/lib/index.js:292-294`) — so it is filled like any gap.
      if (Array.isArray(entry.input) && entry.input.length > 0) {
        summary.inputDeclared += 1
      } else {
        const { value, source } = plannedModalities(catalog, entry.id)
        // Set equality, not array equality: `['image', 'text']` is the value
        // `['text', 'image']` names, so a list that already says this is never
        // rewritten just to be reordered. A stored value that reaches this
        // comparison is not a declaration (absent, `[]`, or not a list at all)
        // and so never names a non-empty set; keeping the comparison here rather
        // than testing lengths makes "already correct" one rule for the field.
        if (!sameModalitySet(entry.input, value)) {
          if (source === 'twin') summary.modalityInherited += 1
          else summary.modalityDefaulted += 1
          changed = true
          next = { ...next, input: value }
        }
      }

      return next
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: models })
  }
  return { ops, summary }
}
