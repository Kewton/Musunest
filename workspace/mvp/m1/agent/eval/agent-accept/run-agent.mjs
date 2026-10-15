// 受入の試験：評価セットの定義ファイルの本 × 回数 を、プロダクト内の工場（factory:run）で流す。API を呼ぶ（窓口の手元だけで使う）。
// 使い方: OPENAI_API_KEY=... node run-agent.mjs <repo> <out> --effort low|medium|high [--runs 5] [--concurrency 3] [--only P1,P3] [--budget-usd 15]
//          [--plan [--script] | --plan-only [--script] | --build-from <凍結した組のファイル>] [--resume] [--set <定義ファイル>]
//   --set：評価セットの定義ファイル（#427。README §5.6）。既定は <repo> の sets/dev-p1-p10.json（今の P1〜P10 を同じ形で書き直したもの）。
//          依頼文・題材・書き方・書ける範囲・採点の定義・台本はここから読む。P 番号と題材の対応をこの道具の中に持たない。
//          定義ファイルの指紋は条件のファイルの set に書き、署名に入る。台本の指紋は scripts に書くが、--script が無ければ署名から外す（台本は採点で事後に当てる。--script は下。
//          --script が無いときの答えは今までどおり全部推奨）。
//          組が参照する採点の定義の実体は scoring の指紋に入る（definition:<題材>。subjects/ の外の定義も数える。fix-427）
//   v2 以前（#427 より前）の条件のファイルの計測は、この道具で再開できない（schema と set が署名に入るので一致しない。安全側の拒否。README §5.1）
//   --plan：Plan を通す（答えは空のファイル＝すべて推奨。#378）。費用は Plan と Build を合わせた額で数える
//   --plan-only：Plan だけを流す（子に --plan-only。#497）。答え方は --plan と同じ（--script があれば台本、無ければ空の答えのファイル）。Build は流さない
//   --script：--plan か --plan-only と組む（#497）。本ごとに定義ファイルの台本を本のディレクトリに写し、子に --script <写し> を渡す（実行中に事項で答える。
//          --answers は渡さない）。台本は署名に入る（scripts.mode が live）。台本の無い本が 1 本でもあれば断る
//   --build-from：凍結した組（freeze-plan-set.mjs の出力か、人が作る同じ形の組）の包みを本ごとに写し、子に --plan-file <写し> を渡す（Build だけ。#497）。
//          対象の本は既定で組が採用した P × 回数（--only は採用した P の部分集合だけ）。子を起こす前に、工場の dist の包みの検査の関数を写しと今の依頼文に当て、
//          組の SHA-256 と照らす（README §5.7）。組の指紋は条件の frozen に書き、署名に入る
//   断りは exit 3。標準エラーの 1 行に、固定の符号（[resume:signature] など）と本の ID・件数だけを出す（既存の断りは今までの文に符号を添える）。どの断りでも子を起こさない
//   --resume：前の計測の続きから流す（#400）。保存した条件と一致し、全文と要約がそろっているときだけ許す
//   --model / --factory-budget-usd / --deadline-min：工場へ渡す値。既定は工場の dist が公開する既定値（別に手書きしない）
//   --budget-usd：計測全体の停止の目安の額。**起動中の本の予約を含まない**（終わった本の額だけを足す）
//   v3 以前（#497 より前）の条件のファイルの計測も、この道具で再開できない（schema が署名に入る。v4 で params.mode・frozen を足した）
// 条件のファイル（conditions.json。#425 で v2・#427 で v3・#497 で v4）には、工場の dist に加えて spec-engine の dist・生成に渡す文書（契約・語彙の意味・語彙の台帳）・
//   採点の定義と集計のコード・判定の口の構成（鍵そのものは書かない）の指紋を残す。1 回の起動ごとに run-<時刻>.json（流した本・残りの本・止まった理由と
//   そのコード・その起動で有効だった計測全体の目安の額と初回の条件との差・済みの額）を残す。署名が保証するのは生成の条件であって、管理の条件
//   （計測全体の目安の額）まで含めた一致ではない。再開で変えた値は起動の記録から読む
// 採点は: node score-agent.mjs <repo> <out> [--label high]（リポジトリ・出力先の順で渡す）
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SET_PATH, FACTORY_VERDICTS, SCRIPT_MODE, fingerprintDir, loadEvalSet, scoringFingerprint, scriptsFingerprint, sha256 } from "./score-agent.mjs";
import { PLAN_FILE_CHECKS, PLAN_FILE_ERROR_SCHEMA, PLAN_FILE_REJECT_SCHEMA, checkEnvelope, loadFrozenSet, loadPlanFileChecks, refusalLine } from "./freeze-plan-set.mjs";

