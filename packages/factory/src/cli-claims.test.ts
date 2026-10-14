// 流し直す入口（cli-claims.ts）の unit テスト（Issue #459）。
//
// **偽物の判定・時計・ファイル・環境値で閉じ、通信を拒否する。実 API は呼ばない。**
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@musunest/spec-engine";
import type { Judge, JudgeAnswer, JudgeRequest } from "./judge.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { SAMPLE_DOCUMENTS } from "./stages/__tests__/prompt.js";
import {
  CLAIMS_DIAGNOSTIC_SCHEMA,
  CLAIMS_SET_SCHEMA,
  JUDGE_CLAIMS_EXIT_OK,
  JUDGE_CLAIMS_EXIT_STOPPED,
  JUDGE_CLAIMS_EXIT_USAGE,
  convertDiagnostic,
  parseClaimsSet,
  parseJudgeClaimsArguments,
  runJudgeClaims,
} from "./cli-claims.js";

const DOCS = SAMPLE_DOCUMENTS;
const DOC_HASH = await sha256Hex(JSON.stringify(DOCS));

const CLAIMS_TEXT = JSON.stringify({
  schema_version: CLAIMS_SET_SCHEMA,
  doc_version: "v1",
  doc_hash: DOC_HASH,
  claims: [
    {
      id: "c1",
      run_id: "run-1",
      index: 0,
      requirement_id: "R-1",
      requirement_text: "要件 1",
      part: "穴の部分",
      reason: "理由 1",
      constraint_ids: ["記録"],
      alternative: "代案 1",
    },
    {
      id: "c2",
      run_id: "run-1",
      index: 1,
      requirement_id: "R-2",
      requirement_text: null,
      part: "文脈不足の部分",
      reason: "理由 2",
      constraint_ids: ["合計"],
      alternative: null,
    },
  ],
});

function choice(value: string, confidence = 0.9): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability: confidence, confidence };
}

/** 問いの名前ごとに妥当な答えを返す偽物（主）。応答の `answeredBy` と `inputTokens` は差し替えられる */
function answering(
  overrides: { readonly answeredBy?: "jev" | "llm" | "fake"; readonly inputTokens?: number } = {},
): Judge {
  return {
    async judge(request: JudgeRequest) {
      const out: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        if (name.startsWith("claim-t2")) out[name] = choice("vocabulary_gap");
        else if (name.startsWith("claim-t3") || name.startsWith("claim-t1")) out[name] = choice("vocabulary-hole");
        else if (name.startsWith("claim-s3-select")) out[name] = choice("none-of-them");
        else if (name.startsWith("claim-s3-section") || name.startsWith("claim-s2") || name.startsWith("claim-s4")) out[name] = choice("restricts");
        else if (name.startsWith("plan-triage")) out[name] = choice("vocabulary-hole");
        else if (name.startsWith("plan-support")) out[name] = choice("not-stated");
        else if (name.startsWith("plan-recheck-kind")) out[name] = choice("undecidable");
        else out[name] = choice("none");
      }
      return { answers: out, inputTokens: overrides.inputTokens ?? 0, model: "fake-judge", answeredBy: overrides.answeredBy ?? "fake" };
    },
  };
}

const DUMMY_CLIENT: LlmClient = {
  callStructured<T>(_request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
    return Promise.reject(new Error("実 API は呼ばない"));
  },
  callWithTools(): Promise<LlmToolResponse> {
    return Promise.reject(new Error("実 API は呼ばない"));
  },
};

interface Harness {
  readonly code: number;
  readonly output: Record<string, unknown>;
  readonly log: string[];
  readonly events: string[];
  readonly requests: JudgeRequest[];
}

