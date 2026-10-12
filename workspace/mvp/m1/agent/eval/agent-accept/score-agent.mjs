// 受入の試験の採点：run-agent.mjs の出力を採点表 v5（凍結）で採点し、基準線と同じ指標を出す。API は呼ばない。
// 使い方: node score-agent.mjs <repo> <out> [--label high] [--anonymous] [--set <定義ファイル>]
//   --anonymous：行ごとの失敗の鍵・要件の文・題材 ID を出さず、指標の数と区間だけを書く（回帰用・保留用の組。#425）。
//                書くのは score[-label].anonymous.json だけで、行つきの score[-label].json は書かない
//   --set：評価セットの定義ファイル（#427）。省略すると条件のファイルに記録された定義ファイル、それも無ければ既定の sets/dev-p1-p10.json
// #425 で足したもの（既存の欄は消さず、意味も変えない）：
//   集計の版 … v1 ＝ 補正前（metrics の fulfillment_partial と rows の fulfilled／writable_total。生成失敗・静的 NG の本は
//              充足率の分母に入らない）。v2 ＝ 補正後（fulfillment.v2 と rows の fulfillment_v2。分母は題材の採点定義の判定の数。
//              生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す）。2 つの版は別の欄に並べ、混ぜない
//   本数の照合 … completion。条件のファイルの予定（child_args）を検証（schema・一覧の型・ID の形と一意性・params.patterns × runs との一致）
//              してから出力先の本と照合し、未実行・途中・予定外が 1 本でもあれば「未完了」。検証に落ちれば「未照合」と理由
//   指紋 … fingerprints。採点に使った定義とエンジン（<repo> から実際に読み込んだもの）と集計のコード（実行中のこのファイル）の指紋、
//          spec-engine の dist の指紋。条件のファイルの値と照合する（別の checkout を <repo> に渡しても、集計したコードの指紋が出る）
// #426 で足したもの（原文系の欄は変えない。README §5.5）：
//   了承後系 … Plan を通した本を、確定した仕様（bundle/artifacts/plan.json。契約の検査 checkConfirmedPlan を通ったものだけ）の了承の記録で読み替えて
//              別に数える。了承済みの書けない要件は申告が無くても挙げ漏れにせず（claims_accepted）、誤った除外・判定不能・未評価を別に数える
//              （rows[].acceptance・metrics_accepted・fulfillment.accepted）。原文の要件との対応は定義の keys（正規表現）で、処分した部分の文だけに当てる。
//              分母・分子は v2 と同じ（了承で変わった判定も誤った除外も外さない）。変更後を判定する手段（対応データ。別の Issue）が無い間、
//              誤った了承の指標は「未評価」で、変更が当たった本の了承後の判定は UNEVALUATED（PASS にしない）。
//              処分の照合（expected・allowed）とは別に、了承後の有効な要件の評価の状態（acceptance.effective）を持つ：判定の手段が無い有効な要件
//              （代替先・変更後・追加）が 1 つでもあれば、照合が expected でもその本は UNEVALUATED。件数は行・集計・匿名・標準出力に残す。
//              記録の無い本（理由の内訳つき）・読めない本は充足 0 で分母に残す。Plan を通していない計測の本は対象外（null）
// #427 で足したもの（README §5.6）：
//   評価セットの定義ファイル … 本の ID → 題材・書き方・書ける範囲・採点の定義・台本・依頼文を 1 つのファイル（sets/<組>.json）から読む。
//              P 番号と題材の対応をこの道具の中に持たない。条件のファイルの set.path（無ければ既定の組）を読み、指紋を条件と照合する
//   台本 … Plan の質問に、質問 ID ではなく点検済みの事項（文の鍵と目録の観点）で答える台本（sets/scripts/<題材>.json）を、往復の記録の
//              全部の問いに**事後に**当てる（工場の答えの口は質問 ID で Plan の前に 1 度だけ読むので、実行中には当てられない）。台本に無い問いは
//              「不明」、決められない問いは「決められない」として数え、推奨に丸めない（rows[].script・metrics_script）。判定と合格率は変えない
// run-agent.mjs は、ここから指紋の関数と定義ファイルの読み込みを import して条件のファイルに書く（道具は 2 本で 1 組。入口として起動したときだけ採点する）
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGGREGATION_VERSIONS = {
  v1: "補正前：充足率の分母は当てはまった構造の判定の数。生成失敗・静的 NG の本は分母に入らない",
  v2: "補正後：充足率の分母は題材の採点定義の判定の数（当てはまった構造。無ければ主の構造）。生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す",
};
/** 採点の系（#426）。原文系 ＝ 凍結した v5 の判定のまま。了承後系 ＝ 確定した仕様の了承の記録で読み替える。2 つの系は別の欄に並べ、混ぜない */
export const SCORING_SYSTEMS = {
  source: "原文系：凍結した v5 の判定のまま（集計の版 v1・v2）。了承の記録は見ない",
  accepted: "了承後系：確定した仕様（plan.json。契約の検査を通ったもの）の了承の記録で読み替える。了承済みの書けない要件は申告が無くても挙げ漏れにせず、誤った除外・判定不能・未評価を別に数える。分母・分子は v2 と同じ（了承で変わった判定も誤った除外も外さない）。変更後を判定する手段が無い間、誤った了承は未評価、変更が当たった本の判定は UNEVALUATED。生成失敗・静的 NG・記録の無い本は充足 0 で分母に残す",
};
/** 条件のファイルの既知の schema（v1 ＝ #401、v2 ＝ #425、v3 ＝ #427。どれも child_args と params.patterns・params.runs を持つ） */
export const CONDITIONS_SCHEMAS = ["musunest-factory/agent-accept-conditions/v1", "musunest-factory/agent-accept-conditions/v2", "musunest-factory/agent-accept-conditions/v3"];
/** 工場の要約の verdict の既知の値（packages/factory の Verdict）。匿名の集計はこれ以外を unknown にまとめる */
export const FACTORY_VERDICTS = ["full", "partial", "none"];
/** 判定の口の構成の既知の値（run-agent.mjs が記録する） */
export const JUDGE_CONFIGURATIONS = ["jev-primary-llm-fallback", "llm-only"];
/** 起動の記録の止まった理由のコード（budget ＝ 計測全体の目安の額に達した。other ＝ それ以外の文） */
export const STOP_CODES = ["budget", "other"];
const COMPLETION_LABELS = { complete: "完了", incomplete: "未完了", unverified: "未照合" };

// ── 指紋（run-agent.mjs と共有）
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const walkFiles = (dir, base = dir) => readdirSync(dir).sort().flatMap((name) => { const full = join(dir, name); return statSync(full).isDirectory() ? walkFiles(full, base) : [relative(base, full)]; });
/** ディレクトリの指紋（相対パスと中身のハッシュ）と、いちばん新しい更新時刻 */
export const fingerprintDir = (dir) => {
  if (!existsSync(dir)) return { fingerprint: null, files: 0, mtime_ms: null };
  const files = walkFiles(dir);
  const h = createHash("sha256");
  let mtime = 0;
  for (const rel of files) { const full = join(dir, rel); h.update(rel); h.update("\0"); h.update(sha256(readFileSync(full))); h.update("\n"); mtime = Math.max(mtime, statSync(full).mtimeMs); }
  return { fingerprint: h.digest("hex"), files: files.length, mtime_ms: files.length ? mtime : null };
};
/** 採点の定義と集計のコード：エンジン・申告の採点・入口・この採点の道具と、題材の定義（subjects/*.json）全部 */
export const SCORING_FILES = ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "agent-accept/score-agent.mjs"];
/** 集計のコード（この道具）。指紋の中では evDir からの相対名で数えるが、実体は aggregator で差し替えられる */
export const AGGREGATOR_FILE = "agent-accept/score-agent.mjs";
/**
 * evDir は定義とエンジンを実際に読み込む場所。aggregator は集計のコードの実体のパス（既定は evDir の中の score-agent.mjs。
 * 条件のファイルへ書く run-agent.mjs は既定のまま＝ <repo> の採点器。採点する scoreOutput は実行中のファイルを渡す）。
 * 別の checkout の採点器を起動して <repo> を渡したときに、<repo> の旧い採点器の指紋を「一致」と出さないため
 */
export function scoringFingerprint(evDir, aggregator = join(evDir, AGGREGATOR_FILE)) {
  const subjectsDir = join(evDir, "subjects");
  const subjects = existsSync(subjectsDir) ? readdirSync(subjectsDir).filter((n) => n.endsWith(".json")).sort().map((n) => `subjects/${n}`) : [];
  const h = createHash("sha256");
  const files = [], missing = [];
  for (const rel of [...SCORING_FILES, ...subjects]) {
    const full = rel === AGGREGATOR_FILE ? aggregator : join(evDir, rel);
    if (!existsSync(full)) { missing.push(rel); continue; }
    const digest = sha256(readFileSync(full));
    files.push({ path: rel, sha256: digest });
    h.update(rel); h.update("\0"); h.update(digest); h.update("\n");
  }
  return { fingerprint: h.digest("hex"), files, missing };
}

