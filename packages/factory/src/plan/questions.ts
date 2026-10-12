// P4 質問を組み立てる（04-plan-agent.md §3 P4・§6）。
//
// **1 問 = 未解決の事項 1 つ**。影響の大きい順に、合わせて上限（`AGENT_LIMITS.planQuestions`）まで。1 問は
// 「質問 ID・問い・選択肢 2〜4（選択肢 ID）・推奨（とその理由 1 行）・自由入力・一緒に閉じる事項
// （`alsoCloses`）」である（§6 の 3）。**同じことを聞く事項は 1 問にまとめ**、残りを `alsoCloses` に入れる。
// 依頼文で決まっている事項は、聞かずに依頼文の引用つきで閉じる（`closedBySource`）。
//
// 質問の文は利用者の言葉で書く（宣言の用語を使わない。§3）。**コードが形・数・事項との対応・重複を確かめる**
// ——選択肢の数（2〜4）、推奨が選択肢の 1 つであること、自由入力があること、同じ事項への 2 問が無いこと、
// `alsoCloses`・`closedBySource` のつながり（無い事項・閉じた事項・重なり）が正しいこと、問数が上限を
// 超えないこと。**このつながりの検査は切り捨ての前に行う**。
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
  "**重大な（critical が真の）未解決の事項を先に聞く。** 残りの問数の範囲で、重大な事項はすべて聞く。重大な事項が残りの問数より多いときは、残りの問数ぶんを重大なものから聞く。",
  "重大でない事項は、残りの問数に余りがあるときだけ聞く。",
  "1 問は「質問 ID（id）・問い（text）・選択肢（choices。2〜4 個。選択肢 ID と文）・推奨（recommended。選択肢 ID と理由 1 行）・自由入力の可否（allowFreeText）」を持つ。",
  "問いと選択肢の文は、利用者の言葉で書く。宣言の用語（entity・computed・selector など）を使わない。",
  "選択肢は、どれを選んでも書けるものにする。作るものが同じになる選択肢は 1 つにまとめる。",
  "推奨は必ず 1 つだけ示し、理由を 1 行で書く。自由入力はどの問いにも用意する（allowFreeText を true にする）。",
  "同じ事項を 2 問にしない。すでに答えの出ている事項は挙げない。",
  "同じことを聞く事項は 1 問にまとめ、残りの事項の ID を「一緒に閉じる事項」（alsoCloses）に入れる。1 つの答えで、その問いの事項と一緒に閉じる事項をまとめて閉じる。",
  "依頼文にすでに書かれていて決まっている事項は、聞かずに「依頼文で閉じる事項」（closedBySource）に入れる。引用（quote）は依頼文からそのまま写し、決まっている中身（value）を書く。",
  "依頼文から**逐語で引用できない**事項は、「依頼文で閉じる事項」（closedBySource）に含めない。引用は依頼文の一部をそのまま写す——言い換えない・空白や改行を足さない（逐語でない引用はコードが断る）。",
  "コードの**許可の表**（観点ごとの既定）に当てはまる事項だけは、P4 に渡す前に**コードが既定で閉じる**。ここには入れず、問いにもしない。",
];

