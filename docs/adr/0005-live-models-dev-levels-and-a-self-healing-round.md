# 0005. Read thinking levels from models.dev live, and make a round unable to give up

Date: 2026-10-16
Status: accepted
Supersedes: [ADR-0001](0001-settings-normalization-for-custom-provider-reasoning-effort.md) in part (the level source and the opt-out rule survive; the catalog-twin inheritance and the one-shot bookmark it needed do not)

## Context

A user reported that `gemini-4-argon`, added to their custom provider route
(`self-use`, an OpenAI-compatible gateway) through the Models page, still had no
推理等级 picker while the six models already on that route did. Investigation on
the live harness (RPC against the running profile, not a reproduction) found:

- the model entry carried no `reasoningEfforts`, and the resolved catalog entry
  therefore carried no `reasoning`, which is exactly what hides the picker;
- the six older models on the same route carried the seven-level standard set;
- the route was serviceable — `llm/listConfigurableProviders` reported no error
  for it, and an inert settings write was accepted against it;
- the plugin's Loader row was `enabled: true`, `fiberPhase: "active"`;
- **a fresh settings write on the `llm-pi-ai` namespace (revision 3 → 4) produced
  no reaction from the plugin at all** — no write, no retry, no log — which is
  the state the user was in: the plugin had stopped acting on events, silently,
  at some point after the boot that filled the six models.

Two independent defects produced that outcome, and both are structural rather
than incidental:

1. **The plugin could disable itself permanently.** `schedule()` armed its
   debounce through `ctx.effect` and, on any refusal, set `disposed = true` for
   the life of the instance. Cordis refuses a new effect while a fiber is
   unloading, and this profile runs with `patchReload: live`, so the Loader tears
   down and re-applies rows every time the profile patch changes — which the
   settings service does on every model edit. One refusal in that window silenced
   every later trigger while the listeners stayed registered and the row still
   read `active`. There was no second trigger and no verification, so nothing
   ever noticed.
2. **The capability source was the installed catalog**, i.e. a models.dev
   snapshot frozen at harness build time (`pi-ai/dist/providers/data/*.json`).
   The previous release inherited a same-id "catalog twin"'s levels and required
   all describing routes to agree; `gemini-4-argon` does not exist in that
   snapshot at all, so the only thing the source could have said about it was
   "unknown". The user asked for the level set to come from models.dev live.

## Decision

**The level source is models.dev, fetched at runtime, unioned per model id.**
One `GET https://models.dev/api.json` (compressed: ~0.4 MB of a ~5.7 MB document)
is reduced in memory to a `Map<id, levels>` and the document is dropped; nothing
is written to disk. A model id is looked up across every provider and the union
of the `type: "effort"` values becomes its level set, mapped onto this harness's
vocabulary (`none` → `off`; `toggle` and `budget_tokens` name no level; unknown
values are ignored), with `off` always added because it means "send no reasoning
parameter". The installed catalog is not consulted — not as a primary source and
not as a fallback — because it is the thing that was stale.

**An id with no usable declaration keeps the standard seven-level set, and
nothing is ever written as `false`.** The fallback covers "not in models.dev",
"declared only with `toggle`/`budget_tokens`", and "declared `reasoning: false`"
alike: the plugin fills a picker, it does not take one away, and a model it
cannot describe must not lose a capability it may have. The user's own
`reasoningEfforts: false` remains the one durable per-model judgement
(ADR-0001's opt-out rule, unchanged).

**A pass can be triggered three ways, and a failure cannot stop the plugin.**
The two change signals arm a debounced round; a once-a-minute reconcile tick
re-runs it with no event at all (and refreshes a snapshot older than six hours);
and a refused timer is reported rather than latched. After a committed write the
plugin re-reads and re-plans to confirm the value landed, and every finding is
reported through `ctx.logger` **and** the console — this deployment registers no
logger exporter, so runtime `logger.warn` goes nowhere, which is why a silent
failure was possible for five days.

**The plugin keeps no persisted state of its own.** The 0.2.x `input` reclaim and
the `residualInputsReclaimed` marker that gated it are retired: the marker was the
plugin's only write outside `llm-pi-ai`, it forced a `Config` schema and a row
override in the user's profile patch, and the field it cleaned is owned by the
Models page now. With no `Config` the plugin has no settings namespace and no row
override to leave behind. The level declarations themselves cannot be removed by
a plugin that is already uninstalled, so the package ships
`scripts/cleanup.mjs`: a one-shot, dry-run-by-default command that removes the
declarations of this plugin's own handwriting (`isWrittenEfforts`: each level
spelled as its own name, `off` as `null`) plus the retired marker row, preserving
comments and key order.

## Consequences

- **Level sets narrow on upgrade, by design.** A model that showed seven levels
  now shows what models.dev declares for it (`gemini-4-argon`: `off`, `low`,
  `medium`, `high`, `max`). An explicit effort a model no longer offers is
  rejected by the adapter's own `resolveCallConfig` before provider I/O, so a
  session sitting on such a level must pick another one. The alternative —
  intersection — was rejected for the opposite failure: hiding a level the
  endpoint accepts.
- **A union can over-offer.** models.dev's providers disagree because each
  publishes what its own gateway accepts, and a custom route has no upstream to
  match against. The `false` opt-out is the per-model escape hatch, and the
  over-offer is bounded by the vocabulary (seven levels) rather than by the
  catalog's opinion.
- **The plugin now needs the network once per boot** (only when the profile has
  at least one custom-route model), and revalidates every six hours. An
  unreachable models.dev is not fatal: the standard set is written so the picker
  still appears, the failure is reported once, and retries back off from 30 s to
  15 min. While the first fetch is in flight the pass waits instead of writing a
  value it is about to replace.
- **The debounce and reconcile intervals are tunable through the row config**
  (`debounceMs`, `reconcileIntervalMs`); nothing else is, and no config is ever
  written by the plugin.
- **ADR-0001's core decision stands**: normalize the persisted `llm-pi-ai`
  settings, because the per-model `reasoningEfforts` field is the only lawful
  source of the capability and no runtime service can contribute one. Its
  twin-inheritance source and agreement rule are replaced by models.dev and the
  union. ADR-0003's reclaim is retired along with the marker it needed; a user
  upgrading directly from 0.2.x keeps those `input` values, which the Models page
  shows as explicit per-model choices and can clear per model.
