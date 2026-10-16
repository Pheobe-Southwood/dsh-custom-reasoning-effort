/**
 * Pure planning for the reasoning-effort normalizer.
 *
 * WHY this module is separate: "what should this model's `reasoningEfforts` be"
 * is derived state computed from exactly two inputs — the persisted `llm-pi-ai`
 * provider layer and a level set per model id. Keeping the rules free of `ctx`,
 * of services and of I/O makes them directly testable against plain objects
 * (`test/normalizer.test.mjs`) and keeps the plugin entry (`lib/index.js`)
 * concerned only with reading services, fetching models.dev and writing settings.
 *
 * WHAT IS FILLED, AND WHY — `reasoningEfforts`. `resolveModelReasoning(provider,
 * entry, base)` in `dsh-llm-pi-ai/lib/index.js` returns
 * `{ reasoning: base?.reasoning ?? false }` when the entry declares no
 * `reasoningEfforts`, and `base` is the installed catalog entry **of that same
 * model id on that same route**. A custom route has no such entry, so the model
 * resolves to `reasoning: false`, the model catalog entry carries no reasoning,
 * and the composer's official 推理等级 picker stays hidden. The per-model
 * `reasoningEfforts` field is the only other lawful source of that capability,
 * which is what this planner fills.
 *
 * WHERE THE LEVELS COME FROM — models.dev, live (`lib/modelsdev.js`), never from
 * the installed catalog. The installed catalog is the frozen output of some
 * earlier models.dev snapshot; reading it is what made a newly released model
 * (`gemini-4-argon`) resolve to nothing at all. The caller therefore hands this
 * planner a `levels` map built from the live document, and an id that map does
 * not describe falls back to {@link DEFAULT_REASONING_EFFORTS}: the standard set
 * is the honest answer for "unknown", it keeps the picker available, and it is
 * *not* an assertion about the model. Nothing here ever writes
 * `reasoningEfforts: false`: a model this plugin cannot describe must not lose a
 * picker it may well deserve, and the user's own `false` opt-out is the one
 * explicit "this model does not reason" declaration that is preserved verbatim.
 *
 * WHAT IS NOT TOUCHED, AND WHY — `input`. DSH v0.2.0's Models settings page
 * renders a per-model 输入类型 field (文本 / 图片) for custom pi-ai routes and
 * writes the adapter's own `input` list
 * (`dsh-client-ui-settings-models/lib/client.js`, `inputField: "input"`), so the
 * field has an owner and a UI. This planner neither reads nor writes it. The
 * 0.2.x releases of this plugin wrote that field and a later release reclaimed
 * its leftovers under a migration marker; both are gone — the reclaim, the
 * marker it needed, and this plugin's own settings namespace with them — so an
 * uninstall leaves nothing of this plugin behind beyond the level declarations
 * it was asked to write (and `scripts/cleanup.mjs` removes those).
 *
 * SHAPE OF `reasoningEfforts`, settled from `dsh-llm-pi-ai/lib/index.js:1001`:
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
 * that cost is the accepted trade-off of the fallback, and the per-model
 * `reasoningEfforts: false` opt-out is the escape hatch. Every level but `off`
 * carries its own name as the wire spelling, and `off` carries `null`: "send no
 * reasoning parameter at all".
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
 * `off` — when the set offers it — is declared as `null`, "supported, send
 * nothing". Because resolution pins undeclared levels to `null`, the resulting
 * `thinkingLevelMap` maps exactly the offered levels, which is what makes the
 * picker's level list exactly the level set the source declared.
 *
 * @param levels - offered level ids, in any order.
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

/**
 * Whether a stored `reasoningEfforts` value is one THIS plugin writes.
 *
 * The predicate is the plugin's own handwriting, not a guess about it: every
 * value this plugin declares spells each level as its own name and `off` as
 * `null` ({@link effortsForLevels}). It exists for `scripts/cleanup.mjs`, the
 * one-shot removal that runs when the user uninstalls the plugin: only values
 * this plugin could have written are deleted, so a hand-written level set — with
 * any spelling of its own, or the explicit `false` opt-out — is never touched.
 *
 * @param value - a stored `reasoningEfforts` value.
 * @returns whether it is one of this plugin's declarations.
 */
