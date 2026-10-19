// 表の採点（v1.2 表の採点 1。#606）。工場の受理済みの表（納品物の名前の表）と段の走りの checkpoint の表（境界 t1-t2 の name_table）を、
// 正解の表（要件単位・別解つき。採点担当が作る。非公開で git の外）と照らし、要件ごとの 3 問（欠け・過剰・確かめ方）を 0／1 で出す。
// 計測の道具であって工場の門ではない：工場の package を import せず、工場の段からも呼ばれない。LLM・判定・API・通信・時計を使わない（費用 0）。
// P のまとまりの区間（bootstrap・t 区間）・符号反転の p・対の差の集計は、評価の下の既存の道具（score-agent.mjs）の関数を import して使う（写さない）。
// 2 本目（#607）：T1' が断った候補の下書き（読取元 (c)。本ごとに最後の候補だけ）を同じ採点の関数で採点し、C3（T1''）の判定を同じ正解と照らした
// 正誤表（見逃し・誤拒否。二値の要件だけ）を足す。1 本目の欄は変えず、出力の後ろに足す。
//
// 段単位の走り（#639。条件 v6・v8 で params.mode が stage-run）：予定の本は child_args、凍結した組は frozen のまま読む。入力なしの本（stage_input_absent）は表なしと分けて数え（分母 (b) には残す）、
//   読取元ごとの本の数・条件のファイルの SHA-256（fingerprint.conditions_sha256）を足す。段単位でない計測の出力は変えない。
//
// 使い方: node score-table.mjs <正解のディレクトリ> <計測の出力先（--compare なら比較の記録の出力先）> <出力先> [--compare] [--anonymous]
// 断る（終了コード 3・固定の符号の 1 行・出力を書かない）：引数・正解の版と形・凍結した組の ID と版・plan_sha256（条件のファイル・本の記録）・比較の記録
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterStats, isStageConditions, pairStats, stageAbsentOf, stagePipelineOf } from "../agent-accept/score-agent.mjs";

export const GOLD_VERSION = "table-gold-v1";
export const OUTPUT_SCHEMA = "musunest-eval/table-score/v1";
export const COMPARE_SCHEMA = "musunest-eval/table-score-compare/v1";
export const ANONYMOUS_SCHEMA = "musunest-eval/table-score-anonymous/v1";
export const OUTPUT_FILE = "table-score.json";
export const COMPARE_FILE = "table-score-compare.json";
export const anonymousFileOf = (file) => file.replace(/\.json$/, ".anonymous.json");
export const EXIT_REFUSED = 3;

/** 読取元（観測の単位は本。1 本に表 1 つ）：(a) 受理済みの表、(b) 段の走りの checkpoint（境界 t1-t2）。本のディレクトリからの場所 */
export const SOURCES = ["accepted", "checkpoint"];
export const SOURCE_PATHS = { accepted: "bundle/artifacts/name-table.json", checkpoint: "bundle/stage-checkpoint-t1-t2.json" };
/** plan_sha256 を照らす本の記録（納品物の build の記録。checkpoint は読取元の (b) と同じファイル） */
export const BUILD_RECORD_PATH = "bundle/build-record.json";
export const CONDITIONS_FILE = "conditions.json";
/** 読取元 (c)：T1' が断った候補の下書き（診断の記録。#607）。(a)・(b) と混ぜない */
export const DRAFT_SOURCE = "draft";
export const DRAFT_PATH = "bundle/diagnostics/rejected-name-table.json";
/** 読めない候補の理由：記録のファイルが読めない・形が違う／一覧が無い／応答が表の形でない（形の失敗）／一覧と要件の数が合わない */
export const DRAFT_UNREADABLE = ["file", "no-list", "shape", "count-mismatch"];
/** 下書きの行の type（欄を平らに持つ写像）のうち、行の種類ごとに使う欄 */
export const DRAFT_TYPE_KEYS = { entity: [], field: ["fieldType"], computation: ["valueType", "scope", "form", "aggregate"], operation: ["action", "hasWhen"], screen: ["view"] };
/** C3 の点検の記録の場所（受理済みの表は成果物の semantic-check の記録、checkpoint は同じファイルの semantic_check） */
export const SEMANTIC_RECORD_PATHS = { accepted: "bundle/artifacts/semantic-check.json", checkpoint: "bundle/stage-checkpoint-t1-t2.json" };
export const C3_VERDICTS = ["accept", "reject"];
/** 拒否の種類の既知の値（件数だけ出す。ほかの値は unknown に数える） */
export const C3_REJECTION_KINDS = ["unnecessary-ownership", "missing-target", "weak-verification"];
/** 正誤表に入れない非二値（件数だけ） */
export const C3_NON_BINARY = ["carry-over", "accepted-removal", "held"];
/** 点検の記録なしの理由：記録が無い／読めない・形が違う／表の SHA の合う回が無い */
export const C3_NO_RECORD = ["absent", "unreadable", "no-matching-round"];
export const COMPARISON_FILE = "comparison.json";

/** 要件の結果の 5 値。二値（率と差に使う）は正答・誤りだけ */
export const OUTCOMES = ["correct", "wrong", "carry-over", "accepted-removal", "held"];
export const BINARY_OUTCOMES = ["correct", "wrong"];
/** 保留の理由：静的（正解だけで決まる）と候補依存 */
export const HOLD_REASONS = { static: ["needs-human"], candidate: ["unassignable-row", "alternative-unselectable", "search-limit"] };
/** 印（0／1 に入れない注記） */
export const MARKS = ["semantics-unverified", "related", "overclaim"];
/** unresolved の reason_kind の扱い */
export const UNRESOLVED_REASON_KINDS = { "accepted-removal": "accepted-removal", "unsupported-observation": "carry-over", "deployment-scope": "carry-over" };
/** fixed-test の観測の操作（試験の操作。記号ではない）が適合する行の型（定数の表） */
export const OBSERVATION_FIT = {
  validate: (row) => row.kind === "field" || row.kind === "entity",
  action: (row) => row.kind === "operation" && row.type?.hasWhen === true,
  screen: (row) => row.kind === "screen",
  aggregate: (row) => row.kind === "computation" && row.type?.form === "aggregate",
  compute: (row) => row.kind === "computation" && row.type?.form === "expression",
};
/** 割り当ての探索の上限（節の数と、最良の解の数）。超えた本の表は全要件を保留 */
export const SEARCH_LIMIT = 1000000;
export const SOLUTION_LIMIT = 64;
export const ROW_KINDS = ["entity", "field", "computation", "operation", "screen"];
/** 参照切れ（指す行が無い参照。null ＝ 参照なし と区別する） */
export const BROKEN = "broken";

/** 断る固定の符号 → 文（入力の値・パス・ID は文に入れない） */
export const REFUSALS = {
  "table-score:args": "引数が足りない（正解のディレクトリ・計測の出力先・出力先）",
  "table-score:gold-unreadable": "正解のディレクトリかファイルが読めない、または JSON として読めない",
  "table-score:gold-version": "正解の版が table-gold-v1 でない",
  "table-score:gold-shape": "正解の必須の欄が欠けるか型が違う",
  "table-score:gold-duplicate": "同じ P の正解が 2 つある",
  "table-score:gold-missing": "予定の P の正解が無い",
  "table-score:conditions": "計測の条件のファイルが無い・読めない・予定と凍結した組の形が違う、または段単位の条件の入力なしの本・経路が読めない",
  "table-score:frozen-set": "正解の凍結した組の ID か版が条件のファイルと違う",
  "table-score:plan-sha256-conditions": "正解の plan_sha256 が条件のファイルの凍結した組の値と違う",
  "table-score:plan-sha256-run": "本の記録の plan_sha256 が正解と違う、または表のある本に plan_sha256 の記録が無い",
  "table-score:table-unreadable": "表のファイルが読めないか形が違う",
  "table-score:compare-record": "比較の記録が無い・読めない・群の形が違う",
};
export class TableScoreError extends Error {
  constructor(code) { super(REFUSALS[code] ?? code); this.code = code; }
}
const refuse = (code) => { throw new TableScoreError(code); };

/** 分母・率・区間の定義（出力に添える文） */
export const DEFINITIONS = {
  binary_rule: "率と差に使うのは二値（正答・誤り）の要件だけ。正直な持ち越し・了承除外・保留は分子にも分母 (a) にも入れない",
  denominator_a: "分母 (a)＝表のある本の二値の要件数",
  denominator_b: "分母 (b)＝予定の本 ×（その P の要件数 − 静的な保留の数）。観測に依らない。未観測（表なしの本）と候補依存の非二値は分母に残し分子に入れない（正答の下限）",
  zero_denominator: "分母 0 は 0 と出し、率と区間は null にして理由の符号を付ける",
  interval_rule: "区間は P を単位にする（P ごとに二値の要件の 0／1 を平均し、bootstrap の区間と参考の t 区間。m < 2 は null と理由）。単独群では符号反転の p を出さない。Wilson の 95% は参考（独立を仮定）で、P の区間の代用にしない",
  source_rule: "読取元ごとに出し、混ぜない。1 本に両方あれば受理済みの表を採り、checkpoint は件数だけ",
  gate_note: "計測の道具であって工場の門ではない。費用 0（LLM・判定・API を呼ばない）。正解の文は写さない",
  draft_rule: "読取元 (c)＝T1' が断った候補の下書き。本ごとに最後の候補（round・attempt・call が最大）1 つだけを採点し、別の候補を合併しない。最後の候補が読めなければ採点せず、古い候補に戻らない。表の SHA は null",
  denominator_a_prime: "分母 (a')＝下書きを採点した本の二値の要件数（(a) と混ぜない）",
  denominator_b_prime: "分母 (b')＝予定の本 ×（その P の要件数 − 静的な保留の数）（(b) と混ぜない）",
  c3_rule: "C3 の正誤表は二値（正答・誤り）の要件だけ。表と表の SHA が一致する点検の回に結ぶ。見逃しの率＝誤りのうち受理 ÷ 誤り、誤拒否の率＝正答のうち拒否 ÷ 正答。持ち越し・了承除外・保留は件数だけ。点検の引用・拒否の理由の文は写さない。Wilson は参考（独立を仮定）。--compare では群ごとに出し、対の差は取らない",
};
export const WILSON_NAME = "参考（独立を仮定）";
const ZERO_REASON = "denominator-zero";

