import { Router } from 'express'
import { toDisclosed } from '../disclose.js'
import { matchesInstrument } from '../mapping.js'
import type { InstrumentConfigProposalPayload } from '../payloads.js'
import type { ServerDeps } from '../server.js'
import { asyncHandler } from './async-handler.js'
import { activeConfigs, activeRegistries, findByContractId } from './lookup.js'

// A required proposal field must be a present, non-empty string. Checking the
// type alone would let "" through, which the ledger would take as a malformed
// instrument id/name/symbol rather than reject.
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// The ledger bound on decimals, mirrored from the InstrumentConfigProposal
// `ensure`. Checking it here is what makes a bad value a 400 instead of a 500:
// the on-ledger guard is only reached by values Int64 can decode, and the
// stringified form of a fractional or huge number ("6.5", "1e+21") cannot be.
const MAX_DECIMALS = 18

// Daml Decimal is Numeric 10.
const DECIMAL_SCALE = 10

// A JSON number reaches the Numeric parser as text the participant rendered
// from a double, and that rendering turns exponential from 1e7 upwards, which
// the parser then refuses ("Could not read Numeric string \"1.0E7\"", verified
// against Canton 3.5.6). A decimal string is taken literally at any magnitude,
// so numbers are rendered here in plain notation instead of being forwarded.
// Returns null for a value no Decimal can carry, including one that underflows
// the scale, which would otherwise be silently rounded to zero.
function plainDecimal(value: number): string | null {
  if (!Number.isFinite(value)) return null
  if (Number.isInteger(value)) return BigInt(value).toString()
  const text = value.toFixed(DECIMAL_SCALE).replace(/0+$/, '').replace(/\.$/, '')
  return Number(text) === 0 ? null : text
}

function decimalText(value: unknown): string | null {
  if (typeof value === 'number') return plainDecimal(value)
  if (typeof value !== 'string') return null
  return /^-?\d+(\.\d+)?$/.test(value) ? value : null
}

// A faucet is optional, so absent and null both mean "no faucet". Anything
// else must carry a maxPerTap the ledger's Decimal parser accepts.
function faucetArgument(value: unknown): { maxPerTap: string } | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const maxPerTap = decimalText((value as Record<string, unknown>).maxPerTap)
  return maxPerTap === null ? undefined : { maxPerTap }
}

// canton-token-forge admin endpoints that drive the Plan 04 propose-accept
// instrument-registration workflow. These sit outside the four standard
// registry API groups, so there is no vendored OpenAPI spec to validate
// their bodies against; error bodies still follow the service-wide
// { error } convention.
export function adminRouter(deps: ServerDeps): Router {
  const r = Router()

  // Admin proposes an instrument through the registry. The operator identity
  // is read from the registry contract on-ledger, so it is not a request
  // field. actAs the admin, disclosing the operator-signed registry so the
  // admin (not a registry stakeholder) can exercise a choice on it.
  r.post(
    '/admin/instruments',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const { admin, instrumentId, name, symbol, decimals } = body
      if (
        !isNonEmptyString(admin) ||
        !isNonEmptyString(instrumentId) ||
        !isNonEmptyString(name) ||
        !isNonEmptyString(symbol) ||
        typeof decimals !== 'number'
      ) {
        return res.status(400).json({ error: 'missing proposal fields' })
      }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        return res
          .status(400)
          .json({ error: `decimals must be an integer between 0 and ${MAX_DECIMALS}` })
      }
      const faucet = faucetArgument(body.faucet)
      if (faucet === undefined) {
        return res.status(400).json({ error: 'faucet must be null or carry a decimal maxPerTap' })
      }

      // The operator creates exactly one TokenRegistry, so its active set is a
      // singleton; take it directly rather than through resolveUnique. A second
      // active registry would be an operator misconfiguration, not a routine
      // duplicate to surface as a 409 the way instrument configs are.
      const regs = await activeRegistries(deps.ledger, deps.config)
      const reg = regs[0]
      if (!reg) return res.status(503).json({ error: 'registry not initialized' })

      await deps.ledger.submitAndWait(
        [admin],
        [
          {
            templateId: deps.config.tokenRegistryTemplateId,
            contractId: reg.contractId,
            choice: 'TokenRegistry_ProposeInstrument',
            // Daml Int64 is encoded as a JSON string on the wire, so the
            // numeric `decimals` of the request body is stringified here.
            // `faucet` carries a Decimal, normalized to text the same way above.
            choiceArgument: {
              admin,
              instrumentId,
              name,
              symbol,
              decimals: String(decimals),
              faucet,
            },
          },
        ],
        [toDisclosed(reg)],
      )
      return res.status(202).json({ status: 'proposed' })
    }),
  )

  // Operator accepts a pending proposal after the off-ledger (admin,
  // instrumentId) uniqueness check, the authoritative enforcement point
  // since LF 2.1 has no contract keys and the operator is a mandatory
  // participant in every InstrumentConfig creation.
  r.post(
    '/admin/proposals/:proposalId/accept',
    asyncHandler(async (req, res) => {
      const prop = await findByContractId<InstrumentConfigProposalPayload>(
        deps.ledger,
        deps.config.instrumentConfigProposalTemplateId,
        deps.config.operatorParty,
        req.params.proposalId,
      )
      if (!prop) return res.status(404).json({ error: 'proposal not found' })

      const cfgRows = await activeConfigs(deps.ledger, deps.config)
      const dupIds = cfgRows
        .filter((r) =>
          matchesInstrument(r.payload, {
            admin: prop.payload.admin,
            id: prop.payload.instrumentId,
          }),
        )
        .map((r) => r.contractId)
      if (dupIds.length > 0) {
        return res
          .status(409)
          .json({ error: 'instrument id already registered', contractIds: dupIds })
      }

      await deps.ledger.submitAndWait(
        [deps.config.operatorParty],
        [
          {
            templateId: deps.config.instrumentConfigProposalTemplateId,
            contractId: prop.contractId,
            choice: 'InstrumentConfigProposal_Accept',
            choiceArgument: {},
          },
        ],
      )
      return res.status(200).json({ status: 'accepted' })
    }),
  )

  // Operator rejects a pending proposal, for parity with accept.
  r.post(
    '/admin/proposals/:proposalId/reject',
    asyncHandler(async (req, res) => {
      const prop = await findByContractId<InstrumentConfigProposalPayload>(
        deps.ledger,
        deps.config.instrumentConfigProposalTemplateId,
        deps.config.operatorParty,
        req.params.proposalId,
      )
      if (!prop) return res.status(404).json({ error: 'proposal not found' })

      await deps.ledger.submitAndWait(
        [deps.config.operatorParty],
        [
          {
            templateId: deps.config.instrumentConfigProposalTemplateId,
            contractId: prop.contractId,
            choice: 'InstrumentConfigProposal_Reject',
            choiceArgument: {},
          },
        ],
      )
      return res.status(200).json({ status: 'rejected' })
    }),
  )

  return r
}
