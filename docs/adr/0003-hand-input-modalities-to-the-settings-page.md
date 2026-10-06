# 0003. Hand the per-model `input` list to the settings page

Date: 2026-10-06
Status: accepted
Supersedes: [ADR-0002](0002-input-modality-backfill-for-custom-provider-routes.md)

## Context

ADR-0002 gave this plugin a second job: fill the per-model `input` list on
custom-provider routes, because `resolveEntry` computes a model's modalities as

```js
input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

and for a custom route every term but the first is empty — no `base` (the
installed catalog is keyed by provider route) and a profile default of `["text"]`
— while nothing in the product wrote the first. The ADR's own "considered
options" named the fix that has since arrived: *"Change the shipped settings card
to collect modalities."* It was rejected then because it would live outside this
repository and leave every already-added route unfixed.

DSH v0.2.0 ships exactly that card. The Models settings page renders a per-model
**输入类型** field (文本 / 图片) on both provider families and writes the
adapter's own field — `input` for pi-ai routes, `inputModalities` for the
DeepSeek catalog (`dsh-client-ui-settings-models/lib/client.js`, `inputField:
"input"` at the `ModelListEditor`). For a pi-ai route it even primes the control
with the model's advertised input types, discovered from the endpoint or the
installed catalog, and falls back to the profile's `defaultInput`. The field now
has an owner, a UI, and a one-click answer that survives the plugin.

Two properties of the plugin's own write make simply deleting the code
insufficient. It wrote on *every* custom-route model it found without a list, so
the values are already in users' documents; and the settings page shows a
present list as an explicit override, so those values do not decay into
inheritance — they read as a per-model decision the user made. `["text",
"image"]` in particular is a plugin guess that keeps a text-only endpoint
admitting images (ADR-0002 accepted that as over-declaration, with a hand-written
list as the durable answer), and the page now presents it as the user's own
choice.

## Decision

Remove the `input` half of the normalizer. The plugin no longer reads, writes,
validates or reorders the per-model modality list; the shipped settings page and
the adapter own it, and an entry's list is carried through every write verbatim.
`reasoningEfforts` keeps ADR-0001's rules unchanged, including its `false`-only
opt-out — the reasoning picker is still a capability no shipped surface collects.

Reclaim the leftovers **once**, on the first start of this release:

1. For each model of a custom-provider route, remove `input` when — and only
   when — the stored list is exactly the value the 0.2.x normalizer would have
   written for that entry: the list its same-id catalog twin states (when every
   catalog route describing that id agrees), or `["text", "image"]` when no twin
   does. Comparison is set-based, because ordering never carried information in
   this field. Everything else — a narrower list, an unknown member, `[]`, a
   non-list — is left alone.
2. Catalog routes are never swept: the old code skipped them, so a list there is
   either the catalog's or the user's.
3. The removal and its marker are committed as one mutation, so the profile
   either has the leftovers gone and the marker set, or neither.
4. The marker (`residualInputsReclaimed`) lives in this plugin's own row config
   in the profile's patch document, is schema-declared and volatile, and gates
   every later boot. Deleting it by hand re-runs the cleanup once — the
   documented way back if a removal went too far.

The reclaim is deliberately not a normalization pass: it is a deletion bounded
by "the value this plugin writes for this entry", and it is the only action in
the package that can remove user-visible data.

**Considered options**

- **Leave the leftovers in place (code-only removal).** Rejected: the values
  are the plugin's, not the user's, and after the upgrade they are
  indistinguishable in the UI from a deliberate choice — including the
  `["text", "image"]` over-declaration ADR-0002 explicitly recommended users
  correct by hand.
- **Run the reclaim on every boot instead of once.** Rejected: the rule is
  recomputed from the same two sources, so it stays true for a list the user
  writes *after* the upgrade whenever that list equals the computed value —
  `["text", "image"]` is precisely what the settings page writes for a model
  with no catalog twin, so every start would revert the user's own tick. A
  persisted marker is what makes the cleanup a migration rather than a policy.
- **Store the marker in the `llm-pi-ai` namespace, beside the data.** Rejected:
  impossible, and worth recording. The settings seam projects every write through
  the namespace's schema-declared volatile fields
  (`dsh-settings/lib/index.js:141-146`, `:515-529`); an undeclared key is dropped
  from the form and stripped from the document, so a marker written there would
  silently vanish and the deletion would re-arm on every boot. A plugin's own
  row config is the only namespace it may write, which is why this package now
  declares the harness's schema library as its one runtime dependency.
- **Write the marker to the filesystem** (a dotfile under the harness home or
  the plugin directory). Rejected: it needs a new injected path service or an
  environment read the package would otherwise not have, it puts cleanup state
  somewhere the user's settings document does not describe, and the profile's
  `node_modules` is replaced on upgrade. The settings row is also the place a
  user can see and reset the state.
- **Keep writing `input`, but stop defaulting it** (inherit only). Rejected: it
  duplicates what the settings page already shows as an inherited hint, and it
  would keep a plugin-owned override on the entry that the page's own inheritance
  path never overwrites — the exact confusion this change removes.
- **Reclaim by asking the UI.** Rejected: nothing records which values the page
  wrote versus which the plugin wrote; the plugin cannot call a client surface,
  and a user prompt for a cleanup they never asked for is worse than the
  bounded, documented removal above.

## Consequences

- A custom route's models resolve to the adapter's own rule again — text-only
  until a list is declared — so a model that was silently admitted images under
  0.2.x may now refuse them with `MODEL_DOES_NOT_SUPPORT_IMAGES` until 图片 is
  ticked on its row. That is the shipped behaviour for every route, the tick is
  one click away on the same card that edits the model, and the plugin no longer
  speaks for a model's input types at all.
- A hand-written list equal to the computed value is removed with the plugin's
  own. The document cannot tell the two apart, so the alternative is either to
  keep every user in a permission they may not have chosen, or not to reclaim at
  all. The README states this and the marker is resettable.
- The reclaim is one-shot and idempotent: a crash between planning and writing
  leaves a document that re-plans identically, and a clean document plans only
  the marker. A write refused for any reason is logged and retried on the next
  boot, because the marker is only committed together with the removal.
- `input` deletion can leave a route's `models` array restated in the patch
  document. The value is the array just read with the one field removed, so no
  other field, entry or key position changes.
- The package now has a runtime dependency (`@deepseek-ai/schemastery`, the
  harness's own schema library) and a config block on its row. Both exist only to
  make the one-shot marker possible and are pinned by
  `test/mount-check.mjs`.
- Reasoning-effort semantics are unchanged, so ADR-0001 remains the reference for
  everything this plugin still does: twin inheritance, the standard-set fallback,
  the `false` opt-out, the array-level `set` op, the unresolvable-route skip and
  the user-settings-layer scope.
