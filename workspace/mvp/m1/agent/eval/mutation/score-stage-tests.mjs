// U2 試験の指標の道具（#686。README §10.8.2）。凍結した上流の組（境界 t1-t2）から T2 だけを流した段の走り（条件 v8・範囲 test-spec..test-spec）の
// 記録と境界 t2-b1 の checkpoint を、参照の宣言の組（P ごとに 1 本。組と表の SHA で結ぶ）に当て、手 5（手 5a の分類 → 手 5b の評価）の
// 変異の検出率と落とせない試験の率を本・P・群ごとに出す。計測の道具であって門ではない：工場の package を import せず（dist の公開の値と関数を
// 計測の checkout の場所から読む）、門・判定・merge の可否に使わない。API・LLM・判定・通信を使わない（費用 0）。
//
// 使い方:
//   node score-stage-tests.mjs --make-reference <参照の計測の出力先> <上流の組のディレクトリ> <参照の宣言の組のディレクトリ> --id <組の ID> --version <整数>
//   node score-stage-tests.mjs <repo> <U2 の計測の出力先（--compare なら比較の記録の出力先）> <参照の宣言の組のディレクトリ> <出力先> [--compare] [--anonymous]
// 照合は fail-closed で、口ごとに扱いを分ける：(a) 計測全体（条件の版・範囲・上流の組・参照の宣言の組の署名と写し・dist の指紋）は合わなければ何も書かず
//   exit 3・固定の符号。(b) 本ごと（入力・出力ダイジェスト・表の SHA・確定した仕様の SHA）は合わない本を mismatch に数えて評価せず、予定の分母に残す。
//   (c) 参照の作成のときの表の不一致は参照の宣言の組の missing（table-mismatch）。断りの行は符号だけ（値・パスを出さない）
// 参照の宣言の組・文脈・目録は題材の名前を含むので、置き場所はリポジトリの外（道具は場所を引数で受けるだけ）。出力に要件の文・宣言の原文を写さない
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTEXT_SCHEMA, INVENTORY_SCHEMA, checkContext, makeRate, scoreMutants, toAnonymous as anonymousMutation } from "./score-mutants.mjs";
import { classifyMutations } from "./classify.mjs";
import { MutationToolError } from "./mutate.mjs";
import { SOURCE_PATHS, patternInterval } from "../table/score-table.mjs";
import { COMPARE_PAIRS_COPY, COMPARISON_FILE, CONDITIONS_V8, STAGE_COMPARE_GROUPS, STAGE_COMPARE_ROLES, STAGE_COMPARISON_SCHEMA, STAGE_FROM_SET_KIND, STAGE_PAIRS_SCHEMA, STAGE_RUN_MODE, V12_PIPELINE, clusterStats, conditionsSignature, fingerprintDir, loadConditions, loadEvalSet, pairsShapeProblem } from "../agent-accept/score-agent.mjs";
import { loadFrozenStageSet } from "../agent-accept/freeze-stage-input.mjs";
import { checkEnvelope, loadPlanFileChecks, refusalLine } from "../agent-accept/freeze-plan-set.mjs";

/** 参照の宣言の組の版・組のファイルの名前・写しの置き場所・作る規則（版 1）・本の中の納品物の宣言の場所 */
export const REFERENCE_SET_SCHEMA = "musunest-eval/reference-declaration-set/v1";
export const REFERENCE_SET_FILE = "reference-declaration-set.json";
export const REFERENCE_DECLARATION_DIR = "declarations";
export const REFERENCE_RULE = { name: "adopted-run-declaration", version: 1 };
export const DECLARATION_PATH = "bundle/artifacts/app.spec.yaml";
/** 参照の宣言の無い P の理由（納品物の宣言が無い・受理済みの表の SHA が組の checkpoint の表と違う・上流の組が外した P） */
export const REFERENCE_MISSING = ["no-declaration", "table-mismatch", "upstream-missing"];
/** 出力の版と名前 */
export const OUTPUT_SCHEMA = "musunest-eval/stage-tests-score/v1";
export const COMPARE_SCHEMA = "musunest-eval/stage-tests-compare/v1";
export const ANONYMOUS_SCHEMA = "musunest-eval/stage-tests-anonymous/v1";
export const OUTPUT_FILE = "stage-tests-score.json";
export const COMPARE_FILE = "stage-tests-compare.json";
export const anonymousFileOf = (file) => file.replace(/\.json$/, ".anonymous.json");
/** U2 の範囲（T2 だけ） */
export const U2_RANGE = { start: "test-spec", end: "test-spec" };
/**
 * 本の状態（排他的。上から最初に当てはまる 1 つ）：入力なし → 欠測（起こしたが記録が読めない）→ mismatch（(b) の照合に落ちる）→ 段を通らない →
 * 参照の宣言なし → 評価した（手 5b の候補の状態は別の欄）
 */
export const RUN_STATES = ["input-absent", "missing", "mismatch", "stage-failed", "no-reference", "evaluated"];
/** mismatch の理由（範囲・入力の出力ダイジェスト・確定した仕様・checkpoint が無い／読めない・出力ダイジェスト・表の SHA・文脈が組めない） */
export const MISMATCH_REASONS = ["range", "input", "plan", "checkpoint", "digest", "table", "context"];
/** 対の比較で除く理由 */
export const PAIR_EXCLUSIONS = ["unlaunched", "missing", "mismatch", "stage-failed", "no-reference", "not-aligned", "no-eligible"];
export const EXIT_REFUSED = 3;

