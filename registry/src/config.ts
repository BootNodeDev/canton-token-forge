export interface Config {
  ledgerApiUrl: string
  ledgerApiToken: string
  // Read by the submission path only, which no route reaches; see the note on
  // LedgerClient.submitAndWait for why that path is kept. Optional on purpose:
  // see the userId note on the implementation.
  ledgerUserId?: string
  adminParty: string
  instrumentConfigTemplateId: string
  transferInstructionTemplateId: string
  preapprovalTemplateId: string
  lockedTokenTemplateId: string
  allocationTemplateId: string
  port: number
  shutdownTimeoutMs: number
  directTransferMarginMs: number
}

const DEFAULT_PORT = 8080
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000
// Node's setTimeout clamps any delay above 2^31-1 back to 1ms, which would turn
// a long grace window into an immediate force-close, so we reject those values.
const MAX_SHUTDOWN_TIMEOUT_MS = 2_147_483_647

// The sender submits a direct transfer some time after the transfer-factory
// response, and TokenTransferPreapproval_Send re-checks the preapproval window
// against ledger time at that later moment. Recommending "direct" against a
// preapproval that is about to expire risks the choice aborting on-ledger, with
// no offer fallback on that path. This margin covers the client round trip,
// submission and sequencing latency, and tolerated clock skew between the
// registry host and the synchronizer; a preapproval expiring within it falls
// through to "offer" instead, which always succeeds. Zero disables it.
const DEFAULT_DIRECT_TRANSFER_MARGIN_MS = 30_000
// A margin longer than a realistic preapproval window would answer "offer" for
// every transfer, so a value that large is more likely a units mistake than an
// intent; rejecting it at boot beats silently disabling the direct path.
const MAX_DIRECT_TRANSFER_MARGIN_MS = 3_600_000

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const require_ = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing required env var ${k}`)
    return v
  }
  // The participant resolves a template id by package NAME, written
  // `#<package-name>:<module>:<entity>`, and rejects a package-id-qualified
  // identifier with "expected a package name". Checking the form at boot turns
  // what would otherwise be an empty result set on every query into a startup
  // error naming the variable at fault.
  const requireTemplateId = (k: string): string => {
    const v = require_(k)
    if (!/^#[^:]+:[^:]+:[^:]+$/.test(v)) {
      throw new Error(
        `invalid ${k}: expected the package-name form #<package-name>:<module>:<entity>, got "${v}"`,
      )
    }
    return v
  }
  const parsePort = (raw: string | undefined): number => {
    if (!raw) return DEFAULT_PORT
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid PORT: ${raw}`)
    }
    return n
  }
  const parseTimeoutMs = (raw: string | undefined): number => {
    if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_SHUTDOWN_TIMEOUT_MS) {
      throw new Error(`invalid SHUTDOWN_TIMEOUT_MS: ${raw}`)
    }
    return n
  }
  const parseMarginMs = (raw: string | undefined): number => {
    if (!raw) return DEFAULT_DIRECT_TRANSFER_MARGIN_MS
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > MAX_DIRECT_TRANSFER_MARGIN_MS) {
      throw new Error(`invalid DIRECT_TRANSFER_MARGIN_MS: ${raw}`)
    }
    return n
  }
  return {
    ledgerApiUrl: require_('LEDGER_API_URL'),
    ledgerApiToken: require_('LEDGER_API_TOKEN'),
    ...(env.LEDGER_USER_ID ? { ledgerUserId: env.LEDGER_USER_ID } : {}),
    adminParty: require_('ADMIN_PARTY'),
    instrumentConfigTemplateId: requireTemplateId('INSTRUMENT_CONFIG_TEMPLATE_ID'),
    transferInstructionTemplateId: requireTemplateId('TRANSFER_INSTRUCTION_TEMPLATE_ID'),
    preapprovalTemplateId: requireTemplateId('PREAPPROVAL_TEMPLATE_ID'),
    lockedTokenTemplateId: requireTemplateId('LOCKED_TOKEN_TEMPLATE_ID'),
    allocationTemplateId: requireTemplateId('ALLOCATION_TEMPLATE_ID'),
    port: parsePort(env.PORT),
    shutdownTimeoutMs: parseTimeoutMs(env.SHUTDOWN_TIMEOUT_MS),
    directTransferMarginMs: parseMarginMs(env.DIRECT_TRANSFER_MARGIN_MS),
  }
}
