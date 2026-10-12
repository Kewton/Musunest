// 判定の呼び出しを、生成の予算に結び付ける包み（05-judge-model.md §4・§5・Issue #359）。
//
// 判定の口（`Judge`。judge.ts）は**助言**であって門ではない（§4）。だから、判定の呼び出しも
// **1 回の生成の予算のうち**で数える——Jev の入力トークンも、Jev が使えないときに LLM が答えた
// 呼び出し（推論を含む出力のトークン）も、段の呼び出しと同じ予算である（§1.5・§5）。
//
// ここが引き受けるのは 3 つ。
//
//   1. **呼ぶ前に、その判定の呼び出しの最大費用を予約する**（§1.5）。入力の上界は、渡された
//      `JudgeRequest` を JSON にした長さから出す（1 文字 = 1 トークン。安全側に倒す）。出力の上界は
//      `maxOutputTokens`。**Jev と LLM の両方の単価で見積もり、大きい方を予約する**——どちらが
//      答えるかは呼ぶ前には分からないからである。**予約できなければ判定を呼ばない**（`JudgeBudgetExceededError`。
//      判定は助言なので、走りは止めず申告をそのまま残す。§4・§6）。
//   2. **答えたあとで、実際の費用で精算する**（§5）。**答えた adapter が Jev なら Jev の単価**
//      （入力だけ。出力は無料）、**LLM なら LLM の単価**（入力・キャッシュ・出力）で数える。偽物は
//      費用を掛けない（予約を解く）。
//   3. **答えた adapter ごとの呼び出しの数と、判定の費用（USD）を数える**（§5・Issue #359）。生成の
//      側は、これを要約に写す——段の費用（`provider_cost_usd`）とは別の欄に残す。
//
// **呼び出しが失敗しても、予約は精算する**（`JobBudget.release`。Issue #359）。usage が分からない
// 失敗で予約を残すと、残高が戻らない。判定は助言なので、失敗は呼ぶ側（run.ts）が握って申告を
// そのまま残す（§4・§6）。
//
// **実 API は呼ばない。** ここは差し込まれた `Judge` を受け取るだけで、`fetch` も鍵も環境変数も
// 扱わない（CLAUDE.md の不変条件）。単価は引数で受け取る（コードに埋め込まない）。
import { JEV_RATES, estimateMaxCostUsd, type JobBudget, type Reservation, type TokenRates } from "./budget.js";
import { MAX_TOKENS_PER_CHAR } from "./call.js";
import { DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS } from "./judge-llm.js";
import type { Judge, JudgeRequest, JudgeResponse, JudgeSource } from "./judge.js";
import type { LlmUsage } from "./llm.js";

/**
 * 予約できないときに投げる誤り（Issue #359）。**判定を呼ばずに**、この誤りで返す。呼ぶ側（run.ts）は
 * 握って、申告をそのまま残す（判定は助言。§4）。
 */
export class JudgeBudgetExceededError extends Error {
  /** 予約しようとした最大費用（USD） */
  readonly maxCostUsd: number;
  /** 予約する時点の残高（USD） */
  readonly remainingUsd: number;

  constructor(maxCostUsd: number, remainingUsd: number) {
    super(`判定の予約が残高を超えています（最大 ${maxCostUsd} USD > 残り ${remainingUsd} USD）`);
    this.name = "JudgeBudgetExceededError";
    this.maxCostUsd = maxCostUsd;
    this.remainingUsd = remainingUsd;
  }
}

/** 実際の呼び出しの前に、締切と総呼び出し数の門で止まるとき投げる誤り（締切。Issue #432） */
export class JudgeDeadlineExceededError extends Error {
  constructor() {
    super("判定の締切を過ぎています");
    this.name = "JudgeDeadlineExceededError";
  }
}

/** 実際の呼び出しの前に、総呼び出し数の門で止まるとき投げる誤り（Issue #432） */
export class JudgeCallLimitExceededError extends Error {
  constructor(remaining: number) {
    super(`判定の呼び出しの上限に達しています（残り ${remaining}）`);
    this.name = "JudgeCallLimitExceededError";
  }
}

