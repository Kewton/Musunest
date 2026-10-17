// score-mutants.mjs の試験（node --test。#554）。API・通信・LLM・判定・時計を使わない（時計は固定の時刻）。
// 宣言・題材の定義・名前の表・試験・文脈・目録は手で組んだ中立なもの。工場と spec-engine は build 済みの dist を使う。
// 実行（pnpm build のあと）: node --test workspace/mvp/m1/agent/eval/mutation/score-mutants.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKS_SCHEMA, classifyMutations } from "./classify.mjs";
import { MutationToolError, generateMutants, sha256 } from "./mutate.mjs";
import { CATEGORY_IDS, CONTEXT_SCHEMA, INVENTORY_SCHEMA, MESSAGES, OUTPUT_SCHEMA, WILSON_NAME, makeRate, rowsOfPlace, scoreMutants, summarizeRecords, summaryLines, toAnonymous } from "./score-mutants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../../..");
const factoryEntry = join(root, "packages/factory/dist/index.js");
const engineEntry = join(root, "packages/spec-engine/dist/index.js");
const scoringEngineFile = join(here, "../engine.mjs");
const factory = await import(factoryEntry);
const engine = await import(engineEntry);

const bytesSha = (b) => createHash("sha256").update(b).digest("hex");
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === "__tests__" ? [] : walk(p)) : n.endsWith(".js") && !n.endsWith(".test.js") ? [p] : [];
}).sort();
const listDist = (entry) => walk(dirname(entry)).map((p) => ({ path: p, sha256: bytesSha(readFileSync(p)) }));
const factoryFiles = listDist(factoryEntry), engineFiles = listDist(engineEntry);

// ── 宣言（中立な名前）。member に note を足し、一覧の画面（表）から辿れるようにする
const SRC = `# note
entities:
  - name: member
    fields:
      name:
        type: string
        label: Name
      note:
        type: string
        label: Note
  - name: item
    fields:
      title:
        type: string
        label: Title
      owner:
        type: ref
        to: member
        label: Owner
      quantity:
        type: number
        label: Quantity
      state:
        type: enum
        label: State
        options:
          open: Open
          doing: Doing
          done: Done
        default: open
      memo:
        type: string
        label: Memo
computed:
  - name: itemCount
    entity: member
    aggregate:
      count: item
      where:
        owner: this
    type: number
    label: Items
views:
  - name: board
    type: board
    entity: item
    columns: state
  - name: items
    type: list
    entity: item
    show: [title, owner, quantity, state]
  - name: members
    type: table
    entity: member
actions:
  - name: addMember
    entity: member
  - name: addItem
    entity: item
    kind: create
  - name: finish
    entity: item
    kind: update
    set:
      state: done
    when: state == "open"
validations:
  - name: positiveQuantity
    entity: item
    expression: quantity >= 1
    message: Quantity must be at least 1
  - name: limitQuantity
    entity: item
    expression: quantity <= 100
    message: Quantity must be at most 100
permissions:
  - name: read
    subject: minIdentity
  - name: write
    subject: minIdentity
minIdentity:
  mode: anonymous
`;
const DEF = {
  id: "T",
  structures: [{
    id: "main",
    roles: {
      main: { entity: {} },
      status: { field: { of: "main", type: "enum", labels: ["Open", "Doing", "Done"] } },
      qty: { field: { of: "main", type: "number" } },
    },
    checks: [
      { req: "default-state", kind: "enumDefault", field: "status", label: "Open" },
      { req: "advance", kind: "advanceAction", field: "status", from: "Open", to: "Done" },
      { req: "board", kind: "boardColumns", field: "status" },
      { req: "creatable", kind: "creatable", entities: ["main"] },
      { req: "quantity-rule", kind: "validation", entity: "main", cases: [{ set: { qty: 0 }, valid: false }, { set: { qty: 1 }, valid: true }] },
    ],
  }],
};

