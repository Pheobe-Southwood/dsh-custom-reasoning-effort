# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was initialized with 0.4.0, so the entries before it were reconstructed
from the repository history and record the change rather than a release run.

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
