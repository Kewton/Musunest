// すべての段の要求で、規則と文書が入力の先頭に同じ並びで置かれ、依頼文がその後ろにあること
// （02 §2「キャッシュ：信頼する規則と文書を入力の先頭に固定し、依頼文は後ろに置く」・§2.2）。
//
// キャッシュに当たった入力を記録に出すには、そもそも前置きが同じ並びで送られている必要がある。
// ここでは、LLM を呼ぶ段を**すべて**（①・①'・②・②'・③・⑤a・⑥・⑥'）回し、偽物が受け取った要求を
// 観測する。**やり直しの要求（① の redo）も含む。** 実 API は呼ばない（偽物と、差し込んだ fetch で閉じる）。
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { normalizeSpec } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { checkTestSuite } from "../../fixed-test.js";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest } from "../../llm.js";
import { createOpenAiLlmClient } from "../../openai.js";
import { runArbitration } from "../arbitrate.js";
import { runCorrespondence } from "../correspondence.js";
import { runDesign } from "../design.js";
import { COMMON_RULES } from "../prompt.js";
import { checkDeclarationVersion, runRepairStep } from "../repair.js";
import { runRequirements } from "../requirements.js";
import { runReverseCheck } from "../reverse-check.js";
import { runTestSuite } from "../test-suite.js";
import { runWrite } from "../write.js";
import {
  CORRESPONDENCE_OUTPUT,
  DECLARATION_SOURCE,
  DESIGN_OUTPUT,
  TEST_SUITE_OUTPUT,
} from "../../__tests__/run.js";
import {
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  makeGateway,
} from "./prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 試験用の共通の口（上限の出所を試すので effort は high に固定する） */
const gatewayFor = (client: LlmClient) => makeGateway(client, { maxAttempts: 1, effort: "high" });

/** 文書が入力の先頭に固定される並び（段によらず同じ） */
const RENDERED_DOCUMENTS: readonly string[] = SAMPLE_DOCUMENTS.map(
  (document) => `${document.name}\n${document.text}`,
);

