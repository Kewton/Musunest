// 質問を組み立てる（plan/questions.ts）の unit テスト（04-plan-agent.md §3 P4・§6）。
//
// **偽物の LLM で回す。実 API は呼ばない。** ここで固定したいのは、コードが形・数・事項との対応・重複を
// 確かめること。断るもの：選択肢が 1 つ・5 つ、推奨が無い、自由入力が無い、同じ事項への 2 問。
import { describe, expect, it } from "vitest";
import { PLAN_CHOICES_MIN, AGENT_LIMITS, maxOutputTokensForEffort } from "../limits.js";
import type { PlanOpenIssue } from "@musunest/appspec-schema";
import { SAMPLE_DOCUMENTS, createRecordingClient, makeGateway } from "../stages/__tests__/prompt.js";
import {
  QUESTIONS_RULES,
  QUESTIONS_SCHEMA_NAME,
  alsoClosesOf,
  checkQuestionCoverage,
  checkQuestionLinks,
  checkQuestionSet,
  checkQuestionsOutput,
  runQuestions,
  trimQuestionsToRemaining,
  type PlanChoice,
  type PlanQuestion,
  type PlanRecommended,
  type PlanSourceClosure,
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
  readonly alsoCloses?: readonly string[];
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
    ...(overrides.alsoCloses === undefined ? {} : { alsoCloses: overrides.alsoCloses }),
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
      "タスクを記録する。",
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.questions[0]?.revision).toBe(3);
    // 一緒に閉じる一覧が無い問いは、空の配列として扱われる
    expect(alsoClosesOf(checked.value.questions[0] as PlanQuestion)).toEqual([]);
  });

  it("応答の中で質問 ID が重なると、形の確認で duplicate-question-id として断る（Issue #405）", () => {
    const item = (openIssueId: string) => ({
      id: "Q-1",
      openIssueId,
      text: "どちらにしますか",
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    });
    const checked = checkQuestionsOutput(
      { questions: [item("OI-1"), item("OI-2")] },
      1,
      "タスクを記録する。",
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    // 重なりの欄は、添字つきの `questions[n].id`。分類は `duplicate-question-id`
    expect(checked.problems).toEqual([
      { field: "questions[1].id", code: "duplicate-question-id", message: "質問 ID が重複している" },
    ]);
  });

  it("質問 ID の重なりは、意味の検査（checkQuestionSet）では二重に数えない（Issue #405）", () => {
    const problems = checkQuestionSet(
      ["OI-1", "OI-2"],
      [question({ id: "Q-1" }, "OI-1"), question({ id: "Q-1" }, "OI-2")],
    );
    // 形の確認が `duplicate-question-id` を出すので、意味の検査は重なりを数えない
    expect(problems.map((problem) => problem.code)).not.toContain("duplicate-question-id");
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

  it("出力の上限は、自分の段（questions）の値になる（02 §1.5・Issue #399）", async () => {
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
    expect(recording.structured[0]?.maxOutputTokens).toBe(maxOutputTokensForEffort("high", "questions"));
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
    if (outcome.failure.kind !== "unmet") return;
    // 断る理由の分類（コード）が残る（Issue #397）
    expect(outcome.failure.problems.map((problem) => problem.code)).toContain("choices-count");
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
      // 残り 1 問（開いている 2 件が収まらない）——重大な事項への問いだけでよい設定
      remaining: 1,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    // 残りの問数がデータに入る
    expect(request?.input).toContain('<data name="残りの問数">\n1\n</data>');
    // 答えの出た事項はデータに入らない
    expect(request?.input).not.toContain("OI-2");
    expect(request?.input).not.toContain("答えの出た事項");
    // 重大なものを先に並べる
    expect(request?.input.indexOf("OI-1")).toBeLessThan(request?.input.indexOf("OI-3") ?? -1);
  });

  it("残りの問数が足りるのに重大な事項への問いが欠けた応答は、やり直しになる", async () => {
    // 2 件が残り 4 に収まるので、重大な OI-1 と重大でない OI-2 の両方を覆う必要がある
    const covering = { questions: [question({ id: "Q-1", alsoCloses: ["OI-2"] }, "OI-1")] };
    const missingCritical = { questions: [question({ id: "Q-2" }, "OI-2")] };
    const recording = createRecordingClient([
      { kind: "structured", output: missingCritical, usage: undefined },
      { kind: "structured", output: covering, usage: undefined },
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
    // 2 件が残り 4 に収まるので、両方を覆う問いを出す必要がある
    const covering = { questions: [question({ id: "Q-1", alsoCloses: ["OI-2"] }, "OI-1")] };
    const recording = createRecordingClient([
      { kind: "structured", output: { questions: [] }, usage: undefined },
      { kind: "structured", output: covering, usage: undefined },
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
    expect(outcome.value.questions.map((one) => one.id)).toEqual(["Q-1"]);
    expect(recording.structured).toHaveLength(1);
  });
});

// ── 一緒に閉じる事項（alsoCloses）と、依頼文で閉じる事項（closedBySource）（Issue #370）──

describe("一緒に閉じる事項の一覧（alsoCloses。04 §3 P4・Issue #370）", () => {
  it("一緒に閉じる一覧を持つ問いは受け付けられ、問数には問いの数だけが数えられる", () => {
    const many = Array.from({ length: AGENT_LIMITS.planQuestions }, (_value, index) =>
      question({ id: `Q-${index}`, alsoCloses: [`OI-${index}-a`] }, `OI-${index}`),
    );
    const openIds = many.flatMap((one) => [one.openIssueId, ...alsoClosesOf(one)]);
    const problems = checkQuestionSet(openIds, many);
    // 一緒に閉じる事項は問数に数えない（問いは上限ちょうどの 10 問）
    expect(problems.map((problem) => problem.code)).not.toContain("question-count");
    expect(problems).toEqual([]);
  });

  it("一緒に閉じる一覧が無い質問の型は、空の配列として扱われる", () => {
    expect(alsoClosesOf(question())).toEqual([]);
    expect(alsoClosesOf(question({ alsoCloses: ["OI-2"] }))).toEqual(["OI-2"]);
  });

  it("問いが閉じるすべての ID で切り捨ての重大さを見る（主が重大でなくても、一緒に閉じる事項が重大なら残す）", () => {
    const openIssues: readonly PlanOpenIssue[] = [
      { id: "OI-1", text: "重大でない主", critical: false, status: "open" },
      { id: "OI-2", text: "重大な同義", critical: true, status: "open" },
      { id: "OI-3", text: "重大でない 2", critical: false, status: "open" },
    ];
    const grouped = question({ id: "Q-a", alsoCloses: ["OI-2"] }, "OI-1");
    const other = question({ id: "Q-b" }, "OI-3");
    // 残り 1 問の境界：主は重大でないが、一緒に閉じる事項が重大な Q-a が残る
    const trimmed = trimQuestionsToRemaining([other, grouped], openIssues, 1);
    expect(trimmed.map((one) => one.id)).toEqual(["Q-a"]);
    // 残り 2 問なら両方残る
    expect(trimQuestionsToRemaining([other, grouped], openIssues, 2)).toHaveLength(2);
  });
});

describe("問いと事項のつながりの検査（切り捨ての前。04 §3 P4・Issue #370）", () => {
  const CLOSED: readonly PlanSourceClosure[] = [
    { issueId: "OI-9", quote: "タスクを記録する", value: "記録する" },
  ];

  it("正しいつながりは通る", () => {
    expect(checkQuestionLinks(["OI-1", "OI-2"], [question({ alsoCloses: ["OI-2"] }, "OI-1")])).toEqual([]);
    expect(checkQuestionLinks(["OI-1", "OI-9"], [], CLOSED)).toEqual([]);
  });

  it("無い事項の ID は形の誤りになる", () => {
    expect(checkQuestionLinks(["OI-1"], [question({ alsoCloses: ["OI-9"] })])).not.toEqual([]);
    expect(checkQuestionLinks(["OI-1"], [question({}, "OI-9")])).not.toEqual([]);
  });

  it("すでに閉じた事項（依頼文で閉じる）の ID は形の誤りになる", () => {
    const problems = checkQuestionLinks(
      ["OI-1", "OI-9"],
      [question({ alsoCloses: ["OI-9"] }, "OI-1")],
      CLOSED,
    );
    expect(problems.map((problem) => problem.code)).toContain("also-closes");
  });

  it("同じ一覧の中の重なりは形の誤りになる", () => {
    const problems = checkQuestionLinks(["OI-1", "OI-2"], [question({ alsoCloses: ["OI-2", "OI-2"] }, "OI-1")]);
    expect(problems.map((problem) => problem.code)).toContain("also-closes");
  });

  it("主の ID の再掲は形の誤りになる", () => {
    const problems = checkQuestionLinks(["OI-1"], [question({ alsoCloses: ["OI-1"] }, "OI-1")]);
    expect(problems.map((problem) => problem.code)).toContain("also-closes");
  });

  it("2 か所以上に出る事項は形の誤りになる", () => {
    const problems = checkQuestionLinks(
      ["OI-1", "OI-2"],
      [question({ id: "Q-1", alsoCloses: ["OI-2"] }, "OI-1"), question({ id: "Q-2" }, "OI-2")],
    );
    expect(problems.map((problem) => problem.code)).toContain("duplicate-issue");
  });
});

describe("重大な事項の取りこぼしと、依頼文で閉じる事項（04 §3 P4・Issue #370）", () => {
  const CRITICAL: readonly PlanOpenIssue[] = [
    { id: "OI-1", text: "重大 1", critical: true, status: "open" },
    { id: "OI-2", text: "重大 2", critical: true, status: "open" },
  ];

  it("重大な事項を、問い・一緒に閉じる一覧・依頼文で閉じる一覧のどれかで閉じていれば、取りこぼしにならない", () => {
    // 1 問で 2 件を閉じる（主 + 一緒に閉じる）
    expect(
      checkQuestionCoverage(CRITICAL, 2, [question({ id: "Q-1", alsoCloses: ["OI-2"] }, "OI-1")]),
    ).toEqual([]);
    // 依頼文で閉じる一覧で閉じる（問いは 0 問でもよい）
    const closed: readonly PlanSourceClosure[] = [
      { issueId: "OI-1", quote: "タスクを記録する", value: "記録する" },
      { issueId: "OI-2", quote: "件数を合計する", value: "合計する" },
    ];
    expect(checkQuestionCoverage(CRITICAL, 4, [], closed)).toEqual([]);
    // どれでも閉じていない重大な事項があれば、取りこぼしになる
    expect(checkQuestionCoverage(CRITICAL, 4, [question({ id: "Q-1" }, "OI-1")])).not.toEqual([]);
    // 依頼文で閉じる一覧に無いのに 0 問なら、取りこぼしになる
    expect(checkQuestionCoverage(CRITICAL, 4, [])).not.toEqual([]);
  });
});

// ── 開いている事項が残りの問数に収まるときは全部を覆わせる（Issue #419）──

describe("残りの問数に収まる事項は全部覆わせる（04 §3 P4・Issue #419）", () => {
  const MIX: readonly PlanOpenIssue[] = [
    { id: "OI-1", text: "重大", critical: true, status: "open" },
    { id: "OI-2", text: "重大でない 1", critical: false, status: "open" },
    { id: "OI-3", text: "重大でない 2", critical: false, status: "open" },
  ];

  it("3 件が残り 5 に収まるなら、重大でない事項を聞かない応答は覆いの誤りになる", () => {
    const problems = checkQuestionCoverage(MIX, 5, [question({ id: "Q-1" }, "OI-1")]);
    expect(problems.map((problem) => problem.code)).toContain("question-coverage");
  });

  it("収まるなら、一緒に閉じる事項（alsoCloses）で覆えば通る", () => {
    const problems = checkQuestionCoverage(MIX, 5, [
      question({ id: "Q-1", alsoCloses: ["OI-2", "OI-3"] }, "OI-1"),
    ]);
    expect(problems).toEqual([]);
  });

  it("収まらない（残り 2）なら、重大な事項だけでよい", () => {
    expect(checkQuestionCoverage(MIX, 2, [question({ id: "Q-1" }, "OI-1")])).toEqual([]);
    // 重大な事項が収まるのに覆われていなければ、今までどおり誤りになる
    expect(checkQuestionCoverage(MIX, 2, [question({ id: "Q-2" }, "OI-2")])).not.toEqual([]);
  });

  it("依頼文で閉じた事項を除いた数で判定する（依頼文で閉じた分は聞かなくてよい）", () => {
    const closed: readonly PlanSourceClosure[] = [
      { issueId: "OI-2", quote: "タスクを記録する", value: "記録する" },
      { issueId: "OI-3", quote: "件数を合計する", value: "合計する" },
    ];
    // 依頼文で 2 件閉じれば、残りは重大な 1 件だけ——問い 1 問で収まる
    expect(checkQuestionCoverage(MIX, 5, [question({ id: "Q-1" }, "OI-1")], closed)).toEqual([]);
  });

  it("覆いの誤りは 1 回だけやり直し、2 回続けば段の失敗になる", async () => {
    const asking = { questions: [question({ id: "Q-1" }, "OI-1")] };
    const recording = createRecordingClient([
      { kind: "structured", output: asking, usage: undefined },
      { kind: "structured", output: asking, usage: undefined },
    ]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [...MIX],
      remaining: 5,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    if (outcome.failure.kind !== "malformed") return;
    expect(outcome.failure.problems.map((problem) => problem.code)).toContain("question-coverage");
    expect(recording.structured).toHaveLength(2);
  });

  it("収まるなら、全部を覆う応答は通る（やり直しは走らない）", async () => {
    const output = { questions: [question({ id: "Q-1", alsoCloses: ["OI-2", "OI-3"] }, "OI-1")] };
    const recording = createRecordingClient([{ kind: "structured", output, usage: undefined }]);
    const outcome = await runQuestions({
      source: "タスクを記録する。",
      openIssues: [...MIX],
      remaining: 5,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(1);
  });
});

describe("依頼文で閉じる事項の引用（04 §3 P4・Issue #370）", () => {
  const ISSUE: PlanOpenIssue = { id: "OI-1", text: "誰の分を数えるか", critical: true, status: "open" };

  async function runWith(first: unknown, second: unknown) {
    const recording = createRecordingClient([
      { kind: "structured", output: first, usage: undefined },
      { kind: "structured", output: second, usage: undefined },
    ]);
    const outcome = await runQuestions({
      source: "タスクを記録する。件数を合計する。",
      openIssues: [ISSUE],
      remaining: 4,
      revision: 1,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    return { outcome, recording };
  }

  it("依頼文に無い引用で閉じた応答は、やり直しになる", async () => {
    const bad = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "依頼文に無い", value: "記録する" }],
    };
    const good = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "タスクを記録する", value: "記録する" }],
    };
    const { outcome, recording } = await runWith(bad, good);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.closedBySource).toEqual([
      { issueId: "OI-1", quote: "タスクを記録する", value: "記録する" },
    ]);
  });

  it("空の引用で閉じた応答は、やり直しになる", async () => {
    const bad = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "", value: "記録する" }],
    };
    const good = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "件数を合計する", value: "合計する" }],
    };
    const { outcome, recording } = await runWith(bad, good);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(true);
  });

  it("逐語でない引用は、置き換え（source-closure-quote）と空白の差（source-closure-quote-whitespace）に分けて断り、どちらも受理しない", () => {
    const source = "タスクを記録する。件数を合計する。";
    const item = (quote: string) => ({ issueId: "OI-1", quote, value: "記録する" });

    // 依頼文にそのまま含まれない（置き換え）
    const missing = checkQuestionsOutput({ questions: [], closedBySource: [item("タスクを登録する。")] }, 1, source);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problems.map((problem) => problem.code)).toEqual(["source-closure-quote"]);

    // 空白の差だけ
    const spaced = checkQuestionsOutput({ questions: [], closedBySource: [item("タスクを 記録する。")] }, 1, source);
    expect(spaced.ok).toBe(false);
    if (spaced.ok) return;
    expect(spaced.problems.map((problem) => problem.code)).toEqual(["source-closure-quote-whitespace"]);

    // 空白だけの引用は、空白差の一致にしない（source-closure-quote）
    const blank = checkQuestionsOutput({ questions: [], closedBySource: [item("   ")] }, 1, source);
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.problems.map((problem) => problem.code)).toEqual(["source-closure-quote"]);

    // 空文字は今までどおり shape
    const empty = checkQuestionsOutput({ questions: [], closedBySource: [item("")] }, 1, source);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problems.map((problem) => problem.code)).toEqual(["shape"]);
  });

  it("逐語でない引用の問題に、引用の値が入らない", () => {
    const source = "タスクを記録する。件数を合計する。";
    const mark = "MARK_QUOTE_JJJ";
    const checked = checkQuestionsOutput(
      { questions: [], closedBySource: [{ issueId: "OI-1", quote: `${mark}する`, value: "記録する" }] },
      1,
      source,
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    // 問題（欄の名前・分類・文）のどこにも、引用の値が入らない
    expect(JSON.stringify(checked.problems)).not.toContain(mark);
    expect(checked.problems.map((problem) => problem.code)).toEqual(["source-closure-quote"]);
  });

  it("依頼文に無い引用は source-closure-quote で、やり直しになる", async () => {
    const bad = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "依頼文に無い", value: "記録する" }],
    };
    const good = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "タスクを記録する", value: "記録する" }],
    };
    const { outcome, recording } = await runWith(bad, good);
    // 逐語の受理の条件は変えない——やり直しになり、2 回目で通る
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(true);
  });

  it("空白の差だけの引用も、今までどおりやり直しになる", async () => {
    const bad = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "タスクを 記録する", value: "記録する" }],
    };
    const good = {
      questions: [],
      closedBySource: [{ issueId: "OI-1", quote: "タスクを記録する", value: "記録する" }],
    };
    const { outcome, recording } = await runWith(bad, good);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(true);
  });

  it("規則の文に、逐語で引用できない事項は依頼文による解決に含めないことと、許可の表に当てはまる事項はコードが既定で閉じることがある", () => {
    const text = QUESTIONS_RULES.join("\n");
    expect(text).toContain("逐語で引用できない");
    expect(text).toContain("依頼文で閉じる事項");
    expect(text).toContain("許可の表");
    expect(text).toContain("既定で閉じる");
  });

  it("規則の 3 文目が、収まるなら重大でない事項も聞く（か一緒に閉じる）ことと、収まらなければ重大を先にすることを書く", () => {
    const rule = QUESTIONS_RULES[2] ?? "";
    expect(rule).toContain("全部収まる");
    expect(rule).toContain("重大でない事項も聞く");
    expect(rule).toContain("収まらない");
  });
});

