<!-- starter-kit: v2026.05 -->

# CLAUDE.md

Single source of truth for this project's stack, conventions, and working rules.
Claude Code reads this file natively. Other agents (Cursor, Windsurf, etc.) read
[`AGENTS.md`](AGENTS.md), which points here.

This is a **Daml** project built with **`dpm`**, not a JavaScript project - the
`npm` scripts mostly wrap `dpm` and vendor dependencies, and the one genuine
JavaScript build among them (`prepare`, which compiles `registry/`) never
touches the Daml side. Generic JS/`npm` assumptions do not apply here, and this
file overrides any parent-directory or global config that describes generic
JS/`npm` workflows.

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

## Stack & Conventions

| Category | Technology | Notes |
|----------|-----------|-------|
| Language | Daml | LF target **2.1** (`build-options: --target=2.1`) |
| SDK | 3.4.11 | pinned in all three `daml.yaml` files; CI asserts them |
| Build tool | `dpm` (Digital Asset Package Manager) | NOT the legacy `daml` assistant (removed as of SDK 3.5) |
| Task runner | `npm` scripts | the Daml ones wrap `dpm` with `LANG=C.UTF-8`; `prepare` builds `registry/` |
| Dependencies | Splice interface DARs | vendored into `deps/` by `scripts/fetch-dep.sh` (gitignored) |
| Runtime | JDK 17+ | required on `PATH` for `dpm` |
| Choice naming | `TemplateName_ChoiceName` | matches the CN Token Standard convention |

## Toolchain

- Use **`dpm`** (Digital Asset Package Manager), **not** the legacy `daml`
  assistant (removed as of SDK 3.5). Commands: `dpm build`, `dpm test`,
  `dpm install <version>`.
- SDK pinned to **3.4.11**, LF target **2.1** (`build-options: --target=2.1`) in
  every tracked `daml.yaml`, of which there are three: the two packages under
  `daml/` and the consumer smoke package. Do not bump casually - the deps are
  built at this SDK/LF and the test package unifies `daml-script` against it.
  The `daml` CI check reads the pin out of each one and fails if any disagrees
  with the SDK the workflow installs.
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

