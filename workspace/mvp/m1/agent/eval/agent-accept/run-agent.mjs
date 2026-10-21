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
// #545（段単位の走り。README §5.11。設計書 08 §8.3）：
//   --stage-start <段> / --stage-end <段> / --stage-from <凍結した上流の計測の出力>：--pipeline v1.1a と --build-from と組んでだけ受ける（それ以外は flags:conflict）。
//          段の表（開始・終了・境界）と範囲の決め方は工場の dist（v11a/bundle-v11a.js）が公開する定数と関数を読む（別に手書きしない）。開始 T1 は --stage-from を
//          付けられず、T2・B1 は必須（flags:conflict）。子の引数の末尾に --stage-start・--stage-end（と --stage-input <本のディレクトリの写し>）を足す。
//          子を起こす前に、本ごとの上流の段の走りの記録と開始の段の直前の境界の checkpoint に工場の dist の照合の関数（verifyStageInput）を当てる
//          （記録に残した照合の結果は信頼しない）。断れば exit 4 と固定の符号（stage-from:<工場の符号> など）と本の ID の 1 行で、子を 1 本も起こさない。
//          上流の記録が範囲の中の早期停止で境界に届かなかった本だけを入力なし（stage_input_absent）として起こさず、条件に本の ID と件数を残す。
//          条件の schema は v6（段単位の走りのときだけ）で、params.mode が stage-run・stage_start・stage_end・budget_scope・stage_from・stage_inputs を足す。
//          予算と締切は段の走り 1 本ごとに工場へ渡す（--budget・--deadline。計測全体の目安の額の扱いは今と同じ）。--resume は段の欄を含む署名の一致でだけ許す
//   --compare と段の旗：群は before（--baseline の checkout。凍結した前の候補）と after（<repo>。今の候補）。両群とも v1.1α の経路で、同じ本に同じ上流の入力を渡す。
//          --make-pairs と段の旗は、上流の入力のある本だけで対を書く（交互の順は今の比較と同じ関数）。起こす直前の額の確かめ（D17）も今の比較と同じ関数
// #557（経路 v1.2 と比較の群の組。README §5.13。設計書 08 §8.6・§8.7・§9）：
//   --pipeline v1.2：v1.1a と同じく --build-from と一緒にだけ受け、子の引数の末尾に --pipeline v1.2 を足す（段の旗とは組めない。flags:conflict）。
//          子を起こす前に工場の dist の package の入口（index.js）の V12_PIPELINE_FLAGS（旗の名前 → 真偽）を読み、条件の params.v12_flags に写す
//          （旗の名前をこの道具に書かない）。無い・写像でなければ exit 3・pipeline:v1.2-unavailable で子を 1 本も起こさない。条件の schema は v7（v1.2 のときだけ）。
//          子が終わったら、その本の要約（標準出力の headless-summary）と条件の記録（bundle/build-record.json の conditions）の v12_flags を読み、条件の組と
//          名前 → 真偽の集合として照らして、本ごとの記録（summary.line.json の v12_flags）に報告と結果を残す。起動の記録には全部の本の記録からの集計を残す
//   --compare-pipelines <比較元>,<候補>：v1,v1.1a（省略と同じ）・v1.1a,v1.2・v1,v1.2 だけ。--compare か --make-pairs と一緒にだけ受け、段の旗とは組めない。
//          群は群の経路の名前（<out>/<経路>）で、比較元 ＝ --baseline の checkout（<repo> と同じでよい）、候補 ＝ <repo>。v1.1a,v1.2 は profile を diagnostic（pipelines）にする
// #638（v1.2 の段の走り。README §10.8。設計書 08 の工程ごとの評価の U1）：
//   段の旗は --pipeline v1.2 --build-from とも組める（子の引数の末尾は --pipeline v1.2 のあとに段の旗）。条件の schema は v8（v6 の段の欄に params.pipeline・
//          v12_flags と #618 の v12_call_limits を足した。v1.1α の段単位は v6 のまま）。開始の別名（--stage-start vocabulary など）は工場の dist の
//          STAGE_START_ALIASES_V12 で区間の正本の名前に正規化してから範囲を決める（別名をこの道具に書かない）
//   --stage-from：上流の条件は v6 か v8 で、経路が今の経路と同じこと（違えば stage-from:conditions-pipeline）。v1.2 の照合では工場の dist の照合の関数に、
//          dist の package の入口が公開する旗の組（V12_PIPELINE_FLAGS）と台帳の指紋（propertyLedgerSha256）を渡す
//   --compare と段の旗 × v1.2：両群とも v1.2 の経路。両群の dist の旗の組が同じでなければ compare:flags-mismatch で子を起こさない
// #640（凍結した上流の組。README §10.8.1）：
//   --stage-from <組のディレクトリ>：組のファイル（freeze-stage-input.mjs の出力。人の採否を反映した組だけ）があるディレクトリも受ける。組の署名・写しの SHA・境界（開始の段の直前の境界）・
//          (b)（--build-from の組と同じ）・経路と旗の組（今の計測と同じ）・review を確かめ（違えば exit 4・stage-from:set-*。子 0 本）、P ごとの 1 本をその P の全反復に
//          同じバイト列で渡す。組が外した P は入力なし（stage_input_absent）。条件の params.stage_from は組の種類・id・版・SHA（上流の計測の出力先を渡す形は今のまま）
// 採点は: node score-agent.mjs <repo> <out> [--label high]（リポジトリ・出力先の順で渡す）。比較は score-agent.mjs <repo> <out> --compare
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_RECORD_PATH, CONDITIONS_V7, V12_PIPELINE, comparableParams, comparePipelinesOf, compareProfileOf, compareRolesOf, groupConditionsProblem, isFlagMap, v12FlagsStatus, v12ReportOf, v12RunStatusOf, V12_FLAG_STATUSES } from "./score-agent.mjs";
import { DEFAULT_SET_PATH, FACTORY_VERDICTS, SCRIPT_MODE, fingerprintDir, loadEvalSet, scoringFingerprint, scriptsFingerprint, sha256 } from "./score-agent.mjs";
import { BUILD_STAGE_IDS, COMPARE_GROUPS, COMPARE_PAIRS_COPY, COMPARE_RUN_PREFIX, COMPARE_RUN_SCHEMA, COMPARISON_FILE, COMPARISON_SCHEMA, PIPELINES, SCORING_COST_USD, launchAllowed, limitsApproved, makePairs, outputLimitsOf, pairsProblem } from "./score-agent.mjs";
import { CONDITIONS_V8, sameFlags } from "./score-agent.mjs";
import { CONDITIONS_V6, FAILURE_KINDS as RECORD_FAILURE_KINDS, STAGE_INPUT_DIR, STAGE_COMPARE_GROUPS, STAGE_COMPARE_ROLES, STAGE_COMPARISON_SCHEMA, STAGE_PAIRS_SCHEMA, STAGE_RUN_MODE, conditionsSignature, loadConditions, makeStagePairs, pairsShapeProblem, stagePairsProblem } from "./score-agent.mjs";
import { PLAN_FILE_CHECKS, PLAN_FILE_ERROR_SCHEMA, PLAN_FILE_REJECT_SCHEMA, checkEnvelope, loadFrozenSet, loadPlanFileChecks, refusalLine } from "./freeze-plan-set.mjs";
import { FROZEN_STAGE_SET_FILE, FROZEN_STAGE_SET_KIND, loadFrozenStageSet } from "./freeze-stage-input.mjs";

