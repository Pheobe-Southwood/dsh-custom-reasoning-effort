# dsh-custom-reasoning-effort

A reasoning-effort toolkit for DeepSeek Harness (dsh): one package, two
independently switchable, host-only components.

| Component | What it does | Without it |
|---|---|---|
| `custom-reasoning-effort` | Fills the per-model `reasoningEfforts` of custom-provider routes with the levels **models.dev** declares for that model id, so the composer's official 推理等级 picker appears | A model added through 添加自定义提供方 offers no levels at all |
| `effort-memory` | Remembers the level each `(provider, model)` route was last left on, and re-issues it when a session switches back to that model | Every model switch lands on the new model's default, and the level you left behind is not restored |

Neither component ships a client half, a slot or any UI, neither registers a
service, and neither calls an LLM. They are two Loader rows of one bundle, so the
plugin panel switches them separately — see
[part two](#part-two--the-effort-memory) for the `effort-memory` row, which is an
in-package sub-package delivered with this package and never installed on its own.

## Part one — the settings normalizer

Fill the per-model reasoning-effort metadata of custom DeepSeek Harness (dsh) LLM
provider routes: the levels the composer's official 推理等级 picker needs. A model
added through 添加自定义提供方 then behaves like the same model added through
添加提供方.

The normalizer writes the per-model `reasoningEfforts` field the `llm-pi-ai`
schema already accepts, and lets the shipped pipeline — settings → model catalog
→ picker → `reasoning_effort` on the wire — do the rest. It ships **no client
half and no custom UI**, and it never calls an LLM itself. The level sets come
from **[models.dev](https://models.dev)**, fetched live; the installed harness
catalog is not consulted (see [The problem](#the-problem)).

Input modalities are deliberately **not** this plugin's business: since dsh
v0.2.0 the Models settings page renders a 输入类型 field (文本 / 图片) on every
model row of a custom route and writes the adapter's own per-model `input` list,
so that capability has an owner and a one-click answer. This plugin neither reads
nor writes that field, and the one-shot cleanup its 0.2.x/0.3.x/0.4.x releases
performed for it is gone — see
[Upgrading from 0.4.0 or earlier](#upgrading-from-040-or-earlier) and
[Uninstalling](#uninstalling-and-leaving-nothing-behind).

## The problem

A model added through **Settings → Models → 添加自定义提供方** never shows the
composer's 推理等级 picker, while the same model added through **添加提供方**
does.

1. **Reasoning metadata cannot be inherited across routes.** The adapter
   resolves a model's reasoning capability per **provider route**: a model
   without its own declaration ends up with `reasoning: base?.reasoning ?? false`,
   where `base` is the installed catalog entry **of that same id on that same
   route**. The builtin catalog is keyed by provider route, so a custom route —
   a route key that appears nowhere in the builtin catalog — has nothing to
   inherit from. An identical model id under a builtin route and under a custom
   route are, for this lookup, unrelated.
2. **The custom-provider card never writes the alternative.** The only other
   lawful source of a model's reasoning capability is the per-model
   `reasoningEfforts` field on the route's own model entry. The custom-provider
   card collects the id and the connection facts and leaves that field absent,
   so a custom route's models have neither an inherited capability nor a
   declared one.
3. **The builtin catalog is a frozen snapshot.** dsh's catalog is generated from
   models.dev when the harness is built and then pinned to that build, so a model
   released afterwards has no entry at all — the earlier releases of this plugin
   had nothing to inherit for it — and a model whose gateway semantics changed
   keeps its build-time levels. That is why the level set is read from models.dev
   directly: 4092 model ids as of this writing, refreshed per boot and every six
   hours, rather than whenever the harness happens to be upgraded.

With neither source present, resolution yields `reasoning: false`, the model
catalog entry carries no reasoning, and the official picker stays hidden
(`当前模型未提供推理等级`) — even for a model id that is reasoning-capable
everywhere else. The workaround is to hand-edit the persisted settings and add
the field to every model, and to remember to do it again for every model added
later.

## What the plugin does

On every start, on every settings change, and on every reconcile tick the
normalizer walks the persisted `llm-pi-ai` settings and, for each
**custom-provider route** (a provider route key that is not in the builtin
catalog), brings every model up to date:

- **A level set models.dev declares.** Every provider's `reasoning_options` entry
  of type `effort` names the wire values that provider accepts
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The union of every
  provider's declaration for the id becomes the model's level set — the live
  example: `gemini-4-argon` is `low/medium/high` on google, `none/low/medium/high/
  max` on requesty and `high` alone on llmgateway, and the union of the three is
  what the picker offers. A custom route names no upstream provider, so no single
  declaration is *the* truth for it, and the union is the reading that cannot
  hide a level the model does support. `off` is always added, because it maps to
  sending no reasoning parameter at all, which every endpoint tolerates.
- **Otherwise, the standard seven-level set.** An id models.dev does not describe
  — or describes only with a `toggle` (on/off thinking, no levels), a
  `budget_tokens` entry, or nothing at all — gets the standard pi-ai
  thinking-level set, the same level vocabulary the harness's own
  reasoning-effort handling is written against. It is the honest answer for
  "unknown": the picker appears, and the value is *not* an assertion about the
  model.
- **A model carrying the explicit `reasoningEfforts: false`** is a judgement and
  is left alone. Nothing else is ever written as `false`: a model this plugin
  cannot describe must not lose a picker it may deserve.

Only routes the user's own settings layer declares are considered: a route that
exists only in a composition base layer is left alone. Nothing else is touched
either — no route the installed catalog ships is rewritten, no model id,
no connection field and no per-model `input` list is changed, and a model whose
stored value already equals the computed one is left exactly as it is. The write
itself is one `set` per affected route and it replaces that route's whole
`models` array, because the shipped settings applier cannot address an element
inside an array; the value is the array that was just read with only
`reasoningEfforts` filled in, so no other model field and no other route field
is restated or dropped.

A custom route the `llm` service reports as **unresolvable** — its directory
entry carries an error, so the adapter cannot resolve its profile — is left
alone for that round. One op restates a route's whole `models` array and the
settings seam validates the whole profile of every write, so planning over such
a route would have the seam reject the round's entire write and starve the
healthy routes of a pass they have no event left to retry from. The set of
unresolvable routes is recomputed on every round, so repairing a route is enough
for the next pass to normalize it. Every round warns about the routes it skipped
— including a round that writes nothing, which is the shape a permanently
unresolvable route produces — so the route to repair is named instead of quietly
staying unfilled.

The existing catalog refresh then rebuilds the model catalog with `reasoning`
present, so the official picker simply appears — there is no second picker, no
Slot replacement and no patched service. The effort a user selects travels the
existing request path unchanged and is dispatched as the `reasoning_effort`
request parameter, exactly as it is for a builtin-route model.

### Why it runs three ways, and never gives up

The level sets arrive asynchronously and the document is rewritten by the shipped
settings page, by this plugin and by the user, so the plugin is built around three
triggers and one rule:

- `settings/document-updated` for the `llm-pi-ai` namespace and
  `llm/adapters-updated` arm a debounced (250 ms) round, because one settings
  write announces itself several times and a provider card lands model by model.
- A **reconcile tick** (once a minute) re-runs the round with no event at all,
  and is also what refreshes a stale models.dev snapshot. Events can be missed,
  coalesced or refused; the tick cannot be.
- A refused trigger is *reported*, never latched. The 0.4.0 release armed its
  debounce through `ctx.effect` and, on any refusal, set a flag for the life of
  the instance; the harness hot-reloads the profile patch on every settings write,
  so a single refusal in that window silenced the plugin permanently while its row
  still read `active`. A model added after that point — `gemini-4-argon` was the
  one that surfaced it — got no picker and no diagnostic, while its older siblings
  kept the levels an earlier boot had written. See
  [ADR-0005](docs/adr/0005-live-models-dev-levels-and-a-self-healing-round.md).
- After a committed write the plugin **re-reads and re-plans** to confirm the
  document actually holds the value, and reports the mismatch if it does not.
  Findings are deduplicated per cause, so a permanent condition is reported once
  rather than once per tick — and every failure goes to the harness logger *and*
  to the console, because a deployment that registers no logger exporter (this
  harness registers one only for boot diagnostics) would otherwise swallow it.

## Semantics

- **`reasoningEfforts` is recomputed and overwritten on every round.** The filled
  values are derived state, not user state: any stored value other than the
  `false` opt-out — including a level list someone wrote by hand — is replaced
  when it disagrees with the computation. Declaring a level list by hand is
  therefore not durable; `false` is.
- **An explicit `reasoningEfforts: false` is an opt-out and is never
  overwritten.** Declaring a model non-reasoning is a decision, not a gap, so it
  survives every normalization pass. A declared level list is not an opt-out —
  the field is derived state, and only `false` is treated as a judgement.
- **`input` is not read, written or restated.** The per-model modality list is
  owned by the Models settings page, which writes the adapter's own field
  (`input` for pi-ai routes, `inputModalities` for the DeepSeek catalog). A list
  already on the entry is carried through verbatim, key order included, and a
  model without one does not gain one. What a route resolves to when no list is
  declared is the adapter's own inheritance rule
  (`declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`), not
  anything this plugin decides.
- **Levels keep the level name as the wire spelling.** `low` is sent as `low`,
  and `off` is written as `off: null`, "supported, send nothing", which is the
  safe generic equivalent on any endpoint rather than a provider-specific
  spelling like xAI's `off: 'none'`.
- **Only the affected route's `models` list is written, one `set` per route.**
  That path is array-level because the shipped settings applier cannot descend
  into arrays, and the value is the array with nothing changed but the missing
  capability field. The plugin never rewrites a profile, a route key, or another
  namespace — it declares no `Config` of its own and writes no marker anywhere —
  and it writes nothing at all when the computed values are already in place.
- **An unreachable models.dev does not blind the plugin and does not flap the
  document.** While a fetch is in flight the round waits (writing the standard
  set and then replacing it a moment later would be a pointless rewrite); if the
  fetch fails, the standard set is written so the picker still appears, the
  failure is reported once, and a retry is scheduled with exponential backoff
  (30 s doubling to 15 min). A successful fetch replaces the snapshot wholesale,
  in memory only.

## Uninstalling, and leaving nothing behind

Nothing this plugin persists lives outside the `llm-pi-ai` settings section, and
it now writes to no namespace of its own: with no `Config` and no migration
marker, an uninstall leaves no row override in the profile patch (a 0.4.0-era
marker row is the one exception, and the command below removes it).

The level declarations it wrote are the one thing that cannot remove themselves —
the plugin is gone by then — so the package ships a one-shot command that does it:

```bash
# with the harness stopped: a running instance may rewrite the file from memory
node node_modules/dsh-custom-reasoning-effort/scripts/cleanup.mjs --profile web          # dry run
node node_modules/dsh-custom-reasoning-effort/scripts/cleanup.mjs --profile web --write   # apply
```

It removes exactly two things: the `reasoningEfforts` declarations this plugin
wrote (every level spelled as its own name, `off` as `null` — a hand-written
level set with any other spelling, and the `false` opt-out, are left alone), and
its own row in the profile patch when that row carries nothing but the retired
0.4.0 marker. Comments, key order, connection facts, modality lists and every
other field survive; `--json` reports the same facts for scripting. Without the
command, the leftover declarations are inert: they are schema-legal values in the
adapter's own section, so the file stays valid and the picker keeps working after
the plugin is removed.

## Upgrading from 0.4.0 or earlier

- **0.2.x** filled each custom-route model's `input` list, because nothing in the
  product wrote that field yet. **0.3.0 and 0.4.0** reclaimed those leftovers once
  under a `residualInputsReclaimed` marker in this plugin's own row config. Both
  are gone: the Models page owns the field now, and the marker was the plugin's
  only write outside `llm-pi-ai`. The marker row is inert where it still exists —
  the plugin ignores an undeclared config object — and
  `scripts/cleanup.mjs` removes it together with the level declarations.
- **Level sets change on this upgrade, and that is the point.** Models are
  rewritten from the standard seven-level set to whatever models.dev declares for
  them, which is often fewer levels: an id nobody describes keeps all seven, while
  an id declared as `low/medium/high` everywhere shows exactly those three. If a
  session is sitting on a level a model no longer offers, the next request for
  that model is rejected by the adapter's own validation
  (`resolveCallConfig`: "unsupported explicit efforts reject before provider
  I/O") — pick another level, or opt the model out with
  `reasoningEfforts: false` from [Opting a model out](#opting-a-model-out).
- **models.dev is consulted at every boot**, which is one compressed request
  (~0.4 MB of a ~5.7 MB document) when the profile has at least one custom-route
  model, and never otherwise. A profile with no custom routes performs no
  network I/O at all.

## Install

**One command installs and mounts the plugin:**

```bash
dsh plugin --profile web add github:Pheobe-Southwood/dsh-custom-reasoning-effort
```

The profile flag belongs to the `plugin` subcommand, which is why it goes after
`plugin` and not before it: `dsh --profile web plugin add …` is rejected with
`required option '--profile <name>' not specified`, because the launcher's own
`--profile` is not the subcommand's. After `plugin`, the flag selects the profile
and is consumed there — pnpm receives only the remaining arguments — so
`dsh plugin --profile web add <spec>` and `dsh plugin add <spec> --profile web`
install into the same profile. There is no environment variable that selects a
default profile.

Then restart the profile's dsh process once — stop the running
`dsh --profile web` (or `dsh web`) and start it again. The restart is required,
not a formality: `dsh plugin` only writes the reconciled bundle list to disk,
while the boot sequence reads `dsh.profile.bundles` once and snapshots every
bundle's patch layer, and live patch reload re-reads the profile and home patch
files over that same boot snapshot — so a bundle installed afterwards joins the
tree on the next start.

The bundle list itself needs no second step: this package declares
`dsh.bundle.patch` in `package.json`, so the dsh CLI's reconcile step appends it
to the profile's `dsh.profile.bundles`, and the package's own `cordis.patch.yml`
contributes **both** plugin rows.

The `effort-memory` row does need one approval. Its code is the in-package
sub-package `effort-memory/`, and the link that makes its package name resolvable
is created by this package's `postinstall`
(`scripts/link-effort-memory-package.mjs`). pnpm 11 blocks dependency build scripts
by default, so on a pnpm-managed profile the first `add` ends in a build-blocked
failure (`ERR_PNPM_IGNORED_BUILDS`; the plugin panel reports it with an
allow-and-retry action). Approve the script — the panel's **allow these scripts and
retry**, or an `allowBuilds` entry in the profile's `pnpm-workspace.yaml` — and
re-run the same `add` command: the link is created on that run and follows the
profile from then on. Skipping it costs only the memory, never the normalizer: the
memory's row is mounted as optional and stays at **Not running**, and the boot
audit names that row alone.

### Other install shapes

The argument after `add` is a pnpm dependency spec, forwarded verbatim, so every
spec form pnpm accepts works — the GitHub shorthand, a git URL, a local
checkout, or a packed tarball:

```bash
dsh plugin --profile web add github:Pheobe-Southwood/dsh-custom-reasoning-effort
dsh plugin --profile web add git+https://github.com/Pheobe-Southwood/dsh-custom-reasoning-effort.git
dsh plugin --profile web add link:/path/to/dsh-custom-reasoning-effort
npm pack && dsh plugin --profile web add ./dsh-custom-reasoning-effort-0.5.0.tgz
```

`dsh plugin` initializes a profile that does not exist yet, runs pnpm inside the
profile directory (so pnpm must be on `PATH`), then reconciles the bundle list
against what is actually installed: a dependency declaring `dsh.bundle` joins
`dsh.profile.bundles`, and one that does not is installed with a warning and
never becomes a layer. This package ships built `lib/`, so no install-time *build*
is involved; its one `postinstall` only creates the sub-package link described
above, which is why approving it is the whole install-time step. A git-hosted
plugin that compiles on install needs its key under `allowBuilds` in the profile's
`pnpm-workspace.yaml` before the command can succeed.

Uninstall is symmetric — reconcile also drops the bundle from
`dsh.profile.bundles`:

```bash
dsh plugin --profile web remove dsh-custom-reasoning-effort
```

**Coming from the standalone `dsh-effort-memory` bundle? Remove it first.** Both
bundles contribute a Loader row with the id `effort-memory`, and the Loader rejects
a repeated entry id, so a profile that lists both cannot boot:

```bash
dsh plugin --profile web remove dsh-effort-memory
dsh plugin --profile web add github:Pheobe-Southwood/dsh-custom-reasoning-effort
```

Nothing remembered is lost in the move: the levels live in the storage domain
`effort_memory`, which the sub-package keeps unchanged.

The level declarations the normalizer filled stay in the settings document until
you remove them, because only your own document can hold them — a running plugin
cannot clean up after it is gone. Run the bundled one-shot command with the
harness stopped to take them back out (and to drop the retired 0.4.0 marker row
if it is still there):

```bash
node node_modules/dsh-custom-reasoning-effort/scripts/cleanup.mjs --profile web --write
```

Left in place they are inert: schema-legal values in the adapter's own settings
section, so the file stays valid and the picker keeps working. See
[Uninstalling](#uninstalling-and-leaving-nothing-behind).

**Do not hand-edit the profile's `cordis.patch.yml`** — the package already ships
both rows, and a second copy of either is not a harmless duplicate: the Loader
rejects a repeated entry id and the next boot fails loudly with

```text
duplicate loader entry id: custom-reasoning-effort
duplicate loader entry id: effort-memory
```

## Opting a model out

A model is opted out of the picker by writing the value instead of computing it,
in the settings document:

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      models:
        - id: my-embedding-model
          reasoningEfforts: false
```

`reasoningEfforts: false` keeps the model out of the 推理等级 picker, and the
normalizer never overwrites it, so the declaration is respected on every later
run. A hand-written level list is *not* an opt-out: the field is derived state,
and only `false` is a judgement.

Because a hand-written level list is recomputed, `false` is the only durable
per-model reasoning declaration: a model whose models.dev levels the picker
offers more widely than the endpoint accepts is opted out model by model rather
than pinned to a shorter list. Input types have no such sentinel and need none —
the Models page's 输入类型 checkboxes are the declaration, and this plugin does not
touch the field.

## Part two — the effort memory

The second component remembers the reasoning effort **last actually in effect** on
each `(provider, model)` route and restores it when a session switches back to that
model. It is the in-package sub-package `effort-memory/` (`dsh-effort-memory`),
mounted by its own Loader row and switchable on its own.

### The problem

The composer's model seat renders the effort from the durable `modelSelection`
projection. Picking a *different* model sends that model's own `defaultEffort`
(`dsh-client-ui-model-selection/lib/client.js:427,883`), and the host resolver
materializes the adapter default when a caller omits an effort
(`dsh-llm/lib/index.js:2116-2130`). A model switch always lands on the new model's
default, so the level you had chosen on the model you left is not restored when you
come back.

### What the memory does

1. The memory key is `(provider, model)`; the value is the effort id that was last
   in effect on that route.
2. On a route change `A -> B` it remembers `A`'s effort, and then:
   - if `B` has a remembered effort **and** `B` currently advertises it, it
     re-issues exactly one selection through `ctx.sessionController.selectModel(...)`,
     so the session's durable selection becomes `{ B, that effort }`;
   - otherwise it does nothing and `B` keeps its own default. A first visit to a
     never-used model therefore lands on that model's default.
3. A route change is recognized across a restart too: each session's pre-switch
   route is seeded from the durable `modelSelection` projection at
   `session/created` — attach time, while that projection still reflects the stored
   log alone. Reading the seed from inside the event handler would be vacuous:
   `stateOf` materializes at the session's current cursor, which by then already
   includes the event being handled.
4. A target model that declares no reasoning capability (resolved `reasoning`
   missing, or `reasoningEfforts: false` in settings) gets no `reasoningEffort` and
   no error.
5. A remembered effort the target no longer advertises — for example rewritten by
   part one — falls back to the model's default silently, with no retry.
6. Effort-only changes on the model already selected are never touched.

### Design constraints

- **Host half only.** No `client.js`, no slot, no React, no UI.
- **One lever.** `ctx.sessionController.selectModel` — the same public command
  interface the GUI calls. The memory never appends session events itself and never
  rewrites in-memory selection state.
- **Capability first.** `ctx.llm.resolveModelInfo(provider, model)` is consulted
  before any re-issue, because `selectModel` throws
  `UNSUPPORTED_REASONING_EFFORT` for a level the target does not advertise.
- **Loop-safe.** Only a *route change* can trigger a re-issue, only when the
  event's effort differs from the remembered one, and the re-issue keeps the same
  route — so the event it produces cannot re-enter the rule as a change.
- **Replay-safe.** Constructor seeds (replay, fork, resume) never publish on the
  `session/event` firehose; a `seq < session.firstLiveSeq` guard is kept as
  belt-and-braces.
- **No services, no settings, no retries.** Any failure is logged and skipped;
  nothing is ever surfaced to the user.
- **No runtime dependencies at all.** The storage-domain declaration is inlined —
  `defineDomain`/`domainTable` are identity wrappers and the runtime only calls
  `valueSchema.parse(raw)` — and the component imports nothing but its own sibling
  module. That is also what lets it be delivered as a plain directory inside this
  package.

### Persistence

- Domain `effort_memory`, table `efforts`, key `JSON.stringify([provider, model])`,
  record `{ reasoningEffort }`.
- The domain name must match `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`, which forbids
  the hyphen — hence the domain is `effort_memory` while the package, the row id
  and the exported plugin name all stay `effort-memory`.
- With the base storage stack mounted, the `single`-layout document lands at
  `$DSH_HOME/storages/effort_memory.json` and survives restarts.
- Without `ctx.storageDomain`, memory degrades to a process-local `Map` (one
  warning is logged at apply time) and is lost on restart.
- Upgrading from the standalone `dsh-effort-memory` bundle keeps this state: the
  domain name and the file it lands in are the sub-package's and are unchanged.

### How the memory is delivered

The row's `name` has to resolve to a *package* from this package's own directory,
because that is where DSH anchors the lookup (`packageDirFromAnchor` in
`@deepseek-ai/dsh-app-boot` probes the require resolution paths of the declaring
package's `package.json`). Three delivery shapes do not survive an install, and all
three are pinned as regressions by `test/mount-check.mjs`:

- a `node_modules/dsh-effort-memory` link committed to the repository — pnpm drops
  a repository's `node_modules/**` when it packs a git-hosted package;
- `bundledDependencies` — recorded as lockfile metadata and kept out of the
  dependency graph, so nothing installs the name;
- `"dsh-effort-memory": "file:./effort-memory"` in `dependencies` — pnpm resolves a
  `file:` spec against the *profile* directory, where no `effort-memory/` exists,
  and the whole install fails with `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`.

So the sub-package is delivered from inside this package:

| Piece | Role |
|---|---|
| `files: [… "effort-memory", "scripts" …]` | ships the sub-package directory and the link script in the artifact |
| `peerDependencies: { "dsh-effort-memory": "file:./effort-memory" }` | pnpm installs no peer, but DSH's dependency closure walks `dependencies` **and** `peerDependencies`: without this edge the link can be present and the row still fails to import |
| `scripts/link-effort-memory-package.mjs` (the root `postinstall`) | creates `<package root>/node_modules/dsh-effort-memory -> <package root>/effort-memory` inside the installed package. It falls back to a copy, and then to a warning, but never fails the install |

`test/packaging.test.mjs` proves this on a real `npm pack` artifact: it extracts
the tarball, asserts the row's name does **not** resolve before that postinstall
runs, and that it resolves to the in-package sub-package afterwards.

### Known limitations

1. One settings write per switch is performed by the public `selectModel` path
   itself (`agentDefaultModel.saveSelection` →
   `settings.replace('agent-default-model', …)`). The memory adds no settings
   namespace and no settings write of its own.
2. Memory is global per `(provider, model)` — shared by every session and
   workspace.
3. The memory acts on every live session whose route changes, subagent sessions
   included.
4. Without `ctx.sessionProjections` there is no attach-time seed, so a session's
   first switch after a restart only establishes a baseline and is not restored;
   every later switch in the same process is.
5. A stale remembered level is kept (harmless): if a model's effort table later
   regains that level, it is restored again.
6. Single-process visibility only; `domain/changed` does not cross processes.

## Development

```bash
npm install        # devDependencies, plus the one runtime dependency (the cleanup command's YAML editor)
npm run check      # lint + tests + pack dry run
npm test           # unit tests and the bundle mount check
npm run test:mount # the mount check alone
npm run cleanup    # the uninstall cleanup command, against --profile-dir or DSH_PROFILE
```

`npm install` also runs this package's own `postinstall`, so the sub-package link
exists in the checkout. `npm pack` runs neither `postinstall` nor `prepare` here
(npm's pack lifecycle is `prepack` → `prepare` → `postpack`), which is why the
packaging test reproduces the link itself inside the extracted artifact.

In a confined sandbox `npm run test:host` (`node --test test/*.test.mjs`) cannot
run: the runner starts one child process per file with piped stdio, which such a
sandbox refuses with `spawn EPERM`. The same suites run in-process:

```bash
node --test --test-isolation=none "test/*.test.mjs"
```

| Path | Role |
|---|---|
| `lib/` | Part one's host half (`index.js`), its live capability source (`modelsdev.js`) and its pure planning rules (`normalize.js`) |
| `effort-memory/` | The sub-package `dsh-effort-memory`: `index.js` (event half), `decide.js` (pure rules), `locale/` (the panel row's title and description) |
| `cordis.patch.yml` | Both Loader rows — the only place either is declared |
| `scripts/link-effort-memory-package.mjs` | The root `postinstall` that links the sub-package into this package's `node_modules` |
| `scripts/cleanup.mjs` | The one-shot uninstall cleanup: removes what this plugin wrote into one profile's patch document |
| `test/` | Unit suites, the bundle mount check and the packaging test |
| `docs/adr/` | The decisions, including [ADR-0005](docs/adr/0005-live-models-dev-levels-and-a-self-healing-round.md) for the level source and the round, and [ADR-0004](docs/adr/0004-ship-the-effort-memory-as-an-in-package-sub-package.md) for the delivery shape |

## License

MIT — see `LICENSE`. The `effort-memory` component was merged in from the
standalone `dsh-effort-memory` bundle (`github:cup113/dsh-effort-memory`, MIT,
© 2026 Jason Li) and keeps that provenance; its code is unchanged apart from the
packaging and the comments that documented the old delivery.

The reasoning-effort semantics this package depends on are the harness's own,
documented by the ADRs in
`docs/adr/0001-settings-normalization-for-custom-provider-reasoning-effort.md`,
`docs/adr/0002-input-modality-backfill-for-custom-provider-routes.md` (superseded),
`docs/adr/0003-hand-input-modalities-to-the-settings-page.md`,
[ADR-0004](docs/adr/0004-ship-the-effort-memory-as-an-in-package-sub-package.md)
and [ADR-0005](docs/adr/0005-live-models-dev-levels-and-a-self-healing-round.md).
Model-level facts come from [models.dev](https://models.dev), which is MIT-licensed
and unaffiliated with this package; only its public `api.json` is read.
