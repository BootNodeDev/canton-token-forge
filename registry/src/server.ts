import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import * as OpenApiValidator from 'express-openapi-validator'
import type { Config } from './config.js'
import type { LedgerClient } from './ledger.js'
import { adminRouter } from './routes/admin.js'
import { allocationRouter } from './routes/allocation.js'
import { metadataRouter } from './routes/metadata.js'
import { transferRouter } from './routes/transfer.js'

export interface ServerDeps {
  ledger: LedgerClient
  config: Config
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
  app.use(express.json())

  // One validator per vendored standard spec, requests only. Paths a given
  // spec does not document are ignored so the other specs' routes and the
  // service-specific /admin and health endpoints pass through; responses
  // stay schema-checked in the test suite instead of per-request.
  const specDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi')
  const specFiles = [
    'token-metadata-v1.yaml',
    'transfer-instruction-v1.yaml',
    'allocation-v1.yaml',
    'allocation-instruction-v1.yaml',
  ]
  // Splice/CN integer-width format hints that the schemas' type: integer
  // already covers, so we register them permissively only to keep ajv quiet.
  const customFormats = {
    int8: { type: 'number' as const, validate: () => true },
    int32: { type: 'number' as const, validate: () => true },
  }
  for (const specFile of specFiles) {
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(specDir, specFile),
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
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    res
      .status(statusFromError(err))
      .json({ error: err instanceof Error ? err.message : 'internal error' })
  })

  return app
}