// ── 文脈（有効な評価の文脈を直接凍結したもの）：持ち越しの要件 R5（その行 c.ghost だけを除く）・棄却した試験 t-rejected・要件でない文 N1 を含む
const row = (id, kind, entity, name, type, from, quote, extra = {}) => ({ id, kind, entity, name, role: `要件 ${from} が使う対象`, source: { requirementId: from, quote }, type, options: null, groupBy: null, refEntity: null, ...extra });
const stated = (id) => ({ id, basis: "stated", reason: null });
const TABLE = {
  rows: [
    row("e.item", "entity", null, "item", null, "R1", "item"),
    row("e.member", "entity", null, "member", null, "R3", "member"),
    row("f.item.title", "field", "e.item", "title", "string", "R3", "title"),
    row("f.item.state", "field", "e.item", "state", "enum", "R1", "state", { options: ["open", "doing", "done"] }),
    row("f.item.quantity", "field", "e.item", "quantity", "number", "R4", "quantity"),
    row("f.member.note", "field", "e.member", "note", "string", "R3", "note"),
    row("c.ghost", "computation", null, "ghost", { valueType: "number", scope: "app", form: "expression" }, "R5", "ghost"),
    row("o.finish", "operation", "e.item", "finish", { action: "update", hasWhen: true }, "R2", "finish"),
    row("s.items", "screen", "e.item", "items", { view: "list" }, "R3", "items"),
    row("s.members", "screen", "e.member", "members", { view: "table" }, "R3", "members"),
  ],
  ownership: [
    { requirementId: "R1", roles: [stated("f.item.state")] },
    { requirementId: "R2", roles: [stated("o.finish"), stated("f.item.state")] },
    { requirementId: "R3", roles: ["f.member.note", "s.members", "s.items", "f.item.title"].map(stated) },
    { requirementId: "R4", roles: [stated("f.item.quantity")] },
    { requirementId: "R5", roles: [stated("c.ghost")] },
  ],
  verification: [],
  classification: [],
};
const req = (id) => ({ id, text: `text ${id}`, quote: `text ${id}`, position: { start: 0, end: 7 } });
const CLOCK = "2026-09-16T12:00:00+09:00";
const base = { kind: "normal", clock: CLOCK, input: {}, referenceData: [], expected: { kind: "ok", value: true } };
const actionTest = (id, state, value) => ({ ...base, id, target: { requirementId: "R2", kind: "operation", roleId: "o.finish" }, operation: "action", input: { "f.item.state": state }, inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] }, expected: { kind: "ok", value } });
const defaultTest = (id, key) => ({ ...base, id, target: { requirementId: "R1", kind: "field", roleId: "f.item.state" }, operation: "compute", expected: { kind: "ok", value: key } });
const showsTest = { ...base, id: "t-shows", target: { requirementId: "R3", kind: "screen", roleId: "s.items" }, operation: "structure", assertion: { check: "view-shows", role: "f.item.title" } };
const EFFECTIVE_SUITE = { tests: [defaultTest("t-default", "open"), actionTest("t-when-open", "open", true), actionTest("t-when-done", "done", false), showsTest] };
const RAW_SUITE = { tests: [...EFFECTIVE_SUITE.tests, defaultTest("t-rejected", "doing")] };
const OBSERVES = { "t-default": "default-value", "t-when-open": "when", "t-when-done": "when", "t-shows": "view-structure", "t-rejected": "default-value" };
const RAW_LIST = { requirements: ["R1", "R2", "R3", "R4", "R5"].map(req), decisions: [], unresolved: [] };
const EFFECTIVE_LIST = { ...RAW_LIST, requirements: RAW_LIST.requirements.filter((r) => r.id !== "R5") };
const effectiveOwnership = () => factory.toV1(TABLE).ownership.filter((o) => EFFECTIVE_LIST.requirements.some((r) => r.id === o.requirementId));
const contextOf = (suite = EFFECTIVE_SUITE) => ({
  schema: CONTEXT_SCHEMA,
  table: TABLE,
  list: EFFECTIVE_LIST,
  suite,
  ownership: effectiveOwnership(),
  excluded_row_ids: ["c.ghost"],
  observes: OBSERVES,
  carry_over: { entries: [{ requirementId: "R5", reasons: [{ origin: "name-table", detail: "carried" }] }] },
  rejected_test_ids: ["t-rejected"],
  non_requirements: ["N1"],
  ledger: { on: false },
});
// 原本と食い違う試験の組（既定値の期待を替える）
const MISALIGNED_SUITE = { tests: [defaultTest("t-default", "doing"), ...EFFECTIVE_SUITE.tests.slice(1)] };

