import { describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../src/config'

const baseEnv: Record<string, string> = {
  LEDGER_API_URL: 'http://ledger',
  LEDGER_API_TOKEN: 't',
  // Deliberately unlike every other value here, so a binding that reads the
  // wrong variable cannot pass by coincidence.
  ADMIN_PARTY: 'admin-party::1',
  INSTRUMENT_CONFIG_TEMPLATE_ID: '#pkg:M:InstrumentConfig',
  TRANSFER_INSTRUCTION_TEMPLATE_ID: '#pkg:M:TokenTransferInstruction',
  PREAPPROVAL_TEMPLATE_ID: '#pkg:M:TokenTransferPreapproval',
  LOCKED_TOKEN_TEMPLATE_ID: '#pkg:M:LockedToken',
  ALLOCATION_TEMPLATE_ID: '#pkg:M:TokenAllocation',
}

// Every template id goes through the same helper, so covering only one of them
// lets the other four be bound with a plain require_ (or to each other's
// variable) without a single test failing.
const templateIdVars: ReadonlyArray<readonly [string, keyof Config]> = [
  ['INSTRUMENT_CONFIG_TEMPLATE_ID', 'instrumentConfigTemplateId'],
  ['TRANSFER_INSTRUCTION_TEMPLATE_ID', 'transferInstructionTemplateId'],
  ['PREAPPROVAL_TEMPLATE_ID', 'preapprovalTemplateId'],
  ['LOCKED_TOKEN_TEMPLATE_ID', 'lockedTokenTemplateId'],
  ['ALLOCATION_TEMPLATE_ID', 'allocationTemplateId'],
]

describe('loadConfig template ids', () => {
  it.each(templateIdVars)('binds %s to the config field it names', (envVar, field) => {
    expect(loadConfig({ ...baseEnv })[field]).toBe(baseEnv[envVar])
  })

  it.each(templateIdVars)('throws when %s is package-id qualified', (envVar) => {
    expect(() => loadConfig({ ...baseEnv, [envVar]: 'deadbeef:M:Entity' })).toThrow(
      new RegExp(`invalid ${envVar}`),
    )
  })

  it.each(templateIdVars)('throws when %s is missing its module or entity', (envVar) => {
    expect(() => loadConfig({ ...baseEnv, [envVar]: '#pkg:Entity' })).toThrow(
      new RegExp(`invalid ${envVar}`),
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

describe('loadConfig direct transfer margin parsing', () => {
  it('defaults to 30000 when DIRECT_TRANSFER_MARGIN_MS is unset', () => {
    expect(loadConfig({ ...baseEnv }).directTransferMarginMs).toBe(30_000)
  })

  it('defaults to 30000 when DIRECT_TRANSFER_MARGIN_MS is an empty string', () => {
    expect(loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: '' }).directTransferMarginMs).toBe(
      30_000,
    )
  })

  it('parses a valid DIRECT_TRANSFER_MARGIN_MS', () => {
    expect(
      loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: '90000' }).directTransferMarginMs,
    ).toBe(90_000)
  })

  it('accepts zero, which disables the margin', () => {
    expect(loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: '0' }).directTransferMarginMs).toBe(
      0,
    )
  })

  it('throws on a non-numeric DIRECT_TRANSFER_MARGIN_MS', () => {
    expect(() => loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: 'abc' })).toThrow(
      /invalid DIRECT_TRANSFER_MARGIN_MS/,
    )
  })

  it('throws on a negative DIRECT_TRANSFER_MARGIN_MS', () => {
    expect(() => loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: '-1' })).toThrow(
      /invalid DIRECT_TRANSFER_MARGIN_MS/,
    )
  })

  it('throws on a margin longer than any realistic preapproval window', () => {
    expect(() => loadConfig({ ...baseEnv, DIRECT_TRANSFER_MARGIN_MS: '3600001' })).toThrow(
      /invalid DIRECT_TRANSFER_MARGIN_MS/,
    )
  })
})

describe('loadConfig CORS origins parsing', () => {
  it('defaults to the dApp dev server when CORS_ORIGINS is unset', () => {
    expect(loadConfig({ ...baseEnv }).corsOrigins).toEqual(['http://localhost:3012'])
  })

  it('defaults to the dApp dev server when CORS_ORIGINS is an empty string', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: '' }).corsOrigins).toEqual([
      'http://localhost:3012',
    ])
  })

  it('parses a single origin', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://a' }).corsOrigins).toEqual(['http://a'])
  })

  it('splits and trims a comma-separated list', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://a, http://b' }).corsOrigins).toEqual([
      'http://a',
      'http://b',
    ])
  })

  it('drops empty entries left by stray or trailing commas', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://a,,http://b,' }).corsOrigins).toEqual([
      'http://a',
      'http://b',
    ])
  })

  it('keeps "*" verbatim: the server, not the config, interprets it', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: '*' }).corsOrigins).toEqual(['*'])
  })

  // A value that is non-empty but names nothing does not reach the default,
  // and the empty list it used to produce matched every origin against
  // nothing: the service started clean and no browser could read a response.
  it.each([
    ',',
    ' ',
    ' , , ',
    ',,,',
  ])('throws when CORS_ORIGINS is %j, which names no origin', (value) => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: value })).toThrow(
      /invalid CORS_ORIGINS: names no origin/,
    )
  })

  // The two shapes an operator actually writes by hand. A browser sends
  // neither, and cors compares origins by exact string, so both would match
  // nothing at all.
  it('throws on an entry with a trailing slash, naming what a browser would send', () => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://localhost:3012/' })).toThrow(
      /a browser would send "http:\/\/localhost:3012"/,
    )
  })

  it('throws on an entry whose host is not lower case', () => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://LOCALHOST:3012' })).toThrow(
      /a browser would send "http:\/\/localhost:3012"/,
    )
  })

  it('throws on an entry that is not a URL at all', () => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: '*.example.com' })).toThrow(
      /expected an origin, scheme:\/\/host\[:port\], or \*/,
    )
  })

  // A default port is part of what URL normalizes away, so naming it is the
  // same class of unmatchable entry as a trailing slash.
  it('throws on an entry that spells out the scheme default port', () => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://app.example:80' })).toThrow(
      /a browser would send "http:\/\/app.example"/,
    )
  })

  it('rejects a bad entry even when a good one precedes it', () => {
    expect(() =>
      loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://localhost:3012, http://app.example/' }),
    ).toThrow(/invalid CORS_ORIGINS entry "http:\/\/app.example\/"/)
  })
})
