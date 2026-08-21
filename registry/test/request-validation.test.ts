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
    const originForm = await sendRaw(port, 'POST', target)
    const absoluteForm = await sendRaw(port, 'POST', `${authority}${target}`)
    // The spec makes the body required, so the validator answers before the
    // route does; unvalidated, the handler's own guard answers 400 instead.
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
