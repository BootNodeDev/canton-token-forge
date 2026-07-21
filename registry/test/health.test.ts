import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { config, ledgerFrom } from './helpers/fixtures'

describe('health', () => {
  it('GET /healthz returns 200 ok', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
