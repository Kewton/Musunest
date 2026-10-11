// 受入の試験：P1〜P10 × 回数 を、プロダクト内の工場（factory:run）で流す。API を呼ぶ（窓口の手元だけで使う）。
// 使い方: OPENAI_API_KEY=... node run-agent.mjs <repo> <out> --effort low|medium|high [--runs 5] [--concurrency 3] [--only P1,P3] [--budget-usd 15] [--plan] [--resume]
//   --plan：Plan を通す（答えは空のファイル＝すべて推奨。#378）。費用は Plan と Build を合わせた額で数える
//   --resume：前の計測の続きから流す（#400）。保存した条件と一致し、全文と要約がそろっているときだけ許す
//   --model / --factory-budget-usd / --deadline-min：工場へ渡す値。既定は工場の dist が公開する既定値（別に手書きしない）
//   --budget-usd：計測全体の停止の目安の額。**起動中の本の予約を含まない**（終わった本の額だけを足す）
// 採点は: node score-agent.mjs <repo> <out> [--label high]（リポジトリ・出力先の順で渡す）
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// 工場の dist を実際に読んで、既定値と段ごとの出力の上限を得る（条件の値と、子へ渡す値を同じ所から出す）
const distDir = join(repo, "packages/factory/dist");
const cliFile = join(distDir, "cli.js");
const factory = await import(pathToFileURL(cliFile).href);
const openai = await import(pathToFileURL(join(distDir, "openai.js")).href);
const limits = await import(pathToFileURL(join(distDir, "limits.js")).href);

const effort = opt("--effort", factory.DEFAULT_EFFORT), RUNS = Number(opt("--runs", "5")), CONC = Number(opt("--concurrency", "3"));
const only = opt("--only", null)?.split(","), budget = Number(opt("--budget-usd", "15"));
const plan = args.includes("--plan"), resume = args.includes("--resume");
const model = opt("--model", openai.DEFAULT_OPENAI_MODEL);
const perRunBudget = Number(opt("--factory-budget-usd", String(factory.DEFAULT_BUDGET_USD)));
const deadlineMin = Number(opt("--deadline-min", String(factory.DEFAULT_DEADLINE_MS / 60000)));

const tablePath = join(repo, "workspace/mvp/m1/grammar-trial/stage1-patterns.md");
const table = readFileSync(tablePath, "utf8");
const reqOf = (pid) => { const m = table.match(new RegExp(`\\*\\*${pid}（[^）]*）\\*\\*\\n\\n((?:> .*\\n?)+)`)); if (!m) throw new Error(pid); return m[1].replace(/^> ?/gm, "").trim(); };
const jobs = [];
for (let p = 1; p <= 10; p++) { const pid = `P${p}`; if (only && !only.includes(pid)) continue; for (let r = 1; r <= RUNS; r++) jobs.push({ pid, r }); }

