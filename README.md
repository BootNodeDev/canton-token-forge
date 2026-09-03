# canton-token-forge

A reusable, multi-instrument CIP-0056 (CN Token Standard) compliant token for
demos and sandboxes. It is interface-faithful to the standard and structurally
faithful to Amulet (rules/factory contract, two-template locking, two-step
transfer, multi-output batch transfer, allocation/DvP, registry HTTP API) but
has NO economics (no decay, fees, mining rounds, rewards, or DSO governance).
Issuance is free/admin-authorized, plus an optional per-instrument faucet.

One party carries both roles: the instrument admin signs every `InstrumentConfig`
and every holding, and is the same party the registry API reports as its
`adminId`. There is no separate operator.

## Quick start

```bash
# 1. Vendor the Splice interface DARs into deps/ (clones canton-network/splice)
npm run setup

# 2. Build the production DAR and run the Daml test suite
npm test

# 3. Install and test the registry HTTP service
cd registry && npm install && npm test
```

`npm test` builds the production DAR and runs the `canton-token-forge-test`
suite, which covers minting, both transfer paths, the batch transfer, locking,
allocations, the faucet and burn-mint. The scripts run in-process, so no ledger
or sandbox is needed.

`registry/` is a separate npm package with its own dependencies: the root
`npm install` does not populate `registry/node_modules`, and vendoring the Daml
deps is a separate `npm run setup`.
Its suite runs against an in-process server with a stubbed ledger, so it needs no
sandbox either.

A third suite drives both transfer paths against a real participant:
`cd registry && npm run test:e2e`. It reports every test as skipped when nothing
is listening, so it is safe to run without a sandbox. See
[`RUNBOOK.md`](RUNBOOK.md).

[`CLAUDE.md`](CLAUDE.md) has the full command list for both the Daml packages and
the service, along with the toolchain constraints behind them.

## Running it locally

[`RUNBOOK.md`](RUNBOOK.md) walks through bringing up a local Canton sandbox
(`npm run sandbox`), seeding it with an instrument (`npm run seed`), and driving
it from the registry HTTP service in `registry/`. It also records the JSON Ledger
API conventions the participant enforces, which are the reason the seed script
and the service look the way they do.

## What's inside

- `daml/canton-token-forge/` - production package. Six templates
  (`InstrumentConfig`, `TokenTransferPreapproval`, `Token`, `LockedToken`,
  `TokenTransferInstruction`, `TokenAllocation`) exposing seven interface
  instances. It data-depends ONLY on the seven `splice-api-token-*` interface
  DARs (holding, metadata, transfer-instruction, allocation,
  allocation-instruction, allocation-request, burn-mint) and NOT on
  `splice-amulet`.
- `daml/canton-token-forge-test/` - the integration-test package, kept separate
  so test code never lands in the production DAR. It data-depends on the compiled
  production DAR.
- `registry/` - the read-only TypeScript HTTP service implementing the CN Token
  Standard registry API: instrument metadata, factory ids, and the choice
  contexts a client needs to submit a transfer or an allocation. It submits
  nothing to the ledger itself.
- `scripts/fetch-dep.sh` - vendor Splice into `deps/`, derive versions,
  stable-symlink DARs. Run by `npm run setup`.
- `scripts/sandbox.sh` - build the DAR and run a local Canton sandbox with the
  JSON Ledger API (`npm run sandbox`).
- `scripts/seed.mjs` - seed a running sandbox with an admin, demo users, and one
  `InstrumentConfig` (`npm run seed`). It prints a ready-to-paste `registry/.env`.
- `scripts/build-harness.sh` - build the Amulet test harness. Unused by default
  and not needed to build, test, or run anything above; it exists for conformance
  work against Amulet's own test engine.
