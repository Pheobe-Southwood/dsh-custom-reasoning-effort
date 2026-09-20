/**
 * dsh-custom-reasoning-effort — host half.
 *
 * A model added through Settings → Models → 添加自定义提供方 reaches the model
 * catalog with no capabilities of its own. The catalog resolves them per
 * provider route and the custom-provider card writes neither per-model field
 * the `llm-pi-ai` schema accepts, so a custom route — which the installed
 * catalog does not describe and which therefore has nothing to inherit from —
 * loses two capabilities at once:
 *
 *   - `reasoning`, so the composer's official 推理等级 picker stays hidden even
 *     when the very same model id is reasoning-capable under a builtin route;
 *   - `input`, so the model resolves to the text-only default and the host-side
 *     modality consumers — the prompt admission gate
 *     (`dsh-api-session-controller/lib/types/commands.js:311-312`,
 *     `MODEL_DOES_NOT_SUPPORT_IMAGES`), `read_image`, and the rest — refuse or
 *     project away images the endpoint would have accepted.
 *
 * This plugin fills both fields in: it normalizes the persisted `llm-pi-ai`
 * settings so every model of a custom-provider route carries a schema-legal
 * `reasoningEfforts` and a non-empty `input`, and the shipped pipeline
 * (settings → catalog build → picker / modality gate → the request on the wire)
 * does the rest with no custom UI.
 *
 * The planning rules live in `./normalize.js`, which is pure so the cases can
 * be tested without a Cordis runtime; this file is the impure half — read the
 * two services, build the catalog capability map, write one settings mutation,
 * and never let a failure escape.
 *
 * WHY the settings layer is the right lever: `PiAiAdapter` rebuilds its model
 * collection from the current profiles on every operation, and
 * `resolveModelReasoning()` turns a declared dict into pi-ai's
 * `thinkingLevelMap` — which is what the catalog's `reasoning` object, and
 * therefore the official picker, is derived from — while the entry's own
 * `input` list is what the catalog's `inputModalities` is copied from. Writing
 * those fields changes the input of the shipped pipeline instead of competing
 * with it.
 *
 * @module dsh-custom-reasoning-effort
 */
import { MODALITIES, customModelIds, planNormalization, withoutRoutes } from './normalize.js'

export const name = 'custom-reasoning-effort'

/** Hard dependencies: the model catalog seam and the settings registry. */
export const inject = ['llm', 'settings']

/** The settings namespace the pi-ai adapter owns; profile layer is `providers`. */
const NS = 'llm-pi-ai'

/**
 * Debounce for both change signals.
 *
 * One settings write announces itself twice — as `settings/document-updated`
 * for the namespace and again as `llm/adapters-updated` once the adapter has
 * re-registered its routes, and a provider card write may land model by model —
 * so a pass per event would read the same state several times and race its own
 * writes. 250ms collapses each burst into one pass while staying imperceptible
 * next to a settings round trip.
 */
const DEBOUNCE_MS = 250

/**
 * Apply the settings normalizer.
 *
 * Every side effect — both listeners and the debounce timer — is registered on
 * this plugin's fiber, so a stop, an update or an undefine removes them
 * together. No error ever escapes: a round that cannot read a service, build
 * the capability map or commit a mutation is logged and skipped, and the next
 * change signal starts a fresh round.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  let pending
  let disposed = false

  ctx.effect(() => () => {
    disposed = true
  }, 'custom-reasoning-effort:lifecycle')

  const cancel = () => {
    const dispose = pending
    pending = undefined
    if (dispose !== undefined) dispose()
  }

  /**
   * Arm the debounced round. The timer is registered as an effect of this
   * fiber rather than taken from the timer service: disposal then clears it
   * with everything else, whereas a timer owned by another fiber's scope would
   * outlive this plugin and fire into a disposed context.
   */
  const schedule = () => {
    cancel()
    if (disposed) return
    try {
      pending = ctx.effect(() => {
        const handle = setTimeout(() => {
          pending = undefined
          void runRound(ctx)
        }, DEBOUNCE_MS)
        return () => clearTimeout(handle)
      }, 'custom-reasoning-effort:debounce')
    } catch (error) {
      // An effect cannot be created on an inactive fiber, which only happens
      // while this plugin is being torn down; there is nothing left to do.
      disposed = true
      ctx.logger.warn(`custom-reasoning-effort: stopping after a refused timer (${messageOf(error)})`)
    }
  }

  // The signal that matters: the namespace was written, in-process or from the
  // stored document, and its revision moved. Emitted by the host settings
  // service (`dsh-settings/lib/index.js:526-531`).
  ctx.on('settings/document-updated', (ns) => {
    if (ns === NS) schedule()
  })

  // The adapter re-registered its routes, so a route that was dormant during
  // the previous pass may now be resolvable — or the reverse. Emitted by the
  // host llm service (`dsh-llm/lib/index.js:1753`).
  ctx.on('llm/adapters-updated', () => schedule())

  // The first pass covers the state a previous run left behind. It is
  // debounced rather than immediate so that plugin rows which apply after this
  // one (the pi-ai adapter installs its settings section in its own apply)
  // have landed before the section is read.
  schedule()
}

