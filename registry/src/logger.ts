import { pino } from 'pino'

// The structural interface the service depends on, so tests can pass a
// recording logger without pulling in pino types.
export interface Logger {
  info(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

export function createLogger(): Logger {
  return pino()
}
