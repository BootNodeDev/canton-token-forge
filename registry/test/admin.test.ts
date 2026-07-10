import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";

const config = {
  operatorParty: "op::1",
  registryBaseUrl: "http://r",
  instrumentConfigTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
  instrumentConfigProposalTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfigProposal",
  tokenRegistryTemplateId: "pkg:Canton.TokenForge.Registry:TokenRegistry",
} as any;

function registryEntry(overrides: any = {}) {
  return {
    templateId: config.tokenRegistryTemplateId,
    contractId: "reg1",
    createdEventBlob: "BLOB-REG",
    synchronizerId: "s",
    payload: {
      operator: "op::1",
      registryBaseUrl: "http://r",
      ...overrides,
    },
  };
}

function proposalEntry(overrides: any = {}) {
  return {
    templateId: config.instrumentConfigProposalTemplateId,
    contractId: "prop1",
    createdEventBlob: "BLOB-PROP",
    synchronizerId: "s",
    payload: {
      admin: "admin::1",
      operator: "op::1",
      instrumentId: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
      faucet: false,
      ...overrides,
    },
  };
}

function cfgEntry(overrides: any = {}) {
  return {
    templateId: config.instrumentConfigTemplateId,
    contractId: "cfg1",
    createdEventBlob: "BLOB-CFG",
    synchronizerId: "s",
    payload: {
      admin: "admin::1",
      operator: "op::1",
      instrumentId: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
      faucet: false,
      ...overrides,
    },
  };
}

function ledgerFrom(byTemplate: Record<string, any[]>) {
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

describe("POST /admin/instruments", () => {
  it("resolves the active registry and submits TokenRegistry_ProposeInstrument as the admin, disclosing the registry", async () => {
    const { ledger, calls } = ledgerFrom({ [config.tokenRegistryTemplateId]: [registryEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/instruments").send({
      admin: "admin::1",
      instrumentId: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
      faucet: false,
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "proposed" });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.actAs).toEqual(["admin::1"]);
    expect(call.commands).toEqual([
      {
        templateId: config.tokenRegistryTemplateId,
        contractId: "reg1",
        choice: "TokenRegistry_ProposeInstrument",
        choiceArgument: {
          admin: "admin::1",
          instrumentId: "CC",
          name: "Canton Coin",
          symbol: "CC",
          decimals: 10,
          faucet: false,
        },
      },
    ]);
    expect(call.disclosedContracts).toEqual([
      {
        templateId: config.tokenRegistryTemplateId,
        contractId: "reg1",
        createdEventBlob: "BLOB-REG",
        synchronizerId: "s",
      },
    ]);
  });

  it("defaults an absent faucet to null in the choice argument", async () => {
    const { ledger, calls } = ledgerFrom({ [config.tokenRegistryTemplateId]: [registryEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/instruments").send({
      admin: "admin::1",
      instrumentId: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
    });
    expect(res.status).toBe(202);
    expect((calls[0].commands[0] as any).choiceArgument.faucet).toBeNull();
  });

  it("400s when a required field is missing", async () => {
    const { ledger } = ledgerFrom({ [config.tokenRegistryTemplateId]: [registryEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/instruments").send({
      admin: "admin::1",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("503s when no registry is active", async () => {
    const { ledger } = ledgerFrom({ [config.tokenRegistryTemplateId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/instruments").send({
      admin: "admin::1",
      instrumentId: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "registry not initialized" });
  });
});

describe("POST /admin/proposals/:proposalId/accept", () => {
  it("409s when an active InstrumentConfig already shares (admin, instrumentId), and does not submit", async () => {
    const { ledger, calls } = ledgerFrom({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [cfgEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/prop1/accept").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("instrument id already registered");
    expect(res.body.contractIds).toEqual(["cfg1"]);
    expect(calls).toHaveLength(0);
  });

  it("409s with all conflicting contractIds when the duplicate check itself is not unique", async () => {
    const dup = cfgEntry();
    dup.contractId = "cfg2";
    const { ledger, calls } = ledgerFrom({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [cfgEntry(), dup],
    });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/prop1/accept").send({});
    expect(res.status).toBe(409);
    expect(res.body.contractIds.sort()).toEqual(["cfg1", "cfg2"]);
    expect(calls).toHaveLength(0);
  });

  it("submits InstrumentConfigProposal_Accept as the operator when there is no duplicate", async () => {
    const { ledger, calls } = ledgerFrom({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [],
    });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/prop1/accept").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
    expect(calls).toHaveLength(1);
    expect(calls[0].actAs).toEqual(["op::1"]);
    expect(calls[0].commands).toEqual([
      {
        templateId: config.instrumentConfigProposalTemplateId,
        contractId: "prop1",
        choice: "InstrumentConfigProposal_Accept",
        choiceArgument: {},
      },
    ]);
  });

  it("404s when the proposal is not found", async () => {
    const { ledger } = ledgerFrom({ [config.instrumentConfigProposalTemplateId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/nope/accept").send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/proposals/:proposalId/reject", () => {
  it("submits InstrumentConfigProposal_Reject as the operator", async () => {
    const { ledger, calls } = ledgerFrom({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/prop1/reject").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "rejected" });
    expect(calls).toHaveLength(1);
    expect(calls[0].actAs).toEqual(["op::1"]);
    expect(calls[0].commands).toEqual([
      {
        templateId: config.instrumentConfigProposalTemplateId,
        contractId: "prop1",
        choice: "InstrumentConfigProposal_Reject",
        choiceArgument: {},
      },
    ]);
  });

  it("404s when the proposal is not found", async () => {
    const { ledger } = ledgerFrom({ [config.instrumentConfigProposalTemplateId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app).post("/admin/proposals/nope/reject").send({});
    expect(res.status).toBe(404);
  });
});
