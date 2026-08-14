import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import type { DisclosedContract } from './disclose.js'

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
    if (!res.ok) throw new Error(`ledger end query failed: ${res.status}`)
    return ((await res.json()) as { offset: number }).offset
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
    if (!res.ok) throw new Error(`ledger query failed: ${res.status}`)
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
    // 404 covers all three ways a lookup misses: no such contract, one this
    // party cannot see, and one of a different template. 400 is a contract id
    // the participant cannot parse. Every other failure is the ledger's, and
    // must not be reported to a caller as an absent contract.
    if (res.status === 404 || res.status === 400) return undefined
    if (!res.ok) throw new Error(`ledger query failed: ${res.status}`)
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
    if (!res.ok) throw new Error(`ledger command submission failed: ${res.status}`)
    return res.json()
  }
}
