// Shared test fixtures for the registry suites. The config is a full Config so
// suites cannot drift from the real shape; the entry builders and ledger stubs
// live here rather than in any one suite because changing either affects every
// suite that imports them.
import type { Config } from '../../src/config'
import type { ContractEntry, LedgerClient } from '../../src/ledger'
import type { Logger } from '../../src/logger'
import type {
  AllocationPayload,
  InstrumentConfigPayload,
  InstrumentIdValue,
  LockedTokenPayload,
  PreapprovalPayload,
  TransferInstructionPayload,
} from '../../src/payloads'

export const config: Config = {
  ledgerApiUrl: 'http://ledger',
  ledgerApiToken: 'secret',
  adminParty: 'admin::1',
  registryBaseUrl: 'http://r',
  instrumentConfigTemplateId: '#canton-token-forge:Canton.TokenForge.Registry:InstrumentConfig',
  instrumentConfigProposalTemplateId:
    '#canton-token-forge:Canton.TokenForge.Registry:InstrumentConfigProposal',
  tokenRegistryTemplateId: '#canton-token-forge:Canton.TokenForge.Registry:TokenRegistry',
  transferInstructionTemplateId:
    '#canton-token-forge:Canton.TokenForge.Instruction:TokenTransferInstruction',
  preapprovalTemplateId: '#canton-token-forge:Canton.TokenForge.Registry:TokenTransferPreapproval',
  lockedTokenTemplateId: '#canton-token-forge:Canton.TokenForge.Locked:LockedToken',
  allocationTemplateId: '#canton-token-forge:Canton.TokenForge.Allocation:TokenAllocation',
  port: 0,
  shutdownTimeoutMs: 8_000,
}

export const instrumentId: InstrumentIdValue = { admin: 'admin::1', id: 'CC' }

// InstrumentConfig is signatory admin.
export function cfgEntry(
  overrides: Partial<InstrumentConfigPayload> = {},
  stakeholders: string[] = [instrumentId.admin],
): StubEntry<InstrumentConfigPayload> {
  return {
    templateId: config.instrumentConfigTemplateId,
    contractId: 'cfg1',
    createdEventBlob: 'BLOB-CFG',
    synchronizerId: 's',
    stakeholders,
    payload: {
      admin: instrumentId.admin,
      instrumentId: instrumentId.id,
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
      faucet: null,
      ...overrides,
    },
  }
}

// LockedToken is signatory admin, owner, holders. The escrow behind a transfer
// instruction is sender-owned with the admin as its sole holder.
export function lockedTokenEntry(
  overrides: Partial<LockedTokenPayload> = {},
  stakeholders: string[] = [instrumentId.admin, 'sender::1'],
): StubEntry<LockedTokenPayload> {
  return {
    templateId: config.lockedTokenTemplateId,
    contractId: 'locked1',
    createdEventBlob: 'BLOB-LOCK',
    synchronizerId: 's',
    stakeholders,
    payload: {
      admin: instrumentId.admin,
      ...overrides,
    },
  }
}

// The Daml stakeholder set of a contract. An active-contracts query against a
// participant returns a row only to a party that is a signatory or observer of
// it, so the stubs model that too: a route reading as a party outside this set
// sees an empty result exactly as it would on a live node.
export interface StubEntry<P = unknown> extends ContractEntry<P> {
  stakeholders: string[]
}

// A read-only ledger stub serving active contracts by template id, visible
// only to their stakeholders. Routes driven by it never submit; a submission
// is therefore a test failure.
export function ledgerFrom(byTemplate: Record<string, StubEntry[]>): LedgerClient {
  return {
    activeContracts: (templateId: string, party: string) =>
      Promise.resolve((byTemplate[templateId] ?? []).filter((e) => e.stakeholders.includes(party))),
    submitAndWait: () => Promise.reject(new Error('submitAndWait not expected in this test')),
  }
}

// ledgerFrom answers every query the same way, so a route that read as the
// wrong party or off the wrong template id is invisible to it. This wrapper
// records what was asked as well as answering it, which is the only way to
// pin the read party now that the configured admin and the instrument admin
// in the request body are necessarily the same value.
export function recordingLedgerFrom(byTemplate: Record<string, StubEntry[]>): {
  ledger: LedgerClient
  queries: [string, string][]
} {
  const queries: [string, string][] = []
  const inner = ledgerFrom(byTemplate)
  return {
    queries,
    ledger: {
      activeContracts: (templateId, party) => {
        queries.push([templateId, party])
        return inner.activeContracts(templateId, party)
      },
      submitAndWait: inner.submitAndWait,
    },
  }
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

// TokenTransferPreapproval is signatory admin, receiver.
export function preapprovalEntry(
  overrides: Partial<PreapprovalPayload> = {},
  stakeholders: string[] = [instrumentId.admin, 'receiver::1'],
): StubEntry<PreapprovalPayload> {
  return {
    templateId: config.preapprovalTemplateId,
    contractId: 'pre1',
    createdEventBlob: 'BLOB-PRE',
    synchronizerId: 's',
    stakeholders,
    payload: {
      admin: instrumentId.admin,
      instrumentId: instrumentId.id,
      receiver: 'receiver::1',
      validFrom: '2020-01-01T00:00:00Z',
      expiresAt: '2999-01-01T00:00:00Z',
      ...overrides,
    },
  }
}

// TokenTransferInstruction is signatory admin, transfer.sender; observer
// transfer.receiver.
export function instructionEntry(
  overrides: Partial<TransferInstructionPayload> = {},
  stakeholders: string[] = [instrumentId.admin, 'sender::1', 'receiver::1'],
): StubEntry<TransferInstructionPayload> {
  return {
    templateId: config.transferInstructionTemplateId,
    contractId: 'instr1',
    createdEventBlob: 'BLOB-INSTR',
    synchronizerId: 's',
    stakeholders,
    payload: {
      admin: instrumentId.admin,
      transfer: {
        sender: 'sender::1',
        receiver: 'receiver::1',
        instrumentId,
        amount: '10.0',
        meta: { values: {} },
      },
      lockedCid: 'locked1',
      ...overrides,
    },
  }
}

// TokenAllocation is signatory admin, sender; observer executor, receiver.
export function allocationEntry(
  overrides: Partial<AllocationPayload> = {},
  stakeholders: string[] = [instrumentId.admin, 'sender::1', 'executor::1', 'receiver::1'],
): StubEntry<AllocationPayload> {
  return {
    templateId: config.allocationTemplateId,
    contractId: 'alloc1',
    createdEventBlob: 'BLOB-ALLOC',
    synchronizerId: 's',
    stakeholders,
    payload: {
      admin: instrumentId.admin,
      allocation: {
        settlement: {
          executor: 'executor::1',
          settlementRef: { id: 'ref1', cid: null },
          requestedAt: '2020-01-01T00:00:00Z',
          allocateBefore: '2999-01-01T00:00:00Z',
          settleBefore: '2999-01-01T00:00:00Z',
        },
        transferLegId: 'leg1',
        transferLeg: { sender: 'sender::1', receiver: 'receiver::1', amount: '10.0', instrumentId },
      },
      lockedCid: 'locked1',
      meta: { values: {} },
      ...overrides,
    },
  }
}