async function run(
  argv: readonly string[],
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly judge?: Judge;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: () => number;
    readonly makeJevJudge?: (options: { apiKey: string }) => Judge;
    readonly deadlineMs?: number;
  } = {},
): Promise<Harness> {
  const {
    files: extraFiles = {},
    judge = answering(),
    env: extraEnv = {},
    now = (): number => 0,
    makeJevJudge,
    deadlineMs,
  } = options;
  const files: Record<string, string> = { "claims.json": CLAIMS_TEXT, ...extraFiles };
  const log: string[] = [];
  const events: string[] = [];
  const requests: JudgeRequest[] = [];
  const recordedJudge: Judge = {
    async judge(request) {
      events.push("judge");
      requests.push(request);
      return judge.judge(request);
    },
  };
  const written: Record<string, string> = {};
  const code = await runJudgeClaims({
    argv,
    env: { OPENAI_API_KEY: "sk-FAKE", ...extraEnv },
    readFile: async (path) => {
      events.push(`read:${path}`);
      const text = files[path];
      if (text === undefined) throw new Error(`ファイルがありません: ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      written[path] = text;
    },
    loadDocuments: async () => DOCS,
    makeClient: () => DUMMY_CLIENT,
    makeLlmJudge: () => recordedJudge,
    ...(makeJevJudge === undefined ? {} : { makeJevJudge }),
    now,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    log: (line) => log.push(line),
  });
  const out = written["out.json"];
  return { code, output: out === undefined ? {} : (JSON.parse(out) as Record<string, unknown>), log, events, requests };
}

const BASE_ARGS = ["--claims", "claims.json", "--out", "out.json"];

// ── 引数の読み取り（Issue #459）──────────────────────────────────────

describe("引数の読み取り（Issue #459）", () => {
  it("形・反復・集計の引数の不正は使い方の誤り", () => {
    expect(parseJudgeClaimsArguments(["--claims", "c", "--out", "o", "--repeat", "0"])).toEqual({
      error: "--repeat には 1 以上の整数を指定してください",
    });
    expect(parseJudgeClaimsArguments(["--claims", "c", "--out", "o", "--rule", "x"])).toEqual({
      error: "--rule は unanimous か majority です",
    });
    expect(parseJudgeClaimsArguments(["--claims", "c", "--out", "o", "--forms", "T1,Z9"])).toEqual({
      error: "--forms に知らない形があります: Z9",
    });
  });

  it("--claims と --diagnostic はちょうど一方", () => {
    expect(parseJudgeClaimsArguments(["--out", "o"])).toEqual({ error: "--claims か --diagnostic のちょうど一方を指定してください" });
  });

  it("形・反復・集計の引数の不正は、実行でも使い方の誤りで終わる", async () => {
    expect((await run(["--claims", "claims.json", "--out", "out.json", "--repeat", "x"])).code).toBe(JUDGE_CLAIMS_EXIT_USAGE);
  });
});

// ── 入力の読み込みと変換（Issue #459）────────────────────────────────

describe("入力の読み込みと変換（Issue #459）", () => {
  it("診断からの変換は、文書の版とハッシュの明示の引数が無ければ止まり、過去の判定の欄を落とす", () => {
    const diagnostic = JSON.stringify({
      schema_version: CLAIMS_DIAGNOSTIC_SCHEMA,
      plan_id: "plan-1",
      claims: [
        {
          check: 1,
          index: 0,
          requirement_id: "R-1",
          part: "穴の部分",
          reason: "理由",
          constraint_ids: ["記録"],
          doc_version: "v1",
          classification: "vocabulary-hole",
          adapter: "jev",
          confidence: 0.9,
          evidence_id: "記録",
        },
      ],
    });
    const converted = convertDiagnostic(diagnostic, "v1", "hash-x");
    expect("error" in converted).toBe(false);
    if ("error" in converted) return;
    expect(converted.docHash).toBe("hash-x");
    // 要件の文と代わりの案は診断に無いので null。過去の分類・確信度・根拠は写さない
    expect(converted.claims[0]).toMatchObject({ requirementText: null, alternative: null, constraintIds: ["記録"] });
    expect(converted.claims[0]).not.toHaveProperty("classification");
    expect(converted.claims[0]).not.toHaveProperty("confidence");
  });

  it("変換の明示の引数が無ければ、実行は使い方の誤りで止まる", async () => {
    const harness = await run(["--diagnostic", "diag.json", "--out", "out.json"], {
      files: { "diag.json": JSON.stringify({ schema_version: CLAIMS_DIAGNOSTIC_SCHEMA, plan_id: "p", claims: [] }) },
    });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_USAGE);
    expect(harness.events.includes("judge")).toBe(false);
  });

  it("申告の組は v1 を読む", () => {
    const parsed = parseClaimsSet(CLAIMS_TEXT);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.claims).toHaveLength(2);
  });
});

// ── 文書のハッシュの照合（Issue #459）────────────────────────────────

describe("文書のハッシュ不一致で呼ばずに止まる（Issue #459）", () => {
  it("組の doc_hash が文書と違えば、判定を呼ばずに止まる", async () => {
    const text = JSON.stringify({
      schema_version: CLAIMS_SET_SCHEMA,
      doc_version: "v1",
      doc_hash: "wrong",
      claims: [],
    });
    const harness = await run(BASE_ARGS, { files: { "claims.json": text } });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_STOPPED);
    expect(harness.events.includes("judge")).toBe(false);
  });
});

// ── 文脈不足の層（Issue #459）───────────────────────────────────────

describe("要件の文が無い申告は、文脈不足の層に数えられ、再点検の口に要求が送られない（Issue #459）", () => {
  it("文脈不足の申告で再点検の呼び出しが起きず、主の比較の分母から外れる", async () => {
    const harness = await run([...BASE_ARGS, "--labels", "labels.json"], {
      files: {
        "labels.json": JSON.stringify({
          doc_version: "v1",
          doc_hash: DOC_HASH,
          labels: [
            { id: "c1", kind: "vocabulary-hole", expressible: "false" },
            { id: "c2", kind: "vocabulary-hole", expressible: "false" },
          ],
        }),
      },
    });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    expect(harness.output["context_insufficient"]).toEqual(["c2"]);
    // 再点検の問いは、要件の文のある束（c1）でだけ 1 回送られる
    const recheckRequests = harness.requests.filter((request) =>
      Object.keys(request.questions).some((name) => name.startsWith("plan-recheck")),
    );
    expect(recheckRequests).toHaveLength(1);
  });
});

// ── 反復と選択肢の反転（Issue #459）─────────────────────────────────

describe("--repeat と --reverse-options は別の操作として記録される（Issue #459）", () => {
  it("反復は申告の数に足さず、反転は別の要求のハッシュになる", async () => {
    const args = ["--claims", "claims.json", "--out", "out.json", "--repeat", "3", "--reverse-options"];
    const harness = await run(args);
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    expect(harness.output["operations"]).toEqual(["forward", "forward#2", "forward#3", "reverse", "reverse#2", "reverse#3"]);
    const claims = harness.output["claims"] as readonly unknown[];
    expect(claims).toHaveLength(2);
    const calls = harness.output["calls"] as readonly { readonly operation: string; readonly request_hash: string }[];
    const forward = calls.find((call) => call.operation === "forward");
    const reverse = calls.find((call) => call.operation === "reverse");
    expect(forward?.request_hash).not.toBe(reverse?.request_hash);
  });
});

// ── 判定の口の選択と鍵（Issue #459）─────────────────────────────────

describe("--judge jev は鍵が無ければ止まり、LLM で代用しない（Issue #459）", () => {
  it("JEV_API_KEY が無ければ使い方の誤りで止まる", async () => {
    let jevBuilt = false;
    const harness = await run([...BASE_ARGS, "--judge", "jev"], {
      makeJevJudge: () => {
        jevBuilt = true;
        return answering();
      },
    });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_USAGE);
    expect(jevBuilt).toBe(false);
    expect(harness.events.includes("judge")).toBe(false);
    expect(harness.log.some((line) => line.includes("JEV_API_KEY"))).toBe(true);
  });
});

describe("切替の呼び出しは adapter で層別され、再点検とは別に数えられる（Issue #459）", () => {
  it("Jev が止まると LLM が答え、呼び出しの adapter が記録に残る", async () => {
    const harness = await run([...BASE_ARGS, "--judge", "fallback"], {
      env: { JEV_API_KEY: "jev-FAKE" },
      makeJevJudge: () => ({
        async judge() {
          throw new Error("jev down");
        },
      }),
      judge: answering({ answeredBy: "llm" }),
    });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    const calls = harness.output["calls"] as readonly { readonly answered_by: string }[];
    expect(calls.some((call) => call.answered_by === "llm")).toBe(true);
    expect(calls.some((call) => call.answered_by === "jev")).toBe(false);
  });
});

// ── 総回数の上限（Issue #459）──────────────────────────────────────

describe("総回数の上限で次を呼ばず、not-run が出力に残る（Issue #459）", () => {
  it("予定数＝実行数＋未実行数になり、状態が残る", async () => {
    const harness = await run([...BASE_ARGS, "--max-calls", "3"]);
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    const calls = harness.output["calls"] as readonly { readonly state: string }[];
    expect(calls.some((call) => call.state === "not-run")).toBe(true);
    const planned = harness.output["planned"] as number;
    const executed = harness.output["executed"] as number;
    const notRun = harness.output["not_run"] as number;
    expect(planned).toBe(executed + notRun);
    expect(planned).toBe(calls.length);
  });
});

// ── 締切後の答えを成功にしない（Issue #459）─────────────────────────

describe("締切の後に届いた答えを成功にしない（Issue #459）", () => {
  it("途中で締切を越えたら、以後の呼び出しは成功にならない", async () => {
    let clock = 0;
    const harness = await run([...BASE_ARGS], {
      now: () => clock,
      deadlineMs: 1,
      judge: {
        async judge(request) {
          clock += 10; // 呼び出しの間に締切を越える
          const out: Record<string, JudgeAnswer> = {};
          for (const name of Object.keys(request.questions)) out[name] = choice("vocabulary-hole");
          return { answers: out, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
        },
      },
    });
    const calls = harness.output["calls"] as readonly { readonly state: string }[];
    expect(calls.every((call) => call.state !== "ok")).toBe(true);
  });
});

// ── 正解は判定の後に読む（Issue #459）───────────────────────────────

describe("正解は判定の後に読み、判定の要求に正解の値が含まれない（Issue #459）", () => {
  it("labels.json の読み込みが最初の判定より後で、要求に正解の欄が無い", async () => {
    const harness = await run([...BASE_ARGS, "--labels", "labels.json"], {
      files: {
        "labels.json": JSON.stringify({
          doc_version: "v1",
          doc_hash: DOC_HASH,
          labels: [
            { id: "c1", kind: "vocabulary-hole", expressible: "false" },
            { id: "c2", kind: "vocabulary-hole", expressible: "false" },
          ],
        }),
      },
    });
    const firstJudge = harness.events.indexOf("judge");
    const labelsRead = harness.events.indexOf("read:labels.json");
    expect(firstJudge).toBeGreaterThanOrEqual(0);
    expect(labelsRead).toBeGreaterThan(firstJudge);
    expect(JSON.stringify(harness.requests).includes("expressible")).toBe(false);
  });
});

// ── 使用量は原値のまま（Issue #459）────────────────────────────────

describe("使用量は原値のまま写る（Issue #459）", () => {
  it("Jev の入力トークンが 0 のときは印が付き、正の値では付かない", async () => {
    const zero = await run(BASE_ARGS, { judge: answering({ answeredBy: "jev", inputTokens: 0 }) });
    const zeroCalls = zero.output["calls"] as readonly { readonly answered_by: string; readonly usage_unmeasurable: boolean }[];
    expect(zeroCalls.filter((call) => call.answered_by === "jev").every((call) => call.usage_unmeasurable)).toBe(true);

    const positive = await run(BASE_ARGS, { judge: answering({ answeredBy: "jev", inputTokens: 5 }) });
    const positiveCalls = positive.output["calls"] as readonly { readonly input_tokens: number; readonly usage_unmeasurable: boolean }[];
    expect(positiveCalls.filter((call) => call.input_tokens === 5).every((call) => call.usage_unmeasurable === false)).toBe(
      true,
    );
  });
});

// ── 申告 0 件と、記録の口の呼び出し（Issue #459）────────────────────

describe("申告 0 件は no-claims の状態にする（Issue #459）", () => {
  it("空の配列でも、成功とも申告無しとも読ませない", async () => {
    const text = JSON.stringify({ schema_version: CLAIMS_SET_SCHEMA, doc_version: "v1", doc_hash: DOC_HASH, claims: [] });
    const harness = await run(BASE_ARGS, { files: { "claims.json": text } });
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    expect(harness.output["no_claims"]).toBe(true);
    expect(harness.output["claims"]).toEqual([]);
  });
});
