import type { Config } from './config.js'
import { type LedgerClient, LedgerRequestError } from './ledger.js'
import type { Logger } from './logger.js'

const DEFAULT_CHECK_TIMEOUT_MS = 5_000

function timeOut(logger: Logger, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => {
      logger.warn({ timeoutMs }, 'admin party check timed out; continuing')
      resolve(true)
    }, timeoutMs).unref()
  })
}

// A participant that refuses a request on authorization grounds answers with
// one of these; anything else is a fault the service cannot attribute to its
// own configuration.
function isAuthorizationRefusal(err: unknown): err is LedgerRequestError {
  return err instanceof LedgerRequestError && (err.status === 401 || err.status === 403)
}

// Every route reads as `config.adminParty`, and a party the participant does
// not know reads as an empty active set rather than an error: a typo in
// ADMIN_PARTY therefore produces a registry that serves an empty instrument
// list and 404s every other route, with nothing anywhere naming the variable.
// This runs the two checks that can tell that apart from a correctly
// configured registry with no instruments yet, and returns false when the
// service must not start.
//
// Only a fault the service can attribute to its own configuration is fatal. A
// participant that is unreachable, or that refuses the party lookup because
// party management is an admin-only surface, leaves the question open, and
// refusing to boot on an open question would turn a participant restart into a
// crashloop and a service token into a false alarm. Those warn and continue;
// /readyz remains the signal for a ledger that is down.
export async function checkAdminParty(
  ledger: LedgerClient,
  config: Pick<Config, 'adminParty' | 'instrumentConfigTemplateId'>,
  logger: Logger,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  // A participant that drops packets rather than refusing them would otherwise
  // hold the boot open indefinitely, since fetch has no timeout of its own.
  // That is worse than the fault this check exists to catch: the service would
  // never listen at all, where today it listens and reports itself unready.
  return Promise.race([runChecks(ledger, config, logger), timeOut(logger, timeoutMs)])
}

async function runChecks(
  ledger: LedgerClient,
  config: Pick<Config, 'adminParty' | 'instrumentConfigTemplateId'>,
  logger: Logger,
): Promise<boolean> {
  try {
    const details = await ledger.partyDetails(config.adminParty)
    if (details.length === 0) {
      logger.error(
        { adminParty: config.adminParty },
        'ADMIN_PARTY names a party this participant does not know; every read would return nothing',
      )
      return false
    }
    if (!details.some((d) => d.isLocal)) {
      logger.warn(
        { adminParty: config.adminParty },
        'ADMIN_PARTY names a party this participant knows but does not host; reads as it may return nothing',
      )
    }
  } catch (err) {
    logger.warn(
      { err, adminParty: config.adminParty },
      'could not verify ADMIN_PARTY against the participant',
    )
  }

  // The party exists, which does not yet mean the configured token may read as
  // it. This is the same query the instrument listing issues, so a refusal here
  // is a refusal of every route the service serves.
  try {
    const configs = await ledger.activeContracts(
      config.instrumentConfigTemplateId,
      config.adminParty,
    )
    logger.info(
      { adminParty: config.adminParty, instruments: configs.length },
      'admin party verified',
    )
  } catch (err) {
    if (isAuthorizationRefusal(err)) {
      logger.error(
        { err, adminParty: config.adminParty },
        'the configured LEDGER_API_TOKEN may not read as ADMIN_PARTY; every route would fail',
      )
      return false
    }
    logger.warn({ err }, 'could not read as ADMIN_PARTY at startup; continuing')
  }
  return true
}
