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
import { CONDITIONS_V6, CONDITIONS_V8, clusterStats, pairStats } from "../agent-accept/score-agent.mjs";
import {
  ANONYMOUS_SCHEMA, BROKEN, COMPARE_FILE, COMPARE_SCHEMA, EXIT_REFUSED, GOLD_VERSION, OUTCOMES, OUTPUT_FILE, OUTPUT_SCHEMA, SOURCE_PATHS, BUILD_RECORD_PATH, WILSON_NAME,
  aggregate, runSources, anonymize, anonymousFileOf, assignRows, compareRows, main, normalizeTable, readSource, scoreStructure, validateGold,
  DRAFT_PATH, SEMANTIC_RECORD_PATHS, draftStructure,
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
    if (r.checkpoint) writeFileSync(join(dir, id, SOURCE_PATHS.checkpoint), JSON.stringify({ schema_version: "cp", boundary: "t1-t2", plan_sha256: r.checkpointPlan ?? plan, name_table: r.checkpoint, ...(r.checkpointSemantic ? { semantic_check: r.checkpointSemantic } : {}) }));
    // 2 本目（#607）：断った候補の記録と、受理済みの表の点検の記録（無ければ書かない）
    if (r.drafts !== undefined && !r.accepted && !r.noRecord) writeFileSync(join(dir, id, BUILD_RECORD_PATH), JSON.stringify({ plan_sha256: r.recordPlan ?? plan }));
    if (r.drafts !== undefined) { mkdirSync(join(dir, id, "bundle", "diagnostics"), { recursive: true }); writeFileSync(join(dir, id, DRAFT_PATH), typeof r.drafts === "string" ? r.drafts : JSON.stringify({ candidates: r.drafts })); }
    if (r.semantic !== undefined) writeFileSync(join(dir, id, SEMANTIC_RECORD_PATHS.accepted), typeof r.semantic === "string" ? r.semantic : JSON.stringify(r.semantic));
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
const CASES_DIR = join(here, "cases");
const caseFiles = () => readdirSync(CASES_DIR).filter((n) => n.endsWith(".json")).sort();
const SECTION_HEAD = "## 7. 表の採点（正解の表との照合）";
test("題材の言葉：試験・fixture・README の新しい節・試験のファイル自身に無い", () => {
  // 語は符号の列で持つ（この試験のファイル自身に書かない）
  const words = [[0x6301, 0x3061, 0x5bc4, 0x308a], [0x5f53, 0x756a, 0x8868], [0x4f1a, 0x8cbb], [0x51fa, 0x6b20], [0x8cb8, 0x3057, 0x51fa, 0x3057]].map((cs) => String.fromCodePoint(...cs));
  const text = readme();
  const texts = [readFileSync(fileURLToPath(import.meta.url), "utf8"), readFileSync(join(here, "score-table.mjs"), "utf8"), text.slice(text.indexOf(SECTION_HEAD)), JSON.stringify([goldOf(), tableOf(), gaGold(), gaTable()]), ...caseFiles().map((f) => readFileSync(join(CASES_DIR, f), "utf8"))];
  for (const t of texts) for (const word of words) assert.ok(!t.includes(word), word);
});

test("README：表の採点の節があり、やることの項目が載る。既存の節の文が変わらない", () => {
  const text = readme();
  const at = text.indexOf(SECTION_HEAD);
  assert.ok(at > 0);
  // 既存の部分（新しい節の前）は #606 の前の README とバイト列まで同じ
  assert.equal(sha(text.slice(0, at - 1)), "662d41ded93107ecd130dfa090b09df1280ec78277509d131bf21b253e82cba4");
  const sec = text.slice(at);
  for (const item of [
    "table-gold-v1", "plan_sha256", "終了コード 3", "任意の欄", "正規化", "参照切れ", "割り当て", "割り当てられない行", "欠け", "過剰", "確かめ方",
    "正答", "誤り", "正直な持ち越し", "了承除外", "保留", "unexpressible", "accepted-removal", "分母 (a)", "分母 (b)", "静的な保留", "候補依存", "意味の未照合",
    "P を単位", "bootstrap", "参考（独立を仮定）", "--compare", "after − before", "--anonymous", "指紋", "門ではない", "非公開", "費用 0", "checkpoint", "受理済みの表",
  ]) assert.ok(sec.includes(item), item);
});

// ── 2 本目（#607）：1 本目の欄が変わらないこと
/** 1 本目の採点の欄（読取元 (a)・(b) の集計と行ごとの出力）だけを抜いた値の SHA-256。正解の文・指紋は入らない */
const firstFieldsSha = (full) => {
  const { accepted, checkpoint } = full.scoring.by_source;
  return sha(JSON.stringify({ by_source: { accepted, checkpoint }, rows: full.scoring.rows }));
};
const firstAnonSha = (anon) => sha(JSON.stringify({ schema: anon.schema, mode: anon.mode, by_source: anon.by_source }));
function firstFixtureSingle() {
  const golds = [goldOf({ needs_human: [{ requirement_id: "R10", reason_kind: "k", source: "machine-review", related_requirement_ids: [], candidates: [], question: TEXT, review_evidence: [TEXT] }] })];
  return world({ golds, runs: { "P1-r1": { accepted: tableOf() }, "P1-r2": { checkpoint: tableOf({ own: { ...OWN, R3: ["F_ref", "F_a2"] } }) }, "P1-r3": {} } });
}
function firstFixtureCompare() {
  const base = mkdtempSync(join(tmpdir(), "table-score-first-"));
  const goldDir = join(base, "gold"), m = join(base, "m"), out = join(base, "out");
  mkdirSync(goldDir);
  writeFileSync(join(goldDir, "p1.json"), JSON.stringify(gaGold()));
  mkdirSync(m);
  writeFileSync(join(m, "comparison.json"), JSON.stringify({ schema: "x", pairs: { groups: ["before", "after"] } }));
  writeMeasure(join(m, "before"), { golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable({ ...GA_VER, A1: { kind: "structural", reason: "x", checks: [] } }) }, "P1-r2": {} } });
  writeMeasure(join(m, "after"), { golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable() }, "P1-r2": { checkpoint: gaTable() } } });
  return { base, goldDir, measure: m, out, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
test("1 本目の fixture で、指紋を除いた 1 本目の採点の欄（と匿名の既存の欄）が 1 本目の道具の出力と深く等しい", () => {
  for (const [mk, file, flag, expected, expectedAnon] of [
    [firstFixtureSingle, OUTPUT_FILE, [], "5096d8491742f9d0f46c36ab47e60e657fce1fa189e03536b6ed3908595655c8", "4733577f91a622c147bbaf3cd52b8f8b82172b95e9b258026b55c7dcf2158d52"],
    [firstFixtureCompare, COMPARE_FILE, ["--compare"], "d6dff12607eed6f77edfeae3eecba8acf27b473104d19717044c7eb37c429111", "781438c694e272742f3e6251c7dcc87787873856f8a44a11408aab3b0b87cdc7"],
  ]) {
    const w = mk();
    try {
      assert.equal(run(w, flag).code, 0);
      const full = JSON.parse(readFileSync(join(w.out, file), "utf8"));
      assert.equal(run(w, [...flag, "--anonymous"]).code, 0);
      const anon = JSON.parse(readFileSync(join(w.out, anonymousFileOf(file)), "utf8"));
      assert.equal(firstFieldsSha(full), expected);
      assert.equal(firstAnonSha(anon), expectedAnon);
    } finally { w.cleanup(); }
  }
});

// ── 2 本目（#607）：断った候補の下書き (c)
const QUOTE = "QUOTEMARK", REASON = "REASONMARK"; // 点検の引用・拒否の理由・出典の写しに入れる目印（出力に写っていないことを走査する）
/** 表の行の型（1 本目の形）を、下書きの平らな写像にする */
const flatType = (row) => {
  const f = { fieldType: null, valueType: null, scope: null, form: null, action: null, hasWhen: null, view: null };
  if (row.kind === "field") f.fieldType = row.type;
  if (row.kind === "computation") Object.assign(f, { valueType: row.type.valueType, scope: row.type.scope, form: row.type.form, aggregate: row.type.aggregate });
  if (row.kind === "operation") Object.assign(f, { action: row.type.action, hasWhen: row.type.hasWhen });
  if (row.kind === "screen") f.view = row.type.view;
  return f;
};
/** 合成の表から、同じ内容の下書き（応答）と点検の一覧を組む。要件の並びは確かめ方の並び（＝一覧の順） */
function draftOf(table, { copy = (i) => `copy${i}`, source = () => ({ copy: QUOTE, quote: QUOTE }) } = {}) {
  const ids = table.verification.map((v) => v.requirementId);
  const response = {
    rows: table.rows.map((r, i) => ({ id: r.id, kind: r.kind, entity: r.entity, name: r.name, role: r.role, source: source(i), type: flatType(r), options: r.options, groupBy: r.groupBy, refEntity: r.refEntity })),
    requirements: ids.map((id, i) => {
      const { requirementId: _x, ...v } = table.verification[i];
      return { copy: copy(i), roles: table.ownership.find((o) => o.requirementId === id)?.roles ?? [], verification: v, nature: "ruled" };
    }),
  };
  return { response, list: { requirements: ids.map((id) => ({ id, text: QUOTE, quote: QUOTE })) } };
}
const candidateOf = (table, { round = 1, attempt = 1, call = 1, kind = "content", list, opts: o } = {}) => {
  const d = draftOf(table, o);
  if (kind === "shape") return { stage: "name-table", operation: null, call, round, attempt, kind, response: d.response, response_sha256: sha("r"), problems: [{ field: "rows", message: REASON, reference: "response" }] };
  return { stage: "name-table", operation: null, call, round, attempt, kind, target: d.response, target_sha256: sha("t"), response: d.response, response_sha256: sha("r"), ...(list === null ? {} : { inspection_list: list ?? d.list, inspection_list_sha256: sha("l") }), problems: [{ field: "rows", message: REASON, reference: "target" }] };
};
const DR_REQS = GA_REQS.slice(0, 4);
const drGold = () => goldOf({ requirements: DR_REQS });
const drVer = Object.fromEntries(DR_REQS.map((r) => [r.requirement_id, { kind: "fixed-test", reason: null, checks: [], constraintIds: [], value: null }]));
const drTable = (syms, own) => tableOf({ syms, own, ver: drVer });
const readOut = (w, file = OUTPUT_FILE) => JSON.parse(readFileSync(join(w.out, file), "utf8"));

test("下書き：1 本に候補 2 つ（先が正答 3・後が正答 1 の要件 4）で、採点されるのは後だけ・率は 1 を超えず・候補の数 2。先にだけ在る部品は後の採点で欠け（合併しない）", () => {
  const first = drTable(["E_a", "E_b", "E_c", "F_a1", "F_a2", "F_b1"], { A1: ["F_a1"], A2: ["F_a2"], A3: ["F_b1"], A4: [] });
  const later = drTable(["E_a", "E_c", "F_a1"], { A1: ["F_a1"], A2: [], A3: [], A4: [] });
  // 記録の並びは後の候補が先（並びではなく round・attempt・call で最後を選ぶ）
  const w = world({ golds: [drGold()], runs: { "P1-r1": { drafts: [candidateOf(later, { round: 2, attempt: 1, call: 2 }), candidateOf(first, { round: 1, attempt: 1, call: 1 })] } } });
  try {
    assert.equal(run(w).code, 0);
    const out = readOut(w);
    const [d] = out.scoring.draft_rows;
    assert.equal(d.candidate_count, 2);
    assert.deepEqual(d.last, { round: 2, attempt: 1, call: 2 });
    assert.equal(d.source, "draft");
    assert.equal(d.table_sha256, null);
    assert.deepEqual(d.requirements.map((q) => q.outcome), ["correct", "wrong", "wrong", "wrong"]);
    assert.equal(outcomeOf(d, "A2").questions.missing, 0);
    assert.equal(outcomeOf(d, "A3").questions.missing, 0);
    const a = out.scoring.draft;
    assert.equal(a.correct.a.k, 1);
    assert.equal(a.denominators.a, 4);
    assert.ok(a.correct.a.rate <= 1 && a.correct.b.rate <= 1);
    assert.equal(a.draft.candidate_total, 2);
    assert.equal(a.draft.scored_runs, 1);
    // 1 本目の読取元には入らない
    assert.equal(out.scoring.rows[0].source, null);
    assert.equal(out.scoring.by_source.accepted.denominators.a, 0);
  } finally { w.cleanup(); }
});

test("下書き：受理済みの表・checkpoint・下書き（平らな type）が同じ内容なら採点の構造と結果が深く等しく、表の SHA は受理済みと checkpoint が同じ非 null・下書きが null。正誤表はその SHA で点検の回に結ぶ", () => {
  const t = tableOf();
  const acc = readSource("accepted", t), cp = readSource("checkpoint", { plan_sha256: PLAN_A, name_table: t });
  const d = draftOf(t), dr = draftStructure(d.response, d.list);
  assert.deepEqual(dr.structure, acc.structure);
  assert.deepEqual(cp.structure, acc.structure);
  const g = validateGold(goldOf());
  const { table_sha256: sa, ...ra } = scoreStructure(acc.structure, acc.meta, g);
  const { table_sha256: sc, ...rc } = scoreStructure(cp.structure, cp.meta, g);
  const { table_sha256: sd, ...rd } = scoreStructure(dr.structure, { table_sha256: null }, g);
  assert.deepEqual(rd, ra);
  assert.deepEqual(rc, ra);
  assert.equal(sa, sha("table"));
  assert.equal(sc, sa);
  assert.equal(sd, null);
  const sem = (s) => ({ table_sha256: s, targets: ["R1", "R2"], judgments: [{ requirementId: "R1", verdict: "accept", kind: null, quote: null }, { requirementId: "R2", verdict: "reject", kind: "missing-target", quote: QUOTE }] });
  const w = world({ runs: { "P1-r1": { accepted: t, semantic: { rounds: [{ round: 1, ...sem(sha("table")), advice: [] }] } }, "P1-r2": { checkpoint: t, checkpointSemantic: sem(sha("table")) }, "P1-r3": { drafts: [candidateOf(t)] } } });
  try {
    assert.equal(run(w).code, 0);
    const out = readOut(w);
    const [r1, r2] = out.scoring.rows;
    assert.equal(r1.table_sha256, sha("table"));
    assert.equal(r2.table_sha256, sha("table"));
    assert.equal(out.scoring.draft_rows[2].table_sha256, null);
    assert.deepEqual(out.scoring.draft_rows[2].requirements, r1.requirements);
    const [c1, c2, c3] = out.scoring.c3_rows;
    assert.equal(c1.record, "matched");
    assert.equal(c1.round, 1);
    assert.equal(c2.record, "matched");
    assert.equal(c3, null);
    assert.deepEqual(c1.cells, { wrong_accept: 0, wrong_reject: 0, correct_accept: 1, correct_reject: 1 });
    assert.deepEqual(c2.cells, c1.cells);
    assert.equal(out.scoring.c3.accepted.runs.with_record, 1);
    assert.equal(out.scoring.c3.checkpoint.runs.with_record, 1);
  } finally { w.cleanup(); }
});

test("下書き：参照の ID を添字へ結び直し、参照先だけが違う 2 つの下書きで正しい接続だけが正答。出典の写し・引用・要件の写しを全部置き換えても同じ結果", () => {
  const g = validateGold(goldOf());
  const scoreDraft = (t, o) => { const d = draftOf(t, o); return scoreStructure(draftStructure(d.response, d.list).structure, { table_sha256: null }, g); };
  assert.equal(outcomeOf(scoreDraft(tableOf()), "R3").outcome, "correct");
  assert.notEqual(outcomeOf(scoreDraft(tableOf({ rowOver: { F_ref: { refEntity: "id-E_c" } } })), "R3").outcome, "correct");
  // id を全部替えても同じ（結び直したあと id は落ちる）
  assert.deepEqual(scoreDraft(tableOf({ idOf: (s) => `q-${s}-q` })), scoreDraft(tableOf()));
  const base = scoreDraft(tableOf());
  const other = scoreDraft(tableOf(), { copy: (i) => `other-copy-${i}`, source: (i) => ({ copy: `zz${i}`, quote: `yy${i}` }) });
  assert.deepEqual(other, base);
});

test("下書き：最後の候補が読めない（一覧が無い・形の失敗・数が合わない）本は「読めない候補」1 で採点されず、古い候補を使わない", () => {
  const good = tableOf();
  const cases = [
    ["no-list", candidateOf(good, { round: 2, list: null })],
    ["shape", candidateOf(good, { round: 2, kind: "shape" })],
    ["count-mismatch", candidateOf(good, { round: 2, list: { requirements: [...draftOf(good).list.requirements, { id: "R99", text: QUOTE, quote: QUOTE }] } })],
    ["shape", { ...candidateOf(good, { round: 2 }), response: { rows: "x", requirements: [] } }],
  ];
  for (const [reason, last] of cases) {
    const w = world({ runs: { "P1-r1": { drafts: [candidateOf(good, { round: 1 }), last] } } });
    try {
      assert.equal(run(w).code, 0, reason);
      const out = readOut(w);
      const [d] = out.scoring.draft_rows;
      assert.equal(d.unreadable, reason);
      assert.equal(d.source, null, reason);
      assert.equal(d.requirements, null, reason);
      assert.equal(d.candidate_count, 2);
      assert.equal(out.scoring.draft.draft.unreadable[reason], 1, reason);
      assert.equal(out.scoring.draft.draft.scored_runs, 0);
      assert.equal(out.scoring.draft.denominators.a, 0);
      assert.equal(out.scoring.draft.correct.a.rate, null);
    } finally { w.cleanup(); }
  }
  // 記録のファイルが読めない本も読めない候補（断らない）
  const w = world({ runs: { "P1-r1": { drafts: "{not json" } } });
  try {
    assert.equal(run(w).code, 0);
    assert.equal(readOut(w).scoring.draft_rows[0].unreadable, "file");
  } finally { w.cleanup(); }
});

test("下書き：受理済みの表と下書きの両方がある本は、それぞれの読取元に 1 回ずつ数え混ざらない。(c) の率は (a)・(b) の欄と別で、--compare の対に入らない", () => {
  const solo = world({ golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable() }, "P1-r2": {} } });
  const both = world({ golds: [gaGold()], runs: { "P1-r1": { accepted: gaTable(), drafts: [candidateOf(gaTable({ ...GA_VER, A1: { kind: "structural", checks: [] } }))] }, "P1-r2": {} } });
  try {
    assert.equal(run(solo).code, 0);
    assert.equal(run(both).code, 0);
    const a = readOut(solo).scoring, b = readOut(both).scoring;
    assert.deepEqual(b.by_source, a.by_source);
    assert.deepEqual(b.rows, a.rows);
    assert.equal(b.by_source.accepted.runs.with_table, 1);
    assert.equal(b.draft.runs.with_table, 1);
    assert.equal(b.draft.denominators.a, 5);
    assert.equal(b.draft.correct.a.k, 4);
    assert.equal(b.draft.denominators.b, 10);
    assert.equal(b.by_source.accepted.correct.a.k, 5);
  } finally { solo.cleanup(); both.cleanup(); }
  // 比較：(c) と正誤表は群ごとの欄だけで、対の差の欄が無い。読取元の対は (a)・(b) だけ
  const base = mkdtempSync(join(tmpdir(), "table-score-dcmp-"));
  try {
    const goldDir = join(base, "gold"), m = join(base, "m"), out = join(base, "out");
    mkdirSync(goldDir);
    writeFileSync(join(goldDir, "p1.json"), JSON.stringify(gaGold()));
    mkdirSync(m);
    writeFileSync(join(m, "comparison.json"), JSON.stringify({ schema: "x", pairs: { groups: ["before", "after"] } }));
    writeMeasure(join(m, "before"), { golds: [gaGold()], runs: { "P1-r1": { drafts: [candidateOf(gaTable())] } } });
    writeMeasure(join(m, "after"), { golds: [gaGold()], runs: { "P1-r1": { drafts: [candidateOf(gaTable({ ...GA_VER, A1: { kind: "structural", checks: [] } }))] } } });
    const r = main([goldDir, m, out, "--compare"]);
    assert.equal(r.code, 0, r.text);
    const o = JSON.parse(readFileSync(join(out, COMPARE_FILE), "utf8"));
    assert.deepEqual(Object.keys(o.scoring.by_source), ["accepted", "checkpoint"]);
    assert.equal(o.scoring.by_source.accepted.compare.requirement_diffs.n, 0);
    assert.equal(o.scoring.by_source.accepted.compare.excluded["table-absent"], 1);
    assert.deepEqual(Object.keys(o.scoring.draft), ["baseline", "candidate"]);
    assert.equal(o.scoring.draft.baseline.correct.a.k, 5);
    assert.equal(o.scoring.draft.candidate.correct.a.k, 4);
    for (const s of ["accepted", "checkpoint"]) assert.deepEqual(Object.keys(o.scoring.c3[s]), ["baseline", "candidate"]);
    assert.ok(!JSON.stringify([o.scoring.draft, o.scoring.c3]).includes("requirement_diffs"));
    assert.ok(r.text.includes("[draft] 比較元") && r.text.includes("[draft] 候補") && r.text.includes("[c3:accepted] 比較元"));
    const ra = main([goldDir, m, out, "--compare", "--anonymous"]);
    assert.equal(ra.code, 0);
    const anon = JSON.parse(readFileSync(join(out, anonymousFileOf(COMPARE_FILE)), "utf8"));
    assert.deepEqual(Object.keys(anon.draft), ["baseline", "candidate"]);
    assert.deepEqual(Object.keys(anon.c3.accepted), ["baseline", "candidate"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ── 2 本目（#607）：C3 の正誤表
const C3_REQS = [
  { requirement_id: "C1", variants: [alt(["F_a1"], ["F_a1"], { kind: "fixed-test" })] },
  { requirement_id: "C2", variants: [alt(["F_a2"], ["F_a2"], { kind: "fixed-test" })] },
  { requirement_id: "C3", variants: [alt(["F_b1"], ["F_b1"], { kind: "fixed-test" })] },
  { requirement_id: "T1", variants: [alt(["F_c1"], ["F_c1"], { kind: "fixed-test" })] },
  { requirement_id: "W1", variants: [alt(["O_add"], ["O_add"], { kind: "fixed-test" })] },
  { requirement_id: "W2", variants: [alt(["O_del"], ["O_del"], { kind: "fixed-test" })] },
  { requirement_id: "K1", variants: [alt([], [], { kind: "unresolved", reason_kind: "unsupported-observation" })] },
  { requirement_id: "X1", variants: [alt([], [], { kind: "unresolved", reason_kind: "accepted-removal" })] },
  { requirement_id: "H1", adjudication_status: "needs_human", variants: [alt([], [], { kind: "fixed-test" })] },
];
const c3Gold = () => goldOf({ requirements: C3_REQS });
const UNRES = { kind: "unresolved", reason: REASON, checks: [], constraintIds: [], value: null };
const c3Table = () => tableOf({
  syms: ["E_a", "E_b", "E_c", "F_a1", "F_a2", "F_b1", "F_c1", "O_add", "O_del"],
  own: { C1: ["F_a1"], C2: ["F_a2"], C3: ["F_b1"], T1: ["F_c1"], W1: ["O_add"], W2: ["O_del"], K1: [], X1: [], H1: [] },
  ver: { C1: { kind: "fixed-test" }, C2: { kind: "fixed-test" }, C3: { kind: "fixed-test" }, T1: { kind: "fixed-test" }, W1: { kind: "structural", checks: ["k"] }, W2: { kind: "structural", checks: ["k"] }, K1: UNRES, X1: UNRES, H1: { kind: "fixed-test" } },
});
const J = (requirementId, verdict, kind = null) => ({ requirementId, verdict, kind, quote: verdict === "reject" ? QUOTE : null, reason: REASON });
const C3_JUDGMENTS = [J("C1", "accept"), J("C2", "accept"), J("C3", "reject", "weak-verification"), J("W1", "accept"), J("W2", "reject", "missing-target"), J("K1", "accept"), J("X1", "accept"), J("H1", "reject", "odd-kind")];
const C3_TARGETS = ["C1", "C2", "C3", "W1", "W2", "K1", "X1", "H1"];
const c3Round = (round, s) => ({ round, table_sha256: s, targets: C3_TARGETS, judgments: C3_JUDGMENTS, advice: [] });

test("正誤表：誤り 2（受理 1・拒否 1）・正答 3（受理 2・拒否 1）・対象外 1・持ち越し 1・了承除外 1・保留 1 で、見逃し 1/2・誤拒否 1/3・対象外 1、非二値は種類ごとの件数。記録の無い本・SHA の合わない回しか無い本は点検の記録なし。断った候補だけの本は入らない", () => {
  const runs = {
    "P1-r1": { accepted: c3Table(), semantic: { rounds: [c3Round(1, sha("other")), c3Round(2, sha("table"))] } },
    "P1-r2": { accepted: c3Table() },
    "P1-r3": { accepted: c3Table(), semantic: { rounds: [c3Round(1, sha("other"))] } },
    "P1-r4": { drafts: [candidateOf(c3Table())] },
    "P1-r5": { checkpoint: c3Table(), checkpointSemantic: c3Round(1, sha("table")) },
  };
  const w = world({ golds: [c3Gold()], runs });
  try {
    const r = run(w);
    assert.equal(r.code, 0, r.text);
    const out = readOut(w);
    const [b1] = out.scoring.rows;
    assert.deepEqual(["C1", "C2", "C3", "T1", "W1", "W2", "K1", "X1", "H1"].map((id) => outcomeOf(b1, id).outcome), ["correct", "correct", "correct", "correct", "wrong", "wrong", "carry-over", "accepted-removal", "held"]);
    const c = out.scoring.c3.accepted;
    assert.deepEqual(c.cells, { wrong_accept: 1, wrong_reject: 1, correct_accept: 2, correct_reject: 1 });
    assert.deepEqual([c.miss.k, c.miss.n, c.miss.rate], [1, 2, 0.5]);
    assert.deepEqual([c.false_reject.k, c.false_reject.n, c.false_reject.rate], [1, 3, round(1 / 3)]);
    assert.equal(c.miss.wilson95_reference.name, WILSON_NAME);
    assert.equal(c.out_of_target, 1);
    assert.deepEqual(c.non_binary, { "carry-over": 1, "accepted-removal": 1, held: 1 });
    assert.deepEqual(c.reject_kinds, { "unnecessary-ownership": 0, "missing-target": 1, "weak-verification": 1, unknown: 1 });
    assert.deepEqual(c.runs, { with_table: 3, with_record: 1, no_record: { absent: 1, unreadable: 0, "no-matching-round": 1 } });
    assert.deepEqual(c.by_pattern, { P1: c.cells });
    assert.equal(c.patterns, 1);
    assert.equal(out.scoring.c3_rows[0].round, 2);
    assert.equal(out.scoring.c3_rows[3], null);
    assert.deepEqual(out.scoring.c3.checkpoint.cells, c.cells);
    assert.equal(out.scoring.c3.checkpoint.runs.with_table, 1);
    for (const w2 of ["[draft]", "[c3:accepted]", "[c3:checkpoint]", "見逃し", "誤拒否", "点検の対象外", "点検の記録なし"]) assert.ok(r.text.includes(w2), w2);
  } finally { w.cleanup(); }
});

test("正誤表：全要件が非二値の本は分母 0・率 null と理由（1 本目と同じ契約）", () => {
  const g = goldOf({ requirements: C3_REQS.slice(6) });
  const t = tableOf({ syms: ["E_a"], own: { K1: [], X1: [], H1: [] }, ver: { K1: UNRES, X1: UNRES, H1: { kind: "fixed-test" } } });
  const w = world({ golds: [g], runs: { "P1-r1": { accepted: t, semantic: { rounds: [c3Round(1, sha("table"))] } } } });
  try {
    assert.equal(run(w).code, 0);
    const c = readOut(w).scoring.c3.accepted;
    for (const rate of [c.miss, c.false_reject]) {
      assert.equal(rate.n, 0);
      assert.equal(rate.rate, null);
      assert.equal(rate.wilson95_reference, null);
      assert.equal(rate.reason_code, "denominator-zero");
    }
    assert.equal(c.runs.with_record, 1);
  } finally { w.cleanup(); }
});

test("出力：点検の引用・拒否の理由・出典の写しの文が無い。匿名の口に本の ID・要件 ID・P の番号が無く件数と率だけ。同じ入力で 2 回同じ出力", () => {
  const runs = {
    "P1-r1": { accepted: c3Table(), semantic: { rounds: [c3Round(1, sha("table"))] }, drafts: [candidateOf(c3Table(), { round: 1 })] },
    "P1-r2": { drafts: [candidateOf(c3Table())] },
  };
  const w = world({ golds: [c3Gold()], runs });
  try {
    const r1 = run(w);
    assert.equal(r1.code, 0);
    const first = readFileSync(join(w.out, OUTPUT_FILE), "utf8");
    rmSync(w.out, { recursive: true });
    const r2 = run(w);
    assert.equal(readFileSync(join(w.out, OUTPUT_FILE), "utf8"), first);
    assert.equal(r2.text, r1.text);
    for (const t of [first, r1.text]) for (const mark of [QUOTE, REASON, TEXT]) assert.ok(!t.includes(mark), mark);
    assert.ok(!first.includes('"quote"'));
    const ra = run(w, ["--anonymous"]);
    assert.equal(ra.code, 0);
    const anonText = readFileSync(join(w.out, anonymousFileOf(OUTPUT_FILE)), "utf8");
    const anon = JSON.parse(anonText);
    assert.deepEqual(anon, anonymize(JSON.parse(first)));
    assert.ok(anon.draft && anon.c3.accepted && anon.c3.checkpoint);
    assert.doesNotMatch(anonText, /P\d+|-r\d|"[CTWKXHR]\d+"|[0-9a-f]{64}|by_pattern|fingerprint/);
    for (const mark of [QUOTE, REASON, TEXT]) assert.ok(!anonText.includes(mark), mark);
    assert.ok(!anonText.includes(w.base));
  } finally { w.cleanup(); }
});

const SECTION_DRAFT = "### 7.11 断った候補の下書きの採点（読取元 (c)。#607）";
const SECTION_C3 = "### 7.12 C3 の正誤表（見逃し・誤拒否。#607）";
test("README：下書きの採点と正誤表の小節があり、やることの項目が載る。既存の節の文（#606 の README の全体）が変わらない", () => {
  const text = readme();
  const at = text.indexOf(SECTION_DRAFT), c3 = text.indexOf(SECTION_C3);
  assert.ok(at > 0 && c3 > at);
  assert.equal(sha(text.slice(0, at - 1)), "1c21bdefca9e6e5373316f7ce143bdad580dea3d25ad5d1bbda1e8e64f9b2e1f");
  const draft = text.slice(at, c3), table = text.slice(c3);
  for (const item of ["最後の候補", "round・attempt・call", "候補の数", "合併しない", "読めない候補", "古い候補", "一覧", "形の失敗", "数が合わない", "平ら", "添字", "参照切れ", "出典の写し", "表の SHA は null", "分母 (a')", "分母 (b')", "静的な保留", "P を単位", "--compare", "1 回ずつ", "rejected-name-table.json"]) assert.ok(draft.includes(item), item);
  for (const item of ["二値", "見逃し", "誤拒否", "点検の記録なし", "点検の対象外", "表の SHA", "semantic-check", "semantic_check", "持ち越し", "了承除外", "保留", "参考（独立を仮定）", "P ごと", "拒否の種類", "引用", "拒否の理由", "--compare", "--anonymous", "指紋", "断った候補"]) assert.ok(table.includes(item), item);
});

const DR_ONLY = () => drTable(["E_a", "F_a1"], { A1: ["F_a1"], A2: [], A3: [], A4: [] });
/** 下書きだけの本（P1-r2）を含む組が、1 本目と同じ符号で何も数えず終了コード 3・出力無しで断られる */
const assertDraftOnlyRefused = (r) => {
  const w = world({ golds: [drGold()], runs: { "P1-r1": { accepted: DR_ONLY() }, "P1-r2": r } });
  try {
    const res = run(w);
    assert.equal(res.code, EXIT_REFUSED);
    assert.ok(res.text.includes("[table-score:plan-sha256-run]"), res.text);
    assert.deepEqual(outFiles(w), []);
  } finally { w.cleanup(); }
};
test("下書きだけの本：build の記録の plan_sha256 が正解と違えば、1 本目と同じ符号で何も数えず終了コード 3・出力無し（合えば数える）", () => {
  assertDraftOnlyRefused({ drafts: [candidateOf(DR_ONLY())], recordPlan: PLAN_X });
  const ok = world({ golds: [drGold()], runs: { "P1-r1": { drafts: [candidateOf(DR_ONLY())] } } });
  try { assert.equal(run(ok).code, 0); } finally { ok.cleanup(); }
});
test("下書きだけの本：build の記録が無ければ、1 本目と同じ符号で何も数えず終了コード 3・出力無し", () => {
  assertDraftOnlyRefused({ drafts: [candidateOf(DR_ONLY())], noRecord: true });
});

// ── 症例（cases/）：架空の小さな表で、採点器の挙動をデータで固定する（#630）。正解の表の現物は使わない
const readCase = (name) => JSON.parse(readFileSync(join(CASES_DIR, name), "utf8"));
const caseIndex = () => readCase("cases.json").cases;
const CASE_TEXT_KEYS = ["meaning_quote", "rationale", "review_evidence", "question", "text"];
const CASE_MARK = "MARK_TEXT";

test("症例：索引と症例のファイルが 1 対 1（索引に無いファイル・ファイルの無い索引の行があれば落ちる）。id は一意、正 3 以上・負 7 以上・12 件以上、候補依存の保留の症例を含む", () => {
  const rows = caseIndex();
  const referenced = new Set(["cases.json"]);
  for (const r of rows) {
    for (const k of ["gold", "table", "record"]) if (r[k] !== undefined) { assert.ok(existsSync(join(CASES_DIR, r[k])), `${r.id}: ${r[k]}`); referenced.add(r[k]); }
    assert.ok(["pos", "neg"].includes(r.polarity) && ["accepted", "checkpoint", "draft"].includes(r.source) && r.expect && r.note, r.id);
  }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.deepEqual(caseFiles().filter((n) => !referenced.has(n)), []);
  // 表のファイルと点検の記録のファイルは 1 つの症例にだけ属する
  const own = rows.flatMap((r) => [r.table, r.record].filter(Boolean));
  assert.equal(new Set(own).size, own.length);
  assert.ok(rows.length >= 12 && rows.filter((r) => r.polarity === "pos").length >= 3 && rows.filter((r) => r.polarity === "neg").length >= 7);
  assert.ok(rows.some((r) => Object.values(r.expect.requirements ?? {}).some((q) => q.hold === "unassignable-row")));
  assert.deepEqual([...new Set(rows.map((r) => r.source))].sort(), ["accepted", "checkpoint", "draft"]);
});

test("症例：文の欄（meaning_quote・rationale・review_evidence・question・text）の値は目印の文字列だけ", () => {
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (CASE_TEXT_KEYS.includes(k)) assert.ok(x === CASE_MARK || (Array.isArray(x) && x.every((y) => y === CASE_MARK)), `${path}.${k}`);
      else walk(x, `${path}.${k}`);
    }
  };
  for (const f of caseFiles()) if (f !== "cases.json") walk(readCase(f), f);
});

/** 期待に在る欄だけを実際の値から取り出す（期待に無い欄・順序・指紋は比べない） */
const pickLike = (actual, want) => {
  if (want === null || typeof want !== "object" || Array.isArray(want)) return actual;
  if (actual === null || typeof actual !== "object") return actual;
  return Object.fromEntries(Object.keys(want).map((k) => [k, pickLike(actual[k], want[k])]));
};

/** 症例を組んで道具を流し、期待と同じ形の見え方（要件 ID ごとの結果・割り当てられない行・集計・正誤表）にする */
function runCaseRow(r) {
  const gold = readCase(r.gold), body = readCase(r.table);
  const spec = r.source === "draft" ? { drafts: body.candidates } : { [r.source]: body };
  if (r.record !== undefined) spec.semantic = readCase(r.record);
  const w = world({ golds: [gold], runs: { "P1-r1": spec } });
  try {
    const res = run(w);
    assert.equal(res.code, 0, `${r.id}: ${res.text}`);
    const sc = readOut(w).scoring;
    const row = r.source === "draft" ? sc.draft_rows[0] : sc.rows[0];
    const block = r.source === "draft" ? sc.draft : sc.by_source[r.source];
    return {
      requirements: row.requirements === null ? null : Object.fromEntries(row.requirements.map((q) => [q.requirement_id, { outcome: q.outcome, hold: q.hold, questions: q.questions, marks: q.marks, variant_id: q.variant_id }])),
      unassigned_rows: row.unassigned_rows === null ? [] : row.unassigned_rows,
      aggregate: block, draft: block.draft, c3: sc.c3[r.source],
    };
  } finally { w.cleanup(); }
}

test("症例：各症例の 5 値・3 問・印・保留の種類・割り当てられない行・分母・正誤表が期待と深く等しい（症例ごとに失敗が分かる）", async (t) => {
  for (const r of caseIndex()) {
    await t.test(`${r.polarity} ${r.id}`, () => {
      const got = runCaseRow(r);
      assert.deepEqual(pickLike(got, r.expect), r.expect);
      // 静的な保留は全症例で held／needs-human・3 問 null で、二値の分母に入らない
      if (r.expect.requirements !== null) {
        assert.deepEqual(got.requirements.Q6, { outcome: "held", hold: "needs-human", questions: { missing: null, excess: null, verification: null }, marks: [], variant_id: null });
        assert.equal(got.aggregate.denominators.a, Object.values(got.requirements).filter((q) => ["correct", "wrong"].includes(q.outcome)).length);
        assert.equal(got.aggregate.denominators.b, 5);
      }
    });
  }
});

// ── 段の走りと段の比較（#639）：条件 v8・読取元 checkpoint・入力なし・表なし
const stageConditions = (absent, over = {}) => ({ schema: CONDITIONS_V8, measurement_id: "m-stage", params: { mode: "stage-run", pipeline: "v1.2" }, stage_input_absent: { count: absent.length, ids: absent }, ...over });
/** 段単位の計測を書く。入力なしの本は本のディレクトリを作らない（起こさない） */
function writeStage(dir, golds, runs, absent, over = {}) {
  writeMeasure(dir, { golds, runs: Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, { plan: PLAN_A, ...r }])), extraConditions: stageConditions(absent, over) });
  for (const id of absent) rmSync(join(dir, id), { recursive: true, force: true });
}
const stageWorld = (build) => {
  const base = mkdtempSync(join(tmpdir(), "table-score-stage-"));
  const goldDir = join(base, "gold"), m = join(base, "m"), out = join(base, "out");
  mkdirSync(goldDir);
  for (const p of ["P1", "P2", "P3"]) writeFileSync(join(goldDir, `${p}.json`), JSON.stringify(gaGold(p)));
  build(m);
  return { base, goldDir, measure: m, out, cleanup: () => rmSync(base, { recursive: true, force: true }) };
};
const STAGE_GOLDS = ["P1", "P2", "P3"].map((p) => gaGold(p));
const A1_WRONG = { ...GA_VER, A1: { kind: "structural", reason: "x", checks: [] } };
const gaRound = (targets, verdicts) => ({ table_sha256: sha("table"), targets, judgments: targets.map((t, i) => ({ requirementId: t, verdict: verdicts[i], kind: verdicts[i] === "reject" ? "missing-target" : null })), advice: [] });

