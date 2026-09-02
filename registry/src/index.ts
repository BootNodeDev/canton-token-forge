#!/usr/bin/env node
import 'dotenv/config'
import { type Config, loadConfig } from './config.js'
import { HttpLedgerClient } from './ledger.js'
import { createLogger } from './logger.js'
import { createServer } from './server.js'
import { checkAdminParty, checkTemplateIds } from './startup.js'

const logger = createLogger()

let config: Config
try {
  config = loadConfig(process.env)
} catch (err) {
  logger.error({ err }, 'invalid configuration')
  process.exit(1)
}

const ledger = new HttpLedgerClient(config, fetch, logger)
// Refuse to serve a configuration that can only answer empty lists, 404s and
// 500s. Only a fault attributable to the configuration stops the boot here; see
// each check for why an unreachable participant is left to /readyz instead.
// The template ids go first: their check needs nothing the admin party check
// establishes, while the admin party check reads off one of them and would
// report an unresolvable id against ADMIN_PARTY.
if (!(await checkTemplateIds(ledger, config, logger))) process.exit(1)
if (!(await checkAdminParty(ledger, config, logger))) process.exit(1)

const app = createServer({ ledger, config, logger })
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'canton-token-forge registry listening')
})

let shuttingDown = false
function shutdown(signal: string) {
  // A second signal mid-drain is a no-op: let the first drain finish.
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  // Stop accepting new connections; this callback fires once the open ones
  // close. Release idle keep-alive sockets right away so they do not hold
  // the callback open, which is what makes a bare server.close() hang until
  // the runtime escalates to SIGKILL.
  server.close(() => {
    logger.info('shutdown complete')
    process.exit(0)
  })
  server.closeIdleConnections()
  // Backstop: force the still-active sockets closed if in-flight requests
  // overrun the grace window, so we exit before the runtime sends SIGKILL.
  // Keep SHUTDOWN_TIMEOUT_MS below the runtime grace period (Docker 10s,
  // Kubernetes terminationGracePeriodSeconds 30s).
  setTimeout(() => {
    logger.error({ signal }, 'drain timeout exceeded, forcing shutdown')
    server.closeAllConnections()
  }, config.shutdownTimeoutMs).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
