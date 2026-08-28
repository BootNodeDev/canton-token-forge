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
import { activeConfigs, findByContractId, findEscrow, isContractId } from './lookup.js'
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
        choiceContext: {
          choiceContextData: { values: {} },
          disclosedContracts: [toDisclosed(cfg)],
        },
      })
    }),
  )

  // Only cancel is jointly authorized (executor + sender + receiver), so
  // only it may release the escrow before settleBefore, and it does so by
  // reading the early-release signal from the context. execute-transfer
  // never needs that signal, and withdraw is deadline-gated on-ledger and
  // ignores it, so neither is ever sent it: with the escrow there to disclose,
  // those two send empty context data and cancel sends the signal alone.
  for (const choice of ['execute-transfer', 'withdraw', 'cancel']) {
    r.post(
      `/registry/allocations/v1/:allocationId/choice-contexts/${choice}`,
      asyncHandler(async (req, res) => {
        const notFound = { error: 'allocation not found' }
        if (!isContractId(req.params.allocationId)) return res.status(404).json(notFound)

        const alloc = await findByContractId<AllocationPayload>(
          deps.ledger,
          deps.config.allocationTemplateId,
          deps.config.adminParty,
          req.params.allocationId,
        )
        if (!alloc) return res.status(404).json(notFound)

        const escrow = await findEscrow(deps.ledger, deps.config, alloc.payload.lockedCid)
        if (escrow.state !== 'live') {
          // execute-transfer settles the leg out of the escrow, so an escrow
          // that is not live leaves it nothing to do. The two aborts only clear
          // the record and report the reclaim. Cancel keeps its early-release
          // signal alongside that report: the signal is what authorizes acting
          // before settleBefore, and the record still has to be cleared then
          // whether or not there is an escrow left to release.
          //
          // Both of them need the archive event first. The report and the
          // signal together are what let a client clear the allocation record,
          // and a lookup that merely found nothing is no evidence the sender
          // ever got the escrow back: a LOCKED_TOKEN_TEMPLATE_ID naming another
          // template the participant hosts reads every live escrow that way.
          if (choice === 'execute-transfer' || escrow.state !== 'archived') {
            return res.status(404).json({ error: 'escrow not found' })
          }
          const reclaimed = { [ESCROW_RECLAIMED_CONTEXT_KEY]: anyValueBool(true) }
          return res.json({
            choiceContextData: {
              values:
                choice === 'cancel'
                  ? { ...reclaimed, [EXPIRE_LOCK_CONTEXT_KEY]: anyValueBool(true) }
                  : reclaimed,
            },
            disclosedContracts: [],
          })
        }

        const choiceContextData = {
          values: choice === 'cancel' ? { [EXPIRE_LOCK_CONTEXT_KEY]: anyValueBool(true) } : {},
        }
        res.json({ choiceContextData, disclosedContracts: [toDisclosed(escrow.entry)] })
      }),
    )
  }

  return r
}