// ── 小道具
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x !== "";
const isStrList = (x) => Array.isArray(x) && x.every(isStr);
const isHex64 = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const present = (x) => x !== undefined && x !== null && x !== false;
const opt = (x) => (x === undefined ? null : x);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const PATTERN = /^P\d+$/;
const RUN_ID = /^(P\d+)-r(\d+)$/;

// ── 正解の検証（fail-closed。任意の欄は無ければ null と同じで、無いだけで断らない）と、採点の内部の形への写し
// 現物の形（table-gold-v1）：最上位 plan_set・components[]（entity・refEntity・groupBy・options の配列）・requirements[]（variants[]・
// adjudication_status・unexpressible・verification_limit）・needs_human[]。文の欄（meaning_quote・rationale・question など）は読まない
const OPTIONAL_STR = (x) => x === undefined || x === null || typeof x === "string";
const OPTIONAL_STR_LIST = (x) => x === undefined || x === null || isStrList(x);
const OPTIONAL_OBJ = (x) => x === undefined || x === null || isObj(x);
const OPTIONAL_LIST = (x) => x === undefined || x === null || Array.isArray(x);
/** unexpressible.scope の形（"<設計族>-family-only"）。この形以外は断る */
export const UNEXPRESSIBLE_SCOPE = /^(.+)-family-only$/;
function checkComponent(c) {
  if (!isObj(c) || !isStr(c.symbol) || !ROW_KINDS.includes(c.kind)) return false;
  if (!("type" in c) || !OPTIONAL_STR(c.entity) || !OPTIONAL_STR(c.refEntity)) return false;
  if (!(c.groupBy === undefined || c.groupBy === null || (isObj(c.groupBy) && isStr(c.groupBy.kind) && isStr(c.groupBy.field)))) return false;
  if (!(c.options === undefined || c.options === null || (Array.isArray(c.options) && c.options.every((o) => isObj(o) && isStr(o.symbol))))) return false;
  return OPTIONAL_OBJ(c.semantics) && OPTIONAL_STR(c.design_family);
}
function checkVerificationItem(v) {
  if (!isObj(v) || !isStr(v.kind)) return false;
  if (!OPTIONAL_STR_LIST(v.checks)) return false;
  if (!(v.assertions === undefined || v.assertions === null || (Array.isArray(v.assertions) && v.assertions.every((a) => isObj(a) && isStr(a.check) && isStr(a.target) && OPTIONAL_STR(a.expected) && OPTIONAL_STR(a.refEntity))))) return false;
  if (!(v.observations === undefined || v.observations === null || (Array.isArray(v.observations) && v.observations.every((o) => isObj(o) && isStr(o.target) && ROW_KINDS.includes(o.target_kind) && isStr(o.operation))))) return false;
  return OPTIONAL_STR(v.reason_kind);
}
function checkUnexpressible(u) {
  if (u === undefined || u === null) return true;
  if (!isObj(u)) return false;
  return u.scope === undefined || u.scope === null || (typeof u.scope === "string" && UNEXPRESSIBLE_SCOPE.test(u.scope));
}
function checkVariant(a) {
  if (!isObj(a) || !isStr(a.id) || !isStrList(a.required) || !isStrList(a.allowed) || !isStrList(a.context)) return false;
  // 確かめ方は長さ 1 の配列（長さ 1 以外は断る）
  if (!Array.isArray(a.verification) || a.verification.length !== 1 || !checkVerificationItem(a.verification[0])) return false;
  return OPTIONAL_STR(a.design_family) && OPTIONAL_STR_LIST(a.forbidden_components) && OPTIONAL_OBJ(a.entity_field_policy) && checkUnexpressible(a.unexpressible);
}
function checkRequirement(r) {
  if (!isObj(r) || !isStr(r.requirement_id) || !Array.isArray(r.variants) || r.variants.length === 0 || !r.variants.every(checkVariant)) return false;
  return OPTIONAL_STR(r.adjudication_status) && OPTIONAL_OBJ(r.scope) && checkUnexpressible(r.unexpressible) && OPTIONAL_OBJ(r.verification_limit) && OPTIONAL_STR_LIST(r.related_requirement_ids);
}
const checkNeedsHuman = (h) => isObj(h) && isStr(h.requirement_id) && OPTIONAL_STR(h.reason_kind) && OPTIONAL_LIST(h.candidates) && OPTIONAL_STR_LIST(h.related_requirement_ids);
const familyOfScope = (u) => (isObj(u) && typeof u.scope === "string" ? UNEXPRESSIBLE_SCOPE.exec(u.scope)[1] : null);
const componentOf = (c) => ({
  symbol: c.symbol, kind: c.kind, type: c.type, parent_entity: opt(c.entity), ref_entity: opt(c.refEntity),
  group_by: isObj(c.groupBy) ? { kind: c.groupBy.kind, field: c.groupBy.field } : null,
  options_count: Array.isArray(c.options) ? c.options.length : null, semantics: present(c.semantics),
});
const verificationOf = (v) => ({
  kind: v.kind, checks: v.checks ?? null, reason_kind: opt(v.reason_kind),
  assertions: (v.assertions ?? []).map((a) => ({ check: a.check, target: a.target, expected: opt(a.expected), ref_entity: opt(a.refEntity) })),
  observations: (v.observations ?? []).map((o) => ({ target: o.target, target_kind: o.target_kind, operation: o.operation })),
});
const variantOf = (a) => ({
  id: a.id, required: [...a.required], allowed: [...a.allowed], context: [...a.context], verification: verificationOf(a.verification[0]),
  design_family: opt(a.design_family), forbidden_components: [...(a.forbidden_components ?? [])], policy: present(a.entity_field_policy), unexpressible: present(a.unexpressible),
});
/**
 * 正解の 1 P を検証し、採点の内部の形に写す。版が違えば gold-version、必須の欄が欠ける・型が違えば gold-shape。
 * 内部の形：components（parent_entity・ref_entity・group_by・options_count・semantics）、requirements（alternatives＝案。
 * held・unexpressible・unexpressible_family・verification_limit）、needs_human（requirement_id・related_requirement_ids）、plan_set
 */
export function validateGold(g) {
  if (!isObj(g)) refuse("table-score:gold-shape");
  if (g.version !== GOLD_VERSION) refuse("table-score:gold-version");
  if (typeof g.pattern !== "string" || !PATTERN.test(g.pattern)) refuse("table-score:gold-shape");
  if (!isObj(g.plan_set) || !isStr(g.plan_set.id) || !Number.isInteger(g.plan_set.version) || !isHex64(g.plan_set.manifest_sha256)) refuse("table-score:gold-shape");
  if (!isHex64(g.plan_sha256) || !isObj(g.counts) || !Object.values(g.counts).every(Number.isInteger)) refuse("table-score:gold-shape");
  if (!Array.isArray(g.components) || !g.components.every(checkComponent)) refuse("table-score:gold-shape");
  if (!Array.isArray(g.requirements) || !g.requirements.every(checkRequirement)) refuse("table-score:gold-shape");
  if (!Array.isArray(g.needs_human) || !g.needs_human.every(checkNeedsHuman)) refuse("table-score:gold-shape");
  const syms = g.components.map((c) => c.symbol), ids = g.requirements.map((r) => r.requirement_id);
  if (new Set(syms).size !== syms.length || new Set(ids).size !== ids.length) refuse("table-score:gold-shape");
  return {
    pattern: g.pattern, plan_set: { id: g.plan_set.id, version: g.plan_set.version }, plan_sha256: g.plan_sha256,
    components: g.components.map(componentOf),
    requirements: g.requirements.map((r) => ({
      requirement_id: r.requirement_id, alternatives: r.variants.map(variantOf), held: r.adjudication_status === "needs_human",
      unexpressible: present(r.unexpressible), unexpressible_family: familyOfScope(r.unexpressible), verification_limit: present(r.verification_limit),
      related_requirement_ids: [...(r.related_requirement_ids ?? [])],
    })),
    needs_human: g.needs_human.map((h) => ({ requirement_id: h.requirement_id, related_requirement_ids: [...(h.related_requirement_ids ?? [])] })),
  };
}
/** 正解のディレクトリを読む（*.json だけを名前の順に。ほかのファイルは無視。P → 内部の形の正解） */
export function loadGoldDir(dir) {
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { refuse("table-score:gold-unreadable"); }
  if (names.length === 0) refuse("table-score:gold-unreadable");
  const out = new Map();
  for (const n of names) {
    let g;
    try { g = readJson(join(dir, n)); } catch { refuse("table-score:gold-unreadable"); }
    const v = validateGold(g);
    if (out.has(v.pattern)) refuse("table-score:gold-duplicate");
    out.set(v.pattern, v);
  }
  return out;
}

