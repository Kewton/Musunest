// 判定を予算に結び付ける包み（Issue #359）の unit テスト。
//
// **実 API は呼ばない。** 差し込んだ偽物の判定（`Judge`）が返す答えと usage、それを受け取る `JobBudget`
// だけで閉じる。固定したいのは 5 つ。
//   1. **Jev の答えは Jev の単価で精算される**（入力だけ。出力は無料。§5）
//   2. **LLM の答えは LLM の単価で精算される**（入力・キャッシュ・出力。§5）
//   3. **予約できないときは判定を呼ばず、誤り（`JudgeBudgetExceededError`）として返す**
//   4. **呼び出しが失敗しても、予約は精算される**（残高へ戻る。Issue #359）
//   5. **包みは、共有の門を要求へ載せて Jev の内部の再送へ届ける**（Issue #469）
import { describe, expect, it } from "vitest";
import { JEV_RATES, JobBudget, costOfUsageUsd, type TokenRates } from "./budget.js";
import { JudgeBudgetExceededError, JudgeCallLimitExceededError, JudgeDeadlineExceededError, createBudgetedJudge } from "./judge-budget.js";
import { createCallGate, type CallGate } from "./call.js";
import type { Judge, JudgeRequest, JudgeResponse, JudgeSource } from "./judge.js";
import { createJevJudge, type JevFetch } from "./judge-jev.js";
import type { LlmUsage } from "./llm.js";

/** LLM（判定の落とし先）の単価（試験は小さく取る） */
const RATES: TokenRates = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

/** 1 問だけの小さな要求 */
const REQUEST: JudgeRequest = {
  state: { note: "x" },
  questions: { q: { kind: "noul", instructions: "yes?" } },
};

/** 決めた答えを返し、呼ばれた回数を数える偽物の判定（`source` を渡すと名乗る。Issue #473） */
function fixedJudge(
  response: JudgeResponse,
  source?: JudgeSource,
): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  return {
    judge: {
      ...(source === undefined ? {} : { source }),
      async judge(): Promise<JudgeResponse> {
        calls += 1;
        return response;
      },
    },
    calls: () => calls,
  };
}

/** 常に失敗する偽物の判定（`source` を渡すと名乗る。Issue #473） */
function failingJudge(error: Error, source?: JudgeSource): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  return {
    judge: {
      ...(source === undefined ? {} : { source }),
      async judge(): Promise<JudgeResponse> {
        calls += 1;
        throw error;
      },
    },
    calls: () => calls,
  };
}

describe("判定の費用を、答えた adapter の単価で精算する（05 §5・Issue #359）", () => {
  it("Jev の答えは、Jev の単価で精算する（入力だけ。出力は無料）", async () => {
    const { judge, calls } = fixedJudge({
      answers: {},
      inputTokens: 1_000_000,
      model: "jev-1.13.0",
      answeredBy: "jev",
    });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    const response = await budgeted.judge(REQUEST);

    expect(response.answeredBy).toBe("jev");
    // Jev: 入力 1,000,000 × 0.042/100 万 = 0.042 USD（出力は無料）
    expect(budgeted.spentUsd).toBeCloseTo(0.042, 12);
    expect(budget.spentUsd).toBeCloseTo(0.042, 12);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 1, llm: 0, fake: 0 });
    expect(calls()).toBe(1);
  });

  it("LLM の答えは、LLM の単価で精算する（入力・キャッシュ・出力を含む）", async () => {
    const usage: LlmUsage = { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 0 };
    const { judge } = fixedJudge({ answers: {}, inputTokens: usage.inputTokens, usage, model: "gpt-judge", answeredBy: "llm" });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.spentUsd).toBeCloseTo(costOfUsageUsd(usage, RATES), 12);
    // 出力（200）も費用に入る（Jev の単価なら 0 になる額ではない）
    expect(budgeted.spentUsd).toBeGreaterThan(200 * RATES.outputPerToken);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0 });
  });

  it("偽物の答えは、費用を掛けない（予約を解くだけ）", async () => {
    const { judge } = fixedJudge({ answers: {}, inputTokens: 123, model: "fake-judge", answeredBy: "fake" });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.spentUsd).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 1 });
  });
});

