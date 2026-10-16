/**
 * The models.dev capability source: what thinking levels a model id supports.
 *
 * WHY this module exists at all, and why it is not the installed catalog: the
 * capability this plugin fills used to be inherited from the *installed* model
 * catalog's entry of the same id (the "catalog twin"). That catalog is generated
 * from models.dev when the harness is built and then frozen for the life of the
 * installed version, so a model released after that build had no twin, and a
 * model whose gateway semantics changed kept its build-time levels. The user's
 * requirement is the opposite: read the level set from models.dev live.
 *
 * WHAT models.dev says. `https://models.dev/api.json` is one JSON object keyed
 * by provider, each provider holding a `models` dict keyed by model id, and each
 * model carrying `reasoning` (boolean) plus `reasoning_options`, a list of
 * `{ type, ... }` entries. Only `type: "effort"` entries describe levels, and
 * their `values` are the wire spellings the provider accepts
 * (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The other types —
 * `toggle` (on/off thinking, no levels) and `budget_tokens` (a token budget, not
 * a level) — name no level this harness could offer, and neither does an empty
 * or absent option list.
 *
 * HOW one id's levels are derived, and why a union: the same id is routinely
 * declared by dozens of providers, and they disagree, because each one publishes
 * the subset its own gateway accepts (the live example that started this work:
 * `gemini-4-argon` is `low/medium/high` on google, `none/low/medium/high/max` on
 * requesty, and `high` alone on llmgateway). A custom route names no upstream
 * provider, so no single declaration is *the* truth for it, and the two
 * defensible readings are the union (never hide a level some provider accepts)
 * and the intersection (never offer a level some provider rejects). This module
 * takes the union — the same direction the plugin's "unknown" fallback has always
 * taken, and the one that cannot strand a capable model without a level it
 * supports. `off` is always added: it maps to sending no reasoning parameter at
 * all, which every endpoint tolerates, so "do not think" stays reachable.
 *
 * An id that yields no level beyond `off` is deliberately reported as UNKNOWN
 * rather than as a one-level set: the caller then falls back to the standard set
 * (`normalize.js`), which keeps the picker available, and the schema refuses a
 * declaration that offers nothing but `off` anyway.
 *
 * The fetch half is a small state machine around one in-memory snapshot:
 * `cold` (nothing yet) → `pending` (one request in flight) → `ready` (an index
 * is held; possibly stale) with failures retried on a capped backoff. Nothing is
 * ever written to disk: the snapshot is derived state that a restart re-derives,
 * which is what keeps an uninstall free of leftovers. The request asks for
 * compression explicitly because the document is ~5.7 MB raw and ~0.4 MB
 * brotli-encoded; Node's fetch decompresses brotli transparently, so the request
 * stays one ordinary fetch.
 *
 * @module dsh-custom-reasoning-effort/modelsdev
 */
import { THINKING_LEVELS } from './normalize.js'

/** The document this plugin reads; the only external input it has. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * The effort vocabulary models.dev uses, mapped onto this harness's level ids.
 *
 * `none` is the odd one: it is a wire spelling for "no reasoning", which is
 * exactly this harness's `off` level (declared as `off: null`, i.e. send
 * nothing). `default` — two occurrences in the whole document — names no level
 * and is ignored, as is any value this harness cannot express.
 */
