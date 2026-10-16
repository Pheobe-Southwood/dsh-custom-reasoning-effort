# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was initialized with 0.4.0, so the entries before it were reconstructed
from the repository history and record the change rather than a release run.

## [0.5.0] - 2026-10-16

### Fixed

- **The normalizer could disable itself permanently.** Its debounce was armed
  through `ctx.effect`, and any refusal — which the harness produces while a
  fiber is unloading during a live profile reload — set a `disposed` flag for the
  life of the instance. Every later settings change was then dropped in silence
  while the Loader still reported the row as `active`: a model added after that
  point never received `reasoningEfforts` and never appeared in the 推理等级 picker,
  which is the report this release answers (`gemini-4-argon`, added to a custom
  route whose six older models already carried the field). A refused trigger is
  now reported and retried by the other triggers instead of latching.
- **A round that failed or was skipped left no trace anywhere.** The plugin's
  `ctx.logger` output is dropped by a deployment that registers no logger
  exporter (this harness registers one only for boot diagnostics), so failures
  were invisible. Failures now also reach the console, are deduplicated per
  cause, and a committed write is verified by re-reading the document.

### Changed

- **The thinking levels come from [models.dev](https://models.dev), read live**,
  instead of being inherited from the installed catalog's same-id entry. The
  installed catalog is a models.dev snapshot frozen at harness build time, so a
  model released after that build had no entry to inherit from at all. One
  compressed request per boot (and a six-hour revalidation) builds an in-memory
  `Map<model id, levels>`; nothing is cached on disk.
- **An id several providers describe takes the union of their `effort` values**
  (with `off` always added), rather than requiring agreement and falling back to
  the standard set on a disagreement. `toggle` and `budget_tokens` entries name
  no level and are ignored; `none` maps onto `off`.
- **The standard seven-level set is now only the "no usable answer" fallback**,
  and `reasoningEfforts: false` is never written by the plugin: a model it cannot
  describe keeps its picker, and the user's own `false` remains the one durable
  per-model opt-out.
- **A reconcile tick (once a minute) re-runs the round with no event at all**, so
  a missed, coalesced or refused signal can no longer strand a model until the
  next restart.
- **An unreachable models.dev no longer waits forever**: while the first fetch is
  in flight the pass waits (instead of writing a value it is about to replace),
  and once a fetch has failed the standard set is written so the picker still
  appears, with retries backing off from 30 s to 15 min.

### Removed

- The `residualInputsReclaimed` marker and the one-shot `input` reclaim it gated
  (added in 0.3.0 for the values 0.2.x wrote, and superseded by the Models
  page's own 输入类型 field). The plugin now declares no `Config` and writes no
  namespace of its own, so an uninstall leaves no row override in the profile
  patch. Upgrading directly from 0.2.x keeps those `input` values; the Models
  page shows them as explicit per-model choices.
- The catalog-twin capability lookup and its `twinCapability`/agreement rules.

### Added

- `lib/modelsdev.js`: the models.dev index builder (pure) and the snapshot state
  machine (one in-memory snapshot, TTL, capped retry backoff, bounded response
  read).
- `scripts/cleanup.mjs` (`npm run cleanup`): the one-shot, dry-run-by-default
  command that removes this plugin's declarations and its retired marker row from
  one profile's patch document, preserving comments and key order.
- `test/modelsdev.test.mjs`, `test/cleanup.test.mjs`, and a rewritten
  `test/normalizer.test.mjs`/`test/round.test.mjs` — the latter including the
  regression that pins "a refused timer does not disable the plugin" and the tick
  that runs a pass with no event at all.
- [ADR-0005](docs/adr/0005-live-models-dev-levels-and-a-self-healing-round.md).

## [0.4.0] - 2026-10-09

### Added

- The `effort-memory` component: an in-package sub-package (`effort-memory/`,
  package `dsh-effort-memory`) that remembers the reasoning effort last actually in
  effect per `(provider, model)` route and re-issues one selection when a session
  switches back to a model that still advertises that level. Merged from the
  standalone `dsh-effort-memory` bundle; host-only, no client half, no runtime
  dependencies.
- Its own Loader row in `cordis.patch.yml` (id `effort-memory`), so the plugin panel
  switches it independently of the normalizer.
- The delivery mechanism that makes that row resolvable in a normal install:
  `effort-memory` and `scripts` in `files`, a root `postinstall`
  (`scripts/link-effort-memory-package.mjs`) that links the sub-package into the
  package's own `node_modules`, and the `dsh-effort-memory` peer declaration that
  makes DSH's dependency closure walk the edge.
- Panel metadata for the memory's row (`effort-memory/locale/{en,zh}.json`).
- `test/effort-memory.test.mjs` and `test/effort-memory-apply.test.mjs`: the
  component's pure rules, its packaging parity, and an integration suite driving the
  real `apply()` against a fake Cordis context.
- `test/packaging.test.mjs`: a real `npm pack`, extracted, with the install state
  reproduced inside the artifact — it asserts that the row's name is unresolvable
  before the postinstall runs and resolves to the in-package sub-package after.
- `.gitattributes` (`* text=auto eol=lf`), so the sub-package linked into the
  installed package cannot differ from the published one.

### Changed

- `test/mount-check.mjs` checks both rows, both host halves, the sub-package's
  manifest and locales, and pins the three delivery shapes that break an install.
- `README.md` and `CONTEXT.md` cover both components; the delivery shape and the
  install-time approval step it needs are documented, and
  `docs/adr/0004-ship-the-effort-memory-as-an-in-package-sub-package.md` records the
  decision together with the options it rejected.
- The package `description` and `keywords` now describe both components.

### Removed

- The standalone `dsh-effort-memory` bundle is superseded. A profile that lists both
  bundles cannot boot — both contribute the Loader row id `effort-memory`, and a
  repeated entry id is a Loader failure — so it must be removed before this version
  is installed. Its remembered levels are not lost: they live in the storage domain
  `effort_memory`, which the sub-package keeps unchanged.

## [0.3.0] - 2026-10-06

### Added

- A one-shot reclaim of the per-model `input` lists the 0.2.x releases wrote, gated
  by a marker (`residualInputsReclaimed`) in the plugin's own row config. Deleting
  the field re-runs the cleanup once on the next start.

### Changed

- Dropped the `input` backfill: DSH v0.2.0's Models settings page owns that field
  (输入类型) on the same model card, so the normalizer writes `reasoningEfforts`
  only.

## [0.2.0] - 2026-09-20

### Added

- Per-model `input` lists on custom-provider routes, so a route whose models are
  not in the installed catalog can still accept images. Superseded by 0.3.0.

## [0.1.0] - 2026-09-20

### Added

- The settings normalizer: per-model `reasoningEfforts` on custom-provider routes,
  so the composer's official 推理等级 picker appears for the models the
  添加自定义提供方 card adds.
