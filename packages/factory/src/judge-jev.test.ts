// Jev（TypeSafe の System One）の判定の adapter（Issue #330・#349）の unit テスト。
//
// **実 API は呼ばない。** 差し込んだ `fetch` が受け取った要求と、手で書いた応答だけで閉じる。
// ここで固定したいのは 9 つ。
//   1. 送る本文の形（`state`・`model: jev-1.13.0`・`questions`）と `Authorization: Bearer` の見出し（§1・§4）
//   2. 429・529 は指数の待ちで再試行し、上限で失敗になる（§1）
//   3. 401・422 は再試行しない失敗の種類にする（§1）
//   4. 応答の `model` を結果に残す（§8 U-J3）
//   5. 答え（choice の確率の分布・score の数の値と段階と確率・noul）とトークン数を、判定の口の形に直す（§1・#349）
//   6. adapter のソースが環境変数を読まない（§4・R-15）
//   7. 窓口が記録した本物の応答を読み、送る本文が記録した要求と一致する（#349）
//   8. score の `criteria` は順序のある配列で送り、2〜10 個の外は送る前に断る。`instructions` は object も許す（#349）
//   9. 要求の門（包みが載せる共有の門）で、内部の再送の各回だけを数え、上限・締切で再送しない。断りは
//      通常の混み合いと区別できる。要求の門は、作るときに渡した門より優先する（#469）
//  10. 再送の待ちを、中断の合図で片付ける——合図が中断したら、既定のタイマーを消して `timeout` にし、
//      合図に足した listener をどの終わり方（中断・満了・拒否・同期の throw）でも残さない（#477）
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallGate } from "./call.js";
import type { JudgeRequest } from "./judge.js";
import {
  DEFAULT_JEV_MODEL,
  JevAdapterError,
  createJevJudge,
  type JevErrorKind,
  type JevFetch,
} from "./judge-jev.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

// ── 差し込む fetch と、手で書いた応答 ────────────────────────────────────

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
}

/** 差し込んだ fetch が受け取った要求を記録し、用意した応答を返す */
function recordingFetch(
  reply: (call: number) => Response | Promise<Response>,
): { readonly fetch: JevFetch; readonly captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: JevFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = (init.headers ?? {}) as Record<string, string>;
    captured.push({ url, body, authorization: headers.Authorization });
    return reply(captured.length);
  };
  return { fetch: fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(captured: readonly Captured[], index = 0): Record<string, unknown> {
  const call = captured[index];
  if (call === undefined) throw new Error(`要求が記録されていません（index=${index}）`);
  return call.body;
}

/** 型付きの誤りを取り出す（誤りが投げられなければ試験を落とす） */
async function captureError(run: () => Promise<unknown>): Promise<JevAdapterError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof JevAdapterError) return error;
    throw new Error(`型付きの誤りではありません: ${String(error)}`, { cause: error });
  }
  throw new Error("誤りが投げられませんでした");
}

/** 待たずに記録だけする sleep（再試行の待ちを、待ち時間の列で観測する） */
function recordingSleep(): { readonly sleep: (ms: number) => Promise<void>; readonly delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

const REQUEST: JudgeRequest = {
  state: { note: "決まっていないことを挙げている", requirement: "件数を見られる" },
  questions: {
    kind: { kind: "choice", instructions: "What kind of note is it?", criteria: { a: "one", b: "another" } },
    open: { kind: "noul", instructions: "Does it name an undecided choice?" },
  },
};

const ANSWER_WIRE = {
  model: DEFAULT_JEV_MODEL,
  usage: { input_tokens: 1_234 },
  answers: {
    kind: { choice: "a", confidence: 0.8, probabilities: { a: 0.7, b: 0.3 } },
    open: { noul: 0.9 },
  },
};

// ── 1. 要求の組み立て（§1・§4）────────────────────────────────────────

describe("要求の組み立て（05 §1・§4）", () => {
  it("本文に state・model: jev-1.13.0・questions が入り、入口と見出しが正しい", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(ANSWER_WIRE));
    const judge = createJevJudge({ apiKey: "test-key", fetch });

    await judge.judge(REQUEST);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(captured[0]?.authorization).toBe("Bearer test-key");
    const body = bodyOf(captured);
    expect(body.state).toEqual(REQUEST.state);
    expect(body.model).toBe("jev-1.13.0");
    const questions = body.questions as Record<string, Record<string, unknown>>;
    expect(questions.kind).toMatchObject({ type: "choice", instructions: "What kind of note is it?" });
    expect(questions.kind?.criteria).toEqual({ a: "one", b: "another" });
    expect(questions.open).toMatchObject({ type: "noul", instructions: "Does it name an undecided choice?" });
  });

  it("モデルを渡すと、その版の ID を送る（既定は固定の jev-1.13.0）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(ANSWER_WIRE));
    await createJevJudge({ apiKey: "k", model: "jev-1.12.0", fetch }).judge(REQUEST);
    expect(bodyOf(captured).model).toBe("jev-1.12.0");
  });

  it("作った口は、自分の adapter の種類（jev）を名乗る（Issue #473）", () => {
    const { fetch } = recordingFetch(() => jsonResponse(ANSWER_WIRE));
    expect(createJevJudge({ apiKey: "k", fetch }).source).toBe("jev");
  });
});