test("段の走り：条件 v8・P 3 × 回 2（checkpoint 3・段の途中で止まった 1・入力なし 2）で正答率・分母・表なしと入力なしの件数・読取元の件数・C3 の正誤表が手計算と一致する", () => {
  const w = stageWorld((m) => {
    writeStage(m, STAGE_GOLDS, {
      "P1-r1": { checkpoint: gaTable(), checkpointSemantic: gaRound(["A1", "A2", "A5"], ["accept", "reject", "accept"]) },
      "P1-r2": { checkpoint: gaTable(A1_WRONG), checkpointSemantic: gaRound(["A1", "A2"], ["reject", "accept"]) },
      "P2-r1": {}, "P2-r2": {},
      "P3-r1": { checkpoint: gaTable() }, "P3-r2": {},
    }, ["P2-r2", "P3-r2"]);
    // 段の途中で止まった本：段の走りの記録だけで checkpoint が無い
    writeFileSync(join(m, "P2-r1", "bundle", "stage-run.json"), JSON.stringify({ stage_pass: false }));
  });
  try {
    const r = run(w);
    assert.equal(r.code, 0, r.text);
    const out = readOut(w);
    const c = out.scoring.by_source.checkpoint;
    // 分母 (a)：表のある 3 本 × 二値 5、(b)：予定 6 本 × (6 − 静的な保留 1)
    assert.deepEqual(c.denominators, { a: 15, b: 30 });
    assert.deepEqual([c.correct.a.k, c.correct.a.n], [14, 15]);
    assert.deepEqual([c.correct.b.k, c.correct.b.n, c.correct.b.rate], [14, 30, round(14 / 30)]);
    assert.deepEqual(c.runs, { planned: 6, with_table: 3, no_table: 1, other_source: 0, checkpoint_also: 0, input_absent: 2 });
    assert.equal(c.counts.unobserved, 15);
    assert.equal(c.pattern_interval.m, 2);
    assert.deepEqual(out.scoring.run_sources, { accepted_only: 0, checkpoint_only: 3, both: 0, no_table: 1, input_absent: 2 });
    assert.deepEqual(runSources(out.scoring.rows), out.scoring.run_sources);
    assert.deepEqual(out.scoring.rows.map((x) => x.input_absent), [false, false, false, true, false, true]);
    // C3：P1-r1（正答 A1・A2・A5 の受理 2・拒否 1）、P1-r2（誤り A1 の拒否 1・正答 A2 の受理 1）。P3-r1 は点検の記録なし
    const c3 = out.scoring.c3.checkpoint;
    assert.deepEqual(c3.cells, { wrong_accept: 0, wrong_reject: 1, correct_accept: 3, correct_reject: 1 });
    assert.deepEqual([c3.miss.k, c3.miss.n], [0, 1]);
    assert.deepEqual([c3.false_reject.k, c3.false_reject.n], [1, 4]);
    assert.deepEqual(c3.runs, { with_table: 3, with_record: 2, no_record: { absent: 1, unreadable: 0, "no-matching-round": 0 } });
    assert.ok(out.scoring.c3_rows[3] === null && out.scoring.c3_rows[5] === null);
    for (const t of ["[本の読取元]", "入力なし 2", "表なし 1", "checkpoint のみ 3"]) assert.ok(r.text.includes(t), t);
    // 出どころの契約：条件のファイルの SHA-256・計測の ID・本ごとの読取元と表の SHA
    assert.equal(out.fingerprint.conditions_sha256, sha(readFileSync(join(w.measure, "conditions.json"))));
    assert.equal(out.fingerprint.measurement_id, "m-stage");
    assert.equal(out.fingerprint.tool_sha256, sha(readFileSync(join(here, "score-table.mjs"))));
    assert.deepEqual([out.scoring.rows[0].source, out.scoring.rows[0].table_sha256], ["checkpoint", sha("table")]);
    assert.equal(out.scoring.rows[3].table_sha256, null);
    // 匿名の口：指紋・SHA・本の ID が無く、読取元の件数だけある
    assert.equal(run(w, ["--anonymous"]).code, 0);
    const anonText = readFileSync(join(w.out, anonymousFileOf(OUTPUT_FILE)), "utf8");
    assert.doesNotMatch(anonText, /conditions_sha256|measurement_id|m-stage|[0-9a-f]{64}|fingerprint|P\d+|-r\d/);
    assert.deepEqual(JSON.parse(anonText).run_sources, out.scoring.run_sources);
    assert.equal(JSON.parse(anonText).by_source.checkpoint.runs.input_absent, 2);
  } finally { w.cleanup(); }
});