export const DEFINITIONS = {
  unit: "U2（C4 試験）。入口は凍結した上流の組（境界 t1-t2）、出口は境界 t2-b1 の checkpoint。段の走りの範囲は test-spec..test-spec",
  denominator: "群の件数の分母は予定（条件の child_args の全部）。入力なし・欠測・mismatch・段を通らない・参照の宣言なし・原本不適・試験と原本が合わない・適格な変異 0・評価した、の和が予定に等しい（黙って落とさない）",
  conditional_note: "検出率は適格な変異に限る条件付きの率（手 5b の定義）。変異の全体の検出率ではない",
  p_aggregate: "P ごとの率＝その P の評価した本の分子の和 ÷ 分母の和。群の率は P を単位にした平均と bootstrap の区間（表の採点の patternInterval）。全部を合わせた率の Wilson は参考（独立を仮定）",
  zero_denominator: "分母 0 は 0% にせず、率を null にして理由の符号を付ける",
  reference_note: "版 1 の参照の宣言は参照の計測で受理された宣言（規則 adopted-run-declaration）。正しい宣言ではない。版をまたいで比較しない",
  stage_note: "段の通過は納品の成功ではない。判定・門・merge の可否に使わない。費用 0（API・LLM・判定を呼ばない）",
};

export class StageTestsError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = (code) => { throw new StageTestsError(code); };

const HEX64 = /^[0-9a-f]{64}$/;
const PID = /^P\d+$/;
const RUN_ID = /^(P\d+)-r(\d+)$/;
const CODE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x !== "";
const isInt = (x) => Number.isInteger(x) && x >= 0;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJsonOr = (path, fallback = undefined) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const here = dirname(fileURLToPath(import.meta.url));
const scoringEngineFile = join(here, "../engine.mjs");
const toolFingerprint = () => sha256(["score-stage-tests.mjs", "score-mutants.mjs", "classify.mjs", "mutate.mjs"].map((n) => `${n}\n${sha256(readFileSync(join(here, n)))}\n`).join(""));

// ── 参照の宣言の組
/** 組の署名：署名の欄を除いた組の JSON の SHA-256（欄の順は組を作った順のまま） */
export function referenceSignature(set) {
  const { signature: _s, ...rest } = set;
  return sha256(JSON.stringify(rest));
}
export const referenceBytes = (set) => Buffer.from(JSON.stringify({ ...set, signature: referenceSignature(set) }, null, 1) + "\n");
/** 組の中の相対パス（declarations/<P>/<名前> の形で、.. を含まない） */
const safeRel = (p, pid) => typeof p === "string" && !isAbsolute(p) && p.split("/").length === 3 && p.split("/")[0] === REFERENCE_DECLARATION_DIR && p.split("/")[1] === pid && !["", ".", ".."].includes(p.split("/")[2]);
const fileRefOk = (r, pid) => isObj(r) && safeRel(r.path, pid) && HEX64.test(r.sha256 ?? "");
function referenceShapeOk(set) {
  if (!isObj(set) || set.schema !== REFERENCE_SET_SCHEMA || !isStr(set.id) || !Number.isInteger(set.version) || !isObj(set.rule)) return false;
  if (!isObj(set.frozen_set) || !isStr(set.frozen_set.id) || !Number.isInteger(set.frozen_set.version) || !HEX64.test(set.frozen_set.sha256 ?? "")) return false;
  if (!isObj(set.source) || !HEX64.test(set.source.conditions_sha256 ?? "")) return false;
  if (!Array.isArray(set.declarations) || !Array.isArray(set.missing) || typeof set.signature !== "string") return false;
  const seen = new Set();
  for (const d of set.declarations) {
    if (!isObj(d) || !PID.test(d.pattern ?? "") || seen.has(d.pattern) || !isStr(d.origin) || !(d.origin === "human" || RUN_ID.exec(d.origin)?.[1] === d.pattern)) return false;
    if (!fileRefOk(d.declaration, d.pattern) || !HEX64.test(d.table_sha256 ?? "") || !(d.marks === null || d.marks === undefined || fileRefOk(d.marks, d.pattern))) return false;
    seen.add(d.pattern);
  }
  for (const m of set.missing) {
    if (!isObj(m) || !PID.test(m.pattern ?? "") || seen.has(m.pattern) || !isStr(m.reason) || !CODE.test(m.reason)) return false;
    seen.add(m.pattern);
  }
  return true;
}
/**
 * 参照の宣言の組のディレクトリを読む。無ければ missing、JSON でなければ unreadable、形が違えば invalid、署名が中身と合わなければ signature、
 * 写しが無い・SHA が組の値と違えば sha256。通れば組・組のファイルの SHA-256・P ごとの宣言（と印）のバイト列と絶対パス
 */
export function loadReferenceSet(dir) {
  const path = join(dir, REFERENCE_SET_FILE);
  if (!existsSync(path)) return { status: "missing" };
  let bytes, set;
  try { bytes = readFileSync(path); set = JSON.parse(bytes.toString("utf8")); } catch { return { status: "unreadable" }; }
  if (!referenceShapeOk(set)) return { status: "invalid" };
  if (referenceSignature(set) !== set.signature) return { status: "signature" };
  const byPattern = new Map();
  for (const d of set.declarations) {
    const read = (ref) => { const p = join(dir, ref.path); const b = readFileSync(p); if (sha256(b) !== ref.sha256) throw new Error("sha"); return { bytes: b, path: realpathSync(p), sha256: ref.sha256 }; };
    try { byPattern.set(d.pattern, { entry: d, declaration: read(d.declaration), marks: isObj(d.marks) ? read(d.marks) : null }); } catch { return { status: "sha256" }; }
  }
  return { status: "ok", set, bytes, sha256: sha256(bytes), byPattern };
}

/**
 * 参照の宣言の組を作る（版 1 の規則 adopted-run-declaration）。上流の組の署名と写しの SHA が中身と合い review があり、参照の計測の条件のファイルの SHA が
 * 上流の組の source.conditions_sha256 と同じことを確かめてから、組が採用した本と同じ本の受理済みの宣言を写す（その本の受理済みの表の SHA が組の
 * checkpoint の表の SHA と違えば table-mismatch）。断るときは { code }、作れたら { set（署名なし）, copies: [{ rel, bytes }] }。本を選ばせる引数は無い
 */
