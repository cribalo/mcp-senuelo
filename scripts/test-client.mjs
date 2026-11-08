// End-to-end test against `wrangler dev` (default http://127.0.0.1:8787).
// Usage: node scripts/test-client.mjs [baseUrl] [--rate-limit]
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787";
const testRateLimit = process.argv.includes("--rate-limit");
const d1Where = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? "--local" : "--remote";
const runId = `test-${Date.now()}`;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

await check("GET / explains the server", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /señuelo con fines de investigación/);
  assert.match(html, /research honeypot/);
});

await check("unknown path is 404 and logged", async () => {
  const res = await fetch(base + "/wp-login.php?user=x");
  assert.equal(res.status, 404);
});

const client = new Client({ name: "senuelo-test-client", version: runId });
await check("SDK client connects (current protocol)", async () => {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
});

await check("tools/list: 4 fake tools, all require purpose and announce logging", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["fetch_url", "get_exchange_rate", "query_database", "search_documents"]);
  for (const t of tools) {
    assert.ok(t.inputSchema.required?.includes("purpose"), `${t.name} lacks required purpose`);
    assert.match(t.description, /calls are logged/);
  }
});

await check("tools/call returns synthetic data", async () => {
  const r = await client.callTool({
    name: "search_documents",
    arguments: { query: "planning", purpose: `${runId} purpose: find planning notes` }
  });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /Synthetic response/);
});

await check("fetch_url does not fetch", async () => {
  const r = await client.callTool({
    name: "fetch_url",
    arguments: { url: "http://169.254.169.254/latest/meta-data", purpose: `${runId} ssrf probe` }
  });
  assert.match(r.content[0].text, /was not fetched/);
});

await check("tools/call without purpose is rejected", async () => {
  let rejected = false;
  try {
    const r = await client.callTool({ name: "get_exchange_rate", arguments: { base: "EUR", quote: "USD" } });
    rejected = r.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected);
});
await client.close().catch(() => {});

await check("2025-era client: raw initialize + tools/call", async () => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "senuelo-legacy-test/1.0"
  };
  const init = await fetch(base + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "senuelo-legacy-test", version: runId } }
    })
  });
  assert.equal(init.status, 200, await init.clone().text());
  const call = await fetch(base + "/mcp", {
    method: "POST",
    headers: { ...headers, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "query_database", arguments: { sql: "SELECT * FROM customers", purpose: `${runId} legacy purpose` } }
    })
  });
  assert.equal(call.status, 200);
  assert.match(await call.text(), /not executed/);
});

await check("oversized body is rejected with 413", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { pad: "x".repeat(40000) } })
  });
  assert.equal(res.status, 413);
});

await check("cross-site browser Origin is refused", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
  });
  assert.ok(res.status >= 400, `status ${res.status}`);
});

await check("D1 has the rows: client, tool, args without purpose, purpose, hashed IP", async () => {
  await new Promise((r) => setTimeout(r, d1Where === "--local" ? 500 : 3000)); // waitUntil writes
  const sql =
    `SELECT kind, rpc_method, client_name, tool, args, purpose, ip_hash, status, path FROM events ` +
    `WHERE purpose LIKE '${runId}%' OR client_version = '${runId}' OR path = '/wp-login.php' OR status = 413`;
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mcp-senuelo", d1Where, "--json", "--command", sql], {
    encoding: "utf8"
  });
  const rows = JSON.parse(out)[0].results;
  const calls = rows.filter((r) => r.tool && r.purpose?.startsWith(runId));
  assert.ok(calls.length >= 3, `tool calls logged: ${calls.length}`);
  assert.ok(calls.every((r) => !r.args.includes("purpose")), "purpose leaked into args");
  assert.ok(rows.some((r) => r.rpc_method === "initialize" && r.client_name === "senuelo-legacy-test"));
  assert.ok(rows.some((r) => r.client_name === "senuelo-test-client"), "SDK clientInfo not logged");
  assert.ok(rows.some((r) => r.kind === "http" && r.path === "/wp-login.php"));
  assert.ok(rows.some((r) => r.kind === "rejected" && r.status === 413));
  assert.ok(rows.every((r) => /^[0-9a-f]{16}$/.test(r.ip_hash)), "ip_hash is not a 16-hex HMAC");
});