test("段の走り：段単位でない条件には欄を足さない（run_sources・input_absent・条件の SHA 以外の指紋）。v6 も受ける。入力なしの一覧・経路が合わない条件は断る", () => {
  const w = world({ golds: [gaGold()], runs: { "P1-r1": { checkpoint: gaTable() } } });
  try {
    assert.equal(run(w).code, 0);
    const out = readOut(w);
    assert.equal(out.scoring.run_sources, undefined);
    assert.equal("input_absent" in out.scoring.rows[0], false);
    assert.equal("input_absent" in out.scoring.by_source.checkpoint.runs, false);
    assert.equal(out.fingerprint.conditions_sha256, sha(readFileSync(join(w.measure, "conditions.json"))));
    assert.equal(out.fingerprint.measurement_id, null);
  } finally { w.cleanup(); }
  const v6 = stageWorld((m) => writeStage(m, STAGE_GOLDS, { "P1-r1": { checkpoint: gaTable() } }, [], { schema: CONDITIONS_V6, params: { mode: "stage-run", pipeline: "v1.1a" } }));
  try { assert.equal(run(v6).code, 0); } finally { v6.cleanup(); }
  for (const over of [
    { stage_input_absent: { count: 1, ids: ["P9-r1"] } }, { stage_input_absent: { count: 2, ids: ["P1-r1"] } }, { stage_input_absent: undefined },
    { params: { mode: "stage-run", pipeline: "v1.1a" } }, { schema: CONDITIONS_V6, params: { mode: "stage-run", pipeline: "v1.2" } },
  ]) {
    const bad = stageWorld((m) => writeStage(m, STAGE_GOLDS, { "P1-r1": { checkpoint: gaTable() } }, [], over));
    try {
      const r = run(bad);
      assert.equal(r.code, EXIT_REFUSED);
      assert.ok(r.text.includes("[table-score:conditions]"), r.text);
      assert.deepEqual(outFiles(bad), []);
    } finally { bad.cleanup(); }
  }
});

