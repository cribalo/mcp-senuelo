// Former Ollama lab runner (tanda 3), kept so the commands in LABORATORIO.md still work.
// It now runs scripts/lab/run.mjs with the ollama adapter; all options pass through.
// Usage: node scripts/lab-local.mjs --variant published|silent [--models gemma4:12b-it-qat,…] [--reps 2] [--tasks T1,T4]
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [new URL("./lab/run.mjs", import.meta.url).pathname, "--client", "ollama", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
