# 0004. Ship the effort memory as an in-package sub-package

Date: 2026-10-09
Status: accepted

## Context

This package gained a second, independent behaviour: a per-route reasoning-effort
memory, developed and released separately as `dsh-effort-memory`
(`github:cup113/dsh-effort-memory`). It watches `model/selection` records and
re-issues exactly one selection when a session's route changes back to a model
whose remembered level that model still advertises. It shares its subject with the
normalizer — the same `reasoningEfforts` field, the same 推理等级 picker — and
nothing else: no code, no service, no settings namespace, no persisted state in
the settings document.

Two questions had to be answered: should the two become one plugin, and if not,
how does a second Loader row reach a profile?

Rows are resolved through a runtime resolution table, not by the Loader alone.
For an out-of-tree bundle DSH builds that table by walking the `dependencies`
and then the `peerDependencies` of every selected bundle root, resolving each edge
from the manifest that declares it, anchored at that package's real directory
(`packages/boot/app-boot/src/profile.ts` — `dependencyClosure` and
`packageDirFromAnchor`, and `profileDependencyNames` is `dependencies` +
`peerDependencies`). `packageDirFromAnchor` is Node's own ancestor `node_modules`
search from `<packageDir>/package.json`, so a name is resolvable exactly when some
`<searchPath>/<name>/package.json` exists.

A row's name must, in addition, be a *bare package name*. `barePackageName()`
returns undefined for a specifier containing `/`, and `readPluginMeta()` returns
undefined for it, so a row named `dsh-custom-reasoning-effort/effort-memory` —
which Node itself would happily import through an exports map — would reach the
plugin panel as an unnamed component with no title, description or icon. Two rows
naming the same package are rejected as well (resolves from multiple Loader
sources), which rules out mounting both behaviours from one package name.

