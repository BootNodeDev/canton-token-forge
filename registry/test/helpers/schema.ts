import { readFileSync } from 'node:fs'
import path from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { load as loadYaml } from 'js-yaml'
import { openapiDir, specFiles } from '../../src/openapi'

const ajv = new Ajv({ strict: false })
addFormats(ajv)
// The specs annotate `decimals` with `format: int8`, which ajv-formats does
// not define (unlike int32, which it validates as a real range). Register it
// as an always-valid format so the surrounding `type: integer` still governs
// and Ajv emits no "unknown format" warning.
ajv.addFormat('int8', true)

for (const [specId, spec] of Object.entries(specFiles)) {
  const doc = loadYaml(readFileSync(path.join(openapiDir, spec.file), 'utf8'))
  ajv.addSchema(doc as object, specId)
}

/**
 * Validate a response body against a component schema identified by a JSON
 * pointer, e.g. validateAgainst("metadata#/components/schemas/Instrument", body).
 * Throws with the Ajv error list if the body does not satisfy the schema.
 */
export function validateAgainst(pointer: string, body: unknown): void {
  const validate = ajv.getSchema(pointer) as ValidateFunction | undefined
  if (!validate) {
    throw new Error(`no schema registered for pointer ${pointer}`)
  }
  const valid = validate(body)
  if (!valid) {
    throw new Error(
      `schema validation failed for ${pointer}: ${JSON.stringify(validate.errors, null, 2)}`,
    )
  }
}
