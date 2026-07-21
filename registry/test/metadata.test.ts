import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";
import { validateAgainst } from "./helpers/schema";
import { config } from "./helpers/fixtures";
import type { LedgerClient } from "../src/ledger";
import type { InstrumentConfigPayload } from "../src/payloads";

function ledgerWith(payloads: InstrumentConfigPayload[]): LedgerClient {
  return {
    activeContracts: () =>
      Promise.resolve(
        payloads.map((p, i) => ({
          templateId: config.instrumentConfigTemplateId,
          contractId: `c${i}`,
          createdEventBlob: "b",
          synchronizerId: "s",
          payload: p,
        })),
      ),
    submitAndWait: () => Promise.reject(new Error("submitAndWait not expected in this test")),
  };
}

const cantonCoin: InstrumentConfigPayload = {
  admin: "admin::1",
  operator: "op::1",
  instrumentId: "CC",
  name: "Canton Coin",
  symbol: "CC",
  decimals: 10,
  faucet: null,
};

describe("metadata", () => {
  it("lists instruments", async () => {
    const ledger = ledgerWith([cantonCoin]);
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments");
    expect(res.status).toBe(200);
    validateAgainst("metadata#/components/schemas/ListInstrumentsResponse", res.body);
    expect(res.body.instruments[0]).toMatchObject({
      id: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
    });
    expect(res.body.instruments[0].supportedApis).toBeDefined();
  });

  it("collapses duplicate (admin, instrumentId) rows in the list", async () => {
    const duplicate = { ...cantonCoin, name: "Canton Coin (second create)" };
    const ledger = ledgerWith([cantonCoin, duplicate]);
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments");
    expect(res.status).toBe(200);
    validateAgainst("metadata#/components/schemas/ListInstrumentsResponse", res.body);
    expect(res.body.instruments).toHaveLength(1);
    expect(res.body.instruments[0].id).toBe("CC");
  });

  it("returns registry info", async () => {
    const app = createServer({ ledger: ledgerWith([]), config });
    const res = await request(app).get("/registry/metadata/v1/info");
    expect(res.status).toBe(200);
    validateAgainst("metadata#/components/schemas/GetRegistryInfoResponse", res.body);
    expect(res.body.adminId).toBe("op::1");
    expect(res.body.supportedApis).toBeDefined();
  });

  it("gets an instrument by id when unique", async () => {
    const ledger = ledgerWith([cantonCoin]);
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments/CC");
    expect(res.status).toBe(200);
    validateAgainst("metadata#/components/schemas/Instrument", res.body);
    expect(res.body).toMatchObject({
      id: "CC",
      name: "Canton Coin",
      symbol: "CC",
      decimals: 10,
    });
  });

  it("404s when no instrument matches the id", async () => {
    const ledger = ledgerWith([cantonCoin]);
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments/NOPE");
    expect(res.status).toBe(404);
    validateAgainst("metadata#/components/schemas/ErrorResponse", res.body);
    expect(res.body).toEqual({ error: "instrument not found" });
  });

  it("409s when (admin, instrumentId) is not unique", async () => {
    const duplicate = { ...cantonCoin, admin: "admin::2" };
    const ledger = ledgerWith([cantonCoin, duplicate]);
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments/CC");
    expect(res.status).toBe(409);
    validateAgainst("metadata#/components/schemas/ErrorResponse", res.body);
    expect(res.body.error).toBe("instrument id not unique");
    expect(res.body.contractIds).toEqual(["c0", "c1"]);
  });
});
