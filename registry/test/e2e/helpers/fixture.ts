import type { Express } from 'express'
import request from 'supertest'
import type { Config } from '../../../src/config'
import type { DisclosedContract } from '../../../src/disclose'
import { toDisclosed } from '../../../src/disclose'
import type { ContractEntry } from '../../../src/ledger'
import { HttpLedgerClient } from '../../../src/ledger'
import type {
  InstrumentConfigPayload,
  PreapprovalPayload,
  TransferInstructionPayload,
} from '../../../src/payloads'
import { createServer } from '../../../src/server'
import {
  allocateParty,
  LEDGER_API_URL,
  LEDGER_USER_ID,
  TRANSFER_FACTORY_INTERFACE_ID,
  TRANSFER_INSTRUCTION_INTERFACE_ID,
  templateIds,
  uniqueSuffix,
} from './sandbox'

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

// The service never reads a Token, so its payload shape is not declared in
// src/payloads.ts. This suite reads holdings to assert outcomes, so it
// declares the fields it asserts on.
export interface TokenPayload {
  admin: string
  owner: string
  instrumentId: string
  amount: string
}

export async function configEntry(fx: LiveFixture): Promise<ContractEntry> {
  const rows = await fx.ledger.activeContracts(fx.ids.instrumentConfig, fx.admin)
  const row = rows.find((r) => r.contractId === fx.configCid)
  if (!row) throw new Error('the run InstrumentConfig is no longer active')
  return row
}

export async function holdingsOf(
  fx: LiveFixture,
  owner: string,
): Promise<ContractEntry<TokenPayload>[]> {
  const rows = (await fx.ledger.activeContracts(
    fx.ids.token,
    owner,
  )) as ContractEntry<TokenPayload>[]
  return rows.filter((r) => r.payload.instrumentId === fx.instrumentId)
}

// The tapping party is not a stakeholder of the config, so the config has to
// be disclosed to it. Which holding the tap created is derived by difference
// rather than read out of the transaction, so the helper does not depend on
// where a given Canton version puts a create result in the envelope.
export async function tapFaucet(fx: LiveFixture, user: string, amount: string): Promise<string> {
  const before = new Set((await holdingsOf(fx, user)).map((h) => h.contractId))
  const cfg = await configEntry(fx)

  await fx.ledger.submitAndWait(
    [user],
    [
      {
        templateId: fx.ids.instrumentConfig,
        contractId: fx.configCid,
        choice: 'InstrumentConfig_Tap',
        choiceArgument: { user, amount },
      },
    ],
    [toDisclosed(cfg)],
  )

  const created = (await holdingsOf(fx, user)).filter((h) => !before.has(h.contractId))
  if (created.length !== 1) {
    throw new Error(`expected one new holding for ${user} after the tap, got ${created.length}`)
  }
  return created[0].contractId
}

// An hour of slack either side of now. The sandbox runs on wall clock, so a
// window that closes mid-run would turn a wire question into a flake.
const WINDOW_MS = 60 * 60 * 1000

// The receiver opts in on its own and is not a stakeholder of the config, so
// the config has to be disclosed to it, exactly as the faucet does for a
// tapping party.
export async function preapprove(fx: LiveFixture, receiver: string): Promise<string> {
  const now = Date.now()
  const cfg = await configEntry(fx)
  await fx.ledger.submitAndWait(
    [receiver],
    [
      {
        templateId: fx.ids.instrumentConfig,
        contractId: fx.configCid,
        choice: 'InstrumentConfig_Preapprove',
        choiceArgument: {
          receiver,
          validFrom: new Date(now - WINDOW_MS).toISOString(),
          expiresAt: new Date(now + WINDOW_MS).toISOString(),
        },
      },
    ],
    [toDisclosed(cfg)],
  )

  const rows = (await fx.ledger.activeContracts(
    fx.ids.preapproval,
    fx.admin,
  )) as ContractEntry<PreapprovalPayload>[]
  const row = rows.find(
    (r) => r.payload.receiver === receiver && r.payload.instrumentId === fx.instrumentId,
  )
  if (!row) throw new Error(`no preapproval on the ledger for ${receiver}`)
  return row.contractId
}