export function makeReferenceSet({ referenceOut, upstreamDir, id, version }) {
  if (!isStr(id) || !Number.isInteger(version)) return { code: "make-reference:args" };
  const up = loadFrozenStageSet(upstreamDir);
  if (up.status !== "ok") return { code: `make-reference:set-${up.status}` };
  if (!("review" in up.set)) return { code: "make-reference:set-review" };
  let condBytes;
  try { condBytes = readFileSync(join(referenceOut, "conditions.json")); } catch { return { code: "make-reference:conditions-unreadable" }; }
  if (sha256(condBytes) !== up.set.source.conditions_sha256) return { code: "make-reference:source-mismatch" };
  const cond = readJsonOr(join(referenceOut, "conditions.json"), null);
  const declarations = [], missing = [], copies = [];
  for (const a of up.set.adopted) {
    const bundle = join(referenceOut, a.run);
    let decl = null;
    try { decl = readFileSync(join(bundle, DECLARATION_PATH)); } catch { decl = null; }
    if (decl === null) { missing.push({ pattern: a.pattern, reason: "no-declaration" }); continue; }
    const table = readJsonOr(join(bundle, SOURCE_PATHS.accepted), null);
    if (!isObj(table) || table.table_sha256 !== a.table_sha256) { missing.push({ pattern: a.pattern, reason: "table-mismatch" }); continue; }
    const rel = `${REFERENCE_DECLARATION_DIR}/${a.pattern}/app.spec.yaml`;
    copies.push({ rel, bytes: decl });
    declarations.push({ pattern: a.pattern, origin: a.run, declaration: { path: rel, sha256: sha256(decl) }, table_sha256: a.table_sha256, marks: null });
  }
  for (const m of up.set.missing) missing.push({ pattern: m.pattern, reason: "upstream-missing" });
  missing.sort((x, y) => Number(x.pattern.slice(1)) - Number(y.pattern.slice(1)));
  const set = {
    schema: REFERENCE_SET_SCHEMA, id, version, rule: REFERENCE_RULE,
    frozen_set: { id: up.set.id, version: up.set.version, sha256: up.sha256 },
    source: { conditions_sha256: up.set.source.conditions_sha256, measurement_id: isObj(cond) && typeof cond.measurement_id === "string" ? cond.measurement_id : null },
    declarations, missing,
  };
  return { set, copies };
}

// ── 工場の dist（計測の checkout の場所から読む。工場の package を import しない）
async function loadStageDist(repo) {
  const distDir = join(repo, "packages/factory/dist");
  try {
    const entry = await import(pathToFileURL(join(distDir, "index.js")).href);
    const checks = await loadPlanFileChecks(distDir);
    const names = ["stageOutputDigest", "stageCheckpointFile", "boundaryBefore", "requirementsFromPlan", "pruneForCarryOver"];
    if (names.some((n) => typeof entry[n] !== "function") || !Array.isArray(entry.STAGE_STARTS) || typeof entry.STAGE_RUN_RECORD_FILE !== "string") return null;
    const next = entry.STAGE_STARTS[entry.STAGE_STARTS.indexOf(U2_RANGE.end) + 1];
    const boundary = next === undefined ? null : entry.boundaryBefore(next);
    if (typeof boundary !== "string") return null;
    return { distDir, entry, checks, boundary, checkpointFile: entry.stageCheckpointFile(boundary), recordFile: entry.STAGE_RUN_RECORD_FILE };
  } catch { return null; }
}

// ── (a) 計測全体の照合
/** 計測の条件を照らす（合わなければ断る）。distOf が null でなければ、条件の dist の指紋が今の checkout の dist と同じことも求める */
function checkMeasurement(dir, ref, repo, { distCheck }) {
  const loaded = loadConditions(dir);
  if (loaded.status !== "ok") refuse("stage-tests:conditions-unreadable");
  const cond = loaded.cond;
  if (cond.schema !== CONDITIONS_V8 || typeof cond.signature !== "string" || cond.signature !== conditionsSignature(cond) || !isObj(cond.params)) refuse("stage-tests:conditions-version");
  const p = cond.params;
  if (p.mode !== STAGE_RUN_MODE || p.pipeline !== V12_PIPELINE || p.stage_start !== U2_RANGE.start || p.stage_end !== U2_RANGE.end) refuse("stage-tests:range");
  const sf = p.stage_from, fz = ref.set.frozen_set;
  if (!isObj(sf) || sf.kind !== STAGE_FROM_SET_KIND || sf.id !== fz.id || sf.version !== fz.version || sf.sha256 !== fz.sha256) refuse("stage-tests:frozen-set");
  if (distCheck) {
    const f = fingerprintDir(join(repo, "packages/factory/dist")).fingerprint, s = fingerprintDir(join(repo, "packages/spec-engine/dist")).fingerprint;
    if (f === null || f !== cond.factory?.fingerprint || s === null || s !== cond.spec_engine?.fingerprint) refuse("stage-tests:dist");
  }
  if (!Array.isArray(cond.child_args) || cond.child_args.length === 0 || !cond.child_args.every((c) => isObj(c) && RUN_ID.test(c.id ?? "")) || !Array.isArray(p.stage_inputs)) refuse("stage-tests:conditions-version");
  if (!isObj(cond.frozen) || !Array.isArray(cond.frozen.adopted)) refuse("stage-tests:conditions-version");
  const evalSet = isObj(cond.set) && typeof cond.set.path === "string" ? loadEvalSet(resolve(repo, cond.set.path)) : { status: "missing" };
  if (evalSet.status !== "ok" || evalSet.sha256 !== cond.set.sha256) refuse("stage-tests:set");
  return { cond, evalSet, conditionsSha256: sha256(readFileSync(join(dir, "conditions.json"))) };
}

