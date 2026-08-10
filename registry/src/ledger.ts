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

// Shape of one row of the /v2/state/active-contracts response as this service
// consumes it, verified against Canton 3.5.6. Adjusting it here and in the
// mapping below is the single place a live-node drift lands.
interface ActiveContractsRow {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: {
        templateId: string
        contractId: string
        createdEventBlob: string
        createArgument: unknown
      }
      synchronizerId: string
    }
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
  private async ledgerEnd(): Promise<number> {
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
        filter: {
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
        },
        verbose: false,
        activeAtOffset,
      }),
    })
    if (!res.ok) throw new Error(`ledger query failed: ${res.status}`)
    const rows = (await res.json()) as ActiveContractsRow[]
    return rows.flatMap((r) => {
      const ac = r?.contractEntry?.JsActiveContract
      if (!ac) return []
      return [
        {
          templateId: ac.createdEvent.templateId,
          contractId: ac.createdEvent.contractId,
          createdEventBlob: ac.createdEvent.createdEventBlob,
          synchronizerId: ac.synchronizerId,
          payload: ac.createdEvent.createArgument,
        },
      ]
    })
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
