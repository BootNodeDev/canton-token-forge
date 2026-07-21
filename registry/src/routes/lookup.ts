import type { Config } from "../config.js";
import type { ContractEntry, LedgerClient } from "../ledger.js";
import { toDisclosed, type DisclosedContract } from "../disclose.js";
import type {
  InstrumentConfigPayload,
  PreapprovalPayload,
  TokenRegistryPayload,
} from "../payloads.js";

// The ledger client returns payloads as unknown; the wrappers below pair one
// template id with its payload shape. The cast that gives the routes their
// types happens once here, in activeContractsAs, so each active-set query is a
// one-line binding of a template-id field to a payload type.
function activeContractsAs<P>(
  ledger: LedgerClient,
  templateId: string,
  party: string,
): Promise<ContractEntry<P>[]> {
  return ledger.activeContracts(templateId, party) as Promise<ContractEntry<P>[]>;
}

// The InstrumentConfig active set for the operator, which the routes then run
// through resolveConfig/resolveById. Centralized so the "which template, which
// party identifies the config set" choice has one home, alongside
// findByContractId and escrowDisclosure below.
export function activeConfigs(
  ledger: LedgerClient,
  config: Pick<Config, "instrumentConfigTemplateId" | "operatorParty">,
): Promise<ContractEntry<InstrumentConfigPayload>[]> {
  return activeContractsAs<InstrumentConfigPayload>(ledger, config.instrumentConfigTemplateId, config.operatorParty);
}

export function activePreapprovals(
  ledger: LedgerClient,
  config: Pick<Config, "preapprovalTemplateId" | "operatorParty">,
): Promise<ContractEntry<PreapprovalPayload>[]> {
  return activeContractsAs<PreapprovalPayload>(ledger, config.preapprovalTemplateId, config.operatorParty);
}

export function activeRegistries(
  ledger: LedgerClient,
  config: Pick<Config, "tokenRegistryTemplateId" | "operatorParty">,
): Promise<ContractEntry<TokenRegistryPayload>[]> {
  return activeContractsAs<TokenRegistryPayload>(ledger, config.tokenRegistryTemplateId, config.operatorParty);
}

// Locate a single active contract by its id within a template's active set.
// Several handlers resolve a path parameter (a proposal, an allocation, a
// transfer instruction) this way before acting on it, so the query lives in
// one place; live-node work that changes how a contract is located by id
// then has a single call site to update.
export async function findByContractId<P = unknown>(
  ledger: LedgerClient,
  templateId: string,
  party: string,
  contractId: string,
): Promise<ContractEntry<P> | undefined> {
  const rows = (await ledger.activeContracts(templateId, party)) as ContractEntry<P>[];
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
