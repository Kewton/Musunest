// 受入の試験：P1〜P10 × 回数 を、プロダクト内の工場（factory:run）で流す。API を呼ぶ（窓口の手元だけで使う）。
// 使い方: OPENAI_API_KEY=... node run-agent.mjs <repo> <out> --effort low|medium|high [--runs 5] [--concurrency 3] [--only P1,P3] [--budget-usd 15] [--plan] [--resume]
//   --plan：Plan を通す（答えは空のファイル＝すべて推奨。#378）。費用は Plan と Build を合わせた額で数える
//   --resume：前の計測の続きから流す（#400）。保存した条件と一致し、全文と要約がそろっているときだけ許す
//   --model / --factory-budget-usd / --deadline-min：工場へ渡す値。既定は工場の dist が公開する既定値（別に手書きしない）
//   --budget-usd：計測全体の停止の目安の額。**起動中の本の予約を含まない**（終わった本の額だけを足す）
// 条件のファイル（conditions.json。#425 で v2）には、工場の dist に加えて spec-engine の dist・生成に渡す文書（契約・語彙の意味・語彙の台帳）・
//   採点の定義と集計のコード・判定の口の構成（鍵そのものは書かない）の指紋を残す。1 回の起動ごとに run-<時刻>.json（流した本・残りの本・止まった理由と
//   そのコード・その起動で有効だった計測全体の目安の額と初回の条件との差・済みの額）を残す。署名が保証するのは生成の条件であって、管理の条件
//   （計測全体の目安の額）まで含めた一致ではない。再開で変えた値は起動の記録から読む
// 採点は: node score-agent.mjs <repo> <out> [--label high]（リポジトリ・出力先の順で渡す）
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fingerprintDir, scoringFingerprint, sha256 } from "./score-agent.mjs";

const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// 工場の dist を実際に読んで、既定値と段ごとの出力の上限を得る（条件の値と、子へ渡す値を同じ所から出す）
const distDir = join(repo, "packages/factory/dist");
const cliFile = join(distDir, "cli.js");
const factory = await import(pathToFileURL(cliFile).href);
const openai = await import(pathToFileURL(join(distDir, "openai.js")).href);
const limits = await import(pathToFileURL(join(distDir, "limits.js")).href);
// 生成に渡す文書の置き場所は、工場の入口と同じ appspec-schema の files から引く（cli.ts の loadDocumentsFromFiles）
const schemaFiles = await import(pathToFileURL(join(repo, "packages/appspec-schema/dist/files.js")).href);

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
const idOf = (job) => `${job.pid}-r${job.r}`;
// 子プロセスへ渡す引数を 1 か所で組み立て、条件のファイルもここから作る（既定値を別に手書きしない）
const childArgsFor = (job) => {
  const dir = dirOf(job);
  const argv = [cliFile, join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort, "--model", model, "--budget", String(perRunBudget), "--deadline", String(deadlineMin)];
  if (plan) argv.push("--plan", "--answers", join(dir, "answers.json"));
  return argv;
};