The worked-out reference for a second row inside one package is `dsh-pocket-oauth`'s
`mobile/` sub-package (`dsh-pocket-mobile`), whose delivery was established against
a real failing install (that repository's `AGENT-TASK.md`). It eliminated three
shapes, each for a measured reason:

- a committed `node_modules/<name>` link — pnpm drops a repository's
  `node_modules/**` when it packs a git-hosted package, so the link is gone
  before anyone can resolve it;
- `bundledDependencies` — pnpm records it as lockfile metadata and keeps the entry
  out of the dependency graph, so nothing ever installs the name;
- `dependencies: { "<name>": "file:./<dir>" }` — pnpm resolves a `file:` spec
  against the *profile* directory, where the directory does not exist, and the
  whole install fails with `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`.

What it landed on is the shape adopted here: ship the sub-package directory
through `files`, create `<packageRoot>/node_modules/<name> -> <packageRoot>/<dir>`
from a root `postinstall`, and keep `"<name>": "file:./<dir>"` in
`peerDependencies` — pnpm installs no peer, while DSH's closure walks peers, and
without the declaration the link can be present and the row still fails to import.
The cost is that pnpm 11 blocks dependency build scripts by default, so the first
install ends in a build-blocked failure until the user approves the script.

## Decision

Keep the two behaviours as two components of one package, delivered as an
in-package sub-package.

1. **`effort-memory/` is the sub-package `dsh-effort-memory`**: the unchanged host
   half (`index.js`, `decide.js`), its own manifest, and `locale/{en,zh}.json` for
   the panel row's title and description. It declares no `dsh.bundle` and no
   dependencies — this package's patch is the only place its row exists, and it
   imports nothing but its own sibling module.
2. **Both rows live in this package's `cordis.patch.yml`**, with the ids the two
   host halves already export (`custom-reasoning-effort`, `effort-memory`) and the
   names of the packages that ship them. Keeping the memory's id is deliberate: it
   is what the panel's per-row switch writes against, and it is the id the
   standalone bundle used.
3. **Delivery is the reference shape**, with each piece load-bearing: `files`
   ships `effort-memory` and `scripts`; `scripts/link-effort-memory-package.mjs`
   creates the in-package link and never fails; `peerDependencies` carries
   `"dsh-effort-memory": "file:./effort-memory"`. `dependencies`,
   `bundledDependencies` and `optionalDependencies` are all asserted absent,
   because each of them re-breaks the install.
4. **The sub-package version tracks the root version** and is asserted equal, so a
   release cannot ship a stale one.
5. **The standalone `dsh-effort-memory` bundle and this package are mutually
   exclusive.** Its patch inserts the same `effort-memory` row id, and a repeated
   Loader entry id is a boot failure, not a harmless duplicate. The README states
   it as an upgrade step, and the row-id collision is the reason the id was kept
   rather than renamed: renaming it would trade a loud, documented conflict for a
   silent double mount.

## Considered options

- **Fold the memory into the normalizer's single row (one row, one plugin).**
  Rejected, though it is the cheapest delivery: no sub-package, no postinstall, no
  build-script approval, no second row that can sit at Not running. It would fuse
  two components with disjoint state and failure modes — a settings normalizer
  that can delete data on one code path, and an event observer that must never
  fail a turn — into one switch, so a user could no longer turn the memory off
  while keeping the backfill, which is the pairing the two plugins already shipped
  in the field. The panel is where that choice belongs, and a row is the only
  granularity it offers.
- **Keep two independent packages, each installed with its own `dsh plugin add`.**
  Rejected: it is not a merge. Two commands, two upgrade paths, two specs to keep
  in step, and nothing that fails when only one is installed — while the two
  components are useless apart in the common case (a remembered level the model no
  longer advertises is the state the normalizer prevents).
- **Publish `dsh-effort-memory` to the npm registry and depend on it.** Rejected:
  this package is installed from git, and a registry dependency would either pin
  two artifacts that must stay compatible or add a publish path this repository
  does not have (and the standalone bundle is `private: true`). It also does not
  address the peer/graph requirement: the name still has to be resolvable from
  this package's anchor.
- **A row name that is a subpath of this package.** Rejected on the resolution
  contract above: Node would import it, DSH would not describe it. A subpath
  specifier resolves to no package for panel metadata, so the assembler would
  render a nameless component.
- **Both rows named after this package.** Rejected: DSH rejects two rows that
  resolve from multiple Loader sources, and it is the same collision that makes
  the standalone bundle incompatible.
- **A committed `node_modules/dsh-effort-memory` link, or `bundledDependencies`,
  or a `file:` `dependencies` entry.** Rejected: each is a measured install
  failure or a silent no-op, per the reference above. All three are pinned as
  regressions in `test/mount-check.mjs`.
- **A `prepare`-time copy into a packed `node_modules/`.** Rejected: npm and pnpm
  exclude `node_modules/**` from a packed artifact unconditionally, except for
  entries `bundledDependencies` names — which is exactly the shape that was
  measured not to work.

## Consequences

- **An installation needs one extra user step, once.** pnpm 11 blocks dependency
  build scripts by default, so the first `dsh plugin --profile <name> add` ends in
  a build-blocked failure; approving the script (the plugin panel's allow-and-retry,
  or an `allowBuilds` entry) and re-running the same command creates the link. The
  link never fails the installation — when it cannot be created the script warns
  and exits 0 — but the memory row then sits at Not running, exactly as the
  reference's `dsh-pocket-mobile` row once did.
- **The row is `required: false` by construction.** A missing sub-package costs
  the memory, never the normalizer, and the boot audit names only the row.
- **Existing users of the standalone `dsh-effort-memory` must remove it.** A
  profile that lists both bundles cannot boot (repeated entry id), which the README
  states as the first upgrade step. The memory's own persisted state is untouched
  by the move: the storage domain name (`effort_memory`) and the file it lands in
  (`$DSH_HOME/storages/effort_memory.json`) are the sub-package's, and the
  sub-package keeps them byte for byte.
- **A packaging defect here is now testable without a live profile.**
  `test/packaging.test.mjs` packs the real artifact, replicates the install inside
  the extracted package, and resolves the row's name with the same primitive DSH
  uses; it asserts the resolution is impossible before the postinstall runs and
  possible after. The shape it guards — `files` entries, the peer declaration, the
  one postinstall — is reproduced from the reference implementation rather than
  re-derived, so a future change that looks reasonable but reverts one of them
  fails a test instead of an install.
- **One more row has to be described.** The panel card now reports two components,
  both switchable, and the sub-package's `locale/` dictionaries are what give the
  memory's row a title and a description rather than a bare package name.