// ── 2. 再試行（§1）────────────────────────────────────────────────────

describe("混み合っているときの再試行（05 §1）", () => {
  it("429 は指数の待ちで再試行し、成功すれば答えを返す", async () => {
    const { fetch, captured } = recordingFetch((call) =>
      call === 1 ? jsonResponse({ error: "busy" }, 429) : jsonResponse(ANSWER_WIRE),
    );
    const { sleep, delays } = recordingSleep();

    const result = await createJevJudge({ apiKey: "k", fetch, sleep, retryBaseMs: 100 }).judge(REQUEST);

    expect(captured).toHaveLength(2);
    expect(delays).toEqual([100]);
    expect(result.answeredBy).toBe("jev");
  });

  it("429 と 529 が続くと、上限で失敗になる（待ちは 2 倍ずつ伸びる）", async () => {
    const { fetch, captured } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, call % 2 === 0 ? 529 : 429));
    const { sleep, delays } = recordingSleep();

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 3, retryBaseMs: 100 }).judge(REQUEST),
    );

    expect(error.kind).toBe("unavailable");
    expect(captured).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });
});

// ── 3. 再試行しない失敗（§1）────────────────────────────────────────────

describe("再試行しない失敗（05 §1）", () => {
  it("401 は unauthorized にし、再試行しない", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "no key" }, 401));
    const error = await captureError(() => createJevJudge({ apiKey: "k", fetch, maxAttempts: 3 }).judge(REQUEST));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(captured).toHaveLength(1);
  });

  it("422 は invalidRequest にし、再試行しない", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "bad request" }, 422));
    const error = await captureError(() => createJevJudge({ apiKey: "k", fetch, maxAttempts: 3 }).judge(REQUEST));
    expect(error.kind).toBe("invalidRequest");
    expect(error.status).toBe(422);
    expect(captured).toHaveLength(1);
  });
});

// ── 4・5. 応答の解釈（§1・§8）───────────────────────────────────────────

describe("応答の解釈（05 §1・§8 U-J3）", () => {
  it("答えを判定の口の形に直し、トークン数を残す", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(ANSWER_WIRE));
    const result = await createJevJudge({ apiKey: "k", fetch }).judge(REQUEST);

    expect(result.answeredBy).toBe("jev");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(1_234);
    expect(result.answers.kind).toEqual({
      kind: "choice",
      choice: "a",
      probabilities: { a: 0.7, b: 0.3 },
      probability: 0.7,
      confidence: 0.8,
    });
    expect(result.answers.open).toEqual({ kind: "noul", noul: 0.9 });
  });

  it("応答の model（答えた版の ID）を結果に残す", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ ...ANSWER_WIRE, model: "jev-1.13.1" }));
    const result = await createJevJudge({ apiKey: "k", fetch }).judge(REQUEST);
    expect(result.model).toBe("jev-1.13.1");
  });

  it("確率・確信度が無い答えは「不明」（undefined）にする", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ model: DEFAULT_JEV_MODEL, answers: { kind: { choice: "a" }, open: { noul: 0.2, confidence: 0.5 } } }),
    );
    const result = await createJevJudge({ apiKey: "k", fetch }).judge(REQUEST);
    expect(result.answers.kind).toEqual({
      kind: "choice",
      choice: "a",
      probabilities: undefined,
      probability: undefined,
      confidence: undefined,
    });
    // noul は 0〜1 の値だけを持つ（確信度は持たない）
    expect(result.answers.open).toEqual({ kind: "noul", noul: 0.2 });
  });

  it("問いの答えが欠けた応答は malformed にする", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ model: DEFAULT_JEV_MODEL, answers: { kind: { choice: "a" } } }));
    const error = await captureError(() => createJevJudge({ apiKey: "k", fetch }).judge(REQUEST));
    expect(error.kind).toBe("malformed");
  });

  it("JSON として読めない応答は malformed にする", async () => {
    const { fetch } = recordingFetch(() => new Response("これは JSON ではない", { status: 200 }));
    const error = await captureError(() => createJevJudge({ apiKey: "k", fetch }).judge(REQUEST));
    expect(error.kind).toBe("malformed");
  });

  it("種類は互いに区別できる（kind の取り違えが無い）", async () => {
    const kinds: Readonly<Record<string, JevErrorKind>> = {
      unauthorized: (await captureError(() => createJevJudge({ apiKey: "k", fetch: errorFetch(401) }).judge(REQUEST))).kind,
      invalidRequest: (await captureError(() => createJevJudge({ apiKey: "k", fetch: errorFetch(422) }).judge(REQUEST))).kind,
      unavailable: (await captureError(() => createJevJudge({ apiKey: "k", fetch: errorFetch(429), maxAttempts: 1 }).judge(REQUEST))).kind,
    };
    expect(kinds).toEqual({ unauthorized: "unauthorized", invalidRequest: "invalidRequest", unavailable: "unavailable" });
  });
});

