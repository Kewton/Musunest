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
// 門と一緒に**判定の枝**の上限（`judgeLimit`。08-architecture-v1.2.md §4.1・Issue #592）を渡すと、判定の実試行は共有の門より
// 先に枝に照らす。枝が尽きれば判定を呼ばず、共有の門も数えない（判定は助言。受理で埋めない）。
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
import {
  judgeGateRefusalKindOf,
  type Judge,
  type JudgeAttemptSource,
  type JudgeRequest,
  type JudgeResponse,
  type JudgeSource,
} from "./judge.js";
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
  /**
   * **判定の枝**の上限（判定だけの実試行の上限。08-architecture-v1.2.md §4.1・Issue #592）。`gate` と一緒に渡すと、判定の
   * 実試行（最初の 1 回・内部の再送・切り替え・再点検）は、共有の門より**先に**この枝に照らす。枝が尽きれば共有の門を
   * 数えずに `JudgeCallLimitExceededError` で断る（判定を呼ばない・落とし先へ切り替えない）。渡さなければ枝を掛けない
   * （今までどおり）。
   */
  readonly judgeLimit?: number;
}

/** 予算に結び付けた判定。`Judge` に、判定の費用と、答えた adapter ごとの呼び出しの数を足したもの */
export interface BudgetedJudge extends Judge {
  /** 判定に使った費用（USD。精算済み） */
  readonly spentUsd: number;
  /** 答えた adapter（jev・llm・fake）ごとの呼び出しの数 */
  readonly callsByAdapter: Readonly<Record<JudgeSource, number>>;
  /**
   * 実試行の数（成功・失敗・締切後の応答の合計。Issue #473）。門を通り、**予約に成功したあと、口の
   * 呼び出しを始めた回**を、口の名乗り（`source`）ごとに数える——名乗りの無い口は `unknown` に入る。
   * 門・予算が断って口を呼ばなかった回は数えない。**成功応答の `answeredBy` からは補わない。**
   */
  readonly attemptsByAdapter: Readonly<Record<JudgeAttemptSource, number>>;
  /**
   * 判定の落とし先（Luna）も、**同じ予算**に結び付けた口（Issue #432）。独立した再点検を Luna の
   * 別の会話で行うとき、呼び側（`runPlan`）はここを使う——費用と呼び出しの数は主と共有する。
   */
  readonly fallback?: BudgetedJudge;
  /**
   * 門を通した判定の**試行**の数（主と落とし先の合計。成功・失敗を問わない。Issue #432）。**内部で
   * 再送した各回も 1 つずつ数える**（Issue #469）——生成側の呼び出しの数と足して、総呼び出し数の上限に
   * 照らすのに使う。台帳（ここ）と共有の門（`CallGate`）を食い違わせない。
   */
  readonly attempts: number;
  /**
   * 判定の枝（`judgeLimit`）の上限と、枝を通った判定の実試行の数（Issue #592）。枝を掛けない包みは null。
   * 枝が断った回は数えない。
   */
  readonly branch: { readonly limit: number; readonly used: number } | null;
}

