// Jev（TypeSafe の System One）の判定の adapter（05-judge-model.md §1・§4）。
//
// 共通の判定の口（`Judge`。judge.ts）を、`POST https://api.typesafe.ai/v1/systemone` で実装する。
// **鍵と `fetch` は呼ぶ側から渡す**（adapter は環境変数を読まない。§4・R-15）。手元でも Worker でも
// 同じものが動くように、Cloudflare 固有の API も Node 固有の API も使わない。
//
// 決めごと（§1・§4）：
//   * モデルは既定で **`jev-1.13.0` に固定**する（`jev-latest` は既定にしない）。
//   * 429・529 は指数の待ちで再試行する（回数の上限あり）。**401・422 は再試行しない**失敗の種類にする。
//   * 応答の `model`（答えた版の ID）を結果に残す（§8 U-J3）。
//   * 使った入力のトークン数を結果に残す（出力は無料。§5）。費用は呼ぶ側が budget.ts の Jev の単価で
//     予約・精算する（「判定の adapter は費用を数えない」——OpenAI の adapter と同じ。§1.5）。
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest, JudgeResponse } from "./judge.js";

/** System One の入口（1 か所に固定する。環境変数からは読まない。§1） */
const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

/** 既定のモデル（**版の ID を固定する**。`jev-latest` は既定にしない。§1） */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** 再試行を含む既定の試行の回数（1 + 3 回の再試行。§4） */
export const DEFAULT_JEV_MAX_ATTEMPTS = 4;

/** 指数の待ちの基準（ミリ秒。待ちは `基準 × 2^(試行 - 1)`。§1） */
export const DEFAULT_JEV_RETRY_BASE_MS = 1_000;

/** 混み合っているときに待って再試行する状態コード（§1） */
const RETRYABLE_STATUSES: readonly number[] = [429, 529];

/** fetch の差し替え口。Workers・ブラウザ・Node のどれでも同じ形で呼べる範囲だけを要求する（§4） */
export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * adapter の誤りの種類（§1・§4）。呼ぶ側（落とす組み合わせ）が「LLM に落とすか」を種類で分けられる
 * ようにする。**429・529 は再試行の上限でだけ `unavailable` になる**（401・422 は再試行しない）。
 */
export type JevErrorKind =
  /** fetch 自体が失敗した（応答が返らなかった） */
  | "network"
  /** 呼び出しが打ち切られた（合図が中断した） */
  | "timeout"
  /** 鍵が正しくない（HTTP 401）。**再試行しない** */
  | "unauthorized"
  /** 要求が不正（HTTP 422）。**再試行しない** */
  | "invalidRequest"
  /** 混み合っている（429・529）ため、再試行の上限に達した */
  | "unavailable"
  /** その他の HTTP の誤り（状態コード付き）。**再試行しない** */
  | "http"
  /** 形が合わない応答（JSON でない・答えが無い） */
  | "malformed";

/** adapter が投げる型付きの誤り（§1）。`kind` で分類し、HTTP の誤りは `status` を持つ */
export class JevAdapterError extends Error {
  readonly kind: JevErrorKind;
  /** HTTP の誤りの状態コード（それ以外は `undefined`） */
  readonly status: number | undefined;

  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = "JevAdapterError";
    this.kind = kind;
    this.status = status;
  }
}

/** adapter を作る関数の引数 */
export interface JevJudgeOptions {
  /** API キー。**環境変数からは読まない**。呼ぶ側が渡す（§4） */
  readonly apiKey: string;
  /** モデル（既定 `jev-1.13.0`。§1） */
  readonly model?: string;
  /** 差し込む `fetch`（既定 `globalThis.fetch`。§4） */
  readonly fetch?: JevFetch;
  /** 再試行を含む試行の回数（既定 `DEFAULT_JEV_MAX_ATTEMPTS`。§4） */
  readonly maxAttempts?: number;
  /** 指数の待ちの基準（ミリ秒。既定 `DEFAULT_JEV_RETRY_BASE_MS`。§1） */
  readonly retryBaseMs?: number;
  /** 待つ処理（試験では待たずに済むよう差し替える。既定は `setTimeout`） */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 打ち切りの合図（任意） */
  readonly signal?: AbortSignal;
}

/**
 * Jev の判定の adapter を作る（§1・§4）。`fetch` を差し込めるので、試験は実 API を呼ばずに要求の中身と
 * 再試行の様子を観測できる。
 */
