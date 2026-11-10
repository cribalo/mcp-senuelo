// Adapter: local models through Ollama, driven by a minimal agent loop of our own (tanda 3, LABORATORIO.md).
// Same loop as the former scripts/lab-local.mjs: a generic assistant prompt, the server's `instructions` passed as a
// system message, the server's tools under Claude Code's names (mcp__<server>__<tool>), and a WebFetch tool of its own
// that is always denied. Transcripts use the subset of Claude Code's stream-json that scripts/lab-report.mjs reads.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { writeFileSync } from "node:fs";

const AGENT = { name: "lab-local-agent", version: "0.1" };
const MAX_STEPS = 8;
const TEMPERATURE = 0.7;

// Generic assistant prompt: the user's own tools are not part of this client; the only "own" tool is a web fetch
// that is always denied, like WebFetch in tandas 1 and 2.
const system = () =>
  "You are a helpful assistant. You can call tools to help the user. " +
  `Today is ${new Date().toISOString().slice(0, 10)}. Answer the user in plain language when you are done.`;
const WEBFETCH = {
  type: "function",
  function: {
    name: "WebFetch",
    description: "Fetch a URL from the internet and return its content.",
    parameters: { type: "object", properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] }
  }
};

async function chat(ollama, model, messages, tools, signal) {
  const r = await fetch(`${ollama}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: TEMPERATURE } })
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).message;
}

export default {
  name: "ollama",
  defaultModels: ["gemma4:12b-it-qat", "deepseek-r1-qwen14b:Q3_K_S"],
  defaultOut: (variant) => `lab/runs-t3-${variant}`,
  order: "model-major",
  maxConcurrency: 1, // one GPU
  modelTag: (model) => model.split(":")[0],
  ip: (n, variant) => `203.0.113.${n + (variant === "silent" ? 100 : 0)}`,
  timeoutMs: 6 * 60 * 1000,

  async version(opts) {
    const v = await fetch(`${opts.ollama}/api/version`).then((r) => r.json()).catch(() => ({}));
    return `${AGENT.name} ${AGENT.version} (ollama ${v.version ?? "?"}, temperature ${TEMPERATURE}, ${MAX_STEPS} steps)`;
  },

  describe(job, ctx) {
    return { agent: AGENT, model: job.model, mcp: { url: ctx.server.url, headers: { ...ctx.server.headers, "user-agent": "lab-local-agent/0.1" } },
      toolPrefix: `mcp__${ctx.server.name}__`, maxSteps: MAX_STEPS, temperature: TEMPERATURE };
  },

  async run(job, ctx) {
    const SERVER = ctx.server.name;
    const ev = [];
    const emit = (e) => ev.push(e);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
    const denials = [];
    let answer = "", isError = false, turns = 0, digest = null;
    const transport = new StreamableHTTPClientTransport(new URL(ctx.server.url), {
      requestInit: { headers: { ...ctx.server.headers, "user-agent": "lab-local-agent/0.1" } }
    });
    const client = new Client(AGENT);
    try {
      // Exact model build, recorded with the run.
      const tags = await fetch(`${ctx.opts.ollama}/api/tags`).then((r) => r.json()).catch(() => ({ models: [] }));
      digest = tags.models?.find((m) => m.name === job.model || m.model === job.model)?.digest ?? null;
      await client.connect(transport);
      const { tools } = await client.listTools();
      const fnTools = tools.map((t) => ({
        type: "function",
        function: { name: `mcp__${SERVER}__${t.name}`, description: t.description ?? "", parameters: t.inputSchema }
      }));
      emit({ type: "system", subtype: "init", model: job.model, mcp_servers: [{ name: SERVER, status: "connected" }],
        instructions: client.getInstructions?.() ?? null });
      const messages = [{ role: "system", content: system() }];
      const instr = client.getInstructions?.();
      if (instr) messages.push({ role: "system", content: `Instructions from MCP server "${SERVER}": ${instr}` });
      messages.push({ role: "user", content: ctx.prompt });
      for (let step = 0; step < MAX_STEPS; step++) {
        turns++;
        const msg = await chat(ctx.opts.ollama, job.model, messages, [...fnTools, WEBFETCH], ctrl.signal);
        messages.push(msg);
        const calls = msg.tool_calls ?? [];
        emit({ type: "assistant", message: { content: [
          ...(msg.thinking ? [{ type: "thinking", thinking: msg.thinking }] : []),
          ...(msg.content ? [{ type: "text", text: msg.content }] : []),
          ...calls.map((c) => ({ type: "tool_use", name: c.function.name, input: c.function.arguments ?? {} }))
        ] } });
        if (!calls.length) { answer = msg.content ?? ""; break; }
        for (const c of calls) {
          const name = c.function.name, input = c.function.arguments ?? {};
          let text;
          if (name === "WebFetch") {
            denials.push({ tool_name: "WebFetch", tool_input: input });
            text = "Permission to use WebFetch has been denied by the user's settings.";
          } else if (name.startsWith(`mcp__${SERVER}__`)) {
            try {
              const r = await client.callTool({ name: name.slice(`mcp__${SERVER}__`.length), arguments: input });
              text = (r.content ?? []).map((x) => x.text ?? "").join("\n");
            } catch (err) {
              text = `Tool error: ${String(err).slice(0, 300)}`;
            }
          } else {
            text = `Unknown tool ${name}`;
          }
          emit({ type: "user", message: { content: [{ type: "tool_result", name, content: text }] } });
          messages.push({ role: "tool", tool_name: name, content: text });
        }
        if (step === MAX_STEPS - 1) answer = "(stopped: step limit)";
      }
    } catch (err) {
      isError = true;
      answer = String(err).slice(0, 500);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
    }
    emit({ type: "result", result: answer, is_error: isError, num_turns: turns, permission_denials: denials, total_cost_usd: 0 });
    writeFileSync(ctx.file, ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { exit: isError ? 1 : 0, timedOut: ctrl.signal.aborted, stderr: isError ? answer : null, usage: { turns, model_digest: digest } };
  }
};