/**
 * 判定の**実呼び出し**を、生成と共有する締切・総呼び出し数の門に結び付ける（Issue #432）。判定の口は
 * 生成の `CallGateway` を通らないので、ここで同じ時計・締切・上限を見る——**締切の残りで中断し、
 * 失敗した試行も数える**。費用の予約はこの門のあと 1 回だけ行う（二重に予約しない）。
 */
export interface JudgeCallGate {
  /** いまの時刻（ミリ秒）。生成と同じ時計を渡す */
  readonly now: () => number;
  /** 締切（ミリ秒）。これ以上なら呼ばない */
  readonly deadline: number;
  /** 総呼び出しの上限（生成の `callCount` と共有） */
  readonly callLimit: number;
  /** 生成側が既に使った呼び出しの数（いまの値。判定の試行と足して上限に照らす） */
  readonly generationCalls: () => number;
}

/** 予算に結び付けた判定を作る関数の引数 */
export interface BudgetedJudgeOptions {
  /** 包む判定の口（Jev・LLM・偽物のどれでもよい） */
  readonly judge: Judge;
  /** 生成と同じ予算（予約と精算の台帳） */
  readonly budget: JobBudget;
  /** LLM（判定の落とし先）の単価。出力を含めて数える（§5） */
  readonly rates: TokenRates;
  /** Jev の単価（既定 `JEV_RATES`。入力だけ。出力は無料。§5） */
  readonly jevRates?: TokenRates;
  /**
   * 判定の呼び出しの出力の上界（予約に使う。既定 `DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS`）。
   * どちらが答えるか分からないので、Jev と LLM の両方の見積もりに同じ値を渡す。
   */
  readonly maxOutputTokens?: number;
  /**
   * **再点検専用の Luna の口**（Issue #432）。渡すと、これを落とし先（`fallback`）として同じ予算・
   * 同じ台帳で包む——`judge.fallback` より優先する。渡さなければ `judge.fallback` を使う。
   */
  readonly recheck?: Judge;
  /** 締切と総呼び出し数の門（生成と共有。Issue #432）。渡さなければ門を掛けない */
  readonly gate?: JudgeCallGate;
}

/** 予算に結び付けた判定。`Judge` に、判定の費用と、答えた adapter ごとの呼び出しの数を足したもの */
export interface BudgetedJudge extends Judge {
  /** 判定に使った費用（USD。精算済み） */
  readonly spentUsd: number;
  /** 答えた adapter（jev・llm・fake）ごとの呼び出しの数 */
  readonly callsByAdapter: Readonly<Record<JudgeSource, number>>;
  /**
   * 判定の落とし先（Luna）も、**同じ予算**に結び付けた口（Issue #432）。独立した再点検を Luna の
   * 別の会話で行うとき、呼び側（`runPlan`）はここを使う——費用と呼び出しの数は主と共有する。
   */
  readonly fallback?: BudgetedJudge;
  /**
   * 門を通した判定の**試行**の数（主と落とし先の合計。成功・失敗を問わない。Issue #432）。生成側の
   * 呼び出しの数と足して、総呼び出し数の上限に照らすのに使う。
   */
  readonly attempts: number;
}

/** 主と落とし先で**共有する**、判定の費用・呼び出しの数・試行の数の台帳（Issue #432）。 */
interface JudgeAccount {
  spentUsd: number;
  attempts: number;
  readonly callsByAdapter: Record<JudgeSource, number>;
}

/**
 * 判定の口を、生成の予算に結び付けた包みで包む（§1.5・§5・Issue #359）。呼ぶ前に最大費用を予約し、
 * 呼んだあとで実際の費用で精算する。予約できなければ判定を呼ばずに `JudgeBudgetExceededError` を投げる。
 * 落とし先（Luna）があれば、それも**同じ予算・同じ台帳**で包む（Issue #432）。締切と総呼び出し数の門
 * （`gate`）があれば、**費用の予約の前に**照らし、失敗した試行も数える。
 */
export function createBudgetedJudge(options: BudgetedJudgeOptions): BudgetedJudge {
  const account: JudgeAccount = { spentUsd: 0, attempts: 0, callsByAdapter: { jev: 0, llm: 0, fake: 0 } };
  const fallback = options.recheck ?? options.judge.fallback;
  return wrapBudgetedJudge(options.judge, options, account, fallback);
}

