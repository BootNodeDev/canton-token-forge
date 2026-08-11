import { describe, expect, it } from 'vitest'
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