/** 正解の索引（内部の形）：部品（symbol）・要件（requirement_id。P の中で一意）・静的な保留（ID で重複排除）・関連あり */
export function indexGold(g) {
  const comp = new Map(g.components.map((c) => [c.symbol, c]));
  const reqs = new Map(g.requirements.map((r) => [r.requirement_id, r]));
  const held = new Set();
  for (const r of g.requirements) if (r.held) held.add(r.requirement_id);
  for (const h of g.needs_human) held.add(h.requirement_id);
  const related = new Set();
  for (const x of [...g.requirements, ...g.needs_human]) for (const id of x.related_requirement_ids) related.add(id);
  // 要件の全体＝要件の並び ∪ 保留の一覧の ID（ID で重複排除）
  const allIds = [...new Set([...reqs.keys(), ...g.needs_human.map((h) => h.requirement_id)])];
  return { comp, reqs, held, related, allIds };
}

// ── 正規化（読取元 → 採点の構造とメタデータ）
const typeStructure = (kind, type) => {
  if (kind === "entity") return null;
  if (kind === "field") return typeof type === "string" ? type : null;
  if (!isObj(type)) return null;
  if (kind === "computation") return { valueType: opt(type.valueType), scope: opt(type.scope), form: opt(type.form), aggregate: isObj(type.aggregate) ? opt(type.aggregate.kind) : null };
  if (kind === "operation") return { action: opt(type.action), hasWhen: type.hasWhen === true };
  return { view: opt(type.view) };
};
const refIndex = (id, at) => (id === null || id === undefined ? null : at.has(id) ? at.get(id) : BROKEN);
/**
 * 表（rows・ownership・verification）を採点の構造に正規化する。行＝種類・型の構造・options の数・groupBy の種類と、
 * 親 entity・refEntity・groupBy の元・集計元を行の添字へ結び直した参照（無いなら null、指す行が無ければ参照切れ）。
 * 所属＝要件 ID → 行の添字の集合。確かめ方＝要件 ID → 種類・checks・value。id・name・role・source は結び直しのあと落とす
 */
export function normalizeTable(table) {
  if (!isObj(table) || !Array.isArray(table.rows) || !Array.isArray(table.ownership) || !Array.isArray(table.verification)) refuse("table-score:table-unreadable");
  if (!table.rows.every((r) => isObj(r) && isStr(r.id) && ROW_KINDS.includes(r.kind))) refuse("table-score:table-unreadable");
  const at = new Map(table.rows.map((r, i) => [r.id, i]));
  const rows = table.rows.map((r) => ({
    kind: r.kind,
    type: typeStructure(r.kind, r.type),
    options_count: Array.isArray(r.options) ? r.options.length : null,
    group_by_kind: isObj(r.groupBy) ? opt(r.groupBy.kind) : null,
    refs: {
      parent: refIndex(r.entity, at),
      ref_entity: refIndex(r.refEntity, at),
      group_by: isObj(r.groupBy) ? refIndex(r.groupBy.field, at) : null,
      aggregate: r.kind === "computation" && isObj(r.type) && isObj(r.type.aggregate) ? refIndex(r.type.aggregate.entity, at) : null,
    },
  }));
  const ownership = {};
  for (const e of table.ownership) {
    if (!isObj(e) || !isStr(e.requirementId) || !Array.isArray(e.roles)) refuse("table-score:table-unreadable");
    const set = new Set(ownership[e.requirementId] ?? []);
    for (const role of e.roles) if (isObj(role) && at.has(role.id)) set.add(at.get(role.id));
    ownership[e.requirementId] = [...set].sort((a, b) => a - b);
  }
  const verification = {};
  for (const v of table.verification) {
    if (!isObj(v) || !isStr(v.requirementId) || !isStr(v.kind)) refuse("table-score:table-unreadable");
    verification[v.requirementId] = { kind: v.kind, checks: Array.isArray(v.checks) ? [...v.checks] : null, value: opt(v.value) };
  }
  return { rows, ownership, verification };
}
/** 読取元の表を正規化して、採点の構造とメタデータ（表の SHA。無ければ null）を返す */
export function readSource(kind, value) {
  const t = kind === "checkpoint" ? (isObj(value) ? value.name_table : null) : value;
  if (!isObj(t)) refuse("table-score:table-unreadable");
  return { structure: normalizeTable(t), meta: { table_sha256: isHex64(t.table_sha256) ? t.table_sha256 : null } };
}

// ── 割り当て（表の行 → 正解の部品）
const goldTypeStructure = (c) => typeStructure(c.kind, c.kind === "computation" && isObj(c.type) ? { ...c.type, aggregate: isObj(c.type.aggregate) ? { kind: c.type.aggregate.kind } : null } : c.type);
const goldRefs = (c) => ({
  parent: opt(c.parent_entity),
  ref_entity: opt(c.ref_entity),
  group_by: isObj(c.group_by) ? c.group_by.field : null,
  aggregate: c.kind === "computation" && isObj(c.type) && isObj(c.type.aggregate) ? opt(c.type.aggregate.entity) : null,
});
const REF_KEYS = ["parent", "ref_entity", "group_by", "aggregate"];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 要件の記号の全体（全案の required・allowed・context と、その親 entity・参照先の閉包）。足跡の照合に使う */
function symbolsOfRequirement(r, comp) {
  const out = new Set();
  const add = (s) => {
    if (out.has(s) || !comp.has(s)) return;
    out.add(s);
    const refs = goldRefs(comp.get(s));
    for (const k of REF_KEYS) if (refs[k] !== null) add(refs[k]);
  };
  for (const a of r.alternatives) for (const s of [...a.required, ...a.allowed, ...a.context]) add(s);
  return out;
}
/**
 * P 全体で一貫した割り当てを決定的に探す。鍵は凍結した要件 ID：行は（種類・型の構造・groupBy の種類）＋所属の足跡で候補の記号を持ち、
 * 参照（親 entity・参照先・groupBy の元・集計元）を割り当てどうしで整合させる。参照切れの行は割り当て不能。
 * 1 部品に 1 行：同じ部品にしか当たらない 2 行はどちらも割り当てない。解が 1 つに決まらない行は、全ての解で同じ記号の行だけを割り当てる。
 * 戻り：{ assignment: symbol → 行の添字, unassigned: 行の添字の並び, limit: 探索の上限を超えたか }
 */