/** P4 の JSON Schema（構造化出力） */
export const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions", "closedBySource"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "openIssueId", "text", "choices", "recommended", "allowFreeText", "alsoCloses"],
        properties: {
          id: { type: "string", description: "質問の識別子" },
          openIssueId: { type: "string", description: "この問いが対応する未解決の事項の ID" },
          alsoCloses: {
            type: "array",
            description: "この問いの答えで一緒に閉じる、同じことを聞く事項の ID（無ければ空の配列）",
            items: { type: "string" },
          },
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
    closedBySource: {
      type: "array",
      description: "依頼文にすでに書かれていて決まっている事項（聞かずに閉じる。無ければ空の配列）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issueId", "quote", "value"],
        properties: {
          issueId: { type: "string", description: "閉じる未解決の事項の ID" },
          quote: { type: "string", description: "依頼文からの引用（そのまま写す）" },
          value: { type: "string", description: "依頼文で決まっている中身" },
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
 *
 * `alsoCloses`（同じ答えで一緒に閉じる事項の ID）も**任意の欄**である——質問を作るほかの箇所と試験の
 * 型を壊さないためである。無いときは空の配列として扱う（`alsoClosesOf`）。
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
  /** この問いの答えで**一緒に閉じる**、同じことを聞く事項の ID（無いときは空の配列） */
  readonly alsoCloses?: readonly string[];
}

/** 問いの「一緒に閉じる事項」（無いときは空の配列） */
export function alsoClosesOf(question: PlanQuestion): readonly string[] {
  return question.alsoCloses ?? [];
}

/**
 * 質問の ID を組み直す（`Q<版>-<n>`。`n` は 1 始まり。Issue #405）。LLM が付けた ID は**仕様の ID に
 * しない**——応答の中の整合の検査にだけ使い、答える役へ渡す前にコードがこの形へ組み直す。
 */
export function questionIdForRevision(revision: number, index: number): string {
  return `Q${revision}-${index + 1}`;
}

/**
 * 通常の質問の並びの ID を、コードが組み直す（`Q<版>-<n>`。並びの順に `n` を 1 から振る。Issue #405）。
 * 前の往復から持ち越した矛盾の再質問は、すでに答えの ID から組んであるので、この関数に通さない
 * （`runPlan` が、生成した通常の問いにだけ通す。`n` に数えない）。
 */
export function assignQuestionIds(
  questions: readonly PlanQuestion[],
  revision: number,
): readonly PlanQuestion[] {
  return questions.map((question, index) => ({ ...question, id: questionIdForRevision(revision, index) }));
}

/**
 * 依頼文で決まっている事項 1 つ（P4 の応答。04 §3 P4）。依頼文からの引用（`quote`）と、決まっている
 * 中身（`value`）を持つ。引用は**依頼文にそのまま含まれる**ことをコードが確かめる。
 */
export interface PlanSourceClosure {
  /** 閉じる未解決の事項の ID */
  readonly issueId: string;
  /** 依頼文からの引用（そのまま） */
  readonly quote: string;
  /** 依頼文で決まっている中身 */
  readonly value: string;
}

/** P4 の応答（問いの束と、依頼文で閉じた事項。04 §3 P4） */
export interface PlanQuestionsOutput {
  readonly questions: readonly PlanQuestion[];
  readonly closedBySource: readonly PlanSourceClosure[];
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
  /** 一緒に閉じる事項の一覧（`alsoCloses`）の誤り（無い事項・閉じた事項・重なり・主の ID の再掲） */
  "also-closes",
  /** 依頼文で閉じる事項の一覧（`closedBySource`）の誤り */
  "source-closure",
  /**
   * 依頼文で閉じる事項の引用が、**依頼文にそのまま（逐語で）含まれていない**（Issue #408）。
   * 逐語の門は変えない——今までどおり形の誤りとして断る。診断だけを分ける。
   */
  "source-closure-quote",
  /**
   * 依頼文で閉じる事項の引用が、**空白と改行の違いだけ**で依頼文に含まれる（Issue #408）。
   * やはり逐語では受理しない（形の誤り）。診断だけを分ける。
   */
  "source-closure-quote-whitespace",
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

/** 問いの「一緒に閉じる事項」（`alsoCloses`）の並びを確かめる。無いときは空の配列である */
function checkAlsoCloses(value: unknown, field: string, problems: Problem[]): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push({ field, message: "一緒に閉じる事項の一覧（array）であること" });
    return undefined;
  }
  const ids: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      problems.push({ field: `${field}[${index}]`, message: "一緒に閉じる事項の ID は空でない文字列であること" });
      return;
    }
    ids.push(entry);
  });
  return ids;
}

