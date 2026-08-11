import { describe, expect, it } from 'vitest'
import { LEDGER_API_URL, probeSandbox } from './helpers/sandbox'

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
})