- `versions.env` - the single knob: `SPLICE_TAG`.
- [`SPEC.md`](SPEC.md) - the specification: capabilities, the standard surface
  implemented, the authorization model, verification, and the known limits.
  Written to be read on its own by someone evaluating the system.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) - system shape: templates, authority
  model, data flow, and the choice-context pattern.
- [`CLAUDE.md`](CLAUDE.md) - the operational guide (toolchain, conventions,
  gotchas, versioning model); [`AGENTS.md`](AGENTS.md) is a thin pointer to it
  for non-Claude agents.

## Standard interfaces implemented

From the `splice-api-token-*` DARs:

| Interface | Implemented by |
|-----------|----------------|
| `HoldingV1.Holding` | `Token`, `LockedToken` |
| `TransferInstructionV1.TransferFactory` | `InstrumentConfig` |
| `TransferInstructionV1.TransferInstruction` | `TokenTransferInstruction` |
| `AllocationInstructionV1.AllocationFactory` | `InstrumentConfig` |
| `AllocationV1.Allocation` | `TokenAllocation` |
| `BurnMintV1.BurnMintFactory` | `InstrumentConfig` |

`GET /registry/metadata/v1/info` advertises six supported APIs: the five DARs
these interfaces come from, plus `splice-api-token-metadata-v1`, which is the
registry's own HTTP API and has no Daml interface to implement.

The seventh data-dependency, `splice-api-token-allocation-request-v1`, defines
`AllocationRequest`, which an app implements to solicit allocations from its
users when settling a DvP. That is
the settlement venue's role rather than a token registry's, so this package
declares the DAR without implementing the interface.

## Consuming a release

