/**
 * dsh-custom-reasoning-effort — host half.
 *
 * A model added through Settings → Models → 添加自定义提供方 reaches the model
 * catalog with no capabilities of its own. The catalog resolves a model's
 * reasoning per provider route (`resolveModelReasoning` in `dsh-llm-pi-ai`),
 * and a custom route — a route key the installed catalog, which is keyed by
 * route, does not ship — has no catalog entry to inherit from. The
 * custom-provider card writes no per-model `reasoningEfforts` either, so the
 * model resolves to `reasoning: false` and the composer's official 推理等级
 * picker stays hidden even when the very same model id is reasoning-capable
 * under a builtin route.
 *
 * This plugin fills that field in: it normalizes the persisted `llm-pi-ai`
 * settings so every model of a custom-provider route carries a schema-legal
 * `reasoningEfforts`, and the shipped pipeline (settings → catalog build →
 * picker → the `reasoning_effort` request parameter) does the rest with no
 * custom UI.
 *
 * The other per-model capability — the `input` modality list that decides
 * whether an image may be sent — is deliberately NOT this plugin's job. DSH
 * v0.2.0's Models settings page renders a per-model 输入类型 field (文本 /
 * 图片) on the very same card and writes the adapter's own `input` list
 * (`dsh-client-ui-settings-models/lib/client.js`, `inputField: "input"`), and
 * the adapter keeps resolving that field exactly as it resolves reasoning:
 * `declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`
 * (`dsh-llm-pi-ai/lib/index.js:687`). So the field has an owner, a UI and a
 * one-click answer, while a plugin writing it would only compete with the user.
 * Every reader of that resolved list — the host-side prompt admission gate
 * (`dsh-api-session-controller/lib/types/commands.js:317`,
 * `MODEL_DOES_NOT_SUPPORT_IMAGES`), `read_image`, the subagent and ACP image
 * paths — now clears through the settings page instead of through this plugin.
 *
 * The only thing this plugin still does with `input` is a ONE-SHOT cleanup of
 * its own leftovers: the previous release wrote that list on every custom-route
 * model it found without one, and those values are now shown by the settings
 * page as explicit per-model overrides. {@link apply} reclaims them once per
 * document — planned by `planResidualInputRemoval`, gated by a marker in this
 * plugin's own row config — and never touches the field again.
 *
 * The planning rules live in `./normalize.js`, which is pure so the cases can
 * be tested without a Cordis runtime; this file is the impure half — read the
 * two services, build the catalog capability map, write the settings mutations,
 * and never let a failure escape.
 *
 * @module dsh-custom-reasoning-effort
 */
import z from '@deepseek-ai/schemastery'
import {
  RESIDUAL_INPUT_VERSION,
  customModelIds,
  planNormalization,
  planResidualInputRemoval,
  withoutRoutes,
} from './normalize.js'

export const name = 'custom-reasoning-effort'

/** Hard dependencies: the model catalog seam and the settings registry. */
export const inject = ['llm', 'settings']

/**
 * This plugin's own row config, which is also its marker slot.
 *
 * WHY the reclaim needs persisted state at all, and why it lives here rather
 * than beside the data: the cleanup must run exactly once per document. Run on
 * every boot, it would also delete a list the user or the settings page wrote
 * after the upgrade whenever that list happens to equal a residual value —
 * `["text", "image"]` is the page's own output for a model with no catalog
 * twin, so that collision is not hypothetical. The marker therefore has to
 * outlive the process, and this row is the only namespace of ours the settings
 * service will let a plugin write: it is schema-declared and volatile, so it is
 * persisted to the profile's patch document (`configEditor.edit`), it keeps the
 * cleanup state next to the values it cleans, and a user who deletes the field
 * re-runs the cleanup once — which is a documented, recoverable way back.
 *
 * A schemastery schema is what makes the row configurable at all: the settings
 * service derives its configurable namespaces from the active Loader entries
 * whose runtime declares a `Config` (`dsh-settings/lib/index.js:539`), and its
 * writes keep only schema-declared volatile fields
 * (`dsh-settings/lib/index.js:141-146`). This package therefore declares one
 * runtime dependency, the harness's own schema library, instead of zero.
 */