const args = process.argv.slice(2);
const [repo, outRoot] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
// 断り（exit 3）：既存の断り（#400〜#427）は今までの文のあとに符号を添える。#497 で足した断りは符号と本の ID・件数だけ（値を出さない）
const refuse = (msg, code) => { console.error(refusalLine(code, { text: msg })); process.exit(3); };
const refuseCode = (code, opts) => { console.error(refusalLine(code, opts)); process.exit(3); };
// 段単位の走りの上流の照合の断り（#545）：exit 4（工場の段の入力の照合の失敗と同じ値。exit 3 の断りと取り違えない）。符号と本の ID・件数だけ
const refuseStage = (code, opts) => { console.error(refusalLine(code, opts)); process.exit(4); };

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
// #545：段単位の走り。段の旗のどれかがあれば段単位で、v1.1α の経路の旗と凍結した組の旗が要る（比較・対のファイルでも同じ）
const stageStartArg = valueOf("--stage-start"), stageEndArg = valueOf("--stage-end"), stageFromArg = valueOf("--stage-from");
const stageMode = stageStartArg !== null || stageEndArg !== null || stageFromArg !== null;
if ([stageStartArg, stageEndArg, stageFromArg].includes("")) refuseCode("flags:conflict");
// 段の旗は v1.1a か v1.2（#638）の経路と凍結した組の旗と一緒にだけ受ける
if (stageMode && ((pipelineArg !== "v1.1a" && pipelineArg !== V12_PIPELINE) || buildFrom === null)) refuseCode("flags:conflict");
// v1.1a と v1.2（#557）は凍結した組の旗と一緒にだけ受ける
if (!PIPELINES.includes(pipeline) || (pipeline !== "v1" && buildFrom === null)) refuseCode("flags:conflict");
if ([makePairsOut, baselineArg, pairsArg].includes("")) refuseCode("flags:conflict");
if (makePairsOut !== null && (compare || buildFrom === null || only || resume || (pipelineArg !== null && !stageMode) || baselineArg !== null || pairsArg !== null)) refuseCode("flags:conflict");
if (compare && (buildFrom === null || baselineArg === null || pairsArg === null || only || args.includes("--runs") || resume || (pipelineArg !== null && !stageMode))) refuseCode("flags:conflict");
if (!compare && (baselineArg !== null || pairsArg !== null)) refuseCode("flags:conflict");
// #557：比較の群の組。受ける 3 つの組だけで、--compare か --make-pairs と一緒にだけ受け、段の旗とはどの組でも組めない
const comparePipelinesArg = valueOf("--compare-pipelines"), selectedGroups = comparePipelinesArg === null ? null : comparePipelinesOf(comparePipelinesArg);
if (comparePipelinesArg !== null && (selectedGroups === null || (!compare && makePairsOut === null) || stageMode)) refuseCode("flags:conflict");
/** 比較の群（v1／v1.1α の比較。省略は v1,v1.1a） */
const compareGroups = selectedGroups ?? COMPARE_GROUPS;
if (compare && !args.includes("--budget-usd")) refuseCode("compare:budget-required");
if (compare && !(Number.isFinite(budget) && budget >= 0 && Number.isInteger(CONC) && CONC >= 1)) refuseCode("flags:conflict");
/** 条件の params.mode：build（指定なし）・e2e（--plan）・plan-only・build-from・stage-run（段の旗。#545） */
const mode = stageMode ? STAGE_RUN_MODE : buildFrom !== null ? "build-from" : planOnly ? "plan-only" : plan ? "e2e" : "build";
const model = opt("--model", openai.DEFAULT_OPENAI_MODEL);
const perRunBudget = Number(opt("--factory-budget-usd", String(factory.DEFAULT_BUDGET_USD)));
const deadlineMin = Number(opt("--deadline-min", String(factory.DEFAULT_DEADLINE_MS / 60000)));

// #545：段の表と照合の関数を工場の dist から読む（v11a/bundle-v11a.js。段単位の走りのときだけ読むので、旗を省いた計測は今と同じ）
const STAGE_LIB_VALUES = ["STAGE_STARTS", "STAGE_ENDS", "STAGE_BOUNDARIES", "STAGE_INPUT_CODES", "STAGE_RUN_RECORD_FILE", "STAGE_RUN_RECORD_SCHEMA", "STAGE_BUDGET_SCOPE"];
const STAGE_LIB_FUNCTIONS = ["boundaryBefore", "resolveStageRange", "stageCheckpointFile", "verifyStageInput"];
async function loadStageLib(dir) {
  let lib;
  try { lib = await import(pathToFileURL(join(dir, "v11a/bundle-v11a.js")).href); } catch { refuseCode("stage:dist-unreadable"); }
  if (!STAGE_LIB_VALUES.every((k) => lib[k] !== undefined) || !STAGE_LIB_FUNCTIONS.every((k) => typeof lib[k] === "function")) refuseCode("stage:dist-unreadable");
  // 段の表の並び：開始 i ≤ 終了 i ＜ 開始 i+1 で、境界 i は開始 i+1 の直前（工場の boundaryBefore と resolveStageRange で確かめる。合わなければ境界の判定を組めない）
  const { STAGE_STARTS: starts, STAGE_ENDS: ends, STAGE_BOUNDARIES: bounds } = lib;
  const rangeOk = (start, end) => !("code" in lib.resolveStageRange({ start, end, hasInput: lib.boundaryBefore(start) !== null }));
  const aligned = ends.length === starts.length && bounds.length === starts.length - 1
    && starts.every((st, i) => lib.boundaryBefore(st) === (i === 0 ? null : bounds[i - 1]) && rangeOk(st, ends[i]) && (i === 0 || !rangeOk(st, ends[i - 1])));
  if (!aligned) refuseCode("stage:dist-unreadable");
  return lib;
}
/** 範囲が境界を通るか：開始が境界より前（開始 i ≤ 境界 i）で、終了が境界の後（終了 i ≥ 境界 i）。並びは loadStageLib で dist に照らしてある */
const passesBoundary = (lib, range, boundary) => { const j = lib.STAGE_BOUNDARIES.indexOf(boundary); return j >= 0 && lib.STAGE_STARTS.indexOf(range.start) >= 0 && lib.STAGE_STARTS.indexOf(range.start) <= j && lib.STAGE_ENDS.indexOf(range.end) >= j; };
/**
 * 境界 boundary より前に走りうる段（上流の範囲の開始の区間から境界の直前の区間まで。区間 i ＝ 開始 i 〜 終了 i。dist の表から導く）。
 * 持ち越しの導出（carry-over）は T1'' のあと・境界 t1-t2 の前に走る段で、表には無いので区間 0 にだけ足す（packages/factory/src/v11a/run.ts。全件持ち越しの早期停止）
 */
const CARRY_OVER_STAGE = "carry-over";
const stagesBefore = (lib, range, boundary) => {
  const from = lib.STAGE_STARTS.indexOf(range.start), j = lib.STAGE_BOUNDARIES.indexOf(boundary);
  const ids = [];
  for (let i = from; i >= 0 && i <= j; i++) ids.push(lib.STAGE_STARTS[i], ...(i === 0 ? [CARRY_OVER_STAGE] : []), lib.STAGE_ENDS[i]);
  return [...new Set(ids)];
};
/**
 * 入力なしの記録の整合（境界の checkpoint を宣言しない本）：範囲の中で境界へ未到達と確認できるときだけ真。停止（段は境界より前の段・種類は既知の値）・
 * 段の通過が偽・終了コード 1・段の履歴が全部境界より前の段で、到達した段が履歴の最後と同じで停止の段と一致・宣言した境界は全部それより前
 */
function absentRecordConsistent(lib, record, range, boundary) {
  const before = stagesBefore(lib, range, boundary), j = lib.STAGE_BOUNDARIES.indexOf(boundary);
  const st = record.stopped, stages = record.stages;
  if (!isRec(st) || !before.includes(st.stage) || !RECORD_FAILURE_KINDS.includes(st.kind)) return false;
  if (record.stage_pass !== false || record.exit_code !== 1 || !Array.isArray(stages) || stages.length === 0) return false;
  if (!stages.every((x) => isRec(x) && before.includes(x.stage))) return false;
  if (record.reached_stage !== stages.at(-1).stage || st.stage !== stages.at(-1).stage) return false;
  return record.checkpoints.every((c) => isRec(c) && lib.STAGE_BOUNDARIES.indexOf(c.boundary) >= 0 && lib.STAGE_BOUNDARIES.indexOf(c.boundary) < j);
}
let stageLib = null, stageRange = null, stageBoundary = null;
if (stageMode) {
  stageLib = await loadStageLib(distDir);
  // v1.2（#638）：開始の別名を工場の dist の表で区間の正本の名前に正規化する（表の無い dist は別名を受けない。表に無い段は下で断る）
  const aliasTable = stageLib.STAGE_START_ALIASES_V12;
  const aliases = pipeline === V12_PIPELINE && aliasTable !== null && typeof aliasTable === "object" && !Array.isArray(aliasTable) ? aliasTable : {};
  const stageStart = stageStartArg !== null && Object.hasOwn(aliases, stageStartArg) && typeof aliases[stageStartArg] === "string" ? aliases[stageStartArg] : stageStartArg;
  const resolved = stageLib.resolveStageRange({ ...(stageStart === null ? {} : { start: stageStart }), ...(stageEndArg === null ? {} : { end: stageEndArg }), hasInput: stageFromArg !== null });
  // 表に無い段・開始が終了より後・開始 T1 に --stage-from・開始 T2／B1 に --stage-from が無い（工場の符号は使い方の誤り。計測では組めない指定）
  if ("code" in resolved) refuseCode("flags:conflict");
  stageRange = { start: resolved.start, end: resolved.end };
  stageBoundary = stageLib.boundaryBefore(stageRange.start);
}

