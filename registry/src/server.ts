import path from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import * as OpenApiValidator from 'express-openapi-validator'
import type { Config } from './config.js'
import type { LedgerClient } from './ledger.js'
import { createLogger, type Logger } from './logger.js'
import { openapiDir, specFiles } from './openapi.js'
import { adminRouter } from './routes/admin.js'
import { allocationRouter } from './routes/allocation.js'
import { asyncHandler } from './routes/async-handler.js'
import { activeRegistries } from './routes/lookup.js'
import { metadataRouter } from './routes/metadata.js'
import { transferRouter } from './routes/transfer.js'

export interface ServerDeps {
  ledger: LedgerClient
  config: Config
  logger?: Logger
}

function statusFromError(err: unknown): number {
  if (err && typeof err === 'object') {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status <= 599) return status
  }
  return 500
}

export function createServer(deps: ServerDeps): Express {
  const app = express()
  const logger = deps.logger ?? createLogger()
  app.use(express.json())

  // One validator per vendored standard spec, requests only. Paths a given
  // spec does not document are ignored so the other specs' routes and the
  // service-specific /admin and health endpoints pass through; responses
  // stay schema-checked in the test suite instead of per-request.
  // Splice/CN integer-width format hints that the schemas' type: integer
  // already covers, so we register them permissively only to keep ajv quiet.
  const customFormats = {
    int8: { type: 'number' as const, validate: () => true },
    int32: { type: 'number' as const, validate: () => true },
  }
  for (const specFile of Object.values(specFiles)) {
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(openapiDir, specFile),
        validateRequests: {
          // Tolerate undeclared query params (cache-busters, client
          // instrumentation): the specs never forbid them and the handlers
          // ignore them, so rejecting them adds no safety, only friction.
          allowUnknownQueryParameters: true,
        },
        validateResponses: false,
        ignoreUndocumented: true,
        formats: customFormats,
      }),
    )
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))

  // Liveness (/healthz) must not depend on the ledger; readiness does, so
  // an orchestrator can hold traffic while the ledger connection is down.
  app.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      try {
        await activeRegistries(deps.ledger, deps.config)
      } catch {
        return res.status(503).json({ status: 'unavailable' })
      }
      res.json({ status: 'ready' })
    }),
  )

  app.use(metadataRouter(deps))
  app.use(transferRouter(deps))
  app.use(allocationRouter(deps))
  app.use(adminRouter(deps))

  // Terminal error handler: catches rejections funneled through
  // asyncHandler (e.g. a ledger query or submission failure) so a request
  // always gets a response instead of hanging until the socket times out.
  // Express only recognizes this as error-handling middleware because it
  // has all four parameters. It honors a status carried on the error (e.g.
  // express.json() tags a malformed body with 400) so framework-level client
  // errors are not re-classified as 500.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const status = statusFromError(err)
    // 5xx means the service itself failed (usually the ledger connection);
    // without this line a live-node outage is invisible in operator logs.
    if (status >= 500) {
      logger.error({ err, status, method: req.method, path: req.originalUrl }, 'request failed')
    }
    res.status(status).json({ error: err instanceof Error ? err.message : 'internal error' })
  })

  return app
}
