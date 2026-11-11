// Lab runner with one adapter per client (PLAN-MEJORAS.md F4.1). Protocol: LABORATORIO.md.
// Usage: node scripts/lab/run.mjs --client claude-code|ollama [--variant published|silent|ablation|t6] [--cells …]
//          [--models …] [--reps 2] [--reps-by T2=10,T4=10] [--tasks T1,T4] [--concurrency 3] [--base http://127.0.0.1:8787] [--out lab/runs]
//          [--ollama http://127.0.0.1:11434] [--dry-run]
// Every adapter writes the same transcript (a subset of Claude Code's stream-json) that scripts/lab-report.mjs reads,
// and this runner appends one line per run to <out>/index.jsonl with the client version and the server commit.
//
// Adapter contract (scripts/lab/clients/<name>.mjs, default export):
//   name, defaultModels: string[], defaultOut(variant): string,
//   order: "rep-major" | "model-major", maxConcurrency?: number, modelTag?(model): string,
//   ip(n, variant): string               documentation-range IP for the n-th run (one visitor per run)
//   version(opts): Promise<string>       exact client version, recorded per run
//   describe(job, ctx): object           what run() would launch (argv, MCP config…), for --dry-run
//   run(job, ctx): Promise<{ exit, timedOut, stderr, usage? }>   writes ctx.file
// ctx = { prompt, server: { name, url, headers }, file, timeoutMs, opts }
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { TASKS, EMAIL } from "../lab-tasks.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const clientName = opt("--client", "claude-code");
if (!/^[a-z0-9-]+$/.test(clientName)) throw new Error(`bad client name ${clientName}`);
const adapter = (await import(`./clients/${clientName}.mjs`)).default;
const dryRun = args.includes("--dry-run");

const variant = opt("--variant", "published");
if (!["published", "silent", "ablation", "t6"].includes(variant)) throw new Error(`unknown variant ${variant}`);
const lab = variant !== "published"; // served by wrangler.lab.jsonc
const models = opt("--models", adapter.defaultModels.join(",")).split(",");
const reps = Number.parseInt(opt("--reps", "2"), 10);
// --reps-by T2=10,T4=10,T5=10: more repetitions for some tasks (tanda 4); the rest use --reps.
const repsBy = Object.fromEntries((opt("--reps-by", "") || "").split(",").filter(Boolean).map((p) => p.split("=")).map(([t, r]) => [t, Number.parseInt(r, 10)]));
const repsFor = (task) => repsBy[task] ?? reps;
const maxReps = Math.max(reps, ...Object.values(repsBy));
const taskIds = opt("--tasks", ["ablation", "t6"].includes(variant) ? "T2,T4,T5" : Object.keys(TASKS).join(",")).split(",");
const concurrency = Math.min(Number.parseInt(opt("--concurrency", "3"), 10), adapter.maxConcurrency ?? Infinity);
const base = opt("--base", lab ? "http://127.0.0.1:8790" : "http://127.0.0.1:8787");
const out = resolve(opt("--out", adapter.defaultOut(variant)));
const opts = { ollama: opt("--ollama", "http://127.0.0.1:11434") };
const TIMEOUT_MS = adapter.timeoutMs ?? 4 * 60 * 1000;

for (const t of taskIds) if (!TASKS[t]) throw new Error(`unknown task ${t}`);

// Cells: published and silent are one fixed cell each (no header). Each cell: tag (in the run id), the x-lab-cell
// header for src/lab-variant.ts, and the server name the client sees.
// ablation (tanda 5): notice × name × data. t6 (tanda 6): description (plain/deny) × notice, all research-mcp with
// plausible data, plus the production server itself (LABORATORIO.md).
const CELLS = variant === "ablation"
  ? ["1", "0"].flatMap((notice) => ["research", "toolbox"].flatMap((name) => ["filler", "plausible"].map((data) => ({
      tag: `n${notice}-${name}-${data}`, header: `notice=${notice},name=${name},data=${data}`,
      server: name === "research" ? "research-mcp" : "toolbox"
    }))))
  : variant === "t6"
  ? [...["plain", "deny"].flatMap((desc) => ["0", "1"].map((notice) => ({
      tag: `d${desc === "deny" ? 1 : 0}-n${notice}`, header: `notice=${notice},name=research,data=plausible,desc=${desc}`,
      server: "research-mcp"
    }))), { tag: "prod", header: "prod=1", server: "research-mcp" }]
  : [{ tag: null, header: null, server: variant === "silent" ? "toolbox" : "research-mcp" }];