// ── 断る問題の path と message に、事項 ID・選択肢 ID の値を埋めない（§1・P4・Issue #445）──

describe("断る問題の path と message に、事項 ID・選択肢 ID の値を埋めない（§1・P4・Issue #445）", () => {
  const mark = "MARKER445";

  /** 問題の全欄を 1 つの文字列に直列化する（目印の有無を見るため） */
  const text = (problems: readonly { readonly code: string; readonly path: string; readonly message: string }[]): string =>
    problems.map((problem) => `${problem.code} ${problem.path} ${problem.message}`).join("\n");

  it("checkQuestionSet の各検査で、事項 ID・選択肢 ID の値を埋めない", () => {
    const mapping = checkQuestionSet(["OI-1"], [question({ openIssueId: `OI-${mark}` })]);
    const duplicate = checkQuestionSet(
      [`OI-${mark}`],
      [question({ id: "Q-1", openIssueId: `OI-${mark}` }), question({ id: "Q-2", openIssueId: `OI-${mark}` })],
    );
    const recommended = checkQuestionSet(
      [`OI-${mark}`],
      [question({ openIssueId: `OI-${mark}`, recommended: { choiceId: `c-${mark}`, reason: "理由" } })],
    );
    const duplicatedChoice = checkQuestionSet(
      [`OI-${mark}`],
      [question({ openIssueId: `OI-${mark}`, choices: choices(`c-${mark}`, `c-${mark}`) })],
    );
    expect(mapping.map((problem) => problem.code)).toContain("issue-mapping");
    expect(duplicate.map((problem) => problem.code)).toContain("duplicate-issue");
    expect(recommended.map((problem) => problem.code)).toContain("recommendation");
    expect(duplicatedChoice.map((problem) => problem.code)).toContain("shape");
    for (const problems of [mapping, duplicate, recommended, duplicatedChoice]) {
      expect(problems.length).toBeGreaterThan(0);
      expect(text(problems)).not.toContain(mark);
    }
  });

  it("checkQuestionLinks が出す全部の code に、目印の例があり、値を埋めない", () => {
    const closed: readonly PlanSourceClosure[] = [
      { issueId: `OI-${mark}`, quote: "タスクを記録する", value: "記録する" },
    ];
    // 未解決の事項に無い（依頼文で閉じる一覧にも無い）
    const sourceClosure = checkQuestionLinks(["OI-1"], [], closed);
    // 依頼文で閉じる一覧の中で重なる（同じ事項を 2 回）
    const sourceClosureDuplicate = checkQuestionLinks(
      [`OI-${mark}`],
      [],
      [
        { issueId: `OI-${mark}`, quote: "タスクを記録する", value: "記録する" },
        { issueId: `OI-${mark}`, quote: "件数を合計する", value: "合計する" },
      ],
    );
    // 依頼文で閉じる事項と同じ
    const alsoCloses = checkQuestionLinks(
      ["OI-1", `OI-${mark}`],
      [question({ id: "Q-1", openIssueId: "OI-1", alsoCloses: [`OI-${mark}`] })],
      closed,
    );
    // 一緒に閉じる一覧の中で重なる（同じ事項を 2 回）／主の事項を一緒に閉じる一覧に書き直す
    const alsoClosesDuplicate = checkQuestionLinks(
      ["OI-1", `OI-${mark}`],
      [question({ id: "Q-1", openIssueId: "OI-1", alsoCloses: [`OI-${mark}`, `OI-${mark}`] })],
    );
    const alsoClosesMain = checkQuestionLinks(
      [`OI-${mark}`],
      [question({ id: "Q-1", openIssueId: `OI-${mark}`, alsoCloses: [`OI-${mark}`] })],
    );
    // 問いの主の事項が、未解決の事項に無い
    const issueMapping = checkQuestionLinks(["OI-1"], [question({ openIssueId: `OI-${mark}` })]);
    // 主の事項が、別の問いの一緒に閉じる一覧にも載る（個々の一覧では重複しない）
    const duplicate = checkQuestionLinks(
      ["OI-1", `OI-${mark}`],
      [
        question({ id: "Q-1", openIssueId: "OI-1", alsoCloses: [`OI-${mark}`] }),
        question({ id: "Q-2", openIssueId: `OI-${mark}` }),
      ],
    );
    expect(sourceClosure.map((problem) => problem.code)).toContain("source-closure");
    expect(sourceClosureDuplicate.map((problem) => problem.code)).toContain("source-closure");
    expect(alsoCloses.map((problem) => problem.code)).toContain("also-closes");
    expect(alsoClosesDuplicate.map((problem) => problem.code)).toContain("also-closes");
    expect(alsoClosesMain.map((problem) => problem.code)).toContain("also-closes");
    expect(issueMapping.map((problem) => problem.code)).toContain("issue-mapping");
    expect(duplicate.map((problem) => problem.code)).toContain("duplicate-issue");
    for (const problems of [
      sourceClosure,
      sourceClosureDuplicate,
      alsoCloses,
      alsoClosesDuplicate,
      alsoClosesMain,
      issueMapping,
      duplicate,
    ]) {
      expect(problems.length).toBeGreaterThan(0);
      expect(text(problems)).not.toContain(mark);
    }
  });
});
