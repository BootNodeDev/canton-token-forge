import type { Express } from 'express'
import type { Config } from '../../../src/config'
import { HttpLedgerClient } from '../../../src/ledger'
import type { InstrumentConfigPayload } from '../../../src/payloads'
import { createServer } from '../../../src/server'
import { allocateParty, LEDGER_API_URL, LEDGER_USER_ID, templateIds, uniqueSuffix } from './sandbox'

export interface LiveFixture {
  admin: string
  instrumentId: string
  configCid: string
  ledger: HttpLedgerClient
  config: Config
  app: Express
  ids: ReturnType<typeof templateIds>
}

// Comfortably above every amount this suite taps, so a cap rejection can only
// mean the faucet policy itself is wrong.
export const FAUCET_MAX = '1000.0'

export async function setupInstrument(): Promise<LiveFixture> {
  const suffix = uniqueSuffix()
  const admin = await allocateParty(`e2e-admin-${suffix}`)
  const instrumentId = `E2E-${suffix}`
  const ids = templateIds()

  const config: Config = {
    ledgerApiUrl: LEDGER_API_URL,
    // The sandbox authenticates nothing, but the client always sends the
    // header, so this only has to be non-empty.
    ledgerApiToken: 'placeholder',
    ledgerUserId: LEDGER_USER_ID,
    adminParty: admin,
    instrumentConfigTemplateId: ids.instrumentConfig,
    transferInstructionTemplateId: ids.transferInstruction,
    preapprovalTemplateId: ids.preapproval,
    lockedTokenTemplateId: ids.lockedToken,
    allocationTemplateId: ids.allocation,
    port: 0,
    shutdownTimeoutMs: 8_000,
  }
  const ledger = new HttpLedgerClient(config)

  await ledger.submitAndWait(
    [admin],
    [
      {
        templateId: ids.instrumentConfig,
        createArguments: {
          admin,
          instrumentId,
          name: 'End-to-end test instrument',
          symbol: 'E2E',
          // Int64 is a JSON string on this API; a bare number is rejected
          // with "Expected ujson.Str".
          decimals: '10',
          // Decimal is sent as plain decimal text: a JSON number is rendered
          // from a double first, and that rendering is exponential from 1e7 up,
          // which the Numeric parser rejects.
          faucet: { maxPerTap: FAUCET_MAX },
          meta: { values: {} },
        },
      },
    ],
  )

  const rows = await ledger.activeContracts(ids.instrumentConfig, admin)
  const row = rows.find((r) => (r.payload as InstrumentConfigPayload).instrumentId === instrumentId)
  if (!row) throw new Error(`InstrumentConfig ${instrumentId} is not active after creating it`)

  return {
    admin,
    instrumentId,
    configCid: row.contractId,
    ledger,
    config,
    app: createServer({ ledger, config }),
    ids,
  }
}
