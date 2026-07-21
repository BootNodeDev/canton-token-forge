export interface Config {
  ledgerApiUrl: string
  ledgerApiToken: string
  operatorParty: string
  registryBaseUrl: string
  instrumentConfigTemplateId: string
  instrumentConfigProposalTemplateId: string
  tokenRegistryTemplateId: string
  transferInstructionInterfaceId: string
  preapprovalTemplateId: string
  lockedTokenTemplateId: string
  allocationInterfaceId: string
  port: number
  shutdownTimeoutMs: number
}

const DEFAULT_PORT = 8080
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const require_ = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing required env var ${k}`)
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
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid SHUTDOWN_TIMEOUT_MS: ${raw}`)
    }
    return n
  }
  return {
    ledgerApiUrl: require_('LEDGER_API_URL'),
    ledgerApiToken: require_('LEDGER_API_TOKEN'),
    operatorParty: require_('OPERATOR_PARTY'),
    registryBaseUrl: require_('REGISTRY_BASE_URL'),
    instrumentConfigTemplateId: require_('INSTRUMENT_CONFIG_TEMPLATE_ID'),
    instrumentConfigProposalTemplateId: require_('INSTRUMENT_CONFIG_PROPOSAL_TEMPLATE_ID'),
    tokenRegistryTemplateId: require_('TOKEN_REGISTRY_TEMPLATE_ID'),
    transferInstructionInterfaceId: require_('TRANSFER_INSTRUCTION_INTERFACE_ID'),
    preapprovalTemplateId: require_('PREAPPROVAL_TEMPLATE_ID'),
    lockedTokenTemplateId: require_('LOCKED_TOKEN_TEMPLATE_ID'),
    allocationInterfaceId: require_('ALLOCATION_INTERFACE_ID'),
    port: parsePort(env.PORT),
    shutdownTimeoutMs: parseTimeoutMs(env.SHUTDOWN_TIMEOUT_MS),
  }
}
