// P4 質問を組み立てる（04-plan-agent.md §3 P4・§6）。
//
// **1 問 = 未解決の事項 1 つ**。影響の大きい順に、合わせて上限（`AGENT_LIMITS.planQuestions`）まで。1 問は
// 「質問 ID・問い・選択肢 2〜4（選択肢 ID）・推奨（とその理由 1 行）・自由入力」である（§6 の 3）。
//
// 質問の文は利用者の言葉で書く（宣言の用語を使わない。§3）。**コードが形・数・事項との対応・重複を確かめる**
// ——選択肢の数（2〜4）、推奨が選択肢の 1 つであること、自由入力があること、同じ事項への 2 問が無いこと、
// 問数が上限を超えないこと。
//
// **実 API は呼ばない。** 質問の文と選択肢を作るのは LLM（共通の口を通す）だが、判定と形の検査はコードである。
import type { CallGateway } from "../call.js";
import type { PlanOpenIssue } from "@musunest/appspec-schema";
import { AGENT_LIMITS, PLAN_CHOICES_MIN } from "../limits.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type Problem,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "../stages/prompt.js";

/** P4 の JSON Schema の名前 */
export const QUESTIONS_SCHEMA_NAME = "plan-questions";

/** P4 に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const QUESTIONS_RULES: readonly string[] = [
  "未解決の事項から、利用者への質問を組み立てる。**1 問は未解決の事項 1 つ**に対応する。",
  "1 問は「質問 ID（id）・問い（text）・選択肢（choices。2〜4 個。選択肢 ID と文）・推奨（recommended。選択肢 ID と理由 1 行）・自由入力の可否（allowFreeText）」を持つ。",
  "問いと選択肢の文は、利用者の言葉で書く。宣言の用語（entity・computed・selector など）を使わない。",
  "選択肢は、どれを選んでも書けるものにする。作るものが同じになる選択肢は 1 つにまとめる。",
  "推奨は必ず 1 つだけ示し、理由を 1 行で書く。自由入力はどの問いにも用意する（allowFreeText を true にする）。",
  "同じ事項を 2 問にしない。すでに答えの出ている事項は挙げない。",
];

/** P4 の JSON Schema（構造化出力） */
export const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "openIssueId", "text", "choices", "recommended", "allowFreeText"],
        properties: {
          id: { type: "string", description: "質問の識別子" },
          openIssueId: { type: "string", description: "この問いが対応する未解決の事項の ID" },
          text: { type: "string", description: "利用者の言葉で書いた問い" },
          choices: {
            type: "array",
            description: "選択肢（2〜4 個）",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "text"],
              properties: {
                id: { type: "string", description: "選択肢の識別子" },
                text: { type: "string", description: "選択肢の文" },
              },
            },
          },
          recommended: {
            type: "object",
            additionalProperties: false,
            required: ["choiceId", "reason"],
            properties: {
              choiceId: { type: "string", description: "推奨する選択肢の ID" },
              reason: { type: "string", description: "推奨の理由（1 行）" },
            },
          },
          allowFreeText: { type: "boolean", description: "自由入力を許すか（どの問いにも true）" },
        },
      },
    },
  },
} as const;

/** 質問の選択肢 1 つ */
export interface PlanChoice {
  readonly id: string;
  readonly text: string;
}

/** 推奨の選択肢と、その理由（1 行） */
export interface PlanRecommended {
  /** `choices` のどれかの ID */
  readonly choiceId: string;
  readonly reason: string;
}

/**
 * 質問 1 つ（04 §4 `inputs` の `question` に対応する）。
 *
 * `recommended` と `allowFreeText` を**任意の欄**にしている——`checkQuestionSet` が「無い」ことを
 * 断れるようにするためである（型で強制すると、断りの試験が書けない）。正しい問いでは両方を持つ。
 */
export interface PlanQuestion {
  readonly id: string;
  readonly openIssueId: string;
  /** 質問を組み立てたときの仕様の版（これが古い答えを断る根拠。04 §6 の 6） */
  readonly revision: number;
  readonly text: string;
  readonly choices: readonly PlanChoice[];
  readonly recommended?: PlanRecommended;
  readonly allowFreeText?: boolean;
}

/** 質問の検査の誤りの種類（呼ぶ側が直し方を選べるように分ける） */
export const QUESTION_PROBLEM_CODES = [
  /** 形（欄の欠け・空文字・型違い） */
  "shape",
  /** 問数が上限を超えている */
  "question-count",
  /** 選択肢の数が 2〜4 でない */
  "choices-count",
  /** 推奨が無い・推奨が選択肢に無い・理由が空 */
  "recommendation",
  /** 自由入力が無い */
  "free-text",
  /** 未解決の事項に無い ID を指している */
  "issue-mapping",
  /** 同じ事項への 2 問がある */
  "duplicate-issue",
] as const;
export type QuestionProblemCode = (typeof QUESTION_PROBLEM_CODES)[number];

