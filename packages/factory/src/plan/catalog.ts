// P3 洗い出す——**語彙の決めどころの目録**（04-plan-agent.md §3 P3・05-judge-model.md §3・E4）。
//
// 要件ごとに「語彙の決めどころ」を **Noul**（はい／いいえの確率）で一度に聞く（扇形）。問いは同じ
// state に対して互いに独立に評価されるので、要件 × 観点をまとめて 1 回の呼び出しで聞ける（05 §1）。
//
// 問いは要件 × 観点ごとに 2 つにする（Issue #366）。**先に「当てはまるか」**（この観点がこの要件に
// 関係するか）を聞き、**次に「決まっているか」**（依頼か答えで指定されているか）を聞く。未解決の事項
// （質問の候補）にするのは、**当てはまる確率が閾値以上で、かつ決まっている確率が閾値未満の観点だけ**
// である——数えることの無い要件（登録するだけの要件など）に、どの状態のものを数えるか、を付けないため。
// 目録に無い曖昧さは LLM（surface.ts）が挙げる。
//
// 「決まっているか」を yes とする——Noul の値が高いほど「依頼や答えで指定されている」。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";

/** 目録の 1 観点（04 §3 P3 の「集計の種類・期間・今月を含むか・数える状態・整数か・絞り込みの組み合わせ・0 件を含むか・直せる人」） */
export interface CatalogFacet {
  /** 観点の ID（問いの名前と未解決の事項の ID に使う） */
  readonly id: string;
  /** 利用者の言葉で書いた観点（宣言の用語を使わない。04 §3） */
  readonly question: string;
  /** 指定されていないまま残ると**重大**か（答えで作るものが変わるか。04 §3 P3） */
  readonly critical: boolean;
}

/**
 * 語彙の決めどころの目録（04 §3 P3）。観点の文は利用者の言葉で書く（entity・computed などの宣言の
 * 用語を使わない）。`critical` は、指定されないまま残ると**作るものが変わる**観点に立てる。
 */
export const CATALOG_FACETS: readonly CatalogFacet[] = [
  { id: "aggregation", question: "何を数え、どう出すか（数える・合計する・平均するなど）", critical: true },
  { id: "period", question: "対象にする期間（いつからいつまでか）", critical: false },
  { id: "current-period", question: "今の期間（今月など）を含むかどうか", critical: false },
  { id: "counted-state", question: "どの状態のものを数えるか", critical: true },
  { id: "integer", question: "値が整数か、小数を許すか", critical: false },
  { id: "filter-combination", question: "複数の絞り込みを組み合わせたときにどう絞るか", critical: false },
  { id: "include-zero", question: "0 件のときも表示するかどうか", critical: false },
  { id: "editable-by", question: "誰が直せるか", critical: false },
];

/** 目録に照らす要件（ID と文だけでよい。要件の一覧から作る） */
export interface CatalogRequirement {
  readonly id: string;
  readonly text: string;
}

/** 目録の「決まっているか」の問いの名前の頭（問いの名前は `catalog:要件 ID:観点 ID`） */
export const CATALOG_QUESTION_PREFIX = "catalog";

/** 目録の「決まっているか」の問いの名前（要件 ID と観点 ID で決まる） */
export function catalogQuestionName(requirementId: string, facetId: string): string {
  return `${CATALOG_QUESTION_PREFIX}:${requirementId}:${facetId}`;
}

/** 目録の「当てはまるか」の問いの名前の頭（問いの名前は `catalog-applies:要件 ID:観点 ID`） */
export const CATALOG_APPLIES_QUESTION_PREFIX = "catalog-applies";

/** 目録の「当てはまるか」の問いの名前（要件 ID と観点 ID で決まる。「決まっているか」と別の頭にする） */
export function catalogAppliesQuestionName(requirementId: string, facetId: string): string {
  return `${CATALOG_APPLIES_QUESTION_PREFIX}:${requirementId}:${facetId}`;
}

/** 未指定だった観点 1 つ（質問の候補。04 §3 P3） */
export interface UnspecifiedFacet {
  readonly requirementId: string;
  /** 対象の要件の文（未解決の事項の文に入れる） */
  readonly requirementText: string;
  readonly facetId: string;
  /** 利用者の言葉の観点の文 */
  readonly question: string;
  readonly critical: boolean;
  /** 「決まっている」の確率（Noul の値） */
  readonly specified: number;
}

/** 判定の記録の種類（「当てはまる」か「決まっている」か） */
export type CatalogJudgmentKind = "applies" | "specified";

/** 判定 1 件の記録（納品物へ残す。依頼文の全文は残さない。05 §4・U-J3） */
export interface CatalogJudgment {
  readonly questionId: string;
  /** どちらの問いの記録か（「当てはまる」か「決まっている」か） */
  readonly kind: CatalogJudgmentKind;
  /** 問いの確率（Noul の値） */
  readonly value: number;
  readonly model: string;
  readonly answeredBy: string;
}