// ── 本数の照合
const RUN_DIR = /^P\d+-r\d+$/;
const PATTERN_ID = /^P\d+$/;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const runDirs = (outRoot) => readdirSync(outRoot).filter((x) => RUN_DIR.test(x)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
/** 条件のファイルを読む：無ければ missing、JSON として読めないか object でなければ unreadable */
export function loadConditions(outRoot) {
  const path = join(outRoot, "conditions.json");
  if (!existsSync(path)) return { status: "missing", cond: null };
  try { const c = readJson(path); return c !== null && typeof c === "object" && !Array.isArray(c) ? { status: "ok", cond: c } : { status: "unreadable", cond: null }; } catch { return { status: "unreadable", cond: null }; }
}
export const readConditions = (outRoot) => loadConditions(outRoot).cond;
/**
 * 条件のファイルの予定を検証する（照合できない理由の一覧。空なら照合できる）。理由に入力の値は含めない。
 * 見るもの：既知の schema・予定の一覧（child_args）が配列・各 ID が文字列で P<n>-r<n> の形・ID の一意性・params.patterns と params.runs の形・
 * 予定の一覧が params.patterns × runs と一致・予定が 1 本以上。欠落・旧形式・編集後の不整合を「完了」に丸めないための検証
 */
export function validatePlanned(cond) {
  const reasons = [];
  if (!CONDITIONS_SCHEMAS.includes(cond?.schema)) reasons.push("schema が未知");
  const list = cond?.child_args;
  const isList = Array.isArray(list);
  if (!isList) reasons.push("予定の一覧（child_args）が無いか配列でない");
  const ids = isList ? list.map((c) => c?.id) : [];
  const idsOk = isList && ids.every((id) => typeof id === "string" && RUN_DIR.test(id));
  if (isList && !idsOk) reasons.push("予定の ID が文字列でないか P<n>-r<n> の形でない");
  if (idsOk && new Set(ids).size !== ids.length) reasons.push("予定の ID が重複");
  const p = cond?.params;
  const paramsOk = Array.isArray(p?.patterns) && p.patterns.every((x) => typeof x === "string" && PATTERN_ID.test(x)) && Number.isInteger(p?.runs) && p.runs >= 0;
  if (!paramsOk) reasons.push("params.patterns・params.runs が無いか形が違う");
  if (idsOk && paramsOk) {
    const expected = p.patterns.flatMap((pid) => Array.from({ length: p.runs }, (_, i) => `${pid}-r${i + 1}`)).sort();
    if (JSON.stringify(expected) !== JSON.stringify([...ids].sort())) reasons.push("予定の一覧が params.patterns × runs と一致しない");
  }
  if (isList && list.length === 0) reasons.push("予定が 0 本");
  return reasons;
}
const stopCodeOf = (r) => (STOP_CODES.includes(r.stop_code) ? r.stop_code : r.stop === null || r.stop === undefined ? null : /^予算 /.test(String(r.stop)) ? "budget" : "other");
/**
 * 予定した本（条件のファイルの child_args）・実行した本（要約のある本）・未実行の本（ディレクトリが無い）・途中の本（要約の無い本）・予定外の本（予定に無いディレクトリ）を照合する。
 * 未実行・途中・予定外が 1 本でもあれば「未完了」（正式な比較基準にしない、の機械の目印。方法論 01 §3）。
 * 条件のファイルが無い出力先（#401 より前の計測）・読めない条件・予定を検証できない条件（validatePlanned）は照合できないので「未照合」と理由。
 */
export function reconcile(outRoot) {
  const dirs = runDirs(outRoot);
  const executed = dirs.filter((d) => existsSync(join(outRoot, d, "summary.line.json")));
  const incomplete = dirs.filter((d) => !executed.includes(d));
  // 1 回の起動の記録（run-<時刻>.json。再開は resume-<時刻>.json も残す）。いちばん新しいものの止まった理由（文とコード）・残りの本・その起動で有効だった目安の額を添える
  const records = readdirSync(outRoot).filter((n) => /^(run|resume)-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const last = records.at(-1);
  const latest_record = last === undefined ? null : (() => { const r = readJson(join(outRoot, last)); return { file: last, stop: r.stop ?? null, stop_code: stopCodeOf(r), pending: r.pending ?? [], budget_usd: typeof r.budget_usd === "number" ? r.budget_usd : null }; })();
  const loaded = loadConditions(outRoot);
  const cond = loaded.cond;
  const unverified = (reasons) => ({ status: "unverified", label: COMPLETION_LABELS.unverified, reasons, measurement_id: typeof cond?.measurement_id === "string" ? cond.measurement_id : null, signature: typeof cond?.signature === "string" ? cond.signature : null, planned: null, executed: executed.length, executed_ids: executed, unexecuted: null, incomplete, extra: null, latest_record });
  if (loaded.status === "missing") return unverified(["条件のファイルが無い"]);
  if (loaded.status === "unreadable") return unverified(["条件のファイルを読めない"]);
  const invalid = validatePlanned(cond);
  if (invalid.length > 0) return unverified(invalid);
  const planned = cond.child_args.map((c) => c.id);
  const unexecuted = planned.filter((id) => !dirs.includes(id));
  const extra = dirs.filter((id) => !planned.includes(id));
  const reasons = [];
  if (unexecuted.length > 0) reasons.push(`未実行 ${unexecuted.length} 本`);
  if (incomplete.length > 0) reasons.push(`途中 ${incomplete.length} 本`);
  if (extra.length > 0) reasons.push(`予定外 ${extra.length} 本`);
  const status = reasons.length === 0 ? "complete" : "incomplete";
  return { status, label: COMPLETION_LABELS[status], reasons, measurement_id: cond.measurement_id ?? null, signature: cond.signature ?? null, planned: planned.length, executed: executed.length, executed_ids: executed, unexecuted, incomplete, extra, latest_record };
}

// ── 評価セットの定義ファイルと台本（#427。README §5.6）
/** 定義ファイルの契約の版 */
export const EVAL_SET_SCHEMA = "musunest-eval/eval-set/v1";
/** 台本の契約の版 */
export const PLAN_SCRIPT_SCHEMA = "musunest-eval/plan-script/v1";
/** 組の役割（方法論 01 §1） */
export const EVAL_SET_ROLES = ["development", "regression", "holdout"];
/** 工場の目録の観点 ID（packages/factory の CATALOG_FACETS と同じ値。台本の facet に書けるもの） */
export const CATALOG_FACET_IDS = ["aggregation", "period", "current-period", "counted-state", "include-zero", "editable-by"];
/** 既定の組（<repo> からの相対。今の P1〜P10） */
export const DEFAULT_SET_PATH = "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json";
/** 台本の当て方。今は採点で事後に当てる（工場に事項で答える口が無い。README §5.6.3） */
export const SCRIPT_MODE = "post-hoc";
/** 問い 1 つの台本の照合の状態：台本で答えられた／台本に無い（不明）／決められない */
export const SCRIPT_QUESTION_STATUSES = ["scripted", "unknown", "unresolved"];
/** 決められない理由：台本の件が 2 つ以上当たる／当たる選択肢が無い／当たる選択肢が 2 つ以上 */
export const SCRIPT_UNRESOLVED_REASONS = ["entries", "no-choice", "many-choices"];
/** 本 1 つの台本の照合の状態：全部一致／台本と違う答えで進んだ／不明か決められない問いで進んだ／問いが無い／往復の記録が無い（対象外） */
export const SCRIPT_RUN_STATUSES = ["ok", "disagreed", "unanswered", "no-questions", "none"];
const CATALOG_ISSUE_ID = /^OI:catalog:(.+):([^:]+)$/;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const compiles = (k) => { if (typeof k !== "string" || k === "") return false; try { new RegExp(k); return true; } catch { return false; } };
const regexList = (xs) => Array.isArray(xs) && xs.length > 0 && xs.every(compiles);
/** 台本の形を検証する（落ちた理由の一覧。空なら読める。理由に入力の値は含めない） */
export function validateScript(script) {
  if (!isObj(script)) return ["台本が写像でない"];
  const reasons = [];
  if (script.schema !== PLAN_SCRIPT_SCHEMA) reasons.push("台本の schema が未知");
  if (typeof script.subject !== "string" || script.subject === "") reasons.push("台本の subject が文字列でない");
  if (!Number.isInteger(script.version)) reasons.push("台本の version が整数でない");
  if (!Array.isArray(script.entries)) { reasons.push("台本の entries が配列でない"); return reasons; }
  const ids = new Set();
  script.entries.forEach((e, i) => {
    if (!isObj(e)) { reasons.push(`entries[${i}] が写像でない`); return; }
    if (typeof e.id !== "string" || e.id === "" || ids.has(e.id)) reasons.push(`entries[${i}].id が文字列でないか重複`);
    ids.add(e.id);
    if (!(e.facet === null || CATALOG_FACET_IDS.includes(e.facet))) reasons.push(`entries[${i}].facet が未知`);
    if (!regexList(e.keys)) reasons.push(`entries[${i}].keys が正規表現の配列でないか 0 件`);
    const a = e.answer;
    const choose = isObj(a) && regexList(a.choose) && a.recommended === undefined;
    const recommended = isObj(a) && a.recommended === true && a.choose === undefined;
    if (!choose && !recommended) reasons.push(`entries[${i}].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない`);
    if (typeof e.basis !== "string" || e.basis === "") reasons.push(`entries[${i}].basis が文字列でない`);
  });
  return reasons;
}
/** 台本を読む：無ければ missing、JSON として読めなければ unreadable、形が違えば invalid と理由、通れば ok */
export function loadScript(path) {
  if (!existsSync(path)) return { status: "missing", script: null, reasons: ["台本が無い"], sha256: null };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { status: "unreadable", script: null, reasons: ["台本を読めない"], sha256: null }; }
  let script;
  try { script = JSON.parse(text); } catch { return { status: "unreadable", script: null, reasons: ["台本を JSON として読めない"], sha256: sha256(text) }; }
  const reasons = validateScript(script);
  return reasons.length > 0 ? { status: "invalid", script: null, reasons, sha256: sha256(text) } : { status: "ok", script, reasons: [], sha256: sha256(text) };
}
const ITEM_ID = /^P\d+$/;
const resolveFrom = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));
/**
 * 評価セットの定義ファイルを読む（README §5.6.1）。無ければ missing、読めなければ unreadable、欠けた欄・形の違う欄があれば invalid と理由の一覧
 * （入力の値は書かない）、通れば ok。ok のときは本の一覧（items。依頼文は requestText に組み立て済み）・本の ID → 本（byId）・題材の順（subjects）・
 * 題材ごとの台本（scripts：読み込んだ台本と SHA-256。無い題材は入れない）・定義ファイルの SHA-256 を返す。パスは定義ファイルの場所からの相対（絶対も通す）
 */
