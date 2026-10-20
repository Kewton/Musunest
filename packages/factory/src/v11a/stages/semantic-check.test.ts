// T1'' 表の意味の点検（v11a/stages/semantic-check.ts）の試験（Issue #507）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 負例 3 つ（誤った所属・欠けた対象・弱い checks）で、偽物の拒否が種類と引用つきで返り、表の SHA を持つ
//   2. データのどの塊の JSON にも `name` の鍵が無く、試験・期待・合否の塊が無い。J4 の印を渡す
//   3. 判定の欠落・重複・未知の要件 ID・見つからない引用・引用の無い拒否は形の落ちで、2 回続けば `malformed`・calls 2
//   4. `unresolved` の要件は対象にも応答の必須にも無い
//   5. 旗 v12.ids の束（Issue #662）：要件 6 件ごとの束のデータ・束ごとの形の検査の固定文・段全体で通算 1 の形のやり直し・
//      2 束の落ちと枠の使い切りの malformed・合併の順と表の SHA・同時の開始・予算の落ちで一部だけ進まない
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects } from "../../stages/prompt.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  createCheckedRecordingClient,
  negative,
  recordedStructured,
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
} from "../__tests__/fixtures.js";
import { deriveCarryOver } from "../carry-over.js";
import { checkNameTable, nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView } from "../../v12/ledger.js";
import { buildSized } from "../__tests__/sizes.js";
import { JobBudget } from "../../budget.js";
import { CallGateway } from "../../call.js";
import type { LlmClient, LlmStructuredRequest } from "../../llm.js";
import { PREVIOUS_RESPONSE_DATA_NAME, SHAPE_PROBLEMS_DATA_NAME } from "../../stages/prompt.js";
import { V12_C3_BUNDLE } from "../../v12/limits.js";
import {
  SEMANTIC_CHECK_BUNDLE_MESSAGES,
  mapConcurrently,
  runSemanticCheckBundled,
  semanticCheckBundles,
  type SemanticCheckShapeFrame,
  SEMANTIC_CHECK_LEDGER_RULE_ID,
  SEMANTIC_CHECK_RULE_DEFINITIONS,
  SEMANTIC_CHECK_RULES,
  SEMANTIC_CHECK_SCHEMA,
  SEMANTIC_CHECK_SCHEMA_NAME,
  SEMANTIC_REJECTION_KINDS,
  runSemanticCheck,
  semanticCheckRuleDefinitionsOf,
  semanticCheckTargets,
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

// ── 旗 v12.ids の C3 の束（Issue #662）──────────────────────────────────────

describe("旗 v12.ids の C3 の束：要件 6 件ごとに同時に呼び、束ごとに自分の要件の判定の形だけを照らす（Issue #662）", () => {
  /** 要件 N 件（全部が点検の対象）の材料 */
  const sized = (count: number) => buildSized(count, 3 * count);
  /** 要求の「要件の文と引用」の要件 ID */
  const idsOf = (request: LlmStructuredRequest): readonly string[] =>
    (JSON.parse(dataBlocks(request.input).find((block) => block.name === "要件の文と引用")?.text ?? "[]") as readonly { requirementId: string }[]).map(
      (entry) => entry.requirementId,
    );
  /** 束ごとの要求の数（束の頭の要件 ID で引く） */
  const countsOf = (requests: readonly LlmStructuredRequest[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const request of requests) {
      const head = idsOf(request)[0] ?? "";
      counts[head] = (counts[head] ?? 0) + 1;
    }
    return counts;
  };
  /**
   * 束の要件で答える偽物の口（呼ばれた順に関わらず、要求のデータの要件 ID から答えを決める。`call` は同じ束の何回目か）。
   * 開始と応答の順を記録し、応答の前に 1 度タスクを譲る（ほかの束が始まれる）
   */
  function bundleClient(answer: (ids: readonly string[], call: number) => unknown) {
    const requests: LlmStructuredRequest[] = [];
    const events: string[] = [];
    const calls = new Map<string, number>();
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest) {
        requests.push(request);
        const ids = idsOf(request);
        const key = ids.join(",");
        const call = (calls.get(key) ?? 0) + 1;
        calls.set(key, call);
        events.push(`start:${ids[0] ?? ""}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push(`end:${ids[0] ?? ""}`);
        return { output: answer(ids, call) as T, usage: undefined };
      },
      async callWithTools() {
        throw new Error("前提が壊れた：C3 は道具を呼ばない");
      },
    };
    return { client, requests, events };
  }
  const acceptOf = (ids: readonly string[]) => ({ judgments: ids.map(accept) });
  async function runBundled(
    materials: ReturnType<typeof sized>,
    answer: (ids: readonly string[], call: number) => unknown,
    options: { readonly frame?: SemanticCheckShapeFrame; readonly advice?: readonly JudgeAdviceMarkEntry[]; readonly concurrency?: number } = {},
  ) {
    const fake = bundleClient(answer);
    const frame = options.frame ?? { used: false };
    const gateways: CallGateway[] = [];
    const outcome = await runSemanticCheckBundled({
      plan: materials.plan,
      list: materials.list,
      table: materials.table,
      ...(options.advice === undefined ? {} : { advice: options.advice }),
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(fake.client),
      bundleGateway: (bundle) => {
        const made = makeGateway(fake.client);
        gateways[bundle] = made;
        return made;
      },
      ...(options.concurrency === undefined ? {} : { bundleConcurrency: options.concurrency }),
      shapeFrame: frame,
    });
    return { outcome, ...fake, frame, gateways };
  }

  it.each([
    [15, 3],
    [17, 3],
    [25, 5],
    [13, 3],
    [6, 1],
    [4, 1],
  ])("(1) 要件 %i：初回の要求は %i 本。各要求のデータは束の要件（6 件以下）の文・所属・確かめ方・印だけで、表は全行", async (count, bundles) => {
    const materials = sized(count);
    const advice: readonly JudgeAdviceMarkEntry[] = materials.ids.map((requirementId) => ({ requirementId, id: `row-${requirementId}`, mark: "undetermined" as const }));
    const { outcome, requests } = await runBundled(materials, acceptOf, { advice });
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(bundles);
    expect(bundles).toBe(Math.ceil(count / V12_C3_BUNDLE.size));
    const expected = semanticCheckBundles(materials.ids);
    expect(requests.map(idsOf)).toEqual(expected);
    const rows = materials.table.rows.map((row) => row.id);
    requests.forEach((request, index) => {
      const ids = expected[index] ?? [];
      expect(ids.length).toBeLessThanOrEqual(V12_C3_BUNDLE.size);
      const block = (name: string) => JSON.parse(dataBlocks(request.input).find((entry) => entry.name === name)?.text ?? "null") as readonly Record<string, unknown>[];
      expect(block("表の行").map((row) => row["id"])).toEqual(rows);
      for (const name of ["要件ごとの所属", "確かめ方", "助言の印"]) expect(block(name).map((entry) => entry["requirementId"]), name).toEqual(ids);
      // 規則・schema・文書は静的（束によらず同じ）
      expect(request.rules).toEqual(requests[0]?.rules);
      expect(request.schema).toEqual(SEMANTIC_CHECK_SCHEMA);
    });
    expectNoAcceptanceMaterial(requests.map((request) => request.input));
  });

  it("(1') 要件 6 件以下（束 1）の要求とデータは今の runSemanticCheck とバイト列で同じ。形のやり直しの要求も共通の窓口の要求と同じ", async () => {
    const recording = createCheckedRecordingClient([structured({ judgments: TARGETS.slice(1).map(accept) }), structured({ judgments: TARGETS.map(accept) })]);
    const before = await runSemanticCheck({ plan: PLAN, list: LIST, table: fixtureTable(), advice: ADVICE, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(recording.client) });
    const bundled = createCheckedRecordingClient([structured({ judgments: TARGETS.slice(1).map(accept) }), structured({ judgments: TARGETS.map(accept) })]);
    const frame: SemanticCheckShapeFrame = { used: false };
    const after = await runSemanticCheckBundled({
      plan: PLAN,
      list: LIST,
      table: fixtureTable(),
      advice: ADVICE,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(bundled.client),
      shapeFrame: frame,
    });
    expect(bundled.structured).toHaveLength(2);
    expect(JSON.stringify(bundled.structured)).toBe(JSON.stringify(recording.structured));
    if (!before.ok || !after.ok) throw new Error("通るはず");
    expect({ tableSha256: after.value.tableSha256, judgments: after.value.judgments, targets: after.value.targets }).toEqual(before.value);
    expect(after.value.bundleTableSha256s).toEqual([before.value.tableSha256]);
    expect(frame.used).toBe(true);
  });

  const BUNDLE_DEFECTS: readonly [string, (ids: readonly string[], others: readonly string[]) => unknown, string][] = [
    ["欠落", (ids) => ({ judgments: ids.slice(1).map(accept) }), "判定が無い要件がある"],
    ["重複", (ids) => ({ judgments: [...ids.map(accept), accept(ids[0] ?? "")] }), "同じ要件の判定が重なっている"],
    ["別の束の要件 ID", (ids, others) => ({ judgments: [...ids.map(accept), accept(others[0] ?? "")] }), SEMANTIC_CHECK_BUNDLE_MESSAGES.crossBundle],
    ["一覧に無い ID", (ids) => ({ judgments: [...ids.map(accept), accept("R99")] }), "要件 ID が点検の対象に無い"],
    [
      "引用の無い拒否",
      (ids) => ({ judgments: ids.map((id, index) => (index === 0 ? { requirementId: id, verdict: "reject", kind: "missing-target", quote: null } : accept(id))) }),
      "拒否には引用が要る",
    ],
  ];

  it.each(BUNDLE_DEFECTS)("(2) 束 2 の応答の%s は固定文で束 2 だけがやり直され、束 1・3 の要求は増えない", async (_label, defect, message) => {
    const materials = sized(15);
    const bundles = semanticCheckBundles(materials.ids);
    const second = bundles[1] ?? [];
    const others = materials.ids.filter((id) => !second.includes(id));
    const { outcome, requests, frame, gateways } = await runBundled(materials, (ids, call) => (ids[0] === second[0] && call === 1 ? defect(ids, others) : acceptOf(ids)));
    expect(outcome.ok).toBe(true);
    expect(countsOf(requests)).toEqual({ [bundles[0]?.[0] ?? ""]: 1, [second[0] ?? ""]: 2, [bundles[2]?.[0] ?? ""]: 1 });
    // やり直しの要求は束 2 の要件だけで、前回の応答と前回の形の問題（固定文）をデータに持つ
    const retry = requests.at(-1);
    if (retry === undefined) throw new Error("前提が壊れた：やり直しの要求が無い");
    expect(idsOf(retry)).toEqual(second);
    const problems = JSON.parse(dataBlocks(retry.input).find((block) => block.name === SHAPE_PROBLEMS_DATA_NAME)?.text ?? "[]") as readonly { message: string }[];
    expect(problems.map((problem) => problem.message)).toContain(message);
    expect(dataBlocks(retry.input).some((block) => block.name === PREVIOUS_RESPONSE_DATA_NAME)).toBe(true);
    // 形のやり直しを段全体の枠で使い、束 2 の口へ形の再試行として告げた
    expect(frame.used).toBe(true);
    expect(gateways.map((gateway) => gateway.counts.retries.shape)).toEqual([0, 1, 0]);
  });

  it("(3) 2 束が同じ回で形に落ちれば、追加の要求なく malformed（束の位置つきの固定文）", async () => {
    const materials = sized(15);
    const bundles = semanticCheckBundles(materials.ids);
    const broken = new Set([bundles[1]?.[0], bundles[2]?.[0]]);
    const { outcome, requests, frame } = await runBundled(materials, (ids) => (broken.has(ids[0]) ? { judgments: ids.slice(1).map(accept) } : acceptOf(ids)));
    expect(requests).toHaveLength(3);
    expect(frame.used).toBe(false);
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "malformed",
        attempts: 1,
        problems: [
          { field: "bundles[1].requirements[0]", message: "判定が無い要件がある" },
          { field: "bundles[2].requirements[0]", message: "判定が無い要件がある" },
        ],
      },
    });
  });

  it("(3') 枠を使った走り（初回で形のやり直しを使った）で再点検の束が形に落ちれば、追加の要求なく malformed", async () => {
    const materials = sized(15);
    const bundles = semanticCheckBundles(materials.ids);
    const { outcome, requests } = await runBundled(materials, (ids) => (ids[0] === bundles[0]?.[0] ? { judgments: ids.slice(1).map(accept) } : acceptOf(ids)), {
      frame: { used: true },
    });
    expect(requests).toHaveLength(3);
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "malformed", attempts: 1 } });
  });

  it("(3'') やり直した束がまた形に落ちれば、追加の要求なく malformed（試行 2）", async () => {
    const materials = sized(15);
    const bundles = semanticCheckBundles(materials.ids);
    const { outcome, requests } = await runBundled(materials, (ids) => (ids[0] === bundles[1]?.[0] ? { judgments: ids.slice(1).map(accept) } : acceptOf(ids)));
    expect(requests).toHaveLength(4);
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "malformed", attempts: 2, problems: [{ field: "bundles[1].requirements[0]", message: "判定が無い要件がある" }] },
    });
  });

  it("(4) 合併した判定は全対象にちょうど 1 つずつ・一覧の順で、束ごとの表の SHA は表の SHA。1 束の判定を落とし続ければ受理で埋めず malformed", async () => {
    const materials = sized(25);
    const quote = materials.textOf("R8");
    const { outcome, events } = await runBundled(materials, (ids) => ({
      // 束の中では逆順に返しても、合併は一覧の順
      judgments: [...ids].reverse().map((id) => (id === "R8" ? reject(id, "missing-target", quote) : accept(id))),
    }));
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.map((judgment) => judgment.requirementId)).toEqual(materials.ids);
    expect(outcome.value.targets).toEqual(materials.ids);
    expect(outcome.value.judgments.filter((judgment) => judgment.verdict === "reject")).toEqual([{ requirementId: "R8", verdict: "reject", kind: "missing-target", quote }]);
    const sha = await nameTableSha256(materials.table);
    expect(outcome.value.tableSha256).toBe(sha);
    expect(outcome.value.bundleTableSha256s).toEqual(Array.from({ length: 5 }, () => sha));
    // (5) 偽物の口が記録した開始の順：束 5 の開始がどの応答よりも前（同時に始めた）
    const lastStart = events.lastIndexOf(`start:R25`);
    expect(lastStart).toBe(4);
    expect(events.findIndex((event) => event.startsWith("end:"))).toBeGreaterThan(lastStart);

    const dropped = await runBundled(materials, (ids) => (ids.includes("R8") ? { judgments: ids.filter((id) => id !== "R8").map(accept) } : acceptOf(ids)));
    expect(dropped.outcome.ok).toBe(false);
    expect(dropped.outcome).toMatchObject({ ok: false, failure: { kind: "malformed" } });
  });

  it("(5') 同時数 1 では束を 1 つずつ（前の束の応答のあとに次の束を）始め、判定は同時の走りと深く等しい", async () => {
    const materials = sized(15);
    const together = await runBundled(materials, acceptOf);
    const serial = await runBundled(materials, acceptOf, { concurrency: 1 });
    expect(serial.events).toEqual(["start:R1", "end:R1", "start:R7", "end:R7", "start:R13", "end:R13"]);
    expect(together.events.slice(0, 3)).toEqual(["start:R1", "start:R7", "start:R13"]);
    expect(serial.outcome).toEqual(together.outcome);
  });

  it("(8) 1 束だけ予算で始められなくても、残りの束の判定を採用して進まない（段の失敗は budget）。予算 0 なら全束が budget で始まらない", async () => {
    const materials = sized(15);
    const fake = bundleClient(acceptOf);
    const zero = (budgetUsd: number) => makeGateway(fake.client, { budgetUsd });
    const partly = await runSemanticCheckBundled({
      plan: materials.plan,
      list: materials.list,
      table: materials.table,
      documents: FIXTURE_DOCUMENTS,
      gateway: zero(10),
      bundleGateway: (bundle) => zero(bundle === 1 ? 0 : 10),
      shapeFrame: { used: false },
    });
    expect(partly).toMatchObject({ ok: false, failure: { kind: "budget" } });
    expect(fake.requests).toHaveLength(2);

    const none = bundleClient(acceptOf);
    const gateways: CallGateway[] = [];
    const shared = new JobBudget(0);
    const all = await runSemanticCheckBundled({
      plan: materials.plan,
      list: materials.list,
      table: materials.table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(none.client),
      bundleGateway: (bundle) => {
        gateways[bundle] = new CallGateway({ client: none.client, budget: shared, rates: { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 }, now: () => 0, deadline: 60_000 });
        return gateways[bundle] as CallGateway;
      },
      shapeFrame: { used: false },
    });
    expect(all).toMatchObject({ ok: false, failure: { kind: "budget" } });
    expect(none.requests).toHaveLength(0);
    expect(gateways.map((gateway) => gateway.counts.attempts.not_started.budget)).toEqual([1, 1, 1]);
  });

  it("対象 0 件（全件が unresolved）なら呼ばずに空の結果（今と同じ）", async () => {
    const table = fixtureTable();
    const allUnresolved: NameTable = {
      ...table,
      verification: table.verification.map((entry) => ({ requirementId: entry.requirementId, kind: "unresolved" as const, reason: "宣言で書けない", constraintIds: ["外部への通知"] })),
    };
    const fake = bundleClient(acceptOf);
    const outcome = await runSemanticCheckBundled({ plan: PLAN, list: LIST, table: allUnresolved, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(fake.client), shapeFrame: { used: false } });
    expect(fake.requests).toHaveLength(0);
    expect(outcome).toEqual({ ok: true, value: { tableSha256: await nameTableSha256(allUnresolved), judgments: [], targets: [], bundleTableSha256s: [] } });
  });

  it("束に切る部品：一覧の順で 6 件ごと（最後は 6 未満）。大きさは 1 以上の整数。同時に走らせる部品は結果を並びの順で返す", async () => {
    expect(semanticCheckBundles(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(semanticCheckBundles([])).toEqual([]);
    expect(() => semanticCheckBundles(["a"], 0)).toThrow(RangeError);
    expect(await mapConcurrently([3, 1, 2], 2, async (value) => value * 10)).toEqual([30, 10, 20]);
  });
});