export const EFFORT_LEVELS = Object.freeze({
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/** How long one fetched snapshot is considered current, in milliseconds. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/** The first retry delay after a failed fetch, in milliseconds. */
export const DEFAULT_RETRY_MS = 30 * 1000

/** The ceiling the retry delay doubles up to, in milliseconds. */
export const MAX_RETRY_MS = 15 * 60 * 1000

/** How long one request may take before it is aborted. */
export const DEFAULT_TIMEOUT_MS = 20 * 1000

/**
 * The largest document this plugin will accept, in bytes. The real one is
 * ~5.7 MB; the ceiling exists so a misrouted or hostile endpoint cannot make the
 * harness allocate without bound.
 */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

/** Whether a value is a plain data object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The levels one model entry declares through its `reasoning_options`.
 *
 * @param options - the entry's `reasoning_options` value.
 * @returns the harness level ids it names, deduplicated, in any order.
 */
export function declaredLevels(options) {
  if (!Array.isArray(options)) return []
  const levels = new Set()
  for (const option of options) {
    if (!isPlainObject(option) || option.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      const level = typeof value === 'string' ? EFFORT_LEVELS[value] : undefined
      if (level !== undefined) levels.add(level)
    }
  }
  return [...levels]
}

/**
 * Build the id → levels index from one parsed models.dev document.
 *
 * The whole document is walked once and reduced immediately: this plugin wants
 * 4092 ids' level sets, not 8983 model records, and dropping the input lets the
 * parsed document be collected instead of held for the process's lifetime.
 *
 * @param document - the parsed JSON document, of unknown shape.
 * @returns `{ providers, models, levels }` where `levels` is a `Map` from model
 *   id to a frozen, canonically ordered level list — every one of which offers
 *   at least one level beyond `off`.
 */
export function buildLevelIndex(document) {
  const levels = new Map()
  let providers = 0
  let models = 0
  if (!isPlainObject(document)) return { providers, models, levels }
  for (const provider of Object.values(document)) {
    if (!isPlainObject(provider) || !isPlainObject(provider.models)) continue
    providers += 1
    for (const [key, model] of Object.entries(provider.models)) {
      if (!isPlainObject(model)) continue
      models += 1
      const id = typeof model.id === 'string' && model.id.length > 0 ? model.id : key
      if (typeof id !== 'string' || id.length === 0) continue
      const declared = declaredLevels(model.reasoning_options)
      if (declared.length === 0) continue
      const bucket = levels.get(id) ?? new Set()
      for (const level of declared) bucket.add(level)
      levels.set(id, bucket)
    }
  }
  const index = new Map()
  for (const [id, bucket] of levels) {
    // Canonical order, `off` always present, and a set with nothing but `off`
    // is not a capability this plugin can declare.
    const ordered = THINKING_LEVELS.filter((level) => level === 'off' || bucket.has(level))
    if (!ordered.some((level) => level !== 'off')) continue
    index.set(id, Object.freeze(ordered))
  }
  return { providers, models, levels: index }
}

/**
 * Read one response body with a byte ceiling.
 *
 * `Response.text()` would buffer whatever the endpoint sends; the ceiling is
 * enforced while reading so a wrong URL cannot be turned into unbounded memory.
 *
 * @param response - the fetch response.
 * @param maxBytes - the largest body to accept.
 * @returns the decoded text.
 * @throws when the body exceeds the ceiling or cannot be decoded.
 */
async function readBounded(response, maxBytes) {
  const body = response.body
  if (body === null || typeof body.getReader !== 'function') return await response.text()
  const reader = body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new Error(`the document outgrew ${String(maxBytes)} bytes`)
    }
    chunks.push(chunk)
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * The live models.dev snapshot, as a small state machine the rounds drive.
 *
 * Every round calls {@link LevelCatalog.ensure}, which starts a request when one
 * is due and otherwise answers with the current state; the caller never waits on
 * the network. A completed request calls `onEvent`, which is what re-arms a round
 * — the plugin therefore fills shortly after the document arrives, and reports
 * the standard-set fallback while it has none.
 *
 * @param options - deployment seams; all have production defaults.
 * @returns the catalog handle: `ensure`, `levelsFor`, `state`, and the raw index.
 */
export function createLevelCatalog({
  url = MODELS_DEV_URL,
  fetchImpl = globalThis.fetch,
  ttlMs = DEFAULT_TTL_MS,
  retryMs = DEFAULT_RETRY_MS,
  maxRetryMs = MAX_RETRY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_DOCUMENT_BYTES,
  now = Date.now,
  onEvent = () => {},
} = {}) {
  let index
  let fetchedAt
  let attempts = 0
  let nextAttemptAt = 0
  let inFlight
  let error

  /** The levels one id declares, or `undefined` when models.dev names none. */
  const levelsFor = (id) => index?.levels.get(id)

  /** The observed state, without touching the network. */
  const state = () => {
    const at = now()
    return {
      status: index !== undefined ? 'ready' : inFlight !== undefined ? 'pending' : 'cold',
      stale: index !== undefined && fetchedAt !== undefined && at - fetchedAt >= ttlMs,
      attempts,
      error,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(index === undefined ? {} : { known: index.levels.size }),
    }
  }

    /** Whether a request should start now. */
    const due = () => {
      if (inFlight !== undefined) return false
      if (typeof fetchImpl !== 'function') return false
      if (index === undefined) return now() >= nextAttemptAt
      return now() - (fetchedAt ?? 0) >= ttlMs
    }

  /** The backoff one failed attempt earns. */
  const backoff = () => Math.min(retryMs * 2 ** Math.max(0, attempts - 1), maxRetryMs)

  /** One request, from body to index, with no failure escaping. */
  const refresh = () => {
    const started = now()
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    inFlight = (async () => {
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/json', 'accept-encoding': 'br, gzip' },
          ...(signal === undefined ? {} : { signal }),
        })
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          throw new Error(`models.dev answered ${String(response?.status ?? 'nothing')}`)
        }
        const text = await readBounded(response, maxBytes)
        const built = buildLevelIndex(JSON.parse(text))
        if (built.levels.size === 0) throw new Error('models.dev returned no usable model levels')
        index = built
        fetchedAt = now()
        attempts = 0
        nextAttemptAt = 0
        error = undefined
        onEvent('ready', built)
      } catch (reason) {
        attempts += 1
        nextAttemptAt = now() + backoff()
        error = reason instanceof Error ? reason.message : String(reason)
        onEvent('failed', { attempts, error, elapsedMs: now() - started })
      } finally {
        inFlight = undefined
      }
    })()
    // The request itself settles this promise; no caller awaits it, so keep a
    // rejection from ever surfacing as an unhandled rejection.
    inFlight.catch(() => {})
    return inFlight
  }

  return {
    /** Start a request when one is due and report the state either way. */
    ensure() {
      if (due()) refresh()
      return { ...state(), ...(index === undefined ? {} : { levels: index.levels }) }
    },
    /** Whether no level set can be had right now: nothing held, nothing in flight. */
    get unavailable() {
      return index === undefined && inFlight === undefined && (attempts > 0 || typeof fetchImpl !== 'function')
    },
    levelsFor,
    state,
    /** The raw index, for tests and diagnostics. */
    get index() {
      return index
    },
    /** Force a request now, ignoring the TTL and the backoff (tests, repair). */
    refresh,
  }
}
