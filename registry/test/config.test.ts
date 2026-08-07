import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const baseEnv: Record<string, string> = {
  LEDGER_API_URL: 'http://ledger',
  LEDGER_API_TOKEN: 't',
  // Deliberately unlike every other value here, so a binding that reads the
  // wrong variable cannot pass by coincidence.
  ADMIN_PARTY: 'admin-party::1',
  REGISTRY_BASE_URL: 'http://r',
  INSTRUMENT_CONFIG_TEMPLATE_ID: '#pkg:M:InstrumentConfig',
  INSTRUMENT_CONFIG_PROPOSAL_TEMPLATE_ID: '#pkg:M:InstrumentConfigProposal',
  TOKEN_REGISTRY_TEMPLATE_ID: '#pkg:M:TokenRegistry',
  TRANSFER_INSTRUCTION_TEMPLATE_ID: '#pkg:M:TokenTransferInstruction',
  PREAPPROVAL_TEMPLATE_ID: '#pkg:M:TokenTransferPreapproval',
  LOCKED_TOKEN_TEMPLATE_ID: '#pkg:M:LockedToken',
  ALLOCATION_TEMPLATE_ID: '#pkg:M:TokenAllocation',
}

describe('loadConfig template ids', () => {
  it('reads the transfer instruction and allocation ids as template ids', () => {
    const config = loadConfig({ ...baseEnv })
    expect(config.transferInstructionTemplateId).toBe('#pkg:M:TokenTransferInstruction')
    expect(config.allocationTemplateId).toBe('#pkg:M:TokenAllocation')
  })

  it('throws when a template id is package-id qualified instead of package-name form', () => {
    expect(() =>
      loadConfig({ ...baseEnv, TOKEN_REGISTRY_TEMPLATE_ID: 'deadbeef:M:TokenRegistry' }),
    ).toThrow(/invalid TOKEN_REGISTRY_TEMPLATE_ID/)
  })

  it('throws when a template id is missing its module or entity', () => {
    expect(() => loadConfig({ ...baseEnv, LOCKED_TOKEN_TEMPLATE_ID: '#pkg:LockedToken' })).toThrow(
      /invalid LOCKED_TOKEN_TEMPLATE_ID/,
    )
  })
})

describe('loadConfig admin party', () => {
  it('reads ADMIN_PARTY as the party every ledger read runs under', () => {
    expect(loadConfig({ ...baseEnv }).adminParty).toBe('admin-party::1')
  })

  it('throws when ADMIN_PARTY is absent', () => {
    const { ADMIN_PARTY, ...withoutAdminParty } = baseEnv
    expect(() => loadConfig(withoutAdminParty)).toThrow(/missing required env var ADMIN_PARTY/)
  })
})

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