const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(" / ")}`);
  }
  return result.app;
};

const APP = await normalized(DECLARATION_SOURCE);
const suiteChecked = checkTestSuite(TEST_SUITE_OUTPUT.tests);
if (!suiteChecked.ok) throw new Error("試験の fixture が壊れた");
const SUITE = suiteChecked.suite;
const DECLARATION = { source: DECLARATION_SOURCE };
const CURRENT = await checkDeclarationVersion(DECLARATION, {
  list: REQUIREMENT_LIST,
  suite: SUITE,
  correspondences: [],
});

/** 構造化出力の段を回し、偽物が受け取った要求を返す */
async function structuredRequestOf(run: (client: LlmClient) => Promise<unknown>): Promise<LlmStructuredRequest> {
  const recording = createRecordingClient([structured({})]);
  await run(recording.client);
  const request = recording.structured[0];
  if (request === undefined) throw new Error("構造化出力の要求が記録されていません");
  return request;
}

/** 道具付きの段（⑥）を回し、偽物が受け取った要求を返す */
async function toolRequestOf(run: (client: LlmClient) => Promise<unknown>): Promise<LlmToolRequest> {
  const recording = createRecordingClient([
    {
      kind: "tools",
      response: { kind: "done", declaration: { declaration: DECLARATION_SOURCE, disputes: [] }, usage: undefined },
    },
  ]);
  await run(recording.client);
  const request = recording.tools[0];
  if (request === undefined) throw new Error("道具付きの要求が記録されていません");
  return request;
}

/** 要求を openai の adapter に通し、wire の入力（`input` のテキストの並び）を読む（実 API は呼ばない） */
async function wireInputTexts(request: LlmStructuredRequest | LlmToolRequest): Promise<readonly string[]> {
  const captured: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    captured.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = createOpenAiLlmClient({ apiKey: "test-key", fetch });
  try {
    if ("tools" in request) {
      await client.callWithTools(request);
    } else {
      await client.callStructured(request);
    }
  } catch {
    // schema に合わない応答はここでは問題にしない（読みたいのは送った要求の並びだけ）
  }
  const body = captured[0];
  if (body === undefined) throw new Error("wire の要求が記録されていません");
  const input = body.input as readonly { content: readonly { text: string }[] }[];
  return input.map((item) => item.content[0]?.text ?? "");
}

/** 1 つの要求が、規則と文書を先頭に固定し、依頼文を後ろに置いていることを確かめる */
async function expectPreparedPrefix(request: LlmStructuredRequest | LlmToolRequest): Promise<void> {
  // 規則：共通の規則が先頭にあり、データの囲みは規則の側に入らない
  expect(request.instructions.startsWith(COMMON_RULES[0] ?? "")).toBe(true);
  expect(request.instructions).not.toContain("<data ");
  // 文書：段によらず同じ並びで、そのまま渡る
  expect(request.documents).toEqual(RENDERED_DOCUMENTS);
  // データ：規則とは別の `input` にだけ入る
  expect(request.input.startsWith('<data name="')).toBe(true);
  // wire でも、文書が入力の先頭で、依頼文（データの囲み）がその後ろに置かれる
  const wire = await wireInputTexts(request);
  expect(wire.slice(0, RENDERED_DOCUMENTS.length)).toEqual(RENDERED_DOCUMENTS);
  const data = wire[RENDERED_DOCUMENTS.length];
  expect(data?.startsWith("<data>\n")).toBe(true);
  expect(wire).toHaveLength(RENDERED_DOCUMENTS.length + 1);
}

describe("すべての段の要求で、規則と文書が入力の先頭に同じ並びで置かれる（02 §2・§2.2）", () => {
  it("① 要件にする（やり直しの要求も含む）", async () => {
    const first = await structuredRequestOf((client) =>
      runRequirements({ source: SOURCE_TEXT, documents: SAMPLE_DOCUMENTS, gateway: gatewayFor(client) }),
    );
    await expectPreparedPrefix(first);

    const redo = await structuredRequestOf((client) =>
      runRequirements({
        source: SOURCE_TEXT,
        documents: SAMPLE_DOCUMENTS,
        gateway: gatewayFor(client),
        redo: {
          previous: REQUIREMENT_LIST,
          misses: [{ kind: "quote-not-found", requirementId: "R-9", detail: "引用が見つからない" }],
        },
      }),
    );
    await expectPreparedPrefix(redo);
  });

  it("①' 逆照合", async () => {
    const request = await structuredRequestOf((client) =>
      runReverseCheck({
        source: SOURCE_TEXT,
        list: REQUIREMENT_LIST,
        documents: SAMPLE_DOCUMENTS,
        gateway: gatewayFor(client),
      }),
    );
    await expectPreparedPrefix(request);
  });

  it("② 設計する", async () => {
    const recording = createRecordingClient([structured(DESIGN_OUTPUT)]);
    await runDesign({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway: gatewayFor(recording.client) });
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が記録されていません");
    await expectPreparedPrefix(request);
  });

  it("②' 試験を作って固定する", async () => {
    const recording = createRecordingClient([structured(TEST_SUITE_OUTPUT)]);
    await runTestSuite({ list: REQUIREMENT_LIST, documents: SAMPLE_DOCUMENTS, gateway: gatewayFor(recording.client) });
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が記録されていません");
    await expectPreparedPrefix(request);
  });

  it("③ 書く", async () => {
    const recording = createRecordingClient([structured({ declaration: DECLARATION_SOURCE })]);
    await runWrite({
      list: REQUIREMENT_LIST,
      design: DESIGN_OUTPUT,
      documents: SAMPLE_DOCUMENTS,
      gateway: gatewayFor(recording.client),
    });
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が記録されていません");
    await expectPreparedPrefix(request);
  });

  it("⑤a 対応表", async () => {
    const recording = createRecordingClient([structured(CORRESPONDENCE_OUTPUT)]);
    await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: gatewayFor(recording.client),
    });
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が記録されていません");
    await expectPreparedPrefix(request);
  });

  it("⑥ 直す（道具付き）", async () => {
    const request = await toolRequestOf((client) =>
      runRepairStep({
        source: SOURCE_TEXT,
        list: REQUIREMENT_LIST,
        suite: SUITE,
        current: CURRENT,
        correspondences: [],
        documents: SAMPLE_DOCUMENTS,
        gateway: gatewayFor(client),
      }),
    );
    await expectPreparedPrefix(request);
  });

  it("⑥' 期待の裁定", async () => {
    const recording = createRecordingClient([
      structured({ decisions: [{ testId: "t1", verdict: "uphold", reason: "原文のとおり", quote: "" }] }),
    ]);
    await runArbitration({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      suite: SUITE,
      declaration: DECLARATION,
      disputes: [{ testId: "t1", quote: "件数を合計する" }],
      documents: SAMPLE_DOCUMENTS,
      gateway: gatewayFor(recording.client),
    });
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が記録されていません");
    await expectPreparedPrefix(request);
  });
});
