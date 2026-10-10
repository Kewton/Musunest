// 記録した応答を返す偽物の LlmClient（02 §2.1「試験用に、記録した応答を返す偽物を置く」）。
//
// CI は API を呼ばない（CLAUDE.md・§2.1）。記録は**順に**返し、尽きたら誤りにする。
// 記録の順は会話の順である。種別（構造化出力・道具付き）が食い違うときも誤りにする。
//
// **道具の往復の再生**（R-2）：道具付きの記録は、道具の呼び出し（`toolCalls`）か、宣言の確定
// （`done`）のどちらかを返す。呼ぶ側は結果を返信して次のターンを送るので、**こちらが期待する
// 履歴（`turns`）の長さと、直近の道具の呼び出しに返信していることを確かめる**。記録と違う順の
// 要求は `FakeLlmOrderError` にする（往復を再生できているかを、記録に照らして観測できる）。
import { AGENT_LIMITS } from "./limits.js";
import type {
  LlmClient,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmTurn,
  LlmUsage,
} from "./llm.js";
import { ENVELOPE_RESULT_KEY, ENVELOPE_STAGE_KEY } from "./schema-envelope.js";

/** 記録した構造化出力の 1 回 */
export interface RecordedStructuredCall {
  readonly kind: "structured";
  readonly output: unknown;
  readonly usage: LlmUsage | undefined;
}

/** 記録した道具付きの 1 回（応答は「続く」か「終わる」のどちらか） */
export interface RecordedToolCall {
  readonly kind: "tools";
  readonly response: LlmToolResponse;
}

/** 記録した 1 回の呼び出し（構造化出力か道具付き） */
export type RecordedCall = RecordedStructuredCall | RecordedToolCall;

/** 記録を使い切ったときに投げる誤り */
export class FakeLlmExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeLlmExhaustedError";
  }
}

/** 記録と違う順・違う種別の要求が来たときに投げる誤り（往復の再生が崩れた合図） */
export class FakeLlmOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeLlmOrderError";
  }
}

const exhausted = (used: number): FakeLlmExhaustedError =>
  new FakeLlmExhaustedError(`記録した応答が尽きました（${used} 件を使い切りました）`);

const kindMismatch = (expected: RecordedCall["kind"], actual: RecordedCall["kind"]): FakeLlmOrderError =>
  new FakeLlmOrderError(`記録した応答の種別が違います（期待 ${expected}、記録 ${actual}）`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 封筒の応答（`{"result": {…}}`）なら `result` を取り出し、判別子の `stage` を落とす（#353）。adapter
 * （openai.ts）が本物の応答に対して行うのと同じことを、記録に対して行う。封筒を使わない今までの記録は
 * そのまま返す——**封筒の有無にかかわらず、段の試験は今までどおり通る**（#353「守ること」）。
 */
function unwrapRecordedOutput(output: unknown): unknown {
  if (!isRecord(output) || !(ENVELOPE_RESULT_KEY in output)) return output;
  const result = output[ENVELOPE_RESULT_KEY];
  if (!isRecord(result)) return output;
  const unwrapped: Record<string, unknown> = { ...result };
  delete unwrapped[ENVELOPE_STAGE_KEY];
  return unwrapped;
}

/**
 * 往復の順を確かめる。道具付きの呼び出しが k 回目なら、こちらが期待する履歴の長さは 2k である
 * （1 回の呼び出しごとに、助手の呼び出しと道具の結果が 1 つずつ増える）。直近の呼び出しには、
 * その識別子で結果を返していることまで見る（**順の入れ替えと、返信漏れの両方を誤りにする**）。
 */
function checkTurnOrder(turns: readonly LlmTurn[], expectedTurns: number, lastIds: readonly string[]): void {
  if (turns.length !== expectedTurns) {
    throw new FakeLlmOrderError(
      `往復の順が違います（履歴は ${expectedTurns} 項目のはずが ${turns.length} 項目でした）`,
    );
  }
  if (expectedTurns === 0) return;
  const assistant = turns[expectedTurns - 2];
  const tool = turns[expectedTurns - 1];
  if (assistant === undefined || assistant.role !== "assistant") {
    throw new FakeLlmOrderError("往復の順が違います（助手の呼び出しの後に、道具の結果を返すこと）");
  }
  if (tool === undefined || tool.role !== "tool") {
    throw new FakeLlmOrderError("往復の順が違います（最後は道具の結果であること）");
  }
  const actualIds = tool.results.map((result) => result.toolCallId);
  const same =
    actualIds.length === lastIds.length && actualIds.every((id, index) => id === lastIds[index]);
  if (!same) {
    throw new FakeLlmOrderError(
      `往復の順が違います（直近の道具の呼び出し ${lastIds.join("・")} に、結果を返すこと）`,
    );
  }
}

/**
 * 記録した応答を順に返す偽物の LlmClient。試験はこれで閉じる（実 API を呼ばない）。
 * 記録が尽きたら `FakeLlmExhaustedError`、記録と違う順・種別なら `FakeLlmOrderError` を投げる。
 * 記録の行数は上限（`recordRows`）を超えられない（§2.1・§1.5）。
 */
export function createFakeLlmClient(recorded: readonly RecordedCall[]): LlmClient {
  if (recorded.length > AGENT_LIMITS.recordRows) {
    throw new RangeError(
      `記録の行数が上限を超えています（上限 ${AGENT_LIMITS.recordRows}、記録 ${recorded.length}）`,
    );
  }
  let index = 0;
  let expectedTurns = 0;
  let lastToolCallIds: readonly string[] = [];
  return {
    async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      const call = recorded[index];
      if (call === undefined) throw exhausted(index);
      if (call.kind !== "structured") throw kindMismatch("structured", call.kind);
      index += 1;
      return { output: unwrapRecordedOutput(call.output) as T, usage: call.usage };
    },
    async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
      const call = recorded[index];
      if (call === undefined) throw exhausted(index);
      if (call.kind !== "tools") throw kindMismatch("tools", call.kind);
      checkTurnOrder(request.turns, expectedTurns, lastToolCallIds);
      index += 1;
      if (call.response.kind === "toolCalls") {
        expectedTurns += 2;
        lastToolCallIds = call.response.toolCalls.map((toolCall) => toolCall.id);
      }
      return call.response;
    },
  };
}