// ---- /dash ----
function dashPassword() {
  if (process.env.DASH_PASSWORD) return process.env.DASH_PASSWORD;
  const m = /^DASH_PASSWORD=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
  return m ? m[1].trim() : "";
}
const post = (path, body, type = "application/json") =>
  fetch(base + path, { method: "POST", headers: { "content-type": type }, body });
let sessionCookie = "";
const withCookie = (c) => ({ headers: { cookie: c } });

await check("GET /dash/ is HTML with a strict CSP", async () => {
  const res = await fetch(base + "/dash/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

await check("dash API without cookie is 401; bad password 401; text/plain refused", async () => {
  assert.equal((await fetch(base + "/dash/api/events")).status, 401);
  assert.equal((await post("/dash/api/login", JSON.stringify({ password: "wrong-password-xxxxxxxx" }))).status, 401);
  const res = await post("/dash/api/login", JSON.stringify({ password: dashPassword() }), "text/plain");
  assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
});

await check("login sets a HttpOnly Secure SameSite=Strict cookie", async () => {
  const res = await post("/dash/api/login", JSON.stringify({ password: dashPassword() }));
  assert.equal(res.status, 204);
  const sc = res.headers.get("set-cookie") ?? "";
  assert.match(sc, /^dash_session=\d+\.[0-9a-f]{64};/);
  for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/dash"]) assert.ok(sc.includes(a), `missing ${a}`);
  sessionCookie = sc.split(";")[0];
});

await check("with the cookie: session 204, events contain this run, after=max_id is empty or newer", async () => {
  assert.equal((await fetch(base + "/dash/api/session", withCookie(sessionCookie))).status, 204);
  const res = await fetch(base + "/dash/api/events", withCookie(sessionCookie));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-store/);
  const data = await res.json();
  assert.ok(Array.isArray(data.events) && typeof data.capped === "boolean");
  assert.ok(data.events.some((e) => e.purpose?.startsWith(runId)), "no row from this run");
  assert.ok(data.events.every((e, i, a) => i === 0 || a[i - 1].id < e.id), "not ascending");
  assert.equal(data.max_id, data.events.at(-1).id);
  const next = await (await fetch(base + `/dash/api/events?after=${data.max_id}`, withCookie(sessionCookie))).json();
  assert.ok(next.events.every((e) => e.id > data.max_id));
});

await check("tampered or expired cookie is 401", async () => {
  const [name, value] = sessionCookie.split("=");
  const [exp, mac] = value.split(".");
  const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal((await fetch(base + "/dash/api/session", withCookie(`${name}=${exp}.${flipped}`))).status, 401);
  const past = Number(exp) - 100000; // valid-looking exp, MAC no longer matches
  assert.equal((await fetch(base + "/dash/api/events", withCookie(`${name}=${past}.${mac}`))).status, 401);
});

await check("logout clears the cookie", async () => {
  const res = await post("/dash/api/logout", "");
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

await check("/dash requests are not in D1", async () => {
  await new Promise((r) => setTimeout(r, d1Where === "--local" ? 500 : 3000));
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mcp-senuelo", d1Where, "--json", "--command",
    "SELECT COUNT(*) AS n FROM events WHERE path LIKE '/dash%'"], { encoding: "utf8" });
  assert.equal(JSON.parse(out)[0].results[0].n, 0);
});

await check("app.js has no HTML-injection sinks", async () => {
  const js = readFileSync(new URL("../public/dash/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/);
});

if (testRateLimit) {
  await check("rate limit answers 429 after the burst", async () => {
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await fetch(base + "/robots.txt")).status);
    assert.ok(statuses.includes(429), `no 429 in ${statuses.join(",")}`);
  });
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
