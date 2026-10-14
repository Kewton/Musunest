// ② 設計する（stages/design.ts）の unit テスト（02 §1・F-4・F-5・Issue #307）。
import { describe, expect, it } from "vitest";
import { JobBudget, estimateMaxCostUsd } from "../budget.js";
import { CallGateway, estimateInputUpperBoundTokens, structuredInputParts } from "../call.js";
import { maxOutputTokensForEffort } from "../limits.js";
import type { LlmClient, LlmStructuredRequest } from "../llm.js";
import type { DesignResult, RequirementDesign, RequirementList, RoleEntry } from "../pipeline.js";
import { LEGACY_DESIGN_CONTRACT } from "../pipeline.js";
import {
  DESIGN_ROUNDS,
  DESIGN_RULE_DEFINITIONS,
  DESIGN_RULES,
  DESIGN_SCHEMA,
  DESIGN_SCHEMA_NAME,
  REDO_DESIGN_FIXED_TABLE_DEFINITION,
  REDO_DESIGN_FIXED_TABLE_RULE,
  checkDesignConstraints,
  checkDesignOutput,
  checkDesignPlan,
  checkGroupBy,
  isPlannedDesign,
  runDesign,
  type DesignInput,
} from "./design.js";
import { buildStructuredRequest, ruleDefinitionDefects, ruleTexts, serializeJson } from "./prompt.js";
import {
  DESIGN_OUTPUT,
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 試験の共通の口と同じ単価（予約の見積もりを、段とすり合わせるのに使う） */
const RATES = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

/** 抽象的な役割 ID の表（entity の文脈を含む ID。共有・別名は明示の欄でだけ許す。新契約） */
const PLANNED_ROLES = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
];

/** R-1 の所属（役割の表の役割をすべて覆う。新契約） */
const OWNERSHIP_R1 = [
  { roleId: "record", basis: "dependency", reason: "記録の行を参照するため" },
  { roleId: "record.amount", basis: "dependency", reason: "入力の行に保存する項目として参照するため" },
  { roleId: "record.total", basis: "stated", reason: null },
];

/** 役割 ID の表・種類・確かめ方・所属を備えた設計（本番の応答の形） */
const PLANNED_DESIGN = {
  roles: PLANNED_ROLES,
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test", reason: null },
      vocabulary: ["記録"],
      placement: ["entities[].fields"],
      unwritable: [],
      ownership: OWNERSHIP_R1,
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけなので構造で確かめる" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [],
    },
  ],
};

/** 形を通したうえで、中身の点検を掛ける（本番では `runDesign` が自動で掛ける。新契約） */
function planned(value: unknown): { readonly design: DesignResult; readonly problems: readonly string[] } {
  const checked = checkDesignOutput(value);
  if (!checked.ok) throw new Error(`前提（形）が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return {
    design: checked.value,
    problems: checkDesignPlan(REQUIREMENT_LIST, checked.value).map((problem) => problem.message),
  };
}

/** 旧形式の設計を、**互換を明示して**形と中身（旧来の規則）に掛ける（決定 ⑨・Issue #418） */
function legacyPlanned(value: unknown): { readonly design: DesignResult; readonly problems: readonly string[] } {
  const checked = checkDesignOutput(value, LEGACY_DESIGN_CONTRACT);
  if (!checked.ok) throw new Error(`前提（形）が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return {
    design: checked.value,
    problems: checkDesignPlan(REQUIREMENT_LIST, checked.value, LEGACY_DESIGN_CONTRACT).map(
      (problem) => problem.message,
    ),
  };
}

/** 1 つの effort で ② を回し、送った要求の出力の上限を読む */
async function maxOutputTokensAt(effort: string): Promise<number> {
  const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
  await runDesign({
    list: REQUIREMENT_LIST,
    documents: SAMPLE_DOCUMENTS,
    gateway: makeGateway(recording.client, { maxAttempts: 1, effort }),
  });
  const request = recording.structured[0];
  if (request === undefined) throw new Error("要求が記録されていません");
  return request.maxOutputTokens;
}

describe("② が送る要求を観測する（02 §2.2）", () => {
  it("要件の一覧だけをデータに置き、JSON Schema を付け、規則とデータを分ける", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      version: LEGACY_DESIGN_CONTRACT,
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // データは要件の一覧の 1 つだけ（宣言は渡さない）
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
    expect(request.input).toContain("要件の一覧");
    expect(request.instructions).not.toContain("要件の一覧");
    expect(request.schemaName).toBe(DESIGN_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("要件の文に仕込んだ「規則を無視せよ」も、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    const list = {
      requirements: [
        { id: "R-1", text: `タスクを記録できる。${INJECTED_INSTRUCTION}`, quote: "タスクを記録する", position: { start: 0, end: 8 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const outcome = await runDesign({
      list,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      version: LEGACY_DESIGN_CONTRACT,
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("宣言を渡そうとしても（余分な欄は）データに入らない", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    const withDeclaration = {
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      declaration: "DECLARATION_SENTINEL",
    } as unknown as DesignInput;
    await runDesign(withDeclaration);
    const request = recording.structured[0];
    expect(request?.input).not.toContain("DECLARATION_SENTINEL");
    expect(request?.instructions).not.toContain("DECLARATION_SENTINEL");
  });
});

describe("② の出力の上限は effort ごとに、共通の置き場所から取る（02 §1.5・§2）", () => {
  it("effort high の上限は、medium 以上である", async () => {
    const high = await maxOutputTokensAt("high");
    const medium = await maxOutputTokensAt("medium");
    expect(high).toBeGreaterThanOrEqual(medium);
  });

  it("送る要求の上限は、共通の置き場所（maxOutputTokensForEffort）と一致する", async () => {
    expect(await maxOutputTokensAt("medium")).toBe(maxOutputTokensForEffort("medium", "design"));
    expect(await maxOutputTokensAt("high")).toBe(maxOutputTokensForEffort("high", "design"));
  });
});

describe("② の形の確認", () => {
  it("正しい応答は固定できる", () => {
    expect(checkDesignOutput(PLANNED_DESIGN).ok).toBe(true);
  });

  it("欄の形が合わなければ、欄つきで断る", () => {
    const bad = checkDesignOutput({
      designs: [{ requirementId: "", vocabulary: "nope", placement: [1], unwritable: [] }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("designs[0].requirementId");
    expect(fields).toContain("designs[0].vocabulary");
    expect(fields).toContain("designs[0].placement[0]");
  });

  it("設計の並びでなければ断る", () => {
    expect(checkDesignOutput({ designs: {} }).ok).toBe(false);
    expect(checkDesignOutput(null).ok).toBe(false);
  });
});

describe("② の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ designs: "nope" }), structured({ designs: "nope" })]);
    const failed = await runDesign({
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");

    const recovered = createRecordingClient([structured({ designs: "nope" }), structured(DESIGN_OUTPUT)]);
    const retried = await runDesign({
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recovered.client),
      version: LEGACY_DESIGN_CONTRACT,
    });
    expect(retried.ok).toBe(true);
  });
});

// ── 役割 ID の表・種類・確かめ方（Issue #307）────────────────────

describe("役割 ID の表・種類・確かめ方は必須で、旧形式の記録は後方互換で通す（Issue #307）", () => {
  it("旧形式の設計（役割 ID の表も種類も無い）は、② が受け入れる（後方互換を明示する）", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      version: LEGACY_DESIGN_CONTRACT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isPlannedDesign(outcome.value)).toBe(false);
  });

  it("旧形式の設計は、形の確認は通るが、中身の点検は必須の欄（種類・確かめ方）を求める", () => {
    const checked = checkDesignOutput(DESIGN_OUTPUT, LEGACY_DESIGN_CONTRACT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(isPlannedDesign(checked.value)).toBe(false);
    expect(checkDesignPlan(REQUIREMENT_LIST, checked.value, LEGACY_DESIGN_CONTRACT).length).toBeGreaterThan(0);
  });

  it("役割 ID の表・種類・確かめ方を備えた設計は、形も中身も通す", () => {
    const checked = checkDesignOutput(PLANNED_DESIGN);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(isPlannedDesign(checked.value)).toBe(true);
    expect(checked.value.roles).toHaveLength(3);
    expect(checked.value.designs[0]?.nature).toBe("ruled");
    expect(checked.value.designs[0]?.verification).toEqual({ kind: "fixed-test" });
    expect(checked.value.designs[1]?.verification).toEqual({
      kind: "structural",
      reason: "在ることだけなので構造で確かめる",
    });
    expect(checkDesignPlan(REQUIREMENT_LIST, checked.value)).toEqual([]);
  });

  it("確かめ方の欠けた要件 ID があれば断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        { requirementId: "R-2", nature: "existence-only", vocabulary: [], placement: [], unwritable: [], ownership: [] },
      ],
    };
    const { problems } = planned(bad);
    // 問題の文は固定文で、位置は field の添字（requirements[1]）で示す（要件 ID の値を埋めない。Issue #445）
    expect(problems.some((message) => message.includes("確かめ方"))).toBe(true);
    expect(problems.some((message) => message.includes("R-2"))).toBe(false);
  });

  it("種類（nature）の欠けた要件 ID があれば断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        {
          requirementId: "R-2",
          verification: { kind: "structural", reason: "構造で確かめる" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [],
        },
      ],
    };
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("種類"))).toBe(true);
    expect(problems.some((message) => message.includes("R-2"))).toBe(false);
  });

  it("役割 ID の表が無ければ、新契約の形の確認で断る", () => {
    const bad = { designs: PLANNED_DESIGN.designs };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("roles");
  });

  it("fixed-test 以外の確かめ方に理由が無ければ、形の確認で断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        { requirementId: "R-2", nature: "existence-only", verification: { kind: "unresolved", reason: "" }, vocabulary: [], placement: [], unwritable: [], ownership: [] },
      ],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("designs[1].verification.reason");
  });

  it("種類が知らない値なら断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [{ ...PLANNED_DESIGN.designs[0], nature: "nope" }, PLANNED_DESIGN.designs[1]],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("designs[0].nature");
  });

  it("中身の点検に合わない設計を 2 回送ると、② は未達として断る（作り直しても直らない）", async () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        { requirementId: "R-2", nature: "existence-only", vocabulary: [], placement: [], unwritable: [], ownership: [] },
      ],
    };
    const recording = createRecordingClient([structured(bad), structured(bad)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
  });
});

