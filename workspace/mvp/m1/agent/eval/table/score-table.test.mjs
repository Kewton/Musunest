// score-table.mjs の試験（node --test。#606）。API・通信・LLM・判定・時計を使わない。
// 正解の表と工場の表は、ここで組む合成のもの（中立な名前）だけで閉じる。計測の記録・正解の現物を取り込まない。
// 実行: node --test workspace/mvp/m1/agent/eval/table/score-table.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterStats, pairStats } from "../agent-accept/score-agent.mjs";
import {
  ANONYMOUS_SCHEMA, BROKEN, COMPARE_FILE, COMPARE_SCHEMA, EXIT_REFUSED, GOLD_VERSION, OUTCOMES, OUTPUT_FILE, OUTPUT_SCHEMA, SOURCE_PATHS, BUILD_RECORD_PATH, WILSON_NAME,
  aggregate, anonymize, anonymousFileOf, assignRows, compareRows, main, normalizeTable, readSource, scoreStructure, validateGold,
} from "./score-table.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../../..");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const PLAN_A = sha("plan-a"), PLAN_B = sha("plan-b"), PLAN_X = sha("plan-x");
const TEXT = "GOLDTEXT"; // 正解の文の欄に入れる目印（出力に写っていないことを走査する）

// ── 合成の正解（部品と要件は配列）
const C = (symbol, kind, type, parent = null, extra = {}) => ({ symbol, kind, type, entity: parent, refEntity: null, groupBy: null, options: null, meaning_quote: TEXT, ...extra });
/** 選択肢の配列（現物は symbol と意味の文の組。数は配列の長さ） */
const opts = (n) => Array.from({ length: n }, (_, k) => ({ symbol: `opt${k}`, meaning: TEXT }));
const COMPONENTS = [
  C("E_a", "entity", null),
  C("E_b", "entity", null),
  C("E_c", "entity", null),
  C("E_d", "entity", null),
  C("F_a1", "field", "string", "E_a"),
  C("F_a2", "field", "number", "E_a"),
  C("F_ref", "field", "ref", "E_a", { refEntity: "E_b" }),
  C("F_enum", "field", "enum", "E_a", { options: opts(3), semantics: { note: "x" } }),
  C("F_enum2", "field", "enum", "E_a", { options: opts(2) }),
  C("F_b1", "field", "string", "E_b"),
  C("F_opt", "field", "ref", "E_b", { refEntity: "E_d" }),
  C("F_c1", "field", "date", "E_c"),
  C("C_sum", "computation", { valueType: "number", scope: "row", form: "aggregate", aggregate: { kind: "sum", entity: "E_a" } }, "E_b"),
  C("C_expr", "computation", { valueType: "number", scope: "row", form: "expression", aggregate: null }, "E_a"),
  C("O_add", "operation", { action: "add", hasWhen: true }, "E_a"),
  C("O_del", "operation", { action: "delete", hasWhen: false }, "E_a"),
  C("S_board", "screen", { view: "board" }, "E_a", { groupBy: { kind: "enum", field: "F_enum" } }),
];
const alt = (required, allowed, verification, context = [], extra = {}) => ({ id: `v-${required.join("+") || "none"}`, required, allowed, context, verification: [verification], added_after_review: false, rationale: TEXT, review_evidence: [TEXT], ...extra });
const UX = (scope) => ({ reason_kind: "k", expected_handling: "carry-over", blocked_components: [], rationale: TEXT, ...(scope === undefined ? {} : { scope }) });
const ST = (checks, assertions) => ({ kind: "structural", checks, ...(assertions ? { assertions } : {}) });
const FT = (observations) => ({ kind: "fixed-test", observations });
const REQS = [
  { requirement_id: "R1", variants: [alt(["F_a1"], ["F_a1", "E_a"], ST(["k-req", "k-uniq"], [{ check: "k-req", target: "F_a1", expected: "string" }]))], question: TEXT },
  { requirement_id: "R2", variants: [alt(["F_a2"], ["F_a2", "F_a1"], FT([{ target: "F_a2", target_kind: "field", operation: "validate" }]), ["F_a1"])] },
  { requirement_id: "R3", variants: [alt(["F_ref"], ["F_ref"], ST(["k-ref"], [{ check: "k-ref", target: "F_ref", refEntity: "E_b" }]))] },
  { requirement_id: "R4", variants: [alt(["F_b1"], ["F_b1", "F_opt"], { kind: "default-value" })] },
  { requirement_id: "R5", variants: [alt(["F_enum"], ["F_enum"], { kind: "enum-membership" })] },
  { requirement_id: "R6", variants: [alt(["C_sum"], ["C_sum"], FT([{ target: "C_sum", target_kind: "computation", operation: "aggregate" }]))] },
  { requirement_id: "R7", variants: [alt(["O_add"], ["O_add"], FT([{ target: "O_add", target_kind: "operation", operation: "action" }]))] },
  { requirement_id: "R8", variants: [alt(["S_board"], ["S_board"], ST(["k-group"]))] },
  { requirement_id: "R9", variants: [alt(["O_del"], ["O_del"], FT([{ target: "O_del", target_kind: "operation", operation: "structure" }])), alt(["C_expr"], ["C_expr"], ST(["k-x"]))] },
  { requirement_id: "R10", variants: [alt(["F_enum2"], ["F_enum2"], { kind: "enum-membership" })] },
  { requirement_id: "R11", variants: [alt(["F_c1"], ["F_c1"], ST(["k-c"]))] },
];
const goldOf = (over = {}) => ({
  version: GOLD_VERSION, pattern: "P1", plan_set: { id: "set-x", version: 1, manifest_sha256: sha("manifest") }, plan_sha256: PLAN_A,
  components: COMPONENTS, requirements: REQS, needs_human: [], counts: { requirements: REQS.length, alternatives: 12, needs_human: 0, unexpressible: 0, after_review: 0, human_added_after_review: 0 }, provenance: { note: TEXT }, ...over,
});

