// T1'' 表の意味の点検（v11a/stages/semantic-check.ts）の試験（Issue #507）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 負例 3 つ（誤った所属・欠けた対象・弱い checks）で、偽物の拒否が種類と引用つきで返り、表の SHA を持つ
//   2. データのどの塊の JSON にも `name` の鍵が無く、試験・期待・合否の塊が無い。J4 の印を渡す
//   3. 判定の欠落・重複・未知の要件 ID・見つからない引用・引用の無い拒否は形の落ちで、2 回続けば `malformed`・calls 2
//   4. `unresolved` の要件は対象にも応答の必須にも無い
//   5. 旗 v12.ids の束（Issue #735）：要件 5 件ごとの束に分けて同時に呼び、束ごとに形を確かめ、合併して全体の完全性を確かめる。
//      形のやり直しは 2 回の点検を通じて段全体で束の数まで。偽物の LLM・遅らせた偽物の応答で閉じる
//   6. 旗 v12.ids の束が 2 つ以上の要求（Issue #741）：束の外の対象を「参照のみ」の塊で渡し、その読み方の規則を末尾に 1 つ足す。
//      判定の対象・形の検査は変えない。束が 1 つの要求は直す前とバイト列で同じ
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects, ruleTexts, type RuleDefinition } from "../../stages/prompt.js";
import { ACCEPTANCE_MATERIAL_WORDS, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse } from "../../llm.js";
import { estimateMaxCostUsd } from "../../budget.js";
import { estimateInputUpperBoundTokens, structuredInputParts } from "../../call.js";
import { V12_T2_BUNDLE } from "../../v12/limits.js";
import {
  createCheckedRecordingClient,
  negative,
  recordedStructured,
  FIXTURE_CONSTRAINT_ID,
  FIXTURE_DOCUMENTS,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureEnumMembershipList,
  fixtureEnumMembershipTable,
  fixtureList,
  fixtureTable,
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  LEDGER_VIEW_2A,
  LEDGER_VIEW_2C,
  NON_REQUIREMENT_TEXT,
  RULED_AS_NON_REQUIREMENT_QUOTE,
  RULED_AS_NON_REQUIREMENT_TEXT,
  WHEN_NON_REQUIREMENT_REQUEST_DIFF,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  requestDiffsOf,
  withoutEnumMembership,
  withoutWhenAndNonRequirement,
  withCheckTargets,
  semanticRequestIds,
} from "../__tests__/fixtures.js";
import { deriveCarryOver } from "../carry-over.js";
import { checkNameTable, nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView, type UpstreamLedgerView } from "../../v12/ledger.js";
import { STRUCTURAL_ASSERTIONS } from "../../fixed-test.js";
import { STRUCTURAL_MEANINGS, structuralReadingText, type StructuralMeaningTable } from "../../v12/structural-meanings.js";
import {
  SEMANTIC_CHECK_LEDGER_RULE_ID,
  SEMANTIC_CHECK_REFERENCE_DATA_NAME,
  SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION,
  SEMANTIC_CHECK_RULE_DEFINITIONS,
  SEMANTIC_CHECK_RULES,
  SEMANTIC_CHECK_SCHEMA,
  SEMANTIC_CHECK_SCHEMA_NAME,
  SEMANTIC_REJECTION_KINDS,
  SEMANTIC_MERGE_MESSAGES,
  mergeSemanticJudgments,
  runSemanticCheck,
  semanticShapeRetryBudgetOf,
  semanticCheckRuleDefinitionsOf,
  semanticCheckTargets,
  type SemanticCheckInput,
} from "./semantic-check.js";

const structured = recordedStructured;

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

const LIST = fixtureList();
const PLAN = planOf(LIST);
/** 点検の対象（R5 は unresolved なので外れる） */
const TARGETS = ["R1", "R2", "R3", "R4"];
const ADVICE: readonly JudgeAdviceMarkEntry[] = [
  { requirementId: "R2", id: "s.items", mark: "suspect-unnecessary" },
  { requirementId: "R3", id: "f.item.amount", mark: "llm-unknown-confidence" },
];

const accept = (requirementId: string) => ({ requirementId, verdict: "accept", kind: null, quote: null });
const reject = (requirementId: string, kind: string, quote: string) => ({ requirementId, verdict: "reject", kind, quote });
const acceptAll = (except: string) => TARGETS.filter((id) => id !== except).map(accept);

async function run(table: NameTable, outputs: readonly unknown[], advice?: readonly JudgeAdviceMarkEntry[]) {
  const recording = createCheckedRecordingClient(outputs.map(structured));
  const outcome = await runSemanticCheck({
    plan: PLAN,
    list: LIST,
    table,
    ...(advice === undefined ? {} : { advice }),
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
  });
  return { outcome, requests: recording.structured };
}

const dataBlocks = (input: string) =>
  [...input.matchAll(/<data name="([^"]+)">\n([\s\S]*?)\n<\/data>/g)].map((match) => ({
    name: match[1] as string,
    text: match[2] as string,
  }));

const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([name, item]) => name === key || hasKey(item, key));
  }
  return false;
};

// ── 負例の表 ────────────────────────────────────────────────────────

/** 誤った所属：R1（項目の題名）が、別 entity の同名の項目 member.title を所属させる */
function wrongOwnershipTable(): NameTable {
  const table = fixtureTable();
  return {
    ...table,
    ownership: table.ownership.map((entry) =>
      entry.requirementId === "R1"
        ? { ...entry, roles: entry.roles.map((role) => (role.id === "f.item.title" ? { ...role, id: "f.member.title" } : role)) }
        : entry,
    ),
  };
}

/** 欠けた対象：R4 が求める区分ごとの件数（集計）が表に無い */
function missingTargetTable(): NameTable {
  const table = fixtureTable();
  return {
    ...table,
    rows: table.rows.filter((row) => row.id !== "c.byKind"),
    ownership: table.ownership.map((entry) => ({ ...entry, roles: entry.roles.filter((role) => role.id !== "c.byKind") })),
  };
}

/** 弱い checks：決まりのある R3 を view-shows だけで確かめる */
function weakChecksTable(): NameTable {
  const table = fixtureTable();
  return {
    ...table,
    ownership: table.ownership.map((entry) =>
      entry.requirementId === "R3"
        ? { ...entry, roles: [...entry.roles, { id: "s.items", basis: "stated" as const, reason: null }] }
        : entry,
    ),
    verification: table.verification.map((entry) =>
      entry.requirementId === "R3"
        ? { requirementId: "R3", kind: "structural" as const, reason: "画面に出ることを見る", checks: ["view-shows" as const] }
        : entry,
    ),
  };
}

describe("T1'' の規則と schema", () => {
  it("規則の定義に不備が無く、送る文は定義の text から組む", () => {
    expect(ruleDefinitionDefects(SEMANTIC_CHECK_RULE_DEFINITIONS)).toEqual([]);
    expect(SEMANTIC_CHECK_RULES).toEqual(SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(SEMANTIC_CHECK_RULE_DEFINITIONS.every((definition) => /^R-sc-\d\d$/.test(definition.id))).toBe(true);
    expect(SEMANTIC_REJECTION_KINDS).toEqual(["unnecessary-ownership", "missing-target", "weak-verification"]);
    expect(SEMANTIC_CHECK_SCHEMA_NAME).toBe("semantic-check");
  });
});

describe("T1'' の負例", () => {
  it.each([
    ["誤った所属", wrongOwnershipTable, "R1", "unnecessary-ownership", "題名"],
    ["欠けた対象", missingTargetTable, "R4", "missing-target", "区分ごとの件数"],
    ["弱い checks", weakChecksTable, "R3", "weak-verification", "金額が 0 より大きい項目だけ"],
  ] as const)("%s：拒否が種類と引用つきで返り、表の SHA を持つ", async (_label, makeTable, requirementId, kind, quote) => {
    const table = makeTable();
    const { outcome, requests } = await run(table, [
      { judgments: [...acceptAll(requirementId), reject(requirementId, kind, quote)] },
    ]);
    expect(requests).toHaveLength(1);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(table));
    expect(outcome.value.tableSha256).not.toBe(await nameTableSha256(fixtureTable()));
    expect(outcome.value.targets).toEqual(TARGETS);
    // 判定は対象の順に並べ直す
    expect(outcome.value.judgments.map((judgment) => judgment.requirementId)).toEqual(TARGETS);
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === requirementId)).toEqual({
      requirementId,
      verdict: "reject",
      kind,
      quote,
    });
    expect(outcome.value.judgments.filter((judgment) => judgment.verdict === "accept")).toHaveLength(3);
  });
});