Any downstream Daml package that depends on this one needs one file:
`canton-token-forge-0.0.1.dar`, attached to each
[release](https://github.com/BootNodeDev/canton-token-forge/releases). It
bundles the six `splice-api-token-*` interface packages it links against, at the
package-ids it was compiled with, so a consumer does not vendor Splice, does not
run `npm run setup`, and does not have to match `SPLICE_TAG`.

Download it and save it as `vendor/canton-token-forge.dar`, then in your
`daml.yaml`:

```yaml
data-dependencies:
  - vendor/canton-token-forge.dar
build-options:
  - --target=2.1
  - --package=splice-api-token-holding-v1-1.0.0
  - --package=splice-api-token-metadata-v1-1.0.0
  - --package=splice-api-token-transfer-instruction-v1-1.0.0
  - --package=splice-api-token-allocation-v1-1.0.0
  - --package=splice-api-token-allocation-instruction-v1-1.0.0
  - --package=splice-api-token-burn-mint-v1-1.0.0
```

The `--package` lines are required: the bundled interface packages are hidden by
default, and importing `Splice.Api.Token.*` without them fails with "member of
the hidden package". You still need SDK 3.4.11 and LF 2.1 to compile against it.

`splice-api-token-allocation-request-v1` is declared by this package but never
implemented, so it is not bundled. Take it from Splice directly if you need it.

This snippet is transcribed from the `data-dependencies` and `build-options`
blocks in `consumer-smoke/consumer/daml.yaml`. On every pull request the `daml`
check compares both block headers and every entry under them against that file,
in both directions, so a flag, target or path that changes on one side reds
rather than ships. The release body carries the same blocks, generated straight
from that file.

## Consuming the registry service

The registry service is published from this repository as an npm package,
consumed from git at a tag rather than from the public registry:

```json
{
  "dependencies": {
    "@bootnodedev/canton-token-forge": "github:BootNodeDev/canton-token-forge#v0.2.0"
  }
}
```

Two preconditions. This repository is private, so the install needs
credentials that can read it: a token-based HTTPS credential helper or an SSH
key for `github.com`, whichever your environment already uses for private git
dependencies. And the tag must name a commit whose DAR is uploaded to the
participant the service points at, since the template ids are checked at boot
and an id the participant cannot resolve stops it starting.

Every `v[0-9]*` tag is both a DAR release and an npm package pin: see
"Consuming a release" above for the DAR itself.

`npm install` builds `registry/src` through the package's `prepare` script and
links one bin, `canton-token-forge-registry`, unmodified. `pnpm install`
refuses by default: pnpm will not run a git-hosted package's build scripts
unless the consumer allowlists it, and `registry/dist` is gitignored, so
`prepare` is the only thing that produces the bin. Add the resolved git
specifier to `pnpm-workspace.yaml`, using whichever key your pnpm major reads:

```yaml
# pnpm 11 and later
allowBuilds:
  "@bootnodedev/canton-token-forge@git+https://github.com/BootNodeDev/canton-token-forge.git#<resolved-sha>": true

# pnpm 10
onlyBuiltDependencies:
  - "@bootnodedev/canton-token-forge@git+https://github.com/BootNodeDev/canton-token-forge.git#<resolved-sha>"
```

The key is the full resolved git specifier, not the bare package name, a
version range, or a wildcard: pnpm resolves the tag to its commit sha and
matches on that exact string. Its own refusal error prints that specifier, but
unquoted: a YAML key cannot start with `@`, and the `#` before the sha would
open a comment, so quote it as the block above does. Since the sha is resolved
from the tag, this entry changes whenever the pin does. With it present, `pnpm exec canton-token-forge-registry` runs the
same as `npm`'s link.

The service reads its whole configuration from the environment, plus a `.env`
loaded from the working directory it is started in. Required, eight:
`LEDGER_API_URL`, `LEDGER_API_TOKEN`, `ADMIN_PARTY`, and the five template ids
(`INSTRUMENT_CONFIG_TEMPLATE_ID`, `PREAPPROVAL_TEMPLATE_ID`,
`LOCKED_TOKEN_TEMPLATE_ID`, `TRANSFER_INSTRUCTION_TEMPLATE_ID`,
`ALLOCATION_TEMPLATE_ID`). Optional, four: `PORT`, `LEDGER_USER_ID`,
`SHUTDOWN_TIMEOUT_MS`, `DIRECT_TRANSFER_MARGIN_MS`. The package ships
`registry/.env.example` with the full list and what each variable is for, and
`npm run seed` against a local sandbox prints the block filled in with the real
admin party and the five template ids. `ADMIN_PARTY` and all five template ids
are checked against the participant at boot, so a value it cannot resolve
stops the service starting rather than failing later.

What the package contains: `registry/dist`, `registry/openapi` and
`registry/.env.example`, plus `package.json`, `README.md` and `LICENSE` (24
entries). The manifest that travels with it is this repository's own, so its
`dpm` and `daml/` scripts cannot run from an installed copy; `prepare` is the
only entry npm acts on.

## Requirements

- `dpm` (Digital Asset Package Manager) and a JDK 17+ on `PATH`
  (`curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`).
- Node 20+ for the registry service, its test suites, and the seed script.
- `git` + network access (setup clones `canton-network/splice`).

## Bumping Splice

Edit `SPLICE_TAG` in `versions.env`, run `npm run setup`. Two things do not
follow from that knob (see CLAUDE.md). If the new tag ships a different SDK,
update `sdk-version` in every tracked `daml.yaml`, `DPM_SDK_VERSION` in both
workflows, and the tarball digest recorded for that version in
`.github/actions/install-dpm/action.yml`; and if it moves the LF target,
`--target` in those manifests and in the LF greps both workflows run. If it
ships different interface versions, update the `--package` unit-ids in
`consumer-smoke/consumer/daml.yaml`, which spell the version out because the
compiler rejects the unversioned form.

Then update this file by hand for any of the three. The snippet above is
compared against the smoke package by the `daml` check, so forgetting it reds
rather than ships. The SDK and LF versions named in the prose under it are
transcriptions that nothing reads, so an edit that stops short of them leaves
the first page a consumer reads naming a version we just moved off.

## License

MIT - see [`LICENSE`](LICENSE).
