// JSON shapes of the on-ledger contract payloads this service reads, as the
// Canton JSON Ledger API renders create arguments. Only the fields the
// service actually reads are declared; extra runtime fields are allowed by
// structural typing. The exact live-node JSON encoding is the known deferral
// (see ledger.ts): if it drifts, these shapes are the single place to adjust
// alongside the client.

// The standard API's InstrumentId value type, embedded in transfer and
// allocation choice arguments as { admin, id }. On-ledger config payloads
// instead carry (admin, instrumentId); mapping.ts bridges the two namings.
export interface InstrumentIdValue {
  admin: string;
  id: string;
}

export interface InstrumentConfigPayload {
  admin: string;
  operator: string;
  instrumentId: string;
  name: string;
  symbol: string;
  decimals: number | string;
  faucet: unknown;
}

export type InstrumentConfigProposalPayload = InstrumentConfigPayload;

export interface TokenRegistryPayload {
  operator: string;
  registryBaseUrl: string;
}

export interface PreapprovalPayload {
  admin: string;
  instrumentId: string;
  receiver: string;
  validFrom: string;
  expiresAt: string;
}

export interface TransferInstructionPayload {
  admin: string;
  transfer: {
    sender: string;
    receiver: string;
    instrumentId: InstrumentIdValue;
    amount: string;
    meta: unknown;
  };
  lockedCid: string;
}

export interface AllocationPayload {
  admin: string;
  allocation: unknown;
  lockedCid: string;
  meta: unknown;
}

export interface LockedTokenPayload {
  admin: string;
}
