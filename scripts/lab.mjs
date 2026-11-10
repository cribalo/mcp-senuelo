// Former Claude Code lab runner, kept so the commands in LABORATORIO.md still work.
// It now runs scripts/lab/run.mjs with the claude-code adapter; all options pass through.
// Usage: node scripts/lab.mjs [--variant published|silent|ablation|t6] [--cells …] [--models haiku,sonnet,opus] [--reps 2] …
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [new URL("./lab/run.mjs", import.meta.url).pathname, "--client", "claude-code", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
