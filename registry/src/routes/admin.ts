import { Router } from "express";
import type { ServerDeps } from "../server.js";
import { toDisclosed } from "../disclose.js";
import { matchesInstrument } from "../mapping.js";
import { asyncHandler } from "./async-handler.js";
import { findByContractId, activeConfigs } from "./lookup.js";

// canton-token-forge admin endpoints that drive the Plan 04 propose-accept
// instrument-registration workflow. These sit outside the four standard
// registry API groups, so there is no vendored OpenAPI spec to validate
// their bodies against; error bodies still follow the service-wide
// { error } convention.
export function adminRouter(deps: ServerDeps): Router {
  const r = Router();

  // Admin proposes an instrument through the registry. The operator identity
  // is read from the registry contract on-ledger, so it is not a request
  // field. actAs the admin, disclosing the operator-signed registry so the
  // admin (not a registry stakeholder) can exercise a choice on it.
  r.post(
    "/admin/instruments",
    asyncHandler(async (req, res) => {
      const { admin, instrumentId, name, symbol, decimals, faucet } = req.body ?? {};
      if (!admin || !instrumentId || !name || !symbol || typeof decimals !== "number") {
        return res.status(400).json({ error: "missing proposal fields" });
      }

      const regs = await deps.ledger.activeContracts(deps.config.tokenRegistryTemplateId, deps.config.operatorParty);
      const reg = regs[0];
      if (!reg) return res.status(503).json({ error: "registry not initialized" });

      await deps.ledger.submitAndWait(
        [admin],
        [
          {
            templateId: deps.config.tokenRegistryTemplateId,
            contractId: reg.contractId,
            choice: "TokenRegistry_ProposeInstrument",
            choiceArgument: { admin, instrumentId, name, symbol, decimals, faucet: faucet ?? null },
          },
        ],
        [toDisclosed(reg)],
      );
      return res.status(202).json({ status: "proposed" });
    }),
  );

  // Operator accepts a pending proposal after the off-ledger (admin,
  // instrumentId) uniqueness check, the authoritative enforcement point
  // since LF 2.1 has no contract keys and the operator is a mandatory
  // participant in every InstrumentConfig creation.
  r.post(
    "/admin/proposals/:proposalId/accept",
    asyncHandler(async (req, res) => {
      const prop = await findByContractId(
        deps.ledger,
        deps.config.instrumentConfigProposalTemplateId,
        deps.config.operatorParty,
        req.params.proposalId,
      );
      if (!prop) return res.status(404).json({ error: "proposal not found" });

      const cfgRows = await activeConfigs(deps.ledger, deps.config);
      const dupIds = cfgRows
        .filter((r) => matchesInstrument(r.payload, { admin: prop.payload.admin, id: prop.payload.instrumentId }))
        .map((r) => r.contractId);
      if (dupIds.length > 0) {
        return res.status(409).json({ error: "instrument id already registered", contractIds: dupIds });
      }

      await deps.ledger.submitAndWait([deps.config.operatorParty], [
        {
          templateId: deps.config.instrumentConfigProposalTemplateId,
          contractId: prop.contractId,
          choice: "InstrumentConfigProposal_Accept",
          choiceArgument: {},
        },
      ]);
      return res.status(200).json({ status: "accepted" });
    }),
  );

  // Operator rejects a pending proposal, for parity with accept.
  r.post(
    "/admin/proposals/:proposalId/reject",
    asyncHandler(async (req, res) => {
      const prop = await findByContractId(
        deps.ledger,
        deps.config.instrumentConfigProposalTemplateId,
        deps.config.operatorParty,
        req.params.proposalId,
      );
      if (!prop) return res.status(404).json({ error: "proposal not found" });

      await deps.ledger.submitAndWait([deps.config.operatorParty], [
        {
          templateId: deps.config.instrumentConfigProposalTemplateId,
          contractId: prop.contractId,
          choice: "InstrumentConfigProposal_Reject",
          choiceArgument: {},
        },
      ]);
      return res.status(200).json({ status: "rejected" });
    }),
  );

  return r;
}
