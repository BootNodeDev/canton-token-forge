import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";
import { validateAgainst } from "./helpers/schema";
import { PREAPPROVAL_CONTEXT_KEY } from "../src/disclose";

const config = {
  operatorParty: "op::1",
  registryBaseUrl: "http://r",
  instrumentConfigTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
  transferInstructionInterfaceId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
  preapprovalTemplateId: "pkg:Canton.TokenForge.Registry:TokenTransferPreapproval",
  lockedTokenTemplateId: "pkg:Canton.TokenForge.Registry:LockedToken",
} as any;

const instrumentId = { admin: "admin::1", id: "CC" };

function cfgEntry(overrides: any = {}) {
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
      faucet: false,
      ...overrides,
    },
  };
}

function preapprovalEntry(overrides: any = {}) {
  return {
    templateId: config.preapprovalTemplateId,
    contractId: "pre1",
    createdEventBlob: "BLOB-PRE",
    synchronizerId: "s",
    payload: {
      admin: instrumentId.admin,
      instrumentId: instrumentId.id,
      receiver: "receiver::1",
      validFrom: "2020-01-01T00:00:00Z",
      expiresAt: "2999-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

function instructionEntry(overrides: any = {}) {
  return {
    templateId: config.transferInstructionInterfaceId,
    contractId: "instr1",
    createdEventBlob: "BLOB-INSTR",
    synchronizerId: "s",
    payload: {
      admin: instrumentId.admin,
      transfer: {
        sender: "sender::1",
        receiver: "receiver::1",
        instrumentId,
        amount: "10.0",
        meta: { values: {} },
      },
      lockedCid: "locked1",
      ...overrides,
    },
  };
}

function lockedTokenEntry(overrides: any = {}) {
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

function ledgerFrom(byTemplate: Record<string, any[]>) {
  return {
    activeContracts: async (templateOrInterfaceId: string) => byTemplate[templateOrInterfaceId] ?? [],
  } as any;
}

describe("transfer factory", () => {
  it("returns transferKind offer and discloses only the config when there is no preapproval", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext", res.body);
    expect(res.body.factoryId).toBe("cfg1");
    expect(res.body.transferKind).toBe("offer");
    expect(res.body.choiceContext.choiceContextData).toEqual({});
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1);
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: "cfg1" });
  });

  it("returns transferKind direct and discloses config + preapproval when an in-window preapproval exists", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [preapprovalEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext", res.body);
    expect(res.body.transferKind).toBe("direct");
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(2);
    expect(res.body.choiceContext.disclosedContracts.map((d: any) => d.contractId).sort()).toEqual(["cfg1", "pre1"]);
    expect(res.body.choiceContext.choiceContextData[PREAPPROVAL_CONTEXT_KEY]).toEqual({
      tag: "AV_ContractId",
      value: "pre1",
    });
  });

  it("returns transferKind self and discloses only the config when sender === receiver", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [preapprovalEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "same::1", receiver: "same::1" } } });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext", res.body);
    expect(res.body.transferKind).toBe("self");
    expect(res.body.choiceContext.choiceContextData).toEqual({});
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1);
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: "cfg1" });
  });

  it("falls through to offer when the only preapproval is out of its validity window", async () => {
    const expired = preapprovalEntry({ validFrom: "2020-01-01T00:00:00Z", expiresAt: "2021-01-01T00:00:00Z" });
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [expired],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext", res.body);
    expect(res.body.transferKind).toBe("offer");
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1);
  });

  it("400s when choiceArguments.transfer.instrumentId is missing", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(400);
  });

  it("404s when no config matches the instrumentId", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(404);
  });

  it("409s when (admin, instrumentId) is not unique", async () => {
    const dup = cfgEntry();
    dup.contractId = "cfg2";
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry(), dup] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/transfer-factory")
      .send({ choiceArguments: { transfer: { instrumentId, sender: "sender::1", receiver: "receiver::1" } } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("instrument id not unique");
    expect(res.body.contractIds.sort()).toEqual(["cfg1", "cfg2"]);
  });
});

describe("transfer-instruction choice-contexts", () => {
  it("discloses the config and the escrow LockedToken for accept", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionInterfaceId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/instr1/choice-contexts/accept")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData).toEqual({});
    const ids = res.body.disclosedContracts.map((d: any) => d.contractId).sort();
    expect(ids).toEqual(["cfg1", "locked1"]);
  });

  it("discloses the config and the escrow LockedToken for reject", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionInterfaceId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/instr1/choice-contexts/reject")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData).toEqual({});
    const ids = res.body.disclosedContracts.map((d: any) => d.contractId).sort();
    expect(ids).toEqual(["cfg1", "locked1"]);
  });

  it("discloses the config and the escrow LockedToken for withdraw", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionInterfaceId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/instr1/choice-contexts/withdraw")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("transfer-instruction#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData).toEqual({});
    const ids = res.body.disclosedContracts.map((d: any) => d.contractId).sort();
    expect(ids).toEqual(["cfg1", "locked1"]);
  });

  it("404s when the transfer instruction is not found", async () => {
    const ledger = ledgerFrom({ [config.transferInstructionInterfaceId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/transfer-instruction/v1/nope/choice-contexts/accept")
      .send({ meta: {} });
    expect(res.status).toBe(404);
  });
});