export function assignRows(structure, gold, ix = indexGold(gold)) {
  const { rows, ownership } = structure;
  const footprint = rows.map(() => new Set());
  for (const [req, idxs] of Object.entries(ownership)) for (const i of idxs) footprint[i].add(req);
  const reqSyms = new Map([...ix.reqs].map(([id, r]) => [id, symbolsOfRequirement(r, ix.comp)]));
  // 候補：型の構造が合う記号のうち、足跡（その行を所属させる要件）の記号の全体に入る要件の数が最も多いもの。
  // 足跡が空の行、どの要件にも入らない行は、型の構造が合う記号の全部（足跡で落とすと、許す集合の外の所属を過剰として数えられない）
  const cand = rows.map((row, i) => {
    if (REF_KEYS.some((k) => row.refs[k] === BROKEN)) return new Set();
    const scored = [];
    for (const c of gold.components) {
      if (c.kind !== row.kind || !sameJson(goldTypeStructure(c), row.type)) continue;
      if ((isObj(c.group_by) ? c.group_by.kind : null) !== row.group_by_kind) continue;
      const refs = goldRefs(c);
      if (REF_KEYS.some((k) => (refs[k] === null) !== (row.refs[k] === null))) continue;
      scored.push([c.symbol, [...footprint[i]].filter((req) => reqSyms.get(req)?.has(c.symbol) ?? false).length]);
    }
    const best = Math.max(0, ...scored.map(([, n]) => n));
    return new Set(scored.filter(([, n]) => n === best).map(([s]) => s));
  });
  const dropped = new Set();
  // 参照の整合（弧の整合）：行の候補 s は、参照先の行の候補に s の参照先の記号があるときだけ残す
  const refine = () => {
    let changed = true;
    while (changed) {
      changed = false;
      rows.forEach((row, i) => {
        for (const s of [...cand[i]]) {
          const refs = goldRefs(ix.comp.get(s));
          const ok = REF_KEYS.every((k) => row.refs[k] === null || (!dropped.has(row.refs[k]) && cand[row.refs[k]].has(refs[k])));
          if (!ok) { cand[i].delete(s); changed = true; }
        }
      });
      // 同じ部品にしか当たらない 2 行以上はどちらも割り当てない（別名の合併をしない）
      const single = new Map();
      rows.forEach((_, i) => { if (!dropped.has(i) && cand[i].size === 1) { const s = [...cand[i]][0]; single.set(s, [...(single.get(s) ?? []), i]); } });
      for (const [, list] of single) if (list.length >= 2) for (const i of list) { dropped.add(i); cand[i].clear(); changed = true; }
    }
  };
  refine();
  // 探索：候補の残る行に、単射で参照の整合する割り当てを探す。行は割り当てないこともでき、割り当てた行の数が最も多い解を全部集める
  // （上限つき。行の順は候補の少ない順・添字の順、記号の順は文字列の順で決定的）。全ての最良の解で同じ値（記号か「割り当てない」）の行だけを決める
  const order = rows.map((_, i) => i).filter((i) => cand[i].size > 0).sort((a, b) => cand[a].size - cand[b].size || a - b);
  let solutions = [], best = -1, nodes = 0, limit = false;
  const cur = new Map(), used = new Set();
  const fits = (i, s) => {
    const refs = goldRefs(ix.comp.get(s));
    return REF_KEYS.every((k) => rows[i].refs[k] === null || !cur.has(rows[i].refs[k]) || cur.get(rows[i].refs[k]) === refs[k]);
  };
  const backRefsOk = (i, s) => rows.every((r, j) => !cur.has(j) || REF_KEYS.every((k) => r.refs[k] !== i || goldRefs(ix.comp.get(cur.get(j)))[k] === s));
  const dfs = (k) => {
    if (limit) return;
    if (++nodes > SEARCH_LIMIT) { limit = true; return; }
    if (cur.size + (order.length - k) < best) return;
    if (k === order.length) {
      if (cur.size > best) { best = cur.size; solutions = []; }
      if (solutions.length >= SOLUTION_LIMIT) { limit = true; return; }
      solutions.push(new Map(cur));
      return;
    }
    const i = order[k];
    for (const s of [...cand[i]].sort()) {
      if (used.has(s) || !fits(i, s) || !backRefsOk(i, s)) continue;
      cur.set(i, s); used.add(s);
      dfs(k + 1);
      cur.delete(i); used.delete(s);
      if (limit) return;
    }
    dfs(k + 1);
  };
  dfs(0);
  if (limit) return { assignment: {}, unassigned: rows.map((_, i) => i), limit: true };
  const assignment = {};
  for (const i of order) {
    const vals = new Set(solutions.map((m) => m.get(i) ?? null));
    const only = [...vals][0];
    if (vals.size === 1 && only !== null) assignment[only] = i;
  }
  // 最後の整合：割り当てた行の参照先が割り当てられていて記号が合うまで外す
  let changed = true;
  while (changed) {
    changed = false;
    const symOf = new Map(Object.entries(assignment).map(([s, i]) => [i, s]));
    for (const [s, i] of Object.entries(assignment)) {
      const refs = goldRefs(ix.comp.get(s));
      if (!REF_KEYS.every((k) => rows[i].refs[k] === null || symOf.get(rows[i].refs[k]) === refs[k])) { delete assignment[s]; changed = true; }
    }
  }
  const assigned = new Set(Object.values(assignment));
  const sorted = Object.fromEntries(Object.entries(assignment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { assignment: sorted, unassigned: rows.map((_, i) => i).filter((i) => !assigned.has(i)), limit: false };
}

// ── 3 問と判定（同じ 1 案の中で）
const parentClosure = (idxs, rows) => {
  const out = new Set(idxs);
  const stack = [...idxs];
  while (stack.length > 0) { const p = rows[stack.pop()].refs.parent; if (typeof p === "number" && !out.has(p)) { out.add(p); stack.push(p); } }
  return out;
};
const goldParentClosure = (syms, comp) => {
  const out = new Set(syms);
  const stack = [...syms];
  while (stack.length > 0) { const c = comp.get(stack.pop()); const p = c ? opt(c.parent_entity) : null; if (p !== null && !out.has(p)) { out.add(p); stack.push(p); } }
  return out;
};
const rowTypeName = (row) => (typeof row.type === "string" ? row.type : isObj(row.type) ? (row.type.valueType ?? row.type.action ?? row.type.view ?? null) : null);
/** unexpressible が効く案か：案の中 → その案だけ、要件直下で scope 無し → 全案、scope（設計族）あり → その設計族の案だけ */
export const unexpressibleApplies = (req, alt) => alt.unexpressible || (req.unexpressible && (req.unexpressible_family === null || alt.design_family === req.unexpressible_family));

/** 1 案の 3 問：{ missing, excess, verification（0／1）, kind（correct・carry-over・accepted-removal・overclaim・wrong）, marks } */
export function evaluateAlternative(req, alt, ctx) {
  const { rows, ownership, verification, rowOf, symOf, comp } = ctx;
  const owned = ownership[req.requirement_id] ?? [];
  const ownedClosure = parentClosure(owned, rows);
  const marks = new Set();
  // (i) 欠け：required は所属で（親 entity は閉包）、context と required・実在の allowed の参照先は表全体に在ればよい
  let missing = 1;
  for (const s of alt.required) {
    const r = rowOf.get(s), c = comp.get(s);
    if (r === undefined || !ownedClosure.has(r)) { missing = 0; continue; }
    if (c && Number.isInteger(c.options_count)) { if (rows[r].options_count !== c.options_count) missing = 0; else marks.add("semantics-unverified"); }
    if (c && c.semantics) marks.add("semantics-unverified");
  }
  for (const s of alt.context) if (!rowOf.has(s)) missing = 0;
  for (const s of [...alt.required, ...alt.allowed.filter((x) => rowOf.has(x))]) {
    const c = comp.get(s);
    if (!c) continue;
    const refs = goldRefs(c);
    for (const k of ["ref_entity", "group_by", "aggregate"]) if (refs[k] !== null && !rowOf.has(refs[k])) missing = 0;
  }
  // (ii) 過剰：所属の行が同じ案の allowed（と required）の親 entity の閉包の内。導いた entity の所属は過剰にしない
  const permitted = goldParentClosure([...alt.required, ...alt.allowed], comp);
  const ownedSet = new Set(owned);
  const derivedParents = new Set();
  for (const i of owned) { let p = rows[i].refs.parent; while (typeof p === "number") { derivedParents.add(p); p = rows[p].refs.parent; } }
  let excess = 1;
  for (const i of ownedSet) {
    if (rows[i].kind === "entity" && derivedParents.has(i)) continue;
    if (!permitted.has(symOf.get(i))) excess = 0;
  }
  // (iii) 確かめ方
  const tv = verification[req.requirement_id] ?? null, gv = alt.verification;
  if (unexpressibleApplies(req, alt)) {
    if (tv?.kind === "unresolved") return { missing, excess, verification: null, kind: "carry-over", marks: [...marks].sort() };
    marks.add("overclaim");
    return { missing, excess, verification: 0, kind: "overclaim", marks: [...marks].sort() };
  }
  if (tv?.kind === "unresolved") {
    const by = gv.kind === "unresolved" ? UNRESOLVED_REASON_KINDS[gv.reason_kind] : undefined;
    if (by !== undefined) return { missing, excess, verification: null, kind: by, marks: [...marks].sort() };
    if (req.verification_limit) return { missing, excess, verification: null, kind: "carry-over", marks: [...marks].sort() };
    return { missing, excess, verification: 0, kind: "wrong", marks: [...marks].sort() };
  }
  let ver = tv !== null && tv.kind === gv.kind ? 1 : 0;
  if (ver === 1 && gv.kind === "structural") {
    const a = [...new Set(tv.checks ?? [])].sort(), b = [...new Set(gv.checks ?? [])].sort();
    if (!sameJson(a, b)) ver = 0;
    for (const as of gv.assertions ?? []) {
      const r = rowOf.get(as.target);
      if (r === undefined || !ownedClosure.has(r)) { ver = 0; continue; }
      if (as.expected !== undefined && as.expected !== null && rowTypeName(rows[r]) !== as.expected) ver = 0;
      if (as.ref_entity !== undefined && as.ref_entity !== null) { const t = rows[r].refs.ref_entity; if (typeof t !== "number" || symOf.get(t) !== as.ref_entity) ver = 0; }
    }
  } else if (ver === 1 && gv.kind === "fixed-test") {
    for (const o of gv.observations ?? []) {
      const r = rowOf.get(o.target);
      const fit = OBSERVATION_FIT[o.operation];
      if (r === undefined || rows[r].kind !== o.target_kind || (fit !== undefined && !fit(rows[r]))) ver = 0;
    }
    marks.add("semantics-unverified");
  } else if (ver === 1 && (gv.kind === "default-value" || gv.kind === "enum-membership")) marks.add("semantics-unverified");
  const kind = missing === 1 && excess === 1 && ver === 1 ? "correct" : "wrong";
  return { missing, excess, verification: ver, kind, marks: [...marks].sort() };
}

/**
 * 共有の採点の関数。渡すもの：採点の構造（normalizeTable の戻り）と読取元のメタデータ（表の SHA）。
 * 戻り：要件 ID ごとの 5 値・3 問（0／1／null）・採った案・印、割り当て、割り当てられない行
 */
export function scoreStructure(structure, meta, gold) {
  const ix = indexGold(gold);
  const asg = assignRows(structure, gold, ix);
  const rowOf = new Map(Object.entries(asg.assignment));
  const symOf = new Map([...rowOf].map(([s, i]) => [i, s]));
  const unassigned = new Set(asg.unassigned);
  const ctx = { ...structure, rowOf, symOf, comp: ix.comp };
  const requirements = ix.allIds.map((id) => {
    const base = { requirement_id: id, outcome: "held", hold: null, questions: { missing: null, excess: null, verification: null }, alternative: null, variant_id: null, marks: ix.related.has(id) ? ["related"] : [] };
    if (ix.held.has(id)) return { ...base, hold: "needs-human" };
    const req = ix.reqs.get(id);
    if (asg.limit) return { ...base, hold: "search-limit" };
    const owned = structure.ownership[id] ?? [];
    if (owned.some((i) => unassigned.has(i))) return { ...base, hold: "unassignable-row" };
    // 禁止の部品（案ごと）：所属の行に禁止の部品を割り当てた案は選ばない。全案がそうなら案が選べない
    const admissible = req.alternatives.map((alt) => !alt.forbidden_components.some((s) => owned.some((i) => symOf.get(i) === s)));
    if (!admissible.some(Boolean)) return { ...base, hold: "alternative-unselectable" };
    const evaluated = req.alternatives.map((alt, i) => (admissible[i] ? evaluateAlternative(req, alt, ctx) : { missing: 0, excess: 0, verification: 0, kind: "inadmissible", marks: [] }));
    const pick = (k) => evaluated.findIndex((j) => j.kind === k);
    const done = (outcome, at) => {
      const j = evaluated[at];
      const marks = [...new Set([...base.marks, ...j.marks])].sort();
      return { ...base, outcome, questions: { missing: j.missing, excess: j.excess, verification: j.verification }, alternative: at, variant_id: req.alternatives[at].id, marks };
    };
    if (pick("correct") >= 0) return done("correct", pick("correct"));
    if (pick("accepted-removal") >= 0) return done("accepted-removal", pick("accepted-removal"));
    if (pick("carry-over") >= 0) return done("carry-over", pick("carry-over"));
    const ones = evaluated.map((j) => (j.kind === "inadmissible" ? -1 : j.missing + j.excess + (j.verification ?? 0)));
    const best = Math.max(...ones), tied = ones.map((x, i) => (x === best ? i : -1)).filter((i) => i >= 0);
    const families = new Set(tied.map((i) => req.alternatives[i].design_family ?? null));
    if (tied.length >= 2 && (families.size >= 2 || tied.some((i) => req.alternatives[i].policy))) return { ...base, hold: "alternative-unselectable" };
    return done("wrong", tied[0]);
  });
  return { table_sha256: meta?.table_sha256 ?? null, requirements, assignment: asg.assignment, unassigned_rows: asg.unassigned, search_limit: asg.limit };
}

// ── 計測の出力の読取りと照合
function loadConditions(dir) {
  let c, bytes;
  try { bytes = readFileSync(join(dir, CONDITIONS_FILE)); c = JSON.parse(bytes.toString("utf8")); } catch { refuse("table-score:conditions"); }
  if (!isObj(c) || !Array.isArray(c.child_args) || !isObj(c.frozen) || !isStr(c.frozen.id) || !Number.isInteger(c.frozen.version) || !Array.isArray(c.frozen.adopted)) refuse("table-score:conditions");
  const runs = c.child_args.map((a) => a?.id);
  if (!runs.every((id) => typeof id === "string" && RUN_ID.test(id)) || new Set(runs).size !== runs.length || runs.length === 0) refuse("table-score:conditions");
  if (!c.frozen.adopted.every((a) => isObj(a) && typeof a.pattern === "string" && isHex64(a.plan_sha256))) refuse("table-score:conditions");
  // 段単位の走り（v6・v8 で params.mode が stage-run）：入力なしの本は予定の部分集合で、経路（v6 は v1.1a・v8 は v1.2）が版と合うことだけを見る
  const stage = isStageConditions(c);
  let absent = [];
  if (stage) {
    absent = stageAbsentOf(c, runs);
    if (absent === null || stagePipelineOf(c) === null) refuse("table-score:conditions");
  }
  return { runs, frozen: c.frozen, stage, absent, conditions_sha256: sha256(bytes), measurement_id: isStr(c.measurement_id) ? c.measurement_id : null };
}
const readIf = (path) => {
  if (!existsSync(path)) return { status: "absent", value: null };
  try { return { status: "ok", value: readJson(path) }; } catch { return { status: "unreadable", value: null }; }
};
/** 本の表の読取り：受理済みの表を採り、checkpoint は件数だけ。plan_sha256 を build の記録と checkpoint の両方で照らす */
function readRun(dir, id, gold) {
  const accepted = readIf(join(dir, id, SOURCE_PATHS.accepted));
  const checkpoint = readIf(join(dir, id, SOURCE_PATHS.checkpoint));
  const record = readIf(join(dir, id, BUILD_RECORD_PATH));
  if (accepted.status === "unreadable" || checkpoint.status === "unreadable") refuse("table-score:table-unreadable");
  const shas = [];
  if (record.status === "ok" && isObj(record.value) && "plan_sha256" in record.value) shas.push(record.value.plan_sha256);
  if (checkpoint.status === "ok" && isObj(checkpoint.value)) shas.push(checkpoint.value.plan_sha256);
  const source = accepted.status === "ok" ? "accepted" : checkpoint.status === "ok" ? "checkpoint" : null;
  // 下書きだけの本（断った候補の記録があり表の無い本）も、build の記録の plan_sha256 を同じく照らす（記録が無ければ断る。#607）
  if ((source !== null || existsSync(join(dir, id, DRAFT_PATH))) && shas.length === 0) refuse("table-score:plan-sha256-run");
  if (shas.some((s) => s !== gold.plan_sha256)) refuse("table-score:plan-sha256-run");
  if (source === null) return { source: null, both: false, read: null, semantic: null };
  const semantic = source === "accepted" ? readIf(join(dir, id, SEMANTIC_RECORD_PATHS.accepted)) : { status: "ok", value: isObj(checkpoint.value) ? opt(checkpoint.value.semantic_check) : null };
  return { source, both: accepted.status === "ok" && checkpoint.status === "ok", read: readSource(source, source === "accepted" ? accepted.value : checkpoint.value), semantic };
}
/** 1 つの計測の出力先を照合して採点する（照合が 1 つでも合わなければ何も数えずに断る）。戻り：1 本目の行ごとの出力 */
export const scoreMeasurement = (dir, golds) => measure(dir, golds).rows;
/** 照合して採点し、1 本目の行・下書きの行 (c)・C3 の結び付けの行を返す */
function measure(dir, golds) {
  const { runs, frozen, stage, absent, conditions_sha256, measurement_id } = loadConditions(dir);
  const patterns = [...new Set(runs.map((id) => RUN_ID.exec(id)[1]))];
  for (const p of patterns) {
    const g = golds.get(p);
    if (g === undefined) refuse("table-score:gold-missing");
    if (g.plan_set.id !== frozen.id || g.plan_set.version !== frozen.version) refuse("table-score:frozen-set");
    const a = frozen.adopted.find((x) => x.pattern === p);
    if (a === undefined || a.plan_sha256 !== g.plan_sha256) refuse("table-score:plan-sha256-conditions");
  }
  // 照合を全部済ませてから数える（途中で断っても何も数えない）
  // 入力なしの本は起こしていないので本のディレクトリを読まない
  const read = runs.map((id) => ({ id, pattern: RUN_ID.exec(id)[1], ...(absent.includes(id) ? { source: null, both: false, read: null, semantic: null } : readRun(dir, id, golds.get(RUN_ID.exec(id)[1]))) }));
  const rows = read.map((r) => ({
    run: r.id, pattern: r.pattern, source: r.source, checkpoint_also: r.both, ...(stage ? { input_absent: absent.includes(r.id) } : {}),
    ...(r.read === null ? { table_sha256: null, requirements: null, assignment: null, unassigned_rows: null, search_limit: null } : scoreStructure(r.read.structure, r.read.meta, golds.get(r.pattern))),
  }));
  const draftRows = runs.map((id) => (absent.includes(id) ? { run: id, pattern: RUN_ID.exec(id)[1], source: null, checkpoint_also: false, candidate_count: 0, last: null, unreadable: null, table_sha256: null, requirements: null, assignment: null, unassigned_rows: null, search_limit: null } : scoreDraftRun(dir, id, golds.get(RUN_ID.exec(id)[1]))));
  const c3Rows = rows.map((r, i) => linkC3(r, read[i].semantic));
  return { rows, draftRows, c3Rows, stage, conditions_sha256, measurement_id };
}
/** 読取元ごとの本の数（段単位の走りだけ。互いに重ならない）：受理済みのみ・checkpoint のみ・両方・表なし（段の途中で止まるなどで読める表が無い）・入力なし */
export function runSources(rows) {
  const out = { accepted_only: 0, checkpoint_only: 0, both: 0, no_table: 0, input_absent: 0 };
  for (const r of rows) {
    if (r.input_absent === true) out.input_absent += 1;
    else if (r.source === null) out.no_table += 1;
    else if (r.checkpoint_also) out.both += 1;
    else if (r.source === "accepted") out.accepted_only += 1;
    else out.checkpoint_only += 1;
  }
  return out;
}

// ── 読取元 (c)：断った候補の下書き（#607）
/** 下書きの行の type（平らな写像）を、行の種類に合う欄だけの 1 本目の表の型に写す（種類に合わない欄は読まない） */
const draftType = (kind, t) => {
  if (kind === "entity") return null;
  if (kind === "field") return opt(t.fieldType);
  const keys = DRAFT_TYPE_KEYS[kind];
  return keys === undefined ? null : Object.fromEntries(keys.map((k) => [k, opt(t[k])]));
};
/**
 * 下書き（応答）と候補に添えた点検の一覧から、1 本目の採点の構造を作る。要件 ID は一覧の順で付ける（応答の写し・行の出典は読まない）。
 * 戻り：{ structure } か { unreadable: 理由 }（一覧が無い・表の形でない・数が合わない）
 */
export function draftStructure(response, list) {
  if (!isObj(list) || !Array.isArray(list.requirements) || !list.requirements.every((q) => isObj(q) && isStr(q.id))) return { unreadable: "no-list" };
  if (!isObj(response) || !Array.isArray(response.rows) || !Array.isArray(response.requirements)) return { unreadable: "shape" };
  if (!response.rows.every((r) => isObj(r) && isObj(r.type))) return { unreadable: "shape" };
  if (!response.requirements.every((q) => isObj(q) && Array.isArray(q.roles) && isObj(q.verification))) return { unreadable: "shape" };
  if (response.requirements.length !== list.requirements.length) return { unreadable: "count-mismatch" };
  const table = {
    rows: response.rows.map((r) => ({ id: r.id, kind: r.kind, entity: opt(r.entity), type: draftType(r.kind, r.type), options: opt(r.options), groupBy: opt(r.groupBy), refEntity: opt(r.refEntity) })),
    ownership: list.requirements.map((q, i) => ({ requirementId: q.id, roles: response.requirements[i].roles })),
    verification: list.requirements.map((q, i) => { const v = response.requirements[i].verification; return { requirementId: q.id, kind: v.kind, checks: v.checks, value: v.value }; }),
  };
  try { return { structure: normalizeTable(table) }; } catch (e) { if (e instanceof TableScoreError) return { unreadable: "shape" }; throw e; }
}
const coordOf = (c) => [c.round, c.attempt, c.call];
const coordCompare = (a, b) => { for (let k = 0; k < 3; k += 1) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
/** 本の断った候補の記録を読み、最後の候補（round・attempt・call が最大。同じなら記録の後のもの）だけを採点する */
function scoreDraftRun(dir, id, gold) {
  const pattern = RUN_ID.exec(id)[1];
  const none = { table_sha256: null, requirements: null, assignment: null, unassigned_rows: null, search_limit: null };
  const base = { run: id, pattern, source: null, checkpoint_also: false, candidate_count: 0, last: null, unreadable: null };
  const f = readIf(join(dir, id, DRAFT_PATH));
  if (f.status === "absent") return { ...base, ...none };
  const list = f.status === "ok" && isObj(f.value) && Array.isArray(f.value.candidates) ? f.value.candidates : null;
  if (list === null || !list.every((c) => isObj(c) && coordOf(c).every(Number.isInteger))) return { ...base, candidate_count: list === null ? null : list.length, unreadable: "file", ...none };
  if (list.length === 0) return { ...base, ...none };
  let last = list[0];
  for (const c of list) if (coordCompare(coordOf(c), coordOf(last)) >= 0) last = c;
  const head = { ...base, candidate_count: list.length, last: { round: last.round, attempt: last.attempt, call: last.call } };
  const d = last.kind === "content" ? draftStructure(last.response, last.inspection_list) : { unreadable: last.kind === "shape" ? "shape" : "no-list" };
  if (d.unreadable !== undefined) return { ...head, unreadable: d.unreadable, ...none };
  return { ...head, source: DRAFT_SOURCE, ...scoreStructure(d.structure, { table_sha256: null }, gold) };
}
/** 読取元 (c) の集計：1 本目の集計の関数をそのまま使い（分母 (a')・(b')）、候補の件数と読めない候補を足す */
export function aggregateDraft(draftRows, golds) {
  const unreadable = Object.fromEntries(DRAFT_UNREADABLE.map((k) => [k, 0]));
  for (const r of draftRows) if (r.unreadable !== null) unreadable[r.unreadable] += 1;
  return {
    ...aggregate(draftRows, golds, DRAFT_SOURCE),
    draft: {
      runs_with_candidates: draftRows.filter((r) => r.candidate_count !== 0).length,
      candidate_total: draftRows.reduce((s, r) => s + (r.candidate_count ?? 0), 0),
      scored_runs: draftRows.filter((r) => r.source === DRAFT_SOURCE).length,
      unreadable,
    },
  };
}

// ── C3 の正誤表（#607）
/** 採点した表と表の SHA が一致する点検の回（受理済みの表は記録の回のうち最後のもの）。戻り：{ status, round, targets, judgments } */
function matchSemantic(source, semantic, tableSha) {
  if (semantic === null || semantic.status === "absent" || (semantic.status === "ok" && semantic.value === null)) return { status: "absent" };
  if (semantic.status !== "ok") return { status: "unreadable" };
  const v = semantic.value;
  const rounds = source === "accepted" ? (isObj(v) && Array.isArray(v.rounds) ? v.rounds : null) : isObj(v) ? [v] : null;
  if (rounds === null) return { status: "unreadable" };
  const hit = rounds.filter((x) => isObj(x) && tableSha !== null && x.table_sha256 === tableSha).at(-1);
  if (hit === undefined) return { status: "no-matching-round" };
  if (!isStrList(hit.targets) || !Array.isArray(hit.judgments)) return { status: "unreadable" };
  return { status: "matched", round: source === "accepted" && Number.isInteger(hit.round) ? hit.round : null, targets: hit.targets, judgments: hit.judgments };
}
const emptyCells = () => ({ wrong_accept: 0, wrong_reject: 0, correct_accept: 0, correct_reject: 0 });
/** 本ごとに、採点した表を点検の回に結び、二値の要件の 2×2・非二値の件数・対象外・拒否の種類の件数を数える（引用・理由の文は読まない） */
function linkC3(r, semantic) {
  if (r.source === null) return null;
  const m = matchSemantic(r.source, semantic, r.table_sha256);
  const head = { run: r.run, pattern: r.pattern, source: r.source, record: m.status, round: m.round ?? null };
  if (m.status !== "matched") return { ...head, cells: null, non_binary: null, out_of_target: null, reject_kinds: null };
  // 判定は要件 ID ごとに 1 つ（既知の判定だけ。同じ ID が 2 つ以上なら判定の無い要件として扱う）
  const seen = new Map();
  for (const j of m.judgments) if (isObj(j) && isStr(j.requirementId)) seen.set(j.requirementId, seen.has(j.requirementId) ? null : j);
  const verdictOf = (id) => { const j = seen.get(id); return j && C3_VERDICTS.includes(j.verdict) && m.targets.includes(id) ? j.verdict : null; };
  const cells = emptyCells(), nonBinary = Object.fromEntries(C3_NON_BINARY.map((k) => [k, 0]));
  let outOfTarget = 0;
  for (const q of r.requirements) {
    if (!BINARY_OUTCOMES.includes(q.outcome)) { nonBinary[q.outcome] += 1; continue; }
    const v = verdictOf(q.requirement_id);
    if (v === null) { outOfTarget += 1; continue; }
    cells[`${q.outcome}_${v}`] += 1;
  }
  const rejectKinds = Object.fromEntries([...C3_REJECTION_KINDS, "unknown"].map((k) => [k, 0]));
  for (const j of m.judgments) if (isObj(j) && j.verdict === "reject") rejectKinds[C3_REJECTION_KINDS.includes(j.kind) ? j.kind : "unknown"] += 1;
  return { ...head, cells, non_binary: nonBinary, out_of_target: outOfTarget, reject_kinds: rejectKinds };
}
/** 読取元ごとの正誤表（見逃しの率・誤拒否の率・P ごとの 2×2・P の数） */
export function aggregateC3(c3Rows, source) {
  const cells = emptyCells(), nonBinary = Object.fromEntries(C3_NON_BINARY.map((k) => [k, 0])), noRecord = Object.fromEntries(C3_NO_RECORD.map((k) => [k, 0]));
  const rejectKinds = Object.fromEntries([...C3_REJECTION_KINDS, "unknown"].map((k) => [k, 0]));
  const byPattern = {};
  let withTable = 0, withRecord = 0, outOfTarget = 0;
  for (const r of c3Rows) {
    if (r === null || r.source !== source) continue;
    withTable += 1;
    if (r.record !== "matched") { noRecord[r.record] += 1; continue; }
    withRecord += 1;
    outOfTarget += r.out_of_target;
    const p = (byPattern[r.pattern] ??= emptyCells());
    for (const k of Object.keys(cells)) { cells[k] += r.cells[k]; p[k] += r.cells[k]; }
    for (const k of C3_NON_BINARY) nonBinary[k] += r.non_binary[k];
    for (const k of Object.keys(rejectKinds)) rejectKinds[k] += r.reject_kinds[k];
  }
  const sorted = Object.fromEntries(Object.entries(byPattern).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))));
  return {
    source,
    runs: { with_table: withTable, with_record: withRecord, no_record: noRecord },
    cells, non_binary: nonBinary, out_of_target: outOfTarget, reject_kinds: rejectKinds,
    miss: makeRate(cells.wrong_accept, cells.wrong_accept + cells.wrong_reject),
    false_reject: makeRate(cells.correct_reject, cells.correct_accept + cells.correct_reject),
    by_pattern: sorted, patterns: Object.keys(sorted).length,
  };
}