// ── (b) 本ごとの照合と文脈
/** 確定した仕様の写し（本のディレクトリの plan-file.json）を工場の包みの検査で読み直す。合わなければ null */
async function planOfRun(dist, runDir, adopted, requestText) {
  let bytes;
  try { bytes = readFileSync(join(runDir, "plan-file.json")); } catch { return null; }
  if (!isObj(adopted) || sha256(bytes) !== adopted.envelope_sha256) return null;
  const checked = await checkEnvelope(dist.checks, bytes, requestText + "\n");
  if (!checked.ok || checked.planSha256 !== adopted.plan_sha256) return null;
  const parsed = dist.checks.parsePlanFile(bytes.toString("utf8"));
  const v = await dist.checks.validatePlanFile({ envelope: parsed.envelope, source: requestText + "\n", vocabularyVersion: dist.checks.vocabularyVersion });
  return v?.kind === "ok" ? { plan: v.plan, planSha256: checked.planSha256 } : null;
}

/**
 * checkpoint（境界 t2-b1）と確定した仕様から、手 5b の有効な評価の文脈を組む（工場の回す部分が B の評価口に渡す文脈と同じ導き方。工場の dist の関数を使う）。
 * 表は checkpoint の name_table（表の SHA の欄を除く）、一覧・組・所属は持ち越しと要件でない文を除いたもの、棄却した試験は T2 だけの走りでは空、台帳の旗は checkpoint の版の旗
 */
export function contextOf(dist, cp, plan) {
  const nt = cp.name_table, co = cp.carry_over, ts = cp.test_spec;
  const table = { rows: nt.rows, ownership: nt.ownership, verification: nt.verification, classification: nt.classification };
  const carry = { entries: co.entries, excludedRowIds: co.excluded_row_ids, remainingRequirementIds: co.remaining_requirement_ids, allCarried: false, ...(co.non_requirements === undefined ? {} : { nonRequirements: co.non_requirements }) };
  const pruned = dist.entry.pruneForCarryOver(dist.entry.requirementsFromPlan(plan), table, carry, ts.suite);
  return {
    schema: CONTEXT_SCHEMA,
    table,
    list: pruned.list,
    suite: pruned.suite ?? { tests: [] },
    ownership: pruned.conversion.ownership,
    excluded_row_ids: co.excluded_row_ids,
    observes: Object.fromEntries(ts.observes.map((o) => [o.testId, o.observes])),
    carry_over: { entries: co.entries },
    rejected_test_ids: [],
    non_requirements: co.non_requirements ?? [],
    ledger: { on: cp.versions?.flags?.ledger === true },
  };
}

const t2CountsOf = (record) => (isObj(record.test_spec) ? Object.fromEntries(["tests", "dropped_tests", "coverage_units"].map((k) => [k, isInt(record.test_spec[k]) ? record.test_spec[k] : null])) : null);

/** 予定の本ごとに、状態と（評価できる本は）文脈を決める。(b) の照合に落ちる本は mismatch と理由（評価しない・分母に残す） */
async function prepareRuns(dir, { cond, evalSet }, ref, dist) {
  const inputs = new Map(cond.params.stage_inputs.filter(isObj).map((x) => [x.id, x]));
  const runs = [];
  for (const { id } of cond.child_args) {
    const [, pid, r] = RUN_ID.exec(id);
    const row = { run: id, pattern: pid, iteration: Number(r), state: null, reason: null, stage_pass: null, t2: null, context: null, plan: null };
    runs.push(row);
    const si = inputs.get(id);
    if (si?.absent === true) { row.state = "input-absent"; continue; }
    const runDir = join(dir, id), bundle = join(runDir, "bundle");
    const record = readJsonOr(join(bundle, dist.recordFile), null);
    if (!isObj(record)) { row.state = "missing"; continue; }
    const mismatch = (reason) => { row.state = "mismatch"; row.reason = reason; };
    if (!sameJson(record.range, U2_RANGE)) { mismatch("range"); continue; }
    if (!isObj(si) || !isStr(si.output_digest) || !isObj(record.input) || record.input.output_digest !== si.output_digest) { mismatch("input"); continue; }
    const adopted = cond.frozen.adopted.find((a) => isObj(a) && a.pattern === pid);
    const item = evalSet.byId.get(pid);
    const plan = item === undefined ? null : await planOfRun(dist, runDir, adopted, item.requestText);
    if (plan === null || record.plan_sha256 !== plan.planSha256) { mismatch("plan"); continue; }
    row.stage_pass = record.stage_pass === true;
    row.t2 = t2CountsOf(record);
    if (!row.stage_pass) { row.state = "stage-failed"; continue; }
    const declared = Array.isArray(record.checkpoints) ? record.checkpoints.find((c) => isObj(c) && c.boundary === dist.boundary && c.path === dist.checkpointFile) : undefined;
    const cp = readJsonOr(join(bundle, dist.checkpointFile), null);
    if (!isObj(declared) || !isObj(cp) || !isObj(cp.name_table) || !isObj(cp.carry_over) || !isObj(cp.test_spec) || !Array.isArray(cp.test_spec.observes)) { mismatch("checkpoint"); continue; }
    if ((await dist.entry.stageOutputDigest(cp)) !== declared.output_digest) { mismatch("digest"); continue; }
    if (cp.plan_sha256 !== plan.planSha256) { mismatch("plan"); continue; }
    const decl = ref.byPattern.get(pid);
    if (decl !== undefined && cp.name_table.table_sha256 !== decl.entry.table_sha256) { mismatch("table"); continue; }
    if (decl === undefined) { row.state = "no-reference"; continue; }
    // 文脈の形を手 5b と同じ検査で先に確かめる（不正ならこの本だけ mismatch・context。計測全体を断らない）
    try { row.context = contextOf(dist, cp, plan.plan); checkContext(row.context); } catch { row.context = null; mismatch("context"); continue; }
    row.state = "evaluated";
  }
  return runs;
}

