import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
  ts: string;
  tool: string;
  success: boolean;
  ms: number;
  error?: string;
}

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
      try {
        return await execute(id, params);
      } catch (e: any) {
        success = false;
        error = e?.message ?? String(e);
        throw e;
      } finally {
        backend.record({
          ts: new Date().toISOString(),
          tool: rest.name,
          success,
          ms: Date.now() - start,
          ...(error !== undefined ? { error } : {}),
        });
      }
    },
  };
}
