// ⑤a 対応表（stages/correspondence.ts）の unit テスト（02 §1・F-2・F-8・R-1）。
//
// ここで固定したいのは 4 つ。
//   1. コードが確かめる：宣言に無い名前・画面から辿れない計算を落ちにし、`show` を省略して全部を出す
//      一覧の計算は落ちにしないこと
//   2. 要件の対応そのものが無いことも落ちにすること
//   3. 送った要求を観測する：原文・要件の一覧・宣言の 3 つだけをデータに置き、JSON Schema を付け、
//      規則とデータを分け、受入の題材の言葉を使わないこと
//   4. 偽物が受け取った要求を読む（予定の答えを返すだけの試験で閉じない）
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { normalizeSpec } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import type { CorrespondenceEntry, Declaration } from "../pipeline.js";
import {
  CORRESPONDENCE_SCHEMA_NAME,
  checkCorrespondence,
  checkCorrespondenceOutput,
  runCorrespondence,
  type CorrespondenceInput,
} from "./correspondence.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 手で書いた宣言（抽象的な題材。受入の題材の言葉は使わない） */
const DECLARATION_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      title: string",
  "      amount: number",
  "  - name: other",
  "    fields:",
  "      count: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [title, amount, total]",
  "  - name: others",
  "    type: table",
  "    entity: other",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: total",
  "    entity: record",
  "    expression: amount * 2",
  "    type: number",
  "  - name: hidden",
  "    entity: record",
  "    expression: amount + 1",
  "    type: number",
  "  - name: otherTotal",
  "    entity: other",
  "    expression: count * 2",
  "    type: number",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const DECLARATION: Declaration = { source: DECLARATION_SOURCE };

const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(" / ")}`);
  }
  return result.app;
};

const APP = await normalized(DECLARATION_SOURCE);

const entry = (
  requirementId: string,
  locations: readonly CorrespondenceEntry["locations"][number][],
): CorrespondenceEntry => ({ requirementId, locations });

describe("コードが確かめる（実在・画面からの到達。02 §1）", () => {
  it("宣言に無い名前を落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "field", entity: "record", name: "missing" }]),
      entry("R-2", [{ kind: "computation", entity: "other", name: "otherTotal" }]),
    ]);
    const miss = misses.find((candidate) => candidate.location?.name === "missing");
    expect(miss).toBeDefined();
    expect(miss?.detail).toContain("missing");
  });

  it("画面から辿れない計算を落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
      entry("R-2", [{ kind: "computation", entity: "record", name: "hidden" }]),
    ]);
    const miss = misses.find((candidate) => candidate.location?.name === "hidden");
    expect(miss).toBeDefined();
    expect(miss?.detail).toContain("画面から辿れない");
  });

  it("`show` を省略して全部を出す一覧の計算は、画面から辿れる（落ちにしない）", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
      entry("R-2", [{ kind: "computation", entity: "other", name: "otherTotal" }]),
    ]);
    expect(misses).toEqual([]);
  });

  it("要件の対応そのものが無いことも落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
    ]);
    const miss = misses.find((candidate) => candidate.requirementId === "R-2");
    expect(miss).toBeDefined();
    expect(miss?.location).toBeUndefined();
    expect(miss?.detail).toContain("R-2");
  });
});

describe("⑤a の形の確認（02 §2.2）", () => {
  it("場所の形が合わなければ、欄つきで断る", () => {
    const bad = checkCorrespondenceOutput({
      entries: [{ requirementId: "", locations: [{ kind: "nope", entity: 1, name: "" }] }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("entries[0].requirementId");
    expect(fields).toContain("entries[0].locations[0].kind");
    expect(fields).toContain("entries[0].locations[0].name");
  });

  it("対応表の並びでなければ断る", () => {
    expect(checkCorrespondenceOutput({ entries: {} }).ok).toBe(false);
    expect(checkCorrespondenceOutput(null).ok).toBe(false);
  });
});

describe("⑤a が送る要求を観測する（02 §2.2・§1）", () => {
  const answer = {
    entries: [
      { requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] },
      { requirementId: "R-2", locations: [{ kind: "computation", entity: "other", name: "otherTotal" }] },
    ],
  };

  it("原文・要件の一覧・宣言の 3 つだけをデータに置き、JSON Schema を付ける", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const outcome = await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input.match(/<data name=/g)).toHaveLength(3);
    expect(request.input).toContain("原文");
    expect(request.input).toContain("要件の一覧");
    expect(request.input).toContain("宣言");
    expect(request.input).toContain(DECLARATION_SOURCE);
    expect(request.instructions).not.toContain(DECLARATION_SOURCE);
    expect(request.schemaName).toBe(CORRESPONDENCE_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("原文に仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    await runCorrespondence({
      source: `${SOURCE_TEXT}${INJECTED_INSTRUCTION}`,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("渡すと決めていない文脈（余分な欄）は、データにも規則にも入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const withExtra = {
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      testSuiteSentinel: "SUITE_SENTINEL",
    } as unknown as CorrespondenceInput;
    await runCorrespondence(withExtra);
    const request = recording.structured[0];
    expect(request?.input).not.toContain("SUITE_SENTINEL");
    expect(request?.instructions).not.toContain("SUITE_SENTINEL");
  });
});

describe("⑤a の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ entries: "nope" }), structured({ entries: "nope" })]);
    const failed = await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");
  });
});