export function loadEvalSet(path) {
  if (!existsSync(path)) return { status: "missing", reasons: ["定義ファイルが無い"], set: null };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { status: "unreadable", reasons: ["定義ファイルを読めない"], set: null }; }
  let set;
  try { set = JSON.parse(text); } catch { return { status: "unreadable", reasons: ["定義ファイルを JSON として読めない"], set: null }; }
  const reasons = [];
  if (!isObj(set)) return { status: "invalid", reasons: ["定義ファイルが写像でない"], set: null };
  if (set.schema !== EVAL_SET_SCHEMA) reasons.push("schema が未知");
  if (typeof set.id !== "string" || set.id === "") reasons.push("id が文字列でない");
  if (!Number.isInteger(set.version)) reasons.push("version が整数でない");
  if (!EVAL_SET_ROLES.includes(set.role)) reasons.push("role が未知");
  if (!isObj(set.styles)) reasons.push("styles が写像でない");
  if (set.source !== undefined && (!isObj(set.source) || (set.source.document !== undefined && typeof set.source.document !== "string"))) reasons.push("source の形が違う（document は文字列）");
  if (!Array.isArray(set.items) || set.items.length === 0) { reasons.push("items が配列でないか 0 件"); return { status: "invalid", reasons, set: null }; }
  const dir = dirname(path);
  const items = [], ids = new Set(), bySubject = new Map(), scripts = new Map(), subjects = [];
  set.items.forEach((it, i) => {
    if (!isObj(it)) { reasons.push(`items[${i}] が写像でない`); return; }
    if (typeof it.id !== "string" || !ITEM_ID.test(it.id)) reasons.push(`items[${i}].id が P<n> の形でない`);
    else if (ids.has(it.id)) reasons.push("items の id が重複");
    ids.add(it.id);
    if (typeof it.subject !== "string" || it.subject === "") reasons.push(`items[${i}].subject が文字列でない`);
    if (!(isObj(set.styles) && typeof it.style === "string" && it.style in set.styles)) reasons.push(`items[${i}].style が styles に無い`);
    if (typeof it.writable !== "boolean") reasons.push(`items[${i}].writable が真偽値でない`);
    let scoringPath = null, scoringDef = null;
    if (typeof it.scoring !== "string" || it.scoring === "") reasons.push(`items[${i}].scoring が文字列でない`);
    else {
      scoringPath = resolveFrom(dir, it.scoring);
      try { scoringDef = JSON.parse(readFileSync(scoringPath, "utf8")); } catch { reasons.push(`items[${i}].scoring の定義が無いか読めない`); }
      if (scoringDef !== null && scoringDef?.id !== it.subject) reasons.push(`items[${i}].scoring の定義の id が subject と違う`);
    }
    let scriptPath = null;
    if (it.script !== null && (typeof it.script !== "string" || it.script === "")) reasons.push(`items[${i}].script が文字列でも null でもない`);
    else if (typeof it.script === "string") {
      scriptPath = resolveFrom(dir, it.script);
      const loaded = loadScript(scriptPath);
      if (loaded.status !== "ok") reasons.push(`items[${i}].script の台本が読めない: ${loaded.reasons.join("、")}`);
      else if (loaded.script.subject !== it.subject) reasons.push(`items[${i}].script の台本の subject が違う`);
      else if (typeof it.subject === "string" && !scripts.has(it.subject)) scripts.set(it.subject, { path: scriptPath, rel: it.script, sha256: loaded.sha256, script: loaded.script });
    }
    if (!Array.isArray(it.request) || it.request.length === 0 || !it.request.every((l) => typeof l === "string")) reasons.push(`items[${i}].request が文字列の配列でないか 0 行`);
    const prior = typeof it.subject === "string" ? bySubject.get(it.subject) : undefined;
    if (prior !== undefined) {
      if (prior.writable !== it.writable) reasons.push("同じ題材の items で writable が食い違う");
      if (prior.scoring !== it.scoring || prior.script !== it.script) reasons.push("同じ題材の items で scoring・script が食い違う");
    } else if (typeof it.subject === "string") { bySubject.set(it.subject, it); subjects.push(it.subject); }
    items.push({ id: it.id, subject: it.subject, style: it.style, writable: it.writable, scoring: it.scoring, scoringPath, script: it.script, scriptPath, requestText: Array.isArray(it.request) ? it.request.join("\n") : "" });
  });
  if (reasons.length > 0) return { status: "invalid", reasons: [...new Set(reasons)], set: null };
  return { status: "ok", reasons: [], set, path, dir, sha256: sha256(text), items, byId: new Map(items.map((it) => [it.id, it])), subjects, scripts };
}
/** 台本のまとめた指紋（題材と中身の SHA-256 だけ。パスに依らない）と一覧 */
export function scriptsFingerprint(scripts) {
  const h = createHash("sha256");
  const files = [];
  for (const subject of [...scripts.keys()].sort()) { const sc = scripts.get(subject); h.update(subject); h.update("\0"); h.update(sc.sha256); h.update("\n"); files.push({ subject, sha256: sc.sha256 }); }
  return { fingerprint: files.length === 0 ? null : h.digest("hex"), files };
}
/** 問いが持つ目録の観点（open_issue_id と also_closes の中の OI:catalog:<要件 ID>:<観点 ID>）と、指す要件 ID */
export function questionFacets(question) {
  const facets = [], requirementIds = [];
  for (const id of [question.open_issue_id, ...(Array.isArray(question.also_closes) ? question.also_closes : [])]) {
    const m = typeof id === "string" ? id.match(CATALOG_ISSUE_ID) : null;
    if (m === null) continue;
    if (!facets.includes(m[2])) facets.push(m[2]);
    if (!requirementIds.includes(m[1])) requirementIds.push(m[1]);
  }
  return { facets, requirementIds };
}
/** 確定した仕様（plan.json。無ければ null）から、事項 ID → 文・要件 ID → 文を引く */
export function planTexts(plan) {
  const issues = new Map(), requirements = new Map();
  for (const oi of Array.isArray(plan?.open_issues) ? plan.open_issues : []) if (typeof oi?.id === "string" && typeof oi.text === "string") issues.set(oi.id, oi.text);
  for (const r of Array.isArray(plan?.requirements) ? plan.requirements : []) if (typeof r?.id === "string" && typeof r.text === "string") requirements.set(r.id, r.text);
  return { issues, requirements };
}
/**
 * 問い 1 つに台本を当てる（README §5.6.2）。鍵は問いの文・選択肢の文・閉じる事項の文・目録の事項が指す要件の文（確定した仕様から）を連結した文に当てる。
 * 全部の鍵が当たり観点が食い違わない件が 1 つのとき、choose が全部当たる選択肢がちょうど 1 つならその選択肢（recommended: true なら推奨）。
 * 0 件なら unknown（不明）、2 件以上・選択肢が決まらないなら unresolved（決められない）。actual は工場が実際に採った選択肢 ID（無ければ null）
 */
export function applyScript(script, question, actual, texts = planTexts(null)) {
  const { facets, requirementIds } = questionFacets(question);
  const ids = [question.open_issue_id, ...(Array.isArray(question.also_closes) ? question.also_closes : [])];
  const choices = Array.isArray(question.choices) ? question.choices.filter((c) => isObj(c) && typeof c.id === "string") : [];
  const hay = [question.text, ...choices.map((c) => c.text), ...ids.map((id) => texts.issues.get(id)), ...requirementIds.map((id) => texts.requirements.get(id))].filter((t) => typeof t === "string").join("\n");
  const base = { question_id: question.id ?? null, open_issue_id: question.open_issue_id ?? null, facets, actual_choice_id: actual };
  const entries = Array.isArray(script?.entries) ? script.entries : [];
  const hit = entries.filter((e) => e.keys.every((k) => new RegExp(k).test(hay)) && (e.facet === null || facets.length === 0 || facets.includes(e.facet)));
  if (hit.length === 0) return { ...base, status: "unknown", reason: null, entry_id: null, choice_id: null, agrees: null };
  if (hit.length > 1) return { ...base, status: "unresolved", reason: "entries", entry_id: hit.map((e) => e.id), choice_id: null, agrees: null };
  const [entry] = hit;
  let choiceId = null;
  if (entry.answer.recommended === true) choiceId = typeof question.recommended?.choice_id === "string" ? question.recommended.choice_id : null;
  else {
    const matched = choices.filter((c) => typeof c.text === "string" && entry.answer.choose.every((k) => new RegExp(k).test(c.text)));
    if (matched.length !== 1) return { ...base, status: "unresolved", reason: matched.length === 0 ? "no-choice" : "many-choices", entry_id: entry.id, choice_id: null, agrees: null };
    choiceId = matched[0].id;
  }
  if (choiceId === null) return { ...base, status: "unresolved", reason: "no-choice", entry_id: entry.id, choice_id: null, agrees: null };
  return { ...base, status: "scripted", reason: null, entry_id: entry.id, choice_id: choiceId, agrees: actual === null ? null : choiceId === actual };
}
/**
 * 本 1 つの台本の照合（README §5.6.4 の rows[].script）。往復の記録（plan-record.json）の全部の問いに当てる。工場の答えは記録の answers
 * （全部推奨で閉じた往復は推奨）から取る。記録の無い本は対象外（none）。台本の無い題材は全部の問いが不明
 */