// ── 7. 記録した本物の応答（Issue #349）──────────────────────────────────

/** fixture（`__fixtures__/jev-wire/`）を UTF-8 の JSON として読む */
function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`./__fixtures__/jev-wire/${name}`, import.meta.url), "utf8")) as unknown;
}

describe("記録した本物の応答を読む（05 §1・Issue #349）", () => {
  const recordedQuestions = readFixture("request.json");
  const recordedResponse = readFixture("response.json");
  const RECORDED: JudgeRequest = {
    state: { note: "窓口が記録した題材" },
    questions: {
      urgent: { kind: "noul", instructions: "Is this urgent?" },
      team: { kind: "choice", instructions: "Which team?", criteria: { billing: "payments", shipping: "delivery" } },
      tone: { kind: "score", instructions: "How angry is the writer?", criteria: ["calm", "annoyed", "angry"] },
    },
  };

  it("送る本文が、記録した要求（抜粋）と一致する", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(recordedResponse));
    await createJevJudge({ apiKey: "k", fetch }).judge(RECORDED);
    expect(bodyOf(captured).questions).toEqual(recordedQuestions);
  });

  it("noul 0.93・choice shipping（確率 billing 0・shipping 1）・score 1.05（段階 3・確率 3・確信度 0.66）に直す", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(recordedResponse));
    const result = await createJevJudge({ apiKey: "k", fetch }).judge(RECORDED);

    expect(result.answeredBy).toBe("jev");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(364);
    expect(result.answers.urgent).toEqual({ kind: "noul", noul: 0.93 });
    expect(result.answers.team).toEqual({
      kind: "choice",
      choice: "shipping",
      probabilities: { billing: 0, shipping: 1 },
      probability: 1,
      confidence: 1,
    });
    expect(result.answers.tone).toEqual({
      kind: "score",
      score: 1.05,
      legend: ["calm", "annoyed", "angry"],
      probabilities: [0.09, 0.77, 0.14],
      confidence: 0.66,
    });
  });

  it("score の答えが数でなければ malformed にする（#349）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        model: DEFAULT_JEV_MODEL,
        answers: { tone: { score: "annoyed", legend: { 0: "calm", 1: "annoyed" }, probabilities: { 0: 0.5, 1: 0.5 } } },
      }),
    );
    const error = await captureError(() => {
      const request: JudgeRequest = {
        state: {},
        questions: { tone: { kind: "score", instructions: "?", criteria: ["calm", "annoyed"] } },
      };
      return createJevJudge({ apiKey: "k", fetch }).judge(request);
    });
    expect(error.kind).toBe("malformed");
  });
});

// ── 8. score の criteria と instructions の object（Issue #349）──────────

