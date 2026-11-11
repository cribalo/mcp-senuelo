// Adapter: Claude Code in headless mode (`claude -p`), tandas 1, 2, 5 and 6 (LABORATORIO.md).
// Same launch as the former scripts/lab.mjs: only the decoy as MCP server, WebFetch as the only own tool (denied by
// dontAsk), the decoy's tools pre-approved, no user or project settings, no session saved, clean environment.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A clean child environment: nothing inherited from the Claude session that runs the lab.
const childEnv = () => Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)/.test(k))
);

function argv(job, ctx, cfg) {
  return [
    "-p", ctx.prompt,
    "--model", job.model,
    "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", cfg,
    "--tools", "WebFetch",
    "--allowedTools", `mcp__${ctx.server.name}`,
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--no-session-persistence"
  ];
}
const mcpConfig = (ctx) => ({ mcpServers: { [ctx.server.name]: { type: "http", url: ctx.server.url, headers: ctx.server.headers } } });

export default {
  name: "claude-code",
  defaultModels: ["haiku", "sonnet", "opus"],
  defaultOut: (variant) => ({ published: "lab/runs", silent: "lab/runs-t2", ablation: "lab/runs-t5", t6: "lab/runs-t6" }[variant]),
  order: "rep-major",
  // Documentation ranges (RFC 5737): one hashed IP, so one visitor and one rate-limit bucket, per run.
  ip: (n) => (n <= 254 ? `192.0.2.${n}` : n <= 508 ? `198.51.100.${n - 254}` : `203.0.113.${n - 508}`),
  timeoutMs: 4 * 60 * 1000,

  async version() {
    return execFileSync("claude", ["--version"], { encoding: "utf8", env: childEnv() }).trim();
  },

  describe(job, ctx) {
    return { argv: argv(job, ctx, "<config>"), mcpConfig: mcpConfig(ctx), cwd: "<tmp>/workspace-XXXXXX" };
  },

  run(job, ctx) {
    return new Promise((done) => {
      // The model sees its working directory: the name must not give the setup away (LABORATORIO.md changelog).
      const cwd = mkdtempSync(join(tmpdir(), "workspace-"));
      const cfg = join(cwd, "..", `${job.id}.mcp.json`);
      writeFileSync(cfg, JSON.stringify(mcpConfig(ctx)));
      const sink = createWriteStream(ctx.file);
      const child = spawn("claude", argv(job, ctx, cfg), { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let timedOut = false;
      child.stdout.pipe(sink);
      child.stderr.on("data", (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, ctx.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        sink.end(() => {
          rmSync(cwd, { recursive: true, force: true });
          rmSync(cfg, { force: true });
          done({ exit: code, timedOut, stderr: stderr.trim().slice(-500) || null, usage: usageFrom(ctx.file) });
        });
      });
    });
  }
};

// Cost and tokens from the final `result` event, when Claude Code reports them.
function usageFrom(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "result") return { cost_usd: e.total_cost_usd ?? null, turns: e.num_turns ?? null, tokens: e.usage ?? null };
    } catch {}
  }
  return null;
}
