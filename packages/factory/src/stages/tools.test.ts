// ⑥ 直す、の道具（stages/tools.ts）の unit テスト（02 §1・§2.2）。
//
// ここで固定したいのは 4 つ。
//   1. 形の合わない引数（名前・写像でない引数・空の宣言）を、コードが呼ぶ前に断ること
//   2. 上限を超える宣言（§1.5）を断ること
//   3. 上限を超える道具の呼び出しの回数（§1.5）を断ること
//   4. 道具は**このリポジトリの本物の検査**（静的チェック・試験・対応表）を呼ぶこと
import { describe, expect, it } from "vitest";
import { checkTestSuite } from "../fixed-test.js";
import { AGENT_LIMITS } from "../limits.js";
import type { CorrespondenceEntry, RequirementList, RoleNameMapping, TestSuite } from "../pipeline.js";
import {
  REPAIR_TOOL_NAMES,
  REPAIR_TOOLS,
  checkToolArguments,
  checkToolCallBudget,
  executeRepairTool,
  type RepairToolContext,
} from "./tools.js";

/** 7 欄をすべて書いた、通る宣言（抽象的な題材） */
const VALID = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      title: string",
  "views: []",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 1 か所だけ型を間違えた宣言 */
const INVALID = VALID.replace("title: string", "title: nosuchtype");

const EMPTY_SUITE: TestSuite = { tests: [] };

/** 試験の組を、コードの検査を通して固定する（前提が壊れていれば例外） */
function suiteOf(tests: readonly unknown[]): TestSuite {
  const checked = checkTestSuite(tests);
  if (!checked.ok) throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return checked.suite;
}

const LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "記録できる", quote: "記録する", position: { start: 0, end: 4 } },
    { id: "R-2", text: "探せる", quote: "探す", position: { start: 5, end: 7 } },
  ],
  decisions: [],
  unresolved: [],
};

const CONTEXT: RepairToolContext = {
  list: LIST,
  suite: EMPTY_SUITE,
  correspondences: [
    { requirementId: "R-1", locations: [{ kind: "entity", entity: null, name: "record" }] },
    { requirementId: "R-2", locations: [{ kind: "entity", entity: null, name: "ghost" }] },
  ] satisfies readonly CorrespondenceEntry[],
};

describe("道具の定義（02 §1）", () => {
  it("3 つの道具が、名前・説明・引数の JSON Schema を持つ", () => {
    expect(REPAIR_TOOLS.map((tool) => tool.name)).toEqual([...REPAIR_TOOL_NAMES]);
    for (const tool of REPAIR_TOOLS) {
      expect(tool.description).not.toBe("");
      expect(tool.parameters).toBeTypeOf("object");
    }
  });
});

describe("引数をコードが確かめる（02 §2.2）", () => {
  it("無い道具の名前を断る", () => {
    const checked = checkToolArguments("nope", { declaration: VALID });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("name");
  });

  it("写像でない引数・空の宣言を断る", () => {
    expect(checkToolArguments("static-check", null).ok).toBe(false);
    expect(checkToolArguments("static-check", { declaration: 1 }).ok).toBe(false);
    const empty = checkToolArguments("static-check", { declaration: "" });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problems.map((problem) => problem.field)).toContain("arguments.declaration");
  });

  it("通る引数は、宣言を持つ呼び出しになる", () => {
    const checked = checkToolArguments("run-tests", { declaration: VALID });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.call.name).toBe("run-tests");
    expect(checked.call.declaration.source).toBe(VALID);
  });

  it("上限を超える宣言を断る（§1.5）", () => {
    const huge = "x".repeat(AGENT_LIMITS.declarationBytes + 1);
    const checked = checkToolArguments("static-check", { declaration: huge });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems[0]?.message).toContain("上限");
  });
});