export function scriptSummary(scriptEntry, pr, plan) {
  const file = scriptEntry?.rel ?? null;
  const empty = { file, questions: 0, scripted: 0, agreed: 0, disagreed: 0, unknown: 0, unresolved: 0, details: [] };
  if (pr === null) return { ...empty, status: "none" };
  const texts = planTexts(plan);
  const details = [];
  for (const round of Array.isArray(pr.rounds) ? pr.rounds : []) {
    const answers = Array.isArray(round?.answers) ? round.answers : [];
    for (const q of Array.isArray(round?.questions) ? round.questions : []) {
      if (!isObj(q)) continue;
      const a = answers.find((x) => isObj(x) && x.question_id === q.id);
      const actual = round.all_recommended === true ? (typeof q.recommended?.choice_id === "string" ? q.recommended.choice_id : null) : typeof a?.choice_id === "string" ? a.choice_id : null;
      details.push(applyScript(scriptEntry?.script ?? null, q, actual, texts));
    }
  }
  const count = (f) => details.filter(f).length;
  const summary = { ...empty, questions: details.length, scripted: count((d) => d.status === "scripted"), agreed: count((d) => d.agrees === true), disagreed: count((d) => d.agrees === false), unknown: count((d) => d.status === "unknown"), unresolved: count((d) => d.status === "unresolved"), details };
  const status = details.length === 0 ? "no-questions" : summary.disagreed > 0 ? "disagreed" : details.every((d) => d.agrees === true) ? "ok" : "unanswered";
  return { ...summary, status };
}

// ── 了承後の採点（#426。README §5.5）
/** 確定した仕様の契約の版（appspec-schema の PLAN_SPEC_SCHEMA_VERSION と同じ値。契約の版を上げたら、ここも上げる） */
export const PLAN_SPEC_SCHEMA = "musunest.plan-spec/v1";
/** 了承の記録の読みの状態（confirmed ＝ 読めて契約の検査を通った、invalid ＝ あるが読めない・形が違う・検査に落ちる、absent ＝ 無い、none ＝ Plan を通していない本＝対象外） */
export const ACCEPTANCE_STATUSES = ["confirmed", "invalid", "absent", "none"];
/** 記録の無い本（absent）の理由：Plan が確定しなかった／Plan は確定したが納品物に仕様が無い（Build の段階は断定しない）／Plan の結果も不明 */
export const ABSENT_REASONS = ["plan_not_confirmed", "confirmed_without_plan", "unknown"];
/** 往復の記録の outcome の既知の値（工場の PlanResult の kind） */
const PLAN_OUTCOMES = ["confirmed", "stopped", "cannot-confirm"];
/** 処分 1 つの判定（README §5.5.2）。判定不能 ＝ unmatched（何にも当たらない）・ambiguous（部分が 2 つ以上に当たる）。未評価 ＝ unevaluated（書ける要件の変更。変更後を判定する手段が無い） */
export const JUDGEMENTS = ["expected", "allowed", "wrong", "unevaluated", "unmatched", "ambiguous"];
const UNDECIDED = ["unmatched", "ambiguous"];
/** 了承後の最終の判定のうち、この道具が足した値（変更後を判定する手段が無い本。PASS にしない） */
export const VERDICT_UNEVALUATED = "UNEVALUATED";
/**
 * 誤った了承の指標の状態。変更後・代替・追加の要件を判定する対応データ（別の Issue）が無い間は未評価で、証拠（他の構造の書けない要件に当たった変更）と
 * 判定不能・未評価の件数を添える。0 件に丸めない。対応データが入ったら、ここを evaluated に変える
 */
export const WRONG_ACCEPTANCE_EVALUATION = { status: "unevaluated", label: "未評価：変更後の要件を判定する対応データが無い。evidence ＝ 他の構造の書けない要件に当たった変更、unmatched・ambiguous ＝ 照合できない・複数候補、unevaluated ＝ 書ける要件に当たった変更" };
const EVALUATION_STATUSES = ["unevaluated", "evaluated"];
/**
 * 了承後の有効な要件のうち、判定の手段が無いもの（未検証）の出どころ（README §5.5.3）：
 * accepted_unwritable ＝ 了承して除いた記録の代替先（accepted_unwritable[].alternative_id が指す要件）、part ＝ 部分の代替先（parts[].alternative_id が指す要件）、
 * changed ＝ 変更後の要件（changed の要件そのもの）、added ＝ 追加の要件（added の要件そのもの）。今の工場は accepted_unwritable と added を作る
 */
export const UNVERIFIED_SOURCES = ["accepted_unwritable", "part", "changed", "added"];
/** plan.json の形（この道具が読む欄だけ）を検証する。落ちた理由の一覧（空なら読める）。理由に入力の値は含めない */
export function validatePlanShape(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return ["plan.json が写像でない"];
  const reasons = [];
  if (plan.schema_version !== PLAN_SPEC_SCHEMA) reasons.push("schema_version が未知");
  for (const k of ["requirements", "accepted_unwritable", "decisions"]) if (!Array.isArray(plan[k])) reasons.push(`${k} が配列でない`);
  if (Array.isArray(plan.requirements) && !plan.requirements.every((r) => r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.text === "string" && Array.isArray(r.parts))) reasons.push("requirements の形が違う（id・text・parts）");
  return reasons;
}
/**
 * 了承の記録（bundle/artifacts/plan.json）を読む：無ければ absent、読めない・形が違えば invalid と理由、
 * 契約の検査（check ＝ appspec-schema の checkConfirmedPlan。形・参照・了承の範囲・未解決・確認の失効）に落ちれば invalid と理由（検査のコードと欄の場所。値は書かない）、
 * 通れば confirmed
 */
export async function loadPlan(dir, check = null) {
  const path = join(dir, "bundle/artifacts/plan.json");
  if (!existsSync(path)) return { status: "absent", plan: null, reasons: [] };
  let plan;
  try { plan = readJson(path); } catch { return { status: "invalid", plan: null, reasons: ["plan.json を読めない"] }; }
  const reasons = validatePlanShape(plan);
  if (reasons.length > 0) return { status: "invalid", plan: null, reasons };
  const problems = check === null ? [] : await check(plan);
  if (problems.length > 0) return { status: "invalid", plan: null, reasons: [...new Set(problems.map((p) => `契約の検査: ${p.code} (${p.path})`))] };
  return { status: "confirmed", plan, reasons: [] };
}
const compileKeys = (keys) => (Array.isArray(keys) ? keys : []).map((k) => new RegExp(k));
const hits = (res, text) => res.some((re) => re.test(text));
/**
 * 原文の要件との対応（README §5.5.2）。score-claims.mjs と同じ照合（定義の keys を正規表現として読み、文に当てる）。
 * 当たる先は：当てはまった構造（無ければ主の構造）の書けない要件（unwritable）／許される申告（allowed）／
 * 書ける要件（check。checks[].keys。v5 の定義には無い）／他の構造の書けない要件（other_unwritable。当てはまった構造では書ける、の目印）。
 * match は当たった先を**全部**返す（先頭の 1 件で決めない）
 */
export function acceptanceMatcher(def, structureId, allowedClaims = []) {
  const st = def.structures.find((x) => x.id === structureId) ?? def.structures[0];
  const table = (kind, list) => list.map((u) => ({ kind, id: u.id, res: compileKeys(u.keys) }));
  const candidates = [
    ...table("unwritable", st.unwritable ?? []),
    ...table("allowed", [...allowedClaims, ...(def.allowedClaims ?? [])]),
    ...table("check", (st.checks ?? []).filter((c) => Array.isArray(c.keys) && c.keys.length > 0).map((c) => ({ id: c.req, keys: c.keys }))),
    ...table("other_unwritable", def.structures.filter((x) => x.id !== st.id).flatMap((x) => (x.unwritable ?? []).map((u) => ({ id: `${x.id}:${u.id}`, keys: u.keys })))),
  ];
  const match = (text) => {
    const seen = new Set(), out = [];
    for (const c of candidates) {
      if (!hits(c.res, text) || seen.has(`${c.kind}\0${c.id}`)) continue;
      seen.add(`${c.kind}\0${c.id}`);
      out.push({ kind: c.kind, id: c.id });
    }
    return out;
  };
  return { structure: st.id, match };
}
/**
 * 処分 1 つの判定（README §5.5.2 の表）。targets ＝ 当たった先の全部、scope ＝ part（部分の文だけ）か requirement（要件全体。含まれる対象を全部点検する）、
 * op ＝ exclusion（除外）か change（変更）。何にも当たらなければ unmatched、部分が 2 つ以上に当たれば ambiguous（どちらも判定不能。免除にも誤りにも使わない）。
 * 他の構造の書けない要件 ＝ wrong。書ける要件 ＝ 除外なら wrong、変更なら unevaluated（変更後を判定する手段が無い）。書けない要件 ＝ expected。許される申告だけ ＝ allowed
 */
export function judgeDisposition(targets, scope, op) {
  if (targets.length === 0) return "unmatched";
  if (scope === "part" && targets.length > 1) return "ambiguous";
  const kinds = new Set(targets.map((t) => t.kind));
  if (kinds.has("other_unwritable")) return "wrong";
  if (kinds.has("check")) return op === "exclusion" ? "wrong" : "unevaluated";
  if (kinds.has("unwritable")) return "expected";
  return "allowed";
}
/**
 * 確定した仕様の了承の記録を、定義の鍵で読む（README §5.5.2〜§5.5.3）。
 * 除外 ＝ accepted_removal の部分・removed の要件（作らない、と了承した）。変更 ＝ alternative の部分・changed の要件（別の形で作る、と了承した）。added の要件は数えるだけ。
 * 照合する文は、部分ならその部分の文だけ（親の全文・変更後・代わりの案の文は使わない）。要件全体なら元の要件（from_requirement_id）の文（changed の元が自分自身なら元の文が無い）。
 * 判定不能・未評価は件数と状態で出し、誤った除外も未評価の判定も了承後の分母から外さない。
 * 処分の照合とは別に、了承後の有効な要件の評価の状態（effective）を持つ：照合が expected なのは「処分の対象が書けない要件に当たった」という判断で、
 * 代替先・変更後・追加の要件を Build が満たしたことの判定ではない。判定の手段が無いそれらの要件は未検証（effective.unverified）として数える
 */
