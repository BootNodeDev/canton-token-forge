# AGENTS.md

Operational guide for AI agents (and humans) working in this repo. Read before
making changes.

## What this repo is

A **Daml** project implementing a clean-room CIP-0056 (CN Token Standard) token.
`daml/` is a **container** of packages (mirroring the upstream `canton-network/splice`
`daml/` layout), wired by the root `multi-package.yaml` - it is *not* a package.
Two packages:

- **`canton-token-forge`** (`daml/canton-token-forge/daml.yaml`) - production
  templates. It data-depends ONLY on the seven `splice-api-token-*` interface DARs
  (holding, metadata, transfer-instruction, allocation, allocation-instruction,
  allocation-request, burn-mint) and NOT on `splice-amulet`.
- **`canton-token-forge-test`** (`daml/canton-token-forge-test/daml.yaml`) -
  integration-test package that data-depends on the compiled `canton-token-forge`
  DAR. Kept separate so test code never lands in the production DAR.

## Toolchain

- Use **`dpm`** (Digital Asset Package Manager), **not** the legacy `daml`
  assistant (removed as of SDK 3.5). Commands: `dpm build`, `dpm test`,
  `dpm install <version>`.
- SDK pinned to **3.4.11**, LF target **2.1** (`build-options: --target=2.1`) in
  both `daml.yaml` files. Do not bump casually - the deps are built at this SDK/LF
  and the test package unifies `daml-script` against it.
- A JDK (17+) and `dpm` must be on `PATH`. Install dpm with
  `curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`.

## Versioning: one knob

The **only** version you pin is the Splice release tag, in **`versions.env`**
(`SPLICE_TAG`). Everything else is derived:

- `scripts/fetch-dep.sh` sparse-clones `canton-network/splice@$SPLICE_TAG`, reads
  each DAR's version out of the vendored source `daml.yaml`, and creates
  **stable-name symlinks** (`deps/splice-daml/dars/splice-api-token-holding-v1.dar`, etc.).
- `daml.yaml` references only those stable names - **no version string appears in
  tracked Daml config**.
- To move to a new Splice release: edit `SPLICE_TAG`, run `npm run setup`.

Exception: the **SDK/LF** pins live in the two `daml.yaml` files (static YAML
can't read env vars). If a new tag ships a different SDK, update `sdk-version`
(and possibly `--target`) there too. `scripts/build-harness.sh` derives the SDK
it installs from the vendored harness, so at least the install matches the tag.

## Build & test

Use the `package.json` npm scripts - they set `LANG=C.UTF-8` and handle the
per-package layout. (damlc regenerates data-dependency interface source and
throws "lexical error (UTF-8 decoding error)" under a POSIX/`C` locale.)

### Setup (`npm install`)

`postinstall` runs `npm run setup` (= `scripts/fetch-dep.sh`): vendors Splice into
`deps/` and creates the stable-name symlinks for the token interface DARs.
Preconditions: `dpm` + JDK 17+ on `PATH`, `git` + network. First run takes a few
minutes. For deps only, run `bash scripts/fetch-dep.sh`.

| Command | Does |
| --- | --- |
| `npm run build` | Build both packages (canton-token-forge, then canton-token-forge-test). |
| `npm run build:canton-token-forge` | Build only the production package. |
| `npm test` | Build the `canton-token-forge` DAR, then run the `canton-token-forge-test` suite. |
| `npm run test:coverage` | Same, with a coverage report focused on your templates. |
| `npm run clean` | Remove both `.daml` build dirs. |
| `npm run setup` | Re-vendor deps + re-create the stable symlinks. |

Build **each package in its own `dpm` invocation**; do **not** use
`dpm build --all`, and never `dpm build` at the repo root (it is a
`multi-package.yaml`, not a package).

### Running dpm directly

```bash
export LANG=C.UTF-8
( cd daml/canton-token-forge      && dpm build )   # -> daml/canton-token-forge/.daml/dist/canton-token-forge-0.0.1.dar
( cd daml/canton-token-forge-test && dpm test )     # needs the canton-token-forge DAR built first
```

## The Amulet harness (unused by default)

> The Amulet test harness is NOT used by default. `setup` is slimmed to
> `fetch-dep` only; the harness is built solely by Plan 05 (conformance) via
> `scripts/build-harness.sh`. The section below documents that build for when Plan
> 05 reaches for it.

### Why the harness build is finicky

The AmuletRegistry test engine (`setupApp` / `tap` / `getAppTransferContext`)
ships only as **source** and data-depends on `*-current.dar` artifacts the repo
doesn't ship. `scripts/build-harness.sh` **aliases** those `-current.dar` names
at the shipped versioned DARs (via the stable symlinks) - same package-ids the
production package uses - and builds only the source-only test packages
(`splice-token-test-trading-app`, `splice-token-standard-test`,
`splice-amulet-test`) bottom-up. It does not rebuild `splice-amulet`/`splice-util`
from source.

## Coverage caveats (`npm run test:coverage`)

Templates live in `canton-token-forge` but are exercised from
`canton-token-forge-test`, so a plain `dpm test` reports `0 defined`. The coverage
script adds `--all` (pulls the data-dependencies into the universe; **also re-runs
splice's own suites, so it's slower**) plus two `--coverage-ignore-choice` filters.
Gotchas: the regex engine is POSIX `Text.Regex.TDFA` (**no** negative lookahead -
you positively drop `^splice`); it matches the rendered **package name**, not the
package-id; and it filters **choices only** (no template-ignore flag).

## Hard rules

- Never edit or commit `deps/` (vendored + gitignored) or `.daml/`.
- Keep test code out of the production `canton-token-forge` package.
- Name every choice we define `TemplateName_ChoiceName` (e.g.
  `TokenRegistry_RegisterInstrument`, `InstrumentConfig_Mint`), matching the CN
  Token Standard's own choice-naming convention (`TransferFactory_Transfer`,
  `AllocationFactory_Allocate`). Interface method implementations keep the names
  the standard interface dictates.
- Never use the informal four-letter word for a fake/stub stand-in object
  anywhere (names, comments, docs). Say "fake", "stub", or "placeholder" instead.
- No em dashes anywhere (code, comments, docs, commits). Use hyphen, comma, or
  parentheses instead.
- Commits use no `Co-Authored-By` trailer.
