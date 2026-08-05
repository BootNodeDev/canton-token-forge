# Sandbox runbook

How to bring up a local Canton sandbox, seed it with a canton-token-forge
instrument, and drive it from the registry HTTP service.

Everything below was executed against Canton 3.5.6 (the version `dpm sandbox`
resolves for SDK 3.4.11) on 2026-08-04. Steps that are known NOT to work yet are
marked as such rather than omitted.

## Prerequisites

- `dpm` and a JDK 17+ on `PATH` (see `CLAUDE.md`)
- `deps/` vendored: `npm install`, or `bash scripts/fetch-dep.sh` for deps only
- Node 18+ for the seed script and the registry service

## 1. Start the sandbox

```bash
npm run sandbox        # or: bash scripts/sandbox.sh
```

This builds the production DAR, then runs `dpm sandbox` with the DAR uploaded and
the JSON Ledger API on port 7575. It stays in the foreground; stop it with Ctrl-C.

The sandbox is ready when `.canton-ports.json` appears in the repo root. Startup
takes roughly 15 seconds. Verify from another shell:

```bash
curl -s http://localhost:7575/v2/version
```

Useful overrides: `JSON_API_PORT`, `LEDGER_API_PORT`, `SKIP_BUILD=1` (start
against the DAR that is already built).

Sandbox storage is in-process. Restarting it gives a clean ledger, including
freshly allocated party ids.

## 2. Seed an operator, an admin, and one instrument

In a second shell:

```bash
npm run seed           # or: node scripts/seed.mjs
```

The script allocates the `operator`, `admin`, `user1`, and `user2` parties,
creates a `TokenRegistry`, and registers a `CC` instrument through the
propose/accept flow: the admin exercises `TokenRegistry_ProposeInstrument` (with
the operator-signed registry disclosed to it), then the operator exercises
`InstrumentConfigProposal_Accept`. It prints the resulting contract ids and a
ready-to-paste `registry/.env` block.

The script is find-or-create at every step, so re-running it against an
already-seeded sandbox reports the same contracts instead of creating duplicates.

Useful overrides: `SEED_INSTRUMENT_ID`, `SEED_INSTRUMENT_NAME`, `SEED_SYMBOL`,
`SEED_DECIMALS`, `SEED_FAUCET_MAX` (set empty to register an instrument with no
faucet), `LEDGER_API_URL`, `LEDGER_API_TOKEN`, `LEDGER_USER_ID`.

## 3. Configure and start the registry service

Copy the printed block into `registry/.env`, then:

```bash
cd registry
npm install
npm run build
npm start
```

`registry/` is a separate package with its own dependencies: the root
`npm install` vendors the Daml deps and does not populate `registry/node_modules`.

`GET /healthz` and `GET /readyz` answer, and `GET /registry/metadata/v1/info`
returns the operator party as `adminId` with the six supported APIs.

`GET /registry/metadata/v1/instruments` currently returns an empty list against a
live sandbox even though the instrument exists. See "Known live-node gaps" below.

## 4. Tap the faucet

The faucet is exercised on the ledger, not through the registry service. The
`InstrumentConfig` must be disclosed to the tapping party, which is not a
stakeholder of it:

```
POST /v2/commands/submit-and-wait-for-transaction
{
  "commands": {
    "commands": [{ "ExerciseCommand": {
      "templateId": "#canton-token-forge:Canton.TokenForge.Registry:InstrumentConfig",
      "contractId": "<InstrumentConfig cid from the seed output>",
      "choice": "InstrumentConfig_Tap",
      "choiceArgument": { "user": "<user1 party>", "amount": "25.0" }
    }}],
    "actAs": ["<user1 party>"],
    "userId": "participant_admin",
    "commandId": "<unique>",
    "disclosedContracts": [{
      "templateId": "...InstrumentConfig",
      "contractId": "<same cid>",
      "createdEventBlob": "<from the active-contracts query>",
      "synchronizerId": "<from the active-contracts query>"
    }]
  }
}
```

Verified: this creates a `Token` holding of `25.0000000000 CC` for `user1`,
readable with an active-contracts query on
`#canton-token-forge:Canton.TokenForge.Token:Token`.

## 5. Transfer

Not yet exercised end to end. The transfer path runs through the registry
service's transfer-factory and choice-context routes, which are blocked by the
gaps below. The end-to-end transfer test is separate work.

## JSON Ledger API conventions this sandbox enforces

These were established by trial against the running participant and are the
reason the seed script looks the way it does.

- **Template ids in an active-contracts filter must use the package NAME**,
  written `#<package-name>:<module>:<entity>`. A package-id-qualified identifier
  is rejected with "Received an identifier with package ID ..., but expected a
  package name". This is why every id in the generated `.env` block starts with
  `#canton-token-forge:`.
- **The active contract set must be snapshotted at the current ledger end**,
  read from `GET /v2/state/ledger-end`. At offset 0 the set is always empty.
- **The command submission body nests the command list**: the payload is
  `{"commands": {"commands": [...], "actAs": [...], "commandId": ..., "userId": ...,
  "disclosedContracts": [...]}}`. A flat body is rejected with "Missing required
  field at 'commands.commands'".
- **`userId` must be sent explicitly** when the participant runs without
  authentication, since there are no claims to default it from. The sandbox
  accepts `participant_admin`.
- **`Int64` fields are JSON strings**, not numbers. Sending `decimals: 10`
  fails with "Expected ujson.Str (data: 10)"; send `"10"`.
- Disclosed contracts are `{templateId, contractId, createdEventBlob,
  synchronizerId}`, taken straight from an active-contracts row queried by a
  party that can see the contract.
- The sandbox needs no bearer token. `LEDGER_API_TOKEN` is still required by the
  service config, so any placeholder value works locally.

## Known live-node gaps

The registry service was built and tested against an in-memory stub, so the
conventions above are not all reflected in it yet.

- **Active-contract queries run at offset 0** (`registry/src/ledger.ts`), so every
  read returns empty against a live node. Confirmed by patching the built output
  to read `/v2/state/ledger-end` first: with that single change,
  `GET /registry/metadata/v1/instruments` and
  `GET /registry/metadata/v1/instruments/CC` both return the seeded `CC`
  instrument correctly.
- **The command envelope in `submitAndWait` is flat and omits `userId`**, so every
  write path fails against a live node.
- **`TRANSFER_INSTRUCTION_INTERFACE_ID` and `ALLOCATION_INTERFACE_ID` are named
  for interfaces but must hold concrete template ids**, in package-name form. The
  filter type itself is correct: a `TemplateFilter` carrying a package-name id
  matches, which is what the seeded `.env` block above uses.

## Troubleshooting

- **`.canton-ports.json` never appears**: check the sandbox shell output. The
  script removes the ports file both at startup and on exit, so its presence
  always means a sandbox is up.
- **"a sandbox is already serving on port 7575"**: another sandbox is running.
  Stop it, or start this one on a different `JSON_API_PORT`.
- **"Party already exists"**: expected on a re-run. `scripts/seed.mjs` reuses an
  existing party for a hint instead of allocating it again.
- **"expected exactly one TokenRegistry"**: more than one registry was created,
  usually by an interrupted earlier run. Restart the sandbox for a clean ledger.
- **DAR not found**: run `npm run build:canton-token-forge`, or let
  `scripts/sandbox.sh` build it (do not pass `SKIP_BUILD=1`).
- Canton logs to `log/canton.log` in the repo root, which is gitignored.
