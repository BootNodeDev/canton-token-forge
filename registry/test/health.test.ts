import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { LedgerClient } from '../src/ledger'
import { createServer } from '../src/server'
import { config, ledgerFrom, recordingLogger, rejectingLedger } from './helpers/fixtures'

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

  // ledgerFrom answers [] for every template id and party, including one that
  // is undefined, so the 200-ready case above cannot tell what the probe asks
  // the ledger for. This pins it.
  it('GET /readyz probes the InstrumentConfig active set as the configured party', async () => {
    const queries: [string, string][] = []
    const ledger: LedgerClient = {
      activeContracts: (templateId, party) => {
        queries.push([templateId, party])
        return Promise.resolve([])
      },
      submitAndWait: () => Promise.reject(new Error('submitAndWait not expected in this test')),
    }
    const res = await request(createServer({ ledger, config })).get('/readyz')
    expect(res.status).toBe(200)
    expect(queries).toEqual([[config.instrumentConfigTemplateId, config.adminParty]])
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
