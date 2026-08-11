import request from 'supertest'
import { describe, expect, it } from 'vitest'
import type { LockedPayload } from './helpers/fixture'
import {
  createOfferInstruction,
  holdingsOf,
  requestTransferFactory,
  setupInstrument,
  submitInstructionChoice,
} from './helpers/fixture'
import { allocateParty, LEDGER_API_URL, probeSandbox, uniqueSuffix } from './helpers/sandbox'

const live = await probeSandbox()
if (!live) console.warn(`no participant on ${LEDGER_API_URL}: skipping the end-to-end suite.`)

describe.skipIf(!live)('live offer transfer', () => {
  // A receiver with no preapproval is the whole difference from the direct
  // path.
  it('answers transferKind offer for a receiver with no preapproval', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const dan = await allocateParty(`e2e-dan-${suffix}`)
    const erin = await allocateParty(`e2e-erin-${suffix}`)

    const res = await requestTransferFactory(fx, dan, erin)

    expect(res.status).toBe(200)
    expect(res.body.transferKind).toBe('offer')
    expect(res.body.choiceContext.choiceContextData).toEqual({})
    expect(res.body.choiceContext.disclosedContracts).toHaveLength(1)
    expect(res.body.choiceContext.disclosedContracts[0].contractId).toBe(fx.configCid)
  })

  it('escrows the sender funds and leaves the change behind', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const dan = await allocateParty(`e2e-dan-${suffix}`)
    const erin = await allocateParty(`e2e-erin-${suffix}`)

    const { escrowCid } = await createOfferInstruction(fx, dan, erin, '40.0')

    // The run has its own admin, so the admin's escrow set can only hold what
    // this test created.
    const escrows = await fx.ledger.activeContracts(fx.ids.lockedToken, fx.admin)
    expect(escrows.map((e) => e.contractId)).toEqual([escrowCid])
    expect(Number((escrows[0].payload as LockedPayload).amount)).toBe(40)
    expect((await holdingsOf(fx, dan)).map((h) => Number(h.payload.amount))).toEqual([60])
    expect(await holdingsOf(fx, erin)).toEqual([])
  })

  it('delivers the holding when the receiver accepts with the service context', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const dan = await allocateParty(`e2e-dan-${suffix}`)
    const erin = await allocateParty(`e2e-erin-${suffix}`)
    const { instructionCid, escrowCid } = await createOfferInstruction(fx, dan, erin, '40.0')

    const ctx = await request(fx.app)
      .post(`/registry/transfer-instruction/v1/${instructionCid}/choice-contexts/accept`)
      .send({ meta: {} })
    expect(ctx.status).toBe(200)
    expect(ctx.body.choiceContextData).toEqual({})
    expect(ctx.body.disclosedContracts.map((d: { contractId: string }) => d.contractId)).toEqual([
      escrowCid,
    ])

    await submitInstructionChoice(fx, instructionCid, 'TransferInstruction_Accept', erin, ctx.body)

    expect((await holdingsOf(fx, erin)).map((h) => Number(h.payload.amount))).toEqual([40])
    expect((await holdingsOf(fx, dan)).map((h) => Number(h.payload.amount))).toEqual([60])
    expect(await fx.ledger.activeContracts(fx.ids.lockedToken, fx.admin)).toEqual([])
    expect(await fx.ledger.activeContracts(fx.ids.transferInstruction, fx.admin)).toEqual([])
  })
})
