import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { config, ledgerFrom } from './helpers/fixtures'

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

  it('reflects whatever origin asks when corsOrigins is ["*"]', async () => {
    const app = createServer({ ledger: ledgerFrom({}), config: { ...config, corsOrigins: ['*'] } })
    const res = await request(app).get('/healthz').set('Origin', 'http://anything.example')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://anything.example')
  })
})
