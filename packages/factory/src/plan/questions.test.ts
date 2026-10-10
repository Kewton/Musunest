// 質問を組み立てる（plan/questions.ts）の unit テスト（04-plan-agent.md §3 P4・§6）。
//
// **偽物の LLM で回す。実 API は呼ばない。** ここで固定したいのは、コードが形・数・事項との対応・重複を
// 確かめること。断るもの：選択肢が 1 つ・5 つ、推奨が無い、自由入力が無い、同じ事項への 2 問。
import { describe, expect, it } from "vitest";
import { PLAN_CHOICES_MIN, AGENT_LIMITS } from "../limits.js";
import type { PlanOpenIssue } from "@musunest/appspec-schema";
import { SAMPLE_DOCUMENTS, createRecordingClient, makeGateway } from "../stages/__tests__/prompt.js";
import {
  QUESTIONS_SCHEMA_NAME,
  checkQuestionSet,
  checkQuestionsOutput,
  runQuestions,
  type PlanChoice,
  type PlanQuestion,
  type PlanRecommended,
} from "./questions.js";

const OPEN_ISSUES: readonly PlanOpenIssue[] = [
  { id: "OI-1", text: "誰の分を数えるか", critical: true, status: "open" },
  { id: "OI-2", text: "期間をどうするか", critical: false, status: "open" },
];

const choices = (...ids: readonly string[]): readonly PlanChoice[] =>
  ids.map((id) => ({ id, text: `${id} の説明` }));

const RECOMMENDED: PlanRecommended = { choiceId: "c1", reason: "依頼に沿う" };

/** 問い 1 つを作る（既定では正しい形。壊したい欄だけ上書きする） */
interface QuestionOverrides {
  readonly id?: string;
  readonly openIssueId?: string;
  readonly revision?: number;
  readonly text?: string;
  readonly choices?: readonly PlanChoice[];
  readonly recommended?: PlanRecommended | undefined;
  readonly allowFreeText?: boolean | undefined;
}

function question(overrides: QuestionOverrides = {}, issueId = "OI-1"): PlanQuestion {
  const recommended = "recommended" in overrides ? overrides.recommended : RECOMMENDED;
  const allowFreeText = "allowFreeText" in overrides ? overrides.allowFreeText : true;
  return {
    id: overrides.id ?? "Q-1",
    openIssueId: overrides.openIssueId ?? issueId,
    revision: overrides.revision ?? 1,
    text: overrides.text ?? "どちらにしますか",
    choices: overrides.choices ?? choices("c1", "c2"),
    ...(recommended === undefined ? {} : { recommended }),
    ...(allowFreeText === undefined ? {} : { allowFreeText }),
  };
}

describe("質問のコードの検査（04 §3 P4・§6 の 3）", () => {
  it("正しい質問の束は通る", () => {
    const problems = checkQuestionSet(
      OPEN_ISSUES.map((issue) => issue.id),
      [question({ id: "Q-1" }, "OI-1"), question({ id: "Q-2", recommended: { choiceId: "c2", reason: "短い" } }, "OI-2")],
    );
    expect(problems).toEqual([]);
  });

  it("選択肢が 1 つなら断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ choices: choices("c1") })]);
    expect(problems.map((problem) => problem.code)).toContain("choices-count");
  });

  it("選択肢が 5 つなら断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ choices: choices("c1", "c2", "c3", "c4", "c5") })]);
    expect(problems.map((problem) => problem.code)).toContain("choices-count");
  });

  it("選択肢はちょうど下限・上限なら通る（境目）", () => {
    const min = checkQuestionSet(["OI-1"], [question({ choices: choices("c1", "c2") })]);
    expect(min.map((problem) => problem.code)).not.toContain("choices-count");
    const max = checkQuestionSet(
      ["OI-1"],
      [question({ choices: choices("c1", "c2", "c3", "c4") })],
    );
    expect(max.map((problem) => problem.code)).not.toContain("choices-count");
    expect(PLAN_CHOICES_MIN).toBe(2);
    expect(AGENT_LIMITS.planChoices).toBe(4);
  });

  it("推奨が無ければ断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ recommended: undefined })]);
    expect(problems.map((problem) => problem.code)).toContain("recommendation");
  });

  it("推奨が選択肢に無ければ断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ recommended: { choiceId: "c9", reason: "理由" } })]);
    expect(problems.map((problem) => problem.code)).toContain("recommendation");
  });

  it("自由入力が無ければ断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ allowFreeText: false })]);
    expect(problems.map((problem) => problem.code)).toContain("free-text");
  });

  it("同じ事項への 2 問は断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({ id: "Q-1" }, "OI-1"), question({ id: "Q-2" }, "OI-1")]);
    expect(problems.map((problem) => problem.code)).toContain("duplicate-issue");
  });

  it("未解決の事項に無い ID を指す問いは断る", () => {
    const problems = checkQuestionSet(["OI-1"], [question({}, "OI-9")]);
    expect(problems.map((problem) => problem.code)).toContain("issue-mapping");
  });

  it("問数が上限を超えたら断る", () => {
    const many = Array.from({ length: AGENT_LIMITS.planQuestions + 1 }, (_value, index) =>
      question({ id: `Q-${index}` }, `OI-${index}`),
    );
    const problems = checkQuestionSet(
      many.map((one) => one.openIssueId),
      many,
    );
    expect(problems.map((problem) => problem.code)).toContain("question-count");
  });
});

