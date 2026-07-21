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

function statusFromError(err: unknown): number {
  if (err && typeof err === "object") {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status <= 599) return status;
  }
  return 500;
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
  // has all four parameters. It honors a status carried on the error (e.g.
  // express.json() tags a malformed body with 400) so framework-level client
  // errors are not re-classified as 500.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(statusFromError(err)).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}
