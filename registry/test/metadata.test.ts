import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { LedgerClient } from '../src/ledger'
import type { Instrument } from '../src/mapping'
import type { InstrumentConfigPayload } from '../src/payloads'
import { createServer } from '../src/server'
import { cfgEntry, config, ledgerFrom } from './helpers/fixtures'
import { validateAgainst } from './helpers/schema'

function ledgerWith(payloads: InstrumentConfigPayload[]): LedgerClient {
  return ledgerFrom({
    [config.instrumentConfigTemplateId]: payloads.map((p, i) => {
      const entry = cfgEntry(p, [p.admin])
      entry.contractId = `c${i}`
      entry.createdEventBlob = 'b'
      return entry
    }),
  })
}

const cantonCoin: InstrumentConfigPayload = {
  admin: 'admin::1',
  instrumentId: 'CC',
  name: 'Canton Coin',
  symbol: 'CC',
  decimals: 10,
  faucet: null,
}

// instrumentId and symbol deliberately differ, so an assertion on one cannot be
// satisfied by the other. cantonCoin cannot serve that purpose: the standard's
// `id` and `symbol` happen to coincide there.
const goldBar: InstrumentConfigPayload = {
  admin: 'admin::1',
  instrumentId: 'GOLD-BAR',
  name: 'Gold Bar',
  symbol: 'GB',
  decimals: 2,
  faucet: null,
}

describe('metadata', () => {
  it('lists instruments', async () => {
    const ledger = ledgerWith([cantonCoin])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    expect(res.body.instruments[0]).toMatchObject({
      id: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
    })
    expect(res.body.instruments[0].supportedApis).toBeDefined()
  })

  it('collapses duplicate (admin, instrumentId) rows in the list', async () => {
    const duplicate = { ...cantonCoin, name: 'Canton Coin (second create)' }
    const ledger = ledgerWith([cantonCoin, duplicate])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    expect(res.body.instruments).toHaveLength(1)
    expect(res.body.instruments[0].id).toBe('CC')
  })

  it('returns registry info', async () => {
    const app = createServer({ ledger: ledgerWith([]), config })
    const res = await request(app).get('/registry/metadata/v1/info')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/GetRegistryInfoResponse', res.body)
    expect(res.body.adminId).toBe('admin::1')
    expect(res.body.supportedApis).toBeDefined()
  })

  it('gets an instrument by id when unique', async () => {
    const ledger = ledgerWith([cantonCoin])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments/CC')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/Instrument', res.body)
    expect(res.body).toMatchObject({
      id: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
    })
  })

  it('404s when no instrument matches the id', async () => {
    const ledger = ledgerWith([cantonCoin])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments/NOPE')
    expect(res.status).toBe(404)
    validateAgainst('metadata#/components/schemas/ErrorResponse', res.body)
    expect(res.body).toEqual({ error: 'instrument not found' })
  })

  it('409s when (admin, instrumentId) is not unique', async () => {
    const duplicate = { ...cantonCoin, name: 'Canton Coin (second create)' }
    const ledger = ledgerWith([cantonCoin, duplicate])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments/CC')
    expect(res.status).toBe(409)
    validateAgainst('metadata#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toBe('instrument id not unique')
    expect(res.body.contractIds).toEqual(['c0', 'c1'])
  })

  it('lists every instrument the admin has registered', async () => {
    const ledger = ledgerWith([cantonCoin, goldBar])
    const app = createServer({ ledger, config })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    // Keyed by id rather than by position, so each row's own name, symbol and
    // decimals have to travel with its id: a list that renders every row from
    // one payload cannot satisfy this.
    const byId = new Map((res.body.instruments as Instrument[]).map((i) => [i.id, i]))
    expect([...byId.keys()].sort()).toEqual(['CC', 'GOLD-BAR'])
    expect(byId.get('CC')).toMatchObject({ name: 'Canton Coin', symbol: 'CC', decimals: 10 })
    expect(byId.get('GOLD-BAR')).toMatchObject({ name: 'Gold Bar', symbol: 'GB', decimals: 2 })
  })

  it('resolves each of the admin instruments by its own id', async () => {
    const ledger = ledgerWith([cantonCoin, goldBar])
    const app = createServer({ ledger, config })
    const cc = await request(app).get('/registry/metadata/v1/instruments/CC')
    expect(cc.status).toBe(200)
    validateAgainst('metadata#/components/schemas/Instrument', cc.body)
    expect(cc.body).toMatchObject({ id: 'CC', symbol: 'CC', decimals: 10 })
    const gb = await request(app).get('/registry/metadata/v1/instruments/GOLD-BAR')
    expect(gb.status).toBe(200)
    validateAgainst('metadata#/components/schemas/Instrument', gb.body)
    expect(gb.body).toMatchObject({ id: 'GOLD-BAR', symbol: 'GB', decimals: 2 })
  })
})
