# canton-token-forge

A reusable, multi-instrument CIP-0056 (CN Token Standard) compliant token for
demos and sandboxes. It is interface-faithful to the standard and structurally
faithful to Amulet (rules/factory contract, two-template locking, two-step
transfer, allocation/DvP, registry HTTP API) but has NO economics (no decay,
fees, mining rounds, rewards, or DSO governance). Issuance is free/admin-authorized,
plus an optional per-instrument faucet.

One party carries both roles: the instrument admin signs every `InstrumentConfig`
and every holding, and is the same party the registry API reports as its
`adminId`. There is no separate operator.

## Quick start

```bash
# 1. Vendor the Splice interface DARs into deps/ (clones canton-network/splice)
npm install

# 2. Build the production DAR and run the Daml test suite
npm test

# 3. Install and test the registry HTTP service
cd registry && npm install && npm test
```

`npm test` builds the production DAR and runs the `canton-token-forge-test`
suite, which covers minting, both transfer paths, locking, allocations, the
faucet and burn-mint. The scripts run in-process, so no ledger or sandbox is
needed.

`registry/` is a separate npm package with its own dependencies: the root
`npm install` vendors the Daml deps and does not populate `registry/node_modules`.
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
  stable-symlink DARs. Run by `npm install`.
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

## Requirements

- `dpm` (Digital Asset Package Manager) and a JDK 17+ on `PATH`
  (`curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`).
- Node 18+ for the registry service, its test suites, and the seed script.
- `git` + network access (setup clones `canton-network/splice`).

## Bumping Splice

Edit `SPLICE_TAG` in `versions.env`, run `npm run setup`. No other file changes -
unless the new tag ships a different SDK, in which case also update `sdk-version`
in the two `daml.yaml` files (see CLAUDE.md).

## License

MIT - see [`LICENSE`](LICENSE).
