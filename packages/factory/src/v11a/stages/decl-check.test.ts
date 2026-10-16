// B3' 宣言の意味の点検（v11a/stages/decl-check.ts）の試験（Issue #507）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 反例 3 つ（宣言だけを変える／振る舞いが追加の要素へ移る／補助の定義だけを変える）で、拒否が種類と引用
//      つきで返り、宣言の SHA を持つ。反例ごとに宣言だけが違う対照を置き、データの並び・印の形が同じで受理が返る
//   2. データに宣言の全文（`source` と文字列で等しい）・印・追加の要素の一覧（A1 の関数の値と深く等しい）があり、
//      試験・期待・合否の塊が無い
//   3. 印を引き当てられない要件は要求の対象に含まれず「文脈なし」で返る
//   4. 完全性の負例は T1'' と同じく形の落ち（2 回続けば malformed・calls 2）
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects } from "../../stages/prompt.js";
import { createRecordingClient, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, fixtureList, fixtureTable, fixtureYaml, normalizedFixture } from "../__tests__/fixtures.js";
import { extraElementsOf, markRows, type DeclarationMark } from "../bind-by-id.js";
import {
  DECL_CHECK_RULE_DEFINITIONS,
  DECL_CHECK_RULES,
  DECL_CHECK_SCHEMA,
  DECL_CHECK_SCHEMA_NAME,
  DECL_REJECTION_KINDS,
  runDeclCheck,
} from "./decl-check.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

function planOf(list: RequirementList): ConfirmedPlan {
  return {
    schema_version: "1",
    plan_id: "plan-1",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-10-16T00:00:00+09:00", confirmed_by: "tester" },
  };
}

const FULL_LIST = fixtureList();
const PLAN = planOf(FULL_LIST);
/** 持ち越し（R5 は unresolved）を除いた残りの要件 */
const LIST: RequirementList = { ...FULL_LIST, requirements: FULL_LIST.requirements.filter((entry) => entry.id !== "R5") };
const TARGETS = ["R1", "R2", "R3", "R4"];
const TABLE = fixtureTable();

const accept = (requirementId: string) => ({ requirementId, verdict: "accept", kind: null, quote: null });
const reject = (requirementId: string, kind: string, quote: string) => ({ requirementId, verdict: "reject", kind, quote });

/** 置き換えが 1 か所に効いたことを確かめて置き換える（宣言の前提が崩れたら落とす） */
function replaced(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}

/** 表に無い要素 `realRate`（本当の率の計算）を足した宣言 */
const withRealRate = (source: string): string =>
  replaced(
    source,
    "  - name: byKind\n",
    "  - name: realRate\n    scope: app\n    expression: base * 2\n    type: number\n  - name: byKind\n",
  );

async function run(source: string, outputs: readonly unknown[], list: RequirementList = LIST) {
  const app = await normalizedFixture(source);
  const recording = createRecordingClient(outputs.map(structured));
  const outcome = await runDeclCheck({
    plan: PLAN,
    list,
    table: TABLE,
    declaration: { source },
    app,
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
  });
  return { outcome, requests: recording.structured, app };
}

const dataBlocks = (input: string) =>
  [...input.matchAll(/<data name="([^"]+)">\n([\s\S]*?)\n<\/data>/g)].map((match) => ({
    name: match[1] as string,
    text: match[2] as string,
  }));

/**
 * 印の形（id・要素の種類と経路・欄の名前と、参照先 1 つの欄の名前）。参照先の数と値は宣言で変わる（定数の式は
 * 参照先を持たない）ので、形だけを比べる。
 */
const markShape = (marks: readonly DeclarationMark[]) => ({
  marks: marks.map((mark) => ({ id: mark.id, keys: Object.keys(mark).sort(), element: [mark.element.kind, mark.element.path] })),
  referenceKeys: [...new Set(marks.flatMap((mark) => mark.references.map((reference) => Object.keys(reference).sort().join(","))))],
});

// ── 反例と対照（宣言だけが違う。表と試験は同じ）──────────────────────────

interface Counterexample {
  readonly label: string;
  readonly requirementId: string;
  readonly kind: (typeof DECL_REJECTION_KINDS)[number];
  readonly quote: string;
  readonly bad: string;
  readonly control: string;
}

