import type { Server } from 'node:http'
import net from 'node:net'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

interface RawResponse {
  status: number
  body: string
}

/**
 * A request written onto the socket by hand. Every HTTP client in the toolchain
 * (supertest included) emits the origin form of the request target, so the
 * absolute form these tests are about is only reachable this way.
 */
function sendRaw(
  port: number,
  method: string,
  target: string,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const headers = [`Host: 127.0.0.1:${port}`, 'Connection: close']
      if (body !== undefined) {
        headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`)
      }
      socket.write(`${method} ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body ?? ''}`)
    })
    let raw = ''
    socket.on('data', (chunk) => {
      raw += chunk.toString()
    })
    socket.on('error', reject)
    socket.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n')
      resolve({ status: Number(head.split(' ')[1]), body: rest.join('\r\n\r\n') })
    })
  })
}

describe('absolute-form request targets', () => {
  let server: Server
  let port: number
  let authority: string

  beforeAll(async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    server = createServer({ ledger, config }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    port = address.port
    authority = `http://127.0.0.1:${port}`
  })

  afterAll(() => {
    server.close()
  })

  // Each test asserts the origin form's own answer as well as the two forms
  // agreeing: two identically broken answers would satisfy the comparison
  // alone.
  it('validates a query parameter the absolute form carries', async () => {
    const target = '/registry/metadata/v1/instruments?pageSize=abc'
    const originForm = await sendRaw(port, 'GET', target)
    const absoluteForm = await sendRaw(port, 'GET', `${authority}${target}`)
    expect(originForm.status).toBe(400)
    expect(JSON.parse(originForm.body).error).toMatch(/pageSize must be integer/)
    expect(absoluteForm).toEqual(originForm)
  })

  it('validates a body the absolute form carries', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const originForm = await sendRaw(port, 'POST', target, '{}')
    const absoluteForm = await sendRaw(port, 'POST', `${authority}${target}`, '{}')
    // Both a validated and an unvalidated request answer 400 here, so the
    // status alone proves nothing: the message is what says which one answered.
    // The validator names the property the spec requires; the handler, reached
    // only when the request got past the validator unchecked, names its own
    // first missing field instead.
    expect(originForm.status).toBe(400)
    expect(JSON.parse(originForm.body).error).toMatch(
      /must have required property 'choiceArguments'/,
    )
    expect(absoluteForm).toEqual(originForm)
  })

  it('applies the media-type check to the absolute form too', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const originForm = await sendRaw(port, 'POST', target)
    const absoluteForm = await sendRaw(port, 'POST', `${authority}${target}`)
    // No body means no content type, which the validator refuses before it ever
    // reads a schema.
    expect(originForm.status).toBe(415)
    expect(absoluteForm).toEqual(originForm)
  })

  it('answers a valid absolute-form request exactly as it answers the origin form', async () => {
    const target = '/registry/metadata/v1/instruments?pageSize=2'
    const originForm = await sendRaw(port, 'GET', target)
    const absoluteForm = await sendRaw(port, 'GET', `${authority}${target}`)
    expect(originForm).toEqual({ status: 200, body: '{"instruments":[]}' })
    expect(absoluteForm).toEqual(originForm)
  })

  // The scheme separator is only a scheme separator ahead of the path, which is
  // the distinction express itself draws before stripping one.
  it('leaves an origin-form target whose own path contains :// alone', async () => {
    const res = await sendRaw(port, 'GET', '/registry/metadata/v1/instruments/a://b')
    expect(res.status).toBe(404)
    expect(res.body).toMatch(/Cannot GET \/registry\/metadata\/v1\/instruments\/a:\/\/b/)
  })

  it('still lets an absolute-form request on an undocumented path reach express routing', async () => {
    const originForm = await sendRaw(port, 'GET', '/not-a-documented-path')
    const absoluteForm = await sendRaw(port, 'GET', `${authority}/not-a-documented-path`)
    expect(originForm.status).toBe(404)
    expect(originForm.body).toMatch(/Cannot GET \/not-a-documented-path/)
    expect(absoluteForm).toEqual(originForm)
  })
})

// The response to a fragment-bearing request cannot show every way the cut can
// go wrong: a lookup mangled into a path no spec documents is passed on by
// ignoreUndocumented, and express keeps routing on req.url, so the request still
// answers exactly as it should while nothing validates it. These read the field
// the fix changes instead, on a path no route answers.
describe('the request target the validator matches', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    app.use((req, res) => {
      res.json({ originalUrl: req.originalUrl, url: req.url })
    })
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    port = address.port
  })

  afterAll(() => {
    server.close()
  })

  it('drops the fragment, leaving req.url as node delivered it', async () => {
    const res = await sendRaw(port, 'GET', '/undocumented#x?pageSize=abc')
    expect(JSON.parse(res.body)).toEqual({
      originalUrl: '/undocumented',
      url: '/undocumented#x?pageSize=abc',
    })
  })

  it('keeps a percent-encoded number sign, which delimits nothing', async () => {
    const res = await sendRaw(port, 'GET', '/undocumented/%23/x')
    expect(JSON.parse(res.body).originalUrl).toBe('/undocumented/%23/x')
  })
})

