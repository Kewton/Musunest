// 受入の試験：P1〜P10 × 回数 を、プロダクト内の工場（factory:run）で流す。API を呼ぶ（窓口の手元だけで使う）。
// 使い方: OPENAI_API_KEY=... node run-agent.mjs <repo> <out> --effort medium|high [--runs 5] [--concurrency 3] [--only P1,P3] [--budget-usd 15]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const effort = opt("--effort", "high"), RUNS = Number(opt("--runs", "5")), CONC = Number(opt("--concurrency", "3"));
const only = opt("--only", null)?.split(","), budget = Number(opt("--budget-usd", "15"));
const table = readFileSync(join(repo, "workspace/mvp/m1/grammar-trial/stage1-patterns.md"), "utf8");
const reqOf = (pid) => { const m = table.match(new RegExp(`\\*\\*${pid}（[^）]*）\\*\\*\\n\\n((?:> .*\\n?)+)`)); if (!m) throw new Error(pid); return m[1].replace(/^> ?/gm, "").trim(); };
const jobs = [];
for (let p = 1; p <= 10; p++) { const pid = `P${p}`; if (only && !only.includes(pid)) continue; for (let r = 1; r <= RUNS; r++) jobs.push({ pid, r }); }
mkdirSync(outRoot, { recursive: true });
let spent = 0, stop = null;
const runOne = (job) => new Promise((resolve) => {
  const dir = join(outRoot, `${job.pid}-r${job.r}`);
  if (existsSync(join(dir, "summary.line.json"))) return resolve();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), reqOf(job.pid) + "\n");
  const t0 = Date.now();
  const ch = spawn("node", [join(repo, "packages/factory/dist/cli.js"), join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort], { cwd: join(repo, "packages/factory"), env: process.env });
  let out = "", err = "";
  ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (err += d));
  ch.on("close", (code) => {
    const last = out.trim().split("\n").at(-1) ?? "";
    let s = null; try { s = JSON.parse(last); } catch {}
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, summary: s, stderr_tail: err.slice(-500) }, null, 1));
    spent += s?.provider_cost_usd ?? 0;
    console.log(`${job.pid}-r${job.r} effort=${effort} exit=${code} verdict=${s?.verdict} cost=${(s?.provider_cost_usd ?? 0).toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
    resolve();
  });
});
const queue = [...jobs];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length && !stop) {
    if (spent >= budget) { stop = `予算 ${budget} USD に達した`; break; }
    await runOne(queue.shift());
  }
}));
console.log("done", stop ?? "", "spent", spent.toFixed(4));
