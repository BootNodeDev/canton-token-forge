import { describe, expect, it } from 'vitest'
import { HttpLedgerClient } from '../src/ledger'

function recordingFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  const calls: [string, RequestInit][] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init])
    return response as Response
  }) as typeof fetch
  return { fakeFetch, calls }
}

describe('HttpLedgerClient.activeContracts', () => {
  it('maps JSON Ledger API entries to ContractEntry', async () => {
    const { fakeFetch, calls } = recordingFetch({
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
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )
    const rows = await client.activeContracts(
      'pkg:Canton.TokenForge.Registry:InstrumentConfig',
      'operator::1',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      contractId: '00abc',
      createdEventBlob: 'BLOB==',
      synchronizerId: 'sync-1',
      payload: { id: 'CC' },
    })

    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]
    expect(url).toBe('http://ledger/v2/state/active-contracts')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(
      body.filter.filtersByParty['operator::1'].cumulative[0].identifierFilter.TemplateFilter.value
        .templateId,
    ).toBe('pkg:Canton.TokenForge.Registry:InstrumentConfig')
  })
})

describe('HttpLedgerClient.submitAndWait', () => {
  it('submits create/exercise commands as actAs and returns the response', async () => {
    const { fakeFetch, calls } = recordingFetch({
      ok: true,
      json: async () => ({ transactionId: 'tx-1' }),
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    const result = await client.submitAndWait(
      ['operator::1'],
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
    const body = JSON.parse(init.body as string)
    expect(body.actAs).toEqual(['operator::1'])
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
      ok: true,
      json: async () => ({ transactionId: 'tx-2' }),
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
    const body = JSON.parse(init.body as string)
    expect(body.disclosedContracts).toEqual(disclosedContracts)
  })

  it('throws when the ledger responds with a non-ok status', async () => {
    const { fakeFetch } = recordingFetch({
      ok: false,
      status: 400,
      json: async () => ({}),
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await expect(
      client.submitAndWait(['operator::1'], [{ templateId: 'T', createArguments: {} }]),
    ).rejects.toThrow(/400/)
  })
})
