import express, { Express, NextFunction, Request, Response } from "express";
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

  // Terminal error handler: catches rejections funneled through
  // asyncHandler (e.g. a ledger query or submission failure) so a request
  // always gets a response instead of hanging until the socket times out.
  // Express only recognizes this as error-handling middleware because it
  // has all four parameters.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}
