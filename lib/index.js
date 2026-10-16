/**
 * dsh-custom-reasoning-effort — host half.
 *
 * A model added through Settings → Models → 添加自定义提供方 reaches the model
 * catalog with no capabilities of its own. The catalog resolves a model's
 * reasoning per provider route (`resolveModelReasoning` in `dsh-llm-pi-ai`), and
 * a custom route — a route key the installed catalog, which is keyed by route,
 * does not ship — has no catalog entry to inherit from. The custom-provider card
 * writes no per-model `reasoningEfforts` either, so the model resolves to
 * `reasoning: false` and the composer's official 推理等级 picker stays hidden even
 * when the very same model id is reasoning-capable under a builtin route.
 *
 * This plugin fills that field in: it normalizes the persisted `llm-pi-ai`
 * settings so every model of a custom-provider route carries a schema-legal
 * `reasoningEfforts`, and the shipped pipeline (settings → catalog build →
 * picker → the `reasoning_effort` request parameter) does the rest with no
 * custom UI. The level sets come from models.dev, fetched live; see
 * `lib/modelsdev.js` for why the installed catalog is not the source, and
 * `lib/normalize.js` for the planning rules.
 *
 * The other per-model capability — the `input` modality list that decides
 * whether an image may be sent — is deliberately NOT this plugin's job. DSH
 * v0.2.0's Models settings page renders a per-model 输入类型 field (文本 /
 * 图片) on the very same card and writes the adapter's own `input` list
 * (`dsh-client-ui-settings-models/lib/client.js`, `inputField: "input"`). The
 * 0.2.x releases of this plugin wrote that field, and 0.3.0 reclaimed their
 * leftovers under a migration marker in this plugin's own row config; both the
 * reclaim and the marker are retired. Dropping the marker is what removes this
 * plugin's last writes outside `llm-pi-ai`: an uninstall now leaves nothing in
 * the profile patch, and `scripts/cleanup.mjs` removes the level declarations
 * themselves.
 *
 * THREE PROPERTIES THIS ENTRY IS BUILT AROUND, each of them a bug that was
 * observed in production before it was designed away:
 *
 *   1. A ROUND MUST NEVER BE ABLE TO STOP THE PLUGIN. The previous release armed
 *      its debounce through `ctx.effect` and, on any refusal, set a `disposed`
 *      flag for the life of the instance — so one refused timer (a fiber
 *      unloading while the harness hot-reloads the profile patch, which the
 *      settings service rewrites on every model edit) silenced the plugin
 *      forever. Its listeners stayed registered, the Loader still reported the
 *      row as `active`, and every later settings write was dropped on the floor.
 *      That is the state `gemini-4-argon` was found in: the six models filled at
 *      an earlier boot kept their levels, and the model added afterwards never
 *      got any. Nothing here may latch: a refused timer is reported and the
 *      round is left to the other two triggers.
 *   2. THERE IS ALWAYS A THIRD TRIGGER. Beyond the two change signals, one
 *      long-lived reconcile tick re-runs the pass on every interval, so a missed
 *      or refused event self-heals instead of stranding a model permanently.
 *   3. A FAILURE MUST BE VISIBLE. The pass verifies its own write and reports
 *      every failure through the harness logger AND, because this deployment
 *      registers no logger exporter at all (runtime `ctx.logger` output goes
 *      nowhere; only boot diagnostics are collected), through the console, which
 *      reaches the process's stdout. Findings are deduplicated per cause so a
 *      permanent condition is reported once, not once per tick.
 *
 * @module dsh-custom-reasoning-effort
 */
import { MODELS_DEV_URL, createLevelCatalog } from './modelsdev.js'
import {
  customModelIds,
  planNormalization,
  withoutRoutes,
} from './normalize.js'

export const name = 'custom-reasoning-effort'

/**
 * Hard dependencies: the model catalog seam and the settings registry.
 *
 * `config` is deliberately NOT injected — it is the entry's value, not a
 * service, and injecting it leaves the plugin waiting for something that never
 * registers (`pending (waiting for service: config)`).
 */
export const inject = ['llm', 'settings']

/**
 * The settings namespace the pi-ai adapter owns; its profile layer is `providers`.
 *
 * This plugin writes here and nowhere else. It declares no `Config` of its own,
 * so it has no namespace to leave a marker in — one less thing to clean up.
 */
const NS = 'llm-pi-ai'

