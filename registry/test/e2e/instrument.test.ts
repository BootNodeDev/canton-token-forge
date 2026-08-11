import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { setupInstrument } from './helpers/fixture'
import { LEDGER_API_URL, probeSandbox } from './helpers/sandbox'

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
})
