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
  // The service tells a contract the participant has never seen from a read the
  // participant refused by one literal in the error body, and answers the first
  // as a 404 and the second as a 500. Nothing else pins that literal to what a
  // real participant sends, so a rewording would silently turn every miss on
  // these routes into a server error. This is the assertion that catches it:
  // the id below is well-formed, so the only thing standing between it and a
  // 404 is the wording.
  it('404s on a well-formed contract id no participant has ever issued', async () => {
    const fx = await setupInstrument()
    const unknownCid = `00${'a'.repeat(64)}ca121220${'a'.repeat(64)}`

    const res = await request(fx.app)
      .post(`/registry/transfer-instruction/v1/${unknownCid}/choice-contexts/accept`)
      .send({ meta: {} })

    expect(res.status).toBe(404)
  })

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

  // The sender can reclaim an escrow directly once the offer window closes,
  // which leaves the instruction pointing at a contract that is gone. This is
  // the only path in the suite that puts an AV_Bool choice-context value on the
  // wire, so it is also where that encoding is exercised against a real
  // participant.
  it('withdraws an instruction whose escrow the sender already reclaimed', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const dan = await allocateParty(`e2e-dan-${suffix}`)
    const erin = await allocateParty(`e2e-erin-${suffix}`)

    // Short enough to wait out, since both the reclaim and the withdraw are
    // gated on this instant having passed. The helper measures the window from
    // just before it submits the transfer, so only that submission has to land
    // inside it, and the wait below runs to the deadline the offer actually
    // carries rather than to a duration guessed alongside it.
    const { instructionCid, escrowCid, executeBefore } = await createOfferInstruction(
      fx,
      dan,
      erin,
      '40.0',
      6_000,
    )
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(executeBefore) - Date.now()) + 1_000),
    )

    await fx.ledger.submitAndWait(
      [dan],
      [
        {
          templateId: fx.ids.lockedToken,
          contractId: escrowCid,
          choice: 'LockedToken_ExpireLock',
          choiceArgument: {},
        },
      ],
    )
    expect(await fx.ledger.activeContracts(fx.ids.lockedToken, fx.admin)).toEqual([])

    const ctx = await request(fx.app)
      .post(`/registry/transfer-instruction/v1/${instructionCid}/choice-contexts/withdraw`)
      .send({ meta: {} })
    expect(ctx.status).toBe(200)
    expect(ctx.body.choiceContextData).toEqual({
      'canton-token-forge/escrow-reclaimed': { tag: 'AV_Bool', value: true },
    })
    expect(ctx.body.disclosedContracts).toEqual([])

    await submitInstructionChoice(fx, instructionCid, 'TransferInstruction_Withdraw', dan, ctx.body)

    expect(await fx.ledger.activeContracts(fx.ids.transferInstruction, fx.admin)).toEqual([])
    // 60 change plus the 40 the reclaim returned, so the withdraw cleared the
    // record without paying anything a second time
    expect((await holdingsOf(fx, dan)).map((h) => Number(h.payload.amount)).sort()).toEqual([
      40, 60,
    ])
  })
})
