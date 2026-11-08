// Decoy A2A (Agent2Agent) agent: a public Agent Card and a stateless JSON-RPC endpoint.
// Like the MCP tools, nothing is executed: every SendMessage gets a completed task with a
// fixed synthetic text that says so. Speaks A2A 1.0 and, for older clients, 0.3.
import { Row, asString, truncate, truncateOrNull, cleanOrNull, joinKinds, makeCleaner } from "./log";

export const A2A_PATH = "/a2a";
// 1.0 path, plus the pre-0.3 path some crawlers still request.
export const CARD_PATHS = new Set(["/.well-known/agent-card.json", "/.well-known/agent.json"]);

const NOTICE =
  "Research agent: requests are logged (time, hashed IP, User-Agent, method, message text). " +
  "Nothing is executed and all data is synthetic. Details: https://mcp.cribalo.com/";

const REPLY =
  "Synthetic response from a research agent. Nothing was executed, nothing was fetched and " +
  "no real data exists behind this agent. Your request was logged for research; details at https://mcp.cribalo.com/";

// Mirrors the MCP tools (src/tools.ts) so both doors offer the same bait.
const SKILLS = [
  ["search_documents", "Search documents", "Search a small index of sample documents.", ["search", "documents"]],
  ["fetch_url", "Fetch a web page", "Pretends to fetch a web page; it never contacts the URL.", ["web", "fetch"]],
  ["query_database", "Query a database", "Pretends to run read-only SQL against a synthetic sample table.", ["sql", "data"]],
  ["get_exchange_rate", "Exchange rate", "Returns a placeholder exchange rate (not real market data).", ["finance"]],
  ["execute_script", "Run a script", "Pretends to run a script; it never executes anything.", ["code", "execution"]],
  ["read_file", "Read a file", "Pretends to read a file; this agent has no file system.", ["files"]]
] as const;

// `origin` is the request's own origin (https://mcp.cribalo.com in production).
export function agentCard(origin: string): Record<string, unknown> {
  const url = `${origin}${A2A_PATH}`;
  return {
    name: "Cribalo research agent",
    description: `${NOTICE} Describe your task honestly in the message; there is no real data behind this agent.`,
    version: "0.1.0",
    // A2A 1.0: endpoints live in supportedInterfaces, the first one is preferred.
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url, protocolBinding: "JSONRPC", protocolVersion: "0.3" }
    ],
    // A2A 0.3 fields, ignored by 1.0 clients.
    protocolVersion: "0.3.0",
    url,
    preferredTransport: "JSONRPC",
    provider: { organization: "cribalo.com (research)", url: `${origin}/` },
    documentationUrl: `${origin}/`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: SKILLS.map(([id, name, description, tags]) => ({
      id, name, description: `${description} ${NOTICE}`, tags: [...tags]
    }))
  };
}

type Version = "0.3" | "1.0";
type Style = "v03" | "v1";
type RpcError = { code: number; message: string };

const ERR = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  // Stateless: no task is ever stored, so every lookup misses.
  taskNotFound: { code: -32001, message: "Task not found" },
  pushNotSupported: { code: -32003, message: "Push notifications are not supported" },
  unsupported: { code: -32004, message: "This operation is not supported" },
  extendedCard: { code: -32007, message: "Extended agent card is not configured" },
  version: { code: -32009, message: "Version not supported; supported: 1.0, 0.3" }
} satisfies Record<string, RpcError>;

const SEND = new Set(["SendMessage", "message/send"]);
const STREAM = new Set(["SendStreamingMessage", "message/stream"]);
const TASK_LOOKUP = new Set(["GetTask", "tasks/get", "CancelTask", "tasks/cancel", "SubscribeToTask", "tasks/resubscribe"]);
const LIST = new Set(["ListTasks", "tasks/list"]);
const EXTENDED = new Set(["GetExtendedAgentCard", "agent/getAuthenticatedExtendedCard"]);

// Empty header means 0.3 (spec 1.0, §3.6.2). Patch numbers are tolerated and dropped.
function parseVersion(raw: string | null): Version | null {
  if (!raw) return "0.3";
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw.trim());
  if (!m) return null;
  const v = `${Number(m[1])}.${Number(m[2])}`;
  return v === "1.0" || v === "0.3" ? v : null;
}

