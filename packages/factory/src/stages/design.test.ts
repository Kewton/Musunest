// ② 設計する（stages/design.ts）の unit テスト（02 §1・F-4・F-5）。
import { describe, expect, it } from "vitest";
import { maxOutputTokensForEffort } from "../limits.js";
import { DESIGN_SCHEMA_NAME, checkDesignOutput, runDesign, type DesignInput } from "./design.js";
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
