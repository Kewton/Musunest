// 試験の点検（v1.2 手 5b。#554）。手 5a（mutate.mjs・classify.mjs）が作って分類した変異体に、凍結した候補の固定した試験を、
// 工場の B3（名前の照合）・B4（試験の評価）と同じ評価口と、工場が使ったのと同じ有効な評価の文脈で掛け、条件付きの検出率と落とせない試験の率を出す。
// 計測の道具であって工場の門ではない：工場・門・合否を変えず、工場の package を import せず、工場の段からも呼ばれない。
// API・LLM・判定・通信・時計を使わない（費用 0）。B3'・判定は呼ばない。
//
// 入力は目録（凍結した候補・有効な評価の文脈・版）だけ。道具は目録に載ったファイル（と自分のコード）だけを読み、読む前に SHA-256 を全部照らす。
// 1 つでも合わなければ何も数えずに断る（終了コード 3・固定の符号。fail-closed）。工場と spec-engine は build 済みの dist を目録の場所から動的に読む。
// 動的に読む前に、2 つの入口から import の閉包（静的な import・export … from・文字列の import()。bare の指定子は node_modules の
// package.json の exports で解く。各 .js の形を決める最寄りの package.json も入れる）を、目録に載ったファイルだけを読んで求める。
// 閉包のファイルが 1 つでも目録に無い・SHA-256 が合わなければ、評価の前に断る（前段の早い断り）。正は実際の読み込み：resolve・load の hook が、
// Node が読むファイルを目録（と道具のコード・組み込み）に限り、読んだ原文の SHA-256 を照らす（下の「読み込みの hook」）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLASS_IDS, OUTPUT_SCHEMA as CLASSIFY_OUTPUT_SCHEMA, loadMarks } from "./classify.mjs";
import { MutationToolError, OPERATOR_IDS, sha256 } from "./mutate.mjs";

export const INVENTORY_SCHEMA = "musunest-eval/mutation-score-inventory/v1";
export const CONTEXT_SCHEMA = "musunest-eval/mutation-score-context/v1";
export const OUTPUT_SCHEMA = "musunest-eval/mutation-test-score/v1";
export const EXIT_REFUSED = 3;

