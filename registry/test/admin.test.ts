import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { ContractEntry, ExerciseCommand } from '../src/ledger'
import type { InstrumentConfigProposalPayload, TokenRegistryPayload } from '../src/payloads'
import { createServer } from '../src/server'
import { cfgEntry, config, recordingLedger } from './helpers/fixtures'

function registryEntry(
  overrides: Partial<TokenRegistryPayload> = {},
): ContractEntry<TokenRegistryPayload> {
  return {
    templateId: config.tokenRegistryTemplateId,
    contractId: 'reg1',
    createdEventBlob: 'BLOB-REG',
    synchronizerId: 's',
    payload: {
      operator: 'op::1',
      registryBaseUrl: 'http://r',
      ...overrides,
    },
  }
}

function proposalEntry(
  overrides: Partial<InstrumentConfigProposalPayload> = {},
): ContractEntry<InstrumentConfigProposalPayload> {
  return {
    templateId: config.instrumentConfigProposalTemplateId,
    contractId: 'prop1',
    createdEventBlob: 'BLOB-PROP',
    synchronizerId: 's',
    payload: {
      admin: 'admin::1',
      operator: 'op::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
      faucet: null,
      ...overrides,
    },
  }
}

describe('POST /admin/instruments', () => {
  it('resolves the active registry and submits TokenRegistry_ProposeInstrument as the admin, disclosing the registry', async () => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
      faucet: null,
    })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ status: 'proposed' })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.actAs).toEqual(['admin::1'])
    expect(call.commands).toEqual([
      {
        templateId: config.tokenRegistryTemplateId,
        contractId: 'reg1',
        choice: 'TokenRegistry_ProposeInstrument',
        choiceArgument: {
          admin: 'admin::1',
          instrumentId: 'CC',
          name: 'Canton Coin',
          symbol: 'CC',
          // Daml Int64 is encoded as a JSON string; a bare number is rejected
          // with "Expected ujson.Str".
          decimals: '10',
          faucet: null,
        },
      },
    ])
    expect(call.disclosedContracts).toEqual([
      {
        templateId: config.tokenRegistryTemplateId,
        contractId: 'reg1',
        createdEventBlob: 'BLOB-REG',
        synchronizerId: 's',
      },
    ])
  })

  it('defaults an absent faucet to null in the choice argument', async () => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
    })
    expect(res.status).toBe(202)
    const cmd = calls[0].commands[0] as ExerciseCommand
    expect(cmd.choiceArgument.faucet).toBeNull()
  })

  // A JSON number reaches the participant's Numeric parser as text rendered
  // from a double, which goes exponential from 1e7 up and is then rejected.
  // Plain decimal text is taken literally at any magnitude.
  it.each([
    ['a small number', 1000, '1000'],
    ['a number the participant would render exponentially', 1e7, '10000000'],
    ['a fractional number', 0.5, '0.5'],
    ['a fraction below double rendering', 1e-7, '0.0000001'],
    ['a decimal string', '1000.0', '1000.0'],
  ])('sends a faucet maxPerTap given as %s as plain decimal text', async (_, given, wire) => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/admin/instruments')
      .send({
        admin: 'admin::1',
        instrumentId: 'CC',
        name: 'Canton Coin',
        symbol: 'CC',
        decimals: 10,
        faucet: { maxPerTap: given },
      })
    expect(res.status).toBe(202)
    const cmd = calls[0].commands[0] as ExerciseCommand
    expect(cmd.choiceArgument.faucet).toEqual({ maxPerTap: wire })
  })

  it.each([
    ['an empty faucet object', {}],
    ['a non-numeric maxPerTap', { maxPerTap: 'lots' }],
    ['a maxPerTap that underflows the Decimal scale', { maxPerTap: 1.5e-11 }],
    ['a non-object faucet', 'yes'],
  ])('400s on %s rather than submitting a faucet the ledger cannot read', async (_, faucet) => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
      faucet,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('400s when a required field is missing', async () => {
    const { ledger } = recordingLedger({ [config.tokenRegistryTemplateId]: [registryEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('400s when a required field is an empty string rather than submitting it to the ledger', async () => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: '',
      name: '',
      symbol: '',
      decimals: 10,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('400s when decimals is null rather than forwarding a null Int to the ledger', async () => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: null,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['fractional', 6.5],
    ['negative', -1],
    ['above the ledger bound', 19],
    ['large enough to stringify in exponential form', 1e21],
    ['NaN', Number.NaN],
  ])('400s on a %s decimals rather than submitting a value Int64 cannot decode', async (_, dec) => {
    const { ledger, calls } = recordingLedger({
      [config.tokenRegistryTemplateId]: [registryEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: dec,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('accepts the ledger bounds themselves', async () => {
    for (const decimals of [0, 18]) {
      const { ledger, calls } = recordingLedger({
        [config.tokenRegistryTemplateId]: [registryEntry()],
      })
      const app = createServer({ ledger, config })
      const res = await request(app).post('/admin/instruments').send({
        admin: 'admin::1',
        instrumentId: 'CC',
        name: 'Canton Coin',
        symbol: 'CC',
        decimals,
      })
      expect(res.status).toBe(202)
      const cmd = calls[0].commands[0] as ExerciseCommand
      expect(cmd.choiceArgument.decimals).toBe(String(decimals))
    }
  })

  it('503s when no registry is active', async () => {
    const { ledger } = recordingLedger({ [config.tokenRegistryTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/instruments').send({
      admin: 'admin::1',
      instrumentId: 'CC',
      name: 'Canton Coin',
      symbol: 'CC',
      decimals: 10,
    })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'registry not initialized' })
  })
})

describe('POST /admin/proposals/:proposalId/accept', () => {
  it('409s when an active InstrumentConfig already shares (admin, instrumentId), and does not submit', async () => {
    const { ledger, calls } = recordingLedger({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [cfgEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/prop1/accept').send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('instrument id already registered')
    expect(res.body.contractIds).toEqual(['cfg1'])
    expect(calls).toHaveLength(0)
  })

  it('409s with all conflicting contractIds when the duplicate check itself is not unique', async () => {
    const dup = cfgEntry()
    dup.contractId = 'cfg2'
    const { ledger, calls } = recordingLedger({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [cfgEntry(), dup],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/prop1/accept').send({})
    expect(res.status).toBe(409)
    expect(res.body.contractIds.sort()).toEqual(['cfg1', 'cfg2'])
    expect(calls).toHaveLength(0)
  })

  it('submits InstrumentConfigProposal_Accept as the operator when there is no duplicate', async () => {
    const { ledger, calls } = recordingLedger({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
      [config.instrumentConfigTemplateId]: [],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/prop1/accept').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'accepted' })
    expect(calls).toHaveLength(1)
    expect(calls[0].actAs).toEqual(['op::1'])
    expect(calls[0].commands).toEqual([
      {
        templateId: config.instrumentConfigProposalTemplateId,
        contractId: 'prop1',
        choice: 'InstrumentConfigProposal_Accept',
        choiceArgument: {},
      },
    ])
  })

  it('404s when the proposal is not found', async () => {
    const { ledger } = recordingLedger({ [config.instrumentConfigProposalTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/nope/accept').send({})
    expect(res.status).toBe(404)
  })
})

describe('POST /admin/proposals/:proposalId/reject', () => {
  it('submits InstrumentConfigProposal_Reject as the operator', async () => {
    const { ledger, calls } = recordingLedger({
      [config.instrumentConfigProposalTemplateId]: [proposalEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/prop1/reject').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'rejected' })
    expect(calls).toHaveLength(1)
    expect(calls[0].actAs).toEqual(['op::1'])
    expect(calls[0].commands).toEqual([
      {
        templateId: config.instrumentConfigProposalTemplateId,
        contractId: 'prop1',
        choice: 'InstrumentConfigProposal_Reject',
        choiceArgument: {},
      },
    ])
  })

  it('404s when the proposal is not found', async () => {
    const { ledger } = recordingLedger({ [config.instrumentConfigProposalTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app).post('/admin/proposals/nope/reject').send({})
    expect(res.status).toBe(404)
  })
})
