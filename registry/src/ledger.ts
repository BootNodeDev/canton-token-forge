import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import type { DisclosedContract } from './disclose.js'
import { createLogger, type Logger } from './logger.js'

// The participant's answer to a party lookup. `isLocal` is what separates a
// party this participant hosts, and can therefore read as, from one it merely
// knows about.
export interface PartyDetails {
  party: string
  isLocal: boolean
}

// Carries the participant's status code, because a caller's response depends on
// which failure it was: an authorization refusal is a configuration fault, and
// anything else is the ledger being the ledger. The field is deliberately not
// named `status`: the terminal error handler answers a request with any status
// it finds on the error, and the participant's own status is never the one a
// client should be told (an expired ledger token is not the caller's 403).
export class LedgerRequestError extends Error {
  constructor(
    readonly ledgerStatus: number,
    message: string,
  ) {
    super(message)
    this.name = 'LedgerRequestError'
  }
}

export interface ContractEntry<P = unknown> {
  templateId: string
  contractId: string
  createdEventBlob: string
  synchronizerId: string
  payload: P
}

export interface CreateCommand {
  templateId: string
  createArguments: Record<string, unknown>
}

export interface ExerciseCommand {
  templateId: string
  contractId: string
  choice: string
  choiceArgument: Record<string, unknown>
}

export interface LedgerClient {
  activeContracts(templateId: string, party: string): Promise<ContractEntry[]>
  lookupByContractId(
    templateId: string,
    contractId: string,
    party: string,
  ): Promise<ContractEntry | undefined>
  // The cheapest round-trip the participant offers, and the only ledger call
  // whose cost does not move with what the admin is a stakeholder of. The
  // readiness probe uses it for that reason.
  ledgerEnd(): Promise<number>
  // The participant's view of a single party, used by the startup check. Its
  // cost does not move with the ledger, and unlike every other read here it can
  // tell a party the participant does not know from one that simply has no
  // contracts: the participant answers the first with an empty list rather than
  // an error.
  partyDetails(party: string): Promise<PartyDetails[]>
  // The service answers reads only: an instrument is registered by an admin
  // creating the contract directly, so no route submits and nothing calls this
  // today. It stays on the client because it encodes the participant's
  // submission rules (the nested envelope and the userId contract documented
  // below), which were established against a live node and cannot be recovered
  // from the API reference alone.
  submitAndWait(
    actAs: string[],
    commands: (CreateCommand | ExerciseCommand)[],
    disclosedContracts?: DisclosedContract[],
  ): Promise<unknown>
}

type FetchFn = typeof fetch

function isExerciseCommand(command: CreateCommand | ExerciseCommand): command is ExerciseCommand {
  return 'contractId' in command
}

// The response shapes below are as this service consumes them, verified
// against Canton 3.5.6; adjusting them here and in the mapping is the single
// place a live-node drift lands. Both reads carry the same created event, which
// is what lets one contract be resolved either way and mapped once.
interface CreatedEvent {
  templateId: string
  contractId: string
  createdEventBlob: string
  createArgument: unknown
}

// One row of /v2/state/active-contracts.
interface ActiveContractsRow {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: CreatedEvent
      synchronizerId: string
    }
  }
}

// /v2/events/events-by-contract-id answers with the contract's whole history,
// so `archived` is null while it is active and carries the archive event once
// it is not.
interface EventsByContractIdResponse {
  created?: {
    createdEvent: CreatedEvent
    synchronizerId: string
  }
  archived?: unknown
}

// The party-and-template filter both reads send. Requesting the created event
// blob is what makes a row disclosable to a counterparty later.
function templateFilter(templateId: string, party: string) {
  return {
    filtersByParty: {
      [party]: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: { templateId, includeCreatedEventBlob: true },
              },
            },
          },
        ],
      },
    },
  }
}

function toEntry(createdEvent: CreatedEvent, synchronizerId: string): ContractEntry {
  return {
    templateId: createdEvent.templateId,
    contractId: createdEvent.contractId,
    createdEventBlob: createdEvent.createdEventBlob,
    synchronizerId,
    payload: createdEvent.createArgument,
  }
}

