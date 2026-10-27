// 共通の上限値（02 §1.5・§2.2）の unit テスト。
//
// ここで固定したいのは 3 つ。
//   1. 依頼文は 4,000 文字ちょうどは通り、4,001 文字は断る（境目）
//   2. 宣言の大きさ・試験の数・参照データの行数も、ちょうどは通り、超過は断る（境目）
//   3. どの上限にも、どの段が確かめるかの番人が書かれている（書き漏らしを `satisfies` と対で見る）
import { describe, expect, it } from "vitest";
import {
  AGENT_LIMITS,
  CALL_TIMEOUT_BY_EFFORT,
  LIMIT_GUARDS,
  OUTPUT_STAGES,
  PLAN_CHOICES_MIN,
  STAGE_EFFORT_STAGES,
  STAGE_MAX_OUTPUT_TOKENS,
  callTimeoutMsForEffort,
  checkDeclarationBytes,
  checkLimit,
  checkPlanQuestions,
  checkPlanRoundTrips,
  checkRequestText,
  effectiveCallTimeoutMs,
  isReasoningEffort,
  isStageEffortStage,
  maxOutputTokensForEffort,
  type LimitName,
} from "./limits.js";

describe("共通の上限（02 §1.5・§2.2）", () => {
  it("依頼文は 4,000 文字ちょうどは通り、4,001 文字は断る", () => {
    expect(checkRequestText("x".repeat(4_000))).toBeUndefined();
    expect(checkRequestText("x".repeat(4_001))).toEqual({
      limit: "requestTextChars",
      max: 4_000,
      actual: 4_001,
    });
  });

  it("宣言の大きさはちょうどは通り、1 バイト超過は断る", () => {
    expect(checkDeclarationBytes(AGENT_LIMITS.declarationBytes)).toBeUndefined();
    expect(checkDeclarationBytes(AGENT_LIMITS.declarationBytes + 1)).toEqual({
      limit: "declarationBytes",
      max: AGENT_LIMITS.declarationBytes,
      actual: AGENT_LIMITS.declarationBytes + 1,
    });
  });

  it("試験の数はちょうどは通り、超過は断る", () => {
    expect(checkLimit("testsPerRequirement", AGENT_LIMITS.testsPerRequirement)).toBeUndefined();
    expect(checkLimit("testsPerRequirement", AGENT_LIMITS.testsPerRequirement + 1)).toEqual({
      limit: "testsPerRequirement",
      max: AGENT_LIMITS.testsPerRequirement,
      actual: AGENT_LIMITS.testsPerRequirement + 1,
    });
  });

  it("参照データの行数はちょうどは通り、超過は断る", () => {
    expect(checkLimit("referenceRowsPerTest", AGENT_LIMITS.referenceRowsPerTest)).toBeUndefined();
    expect(checkLimit("referenceRowsPerTest", AGENT_LIMITS.referenceRowsPerTest + 1)?.limit).toBe(
      "referenceRowsPerTest",
    );
  });

  it("⑥ の 1 回の直す段の応答の往復は 8 ちょうどは通り、9 は断る（§1.5・Issue #429）", () => {
    expect(AGENT_LIMITS.repairStepTurns).toBe(8);
    expect(checkLimit("repairStepTurns", AGENT_LIMITS.repairStepTurns)).toBeUndefined();
    expect(checkLimit("repairStepTurns", AGENT_LIMITS.repairStepTurns + 1)).toEqual({
      limit: "repairStepTurns",
      max: AGENT_LIMITS.repairStepTurns,
      actual: AGENT_LIMITS.repairStepTurns + 1,
    });
  });

  it("道具の呼び出しの累計は、ジョブ全体の上限（toolCalls）に照らす（§1.5・Issue #429）", () => {
    expect(checkLimit("toolCalls", AGENT_LIMITS.toolCalls)).toBeUndefined();
    expect(checkLimit("toolCalls", AGENT_LIMITS.toolCalls + 1)).toEqual({
      limit: "toolCalls",
      max: AGENT_LIMITS.toolCalls,
      actual: AGENT_LIMITS.toolCalls + 1,
    });
  });

  it("③ のやり直し・⑤a の作り直し・停滞の回数の上限も、ちょうどは通り、超過は断る（02 §1.5・#309）", () => {
    for (const name of ["correspondenceRedos", "correspondenceChecks", "stagnationRepeats"] as const) {
      expect(checkLimit(name, AGENT_LIMITS[name]), name).toBeUndefined();
      expect(checkLimit(name, AGENT_LIMITS[name] + 1)?.limit, name).toBe(name);
    }
  });

  it("Plan の質問は 10 問ちょうどは通り、11 問は断る（04 §6 の 2）", () => {
    expect(checkPlanQuestions(AGENT_LIMITS.planQuestions)).toBeUndefined();
    expect(checkPlanQuestions(AGENT_LIMITS.planQuestions + 1)).toEqual({
      limit: "planQuestions",
      max: AGENT_LIMITS.planQuestions,
      actual: AGENT_LIMITS.planQuestions + 1,
    });
  });

  it("Plan の往復は 3 回ちょうどは通り、4 回は断る（04 §6 の 2）", () => {
    expect(checkPlanRoundTrips(AGENT_LIMITS.planRoundTrips)).toBeUndefined();
    expect(checkPlanRoundTrips(AGENT_LIMITS.planRoundTrips + 1)?.limit).toBe("planRoundTrips");
  });

  it("選択肢の数は 2〜4 で、上限は AGENT_LIMITS・下限は PLAN_CHOICES_MIN に置く（04 §6 の 3）", () => {
    expect(PLAN_CHOICES_MIN).toBe(2);
    expect(AGENT_LIMITS.planChoices).toBe(4);
    expect(PLAN_CHOICES_MIN).toBeLessThan(AGENT_LIMITS.planChoices);
  });

  it("すべての上限に、どの段が確かめるかの番人が書かれている", () => {
    const names = Object.keys(AGENT_LIMITS) as readonly LimitName[];
    for (const name of names) {
      expect(LIMIT_GUARDS[name]).toBeTypeOf("string");
      expect(LIMIT_GUARDS[name].length).toBeGreaterThan(0);
    }
  });

  it("数えられる値でないものは断る（呼ぶ側の数え方の誤り）", () => {
    expect(() => checkLimit("callCount", -1)).toThrow();
    expect(() => checkLimit("callCount", 1.5)).toThrow();
    expect(() => checkLimit("callCount", Number.NaN)).toThrow();
  });
});