// ── 手 5a の出力（本物の classifyMutations で作る）。印：member.note を消す変異を非同値と人が判断したもの
const gen = await generateMutants({ engine, source: SRC });
const byId = (id) => gen.mutants.find((m) => m.id === id);
const ID = {
  default: "change-default@entities[1].fields.state.default",
  removeNote: "remove-field@entities[0].fields.note",
  flipWhen: "flip-comparison@actions[2].when#0",
  removeWhen: "remove-when@actions[2].when",
  removeValidation: "remove-validation@validations[0]",
  reorder: "reorder-options@entities[1].fields.state.options#0",
};
const MARKS = { schema: MARKS_SCHEMA, origin_marks: [], mutant_marks: [{ sha256: byId(ID.removeNote).sha256, reviewer_role: "reviewer-a", verdict: "non-equivalent" }] };
const out5a = await classifyMutations({ engineFile: engineEntry, scoringEngineFile, origins: [{ id: "o1", source: SRC, def: DEF }], marks: MARKS });
const mut5a = (id) => out5a.mutants.find((m) => m.id === id);

/** 目録と、それが指すファイルを一時のディレクトリに書く。files に差し替えを渡すと、目録の SHA-256 はそのあとの内容で計算する */
function world({ replace = {}, candidates = ["a", "b"], keepInventorySha = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "score-mutants-"));
  const files = {
    "subject.json": JSON.stringify(DEF),
    "origin.yaml": SRC,
    "out5a.json": JSON.stringify(out5a),
    "marks.json": JSON.stringify(MARKS),
    "context-a.json": JSON.stringify(contextOf()),
    "context-b.json": JSON.stringify(contextOf(MISALIGNED_SUITE)),
    ...replace,
  };
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  const ref = (n) => ({ path: join(dir, n), sha256: keepInventorySha[n] ?? bytesSha(Buffer.from(files[n])) });
  const ids = { a: ["cand-a", "P1", "context-a.json"], b: ["cand-b", "P2", "context-b.json"], c: ["cand-c", "P1", "context-a.json"] };
  const inventory = {
    schema: INVENTORY_SCHEMA,
    version: {
      factory_commit: "0123456789abcdef0123456789abcdef01234567",
      factory_dist: { entry: factoryEntry, files: factoryFiles },
      spec_engine_dist: { entry: engineEntry, files: engineFiles },
      scoring_engine: { path: scoringEngineFile, sha256: bytesSha(readFileSync(scoringEngineFile)) },
    },
    candidates: candidates.map((k, i) => ({
      id: ids[k][0], p: ids[k][1], iteration: i,
      subject: ref("subject.json"), origin: ref("origin.yaml"), mutants: { ...ref("out5a.json"), origin_id: "o1" }, marks: ref("marks.json"), context: ref(ids[k][2]),
    })),
  };
  return { dir, inventory, files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const refused = async (promise, code) => {
  await assert.rejects(promise, (e) => e instanceof MutationToolError && e.code === code && e.message === MESSAGES[code]);
};
const cat = (cand, id) => cand.mutants.find((m) => m.id === id).category;

test("前提：手 5a の分類が組んだ想定どおり（試験の評価の前の分類）", () => {
  assert.equal(mut5a(ID.default).class, "non-equivalent");
  assert.equal(mut5a(ID.flipWhen).class, "non-equivalent");
  assert.equal(mut5a(ID.removeWhen).class, "non-equivalent");
  assert.equal(mut5a(ID.removeValidation).class, "non-equivalent");
  assert.equal(mut5a(ID.removeNote).class, "non-equivalent");
  assert.equal(mut5a(ID.removeNote).reason_code, "non-equivalent:mark");
  assert.equal(mut5a(ID.reorder).class, "undecidable");
});

test("評価の試験 (a)〜(d)：既定値は試験で落ちる・項目を消すと結び付けで落ちる・対象外は生き残る・原本が合わない候補は分母の外", async () => {
  const w = world();
  try {
    const out = await scoreMutants({ inventory: w.inventory });
    assert.equal(out.schema, OUTPUT_SCHEMA);
    const a = out.candidates.find((c) => c.id === "cand-a"), b = out.candidates.find((c) => c.id === "cand-b");
    assert.equal(a.status, "aligned");
    assert.deepEqual([a.origin_run.misses, a.origin_run.mismatches, a.origin_run.unresolved], [0, 0, 0]);
    assert.equal(cat(a, ID.default), "test-fail"); // (a)
    assert.equal(cat(a, ID.flipWhen), "test-fail");
    assert.equal(cat(a, ID.removeNote), "binding-fail"); // (b)
    assert.equal(a.mutants.find((m) => m.id === ID.removeNote).mismatches, 0);
    assert.equal(cat(a, ID.removeWhen), "binding-fail");
    assert.equal(cat(a, ID.removeValidation), "survived"); // (c)
    assert.equal(cat(a, ID.reorder), "undecidable");
    // (d) 原本に不一致がある候補は、試験と原本が合わない。変異は全部が分母の外
    assert.equal(b.status, "test-origin-mismatch");
    assert.ok(b.origin_run.mismatches >= 1);
    assert.ok(b.mutants.length > 0 && b.mutants.every((m) => m.category === "test-origin-mismatch" && m.outcomes === null));
    assert.equal(b.summary.eligible, 0);
    assert.equal(b.summary.detection.primary.rate, null);
    assert.equal(out.totals.eligible, a.summary.eligible);
    assert.equal(out.separate.test_origin_mismatch, b.mutants.length);
    // 1 つの変異は 1 つにだけ入る
    for (const c of out.candidates) assert.equal(Object.values(c.summary.by_category).reduce((x, y) => x + y, 0), c.mutants.length);
    // 試験ごと：t-shows は対象の要件（R3）の適格な変異（note を消す）があるのに落とさない
    const shows = a.tests.find((t) => t.id === "t-shows");
    assert.deepEqual([shows.eligible_mutants, shows.killed, shows.uncatchable], [1, 0, true]);
    assert.equal(a.tests.find((t) => t.id === "t-default").killed, 1);
    const [k, n] = [out.totals.uncatchable.rate.k, out.totals.uncatchable.rate.n];
    assert.equal(k, 1);
    assert.equal(n, 4, "t-default・t-when-open・t-when-done・t-shows のうち適格な変異を対象に持つ試験");
  } finally { w.cleanup(); }
});

test("(e) 持ち越しの除く行・棄却した試験・要件でない文を含む候補：道具の結果は同じ文脈で工場の評価口を直接作った結果と試験 ID ごとに深く等しい。除く前の一覧・組では変わる", async () => {
  const w = world({ candidates: ["a"] });
  try {
    const out = await scoreMutants({ inventory: w.inventory });
    const cand = out.candidates[0];
    const direct = (excluded, list, suite) => factory.createV11aEvaluator({ table: TABLE, excludedRowIds: excluded, observes: new Map(Object.entries(OBSERVES)) });
    const outcomes = async (evaluator, list, suite, source) => {
      const n = await engine.normalizeSpec(source);
      const r = await evaluator.evaluate(n.app, { source }, { list, suite, correspondences: [], ownership: factory.toV1(TABLE).ownership.filter((o) => list.requirements.some((x) => x.id === o.requirementId)) });
      const bad = new Set(r.testRun.mismatches.map((x) => x.testId)), un = new Set(r.testRun.unresolved.map((x) => x.testId));
      return { misses: r.correspondence.misses.length, byTest: Object.fromEntries(suite.tests.map((t) => [t.id, bad.has(t.id) ? "mismatch" : un.has(t.id) ? "unresolved" : "match"])) };
    };
    const frozen = direct(["c.ghost"], EFFECTIVE_LIST, EFFECTIVE_SUITE);
    for (const m of cand.mutants.filter((x) => x.outcomes !== null)) {
      const d = await outcomes(frozen, EFFECTIVE_LIST, EFFECTIVE_SUITE, byId(m.id).source);
      assert.deepEqual(m.outcomes, d.byTest, m.id);
      assert.equal(m.misses, d.misses, m.id);
    }
    // 二点測定：文脈を除く前の一覧（R5 あり）・組（t-rejected あり）・除く行なしで評価すると、原本で結果が変わる
    const before = await outcomes(direct([], RAW_LIST, RAW_SUITE), RAW_LIST, RAW_SUITE, SRC);
    const after = await outcomes(frozen, EFFECTIVE_LIST, EFFECTIVE_SUITE, SRC);
    assert.notDeepEqual(before, after);
    assert.ok(before.misses > 0 || Object.values(before.byTest).some((x) => x !== "match"));
    assert.equal(after.misses, 0);
    assert.ok(Object.values(after.byTest).every((x) => x === "match"));
    assert.deepEqual(cand.origin_run.outcomes, after.byTest);
  } finally { w.cleanup(); }
});

test("集計 (1)〜(3)：分母の定義・条件付きの率・分母 0 の null と理由の符号", () => {
  const recs = (spec) => Object.entries(spec).flatMap(([category, n]) => Array.from({ length: n }, () => ({ category, operator: "remove-field" })));
  // (1) 適格 4（試験 3・結び付け 1）・判定不能 2・同値 1・食い違い 1
  const s1 = summarizeRecords(recs({ "test-fail": 3, "binding-fail": 1, undecidable: 2, "syntactic-equivalent": 1, discrepancy: 1 }));
  assert.equal(s1.eligible, 4);
  assert.deepEqual([s1.detection.primary.k, s1.detection.primary.n, s1.detection.primary.rate], [3, 4, 0.75]);
  assert.deepEqual([s1.detection.secondary.k, s1.detection.secondary.n, s1.detection.secondary.rate], [4, 4, 1]);
  assert.equal(s1.classification.classified, 8);
  assert.deepEqual([s1.classification.equivalent.k, s1.classification.equivalent.n], [1, 8]);
  assert.deepEqual([s1.classification.undecidable.k, s1.classification.undecidable.n], [2, 8]);
  assert.equal(s1.detection.primary.n, 4, "判定不能・同値・食い違いは検出率の分母に入らない");
  // (2) 食い違い 0 の組：同値の率 1 ÷ 7（人の印の同値も同値の率に入る）
  const s2 = summarizeRecords(recs({ "test-fail": 3, "binding-fail": 1, undecidable: 2, "equivalent-marked": 1 }));
  assert.deepEqual([s2.classification.equivalent.k, s2.classification.equivalent.n], [1, 7]);
  assert.deepEqual([s2.classification.discrepancy.k, s2.classification.discrepancy.n], [0, 7]);
  // 原本不適・試験と原本が合わない・静的に落ちるは、分類の割合の分母にも入らない
  const s2b = summarizeRecords(recs({ "test-fail": 1, "origin-unusable": 5, "test-origin-mismatch": 4, "static-fail": 3 }));
  assert.equal(s2b.classification.classified, 1);
  // (3) 適格な変異 0：率と区間が null で理由の符号がある（0% にしない）
  const s3 = summarizeRecords(recs({ undecidable: 2, "origin-unusable": 1 }), []);
  assert.equal(s3.eligible, 0);
  for (const r of [s3.detection.primary, s3.detection.secondary]) assert.deepEqual([r.rate, r.wilson95_reference, r.reason_code], [null, null, "no-eligible-mutants"]);
  assert.equal(s3.classification.non_equivalent.rate, 0);
  assert.deepEqual([s3.uncatchable.rate.rate, s3.uncatchable.rate.reason_code], [null, "no-tests-with-eligible-mutants"]);
  assert.equal(summarizeRecords([]).classification.equivalent.reason_code, "no-classified-mutants");
  // 落とせない試験の率：適格な変異を対象に持つ試験だけが分母
  const s4 = summarizeRecords(recs({ "test-fail": 1 }), [{ eligible_mutants: 2, killed: 0 }, { eligible_mutants: 1, killed: 1 }, { eligible_mutants: 0, killed: 0 }]);
  assert.deepEqual([s4.uncatchable.rate.k, s4.uncatchable.rate.n], [1, 2]);
  assert.equal(s4.uncatchable.tests, 3);
});

test("集計 (4)(5)：Wilson は参考の名・候補ごと・P ごとの率とまとまりの数・同じ入力から同じ出力", async () => {
  const r = makeRate(3, 4, "x");
  assert.equal(r.wilson95_reference.name, WILSON_NAME);
  assert.equal(WILSON_NAME, "参考（独立を仮定）");
  assert.ok(r.wilson95_reference.low < 0.75 && r.wilson95_reference.high > 0.75);
  const w = world({ candidates: ["a", "b", "c"] });
  try {
    const first = await scoreMutants({ inventory: w.inventory });
    const second = await scoreMutants({ inventory: w.inventory });
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.clusters, { candidates: 3, p_groups: 2, p_groups_with_eligible: 1 });
    assert.deepEqual(first.by_p.map((g) => [g.p, g.candidates]), [["P1", 2], ["P2", 1]]);
    assert.equal(first.by_p[0].detection.primary.n, first.candidates[0].summary.eligible * 2);
    assert.equal(first.by_p[1].detection.primary.rate, null);
    for (const c of first.candidates) assert.ok("primary" in c.summary.detection);
    assert.match(first.definitions.interval_rule, /参考（独立を仮定）/);
    assert.match(first.definitions.interval_rule, /一般化の区間は出さず/);
    assert.match(first.definitions.conditional_note, /条件付き/);
    assert.match(first.definitions.classification_denominator, /静的チェックを通った変異の全部/);
    assert.ok(Object.keys(first.by_operator).every((k) => ["remove-field", "flip-comparison", "remove-when", "reorder-options", "change-default", "remove-validation", "swap-aggregate"].includes(k)));
    assert.equal(first.fingerprints.tool.length, 64);
    assert.equal(first.fingerprints.factory_commit, w.inventory.version.factory_commit);
    const lines = summaryLines(first).join("\n");
    assert.match(lines, /主の検出率/);
    assert.doesNotMatch(lines, /cand-|P1|P2/);
  } finally { w.cleanup(); }
});