/**
 * Debounce for both change signals.
 *
 * One settings write announces itself twice — as `settings/document-updated` for
 * the namespace and again as `llm/adapters-updated` once the adapter has
 * re-registered its routes, and a provider card write may land model by model —
 * so a pass per event would read the same state several times and race its own
 * writes. 250ms collapses each burst into one pass while staying imperceptible
 * next to a settings round trip.
 */
const DEFAULT_DEBOUNCE_MS = 250

/**
 * How often the reconcile tick re-runs the pass with no event at all.
 *
 * WHY this exists: the plugin is the only writer of the field it fills, and a
 * single missed or refused trigger used to strand a model until the next restart
 * (see the module comment). A pass with nothing to do is one settings read and a
 * pure plan over a handful of models, so a minute is cheap; it is also the
 * cadence at which a models.dev snapshot that went stale is refreshed.
 */
const DEFAULT_RECONCILE_MS = 60 * 1000

/** One reporter per plugin context, so deduplication survives across passes. */
const reporters = new WeakMap()

/** A short, safe message for a caught value of unknown shape. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** A positive number, or the fallback when the value is not one. */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The reporter one context logs through.
 *
 * Deduplication is per cause (`report(key, message)` emits only when that key's
 * message changes), which is what keeps a permanently unavailable models.dev or
 * a permanently unresolvable route from printing once per reconcile tick, while
 * still reporting a new failure and staying quiet once the cause changes.
 *
 * @param ctx - the plugin context.
 * @returns the reporter.
 */
function reporterFor(ctx) {
  let reporter = reporters.get(ctx)
  if (reporter !== undefined) return reporter
  const active = new Map()
  const emit = (level, message) => {
    if (level === 'warn') {
      ctx.logger?.warn?.(`${name}: ${message}`)
      // The fallback channel, on purpose: this harness registers a logger
      // exporter only for boot diagnostics, so a runtime `logger.warn` is
      // dropped and a failure would otherwise be invisible. Failures only —
      // routine progress stays on the harness logger.
      if (typeof console === 'object' && typeof console.warn === 'function') {
        console.warn(`[${name}] ${message}`)
      }
      return
    }
    ctx.logger?.info?.(`${name}: ${message}`)
  }
  reporter = {
    info: (message) => emit('info', message),
    report(key, message) {
      if (active.get(key) === message) return
      active.set(key, message)
      emit('warn', message)
    },
    clear(key) {
      active.delete(key)
    },
  }
  reporters.set(ctx, reporter)
  return reporter
}

/**
 * Build the plugin's behaviour with its seams injectable.
 *
 * `apply` is the production entry and needs no options. The factory exists so
 * `test/round.test.mjs` can drive the real pass directly (`normalizer.run(ctx)`)
 * and hand it a stub fetch and short timers instead of waiting on the network
 * and on production intervals.
 *
 * @param options - deployment seams; every one of them has a production default.
 * @returns `{ catalog, run, mount }`.
 */
