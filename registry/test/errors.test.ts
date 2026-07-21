import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { LedgerClient } from '../src/ledger'
import { createServer } from '../src/server'
import { config, ledgerFrom } from './helpers/fixtures'

describe('async route errors', () => {
  it('maps a rejected ledger call to a 500 with a JSON error body instead of hanging', async () => {
    const ledger: LedgerClient = {
      activeContracts: () => Promise.reject(new Error('ledger query failed: 503')),
      submitAndWait: () => Promise.reject(new Error('ledger query failed: 503')),
    }
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'ledger query failed: 503' })
  })

  it('preserves the 4xx status express.json() puts on a malformed body instead of reporting 500', async () => {
    const ledger = ledgerFrom({})
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/admin/instruments')
      .set('content-type', 'application/json')
      .send('{"admin":')
    expect(res.status).toBe(400)
  })
})