// ── 集計
const wilson = (k, n) => {
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: round6(Math.max(0, (c - m) / d)), high: round6(Math.min(1, (c + m) / d)) };
};
/** 率：分母 0 は率と区間を null にして理由の符号 */
export const makeRate = (k, n) => (n === 0 ? { k, n, rate: null, wilson95_reference: null, reason_code: ZERO_REASON } : { k, n, rate: round6(k / n), wilson95_reference: { name: WILSON_NAME, ...wilson(k, n) }, reason_code: null });
/** P のまとまり（単独群）：既存の clusterStats の bootstrap・t 区間。符号反転の p は出さない */
export function patternInterval(byPattern) {
  const c = clusterStats(byPattern);
  const { sign_flip: _omit, ...rest } = c;
  return rest;
}
/** 読取元ごとの集計。rows ＝ scoreMeasurement の戻り、golds ＝ P → 正解 */
export function aggregate(rows, golds, source) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const holds = { static: 0, candidate: Object.fromEntries(HOLD_REASONS.candidate.map((h) => [h, 0])) };
  const marks = Object.fromEntries(MARKS.map((m) => [m, 0]));
  let binary = 0, correct = 0, missing0 = 0, excess0 = 0, ver1 = 0, unobserved = 0, candidateDependent = 0, unassignedRows = 0, tableRuns = 0, noTable = 0, inputAbsent = 0, otherSource = 0, checkpointAlso = 0, denomB = 0;
  const byPattern = {};
  for (const r of rows) {
    const g = golds.get(r.pattern), ix = indexGold(g);
    const nonStatic = ix.allIds.filter((id) => !ix.held.has(id)).length;
    denomB += nonStatic;
    if (r.source !== source) { unobserved += nonStatic; if (r.source === null) { if (r.input_absent === true) inputAbsent += 1; else noTable += 1; } else otherSource += 1; continue; }
    tableRuns += 1;
    if (r.checkpoint_also) checkpointAlso += 1;
    unassignedRows += r.unassigned_rows.length;
    byPattern[r.pattern] ??= [];
    for (const q of r.requirements) {
      outcomes[q.outcome] += 1;
      for (const m of q.marks) marks[m] += 1;
      if (q.outcome === "held") { if (q.hold === "needs-human") holds.static += 1; else { holds.candidate[q.hold] += 1; candidateDependent += 1; } continue; }
      if (!BINARY_OUTCOMES.includes(q.outcome)) { candidateDependent += 1; continue; }
      binary += 1;
      const ok = q.outcome === "correct" ? 1 : 0;
      correct += ok;
      byPattern[r.pattern].push(ok);
      if (q.questions.missing === 0) missing0 += 1;
      if (q.questions.excess === 0) excess0 += 1;
      if (q.questions.verification === 1) ver1 += 1;
    }
  }
  const denomA = binary;
  return {
    source,
    runs: { planned: rows.length, with_table: tableRuns, no_table: noTable, other_source: otherSource, checkpoint_also: checkpointAlso, ...(rows.some((r) => "input_absent" in r) ? { input_absent: inputAbsent } : {}) },
    denominators: { a: denomA, b: denomB },
    correct: { a: makeRate(correct, denomA), b: makeRate(correct, denomB) },
    breakdown: { missing: makeRate(missing0, denomA), excess: makeRate(excess0, denomA), verification_correct: makeRate(ver1, denomA) },
    outcomes, holds,
    counts: { unobserved, candidate_dependent: candidateDependent, related: marks.related, semantics_unverified: marks["semantics-unverified"], overclaim: marks.overclaim, unassigned_rows: unassignedRows },
    pattern_interval: patternInterval(Object.fromEntries(Object.entries(byPattern).filter(([, xs]) => xs.length > 0))),
  };
}

