// mutate.mjs の試験（node --test。#552）。API・通信・LLM・時計を使わない。手で組んだ中立な宣言で閉じる。
// 実行（pnpm build のあと）: node --test workspace/mvp/m1/agent/eval/mutation/mutate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MAX_PER_SPEC, MESSAGES, MutationToolError, NOT_BUILT_REASONS, OPERATORS, OPERATOR_IDS, comparisonsIn, generateMutants, sha256, specEqual } from "./mutate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../../../..");
const engine = await import(pathToFileURL(join(repo, "packages/spec-engine/dist/index.js")).href);

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

const ids = (r) => r.mutants.map((m) => m.id);
const all = await generateMutants({ engine, source: SRC });

test("(1) 7 つの演算子が、期待した場所に 1 つずつ変異を作る", () => {
  assert.deepEqual(OPERATOR_IDS, ["remove-field", "flip-comparison", "remove-when", "reorder-options", "change-default", "remove-validation", "swap-aggregate"]);
  for (const o of OPERATORS) assert.ok(o.id && o.why && o.since, "id・why・since を持つ");
  assert.deepEqual(ids(all), [
    "reorder-options@entities[1].fields.state.options#0",
    "reorder-options@entities[1].fields.state.options#1",
    "change-default@entities[1].fields.state.default",
    "remove-field@entities[1].fields.memo",
    "swap-aggregate@computed[0].aggregate",
    "swap-aggregate@computed[1].aggregate",
    "flip-comparison@actions[2].when#0",
    "remove-when@actions[2].when",
    "remove-validation@validations[0]",
    "flip-comparison@validations[0].expression#0",
    "remove-validation@validations[1]",
    "flip-comparison@validations[1].expression#0",
  ]);
  const by = (op) => all.mutants.filter((m) => m.operator === op);
  for (const op of OPERATOR_IDS) assert.ok(by(op).length >= 1, op);
  const text = (id) => all.mutants.find((m) => m.id === id).source;
  assert.match(text("reorder-options@entities[1].fields.state.options#0"), /options:\n {10}doing: Doing\n {10}open: Open\n {10}done: Done/);
  assert.match(text("reorder-options@entities[1].fields.state.options#1"), /open: Open\n {10}done: Done\n {10}doing: Doing/);
  assert.match(text("change-default@entities[1].fields.state.default"), /default: doing\n/);
  assert.doesNotMatch(text("remove-field@entities[1].fields.memo"), /memo/);
  assert.match(text("swap-aggregate@computed[0].aggregate"), /sum: item\.quantity\n {6}where:\n {8}owner: this\n {4}type: number\n {4}label: Items/);
  assert.match(text("swap-aggregate@computed[1].aggregate"), /count: item\n {6}where:\n {8}owner: this\n {4}type: number\n {4}label: Total/);
  assert.match(text("flip-comparison@actions[2].when#0"), /when: state != "open"/);
  assert.doesNotMatch(text("remove-when@actions[2].when"), /when:/);
  assert.match(text("flip-comparison@validations[0].expression#0"), /expression: quantity < 1/);
  assert.match(text("flip-comparison@validations[1].expression#0"), /expression: quantity > 100/);
  assert.equal(all.counts.kept, 12);
  assert.equal(all.counts.truncated, 0);
});

test("(1) 変えた場所の行の範囲の外は原文のまま、読み直せて、変えた場所の外の値が原本と深く等しい", async () => {
  const orig = await engine.normalizeSpec(SRC);
  const lines = SRC.split("\n");
  for (const m of all.mutants) {
    const mut = m.source.split("\n");
    const { from, to } = m.lines;
    assert.deepEqual(mut.slice(0, from - 1), lines.slice(0, from - 1), `${m.id} 範囲の前`);
    assert.deepEqual(mut.slice(mut.length - (lines.length - to)), lines.slice(to), `${m.id} 範囲の後`);
    const r = await engine.normalizeSpec(m.source);
    assert.ok(r.ok, m.id);
    assert.equal(m.sha256, sha256(m.source));
    assert.equal(specEqual(r.app.spec, orig.app.spec), false, `${m.id} は原本と違う`);
  }
  // 場所の外の比較の例：remove-field は項目だけが無く、ほかは原本どおり
  const rf = all.mutants.find((m) => m.operator === "remove-field");
  const spec = (await engine.normalizeSpec(rf.source)).app.spec;
  const expected = JSON.parse(JSON.stringify(orig.app.spec));
  delete expected.entities[1].fields.memo;
  assert.equal(specEqual(spec, expected), true);
});

test("読み直せない書き換えは「作れなかった」に数えられ、一覧に無い", () => {
  const failed = all.not_built.filter((n) => n.reason === "reread-failed").map((n) => n.id);
  assert.deepEqual(failed, [
    "remove-field@entities[0].fields.name",
    "remove-field@entities[1].fields.title",
    "remove-field@entities[1].fields.owner",
    "remove-field@entities[1].fields.quantity",
    "remove-field@entities[1].fields.state",
  ]);
  for (const id of failed) assert.ok(!ids(all).includes(id));
  assert.equal(all.counts.not_built, failed.length);
  assert.equal(all.counts.candidates, all.counts.built + all.counts.not_built);
  for (const reason of Object.keys(NOT_BUILT_REASONS)) assert.ok(NOT_BUILT_REASONS[reason]);
});

