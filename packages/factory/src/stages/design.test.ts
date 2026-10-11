// ② 設計する（stages/design.ts）の unit テスト（02 §1・F-4・F-5・Issue #307）。
import { describe, expect, it } from "vitest";
import { JobBudget, estimateMaxCostUsd } from "../budget.js";
import { CallGateway, estimateInputUpperBoundTokens, structuredInputParts } from "../call.js";
import { maxOutputTokensForEffort } from "../limits.js";
import type { LlmClient, LlmStructuredRequest } from "../llm.js";
import type { DesignResult, RequirementList } from "../pipeline.js";
import {
  DESIGN_ROUNDS,
  DESIGN_RULES,
  DESIGN_SCHEMA,
  DESIGN_SCHEMA_NAME,
  checkDesignConstraints,
  checkDesignOutput,
  checkDesignPlan,
  isPlannedDesign,
  runDesign,
  type DesignInput,
} from "./design.js";
import { buildStructuredRequest, serializeJson } from "./prompt.js";
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

/** 抽象的な役割 ID の表（entity の文脈を含む ID。共有・別名は明示の欄でだけ許す） */
const PLANNED_ROLES = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
];

/** 役割 ID の表・種類・確かめ方を備えた設計（本番の応答の形） */
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
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけなので構造で確かめる" },
      vocabulary: [],
      placement: [],
      unwritable: [],
    },
  ],
};

/** 形を通したうえで、中身の点検を掛ける（本番では `runDesign` が自動で掛ける） */
function planned(value: unknown): { readonly design: DesignResult; readonly problems: readonly string[] } {
  const checked = checkDesignOutput(value);
  if (!checked.ok) throw new Error(`前提（形）が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return {
    design: checked.value,
    problems: checkDesignPlan(REQUIREMENT_LIST, checked.value).map((problem) => problem.message),
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
    expect(checkDesignOutput(DESIGN_OUTPUT).ok).toBe(true);
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
    });
    expect(retried.ok).toBe(true);
  });
});

// ── 役割 ID の表・種類・確かめ方（Issue #307）────────────────────

describe("役割 ID の表・種類・確かめ方は必須で、旧形式の記録は後方互換で通す（Issue #307）", () => {
  it("旧形式の設計（役割 ID の表も種類も無い）は、② が受け入れる（後方互換）", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    const outcome = await runDesign({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isPlannedDesign(outcome.value)).toBe(false);
  });

  it("旧形式の設計は、形の確認は通るが、中身の点検は必須の欄（種類・確かめ方）を求める", () => {
    const checked = checkDesignOutput(DESIGN_OUTPUT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(isPlannedDesign(checked.value)).toBe(false);
    expect(checkDesignPlan(REQUIREMENT_LIST, checked.value).length).toBeGreaterThan(0);
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
        { requirementId: "R-2", nature: "existence-only", vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("R-2") && message.includes("確かめ方"))).toBe(true);
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
        },
      ],
    };
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("R-2") && message.includes("種類"))).toBe(true);
  });

  it("役割 ID の表が無ければ断る", () => {
    const bad = { designs: PLANNED_DESIGN.designs };
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("役割 ID の表"))).toBe(true);
  });

  it("fixed-test 以外の確かめ方に理由が無ければ、形の確認で断る", () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        { requirementId: "R-2", nature: "existence-only", verification: { kind: "unresolved", reason: "" }, vocabulary: [], placement: [], unwritable: [] },
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
        { requirementId: "R-2", nature: "existence-only", vocabulary: [], placement: [], unwritable: [] },
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
    const { problems } = planned(bad);
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
    const { problems } = planned(bad);
    expect(problems.some((message) => message.includes("同じ名前") && message.includes("total"))).toBe(true);
  });

  it("共有（shared）を明示すれば、同名の対象を複数の役割 ID にできる", () => {
    const ok = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null },
        { roleId: "record.sum", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null },
      ],
    };
    expect(planned(ok).problems).toEqual([]);
  });

  it("別名（aliasOf）を明示すれば、同名の対象を複数の役割 ID にできる", () => {
    const ok = {
      ...PLANNED_DESIGN,
      roles: [
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
        { roleId: "record.sum", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: "record.total" },
      ],
    };
    expect(planned(ok).problems).toEqual([]);
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
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけなので構造で確かめる" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      notes: ["件数の数え方を決めずに残した（曖昧さのメモ）"],
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
    expect(problems.some((problem) => problem.message.includes("R-999"))).toBe(true);

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
    const checked = checkDesignOutput({
      designs: [
        { requirementId: "R-1", vocabulary: [], placement: [], unwritable: [], notes: ["曖昧さのメモ"] },
      ],
    });
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
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "構造で確かめる" },
      checks: ["action-kind", "action-unconditioned"],
      vocabulary: [],
      placement: [],
      unwritable: [],
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
    // 目印（モデル由来の要件 ID を含む問題の文）は、データにだけ入る
    const marker = "要件 R-2 の設計が無い";
    expect(second?.input).toContain(marker);
    for (const request of [first, second]) {
      expect(request?.instructions).not.toContain("前回の作り直しの指示");
      expect(request?.instructions).not.toContain(marker);
      for (const rule of request?.rules ?? []) expect(rule).not.toContain(marker);
      for (const document of request?.documents ?? []) expect(document).not.toContain(marker);
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
    // 問題は最後の回（2 回目）のもの。1 回目の「設計が無い」は残らない
    expect(outcome.failure.problems.some((problem) => problem.message.includes("R-999"))).toBe(true);
    expect(outcome.failure.problems.some((problem) => problem.message.includes("R-2 の設計が無い"))).toBe(false);
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
    expect(second?.input).toContain("要件 R-2 の設計が無い");
    expect(second?.input).toContain("R-999");
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
    expect(outcome.failure.problems.some((problem) => problem.message.includes("R:alt:R-9"))).toBe(true);
  });

  it("規則に、代わりの案の要件にも設計を返す決まりがある", () => {
    expect(DESIGN_RULES.some((rule) => rule.includes("代わりの案の要件にも 1 つ設計を返す"))).toBe(true);
  });
});
