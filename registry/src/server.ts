import express, { Express } from "express";
import type { Config } from "./config.js";
import type { LedgerClient } from "./ledger.js";
import { metadataRouter } from "./routes/metadata.js";
import { transferRouter } from "./routes/transfer.js";
import { allocationRouter } from "./routes/allocation.js";
import { adminRouter } from "./routes/admin.js";

export interface ServerDeps {
  ledger: LedgerClient;
  config: Config;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use(metadataRouter(deps));
  app.use(transferRouter(deps));
  app.use(allocationRouter(deps));
  app.use(adminRouter(deps));
  return app;
}
