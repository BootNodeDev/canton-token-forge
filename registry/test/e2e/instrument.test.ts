import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { holdingsOf, setupInstrument, tapFaucet } from './helpers/fixture'
import { allocateParty, LEDGER_API_URL, probeSandbox, uniqueSuffix } from './helpers/sandbox'

const live = await probeSandbox()
if (!live) console.warn(`no participant on ${LEDGER_API_URL}: skipping the end-to-end suite.`)

describe.skipIf(!live)('live instrument', () => {
  it('serves the freshly created instrument through the metadata route', async () => {
    const fx = await setupInstrument()

    const res = await request(fx.app).get('/registry/metadata/v1/instruments')

    expect(res.status).toBe(200)
    expect(res.body.instruments).toEqual([
      expect.objectContaining({ id: fx.instrumentId, symbol: 'E2E', decimals: 10 }),
    ])
  })

  it('taps the faucet into a holding the owner can read', async () => {
    const fx = await setupInstrument()
    const alice = await allocateParty(`e2e-alice-${uniqueSuffix()}`)

    const cid = await tapFaucet(fx, alice, '100.0')

    const holdings = await holdingsOf(fx, alice)
    expect(holdings.map((h) => h.contractId)).toEqual([cid])
    expect(Number(holdings[0].payload.amount)).toBe(100)
    expect(holdings[0].payload.owner).toBe(alice)
  })
})