/**
 * 空白と改行を除いた形（空白の差だけの引用を見分ける。Issue #408）。**引用そのものの受理の条件は
 * 変えない**——逐語でない引用は、今までどおり形の誤りとして断る。診断だけを分ける。
 */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 依頼文から逐語で引用できなかった引用の分類（診断だけ。Issue #408）。**空白を除いた引用が空なら、
 * 空白差の一致にしない**（空白だけの引用は `source-closure-quote`）。**問題に引用の値は入れない**。
 */
function quoteProblemCode(source: string, quote: string): QuestionProblemCode {
  const stripped = withoutWhitespace(quote);
  if (stripped !== "" && withoutWhitespace(source).includes(stripped)) {
    return "source-closure-quote-whitespace";
  }
  return "source-closure-quote";
}

/**
 * 「依頼文で決める事項」（`closedBySource`）の並びを確かめる。`source` は依頼文（原文）である。
 * 引用は空でなく、**依頼文にそのまま含まれる**こと（含まれなければ形の誤りとしてやり直させる）。
 * 逐語でない引用は、置き換えの違い（`source-closure-quote`）と、空白の差だけの違い
 * （`source-closure-quote-whitespace`）に分けて診断するが、**どちらも受理しない**（Issue #408）。
 */
function checkClosedBySource(
  value: unknown,
  source: string,
  problems: Problem[],
): readonly PlanSourceClosure[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push({ field: "closedBySource", message: "依頼文で閉じる事項の一覧（array）であること" });
    return undefined;
  }
  const closures: PlanSourceClosure[] = [];
  value.forEach((item, index) => {
    const field = `closedBySource[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "依頼文で閉じる事項は写像（object）であること" });
      return;
    }
    const issueId = item["issueId"];
    const quote = item["quote"];
    const content = item["value"];
    let good = true;
    if (typeof issueId !== "string" || issueId === "") {
      problems.push({ field: `${field}.issueId`, message: "事項の ID は空でない文字列であること" });
      good = false;
    }
    if (typeof quote !== "string" || quote === "") {
      // 空・型違いは今までどおり `shape`
      problems.push({ field: `${field}.quote`, code: "shape", message: "引用は空でない文字列であること" });
      good = false;
    } else if (!source.includes(quote)) {
      // 逐語でない引用の分類（診断だけ）。問題に引用の値は入れない
      problems.push({
        field: `${field}.quote`,
        code: quoteProblemCode(source, quote),
        message: "引用が依頼文にそのまま（逐語で）含まれていない",
      });
      good = false;
    }
    if (typeof content !== "string" || content === "") {
      problems.push({ field: `${field}.value`, message: "決めた中身は空でない文字列であること" });
      good = false;
    }
    if (good) closures.push({ issueId: issueId as string, quote: quote as string, value: content as string });
  });
  return closures;
}

/**
 * P4 の応答の形を確かめる。`revision` は、この問いを組み立てた仕様の版である（LLM には書かせず、コードが
 * 付ける）。`recommended` と `allowFreeText` は、無ければ形では断らない（意味の検査 `checkQuestionSet` が
 * 断る）。`alsoCloses` は無ければ空の配列にする。依頼文で閉じる事項（`closedBySource`）の引用は、依頼文に
 * そのまま含まれることを確かめる。
 */
export function checkQuestionsOutput(
  output: unknown,
  revision: number,
  source: string,
): ShapeCheck<PlanQuestionsOutput> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", code: "shape", message: "応答は写像（object）であること" }] };
  }
  const raw = output["questions"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "questions", code: "shape", message: "質問の並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const questions: PlanQuestion[] = [];
  const seenIds = new Set<string>();
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
    } else if (seenIds.has(id)) {
      // 1 つの応答の中で質問 ID が重なるのは**形の誤り**である（1 回やり直し、2 回続けば malformed。
      // 分類は `duplicate-question-id`。Issue #405）
      problems.push({ field: `${field}.id`, code: "duplicate-question-id", message: "質問 ID が重複している" });
      good = false;
    } else {
      seenIds.add(id);
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
    const alsoCloses = checkAlsoCloses(item["alsoCloses"], `${field}.alsoCloses`, problems);
    if (alsoCloses === undefined) good = false;
    if (good) {
      questions.push({
        id: id as string,
        openIssueId: openIssueId as string,
        revision,
        text: text as string,
        choices,
        ...(recommended === undefined ? {} : { recommended }),
        ...(allowFreeText === undefined ? {} : { allowFreeText }),
        alsoCloses: alsoCloses ?? [],
      });
    }
  });
  const closedBySource = checkClosedBySource(output["closedBySource"], source, problems);
  if (problems.length > 0) {
    return { ok: false, problems: problems.map((problem) => ({ ...problem, code: problem.code ?? "shape" })) };
  }
  return { ok: true, value: { questions, closedBySource: closedBySource ?? [] } };
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
  const issueToIndex = new Map<string, number>();

  questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    if (question.id === "") report("shape", `${path}.id`, "質問 ID が空である");
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

/**
 * 問いと、一緒に閉じる事項（`alsoCloses`）・依頼文で閉じる事項（`closedBySource`）の**つながり**を
 * コードで確かめる（04 §3 P4）。**切り捨ての前に**呼ぶ——切り捨てで問いが落ちると、重なりを見落とす。
 *
 * 形の誤りにするもの：一覧に、無い事項・すでに閉じた（依頼文で閉じる）事項の ID がある／同じ一覧の中で
 * 重なる／主の ID を一緒に閉じる一覧に再び書く／1 つの事項が、2 つの問い・一緒に閉じる一覧・依頼文で
 * 閉じる一覧のうち 2 か所以上に出る。
 */
export function checkQuestionLinks(
  openIssueIds: readonly string[],
  questions: readonly PlanQuestion[],
  closedBySource: readonly PlanSourceClosure[] = [],
): readonly QuestionProblem[] {
  const problems: QuestionProblem[] = [];
  const report = (code: QuestionProblemCode, path: string, message: string): void => {
    problems.push({ code, path, message });
  };

  const openSet = new Set(openIssueIds);
  const closedBySourceIds = new Set<string>();
  closedBySource.forEach((closure, index) => {
    const path = `closedBySource[${index}]`;
    if (!openSet.has(closure.issueId)) {
      report("source-closure", `${path}.issueId`, `${closure.issueId}: 未解決の事項に無い`);
    }
    if (closedBySourceIds.has(closure.issueId)) {
      report("source-closure", `${path}.issueId`, `事項 ${closure.issueId} が依頼文で閉じる一覧に重なっている`);
    }
    closedBySourceIds.add(closure.issueId);
  });

  questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    if (!openSet.has(question.openIssueId)) {
      report("issue-mapping", `${path}.openIssueId`, `${question.openIssueId}: 未解決の事項に無い`);
    }
    const seen = new Set<string>();
    alsoClosesOf(question).forEach((id, alsoIndex) => {
      const idPath = `${path}.alsoCloses[${alsoIndex}]`;
      if (!openSet.has(id)) {
        report("issue-mapping", idPath, `${id}: 未解決の事項に無い`);
      }
      if (closedBySourceIds.has(id)) {
        report("also-closes", idPath, `${id}: 依頼文で閉じる事項と同じである`);
      }
      if (id === question.openIssueId) {
        report("also-closes", idPath, `${id}: 主の事項を一緒に閉じる一覧に書き直している`);
      }
      if (seen.has(id)) {
        report("also-closes", idPath, `事項 ${id} が一緒に閉じる一覧の中で重なっている`);
      }
      seen.add(id);
    });
  });

  // 1 つの事項が、2 つの問い・一緒に閉じる一覧・依頼文で閉じる一覧のうち 2 か所以上に出ていないか
  const placement = new Map<string, number>();
  const place = (id: string): void => {
    placement.set(id, (placement.get(id) ?? 0) + 1);
  };
  for (const closure of closedBySource) place(closure.issueId);
  for (const question of questions) {
    place(question.openIssueId);
    for (const id of alsoClosesOf(question)) place(id);
  }
  for (const [id, count] of placement) {
    if (count >= 2) report("duplicate-issue", "questions", `事項 ${id} が 2 か所以上に出ている（${count} か所）`);
  }

  return problems;
}

/**
 * 開いている事項だけを、**重大なものを先に並べて**返す（04 §3 P4）。答えの出た事項（`status` が `open`
 * でないもの）は落とす——P4 は開いている事項についてだけ聞く。並び順が、LLM に渡すデータの見え方を
 * 決める。
 */
export function openIssuesForQuestions(openIssues: readonly PlanOpenIssue[]): readonly PlanOpenIssue[] {
  const open = openIssues.filter((issue) => issue.status === "open");
  return [...open.filter((issue) => issue.critical), ...open.filter((issue) => !issue.critical)];
}

/**
 * 残りの問数に照らして、**開いている重大な事項がすべて聞かれている**かを確かめる（04 §3 P4）。
 *
 * 重大な事項は、**問い・一緒に閉じる事項（`alsoCloses`）・依頼文で閉じる事項（`closedBySource`）**の
 * どれかで閉じていれば、取りこぼしにしない。残りの問数が足りるのに、ある重大な事項を閉じる問いが
 * 無ければ、形の誤りとして返す——`runQuestions` はこれを形の検査に混ぜるので、応答は 1 回だけやり直され、
 * それでも足りなければ段の失敗になる。開いている事項がすべて依頼文で閉じているなら、問いが 0 問でもよい。
 * 残りの問数が足りない（重大な事項のほうが多い）ときは、聞けるぶんだけ聞くので、ここでは何も言わない。
 */
export function checkQuestionCoverage(
  openIssues: readonly PlanOpenIssue[],
  remaining: number,
  questions: readonly PlanQuestion[],
  closedBySource: readonly PlanSourceClosure[] = [],
): readonly Problem[] {
  const problems: Problem[] = [];
  const open = openIssues.filter((issue) => issue.status === "open");
  if (open.length === 0 || remaining <= 0) return problems;

  const closedBySourceIds = new Set(closedBySource.map((closure) => closure.issueId));
  const closed = new Set<string>();
  for (const question of questions) {
    closed.add(question.openIssueId);
    for (const id of alsoClosesOf(question)) closed.add(id);
  }
  const isClosed = (id: string): boolean => closed.has(id) || closedBySourceIds.has(id);

  // 開いている事項がすべて（問いか依頼文で）閉じているなら、問いが 0 問でもよい
  if (open.every((issue) => isClosed(issue.id))) return problems;
  if (questions.length === 0) {
    problems.push({ field: "questions", code: "question-coverage", message: "開いている事項があるのに問いが 0 問である" });
    return problems;
  }
  const critical = open.filter((issue) => issue.critical);
  if (critical.length > remaining) return problems;
  for (const issue of critical) {
    if (!isClosed(issue.id)) {
      problems.push({
        field: "questions",
        code: "question-coverage",
        message: `重大な事項 ${issue.id} への問いが無い（残りの問数 ${remaining} に重大な事項 ${critical.length} 件が収まる）`,
      });
    }
  }
  return problems;
}

/**
 * 問いが残りの問数を超えていれば、**重大なものを残して**切る（04 §3 P4）。重大な事項に対応する問いを
 * 先に、次に重大でない事項の問いを残し、残りの問数まで取る。`openIssues` は開いている事項である。
 *
 * 重大かどうかは、**主の事項と一緒に閉じる事項（`alsoCloses`）の両方**で見る——主が重大でなくても、
 * 一緒に閉じる一覧に重大な事項があれば、その問いは重大なものとして残す。
 */
export function trimQuestionsToRemaining(
  questions: readonly PlanQuestion[],
  openIssues: readonly PlanOpenIssue[],
  remaining: number,
): readonly PlanQuestion[] {
  if (questions.length <= remaining) return questions;
  const criticalIds = new Set(openIssues.filter((issue) => issue.critical).map((issue) => issue.id));
  const isCritical = (question: PlanQuestion): boolean =>
    criticalIds.has(question.openIssueId) || alsoClosesOf(question).some((id) => criticalIds.has(id));
  const criticalQuestions = questions.filter(isCritical);
  const otherQuestions = questions.filter((question) => !isCritical(question));
  return [...criticalQuestions, ...otherQuestions].slice(0, remaining);
}

/** P4 が受け取るもの */
export interface QuestionsInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 未解決の事項（いま開いているもの）。答えの出た事項は含めない */
  readonly openIssues: readonly PlanOpenIssue[];
  /** 残りの問数（あと何問聞けるか。往復をまたいで数えた残り） */
  readonly remaining: number;
  /** 質問を組み立てた仕様の版 */
  readonly revision: number;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/**
 * P4 を 1 回呼ぶ。データは依頼文・**残りの問数**・**開いている事項**（重大なものを先）だけである。
 *
 * 形の検査には、**切り捨ての前の**つながりの検査（`checkQuestionLinks`）と、**残りの問数に照らした
 * 覆いの検査**（`checkQuestionCoverage`）を混ぜる——重なりや、足りるのに欠けた重大な事項があれば、
 * 1 回だけやり直す。問いが残りの問数を超えていれば、重大なものを残して切る
 * （`trimQuestionsToRemaining`）。そのうえで意味の検査（`checkQuestionSet`）に合わなければ `unmet` で断る。
 */
export async function runQuestions(input: QuestionsInput): Promise<StageOutcome<PlanQuestionsOutput>> {
  const openIssues = openIssuesForQuestions(input.openIssues);
  const openIssueIds = openIssues.map((issue) => issue.id);
  const request = buildStructuredRequest({
    rules: QUESTIONS_RULES,
    documents: input.documents,
    data: [
      { name: "依頼文", text: input.source },
      { name: "残りの問数", text: String(input.remaining) },
      { name: "未解決の事項", text: serializeJson(openIssues) },
    ],
    schemaName: QUESTIONS_SCHEMA_NAME,
    schema: QUESTIONS_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("questions"),
  });
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) => {
      const shape = checkQuestionsOutput(output, input.revision, input.source);
      if (!shape.ok) return shape;
      const links = checkQuestionLinks(openIssueIds, shape.value.questions, shape.value.closedBySource);
      if (links.length > 0) {
        return {
          ok: false,
          problems: links.map((problem) => ({
            field: problem.path,
            code: problem.code,
            message: `${problem.code}: ${problem.message}`,
          })),
        };
      }
      const coverage = checkQuestionCoverage(
        openIssues,
        input.remaining,
        shape.value.questions,
        shape.value.closedBySource,
      );
      if (coverage.length > 0) return { ok: false, problems: coverage };
      return {
        ok: true,
        value: {
          questions: trimQuestionsToRemaining(shape.value.questions, openIssues, input.remaining),
          closedBySource: shape.value.closedBySource,
        },
      };
    },
  });
  if (!answer.ok) return answer;
  const problems = checkQuestionSet(
    openIssueIds,
    answer.value.questions,
  );
  if (problems.length > 0) {
    return {
      ok: false,
      failure: {
        kind: "unmet",
        attempts: 1,
        problems: problems.map((problem) => ({
          field: problem.path,
          code: problem.code,
          message: `${problem.code}: ${problem.message}`,
        })),
      },
    };
  }
  return answer;
}
