import { describe, expect, it } from 'vitest'
import { type LedgerClient, LedgerRequestError } from '../src/ledger'
import { checkAdminParty, checkTemplateIds } from '../src/startup'
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

// A participant that resolves every configured template id except the ones
// named here, which it refuses the way a real one does: a 404 whose body
// carries its own error code. Status alone cannot tell these apart from a
// participant having a bad day, which is why the detail is what the check
// reads.
function ledgerRefusing(refusals: Record<string, string>): LedgerClient {
  const inner = ledgerFrom(seeded)
  return {
    ...inner,
    activeContracts: (templateId: string, party: string) => {
      const code = refusals[templateId]
      if (!code) return inner.activeContracts(templateId, party)
      return Promise.reject(
        new LedgerRequestError(
          404,
          'ledger query failed: 404',
          `{"code":"${code}","cause":"...","correlationId":null}`,
        ),
      )
    },
  }
}

describe('checkTemplateIds', () => {
  it('passes a clean deploy, whose configured templates have no contracts yet', async () => {
    const { logger, warnings, errors } = recordingLogger()

    // The empty case is what every first deploy looks like, and the
    // participant answers it 200 with an empty set rather than a 404: a check
    // that treated "no contracts" as "no such template" would refuse to start
    // every new registry.
    expect(await checkTemplateIds(ledgerFrom({}), config, logger)).toBe(true)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it('passes a registry whose templates already carry contracts', async () => {
    const { logger, warnings, errors } = recordingLogger()

    expect(await checkTemplateIds(ledgerFrom(seeded), config, logger)).toBe(true)
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  it('refuses to start when an id names a package the participant does not host', async () => {
    const { logger, errors, entries } = recordingLogger()
    const ledger = ledgerRefusing({
      [config.lockedTokenTemplateId]: 'PACKAGE_NAMES_NOT_FOUND',
    })

    expect(await checkTemplateIds(ledger, config, logger)).toBe(false)
    // Naming the variable is the whole point: the fault is in the environment,
    // and the participant's own wording names neither the variable nor which
    // of the five carried the id.
    expect(errors.join(' ')).toContain('LOCKED_TOKEN_TEMPLATE_ID')
    // The value it was configured with rides in the structured object, where
    // every other diagnostic on this path puts it.
    expect(entries).toContainEqual(
      expect.objectContaining({
        envVar: 'LOCKED_TOKEN_TEMPLATE_ID',
        templateId: config.lockedTokenTemplateId,
      }),
    )
  })

  it('refuses to start when an id names a qualified name the participant does not host', async () => {
    const { logger, errors } = recordingLogger()
    const ledger = ledgerRefusing({
      [config.allocationTemplateId]: 'NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME',
    })

    expect(await checkTemplateIds(ledger, config, logger)).toBe(false)
    expect(errors.join(' ')).toContain('ALLOCATION_TEMPLATE_ID')
  })

  it('names every id at fault in one boot', async () => {
    const { logger, errors } = recordingLogger()
    // A drifted .env is rarely wrong in one place, and a check that stopped at
    // the first fault would make fixing it one restart per variable.
    const ledger = ledgerRefusing({
      [config.preapprovalTemplateId]: 'PACKAGE_NAMES_NOT_FOUND',
      [config.transferInstructionTemplateId]: 'NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME',
    })

    expect(await checkTemplateIds(ledger, config, logger)).toBe(false)
    const reported = errors.join(' ')
    expect(reported).toContain('PREAPPROVAL_TEMPLATE_ID')
    expect(reported).toContain('TRANSFER_INSTRUCTION_TEMPLATE_ID')
  })

  it('starts with a warning on a 404 the participant did not attribute to a template id', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // 404 is not by itself evidence about the configured id: a participant that
    // does not serve the endpoint answers one at the path level, and reading
    // the status alone would refuse to start over it.
    const ledger = ledgerRefusing({ [config.lockedTokenTemplateId]: 'SOMETHING_ELSE_ENTIRELY' })

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(errors).toEqual([])
  })

  it('starts with a warning when the query fails for a reason it cannot attribute', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // A participant that is down says nothing about the configured ids, and
    // refusing to boot on it turns a participant restart into a crashloop.
    const ledger = {
      ...ledgerFrom(seeded),
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(503, 'ledger query failed: 503')),
    }

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  it('starts with a warning when the participant refuses the query on authorization grounds', async () => {
    const { logger, warnings, errors } = recordingLogger()
    // A 403 is a fault, but not one attributable to a template id. The admin
    // party check issues the same query and is where that verdict belongs, so
    // reporting it fatally here would name the wrong variable.
    const ledger = {
      ...ledgerFrom(seeded),
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(403, 'ledger query failed: 403')),
    }

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  it('does not claim the ids were verified when the participant answered for none of them', async () => {
    const { logger, infos, errors } = recordingLogger()
    // Every query failed for a reason that says nothing about the ids, which
    // is no evidence of a fault and equally no evidence of a correct
    // configuration. Reporting it as verified tells an operator the ids were
    // put to a participant that in fact never answered.
    const ledger = {
      ...ledgerFrom(seeded),
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(503, 'ledger query failed: 503')),
    }

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    expect(infos).toEqual([])
    expect(errors).toEqual([])
  })

  it('counts only the ids the participant actually resolved', async () => {
    const { logger, infoEntries, infos, warnings } = recordingLogger()
    const inner = ledgerFrom(seeded)
    const ledger = {
      ...inner,
      activeContracts: (templateId: string, party: string) =>
        templateId === config.allocationTemplateId
          ? Promise.reject(new LedgerRequestError(503, 'ledger query failed: 503'))
          : inner.activeContracts(templateId, party),
    }

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    expect(warnings.length).toBe(1)
    // Four of the five answered, and the count is the evidence the check has
    // rather than the number of ids it set out to put to the participant.
    expect(infos.join(' ')).toContain('template ids verified')
    expect(infoEntries).toEqual([{ count: 4 }])
  })

  it('probes every configured template id as the admin party', async () => {
    const { logger } = recordingLogger()
    const { ledger, queries } = recordingLedgerFrom(seeded)

    expect(await checkTemplateIds(ledger, config, logger)).toBe(true)
    // An id the check never puts to the participant is an id it cannot
    // validate, so the read set is the assertion.
    expect(new Set(queries)).toEqual(
      new Set([
        [config.instrumentConfigTemplateId, config.adminParty],
        [config.transferInstructionTemplateId, config.adminParty],
        [config.preapprovalTemplateId, config.adminParty],
        [config.lockedTokenTemplateId, config.adminParty],
        [config.allocationTemplateId, config.adminParty],
      ]),
    )
  })
})

describe('checkTemplateIds timeout', () => {
  it('starts with a warning rather than hanging the boot on a participant that never answers', async () => {
    const { logger, warnings, errors } = recordingLogger()
    const ledger = { ...ledgerFrom(seeded), activeContracts: () => new Promise<never>(() => {}) }

    expect(await checkTemplateIds(ledger, config, logger, 5)).toBe(true)
    expect(warnings.length).toBe(1)
    expect(errors).toEqual([])
  })
})
