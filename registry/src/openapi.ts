import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Absolute path to the vendored CN Token Standard OpenAPI specs, resolved from
// this module so it holds whether we run from src/ (tsx, vitest) or the
// compiled dist/.
export const openapiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi')

// The single authoritative list of the vendored standard specs the registry
// ships, keyed by a short id. The runtime request validators (server.ts) and
// the response-schema test harness both derive from this, so a spec added or
// renamed here reaches both. How each side treats the specs' int8/int32 format
// hints is left to the consumer: express-openapi-validator's ajv and the test
// harness's ajv-formats start from different baseline format knowledge.
//
// `basePath` is the prefix every path in that spec shares, which server.ts
// mounts the spec's validator on so a request meets only the validator that
// could describe it. It is recorded here rather than computed from the spec at
// boot to keep YAML parsing out of the service; `openapi.test.ts` asserts each
// one still covers every path its spec declares, so the vendored spec stays the
// arbiter and drift fails the suite.
export const specFiles = {
  metadata: { file: 'token-metadata-v1.yaml', basePath: '/registry/metadata/v1' },
  'transfer-instruction': {
    file: 'transfer-instruction-v1.yaml',
    basePath: '/registry/transfer-instruction/v1',
  },
  allocation: { file: 'allocation-v1.yaml', basePath: '/registry/allocations/v1' },
  'allocation-instruction': {
    file: 'allocation-instruction-v1.yaml',
    basePath: '/registry/allocation-instruction/v1',
  },
} as const