/** 変異ごとの結果（排他的。1 つの変異は 1 つにだけ入る）。上から：手 5a の分類で外れるもの → この道具の評価の結果 */
export const CATEGORIES = [
  { id: "origin-unusable", in_eligible: false, meaning: "原本が使えない（手 5a の分類。その原本の変異は全部ここ）" },
  { id: "test-origin-mismatch", in_eligible: false, meaning: "試験と原本が合わない（原本に B3 の落ち・B4 の不一致・未解決がある）。その候補の変異は全部ここで、分母の外" },
  { id: "static-fail", in_eligible: false, meaning: "変異が静的チェックに落ちる（門が断つ）" },
  { id: "discrepancy", in_eligible: false, meaning: "外の採点・正規化の結果・人の印が食い違う" },
  { id: "syntactic-equivalent", in_eligible: false, meaning: "構文の同値（app.spec が原本と深く等しい）" },
  { id: "equivalent-marked", in_eligible: false, meaning: "同値（人の印）" },
  { id: "undecidable", in_eligible: false, meaning: "判定不能（同値とも非同値とも推測しない）" },
  { id: "test-fail", in_eligible: true, meaning: "試験で落ちる（B4 の不一致が 1 件以上）" },
  { id: "binding-fail", in_eligible: true, meaning: "結び付けで落ちる（B3 の落ちがあり、B4 の不一致は 0）" },
  { id: "unresolved-only", in_eligible: true, meaning: "未解決だけ（B3 の落ちも B4 の不一致も 0 で、B4 の未解決が 1 件以上）" },
  { id: "survived", in_eligible: true, meaning: "生き残る（B3 の落ち・B4 の不一致・未解決がどれも 0）" },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const ELIGIBLE = CATEGORIES.filter((c) => c.in_eligible).map((c) => c.id);
/** 分類の割合の分母に入るもの：原本が使え、試験と原本が合う候補の、静的チェックを通った変異の全部 */
const CLASSIFIED = ["discrepancy", "syntactic-equivalent", "equivalent-marked", "undecidable", ...ELIGIBLE];

export const DEFINITIONS = {
  eligible_rule: "適格な変異＝原本が使え（手 5a）・試験と原本が合い・静的チェックを通り・非同値（確定）の変異。主の検出率の分母・副の検出率の分母・落とせない試験の率の分母にこの集合以外を入れない（判定不能・同値・食い違いを入れない）",
  primary_rate: "主の検出率＝試験で落ちる ÷ 適格な変異",
  secondary_rate: "副の検出率＝（試験で落ちる ＋ 結び付けで落ちる）÷ 適格な変異",
  uncatchable_rule: "落とせない試験＝対象の要件の適格な変異（変えた場所が、その試験の対象の行に当たる。同じ要件の別の行は当たらない）が 1 つ以上あるのに、1 つも落とさない試験。率＝落とせない試験 ÷ 適格な変異を対象に持つ試験",
  conditional_note: "検出率は適格な変異に限る条件付きの率である。判定不能を除く選別のため、外の採点で差の出やすい変異に偏る。変異の全体の検出率ではない",
  classification_denominator: "分類の割合の分母＝原本が使え、試験と原本が合う候補の、静的チェックを通った変異の全部（構文の同値・食い違い・判定不能を含む）。検出率とは別の欄",
  interval_rule: "Wilson の 95% 区間は「参考（独立を仮定）」。変異は同じ原本・同じ試験で相関するので、区間は一般化の根拠にならない。一般化の区間は出さず、候補ごと・P ごとの率とまとまりの数を並べる。率はこの凍結した集合の記述に限る",
  zero_denominator: "分母 0 は 0% にせず、率と区間を null にして理由の符号を付ける",
  gate_note: "計測の道具であって工場の門ではない。工場の合否・門・検証の定義に入らない。費用 0（API・判定を呼ばない）",
};

/** 断る固定文（入力の値は文に入れない）。符号 → 文 */
export const MESSAGES = {
  invalid_inventory: "目録は schema・版・候補の一覧（題材の定義・原本・手 5a の出力・文脈のファイルの場所と SHA-256）を持つ形で書く",
  invalid_context: "文脈のファイルは schema と、名前の表・要件の一覧・試験の組・所属・除く行・観測する性質・持ち越し・棄却した試験・要件でない文・台帳の旗を持つ形で書く",
  invalid_file: "目録のファイルが読めない、または JSON として読めない",
  hash_mismatch: "目録のファイルの SHA-256 が申告の値と一致しない（何も数えずに断る）",
  entry_unlisted: "dist の入口のファイルが、目録のファイルの一覧に載っていない",
  dependency_unlisted: "dist の入口から import で読むファイル（依存）が、目録のファイルの一覧に載っていない（評価の前に断る）",
  dependency_unresolved: "dist の入口から import で読む指定子を、目録の package.json で解けない（評価の前に断る）",
  invalid_output: "手 5a の出力の schema・形が知らない値である",
  origin_missing: "目録の原本が、手 5a の出力に無い",
  origin_sha_mismatch: "手 5a の出力に書かれた原本の SHA-256 が、目録の原本と一致しない",
  subject_sha_mismatch: "手 5a の出力に書かれた題材の定義の SHA-256 が、目録の題材の定義と一致しない",
  marks_mismatch: "手 5a の出力に書かれた印の指紋が、目録の印のファイルと一致しない",
  mutant_sha_mismatch: "変異の原文の SHA-256 が、手 5a の出力の値と一致しない（評価の前に断る）",
  context_inconsistent: "文脈が食い違う（有効な試験の組に棄却した試験がある・一覧に持ち越しの要件か要件でない文がある）",
  origin_unreadable: "手 5a が使えるとした原本を spec-engine が読めない",
  mutant_unreadable: "手 5a が静的チェックを通ったとした変異を spec-engine が読めない",
  invalid_input: "使い方: node score-mutants.mjs <目録の JSON のファイル> --out <出力の JSON のファイル> [--anonymous]",
  output_check_failed: "出力の検算（変異の結果の件数の和）が通らない",
};
const refuse = (code) => {
  throw new MutationToolError(code, MESSAGES[code]);
};

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v !== "";
const isSha = (v) => typeof v === "string" && HEX64.test(v);
const isFileRef = (v) => isObj(v) && isStr(v.path) && isSha(v.sha256);
const bytesSha = (buf) => createHash("sha256").update(buf).digest("hex");

const here = dirname(fileURLToPath(import.meta.url));
const toolFingerprint = () => sha256(["mutate.mjs", "classify.mjs", "score-mutants.mjs"].map((n) => `${n}\n${sha256(readFileSync(join(here, n), "utf8"))}\n`).join(""));

// ── Wilson の 95% 区間（参考。独立を仮定）と率
const wilson = (k, n) => {
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
};
export const WILSON_NAME = "参考（独立を仮定）";
/** 率：分母 0 は 0% にせず rate・区間を null にして理由の符号を付ける */
export function makeRate(k, n, zeroReason) {
  if (n === 0) return { k, n, rate: null, wilson95_reference: null, reason_code: zeroReason };
  return { k, n, rate: k / n, wilson95_reference: { name: WILSON_NAME, ...wilson(k, n) }, reason_code: null };
}

const emptyCategories = () => Object.fromEntries(CATEGORY_IDS.map((c) => [c, 0]));

/**
 * 変異の結果の記録（{ category, … }）と試験の記録（{ eligible_mutants, killed }。省略可）から、件数と率を出す（純粋な関数）。
 * 検出率の分母は適格な変異だけ。分類の割合の分母は CLASSIFIED。
 */
export function summarizeRecords(mutants, tests = null) {
  const by = emptyCategories();
  for (const m of mutants) by[m.category] += 1;
  const eligible = ELIGIBLE.reduce((a, c) => a + by[c], 0);
  const classified = CLASSIFIED.reduce((a, c) => a + by[c], 0);
  const out = {
    mutants: mutants.length,
    by_category: by,
    eligible,
    detection: {
      denominator: "eligible",
      primary: makeRate(by["test-fail"], eligible, "no-eligible-mutants"),
      secondary: makeRate(by["test-fail"] + by["binding-fail"], eligible, "no-eligible-mutants"),
    },
    classification: {
      denominator: "classified",
      classified,
      equivalent: makeRate(by["syntactic-equivalent"] + by["equivalent-marked"], classified, "no-classified-mutants"),
      syntactic_equivalent: makeRate(by["syntactic-equivalent"], classified, "no-classified-mutants"),
      equivalent_marked: makeRate(by["equivalent-marked"], classified, "no-classified-mutants"),
      discrepancy: makeRate(by.discrepancy, classified, "no-classified-mutants"),
      undecidable: makeRate(by.undecidable, classified, "no-classified-mutants"),
      non_equivalent: makeRate(eligible, classified, "no-classified-mutants"),
    },
  };
  if (tests) {
    const targeted = tests.filter((t) => t.eligible_mutants >= 1);
    out.uncatchable = { tests: tests.length, with_eligible_mutants: targeted.length, rate: makeRate(targeted.filter((t) => t.killed === 0).length, targeted.length, "no-tests-with-eligible-mutants") };
  }
  return out;
}

// ── 目録と文脈の検証
function checkInventory(inv) {
  if (!isObj(inv) || inv.schema !== INVENTORY_SCHEMA || !isObj(inv.version) || !Array.isArray(inv.candidates) || inv.candidates.length === 0) refuse("invalid_inventory");
  const v = inv.version;
  const dist = (d) => isObj(d) && isStr(d.entry) && Array.isArray(d.files) && d.files.length > 0 && d.files.every(isFileRef);
  if (!isStr(v.factory_commit) || !dist(v.factory_dist) || !dist(v.spec_engine_dist) || !isFileRef(v.scoring_engine)) refuse("invalid_inventory");
  if (v.dependency_files !== undefined && !(Array.isArray(v.dependency_files) && v.dependency_files.every(isFileRef))) refuse("invalid_inventory");
  for (const d of [v.factory_dist, v.spec_engine_dist]) if (!d.files.some((f) => f.path === d.entry)) refuse("entry_unlisted");
  const ids = new Set();
  for (const c of inv.candidates) {
    if (!isObj(c) || !isStr(c.id) || ids.has(c.id) || !(isStr(c.p) || Number.isInteger(c.p)) || !Number.isInteger(c.iteration)) refuse("invalid_inventory");
    ids.add(c.id);
    if (!isFileRef(c.subject) || !isFileRef(c.origin) || !isFileRef(c.context) || !isObj(c.mutants) || !isFileRef(c.mutants) || !isStr(c.mutants.origin_id)) refuse("invalid_inventory");
    if (c.marks !== undefined && c.marks !== null && !isFileRef(c.marks)) refuse("invalid_inventory");
  }
}

const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function checkContext(ctx) {
  const ok = isObj(ctx) && ctx.schema === CONTEXT_SCHEMA
    && isObj(ctx.table) && Array.isArray(ctx.table.rows) && Array.isArray(ctx.table.ownership)
    && isObj(ctx.list) && Array.isArray(ctx.list.requirements)
    && isObj(ctx.suite) && Array.isArray(ctx.suite.tests)
    && Array.isArray(ctx.ownership)
    && strList(ctx.excluded_row_ids)
    && isObj(ctx.observes) && Object.values(ctx.observes).every((x) => typeof x === "string")
    && isObj(ctx.carry_over) && Array.isArray(ctx.carry_over.entries) && ctx.carry_over.entries.every((e) => isObj(e) && isStr(e.requirementId))
    && strList(ctx.rejected_test_ids)
    && strList(ctx.non_requirements)
    && isObj(ctx.ledger) && typeof ctx.ledger.on === "boolean";
  if (!ok) refuse("invalid_context");
  const reqIds = new Set(ctx.list.requirements.map((r) => r.id));
  if (ctx.suite.tests.some((t) => ctx.rejected_test_ids.includes(t.id))) refuse("context_inconsistent");
  if (ctx.non_requirements.some((id) => reqIds.has(id)) || ctx.carry_over.entries.some((e) => reqIds.has(e.requirementId))) refuse("context_inconsistent");
}

// ── 変異の場所（place）→ 名前の表の行
/** 変えた場所が当たる表の行の id（検査は表に行が無いので空）。除く行は含めない */
export function rowsOfPlace(place, table, excluded = []) {
  const skip = new Set(excluded);
  const byId = new Map(table.rows.map((r) => [r.id, r]));
  const head = place.replace(/\(.*$/, "");
  const parts = head.split(".");
  const pick = (kind, name, entityName = null) => table.rows
    .filter((r) => r.kind === kind && r.name === name && !skip.has(r.id) && (entityName === null || byId.get(r.entity)?.name === entityName))
    .map((r) => r.id);
  if (parts[0] === "actions" && parts.length >= 2) return pick("operation", parts[1]);
  if (parts[0] === "computed" && parts.length >= 2) return pick("computation", parts[1]);
  if (parts[0] === "validations") return [];
  if (parts.length >= 2) return pick("field", parts[1], parts[0]);
  return [];
}

const outcomeOf = (r) => ({
  misses: r.correspondence.misses.length,
  mismatches: r.testRun.mismatches.length,
  unresolved: r.testRun.unresolved.length,
});
const outcomesById = (suite, r) => {
  const bad = new Set(r.testRun.mismatches.map((x) => x.testId)), unres = new Set(r.testRun.unresolved.map((x) => x.testId));
  return Object.fromEntries(suite.tests.map((t) => [t.id, bad.has(t.id) ? "mismatch" : unres.has(t.id) ? "unresolved" : "match"]));
};

const importDist = (d, base) => import(pathToFileURL(resolve(base, d.entry)).href);

// ── 読み込みの hook（実際の読み込みで止める。#571 の再レビューの指摘）
// 静的な閉包は指定子の書き方（注釈を挟む import など）で取りこぼし得るので、前段の早い断りにとどめる。正は Node の読み込みそのもの：
// resolve・load の hook で、file: のファイルは目録に載ったもの（load では Node が読んだ原文の SHA-256 が目録と合うもの）か道具のコードだけを通し、
// node: の組み込みは通し、それ以外（目録に無いファイル・data: など）は断る。ESM はグラフの全部を読み終えてから評価するので、静的な import の
// 断りはどのモジュールの評価よりも前に起きる。評価の途中の import() も同じ hook を通る（断れば出力を作らない）。
// hook は data: の URL で登録し、道具の外にファイルを足さない。hook はプロセスに残るので、同じプロセスで 2 回目以降に呼ぶと前の hook も
// 重なるが、hook は呼び出しごとの見張りの窓（共有の旗）が開いている間だけ働く。すでに読み込まれたモジュールは読み直されないので、
// 凍結の保証は新しいプロセス（入口）で得る。
const LOAD_REFUSED = "musunest-mutation-load-refused";
const OWN_FILES = ["score-mutants.mjs", "classify.mjs", "mutate.mjs"];
const HOOK_SOURCE = [
  'import { createHash } from "node:crypto";',
  "let allowed = new Map(), own = new Set(), marker = \"\", active = null;",
  "export async function initialize(data) { allowed = new Map(Object.entries(data.allowed)); own = new Set(data.own); marker = data.marker; active = new Int32Array(data.active); }",
  "const on = () => Atomics.load(active, 0) === 1;",
  "const deny = (code) => { throw new Error(marker + \":\" + code); };",
  "const known = (url) => url.startsWith(\"node:\") || own.has(url) || allowed.has(url);",
  "export async function resolve(specifier, context, next) { const r = await next(specifier, context); if (on() && !known(r.url)) deny(\"dependency_unlisted\"); return r; }",
  "export async function load(url, context, next) {",
  "  if (!on() || url.startsWith(\"node:\") || own.has(url)) return next(url, context);",
  "  const want = allowed.get(url);",
  "  if (want === undefined) deny(\"dependency_unlisted\");",
  "  const r = await next(url, context);",
  "  if (r.source === null || r.source === undefined) deny(\"dependency_unlisted\");",
  "  const got = createHash(\"sha256\").update(typeof r.source === \"string\" ? Buffer.from(r.source, \"utf8\") : Buffer.from(r.source)).digest(\"hex\");",
  "  if (got !== want) deny(\"hash_mismatch\");",
  "  return r;",
  "}",
].join("\n");
/** hook を登録し、見張りの窓を開け閉めする口を返す（窓の外では hook は何もしない。同じプロセスで道具を呼んだあとの import を妨げない） */
function installLoadGuard(allowed) {
  const active = new SharedArrayBuffer(4), flag = new Int32Array(active);
  // 道具のコードと、hook 自身の data: の URL（同じプロセスで重ねて登録するとき、前の hook を通って読まれる）は通す
  const hookUrl = `data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`;
  const own = [...OWN_FILES.map((n) => pathToFileURL(realpathSync(join(here, n))).href), hookUrl];
  register(hookUrl, { data: { allowed, own, marker: LOAD_REFUSED, active } });
  return { open: () => Atomics.store(flag, 0, 1), close: () => Atomics.store(flag, 0, 0) };
}
/** 見張りの窓を開けて fn を走らせ、hook の断り（印の付いた誤り）を固定の符号の断りに直す。それ以外の誤りはそのまま投げる */
async function guardLoads(guard, fn) {
  guard.open();
  try {
    return await fn();
  } catch (e) {
    const m = new RegExp(`${LOAD_REFUSED}:([a-z_]+)`).exec(String(e?.message ?? ""));
    if (m && Object.hasOwn(MESSAGES, m[1])) refuse(m[1]);
    throw e;
  } finally {
    guard.close();
  }
}

// ── import の閉包（Node が入口から読むファイル）
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^;'"`]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
/** モジュールの原文から指定子（静的な import・export … from・副作用の import・文字列の import()）を取る。注釈の中の例も拾う（多めに取る側に倒す） */
export function specifiersIn(text) {
  const out = new Set();
  for (const re of SPECIFIER_PATTERNS) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}
const CONDITIONS = ["node", "import", "default"];
const pickTarget = (v) => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length > 0 ? pickTarget(v[0]) : null;
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (CONDITIONS.includes(k)) { const r = pickTarget(x); if (r !== null) return r; }
  return null;
};
/** package.json の exports（無ければ main）から、副パス（"." か "./…"）の行き先を引く。引けなければ null */
function exportTarget(pkg, sub) {
  let ex = pkg.exports;
  if (ex === undefined) return sub === "." ? (typeof pkg.main === "string" ? pkg.main : "index.js") : sub;
  if (typeof ex === "string" || Array.isArray(ex) || (isObj(ex) && !Object.keys(ex).some((k) => k.startsWith(".")))) ex = { ".": ex };
  return isObj(ex) && Object.hasOwn(ex, sub) ? pickTarget(ex[sub]) : null;
}
const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
/** ファイルの最寄りの package.json（Node が .js の形を決めるのに読む）。無ければ null */
function nearestPackageJson(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) return realOf(pj);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * 入口（実パス）から import の閉包を求める。read(実パス) は内容（Buffer）を返す（目録の照合つきの読み取りを渡す）。
 * 返り値は閉包のファイルの実パス（.js と package.json。名前の昇順）。解けない指定子は dependency_unresolved で断る。
 */
export function dependencyClosure(entries, read) {
  const seen = new Set(), queue = [...entries];
  const add = (p) => { if (!seen.has(p)) { seen.add(p); queue.push(p); } };
  const json = (p) => { try { return JSON.parse(read(p).toString("utf8")); } catch (e) { if (e instanceof MutationToolError) throw e; return refuse("dependency_unresolved"); } };
  for (const e of entries) seen.add(e);
  while (queue.length > 0) {
    const file = queue.shift();
    const buf = read(file);
    if (file.endsWith("package.json")) continue;
    const pj = nearestPackageJson(file);
    if (pj !== null) add(pj);
    for (const spec of specifiersIn(buf.toString("utf8"))) {
      if (spec.startsWith("node:")) continue; // 接頭辞の無い組み込みの名前は解けず断る（fail-closed）
      let target = null;
      if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) target = realOf(resolve(dirname(file), spec));
      else if (spec.startsWith("file:")) target = realOf(fileURLToPath(spec));
      else {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        for (let dir = dirname(file); ; dir = dirname(dir)) {
          const pkgJson = realOf(join(dir, "node_modules", name, "package.json"));
          if (pkgJson !== null) {
            add(pkgJson);
            const to = exportTarget(json(pkgJson), `.${spec.slice(name.length)}`);
            target = to === null ? null : realOf(resolve(dirname(pkgJson), to));
            break;
          }
          if (dirname(dir) === dir) break;
        }
      }
      if (target === null) refuse("dependency_unresolved");
      add(target);
    }
  }
  return [...seen].sort();
}

