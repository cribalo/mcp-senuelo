// Adapter: opencode (https://opencode.ai) in headless mode (`opencode run --format json`) with local models through
// Ollama's OpenAI-compatible API. Installed outside the repository, pinned: /root/lab-tools/opencode (opencode-ai@1.19.5).
// Same profile as Claude Code in tandas 1 and 2: the decoy as the only MCP server with its tools pre-approved, webfetch
// as the only own tool (offered, and auto-rejected because headless runs reject every "ask"), every other built-in
// tool disabled, a fresh HOME per run (no user config, sessions or memory), no sharing, no update checks.
// Ollama models need a context of at least 16k tokens for opencode's system prompt: use a derived tag such as
// gemma4-lab:16k (Modelfile: FROM gemma4:12b-it-qat, PARAMETER num_ctx 16384, PARAMETER temperature 0.7).
// The raw opencode events are kept next to the transcript (<id>.raw.jsonl); the transcript itself is converted to the
// subset of Claude Code's stream-json that scripts/lab-report.mjs reads.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.LAB_OPENCODE_BIN ?? "/root/lab-tools/opencode/node_modules/.bin/opencode";
// Shared between runs: provider package and model catalogue only (no sessions, config or history).
const CACHE = process.env.LAB_OPENCODE_CACHE ?? "/root/lab-tools/opencode/cache";
const DISABLED = ["bash", "edit", "write", "read", "grep", "glob", "list", "patch", "todowrite", "todoread", "task", "skill",
  "lsp", "question", "websearch"];

function config(job, ctx) {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    enabled_providers: ["ollama"],
    model: `ollama/${job.model}`,
    small_model: `ollama/${job.model}`,
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: `${ctx.opts.ollama}/v1` },
        models: { [job.model]: { name: job.model, tool_call: true } }
      }
    },
    mcp: { [ctx.server.name]: { type: "remote", url: ctx.server.url, enabled: true, oauth: false, headers: ctx.server.headers } },
    tools: { ...Object.fromEntries(DISABLED.map((t) => [t, false])), webfetch: true },
    // "ask" keeps webfetch in the tool list and rejects it on use; "deny" would remove it from the list.
    permission: { webfetch: "ask", [`${ctx.server.name}_*`]: "allow" }
  };
}

function env(home) {
  return {
    PATH: process.env.PATH, TERM: "dumb", HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: CACHE
  };
}

// opencode events → the stream-json subset lab-report.mjs reads. MCP tools are named <server>_<tool> in opencode and
// mcp__<server>__<tool> in the transcript; webfetch becomes WebFetch.
function convert(raw, job, ctx) {
  const events = raw.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const prefix = `${ctx.server.name}_`;
  const out = [{ type: "system", subtype: "init", model: job.model, mcp_servers: [{ name: ctx.server.name, status: "configured" }] }];
  const denials = [];
  const texts = new Map(); // messageID → text
  let lastText = null, steps = 0, cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0 };
  for (const e of events) {
    const p = e.part ?? {};
    if (e.type === "step_start") steps++;
    if (e.type === "tool_use") {
      const name = p.tool?.startsWith(prefix) ? `mcp__${ctx.server.name}__${p.tool.slice(prefix.length)}` : p.tool === "webfetch" ? "WebFetch" : p.tool;
      out.push({ type: "assistant", message: { content: [{ type: "tool_use", name, input: p.state?.input ?? {} }] } });
      const result = p.state?.status === "error" ? `Error: ${p.state.error}` : p.state?.output ?? "";
      out.push({ type: "user", message: { content: [{ type: "tool_result", name, content: result }] } });
      if (p.state?.status === "error" && /rejected permission/i.test(p.state.error ?? "")) denials.push({ tool_name: name, tool_input: p.state?.input ?? {} });
    }
    if (e.type === "text" && p.text) {
      texts.set(p.messageID, (texts.get(p.messageID) ?? "") + p.text);
      lastText = p.messageID;
      out.push({ type: "assistant", message: { content: [{ type: "text", text: p.text }] } });
    }
    if (e.type === "reasoning" && p.text) out.push({ type: "assistant", message: { content: [{ type: "thinking", thinking: p.text }] } });
    if (e.type === "step_finish") {
      cost += p.cost ?? 0;
      for (const k of Object.keys(tokens)) tokens[k] += p.tokens?.[k] ?? 0;
    }
  }
  const answer = lastText ? texts.get(lastText) : "";
  return { out, answer, denials, steps, cost, tokens, empty: events.length === 0 };
}

export default {
  name: "opencode",
  defaultModels: ["gemma4-lab:16k"],
  defaultOut: (variant) => `lab/runs-oc-${variant}`,
  order: "model-major",
  maxConcurrency: 1, // one GPU
  modelTag: (model) => model.split(":")[0],
  ip: (n) => (n <= 254 ? `198.51.100.${n}` : `203.0.113.${n - 254}`),
  timeoutMs: 6 * 60 * 1000,

  async version(opts) {
    const oc = execFileSync(BIN, ["--version"], { encoding: "utf8", env: env(mkdtempSync(join(tmpdir(), "oc-v-"))) }).trim();
    const ol = await fetch(`${opts.ollama}/api/version`).then((r) => r.json()).catch(() => ({}));
    return `opencode ${oc} (ollama ${ol.version ?? "?"})`;
  },

  describe(job, ctx) {
    return { argv: [BIN, "run", "--format", "json", "--dir", "<tmp>/workspace-XXXXXX", ctx.prompt], config: config(job, ctx) };
  },

  run(job, ctx) {
    return new Promise((done) => {
      mkdirSync(CACHE, { recursive: true });
      const home = mkdtempSync(join(tmpdir(), "oc-home-"));
      // The model sees its working directory: the name must not give the setup away.
      const cwd = mkdtempSync(join(tmpdir(), "workspace-"));
      mkdirSync(join(home, ".config/opencode"), { recursive: true });
      writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify(config(job, ctx), null, 2));
      const rawFile = ctx.file.replace(/\.jsonl$/, ".raw.jsonl");
      const sink = createWriteStream(rawFile);
      const child = spawn(BIN, ["run", "--format", "json", "--dir", cwd, ctx.prompt], { cwd, env: env(home), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let timedOut = false;
      child.stdout.pipe(sink);
      child.stderr.on("data", (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, ctx.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        sink.end(async () => {
          const c = convert(readFileSync(rawFile, "utf8"), job, ctx);
          const isError = code !== 0 || timedOut || c.empty;
          c.out.push({ type: "result", result: c.answer, is_error: isError, num_turns: c.steps, permission_denials: c.denials,
            total_cost_usd: c.cost });
          writeFileSync(ctx.file, c.out.map((e) => JSON.stringify(e)).join("\n") + "\n");
          const tags = await fetch(`${ctx.opts.ollama}/api/tags`).then((r) => r.json()).catch(() => ({ models: [] }));
          const digest = tags.models?.find((m) => m.name === job.model || m.model === job.model)?.digest ?? null;
          rmSync(home, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
          // opencode prints ANSI colour codes in its notices; keep the text only.
          const err = stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-500) || null;
          done({ exit: isError ? (code || 1) : 0, timedOut, stderr: err, usage: { turns: c.steps, tokens: c.tokens, cost_usd: c.cost, model_digest: digest } });
        });
      });
    });
  }
};