/** 判定 1 つ（主または落とし先）を、共有の台帳に結び付けて包む（Issue #432） */
function wrapBudgetedJudge(
  judge: Judge,
  options: BudgetedJudgeOptions,
  account: JudgeAccount,
  fallback: Judge | undefined,
): BudgetedJudge {
  const rates = options.rates;
  const jevRates = options.jevRates ?? JEV_RATES;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS;
  const gate = options.gate;
  return {
    get spentUsd(): number {
      return account.spentUsd;
    },
    get callsByAdapter(): Readonly<Record<JudgeSource, number>> {
      return { ...account.callsByAdapter };
    },
    get attempts(): number {
      return account.attempts;
    },
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      // 締切と総呼び出し数の門（生成と共有。Issue #432）。**費用を予約する前に**照らし、失敗した試行も数える
      if (gate !== undefined) {
        if (gate.now() >= gate.deadline) throw new JudgeDeadlineExceededError();
        const used = gate.generationCalls() + account.attempts;
        if (used >= gate.callLimit) throw new JudgeCallLimitExceededError(gate.callLimit - used);
        account.attempts += 1;
      }
      const maxCostUsd = estimateJudgeMaxCostUsd({ request, rates, jevRates, maxOutputTokens });
      const reserved = options.budget.reserve(maxCostUsd);
      if (!reserved.reserved) {
        throw new JudgeBudgetExceededError(reserved.maxCostUsd, reserved.remainingUsd);
      }
      try {
        const response = await judge.judge(request);
        account.spentUsd += settleResponse(options.budget, reserved.reservation, response, rates, jevRates);
        account.callsByAdapter[response.answeredBy] += 1;
        return response;
      } catch (error) {
        // 呼び出しが失敗しても、予約は精算する（残高へ戻す。Issue #359）
        options.budget.release(reserved.reservation);
        throw error;
      }
    },
    ...(fallback === undefined
      ? {}
      : { fallback: wrapBudgetedJudge(fallback, options, account, fallback.fallback) }),
  };
}

/**
 * 呼ぶ前に予約する最大費用（§1.5）。入力の上界は、要求を JSON にした長さから出す（1 文字 = 1 トークン）。
 * **Jev と LLM の両方の単価で見積もり、大きい方を返す**——どちらが答えるかは呼ぶ前には分からない。
 *
 * 包みは adapter の中身（LLM の共通の規則・文書など、`JudgeRequest` の外にある入力）を見ないので、
 * その分は予約に入らない。出力の上限（`maxOutputTokens`）は入るので、費用の大きい側は押さえられる。
 */
export function estimateJudgeMaxCostUsd(input: {
  readonly request: JudgeRequest;
  readonly rates: TokenRates;
  readonly jevRates: TokenRates;
  readonly maxOutputTokens: number;
}): number {
  const inputTokens = JSON.stringify(input.request).length * MAX_TOKENS_PER_CHAR;
  const llm = estimateMaxCostUsd({ inputTokens, maxOutputTokens: input.maxOutputTokens, rates: input.rates });
  const jev = estimateMaxCostUsd({ inputTokens, maxOutputTokens: input.maxOutputTokens, rates: input.jevRates });
  return Math.max(llm, jev);
}

/**
 * 答えた adapter の単価で実際の費用を精算する（§5）。Jev は入力のトークン数（`usage` が無ければ
 * `inputTokens`。出力は無料）、LLM は構造化出力の `usage`（入力・キャッシュ・出力）、偽物は費用を
 * 掛けない（予約を解く）。精算した額（USD）を返す。
 */
function settleResponse(
  budget: JobBudget,
  reservation: Reservation,
  response: JudgeResponse,
  rates: TokenRates,
  jevRates: TokenRates,
): number {
  if (response.answeredBy === "fake") {
    budget.release(reservation);
    return 0;
  }
  const usage = usageOf(response);
  const tokenRates = response.answeredBy === "jev" ? jevRates : rates;
  return budget.settle(reservation, usage, tokenRates);
}

/** 答えから、精算に使う使用量を出す。LLM は `usage`、Jev は入力のトークン数だけ（出力は無料。§5） */
function usageOf(response: JudgeResponse): LlmUsage {
  if (response.usage !== undefined) return response.usage;
  return {
    inputTokens: response.inputTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}