describe("同名の対象は、共有と別名を明示したときだけ分ける（Issue #307）", () => {
  it("同名の別 entity を同じ役割 ID にしたら断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "name", kind: "field", entity: "member", name: "name", shared: false, aliasOf: null },
        { roleId: "name", kind: "field", entity: "session", name: "name", shared: false, aliasOf: null },
      ],
    };
    const { problems } = legacyPlanned(bad);
    expect(problems.some((message) => message.includes("同名の別 entity"))).toBe(true);
  });

  it("同名の対象を、共有も別名も明示せずに複数の役割 ID にしたら断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
        { roleId: "record.sum", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
      ],
    };
    const { problems } = legacyPlanned(bad);
    expect(problems.some((message) => message.includes("同じ名前"))).toBe(true);
    expect(problems.some((message) => message.includes("total"))).toBe(false);
  });

  it("共有（shared）を明示すれば、同名の対象を複数の役割 ID にできる", () => {
    const ok = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null },
        { roleId: "record.sum", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null },
      ],
    };
    expect(legacyPlanned(ok).problems).toEqual([]);
  });

  it("別名（aliasOf）を明示すれば、同名の対象を複数の役割 ID にできる", () => {
    const ok = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
        { roleId: "record.sum", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: "record.total" },
      ],
    };
    expect(legacyPlanned(ok).problems).toEqual([]);
  });
});

// ── 「書けない」の根拠（制約 ID）と、曖昧さを分ける notes（Issue #332）──────

/** 文書にある語彙の意味の見出しを根拠にした、書けない部分の申告（新形式） */
const VALID_CLAIM = {
  part: "アプリ自体の名前・説明",
  constraintIds: ["アプリの名前・説明"],
  reason: "宣言には、アプリ自体の名前や説明を置く欄が無い。",
};

/** 新形式（unwritable の要素が「部分・制約 ID・理由」の組。notes を持つ）の設計 */
const CLAIM_DESIGN = {
  roles: PLANNED_ROLES,
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["記録"],
      placement: ["entities[].fields"],
      unwritable: [VALID_CLAIM],
      notes: [],
      ownership: OWNERSHIP_R1,
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけなので構造で確かめる" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      notes: ["件数の数え方を決めずに残した（曖昧さのメモ）"],
      ownership: [],
    },
  ],
};

/**
 * 1 つの設計を ② に流し、結果を返す（本番と同じく、形と中身と根拠を確かめる）。中身の点検に
 * 合わなければもう 1 回作り直すので、**既定では同じ応答を 2 回**渡す（やり直しで直る例は `redo` を渡す）。
 */
async function designOutcome(value: unknown, redo: unknown = value) {
  const recording = createRecordingClient([structured(value), structured(redo)]);
  return runDesign({
    list: REQUIREMENT_LIST,
    documents: SAMPLE_DOCUMENTS,
    gateway: makeGateway(recording.client, { maxAttempts: 1 }),
  });
}

describe("「書けない」の根拠（制約 ID）と、曖昧さを分ける notes（Issue #332）", () => {
  it("制約 ID の無い unwritable は断る（形は通るが、根拠が無い）", async () => {
    const bad = {
      ...CLAIM_DESIGN,
      designs: [{ ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: [] }] }, CLAIM_DESIGN.designs[1]],
    };
    // 形の確認は通る（写像で、部分・制約 ID・理由の欄がある）
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // 根拠（制約 ID）が無いので、コードの点検が断る
    const problems = checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS);
    expect(problems.some((problem) => problem.field.includes("constraintIds"))).toBe(true);

    const outcome = await designOutcome(bad);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
  });

  it("文書に無い制約 ID を使った unwritable は断る", async () => {
    const bad = {
      ...CLAIM_DESIGN,
      designs: [
        { ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: ["R-999"] }] },
        CLAIM_DESIGN.designs[1],
      ],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const problems = checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS);
    // 問題の文は固定文（文書に無い制約 ID の値も埋めない。Issue #445）
    expect(problems.some((problem) => problem.message === "文書に無い制約 ID である")).toBe(true);
    expect(problems.some((problem) => problem.message.includes("R-999"))).toBe(false);

    const outcome = await designOutcome(bad);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
  });

  it("契約の規則の R-… も、制約 ID として使える", () => {
    const design = {
      ...CLAIM_DESIGN,
      designs: [
        { ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: ["R-1"] }] },
        CLAIM_DESIGN.designs[1],
      ],
    };
    const checked = checkDesignOutput(design);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS)).toEqual([]);
  });

  it("曖昧さを notes に書いた設計を受け取り、notes を保つ", async () => {
    const outcome = await designOutcome(CLAIM_DESIGN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 書けない部分（語彙の穴）は、根拠つきで残る
    expect(outcome.value.designs[0]?.unwritableClaims).toEqual([VALID_CLAIM]);
    // 曖昧さは notes に入り、書けない部分には混ざらない
    expect(outcome.value.designs[1]?.notes).toEqual(["件数の数え方を決めずに残した（曖昧さのメモ）"]);
    expect(outcome.value.designs[1]?.unwritableClaims).toEqual([]);
  });

  it("notes だけがある要件は、設計として受け取れる（形の確認で断らない）", () => {
    const checked = checkDesignOutput(
      {
        designs: [
          { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [], notes: ["曖昧さのメモ"] },
        ],
      },
      LEGACY_DESIGN_CONTRACT,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.designs[0]?.notes).toEqual(["曖昧さのメモ"]);
    expect(checked.value.designs[0]?.unwritableClaims).toEqual([]);
  });
});

// ── 構造の要件の checks（Issue #386）────────────────────────────

/** 構造の要件（checks 付き）を持つ設計 */
const STRUCTURAL_DESIGN = {
  roles: PLANNED_ROLES,
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: ["記録"],
      placement: ["entities[].fields"],
      unwritable: [],
      ownership: OWNERSHIP_R1,
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "構造で確かめる" },
      checks: ["action-kind", "action-unconditioned"],
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [],
    },
  ],
};

