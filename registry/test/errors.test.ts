import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { type LedgerClient, LedgerRequestError } from '../src/ledger'
import { createServer } from '../src/server'
import { config, ledgerFrom, recordingLogger, rejectingLedger } from './helpers/fixtures'

describe('async route errors', () => {
  it('maps a rejected ledger call to a 500 with a JSON error body instead of hanging', async () => {
    const { logger } = recordingLogger()
    const app = createServer({ ledger: rejectingLedger, config, logger })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'ledger query failed: 503' })
  })

  it('preserves the 4xx status express.json() puts on a malformed body instead of reporting 500', async () => {
    const ledger = ledgerFrom({})
    const { logger, entries } = recordingLogger()
    const app = createServer({ ledger, config, logger })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .set('content-type', 'application/json')
      .send('{"choiceArguments":')
    expect(res.status).toBe(400)
    // The target endpoint is spec-validated, so the status alone does not
    // identify who rejected the request: with the body parser removed the
    // OpenAPI validator answers 400 too, on a missing body. The parser's own
    // message is what distinguishes the two.
    expect(res.body.error).toMatch(/Unexpected end of JSON input/)
    expect(entries).toHaveLength(0)
  })

  it('logs the 5xx from the terminal error middleware', async () => {
    const { logger, entries } = recordingLogger()
    const app = createServer({ ledger: rejectingLedger, config, logger })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(500)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      status: 500,
      method: 'GET',
      path: '/registry/metadata/v1/instruments',
    })
  })

  it('answers 500 for a ledger failure that carries a status from the participant', async () => {
    const { logger, entries } = recordingLogger()
    // A LedgerRequestError carries the participant's status so the boot check
    // can tell an authorization refusal from a fault. Were that status to
    // reach the client, an expired LEDGER_API_TOKEN would answer 403 to a
    // caller who sent a perfectly good request, and the outage would skip the
    // 5xx log line that is the only record operators get of it.
    const ledger: LedgerClient = {
      ...ledgerFrom({}),
      activeContracts: () =>
        Promise.reject(new LedgerRequestError(403, 'ledger query failed: 403')),
    }
    const app = createServer({ ledger, config, logger })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(500)
    expect(entries).toHaveLength(1)
  })
})
