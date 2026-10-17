// classify.mjs の試験（node --test。#552）。API・通信・LLM・時計を使わない。
// 原本・題材の定義・印は手で組んだ中立なもの。外の採点は eval/engine.mjs（v5）をそのまま使う。
// 実行（pnpm build のあと）: node --test workspace/mvp/m1/agent/eval/mutation/classify.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES, CLASS_IDS, DENOMINATOR_RULE, MARKS_SCHEMA, MESSAGES, OUTPUT_SCHEMA, classifyMutations, loadMarks, verifyOutput } from "./classify.mjs";
import { MutationToolError, generateMutants, sha256 } from "./mutate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engineFile = join(here, "../../../../../../packages/spec-engine/dist/index.js");
const scoringEngineFile = join(here, "../engine.mjs");
const engine = await import(engineFile);

const SRC = `# note
entities:
  - name: member
    fields:
      name:
        type: string
        label: Name
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
  - name: quantityTotal
    entity: member
    aggregate:
      sum: item.quantity
      where:
        owner: this
    type: number
    label: Total
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

// 題材の定義（中立な名前で手で組む）：登録時の状態・状態を進める操作・状態の列のボード・登録・数の検査
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
// PASS にならない定義（数の検査の期待を逆にする）
const DEF_FAIL = { ...DEF, id: "T-fail", structures: [{ ...DEF.structures[0], checks: [...DEF.structures[0].checks.slice(0, 4), { req: "quantity-rule", kind: "validation", entity: "main", cases: [{ set: { qty: 0 }, valid: true }] }] }] };

const gen = await generateMutants({ engine, source: SRC });
const byId = (id) => gen.mutants.find((m) => m.id === id);
const ID = {
  reorder: "reorder-options@entities[1].fields.state.options#0",
  default: "change-default@entities[1].fields.state.default",
  memo: "remove-field@entities[1].fields.memo",
  swap: "swap-aggregate@computed[0].aggregate",
  flipWhen: "flip-comparison@actions[2].when#0",
  removeWhen: "remove-when@actions[2].when",
  removeValidation: "remove-validation@validations[0]",
};
const markAt = (id, verdict, role = "reviewer-a") => ({ sha256: byId(id).sha256, reviewer_role: role, verdict });
const marksOf = (mutant_marks = [], origin_marks = []) => ({ schema: MARKS_SCHEMA, origin_marks, mutant_marks });
const run = (extra = {}) => classifyMutations({ engineFile, scoringEngineFile, origins: [{ id: "o1", source: SRC, def: DEF }], ...extra });
const classOf = (out, id) => out.mutants.find((m) => m.id === id);
const handMade = (id, source) => ({ id, operator: "remove-field", place: id, lines: { from: 1, to: 1 }, source, sha256: sha256(source) });

test("原本は PASS で使える。外の採点の差のある変異は非同値（確定）、差も印も無ければ判定不能", async () => {
  const out = await run();
  assert.equal(out.schema, OUTPUT_SCHEMA);
  assert.equal(out.origins[0].usable, true);
  assert.equal(out.origins[0].scoring_verdict, "PASS");
  // (c) 外の採点の差で非同値（確定）
  for (const id of [ID.default, ID.flipWhen, ID.removeWhen, ID.removeValidation]) assert.equal(classOf(out, id).class, "non-equivalent", id);
  assert.deepEqual(classOf(out, ID.default).differing_checks, ["default-state"]);
  assert.equal(classOf(out, ID.default).reason_code, "non-equivalent:scoring");
  // (d) 差も印も無ければ判定不能（同値とも非同値とも推測しない）
  for (const id of [ID.reorder, ID.memo, ID.swap]) assert.equal(classOf(out, id).class, "undecidable", id);
  assert.equal(out.counts.detection_denominator, out.counts.by_class["non-equivalent"]);
});

test("(a)(k) 静的に落ちる変異は静的に落ちる。印があっても変わらない", async () => {
  const bad = handMade("bad", "entities: [\n");
  const out = await run({ mutants: { o1: [bad] }, marks: marksOf([{ sha256: bad.sha256, reviewer_role: "reviewer-a", verdict: "non-equivalent" }, { sha256: bad.sha256, reviewer_role: "reviewer-b", verdict: "equivalent" }]) });
  assert.equal(out.mutants[0].class, "static-fail");
  assert.equal(out.counts.ignored_marks.mutant, 0);
});

test("(b) 構文の同値：原文の SHA-256 が違い app.spec が同じなら、印なしは構文の同値", async () => {
  const same = handMade("comment-only", `${SRC}# only a comment\n`);
  assert.notEqual(same.sha256, sha256(SRC));
  const out = await run({ mutants: { o1: [same] } });
  assert.equal(out.mutants[0].class, "syntactic-equivalent");
});

