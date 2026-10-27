// 偽物の LlmClient（02 §2.1）の unit テスト。Issue #282 の受入条件のうち、偽物に閉じる分。
//
// ここで固定したいのは 4 つ。
//   1. 道具の呼び出し → 結果の返信 → 次のターン → 宣言の確定、の往復を**再生**できる（R-2）
//   2. 記録と違う順の要求（履歴の長さ・返信先の識別子）は誤りにする
//   3. 記録した応答と usage を順に返し、尽きたら誤りになる（実 API を呼ばない）
//   4. 記録の行数は上限（`recordRows`）を超えられない（§1.5）
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "./limits.js";
import type { LlmStructuredRequest, LlmToolRequest, LlmTurn, LlmUsage } from "./llm.js";
import {
  FakeLlmExhaustedError,
  FakeLlmOrderError,
  FakeLlmSchemaMismatchError,
  createFakeLlmClient,
  uncheckedBecause,
  type RecordedCall,
} from "./llm-fake.js";
import { ENVELOPE_RESULT_KEY, ENVELOPE_STAGE_KEY } from "./schema-envelope.js";
import { draftOf, fixtureList, fixtureTable, t1ResponseOf, withAggregates } from "./v11a/__tests__/fixtures.js";
import { NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf } from "./v11a/stages/name-table.js";
import { PROPERTY_LEDGER_VIEW } from "./v12/ledger.js";

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "依頼文",
  schemaName: "requirement-list",
  schema: { type: "object" },
  maxOutputTokens: 100,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 100,
};

const USAGE_A: LlmUsage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 1 };
const USAGE_B: LlmUsage = { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 0 };

/** 助手の呼び出しと、その結果の返信（こちらで組み立てて毎回送る履歴。§2） */
const replyTurns = (toolCalls: readonly { id: string; name: string }[]): readonly LlmTurn[] => [
  { role: "assistant", toolCalls: toolCalls.map((call) => ({ ...call, arguments: {} })) },
  {
    role: "tool",
    results: toolCalls.map((call) => ({ toolCallId: call.id, name: call.name, output: { ok: true } })),
  },
];

