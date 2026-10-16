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
// #513（v1.1α の比較。README の v1.1α の節）：
//   --pipeline v1|v1.1a（既定 v1）：v1.1a は --build-from と一緒にだけ受け、子の引数の末尾に --pipeline v1.1a を足す（v1 と省略は子に何も足さない）。
//          条件の schema は v5（params.pipeline・params.stage_output_limits_v11a・comparison。stage_output_limits は v1 の 10 段だけ）。知らない値・組めない組は flags:conflict
//   --make-pairs <出力> --build-from <組> [--runs 3]：採用した P（組の順）× 回数の対を、先行の群を v1 から交互に並べて書く（子を起こさない）
//   --compare --baseline <比較元の checkout> --pairs <対のファイル> --build-from <組> --budget-usd <上限> [--concurrency 3]：対にした交互の計測。
//          群 v1 ＝ 比較元の checkout の入口（--pipeline 無し）、群 v1.1a ＝ <repo> の入口（--pipeline v1.1a）。対の順 × 先行順を 1 本の待ち行列にし、
//          両群の合計の並列で起こす。起こす直前に「済みの額＋走行中の予約＋新しく起こす 1 本の予約 ≤ 上限」を確かめ、超えればそれ以降を起こさない（D17）。
//          --only・--runs・--resume・--plan・--plan-only・--script・--pipeline とは組めない。記録は <out>/v1・<out>/v1.1a（群の計測）と直下の比較の記録・起動の記録
// 採点は: node score-agent.mjs <repo> <out> [--label high]（リポジトリ・出力先の順で渡す）。比較は score-agent.mjs <repo> <out> --compare
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SET_PATH, FACTORY_VERDICTS, SCRIPT_MODE, fingerprintDir, loadEvalSet, scoringFingerprint, scriptsFingerprint, sha256 } from "./score-agent.mjs";
import { BUILD_STAGE_IDS, COMPARE_GROUPS, COMPARE_PAIRS_COPY, COMPARE_ROLES, COMPARE_RUN_PREFIX, COMPARE_RUN_SCHEMA, COMPARISON_FILE, COMPARISON_SCHEMA, PIPELINES, SCORING_COST_USD, compareProfile, launchAllowed, limitsApproved, makePairs, outputLimitsOf, pairsProblem } from "./score-agent.mjs";
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
// checkout ごとの入口と公開の値（#513：比較では比較元の checkout も同じ形で読む）
async function loadCheckout(checkout) {
  const distDir = join(checkout, "packages/factory/dist");
  const cliFile = join(distDir, "cli.js");
  const factory = await import(pathToFileURL(cliFile).href);
  const openai = await import(pathToFileURL(join(distDir, "openai.js")).href);
  const limits = await import(pathToFileURL(join(distDir, "limits.js")).href);
  // 生成に渡す文書の置き場所は、工場の入口と同じ appspec-schema の files から引く（cli.ts の loadDocumentsFromFiles）
  const schemaFiles = await import(pathToFileURL(join(checkout, "packages/appspec-schema/dist/files.js")).href);
  return { checkout, distDir, cliFile, factory, openai, limits, schemaFiles };
}
const main = await loadCheckout(repo);
const { distDir, cliFile, factory, openai } = main;

const effort = opt("--effort", factory.DEFAULT_EFFORT), CONC = Number(opt("--concurrency", "3"));
let RUNS = Number(opt("--runs", "5"));
const only = opt("--only", null)?.split(","), budget = Number(opt("--budget-usd", "15"));
const plan = args.includes("--plan"), resume = args.includes("--resume");
// #497：Plan だけ・台本・凍結した組から Build だけ。組めない組は子を起こす前に断る
const planOnly = args.includes("--plan-only"), script = args.includes("--script");
const buildFromIndex = args.indexOf("--build-from"), buildFrom = buildFromIndex >= 0 ? args[buildFromIndex + 1] ?? "" : null;
if (buildFrom !== null && (buildFrom === "" || buildFrom.startsWith("--"))) refuseCode("flags:conflict");
if ((plan && planOnly) || (buildFrom !== null && (plan || planOnly || script)) || (script && !plan && !planOnly)) refuseCode("flags:conflict");
// #513：経路（--pipeline）・対のファイルを書く（--make-pairs）・対にした交互の計測（--compare）。値を取る引数は値が無いか -- で始まれば組めない
const valueOf = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; return v === undefined || v === "" || v.startsWith("--") ? "" : v; };
const pipelineArg = valueOf("--pipeline"), pipeline = pipelineArg ?? "v1";
const compare = args.includes("--compare"), makePairsOut = valueOf("--make-pairs"), baselineArg = valueOf("--baseline"), pairsArg = valueOf("--pairs");
if (!PIPELINES.includes(pipeline) || (pipeline === "v1.1a" && buildFrom === null)) refuseCode("flags:conflict");
if ([makePairsOut, baselineArg, pairsArg].includes("")) refuseCode("flags:conflict");
if (makePairsOut !== null && (compare || buildFrom === null || only || resume || pipelineArg !== null || baselineArg !== null || pairsArg !== null)) refuseCode("flags:conflict");
if (compare && (buildFrom === null || baselineArg === null || pairsArg === null || only || args.includes("--runs") || resume || pipelineArg !== null)) refuseCode("flags:conflict");
if (!compare && (baselineArg !== null || pairsArg !== null)) refuseCode("flags:conflict");
if (compare && !args.includes("--budget-usd")) refuseCode("compare:budget-required");
if (compare && !(Number.isFinite(budget) && budget >= 0 && Number.isInteger(CONC) && CONC >= 1)) refuseCode("flags:conflict");
/** 条件の params.mode：build（指定なし）・e2e（--plan）・plan-only・build-from */
const mode = buildFrom !== null ? "build-from" : planOnly ? "plan-only" : plan ? "e2e" : "build";
const model = opt("--model", openai.DEFAULT_OPENAI_MODEL);
const perRunBudget = Number(opt("--factory-budget-usd", String(factory.DEFAULT_BUDGET_USD)));
const deadlineMin = Number(opt("--deadline-min", String(factory.DEFAULT_DEADLINE_MS / 60000)));

