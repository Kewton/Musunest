// J4 Jev の助言（v11a/stages/judge-advice.ts）の試験（Issue #507）。偽物の判定で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：境界値の両側で印が決まる／`llm` が答えたら値によらず確信度不明／答えの欠落・例外・門の拒否は
// 未判定で、例外が外へ出ない／state に名前が無い／要件ごとに要求 1 回・問いは所属の行の数／記録に問いの ID・
// 値・adapter・版・閾値がある。
import { describe, expect, it } from "vitest";
import { JudgeBudgetExceededError, JudgeCallLimitExceededError, JudgeDeadlineExceededError } from "../../judge-budget.js";
import type { Judge, JudgeRequest, JudgeResponse, JudgeSource } from "../../judge.js";
import { fixtureList, fixtureTable } from "../__tests__/fixtures.js";
import {
  JUDGE_ADVICE_THRESHOLDS,
  judgeAdviceMarkOf,
  judgeAdviceMarks,
  judgeAdviceQuestionId,
  runJudgeAdvice,
} from "./judge-advice.js";

const LIST = fixtureList();
const TABLE = fixtureTable();

/** 問いごとに同じ値で答える偽物（受け取った要求を残す） */
function fakeJudge(
  valueOf: (questionId: string) => number | undefined,
  options: { answeredBy?: JudgeSource; fail?: (request: JudgeRequest) => unknown } = {},
): { judge: Judge; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  const judge: Judge = {
    source: "fake",
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      requests.push(request);
      const failure = options.fail?.(request);
      if (failure !== undefined) throw failure;
      const answers: JudgeResponse["answers"] = Object.fromEntries(
        Object.keys(request.questions).flatMap((name) => {
          const value = valueOf(name);
          return value === undefined ? [] : [[name, { kind: "noul" as const, noul: value }]];
        }),
      );
      return { answers, inputTokens: 0, model: "fake-1.0", answeredBy: options.answeredBy ?? "jev" };
    },
  };
  return { judge, requests };
}

/** 所属の行がある・unresolved でない要件（R1〜R4） */
const ASKED = ["R1", "R2", "R3", "R4"];

const ownedRows = (requirementId: string) =>
  TABLE.ownership.find((entry) => entry.requirementId === requirementId)?.roles.map((role) => role.id) ?? [];

const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([name, item]) => name === key || hasKey(item, key));
  }
  return false;
};