test("場所の外まで変わる書き換えは「作れなかった」に数えられ、一覧に無い", async () => {
  // 読み取りの結果が、when を消した変異でだけ別の場所（permissions）まで変わるように見せる偽物の engine
  const spy = {
    normalizeSpec: async (text) => {
      const r = await engine.normalizeSpec(text);
      if (r.ok && !text.includes("when:")) r.app.spec.permissions[0].subject = "changed";
      return r;
    },
  };
  const r = await generateMutants({ engine: spy, source: SRC, operators: ["remove-when", "flip-comparison"] });
  assert.deepEqual(r.not_built.map((n) => [n.id, n.reason]), [["remove-when@actions[2].when", "outside-changed"]]);
  assert.ok(!ids(r).includes("remove-when@actions[2].when"));
  assert.equal(ids(r).length, 3);
});

test("原文が変わらない書き換えと、読めない原本は変異を作らない", async () => {
  const unreadable = await generateMutants({ engine, source: "entities: [\n" });
  assert.equal(unreadable.origin_readable, false);
  assert.deepEqual(unreadable.mutants, []);
  // 選択肢が 1 つだけなら入れ替えも default の変更も場所にならない
  const one = SRC.replace("          doing: Doing\n", "").replace("          done: Done\n", "");
  const r = await generateMutants({ engine, source: one, operators: ["reorder-options", "change-default"] });
  assert.deepEqual(ids(r), []);
});

test("(3) 同じ入力で 2 回、ID・SHA-256・順が同じ。原文の SHA-256 を持つ", async () => {
  const again = await generateMutants({ engine, source: SRC });
  assert.deepEqual(again.mutants.map((m) => [m.id, m.sha256]), all.mutants.map((m) => [m.id, m.sha256]));
  assert.equal(all.origin_sha256, sha256(SRC));
  assert.equal(new Set(ids(all)).size, ids(all).length);
  const lineOrder = all.mutants.map((m) => m.lines.from);
  assert.deepEqual(lineOrder, [...lineOrder].sort((a, b) => a - b), "原文の出現順");
});

test("(4) 上限 3 で切ると決まった 3 つが残り、切った数が出る", async () => {
  const r = await generateMutants({ engine, source: SRC, max: 3 });
  assert.deepEqual(ids(r), ids(all).slice(0, 3));
  assert.equal(r.counts.kept, 3);
  assert.equal(r.counts.truncated, all.counts.built - 3);
  assert.equal(DEFAULT_MAX_PER_SPEC, 50);
  assert.deepEqual(r.counts.by_operator, { "reorder-options": 2, "change-default": 1 });
  await assert.rejects(() => generateMutants({ engine, source: SRC, max: 0 }), (e) => e instanceof MutationToolError && e.message === MESSAGES.invalidMax);
});

test("演算子の指定で絞れる", async () => {
  const r = await generateMutants({ engine, source: SRC, operators: ["swap-aggregate"] });
  assert.deepEqual(ids(r), ["swap-aggregate@computed[0].aggregate", "swap-aggregate@computed[1].aggregate"]);
});

test("(5) 未登録の演算子は固定文で断る（入力の値を文に入れない）", async () => {
  await assert.rejects(() => generateMutants({ engine, source: SRC, operators: ["remove-field", "no-such-op"] }), (e) => e instanceof MutationToolError && e.code === "unknown_operator" && e.message === MESSAGES.unknownOperator && !e.message.includes("no-such-op"));
  await assert.rejects(() => generateMutants({ engine, source: SRC, operators: "remove-field" }), (e) => e.message === MESSAGES.invalidOperators);
});

test("比較の演算子は文字列の中を見ない。= の反転の組", () => {
  assert.deepEqual(comparisonsIn('a < 1').map((h) => h.op), ["<"]);
  assert.deepEqual(comparisonsIn('a >= 1').map((h) => h.op), [">="]);
  assert.deepEqual(comparisonsIn('s == "a<b"').map((h) => h.op), ["=="]);
  assert.deepEqual(comparisonsIn('s != \\"x>=y\\"').map((h) => h.op), ["!="]);
});

// ── 走査：工場の package の静的 import・通信・LLM の口が無い／工場の側がこの道具を参照しない／題材の言葉が無い
const files = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n === ".git") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
};
const TOOL_FILES = ["mutate.mjs", "classify.mjs"].map((n) => join(here, n));
const SUBJECT_WORDS = ["持ち寄り", "当番表", "会費", "出欠", "貸し出し"];

test("道具のファイルに、工場の package の静的 import と、通信・LLM の口が無い", () => {
  for (const f of TOOL_FILES) {
    const t = readFileSync(f, "utf8");
    const statics = [...t.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const s of statics) assert.ok(s.startsWith("node:") || s.startsWith("./"), `${f}: ${s}`);
    assert.doesNotMatch(t, /packages\/factory|@musunest\/factory|packages\/control-plane|packages\/data-api/);
    assert.doesNotMatch(t, /\bfetch\s*\(|node:(?:http|https|net|tls|dgram|dns)\b|XMLHttpRequest|WebSocket|OPENAI_API_KEY|JEV_API_KEY|api\.openai|anthropic|process\.env|Date\.now|new Date\(/);
  }
});

test("工場の側のどのファイルもこの道具を参照しない", () => {
  for (const f of files(join(repo, "packages/factory"))) {
    if (!/\.(ts|mjs|js|json|md)$/.test(f)) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), /eval\/mutation|mutation\/(?:mutate|classify)/, relative(repo, f));
  }
});

test("試験・fixture のどこにも題材の言葉が無い", () => {
  for (const f of [...TOOL_FILES, join(here, "mutate.test.mjs"), join(here, "classify.test.mjs")]) {
    const t = readFileSync(f, "utf8").replace(/const SUBJECT_WORDS = .*\n/, "");
    for (const w of SUBJECT_WORDS) assert.ok(!t.includes(w), `${f}: ${w}`);
  }
});
