import type { ContractEntry } from './ledger.js'
import type { InstrumentConfigPayload, InstrumentIdValue } from './payloads.js'

// Map from token standard API name to the minor version of the API
// supported by this registry. Shared between GetRegistryInfoResponse and
// every Instrument's supportedApis field.
export const SUPPORTED_APIS: Record<string, number> = Object.freeze({
  'splice-api-token-metadata-v1': 1,
  'splice-api-token-holding-v1': 1,
  'splice-api-token-transfer-instruction-v1': 1,
  'splice-api-token-allocation-v1': 1,
  'splice-api-token-allocation-instruction-v1': 1,
  'splice-api-token-burn-mint-v1': 1,
})

export interface Instrument {
  id: string
  name: string
  symbol: string
  decimals: number
  totalSupply?: string
  totalSupplyAsOf?: string
  supportedApis: Record<string, number>
}

// The two payload fields that identify an instrument on-ledger. Both the
// config and the preapproval payloads carry them.
interface InstrumentKeyedPayload {
  admin: string
  instrumentId: string
}

// The InstrumentConfig contract payload uses the Daml record field names
// (admin, instrumentId, name, symbol, decimals, faucet), not the
// metadata standard's `id`. This maps the on-ledger payload to the
// standard's Instrument shape.
export function toInstrument(payload: InstrumentConfigPayload): Instrument {
  return {
    id: payload.instrumentId,
    name: payload.name,
    symbol: payload.symbol,
    decimals: Number(payload.decimals),
    supportedApis: SUPPORTED_APIS,
  }
}

// An on-ledger payload (InstrumentConfig, TokenTransferPreapproval) identifies
// its instrument by the Daml record fields (admin, instrumentId), while the
// standard API carries the same identity as InstrumentId { admin, id }. These
// two helpers are the single place that bridges the two field namings, so the
// admin-and-id equality rule the whole service depends on is defined once.
export function matchesInstrument(payload: InstrumentKeyedPayload, id: InstrumentIdValue): boolean {
  return payload.admin === id.admin && payload.instrumentId === id.id
}

export function instrumentIdentity(payload: InstrumentKeyedPayload): string {
  return `${payload.admin}::${payload.instrumentId}`
}

export type ResolveResult<P = unknown> =
  | { kind: 'ok'; entry: ContractEntry<P> }
  | { kind: 'none' }
  | { kind: 'conflict'; contractIds: string[] }

// Because LF 2.1 has no contract keys, nothing on-ledger prevents two active
// InstrumentConfigs from sharing the same logical identity. Every "pick one
// config" call site resolves through this shared uniqueness check so a
// duplicate surfaces as a 409 instead of silently picking one.
export function resolveUnique<P>(matches: ContractEntry<P>[]): ResolveResult<P> {
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'conflict', contractIds: matches.map((m) => m.contractId) }
  return { kind: 'ok', entry: matches[0] }
}

export function resolveConfig(
  rows: ContractEntry<InstrumentConfigPayload>[],
  admin: string,
  id: string,
): ResolveResult<InstrumentConfigPayload> {
  const matches = rows.filter((r) => matchesInstrument(r.payload, { admin, id }))
  return resolveUnique(matches)
}

// The metadata standard's get-by-id path (/instruments/:instrumentId) only
// carries the instrumentId, not the admin, so it cannot use resolveConfig
// directly; it resolves uniqueness by instrumentId alone. resolveConfig keeps
// its admin comparison even though every readable row is administered by the
// configured party: there the admin arrives in the request body, and without
// the check the service would answer for an instrument it does not administer.
export function resolveById(
  rows: ContractEntry<InstrumentConfigPayload>[],
  id: string,
): ResolveResult<InstrumentConfigPayload> {
  const matches = rows.filter((r) => r.payload.instrumentId === id)
  return resolveUnique(matches)
}
