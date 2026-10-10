// ③ 書く（stages/write.ts）の unit テスト（02 §1・§1.5・§2.2）。
//
// ここで固定したいのは 4 つ。
//   1. 送った要求を観測する：規則（instructions）とデータが別の入力であること・データに仕込んだ
//      「規則を無視せよ」が規則の側へ入らないこと・その段に渡すと決めた文脈（要件の一覧と設計）だけが
//      入っていること・JSON Schema が付いていること・受入の題材の言葉が無いこと
//   2. 書いた直後に、宣言の大きさの上限の**ちょうど**と**超過**を確かめること
//   3. 形が合わない応答は 1 回だけやり直すこと（共通の口）
//   4. **役割 ID → 宣言の名前の対応（mappings）を提出する**こと（Issue #308）
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import {
  DECLARATION_SCHEMA,
  WRITE_SCHEMA_NAME,
  checkWriteOutput,
  runWrite,
  utf8ByteLength,
  type WriteInput,
} from "./write.js";
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

/** 手で書いた、抽象的な宣言（この試験の題材。受入の題材の言葉は使わない） */
const SAMPLE_DECLARATION = [
  "entities: []",
  "views: []",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

describe("③ が送る要求を観測する（02 §2.2）", () => {
  it("設計と要件の一覧だけをデータに置き、JSON Schema を付け、規則とデータを分ける", async () => {
    const recording = createRecordingClient([structured({ declaration: SAMPLE_DECLARATION })]);
    const outcome = await runWrite({
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // データは要件の一覧と設計の 2 つだけ
    expect(request.input.match(/<data name=/g)).toHaveLength(2);
    expect(request.input).toContain("要件の一覧");
    expect(request.input).toContain("設計");
    // データの中身と囲みは、規則の側に入らない（規則が語を説明に使うことはある）
    expect(request.instructions).not.toContain("要件の一覧");
    expect(request.instructions).not.toContain("<data");
    expect(request.instructions).not.toContain('"requirements"');
    expect(request.instructions).not.toContain('"designs"');
    // JSON Schema が付く
    expect(request.schemaName).toBe(WRITE_SCHEMA_NAME);
    expect(request.schema).toBe(DECLARATION_SCHEMA);
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("データに仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured({ declaration: SAMPLE_DECLARATION })]);
    await runWrite({
      list: { ...REQUIREMENT_LIST, decisions: [INJECTED_INSTRUCTION] },
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("渡すと決めていない文脈（余分な欄）は、データにも規則にも入らない", async () => {
    const recording = createRecordingClient([structured({ declaration: SAMPLE_DECLARATION })]);
    const withExtra = {
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      declarationSentinel: "DECLARATION_SENTINEL",
    } as unknown as WriteInput;
    await runWrite(withExtra);
    const request = recording.structured[0];
    expect(request?.input).not.toContain("DECLARATION_SENTINEL");
    expect(request?.instructions).not.toContain("DECLARATION_SENTINEL");
  });
});

describe("③ は書いた直後に宣言の大きさを確かめる（02 §1.5）", () => {
  const run = (declaration: string) =>
    runWrite({
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(
        createRecordingClient([structured({ declaration })]).client,
        { maxAttempts: 1 },
      ),
    });

  it("上限ちょうどは通る", async () => {
    const atLimit = "a".repeat(AGENT_LIMITS.declarationBytes);
    expect(utf8ByteLength(atLimit)).toBe(AGENT_LIMITS.declarationBytes);
    const outcome = await run(atLimit);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.byteLength).toBe(AGENT_LIMITS.declarationBytes);
    expect(outcome.value.declaration.source).toBe(atLimit);
  });

  it("1 バイト超過は、書いた直後に断る（静的チェックへ渡さない）", async () => {
    const over = "a".repeat(AGENT_LIMITS.declarationBytes + 1);
    const outcome = await run(over);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("limit");
    if (outcome.failure.kind !== "limit") return;
    expect(outcome.failure.limit).toBe("declarationBytes");
    expect(outcome.failure.max).toBe(AGENT_LIMITS.declarationBytes);
    expect(outcome.failure.actual).toBe(AGENT_LIMITS.declarationBytes + 1);
  });
});

describe("③ の形の確認（02 §2.2）", () => {
  it("宣言が空でない文字列でなければ断る", () => {
    expect(checkWriteOutput({ declaration: SAMPLE_DECLARATION }).ok).toBe(true);
    expect(checkWriteOutput({ declaration: "" }).ok).toBe(false);
    expect(checkWriteOutput({ declaration: 1 }).ok).toBe(false);
    expect(checkWriteOutput({}).ok).toBe(false);
    expect(checkWriteOutput("nope").ok).toBe(false);
  });
});

// ── 4. 役割 ID → 宣言の名前の対応を提出する（02 §1・Issue #308）────────

describe("③ は役割 ID → 宣言の名前の対応を提出する（02 §1・Issue #308）", () => {
  const MAPPINGS = [
    { roleId: "record", name: "record" },
    { roleId: "record.total", name: "total" },
  ];

  const run = (output: unknown) =>
    runWrite({
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(createRecordingClient([structured(output)]).client, { maxAttempts: 1 }),
    });

  it("提出された対応を、そのまま返す", async () => {
    const outcome = await run({ declaration: SAMPLE_DECLARATION, mappings: MAPPINGS });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mappings).toEqual(MAPPINGS);
  });

  it("対応の欄が無ければ空として扱う（旧形式の記録は壊さない）", async () => {
    const outcome = await run({ declaration: SAMPLE_DECLARATION });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mappings).toEqual([]);
  });

  it("対応の形が合わなければ、欄つきで断る", () => {
    const bad = checkWriteOutput({ declaration: SAMPLE_DECLARATION, mappings: [{ roleId: "", name: 1 }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("mappings[0].roleId");
    expect(fields).toContain("mappings[0].name");
    expect(checkWriteOutput({ declaration: SAMPLE_DECLARATION, mappings: "nope" }).ok).toBe(false);
  });

  it("要求の schema が対応の欄を必須にし、規則が対応の提出を頼む", async () => {
    expect(DECLARATION_SCHEMA.required).toContain("mappings");
    expect(DECLARATION_SCHEMA.properties.mappings.type).toBe("array");
    const recording = createRecordingClient([structured({ declaration: SAMPLE_DECLARATION, mappings: MAPPINGS })]);
    await runWrite({
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect((request?.rules ?? []).join("\n")).toContain("mappings");
  });
});
