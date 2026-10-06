# dsh-custom-reasoning-effort

Backfill the per-model reasoning-effort metadata of custom DeepSeek Harness
(dsh) LLM provider routes: the levels the composer's official 推理等级 picker
needs. A model added through 添加自定义提供方 then behaves like the same model
added through 添加提供方.

The plugin is a host-side settings normalizer: it writes the per-model
`reasoningEfforts` field the `llm-pi-ai` schema already accepts, and lets the
shipped pipeline — settings → model catalog → picker → `reasoning_effort` on the
wire — do the rest. It ships **no client half and no custom UI**, and it never
calls an LLM itself.

Input modalities are deliberately **not** this plugin's business: since dsh
v0.2.0 the Models settings page renders a 输入类型 field (文本 / 图片) on every
model row of a custom route and writes the adapter's own per-model `input` list,
so that capability has an owner and a one-click answer. The only thing this
plugin still does with `input` is a one-shot cleanup of the values its own 0.2.x
releases wrote into your settings — see [Upgrading from 0.2.x](#upgrading-from-02x).

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

With neither source present, resolution yields `reasoning: false`, the model
catalog entry carries no reasoning, and the official picker stays hidden
(`当前模型未提供推理等级`) — even for a model id that is reasoning-capable
everywhere else. The workaround is to hand-edit the persisted settings and add
the field to every model, and to remember to do it again for every model added
later.

## What the plugin does

On every start and on every settings change the normalizer walks the persisted
`llm-pi-ai` settings and, for each **custom-provider route** (a provider route
key that is not in the builtin catalog), brings every model up to date:

- **Same-id builtin twin.** If the builtin catalog has an entry with that model
  id, its capability is inherited, level for level, including a `reasoning:
  false` twin (a non-reasoning builtin model stays non-reasoning under the
  custom route rather than silently gaining levels); a twin whose only offered
  level is `off` has no expressible level list and is declared non-reasoning for
  the same reason. When several catalog routes describe the same id and
  disagree, that id names different models in different places and no single
  capability is a fact, so the standard set is used instead.
- **Otherwise.** The model gets the standard seven-level pi-ai thinking-level
  set, the same level vocabulary the harness's own reasoning-effort handling is
  written against. A model carrying the explicit `reasoningEfforts: false` is a
  judgement and is left alone.

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
unresolvable route produces — so the route to repair is named in the log instead
of quietly staying unfilled.

The existing catalog refresh then rebuilds the model catalog with `reasoning`
present, so the official picker simply appears — there is no second picker, no
Slot replacement and no patched service. The effort a user selects travels the
existing request path unchanged and is dispatched as the `reasoning_effort`
request parameter, exactly as it is for a builtin-route model.

## Semantics

- **`reasoningEfforts` is recomputed and overwritten on every start and every
  settings change.** The filled values are derived state, not user state: any
  stored value other than the `false` opt-out — including a level list someone
  wrote by hand — is replaced when it disagrees with the computation.
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
- **Inherited levels keep the level name as the wire spelling.** The inherited
  list reproduces exactly the levels the twin offers — the catalog's own
  `reasoning` object comes out identical — but a vendor-specific spelling a
  catalog model may carry internally is not reproduced. `off` is therefore
  written as `off: null`, "supported, send nothing", which is the safe generic
  equivalent on any endpoint, rather than xAI's `off: 'none'` or a
  provider-specific value.
- **Only the affected route's `models` list is written, one `set` per route.**
  That path is array-level because the shipped settings applier cannot descend
  into arrays, and the value is the array with nothing changed but the missing
  capability field. The plugin never rewrites a profile, a route key, or another
  namespace, and it writes nothing at all when the computed values are already in
  place.
- **Uninstalling (`dsh plugin --profile <name> remove
  dsh-custom-reasoning-effort`) leaves the filled fields in the settings
  document.** They are schema-legal values in the adapter's own section, so the
  file stays valid and the picker keeps working after the plugin is removed; the
  plugin does not rewrite settings on the way out. This is an accepted
  trade-off — see the ADRs below.

## Upgrading from 0.2.x

The 0.2.x releases also filled the per-model `input` list on every custom-route
model, because nothing in the product wrote that field yet. dsh v0.2.0's Models
page does, so this plugin stopped — and going away silently would have left those
values behind as per-model overrides the settings page dutifully shows and
honours.

The first start on this release therefore **reclaims them, once** — a fresh
install runs the same rule, finds nothing to reclaim, and records that the
cleanup is done. The plugin's own row ships with an empty `config: {}`; the start
that performs the cleanup fills it in:

- A stored `input` list is removed only when it is exactly the value the 0.2.x
  release would have written for that model: the list its same-id catalog twin
  states, or the `["text", "image"]` fallback when no twin states one. Any other
  list is left exactly as it stands — including a narrower one you wrote
  yourself. (A hand-written list that happens to equal the computed value is
  indistinguishable from the plugin's own and is removed too; that is the one
  cost of a cleanup the plugin's removal cannot perform.)
- Catalog routes are never swept: the 0.2.x release never wrote there.
- The removal is recorded in this plugin's own row config, so it never runs
  again. That marker is what keeps a later, deliberate 图片 selection in the
  Models page from being reverted on the next start.
- The marker only records that the cleanup happened — it says nothing about
  which models were swept. The rule is recomputed from the catalog every time it
  runs, so a model added while the cleanup was still pending is swept by the same
  pass.

The marker lives in the profile's patch document, on this plugin's row:

```yaml
- id: custom-reasoning-effort
  name: dsh-custom-reasoning-effort
  config:
    residualInputsReclaimed: 1
```

**Deleting the `residualInputsReclaimed` field re-runs the cleanup once on the
next start.** That is the escape hatch if a removal went further than you wanted,
or if you import a settings document from a 0.2.x installation later: the field
comes back on its own with the next start. There is nothing else to configure —
the plugin takes no other options.

After the cleanup, each custom-route model resolves its input types the way the
settings page shows them: no declaration means the adapter's
`declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`, which
for a custom route is text-only until you tick 图片 on that model row. That is
the same rule the page's own 输入类型 field writes against, which is why the two
cannot drift apart any more.

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

There is no second step: this package declares `dsh.bundle.patch` in
`package.json`, so the dsh CLI's reconcile step appends it to the profile's
`dsh.profile.bundles`, and the package's own `cordis.patch.yml` contributes the
plugin row.

### Other install shapes

The argument after `add` is a pnpm dependency spec, forwarded verbatim, so every
spec form pnpm accepts works — the GitHub shorthand, a git URL, a local
checkout, or a packed tarball:

```bash
dsh plugin --profile web add github:Pheobe-Southwood/dsh-custom-reasoning-effort
dsh plugin --profile web add git+https://github.com/Pheobe-Southwood/dsh-custom-reasoning-effort.git
dsh plugin --profile web add link:/path/to/dsh-custom-reasoning-effort
npm pack && dsh plugin --profile web add ./dsh-custom-reasoning-effort-0.3.0.tgz
```

`dsh plugin` initializes a profile that does not exist yet, runs pnpm inside the
profile directory (so pnpm must be on `PATH`), then reconciles the bundle list
against what is actually installed: a dependency declaring `dsh.bundle` joins
`dsh.profile.bundles`, and one that does not is installed with a warning and
never becomes a layer. This package ships built `lib/` and declares no `prepare`
script, so no install-time build is involved; a git-hosted plugin that does
build on install needs its key under `allowBuilds` in the profile's
`pnpm-workspace.yaml` before the command can succeed.

Uninstall is symmetric — reconcile also drops the bundle from
`dsh.profile.bundles`:

```bash
dsh plugin --profile web remove dsh-custom-reasoning-effort
```

The fields it filled stay in the settings document, and so does the marker on
its row if the cleanup already ran: the filled levels are schema-legal values in
the adapter's own settings section, so the file stays valid and the picker keeps
working. That residue is an accepted consequence — see the ADRs below — and the
per-model opt-out below is how a model leaves the picker for good.

**Do not hand-edit the profile's `cordis.patch.yml`** — the package already
ships that row, and a second copy of the same row is not a harmless duplicate:
the Loader rejects a repeated entry id and the next boot fails loudly with

```text
duplicate loader entry id: custom-reasoning-effort
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
per-model reasoning declaration: a gateway whose levels the fallback
over-offers is opted out model by model rather than pinned to a shorter list.
Input types have no such sentinel and need none — the Models page's 输入类型
checkboxes are the declaration, and this plugin does not touch the field.

## Development

```bash
npm install        # devDependencies, plus the one runtime dependency (a schema library)
npm run check      # lint + tests + pack dry run
npm test           # unit tests and the bundle mount check
npm run test:mount # the mount check alone
```

## License

MIT — see `LICENSE`. The reasoning-effort semantics this plugin depends on are
the harness's own, documented by the ADRs in
`docs/adr/0001-settings-normalization-for-custom-provider-reasoning-effort.md`,
`docs/adr/0002-input-modality-backfill-for-custom-provider-routes.md` (superseded)
and
`docs/adr/0003-hand-input-modalities-to-the-settings-page.md`.