describe("構造の要件の checks（Issue #386）", () => {
  it("構造の要件の checks を受け付け、中身を保つ", () => {
    const checked = checkDesignOutput(STRUCTURAL_DESIGN);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.designs[1]?.checks).toEqual(["action-kind", "action-unconditioned"]);
    expect(checked.value.designs[0]?.checks).toEqual([]);
  });

  it("選択肢に無い中身を断る", () => {
    const bad = {
      ...STRUCTURAL_DESIGN,
      designs: [STRUCTURAL_DESIGN.designs[0], { ...STRUCTURAL_DESIGN.designs[1], checks: ["nope"] }],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("designs[1].checks[0]");
  });

  it("重なった中身を断る", () => {
    const bad = {
      ...STRUCTURAL_DESIGN,
      designs: [STRUCTURAL_DESIGN.designs[0], { ...STRUCTURAL_DESIGN.designs[1], checks: ["action-kind", "action-kind"] }],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.some((problem) => problem.message.includes("重なっている"))).toBe(true);
  });

  it("構造で確かめるのに checks が空なら断る", () => {
    const bad = {
      ...STRUCTURAL_DESIGN,
      designs: [STRUCTURAL_DESIGN.designs[0], { ...STRUCTURAL_DESIGN.designs[1], checks: [] }],
    };
    const checked = checkDesignOutput(bad);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("designs[1].checks");
  });

  it("checks の無い古い応答は受け付ける（後方互換）", () => {
    const checked = checkDesignOutput(PLANNED_DESIGN);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.designs[1]?.checks).toBeUndefined();
  });

  it("checks の欄が並びでなければ断る", () => {
    const bad = {
      ...STRUCTURAL_DESIGN,
      designs: [STRUCTURAL_DESIGN.designs[0], { ...STRUCTURAL_DESIGN.designs[1], checks: "nope" }],
    };
    expect(checkDesignOutput(bad).ok).toBe(false);
  });

  it("設計の規則に、構造で確かめるときの checks の決まりがある", () => {
    expect(DESIGN_RULES.some((rule) => rule.includes("checks"))).toBe(true);
  });

  it("checks に write-anonymous を受け付ける（Issue #393）", () => {
    const value = {
      ...STRUCTURAL_DESIGN,
      designs: [
        STRUCTURAL_DESIGN.designs[0],
        {
          ...STRUCTURAL_DESIGN.designs[1],
          checks: ["action-kind", "action-unconditioned", "write-anonymous"],
        },
      ],
    };
    const checked = checkDesignOutput(value);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.designs[1]?.checks).toEqual(["action-kind", "action-unconditioned", "write-anonymous"]);
  });

  it("設計の規則に、誰でも行える操作を構造で確かめる 3 文がある（Issue #393）", () => {
    expect(
      DESIGN_RULES.some(
        (rule) =>
          rule.includes("誰でも行える") &&
          rule.includes("action-kind") &&
          rule.includes("action-unconditioned") &&
          rule.includes("write-anonymous"),
      ),
    ).toBe(true);
    expect(DESIGN_RULES.some((rule) => rule.includes("書き換えの結果") && rule.includes("structural にしない"))).toBe(
      true,
    );
    expect(
      DESIGN_RULES.some(
        (rule) => rule.includes("権限") && rule.includes("本人確認") && rule.includes("write-anonymous"),
      ),
    ).toBe(true);
  });
});

// ── 設計の段が要件の範囲を広げない（§1・②・Issue #391）────────────────

describe("設計の段が要件の範囲を広げない（Issue #391）", () => {
  it("出どころが答えの要件を、問いが対象にした範囲にだけ当てる文がある", () => {
    expect(
      DESIGN_RULES.some(
        (rule) => rule.includes("範囲にだけ当てる") && rule.includes("役割 ID の表に足さない"),
      ),
    ).toBe(true);
  });

  it("参考の文脈を新しい要件にせず、確定した要件の文と有効な parts を優先する文がある", () => {
    expect(
      DESIGN_RULES.some((rule) => rule.includes("参考の文脈") && rule.includes("確定した要件の文")),
    ).toBe(true);
  });
});

// ── 計測で断られた形が通り、門は緩めない（Issue #398）──────────────────

describe("計測で断られた形が通り、門は緩めない（Issue #398）", () => {
  /** 根拠の制約 ID だけを差し替えた設計（新形式）を作る */
  const withConstraintIds = (ids: readonly string[]) => ({
    ...CLAIM_DESIGN,
    designs: [
      { ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: ids }] },
      CLAIM_DESIGN.designs[1],
    ],
  });

  it("実物の ID（R-VOCAB-01・R-TYPE-07・R-NAME-10）と記号つきの見出し（### computed・### 宣言の全体）が通る", async () => {
    const outcome = await designOutcome(
      withConstraintIds(["R-VOCAB-01", "R-TYPE-07", "R-NAME-10", "### computed", "### 宣言の全体"]),
    );
    expect(outcome.ok).toBe(true);
  });

  it("正規化して重なった ID は 1 つになり、申告に残す ID も正規化後になる", async () => {
    const outcome = await designOutcome(withConstraintIds(["### computed", "`computed`", "computed"]));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.designs[0]?.unwritableClaims[0]?.constraintIds).toEqual(["computed"]);
  });

  it("文書に無い ID と、正規化しても知らない ID は今までどおり断る", () => {
    for (const id of ["R-999", "### ### computed", "#### nope", "`computed", "computed`"]) {
      const checked = checkDesignOutput(withConstraintIds([id]));
      expect(checked.ok, id).toBe(true);
      if (!checked.ok) continue;
      expect(checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS).length, id).toBeGreaterThan(0);
    }
  });

  it("旧形式（R-1 の形）は、文書にあるときだけ通り、無いときは断る", () => {
    const checked = checkDesignOutput(withConstraintIds(["R-1"]));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS)).toEqual([]);
    expect(
      checkDesignConstraints(checked.value, [{ name: "契約", text: "R-TYPE-01 だけがある。" }]).length,
    ).toBeGreaterThan(0);
  });

  it("規則の文と断る文言に、記号つき（### ）の例が無い", async () => {
    for (const rule of DESIGN_RULES) expect(rule).not.toContain("### ");
    const outcome = await designOutcome(withConstraintIds([]));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    for (const problem of outcome.failure.problems) expect(problem.message).not.toContain("### ");
  });
});

// ── 中身の作り直し（1 回。Issue #407）──────────────────────────────

/** 形の誤りの応答（JSON Schema に合わない） */
const MALFORMED_DESIGN = { designs: "nope" };

/** 設計の欠けた応答（R-2 の設計が無い。形は正しい） */
const DESIGN_MISSING_R2 = { roles: PLANNED_ROLES, designs: [PLANNED_DESIGN.designs[0]] };

/** 制約 ID だけが誤った設計（R-1 の申告が、文書に無い R-999 を根拠にする） */
const DESIGN_BAD_CONSTRAINT = {
  roles: PLANNED_ROLES,
  designs: [
    { ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: ["R-999"] }] },
    CLAIM_DESIGN.designs[1],
  ],
};

/** 欠けと制約 ID の誤りが同時にある設計（R-2 の設計が無く、R-1 の申告が R-999 を根拠にする） */
const DESIGN_MISSING_AND_BAD_CONSTRAINT = {
  roles: PLANNED_ROLES,
  designs: [{ ...CLAIM_DESIGN.designs[0], unwritable: [{ ...VALID_CLAIM, constraintIds: ["R-999"] }] }],
};

/** 与えられた誤りを投げる偽物の LlmClient（通信の失敗・拒否・要求の誤りを試す） */
function throwingClient(error: unknown): LlmClient {
  return {
    async callStructured() {
      throw error;
    },
    async callWithTools() {
      throw error;
    },
  };
}

/** `kind` 付きの誤りを作る（共通の口が種類で分類する） */
const errorOf = (kind: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(kind), { kind, ...extra });

/** 23 回の下ごしらえに使う、ごく小さい構造化出力の要求 */
const PRIME_REQUEST: LlmStructuredRequest = {
  instructions: "",
  documents: [],
  rules: [],
  input: "",
  schemaName: "prime",
  schema: {},
  maxOutputTokens: 1,
};