test("照合：手 5a の出力をファイルに保存し、道具がそれだけを読み直して評価できる。読むのは目録に載ったファイルだけ", async () => {
  const w = world({ candidates: ["a"] });
  try {
    const listed = new Set([
      ...w.inventory.version.factory_dist.files, ...w.inventory.version.spec_engine_dist.files, w.inventory.version.scoring_engine,
      ...w.inventory.candidates.flatMap((c) => [c.subject, c.origin, c.mutants, c.marks, c.context]),
    ].map((f) => f.path));
    const reads = [];
    const out = await scoreMutants({ inventory: w.inventory, readFile: (p) => { reads.push(p); return readFileSync(p); } });
    assert.ok(out.totals.eligible > 0);
    assert.ok(reads.length > 0 && reads.every((p) => listed.has(p)), "目録に無いファイルを読んだ");
    // 目録に載せたファイルは全部読まれる（読む前の照合）
    for (const p of listed) assert.ok(reads.includes(p), p);
  } finally { w.cleanup(); }
});

test("目録の拒否：SHA-256 が 1 つ合わない・手 5a の出力の原本の SHA-256 が違う・変異の原文を 1 バイト変える、は何も数えずに断る（固定の符号）", async () => {
  // 目録の SHA-256 が合わない（候補のどのファイルでも・版のどのファイルでも）
  for (const n of ["subject.json", "origin.yaml", "out5a.json", "marks.json", "context-a.json"]) {
    const w = world({ candidates: ["a"], keepInventorySha: { [n]: "0".repeat(64) } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "hash_mismatch"); } finally { w.cleanup(); }
  }
  {
    const w = world({ candidates: ["a"] });
    try {
      const bad = structuredClone(w.inventory);
      bad.version.factory_dist.files[bad.version.factory_dist.files.length - 1].sha256 = "1".repeat(64);
      await refused(scoreMutants({ inventory: bad }), "hash_mismatch");
      const bad2 = structuredClone(w.inventory);
      bad2.version.scoring_engine.sha256 = "2".repeat(64);
      await refused(scoreMutants({ inventory: bad2 }), "hash_mismatch");
      const bad3 = structuredClone(w.inventory);
      bad3.version.spec_engine_dist.files[0].sha256 = "3".repeat(64);
      await refused(scoreMutants({ inventory: bad3 }), "hash_mismatch");
    } finally { w.cleanup(); }
  }
  // 手 5a の出力に書かれた原本の SHA-256 が目録の原本と違う（目録の SHA-256 は出力に合わせてあるので、照合の段で落ちる）
  {
    const tampered = structuredClone(out5a);
    tampered.origins[0].sha256 = "f".repeat(64);
    const w = world({ candidates: ["a"], replace: { "out5a.json": JSON.stringify(tampered) } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "origin_sha_mismatch"); } finally { w.cleanup(); }
  }
  // 原本のファイルのほうが違う（出力の値に合う目録の SHA-256 のまま、別の宣言を置く）
  {
    const w = world({ candidates: ["a"], replace: { "origin.yaml": `${SRC}# edited\n` } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "origin_sha_mismatch"); } finally { w.cleanup(); }
  }
  {
    const tampered = structuredClone(out5a);
    tampered.origins[0].subject_sha256 = "e".repeat(64);
    const w = world({ candidates: ["a"], replace: { "out5a.json": JSON.stringify(tampered) } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "subject_sha_mismatch"); } finally { w.cleanup(); }
  }
  // 印の指紋が違う
  {
    const w = world({ candidates: ["a"], replace: { "marks.json": JSON.stringify({ ...MARKS, mutant_marks: [] }) } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "marks_mismatch"); } finally { w.cleanup(); }
  }
  // 出力に埋め込んだ変異の原文を 1 バイト変える（目録の SHA-256 は変えたあとの内容で計算してある）：評価の前に断る
  {
    const tampered = structuredClone(out5a);
    const m = tampered.mutants.find((x) => x.id === ID.default);
    m.source = `${m.source}\n`;
    const w = world({ candidates: ["a"], replace: { "out5a.json": JSON.stringify(tampered) } });
    try {
      await refused(scoreMutants({ inventory: w.inventory }), "mutant_sha_mismatch");
    } finally { w.cleanup(); }
  }
  // 文脈の食い違い・形の不正
  {
    const ctx = contextOf();
    ctx.suite = RAW_SUITE; // 棄却した試験が有効な組に残っている
    const w = world({ candidates: ["a"], replace: { "context-a.json": JSON.stringify(ctx) } });
    try { await refused(scoreMutants({ inventory: w.inventory }), "context_inconsistent"); } finally { w.cleanup(); }
    const ctx2 = contextOf();
    delete ctx2.non_requirements;
    const w2 = world({ candidates: ["a"], replace: { "context-a.json": JSON.stringify(ctx2) } });
    try { await refused(scoreMutants({ inventory: w2.inventory }), "invalid_context"); } finally { w2.cleanup(); }
  }
  await refused(scoreMutants({ inventory: { schema: "x" } }), "invalid_inventory");
});

