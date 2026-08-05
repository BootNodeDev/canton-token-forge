import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { PREAPPROVAL_CONTEXT_KEY } from '../src/disclose'
import { createServer } from '../src/server'
import {
  cfgEntry,
  config,
  instructionEntry,
  instrumentId,
  ledgerFrom,
  lockedTokenEntry,
  preapprovalEntry,
} from './helpers/fixtures'
import { validateAgainst } from './helpers/schema'

describe('transfer factory', () => {
  it('returns transferKind offer and discloses only the config when there is no preapproval', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(200)
    validateAgainst(
      'transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext',
      res.body,
    )
    expect(res.body.factoryId).toBe('cfg1')
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.choiceContextData).toEqual({})
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg1' })
  })

  it('returns transferKind direct and discloses config + preapproval when an in-window preapproval exists', async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [preapprovalEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(200)
    validateAgainst(
      'transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext',
      res.body,
    )
    expect(res.body.transferKind).toBe('direct')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(2)
    expect(
      (res.body.choiceContext.disclosedContracts as { contractId: string }[])
        .map((d) => d.contractId)
        .sort(),
    ).toEqual(['cfg1', 'pre1'])
    expect(res.body.choiceContext.choiceContextData[PREAPPROVAL_CONTEXT_KEY]).toEqual({
      tag: 'AV_ContractId',
      value: 'pre1',
    })
  })

  it('returns transferKind self and discloses only the config when sender === receiver', async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [preapprovalEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: { transfer: { instrumentId, sender: 'same::1', receiver: 'same::1' } },
      })
    expect(res.status).toBe(200)
    validateAgainst(
      'transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext',
      res.body,
    )
    expect(res.body.transferKind).toBe('self')
    expect(res.body.choiceContext.choiceContextData).toEqual({})
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg1' })
  })

  it('falls through to offer when the only preapproval is out of its validity window', async () => {
    const expired = preapprovalEntry({
      validFrom: '2020-01-01T00:00:00Z',
      expiresAt: '2021-01-01T00:00:00Z',
    })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [expired],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(200)
    validateAgainst(
      'transfer-instruction#/components/schemas/TransferFactoryWithChoiceContext',
      res.body,
    )
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
  })

  it('400s when choiceArguments.transfer.instrumentId is missing', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({ choiceArguments: { transfer: { sender: 'sender::1', receiver: 'receiver::1' } } })
    expect(res.status).toBe(400)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('400s when the request omits both sender and receiver instead of treating it as a self-transfer', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({ choiceArguments: { transfer: { instrumentId } } })
    expect(res.status).toBe(400)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('404s when no config matches the instrumentId', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('409s when (admin, instrumentId) is not unique', async () => {
    const dup = cfgEntry()
    dup.contractId = 'cfg2'
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry(), dup] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(409)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toBe('instrument id not unique')
    expect(res.body.contractIds.sort()).toEqual(['cfg1', 'cfg2'])
  })
})

describe('transfer-instruction choice-contexts', () => {
  it('discloses the config and the escrow LockedToken for accept', async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/instr1/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('transfer-instruction#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData).toEqual({})
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['cfg1', 'locked1'])
  })

  it('discloses the config and the escrow LockedToken for reject', async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/instr1/choice-contexts/reject')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('transfer-instruction#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData).toEqual({})
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['cfg1', 'locked1'])
  })

  it('discloses the config and the escrow LockedToken for withdraw', async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/instr1/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('transfer-instruction#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData).toEqual({})
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['cfg1', 'locked1'])
  })

  it('404s when the transfer instruction is not found', async () => {
    const ledger = ledgerFrom({ [config.transferInstructionTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/nope/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it("404s when no config matches the instruction's instrumentId", async () => {
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/instr1/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('409s instead of returning a context that omits the config when (admin, instrumentId) is not unique', async () => {
    const dup = cfgEntry()
    dup.contractId = 'cfg2'
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry(), dup],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/instr1/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(409)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toBe('instrument id not unique')
    expect(res.body.contractIds.sort()).toEqual(['cfg1', 'cfg2'])
  })
})
