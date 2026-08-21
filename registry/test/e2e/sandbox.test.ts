import { describe, expect, it } from 'vitest'
import { HttpLedgerClient, LedgerRequestError } from '../../src/ledger'
import { checkTemplateIds } from '../../src/startup'
import { recordingLogger } from '../helpers/fixtures'
import {
  allocateParty,
  LEDGER_API_URL,
  packageName,
  probeSandbox,
  templateIds,
  uniqueSuffix,
} from './helpers/sandbox'

const live = await probeSandbox()
if (!live) {
  console.warn(
    `no participant on ${LEDGER_API_URL}: skipping the end-to-end suite. ` +
      "Start one with 'bash scripts/sandbox.sh' from the repo root.",
  )
}

describe.skipIf(!live)('sandbox reachability', () => {
  it('serves the JSON Ledger API version endpoint', async () => {
    const res = await fetch(`${LEDGER_API_URL}/v2/version`)
    expect(res.ok).toBe(true)
  })

  it('allocates a party under the requested hint', async () => {
    const hint = `e2e-probe-${uniqueSuffix()}`
    const party = await allocateParty(hint)
    expect(party.startsWith(`${hint}::`)).toBe(true)
  })

  it('derives every template id in package-name form', () => {
    const ids = Object.values(templateIds())
    expect(ids).toHaveLength(6)
    for (const id of ids) {
      expect(id).toMatch(/^#[^:]+:[^:]+:[^:]+$/)
    }
    expect(templateIds().token).toContain(`#${packageName()}:`)
  })
})

// The boot check refuses to start on two error codes and treats every other
// failure as saying nothing about the configured ids. Both codes are fabricated
// by a stub in the unit suite, which cannot tell whether this participant names
// these faults that way on the endpoint the check actually calls: get it wrong
// and the check degrades to a permanent warning that protects nothing, with
// every unit test still green. These put both fault kinds, and a clean deploy,
// to a live participant through the client the boot check uses, and then put
// the check itself to it.
describe.skipIf(!live)('template id probe', () => {
  const ledger = new HttpLedgerClient({
    ledgerApiUrl: LEDGER_API_URL,
    ledgerApiToken: 'placeholder',
  })

  const refusalFor = async (templateId: string): Promise<LedgerRequestError> => {
    const party = await allocateParty(`e2e-probe-${uniqueSuffix()}`)
    const err = await ledger.probeTemplate(templateId, party).then(
      () => undefined,
      (e) => e,
    )
    if (!(err instanceof LedgerRequestError)) throw new Error(`expected a refusal, got ${err}`)
    return err
  }

  it('resolves a template this participant hosts, for a party holding none of it', async () => {
    // The premise the whole check rests on: a hosted template answers rather
    // than 404s when there is nothing to return, which is what every clean
    // deploy looks like and what a freshly allocated party sees.
    const party = await allocateParty(`e2e-probe-${uniqueSuffix()}`)

    await expect(ledger.probeTemplate(templateIds().lockedToken, party)).resolves.toBeUndefined()
  })

  it('refuses an id naming a package it does not host, and names it', async () => {
    const err = await refusalFor('#no-such-package:Canton.TokenForge.Locked:LockedToken')

    expect(err.ledgerStatus).toBe(404)
    expect(err.detail).toContain('PACKAGE_NAMES_NOT_FOUND')
  })

  it('refuses an id naming a template it does not host, and names it', async () => {
    const err = await refusalFor(`#${packageName()}:Canton.TokenForge.Locked:NoSuchTemplate`)

    expect(err.ledgerStatus).toBe(404)
    expect(err.detail).toContain('NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME')
  })

  it('passes a boot whose ids this participant hosts and fails one whose ids it does not', async () => {
    const ids = templateIds()
    const adminParty = await allocateParty(`e2e-probe-${uniqueSuffix()}`)
    const configured = {
      adminParty,
      instrumentConfigTemplateId: ids.instrumentConfig,
      transferInstructionTemplateId: ids.transferInstruction,
      preapprovalTemplateId: ids.preapproval,
      lockedTokenTemplateId: ids.lockedToken,
      allocationTemplateId: ids.allocation,
    }
    const { logger, errors } = recordingLogger()

    expect(await checkTemplateIds(ledger, configured, logger)).toBe(true)
    expect(errors).toEqual([])

    // Both fault kinds in one boot, which is what a drifted .env looks like:
    // this is the only case that ties the participant's own wording to the
    // verdict that stops the service starting.
    const drifted = {
      ...configured,
      lockedTokenTemplateId: '#no-such-package:Canton.TokenForge.Locked:LockedToken',
      allocationTemplateId: `#${packageName()}:Canton.TokenForge.Allocation:NoSuchTemplate`,
    }
    const { logger: driftedLogger, errors: driftedErrors } = recordingLogger()

    expect(await checkTemplateIds(ledger, drifted, driftedLogger)).toBe(false)
    expect(driftedErrors.join(' ')).toContain('LOCKED_TOKEN_TEMPLATE_ID')
    expect(driftedErrors.join(' ')).toContain('ALLOCATION_TEMPLATE_ID')
  })
})