describe("中身の作り直しを 1 回だけ入れる（02 §1・Issue #407）", () => {
  it("1 回目に設計が欠け、2 回目に直ったら ok（呼び出し 2 回）。前回の指示はデータにだけ入り、規則と前置きは変わらない", async () => {
    const recording = createRecordingClient([structured(DESIGN_MISSING_R2), structured(PLANNED_DESIGN)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    // 構造化の呼び出しは 2 回（形 1 回 × 中身 2 回）
    expect(recording.structured).toHaveLength(2);
    const first = recording.structured[0];
    const second = recording.structured[1];
    // 1 回目には前回の指示が無く、2 回目にはある
    expect(first?.input).not.toContain("前回の作り直しの指示");
    expect(second?.input).toContain("前回の作り直しの指示");
    // 前回の指示は、分類ごとの固定文と field の添字で示す。要件 ID の値は、データにも規則にも入れない
    // （Issue #445）
    expect(second?.input).toContain('"message": "要件の設計が無い"');
    expect(second?.input).toContain('"field": "requirements[1]"');
    const oldValuePhrase = "R-2 の設計が無い";
    expect(second?.input).not.toContain(oldValuePhrase);
    for (const request of [first, second]) {
      expect(request?.instructions).not.toContain("前回の作り直しの指示");
      expect(request?.instructions).not.toContain(oldValuePhrase);
      for (const rule of request?.rules ?? []) expect(rule).not.toContain(oldValuePhrase);
      for (const document of request?.documents ?? []) expect(document).not.toContain(oldValuePhrase);
    }
    // 共通の規則と前置き（instructions・rules・文書）は、1 回目と 2 回目で変わらない
    expect(second?.instructions).toBe(first?.instructions);
    expect(second?.rules).toEqual(first?.rules);
    expect(second?.documents).toEqual(first?.documents);
  });

  it("形の誤り→形の正しい未達→形の誤り→正しい設計、の合成例で ok になり、呼び出しは最大 4 回（5 回目を呼ばない）", async () => {
    const recording = createRecordingClient([
      structured(MALFORMED_DESIGN),
      structured(DESIGN_MISSING_R2),
      structured(MALFORMED_DESIGN),
      structured(PLANNED_DESIGN),
    ]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(4);
  });

  it("2 回とも中身に合わなければ unmet（attempts 2、問題は最後の回のもの）", async () => {
    const recording = createRecordingClient([
      structured(DESIGN_MISSING_R2),
      structured(DESIGN_BAD_CONSTRAINT),
    ]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    expect(outcome.failure.attempts).toBe(DESIGN_ROUNDS);
    // 問題は最後の回（2 回目）のもの。1 回目の「設計が無い」は残らない。文は固定文（値を埋めない）
    expect(outcome.failure.problems.some((problem) => problem.message === "文書に無い制約 ID である")).toBe(true);
    expect(outcome.failure.problems.some((problem) => problem.message === "要件の設計が無い")).toBe(false);
  });

  it("制約 ID の誤りも同じ枠で 1 回作り直し、直れば ok、直らなければ unmet", async () => {
    const fixed = await designOutcome(DESIGN_BAD_CONSTRAINT, CLAIM_DESIGN);
    expect(fixed.ok).toBe(true);

    const failed = await designOutcome(DESIGN_BAD_CONSTRAINT);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("unmet");
  });

  it("欠けと制約 ID の誤りが同時にあれば、1 回目の問題に両方が入る（前回の指示のデータで渡す）", async () => {
    const recording = createRecordingClient([
      structured(DESIGN_MISSING_AND_BAD_CONSTRAINT),
      structured(PLANNED_DESIGN),
    ]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const second = recording.structured[1];
    // 欠け（固定文 + 添字）と制約 ID の誤り（固定文）の両方が、前回の指示のデータに入る（Issue #445）
    expect(second?.input).toContain("要件の設計が無い");
    expect(second?.input).toContain("文書に無い制約 ID である");
    expect(second?.input).toContain('"field": "requirements[1]"');
    expect(second?.input).not.toContain("R-999");
  });

  it("形の誤り（malformed）は中身の枠に入らない（2 試行で malformed、3 回目を呼ばない）", async () => {
    const recording = createRecordingClient([structured(MALFORMED_DESIGN), structured(MALFORMED_DESIGN)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    expect(recording.structured).toHaveLength(2);
  });

  it("拒否・要求の誤り・打ち切りは 1 回で返り、追加の要求を出さない", async () => {
    const cases: readonly [Error, string][] = [
      [errorOf("refusal"), "refused"],
      [errorOf("invalidRequest", { code: "invalid_json_schema" }), "invalidRequest"],
      [errorOf("incomplete", { reason: "max_output_tokens" }), "incomplete"],
    ];
    for (const [error, expected] of cases) {
      const gateway = makeGateway(throwingClient(error), { deadline: 10_000_000 });
      const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
      expect(outcome.ok, expected).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure.kind, expected).toBe(expected);
      expect(gateway.calls, expected).toBe(1);
    }
  });

  it("通信の失敗（timeout）は共通の口の既定 2 試行で別に数える", async () => {
    const gateway = makeGateway(throwingClient(errorOf("timeout")), { deadline: 10_000_000 });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("timeout");
    // 段では数えず、共通の口の試行の数（既定 2）になる
    expect(gateway.calls).toBe(2);
  });

  it("呼び出しの数が 23 回使われた状態で 1 回目が unmet なら、2 回目は callLimit で止まり、25 回目を呼ばない", async () => {
    const recording = createRecordingClient([
      ...Array.from({ length: 23 }, () => structured({ ok: true })),
      structured(DESIGN_MISSING_R2),
    ]);
    const gateway = makeGateway(recording.client);
    // 下ごしらえで 23 回使う（全試行がジョブの上限に数えられることを確かめる）
    for (let i = 0; i < 23; i += 1) await gateway.callStructured(PRIME_REQUEST);
    expect(gateway.calls).toBe(23);

    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("callLimit");
    // 24 回目（1 回目の設計）で使い切り、25 回目（2 回目）は呼ばない
    expect(gateway.calls).toBe(24);
    expect(recording.structured.filter((request) => request.schemaName === DESIGN_SCHEMA_NAME)).toHaveLength(1);
  });

  it("最初の未達のあとで締切に達すると deadline で止まり、追加の要求を出さない", async () => {
    let checks = 0;
    const now = () => (checks++ === 0 ? 0 : 10 ** 9);
    const recording = createRecordingClient([structured(DESIGN_MISSING_R2)]);
    const gateway = new CallGateway({
      client: recording.client,
      budget: new JobBudget(10),
      rates: RATES,
      now,
      deadline: 1000,
      effort: "high",
    });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("deadline");
    expect(gateway.calls).toBe(1);
    expect(recording.structured).toHaveLength(1);
  });

  it("2 回目の予約が足りない予算では budget で止まり、追加の要求を出さない（usage が無いので予約は残る）", async () => {
    const firstRequest = buildStructuredRequest({
      rules: DESIGN_RULES,
      documents: SAMPLE_DOCUMENTS,
      data: [{ name: "要件の一覧", text: serializeJson(REQUIREMENT_LIST) }],
      schemaName: DESIGN_SCHEMA_NAME,
      schema: DESIGN_SCHEMA,
      maxOutputTokens: maxOutputTokensForEffort("high", "design"),
    });
    const maxCost = estimateMaxCostUsd({
      inputTokens: estimateInputUpperBoundTokens(structuredInputParts(firstRequest)),
      maxOutputTokens: firstRequest.maxOutputTokens,
      rates: RATES,
    });
    const recording = createRecordingClient([structured(DESIGN_MISSING_R2)]);
    // 1 回目は通るが、2 回目（前回の問題を含む分だけ大きい要求）の予約は残高を超える予算にする
    const gateway = makeGateway(recording.client, { budgetUsd: maxCost * 1.5, maxAttempts: 1 });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("budget");
    expect(gateway.calls).toBe(1);
    expect(recording.structured).toHaveLength(1);
  });

  it("代わりの案の要件（一覧の中の R:alt: の形）に設計が無い応答は、欠けとして断る", async () => {
    const list: RequirementList = {
      ...REQUIREMENT_LIST,
      requirements: [
        ...REQUIREMENT_LIST.requirements,
        { id: "R:alt:R-9", text: "代わりの案", quote: "代わりの案", position: { start: 0, end: 0 } },
      ],
    };
    const recording = createRecordingClient([structured(PLANNED_DESIGN), structured(PLANNED_DESIGN)]);
    const outcome = await runDesign({
      list,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
    if (outcome.failure.kind !== "unmet") return;
    // 代わりの案の要件（一覧の 3 番目）の設計の欠けは、固定文と field の添字で示す（値を埋めない。Issue #445）
    expect(
      outcome.failure.problems.some(
        (problem) => problem.field === "requirements[2]" && problem.message === "要件の設計が無い",
      ),
    ).toBe(true);
    expect(outcome.failure.problems.some((problem) => problem.message.includes("R:alt:R-9"))).toBe(false);
  });

  it("規則に、代わりの案の要件にも設計を返す決まりがある", () => {
    expect(DESIGN_RULES.some((rule) => rule.includes("代わりの案の要件にも 1 つ設計を返す"))).toBe(true);
  });
});

// ── 所属（根拠つき）と選択肢の順序（Issue #418）──────────────────────

/** 新契約の役割 ID の表（entity・計算 2 つ。`record` は 2 要件が使うので共有） */
const ROLES_418: readonly RoleEntry[] = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.extra", kind: "computation", entity: "record", name: "extra", shared: false, aliasOf: null, options: null, groupBy: null },
];

/** 正しい所属（R-1 が `record.total`、R-2 が `record.extra`。`record` は両方の依存） */
const OWNERSHIP_418: Record<string, readonly Record<string, unknown>[]> = {
  "R-1": [
    { roleId: "record", basis: "dependency", reason: "行を参照するため" },
    { roleId: "record.total", basis: "stated", reason: null },
  ],
  "R-2": [
    { roleId: "record", basis: "dependency", reason: "行を参照するため" },
    { roleId: "record.extra", basis: "stated", reason: null },
  ],
};

/** 役割の表と所属から、要件ごとの設計（新契約）を組む */
function designOf(
  roles: readonly unknown[],
  ownership: Readonly<Record<string, readonly unknown[]>>,
): unknown {
  return {
    roles,
    designs: REQUIREMENT_LIST.requirements.map((requirement) => ({
      requirementId: requirement.id,
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけ" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: ownership[requirement.id] ?? [],
    })),
  };
}

/** 1 つの設計を新しい契約で ② に流す（同じ応答を 2 回渡す） */
async function designRun(value: unknown, redo: unknown = value) {
  const recording = createRecordingClient([structured(value), structured(redo)]);
  return runDesign({
    list: REQUIREMENT_LIST,
    documents: SAMPLE_DOCUMENTS,
    gateway: makeGateway(recording.client, { maxAttempts: 1 }),
  });
}

describe("所属と選択肢を持つ設計は通り、戻り値にそのまま保持される（Issue #418）", () => {
  it("所属と options を持つ設計が、形も中身も通り、戻り値にそのまま保持される", async () => {
    const fixture = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null, options: null, groupBy: null },
        { roleId: "record.status", kind: "field", entity: "record", name: "status", shared: false, aliasOf: null, options: ["open", "closed"], groupBy: null },
      ],
      designs: [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "行を参照するため" },
            { roleId: "record.status", basis: "stated", reason: null },
          ],
        },
        {
          requirementId: "R-2",
          nature: "existence-only",
          verification: { kind: "structural", reason: "在ることだけ" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [],
        },
      ],
    };
    const outcome = await designRun(fixture);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.roles?.[1]?.options).toEqual(["open", "closed"]);
    expect(outcome.value.designs[0]?.ownership).toEqual([
      { roleId: "record", basis: "dependency", reason: "行を参照するため" },
      { roleId: "record.status", basis: "stated", reason: null },
    ]);
  });

  it("規則の文に、所属・根拠の無い役割・付け替え・options の順・固定の表の 5 つの文がある", () => {
    expect(DESIGN_RULES.some((rule) => rule.includes("所属") && rule.includes("stated") && rule.includes("dependency"))).toBe(true);
    expect(DESIGN_RULES.some((rule) => rule.includes("根拠の無い役割"))).toBe(true);
    expect(DESIGN_RULES.some((rule) => rule.includes("付け替え"))).toBe(true);
    expect(DESIGN_RULES.some((rule) => rule.includes("options") && rule.includes("使う順"))).toBe(true);
    expect(REDO_DESIGN_FIXED_TABLE_RULE).toContain("固定");
  });
});

describe("所属の中身の点検は、別々の合成例を断る（Issue #418）", () => {
  const withOwnership = (ownership: Record<string, readonly Record<string, unknown>[]>, roles: readonly unknown[] = ROLES_418) =>
    designOf(roles, ownership);

  it("表に無い役割 ID の所属を断る", () => {
    const bad = withOwnership({
      ...OWNERSHIP_418,
      "R-1": [...OWNERSHIP_418["R-1"]!, { roleId: "ghost", basis: "stated", reason: null }],
    });
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("所属の役割 ID が役割 ID の表に無い"))).toBe(true);
  });

  it("同じ要件の中の重複した所属を断る", () => {
    const bad = withOwnership({
      ...OWNERSHIP_418,
      "R-1": [...OWNERSHIP_418["R-1"]!, { roleId: "record.total", basis: "stated", reason: null }],
    });
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("同じ要件の中で役割の所属が重なっている"))).toBe(true);
  });

  it("どの要件にも所属しない役割を断る", () => {
    const bad = withOwnership({
      "R-1": OWNERSHIP_418["R-1"]!,
      "R-2": [{ roleId: "record", basis: "dependency", reason: "行を参照するため" }],
    });
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("根拠の無い役割"))).toBe(true);
  });

  it("参照先の entity の所属を伴わない役割の所属を断る", () => {
    const bad = withOwnership({
      "R-1": [{ roleId: "record.total", basis: "stated", reason: null }],
      "R-2": OWNERSHIP_418["R-2"]!,
    });
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("参照先の entity の所属を伴わない"))).toBe(true);
  });

  it("2 つの要件に所属するのに shared が偽なら断る", () => {
    const roles = ROLES_418.map((role) => (role.roleId === "record" ? { ...role, shared: false } : role));
    const bad = withOwnership(OWNERSHIP_418, roles);
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("shared を真にすること"))).toBe(true);
  });

  it("aliasOf の先が表に無い・別名の別名を断る", () => {
    const rolesWithAlias = [
      ...ROLES_418,
      { roleId: "record.sum", kind: "computation", entity: "record", name: "sum", shared: false, aliasOf: "ghost", options: null, groupBy: null },
    ];
    const ownership = {
      ...OWNERSHIP_418,
      "R-1": [...OWNERSHIP_418["R-1"]!, { roleId: "record.sum", basis: "stated", reason: null }],
    };
    const missing = planned(designOf(rolesWithAlias, ownership)).problems;
    expect(missing.some((message) => message.includes("別名の元の役割 ID が役割 ID の表に無い"))).toBe(true);

    const aliasOfAlias = [
      ...ROLES_418,
      { roleId: "record.sum", kind: "computation", entity: "record", name: "sum", shared: false, aliasOf: "record.total", options: null, groupBy: null },
      { roleId: "record.sum2", kind: "computation", entity: "record", name: "sum2", shared: false, aliasOf: "record.sum", options: null, groupBy: null },
    ];
    const ownership2 = {
      ...OWNERSHIP_418,
      "R-1": [
        ...OWNERSHIP_418["R-1"]!,
        { roleId: "record.sum", basis: "stated", reason: null },
        { roleId: "record.sum2", basis: "stated", reason: null },
      ],
    };
    const chained = planned(designOf(aliasOfAlias, ownership2)).problems;
    expect(chained.some((message) => message.includes("別名の別名は作らない"))).toBe(true);
  });

  it("1 回目に直れば ok、2 回とも落ちれば unmet（attempts 2）", async () => {
    const bad = withOwnership({
      ...OWNERSHIP_418,
      "R-1": [...OWNERSHIP_418["R-1"]!, { roleId: "ghost", basis: "stated", reason: null }],
    });
    const good = designOf(ROLES_418, OWNERSHIP_418);
    const fixed = await designRun(bad, good);
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.value.designs[0]?.ownership).toEqual(OWNERSHIP_418["R-1"]);

    const failed = await designRun(bad);
    expect(failed.ok).toBe(false);
    if (failed.ok || failed.failure.kind !== "unmet") return;
    expect(failed.failure.attempts).toBe(DESIGN_ROUNDS);
  });
});