/** 質問の検査の誤り 1 つ */
export interface QuestionProblem {
  readonly code: QuestionProblemCode;
  readonly path: string;
  readonly message: string;
}

function checkChoice(value: unknown, field: string, problems: Problem[]): PlanChoice | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "選択肢は写像（object）であること" });
    return undefined;
  }
  const id = value["id"];
  const text = value["text"];
  let good = true;
  if (typeof id !== "string" || id === "") {
    problems.push({ field: `${field}.id`, message: "選択肢 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof text !== "string" || text === "") {
    problems.push({ field: `${field}.text`, message: "選択肢の文は空でない文字列であること" });
    good = false;
  }
  if (!good) return undefined;
  return { id: id as string, text: text as string };
}

function checkRecommended(value: unknown, field: string, problems: Problem[]): PlanRecommended | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "推奨は写像（object）であること" });
    return undefined;
  }
  const choiceId = value["choiceId"];
  const reason = value["reason"];
  let good = true;
  if (typeof choiceId !== "string" || choiceId === "") {
    problems.push({ field: `${field}.choiceId`, message: "推奨の選択肢 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof reason !== "string" || reason === "") {
    problems.push({ field: `${field}.reason`, message: "推奨の理由は空でない文字列であること（1 行）" });
    good = false;
  }
  if (!good) return undefined;
  return { choiceId: choiceId as string, reason: reason as string };
}

/**
 * P4 の応答の形を確かめる。`revision` は、この問いを組み立てた仕様の版である（LLM には書かせず、コードが
 * 付ける）。`recommended` と `allowFreeText` は、無ければ形では断らない（意味の検査 `checkQuestionSet` が
 * 断る）。
 */
export function checkQuestionsOutput(output: unknown, revision: number): ShapeCheck<readonly PlanQuestion[]> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["questions"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "questions", message: "質問の並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const questions: PlanQuestion[] = [];
  raw.forEach((item, index) => {
    const field = `questions[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "質問は写像（object）であること" });
      return;
    }
    const id = item["id"];
    const openIssueId = item["openIssueId"];
    const text = item["text"];
    let good = true;
    if (typeof id !== "string" || id === "") {
      problems.push({ field: `${field}.id`, message: "質問 ID は空でない文字列であること" });
      good = false;
    }
    if (typeof openIssueId !== "string" || openIssueId === "") {
      problems.push({ field: `${field}.openIssueId`, message: "未解決の事項の ID は空でない文字列であること" });
      good = false;
    }
    if (typeof text !== "string" || text === "") {
      problems.push({ field: `${field}.text`, message: "問いは空でない文字列であること" });
      good = false;
    }
    const rawChoices = item["choices"];
    const choices: PlanChoice[] = [];
    if (!Array.isArray(rawChoices)) {
      problems.push({ field: `${field}.choices`, message: "選択肢の並び（array）であること" });
      good = false;
    } else {
      rawChoices.forEach((choice, choiceIndex) => {
        const checked = checkChoice(choice, `${field}.choices[${choiceIndex}]`, problems);
        if (checked === undefined) good = false;
        else choices.push(checked);
      });
    }
    let recommended: PlanRecommended | undefined;
    if (item["recommended"] !== undefined) {
      recommended = checkRecommended(item["recommended"], `${field}.recommended`, problems);
      if (recommended === undefined) good = false;
    }
    let allowFreeText: boolean | undefined;
    if (item["allowFreeText"] !== undefined) {
      if (typeof item["allowFreeText"] !== "boolean") {
        problems.push({ field: `${field}.allowFreeText`, message: "自由入力の可否は真偽（boolean）であること" });
        good = false;
      } else {
        allowFreeText = item["allowFreeText"];
      }
    }
    if (good) {
      questions.push({
        id: id as string,
        openIssueId: openIssueId as string,
        revision,
        text: text as string,
        choices,
        ...(recommended === undefined ? {} : { recommended }),
        ...(allowFreeText === undefined ? {} : { allowFreeText }),
      });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: questions };
}

/**
 * 質問の束をコードで確かめる（04 §3 P4「コードが形・数・事項との対応・重複を確かめる」）。
 * 合わない箇所を**すべて**挙げて返す。空なら通る。
 */
export function checkQuestionSet(
  openIssueIds: readonly string[],
  questions: readonly PlanQuestion[],
): readonly QuestionProblem[] {
  const problems: QuestionProblem[] = [];
  const report = (code: QuestionProblemCode, path: string, message: string): void => {
    problems.push({ code, path, message });
  };

  if (questions.length > AGENT_LIMITS.planQuestions) {
    report(
      "question-count",
      "questions",
      `問数が上限を超えている（上限 ${AGENT_LIMITS.planQuestions}、実際 ${questions.length}）`,
    );
  }

  const openSet = new Set(openIssueIds);
  const seenIds = new Set<string>();
  const issueToIndex = new Map<string, number>();

  questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    if (question.id === "") report("shape", `${path}.id`, "質問 ID が空である");
    if (seenIds.has(question.id)) report("shape", `${path}.id`, `質問 ID ${question.id} が重複している`);
    seenIds.add(question.id);
    if (question.text === "") report("shape", `${path}.text`, "問いが空である");
    if (!Number.isInteger(question.revision) || question.revision < 1) {
      report("shape", `${path}.revision`, "版は 1 以上の整数であること");
    }

    if (question.choices.length < PLAN_CHOICES_MIN || question.choices.length > AGENT_LIMITS.planChoices) {
      report(
        "choices-count",
        `${path}.choices`,
        `選択肢は ${PLAN_CHOICES_MIN}〜${AGENT_LIMITS.planChoices} 個であること（実際 ${question.choices.length}）`,
      );
    }
    const choiceIds = new Set<string>();
    question.choices.forEach((choice, choiceIndex) => {
      if (choice.id === "" || choice.text === "") {
        report("shape", `${path}.choices[${choiceIndex}]`, "選択肢の ID と文は空でないこと");
      }
      if (choiceIds.has(choice.id)) {
        report("shape", `${path}.choices[${choiceIndex}].id`, `選択肢 ID ${choice.id} が重複している`);
      }
      choiceIds.add(choice.id);
    });

    if (question.recommended === undefined) {
      report("recommendation", `${path}.recommended`, "推奨が無い（どの問いにも推奨を 1 つ示す）");
    } else {
      if (question.recommended.reason === "") {
        report("recommendation", `${path}.recommended.reason`, "推奨の理由が空である（1 行書く）");
      }
      if (!choiceIds.has(question.recommended.choiceId)) {
        report(
          "recommendation",
          `${path}.recommended.choiceId`,
          `推奨 ${question.recommended.choiceId} が選択肢に無い`,
        );
      }
    }

    if (question.allowFreeText !== true) {
      report("free-text", `${path}.allowFreeText`, "自由入力が無い（どの問いにも自由入力を用意する）");
    }

    if (!openSet.has(question.openIssueId)) {
      report("issue-mapping", `${path}.openIssueId`, `${question.openIssueId}: 未解決の事項に無い`);
      return;
    }
    const previous = issueToIndex.get(question.openIssueId);
    if (previous !== undefined) {
      report(
        "duplicate-issue",
        `${path}.openIssueId`,
        `事項 ${question.openIssueId} への問いが重なっている（questions[${previous}] と）`,
      );
    } else {
      issueToIndex.set(question.openIssueId, index);
    }
  });

  return problems;
}

/** P4 が受け取るもの */
export interface QuestionsInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 未解決の事項（いま開いているもの） */
  readonly openIssues: readonly PlanOpenIssue[];
  /** 質問を組み立てた仕様の版 */
  readonly revision: number;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/**
 * P4 を 1 回呼ぶ。データは依頼文と未解決の事項だけである。形が合わない応答は 1 回だけやり直し、
 * 意味の検査（`checkQuestionSet`）に合わなければ `unmet` で断る。
 */
export async function runQuestions(input: QuestionsInput): Promise<StageOutcome<readonly PlanQuestion[]>> {
  const request = buildStructuredRequest({
    rules: QUESTIONS_RULES,
    documents: input.documents,
    data: [
      { name: "依頼文", text: input.source },
      { name: "未解決の事項", text: serializeJson(input.openIssues) },
    ],
    schemaName: QUESTIONS_SCHEMA_NAME,
    schema: QUESTIONS_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("design"),
  });
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkQuestionsOutput(output, input.revision),
  });
  if (!answer.ok) return answer;
  const problems = checkQuestionSet(
    input.openIssues.map((issue) => issue.id),
    answer.value,
  );
  if (problems.length > 0) {
    return {
      ok: false,
      failure: {
        kind: "unmet",
        attempts: 1,
        problems: problems.map((problem) => ({ field: problem.path, message: `${problem.code}: ${problem.message}` })),
      },
    };
  }
  return answer;
}