// ── 手 5a と手 5b
const walkJs = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "__tests__" ? [] : walkJs(p)) : n.endsWith(".js") && !n.endsWith(".test.js") ? [p] : []; }).sort() : []);
const fileRef = (p) => ({ path: p, sha256: sha256(readFileSync(p)) });
/** 手 5b の目録の版（工場と spec-engine の dist のファイルの一覧と SHA・ほかの依存・採点のエンジン） */
function versionOf(repo, cond) {
  const pkg = (n) => join(repo, "packages", n);
  return {
    factory_commit: isStr(cond.source?.commit) ? cond.source.commit : "unknown",
    factory_dist: { entry: join(pkg("factory"), "dist/index.js"), files: walkJs(join(pkg("factory"), "dist")).map(fileRef) },
    spec_engine_dist: { entry: join(pkg("spec-engine"), "dist/index.js"), files: walkJs(join(pkg("spec-engine"), "dist")).map(fileRef) },
    dependency_files: [...walkJs(join(pkg("appspec-schema"), "dist")), ...["factory", "spec-engine", "appspec-schema"].map((n) => join(pkg(n), "package.json")).filter((p) => existsSync(p))].map(fileRef),
    scoring_engine: fileRef(scoringEngineFile),
  };
}

/** 書くファイル（出力先の下の相対パス → バイト列）を足す口 */
function writer(outDir) {
  const written = [];
  const put = (rel, bytes) => { const p = join(outDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); written.push(rel); return { path: rel, abs: p, sha256: sha256(bytes) }; };
  return { put, written };
}
const jsonBytes = (v) => Buffer.from(JSON.stringify(v, null, 1) + "\n");

/** P ごとに 1 回、参照の宣言の手 5a の分類を作る（原本の SHA で引く。印は参照の宣言の組の印） */
async function classifyPatterns(repo, patterns, ref, evalSet, w) {
  const out = new Map();
  for (const pid of patterns) {
    const d = ref.byPattern.get(pid), item = evalSet.byId.get(pid), def = evalSet.definitions.get(item.subject);
    const marks = d.marks === null ? null : JSON.parse(d.marks.bytes.toString("utf8"));
    const result = await classifyMutations({ engineFile: join(repo, "packages/spec-engine/dist/index.js"), scoringEngineFile, origins: [{ id: pid, source: d.declaration.bytes.toString("utf8"), def: JSON.parse(readFileSync(def.path, "utf8")) }], marks });
    out.set(pid, { file: w.put(`mutants/${pid}.json`, jsonBytes(result)), subject: fileRef(def.path), declaration: d.declaration, marks: d.marks });
  }
  return out;
}

const rateOf = (k, n) => makeRate(k, n, n === 0 ? "denominator-zero" : null);
/** 本の行から、手 5b の結果の要約（候補の状態・件数・率） */
const candidateOf = (c) => ({
  status: c.status, eligible: c.summary.eligible, by_category: c.summary.by_category,
  detection: { primary: c.summary.detection.primary, secondary: c.summary.detection.secondary },
  uncatchable: c.summary.uncatchable ?? null,
});
const mean = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 1e6) / 1e6);

/** 群の集計：P ごとの合算と、P を単位にした平均と bootstrap の区間、予定を分母にした件数 */
export function aggregateGroup(rows) {
  const scored = rows.filter((r) => r.candidate?.status === "aligned");
  const sumOf = (rs, pick) => rs.reduce((a, r) => { const x = pick(r); return { k: a.k + x.k, n: a.n + x.n }; }, { k: 0, n: 0 });
  const prim = (r) => r.candidate.detection.primary, sec = (r) => r.candidate.detection.secondary, unc = (r) => r.candidate.uncatchable?.rate ?? { k: 0, n: 0 };
  const patterns = [...new Set(rows.map((r) => r.pattern))];
  const byP = patterns.map((pid) => {
    const rs = rows.filter((r) => r.pattern === pid), ss = scored.filter((r) => r.pattern === pid);
    const p = sumOf(ss, prim), s = sumOf(ss, sec), u = sumOf(ss, unc);
    return {
      pattern: pid, planned: rs.length, scored: ss.length,
      primary: makeRate(p.k, p.n, "no-eligible-mutants"), secondary: makeRate(s.k, s.n, "no-eligible-mutants"), uncatchable: makeRate(u.k, u.n, "no-tests-with-eligible-mutants"),
      by_run: rs.map((r) => ({ run: r.run, state: r.state, status: r.candidate?.status ?? null, primary: r.candidate === null ? null : prim(r).rate, uncatchable: r.candidate?.uncatchable?.rate.rate ?? null })),
    };
  });
  const count = (f) => rows.filter(f).length;
  const status = (s) => count((r) => r.candidate?.status === s);
  const runs = {
    planned: rows.length,
    input_absent: count((r) => r.state === "input-absent"),
    missing: count((r) => r.state === "missing"),
    mismatch: count((r) => r.state === "mismatch"),
    mismatch_reasons: Object.fromEntries(MISMATCH_REASONS.map((m) => [m, count((r) => r.state === "mismatch" && r.reason === m)])),
    observed: count((r) => !["input-absent", "missing", "mismatch"].includes(r.state)),
    stage_passed: count((r) => r.stage_pass === true && r.state !== "mismatch"),
    stage_failed: count((r) => r.state === "stage-failed"),
    no_reference: count((r) => r.state === "no-reference"),
    origin_unusable: status("origin-unusable"),
    test_origin_mismatch: status("test-origin-mismatch"),
    no_eligible: count((r) => r.candidate?.status === "aligned" && r.candidate.eligible === 0),
    scored: count((r) => r.candidate?.status === "aligned" && r.candidate.eligible > 0),
  };
  const groupRate = (key) => {
    const byPattern = Object.fromEntries(byP.filter((g) => g[key].rate !== null).map((g) => [g.pattern, [g[key].rate]]));
    return { p_with_rate: Object.keys(byPattern).length, p_without_rate: byP.length - Object.keys(byPattern).length, mean_over_p: mean(Object.values(byPattern).map((x) => x[0])), interval: patternInterval(byPattern) };
  };
  const p = sumOf(scored, prim), s = sumOf(scored, sec), u = sumOf(scored, unc);
  return {
    runs,
    stage_pass: rateOf(runs.stage_passed, runs.planned),
    pooled_reference: { primary: makeRate(p.k, p.n, "no-eligible-mutants"), secondary: makeRate(s.k, s.n, "no-eligible-mutants"), uncatchable: makeRate(u.k, u.n, "no-tests-with-eligible-mutants") },
    by_p_mean: { primary: groupRate("primary"), secondary: groupRate("secondary"), uncatchable: groupRate("uncatchable") },
    by_p: byP,
  };
}

