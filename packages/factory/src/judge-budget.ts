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
import { MAX_TOKENS_PER_CHAR, type CallGate } from "./call.js";
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
 * 判定の**実呼び出し**を、生成と共有する門（`CallGate`。call.ts）に結び付ける（Issue #432）。判定の口は
 * 生成の `CallGateway` を通らないので、同じ門を渡して**実試行の直前**に締切と総呼び出し数を照らす
 * ——費用の予約は門のあと 1 回だけ行う（二重に予約しない）。
 */
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
  readonly gate?: CallGate;
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
 * 判定の口を、生成の予算に結び付けた包みで包む（§1.5・§5・Issue #359）。**実試行の直前**に門（`gate`）を
 * 照らし、呼ぶ前に最大費用を予約し、呼んだあとで実際の費用で精算する。予約できなければ判定を呼ばずに
 * `JudgeBudgetExceededError` を投げる。締切を越えて返った応答は**成功にしない**（Issue #432）。
 *
 * 合成した口（Jev → Luna）は、**主と落とし先に分けて包み直す**——切り替えの 2 回も、それぞれ 1 試行として
 * 数え・門に掛ける。落とし先（Luna）は `fallback` に載せ、独立した再点検に使う。
 */
export function createBudgetedJudge(options: BudgetedJudgeOptions): BudgetedJudge {
  const account: JudgeAccount = { spentUsd: 0, attempts: 0, callsByAdapter: { jev: 0, llm: 0, fake: 0 } };
  const judge = options.judge;
  if (judge.primary !== undefined && judge.fallback !== undefined) {
    const primary = wrapBudgetedJudge(judge.primary, options, account, undefined);
    const switchFallback = wrapBudgetedJudge(judge.fallback, options, account, undefined);
    // 再点検の宛先は、明示の `recheck` が落とし先と違うときだけ別に包む（同じなら切り替えと同じ包み）
    const exposedFallback =
      options.recheck === undefined || options.recheck === judge.fallback
        ? switchFallback
        : wrapBudgetedJudge(options.recheck, options, account, undefined);
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
        try {
          return await primary.judge(request);
        } catch (error) {
          // 門・予算で止まったときは、切り替えずにそのまま止める（締切後の Luna の開始を防ぐ。Issue #432）
          if (isJudgeStopError(error)) throw error;
          return await switchFallback.judge(request);
        }
      },
      fallback: exposedFallback,
    };
  }
  const fallback = options.recheck ?? judge.fallback;
  return wrapBudgetedJudge(judge, options, account, fallback === undefined ? undefined : wrapBudgetedJudge(fallback, options, account, undefined));
}

/** 門・予算で止まった誤りか（切り替えの判断に使う。Issue #432） */
function isJudgeStopError(error: unknown): boolean {
  return (
    error instanceof JudgeDeadlineExceededError ||
    error instanceof JudgeCallLimitExceededError ||
    error instanceof JudgeBudgetExceededError
  );
}

/** 判定 1 つ（主または落とし先）を、共有の台帳に結び付けて包む（Issue #432） */
function wrapBudgetedJudge(
  judge: Judge,
  options: BudgetedJudgeOptions,
  account: JudgeAccount,
  fallback: BudgetedJudge | undefined,
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
      // 実試行の**直前**に、生成と共有する門を照らす（締切・総呼び出し数。Issue #432）。失敗した試行も数える
      if (gate !== undefined) {
        const begun = gate.begin();
        if (begun === "deadline") throw new JudgeDeadlineExceededError();
        if (begun === "limit") {
          throw new JudgeCallLimitExceededError(Math.max(0, gate.limit - gate.attempts()));
        }
        account.attempts += 1;
      }
      const maxCostUsd = estimateJudgeMaxCostUsd({ request, rates, jevRates, maxOutputTokens });
      const reserved = options.budget.reserve(maxCostUsd);
      if (!reserved.reserved) {
        throw new JudgeBudgetExceededError(reserved.maxCostUsd, reserved.remainingUsd);
      }
      // 締切の残りで実呼び出しを打ち切る（Issue #432）。合図は要求に載せ、adapter（LLM）が実呼び出しへ渡す。
      const controller = gate === undefined ? undefined : new AbortController();
      const timer =
        controller === undefined || gate === undefined
          ? undefined
          : setTimeout(() => controller.abort(), gate.remainingMs());
      let response: JudgeResponse;
      try {
        response = await judge.judge(
          controller === undefined ? request : { ...request, signal: controller.signal },
        );
      } catch (error) {
        // 呼び出しが失敗しても、予約は精算する（残高へ戻す。Issue #359）
        options.budget.release(reserved.reservation);
        if (controller?.signal.aborted === true) throw new JudgeDeadlineExceededError();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // **遅い応答を成功にしない**——締切を越えて返ったら、費用は精算しつつ、締切の停止にする（Issue #432）
      account.spentUsd += settleResponse(options.budget, reserved.reservation, response, rates, jevRates);
      if (gate !== undefined && gate.now() >= gate.deadline) throw new JudgeDeadlineExceededError();
      account.callsByAdapter[response.answeredBy] += 1;
      return response;
    },
    ...(fallback === undefined ? {} : { fallback }),
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
