# 0002. Backfill the per-model `input` list for custom-provider routes

Date: 2026-09-20
Status: accepted

## Context

ADR 0001 gave this plugin one job: fill the per-model `reasoningEfforts` a
custom-provider route cannot inherit, so the official 推理等级 picker appears. The
same route-keyed resolution loses a second capability, and it is the one that
decides whether an image can be sent at all.

`resolveEntry` computes a model's modalities as

```js
input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

(`dsh-llm-pi-ai/lib/index.js:682`). `declaredInput` (`:292-294`) answers
`undefined` for an absent **or empty** list — `[]` describes a model that
accepts nothing, so it states no answer — and `base` is again the installed
catalog entry of the same id **on the same route**. The profile layer's
`defaultInput` defaults to `['text']` (`:993`, `DEFAULT_INPUT` at `:906`), so:

- a custom route has no `base`, so `base?.input` contributes nothing;
- the custom-provider card writes only the id, the display name, the context
  window and the token limits — never `input` — so `declaredInput` contributes
  nothing either;
- every model of every custom route therefore resolves to `["text"]`, however
  vision-capable the endpoint behind it is.

That resolved list is not advisory. The host-side prompt admission gate throws
`MODEL_DOES_NOT_SUPPORT_IMAGES` as soon as the resolved list exists and does not
name `image` (`dsh-api-session-controller/lib/types/commands.js:311-312`), so an
attached image is refused before it is admitted; `dsh-tool-fs` refuses
`read_image` with the same test, `dsh-subagent` and `dsh-acp` refuse their own
image paths, and the repeat/context projectors strip images for such a model.
Every one of them reads the same resolved list, and no client surface reads
modalities at all — there is no picker, badge or dialog that would have to
change. The gap is host-side admission, and the per-model `input` field is the
only lawful per-model declaration the schema accepts
(`z.array(z.union(MODALITIES))`, `:973`, with `MODALITIES = ['text', 'image']` at
`:279-282`).

The field has two traps that shape the decision. An empty list is legal but
semantically identical to an absent one, so writing `[]` would silently undo the
fill it was meant to be; and the whole write is validated, so a member outside
`text`/`image` rejects the round's single mutation. (A stored unknown member is
worse than a rejected write: it makes the owning route unresolvable, which the
plugin already skips through `withoutRoutes`.)

## Decision

Extend the existing normalizer to fill the missing per-model `input` list, in
the same pass, with the same levers ADR 0001 settled: plan over
`describe().user`, skip routes the `llm` service reports as unresolvable, commit
one whole-`models`-array `set` per affected route against the namespace
revision, debounce both change signals, and never throw out of a listener.

For each model of a custom-provider route, in this order:

1. **A non-empty `input` array the entry already carries is a judgement and is
   preserved** — never overwritten, no change planned for this field, ordering
   included (`["image", "text"]` declares exactly what `["text", "image"]` does).
2. **Otherwise an unambiguous same-id catalog twin supplies the list**, when
   every catalog route describing that bare id agrees on the modality set and
   the agreed list is non-empty. A text-only `["text"]` twin is inherited like
   any other: that is capability truth, and copying it is what keeps a
   text-only builtin model text-only under a custom route.
3. **Otherwise the fallback is `["text", "image"]`** — no twin, twins that
   disagree, and twins that state nothing all leave the id undecided, and the
   permissive list is the one that can still be corrected per model.

The written value is never empty and never names a modality outside
`text`/`image`; both properties are enforced in the planner, not by its caller.

Two fields, one op. `reasoningEfforts` keeps its rules unchanged, `input` is
computed alongside it, and the route's single `set` op is emitted only when at
least one of the two differs from the stored value. `input` idempotence is
**set**-based, so an equivalent list is never rewritten to be reordered; the
loop breaker therefore covers both fields — the list this pass writes is a
non-empty declaration the next pass preserves, and the dict it writes is the
value the next pass computes again. A zero-op pass still returns without a
write.

Modality agreement is computed by a **separate** helper from reasoning
agreement. The two facts are independent — a twin can be non-reasoning yet
vision-capable — and coupling them would let a pair of twins that disagree only
about modalities push the reasoning field onto the standard-set fallback (or the
reverse). The captured catalog fact carries both, each captured on its own.

**Why an explicit list is a judgement while `reasoningEfforts` keeps its
`false`-only opt-out.** The two fields are only readable through their own
content. A reasoning dict this plugin wrote and a reasoning dict the user wrote
are the same value, so only `false` — something this plugin never writes — is
recognizable as a decision; everything else is derived state and is recomputed.
`input` has no sentinel like that and no spelling that could be recognized as
this plugin's own, so the field's mere presence is the only signal available.
Reading a present list as a judgement is the interpretation that cannot lose a
user's decision, at the cost of one asymmetry between the two fields; the
alternative — overwriting it because "the plugin might have written it" — would
silently turn every text-only declaration back into an image-capable one on the
next settings change.

**Considered options**

- **Add modality UI to this plugin (a Slot card beside the composer, or a
  settings section of its own).** Rejected: every reader of modalities is
  host-side, so a client surface would be a second place to look with no effect
  of its own, and it would introduce the client half, the Slot registration and
  the approval surface this package deliberately does not have. The per-model
  declaration already exists in settings; the gap is that nobody fills it.
- **Change the shipped settings card to collect modalities.** Rejected: it is
  harness code, not this plugin's, so the change would live outside this
  repository, ship on the harness's release cadence, and leave every
  already-added custom route unfixed. It also cannot help a route declared by
  hand or by a bundle.
- **Patch the admission gate (or the catalog build) to admit images for custom
  routes.** Rejected: it reaches into internals no plugin contract covers,
  breaks on upgrade, and would claim image support for models that genuinely do
  not have it, with no per-model way to say otherwise. Writing a value the
  schema already validates changes the pipeline's input instead of competing
  with the pipeline.
- **Keep the shipped `DEFAULT_INPUT = ['text']` as the fallback and require a
  hand-written list for images.** Rejected as the default: under-claiming
  refuses the image with no in-product way to fix it, which is precisely the bug
  being fixed here. The shipped constant must serve every route the catalog
  cannot interrogate; this planner serves routes a user just added on purpose,
  and a wrong guess is both visible and repairable there.

## Consequences

- Images can be sent to a custom-route model with no custom UI, no client half,
  no new dependency and no service published by this plugin. `read_image`, the
  prompt admission gate and the other modality consumers all clear with the same
  write, because they all read the same resolved list.
- The fallback may **over-declare** image support: a text-only endpoint behind a
  custom route is admitted an image that its provider then rejects mid-turn,
  after the message is durable. That is the accepted direction of the trade —
  under-claiming would refuse the image up front and leave the capability
  unreachable — and the durable answer is the explicit per-model list, `input:
  ["text"]`, which is never overwritten.
- A declared list is a durable judgement: ordinary edits to the provider profile
  do not restate the model entries (the shipped card writes minimal path ops
  against the stored section), so the list survives them. Deleting a model and
  re-adding it through the card builds a fresh entry without the field, so the
  next pass recomputes it — the reasoning dict is refilled to the same value,
  and a modality list the user had declared is lost to the computed one.
- Fallback drift is acceptable: when a catalog twin appears for an id that was
  previously unknown, later passes inherit its list. Values the user wrote
  explicitly win, because an explicit list is never rewritten, so the drift only
  reaches entries that declare nothing.
- `input` is written as a per-model field on the route's own entry, so
  uninstalling leaves it in `settings.yaml` like the reasoning dict: it stays
  schema-legal in the adapter's own section, the file remains valid, and images
  keep being admitted. Rewriting the user's file on removal stays out of scope,
  as in ADR 0001.
- A model whose stored list names a modality this harness does not know makes
  its route unresolvable, which is the one state the plugin already refuses to
  write: the route is skipped for that round, and the rest of the layer is
  normalized as usual.
- The planner's counters separate the two fields (`inputDeclared`,
  `modalityInherited`, `modalityDefaulted`), so the log line reports what was
  filled rather than implying that every model needed a modality change; every
  id-bearing model lands in exactly one of the three.
