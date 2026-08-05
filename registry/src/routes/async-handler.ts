import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Express 4 does not forward a rejected promise from an async handler to
// error-handling middleware, so an unhandled ledger error would otherwise
// leave the request hanging until the socket times out. Wrapping routes
// with this funnels any rejection into next(err), where the terminal error
// middleware in server.ts turns it into a clean 500.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