export function handleA2a(
  request: Request, url: URL, body: string, base: Row, maxField: number
): { response: Response; rows: Row[] } {
  const row: Row = { ...base, kind: "a2a" };
  if (request.method !== "POST") {
    return { response: new Response("Use POST with JSON-RPC 2.0\n", { status: 405, headers: { allow: "POST" } }), rows: [{ ...row, status: 405 }] };
  }
  // Requiring a JSON content type forces a CORS preflight, which this endpoint never grants:
  // other websites cannot use their visitors' browsers against /a2a.
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/a2a+json") {
    return { response: new Response("Unsupported media type\n", { status: 415 }), rows: [{ ...row, status: 415, note: truncate(`content-type: ${type || "(none)"}`, 200) }] };
  }

  const rawVersion = request.headers.get("a2a-version") ?? url.searchParams.get("A2A-Version");
  row.protocol_version = truncateOrNull(rawVersion, 50);
  const version = parseVersion(rawVersion);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const c = makeCleaner();
    const r = { ...row, status: 200, note: "invalid JSON", args: truncate(c.clean(body), maxField) };
    r.redactions = joinKinds([...c.kinds]);
    return { response: rpc(null, { error: ERR.parse }), rows: [r] };
  }
  if (Array.isArray(parsed)) {
    // A2A does not use JSON-RPC batches; log what was sent, answer with one error.
    const rows = parsed.slice(0, 20).map((m) => ({ ...rowFromMessage(m, row, maxField), status: 200, note: "batch (rejected)" }));
    return { response: rpc(null, { error: ERR.invalidRequest }), rows: rows.length ? rows : [{ ...row, status: 200, note: "empty batch" }] };
  }

  const r = rowFromMessage(parsed, row, maxField);
  r.status = 200;
  const m = (parsed && typeof parsed === "object" ? parsed : {}) as { id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  const method = typeof m.method === "string" ? m.method : "";

  const fail = (e: RpcError) => {
    r.note = truncate([r.note, `error ${e.code}`].filter(Boolean).join("; "), 300);
    return { response: rpc(id, { error: e }), rows: [r] };
  };
  if (version === null) return fail(ERR.version);
  if (!method) return fail(ERR.invalidRequest);
  // PascalCase names only exist in 1.0; answer in that shape even if the header was left out.
  const style: Style = version === "1.0" || /^[A-Z]/.test(method) ? "v1" : "v03";

  if (SEND.has(method)) {
    const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, any>;
    const msg = params.message;
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.parts)) return fail(ERR.invalidParams);
    const contextId = typeof msg.contextId === "string" && msg.contextId ? truncate(msg.contextId, 100) : crypto.randomUUID();
    return { response: rpc(id, { result: completedTask(style, contextId) }), rows: [r] };
  }
  if (STREAM.has(method) || LIST.has(method)) return fail(ERR.unsupported);
  if (TASK_LOOKUP.has(method)) return fail(ERR.taskNotFound);
  if (/pushnotificationconfig/i.test(method)) return fail(ERR.pushNotSupported);
  if (EXTENDED.has(method)) return fail(ERR.extendedCard);
  return fail(ERR.methodNotFound);
}

export function cardResponse(origin: string, method: string): Response {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    // A public description: any site may read it.
    "access-control-allow-origin": "*"
  };
  if (method === "HEAD") return new Response(null, { headers });
  if (method !== "GET") return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  return new Response(JSON.stringify(agentCard(origin), null, 2), { headers });
}

function completedTask(style: Style, contextId: string): Record<string, unknown> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const artifactId = crypto.randomUUID();
  if (style === "v1") {
    return {
      task: {
        id, contextId,
        status: { state: "TASK_STATE_COMPLETED", timestamp },
        artifacts: [{ artifactId, name: "result", parts: [{ text: REPLY, mediaType: "text/plain" }] }]
      }
    };
  }
  return {
    kind: "task", id, contextId,
    status: { state: "completed", timestamp },
    artifacts: [{ artifactId, name: "result", parts: [{ kind: "text", text: REPLY }] }]
  };
}

function rpc(id: string | number | null, payload: { result: unknown } | { error: RpcError }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function rowFromMessage(msg: unknown, base: Row, maxField: number): Row {
  if (!msg || typeof msg !== "object") return { ...base, note: "non-object message" };
  const m = msg as { method?: unknown; id?: unknown; params?: unknown };
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, any>;
  const row: Row = {
    ...base,
    rpc_method: typeof m.method === "string" ? truncate(m.method, 100) : "(response)",
    rpc_id: m.id === undefined || m.id === null ? null : truncate(String(m.id), 100)
  };
  const { clean, kinds } = makeCleaner();
  const message = params.message && typeof params.message === "object" ? params.message : null;
  if (message) {
    const parts: unknown[] = Array.isArray(message.parts) ? message.parts.slice(0, 50) : [];
    // In A2A the message text is the intent: it goes to `purpose`, like MCP's purpose field.
    const texts = parts.map((p: any) => (p && typeof p.text === "string" ? p.text : null)).filter((t): t is string => t !== null);
    if (texts.length) row.purpose = truncate(clean(texts.join("\n")), maxField);
    const meta = { ...(params.metadata ?? {}), ...(message.metadata ?? {}) } as Record<string, unknown>;
    const skill = asString(meta.skillId) ?? asString(meta.skill_id) ?? asString(meta.skill);
    row.tool = truncateOrNull(cleanOrNull(skill, clean), 100);
    row.context_id = truncateOrNull(cleanOrNull(asString(message.contextId), clean), 100);
    row.task_id = truncateOrNull(cleanOrNull(asString(message.taskId), clean), 100);
    // Everything else, with texts and inline file bytes replaced by their sizes.
    const slim = {
      ...params,
      message: {
        ...message,
        parts: parts.map((p: any) => {
          if (!p || typeof p !== "object") return p;
          const q = { ...p };
          if (typeof q.text === "string") q.text = `[${q.text.length} chars → purpose]`;
          if (typeof q.raw === "string") q.raw = `[${q.raw.length} base64 chars]`;
          if (q.file && typeof q.file.bytes === "string") q.file = { ...q.file, bytes: `[${q.file.bytes.length} base64 chars]` };
          return q;
        })
      }
    };
    row.args = truncate(clean(JSON.stringify(slim)), maxField);
  } else if (Object.keys(params).length) {
    row.task_id = truncateOrNull(cleanOrNull(asString(params.id) ?? asString(params.taskId), clean), 100);
    row.args = truncate(clean(JSON.stringify(params)), maxField);
  }
  row.redactions = joinKinds([...kinds]);
  return row;
}
