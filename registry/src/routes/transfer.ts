import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { toDisclosed, PREAPPROVAL_CONTEXT_KEY, anyValueContractId } from "../disclose.js";
import { resolveConfig, resolveOrRespond } from "../mapping.js";
import type { ContractEntry } from "../ledger.js";
import { asyncHandler } from "./async-handler.js";
import { findByContractId, escrowDisclosure } from "./lookup.js";

export function transferRouter(deps: ServerDeps): Router {
  const r = Router();

  async function configRows(): Promise<ContractEntry[]> {
    return deps.ledger.activeContracts(deps.config.instrumentConfigTemplateId, deps.config.operatorParty);
  }

  r.post(
    "/registry/transfer-instruction/v1/transfer-factory",
    asyncHandler(async (req, res) => {
      const transfer = req.body?.choiceArguments?.transfer;
      const instrumentId = transfer?.instrumentId;
      if (!instrumentId) return res.status(400).json({ error: "missing transfer.instrumentId" });
      const { sender, receiver } = transfer;
      if (!sender || !receiver) return res.status(400).json({ error: "missing transfer.sender or transfer.receiver" });

      const cfg = resolveOrRespond(res, resolveConfig(await configRows(), instrumentId.admin, instrumentId.id));
      if (!cfg) return;

      if (sender === receiver) {
        return res.json({
          factoryId: cfg.contractId,
          transferKind: "self",
          choiceContext: { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] },
        });
      }

      // Only a preapproval whose validity window covers now enables a direct
      // transfer: TokenTransferPreapproval_Send asserts validFrom <= now <
      // expiresAt on-ledger, and the direct path hard-fails (no offer
      // fallback) against an out-of-window one, so an expired or
      // not-yet-valid preapproval must fall through to "offer" here.
      const now = Date.now();
      const preapprovalRows = await deps.ledger.activeContracts(
        deps.config.preapprovalTemplateId,
        deps.config.operatorParty,
      );
      const pre = preapprovalRows.find(
        (p) =>
          p.payload.admin === instrumentId.admin &&
          p.payload.instrumentId === instrumentId.id &&
          p.payload.receiver === receiver &&
          Date.parse(p.payload.validFrom) <= now &&
          now < Date.parse(p.payload.expiresAt),
      );
      if (pre) {
        return res.json({
          factoryId: cfg.contractId,
          transferKind: "direct",
          choiceContext: {
            choiceContextData: { [PREAPPROVAL_CONTEXT_KEY]: anyValueContractId(pre.contractId) },
            disclosedContracts: [toDisclosed(cfg), toDisclosed(pre)],
          },
        });
      }

      return res.json({
        factoryId: cfg.contractId,
        transferKind: "offer",
        choiceContext: { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] },
      });
    }),
  );

  // accept / reject / withdraw all disclose the InstrumentConfig and the
  // escrow LockedToken; none of the three read the expire-lock signal on
  // the transfer path (reject unlocks unconditionally, withdraw is
  // deadline-gated on-ledger), so choiceContextData is always empty here.
  for (const choice of ["accept", "reject", "withdraw"]) {
    r.post(
      `/registry/transfer-instruction/v1/:transferInstructionId/choice-contexts/${choice}`,
      asyncHandler(async (req, res) => {
        const instr = await findByContractId(
          deps.ledger,
          deps.config.transferInstructionInterfaceId,
          deps.config.operatorParty,
          req.params.transferInstructionId,
        );
        if (!instr) return res.status(404).json({ error: "transfer instruction not found" });

        const instrumentId = instr.payload.transfer.instrumentId;
        const cfg = resolveOrRespond(res, resolveConfig(await configRows(), instrumentId.admin, instrumentId.id));
        if (!cfg) return;

        const escrow = await escrowDisclosure(deps.ledger, deps.config, instr.payload.lockedCid);
        const disclosedContracts = [toDisclosed(cfg), ...escrow];
        res.json({ choiceContextData: {}, disclosedContracts });
      }),
    );
  }

  return r;
}