// ── 比較（after − before。両側とも二値の要件だけ）
export const PAIR_NULL_REASONS = ["table-absent", "non-binary"];
export function compareRows(baseRows, candRows) {
  const candOf = new Map(candRows.map((r) => [r.run, r]));
  const diffs = [], excluded = Object.fromEntries(PAIR_NULL_REASONS.map((k) => [k, 0])), byPattern = {}, pairs = [];
  // 段単位の走り：入力なしの本は対に入らず、件数だけ別に出す（段単位でない計測には欄を足さない）
  if (baseRows.some((r) => "input_absent" in r) || candRows.some((r) => "input_absent" in r)) excluded["input-absent"] = 0;
  for (const b of baseRows) {
    const c = candOf.get(b.run);
    if (c === undefined) continue;
    if (b.input_absent === true || c.input_absent === true) { excluded["input-absent"] += 1; continue; }
    if (b.requirements === null || c.requirements === null) { excluded["table-absent"] += 1; pairs.push({ run: b.run, pattern: b.pattern, mean: null, n: 0 }); continue; }
    const cq = new Map(c.requirements.map((q) => [q.requirement_id, q]));
    const ds = [];
    for (const q of b.requirements) {
      const o = cq.get(q.requirement_id);
      if (o === undefined || !BINARY_OUTCOMES.includes(q.outcome) || !BINARY_OUTCOMES.includes(o.outcome)) { excluded["non-binary"] += 1; continue; }
      ds.push((o.outcome === "correct" ? 1 : 0) - (q.outcome === "correct" ? 1 : 0));
    }
    diffs.push(...ds);
    const mean = ds.length === 0 ? null : round6(ds.reduce((s, d) => s + d, 0) / ds.length);
    pairs.push({ run: b.run, pattern: b.pattern, mean, n: ds.length });
    if (mean !== null) (byPattern[b.pattern] ??= []).push(ds.reduce((s, d) => s + d, 0) / ds.length);
  }
  return { direction: "after − before（candidate − baseline）", requirement_diffs: pairStats(diffs), excluded, pairs, pattern_clusters: clusterStats(byPattern) };
}
function loadComparison(dir) {
  let c;
  try { c = readJson(join(dir, COMPARISON_FILE)); } catch { refuse("table-score:compare-record"); }
  const groups = c?.pairs?.groups;
  if (!isObj(c) || !Array.isArray(groups) || groups.length !== 2 || !groups.every(isStr) || groups[0] === groups[1]) refuse("table-score:compare-record");
  for (const g of groups) { try { if (!statSync(join(dir, g)).isDirectory()) refuse("table-score:compare-record"); } catch { refuse("table-score:compare-record"); } }
  return { baseline: groups[0], candidate: groups[1] };
}

