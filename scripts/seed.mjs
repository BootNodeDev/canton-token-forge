#!/usr/bin/env node
//
// seed.mjs - seed a running Canton sandbox with the contracts the registry
// service needs: an operator party, an instrument admin, two demo users, a
// TokenRegistry, and one InstrumentConfig created through the propose/accept
// flow. Prints the resulting contract ids and a ready-to-paste registry/.env
// block.
//
// Usage:
//   bash scripts/sandbox.sh                    # in one shell
//   node scripts/seed.mjs                      # in another
//
// Env overrides:
//   LEDGER_API_URL        JSON Ledger API base URL (default http://localhost:7575)
//   LEDGER_API_TOKEN      bearer token; omitted entirely when unset (sandbox needs none)
//   REGISTRY_BASE_URL     URL the registry advertises for its own routes (default http://localhost:8080)
//   SEED_INSTRUMENT_ID    instrument id to register (default CC)
//   SEED_INSTRUMENT_NAME  display name (default Canton Coin Forge)
//   SEED_SYMBOL           ticker symbol (default CC)
//   SEED_DECIMALS         decimals, 0..18 (default 10)
//   SEED_FAUCET_MAX       per-tap cap; set empty to register without a faucet (default 1000.0)
//   LEDGER_USER_ID        ledger user id for submissions (default participant_admin)

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dar = resolve(repoRoot, 'daml/canton-token-forge/.daml/dist/canton-token-forge-0.0.1.dar')

// An exported-but-empty variable means "unset" for every override below except
// SEED_FAUCET_MAX, where empty is the documented way to ask for no faucet.
// Letting "" through would commit an instrument with an empty id or symbol,
// which the ledger accepts and no later run can distinguish from a real one.
const strEnv = (name, fallback) => {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer ${min}..${max}, got ${JSON.stringify(raw)}`)
  }
  return n
}

function loadConfig() {
  return {
    base: strEnv('LEDGER_API_URL', 'http://localhost:7575'),
    token: strEnv('LEDGER_API_TOKEN', ''),
    registryBaseUrl: strEnv('REGISTRY_BASE_URL', 'http://localhost:8080'),
    instrumentId: strEnv('SEED_INSTRUMENT_ID', 'CC'),
    instrumentName: strEnv('SEED_INSTRUMENT_NAME', 'Canton Coin Forge'),
    symbol: strEnv('SEED_SYMBOL', 'CC'),
    decimals: intEnv('SEED_DECIMALS', 10, 0, 18),
    faucetMax: process.env.SEED_FAUCET_MAX ?? '1000.0',
    userId: strEnv('LEDGER_USER_ID', 'participant_admin'),
  }
}

// Configuration is resolved before anything else runs, so a bad override has to
// be caught here: a throw at module scope would escape main()'s handler and
// print a stack trace instead of the one-line reason.
let settings
try {
  settings = loadConfig()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const {
  base,
  token,
  registryBaseUrl,
  instrumentId,
  instrumentName,
  symbol,
  decimals,
  faucetMax,
  userId,
} = settings

const headers = {
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

function inspectDar() {
  if (!existsSync(dar)) {
    throw new Error(`DAR not found at ${dar}; run 'npm run build:canton-token-forge' first`)
  }
  const out = JSON.parse(execFileSync('dpm', ['inspect-dar', dar, '--json'], { encoding: 'utf8' }))
  const id = out.main_package_id
  return { id, name: out.packages[id].name }
}

const { id: packageId, name: packageName } = inspectDar()

// Active-contract filters resolve templates by package NAME, written
// `#<name>:<module>:<entity>`. A package-id-qualified identifier is rejected
// outright ("expected a package name"), so every id below uses the name form.
const pkg = `#${packageName}`
const tid = (entity) => `${pkg}:Canton.TokenForge.Registry:${entity}`
const TOKEN_REGISTRY = tid('TokenRegistry')
const INSTRUMENT_CONFIG_PROPOSAL = tid('InstrumentConfigProposal')
const INSTRUMENT_CONFIG = tid('InstrumentConfig')
const PREAPPROVAL = tid('TokenTransferPreapproval')
const TOKEN = `${pkg}:Canton.TokenForge.Token:Token`
const LOCKED_TOKEN = `${pkg}:Canton.TokenForge.Locked:LockedToken`
const TRANSFER_INSTRUCTION = `${pkg}:Canton.TokenForge.Instruction:TokenTransferInstruction`
const ALLOCATION = `${pkg}:Canton.TokenForge.Allocation:TokenAllocation`

async function call(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

// Re-running the seed against an already-seeded sandbox must not fail, so every
// step below is find-or-create. Party ids are `<hint>::<namespace>`, and
// re-allocating an existing hint is rejected outright.
async function allocate(hint) {
  const res = await fetch(`${base}/v2/parties`, { headers })
  if (!res.ok) throw new Error(`GET /v2/parties failed: ${res.status}`)
  const existing = (await res.json()).partyDetails.find((p) => p.party.startsWith(`${hint}::`))
  if (existing) return existing.party
  const created = await call('/v2/parties', { partyIdHint: hint })
  return created.partyDetails.party
}

// The active contract set must be snapshotted at the CURRENT ledger end. At
// offset 0 (the beginning of the ledger) it is always empty.
async function ledgerEnd() {
  const res = await fetch(`${base}/v2/state/ledger-end`, { headers })
  if (!res.ok) throw new Error(`GET /v2/state/ledger-end failed: ${res.status}`)
  return (await res.json()).offset
}

async function activeContracts(templateId, party) {
  const rows = await call('/v2/state/active-contracts', {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: { value: { templateId, includeCreatedEventBlob: true } },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: await ledgerEnd(),
  })
  return rows.flatMap((row) => {
    const ac = row?.contractEntry?.JsActiveContract
    if (!ac) return []
    return [
      {
        templateId: ac.createdEvent.templateId,
        contractId: ac.createdEvent.contractId,
        createdEventBlob: ac.createdEvent.createdEventBlob,
        synchronizerId: ac.synchronizerId,
        payload: ac.createdEvent.createArgument,
      },
    ]
  })
}

// The submission envelope nests the command list inside a `commands` object;
// a flat body is rejected with "Missing required field at 'commands.commands'".
// `userId` must be sent explicitly: with authentication off there are no claims
// to default it from, and the participant rejects the submission without it.
async function submit(actAs, commands, disclosedContracts = []) {
  return call('/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commands: commands.map((command) =>
        'contractId' in command ? { ExerciseCommand: command } : { CreateCommand: command },
      ),
      actAs,
      userId,
      commandId: `seed-${randomUUID()}`,
      disclosedContracts,
    },
  })
}

