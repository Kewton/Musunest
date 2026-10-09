// 記録した応答を返す偽物の LlmClient（02 §2.1「試験用に、記録した応答を返す偽物を置く」）。
//
// CI は API を呼ばない（CLAUDE.md・§2.1）。記録は**順に**返し、尽きたら誤りにする。
// 記録の順は会話の順である。種別（構造化出力・道具付き）が食い違うときも誤りにする。
import type {
  LlmClient,
  LlmStructuredResponse,
  LlmToolCall,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";

/** 記録した構造化出力の 1 回 */
export interface RecordedStructuredCall {
  readonly kind: "structured";
  readonly output: unknown;
  readonly usage: LlmUsage | undefined;
}

/** 記録した道具付きの 1 回 */
export interface RecordedToolCall {
  readonly kind: "tools";
  readonly toolCalls: readonly LlmToolCall[];
  readonly usage: LlmUsage | undefined;
}

/** 記録した 1 回の呼び出し（構造化出力か道具付き） */
export type RecordedCall = RecordedStructuredCall | RecordedToolCall;

/** 記録を使い切った、または記録の種別が食い違ったときに投げる誤り */
export class FakeLlmExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeLlmExhaustedError";
  }
}

const exhausted = (used: number): FakeLlmExhaustedError =>
  new FakeLlmExhaustedError(`記録した応答が尽きました（${used} 件を使い切りました）`);

const kindMismatch = (expected: RecordedCall["kind"], actual: RecordedCall["kind"]): FakeLlmExhaustedError =>
  new FakeLlmExhaustedError(`記録した応答の種別が違います（期待 ${expected}、記録 ${actual}）`);

/**
 * 記録した応答を順に返す偽物の LlmClient。試験はこれで閉じる（実 API を呼ばない）。
 * 記録が尽きたら `FakeLlmExhaustedError` を投げる。
 */
export function createFakeLlmClient(recorded: readonly RecordedCall[]): LlmClient {
  let index = 0;
  return {
    async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      const call = recorded[index];
      if (call === undefined) throw exhausted(index);
      if (call.kind !== "structured") throw kindMismatch("structured", call.kind);
      index += 1;
      return { output: call.output as T, usage: call.usage };
    },
    async callWithTools(): Promise<LlmToolResponse> {
      const call = recorded[index];
      if (call === undefined) throw exhausted(index);
      if (call.kind !== "tools") throw kindMismatch("tools", call.kind);
      index += 1;
      return { toolCalls: call.toolCalls, usage: call.usage };
    },
  };
}