// ── 合成の表（工場の名前の表の形）
const SYMS_ALL = ["E_a", "E_b", "E_c", "F_a1", "F_a2", "F_ref", "F_enum", "F_enum2", "F_b1", "F_c1", "C_sum", "O_add", "O_del", "S_board"];
const OWN = { R1: ["F_a1"], R2: ["F_a2", "F_a1"], R3: ["F_ref"], R4: ["F_b1"], R5: ["F_enum"], R6: ["C_sum"], R7: ["O_add"], R8: ["S_board"], R9: ["O_del"], R10: ["F_enum2"], R11: ["F_c1"] };
const VER = {
  R1: { kind: "structural", reason: "x", checks: ["k-uniq", "k-req"] }, R2: { kind: "fixed-test" }, R3: { kind: "structural", reason: "x", checks: ["k-ref"] },
  R4: { kind: "default-value", value: "o0" }, R5: { kind: "enum-membership" }, R6: { kind: "fixed-test" }, R7: { kind: "fixed-test" }, R8: { kind: "structural", reason: "x", checks: ["k-group"] },
  R9: { kind: "fixed-test" }, R10: { kind: "enum-membership" }, R11: { kind: "structural", reason: "x", checks: ["k-c"] },
};
const compOf = new Map(COMPONENTS.map((c) => [c.symbol, c]));
/** 表を組む。idOf で id を、naming で name・role・source を替えられる。rowOver は記号 → 行の上書き */
function tableOf({ syms = SYMS_ALL, own = OWN, ver = VER, rowOver = {}, idOf = (s) => `id-${s}`, naming = (s, i) => ({ name: `n${i}`, role: "role", source: { requirementId: "R1", quote: "q" } }), extraRows = [] } = {}) {
  const rows = syms.map((s, i) => {
    const c = compOf.get(s);
    const type = c.kind === "computation" ? { ...c.type, aggregate: c.type.aggregate ? { kind: c.type.aggregate.kind, entity: idOf(c.type.aggregate.entity) } : null } : c.type;
    return {
      id: idOf(s), kind: c.kind, entity: c.entity === null ? null : idOf(c.entity), ...naming(s, i), type,
      options: c.options === null ? null : c.options.map((_, k) => `o${k}`),
      groupBy: c.groupBy === null ? null : { kind: c.groupBy.kind, field: idOf(c.groupBy.field) },
      refEntity: c.refEntity === null ? null : idOf(c.refEntity),
      ...(rowOver[s] ?? {}),
    };
  });
  return {
    table_sha256: sha("table"),
    rows: [...rows, ...extraRows],
    ownership: Object.entries(own).map(([r, ss]) => ({ requirementId: r, roles: ss.map((s) => ({ id: idOf(s), basis: "stated", reason: null })) })),
    verification: Object.entries(ver).map(([r, v]) => ({ requirementId: r, ...v })),
    classification: [],
  };
}
const score = (table, gold = goldOf()) => { const s = readSource("accepted", table); return scoreStructure(s.structure, s.meta, validateGold(gold)); };
const outcomeOf = (res, id) => res.requirements.find((q) => q.requirement_id === id);