const COUNTEREXAMPLES: readonly Counterexample[] = [
  {
    label: "宣言だけを変える（操作の when が要件より緩い）",
    requirementId: "R3",
    kind: "mismatch",
    quote: "金額が 0 より大きい項目だけ",
    bad: replaced(FIXTURE_YAML, "when: amount > 0", "when: amount >= 0"),
    control: FIXTURE_YAML,
  },
  {
    label: "振る舞いが追加の要素へ移る（所属の計算が定数で、本当の計算は表に無い要素にある）",
    requirementId: "R4",
    kind: "behavior-outside-ownership",
    quote: "全体の率",
    bad: withRealRate(replaced(FIXTURE_YAML, "expression: base * 2", "expression: 2 * 3")),
    control: withRealRate(FIXTURE_YAML),
  },
  {
    label: "補助の定義だけを変える（所属する計算の式は同じで、参照する補助の計算の式だけが誤り）",
    requirementId: "R4",
    kind: "auxiliary-mismatch",
    quote: "全体の率",
    bad: replaced(
      FIXTURE_YAML,
      "  - name: base\n    scope: app\n    aggregate:\n      sum: item.amount\n",
      "  - name: base\n    scope: app\n    aggregate:\n      count: item\n",
    ),
    control: FIXTURE_YAML,
  },
];

