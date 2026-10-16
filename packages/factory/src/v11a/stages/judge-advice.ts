// J4 Jev の助言（表の要件への当てはまり。07-architecture-v1.1a.md §6・D5・追加判断 A。Issue #507）。
//
// 要件ごとに 1 つの判定の要求（`JudgeRequest`）を作り、その要件の所属の行ごとに Noul の問い「この要件を満たす
// のに、この対象は必要か」を聞く。値で線を引く（閾値は `JUDGE_ADVICE_THRESHOLDS` の 1 か所）：
//
//   - 値 < 0.2 → `suspect-unnecessary`（不要の疑い）
//   - 0.2 ≤ 値 < 0.8 → `unclear`（不明）
//   - 0.8 ≤ 値 → 印なし
//
// 値の印とは**別の欄**に 2 つを持つ：答えた adapter が `llm` なら `llmUnknownConfidence`（値は使わない。判定の口の
// Noul には確信度が無い）、答えの欠落・例外・門の拒否（予算・締切・回数の包みの誤り）なら `undetermined`。
//
// **助言であって門ではない**（D5）。印は T1 の 2 回目のデータと記録にだけ効き、持ち越し・合否・T1'' の判定を
// 変えない。だから**例外を外へ投げない・走りを止めない**——判定の口が投げたものは、その要件の問い全部を
// `undetermined` にして次の要件へ進む。state には要件の文と引用と、その要件の所属の行（`id`・`role`・`kind`・
// `type`）だけを入れる。**名前（`name`）は入れない。** 欠けた対象は問えない（在る行しか聞けない。§6）。
//
// 戻り値は記録用（問いの ID・値・adapter・版・閾値。`05-judge-model.md` §8 U-J3）。`judge-advice.json` に載せる
// のは A5 の仕事である。
import { JudgeBudgetExceededError, JudgeCallLimitExceededError, JudgeDeadlineExceededError } from "../../judge-budget.js";
import { judgeGateRefusalKindOf, type Judge, type JudgeNoulQuestion, type JudgeSource } from "../../judge.js";
import type { RequirementList } from "../../pipeline.js";
import type { NameTable, NameTableRow } from "../names.js";

/** J4 の閾値（ここ 1 か所。境界は「未満」で切る） */
export const JUDGE_ADVICE_THRESHOLDS = {
  /** 値がこれ未満なら「不要の疑い」 */
  suspectBelow: 0.2,
  /** 値がこれ以上なら印なし（あいだは「不明」） */
  clearAtOrAbove: 0.8,
} as const;

/** 問いの英語の文（Jev は問いの名前を読まないので、対象は `instructions` に載せる） */
export const JUDGE_ADVICE_QUESTION_TEXT =
  "Is `target` needed in order to satisfy `requirement` (its `text` and `quote`)?";

/** 値の印（印なしは null） */
export type JudgeAdviceValueMark = "suspect-unnecessary" | "unclear";

/** 未判定の理由（答えの欠落・判定の口の例外・門の拒否） */
export type JudgeAdviceUndetermined = "missing" | "error" | "gate";

/** 問い 1 つの記録（3 つの印は別の欄） */
export interface JudgeAdviceQuestionRecord {
  readonly questionId: string;
  readonly requirementId: string;
  /** 所属の行の `id` */
  readonly id: string;
  /** Noul の値（答えが無い・未判定は null。`llm` が答えたときも値は残すが印には使わない） */
  readonly value: number | null;
  /** 値の印（`llm` が答えたとき・未判定のときは null） */
  readonly mark: JudgeAdviceValueMark | null;
  /** 答えた adapter が `llm`（確信度不明）か */
  readonly llmUnknownConfidence: boolean;
  /** 未判定の理由（判定できたら null） */
  readonly undetermined: JudgeAdviceUndetermined | null;
}

/** 要件 1 つの要求の記録 */
export interface JudgeAdviceRequestRecord {
  readonly requirementId: string;
  /** 答えた adapter（例外・門の拒否のときは null） */
  readonly adapter: JudgeSource | null;
  /** 答えたモデルの版の ID（例外・門の拒否のときは null） */
  readonly model: string | null;
  readonly questions: readonly JudgeAdviceQuestionRecord[];
}

/** J4 の記録（`judge-advice.json` の中身） */
export interface JudgeAdviceRecord {
  readonly thresholds: typeof JUDGE_ADVICE_THRESHOLDS;
  readonly requests: readonly JudgeAdviceRequestRecord[];
}

/** T1・T1'' のデータに渡す印 1 つ（印なしは入れない） */
export interface JudgeAdviceMarkEntry {
  readonly requirementId: string;
  readonly id: string;
  readonly mark: JudgeAdviceValueMark | "llm-unknown-confidence" | "undetermined";
}

/** J4 が受け取るもの */
export interface JudgeAdviceInput {
  readonly list: RequirementList;
  readonly table: NameTable;
  /** 判定の口（包み `createBudgetedJudge` を通したもの。試験は偽物） */
  readonly judge: Judge;
}

