import type { Config } from '../config.js'
import type { ContractEntry, ContractLookup, LedgerClient } from '../ledger.js'
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

// Resolve a single active contract by the id a client named in the path (an
// allocation, a transfer instruction), so the one cast from the participant's
// unknown payload lives here. The id is the client's, so one the participant
// cannot parse is answered as a miss rather than as a fault of ours.
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
  const found = await ledger.lookupByContractId(templateId, contractId, party, true)
  return found.state === 'live' ? (found.entry as ContractEntry<P>) : undefined
}

// Resolve the escrow LockedToken behind a lockedCid. The receiver is not a
// stakeholder of the escrow, so the transfer and allocation choice-contexts
// both disclose it before the counterparty exercises its choice. An escrow that
// is not live is reported by state rather than as an empty disclosure list,
// because a context that silently omitted it would only fail later inside the
// choice.
//
// The caller need not hold a stale id for the escrow to be gone: after expiry
// the sender can reclaim it through LockedToken_ExpireLock, which archives the
// escrow while the record that names it stays active, so the cid the service
// itself just read out of a live instruction can already be archived. That is
// the one case the aborts whose controller owns the escrow report back to the
// choice, and it is why the state is passed through instead of collapsed: an
// archive event is the participant's evidence that the reclaim happened, while
// a lookup that found nothing is only the absence of an answer. The settlement
// routes and the receiver-controlled reject treat both alike as a dead end.
//
// A participant that has pruned the archive event answers a genuine reclaim as
// absent, which stalls the client on a 404 instead of letting it clear the
// record. That is the safe direction of the two, and the reason the evidence is
// required rather than inferred: the opposite failure clears the record while
// the funds stay locked until the escrow's own expiry.
export function findEscrow(
  ledger: LedgerClient,
  config: Pick<Config, 'lockedTokenTemplateId' | 'adminParty'>,
  lockedCid: string,
): Promise<ContractLookup<LockedTokenPayload>> {
  // Deliberately not routed through findByContractId: this is the one lookup
  // whose id the service read out of a record's own payload rather than off a
  // client, and the only one that returns all three states rather than
  // collapsing them. The payload is an unchecked cast, so a lockedCid the
  // participant cannot parse says the contract is not the template it was read
  // as. Withholding the client-id flag is what makes that refusal raise instead
  // of coming back as an absent escrow, reporting a fault of ours as a contract
  // the ledger simply does not hold.
  return ledger.lookupByContractId(
    config.lockedTokenTemplateId,
    lockedCid,
    config.adminParty,
  ) as Promise<ContractLookup<LockedTokenPayload>>
}
