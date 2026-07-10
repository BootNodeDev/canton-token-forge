import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { HttpLedgerClient } from "./ledger.js";

const config = loadConfig(process.env);
const ledger = new HttpLedgerClient(config);
const app = createServer({ ledger, config });
app.listen(config.port, () => {
  console.log(`canton-token-forge registry listening on :${config.port}`);
});
