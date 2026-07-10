import type { Response } from "express";
import type { ContractEntry } from "./ledger.js";

// Map from token standard API name to the minor version of the API
// supported by this registry. Shared between GetRegistryInfoResponse and
// every Instrument's supportedApis field.
export const SUPPORTED_APIS: Record<string, number> = Object.freeze({
  "splice-api-token-metadata-v1": 1,
  "splice-api-token-holding-v1": 1,
  "splice-api-token-transfer-instruction-v1": 1,
  "splice-api-token-allocation-v1": 1,
  "splice-api-token-allocation-instruction-v1": 1,
  "splice-api-token-burn-mint-v1": 1,
});

export interface Instrument {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply?: string;
  totalSupplyAsOf?: string;
  supportedApis: Record<string, number>;
}

// The InstrumentConfig contract payload uses the Daml record field names
// (admin, operator, instrumentId, name, symbol, decimals, faucet), not the
// metadata standard's `id`. This maps the on-ledger payload to the
// standard's Instrument shape.
export function toInstrument(payload: any): Instrument {
  return {
    id: payload.instrumentId,
    name: payload.name,
    symbol: payload.symbol,
    decimals: Number(payload.decimals),
    supportedApis: SUPPORTED_APIS,
  };
}

export type ResolveResult =
  | { kind: "ok"; entry: ContractEntry }
  | { kind: "none" }
  | { kind: "conflict"; contractIds: string[] };

// Because LF 2.1 has no contract keys, nothing on-ledger prevents two active
// InstrumentConfigs from sharing the same logical identity. Every "pick one
// config" call site resolves through this shared uniqueness check so a
// duplicate surfaces as a 409 instead of silently picking one.
export function resolveUnique(matches: ContractEntry[]): ResolveResult {
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "conflict", contractIds: matches.map((m) => m.contractId) };
  return { kind: "ok", entry: matches[0] };
}

export function resolveConfig(rows: ContractEntry[], admin: string, id: string): ResolveResult {
  const matches = rows.filter((r) => r.payload.admin === admin && r.payload.instrumentId === id);
  return resolveUnique(matches);
}

// The metadata standard's get-by-id path (/instruments/:instrumentId) only
// carries the instrumentId, not the admin, so it cannot use resolveConfig
// directly; it resolves uniqueness by instrumentId alone.
export function resolveById(rows: ContractEntry[], id: string): ResolveResult {
  const matches = rows.filter((r) => r.payload.instrumentId === id);
  return resolveUnique(matches);
}

// Translate a ResolveResult into the shared HTTP error responses (404 for a
// missing instrument, 409 with the conflicting ids for a non-unique
// (admin, instrumentId)) and return the resolved entry, or undefined when a
// response was already sent. Every config-resolving route funnels through
// this so the status codes and error strings live in one place.
export function resolveOrRespond(res: Response, result: ResolveResult): ContractEntry | undefined {
  if (result.kind === "none") {
    res.status(404).json({ error: "instrument not found" });
    return undefined;
  }
  if (result.kind === "conflict") {
    res.status(409).json({ error: "instrument id not unique", contractIds: result.contractIds });
    return undefined;
  }
  return result.entry;
}