describe("J4 の印", () => {
  it.each([
    [0.19, "suspect-unnecessary"],
    [0.2, "unclear"],
    [0.79, "unclear"],
    [0.8, null],
  ] as const)("値 %s の印は %s（閾値は定数 1 か所）", async (value, mark) => {
    expect(judgeAdviceMarkOf(value)).toBe(mark);
    const { judge } = fakeJudge(() => value);
    const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge });
    const questions = record.requests.flatMap((request) => request.questions);
    expect(questions.every((question) => question.mark === mark && question.value === value)).toBe(true);
    expect(questions.every((question) => !question.llmUnknownConfidence && question.undetermined === null)).toBe(true);
  });

  it("閾値は 0.2・0.8 で記録に載る", () => {
    expect(JUDGE_ADVICE_THRESHOLDS).toEqual({ suspectBelow: 0.2, clearAtOrAbove: 0.8 });
  });

  it("answeredBy が llm なら値によらず llm-unknown-confidence（値の印は付けない）", async () => {
    for (const value of [0.0, 0.5, 1.0]) {
      const { judge } = fakeJudge(() => value, { answeredBy: "llm" });
      const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge });
      const questions = record.requests.flatMap((request) => request.questions);
      expect(questions.every((question) => question.llmUnknownConfidence && question.mark === null)).toBe(true);
      expect(record.requests.every((request) => request.adapter === "llm")).toBe(true);
      expect(new Set(judgeAdviceMarks(record).map((entry) => entry.mark))).toEqual(new Set(["llm-unknown-confidence"]));
    }
  });

  it("答えの欠落は undetermined（missing）", async () => {
    const missing = judgeAdviceQuestionId("R3", "o.closeItem");
    const { judge } = fakeJudge((name) => (name === missing ? undefined : 0.9));
    const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge });
    const question = record.requests.flatMap((request) => request.questions).find((entry) => entry.questionId === missing);
    expect(question).toMatchObject({ value: null, mark: null, llmUnknownConfidence: false, undetermined: "missing" });
    expect(judgeAdviceMarks(record)).toEqual([{ requirementId: "R3", id: "o.closeItem", mark: "undetermined" }]);
  });

  it("例外と門の拒否（予算・締切・回数）は undetermined で、例外が外へ出ず次の要件へ進む", async () => {
    const failures: Record<string, unknown> = {
      R1: new Error("障害"),
      R2: new JudgeBudgetExceededError(1, 0),
      R3: new JudgeDeadlineExceededError(),
      R4: new JudgeCallLimitExceededError(0),
    };
    const { judge, requests } = fakeJudge(() => 0.9, {
      fail: (request) => {
        const [first] = Object.keys(request.questions);
        const requirementId = first?.split(":")[1] ?? "";
        return failures[requirementId];
      },
    });
    const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge });
    expect(requests).toHaveLength(4);
    expect(record.requests.map((request) => [request.requirementId, request.adapter, request.model])).toEqual([
      ["R1", null, null],
      ["R2", null, null],
      ["R3", null, null],
      ["R4", null, null],
    ]);
    expect(record.requests.map((request) => new Set(request.questions.map((question) => question.undetermined)))).toEqual([
      new Set(["error"]),
      new Set(["gate"]),
      new Set(["gate"]),
      new Set(["gate"]),
    ]);
    const gateRefusal = Object.assign(new Error("門"), { kind: "gateLimit" });
    const refused = await runJudgeAdvice({ list: LIST, table: TABLE, judge: fakeJudge(() => 0.9, { fail: () => gateRefusal }).judge });
    expect(refused.requests.every((request) => request.questions.every((question) => question.undetermined === "gate"))).toBe(true);
  });
});

describe("J4 の要求と記録", () => {
  it("要件ごとに要求 1 回、問いの数は所属の行の数。unresolved の要件は聞かない。state に名前が無い", async () => {
    const { judge, requests } = fakeJudge(() => 0.9);
    await runJudgeAdvice({ list: LIST, table: TABLE, judge });
    expect(requests).toHaveLength(ASKED.length);
    requests.forEach((request, index) => {
      const requirementId = ASKED[index]!;
      const rows = ownedRows(requirementId);
      expect(Object.keys(request.questions)).toEqual(rows.map((id) => judgeAdviceQuestionId(requirementId, id)));
      expect(Object.values(request.questions).every((question) => question.kind === "noul")).toBe(true);
      expect(hasKey(request.state, "name")).toBe(false);
      expect(hasKey(request.questions, "name")).toBe(false);
      const requirement = LIST.requirements.find((entry) => entry.id === requirementId)!;
      expect(request.state["requirement"]).toEqual({ text: requirement.text, quote: requirement.quote });
      expect((request.state["rows"] as { id: string }[]).map((row) => row.id)).toEqual(rows);
    });
  });

  it("記録に問いの ID・値・adapter・版・閾値がある", async () => {
    const { judge } = fakeJudge(() => 0.1);
    const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge });
    expect(record.thresholds).toEqual(JUDGE_ADVICE_THRESHOLDS);
    expect(record.requests.map((request) => request.requirementId)).toEqual(ASKED);
    for (const request of record.requests) {
      expect(request).toMatchObject({ adapter: "jev", model: "fake-1.0" });
      expect(request.questions.map((question) => question.questionId)).toEqual(
        ownedRows(request.requirementId).map((id) => judgeAdviceQuestionId(request.requirementId, id)),
      );
      expect(request.questions.every((question) => question.value === 0.1 && question.mark === "suspect-unnecessary")).toBe(true);
    }
    expect(judgeAdviceMarks(record)).toHaveLength(ASKED.flatMap(ownedRows).length);
  });

  it("印なし（値 0.8 以上）は印の並びに入れない", async () => {
    const record = await runJudgeAdvice({ list: LIST, table: TABLE, judge: fakeJudge(() => 0.95).judge });
    expect(judgeAdviceMarks(record)).toEqual([]);
  });
});
