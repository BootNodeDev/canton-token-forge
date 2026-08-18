import type { Config } from './config.js'
import { type LedgerClient, LedgerRequestError } from './ledger.js'
import type { Logger } from './logger.js'

const DEFAULT_CHECK_TIMEOUT_MS = 5_000

const TIMED_OUT = Symbol('admin party check timed out')

// The checks report through this rather than logging directly, so a verdict
// that only arrives after the boot gave up waiting can be reported for what it
// then is: a warning about a running service, not a refusal to start.
type Report = (level: 'info' | 'warn' | 'error', obj: object, msg: string) => void

// A participant that refuses a request on authorization grounds answers with
// one of these; anything else is a fault the service cannot attribute to its
// own configuration.
function isAuthorizationRefusal(err: unknown): err is LedgerRequestError {
  return err instanceof LedgerRequestError && (err.ledgerStatus === 401 || err.ledgerStatus === 403)
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
  let abandoned = false
  const report: Report = (level, obj, msg) => {
    if (!abandoned) return logger[level](obj, msg)
    // The service is already listening, so nothing here can still stop it.
    logger[level === 'error' ? 'warn' : level]({ ...obj, afterBootTimeout: true }, msg)
  }

  // A participant that drops packets rather than refusing them would otherwise
  // hold the boot open indefinitely, since fetch has no timeout of its own.
  // That is worse than the fault this check exists to catch: the service would
  // never listen at all, where today it listens and reports itself unready.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  try {
    const verdict = await Promise.race([runChecks(ledger, config, report), timedOut])
    if (verdict !== TIMED_OUT) return verdict
    abandoned = true
    logger.warn({ timeoutMs }, 'admin party check timed out; continuing')
    return true
  } finally {
    // Promise.race leaves the loser running: without this the timer fires on
    // every healthy boot and reports a timeout that never happened.
    clearTimeout(timer)
  }
}

async function runChecks(
  ledger: LedgerClient,
  config: Pick<Config, 'adminParty' | 'instrumentConfigTemplateId'>,
  report: Report,
): Promise<boolean> {
  // Undefined where the lookup could not answer at all, which is a different
  // thing from the participant answering that it knows no such party.
  let known: boolean | undefined
  try {
    const details = await ledger.partyDetails(config.adminParty)
    known = details.length > 0
    if (known && !details.some((d) => d.isLocal)) {
      report(
        'warn',
        { adminParty: config.adminParty },
        'ADMIN_PARTY names a party this participant knows but does not host; reads as it may return nothing',
      )
    }
  } catch (err) {
    report(
      'warn',
      { err, adminParty: config.adminParty },
      'could not verify ADMIN_PARTY against the participant',
    )
  }

  // The party exists, which does not yet mean the configured token may read as
  // it. This is the same query the instrument listing issues, so a refusal here
  // is a refusal of every route the service serves.
  let instruments: number | undefined
  try {
    instruments = (
      await ledger.activeContracts(config.instrumentConfigTemplateId, config.adminParty)
    ).length
  } catch (err) {
    if (isAuthorizationRefusal(err)) {
      report(
        'error',
        { err, adminParty: config.adminParty },
        'the configured LEDGER_API_TOKEN may not read as ADMIN_PARTY; every route would fail',
      )
      return false
    }
    report('warn', { err }, 'could not read as ADMIN_PARTY at startup; continuing')
  }

  if (known === false) {
    // A party lookup is scoped to the caller's identity provider, so an empty
    // answer is only evidence of a wrong party when the party owns nothing
    // either: contracts read as it prove it exists and is readable, whatever
    // the lookup was able to see. A typo'd party owns nothing, so the fault
    // this check exists for is still fatal.
    if (instruments) {
      report(
        'warn',
        { adminParty: config.adminParty, instruments },
        'the participant does not list ADMIN_PARTY, but reads as it return instrument configs; the party lookup is likely scoped to another identity provider',
      )
      return true
    }
    report(
      'error',
      { adminParty: config.adminParty },
      'ADMIN_PARTY names a party this participant does not know; every read would return nothing',
    )
    return false
  }

  if (instruments !== undefined) {
    report('info', { adminParty: config.adminParty, instruments }, 'admin party verified')
  }
  return true
}
