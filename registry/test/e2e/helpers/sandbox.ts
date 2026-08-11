import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `||` rather than `??`: an exported-but-empty value has to fall back too, or
// the probe fetches a relative URL and the whole suite silently skips.
export const LEDGER_API_URL = process.env.LEDGER_API_URL || 'http://localhost:7575'

export const LEDGER_USER_ID = process.env.LEDGER_USER_ID || 'participant_admin'

// A short timeout rather than the default: an unreachable participant is the
// expected case, and it must cost the run seconds, not a hung socket.
//
// Only a probe that fails to connect means "no participant". An address that
// answers non-2xx is a broken setup, and skipping it would report a green run
// that asserted nothing, so it throws instead.
export async function probeSandbox(): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(`${LEDGER_API_URL}/v2/version`, {
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    return false
  }
  if (!res.ok) {
    throw new Error(
      `${LEDGER_API_URL} answered ${res.status} on /v2/version: something serves that ` +
        'address but it is not a participant this suite can drive.',
    )
  }
  return true
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

// Read from daml.yaml rather than pinned here, so renaming the package cannot
// leave the suite querying template ids that no longer resolve while every
// query still returns a well-formed empty result.
export function packageName(): string {
  const path = resolve(repoRoot, 'daml/canton-token-forge/daml.yaml')
  const match = readFileSync(path, 'utf8').match(/^name:\s*(\S+)/m)
  if (!match) throw new Error(`could not read 'name' from ${path}`)
  return match[1]
}

export function templateIds() {
  const pkg = `#${packageName()}`
  return {
    instrumentConfig: `${pkg}:Canton.TokenForge.Registry:InstrumentConfig`,
    preapproval: `${pkg}:Canton.TokenForge.Registry:TokenTransferPreapproval`,
    token: `${pkg}:Canton.TokenForge.Token:Token`,
    lockedToken: `${pkg}:Canton.TokenForge.Locked:LockedToken`,
    transferInstruction: `${pkg}:Canton.TokenForge.Instruction:TokenTransferInstruction`,
    allocation: `${pkg}:Canton.TokenForge.Allocation:TokenAllocation`,
  }
}

const TRANSFER_MODULE =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1'
export const TRANSFER_FACTORY_INTERFACE_ID = `${TRANSFER_MODULE}:TransferFactory`
export const TRANSFER_INSTRUCTION_INTERFACE_ID = `${TRANSFER_MODULE}:TransferInstruction`

// Every run gets its own parties and its own instrument id. LF 2.1 has no
// contract keys, so a second InstrumentConfig under an existing
// (admin, instrumentId) is accepted by the ledger and then makes the service
// answer 409 for that instrument until one of them is archived.
export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8)
}

export async function allocateParty(hint: string): Promise<string> {
  const res = await fetch(`${LEDGER_API_URL}/v2/parties`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ partyIdHint: hint }),
  })
  if (!res.ok) throw new Error(`party allocation failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { partyDetails: { party: string } }).partyDetails.party
}
