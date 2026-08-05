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

// The InstrumentConfig active set for the admin, which the routes then run
// through resolveConfig/resolveById. Centralized so the "which template, which
// party identifies the config set" choice has one home, alongside
// findByContractId and escrowDisclosure below.
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

// Locate a single active contract by its id within a template's active set.
// Several handlers resolve a path parameter (an allocation, a transfer
// instruction) this way before acting on it, so the query lives in
// one place; live-node work that changes how a contract is located by id
// then has a single call site to update.
export async function findByContractId<P = unknown>(
  ledger: LedgerClient,
  templateId: string,
  party: string,
  contractId: string,
): Promise<ContractEntry<P> | undefined> {
  const rows = await activeContractsAs<P>(ledger, templateId, party)
  return rows.find((row) => row.contractId === contractId)
}

// Resolve the escrow LockedToken behind a lockedCid. The receiver is not a
// stakeholder of the escrow, so the transfer and allocation choice-contexts
// both disclose it before the counterparty exercises its choice. An absent
// escrow is returned as undefined rather than an empty disclosure list: an
// active instruction or allocation always points at a live escrow, so a
// missing one means the caller holds a stale contract id, and a context that
// silently omits it would only fail later inside the choice.
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