describe("score の criteria と instructions の object（05 §1・Issue #349）", () => {
  const scoreRequest = (criteria: readonly string[]): JudgeRequest => ({
    state: {},
    questions: { tone: { kind: "score", instructions: "How angry is the writer?", criteria } },
  });

  const stageAnswer = (count: number) => ({
    model: DEFAULT_JEV_MODEL,
    answers: {
      tone: {
        score: 0,
        confidence: 0.5,
        legend: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), `stage-${i}`])),
        probabilities: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), 1 / count])),
      },
    },
  });

  it("score の criteria を、順序のある配列のまま送る", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(stageAnswer(3)));
    await createJevJudge({ apiKey: "k", fetch }).judge(scoreRequest(["a", "b", "c"]));
    const questions = bodyOf(captured).questions as Record<string, Record<string, unknown>>;
    expect(questions.tone?.criteria).toEqual(["a", "b", "c"]);
  });

  it("段階が 2 個ちょうど・10 個ちょうどは送る", async () => {
    for (const count of [2, 10]) {
      const { fetch, captured } = recordingFetch(() => jsonResponse(stageAnswer(count)));
      const stages = Array.from({ length: count }, (_, i) => `stage-${i}`);
      await createJevJudge({ apiKey: "k", fetch }).judge(scoreRequest(stages));
      expect(captured).toHaveLength(1);
    }
  });

  it("段階が 2 個未満（1 個）なら、送る前に断る", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({}));
    await expect(createJevJudge({ apiKey: "k", fetch }).judge(scoreRequest(["only"]))).rejects.toThrow(RangeError);
    expect(captured).toHaveLength(0);
  });

  it("段階が 11 個以上（11 個）なら、送る前に断る", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({}));
    const eleven = Array.from({ length: 11 }, (_, i) => `stage-${i}`);
    await expect(createJevJudge({ apiKey: "k", fetch }).judge(scoreRequest(eleven))).rejects.toThrow(RangeError);
    expect(captured).toHaveLength(0);
  });

  it("instructions の object は、そのまま送る", async () => {
    const instructions = { question: "Which team?", note: { hint: "pick one" } };
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse({
        model: DEFAULT_JEV_MODEL,
        answers: { team: { choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } } },
      }),
    );
    const request: JudgeRequest = {
      state: {},
      questions: { team: { kind: "choice", instructions, criteria: { a: "one", b: "another" } } },
    };
    await createJevJudge({ apiKey: "k", fetch }).judge(request);
    const questions = bodyOf(captured).questions as Record<string, Record<string, unknown>>;
    expect(questions.team?.instructions).toEqual(instructions);
  });
});

function errorFetch(status: number): JevFetch {
  return async () => jsonResponse({ error: "x" }, status);
}

// ── 中断の合図と、共有の門（05 §1・§4・Issue #455）──────────────────────

/** 応答を返さない fetch（中断の試験用）。打ち切りの合図で拒否する */
const hangingJevFetch: JevFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("呼び出しごとの中断の合図（05 §1・§4・Issue #455）", () => {
  it("要求の合図で、実通信を打ち切る（作るときに合図を渡さなくても）", async () => {
    const controller = new AbortController();
    const judge = createJevJudge({ apiKey: "k", fetch: hangingJevFetch });

    const pending = judge.judge({ ...REQUEST, signal: controller.signal });
    controller.abort();

    const error = await captureError(() => pending);
    expect(error.kind).toBe("timeout");
  });

  it("要求の合図で、再送の待機も止める（再送しない）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const controller = new AbortController();
    // 待機に入ったことを知らせたうえで、そのまま待ち続ける sleep
    let enteredWait: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      enteredWait = resolve;
    });
    const sleep = (): Promise<void> => {
      enteredWait();
      return new Promise<void>(() => {});
    };
    const judge = createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 3, retryBaseMs: 1 });

    const pending = judge.judge({ ...REQUEST, signal: controller.signal });
    await waiting;
    controller.abort();

    const error = await captureError(() => pending);
    expect(error.kind).toBe("timeout");
    expect(captured).toHaveLength(1);
  });
});

// ── 再送の待ちを、中断の合図で片付ける（05 §1・Issue #477）──────────────────
//
// 待ちの資源は持ち主で分ける（#477）。**既定の待ち**が作るタイマーは、中断で `clearTimeout` して消し、
// 満了では合図の listener を外す。**adapter が合図に足した listener**は、どの終わり方（中断・満了・
// 差し替えの Promise の拒否・差し替えの同期の throw）でも残さない。差し替えが自分で作った資源は、
// 差し替えの持ち主の責任とする。

/** 合図に残る listener の数を数える（生存の集合から数える） */
interface AbortLedger {
  remaining(): number;
}