export function createNormalizer({
  fetchImpl,
  url = MODELS_DEV_URL,
  ttlMs,
  retryMs,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  reconcileMs = DEFAULT_RECONCILE_MS,
} = {}) {
  /** Set by {@link mount}; a catalog event before a mount has nothing to arm. */
  let hooks = {}
  const catalog = createLevelCatalog({
    url,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(retryMs === undefined ? {} : { retryMs }),
    onEvent: (event, detail) => hooks.onCatalogEvent?.(event, detail),
  })
  const debounce = positiveNumber(debounceMs, DEFAULT_DEBOUNCE_MS)
  const reconcile = positiveNumber(reconcileMs, DEFAULT_RECONCILE_MS)

  /** One pass against one context; never throws, never latches. */
  const run = (ctx) => runPass(ctx, catalog)

  /**
   * Mount on a plugin context: the two change signals, one debounced round and
   * the reconcile tick.
   *
   * Every side effect — both listeners, both timers and the debounced round —
   * is registered on this plugin's fiber, so a stop, an update or an undefine
   * removes them together.
   *
   * @param ctx - the plugin context.
   * @returns the mounted runtime (`run`, `arm`, `stop`), for tests and callers.
   */
  const mount = (ctx) => {
    const reporter = reporterFor(ctx)
    let stopped = false
    let pending

    const cancel = () => {
      const dispose = pending
      pending = undefined
      if (dispose !== undefined) dispose()
    }

    const stop = () => {
      stopped = true
      cancel()
    }

    const runNow = () => {
      void run(ctx)
    }

    /**
     * Arm the debounced round.
     *
     * A refused `ctx.effect` — the fiber is unloading right now, which the live
     * profile reload does on every patch edit — is a transient condition, NOT a
     * reason to stop. It is reported, and the reconcile tick and the next event
     * still get their chance. (The previous release set a `disposed` latch here
     * and went permanently silent instead; see the module comment.)
     */
    const arm = () => {
      if (stopped) return
      cancel()
      try {
        pending = ctx.effect(() => {
          const handle = setTimeout(() => {
            // The timer has fired, so its registration is spent: release it now
            // rather than leaving one passed-over effect on the fiber per round,
            // which a long-lived harness would accumulate indefinitely.
            const dispose = pending
            pending = undefined
            if (dispose !== undefined) dispose()
            runNow()
          }, debounce)
          return () => clearTimeout(handle)
        }, `${name}:round`)
      } catch (error) {
        reporter.report('timer', `could not arm the debounced round (${messageOf(error)}); the reconcile tick will still run it`)
      }
    }

    ctx.effect(() => stop, `${name}:lifecycle`)

    // The self-healing trigger. `unref` keeps this plugin from being the reason
    // a shutting-down process stays alive; the harness owns the loop otherwise.
    ctx.effect(() => {
      const handle = setInterval(runNow, reconcile)
      if (typeof handle.unref === 'function') handle.unref()
      return () => clearInterval(handle)
    }, `${name}:reconcile`)

    // The signal that matters: the namespace was written, in-process or from the
    // stored document, and its revision moved. Emitted by the host settings
    // service (`dsh-settings/lib/index.js:435`).
    ctx.on('settings/document-updated', (ns) => {
      if (ns === NS) arm()
    })

    // The adapter re-registered its routes, so a route that was dormant during
    // the previous pass may now be resolvable — or the reverse. Emitted by the
    // host llm service (`dsh-llm/lib/index.js:1753`).
    ctx.on('llm/adapters-updated', () => arm())

    hooks = {
      onCatalogEvent(event, detail) {
        if (event === 'failed') {
          reporter.report('modelsdev', `models.dev is unavailable (${detail?.error ?? 'no fetch available'}); the standard level set is used meanwhile and a retry is scheduled`)
        } else {
          reporter.clear('modelsdev')
          reporter.info(`models.dev index ready (${String(detail?.levels?.size ?? 0)} model id(s))`)
        }
        arm()
      },
    }

    // The first pass covers the state a previous run left behind. It is
    // debounced rather than immediate so that plugin rows which apply after this
    // one (the pi-ai adapter installs its settings section in its own apply)
    // have landed before the section is read.
    arm()

    return { run: () => run(ctx), arm, stop }
  }

  return { catalog, run, mount }
}

/**
 * Apply the settings normalizer.
 *
 * @param ctx - the plugin context.
 * @param config - the row's config, when a profile carries one. Only the
 *   optional tuning keys below are read; an undeclared config object (a stale
 *   marker from 0.4.0, say) is ignored.
 */
export function apply(ctx, config = {}) {
  createNormalizer({
    ...(typeof config?.fetchImpl === 'function' ? { fetchImpl: config.fetchImpl } : {}),
    ...(typeof config?.modelsDevUrl === 'string' && config.modelsDevUrl.length > 0 ? { url: config.modelsDevUrl } : {}),
    ...(typeof config?.debounceMs === 'number' ? { debounceMs: config.debounceMs } : {}),
    ...(typeof config?.reconcileIntervalMs === 'number' ? { reconcileMs: config.reconcileIntervalMs } : {}),
  }).mount(ctx)
}

/**
 * One normalization pass: read the layer, decide the level set of every model
 * that needs one, and commit at most one mutation.
 *
 * @param ctx - the plugin context.
 * @param catalog - the models.dev catalog handle.
 */
async function runPass(ctx, catalog) {
  const reporter = reporterFor(ctx)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // One retry: another writer moved the namespace between read and write.
      // The loop re-reads and re-plans, so the retry commits values derived from
      // the state it actually saw.
      const outcome = await attemptPass(ctx, catalog, reporter)
      if (outcome !== 'conflict') return
    }
  } catch (error) {
    reporter.report('pass', `skipped one normalization pass (${messageOf(error)})`)
  }
}

/**
 * One read-decide-write attempt.
 *
 * @param ctx - the plugin context.
 * @param catalog - the models.dev catalog handle.
 * @param reporter - the deduplicating reporter.
 * @returns `'idle'` (nothing to plan), `'waiting'` (the capability source is
 *   still arriving), `'settled'` (the computed values are already in place),
 *   `'conflict'` (another writer moved the namespace) or `'written'`.
 */
