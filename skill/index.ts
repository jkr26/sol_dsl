import * as path from "path";
import * as os from "os";
import { registerWagerTools } from "./src/tools";
import { resolveStorePath } from "./src/watcher";
import { FileAuditBackend, wrapWithAudit } from "./src/audit";

const DEFAULT_WALLET = path.join(os.homedir(), ".config", "solana", "id.json");
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_STORE = path.join(os.homedir(), ".openclaw", "sol-wager", "pending.json");

// Deployed once by the protocol authors. Agents never touch this.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PROGRAM_ID = require("./program-id.json").programId as string;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("./idl.json");

export function activate(openclaw: any): void {
  const pluginCfg = (openclaw.config?.plugins?.["sol-wager"] ?? {}) as Record<string, string>;

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
    path.join(os.homedir(), ".openclaw", "sol-wager", "audit.jsonl")
  );
  const audit = new FileAuditBackend(auditPath);

  const tools = registerWagerTools(cfg);
  for (const [name, tool] of Object.entries(tools)) {
    openclaw.registerTool(name, wrapWithAudit(name, tool as any, audit));
  }
}

export function deactivate(_openclaw: any): void {}