// 依頼文は定義ファイルの本から組む（行を改行でつなぐ。request.md にはその末尾に改行を 1 つ足す）
const reqOf = (pid) => evalSet.byId.get(pid).requestText;
// 組の ID は条件の set.id にも書く識別子で、小文字・数字・ハイフンの形のときだけ出す。--only の ID は P<n> の形のものだけを出し、それ以外は件数だけ
const KNOWN_SET_IDS = ["dev-p1-p10", "regression-r1"]; // sets/ にある組の ID（README §5.6・§6）。これ以外の組の ID は断りの文に出さない
const setIdShown = KNOWN_SET_IDS.includes(evalSet.set.id) ? evalSet.set.id : "既知でない組";
if (only && buildFrom === null) {
  const unknown = only.filter((pid) => !evalSet.byId.has(pid)), shaped = unknown.filter((pid) => /^P\d+$/.test(pid)), others = unknown.length - shaped.length;
  if (unknown.length > 0) refuse(`--only に定義ファイル（${setIdShown}）に無い ID があります: ${[...shaped, ...(others > 0 ? [`形の違う ID ${others} 件`] : [])].join(",")}`, "only:unknown");
}

// --make-pairs（#513）：組を読み、採用した P（組の順）× 回数の対を書いて終える。子を起こさない。出力が既にあれば上書きしない。
// 段の旗があれば（#545）、上流の照合のあとで上流の入力のある本だけの対を書く（下）
if (makePairsOut !== null && !stageMode) {
  const fz = loadFrozenSet(resolve(buildFrom));
  if (fz.status === "missing") refuseCode("build-from:frozen-missing");
  if (fz.status !== "ok") refuseCode("build-from:frozen-invalid");
  if (!Number.isInteger(RUNS) || RUNS < 1) refuseCode("flags:conflict");
  if (existsSync(makePairsOut)) refuseCode("compare:pairs-exists");
  const pairsValue = makePairs(fz.set.adopted.map((a) => a.pattern), RUNS, fz.sha256, compareGroups);
  writeFileSync(makePairsOut, JSON.stringify(pairsValue, null, 1) + "\n");
  // 書き終えてから終える（パイプへの書き込みが非同期の環境でも行を落とさない）
  await new Promise((done) => process.stdout.write(`対を書きました: ${pairsValue.pairs.length} 対（採用 ${fz.set.adopted.length} P × ${RUNS} 回）\n`, done));
  process.exit(0);
}

// 経路 v1.2（#557）：旗の組の正本を工場の dist の package の入口から読む（候補 ＝ <repo> の dist。旗の名前を手書きしない）。
// 無い・旗の名前 → 真偽の写像でなければ、子を 1 本も起こさずに断る
const usesV12 = pipeline === V12_PIPELINE || (compare && compareGroups.includes(V12_PIPELINE));
let v12Flags = null, v12CallLimits = null, v12Entry = null;
/** 工場の dist の package の入口（読めなければ null。#557・#638 で比較元の checkout も同じ形で読む） */
const loadEntry = async (dir) => { try { return await import(pathToFileURL(join(dir, "index.js")).href); } catch { return null; } };
if (usesV12) {
  const entry = await loadEntry(distDir);
  if (!isFlagMap(entry?.V12_PIPELINE_FLAGS)) refuseCode("pipeline:v1.2-unavailable");
  v12Entry = entry;
  v12Flags = JSON.parse(JSON.stringify(entry.V12_PIPELINE_FLAGS));
  // 呼び出しの上限（#618）：dist の V12_CALL_LIMITS から読む（写して固定しない）。旗 ids が on なのに無い・3 つが有限の数でないときは断る（黙って欄を省かない）。
  // ids が off か、旗に ids の無い dist（手 3p より前）だけ欄を足さずに通す
  const lim = entry.V12_CALL_LIMITS, ok = (x) => typeof x === "number" && Number.isFinite(x);
  const limOk = lim !== null && typeof lim === "object" && ok(lim.logicalCalls) && ok(lim.realAttempts) && ok(lim.judgeBranch);
  if (v12Flags.ids === true && !limOk) refuseCode("pipeline:v1.2-limits-unavailable");
  if (limOk && v12Flags.ids === true) v12CallLimits = { logical_calls: lim.logicalCalls, real_attempts: lim.realAttempts, judge_branch: lim.judgeBranch };
}

// --compare（#513）：比較元の checkout を同じ形で読む（読めなければ断る。パスは出さない）
let baseline = null;
if (compare) {
  try { baseline = await loadCheckout(resolve(baselineArg)); } catch { refuseCode("compare:baseline-unreadable"); }
}
// 段だけの対の比較 × v1.2（#638）：両群とも v1.2 の経路なので、比較元の dist の旗の組も読み、候補の組と名前 → 真偽の集合として同じことを確かめる（子を起こす前）
let baselineEntry = null;
if (compare && stageMode && pipeline === V12_PIPELINE) {
  baselineEntry = await loadEntry(baseline.distDir);
  if (!isFlagMap(baselineEntry?.V12_PIPELINE_FLAGS)) refuseCode("pipeline:v1.2-unavailable");
  if (!sameFlags(baselineEntry.V12_PIPELINE_FLAGS, v12Flags)) refuseCode("compare:flags-mismatch");
}

// --build-from（#497）：組を読み、対象の本（採用した P。--only はその部分集合だけ）を決め、子を起こす前に包みを検査する（組に保存した検査の結果は信頼しない）
let frozen = null, targets = null, fzLoaded = null, checksList = [];
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
  checksList = [await loadPlanFileChecks(distDir), ...(baseline === null ? [] : [await loadPlanFileChecks(baseline.distDir)])];
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
  // 段だけの対の比較（#545）は、ここでは形だけを見る（上流の入力のある本との一致は上流の照合のあと）
  // 群の組（#557）：対のファイルの groups が選んだ群と同じでなければ compare:pairs-schema
  const problem = stageMode ? pairsShapeProblem(pairsValue, { schema: STAGE_PAIRS_SCHEMA, groups: STAGE_COMPARE_GROUPS }) : pairsProblem(pairsValue, { frozenSha256: fzLoaded.sha256, adopted: fzLoaded.set.adopted.map((a) => a.pattern), groups: compareGroups });
  if (problem !== null) refuseCode(problem);
  RUNS = pairsValue.runs;
}
const idOf = (job) => `${job.pid}-r${job.r}`;
const dirOf = (job) => join(outRoot, `${job.pid}-r${job.r}`);
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const jobs = [];
for (const item of evalSet.items) { const pid = item.id; if (targets !== null ? !targets.includes(pid) : only && !only.includes(pid)) continue; for (let r = 1; r <= RUNS; r++) jobs.push({ pid, r }); }