// 依頼文は定義ファイルの本から組む（行を改行でつなぐ。request.md にはその末尾に改行を 1 つ足す）
const reqOf = (pid) => evalSet.byId.get(pid).requestText;
// 組の ID は条件の set.id にも書く識別子で、小文字・数字・ハイフンの形のときだけ出す。--only の ID は P<n> の形のものだけを出し、それ以外は件数だけ
const KNOWN_SET_IDS = ["dev-p1-p10", "regression-r1"]; // sets/ にある組の ID（README §5.6・§6）。これ以外の組の ID は断りの文に出さない
const setIdShown = KNOWN_SET_IDS.includes(evalSet.set.id) ? evalSet.set.id : "既知でない組";
if (only && buildFrom === null) {
  const unknown = only.filter((pid) => !evalSet.byId.has(pid)), shaped = unknown.filter((pid) => /^P\d+$/.test(pid)), others = unknown.length - shaped.length;
  if (unknown.length > 0) refuse(`--only に定義ファイル（${setIdShown}）に無い ID があります: ${[...shaped, ...(others > 0 ? [`形の違う ID ${others} 件`] : [])].join(",")}`, "only:unknown");
}

// --make-pairs（#513）：組を読み、採用した P（組の順）× 回数の対を書いて終える。子を起こさない。出力が既にあれば上書きしない
if (makePairsOut !== null) {
  const fz = loadFrozenSet(resolve(buildFrom));
  if (fz.status === "missing") refuseCode("build-from:frozen-missing");
  if (fz.status !== "ok") refuseCode("build-from:frozen-invalid");
  if (!Number.isInteger(RUNS) || RUNS < 1) refuseCode("flags:conflict");
  if (existsSync(makePairsOut)) refuseCode("compare:pairs-exists");
  const pairsValue = makePairs(fz.set.adopted.map((a) => a.pattern), RUNS, fz.sha256);
  writeFileSync(makePairsOut, JSON.stringify(pairsValue, null, 1) + "\n");
  // 書き終えてから終える（パイプへの書き込みが非同期の環境でも行を落とさない）
  await new Promise((done) => process.stdout.write(`対を書きました: ${pairsValue.pairs.length} 対（採用 ${fz.set.adopted.length} P × ${RUNS} 回）\n`, done));
  process.exit(0);
}

// --compare（#513）：比較元の checkout を同じ形で読む（読めなければ断る。パスは出さない）
let baseline = null;
if (compare) {
  try { baseline = await loadCheckout(resolve(baselineArg)); } catch { refuseCode("compare:baseline-unreadable"); }
}

