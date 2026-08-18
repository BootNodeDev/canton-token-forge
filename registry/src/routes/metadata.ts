import { Router } from 'express'
import type { ContractEntry } from '../ledger.js'
import {
  type Instrument,
  instrumentIdentity,
  resolveById,
  SUPPORTED_APIS,
  toInstrument,
} from '../mapping.js'
import type { InstrumentConfigPayload } from '../payloads.js'
import type { ServerDeps } from '../server.js'
import { asyncHandler } from './async-handler.js'
import { activeConfigs } from './lookup.js'
import { resolveOrRespond } from './respond.js'

// Collapse rows to one entry per (admin, instrumentId): LF 2.1 has no
// contract keys, so nothing prevents duplicates, but the list endpoint
// should not surface them as visible duplicates the way get-by-id does.
function dedupeByAdminAndInstrumentId(
  rows: ContractEntry<InstrumentConfigPayload>[],
): ContractEntry<InstrumentConfigPayload>[] {
  const seen = new Map<string, ContractEntry<InstrumentConfigPayload>>()
  for (const row of rows) {
    const key = instrumentIdentity(row.payload)
    if (!seen.has(key)) seen.set(key, row)
  }
  return [...seen.values()]
}

// The spec declares pageSize with `default: 25` and the request validator
// injects that default before the handler runs, so a bare request already asks
// for 25. The bounds are ours: the schema sets no minimum, and its int32 format
// is registered permissively (see createServer), so a client can ask for 0, -1
// or a number far larger than any page should hold.
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function pageSizeOf(requested: unknown): number {
  const size = Number(requested)
  if (!Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE
  return Math.min(size, MAX_PAGE_SIZE)
}

// Keyset pagination over the instrument id, which is what the spec describes
// when it calls nextPageToken "the lastInstrumentId for the next page": a page
// is the ids strictly after the token, in order. Nothing needs to exist at the
// token itself, so a stale token resumes from its position rather than failing.
// Sort and token comparison have to agree or a page can skip or repeat an
// instrument, which is why both use `<`/`>` and not localeCompare. This bounds
// the response, not the ledger read behind it (see activeConfigs).
function pageOf(
  instruments: Instrument[],
  pageSize: number,
  pageToken: string | undefined,
): { instruments: Instrument[]; nextPageToken?: string } {
  const ordered = [...instruments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const remaining = pageToken === undefined ? ordered : ordered.filter((i) => i.id > pageToken)
  const page = remaining.slice(0, pageSize)
  const last = page.at(-1)
  if (last === undefined || remaining.length === page.length) return { instruments: page }
  return { instruments: page, nextPageToken: last.id }
}

export function metadataRouter(deps: ServerDeps): Router {
  const r = Router()

  r.get('/registry/metadata/v1/info', (_req, res) => {
    res.json({
      adminId: deps.config.adminParty,
      supportedApis: SUPPORTED_APIS,
    })
  })

  r.get(
    '/registry/metadata/v1/instruments',
    asyncHandler(async (req, res) => {
      const rows = await activeConfigs(deps.ledger, deps.config)
      const instruments = dedupeByAdminAndInstrumentId(rows).map((row) => toInstrument(row.payload))
      const { pageToken } = req.query
      res.json(
        pageOf(
          instruments,
          pageSizeOf(req.query.pageSize),
          typeof pageToken === 'string' ? pageToken : undefined,
        ),
      )
    }),
  )

  r.get(
    '/registry/metadata/v1/instruments/:instrumentId',
    asyncHandler(async (req, res) => {
      const rows = await activeConfigs(deps.ledger, deps.config)
      const cfg = resolveOrRespond(res, resolveById(rows, req.params.instrumentId))
      if (!cfg) return
      res.json(toInstrument(cfg.payload))
    }),
  )

  return r
}
