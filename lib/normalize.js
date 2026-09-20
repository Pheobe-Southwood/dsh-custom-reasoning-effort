/**
 * Pure planning for the `llm-pi-ai` settings normalizer.
 *
 * WHY this module is separate: "what should this model's `reasoningEfforts`
 * be" is derived state computed from exactly two inputs — the persisted
 * `llm-pi-ai` provider layer and the installed catalog's capability facts.
 * Keeping the rules free of `ctx`, of services and of I/O makes them directly
 * testable against plain objects (`test/normalizer.test.mjs`) and keeps the
 * plugin entry (`lib/index.js`) concerned only with reading services, building
 * the capability map and writing settings.
 *
 * WHY the field exists at all (the route-keyed inheritance root cause): the
 * adapter resolves a model's reasoning capability per provider ROUTE.
 * `resolveModelReasoning(provider, entry, base)` in `dsh-llm-pi-ai/lib/index.js`
 * returns `{ reasoning: base?.reasoning ?? false }` when the entry declares no
 * `reasoningEfforts`, and `base` is the installed catalog entry **of that same
 * model id on that same route**. The installed catalog is keyed by route, so a
 * custom route key — one that appears nowhere in the catalog — has nothing to
 * inherit from: it resolves to `reasoning: false`, the model catalog entry
 * carries no `reasoning`, and the composer's official 推理等级 picker stays
 * hidden. The per-model `reasoningEfforts` field is the only other lawful
 * source of that capability, which is what this planner fills in.
 *
 * SHAPE OF THE FIELD, settled from `dsh-llm-pi-ai/lib/index.js:967`:
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
 * @param catalog - the capability map: `{ catalogRoutes, models: { route: { id: { reasoning, levels } } } }`.
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
 *   2. A model carrying an explicit `false` is an opt-out and is never
 *      overwritten (case e) — the declaration is a decision, not a gap.
 *   3. Otherwise the value is recomputed: an unambiguous same-id catalog twin
 *      supplies it (cases a, b), and no twin or disagreeing twins fall back to
 *      the standard set (cases c, d).
 *   4. A model whose recomputed value already equals what it holds produces no
 *      op (case f). This is also the loop breaker: the write this planner
 *      produces triggers the very settings event that re-runs it, and the
 *      second pass must be a no-op.
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
 * the CURRENT array rebuilt with nothing changed but `reasoningEfforts` on the
 * affected entries — no other model field, and no other route field, is
 * restated or dropped (case h).
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
  }
  const catalogRoutes = catalogRouteSet(catalog)
  for (const [route, profile] of customProfiles(snapshot, catalogRoutes)) {
    summary.routes.push(route)
    let changed = false
    const models = profile.models.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) return entry
      summary.models += 1
      const current = Object.hasOwn(entry, 'reasoningEfforts') ? entry.reasoningEfforts : undefined
      if (current === false) {
        summary.optedOut += 1
        return entry
      }
      const { value, source } = plannedEfforts(catalog, entry.id)
      if (current !== undefined && deepEqual(current, value)) {
        summary.unchanged += 1
        return entry
      }
      if (value === false) summary.nonReasoning += 1
      else if (source === 'twin') summary.inherited += 1
      else summary.defaulted += 1
      summary.planned += 1
      changed = true
      return { ...entry, reasoningEfforts: value }
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: models })
  }
  return { ops, summary }
}