/**
 * 合図の listener の生死を数える。`addEventListener`/`removeEventListener` を差し替え、`once` の
 * listener は包んで登録し、**元の関数と実際に登録した関数の対応**を覚える。明示の削除では、実際に登録
 * した関数（`once` なら包んだほう）を渡さないと外れないので、取り違えを「外れた」と数えないため
 * （Issue #477・F2。素朴に「削除の回数」を引くと、実際には残っているのに残数 0 と報告できてしまう）。
 * 生存は登録ごとの印で持ち、**明示の削除と `once` の自動除去のどちらでも、同じ登録を 1 回だけ落とす**。
 */
function trackAbortListeners(signal: AbortSignal): AbortLedger {
  interface Registration {
    readonly original: (event: Event) => void;
    actual: (event: Event) => void;
    live: boolean;
  }
  const registrations: Registration[] = [];
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const patched = {
    addEventListener: (type: string, listener: (event: Event) => void, options?: { readonly once?: boolean }): void => {
      if (type !== "abort") {
        originalAdd(type, listener, options);
        return;
      }
      const registration: Registration = { original: listener, actual: listener, live: true };
      if (options?.once === true) {
        // `once` は発火でプラットフォームが外す——その 1 回を、ここで「落ちた」と数える
        registration.actual = (event) => {
          registration.live = false;
          listener(event);
        };
      }
      registrations.push(registration);
      originalAdd(type, registration.actual, options);
    },
    removeEventListener: (type: string, listener: (event: Event) => void, options?: boolean): void => {
      if (type !== "abort") {
        originalRemove(type, listener, options);
        return;
      }
      // 実際に登録した関数で外す（`once` は包んだほう）。元の関数が一致する生きた登録を 1 つだけ落とす
      // ——一致するものが無ければ何もしない（取り違えを「外れた」と数えない）。
      for (let i = registrations.length - 1; i >= 0; i -= 1) {
        const registration = registrations[i];
        if (registration !== undefined && registration.live && registration.original === listener) {
          registration.live = false;
          originalRemove(type, registration.actual, options);
          return;
        }
      }
    },
  };
  Object.defineProperty(signal, "addEventListener", { configurable: true, writable: true, value: patched.addEventListener });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    writable: true,
    value: patched.removeEventListener,
  });
  return { remaining: () => registrations.filter((registration) => registration.live).length };
}

/** 合図に登録していない別の関数（取り違えの削除＝実際には外れない、の負例に使う。Issue #477・F2） */
const unregisteredListener = (): void => {};

afterEach(() => {
  vi.useRealTimers();
});