/** 目録の判定の結果 */
export interface CatalogResult {
  /** 指定されていない観点（当てはまるかつ閾値より低いものだけ）。要件の順・観点の順に並ぶ */
  readonly unspecified: readonly UnspecifiedFacet[];
  readonly judgments: readonly CatalogJudgment[];
}

/** 目録の判定が受け取るもの */
export interface CatalogInput {
  /** 目録に照らす要件（ID と文） */
  readonly requirements: readonly CatalogRequirement[];
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /** 「決まっている」と見なす確率の閾値（これ**未満**は未指定） */
  readonly threshold: number;
}

/** Noul の答えから値を取り出す（答えが無い・種類が違うときは 0） */
function noulValue(answer: JudgeAnswer | undefined): number {
  return answer !== undefined && answer.kind === "noul" ? answer.noul : 0;
}

/** 1 つの要件 × 観点の判定の対象 */
interface CatalogTarget {
  readonly requirementId: string;
  readonly requirementText: string;
  readonly facet: CatalogFacet;
}

/**
 * 語彙の決めどころの目録を、要件ごとに Noul で一度に聞く（04 §3 P3・05 §3・E4・Issue #366）。
 * 要件 × 観点ごとに「当てはまるか」と「決まっているか」の 2 つを同じ 1 回の呼び出しで聞く。
 * **当てはまる確率が閾値以上で、かつ決まっている確率が閾値未満の観点だけ**を `unspecified` にする。
 * 要件が 1 つも無ければ判定を呼ばない。
 */
export async function runCatalog(input: CatalogInput): Promise<CatalogResult> {
  const questions: Record<string, JudgeQuestion> = {};
  const targets: CatalogTarget[] = [];
  for (const requirement of input.requirements) {
    for (const facet of CATALOG_FACETS) {
      questions[catalogAppliesQuestionName(requirement.id, facet.id)] = {
        kind: "noul",
        instructions: `対象の要件について、次の点が当てはまる（その要件に関係する）かを yes／no で答える。点: ${facet.question}`,
        criteria: { yes: "当てはまる（関係する）", no: "当てはまらない（関係しない）" },
      };
      questions[catalogQuestionName(requirement.id, facet.id)] = {
        kind: "noul",
        instructions: `対象の要件について、次の点が決まっている（依頼か答えで指定されている）かを yes／no で答える。点: ${facet.question}`,
        criteria: { yes: "決まっている（指定されている）", no: "決まっていない（指定されていない）" },
      };
      targets.push({ requirementId: requirement.id, requirementText: requirement.text, facet });
    }
  }
  if (targets.length === 0) return { unspecified: [], judgments: [] };

  const state = {
    requirements: input.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
  };
  const response = await input.judge.judge({ state, questions });

  const unspecified: UnspecifiedFacet[] = [];
  const judgments: CatalogJudgment[] = [];
  for (const target of targets) {
    const appliesName = catalogAppliesQuestionName(target.requirementId, target.facet.id);
    const specifiedName = catalogQuestionName(target.requirementId, target.facet.id);
    const applies = noulValue(response.answers[appliesName]);
    const specified = noulValue(response.answers[specifiedName]);
    judgments.push({
      questionId: appliesName,
      kind: "applies",
      value: applies,
      model: response.model,
      answeredBy: response.answeredBy,
    });
    judgments.push({
      questionId: specifiedName,
      kind: "specified",
      value: specified,
      model: response.model,
      answeredBy: response.answeredBy,
    });
    // 当てはまらない観点は、決まっていなくても未解決の事項にしない（Issue #366）
    if (applies >= input.threshold && specified < input.threshold) {
      unspecified.push({
        requirementId: target.requirementId,
        requirementText: target.requirementText,
        facetId: target.facet.id,
        question: target.facet.question,
        critical: target.facet.critical,
        specified,
      });
    }
  }
  return { unspecified, judgments };
}

/**
 * 未指定の観点を、未解決の事項（`open_issues` の 1 件）に写す（04 §4）。ID は問いの名前から作る。
 * 文には、対象の要件の ID と文を先に置き、観点の文を続ける（Issue #366）。
 * `resolution` は付けない（まだ閉じていない）。
 */
export function catalogOpenIssue(facet: UnspecifiedFacet): {
  readonly id: string;
  readonly text: string;
  readonly critical: boolean;
  readonly status: "open";
} {
  return {
    id: `OI:${catalogQuestionName(facet.requirementId, facet.facetId)}`,
    text: `要件 ${facet.requirementId}「${facet.requirementText}」について：${facet.question}`,
    critical: facet.critical,
    status: "open",
  };
}
