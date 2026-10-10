// ② 設計する（stages/design.ts）の unit テスト（02 §1・F-4・F-5・Issue #307）。
import { describe, expect, it } from "vitest";
import { maxOutputTokensForEffort } from "../limits.js";
import type { DesignResult } from "../pipeline.js";
import {
  DESIGN_SCHEMA_NAME,
  checkDesignConstraints,
  checkDesignOutput,
  checkDesignPlan,
  isPlannedDesign,
  runDesign,
  type DesignInput,
} from "./design.js";
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

  it("中身の点検に合わない設計を送ると、② は未達として断る（やり直さない）", async () => {
    const bad = {
      ...PLANNED_DESIGN,
      designs: [
        PLANNED_DESIGN.designs[0],
        { requirementId: "R-2", nature: "existence-only", vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    const recording = createRecordingClient([structured(bad)]);
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

/** 1 つの設計を ② に流し、結果を返す（本番と同じく、形と中身と根拠を確かめる） */
async function designOutcome(value: unknown) {
  const recording = createRecordingClient([structured(value)]);
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
