import 'dotenv/config'
import { type Config, loadConfig } from './config.js'
import { HttpLedgerClient } from './ledger.js'
import { createLogger } from './logger.js'
import { createServer } from './server.js'

const logger = createLogger()

let config: Config
try {
  config = loadConfig(process.env)
} catch (err) {
  logger.error({ err }, 'invalid configuration')
  process.exit(1)
}

const ledger = new HttpLedgerClient(config)
const app = createServer({ ledger, config, logger })
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'canton-token-forge registry listening')
})

process.on('SIGTERM', () => {
  logger.info('shutting down')
  server.close(() => process.exit(0))
})