// An absolute-form target can carry a query with no path at all
// (`GET http://host?pageSize=abc`). Express routes that on "/", which no route
// and no validator mount matches, so both forms answer 404 and the mismatch is
// only visible on req.originalUrl itself: the field the request validator
// reads its query parameters out of. A handler appended after every router has
// declined the request is what makes it observable.
describe('an absolute-form target with no path', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    app.use((req, res) => {
      res.json({ originalUrl: req.originalUrl, query: req.query })
    })
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    port = address.port
  })

  afterAll(() => {
    server.close()
  })

  it('keeps its query on the field the request validator reads', async () => {
    const res = await sendRaw(port, 'GET', `http://127.0.0.1:${port}?pageSize=abc`)
    expect(JSON.parse(res.body)).toEqual({
      originalUrl: '/?pageSize=abc',
      query: { pageSize: 'abc' },
    })
  })

  // A fragment ahead of that query takes the query with it, leaving the
  // validator matching the bare path parseurl reports. Node's own parser
  // refuses a "#" that follows the authority directly (HPE_INVALID_URL), so
  // the shortest target that can carry this shape onto the wire is the one
  // below, whose path is a single "/".
  it('drops a query the fragment precedes, leaving the bare path', async () => {
    const res = await sendRaw(port, 'GET', `http://127.0.0.1:${port}/#x?pageSize=abc`)
    expect(JSON.parse(res.body)).toEqual({ originalUrl: '/', query: {} })
  })

  it('keeps a query the fragment follows, dropping only the fragment', async () => {
    const res = await sendRaw(port, 'GET', `http://127.0.0.1:${port}?pageSize=abc#x`)
    expect(JSON.parse(res.body)).toEqual({
      originalUrl: '/?pageSize=abc',
      query: { pageSize: 'abc' },
    })
  })

  it('reads a "/" inside that query as part of a value, not as a path', async () => {
    const target = `http://127.0.0.1:${port}?next=/registry/metadata/v1/instruments`
    const res = await sendRaw(port, 'GET', target)
    expect(JSON.parse(res.body).originalUrl).toBe('/?next=/registry/metadata/v1/instruments')
  })
})

// A fragment is not one of RFC 9112's request-target forms, but node hands one
// through to the application verbatim. Express drops it, along with anything
// behind it, before it routes; the request validator looks its route up on the
// unstripped req.originalUrl, where the fragment makes the request match no path
// in any spec and ignoreUndocumented then passes it on unvalidated.
describe('fragment-bearing request targets', () => {
  let server: Server
  let port: number
  let authority: string

  beforeAll(async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    server = createServer({ ledger, config }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    port = address.port
    authority = `http://127.0.0.1:${port}`
  })

  afterAll(() => {
    server.close()
  })

  it('validates a body the target carries behind a fragment', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const plain = await sendRaw(port, 'POST', target, '{}')
    const fragment = await sendRaw(port, 'POST', `${target}#x`, '{}')
    // Both answer 400, so the status alone proves nothing: the message is what
    // says which one answered. The validator names the property the spec
    // requires; the handler, reached only when the request got past the
    // validator unchecked, names its own first missing field instead.
    expect(plain.status).toBe(400)
    expect(JSON.parse(plain.body).error).toMatch(/must have required property 'choiceArguments'/)
    expect(fragment).toEqual(plain)
  })

  // The fragment starts at the FIRST "#", which is where parseurl ends the path
  // too, so a second one is fragment content rather than a second delimiter.
  it('cuts at the first number sign when the target carries two', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const plain = await sendRaw(port, 'POST', target, '{}')
    const fragment = await sendRaw(port, 'POST', `${target}#a#b`, '{}')
    expect(plain.status).toBe(400)
    expect(fragment).toEqual(plain)
  })

  it('applies the media-type check behind a fragment too', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const plain = await sendRaw(port, 'POST', target)
    const fragment = await sendRaw(port, 'POST', `${target}#x`)
    expect(plain.status).toBe(415)
    expect(fragment).toEqual(plain)
  })

  it('validates a body an absolute-form target carries behind a fragment', async () => {
    const target = '/registry/transfer-instruction/v1/transfer-factory'
    const plain = await sendRaw(port, 'POST', target, '{}')
    const fragment = await sendRaw(port, 'POST', `${authority}${target}#x`, '{}')
    expect(plain.status).toBe(400)
    expect(fragment).toEqual(plain)
  })

  // A fragment ahead of the query takes the query with it: parseurl reports no
  // query at all, so req.query is empty and the pageSize below never reaches the
  // server in any form. The answer that agrees with what express routed is
  // therefore the fragment-free path's own answer, not the 400 the same query
  // draws when it really is a query.
  it('answers a fragment-bearing GET exactly as it answers the fragment-free path', async () => {
    const target = '/registry/metadata/v1/instruments'
    const plain = await sendRaw(port, 'GET', target)
    const fragment = await sendRaw(port, 'GET', `${target}#x?pageSize=abc`)
    expect(plain.status).toBe(200)
    expect(JSON.parse(plain.body).instruments).toHaveLength(1)
    expect(fragment).toEqual(plain)
  })

  it('still validates a query the fragment follows rather than precedes', async () => {
    const res = await sendRaw(port, 'GET', '/registry/metadata/v1/instruments?pageSize=abc#x')
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/pageSize must be integer/)
  })

  // %23 is a percent-encoded number sign, not a fragment delimiter, so the cut
  // must not reach it. A cut that did would leave "/instruments/", which routes
  // to the list endpoint and answers 200 with every instrument.
  it('leaves a percent-encoded number sign in the path alone', async () => {
    const res = await sendRaw(port, 'GET', '/registry/metadata/v1/instruments/%23')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body).error).toBe('instrument not found')
  })

  it('still lets a fragment-bearing request on an undocumented path reach express routing', async () => {
    const plain = await sendRaw(port, 'GET', '/not-a-documented-path')
    const fragment = await sendRaw(port, 'GET', '/not-a-documented-path#x')
    expect(plain.status).toBe(404)
    expect(plain.body).toMatch(/Cannot GET \/not-a-documented-path/)
    expect(fragment).toEqual(plain)
  })
})
