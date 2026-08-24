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
//
// `detail` is the participant's own response body, kept for the same reason and
// held to the same rule: it names which error the participant raised, which one
// status can stand for several of, but it is its wording and not ours, so it
// stays off `message`, which the terminal handler does answer the client with.
export class LedgerRequestError extends Error {
  constructor(
    readonly ledgerStatus: number,
    message: string,
    readonly detail?: string,
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

// What a by-id lookup found. The escrow lookup needs the archived case kept
// apart from the absent one: the abort choice-contexts turn a reclaimed escrow
// into a positive report to the choice, and only an archive event is evidence
// of a reclaim. Collapsing the two is what let a template id naming another
// real template manufacture that report for an escrow still sitting on the
// ledger. Callers that only need to know whether a contract is servable
// collapse it back themselves.
export type ContractLookup<P = unknown> =
  | { state: 'live'; entry: ContractEntry<P> }
  | { state: 'archived' }
  | { state: 'absent' }

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
    clientSuppliedId?: boolean,
  ): Promise<ContractLookup>
  // The cheapest round-trip the participant offers, and the only ledger call
  // whose cost does not move with what the admin is a stakeholder of. The
  // readiness probe uses it for that reason.
  ledgerEnd(): Promise<number>
  // Put a configured template id to the participant and read nothing back,
  // used by the startup check. A template the participant hosts but that has no
  // contracts answers as one that has thousands, so only the failure carries
  // meaning, and the query is shaped to transfer no contract either way: a
  // check that downloaded five active sets to discard them would cost the boot
  // whatever the admin happens to be a stakeholder of.
  probeTemplate(templateId: string, party: string): Promise<void>
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
  archived?: { archivedEvent?: unknown } | null
}

