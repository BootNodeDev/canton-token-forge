import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { SUPPORTED_APIS, toInstrument, resolveById, resolveOrRespond, instrumentIdentity } from "../mapping.js";
import type { ContractEntry } from "../ledger.js";
import { asyncHandler } from "./async-handler.js";

// Collapse rows to one entry per (admin, instrumentId): LF 2.1 has no
// contract keys, so nothing prevents duplicates, but the list endpoint
// should not surface them as visible duplicates the way get-by-id does.
function dedupeByAdminAndInstrumentId(rows: ContractEntry[]): ContractEntry[] {
  const seen = new Map<string, ContractEntry>();
  for (const row of rows) {
    const key = instrumentIdentity(row.payload);
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

export function metadataRouter(deps: ServerDeps): Router {
  const r = Router();

  r.get("/registry/metadata/v1/info", (_req, res) => {
    res.json({
      adminId: deps.config.operatorParty,
      supportedApis: SUPPORTED_APIS,
    });
  });

  r.get(
    "/registry/metadata/v1/instruments",
    asyncHandler(async (_req, res) => {
      const rows = await deps.ledger.activeContracts(
        deps.config.instrumentConfigTemplateId,
        deps.config.operatorParty,
      );
      const instruments = dedupeByAdminAndInstrumentId(rows).map((row) => toInstrument(row.payload));
      res.json({ instruments });
    }),
  );

  r.get(
    "/registry/metadata/v1/instruments/:instrumentId",
    asyncHandler(async (req, res) => {
      const rows = await deps.ledger.activeContracts(
        deps.config.instrumentConfigTemplateId,
        deps.config.operatorParty,
      );
      const cfg = resolveOrRespond(res, resolveById(rows, req.params.instrumentId));
      if (!cfg) return;
      res.json(toInstrument(cfg.payload));
    }),
  );

  return r;
}