describe("選択肢と根拠の形の誤り（Issue #418）", () => {
  const role = (overrides: Record<string, unknown>) => ({
    roleId: "record.status",
    kind: "field",
    entity: "record",
    name: "status",
    shared: false,
    aliasOf: null,
    options: null,
    groupBy: null,
    ...overrides,
  });
  const baseDesign = (roles: readonly unknown[]) =>
    checkDesignOutput({
      roles,
      designs: [
        { requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [], ownership: [] },
      ],
    });

  it("項目でない役割の options が非 null なら断る", () => {
    const checked = baseDesign([role({ kind: "entity", entity: null, options: ["a"] })]);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("roles[0].options");
  });

  it("options が空・重複・文字列でないなら断る", () => {
    for (const [options, expected] of [
      [[], "選択肢は空でない並びであること"],
      [["a", "a"], "選択肢のキーが重なっている"],
      [[1], "選択肢のキーは空でない文字列であること"],
    ] as const) {
      const checked = baseDesign([role({ options })]);
      expect(checked.ok, JSON.stringify(options)).toBe(false);
      if (checked.ok) continue;
      expect(checked.problems.some((problem) => problem.message.includes(expected)), JSON.stringify(options)).toBe(true);
    }
  });

  const ownershipDesign = (ownership: readonly unknown[]) =>
    checkDesignOutput({
      roles: [role({ kind: "entity", entity: null, options: null })],
      designs: [
        { requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [], ownership },
      ],
    });

  it("所属の basis が知らない値なら断る", () => {
    const checked = ownershipDesign([{ roleId: "record.status", basis: "nope", reason: null }]);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("designs[0].ownership[0].basis");
  });

  it("dependency の reason が空か空白だけなら断る", () => {
    for (const reason of ["", "   "]) {
      const checked = ownershipDesign([{ roleId: "record.status", basis: "dependency", reason }]);
      expect(checked.ok, reason).toBe(false);
      if (checked.ok) continue;
      expect(checked.problems.map((problem) => problem.field)).toContain("designs[0].ownership[0].reason");
    }
  });
});