describe("予約できないときは判定を呼ばない（Issue #359）", () => {
  it("残高を超える予約は取れず、判定を呼ばずに誤りを返す", async () => {
    const { judge, calls } = fixedJudge({ answers: {}, inputTokens: 0, model: "gpt-judge", answeredBy: "llm" });
    const budget = new JobBudget(0.0001);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeBudgetExceededError);
    // 予約できなかったので、判定は呼ばない（誤りをそのまま返す）
    expect(calls()).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0 });
  });
});

describe("呼び出しが失敗しても、予約は精算される（Issue #359）", () => {
  it("判定が失敗したら、誤りを投げ直し、予約を解いて残高へ戻す", async () => {
    const { judge, calls } = failingJudge(new Error("判定が失敗した"));
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await expect(budgeted.judge(REQUEST)).rejects.toThrow("判定が失敗した");
    expect(calls()).toBe(1);
    // 予約は精算され（解かれ）、残高は上限のまま戻る
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.remainingUsd).toBe(10);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0 });
  });
});

describe("単価の既定（Issue #359）", () => {
  it("Jev の単価を渡さなければ、JEV_RATES を使う（入力は同じ単価・出力は無料）", async () => {
    expect(JEV_RATES.outputPerToken).toBe(0);
    const { judge } = fixedJudge({ answers: {}, inputTokens: 500_000, model: "jev", answeredBy: "jev" });
    const budget = new JobBudget(1);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });
    await budgeted.judge(REQUEST);
    expect(budgeted.spentUsd).toBeCloseTo(0.021, 12);
  });
});

describe("落とし先（Luna）も同じ予算で包む（Issue #432）", () => {
  it("落とし先を fallback に載せ、費用と呼び出しの数を主と共有する", async () => {
    const primary = fixedJudge({ answers: {}, inputTokens: 0, model: "jev", answeredBy: "jev" });
    const luna = fixedJudge({ answers: {}, inputTokens: 1_000_000, model: "gpt-judge", answeredBy: "llm" });
    const judge: Judge = { judge: primary.judge.judge.bind(primary.judge), fallback: luna.judge };
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    expect(budgeted.fallback).toBeDefined();
    await budgeted.fallback?.judge(REQUEST);

    // 落とし先の呼び出しが、主の口の台帳にも数えられる（費用も同じ予算で精算される）
    expect(budgeted.spentUsd).toBeCloseTo(1, 12);
    expect(budget.spentUsd).toBeCloseTo(1, 12);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0 });
  });

  it("落とし先が無ければ、fallback は undefined", () => {
    const { judge } = fixedJudge({ answers: {}, inputTokens: 0, model: "fake", answeredBy: "fake" });
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });
    expect(budgeted.fallback).toBeUndefined();
  });
});