Two exceptions. The **SDK/LF** pins live in the three `daml.yaml` files (static
YAML can't read env vars). If a new tag ships a different SDK, update
`sdk-version` (and possibly `--target`) there too, along with
`DPM_SDK_VERSION` in both workflows and the tarball digest in
`.github/actions/install-dpm/action.yml`, which is where the one copy of that
digest lives. Neither workflow installs an SDK a manifest disagrees with, and
the action refuses a version it holds no digest for, so a half-finished bump
reds rather than installing something unverified.
`scripts/build-harness.sh` derives the SDK it installs from the vendored
harness, so at least the install matches the tag.

The second is `consumer-smoke/consumer/daml.yaml`, which names the six bundled
Splice interfaces as versioned unit-ids (`--package=splice-api-token-holding-v1-1.0.0`
and its five siblings). The compiler rejects the unversioned form, so there is no
stable name to point at, and a `SPLICE_TAG` that ships a different interface
version has to be followed by hand here. Nothing derives these.

## Build & test

Use the `package.json` npm scripts - they set `LANG=C.UTF-8` and handle the
per-package layout. (damlc regenerates data-dependency interface source and
throws "lexical error (UTF-8 decoding error)" under a POSIX/`C` locale.)

### Setup (`npm run setup`)

`npm run setup` (= `scripts/fetch-dep.sh`) vendors Splice into `deps/` and
creates the stable-name symlinks for the token interface DARs. It needs `git`
and network, and invokes neither `dpm` nor a JVM: the DARs are pre-built
upstream. Run `bash scripts/fetch-dep.sh` directly and it does the same work
without Node. First run writes over 100 MB into `deps/` and took 6 seconds on a
cold CI runner; a slow link will take longer.

A root `npm install` vendors nothing. It installs the registry service's runtime
dependencies and compiles `registry/src` to `registry/dist` through `prepare`, so
installing this repository needs no `dpm`, no JDK and no clone of Splice.

| Command | Does |
| --- | --- |
| `npm run build` | Build both packages (canton-token-forge, then canton-token-forge-test). |
| `npm run build:canton-token-forge` | Build only the production package. |
| `npm test` | Build the `canton-token-forge` DAR, then run the `canton-token-forge-test` suite. |
| `npm run test:coverage` | Same, with a coverage report focused on your templates. |
| `npm run smoke` | Build the DAR, then compile a package that data-depends on nothing but it, proving the artifact is consumable on its own. |
| `npm run clean` | Remove both `.daml` build dirs, the consumer smoke test's output, and `registry/dist`. |
| `npm run setup` | Re-vendor deps + re-create the stable symlinks. |
| `npm run sandbox` | Build the DAR and run a local Canton sandbox with the JSON Ledger API. |
| `npm run seed` | Seed a running sandbox with an admin, demo users, and one `InstrumentConfig`. |

### The registry service

`registry/` is a separate npm package with its own dependency tree; the root
`npm install` does not populate `registry/node_modules`. Run its commands from
that directory.

| Command | Does |
| --- | --- |
| `npm install` | Install the service's own dependencies. |
| `npm test` | Unit suites against an in-process server with a stub ledger. No sandbox needed. |
| `npm run test:e2e` | Drive both transfer paths against a live participant. Skips itself when nothing is listening. |
| `npm run build` | Typecheck `src/` and emit `dist/`. |
| `npm run typecheck:test` | Typecheck the suites, which `build` leaves out and vitest does not check. |
| `npm start` / `npm run dev` | Run the built service / run it from source. |
| `npm run lint` | Biome check (`lint:fix` to write). |

See [`RUNBOOK.md`](RUNBOOK.md) for the full local bring-up, including wiring the
`registry/` HTTP service to the seeded sandbox.

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
> `fetch-dep` only, and nothing in the build, the test suites, or the local
> bring-up needs the harness. It is built only by `scripts/build-harness.sh`, for
> conformance work against Amulet's own test engine. The section below documents
> that build for whoever reaches for it.

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

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full system overview: package
layout, key templates and interfaces, the dependency-vendoring flow, and the
transfer/mint data flow.

## Code Style

- Name every choice we define `TemplateName_ChoiceName` (e.g.
  `InstrumentConfig_Preapprove`, `InstrumentConfig_Mint`), matching the CN
  Token Standard's own choice-naming convention (`TransferFactory_Transfer`,
  `AllocationFactory_Allocate`). Interface method implementations keep the names
  the standard interface dictates.
- No em dashes anywhere (code, comments, docs, commits). Use hyphen, comma, or
  parentheses instead.
- No plan/roadmap comments and no slop comments in code. Never reference plans,
  tasks, or future work in a comment (no "added in Plan 03", "arrives later",
  "for now"). A comment must explain why the code is the way it is; if it only
  restates what the code plainly does or narrates scaffolding progress, delete it.
- Never use the informal four-letter word for a fake/stub stand-in object
  anywhere (names, comments, docs). Say "fake", "stub", or "placeholder" instead.

## Commit Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

**Format:** `type(scope): subject`

- **Scope** is optional: `feat: add mint choice` and `feat(registry): add mint choice` are both valid
- **Subject** uses imperative mood, lowercase after the colon, no trailing period
- **A commit message is the subject line and nothing else**: no body, no bullet
  list, no explanatory paragraphs. Anything that seems to need more explanation
  belongs in the PR description or a code comment
- Commits use **no `Co-Authored-By` trailer**

**Prefixes:**

| Prefix | Purpose |
|--------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `chore` | Maintenance, dependencies, config |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `ci` | CI/CD pipeline changes |
| `perf` | Performance improvement |
| `build` | Build system or external dependencies |
| `revert` | Reverts a previous commit |

## PR Workflow

- Every PR must reference an issue (`Closes #`)

  > No related issue? Use `No related issue.` as the first line of the Summary section.

