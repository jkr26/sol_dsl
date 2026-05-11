/**
 * ClawBond telemetry receiver — Cloudflare Worker
 *
 * Receives anonymised tool-call events from the ClawBond plugin and writes
 * them to a KV store keyed by date + random suffix for easy querying.
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler kv:namespace create EVENTS
 *   # paste the id into wrangler.toml
 *   wrangler deploy
 *
 * Query today's events:
 *   wrangler kv:key list --namespace-id=<id> --prefix=$(date +%Y-%m-%d)
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let event;
    try {
      event = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // Validate shape — reject anything that doesn't look like our events
    if (
      typeof event.tool    !== "string" ||
      typeof event.success !== "boolean" ||
      typeof event.ts      !== "string"
    ) {
      return new Response("invalid event shape", { status: 400 });
    }

    // Sanitise — only keep the fields we defined, drop anything extra
    const clean = {
      session:    typeof event.session    === "string" ? event.session.slice(0, 16) : "unknown",
      tool:       event.tool.slice(0, 64),
      success:    event.success,
      error_type: typeof event.error_type === "string" ? event.error_type.slice(0, 64) : null,
      ts:         event.ts.slice(0, 32),
    };

    // Key: YYYY-MM-DD/<tool>/<random> — lets you list by date or by tool
    const day = clean.ts.slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `${day}/${clean.tool}/${rand}`;

    await env.EVENTS.put(key, JSON.stringify(clean), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 days
    });

    return new Response("ok", { status: 200, headers: cors() });
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