test("段の比較：記録（stage-compare-record/v1。before・after）で同じ P・同じ回を対にし、対の差・table-absent・入力なしの件数・P のまとまりの区間・群ごとの C3 が出る", () => {
  const w = stageWorld((m) => {
    mkdirSync(m, { recursive: true });
    writeFileSync(join(m, "comparison.json"), JSON.stringify({ schema: "musunest-eval/stage-compare-record/v1", pairs: { groups: ["before", "after"] } }));
    const absent = ["P2-r2", "P3-r2"];
    writeStage(join(m, "before"), STAGE_GOLDS, { "P1-r1": { checkpoint: gaTable(A1_WRONG) }, "P1-r2": { checkpoint: gaTable() }, "P2-r1": {}, "P2-r2": {}, "P3-r1": { checkpoint: gaTable() }, "P3-r2": {} }, absent);
    writeStage(join(m, "after"), STAGE_GOLDS, {
      "P1-r1": { checkpoint: gaTable(), checkpointSemantic: gaRound(["A1"], ["accept"]) }, "P1-r2": { checkpoint: gaTable() },
      "P2-r1": { checkpoint: gaTable() }, "P2-r2": {}, "P3-r1": { checkpoint: gaTable() }, "P3-r2": {},
    }, absent);
  });
  try {
    const r = run(w, ["--compare"]);
    assert.equal(r.code, 0, r.text);
    const o = readOut(w, COMPARE_FILE);
    const x = o.scoring.by_source.checkpoint, cmp = x.compare;
    // 対（静的な保留 A6 が 3 対で非二値）：P1-r1 [+1,0,0,0,0]、P1-r2・P3-r1 は全部 0、P2-r1 は比較元に表が無く table-absent、入力なしの 2 本は対に入らない
    assert.deepEqual(cmp.requirement_diffs, pairStats([1, ...Array(14).fill(0)]));
    assert.deepEqual(cmp.excluded, { "table-absent": 1, "non-binary": 3, "input-absent": 2 });
    assert.deepEqual(cmp.pairs.map((p) => [p.run, p.mean, p.n]), [["P1-r1", 0.2, 5], ["P1-r2", 0, 5], ["P2-r1", null, 0], ["P3-r1", 0, 5]]);
    assert.deepEqual(cmp.pattern_clusters, clusterStats({ P1: [0.2, 0], P3: [0] }));
    assert.deepEqual(x.baseline.runs, { planned: 6, with_table: 3, no_table: 1, other_source: 0, checkpoint_also: 0, input_absent: 2 });
    assert.equal(x.candidate.runs.no_table, 0);
    // 群ごとの正誤表（対の差は取らない）
    assert.equal(o.scoring.c3.checkpoint.baseline.runs.with_record, 0);
    assert.deepEqual(o.scoring.c3.checkpoint.candidate.cells, { wrong_accept: 0, wrong_reject: 0, correct_accept: 1, correct_reject: 0 });
    assert.deepEqual(o.scoring.run_sources.baseline, { accepted_only: 0, checkpoint_only: 3, both: 0, no_table: 1, input_absent: 2 });
    assert.deepEqual(o.scoring.run_sources.candidate, { accepted_only: 0, checkpoint_only: 4, both: 0, no_table: 0, input_absent: 2 });
    assert.equal(o.fingerprint.conditions_sha256.baseline, sha(readFileSync(join(w.measure, "before", "conditions.json"))));
    assert.equal(o.fingerprint.conditions_sha256.candidate, sha(readFileSync(join(w.measure, "after", "conditions.json"))));
    assert.deepEqual(o.fingerprint.measurement_id, { baseline: "m-stage", candidate: "m-stage" });
    assert.ok(r.text.includes("input-absent 2") && r.text.includes("[本の読取元] 比較元"));
    assert.equal(run(w, ["--compare", "--anonymous"]).code, 0);
    const anonText = readFileSync(join(w.out, anonymousFileOf(COMPARE_FILE)), "utf8");
    assert.doesNotMatch(anonText, /conditions_sha256|[0-9a-f]{64}|fingerprint|P\d+|-r\d|before|after/);
    assert.deepEqual(JSON.parse(anonText), anonymize(o));
    assert.equal(JSON.parse(anonText).by_source.checkpoint.compare.excluded["input-absent"], 2);
  } finally { w.cleanup(); }
});

test("README §7.13：段の走り・入力なし・表なし・分母 (b)・納品の成功ではない。§7.12 の後ろにあり、§7.11 の前のバイト列は変わらない", () => {
  const text = readme();
  const at = text.indexOf("### 7.13 "), c3 = text.indexOf(SECTION_C3), next = text.indexOf("\n## 8. ");
  assert.ok(c3 > 0 && at > c3 && next > at);
  const sec = text.slice(at, next);
  for (const item of ["段の走り", "入力なし", "表なし", "分母 (b)", "納品の成功ではない", "checkpoint", "conditions_sha256", "table-absent", "input-absent", "stage-compare-record/v1"]) assert.ok(sec.includes(item), item);
  assert.equal(text.indexOf("### 7.13 ", at + 1), -1);
});