const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
// 断り（exit 3）：既存の断り（#400〜#427）は今までの文のあとに符号を添える。#497 で足した断りは符号と本の ID・件数だけ（値を出さない）
const refuse = (msg, code) => { console.error(refusalLine(code, { text: msg })); process.exit(3); };
const refuseCode = (code, opts) => { console.error(refusalLine(code, opts)); process.exit(3); };

// 評価セットの定義ファイル（#427）。欠けた欄があれば 1 本も起こさずに断る
const setPath = resolve(opt("--set", join(repo, DEFAULT_SET_PATH)));
const evalSet = loadEvalSet(setPath);
// 断りの文に入力の文字列（パス・任意の ID）を通さない（#497 の独立レビューの指摘 2）。理由は loadEvalSet の固定の文（値を含まない）
if (evalSet.status !== "ok") refuse(`定義ファイルを読めません: ${evalSet.reasons.join("、")}`, "set:invalid");

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
// #497：Plan だけ・台本・凍結した組から Build だけ。組めない組は子を起こす前に断る
const planOnly = args.includes("--plan-only"), script = args.includes("--script");
const buildFromIndex = args.indexOf("--build-from"), buildFrom = buildFromIndex >= 0 ? args[buildFromIndex + 1] ?? "" : null;
if (buildFrom !== null && (buildFrom === "" || buildFrom.startsWith("--"))) refuseCode("flags:conflict");
if ((plan && planOnly) || (buildFrom !== null && (plan || planOnly || script)) || (script && !plan && !planOnly)) refuseCode("flags:conflict");
/** 条件の params.mode：build（指定なし）・e2e（--plan）・plan-only・build-from */
const mode = buildFrom !== null ? "build-from" : planOnly ? "plan-only" : plan ? "e2e" : "build";
const model = opt("--model", openai.DEFAULT_OPENAI_MODEL);
const perRunBudget = Number(opt("--factory-budget-usd", String(factory.DEFAULT_BUDGET_USD)));
const deadlineMin = Number(opt("--deadline-min", String(factory.DEFAULT_DEADLINE_MS / 60000)));

// 依頼文は定義ファイルの本から組む（行を改行でつなぐ。request.md にはその末尾に改行を 1 つ足す）
const reqOf = (pid) => evalSet.byId.get(pid).requestText;
// 組の ID は条件の set.id にも書く識別子で、小文字・数字・ハイフンの形のときだけ出す。--only の ID は P<n> の形のものだけを出し、それ以外は件数だけ
const setIdShown = /^[a-z0-9][a-z0-9-]{0,63}$/.test(evalSet.set.id) ? evalSet.set.id : "形の違う ID";
if (only && buildFrom === null) {
  const unknown = only.filter((pid) => !evalSet.byId.has(pid)), shaped = unknown.filter((pid) => /^P\d+$/.test(pid)), others = unknown.length - shaped.length;
  if (unknown.length > 0) refuse(`--only に定義ファイル（${setIdShown}）に無い ID があります: ${[...shaped, ...(others > 0 ? [`形の違う ID ${others} 件`] : [])].join(",")}`, "only:unknown");
}

