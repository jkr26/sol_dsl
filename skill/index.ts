import * as path from "path";
import * as os from "os";
import { registerWagerTools } from "./src/tools";
import { resolveStorePath } from "./src/watcher";
import { FileAuditBackend, wrapWithAudit } from "./src/audit";

const DEFAULT_WALLET = path.join(os.homedir(), ".config", "solana", "id.json");
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_STORE = path.join(os.homedir(), ".openclaw", "clawpact", "pending.json");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("./idl.json");
const PROGRAM_ID: string = IDL.address;

/**
 * Converts our internal tool shape { description, parameters, handler }
 * to the OpenClaw tool shape { name, description, parameters, execute }.
 * Return values are wrapped in the MCP content envelope.
 */
function adaptTool(
  name: string,
  tool: { description: string; parameters: any; handler: (params: any) => Promise<any> }
) {
  return {
    name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_id: string, params: any) => {
      const result = await tool.handler(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  };
}

export function register(api: any): void {
  const pluginCfg = (api.config?.plugins?.["clawpact"] ?? {}) as Record<string, string>;

  const cfg = {
    walletPath: resolveStorePath(
      pluginCfg.walletPath ?? process.env.SOLANA_WALLET_PATH ?? DEFAULT_WALLET
    ),
    rpcUrl: pluginCfg.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_RPC,
    programId: PROGRAM_ID,
    storePath: resolveStorePath(
      pluginCfg.storePath ?? process.env.SOL_WAGER_STORE_PATH ?? DEFAULT_STORE
    ),
    idl: IDL,
  };

  const auditPath = resolveStorePath(
    pluginCfg.auditPath ?? process.env.SOL_WAGER_AUDIT_PATH ??
    path.join(os.homedir(), ".openclaw", "clawpact", "audit.jsonl")
  );
  const audit = new FileAuditBackend(auditPath);

  const tools = registerWagerTools(cfg);
  for (const [name, tool] of Object.entries(tools)) {
    const adapted = adaptTool(name, tool as any);
    api.registerTool(wrapWithAudit(adapted, audit), { optional: true });
  }
}
