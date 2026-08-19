import type { ContractEntry } from './ledger.js'

// A disclosure is a ContractEntry minus its decoded payload: the ledger
// only needs the blob, and deriving the type keeps the two from drifting.
export type DisclosedContract = Omit<ContractEntry, 'payload'>

export function toDisclosed(e: ContractEntry): DisclosedContract {
  return {
    templateId: e.templateId,
    contractId: e.contractId,
    createdEventBlob: e.createdEventBlob,
    synchronizerId: e.synchronizerId,
  }
}

// Choice-context data keys the on-ledger choices read to locate disclosed
// reference contracts. Shared between the factory (which populates them)
// and any future caller that needs to know the exact key string.
export const PREAPPROVAL_CONTEXT_KEY = 'canton-token-forge/transfer-preapproval'
export const EXPIRE_LOCK_CONTEXT_KEY = 'canton-token-forge/expire-lock'
// Reported on an abort context when the escrow behind the record is already
// gone, because its owner reclaimed it once the deadline passed. It tells the
// choice there is nothing to return; the deadline still applies on-ledger.
export const ESCROW_RECLAIMED_CONTEXT_KEY = 'canton-token-forge/escrow-reclaimed'

// The ChoiceContext value is a Daml AnyValue (AV_ContractId / AV_Bool, see
// MetadataV1.daml).
export function anyValueContractId(cid: string): unknown {
  return { tag: 'AV_ContractId', value: cid }
}

// The allocation cancel path supplies the early-release signal as an AV_Bool,
// and every abort context reports a reclaimed escrow the same way. Declared
// alongside the contract-id encoder so this file stays the single AnyValue
// encoding site.
export function anyValueBool(b: boolean): unknown {
  return { tag: 'AV_Bool', value: b }
}
