# Sandbox runbook

How to bring up a local Canton sandbox, seed it with a canton-token-forge
instrument, and serve it through the read-only registry HTTP service. Anything
that changes ledger state is submitted directly to the participant, as
`scripts/seed.mjs` does.

The runs recorded below were executed against Canton 3.5.6. That version is not
pinned by this repo: `dpm sandbox` resolves the current patch of the 3.5 line
for SDK 3.4.11, which has since moved to 3.5.12, so a sandbox started today
reports a newer version than the runs recorded here. Sections 1 to 5 were last
run end to end on 2026-08-11 from a clean clone, with nothing built or vendored
beforehand; the wire conventions and troubleshooting notes below them were
established by probing the same participant version on 2026-08-05 and have not
been re-probed since.

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

## 2. Seed an admin and one instrument

In a second shell:

```bash
npm run seed           # or: node scripts/seed.mjs
```

The script allocates the `admin`, `user1`, and `user2` parties and creates one
`CC` `InstrumentConfig` signed by the admin. It prints the resulting contract id
and a ready-to-paste `registry/.env` block.

The script is find-or-create at every step, so re-running it against an
already-seeded sandbox reports the same contracts instead of creating duplicates.

Useful overrides: `SEED_INSTRUMENT_ID`, `SEED_INSTRUMENT_NAME`, `SEED_SYMBOL`,
`SEED_DECIMALS`, `SEED_FAUCET_MAX` (set empty to register an instrument with no
faucet), `LEDGER_API_URL`, `LEDGER_API_TOKEN`, `LEDGER_USER_ID`.

## 3. Configure and start the registry service

Copy the printed block into `registry/.env`, keeping the quoting as printed: the
template ids are single-quoted because they start with `#`, which dotenv would
otherwise read as the start of a comment.

One line is a placeholder rather than a value. If you ran the seed with
`LEDGER_API_TOKEN` set, the block says `<the LEDGER_API_TOKEN you passed in>`
instead of echoing your credential into the terminal, so put the real token
there yourself. Copied as printed it is accepted at boot and then sent as the
bearer token on every call, which an authenticated participant rejects. Then:

```bash
cd registry
npm install
npm run build
npm start
```

`registry/` is a separate package with its own dependencies: the root
`npm install` vendors the Daml deps and does not populate `registry/node_modules`.

`GET /healthz` and `GET /readyz` answer, `GET /registry/metadata/v1/info` returns
the admin party as `adminId` with the six supported APIs, and
`GET /registry/metadata/v1/instruments` and `/instruments/CC` return the seeded
instrument. The list is paged: pass `pageSize` (25 by default, 100 at most) and
follow the `nextPageToken` in the response as `pageToken` to read the rest.

The service is read-only: it serves instrument metadata, factory ids, and choice
contexts, and submits nothing. Registering a second instrument is a `create` on
the ledger as the admin, the same command `scripts/seed.mjs` issues. Set
`SEED_INSTRUMENT_ID=CC2` (with `SEED_INSTRUMENT_NAME`, `SEED_SYMBOL` and
`SEED_DECIMALS` to match, or the new instrument inherits the defaults of the
first one) and
re-run the seed; `CC2` then appears in `GET /registry/metadata/v1/instruments`
alongside `CC`, since one admin serves every instrument it has created.

## 4. Tap the faucet

The faucet is exercised on the ledger, not through the registry service. The
`InstrumentConfig` must be disclosed to the tapping party, which is not a
stakeholder of it. A disclosure needs the contract's `createdEventBlob`, and an
active-contracts query only returns one when the filter asks for it, so add
`"includeCreatedEventBlob": true` next to the `templateId` in the `TemplateFilter`
value. `scripts/seed.mjs` omits that flag because it discloses nothing.

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

Both transfer paths are exercised end to end by the registry service's
end-to-end suite. With a sandbox running:

```
cd registry && npm run test:e2e
```

The suite plays the part of an app backend's client. It asks the service for
the transfer factory and for each choice context, then submits the resulting
exercise itself, forwarding the service's `choiceContextData` and
`disclosedContracts` untouched. Two flows are covered: a direct transfer, which
completes in one step against a receiver's `TokenTransferPreapproval`, and a
two-step offer, which escrows the sender's funds and delivers them when the
receiver accepts.

Every run allocates its own admin, sender and receiver parties and creates its
own instrument, so it neither reads nor disturbs a seeded `CC`. Nothing needs
seeding first, and re-running is safe. Nothing is archived afterwards either:
each run leaves its parties, instrument and holdings on the participant, so the
suite assumes a sandbox you can throw away rather than a long-lived one.

The suite is not part of `npm test`, which stays hermetic. When no participant
answers on `LEDGER_API_URL` (default `http://localhost:7575`), it prints a
warning naming that URL and reports every test as skipped rather than failing.
Something answering that address without being a usable participant fails the
run instead, so a skipped run always means nothing was listening.