describe("偽物の LlmClient（02 §2.1・R-2）", () => {
  it("道具の呼び出し → 結果の返信 → 次のターン → 宣言の確定、の往復を再生する", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: {
          kind: "toolCalls",
          toolCalls: [{ id: "call-1", name: "staticCheck", arguments: {} }],
          usage: USAGE_A,
        },
      },
      { kind: "tools", response: { kind: "done", declaration: { entity: "item" }, usage: USAGE_B } },
    ]);

    const first = await client.callWithTools(TOOL_REQUEST);
    expect(first.kind).toBe("toolCalls");
    if (first.kind !== "toolCalls") return;
    expect(first.toolCalls).toEqual([{ id: "call-1", name: "staticCheck", arguments: {} }]);
    expect(first.usage).toBe(USAGE_A);

    const second = await client.callWithTools({
      ...TOOL_REQUEST,
      turns: replyTurns([{ id: "call-1", name: "staticCheck" }]),
    });
    expect(second.kind).toBe("done");
    if (second.kind !== "done") return;
    expect(second.declaration).toEqual({ entity: "item" });
    expect(second.usage).toBe(USAGE_B);
  });

  it("結果を返さずに次のターンを送ると、順が違うので誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    // 履歴は 2 項目のはずが、記録のままの 0 項目で来た
    await expect(client.callWithTools(TOOL_REQUEST)).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("助手の呼び出しと道具の結果の順を入れ替えると誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    const [assistant, tool] = replyTurns([{ id: "call-1", name: "t" }]);
    if (assistant === undefined || tool === undefined) throw new Error("前提が壊れた");
    await expect(
      client.callWithTools({ ...TOOL_REQUEST, turns: [tool, assistant] }),
    ).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("直近の呼び出しと違う識別子で結果を返すと誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    await expect(
      client.callWithTools({ ...TOOL_REQUEST, turns: replyTurns([{ id: "call-9", name: "t" }]) }),
    ).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("記録した構造化出力と usage を順に返す", async () => {
    const recorded: readonly RecordedCall[] = [
      { kind: "structured", output: { id: "first" }, usage: USAGE_A },
      { kind: "structured", output: { id: "second" }, usage: USAGE_B },
    ];
    const client = createFakeLlmClient(recorded);

    const first = await client.callStructured<{ id: string }>(STRUCTURED_REQUEST);
    expect(first.output).toEqual({ id: "first" });
    expect(first.usage).toBe(USAGE_A);

    const second = await client.callStructured<{ id: string }>(STRUCTURED_REQUEST);
    expect(second.output).toEqual({ id: "second" });
    expect(second.usage).toBe(USAGE_B);
  });

  it("封筒の記録（result で包んだもの）は、result を取り出し stage を落として返す（#353）", async () => {
    const client = createFakeLlmClient([
      { kind: "structured", output: { result: { stage: "requirement-list", items: [1] } }, usage: USAGE_A },
      { kind: "structured", output: { ok: true }, usage: undefined },
    ]);
    // 封筒の記録は、段が受け取る中身（result）になる
    const enveloped = await client.callStructured<{ items: number[] }>(STRUCTURED_REQUEST);
    expect(enveloped.output).toEqual({ items: [1] });
    // 封筒を使わない記録は、そのまま返る（封筒の有無にかかわらず、段の試験は通る）
    const plain = await client.callStructured<{ ok: boolean }>(STRUCTURED_REQUEST);
    expect(plain.output).toEqual({ ok: true });
  });

  it("usage が無い記録は、usage を undefined にする", async () => {
    const client = createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: undefined }]);
    const response = await client.callStructured<{ ok: boolean }>(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ ok: true });
    expect(response.usage).toBeUndefined();
  });

  it("記録が尽きたら誤りになる", async () => {
    const client = createFakeLlmClient([{ kind: "structured", output: { id: "only" }, usage: USAGE_A }]);
    await client.callStructured(STRUCTURED_REQUEST);
    await expect(client.callStructured(STRUCTURED_REQUEST)).rejects.toBeInstanceOf(FakeLlmExhaustedError);
  });

  it("記録の種別が食い違えば誤りになる", async () => {
    const client = createFakeLlmClient([
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await expect(client.callStructured(STRUCTURED_REQUEST)).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("記録の行数が上限を超えたら断る", () => {
    const tooMany: RecordedCall[] = Array.from({ length: AGENT_LIMITS.recordRows + 1 }, () => ({
      kind: "structured" as const,
      output: null,
      usage: undefined,
    }));
    expect(() => createFakeLlmClient(tooMany)).toThrow(RangeError);
  });
});

// ── 最後の答えだけを求める印を、記録に照らす（Issue #768）──────────────────────────

describe("偽物の LlmClient：最後の答えだけを求める印を記録に照らす（Issue #768）", () => {
  const marked = { ...TOOL_REQUEST, finalAnswerOnly: true };

  it("印を期待した記録は印付きの要求で返り、印の無い記録は印の無い要求で返る", async () => {
    const client = createFakeLlmClient([
      { kind: "tools", finalAnswerOnly: true, response: { kind: "done", declaration: {}, usage: undefined } },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await expect(client.callWithTools(marked)).resolves.toMatchObject({ kind: "done" });
    await expect(client.callWithTools(TOOL_REQUEST)).resolves.toMatchObject({ kind: "done" });
  });

  it("期待した印と要求の印が食い違えば、往復の順の誤りとして止める（有無の両方向）", async () => {
    const expectingMark = createFakeLlmClient([
      { kind: "tools", finalAnswerOnly: true, response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await expect(expectingMark.callWithTools(TOOL_REQUEST)).rejects.toBeInstanceOf(FakeLlmOrderError);

    const expectingNone = createFakeLlmClient([
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await expect(expectingNone.callWithTools(marked)).rejects.toBeInstanceOf(FakeLlmOrderError);
  });
});

// ── 記録した応答を要求の schema に照らす（Issue #590）──────────────────────────

describe("偽物の LlmClient：記録を要求の schema に照らす選択肢（Issue #590）", () => {
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "count"],
    properties: {
      kind: { type: "string", enum: ["alpha", "beta"] },
      count: { type: "integer", minimum: 0 },
    },
  } as const;
  const REQUEST: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: "sample", schema: SCHEMA };
  /** 応答の中身が誤りの文に写らないことを見るための、目印の値 */
  const MARK = "目印の値の文字列";
  const checked = (recorded: readonly RecordedCall[]) => createFakeLlmClient(recorded, { validateAgainstSchema: true });
  const structured = (output: unknown, extra: Partial<RecordedCall> = {}): RecordedCall =>
    ({ kind: "structured", output, usage: undefined, ...extra }) as RecordedCall;

  const mismatch = async (recorded: readonly RecordedCall[], request: LlmStructuredRequest = REQUEST) => {
    const error = await checked(recorded).callStructured(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FakeLlmSchemaMismatchError);
    return error as FakeLlmSchemaMismatchError;
  };

  it("(1) 余計な欄・enum の外の値・required の欠けた記録は、専用の誤りで止まる（添字・名前・箇所があり、応答の中身は無い）", async () => {
    const extra = await mismatch([structured({ kind: "alpha", count: 1, extra: MARK })]);
    expect(extra).toMatchObject({ recordIndex: 0, schemaName: "sample" });
    expect(extra.detail).toBe("余分な欄があります（extra）");
    const outside = await mismatch([structured({ kind: MARK, count: 1 })]);
    expect(outside.detail).toBe("kind: enum のどれでもありません");
    const missing = await mismatch([structured({ kind: "alpha" })]);
    expect(missing.detail).toBe("必須の欄がありません（count）");
    // 2 件目の記録の添字（1 件目は通る）
    const client = checked([structured({ kind: "alpha", count: 1 }), structured({ kind: "beta" })]);
    await client.callStructured(REQUEST);
    const second = (await client.callStructured(REQUEST).catch((caught: unknown) => caught)) as FakeLlmSchemaMismatchError;
    expect(second).toBeInstanceOf(FakeLlmSchemaMismatchError);
    expect(second.recordIndex).toBe(1);
    for (const error of [extra, outside, missing, second]) {
      expect(error.message).not.toContain(MARK);
      expect(error.message).toContain("sample");
    }
  });

  it("合う記録は通り、中身は今までどおり返る", async () => {
    const response = await checked([structured({ kind: "beta", count: 3 })]).callStructured(REQUEST);
    expect(response.output).toEqual({ kind: "beta", count: 3 });
  });

  it("(2) 旗 off の T1 の schema に aggregate を持つ記録を渡すと止まる。旗 on の schema なら通る（v12-cmp2 の型のずれを偽物の層で再現）", async () => {
    const list = fixtureList();
    const record = t1ResponseOf(draftOf(list, withAggregates(fixtureTable())), PROPERTY_LEDGER_VIEW);
    const request = (schema: unknown): LlmStructuredRequest => ({ ...STRUCTURED_REQUEST, schemaName: NAME_TABLE_SCHEMA_NAME, schema });
    const off = await mismatch([structured(record)], request(nameTableSchemaOf()));
    expect(off.detail).toContain("aggregate");
    const on = await checked([structured(record)]).callStructured(request(nameTableSchemaOf(PROPERTY_LEDGER_VIEW)));
    expect(on.output).toEqual(record);
  });

  it("(3) 封筒の形の記録で stage が要求の schema の名前と違えば止まる。合えば result を取り出し stage を落として照らす", async () => {
    const envelope = (stage: string) => structured({ [ENVELOPE_RESULT_KEY]: { [ENVELOPE_STAGE_KEY]: stage, kind: "alpha", count: 2 } });
    const wrong = await mismatch([envelope("other")]);
    expect(wrong.detail).toContain("stage");
    const right = await checked([envelope("sample")]).callStructured(REQUEST);
    expect(right.output).toEqual({ kind: "alpha", count: 2 });
    // 取り出した中身も schema に照らす
    const bad = await mismatch([structured({ [ENVELOPE_RESULT_KEY]: { [ENVELOPE_STAGE_KEY]: "sample", kind: "gamma", count: 2 } })]);
    expect(bad.detail).toContain("enum");
  });

  it("(4) unchecked と理由のある記録は照合を通らず返る。理由の無い unchecked は作れない（型でも実行でも）", async () => {
    const response = await checked([
      structured({ kind: MARK }, { unchecked: uncheckedBecause("負例：enum の外の値を段の形の検査に渡す") }),
    ]).callStructured(REQUEST);
    expect(response.output).toEqual({ kind: MARK });
    expect(() => uncheckedBecause("")).toThrow(RangeError);
    expect(() => uncheckedBecause("  ")).toThrow(RangeError);
    // @ts-expect-error 理由の印（uncheckedBecause が作る値）が無い unchecked は型で作れない
    const withoutReason: RecordedCall = { kind: "structured", output: {}, usage: undefined, unchecked: { reason: "手で書いた理由" } };
    expect(withoutReason.kind).toBe("structured");
  });

  it("(5) 既定（照合なし）の偽物は、schema に合わない記録もそのまま返す", async () => {
    const response = await createFakeLlmClient([structured({ kind: MARK })]).callStructured(REQUEST);
    expect(response.output).toEqual({ kind: MARK });
    const explicitOff = await createFakeLlmClient([structured({ kind: MARK })], { validateAgainstSchema: false }).callStructured(REQUEST);
    expect(explicitOff.output).toEqual({ kind: MARK });
  });
});
