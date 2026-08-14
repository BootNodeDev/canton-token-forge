import { describe, expect, it } from 'vitest'
import { HttpLedgerClient } from '../src/ledger'
import { recordingLogger } from './helpers/fixtures'

interface FakeResponse {
  ok: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

// Routes by path because a single client call now hits two endpoints: an
// active-contract query first reads the ledger end to snapshot at.
function recordingFetch(routes: Record<string, FakeResponse>) {
  const calls: [string, RequestInit][] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init])
    const res = routes[new URL(url).pathname]
    if (!res) throw new Error(`unexpected request to ${url}`)
    return { text: async () => '', ...res } as Response
  }) as typeof fetch
  return { fakeFetch, calls }
}

const LEDGER_END = '/v2/state/ledger-end'
const ACTIVE_CONTRACTS = '/v2/state/active-contracts'
const BY_CONTRACT_ID = '/v2/events/events-by-contract-id'
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

// The shape of a by-contract-id response, recorded from Canton 3.5.6: the
// created event and its synchronizer id sit under `created`, and `archived` is
// null for a contract that is still active.
const createdEventFor = (contractId: string) => ({
  created: {
    createdEvent: {
      templateId: 'pkg:Canton.TokenForge.Locked:LockedToken',
      contractId,
      createdEventBlob: 'BLOB-LOCK',
      createArgument: { amount: '10.0' },
    },
    synchronizerId: 'sync-1',
  },
  archived: null,
})

describe('HttpLedgerClient.lookupByContractId', () => {
  it('resolves one contract by id without querying an active set', async () => {
    const { fakeFetch, calls } = recordingFetch({
      [BY_CONTRACT_ID]: { ok: true, json: async () => createdEventFor('00locked') },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    const entry = await client.lookupByContractId(
      'pkg:Canton.TokenForge.Locked:LockedToken',
      '00locked',
      'admin::1',
    )

    expect(entry).toMatchObject({
      contractId: '00locked',
      createdEventBlob: 'BLOB-LOCK',
      synchronizerId: 'sync-1',
      payload: { amount: '10.0' },
    })

    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([BY_CONTRACT_ID])
    const [url, init] = calls[0]
    expect(url).toBe('http://ledger/v2/events/events-by-contract-id')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.contractId).toBe('00locked')
    // The participant matches the template itself and 404s a mismatch, which
    // is what spares the service comparing a package-id-qualified templateId
    // from the response against its package-name-qualified configuration.
    expect(
      body.eventFormat.filtersByParty['admin::1'].cumulative[0].identifierFilter.TemplateFilter
        .value,
    ).toMatchObject({
      templateId: 'pkg:Canton.TokenForge.Locked:LockedToken',
      includeCreatedEventBlob: true,
    })
  })

  // The participant answers one 404 (CONTRACT_EVENTS_NOT_FOUND) for all three
  // of: no such contract, a contract this party cannot see, and a contract of
  // a different template. Each is "not found" to the caller.
  it('returns undefined when the participant reports no such contract', async () => {
    const { fakeFetch } = recordingFetch({
      [BY_CONTRACT_ID]: {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ code: 'CONTRACT_EVENTS_NOT_FOUND' }),
      },
    })
    const { logger, entries } = recordingLogger()
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
      logger,
    )

    await expect(
      client.lookupByContractId('pkg:M:T', '00gone', 'admin::1'),
    ).resolves.toBeUndefined()
    // A miss is the routine answer on these routes, so it must stay silent:
    // logging it would bury the rejections below in traffic a caller controls.
    expect(entries).toEqual([])
  })

  // The service cannot tell this apart from a missing contract by status alone,
  // and answering "not found" forever with nothing in the log is what made the
  // whole class invisible: a participant that does not serve this endpoint
  // returns a path-level 404, and a rejected event format or party returns 400.
  it('logs a rejection that is not the participant reporting a missing contract', async () => {
    const { fakeFetch } = recordingFetch({
      [BY_CONTRACT_ID]: {
        ok: false,
        status: 404,
        text: async () => '<html><body>404 Not Found</body></html>',
      },
    })
    const { logger, entries } = recordingLogger()
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
      logger,
    )

    await expect(
      client.lookupByContractId('pkg:M:T', '00locked', 'admin::1'),
    ).resolves.toBeUndefined()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      status: 404,
      templateId: 'pkg:M:T',
      contractId: '00locked',
      detail: '<html><body>404 Not Found</body></html>',
    })
  })

  // A ledger outage must not read as "no such contract": that would turn a
  // 503 into a 404 on every route that resolves a path parameter this way.
  it('throws when the ledger is unreachable', async () => {
    const { fakeFetch } = recordingFetch({
      [BY_CONTRACT_ID]: { ok: false, status: 503, json: async () => ({}) },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await expect(client.lookupByContractId('pkg:M:T', '00locked', 'admin::1')).rejects.toThrow(
      /503/,
    )
  })

  // A contract id the participant cannot parse comes back 400 INVALID_FIELD.
  // It is still a path parameter naming no contract, and the routes answer
  // their own "not found" for it, as they did when this was an in-memory scan.
  it('returns undefined when the participant rejects the contract id as unparseable', async () => {
    const { fakeFetch } = recordingFetch({
      [BY_CONTRACT_ID]: {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ code: 'INVALID_FIELD' }),
      },
    })
    const { logger, entries } = recordingLogger()
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
      logger,
    )

    await expect(
      client.lookupByContractId('pkg:M:T', 'not-a-cid', 'admin::1'),
    ).resolves.toBeUndefined()
    // A 400 is logged with the rest: telling a malformed contract id apart from
    // an event format the participant refuses needs the message text, which no
    // run against a live participant has pinned down.
    expect(entries).toHaveLength(1)
  })

  // An archived contract still answers 200 with its created event; only
  // `archived` distinguishes it. Returning it would disclose a dead contract
  // and push the failure to the on-ledger submission, where the active-set
  // scan this replaced simply never saw it.
  it('returns undefined for a contract that has been archived', async () => {
    const { fakeFetch } = recordingFetch({
      [BY_CONTRACT_ID]: {
        ok: true,
        json: async () => ({
          ...createdEventFor('00locked'),
          archived: { archivedEvent: { contractId: '00locked', offset: 21 } },
        }),
      },
    })
    const client = new HttpLedgerClient(
      { ledgerApiUrl: 'http://ledger', ledgerApiToken: 't' },
      fakeFetch,
    )

    await expect(
      client.lookupByContractId('pkg:Canton.TokenForge.Locked:LockedToken', '00locked', 'admin::1'),
    ).resolves.toBeUndefined()
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
          createArguments: { instrumentId: 'CC' },
        },
        {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          contractId: '00abc',
          choice: 'InstrumentConfig_Mint',
          choiceArgument: { recipient: 'alice::1', amount: '42.0' },
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
          createArguments: { instrumentId: 'CC' },
        },
      },
      {
        ExerciseCommand: {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          contractId: '00abc',
          choice: 'InstrumentConfig_Mint',
          choiceArgument: { recipient: 'alice::1', amount: '42.0' },
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
        templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
        contractId: 'cfg1',
        createdEventBlob: 'BLOB-CFG',
        synchronizerId: 'sync-1',
      },
    ]

    await client.submitAndWait(
      ['admin::1'],
      [
        {
          templateId: 'pkg:Canton.TokenForge.Registry:InstrumentConfig',
          contractId: 'cfg1',
          choice: 'InstrumentConfig_Mint',
          choiceArgument: { recipient: 'alice::1', amount: '42.0' },
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
