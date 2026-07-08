# AGENTS.md

Operational guide for AI agents (and humans) working in this repo. Read before
making changes.

## What this repo is

A **Daml** project that data-depends on **Splice Amulet / Canton Coin**. `daml/`
is a **container** of packages (mirroring the upstream `canton-network/splice`
`daml/` layout), wired by the root `multi-package.yaml` - it is *not* a package.
Two packages:

- **`splice-app`** (`daml/splice-app/daml.yaml`) - production templates.
- **`splice-app-test`** (`daml/splice-app-test/daml.yaml`) - integration-test
  package that data-depends on the compiled `splice-app` DAR and runs it against
  the upstream Amulet test harness. Kept separate so the harness never lands in
  the production DAR.

(These are the template's generic names; if you cloned via the template you may
have renamed them with `init.sh`.)

## Toolchain

- Use **`dpm`** (Digital Asset Package Manager), **not** the legacy `daml`
  assistant (removed as of SDK 3.5). Commands: `dpm build`, `dpm test`,
  `dpm install <version>`.
- SDK pinned to **3.4.11**, LF target **2.1** (`build-options: --target=2.1`) in
  both `daml.yaml` files. Do not bump casually - the deps and harness are built
  at this SDK/LF and the test package unifies `daml-script` against it.
- A JDK (17+) and `dpm` must be on `PATH`. Install dpm with
  `curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`.

## Versioning: one knob

The **only** version you pin is the Splice release tag, in **`versions.env`**
(`SPLICE_TAG`). Everything else is derived:

- `scripts/fetch-dep.sh` sparse-clones `canton-network/splice@$SPLICE_TAG`, reads
  each DAR's version out of the vendored source `daml.yaml`, and creates
  **stable-name symlinks** (`deps/splice-daml/dars/splice-amulet.dar`, etc.).
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

`postinstall` runs `npm run setup` (= `scripts/fetch-dep.sh` then
`scripts/build-harness.sh`): vendors Splice into `deps/` and builds the
`splice-amulet-test` harness DAR. Preconditions: `dpm` + JDK 17+ on `PATH`, `git`
+ network. First run takes a few minutes. For deps only, run
`bash scripts/fetch-dep.sh`.

| Command | Does |
| --- | --- |
| `npm run build` | Build both packages (splice-app, then splice-app-test). |
| `npm run build:splice-app` | Build only the production package. |
| `npm test` | Build the `splice-app` DAR, then run the `splice-app-test` suite. |
| `npm run test:coverage` | Same, with a coverage report focused on your templates. |
| `npm run clean` | Remove both `.daml` build dirs. |
| `npm run setup` | Re-vendor deps + rebuild the harness DAR. |

Build **each package in its own `dpm` invocation**; do **not** use
`dpm build --all`, and never `dpm build` at the repo root (it is a
`multi-package.yaml`, not a package).

### Running dpm directly

```bash
export LANG=C.UTF-8
( cd daml/splice-app      && dpm build )   # -> daml/splice-app/.daml/dist/splice-app-0.0.1.dar
( cd daml/splice-app-test && dpm test )     # needs the splice-app DAR built first
```

## Why the harness build is finicky

The AmuletRegistry test engine (`setupApp` / `tap` / `getAppTransferContext`)
ships only as **source** and data-depends on `*-current.dar` artifacts the repo
doesn't ship. `scripts/build-harness.sh` **aliases** those `-current.dar` names
at the shipped versioned DARs (via the stable symlinks) - same package-ids the
production package uses - and builds only the three source-only test packages
(`splice-token-test-trading-app`, `splice-token-standard-test`,
`splice-amulet-test`) bottom-up. It does not rebuild `splice-amulet`/`splice-util`
from source.

## Coverage caveats (`npm run test:coverage`)

Templates live in `splice-app` but are exercised from `splice-app-test`, so a
plain `dpm test` reports `0 defined`. The coverage script adds `--all` (pulls the
data-dependencies into the universe; **also re-runs splice's own suites, so it's
slower**) plus two `--coverage-ignore-choice` filters. Gotchas: the regex engine
is POSIX `Text.Regex.TDFA` (**no** negative lookahead - you positively drop
`^splice`); it matches the rendered **package name**, not the package-id; and it
filters **choices only** (no template-ignore flag).

## Hard rules

- Never edit or commit `deps/` (vendored + gitignored) or `.daml/`.
- Keep the test harness out of the production `splice-app` package.
- Commits use no `Co-Authored-By` trailer.
