// Shared test fixtures for the registry route suites. The config is a full
// Config so suites cannot drift from the real shape; the entry builders and
// ledger stubs are the ones duplicated verbatim across the transfer,
// allocation, admin, and metadata suites.
import type { Config } from '../../src/config'
import type { DisclosedContract } from '../../src/disclose'
import type { ContractEntry, CreateCommand, ExerciseCommand, LedgerClient } from '../../src/ledger'
import type { Logger } from '../../src/logger'
import type {
  InstrumentConfigPayload,
  InstrumentIdValue,
  LockedTokenPayload,
} from '../../src/payloads'

export const config: Config = {
  ledgerApiUrl: 'http://ledger',
  ledgerApiToken: 'secret',
  operatorParty: 'op::1',
  registryBaseUrl: 'http://r',
  instrumentConfigTemplateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
  instrumentConfigProposalTemplateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfigProposal',
  tokenRegistryTemplateId: 'pkg:Canton.TokenForge.Registry:TokenRegistry',
  transferInstructionInterfaceId: 'pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction',
  preapprovalTemplateId: 'pkg:Canton.TokenForge.Registry:TokenTransferPreapproval',
  lockedTokenTemplateId: 'pkg:Canton.TokenForge.Registry:LockedToken',
  allocationInterfaceId: 'pkg:Splice.Api.Token.AllocationV1:Allocation',
  port: 0,
  shutdownTimeoutMs: 8_000,
}

export const instrumentId: InstrumentIdValue = { admin: 'admin::1', id: 'CC' }

export function cfgEntry(
  overrides: Partial<InstrumentConfigPayload> = {},
): ContractEntry<InstrumentConfigPayload> {
  return {
    templateId: config.instrumentConfigTemplateId,
    contractId: 'cfg1',
    createdEventBlob: 'BLOB-CFG',
    synchronizerId: 's',
    payload: {
      admin: instrumentId.admin,
      operator: 'op::1',
      instrumentId: instrumentId.id,
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
      faucet: null,
      ...overrides,
    },
  }
}

export function lockedTokenEntry(
  overrides: Partial<LockedTokenPayload> = {},
): ContractEntry<LockedTokenPayload> {
  return {
    templateId: config.lockedTokenTemplateId,
    contractId: 'locked1',
    createdEventBlob: 'BLOB-LOCK',
    synchronizerId: 's',
    payload: {
      admin: instrumentId.admin,
      ...overrides,
    },
  }
}

// A read-only ledger stub serving active contracts by template id. Routes
// driven by it never submit; a submission is therefore a test failure.
export function ledgerFrom(byTemplate: Record<string, ContractEntry[]>): LedgerClient {
  return {
    activeContracts: (templateOrInterfaceId: string) =>
      Promise.resolve(byTemplate[templateOrInterfaceId] ?? []),
    submitAndWait: () => Promise.reject(new Error('submitAndWait not expected in this test')),
  }
}

export interface RecordedCall {
  actAs: string[]
  commands: (CreateCommand | ExerciseCommand)[]
  disclosedContracts: DisclosedContract[]
}

// A ledger stub whose every call rejects, for exercising the failure paths:
// the terminal 5xx error handler and the readiness probe's unavailable branch.
export const rejectingLedger: LedgerClient = {
  activeContracts: () => Promise.reject(new Error('ledger query failed: 503')),
  submitAndWait: () => Promise.reject(new Error('ledger query failed: 503')),
}

// A logger that records the structured objects passed to error(), so a suite
// can assert what the service logged without depending on pino.
export function recordingLogger(): { logger: Logger; entries: object[] } {
  const entries: object[] = []
  const logger: Logger = {
    info: () => {},
    error: (obj: object | string) => {
      if (typeof obj === 'object') entries.push(obj)
    },
  }
  return { logger, entries }
}

// A ledger stub that also records submitAndWait calls for the admin suite,
// which asserts the actAs / commands / disclosedContracts it submits.
export function recordingLedger(byTemplate: Record<string, ContractEntry[]>): {
  ledger: LedgerClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const ledger: LedgerClient = {
    activeContracts: (templateOrInterfaceId: string) =>
      Promise.resolve(byTemplate[templateOrInterfaceId] ?? []),
    submitAndWait: (actAs, commands, disclosedContracts = []) => {
      calls.push({ actAs, commands, disclosedContracts })
      return Promise.resolve({ transactionId: 'tx-1' })
    },
  }
  return { ledger, calls }
}