A non-default port has to be exported into the environment
(`LEDGER_API_URL=http://localhost:7576 npm run test:e2e`). Only the service
loads `registry/.env`; recording the port there alone leaves the suite probing
the default and reporting every test as skipped against a healthy sandbox.

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
- **One contract is read by id with `POST /v2/events/events-by-contract-id`**,
  whose body is `{"contractId": ..., "eventFormat": {...}}` and whose
  `eventFormat` takes the same party-and-template filter as an active-contracts
  query. It answers the contract's whole history, so an **archived** contract
  still comes back `200` with its created event and a non-null `archived`: that
  field is the only thing separating it from a live one. A contract that does
  not exist, that the party cannot see, and one of another template are all the
  same `404 CONTRACT_EVENTS_NOT_FOUND`; a contract id the participant cannot
  parse is `400 INVALID_FIELD`.
- **The command submission body nests the command list**: the payload is
  `{"commands": {"commands": [...], "actAs": [...], "commandId": ..., "userId": ...,
  "disclosedContracts": [...]}}`. A flat body is rejected with "Missing required
  field at 'commands.commands'".
- **`userId` must be sent explicitly** when the participant runs without
  authentication, since there are no claims to default it from. The sandbox
  accepts `participant_admin`.
- **`Int64` fields are JSON strings**, not numbers. Sending `decimals: 10`
  fails with "Expected ujson.Str (data: 10)"; send `"10"`.
- **`Decimal` fields take either, but a JSON number is only safe below 1e7.**
  A number is rendered from a double before it reaches the Numeric parser, and
  that rendering is exponential from 1e7 up and below 1e-3, which the parser
  rejects: `maxPerTap: 10000000` fails with "Could not read Numeric string
  \"1.0E7\"" while `maxPerTap: 1000` succeeds. A decimal string is read
  literally at any magnitude, so send `"10000000.0"`.
- Disclosed contracts are `{templateId, contractId, createdEventBlob,
  synchronizerId}`, taken straight from an active-contracts row, or from the
  created event of a by-id read, queried by a party that can see the contract. Those rows report the template id in
  package-**id** form, and disclosing it that way is accepted. The package-name
  rule above applies to the filter you send, not to the id that comes back.
- **A choice declared on an interface is exercised under the INTERFACE id**, not
  under the id of the template implementing it: `ExerciseCommand.templateId` for
  `TransferFactory_Transfer` on an `InstrumentConfig` contract is
  `#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory`.
  Naming the template instead is rejected with "Invalid
  template:...:Canton.TokenForge.Registry:InstrumentConfig or
  choice:TransferFactory_PublicFetch", which reads as a plain resolution failure
  and does not point at the interface. Consuming and nonconsuming choices behave
  the same, and both the package-name and the (deprecated) package-id form of the
  interface id are accepted.
- The sandbox needs no bearer token. `LEDGER_API_TOKEN` is still required by the
  service config, so any placeholder value works locally.
- **A `ChoiceContext`'s `values` are a Daml `TextMap AnyValue`, and the
  participant accepts the variant written as `{"tag": "AV_ContractId", "value":
  "<cid>"}`.** Confirmed against Canton 3.5.6 inside a real
  `TransferFactory_Transfer`. `registry/src/disclose.ts` is the single site that
  encodes it; the same file also encodes `AV_Bool` for the allocation cancel
  signal, which has not been exercised live.
- **A Daml `Time` field accepts a millisecond-precision ISO-8601 string**, which
  is what `new Date().toISOString()` produces, even though the ledger stores and
  reports microseconds. The end-to-end suite relies on this for `validFrom`,
  `expiresAt`, `requestedAt` and `executeBefore`.

## What the service configuration has to match

- `ADMIN_PARTY` is checked against the participant at boot, because every read
  runs as it and a party the participant does not know reads as an empty active
  set rather than an error: without the check a typo'd fingerprint booted green,
  advertised the typo as `adminId`, and answered an empty instrument list with a
  404 on everything else. The service now logs
  `ADMIN_PARTY names a party this participant does not know` and exits 1. A
  participant that is unreachable, or that refuses the party lookup because
  party management is admin-only, is logged as a warning and the service starts:
  `/readyz` remains the signal for a ledger that is down. The lookup is scoped
  to the caller's identity provider, so an empty answer is fatal only when
  reading as the party also returns no instrument configs: a party that owns
  configs exists and is readable whatever the lookup could see. A check that has
  not answered within five seconds warns and the boot continues, and a verdict
  landing after that is logged as a warning, because the service is by then
  serving and nothing can still stop it starting.