test("(e) 印が同値で差が無ければ同値（人の印）、印が非同値で差が無ければ非同値", async () => {
  const eq = await run({ marks: marksOf([markAt(ID.reorder, "equivalent")]) });
  assert.equal(classOf(eq, ID.reorder).class, "equivalent-marked");
  assert.deepEqual(classOf(eq, ID.reorder).marks, [{ reviewer_role: "reviewer-a", verdict: "equivalent" }]);
  const non = await run({ marks: marksOf([markAt(ID.reorder, "non-equivalent")]) });
  assert.equal(classOf(non, ID.reorder).class, "non-equivalent");
  assert.equal(classOf(non, ID.reorder).reason_code, "non-equivalent:mark");
  // 同じ SHA-256 に同じ向きの印が複数あっても同じ分類
  const two = await run({ marks: marksOf([markAt(ID.reorder, "equivalent", "r1"), markAt(ID.reorder, "equivalent", "r2")]) });
  assert.equal(classOf(two, ID.reorder).class, "equivalent-marked");
});

test("(f) PASS でない原本・原本の印がある原本は原本不適で、その変異は全部が原本不適", async () => {
  const failing = await classifyMutations({ engineFile, scoringEngineFile, origins: [{ id: "o1", source: SRC, def: DEF_FAIL }] });
  assert.equal(failing.origins[0].usable, false);
  assert.equal(failing.origins[0].reason_code, "not-pass");
  assert.ok(failing.mutants.length > 0);
  assert.ok(failing.mutants.every((m) => m.class === "origin-unusable"));
  const marked = await run({ marks: marksOf([markAt(ID.default, "non-equivalent")], [{ sha256: sha256(SRC), reviewer_role: "reviewer-a", verdict: "incorrect" }]) });
  assert.equal(marked.origins[0].usable, false);
  assert.equal(marked.origins[0].reason_code, "marked-incorrect");
  assert.ok(marked.mutants.every((m) => m.class === "origin-unusable"));
  assert.equal(marked.counts.by_class["origin-unusable"], marked.counts.mutants);
  assert.equal(marked.counts.detection_denominator, 0);
  // 静的に落ちる原本は変異を作れない（原本不適）
  const bad = await classifyMutations({ engineFile, scoringEngineFile, origins: [{ id: "o1", source: "entities: [\n", def: DEF }] });
  assert.equal(bad.origins[0].usable, false);
  assert.equal(bad.origins[0].reason_code, "static-ng");
  assert.equal(bad.counts.mutants, 0);
});

test("(g) 一覧に無い SHA-256 の印は無視され、件数が出る", async () => {
  const stray = "0".repeat(64);
  const out = await run({ marks: marksOf([markAt(ID.reorder, "equivalent"), { sha256: stray, reviewer_role: "r", verdict: "equivalent" }, { sha256: "1".repeat(64), reviewer_role: "r", verdict: "non-equivalent" }], [{ sha256: stray, reviewer_role: "r", verdict: "incorrect" }]) });
  assert.deepEqual(out.counts.ignored_marks, { origin: 1, mutant: 2 });
  assert.equal(out.origins[0].usable, true, "知らない値の原本の印は効かない");
  assert.equal(classOf(out, ID.reorder).class, "equivalent-marked");
});

test("(h) 外の採点に差があり印が同値なら食い違い（非同値にも同値にも入らない）", async () => {
  const out = await run({ marks: marksOf([markAt(ID.default, "equivalent")]) });
  const m = classOf(out, ID.default);
  assert.equal(m.class, "discrepancy");
  assert.equal(m.reason_code, "scoring-vs-equivalent");
});