// #545：上流の照合。開始の段の直前の境界があるとき、子を起こす前に、本ごとの上流の段の走りの記録と境界の checkpoint を読み、工場の dist の照合の関数を当てる
// （比較では両群の checkout の関数を同じ写しに当てる）。記録に残した照合の結果は信頼しない。断れば exit 4 で、子を 1 本も起こさない
const stageInputs = new Map(); // 本の ID → { checkpointFile, checkpointBytes, recordBytes }（照合を通った上流の入力。子のディレクトリに写す）
const stageAbsent = []; // 入力なしの本（上流が範囲の中の早期停止で境界に届かなかった本）
const stageInputRecords = []; // 条件の params.stage_inputs（本ごとの上流の入力の SHA）
let stageFrom = null; // 条件の params.stage_from（上流の計測の条件の指紋と範囲。組のディレクトリなら組の種類・id・版・SHA。#640）
// 照合の関数に渡す確定した仕様（包みの検査の関数で読み直す。--build-from の事前の検査を通った写し）
const planOf = async (checks, pid) => { const parsed = checks.parsePlanFile(Buffer.from(envelopeBytes.get(pid)).toString("utf8")); const v = await checks.validatePlanFile({ envelope: parsed.envelope, source: reqOf(pid) + "\n", vocabularyVersion: checks.vocabularyVersion }); return v?.plan; };
const codeOf = (lib, code) => (Array.isArray(lib.STAGE_INPUT_CODES) && lib.STAGE_INPUT_CODES.includes(code) ? code : "stage-input:unknown");
// v1.2（#638）：照合の関数に渡す旗の組と台帳の指紋は、checkout ごとの dist の package の入口が公開する値（V12_PIPELINE_FLAGS・propertyLedgerSha256）
// #713：開始の段の直前の境界が、その dist の境界の表の最初（上流の段だけが前にある境界）なら、上流の台帳の部分の指紋（upstreamLedgerSha256）の
// 今の値も渡す（照合の関数はその境界でこれを照らす）。関数が無い・例外・返りの値が 64 桁の 16 進でなければ dist の読み取りの失敗（子を起こす前）。
// ほかの境界では部分の関数を取らず・呼ばない（部分の関数の無い今までの dist も、ほかの条件を満たせば受ける）
const SHA256_HEX = /^[0-9a-f]{64}$/;
const v12Of = async (entry, lib) => {
  if (typeof entry?.propertyLedgerSha256 !== "function") refuseCode("stage:dist-unreadable");
  let ledger = null;
  try { ledger = await entry.propertyLedgerSha256(); } catch { ledger = null; }
  if (typeof ledger !== "string") refuseCode("stage:dist-unreadable");
  const flags = JSON.parse(JSON.stringify(entry.V12_PIPELINE_FLAGS));
  if (stageBoundary !== lib.STAGE_BOUNDARIES[0]) return { ledger, flags };
  if (typeof entry.upstreamLedgerSha256 !== "function") refuseCode("stage:dist-unreadable");
  let ledgerUpstream = null;
  try { ledgerUpstream = await entry.upstreamLedgerSha256(); } catch { ledgerUpstream = null; }
  if (typeof ledgerUpstream !== "string" || !SHA256_HEX.test(ledgerUpstream)) refuseCode("stage:dist-unreadable");
  return { ledger, ledgerUpstream, flags };
};
// #640：組のディレクトリ（凍結した上流の組。組のファイルがある）。組の署名・写しの SHA・境界・(b)・経路と旗の組・人の採否を照らし、採用した P の 1 本を
// その P の全反復に同じバイト列で渡す（写しにも工場の dist の照合の関数を当て直す）。組が外した P は入力なし。断れば exit 4・stage-from:set-* で子 0 本
if (stageMode && stageBoundary !== null && existsSync(join(resolve(stageFromArg), FROZEN_STAGE_SET_FILE))) {
  const root = resolve(stageFromArg);
  const ctxs = [main, ...(baseline === null ? [] : [baseline])];
  const libs = [stageLib, ...(baseline === null ? [] : [await loadStageLib(baseline.distDir)])];
  const loaded = loadFrozenStageSet(root);
  if (loaded.status !== "ok") refuseStage(`stage-from:set-${loaded.status}`, { ids: loaded.ids ?? null });
  const set = loaded.set;
  if (set.boundary !== stageBoundary) refuseStage("stage-from:set-boundary");
  if (set.plan_set.sha256 !== frozen.sha256 || set.plan_set.id !== frozen.id || set.plan_set.version !== frozen.version) refuseStage("stage-from:set-plan-set");
  if (set.source.pipeline !== pipeline || !sameFlags(set.source.v12_flags, v12Flags)) refuseStage("stage-from:set-pipeline");
  if (!("review" in set)) refuseStage("stage-from:set-review");
  // 写しの名前：checkpoint は開始の段の直前の境界の名前、記録は工場の dist が前の走りの記録として読む名前（段の走りの記録か Build だけの記録）
  let buildRecordFile = null;
  try { buildRecordFile = (await import(pathToFileURL(join(distDir, "cli-plan.js")).href)).BUILD_CLI_RECORD_FILE ?? null; } catch { buildRecordFile = null; }
  const recordNames = [stageLib.STAGE_RUN_RECORD_FILE, ...(typeof buildRecordFile === "string" ? [buildRecordFile] : [])];
  for (const [pid, input] of loaded.inputs) if (input.checkpointFile !== stageLib.stageCheckpointFile(stageBoundary) || !recordNames.includes(input.recordFile)) refuseStage("stage-from:set-invalid", { ids: [pid] });
  const uncovered = [...new Set(jobs.map((j) => j.pid))].filter((pid) => !set.adopted.some((a) => a.pattern === pid) && !set.missing.some((m) => m.pattern === pid));
  if (uncovered.length > 0) refuseStage("stage-from:set-pattern", { ids: uncovered });
  const v12s = pipeline === V12_PIPELINE ? [await v12Of(v12Entry, libs[0]), ...(baseline === null ? [] : [await v12Of(baselineEntry, libs[1])])] : null;
  const verifiedPatterns = new Set();
  for (const job of jobs) {
    const id = idOf(job), input = loaded.inputs.get(job.pid);
    if (input === undefined) { stageAbsent.push(id); stageInputRecords.push({ id, absent: true }); continue; }
    if (!verifiedPatterns.has(job.pid)) {
      // 記録が宣言する境界の出力ダイジェストが組の宣言と同じ（照合の関数は記録の宣言と checkpoint を照らす）
      let record = null;
      try { record = JSON.parse(input.recordBytes.toString("utf8")); } catch { record = null; }
      const declared = isRec(record) && Array.isArray(record.checkpoints) ? record.checkpoints.find((c) => isRec(c) && c.boundary === stageBoundary) : undefined;
      if (declared?.output_digest !== input.outputDigest) refuseStage("stage-from:set-digest", { ids: [job.pid] });
      const entry = frozen.adopted.find((a) => a.pattern === job.pid);
      for (let i = 0; i < libs.length; i++) {
        const verified = await libs[i].verifyStageInput({
          start: stageRange.start, checkpointText: input.checkpointBytes.toString("utf8"), checkpointFile: input.checkpointFile, recordText: input.recordBytes.toString("utf8"),
          plan: await planOf(checksList[i], job.pid), planSha256: entry.plan_sha256, sourceSha256: entry.source_sha256,
          vocabularyVersion: ctxs[i].factory.VOCABULARY_VERSION, contractVersion: ctxs[i].factory.CONTRACT_VERSION,
          ...(v12s === null ? {} : { v12: v12s[i] }),
        });
        if (verified?.ok !== true) refuseStage(`stage-from:${codeOf(libs[i], verified?.code)}`, { ids: [job.pid] });
      }
      verifiedPatterns.add(job.pid);
    }
    stageInputs.set(id, { checkpointFile: input.checkpointFile, checkpointBytes: input.checkpointBytes, recordBytes: input.recordBytes, recordFile: input.recordFile });
    stageInputRecords.push({ id, checkpoint_sha256: sha256(input.checkpointBytes), record_sha256: sha256(input.recordBytes), output_digest: input.outputDigest, record_file: input.recordFile });
  }
  stageFrom = { kind: FROZEN_STAGE_SET_KIND, id: set.id, version: set.version, sha256: loaded.sha256 };
} else if (stageMode && stageBoundary !== null) {
  const root = resolve(stageFromArg);
  const ctxs = [main, ...(baseline === null ? [] : [baseline])];
  const libs = [stageLib, ...(baseline === null ? [] : [await loadStageLib(baseline.distDir)])];
  // 上流の計測の条件：段単位の走りの版で、署名が中身と合い、同じ定義ファイルと凍結した組から流したもの。範囲が開始の段の直前の境界を通る
  const up = loadConditions(root);
  if (up.status === "missing") refuseStage("stage-from:conditions-missing");
  if (up.status !== "ok") refuseStage("stage-from:conditions-unreadable");
  const upCond = up.cond;
  if ((upCond.schema !== CONDITIONS_V6 && upCond.schema !== CONDITIONS_V8) || upCond.params?.mode !== STAGE_RUN_MODE || typeof upCond.signature !== "string" || upCond.signature !== conditionsSignature(upCond)) refuseStage("stage-from:conditions-invalid");
  // 上流の経路（#638）：v6 は v1.1a、v8 は v1.2 の経路を書く。版と経路が合わない条件は壊れた条件、今の経路と違う上流は混ぜない
  if ((upCond.schema === CONDITIONS_V8) !== (upCond.params.pipeline === V12_PIPELINE)) refuseStage("stage-from:conditions-invalid");
  if (upCond.params.pipeline !== pipeline) refuseStage("stage-from:conditions-pipeline");
  if (upCond.set?.sha256 !== evalSet.sha256 || upCond.frozen?.sha256 !== frozen.sha256) refuseStage("stage-from:conditions-frozen");
  const upRange = { start: upCond.params.stage_start, end: upCond.params.stage_end };
  if (!passesBoundary(stageLib, upRange, stageBoundary)) refuseStage("stage-from:range");
  stageFrom = { conditions_sha256: sha256(readFileSync(join(root, "conditions.json"))), signature: upCond.signature, range: upRange };
  const checkpointFile = stageLib.stageCheckpointFile(stageBoundary);
  const v12s = pipeline === V12_PIPELINE ? [await v12Of(v12Entry, libs[0]), ...(baseline === null ? [] : [await v12Of(baselineEntry, libs[1])])] : null;
  for (const job of jobs) {
    const id = idOf(job), upDir = join(root, id, "bundle"), entry = frozen.adopted.find((a) => a.pattern === job.pid);
    // 上流の段の走りの記録：読める・形の版・範囲が上流の条件と同じ・確定した仕様と依頼文の SHA が凍結した組の値と同じ（読めない・壊れた記録は入力なしにしない）
    let recordBytes = null, record = null;
    try { recordBytes = readFileSync(join(upDir, stageLib.STAGE_RUN_RECORD_FILE)); record = JSON.parse(recordBytes.toString("utf8")); } catch { record = null; }
    if (!isRec(record) || !Array.isArray(record.checkpoints)) refuseStage("stage-from:stage-input:unreadable", { ids: [id] });
    if (record.schema_version !== stageLib.STAGE_RUN_RECORD_SCHEMA) refuseStage("stage-from:stage-input:version", { ids: [id] });
    if (!isRec(record.range) || record.range.start !== upRange.start || record.range.end !== upRange.end) refuseStage("stage-from:record-range", { ids: [id] });
    if (record.plan_sha256 !== entry.plan_sha256) refuseStage("stage-from:stage-input:plan-sha256", { ids: [id] });
    if (record.source_sha256 !== entry.source_sha256) refuseStage("stage-from:stage-input:source-sha256", { ids: [id] });
    if (!record.checkpoints.some((c) => isRec(c) && c.boundary === stageBoundary)) {
      // 入力なし：境界の checkpoint を宣言せず、記録の形と段の履歴から範囲の中で境界へ未到達と確認できる本だけ（absentRecordConsistent）。
      // 境界より後の段の停止・到達・履歴、不正な形の停止など、宣言の欠けた壊れた記録は入力なしにせず断る。早期停止を示さない宣言なしも断る
      if (isRec(record.stopped) || record.stage_pass === false) {
        if (!absentRecordConsistent(stageLib, record, upRange, stageBoundary)) refuseStage("stage-from:record-inconsistent", { ids: [id] });
        stageAbsent.push(id); stageInputRecords.push({ id, absent: true, record_sha256: sha256(recordBytes) }); continue;
      }
      refuseStage("stage-from:stage-input:boundary", { ids: [id] });
    }
    // 境界に届いて checkpoint を宣言した本：材料が無い・壊れていれば工場の照合が断る（入力なしにしない）
    let checkpointBytes = null;
    try { checkpointBytes = readFileSync(join(upDir, checkpointFile)); } catch { checkpointBytes = null; }
    for (let i = 0; i < libs.length; i++) {
      const verified = await libs[i].verifyStageInput({
        start: stageRange.start, checkpointText: checkpointBytes === null ? null : checkpointBytes.toString("utf8"), checkpointFile, recordText: recordBytes.toString("utf8"),
        plan: await planOf(checksList[i], job.pid), planSha256: entry.plan_sha256, sourceSha256: entry.source_sha256,
        vocabularyVersion: ctxs[i].factory.VOCABULARY_VERSION, contractVersion: ctxs[i].factory.CONTRACT_VERSION,
        ...(v12s === null ? {} : { v12: v12s[i] }),
      });
      if (verified?.ok !== true) refuseStage(`stage-from:${codeOf(libs[i], verified?.code)}`, { ids: [id] });
    }
    stageInputs.set(id, { checkpointFile, checkpointBytes, recordBytes });
    stageInputRecords.push({ id, checkpoint_sha256: sha256(checkpointBytes), record_sha256: sha256(recordBytes) });
  }
}
/** 起こす本（入力なしの本を除く。段単位でない計測では予定した本の全部） */
const launchJobs = jobs.filter((j) => !stageAbsent.includes(idOf(j)));
/** 段だけの対の比較の対のファイルが結ぶ範囲と上流の条件の指紋（#545） */
/** 上流の指紋（上流の計測なら条件のファイルの SHA、組のディレクトリなら組のファイルの SHA。#640） */
const stageFromSha256 = stageFrom === null ? null : stageFrom.kind === FROZEN_STAGE_SET_KIND ? stageFrom.sha256 : stageFrom.conditions_sha256 ?? null;
const stagePairsStage = stageMode ? { start: stageRange.start, end: stageRange.end, stage_from_sha256: stageFromSha256 } : null;
if (compare && stageMode) {
  const problem = stagePairsProblem(pairsValue, { frozenSha256: fzLoaded.sha256, expected: launchJobs.map(idOf), stage: stagePairsStage });
  if (problem !== null) refuseCode(problem);
}
// --make-pairs と段の旗（#545）：上流の入力のある本（採用した P の順 × 回数）だけで対を書いて終える。子を起こさない
if (makePairsOut !== null) {
  if (!Number.isInteger(RUNS) || RUNS < 1) refuseCode("flags:conflict");
  if (existsSync(makePairsOut)) refuseCode("compare:pairs-exists");
  const keys = fzLoaded.set.adopted.map((a) => a.pattern).filter((pid) => targets.includes(pid)).flatMap((pid) => Array.from({ length: RUNS }, (_, i) => ({ pid, r: i + 1 }))).filter((k) => !stageAbsent.includes(idOf(k)));
  const pairsOut = makeStagePairs(keys, RUNS, fzLoaded.sha256, stagePairsStage);
  writeFileSync(makePairsOut, JSON.stringify(pairsOut, null, 1) + "\n");
  await new Promise((done) => process.stdout.write(`対を書きました: ${pairsOut.pairs.length} 対（上流の入力のある本。入力なし ${stageAbsent.length} 本は対に入れない）\n`, done));
  process.exit(0);
}
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

