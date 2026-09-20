# 0001. Normalize persisted `llm-pi-ai` settings instead of competing with the request path

Date: 2026-09-20
Status: accepted

## Context

A model added through Settings → Models → **添加自定义提供方** never shows the
composer's official 推理等级 picker, while the same model added through
**添加提供方** does — even when the model id is identical. Two independent
facts produce that outcome:

- The adapter resolves a model's reasoning capability **per provider route**
  (`resolveModelReasoning` in `dsh-llm-pi-ai`): with no declaration of its own, a
  model becomes `reasoning: base?.reasoning ?? false`, where `base` is the
  installed catalog entry of the same id **on the same route**. The builtin
  catalog is keyed by provider route, so a custom route — a route key that
  appears nowhere in the builtin catalog — has no entry to inherit from.
  Identical ids on a builtin route and on a custom route are unrelated for this
  lookup.
- The only other lawful source of that capability is the per-model
  `reasoningEfforts` field on the route's own model entry, which the schema
  accepts as either a dict of thinking levels with their wire spellings or the
  literal `false`. The custom-provider card never writes it: it collects the id
  and the connection facts and leaves the field absent.

With neither source present the catalog entry carries no reasoning, and the
official picker stays hidden (`当前模型未提供推理等级`). Everything downstream of
the catalog already works: when the entry says the model reasons, the shipped
picker appears, and the selected level is dispatched on the existing request
path as the `reasoning_effort` request parameter. The gap is purely missing
input metadata, and it must be closed by a plugin — a harness change is out of
scope, and any solution has to keep working across harness upgrades without
adding a second UI.

## Decision

Normalize the persisted `llm-pi-ai` settings. On every start and every settings
change, for each **custom-provider route** (a provider route key that is not in
the builtin catalog), every model that does not carry the explicit `false`
opt-out is brought up to date:

- an unambiguous builtin catalog entry with the same model id supplies the
  capability, level for level, each level spelled as its own name; `off` is
  written as `off: null`, "supported, send nothing". A `reasoning: false` twin
  is inherited as "this model does not reason" rather than silently gaining
  levels, and a twin whose only offered level is `off` has no expressible level
  list and lands on the same `false`;
- an id whose catalog twins disagree names different models in different places,
  and an id with no twin at all has nothing to inherit, so both get the standard
  seven-level pi-ai thinking-level set.

Two boundaries keep the write narrow. Only routes the **user settings layer**
declares are considered: a route the installed catalog ships is never touched,
and a route declared only in a composition base layer is left alone. The write
itself is one `set` op per affected route on that route's `models` path — the
array-level path is the deepest the shipped settings applier supports, because
it descends only into plain objects and cannot address an element inside an
array — and its value is the array that was just read with nothing changed but
`reasoningEfforts`, committed against the namespace revision so a concurrent
writer wins the race instead of being clobbered.

Settings is the only public, schema-legal lever the shipped pipeline already
honors end to end: the adapter builds the catalog from it on every refresh, the
catalog drives the official picker, and the picker's selection drives
`reasoning_effort` on the wire. Writing there changes the existing pipeline's
input instead of competing with the pipeline.

**Considered options**

- **Register a competing `LlmAdapter` for these routes.** Rejected: the adapter
  that owns a route also serves it, so this means reimplementing streaming,
  auth, retries, image budgets and every protocol detail, and then owning the
  request path forever — a metadata gap does not justify replacing the thing
  that talks to the model.
- **Replace the `conversation.input.model` slot, or reimplement the picker.**
  Rejected: the slot is a single-occupant official surface with its own catalog
  view, grouping, effort list and localization; shadowing it duplicates all of
  it, drifts with every release, and would fix only the composer while leaving
  every other catalog reader blind.
- **Monkey-patch the `llm` service or the catalog build.** Rejected: patching a
  live service reaches into internals no plugin contract covers and breaks on
  upgrade, for a result already reachable through validated input.
- **Require a hand-edited `reasoningEfforts` on every model.** Works today, but
  it is not a fix: every model added later needs the edit again. Rejected as the
  default — an explicit `false` remains available as the deliberate opt-out,
  while a hand-written level dict is overwritten like any other derived state.

**Recorded semantics.** The filled values are recomputed and overwritten on
every start and every settings change: they are derived state, not user state. A
hand-written level dict is derived state too and is replaced as soon as it
disagrees with the computation; the one value never overwritten is the explicit
per-model `false`, which is a judgement and therefore a durable opt-out.
Uninstalling leaves the filled fields in `settings.yaml`: they remain
schema-legal values in the adapter's own settings section, so the file stays
valid and the picker keeps working.

## Consequences

- The official picker appears for custom-provider routes with no custom UI, no
  client half, no new dependency and no service published by this plugin.
- The plugin's only write surface is a schema-validated settings section, so a
  schema change can at worst make the normalization a no-op or a refused write;
  nothing else in the deployment is put at risk.
- The inherited levels are an identity-spelling approximation. The list
  reproduces exactly the levels the twin offers — the resulting catalog
  `reasoning` object is identical — but a vendor-specific spelling the catalog
  carries internally is not reproduced: xAI's and OpenAI's `off: 'none'` is not
  copied, and omitting the reasoning parameter, which is what `off: null`
  produces, is the safe generic equivalent of "do not think" on whatever
  endpoint the route points at.
- The write is route-granular rather than field-granular: `set` on the route's
  `models` path restates the whole array, because the shipped settings applier
  cannot descend into arrays and an element path would replace the array with an
  object the schema rejects. The value is the array just read with only
  `reasoningEfforts` changed, so the cost is a larger write, not a coarser one.
- The scope is the user settings layer only: a route the installed catalog ships
  is never touched, and a route declared only in a composition base layer is
  left alone. A custom route materialized from a bundle therefore keeps whatever
  capability it declares and gets no help from this plugin.
- Overwriting derived state means a hand-edit that conflicts with the
  computation is replaced on the next pass; the only per-model declaration that
  survives is the explicit `false`. This is accepted: the alternative — merging
  with whatever the file currently holds — cannot distinguish a stale
  computation from a user edit.
- The standard thinking-level fallback can offer levels a gateway does not
  serve, and because a hand-written level list is derived state, the durable
  answer is the explicit per-model opt-out: one line, `reasoningEfforts: false`,
  which takes the model out of the picker rather than pinning a shorter list.
- Uninstall leaving the fields behind is an accepted trade-off: rewriting
  `settings.yaml` on removal would be a destructive act on a file the user owns,
  and the leftover values are precisely the state the user wanted. They stay
  schema-legal, so the file remains valid and the picker keeps working.
- A custom route the `llm` service reports as unresolvable is skipped for that
  round, and a partially-broken route is skipped as a whole rather than partly
  normalized: one op restates the route's whole `models` array and the seam
  re-validates the profile of every write, so attempting such a route would have
  the round's single mutation rejected and starve every healthy route of a pass
  it has no event left to retry from. The set is recomputed on every round, so a
  repaired route is normalized on the next pass.