test("入口：1 つでも合わなければ exit 3 と「符号 固定文」で、出力のファイルを書かない。正常なら要約を標準出力へ", () => {
  const w = world({ candidates: ["a"] });
  try {
    const invFile = join(w.dir, "inventory.json"), outFile = join(w.dir, "out.json"), badFile = join(w.dir, "bad.json");
    writeFileSync(invFile, JSON.stringify(w.inventory));
    const ok = spawnSync(process.execPath, [join(here, "score-mutants.mjs"), invFile, "--out", outFile], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /主の検出率/);
    assert.equal(JSON.parse(readFileSync(outFile, "utf8")).schema, OUTPUT_SCHEMA);
    const bad = structuredClone(w.inventory);
    bad.candidates[0].subject.sha256 = "0".repeat(64);
    writeFileSync(badFile, JSON.stringify(bad));
    const outBad = join(w.dir, "never.json");
    const r = spawnSync(process.execPath, [join(here, "score-mutants.mjs"), badFile, "--out", outBad], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(r.stderr.trim(), `hash_mismatch ${MESSAGES.hash_mismatch}`);
    assert.throws(() => readFileSync(outBad));
    const none = spawnSync(process.execPath, [join(here, "score-mutants.mjs")], { encoding: "utf8" });
    assert.equal(none.status, 3);
    assert.match(none.stderr, /^invalid_input /);
  } finally { w.cleanup(); }
});

test("匿名の口：P の番号・候補の ID・宣言の名前・パス・SHA-256 が無く、件数・率・演算子の ID だけ", async () => {
  const w = world({ candidates: ["a", "b"] });
  try {
    const full = await scoreMutants({ inventory: w.inventory });
    const anon = toAnonymous(full);
    const text = JSON.stringify(anon);
    assert.equal(anon.anonymous, true);
    assert.doesNotMatch(text, /[0-9a-f]{64}/);
    assert.doesNotMatch(text, /cand-|"P[0-9]|P1|P2/);
    assert.ok(!text.includes(w.dir) && !text.includes(factoryEntry) && !text.includes("origin.yaml"));
    for (const name of ["finish", "addItem", "positiveQuantity", "memo", "f.member", "state", "o1", "t-default", "t-shows", "c.ghost", "f.item"]) assert.ok(!text.includes(name), name);
    assert.ok(!("fingerprints" in anon) && !("candidates" in anon) && !("mutants" in anon));
    assert.deepEqual(anon.totals.by_category, full.totals.by_category);
    assert.equal(anon.by_candidate.length, 2);
    assert.ok(Object.keys(anon.by_operator).every((k) => ["remove-field", "flip-comparison", "remove-when", "reorder-options", "change-default", "remove-validation", "swap-aggregate"].includes(k)));
    assert.deepEqual(Object.keys(anon.by_operator), Object.keys(full.by_operator));
  } finally { w.cleanup(); }
});

test("rowsOfPlace：場所を表の行に当てる（除く行・検査は当たらない）", () => {
  assert.deepEqual(rowsOfPlace("item.state.default(open→doing)", TABLE), ["f.item.state"]);
  assert.deepEqual(rowsOfPlace("member.note", TABLE), ["f.member.note"]);
  assert.deepEqual(rowsOfPlace("actions.finish.when", TABLE), ["o.finish"]);
  assert.deepEqual(rowsOfPlace("computed.ghost.expression(<→>=)", TABLE), ["c.ghost"]);
  assert.deepEqual(rowsOfPlace("computed.ghost.expression(<→>=)", TABLE, ["c.ghost"]), []);
  assert.deepEqual(rowsOfPlace("validations.positiveQuantity", TABLE), []);
  assert.deepEqual(rowsOfPlace("item.title", TABLE), ["f.item.title"]);
});

test("静的な走査：道具に工場の package の import・通信・LLM・判定の口が無い。工場の側はこの道具を参照しない", () => {
  const src = readFileSync(join(here, "score-mutants.mjs"), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /from\s+["']@musunest\//);
  assert.doesNotMatch(code, /from\s+["'][^"']*packages\//);
  assert.doesNotMatch(code, /require\(/);
  const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["./classify.mjs", "./mutate.mjs", "node:crypto", "node:fs", "node:path", "node:url"]);
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|node:(http|https|net|tls|dgram|child_process)|openai|anthropic|process\.env|new Date\(|Date\.now\(|\bjudge[A-Z(]/i);
  // 工場の側（packages/ の src）のどのファイルもこの道具を参照しない
  const walkSrc = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === "node_modules" || n === "dist") return [];
    return statSync(p).isDirectory() ? walkSrc(p) : /\.(ts|tsx|mjs|js|json)$/.test(n) ? [p] : [];
  });
  for (const f of walkSrc(join(root, "packages"))) assert.ok(!readFileSync(f, "utf8").includes("score-mutants"), relative(root, f));
});

test("題材の言葉：試験・fixture のどこにも無い", () => {
  // 語は符号の列で持つ（この試験のファイル自身に書かない）
  const words = [[0x6301, 0x3061, 0x5bc4, 0x308a], [0x5f53, 0x756a, 0x8868], [0x4f1a, 0x8cbb], [0x51fa, 0x6b20], [0x8cb8, 0x3057, 0x51fa, 0x3057]].map((cs) => String.fromCodePoint(...cs));
  const w = world();
  try {
    const texts = [readFileSync(fileURLToPath(import.meta.url), "utf8"), ...Object.values(w.files)];
    for (const t of texts) for (const word of words) assert.ok(!t.includes(word), word);
    assert.ok(CATEGORY_IDS.length === 11);
  } finally { w.cleanup(); }
});

test("README：試験の点検（変異）の節があり、やることの項目が載り、既存の節の見出しの並びが変わらない", () => {
  const readme = readFileSync(join(here, "../README.md"), "utf8");
  const at = readme.indexOf("### 5.12 試験の点検（変異");
  assert.ok(at > 0);
  const end = readme.indexOf("\n## 6. ", at);
  const section = readme.slice(at, end);
  for (const item of [
    "remove-field", "flip-comparison", "remove-when", "reorder-options", "change-default", "remove-validation", "swap-aggregate",
    "優先順", "試験で落ちる", "結び付けで落ちる", "未解決だけ", "生き残る", "試験と原本が合わない",
    "適格な変異", "条件付き", "選別", "分類の割合の分母", "参考（独立を仮定）", "まとまり", "目録", "有効な評価の文脈", "SHA-256",
    "--anonymous", "門ではない", "費用 0", "終了コード 3", "落とせない試験", "null",
  ]) assert.ok(section.includes(item), item);
  const heads = [...readme.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)].map((m) => m[1]);
  const i511 = heads.indexOf("5.11");
  assert.deepEqual(heads.slice(i511, i511 + 3), ["5.11", "5.12", "6"]);
});