/**
 * 試験を変異に掛ける。
 *   inventory … 目録（オブジェクト）　baseDir … 目録のパスの基準（既定は cwd）　readFile … ファイルの読み取り（試験で差し替える。既定は readFileSync。Buffer を返す）
 */
export async function scoreMutants({ inventory, baseDir = process.cwd(), readFile = (p) => readFileSync(p) }) {
  checkInventory(inventory);
  const at = (p) => realOf(resolve(baseDir, p)) ?? resolve(baseDir, p);
  const cache = new Map();
  /** 目録に載ったファイルを読み、SHA-256 を照らす（同じファイルは 1 度だけ。実パスで見分ける） */
  const readChecked = (ref) => {
    const key = at(ref.path);
    if (!cache.has(key)) {
      let buf;
      try { buf = readFile(key); } catch { refuse("invalid_file"); }
      cache.set(key, buf);
    }
    const buf = cache.get(key);
    if (bytesSha(buf) !== ref.sha256) refuse("hash_mismatch");
    return buf;
  };
  const parse = (buf) => { try { return JSON.parse(buf.toString("utf8")); } catch { return refuse("invalid_file"); } };
  const v = inventory.version;

  // 1. 読む前に SHA-256 を全部照らす（版・候補のファイル）。dist の入口からの import の閉包は、目録に載ったファイルだけで求める
  const depFiles = [...v.factory_dist.files, ...v.spec_engine_dist.files, ...(v.dependency_files ?? [])];
  for (const f of [...depFiles, v.scoring_engine]) readChecked(f);
  const listed = new Map(depFiles.map((f) => [at(f.path), f]));
  const closure = dependencyClosure([at(v.factory_dist.entry), at(v.spec_engine_dist.entry)], (p) => {
    const ref = listed.get(p);
    if (!ref) refuse("dependency_unlisted");
    return readChecked(ref);
  });
  const loaded = inventory.candidates.map((c) => {
    const subject = readChecked(c.subject), origin = readChecked(c.origin), mutantsBuf = readChecked(c.mutants), ctxBuf = readChecked(c.context);
    const marksBuf = c.marks ? readChecked(c.marks) : null;
    return { c, subject, origin, mutantsBuf, ctxBuf, marksBuf };
  });

  // 2. 形・相互の照合（手 5a の出力の原本・題材・印・変異の原文）
  const prepared = loaded.map(({ c, subject, origin, mutantsBuf, ctxBuf, marksBuf }) => {
    const out = parse(mutantsBuf);
    if (!isObj(out) || out.schema !== CLASSIFY_OUTPUT_SCHEMA || !Array.isArray(out.origins) || !Array.isArray(out.mutants) || !isObj(out.fingerprints)) refuse("invalid_output");
    const rec = out.origins.find((o) => isObj(o) && o.id === c.mutants.origin_id);
    if (!rec) refuse("origin_missing");
    if (rec.sha256 !== bytesSha(origin)) refuse("origin_sha_mismatch");
    if (rec.subject_sha256 !== sha256(JSON.stringify(parse(subject)))) refuse("subject_sha_mismatch");
    const marksJson = marksBuf ? loadMarks(parse(marksBuf)) : loadMarks(null);
    if (out.fingerprints.marks !== sha256(JSON.stringify(marksJson))) refuse("marks_mismatch");
    const mutants = out.mutants.filter((m) => m.origin_id === rec.id);
    for (const m of mutants) {
      if (!isObj(m) || typeof m.source !== "string" || sha256(m.source) !== m.sha256 || !CLASS_IDS.includes(m.class) || !isStr(m.operator)) refuse("mutant_sha_mismatch");
    }
    const ctx = parse(ctxBuf);
    checkContext(ctx);
    return { c, rec, mutants, ctx, originSource: origin.toString("utf8") };
  });

  // 3. 評価（工場の build 済みの評価口を、凍結した文脈で作る）。読み込みの hook を入れてから dist を import し、
  //    Node が実際に読むファイルが目録に載ったもの（SHA-256 が合う）か道具のコード・組み込みであることを、読み込みのたびに確かめる
  const guard = installLoadGuard(Object.fromEntries(depFiles.map((f) => [pathToFileURL(at(f.path)).href, f.sha256])));
  const candidates = await guardLoads(guard, async () => {
    const factory = await importDist(v.factory_dist, baseDir), engine = await importDist(v.spec_engine_dist, baseDir);
    const candidates = [];
    for (const { c, rec, mutants, ctx, originSource } of prepared) {
      const evaluator = factory.createV11aEvaluator({ table: ctx.table, excludedRowIds: ctx.excluded_row_ids, observes: new Map(Object.entries(ctx.observes)) });
      const context = { list: ctx.list, suite: ctx.suite, correspondences: ctx.correspondences ?? [], ownership: ctx.ownership };
      const evaluate = async (source, unreadable) => {
        const n = await engine.normalizeSpec(source);
        if (!n.ok) return refuse(unreadable);
        const r = await evaluator.evaluate(n.app, { source }, context);
        return { ...outcomeOf(r), outcomes: outcomesById(ctx.suite, r) };
      };
      let status = "aligned", originRun = null;
      if (!rec.usable) status = "origin-unusable";
      else {
        originRun = await evaluate(originSource, "origin_unreadable");
        if (originRun.misses + originRun.mismatches + originRun.unresolved > 0) status = "test-origin-mismatch";
      }
      const tests = ctx.suite.tests.map((t) => ({ id: t.id, requirement_id: t.target.requirementId, target_role_id: t.target.roleId ?? null, eligible_mutants: 0, killed: 0 }));
      const records = [];
      for (const m of mutants) {
        let category, run = null;
        if (status === "origin-unusable") category = "origin-unusable";
        else if (status === "test-origin-mismatch") category = "test-origin-mismatch";
        else if (m.class !== "non-equivalent") category = m.class;
        else {
          run = await evaluate(m.source, "mutant_unreadable");
          category = run.mismatches > 0 ? "test-fail" : run.misses > 0 ? "binding-fail" : run.unresolved > 0 ? "unresolved-only" : "survived";
          const rows = new Set(rowsOfPlace(m.place, ctx.table, ctx.excluded_row_ids));
          tests.forEach((t, i) => {
            // 変えた場所が、試験の対象の行（target.roleId）に当たるときだけ（同じ要件の別の行は当たらない）
            if (t.target_role_id !== null && rows.has(t.target_role_id)) {
              t.eligible_mutants += 1;
              if (run.outcomes[ctx.suite.tests[i].id] === "mismatch") t.killed += 1;
            }
          });
        }
        records.push({
          id: m.id, operator: m.operator, place: m.place, sha256: m.sha256, class: m.class, category,
          misses: run?.misses ?? null, mismatches: run?.mismatches ?? null, unresolved: run?.unresolved ?? null, outcomes: run?.outcomes ?? null,
        });
      }
      const evaluated = status === "aligned";
      candidates.push({
        id: c.id, p: String(c.p), iteration: c.iteration, origin_id: rec.id, subject_id: rec.subject_id ?? null,
        status, origin_run: originRun,
        generation: { not_built: rec.generation?.not_built ?? 0, truncated: rec.generation?.truncated ?? 0 },
        context: { ledger_on: ctx.ledger.on, tests: ctx.suite.tests.length, carry_over: ctx.carry_over.entries.length, rejected_tests: ctx.rejected_test_ids.length, non_requirements: ctx.non_requirements.length, excluded_rows: ctx.excluded_row_ids.length },
        summary: summarizeRecords(records, evaluated ? tests : []),
        tests: evaluated ? tests.map((t) => ({ ...t, uncatchable: t.eligible_mutants >= 1 && t.killed === 0 })) : [],
        mutants: records,
      });
    }

    return candidates;
  });
  // 4. 集計
  const allMutants = candidates.flatMap((c) => c.mutants);
  const allTests = candidates.flatMap((c) => c.tests);
  const totals = summarizeRecords(allMutants, allTests);
  const byOperator = Object.fromEntries(OPERATOR_IDS.filter((op) => allMutants.some((m) => m.operator === op)).map((op) => [op, summarizeRecords(allMutants.filter((m) => m.operator === op))]));
  const pGroups = [...new Set(candidates.map((c) => c.p))].sort();
  const byP = pGroups.map((p) => {
    const cs = candidates.filter((c) => c.p === p);
    return { p, candidates: cs.length, ...summarizeRecords(cs.flatMap((c) => c.mutants), cs.flatMap((c) => c.tests)) };
  });
  const result = {
    schema: OUTPUT_SCHEMA,
    definitions: { categories: CATEGORIES, ...DEFINITIONS, wilson_name: WILSON_NAME },
    fingerprints: {
      tool: toolFingerprint(),
      factory_commit: v.factory_commit,
      factory_dist: sha256(v.factory_dist.files.map((f) => `${f.path}\n${f.sha256}\n`).join("")),
      spec_engine_dist: sha256(v.spec_engine_dist.files.map((f) => `${f.path}\n${f.sha256}\n`).join("")),
      dependency_files: sha256(closure.map((p) => `${listed.get(p).sha256}\n`).join("")),
      dependency_count: closure.length,
      scoring_engine: v.scoring_engine.sha256,
      inventory: sha256(JSON.stringify(inventory)),
    },
    clusters: { candidates: candidates.length, p_groups: pGroups.length, p_groups_with_eligible: byP.filter((g) => g.eligible > 0).length },
    totals,
    separate: {
      syntactic_equivalent: totals.by_category["syntactic-equivalent"],
      equivalent_marked: totals.by_category["equivalent-marked"],
      discrepancy: totals.by_category.discrepancy,
      undecidable: totals.by_category.undecidable,
      static_fail: totals.by_category["static-fail"],
      origin_unusable: totals.by_category["origin-unusable"],
      test_origin_mismatch: totals.by_category["test-origin-mismatch"],
      unresolved_only: totals.by_category["unresolved-only"],
      not_built: candidates.reduce((a, c) => a + c.generation.not_built, 0),
      truncated: candidates.reduce((a, c) => a + c.generation.truncated, 0),
    },
    by_operator: byOperator,
    by_p: byP,
    candidates,
  };
  if (!verifyOutput(result)) refuse("output_check_failed");
  return result;
}

