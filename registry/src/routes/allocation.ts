import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { toDisclosed, EXPIRE_LOCK_CONTEXT_KEY, anyValueBool } from "../disclose.js";
import { resolveConfig } from "../mapping.js";
import { asyncHandler } from "./async-handler.js";
import { findByContractId, escrowDisclosure, activeConfigs } from "./lookup.js";
import type { AllocationPayload, InstrumentIdValue } from "../payloads.js";
import { resolveOrRespond } from "./respond.js";

interface AllocationFactoryBody {
  choiceArguments?: { allocation?: { instrumentId?: InstrumentIdValue } };
}

export function allocationRouter(deps: ServerDeps): Router {
  const r = Router();

  r.post(
    "/registry/allocation-instruction/v1/allocation-factory",
    asyncHandler(async (req, res) => {
      const instrumentId = (req.body as AllocationFactoryBody | undefined)?.choiceArguments?.allocation
        ?.instrumentId;
      if (!instrumentId) return res.status(400).json({ error: "missing allocation.instrumentId" });

      const rows = await activeConfigs(deps.ledger, deps.config);
      const cfg = resolveOrRespond(res, resolveConfig(rows, instrumentId.admin, instrumentId.id));
      if (!cfg) return;

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
        const alloc = await findByContractId<AllocationPayload>(
          deps.ledger,
          deps.config.allocationInterfaceId,
          deps.config.operatorParty,
          req.params.allocationId,
        );
        if (!alloc) return res.status(404).json({ error: "allocation not found" });

        const disclosedContracts = await escrowDisclosure(deps.ledger, deps.config, alloc.payload.lockedCid);
        const choiceContextData =
          choice === "cancel" ? { [EXPIRE_LOCK_CONTEXT_KEY]: anyValueBool(true) } : {};
        res.json({ choiceContextData, disclosedContracts });
      }),
    );
  }

  return r;
}
