# Architecture Overview

<!-- Keep this document up to date as the system evolves. It captures structural
     knowledge that helps both humans onboarding and agents building context at
     session start. Focus on the "shape" of the system - not usage instructions
     (that's CLAUDE.md) or API docs (that's code comments). -->

## Tech Stack

| Category | Technology | Notes |
|----------|-----------|-------|
| Language | Daml | LF target 2.1 (`build-options: --target=2.1`) |
| SDK | Daml SDK 3.4.11 | installed and driven via `dpm` |
| Build tool | `dpm` (Digital Asset Package Manager) | not the legacy `daml` assistant (removed as of SDK 3.5) |
| Task runner | `npm` scripts | thin wrappers over `dpm`; set `LANG=C.UTF-8` |
| Standard | CIP-0056 (CN Token Standard) | interface-faithful, clean-room (no economics) |
| Dependencies | `splice-api-token-*` interface DARs | vendored from `canton-network/splice`; NOT `splice-amulet` |
| Testing | `daml-script` (`dpm test`) | lives in the separate `canton-token-forge-test` package |
| Runtime | Canton ledger; JDK 17+ on `PATH` | |

## Project Structure

```
daml/                                    Container of dpm packages (mirrors upstream splice layout); NOT a package
  canton-token-forge/                    Production package (name: canton-token-forge)
    daml.yaml                            SDK/LF pins; data-deps on the 7 splice-api-token-* interface DARs
    daml/Canton/TokenForge/
      Registry.daml                      InstrumentConfig rules/factory + preapproval; TransferFactory/AllocationFactory/BurnMintFactory instances
      Token.daml                         Token holding template + HoldingV1.Holding instance; input fetch/consume/spend helpers
      Locked.daml                        LockedToken escrow shared by pending transfers and allocations
      Instruction.daml                   TokenTransferInstruction template + TransferInstruction interface instance
      Allocation.daml                    TokenAllocation template + Allocation interface instance
      Types.daml                         mkInstrumentId helper (admin + id -> InstrumentId)
      Version.daml                       package version marker
  canton-token-forge-test/               Integration-test package (name: canton-token-forge-test)
    daml.yaml                            data-deps on the compiled production DAR + the interface DARs
    daml/Canton/TokenForge/Test/
      AllocationTest.daml                allocation flow tests
      BurnMintTest.daml                  burn-mint factory tests
      FaucetTest.daml                    faucet tap tests
      LockTest.daml                      LockedToken escrow tests
      MultiInstrumentTest.daml           multi-instrument isolation tests
      OfferTest.daml                     pending-offer (2-step) transfer tests
      RegistryTest.daml                  registry / instrument config tests
      Smoke.daml                         version-marker smoke script
      TokenTest.daml                     token minting / holding tests
      TransferTest.daml                  direct transfer flow tests
      Util.daml                          shared test/setup helpers
registry/                                Read-only TypeScript HTTP service serving the CN Token Standard registry API
scripts/
  fetch-dep.sh                           Vendor Splice sources, derive DAR versions, create stable-name symlinks
  build-harness.sh                       Build the Amulet test harness (unused by default; conformance only)
  sandbox.sh                             Build the DAR and run a local Canton sandbox with the JSON Ledger API
  seed.mjs                               Seed a running sandbox with an admin, demo users, and one InstrumentConfig
deps/                                    Vendored Splice sources + built DARs (gitignored; never edit or commit)
multi-package.yaml                       Wires the two packages into one workspace
versions.env                             Single version knob: SPLICE_TAG
package.json                             npm scripts wrapping dpm
```

## Key Abstractions

The package is a clean-room implementation of the CN Token Standard: it defines
its own templates but exposes behavior only through the standard interfaces from
the `splice-api-token-*` DARs. The core module hierarchy:

- **`InstrumentConfig`** (`Registry.daml`) - admin-signed per-instrument
  rules/factory contract (the AmuletRules analog), created directly by its admin.
  `ensure` constrains `decimals` to 0..18. `InstrumentConfig_Mint` is free,
  admin-and-recipient-authorized minting (no economics). Implements the
  `TransferFactory`, `AllocationFactory`, and `BurnMintFactory` interfaces. One
  admin creates one config per instrument and serves all of them through a single
  registry API; the instrument identity is `(admin, instrumentId)`.
- **`TokenTransferPreapproval`** (`Registry.daml`) - receiver opt-in enabling
  one-step transfers, co-signed by `admin, receiver` with an Amulet-style
  validity window.
- **`Token`** (`Token.daml`) - an unlocked holding. Signed by `admin, owner`.
  `ensure amount > 0.0`. Implements `HoldingV1.Holding`.
- **`LockedToken`** (`Locked.daml`) - the escrow holding behind a pending
  transfer or an allocation. Signed by `admin, owner, holders`, with `expiresAt`
  set from the transfer's `executeBefore` or the allocation's `settleBefore`.
  `abortEscrow` is the one reject/withdraw/cancel path back to the owner.
- **`TokenTransferInstruction`** (`Instruction.daml`) - a pending two-step
  transfer, signed by `admin, transfer.sender` with the receiver as observer.
  Implements `TransferInstructionV1.TransferInstruction`.
- **`TokenAllocation`** (`Allocation.daml`) - an escrowed leg of a DvP
  settlement, signed by `admin, allocation.transferLeg.sender` with the executor
  and receiver as observers. Implements `AllocationV1.Allocation`.