describe("B3' の規則と schema", () => {
  it("規則の定義に不備が無く、送る文は定義の text から組む", () => {
    expect(ruleDefinitionDefects(DECL_CHECK_RULE_DEFINITIONS)).toEqual([]);
    expect(DECL_CHECK_RULES).toEqual(DECL_CHECK_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(DECL_CHECK_RULE_DEFINITIONS.every((definition) => /^R-dc-\d\d$/.test(definition.id))).toBe(true);
    expect(DECL_REJECTION_KINDS).toEqual(["mismatch", "auxiliary-mismatch", "behavior-outside-ownership", "empty-location"]);
    expect(DECL_CHECK_SCHEMA_NAME).toBe("decl-check");
  });
});

describe("B3' の反例と対照", () => {
  it.each(COUNTEREXAMPLES)("$label：拒否が種類と引用つきで返り、対照は同じ並びで受理", async (example) => {
    const bad = await run(example.bad, [
      { judgments: [...TARGETS.filter((id) => id !== example.requirementId).map(accept), reject(example.requirementId, example.kind, example.quote)] },
    ]);
    const control = await run(example.control, [{ judgments: TARGETS.map(accept) }]);
    if (!bad.outcome.ok || !control.outcome.ok) throw new Error("通るはず");

    expect(bad.outcome.value.declarationSha256).toBe(await sha256Hex(example.bad));
    expect(control.outcome.value.declarationSha256).toBe(await sha256Hex(example.control));
    expect(bad.outcome.value.declarationSha256).not.toBe(control.outcome.value.declarationSha256);
    expect(bad.outcome.value.judgments.find((judgment) => judgment.requirementId === example.requirementId)).toEqual({
      requirementId: example.requirementId,
      verdict: "reject",
      kind: example.kind,
      quote: example.quote,
    });
    expect(control.outcome.value.judgments).toEqual(TARGETS.map((requirementId) => ({ requirementId, verdict: "accept" })));
    expect(bad.outcome.value.targets).toEqual(TARGETS);
    expect(control.outcome.value.targets).toEqual(TARGETS);

    // データの並び・印の形が反例と対照で同じ（違うのは宣言だけ）
    const badBlocks = dataBlocks(bad.requests[0]!.input);
    const controlBlocks = dataBlocks(control.requests[0]!.input);
    expect(badBlocks.map((block) => block.name)).toEqual(controlBlocks.map((block) => block.name));
    expect(markShape(JSON.parse(badBlocks[3]!.text))).toEqual(markShape(JSON.parse(controlBlocks[3]!.text)));
    for (const index of [0, 1]) expect(badBlocks[index]!.text).toBe(controlBlocks[index]!.text);
    expect(badBlocks[2]!.text).not.toBe(controlBlocks[2]!.text);
    expect(bad.requests[0]!.rules).toEqual(control.requests[0]!.rules);
    expect(bad.requests[0]!.schema).toBe(control.requests[0]!.schema);
  });
});

describe("B3' の要求", () => {
  it("宣言の全文・印・追加の要素の一覧を渡し、試験・期待・合否の塊が無い", async () => {
    const { requests, app } = await run(FIXTURE_YAML, [{ judgments: TARGETS.map(accept) }]);
    const request = requests[0]!;
    const blocks = dataBlocks(request.input);
    expect(blocks.map((block) => block.name)).toEqual(["要件の文と引用", "所属の行", "宣言", "該当箇所の印", "追加の要素"]);
    expect(blocks.every((block) => !/試験|期待|合否/.test(block.name))).toBe(true);
    expect(blocks[2]!.text).toBe(FIXTURE_YAML);
    expect(JSON.parse(blocks[3]!.text)).toEqual(JSON.parse(JSON.stringify([...markRows(app, TABLE).values()])));
    expect(JSON.parse(blocks[4]!.text)).toEqual(JSON.parse(JSON.stringify(extraElementsOf(app, TABLE))));
    expect(JSON.parse(blocks[4]!.text).map((element: { name: string }) => element.name)).toContain("base");
    const owned = JSON.parse(blocks[1]!.text) as { requirementId: string; rows: Record<string, unknown>[] }[];
    expect(owned.map((entry) => entry.requirementId)).toEqual(TARGETS);
    expect(Object.keys(owned[0]!.rows[0]!).sort()).toEqual(["id", "kind", "name", "role", "type"]);
    expect(request.schemaName).toBe(DECL_CHECK_SCHEMA_NAME);
    expect(request.schema).toBe(DECL_CHECK_SCHEMA);
    expect(request.rules).toEqual(DECL_CHECK_RULES);
    expectNoAcceptanceMaterial([request.instructions, ...(request.rules ?? []), ...request.documents, request.input]);
  });

  it("印を引き当てられない要件は要求の対象に含まれず「文脈なし」で返る", async () => {
    const source = fixtureYaml({ closeItem: false });
    const { outcome, requests } = await run(source, [{ judgments: ["R1", "R2", "R4"].map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    const blocks = dataBlocks(requests[0]!.input);
    const sent = (JSON.parse(blocks[0]!.text) as { requirementId: string }[]).map((entry) => entry.requirementId);
    expect(sent).toEqual(["R1", "R2", "R4"]);
    expect((JSON.parse(blocks[1]!.text) as { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual(sent);
    expect(outcome.value.targets).toEqual(["R1", "R2", "R4"]);
    expect(outcome.value.unmarked).toEqual(["R3"]);
    expect(outcome.value.judgments).toEqual([
      { requirementId: "R1", verdict: "accept" },
      { requirementId: "R2", verdict: "accept" },
      { requirementId: "R3", verdict: "unmarked" },
      { requirementId: "R4", verdict: "accept" },
    ]);
    // R3 の判定を書くと、対象の外の要件 ID として形の落ちになる
    const extra = await run(source, [
      { judgments: TARGETS.map(accept) },
      { judgments: TARGETS.map(accept) },
    ]);
    expect(extra.outcome).toMatchObject({ ok: false, failure: { kind: "malformed", attempts: 2 } });
  });

  it("対象が全部「文脈なし」なら呼ばない", async () => {
    const only: RequirementList = { ...LIST, requirements: LIST.requirements.filter((entry) => entry.id === "R3") };
    const { outcome, requests } = await run(fixtureYaml({ closeItem: false }), [], only);
    expect(requests).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: true, value: { targets: [], unmarked: ["R3"], judgments: [{ requirementId: "R3", verdict: "unmarked" }] } });
  });
});

describe("B3' の完全性（形の落ち）", () => {
  const cases: readonly [string, unknown, { field: string; message: string }][] = [
    ["判定が 1 件欠けた応答", { judgments: TARGETS.slice(1).map(accept) }, { field: "requirements[0]", message: "判定が無い要件がある" }],
    [
      "重複した応答",
      { judgments: [...TARGETS.map(accept), accept("R2")] },
      { field: "judgments[4].requirementId", message: "同じ要件の判定が重なっている" },
    ],
    [
      "未知の要件 ID",
      { judgments: [...TARGETS.map(accept), accept("R5")] },
      { field: "judgments[4].requirementId", message: "要件 ID が点検の対象に無い" },
    ],
    [
      "見つからない引用",
      { judgments: [...TARGETS.slice(0, 3).map(accept), reject("R4", "mismatch", "どこにも無い文")] },
      { field: "judgments[3].quote", message: "引用が確定した仕様にも要件の文にも無い" },
    ],
    [
      "引用の無い拒否",
      { judgments: [...TARGETS.slice(0, 3).map(accept), { requirementId: "R4", verdict: "reject", kind: "mismatch", quote: "" }] },
      { field: "judgments[3].quote", message: "拒否には引用が要る" },
    ],
  ];

  it.each(cases)("%s は形の落ちで、2 回続けば malformed・calls 2", async (_label, output, problem) => {
    const { outcome, requests } = await run(FIXTURE_YAML, [output, output]);
    expect(requests).toHaveLength(2);
    expect(outcome).toEqual({ ok: false, failure: { kind: "malformed", attempts: 2, problems: [problem] } });
  });
});
