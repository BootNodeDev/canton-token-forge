import { readFileSync } from 'node:fs'
import path from 'node:path'
import express, { type Express } from 'express'
import * as OpenApiValidator from 'express-openapi-validator'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { openapiDir, specFiles } from '../src/openapi'
import { createServer } from '../src/server'
import { config, ledgerFrom } from './helpers/fixtures'

interface Layer {
  name: string
  regexp: RegExp
}

/**
 * Express 4 keeps the mounted middleware stack on `app._router`, which is the
 * only place the mount path of a middleware survives. Nothing about validator
 * mounting is observable through a request (a validator whose spec does not
 * describe the path passes it on silently), so the stack is what a test has to
 * read to tell one validation pass from four.
 */
function layers(app: Express): Layer[] {
  return (app as unknown as { _router: { stack: Layer[] } })._router.stack
}

/**
 * The layer names one `OpenApiValidator.middleware()` call contributes, learned
 * from a throwaway app rather than hardcoded, so a library upgrade that renames
 * or adds a layer is picked up instead of quietly shrinking what this file
 * inspects. `query` and `expressInit` are express's own, added when the router
 * is first created.
 */
function validatorLayerNames(): Set<string> {
  const probe = express()
  probe.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(openapiDir, specFiles.metadata.file),
      validateRequests: true,
      validateResponses: false,
      ignoreUndocumented: true,
    }),
  )
  const names = new Set(layers(probe).map((layer) => layer.name))
  names.delete('query')
  names.delete('expressInit')
  return names
}

/** The distinct mount points of the server's validator layers. */
function validatorMounts(app: Express): RegExp[] {
  const names = validatorLayerNames()
  const seen = new Map<string, RegExp>()
  for (const layer of layers(app)) {
    if (names.has(layer.name)) seen.set(String(layer.regexp), layer.regexp)
  }
  return [...seen.values()]
}

/** A spec path template as a request would spell it, e.g. `/x/{id}` -> `/x/id0`. */
function requestPathFor(declared: string): string {
  return declared.replace(/\{[^}]+\}/g, 'id0')
}

function declaredPaths(specFile: string): string[] {
  const doc = loadYaml(readFileSync(path.join(openapiDir, specFile), 'utf8')) as {
    paths: Record<string, unknown>
  }
  return Object.keys(doc.paths)
}

describe('vendored spec base paths', () => {
  // The base path in specFiles is what a validator gets mounted on, so a spec
  // declaring a path outside it would reach the router unvalidated. Checking it
  // against the vendored document keeps that document the arbiter.
  for (const [specId, spec] of Object.entries(specFiles)) {
    it(`covers every path the ${specId} spec declares`, () => {
      const paths = declaredPaths(spec.file)
      expect(paths.length).toBeGreaterThan(0)
      for (const declared of paths) {
        expect(declared.startsWith(`${spec.basePath}/`)).toBe(true)
      }
    })
  }

  it('gives every spec a distinct base path', () => {
    const basePaths = Object.values(specFiles).map((spec) => spec.basePath)
    expect(new Set(basePaths).size).toBe(basePaths.length)
  })
})

describe('request validator mounting', () => {
  const app = createServer({ ledger: ledgerFrom({}), config })

  it('mounts one validator per spec', () => {
    expect(validatorMounts(app)).toHaveLength(Object.keys(specFiles).length)
  })

  // The point of the change: a documented request is validated once, by the one
  // spec that describes it, rather than walking every mounted validator. The
  // second assertion is what makes the first non-vacuous: a single validator
  // mounted at the root would also match each path exactly once, and is caught
  // only by its matching the other specs' paths too.
  for (const [specId, spec] of Object.entries(specFiles)) {
    it(`sends a ${specId} request through exactly one validator, and no other spec's`, () => {
      const mounts = validatorMounts(app)
      const foreign = Object.entries(specFiles)
        .filter(([otherId]) => otherId !== specId)
        .flatMap(([, other]) => declaredPaths(other.file).map(requestPathFor))

      for (const declared of declaredPaths(spec.file)) {
        const requestPath = requestPathFor(declared)
        const matched = mounts.filter((mount) => mount.test(requestPath))
        expect(matched, `${requestPath} matched ${matched.length} validators`).toHaveLength(1)

        const leaked = foreign.filter((other) => matched[0].test(other))
        expect(leaked, `the validator for ${requestPath} also matched ${leaked}`).toHaveLength(0)
      }
    })
  }

  it('sends the health endpoints through no validator at all', () => {
    const mounts = validatorMounts(app)
    for (const requestPath of ['/healthz', '/readyz']) {
      const matched = mounts.filter((mount) => mount.test(requestPath))
      expect(matched, `${requestPath} matched ${matched.length} validators`).toHaveLength(0)
    }
  })
})