/** 主と落とし先で**共有する**、判定の費用・呼び出しの数・試行の数の台帳（Issue #432・#473）。 */
interface JudgeAccount {
  spentUsd: number;
  attempts: number;
  readonly callsByAdapter: Record<JudgeSource, number>;
  /** 名乗りごとの実試行の数（名乗りの無い口は `unknown`。Issue #473） */
  readonly attemptsByAdapter: Record<JudgeAttemptSource, number>;
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
  const account: JudgeAccount = {
    spentUsd: 0,
    attempts: 0,
    callsByAdapter: { jev: 0, llm: 0, fake: 0 },
    attemptsByAdapter: { jev: 0, llm: 0, fake: 0, unknown: 0 },
  };
  const judge = options.judge;
  // 判定の枝（門と一緒に渡されたときだけ）。包みと adapter（Jev の内部の再送）には、枝を先に照らす門の見え方を渡す
  const branch = options.gate === undefined || options.judgeLimit === undefined ? undefined : createJudgeBranchGate(options.gate, options.judgeLimit);
  const wrapOptions: BudgetedJudgeOptions = branch === undefined ? options : { ...options, gate: branch.gate };
  const branchOf = (): BudgetedJudge["branch"] => (branch === undefined ? null : { limit: branch.limit, used: branch.used() });
  if (judge.primary !== undefined && judge.fallback !== undefined) {
    const primary = wrapBudgetedJudge(judge.primary, wrapOptions, account, undefined, branchOf);
    const switchFallback = wrapBudgetedJudge(judge.fallback, wrapOptions, account, undefined, branchOf);
    // 再点検の宛先は、明示の `recheck` が落とし先と違うときだけ別に包む（同じなら切り替えと同じ包み）
    const exposedFallback =
      options.recheck === undefined || options.recheck === judge.fallback
        ? switchFallback
        : wrapBudgetedJudge(options.recheck, wrapOptions, account, undefined, branchOf);
    return {
      get spentUsd(): number {
        return account.spentUsd;
      },
      get callsByAdapter(): Readonly<Record<JudgeSource, number>> {
        return { ...account.callsByAdapter };
      },
      get attemptsByAdapter(): Readonly<Record<JudgeAttemptSource, number>> {
        return { ...account.attemptsByAdapter };
      },
      get attempts(): number {
        return account.attempts;
      },
      get branch(): BudgetedJudge["branch"] {
        return branchOf();
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
  return wrapBudgetedJudge(
    judge,
    wrapOptions,
    account,
    fallback === undefined ? undefined : wrapBudgetedJudge(fallback, wrapOptions, account, undefined, branchOf),
    branchOf,
  );
}

/**
 * 判定の枝（Issue #592）。共有の門の**見え方**を作る：`begin` は、枝を通った判定の実試行が上限に達していれば共有の門を
 * 数えずに `"limit"` を返し、そうでなければ共有の門に照らして、通った回だけ枝を 1 つ数える。時計・締切・上限・数は
 * 共有の門のものをそのまま見せる（包みの台帳の差分と、締切の打ち切りは今までと同じに働く）。
 */
export function createJudgeBranchGate(
  gate: CallGate,
  limit: number,
): { readonly gate: CallGate; readonly limit: number; used(): number } {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("判定の枝の上限は 0 以上の整数であること");
  let used = 0;
  return {
    limit,
    used: () => used,
    gate: {
      now: gate.now,
      deadline: gate.deadline,
      limit: gate.limit,
      attempts: () => gate.attempts(),
      remainingMs: () => gate.remainingMs(),
      begin: () => {
        if (used >= limit) return "limit";
        const begun = gate.begin();
        if (begun === "ok") used += 1;
        return begun;
      },
    },
  };
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
  branchOf: () => BudgetedJudge["branch"],
): BudgetedJudge {
  const rates = options.rates;
  const jevRates = options.jevRates ?? JEV_RATES;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS;
  const gate = options.gate;
  // 包む口の名乗り（無ければ `unknown`。Issue #473）。**成功応答の `answeredBy` からは補わない。**
  const source: JudgeAttemptSource = judge.source ?? "unknown";
  return {
    get spentUsd(): number {
      return account.spentUsd;
    },
    get callsByAdapter(): Readonly<Record<JudgeSource, number>> {
      return { ...account.callsByAdapter };
    },
    get attemptsByAdapter(): Readonly<Record<JudgeAttemptSource, number>> {
      return { ...account.attemptsByAdapter };
    },
    get attempts(): number {
      return account.attempts;
    },
    get branch(): BudgetedJudge["branch"] {
      return branchOf();
    },
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      // 実試行の**直前**に、生成と共有する門を照らす（締切・総呼び出し数。Issue #432）。失敗した試行も数える
      let attemptsAtStart: number | undefined;
      if (gate !== undefined) {
        attemptsAtStart = gate.attempts();
        const begun = gate.begin();
        // 門が断った回は、口を呼ばず、**どの欄にも足さない**（Issue #473）。`attempts` も実試行の内訳も動かさない。
        if (begun === "deadline") throw new JudgeDeadlineExceededError();
        if (begun === "limit") {
          throw new JudgeCallLimitExceededError(Math.max(0, gate.limit - gate.attempts()));
        }
      }
      // 門を通した試行の数（最初の 1 回と、adapter が**内部で再送した各回**）を、判定の台帳へ写す
      // （Issue #469）。門は生成と共有で、adapter の再送も同じ門を通る——台帳と門を食い違わせない。
      // **二重に数えない**：門の数の差を取るので、最初の 1 回も含めてちょうど 1 回ずつ入る。
      const recordAttempts = (): void => {
        if (gate === undefined || attemptsAtStart === undefined) return;
        account.attempts += gate.attempts() - attemptsAtStart;
        attemptsAtStart = gate.attempts();
      };
      // 名乗りごとの**実試行**（Issue #473）は、この呼び出しが**実際に始めた初回**（予約の成功の直後）と、
      // adapter が**許された再送を始めた通知**（`onRetryStarted`）だけで数える。**門全体の差分は使わない**
      // ——判定の応答を待つ間に生成側が同じ門を通った増分を、判定の内訳に混ぜないため（F1）。門の有無を
      // 問わず同じ通知を使い、門をもう一度照らさない。**要求ごとの通知**なので、同じ adapter を別の包みで
      // 使い回しても混ざらない。
      const onRetryStarted = (): void => {
        account.attemptsByAdapter[source] += 1;
      };
      const maxCostUsd = estimateJudgeMaxCostUsd({ request, rates, jevRates, maxOutputTokens });
      const reserved = options.budget.reserve(maxCostUsd);
      if (!reserved.reserved) {
        recordAttempts();
        throw new JudgeBudgetExceededError(reserved.maxCostUsd, reserved.remainingUsd);
      }
      // 予約できた——ここから口の呼び出しを始める。門の有無を問わず、名乗りごとの実試行を 1 つ数える
      account.attemptsByAdapter[source] += 1;
      // 締切の残りで実呼び出しを打ち切る（Issue #432）。合図は要求に載せ、adapter（LLM）が実呼び出しへ渡す。
      // **共有の門も要求に載せる**（Issue #469）——Jev の adapter は、内部の再送の各回をこの門に通す。
      const controller = gate === undefined ? undefined : new AbortController();
      const timer =
        controller === undefined || gate === undefined
          ? undefined
          : setTimeout(() => controller.abort(), gate.remainingMs());
      let response: JudgeResponse;
      try {
        // 合図・門・**再送の通知**を要求に載せる。通知は門の有無を問わず載せる——adapter（Jev）が内部の
        // 再送を始める時点で呼び、この呼び出しの内訳へ 1 足す（Issue #473）。
        response = await judge.judge({
          ...request,
          ...(controller === undefined || gate === undefined ? {} : { signal: controller.signal, gate }),
          onRetryStarted,
        });
      } catch (error) {
        // 呼び出しが失敗しても、予約は精算する（残高へ戻す。Issue #359）。**失敗しても、始めた実試行と
        // 許された再送は内訳に残る**（成功を待たない。Issue #473）
        options.budget.release(reserved.reservation);
        recordAttempts();
        if (controller?.signal.aborted === true) throw new JudgeDeadlineExceededError();
        // 要求の門が内部の再送を断ったときは、既存の門の停止へ写す（Issue #469）。**落とし先へ切り替えない**
        // ——切り替えの判断（`isJudgeStopError`）でそのまま止まる。断られた再送は門の差に入らないので、
        // 内訳にも足さない（Issue #473）。
        const refusal = judgeGateRefusalKindOf(error);
        if (refusal !== undefined) {
          throw refusal === "gateDeadline"
            ? new JudgeDeadlineExceededError()
            : new JudgeCallLimitExceededError(Math.max(0, gate === undefined ? 0 : gate.limit - gate.attempts()));
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // **遅い応答を成功にしない**——締切を越えて返ったら、費用は精算しつつ、締切の停止にする（Issue #432）。
      // その応答の実試行は、開始の時点で既に内訳へ入っている（Issue #473）
      account.spentUsd += settleResponse(options.budget, reserved.reservation, response, rates, jevRates);
      recordAttempts();
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
