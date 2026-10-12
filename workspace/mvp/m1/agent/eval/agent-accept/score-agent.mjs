// 受入の試験の採点：run-agent.mjs の出力を採点表 v5（凍結）で採点し、基準線と同じ指標を出す。API は呼ばない。
// 使い方: node score-agent.mjs <repo> <out> [--label high] [--anonymous]
//   --anonymous：行ごとの失敗の鍵・要件の文・題材 ID を出さず、指標の数と区間だけを書く（回帰用・保留用の組。#425）。
//                書くのは score[-label].anonymous.json だけで、行つきの score[-label].json は書かない
// #425 で足したもの（既存の欄は消さず、意味も変えない）：
//   集計の版 … v1 ＝ 補正前（metrics の fulfillment_partial と rows の fulfilled／writable_total。生成失敗・静的 NG の本は
//              充足率の分母に入らない）。v2 ＝ 補正後（fulfillment.v2 と rows の fulfillment_v2。分母は題材の採点定義の判定の数。
//              生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す）。2 つの版は別の欄に並べ、混ぜない
//   本数の照合 … completion。条件のファイルの予定（child_args）を検証（schema・一覧の型・ID の形と一意性・params.patterns × runs との一致）
//              してから出力先の本と照合し、未実行・途中・予定外が 1 本でもあれば「未完了」。検証に落ちれば「未照合」と理由
//   指紋 … fingerprints。採点に使った定義とエンジン（<repo> から実際に読み込んだもの）と集計のコード（実行中のこのファイル）の指紋、
//          spec-engine の dist の指紋。条件のファイルの値と照合する（別の checkout を <repo> に渡しても、集計したコードの指紋が出る）
// run-agent.mjs は、ここから指紋の関数を import して条件のファイルに書く（道具は 2 本で 1 組。入口として起動したときだけ採点する）
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUBJECT = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };
export const STYLE = { P1: "S1", P2: "S2", P3: "S1", P4: "S2", P5: "S1", P6: "S2", P7: "S1", P8: "S2", P9: "S1", P10: "S2" };
export const AGGREGATION_VERSIONS = {
  v1: "補正前：充足率の分母は当てはまった構造の判定の数。生成失敗・静的 NG の本は分母に入らない",
  v2: "補正後：充足率の分母は題材の採点定義の判定の数（当てはまった構造。無ければ主の構造）。生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す",
};
/** 条件のファイルの既知の schema（v1 ＝ #401、v2 ＝ #425。どちらも child_args と params.patterns・params.runs を持つ） */
export const CONDITIONS_SCHEMAS = ["musunest-factory/agent-accept-conditions/v1", "musunest-factory/agent-accept-conditions/v2"];
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

