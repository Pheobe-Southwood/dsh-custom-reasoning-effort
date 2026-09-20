# dsh-custom-reasoning-effort

Backfill the per-model capability metadata of custom DeepSeek Harness (dsh) LLM
provider routes: the reasoning-effort levels the composer's official 推理等级
picker needs, and the input modality list image input needs. A model added
through 添加自定义提供方 then behaves like the same model added through 添加提供方.

The plugin is a host-side settings normalizer: it writes the per-model
`reasoningEfforts` and `input` fields the `llm-pi-ai` schema already accepts, and
lets the shipped pipeline — settings → model catalog → picker and modality gate
→ `reasoning_effort` and the request content on the wire — do the rest. It ships
**no client half, no custom UI and no runtime dependencies**, and it never calls
an LLM itself.

## The problem

A model added through **Settings → Models → 添加自定义提供方** never shows the
composer's 推理等级 picker and cannot receive an image, while the same model
added through **添加提供方** does both.

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

Input modalities are resolved the same route-keyed way, and lose the same race.
The adapter computes a model's list as
`declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]`, where
`declaredInput` treats an absent list and an empty one alike as "states no
answer". A custom route has no `base` either, so every one of its models
resolves to the profile default `["text"]`. That resolved list is what every
modality consumer reads: the host-side admission gate refuses an attached image
with `MODEL_DOES_NOT_SUPPORT_IMAGES` before it is ever admitted, `read_image`
refuses the same way, and the other consumers project images away for such a
model. The card collects only the id and the connection facts, so the per-model
`input` list — the one lawful per-model declaration — is missing too.

## What the plugin does

On every start and on every settings change the normalizer walks the persisted
`llm-pi-ai` settings and, for each **custom-provider route** (a provider route
key that is not in the builtin catalog), brings every model up to date, filling
only the fields it can:

- **`reasoningEfforts` — same-id builtin twin.** If the builtin catalog has an
  entry with that model id, its capability is inherited, level for level,
  including a `reasoning: false` twin (a non-reasoning builtin model stays
  non-reasoning under the custom route rather than silently gaining levels); a
  twin whose only offered level is `off` has no expressible level list and is
  declared non-reasoning for the same reason. When several catalog routes
  describe the same id and disagree, that id names different models in different
  places and no single capability is a fact, so the standard set is used instead.
- **`reasoningEfforts` — otherwise.** The model gets the standard seven-level
  pi-ai thinking-level set, the same level vocabulary the harness's own
  reasoning-effort handling is written against. A model carrying the explicit
  `reasoningEfforts: false` is a judgement and is left alone.
- **`input` — same-id builtin twin.** The twin's own modality list is inherited,
  including a text-only `["text"]`: a text-only builtin model does not gain image
  input just because it is reached through a custom route. Twins that disagree,
  and twins that state no modality list at all, are no fact and fall back.
- **`input` — otherwise.** The model gets `["text", "image"]`, because an
  endpoint the catalog does not describe is exactly the case where a text-only
  default would keep images unreachable with no in-product way to say otherwise.
  A model that must stay text-only says so itself — see *Input modalities*.
- **A list the entry already carries is a judgement** and is left exactly as it
  stands, ordering included; the field is never rewritten to widen, narrow or
  sort it.

Only routes the user's own settings layer declares are considered: a route that
exists only in a composition base layer is left alone. Nothing else is touched
either — no route the installed catalog ships is rewritten, no model id or
connection field is changed, and a model whose stored values already equal the
computed ones is left exactly as it is. The write itself is one `set` per
affected route and it replaces that route's whole `models` array, because the
shipped settings applier cannot address an element inside an array; the value is
the array that was just read with only the missing capability fields filled in,
so no other model field and no other route field is restated or dropped. Both
fields travel in that single op whenever a model needs both.

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
request parameter, exactly as it is for a builtin-route model. The same refresh
is what clears the modality consumers: the catalog's `inputModalities` is copied
from the entry the very same write filled, so images are admitted for the model
without a second change anywhere.

## Input modalities

`input` is a per-model list of the modalities the model accepts, written in the
adapter's own vocabulary: `text` and `image`, nothing else. It is the field that
decides whether an image may be sent:

- The **host-side admission gate** refuses an attached image with
  `MODEL_DOES_NOT_SUPPORT_IMAGES` when the resolved list exists and does not name
  `image`. `read_image` and every other consumer of the resolved list refuse or
  project images away the same way. One write clears them all: nothing else has
  to change, and no client surface reads modalities at all.
- **A list the entry already carries is the durable per-model declaration.** An
  explicit non-empty `input` list is never overwritten, so writing
  `input: ["text"]` is how a text-only endpoint keeps images out, and writing
  `input: ["text", "image"]` pins the capability explicitly. Ordering is not
  part of the value: `["image", "text"]` declares exactly what
  `["text", "image"]` does and is never rewritten to be sorted.
