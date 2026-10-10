// 段の共通のプロンプトと窓口（stages/prompt.ts）の unit テスト（02 §2.2）。
//
// ここで固定したいのは 3 つ。
//   1. 規則とデータが別の入力であること・データに仕込んだ「規則を無視せよ」が規則の側へ入らないこと
//   2. 構造化出力の要求には JSON Schema が付き、文書は呼ぶ側から渡ったものだけが入ること
//   3. 形が合わない応答は 1 回だけやり直し、誤りは種類ごとに段の失敗になること（拒否はやり直さない。#302）
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "../llm.js";
import { OpenAiIncompleteError } from "../openai.js";
import {
  DATA_IS_NOT_INSTRUCTIONS_RULE,
  buildStructuredRequest,
  callStructuredChecked,
  constraintExcerpt,
  constraintIdsIn,
  isRecord,
  type ShapeCheck,
  type StructuredPlan,
} from "./prompt.js";
import {
  INJECTED_INSTRUCTION,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

const REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "入力",
  schemaName: "sample",
  schema: { type: "object" },
  maxOutputTokens: 100,
};

interface NValue {
  readonly n: number;
}

function checkN(output: unknown): ShapeCheck<NValue> {
  if (!isRecord(output) || typeof output["n"] !== "number") {
    return { ok: false, problems: [{ field: "n", message: "数であること" }] };
  }
  return { ok: true, value: { n: output["n"] } };
}

const PLAN: StructuredPlan<NValue> = { request: REQUEST, check: checkN };

/** 拒否（refusal）を表す誤り（adapter が投げる形をまねる。#302） */
const refusalError = (): Error => Object.assign(new Error("モデルが拒否しました"), { kind: "refusal" });

describe("規則とデータを分ける（02 §2.2）", () => {
  it("規則は instructions に、データは input にだけ置く", () => {
    const request = buildStructuredRequest({
      rules: ["段の規則"],
      documents: SAMPLE_DOCUMENTS,
      data: [
        { name: "原文", text: `タスクを記録する。${INJECTED_INSTRUCTION}` },
        { name: "要件の一覧", text: "[]" },
      ],
      schemaName: "sample",
      schema: { type: "object" },
      maxOutputTokens: 100,
    });

    // instructions には共通の規則だけが入る（段ごとの規則は入らない）
    expect(request.instructions).toContain(DATA_IS_NOT_INSTRUCTIONS_RULE);
    expect(request.instructions).not.toContain("段の規則");
    // 段ごとの規則は rules に入る（文書の後ろ・データの前に置かれる）
    expect(request.rules).toEqual(["段の規則"]);
    // データの中身は input の側にだけ入る
    expect(request.input).toContain("タスクを記録する。");
    expect(request.input).toContain("要件の一覧");
    // データに仕込んだ「規則を無視せよ」は、規則の側に入らない
    expect(request.input).toContain(INJECTED_INSTRUCTION);
    expect(request.instructions).not.toContain(INJECTED_INSTRUCTION);
    // データは規則の側に入らない
    expect(request.instructions).not.toContain("タスクを記録する。");
    // 文書は渡したものだけ
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
  });

  it("JSON Schema を付ける", () => {
    const request = buildStructuredRequest({
      rules: [],
      documents: [],
      data: [{ name: "原文", text: "タスクを記録する。" }],
      schemaName: "requirement-list",
      schema: { type: "object", required: ["requirements"] },
      maxOutputTokens: 100,
    });
    expect(request.schemaName).toBe("requirement-list");
    expect(request.schema).toEqual({ type: "object", required: ["requirements"] });
  });

  it("受入の題材の言葉を、規則・データ・文書のどこにも使わない", () => {
    const request = buildStructuredRequest({
      rules: ["段の規則"],
      documents: SAMPLE_DOCUMENTS,
      data: [{ name: "原文", text: "タスクを記録する。件数を合計する。" }],
      schemaName: "sample",
      schema: { type: "object" },
      maxOutputTokens: 100,
    });
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });
});

describe("形が合わない応答は 1 回だけやり直す（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回目が合えば通る", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { bad: true }, usage: undefined },
      { kind: "structured", output: { n: 7 }, usage: undefined },
    ]);
    const outcome = await callStructuredChecked(makeGateway(recording.client), PLAN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ n: 7 });
    expect(recording.structured).toHaveLength(2);
  });

  it("形が合わない応答が 2 回続くと段の失敗になる", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { bad: true }, usage: undefined },
      { kind: "structured", output: { also: "bad" }, usage: undefined },
    ]);
    const outcome = await callStructuredChecked(makeGateway(recording.client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    expect(recording.structured).toHaveLength(2);
  });

  it("拒否は、拒否として段の失敗にし、やり直さない（02 §2.2・#302）", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        throw refusalError();
      },
      async callWithTools(): Promise<LlmToolResponse> {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("refused");
    // 拒否はやり直さない（#302。§2.2「1 回だけやり直す」は形が合わない応答に限る）
    expect(calls).toBe(1);
  });

  it("分類できない例外は unknown として段の失敗にし、拒否に混ぜず、やり直さない（02 §2.2・#302）", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        throw new Error("分類できない");
      },
      async callWithTools(): Promise<LlmToolResponse> {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unknown");
    expect(calls).toBe(1);
  });
});

describe("未完了の応答は、拒否と分けて段の失敗にする（02 §2.2・§1.5）", () => {
  it("拒否ではなく incomplete（理由付き）にし、同じ要求のままやり直さない", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured() {
        calls += 1;
        throw new OpenAiIncompleteError("max_output_tokens", undefined, "応答が完了していません");
      },
      async callWithTools() {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "incomplete", reason: "max_output_tokens" });
    expect(calls).toBe(1);
  });
});

// ── 文書の本文から制約 ID を取り出す（02 §1・②・Issue #332）──────────────

describe("制約 ID の取り出しと、節の抜粋（Issue #332）", () => {
  it("契約の規則の R-… と、語彙の意味の ### 見出しを、制約 ID として取り出す", () => {
    const ids = constraintIdsIn(SAMPLE_DOCUMENTS);
    expect(ids.has("R-1")).toBe(true);
    expect(ids.has("R-2")).toBe(true);
    expect(ids.has("R-14")).toBe(true);
    expect(ids.has("記録")).toBe(true);
    expect(ids.has("合計")).toBe(true);
    expect(ids.has("アプリの名前・説明")).toBe(true);
    // 文書に無い ID は入らない
    expect(ids.has("R-999")).toBe(false);
  });

  it("制約 ID の節の抜粋を、見出しとその本文／規則の行から取り出す", () => {
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["アプリの名前・説明"])).toBe(
      "### アプリの名前・説明\nアプリ自体の名前や説明を置く欄は無い。",
    );
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["R-1"])).toBe("R-1 宣言は、閉じた語彙だけを使う。");
    // 知らない ID は何も返さない
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["R-999"])).toBe("");
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, [])).toBe("");
  });
});
