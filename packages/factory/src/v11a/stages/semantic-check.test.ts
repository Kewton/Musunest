// T1'' 表の意味の点検（v11a/stages/semantic-check.ts）の試験（Issue #507）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 負例 3 つ（誤った所属・欠けた対象・弱い checks）で、偽物の拒否が種類と引用つきで返り、表の SHA を持つ
//   2. データのどの塊の JSON にも `name` の鍵が無く、試験・期待・合否の塊が無い。J4 の印を渡す
//   3. 判定の欠落・重複・未知の要件 ID・見つからない引用・引用の無い拒否は形の落ちで、2 回続けば `malformed`・calls 2
//   4. `unresolved` の要件は対象にも応答の必須にも無い
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects, ruleTexts } from "../../stages/prompt.js";
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
  semanticEvidenceResponseOf,
  withoutEnumMembership,
  withoutWhenAndNonRequirement,
} from "../__tests__/fixtures.js";
import { deriveCarryOver } from "../carry-over.js";
import { checkNameTable, nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView } from "../../v12/ledger.js";
import {
  SEMANTIC_CHECK_IDS_RULE_ID,
  SEMANTIC_CHECK_IDS_RULE_TEXT,
  SEMANTIC_CHECK_IDS_SCHEMA,
  SEMANTIC_CHECK_LEDGER_RULE_ID,
  SEMANTIC_CHECK_RULE_DEFINITIONS,
  SEMANTIC_CHECK_RULES,
  SEMANTIC_CHECK_SCHEMA,
  SEMANTIC_CHECK_SCHEMA_NAME,
  SEMANTIC_EVIDENCE_MESSAGES,
  SEMANTIC_REJECTION_KINDS,
  checkJudgmentsShape,
  deriveSemanticJudgment,
  quoteSources,
  runSemanticCheck,
  semanticCheckRuleDefinitionsOf,
  semanticCheckTargets,
  type SemanticEvidence,
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

// ── 旗 v12.ids の観点ごとの根拠の契約（Issue #700）────────────────────────────────────
//
// 受理・拒否とも 3 観点（所属・対象・確かめ方）の判定・引用・行 ID を返させ、コードが完全性・引用の実在・行 ID の実在・所属の行の
// 集合との一致を照らしてから、受理／拒否と種類を導く。偽物の LLM で閉じる（配線の検証。モデルの判定の精度の実証ではない）。

describe("旗 v12.ids の C3：観点ごとの根拠の契約（Issue #700）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  type Evidence = Record<string, Record<string, unknown> | string>;

  async function runIds(outputs: readonly unknown[], options: { readonly list?: RequirementList; readonly table?: NameTable; readonly advice?: readonly JudgeAdviceMarkEntry[] } = {}) {
    const list = options.list ?? LIST;
    const table = options.table ?? fixtureTable();
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runSemanticCheck({
      plan: planOf(list),
      list,
      table,
      ...(options.advice === undefined ? {} : { advice: options.advice }),
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      ledger,
      ids: true,
    });
    return { outcome, requests: recording.structured };
  }
  /** 根拠つきの全件受理（examined＝所属の行の全部・present は所属の行・引用は要件の文） */
  const good = (rejects: Readonly<Record<string, readonly [string, string]>> = {}) => semanticEvidenceResponseOf(LIST, fixtureTable(), rejects);
  /** 要件 `id` の判定だけを差し替えた応答 */
  const withJudgment = (id: string, change: (item: Evidence) => Evidence) => ({
    judgments: good().judgments.map((item) => (item["requirementId"] === id ? change(item as Evidence) : item)),
  });
  const perspective = (item: Evidence, key: string) => item[key] as Record<string, unknown>;
  /** 要件 R2 の所属の行（fixture の表のまま） */
  const R2_OWNED = fixtureTable().ownership.find((entry) => entry.requirementId === "R2")!.roles.map((role) => role.id);

  it("規則：ids on の並びは R-sc-04 だけが観点ごとの根拠の文（受理にも根拠・総合の判定を書かない）で、ほかの規則の文と順は直す前と同じ。不備 0（台帳で組み直しても）。off は今の定数", () => {
    const on = semanticCheckRuleDefinitionsOf(ledger, true);
    const ledgerOnly = semanticCheckRuleDefinitionsOf(ledger);
    expect(ruleDefinitionDefects(on)).toEqual([]);
    expect(ruleDefinitionDefects(semanticCheckRuleDefinitionsOf(undefined, true))).toEqual([]);
    expect(on.map((definition) => definition.id)).toEqual(SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) => definition.id));
    for (const [index, definition] of on.entries()) {
      const before = ledgerOnly[index]!;
      if (definition.id === SEMANTIC_CHECK_IDS_RULE_ID) {
        expect(definition.text).toBe(SEMANTIC_CHECK_IDS_RULE_TEXT);
        expect(definition.why).toBe(before.why);
        expect(definition.since.startsWith(before.since)).toBe(true);
        expect(definition.since).toContain("#700");
      } else {
        expect(definition).toEqual(before);
      }
    }
    // 意味：観点ごとの根拠・受理にも根拠・所属は全部・対象は行の ID か missing・確かめ方は決まりの引用か weak・総合の判定を書かない
    for (const phrase of ["受理にも根拠が要る", "examinedRowIds", "unnecessaryRowIds", "presentRowIds", "missing", "weak", "総合の判定と拒否の種類は書かない"]) {
      expect(SEMANTIC_CHECK_IDS_RULE_TEXT, phrase).toContain(phrase);
    }
    expect(SEMANTIC_CHECK_IDS_RULE_TEXT).not.toMatch(/P\d/);
    // 台帳の文で組み直す版の R-sc-02 の頭は同じ。台帳を省いた ids on は R-sc-04 だけが違う
    expect(on.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID)).toEqual(ledgerOnly.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID));
    const plainIds = semanticCheckRuleDefinitionsOf(undefined, true);
    expect(plainIds.filter((definition, index) => JSON.stringify(definition) !== JSON.stringify(SEMANTIC_CHECK_RULE_DEFINITIONS[index])).map((definition) => definition.id)).toEqual([SEMANTIC_CHECK_IDS_RULE_ID]);
    // off（旗 ids を渡さない）は今の定数のまま
    expect(semanticCheckRuleDefinitionsOf()).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(semanticCheckRuleDefinitionsOf(undefined, false)).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expectNoAcceptanceMaterial(ruleTexts(on));
  });

  it("要求：schema は観点ごとの根拠の schema で、データの塊の名前・中身・順と、R-sc-04 を除く規則は ids off の要求と同じ", async () => {
    const recording = createCheckedRecordingClient([structured({ judgments: TARGETS.map(accept) })]);
    await runSemanticCheck({ plan: PLAN, list: LIST, table: fixtureTable(), advice: ADVICE, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(recording.client), ledger });
    const off = recording.structured[0]!;
    const { requests } = await runIds([good()], { advice: ADVICE });
    const on = requests[0]!;
    expect(on.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
    expect(on.schema).toBe(SEMANTIC_CHECK_IDS_SCHEMA);
    expect(off.schema).toBe(SEMANTIC_CHECK_SCHEMA);
    expect(on.input).toBe(off.input);
    expect(on.documents).toEqual(off.documents);
    expect(on.instructions).toBe(off.instructions);
    expect(on.maxOutputTokens).toBe(off.maxOutputTokens);
    const at = SEMANTIC_CHECK_RULE_DEFINITIONS.findIndex((definition) => definition.id === SEMANTIC_CHECK_IDS_RULE_ID);
    expect(on.rules?.[at]).toBe(SEMANTIC_CHECK_IDS_RULE_TEXT);
    expect(on.rules?.filter((_, index) => index !== at)).toEqual(off.rules?.filter((_, index) => index !== at));
    expect(on.rules).toHaveLength(off.rules?.length ?? -1);
    // 名前の欄を見せない（今と同じ）。送るものに受入の題材の言葉が無い
    for (const block of dataBlocks(on.input)) expect(hasKey(JSON.parse(block.text), "name")).toBe(false);
    expectNoAcceptanceMaterial([on.instructions, ...(on.rules ?? []), ...on.documents, on.input]);
  });

  it("(1) 全要件に根拠つきの受理：判定は全部受理（今の形）・持ち越し 0・evidence に要件ごと 3 観点", async () => {
    const { outcome, requests } = await runIds([good()]);
    expect(requests).toHaveLength(1);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.targets).toEqual(TARGETS);
    expect(outcome.value.judgments).toEqual(TARGETS.map((requirementId) => ({ requirementId, verdict: "accept" })));
    expect(outcome.value.evidence?.map((entry) => entry.requirementId)).toEqual(TARGETS);
    for (const entry of outcome.value.evidence ?? []) expect(Object.keys(entry)).toEqual(["requirementId", "ownership", "target", "verification"]);
    expect(outcome.value.evidence).toEqual(good().judgments);
    // 持ち越しは unresolved の R5 だけ（出どころ semantic-check の持ち越しは 0）
    const carry = await deriveCarryOver({ list: LIST, table: fixtureTable(), semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments }, ledger });
    expect(carry.entries.map((entry) => entry.requirementId)).toEqual(["R5"]);
    expect(carry.entries.flatMap((entry) => entry.reasons).filter((reason) => reason.origin === "semantic-check")).toEqual([]);
  });

  it("(2) R3 の unnecessaryRowIds に所属の行 1 つ：R3 は拒否・kind unnecessary-ownership・quote はその観点の引用。持ち越しの理由は今と同じ形", async () => {
    const quote = "締められる";
    const { outcome } = await runIds([good({ R3: ["unnecessary-ownership", quote] })]);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R3")).toEqual({ requirementId: "R3", verdict: "reject", kind: "unnecessary-ownership", quote });
    expect(outcome.value.judgments.filter((judgment) => judgment.verdict === "accept").map((judgment) => judgment.requirementId)).toEqual(["R1", "R2", "R4"]);
    const r3Owned = fixtureTable().ownership.find((entry) => entry.requirementId === "R3")!.roles.map((role) => role.id);
    expect(outcome.value.evidence?.find((entry) => entry.requirementId === "R3")?.ownership.unnecessaryRowIds).toEqual(r3Owned.slice(0, 1));
    const carry = await deriveCarryOver({ list: LIST, table: fixtureTable(), semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments }, ledger });
    expect(carry.entries.find((entry) => entry.requirementId === "R3")).toEqual({ requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] });
  });

  it("(3) R4 で missing と weak の両方：kind は missing-target（固定の順）・quote は対象の観点の引用。evidence に両方", async () => {
    const output = withJudgment("R4", (item) => ({
      ...item,
      target: { ...perspective(item, "target"), verdict: "missing", quote: "区分ごとの件数" },
      verification: { ...perspective(item, "verification"), verdict: "weak", quote: "全体の率" },
    }));
    const { outcome } = await runIds([output]);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R4")).toEqual({ requirementId: "R4", verdict: "reject", kind: "missing-target", quote: "区分ごとの件数" });
    const r4 = outcome.value.evidence?.find((entry) => entry.requirementId === "R4");
    expect(r4?.target.verdict).toBe("missing");
    expect(r4?.verification.verdict).toBe("weak");
  });

  // (4) 旧の形の受理・観点の欠落は schema 違反で、adapter が段の検査の前に断る（openai.test.ts で偽物の fetch に固定）

  /** schema は通る負例（偽の根拠・不完全な点検） */
  const shapeCases: readonly { readonly name: string; readonly output: () => unknown; readonly problem: { readonly field: string; readonly message: string } }[] = [
    ...(["ownership", "target", "verification"] as const).flatMap((key) => [
      {
        name: `(5) ${key} の引用が空`,
        output: () => withJudgment("R1", (item) => ({ ...item, [key]: { ...perspective(item, key), quote: " " } })),
        problem: { field: `judgments[0].${key}.quote`, message: SEMANTIC_EVIDENCE_MESSAGES.quoteEmpty },
      },
      {
        name: `(5) ${key} の引用が確定した仕様にも要件の文にも無い`,
        output: () => withJudgment("R1", (item) => ({ ...item, [key]: { ...perspective(item, key), quote: "どこにも無い文" } })),
        problem: { field: `judgments[0].${key}.quote`, message: SEMANTIC_EVIDENCE_MESSAGES.quoteMissing },
      },
    ]),
    {
      name: "(6) examinedRowIds が所属の行より 1 件少ない",
      output: () => withJudgment("R2", (item) => ({ ...item, ownership: { ...perspective(item, "ownership"), examinedRowIds: R2_OWNED.slice(1) } })),
      problem: { field: "judgments[1].ownership.examinedRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.examinedMissing },
    },
    {
      name: "(6) examinedRowIds に所属の外の行（表には在る）がある",
      output: () => withJudgment("R2", (item) => ({ ...item, ownership: { ...perspective(item, "ownership"), examinedRowIds: [...R2_OWNED, "o.addItem"] } })),
      problem: { field: "judgments[1].ownership.examinedRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.examinedExtra },
    },
    {
      name: "(6) examinedRowIds が重なっている",
      output: () => withJudgment("R2", (item) => ({ ...item, ownership: { ...perspective(item, "ownership"), examinedRowIds: [...R2_OWNED, R2_OWNED[0]] } })),
      problem: { field: "judgments[1].ownership.examinedRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.examinedDuplicate },
    },
    {
      name: "(6) unnecessaryRowIds が点検した行の外",
      output: () => withJudgment("R2", (item) => ({ ...item, ownership: { ...perspective(item, "ownership"), unnecessaryRowIds: ["o.addItem"] } })),
      problem: { field: "judgments[1].ownership.unnecessaryRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.unnecessaryOutside },
    },
    {
      name: "(6) unnecessaryRowIds が重なっている",
      output: () => withJudgment("R2", (item) => ({ ...item, ownership: { ...perspective(item, "ownership"), unnecessaryRowIds: [R2_OWNED[0], R2_OWNED[0]] } })),
      problem: { field: "judgments[1].ownership.unnecessaryRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.unnecessaryDuplicate },
    },
    {
      name: "(7) presentRowIds に表に無い ID",
      output: () => withJudgment("R3", (item) => ({ ...item, target: { ...perspective(item, "target"), presentRowIds: ["x.none"] } })),
      problem: { field: "judgments[2].target.presentRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.presentUnknown },
    },
    {
      name: "(7) presentRowIds が重なっている",
      output: () => withJudgment("R3", (item) => ({ ...item, target: { ...perspective(item, "target"), presentRowIds: ["o.closeItem", "o.closeItem"] } })),
      problem: { field: "judgments[2].target.presentRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.presentDuplicate },
    },
    {
      name: "(8) present で 0 件",
      output: () => withJudgment("R3", (item) => ({ ...item, target: { ...perspective(item, "target"), presentRowIds: [] } })),
      problem: { field: "judgments[2].target.presentRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.presentEmpty },
    },
    {
      name: "(9) 判定が欠けた要件",
      output: () => ({ judgments: good().judgments.slice(1) }),
      problem: { field: "requirements[0]", message: "判定が無い要件がある" },
    },
    {
      name: "(9) 判定が重なっている",
      output: () => ({ judgments: [...good().judgments, good().judgments[1]] }),
      problem: { field: "judgments[4].requirementId", message: "同じ要件の判定が重なっている" },
    },
    {
      name: "(9) 対象の外の要件 ID（unresolved の要件）",
      output: () => ({ judgments: [...good().judgments, { ...(good().judgments[0] as Evidence), requirementId: "R5" }] }),
      problem: { field: "judgments[4].requirementId", message: "要件 ID が点検の対象に無い" },
    },
  ];

  it.each(shapeCases)("$name：schema は通り、段の検査の固定文で落ち、共通の口が 1 回やり直す（要求 2）", async ({ output, problem }) => {
    const passed = await runIds([output(), good()]);
    expect(passed.requests).toHaveLength(2);
    expect(passed.outcome.ok).toBe(true);
    // やり直しの要求に、前回の形の問題として同じ固定文が載る
    expect(passed.requests[1]?.input).toContain(problem.message);
    // (10) 2 回とも落ちれば malformed（attempts 2）で止まる。受理にならない
    const failed = await runIds([output(), output()]);
    expect(failed.requests).toHaveLength(2);
    expect(failed.outcome).toEqual({ ok: false, failure: { kind: "malformed", attempts: 2, problems: [problem] } });
  });

  it("負例：合わない欄を全部挙げる（値は埋めない）。1 判定の 3 観点の問題が全部並ぶ", async () => {
    const output = withJudgment("R2", (item) => ({
      ...item,
      ownership: { ...perspective(item, "ownership"), examinedRowIds: [], quote: "" },
      target: { ...perspective(item, "target"), presentRowIds: ["x.none"] },
      verification: { ...perspective(item, "verification"), quote: "どこにも無い文" },
    }));
    const { outcome } = await runIds([output, output]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(outcome.failure.problems).toEqual([
      { field: "judgments[1].ownership.examinedRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.examinedMissing },
      { field: "judgments[1].ownership.quote", message: SEMANTIC_EVIDENCE_MESSAGES.quoteEmpty },
      { field: "judgments[1].target.presentRowIds", message: SEMANTIC_EVIDENCE_MESSAGES.presentUnknown },
      { field: "judgments[1].verification.quote", message: SEMANTIC_EVIDENCE_MESSAGES.quoteMissing },
    ]);
    expect(JSON.stringify(outcome.failure.problems)).not.toContain("x.none");
  });

  it("(8) 確かめ方が要件でない文（受理で除く性質）の要件は、所属 0 行・present で 0 件でも通り、受理になる", async () => {
    const list = fixtureNonRequirementList();
    const table = fixtureNonRequirementTable();
    const response = semanticEvidenceResponseOf(list, table);
    const r6 = response.judgments.find((item) => item["requirementId"] === "R6") as Evidence;
    expect(perspective(r6, "target")).toMatchObject({ verdict: "present", presentRowIds: [] });
    expect(perspective(r6, "ownership")).toMatchObject({ examinedRowIds: [] });
    const { outcome, requests } = await runIds([response], { list, table });
    expect(requests).toHaveLength(1);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R6")).toEqual({ requirementId: "R6", verdict: "accept" });
  });

  it("(11) 導出の二点：観点に問題の無い根拠は必ず受理、1 観点を変えると拒否（種類は変えた観点）。固定の順は unnecessary-ownership → missing-target → weak-verification", () => {
    const clean: SemanticEvidence = {
      requirementId: "R1",
      ownership: { examinedRowIds: ["f.item.title"], unnecessaryRowIds: [], quote: "題名" },
      target: { verdict: "present", presentRowIds: ["f.item.title"], quote: "題名" },
      verification: { verdict: "sufficient", quote: "登録できる" },
    };
    expect(deriveSemanticJudgment(clean)).toEqual({ requirementId: "R1", verdict: "accept" });
    const unnecessary = { ...clean, ownership: { ...clean.ownership, unnecessaryRowIds: ["f.item.title"], quote: "金額" } };
    const missing = { ...clean, target: { ...clean.target, verdict: "missing" as const, quote: "日付" } };
    const weak = { ...clean, verification: { verdict: "weak" as const, quote: "区分" } };
    expect(deriveSemanticJudgment(unnecessary)).toEqual({ requirementId: "R1", verdict: "reject", kind: "unnecessary-ownership", quote: "金額" });
    expect(deriveSemanticJudgment(missing)).toEqual({ requirementId: "R1", verdict: "reject", kind: "missing-target", quote: "日付" });
    expect(deriveSemanticJudgment(weak)).toEqual({ requirementId: "R1", verdict: "reject", kind: "weak-verification", quote: "区分" });
    // 2 つ以上の観点に問題があれば、固定の順で最初に当たった観点
    expect(deriveSemanticJudgment({ ...unnecessary, target: missing.target, verification: weak.verification })).toMatchObject({ kind: "unnecessary-ownership", quote: "金額" });
    expect(deriveSemanticJudgment({ ...missing, verification: weak.verification })).toMatchObject({ kind: "missing-target", quote: "日付" });
    // 拒否の種類の集合は 3 のまま
    expect([unnecessary, missing, weak].map((entry) => (deriveSemanticJudgment(entry) as { kind: string }).kind)).toEqual([...SEMANTIC_REJECTION_KINDS]);
  });

  it("(12) J4 の印の有無で結果が同じ", async () => {
    const withAdvice = await runIds([good()], { advice: ADVICE });
    const without = await runIds([good()]);
    expect(withAdvice.outcome).toEqual(without.outcome);
  });

  it("B3' と共有する判定の schema と形の検査の関数は、同じ入力で今と同じ結果（ids on の C3 は別の関数）", () => {
    const output = { judgments: [...acceptAll("R1"), reject("R1", "unnecessary-ownership", "題名")] };
    expect(checkJudgmentsShape(output, TARGETS, SEMANTIC_REJECTION_KINDS, quoteSources(PLAN, LIST))).toEqual({
      ok: true,
      value: [{ requirementId: "R1", verdict: "reject", kind: "unnecessary-ownership", quote: "題名" }, ...TARGETS.slice(1).map((requirementId) => ({ requirementId, verdict: "accept" }))],
    });
    expect(SEMANTIC_CHECK_SCHEMA.properties.judgments.items.required).toEqual(["requirementId", "verdict", "kind", "quote"]);
    expect(SEMANTIC_CHECK_IDS_SCHEMA).not.toBe(SEMANTIC_CHECK_SCHEMA);
  });

  it("試験と fixture の固定文に受入の題材の言葉が無い（このファイルと共通の題材の走査）", async () => {
    const fsModule = (await import(/* @vite-ignore */ "node:fs")) as { readFileSync(path: URL, encoding: "utf8"): string };
    const texts = ["./semantic-check.test.ts", "./semantic-check.ts", "../__tests__/fixtures.ts"].map((path) => fsModule.readFileSync(new URL(path, import.meta.url), "utf8"));
    // 走査の言葉の一覧そのものは prompt.ts（試験の道具）にだけある
    expectNoAcceptanceMaterial(texts);
  });
});