/** 出力の検算：変異の結果の件数の和が変異の数と等しく、候補ごとの和が全体と等しい */
export function verifyOutput(out) {
  const sum = (by) => Object.values(by).reduce((a, b) => a + b, 0);
  return sum(out.totals.by_category) === out.totals.mutants
    && out.candidates.reduce((a, c) => a + c.summary.mutants, 0) === out.totals.mutants
    && out.candidates.every((c) => sum(c.summary.by_category) === c.mutants.length);
}

const rateView = (r) => ({ k: r.k, n: r.n, rate: r.rate, wilson95_reference: r.wilson95_reference, reason_code: r.reason_code });
const anonSummary = (s) => ({
  mutants: s.mutants, by_category: s.by_category, eligible: s.eligible,
  detection: { denominator: s.detection.denominator, primary: rateView(s.detection.primary), secondary: rateView(s.detection.secondary) },
  classification: Object.fromEntries(Object.entries(s.classification).map(([k, x]) => [k, typeof x === "object" ? rateView(x) : x])),
  ...(s.uncatchable ? { uncatchable: { tests: s.uncatchable.tests, with_eligible_mutants: s.uncatchable.with_eligible_mutants, rate: rateView(s.uncatchable.rate) } } : {}),
});

/** 匿名の口：件数・率・演算子の ID だけ（P の番号・候補の ID・宣言の名前・パス・SHA-256 を出さない。指紋も出さない） */
export function toAnonymous(out) {
  const { categories, ...rules } = out.definitions;
  return {
    schema: out.schema,
    anonymous: true,
    definitions: { categories: categories.map(({ id, in_eligible, meaning }) => ({ id, in_eligible, meaning })), ...rules },
    clusters: out.clusters,
    totals: anonSummary(out.totals),
    separate: out.separate,
    by_operator: Object.fromEntries(Object.entries(out.by_operator).map(([k, s]) => [k, anonSummary(s)])),
    // 候補ごと・P ごとの率は、名前を付けずに率の昇順で並べる
    by_candidate: out.candidates.map((c) => ({ status: c.status, ...anonSummary(c.summary) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    by_p: out.by_p.map(({ p: _p, ...rest }) => anonSummary(rest)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

const pct = (r) => (r.rate === null ? `なし（${r.reason_code}）` : `${r.k}/${r.n}（${(r.rate * 100).toFixed(1)}%・区間 ${(r.wilson95_reference.low * 100).toFixed(1)}〜${(r.wilson95_reference.high * 100).toFixed(1)}% ${WILSON_NAME}）`);

/** 標準出力の要約（P の番号・候補の ID を含まない） */
export function summaryLines(out) {
  const t = out.totals, s = out.separate;
  return [
    `試験の点検（変異。門ではない）: 候補 ${out.clusters.candidates}・P のまとまり ${out.clusters.p_groups}（適格あり ${out.clusters.p_groups_with_eligible}）・変異 ${t.mutants}・適格 ${t.eligible}`,
    `主の検出率（試験で落ちる ÷ 適格。条件付き）: ${pct(t.detection.primary)}`,
    `副の検出率（試験＋結び付けで落ちる ÷ 適格。条件付き）: ${pct(t.detection.secondary)}`,
    `落とせない試験の率: ${t.uncatchable ? pct(t.uncatchable.rate) : "なし"}`,
    `分類の割合（分母 ${t.classification.classified}）: 同値 ${pct(t.classification.equivalent)}・判定不能 ${pct(t.classification.undecidable)}・食い違い ${pct(t.classification.discrepancy)}`,
    `別に数える: 同値（構文）${s.syntactic_equivalent}・同値（印）${s.equivalent_marked}・食い違い ${s.discrepancy}・判定不能 ${s.undecidable}・静的に落ちる ${s.static_fail}・作れなかった ${s.not_built}・原本不適 ${s.origin_unusable}・試験と原本が合わない ${s.test_origin_mismatch}・未解決だけ ${s.unresolved_only}`,
  ];
}

// ── 利用の入口（node score-mutants.mjs <目録> --out <出力> [--anonymous]。import したときは何も起きない）
// MutationToolError は「符号 固定文」の 1 行を標準エラーに出して exit 3。何も数えず、出力のファイルも書かない
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) {
  try {
    const args = process.argv.slice(2);
    const anonymous = args.includes("--anonymous");
    const outAt = args.indexOf("--out");
    const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
    if (!file || outAt < 0 || !args[outAt + 1]) refuse("invalid_input");
    let inventory;
    try { inventory = JSON.parse(readFileSync(file, "utf8")); } catch { refuse("invalid_file"); }
    const out = await scoreMutants({ inventory, baseDir: dirname(resolve(file)) });
    writeFileSync(args[outAt + 1], `${JSON.stringify(anonymous ? toAnonymous(out) : out, null, 2)}\n`);
    process.stdout.write(`${summaryLines(out).join("\n")}\n`);
  } catch (e) {
    if (!(e instanceof MutationToolError)) throw e;
    process.stderr.write(`${e.code} ${e.message}\n`);
    process.exitCode = EXIT_REFUSED;
  }
}