// ── 段の出力の上限（effort ごと。§1.5・§2）──────────────────────

/** v1.1α の段の出力の上限（07-architecture-v1.1a.md §3。Issue #505。3 つの effort で同じ） */
const V11A_STAGE_TABLE = {
  "name-table": 32_768,
  "semantic-check": 16_384,
  "test-spec": 32_768,
  "decl-check": 16_384,
} as const;

describe("段の出力の上限は effort ごとに、共通の置き場所が持つ（02 §1.5・§2）", () => {
  it("effort high の上限は、medium 以上である（段ごとに）", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("high", stage), stage).toBeGreaterThanOrEqual(
        maxOutputTokensForEffort("medium", stage),
      );
      expect(maxOutputTokensForEffort("low", stage), stage).toBeLessThanOrEqual(
        maxOutputTokensForEffort("medium", stage),
      );
    }
  });

  it("上限は、共通の置き場所（STAGE_MAX_OUTPUT_TOKENS）から取る", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("low", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.low[stage]);
      expect(maxOutputTokensForEffort("medium", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.medium[stage]);
      expect(maxOutputTokensForEffort("high", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.high[stage]);
    }
  });

  it("値は次の表のとおりで、3 つの effort で同じである（Issue #399）", () => {
    // 2026-10-11 の計測で打ち切りが出た段に余白を取り、Plan の段（surface・questions）を自分の名前で
    // 足した。値は暫定で、3 つの effort は同じである。
    const table: Record<(typeof OUTPUT_STAGES)[number], number> = {
      ...V11A_STAGE_TABLE,
      requirements: 16_384,
      "reverse-check": 8_192,
      design: 32_768,
      surface: 32_768,
      questions: 32_768,
      "test-suite": 32_768,
      write: 32_768,
      correspondence: 16_384,
      repair: 32_768,
      arbitration: 16_384,
    };
    // 表は、段の一覧（OUTPUT_STAGES）を漏れなく覆う（足し忘れは型で見つかる）
    expect(Object.keys(table).sort()).toEqual([...OUTPUT_STAGES].sort());
    for (const effort of ["low", "medium", "high"] as const) {
      for (const stage of OUTPUT_STAGES) {
        expect(maxOutputTokensForEffort(effort, stage), `${effort}/${stage}`).toBe(table[stage]);
      }
    }
  });

  it("medium の上限は high と同じである（Issue #332。受入の試験で medium が途中で切れた）", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("medium", stage), stage).toBe(maxOutputTokensForEffort("high", stage));
    }
  });

  it("low の上限は、medium（= high）と同じである（Issue #399。low の設計の余白が足りなかった）", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("low", stage), stage).toBe(maxOutputTokensForEffort("medium", stage));
    }
  });

  it("知らない effort は、既定（high）へ倒す（段を止めない）", () => {
    expect(isReasoningEffort("nope")).toBe(false);
    expect(isReasoningEffort("high")).toBe(true);
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("nope", stage)).toBe(maxOutputTokensForEffort("high", stage));
    }
  });
});

// ── 呼び出しごとの timeout（effort ごと。§1.5・#302）──────────────────