export class HttpLedgerClient implements LedgerClient {
  constructor(
    private readonly config: Pick<Config, 'ledgerApiUrl' | 'ledgerApiToken' | 'ledgerUserId'>,
    private readonly fetchFn: FetchFn = fetch,
    private readonly logger: Logger = createLogger(),
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.ledgerApiToken}`,
    }
  }

  // An active-contract query is snapshotted at an offset, and offset 0 is the
  // beginning of the ledger, where nothing is active yet. Reading the current
  // end first is what makes the query return the live contract set.
  async ledgerEnd(): Promise<number> {
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/state/ledger-end`, {
      headers: this.headers(),
    })
    if (!res.ok) throw new LedgerRequestError(res.status, `ledger end query failed: ${res.status}`)
    return ((await res.json()) as { offset: number }).offset
  }

  // A party id contains characters (`::`, and whatever the hint carries) that
  // must survive the path segment, so it is encoded rather than interpolated.
  async partyDetails(party: string): Promise<PartyDetails[]> {
    const res = await this.fetchFn(
      `${this.config.ledgerApiUrl}/v2/parties/${encodeURIComponent(party)}`,
      { headers: this.headers() },
    )
    if (!res.ok) throw new LedgerRequestError(res.status, `party lookup failed: ${res.status}`)
    const body = (await res.json()) as { partyDetails?: PartyDetails[] }
    return (body.partyDetails ?? []).map(({ party, isLocal }) => ({ party, isLocal }))
  }

  async activeContracts(templateId: string, party: string): Promise<ContractEntry[]> {
    const activeAtOffset = await this.ledgerEnd()
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        filter: templateFilter(templateId, party),
        verbose: false,
        activeAtOffset,
      }),
    })
    if (!res.ok) throw new LedgerRequestError(res.status, `ledger query failed: ${res.status}`)
    const rows = (await res.json()) as ActiveContractsRow[]
    return rows.flatMap((r) => {
      const ac = r?.contractEntry?.JsActiveContract
      if (!ac) return []
      return [toEntry(ac.createdEvent, ac.synchronizerId)]
    })
  }

  async lookupByContractId(
    templateId: string,
    contractId: string,
    party: string,
  ): Promise<ContractEntry | undefined> {
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/events/events-by-contract-id`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        contractId,
        eventFormat: { ...templateFilter(templateId, party), verbose: false },
      }),
    })
    // A lookup misses in four ways, and the participant names each one: no such
    // contract, one this party cannot see and one of a different template all
    // answer 404 CONTRACT_EVENTS_NOT_FOUND, and an id it cannot parse answers
    // 400 naming the contract_id field. Every other failure is a fault of ours
    // or the ledger's and must not be reported to a caller as an absent
    // contract: the abort choice-contexts turn an absent escrow into a positive
    // report that its owner reclaimed it, and a request the participant would
    // not even process must not manufacture that report for an escrow that is
    // sitting right there. So both statuses are matched on what the participant
    // named, never on the status alone: a participant that does not serve this
    // endpoint answers a path-level 404, one that does not host the package or
    // the qualified name answers 404 too (PACKAGE_NAMES_NOT_FOUND,
    // NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME), and a party or event
    // format it refuses answers 400. All of those raise.
    //
    // Reading an unparseable id as a miss is safe in a way those are not: it
    // names no contract at all, so nothing of ours can be sitting behind it.
    // The routes screen a path parameter's characters but deliberately not its
    // length, so a client's truncated id arrives here, and raising it would
    // answer a client's own typo with a 500. The escrow lookups cannot reach
    // this branch against a live escrow, because the cid they pass was read out
    // of the ledger's own payload. Matching on the participant's wording fails
    // safe: if it is ever reworded, the id is raised again rather than silently
    // read as a miss.
    //
    // What none of this screens is a template id the participant does resolve
    // but that names a different template than the contract's. That comes back
    // as a genuine miss, and no answer to this request tells it apart from an
    // absent contract.
    if (res.status === 404 || res.status === 400) {
      const detail = await res.text()
      if (
        !detail.includes('CONTRACT_EVENTS_NOT_FOUND') &&
        !detail.includes('cannot parse ContractId')
      ) {
        this.logger.error(
          { status: res.status, templateId, contractId, detail },
          'contract lookup rejected',
        )
        throw new LedgerRequestError(res.status, `contract lookup rejected: ${res.status}`)
      }
      return undefined
    }
    if (!res.ok) throw new LedgerRequestError(res.status, `ledger query failed: ${res.status}`)
    const body = (await res.json()) as EventsByContractIdResponse
    // An archived contract is still answered with its created event, so the
    // archive event is the only thing separating it from a live one.
    if (!body.created || body.archived) return undefined
    return toEntry(body.created.createdEvent, body.created.synchronizerId)
  }

  // Every submission field lives inside a nested `commands` object; the
  // participant looks for them one level deep and rejects a flat body.
  //
  // `userId` names the ledger user the submission is made under, which the
  // participant normally defaults from the token's claims. It is sent only
  // when configured: an unauthenticated participant has no claims to default
  // from and requires it, while an authenticated one rejects a submission
  // claiming a user its token does not authorize.
  async submitAndWait(
    actAs: string[],
    commands: (CreateCommand | ExerciseCommand)[],
    disclosedContracts: DisclosedContract[] = [],
  ): Promise<unknown> {
    const res = await this.fetchFn(
      `${this.config.ledgerApiUrl}/v2/commands/submit-and-wait-for-transaction`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          commands: {
            commands: commands.map((command) =>
              isExerciseCommand(command)
                ? { ExerciseCommand: command }
                : { CreateCommand: command },
            ),
            actAs,
            commandId: randomUUID(),
            ...(this.config.ledgerUserId ? { userId: this.config.ledgerUserId } : {}),
            disclosedContracts,
          },
        }),
      },
    )
    if (!res.ok) {
      throw new LedgerRequestError(res.status, `ledger command submission failed: ${res.status}`)
    }
    return res.json()
  }
}
