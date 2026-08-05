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

  it('leaves the undocumented health endpoints unvalidated by the specs', async () => {
    const ledger = ledgerFrom({})
    const app = createServer({ ledger, config })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
