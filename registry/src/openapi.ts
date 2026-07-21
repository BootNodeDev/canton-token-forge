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
export const specFiles = {
  metadata: 'token-metadata-v1.yaml',
  'transfer-instruction': 'transfer-instruction-v1.yaml',
  allocation: 'allocation-v1.yaml',
  'allocation-instruction': 'allocation-instruction-v1.yaml',
} as const
