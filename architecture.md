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
      Registry.daml                      TokenRegistry anchor + InstrumentConfig rules/factory; TransferFactory instance
      Token.daml                         Token holding template; HoldingV1.Holding interface instance
      Transfer.daml                      transferDirectImpl: input-holding consume/validate/split logic
      Types.daml                         mkInstrumentId helper (admin + id -> InstrumentId)
      Version.daml                       package version marker
  canton-token-forge-test/               Integration-test package (name: canton-token-forge-test)
    daml.yaml                            data-deps on the compiled production DAR + the interface DARs
    daml/Canton/TokenForge/Test/
      Smoke.daml                         version-marker smoke script
      RegistryTest.daml                  registry / instrument registration tests
      TokenTest.daml                     token minting / holding tests
      TransferTest.daml                  transfer flow tests
scripts/
  fetch-dep.sh                           Vendor Splice sources, derive DAR versions, create stable-name symlinks
  build-harness.sh                       Build the Amulet test harness (unused by default; conformance only)
deps/                                    Vendored Splice sources + built DARs (gitignored; never edit or commit)
multi-package.yaml                       Wires the two packages into one workspace
versions.env                             Single version knob: SPLICE_TAG
package.json                             npm scripts wrapping dpm
```

## Key Abstractions

The package is a clean-room implementation of the CN Token Standard: it defines
its own templates but exposes behavior only through the standard interfaces from
the `splice-api-token-*` DARs. The core module hierarchy:

- **`TokenRegistry`** (`Registry.daml`) - operator-signed anchor. Serves as the
  `getRegistryInfo` identity and the creation entry point for instruments. Its
  `TokenRegistry_RegisterInstrument` choice is co-authorized by `operator, admin`
  so the admin-signed `InstrumentConfig` can be created.
- **`InstrumentConfig`** (`Registry.daml`) - admin-signed per-instrument
  rules/factory contract (the AmuletRules analog); the operator is an observer.
  `ensure` constrains `decimals` to 0..18. `InstrumentConfig_Mint` is free,
  admin-authorized minting (no economics). Implements the `TransferFactory`
  interface, delegating to `transferDirectImpl`.
- **`Token`** (`Token.daml`) - an unlocked holding. Signed by the instrument
  admin (the DSO analog); the owner is an observer. `ensure amount > 0.0`.
  Implements `HoldingV1.Holding`.
- **`transferDirectImpl`** (`Transfer.daml`) - shared transfer logic, passed the
  config's `admin` and `instrumentId` as explicit params to avoid a module import
  cycle with `Registry`.
- **`mkInstrumentId`** (`Types.daml`) - builds the standard `HoldingV1.InstrumentId`
  from an admin party and an id string.

### Data Access Layer

The production package data-depends ONLY on the seven `splice-api-token-*`
interface DARs (holding, metadata, transfer-instruction, allocation,
allocation-instruction, allocation-request, burn-mint) and NOT on `splice-amulet`.
It integrates with the wider CN ecosystem purely by implementing those standard
interfaces (`HoldingV1.Holding`, `TransferInstructionV1.TransferFactory`). There
is no off-ledger I/O in the Daml code; all state lives on the ledger as contracts.

## Data Flow

Registration and transfer move through the ledger as follows:

1. **Register an instrument** - `TokenRegistry_RegisterInstrument` (controlled by
   `operator, admin`) creates an `InstrumentConfig` for the instrument.
2. **Mint** - `InstrumentConfig_Mint` (controlled by `admin`) creates a `Token`
   holding for the recipient.
3. **Transfer** - `TransferFactory_Transfer` on the `InstrumentConfig` runs
   `transferDirectImpl`, which:
   - asserts `expectedAdmin` matches the config admin, the transfer instrument
     matches this config, and the amount is positive;
   - fetches and archives each input `Token`, checking sender ownership and
     instrument, and sums their amounts;
   - asserts the input total covers the transfer amount;
   - creates the receiver `Token`, plus a sender-change `Token` when the input
     total exceeds the transfer amount;
   - returns `TransferInstructionResult_Completed` with the resulting holding cids.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SPLICE_TAG` | In `versions.env`. The single Splice release tag every vendored DAR version is derived from. Change it, run `npm run setup`. |
| `LANG` | Must be `C.UTF-8` for `dpm`/`damlc` (otherwise data-dependency interface regeneration throws a UTF-8 decoding error). The npm scripts set it. |

## Scripts

| Command | Purpose |
|---------|---------|
| `npm install` / `npm run setup` | Vendor Splice into `deps/` and create the stable-name symlinks (`scripts/fetch-dep.sh`). |
| `npm run build` | Build both packages (production, then test). |
| `npm run build:canton-token-forge` | Build only the production package. |
| `npm test` | Build the production DAR, then run the `canton-token-forge-test` suite. |
| `npm run test:coverage` | Same as `npm test` with a template-focused coverage report. |
| `npm run clean` | Remove both `.daml` build dirs. |
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

- **Signatory / observer model:** `TokenRegistry` (signatory `operator`),
  `InstrumentConfig` (signatory `admin`, observer `operator`), `Token` (signatory
  `admin`, observer `owner`).
- **Co-authorized registration:** `TokenRegistry_RegisterInstrument` is controlled
  by both `operator` and `admin` so the operator-signed registry can create an
  admin-signed `InstrumentConfig`.
- **Rules/factory pattern:** `InstrumentConfig` is the per-instrument rules/factory
  (AmuletRules analog); it implements `TransferFactory` and exposes minting as a
  nonconsuming choice.
- **Module boundary:** transfer logic lives in `Transfer.daml` and receives the
  config's `admin`/`instrumentId` as params to avoid an import cycle with
  `Registry.daml`.
- **Clean-room, interface-only:** no dependency on `splice-amulet` and no
  economics (no decay, fees, mining rounds, rewards, or DSO governance); issuance
  is free/admin-authorized plus an optional per-instrument faucet policy.
