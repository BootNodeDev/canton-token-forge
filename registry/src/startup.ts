import type { Config } from './config.js'
import { type LedgerClient, LedgerRequestError } from './ledger.js'
import type { Logger } from './logger.js'

const DEFAULT_CHECK_TIMEOUT_MS = 5_000

const TIMED_OUT = Symbol('startup check timed out')

// The checks report through this rather than logging directly, so a verdict
// that only arrives after the boot gave up waiting can be reported for what it
// then is: a warning about a running service, not a refusal to start.
type Report = (level: 'info' | 'warn' | 'error', obj: object, msg: string) => void

// The environment variable each configured template id came from, which is the
// only thing that names the fault to whoever has to fix it: the participant
// reports the id, and the id appears in five variables that all look alike.
//
// Keyed on the template-id fields of Config rather than on a hand-written list,
// so a sixth id cannot be added to the configuration and silently go unchecked
// here; the Record makes that a type error rather than a gap.
type TemplateIdKey = Extract<keyof Config, `${string}TemplateId`>

const TEMPLATE_ID_ENV_VARS: Record<TemplateIdKey, string> = {
  instrumentConfigTemplateId: 'INSTRUMENT_CONFIG_TEMPLATE_ID',
  transferInstructionTemplateId: 'TRANSFER_INSTRUCTION_TEMPLATE_ID',
  preapprovalTemplateId: 'PREAPPROVAL_TEMPLATE_ID',
  lockedTokenTemplateId: 'LOCKED_TOKEN_TEMPLATE_ID',
  allocationTemplateId: 'ALLOCATION_TEMPLATE_ID',
}

// What the participant answers when it cannot resolve a template id: the first
// for a package name it does not host, the second for a module or entity it
// does not host within one it does. Both are attributable to our own
// configuration and to nothing else, which is what makes them fatal where every
// other failure of the same query is not.
const UNRESOLVABLE_TEMPLATE_CODES = [
  'PACKAGE_NAMES_NOT_FOUND',
  'NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME',
]

function namesAnUnresolvableTemplate(err: unknown): boolean {
  if (!(err instanceof LedgerRequestError) || err.detail === undefined) return false
  return UNRESOLVABLE_TEMPLATE_CODES.some((code) => err.detail?.includes(code))
}

// Bound a startup check's wall clock and give it a reporter that knows whether
// the boot is still waiting on it. A participant that drops packets rather than
// refusing them would otherwise hold the boot open indefinitely, since fetch has
// no timeout of its own. That is worse than the faults these checks exist to
// catch: the service would never listen at all, where today it listens and
// reports itself unready.
async function withBootTimeout(
  logger: Logger,
  timeoutMs: number,
  label: string,
  run: (report: Report) => Promise<boolean>,
): Promise<boolean> {
  let abandoned = false
  const report: Report = (level, obj, msg) => {
    if (!abandoned) return logger[level](obj, msg)
    // The service is already listening, so nothing here can still stop it.
    logger[level === 'error' ? 'warn' : level]({ ...obj, afterBootTimeout: true }, msg)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  try {
    const verdict = await Promise.race([run(report), timedOut])
    if (verdict !== TIMED_OUT) return verdict
    abandoned = true
    logger.warn({ timeoutMs }, `${label} timed out; continuing`)
    return true
  } finally {
    // Promise.race leaves the loser running: without this the timer fires on
    // every healthy boot and reports a timeout that never happened.
    clearTimeout(timer)
  }
}

// A configured template id the participant cannot resolve fails every read the
// service makes off it, but only at request time and only as a 500 whose sole
// clue is the participant's wording in a log line. Putting each id to the
// participant once at boot turns that into a refusal to start naming the
// variable at fault, which is what config.ts already does for an id whose form
// is wrong.
//
// This runs before the admin party check for two reasons. The query resolves a
// template id whether or not the party is one the participant knows, so it needs
// nothing that check establishes; and the admin check issues this same query for
// its own purposes, so an unresolvable id reaches it as a failure it reports
// against ADMIN_PARTY, naming the wrong variable entirely.
export async function checkTemplateIds(
  ledger: LedgerClient,
  config: Pick<Config, TemplateIdKey | 'adminParty'>,
  logger: Logger,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  return withBootTimeout(logger, timeoutMs, 'template id check', (report) =>
    runTemplateIdChecks(ledger, config, report),
  )
}

async function runTemplateIdChecks(
  ledger: LedgerClient,
  config: Pick<Config, TemplateIdKey | 'adminParty'>,
  report: Report,
): Promise<boolean> {
  const entries = Object.entries(TEMPLATE_ID_ENV_VARS) as [TemplateIdKey, string][]
  // Concurrently, so the queries overlap rather than serialize: each one reads
  // the ledger end before its own, so the check costs two sequential round
  // trips whatever the number of ids. Every id is put to the participant even
  // once one of them has already failed: a drifted environment file is rarely
  // wrong in a single place, and reporting the whole set makes fixing it one
  // restart instead of one per variable.
  const verdicts = await Promise.all(
    entries.map(async ([key, envVar]) => {
      const templateId = config[key]
      try {
        // The rows are irrelevant. A template the participant hosts but that
        // has no contracts yet answers 200 with an empty set, which is what
        // every clean deploy looks like, so only the failure carries meaning.
        await ledger.activeContracts(templateId, config.adminParty)
        return 'resolved' as const
      } catch (err) {
        if (namesAnUnresolvableTemplate(err)) {
          report(
            'error',
            { envVar, templateId },
            `${envVar} names a template this participant does not host; every read off it would fail`,
          )
          return 'unresolvable' as const
        }
        // Anything else leaves the question open: an unreachable participant,
        // or one refusing the read on authorization grounds, says nothing about
        // the id. The authorization case is a real fault, but it belongs to the
        // admin party check, which runs next and issues the same query.
        report(
          'warn',
          { err, envVar, templateId },
          `could not verify ${envVar} against the participant`,
        )
        return 'unanswered' as const
      }
    }),
  )

  const ok = !verdicts.includes('unresolvable')
  // Only the ids the participant actually resolved, so a boot that reached no
  // participant at all reports the warnings alone. Counting the ids put to it
  // instead would claim a verification that never happened, which is the one
  // thing worse than the silent misconfiguration this check exists to catch.
  const resolved = verdicts.filter((v) => v === 'resolved').length
  if (ok && resolved > 0) report('info', { count: resolved }, 'template ids verified')
  return ok
}

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
  return withBootTimeout(logger, timeoutMs, 'admin party check', (report) =>
    runChecks(ledger, config, report),
  )
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
