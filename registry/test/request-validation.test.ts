import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { cfgEntry, config, ledgerFrom } from './helpers/fixtures'
import { validateAgainst } from './helpers/schema'

describe('runtime request validation', () => {
  it('400s a transfer-factory request missing the spec-required choiceArguments', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({})
    expect(res.status).toBe(400)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toMatch(/choiceArguments/)
  })

  it('400s an allocation-factory request missing the spec-required choiceArguments', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocation-instruction/v1/allocation-factory')
      .send({})
    expect(res.status).toBe(400)
    validateAgainst('allocation-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toMatch(/choiceArguments/)
  })

  it('400s a non-integer pageSize on the metadata list endpoint', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments?pageSize=abc')
    expect(res.status).toBe(400)
  })

  it('accepts an undocumented query param on a documented endpoint', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments?_=cachebuster')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ instruments: [] })
  })

  it('lets a request on a path no spec documents through to express routing', async () => {
    const ledger = ledgerFrom({})
    const app = createServer({ ledger, config })
    const res = await request(app).post('/not-a-documented-path').send({ any: 'body' })
    // Express's own 404 page, not a JSON error body, is the evidence: it can
    // only be reached after all three validators have passed the request on.
    // Were any of them enforcing its spec here, the request would stop at that
    // validator with { error: 'not found' } instead.
    expect(res.status).toBe(404)
    expect(res.text).toMatch(/Cannot POST \/not-a-documented-path/)
  })
})