// Contract ids are read back from the active contract set rather than out of
// the submission response, so the seed does not depend on where a given Canton
// version puts an exercise result in the transaction envelope.
function expectOne(rows, what) {
  if (rows.length !== 1) throw new Error(`expected exactly one ${what}, found ${rows.length}`)
  return rows[0]
}

// The instrument identity is (admin, instrumentId); the payload spells the id
// field `instrumentId`, unlike the standard InstrumentId value type's `id`.
const forThisInstrument = (rows, admin) =>
  rows.filter((r) => r.payload.admin === admin && r.payload.instrumentId === instrumentId)

async function main() {
  console.log(`seeding ${base}`)
  console.log(`package ${packageName} (${packageId})\n`)

  const operator = await allocate('operator')
  const admin = await allocate('admin')
  const user1 = await allocate('user1')
  const user2 = await allocate('user2')

  let registryRows = await activeContracts(TOKEN_REGISTRY, operator)
  if (registryRows.length === 0) {
    await submit(
      [operator],
      [{ templateId: TOKEN_REGISTRY, createArguments: { operator, registryBaseUrl } }],
    )
    registryRows = await activeContracts(TOKEN_REGISTRY, operator)
  }
  const registry = expectOne(registryRows, 'TokenRegistry')

  let configRows = forThisInstrument(await activeContracts(INSTRUMENT_CONFIG, operator), admin)
  if (configRows.length === 0) {
    let proposalRows = forThisInstrument(
      await activeContracts(INSTRUMENT_CONFIG_PROPOSAL, admin),
      admin,
    )
    if (proposalRows.length === 0) {
      // The admin controls TokenRegistry_ProposeInstrument but is not a
      // stakeholder of the operator-signed registry, so the registry is
      // disclosed explicitly. Same disclosure the service's propose route makes.
      await submit(
        [admin],
        [
          {
            templateId: TOKEN_REGISTRY,
            contractId: registry.contractId,
            choice: 'TokenRegistry_ProposeInstrument',
            choiceArgument: {
              admin,
              instrumentId,
              name: instrumentName,
              symbol,
              // Int64 is encoded as a JSON string; a bare number is rejected
              // with "Expected ujson.Str".
              decimals: String(decimals),
              faucet: faucetMax ? { maxPerTap: faucetMax } : null,
            },
          },
        ],
        [
          {
            templateId: registry.templateId,
            contractId: registry.contractId,
            createdEventBlob: registry.createdEventBlob,
            synchronizerId: registry.synchronizerId,
          },
        ],
      )
      proposalRows = forThisInstrument(
        await activeContracts(INSTRUMENT_CONFIG_PROPOSAL, admin),
        admin,
      )
    }
    const proposal = expectOne(proposalRows, 'InstrumentConfigProposal')

    await submit(
      [operator],
      [
        {
          templateId: INSTRUMENT_CONFIG_PROPOSAL,
          contractId: proposal.contractId,
          choice: 'InstrumentConfigProposal_Accept',
          choiceArgument: {},
        },
      ],
    )
    configRows = forThisInstrument(await activeContracts(INSTRUMENT_CONFIG, operator), admin)
  }
  const config = expectOne(configRows, 'InstrumentConfig')

  // Report the contract that is actually on the ledger, not the requested
  // values: on a re-run the find-or-create branches are skipped and the
  // existing contract wins, so echoing the env vars would misreport it.
  const instrument = config.payload

  // Same reasoning for the registry: a reused one keeps whatever base URL it
  // was created with, and that is the URL standard clients resolve from the
  // ledger, so the generated .env has to agree with it rather than with the env.
  const onLedgerBaseUrl = registry.payload.registryBaseUrl
  if (onLedgerBaseUrl !== registryBaseUrl) {
    console.warn(
      `warning: reusing a TokenRegistry that advertises ${onLedgerBaseUrl}; ` +
        `REGISTRY_BASE_URL=${registryBaseUrl} was ignored\n`,
    )
  }

  console.log('parties')
  console.log(`  operator ${operator}`)
  console.log(`  admin    ${admin}`)
  console.log(`  user1    ${user1}`)
  console.log(`  user2    ${user2}\n`)
  console.log('contracts')
  console.log(`  TokenRegistry    ${registry.contractId}`)
  console.log(`  InstrumentConfig ${config.contractId}`)
  console.log(
    `  instrument       ${instrument.instrumentId} (${instrument.symbol}, ${instrument.decimals} decimals)`,
  )
  console.log(
    `  faucet           ${
      instrument.faucet ? `enabled, max ${instrument.faucet.maxPerTap} per tap` : 'disabled'
    }\n`,
  )

  console.log('registry/.env')
  console.log(`LEDGER_API_URL=${base}`)
  // The service requires this to be non-empty, and the sandbox authenticates
  // nothing. A caller-supplied token is referenced rather than reprinted, to
  // keep a real credential out of terminal scrollback and CI logs.
  console.log(`LEDGER_API_TOKEN=${token ? '<the LEDGER_API_TOKEN you passed in>' : 'placeholder'}`)
  console.log(`OPERATOR_PARTY=${operator}`)
  console.log(`REGISTRY_BASE_URL=${onLedgerBaseUrl}`)
  console.log(`INSTRUMENT_CONFIG_TEMPLATE_ID=${INSTRUMENT_CONFIG}`)
  console.log(`INSTRUMENT_CONFIG_PROPOSAL_TEMPLATE_ID=${INSTRUMENT_CONFIG_PROPOSAL}`)
  console.log(`TOKEN_REGISTRY_TEMPLATE_ID=${TOKEN_REGISTRY}`)
  console.log(`PREAPPROVAL_TEMPLATE_ID=${PREAPPROVAL}`)
  console.log(`LOCKED_TOKEN_TEMPLATE_ID=${LOCKED_TOKEN}`)
  console.log(`TRANSFER_INSTRUCTION_INTERFACE_ID=${TRANSFER_INSTRUCTION}`)
  console.log(`ALLOCATION_INTERFACE_ID=${ALLOCATION}`)
  console.log(`PORT=8080`)
  console.log(`\nother template ids`)
  console.log(`  Token ${TOKEN}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
