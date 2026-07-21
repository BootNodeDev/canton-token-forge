import type { ContractEntry } from "./ledger.js";

// A disclosure is a ContractEntry minus its decoded payload: the ledger
// only needs the blob, and deriving the type keeps the two from drifting.
export type DisclosedContract = Omit<ContractEntry, "payload">;

export function toDisclosed(e: ContractEntry): DisclosedContract {
  return {
    templateId: e.templateId,
    contractId: e.contractId,
    createdEventBlob: e.createdEventBlob,
    synchronizerId: e.synchronizerId,
  };
}

// Choice-context data keys the on-ledger choices read to locate disclosed
// reference contracts. Shared between the factory (which populates them)
// and any future caller that needs to know the exact key string.
export const PREAPPROVAL_CONTEXT_KEY = "canton-token-forge/transfer-preapproval";
export const EXPIRE_LOCK_CONTEXT_KEY = "canton-token-forge/expire-lock";

// The ChoiceContext value is a Daml AnyValue (AV_ContractId / AV_Bool, see
// MetadataV1.daml). The exact JSON shape the Canton JSON Ledger API expects
// for a Daml variant is UNVERIFIED against a live node (same class of
// deferral as the ledger envelope in Task 2) - this file is the single site
// that encodes AnyValue so that assumption is easy to revisit in one place.
export function anyValueContractId(cid: string): unknown {
  return { tag: "AV_ContractId", value: cid };
}

// The allocation cancel path supplies the early-release signal as an
// AV_Bool; declared here so disclose.ts stays the single AnyValue encoding
// site even though the transfer routes in this file do not use it.
export function anyValueBool(b: boolean): unknown {
  return { tag: "AV_Bool", value: b };
}
