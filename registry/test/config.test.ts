import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const baseEnv: Record<string, string> = {
  LEDGER_API_URL: 'http://ledger',
  LEDGER_API_TOKEN: 't',
  OPERATOR_PARTY: 'op::1',
  REGISTRY_BASE_URL: 'http://r',
  INSTRUMENT_CONFIG_TEMPLATE_ID: 'pkg:M:InstrumentConfig',
  INSTRUMENT_CONFIG_PROPOSAL_TEMPLATE_ID: 'pkg:M:InstrumentConfigProposal',
  TOKEN_REGISTRY_TEMPLATE_ID: 'pkg:M:TokenRegistry',
  TRANSFER_INSTRUCTION_INTERFACE_ID: 'pkg:I:TransferInstruction',
  PREAPPROVAL_TEMPLATE_ID: 'pkg:M:TokenTransferPreapproval',
  LOCKED_TOKEN_TEMPLATE_ID: 'pkg:M:LockedToken',
  ALLOCATION_INTERFACE_ID: 'pkg:I:Allocation',
}

describe('loadConfig ledger user id', () => {
  it('reads LEDGER_USER_ID when it is set', () => {
    expect(loadConfig({ ...baseEnv, LEDGER_USER_ID: 'participant_admin' }).ledgerUserId).toBe(
      'participant_admin',
    )
  })

  it('leaves the ledger user id unset when LEDGER_USER_ID is absent', () => {
    expect(loadConfig({ ...baseEnv })).not.toHaveProperty('ledgerUserId')
  })

  it('leaves the ledger user id unset when LEDGER_USER_ID is an empty string', () => {
    expect(loadConfig({ ...baseEnv, LEDGER_USER_ID: '' })).not.toHaveProperty('ledgerUserId')
  })
})

describe('loadConfig port parsing', () => {
  it('defaults to 8080 when PORT is unset', () => {
    expect(loadConfig({ ...baseEnv }).port).toBe(8080)
  })

  it('defaults to 8080 when PORT is an empty string', () => {
    expect(loadConfig({ ...baseEnv, PORT: '' }).port).toBe(8080)
  })

  it('parses a valid numeric PORT', () => {
    expect(loadConfig({ ...baseEnv, PORT: '9000' }).port).toBe(9000)
  })

  it('throws on a non-numeric PORT instead of binding NaN', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrow(/invalid PORT/)
  })

  it('throws on an out-of-range PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/invalid PORT/)
  })
})

describe('loadConfig shutdown timeout parsing', () => {
  it('defaults to 8000 when SHUTDOWN_TIMEOUT_MS is unset', () => {
    expect(loadConfig({ ...baseEnv }).shutdownTimeoutMs).toBe(8000)
  })

  it('defaults to 8000 when SHUTDOWN_TIMEOUT_MS is an empty string', () => {
    expect(loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '' }).shutdownTimeoutMs).toBe(8000)
  })

  it('parses a valid SHUTDOWN_TIMEOUT_MS', () => {
    expect(loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '30000' }).shutdownTimeoutMs).toBe(30000)
  })

  it('throws on a non-numeric SHUTDOWN_TIMEOUT_MS', () => {
    expect(() => loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: 'abc' })).toThrow(
      /invalid SHUTDOWN_TIMEOUT_MS/,
    )
  })

  it('throws on a negative SHUTDOWN_TIMEOUT_MS', () => {
    expect(() => loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '-1' })).toThrow(
      /invalid SHUTDOWN_TIMEOUT_MS/,
    )
  })

  it('throws on a zero SHUTDOWN_TIMEOUT_MS (would fire the backstop immediately)', () => {
    expect(() => loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(
      /invalid SHUTDOWN_TIMEOUT_MS/,
    )
  })

  it('throws when SHUTDOWN_TIMEOUT_MS overflows the setTimeout range', () => {
    expect(() => loadConfig({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '2147483648' })).toThrow(
      /invalid SHUTDOWN_TIMEOUT_MS/,
    )
  })
})