// ── 採点と集計
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n}（${n ? pct(k / n) : "-"}・95% 区間 ${pct(lo)}〜${pct(hi)}）`; };
const sum = (xs, f) => xs.reduce((s, r) => s + f(r), 0);
const pass = (r) => !r.generation_failed && r.verdict === "PASS";
const relReal = (from, to) => { try { return relative(realpathSync(from), realpathSync(to)); } catch { return relative(from, to); } };

export async function scoreOutput(repo, outRoot) {
  const ev = join(repo, "workspace/mvp/m1/agent/eval");
  const { loadDef, score } = await import(pathToFileURL(join(ev, "engine.mjs")).href);
  const { finalVerdict, scoreClaims } = await import(pathToFileURL(join(ev, "score-claims.mjs")).href);
  const specEngineDist = join(repo, "packages/spec-engine/dist");
  const engine = await import(pathToFileURL(join(specEngineDist, "index.js")).href);
  const rows = [];
  for (const d of runDirs(outRoot)) {
    const p = d.split("-")[0], subject = SUBJECT[p], dir = join(outRoot, d);
    const sl = existsSync(join(dir, "summary.line.json")) ? readJson(join(dir, "summary.line.json")) : null;
    const s = sl?.summary ?? null;
    const spec = join(dir, "bundle/artifacts/app.spec.yaml");
    // --plan の本（#378）：費用は Plan と Build の合計。Plan の結果と質問の数も残す
    const planRecordPath = join(dir, "bundle/plan-record.json");
    const pr = existsSync(planRecordPath) ? readJson(planRecordPath) : null;
    const plan = pr === null ? null : { outcome: pr.outcome ?? null, questions: (pr.rounds ?? []).reduce((n, round) => n + (round.questions ?? []).length, 0), rounds: (pr.rounds ?? []).length, usd: sl?.plan_cost?.plan_usd ?? pr.spent_usd ?? 0 };
    const base = { run: d, pattern: p, subject, style: STYLE[p], factory_verdict: s?.verdict ?? null, stop: s?.stop_reason ?? s?.stop_class ?? null, failure: s?.failure ?? null, cost_usd: sl?.plan_cost?.total_usd ?? s?.provider_cost_usd ?? 0, seconds: sl?.wall_s ?? s?.duration_secs ?? 0, plan };
    const def = loadDef(join(ev, "subjects", `${subject}.json`));
    // 補正後（v2）の分母の既定：主の構造（0 番目）の判定の数。役割が見つからないときに engine.mjs が writable_total に使う値と同じ
    const main = def.structures[0], fromDefinition = { total: main.checks.length, total_from: `definition:${main.id}` };
    if (!existsSync(spec)) { rows.push({ ...base, generation_failed: true, fulfillment_v2: { fulfilled: 0, ...fromDefinition } }); continue; }
    const r = await score(engine, spec, def);
    const uw = existsSync(join(dir, "bundle/artifacts/unwritable.json")) ? readJson(join(dir, "bundle/artifacts/unwritable.json")).unwritable ?? [] : [];
    const claimsList = uw.flatMap((u) => (u.unwritable ?? []).map((part) => ({ requirement: `${u.text}（${u.quote}）`, reason: part })));
    const claims = scoreClaims({ attempts: [{ unwritable: claimsList }] }, def, r.structure, r.written);
    // 構造が当てはまった本は、その構造の判定の数が分母。静的 NG・役割が見つからない本は充足 0 で、主の構造の判定の数が分母
    const fulfillment_v2 = r.structure ? { fulfilled: r.fulfilled ?? 0, total: r.writable_total, total_from: `structure:${r.structure}` } : { fulfilled: 0, ...fromDefinition };
    rows.push({ ...base, spec_verdict: r.verdict, verdict: finalVerdict(r, claims), failed: Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k), fulfilled: r.fulfilled ?? 0, writable_total: r.writable_total ?? 0, claims, final_static: r.verdict === "STATIC_NG" ? 1 : 0, fulfillment_v2 });
  }
  const W = rows.filter((r) => ["A", "C", "E"].includes(r.subject)), P = rows.filter((r) => ["B", "D"].includes(r.subject));
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
  const fulfillment = {
    v1: { label: AGGREGATION_VERSIONS.v1, partial: v1(P), writable: v1(W), all: v1(rows) },
    v2: { label: AGGREGATION_VERSIONS.v2, partial: v2(P), writable: v2(W), all: v2(rows) },
  };
  const bySubject = Object.fromEntries(["A", "B", "C", "D", "E"].map((s) => { const xs = rows.filter((r) => r.subject === s); return [s, { pass: fmt(xs.filter(pass).length, xs.length), S1: `${xs.filter((r) => r.style === "S1" && pass(r)).length}/${xs.filter((r) => r.style === "S1").length}`, S2: `${xs.filter((r) => r.style === "S2" && pass(r)).length}/${xs.filter((r) => r.style === "S2").length}` }]; }));
  const completion = reconcile(outRoot);
  // 採点に使った定義とエンジン（<repo> から読み込んだ ev）・集計のコード（実行中のこのファイル）・spec-engine の dist の指紋。条件のファイル（計測の始めに記録）の値と照合する
  const cond = readConditions(outRoot);
  const aggregator = fileURLToPath(import.meta.url);
  const scoring = { dir: relative(repo, ev), aggregator: { path: relReal(repo, aggregator), sha256: sha256(readFileSync(aggregator)) }, ...scoringFingerprint(ev, aggregator) };
  const se = fingerprintDir(specEngineDist);
  const matches = (mine, theirs) => (theirs === undefined || theirs === null ? null : mine === theirs);
  const fingerprints = {
    scoring,
    spec_engine: { dist_dir: relative(repo, specEngineDist), fingerprint: se.fingerprint, files: se.files },
    conditions: cond === null ? null : { schema: cond.schema ?? null, signature: cond.signature ?? null, factory: cond.factory?.fingerprint ?? null, spec_engine: cond.spec_engine?.fingerprint ?? null, scoring: cond.scoring?.fingerprint ?? null, judge: cond.judge?.configuration ?? null },
    scoring_matches_conditions: matches(scoring.fingerprint, cond?.scoring?.fingerprint),
    spec_engine_matches_conditions: matches(se.fingerprint, cond?.spec_engine?.fingerprint),
  };
  return { rubric: "v5", aggregation_versions: AGGREGATION_VERSIONS, metrics, fulfillment, completion, fingerprints, bySubject, rows };
}

// ── 匿名の集計（回帰用・保留用の組）：許可した欄だけを組み立てる。入力の文字列をそのまま通さない
const HEX64 = /^[0-9a-f]{64}$/;
/** 匿名で出す指標（数と区間だけ。factory_verdicts は別に既知の値へまとめる） */
export const ANONYMOUS_METRICS = ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd"];
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
  const c = full.completion, f = full.fingerprints, m = full.metrics, cond = f.conditions;
  const verdicts = Object.fromEntries([...FACTORY_VERDICTS, "unknown"].map((k) => [k, 0]));
  for (const [k, n] of Object.entries(m.factory_verdicts ?? {})) verdicts[FACTORY_VERDICTS.includes(k) ? k : "unknown"] += Number.isInteger(n) ? n : 0;
  const status = enumOrUnknown(Object.keys(COMPLETION_LABELS), c.status);
  return {
    rubric: "v5", anonymous: true, aggregation_versions: AGGREGATION_VERSIONS, runs: full.rows.length,
    metrics: { ...Object.fromEntries(ANONYMOUS_METRICS.map((k) => [k, m[k]])), factory_verdicts: verdicts },
    fulfillment: Object.fromEntries(["v1", "v2"].map((v) => [v, { label: AGGREGATION_VERSIONS[v], partial: full.fulfillment[v].partial, writable: full.fulfillment[v].writable, all: full.fulfillment[v].all }])),
    completion: { status, label: COMPLETION_LABELS[status] ?? "unknown", planned: intOrNull(c.planned), executed: intOrNull(c.executed), unexecuted: countOrNull(c.unexecuted), incomplete: countOrNull(c.incomplete), extra: countOrNull(c.extra), stop_code: enumOrUnknown(STOP_CODES, c.latest_record?.stop_code ?? null) },
    fingerprints: {
      scoring: hashOrNull(f.scoring.fingerprint), spec_engine: hashOrNull(f.spec_engine.fingerprint),
      conditions: cond === null ? null : { schema: enumOrUnknown(CONDITIONS_SCHEMAS, cond.schema), signature: hashOrNull(cond.signature), factory: hashOrNull(cond.factory), spec_engine: hashOrNull(cond.spec_engine), scoring: hashOrNull(cond.scoring), judge: enumOrUnknown(JUDGE_CONFIGURATIONS, cond.judge) },
      scoring_matches_conditions: boolOrNull(f.scoring_matches_conditions), spec_engine_matches_conditions: boolOrNull(f.spec_engine_matches_conditions),
    },
  };
}

async function main() {
  const [repo, outRoot] = process.argv.slice(2);
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";
  const anonymous = process.argv.includes("--anonymous");
  const full = await scoreOutput(repo, outRoot);
  const name = `score${label ? "-" + label : ""}`;
  if (anonymous) {
    const a = anonymize(full);
    writeFileSync(join(outRoot, `${name}.anonymous.json`), JSON.stringify(a, null, 1));
    console.log(JSON.stringify(a, null, 1));
    return;
  }
  writeFileSync(join(outRoot, `${name}.json`), JSON.stringify(full, null, 1));
  const { metrics, fulfillment, completion, fingerprints, bySubject, rows } = full;
  console.log(JSON.stringify({ metrics, fulfillment, completion, bySubject }, null, 1));
  for (const r of rows) console.log([r.run, r.factory_verdict, r.verdict ?? "GEN_FAIL", (r.failed ?? []).join("・"), r.claims ? `claims ok=${r.claims.correct} miss=${r.claims.missed} false=${r.claims.false_claims.length}` : "", r.cost_usd?.toFixed(3), Math.round(r.seconds)].join("\t"));
  console.log(`照合: ${completion.label}（予定 ${completion.planned ?? "-"}・実行 ${completion.executed}・未実行 ${completion.unexecuted?.length ?? "-"}・途中 ${completion.incomplete.length}${completion.latest_record?.stop ? `・止まった理由: ${completion.latest_record.stop}` : ""}${completion.status === "unverified" ? `・理由: ${completion.reasons.join("、")}` : ""}）`);
  const judge = (m) => (m === null ? "条件のファイルに無い" : m ? "条件のファイルと一致" : "条件のファイルと不一致");
  console.log(`指紋: 採点 ${fingerprints.scoring.fingerprint.slice(0, 12)}…（${judge(fingerprints.scoring_matches_conditions)}）・spec-engine ${fingerprints.spec_engine.fingerprint?.slice(0, 12) ?? "-"}…（${judge(fingerprints.spec_engine_matches_conditions)}）`);
}

const isEntry = () => { if (process.argv[1] === undefined) return false; try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) await main();
