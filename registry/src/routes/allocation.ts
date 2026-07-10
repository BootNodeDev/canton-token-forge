import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { toDisclosed, EXPIRE_LOCK_CONTEXT_KEY, anyValueBool } from "../disclose.js";
import { resolveConfig } from "../mapping.js";
import type { ContractEntry } from "../ledger.js";
import { asyncHandler } from "./async-handler.js";

export function allocationRouter(deps: ServerDeps): Router {
  const r = Router();

  r.post(
    "/registry/allocation-instruction/v1/allocation-factory",
    asyncHandler(async (req, res) => {
      const instrumentId = req.body?.choiceArguments?.allocation?.instrumentId;
      if (!instrumentId) return res.status(400).json({ error: "missing allocation.instrumentId" });

      const rows = await deps.ledger.activeContracts(deps.config.instrumentConfigTemplateId, deps.config.operatorParty);
      const result = resolveConfig(rows, instrumentId.admin, instrumentId.id);
      if (result.kind === "none") return res.status(404).json({ error: "instrument not found" });
      if (result.kind === "conflict") {
        return res.status(409).json({ error: "instrument id not unique", contractIds: result.contractIds });
      }
      const cfg = result.entry;

      res.json({
        factoryId: cfg.contractId,
        choiceContext: { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] },
      });
    }),
  );

  // Only cancel is jointly authorized (executor + sender + receiver), so
  // only it may release the escrow before settleBefore, and it does so by
  // reading the early-release signal from the context. execute-transfer
  // never needs it, and withdraw is deadline-gated on-ledger and ignores
  // it, so both send empty context data.
  for (const choice of ["execute-transfer", "withdraw", "cancel"]) {
    r.post(
      `/registry/allocations/v1/:allocationId/choice-contexts/${choice}`,
      asyncHandler(async (req, res) => {
        const allocationRows = await deps.ledger.activeContracts(
          deps.config.allocationInterfaceId,
          deps.config.operatorParty,
        );
        const alloc = allocationRows.find((row) => row.contractId === req.params.allocationId);
        if (!alloc) return res.status(404).json({ error: "allocation not found" });

        const lockedRows = await deps.ledger.activeContracts(
          deps.config.lockedTokenTemplateId,
          deps.config.operatorParty,
        );
        const escrow = lockedRows.find((row) => row.contractId === alloc.payload.lockedCid);

        const disclosedContracts = [escrow].filter((c): c is ContractEntry => c != null).map(toDisclosed);
        const choiceContextData = choice === "cancel" ? { [EXPIRE_LOCK_CONTEXT_KEY]: anyValueBool(true) } : {};
        res.json({ choiceContextData, disclosedContracts });
      }),
    );
  }

  return r;
}