- **An empty list is not a declaration.** `input: []` is schema-legal but means
  the same thing as an absent field — the adapter's `declaredInput` answers "no
  answer" for both — so a model whose entry carries `[]` is filled like any
  other gap, not left text-only. To declare text-only, write `["text"]`.
- **A twin states the truth when the catalog agrees.** When every catalog route
  describing that model id states the same modality set, it is inherited,
  including a text-only one. When they disagree — or when some of them state
  nothing — the id is not decidable from the catalog and the fallback is used.
- **The fallback may over-declare image support.** `["text", "image"]` is the
  answer for a model the catalog cannot describe, and it is deliberately the
  permissive direction: this route is one the user added by hand, nothing in the
  product writes the field, and under-claiming would leave image input
  unreachable. If the endpoint really cannot take images, the provider rejects
  the request at send time; the per-model `input` list above is the durable way
  to claim less.

## Semantics

- **`reasoningEfforts` is recomputed and overwritten on every start and every
  settings change.** The filled values are derived state, not user state: any
  stored value other than the `false` opt-out — including a level list someone
  wrote by hand — is replaced when it disagrees with the computation.
- **`input` is only filled where the entry declares nothing.** Unlike a
  reasoning dict, a modality list cannot be told apart from its own content — a
  list this plugin wrote and a list the user wrote are the same value — so any
  explicit non-empty list is read as a judgement and preserved. That is the one
  field whose per-model opt-out is a value rather than a sentinel.
- **An explicit `reasoningEfforts: false` is an opt-out and is never
  overwritten.** Declaring a model non-reasoning is a decision, not a gap, so it
  survives every normalization pass. A declared level list is not an opt-out —
  the field is derived state, and only `false` is treated as a judgement. The
  opt-out is field-scoped: it says the model does not reason, not that it takes
  no images, so its `input` list is still filled.
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
  capability fields — both of them, in the same op. The plugin never rewrites a
  profile, a route key, or another namespace, and it writes nothing at all when
  the computed values are already in place.
- **Uninstalling (`dsh plugin --profile <name> remove
  dsh-custom-reasoning-effort`) leaves the filled fields in `settings.yaml`.**
  They are schema-legal values in the adapter's own settings section, so the file
  stays valid, the picker keeps working and images keep being admitted after the
  plugin is removed; the plugin does not rewrite settings on the way out. This is
  an accepted trade-off — see the ADRs below.

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
npm pack && dsh plugin --profile web add ./dsh-custom-reasoning-effort-0.2.0.tgz
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

The fields it filled stay in `settings.yaml`: they are schema-legal values in
the adapter's own settings section, so the file stays valid, the picker keeps
working and images keep being admitted. That residue is an accepted consequence
— see the ADRs below — and the per-model opt-outs below are how a model leaves
the picker, or image input, for good.

**Do not hand-edit the profile's `cordis.patch.yml`** — the package already
ships that row, and a second copy of the same row is not a harmless duplicate:
the Loader rejects a repeated entry id and the next boot fails loudly with

```text
duplicate loader entry id: custom-reasoning-effort
```

## Opting a model out

Both capabilities are opted out per model, in the persisted `settings.yaml`, by
writing the value instead of computing it:

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      models:
        - id: my-embedding-model
          reasoningEfforts: false
          input: ["text"]
```

`reasoningEfforts: false` keeps the model out of the 推理等级 picker, and the
normalizer never overwrites it, so the declaration is respected on every later
run. `input: ["text"]` declares the model text-only, which keeps images out of
requests to it; an explicit non-empty list is never overwritten either.

The two declarations are independent, and their shapes are different for a
reason. Because a hand-written level list is derived state and gets recomputed,
`false` is the only durable per-model reasoning declaration: a gateway whose
levels the fallback over-offers is opted out model by model rather than pinned
to a shorter list. A modality list has no such sentinel — the field cannot
distinguish a list this plugin wrote from a list the user wrote — so the list
itself is the declaration, and writing the modalities the model really takes is
both the opt-out and the documentation.

## Development

```bash
npm install        # devDependencies only: eslint and its config packages
npm run check      # lint + tests + pack dry run
npm test           # unit tests and the bundle mount check
npm run test:mount # the mount check alone
```

## License

MIT — see `LICENSE`. The reasoning-effort and input-modality semantics this
plugin depends on are the harness's own, documented by the ADRs in
`docs/adr/0001-settings-normalization-for-custom-provider-reasoning-effort.md`
and
`docs/adr/0002-input-modality-backfill-for-custom-provider-routes.md`.
