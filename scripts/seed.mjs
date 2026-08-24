#!/usr/bin/env node
//
// seed.mjs - seed a running Canton sandbox with the contracts the registry
// service needs: an instrument admin, two demo users, and one InstrumentConfig
// created directly by the admin. Prints the resulting contract ids and a
// ready-to-paste registry/.env block.
//
// Usage:
//   bash scripts/sandbox.sh                    # in one shell
//   node scripts/seed.mjs                      # in another
//
// Env overrides:
//   LEDGER_API_URL        JSON Ledger API base URL (default http://localhost:7575)
//   LEDGER_API_TOKEN      bearer token; omitted entirely when unset (sandbox needs none)
//   SEED_INSTRUMENT_ID    instrument id to register (default CC)
//   SEED_INSTRUMENT_NAME  display name (default Canton Coin Forge)
//   SEED_SYMBOL           ticker symbol (default CC)
//   SEED_DECIMALS         decimals, 0..10 (default 10)
//   SEED_FAUCET_MAX       per-tap cap; set empty to register without a faucet (default 1000.0)
//   LEDGER_USER_ID        ledger user id for submissions (default participant_admin
//                         without a token, omitted with one; set empty to force omission)

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// An exported-but-empty variable means "unset" for every override below except
// SEED_FAUCET_MAX and LEDGER_USER_ID, where empty is the documented way to ask
// for no faucet and no user id. Letting "" through elsewhere would commit an
// instrument with an empty id or symbol, which the ledger accepts and no later
// run can distinguish from a real one.
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

// Read from daml.yaml rather than `dpm inspect-dar`, so the seed needs neither a
// JVM nor a locally built DAR and can run against a remote participant.
function packageNameFromDamlYaml() {
  const path = resolve(repoRoot, 'daml/canton-token-forge/daml.yaml')
  const match = readFileSync(path, 'utf8').match(/^name:\s*(\S+)/m)
  if (!match) throw new Error(`could not read 'name' from ${path}`)
  return match[1]
}

function loadConfig() {
  const token = strEnv('LEDGER_API_TOKEN', '')
  return {
    base: strEnv('LEDGER_API_URL', 'http://localhost:7575'),
    token,
    instrumentId: strEnv('SEED_INSTRUMENT_ID', 'CC'),
    instrumentName: strEnv('SEED_INSTRUMENT_NAME', 'Canton Coin Forge'),
    symbol: strEnv('SEED_SYMBOL', 'CC'),
    decimals: intEnv('SEED_DECIMALS', 10, 0, 10),
    faucetMax: process.env.SEED_FAUCET_MAX ?? '1000.0',
    // A token already names the ledger user, and the participant rejects a
    // submission naming a different one, so the default is to omit it there.
    // Without authentication there are no claims to read it from and the
    // participant rejects a submission that leaves it out.
    userId: process.env.LEDGER_USER_ID ?? (token ? '' : 'participant_admin'),
    packageName: packageNameFromDamlYaml(),
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
  instrumentId,
  instrumentName,
  symbol,
  decimals,
  faucetMax,
  userId,
  packageName,
} = settings

const headers = {
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

// Active-contract filters resolve templates by package NAME, written
// `#<name>:<module>:<entity>`. A package-id-qualified identifier is rejected
// outright ("expected a package name"), so every id below uses the name form.
const pkg = `#${packageName}`
// Every id is spelled out rather than built from a helper: CI checks these
// strings against daml/ with a pattern that reads literals only, and an
// interpolated entity would be skipped while the file still reported ok.
const INSTRUMENT_CONFIG = `${pkg}:Canton.TokenForge.Registry:InstrumentConfig`
const PREAPPROVAL = `${pkg}:Canton.TokenForge.Registry:TokenTransferPreapproval`
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

// The party list is paginated. A hint that exists but falls outside the first
// page would look unallocated, and re-allocating an existing hint is rejected
// outright, so the whole list is read once and cached for every lookup.
let knownParties
async function allParties() {
  if (knownParties) return knownParties
  knownParties = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
    const res = await fetch(`${base}/v2/parties${query}`, { headers })
    if (!res.ok) throw new Error(`GET /v2/parties failed: ${res.status}`)
    const body = await res.json()
    knownParties.push(...(body.partyDetails ?? []))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return knownParties
}

// Re-running the seed against an already-seeded sandbox must not fail, so every
// step below is find-or-create. Party ids are `<hint>::<namespace>`.
async function allocate(hint) {
  const existing = (await allParties()).find((p) => p.party.startsWith(`${hint}::`))
  if (existing) return existing.party
  const created = await call('/v2/parties', { partyIdHint: hint })
  knownParties.push(created.partyDetails)
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
              identifierFilter: { TemplateFilter: { value: { templateId } } },
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
    return [{ contractId: ac.createdEvent.contractId, payload: ac.createdEvent.createArgument }]
  })
}