const gitOut = (gitArgs) => { try { return execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

// 計測の条件。始めた時刻は補助（署名から外す）。条件の値は、子へ渡す引数と run-agent の指定から作る。
const probe = jobs[0] ?? { pid: only?.[0] ?? "P1", r: 1 };
const sampleArgv = childArgsFor(probe);
const argOf = (flag) => { const i = sampleArgv.indexOf(flag); return i >= 0 ? sampleArgv[i + 1] : undefined; };
const distInfo = fingerprintDir(distDir), srcInfo = fingerprintDir(join(repo, "packages/factory/src"));
const specEngineDist = join(repo, "packages/spec-engine/dist"), specEngineInfo = fingerprintDir(specEngineDist);
const contractDir = fileURLToPath(schemaFiles.packageFile(`${schemaFiles.CONTRACT_DIR}/`)), contractInfo = fingerprintDir(contractDir);
const semanticsPath = fileURLToPath(schemaFiles.semanticsFile()), vocabularyPath = fileURLToPath(schemaFiles.vocabularyFile());
// files が import.meta.url から引く場所は実体のパス（symlink を解いた形）なので、リポジトリ側も解いてから相対にする
const relToRepo = (p) => relative(realpathSync(repo), realpathSync(p));
const evDir = join(repo, "workspace/mvp/m1/agent/eval");
// 判定の口の構成（cli.ts の assembleJudge と同じ条件）：Jev の鍵の環境変数が空でなければ Jev を主・LLM を落とし先、無ければ LLM だけ。鍵の値は記録しない
const jevEnv = factory.JEV_API_KEY_ENV;
if (typeof jevEnv !== "string") throw new Error("工場の dist が JEV_API_KEY_ENV を公開していないので、判定の口の構成を記録できない");
const jevKey = process.env[jevEnv];
const judge = { configuration: jevKey !== undefined && jevKey !== "" ? "jev-primary-llm-fallback" : "llm-only", jev_key_env: jevEnv };
const head = gitOut(["rev-parse", "HEAD"]), status = gitOut(["status", "--porcelain"]);
const measured = {
  schema: "musunest-factory/agent-accept-conditions/v2",
  measurement_id: basename(outRoot),
  source: { commit: head === null ? null : head.trim(), dirty: status === null ? null : status.trim().length > 0 },
  factory: { dist_dir: relative(repo, distDir), fingerprint: distInfo.fingerprint, rebuilt: distInfo.mtime_ms !== null && (srcInfo.mtime_ms === null || distInfo.mtime_ms >= srcInfo.mtime_ms) },
  spec_engine: { dist_dir: relative(repo, specEngineDist), fingerprint: specEngineInfo.fingerprint, files: specEngineInfo.files },
  document: { path: relative(repo, tablePath), sha256: sha256(table) },
  prompt_documents: {
    contract: { dir: relToRepo(contractDir), fingerprint: contractInfo.fingerprint, files: contractInfo.files },
    semantics: { path: relToRepo(semanticsPath), sha256: sha256(readFileSync(semanticsPath)) },
    vocabulary: { path: relToRepo(vocabularyPath), sha256: sha256(readFileSync(vocabularyPath)) },
  },
  judge,
  params: {
    effort: argOf("--effort"), model: argOf("--model"), plan: sampleArgv.includes("--plan"),
    answers_mode: sampleArgv.includes("--answers") ? "recommended" : "none",
    patterns: [...new Set(jobs.map((j) => j.pid))], runs: RUNS, concurrency: CONC, budget_usd: budget,
    factory_budget_usd: Number(argOf("--budget")), factory_deadline_min: Number(argOf("--deadline")),
    stage_output_limits: limits.STAGE_MAX_OUTPUT_TOKENS[effort] ?? limits.STAGE_MAX_OUTPUT_TOKENS[limits.DEFAULT_REASONING_EFFORT],
  },
  child_args: jobs.map((j) => ({ id: idOf(j), argv: childArgsFor(j) })),
  // 採点の定義と集計のコードの指紋（<repo> の採点器）。署名からは外す：採点は生成のあとに全本へ同じ版を当てるもので、採点の出力が
  // 実際に実行した集計のコードの指紋をこの値と照合する（score-agent.mjs）。ただし source.commit・source.dirty は署名に残るので、
  // clean な checkout を編集したり採点だけの commit を積んだりすれば再開は断られる。外す効果があるのは source が変わらない場合に限る
  scoring: { dir: relative(repo, evDir), ...scoringFingerprint(evDir) },
};
// 署名（--resume の一致の判定）から外すもの：started_at（補助）、scoring（上）、params.budget_usd（計測全体の停止の目安。
// 予算で止まった計測を --budget-usd を上げて流し切れるようにする。工場 1 本の予算 factory_budget_usd は生成の条件なので残す）。
// 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）の一致ではない。有効だった額は起動の記録（下）に残す
const { scoring: _scoring, ...generationConditions } = measured;
const { budget_usd: _budget, ...paramsForSignature } = measured.params;
const signature = sha256(JSON.stringify({ ...generationConditions, params: paramsForSignature }));

const costOfDir = (dir) => { try { const sl = JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")); return sl.plan_cost?.total_usd ?? sl.summary?.provider_cost_usd ?? 0; } catch { return 0; } };
const refuse = (msg) => { console.error(`断りました: ${msg}`); process.exit(3); };

let spent = 0, stop = null, stopCode = null, skipped = [], reopened = [], executed = [], runQueue = [];
// この起動で有効な計測全体の目安の額（budget）と、初回の条件のファイルに記録した額。再開で変えたかどうかを起動の記録に残す
let initialBudget = budget;
mkdirSync(outRoot, { recursive: true });
const conditionsPath = join(outRoot, "conditions.json");
const priorDirs = readdirSync(outRoot).filter((n) => /^P\d+-r\d+$/.test(n));
if (priorDirs.length > 0 || existsSync(conditionsPath)) {
  // 前の結果がある出力先では、既定では子プロセスを 1 本も起こさない（#400）
  if (!resume) refuse("出力先に前の計測の結果があります。続きから流すなら --resume を、新しい計測なら別の出力先を使ってください");
  if (!existsSync(conditionsPath)) refuse("条件のファイルの無い出力先です（新しい出力先を使ってください）");
  let saved = null; try { saved = JSON.parse(readFileSync(conditionsPath, "utf8")); } catch { refuse("条件のファイルを読めません"); }
  if (saved?.signature !== signature) refuse("保存した条件と今の条件が一致しません");
  initialBudget = typeof saved.params?.budget_usd === "number" ? saved.params.budget_usd : null;
  for (const job of jobs) {
    const dir = dirOf(job);
    if (!existsSync(dir)) continue;
    if (!existsSync(join(dir, "summary.line.json"))) refuse(`要約の無い途中の本があります: ${idOf(job)}`);
    if (!existsSync(join(dir, "stdout.log")) || !existsSync(join(dir, "stderr.log"))) refuse(`全文が欠けた古い出力があります: ${idOf(job)}`);
  }
  // 終わった本の費用を足してから、残りの本だけを起こす。既存の条件・全文・要約は上書きしない
  const remaining = [];
  for (const job of jobs) {
    const dir = dirOf(job);
    if (existsSync(join(dir, "summary.line.json"))) { skipped.push(idOf(job)); spent += costOfDir(dir); }
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
    console.log(`${idOf(job)} effort=${effort}${plan ? " plan" : ""}${job.resumed ? " resume" : ""} exit=${code} verdict=${s?.verdict ?? "none"} cost=${cost.toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
    resolve();
  });
});

const queue = [...runQueue];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length && !stop) {
    if (spent >= budget) { stop = `予算 ${budget} USD に達した`; stopCode = "budget"; break; }
    const job = queue.shift();
    if (resume) { job.resumed = true; reopened.push(idOf(job)); }
    executed.push(idOf(job));
    await runOne(job);
  }
}));
const pending = queue.map(idOf);
if (resume) {
  // 再開した本・飛ばした本・終わっていない本を区別して残す（既存のファイルは上書きしない）
  writeFileSync(join(outRoot, `resume-${Date.now()}.json`), JSON.stringify({ resumed_at: new Date().toISOString(), skipped, reopened, pending, stop, stop_code: stopCode, budget_usd: budget }, null, 1));
}
// 1 回の起動の記録：流した本・残りの本・止まった理由（文とコード。予算で止まった計測を採点の道具が「未完了」と照合するための根拠。#425）と、
// この起動で有効だった計測全体の目安の額（budget_usd）・初回の条件の額（initial_budget_usd。条件のファイルは初回の値のまま上書きしない）・
// 変えたかどうか（budget_changed）・済みの額（spent_usd）。完走した再開でも残すので、署名が同じでも管理の条件の変更履歴を読める
writeFileSync(join(outRoot, `run-${Date.now()}.json`), JSON.stringify({ finished_at: new Date().toISOString(), mode: resume ? "resume" : "fresh", executed, pending, stop, stop_code: stopCode, budget_usd: budget, initial_budget_usd: initialBudget, budget_changed: initialBudget === null ? null : initialBudget !== budget, spent_usd: spent }, null, 1));
console.log("done", stop ?? "", "spent", spent.toFixed(4));