export function readAcceptance(plan, matcher) {
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const changes = { added: 0, changed: 0, removed: 0 };
  const exclusions = [], changed = [];
  const entry = (id, kind, scope, text, op) => { const targets = matcher.match(text); return { id, kind, scope, matched: targets, judged: judgeDisposition(targets, scope, op) }; };
  const partIds = new Set();
  // 未検証の有効な要件（要件 ID ごとに 1 件。出どころは全部残す）。指す先が requirements に無くても数える（契約の検査が落とすので確定した本には現れない）
  const unverified = new Map();
  const note = (id, via) => { if (typeof id !== "string") return; const u = unverified.get(id) ?? { id, via: [] }; if (!u.via.includes(via)) u.via.push(via); unverified.set(id, u); };
  for (const r of plan.requirements) {
    const kind = r.change?.kind;
    if (typeof kind === "string" && kind in changes) changes[kind] += 1;
    const from = r.change?.from_requirement_id;
    const original = typeof from !== "string" ? "" : kind === "changed" && from === r.id ? "" : byId.get(from)?.text ?? "";
    if (kind === "removed") exclusions.push(entry(r.id, "removed", "requirement", original, "exclusion"));
    else if (kind === "changed") { changed.push(entry(r.id, "changed", "requirement", original, "change")); note(r.id, "changed"); }
    else if (kind === "added") note(r.id, "added");
    for (const part of r.parts) {
      if (part === null || typeof part !== "object") continue;
      partIds.add(part.id);
      if (part.disposition === "met") continue;
      note(part.alternative_id, "part");
      const text = typeof part.text === "string" ? part.text : "";
      if (part.disposition === "alternative") changed.push(entry(part.id, "alternative", "part", text, "change"));
      else exclusions.push(entry(part.id, typeof part.disposition === "string" ? part.disposition : "unknown", "part", text, "exclusion"));
    }
  }
  // 部分の無い accepted_unwritable の記録（契約の検査が落とすので確定した本には現れない）は、照合できない除外として誤った除外に数える
  for (const a of plan.accepted_unwritable) {
    if (!partIds.has(a?.part_id)) exclusions.push({ id: typeof a?.part_id === "string" ? a.part_id : null, kind: "accepted_unwritable", scope: "record", matched: [], judged: "wrong" });
    note(a?.alternative_id, "accepted_unwritable");
  }
  const all = [...exclusions, ...changed];
  const countBy = (xs) => Object.fromEntries(JUDGEMENTS.map((j) => [j, xs.filter((x) => x.judged === j).length]));
  const targetsOf = (xs, kind) => [...new Set(xs.flatMap((x) => x.matched.filter((t) => t.kind === kind).map((t) => t.id)))];
  const unverifiedList = [...unverified.values()];
  return {
    changes, decisions: plan.decisions.length, exclusions, changed,
    counts: { exclusions: countBy(exclusions), changes: countBy(changed) },
    accepted_unwritable_ids: targetsOf(all.filter((x) => x.judged === "expected"), "unwritable"),
    // 変更が当てた書ける要件の判定（判定のいかんにかかわらず、変更後は判定できない）
    unevaluated_checks: targetsOf(changed, "check"),
    allowed: all.filter((x) => x.judged === "allowed").length,
    // 了承後の有効な要件の評価の状態（README §5.5.3）：未検証の要件が 1 つでもあれば unevaluated（その本は PASS にしない）。counts は出どころごとの要件の数（total は要件 ID で数える）
    effective: {
      status: unverifiedList.length === 0 ? "evaluated" : "unevaluated",
      unverified: unverifiedList,
      counts: { total: unverifiedList.length, ...Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, unverifiedList.filter((u) => u.via.includes(s)).length])) },
    },
  };
}
/** 変更のうち、了承後の判定を PASS にできないもの（expected・allowed 以外）の数 */
export const unjudgedChanges = (a) => JUDGEMENTS.filter((j) => j !== "expected" && j !== "allowed").reduce((n, j) => n + a.counts.changes[j], 0);
/** 変更のうち判定不能（unmatched・ambiguous）の数 */
export const undecidedChanges = (a) => UNDECIDED.reduce((n, j) => n + a.counts.changes[j], 0);
/** 除外のうち判定不能（unmatched・ambiguous）の数 */
export const undecidedExclusions = (a) => UNDECIDED.reduce((n, j) => n + a.counts.exclusions[j], 0);
/**
 * 了承後の申告の採点：score-claims.mjs と同じ照合で、期待の書けない要件ごとに「申告あり（correct）／任意（optional）／了承済みで申告なし（accepted）／挙げ漏れ（missed）」に分ける。
 * 誤った申告は原文系の claims.false_claims と同じ（数だけ受け取り、verdict に使う）
 */
export function claimsAfterAcceptance(def, structureId, claimsList, written, acceptedIds, falseClaims = 0) {
  const st = def.structures.find((x) => x.id === structureId) ?? def.structures[0];
  const claims = claimsList.map((u) => `${u.requirement} ${u.reason}`);
  const result = { structure: st.id, expected: st.unwritable.map((u) => u.id), correct: 0, accepted: 0, optional: 0, missed: 0 };
  for (const u of st.unwritable) {
    const res = compileKeys(u.keys);
    const claimed = claims.some((c) => hits(res, c));
    if (u.optionalIfWritten && written?.[u.optionalIfWritten]) result.optional += claimed ? 1 : 0;
    else if (claimed) result.correct += 1;
    else if (acceptedIds.includes(u.id)) result.accepted += 1;
    else result.missed += 1;
  }
  result.verdict = result.missed === 0 && falseClaims === 0 ? "OK" : "NG";
  return result;
}
/**
 * 了承後の充足：分母・分子は原文の判定のまま（v2 と同じ。了承で変わった判定も誤った除外も外さない。落ちた判定を変更扱いにしても率は上がらない）。
 * 変更が当てた判定（unevaluated）は名前を添えるだけ。構造が当てはまらない本は呼ばない（充足 0・定義の判定の数）
 */
export function fulfillmentAfterAcceptance(r, unevaluatedChecks) {
  return { fulfilled: r.fulfilled ?? 0, total: r.writable_total ?? 0, total_from: `structure:${r.structure}`, unevaluated: unevaluatedChecks.filter((k) => k in r.checks) };
}
/**
 * 了承後の最終の判定（README §5.5.4）：静的 NG はそのまま。変更に expected・allowed 以外があるか、未検証の有効な要件（代替先・変更後・追加）が 1 つでもあれば
 * 原則 UNEVALUATED（PASS にしない。照合が expected・allowed でも同じ）。ただし変更が当てた判定が分かっていて（wrong・判定不能の変更が無い）、
 * 未評価の判定の外に落ちがあるか挙げ漏れがあれば FAIL（落ちは隠さない）。残りは finalVerdict を了承後の申告で取る
 */
export function verdictAfterAcceptance(r, acceptance, claimsAccepted, finalVerdict) {
  if (r.verdict === "STATIC_NG") return r.verdict;
  if (unjudgedChanges(acceptance) === 0 && acceptance.effective.counts.total === 0) return finalVerdict(r, claimsAccepted);
  const known = acceptance.counts.changes.wrong + undecidedChanges(acceptance) === 0;
  const failedOutside = Object.entries(r.checks).some(([k, ok]) => !ok && !acceptance.unevaluated_checks.includes(k));
  return known && (failedOutside || (claimsAccepted !== null && claimsAccepted.missed > 0)) ? "FAIL" : VERDICT_UNEVALUATED;
}