/**
 * One normalization round: read the persisted layer, build the capability map,
 * plan, and commit at most one mutation.
 *
 * @param ctx - the plugin context.
 */
async function runRound(ctx) {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const descriptor = describeNamespace(ctx)
      if (descriptor === undefined) return
      const catalogRoutes = catalogRouteIds(ctx)
      const catalog = {
        catalogRoutes: [...catalogRoutes],
        models: await catalogCapabilityMap(ctx, catalogRoutes, customModelIds(descriptor.user, catalogRoutes)),
      }
      // A route the llm service cannot resolve is not writable at all, and one
      // op carries a route's whole `models` array, so planning over it would
      // cost every other route the round (see `unresolvableRoutes`).
      const unresolvable = unresolvableRoutes(ctx)
      // Reported BEFORE the no-op return below, because an unresolvable route
      // is precisely the state that produces a pass with nothing to write: its
      // models can never be filled while it stays unresolvable, so a pass that
      // stayed silent about it would leave the one route the user has to repair
      // by hand permanently invisible — the round that would have filled it is
      // the very round whose op list is empty.
      if (unresolvable.size > 0) {
        ctx.logger.warn(`custom-reasoning-effort: left ${unresolvable.size} unresolvable custom route(s) alone (${[...unresolvable].join(', ')}); the llm service reports what each one needs`)
      }
      const plan = planNormalization(withoutRoutes(descriptor.user, unresolvable), catalog)
      // The loop breaker: a pass whose computed values are already in place
      // writes nothing, so the event this plugin's own write produces settles
      // here instead of running forever.
      if (plan.ops.length === 0) return
      try {
        await ctx.settings.mutate(NS, plan.ops, descriptor.revision)
        const { planned, inputDeclared, modalityInherited, modalityDefaulted } = plan.summary
        ctx.logger.info(
          `custom-reasoning-effort: filled reasoningEfforts on ${planned} model(s)`
          + ` and input modalities on ${modalityInherited + modalityDefaulted} model(s)`
          + ` across ${plan.ops.length} custom route(s)`
          + ` (modalities: ${modalityInherited} inherited, ${modalityDefaulted} defaulted, ${inputDeclared} already declared)`,
        )
        return
      } catch (error) {
        // One retry: another writer moved the namespace between read and
        // write. The loop re-reads and re-plans, so the retry commits values
        // derived from the state it actually saw.
        if (attempt === 0 && isRevisionConflict(error)) continue
        throw error
      }
    }
  } catch (error) {
    ctx.logger.warn(`custom-reasoning-effort: skipped one normalization pass (${messageOf(error)})`)
  }
}

/**
 * The `llm-pi-ai` descriptor: the raw provider layer the ops apply to, plus
 * the revision a write must still find.
 *
 * WHY `user` and not `value`: `describe().user` is the stored layer itself —
 * exactly what `SettingsProvider.write()` reduces the ops over — while `value`
 * is the schema-resolved view with profile-level defaults materialized into
 * it. Rebuilding a `models` array from `value` would copy those defaults back
 * into the user's document as a side effect of filling one field.
 *
 * @param ctx - the plugin context.
 * @returns the descriptor, or `undefined` when the namespace is not registered
 *   yet or carries nothing this plugin may write.
 */
function describeNamespace(ctx) {
  const descriptors = ctx.settings.describe()
  if (!Array.isArray(descriptors)) return undefined
  const descriptor = descriptors.find((entry) => {
    return entry !== null && typeof entry === 'object' && entry.ns === NS && typeof entry.revision === 'number'
  })
  if (descriptor === undefined) return undefined
  return typeof descriptor.user === 'object' && descriptor.user !== null ? descriptor : undefined
}

/**
 * The route ids the installed catalog ships.
 *
 * `declared: false` is the llm service's own statement that the route comes
 * from the installed catalog rather than from configuration
 * (`dsh-llm-pi-ai/lib/index.js:2563`), which is precisely the predicate that
 * decides whether a route has something to inherit from.
 *
 * @param ctx - the plugin context.
 * @returns the catalog route ids.
 */
function catalogRouteIds(ctx) {
  const routes = new Set()
  const entries = ctx.llm.listConfigurableProviders()
  if (!Array.isArray(entries)) return routes
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && entry.declared === false && typeof entry.provider === 'string') {
      routes.add(entry.provider)
    }
  }
  return routes
}

/**
 * The routes the llm service itself reports as unresolvable.
 *
 * A directory entry carries an `error` when the owning adapter cannot resolve
 * that route's profile (`dsh-llm/lib/types/types.d.ts`,
 * `LlmConfigurableProvider.error`), which is exactly the state in which the
 * settings seam will refuse a write to it: `SettingsProvider.write()` resolves
 * the changed profile under the registrant's own strict validation
 * (`dsh-settings/lib/index.js:462`), and the pi-ai section refuses a profile
 * whose models do not resolve. Because one op restates a route's whole `models`
 * array, including such a route would have the seam reject the round's single
 * mutation as a whole — costing every other route its pass, with no event left
 * to retry from. Leaving it out of the plan instead lets the remaining routes
 * commit, and recomputing the set every round means repairing the route lets
 * the next pass pick it up.
 *
 * @param ctx - the plugin context.
 * @returns the unresolvable route ids.
 */