// ── 計測の出力先と正解のディレクトリ（一時ディレクトリ）
function world({ golds = [goldOf()], runs = { "P1-r1": { accepted: tableOf() } }, frozen = null, extraConditions = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "table-score-"));
  const goldDir = join(base, "gold"), out = join(base, "out");
  mkdirSync(goldDir);
  golds.forEach((g, i) => writeFileSync(join(goldDir, `g${i}.json`), typeof g === "string" ? g : JSON.stringify(g)));
  // 現物と同じく、正解のディレクトリには .json 以外の文書も置かれる（読まない）
  writeFileSync(join(goldDir, "schema.md"), "{not json");
  writeFileSync(join(goldDir, "README.md"), "{not json");
  const measure = join(base, "m");
  writeMeasure(measure, { golds, runs, frozen, extraConditions });
  return { base, goldDir, measure, out, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
function writeMeasure(dir, { golds, runs, frozen = null, extraConditions = {} }) {
  mkdirSync(dir, { recursive: true });
  const gs = golds.filter((g) => typeof g === "object" && g !== null);
  const fz = frozen ?? { id: "set-x", version: 1, adopted: gs.map((g) => ({ pattern: g.pattern, plan_sha256: g.plan_sha256, source_sha256: sha("s") })), missing: [] };
  writeFileSync(join(dir, "conditions.json"), JSON.stringify({ schema: "x", child_args: Object.keys(runs).map((id) => ({ id })), frozen: fz, ...extraConditions }));
  for (const [id, r] of Object.entries(runs)) {
    mkdirSync(join(dir, id, "bundle", "artifacts"), { recursive: true });
    const plan = r.plan ?? (id.startsWith("P2") ? PLAN_B : PLAN_A);
    if (r.accepted) { writeFileSync(join(dir, id, SOURCE_PATHS.accepted), JSON.stringify(r.accepted)); writeFileSync(join(dir, id, BUILD_RECORD_PATH), JSON.stringify({ plan_sha256: r.recordPlan ?? plan })); }
    if (r.checkpoint) writeFileSync(join(dir, id, SOURCE_PATHS.checkpoint), JSON.stringify({ schema_version: "cp", boundary: "t1-t2", plan_sha256: r.checkpointPlan ?? plan, name_table: r.checkpoint }));
  }
}
const run = (w, flags = []) => main([w.goldDir, w.measure, w.out, ...flags]);
const outFiles = (w) => (existsSync(w.out) ? readdirSync(w.out) : []);

// ── 断り
test("断り：版が違う／必須の欄が欠ける／組の ID か版が違う／plan_sha256 が条件と違う／本の記録の plan_sha256 が違う → 何も数えず終了コード 3・固定の符号・出力無し", () => {
  const cases = [
    ["table-score:gold-version", { golds: [goldOf({ version: "table-gold-v0" })] }],
    ["table-score:gold-shape", { golds: [(({ components, ...g }) => g)(goldOf())] }],
    ["table-score:gold-shape", { golds: [goldOf({ requirements: [{ requirement_id: "R1", variants: [{ id: "v", required: ["F_a1"], allowed: [], verification: [{ kind: "fixed-test" }] }] }] })] }],
    // 現物の形が「断る」とした形：確かめ方の配列の長さが 1 以外・unexpressible.scope が「<設計族>-family-only」以外・plan_set の代わりに frozen_set・案が alternatives
    ["table-score:gold-shape", { golds: [goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R1" ? { ...r, variants: [{ ...r.variants[0], verification: [...r.variants[0].verification, { kind: "fixed-test" }] }] } : r)) })] }],
    ["table-score:gold-shape", { golds: [goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R1" ? { ...r, variants: [{ ...r.variants[0], verification: [] }] } : r)) })] }],
    ["table-score:gold-shape", { golds: [goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R1" ? { ...r, unexpressible: { reason_kind: "k", expected_handling: "carry-over", blocked_components: [], scope: "fam-a" } } : r)) })] }],
    ["table-score:gold-shape", { golds: [(({ plan_set, ...g }) => ({ ...g, frozen_set: { id: "set-x", version: 1 } }))(goldOf())] }],
    ["table-score:gold-shape", { golds: [goldOf({ requirements: REQS.map(({ variants, ...r }) => ({ ...r, alternatives: variants })) })] }],
    ["table-score:gold-shape", { golds: [goldOf({ plan_set: { id: "set-x", version: 1 } })] }],
    ["table-score:gold-shape", { golds: [goldOf({ plan_sha256: "short" })] }],
    ["table-score:frozen-set", { golds: [goldOf({ plan_set: { id: "set-y", version: 1, manifest_sha256: sha("manifest") } })] }],
    ["table-score:frozen-set", { golds: [goldOf({ plan_set: { id: "set-x", version: 2, manifest_sha256: sha("manifest") } })] }],
    ["table-score:plan-sha256-conditions", { frozen: { id: "set-x", version: 1, adopted: [{ pattern: "P1", plan_sha256: PLAN_X }], missing: [] } }],
    ["table-score:plan-sha256-run", { runs: { "P1-r1": { accepted: tableOf(), recordPlan: PLAN_X } } }],
    ["table-score:plan-sha256-run", { runs: { "P1-r1": { checkpoint: tableOf(), checkpointPlan: PLAN_X } } }],
    ["table-score:gold-unreadable", { golds: ["{not json"] }],
  ];
  for (const [code, opts] of cases) {
    const w = world(opts);
    try {
      const r = run(w);
      assert.equal(r.code, EXIT_REFUSED, code);
      assert.ok(r.text.includes(`[${code}]`), `${code}: ${r.text}`);
      assert.deepEqual(outFiles(w), [], code);
    } finally { w.cleanup(); }
  }
  // 引数が足りない
  assert.equal(main(["a", "b"]).code, EXIT_REFUSED);
});

test("任意の欄が全部無い合成の正解（部品と要件は配列）を受理する", () => {
  const bare = {
    version: GOLD_VERSION, pattern: "P1", plan_set: { id: "set-x", version: 1, manifest_sha256: sha("manifest") }, plan_sha256: PLAN_A, counts: {},
    components: [{ symbol: "E_a", kind: "entity", type: null }, { symbol: "F_a1", kind: "field", type: "string", entity: "E_a" }],
    requirements: [{ requirement_id: "R1", variants: [{ id: "v1", required: ["F_a1"], allowed: ["F_a1"], context: [], verification: [{ kind: "fixed-test" }] }] }],
    needs_human: [],
  };
  const w = world({ golds: [bare], runs: { "P1-r1": { accepted: tableOf({ syms: ["E_a", "F_a1"], own: { R1: ["F_a1"] }, ver: { R1: { kind: "fixed-test" } } }) } } });
  try {
    const r = run(w);
    assert.equal(r.code, 0, r.text);
    const out = JSON.parse(readFileSync(join(w.out, OUTPUT_FILE), "utf8"));
    assert.equal(out.scoring.rows[0].requirements[0].outcome, "correct");
  } finally { w.cleanup(); }
});

// ── 割り当てと 3 問
test("(a) 正解どおりの表は全要件 正答・割り当てられない行 0", () => {
  const res = score(tableOf());
  assert.deepEqual(res.requirements.map((q) => q.outcome), REQS.map(() => "correct"));
  assert.deepEqual(res.unassigned_rows, []);
  assert.equal(Object.keys(res.assignment).length, SYMS_ALL.length);
});

test("(b) 必要な項目の行を消した表で (i) 0。(b') 所属だけを外した表で (i) 0、context の部品の所属を外した表は 1", () => {
  const gone = score(tableOf({ syms: SYMS_ALL.filter((s) => s !== "F_a2"), own: { ...OWN, R2: ["F_a1"] } }));
  assert.equal(outcomeOf(gone, "R2").questions.missing, 0);
  assert.equal(outcomeOf(gone, "R2").outcome, "wrong");
  const unowned = score(tableOf({ own: { ...OWN, R2: ["F_a1"] } }));
  assert.equal(outcomeOf(unowned, "R2").questions.missing, 0);
  const ctx = score(tableOf({ own: { ...OWN, R2: ["F_a2"] } }));
  assert.equal(outcomeOf(ctx, "R2").questions.missing, 1);
  assert.equal(outcomeOf(ctx, "R2").outcome, "correct");
});

test("(b'') 任意の allowed の参照の部品とその参照先が両方無い表は正答、参照の部品を置いて参照先が無い表は非正答", () => {
  assert.equal(outcomeOf(score(tableOf()), "R4").outcome, "correct");
  const withOpt = score(tableOf({ syms: [...SYMS_ALL, "F_opt"], own: { ...OWN, R4: ["F_b1", "F_opt"] } }));
  assert.notEqual(outcomeOf(withOpt, "R4").outcome, "correct");
  // 参照先を在る別の entity にした表も非正答
  const elsewhere = score(tableOf({ syms: [...SYMS_ALL, "F_opt"], own: { ...OWN, R4: ["F_b1", "F_opt"] }, rowOver: { F_opt: { refEntity: "id-E_c" } } }));
  assert.notEqual(outcomeOf(elsewhere, "R4").outcome, "correct");
});

test("(c) 許す集合の外の行を所属させた表で (ii) 0。(d) 導いた親 entity の所属は過剰にしない", () => {
  const extra = score(tableOf({ own: { ...OWN, R3: ["F_ref", "F_a2"] } }));
  assert.equal(outcomeOf(extra, "R3").questions.excess, 0);
  assert.equal(outcomeOf(extra, "R3").outcome, "wrong");
  const derived = score(tableOf({ own: { ...OWN, R3: ["F_ref", "E_a"] } }));
  assert.equal(outcomeOf(derived, "R3").questions.excess, 1);
  assert.equal(outcomeOf(derived, "R3").outcome, "correct");
  // 参照先 entity は allowed に無いので、所属させれば過剰
  const refOwned = score(tableOf({ own: { ...OWN, R3: ["F_ref", "E_b"] } }));
  assert.equal(outcomeOf(refOwned, "R3").questions.excess, 0);
});

test("(e) checks の順を替えた表は 1、1 つ足した表は 0。(e') 同じ checks で assertions の対象が別の部品の行に当たる表は (iii) 0", () => {
  assert.equal(outcomeOf(score(tableOf({ ver: { ...VER, R1: { kind: "structural", reason: "x", checks: ["k-req", "k-uniq", "k-req"] } } })), "R1").questions.verification, 1);
  assert.equal(outcomeOf(score(tableOf({ ver: { ...VER, R1: { kind: "structural", reason: "x", checks: ["k-req", "k-uniq", "k-more"] } } })), "R1").questions.verification, 0);
  // 同じ checks のまま、R1 の所属を同じ型（string）の別の部品の行 F_b1 に替える：assertions の対象 F_a1 の行が所属に無い
  const moved = score(tableOf({ own: { ...OWN, R1: ["F_b1"] } }));
  assert.equal(outcomeOf(moved, "R1").questions.verification, 0);
  // assertions の expected が型と合わない（F_a1 の行の型を number にした表は割り当てが変わるので、正解の側の expected を替える）
  const typed = score(tableOf(), goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R1" ? { ...r, variants: [alt(["F_a1"], ["F_a1", "E_a"], ST(["k-req", "k-uniq"], [{ check: "k-req", target: "F_a1", expected: "number" }]))] } : r)) }));
  assert.equal(outcomeOf(typed, "R1").questions.verification, 0);
});

test("(e'') fixed-test：観測の対象の行が無ければ 0、意味だけが無い表は 1 で未照合の印。entity の validation を受理。操作が不適合なら 0", () => {
  const ok = outcomeOf(score(tableOf()), "R2");
  assert.equal(ok.questions.verification, 1);
  assert.ok(ok.marks.includes("semantics-unverified"));
  // 対象の行が無い（R7 の O_add を消す）
  const noTarget = outcomeOf(score(tableOf({ syms: SYMS_ALL.filter((s) => s !== "O_add"), own: { ...OWN, R7: [] } })), "R7");
  assert.equal(noTarget.questions.verification, 0);
  const g = (id, obs) => goldOf({ requirements: REQS.map((r) => (r.requirement_id === id ? { ...r, variants: [{ ...r.variants[0], verification: [FT(obs)] }] } : r)) });
  // entity を対象にした validation
  assert.equal(outcomeOf(score(tableOf(), g("R2", [{ target: "E_a", target_kind: "entity", operation: "validate" }])), "R2").questions.verification, 1);
  // compute を集計の計算に
  assert.equal(outcomeOf(score(tableOf(), g("R6", [{ target: "C_sum", target_kind: "computation", operation: "compute" }])), "R6").questions.verification, 0);
  // action を hasWhen 偽の操作に
  assert.equal(outcomeOf(score(tableOf(), g("R7", [{ target: "O_del", target_kind: "operation", operation: "action" }])), "R7").questions.verification, 0);
  // 種類が違う
  assert.equal(outcomeOf(score(tableOf(), g("R7", [{ target: "O_add", target_kind: "screen", operation: "screen" }])), "R7").questions.verification, 0);
});

test("(f) 基準の案で落ち別解で 3 問 1 の表は正答、別案の集合を合併すれば通る表は正答にしない", () => {
  const second = score(tableOf({ syms: [...SYMS_ALL, "C_expr"], own: { ...OWN, R9: ["C_expr"] }, ver: { ...VER, R9: { kind: "structural", reason: "x", checks: ["k-x"] } } }));
  assert.equal(outcomeOf(second, "R9").outcome, "correct");
  assert.equal(outcomeOf(second, "R9").alternative, 1);
  const merged = score(tableOf({ syms: [...SYMS_ALL, "C_expr"], own: { ...OWN, R9: ["O_del", "C_expr"] } }));
  assert.equal(outcomeOf(merged, "R9").outcome, "wrong");
});

test("(g) 同じ部品にしか当たらない 2 行はどちらも割り当てない", () => {
  const dup = { id: "id-dup", kind: "field", entity: "id-E_a", name: "dup", role: "r", source: null, type: "string", options: null, groupBy: null, refEntity: null };
  const res = score(tableOf({ own: { ...OWN, R1: ["F_a1", "dup"] }, extraRows: [dup], idOf: (s) => (s === "dup" ? "id-dup" : `id-${s}`) }));
  const idx = SYMS_ALL.indexOf("F_a1");
  assert.ok(res.unassigned_rows.includes(idx));
  assert.ok(res.unassigned_rows.includes(SYMS_ALL.length));
  assert.equal(res.assignment.F_a1, undefined);
  assert.equal(outcomeOf(res, "R1").outcome, "held");
  assert.equal(outcomeOf(res, "R1").hold, "unassignable-row");
});

test("(h) 保留：状態欄だけ・一覧だけも保留。一覧 2 回と関連 ID に重なっても件数 1。関連 ID だけの要件は二値で判定し印。未採用の candidates と一致する表を正答にしない", () => {
  // 保留の一覧の候補（現物の形）。表はこの候補と一致するが、候補は案として使わない
  const CAND = { owned: ["F_c1"], rows: [{ symbol: "F_c1", kind: "field", entity: "E_c", type: "date", refEntity: null, groupBy: null, options_count: null }], verification: { kind: "structural", checks: ["k-c"] }, accepted: false };
  const g = goldOf({
    requirements: REQS.map((r) => (r.requirement_id === "R10" ? { ...r, adjudication_status: "needs_human" } : r)),
    needs_human: [
      { requirement_id: "R11", reason_kind: "k1", source: "machine-review", related_requirement_ids: [], candidates: [CAND], question: TEXT, review_evidence: [TEXT] },
      { requirement_id: "R11", reason_kind: "k2", source: "independent-review", candidates: [], related_requirement_ids: ["R11", "R8"], question: TEXT },
    ],
  });
  const res = score(tableOf(), g);
  assert.equal(outcomeOf(res, "R10").outcome, "held");
  assert.equal(outcomeOf(res, "R10").hold, "needs-human");
  assert.equal(outcomeOf(res, "R11").outcome, "held");
  assert.equal(res.requirements.filter((q) => q.requirement_id === "R11").length, 1);
  assert.equal(outcomeOf(res, "R8").outcome, "correct");
  assert.ok(outcomeOf(res, "R8").marks.includes("related"));
  const agg = aggregate([{ run: "P1-r1", pattern: "P1", source: "accepted", checkpoint_also: false, ...res }], new Map([["P1", validateGold(g)]]), "accepted");
  assert.equal(agg.holds.static, 2);
  assert.equal(agg.denominators.b, REQS.length - 2);
});

test("(i) unresolved：accepted-removal は了承除外、unsupported-observation は持ち越し、verification_limit だけも持ち越し、どれも無い要件（alt の ID を含む）は (iii) 0", () => {
  const U = (reason_kind) => ({ kind: "unresolved", reason_kind });
  const g = goldOf({
    requirements: [
      ...REQS,
      { requirement_id: "U1", variants: [alt([], [], U("accepted-removal"))] },
      { requirement_id: "U2", variants: [alt([], [], U("unsupported-observation"))] },
      { requirement_id: "U3", variants: [alt([], [], FT([]))], verification_limit: { property: "state-after-set", expressible: false, supported_subproperties: [], expected_handling: TEXT } },
      { requirement_id: "U4-alt", variants: [alt([], [], FT([]))] },
    ],
  });
  const unres = { kind: "unresolved", reason: "x", constraintIds: [] };
  const res = score(tableOf({ ver: { ...VER, U1: unres, U2: unres, U3: unres, "U4-alt": unres } }), g);
  assert.equal(outcomeOf(res, "U1").outcome, "accepted-removal");
  assert.equal(outcomeOf(res, "U2").outcome, "carry-over");
  assert.equal(outcomeOf(res, "U3").outcome, "carry-over");
  assert.equal(outcomeOf(res, "U4-alt").outcome, "wrong");
  assert.equal(outcomeOf(res, "U4-alt").questions.verification, 0);
});

test("(i') unexpressible：scope 無しは全案で unresolved なら持ち越し・fixed-test なら過大な主張。設計族 scope で別の設計族の案に合う表は正答。案の中のものはその案だけ", () => {
  const g = goldOf({
    requirements: [
      ...REQS,
      { requirement_id: "X1", unexpressible: UX(), variants: [alt([], [], FT([])), alt([], [], ST(["k"]))] },
      { requirement_id: "X2", unexpressible: UX("fam-a-family-only"), scope: { excluded_parts: [{ id: "e1", disposition: "accepted_removal", text: TEXT }], alternatives: ["fam-a"] }, variants: [alt(["C_expr"], ["C_expr"], FT([]), [], { design_family: "fam-a" }), alt(["C_expr"], ["C_expr"], FT([]), [], { design_family: "fam-b" })] },
      { requirement_id: "X3", variants: [alt([], [], FT([]), [], { unexpressible: UX() }), alt(["C_expr"], ["C_expr"], ST(["k-y"]))] },
    ],
  });
  const unres = { kind: "unresolved", reason: "x", constraintIds: [] };
  const syms = [...SYMS_ALL, "C_expr"];
  const a = score(tableOf({ syms, ver: { ...VER, X1: unres, X2: { kind: "fixed-test" }, X3: { kind: "fixed-test" } }, own: { ...OWN, X2: ["C_expr"] } }), g);
  assert.equal(outcomeOf(a, "X1").outcome, "carry-over");
  assert.equal(outcomeOf(a, "X2").outcome, "correct");
  assert.equal(outcomeOf(a, "X2").alternative, 1);
  assert.equal(outcomeOf(a, "X3").outcome, "wrong");
  assert.ok(outcomeOf(a, "X3").marks.includes("overclaim"));
  const b = score(tableOf({ syms, ver: { ...VER, X1: { kind: "fixed-test" }, X3: { kind: "structural", reason: "x", checks: ["k-y"] } }, own: { ...OWN, X3: ["C_expr"] } }), g);
  assert.equal(outcomeOf(b, "X1").outcome, "wrong");
  assert.ok(outcomeOf(b, "X1").marks.includes("overclaim"));
  assert.equal(outcomeOf(b, "X3").outcome, "correct");
});

test("禁止の部品（案ごと）と方針：禁止の部品を所属に割り当てた案は選ばず、全案がそうなら保留。同数の最良の案に方針があれば保留。採った案の ID を出す", () => {
  const forb = goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R3" ? { ...r, variants: [{ ...r.variants[0], forbidden_components: ["F_ref"] }] } : r)) });
  const held = outcomeOf(score(tableOf(), forb), "R3");
  assert.equal(held.outcome, "held");
  assert.equal(held.hold, "alternative-unselectable");
  // 案 0 は禁止に当たり、案 1 で正答
  const two = goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R3" ? { ...r, variants: [{ ...r.variants[0], id: "va", forbidden_components: ["F_ref"] }, { ...r.variants[0], id: "vb" }] } : r)) });
  const ok = outcomeOf(score(tableOf(), two), "R3");
  assert.equal(ok.outcome, "correct");
  assert.equal(ok.variant_id, "vb");
  // 最良が同数で方針のある案を含む → 保留。方針が無ければ基準（先頭）で誤り
  const policy = { entity: "E_a", exact_fields: ["F_a1"], system_fields_excluded: true };
  const tie = (p) => goldOf({ requirements: REQS.map((r) => (r.requirement_id === "R7" ? { ...r, variants: [{ ...r.variants[0], id: "v0", verification: [{ kind: "structural", checks: ["a"] }], ...(p ? { entity_field_policy: policy } : {}) }, { ...r.variants[0], id: "v1", verification: [{ kind: "structural", checks: ["b"] }] }] } : r)) });
  assert.equal(outcomeOf(score(tableOf(), tie(true)), "R7").hold, "alternative-unselectable");
  const base = outcomeOf(score(tableOf(), tie(false)), "R7");
  assert.equal(base.outcome, "wrong");
  assert.equal(base.variant_id, "v0");
});

test("部品の semantics（意味）がある required は意味の未照合の印", () => {
  assert.ok(outcomeOf(score(tableOf()), "R5").marks.includes("semantics-unverified"));
  assert.ok(!outcomeOf(score(tableOf()), "R3").marks.includes("semantics-unverified"));
});

test("(j) name・id・role・source を全部置き換えても同じ結果。(l) source が全部 null の表も同じ結果", () => {
  const strip = (r) => ({ ...r, table_sha256: null });
  const base = score(tableOf());
  const renamed = score(tableOf({ idOf: (s) => `zz-${s.length}-${s.split("").reverse().join("")}`, naming: (s, i) => ({ name: `other${i}`, role: `x${i}`, source: { requirementId: "R9", quote: "other" } }) }));
  assert.deepEqual(strip(renamed), strip(base));
  const nulls = score(tableOf({ naming: (s, i) => ({ name: `n${i}`, role: "role", source: null }) }));
  assert.deepEqual(strip(nulls), strip(base));
});

test("(k) 選択肢の数が違う表は (i) 0、同じ数で未照合の印", () => {
  const two = outcomeOf(score(tableOf({ rowOver: { F_enum: { options: ["a", "b"] } } })), "R5");
  assert.equal(two.questions.missing, 0);
  const same = outcomeOf(score(tableOf({ rowOver: { F_enum: { options: ["x", "y", "z"] } } })), "R5");
  assert.equal(same.questions.missing, 1);
  assert.ok(same.marks.includes("semantics-unverified"));
});

test("(m) 型と所属が同じで参照先だけ違う 2 表は正しい接続の表だけ正答。groupBy の元も同様。指す行の無い参照は参照切れ（null と区別）で割り当て不能", () => {
  assert.equal(outcomeOf(score(tableOf()), "R3").outcome, "correct");
  assert.notEqual(outcomeOf(score(tableOf({ rowOver: { F_ref: { refEntity: "id-E_c" } } })), "R3").outcome, "correct");
  assert.equal(outcomeOf(score(tableOf()), "R8").outcome, "correct");
  assert.notEqual(outcomeOf(score(tableOf({ rowOver: { S_board: { groupBy: { kind: "enum", field: "id-F_enum2" } } } })), "R8").outcome, "correct");
  const broken = normalizeTable(tableOf({ rowOver: { F_ref: { refEntity: "id-nowhere" } } }));
  const none = normalizeTable(tableOf({ rowOver: { F_ref: { refEntity: null } } }));
  const i = SYMS_ALL.indexOf("F_ref");
  assert.equal(broken.rows[i].refs.ref_entity, BROKEN);
  assert.equal(none.rows[i].refs.ref_entity, null);
  const res = scoreStructure(broken, { table_sha256: null }, validateGold(goldOf()));
  assert.ok(res.unassigned_rows.includes(i));
  assert.equal(outcomeOf(res, "R3").hold, "unassignable-row");
});

// ── 集計
const GA_REQS = [
  { requirement_id: "A1", variants: [alt(["F_a1"], ["F_a1"], { kind: "fixed-test" })] },
  { requirement_id: "A2", variants: [alt(["F_a2"], ["F_a2"], { kind: "fixed-test" })] },
  { requirement_id: "A3", variants: [alt(["F_b1"], ["F_b1"], { kind: "fixed-test" })] },
  { requirement_id: "A4", variants: [alt(["F_c1"], ["F_c1"], { kind: "fixed-test" })] },
  { requirement_id: "A5", variants: [alt(["O_add"], ["O_add"], { kind: "fixed-test" }), alt([], [], { kind: "unresolved", reason_kind: "accepted-removal" })] },
  { requirement_id: "A6", adjudication_status: "needs_human", variants: [alt(["O_del"], ["O_del"], { kind: "fixed-test" })] },
];
const gaGold = (pattern = "P1", plan = PLAN_A) => goldOf({ pattern, plan_sha256: plan, requirements: GA_REQS });
const GA_OWN = { A1: ["F_a1"], A2: ["F_a2"], A3: ["F_b1"], A4: ["F_c1"], A5: ["O_add"], A6: ["O_del"] };
const GA_VER = Object.fromEntries(Object.keys(GA_OWN).map((k) => [k, { kind: "fixed-test" }]));
const gaTable = (ver = GA_VER) => tableOf({ syms: ["E_a", "E_b", "E_c", "F_a1", "F_a2", "F_b1", "F_c1", "O_add", "O_del"], own: GA_OWN, ver });

test("集計：予定 4 本・表あり 3 本・要件 6（静的な保留 1・了承除外 1）で (a) 14・(b) 20・未観測 5・候補依存 1。表なしの本が増えても (b) は変わらない", () => {
  const removal = gaTable({ ...GA_VER, A5: { kind: "unresolved", reason: "x", constraintIds: [] } });
  const w = world({ golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable() }, "P1-r2": { accepted: gaTable() }, "P1-r3": { accepted: removal }, "P1-r4": {} } });
  try {
    assert.equal(run(w).code, 0);
    const a = JSON.parse(readFileSync(join(w.out, OUTPUT_FILE), "utf8")).scoring.by_source.accepted;
    assert.equal(a.denominators.a, 14);
    assert.equal(a.denominators.b, 20);
    assert.equal(a.counts.unobserved, 5);
    assert.equal(a.counts.candidate_dependent, 1);
    assert.equal(a.outcomes["accepted-removal"], 1);
    assert.equal(a.outcomes.correct, 14);
    assert.equal(a.runs.no_table, 1);
    assert.equal(a.correct.b.rate, 0.7);
    assert.equal(a.correct.a.wilson95_reference.name, WILSON_NAME);
    assert.equal(a.pattern_interval.m, 1);
    assert.equal(a.pattern_interval.bootstrap.interval, null);
    assert.ok(a.pattern_interval.bootstrap.reason);
    assert.equal(a.pattern_interval.sign_flip, undefined);
  } finally { w.cleanup(); }
  const w2 = world({ golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable() }, "P1-r2": {}, "P1-r3": {}, "P1-r4": {} } });
  try {
    assert.equal(run(w2).code, 0);
    const a = JSON.parse(readFileSync(join(w2.out, OUTPUT_FILE), "utf8")).scoring.by_source.accepted;
    assert.equal(a.denominators.b, 20);
    assert.equal(a.denominators.a, 5);
  } finally { w2.cleanup(); }
});

test("集計：全要件が候補依存の非二値の本だけの組は分母 (a) 0・率 null と理由の符号", () => {
  const g = gaGold();
  const reqs = indexIds(g).map((id) => ({ requirement_id: id, outcome: id === "A6" ? "held" : "carry-over", hold: id === "A6" ? "needs-human" : null, questions: { missing: null, excess: null, verification: null }, marks: [] }));
  const a = aggregate([{ run: "P1-r1", pattern: "P1", source: "accepted", checkpoint_also: false, requirements: reqs, unassigned_rows: [] }], new Map([["P1", validateGold(g)]]), "accepted");
  assert.equal(a.denominators.a, 0);
  assert.equal(a.correct.a.rate, null);
  assert.equal(a.correct.a.reason_code, "denominator-zero");
  assert.equal(a.breakdown.missing.rate, null);
  assert.equal(a.pattern_interval.bootstrap.interval, null);
});
const indexIds = (g) => g.requirements.map((r) => r.requirement_id);

test("集計：P ごとの 0／1 からの bootstrap の区間が既存の関数の出力と深く等しい", () => {
  const golds = new Map([["P1", gaGold()], ["P2", gaGold("P2", PLAN_B)], ["P3", gaGold("P3", PLAN_X)]].map(([p, g]) => [p, validateGold(g)]));
  const q = (id, ok) => ({ requirement_id: id, outcome: ok ? "correct" : "wrong", hold: null, questions: { missing: ok ? 1 : 0, excess: 1, verification: 1 }, marks: [] });
  const held = { requirement_id: "A6", outcome: "held", hold: "needs-human", questions: { missing: null, excess: null, verification: null }, marks: [] };
  const mk = (run, pattern, oks) => ({ run, pattern, source: "accepted", checkpoint_also: false, requirements: [...oks.map((ok, i) => q(`A${i + 1}`, ok)), held], unassigned_rows: [] });
  const rows = [mk("P1-r1", "P1", [1, 1, 1, 0, 1]), mk("P1-r2", "P1", [1, 1, 1, 1, 1]), mk("P2-r1", "P2", [0, 0, 1, 1, 0]), mk("P3-r1", "P3", [1, 0, 1, 0, 1])];
  const a = aggregate(rows, golds, "accepted");
  const { sign_flip: _x, ...expected } = clusterStats({ P1: [1, 1, 1, 0, 1, 1, 1, 1, 1, 1], P2: [0, 0, 1, 1, 0], P3: [1, 0, 1, 0, 1] });
  assert.deepEqual(a.pattern_interval, expected);
  assert.equal(a.pattern_interval.m, 3);
  assert.ok(Array.isArray(a.pattern_interval.bootstrap.interval));
  assert.equal(a.breakdown.missing.k, 6);
});

// ── 読取元
test("読取元：受理済みの表と checkpoint の採点の構造が深く等しく同じ結果、表の SHA は両方同じ非 null。両方ある本は受理済みを採る。表の無い本は表なしで (a) に入らない", () => {
  const t = tableOf();
  const acc = readSource("accepted", t), cp = readSource("checkpoint", { plan_sha256: PLAN_A, name_table: t });
  assert.deepEqual(acc.structure, cp.structure);
  assert.equal(acc.meta.table_sha256, cp.meta.table_sha256);
  assert.notEqual(acc.meta.table_sha256, null);
  const text = JSON.stringify(acc.structure);
  for (const w of ["id-F_a1", "role", "\"n0\"", "quote"]) assert.ok(!text.includes(w), w);
  assert.deepEqual(scoreStructure(acc.structure, acc.meta, validateGold(goldOf())), scoreStructure(cp.structure, cp.meta, validateGold(goldOf())));
  const w = world({ runs: { "P1-r1": { accepted: tableOf(), checkpoint: tableOf({ ver: { ...VER, R1: { kind: "fixed-test" } } }) }, "P1-r2": { checkpoint: tableOf() }, "P1-r3": {} } });
  try {
    assert.equal(run(w).code, 0);
    const out = JSON.parse(readFileSync(join(w.out, OUTPUT_FILE), "utf8"));
    const [r1, r2, r3] = out.scoring.rows;
    assert.equal(r1.source, "accepted");
    assert.equal(r1.checkpoint_also, true);
    assert.equal(outcomeOf(r1, "R1").outcome, "correct");
    assert.equal(r2.source, "checkpoint");
    assert.equal(r3.source, null);
    const acc2 = out.scoring.by_source.accepted, cp2 = out.scoring.by_source.checkpoint;
    assert.equal(acc2.runs.with_table, 1);
    assert.equal(acc2.runs.checkpoint_also, 1);
    assert.equal(acc2.denominators.a, REQS.length);
    assert.equal(cp2.runs.with_table, 1);
    assert.equal(acc2.runs.no_table, 1);
  } finally { w.cleanup(); }
});

// ── 比較
const rowOf = (runId, oks) => ({ run: runId, pattern: runId.split("-")[0], source: "accepted", checkpoint_also: false, unassigned_rows: [], requirements: oks.map((o, i) => ({ requirement_id: `A${i + 1}`, outcome: o === null ? "carry-over" : o === "h" ? "held" : o === "x" ? "accepted-removal" : o ? "correct" : "wrong", hold: o === "h" ? "needs-human" : null, questions: { missing: null, excess: null, verification: null }, marks: [] })) });
test("比較：対 3（＋1・0・−1）で要件の差・本と P の平均が手計算と一致し、P のまとまりは既存の関数と深く等しい。片側でも非二値・片側に表の無い対は差 null で理由の件数", () => {
  const base = [rowOf("P1-r1", [0, 1, 1, null]), rowOf("P1-r2", [1, 1, "h", 1]), rowOf("P2-r1", [1, 0, 1, 1]), { ...rowOf("P2-r2", [1]), requirements: null }];
  const cand = [rowOf("P1-r1", [1, 1, 1, 1]), rowOf("P1-r2", [1, 1, 1, "x"]), rowOf("P2-r1", [0, 0, 1, 1]), rowOf("P2-r2", [1])];
  const c = compareRows(base, cand);
  // 差：P1-r1 [+1, 0, 0]、P1-r2 [0, 0]、P2-r1 [−1, 0, 0, 0]
  assert.deepEqual(c.requirement_diffs, pairStats([1, 0, 0, 0, 0, -1, 0, 0, 0]));
  assert.deepEqual(c.requirement_diffs.counts, { "+1": 1, 0: 7, "-1": 1 });
  assert.deepEqual(c.pairs.map((p) => p.mean), [round(1 / 3), 0, -0.25, null]);
  assert.deepEqual(c.excluded, { "table-absent": 1, "non-binary": 3 });
  assert.deepEqual(c.pattern_clusters, clusterStats({ P1: [1 / 3, 0], P2: [-0.25] }));
  assert.equal(c.pattern_clusters.by_pattern.P1, round(1 / 6));
});
const round = (x) => Math.round(x * 1e6) / 1e6;

test("比較：比較の記録の群（baseline・candidate）を読み、同じ P・同じ回の本を対にする（ファイルから）", () => {
  const base = mkdtempSync(join(tmpdir(), "table-score-cmp-"));
  try {
    const goldDir = join(base, "gold"), m = join(base, "m"), out = join(base, "out");
    mkdirSync(goldDir);
    writeFileSync(join(goldDir, "p1.json"), JSON.stringify(gaGold()));
    mkdirSync(m);
    writeFileSync(join(m, "comparison.json"), JSON.stringify({ schema: "x", pairs: { groups: ["before", "after"] } }));
    writeMeasure(join(m, "before"), { golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable({ ...GA_VER, A1: { kind: "structural", reason: "x", checks: [] } }) }, "P1-r2": {} } });
    writeMeasure(join(m, "after"), { golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable() }, "P1-r2": { accepted: gaTable() } } });
    const r = main([goldDir, m, out, "--compare"]);
    assert.equal(r.code, 0, r.text);
    const o = JSON.parse(readFileSync(join(out, COMPARE_FILE), "utf8"));
    assert.equal(o.schema, COMPARE_SCHEMA);
    const c = o.scoring.by_source.accepted.compare;
    assert.deepEqual(c.requirement_diffs.counts, { "+1": 1, 0: 4, "-1": 0 });
    assert.equal(c.excluded["table-absent"], 1);
    assert.equal(c.excluded["non-binary"], 1);
    assert.ok(r.text.includes("差 n 5"));
    // 匿名の口（比較）
    const ra = main([goldDir, m, out, "--compare", "--anonymous"]);
    assert.equal(ra.code, 0);
    const anonText = readFileSync(join(out, anonymousFileOf(COMPARE_FILE)), "utf8");
    assert.deepEqual(JSON.parse(anonText), anonymize(o));
    assert.doesNotMatch(anonText, /P\d+|-r\d|"A\d|before|after|[0-9a-f]{64}|fingerprint/);
    // 比較の記録が無ければ断る
    rmSync(join(m, "comparison.json"));
    const out2 = join(base, "out2");
    const r2 = main([goldDir, m, out2, "--compare"]);
    assert.equal(r2.code, EXIT_REFUSED);
    assert.ok(r2.text.includes("[table-score:compare-record]"));
    assert.ok(!existsSync(out2));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ── 出力・指紋・匿名
test("同じ入力で 2 回同じ出力。指紋は道具のファイルの SHA-256 で採点の欄と別。正解の文の欄が無い。匿名の口に P の番号・本の ID・要件 ID・記号・パス・SHA が無い", () => {
  const golds = [goldOf({ needs_human: [{ requirement_id: "R10", reason_kind: "k", source: "machine-review", related_requirement_ids: [], candidates: [], question: TEXT, review_evidence: [TEXT] }] })];
  const w = world({ golds, runs: { "P1-r1": { accepted: tableOf() }, "P1-r2": { checkpoint: tableOf() } } });
  try {
    assert.equal(run(w).code, 0);
    const first = readFileSync(join(w.out, OUTPUT_FILE), "utf8");
    rmSync(w.out, { recursive: true });
    const r = run(w);
    assert.equal(r.code, 0);
    const second = readFileSync(join(w.out, OUTPUT_FILE), "utf8");
    assert.equal(first, second);
    const out = JSON.parse(first);
    assert.equal(out.schema, OUTPUT_SCHEMA);
    assert.equal(out.fingerprint.tool_sha256, sha(readFileSync(join(here, "score-table.mjs"))));
    assert.ok(!JSON.stringify(out.scoring).includes(out.fingerprint.tool_sha256));
    assert.ok(!first.includes(TEXT));
    for (const k of ["quote", "meaning", "question", "exclusion", "candidates"]) assert.ok(!first.includes(`"${k}"`), k);
    // 標準出力の要約
    for (const w2 of ["正答", "欠け", "過剰", "確かめ方", "分母", "割り当てられない行", "表なし", "P の区間"]) assert.ok(r.text.includes(w2), w2);
    assert.ok(OUTCOMES.every((o) => r.text.includes(o)));
    // 匿名
    const ra = run(w, ["--anonymous"]);
    assert.equal(ra.code, 0);
    const anonText = readFileSync(join(w.out, anonymousFileOf(OUTPUT_FILE)), "utf8");
    const anon = JSON.parse(anonText);
    assert.equal(anon.schema, ANONYMOUS_SCHEMA);
    assert.deepEqual(anon, anonymize(out));
    assert.doesNotMatch(anonText, /P\d+|-r\d|"R\d|E_a|F_a1|[0-9a-f]{64}|tool_sha256|fingerprint/);
    for (const s of COMPONENTS.map((c) => c.symbol)) assert.ok(!anonText.includes(s), s);
    assert.ok(!anonText.includes(w.base));
  } finally { w.cleanup(); }
});

test("割り当ての探索は決定的で、assignRows は P 全体で一貫する（同じ構造で同じ割り当て）", () => {
  const s = normalizeTable(tableOf());
  assert.deepEqual(assignRows(s, validateGold(goldOf())), assignRows(s, validateGold(goldOf())));
  assert.equal(assignRows(s, validateGold(goldOf())).limit, false);
});

// ── 静的な走査・題材の言葉・README
test("静的な走査：道具に工場の package の import・通信・LLM・判定の口が無い。工場の側はこの道具を参照しない", () => {
  const src = readFileSync(join(here, "score-table.mjs"), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /from\s+["']@musunest\//);
  assert.doesNotMatch(code, /from\s+["'][^"']*packages\//);
  assert.doesNotMatch(code, /require\(|import\(/);
  const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["../agent-accept/score-agent.mjs", "node:crypto", "node:fs", "node:path", "node:url"]);
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|node:(http|https|net|tls|dgram|child_process)|openai|anthropic|process\.env|new Date\(|Date\.now\(|\bjudge[A-Z(]|\bjev\b/i);
  const walkSrc = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === "node_modules" || n === "dist") return [];
    return statSync(p).isDirectory() ? walkSrc(p) : /\.(ts|tsx|mjs|js|json)$/.test(n) ? [p] : [];
  });
  for (const f of walkSrc(join(root, "packages"))) assert.ok(!readFileSync(f, "utf8").includes("score-table"), relative(root, f));
});

const readme = () => readFileSync(join(here, "../README.md"), "utf8");
const SECTION_HEAD = "## 7. 表の採点（正解の表との照合）";
test("題材の言葉：試験・fixture・README の新しい節・試験のファイル自身に無い", () => {
  // 語は符号の列で持つ（この試験のファイル自身に書かない）
  const words = [[0x6301, 0x3061, 0x5bc4, 0x308a], [0x5f53, 0x756a, 0x8868], [0x4f1a, 0x8cbb], [0x51fa, 0x6b20], [0x8cb8, 0x3057, 0x51fa, 0x3057]].map((cs) => String.fromCodePoint(...cs));
  const text = readme();
  const texts = [readFileSync(fileURLToPath(import.meta.url), "utf8"), readFileSync(join(here, "score-table.mjs"), "utf8"), text.slice(text.indexOf(SECTION_HEAD)), JSON.stringify([goldOf(), tableOf(), gaGold(), gaTable()])];
  for (const t of texts) for (const word of words) assert.ok(!t.includes(word), word);
});

test("README：表の採点の節があり、やることの項目が載る。既存の節の文が変わらない", () => {
  const text = readme();
  const at = text.indexOf(SECTION_HEAD);
  assert.ok(at > 0);
  // 既存の部分（新しい節の前）は #606 の前の README とバイト列まで同じ
  assert.equal(sha(text.slice(0, at - 1)), "ecf45bc68edac023c1250cb5e15abb4312b6c9a1476eda467db6a04c01d54e1d");
  const sec = text.slice(at);
  for (const item of [
    "table-gold-v1", "plan_sha256", "終了コード 3", "任意の欄", "正規化", "参照切れ", "割り当て", "割り当てられない行", "欠け", "過剰", "確かめ方",
    "正答", "誤り", "正直な持ち越し", "了承除外", "保留", "unexpressible", "accepted-removal", "分母 (a)", "分母 (b)", "静的な保留", "候補依存", "意味の未照合",
    "P を単位", "bootstrap", "参考（独立を仮定）", "--compare", "after − before", "--anonymous", "指紋", "門ではない", "非公開", "費用 0", "checkpoint", "受理済みの表",
  ]) assert.ok(sec.includes(item), item);
});