// --build-from（#497）：組を読み、対象の本（採用した P。--only はその部分集合だけ）を決め、子を起こす前に包みを検査する（組に保存した検査の結果は信頼しない）
let frozen = null, targets = null;
const envelopeBytes = new Map();
if (buildFrom !== null) {
  const fz = loadFrozenSet(resolve(buildFrom));
  if (fz.status === "missing") refuseCode("build-from:frozen-missing");
  if (fz.status !== "ok") refuseCode("build-from:frozen-invalid");
  // 組に書いた定義ファイルの SHA-256 と今の定義ファイル
  if (fz.set.set.sha256 !== evalSet.sha256) refuseCode("build-from:set-sha256");
  const adoptedIds = fz.set.adopted.map((a) => a.pattern), missingIds = fz.set.missing.map((m) => m.pattern);
  if (only) {
    // 組が外した P（missing）・組にも定義ファイルにも無い P・定義ファイルにはあるが組に無い P を、別の符号で断る
    const excluded = only.filter((pid) => missingIds.includes(pid));
    if (excluded.length > 0) refuseCode("build-from:excluded-p", { ids: excluded });
    const unknownIds = only.filter((pid) => !adoptedIds.includes(pid) && !evalSet.byId.has(pid));
    if (unknownIds.length > 0) refuseCode("build-from:unknown-p", { ids: unknownIds, count: unknownIds.length });
    const notAdopted = only.filter((pid) => !adoptedIds.includes(pid));
    if (notAdopted.length > 0) refuseCode("build-from:not-adopted", { ids: notAdopted });
  }
  const unknownAdopted = adoptedIds.filter((pid) => !evalSet.byId.has(pid));
  if (unknownAdopted.length > 0) refuseCode("build-from:unknown-p", { ids: unknownAdopted });
  targets = only ?? adoptedIds;
  const checks = await loadPlanFileChecks(distDir);
  for (const pid of evalSet.items.map((it) => it.id).filter((p) => targets.includes(p))) {
    const entry = fz.set.adopted.find((a) => a.pattern === pid), envPath = fz.envelopeOf.get(pid);
    if (!existsSync(envPath)) refuseCode("build-from:envelope-missing", { ids: [pid] });
    // 在るが読めない（ディレクトリなど）も固定の符号で断る（#497 の独立レビューの指摘 3。工場の plan-file-read と同じ扱い）
    let bytes;
    try { bytes = readFileSync(envPath); } catch { refuseCode("build-from:envelope-read", { ids: [pid] }); }
    // 写しの SHA-256（組の値）→ 工場の検査（今の依頼文と語彙の版）→ 組の plan_sha256・source_sha256 と包みの値
    if (sha256(bytes) !== entry.envelope.sha256) refuseCode("build-from:envelope-sha256", { ids: [pid] });
    const checked = await checkEnvelope(checks, bytes, reqOf(pid) + "\n");
    if (!checked.ok) refuseCode(`build-from:${checked.code}:${checked.detail}`, { ids: [pid] });
    if (checked.planSha256 !== entry.plan_sha256) refuseCode("build-from:plan-sha256", { ids: [pid] });
    if (checked.sourceSha256 !== entry.source_sha256) refuseCode("build-from:source-sha256", { ids: [pid] });
    envelopeBytes.set(pid, bytes);
  }
  // 条件の frozen：組のファイルのパスと SHA-256・ID・版・出どころ、採用した P ごとの 2 つの SHA と包みの SHA-256、外した P。仕様の本体は写さない
  frozen = {
    path: fz.path, sha256: fz.sha256, id: fz.set.id, version: fz.set.version, origin: fz.set.origin, author: fz.set.origin === "human" ? fz.set.author : null,
    adopted: fz.set.adopted.map((a) => ({ pattern: a.pattern, plan_sha256: a.plan_sha256, source_sha256: a.source_sha256, envelope_sha256: a.envelope.sha256 })),
    missing: missingIds,
  };
}
const jobs = [];
for (const item of evalSet.items) { const pid = item.id; if (targets !== null ? !targets.includes(pid) : only && !only.includes(pid)) continue; for (let r = 1; r <= RUNS; r++) jobs.push({ pid, r }); }
// --script（#497）：流す本の題材の台本を読み、写すバイト列を決める（台本の無い本が 1 本でもあれば断る。定義ファイルの読み込みで取った指紋と同じ中身だけを写す）
const scriptBytes = new Map();
if (script) {
  const pids = [...new Set(jobs.map((j) => j.pid))];
  const noScript = pids.filter((pid) => !evalSet.scripts.has(evalSet.byId.get(pid).subject));
  if (noScript.length > 0) refuseCode("script:missing", { ids: noScript });
  for (const pid of pids) {
    const sc = evalSet.scripts.get(evalSet.byId.get(pid).subject);
    let bytes;
    try { bytes = readFileSync(sc.path); } catch { refuseCode("script:read", { ids: [pid] }); }
    if (sha256(bytes.toString("utf8")) !== sc.sha256) refuseCode("script:changed", { ids: [pid] });
    scriptBytes.set(pid, bytes);
  }
}