describe("締切と総呼び出し数の門（生成と共有。Issue #432）", () => {
  /** 固定した答えを返す偽物の判定（呼ばれた回数を数える） */
  const response = (answeredBy: "fake" | "llm" | "jev"): JudgeResponse => ({ answers: {}, inputTokens: 0, model: "x", answeredBy });

  it("締切を過ぎていれば、判定を呼ばずに deadline の誤りを返す", async () => {
    const { judge, calls } = fixedJudge(response("fake"));
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({
      judge,
      budget,
      rates: RATES,
      gate: createCallGate({ now: () => 1_000, deadline: 1_000, limit: 10 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
    expect(calls()).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budgeted.attempts).toBe(0);
  });

  it("合算した総呼び出し数に達していれば、判定を呼ばずに limit の誤りを返す", async () => {
    const { judge, calls } = fixedJudge(response("fake"));
    // 生成側が 3 回使ったところから始める（同じ門を共有する）
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 3 });
    gate.begin();
    gate.begin();
    gate.begin();
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    expect(calls()).toBe(0);
    expect(budgeted.attempts).toBe(0);
  });

  it("門を通った試行は、失敗しても数える（成功・失敗を問わない）", async () => {
    const { judge } = failingJudge(new Error("判定が失敗した"));
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toThrow("判定が失敗した");
    expect(budgeted.attempts).toBe(1);
    expect(gate.attempts()).toBe(1);
  });

  it("合成した口（Jev→Luna）の切り替えは、2 回とも 1 試行として数える", async () => {
    const { judge: primary } = failingJudge(new Error("Jev が止まった"));
    const { judge: luna, calls: lunaCalls } = fixedJudge(response("llm"));
    const composed: Judge = { judge: async () => response("fake"), primary, fallback: luna };
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    const result = await budgeted.judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(lunaCalls()).toBe(1);
    // 切り替えの 2 回（失敗した主＋落とし先）が、それぞれ 1 試行として数えられる
    expect(budgeted.attempts).toBe(2);
    expect(gate.attempts()).toBe(2);
  });

  it("切り替え先も門で守る（上限に達していれば、落とし先を呼ばない）", async () => {
    const { judge: primary } = failingJudge(new Error("Jev が止まった"));
    const { judge: luna, calls: lunaCalls } = fixedJudge(response("llm"));
    const composed: Judge = { judge: async () => response("fake"), primary, fallback: luna };
    // 上限 1：主の試行で使い切る → 落とし先は呼ばれない
    const budgeted = createBudgetedJudge({
      judge: composed,
      budget: new JobBudget(10),
      rates: RATES,
      gate: createCallGate({ now: () => 0, deadline: 1_000, limit: 1 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    expect(lunaCalls()).toBe(0);
  });

  it("呼び出しの途中で締切を過ぎたら、待たずに打ち切る", async () => {
    const judge: Judge = {
      async judge(request) {
        // 締切の合図が来るまで待つ（返さない）
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted === true) resolve();
          else request.signal?.addEventListener("abort", () => resolve());
        });
        throw new Error("打ち切られました");
      },
    };
    const budgeted = createBudgetedJudge({
      judge,
      budget: new JobBudget(10),
      rates: RATES,
      gate: createCallGate({ now: () => 0, deadline: 20, limit: 10 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
  });

  it("締切を越えて返った応答を、成功にしない", async () => {
    let clock = 0;
    const judge: Judge = {
      async judge() {
        clock = 100; // 締切（50）を越えて返る
        return response("fake");
      },
    };
    const budgeted = createBudgetedJudge({
      judge,
      budget: new JobBudget(10),
      rates: RATES,
      gate: createCallGate({ now: () => clock, deadline: 50, limit: 10 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
  });
});

// ── 包みが、共有の門を要求へ載せて Jev の内部の再送へ届ける（Issue #469）────────────
//
// 包みは、門を持つとき、中断の合図と一緒に**門**を要求へ載せる。Jev の adapter は、要求の門で内部の
// 再送の各回を数え、断られたら通常の混み合いと区別できる種類で返す——包みはそれを既存の門の停止
// （`JudgeCallLimitExceededError`・`JudgeDeadlineExceededError`）に写し、**落とし先へ切り替えない**。
// 門の拒否でなければ、今までどおり落とし先へ切り替える。

/** 決めた答えを返す偽物の判定（`answeredBy` を選べる） */
function stubJudge(answeredBy: "fake" | "llm" | "jev"): JudgeResponse {
  return { answers: {}, inputTokens: 0, model: "x", answeredBy };
}

/**
 * 差し込む `fetch` が状態コードを順に返す、Jev の adapter（門は**作るときに渡さない**）。
 * 200 のときは、要求の問い（Noul）に「はい」を返す。呼ばれた回数も返す。
 */
function jevAdapter(options: {
  readonly statuses: readonly number[];
  readonly maxAttempts: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  const fetchImpl: JevFetch = async (_url, init) => {
    calls += 1;
    const status = options.statuses[calls - 1] ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "busy" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string }> };
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions)) {
      answers[name] = question.type === "noul" ? { noul: 1 } : { choice: "a", probabilities: { a: 1 } };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 10 }, answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    judge: createJevJudge({
      apiKey: "k",
      fetch: fetchImpl,
      maxAttempts: options.maxAttempts,
      sleep: options.sleep ?? (async () => {}),
    }),
    calls: () => calls,
  };
}

describe("包みが、共有の門を要求へ載せる（05 §1.5・Issue #469）", () => {
  it("門を持つ包みは、要求に門と合図を載せる。門の無い包みは載せない", async () => {
    const seen: JudgeRequest[] = [];
    const judge: Judge = {
      async judge(request): Promise<JudgeResponse> {
        seen.push(request);
        return stubJudge("fake");
      },
    };
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });

    await createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES, gate }).judge(REQUEST);
    await createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES }).judge(REQUEST);

    // 門を持つ包みは、中断の合図と一緒に門を載せる（同じ参照）
    expect(seen[0]?.gate).toBe(gate);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    // 門の無い包みは、門も合図も載せない（今までどおり）
    expect(seen[1]?.gate).toBeUndefined();
    expect(seen[1]?.signal).toBeUndefined();
  });

  it("主・切り替え先・明示の再点検先へ、同じ門の参照が届く", async () => {
    const seen: (CallGate | undefined)[] = [];
    const failing: Judge = {
      async judge(request): Promise<JudgeResponse> {
        seen.push(request.gate);
        throw new Error("Jev が止まった");
      },
    };
    const answering = (): Judge => ({
      async judge(request): Promise<JudgeResponse> {
        seen.push(request.gate);
        return stubJudge("fake");
      },
    });
    const composed: Judge = { judge: failing.judge, primary: failing, fallback: answering() };
    const recheck = answering();
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });

    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate, recheck });
    await budgeted.judge(REQUEST); // 主（失敗）→ 切り替え先
    await budgeted.fallback?.judge(REQUEST); // 明示の再点検先

    expect(seen).toHaveLength(3);
    expect(seen.every((received) => received === gate)).toBe(true);
  });

  it("要求の門が再送を断ったら JudgeCallLimitExceededError になり、落とし先の実呼び出しが 0", async () => {
    const jev = jevAdapter({ statuses: [429, 429], maxAttempts: 2 });
    const luna = fixedJudge(stubJudge("llm"));
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna.judge };
    // 上限 1：最初の 1 回で使い切る → 再送は門が断る
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 1 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    // 実呼び出しは Jev の最初の 1 回だけ（再送も Luna も呼ばない）
    expect(jev.calls()).toBe(1);
    expect(luna.calls()).toBe(0);
    expect(budgeted.attempts).toBe(1);
  });

  it("要求の門が締切で再送を断ったら JudgeDeadlineExceededError になり、落とし先の実呼び出しが 0", async () => {
    let clock = 0;
    // 再送の待機で、締切（1000ms）を過ぎる
    const jev = jevAdapter({
      statuses: [429, 429],
      maxAttempts: 2,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const luna = fixedJudge(stubJudge("llm"));
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna.judge };
    const gate = createCallGate({ now: () => clock, deadline: 1_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
    expect(jev.calls()).toBe(1);
    expect(luna.calls()).toBe(0);
  });

  it("通常の障害で門に余裕があれば切り替え、attempts は初回＋再送＋落とし先の合計になる", async () => {
    // Jev は初回＋合法な再送 1 の 2 回で失敗し、Luna が答える（＝ 3 試行）
    const jev = jevAdapter({ statuses: [429, 429], maxAttempts: 2 });
    const luna = fixedJudge(stubJudge("llm"));
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna.judge };
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    const result = await budgeted.judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(jev.calls()).toBe(2);
    expect(luna.calls()).toBe(1);
    // 初回＋再送 1＋Luna 1
    expect(budgeted.attempts).toBe(3);
    expect(gate.attempts()).toBe(3);
  });

  it("門が上限に達していれば、切り替えの落とし先も呼ばない（Luna 0）", async () => {
    const jev = jevAdapter({ statuses: [429, 429], maxAttempts: 2 });
    const luna = fixedJudge(stubJudge("llm"));
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna.judge };
    // 上限 2：初回＋再送 1 で使い切る → 切り替えの落とし先は門が断る
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 2 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    expect(jev.calls()).toBe(2);
    expect(luna.calls()).toBe(0);
  });
});

