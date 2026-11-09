// Lab runner: real Claude Code agents against a local copy of the decoy. Protocol: LABORATORIO.md.
// Start the server first:  npx wrangler dev --port 8787 --ip 127.0.0.1 --local-upstream mcp.cribalo.com
// Usage: node scripts/lab.mjs [--variant published|silent] [--models haiku,sonnet,opus] [--reps 2] [--tasks T1,T4] [--concurrency 3]
//                             [--base http://127.0.0.1:8787] [--out lab/runs]
// Transcripts (stream-json) go to <out>/<id>.jsonl; one line per run is appended to <out>/index.jsonl.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TASKS, EMAIL } from "./lab-tasks.mjs";

// Tanda 1: the decoy as published, under its MCP Registry name. Tanda 2 (--variant silent): the lab-only
// variant without the notice (src/lab-silent.ts, wrangler.lab.jsonc on port 8790), under a neutral name.
// The exact task texts live in lab-tasks.mjs, shared with lab-local.mjs.

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const variant = opt("--variant", "published");
if (!["published", "silent"].includes(variant)) throw new Error(`unknown variant ${variant}`);
const SERVER = variant === "silent" ? "toolbox" : "research-mcp";
const models = opt("--models", "haiku,sonnet,opus").split(",");
const reps = Number.parseInt(opt("--reps", "2"), 10);
const taskIds = opt("--tasks", Object.keys(TASKS).join(",")).split(",");
const concurrency = Number.parseInt(opt("--concurrency", "3"), 10);
const base = opt("--base", variant === "silent" ? "http://127.0.0.1:8790" : "http://127.0.0.1:8787");
const out = resolve(opt("--out", variant === "silent" ? "lab/runs-t2" : "lab/runs"));
const TIMEOUT_MS = 4 * 60 * 1000;

for (const t of taskIds) if (!TASKS[t]) throw new Error(`unknown task ${t}`);
mkdirSync(out, { recursive: true });

// A clean child environment: nothing inherited from the Claude session that runs this script.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)/.test(k))
);

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // e.g. 20261109T1830
const jobs = [];
let n = 0;
for (let rep = 1; rep <= reps; rep++)
  for (const task of taskIds)
    for (const model of models) {
      n++;
      // Documentation ranges (RFC 5737): one hashed IP, so one visitor and one rate-limit bucket, per run.
      const ip = n <= 254 ? `192.0.2.${n}` : `198.51.100.${n - 254}`;
      jobs.push({ id: `${stamp}-${task}-${model}-r${rep}`, task, model, rep, ip });
    }

function runOne(job) {
  return new Promise((done) => {
    const key = job.task === "T4" ? "sk-proj-" + randomBytes(18).toString("base64url") : null;
    const cwd = mkdtempSync(join(tmpdir(), "workspace-"));
    const cfg = join(cwd, "..", `${job.id}.mcp.json`);
    writeFileSync(cfg, JSON.stringify({
      mcpServers: { [SERVER]: { type: "http", url: `${base}/mcp`, headers: { "cf-connecting-ip": job.ip } } }
    }));
    const argv = [
      "-p", TASKS[job.task](key),
      "--model", job.model,
      "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", "--mcp-config", cfg,
      "--tools", "WebFetch",
      "--allowedTools", `mcp__${SERVER}`,
      "--permission-mode", "dontAsk",
      "--setting-sources", "",
      "--no-session-persistence"
    ];
    const started = new Date().toISOString();
    const file = join(out, `${job.id}.jsonl`);
    const sink = createWriteStream(file);
    const child = spawn("claude", argv, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stdout.pipe(sink);
    child.stderr.on("data", (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      sink.end();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(cfg, { force: true });
      const rec = { ...job, variant, server: SERVER, key, email: job.task === "T4" ? EMAIL : null, started, ended: new Date().toISOString(),
        exit: code, timedOut, stderr: stderr.trim().slice(-500) || null, file };
      appendFileSync(join(out, "index.jsonl"), JSON.stringify(rec) + "\n");
      console.log(`${code === 0 && !timedOut ? "ok  " : "FAIL"} ${job.id}${timedOut ? " (timeout)" : ""}`);
      done(rec);
    });
  });
}

const queue = [...jobs];
console.log(`${jobs.length} runs, concurrency ${concurrency}, server ${base}`);
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await runOne(queue.shift());
}));
