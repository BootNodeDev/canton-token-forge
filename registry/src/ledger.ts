import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { DisclosedContract } from "./disclose.js";

export interface ContractEntry {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
  payload: any;
}

export interface CreateCommand {
  templateId: string;
  createArguments: any;
}

export interface ExerciseCommand {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: any;
}

export interface LedgerClient {
  activeContracts(templateOrInterfaceId: string, party: string): Promise<ContractEntry[]>;
  submitAndWait(
    actAs: string[],
    commands: (CreateCommand | ExerciseCommand)[],
    disclosedContracts?: DisclosedContract[],
  ): Promise<any>;
}

type FetchFn = typeof fetch;

function isExerciseCommand(command: CreateCommand | ExerciseCommand): command is ExerciseCommand {
  return "contractId" in command;
}

export class HttpLedgerClient implements LedgerClient {
  constructor(
    private readonly config: Pick<Config, "ledgerApiUrl" | "ledgerApiToken">,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async activeContracts(templateOrInterfaceId: string, party: string): Promise<ContractEntry[]> {
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/state/active-contracts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.ledgerApiToken}`,
      },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: { templateId: templateOrInterfaceId, includeCreatedEventBlob: true },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: false,
        activeAtOffset: 0,
      }),
    });
    if (!res.ok) throw new Error(`ledger query failed: ${res.status}`);
    const rows = (await res.json()) as any[];
    return rows
      .map((r) => r?.contractEntry?.JsActiveContract)
      .filter(Boolean)
      .map((ac) => ({
        templateId: ac.createdEvent.templateId,
        contractId: ac.createdEvent.contractId,
        createdEventBlob: ac.createdEvent.createdEventBlob,
        synchronizerId: ac.synchronizerId,
        payload: ac.createdEvent.createArgument,
      }));
  }

  // The disclosedContracts placement in this envelope (a top-level sibling of
  // commands/actAs) is UNVERIFIED against a live node, same class of
  // deferral as the rest of this JSON command envelope.
  async submitAndWait(
    actAs: string[],
    commands: (CreateCommand | ExerciseCommand)[],
    disclosedContracts: DisclosedContract[] = [],
  ): Promise<any> {
    const res = await this.fetchFn(`${this.config.ledgerApiUrl}/v2/commands/submit-and-wait-for-transaction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.ledgerApiToken}`,
      },
      body: JSON.stringify({
        commands: commands.map((command) =>
          isExerciseCommand(command) ? { ExerciseCommand: command } : { CreateCommand: command },
        ),
        actAs,
        commandId: randomUUID(),
        disclosedContracts,
      }),
    });
    if (!res.ok) throw new Error(`ledger command submission failed: ${res.status}`);
    return res.json();
  }
}
