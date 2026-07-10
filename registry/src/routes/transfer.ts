import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { toDisclosed, PREAPPROVAL_CONTEXT_KEY, anyValueContractId } from "../disclose.js";
import { resolveConfig, resolveOrRespond, matchesInstrument } from "../mapping.js";
import { asyncHandler } from "./async-handler.js";
import { findByContractId, escrowDisclosure, activeConfigs } from "./lookup.js";

export function transferRouter(deps: ServerDeps): Router {
  const r = Router();

  r.post(
    "/registry/transfer-instruction/v1/transfer-factory",
    asyncHandler(async (req, res) => {
      const transfer = req.body?.choiceArguments?.transfer;
      const instrumentId = transfer?.instrumentId;
      if (!instrumentId) return res.status(400).json({ error: "missing transfer.instrumentId" });
      const { sender, receiver } = transfer;
      if (!sender || !receiver) return res.status(400).json({ error: "missing transfer.sender or transfer.receiver" });

      const cfg = resolveOrRespond(res, resolveConfig(await activeConfigs(deps.ledger, deps.config), instrumentId.admin, instrumentId.id));
      if (!cfg) return;

      // self and offer share the same empty context disclosing only the
      // config; only a matched in-window preapproval upgrades to a direct one.
      const baseContext = { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] };

      if (sender === receiver) {
        return res.json({ factoryId: cfg.contractId, transferKind: "self", choiceContext: baseContext });
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
          matchesInstrument(p.payload, instrumentId) &&
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

      return res.json({ factoryId: cfg.contractId, transferKind: "offer", choiceContext: baseContext });
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
        const cfg = resolveOrRespond(res, resolveConfig(await activeConfigs(deps.ledger, deps.config), instrumentId.admin, instrumentId.id));
        if (!cfg) return;

        const escrow = await escrowDisclosure(deps.ledger, deps.config, instr.payload.lockedCid);
        const disclosedContracts = [toDisclosed(cfg), ...escrow];
        res.json({ choiceContextData: {}, disclosedContracts });
      }),
    );
  }

  return r;
}