describe("新契約の形の誤りと、互換の明示（Issue #418）", () => {
  it("全欠落・一部の欠落・型違いは形の誤り（2 試行で malformed）", async () => {
    const cases: readonly unknown[] = [
      {}, // 全欠落（役割の表も設計も無い）
      { roles: ROLES_418, designs: [{ requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [] }] }, // 所属の欠落
      { roles: ROLES_418.map((entry) => ({ ...entry, options: undefined })), designs: [] }, // options の欠落
      { roles: ROLES_418, designs: [{ requirementId: "R-1", ownership: "nope" }] }, // 型違い
    ];
    for (const [index, value] of cases.entries()) {
      const recording = createRecordingClient([structured(value), structured(value)]);
      const outcome = await runDesign({
        list: REQUIREMENT_LIST,
        documents: SAMPLE_DOCUMENTS,
        gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      });
      expect(outcome.ok, `case ${index}`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure.kind, `case ${index}`).toBe("malformed");
    }
  });

  it("互換を明示すれば、役割の表の無い旧形式と所属の無い形式が通り、混在は断る", () => {
    // 役割の表の無い旧形式
    expect(checkDesignOutput(DESIGN_OUTPUT, LEGACY_DESIGN_CONTRACT).ok).toBe(true);
    // 表はあるが所属の無い形式（`options` も無い）
    const withoutOwnership = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
      ],
      designs: [
        { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [] },
        { requirementId: "R-2", vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    expect(checkDesignOutput(withoutOwnership, LEGACY_DESIGN_CONTRACT).ok).toBe(true);
    // 所属の有無が混ざっていれば、互換でも断る
    const mixedOwnership = {
      roles: withoutOwnership.roles,
      designs: [
        { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [], ownership: [] },
        { requirementId: "R-2", vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    expect(checkDesignOutput(mixedOwnership, LEGACY_DESIGN_CONTRACT).ok).toBe(false);
    // options の有無が混ざっていても、互換でも断る
    const mixedOptions = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null, options: null, groupBy: null },
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
      ],
      designs: withoutOwnership.designs,
    };
    expect(checkDesignOutput(mixedOptions, LEGACY_DESIGN_CONTRACT).ok).toBe(false);
  });

  it("互換を明示した、表を持つ旧設計の従来の不正例は従来どおり断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "name", kind: "field", entity: "member", name: "name", shared: false, aliasOf: null },
        { roleId: "name", kind: "field", entity: "session", name: "name", shared: false, aliasOf: null },
      ],
    };
    const { problems } = legacyPlanned(bad);
    expect(problems.some((message) => message.includes("同名の別 entity"))).toBe(true);
  });

  it("新しい検査の Problem に、目印を入れた役割 ID・options・basis・reason の値が出ない", async () => {
    const marker = "MARKER418";
    const design = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null, options: null, groupBy: null },
        { roleId: `record.${marker}`, kind: "field", entity: "record", name: `${marker}`, shared: false, aliasOf: null, options: [`${marker}-option`], groupBy: null },
      ],
      designs: [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [{ roleId: `ghost-${marker}`, basis: "dependency", reason: `${marker}-reason` }],
        },
        { requirementId: "R-2", nature: "existence-only", verification: { kind: "structural", reason: "在ることだけ" }, vocabulary: [], placement: [], unwritable: [], ownership: [] },
      ],
    };
    const recording = createRecordingClient([structured(design), structured(design)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    for (const problem of outcome.failure.problems) {
      expect(`${problem.field} ${problem.message}`).not.toContain(marker);
    }
  });
});

