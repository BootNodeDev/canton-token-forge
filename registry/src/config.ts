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
  // A browser will not hand a cross-origin response to the page unless the
  // service names the requesting origin back in the response, so the origins
  // a dApp may call from have to be configured rather than inferred.
  corsOrigins: string[]
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

// The dApp dev server the CORS report was filed from, so the reported case
// works with no configuration. Any real deployment sets CORS_ORIGINS itself.
const DEFAULT_CORS_ORIGINS = 'http://localhost:3012'

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
  // A browser sends the origin it computed, so an entry the browser can never
  // send matches nothing and blocks the dApp with the same opaque failure this
  // list exists to prevent, from a service that started clean. URL normalizes
  // the near misses an operator writes by hand, a trailing slash, a host that
  // is not already lower case, a spelled-out default port, a path, so
  // comparing an entry against its own origin catches all of those. Two kinds
  // survive that comparison unchanged and are refused ahead of it instead: a
  // pattern, which parses as a host that happens to carry a "*", and a scheme
  // a browser never sends an Origin for.
  const parseOrigins = (raw: string | undefined): string[] => {
    const entries = (raw || DEFAULT_CORS_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
    if (entries.length === 0) {
      throw new Error(`invalid CORS_ORIGINS: names no origin, got "${raw}"`)
    }
    const notAnOrigin = (entry: string) =>
      new Error(
        `invalid CORS_ORIGINS entry "${entry}": expected an origin, http(s)://host[:port], or *`,
      )
    for (const entry of entries) {
      if (entry === '*') continue
      // The list is matched by exact string, so a pattern matches nothing at
      // all, and "*" meaning any origin is what invites one. URL parses
      // "https://*.example.com" happily and reports itself as its own origin,
      // so this is the only place it can be caught.
      if (entry.includes('*')) {
        throw new Error(
          `invalid CORS_ORIGINS entry "${entry}": no pattern is matched, list each origin, or "*" alone for any`,
        )
      }
      let url: URL
      try {
        url = new URL(entry)
      } catch {
        throw notAnOrigin(entry)
      }
      // Only these two schemes reach the service as an Origin, and confining
      // the entry to them is also what keeps the message honest: URL accepts
      // anything carrying a colon, so a scheme-less entry parses as a
      // non-special URL whose origin is the literal string "null", and naming
      // that back as the value to write would be a remedy the operator cannot
      // take, since "null" is itself refused as not a URL.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw notAnOrigin(entry)
      const normalized = url.origin
      if (normalized !== entry) {
        throw new Error(
          `invalid CORS_ORIGINS entry "${entry}": a browser would send "${normalized}", so write that instead`,
        )
      }
    }
    return entries
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
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
  }
}