describe("P4 の形の確認", () => {
  it("正しい応答は固定でき、版（revision）をコードが付ける", () => {
    const checked = checkQuestionsOutput(
      {
        questions: [
          {
            id: "Q-1",
            openIssueId: "OI-1",
            text: "どちらにしますか",
            choices: [
              { id: "c1", text: "こちら" },
              { id: "c2", text: "あちら" },
            ],
            recommended: { choiceId: "c1", reason: "依頼に沿う" },
            allowFreeText: true,
          },
        ],
      },
      3,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value[0]?.revision).toBe(3);
  });
});

describe("P4 を 1 回呼ぶ（04 §3 P4）", () => {
  const VALID_OUTPUT = {
    questions: [
      {
        id: "Q-1",
        openIssueId: "OI-1",
        text: "どちらにしますか",
        choices: [
          { id: "c1", text: "こちら" },
          { id: "c2", text: "あちら" },
        ],
        recommended: { choiceId: "c1", reason: "依頼に沿う" },
        allowFreeText: true,
      },
    ],
  };

  it("正しい応答は通り、データは依頼文と未解決の事項だけ・JSON Schema が付く", async () => {
    const recording = createRecordingClient([{ kind: "structured", output: VALID_OUTPUT, usage: undefined }]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [OPEN_ISSUES[0] ?? { id: "OI-1", text: "x", critical: true, status: "open" }],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.schemaName).toBe(QUESTIONS_SCHEMA_NAME);
    expect(request?.input).toContain("依頼文");
    expect(request?.input).toContain("未解決の事項");
    expect(request?.instructions).not.toContain("未解決の事項");
  });

  it("意味の検査に合わない応答は unmet で断る", async () => {
    const bad = {
      questions: [
        {
          id: "Q-1",
          openIssueId: "OI-1",
          text: "どちらにしますか",
          choices: [{ id: "c1", text: "こちら" }],
          recommended: { choiceId: "c1", reason: "依頼に沿う" },
          allowFreeText: true,
        },
      ],
    };
    const recording = createRecordingClient([{ kind: "structured", output: bad, usage: undefined }]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [OPEN_ISSUES[0] ?? { id: "OI-1", text: "x", critical: true, status: "open" }],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
  });

  it("P4 に渡すデータに、残りの問数が入り、答えの出た事項が入らない", async () => {
    const recording = createRecordingClient([{ kind: "structured", output: VALID_OUTPUT, usage: undefined }]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [
        { id: "OI-3", text: "重大でない事項", critical: false, status: "open" },
        { id: "OI-1", text: "重大な事項", critical: true, status: "open" },
        { id: "OI-2", text: "答えの出た事項", critical: true, status: "resolved" },
      ],
      remaining: 7,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    // 残りの問数がデータに入る
    expect(request?.input).toContain("残りの問数");
    expect(request?.input).toContain("7");
    // 答えの出た事項はデータに入らない
    expect(request?.input).not.toContain("OI-2");
    expect(request?.input).not.toContain("答えの出た事項");
    // 重大なものを先に並べる
    expect(request?.input.indexOf("OI-1")).toBeLessThan(request?.input.indexOf("OI-3") ?? -1);
  });

  it("残りの問数が足りるのに重大な事項への問いが欠けた応答は、やり直しになる", async () => {
    const missingCritical = { questions: [question({ id: "Q-2" }, "OI-2")] };
    const recording = createRecordingClient([
      { kind: "structured", output: missingCritical, usage: undefined },
      { kind: "structured", output: VALID_OUTPUT, usage: undefined },
    ]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [...OPEN_ISSUES],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    // 1 回目（重大な事項 OI-1 の問いが無い）でやり直し、2 回目の応答を使う
    expect(recording.structured).toHaveLength(2);
  });

  it("重大な事項への問いが欠けた応答が 2 回続くと段の失敗になる", async () => {
    const missingCritical = { questions: [question({ id: "Q-2" }, "OI-2")] };
    const recording = createRecordingClient([
      { kind: "structured", output: missingCritical, usage: undefined },
      { kind: "structured", output: missingCritical, usage: undefined },
    ]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [...OPEN_ISSUES],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
  });

  it("開いている事項があるのに問いが 0 問の応答も、やり直しになる", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { questions: [] }, usage: undefined },
      { kind: "structured", output: VALID_OUTPUT, usage: undefined },
    ]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [...OPEN_ISSUES],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(2);
  });

  it("問いが残りの問数を超えたら、重大なものを残して切られる", async () => {
    const issues: readonly PlanOpenIssue[] = [
      { id: "OI-1", text: "重大", critical: true, status: "open" },
      { id: "OI-2", text: "重大でない", critical: false, status: "open" },
      { id: "OI-3", text: "重大でない 2", critical: false, status: "open" },
    ];
    const output = {
      questions: [
        question({ id: "Q-2" }, "OI-2"),
        question({ id: "Q-1" }, "OI-1"),
        question({ id: "Q-3" }, "OI-3"),
      ],
    };
    const recording = createRecordingClient([{ kind: "structured", output, usage: undefined }]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: issues,
      remaining: 1,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 残り 1 問なので、重大な事項（OI-1）の問いだけが残る（順に切るだけでやり直しはしない）
    expect(outcome.value.map((one) => one.id)).toEqual(["Q-1"]);
    expect(recording.structured).toHaveLength(1);
  });
});