export const Config = z.object({
  /**
   * The reclaim revision this profile has completed. Absent, or a number below
   * {@link RESIDUAL_INPUT_VERSION}, means the cleanup still needs to run.
   */
  residualInputsReclaimed: z.number().step(1).min(0).volatile(),
})

/** The settings namespace the pi-ai adapter owns; profile layer is `providers`. */
const NS = 'llm-pi-ai'

/**
 * The settings namespace of this plugin's own Loader row, which is where the
 * reclaim marker lives.
 *
 * The Loader derives an entry's settings namespace from its profile entry id
 * (`dsh-settings/lib/index.js:432`), and a bundle's own patch is what gives this
 * plugin its row — with `id` equal to the `name` this module exports, a parity
 * `test/mount-check.mjs` guards. Declaring `config` as an injected service
 * would be the other way to name it, and it is the wrong one: `config` is the
 * entry's value, not a service, so a plugin that injects it waits for something
 * that never registers (`pending (waiting for service: config)`).
 */
const MARKER_NS = name

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
  // service (`dsh-settings/lib/index.js:435`).
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
 * One normalization round: reclaim this plugin's leftovers once, then fill the
 * capability facts this plugin owns, committing at most one mutation per step.
 *
 * @param ctx - the plugin context.
 */
async function runRound(ctx) {
  try {
    await reclaimOnce(ctx, MARKER_NS, markerIn(ctx))
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
        const { planned, inherited, defaulted, nonReasoning } = plan.summary
        ctx.logger.info(
          `custom-reasoning-effort: filled reasoningEfforts on ${planned} model(s)`
          + ` across ${plan.ops.length} custom route(s)`
          + ` (${inherited} inherited, ${defaulted} defaulted, ${nonReasoning} non-reasoning)`,
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
 * The one-time cleanup of the `input` lists the previous release of this plugin
 * wrote, under a marker that keeps it from ever running twice.
 *
 * Two writes, in this order and never the other way round: the removal, then the
 * marker. The marker may never claim a cleanup that did not happen, or the
 * leftovers would be stranded forever, so a refused removal throws before the
 * marker is written and the next boot retries both.
 *
 * Idempotence is what makes that retry harmless: the plan is recomputed from the
 * document every time, so a re-read document is either untouched (the same plan)
 * or already clean (only the marker is left to write). Reclaim runs BEFORE the
 * capability fill because a cleanup that is always safe should not wait on a
 * fill that can be refused — and because the fill's own no-op pass, which is how
 * the plugin settles after a write, must not keep re-arming a deletion that has
 * already been recorded.
 *
 * @param ctx - the plugin context.
 * @param ns - this plugin's own settings namespace.
 * @param marker - the reclaim revision that namespace already records, or `undefined`.
 * @returns resolution when the profile is reclaimed, or when there is nothing
 *   for this round to do.
 */
async function reclaimOnce(ctx, ns, marker) {
  if (typeof marker === 'number' && marker >= RESIDUAL_INPUT_VERSION) return
  const descriptor = describeNamespace(ctx)
  // No `llm-pi-ai` section yet: nothing can have been reclaimed yet either, and
  // a later boot or settings change re-enters this path.
  if (descriptor === undefined) return
  const catalogRoutes = catalogRouteIds(ctx)
  const catalog = {
    catalogRoutes: [...catalogRoutes],
    models: await catalogCapabilityMap(ctx, catalogRoutes, customModelIds(descriptor.user, catalogRoutes)),
  }
  // Unresolvable routes are left IN, unlike the capability fill: deleting a
  // value is safe for a route whose profile cannot be resolved, and this
  // plugin's own leftovers must not survive in exactly the routes the user is
  // least likely to open in the settings page. If the seam refuses the write
  // anyway, it throws, the marker stays unset, and the next boot retries.
  const plan = planResidualInputRemoval(descriptor.user, catalog)
  if (plan.ops.length > 0) await ctx.settings.mutate(NS, plan.ops, descriptor.revision)
  // Two namespaces, two writes: the removal above belongs to the adapter's
  // section, the marker below to this plugin's own row — whose Loader id is the
  // name the host half exports, and the only namespace the settings service lets
  // a plugin write (see `Config`). The marker needs no revision guard of its
  // own: it is this plugin's private state, and nothing else writes it. It is
  // written LAST on purpose: a refused removal throws before this line, so the
  // marker can never claim a cleanup that did not happen.
  await ctx.settings.mutate(ns, [{ op: 'set', path: ['residualInputsReclaimed'], value: RESIDUAL_INPUT_VERSION }], undefined)
  if (plan.summary.reclaimed === 0) {
    ctx.logger.info('custom-reasoning-effort: no legacy input declarations to reclaim; the cleanup will not run again')
    return
  }
  ctx.logger.info(
    `custom-reasoning-effort: reclaimed legacy input declarations on ${plan.summary.reclaimed} model(s)`
    + ` across ${plan.summary.routes.length} custom route(s);`
    + ' input types are owned by the Models settings page from now on',
  )
}

/**
 * The reclaim revision this plugin's own namespace records, when it records one.
 *
 * WHY this reads the settings document instead of `ctx.config`: a round must see
 * the marker its previous write committed, and `ctx.config` is not reachable
 * from a plugin here — a property read on the context proxy goes through service
 * resolution, which answers `cannot get property "config" without inject` for a
 * key that is an entry value rather than a service. (Declaring `config` as an
 * injected service is the other way to ask, and it is the wrong one: the plugin
 * then waits forever for a service that never registers —
 * `pending (waiting for service: config)`.) The settings descriptor is the same
 * document, it is already a hard dependency of this plugin, and it is current:
 * every write re-describes.
 *
 * The shape test is deliberate. A hand-edited row may hold anything, and a
 * marker that is not a number says nothing, so the cleanup runs rather than
 * being silently retired.
 *
 * @param ctx - the plugin context.
 * @returns the recorded revision, or `undefined` when the row records none.
 */
function markerIn(ctx) {
  const descriptors = ctx.settings.describe()
  if (!Array.isArray(descriptors)) return undefined
  const descriptor = descriptors.find((entry) => {
    return entry !== null && typeof entry === 'object' && entry.ns === MARKER_NS
  })
  if (descriptor === undefined || descriptor === null || typeof descriptor !== 'object') return undefined
  const marker = descriptor.user === null || typeof descriptor.user !== 'object' ? undefined : descriptor.user.residualInputsReclaimed
  return typeof marker === 'number' ? marker : undefined
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
 * The reclaim is the one caller that does not use this list, because deleting a
 * value cannot be rejected for the reason a fill can (see `reclaimOnce`).
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
 * rather than guessing one.
 *
 * Both capitality facts are captured here, each on its own: the offered levels
 * are what the planner fills, and the modality list is what the one-shot
 * reclaim needs to recognize the values the previous release wrote
 * (`planResidualInputRemoval`). Capturing them together is only about the cost
 * of one `resolveModelInfo` call per id, not about one deciding the other.
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
 * The offered levels are the picker's own effort ids: the adapter reports
 * `reasoning.efforts[].id` as the raw level name, and a model with no
 * `reasoning` at all is a fact too — "this id does not reason here" — which is
 * why it resolves to `{ reasoning: false }` rather than to nothing.
 *
 * The modality list travels beside them for the reclaim alone. A list naming a
 * member this harness does not know is dropped there rather than copied, so
 * this capture stays a faithful copy of what the route reported.
 *
 * @param ctx - the plugin context.
 * @param route - a catalog route id.
 * @param modelId - the bare model id.
 * @returns the capability, or `undefined` when this route cannot describe it.
 */
async function capabilityOf(ctx, route, modelId) {
  try {
    const info = await ctx.llm.resolveModelInfo(route, modelId)
    const modalities = info !== null && typeof info === 'object' && Array.isArray(info.inputModalities)
      ? [...info.inputModalities]
      : undefined
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

/** Whether a rejected write was refused because the namespace moved. */
function isRevisionConflict(error) {
  return error !== null && typeof error === 'object' && error.code === 'SETTINGS_CONFLICT'
}

/** A short, safe message for a caught value of unknown shape. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
