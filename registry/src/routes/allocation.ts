import { Router } from 'express'
import {
  anyValueBool,
  ESCROW_RECLAIMED_CONTEXT_KEY,
  EXPIRE_LOCK_CONTEXT_KEY,
  toDisclosed,
} from '../disclose.js'
import { resolveConfig } from '../mapping.js'
import type { AllocationPayload, InstrumentIdValue } from '../payloads.js'
import type { ServerDeps } from '../server.js'
import { asyncHandler } from './async-handler.js'
import { activeConfigs, findByContractId, findEscrow } from './lookup.js'
import { resolveOrRespond } from './respond.js'

interface AllocationFactoryBody {
  choiceArguments?: { allocation?: { instrumentId?: InstrumentIdValue } }
}

export function allocationRouter(deps: ServerDeps): Router {
  const r = Router()

  r.post(
    '/registry/allocation-instruction/v1/allocation-factory',
    asyncHandler(async (req, res) => {
      const instrumentId = (req.body as AllocationFactoryBody | undefined)?.choiceArguments
        ?.allocation?.instrumentId
      if (!instrumentId) return res.status(400).json({ error: 'missing allocation.instrumentId' })

      const rows = await activeConfigs(deps.ledger, deps.config)
      const cfg = resolveOrRespond(res, resolveConfig(rows, instrumentId.admin, instrumentId.id))
      if (!cfg) return

      res.json({
        factoryId: cfg.contractId,
        choiceContext: { choiceContextData: {}, disclosedContracts: [toDisclosed(cfg)] },
      })
    }),
  )

  // Only cancel is jointly authorized (executor + sender + receiver), so
  // only it may release the escrow before settleBefore, and it does so by
  // reading the early-release signal from the context. execute-transfer
  // never needs it, and withdraw is deadline-gated on-ledger and ignores
  // it, so both send empty context data.
  for (const choice of ['execute-transfer', 'withdraw', 'cancel']) {
    r.post(
      `/registry/allocations/v1/:allocationId/choice-contexts/${choice}`,
      asyncHandler(async (req, res) => {
        const alloc = await findByContractId<AllocationPayload>(
          deps.ledger,
          deps.config.allocationTemplateId,
          deps.config.adminParty,
          req.params.allocationId,
        )
        if (!alloc) return res.status(404).json({ error: 'allocation not found' })

        const escrow = await findEscrow(deps.ledger, deps.config, alloc.payload.lockedCid)
        if (!escrow) {
          // execute-transfer settles the leg out of the escrow, so an absent one
          // leaves it nothing to do. The two aborts only clear the record, and
          // report the reclaim rather than the early-release signal: there is
          // nothing left to release.
          if (choice === 'execute-transfer') {
            return res.status(404).json({ error: 'escrow not found' })
          }
          return res.json({
            choiceContextData: { [ESCROW_RECLAIMED_CONTEXT_KEY]: anyValueBool(true) },
            disclosedContracts: [],
          })
        }

        const choiceContextData =
          choice === 'cancel' ? { [EXPIRE_LOCK_CONTEXT_KEY]: anyValueBool(true) } : {}
        res.json({ choiceContextData, disclosedContracts: [toDisclosed(escrow)] })
      }),
    )
  }

  return r
}
