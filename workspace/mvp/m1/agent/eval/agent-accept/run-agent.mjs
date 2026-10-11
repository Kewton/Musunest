// 受入の試験：P1〜P10 × 回数 を、プロダクト内の工場（factory:run）で流す。API を呼ぶ（窓口の手元だけで使う）。
// 使い方: OPENAI_API_KEY=... node run-agent.mjs <repo> <out> --effort low|medium|high [--runs 5] [--concurrency 3] [--only P1,P3] [--budget-usd 15] [--plan]
// --plan：Plan を通す（答えは空のファイル＝すべて推奨。#378）。費用は Plan と Build を合わせた額で数える
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const effort = opt("--effort", "high"), RUNS = Number(opt("--runs", "5")), CONC = Number(opt("--concurrency", "3"));
const only = opt("--only", null)?.split(","), budget = Number(opt("--budget-usd", "15"));
const plan = args.includes("--plan");
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
  const cliArgs = [join(repo, "packages/factory/dist/cli.js"), join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort];
  if (plan) {
    writeFileSync(join(dir, "answers.json"), "{}\n");
    cliArgs.push("--plan", "--answers", join(dir, "answers.json"));
  }
  const t0 = Date.now();
  const ch = spawn("node", cliArgs, { cwd: join(repo, "packages/factory"), env: process.env });
  let out = "", err = "";
  ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (err += d));
  ch.on("close", (code) => {
    // 入口の出力の JSON の行を読む：生成の要約（headless-summary）と、--plan のときの Plan と Build の合計（plan-build-cost）
    const lines = out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x !== null);
    const s = lines.filter((x) => x.schema_version === "commandagent.headless-summary/v1").at(-1) ?? null;
    const planCost = lines.filter((x) => x.schema_version === "musunest-factory/plan-build-cost/v1").at(-1) ?? null;
    const cost = planCost?.total_usd ?? s?.provider_cost_usd ?? 0;
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, summary: s, plan_cost: planCost, stderr_tail: err.slice(-500), stdout_tail: s === null ? out.slice(-500) : undefined }, null, 1));
    spent += cost;
    console.log(`${job.pid}-r${job.r} effort=${effort}${plan ? " plan" : ""} exit=${code} verdict=${s?.verdict ?? "none"} cost=${cost.toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
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
