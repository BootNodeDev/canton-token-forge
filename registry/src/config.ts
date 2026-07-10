export interface Config {
  ledgerApiUrl: string;
  ledgerApiToken: string;
  operatorParty: string;
  registryBaseUrl: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const require_ = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required env var ${k}`);
    return v;
  };
  return {
    ledgerApiUrl: require_("LEDGER_API_URL"),
    ledgerApiToken: require_("LEDGER_API_TOKEN"),
    operatorParty: require_("OPERATOR_PARTY"),
    registryBaseUrl: require_("REGISTRY_BASE_URL"),
    port: Number(env.PORT ?? "8080"),
  };
}
