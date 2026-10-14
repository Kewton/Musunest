// 流し直す入口（cli-claims.ts）の unit テスト（Issue #459）。
//
// **偽物の判定・時計・ファイル・環境値で閉じ、通信を拒否する。実 API は呼ばない。**
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@musunest/spec-engine";
import type { Judge, JudgeAnswer, JudgeRequest } from "./judge.js";
import { createJevJudge, type JevFetch } from "./judge-jev.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { SAMPLE_DOCUMENTS } from "./stages/__tests__/prompt.js";
import {
  CLAIMS_DIAGNOSTIC_SCHEMA,
  CLAIMS_SET_SCHEMA,
  JUDGE_CLAIMS_EXIT_OK,
  JUDGE_CLAIMS_EXIT_STOPPED,
  JUDGE_CLAIMS_EXIT_USAGE,
  convertDiagnostic,
  nodeJudgeClaimsDeps,
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

/** 問いの名前ごとに妥当な答えを返す偽物（主）。応答の `answeredBy`・`inputTokens`・名乗りを差し替えられる */
function answering(
  overrides: { readonly answeredBy?: "jev" | "llm" | "fake"; readonly inputTokens?: number; readonly source?: "jev" | "llm" | "fake" } = {},
): Judge {
  return {
    // 名乗り（`source`）は任意。渡すと、包みの実試行の内訳がその adapter に入る（Issue #473）
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
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
    // 注入した口の名乗りを、観測の包みへ引き継ぐ（Issue #473）
    ...(judge.source === undefined ? {} : { source: judge.source }),
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

describe("実入口には client と判定の生成関数がそろう（Issue #459・F2）", () => {
  it("nodeJudgeClaimsDeps が、注入なしの既定の生成関数を組む", async () => {
    const deps = await nodeJudgeClaimsDeps({
      argv: ["node", "cli-claims.js"],
      env: {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(typeof deps.makeClient).toBe("function");
    expect(typeof deps.makeJevJudge).toBe("function");
    expect(typeof deps.makeLlmJudge).toBe("function");
    expect(typeof deps.loadDocuments).toBe("function");
    expect(typeof deps.readFile).toBe("function");
    expect(typeof deps.writeFile).toBe("function");
  });
});

// ── 別 run の同じ要件 ID（Issue #459・F5）────────────────────────────

describe("別 run の同じ要件 ID でも、その申告自身の要件の文で再点検する（Issue #459・F5）", () => {
  it("run A と run B がどちらも R-1 を持っても、それぞれ自分の文が使われる", async () => {
    const text = JSON.stringify({
      schema_version: CLAIMS_SET_SCHEMA,
      doc_version: "v1",
      doc_hash: DOC_HASH,
      claims: [
        { id: "a", run_id: "run-A", index: 0, requirement_id: "R-1", requirement_text: "A の要件の文", part: "a", reason: "r", constraint_ids: ["記録"], alternative: null },
        { id: "b", run_id: "run-B", index: 0, requirement_id: "R-1", requirement_text: "B の要件の文", part: "b", reason: "r", constraint_ids: ["記録"], alternative: null },
      ],
    });
    const harness = await run(BASE_ARGS, { files: { "claims.json": text } });
    const requirements = harness.requests
      .map((request) => {
        const name = Object.keys(request.questions).find((key) => key.startsWith("plan-recheck-kind"));
        const question = name === undefined ? undefined : request.questions[name];
        const instructions = question?.instructions;
        return typeof instructions === "object" ? (instructions as { requirement?: string }).requirement : undefined;
      })
      .filter((value): value is string => typeof value === "string");
    expect(requirements).toContain("A の要件の文");
    expect(requirements).toContain("B の要件の文");
  });
});

describe("同じ run でも、同じ要件 ID に異なる文があれば束を分ける（Issue #459・N1）", () => {
  it("run が同じで R-1 の文が食い違っても、各自の文で再点検する", async () => {
    const text = JSON.stringify({
      schema_version: CLAIMS_SET_SCHEMA,
      doc_version: "v1",
      doc_hash: DOC_HASH,
      claims: [
        { id: "a", run_id: "run-1", index: 0, requirement_id: "R-1", requirement_text: "版 A の文", part: "a", reason: "r", constraint_ids: ["記録"], alternative: null },
        { id: "b", run_id: "run-1", index: 1, requirement_id: "R-1", requirement_text: "版 B の文", part: "b", reason: "r", constraint_ids: ["記録"], alternative: null },
      ],
    });
    const harness = await run(BASE_ARGS, { files: { "claims.json": text } });
    const requirements = harness.requests
      .map((request) => {
        const name = Object.keys(request.questions).find((key) => key.startsWith("plan-recheck-kind"));
        const question = name === undefined ? undefined : request.questions[name];
        const instructions = question?.instructions;
        return typeof instructions === "object" ? (instructions as { requirement?: string }).requirement : undefined;
      })
      .filter((value): value is string => typeof value === "string");
    expect(requirements).toContain("版 A の文");
    expect(requirements).toContain("版 B の文");
  });
});

// ── 再点検なしの実回付（Issue #459・N3 の残り）──────────────────────

describe("再点検なしの実回付を空にし、あり側は実開始で数える（Issue #459・N3 の残り）", () => {
  it("裏付けが not-stated の 1 申告で、再点検なしは 0/1、ありは 1/1", async () => {
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
    const score = harness.output["score"] as {
      readonly rates: readonly { readonly path: string; readonly stratum: string; readonly name: string; readonly numerator: number; readonly denominator: number }[];
    };
    const rate = (path: string) =>
      score.rates.find((entry) => entry.path === path && entry.stratum === "all" && entry.name === "再点検への回付率");
    // Luna を呼ばない「再点検なし」は、実回付が空
    expect(rate("baseline:no-recheck")).toMatchObject({ numerator: 0, denominator: 1 });
    // 「再点検あり」は、要求して実際に開始したので 1
    expect(rate("baseline:recheck")).toMatchObject({ numerator: 1, denominator: 1 });
  });
});

// ── 別 run の同じ要件 ID・同じ文（Issue #459・N6）──────────────────

describe("別 run でも同じ要件 ID・同じ文なら、束は run をまたがない（Issue #459・N6）", () => {
  it("run-A の a と run-B の b は別の束になり、記録の run と申告 ID が一致する", async () => {
    const text = JSON.stringify({
      schema_version: CLAIMS_SET_SCHEMA,
      doc_version: "v1",
      doc_hash: DOC_HASH,
      claims: [
        { id: "a", run_id: "run-A", index: 0, requirement_id: "R-1", requirement_text: "同じ文", part: "a", reason: "r", constraint_ids: ["記録"], alternative: null },
        { id: "b", run_id: "run-B", index: 0, requirement_id: "R-1", requirement_text: "同じ文", part: "b", reason: "r", constraint_ids: ["記録"], alternative: null },
      ],
    });
    const harness = await run(BASE_ARGS, { files: { "claims.json": text } });
    const primary = (harness.output["baseline_calls"] as readonly { readonly role: string; readonly run_id: string; readonly claim_ids: readonly string[] }[]).filter(
      (entry) => entry.role === "primary",
    );
    expect(primary.some((entry) => entry.run_id === "run-A" && entry.claim_ids.includes("a"))).toBe(true);
    expect(primary.some((entry) => entry.run_id === "run-B" && entry.claim_ids.includes("b"))).toBe(true);
    // run-A の呼び出しに、run-B の申告が混ざらない
    expect(primary.filter((entry) => entry.run_id === "run-A").every((entry) => !entry.claim_ids.includes("b"))).toBe(true);
  });
});

// ── 基準の遅い応答の使用量（Issue #459・F12/F13 の残り）──────────────

describe("基準の遅い応答（締切後）の使用量も、失敗の記録に残す（Issue #459・F12/F13 の残り）", () => {
  it("開始してから締切を越えた基準の呼び出しが、原値の入力トークンを残す", async () => {
    let clock = 0;
    const judge: Judge = {
      async judge(request) {
        clock = 10_000; // 呼び出しの間に締切を越える
        const out: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) out[name] = choice("vocabulary-hole");
        return { answers: out, inputTokens: 9, model: "fake-judge", answeredBy: "jev" };
      },
    };
    const harness = await run(BASE_ARGS, { now: () => clock, deadlineMs: 1000, judge });
    const baseline = harness.output["baseline_calls"] as readonly {
      readonly state: string;
      readonly input_tokens: number | null;
      readonly answered_by: string;
    }[];
    expect(baseline.some((entry) => entry.state === "failed" && entry.input_tokens === 9)).toBe(true);
  });
});

// ── 成功の次の応答なしの失敗（Issue #459・N7）───────────────────────

describe("成功の次の、応答なしの失敗に、前の呼出の応答を付けない（Issue #459・N7）", () => {
  it("基準：仕分けが成功した後の、応答なしの裏付けの失敗は、答えも使用量も null", async () => {
    const judge: Judge = {
      async judge(request) {
        const names = Object.keys(request.questions);
        if (names.some((name) => name.startsWith("plan-support"))) throw new Error("応答なしの失敗");
        const out: Record<string, JudgeAnswer> = {};
        for (const name of names) out[name] = choice("vocabulary-hole");
        return { answers: out, inputTokens: 9, model: "fake-judge", answeredBy: "jev" };
      },
    };
    const harness = await run(BASE_ARGS, { judge });
    const primary = (harness.output["baseline_calls"] as readonly {
      readonly role: string;
      readonly state: string;
      readonly answered_by: string;
      readonly input_tokens: number | null;
      readonly answers: unknown;
    }[]).filter((entry) => entry.role === "primary");
    expect(primary.find((entry) => entry.state === "ok")?.input_tokens).toBe(9);
    const failed = primary.find((entry) => entry.state === "failed");
    // 前の呼出（仕分け）の応答を、応答なしの失敗に付けない
    expect(failed?.input_tokens).toBeNull();
    expect(failed?.answers).toBeNull();
    expect(failed?.answered_by).toBe("none");
  });

  it("形：1 つ目の成功の後、2 つ目の応答なしの失敗は、答えも使用量も null", async () => {
    let claimCalls = 0;
    const judge: Judge = {
      async judge(request) {
        const names = Object.keys(request.questions);
        if (names.some((name) => name.startsWith("claim-"))) {
          claimCalls += 1;
          if (claimCalls === 2) throw new Error("応答なしの失敗");
        }
        const out: Record<string, JudgeAnswer> = {};
        for (const name of names) out[name] = choice("vocabulary-hole");
        return { answers: out, inputTokens: 9, model: "fake-judge", answeredBy: "jev" };
      },
    };
    const harness = await run([...BASE_ARGS, "--forms", "T1,S1"], { judge });
    const calls = harness.output["calls"] as readonly {
      readonly id: string;
      readonly state: string;
      readonly input_tokens: number | null;
      readonly answers: unknown;
    }[];
    const t1 = calls.find((call) => call.id === "T1");
    const s1 = calls.find((call) => call.id === "S1");
    expect(t1?.state).toBe("ok");
    expect(t1?.input_tokens).toBe(9);
    // 失敗は失敗のまま、前の呼出の答え・使用量を付けない
    expect(s1?.state).toBe("failed");
    expect(s1?.input_tokens).toBeNull();
    expect(s1?.answers).toBeNull();
  });
});

// ── 基準の記録に原値と対応を残す（Issue #459・N5）──────────────────

describe("基準の記録に、原値の入力トークン・印・run と申告 ID の対応を残す（Issue #459・N5）", () => {
  it("Jev の正の入力トークンは原値で残り、0 のときは印が付く", async () => {
    const positive = await run(BASE_ARGS, { judge: answering({ answeredBy: "jev", inputTokens: 5 }) });
    const primary = (positive.output["baseline_calls"] as readonly {
      readonly role: string;
      readonly run_id: string;
      readonly claim_ids: readonly string[];
      readonly input_tokens: number | null;
      readonly usage_unmeasurable: boolean;
    }[]).filter((entry) => entry.role === "primary");
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.some((entry) => entry.input_tokens === 5 && entry.usage_unmeasurable === false)).toBe(true);
    expect(primary.every((entry) => entry.run_id === "run-1")).toBe(true);
    expect(primary.some((entry) => entry.claim_ids.includes("c1"))).toBe(true);

    const zero = await run(BASE_ARGS, { judge: answering({ answeredBy: "jev", inputTokens: 0 }) });
    const zeroPrimary = (zero.output["baseline_calls"] as readonly { readonly role: string; readonly usage_unmeasurable: boolean }[]).filter(
      (entry) => entry.role === "primary",
    );
    expect(zeroPrimary.every((entry) => entry.usage_unmeasurable)).toBe(true);
  });
});

// ── 基準の要約は元の申告 ID で結ぶ（Issue #459・F6）──────────────────

describe("基準の要約は、配列の位置ではなく元の申告 ID で分類を結ぶ（Issue #459・F6）", () => {
  it("with_recheck の要約が claim_id と分類の対応になる", async () => {
    const harness = await run(BASE_ARGS);
    const baselines = harness.output["baselines"] as {
      readonly with_recheck: { readonly claims: readonly { readonly claim_id: string; readonly classification: string }[] };
    };
    const map = new Map(baselines.with_recheck.claims.map((entry) => [entry.claim_id, entry.classification]));
    // 文脈不足の c2 は含めず、c1 だけを ID で結ぶ
    expect([...map.keys()]).toEqual(["c1"]);
    expect(map.get("c1")).toBe("unchecked");
  });
});

// ── 基準の経路が門で止まっても比べられる（Issue #459・F7）──────────

describe("基準の経路が門で止まっても、要約を残して比べられる（Issue #459・F7）", () => {
  it("上限で止まっても、再点検あり／なしの要約がそろって一致する", async () => {
    const harness = await run([...BASE_ARGS, "--max-calls", "1"]);
    const baselines = harness.output["baselines"] as {
      readonly with_recheck: { readonly claims: readonly unknown[] };
      readonly without_recheck: { readonly claims: readonly unknown[] };
    };
    expect(baselines.with_recheck.claims.length).toBeGreaterThan(0);
    expect(baselines.without_recheck.claims.length).toBeGreaterThan(0);
    expect(baselines.without_recheck).toEqual(baselines.with_recheck);
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

// ── 生の答えと実試行の内訳（Issue #459・F12）────────────────────────

describe("生の答えと実試行の内訳が出力に残る（Issue #459・F12）", () => {
  it("呼び出しの生の答え・基準の呼び出し・実試行の数が出力にある", async () => {
    const harness = await run(BASE_ARGS);
    const calls = harness.output["calls"] as readonly { readonly answers: unknown }[];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => typeof call.answers === "object" && call.answers !== null)).toBe(true);
    const baseline = harness.output["baseline_calls"] as readonly { readonly answers: unknown; readonly role: string }[];
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.some((entry) => entry.role === "primary")).toBe(true);
    const cost = harness.output["cost"] as { readonly attempts: number };
    expect(cost.attempts).toBeGreaterThan(0);
  });
});

// ── 実施後の締切停止（Issue #459・F13）──────────────────────────────

describe("実施後の締切停止は、未実施に数えない（Issue #459・F13）", () => {
  it("判定を呼んだ後に締切を越えたら failed として実施数に数える", async () => {
    let clock = 0;
    const judge: Judge = {
      async judge(request) {
        // 形の呼び出し（claim-*）でだけ締切を越えさせる（基準の経路は通す）
        if (Object.keys(request.questions).some((name) => name.startsWith("claim-"))) clock = 10_000;
        const out: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) out[name] = choice("vocabulary-hole");
        return { answers: out, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    const harness = await run([...BASE_ARGS, "--forms", "T1"], { now: () => clock, deadlineMs: 1000, judge });
    const calls = harness.output["calls"] as readonly { readonly state: string }[];
    // 呼んだ後の締切超過は failed（未実施にしない）
    expect(calls.some((call) => call.state === "failed")).toBe(true);
    expect(harness.output["executed"] as number).toBeGreaterThan(0);
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

// ── 実試行の内訳（Issue #473）───────────────────────────────────────

/** 費用の欄（`cost`）の形（Issue #473 で `attempts_by_adapter` を足した） */
interface CostOutput {
  readonly calls_by_adapter: Readonly<Record<string, number>>;
  readonly attempts: number;
  readonly attempts_by_adapter: Readonly<Record<string, number>>;
}

describe("出力の attempts_by_adapter が、名乗りのある偽物の実開始の記録と一致する（Issue #473）", () => {
  it("主の失敗→切り替え・再点検ありの組で、内訳が偽物の口と偽物の fetch の実開始と一致する", async () => {
    // 主（Jev）は偽物の fetch で 429 を返して失敗し、切り替え先・再点検先（Luna）は名乗りのある偽物の口が答える
    let jevStarts = 0;
    const jevFetch: JevFetch = async () => {
      jevStarts += 1;
      return new Response(JSON.stringify({ error: "busy" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    };
    const luna = answering({ source: "llm", answeredBy: "llm" });
    let lunaStarts = 0;
    const countingLuna: Judge = {
      source: "llm",
      async judge(request) {
        lunaStarts += 1;
        return luna.judge(request);
      },
    };

    const harness = await run([...BASE_ARGS, "--judge", "fallback"], {
      env: { JEV_API_KEY: "jev-FAKE" },
      // 主は偽物の fetch の Jev（再送なし＝1 呼び出しにつき fetch 1 回）
      makeJevJudge: () => createJevJudge({ apiKey: "k", fetch: jevFetch, maxAttempts: 1 }),
      judge: countingLuna,
    });

    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    const cost = harness.output["cost"] as CostOutput;
    // 内訳が、偽物の fetch（主）と偽物の口（Luna）の実開始の記録と一致する
    expect(cost.attempts_by_adapter["jev"]).toBe(jevStarts);
    expect(cost.attempts_by_adapter["llm"]).toBe(lunaStarts);
    expect(cost.attempts_by_adapter["fake"]).toBe(0);
    expect(cost.attempts_by_adapter["unknown"]).toBe(0);
    // 実試行の合計（今の欄）は、実開始の合計と一致する。**記録からの再生は追加 0**（再生は包みを通らない）
    expect(cost.attempts).toBe(jevStarts + lunaStarts);
    // 成功して返った応答の数（今の欄）は、答えた adapter（Luna）だけ
    expect(cost.calls_by_adapter).toEqual({ jev: 0, llm: lunaStarts, fake: 0 });
  });

  it("名乗りの無い口を注入すると、その実試行は unknown に入る", async () => {
    const harness = await run(BASE_ARGS, { judge: answering({ answeredBy: "fake" }) }); // 名乗り無し
    expect(harness.code).toBe(JUDGE_CLAIMS_EXIT_OK);
    const cost = harness.output["cost"] as CostOutput;
    expect(cost.attempts_by_adapter["unknown"]).toBeGreaterThan(0);
    expect(cost.attempts_by_adapter["jev"]).toBe(0);
    expect(cost.attempts_by_adapter["llm"]).toBe(0);
    expect(cost.attempts_by_adapter["fake"]).toBe(0);
  });
});