// 子プロセスへ渡す引数を 1 か所で組み立て、条件のファイルもここから作る（既定値を別に手書きしない）。v1.1a・v1.2 の経路だけ末尾に --pipeline <経路> を足す（#513・#557）
const argvFor = (cli, dir, pl) => {
  const argv = [cli, join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", effort, "--model", model, "--budget", String(perRunBudget), "--deadline", String(deadlineMin)];
  if (plan || planOnly) argv.push(plan ? "--plan" : "--plan-only", ...(script ? ["--script", join(dir, "script.json")] : ["--answers", join(dir, "answers.json")]));
  if (buildFrom !== null) argv.push("--plan-file", join(dir, "plan-file.json"));
  if (pl === "v1.1a" || pl === V12_PIPELINE) argv.push("--pipeline", pl);
  // 段単位の走り（#545）：工場の開始・終了の段と、開始の段の直前の境界があれば本のディレクトリに写した上流の checkpoint
  if (stageMode) argv.push("--stage-start", stageRange.start, "--stage-end", stageRange.end, ...(stageBoundary === null ? [] : ["--stage-input", join(dir, STAGE_INPUT_DIR, stageLib.stageCheckpointFile(stageBoundary))]));
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
    // 段単位の走り（#545）のときだけ v6（v1.2 の段単位の走りは v8。#638）、経路 v1.2（#557）のときだけ v7。旗を省いた計測は今までどおり v5
    schema: stageMode ? (pl === V12_PIPELINE ? CONDITIONS_V8 : CONDITIONS_V6) : pl === V12_PIPELINE ? CONDITIONS_V7 : "musunest-factory/agent-accept-conditions/v5",
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
      // #557：経路 v1.2 のときだけ。工場の dist の V12_PIPELINE_FLAGS の写し（署名に入る。旗の組が変われば再開を断る）
      ...(pl === V12_PIPELINE ? { v12_flags: v12Flags } : {}),
      // #618：経路 v1.2 の単独の計測だけ（署名に入る。上限が変われば再開を断る）。比較の群には足さない（採点側の比較が params の同一を見るため）
      ...(pl === V12_PIPELINE && comparison === null && v12CallLimits !== null ? { v12_call_limits: v12CallLimits } : {}),
      // #545：段単位の走りのときだけ。範囲・予算と締切の適用の単位（工場の dist の値）・上流の計測の条件の指紋（開始 T1 は null）・本ごとの上流の入力の SHA
      ...(stageMode ? { stage_start: stageRange.start, stage_end: stageRange.end, budget_scope: stageLib.STAGE_BUDGET_SCOPE, stage_from: stageFrom, stage_inputs: stageInputRecords } : {}),
    },
    // 入力なしの本（#545）は起こさないので子の引数は null（予定の一覧には残す）
    child_args: js.map((j) => ({ id: idOf(j), argv: stageAbsent.includes(idOf(j)) ? null : argvOf(j) })),
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
    // 入力なしの本（#545。段単位の走りのときだけ）：子を起こす前に固定する本の ID と件数。署名に入る（採点は分母から黙って除かず別の行に出す）
    ...(stageMode ? { stage_input_absent: { count: stageAbsent.length, ids: [...stageAbsent] } } : {}),
  };
  // 署名（--resume の一致の判定）から外すもの：started_at（補助）、scoring・post-hoc の scripts（上。live の scripts は入れる）、params.budget_usd（計測全体の停止の目安。
  // 予算で止まった計測を --budget-usd を上げて流し切れるようにする。工場 1 本の予算 factory_budget_usd は生成の条件なので残す）。
  // 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）の一致ではない。有効だった額は起動の記録（下）に残す
  const { scoring: _scoring, scripts: _scripts, ...generationConditions } = measured;
  const { budget_usd: _budget, ...paramsForSignature } = measured.params;
  const signature = sha256(JSON.stringify(script ? { ...generationConditions, params: paramsForSignature, scripts: measured.scripts } : { ...generationConditions, params: paramsForSignature }));
  // 上限の欄を足す前の版の署名（欄の無い前の条件のファイルを今までどおり照らす。#618）
  const { v12_call_limits: _vl, ...paramsLegacy } = paramsForSignature;
  const signatureLegacy = sha256(JSON.stringify(script ? { ...generationConditions, params: paramsLegacy, scripts: measured.scripts } : { ...generationConditions, params: paramsLegacy }));
  return { measured, signature, signatureLegacy };
}