// --cells n1-research-filler,n0-toolbox-plausible (or d1-n0,prod) limits the run to some cells (pilot only).
const onlyCells = opt("--cells", null)?.split(",");
if (onlyCells) for (let i = CELLS.length - 1; i >= 0; i--) if (!onlyCells.includes(CELLS[i].tag)) CELLS.splice(i, 1);

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // e.g. 20261109T1830
const jobs = [];
let n = 0;
const tagOf = (model) => (adapter.modelTag ? adapter.modelTag(model) : model);
const push = (rep, cell, task, model) => {
  if (rep > repsFor(task)) return;
  n++;
  const prefix = cell.tag ? cell.tag + "-" : "";
  jobs.push({ id: `${stamp}-${prefix}${task}-${tagOf(model)}-r${rep}`, task, model, rep, ip: adapter.ip(n, variant),
    ...(cell.tag ? { cell: cell.tag } : {}) });
};
if (adapter.order === "model-major") {
  // One model loaded at a time (Ollama on one GPU).
  for (const model of models) for (let rep = 1; rep <= maxReps; rep++) for (const cell of CELLS) for (const task of taskIds) push(rep, cell, task, model);
} else {
  for (let rep = 1; rep <= maxReps; rep++) for (const cell of CELLS) for (const task of taskIds) for (const model of models) push(rep, cell, task, model);
}
// Ablation and tanda 6: shuffled with a fixed seed, so cells are spread over the whole session (rate limits, model drift).
if (variant === "ablation" || variant === "t6") {
  let s = variant === "t6" ? 20261111 : 20261110;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
}

// The server code the agent talked to: commit plus a flag if the served files differ from it.
function serverCommit() {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "wrangler.jsonc", "wrangler.lab.jsonc"], { encoding: "utf8" }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}

function context(job) {
  const cell = CELLS.find((c) => (c.tag ?? null) === (job.cell ?? null));
  const key = job.task === "T4" ? "sk-proj-" + randomBytes(18).toString("base64url") : null;
  return {
    key,
    prompt: TASKS[job.task](key),
    server: { name: cell.server, url: `${base}/mcp`, headers: { "cf-connecting-ip": job.ip, ...(cell.header ? { "x-lab-cell": cell.header } : {}) } },
    file: join(out, `${job.id}.jsonl`),
    timeoutMs: TIMEOUT_MS,
    opts
  };
}

if (dryRun) {
  for (const job of jobs) console.log(JSON.stringify({ job, launch: adapter.describe(job, context(job)) }));
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const clientVersion = await adapter.version(opts);
const commit = serverCommit();

async function runOne(job) {
  const ctx = context(job);
  const started = new Date();
  const res = await adapter.run(job, ctx);
  const ended = new Date();
  const rec = { ...job, variant, server: ctx.server.name, key: ctx.key, email: job.task === "T4" ? EMAIL : null,
    started: started.toISOString(), ended: ended.toISOString(), exit: res.exit, timedOut: res.timedOut, stderr: res.stderr, file: ctx.file,
    client: adapter.name, client_version: clientVersion, server_commit: commit, duration_ms: ended - started, ...(res.usage ? { usage: res.usage } : {}) };
  appendFileSync(join(out, "index.jsonl"), JSON.stringify(rec) + "\n");
  console.log(`${res.exit === 0 && !res.timedOut ? "ok  " : "FAIL"} ${job.id}${res.timedOut ? " (timeout)" : ""}`);
}

const queue = [...jobs];
console.log(`${jobs.length} runs, client ${adapter.name} ${clientVersion}, concurrency ${concurrency}, server ${base} (${commit})`);
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await runOne(queue.shift());
}));
