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

export function wrapWithAudit(name: string, tool: any, backend: AuditBackend): any {
  const { handler, ...rest } = tool;
  return {
    ...rest,
    handler: async (params: any) => {
      const start = Date.now();
      let success = true;
      let error: string | undefined;
      try {
        return await handler(params);
      } catch (e: any) {
        success = false;
        error = e?.message ?? String(e);
        throw e;
      } finally {
        backend.record({
          ts: new Date().toISOString(),
          tool: name,
          success,
          ms: Date.now() - start,
          ...(error !== undefined ? { error } : {}),
        });
      }
    },
  };
}