- All five template ids are package-name form, and the service refuses to start
  otherwise rather than serving empty results from a filter that matches nothing.
  Each is also put to the participant at boot, because the form being right does
  not mean the participant hosts it: an id naming a package, module or entity it
  does not host answers `404 PACKAGE_NAMES_NOT_FOUND` or
  `404 NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME` on every read, so the
  service used to start clean and then 500 each route with only the
  participant's wording to say which of the five was wrong. It now logs
  `<VARIABLE> names a template this participant does not host` and exits 1,
  reporting every id at fault in the one boot so a drifted `.env` takes one
  restart to fix rather than one per variable. The same warn-and-continue rule
  as above applies to anything the participant does not attribute to the id
  itself: an unreachable participant, a refused read, or a plain 404 carrying
  neither code. Each id costs one request and no contract: the query is
  snapshotted at the beginning of the ledger, where nothing is active, so the
  boot does not slow down as the registry accumulates escrows, instructions and
  allocations the admin is a stakeholder of. The two checks run in sequence and
  each carries its own five-second budget, so a participant that drops packets
  rather than refusing them holds the boot for up to ten seconds before the
  service listens: size a startup probe against that, not against one check's
  five. One consequence
  worth planning a deploy around: a registry started before its DAR is uploaded
  now crashloops until the upload lands.
  They are concrete template ids, never interface ids: the choice-context
  handlers read payload fields that exist on the template create arguments and
  not on the standard interface views.
- `LEDGER_USER_ID` has no effect on the running service, which submits nothing.
  The seed prints it as a record of the user it submitted under, not as an input
  the service reads back. Setting it in `registry/.env` changes nothing at all:
  only the service loads that file, and `scripts/seed.mjs` reads the process
  environment directly. To change what the seed sends, pass it on the command
  line: `LEDGER_USER_ID=myuser npm run seed`. An unauthenticated sandbox has no
  token claims to default the user from and needs `participant_admin`, which the
  seed supplies by default; against an authenticated participant leave it unset,
  because the participant derives the user from the token and rejects a
  submission that names a different one.

## Troubleshooting

- **`.canton-ports.json` never appears**: check the sandbox shell output. The
  script removes the ports file both at startup and on exit, so its presence
  always means a sandbox is up.
- **"a sandbox is already serving on port 7575"**: another sandbox is running.
  Stop it, or start this one on a different `JSON_API_PORT`.
- **"Party already exists"**: expected on a re-run. `scripts/seed.mjs` reuses an
  existing party for a hint instead of allocating it again.
- **"found N InstrumentConfig contracts for ..."**: `expectOneConfig` in
  `scripts/seed.mjs` refuses to guess a winner and throws, naming the contract
  count and instrument id, when more than one config shares this
  `(admin, instrumentId)`. LF 2.1 has no contract keys, so nothing on-ledger
  prevents it, and the registry would answer 409 for an ambiguous instrument.
  Restart the sandbox for a clean ledger, or archive all but one config by
  exercising `Archive` on the extras as the admin, then seed again. Seeding a
  different `SEED_INSTRUMENT_ID` does not clear it: the duplicates stay active
  and the original id keeps answering 409.
- **DAR not found**: run `npm run build:canton-token-forge`, or let
  `scripts/sandbox.sh` build it (do not pass `SKIP_BUILD=1`).
- Canton logs to `log/canton.log` in the repo root, which is gitignored.

## Cutting a release

`.github/workflows/release.yml` builds and publishes. It runs the full suite,
checks the DAR is byte-reproducible, and compiles `consumer-smoke/` against the
built artifact before anything is published. The release body, including the
consumer snippet, is generated by `scripts/release-notes.sh` from
`consumer-smoke/consumer/daml.yaml`, so the published instructions are the ones
CI just proved compile.

1. Rehearse: run the workflow from the Actions tab. A `workflow_dispatch` run
   performs every check but the tag guard, and stops short of publishing,
   because the publish step is gated on a tag push.
2. Tag and push. This is the decision that matters: a downstream repository pins
   it permanently.

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Confirm the release carries `canton-token-forge-0.0.1.dar` and that its body
   shows the sha256 and package-id.

To run the smoke test locally without the workflow:

```bash
npm run smoke
```

Two environment variables tune this path:

- `SKIP_BUILD=1` skips the `dpm build` step in `scripts/consumer-smoke.sh` and
  `scripts/release-notes.sh`, working against whatever DAR is already on disk.
  The release workflow sets it on both of those steps, so the bytes it
  publishes are the ones the reproducibility check just verified.
  `scripts/sandbox.sh` reads the same variable, as above.
- `ALLOW_UNTAGGED=1` lets `scripts/release-notes.sh` emit a preview body before
  the tag exists. The release workflow sets it only for a `workflow_dispatch`
  run. Preview a body locally with:

  ```bash
  ALLOW_UNTAGGED=1 bash scripts/release-notes.sh v0.1.0
  ```

  This one refuses on a dirty working tree, untracked files included, because
  the sha256 it prints has to be reproducible from the tag. Commit or stash
  first: a single untracked file is enough to stop it, and the message says
  "dirty" rather than naming the file.