describe("再送の待ちを、中断の合図で片付ける（05 §1・Issue #477）", () => {
  it("既定の sleep は、中断でタイマーを消して timeout にし、あとで時計を進めても再送しない（#477・a）", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    // 既定の sleep（差し替えない）。retryBaseMs の既定は 1000ms
    const judge = createJevJudge({ apiKey: "k", fetch });

    const pending = judge.judge({ ...REQUEST, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0); // 初回の fetch を解決し、待ちに入る
    expect(vi.getTimerCount()).toBe(1); // 待ちのタイマーが掛かっている

    controller.abort();

    const error = await captureError(() => pending);
    expect(error.kind).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0); // 中断でタイマーが消える
    expect(ledger.remaining()).toBe(0); // 合図の listener も残らない

    await vi.advanceTimersByTimeAsync(10_000); // 待ちの長さを越えて時計を進める
    expect(captured).toHaveLength(1); // 再送 0
  });

  it("既定の sleep は、待ちの満了で再送して成功し、タイマーも listener も残さない（#477・b）", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const { fetch, captured } = recordingFetch((call) =>
      call === 1 ? jsonResponse({ error: "busy" }, 429) : jsonResponse(ANSWER_WIRE),
    );
    const judge = createJevJudge({ apiKey: "k", fetch }); // 既定の sleep

    const pending = judge.judge({ ...REQUEST, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // 既定の待ち（1000ms）の満了で再送する

    const result = await pending;
    expect(result.answeredBy).toBe("jev");
    expect(captured).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(ledger.remaining()).toBe(0);
  });

  it("差し替えの sleep が Promise を拒否したら、その誤りのまま失敗し、listener を残さない（#477・c）", async () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const failure = new Error("sleep が拒否した");
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const judge = createJevJudge({ apiKey: "k", fetch, sleep: () => Promise.reject(failure) });

    await expect(judge.judge({ ...REQUEST, signal: controller.signal })).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(ledger.remaining()).toBe(0);
  });

  it("差し替えの sleep が同期に throw しても、その誤りのまま失敗し、listener を残さない（#477・c2）", async () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const failure = new Error("sleep が同期に throw した");
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const judge = createJevJudge({
      apiKey: "k",
      fetch,
      sleep: () => {
        throw failure;
      },
    });

    await expect(judge.judge({ ...REQUEST, signal: controller.signal })).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(ledger.remaining()).toBe(0);
  });

  it("既に中断した合図の要求は、429 のあと待たずに timeout にし、タイマーも再送も作らない（#477・c3）", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(); // 先に中断しておく
    const ledger = trackAbortListeners(controller.signal);
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const judge = createJevJudge({ apiKey: "k", fetch }); // 既定の sleep

    const error = await captureError(() => judge.judge({ ...REQUEST, signal: controller.signal }));

    expect(error.kind).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
    expect(ledger.remaining()).toBe(0);
    expect(captured).toHaveLength(1);
  });

  it("差し替えの sleep の呼び出し中に合図が同期に中断し、未解決の Promise でも timeout にする（#477・F1）", async () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    let notified = 0;
    const judge = createJevJudge({
      apiKey: "k",
      fetch,
      // 呼び出しの中で合図を中断し、そのまま待ち続ける Promise を返す——abort のイベントは listener を
      // 足す前に終わっている。取り逃すと待ちが終わらず、listener が残る
      sleep: () => {
        controller.abort();
        return new Promise<void>(() => {});
      },
    });

    const error = await captureError(() =>
      judge.judge({
        ...REQUEST,
        signal: controller.signal,
        onRetryStarted: () => {
          notified += 1;
        },
      }),
    );

    expect(error.kind).toBe("timeout");
    expect(captured).toHaveLength(1); // 再送 0
    expect(notified).toBe(0); // 再送を始めた通知 0
    expect(ledger.remaining()).toBe(0); // 足した listener も残らない
  });

  it("差し替えの sleep の呼び出し中に合図が同期に中断し、解決済みの Promise でも成功にしない（#477・F1）", async () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    let notified = 0;
    const judge = createJevJudge({
      apiKey: "k",
      fetch,
      // 呼び出しの中で合図を中断し、解決済みの Promise を返す——取り逃すと待ちを成功として扱い、再送する
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    const error = await captureError(() =>
      judge.judge({
        ...REQUEST,
        signal: controller.signal,
        onRetryStarted: () => {
          notified += 1;
        },
      }),
    );

    expect(error.kind).toBe("timeout");
    expect(captured).toHaveLength(1); // 再送 0
    expect(notified).toBe(0); // 再送を始めた通知 0
    expect(ledger.remaining()).toBe(0);
  });

  it("合図の無い要求は、今のまま待って再送する（待ちの長さの列は今の期待のまま）（#477・d）", async () => {
    const { fetch, captured } = recordingFetch((call) =>
      call < 3 ? jsonResponse({ error: "busy" }, 429) : jsonResponse(ANSWER_WIRE),
    );
    const { sleep, delays } = recordingSleep();

    const result = await createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 3, retryBaseMs: 100 }).judge(REQUEST);

    expect(result.answeredBy).toBe("jev");
    expect(captured).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });
});

describe("合図の listener の台帳そのものの負例（Issue #477・F2）", () => {
  it("削除する関数を取り違えると、外れていないことを検出できる", () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    let fired = 0;
    const registered = () => {
      fired += 1;
    };
    controller.signal.addEventListener("abort", registered, { once: true });

    controller.signal.removeEventListener("abort", unregisteredListener); // 登録していない別の関数（取り違え）
    expect(ledger.remaining()).toBe(1); // 実際には外れていないので、残数は減らない

    controller.abort();
    expect(fired).toBe(1); // 中断すれば、まだ発火する（外れていない証拠）
    expect(ledger.remaining()).toBe(0); // 発火（`once` の自動除去）で初めて落ちる
  });

  it("正しく外したあとの中断では、完了済みの listener が発火しない", () => {
    const controller = new AbortController();
    const ledger = trackAbortListeners(controller.signal);
    let fired = 0;
    const registered = () => {
      fired += 1;
    };
    controller.signal.addEventListener("abort", registered, { once: true });

    controller.signal.removeEventListener("abort", registered); // 実際に登録した関数（包んだほう）で外す
    expect(ledger.remaining()).toBe(0);

    controller.abort(); // 完了後に中断する
    expect(fired).toBe(0); // 完了済みの listener は発火しない
  });
});