- Mirror the issue's acceptance criteria in the PR
- Self-review your diff before requesting peer review
- Keep PRs small and focused - one issue, one PR
- PR titles use the same conventional commit format (`feat: add transfer factory`)
- Use `/sdlc:create-pr` to create PRs - it reads the template and fills every section automatically

## Label Conventions

GitHub form dropdowns (like the Priority field in issue templates) only work through the web UI. When issues are created via `gh` CLI or REST API, dropdown values become unstructured body text - not queryable, not consistent. **Labels are the API-reliable mechanism for structured metadata.**

**Priority** (bugs, features, and epics):

| Label | Description |
|-------|-------------|
| `priority: critical` | Blocking work, system down, or security issue |
| `priority: high` | Must be addressed in current sprint |
| `priority: medium` | Should be addressed soon |
| `priority: low` | Nice to have, can wait |

Labels are queryable: `gh issue list --label "priority: high"`.

The `/sdlc:issue` skill applies these labels automatically when creating issues via CLI. Bug, feature, and epic templates include a Priority dropdown for web UI users, but labels are the source of truth for programmatic workflows.

## Guardrails

- Never edit or commit `deps/` (vendored + gitignored) or `.daml/` (build output).
- Keep test code out of the production `canton-token-forge` package - it must not
  land in the production DAR.
- Do not commit secrets, API keys, or credentials.
- Do not modify CI/CD pipelines without team review.
- Do not skip tests or the build to make something pass.
- When in doubt, ask - don't assume.

## Change Strategy

- Prefer small, focused diffs over broad refactors
- Avoid introducing new patterns when a project pattern already exists
- Update docs (this file and `ARCHITECTURE.md`) only when behavior or workflow changes

## Validation Checklist

Run before declaring work done:

- `npm run setup` once, so `deps/` are vendored
- `npm run build` - both packages compile
- `npm test` - the integration suite passes
- `npm run test:coverage` - when you touched or added templates
- `npm run smoke` - when you changed what the production DAR exposes: a
  renamed module or template, its dependencies, its interface instances, or its
  `build-options`

Every pull request gets three comparisons whatever it touches, because the
`daml` check runs them ahead of its toolchain install and outside its own
scope gate: the strings that spell a template id, against `daml/`; the
consumer snippet in `README.md`, against `consumer-smoke/consumer/daml.yaml`;
and every tracked `daml.yaml`, against both the SDK version the workflow
installs and LF 2.1. One that touches
`daml/`, `consumer-smoke/`, `scripts/consumer-smoke.sh` or the root build
inputs runs four of these five automatically in that same check, after those
three steps: only `npm run test:coverage` does not. One that touches `registry/`
runs that package's own lint, both typechecks, and unit suite as the
`registry` check, not the root commands above. `npm run test:coverage` and
the registry's `npm run test:e2e` are both off the pull-request path: the
first re-runs Splice's own suites, the second needs a live participant. The
`release` workflow adds checks of its own that no pull request runs. The
end-to-end suite is typechecked on that path even so, which is the point of
typechecking it separately from the run.

A pushed tag whose `v` is followed by a digit (`v[0-9]*`, so `vnext` and
`vendor` trigger nothing) runs the `release` workflow instead: it refuses a
tag `main` does not reach, builds from a clean checkout, runs the suite,
checks the DAR is byte-reproducible, compiles `consumer-smoke/` against the
built artifact, generates the release body, and publishes the DAR as a
release asset. A manual
dispatch of that workflow runs the build and those artifact checks, cannot
publish, and leaves three things unexercised: the on-main refusal, the publish,
and `release-notes.sh`'s tag guard, which `ALLOW_UNTAGGED` waives so that a
body can be emitted for a ref that is not a tag at all. See
[`RUNBOOK.md`](RUNBOOK.md#cutting-a-release) for the procedure, including the
pre-release rehearsal, the only run that exercises that guard before the real
tag.

## References

- [Daml documentation](https://docs.daml.com)
- [`canton-network/splice`](https://github.com/canton-network/splice) - upstream source for the vendored DARs
- dpm install: `curl https://get.digitalasset.com/install/install.sh | sh`
- [Conventional Commits](https://www.conventionalcommits.org/)
