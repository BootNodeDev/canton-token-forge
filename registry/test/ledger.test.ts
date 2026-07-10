import { describe, it, expect, vi } from "vitest";
import { HttpLedgerClient } from "../src/ledger";

describe("HttpLedgerClient.activeContracts", () => {
  it("maps JSON Ledger API entries to ContractEntry", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: {
                templateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
                contractId: "00abc",
                createdEventBlob: "BLOB==",
                createArgument: { id: "CC" },
              },
              synchronizerId: "sync-1",
            },
          },
        },
      ],
    })) as any;
    const client = new HttpLedgerClient(
      { ledgerApiUrl: "http://ledger", ledgerApiToken: "t" } as any,
      fakeFetch,
    );
    const rows = await client.activeContracts(
      "pkg:Canton.TokenForge.Registry:InstrumentConfig",
      "operator::1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contractId: "00abc",
      createdEventBlob: "BLOB==",
      synchronizerId: "sync-1",
      payload: { id: "CC" },
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe("http://ledger/v2/state/active-contracts");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.filter.filtersByParty["operator::1"].cumulative[0].identifierFilter.TemplateFilter.value.templateId).toBe(
      "pkg:Canton.TokenForge.Registry:InstrumentConfig",
    );
  });
});

describe("HttpLedgerClient.submitAndWait", () => {
  it("submits create/exercise commands as actAs and returns the response", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ transactionId: "tx-1" }),
    })) as any;
    const client = new HttpLedgerClient(
      { ledgerApiUrl: "http://ledger", ledgerApiToken: "t" } as any,
      fakeFetch,
    );

    const result = await client.submitAndWait(["operator::1"], [
      {
        templateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
        createArguments: { id: "CC" },
      },
      {
        templateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
        contractId: "00abc",
        choice: "InstrumentConfig_Archive",
        choiceArgument: {},
      },
    ]);

    expect(result).toEqual({ transactionId: "tx-1" });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe("http://ledger/v2/commands/submit-and-wait-for-transaction");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.actAs).toEqual(["operator::1"]);
    expect(typeof body.commandId).toBe("string");
    expect(body.commands).toEqual([
      {
        CreateCommand: {
          templateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
          createArguments: { id: "CC" },
        },
      },
      {
        ExerciseCommand: {
          templateId: "pkg:Canton.TokenForge.Registry:InstrumentConfig",
          contractId: "00abc",
          choice: "InstrumentConfig_Archive",
          choiceArgument: {},
        },
      },
    ]);
  });

  it("throws when the ledger responds with a non-ok status", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
    })) as any;
    const client = new HttpLedgerClient(
      { ledgerApiUrl: "http://ledger", ledgerApiToken: "t" } as any,
      fakeFetch,
    );

    await expect(
      client.submitAndWait(["operator::1"], [
        { templateId: "T", createArguments: {} },
      ]),
    ).rejects.toThrow(/400/);
  });
});