const dirOf = (job) => join(outRoot, `${job.pid}-r${job.r}`);
// 子プロセスへ渡す引数を 1 か所で組み立て、条件のファイルもここから作る（既定値を別に手書きしない）
const childArgsFor = (job) => {
  const dir = dirOf(job);
  const argv = [cliFile, join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort, "--model", model, "--budget", String(perRunBudget), "--deadline", String(deadlineMin)];
  if (plan) argv.push("--plan", "--answers", join(dir, "answers.json"));
  return argv;
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const walkFiles = (dir, base = dir) => readdirSync(dir).sort().flatMap((name) => { const full = join(dir, name); return statSync(full).isDirectory() ? walkFiles(full, base) : [relative(base, full)]; });
// 実行する dist の指紋（中身のハッシュ）と、作り直したことの根拠（src より新しいか）
const fingerprintDir = (dir) => {
  if (!existsSync(dir)) return { fingerprint: null, files: 0, mtime_ms: null };
  const files = walkFiles(dir);
  const h = createHash("sha256");
  let mtime = 0;
  for (const rel of files) { const full = join(dir, rel); h.update(rel); h.update("\0"); h.update(sha256(readFileSync(full))); h.update("\n"); mtime = Math.max(mtime, statSync(full).mtimeMs); }
  return { fingerprint: h.digest("hex"), files: files.length, mtime_ms: files.length ? mtime : null };
};
const gitOut = (gitArgs) => { try { return execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

// 計測の条件。始めた時刻は補助（署名から外す）。条件の値は、子へ渡す引数と run-agent の指定から作る。
const probe = jobs[0] ?? { pid: only?.[0] ?? "P1", r: 1 };
const sampleArgv = childArgsFor(probe);
const argOf = (flag) => { const i = sampleArgv.indexOf(flag); return i >= 0 ? sampleArgv[i + 1] : undefined; };
const distInfo = fingerprintDir(distDir), srcInfo = fingerprintDir(join(repo, "packages/factory/src"));
const head = gitOut(["rev-parse", "HEAD"]), status = gitOut(["status", "--porcelain"]);
const measured = {
  schema: "musunest-factory/agent-accept-conditions/v1",
  measurement_id: basename(outRoot),
  source: { commit: head === null ? null : head.trim(), dirty: status === null ? null : status.trim().length > 0 },
  factory: { dist_dir: relative(repo, distDir), fingerprint: distInfo.fingerprint, rebuilt: distInfo.mtime_ms !== null && (srcInfo.mtime_ms === null || distInfo.mtime_ms >= srcInfo.mtime_ms) },
  document: { path: relative(repo, tablePath), sha256: sha256(table) },
  params: {
    effort: argOf("--effort"), model: argOf("--model"), plan: sampleArgv.includes("--plan"),
    answers_mode: sampleArgv.includes("--answers") ? "recommended" : "none",
    patterns: [...new Set(jobs.map((j) => j.pid))], runs: RUNS, concurrency: CONC, budget_usd: budget,
    factory_budget_usd: Number(argOf("--budget")), factory_deadline_min: Number(argOf("--deadline")),
    stage_output_limits: limits.STAGE_MAX_OUTPUT_TOKENS[effort] ?? limits.STAGE_MAX_OUTPUT_TOKENS[limits.DEFAULT_REASONING_EFFORT],
  },
  child_args: jobs.map((j) => ({ id: `${j.pid}-r${j.r}`, argv: childArgsFor(j) })),
};
const signature = sha256(JSON.stringify(measured));

const costOfDir = (dir) => { try { const sl = JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")); return sl.plan_cost?.total_usd ?? sl.summary?.provider_cost_usd ?? 0; } catch { return 0; } };
const refuse = (msg) => { console.error(`断りました: ${msg}`); process.exit(3); };

let spent = 0, stop = null, skipped = [], reopened = [], runQueue = [];
mkdirSync(outRoot, { recursive: true });
const conditionsPath = join(outRoot, "conditions.json");
const priorDirs = readdirSync(outRoot).filter((n) => /^P\d+-r\d+$/.test(n));
if (priorDirs.length > 0 || existsSync(conditionsPath)) {
  // 前の結果がある出力先では、既定では子プロセスを 1 本も起こさない（#400）
  if (!resume) refuse("出力先に前の計測の結果があります。続きから流すなら --resume を、新しい計測なら別の出力先を使ってください");
  if (!existsSync(conditionsPath)) refuse("条件のファイルの無い出力先です（新しい出力先を使ってください）");
  let saved = null; try { saved = JSON.parse(readFileSync(conditionsPath, "utf8")); } catch { refuse("条件のファイルを読めません"); }
  if (saved?.signature !== signature) refuse("保存した条件と今の条件が一致しません");
  for (const job of jobs) {
    const dir = dirOf(job);
    if (!existsSync(dir)) continue;
    if (!existsSync(join(dir, "summary.line.json"))) refuse(`要約の無い途中の本があります: ${job.pid}-r${job.r}`);
    if (!existsSync(join(dir, "stdout.log")) || !existsSync(join(dir, "stderr.log"))) refuse(`全文が欠けた古い出力があります: ${job.pid}-r${job.r}`);
  }
  // 終わった本の費用を足してから、残りの本だけを起こす。既存の条件・全文・要約は上書きしない
  const remaining = [];
  for (const job of jobs) {
    const dir = dirOf(job);
    if (existsSync(join(dir, "summary.line.json"))) { skipped.push(`${job.pid}-r${job.r}`); spent += costOfDir(dir); }
    else remaining.push(job);
  }
  console.log(`再開: 飛ばす ${skipped.length} 本、流す ${remaining.length} 本、済みの額 ${spent.toFixed(4)} USD を足した`);
  runQueue = remaining;
} else {
  writeFileSync(conditionsPath, JSON.stringify({ ...measured, started_at: new Date().toISOString(), signature }, null, 1));
  runQueue = [...jobs];
}

const runOne = (job) => new Promise((resolve) => {
  const dir = dirOf(job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), reqOf(job.pid) + "\n");
  if (plan) writeFileSync(join(dir, "answers.json"), "{}\n");
  const cliArgs = childArgsFor(job);
  const t0 = Date.now();
  const ch = spawn("node", cliArgs, { cwd: join(repo, "packages/factory"), env: process.env });
  // 入口の標準出力・標準エラーは、そのままのバイト列で残す（成功しても非 0 でも。書き終えてから次へ進む）
  const outChunks = [], errChunks = [];
  ch.stdout.on("data", (d) => outChunks.push(d)); ch.stderr.on("data", (d) => errChunks.push(d));
  ch.on("close", (code) => {
    const outBuf = Buffer.concat(outChunks), errBuf = Buffer.concat(errChunks);
    writeFileSync(join(dir, "stdout.log"), outBuf);
    writeFileSync(join(dir, "stderr.log"), errBuf);
    // 入口の出力の JSON の行を読む：生成の要約（headless-summary）と、--plan のときの Plan と Build の合計（plan-build-cost）
    const out = outBuf.toString("utf8");
    const lines = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x !== null);
    const s = lines.filter((x) => x.schema_version === "commandagent.headless-summary/v1").at(-1) ?? null;
    const planCost = lines.filter((x) => x.schema_version === "musunest-factory/plan-build-cost/v1").at(-1) ?? null;
    const cost = planCost?.total_usd ?? s?.provider_cost_usd ?? 0;
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, summary: s, plan_cost: planCost, stderr_tail: errBuf.toString("utf8").slice(-500), stdout_tail: s === null ? out.slice(-500) : undefined, resumed: job.resumed === true }, null, 1));
    spent += cost;
    console.log(`${job.pid}-r${job.r} effort=${effort}${plan ? " plan" : ""}${job.resumed ? " resume" : ""} exit=${code} verdict=${s?.verdict ?? "none"} cost=${cost.toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
    resolve();
  });
});

const queue = [...runQueue];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length && !stop) {
    if (spent >= budget) { stop = `予算 ${budget} USD に達した`; break; }
    const job = queue.shift();
    if (resume) { job.resumed = true; reopened.push(`${job.pid}-r${job.r}`); }
    await runOne(job);
  }
}));
if (resume) {
  // 再開した本・飛ばした本・終わっていない本を区別して残す（既存のファイルは上書きしない）
  writeFileSync(join(outRoot, `resume-${Date.now()}.json`), JSON.stringify({ resumed_at: new Date().toISOString(), skipped, reopened, pending: queue.map((j) => `${j.pid}-r${j.r}`), stop }, null, 1));
}
console.log("done", stop ?? "", "spent", spent.toFixed(4));