test("(i) 同じ変異に非同値と同値の印があれば食い違い", async () => {
  const out = await run({ marks: marksOf([markAt(ID.reorder, "non-equivalent", "r1"), markAt(ID.reorder, "equivalent", "r2")]) });
  assert.equal(classOf(out, ID.reorder).class, "discrepancy");
  assert.equal(classOf(out, ID.reorder).reason_code, "marks-conflict");
});

test("(j)(m) 構文の同値なのに印が非同値なら食い違い。印なしなら構文の同値", async () => {
  const same = handMade("comment-only", `# leading comment\n${SRC}`);
  const none = await run({ mutants: { o1: [same] } });
  assert.equal(none.mutants[0].class, "syntactic-equivalent");
  assert.notEqual(none.mutants[0].sha256, sha256(SRC));
  const non = await run({ mutants: { o1: [same] }, marks: marksOf([{ sha256: same.sha256, reviewer_role: "reviewer-a", verdict: "non-equivalent" }]) });
  assert.equal(non.mutants[0].class, "discrepancy");
  assert.equal(non.mutants[0].reason_code, "spec-equal-vs-non-equivalent");
  // 構文の同値で印が同値なら、食い違いにはならない
  const eq = await run({ mutants: { o1: [same] }, marks: marksOf([{ sha256: same.sha256, reviewer_role: "reviewer-a", verdict: "equivalent" }]) });
  assert.equal(eq.mutants[0].class, "syntactic-equivalent");
});

test("(l)(n) どの fixture でも 1 つの変異が 2 つの分類に入らず、7 分類の和が作れた変異の数と等しい。変異の原文が埋め込まれ SHA-256 が一致する", async () => {
  const everything = marksOf([markAt(ID.reorder, "equivalent"), markAt(ID.default, "equivalent"), markAt(ID.swap, "non-equivalent"), markAt(ID.memo, "non-equivalent"), markAt(ID.memo, "equivalent", "r2")]);
  const hand = [handMade("bad", "entities: [\n"), handMade("comment-only", `${SRC}# c\n`)];
  const fixtures = [
    await run(),
    await run({ marks: everything }),
    await run({ marks: everything, max: 3 }),
    await run({ mutants: { o1: hand }, marks: marksOf([{ sha256: hand[0].sha256, reviewer_role: "a", verdict: "equivalent" }]) }),
    await classifyMutations({ engineFile, scoringEngineFile, origins: [{ id: "o1", source: SRC, def: DEF_FAIL }, { id: "o2", source: SRC, def: DEF }], marks: everything }),
  ];
  for (const out of fixtures) {
    assert.equal(CLASS_IDS.length, 7);
    assert.deepEqual(Object.keys(out.counts.by_class), CLASS_IDS);
    assert.equal(Object.values(out.counts.by_class).reduce((a, b) => a + b, 0), out.counts.mutants);
    assert.equal(out.mutants.length, out.counts.mutants);
    for (const m of out.mutants) {
      assert.equal(CLASS_IDS.filter((c) => c === m.class).length, 1);
      assert.equal(typeof m.source, "string");
      assert.equal(sha256(m.source), m.sha256);
    }
    for (const op of Object.values(out.counts.by_operator)) assert.equal(CLASS_IDS.reduce((a, c) => a + op[c], 0), op.total);
    for (const o of out.origins) assert.equal(Object.values(o.counts.by_class).reduce((a, b) => a + b, 0), o.counts.mutants);
    assert.ok(verifyOutput(out));
    assert.equal(out.counts.detection_denominator, out.counts.by_class["non-equivalent"]);
  }
  assert.equal(fixtures[2].counts.mutants, 3);
});