describe("内部の再送を共有の門に通す（05 §1・Issue #455）", () => {
  it("共有の門を渡すと、内部の再送も各回で数えられ、上限で再送しない", async () => {
    const { fetch, captured } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep } = recordingSleep();
    // 呼ぶ側（包み）が最初の 1 回を数えた、という前提（同じ門を共有する）
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 2 });
    gate.begin();

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, gate, maxAttempts: 10, retryBaseMs: 100 }).judge(REQUEST),
    );

    expect(error.kind).toBe("unavailable");
    // 最初の 1 回（呼ぶ側が数える）＋ 再送 1 回（門が各回で数える）＝ 2 回で、上限に達して再送しない
    expect(captured).toHaveLength(2);
    expect(gate.attempts()).toBe(2);
  });

  it("共有の門を渡すと、締切を過ぎた再送はしない", async () => {
    let clock = 0;
    const gate = createCallGate({ now: () => clock, deadline: 5, limit: 10 });
    gate.begin();
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    // 再送の待機で、締切（5ms）を過ぎる
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, gate, retryBaseMs: 100 }).judge(REQUEST),
    );

    expect(error.kind).toBe("timeout");
    expect(captured).toHaveLength(1);
  });

  it("門を渡さないときは、今までどおり上限まで再送する", async () => {
    const { fetch, captured } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep, delays } = recordingSleep();

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 3, retryBaseMs: 100 }).judge(REQUEST),
    );

    expect(error.kind).toBe("unavailable");
    expect(captured).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });
});

// ── 要求の門で、内部の再送の各回を数える（Issue #469）──────────────────────
//
// 包み（`createBudgetedJudge`）は、生成と共有する門を**要求**に載せる。adapter は、要求に門があれば
// それを使い（無ければ作るときに渡された門）、**再送の各回だけ**を数える（最初の 1 回は包みが数える）。
// 門が断ったときは、**通常の混み合い・再送回数の尽きと区別できる種類**（`gateLimit`・`gateDeadline`）に
// して、包みが門の停止へ写せるようにする。

describe("要求の門で、内部の再送の各回を数える（05 §1・Issue #469）", () => {
  it("要求の門を渡すと、再送の各回だけを数える（最初の 1 回は数えない）", async () => {
    const { fetch, captured } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep, delays } = recordingSleep();
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 2, retryBaseMs: 100 }).judge({ ...REQUEST, gate }),
    );

    expect(error.kind).toBe("unavailable");
    expect(captured).toHaveLength(2);
    expect(delays).toEqual([100]);
    // 最初の 1 回は包みが数えるので、adapter が数えるのは再送の 1 回だけ
    expect(gate.attempts()).toBe(1);
  });

  it("要求の門が上限で再送を断ったら gateLimit にし、通常の混み合いと区別できる", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const { sleep } = recordingSleep();
    // 包みが最初の 1 回を数えた、という前提（同じ門を共有する）
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 1 });
    gate.begin();

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 5, retryBaseMs: 100 }).judge({ ...REQUEST, gate }),
    );

    // 通常の混み合い（上限まで再送した `unavailable`）ではなく、門の断り（`gateLimit`）である
    expect(error.kind).toBe("gateLimit");
    expect(captured).toHaveLength(1);
    expect(gate.attempts()).toBe(1);
  });

  it("要求の門が締切で再送を断ったら gateDeadline にし、timeout と区別できる", async () => {
    let clock = 0;
    const gate = createCallGate({ now: () => clock, deadline: 1_000, limit: 10 });
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    // 再送の待機で、締切（1000ms）を過ぎる
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 5, retryBaseMs: 2_000 }).judge({ ...REQUEST, gate }),
    );

    expect(error.kind).toBe("gateDeadline");
    expect(captured).toHaveLength(1);
  });

  it("要求と作るときの門が両方あれば、要求の門だけが増える", async () => {
    const { fetch } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep } = recordingSleep();
    const requestGate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    const creationGate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, gate: creationGate, maxAttempts: 2, retryBaseMs: 100 }).judge({
        ...REQUEST,
        gate: requestGate,
      }),
    );

    expect(error.kind).toBe("unavailable");
    expect(requestGate.attempts()).toBe(1);
    expect(creationGate.attempts()).toBe(0);
  });

  it("同じ adapter を、別の要求の門 A・B で使い回しても、数が混ざらない", async () => {
    const { fetch } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep } = recordingSleep();
    const judge = createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 2, retryBaseMs: 100 });
    const gateA = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });
    const gateB = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });

    await captureError(() => judge.judge({ ...REQUEST, gate: gateA }));
    await captureError(() => judge.judge({ ...REQUEST, gate: gateB }));

    // それぞれの要求の門が、自分の再送（1 回ずつ）だけを数える
    expect(gateA.attempts()).toBe(1);
    expect(gateB.attempts()).toBe(1);
  });

  it("要求に門が無く、作るときに門を渡してあれば、それを使う（#455 の後方）", async () => {
    const { fetch, captured } = recordingFetch((call) => jsonResponse({ error: `busy ${call}` }, 429));
    const { sleep, delays } = recordingSleep();
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 10 });

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, gate, maxAttempts: 2, retryBaseMs: 100 }).judge(REQUEST),
    );

    // 要求に門が無いので、作るときに渡した門を使う。断りの種類は今までどおり（`unavailable`）
    expect(error.kind).toBe("unavailable");
    expect(captured).toHaveLength(2);
    expect(delays).toEqual([100]);
    expect(gate.attempts()).toBe(1);
  });
});