describe("T1'' の要求", () => {
  it("データは名前の欄を持たず、試験・期待・合否の塊が無い。J4 の印を渡し、unresolved の要件を対象にしない", async () => {
    const { requests } = await run(fixtureTable(), [{ judgments: TARGETS.map(accept) }], ADVICE);
    const request = requests[0]!;
    const blocks = dataBlocks(request.input);
    expect(blocks.map((block) => block.name)).toEqual(["要件の文と引用", "表の行", "要件ごとの所属", "確かめ方", "助言の印"]);
    for (const block of blocks) {
      expect(hasKey(JSON.parse(block.text), "name")).toBe(false);
      expect(block.name).not.toMatch(/試験|期待|合否/);
    }
    const requirements = JSON.parse(blocks[0]!.text) as { requirementId: string }[];
    expect(requirements.map((entry) => entry.requirementId)).toEqual(TARGETS);
    const rows = JSON.parse(blocks[1]!.text) as Record<string, unknown>[];
    expect(rows).toHaveLength(fixtureTable().rows.length);
    expect(Object.keys(rows[0]!).sort()).toEqual(["entity", "groupBy", "id", "kind", "options", "refEntity", "role", "type"]);
    expect(JSON.parse(blocks[2]!.text).map((entry: { requirementId: string }) => entry.requirementId)).toEqual(TARGETS);
    expect(JSON.parse(blocks[3]!.text).map((entry: { requirementId: string }) => entry.requirementId)).toEqual(TARGETS);
    expect(JSON.parse(blocks[4]!.text)).toEqual(ADVICE);
    expect(request.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
    expect(request.schema).toBe(SEMANTIC_CHECK_SCHEMA);
    expect(request.rules).toEqual(SEMANTIC_CHECK_RULES);
    expectNoAcceptanceMaterial([request.instructions, ...(request.rules ?? []), ...request.documents, request.input]);
    expect(semanticCheckTargets(LIST, fixtureTable())).toEqual(TARGETS);
  });

  it("J4 の印は判定を変えない（印の有無で結果が同じ）", async () => {
    const output = { judgments: TARGETS.map(accept) };
    const withAdvice = await run(fixtureTable(), [output], ADVICE);
    const without = await run(fixtureTable(), [output]);
    expect(withAdvice.outcome).toEqual(without.outcome);
  });
});

describe("T1'' の完全性（形の落ち）", () => {
  const cases: readonly [string, unknown, { field: string; message: string }][] = [
    ["判定が 1 件欠けた応答", { judgments: TARGETS.slice(1).map(accept) }, { field: "requirements[0]", message: "判定が無い要件がある" }],
    [
      "重複した応答",
      { judgments: [...TARGETS.map(accept), accept("R2")] },
      { field: "judgments[4].requirementId", message: "同じ要件の判定が重なっている" },
    ],
    [
      "未知の要件 ID（unresolved の要件を含む）",
      { judgments: [...TARGETS.map(accept), accept("R5")] },
      { field: "judgments[4].requirementId", message: "要件 ID が点検の対象に無い" },
    ],
    [
      "見つからない引用",
      { judgments: [...acceptAll("R1"), reject("R1", "unnecessary-ownership", "どこにも無い文")] },
      { field: "judgments[3].quote", message: "引用が確定した仕様にも要件の文にも無い" },
    ],
    [
      "引用の無い拒否",
      { judgments: [...acceptAll("R1"), { requirementId: "R1", verdict: "reject", kind: "missing-target", quote: null }] },
      { field: "judgments[3].quote", message: "拒否には引用が要る" },
    ],
    [
      "未知の拒否の種類",
      negative({ judgments: [...acceptAll("R1"), reject("R1", "other", "題名")] }, "拒否の種類が enum の外の応答。strict の schema では出ないが、形の検査の固定文を観測する負例"),
      { field: "judgments[3].kind", message: "拒否の種類は unnecessary-ownership・missing-target・weak-verification のいずれかであること" },
    ],
  ];

  it.each(cases)("%s は形の落ちで、2 回続けば malformed・calls 2", async (_label, output, problem) => {
    const { outcome, requests } = await run(fixtureTable(), [output, output]);
    expect(requests).toHaveLength(2);
    expect(outcome).toEqual({ ok: false, failure: { kind: "malformed", attempts: 2, problems: [problem] } });
  });

  it("1 回落ちて 2 回目に完全な結果が返れば通る（calls 2）", async () => {
    const { outcome, requests } = await run(fixtureTable(), [cases[0]![1], { judgments: TARGETS.map(accept) }]);
    expect(requests).toHaveLength(2);
    expect(outcome.ok).toBe(true);
  });

  it("unresolved の要件の判定は応答の必須に無い（R5 を書かなくても通る）", async () => {
    const { outcome } = await run(fixtureTable(), [{ judgments: TARGETS.map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.some((judgment) => judgment.requirementId === "R5")).toBe(false);
  });
});

describe("T1'' の default-value の受理の条件（拒否の配線の検証。モデルの判定の精度の実証ではない。Issue #533）", () => {
  /** 既定値のほかに入力の制約を含む要件 R6（形と所属は正しい） */
  const WITH_CONSTRAINT = "項目の区分は、未入力なら保存の時点で alpha になり、金額が 0 より大きいときだけ beta を選べる。";
  const CONSTRAINT_QUOTE = "金額が 0 より大きいときだけ beta を選べる";
  /** 文は alpha、value は beta（形と所属は正しい） */
  const VALUE_QUOTE = "未入力なら保存の時点で alpha になる";
  const DEFAULT_TARGETS = [...TARGETS, "R6"];

  async function runDefault(list: RequirementList, table: NameTable, outputs: readonly unknown[]) {
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runSemanticCheck({
      plan: planOf(list),
      list,
      table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    return { outcome, requests: recording.structured };
  }

  const cases = [
    { name: "既定値のほかに入力の制約を含む要件", list: fixtureDefaultValueList(WITH_CONSTRAINT), value: "alpha", quote: CONSTRAINT_QUOTE },
    { name: "value が要件の文の値と違う要件", list: fixtureDefaultValueList(), value: "beta", quote: VALUE_QUOTE },
  ] as const;

  for (const entry of cases) {
    it(`${entry.name}：形と所属は T1' を通り、送るデータと規則を確かめ、偽物の weak-verification が形の検査を通って持ち越しになる`, async () => {
      const table = fixtureDefaultValueTable(entry.value);
      // 前提：形と所属は正しい（T1' は問題 0）
      expect(checkNameTable(entry.list, table, FIXTURE_DOCUMENTS)).toEqual([]);
      const rejection = [...DEFAULT_TARGETS.filter((id) => id !== "R6").map(accept), reject("R6", "weak-verification", entry.quote)];
      const { outcome, requests } = await runDefault(entry.list, table, [{ judgments: rejection }]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const blocks = dataBlocks(request.input);
      // 送る要件の文
      const texts = JSON.parse(blocks.find((block) => block.name === "要件の文と引用")!.text) as { requirementId: string; text: string }[];
      expect(texts.find((item) => item.requirementId === "R6")?.text).toBe(entry.list.requirements[5]?.text);
      // 確かめ方（value つき。既存の写し）
      const verification = JSON.parse(blocks.find((block) => block.name === "確かめ方")!.text) as Record<string, unknown>[];
      expect(verification.find((item) => item["requirementId"] === "R6")).toEqual({
        requirementId: "R6",
        kind: "default-value",
        value: entry.value,
      });
      // 規則の文（ほかの決まりを含む要件・文と違う value は受理しない）
      const rule = request.rules?.find((text) => text.includes("default-value")) ?? "";
      expect(rule).toContain("value が要件の文の値と合うときだけ受理する");
      expect(rule).toContain("既定値のほかの決まり（入力の制約など）を含む要件");
      expect(rule).toContain("value が要件の文の値と違う要件は受理せず、weak-verification で拒否する");
      // 偽物の判定の拒否は形の検査を通る
      if (!outcome.ok) throw new Error("通るはず");
      expect(outcome.value.targets).toEqual(DEFAULT_TARGETS);
      expect(outcome.value.judgments.at(-1)).toEqual({ requirementId: "R6", verdict: "reject", kind: "weak-verification", quote: entry.quote });
      // 拒否は持ち越しへ流れる（共有の区分の項目は R1 も所属させるので除かれない）
      const carry = await deriveCarryOver({ list: entry.list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
      expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5", "R6"]);
      expect(carry.excludedRowIds).toEqual([]);
      expectNoAcceptanceMaterial([request.input, ...(request.rules ?? [])]);
    });
  }

  it("受理すれば持ち越しにならない。拒否の種類の数は 3 のまま", async () => {
    const list = fixtureDefaultValueList();
    const table = fixtureDefaultValueTable();
    const { outcome } = await runDefault(list, table, [{ judgments: DEFAULT_TARGETS.map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    const carry = await deriveCarryOver({ list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5"]);
    expect(SEMANTIC_REJECTION_KINDS).toHaveLength(3);
    expect(SEMANTIC_CHECK_SCHEMA.properties.judgments.items.properties.kind.enum).toEqual([...SEMANTIC_REJECTION_KINDS, null]);
    expect(ruleDefinitionDefects(SEMANTIC_CHECK_RULE_DEFINITIONS)).toEqual([]);
  });

  it("default-value の要件の判定を欠いた応答は今までどおり形の落ち（2 回で malformed）", async () => {
    const list = fixtureDefaultValueList();
    const partial = { judgments: TARGETS.map(accept) };
    const { outcome } = await runDefault(list, fixtureDefaultValueTable(), [partial, partial]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    // 位置は点検の対象の中の添字（R5 は対象に無いので R6 は 5 番目）
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[4]", message: "判定が無い要件がある" });
  });
});

// ── 旗 on：受理条件の差し込み（Issue #548）──────────────────────────────

describe("旗 on：R-sc-02 の末尾に台帳の受理条件の文を台帳の順で差し込む（Issue #548）", () => {
  const ROW = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
  const DEFAULT_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "default-value");
  const ruleOf = (ledger?: LedgerView) =>
    semanticCheckRuleDefinitionsOf(ledger).find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID)?.text ?? "";

  it("off は今の定数。手 2a の台帳で組んだ default-value の文は今の文とバイト列で同じ。#549 の台帳は末尾に enum-membership の文が増えるだけ（今の台帳との差は下の手 2d の試験）", () => {
    expect(semanticCheckRuleDefinitionsOf()).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(semanticCheckRuleDefinitionsOf(LEDGER_VIEW_2A)).toEqual(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(ruleOf(LEDGER_VIEW_2A)).toBe(ruleOf());
    expect(ruleOf()).toContain(DEFAULT_ROW?.rules.t1Acceptance ?? "（無い）");
    expect(ruleOf().endsWith(DEFAULT_ROW?.rules.t1Acceptance ?? "（無い）")).toBe(true);
    expect(ruleOf(LEDGER_VIEW_2C)).toBe(`${ruleOf()}${ROW?.rules.t1Acceptance ?? "（無い）"}`);
    expect(
      semanticCheckRuleDefinitionsOf(LEDGER_VIEW_2C).filter((definition) => definition.id !== SEMANTIC_CHECK_LEDGER_RULE_ID),
    ).toEqual(SEMANTIC_CHECK_RULE_DEFINITIONS.filter((definition) => definition.id !== SEMANTIC_CHECK_LEDGER_RULE_ID));
    for (const ledger of [undefined, LEDGER_VIEW_2A, LEDGER_VIEW_2C]) {
      expect(ruleDefinitionDefects(semanticCheckRuleDefinitionsOf(ledger))).toEqual([]);
    }
  });

  it("二点測定：台帳の受理条件の文を 1 文字変えると、組んだ R-sc-02 が変わる（台帳から組んでいる）", () => {
    const changed: LedgerView = { ...LEDGER_VIEW_2C, t1AcceptanceTexts: LEDGER_VIEW_2C.t1AcceptanceTexts.map((text) => `${text} `) };
    expect(ruleOf(changed)).not.toBe(ruleOf(LEDGER_VIEW_2C));
  });

  it("同じ応答で on・off の要求の差は R-sc-02 だけで、その分を除けばバイト列で同じ。手 2a の台帳ならバイト列で同じ。結果は深く等しい", async () => {
    const list = fixtureDefaultValueList();
    const table = fixtureDefaultValueTable();
    const runWith = async (ledger?: LedgerView) => {
      const recording = createCheckedRecordingClient([structured({ judgments: [...TARGETS, "R6"].map(accept) })]);
      const outcome = await runSemanticCheck({
        plan: planOf(list),
        list,
        table,
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
        ...(ledger === undefined ? {} : { ledger }),
      });
      return { outcome, requests: JSON.parse(JSON.stringify(recording.structured)) as unknown[] };
    };
    const off = await runWith();
    const twoA = await runWith(LEDGER_VIEW_2A);
    const on = await runWith(LEDGER_VIEW_2C);
    expect(JSON.stringify(twoA.requests)).toBe(JSON.stringify(off.requests));
    expect(requestDiffsOf(on.requests, off.requests).map((diff) => diff.paths)).toEqual([ENUM_MEMBERSHIP_REQUEST_DIFF[SEMANTIC_CHECK_SCHEMA_NAME]]);
    expect(JSON.stringify(withoutEnumMembership(on.requests))).toBe(JSON.stringify(off.requests));
    expect(on.outcome).toEqual(off.outcome);
    expect(twoA.outcome).toEqual(off.outcome);
    // 手 2d（#550）：今の台帳の on と #549 の台帳の on の差は R-sc-02（non-requirement の受理条件の文）だけ。off は変わらない
    const now = await runWith(PROPERTY_LEDGER_VIEW);
    expect(requestDiffsOf(now.requests, on.requests).map((diff) => diff.paths)).toEqual([WHEN_NON_REQUIREMENT_REQUEST_DIFF[SEMANTIC_CHECK_SCHEMA_NAME]]);
    expect(JSON.stringify(withoutWhenAndNonRequirement(now.requests))).toBe(JSON.stringify(on.requests));
    expect(now.outcome).toEqual(on.outcome);
  });
});

describe("T1'' の enum-membership の受理の条件（旗 on。拒否の配線の検証。モデルの判定の精度の実証ではない。Issue #548）", () => {
  /** 選択肢のほかに入力の制約を含む要件 R6（形と所属は正しい） */
  const WITH_CONSTRAINT = "項目の区分は、alpha・beta のどれかで、金額が 0 より大きいときだけ beta を選べる。";
  const CONSTRAINT_QUOTE = "金額が 0 より大きいときだけ beta を選べる";
  /** 文の選択肢は alpha・beta・gamma、行の options は alpha・beta（形と所属は正しい） */
  const MISMATCHED = "項目の区分は、alpha・beta・gamma のどれかである。";
  const MISMATCHED_QUOTE = "alpha・beta・gamma のどれかである";
  const ENUM_TARGETS = [...TARGETS, "R6"];
  const ledger = PROPERTY_LEDGER_VIEW;

  async function runEnum(list: RequirementList, table: NameTable, outputs: readonly unknown[]) {
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runSemanticCheck({
      plan: planOf(list),
      list,
      table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      ledger,
    });
    return { outcome, requests: recording.structured };
  }

  const cases = [
    { name: "選択肢のほかに入力の制約を含む要件", list: fixtureEnumMembershipList(WITH_CONSTRAINT), quote: CONSTRAINT_QUOTE },
    { name: "行の options が文の選択肢と合わない要件", list: fixtureEnumMembershipList(MISMATCHED), quote: MISMATCHED_QUOTE },
  ] as const;

  for (const entry of cases) {
    it(`${entry.name}：形と所属は T1' を通り、送るデータと規則を確かめ、偽物の weak-verification が形の検査を通って持ち越しになる`, async () => {
      const table = fixtureEnumMembershipTable();
      // 前提：形と所属は正しい（旗 on の T1' は問題 0）
      expect(checkNameTable(entry.list, table, FIXTURE_DOCUMENTS, { ledger })).toEqual([]);
      const rejection = [...ENUM_TARGETS.filter((id) => id !== "R6").map(accept), reject("R6", "weak-verification", entry.quote)];
      const { outcome, requests } = await runEnum(entry.list, table, [{ judgments: rejection }]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const blocks = dataBlocks(request.input);
      const texts = JSON.parse(blocks.find((block) => block.name === "要件の文と引用")!.text) as { requirementId: string; text: string }[];
      expect(texts.find((item) => item.requirementId === "R6")?.text).toBe(entry.list.requirements[5]?.text);
      // 確かめ方は kind をそのまま載せる（選択肢は表の行の options で見える）
      const verification = JSON.parse(blocks.find((block) => block.name === "確かめ方")!.text) as Record<string, unknown>[];
      expect(verification.find((item) => item["requirementId"] === "R6")).toEqual({ requirementId: "R6", kind: "enum-membership" });
      // 規則の文（ほかの決まりを含む要件・選択肢の合わない要件は受理しない）
      const rule = request.rules?.find((text) => text.includes("enum-membership")) ?? "";
      expect(rule).toContain(ROW_ACCEPTANCE);
      expect(rule).toContain("options が要件の文の選択肢と過不足なく合うときだけ受理する");
      expect(rule).toContain("選択肢のほかの決まり（入力の制約など）を含む要件");
      expect(rule).toContain("weak-verification で拒否する");
      if (!outcome.ok) throw new Error("通るはず");
      expect(outcome.value.targets).toEqual(ENUM_TARGETS);
      expect(outcome.value.judgments.at(-1)).toEqual({ requirementId: "R6", verdict: "reject", kind: "weak-verification", quote: entry.quote });
      const carry = await deriveCarryOver({ list: entry.list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
      expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5", "R6"]);
      expectNoAcceptanceMaterial([request.input, ...(request.rules ?? [])]);
    });
  }

  it("受理すれば持ち越しにならない。拒否の種類の数は 3 のまま（schema は on・off で同じ）", async () => {
    const list = fixtureEnumMembershipList();
    const table = fixtureEnumMembershipTable();
    const { outcome, requests } = await runEnum(list, table, [{ judgments: ENUM_TARGETS.map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    const carry = await deriveCarryOver({ list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5"]);
    expect(SEMANTIC_REJECTION_KINDS).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.schema)).toBe(JSON.stringify(SEMANTIC_CHECK_SCHEMA));
    expect(requests[0]?.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
  });

  it("enum-membership の要件の判定を欠いた応答は今までどおり形の落ち（2 回で malformed）", async () => {
    const partial = { judgments: TARGETS.map(accept) };
    const { outcome } = await runEnum(fixtureEnumMembershipList(), fixtureEnumMembershipTable(), [partial, partial]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[4]", message: "判定が無い要件がある" });
  });
});

const ROW_ACCEPTANCE = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership")?.rules.t1Acceptance ?? "（無い）";

// ── 旗 on：要件でない文（non-requirement）の点検の配線（Issue #550）──────────────────────────────

describe("T1'' の non-requirement の点検（旗 on。配線の検証。モデルの判定の精度の実証ではない。Issue #550）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  const NON_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "non-requirement");

  async function runNon(list: RequirementList, table: NameTable, outputs: readonly unknown[]) {
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runSemanticCheck({
      plan: planOf(list),
      list,
      table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      ledger,
    });
    return { outcome, requests: recording.structured };
  }

  /** 送ったデータの塊（要件の文・確かめ方）と規則の、点検の対象の要件 `id` の分 */
  function sentFor(request: { readonly input: string; readonly rules?: readonly string[] }, id: string) {
    const blocks = dataBlocks(request.input);
    const texts = JSON.parse(blocks.find((block) => block.name === "要件の文と引用")!.text) as { requirementId: string; text: string }[];
    const verification = JSON.parse(blocks.find((block) => block.name === "確かめ方")!.text) as Record<string, unknown>[];
    const ownership = JSON.parse(blocks.find((block) => block.name === "要件ごとの所属")!.text) as Record<string, unknown>[];
    return {
      text: texts.find((item) => item.requirementId === id)?.text,
      verification: verification.find((item) => item["requirementId"] === id),
      ownership: ownership.find((item) => item["requirementId"] === id),
      rule: request.rules?.find((text) => text.includes("non-requirement")) ?? "",
    };
  }

  for (const id of ["R6", "R:alt:x1"]) {
    it(`要件 ID ${id}：non-requirement の要件は点検の対象に含まれ（unresolved と違う）、データに kind つきで載り、規則の文に受理条件がある`, async () => {
      const list = fixtureNonRequirementList(NON_REQUIREMENT_TEXT, id);
      const table = fixtureNonRequirementTable(id);
      // 前提：形と所属は正しい（旗 on の T1' は問題 0）
      expect(checkNameTable(list, table, FIXTURE_DOCUMENTS, { ledger })).toEqual([]);
      expect(semanticCheckTargets(list, table)).toEqual([...TARGETS, id]);
      const { outcome, requests } = await runNon(list, table, [{ judgments: [...TARGETS, id].map(accept) }]);
      expect(requests).toHaveLength(1);
      const sent = sentFor(requests[0]!, id);
      expect(sent.text).toBe(NON_REQUIREMENT_TEXT);
      expect(sent.verification).toEqual({ requirementId: id, kind: "non-requirement" });
      expect(sent.ownership).toEqual({ requirementId: id, roles: [] });
      expect(sent.rule).toContain(NON_ROW?.rules.t1Acceptance ?? "（無い）");
      expect(sent.rule).toContain("決まりも対象（項目・計算・集計・操作・画面）も無いときだけ受理する");
      expect(sent.rule).toContain("weak-verification で拒否する");
      if (!outcome.ok) throw new Error("通るはず");
      expect(outcome.value.targets).toEqual([...TARGETS, id]);
      expectNoAcceptanceMaterial([requests[0]!.input, ...(requests[0]!.rules ?? [])]);
    });

    it(`要件 ID ${id}：判定の欠落は今までどおり形の落ちで 2 回で malformed（受理を既定にしない）`, async () => {
      const partial = { judgments: TARGETS.map(accept) };
      const { outcome } = await runNon(fixtureNonRequirementList(NON_REQUIREMENT_TEXT, id), fixtureNonRequirementTable(id), [partial, partial]);
      if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
      expect(outcome.failure.problems).toContainEqual({ field: "requirements[4]", message: "判定が無い要件がある" });
    });

    it(`要件 ID ${id}：決まりのある文を non-requirement にした要件に偽物の weak-verification を返すと形の検査を通り、持ち越しになる（要件でない文にならない）`, async () => {
      const list = fixtureNonRequirementList(RULED_AS_NON_REQUIREMENT_TEXT, id);
      const table = fixtureNonRequirementTable(id);
      expect(checkNameTable(list, table, FIXTURE_DOCUMENTS, { ledger })).toEqual([]);
      const judgments = [...TARGETS.map(accept), reject(id, "weak-verification", RULED_AS_NON_REQUIREMENT_QUOTE)];
      const { outcome } = await runNon(list, table, [{ judgments }]);
      if (!outcome.ok) throw new Error("通るはず");
      expect(outcome.value.judgments.at(-1)).toEqual({
        requirementId: id,
        verdict: "reject",
        kind: "weak-verification",
        quote: RULED_AS_NON_REQUIREMENT_QUOTE,
      });
      const carry = await deriveCarryOver({ list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
      expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5", id]);
      expect(carry.entries.at(-1)?.reasons).toEqual([{ origin: "semantic-check", reason: "weak-verification" }]);
      expect(carry.nonRequirements).toBeUndefined();
    });
  }

  it("受理すれば持ち越しにならず要件でない文になる。拒否の種類の数は 3 のまま（schema は on・off で同じ）", async () => {
    const list = fixtureNonRequirementList();
    const table = fixtureNonRequirementTable();
    const { outcome, requests } = await runNon(list, table, [{ judgments: [...TARGETS, "R6"].map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    const carry = await deriveCarryOver({ list, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5"]);
    expect(carry.nonRequirements).toEqual(["R6"]);
    expect(SEMANTIC_REJECTION_KINDS).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.schema)).toBe(JSON.stringify(SEMANTIC_CHECK_SCHEMA));
    expect(requests[0]?.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
  });
});

// ── 上流の台帳の見方で受ける（読み漏れの検出。Issue #712）──────────────

/** 2 つの型が互いに代入できる（同じ型）なら true */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("読み漏れの検出：C3（T1''）は台帳を上流の見方で受ける（Issue #712）", () => {
  it("規則・段の入力の台帳の型が上流の見方で、一覧の外の欄（B1 の文・生の行）を読めない", () => {
    const same: readonly true[] = [
      true satisfies SameType<NonNullable<Parameters<typeof semanticCheckRuleDefinitionsOf>[0]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<SemanticCheckInput["ledger"]>, UpstreamLedgerView>,
    ];
    const ledger: NonNullable<SemanticCheckInput["ledger"]> = PROPERTY_LEDGER_VIEW;
    // @ts-expect-error C3 の段の台帳は B1 の規則の文を持たない
    void ledger.b1RuleTexts;
    // @ts-expect-error C3 の段の台帳は生の行を持たない
    void ledger.rows;
    expect(same).toHaveLength(2);
    expect(ledger.t1AcceptanceTexts).toEqual(PROPERTY_LEDGER_VIEW.t1AcceptanceTexts);
  });
});

// ── 旗 v12.ids：構造の検査の読み方（Issue #732）──────────────────────────────

describe("旗 ids on：R-sc-02 の 3 つの観点のあとに構造の検査の種類の意味と targets の読み方を、意味の表から組む（Issue #732）", () => {
  const rsc02 = (definitions: readonly { readonly id: string; readonly text: string }[]) =>
    definitions.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID)?.text ?? "";
  const HEAD = rsc02(SEMANTIC_CHECK_RULE_DEFINITIONS).slice(0, rsc02(SEMANTIC_CHECK_RULE_DEFINITIONS).indexOf("確かめ方が default-value の要件は"));
  const READING = structuralReadingText();
  const others = (definitions: readonly RuleDefinition[]) => definitions.filter((definition) => definition.id !== SEMANTIC_CHECK_LEDGER_RULE_ID);

  it("ids off は今の定数のまま（台帳の on・off とも）。ids を明示で off にしても同じ。4 通りとも規則の定義に不備が無い", () => {
    expect(semanticCheckRuleDefinitionsOf()).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(semanticCheckRuleDefinitionsOf(undefined, false)).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, false)).toEqual(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW));
    expect(rsc02(SEMANTIC_CHECK_RULE_DEFINITIONS)).not.toContain(READING);
    expect(rsc02(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW))).not.toContain(READING);
    for (const [ledger, ids] of [[undefined, false], [undefined, true], [PROPERTY_LEDGER_VIEW, false], [PROPERTY_LEDGER_VIEW, true]] as const) {
      expect(ruleDefinitionDefects(semanticCheckRuleDefinitionsOf(ledger, ids)), `${String(ledger !== undefined)}・${String(ids)}`).toEqual([]);
    }
  });

  it("(1) ids on の R-sc-02 は 3 つの観点 → 種類の意味 → 受理条件の文の順（台帳 off は今の default-value の文、台帳 on は台帳の文）。ID・why は同じで since に履歴。ほかの規則は同じ", () => {
    expect(HEAD.endsWith("（weak-verification）。")).toBe(true);
    const plain = rsc02(semanticCheckRuleDefinitionsOf(undefined, true));
    expect(plain).toBe(`${HEAD}${READING}${rsc02(SEMANTIC_CHECK_RULE_DEFINITIONS).slice(HEAD.length)}`);
    const withLedger = rsc02(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, true));
    expect(withLedger).toBe(`${HEAD}${READING}${PROPERTY_LEDGER_VIEW.t1AcceptanceTexts.join("")}`);
    expect(withLedger.replace(READING, "")).toBe(rsc02(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)));
    for (const check of STRUCTURAL_ASSERTIONS) expect(withLedger).toContain(STRUCTURAL_MEANINGS[check].meaning);
    expect(withLedger).toContain("同じ種類を複数の行に掛けた確かめ方は行ごとに 1 件の検査である");
    expect(withLedger).toContain("(2) と (3) は targets の行の集合に対して見る");
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      const on = semanticCheckRuleDefinitionsOf(ledger, true);
      const off = semanticCheckRuleDefinitionsOf(ledger);
      expect(others(on)).toEqual(others(off));
      const onRule = on.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID);
      const offRule = off.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID);
      expect(onRule?.why).toBe(offRule?.why);
      expect(onRule?.since.startsWith(offRule?.since ?? "（無い）")).toBe(true);
      expect(onRule?.since).toContain("#732");
    }
  });

  it("(1) 同じ応答で ids on・off の要求の差は R-sc-02（$.rules[1]）だけで、データ・schema・結果はバイト列で同じ（台帳の on・off とも）", async () => {
    const table = withCheckTargets(fixtureTable());
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      const runWith = async (ids?: boolean) => {
        const recording = createCheckedRecordingClient([structured({ judgments: TARGETS.map(accept) })]);
        const outcome = await runSemanticCheck({
          plan: PLAN,
          list: LIST,
          table,
          documents: FIXTURE_DOCUMENTS,
          gateway: makeGateway(recording.client),
          ...(ledger === undefined ? {} : { ledger }),
          ...(ids === undefined ? {} : { ids }),
        });
        return { outcome, requests: JSON.parse(JSON.stringify(recording.structured)) as unknown[] };
      };
      const omitted = await runWith();
      const off = await runWith(false);
      const on = await runWith(true);
      expect(JSON.stringify(off.requests)).toBe(JSON.stringify(omitted.requests));
      expect(requestDiffsOf(on.requests, off.requests).map((diff) => diff.paths)).toEqual([["$.rules[1]"]]);
      const [onRequest] = on.requests as { rules: string[] }[];
      expect(onRequest?.rules).toEqual(ruleTexts(semanticCheckRuleDefinitionsOf(ledger, true)));
      expect(on.outcome).toEqual(off.outcome);
      expectNoAcceptanceMaterial([JSON.stringify(on.requests)]);
    }
  });

  it("(2) 意味の表の 1 文字を変えると ids on の R-sc-02 が変わる（表から組んでいる）。ids off は変わらない", () => {
    const changed: StructuralMeaningTable = {
      ...STRUCTURAL_MEANINGS,
      "field-type": { ...STRUCTURAL_MEANINGS["field-type"], meaning: STRUCTURAL_MEANINGS["field-type"].meaning.replace("項目", "列") },
    };
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      expect(rsc02(semanticCheckRuleDefinitionsOf(ledger, true, changed))).not.toBe(rsc02(semanticCheckRuleDefinitionsOf(ledger, true)));
      expect(semanticCheckRuleDefinitionsOf(ledger, false, changed)).toEqual(semanticCheckRuleDefinitionsOf(ledger));
    }
  });

  /** R4 を同じ種類（aggregate-no-period）の 2 つの行に掛けた構造の確かめ方の表（`targets` は対象の行ごとに 1 件） */
  function multiTargetTable(): NameTable {
    const table = fixtureTable();
    return {
      ...table,
      verification: table.verification.map((entry) =>
        entry.requirementId === "R4"
          ? {
              requirementId: "R4",
              kind: "structural" as const,
              reason: "集計が在ることを見る",
              checks: ["aggregate-no-period" as const, "aggregate-no-period" as const],
              targets: [
                { check: "aggregate-no-period" as const, targetId: "c.byKind", sourceId: null },
                { check: "aggregate-no-period" as const, targetId: "c.byMonth", sourceId: null },
              ],
            }
          : entry,
      ),
    };
  }

  async function runIds(outputs: readonly unknown[]) {
    const table = multiTargetTable();
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runSemanticCheck({
      plan: PLAN,
      list: LIST,
      table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      ledger: PROPERTY_LEDGER_VIEW,
      ids: true,
    });
    return { table, outcome, requests: recording.structured };
  }

  it.each([
    ["missing-target", "全体の率"],
    ["weak-verification", "月ごとの金額の合計"],
  ] as const)("(3) 同じ種類を 2 つの行に掛けた structural の要件に偽物の %s を返すと形の検査を通り、持ち越しになる", async (kind, quote) => {
    const { table, outcome, requests } = await runIds([{ judgments: [...acceptAll("R4"), reject("R4", kind, quote)] }]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    // データは確かめ方の entry（checks・targets）をそのまま渡す。規則に読み方の文がある
    const verification = JSON.parse(dataBlocks(request.input).find((block) => block.name === "確かめ方")!.text) as Record<string, unknown>[];
    const sent = verification.find((item) => item["requirementId"] === "R4");
    expect(sent?.["checks"]).toEqual(["aggregate-no-period", "aggregate-no-period"]);
    expect(sent?.["targets"]).toHaveLength(2);
    expect(request.rules?.[1]).toContain(READING);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R4")).toEqual({ requirementId: "R4", verdict: "reject", kind, quote });
    const carry = await deriveCarryOver({ list: LIST, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries.map((item) => item.requirementId)).toEqual(["R4", "R5"]);
    expect(carry.entries.find((item) => item.requirementId === "R4")?.reasons).toEqual([{ origin: "semantic-check", reason: kind }]);
  });

  it("(3) 受理すれば持ち越しにならない。拒否の種類の数は 3 のまま（schema・schema の名前は ids の on・off で同じ）。判定の欠落は今までどおり 2 回で malformed", async () => {
    const { table, outcome, requests } = await runIds([{ judgments: TARGETS.map(accept) }]);
    if (!outcome.ok) throw new Error("通るはず");
    const carry = await deriveCarryOver({ list: LIST, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries.map((item) => item.requirementId)).toEqual(["R5"]);
    expect(SEMANTIC_REJECTION_KINDS).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.schema)).toBe(JSON.stringify(SEMANTIC_CHECK_SCHEMA));
    expect(requests[0]?.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
    const partial = { judgments: acceptAll("R4") };
    const missing = await runIds([partial, partial]);
    if (missing.outcome.ok || missing.outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(missing.requests).toHaveLength(2);
  });
});

// ── 旗 v12.ids の C3 の束（Issue #735）─────────────────────────────────────────────

describe("旗 ids on：C3 を要件 5 件ごとの束に分けて同時に呼び、合併した判定に今の完全性の検査を掛ける（Issue #735）", () => {
  interface NodeFileSystem {
    readFileSync(path: URL, encoding: "utf8"): string;
  }
  /** 要件 n 件の一覧（文は抽象的な言葉だけ。題材の言葉は使わない） */
  const bigListOf = (count: number): RequirementList => ({
    requirements: Array.from({ length: count }, (_, index) => {
      const id = `R${String(index + 1)}`;
      const text = `${id} の項目を一覧で見られる。`;
      return { id, text, quote: text, position: { start: 0, end: text.length } };
    }),
    decisions: [],
    unresolved: [],
  });
  /** 一覧の要件それぞれに、題材の表の R1 の所属・確かめ方・分類を写した表（行は題材の表の全行） */
  const bigTableOf = (list: RequirementList): NameTable => {
    const base = fixtureTable();
    const pick = <T extends { readonly requirementId: string }>(entries: readonly T[]): T => {
      const found = entries.find((entry) => entry.requirementId === "R1");
      if (found === undefined) throw new Error("前提が壊れた：題材の表に R1 が無い");
      return found;
    };
    const ids = list.requirements.map((requirement) => requirement.id);
    return {
      ...base,
      ownership: ids.map((requirementId) => ({ ...pick(base.ownership), requirementId })),
      verification: ids.map((requirementId) => ({ ...pick(base.verification), requirementId })),
      classification: ids.map((requirementId) => ({ ...pick(base.classification), requirementId })),
    };
  };
  const BIG = bigListOf(12);
  const BIG_PLAN = planOf(BIG);
  const BIG_TABLE = bigTableOf(BIG);
  const BIG_IDS = BIG.requirements.map((requirement) => requirement.id);
  const BIG_ADVICE: readonly JudgeAdviceMarkEntry[] = [
    { requirementId: "R2", id: "s.items", mark: "suspect-unnecessary" },
    { requirementId: "R8", id: "f.item.amount", mark: "llm-unknown-confidence" },
  ];
  const textOf = (id: string): string => BIG.requirements.find((requirement) => requirement.id === id)?.text ?? "";
  /** 全対象の判定（`rejects` に挙げた要件は拒否。引用は要件の文） */
  const judgmentsOf = (ids: readonly string[], rejects: Readonly<Record<string, string>> = {}) => ({
    judgments: ids.map((id) => (rejects[id] === undefined ? accept(id) : reject(id, rejects[id] ?? "", textOf(id)))),
  });
  const inputOf = (gateway: SemanticCheckInput["gateway"], extra: Partial<SemanticCheckInput> = {}): SemanticCheckInput => ({
    plan: BIG_PLAN,
    list: BIG,
    table: BIG_TABLE,
    advice: BIG_ADVICE,
    documents: FIXTURE_DOCUMENTS,
    gateway,
    ids: true,
    ...extra,
  });
  /** 記録した応答を束ごとに読む偽物で流す（同じ回の束の n 回目は n 番目の記録を読み、その束の判定だけに絞る） */
  async function runBundled(outputs: readonly unknown[], extra: Partial<SemanticCheckInput> = {}, options: { readonly budgetUsd?: number } = {}) {
    const recording = createCheckedRecordingClient(outputs.map(structured), { bundledC3: true });
    const gateway = makeGateway(recording.client, options);
    const outcome = await runSemanticCheck(inputOf(gateway, extra));
    return { outcome, requests: recording.structured, gateway };
  }
  const blockOf = (request: LlmStructuredRequest | undefined, name: string): unknown =>
    JSON.parse(dataBlocks(request?.input ?? "").find((block) => block.name === name)?.text ?? "null") as unknown;
  const idsOfBlock = (request: LlmStructuredRequest | undefined, name: string): readonly string[] =>
    (blockOf(request, name) as readonly { readonly requirementId: string }[]).map((entry) => entry.requirementId);
  const BUNDLES = [BIG_IDS.slice(0, 5), BIG_IDS.slice(5, 10), BIG_IDS.slice(10)];

  /**
   * 応答を手で返す偽物の口（遅らせた応答）。要求は届いた順に積み、`release(i)` で i 本目の要求に答える（答えは `answer` が要求から
   * 組む。省けばその束の全受理）
   */
  function delayedClient(answer: (request: LlmStructuredRequest, index: number) => unknown = (request) => judgmentsOf(semanticRequestIds(request))) {
    const started: LlmStructuredRequest[] = [];
    const gates: (() => void)[] = [];
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        const index = started.length;
        started.push(request);
        await new Promise<void>((resolve) => gates.push(resolve));
        return { output: answer(request, index) as T, usage: undefined };
      },
      async callWithTools() {
        throw new Error("道具の呼び出しは無い");
      },
    };
    return { client, started, release: (index: number) => gates[index]?.() };
  }
  /** 待ちの約束（マイクロタスクと 1 回のタイマー）を進める */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** 条件が満ちるまで（最大 50 回）進め、さらに 3 回進めて止まっていることを確かめられるようにする */
  const settle = async (done: () => boolean): Promise<void> => {
    for (let index = 0; index < 50 && !done(); index += 1) await flush();
    for (let index = 0; index < 3; index += 1) await flush();
  };
  /** すぐに答える偽物の口（答えは要求の束の要件から組む。届いた要求を積む。束の順・同時数に依らない） */
  function answerClient(answer: (request: LlmStructuredRequest) => unknown = (request) => judgmentsOf(semanticRequestIds(request))) {
    const requests: LlmStructuredRequest[] = [];
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        requests.push(request);
        return { output: answer(request) as T, usage: undefined };
      },
      async callWithTools() {
        throw new Error("道具の呼び出しは無い");
      },
    };
    return { client, requests };
  }

  it("(1) 要件 12 件の対象で要求は 3 つ（5・5・2 件）。各要求の要件の文と引用・所属・確かめ方・助言の印はその束だけで、表の行は全行。規則・文書・schema は束で同じ。ids off は今どおり 1 つ", async () => {
    const { outcome, requests } = await runBundled([judgmentsOf(BIG_IDS)]);
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => idsOfBlock(request, "要件の文と引用"))).toEqual(BUNDLES);
    expect(requests.map((request) => idsOfBlock(request, "要件ごとの所属"))).toEqual(BUNDLES);
    expect(requests.map((request) => idsOfBlock(request, "確かめ方"))).toEqual(BUNDLES);
    expect(requests.map((request) => idsOfBlock(request, "助言の印"))).toEqual([["R2"], ["R8"], []]);
    const rows = requests.map((request) => JSON.stringify(blockOf(request, "表の行")));
    expect(new Set(rows).size).toBe(1);
    expect((blockOf(requests[0], "表の行") as readonly unknown[]).length).toBe(BIG_TABLE.rows.length);
    for (const request of requests) {
      expect(request.rules).toEqual(requests[0]?.rules);
      expect(JSON.stringify(request.schema)).toBe(JSON.stringify(SEMANTIC_CHECK_SCHEMA));
      expect(dataBlocks(request.input).map((block) => block.name)).toEqual(dataBlocks(requests[0]?.input ?? "").map((block) => block.name));
      expect(request.input.split('<data name="要件の文と引用">')[0]).toBe(requests[0]?.input.split('<data name="要件の文と引用">')[0]);
    }
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.map((judgment) => judgment.requirementId)).toEqual(BIG_IDS);
    expect(outcome.value.targets).toEqual(BIG_IDS);
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(BIG_TABLE));
    // 直す前（ids off の今の経路）は 1 つで、全対象のデータ
    const off = await runBundled([judgmentsOf(BIG_IDS)], { ids: false });
    expect(off.requests).toHaveLength(1);
    expect(idsOfBlock(off.requests[0], "要件の文と引用")).toEqual(BIG_IDS);
    if (!off.outcome.ok) throw new Error("通るはず");
    expect(off.outcome.value).toEqual(outcome.value);
  });

  it("(1) 対象が 1〜5 件なら要求は 1 つで、データ・schema は ids off の要求とバイト列で同じ（規則は ids on の R-sc-02 の文だけが違う）。対象 0 件なら呼ばない", async () => {
    for (const count of [1, 5]) {
      const list = bigListOf(count);
      const extra = { list, plan: planOf(list), table: bigTableOf(list) };
      const ids = list.requirements.map((requirement) => requirement.id);
      const on = await runBundled([judgmentsOf(ids)], extra);
      const off = await runBundled([judgmentsOf(ids)], { ...extra, ids: false });
      expect(on.requests).toHaveLength(1);
      expect(on.requests[0]?.input).toBe(off.requests[0]?.input);
      expect(JSON.stringify(on.requests[0]?.schema)).toBe(JSON.stringify(off.requests[0]?.schema));
      expect(on.requests[0]?.rules).toEqual(ruleTexts(semanticCheckRuleDefinitionsOf(undefined, true)));
      expect(on.outcome).toEqual(off.outcome);
    }
    const unresolved: NameTable = {
      ...BIG_TABLE,
      verification: BIG_TABLE.verification.map((entry) => ({ requirementId: entry.requirementId, kind: "unresolved" as const, reason: "宣言で書けない", constraintIds: [] })),
    };
    const none = await runBundled([], { table: unresolved });
    expect(none.requests).toHaveLength(0);
    if (!none.outcome.ok) throw new Error("通るはず");
    expect(none.outcome.value.judgments).toEqual([]);
  });

  it("(2) 遅らせた応答：どの応答も返す前に 3 つの束が全部始まっている。同時数 1 と 5 で要求の材料が同じ", async () => {
    const delayed = delayedClient();
    const pending = runSemanticCheck(inputOf(makeGateway(delayed.client)));
    await settle(() => delayed.started.length >= 3);
    expect(delayed.started).toHaveLength(3);
    for (const index of [0, 1, 2]) delayed.release(index);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    const serial = answerClient();
    const serialOutcome = await runSemanticCheck(inputOf(makeGateway(serial.client), { bundleConcurrency: 1 }));
    expect(serial.requests.map((request) => JSON.stringify(request))).toEqual(delayed.started.map((request) => JSON.stringify(request)));
    expect(serialOutcome).toEqual(outcome);
  });

  it("(2) 束 6 つ（要件 30）で同時数 5：6 つ目の束は空きが出るまで始まらない", async () => {
    const list = bigListOf(30);
    const delayed = delayedClient();
    const pending = runSemanticCheck(inputOf(makeGateway(delayed.client), { list, plan: planOf(list), table: bigTableOf(list) }));
    await settle(() => delayed.started.length >= V12_T2_BUNDLE.concurrency);
    expect(delayed.started).toHaveLength(V12_T2_BUNDLE.concurrency);
    delayed.release(2);
    await settle(() => delayed.started.length >= 6);
    expect(delayed.started).toHaveLength(6);
    expect(semanticRequestIds(delayed.started[5] as LlmStructuredRequest)).toEqual(list.requirements.slice(25).map((requirement) => requirement.id));
    for (const index of [0, 1, 3, 4, 5]) delayed.release(index);
    const outcome = await pending;
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments).toHaveLength(30);
  });

  it("(3) 完了の順を逆にしても、合併した判定・表の SHA・持ち越し・後続の材料（対象）が同じ", async () => {
    const rejects = { R3: "unnecessary-ownership", R8: "missing-target", R12: "weak-verification" };
    const answer = (request: LlmStructuredRequest) => judgmentsOf(semanticRequestIds(request), rejects);
    const results = [];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
    ]) {
      const delayed = delayedClient(answer);
      const pending = runSemanticCheck(inputOf(makeGateway(delayed.client)));
      await settle(() => delayed.started.length >= 3);
      for (const index of order) {
        delayed.release(index);
        await flush();
      }
      const outcome = await pending;
      if (!outcome.ok) throw new Error("通るはず");
      const carry = await deriveCarryOver({ list: BIG, table: BIG_TABLE, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
      results.push({ value: outcome.value, carry });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.carry.entries.map((entry) => entry.requirementId)).toEqual(["R3", "R8", "R12"]);
  });

  it("(4) 1 つの束が判定を 1 件欠くとその束だけやり直す（ほかの束は呼び直さない）。予算に束と回が残る", async () => {
    const shapeRetries = semanticShapeRetryBudgetOf(BIG);
    const missing = { judgments: judgmentsOf(BIG_IDS).judgments.filter((judgment) => judgment.requirementId !== "R7") };
    const { outcome, requests, gateway } = await runBundled([missing, judgmentsOf(BIG_IDS)], { shapeRetries });
    expect(outcome.ok).toBe(true);
    expect(requests.map((request) => semanticRequestIds(request))).toEqual([...BUNDLES, BUNDLES[1]]);
    expect(requests[3]?.input).toContain("前回の形の問題");
    expect(gateway.counts.retries).toEqual({ communication: 0, shape: 1, content: 0 });
    expect(shapeRetries).toEqual({ limit: 3, used: [{ round: 1, bundle: 1 }] });
  });

  it("(4) 2 回続けば malformed で、ほかの束の判定を採らない。始めた束の終わりを待ち、開始・応答の数が口の計に残る", async () => {
    const missing = (request: LlmStructuredRequest) => ({
      judgments: judgmentsOf(semanticRequestIds(request)).judgments.filter((judgment) => judgment.requirementId !== "R2"),
    });
    const delayed = delayedClient(missing);
    const gateway = makeGateway(delayed.client);
    let settled = false;
    const pending = runSemanticCheck(inputOf(gateway)).then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle(() => delayed.started.length >= 3);
    // 束 1 を 2 回続けて落とす（ほかの束は答えを返していない）
    delayed.release(0);
    await settle(() => delayed.started.length >= 4);
    expect(delayed.started).toHaveLength(4);
    delayed.release(3);
    await settle(() => settled);
    expect(settled).toBe(false);
    delayed.release(1);
    delayed.release(2);
    const outcome = await pending;
    if (outcome.ok) throw new Error("通らないはず");
    expect(outcome.failure.kind).toBe("malformed");
    expect(gateway.counts.attempts).toMatchObject({ started: 4, responded: 4, errors: 0, cancelled_deadline: 0, cancelled_timeout: 0 });
    expect(gateway.counts.retries).toEqual({ communication: 0, shape: 1, content: 0 });
  });

  it("(4) 形のやり直しの予算は 2 回の点検を通じて段全体で束の数まで：使い切った回の束の形の落ちは再試行せずに malformed（呼び出しは増えない）", async () => {
    const shapeRetries = semanticShapeRetryBudgetOf(BIG);
    const allBad = { judgments: [] };
    // 1 回目：全部の束が形で 1 度落ちて、やり直しで通る（予算 3 を使い切る）
    const first = await runBundled([allBad, judgmentsOf(BIG_IDS)], { shapeRetries, round: 1 });
    expect(first.outcome.ok).toBe(true);
    expect(first.requests).toHaveLength(6);
    expect(shapeRetries.used).toEqual([0, 1, 2].map((bundle) => ({ round: 1, bundle })));
    // 2 回目：形の落ちは予算が尽きているのでやり直さない
    const second = await runBundled([allBad, judgmentsOf(BIG_IDS)], { shapeRetries, round: 2 });
    if (second.outcome.ok) throw new Error("通らないはず");
    expect(second.outcome.failure).toMatchObject({ kind: "malformed", attempts: 1 });
    expect(second.requests).toHaveLength(3);
    expect(second.gateway.counts.retries.shape).toBe(0);
    expect(shapeRetries.used).toHaveLength(3);
    // 予算が残る回は今までどおり束ごとに 1 回やり直す（2 回目でも）
    const fresh = semanticShapeRetryBudgetOf(BIG);
    const retried = await runBundled([allBad, judgmentsOf(BIG_IDS)], { shapeRetries: fresh, round: 2 });
    expect(retried.outcome.ok).toBe(true);
    expect(fresh.used).toEqual([0, 1, 2].map((bundle) => ({ round: 2, bundle })));
    // 上限は要件の一覧の数を束の大きさで割った数（対象の数ではない）
    expect(semanticShapeRetryBudgetOf(bigListOf(25)).limit).toBe(5);
    expect(semanticShapeRetryBudgetOf(bigListOf(5)).limit).toBe(1);
  });

  it.each([
    { name: "他束の要件 ID", output: { judgments: [...judgmentsOf(BUNDLES[0] ?? []).judgments, accept("R6")] }, message: "要件 ID が点検の対象に無い" },
    { name: "一覧に無い要件 ID", output: { judgments: [...judgmentsOf(BUNDLES[0] ?? []).judgments, accept("R99")] }, message: "要件 ID が点検の対象に無い" },
    { name: "重複", output: { judgments: [...judgmentsOf(BUNDLES[0] ?? []).judgments, accept("R2")] }, message: "同じ要件の判定が重なっている" },
    { name: "欠落", output: { judgments: judgmentsOf(BUNDLES[0] ?? []).judgments.slice(1) }, message: "判定が無い要件がある" },
    {
      name: "不正な引用",
      output: { judgments: judgmentsOf(BUNDLES[0] ?? []).judgments.map((judgment) => (judgment.requirementId === "R4" ? reject("R4", "missing-target", "どこにも無い文") : judgment)) },
      message: "引用が確定した仕様にも要件の文にも無い",
    },
  ])("(5) 束の検査：$name はその束の形の落ち（2 回で malformed。ほかの束は呼び直さない）", async ({ output, message }) => {
    // 束 1（R1〜R5）の応答だけを差し替える偽物（ほかの束は全受理）
    const delayed = delayedClient((request) => (semanticRequestIds(request)[0] === "R1" ? output : judgmentsOf(semanticRequestIds(request))));
    const pending = runSemanticCheck(inputOf(makeGateway(delayed.client)));
    await settle(() => delayed.started.length >= 3);
    for (const index of [0, 1, 2]) delayed.release(index);
    await settle(() => delayed.started.length >= 4);
    delayed.release(3);
    const outcome = await pending;
    if (outcome.ok) throw new Error("通らないはず");
    expect(outcome.failure.kind).toBe("malformed");
    if (outcome.failure.kind !== "malformed") return;
    expect(outcome.failure.problems.map((problem) => problem.message)).toContain(message);
    expect(delayed.started.map((request) => semanticRequestIds(request)[0])).toEqual(["R1", "R6", "R11", "R1"]);
  });

  it("(5) 合併の関数に不正な束の結果を直接入れると、全体の完全性で落ちる（他束の重複・対象に無い要件・欠落）。正しい束なら対象の順", () => {
    const ok = (ids: readonly string[]) => ids.map((requirementId) => ({ requirementId, verdict: "accept" as const }));
    const merged = mergeSemanticJudgments(BIG_IDS, [ok(BUNDLES[2] ?? []), ok(BUNDLES[0] ?? []), ok(BUNDLES[1] ?? [])]);
    if (!merged.ok) throw new Error("通るはず");
    expect(merged.value.map((judgment) => judgment.requirementId)).toEqual(BIG_IDS);
    const cases = [
      { bundles: [ok(BUNDLES[0] ?? []), ok([...(BUNDLES[1] ?? []), "R1"]), ok(BUNDLES[2] ?? [])], message: SEMANTIC_MERGE_MESSAGES.duplicate },
      { bundles: [ok(BUNDLES[0] ?? []), ok(BUNDLES[1] ?? []), ok([...(BUNDLES[2] ?? []), "R99"])], message: SEMANTIC_MERGE_MESSAGES.unknown },
      { bundles: [ok(BUNDLES[0] ?? []), ok(BUNDLES[1] ?? []), ok([])], message: SEMANTIC_MERGE_MESSAGES.missing },
    ];
    for (const entry of cases) {
      const result = mergeSemanticJudgments(BIG_IDS, entry.bundles);
      if (result.ok) throw new Error("落ちるはず");
      expect(result.problems.map((problem) => problem.message)).toContain(entry.message);
    }
  });

  it("(6) 共有の予算が 1 束分しかないと段は予算で止まり、一部の束の判定だけを採らない（予約は 1 束分。予算での未着手が残る）", async () => {
    const probe = answerClient();
    await runSemanticCheck(inputOf(makeGateway(probe.client)));
    const rates = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };
    const reservation = (request: LlmStructuredRequest | undefined): number =>
      request === undefined
        ? Number.NaN
        : estimateMaxCostUsd({ inputTokens: estimateInputUpperBoundTokens(structuredInputParts(request)), maxOutputTokens: request.maxOutputTokens ?? 0, rates });
    const first = reservation(probe.requests[0]);
    expect(reservation(probe.requests[2])).toBeGreaterThan(first * 0.02);
    const limited = answerClient();
    const gateway = makeGateway(limited.client, { budgetUsd: first * 1.01 });
    const outcome = await runSemanticCheck(inputOf(gateway));
    const requests = limited.requests;
    if (outcome.ok) throw new Error("通らないはず");
    expect(outcome.failure.kind).toBe("budget");
    expect(requests).toHaveLength(1);
    expect(gateway.counts.attempts).toMatchObject({ started: 1, responded: 1, not_started: { budget: 2, deadline: 0, limit: 0, timeout: 0 } });
  });

  it("要求・この試験・段のファイルに受入の題材の言葉が無い", async () => {
    const { requests } = await runBundled([judgmentsOf(BIG_IDS)]);
    expectNoAcceptanceMaterial(requests.map((request) => JSON.stringify(request)));
    const fs = (await import(/* @vite-ignore */ "node:fs")) as NodeFileSystem;
    for (const file of ["./semantic-check.ts", "./semantic-check.test.ts", "../run.ts"]) {
      expectNoAcceptanceMaterial([fs.readFileSync(new URL(file, import.meta.url), "utf8")]);
    }
    const [word] = ACCEPTANCE_MATERIAL_WORDS;
    expect(() => expectNoAcceptanceMaterial([`束 ${word ?? ""}`])).toThrow();
  });
});

describe("旗 ids on：束が 2 つ以上の C3 の要求に、束の外の対象の要件を「参照のみ（判定しない）」の塊で渡し、その読み方の規則を 1 つ足す（Issue #741）", () => {
  interface NodeFileSystem {
    readFileSync(path: URL, encoding: "utf8"): string;
  }
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  const requirementOf = (id: string, text: string, quote: string = text) => ({ id, text, quote, position: { start: 0, end: quote.length } });
  const REFERENCE_RULE = ruleTexts([SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION])[0] as string;

  /**
   * 要件 6 件（束 2 つ）：束 2 の要件 Y（R6）が束 1 の要件 X（R1）の指定した項目を参照する。`variant` で X の文と所属だけを変える
   * （A：題名と金額・所属も 2 つ、B：題名だけ・所属も 1 つ、C：B の文で所属は A のまま）。Y の文・引用・所属・確かめ方と表の行は同じ
   */
  const X_TEXT = { A: "R1 は、項目の題名と金額を指定する。", B: "R1 は、項目の題名だけを指定する。" } as const;
  const X_OWNERSHIP = { A: ["f.item.title", "f.item.amount"], B: ["f.item.title"] } as const;
  const Y_TEXT = "R6 は、R1 が指定した項目を全部、一覧の画面に出す。";
  function referringOf(variant: "A" | "B" | "C") {
    const text = variant === "A" ? X_TEXT.A : X_TEXT.B;
    const owned = variant === "B" ? X_OWNERSHIP.B : X_OWNERSHIP.A;
    const list: RequirementList = {
      requirements: [
        requirementOf("R1", text),
        ...["R2", "R3", "R4", "R5"].map((id) => requirementOf(id, `${id} の項目を一覧で見られる。`)),
        requirementOf("R6", Y_TEXT),
      ],
      decisions: [],
      unresolved: [],
    };
    const base = fixtureTable();
    const ids = list.requirements.map((requirement) => requirement.id);
    const table: NameTable = {
      rows: base.rows,
      ownership: ids.map((requirementId) => ({
        requirementId,
        roles: requirementId === "R1" ? owned.map(stated) : requirementId === "R6" ? ["f.item.title", "f.item.amount", "s.items"].map(stated) : [stated("s.items")],
      })),
      verification: ids.map((requirementId) =>
        requirementId === "R6"
          ? { requirementId, kind: "structural" as const, reason: "画面に出ることを見る", checks: ["view-shows" as const] }
          : { requirementId, kind: "fixed-test" as const },
      ),
      classification: ids.map((requirementId) => ({ requirementId, nature: requirementId === "R6" ? ("existence-only" as const) : ("ruled" as const) })),
    };
    return { list, table, plan: planOf(list) };
  }
  const acceptAllOf = (request: LlmStructuredRequest) => ({ judgments: semanticRequestIds(request).map(accept) });
  /** 偽物の口（届いた要求を積み、要求の束の要件を全部受理する） */
  async function requestsOf(materials: { readonly list: RequirementList; readonly table: NameTable; readonly plan: ConfirmedPlan }, extra: Partial<SemanticCheckInput> = {}) {
    const requests: LlmStructuredRequest[] = [];
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        requests.push(request);
        return { output: acceptAllOf(request) as T, usage: undefined };
      },
      async callWithTools() {
        throw new Error("道具の呼び出しは無い");
      },
    };
    const outcome = await runSemanticCheck({
      plan: materials.plan,
      list: materials.list,
      table: materials.table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(client),
      ids: true,
      bundleConcurrency: 1,
      ...extra,
    });
    return { outcome, requests };
  }
  const referenceOf = (request: LlmStructuredRequest | undefined): unknown => {
    const block = dataBlocks(request?.input ?? "").find((entry) => entry.name === SEMANTIC_CHECK_REFERENCE_DATA_NAME);
    return block === undefined ? undefined : (JSON.parse(block.text) as unknown);
  };
  /** 直す前の要求（参照の塊と、末尾に足した規則を外す。Issue #741 の前の段のコードが作った要求の形） */
  const revert741 = (request: LlmStructuredRequest): LlmStructuredRequest => {
    const rules = request.rules ?? [];
    if (rules.at(-1) !== REFERENCE_RULE) throw new Error("前提が壊れた：末尾に参照の規則が無い");
    const input = request.input.replace(/\n<data name="ほかの要件（参照のみ。判定しない）">\n[\s\S]*?\n<\/data>$/, "");
    if (input === request.input) throw new Error("前提が壊れた：参照の塊が無い");
    return { ...request, rules: rules.slice(0, -1), input };
  };
  const shaOf = async (request: LlmStructuredRequest | undefined): Promise<string> => sha256Hex(JSON.stringify(request));
  /**
   * 直す前（4a61133 の段のコード）が作った要求の SHA-256（`JSON.stringify` の要求）。束 2 の要求は A・B で同じだった（材料の欠け）。
   * 境界は (2') の一覧 8 件・対象 5 件の要求
   */
  const BEFORE_741 = {
    bundle2: "ee59539510d24961acfb76e0923751020a2ce841d52f88fc9bdd9ec4eb363a9d",
    boundary: "d536022664f4a4ad50969bdca2c01b11f5f8fa1b1ec00e085356ba001c5d025a",
  } as const;

  it("(1) 束 2 の Y が束 1 の X を参照する対 A・B：直す前は束 2 の要求が A・B で同じで、全対象を 1 要求で渡す経路（ids off）は異なる。直した後は束 2 の参照の塊に A・B それぞれの X の文と所属が入り、要求が異なる", async () => {
    const [a, b] = [referringOf("A"), referringOf("B")];
    // 前提：Y 自身の文・引用・所属・確かめ方と表の行は A・B で同じで、X の文と所属だけが違う
    expect(a.list.requirements.slice(1)).toEqual(b.list.requirements.slice(1));
    expect(a.table.rows).toEqual(b.table.rows);
    expect(a.table.ownership.slice(1)).toEqual(b.table.ownership.slice(1));
    expect(a.table.verification).toEqual(b.table.verification);
    const onA = await requestsOf(a);
    const onB = await requestsOf(b);
    expect(onA.requests.map(semanticRequestIds)).toEqual([["R1", "R2", "R3", "R4", "R5"], ["R6"]]);
    expect(onB.requests.map(semanticRequestIds)).toEqual([["R1", "R2", "R3", "R4", "R5"], ["R6"]]);
    // 直す前の挙動：束 2 の要求は A・B でバイト列が同じ（4a61133 の段のコードの SHA とも一致）
    const [beforeA, beforeB] = [revert741(onA.requests[1] as LlmStructuredRequest), revert741(onB.requests[1] as LlmStructuredRequest)];
    expect(JSON.stringify(beforeA)).toBe(JSON.stringify(beforeB));
    expect(await shaOf(beforeA)).toBe(BEFORE_741.bundle2);
    // 全対象を 1 要求で渡す経路では A・B の要求は異なる
    const offA = await requestsOf(a, { ids: false });
    const offB = await requestsOf(b, { ids: false });
    expect(offA.requests).toHaveLength(1);
    expect(JSON.stringify(offA.requests[0])).not.toBe(JSON.stringify(offB.requests[0]));
    // 直した後：束 2 の参照の塊に、それぞれの X の文と所属が入り、要求が異なる
    for (const [run, variant] of [
      [onA, "A"],
      [onB, "B"],
    ] as const) {
      const reference = referenceOf(run.requests[1]) as { readonly 要件の文と引用: readonly unknown[]; readonly 要件ごとの所属: readonly unknown[] };
      expect(reference.要件の文と引用[0]).toEqual({ requirementId: "R1", text: X_TEXT[variant], quote: X_TEXT[variant] });
      expect(reference.要件ごとの所属[0]).toEqual({ requirementId: "R1", roles: X_OWNERSHIP[variant].map(stated) });
    }
    expect(JSON.stringify(onA.requests[1])).not.toBe(JSON.stringify(onB.requests[1]));
    expect(onA.outcome.ok && onB.outcome.ok).toBe(true);
  });

  it("(1') X の文だけを変え、所属は同じにした対（A・C）でも、直した後の束 2 の要求は異なる（直す前は同じ）", async () => {
    const [a, c] = [referringOf("A"), referringOf("C")];
    expect(a.table).toEqual(c.table);
    const onA = await requestsOf(a);
    const onC = await requestsOf(c);
    expect(JSON.stringify(revert741(onA.requests[1] as LlmStructuredRequest))).toBe(JSON.stringify(revert741(onC.requests[1] as LlmStructuredRequest)));
    expect(JSON.stringify(onA.requests[1])).not.toBe(JSON.stringify(onC.requests[1]));
    const reference = referenceOf(onC.requests[1]) as { readonly 要件の文と引用: readonly unknown[] };
    expect(reference.要件の文と引用[0]).toEqual({ requirementId: "R1", text: X_TEXT.B, quote: X_TEXT.B });
  });

  /** 要件 12 件（R4・R9 は unresolved）。引用は文と別の文字列、所属・確かめ方・助言の印は要件ごとに違う値 */
  function mixedOf() {
    const ids = Array.from({ length: 12 }, (_, index) => `R${String(index + 1)}`);
    const list: RequirementList = {
      requirements: ids.map((id) => requirementOf(id, `${id} の値を一覧で見られる。`, `依頼の ${id} の文`)),
      decisions: [],
      unresolved: [],
    };
    const base = fixtureTable();
    const rowIds = base.rows.map((row) => row.id);
    const table: NameTable = {
      rows: base.rows,
      ownership: ids.map((requirementId, index) => ({ requirementId, roles: [stated(rowIds[index % rowIds.length] as string)] })),
      verification: ids.map((requirementId, index) =>
        requirementId === "R4" || requirementId === "R9"
          ? { requirementId, kind: "unresolved" as const, reason: "宣言で書けない", constraintIds: [FIXTURE_CONSTRAINT_ID] }
          : index % 2 === 0
            ? { requirementId, kind: "fixed-test" as const }
            : { requirementId, kind: "structural" as const, reason: `${requirementId} の画面に出ることを見る`, checks: ["view-shows" as const] },
      ),
      classification: ids.map((requirementId) => ({ requirementId, nature: "ruled" as const })),
    };
    const advice: readonly JudgeAdviceMarkEntry[] = [
      { requirementId: "R2", id: "s.items", mark: "suspect-unnecessary" },
      { requirementId: "R8", id: "f.item.amount", mark: "llm-unknown-confidence" },
      { requirementId: "R9", id: "f.item.day", mark: "undetermined" },
    ];
    return { list, table, plan: planOf(list), advice };
  }

  it("(2) 参照の塊は、判定の対象のうち束の外のものをちょうど 1 回ずつ一覧の順で持ち、束の要件と unresolved を含まない。文・引用・所属・確かめ方・助言の印の値が元の入力どおり", async () => {
    const mixed = mixedOf();
    const targets = semanticCheckTargets(mixed.list, mixed.table);
    expect(targets).toEqual(["R1", "R2", "R3", "R5", "R6", "R7", "R8", "R10", "R11", "R12"]);
    const { outcome, requests } = await requestsOf(mixed, { advice: mixed.advice });
    expect(outcome.ok).toBe(true);
    const bundles = [targets.slice(0, 5), targets.slice(5)];
    expect(requests.map(semanticRequestIds)).toEqual(bundles);
    const expected = (ids: readonly string[]) => ({
      要件の文と引用: ids.map((id) => {
        const found = mixed.list.requirements.find((requirement) => requirement.id === id);
        return { requirementId: id, text: found?.text, quote: found?.quote };
      }),
      要件ごとの所属: ids.map((id) => mixed.table.ownership.find((entry) => entry.requirementId === id)),
      確かめ方: ids.map((id) => mixed.table.verification.find((entry) => entry.requirementId === id)),
      助言の印: mixed.advice.filter((entry) => ids.includes(entry.requirementId)),
    });
    for (const [index, request] of requests.entries()) {
      const others = targets.filter((id) => !(bundles[index] ?? []).includes(id));
      const reference = referenceOf(request) as Record<string, readonly { readonly requirementId: string }[]>;
      expect(reference).toEqual(expected(others));
      for (const name of ["要件の文と引用", "要件ごとの所属", "確かめ方"]) {
        expect((reference[name] ?? []).map((entry) => entry.requirementId)).toEqual(others);
      }
      // 参照の塊は末尾に 1 つだけ。主の塊は今のまま束の要件だけ
      expect(dataBlocks(request.input).map((block) => block.name)).toEqual(["要件の文と引用", "表の行", "要件ごとの所属", "確かめ方", "助言の印", SEMANTIC_CHECK_REFERENCE_DATA_NAME]);
      // 名前・試験・期待・合否を渡さない
      expect(hasKey(reference, "name")).toBe(false);
    }
    // 値は手で書いた期待とも一致する（実装と同じ組み方だけで通る形を防ぐ）
    const first = referenceOf(requests[0]) as Record<string, readonly unknown[]>;
    expect(first["要件の文と引用"]?.[0]).toEqual({ requirementId: "R7", text: "R7 の値を一覧で見られる。", quote: "依頼の R7 の文" });
    expect(first["確かめ方"]?.[0]).toEqual({ requirementId: "R7", kind: "fixed-test" });
    expect(first["助言の印"]).toEqual([{ requirementId: "R8", id: "f.item.amount", mark: "llm-unknown-confidence" }]);
    const second = referenceOf(requests[1]) as Record<string, readonly unknown[]>;
    expect(second["確かめ方"]?.[1]).toEqual({ requirementId: "R2", kind: "structural", reason: "R2 の画面に出ることを見る", checks: ["view-shows"] });
    expect(second["助言の印"]).toEqual([{ requirementId: "R2", id: "s.items", mark: "suspect-unnecessary" }]);
  });

  it("(2') 境界：一覧が 8 件でも判定の対象が 5 件（unresolved を除く）なら、参照の塊も追加の規則も無く、要求は直す前とバイト列で同じ。対象 0 件なら呼ばない", async () => {
    const mixed = mixedOf();
    const list: RequirementList = { ...mixed.list, requirements: mixed.list.requirements.slice(0, 8) };
    const keep = (entry: { readonly requirementId: string }) => list.requirements.some((requirement) => requirement.id === entry.requirementId);
    const unresolvedOf = (requirementId: string) => ({ requirementId, kind: "unresolved" as const, reason: "宣言で書けない", constraintIds: [FIXTURE_CONSTRAINT_ID] });
    const table: NameTable = {
      rows: mixed.table.rows,
      ownership: mixed.table.ownership.filter(keep),
      verification: mixed.table.verification.filter(keep).map((entry) => (["R4", "R7", "R8"].includes(entry.requirementId) ? unresolvedOf(entry.requirementId) : entry)),
      classification: mixed.table.classification.filter(keep),
    };
    expect(semanticCheckTargets(list, table)).toEqual(["R1", "R2", "R3", "R5", "R6"]);
    const materials = { list, table, plan: planOf(list) };
    const { requests } = await requestsOf(materials, { advice: mixed.advice });
    expect(requests).toHaveLength(1);
    expect(referenceOf(requests[0])).toBeUndefined();
    expect(requests[0]?.rules).not.toContain(REFERENCE_RULE);
    expect(requests[0]?.rules).toEqual(ruleTexts(semanticCheckRuleDefinitionsOf(undefined, true)));
    expect(await shaOf(requests[0])).toBe(BEFORE_741.boundary);
    const none = await requestsOf(materials, { table: { ...table, verification: table.verification.map((entry) => unresolvedOf(entry.requirementId)) } });
    expect(none.requests).toHaveLength(0);
  });

  it("(2'') 追加の規則の定義は不備 0 で、R-sc-01〜05 の共通の定義に無い。束が 2 つ以上の要求にだけ末尾に入り、束が 1 つの要求と旗 off の要求に入らない", async () => {
    expect(ruleDefinitionDefects([...semanticCheckRuleDefinitionsOf(undefined, true), SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION])).toEqual([]);
    expect(ruleDefinitionDefects([...semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, true), SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION])).toEqual([]);
    expect(SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual(["R-sc-01", "R-sc-02", "R-sc-03", "R-sc-04", "R-sc-05"]);
    expect(SEMANTIC_CHECK_RULES).not.toContain(REFERENCE_RULE);
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      expect(semanticCheckRuleDefinitionsOf(ledger, true).map((definition) => definition.id)).not.toContain(SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION.id);
    }
    const mixed = mixedOf();
    const on = await requestsOf(mixed);
    expect(on.requests).toHaveLength(2);
    for (const request of on.requests) expect(request.rules).toEqual([...ruleTexts(semanticCheckRuleDefinitionsOf(undefined, true)), REFERENCE_RULE]);
    const off = await requestsOf(mixed, { ids: false });
    expect(off.requests).toHaveLength(1);
    expect(off.requests[0]?.rules).not.toContain(REFERENCE_RULE);
    expect(referenceOf(off.requests[0])).toBeUndefined();
    const single = await requestsOf({ ...mixed, list: { ...mixed.list, requirements: mixed.list.requirements.slice(0, 5) } });
    expect(single.requests).toHaveLength(1);
    expect(single.requests[0]?.rules).not.toContain(REFERENCE_RULE);
  });

  it("(3) 参照の塊にある束の外の要件の判定を返した応答は、その束の形の落ち（2 回で malformed。形の検査は変えない）", async () => {
    const materials = referringOf("A");
    const requests: LlmStructuredRequest[] = [];
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        requests.push(request);
        const ids = semanticRequestIds(request);
        // 束 2 は、参照のみの X（R1）の判定も返す
        const output = ids[0] === "R6" ? { judgments: [accept("R6"), accept("R1")] } : { judgments: ids.map(accept) };
        return { output: output as T, usage: undefined };
      },
      async callWithTools() {
        throw new Error("道具の呼び出しは無い");
      },
    };
    const outcome = await runSemanticCheck({ ...materials, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(client), ids: true, bundleConcurrency: 1 });
    if (outcome.ok) throw new Error("通らないはず");
    expect(outcome.failure.kind).toBe("malformed");
    if (outcome.failure.kind !== "malformed") return;
    expect(outcome.failure.problems.map((problem) => problem.message)).toContain("要件 ID が点検の対象に無い");
    expect(requests.map((request) => semanticRequestIds(request)[0])).toEqual(["R1", "R6", "R6"]);
    expect((referenceOf(requests[1]) as { readonly 要件の文と引用: readonly { readonly requirementId: string }[] }).要件の文と引用.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
  });

  it("要求・この試験・段のファイルに受入の題材の言葉が無い", async () => {
    const runs = [await requestsOf(referringOf("A")), await requestsOf(referringOf("B")), await requestsOf(mixedOf(), { advice: mixedOf().advice })];
    expectNoAcceptanceMaterial(runs.flatMap((run) => run.requests.map((request) => JSON.stringify(request))));
    const fs = (await import(/* @vite-ignore */ "node:fs")) as NodeFileSystem;
    for (const file of ["./semantic-check.ts", "./semantic-check.test.ts"]) {
      expectNoAcceptanceMaterial([fs.readFileSync(new URL(file, import.meta.url), "utf8")]);
    }
  });

  /**
   * 反例の対（PR #742 のレビューの R1）：X（R1）の引用は共通、Y（R6）の確かめ方は view-shows で targets は両入力とも項目 A（題名）だけ。
   * X の指定は A＝項目 A、B＝項目 A と項目 B（金額）。`textOnly` なら X の所属は A のまま、文だけを B の文にする（(1') の対）
   */
  const PAIR_X_TEXT = { A: "R1 は、項目の題名を指定する。", B: "R1 は、項目の題名と金額を指定する。" } as const;
  const PAIR_X_OWNERSHIP = { A: ["f.item.title"], B: ["f.item.title", "f.item.amount"] } as const;
  const PAIR_X_QUOTE = "依頼の一つ目：指定した項目";
  const PAIR_Y_TARGETS = [{ check: "view-shows" as const, targetId: "s.items", sourceId: "f.item.title" }];
  function pairOf(variant: "A" | "B", textOnly = false) {
    const owned = textOnly ? PAIR_X_OWNERSHIP.A : PAIR_X_OWNERSHIP[variant];
    const list: RequirementList = {
      requirements: [
        requirementOf("R1", PAIR_X_TEXT[variant], PAIR_X_QUOTE),
        ...["R2", "R3", "R4", "R5"].map((id) => requirementOf(id, `${id} の項目を一覧で見られる。`)),
        requirementOf("R6", Y_TEXT),
      ],
      decisions: [],
      unresolved: [],
    };
    const base = fixtureTable();
    const ids = list.requirements.map((requirement) => requirement.id);
    const table: NameTable = {
      rows: base.rows,
      ownership: ids.map((requirementId) => ({
        requirementId,
        roles: requirementId === "R1" ? owned.map(stated) : requirementId === "R6" ? ["s.items", "f.item.title"].map(stated) : [stated("s.items")],
      })),
      verification: ids.map((requirementId) =>
        requirementId === "R6"
          ? { requirementId, kind: "structural" as const, reason: "画面に出ることを見る", checks: ["view-shows" as const], targets: PAIR_Y_TARGETS }
          : { requirementId, kind: "fixed-test" as const },
      ),
      classification: ids.map((requirementId) => ({ requirementId, nature: requirementId === "R6" ? ("existence-only" as const) : ("ruled" as const) })),
    };
    return { list, table, plan: planOf(list) };
  }
  /** Y の対象の欠落（X が所属に持つ項目のうち、Y の view-shows の targets に無いもの） */
  const yMissingOf = (table: NameTable): readonly string[] => {
    const fields = new Set(table.rows.filter((row) => row.kind === "field").map((row) => row.id));
    const specified = (table.ownership.find((entry) => entry.requirementId === "R1")?.roles ?? []).map((role) => role.id).filter((id) => fields.has(id));
    const y = table.verification.find((entry) => entry.requirementId === "R6");
    const shown = new Set(y?.kind === "structural" ? (y.targets ?? []).filter((target) => target.check === "view-shows").map((target) => target.sourceId) : []);
    return specified.filter((id) => !shown.has(id));
  };
  /**
   * 4a61133 の段のコード（`semantic-check.ts` を 4a61133 の版に置き戻し、この対を流して取った実測）の束 2 の要求の SHA-256
   * （`JSON.stringify` の要求）。A・B で同じ、A・C（文だけの対）で同じだった
   */
  const BEFORE_741_PAIR = {
    bundle2: "4d2b839a8cd0ea46701925fc1210d8c51773b8e473b4e2265f8fbf341e1b03f4",
    textOnly: "4d2b839a8cd0ea46701925fc1210d8c51773b8e473b4e2265f8fbf341e1b03f4",
  } as const;

  it("(1) 反例の対：X の引用は共通、Y の targets は両入力とも項目 A だけ、X の指定は A＝項目 A・B＝項目 A と B。Y の欠落は A で 0・B で 1。旧コードの束 2 の要求は A・B で同じ（旧の実測の SHA）、新コードは異なり、参照の塊にそれぞれの X の文と所属が入る", async () => {
    const [a, b] = [pairOf("A"), pairOf("B")];
    // 前提：Y 自身の文・引用・所属・確かめ方と表の行は同じ。X の引用も同じ。Y の欠落は A で 0、B で 1
    expect(a.list.requirements.slice(1)).toEqual(b.list.requirements.slice(1));
    expect(a.list.requirements[0]?.quote).toBe(b.list.requirements[0]?.quote);
    expect(a.table.rows).toEqual(b.table.rows);
    expect(a.table.ownership.slice(1)).toEqual(b.table.ownership.slice(1));
    expect(a.table.verification).toEqual(b.table.verification);
    expect(yMissingOf(a.table)).toEqual([]);
    expect(yMissingOf(b.table)).toEqual(["f.item.amount"]);
    const onA = await requestsOf(a);
    const onB = await requestsOf(b);
    expect(onA.requests.map(semanticRequestIds)).toEqual([["R1", "R2", "R3", "R4", "R5"], ["R6"]]);
    expect(onB.requests.map(semanticRequestIds)).toEqual([["R1", "R2", "R3", "R4", "R5"], ["R6"]]);
    // 旧コード：束 2 の要求は A・B で同じ（旧の実測の SHA）。新コードの要求の差は追加分だけ
    expect(await shaOf(revert741(onA.requests[1] as LlmStructuredRequest))).toBe(BEFORE_741_PAIR.bundle2);
    expect(await shaOf(revert741(onB.requests[1] as LlmStructuredRequest))).toBe(BEFORE_741_PAIR.bundle2);
    // 新コード：A・B で要求が異なり、参照の塊にそれぞれの X の文と所属が入る
    expect(JSON.stringify(onA.requests[1])).not.toBe(JSON.stringify(onB.requests[1]));
    for (const [run, variant] of [
      [onA, "A"],
      [onB, "B"],
    ] as const) {
      const reference = referenceOf(run.requests[1]) as { readonly 要件の文と引用: readonly unknown[]; readonly 要件ごとの所属: readonly unknown[] };
      expect(reference.要件の文と引用[0]).toEqual({ requirementId: "R1", text: PAIR_X_TEXT[variant], quote: PAIR_X_QUOTE });
      expect(reference.要件ごとの所属[0]).toEqual({ requirementId: "R1", roles: PAIR_X_OWNERSHIP[variant].map(stated) });
    }
  });

  it("(1') 文だけの対：X の引用・所属と表を固定し、X の文だけを変える。旧コードの束 2 の要求は同じ（旧の実測の SHA）、新コードは異なる", async () => {
    const [a, c] = [pairOf("A"), pairOf("B", true)];
    expect(a.table).toEqual(c.table);
    expect(a.list.requirements.slice(1)).toEqual(c.list.requirements.slice(1));
    expect(a.list.requirements[0]?.quote).toBe(c.list.requirements[0]?.quote);
    expect(a.list.requirements[0]?.text).not.toBe(c.list.requirements[0]?.text);
    const onA = await requestsOf(a);
    const onC = await requestsOf(c);
    expect(await shaOf(revert741(onA.requests[1] as LlmStructuredRequest))).toBe(BEFORE_741_PAIR.textOnly);
    expect(await shaOf(revert741(onC.requests[1] as LlmStructuredRequest))).toBe(BEFORE_741_PAIR.textOnly);
    expect(JSON.stringify(onA.requests[1])).not.toBe(JSON.stringify(onC.requests[1]));
    const reference = referenceOf(onC.requests[1]) as { readonly 要件の文と引用: readonly unknown[] };
    expect(reference.要件の文と引用[0]).toEqual({ requirementId: "R1", text: PAIR_X_TEXT.B, quote: PAIR_X_QUOTE });
  });
});
