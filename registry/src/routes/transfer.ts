import { Router } from 'express'
import {
  anyValueBool,
  anyValueContractId,
  ESCROW_RECLAIMED_CONTEXT_KEY,
  PREAPPROVAL_CONTEXT_KEY,
  toDisclosed,
} from '../disclose.js'
import { matchesInstrument, resolveConfig } from '../mapping.js'
import type { InstrumentIdValue, TransferInstructionPayload } from '../payloads.js'
import type { ServerDeps } from '../server.js'
import { asyncHandler } from './async-handler.js'
import { activeConfigs, activePreapprovals, findByContractId, findEscrow } from './lookup.js'
import { resolveOrRespond } from './respond.js'

interface TransferFactoryBody {
  choiceArguments?: {
    transfer?: { instrumentId?: InstrumentIdValue; sender?: string; receiver?: string }
  }
}

export function transferRouter(deps: ServerDeps): Router {
  const r = Router()

  r.post(
    '/registry/transfer-instruction/v1/transfer-factory',
    asyncHandler(async (req, res) => {
      const transfer = (req.body as TransferFactoryBody | undefined)?.choiceArguments?.transfer
      if (!transfer?.instrumentId)
        return res.status(400).json({ error: 'missing transfer.instrumentId' })
      const { instrumentId, sender, receiver } = transfer
      if (!sender || !receiver)
        return res.status(400).json({ error: 'missing transfer.sender or transfer.receiver' })

      // The config set and the preapprovals are independent lookups, so fetch
      // both up front: the common direct/offer path then costs one round-trip
      // instead of two, at the price of one wasted preapproval query on the
      // self and not-found paths.
      const [cfgRows, preapprovalRows] = await Promise.all([
        activeConfigs(deps.ledger, deps.config),
        activePreapprovals(deps.ledger, deps.config),
      ])
      const now = Date.now()
      const cfg = resolveOrRespond(res, resolveConfig(cfgRows, instrumentId.admin, instrumentId.id))
      if (!cfg) return

      // self and offer share the same empty context disclosing only the
      // config; only a matched preapproval with enough of its window left
      // upgrades to a direct one.
      const baseContext = { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] }

      if (sender === receiver) {
        return res.json({
          factoryId: cfg.contractId,
          transferKind: 'self',
          choiceContext: baseContext,
        })
      }

      // Only expiresAt carries the margin. Latency alone argues for leaving
      // validFrom bare, since waiting can only bring a not-yet-valid
      // preapproval into its window; clock skew can push the other way, so a
      // preapproval that opened moments ago may still be in the future at
      // ledger time and abort. That exposure is accepted: it lasts only the
      // opening moments of a window, whereas expiry is a boundary every
      // preapproval eventually crosses while still being recommended.
      const pre = preapprovalRows.find(
        (p) =>
          matchesInstrument(p.payload, instrumentId) &&
          p.payload.receiver === receiver &&
          Date.parse(p.payload.validFrom) <= now &&
          now + deps.config.directTransferMarginMs < Date.parse(p.payload.expiresAt),
      )
      if (pre) {
        return res.json({
          factoryId: cfg.contractId,
          transferKind: 'direct',
          choiceContext: {
            choiceContextData: { [PREAPPROVAL_CONTEXT_KEY]: anyValueContractId(pre.contractId) },
            disclosedContracts: [toDisclosed(cfg), toDisclosed(pre)],
          },
        })
      }

      return res.json({
        factoryId: cfg.contractId,
        transferKind: 'offer',
        choiceContext: baseContext,
      })
    }),
  )

  // accept / reject / withdraw disclose the escrow LockedToken and nothing
  // else: none of the three choice bodies fetches an InstrumentConfig, so
  // disclosing one would only add a lookup that can fail. None of them reads
  // the expire-lock signal either (reject unlocks unconditionally, withdraw is
  // deadline-gated on-ledger), so choiceContextData is empty whenever the
  // escrow is there to disclose.
  for (const choice of ['accept', 'reject', 'withdraw']) {
    r.post(
      `/registry/transfer-instruction/v1/:transferInstructionId/choice-contexts/${choice}`,
      asyncHandler(async (req, res) => {
        const instr = await findByContractId<TransferInstructionPayload>(
          deps.ledger,
          deps.config.transferInstructionTemplateId,
          deps.config.adminParty,
          req.params.transferInstructionId,
        )
        if (!instr) return res.status(404).json({ error: 'transfer instruction not found' })

        const escrow = await findEscrow(deps.ledger, deps.config, instr.payload.lockedCid)
        if (!escrow) {
          // Accept settles out of the escrow, so an absent one leaves it
          // nothing to do. The two aborts only clear the record, and report the
          // reclaim so the choice does not reach for a contract that is gone.
          if (choice === 'accept') return res.status(404).json({ error: 'escrow not found' })
          return res.json({
            choiceContextData: { [ESCROW_RECLAIMED_CONTEXT_KEY]: anyValueBool(true) },
            disclosedContracts: [],
          })
        }

        res.json({ choiceContextData: {}, disclosedContracts: [toDisclosed(escrow)] })
      }),
    )
  }

  return r
}
