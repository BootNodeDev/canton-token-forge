import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";
import { validateAgainst } from "./helpers/schema";
import { EXPIRE_LOCK_CONTEXT_KEY, anyValueBool } from "../src/disclose";
import { config, instrumentId, cfgEntry, lockedTokenEntry, ledgerFrom } from "./helpers/fixtures";

function allocationEntry(overrides: any = {}) {
  return {
    templateId: config.allocationInterfaceId,
    contractId: "alloc1",
    createdEventBlob: "BLOB-ALLOC",
    synchronizerId: "s",
    payload: {
      admin: instrumentId.admin,
      allocation: {
        settlement: { executor: "executor::1", settlementRef: { id: "ref1", cid: null }, requestedAt: "2020-01-01T00:00:00Z", allocateBefore: "2999-01-01T00:00:00Z", settleBefore: "2999-01-01T00:00:00Z" },
        transferLegId: "leg1",
        transferLeg: { sender: "sender::1", receiver: "receiver::1", amount: "10.0", instrumentId },
      },
      lockedCid: "locked1",
      meta: { values: {} },
      ...overrides,
    },
  };
}

describe("allocation factory", () => {
  it("returns factoryId + disclosed config", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocation-instruction/v1/allocation-factory")
      .send({ choiceArguments: { allocation: { instrumentId } } });
    expect(res.status).toBe(200);
    validateAgainst("allocation-instruction#/components/schemas/FactoryWithChoiceContext", res.body);
    expect(res.body.factoryId).toBe("cfg1");
    expect(res.body.choiceContext.choiceContextData).toEqual({});
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1);
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: "cfg1" });
  });

  it("400s when choiceArguments.allocation.instrumentId is missing", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocation-instruction/v1/allocation-factory")
      .send({ choiceArguments: { allocation: {} } });
    expect(res.status).toBe(400);
  });

  it("404s when no config matches the instrumentId", async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocation-instruction/v1/allocation-factory")
      .send({ choiceArguments: { allocation: { instrumentId } } });
    expect(res.status).toBe(404);
  });

  it("409s when (admin, instrumentId) is not unique", async () => {
    const dup = cfgEntry();
    dup.contractId = "cfg2";
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry(), dup] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocation-instruction/v1/allocation-factory")
      .send({ choiceArguments: { allocation: { instrumentId } } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("instrument id not unique");
    expect(res.body.contractIds.sort()).toEqual(["cfg1", "cfg2"]);
  });
});

describe("allocation choice-contexts", () => {
  it("cancel carries the expire-lock signal and discloses the escrow LockedToken", async () => {
    const ledger = ledgerFrom({
      [config.allocationInterfaceId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocations/v1/alloc1/choice-contexts/cancel")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("allocation#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData[EXPIRE_LOCK_CONTEXT_KEY]).toEqual(anyValueBool(true));
    const ids = res.body.disclosedContracts.map((d: any) => d.contractId).sort();
    expect(ids).toEqual(["locked1"]);
  });

  it("withdraw discloses the escrow LockedToken but sends no signal", async () => {
    const ledger = ledgerFrom({
      [config.allocationInterfaceId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocations/v1/alloc1/choice-contexts/withdraw")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("allocation#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData).toEqual({});
    const ids = res.body.disclosedContracts.map((d: any) => d.contractId).sort();
    expect(ids).toEqual(["locked1"]);
  });

  it("execute-transfer sends no signal", async () => {
    const ledger = ledgerFrom({
      [config.allocationInterfaceId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocations/v1/alloc1/choice-contexts/execute-transfer")
      .send({ meta: {} });
    expect(res.status).toBe(200);
    validateAgainst("allocation#/components/schemas/ChoiceContext", res.body);
    expect(res.body.choiceContextData).toEqual({});
  });

  it("404s when the allocation is not found", async () => {
    const ledger = ledgerFrom({ [config.allocationInterfaceId]: [] });
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/registry/allocations/v1/nope/choice-contexts/cancel")
      .send({ meta: {} });
    expect(res.status).toBe(404);
  });
});