export function isWrittenEfforts(value) {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (!keys.every((key) => THINKING_LEVELS.includes(key))) return false
  if (!keys.some((key) => key !== 'off')) return false
  return keys.every((key) => (key === 'off' ? value[key] === null : value[key] === key))
}

/**
 * The `reasoningEfforts` value one custom-route model should carry.
 *
 * A level set the live models.dev document declares is used as declared; an id
 * the document does not describe — or describes only with `off` — falls back to
 * the standard set. Both outcomes are schema-legal and both leave the picker
 * available; neither is ever `false`.
 *
 * @param catalog - the capability map: `{ levels: Map<string, readonly string[]> }`.
 * @param modelId - the bare model id to look up.
 * @returns `{ value, source }` where `source` is `'models.dev'` or `'standard'`.
 */
export function plannedEfforts(catalog, modelId) {
  const levels = isPlainObject(catalog) ? catalog.levels : undefined
  const declared = levels instanceof Map && typeof modelId === 'string' ? levels.get(modelId) : undefined
  if (Array.isArray(declared)) {
    const value = effortsForLevels(declared)
    if (value !== undefined) return { value, source: 'models.dev' }
  }
  return { value: defaultReasoningEfforts(), source: 'standard' }
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
 * The plugin fetches nothing when this is empty, which keeps a profile with no
 * custom routes from ever touching the network.
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
 *   2. A model carrying an explicit `reasoningEfforts: false` is an opt-out and
 *      is never overwritten (case e): that declaration is a decision, not a gap.
 *      Otherwise the value is recomputed — a level set the live models.dev
 *      document declares, or the standard set when it declares none (cases a-d).
 *   3. A model whose recomputed value already equals what it holds produces no
 *      op (case f). This is also the loop breaker: the write this pass produces
 *      triggers the very settings event that re-runs this planner, and the
 *      second pass must be a no-op.
 *
 * Everything else on the entry — `name`, `contextWindow`, `maxTokens`, `input`,
 * `compat` and whatever a future release adds — is carried through untouched,
 * key order included. `input` in particular is owned by the shipped Models
 * settings page (`dsh-client-ui-settings-models`), which writes the adapter's
 * own per-model declaration; this planner must never restate it, drop it, or
 * reorder it.
 *
 * WHY the op sets the whole `models` array rather than one index inside it:
 * `SettingsProvider.write()` applies ops with
 * `snapshot.ops.reduce(applyPathOp, current)` (`dsh-settings/lib/index.js:505`),
 * and `applyPathOp` descends only through children its `isPlainObject` accepts
 * (`dsh-settings/lib/index.js:112-148`) — a predicate that is explicitly false
 * for arrays. A path of `['providers', route, 'models', '0', 'reasoningEfforts']`
 * is therefore not a narrow write at all: the array is REPLACED by an object
 * keyed `"0"`, which the `models: z.array(...)` schema then rejects, so the whole
 * write fails. Setting `['providers', route, 'models']` is the deepest op the
 * shipped applier supports, and it stays minimal where it matters: the value is
 * the CURRENT array rebuilt with nothing changed but `reasoningEfforts` on the
 * affected entries (case h) — no other model field, and no other route field, is
 * restated or dropped.
 *
 * COUNTERS. `planned` counts the models whose `reasoningEfforts` this plan
 * writes, and `sourced` / `defaulted` split those by where the value came from.
 * Every entry carrying a usable id lands in exactly one of `planned`, `optedOut`
 * or `unchanged`, so the three counts sum to `models` and the entry module can
 * report what a write actually filled.
 *
 * @param snapshot - the persisted `llm-pi-ai` provider layer, the same layer
 *   the returned ops are applied to (host side: `describe().user`).
 * @param catalog - the capability map: `{ catalogRoutes, levels }`.
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
    sourced: 0,
    defaulted: 0,
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
      if (source === 'models.dev') summary.sourced += 1
      else summary.defaulted += 1
      summary.planned += 1
      changed = true
      return { ...entry, reasoningEfforts: value }
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: models })
  }
  return { ops, summary }
}
