import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { cfgEntry, config, ledgerFrom, recordingLogger } from './helpers/fixtures'

const ALLOWED_ORIGIN = config.corsOrigins[0]
const DISALLOWED_ORIGIN = 'http://not-allowed.example'

describe('cors', () => {
  it('reflects an allowed origin on a real GET, with Vary: Origin', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/healthz').set('Origin', ALLOWED_ORIGIN)
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers.vary).toBe('Origin')
  })

  // The service does not reject a disallowed origin: it answers the request
  // normally and simply omits the header that would let the browser hand the
  // body to the page. Asserting the status stays 200 is what tells the two
  // apart.
  it('answers a disallowed origin with 200 and no Access-Control-Allow-Origin', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app).get('/healthz').set('Origin', DISALLOWED_ORIGIN)
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  // A simple request is not preflighted, so nothing stops it: it is delivered,
  // routed, and served off the ledger like any other, and only the browser
  // withholds the body from the page. Counting the ledger read is what shows
  // the work was done, which /healthz above cannot: an operator cannot tell a
  // refused origin from an allowed one by watching the service.
  it('serves a disallowed origin in full, refusing it only in the browser', async () => {
    const base = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    let reads = 0
    const ledger = {
      ...base,
      activeContracts: (templateId: string, party: string) => {
        reads += 1
        return base.activeContracts(templateId, party)
      },
    }
    const res = await request(createServer({ ledger, config }))
      .get('/registry/metadata/v1/instruments')
      .set('Origin', DISALLOWED_ORIGIN)
    expect(res.status).toBe(200)
    expect(res.body.instruments).toHaveLength(1)
    expect(reads).toBe(1)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers a preflight from an allowed origin with 204 and no Allow header', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .options('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    // The exact list, not a substring: the four vendored specs declare only GET
    // and POST operations and express serves HEAD for every GET, so advertising
    // PUT, PATCH or DELETE would name methods no route answers. Asserting only
    // that POST is present cannot see that.
    expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,POST,OPTIONS')
    // express's default OPTIONS handler is what sets Allow; its absence is
    // what proves cors answered the preflight itself, ahead of routing.
    expect(res.headers.allow).toBeUndefined()
  })

  // Every factory route is a POST, so every factory call preflights, and a
  // browser caches a preflight carrying no max-age for a few seconds at most.
  // Without this the dApp pays two round trips for each call it makes.
  it('lets a browser cache the preflight', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .options('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(res.headers['access-control-max-age']).toBe('600')
  })

  // Left at the cors default, this echoes whatever the request asks for, which
  // advertises headers no handler reads. Nothing in src/ reads a request header
  // at all; the body parser and the validators need only the content type.
  it('advertises only the request header the service reads', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .options('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, authorization')
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type')
  })

  it('answers a preflight from a disallowed origin with 204 and no Access-Control-Allow-Origin', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .options('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', DISALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  // The important test: a browser can only show the validator's own rejection
  // message if that rejection is itself readable cross-origin, which is true
  // only while the CORS layer runs ahead of the OpenAPI validators.
  it('carries Access-Control-Allow-Origin on a request the OpenAPI validator rejects', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .get('/registry/metadata/v1/instruments?pageSize=abc')
      .set('Origin', ALLOWED_ORIGIN)
    expect(res.status).toBe(400)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
  })

  // Same argument, pinned against express.json() instead of the validators:
  // its malformed-body 400 is raised the same way, so it has to be reachable
  // cross-origin too.
  it('carries Access-Control-Allow-Origin on a malformed JSON body', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', ALLOWED_ORIGIN)
      .set('content-type', 'application/json')
      .send('{"choiceArguments":')
    expect(res.status).toBe(400)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
  })

  // cors terminates every OPTIONS, not only preflights and not only on paths
  // that route, so a path the service does not serve answers 204 here where
  // express used to 404. The GET is what still reports the path as missing,
  // and pinning both is what keeps the difference deliberate.
  it('answers OPTIONS on an unrouted path with 204, whose GET still 404s', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config })
    const preflight = await request(app).options('/no/such/path')
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-methods']).toBe('GET,HEAD,POST,OPTIONS')
    const get = await request(app).get('/no/such/path')
    expect(get.status).toBe(404)
  })

  // The one option whose value is its absence, on both origin modes. The
  // reference service this configuration was modelled on allows credentials
  // with the same reflected-origin line, and allowing them here would make any
  // page a credentialed reader of this service under a "*" entry, so the
  // omission is pinned rather than left to whoever edits those options next.
  it.each([
    [config.corsOrigins],
    [['*']],
  ])('allows no credentials with corsOrigins %j', async (corsOrigins) => {
    const app = createServer({ ledger: ledgerFrom({}), config: { ...config, corsOrigins } })
    const get = await request(app).get('/healthz').set('Origin', ALLOWED_ORIGIN)
    expect(get.status).toBe(200)
    expect(get.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(get.headers['access-control-allow-credentials']).toBeUndefined()
    const preflight = await request(app)
      .options('/registry/transfer-instruction/v1/transfer-factory')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined()
  })

  // The service side of a refused origin is documented as leaving nothing that
  // names it, and the only line any request writes is this one, on a 5xx. What
  // has to hold is therefore not that nothing is logged but that what is logged
  // identifies the request without identifying where it came from, which is the
  // difference between an operator who can find the request and one who could
  // tell an allowed caller from a refused one.
  it('logs a 5xx by method and path, naming no origin', async () => {
    const { logger, entries, errors } = recordingLogger()
    const base = ledgerFrom({})
    const ledger = {
      ...base,
      activeContracts: () => Promise.reject(new Error('ledger down')),
    }
    const res = await request(createServer({ ledger, config, logger }))
      .get('/registry/metadata/v1/instruments')
      .set('Origin', DISALLOWED_ORIGIN)
    expect(res.status).toBe(500)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(errors).toEqual(['request failed'])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      status: 500,
      method: 'GET',
      path: '/registry/metadata/v1/instruments',
    })
    expect(JSON.stringify(entries[0])).not.toContain(DISALLOWED_ORIGIN)
  })

  it('reflects whatever origin asks when corsOrigins is ["*"]', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config: { ...config, corsOrigins: ['*'] } })
    const res = await request(app).get('/healthz').set('Origin', 'http://anything.example')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://anything.example')
  })
})