export function createJevJudge(options: JevJudgeOptions): Judge {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new Error("fetch がありません。options.fetch で渡してください");
  }
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const maxAttempts = options.maxAttempts ?? DEFAULT_JEV_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("試行の回数は 1 以上の整数であること");
  }
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_JEV_RETRY_BASE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const body = buildBody(request, model);
      let lastStatus: number | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const response = await send(fetchImpl, body, options.apiKey, options.signal);
        if (RETRYABLE_STATUSES.includes(response.status)) {
          lastStatus = response.status;
          // 上限まで来たら再試行せず、失敗の種類（unavailable）にして呼ぶ側（落とす組み合わせ）へ渡す
          if (attempt < maxAttempts) {
            await sleep(retryBaseMs * 2 ** (attempt - 1));
            continue;
          }
          throw new JevAdapterError(
            "unavailable",
            `Jev が混み合っています（HTTP ${response.status}、${maxAttempts} 回試しました）`,
            response.status,
          );
        }
        if (!response.ok) throw httpError(response.status);
        const wire = await parseJson(response);
        return toResult(wire, request.questions, model);
      }
      // ループは必ず return か throw で抜けるが、型のために最後の失敗を置く
      throw new JevAdapterError("unavailable", "再試行の上限に達しました", lastStatus);
    },
  };
}

// ── 呼び出し（§4）─────────────────────────────────────────────────────

/** 1 回の実呼び出し。鍵は `Authorization: Bearer` で送る（§4） */
async function send(
  fetchImpl: JevFetch,
  body: unknown,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetchImpl(SYSTEMONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new JevAdapterError("timeout", "呼び出しが打ち切られました");
    }
    throw new JevAdapterError("network", `fetch が失敗しました: ${messageOf(error)}`);
  }
}

/**
 * HTTP の誤りを分類する（§1）。**401・422 は再試行しない失敗の種類にする**——401 は鍵、422 は要求の形の
 * 誤りで、同じ要求のまま待っても直らない。本文の全文は残さず、種類と状態コードだけを持つ。
 */
function httpError(status: number): JevAdapterError {
  if (status === 401) {
    return new JevAdapterError("unauthorized", "鍵が正しくありません（HTTP 401）", status);
  }
  if (status === 422) {
    return new JevAdapterError("invalidRequest", "要求が不正です（HTTP 422）", status);
  }
  return new JevAdapterError("http", `HTTP の誤り（HTTP ${status}）`, status);
}

// ── 要求の組み立て（§1）───────────────────────────────────────────────

/** System One の body（`state`・`model`・`questions`）にする（§1） */
function buildBody(request: JudgeRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    questions[name] = toWireQuestion(question);
  }
  return { state: request.state, model, questions };
}

/** 問いを wire の形（`type`・`instructions`・`criteria`）に直す（§1） */
function toWireQuestion(question: JudgeQuestion): Record<string, unknown> {
  const wire: Record<string, unknown> = { type: question.kind, instructions: question.instructions };
  if (question.criteria !== undefined) wire.criteria = question.criteria;
  return wire;
}

// ── 応答の解釈（§1）───────────────────────────────────────────────────

/** 応答の本文を object として読む。JSON でない・object でないときは `malformed`（§1） */
async function parseJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new JevAdapterError("malformed", `応答の本文を読めませんでした: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevAdapterError("malformed", "応答が JSON として読めません");
  }
  if (!isRecord(parsed)) {
    throw new JevAdapterError("malformed", "応答が object ではありません");
  }
  return parsed;
}

/** 応答を、判定の口の答えに直す（§1）。応答の `model` を結果に残す（§8 U-J3） */
function toResult(
  wire: Record<string, unknown>,
  questions: Readonly<Record<string, JudgeQuestion>>,
  requestedModel: string,
): JudgeResponse {
  const rawAnswers = wire.answers;
  if (!isRecord(rawAnswers)) {
    throw new JevAdapterError("malformed", "応答に answers がありません");
  }
  const answers: Record<string, JudgeAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = rawAnswers[name];
    if (raw === undefined) {
      throw new JevAdapterError("malformed", `応答に問い ${name} の答えがありません`);
    }
    answers[name] = toAnswer(question, raw);
  }
  const model = typeof wire.model === "string" && wire.model !== "" ? wire.model : requestedModel;
  return { answers, inputTokens: readInputTokens(wire.usage), model, answeredBy: "jev" };
}

/** 問いごとに、wire の答えを判定の口の答えに直す（§1） */
function toAnswer(question: JudgeQuestion, raw: unknown): JudgeAnswer {
  if (!isRecord(raw)) {
    throw new JevAdapterError("malformed", "答えが object ではありません");
  }
  const probability = readUnit(raw.probability);
  const confidence = readUnit(raw.confidence);
  if (question.kind === "noul") {
    const noul = raw.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) {
      throw new JevAdapterError("malformed", "noul の答えが数ではありません");
    }
    return { kind: "noul", noul: Math.min(1, Math.max(0, noul)) };
  }
  if (question.kind === "choice") {
    return { kind: "choice", choice: readLabel(raw.choice), probability, confidence };
  }
  return { kind: "score", score: readLabel(raw.score), probability, confidence };
}

/** 選択肢の名前（文字列）を読む。文字列でなければ `malformed`（§1） */
function readLabel(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new JevAdapterError("malformed", "選択の答えが文字列ではありません");
  }
  return value;
}

/** 確率・確信度（0〜1）を読む。無い・範囲外のときは `undefined`（「不明」）にする（§1） */
function readUnit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** `usage.input_tokens`（使ったトークン数）を読む。無い・壊れているときは 0（§5） */
function readInputTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const value = usage.input_tokens;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