- **`transferImpl`** (`Registry.daml`) - the `TransferFactory` instance body,
  lifted out of the interface instance and passed the config's `admin` and
  `instrumentId` as explicit params. Its only caller is that instance.
- **`mkInstrumentId`** (`Types.daml`) - builds the standard `HoldingV1.InstrumentId`
  from an admin party and an id string.

### Data Access Layer

The production package data-depends ONLY on the seven `splice-api-token-*`
interface DARs (holding, metadata, transfer-instruction, allocation,
allocation-instruction, allocation-request, burn-mint) and NOT on `splice-amulet`.
It integrates with the wider CN ecosystem purely by implementing those standard
interfaces: `HoldingV1.Holding`, `TransferInstructionV1.TransferFactory`,
`TransferInstructionV1.TransferInstruction`, `AllocationInstructionV1.AllocationFactory`,
`AllocationV1.Allocation`, and `BurnMintV1.BurnMintFactory`. There is no
off-ledger I/O in the Daml code; all state lives on the ledger as contracts.

## Data Flow

Registration and transfer move through the ledger as follows:

1. **Register an instrument** - the admin creates an `InstrumentConfig`. There is
   no counterparty: the admin is the sole signatory.
2. **Mint** - `InstrumentConfig_Mint` (controlled by `admin, recipient`) creates a
   `Token` holding for the recipient.
3. **Transfer** - `TransferFactory_Transfer` on the `InstrumentConfig` runs
   `transferImpl`, which spends the sender's inputs (fetches and archives each
   input `Token`, checking sender ownership and instrument, and creates a
   sender-change `Token` for any surplus) and then either:
   - completes directly, creating the receiver `Token` and returning
     `TransferInstructionResult_Completed`, when the transfer is a self-transfer
     or the choice context supplies a matching `TokenTransferPreapproval`; or
   - escrows the amount in a `LockedToken` and creates a pending
     `TokenTransferInstruction`, returning `TransferInstructionResult_Pending`.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SPLICE_TAG` | In `versions.env`. The single Splice release tag every vendored DAR version is derived from. Change it, run `npm run setup`. |
| `LANG` | Must be `C.UTF-8` for `dpm`/`damlc` (otherwise data-dependency interface regeneration throws a UTF-8 decoding error). The npm scripts set it. |

These two cover the Daml build only. The registry service and `scripts/seed.mjs`
are configured entirely by environment: the service requires eight variables and
refuses to start without them (`registry/.env.example`), and the seed reads its
overrides from `SEED_*`/`LEDGER_*` ([`RUNBOOK.md`](RUNBOOK.md)).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm install` / `npm run setup` | Vendor Splice into `deps/` and create the stable-name symlinks (`scripts/fetch-dep.sh`). |
| `npm run build` | Build both packages (production, then test). |
| `npm run build:canton-token-forge` | Build only the production package. |
| `npm test` | Build the production DAR, then run the `canton-token-forge-test` suite. |
| `npm run test:coverage` | Same as `npm test` with a template-focused coverage report. |
| `npm run clean` | Remove both `.daml` build dirs. |
| `npm run sandbox` | Build the DAR and run a local Canton sandbox with the JSON Ledger API. |
| `npm run seed` | Seed a running sandbox with an admin, demo users, and one `InstrumentConfig`. |
| `bash scripts/build-harness.sh` | Build the Amulet test harness (unused by default; conformance only). |

---

## Domain-Specific Sections

### Number / Precision Handling

Amounts are Daml `Decimal`. `InstrumentConfig` constrains `decimals` to the range
0..18 via `ensure`. `Token` enforces `amount > 0.0`. Transfers sum the input
holding amounts, require the total to cover the requested amount, and emit a
sender-change holding for any surplus, so no value is created or destroyed in a
transfer.

### Smart Contract Architecture

- **Signatory model:** the admin signs all six templates, and wherever a template
  encumbers another party's position that party co-signs: `InstrumentConfig`
  (`admin` alone, it encumbers nobody),
  `TokenTransferPreapproval` (`admin, receiver`), `Token` (`admin, owner`),
  `LockedToken` (`admin, owner, holders`), `TokenTransferInstruction`
  (`admin, transfer.sender`, receiver observing), `TokenAllocation`
  (`admin, allocation.transferLeg.sender`, executor and receiver observing).
  Holdings are co-signed by their owner, matching Amulet, so the admin cannot
  archive and re-mint an owner's funds unilaterally.
- **Single-party registry:** the instrument admin is also the registry identity
  the metadata API reports as `adminId`, matching CIP-0056 and Amulet, where the
  DSO party is both the instrument admin and the registry app.
- **Rules/factory pattern:** `InstrumentConfig` is the per-instrument rules/factory
  (AmuletRules analog); it implements `TransferFactory`, `AllocationFactory`, and
  `BurnMintFactory`, and exposes minting as a nonconsuming choice.
- **Module boundary:** the helpers that fetch, validate and spend sender inputs
  (`fetchInputs`/`consumeInputs`/`spendInputs`) live in `Token.daml`, and
  `allocateImpl` lives in `Allocation.daml`; `Registry.daml` imports both, so
  the transfer and allocation paths spend inputs through one implementation.
  Each takes the config's `admin`/`instrumentId` as explicit params instead of
  reading them back from the contract.
- **Clean-room, interface-only:** no dependency on `splice-amulet` and no
  economics (no decay, fees, mining rounds, rewards, or DSO governance); issuance
  is free, authorized jointly by the admin and the recipient, plus an optional
  per-instrument faucet policy.
