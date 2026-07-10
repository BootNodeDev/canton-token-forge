import type { ContractEntry, LedgerClient } from "../ledger.js";

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