test("出力の定義の欄に、検出率の分母の規則が固定文で入っている。分母に入るのは非同値だけ", async () => {
  const out = await run();
  assert.equal(out.definitions.detection_denominator_rule, DENOMINATOR_RULE);
  assert.deepEqual(out.definitions.classes.map((c) => c.id), ["origin-unusable", "static-fail", "discrepancy", "syntactic-equivalent", "non-equivalent", "equivalent-marked", "undecidable"]);
  assert.deepEqual(out.definitions.classes.map((c) => c.priority), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(CLASSES.filter((c) => c.in_denominator).map((c) => c.id), ["non-equivalent"]);
});

test("出力に原本・題材の定義・印・spec-engine と採点のエンジンの SHA-256 と道具の指紋が入る。同じ入力なら同じ出力", async () => {
  const marks = marksOf([markAt(ID.reorder, "equivalent")]);
  const a = await run({ marks }), b = await run({ marks });
  assert.deepEqual(a, b);
  for (const k of ["tool", "spec_engine", "scoring_engine", "marks"]) assert.match(a.fingerprints[k], /^[0-9a-f]{64}$/, k);
  assert.equal(a.fingerprints.origins.o1.source, sha256(SRC));
  assert.equal(a.fingerprints.origins.o1.subject_definition, sha256(JSON.stringify(DEF)));
  const c = await run({ marks: marksOf([markAt(ID.reorder, "non-equivalent")]) });
  assert.notEqual(c.fingerprints.marks, a.fingerprints.marks);
});

test("知らない値の印・形の違う印は固定文で断る", () => {
  assert.throws(() => loadMarks({ schema: "x" }), (e) => e instanceof MutationToolError && e.code === "invalid_marks" && e.message === MESSAGES.marksSchema);
  assert.throws(() => loadMarks(marksOf([{ sha256: "a".repeat(64), reviewer_role: "r", verdict: "maybe" }])), (e) => e.message === MESSAGES.marksVerdict);
  assert.throws(() => loadMarks(marksOf([], [{ sha256: "a".repeat(64), reviewer_role: "r", verdict: "equivalent" }])), (e) => e.message === MESSAGES.marksVerdict);
  assert.throws(() => loadMarks(marksOf([{ sha256: "abc", reviewer_role: "r", verdict: "equivalent" }])), (e) => e.message === MESSAGES.marksShape);
  assert.throws(() => loadMarks(marksOf([{ sha256: "a".repeat(64), reviewer_role: " ", verdict: "equivalent" }])), (e) => e.message === MESSAGES.marksShape);
  assert.deepEqual(loadMarks(null).mutant_marks, []);
  assert.deepEqual(loadMarks(JSON.stringify(marksOf())).origin_marks, []);
});

test("原文だけ 1 バイト変えて sha256 を据え置いた変異は断られ、印は適用されない（出力も作られない）", async () => {
  const m = byId(ID.reorder);
  const tampered = { ...m, source: m.source.replace("# note", "# Note") };
  assert.notEqual(tampered.source, m.source);
  assert.equal(tampered.sha256, m.sha256);
  await assert.rejects(
    () => run({ mutants: { o1: [tampered] }, marks: marksOf([markAt(ID.reorder, "non-equivalent")]) }),
    (e) => e instanceof MutationToolError && e.code === "mutant_sha_mismatch" && e.message === MESSAGES.mutantSha,
  );
  // 原文が文字列でない申告も断る
  await assert.rejects(() => run({ mutants: { o1: [{ ...m, source: null }] } }), (e) => e.code === "mutant_sha_mismatch");
  // 照合が通る変異は従来どおり印が適用される
  const ok = await run({ mutants: { o1: [m] }, marks: marksOf([markAt(ID.reorder, "non-equivalent")]) });
  assert.equal(ok.mutants[0].class, "non-equivalent");
});

test("入口（node classify.mjs <入力の JSON>）：原文だけ 1 バイト変えた変異は exit 3・標準エラーに符号・標準出力は空。照合が通れば exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "classify-cli-"));
  try {
    const m = byId(ID.reorder);
    const input = (mutant) => {
      const f = join(dir, `in-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify({ engineFile, scoringEngineFile, origins: [{ id: "o1", source: SRC, def: DEF }], marks: marksOf([markAt(ID.reorder, "non-equivalent")]), mutants: { o1: [mutant] } }));
      return f;
    };
    const cli = (f) => spawnSync(process.execPath, [join(here, "classify.mjs"), f], { encoding: "utf8" });
    const bad = cli(input({ ...m, source: m.source.replace("# note", "# Note") }));
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /^mutant_sha_mismatch /);
    assert.equal(bad.stdout, "");
    const ok = cli(input(m));
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.mutants[0].class, "non-equivalent");
    assert.equal(verifyOutput(out), true);
    const none = spawnSync(process.execPath, [join(here, "classify.mjs")], { encoding: "utf8" });
    assert.equal(none.status, 3);
    assert.equal(none.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