// ── 出力
/** 道具のファイルの SHA-256（通常の出力にだけ。採点の欄と別の欄） */
export const toolFingerprint = () => sha256(readFileSync(fileURLToPath(import.meta.url)));
const perSource = (rows, golds) => Object.fromEntries(SOURCES.map((s) => [s, aggregate(rows, golds, s)]));
const perC3 = (c3Rows) => Object.fromEntries(SOURCES.map((s) => [s, aggregateC3(c3Rows, s)]));
/** 採点する（照合を通らなければ TableScoreError）。戻り：通常の出力（JSON の値） */
export function scoreTables({ goldDir, measureDir, compare = false }) {
  const golds = loadGoldDir(goldDir);
  if (!compare) {
    const { rows, draftRows, c3Rows, stage, conditions_sha256, measurement_id } = measure(measureDir, golds);
    return {
      schema: OUTPUT_SCHEMA, definitions: DEFINITIONS,
      scoring: { by_source: perSource(rows, golds), rows, draft: aggregateDraft(draftRows, golds), draft_rows: draftRows, c3: perC3(c3Rows), c3_rows: c3Rows, ...(stage ? { run_sources: runSources(rows) } : {}) },
      fingerprint: { tool_sha256: toolFingerprint(), conditions_sha256, measurement_id },
    };
  }
  const roles = loadComparison(measureDir);
  const mb = measure(join(measureDir, roles.baseline), golds), mc = measure(join(measureDir, roles.candidate), golds);
  const base = mb.rows, cand = mc.rows;
  const bySource = Object.fromEntries(SOURCES.map((s) => {
    const pick = (rows) => rows.map((r) => (r.source === s ? r : { ...r, requirements: null }));
    return [s, { baseline: aggregate(base, golds, s), candidate: aggregate(cand, golds, s), compare: compareRows(pick(base), pick(cand)) }];
  }));
  // (c) と正誤表は群ごとの欄だけ（対に入れない・対の差を取らない）
  return {
    schema: COMPARE_SCHEMA, definitions: DEFINITIONS, groups: { baseline: roles.baseline, candidate: roles.candidate },
    scoring: {
      by_source: bySource, rows: { baseline: base, candidate: cand },
      draft: { baseline: aggregateDraft(mb.draftRows, golds), candidate: aggregateDraft(mc.draftRows, golds) }, draft_rows: { baseline: mb.draftRows, candidate: mc.draftRows },
      c3: Object.fromEntries(SOURCES.map((s) => [s, { baseline: aggregateC3(mb.c3Rows, s), candidate: aggregateC3(mc.c3Rows, s) }])), c3_rows: { baseline: mb.c3Rows, candidate: mc.c3Rows },
      ...(mb.stage || mc.stage ? { run_sources: { baseline: runSources(base), candidate: runSources(cand) } } : {}),
    },
    fingerprint: { tool_sha256: toolFingerprint(), conditions_sha256: { baseline: mb.conditions_sha256, candidate: mc.conditions_sha256 }, measurement_id: { baseline: mb.measurement_id, candidate: mc.measurement_id } },
  };
}

