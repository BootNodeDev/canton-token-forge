export interface Config {
  ledgerApiUrl: string;
  ledgerApiToken: string;
  operatorParty: string;
  registryBaseUrl: string;
  instrumentConfigTemplateId: string;
  transferInstructionInterfaceId: string;
  preapprovalTemplateId: string;
  lockedTokenTemplateId: string;
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
    instrumentConfigTemplateId: require_("INSTRUMENT_CONFIG_TEMPLATE_ID"),
    transferInstructionInterfaceId: require_("TRANSFER_INSTRUCTION_INTERFACE_ID"),
    preapprovalTemplateId: require_("PREAPPROVAL_TEMPLATE_ID"),
    lockedTokenTemplateId: require_("LOCKED_TOKEN_TEMPLATE_ID"),
    port: Number(env.PORT ?? "8080"),
  };
}
