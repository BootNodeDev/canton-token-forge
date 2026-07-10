import express, { Express } from "express";
import type { Config } from "./config.js";
import type { LedgerClient } from "./ledger.js";
import { metadataRouter } from "./routes/metadata.js";

export interface ServerDeps {
  ledger: LedgerClient;
  config: Config;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use(metadataRouter(deps));
  // route groups mounted in later tasks
  return app;
}