describe("道具の呼び出しの回数の上限（02 §1.5）", () => {
  it("上限に収まる回数は通し、超える回数は断る", () => {
    expect(checkToolCallBudget(AGENT_LIMITS.toolCalls - 1, 1)).toBeUndefined();
    const over = checkToolCallBudget(AGENT_LIMITS.toolCalls, 1);
    expect(over).toEqual({ limit: "toolCalls", max: AGENT_LIMITS.toolCalls, actual: AGENT_LIMITS.toolCalls + 1 });
  });
});

describe("道具は本物の検査を呼ぶ（02 §1）", () => {
  it("静的チェックの道具は、通ったかと誤りを返す", async () => {
    const passCall = checkToolArguments("static-check", { declaration: VALID });
    expect(passCall.ok).toBe(true);
    if (!passCall.ok) return;
    expect(await executeRepairTool(passCall.call, CONTEXT)).toEqual({ passed: true, diagnostics: [] });

    const failCall = checkToolArguments("static-check", { declaration: INVALID });
    expect(failCall.ok).toBe(true);
    if (!failCall.ok) return;
    const failed = await executeRepairTool(failCall.call, CONTEXT);
    expect(failed.passed).toBe(false);
    expect("diagnostics" in failed && failed.diagnostics.length).toBeGreaterThan(0);
  });

  it("対応表の確認の道具は、実在しない場所を落ちとして返す", async () => {
    const call = checkToolArguments("check-correspondence", { declaration: VALID });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    const output = await executeRepairTool(call.call, CONTEXT);
    expect("misses" in output && output.misses.map((miss) => miss.requirementId)).toEqual(["R-2"]);
  });

  it("静的チェックを通らない宣言では、試験と対応表を流さない", async () => {
    const call = checkToolArguments("run-tests", { declaration: INVALID });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    const output = await executeRepairTool(call.call, CONTEXT);
    expect(output.passed).toBe(false);
    expect("detail" in output && output.detail).toContain("静的チェック");
  });
});

// ── ⑥ の道具も、同じ結び付けの部品を使う（02 §1.3.1・Issue #309）──────────

/** 同じ種類の場所（一覧）が 2 つある宣言（提出された対応が無ければ 1 つに決まらない） */
const VIEWS_DECLARATION = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      title: string",
  "views:",
  "  - name: recordsA",
  "    type: list",
  "    entity: record",
  "  - name: recordsB",
  "    type: list",
  "    entity: record",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

describe("⑥ の道具も、提出された対応で結び付ける（02 §1.3.1・Issue #309）", () => {
  const suite = suiteOf([
    {
      id: "v",
      target: { requirementId: "R-1", kind: "screen", roleId: "record.records" },
      kind: "normal",
      operation: "screen",
      clock: "2026-09-16T12:00:00+09:00",
      input: null,
      referenceData: [],
      expected: { kind: "ok", value: null },
    },
  ]);
  const correspondences: readonly CorrespondenceEntry[] = [
    {
      requirementId: "R-1",
      locations: [
        { kind: "view", entity: "record", name: "recordsA" },
        { kind: "view", entity: "record", name: "recordsB" },
      ],
    },
  ];

  const runTool = async (context: Partial<RepairToolContext>) => {
    const call = checkToolArguments("run-tests", { declaration: VIEWS_DECLARATION });
    if (!call.ok) throw new Error("前提が壊れた");
    return executeRepairTool(call.call, { list: LIST, suite, correspondences, ...context });
  };

  it("提出された対応があれば、同じ種類の場所が複数でも 1 つに結び付く", async () => {
    const mappings: readonly RoleNameMapping[] = [{ roleId: "record.records", name: "recordsB" }];
    const output = await runTool({ mappings });
    expect(output.passed).toBe(true);
    expect("mismatches" in output && output.mismatches).toEqual([]);
  });

  it("提出された対応が無ければ、1 つに決まらず未解決になる（旧形式の経路）", async () => {
    const output = await runTool({});
    expect(output.passed).toBe(false);
    expect("unresolved" in output && output.unresolved.map((entry) => entry.testId)).toEqual(["v"]);
  });
});
