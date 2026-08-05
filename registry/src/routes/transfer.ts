import { Router } from 'express'
import { anyValueContractId, PREAPPROVAL_CONTEXT_KEY, toDisclosed } from '../disclose.js'
import { matchesInstrument, resolveConfig } from '../mapping.js'
import type { InstrumentIdValue, TransferInstructionPayload } from '../payloads.js'
import type { ServerDeps } from '../server.js'
import { asyncHandler } from './async-handler.js'
import { activeConfigs, activePreapprovals, escrowDisclosure, findByContractId } from './lookup.js'
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
      const now = Date.now()
      const [cfgRows, preapprovalRows] = await Promise.all([
        activeConfigs(deps.ledger, deps.config),
        activePreapprovals(deps.ledger, deps.config),
      ])
      const cfg = resolveOrRespond(res, resolveConfig(cfgRows, instrumentId.admin, instrumentId.id))
      if (!cfg) return

      // self and offer share the same empty context disclosing only the
      // config; only a matched in-window preapproval upgrades to a direct one.
      const baseContext = { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] }

      if (sender === receiver) {
        return res.json({
          factoryId: cfg.contractId,
          transferKind: 'self',
          choiceContext: baseContext,
        })
      }

      // Only a preapproval whose validity window covers now enables a direct
      // transfer: TokenTransferPreapproval_Send asserts validFrom <= now <
      // expiresAt on-ledger, and the direct path hard-fails (no offer
      // fallback) against an out-of-window one, so an expired or
      // not-yet-valid preapproval must fall through to "offer" here.
      const pre = preapprovalRows.find(
        (p) =>
          matchesInstrument(p.payload, instrumentId) &&
          p.payload.receiver === receiver &&
          Date.parse(p.payload.validFrom) <= now &&
          now < Date.parse(p.payload.expiresAt),
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

  // accept / reject / withdraw all disclose the InstrumentConfig and the
  // escrow LockedToken; none of the three read the expire-lock signal on
  // the transfer path (reject unlocks unconditionally, withdraw is
  // deadline-gated on-ledger), so choiceContextData is always empty here.
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

        const instrumentId = instr.payload.transfer.instrumentId
        // The config query and the escrow disclosure are independent once the
        // instruction is resolved, so run them concurrently.
        const [cfgRows, escrow] = await Promise.all([
          activeConfigs(deps.ledger, deps.config),
          escrowDisclosure(deps.ledger, deps.config, instr.payload.lockedCid),
        ])
        const cfg = resolveOrRespond(
          res,
          resolveConfig(cfgRows, instrumentId.admin, instrumentId.id),
        )
        if (!cfg) return

        const disclosedContracts = [toDisclosed(cfg), ...escrow]
        res.json({ choiceContextData: {}, disclosedContracts })
      }),
    )
  }

  return r
}
