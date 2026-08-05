import { describe, expect, it } from 'vitest'
import { HttpLedgerClient } from '../src/ledger'

interface FakeResponse {
  ok: boolean
  status?: number
  json?: () => Promise<unknown>
}

// Routes by path because a single client call now hits two endpoints: an
// active-contract query first reads the ledger end to snapshot at.
function recordingFetch(routes: Record<string, FakeResponse>) {
  const calls: [string, RequestInit][] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init])
    const res = routes[new URL(url).pathname]
    if (!res) throw new Error(`unexpected request to ${url}`)
    return res as Response
  }) as typeof fetch
  return { fakeFetch, calls }
}

const LEDGER_END = '/v2/state/ledger-end'
const ACTIVE_CONTRACTS = '/v2/state/active-contracts'
const SUBMIT = '/v2/commands/submit-and-wait-for-transaction'

const ledgerEndAt = (offset: number): FakeResponse => ({
  ok: true,
  json: async () => ({ offset }),
})

describe('HttpLedgerClient.activeContracts', () => {
  it('maps JSON Ledger API entries to ContractEntry', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [LEDGER_END]: ledgerEndAt(7),
      [ACTIVE_CONTRACTS]: {
        ok: true,
        json: async () => [
          {
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
                  contractId: '00abc',
                  createdEventBlob: 'BLOB==',
                  createArgument: { id: 'CC' },
                },
                synchronizerId: 'sync-1',
              },
            },
          },
        ],
      },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )
    const rows = await client.activeContracts(
      'pkg:Canton.TokenForge.Registry:InstrumentConfig',
      'admin::1',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      contractId: '00abc',
      createdEventBlob: 'BLOB==',
      synchronizerId: 'sync-1',
      payload: { id: 'CC' },
    })

    const query = calls.find(([url]) => url.endsWith(ACTIVE_CONTRACTS))
    if (!query) throw new Error('no active-contracts request was made')
    const [url, init] = query
    expect(url).toBe('http://ledger/v2/state/active-contracts')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(
      body.filter.filtersByParty['admin::1'].cumulative[0].identifierFilter.TemplateFilter.value
        .templateId,
    ).toBe('pkg:Canton.TokenForge.Registry:InstrumentConfig')
  })

  it('snapshots the active contract set at the current ledger end', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [LEDGER_END]: ledgerEndAt(4711),
      [ACTIVE_CONTRACTS]: { ok: true, json: async () => [] },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await client.activeContracts('pkg:M:InstrumentConfig', 'admin::1')

    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([LEDGER_END, ACTIVE_CONTRACTS])
    const [, init] = calls[1]
    expect(JSON.parse(init.body as string).activeAtOffset).toBe(4711)
  })

  it('throws when the ledger end cannot be read', async () => {
    const { fakeFetch } = recordingFetch({
      [LEDGER_END]: { ok: false, status: 503, json: async () => ({}) },
      [ACTIVE_CONTRACTS]: { ok: true, json: async () => [] },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await expect(client.activeContracts('pkg:M:InstrumentConfig', 'admin::1')).rejects.toThrow(
      /503/,
    )
  })
})

describe('HttpLedgerClient.submitAndWait', () => {
  it('submits create/exercise commands as actAs and returns the response', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [SUBMIT]: { ok: true, json: async () => ({ transactionId: 'tx-1' }) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    const result = await client.submitAndWait(
      ['admin::1'],
      [
        {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          createArguments: { id: 'CC' },
        },
        {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          contractId: '00abc',
          choice: 'InstrumentConfig_Archive',
          choiceArgument: {},
        },
      ],
    )

    expect(result).toEqual({ transactionId: 'tx-1' })
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]
    expect(url).toBe('http://ledger/v2/commands/submit-and-wait-for-transaction')
    expect(init.method).toBe('POST')
    // The participant reads every submission field one level deep, inside a
    // `commands` object; a flat body loses all of them.
    const body = JSON.parse(init.body as string).commands
    expect(body.actAs).toEqual(['admin::1'])
    expect(typeof body.commandId).toBe('string')
    expect(body.commands).toEqual([
      {
        CreateCommand: {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          createArguments: { id: 'CC' },
        },
      },
      {
        ExerciseCommand: {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          contractId: '00abc',
          choice: 'InstrumentConfig_Archive',
          choiceArgument: {},
        },
      },
    ])
    expect(body.disclosedContracts).toEqual([])
  })

  it('carries a provided disclosedContracts array in the submit request body', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [SUBMIT]: { ok: true, json: async () => ({ transactionId: 'tx-2' }) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    const disclosedContracts = [
      {
        templateId: 'pkg:Canton.TokenForge.Registry:TokenRegistry',
        contractId: 'reg1',
        createdEventBlob: 'BLOB-REG',
        synchronizerId: 'sync-1',
      },
    ]

    await client.submitAndWait(
      ['admin::1'],
      [
        {
          templateId: 'pkg:Canton.TokenForge.Registry:TokenRegistry',
          contractId: 'reg1',
          choice: 'TokenRegistry_ProposeInstrument',
          choiceArgument: {},
        },
      ],
      disclosedContracts,
    )

    expect(calls).toHaveLength(1)
    const [, init] = calls[0]
    const body = JSON.parse(init.body as string).commands
    expect(body.disclosedContracts).toEqual(disclosedContracts)
  })

  it('sends the configured ledger user id', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [SUBMIT]: { ok: true, json: async () => ({}) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't', ledgerUserId: 'registry-service' },
      fakeFetch,
    )

    await client.submitAndWait(['admin::1'], [{ templateId: 'T', createArguments: {} }])

    const [, init] = calls[0]
    expect(JSON.parse(init.body as string).commands.userId).toBe('registry-service')
  })

  // With authentication on, the participant derives the user id from the
  // token's claims and rejects a submission that claims a different one, so an
  // unset LEDGER_USER_ID must leave the field out rather than guess a value.
  it('omits the user id when none is configured', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [SUBMIT]: { ok: true, json: async () => ({}) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await client.submitAndWait(['admin::1'], [{ templateId: 'T', createArguments: {} }])

    const [, init] = calls[0]
    expect(JSON.parse(init.body as string).commands).not.toHaveProperty('userId')
  })

  it('throws when the ledger responds with a non-ok status', async () => {
    const { fakeFetch } = recordingFetch({
      [SUBMIT]: { ok: false, status: 400, json: async () => ({}) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await expect(
      client.submitAndWait(['admin::1'], [{ templateId: 'T', createArguments: {} }]),
    ).rejects.toThrow(/400/)
  })
})
