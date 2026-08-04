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
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dar = resolve(repoRoot, 'daml/canton-token-forge/.daml/dist/canton-token-forge-0.0.1.dar')

const base = process.env.LEDGER_API_URL ?? 'http://localhost:7575'
const token = process.env.LEDGER_API_TOKEN ?? ''
const registryBaseUrl = process.env.REGISTRY_BASE_URL ?? 'http://localhost:8080'
const instrumentId = process.env.SEED_INSTRUMENT_ID ?? 'CC'
const instrumentName = process.env.SEED_INSTRUMENT_NAME ?? 'Canton Coin Forge'
const symbol = process.env.SEED_SYMBOL ?? 'CC'
const decimals = Number(process.env.SEED_DECIMALS ?? '10')
const faucetMax = process.env.SEED_FAUCET_MAX ?? '1000.0'
const userId = process.env.LEDGER_USER_ID ?? 'participant_admin'

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
      commandId: `seed-${crypto.randomUUID()}`,
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

  console.log('parties')
  console.log(`  operator ${operator}`)
  console.log(`  admin    ${admin}`)
  console.log(`  user1    ${user1}`)
  console.log(`  user2    ${user2}\n`)
  console.log('contracts')
  console.log(`  TokenRegistry    ${registry.contractId}`)
  console.log(`  InstrumentConfig ${config.contractId}`)
  console.log(`  instrument       ${instrumentId} (${symbol}, ${decimals} decimals)`)
  console.log(`  faucet           ${faucetMax ? `enabled, max ${faucetMax} per tap` : 'disabled'}\n`)

  // Template ids start with `#`, which dotenv reads as the start of a comment
  // unless the value is quoted, so every id is emitted single-quoted.
  const quoted = (key, id) => console.log(`${key}='${id}'`)

  console.log('registry/.env')
  console.log(`LEDGER_API_URL=${base}`)
  // The sandbox runs without authentication and ignores the header, but the
  // service requires the variable, so an unset token still needs a value.
  console.log(`LEDGER_API_TOKEN=${token || 'sandbox'}`)
  console.log(`LEDGER_USER_ID=${userId}`)
  console.log(`OPERATOR_PARTY=${operator}`)
  console.log(`REGISTRY_BASE_URL=${registryBaseUrl}`)
  quoted('INSTRUMENT_CONFIG_TEMPLATE_ID', INSTRUMENT_CONFIG)
  quoted('INSTRUMENT_CONFIG_PROPOSAL_TEMPLATE_ID', INSTRUMENT_CONFIG_PROPOSAL)
  quoted('TOKEN_REGISTRY_TEMPLATE_ID', TOKEN_REGISTRY)
  quoted('PREAPPROVAL_TEMPLATE_ID', PREAPPROVAL)
  quoted('LOCKED_TOKEN_TEMPLATE_ID', LOCKED_TOKEN)
  quoted('TRANSFER_INSTRUCTION_TEMPLATE_ID', TRANSFER_INSTRUCTION)
  quoted('ALLOCATION_TEMPLATE_ID', ALLOCATION)
  console.log(`PORT=8080`)
  console.log(`\nother template ids`)
  console.log(`  Token ${TOKEN}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
