// ① 要件にする（stages/requirements.ts）の unit テスト（02 §1・F-3・F-6）。
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import {
  REQUIREMENTS_SCHEMA_NAME,
  checkRequirementOutput,
  runRequirements,
} from "./requirements.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  REQUIREMENT_LIST_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

describe("① が送る要求を観測する（02 §2.2）", () => {
  it("規則とデータが別で、データは原文だけ・JSON Schema が付く", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 原文はデータの側にだけ入る
    expect(request.input).toContain(SOURCE_TEXT);
    expect(request.instructions).not.toContain(SOURCE_TEXT);
    // データは 1 つ（原文だけ）。要件の一覧などはまだ無い
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
    // JSON Schema が付く
    expect(request.schemaName).toBe(REQUIREMENTS_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    // 文書は渡したものだけ
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("データに仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: `タスクを記録する。${INJECTED_INSTRUCTION}`,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });
});

describe("① の入口の上限（02 §1.5・依頼文の長さ）", () => {
  it("依頼文が上限を超えたら、呼ばずに断る", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: "あ".repeat(AGENT_LIMITS.requestTextChars + 1),
      documents: [],
      gateway: makeGateway(recording.client),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("limit");
    expect(recording.structured).toHaveLength(0);
  });
});

describe("① のやり直し（02 §1・①' の落ちを受けて）", () => {
  it("やり直すときは、前回の一覧と落ちをデータに足し、規則の側には入れない", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      redo: {
        previous: REQUIREMENT_LIST,
        misses: [{ kind: "quote-not-found", requirementId: "R-9", detail: "引用が見つからない" }],
      },
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input).toContain("前回の要件の一覧");
    expect(request.input).toContain("逆照合で見つかった落ち");
    expect(request.instructions).not.toContain("前回の要件の一覧");
  });
});

describe("① の枠の文（Issue #372）", () => {
  it("framing を持つ応答を受け付け、framing の無い応答は空の配列として扱う", () => {
    const source = "タスクを記録する。アプリを作ってください";
    const withFraming = checkRequirementOutput(
      {
        requirements: [
          { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
        ],
        framing: [{ quote: "アプリを作ってください", position: { start: 9, end: 20 } }],
        decisions: [],
        unresolved: [],
      },
      source,
    );
    expect(withFraming.ok).toBe(true);
    if (!withFraming.ok) return;
    expect(withFraming.value.framing).toEqual([
      { quote: "アプリを作ってください", position: { start: 9, end: 20 } },
    ]);

    const withoutFraming = checkRequirementOutput(REQUIREMENT_LIST_OUTPUT);
    expect(withoutFraming.ok).toBe(true);
    if (!withoutFraming.ok) return;
    expect(withoutFraming.value.framing).toEqual([]);
  });

  it("引用が空の framing は、形の誤りになる", () => {
    const bad = checkRequirementOutput({
      requirements: [],
      framing: [{ quote: "", position: { start: 0, end: 1 } }],
      decisions: [],
      unresolved: [],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("framing[0].quote");
  });

  it("位置の範囲の原文と引用が合わない framing は、形の誤りになる", () => {
    const bad = checkRequirementOutput(
      {
        requirements: [],
        framing: [{ quote: "アプリ", position: { start: 0, end: 3 } }],
        decisions: [],
        unresolved: [],
      },
      SOURCE_TEXT,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("framing[0].position");
  });

  it("位置の合わない framing の応答は、1 回だけやり直す（2 回続くと失敗になる）", async () => {
    const badOutput = {
      requirements: [],
      framing: [{ quote: "アプリ", position: { start: 0, end: 3 } }],
      decisions: [],
      unresolved: [],
    };
    const bad = createRecordingClient([
      { kind: "structured", output: badOutput, usage: undefined },
      { kind: "structured", output: badOutput, usage: undefined },
    ]);
    const failed = await runRequirements({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");

    const recovered = createRecordingClient([
      { kind: "structured", output: badOutput, usage: undefined },
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const retried = await runRequirements({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recovered.client),
    });
    expect(retried.ok).toBe(true);
  });
});

describe("① の形の確認", () => {
  it("正しい応答は固定できる", () => {
    const checked = checkRequirementOutput(REQUIREMENT_LIST_OUTPUT);
    expect(checked.ok).toBe(true);
  });

  it("欄の形が合わなければ、欄つきで断る", () => {
    const bad = checkRequirementOutput({
      requirements: [{ id: "", text: "x", quote: 1, position: { start: 3, end: 1 } }],
      decisions: "nope",
      unresolved: [],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("requirements[0].id");
    expect(fields).toContain("requirements[0].quote");
    expect(fields).toContain("requirements[0].position");
    expect(fields).toContain("decisions");
  });

  it("要件の一覧が並びでなければ断る", () => {
    expect(checkRequirementOutput({ requirements: {}, decisions: [], unresolved: [] }).ok).toBe(false);
    expect(checkRequirementOutput("nope").ok).toBe(false);
  });
});
