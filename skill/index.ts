import * as path from "path";
import * as os from "os";
import { registerWagerTools } from "./src/tools";
import { resolveStorePath } from "./src/watcher";
import { FileAuditBackend, wrapWithAudit } from "./src/audit";
import { wrapWithTelemetry } from "./src/telemetry";

const DEFAULT_WALLET = path.join(os.homedir(), ".config", "solana", "clawbond-dedicated.json");
const DEFAULT_RPC    = "https://api.devnet.solana.com";
const DEFAULT_STORE  = path.join(os.homedir(), ".openclaw", "clawbond", "pending.json");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("./idl.json");
const PROGRAM_ID: string = IDL.address;

function adaptTool(
  name: string,
  tool: {
    description: string;
    parameters: any;
    handler?: (params: any) => Promise<any>;
    execute?: (id: string, params: any) => Promise<any>;
  }
) {
  if (tool.execute) {
    return { name, description: tool.description, parameters: tool.parameters, execute: tool.execute };
  }
  return {
    name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_id: string, params: any) => {
      const result = await tool.handler!(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  };
}

export function register(api: any): void {
  const pluginCfg = (api.config?.plugins?.["clawbond"] ?? {}) as Record<string, string>;

  const cfg = {
    walletPath: resolveStorePath(
      pluginCfg.walletPath ?? process.env.SOLANA_WALLET_PATH ?? DEFAULT_WALLET
    ),
    rpcUrl:    pluginCfg.rpcUrl    ?? process.env.SOLANA_RPC_URL    ?? DEFAULT_RPC,
    programId: PROGRAM_ID,
    storePath: resolveStorePath(
      pluginCfg.storePath ?? process.env.CLAWBOND_STORE_PATH ?? DEFAULT_STORE
    ),
    idl: IDL,
    requireApproval: (pluginCfg.requireApproval ?? process.env.CLAWBOND_REQUIRE_APPROVAL ?? "true") !== "false",
    maxStakeLamports: Math.round(
      Number(pluginCfg.maxStakePerBond ?? process.env.CLAWBOND_MAX_STAKE_SOL ?? "0.1") * 1e9
    ),
  };

  const auditPath = resolveStorePath(
    pluginCfg.auditPath ?? process.env.CLAWBOND_AUDIT_PATH ??
    path.join(os.homedir(), ".openclaw", "clawbond", "audit.jsonl")
  );
  const audit = new FileAuditBackend(auditPath);

  const telemetryEndpoint: string | null =
    pluginCfg.telemetryEndpoint ?? process.env.CLAWBOND_TELEMETRY_URL ?? null;
  // Default key ships with the plugin (write-only ingestion key, safe to embed).
  // Users can override with their own key/endpoint, or set disableTelemetry: true.
  const posthogKey: string | undefined =
    pluginCfg.posthogKey ?? process.env.CLAWBOND_POSTHOG_KEY ??
    "phc_wa8MB4fPpsLqGNNWjspPm7T5r2xrexxSmbHFa4uPydgi";
  const disableTelemetry =
    (pluginCfg.disableTelemetry ?? process.env.CLAWBOND_DISABLE_TELEMETRY ?? "true") !== "false";

  let tools = registerWagerTools(cfg);

  // Telemetry wraps first (innermost), audit wraps second (outermost).
  // Order means audit log always captures the final result including any
  // telemetry overhead, and telemetry sees the raw tool output.
  if (!disableTelemetry) {
    tools = wrapWithTelemetry(tools as any, telemetryEndpoint ?? "", posthogKey) as any;
  }

  for (const [name, tool] of Object.entries(tools)) {
    const adapted = adaptTool(name, tool as any);
    api.registerTool(wrapWithAudit(adapted, audit), { optional: true });
  }
}
