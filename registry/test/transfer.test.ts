import request from 'supertest'
import { describe, expect, it } from 'vitest'
import {
  anyValueBool,
  ESCROW_RECLAIMED_CONTEXT_KEY,
  PREAPPROVAL_CONTEXT_KEY,
} from '../src/disclose'
import { LedgerRequestError } from '../src/ledger'
import { createServer } from '../src/server'
import {
  cfgEntry,
  config,
  instructionEntry,
  instrumentId,
  ledgerFrom,
  lockedTokenEntry,
  otherCfgEntry,
  otherInstrumentId,
  preapprovalEntry,
  recordingLedgerFrom,
  recordingLogger,
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

  it('selects the config of the requested instrument when the admin serves several', async () => {
    // The other config comes first, so answering with the first readable row
    // rather than the matching one is a failure, not a coincidence.
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [otherCfgEntry(), cfgEntry()],
    })
    const app = createServer({ ledger, config })
    const factoryFor = async (id: typeof instrumentId) =>
      await request(app)
        .post('/registry/transfer-instruction/v1/transfer-factory')
        .send({
          choiceArguments: {
            transfer: { instrumentId: id, sender: 'sender::1', receiver: 'receiver::1' },
          },
        })

    const cc = await factoryFor(instrumentId)
    expect(cc.status).toBe(200)
    expect(cc.body.factoryId).toBe('cfg1')
    expect(cc.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg1' })

    const other = await factoryFor(otherInstrumentId)
    expect(other.status).toBe(200)
    expect(other.body.factoryId).toBe('cfg2')
    expect(other.body.choiceContext.disclosedContracts[0]).toMatchObject({ contractId: 'cfg2' })
  })

  it('returns transferKind direct and discloses config + preapproval when an active preapproval exists', async () => {
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

  it('falls through to offer when the only preapproval is not yet valid', async () => {
    const notYetValid = preapprovalEntry({
      validFrom: '2999-01-01T00:00:00Z',
      expiresAt: '2999-06-01T00:00:00Z',
    })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [notYetValid],
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
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
  })

  it('falls through to offer when the only preapproval expires inside the safety margin', async () => {
    const expiringSoon = preapprovalEntry({
      expiresAt: new Date(Date.now() + 15_000).toISOString(),
    })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [expiringSoon],
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

  it('reads the safety margin from the config rather than a fixed value', async () => {
    // The same preapproval the default-margin test above answers "direct" for,
    // under a margin wide enough to cover its remaining window.
    const expiringLater = preapprovalEntry({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [expiringLater],
    })
    const app = createServer({ ledger, config: { ...config, directTransferMarginMs: 120_000 } })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: { instrumentId, sender: 'sender::1', receiver: 'receiver::1' },
        },
      })
    expect(res.status).toBe(200)
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
  })

  it('returns transferKind direct when the only preapproval expires outside the safety margin', async () => {
    const expiringLater = preapprovalEntry({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [expiringLater],
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
    expect(res.body.choiceContext.choiceContextData[PREAPPROVAL_CONTEXT_KEY]).toEqual({
      tag: 'AV_ContractId',
      value: 'pre1',
    })
  })

  // The admin is a stakeholder of every preapproval it issued, so these two
  // reach the match filter and must be rejected by it, not by visibility.
  it('falls through to offer when the only preapproval is for a different receiver', async () => {
    const otherReceiver = preapprovalEntry({ receiver: 'other::1' }, [
      instrumentId.admin,
      'other::1',
    ])
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [otherReceiver],
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
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
  })

  it('falls through to offer when the only preapproval is for a different instrument', async () => {
    const otherInstrument = preapprovalEntry({ instrumentId: 'USDX' })
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [otherInstrument],
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
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
  })

  // Every InstrumentConfig this service can read is one it administers, so the
  // admin comparison in resolveConfig looks redundant from inside the suite.
  // It is not: it is the only thing stopping the registry from answering for an
  // instrument someone else administers. Pinning the read party at the same
  // time keeps a refactor from sourcing it off the request body.
  it('404s a factory request for an instrument administered by someone else, reading as the configured admin', async () => {
    const { ledger, queries } = recordingLedgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry()],
      [config.preapprovalTemplateId]: [preapprovalEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/transfer-factory')
      .send({
        choiceArguments: {
          transfer: {
            instrumentId: { admin: 'other-registry::1', id: instrumentId.id },
            sender: 'sender::1',
            receiver: 'receiver::1',
          },
        },
      })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
    expect(queries).toEqual([
      [config.instrumentConfigTemplateId, config.adminParty],
      [config.preapprovalTemplateId, config.adminParty],
    ])
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
  // No InstrumentConfig is put on the ledger for these three: none of the
  // choice bodies fetches one, so the route must answer without ever looking.
  // Restoring the config lookup turns every one of them into a 404.
  for (const choice of ['accept', 'reject', 'withdraw']) {
    it(`discloses only the escrow LockedToken for ${choice}`, async () => {
      const ledger = ledgerFrom({
        [config.transferInstructionTemplateId]: [instructionEntry()],
        [config.lockedTokenTemplateId]: [lockedTokenEntry()],
      })
      const app = createServer({ ledger, config })
      const res = await request(app)
        .post(`/registry/transfer-instruction/v1/00cafe01/choice-contexts/${choice}`)
        .send({ meta: {} })
      expect(res.status).toBe(200)
      validateAgainst('transfer-instruction#/components/schemas/ChoiceContext', res.body)
      expect(res.body.choiceContextData).toEqual({})
      const ids = (res.body.disclosedContracts as { contractId: string }[]).map((d) => d.contractId)
      expect(ids).toEqual(['locked1'])
    })
  }

  // Both contracts on this path are named by a contract id, so the route
  // resolves each one directly. Downloading the instruction and escrow active
  // sets to scan them in memory made the cost of a choice context grow with
  // every open transfer the admin is a stakeholder of.
  it('resolves the instruction and its escrow by contract id, downloading no active set', async () => {
    const { ledger, queries, lookups } = recordingLedgerFrom({
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const res = await request(createServer({ ledger, config }))
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    expect(lookups).toEqual([
      [config.transferInstructionTemplateId, '00cafe01', config.adminParty],
      [config.lockedTokenTemplateId, 'locked1', config.adminParty],
    ])
    expect(queries).toEqual([])
  })

  it('404s when the transfer instruction is not found', async () => {
    const ledger = ledgerFrom({ [config.transferInstructionTemplateId]: [] })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe99/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  // An id that is not hex at all cannot name a contract, so the route answers it
  // without a participant round-trip: the assertions on lookups and queries are
  // what pin that it never asks. A hex id the participant cannot parse is the
  // other half, and the ledger client reads that rejection as the same miss.
  it('404s on a contract id no participant could parse, without asking one', async () => {
    const { ledger, lookups, queries } = recordingLedgerFrom({
      [config.transferInstructionTemplateId]: [instructionEntry()],
    })
    const res = await request(createServer({ ledger, config }))
      .post('/registry/transfer-instruction/v1/not-a-cid/choice-contexts/accept')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    expect(lookups).toEqual([])
    expect(queries).toEqual([])
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
  })

  // Accept has nothing left to settle out of, and reject, controlled by the
  // receiver alone, is the one abort the Daml side refuses to let a reclaim
  // report clear, so it has nothing left to do either. Neither reads the state
  // the escrow is gone in: only withdraw acts on that difference.
  for (const choice of ['accept', 'reject']) {
    for (const [state, archived] of [
      ['no longer active', true],
      ['not found at all', false],
    ] as const) {
      it(`404s instead of returning a ${choice} context that omits an escrow ${state}`, async () => {
        const ledger = ledgerFrom(
          {
            [config.transferInstructionTemplateId]: [instructionEntry()],
            [config.lockedTokenTemplateId]: [],
          },
          archived ? { [config.lockedTokenTemplateId]: [lockedTokenEntry()] } : {},
        )
        const app = createServer({ ledger, config })
        const res = await request(app)
          .post(`/registry/transfer-instruction/v1/00cafe01/choice-contexts/${choice}`)
          .send({ meta: {} })
        expect(res.status).toBe(404)
        validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
        // The instruction resolves on this path, so only the message separates a
        // stale escrow from the route's other 404.
        expect(res.body.error).toBe('escrow not found')
      })
    }
  }

  // The report is a positive claim that the sender already took the escrow
  // back, and a client acts on it by archiving the instruction. A lookup that
  // found nothing is not that claim: with LOCKED_TOKEN_TEMPLATE_ID naming
  // another template the participant really hosts, every live escrow reads as
  // absent, and reporting a reclaim there clears the record while the funds
  // stay locked until the escrow's own expiry.
  it('404s the withdraw context when the escrow lookup found nothing at all', async () => {
    const ledger = ledgerFrom({
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(404)
    validateAgainst('transfer-instruction#/components/schemas/ErrorResponse', res.body)
    expect(res.body.error).toBe('escrow not found')
    // Not merely a 404: the report must not ride along on an error body either.
    expect(res.body.choiceContextData).toBeUndefined()
  })

  it('reports a reclaimed escrow instead of refusing the withdraw context', async () => {
    const ledger = ledgerFrom(
      {
        [config.transferInstructionTemplateId]: [instructionEntry()],
        [config.lockedTokenTemplateId]: [],
      },
      { [config.lockedTokenTemplateId]: [lockedTokenEntry()] },
    )
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    validateAgainst('transfer-instruction#/components/schemas/ChoiceContext', res.body)
    expect(res.body.choiceContextData[ESCROW_RECLAIMED_CONTEXT_KEY]).toEqual(anyValueBool(true))
    // nothing to disclose: the contract the escrow disclosure would name is
    // the one that is gone
    expect(res.body.disclosedContracts).toEqual([])
  })

  // A refused escrow read is a fault of ours, not an answer about the escrow.
  // Reading it as one would 404 the withdraw context for an instruction whose
  // escrow is sitting on the ledger untouched, hiding a broken read behind a
  // routine not-found, so the read has to fail loudly instead.
  it('fails the withdraw context rather than reporting a reclaim when the escrow read is refused', async () => {
    const base = ledgerFrom({
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const ledger = {
      ...base,
      lookupByContractId: (templateId: string, contractId: string, party: string) =>
        templateId === config.lockedTokenTemplateId
          ? Promise.reject(new LedgerRequestError(400, 'contract lookup rejected: 400'))
          : base.lookupByContractId(templateId, contractId, party),
    }
    const { logger } = recordingLogger()
    const app = createServer({ ledger, config, logger })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(500)
    expect(res.body.choiceContextData).toBeUndefined()
  })

  // The two lookups a choice-context makes differ in where their id came from,
  // and only the client's may be forgiven an id the participant cannot parse.
  // Flagging the escrow lookup as well would read a payload that is not the
  // shape it was cast to as an escrow the ledger simply does not hold.
  it("marks only the client's path parameter as a client-supplied contract id", async () => {
    const base = ledgerFrom({
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const flags: Record<string, boolean | undefined> = {}
    const ledger = {
      ...base,
      lookupByContractId: (
        templateId: string,
        contractId: string,
        party: string,
        clientSuppliedId?: boolean,
      ) => {
        flags[templateId] = clientSuppliedId
        return base.lookupByContractId(templateId, contractId, party)
      },
    }
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/withdraw')
      .send({ meta: {} })
    expect(res.status).toBe(200)
    expect(flags[config.transferInstructionTemplateId]).toBe(true)
    expect(flags[config.lockedTokenTemplateId]).toBeFalsy()
  })

  it('names the reclaimed-escrow key exactly as the Daml choice reads it', async () => {
    const ledger = ledgerFrom(
      {
        [config.transferInstructionTemplateId]: [instructionEntry()],
        [config.lockedTokenTemplateId]: [],
      },
      { [config.lockedTokenTemplateId]: [lockedTokenEntry()] },
    )
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/withdraw')
      .send({ meta: {} })
    // spelled out rather than imported, so renaming the constant cannot travel
    // through both sides of this contract unnoticed
    expect(Object.keys(res.body.choiceContextData)).toEqual(['canton-token-forge/escrow-reclaimed'])
  })

  it('serves a context for an instrument whose config is duplicated', async () => {
    const dup = cfgEntry()
    dup.contractId = 'cfg2'
    const ledger = ledgerFrom({
      [config.instrumentConfigTemplateId]: [cfgEntry(), dup],
      [config.transferInstructionTemplateId]: [instructionEntry()],
      [config.lockedTokenTemplateId]: [lockedTokenEntry()],
    })
    const app = createServer({ ledger, config })
    const res = await request(app)
      .post('/registry/transfer-instruction/v1/00cafe01/choice-contexts/accept')
      .send({ meta: {} })
    // A duplicate config 409s the factory route, which has to name one config
    // as the factory. These three choices never read one, so an accept that is
    // otherwise valid must not be blocked by an ambiguity it does not depend on.
    expect(res.status).toBe(200)
    const ids = (res.body.disclosedContracts as { contractId: string }[]).map((d) => d.contractId)
    expect(ids).toEqual(['locked1'])
  })
})
