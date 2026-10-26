// 探索型の直しの部品（v12/search-repair.ts）の試験（08-architecture-v1.2.md §3 の 1 (c)・§4・§4.1。Issue #551）。
//
// 純粋な関数と定数だけを照らす。LLM・判定・時計を使わない。
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import { ruleDefinitionDefects } from "../stages/prompt.js";
import {
  NAMED_FAILURE_KINDS,
  NAMED_FAILURE_MESSAGES,
  SEARCH_REPAIR_BUDGET,
  SEARCH_REPAIR_BUDGET_DEFINITIONS,
  SEARCH_REPAIR_RULE_DEFINITIONS,
  VIOLATION_KINDS,
  VIOLATION_WEIGHTS,
  countViolations,
  failureSetSha256,
  isStrictlyBetter,
  namedFailuresOf,
  notAdoptedAfter,
  stagnationAction,
  withSearchRounds,
  type VersionFacts,
} from "./search-repair.js";

/** 静的チェック・B3'・B4 を通った版の事実（件数は上書きする） */
const facts = (overrides: Partial<VersionFacts> = {}): VersionFacts => ({
  declarationSha256: "a".repeat(64),
  staticCheckPassed: true,
  correspondenceMisses: 0,
  decl: { ran: true, rejections: 0, unmarked: 0 },
  testMismatches: 0,
  testUnresolved: 0,
  ...overrides,
});

/** 不一致 n 件の版 */
const mismatches = (n: number) => countViolations(facts({ testMismatches: n, declarationSha256: String(n).repeat(64).slice(0, 64) }));

