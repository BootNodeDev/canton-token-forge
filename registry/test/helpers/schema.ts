import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const openapiDir = path.resolve(testDir, "../../openapi");

const ajv = new Ajv({ strict: false });
// ajv-formats is CJS-only, so under NodeNext moduleResolution the default
// import resolves to the module namespace rather than the plugin function;
// its .default property is the actual callable (same object at runtime).
addFormatsModule.default(ajv);
// The metadata spec annotates `decimals` with `format: int8`, which
// ajv-formats does not define. Register it as an always-valid format so the
// surrounding `type: integer` still governs and Ajv emits no "unknown format"
// warning.
ajv.addFormat("int8", true);

const specFiles: Record<string, string> = {
  metadata: "token-metadata-v1.yaml",
  "transfer-instruction": "transfer-instruction-v1.yaml",
  allocation: "allocation-v1.yaml",
  "allocation-instruction": "allocation-instruction-v1.yaml",
};

for (const [specId, fileName] of Object.entries(specFiles)) {
  const doc = loadYaml(readFileSync(path.join(openapiDir, fileName), "utf8"));
  ajv.addSchema(doc as object, specId);
}

/**
 * Validate a response body against a component schema identified by a JSON
 * pointer, e.g. validateAgainst("metadata#/components/schemas/Instrument", body).
 * Throws with the Ajv error list if the body does not satisfy the schema.
 */
export function validateAgainst(pointer: string, body: unknown): void {
  const validate = ajv.getSchema(pointer) as ValidateFunction | undefined;
  if (!validate) {
    throw new Error(`no schema registered for pointer ${pointer}`);
  }
  const valid = validate(body);
  if (!valid) {
    throw new Error(
      `schema validation failed for ${pointer}: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
}
