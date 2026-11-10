// Archive of the lab (lab/ is gitignored and holds the only copy of the transcripts and lab D1 state).
// Writes a dated tar.zst plus its SHA-256 to a directory outside the repository and checks the archive reads back.
// Usage: node scripts/lab-archive.mjs [--dest /root/lab-archive]
// Nothing is uploaded: a private remote copy needs the user's OK (PLAN-MEJORAS.md F1.8).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lab = join(repo, "lab");
const i = process.argv.indexOf("--dest");
const dest = resolve(i > 0 ? process.argv[i + 1] : "/root/lab-archive");
if (dest.startsWith(repo + "/") || dest === repo) throw new Error("the archive must live outside the repository");
if (!existsSync(lab)) throw new Error(`nothing to archive: ${lab} does not exist`);
mkdirSync(dest, { recursive: true });

let files = 0;
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files++));
walk(lab);

const commit = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const out = join(dest, `lab-${stamp}-${commit}.tar.zst`);
// -C repo lab: paths inside the archive start with lab/. --zstd needs GNU tar and the zstd binary.
execFileSync("tar", ["--zstd", "-cf", out, "-C", repo, "lab"], { stdio: "inherit" });

const hash = createHash("sha256");
await new Promise((ok, fail) => createReadStream(out).on("data", (c) => hash.update(c)).on("end", ok).on("error", fail));
const sha = hash.digest("hex");
writeFileSync(`${out}.sha256`, `${sha}  ${basename(out)}\n`);

// Read the archive back: same number of files.
const listed = execFileSync("tar", ["--zstd", "-tf", out], { encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n").filter((l) => l && !l.endsWith("/")).length;
if (listed !== files) throw new Error(`archive lists ${listed} files, lab/ has ${files}`);
console.log(`${out}\n${files} files, ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha}`);
