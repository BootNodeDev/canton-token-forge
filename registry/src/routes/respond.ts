import type { Response } from "express";
import type { ContractEntry } from "../ledger.js";
import type { ResolveResult } from "../mapping.js";

// Translate a ResolveResult into the shared HTTP error responses (404 for a
// missing instrument, 409 with the conflicting ids for a non-unique
// (admin, instrumentId)) and return the resolved entry, or undefined when a
// response was already sent. Every config-resolving route funnels through
// this so the status codes and error strings live in one place. It lives
// with the routes because it writes to the HTTP response; mapping.ts stays
// free of express.
//
// The 409 is deliberately beyond the 400/404 the standard specs list for
// these paths: a duplicate (admin, instrumentId) is registry data corruption
// the caller cannot fix, the body still satisfies the specs' ErrorResponse
// schema, and the contractIds identify the conflict for the operator.
export function resolveOrRespond<P>(res: Response, result: ResolveResult<P>): ContractEntry<P> | undefined {
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