/** 1 つの計測の出力先を採点する（(a) は呼ぶ前に済ませる）。w は出力先への書き込み、prefix は群の下のパス */
async function scoreGroup(repo, dir, measured, ref, dist, w, prefix, classified) {
  const rows = await prepareRuns(dir, measured, ref, dist);
  const evaluated = rows.filter((r) => r.state === "evaluated");
  const patterns = [...new Set(evaluated.map((r) => r.pattern))].filter((pid) => !classified.has(pid));
  for (const [pid, v] of await classifyPatterns(repo, patterns, ref, measured.evalSet, w)) classified.set(pid, v);
  const candidates = evaluated.map((r) => {
    const c = classified.get(r.pattern), ctx = w.put(`${prefix}contexts/${r.run}.json`, jsonBytes(r.context));
    r.files = { context: { path: ctx.path, sha256: ctx.sha256 } };
    return {
      id: r.run, p: r.pattern, iteration: r.iteration,
      subject: c.subject, origin: { path: c.declaration.path, sha256: c.declaration.sha256 }, mutants: { path: c.file.abs, sha256: c.file.sha256, origin_id: r.pattern },
      marks: c.marks === null ? null : { path: c.marks.path, sha256: c.marks.sha256 }, context: { path: ctx.abs, sha256: ctx.sha256 },
    };
  });
  let mutation = null, inventoryFile = null;
  if (candidates.length > 0) {
    const inventory = { schema: INVENTORY_SCHEMA, version: versionOf(repo, measured.cond), candidates };
    inventoryFile = w.put(`${prefix}inventory.json`, jsonBytes(inventory));
    mutation = await scoreMutants({ inventory, baseDir: dirname(inventoryFile.abs) });
    for (const c of mutation.candidates) rows.find((r) => r.run === c.id).candidate = candidateOf(c);
  }
  const outRows = rows.map(({ context: _c, plan: _p, ...r }) => ({ ...r, candidate: r.candidate ?? null, files: r.files ?? null }));
  return {
    measurement: { measurement_id: typeof measured.cond.measurement_id === "string" ? measured.cond.measurement_id : null, conditions_sha256: measured.conditionsSha256, range: U2_RANGE },
    fingerprints: { inventory: inventoryFile === null ? null : { path: inventoryFile.path, sha256: inventoryFile.sha256 }, mutation: mutation === null ? null : mutation.fingerprints },
    rows: outRows,
    group: { ...aggregateGroup(outRows), by_operator: mutation === null ? {} : mutation.by_operator, totals: mutation === null ? null : anonymousMutation(mutation).totals },
  };
}

const referenceSummary = (ref) => ({ id: ref.set.id, version: ref.set.version, rule: ref.set.rule, sha256: ref.sha256, frozen_set: ref.set.frozen_set, declarations: ref.set.declarations.map((d) => ({ pattern: d.pattern, origin: d.origin, table_sha256: d.table_sha256 })), missing: ref.set.missing });

/** 対の比較：同じ P・同じ回の本を対にし、主の検出率と落とせない試験の率の差（after − before）と P のまとまり。片側が評価できない対は除いて理由ごとに数える */
export function comparePairs(pairs, before, after) {
  const rowOf = (g, id) => g.rows.find((r) => r.run === id) ?? null;
  const reasonOf = (r) => (r === null ? "unlaunched" : r.state === "input-absent" ? "unlaunched" : r.state === "evaluated" ? (r.candidate?.status !== "aligned" ? "not-aligned" : null) : r.state);
  const excluded = Object.fromEntries(PAIR_EXCLUSIONS.map((x) => [x, 0]));
  const metrics = { primary: (r) => r.candidate.detection.primary.rate, uncatchable: (r) => r.candidate.uncatchable?.rate.rate ?? null };
  const out = {};
  for (const [key, pick] of Object.entries(metrics)) {
    const ex = { ...excluded }, rows = [], byPattern = {};
    for (const p of pairs) {
      const id = `${p.pid}-r${p.r}`, b = rowOf(before, id), a = rowOf(after, id);
      let reason = reasonOf(b) ?? reasonOf(a);
      const vb = reason === null ? pick(b) : null, va = reason === null ? pick(a) : null;
      if (reason === null && (vb === null || va === null)) reason = "no-eligible";
      if (reason !== null) { ex[reason] += 1; rows.push({ run: id, diff: null, reason }); continue; }
      const diff = Math.round((va - vb) * 1e6) / 1e6;
      rows.push({ run: id, diff, reason: null });
      (byPattern[p.pid] ??= []).push(diff);
    }
    const diffs = rows.filter((x) => x.diff !== null).map((x) => x.diff);
    out[key] = { n: diffs.length, mean: mean(diffs), excluded: ex, clusters: clusterStats(byPattern), rows };
  }
  return { direction: "after − before（同じ P・同じ回の本の対ごと）", ...out };
}

/** 比較の記録（段だけの対の比較）を読む。群のディレクトリと対の写しの SHA を照らす（合わなければ断る） */
function loadComparison(dir) {
  const rec = readJsonOr(join(dir, COMPARISON_FILE), null);
  if (!isObj(rec) || rec.schema !== STAGE_COMPARISON_SCHEMA || !isObj(rec.pairs) || !isObj(rec.groups)) refuse("stage-tests:compare-record");
  const { signature, ...rest } = rec;
  if (signature !== sha256(JSON.stringify(rest))) refuse("stage-tests:compare-record");
  let bytes;
  try { bytes = readFileSync(join(dir, COMPARE_PAIRS_COPY)); } catch { refuse("stage-tests:compare-record"); }
  const pairs = readJsonOr(join(dir, COMPARE_PAIRS_COPY), null);
  if (sha256(bytes) !== rec.pairs.sha256 || pairsShapeProblem(pairs, { schema: STAGE_PAIRS_SCHEMA, groups: STAGE_COMPARE_GROUPS }) !== null) refuse("stage-tests:compare-record");
  for (const g of STAGE_COMPARE_GROUPS) if (!existsSync(join(dir, g))) refuse("stage-tests:compare-record");
  return { pairs: pairs.pairs, sha256: rec.pairs.sha256, groups: rec.groups };
}