describe("呼び出しごとの timeout は、effort ごとに持つ（02 §1.5・#302）", () => {
  it("effort high の timeout は、medium 以上である", () => {
    expect(callTimeoutMsForEffort("high")).toBeGreaterThanOrEqual(callTimeoutMsForEffort("medium"));
    expect(callTimeoutMsForEffort("medium")).toBeGreaterThanOrEqual(callTimeoutMsForEffort("low"));
  });

  it("基準の値は共通の置き場所（CALL_TIMEOUT_BY_EFFORT）から取り、固定の 60 秒ではない", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(callTimeoutMsForEffort(effort)).toBe(CALL_TIMEOUT_BY_EFFORT[effort]);
    }
    // high は、疎通の確認で足りなかった 60 秒より十分に長い
    expect(callTimeoutMsForEffort("high")).toBeGreaterThan(60_000);
  });

  it("知らない effort は、既定（high）へ倒す（段を止めない）", () => {
    expect(callTimeoutMsForEffort("nope")).toBe(callTimeoutMsForEffort("high"));
    expect(callTimeoutMsForEffort("")).toBe(callTimeoutMsForEffort("high"));
  });

  it("実際に使う timeout は、ジョブの締切の残りを超えない", () => {
    // 残りが基準より短ければ、残りに切り詰める
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 1_000 })).toBe(1_000);
    // 残りが基準より長ければ、基準のまま
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 10_000_000 })).toBe(
      callTimeoutMsForEffort("high"),
    );
    // 残りが尽きていれば 0（呼ばない）
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 0 })).toBe(0);
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: -1 })).toBe(0);
  });

  it("呼ぶ側の指定（手元の入口の --timeout）は、effort の基準より優先し、締切の残りを超えない", () => {
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 10_000_000, timeoutMs: 1_200 })).toBe(1_200);
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 800, timeoutMs: 1_200 })).toBe(800);
  });
});

// ── v1.1α の上限と段（07-architecture-v1.1a.md §1・§3・D16。Issue #505）──────────────

describe("v1.1α の上限と段は、v1 の値を変えずに足す（07 §3・D16・Issue #505）", () => {
  it("declChecks は 6 で、番人がある（v1 の correspondenceChecks と同じ数）", () => {
    expect(AGENT_LIMITS.declChecks).toBe(6);
    expect(AGENT_LIMITS.declChecks).toBe(AGENT_LIMITS.correspondenceChecks);
    expect(LIMIT_GUARDS.declChecks).toBeTypeOf("string");
    expect(LIMIT_GUARDS.declChecks.length).toBeGreaterThan(0);
    expect(checkLimit("declChecks", 6)).toBeUndefined();
    expect(checkLimit("declChecks", 7)?.limit).toBe("declChecks");
  });

  it("LIMIT_GUARDS は AGENT_LIMITS の全部の上限を覆い、上限に無い名前を持たない", () => {
    expect(Object.keys(LIMIT_GUARDS).sort()).toEqual(Object.keys(AGENT_LIMITS).sort());
  });

  it("v1 の上限の値は変わらない（呼び出し 24 回・直し 6 往復・⑤a の点検 6 回 ほか）", () => {
    expect(AGENT_LIMITS).toMatchObject({
      requestTextChars: 4_000,
      declarationBytes: 65_536,
      testsPerRequirement: 16,
      referenceRowsPerTest: 64,
      recordRows: 256,
      callCount: 24,
      toolCalls: 24,
      repairRoundTrips: 6,
      repairStepTurns: 8,
      correspondenceRedos: 2,
      correspondenceChecks: 6,
      stagnationRepeats: 2,
      planQuestions: 10,
      planRoundTrips: 3,
      planChoices: 4,
      planFreeTextChars: 500,
    });
  });

  it("新しい 4 段は OUTPUT_STAGES の末尾にあり、既存の段の並びは変わらない", () => {
    expect(OUTPUT_STAGES.slice(0, 10)).toEqual([
      "surface",
      "questions",
      "requirements",
      "reverse-check",
      "design",
      "test-suite",
      "write",
      "correspondence",
      "repair",
      "arbitration",
    ]);
    expect(OUTPUT_STAGES.slice(10)).toEqual(["name-table", "semantic-check", "test-spec", "decl-check"]);
  });

  it("新しい 4 段の上限は 3 つの effort で同じで、name-table・test-spec は 32,768、semantic-check・decl-check は 16,384", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      for (const [stage, value] of Object.entries(V11A_STAGE_TABLE)) {
        expect(STAGE_MAX_OUTPUT_TOKENS[effort][stage as keyof typeof V11A_STAGE_TABLE], `${effort}/${stage}`).toBe(value);
      }
    }
  });
});

describe("段ごとの effort を指定できる段（Issue #664）", () => {
  it("配線する段の集合は C1・C2・C3・T2・B1・B3' に repair を足した 7 つ（Issue #751）で、ほかの段（name-table・arbitration など）は入らない。上限・timeout の表の値は変えない", () => {
    expect(STAGE_EFFORT_STAGES).toEqual(["vocabulary", "mapping", "semantic-check", "test-spec", "write", "decl-check", "repair"]);
    for (const stage of STAGE_EFFORT_STAGES) expect(isStageEffortStage(stage)).toBe(true);
    for (const stage of ["name-table", "arbitration", "requirements", "C3", "", "judge"]) expect(isStageEffortStage(stage)).toBe(false);
    expect(CALL_TIMEOUT_BY_EFFORT).toEqual({ low: 60_000, medium: 120_000, high: 300_000 });
    expect(AGENT_LIMITS.testsPerRequirement).toBe(16);
  });
});