/** 問いの名前（要件 ID と行の `id` から決まる） */
export function judgeAdviceQuestionId(requirementId: string, id: string): string {
  return `need:${requirementId}:${id}`;
}

/** 値から印を決める（境界は `JUDGE_ADVICE_THRESHOLDS`） */
export function judgeAdviceMarkOf(value: number): JudgeAdviceValueMark | null {
  if (value < JUDGE_ADVICE_THRESHOLDS.suspectBelow) return "suspect-unnecessary";
  if (value < JUDGE_ADVICE_THRESHOLDS.clearAtOrAbove) return "unclear";
  return null;
}

/** 門・予算・締切・回数の包みの誤りか */
function isGateError(error: unknown): boolean {
  return (
    error instanceof JudgeBudgetExceededError ||
    error instanceof JudgeDeadlineExceededError ||
    error instanceof JudgeCallLimitExceededError ||
    judgeGateRefusalKindOf(error) !== undefined
  );
}

/** 行の、state に入れる形（名前を入れない） */
const stateRowOf = (row: NameTableRow) => ({ id: row.id, role: row.role, kind: row.kind, type: row.type });

/**
 * J4 を回す。T1 の確かめ方が `unresolved` の要件と、所属の行が無い要件は聞かない（T1'' の対象の外・問えない）。
 * 要件ごとに要求 1 回、問いは所属の行の数。**例外を外へ投げない。**
 */
export async function runJudgeAdvice(input: JudgeAdviceInput): Promise<JudgeAdviceRecord> {
  const rowById = new Map(input.table.rows.map((row) => [row.id, row] as const));
  const verificationById = new Map(input.table.verification.map((entry) => [entry.requirementId, entry] as const));
  const ownershipById = new Map(input.table.ownership.map((entry) => [entry.requirementId, entry] as const));
  const requests: JudgeAdviceRequestRecord[] = [];
  for (const requirement of input.list.requirements) {
    if (verificationById.get(requirement.id)?.kind === "unresolved") continue;
    const rows = (ownershipById.get(requirement.id)?.roles ?? []).flatMap((role) => {
      const row = rowById.get(role.id);
      return row === undefined ? [] : [row];
    });
    if (rows.length === 0) continue;
    const questions: Record<string, JudgeNoulQuestion> = {};
    for (const row of rows) {
      questions[judgeAdviceQuestionId(requirement.id, row.id)] = {
        kind: "noul",
        instructions: { target: stateRowOf(row), question: JUDGE_ADVICE_QUESTION_TEXT },
        criteria: { yes: "必要", no: "不要" },
      };
    }
    const state = {
      requirement: { text: requirement.text, quote: requirement.quote },
      rows: rows.map(stateRowOf),
    };
    const undeterminedAll = (cause: JudgeAdviceUndetermined): JudgeAdviceRequestRecord => ({
      requirementId: requirement.id,
      adapter: null,
      model: null,
      questions: rows.map((row) => ({
        questionId: judgeAdviceQuestionId(requirement.id, row.id),
        requirementId: requirement.id,
        id: row.id,
        value: null,
        mark: null,
        llmUnknownConfidence: false,
        undetermined: cause,
      })),
    });
    let response;
    try {
      response = await input.judge.judge({ state, questions });
    } catch (error) {
      requests.push(undeterminedAll(isGateError(error) ? "gate" : "error"));
      continue;
    }
    const llm = response.answeredBy === "llm";
    requests.push({
      requirementId: requirement.id,
      adapter: response.answeredBy,
      model: response.model,
      questions: rows.map((row) => {
        const questionId = judgeAdviceQuestionId(requirement.id, row.id);
        const answer = response.answers?.[questionId];
        const value =
          answer !== undefined && answer.kind === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
        return {
          questionId,
          requirementId: requirement.id,
          id: row.id,
          value,
          mark: value === null || llm ? null : judgeAdviceMarkOf(value),
          llmUnknownConfidence: value !== null && llm,
          undetermined: value === null ? "missing" : null,
        };
      }),
    });
  }
  return { thresholds: JUDGE_ADVICE_THRESHOLDS, requests };
}

/** 記録から、T1・T1'' のデータに渡す印を取り出す（印なしは入れない。並びは記録の順） */
export function judgeAdviceMarks(record: JudgeAdviceRecord): readonly JudgeAdviceMarkEntry[] {
  return record.requests.flatMap((request) =>
    request.questions.flatMap((question): JudgeAdviceMarkEntry[] => {
      const base = { requirementId: question.requirementId, id: question.id };
      if (question.undetermined !== null) return [{ ...base, mark: "undetermined" }];
      if (question.llmUnknownConfidence) return [{ ...base, mark: "llm-unknown-confidence" }];
      return question.mark === null ? [] : [{ ...base, mark: question.mark }];
    }),
  );
}
