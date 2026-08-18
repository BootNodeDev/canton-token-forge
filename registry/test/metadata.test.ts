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

// Ids are zero-padded so their lexicographic order matches their numeric one,
// which lets a test name the instrument it expects at a page boundary.
function manyInstruments(count: number): InstrumentConfigPayload[] {
  return Array.from({ length: count }, (_, i) => ({
    ...cantonCoin,
    instrumentId: `INS-${String(i).padStart(3, '0')}`,
    symbol: `S${i}`,
  }))
}

function idsOf(body: { instruments: Instrument[] }): string[] {
  return body.instruments.map((i) => i.id)
}

describe('metadata pagination', () => {
  it('caps an unpaged request at the page size the spec defaults to', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(30)), config })
    const res = await request(app).get('/registry/metadata/v1/instruments')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    expect(res.body.instruments).toHaveLength(25)
    expect(idsOf(res.body)[0]).toBe('INS-000')
    expect(res.body.nextPageToken).toBe('INS-024')
  })

  it('returns a single instrument and a continuation token for pageSize=1', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(3)), config })
    const res = await request(app).get('/registry/metadata/v1/instruments?pageSize=1')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    expect(idsOf(res.body)).toEqual(['INS-000'])
    expect(res.body.nextPageToken).toBe('INS-000')
  })

  it('resumes after the instrument the page token names', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(4)), config })
    const res = await request(app)
      .get('/registry/metadata/v1/instruments')
      .query({ pageSize: 2, pageToken: 'INS-001' })
    expect(res.status).toBe(200)
    expect(idsOf(res.body)).toEqual(['INS-002', 'INS-003'])
  })

  it('omits nextPageToken once the last instrument has been served', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(3)), config })
    const first = await request(app).get('/registry/metadata/v1/instruments?pageSize=2')
    expect(first.status).toBe(200)
    expect(first.body.nextPageToken).toBe('INS-001')
    const last = await request(app)
      .get('/registry/metadata/v1/instruments')
      .query({ pageSize: 2, pageToken: first.body.nextPageToken })
    expect(last.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', last.body)
    expect(idsOf(last.body)).toEqual(['INS-002'])
    expect(last.body.nextPageToken).toBeUndefined()
  })

  it('walks every instrument exactly once across pages', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(7)), config })
    const pages: string[][] = []
    let token: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await request(app)
        .get('/registry/metadata/v1/instruments')
        .query(token === undefined ? { pageSize: 2 } : { pageSize: 2, pageToken: token })
      expect(res.status).toBe(200)
      pages.push(idsOf(res.body))
      token = res.body.nextPageToken
      if (token === undefined) break
    }
    expect(token).toBeUndefined()
    // Four pages of at most two: a handler that ignores pageSize walks the
    // whole set in one page and still satisfies the union assertion below.
    expect(pages.map((p) => p.length)).toEqual([2, 2, 2, 1])
    expect(pages.flat()).toEqual(manyInstruments(7).map((p) => p.instrumentId))
  })

  it('pages in instrument id order regardless of the order the ledger returns rows in', async () => {
    const shuffled = [...manyInstruments(4)].reverse()
    const app = createServer({ ledger: ledgerWith(shuffled), config })
    const res = await request(app).get('/registry/metadata/v1/instruments?pageSize=2')
    expect(res.status).toBe(200)
    expect(idsOf(res.body)).toEqual(['INS-000', 'INS-001'])
    expect(res.body.nextPageToken).toBe('INS-001')
  })

  it('collapses duplicate rows before they consume a page slot', async () => {
    const [first, second, third] = manyInstruments(3)
    const duplicate = { ...first, name: 'Canton Coin (second create)' }
    const app = createServer({ ledger: ledgerWith([first, duplicate, second, third]), config })
    const res = await request(app).get('/registry/metadata/v1/instruments?pageSize=2')
    expect(res.status).toBe(200)
    // A page filled from raw rows would spend a slot on the duplicate and stop
    // at INS-001 having served INS-000 twice.
    expect(idsOf(res.body)).toEqual(['INS-000', 'INS-001'])
    expect(res.body.nextPageToken).toBe('INS-001')
  })

  it('falls back to the default page size when pageSize is below one', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(30)), config })
    for (const pageSize of [0, -1]) {
      const res = await request(app).get(`/registry/metadata/v1/instruments?pageSize=${pageSize}`)
      expect(res.status).toBe(200)
      expect(res.body.instruments).toHaveLength(25)
      expect(res.body.nextPageToken).toBe('INS-024')
    }
  })

  it('caps the page at 100 instruments however many the client asks for', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(120)), config })
    const res = await request(app).get('/registry/metadata/v1/instruments?pageSize=1000')
    expect(res.status).toBe(200)
    validateAgainst('metadata#/components/schemas/ListInstrumentsResponse', res.body)
    expect(res.body.instruments).toHaveLength(100)
    expect(res.body.nextPageToken).toBe('INS-099')
  })

  it('serves the instruments after an unknown page token rather than failing', async () => {
    const app = createServer({ ledger: ledgerWith(manyInstruments(3)), config })
    const res = await request(app)
      .get('/registry/metadata/v1/instruments')
      .query({ pageToken: 'INS-000-GONE' })
    expect(res.status).toBe(200)
    expect(idsOf(res.body)).toEqual(['INS-001', 'INS-002'])
  })
})
