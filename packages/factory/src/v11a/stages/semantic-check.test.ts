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
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView, type UpstreamLedgerView } from "../../v12/ledger.js";
import {
  SEMANTIC_CHECK_IDS_RULE_DEFINITION,
  SEMANTIC_CHECK_LEDGER_RULE_ID,
  SEMANTIC_CHECK_RULE_DEFINITIONS,
  SEMANTIC_CHECK_RULES,
  SEMANTIC_CHECK_SCHEMA,
  SEMANTIC_CHECK_SCHEMA_IDS,
  SEMANTIC_CHECK_SCHEMA_NAME,
  SEMANTIC_GAPS,
  SEMANTIC_NOTE_MAX_CODE_POINTS,
  SEMANTIC_REJECTION_KINDS,
  SEMANTIC_TARGET_KINDS,
  runSemanticCheck,
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

// ── 旗 v12.ids の C3：missing-target の欄（Issue #718）──────────────────────────────

describe("旗 v12.ids の C3：missing-target の 4 つの欄（Issue #718）", () => {
  const IDS_TARGETS = ["R1", "R2", "R3", "R4"];
  /** 受理（ids の schema は 4 つの欄を必須にする） */
  const acceptIds = (requirementId: string) => ({ requirementId, verdict: "accept", kind: null, quote: null, targetKind: null, gap: null, relatedRowIds: [], note: null });
  /** missing-target の拒否（R4 の文の引用） */
  const missing = (extra: Record<string, unknown> = {}) => ({
    requirementId: "R4",
    verdict: "reject",
    kind: "missing-target",
    quote: "区分ごとの件数",
    targetKind: "computation",
    gap: "row-absent",
    relatedRowIds: ["c.byKind"],
    note: "集計の行が無い",
    ...extra,
  });
  const others = () => [acceptIds("R1"), acceptIds("R2"), acceptIds("R3")];

  async function runIds(table: NameTable, outputs: readonly unknown[]) {
    const recording = createCheckedRecordingClient(outputs.map(structured), { idsC3: false });
    const outcome = await runSemanticCheck({
      plan: PLAN,
      list: LIST,
      table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      ids: true,
    });
    return { outcome, requests: recording.structured };
  }

  it("ids の schema は targetKind・gap・relatedRowIds・note を required にし、列挙値はコードの定数と同じ。規則は R-sc-06 を末尾に 1 本だけ足す", () => {
    const items = SEMANTIC_CHECK_SCHEMA_IDS.properties.judgments.items;
    expect(items.required).toEqual(["requirementId", "verdict", "kind", "quote", "targetKind", "gap", "relatedRowIds", "note"]);
    expect(items.properties.targetKind.enum).toEqual([...SEMANTIC_TARGET_KINDS, null]);
    expect(items.properties.gap.enum).toEqual([...SEMANTIC_GAPS, null]);
    expect(items.properties.relatedRowIds).toMatchObject({ type: "array", items: { type: "string" } });
    expect(items.properties.note.type).toEqual(["string", "null"]);
    // 旧の schema は変えない（v1・v1.1a・ids off の C3・B3'）
    expect(SEMANTIC_CHECK_SCHEMA.properties.judgments.items.required).toEqual(["requirementId", "verdict", "kind", "quote"]);
    expect(JSON.stringify(SEMANTIC_CHECK_SCHEMA)).not.toContain("targetKind");
    // 規則：R-sc-01〜05 はそのままで、ids on だけ R-sc-06 が末尾に 1 本増える
    expect(semanticCheckRuleDefinitionsOf()).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    const idsRules = semanticCheckRuleDefinitionsOf(undefined, true);
    expect(idsRules.slice(0, SEMANTIC_CHECK_RULE_DEFINITIONS.length)).toEqual(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(idsRules.at(-1)).toEqual(SEMANTIC_CHECK_IDS_RULE_DEFINITION);
    expect(ruleDefinitionDefects(idsRules)).toEqual([]);
    expect(SEMANTIC_CHECK_IDS_RULE_DEFINITION.id).toBe("R-sc-06");
    for (const value of [...SEMANTIC_TARGET_KINDS, ...SEMANTIC_GAPS]) expect(SEMANTIC_CHECK_IDS_RULE_DEFINITION.text).toContain(value);
    expect(SEMANTIC_CHECK_IDS_RULE_DEFINITION.text).toContain("unknown");
    expect(SEMANTIC_CHECK_IDS_RULE_DEFINITION.text).toContain("判定の理由ではなく記録");
    expect(SEMANTIC_CHECK_IDS_RULE_DEFINITION.text).toContain(String(SEMANTIC_NOTE_MAX_CODE_POINTS));
    // 要求の schema と規則が ids の枝になる
    return runIds(fixtureTable(), [{ judgments: [...others(), missing()] }]).then(({ requests }) => {
      expect(requests[0]?.schema).toBe(SEMANTIC_CHECK_SCHEMA_IDS);
      expect(requests[0]?.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
      expect(requests[0]?.rules).toEqual(idsRules.map((definition) => definition.text));
    });
  });

  it.each(SEMANTIC_GAPS)("gap %s：missing-target の拒否が 4 つの欄つきで記録され、表の SHA に結ぶ", async (gap) => {
    const table = fixtureTable();
    const { outcome, requests } = await runIds(table, [{ judgments: [...others(), missing({ gap })] }]);
    expect(requests).toHaveLength(1);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(table));
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R4")).toEqual(missing({ gap }));
    expect(outcome.value.judgments.filter((judgment) => judgment.verdict === "accept")).toEqual(
      ["R1", "R2", "R3"].map((requirementId) => ({ requirementId, verdict: "accept" })),
    );
  });

  it.each([
    ["表に無い行の ID", { relatedRowIds: ["X99"] }, { field: "judgments[3].relatedRowIds[0]", message: "関わる行の ID が表の行に無い" }],
    ["重複した行の ID", { relatedRowIds: ["c.byKind", "c.byKind"] }, { field: "judgments[3].relatedRowIds[1]", message: "関わる行の ID が重なっている" }],
    ["enum の外の targetKind", { targetKind: "thing" }, { field: "judgments[3].targetKind", message: `欠けた対象の種類は ${SEMANTIC_TARGET_KINDS.join("・")} のいずれかであること` }],
    ["enum の外の gap", { gap: "somewhere" }, { field: "judgments[3].gap", message: `不足の場所は ${SEMANTIC_GAPS.join("・")} のいずれかであること` }],
    ["missing-target なのに targetKind が null", { targetKind: null }, { field: "judgments[3].targetKind", message: `欠けた対象の種類は ${SEMANTIC_TARGET_KINDS.join("・")} のいずれかであること` }],
    ["relatedRowIds が並びでない", { relatedRowIds: null }, { field: "judgments[3].relatedRowIds", message: "関わる既存の行の ID は並び（array）であること" }],
    ["note が文字列でない", { note: null }, { field: "judgments[3].note", message: "説明は文字列であること" }],
    ["note が空", { note: "" }, { field: "judgments[3].note", message: "説明は空白だけでないこと" }],
    ["note が空白だけ", { note: " \n\t " }, { field: "judgments[3].note", message: "説明は空白だけでないこと" }],
  ] as const)("形の落ち：%s（2 回続けば malformed）", async (_label, extra, problem) => {
    const bad = { judgments: [...others(), missing(extra)] };
    const { outcome, requests } = await runIds(fixtureTable(), [negative(bad, "欄の形の負例。strict の schema では出ない応答"), negative(bad, "欄の形の負例")]);
    expect(requests).toHaveLength(2);
    expect(outcome).toEqual({ ok: false, failure: { kind: "malformed", attempts: 2, problems: [problem] } });
  });

  it("受理や missing-target 以外の拒否に欄があると形の落ちになる", async () => {
    const fields = { targetKind: "unknown", gap: "unknown", relatedRowIds: ["c.byKind"], note: "説明" };
    const acceptWithFields = { judgments: [...others().slice(0, 2), acceptIds("R3"), { ...acceptIds("R4"), ...fields }] };
    const rejectedWithFields = {
      judgments: [
        ...others(),
        { requirementId: "R4", verdict: "reject", kind: "unnecessary-ownership", quote: "区分ごとの件数", ...fields },
      ],
    };
    const acceptRun = await runIds(fixtureTable(), [negative(acceptWithFields, "受理に欄がある応答"), negative(acceptWithFields, "受理に欄がある応答")]);
    expect(acceptRun.outcome).toEqual({
      ok: false,
      failure: {
        kind: "malformed",
        attempts: 2,
        problems: [{ field: "judgments[3]", message: "受理の判定の対象の欄（targetKind・gap・relatedRowIds・note）は null・null・空・null であること" }],
      },
    });
    const rejectRun = await runIds(fixtureTable(), [negative(rejectedWithFields, "missing-target 以外の拒否に欄がある応答"), negative(rejectedWithFields, "同じ")]);
    expect(rejectRun.outcome).toEqual({
      ok: false,
      failure: {
        kind: "malformed",
        attempts: 2,
        problems: [{ field: "judgments[3]", message: "拒否（missing-target 以外）の対象の欄（targetKind・gap・relatedRowIds・note）は null・null・空・null であること" }],
      },
    });
  });

  it("note は Unicode のコードポイントで数える：BMP は 200 が通り 201 が落ち、BMP の外も 200 が通り 201 が落ちる", async () => {
    const bmp = "あ";
    const astral = "😀";
    const okBmp = await runIds(fixtureTable(), [{ judgments: [...others(), missing({ note: bmp.repeat(200) })] }]);
    expect(okBmp.outcome.ok).toBe(true);
    const badBmp = await runIds(fixtureTable(), [
      negative({ judgments: [...others(), missing({ note: bmp.repeat(201) })] }, "200 字を超える説明"),
      negative({ judgments: [...others(), missing({ note: bmp.repeat(201) })] }, "同じ"),
    ]);
    expect(badBmp.outcome).toEqual({
      ok: false,
      failure: {
        kind: "malformed",
        attempts: 2,
        problems: [{ field: "judgments[3].note", message: `説明は ${String(SEMANTIC_NOTE_MAX_CODE_POINTS)} 字以下であること（Unicode のコードポイントで数える）` }],
      },
    });
    const okAstral = await runIds(fixtureTable(), [{ judgments: [...others(), missing({ note: astral.repeat(200) })] }]);
    expect(okAstral.outcome.ok).toBe(true);
    const badAstral = await runIds(fixtureTable(), [
      negative({ judgments: [...others(), missing({ note: astral.repeat(201) })] }, "コードポイントで 200 を超える説明"),
      negative({ judgments: [...others(), missing({ note: astral.repeat(201) })] }, "同じ"),
    ]);
    expect(badAstral.outcome.ok).toBe(false);
    if (badAstral.outcome.ok || badAstral.outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(badAstral.outcome.failure.problems).toEqual([{ field: "judgments[3].note", message: `説明は ${String(SEMANTIC_NOTE_MAX_CODE_POINTS)} 字以下であること（Unicode のコードポイントで数える）` }]);
  });

  it("最小の応答（unknown・空の並び・短い説明）が通り、未知の値でも拒否は受理にも除外にもならない", async () => {
    const table = missingTargetTable();
    const { outcome } = await runIds(table, [{ judgments: [...others(), missing({ targetKind: "unknown", gap: "unknown", relatedRowIds: [], note: "不明" })] }]);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R4")).toMatchObject({
      verdict: "reject",
      kind: "missing-target",
      targetKind: "unknown",
      gap: "unknown",
      relatedRowIds: [],
      note: "不明",
    });
    const carry = await deriveCarryOver({ list: LIST, table, semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments } });
    expect(carry.entries).toEqual([
      { requirementId: "R4", reasons: [{ origin: "semantic-check", reason: "missing-target" }] },
      { requirementId: "R5", reasons: [{ origin: "name-table", reason: "宣言で書けない" }] },
    ]);
    // 誤った所属・弱い確かめ方の拒否も、欄の値では変わらない（null・空・null の今の形）
    for (const [variant, requirementId, kind, quote] of [
      [wrongOwnershipTable(), "R1", "unnecessary-ownership", "題名"],
      [weakChecksTable(), "R3", "weak-verification", "金額が 0 より大きい項目だけ"],
    ] as const) {
      const rejection = { requirementId, verdict: "reject", kind, quote, targetKind: null, gap: null, relatedRowIds: [], note: null };
      const run = await runIds(variant, [{ judgments: kind === "unnecessary-ownership" ? [rejection, acceptIds("R2"), acceptIds("R3"), acceptIds("R4")] : [acceptIds("R1"), acceptIds("R2"), rejection, acceptIds("R4")] }]);
      if (!run.outcome.ok) throw new Error("通るはず");
      expect(run.outcome.value.judgments.find((judgment) => judgment.requirementId === requirementId)).toEqual({ requirementId, verdict: "reject", kind, quote });
    }
  });

  it("完全性・引用の照合・表の SHA・拒否の種類の数は今のまま（欄を足しても門を緩めない）", async () => {
    const table = fixtureTable();
    const tableSha = await nameTableSha256(table);
    const missingJudgment = await runIds(table, [
      negative({ judgments: [...others()] }, "判定が 1 件欠けた応答"),
      negative({ judgments: [...others()] }, "判定が 1 件欠けた応答"),
    ]);
    expect(missingJudgment.outcome).toEqual({
      ok: false,
      failure: { kind: "malformed", attempts: 2, problems: [{ field: "requirements[3]", message: "判定が無い要件がある" }] },
    });
    const badQuote = await runIds(table, [
      negative({ judgments: [...others(), missing({ quote: "どこにも無い文" })] }, "見つからない引用の負例"),
      negative({ judgments: [...others(), missing({ quote: "どこにも無い文" })] }, "同じ"),
    ]);
    expect(badQuote.outcome).toEqual({
      ok: false,
      failure: { kind: "malformed", attempts: 2, problems: [{ field: "judgments[3].quote", message: "引用が確定した仕様にも要件の文にも無い" }] },
    });
    const accepted = await runIds(table, [{ judgments: IDS_TARGETS.map(acceptIds) }]);
    if (!accepted.outcome.ok) throw new Error("通るはず");
    expect(accepted.outcome.value.tableSha256).toBe(tableSha);
    expect(accepted.outcome.value.targets).toEqual(IDS_TARGETS);
    expect(SEMANTIC_REJECTION_KINDS).toHaveLength(3);
  });

  it("引用符・改行・データの区切りを含む note でも、JSON と形のやり直しの要求のデータの境界が保たれる", async () => {
    const note = '引用符"と改行\nと区切り</data><data name="x">\n終わり';
    const first = { judgments: [...others(), missing({ relatedRowIds: ["c.byKind", "c.byKind"], note })] };
    const second = { judgments: [...others(), missing()] };
    const { outcome, requests } = await runIds(fixtureTable(), [negative(first, "行の ID が重なる負例（note の境界を見る）"), second]);
    expect(requests).toHaveLength(2);
    const blocks = dataBlocks(requests[1]!.input);
    expect(blocks.map((block) => block.name).slice(-2)).toEqual(["前回の応答", "前回の形の問題"]);
    expect(JSON.parse(blocks.find((block) => block.name === "前回の応答")!.text)).toEqual(first);
    expect(requests[1]!.input).toContain("\\u003c/data>");
    if (!outcome.ok) throw new Error("2 回目で通るはず");
    expect(outcome.value.judgments.find((judgment) => judgment.requirementId === "R4")).toEqual(missing());
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