// The submission envelope nests the command list inside a `commands` object;
// a flat body is rejected with "Missing required field at 'commands.commands'".
// `userId` is sent only when resolved, matching the service's own ledger client.
async function create(actAs, createCommand) {
  return call('/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commands: [{ CreateCommand: createCommand }],
      actAs,
      ...(userId ? { userId } : {}),
      commandId: `seed-${randomUUID()}`,
    },
  })
}

// LF 2.1 has no contract keys, so nothing on the ledger stops two overlapping
// seed runs from both creating a config for the same (admin, instrumentId).
// There is no useful winner to pick: the registry answers 409 for an ambiguous
// instrument, so a seed that chose one would hand out an env block for an
// instrument the service cannot serve.
function expectOneConfig(rows) {
  if (rows.length === 1) return rows[0]
  if (rows.length === 0) {
    throw new Error(`no InstrumentConfig for ${instrumentId} after creating one`)
  }
  throw new Error(
    `found ${rows.length} InstrumentConfig contracts for ${instrumentId}: archive all but one, ` +
      'or restart the sandbox for a clean ledger, and seed again',
  )
}

// The instrument identity is (admin, instrumentId), but admin is
// InstrumentConfig's only signatory and these rows come from the admin's own
// active contract set, so only the id half is left to filter on. The payload
// spells that field `instrumentId`, unlike the standard InstrumentId value
// type's `id`.
const forThisInstrument = (rows) => rows.filter((r) => r.payload.instrumentId === instrumentId)

async function main() {
  console.log(`seeding ${base}`)
  console.log(`package ${packageName}\n`)

  const admin = await allocate('admin')
  const user1 = await allocate('user1')
  const user2 = await allocate('user2')

  // Contract ids are read back from the active contract set rather than out of
  // the submission response, so the seed does not depend on where a given Canton
  // version puts a create result in the transaction envelope.
  let configRows = forThisInstrument(await activeContracts(INSTRUMENT_CONFIG, admin))
  if (configRows.length === 0) {
    await create([admin], {
      templateId: INSTRUMENT_CONFIG,
      createArguments: {
        admin,
        instrumentId,
        name: instrumentName,
        symbol,
        // Int64 is encoded as a JSON string; a bare number is rejected
        // with "Expected ujson.Str".
        decimals: String(decimals),
        faucet: faucetMax ? { maxPerTap: faucetMax } : null,
        meta: { values: {} },
      },
    })
    configRows = forThisInstrument(await activeContracts(INSTRUMENT_CONFIG, admin))
  }
  const config = expectOneConfig(configRows)

  // Report the contract that is actually on the ledger, not the requested
  // values: on a re-run the find-or-create branches are skipped and the
  // existing contract wins, so echoing the env vars would misreport it.
  const instrument = config.payload

  console.log('parties')
  console.log(`  admin ${admin}`)
  console.log(`  user1 ${user1}`)
  console.log(`  user2 ${user2}\n`)
  console.log('contracts')
  console.log(`  InstrumentConfig ${config.contractId}`)
  console.log(
    `  instrument       ${instrument.instrumentId} (${instrument.symbol}, ${instrument.decimals} decimals)`,
  )
  console.log(
    `  faucet           ${
      instrument.faucet ? `enabled, max ${instrument.faucet.maxPerTap} per tap` : 'disabled'
    }\n`,
  )

  // Template ids start with `#`, which dotenv reads as the start of a comment
  // unless the value is quoted, so every id is emitted single-quoted.
  const quoted = (key, id) => console.log(`${key}='${id}'`)

  console.log('registry/.env')
  console.log(`LEDGER_API_URL=${base}`)
  // The service requires this to be non-empty, and the sandbox authenticates
  // nothing. A caller-supplied token is referenced rather than reprinted, to
  // keep a real credential out of terminal scrollback and CI logs.
  console.log(`LEDGER_API_TOKEN=${token ? '<the LEDGER_API_TOKEN you passed in>' : 'placeholder'}`)
  // Only an unauthenticated participant needs to be told the ledger user: it
  // has no claims to default one from. A user id resolves empty for two
  // different reasons, so the emitted note names the one that applies: a token
  // was supplied and the participant will derive the user from it, or the
  // caller passed an empty LEDGER_USER_ID to force omission.
  if (userId) {
    console.log(`LEDGER_USER_ID=${userId}`)
  } else if (token) {
    console.log('# LEDGER_USER_ID is unset on purpose: the participant reads it from the token')
  } else {
    console.log('# LEDGER_USER_ID was forced empty, so submissions omit it')
  }
  console.log(`ADMIN_PARTY=${admin}`)
  quoted('INSTRUMENT_CONFIG_TEMPLATE_ID', INSTRUMENT_CONFIG)
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
