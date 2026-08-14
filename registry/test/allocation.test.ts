import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { anyValueBool, EXPIRE_LOCK_CONTEXT_KEY } from '../src/disclose'
import { createServer } from '../src/server'
import {
  allocationEntry,
  cfgEntry,
  config,
  instrumentId,
  ledgerFrom,
  lockedTokenEntry,
  otherCfgEntry,
  otherInstrumentId,
  recordingLedgerFrom,
} from './helpers/fixtures'
import { validateAgainst } from './helpers/schema'

describe('allocation factory', () => {
  it('returns factoryId + disclosed config', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocation-instruction/v1/allocation-factory')
      .send({ choiceArguments: { allocation: { instrumentId } } })
    expect(res.status).toBe(200)
    validateAgainst('allocation-instruction#/components/schemas/FactoryWithChoiceContext', res.body)
    expect(res.body.factoryId).toBe('cfg1')
    expect(res.body.choiceContext.choiceContextData).toEqual({})
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
    expect(res.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg1' })
  })

  it('selects the config of the requested instrument when the admin serves several', async () => {
    // The other config comes first, so answering with the first readable row
    // rather than the matching one is a failure, not a coincidence.
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [otherCfgEntry(), cfgEntry()],
    })
    const app = createServer({ ledger, config })
    const factoryFor = async (id: typeof instrumentId) =>
      await request(app)
        .post('/registry/allocation-instruction/v1/allocation-factory')
        .send({ choiceArguments: { allocation: { instrumentId: id } } })

    const cc = await factoryFor(instrumentId)
    expect(cc.status).toBe(200)
    expect(cc.body.factoryId).toBe('cfg1')
    expect(cc.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg1' })

    const other = await factoryFor(otherInstrumentId)
    expect(other.status).toBe(200)
    expect(other.body.factoryId).toBe('cfg2')
    expect(other.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg2' })
  })

  it('400s when choiceArguments.allocation.instrumentId is missing', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry()] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocation-instruction/v1/allocation-factory')
      .send({ choiceArguments: { allocation: {} } })
    expect(res.status).toBe(400)
    validateAgainst('allocation-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('404s when no config matches the instrumentId', async () => {
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocation-instruction/v1/allocation-factory')
      .send({ choiceArguments: { allocation: { instrumentId } } })
    expect(res.status).toBe(404)
    validateAgainst('allocation-instruction#/components/schemas/ErrorResponse', res.body)
  })

  it('409s when (admin, instrumentId) is not unique', async () => {
    const dup = cfgEntry()
    dup.contractId = 'cfg2'
    const ledger = ledgerFrom({ [config.instrumentConfigTemplateId]: [cfgEntry(), dup] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocation-instruction/v1/allocation-factory')
      .send({ choiceArguments: { allocation: { instrumentId } } })
    expect(res.status).toBe(409)
    validateAgainst('allocation-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toBe('instrument id not unique')
    expect(res.body.contractIds.sort()).toEqual(['cfg1', 'cfg2'])
  })
})

describe('allocation choice-contexts', () => {
  // The allocation and its escrow are both named by a contract id, so this
  // route costs two bounded reads however many allocations the admin holds.
  it('resolves the allocation and its escrow by contract id, downloading no active set', async () => {
    const { ledger, queries, lookups } = recordingLedgerFrom({
      [config.allocationTemplateId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const res = await request(createServer({ ledger, config }))
      .post('/registry/allocations/v1/alloc1/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    expect(lookups).toEqual([
      [config.allocationTemplateId, 'alloc1', config.adminParty],
      [config.lockedTokenTemplateId, 'locked1', config.adminParty],
    ])
    expect(queries).toEqual([])
  })

  it('cancel carries the expire-lock signal and discloses the escrow LockedToken', async () => {
    const ledger = ledgerFrom({
      [config.allocationTemplateId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocations/v1/alloc1/choice-contexts/cancel')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('allocation#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData[EXPIRE_LOCK_CONTEXT_KEY]).toEqual(anyValueBool(true))
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['locked1'])
  })

  it('withdraw discloses the escrow LockedToken but sends no signal', async () => {
    const ledger = ledgerFrom({
      [config.allocationTemplateId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocations/v1/alloc1/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('allocation#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData).toEqual({})
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['locked1'])
  })

  it('execute-transfer discloses the escrow LockedToken but sends no signal', async () => {
    const ledger = ledgerFrom({
      [config.allocationTemplateId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocations/v1/alloc1/choice-contexts/execute-transfer')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('allocation#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData).toEqual({})
    const ids = (res.body.disclosedContracts as { contractId: string }[])
      .map((d) => d.contractId)
      .sort()
    expect(ids).toEqual(['locked1'])
  })

  it('404s instead of returning an empty context when the escrow LockedToken is gone', async () => {
    const ledger = ledgerFrom({
      [config.allocationTemplateId]: [allocationEntry()],
      [config.lockedTokenTemplateId]: [],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocations/v1/alloc1/choice-contexts/cancel')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('allocation#/components/schemas/ErrorResponse', res.body)
    // The allocation itself resolves here, so only the message separates a
    // stale escrow from the not-found allocation below.
    expect(res.body.error).toBe('escrow not found')
  })

  it('404s when the allocation is not found', async () => {
    const ledger = ledgerFrom({ [config.allocationTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/allocations/v1/nope/choice-contexts/cancel')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('allocation#/components/schemas/ErrorResponse', res.body)
  })
})
