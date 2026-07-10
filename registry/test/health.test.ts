import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "../src/server";

describe("health", () => {
  it("GET /healthz returns 200 ok", async () => {
    const app = createServer({ ledger: {} as any, config: {} as any });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