function unresolvableRoutes(ctx) {
  const routes = new Set()
  const entries = ctx.llm.listConfigurableProviders()
  if (!Array.isArray(entries)) return routes
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && typeof entry.provider === 'string' && typeof entry.error === 'string') {
      routes.add(entry.provider)
    }
  }
  return routes
}

/**
 * The capability facts of every catalog route, for the ids in play.
 *
 * Only routes with a registered adapter can be interrogated, and only the
 * candidate ids are resolved, so the cost stays proportional to the custom
 * routes a user owns rather than to the installed catalog's size. A route that
 * throws — dormant, or holding a profile the catalog cannot resolve — simply
 * contributes no facts, and the planner falls back to the standard level set
 * and the default modality list rather than guessing either.
 *
 * @param ctx - the plugin context.
 * @param catalogRoutes - ids the installed catalog ships.
 * @param ids - model ids to resolve.
 * @returns the `models` half of the planner's capability map.
 */
async function catalogCapabilityMap(ctx, catalogRoutes, ids) {
  const models = {}
  if (ids.size === 0) return models
  const providers = ctx.llm.listProviders()
  if (!Array.isArray(providers)) return models
  for (const provider of providers) {
    const route = provider !== null && typeof provider === 'object' ? provider.id : undefined
    if (typeof route !== 'string' || !catalogRoutes.has(route)) continue
    const listed = await listedModels(ctx, route)
    const wanted = listed.filter((model) => ids.has(model.id))
    if (wanted.length === 0) continue
    const byId = {}
    for (const model of wanted) {
      const capability = await capabilityOf(ctx, route, model.id)
      if (capability !== undefined) byId[model.id] = capability
    }
    if (Object.keys(byId).length > 0) models[route] = byId
  }
  return models
}

/** The ids one route serves, or an empty list when the route cannot answer. */
async function listedModels(ctx, route) {
  try {
    const models = await ctx.llm.listModels(route)
    if (!Array.isArray(models)) return []
    return models.filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0)
  } catch {
    return []
  }
}

/**
 * One catalog model's capability, in the planner's shape.
 *
 * The two facts are captured INDEPENDENTLY, because they are independent in
 * fact: a twin can be non-reasoning yet vision-capable, a captioning model can
 * be both, an embedding model neither — and the planner's modality agreement is
 * computed separately from its reasoning agreement, so gathering them together
 * cannot make one decide the other.
 *
 * The offered levels are the picker's own effort ids: the adapter reports
 * `reasoning.efforts[].id` as the raw level name, and a model with no
 * `reasoning` at all is a fact too — "this id does not reason here" — which is
 * why it resolves to `{ reasoning: false }` rather than to nothing.
 *
 * @param ctx - the plugin context.
 * @param route - a catalog route id.
 * @param modelId - the bare model id.
 * @returns the capability, or `undefined` when this route cannot describe it.
 */
async function capabilityOf(ctx, route, modelId) {
  try {
    const info = await ctx.llm.resolveModelInfo(route, modelId)
    const modalities = declaredModalities(info === null || typeof info !== 'object' ? undefined : info.inputModalities)
    const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined
    if (reasoning === null || typeof reasoning !== 'object' || !Array.isArray(reasoning.efforts)) {
      return { reasoning: false, levels: [], modalities }
    }
    const levels = reasoning.efforts
      .map((effort) => (effort !== null && typeof effort === 'object' ? effort.id : undefined))
      .filter((id) => typeof id === 'string' && id.length > 0)
    if (levels.length === 0) return { reasoning: false, levels: [], modalities }
    return { reasoning: true, levels, modalities }
  } catch {
    return undefined
  }
}

/**
 * The modality members of a resolved list, or `undefined` when the route states
 * none.
 *
 * WHY the list is filtered rather than copied: whatever this returns is what
 * the planner may write into the settings document, where
 * `input: z.array(z.union(MODALITIES))` validates it as part of the round's one
 * mutation. A member this harness does not know would turn "inherit this twin"
 * into "the whole write is rejected", so an unknown member is dropped, and a
 * list left empty by that is reported as no statement at all — which is exactly
 * how the adapter reads `[]` (`declaredInput`, `dsh-llm-pi-ai/lib/index.js:292-294`).
 *
 * @param value - the resolved `inputModalities`.
 * @returns the `text`/`image` members, or `undefined`.
 */
function declaredModalities(value) {
  if (!Array.isArray(value)) return undefined
  const known = value.filter((modality) => MODALITIES.includes(modality))
  return known.length === 0 ? undefined : known
}

/** Whether a rejected write was refused because the namespace moved. */
function isRevisionConflict(error) {
  return error !== null && typeof error === 'object' && error.code === 'SETTINGS_CONFLICT'
}

/** A short, safe message for a caught value of unknown shape. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