// --build-from（#497）：組を読み、対象の本（採用した P。--only はその部分集合だけ）を決め、子を起こす前に包みを検査する（組に保存した検査の結果は信頼しない）
let frozen = null, targets = null, fzLoaded = null;
const envelopeBytes = new Map();
if (buildFrom !== null) {
  const fz = loadFrozenSet(resolve(buildFrom));
  if (fz.status === "missing") refuseCode("build-from:frozen-missing");
  if (fz.status !== "ok") refuseCode("build-from:frozen-invalid");
  fzLoaded = fz;
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
  // 比較（#513）では、比較元の checkout の工場の検査も同じ写しに当てる（両群の子が同じ包みを受け取れることを起こす前に確かめる）
  const checksList = [await loadPlanFileChecks(distDir), ...(baseline === null ? [] : [await loadPlanFileChecks(baseline.distDir)])];
  for (const pid of evalSet.items.map((it) => it.id).filter((p) => targets.includes(p))) {
    const entry = fz.set.adopted.find((a) => a.pattern === pid), envPath = fz.envelopeOf.get(pid);
    if (!existsSync(envPath)) refuseCode("build-from:envelope-missing", { ids: [pid] });
    // 在るが読めない（ディレクトリなど）も固定の符号で断る（#497 の独立レビューの指摘 3。工場の plan-file-read と同じ扱い）
    let bytes;
    try { bytes = readFileSync(envPath); } catch { refuseCode("build-from:envelope-read", { ids: [pid] }); }
    // 写しの SHA-256（組の値）→ 工場の検査（今の依頼文と語彙の版）→ 組の plan_sha256・source_sha256 と包みの値
    if (sha256(bytes) !== entry.envelope.sha256) refuseCode("build-from:envelope-sha256", { ids: [pid] });
    for (const checks of checksList) {
      const checked = await checkEnvelope(checks, bytes, reqOf(pid) + "\n");
      if (!checked.ok) refuseCode(`build-from:${checked.code}:${checked.detail}`, { ids: [pid] });
      if (checked.planSha256 !== entry.plan_sha256) refuseCode("build-from:plan-sha256", { ids: [pid] });
      if (checked.sourceSha256 !== entry.source_sha256) refuseCode("build-from:source-sha256", { ids: [pid] });
    }
    envelopeBytes.set(pid, bytes);
  }
  // 条件の frozen：組のファイルのパスと SHA-256・ID・版・出どころ、採用した P ごとの 2 つの SHA と包みの SHA-256、外した P。仕様の本体は写さない
  frozen = {
    path: fz.path, sha256: fz.sha256, id: fz.set.id, version: fz.set.version, origin: fz.set.origin, author: fz.set.origin === "human" ? fz.set.author : null,
    adopted: fz.set.adopted.map((a) => ({ pattern: a.pattern, plan_sha256: a.plan_sha256, source_sha256: a.source_sha256, envelope_sha256: a.envelope.sha256 })),
    missing: missingIds,
  };
}
// --compare（#513）：対のファイルを起動の前に検査する（版・凍結した組の SHA・runs・採用 P × 1〜runs とちょうど一致・交互）。回数は対のファイルから取る
let pairsValue = null, pairsBytes = null;
if (compare) {
  try { pairsBytes = readFileSync(resolve(pairsArg)); pairsValue = JSON.parse(pairsBytes.toString("utf8")); } catch { refuseCode("compare:pairs-unreadable"); }
  const problem = pairsProblem(pairsValue, { frozenSha256: fzLoaded.sha256, adopted: fzLoaded.set.adopted.map((a) => a.pattern) });
  if (problem !== null) refuseCode(problem);
  RUNS = pairsValue.runs;
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

const idOf = (job) => `${job.pid}-r${job.r}`;
const dirOf = (job) => join(outRoot, `${job.pid}-r${job.r}`);
// 子プロセスへ渡す引数を 1 か所で組み立て、条件のファイルもここから作る（既定値を別に手書きしない）。v1.1a の経路だけ末尾に --pipeline v1.1a を足す（#513）
const argvFor = (cli, dir, pl) => {
  const argv = [cli, join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort, "--model", model, "--budget", String(perRunBudget), "--deadline", String(deadlineMin)];
  if (plan || planOnly) argv.push(plan ? "--plan" : "--plan-only", ...(script ? ["--script", join(dir, "script.json")] : ["--answers", join(dir, "answers.json")]));
  if (buildFrom !== null) argv.push("--plan-file", join(dir, "plan-file.json"));
  if (pl === "v1.1a") argv.push("--pipeline", "v1.1a");
  return argv;
};
const childArgsFor = (job) => argvFor(cliFile, dirOf(job), pipeline);

const gitOut = (checkout, gitArgs) => { try { return execFileSync("git", ["-C", checkout, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

// 計測の条件のうち checkout に依らない値（定義ファイル・採点・台本・判定の口の構成は <repo> の道具の側から取る。比較では両群で共有する）
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
const scoringOf = () => ({ dir: relative(repo, evDir), ...scoringFingerprint(evDir, undefined, evalSet.definitions) });

/**
 * 計測の条件（始めた時刻は補助で署名から外す）。条件の値は、子へ渡す引数と run-agent の指定から作る。
 * ctx ＝ 子を起こす checkout（工場の dist・spec-engine の dist・生成に渡す文書・git の状態はここから）。argvOf ＝ 条件に書く子の引数。
 * pl ＝ 経路、comparison ＝ 比較の群の印（#513。比較でなければ null）
 */
function conditionsFor(ctx, { jobs: js, argvOf, pl, comparison, measurementId }) {
  const probe = js[0] ?? { pid: only?.[0] ?? "P1", r: 1 };
  const sampleArgv = argvOf(probe);
  const argOf = (flag) => { const i = sampleArgv.indexOf(flag); return i >= 0 ? sampleArgv[i + 1] : undefined; };
  const distInfo = fingerprintDir(ctx.distDir), srcInfo = fingerprintDir(join(ctx.checkout, "packages/factory/src"));
  const specEngineDist = join(ctx.checkout, "packages/spec-engine/dist"), specEngineInfo = fingerprintDir(specEngineDist);
  const contractDir = fileURLToPath(ctx.schemaFiles.packageFile(`${ctx.schemaFiles.CONTRACT_DIR}/`)), contractInfo = fingerprintDir(contractDir);
  const semanticsPath = fileURLToPath(ctx.schemaFiles.semanticsFile()), vocabularyPath = fileURLToPath(ctx.schemaFiles.vocabularyFile());
  const relToCheckout = (p) => relative(realpathSync(ctx.checkout), realpathSync(p));
  const head = gitOut(ctx.checkout, ["rev-parse", "HEAD"]), status = gitOut(ctx.checkout, ["status", "--porcelain"]);
  // 段ごとの出力の上限：v1 の 10 段は今までの欄に、v1.1α の 4 段は別の欄に（#513。どちらも署名に入る）
  const limitTable = ctx.limits.STAGE_MAX_OUTPUT_TOKENS[effort] ?? ctx.limits.STAGE_MAX_OUTPUT_TOKENS[ctx.limits.DEFAULT_REASONING_EFFORT];
  const outputLimits = outputLimitsOf(limitTable);
  const measured = {
    schema: "musunest-factory/agent-accept-conditions/v5",
    measurement_id: measurementId,
    source: { commit: head === null ? null : head.trim(), dirty: status === null ? null : status.trim().length > 0 },
    factory: { dist_dir: relative(ctx.checkout, ctx.distDir), fingerprint: distInfo.fingerprint, rebuilt: distInfo.mtime_ms !== null && (srcInfo.mtime_ms === null || distInfo.mtime_ms >= srcInfo.mtime_ms) },
    spec_engine: { dist_dir: relative(ctx.checkout, specEngineDist), fingerprint: specEngineInfo.fingerprint, files: specEngineInfo.files },
    document,
    // 読んだ定義ファイル（#427）：パス・SHA-256・組の ID と版と役割・本の一覧。依頼文の出どころなので署名に入る
    set: { path: relToRepo(evalSet.path), sha256: evalSet.sha256, id: evalSet.set.id, version: evalSet.set.version, role: evalSet.set.role, items: evalSet.items.map(({ id, subject, style, writable }) => ({ id, subject, style, writable })) },
    prompt_documents: {
      contract: { dir: relToCheckout(contractDir), fingerprint: contractInfo.fingerprint, files: contractInfo.files },
      semantics: { path: relToCheckout(semanticsPath), sha256: sha256(readFileSync(semanticsPath)) },
      vocabulary: { path: relToCheckout(vocabularyPath), sha256: sha256(readFileSync(vocabularyPath)) },
    },
    judge,
    params: {
      effort: argOf("--effort"), model: argOf("--model"), plan: sampleArgv.includes("--plan"),
      answers_mode: sampleArgv.includes("--answers") ? "recommended" : sampleArgv.includes("--script") ? "script" : "none",
      mode,
      patterns: [...new Set(js.map((j) => j.pid))], runs: RUNS, concurrency: CONC, budget_usd: budget,
      factory_budget_usd: Number(argOf("--budget")), factory_deadline_min: Number(argOf("--deadline")),
      stage_output_limits: outputLimits.v1,
      // #513：経路（v1 か v1.1a。省略は v1）と v1.1α の 4 段の上限（dist に無ければ null）
      pipeline: pl, stage_output_limits_v11a: outputLimits.v11a,
    },
    child_args: js.map((j) => ({ id: idOf(j), argv: argvOf(j) })),
    // 採点の定義と集計のコードの指紋（<repo> の採点器と、組が実際に参照する採点の定義の実体）。署名からは外す：採点は生成のあとに全本へ同じ版を当てるもので、
    // 採点の出力が実際に実行した集計のコードの指紋をこの値と照合する（score-agent.mjs）。ただし source.commit・source.dirty は署名に残るので、
    // clean な checkout を編集したり採点だけの commit を積んだりすれば再開は断られる。外す効果があるのは source が変わらない場合に限る
    scoring: scoringOf(),
    // 台本（#427）：題材ごとの台本の指紋と当て方。--script が無ければ採点で事後に当てる（post-hoc）ので生成の条件ではなく、scoring と同じく署名から外す。
    // --script（#497）なら実行中に当てる（live）ので生成の条件になり、署名に入る。採点の出力が、実際に当てた台本の指紋をこの値と照合する
    scripts: { mode: script ? "live" : SCRIPT_MODE, fingerprint: scriptsFp.fingerprint, files: [...evalSet.scripts.entries()].map(([subject, sc]) => ({ subject, path: relToRepo(sc.path), sha256: sc.sha256 })) },
    // 凍結した組（#497。--build-from のときだけ。それ以外は null）。署名に入る
    frozen,
    // 比較の群の印（#513。--compare のときだけ。それ以外は null）：対のファイルの SHA・群・役割・profile。署名に入る
    comparison,
  };
  // 署名（--resume の一致の判定）から外すもの：started_at（補助）、scoring・post-hoc の scripts（上。live の scripts は入れる）、params.budget_usd（計測全体の停止の目安。
  // 予算で止まった計測を --budget-usd を上げて流し切れるようにする。工場 1 本の予算 factory_budget_usd は生成の条件なので残す）。
  // 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）の一致ではない。有効だった額は起動の記録（下）に残す
  const { scoring: _scoring, scripts: _scripts, ...generationConditions } = measured;
  const { budget_usd: _budget, ...paramsForSignature } = measured.params;
  const signature = sha256(JSON.stringify(script ? { ...generationConditions, params: paramsForSignature, scripts: measured.scripts } : { ...generationConditions, params: paramsForSignature }));
  return { measured, signature };
}

const costOfDir = (dir) => { try { const sl = JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")); return sl.plan_cost?.total_usd ?? sl.summary?.provider_cost_usd ?? 0; } catch { return 0; } };

let spent = 0, stop = null, stopCode = null, skipped = [], reopened = [], executed = [], runQueue = [];
// この起動で有効な計測全体の目安の額（budget）と、初回の条件のファイルに記録した額。再開で変えたかどうかを起動の記録に残す
let initialBudget = budget;

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
// 段の ID は採点の道具と同じ一覧（v1 の 12 段と v1.1α の 7 段。#513）
const STAGE_IDS = BUILD_STAGE_IDS;
const FAILURE_KINDS = ["limit", "deadline", "budget", "call-limit", "timeout", "network", "http", "balance", "malformed", "refused", "tool-arguments", "invalid-request", "unmet", "incomplete", "unknown"];
const STOP_VALUES = ["completed", "stagnation", "limit", "unresolved", "deadline", ...FAILURE_KINDS];
const enumOf = (list, v) => (v === null || v === undefined ? null : list.includes(v) ? v : "unknown");
const numOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
/** 数の写像（試行・再試行・裁定の数）：工場の record.ts の既知の鍵だけを、どの階層でも名指しで写す（値は有限の数か null。未知の鍵は写さない） */
const NOT_STARTED_KEYS = ["deadline", "budget", "limit", "timeout"], RETRY_KEYS = ["communication", "shape", "content"], ARBITRATION_KEYS = ["upheld", "overturned", "undecidable"];
const ATTEMPT_NUMBER_KEYS = ["started", "responded", "errors", "cancelled_deadline", "cancelled_timeout"];
const numsOf = (x, keys) => (!isRec(x) ? null : Object.fromEntries(keys.map((k) => [k, numOf(x[k])])));
const attemptsOf = (x) => (!isRec(x) ? null : { ...numsOf(x, ATTEMPT_NUMBER_KEYS), not_started: numsOf(x.not_started, NOT_STARTED_KEYS) });
const STAGE_NUMBERS = ["duration_ms", "calls", "missing_usage_calls", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
const stageOf = (st) => ({ stage: enumOf(STAGE_IDS, st?.stage ?? null) ?? "unknown", operation: enumOf(["redo-design"], st?.operation ?? null), status: enumOf(["ok", "failed"], st?.status ?? null), ...Object.fromEntries(STAGE_NUMBERS.map((k) => [k, numOf(st?.[k])])), attempts: attemptsOf(st?.attempts), retries: numsOf(st?.retries, RETRY_KEYS), failure_kind: enumOf(FAILURE_KINDS, st?.failure_kind ?? null) });
const failureOf = (f) => (!isRec(f) ? null : { stage: enumOf(STAGE_IDS, f.stage ?? null) ?? "unknown", kind: enumOf(FAILURE_KINDS, f.kind ?? null) ?? "unknown", code: f.code === undefined ? null : "present", problems: Array.isArray(f.problems) ? f.problems.length : 0 });
const SUMMARY_NUMBERS = ["score", "duration_secs", "provider_cost_usd", "directive_round", "exit_code", "budget_remaining_usd", "budget_reserved_usd", "missing_usage_calls"];
const summaryOf = (s) => ({
  schema_version: "commandagent.headless-summary/v1", verdict: verdictOf(s.verdict), stop_class: enumOf(STOP_VALUES, s.stop_class), stop_reason: enumOf(STOP_VALUES, s.stop_reason),
  ...Object.fromEntries(SUMMARY_NUMBERS.map((k) => [k, numOf(s[k])])),
  stages: Array.isArray(s.stages) ? s.stages.map(stageOf) : [], arbitration: numsOf(s.arbitration, ARBITRATION_KEYS), failure: failureOf(s.failure),
});
const planCostOf = (c) => (c === null ? null : { schema_version: "musunest-factory/plan-build-cost/v1", plan_usd: numOf(c.plan_usd), build_usd: numOf(c.build_usd), total_usd: numOf(c.total_usd) });

/**
 * 1 本を流す。job.group があれば比較の群の本（#513）：本のディレクトリは <out>/<群>/<本>、入口と cwd はその群の checkout、子の引数は群の経路で組み、
 * 終了の分類はその群の数に足す。終わった本の費用を返す（済みの額は呼ぶ側の spent にも足す）
 */
const runOne = (job) => new Promise((resolve) => {
  const group = job.group === undefined ? null : groupCtx[job.group];
  const dir = group === null ? dirOf(job) : join(group.dir, idOf(job));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), reqOf(job.pid) + "\n");
  // 答えのファイルは空（すべて推奨）のまま。--script なら台本の写し（#497）、--build-from なら組の包みの写しを置く（どれも生のまま。記録には写さない）
  if ((plan || planOnly) && !script) writeFileSync(join(dir, "answers.json"), "{}\n");
  if (script) writeFileSync(join(dir, "script.json"), scriptBytes.get(job.pid));
  if (buildFrom !== null) writeFileSync(join(dir, "plan-file.json"), envelopeBytes.get(job.pid));
  const cliArgs = group === null ? childArgsFor(job) : argvFor(group.ctx.cliFile, dir, group.pipeline);
  const t0 = Date.now();
  // 子を起こす直前の時刻（#497。凍結の規則が読む。終わる順に依らない）
  const startedAt = new Date().toISOString();
  const ch = spawn("node", cliArgs, { cwd: join(group === null ? repo : group.ctx.checkout, "packages/factory"), env: process.env });
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
    (group === null ? exitClasses : group.exitClasses)[exitClass] += 1;
    // 記録は無害化する（#497）：子の出力の写しはバイト数と既知の版の行の数だけ、要約の verdict は既知の値か unknown。生の中身は stdout.log・stderr.log を開く
    // 要約と費用の行は列挙した欄と型だけ（summaryOf・planCostOf）
    const summary = s === null ? null : summaryOf(s);
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, started_at: startedAt, exit_class: exitClass, summary, plan_cost: planCostOf(planCost), stderr_tail: tailOf(errBuf), stdout_tail: s === null ? tailOf(outBuf) : undefined, resumed: job.resumed === true }, null, 1));
    spent += cost;
    if (group !== null) group.spent += cost;
    console.log(`${group === null ? "" : `${job.group}/`}${idOf(job)} effort=${effort}${plan ? " plan" : ""}${planOnly ? " plan-only" : ""}${buildFrom !== null ? " build-from" : ""}${(group === null ? pipeline : group.pipeline) === "v1.1a" ? " pipeline=v1.1a" : ""}${job.resumed ? " resume" : ""} exit=${code} verdict=${s === null ? "none" : verdictOf(s.verdict) ?? "none"} cost=${Number(cost).toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
    resolve(cost);
  });
});

/** 比較の群（#513）：群の名前 → { ctx（checkout）, pipeline, dir（<out>/<群>）, exitClasses, spent, executed } */
const groupCtx = {};

if (compare) await runCompare();
else await runSingle();

/** 比較でない計測（今までの流れ。#400〜#497） */
async function runSingle() {
  const { measured, signature } = conditionsFor(main, { jobs, argvOf: childArgsFor, pl: pipeline, comparison: null, measurementId: basename(outRoot) });
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
}

/**
 * 対にした交互の計測（#513。設計書 07 §4・D7・D17）。起動の前に、両群の条件を組み、既定・指紋・上限を照合する（どれかが違えば断り、何も書かない）。
 * 意図した差は工場の dist・commit・dirty・経路・v1.1α の上限の欄だけ。正式な比較の条件（OFFICIAL_COMPARE）は断らずに profile として残す
 */
async function runCompare() {
  // 出力先は新しい場所だけ（比較は再開しない）
  if (existsSync(outRoot) && readdirSync(outRoot).length > 0) refuseCode("compare:prior-output");
  const pairsSha = sha256(pairsBytes);
  const ctxOf = { v1: baseline, "v1.1a": main };
  // 工場の既定（子に渡す値の出どころ。片方だけ違えば、同じ引数でも条件の意味が揃わない）
  const defaultsOf = (ctx) => ({
    effort: ctx.factory.DEFAULT_EFFORT, budget_usd: ctx.factory.DEFAULT_BUDGET_USD, deadline_ms: ctx.factory.DEFAULT_DEADLINE_MS, model: ctx.openai.DEFAULT_OPENAI_MODEL,
    reasoning_effort: ctx.limits.DEFAULT_REASONING_EFFORT, vocabulary_version: ctx.factory.VOCABULARY_VERSION, api_key_env: ctx.factory.API_KEY_ENV, jev_key_env: ctx.factory.JEV_API_KEY_ENV,
  });
  if (JSON.stringify(defaultsOf(baseline)) !== JSON.stringify(defaultsOf(main))) refuseCode("compare:defaults-differ");
  // 正式な比較の条件（断らない。違った項目の名前だけ残す）。採点 v5 は採点の定義に rubric-v5.mjs があるとき
  const scoring = scoringOf();
  const baseHead = gitOut(baseline.checkout, ["rev-parse", "HEAD"]), baseStatus = gitOut(baseline.checkout, ["status", "--porcelain"]);
  const { profile, mismatches } = compareProfile({
    baseline_commit: baseHead === null ? null : baseHead.trim(), baseline_dirty: baseStatus === null ? null : baseStatus.trim().length > 0,
    frozen_sha256: frozen.sha256, frozen_id: frozen.id, frozen_version: frozen.version, frozen_adopted: frozen.adopted.length,
    runs: RUNS, effort, deadline_min: deadlineMin, factory_budget_usd: perRunBudget, concurrency: CONC, budget_usd: budget,
    rubric: scoring.files.some((f) => f.path === "rubric-v5.mjs") ? "v5" : null,
  });
  // 条件に書く子の引数は checkout と出力先からの相対（比較元のパスを記録に写さない。実際の引数は本のディレクトリの絶対パス）
  const relArgvOf = (pl, ctx) => (job) => argvFor(relative(ctx.checkout, ctx.cliFile), idOf(job), pl);
  const conds = {};
  for (const g of COMPARE_GROUPS) {
    conds[g] = conditionsFor(ctxOf[g], { jobs, argvOf: relArgvOf(g, ctxOf[g]), pl: g, comparison: { pairs_sha256: pairsSha, group: g, role: COMPARE_ROLES[g], profile }, measurementId: basename(outRoot) });
  }
  // 照合：意図した差（工場の dist・commit・dirty・経路・v1.1α の上限の欄）を除いて、両群の条件が同じか。違えば項目の名前（固定の欄の名前）だけ出して断る
  const comparable = (c) => {
    const { source: _s, factory: _f, comparison: _c, params, child_args: childArgs, ...rest } = c;
    const { pipeline: _p, stage_output_limits_v11a: _l, ...p } = params;
    return { ...rest, params: p, child_args: childArgs.map((x) => ({ id: x.id, argv: x.argv.filter((a, i, all) => !(a === "--pipeline" || all[i - 1] === "--pipeline")) })) };
  };
  const a = comparable(conds.v1.measured), b = comparable(conds["v1.1a"].measured);
  const differs = Object.keys({ ...a, ...b }).flatMap((k) => (k === "params" ? Object.keys({ ...a.params, ...b.params }).filter((pk) => JSON.stringify(a.params[pk]) !== JSON.stringify(b.params[pk])).map((pk) => `params.${pk}`) : JSON.stringify(a[k]) !== JSON.stringify(b[k]) ? [k] : []));
  if (differs.length > 0) refuseCode("compare:fingerprint-differs", { text: `違う項目: ${differs.join("・")}` });
  // v1.1α の 4 段の上限は A1 の承認値（候補の群）
  if (!limitsApproved(conds["v1.1a"].measured.params.stage_output_limits_v11a)) refuseCode("compare:limits-unapproved");

  // ここから書く：対のファイルの写し・群ごとの条件・比較の記録
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, COMPARE_PAIRS_COPY), pairsBytes);
  const startedAt = new Date().toISOString();
  for (const g of COMPARE_GROUPS) {
    const dir = join(outRoot, g);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "conditions.json"), JSON.stringify({ ...conds[g].measured, started_at: startedAt, signature: conds[g].signature }, null, 1));
    groupCtx[g] = { ctx: ctxOf[g], pipeline: g, dir, exitClasses: Object.fromEntries(EXIT_CLASSES.map((c) => [c, 0])), spent: 0, executed: [] };
  }
  const groupRecord = (g) => {
    const m = conds[g].measured;
    return {
      role: COMPARE_ROLES[g], pipeline: g, source: m.source, factory: { fingerprint: m.factory.fingerprint, rebuilt: m.factory.rebuilt }, spec_engine: m.spec_engine.fingerprint,
      prompt_documents: { contract: m.prompt_documents.contract.fingerprint, semantics: m.prompt_documents.semantics.sha256, vocabulary: m.prompt_documents.vocabulary.sha256 },
      stage_output_limits: m.params.stage_output_limits, stage_output_limits_v11a: m.params.stage_output_limits_v11a, defaults: defaultsOf(ctxOf[g]), conditions_signature: conds[g].signature,
    };
  };
  const m1 = conds["v1.1a"].measured;
  const record = {
    schema: COMPARISON_SCHEMA, measurement_id: basename(outRoot), started_at: startedAt,
    pairs: { sha256: pairsSha, count: pairsValue.pairs.length, runs: RUNS, groups: [...COMPARE_GROUPS] },
    groups: Object.fromEntries(COMPARE_GROUPS.map((g) => [g, groupRecord(g)])),
    shared: {
      set: { sha256: m1.set.sha256, id: m1.set.id, version: m1.set.version }, scoring: m1.scoring.fingerprint, scripts: m1.scripts.fingerprint, judge: m1.judge.configuration,
      frozen: { sha256: frozen.sha256, id: frozen.id, version: frozen.version, adopted: frozen.adopted.length }, document: m1.document.sha256,
      params: { effort: m1.params.effort, model: m1.params.model, factory_budget_usd: m1.params.factory_budget_usd, factory_deadline_min: m1.params.factory_deadline_min, mode: m1.params.mode },
    },
    profile, profile_mismatches: mismatches,
    concurrency: CONC, budget_usd: budget, reserve_per_run_usd: perRunBudget, scoring_cost_usd: SCORING_COST_USD,
  };
  writeFileSync(join(outRoot, COMPARISON_FILE), JSON.stringify({ ...record, signature: sha256(JSON.stringify(record)) }, null, 1));
  console.log(`比較: 対 ${pairsValue.pairs.length}・profile ${profile}${mismatches.length > 0 ? `（違う項目: ${mismatches.join("・")}）` : ""}・並列 ${CONC}・上限 ${budget} USD・1 本の予約 ${perRunBudget} USD`);

  // 起動の順：対の順 × 先行順を 1 本の待ち行列にし、枠（両群の合計の並列）が空くたびに先頭を起こす。起こす直前に全体の予算を確かめる（D17）
  const queue = pairsValue.pairs.flatMap((p) => [p.first, COMPARE_GROUPS.find((g) => g !== p.first)].map((g) => ({ pid: p.pid, r: p.r, group: g })));
  const launched = new Set(), inflight = new Set();
  let runningAtStop = null;
  while (queue.length > 0) {
    if (inflight.size >= CONC) { await Promise.race(inflight); continue; }
    if (!launchAllowed({ spentUsd: spent, runningCount: inflight.size, reserveUsd: perRunBudget, budgetUsd: budget })) {
      stop = "全体の予算の上限に届くので、それ以降の本を起こさない"; stopCode = "budget"; runningAtStop = inflight.size; break;
    }
    const job = queue.shift();
    launched.add(`${job.group}/${idOf(job)}`);
    groupCtx[job.group].executed.push(idOf(job));
    const p = runOne(job).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  // 群ごとの起動の記録（今までと同じ形。採点の照合が止まった理由のコードを読む）
  const now = Date.now();
  for (const g of COMPARE_GROUPS) {
    const gc = groupCtx[g];
    const pending = jobs.map(idOf).filter((id) => !gc.executed.includes(id));
    writeFileSync(join(gc.dir, `run-${now}.json`), JSON.stringify({ finished_at: new Date().toISOString(), mode: "fresh", executed: gc.executed, pending, stop, stop_code: stopCode, budget_usd: budget, initial_budget_usd: budget, budget_changed: false, spent_usd: gc.spent, exit_classes: gc.exitClasses }, null, 1));
  }
  // 比較の起動の記録：対ごとの状態（両方・先行だけ・未起動）・起こさなかった本・止まった理由と符号・済みの額・止めたときに走っていた本の数
  const pairStates = pairsValue.pairs.map((p) => {
    const second = COMPARE_GROUPS.find((g) => g !== p.first), id = idOf(p);
    const state = launched.has(`${second}/${id}`) ? "both" : launched.has(`${p.first}/${id}`) ? "first-only" : "unstarted";
    return { pid: p.pid, r: p.r, first: p.first, state };
  });
  const notLaunched = queue.map((j) => ({ group: j.group, run: idOf(j) }));
  writeFileSync(join(outRoot, `${COMPARE_RUN_PREFIX}${now}.json`), JSON.stringify({
    schema: COMPARE_RUN_SCHEMA, finished_at: new Date().toISOString(), pairs: pairStates, not_launched: notLaunched, launched: launched.size,
    stop, stop_code: stopCode, budget_usd: budget, reserve_per_run_usd: perRunBudget, spent_usd: spent, running_at_stop: runningAtStop,
    spent_by_group: Object.fromEntries(COMPARE_GROUPS.map((g) => [g, groupCtx[g].spent])), exit_classes: Object.fromEntries(COMPARE_GROUPS.map((g) => [g, groupCtx[g].exitClasses])),
  }, null, 1));
  console.log("done", stop ?? "", "spent", spent.toFixed(4));
}
