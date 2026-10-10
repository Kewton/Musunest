// Jev（TypeSafe の System One）の判定の adapter（Issue #330）の unit テスト。
//
// **実 API は呼ばない。** 差し込んだ `fetch` が受け取った要求と、手で書いた応答だけで閉じる。
// ここで固定したいのは 6 つ。
//   1. 送る本文の形（`state`・`model: jev-1.13.0`・`questions`）と `Authorization: Bearer` の見出し（§1・§4）
//   2. 429・529 は指数の待ちで再試行し、上限で失敗になる（§1）
//   3. 401・422 は再試行しない失敗の種類にする（§1）
//   4. 応答の `model` を結果に残す（§8 U-J3）
//   5. 答え（choice・noul）とトークン数を、判定の口の形に直す（§1）
//   6. adapter のソースが環境変数を読まない（§4・R-15）
import { describe, expect, it } from "vitest";
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
    kind: { choice: "a", confidence: 0.8, probability: 0.7 },
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
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "a", probability: 0.7, confidence: 0.8 });
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
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "a", probability: undefined, confidence: undefined });
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

function errorFetch(status: number): JevFetch {
  return async () => jsonResponse({ error: "x" }, status);
}

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
