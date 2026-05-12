import * as crypto from "crypto";

export interface TelemetryEvent {
  session:    string;  // anonymous random ID, rotated per plugin startup
  tool:       string;
  success:    boolean;
  error_type: string | null;  // normalised class of error, never the full message
  ts:         string;
}

// Single anonymous session ID for the lifetime of this process.
// Lets you reconstruct usage sequences without knowing who the agent is.
const SESSION_ID = crypto.randomBytes(8).toString("hex");

function classifyError(e: unknown): string {
  const s = String(e);
  if (s.includes("6000") || s.includes("AlreadySettled"))   return "AlreadySettled";
  if (s.includes("6001") || s.includes("NotExpiredYet"))    return "NotExpiredYet";
  if (s.includes("6002") || s.includes("StaleOracle"))      return "StaleOracle";
  if (s.includes("6003") || s.includes("WrongWinner"))      return "WrongWinner";
  if (s.includes("6007") || s.includes("ZeroStake"))        return "ZeroStake";
  if (s.includes("6009") || s.includes("InvalidBand"))      return "InvalidBand";
  if (s.includes("6012") || s.includes("ProposalExpired"))  return "ProposalExpired";
  if (s.includes("6014") || s.includes("WorkBondNotPendingWorker")) return "WorkBondNotPendingWorker";
  if (s.includes("6015") || s.includes("WorkBondNotActive")) return "WorkBondNotActive";
  if (s.includes("6016") || s.includes("InvalidAdjudicator")) return "InvalidAdjudicator";
  if (s.includes("6017") || s.includes("InvalidWorker"))    return "InvalidWorker";
  if (s.includes("429") || s.includes("rate limit"))        return "RateLimited";
  if (s.includes("timeout") || s.includes("ETIMEDOUT"))     return "Timeout";
  if (s.includes("insufficient funds") || s.includes("0x1")) return "InsufficientFunds";
  if (s.includes("simulation failed") || s.includes("Simulation")) return "SimulationFailed";
  return "Unknown";
}

export function wrapWithTelemetry(
  tools: Record<string, { name: string; execute: (...a: any[]) => Promise<any> }>,
  endpoint: string,
  posthogKey?: string
): typeof tools {
  const wrapped: typeof tools = {};

  for (const [key, tool] of Object.entries(tools)) {
    wrapped[key] = {
      ...tool,
      execute: async (id: string, params: Record<string, unknown>) => {
        const result = await tool.execute(id, params);

        const event: TelemetryEvent = {
          session:    SESSION_ID,
          tool:       tool.name,
          success:    result?.success !== false,
          error_type: result?.success === false ? classifyError(result?.error ?? "") : null,
          ts:         new Date().toISOString(),
        };

        if (posthogKey) {
          firePostHog(posthogKey, event);
        } else {
          fireGeneric(endpoint, event);
        }

        return result;
      },
    };
  }

  return wrapped;
}

function firePostHog(apiKey: string, event: TelemetryEvent): void {
  fetch("https://app.posthog.com/capture/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key:     apiKey,
      event:       "tool_call",
      distinct_id: event.session,
      properties: {
        tool:       event.tool,
        success:    event.success,
        error_type: event.error_type,
        $timestamp: event.ts,
      },
    }),
  }).catch(() => {});
}

function fireGeneric(endpoint: string, event: TelemetryEvent): void {
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => {});
}
