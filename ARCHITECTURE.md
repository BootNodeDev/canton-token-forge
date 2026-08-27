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
      Locked.daml                        LockedToken escrow shared by pending transfers, allocations, and batch transfer locked outputs
      Instruction.daml                   TokenTransferInstruction template + TransferInstruction interface instance
      Transfer.daml                      Batch transfer value types, controller rule, and execution helper (the AmuletRules transfer analog)
      Allocation.daml                    TokenAllocation template + Allocation interface instance
      Types.daml                         mkInstrumentId helper (admin + id -> InstrumentId)
      TxMeta.daml                        tx-kind annotations for the choices the standard does not define
      Version.daml                       package version marker
  canton-token-forge-test/               Integration-test package (name: canton-token-forge-test)
    daml.yaml                            data-deps on the compiled production DAR + the interface DARs
    daml/Canton/TokenForge/Test/
      AllocationTest.daml                allocation flow tests
      BatchTransferTest.daml             Batch transfer shapes, conservation, and authorization negatives
      BurnMintTest.daml                  burn-mint factory tests
      FaucetTest.daml                    faucet tap tests
      LockTest.daml                      LockedToken escrow tests
      MultiInstrumentTest.daml           multi-instrument isolation tests
      OfferTest.daml                     pending-offer (2-step) transfer tests
      RegistryTest.daml                  registry / instrument config tests
      Smoke.daml                         version-marker smoke script
      TokenTest.daml                     token minting / holding tests
      TransferTest.daml                  direct transfer flow tests
      TxMetaTest.daml                    tx-kind metadata assertions per annotated choice
      Util.daml                          shared test/setup helpers
registry/                                Read-only TypeScript HTTP service serving the CN Token Standard registry API
  src/
    config.ts                            Env-var config, validated at boot (see Environment Variables)
    ledger.ts                            JSON Ledger API client: ledger end, active contracts, one contract by id, party lookup, disclosures
    startup.ts                           Boot checks: the configured template ids resolve, the admin party exists on the participant and the token can read as it
    payloads.ts                          JSON shapes of the on-ledger payloads the service reads
    mapping.ts                           ACS payload -> API shapes; resolveConfig picks the (admin, instrumentId) config
    disclose.ts                          The single AnyValue encoding site + the three choice-context keys
    logger.ts                            The structural Logger interface plus the pino instance
    openapi.ts, server.ts, index.ts      Spec loading, middleware stack, process lifecycle
    routes/
      metadata.ts                        /info, /instruments, /instruments/:id
      transfer.ts                        Transfer factory + accept/reject/withdraw choice contexts
      allocation.ts                      Allocation factory + execute-transfer/withdraw/cancel choice contexts
      lookup.ts, respond.ts              Shared ACS lookups and the 404/409 response helpers
      async-handler.ts                   Wraps every route so a rejected promise reaches the error middleware
  openapi/                               The CN Token Standard OpenAPI specs the service validates against
  test/                                  Unit suites (stub ledger) + test/e2e (live participant, skip-guarded)
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
its own templates but exposes its standardized behavior through the standard
interfaces from the `splice-api-token-*` DARs. The core module hierarchy:

- **`InstrumentConfig`** (`Registry.daml`) - admin-signed per-instrument
  rules/factory contract (the AmuletRules analog), created directly by its admin.
  `ensure` constrains `decimals` to 0..10. It carries the four choices we define
  on it: `InstrumentConfig_Mint` (free, admin-and-recipient-authorized issuance,
  no economics), `InstrumentConfig_Tap` (the optional faucet, controlled by the
  tapping user alone and capped per tap), `InstrumentConfig_Preapprove`
  (controlled by the receiver, creating the opt-in that enables direct
  transfers), and `InstrumentConfig_Transfer` (the multi-output transfer that
  can emit locked outputs, controlled by the sender together with every output
  receiver and lock holder). Implements the
  `TransferFactory`, `AllocationFactory`, and `BurnMintFactory` interfaces. One
  admin creates one config per instrument and serves all of them through a single
  registry API; the instrument identity is `(admin, instrumentId)`.
- **`TokenTransferPreapproval`** (`Registry.daml`) - receiver opt-in enabling
  one-step transfers, co-signed by `admin, receiver` with an Amulet-style
  validity window.
- **`Token`** (`Token.daml`) - an unlocked holding. Signed by `admin, owner`.
  `ensure amount > 0.0`. Implements `HoldingV1.Holding`.