/**
 * 比較の記録と各群の条件を結ぶ（書き込みの前）：群の条件の対の SHA が比較の記録の対の写しと同じ・群と役割・記録の conditions_signature が群の条件の署名と同じ・
 * 対の本が群の予定のうち入力のある本とちょうど一致（対を黙って消さない）。合わなければ断る
 */
function checkComparisonGroups(comparison, measured) {
  const keys = comparison.pairs.map((p) => `${p.pid}-r${p.r}`);
  for (const g of STAGE_COMPARE_GROUPS) {
    const { cond } = measured.get(g), c = cond.comparison, recorded = comparison.groups[g];
    if (!isObj(c) || c.pairs_sha256 !== comparison.sha256 || c.group !== g || c.role !== STAGE_COMPARE_ROLES[g]) refuse("stage-tests:compare-group");
    if (!isObj(recorded) || recorded.conditions_signature !== cond.signature) refuse("stage-tests:compare-group");
    const absent = new Set(cond.params.stage_inputs.filter((x) => isObj(x) && x.absent === true).map((x) => x.id));
    const launched = cond.child_args.map((x) => x.id).filter((id) => !absent.has(id));
    if (launched.length !== keys.length || !launched.every((id) => keys.includes(id))) refuse("stage-tests:compare-group");
  }
}

/**
 * 採点する。断るときは StageTestsError（符号だけ）を投げ、出力先に何も残さない。戻り：出力（JSON の値）
 *   repo … 計測の checkout（工場と spec-engine の dist・定義ファイル）　measureDir … U2 の計測の出力先（compare なら比較の記録の出力先）
 *   referenceDir … 参照の宣言の組のディレクトリ　outDir … 文脈・目録・手 5a の出力を書く出力先（空か無いこと）
 */
export async function scoreStageTests({ repo, measureDir, referenceDir, outDir, compare = false }) {
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) refuse("stage-tests:out-not-empty");
  const ref = loadReferenceSet(referenceDir);
  if (ref.status !== "ok") refuse(`stage-tests:reference-${ref.status}`);
  // (a) 計測全体：比較では両群の条件を照らす（dist の指紋は今の checkout ＝ after の群の条件と照らし、両群とも同じ評価口で評価する）
  const groups = compare ? STAGE_COMPARE_GROUPS : [null];
  const comparison = compare ? loadComparison(measureDir) : null;
  const measured = new Map(groups.map((g) => [g, checkMeasurement(g === null ? measureDir : join(measureDir, g), ref, repo, { distCheck: g === null || g === STAGE_COMPARE_GROUPS[1] })]));
  if (compare) checkComparisonGroups(comparison, measured);
  const dist = await loadStageDist(repo);
  if (dist === null) refuse("stage-tests:dist-unreadable");
  const created = !existsSync(outDir);
  mkdirSync(outDir, { recursive: true });
  const w = writer(outDir), classified = new Map();
  try {
    const scored = {};
    for (const g of groups) scored[g ?? "single"] = await scoreGroup(repo, g === null ? measureDir : join(measureDir, g), measured.get(g), ref, dist, w, g === null ? "" : `${g}/`, classified);
    const files = { mutants: [...classified.entries()].map(([pid, c]) => ({ pattern: pid, path: c.file.path, sha256: c.file.sha256 })) };
    const head = { definitions: DEFINITIONS, fingerprints: { tool: toolFingerprint(), reference_sha256: ref.sha256, frozen_set: ref.set.frozen_set, files }, reference: referenceSummary(ref) };
    if (!compare) return { schema: OUTPUT_SCHEMA, ...head, ...scored.single, fingerprints: { ...head.fingerprints, ...scored.single.fingerprints } };
    const [b, a] = STAGE_COMPARE_GROUPS;
    return { schema: COMPARE_SCHEMA, ...head, groups: { [b]: scored[b], [a]: scored[a] }, pairs: comparePairs(comparison.pairs, scored[b], scored[a]) };
  } catch (e) {
    if (created) rmSync(outDir, { recursive: true, force: true });
    else for (const rel of w.written) rmSync(join(outDir, rel), { force: true });
    if (e instanceof MutationToolError) refuse(`stage-tests:mutation:${e.code}`);
    throw e;
  }
}

