import type { Config } from '../config.js'
import type { ContractEntry, LedgerClient } from '../ledger.js'
import type {
  InstrumentConfigPayload,
  LockedTokenPayload,
  PreapprovalPayload,
} from '../payloads.js'

// The ledger client returns payloads as unknown; the wrappers below pair one
// template id with its payload shape. The cast that gives the routes their
// types happens once here, in activeContractsAs, so each active-set query is a
// one-line binding of a template-id field to a payload type.
function activeContractsAs<P>(
  ledger: LedgerClient,
  templateId: string,
  party: string,
): Promise<ContractEntry<P>[]> {
  return ledger.activeContracts(templateId, party) as Promise<ContractEntry<P>[]>
}

// The InstrumentConfig active set for the admin. The metadata and factory
// routes run it through resolveConfig/resolveById; the readiness probe issues
// it for the round-trip alone and ignores the rows, so an empty set is not an
// error there. Centralized so the "which template, which party identifies the
// config set" choice has one home, alongside findByContractId and findEscrow
// below.
export function activeConfigs(
  ledger: LedgerClient,
  config: Pick<Config, 'instrumentConfigTemplateId' | 'adminParty'>,
): Promise<ContractEntry<InstrumentConfigPayload>[]> {
  return activeContractsAs<InstrumentConfigPayload>(
    ledger,
    config.instrumentConfigTemplateId,
    config.adminParty,
  )
}

export function activePreapprovals(
  ledger: LedgerClient,
  config: Pick<Config, 'preapprovalTemplateId' | 'adminParty'>,
): Promise<ContractEntry<PreapprovalPayload>[]> {
  return activeContractsAs<PreapprovalPayload>(
    ledger,
    config.preapprovalTemplateId,
    config.adminParty,
  )
}

// Screen a contract id that arrived as a path parameter. An id that cannot name
// a contract names no contract, so the routes answer it as they answer any other
// id they cannot resolve, without spending a participant round-trip on it.
//
// Deliberately a character check alone: the length and the version prefix are
// the participant's business, and pinning them here would start refusing ids it
// still accepts. That leaves the ids that are hex but still unparseable, a
// truncated paste being the likely one, for the participant to reject; the
// ledger client reads that particular rejection as a miss so it reaches the
// client as the same 404 this screen produces.
export function isContractId(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value)
}

// Resolve a single active contract by its id. Several handlers resolve a path
// parameter (an allocation, a transfer instruction) this way before acting on
// it, so the one cast from the client's unknown payload lives here.
//
// This is the only lookup the JSON Ledger API can answer in bounded time: the
// active-set queries above are matched on payload fields (an instrumentId, a
// receiver) and the API has no payload predicate, so they cannot be narrowed
// server-side. They stay proportional to the instruments an admin issues and
// the preapprovals its receivers hold, both of which grow far slower than the
// escrows, instructions and allocations resolved through here.
export async function findByContractId<P = unknown>(
  ledger: LedgerClient,
  templateId: string,
  party: string,
  contractId: string,
): Promise<ContractEntry<P> | undefined> {
  return ledger.lookupByContractId(templateId, contractId, party) as Promise<
    ContractEntry<P> | undefined
  >
}

// Resolve the escrow LockedToken behind a lockedCid. The receiver is not a
// stakeholder of the escrow, so the transfer and allocation choice-contexts
// both disclose it before the counterparty exercises its choice. An absent
// escrow is returned as undefined rather than an empty disclosure list, because
// a context that silently omits it would only fail later inside the choice.
// Note the caller need not hold a stale id for this to happen: after expiry the
// sender can reclaim the escrow through LockedToken_ExpireLock, which archives
// it while the record that names it stays active, so the cid the service itself
// just read out of a live instruction can already be gone. The abort routes
// report that back to the choice rather than refusing; only the settlement
// routes treat it as a dead end.
export async function findEscrow(
  ledger: LedgerClient,
  config: Pick<Config, 'lockedTokenTemplateId' | 'adminParty'>,
  lockedCid: string,
): Promise<ContractEntry<LockedTokenPayload> | undefined> {
  return findByContractId<LockedTokenPayload>(
    ledger,
    config.lockedTokenTemplateId,
    config.adminParty,
    lockedCid,
  )
}