// ── 要求の通知で、再送を始めたことを知らせる（Issue #473）──────────────────
//
// 包み（`createBudgetedJudge`）は、要求に「再送を始めた」通知（`onRetryStarted`）を載せる。adapter は、
// 既存の再送の条件と門の許可を満たして**次の送信を始める時点**で 1 回呼ぶ。門の有無を問わず同じ通知を
// 使う——門全体の差分は使わない（生成側の増分を混ぜないため）。門・締切で断られた再送では呼ばない。

describe("要求の通知で、再送を始めたことを知らせる（05 §1・Issue #473）", () => {
  it("再送を始める各回で 1 回呼ぶ（初回は数えない。門なし）", async () => {
    const { fetch, captured } = recordingFetch((call) =>
      call < 3 ? jsonResponse({ error: "busy" }, 429) : jsonResponse(ANSWER_WIRE),
    );
    const { sleep } = recordingSleep();
    let notified = 0;

    const result = await createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 3, retryBaseMs: 100 }).judge({
      ...REQUEST,
      onRetryStarted: () => {
        notified += 1;
      },
    });

    expect(result.answeredBy).toBe("jev");
    expect(captured).toHaveLength(3);
    // 初回のあとの再送 2 回でだけ知らせる
    expect(notified).toBe(2);
  });

  it("要求の門が上限で再送を断ったら、通知を呼ばない", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const { sleep } = recordingSleep();
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 1 });
    gate.begin(); // 包みが初回を数えた、という前提（同じ門を共有する）
    let notified = 0;

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 5, retryBaseMs: 100 }).judge({
        ...REQUEST,
        gate,
        onRetryStarted: () => {
          notified += 1;
        },
      }),
    );

    expect(error.kind).toBe("gateLimit");
    expect(captured).toHaveLength(1);
    expect(notified).toBe(0);
  });

  it("要求の門が締切で再送を断ったら、通知を呼ばない", async () => {
    let clock = 0;
    const gate = createCallGate({ now: () => clock, deadline: 1_000, limit: 10 });
    const { fetch, captured } = recordingFetch(() => jsonResponse({ error: "busy" }, 429));
    const sleep = async (ms: number): Promise<void> => {
      clock += ms; // 再送の待機で締切（1000ms）を越える
    };
    let notified = 0;

    const error = await captureError(() =>
      createJevJudge({ apiKey: "k", fetch, sleep, maxAttempts: 5, retryBaseMs: 2_000 }).judge({
        ...REQUEST,
        gate,
        onRetryStarted: () => {
          notified += 1;
        },
      }),
    );

    expect(error.kind).toBe("gateDeadline");
    expect(captured).toHaveLength(1);
    expect(notified).toBe(0);
  });
});

// ── 6. 環境変数を読まない（§4・R-15）────────────────────────────────────

describe("adapter は環境変数を読まない（05 §4・R-15）", () => {
  it("judge-jev.ts に環境変数の入口が無い", () => {
    const source = fs.readFileSync(new URL("./judge-jev.ts", import.meta.url), "utf8");
    const forbidden = ["process.env", "process[", "import.meta.env", "Deno.env", "globalThis.process", "JEV_API_KEY"];
    for (const token of forbidden) {
      expect(source.includes(token), `judge-jev.ts に ${token} がある`).toBe(false);
    }
  });
});
