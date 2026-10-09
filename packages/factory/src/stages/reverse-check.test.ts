// ①' 逆照合（stages/reverse-check.ts）の unit テスト（02 §1・§1.2）。
//
// ここで固定したいのは 3 つ。
//   1. 原文に無い引用・位置のずれ・どの要件にも覆われない原文の文を、**コードが**見つける
//   2. 落ちがあれば ① をやり直し、やり直しても残る落ちを未達として返す
//   3. ①' が送る要求を観測する（規則とデータが別・原文と一覧だけ・JSON Schema が付く）
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../pipeline.js";
import {
  REVERSE_CHECK_SCHEMA_NAME,
  checkRequirementCoverage,
  runReverseCheck,
  runReverseCheckLoop,
  splitSourceSentences,
} from "./reverse-check.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  REVERSE_CHECK_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

/** 引用が原文に無い一覧（①' の落ちを起こす） */
const BAD_LIST_OUTPUT = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を数える", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

const BAD_LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を数える", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

describe("コードが見つける落ち（02 §1・§1.2）", () => {
  it("原文を文に切り分ける（前後の空白を除く）", () => {
    expect(splitSourceSentences("タスクを記録する。件数を合計する。")).toEqual([
      { start: 0, end: 9 },
      { start: 9, end: 17 },
    ]);
  });

  it("引用が原文に無ければ quote-not-found", () => {
    const misses = checkRequirementCoverage(SOURCE_TEXT, BAD_LIST);
    expect(misses.map((miss) => miss.kind)).toContain("quote-not-found");
    const miss = misses.find((candidate) => candidate.kind === "quote-not-found");
    expect(miss?.requirementId).toBe("R-2");
  });

  it("引用はあるが位置がずれていれば position-mismatch", () => {
    const shifted: RequirementList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 1, end: 9 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const misses = checkRequirementCoverage(SOURCE_TEXT, shifted);
    expect(misses.some((miss) => miss.kind === "position-mismatch")).toBe(true);
  });

  it("どの要件にも覆われない原文の文を uncovered-source として見つける", () => {
    const partial: RequirementList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const misses = checkRequirementCoverage(SOURCE_TEXT, partial);
    const uncovered = misses.filter((miss) => miss.kind === "uncovered-source");
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]).toMatchObject({ kind: "uncovered-source", range: { start: 9, end: 17 } });
  });

  it("引用と位置が合い、原文の文が覆われていれば、落ちは無い", () => {
    expect(checkRequirementCoverage(SOURCE_TEXT, REQUIREMENT_LIST)).toEqual([]);
  });
});

describe("①' → ① のやり直し（02 §1）", () => {
  it("落ちが無ければやり直さない", async () => {
    const recording = createRecordingClient([
      structured({
        requirements: REQUIREMENT_LIST.requirements,
        decisions: REQUIREMENT_LIST.decisions,
        unresolved: REQUIREMENT_LIST.unresolved,
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.unmet).toEqual([]);
  });

  it("落ちがあれば ① をやり直し、やり直しても残る落ちを未達として返す", async () => {
    const recording = createRecordingClient([
      structured(BAD_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(BAD_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.unmet.map((miss) => miss.kind)).toContain("quote-not-found");
    // ① → ①' → ①（やり直し） → ①' の 4 回が呼ばれる
    expect(recording.structured).toHaveLength(4);
  });
});

describe("①' が送る要求を観測する（02 §2.2・§1.2）", () => {
  it("原文と一覧だけをデータに置き、JSON Schema を付け、規則とデータを分ける", async () => {
    const recording = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    const outcome = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 原文と一覧の 2 つだけ
    expect(request.input.match(/<data name=/g)).toHaveLength(2);
    expect(request.input).toContain(SOURCE_TEXT);
    expect(request.input).toContain("要件の一覧");
    expect(request.instructions).not.toContain(SOURCE_TEXT);
    expect(request.schemaName).toBe(REVERSE_CHECK_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("原文に仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    await runReverseCheck({
      source: `${SOURCE_TEXT}${INJECTED_INSTRUCTION}`,
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("会話が挙げた覆われていない部分も、コードの落ちに足す（範囲外は捨てる）", async () => {
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 0, end: 3 }, { start: 90, end: 99 }] }),
    ]);
    const outcome = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    expect(ranges).toContain("0-3");
    expect(ranges).not.toContain("90-99");
  });
});

describe("①' の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ uncovered: "nope" }), structured({ uncovered: "nope" })]);
    const failed = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");

    const recovered = createRecordingClient([structured({ uncovered: "nope" }), structured(REVERSE_CHECK_OUTPUT)]);
    const retried = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recovered.client),
    });
    expect(retried.ok).toBe(true);
  });
});
