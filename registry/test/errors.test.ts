import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";

const config = {
  operatorParty: "op::1",
  registryBaseUrl: "http://r",
  instrumentConfigTemplateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
} as any;

describe("async route errors", () => {
  it("maps a rejected ledger call to a 500 with a JSON error body instead of hanging", async () => {
    const ledger = {
      activeContracts: async () => {
        throw new Error("ledger query failed: 503");
      },
    } as any;
    const app = createServer({ ledger, config });
    const res = await request(app).get("/registry/metadata/v1/instruments");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "ledger query failed: 503" });
  });

  it("preserves the 4xx status express.json() puts on a malformed body instead of reporting 500", async () => {
    const ledger = { activeContracts: async () => [] } as any;
    const app = createServer({ ledger, config });
    const res = await request(app)
      .post("/admin/instruments")
      .set("content-type", "application/json")
      .send('{"admin":');
    expect(res.status).toBe(400);
  });
});