// ── 採点と集計
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n}（${n ? pct(k / n) : "-"}・95% 区間 ${pct(lo)}〜${pct(hi)}）`; };
const sum = (xs, f) => xs.reduce((s, r) => s + f(r), 0);
const pass = (r) => !r.generation_failed && r.verdict === "PASS";
const relReal = (from, to) => { try { return relative(realpathSync(from), realpathSync(to)); } catch { return relative(from, to); } };

/**
 * 採点する。opts.setPath（--set）があればその定義ファイル、無ければ条件のファイルの set.path（<repo> からの相対。絶対も通す）、それも無ければ既定の組。
 * 定義ファイルを読めなければ採点しない（例外）。出力先に定義ファイルに無い ID の本があれば採点せず飛ばす（標準エラー。照合では予定外に数える）
 */
export async function scoreOutput(repo, outRoot, opts = {}) {
  const ev = join(repo, "workspace/mvp/m1/agent/eval");
  const { loadDef, score } = await import(pathToFileURL(join(ev, "engine.mjs")).href);
  const { finalVerdict, scoreClaims, DEFAULT_ALLOWED } = await import(pathToFileURL(join(ev, "score-claims.mjs")).href);
  const specEngineDist = join(repo, "packages/spec-engine/dist");
  const engine = await import(pathToFileURL(join(specEngineDist, "index.js")).href);
  // 確定した仕様の契約の検査（#426）。工場が Plan を確定するときに呼ぶものと同じ関数を、契約の持ち主の dist から読む（工場の公開の面は再公開していない）
  const appspecDist = join(repo, "packages/appspec-schema/dist");
  const { checkConfirmedPlan } = await import(pathToFileURL(join(appspecDist, "index.js")).href);
  const cond = readConditions(outRoot);
  // 評価セットの定義ファイル（#427）：--set ＞ 条件のファイルの set.path ＞ 既定の組
  const setPath = opts.setPath !== undefined ? resolve(opts.setPath) : typeof cond?.set?.path === "string" ? resolveFrom(repo, cond.set.path) : join(repo, DEFAULT_SET_PATH);
  const loadedSet = loadEvalSet(setPath);
  if (loadedSet.status !== "ok") throw new Error(`定義ファイルを読めません（${relReal(repo, setPath)}）: ${loadedSet.reasons.join("、")}`);
  const evalSet = loadedSet;
  // 了承後系の対象（#426）：計測が Plan を通した（条件のファイルの params.plan）なら全本。そうでなければ Plan の記録（plan-record.json か plan.json）のある本だけ
  const planScope = cond?.params?.plan === true;
  const rows = [];
  for (const d of runDirs(outRoot)) {
    const p = d.split("-")[0], item = evalSet.byId.get(p), dir = join(outRoot, d);
    if (item === undefined) { console.error(`飛ばしました: ${d} は定義ファイル（${evalSet.set.id}）に無い ID の本です`); continue; }
    const subject = item.subject;
    const sl = existsSync(join(dir, "summary.line.json")) ? readJson(join(dir, "summary.line.json")) : null;
    const s = sl?.summary ?? null;
    const spec = join(dir, "bundle/artifacts/app.spec.yaml");
    // --plan の本（#378）：費用は Plan と Build の合計。Plan の結果と質問の数も残す
    const planRecordPath = join(dir, "bundle/plan-record.json");
    const pr = existsSync(planRecordPath) ? readJson(planRecordPath) : null;
    const plan = pr === null ? null : { outcome: pr.outcome ?? null, questions: (pr.rounds ?? []).reduce((n, round) => n + (round.questions ?? []).length, 0), rounds: (pr.rounds ?? []).length, usd: sl?.plan_cost?.plan_usd ?? pr.spent_usd ?? 0 };
    const base = { run: d, pattern: p, subject, style: item.style, writable: item.writable, factory_verdict: s?.verdict ?? null, stop: s?.stop_reason ?? s?.stop_class ?? null, failure: s?.failure ?? null, cost_usd: sl?.plan_cost?.total_usd ?? s?.provider_cost_usd ?? 0, seconds: sl?.wall_s ?? s?.duration_secs ?? 0, plan };
    const def = loadDef(item.scoringPath);
    // 補正後（v2）の分母の既定：主の構造（0 番目）の判定の数。役割が見つからないときに engine.mjs が writable_total に使う値と同じ
    const main = def.structures[0], fromDefinition = { total: main.checks.length, total_from: `definition:${main.id}` };
    // 了承の記録（#426）：plan.json を読んで契約の検査を通し、当てはまった構造（無ければ主の構造）の定義の鍵で除外・変更を照合する。記録の無い本は absent と理由（Plan を通していない計測なら none ＝ 対象外）
    const loaded = await loadPlan(dir, checkConfirmedPlan);
    const status = loaded.status === "absent" && pr === null && !planScope ? "none" : loaded.status;
    const outcome = typeof pr?.outcome === "string" && PLAN_OUTCOMES.includes(pr.outcome) ? pr.outcome : null;
    const absentReason = pr === null || outcome === null ? "unknown" : outcome === "confirmed" ? "confirmed_without_plan" : "plan_not_confirmed";
    const acceptanceOf = (structureId) => {
      if (status === "none") return { status };
      const head = { status, reasons: loaded.reasons, plan_outcome: pr?.outcome ?? null };
      if (status === "absent") return { ...head, absent_reason: absentReason };
      if (status !== "confirmed") return head;
      const matcher = acceptanceMatcher(def, structureId, DEFAULT_ALLOWED);
      return { ...head, plan_id: loaded.plan.plan_id ?? null, revision: loaded.plan.revision ?? null, structure: matcher.structure, ...readAcceptance(loaded.plan, matcher) };
    };
    // 了承後の充足の既定：記録の無い本・読めない本・構造が当てはまらない本は充足 0 で、主の構造の判定の数が分母（v2 と同じ決まり）
    const zeroAccepted = status === "none" ? null : { fulfilled: 0, ...fromDefinition, unevaluated: [] };
    // 台本の照合（#427）：往復の記録の全部の問いに、題材の台本を事後に当てる（記録の無い本は none）
    const script = scriptSummary(evalSet.scripts.get(subject) ?? null, pr, loaded.plan);
    if (!existsSync(spec)) { rows.push({ ...base, generation_failed: true, fulfillment_v2: { fulfilled: 0, ...fromDefinition }, acceptance: acceptanceOf(null), claims_accepted: null, fulfillment_accepted: zeroAccepted, verdict_accepted: null, script }); continue; }
    const r = await score(engine, spec, def);
    const uw = existsSync(join(dir, "bundle/artifacts/unwritable.json")) ? readJson(join(dir, "bundle/artifacts/unwritable.json")).unwritable ?? [] : [];
    const claimsList = uw.flatMap((u) => (u.unwritable ?? []).map((part) => ({ requirement: `${u.text}（${u.quote}）`, reason: part })));
    const claims = scoreClaims({ attempts: [{ unwritable: claimsList }] }, def, r.structure, r.written);
    // 構造が当てはまった本は、その構造の判定の数が分母。静的 NG・役割が見つからない本は充足 0 で、主の構造の判定の数が分母
    const fulfillment_v2 = r.structure ? { fulfilled: r.fulfilled ?? 0, total: r.writable_total, total_from: `structure:${r.structure}` } : { fulfilled: 0, ...fromDefinition };
    // 了承後系：確定した本だけ読み替える（了承済みの書けない要件は挙げ漏れにしない。変更が当てた判定は未評価の印を付け、分母からは外さない）。それ以外は充足 0・判定 null
    const acceptance = acceptanceOf(r.structure);
    const claims_accepted = status === "confirmed" ? claimsAfterAcceptance(def, r.structure, claimsList, r.written, acceptance.accepted_unwritable_ids, claims.false_claims.length) : null;
    const fulfillment_accepted = status === "confirmed" && r.structure ? fulfillmentAfterAcceptance(r, acceptance.unevaluated_checks) : zeroAccepted;
    const verdict_accepted = status === "confirmed" ? verdictAfterAcceptance(r, acceptance, claims_accepted, finalVerdict) : null;
    rows.push({ ...base, spec_verdict: r.verdict, verdict: finalVerdict(r, claims), failed: Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k), fulfilled: r.fulfilled ?? 0, writable_total: r.writable_total ?? 0, claims, final_static: r.verdict === "STATIC_NG" ? 1 : 0, fulfillment_v2, acceptance, claims_accepted, fulfillment_accepted, verdict_accepted, script });
  }
  // 書ける題材（writable）と一部書けない題材（partial）の分け方は定義ファイルの writable（#427。今の組では A・C・E と B・D）
  const W = rows.filter((r) => r.writable), P = rows.filter((r) => !r.writable);
  const withUnwritable = P.filter((r) => r.generation_failed || r.claims.missed + r.claims.correct > 0);
  // 既存の指標（v1 の数え方のまま）
  const metrics = {
    generated: fmt(rows.filter((r) => !r.generation_failed).length, rows.length),
    final_static: fmt(rows.filter((r) => !r.generation_failed && r.final_static === 0).length, rows.length),
    spec_pass_writable: fmt(W.filter(pass).length, W.length),
    missed_partial: fmt(withUnwritable.filter((r) => r.generation_failed || r.claims.missed > 0).length, withUnwritable.length),
    fulfillment_partial: fmt(P.reduce((s, r) => s + (r.fulfilled ?? 0), 0), P.reduce((s, r) => s + (r.writable_total || 0), 0)),
    spec_pass_partial: fmt(P.filter(pass).length, P.length),
    false_claim_runs: fmt(rows.filter((r) => r.generation_failed || r.claims.false_claims.length > 0).length, rows.length),
    within_time_cost: `${rows.filter((r) => !r.generation_failed && r.seconds <= 600 && r.cost_usd <= 0.3).length}/${rows.length}`,
    cost_total_usd: rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(4),
    factory_verdicts: rows.reduce((m, r) => ((m[r.factory_verdict ?? "none"] = (m[r.factory_verdict ?? "none"] ?? 0) + 1), m), {}),
  };
  // 充足率を集計の版ごとに並べる（partial ＝ 一部書けない題材 B・D、writable ＝ 書ける題材 A・C・E、all ＝ 全部）。v1.partial は metrics.fulfillment_partial と同じ値
  const v1 = (xs) => fmt(sum(xs, (r) => r.fulfilled ?? 0), sum(xs, (r) => r.writable_total || 0));
  const v2 = (xs) => fmt(sum(xs, (r) => r.fulfillment_v2.fulfilled), sum(xs, (r) => r.fulfillment_v2.total));
  // 了承後系（#426）：対象の本（fulfillment_accepted が null でない本）だけで数える。記録の無い本・読めない本は充足 0・判定 null で分母に残る
  const inScope = rows.filter((r) => r.fulfillment_accepted !== null);
  const confirmed = inScope.filter((r) => r.acceptance.status === "confirmed");
  const WA = inScope.filter((r) => r.writable), PA = inScope.filter((r) => !r.writable);
  const passAccepted = (r) => r.verdict_accepted === "PASS";
  const withUnwritableA = PA.filter((r) => r.claims_accepted === null || r.claims_accepted.missed + r.claims_accepted.correct + r.claims_accepted.accepted > 0);
  const countOf = (st) => inScope.filter((r) => r.acceptance.status === st).length;
  const sumA = (f) => sum(confirmed, (r) => f(r.acceptance));
  const runsA = (f) => fmt(confirmed.filter((r) => f(r.acceptance)).length, confirmed.length);
  const fa = (xs) => fmt(sum(xs, (r) => r.fulfillment_accepted.fulfilled), sum(xs, (r) => r.fulfillment_accepted.total));
  const unevaluatedRuns = confirmed.filter((r) => r.verdict_accepted === VERDICT_UNEVALUATED);
  const metrics_accepted = {
    runs: inScope.length, confirmed: confirmed.length, absent: countOf("absent"),
    absent_reasons: Object.fromEntries(ABSENT_REASONS.map((k) => [k, inScope.filter((r) => r.acceptance.status === "absent" && r.acceptance.absent_reason === k).length])), invalid: countOf("invalid"),
    spec_pass_writable: fmt(WA.filter(passAccepted).length, WA.length),
    missed_partial: fmt(withUnwritableA.filter((r) => r.claims_accepted === null || r.claims_accepted.missed > 0).length, withUnwritableA.length),
    spec_pass_partial: fmt(PA.filter(passAccepted).length, PA.length),
    // 未評価の本（変更後を判定する手段が無い）と、変更が当てた判定の数。分母からは外していない
    unevaluated_runs: fmt(unevaluatedRuns.length, confirmed.length), unevaluated_checks: sum(confirmed, (r) => r.fulfillment_accepted.unevaluated.length),
    // 未検証の有効な要件（代替先・変更後・追加。判定の手段が無い）の数と出どころの内訳、それを持つ本の数（分母は確定した本）。照合が expected・allowed でも、この本は PASS にしない
    unverified_requirements: sumA((a) => a.effective.counts.total), unverified_sources: Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, sumA((a) => a.effective.counts[s])])), unverified_runs: runsA((a) => a.effective.counts.total > 0),
    wrong_exclusion_runs: runsA((a) => a.counts.exclusions.wrong > 0), undecided_exclusion_runs: runsA((a) => undecidedExclusions(a) > 0),
    wrong_exclusions: sumA((a) => a.counts.exclusions.wrong), undecided_exclusions: sumA(undecidedExclusions),
    // 誤った了承は未評価（対応データが無い）。証拠と判定不能・未評価の件数を添え、0 件に丸めない
    wrong_acceptances: { ...WRONG_ACCEPTANCE_EVALUATION, evidence: sumA((a) => a.counts.changes.wrong), unmatched: sumA((a) => a.counts.changes.unmatched), ambiguous: sumA((a) => a.counts.changes.ambiguous), unevaluated: sumA((a) => a.counts.changes.unevaluated) },
    wrong_acceptance_runs: { status: WRONG_ACCEPTANCE_EVALUATION.status, evidence: runsA((a) => a.counts.changes.wrong > 0), undecided: runsA((a) => unjudgedChanges(a) - a.counts.changes.wrong > 0) },
    changes: { added: sumA((a) => a.changes.added), changed: sumA((a) => a.changes.changed), removed: sumA((a) => a.changes.removed) }, decisions: sumA((a) => a.decisions),
  };
  const fulfillment = {
    v1: { label: AGGREGATION_VERSIONS.v1, partial: v1(P), writable: v1(W), all: v1(rows) },
    v2: { label: AGGREGATION_VERSIONS.v2, partial: v2(P), writable: v2(W), all: v2(rows) },
    // 了承後系の分母・分子は v2 と同じ。未評価（変更が当てた判定の数と、その本の数）を添える
    accepted: { label: SCORING_SYSTEMS.accepted, partial: fa(PA), writable: fa(WA), all: fa(inScope), unevaluated: { checks: metrics_accepted.unevaluated_checks, runs: unevaluatedRuns.length } },
  };
  // 台本の照合の集計（#427）：対象は往復の記録のある本。runs_ok ＝ 問いが無いか、全部の問いが台本で答えられ工場の答えと同じ本
  const scripted = rows.filter((r) => r.script.status !== "none");
  const sumS = (k) => sum(scripted, (r) => r.script[k]);
  const runsS = (f) => fmt(scripted.filter((r) => f(r.script.status)).length, scripted.length);
  const metrics_script = {
    mode: SCRIPT_MODE, label: "台本は採点で事後に当てる（工場は全部推奨で進んだ）。不明・決められない・台本と違う答えで進んだ本の判定と合格率は変えず、ここで数える",
    runs: scripted.length, questions: sumS("questions"), scripted: sumS("scripted"), agreed: sumS("agreed"), disagreed: sumS("disagreed"), unknown: sumS("unknown"), unresolved: sumS("unresolved"),
    runs_ok: runsS((st) => st === "ok" || st === "no-questions"), runs_disagreed: runsS((st) => st === "disagreed"), runs_unanswered: runsS((st) => st === "unanswered"),
  };
  const bySubject = Object.fromEntries(evalSet.subjects.map((s) => { const xs = rows.filter((r) => r.subject === s), xa = xs.filter((r) => r.fulfillment_accepted !== null); return [s, { pass: fmt(xs.filter(pass).length, xs.length), S1: `${xs.filter((r) => r.style === "S1" && pass(r)).length}/${xs.filter((r) => r.style === "S1").length}`, S2: `${xs.filter((r) => r.style === "S2" && pass(r)).length}/${xs.filter((r) => r.style === "S2").length}`, pass_accepted: fmt(xa.filter(passAccepted).length, xa.length) }]; }));
  const completion = reconcile(outRoot);
  // 採点に使った定義とエンジン（<repo> から読み込んだ ev）・集計のコード（実行中のこのファイル）・spec-engine の dist の指紋。条件のファイル（計測の始めに記録）の値と照合する
  const aggregator = fileURLToPath(import.meta.url);
  const scoring = { dir: relative(repo, ev), aggregator: { path: relReal(repo, aggregator), sha256: sha256(readFileSync(aggregator)) }, ...scoringFingerprint(ev, aggregator) };
  const se = fingerprintDir(specEngineDist), as = fingerprintDir(appspecDist);
  const matches = (mine, theirs) => (theirs === undefined || theirs === null ? null : mine === theirs);
  // 読んだ定義ファイルと台本の指紋（#427）。条件のファイルの値（set.sha256・scripts.fingerprint）と照合する
  const scriptsFp = scriptsFingerprint(evalSet.scripts);
  const set = { id: evalSet.set.id, version: evalSet.set.version, role: evalSet.set.role, path: relReal(repo, evalSet.path), sha256: evalSet.sha256 };
  const fingerprints = {
    scoring,
    spec_engine: { dist_dir: relative(repo, specEngineDist), fingerprint: se.fingerprint, files: se.files },
    // 契約の検査に使った dist（#426）。条件のファイルには無いので照合しない
    appspec_schema: { dist_dir: relative(repo, appspecDist), fingerprint: as.fingerprint, files: as.files },
    set: { path: set.path, sha256: set.sha256 },
    scripts: scriptsFp,
    conditions: cond === null ? null : { schema: cond.schema ?? null, signature: cond.signature ?? null, factory: cond.factory?.fingerprint ?? null, spec_engine: cond.spec_engine?.fingerprint ?? null, scoring: cond.scoring?.fingerprint ?? null, judge: cond.judge?.configuration ?? null, set: cond.set?.sha256 ?? null, scripts: cond.scripts?.fingerprint ?? null },
    scoring_matches_conditions: matches(scoring.fingerprint, cond?.scoring?.fingerprint),
    spec_engine_matches_conditions: matches(se.fingerprint, cond?.spec_engine?.fingerprint),
    set_matches_conditions: matches(set.sha256, cond?.set?.sha256),
    scripts_matches_conditions: matches(scriptsFp.fingerprint, cond?.scripts?.fingerprint),
  };
  return { rubric: "v5", aggregation_versions: AGGREGATION_VERSIONS, scoring_systems: SCORING_SYSTEMS, set, metrics, metrics_accepted, metrics_script, fulfillment, completion, fingerprints, bySubject, rows };
}

// ── 匿名の集計（回帰用・保留用の組）：許可した欄だけを組み立てる。入力の文字列をそのまま通さない
const HEX64 = /^[0-9a-f]{64}$/;
/** 匿名で出す指標（数と区間だけ。factory_verdicts は別に既知の値へまとめる） */
export const ANONYMOUS_METRICS = ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd"];
/** 匿名で出す了承後系の指標（数と区間だけ。#426）。本数・件数は別に整数だけを、未評価の状態は既知の値だけを通す */
export const ANONYMOUS_ACCEPTED_METRICS = ["spec_pass_writable", "missed_partial", "spec_pass_partial", "unevaluated_runs", "unverified_runs", "wrong_exclusion_runs", "undecided_exclusion_runs"];
const hashOrNull = (x) => (typeof x === "string" && HEX64.test(x) ? x : null);
const enumOrUnknown = (allowed, x) => (x === null || x === undefined ? null : allowed.includes(x) ? x : "unknown");
const boolOrNull = (x) => (typeof x === "boolean" ? x : null);
const intOrNull = (x) => (Number.isInteger(x) ? x : null);
const countOrNull = (xs) => (Array.isArray(xs) ? xs.length : null);
/**
 * 行・題材ごとの表・ファイルの一覧を落とし、指標の数と区間・照合の本数・指紋だけにする。
 * 判定の値は既知の列挙（FACTORY_VERDICTS）か unknown にまとめ、止まった理由はコード（STOP_CODES）に、指紋は 64 桁の 16 進だけを通し、
 * schema と判定の口の構成は既知の値か unknown にする。測定 ID・署名以外の自由な文字列は出ない
 */
export function anonymize(full) {
  const c = full.completion, f = full.fingerprints, m = full.metrics, ma = full.metrics_accepted ?? {}, ms = full.metrics_script ?? {}, cond = f.conditions;
  const verdicts = Object.fromEntries([...FACTORY_VERDICTS, "unknown"].map((k) => [k, 0]));
  for (const [k, n] of Object.entries(m.factory_verdicts ?? {})) verdicts[FACTORY_VERDICTS.includes(k) ? k : "unknown"] += Number.isInteger(n) ? n : 0;
  const status = enumOrUnknown(Object.keys(COMPLETION_LABELS), c.status);
  return {
    rubric: "v5", anonymous: true, aggregation_versions: AGGREGATION_VERSIONS, scoring_systems: SCORING_SYSTEMS, runs: full.rows.length,
    metrics: { ...Object.fromEntries(ANONYMOUS_METRICS.map((k) => [k, m[k]])), factory_verdicts: verdicts },
    // 了承後系（#426）：本数・件数は整数だけ、率は数と区間の文字列だけ、未評価の状態は既知の値だけ。要件の文・部分の ID・当たった先は出さない
    metrics_accepted: {
      runs: intOrNull(ma.runs), confirmed: intOrNull(ma.confirmed), absent: intOrNull(ma.absent),
      absent_reasons: Object.fromEntries(ABSENT_REASONS.map((k) => [k, intOrNull(ma.absent_reasons?.[k])])), invalid: intOrNull(ma.invalid),
      ...Object.fromEntries(ANONYMOUS_ACCEPTED_METRICS.map((k) => [k, ma[k] ?? null])),
      unevaluated_checks: intOrNull(ma.unevaluated_checks), wrong_exclusions: intOrNull(ma.wrong_exclusions), undecided_exclusions: intOrNull(ma.undecided_exclusions),
      // 未検証の有効な要件は数だけ（要件の ID・文は出さない）
      unverified_requirements: intOrNull(ma.unverified_requirements), unverified_sources: Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, intOrNull(ma.unverified_sources?.[s])])),
      // 誤った了承は未評価のまま出す（状態と件数。0 件に丸めない）
      wrong_acceptances: { status: enumOrUnknown(EVALUATION_STATUSES, ma.wrong_acceptances?.status ?? null), ...Object.fromEntries(["evidence", "unmatched", "ambiguous", "unevaluated"].map((k) => [k, intOrNull(ma.wrong_acceptances?.[k])])) },
      wrong_acceptance_runs: { status: enumOrUnknown(EVALUATION_STATUSES, ma.wrong_acceptance_runs?.status ?? null), evidence: ma.wrong_acceptance_runs?.evidence ?? null, undecided: ma.wrong_acceptance_runs?.undecided ?? null },
      changes: Object.fromEntries(["added", "changed", "removed"].map((k) => [k, intOrNull(ma.changes?.[k])])), decisions: intOrNull(ma.decisions),
    },
    // 台本の照合（#427）：件数は整数だけ、率は数と区間の文字列だけ、当て方は既知の値だけ。問いの文・事項の ID・台本の件の ID は出さない
    metrics_script: { mode: enumOrUnknown([SCRIPT_MODE], ms.mode ?? null), ...Object.fromEntries(["runs", "questions", "scripted", "agreed", "disagreed", "unknown", "unresolved"].map((k) => [k, intOrNull(ms[k])])), ...Object.fromEntries(["runs_ok", "runs_disagreed", "runs_unanswered"].map((k) => [k, ms[k] ?? null])) },
    // 組（#427）：版と役割と指紋だけ（ID・題名は出さない）
    set: { version: intOrNull(full.set?.version), role: enumOrUnknown(EVAL_SET_ROLES, full.set?.role ?? null), sha256: hashOrNull(full.set?.sha256) },
    fulfillment: Object.fromEntries(["v1", "v2", "accepted"].map((v) => [v, { label: v === "accepted" ? SCORING_SYSTEMS.accepted : AGGREGATION_VERSIONS[v], partial: full.fulfillment[v]?.partial ?? null, writable: full.fulfillment[v]?.writable ?? null, all: full.fulfillment[v]?.all ?? null, ...(v === "accepted" ? { unevaluated: { checks: intOrNull(full.fulfillment.accepted?.unevaluated?.checks), runs: intOrNull(full.fulfillment.accepted?.unevaluated?.runs) } } : {}) }])),
    completion: { status, label: COMPLETION_LABELS[status] ?? "unknown", planned: intOrNull(c.planned), executed: intOrNull(c.executed), unexecuted: countOrNull(c.unexecuted), incomplete: countOrNull(c.incomplete), extra: countOrNull(c.extra), stop_code: enumOrUnknown(STOP_CODES, c.latest_record?.stop_code ?? null) },
    fingerprints: {
      scoring: hashOrNull(f.scoring.fingerprint), spec_engine: hashOrNull(f.spec_engine.fingerprint), appspec_schema: hashOrNull(f.appspec_schema?.fingerprint ?? null),
      set: hashOrNull(f.set?.sha256), scripts: hashOrNull(f.scripts?.fingerprint),
      conditions: cond === null ? null : { schema: enumOrUnknown(CONDITIONS_SCHEMAS, cond.schema), signature: hashOrNull(cond.signature), factory: hashOrNull(cond.factory), spec_engine: hashOrNull(cond.spec_engine), scoring: hashOrNull(cond.scoring), judge: enumOrUnknown(JUDGE_CONFIGURATIONS, cond.judge), set: hashOrNull(cond.set), scripts: hashOrNull(cond.scripts) },
      scoring_matches_conditions: boolOrNull(f.scoring_matches_conditions), spec_engine_matches_conditions: boolOrNull(f.spec_engine_matches_conditions),
      set_matches_conditions: boolOrNull(f.set_matches_conditions), scripts_matches_conditions: boolOrNull(f.scripts_matches_conditions),
    },
  };
}

async function main() {
  const [repo, outRoot] = process.argv.slice(2);
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";
  const anonymous = process.argv.includes("--anonymous");
  const setPath = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : undefined;
  let full;
  try { full = await scoreOutput(repo, outRoot, setPath === undefined ? {} : { setPath }); } catch (e) { if (/定義ファイル/.test(String(e?.message))) { console.error(`断りました: ${e.message}`); process.exit(3); } throw e; }
  const name = `score${label ? "-" + label : ""}`;
  if (anonymous) {
    const a = anonymize(full);
    writeFileSync(join(outRoot, `${name}.anonymous.json`), JSON.stringify(a, null, 1));
    console.log(JSON.stringify(a, null, 1));
    return;
  }
  writeFileSync(join(outRoot, `${name}.json`), JSON.stringify(full, null, 1));
  const { set, metrics, metrics_accepted, metrics_script, fulfillment, completion, fingerprints, bySubject, rows } = full;
  console.log(JSON.stringify({ set, metrics, metrics_accepted, metrics_script, fulfillment, completion, bySubject }, null, 1));
  for (const r of rows) console.log([r.run, r.factory_verdict, r.verdict ?? "GEN_FAIL", (r.failed ?? []).join("・"), r.claims ? `claims ok=${r.claims.correct} miss=${r.claims.missed} false=${r.claims.false_claims.length}` : "", r.cost_usd?.toFixed(3), Math.round(r.seconds), `了承後=${r.verdict_accepted ?? "-"}`].join("\t"));
  console.log(`照合: ${completion.label}（予定 ${completion.planned ?? "-"}・実行 ${completion.executed}・未実行 ${completion.unexecuted?.length ?? "-"}・途中 ${completion.incomplete.length}${completion.latest_record?.stop ? `・止まった理由: ${completion.latest_record.stop}` : ""}${completion.status === "unverified" ? `・理由: ${completion.reasons.join("、")}` : ""}）`);
  const ma = metrics_accepted, ar = ma.absent_reasons, wa = ma.wrong_acceptances, us = ma.unverified_sources;
  console.log(`了承後: 対象 ${ma.runs} 本（確定 ${ma.confirmed}・記録なし ${ma.absent}［未確定 ${ar.plan_not_confirmed}・確定後に仕様なし ${ar.confirmed_without_plan}・不明 ${ar.unknown}］・読めない ${ma.invalid}）・未評価の本 ${fulfillment.accepted.unevaluated.runs}・未検証の有効な要件 ${ma.unverified_requirements} 件（代替先 ${us.accepted_unwritable + us.part}・変更後 ${us.changed}・追加 ${us.added}）・誤った除外 ${ma.wrong_exclusions} 件（判定不能 ${ma.undecided_exclusions} 件）・誤った了承 未評価（証拠 ${wa.evidence} 件・判定不能 ${wa.unmatched + wa.ambiguous} 件・書ける要件の変更 ${wa.unevaluated} 件）・充足 ${fulfillment.accepted.all}（未評価の判定 ${fulfillment.accepted.unevaluated.checks}）`);
  const ms = metrics_script;
  console.log(`台本: 対象 ${ms.runs} 本・問い ${ms.questions}（台本で答えられた ${ms.scripted}［推奨と同じ ${ms.agreed}・違う ${ms.disagreed}］・不明 ${ms.unknown}・決められない ${ms.unresolved}）・本の内訳（一致 ${ms.runs_ok}・不一致 ${ms.runs_disagreed}・不明あり ${ms.runs_unanswered}）`);
  const judge = (m) => (m === null ? "条件のファイルに無い" : m ? "条件のファイルと一致" : "条件のファイルと不一致");
  console.log(`指紋: 採点 ${fingerprints.scoring.fingerprint.slice(0, 12)}…（${judge(fingerprints.scoring_matches_conditions)}）・spec-engine ${fingerprints.spec_engine.fingerprint?.slice(0, 12) ?? "-"}…（${judge(fingerprints.spec_engine_matches_conditions)}）・組 ${set.id} v${set.version} ${set.sha256.slice(0, 12)}…（${judge(fingerprints.set_matches_conditions)}）・台本 ${fingerprints.scripts.fingerprint?.slice(0, 12) ?? "-"}…（${judge(fingerprints.scripts_matches_conditions)}）`);
}

const isEntry = () => { if (process.argv[1] === undefined) return false; try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) await main();
