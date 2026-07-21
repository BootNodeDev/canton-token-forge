import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { LedgerClient } from '../src/ledger'
import { createServer } from '../src/server'
import { config, ledgerFrom } from './helpers/fixtures'

describe('health', () => {
  it('GET /healthz returns 200 ok', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('GET /readyz returns 200 when the ledger responds', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ready' })
  })

  it('GET /readyz returns 503 when the ledger is unreachable', async () => {
    const ledger: LedgerClient = {
      activeContracts: () => Promise.reject(new Error('connect ECONNREFUSED')),
      submitAndWait: () => Promise.reject(new Error('connect ECONNREFUSED')),
    }
    const app = createServer({ ledger, config })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'unavailable' })
  })
})