describe("規則・重み・予算の定義", () => {
  it("規則と重みと予算の定義に why・since があり、ruleDefinitionDefects で不備 0。重みは種類ごとに 1 つ・初期値はすべて 1", () => {
    expect(ruleDefinitionDefects(SEARCH_REPAIR_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects(VIOLATION_WEIGHTS)).toEqual([]);
    expect(ruleDefinitionDefects(SEARCH_REPAIR_BUDGET_DEFINITIONS)).toEqual([]);
    expect(VIOLATION_WEIGHTS.map((entry) => entry.kind)).toEqual([...VIOLATION_KINDS]);
    expect(VIOLATION_WEIGHTS.every((entry) => entry.weight === 1)).toBe(true);
    for (const definition of [...SEARCH_REPAIR_RULE_DEFINITIONS, ...VIOLATION_WEIGHTS, ...SEARCH_REPAIR_BUDGET_DEFINITIONS]) {
      expect(definition.why.trim(), definition.id).not.toBe("");
      expect(definition.since.trim(), definition.id).not.toBe("");
    }
  });

  it("(4) 予算の行は往復 6・作り直し 1（形のやり直し 1 を含む）・停滞 2 で、v1 の上限の表は直す前と同じ（足していない）", () => {
    expect(SEARCH_REPAIR_BUDGET).toEqual({ repairRoundTrips: 6, stagnationRepeats: 2, rewrites: 1, rewriteShapeRetries: 1 });
    expect(SEARCH_REPAIR_BUDGET.repairRoundTrips).toBe(AGENT_LIMITS.repairRoundTrips);
    expect(SEARCH_REPAIR_BUDGET.stagnationRepeats).toBe(AGENT_LIMITS.stagnationRepeats);
    // 直す前（base 2d1ccbd）の `AGENT_LIMITS` の全部の欄と値
    expect(AGENT_LIMITS).toEqual({
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
      declChecks: 6,
      stagnationRepeats: 2,
      planQuestions: 10,
      planRoundTrips: 3,
      planChoices: 4,
      planFreeTextChars: 500,
    });
    for (const name of Object.keys(SEARCH_REPAIR_BUDGET)) {
      if (name === "repairRoundTrips" || name === "stagnationRepeats") continue;
      expect(Object.keys(AGENT_LIMITS)).not.toContain(name);
    }
  });
});

describe("(1) 違反の数：重みつきの和・静的に落ちた版は最悪・B3' を流していない版は fail-closed", () => {
  it("和は B3 の落ち・B3' の拒否・unmarked・B4 の不一致・未解決の重みつきの和で、内訳は種類ごと", () => {
    const counted = countViolations(
      facts({ correspondenceMisses: 1, decl: { ran: true, rejections: 2, unmarked: 3 }, testMismatches: 4, testUnresolved: 5 }),
    );
    expect(counted).toEqual({
      kind: "counted",
      declarationSha256: "a".repeat(64),
      breakdown: { "correspondence-miss": 1, "decl-rejection": 2, "decl-unmarked": 3, "test-mismatch": 4, "test-unresolved": 5 },
      knownTotal: 15,
      unknown: null,
    });
  });

  it("静的チェックに落ちた版は、通った版のどれ（違反の多い版・B3' を流していない版を含む）よりも悪い", () => {
    const failed = countViolations(facts({ staticCheckPassed: false, decl: { ran: false, reason: "static-check" } }));
    expect(failed.kind).toBe("static-check-failed");
    const passedVersions = [
      mismatches(0),
      mismatches(50),
      countViolations(facts({ correspondenceMisses: 9, decl: { ran: false, reason: "name-check" }, testMismatches: 9 })),
      countViolations(facts({ decl: { ran: false, reason: "exhausted" } })),
    ];
    for (const passed of passedVersions) {
      expect(isStrictlyBetter(passed, failed)).toBe(true);
      expect(isStrictlyBetter(failed, passed)).toBe(false);
    }
    expect(isStrictlyBetter(failed, failed)).toBe(false);
  });

  it("B3' を流していない版（点検が尽きた・B3 に落ちた）は理由と宣言の SHA-256 を持ち、拒否を不明（null）として、拒否 0 の版より良いと判定されない", () => {
    const sha = "b".repeat(64);
    const zero = mismatches(0);
    const heavy = mismatches(30);
    for (const reason of ["exhausted", "name-check"] as const) {
      const unknown = countViolations(facts({ declarationSha256: sha, decl: { ran: false, reason } }));
      if (unknown.kind !== "counted") throw new Error("前提が壊れた");
      expect(unknown.unknown).toEqual({ reason, declarationSha256: sha });
      expect(unknown.breakdown["decl-rejection"]).toBeNull();
      expect(unknown.breakdown["decl-unmarked"]).toBeNull();
      // 不明を 0 としない：分かっている数が 0 でも、拒否 0 の版・違反の多い版より良いとは見なさない
      expect(unknown.knownTotal).toBe(0);
      expect(isStrictlyBetter(unknown, zero)).toBe(false);
      expect(isStrictlyBetter(unknown, heavy)).toBe(false);
      expect(isStrictlyBetter(unknown, unknown)).toBe(false);
    }
  });
});

describe("(2) 採るかの判定：厳密に小さいときだけ採る", () => {
  it("一番良い版 3 件に対し 2 件は採る、3 件・4 件は採らない", () => {
    const best = mismatches(3);
    expect(isStrictlyBetter(mismatches(2), best)).toBe(true);
    expect(isStrictlyBetter(mismatches(3), best)).toBe(false);
    expect(isStrictlyBetter(mismatches(4), best)).toBe(false);
  });

  it("種類が違っても重みつきの和で比べる（不一致 3 の版に対し、B3 の落ち 1・拒否 1 の版は採る）", () => {
    const candidate = countViolations(facts({ correspondenceMisses: 1, decl: { ran: true, rejections: 1, unmarked: 0 } }));
    expect(isStrictlyBetter(candidate, mismatches(3))).toBe(true);
    expect(isStrictlyBetter(mismatches(3), candidate)).toBe(false);
  });

  it("一番良い版が B3' を流していない版でも、流した候補は分かっている数が厳密に小さいときだけ採る", () => {
    const best = countViolations(facts({ correspondenceMisses: 2, decl: { ran: false, reason: "name-check" } }));
    expect(isStrictlyBetter(mismatches(1), best)).toBe(true);
    expect(isStrictlyBetter(mismatches(2), best)).toBe(false);
  });
});

describe("(3) 停滞：採れない版 2 つで 1 回目（作り直し）、作り直しのあと 2 つで 2 回目（止める）。採れた版で 0 に戻る", () => {
  it("数え方と次の手", () => {
    let notAdopted = 0;
    let rewrites = 0;
    notAdopted = notAdoptedAfter(notAdopted, false);
    expect(stagnationAction(notAdopted, rewrites)).toBe("repair");
    notAdopted = notAdoptedAfter(notAdopted, false);
    expect(notAdopted).toBe(2);
    expect(stagnationAction(notAdopted, rewrites)).toBe("rewrite");
    // 作り直し（数は 0 に戻す）
    rewrites += 1;
    notAdopted = 0;
    notAdopted = notAdoptedAfter(notAdopted, false);
    expect(stagnationAction(notAdopted, rewrites)).toBe("repair");
    notAdopted = notAdoptedAfter(notAdopted, false);
    expect(stagnationAction(notAdopted, rewrites)).toBe("stop");
    // 採れた版で 0 に戻る
    expect(notAdoptedAfter(1, true)).toBe(0);
    expect(notAdoptedAfter(5, true)).toBe(0);
    expect(stagnationAction(notAdoptedAfter(1, true), 0)).toBe("repair");
    expect(stagnationAction(1, 0)).toBe("repair");
  });
});

describe("作り直しに渡す名前付きの失敗の一覧", () => {
  it("試験 ID・要件 ID・種類と種類ごとの固定文だけで、重なりを除き種類の順。静的に落ちた版は 1 件", () => {
    const requirementOfTest = (testId: string): string | null => (testId.startsWith("r1-") ? "R1" : null);
    const failures = namedFailuresOf({
      staticCheckPassed: true,
      correspondenceMisses: [{ requirementId: "R2" }, { requirementId: "R2" }],
      rejections: [{ requirementId: "R3" }],
      unmarked: ["R4"],
      mismatches: [{ testId: "r1-normal" }, { testId: "r1-normal" }],
      unresolved: [{ testId: "x-1" }],
      requirementOfTest,
    });
    expect(failures).toEqual([
      { testId: null, requirementId: "R2", kind: "correspondence-miss", message: NAMED_FAILURE_MESSAGES["correspondence-miss"] },
      { testId: null, requirementId: "R3", kind: "decl-rejection", message: NAMED_FAILURE_MESSAGES["decl-rejection"] },
      { testId: null, requirementId: "R4", kind: "decl-unmarked", message: NAMED_FAILURE_MESSAGES["decl-unmarked"] },
      { testId: "r1-normal", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"] },
      { testId: "x-1", requirementId: null, kind: "test-unresolved", message: NAMED_FAILURE_MESSAGES["test-unresolved"] },
    ]);
    for (const failure of failures) expect(Object.keys(failure).sort()).toEqual(["kind", "message", "requirementId", "testId"]);
    expect(
      namedFailuresOf({
        staticCheckPassed: false,
        correspondenceMisses: [],
        rejections: [],
        unmarked: [],
        mismatches: [],
        unresolved: [],
        requirementOfTest,
      }),
    ).toEqual([{ testId: null, requirementId: null, kind: "static-check", message: NAMED_FAILURE_MESSAGES["static-check"] }]);
    expect(Object.keys(NAMED_FAILURE_MESSAGES)).toEqual([...NAMED_FAILURE_KINDS]);
  });
});

describe("探索の記録の往復ごとの直す手（手 4b。Issue #553）", () => {
  it("記録の JSON の末尾に rounds を足し、ほかの欄の値と順・字下げ・末尾の改行は変えない", () => {
    const text = `${JSON.stringify({ versions: [], recounts: [], best_declaration_sha256: "a", rewritten: false }, null, 2)}\n`;
    const rounds = [
      { hand: "field-repair" as const, locations: 2, unlocated: 0, refused: null },
      { hand: "repair" as const, locations: 1, unlocated: 1, refused: null },
    ];
    const extended = withSearchRounds(text, rounds);
    expect(extended.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(extended) as object)).toEqual(["versions", "recounts", "best_declaration_sha256", "rewritten", "rounds"]);
    expect((JSON.parse(extended) as { rounds: unknown }).rounds).toEqual(rounds);
    expect(extended.startsWith(text.slice(0, text.lastIndexOf("\n}")))).toBe(true);
  });
});

describe("失敗の集合の指紋（段の走りの探索の出来事の列。Issue #746）", () => {
  const failure = (kind: (typeof NAMED_FAILURE_KINDS)[number], testId: string | null, requirementId: string | null) => ({
    kind,
    testId,
    requirementId,
    message: NAMED_FAILURE_MESSAGES[kind],
  });
  it("(種類, 試験 ID, 要件 ID) の組を JSON の文字列の順に並べた配列の JSON の SHA-256。並びに依らず、ID の値を返さない", async () => {
    const a = failure("test-mismatch", "t-9", "R-9");
    const b = failure("decl-rejection", null, "R-8");
    const c = failure("static-check", null, null);
    const expected = await sha256Hex(`[${[JSON.stringify(["decl-rejection", null, "R-8"]), JSON.stringify(["test-mismatch", "t-9", "R-9"])].sort().join(",")}]`);
    expect(await failureSetSha256([a, b])).toBe(expected);
    // 同じ集合で並びだけ違えば同じ値
    expect(await failureSetSha256([b, a])).toBe(expected);
    // 集合が違えば違う値（固定文は値に入れない）
    expect(await failureSetSha256([a])).not.toBe(expected);
    expect(await failureSetSha256([{ ...a, message: "別の文" }, b])).toBe(expected);
    expect(await failureSetSha256([c])).toBe(await sha256Hex('[["static-check",null,null]]'));
    expect(await failureSetSha256([])).toBe(await sha256Hex("[]"));
    expect(await failureSetSha256([a, b])).toMatch(/^[0-9a-f]{64}$/u);
  });
});