// 匿名の口：件数・率・区間・m だけ（P の番号・本の ID・要件 ID・記号・パス・SHA を出さない）
const anonRate = (r) => ({ k: r.k, n: r.n, rate: r.rate, wilson95_reference: r.wilson95_reference === null ? null : { low: r.wilson95_reference.low, high: r.wilson95_reference.high }, reason_code: r.reason_code });
const anonInterval = (c) => ({ m: c.m, mean: c.mean, bootstrap: { interval: c.bootstrap.interval, resamples: c.bootstrap.resamples, seed: c.bootstrap.seed, reason: c.bootstrap.reason }, t_reference: { df: c.t_reference.df, interval: c.t_reference.interval, reason: c.t_reference.reason }, ...(c.sign_flip ? { sign_flip: { p: c.sign_flip.p, permutations: c.sign_flip.permutations, reason: c.sign_flip.reason } } : {}) });
const anonAggregate = (a) => ({
  runs: { ...a.runs }, denominators: { ...a.denominators }, correct: { a: anonRate(a.correct.a), b: anonRate(a.correct.b) },
  breakdown: { missing: anonRate(a.breakdown.missing), excess: anonRate(a.breakdown.excess), verification_correct: anonRate(a.breakdown.verification_correct) },
  outcomes: { ...a.outcomes }, holds: { static: a.holds.static, candidate: { ...a.holds.candidate } }, counts: { ...a.counts }, pattern_interval: anonInterval(a.pattern_interval),
});
const anonDraft = (a) => ({ ...anonAggregate(a), draft: { runs_with_candidates: a.draft.runs_with_candidates, candidate_total: a.draft.candidate_total, scored_runs: a.draft.scored_runs, unreadable: { ...a.draft.unreadable } } });
const anonC3 = (c) => ({
  runs: { with_table: c.runs.with_table, with_record: c.runs.with_record, no_record: { ...c.runs.no_record } }, cells: { ...c.cells }, non_binary: { ...c.non_binary }, out_of_target: c.out_of_target,
  reject_kinds: { ...c.reject_kinds }, miss: anonRate(c.miss), false_reject: anonRate(c.false_reject), patterns: c.patterns,
});
export function anonymize(full) {
  if (full.schema === OUTPUT_SCHEMA) {
    return {
      schema: ANONYMOUS_SCHEMA, mode: "single", by_source: Object.fromEntries(SOURCES.map((s) => [s, anonAggregate(full.scoring.by_source[s])])),
      draft: anonDraft(full.scoring.draft), c3: Object.fromEntries(SOURCES.map((s) => [s, anonC3(full.scoring.c3[s])])),
      ...(full.scoring.run_sources ? { run_sources: { ...full.scoring.run_sources } } : {}),
    };
  }
  return {
    schema: ANONYMOUS_SCHEMA, mode: "compare",
    by_source: Object.fromEntries(SOURCES.map((s) => {
      const x = full.scoring.by_source[s], d = x.compare.requirement_diffs;
      return [s, { baseline: anonAggregate(x.baseline), candidate: anonAggregate(x.candidate), compare: { requirement_diffs: { n: d.n, counts: { ...d.counts }, mean: d.mean, sd: d.sd, interval: d.interval }, excluded: { ...x.compare.excluded }, pattern_clusters: anonInterval(x.compare.pattern_clusters) } }];
    })),
    draft: { baseline: anonDraft(full.scoring.draft.baseline), candidate: anonDraft(full.scoring.draft.candidate) },
    c3: Object.fromEntries(SOURCES.map((s) => [s, { baseline: anonC3(full.scoring.c3[s].baseline), candidate: anonC3(full.scoring.c3[s].candidate) }])),
    ...(full.scoring.run_sources ? { run_sources: { baseline: { ...full.scoring.run_sources.baseline }, candidate: { ...full.scoring.run_sources.candidate } } } : {}),
  };
}

const pct = (r) => (r.rate === null ? `なし（${r.reason_code}）` : `${r.k}/${r.n}（${(r.rate * 100).toFixed(1)}%）`);
const rangeOf = (x) => (x === null ? "-" : `${x[0].toFixed(3)}〜${x[1].toFixed(3)}`);
const aggText = (a) => `正答 (a) ${pct(a.correct.a)}・(b) ${pct(a.correct.b)}・欠け ${pct(a.breakdown.missing)}・過剰 ${pct(a.breakdown.excess)}・確かめ方 ${pct(a.breakdown.verification_correct)}・分母 (a) ${a.denominators.a}／(b) ${a.denominators.b}・5 値 ${OUTCOMES.map((o) => `${o} ${a.outcomes[o]}`).join("・")}・割り当てられない行 ${a.counts.unassigned_rows}・表なし ${a.runs.no_table}・P の区間（m ${a.pattern_interval.m}）bootstrap ${rangeOf(a.pattern_interval.bootstrap.interval)}`;
const draftText = (a) => `${aggText(a)}・候補 ${a.draft.candidate_total}（候補のある本 ${a.draft.runs_with_candidates}・採点した本 ${a.draft.scored_runs}）・読めない候補 ${DRAFT_UNREADABLE.map((k) => `${k} ${a.draft.unreadable[k]}`).join("・")}`;
const sourcesText = (x) => `受理済みのみ ${x.accepted_only}・checkpoint のみ ${x.checkpoint_only}・両方 ${x.both}・表なし ${x.no_table}・入力なし ${x.input_absent}`;
const c3Text = (c) => `見逃し ${pct(c.miss)}・誤拒否 ${pct(c.false_reject)}・点検の対象外 ${c.out_of_target}・非二値 ${C3_NON_BINARY.map((k) => `${k} ${c.non_binary[k]}`).join("・")}・点検の記録あり ${c.runs.with_record}・点検の記録なし ${C3_NO_RECORD.map((k) => `${k} ${c.runs.no_record[k]}`).join("・")}・P の数 ${c.patterns}`;
/** 標準出力の要約（読取元ごとに 1 行。比較は差の 1 行を足す。そのあとに下書き (c) の行と正誤表の行） */
export function summaryText(full) {
  const src = full.scoring.by_source;
  if (full.schema === OUTPUT_SCHEMA) {
    return [...SOURCES.map((s) => `[${s}] ${aggText(src[s])}`), `[${DRAFT_SOURCE}] ${draftText(full.scoring.draft)}`, ...SOURCES.map((s) => `[c3:${s}] ${c3Text(full.scoring.c3[s])}`), ...(full.scoring.run_sources ? [`[本の読取元] ${sourcesText(full.scoring.run_sources)}`] : [])].join("\n");
  }
  const groups = ["baseline", "candidate"], label = { baseline: "比較元", candidate: "候補" };
  const tail = [...groups.map((g) => `[${DRAFT_SOURCE}] ${label[g]} ${draftText(full.scoring.draft[g])}`), ...SOURCES.flatMap((s) => groups.map((g) => `[c3:${s}] ${label[g]} ${c3Text(full.scoring.c3[s][g])}`))];
  const stageTail = full.scoring.run_sources ? groups.map((g) => `[本の読取元] ${label[g]} ${sourcesText(full.scoring.run_sources[g])}`) : [];
  return [...SOURCES.map((s) => {
    const x = src[s], d = x.compare.requirement_diffs, c = x.compare.pattern_clusters;
    return `[${s}] 比較元 ${aggText(x.baseline)}\n[${s}] 候補 ${aggText(x.candidate)}\n[${s}] 差 n ${d.n}（+1 ${d.counts["+1"]}・0 ${d.counts[0]}・-1 ${d.counts["-1"]}）平均 ${d.mean ?? "-"}・P のまとまり（m ${c.m}）p ${c.sign_flip.p ?? "-"}・bootstrap ${rangeOf(c.bootstrap.interval)}・除いた ${[...PAIR_NULL_REASONS, ...("input-absent" in x.compare.excluded ? ["input-absent"] : [])].map((k) => `${k} ${x.compare.excluded[k]}`).join("・")}`;
  }), ...tail, ...stageTail].join("\n");
}

/** 入口：引数を読み、採点して書く。断れば何も書かずに符号を返す */
export function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  const known = new Set(["--compare", "--anonymous"]);
  try {
    if (pos.length !== 3 || [...flags].some((f) => !known.has(f))) refuse("table-score:args");
    const [goldDir, measureDir, outDir] = pos.map((p) => resolve(p));
    const full = scoreTables({ goldDir, measureDir, compare: flags.has("--compare") });
    const file = full.schema === OUTPUT_SCHEMA ? OUTPUT_FILE : COMPARE_FILE;
    mkdirSync(outDir, { recursive: true });
    if (flags.has("--anonymous")) {
      const anon = anonymize(full);
      writeFileSync(join(outDir, anonymousFileOf(file)), `${JSON.stringify(anon, null, 2)}\n`);
      return { code: 0, text: `表の採点（匿名）を書きました: ${anonymousFileOf(file)}` };
    }
    writeFileSync(join(outDir, file), `${JSON.stringify(full, null, 2)}\n`);
    return { code: 0, text: summaryText(full) };
  } catch (e) {
    if (e instanceof TableScoreError) return { code: EXIT_REFUSED, text: `断りました [${e.code}] ${REFUSALS[e.code]}` };
    throw e;
  }
}

const isEntry = () => { if (process.argv[1] === undefined) return false; try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) {
  const r = main(process.argv.slice(2));
  (r.code === 0 ? console.log : console.error)(r.text);
  process.exitCode = r.code;
}