// ── adapter ごとの実試行の内訳（Issue #473）──────────────────────────────
//
// 包みの台帳は、**門を通り、予約に成功して口の呼び出しを始めた回**を、口の名乗り（`source`）ごとに数える。
// 成功・失敗・締切後の応答を問わず、門の有無も問わない。門・予算が断った回は数えない。名乗りの無い口は
// `unknown` に入る（成功応答の `answeredBy` からは補わない）。

describe("adapter ごとの実試行の内訳（05 §5・Issue #473）", () => {
  it("(a) 主の Jev が失敗して Luna へ切り替わると、内訳が jev 1・llm 1（成功の数は今のまま）", async () => {
    const { judge: primary } = failingJudge(new Error("Jev が止まった"), "jev");
    const { judge: luna } = fixedJudge(stubJudge("llm"), "llm");
    const composed: Judge = { judge: async () => stubJudge("fake"), primary, fallback: luna };
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES });

    const result = await budgeted.judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 1, llm: 1, fake: 0, unknown: 0 });
    // 成功して返った応答の数は、意味も値も変えない（Luna が 1 つ答えただけ）
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0 });
  });

  it("(b) 明示の再点検先を呼ぶと、llm に 1 足す", async () => {
    const { judge: primary } = failingJudge(new Error("x"), "jev");
    const { judge: luna } = fixedJudge(stubJudge("llm"), "llm");
    const { judge: recheck } = fixedJudge(stubJudge("llm"), "llm");
    const composed: Judge = { judge: async () => stubJudge("fake"), primary, fallback: luna };
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, recheck });

    await budgeted.fallback?.judge(REQUEST);

    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0, unknown: 0 });
  });

  it("(c) 締切の後に返った応答は失敗のまま、その adapter に 1 足す", async () => {
    let clock = 0;
    const judge: Judge = {
      source: "llm",
      async judge(): Promise<JudgeResponse> {
        clock = 100; // 締切（50）を越えて返る
        return stubJudge("llm");
      },
    };
    const budgeted = createBudgetedJudge({
      judge,
      budget: new JobBudget(10),
      rates: RATES,
      gate: createCallGate({ now: () => clock, deadline: 50, limit: 10 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
    // 締切後に返った応答は成功にしないが、その実試行は内訳に残る
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0, unknown: 0 });
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0 });
  });

  it("(d) 門が締切で断った回は、どの欄にも足さない", async () => {
    const { judge, calls } = fixedJudge(stubJudge("llm"), "llm");
    const budgeted = createBudgetedJudge({
      judge,
      budget: new JobBudget(10),
      rates: RATES,
      gate: createCallGate({ now: () => 1_000, deadline: 1_000, limit: 10 }),
    });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeDeadlineExceededError);
    expect(calls()).toBe(0);
    expect(budgeted.attempts).toBe(0);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 0 });
  });

  it("(d) 門が上限で断った回は、どの欄にも足さない", async () => {
    const { judge, calls } = fixedJudge(stubJudge("llm"), "llm");
    // 生成側が 1 回使ったところから始める（同じ門を共有する）
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 1 });
    gate.begin();
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    expect(calls()).toBe(0);
    expect(budgeted.attempts).toBe(0);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 0 });
  });

  it("(d) 予約が断られた回は、attempts 1・内訳の合計 0", async () => {
    const { judge, calls } = fixedJudge(stubJudge("llm"), "llm");
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(0.0001), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeBudgetExceededError);
    expect(calls()).toBe(0);
    // 門は通ったので attempts は 1。だが口は呼んでいないので、内訳はどの欄も 0
    expect(budgeted.attempts).toBe(1);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 0 });
  });

  it("(e) 門の無い包みで口を 1 回呼ぶと、attempts 0・内訳はその adapter に 1", async () => {
    const { judge } = fixedJudge(stubJudge("llm"), "llm");
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.attempts).toBe(0);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0, unknown: 0 });
  });

  it("(f) Jev が 429 のあと 200 を返すと、初回＋再送 1 で jev 2", async () => {
    const jev = jevAdapter({ statuses: [429, 200], maxAttempts: 2 });
    const { judge: luna } = fixedJudge(stubJudge("llm"), "llm");
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna };
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    const result = await budgeted.judge(REQUEST);

    expect(result.answeredBy).toBe("jev");
    expect(jev.calls()).toBe(2);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 2, llm: 0, fake: 0, unknown: 0 });
    expect(budgeted.callsByAdapter).toEqual({ jev: 1, llm: 0, fake: 0 });
  });

  it("(f) 429→529→再送の尽き→Luna への切り替えで、jev 3・llm 1", async () => {
    const jev = jevAdapter({ statuses: [429, 529, 529], maxAttempts: 3 });
    const { judge: luna } = fixedJudge(stubJudge("llm"), "llm");
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna };
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    const result = await budgeted.judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(jev.calls()).toBe(3);
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 3, llm: 1, fake: 0, unknown: 0 });
  });

  it("(f) 再送が上限で断られると、追加 0・切り替え 0", async () => {
    const jev = jevAdapter({ statuses: [429, 429], maxAttempts: 2 });
    const { judge: luna, calls: lunaCalls } = fixedJudge(stubJudge("llm"), "llm");
    const composed: Judge = { judge: jev.judge.judge.bind(jev.judge), primary: jev.judge, fallback: luna };
    // 上限 1：最初の 1 回で使い切る → 再送は門が断る（切り替えもしない）
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 1 });
    const budgeted = createBudgetedJudge({ judge: composed, budget: new JobBudget(10), rates: RATES, gate });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeCallLimitExceededError);
    expect(lunaCalls()).toBe(0);
    // 初回の 1 だけ。断られた再送は足さない
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 1, llm: 0, fake: 0, unknown: 0 });
  });

  it("(g) 同じ adapter を別の包みで使い回しても、台帳の数が混ざらない", async () => {
    const { judge } = fixedJudge(stubJudge("llm"), "llm");
    const first = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });
    const second = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });

    await first.judge(REQUEST);

    expect(first.attemptsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0, unknown: 0 });
    expect(second.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 0 });
  });

  it("(h) 名乗りの無い口の成功は unknown に入り、成功応答の answeredBy から補わない", async () => {
    const { judge } = fixedJudge(stubJudge("jev")); // 名乗り無し。応答は jev
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 1 });
    // 成功の数は answeredBy のまま（内訳は answeredBy から補わない）
    expect(budgeted.callsByAdapter).toEqual({ jev: 1, llm: 0, fake: 0 });
  });

  it("(h) 名乗りの無い口の失敗も unknown に入る。内訳は 4 欄で初期値 0 から始まる", async () => {
    const { judge } = failingJudge(new Error("x"));
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES });
    // 初期値は 4 欄（jev・llm・fake・unknown）すべて 0
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 0 });

    await expect(budgeted.judge(REQUEST)).rejects.toThrow("x");
    expect(budgeted.attemptsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0, unknown: 1 });
  });

  it("(i) 門があり予約が断られない例では、内訳の合計が attempts と一致する（生成側の増分は入らない）", async () => {
    const { judge } = fixedJudge(stubJudge("llm"), "llm");
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    gate.begin(); // 生成側の増分（判定の内訳には入らない）
    gate.begin();
    const budgeted = createBudgetedJudge({ judge, budget: new JobBudget(10), rates: RATES, gate });

    await budgeted.judge(REQUEST);

    const sum = Object.values(budgeted.attemptsByAdapter).reduce((total, value) => total + value, 0);
    expect(sum).toBe(budgeted.attempts);
    // 生成側の 2 は入らず、この判定の 1 だけ
    expect(budgeted.attempts).toBe(1);
    expect(gate.attempts()).toBe(3);
  });
});