const costOfDir = (dir) => { try { const sl = JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")); return sl.plan_cost?.total_usd ?? sl.summary?.provider_cost_usd ?? sl.stage_run?.provider_cost_usd ?? 0; } catch { return 0; } };

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
/** 段の走りの記録（#545。工場の --out の stage-run.json）から起動の記録へ写す欄：段の通過（真偽）・到達した段・停止（段と種類）・費用・終了コード。読めなければ null */
const stageRunOf = (rec) => (!isRec(rec) ? null : {
  stage_pass: typeof rec.stage_pass === "boolean" ? rec.stage_pass : null, reached_stage: enumOf(STAGE_IDS, rec.reached_stage ?? null),
  stopped: !isRec(rec.stopped) ? null : { stage: enumOf(STAGE_IDS, rec.stopped.stage ?? null) ?? "unknown", kind: enumOf(FAILURE_KINDS, rec.stopped.kind ?? null) ?? "unknown" },
  provider_cost_usd: numOf(rec.provider_cost_usd), exit_code: numOf(rec.exit_code),
});

/**
 * 1 本を流す。job.group があれば比較の群の本（#513）：本のディレクトリは <out>/<群>/<本>、入口と cwd はその群の checkout、子の引数は群の経路で組み、
 * 終了の分類はその群の数に足す。終わった本の費用を返す（済みの額は呼ぶ側の spent にも足す）
 */
const runOne = (job) => new Promise((resolve) => {
  const group = job.group === undefined ? null : groupCtx[job.group];
  const runPipeline = group === null ? pipeline : group.pipeline;
  const dir = group === null ? dirOf(job) : join(group.dir, idOf(job));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), reqOf(job.pid) + "\n");
  // 答えのファイルは空（すべて推奨）のまま。--script なら台本の写し（#497）、--build-from なら組の包みの写しを置く（どれも生のまま。記録には写さない）
  if ((plan || planOnly) && !script) writeFileSync(join(dir, "answers.json"), "{}\n");
  if (script) writeFileSync(join(dir, "script.json"), scriptBytes.get(job.pid));
  if (buildFrom !== null) writeFileSync(join(dir, "plan-file.json"), envelopeBytes.get(job.pid));
  // 段単位の走り（#545）：照合を通った上流の checkpoint と段の走りの記録を、そのままのバイト列で本のディレクトリに写す（工場は checkpoint の隣の記録を読む）
  const si = stageInputs.get(idOf(job));
  if (si !== undefined) {
    mkdirSync(join(dir, STAGE_INPUT_DIR), { recursive: true });
    writeFileSync(join(dir, STAGE_INPUT_DIR, si.checkpointFile), si.checkpointBytes);
    // 組のディレクトリから渡す記録は、組に写した名前のまま（段の走りの記録か Build だけの記録。#640）
    writeFileSync(join(dir, STAGE_INPUT_DIR, si.recordFile ?? stageLib.STAGE_RUN_RECORD_FILE), si.recordBytes);
  }
  const cliArgs = group === null ? childArgsFor(job) : argvFor(group.ctx.cliFile, dir, runPipeline);
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
    // 段単位の走り（#545）：要約の行は無いので、費用は工場の段の走りの記録から読む
    const stageRun = stageMode ? stageRunOf((() => { try { return JSON.parse(readFileSync(join(dir, "bundle", stageLib.STAGE_RUN_RECORD_FILE), "utf8")); } catch { return null; } })()) : null;
    const cost = numOf(planCost?.total_usd) ?? numOf(s?.provider_cost_usd) ?? stageRun?.provider_cost_usd ?? 0;
    const exitClass = exitClassOf(code, lines);
    (group === null ? exitClasses : group.exitClasses)[exitClass] += 1;
    // 記録は無害化する（#497）：子の出力の写しはバイト数と既知の版の行の数だけ、要約の verdict は既知の値か unknown。生の中身は stdout.log・stderr.log を開く
    // 要約と費用の行は列挙した欄と型だけ（summaryOf・planCostOf）
    const summary = s === null ? null : summaryOf(s);
    // 経路 v1.2（#557）：要約と条件の記録が報告した旗の組を読み（推定しない）、条件の組と照らした結果と一緒に本ごとの記録に残す
    // 段の走り（#638）は要約の行と条件の記録を書かないので報告を写さない（旗の組は採点が段の走りの記録から照らす）
    const v12 = runPipeline === V12_PIPELINE && !stageMode ? v12ReportsOf(s, join(dir, BUILD_RECORD_PATH)) : null;
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: code, wall_s: (Date.now() - t0) / 1000, started_at: startedAt, exit_class: exitClass, summary, plan_cost: planCostOf(planCost), stderr_tail: tailOf(errBuf), stdout_tail: s === null ? tailOf(outBuf) : undefined, resumed: job.resumed === true, ...(stageMode ? { stage_run: stageRun } : {}), ...(v12 === null ? {} : { v12_flags: v12 }) }, null, 1));
    spent += cost;
    if (group !== null) group.spent += cost;
    console.log(`${group === null ? "" : `${job.group}/`}${idOf(job)} effort=${effort}${plan ? " plan" : ""}${planOnly ? " plan-only" : ""}${buildFrom !== null ? " build-from" : ""}${runPipeline === "v1.1a" || runPipeline === V12_PIPELINE ? ` pipeline=${runPipeline}` : ""}${stageMode ? ` stage=${stageRange.start}..${stageRange.end}` : ""}${job.resumed ? " resume" : ""} exit=${code} ${stageMode ? `stage_pass=${stageRun?.stage_pass ?? "none"}` : `verdict=${s === null ? "none" : verdictOf(s.verdict) ?? "none"}`} cost=${Number(cost).toFixed(4)} ${Math.round((Date.now() - t0) / 1000)}s total=${spent.toFixed(3)}`);
    resolve(cost);
  });
});

/**
 * 経路 v1.2 の報告（#557）：要約の行の v12_flags と、条件の記録（build-record.json）の conditions.v12_flags。欄が無ければ欠測、読めない・写像でなければ不正形。
 * 照合の結果は条件の組と名前 → 真偽の集合として照らす（score-agent.mjs と同じ関数）
 */
function v12ReportsOf(s, recordPath) {
  let raw;
  if (existsSync(recordPath)) { try { const r = JSON.parse(readFileSync(recordPath, "utf8")); raw = isRec(r) && isRec(r.conditions) ? r.conditions.v12_flags : null; } catch { raw = null; } }
  const summary = v12ReportOf(s === null ? undefined : s.v12_flags), record = v12ReportOf(raw);
  return { status: v12FlagsStatus(v12Flags, summary, record), summary, record };
}
/** 起動の記録の旗の組の照合（#557）：出力先の全部の本の記録（再開で飛ばした前の本を含む）から照らし直した結果ごとの本の数と、一致しない本 */
function v12Tally(dir, ids) {
  const counts = Object.fromEntries(V12_FLAG_STATUSES.map((k) => [k, 0])), unverified = [];
  for (const id of ids) {
    let sl;
    try { sl = JSON.parse(readFileSync(join(dir, id, "summary.line.json"), "utf8")); } catch { continue; }
    const st = v12RunStatusOf(sl, v12Flags);
    counts[st] += 1;
    if (st !== "match") unverified.push({ id, status: st });
  }
  return { flags: v12Flags, counts, unverified };
}