describe("単一要件の作り直しは、表を固定し、1 件を全体へ差し替えて点検する（Issue #418）", () => {
  /** R-2 の設計（他の要件の採用済み） */
  const adoptedR2: RequirementDesign = {
    requirementId: "R-2",
    nature: "existence-only",
    verification: { kind: "structural", reason: "在ることだけ" },
    vocabulary: [],
    placement: [],
    unwritable: [],
    ownership: [
      { roleId: "record", basis: "dependency", reason: "行を参照するため" },
      { roleId: "record.extra", basis: "stated", reason: null },
    ],
  };
  /** R-1 の設計（作り直しの応答。`record.extra` は R-2 だけが使うので所属させない） */
  const redoR1 = {
    requirementId: "R-1",
    nature: "ruled",
    verification: { kind: "fixed-test" },
    vocabulary: [],
    placement: [],
    unwritable: [],
    ownership: [
      { roleId: "record", basis: "dependency", reason: "行を参照するため" },
      { roleId: "record.total", basis: "stated", reason: null },
    ],
  };
  const redoInput = (response: unknown): DesignInput => ({
    list: { ...REQUIREMENT_LIST, requirements: REQUIREMENT_LIST.requirements.filter((r) => r.id === "R-1") },
    documents: SAMPLE_DOCUMENTS,
    gateway: makeGateway(createRecordingClient([structured(response), structured(response)]).client, { maxAttempts: 1 }),
    redo: { roles: ROLES_418, adopted: [adoptedR2], wholeList: REQUIREMENT_LIST },
  });

  it("整合する応答は ok（他の要件だけが使う役割を対象の要件に所属させなくても通る）", async () => {
    const outcome = await runDesign(redoInput({ roles: ROLES_418, designs: [redoR1] }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 戻り値の表は固定の表のまま
    expect(outcome.value.roles).toEqual(ROLES_418);
    expect(outcome.value.designs[0]?.ownership).toEqual(redoR1.ownership);
  });

  it("表を変えた応答は unmet", async () => {
    const outcome = await runDesign(redoInput({ roles: ROLES_418.slice(0, 2), designs: [redoR1] }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    expect(outcome.failure.problems.some((problem) => problem.message.includes("固定の役割 ID の表と一致しない"))).toBe(true);
  });

  it("表に無い ID の所属の応答は unmet", async () => {
    const withGhost = {
      ...redoR1,
      ownership: [...redoR1.ownership, { roleId: "ghost", basis: "stated", reason: null }],
    };
    const outcome = await runDesign(redoInput({ roles: ROLES_418, designs: [withGhost] }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    expect(outcome.failure.problems.some((problem) => problem.message.includes("所属の役割 ID が役割 ID の表に無い"))).toBe(true);
  });

  it("差し替えた全体が整合しない応答は unmet（R-1 が参照先の entity を所属させない）", async () => {
    const withoutEntity = {
      ...redoR1,
      ownership: [{ roleId: "record.total", basis: "stated", reason: null }],
    };
    const outcome = await runDesign(redoInput({ roles: ROLES_418, designs: [withoutEntity] }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    expect(outcome.failure.problems.some((problem) => problem.message.includes("参照先の entity の所属を伴わない"))).toBe(true);
  });

  it("先頭以外の要件を作り直すとき、問題の添字は送った一覧の座標になる（Issue #445・レビュー指摘）", async () => {
    // 対象は全体の 2 番目（R-2）。送る一覧（`list`）は R-2 の 1 件だけで、点検は全体（`wholeList`）で行う。
    // 形は通るが空の designs を返すので、次の指示は「R-2 の設計が無い」になる。送った一覧の位置は
    // `requirements[0]` である（検査した全体の添字 `requirements[1]` をそのまま出すと、送ったデータに無い）。
    const emptyRedo = { roles: ROLES_418, designs: [] };
    const recording = createRecordingClient([structured(emptyRedo), structured(emptyRedo)]);
    const outcome = await runDesign({
      list: { ...REQUIREMENT_LIST, requirements: REQUIREMENT_LIST.requirements.filter((r) => r.id === "R-2") },
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      redo: { roles: ROLES_418, adopted: [redoR1 as RequirementDesign], wholeList: REQUIREMENT_LIST },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") return;
    // 2 回目に送る前回の指示は、送った一覧に在る位置を指す
    const second = recording.structured[1];
    expect(second?.input).toContain("前回の作り直しの指示");
    expect(second?.input).toContain('"field": "requirements[0]"');
    expect(second?.input).not.toContain('"field": "requirements[1]"');
    expect(second?.input).toContain("要件の設計が無い");
    // 未達として返す問題も、送った一覧の座標である
    expect(
      outcome.failure.problems.some(
        (problem) => problem.field === "requirements[0]" && problem.message === "要件の設計が無い",
      ),
    ).toBe(true);
  });
});

// ── 見出しの元の項目（groupBy。Issue #433）──────────────────────────────

describe("見出しの元の項目（groupBy）の形と中身（Issue #433）", () => {
  const ENTITY_ROLE = { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null };
  const STATUS_ROLE = { roleId: "record.status", kind: "field", entity: "record", name: "status", shared: false, aliasOf: null, options: ["open", "closed"], groupBy: null };
  const TOTAL_ROLE = { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: "record.status" };

  /** groupBy つきの設計（R-1 が表の全役割を所属させる。R-2 は在ることだけ） */
  const designOf = (roles: readonly unknown[]): unknown => ({
    roles,
    designs: [
      {
        requirementId: "R-1",
        nature: "ruled",
        verification: { kind: "fixed-test" },
        vocabulary: [],
        placement: [],
        unwritable: [],
        ownership: [
          { roleId: "record", basis: "dependency", reason: "行を参照するため" },
          { roleId: "record.status", basis: "stated", reason: null },
          { roleId: "record.total", basis: "stated", reason: null },
        ],
      },
      { requirementId: "R-2", nature: "existence-only", verification: { kind: "structural", reason: "在ることだけ" }, vocabulary: [], placement: [], unwritable: [], ownership: [] },
    ],
  });

  it("計算の役割の groupBy が、表の選択肢の項目を指せば通る", () => {
    const { problems } = planned(designOf([ENTITY_ROLE, STATUS_ROLE, TOTAL_ROLE]));
    expect(problems).toEqual([]);
  });

  it("無い ID を指す groupBy は断る", () => {
    const { problems } = planned(designOf([ENTITY_ROLE, STATUS_ROLE, { ...TOTAL_ROLE, groupBy: "ghost" }]));
    expect(problems).toContain("見出しの元の項目の役割 ID が役割 ID の表に無い");
  });

  it("項目でない役割を指す groupBy は断る", () => {
    const { problems } = planned(designOf([ENTITY_ROLE, STATUS_ROLE, { ...TOTAL_ROLE, groupBy: "record" }]));
    expect(problems).toContain("見出しの元の項目が項目（field）でない");
  });

  it("選択肢（options）の無い項目を指す groupBy は断る", () => {
    const note = { roleId: "record.note", kind: "field", entity: "record", name: "note", shared: false, aliasOf: null, options: null, groupBy: null };
    const { problems } = planned(
      designOf([ENTITY_ROLE, STATUS_ROLE, note, { ...TOTAL_ROLE, groupBy: "record.note" }]),
    );
    expect(problems).toContain("見出しの元の項目に選択肢（options）が無い");
  });

  it("計算でない役割の非 null の groupBy は、形の確認で断る", () => {
    const checked = checkDesignOutput(designOf([ENTITY_ROLE, { ...STATUS_ROLE, groupBy: "record.status" }, TOTAL_ROLE]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.some((problem) => problem.field === "roles[1].groupBy")).toBe(true);
  });

  it("新契約で groupBy が欠けた役割は、形の確認で断る", () => {
    const { groupBy: _omitted, ...withoutGroupBy } = TOTAL_ROLE;
    const checked = checkDesignOutput(designOf([ENTITY_ROLE, STATUS_ROLE, withoutGroupBy]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.some((problem) => problem.field === "roles[2].groupBy")).toBe(true);
  });

  it("役割ごとに groupBy の有無が混ざっていれば、形の確認で断る", () => {
    const { groupBy: _omitted, ...noGroupBy } = ENTITY_ROLE;
    const checked = checkDesignOutput(designOf([noGroupBy, STATUS_ROLE, TOTAL_ROLE]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.some((problem) => problem.message.includes("見出しの元の項目（groupBy）の有無が役割ごとに混ざっている"))).toBe(true);
  });

  it("中身の点検の Problem に、groupBy の先の値（目印）が出ない", () => {
    const marker = "MARKER433";
    const problems = checkGroupBy([
      { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
      { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: `ghost-${marker}` },
    ]);
    expect(problems).not.toEqual([]);
    for (const problem of problems) {
      expect(`${problem.field} ${problem.message}`).not.toContain(marker);
    }
  });

  it("規則の文に、groupBy の 1 文と理由がある", () => {
    expect(DESIGN_RULES.some((rule) => rule.includes("groupBy"))).toBe(true);
    expect(
      DESIGN_RULES.some(
        (rule) =>
          rule.includes("groupBy") &&
          rule.includes("見出しごとの集計") &&
          rule.includes("宣言と固定する試験が別々の表現を推測しないため"),
      ),
    ).toBe(true);
  });

  it("② の規則の定義は、ID が台帳のもので、重複が無く、why と since が空でない", () => {
    expect(ruleDefinitionDefects(DESIGN_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects([REDO_DESIGN_FIXED_TABLE_DEFINITION])).toEqual([]);
    const ids = [...DESIGN_RULE_DEFINITIONS.map((definition) => definition.id), REDO_DESIGN_FIXED_TABLE_DEFINITION.id];
    const ledger = [
      ...Array.from({ length: 23 }, (_, index) => `R-design-${String(index + 1).padStart(2, "0")}`),
      "R-design-redo",
    ];
    expect([...ids].sort()).toEqual([...ledger].sort());
    for (const definition of [...DESIGN_RULE_DEFINITIONS, REDO_DESIGN_FIXED_TABLE_DEFINITION]) {
      expect(definition.why.trim(), definition.id).not.toBe("");
      expect(definition.since.trim(), definition.id).not.toBe("");
    }
  });

  it("DESIGN_RULES と作り直し専用の文が、定義の text と順まで一致する", () => {
    expect(DESIGN_RULES).toEqual(ruleTexts(DESIGN_RULE_DEFINITIONS));
    expect(DESIGN_RULES).toHaveLength(DESIGN_RULE_DEFINITIONS.length);
    expect(REDO_DESIGN_FIXED_TABLE_RULE).toBe(REDO_DESIGN_FIXED_TABLE_DEFINITION.text);
  });

  it("legacy の役割の表（groupBy の無い旧形式）は、互換を明示すれば通る", () => {
    const legacy = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
      ],
      designs: [
        { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [] },
        { requirementId: "R-2", vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    expect(checkDesignOutput(legacy, LEGACY_DESIGN_CONTRACT).ok).toBe(true);
  });
});

// ── 中身・形の再試行の数（Issue #446）──────────────────────────────

describe("② の中身・形の再試行の数（Issue #446）", () => {
  it("中身の検査に 1 回落ちて 2 回目で通ると、中身 1・形 0", async () => {
    const recording = createRecordingClient([structured(DESIGN_MISSING_R2), structured(PLANNED_DESIGN)]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(true);
    // 形は 1 回目で通り、中身の作り直しだけを 1 回数える
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 1 });
  });

  it("1 回目の形が落ちて同じ回で通ると、形 1・中身 0", async () => {
    const recording = createRecordingClient([structured(MALFORMED_DESIGN), structured(PLANNED_DESIGN)]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(true);
    // 形のやり直しを 1 回数え、中身の作り直しは 0（同じ回で通った）
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
  });

  it("2 回とも中身に合わない（unmet）とき、中身の作り直しは 1", async () => {
    const recording = createRecordingClient([structured(DESIGN_MISSING_R2), structured(DESIGN_BAD_CONSTRAINT)]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    const outcome = await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway });
    expect(outcome.ok).toBe(false);
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 1 });
  });
});

// ── 断る Problem の field と message に、値を埋めない（§1・②・Issue #445）──────────────
//
// #418 は新しい検査（所属・groupBy）を固定文にした。それより前に入った検査（役割の表の重複・一覧に無い
// 要件・設計の欠け・種類／確かめ方の欠け・文書に無い制約 ID）は、誤りの文（`message`）や欄（`field`）に
// 役割 ID・名前・entity 名・要件 ID・制約 ID の値を埋めていた。値は停止の要約と段の失敗の記録に写り、
// 作り直しの指示のデータ（前回の問題）にもそのまま入る。位置は `field` の配列の添字で示し、`message` は
// 分類ごとの固定文にする。ここでは、目印を入れた値で各検査を起こし、断りに目印が出ないことを確かめる。

describe("断る Problem の field と message に、値を埋めない（§1・②・Issue #445）", () => {
  const marker = "MARKER445";

  /** `field` と `message` を 1 つの文字列に直列化する（目印の有無を見るため） */
  const serialized = (problems: readonly { readonly field: string; readonly message: string }[]): string =>
    problems.map((problem) => `${problem.field} ${problem.message}`).join("\n");

  /** 形を通したうえで、中身の点検（`checkDesignPlan`）の `field`・`message` を返す */
  const planProblems = (value: unknown): readonly { readonly field: string; readonly message: string }[] => {
    const checked = checkDesignOutput(value);
    if (!checked.ok) throw new Error(`前提（形）が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
    return checkDesignPlan(REQUIREMENT_LIST, checked.value);
  };

  /** 目印を入れた役割 1 行（新契約の必須の欄を備える。壊したい欄だけ上書きする） */
  const role = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    roleId: `record-${marker}`,
    kind: "entity",
    entity: null,
    name: marker,
    shared: false,
    aliasOf: null,
    options: null,
    groupBy: null,
    ...overrides,
  });

  /** 役割の表と設計から、目印を入れた設計（新契約）を組む */
  const designOf = (options: { readonly roles?: readonly unknown[]; readonly designs?: readonly unknown[] }): unknown => ({
    roles: options.roles ?? [role({})],
    designs:
      options.designs ?? [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [{ roleId: `record-${marker}`, basis: "dependency", reason: `${marker}-reason` }],
        },
        {
          requirementId: "R-2",
          nature: "existence-only",
          verification: { kind: "structural", reason: "在ることだけ" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [],
        },
      ],
  });

  it("役割の表の重複と共有の点検で、役割 ID・名前・entity の値を埋めない（field は添字）", () => {
    const cases: readonly { readonly label: string; readonly value: unknown }[] = [
      // 同じ役割 ID を、別の名前の対象に使い回す
      { label: "reuse", value: designOf({ roles: [role({}), role({ name: `${marker}-2` })] }) },
      // 同名の別 entity を同じ役割 ID にする
      {
        label: "same-name-other-entity",
        value: designOf({
          roles: [role({ name: "n" }), role({ name: "n", entity: `e-${marker}` })],
        }),
      },
      // 同じ名前の対象を、共有も別名も明示せずに 2 つの役割 ID にする
      {
        label: "same-name-multiple-ids",
        value: designOf({
          roles: [role({ roleId: `r1-${marker}`, name: "n" }), role({ roleId: `r2-${marker}`, name: "n" })],
        }),
      },
    ];
    for (const one of cases) {
      const problems = planProblems(one.value);
      expect(problems.length, one.label).toBeGreaterThan(0);
      expect(serialized(problems), one.label).not.toContain(marker);
      for (const problem of problems) expect(problem.field, one.label).toContain("[");
    }
  });

  it("一覧に無い要件・設計の欠け・種類／確かめ方の欠けで、要件 ID の値を埋めない（field は添字）", () => {
    // 一覧に無い要件 ID の設計
    const unknownRequirement = planProblems(
      designOf({
        designs: [
          {
            requirementId: `R-${marker}`,
            nature: "ruled",
            verification: { kind: "fixed-test" },
            vocabulary: [],
            placement: [],
            unwritable: [],
            ownership: [{ roleId: `record-${marker}`, basis: "dependency", reason: `${marker}-reason` }],
          },
        ],
      }),
    );
    // R-1 に種類と確かめ方が無く、R-2 の設計が無い
    const missing = planProblems(
      designOf({
        designs: [
          { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [], ownership: [{ roleId: `record-${marker}`, basis: "dependency", reason: `${marker}-reason` }] },
        ],
      }),
    );
    for (const problems of [unknownRequirement, missing]) {
      expect(problems.length).toBeGreaterThan(0);
      expect(serialized(problems)).not.toContain(marker);
      for (const problem of problems) expect(problem.field).toContain("[");
    }
    expect(unknownRequirement.some((problem) => problem.field === "designs[0]" && problem.message === "一覧に無い要件 ID である")).toBe(true);
    expect(missing.some((problem) => problem.field === "requirements[0]" && problem.message === "要件に種類（決まりを含む／在ることだけ）が無い")).toBe(true);
    expect(missing.some((problem) => problem.field === "requirements[0]" && problem.message === "要件に確かめ方が無い")).toBe(true);
    expect(missing.some((problem) => problem.field === "requirements[1]" && problem.message === "要件の設計が無い")).toBe(true);
  });

  it("文書に無い制約 ID の点検で、制約 ID と要件 ID の値を埋めない（field は添字）", () => {
    const value = designOf({
      designs: [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [{ part: "部分", constraintIds: [`unknown-${marker}`], reason: "理由" }],
          ownership: [{ roleId: `record-${marker}`, basis: "dependency", reason: `${marker}-reason` }],
        },
        {
          requirementId: "R-2",
          nature: "existence-only",
          verification: { kind: "structural", reason: "在ることだけ" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [],
        },
      ],
    });
    const checked = checkDesignOutput(value);
    if (!checked.ok) throw new Error("前提（形）が壊れた");
    const problems = checkDesignConstraints(checked.value, SAMPLE_DOCUMENTS);
    expect(problems.length).toBeGreaterThan(0);
    expect(serialized(problems)).not.toContain(marker);
    expect(
      problems.some(
        (problem) => problem.field === "designs[0].unwritable[0].constraintIds" && problem.message === "文書に無い制約 ID である",
      ),
    ).toBe(true);
  });
});