const dirOf = (job) => join(outRoot, `${job.pid}-r${job.r}`);
const idOf = (job) => `${job.pid}-r${job.r}`;
// 子プロセスへ渡す引数を 1 か所で組み立て、条件のファイルもここから作る（既定値を別に手書きしない）
const childArgsFor = (job) => {
  const dir = dirOf(job);
  const argv = [cliFile, join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort, "--model", model, "--budget", String(perRunBudget), "--deadline", String(deadlineMin)];
  if (plan || planOnly) argv.push(plan ? "--plan" : "--plan-only", ...(script ? ["--script", join(dir, "script.json")] : ["--answers", join(dir, "answers.json")]));
  if (buildFrom !== null) argv.push("--plan-file", join(dir, "plan-file.json"));
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
// 依頼文の出どころの文書（定義ファイルの source.document。無ければ null）。計測はこれを読まない（定義ファイルが写し）。v2 までの document と同じ値になる
const sourceDoc = typeof evalSet.set.source?.document === "string" ? evalSet.set.source.document : null;
const sourceDocPath = sourceDoc === null ? null : join(repo, sourceDoc);
const document = { path: sourceDoc, sha256: sourceDocPath !== null && existsSync(sourceDocPath) ? sha256(readFileSync(sourceDocPath)) : null };
const scriptsFp = scriptsFingerprint(evalSet.scripts);
// 判定の口の構成（cli.ts の assembleJudge と同じ条件）：Jev の鍵の環境変数が空でなければ Jev を主・LLM を落とし先、無ければ LLM だけ。鍵の値は記録しない
const jevEnv = factory.JEV_API_KEY_ENV;
if (typeof jevEnv !== "string") throw new Error("工場の dist が JEV_API_KEY_ENV を公開していないので、判定の口の構成を記録できない");
const jevKey = process.env[jevEnv];
const judge = { configuration: jevKey !== undefined && jevKey !== "" ? "jev-primary-llm-fallback" : "llm-only", jev_key_env: jevEnv };
const head = gitOut(["rev-parse", "HEAD"]), status = gitOut(["status", "--porcelain"]);
const measured = {
  schema: "musunest-factory/agent-accept-conditions/v4",
  measurement_id: basename(outRoot),
  source: { commit: head === null ? null : head.trim(), dirty: status === null ? null : status.trim().length > 0 },
  factory: { dist_dir: relative(repo, distDir), fingerprint: distInfo.fingerprint, rebuilt: distInfo.mtime_ms !== null && (srcInfo.mtime_ms === null || distInfo.mtime_ms >= srcInfo.mtime_ms) },
  spec_engine: { dist_dir: relative(repo, specEngineDist), fingerprint: specEngineInfo.fingerprint, files: specEngineInfo.files },
  document,
  // 読んだ定義ファイル（#427）：パス・SHA-256・組の ID と版と役割・本の一覧。依頼文の出どころなので署名に入る
  set: { path: relToRepo(evalSet.path), sha256: evalSet.sha256, id: evalSet.set.id, version: evalSet.set.version, role: evalSet.set.role, items: evalSet.items.map(({ id, subject, style, writable }) => ({ id, subject, style, writable })) },
  prompt_documents: {
    contract: { dir: relToRepo(contractDir), fingerprint: contractInfo.fingerprint, files: contractInfo.files },
    semantics: { path: relToRepo(semanticsPath), sha256: sha256(readFileSync(semanticsPath)) },
    vocabulary: { path: relToRepo(vocabularyPath), sha256: sha256(readFileSync(vocabularyPath)) },
  },
  judge,
  params: {
    effort: argOf("--effort"), model: argOf("--model"), plan: sampleArgv.includes("--plan"),
    answers_mode: sampleArgv.includes("--answers") ? "recommended" : sampleArgv.includes("--script") ? "script" : "none",
    mode,
    patterns: [...new Set(jobs.map((j) => j.pid))], runs: RUNS, concurrency: CONC, budget_usd: budget,
    factory_budget_usd: Number(argOf("--budget")), factory_deadline_min: Number(argOf("--deadline")),
    stage_output_limits: limits.STAGE_MAX_OUTPUT_TOKENS[effort] ?? limits.STAGE_MAX_OUTPUT_TOKENS[limits.DEFAULT_REASONING_EFFORT],
  },
  child_args: jobs.map((j) => ({ id: idOf(j), argv: childArgsFor(j) })),
  // 採点の定義と集計のコードの指紋（<repo> の採点器と、組が実際に参照する採点の定義の実体）。署名からは外す：採点は生成のあとに全本へ同じ版を当てるもので、
  // 採点の出力が実際に実行した集計のコードの指紋をこの値と照合する（score-agent.mjs）。ただし source.commit・source.dirty は署名に残るので、
  // clean な checkout を編集したり採点だけの commit を積んだりすれば再開は断られる。外す効果があるのは source が変わらない場合に限る
  scoring: { dir: relative(repo, evDir), ...scoringFingerprint(evDir, undefined, evalSet.definitions) },
  // 台本（#427）：題材ごとの台本の指紋と当て方。--script が無ければ採点で事後に当てる（post-hoc）ので生成の条件ではなく、scoring と同じく署名から外す。
  // --script（#497）なら実行中に当てる（live）ので生成の条件になり、署名に入る。採点の出力が、実際に当てた台本の指紋をこの値と照合する
  scripts: { mode: script ? "live" : SCRIPT_MODE, fingerprint: scriptsFp.fingerprint, files: [...evalSet.scripts.entries()].map(([subject, sc]) => ({ subject, path: relToRepo(sc.path), sha256: sc.sha256 })) },
  // 凍結した組（#497。--build-from のときだけ。それ以外は null）。署名に入る
  frozen,
};
// 署名（--resume の一致の判定）から外すもの：started_at（補助）、scoring・post-hoc の scripts（上。live の scripts は入れる）、params.budget_usd（計測全体の停止の目安。
// 予算で止まった計測を --budget-usd を上げて流し切れるようにする。工場 1 本の予算 factory_budget_usd は生成の条件なので残す）。
// 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）の一致ではない。有効だった額は起動の記録（下）に残す
const { scoring: _scoring, scripts: _scripts, ...generationConditions } = measured;
const { budget_usd: _budget, ...paramsForSignature } = measured.params;
const signature = sha256(JSON.stringify(script ? { ...generationConditions, params: paramsForSignature, scripts: measured.scripts } : { ...generationConditions, params: paramsForSignature }));

const costOfDir = (dir) => { try { const sl = JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")); return sl.plan_cost?.total_usd ?? sl.summary?.provider_cost_usd ?? 0; } catch { return 0; } };

let spent = 0, stop = null, stopCode = null, skipped = [], reopened = [], executed = [], runQueue = [];
// この起動で有効な計測全体の目安の額（budget）と、初回の条件のファイルに記録した額。再開で変えたかどうかを起動の記録に残す
let initialBudget = budget;
mkdirSync(outRoot, { recursive: true });
const conditionsPath = join(outRoot, "conditions.json");
const priorDirs = readdirSync(outRoot).filter((n) => /^P\d+-r\d+$/.test(n));
if (priorDirs.length > 0 || existsSync(conditionsPath)) {
  // 前の結果がある出力先では、既定では子プロセスを 1 本も起こさない（#400）
  if (!resume) refuse("出力先に前の計測の結果があります。続きから流すなら --resume を、新しい計測なら別の出力先を使ってください", "resume:prior-output");
  if (!existsSync(conditionsPath)) refuse("条件のファイルの無い出力先です（新しい出力先を使ってください）", "resume:no-conditions");
  let saved = null; try { saved = JSON.parse(readFileSync(conditionsPath, "utf8")); } catch { refuse("条件のファイルを読めません", "resume:unreadable"); }
  if (saved?.signature !== signature) refuse("保存した条件と今の条件が一致しません", "resume:signature");
  initialBudget = typeof saved.params?.budget_usd === "number" ? saved.params.budget_usd : null;
  for (const job of jobs) {
    const dir = dirOf(job);
    if (!existsSync(dir)) continue;
    if (!existsSync(join(dir, "summary.line.json"))) refuse(`要約の無い途中の本があります: ${idOf(job)}`, "resume:partial");
    if (!existsSync(join(dir, "stdout.log")) || !existsSync(join(dir, "stderr.log"))) refuse(`全文が欠けた古い出力があります: ${idOf(job)}`, "resume:no-logs");
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

// 終了の分類（#497）：0 ＝ ok、1 ＝ failed、3 ＝ return-to-plan。2 は標準出力の工場の行で分ける：包みの読み取りの失敗の行（既知の版）なら envelope-unreadable、
// 検査で断った行（既知の版と既知の検査名）なら envelope-rejected、どちらも無ければ usage-other。それ以外は other。exit 2 が出ても計測は止めない
const EXIT_CLASSES = ["ok", "failed", "return-to-plan", "envelope-unreadable", "envelope-rejected", "usage-other", "other"];
const exitClasses = Object.fromEntries(EXIT_CLASSES.map((c) => [c, 0]));
const exitClassOf = (code, lines) => {
  if (code === 0) return "ok";
  if (code === 1) return "failed";
  if (code === 3) return "return-to-plan";
  if (code !== 2) return "other";
  if (lines.some((x) => x?.schema_version === PLAN_FILE_ERROR_SCHEMA)) return "envelope-unreadable";
  if (lines.some((x) => x?.schema_version === PLAN_FILE_REJECT_SCHEMA && PLAN_FILE_CHECKS.includes(x.check))) return "envelope-rejected";
  return "usage-other";
};
// 記録に写す子の出力は、バイト数と既知の版の行の数だけ（値を写さない）
const KNOWN_LINE_SCHEMAS = ["commandagent.headless-summary/v1", "musunest-factory/plan-build-cost/v1", PLAN_FILE_ERROR_SCHEMA, PLAN_FILE_REJECT_SCHEMA];
const tailOf = (buf) => ({ bytes: buf.length, known_lines: buf.toString("utf8").split("\n").filter((l) => { try { return KNOWN_LINE_SCHEMAS.includes(JSON.parse(l)?.schema_version); } catch { return false; } }).length });
const verdictOf = (v) => (v === null || v === undefined ? null : FACTORY_VERDICTS.includes(v) ? v : "unknown");
// 子の要約と費用の行から記録へ写す欄と型（#497 の独立レビューの指摘 1）。列挙した欄だけを写し、分類は既知の列挙（packages/factory/src/record.ts と同じ値。
// それ以外は unknown）へ、問題の詳細は件数へ、数は有限の数だけ写す。自由文（message・未知の分類・追加の欄）は写さない。生の中身は stdout.log を開く
const STAGE_IDS = ["requirements", "reverse-check", "design", "test-suite", "write", "static-check", "correspondence", "run-tests", "repair", "arbitration", "judge", "bundle"];
const FAILURE_KINDS = ["limit", "deadline", "budget", "call-limit", "timeout", "network", "http", "balance", "malformed", "refused", "tool-arguments", "invalid-request", "unmet", "incomplete", "unknown"];
const STOP_VALUES = ["completed", "stagnation", "limit", "unresolved", "deadline", ...FAILURE_KINDS];
const enumOf = (list, v) => (v === null || v === undefined ? null : list.includes(v) ? v : "unknown");
const numOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
/** 数だけの木（試行・再試行の数）：鍵は小文字・数字・_ の形だけ、値は有限の数か同じ形の写像（深さ 2 まで） */
const countsOf = (x, depth = 0) => (!isRec(x) ? null : Object.fromEntries(Object.entries(x).filter(([k]) => /^[a-z][a-z0-9_]{0,40}$/.test(k)).map(([k, v]) => [k, isRec(v) && depth < 1 ? countsOf(v, depth + 1) : numOf(v)]).filter(([, v]) => v !== null)));
const STAGE_NUMBERS = ["duration_ms", "calls", "missing_usage_calls", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
const stageOf = (st) => ({ stage: enumOf(STAGE_IDS, st?.stage ?? null) ?? "unknown", operation: enumOf(["redo-design"], st?.operation ?? null), status: enumOf(["ok", "failed"], st?.status ?? null), ...Object.fromEntries(STAGE_NUMBERS.map((k) => [k, numOf(st?.[k])])), attempts: countsOf(st?.attempts), retries: countsOf(st?.retries), failure_kind: enumOf(FAILURE_KINDS, st?.failure_kind ?? null) });
const failureOf = (f) => (!isRec(f) ? null : { stage: enumOf(STAGE_IDS, f.stage ?? null) ?? "unknown", kind: enumOf(FAILURE_KINDS, f.kind ?? null) ?? "unknown", code: f.code === undefined ? null : "present", problems: Array.isArray(f.problems) ? f.problems.length : 0 });
const SUMMARY_NUMBERS = ["score", "duration_secs", "provider_cost_usd", "directive_round", "exit_code", "budget_remaining_usd", "budget_reserved_usd", "missing_usage_calls"];
const summaryOf = (s) => ({
  schema_version: "commandagent.headless-summary/v1", verdict: verdictOf(s.verdict), stop_class: enumOf(STOP_VALUES, s.stop_class), stop_reason: enumOf(STOP_VALUES, s.stop_reason),
  ...Object.fromEntries(SUMMARY_NUMBERS.map((k) => [k, numOf(s[k])])),
  stages: Array.isArray(s.stages) ? s.stages.map(stageOf) : [], arbitration: countsOf(s.arbitration), failure: failureOf(s.failure),
});
const planCostOf = (c) => (c === null ? null : { schema_version: "musunest-factory/plan-build-cost/v1", plan_usd: numOf(c.plan_usd), build_usd: numOf(c.build_usd), total_usd: numOf(c.total_usd) });

const runOne = (job) => new Promise((resolve) => {
  const dir = dirOf(job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), reqOf(job.pid) + "\n");
  // 答えのファイルは空（すべて推奨）のまま。--script なら台本の写し（#497）、--build-from なら組の包みの写しを置く（どれも生のまま。記録には写さない）
  if ((plan || planOnly) && !script) writeFileSync(join(dir, "answers.json"), "{}\n");
  if (script) writeFileSync(join(dir, "script.json"), scriptBytes.get(job.pid));
  if (buildFrom !== null) writeFileSync(join(dir, "plan-file.json"), envelopeBytes.get(job.pid));
  const cliArgs = childArgsFor(job);
  const t0 = Date.now();
  // 子を起こす直前の時刻（#497。凍結の規則が読む。終わる順に依らない）
  const startedAt = new Date().toISOString();
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
    const cost = numOf(planCost?.total_usd) ?? numOf(s?.provider_cost_usd) ?? 0;
    const exitClass = exitClassOf(code, lines);
    exitClasses[exitClass] += 1;
    // 記録は無害化する（#497）：子の出力の写しはバイト数と既知の版の行の数だけ、要約の verdict は既知の値か unknown。生の中身は stdout.log・stderr.log を開く
    // 要約と費用の行は列挙した欄と型だけ（summaryOf・planCostOf）
    const summary = s === null ? null : summaryOf(s);
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, started_at: startedAt, exit_class: exitClass, summary, plan_cost: planCostOf(planCost), stderr_tail: tailOf(errBuf), stdout_tail: s === null ? tailOf(outBuf) : undefined, resumed: job.resumed === true }, null, 1));
    spent += cost;
    console.log(`${idOf(job)} effort=${effort}${plan ? " plan" : ""}${planOnly ? " plan-only" : ""}${buildFrom !== null ? " build-from" : ""}${job.resumed ? " resume" : ""} exit=${code} verdict=${s === null ? "none" : verdictOf(s.verdict) ?? "none"} cost=${Number(cost).toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
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
// 変えたかどうか（budget_changed）・済みの額（spent_usd）・この起動で流した本の終了の分類ごとの件数（exit_classes。#497）。完走した再開でも残すので、署名が同じでも管理の条件の変更履歴を読める
writeFileSync(join(outRoot, `run-${Date.now()}.json`), JSON.stringify({ finished_at: new Date().toISOString(), mode: resume ? "resume" : "fresh", executed, pending, stop, stop_code: stopCode, budget_usd: budget, initial_budget_usd: initialBudget, budget_changed: initialBudget === null ? null : initialBudget !== budget, spent_usd: spent, exit_classes: exitClasses }, null, 1));
console.log("done", stop ?? "", "spent", spent.toFixed(4));
