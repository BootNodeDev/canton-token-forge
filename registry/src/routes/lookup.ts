import type { Config } from "../config.js";
import type { ContractEntry, LedgerClient } from "../ledger.js";
import { toDisclosed, type DisclosedContract } from "../disclose.js";

// Locate a single active contract by its id within a template's active set.
// Several handlers resolve a path parameter (a proposal, an allocation, a
// transfer instruction) this way before acting on it, so the query lives in
// one place; live-node work that changes how a contract is located by id
// then has a single call site to update.
export async function findByContractId(
  ledger: LedgerClient,
  templateId: string,
  party: string,
  contractId: string,
): Promise<ContractEntry | undefined> {
  const rows = await ledger.activeContracts(templateId, party);
  return rows.find((row) => row.contractId === contractId);
}

// Resolve the escrow LockedToken behind a lockedCid and return it as a
// disclosure list (empty if it is not in the active set). The receiver is not
// a stakeholder of the escrow, so the transfer and allocation choice-contexts
// both disclose it this way before the counterparty exercises its choice.
export async function escrowDisclosure(
  ledger: LedgerClient,
  config: Pick<Config, "lockedTokenTemplateId" | "operatorParty">,
  lockedCid: string,
): Promise<DisclosedContract[]> {
  const escrow = await findByContractId(ledger, config.lockedTokenTemplateId, config.operatorParty, lockedCid);
  return escrow ? [toDisclosed(escrow)] : [];
}
