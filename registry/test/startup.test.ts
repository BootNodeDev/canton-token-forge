import { describe, expect, it } from 'vitest'
import { type LedgerClient, LedgerRequestError } from '../src/ledger'
import { checkAdminParty } from '../src/startup'
import {
  cfgEntry,
  config,
  ledgerFrom,
  recordingLedgerFrom,
  recordingLogger,
} from './helpers/fixtures'

const seeded = { [config.instrumentConfigTemplateId]: [cfgEntry()] }

function ledgerWith(overrides: Partial<LedgerClient>): LedgerClient {
  return { ...ledgerFrom(seeded), ...overrides }
}

describe('checkAdminParty', () => {
  it('passes a party the participant hosts, whose configs the token can read', async () => {
    const { logger, warnings, errors } = recordingLogger()

    expect(await checkAdminParty(ledgerFrom(seeded), config, logger)).toBe(true)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it('accepts a registry with no instruments yet', async () => {
    const { logger, warnings, errors } = recordingLogger()

    // The empty case is the one an operator sees on every clean deploy, so it
    // must not be reported as a fault: it is indistinguishable from a wrong
    // party by this read alone, which is what the party lookup is there for.
    expect(await checkAdminParty(ledgerFrom({}), config, logger)).toBe(true)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it('refuses to start when the participant does not know the party', async () => {
    const { logger, errors } = recordingLogger()
    const ledger = { ...ledgerFrom({}), partyDetails: () => Promise.resolve([]) }

    expect(await checkAdminParty(ledger, config, logger)).toBe(false)
    expect(errors.join(' ')).toContain('ADMIN_PARTY')
  })

  it('starts with a warning when the lookup lists nothing but the party owns configs', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // A party lookup is scoped to the caller's identity provider, so a service
    // token issued under a non-default one can get an empty answer for a party
    // the participant genuinely hosts. Owning instrument configs settles it:
    // a party that does not exist owns nothing.
    const ledger = ledgerWith({ partyDetails: () => Promise.resolve([]) })

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    expect(warnings.join(' ')).toContain('ADMIN_PARTY')
    expect(errors).toEqual([])
  })

  it('starts with a warning when the participant knows the party but does not host it', async () => {
    const { logger, warnings, errors } = recordingLogger()
    const ledger = ledgerWith({
      partyDetails: (party: string) => Promise.resolve([{ party, isLocal: false }]),
    })

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    expect(warnings.join(' ')).toContain('ADMIN_PARTY')
    expect(errors).toEqual([])
  })

  it('starts with a warning when the participant refuses the party lookup', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // Party management may be an admin-only surface, so a service token being
    // refused here says nothing about the party. Failing the boot on it would
    // refuse to start a correctly configured registry.
    const ledger = ledgerWith({
      partyDetails: () => Promise.reject(new LedgerRequestError(403, 'party lookup failed: 403')),
    })

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    expect(warnings.join(' ')).toContain('ADMIN_PARTY')
    expect(errors).toEqual([])
  })

  it('starts with a warning when the party lookup cannot reach the participant', async () => {
    const { logger, warnings, errors } = recordingLogger()
    const ledger = ledgerWith({
      partyDetails: () => Promise.reject(new Error('fetch failed')),
    })

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(errors).toEqual([])
  })

  it('refuses to start when the token may not read as the party', async () => {
    const { logger, errors } = recordingLogger()
    const ledger = ledgerWith({
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(403, 'ledger query failed: 403')),
    })

    expect(await checkAdminParty(ledger, config, logger)).toBe(false)
    expect(errors.join(' ')).toContain('LEDGER_API_TOKEN')
    expect(errors.join(' ')).toContain('ADMIN_PARTY')
  })

  it('starts with a warning when the read fails for a reason other than authorization', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // A participant that is down is what /readyz already reports, and failing
    // the boot on it turns a participant restart into a registry crashloop.
    const ledger = ledgerWith({
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(503, 'ledger query failed: 503')),
    })

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(errors).toEqual([])
  })

  it('probes the configured admin party against the InstrumentConfig template', async () => {
    const { logger } = recordingLogger()
    const { ledger, queries } = recordingLedgerFrom(seeded)

    expect(await checkAdminParty(ledger, config, logger)).toBe(true)
    // A check that read as some other party, or off another template, would
    // prove nothing about the reads every route actually issues.
    expect(queries).toEqual([[config.instrumentConfigTemplateId, config.adminParty]])
  })
})

describe('checkAdminParty timeout', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('starts with a warning rather than hanging the boot on a participant that never answers', async () => {
    const { logger, warnings, errors } = recordingLogger()
    const ledger = ledgerWith({ partyDetails: () => new Promise(() => {}) })

    expect(await checkAdminParty(ledger, config, logger, 5)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(errors).toEqual([])
  })

  it('does not report a timeout on a check that answered in time', async () => {
    const { logger, warnings, errors } = recordingLogger()

    expect(await checkAdminParty(ledgerFrom(seeded), config, logger, 5)).toBe(true)
    // The losing side of a race keeps running, so an uncancelled timer fires
    // on every healthy boot and sends operators after a timeout that never
    // happened.
    await sleep(20)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it('reports a verdict that arrives after the timeout as a warning, not a fatal error', async () => {
    const { logger, warnings, errors } = recordingLogger()
    const ledger = {
      ...ledgerFrom({}),
      partyDetails: async () => {
        await sleep(20)
        return []
      },
    }

    // The boot has already continued by the time this verdict lands, so
    // logging it at error level would describe a service that refused to
    // start while it is in fact serving traffic.
    expect(await checkAdminParty(ledger, config, logger, 5)).toBe(true)
    await sleep(40)
    expect(errors).toEqual([])
    expect(warnings.join(' ')).toContain('ADMIN_PARTY')
  })
})
