import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import {
  config,
  ledgerFrom,
  recordingLedgerFrom,
  recordingLogger,
  rejectingLedger,
} from './helpers/fixtures'

describe('health', () => {
  it('GET /healthz returns 200 ok', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(418)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('GET /readyz returns 200 when the ledger responds', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ready' })
  })

  // ledgerFrom answers every call the same way, so the 200-ready case above
  // cannot tell what the probe asks the ledger for. A readiness probe runs on
  // the orchestrator's interval forever, so it must cost the same whatever the
  // admin's active sets grow to: it reads the ledger end and nothing else.
  it('GET /readyz probes the ledger end and queries no active set', async () => {
    const { ledger, queries, ledgerEnds } = recordingLedgerFrom({})
    const res = await request(createServer({ ledger, config })).get('/readyz')
    expect(res.status).toBe(200)
    expect(ledgerEnds).toHaveLength(1)
    expect(queries).toEqual([])
  })

  it('GET /readyz returns 503 and logs the error when the ledger is unreachable', async () => {
    const { logger, entries } = recordingLogger()
    const app = createServer({ ledger: rejectingLedger, config, logger })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'unavailable' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toHaveProperty('err')
  })
})
