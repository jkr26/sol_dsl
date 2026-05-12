import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
  ts: string;
  tool: string;
  action: string;
  success: boolean;
  ms: number;
  error?: string;
  bond_pda?: string;
  amount_lamports?: number;
  dry_run?: boolean;
}

const TOOL_ACTION_MAP: Record<string, string> = {
  bond_propose:          "bond_proposed",
  bond_propose_open:     "bond_proposed_open",
  bond_accept:           "bond_accepted",
  bond_accept_proposal:  "bond_accepted",
  bond_cancel_proposal:  "bond_cancelled",
  bond_settle:           "bond_settled",
  bond_check_pending:    "bonds_settled",
  bond_watch:            "bond_watched",
  bond_list_pending:     "bonds_listed",
  bond_list_open:        "bonds_listed",
  bond_inspect:          "bond_inspected",
  bond_capabilities:     "capabilities_fetched",
  work_bond_create:      "work_bond_created",
  work_bond_join:        "work_bond_joined",
  work_bond_complete:    "work_bond_completed",
  work_bond_fail:        "work_bond_failed",
  work_bond_expire:      "work_bond_expired",
  work_bond_list:        "bonds_listed",
};

/**
 * Pluggable audit backend. Swap in a telemetry provider by implementing this
 * interface and passing it to wrapWithAudit instead of FileAuditBackend.
 */
export interface AuditBackend {
  record(entry: AuditEntry): void;
}

export class FileAuditBackend implements AuditBackend {
  constructor(private filePath: string) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) {}
  }

  record(entry: AuditEntry): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch (_) {
      // audit must never break a tool call
    }
  }
}

/** Wraps an OpenClaw tool object (with execute) to record every call. */
export function wrapWithAudit(
  tool: { name: string; description: string; parameters: any; execute: (id: string, params: any) => Promise<any> },
  backend: AuditBackend
) {
  const { execute, ...rest } = tool;
  return {
    ...rest,
    execute: async (id: string, params: any) => {
      const start = Date.now();
      let success = true;
      let error: string | undefined;
      let extraMeta: Partial<AuditEntry> = {};
      let action = TOOL_ACTION_MAP[rest.name] ?? rest.name;
      try {
        const raw = await execute(id, params);
        try {
          const parsed = JSON.parse(raw?.content?.[0]?.text ?? "{}");
          if (parsed?.bond_pda)       extraMeta.bond_pda       = parsed.bond_pda;
          if (parsed?.bond_address)   extraMeta.bond_pda       = parsed.bond_address;
          if (parsed?.work_bond_pda)  extraMeta.bond_pda       = parsed.work_bond_pda;
          if (parsed?.amount_lamports !== undefined) extraMeta.amount_lamports = parsed.amount_lamports;
          if (parsed?.dry_run !== undefined)         extraMeta.dry_run         = parsed.dry_run;
          if (parsed?.needs_confirmation)            action = "approval_requested";
          else if (parsed?.dry_run === true)         action = action.replace("_settled", "_previewed").replace("settled", "previewed");
        } catch {}
        return raw;
      } catch (e: any) {
        success = false;
        error = e?.message ?? String(e);
        throw e;
      } finally {
        backend.record({
          ts: new Date().toISOString(),
          tool: rest.name,
          action,
          success,
          ms: Date.now() - start,
          ...(error !== undefined ? { error } : {}),
          ...extraMeta,
        });
      }
    },
  };
}
