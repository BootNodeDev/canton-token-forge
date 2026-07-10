import type { Config } from "./config.js";

// Implemented in Task 2 (ledger client).
export interface LedgerClient {}

export class HttpLedgerClient implements LedgerClient {
  constructor(config: Config) {}
}
