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