// ── 匿名の口：件数・率・区間・演算子の ID だけ（P の番号・本の ID・宣言の名前・パス・SHA を出さない）
const anonRate = (r) => ({ k: r.k, n: r.n, rate: r.rate, wilson95_reference: r.wilson95_reference, reason_code: r.reason_code });
const anonInterval = (c) => ({ m: c.m, mean: c.mean, bootstrap: { interval: c.bootstrap.interval, resamples: c.bootstrap.resamples, seed: c.bootstrap.seed, reason: c.bootstrap.reason }, t_reference: { df: c.t_reference.df, interval: c.t_reference.interval, reason: c.t_reference.reason }, ...(c.sign_flip ? { sign_flip: { p: c.sign_flip.p, permutations: c.sign_flip.permutations, reason: c.sign_flip.reason } } : {}) });
const anonGroup = (x) => {
  const g = x.group;
  return {
    runs: g.runs, stage_pass: anonRate(g.stage_pass),
    pooled_reference: Object.fromEntries(Object.entries(g.pooled_reference).map(([k, r]) => [k, anonRate(r)])),
    by_p_mean: Object.fromEntries(Object.entries(g.by_p_mean).map(([k, v]) => [k, { p_with_rate: v.p_with_rate, p_without_rate: v.p_without_rate, mean_over_p: v.mean_over_p, interval: anonInterval(v.interval) }])),
    // P ごとの率は名前を付けずに並べる
    by_p: g.by_p.map((p) => ({ planned: p.planned, scored: p.scored, primary: anonRate(p.primary), secondary: anonRate(p.secondary), uncatchable: anonRate(p.uncatchable) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    totals: g.totals, by_operator: Object.fromEntries(Object.entries(g.by_operator).map(([k, s]) => [k, { mutants: s.mutants, eligible: s.eligible, by_category: s.by_category, detection: { primary: anonRate(s.detection.primary), secondary: anonRate(s.detection.secondary) } }])),
  };
};
export function toAnonymous(out) {
  const head = { schema: ANONYMOUS_SCHEMA, anonymous: true, definitions: out.definitions, reference: { declarations: out.reference.declarations.length, missing: Object.fromEntries(REFERENCE_MISSING.map((m) => [m, out.reference.missing.filter((x) => x.reason === m).length])) } };
  if (out.schema === OUTPUT_SCHEMA) return { ...head, mode: "single", group: anonGroup(out) };
  const pairs = Object.fromEntries(["primary", "uncatchable"].map((k) => [k, { n: out.pairs[k].n, mean: out.pairs[k].mean, excluded: out.pairs[k].excluded, clusters: anonInterval(out.pairs[k].clusters) }]));
  return { ...head, mode: "compare", groups: Object.fromEntries(Object.entries(out.groups).map(([g, x]) => [g, anonGroup(x)])), pairs: { direction: out.pairs.direction, ...pairs } };
}

const pct = (r) => (r.rate === null ? `なし（${r.reason_code}）` : `${r.k}/${r.n}（${(r.rate * 100).toFixed(1)}%）`);
const range2 = (x) => (x === null ? "-" : `${x[0].toFixed(3)}〜${x[1].toFixed(3)}`);
const groupLine = (label, x) => {
  const g = x.group, r = g.runs;
  return `${label}U2 試験（変異。門ではない・段の通過は納品の成功ではない）: 予定 ${r.planned}・入力なし ${r.input_absent}・欠測 ${r.missing}・mismatch ${r.mismatch}・段を通らない ${r.stage_failed}・参照の宣言なし ${r.no_reference}・原本不適 ${r.origin_unusable}・試験と原本が合わない ${r.test_origin_mismatch}・適格な変異 0 ${r.no_eligible}・評価 ${r.scored}\n`
    + `${label}主の検出率（P の平均。条件付き）: ${g.by_p_mean.primary.mean_over_p ?? "-"}（m ${g.by_p_mean.primary.interval.m}・bootstrap ${range2(g.by_p_mean.primary.interval.bootstrap.interval)}）・合算 ${pct(g.pooled_reference.primary)}・落とせない試験の率（P の平均）: ${g.by_p_mean.uncatchable.mean_over_p ?? "-"}・合算 ${pct(g.pooled_reference.uncatchable)}`;
};
/** 標準出力の要約（P の番号・本の ID を含まない） */
export function summaryLines(out) {
  if (out.schema === OUTPUT_SCHEMA) return [groupLine("", out)];
  const p = out.pairs;
  return [...Object.entries(out.groups).map(([g, x]) => groupLine(`[${g}] `, x)), `対の差（after − before）: 主の検出率 n ${p.primary.n}・平均 ${p.primary.mean ?? "-"}・落とせない試験の率 n ${p.uncatchable.n}・平均 ${p.uncatchable.mean ?? "-"}・除いた ${Object.entries(p.primary.excluded).map(([k, v]) => `${k} ${v}`).join("・")}`];
}

// ── 入口
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
const refuseExit = (code) => { console.error(refusalLine(code)); process.exit(EXIT_REFUSED); };
if (isEntry()) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === "--make-reference") {
    const [, referenceOut, upstreamDir, dest] = args;
    if ([referenceOut, upstreamDir, dest].some((x) => x === undefined || x.startsWith("--"))) refuseExit("make-reference:args");
    const versionText = opt("--version");
    let used = false;
    try { used = existsSync(dest) && readdirSync(dest).length > 0; } catch { used = true; }
    if (used) refuseExit("make-reference:out-not-empty");
    const r = makeReferenceSet({ referenceOut: resolve(referenceOut), upstreamDir: resolve(upstreamDir), id: opt("--id"), version: versionText !== undefined && /^\d+$/.test(versionText) ? Number(versionText) : NaN });
    if (r.code !== undefined) refuseExit(r.code);
    // 写す宣言が 0 件（全部 missing）でも、出力先を作って理由つきの組を保存する
    mkdirSync(dest, { recursive: true });
    for (const c of r.copies) { mkdirSync(dirname(join(dest, c.rel)), { recursive: true }); writeFileSync(join(dest, c.rel), c.bytes); }
    const bytes = referenceBytes(r.set);
    writeFileSync(join(dest, REFERENCE_SET_FILE), bytes);
    console.log(`参照の宣言の組を作りました: 宣言 ${r.set.declarations.length} P、無い ${r.set.missing.length} P、組の SHA-256 ${sha256(bytes)}`);
  } else {
    const flags = new Set(["--compare", "--anonymous"]);
    const pos = args.filter((a) => !flags.has(a));
    if (pos.length !== 4 || pos.some((x) => x.startsWith("--"))) refuseExit("stage-tests:args");
    const [repo, measureDir, referenceDir, outDir] = pos.map((x) => resolve(x));
    const compare = args.includes("--compare");
    let out;
    try { out = await scoreStageTests({ repo, measureDir, referenceDir, outDir, compare }); } catch (e) { if (e instanceof StageTestsError) refuseExit(e.code); throw e; }
    const file = compare ? COMPARE_FILE : OUTPUT_FILE;
    writeFileSync(join(outDir, file), JSON.stringify(out, null, 2) + "\n");
    if (args.includes("--anonymous")) writeFileSync(join(outDir, anonymousFileOf(file)), JSON.stringify(toAnonymous(out), null, 2) + "\n");
    console.log(summaryLines(out).join("\n"));
  }
}
