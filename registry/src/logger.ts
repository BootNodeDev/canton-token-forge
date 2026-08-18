import { pino } from 'pino'

// The structural interface the service depends on, so tests can pass a
// recording logger without pulling in pino types.
export interface Logger {
  info(obj: object | string, msg?: string): void
  // Reserved for faults the service can keep running through: a startup check
  // that could not reach a verdict, as opposed to one that failed.
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

export function createLogger(): Logger {
  return pino()
}
