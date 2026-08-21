import path from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import * as OpenApiValidator from 'express-openapi-validator'
import type { Config } from './config.js'
import type { LedgerClient } from './ledger.js'
import { createLogger, type Logger } from './logger.js'
import { openapiDir, specFiles } from './openapi.js'
import { allocationRouter } from './routes/allocation.js'
import { asyncHandler } from './routes/async-handler.js'
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

// The path and query of a request target, dropping the scheme and authority an
// absolute-form target carries. This is the same split express applies to
// req.url (its getProtohost), so the two cannot disagree about where the path
// starts.
function originForm(target: string): string {
  if (target.startsWith('/')) return target
  const query = target.indexOf('?')
  const scheme = target.slice(0, query === -1 ? target.length : query).indexOf('://')
  if (scheme === -1) return target
  const pathStart = target.indexOf('/', scheme + 3)
  return pathStart === -1 ? '/' : target.slice(pathStart)
}

// RFC 9112 section 3.2.2 lets a client address any server in the absolute form
// (`GET http://host/path`), and node passes that target through verbatim.
// Express routes on the parsed pathname either way, but the request validator
// looks its route up in the unstripped req.originalUrl, where the scheme and
// authority make the request match no path in any spec; ignoreUndocumented then
// passes it on unvalidated, which is how the two forms of one request came to
// get different answers. Canonicalizing the field the validator reads is what
// makes them agree.
// req.url is deliberately left as node delivered it: express reads the mount
// prefix it strips from req.url once per request, before any middleware runs,
// so rewriting it here would cut into the path of every layer mounted on a base
// path. Express already handles the absolute form on its own.
function canonicalizeRequestTarget(req: Request, _res: Response, next: NextFunction): void {
  req.originalUrl = originForm(req.originalUrl)
  next()
}

export function createServer(deps: ServerDeps): Express {
  const app = express()
  const logger = deps.logger ?? createLogger()
  app.use(canonicalizeRequestTarget)
  app.use(express.json())

  // One validator per vendored standard spec, requests only, each mounted on
  // the prefix its own spec documents so a request meets only the validator
  // that could describe it and the health endpoints meet none. The specs are
  // independent documents with disjoint prefixes, which is why this works
  // without merging them. Route lookup inside the validator is unaffected by
  // the mount because express-openapi-validator matches on the unstripped
  // req.originalUrl (its useRequestUrl option defaults to false).
  // Paths a spec does not document are still ignored rather than rejected, so
  // an undocumented route reaches express routing; responses stay
  // schema-checked in the test suite instead of per-request.
  // Splice/CN integer-width format hints that the schemas' type: integer
  // already covers, so we register them permissively only to keep ajv quiet.
  const customFormats = {
    int8: { type: 'number' as const, validate: () => true },
    int32: { type: 'number' as const, validate: () => true },
  }
  for (const spec of Object.values(specFiles)) {
    app.use(
      spec.basePath,
      OpenApiValidator.middleware({
        apiSpec: path.join(openapiDir, spec.file),
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
        await deps.ledger.ledgerEnd()
      } catch (err) {
        // Surface why readiness is failing: the 503 is returned to the
        // orchestrator, but without this the ledger outage behind it is
        // invisible in the service logs, unlike every other failure path.
        logger.error({ err }, 'readiness probe failed')
        return res.status(503).json({ status: 'unavailable' })
      }
      res.json({ status: 'ready' })
    }),
  )

  app.use(metadataRouter(deps))
  app.use(transferRouter(deps))
  app.use(allocationRouter(deps))

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