export interface FactoryResponse {
  factoryId: string
  transferKind: string
  choiceContext: {
    choiceContextData: Record<string, unknown>
    disclosedContracts: DisclosedContract[]
  }
}

// The service's context and disclosures are forwarded untouched. Rebuilding
// either from what this suite already knows would make the test check its own
// encoder instead of the service's.
export async function submitTransfer(
  fx: LiveFixture,
  factory: FactoryResponse,
  transfer: { sender: string; receiver: string; amount: string; inputHoldingCids: string[] },
): Promise<unknown> {
  const now = Date.now()
  return fx.ledger.submitAndWait(
    [transfer.sender],
    [
      {
        templateId: TRANSFER_FACTORY_INTERFACE_ID,
        contractId: factory.factoryId,
        choice: 'TransferFactory_Transfer',
        choiceArgument: {
          expectedAdmin: fx.admin,
          transfer: {
            sender: transfer.sender,
            receiver: transfer.receiver,
            amount: transfer.amount,
            instrumentId: { admin: fx.admin, id: fx.instrumentId },
            requestedAt: new Date(now - WINDOW_MS).toISOString(),
            executeBefore: new Date(now + WINDOW_MS).toISOString(),
            inputHoldingCids: transfer.inputHoldingCids,
            meta: { values: {} },
          },
          extraArgs: {
            context: { values: factory.choiceContext.choiceContextData },
            meta: { values: {} },
          },
        },
      },
    ],
    factory.choiceContext.disclosedContracts,
  )
}

export async function requestTransferFactory(fx: LiveFixture, sender: string, receiver: string) {
  return request(fx.app)
    .post('/registry/transfer-instruction/v1/transfer-factory')
    .send({
      choiceArguments: {
        transfer: { instrumentId: { admin: fx.admin, id: fx.instrumentId }, sender, receiver },
      },
    })
}

// The service never reads a LockedToken's amount, so it is not declared in
// src/payloads.ts. This suite asserts on it, so it declares the field here.
export interface LockedPayload {
  admin: string
  owner: string
  instrumentId: string
  amount: string
}

// Taps, requests the factory, submits, then reads back the pending
// instruction and its escrow. Both tests on this path need the same state, and
// building it per test keeps them independent of each other's ordering.
export async function createOfferInstruction(
  fx: LiveFixture,
  sender: string,
  receiver: string,
  amount: string,
): Promise<{ instructionCid: string; escrowCid: string }> {
  const inputCid = await tapFaucet(fx, sender, '100.0')
  const factory = (await requestTransferFactory(fx, sender, receiver)).body as FactoryResponse
  if (factory.transferKind !== 'offer') {
    throw new Error(`expected an offer transfer for ${receiver}, got ${factory.transferKind}`)
  }

  await submitTransfer(fx, factory, {
    sender,
    receiver,
    amount,
    inputHoldingCids: [inputCid],
  })

  const instructions = (await fx.ledger.activeContracts(
    fx.ids.transferInstruction,
    fx.admin,
  )) as ContractEntry<TransferInstructionPayload>[]
  const instruction = instructions.find(
    (i) => i.payload.transfer.sender === sender && i.payload.transfer.receiver === receiver,
  )
  if (!instruction) throw new Error(`no pending instruction from ${sender} to ${receiver}`)

  return { instructionCid: instruction.contractId, escrowCid: instruction.payload.lockedCid }
}

// Every TransferInstruction choice takes only extraArgs, so one helper covers
// accept, reject and withdraw. The service's context and disclosures go
// through untouched for the same reason submitTransfer forwards them.
export async function submitInstructionChoice(
  fx: LiveFixture,
  instructionCid: string,
  choice: string,
  actor: string,
  choiceContext: {
    choiceContextData: Record<string, unknown>
    disclosedContracts: DisclosedContract[]
  },
): Promise<unknown> {
  return fx.ledger.submitAndWait(
    [actor],
    [
      {
        templateId: TRANSFER_INSTRUCTION_INTERFACE_ID,
        contractId: instructionCid,
        choice,
        choiceArgument: {
          extraArgs: {
            context: { values: choiceContext.choiceContextData },
            meta: { values: {} },
          },
        },
      },
    ],
    choiceContext.disclosedContracts,
  )
}