async function attemptPass(ctx, catalog, reporter) {
  const descriptor = describeNamespace(ctx)
  if (descriptor === undefined) return 'idle'
  const catalogRoutes = catalogRouteIds(ctx)
  // Nothing to fill on a profile with no custom-route models — which is also
  // what keeps such a profile from ever touching the network, so the capability
  // source is consulted only after this answers.
  if (customModelIds(descriptor.user, catalogRoutes).size === 0) return 'idle'
  const state = catalog.ensure()

  let levels = new Map()
  if (state.status === 'pending') {
    // A request is in flight. Writing the standard set now would be overwritten
    // a moment later, so this pass waits; the catalog event re-arms a round.
    return 'waiting'
  }
  if (state.status === 'ready') {
    levels = state.levels
  } else if (catalog.unavailable) {
    // No document and no request in flight: the source is unreachable (or this
    // runtime has no fetch). The standard set is the honest fallback, the retry
    // is already scheduled, and the next successful fetch narrows it again.
    reporter.report('modelsdev', `models.dev is unavailable (${state.error ?? 'no fetch available'}); the standard level set is used meanwhile and a retry is scheduled`)
  } else {
    // Cold with a request just started by `ensure()`; wait for it.
    return 'waiting'
  }

  // A route the llm service cannot resolve is not writable at all, and one op
  // carries a route's whole `models` array, so planning over it would cost every
  // other route the round.
  const unresolvable = unresolvableRoutes(ctx)
  if (unresolvable.size > 0) {
    reporter.report('unresolvable', `left ${unresolvable.size} unresolvable custom route(s) alone (${[...unresolvable].join(', ')}); the llm service reports what each one needs`)
  } else {
    reporter.clear('unresolvable')
  }

  const plan = planNormalization(withoutRoutes(descriptor.user, unresolvable), {
    catalogRoutes: [...catalogRoutes],
    levels,
  })
  // The loop breaker: a pass whose computed values are already in place writes
  // nothing, so the event this plugin's own write produces settles here instead
  // of running forever.
  if (plan.ops.length === 0) return 'settled'

  try {
    await ctx.settings.mutate(NS, plan.ops, descriptor.revision)
  } catch (error) {
    if (isRevisionConflict(error)) return 'conflict'
    throw error
  }

  const { planned, sourced, defaulted } = plan.summary
  reporter.info(
    `filled reasoningEfforts on ${planned} model(s) across ${plan.ops.length} custom route(s)`
    + ` (${sourced} from models.dev, ${defaulted} standard)`,
  )
  reporter.clear('pass')

  // Verify, because "the write reported success" and "the document holds the
  // value" are different facts — and the previous release's silent failure was
  // exactly that gap. A miss is reported and left to the next trigger; it is
  // never retried in a loop here.
  const stillMissing = verifyPass(ctx, catalogRoutes, levels)
  if (stillMissing > 0) {
    reporter.report('verify', `the write landed but ${stillMissing} model(s) still lack the computed level set; the next pass retries`)
  } else {
    reporter.clear('verify')
  }
  return 'written'
}

/**
 * How many models a fresh read would still have to write after a committed pass.
 *
 * The count comes from re-planning the document that is now stored, with the
 * same capability facts the write used. It is deliberately a count rather than a
 * diff: a non-zero answer means the write did not land (or another writer
 * replaced it immediately), which is a reportable fact either way, and the next
 * trigger re-plans from scratch.
 *
 * @param ctx - the plugin context.
 * @param catalogRoutes - ids the installed catalog ships.
 * @param levels - the level sets the pass planned with.
 * @returns the number of models still missing their computed value.
 */
function verifyPass(ctx, catalogRoutes, levels) {
  const fresh = describeNamespace(ctx)
  if (fresh === undefined) return 0
  const plan = planNormalization(withoutRoutes(fresh.user, unresolvableRoutes(ctx)), {
    catalogRoutes: [...catalogRoutes],
    levels,
  })
  return plan.summary.planned
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
 * mutation as a whole — costing every other route its pass. Leaving it out of
 * the plan instead lets the remaining routes commit, and recomputing the set
 * every round means repairing the route lets the next pass pick it up.
 *
 * This is also the one skip that used to be invisible: the report is a warning,
 * deduplicated per cause, so a route stuck behind a broken sibling model says so
 * instead of looking like a plugin that does nothing.
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

/** Whether a rejected write was refused because the namespace moved. */
function isRevisionConflict(error) {
  return error !== null && typeof error === 'object' && error.code === 'SETTINGS_CONFLICT'
}