// The party-and-template filter every read sends. Requesting the created event
// blob is what makes a row disclosable to a counterparty later, so both reads
// ask for it; only the startup probe, which returns no rows at all, does not.
function templateFilter(templateId: string, party: string, includeCreatedEventBlob = true) {
  return {
    filtersByParty: {
      [party]: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: { templateId, includeCreatedEventBlob },
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

  private async queryActiveContracts(
    templateId: string,
    party: string,
    activeAtOffset: number,
    includeCreatedEventBlob: boolean,
  ): Promise<Response> {
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        filter: templateFilter(templateId, party, includeCreatedEventBlob),
        verbose: false,
        activeAtOffset,
      }),
    })
    // The body carries the participant's error code, and a template id it
    // cannot resolve is only distinguishable from any other 404 by that code,
    // which is what the startup check reads to attribute the fault to one
    // configured variable.
    if (!res.ok) {
      // Read before constructing, and never let the read fail the throw: a body
      // that breaks mid-stream would otherwise propagate its own error in place
      // of this one, and both callers classify on this type. Losing it turns an
      // authorization refusal and an unresolvable template id alike from fatal
      // into a warning, which is the direction these checks exist to close.
      const detail = await res.text().catch(() => undefined)
      throw new LedgerRequestError(res.status, `ledger query failed: ${res.status}`, detail)
    }
    return res
  }

  async activeContracts(templateId: string, party: string): Promise<ContractEntry[]> {
    const activeAtOffset = await this.ledgerEnd()
    const res = await this.queryActiveContracts(templateId, party, activeAtOffset, true)
    const rows = (await res.json()) as ActiveContractsRow[]
    return rows.flatMap((r) => {
      const ac = r?.contractEntry?.JsActiveContract
      if (!ac) return []
      return [toEntry(ac.createdEvent, ac.synchronizerId)]
    })
  }

  // Offset 0 is the beginning of the ledger, where no contract is active yet,
  // so the participant answers an empty set however many the template holds:
  // the id is resolved without a single contract crossing the wire, and the
  // ledger end this query would otherwise be snapshotted at is not read either.
  // The blob is left out for the same reason, being the bulk of a row's bytes.
  // Verified on Canton 3.5.12: an id naming a package, module or entity the
  // participant does not host is refused at offset 0 with the same code and
  // status as at the ledger end, because the filter is resolved before the
  // offset is consulted.
  async probeTemplate(templateId: string, party: string): Promise<void> {
    const res = await this.queryActiveContracts(templateId, party, 0, false)
    // The empty set still has to be consumed: an unread body holds its socket
    // open until the collector gets to it, and the point of this call is to
    // cost the boot nothing. A body that cannot be read changes no verdict,
    // since the participant already answered that it resolves the id.
    await res.text().catch(() => undefined)
  }

  async lookupByContractId(
    templateId: string,
    contractId: string,
    party: string,
    clientSuppliedId = false,
  ): Promise<ContractLookup> {
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
    // contract: absence is a claim about the ledger, and a request the
    // participant would not even process supports no such claim, so answering
    // one hands the routes a verdict on a contract that may be sitting right
    // there. So both statuses are matched on what the participant
    // named, never on the status alone: a participant that does not serve this
    // endpoint answers a path-level 404, one that does not host the package or
    // the qualified name answers 404 too (PACKAGE_NAMES_NOT_FOUND,
    // NO_TEMPLATES_FOR_PACKAGE_NAME_AND_QUALIFIED_NAME), and a party or event
    // format it refuses answers 400. All of those raise.
    //
    // Reading an unparseable id as a miss is safe only for an id a client
    // supplied, which is why the caller has to say so. Such an id names no
    // contract at all, so nothing of ours can be sitting behind it, and the
    // routes screen a path parameter's characters but deliberately not its
    // length, so a truncated id arrives here and raising it would answer a
    // client's own typo with a 500. An id the service sourced is the opposite
    // case: the only one is the escrow lookup, which reads the cid out of a
    // record's payload, and an unparseable payload field means the payload is
    // not the shape it was cast to. Reading a fault of ours as a miss would
    // answer for the ledger on an escrow that may still be live, so it raises.
    // Matching on the participant's wording fails safe either way: if it is
    // ever reworded, the id is raised again rather than read as a miss.
    //
    // What none of this screens is a template id the participant does resolve
    // but that names a different template than the contract's. That comes back
    // as a genuine miss, and no answer to this request tells it apart from an
    // absent contract.
    if (res.status === 404 || res.status === 400) {
      const detail = await res.text()
      if (
        !detail.includes('CONTRACT_EVENTS_NOT_FOUND') &&
        !(clientSuppliedId && detail.includes('cannot parse ContractId'))
      ) {
        // Warn, not error: the request is answered 500 and the terminal error
        // handler logs that, so this is the detail behind that line rather than
        // a second alarm for the same fault. It carries the participant's own
        // wording, which is the only thing that names which configured template
        // id or which party the fault is in, and which never reaches the client.
        this.logger.warn(
          { status: res.status, templateId, contractId, detail },
          'contract lookup rejected',
        )
        throw new LedgerRequestError(res.status, `contract lookup rejected: ${res.status}`)
      }
      return { state: 'absent' }
    }
    if (!res.ok) throw new LedgerRequestError(res.status, `ledger query failed: ${res.status}`)
    const body = (await res.json()) as EventsByContractIdResponse
    // An archived contract is still answered with its created event, so the
    // archive event is the only thing separating it from a live one. Verified
    // on Canton 3.5.12: `archived` is null on a live contract and holds the
    // event under `archivedEvent` on an archived one, and the template filter
    // is applied to both alike, so a contract of another template is refused
    // above rather than answered here. That is what makes the archive event
    // evidence about the configured template without comparing a
    // package-id-qualified id from the response against a configuration that
    // names the package. The test is on the event and not on the field around
    // it because this answer is the sole authority for a reclaim report: were
    // that field ever filled with something else for a live contract, a bare
    // presence check would report every live escrow reclaimed.
    if (!body.created) return { state: 'absent' }
    if (body.archived?.archivedEvent) return { state: 'archived' }
    return { state: 'live', entry: toEntry(body.created.createdEvent, body.created.synchronizerId) }
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
