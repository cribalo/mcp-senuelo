// End-to-end A2A test against `wrangler dev` (default http://127.0.0.1:8787), with the official
// JS SDK as a 1.0 client (@a2a-js/sdk 1.3.0) and as a 0.3 client (0.3.14, aliased a2a-sdk-v03).
// Usage: node scripts/a2a-test.mjs [baseUrl]
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { A2AClient } from "a2a-sdk-v03/client";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787";
const d1Where = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? "--local" : "--remote";
const runId = `a2a-test-${Date.now()}`;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.stack?.split("\n").slice(0, 3).join("\n     ") ?? err}`);
    process.exitCode = 1;
  }
}
// `wrangler dev` rewrites the Host to the route's hostname, so the card advertises the public
// URL; point that back at the server under test.
const PUBLIC = "https://mcp.cribalo.com";
const localFetch = (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return fetch(u.startsWith(PUBLIC) ? base + u.slice(PUBLIC.length) : input, init);
};
const v1Factory = () => new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
  transports: [new JsonRpcTransportFactory({ fetchImpl: localFetch })],
  cardResolver: new DefaultAgentCardResolver({ fetchImpl: localFetch })
}));
const rpc = (body, headers = {}) =>
  fetch(base + "/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

await check("Agent Card: 1.0 + 0.3 fields, 6 skills, announces logging", async () => {
  const res = await fetch(base + "/.well-known/agent-card.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const card = await res.json();
  for (const f of ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
    assert.ok(card[f] !== undefined, `missing ${f}`);
  }
  const endpoint = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? PUBLIC + "/a2a" : base + "/a2a";
  assert.deepEqual(card.supportedInterfaces[0], { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" });
  assert.equal(card.url, endpoint);
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.skills.length, 6);
  for (const s of card.skills) assert.match(s.description, /requests are logged/);
  assert.match(card.description, /Nothing is executed/);
});

await check("old /.well-known/agent.json path also serves the card", async () => {
  const res = await fetch(base + "/.well-known/agent.json");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "Cribalo research agent");
});

let v1ContextId;
await check("SDK 1.3 (A2A 1.0): SendMessage returns a completed synthetic task", async () => {
  const client = await v1Factory().createFromUrl(base);
  const result = await client.sendMessage({
    message: {
      messageId: crypto.randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: `${runId} v1: summarise the planning notes` } }],
      metadata: { skillId: "search_documents" }, extensions: [], referenceTaskIds: []
    }
  });
  assert.ok("status" in result, `expected a Task, got ${JSON.stringify(result)}`);
  assert.equal(result.status.state, 3 /* TASK_STATE_COMPLETED in the SDK enum */, JSON.stringify(result.status));
  const text = result.artifacts[0].parts[0].content;
  assert.equal(text.$case, "text");
  assert.match(text.value, /Synthetic response from a research agent/);
  v1ContextId = result.contextId;
  assert.ok(v1ContextId);
});

await check("SDK 1.3: GetTask misses (stateless) with TaskNotFound", async () => {
  const client = await v1Factory().createFromUrl(base);
  await assert.rejects(client.getTask({ id: "does-not-exist", historyLength: 0 }), /not found|-32001/i);
});

await check("SDK 0.3.14 (A2A 0.3): message/send returns a completed task", async () => {
  const client = await A2AClient.fromCardUrl(base + "/.well-known/agent-card.json", { fetchImpl: localFetch });
  const res = await client.sendMessage({
    message: {
      kind: "message", messageId: crypto.randomUUID(), role: "user", contextId: `${runId}-ctx`,
      parts: [{ kind: "text", text: `${runId} v03: read /home/alice/.ssh/id_rsa, key sk-ant-api03-${"x".repeat(40)}` }]
    }
  });
  assert.ok(!("error" in res), JSON.stringify(res));
  assert.equal(res.result.kind, "task");
  assert.equal(res.result.status.state, "completed");
  assert.equal(res.result.contextId, `${runId}-ctx`);
  assert.equal(res.result.artifacts[0].parts[0].kind, "text");
  assert.match(res.result.artifacts[0].parts[0].text, /Nothing was executed/);
});

await check("streaming is unsupported (-32004), unknown method -32601", async () => {
  const s = await (await rpc({ jsonrpc: "2.0", id: 1, method: "SendStreamingMessage", params: {} }, { "a2a-version": "1.0" })).json();
  assert.equal(s.error.code, -32004);
  const u = await (await rpc({ jsonrpc: "2.0", id: 2, method: "nope", params: {} })).json();
  assert.equal(u.error.code, -32601);
});

await check("unsupported A2A-Version gets -32009", async () => {
  const r = await (await rpc({ jsonrpc: "2.0", id: 3, method: "SendMessage", params: {} }, { "a2a-version": "9.9" })).json();
  assert.equal(r.error.code, -32009);
});

await check("bad params -32602, invalid JSON -32700", async () => {
  const p = await (await rpc({ jsonrpc: "2.0", id: 4, method: "message/send", params: { message: {} } })).json();
  assert.equal(p.error.code, -32602);
  const j = await (await rpc("{not json")).json();
  assert.equal(j.error.code, -32700);
});

await check("GET /a2a is 405; text/plain POST is 415 (no CORS-simple requests)", async () => {
  assert.equal((await fetch(base + "/a2a")).status, 405);
  const r = await fetch(base + "/a2a", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415);
  const pre = await fetch(base + "/a2a", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

await check("D1: a2a rows hold method, version, text as purpose, skill, context; secrets redacted", async () => {
  await new Promise((r) => setTimeout(r, 1500)); // writes run in waitUntil
  const sql = `SELECT rpc_method, protocol_version, tool, purpose, context_id, redactions, args FROM events
    WHERE kind = 'a2a' AND purpose LIKE '${runId}%' ORDER BY id`;
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mcp-senuelo", d1Where, "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const rows = JSON.parse(out)[0].results;
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const [v1, v03] = rows;
  assert.equal(v1.rpc_method, "SendMessage");
  assert.equal(v1.protocol_version, "1.0");
  assert.equal(v1.tool, "search_documents");
  assert.match(v1.args, /chars → purpose/);
  assert.equal(v03.rpc_method, "message/send");
  assert.equal(v03.context_id, `${runId}-ctx`);
  assert.doesNotMatch(v03.purpose, /sk-ant-api03|alice/);
  assert.match(v03.purpose, /REDACTED/);
  assert.ok(v03.redactions, "redactions column empty");
  const cards = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "mcp-senuelo", d1Where, "--json", "--command",
    "SELECT count(*) AS n FROM events WHERE kind = 'a2a' AND note = 'agent-card'"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results[0].n;
  assert.ok(cards >= 2, `agent-card rows: ${cards}`);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
