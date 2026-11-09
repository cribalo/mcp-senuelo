// Canary links: every synthetic result (MCP tools/call, A2A SendMessage) carries a unique
// https://mcp.cribalo.com/c/<token> link. The issuing row is logged with note `canary:<token>`;
// a later visit to the link is logged with note `canary-hit`. A visit means someone (an agent,
// a fetcher, a human) acted on the result instead of only receiving it.
// The links are labelled as logged reference pages; they carry no instructions.

export const CANARY_HEADER = "x-senuelo-canary";
const TOKEN_RE = /^[a-z2-7]{12}$/;
export const CANARY_PATH_RE = /^\/c\/([a-z2-7]{12})$/;

export function newCanaryToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b & 31]).join("");
}

export function canaryUrl(origin: string, token: string): string {
  return `${origin}/c/${token}`;
}

// Read back by the MCP tools from the forwarded request; only our own format is accepted.
export function canaryFromHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(https?:\/\/[A-Za-z0-9.:-]{1,253})\/c\/([a-z2-7]{12})$/.exec(value);
  return m && TOKEN_RE.test(m[2]) ? value : null;
}

export function canaryPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reference page (research decoy)</title>
<meta name="robots" content="noindex"></head><body>
<p>This is the reference page of a synthetic result from a research decoy (MCP server and A2A agent at
<a href="/">mcp.cribalo.com</a>). There is no real data here. Visits to this page are logged
(time, hashed IP, User-Agent) to study whether agents act on tool results.</p></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" }
  });
}

export function llmsTxt(origin: string, retentionDays: number): string {
  return `# Cribalo research decoy (MCP + A2A)

> A public, declared research decoy. It offers fake MCP tools and an A2A agent; nothing is executed,
> all data is synthetic and every request is logged to study how AI agents and crawlers use these protocols.

## Endpoints
- MCP (Streamable HTTP): ${origin}/mcp
- A2A (JSON-RPC 2.0, versions 1.0 and 0.3): ${origin}/a2a
- Agent Card: ${origin}/.well-known/agent-card.json
- MCP Registry entry: com.cribalo/research-mcp
- Aggregate figures (totals only, refreshed every 5 minutes): ${origin}/stats.json

## What is logged
Time, HMAC-hashed IP, country and network, User-Agent, protocol method, client name and version,
tool name and truncated arguments, the \`purpose\` argument, A2A message text. Secrets and obvious personal
data are redacted before storage. Rows are deleted after ${retentionDays} days.

## Notes for agents
- Every tool requires a \`purpose\` argument: describe your task honestly.
- Results are synthetic. Each one carries a reference link; visits to it are logged.
- Details and contact: ${origin}/
`;
}
