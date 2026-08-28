import { describe, expect, it } from 'vitest'
import { PREAPPROVAL_CONTEXT_KEY } from '../../src/disclose'
import {
  holdingsOf,
  preapprove,
  requestTransferFactory,
  setupInstrument,
  submitTransfer,
  tapFaucet,
} from './helpers/fixture'
import { allocateParty, LEDGER_API_URL, probeSandbox, uniqueSuffix } from './helpers/sandbox'

const live = await probeSandbox()
if (!live) console.warn(`no participant on ${LEDGER_API_URL}: skipping the end-to-end suite.`)

describe.skipIf(!live)('live direct transfer', () => {
  // No tap here: the factory route reads configs and preapprovals, never
  // holdings, so funding the sender would not change the answer.
  it('answers transferKind direct and carries the preapproval in the choice context', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const alice = await allocateParty(`e2e-alice-${suffix}`)
    const bob = await allocateParty(`e2e-bob-${suffix}`)
    const preCid = await preapprove(fx, bob)

    const res = await requestTransferFactory(fx, alice, bob)

    expect(res.status).toBe(200)
    expect(res.body.transferKind).toBe('direct')
    expect(res.body.factoryId).toBe(fx.configCid)
    expect(res.body.choiceContext.choiceContextData).toEqual({
      values: { [PREAPPROVAL_CONTEXT_KEY]: { tag: 'AV_ContractId', value: preCid } },
    })
    expect(
      res.body.choiceContext.disclosedContracts
        .map((d: { contractId: string }) => d.contractId)
        .sort(),
    ).toEqual([fx.configCid, preCid].sort())
  })

  it('completes the transfer and leaves the sender its change', async () => {
    const fx = await setupInstrument()
    const suffix = uniqueSuffix()
    const alice = await allocateParty(`e2e-alice-${suffix}`)
    const bob = await allocateParty(`e2e-bob-${suffix}`)
    const aliceCid = await tapFaucet(fx, alice, '100.0')
    await preapprove(fx, bob)

    const res = await requestTransferFactory(fx, alice, bob)
    expect(res.status).toBe(200)
    expect(res.body.transferKind).toBe('direct')

    await submitTransfer(fx, res.body, {
      sender: alice,
      receiver: bob,
      amount: '30.0',
      inputHoldingCids: [aliceCid],
    })

    const bobHoldings = await holdingsOf(fx, bob)
    expect(bobHoldings.map((h) => Number(h.payload.amount))).toEqual([30])
    const aliceHoldings = await holdingsOf(fx, alice)
    expect(aliceHoldings.map((h) => Number(h.payload.amount))).toEqual([70])
    expect(aliceHoldings.map((h) => h.contractId)).not.toContain(aliceCid)
  })
})
