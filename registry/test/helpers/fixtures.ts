// Shared test fixtures for the registry route suites. The config is a superset
// of the template ids every suite needs, so each test uses the fields relevant
// to it; the entry builders and ledger stubs are the ones duplicated verbatim
// across the transfer, allocation, admin, and metadata suites.

export const config = {
  operatorParty: "op::1",
  registryBaseUrl: "http://r",
  instrumentConfigTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
  instrumentConfigProposalTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfigProposal",
  tokenRegistryTemplateId: "pkg:Canton.TokenForge.Registry:TokenRegistry",
  transferInstructionInterfaceId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
  preapprovalTemplateId: "pkg:Canton.TokenForge.Registry:TokenTransferPreapproval",
  lockedTokenTemplateId: "pkg:Canton.TokenForge.Registry:LockedToken",
  allocationInterfaceId: "pkg:Splice.Api.Token.AllocationV1:Allocation",
} as any;

export const instrumentId = { admin: "admin::1", id: "CC" };

export function cfgEntry(overrides: any = {}) {
  return {
    templateId: config.instrumentConfigTemplateId,
    contractId: "cfg1",
    createdEventBlob: "BLOB-CFG",
    synchronizerId: "s",
    payload: {
      admin: instrumentId.admin,
      operator: "op::1",
      instrumentId: instrumentId.id,
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
      faucet: null,
      ...overrides,
    },
  };
}

export function lockedTokenEntry(overrides: any = {}) {
  return {
    templateId: config.lockedTokenTemplateId,
    contractId: "locked1",
    createdEventBlob: "BLOB-LOCK",
    synchronizerId: "s",
    payload: {
      admin: instrumentId.admin,
      ...overrides,
    },
  };
}

// A read-only ledger stub serving active contracts by template id.
export function ledgerFrom(byTemplate: Record<string, any[]>) {
  return {
    activeContracts: async (templateOrInterfaceId: string) => byTemplate[templateOrInterfaceId] ?? [],
  } as any;
}

// A ledger stub that also records submitAndWait calls for the admin suite,
// which asserts the actAs / commands / disclosedContracts it submits.
export function recordingLedger(byTemplate: Record<string, any[]>) {
  const calls: { actAs: string[]; commands: any[]; disclosedContracts: any[] }[] = [];
  const ledger = {
    activeContracts: async (templateOrInterfaceId: string) => byTemplate[templateOrInterfaceId] ?? [],
    submitAndWait: async (actAs: string[], commands: any[], disclosedContracts: any[] = []) => {
      calls.push({ actAs, commands, disclosedContracts });
      return { transactionId: "tx-1" };
    },
  } as any;
  return { ledger, calls };
}