- **`LockedToken`** (`Locked.daml`) - the escrow holding behind a pending
  transfer, an allocation, or a batch transfer's locked output. Signed by
  `admin, owner, holders`, with `expiresAt` set from the transfer's
  `executeBefore`, the allocation's `settleBefore`, or, for a batch transfer's
  locked output, the caller-supplied `TokenLock.expiresAt` directly. Three
  helpers return it to its owner, and which one a caller takes is the
  difference between the abort paths: `unlockHolding` (no deadline, transfer
  reject), `reclaimAtDeadline` (both withdraws) and `abortEscrow` (the joint
  allocation cancel alone). Its owner can also reclaim it directly through
  `LockedToken_ExpireLock` once `expiresAt` has passed. `optContext` surfaces as
  the standard `Lock.context`. Three sites create a `LockedToken`: the pending
  two-step transfer (`Registry.daml`) and the allocation (`Allocation.daml`)
  both force it to `None`, while the batch transfer's locked outputs
  (`Transfer.daml`) forward the caller-supplied `TokenLock.optContext` verbatim.
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
4. **Settle or unwind a pending transfer** - the receiver accepts
   (`TransferInstruction_Accept`, which archives the escrow and creates the
   receiver's `Token`) or rejects it, and the sender may withdraw it. Accept
   mints against the escrow rather than moving it, so it first checks that the
   escrow carries the transfer's amount, instrument, and owner, and that the
   instruction's admin is the instrument's own. Archiving the escrow proves only
   that its owner authorized the transaction, and the receiver is one of those
   authorizers, so the owner check is what ties the escrow to the sender.
   The two unwind paths take different helpers from `Locked.daml`, and the split is
   deliberate: reject returns the escrow to the sender immediately
   (`unlockHolding`), since a receiver declining delivery leaves nowhere else
   for the funds to go, while withdraw is the sender acting alone and so is
   gated on `executeBefore` (`reclaimAtDeadline`). Only withdraw can clear the
   instruction with nothing to return when the choice context reports that the
   sender already reclaimed the escrow: reject is controlled by the receiver,
   who could otherwise report a live escrow as gone and archive the record
   without refunding it.
5. **Allocate for settlement** - `AllocationFactory_Allocate` escrows a
   `LockedToken` and creates a `TokenAllocation` holding one leg of a DvP.
   `Allocation_ExecuteTransfer` delivers it to the receiver,
   `Allocation_Withdraw` and `Allocation_Cancel` unwind it.
6. **Faucet** - `InstrumentConfig_Tap` is controlled by the tapping user alone
   and mints up to the instrument's per-tap cap, when the config declares a
   faucet. It is the one path that gives a party funds without the admin acting,
   which is what lets an unfunded party bootstrap itself in a demo.
7. **Burn and mint** - `BurnMintFactory_BurnMint` archives input holdings and
   creates outputs in one atomic step, authorized by the admin plus the
   `extraActors` the standard expects to carry the input and output owners.
8. **Batch transfer** - `InstrumentConfig_Transfer` runs `executeTokenTransfer`
   (`Transfer.daml`), controlled by the sender together with every output
   receiver and every output lock holder. It archives the sender's inputs and
   creates the outputs in order, each either a `Token` or a `LockedToken`
   carrying the caller's own `expiresAt` and `optContext` verbatim, with any
   leftover input value returned to the sender as change. A lock's `holders` is
   the one field not copied verbatim: it is deduplicated, sorted, and stripped
   of the output's own receiver, the way Amulet's `dedupOutputLockHolders` does
   it, so a lock naming nobody but the receiver is created with an empty holder
   list and its owner can release it alone. Unlike steps 3 to 5, this choice is
   registry-native rather than a standard interface, and `registry/src` has no
   reference to it: the registry service does not drive it, so a client submits
   it directly against the participant.

Steps 3 to 5 are the paths a client drives through the registry service. The two
factory routes supply a `factoryId` alongside the choice context; the accept,
reject, withdraw, execute-transfer and cancel routes supply the choice context
and its disclosures alone, since the client already holds the instruction or
allocation contract id it is exercising.

## Choice Contexts

The standard's factory and instruction choices take an `ExtraArgs` carrying a
`ChoiceContext` (`values : TextMap AnyValue`); the contracts it points at are
disclosed separately, in the submission's own `disclosedContracts`. Between them
that is how a choice body reaches a contract the submitting party does not know
about or cannot see: LF 2.1 has no contract keys, so nothing on-ledger can look
a contract up by identity, and so the context carries the contract id while the
disclosure is what makes that contract readable. For a real client the registry
service serves both halves in one response, and `registry/src/disclose.ts` is
its single `AnyValue` encoding site. The Daml suite builds the same contexts
directly, in three places: `Test/Util.daml`'s `expireLockArgs` for the
expire-lock signal and `escrowReclaimedArgs` for the reclaimed-escrow report,
`Test/AllocationTest.daml`'s `bothSignalArgs` for the two together, and the
preapproval context inline at each direct-transfer call site in
`Test/TransferTest.daml`.

Three context keys are ours rather than the standard's, and each is a named
constant on both sides rather than a literal: `preapprovalContextKey`
(`Registry.daml`), `expireLockContextKey` and `escrowReclaimedContextKey`
(`Locked.daml`) in Daml, `PREAPPROVAL_CONTEXT_KEY`, `EXPIRE_LOCK_CONTEXT_KEY`
and `ESCROW_RECLAIMED_CONTEXT_KEY` in `disclose.ts`.

| Key | Value | Read by |
|-----|-------|---------|
| `canton-token-forge/transfer-preapproval` | `AV_ContractId` of a `TokenTransferPreapproval` | `transferImpl`, to take the direct path |
| `canton-token-forge/expire-lock` | `AV_Bool true` | `abortEscrow`, to release an escrow before its deadline |
| `canton-token-forge/escrow-reclaimed` | `AV_Bool true` | `returnEscrowUnlessReclaimed`, to clear a record whose escrow is already gone |

What each route returns:

| Route | Context data | Discloses |
|-------|--------------|-----------|
| transfer factory, `direct` | the preapproval cid | `InstrumentConfig` + the preapproval |
| transfer factory, `offer` / `self` | empty | `InstrumentConfig` |
| transfer accept / reject / withdraw | empty | the escrow `LockedToken` |
| allocation factory | empty | `InstrumentConfig` |
| allocation execute-transfer / withdraw | empty | the escrow `LockedToken` |
| allocation cancel | the expire-lock signal | the escrow `LockedToken` |
| transfer withdraw / allocation withdraw whose escrow is archived | the reclaimed-escrow report | nothing |
| allocation cancel whose escrow is archived | the report + the expire-lock signal | nothing |
| any other of these whose escrow is not live | 404 `escrow not found` | nothing |

The first two of those rows exist because the escrow has a second exit: after
the settlement deadline its owner can reclaim it through `LockedToken_ExpireLock`
without going near the record. `findEscrow` already resolves the escrow on every
one of these routes, so the service reports what it found, and the choice skips
the escrow rather than reaching for a contract that is gone. The third row is
every other way an escrow can fail to be live: accept, reject and
execute-transfer, which have nothing left to act on and no authority to clear
the record without the escrow, and any route whose lookup found nothing at all,
which is not evidence of a reclaim. Both answer 404 rather than report one.

What it reports is the state, not the mere absence of an answer. `findEscrow`
returns the participant's three: `live`, `archived`, and `absent`. Only
`archived` earns the report, because only the archive event is evidence the
escrow was ever there and is gone now. The participant supplies that evidence
for free, since a by-id read answers an archived contract 200 with its created
event and an archive event beside it, while a contract of another template, one
the admin cannot see, and one that never existed all answer 404 alike. Reading
that 404 as a reclaim is what let a `LOCKED_TOKEN_TEMPLATE_ID` naming another
real template manufacture a report for every live escrow on the ledger.

Honoring a report nothing on-ledger backs is safe under two rules, both enforced
by `returnEscrowUnlessReclaimed` and its callers. First, the reported branch runs
the same gate the escrow-returning branch would, so a report can never buy an
abort the honest path would have refused; that is why `cancel` still sends its
expire-lock signal when the escrow is gone, since without it the gate is the
settlement deadline. Second, the report is honored only on a choice the escrow's
owner authorizes: forging it then archives a record the owner is party to and
strands the owner's own funds in a lock they can still reclaim. Where that
authority is delegated, as sender and receiver typically delegate the allocation
cancel to the executor, that rule buys less: an executor reporting a live escrow
as gone archives the allocation without releasing it, so the sender waits for
`settleBefore` and `LockedToken_ExpireLock` instead of being refunded on the
spot. That is delay rather than loss. Transfer `reject` is the exception to the
second, being controlled by the receiver alone, and the first cannot stand in
for it: reject's escrow-returning branch runs no gate at all, so honoring the
report there would buy an abort that refunds nothing rather than one that comes
early. It returns the escrow unconditionally, and its route answers 404 like the
settlement routes (transfer accept, allocation execute-transfer), which answer
404 because they have nothing to settle out of.

Two asymmetries in that table are deliberate:

- **The factory routes disclose the `InstrumentConfig` because they must name one
  contract as `factoryId`; the instruction and allocation routes disclose only
  the escrow.** None of the accept, reject or withdraw choice bodies fetches a
  config, so disclosing one would add a lookup that can fail without adding
  authority. That matters because the lookup routes through `resolveConfig`,
  which answers 409 when two configs share an `(admin, instrumentId)`: a route
  that fetches a reference contract no choice reads imports that contract's
  failure modes into an operation that does not depend on it.
- **Only `cancel` carries the early-release signal.** It is the only path that
  returns an escrow to the sender under joint authorization: its controllers are
  the executor, sender and receiver together, and their co-signature is what
  makes honoring a caller-supplied signal safe. `withdraw` returns the escrow
  too but the sender acts alone, so it is deadline-gated on-ledger and ignores
  the signal; `execute-transfer` shares `cancel`'s joint controllers but
  delivers to the receiver rather than unwinding, so it never needs one.

The escrow disclosures exist because a receiver is not a stakeholder of the
`LockedToken` holding its incoming funds. On the JSON Ledger API a missing
disclosure surfaces as a 404 on submission rather than as an authorization
error, since from the submitting party's side the contract simply does not exist.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SPLICE_TAG` | In `versions.env`. The single Splice release tag every vendored DAR version is derived from. Change it, run `npm run setup`. |
| `LANG` | Must be `C.UTF-8` for `dpm`/`damlc` (otherwise data-dependency interface regeneration throws a UTF-8 decoding error). The npm scripts set it. |

These two cover the Daml build only. The registry service and `scripts/seed.mjs`
are configured entirely by environment: the service requires eight variables,
refuses to start without them, and additionally validates the five template ids
and `ADMIN_PARTY` against the participant at boot (`registry/.env.example`), and the seed reads its
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

Amounts are Daml `Decimal`, which is `Numeric 10`, so every holding amount
carries ten decimal places whatever its instrument declares. `InstrumentConfig`
constrains `decimals` to the range 0..10 via `ensure`, matching that ceiling and
the token standard's own cap. `decimals` is display guidance for clients
deciding how to render and accept amounts; it is not a scale enforced on
amounts, so a `decimals = 0` instrument can still hold `42.5`. `Token` enforces
`amount > 0.0`. Transfers sum the input
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
- **Single-party registry:** one party carries every role. It is the
  `InstrumentId.admin`, signs `InstrumentConfig` and every holding, is the party
  the service reads the active contract set as, and is what the metadata API
  reports as `adminId`. There is no separate operator. This matches CIP-0056,
  which models a single instrument admin, and Amulet, where the DSO party is both
  the instrument admin and the registry app. Reading as any other party is not a
  configuration choice but a broken one: the admin is a signatory of every
  contract the service serves, and a non-stakeholder's queries come back empty.
- **Rules/factory pattern:** `InstrumentConfig` is the per-instrument rules/factory
  (AmuletRules analog); it implements `TransferFactory`, `AllocationFactory`, and
  `BurnMintFactory`, and exposes minting as a nonconsuming choice.
- **Module boundary:** the helpers that fetch, validate and spend sender inputs
  (`fetchInputs`/`consumeInputs`/`spendInputs`) live in `Token.daml`,
  `allocateImpl` lives in `Allocation.daml`, and the batch transfer's execution
  helper `executeTokenTransfer` lives in `Transfer.daml`, itself built on
  `consumeInputs`; `Registry.daml` imports all three, so the standard transfer
  (both its direct and its pending path, which share one `spendInputs` call
  ahead of the branch), the batch transfer and the allocation path spend
  inputs through one implementation. Each takes the config's
  `admin`/`instrumentId` as explicit params instead of reading them back from
  the contract.
- **Clean-room, interface-only:** no dependency on `splice-amulet` and no
  economics (no decay, fees, mining rounds, rewards, or DSO governance); issuance
  is free, authorized jointly by the admin and the recipient, plus an optional
  per-instrument faucet policy.