/** 比較の群（#513）：群の名前 → { ctx（checkout）, pipeline, dir（<out>/<群>）, exitClasses, spent, executed } */
const groupCtx = {};

if (compare) await runCompare();
else await runSingle();

/** 比較でない計測（今までの流れ。#400〜#497） */
async function runSingle() {
  const { measured, signature, signatureLegacy } = conditionsFor(main, { jobs, argvOf: childArgsFor, pl: pipeline, comparison: null, measurementId: basename(outRoot) });
  mkdirSync(outRoot, { recursive: true });
  const conditionsPath = join(outRoot, "conditions.json");
  const priorDirs = readdirSync(outRoot).filter((n) => /^P\d+-r\d+$/.test(n));
  if (priorDirs.length > 0 || existsSync(conditionsPath)) {
    // 前の結果がある出力先では、既定では子プロセスを 1 本も起こさない（#400）
    if (!resume) refuse("出力先に前の計測の結果があります。続きから流すなら --resume を、新しい計測なら別の出力先を使ってください", "resume:prior-output");
    if (!existsSync(conditionsPath)) refuse("条件のファイルの無い出力先です（新しい出力先を使ってください）", "resume:no-conditions");
    let saved = null; try { saved = JSON.parse(readFileSync(conditionsPath, "utf8")); } catch { refuse("条件のファイルを読めません", "resume:unreadable"); }
    // 上限の欄の無い前の版の条件（params に v12_call_limits が無い）は、その欄を除いた署名で今までどおり照らす（#618）。欄があれば上限も署名で照らす
    const savedLegacy = pipeline === V12_PIPELINE && saved?.params && typeof saved.params === "object" && !("v12_call_limits" in saved.params);
    if (saved?.signature !== (savedLegacy ? signatureLegacy : signature)) refuse("保存した条件と今の条件が一致しません", "resume:signature");
    // 経路 v1.2（#557）：保存した条件を既知の版（v7）として検証し、署名を中身から計算し直して照らす（知らない版・書き換えた条件では再開しない）
    if (pipeline === V12_PIPELINE && (saved.schema !== (stageMode ? CONDITIONS_V8 : CONDITIONS_V7) || conditionsSignature(saved) !== saved.signature)) refuse("保存した条件と今の条件が一致しません", "resume:signature");
    initialBudget = typeof saved.params?.budget_usd === "number" ? saved.params.budget_usd : null;
    for (const job of jobs) {
      const dir = dirOf(job);
      if (!existsSync(dir)) continue;
      if (!existsSync(join(dir, "summary.line.json"))) refuse(`要約の無い途中の本があります: ${idOf(job)}`, "resume:partial");
      if (!existsSync(join(dir, "stdout.log")) || !existsSync(join(dir, "stderr.log"))) refuse(`全文が欠けた古い出力があります: ${idOf(job)}`, "resume:no-logs");
    }
    // 終わった本の費用を足してから、残りの本だけを起こす。既存の条件・全文・要約は上書きしない
    const remaining = [];
    for (const job of launchJobs) {
      const dir = dirOf(job);
      if (existsSync(join(dir, "summary.line.json"))) { skipped.push(idOf(job)); spent += costOfDir(dir); }
      else remaining.push(job);
    }
    console.log(`再開: 飛ばす ${skipped.length} 本、流す ${remaining.length} 本、済みの額 ${spent.toFixed(4)} USD を足した`);
    runQueue = remaining;
  } else {
    writeFileSync(conditionsPath, JSON.stringify({ ...measured, started_at: new Date().toISOString(), signature }, null, 1));
    runQueue = [...launchJobs];
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
  writeFileSync(join(outRoot, `run-${Date.now()}.json`), JSON.stringify({ finished_at: new Date().toISOString(), mode: resume ? "resume" : "fresh", executed, pending, stop, stop_code: stopCode, budget_usd: budget, initial_budget_usd: initialBudget, budget_changed: initialBudget === null ? null : initialBudget !== budget, spent_usd: spent, exit_classes: exitClasses, ...(pipeline === V12_PIPELINE && !stageMode ? { v12_flags: v12Tally(outRoot, launchJobs.map(idOf)) } : {}) }, null, 1));
  console.log("done", stop ?? "", "spent", spent.toFixed(4));
}

/**
 * 対にした交互の計測（#513。設計書 07 §4・D7・D17）。起動の前に、両群の条件を組み、既定・指紋・上限を照合する（どれかが違えば断り、何も書かない）。
 * 意図した差は工場の dist・commit・dirty・経路・v1.1α の上限の欄だけ（#557：v1.2 の旗の組と条件の版の差も）。正式な比較の条件（OFFICIAL_COMPARE）は断らずに profile として残す
 */
async function runCompare() {
  // 出力先は新しい場所だけ（比較は再開しない）
  if (existsSync(outRoot) && readdirSync(outRoot).length > 0) refuseCode("compare:prior-output");
  const pairsSha = sha256(pairsBytes);
  // 群（#545）：段だけの対の比較は before（比較元）・after（候補）で、両群とも段の旗と組んだ経路（v1.1a か v1.2。#638）。それ以外は選んだ群の組（#557。省略は v1・v1.1a）
  const GROUPS = stageMode ? STAGE_COMPARE_GROUPS : compareGroups, ROLES = stageMode ? STAGE_COMPARE_ROLES : compareRolesOf(compareGroups);
  const [baseGroup, candGroup] = GROUPS;
  const pipelineOf = (g) => (stageMode ? pipeline : g);
  const ctxOf = { [baseGroup]: baseline, [candGroup]: main };
  // 工場の既定（子に渡す値の出どころ。片方だけ違えば、同じ引数でも条件の意味が揃わない）
  const defaultsOf = (ctx) => ({
    effort: ctx.factory.DEFAULT_EFFORT, budget_usd: ctx.factory.DEFAULT_BUDGET_USD, deadline_ms: ctx.factory.DEFAULT_DEADLINE_MS, model: ctx.openai.DEFAULT_OPENAI_MODEL,
    reasoning_effort: ctx.limits.DEFAULT_REASONING_EFFORT, vocabulary_version: ctx.factory.VOCABULARY_VERSION, api_key_env: ctx.factory.API_KEY_ENV, jev_key_env: ctx.factory.JEV_API_KEY_ENV,
  });
  if (JSON.stringify(defaultsOf(baseline)) !== JSON.stringify(defaultsOf(main))) refuseCode("compare:defaults-differ");
  // 正式な比較の条件（断らない。違った項目の名前だけ残す）。採点 v5 は採点の定義に rubric-v5.mjs があるとき
  const scoring = scoringOf();
  const baseHead = gitOut(baseline.checkout, ["rev-parse", "HEAD"]), baseStatus = gitOut(baseline.checkout, ["status", "--porcelain"]);
  // 段だけの対の比較（#545）には正式な比較の条件（OFFICIAL_COMPARE。v1 と v1.1α の全体の比較）を当てない（profile は null）。
  // 群の組（#557）：比較元が v1 の組は今の定数で判定し、v1.1a,v1.2 は diagnostic（違った項目に pipelines）
  const { profile, mismatches } = stageMode ? { profile: null, mismatches: [] } : compareProfileOf({
    baseline_commit: baseHead === null ? null : baseHead.trim(), baseline_dirty: baseStatus === null ? null : baseStatus.trim().length > 0,
    frozen_sha256: frozen.sha256, frozen_id: frozen.id, frozen_version: frozen.version, frozen_adopted: frozen.adopted.length,
    runs: RUNS, effort, deadline_min: deadlineMin, factory_budget_usd: perRunBudget, concurrency: CONC, budget_usd: budget,
    rubric: scoring.files.some((f) => f.path === "rubric-v5.mjs") ? "v5" : null,
  }, GROUPS);
  // 条件に書く子の引数は checkout と出力先からの相対（比較元のパスを記録に写さない。実際の引数は本のディレクトリの絶対パス）
  const relArgvOf = (pl, ctx) => (job) => argvFor(relative(ctx.checkout, ctx.cliFile), idOf(job), pl);
  const conds = {};
  for (const g of GROUPS) {
    conds[g] = conditionsFor(ctxOf[g], { jobs, argvOf: relArgvOf(pipelineOf(g), ctxOf[g]), pl: pipelineOf(g), comparison: { pairs_sha256: pairsSha, group: g, role: ROLES[g], profile }, measurementId: basename(outRoot) });
  }
  // 経路 v1.2 を含む組（#557）：各群の条件を版ごとに検証してから（v1・v1.1a は v5、v1.2 は v7）、共通の形で照らす。保存する条件と署名は元のまま
  if (GROUPS.includes(V12_PIPELINE)) for (const g of GROUPS) { const problem = groupConditionsProblem(conds[g].measured, g); if (problem !== null) refuseCode(problem); }
  // 照合：意図した差（工場の dist・commit・dirty・経路・v1.1α の上限の欄・v1.2 の旗の組と条件の版）を除いて、両群の条件が同じか。違えば項目の名前（固定の欄の名前）だけ出して断る
  const comparable = (c) => {
    const { source: _s, factory: _f, comparison: _c, schema: _v, params, child_args: childArgs, ...rest } = c;
    const p = comparableParams(params);
    return { ...rest, params: p, child_args: childArgs.map((x) => ({ id: x.id, argv: x.argv === null ? null : x.argv.filter((a, i, all) => !(a === "--pipeline" || all[i - 1] === "--pipeline")) })) };
  };
  const a = comparable(conds[baseGroup].measured), b = comparable(conds[candGroup].measured);
  const differs = Object.keys({ ...a, ...b }).flatMap((k) => (k === "params" ? Object.keys({ ...a.params, ...b.params }).filter((pk) => JSON.stringify(a.params[pk]) !== JSON.stringify(b.params[pk])).map((pk) => `params.${pk}`) : JSON.stringify(a[k]) !== JSON.stringify(b[k]) ? [k] : []));
  if (differs.length > 0) refuseCode("compare:fingerprint-differs", { text: `違う項目: ${differs.join("・")}` });
  // v1.1α の 4 段の上限は A1 の承認値（経路が v1.1a か v1.2 の群すべて。#557。段だけの対の比較は両群とも v1.1α の経路なので両群）
  if (!GROUPS.filter((g) => pipelineOf(g) !== "v1").every((g) => limitsApproved(conds[g].measured.params.stage_output_limits_v11a))) refuseCode("compare:limits-unapproved");

  // ここから書く：対のファイルの写し・群ごとの条件・比較の記録
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, COMPARE_PAIRS_COPY), pairsBytes);
  const startedAt = new Date().toISOString();
  for (const g of GROUPS) {
    const dir = join(outRoot, g);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "conditions.json"), JSON.stringify({ ...conds[g].measured, started_at: startedAt, signature: conds[g].signature }, null, 1));
    groupCtx[g] = { ctx: ctxOf[g], pipeline: pipelineOf(g), dir, exitClasses: Object.fromEntries(EXIT_CLASSES.map((c) => [c, 0])), spent: 0, executed: [] };
  }
  const groupRecord = (g) => {
    const m = conds[g].measured;
    return {
      role: ROLES[g], pipeline: pipelineOf(g), source: m.source, factory: { fingerprint: m.factory.fingerprint, rebuilt: m.factory.rebuilt }, spec_engine: m.spec_engine.fingerprint,
      prompt_documents: { contract: m.prompt_documents.contract.fingerprint, semantics: m.prompt_documents.semantics.sha256, vocabulary: m.prompt_documents.vocabulary.sha256 },
      stage_output_limits: m.params.stage_output_limits, stage_output_limits_v11a: m.params.stage_output_limits_v11a, defaults: defaultsOf(ctxOf[g]), conditions_signature: conds[g].signature,
      // 経路 v1.2 の群（#557）：条件に写した旗の組
      ...(pipelineOf(g) === V12_PIPELINE ? { v12_flags: m.params.v12_flags } : {}),
    };
  };
  const m1 = conds[candGroup].measured;
  const record = {
    schema: stageMode ? STAGE_COMPARISON_SCHEMA : COMPARISON_SCHEMA, measurement_id: basename(outRoot), started_at: startedAt,
    // 段だけの対の比較（#545）：範囲・上流の計測の条件の指紋・入力なしの本の件数（本の ID は群の条件に）
    ...(stageMode ? { stage: { start: stageRange.start, end: stageRange.end, stage_from_sha256: stageFromSha256, input_absent: stageAbsent.length } } : {}),
    pairs: { sha256: pairsSha, count: pairsValue.pairs.length, runs: RUNS, groups: [...GROUPS] },
    groups: Object.fromEntries(GROUPS.map((g) => [g, groupRecord(g)])),
    shared: {
      set: { sha256: m1.set.sha256, id: m1.set.id, version: m1.set.version }, scoring: m1.scoring.fingerprint, scripts: m1.scripts.fingerprint, judge: m1.judge.configuration,
      frozen: { sha256: frozen.sha256, id: frozen.id, version: frozen.version, adopted: frozen.adopted.length }, document: m1.document.sha256,
      params: { effort: m1.params.effort, model: m1.params.model, factory_budget_usd: m1.params.factory_budget_usd, factory_deadline_min: m1.params.factory_deadline_min, mode: m1.params.mode },
    },
    profile, profile_mismatches: mismatches,
    concurrency: CONC, budget_usd: budget, reserve_per_run_usd: perRunBudget, scoring_cost_usd: SCORING_COST_USD,
  };
  writeFileSync(join(outRoot, COMPARISON_FILE), JSON.stringify({ ...record, signature: sha256(JSON.stringify(record)) }, null, 1));
  console.log(`比較: 対 ${pairsValue.pairs.length}・${stageMode ? `段 ${stageRange.start}..${stageRange.end}（入力なし ${stageAbsent.length} 本は対に入れない）` : `profile ${profile}`}${mismatches.length > 0 ? `（違う項目: ${mismatches.join("・")}）` : ""}・並列 ${CONC}・上限 ${budget} USD・1 本の予約 ${perRunBudget} USD`);

  // 起動の順：対の順 × 先行順を 1 本の待ち行列にし、枠（両群の合計の並列）が空くたびに先頭を起こす。起こす直前に全体の予算を確かめる（D17）
  const queue = pairsValue.pairs.flatMap((p) => [p.first, GROUPS.find((g) => g !== p.first)].map((g) => ({ pid: p.pid, r: p.r, group: g })));
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
  for (const g of GROUPS) {
    const gc = groupCtx[g];
    const pending = launchJobs.map(idOf).filter((id) => !gc.executed.includes(id));
    writeFileSync(join(gc.dir, `run-${now}.json`), JSON.stringify({ finished_at: new Date().toISOString(), mode: "fresh", executed: gc.executed, pending, stop, stop_code: stopCode, budget_usd: budget, initial_budget_usd: budget, budget_changed: false, spent_usd: gc.spent, exit_classes: gc.exitClasses, ...(gc.pipeline === V12_PIPELINE && !stageMode ? { v12_flags: v12Tally(gc.dir, launchJobs.map(idOf)) } : {}) }, null, 1));
  }
  // 比較の起動の記録：対ごとの状態（両方・先行だけ・未起動）・起こさなかった本・止まった理由と符号・済みの額・止めたときに走っていた本の数
  const pairStates = pairsValue.pairs.map((p) => {
    const second = GROUPS.find((g) => g !== p.first), id = idOf(p);
    const state = launched.has(`${second}/${id}`) ? "both" : launched.has(`${p.first}/${id}`) ? "first-only" : "unstarted";
    return { pid: p.pid, r: p.r, first: p.first, state };
  });
  const notLaunched = queue.map((j) => ({ group: j.group, run: idOf(j) }));
  writeFileSync(join(outRoot, `${COMPARE_RUN_PREFIX}${now}.json`), JSON.stringify({
    schema: COMPARE_RUN_SCHEMA, finished_at: new Date().toISOString(), pairs: pairStates, not_launched: notLaunched, launched: launched.size,
    stop, stop_code: stopCode, budget_usd: budget, reserve_per_run_usd: perRunBudget, spent_usd: spent, running_at_stop: runningAtStop,
    spent_by_group: Object.fromEntries(GROUPS.map((g) => [g, groupCtx[g].spent])), exit_classes: Object.fromEntries(GROUPS.map((g) => [g, groupCtx[g].exitClasses])),
  }, null, 1));
  console.log("done", stop ?? "", "spent", spent.toFixed(4));
}
