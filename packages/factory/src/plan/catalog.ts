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
// **集計の門**（Issue #384）。要件ごとに「この要件は、記録を数える・合計する・数字を求める、または
// そうして求めた数字を見せることを含むか」を Noul で 1 つ聞く（問いの名前は `catalog-gate:<要件 ID>`）。
// 門の値が「1 − 閾値」**以下**（はっきり集計を含まない）の要件では、**集計の観点**（集計の仕方・期間・
// 今の期間を含むか・数える状態・0 件を含むか）を未解決の事項にしない。門の値が閾値**以上**なら今まで
// どおり当てはまり・決まっているで決め、その間は門を開けて（今までどおり扱って）取りこぼしを避ける。
// 直せる人は、門の値によらず当てはまりで決める。
//
// 「決まっているか」を yes とする——Noul の値が高いほど「依頼や答えで指定されている」。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";

/** 目録の 1 観点（04 §3 P3 の「集計の種類・期間・今月を含むか・数える状態・0 件を含むか・直せる人」） */
export interface CatalogFacet {
  /** 観点の ID（問いの名前と未解決の事項の ID に使う） */
  readonly id: string;
  /** 利用者の言葉で書いた観点（宣言の用語を使わない。04 §3） */
  readonly question: string;
  /**
   * 判定の口に渡す、観点の**英語の説明**（Issue #376）。利用者に見せる `question`（日本語）はそのまま
   * 残し、問いの `instructions` には、対象の要件の文とともにこちらを載せる。
   */
  readonly point: string;
  /** 指定されていないまま残ると**重大**か（答えで作るものが変わるか。04 §3 P3） */
  readonly critical: boolean;
}

/**
 * 語彙の決めどころの目録（04 §3 P3）。観点の文は利用者の言葉で書く（entity・computed などの宣言の
 * 用語を使わない）。`critical` は、指定されないまま残ると**作るものが変わる**観点に立てる。
 */
export const CATALOG_FACETS: readonly CatalogFacet[] = [
  {
    id: "aggregation",
    question: "何を数え、どう出すか（数える・合計する・平均するなど）",
    point: "what is counted and how it is shown (count records, add up a quantity, average, ...)",
    critical: true,
  },
  {
    id: "period",
    question: "対象にする期間（いつからいつまでか）",
    point: "which time period is covered (from when to when)",
    critical: false,
  },
  {
    id: "current-period",
    question: "今の期間（今月など）を含むかどうか",
    point: "whether the current period (e.g. this month) is included",
    critical: false,
  },
  {
    id: "counted-state",
    question: "どの状態のものを数えるか",
    point: "which states of records are counted (e.g. only meetings that were actually held)",
    critical: true,
  },
  {
    id: "include-zero",
    question: "0 件のときも表示するかどうか",
    point: "whether items with zero results are still shown",
    critical: false,
  },
  {
    id: "editable-by",
    question: "誰が直せるか",
    point: "who may edit or delete the records afterwards",
    critical: false,
  },
];

/**
 * **集計の観点**（Issue #384）の ID（04 §3 P3 の「集計の仕方・期間・今の期間を含むか・数える状態・0 件を
 * 含むか」）。門の値が「1 − 閾値」以下の要件では、これらの観点を未解決の事項にしない。**一覧と `critical`
 * は変えない**——どの観点が門に従うかだけを、ここに別に持つ。
 */
export const CATALOG_AGGREGATION_FACET_IDS: ReadonlySet<string> = new Set([
  "aggregation",
  "period",
  "current-period",
  "counted-state",
  "include-zero",
]);

/** 「当てはまるか」の問いの英語の文（`point` は観点の説明、`requirement` は対象の要件の文。Issue #384） */
export const CATALOG_APPLIES_QUESTION_TEXT =
  "Is `point` relevant to building `requirement`, i.e. would the app behave differently depending on how `point` is decided for this requirement?";

/** 「決まっているか」の問いの英語の文（`source` は state の原文の欄の名前。Issue #384） */
export const CATALOG_SPECIFIED_QUESTION_TEXT =
  "Does `source` or `requirement` already decide `point` for this requirement?";

/** 門の問いの英語の文（`requirement` は対象の要件の文。Issue #384） */
export const CATALOG_GATE_QUESTION_TEXT =
  "Does `requirement` ask the app to count, add up or otherwise compute a figure from records, or to show such a computed figure?";

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

/** 集計の門の問いの名前の頭（問いの名前は `catalog-gate:要件 ID`。Issue #384） */
export const CATALOG_GATE_QUESTION_PREFIX = "catalog-gate";

/** 集計の門の問いの名前（要件 ID で決まる。観点ごとではなく要件ごとに 1 つ） */
export function catalogGateQuestionName(requirementId: string): string {
  return `${CATALOG_GATE_QUESTION_PREFIX}:${requirementId}`;
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

/** 判定の記録の種類（「当てはまる」か「決まっている」か、集計の門か） */
export type CatalogJudgmentKind = "applies" | "specified" | "gate";

/** 判定 1 件の記録（納品物へ残す。依頼文の全文は残さない。05 §4・U-J3） */
export interface CatalogJudgment {
  readonly questionId: string;
  /** どの問いの記録か（「当てはまる」か「決まっている」か、集計の門か） */
  readonly kind: CatalogJudgmentKind;
  /**
   * 問いの確率（Noul の値）。**不明のときは `null`**——答えが無い・Noul でない答え・0〜1 の外の値は、
   * 値 0 と区別して「不明」にする（集計の門。Issue #384）。
   */
  readonly value: number | null;
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
  /**
   * 依頼文（原文。Issue #376）。「決まっているか」は、依頼で指定されているかを見るので、原文を state に
   * 入れて聞く（要件の文だけでは、依頼で決まっているかを判定できないため）。
   */
  readonly source: string;
  /** 「決まっている」と見なす確率の閾値（これ**未満**は未指定） */
  readonly threshold: number;
}

/** Noul の答えから値を取り出す（答えが無い・種類が違うときは 0。「当てはまる」「決まっている」用） */
function noulValue(answer: JudgeAnswer | undefined): number {
  return answer !== undefined && answer.kind === "noul" ? answer.noul : 0;
}

/** 集計の門の値（答えが無い・Noul でない・数でない・0〜1 の外は「不明」） */
type GateValue = { readonly kind: "known"; readonly value: number } | { readonly kind: "unknown" };

/**
 * 集計の門の値を取り出す（Issue #384）。**欠けを 0 にする `noulValue` は門には使わない**——答えが無い・
 * Noul でない答え・数でない値・0〜1 の外の値は、値 0 と区別して「不明」にする。不明のときは門を開けて
 * （今までどおり扱って）取りこぼしを避ける。
 */
function gateValue(answer: JudgeAnswer | undefined): GateValue {
  if (answer === undefined || answer.kind !== "noul") return { kind: "unknown" };
  const value = answer.noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { kind: "unknown" };
  }
  return { kind: "known", value };
}

/**
 * 語彙の決めどころの目録を、要件ごとに Noul で一度に聞く（04 §3 P3・05 §3・E4・Issue #366・#384）。
 * 要件ごとに集計の門を 1 つ、要件 × 観点ごとに「当てはまるか」と「決まっているか」の 2 つを、同じ 1 回の
 * 呼び出しで聞く。**当てはまる確率が閾値以上で、かつ決まっている確率が閾値未満の観点だけ**を `unspecified`
 * にする。ただし、門の値が「1 − 閾値」以下（はっきり集計を含まない）の要件では、**集計の観点**を未解決の
 * 事項にしない（直せる人は、門によらず当てはまりで決める）。要件が 1 つも無ければ判定を呼ばない。
 */
export async function runCatalog(input: CatalogInput): Promise<CatalogResult> {
  const questions: Record<string, JudgeQuestion> = {};
  for (const requirement of input.requirements) {
    // 集計の門（Issue #384）。要件ごとに 1 つ、頭を `catalog-gate:要件 ID` にした問いで聞く。
    questions[catalogGateQuestionName(requirement.id)] = {
      kind: "noul",
      instructions: {
        requirement: requirement.text,
        question: CATALOG_GATE_QUESTION_TEXT,
      },
      criteria: { yes: "集計を含む", no: "集計を含まない" },
    };
    for (const facet of CATALOG_FACETS) {
      // 問いの名前（`catalog:要件 ID:観点 ID`）だけで対象を区別しても、Jev は名前を読まない。だから
      // **問いの `instructions` に対象の要件の文と観点の説明を載せ**、問いの文は英語にする（Issue #376）。
      questions[catalogAppliesQuestionName(requirement.id, facet.id)] = {
        kind: "noul",
        instructions: {
          requirement: requirement.text,
          point: facet.point,
          question: CATALOG_APPLIES_QUESTION_TEXT,
        },
        criteria: { yes: "当てはまる（関係する）", no: "当てはまらない（関係しない）" },
      };
      questions[catalogQuestionName(requirement.id, facet.id)] = {
        kind: "noul",
        instructions: {
          requirement: requirement.text,
          point: facet.point,
          question: CATALOG_SPECIFIED_QUESTION_TEXT,
        },
        criteria: { yes: "決まっている（指定されている）", no: "決まっていない（指定されていない）" },
      };
    }
  }
  if (input.requirements.length === 0) return { unspecified: [], judgments: [] };

  // state には、問いをまたいで共通に要るものだけを残す（対象の文は問いの欄に載せた。Issue #376）。
  // 「決まっているか」は依頼で指定されているかを見るので、原文を state に入れて渡す。
  const state = {
    source: input.source,
    requirements: input.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
  };
  const response = await input.judge.judge({ state, questions });

  const unspecified: UnspecifiedFacet[] = [];
  const judgments: CatalogJudgment[] = [];
  for (const requirement of input.requirements) {
    const gateName = catalogGateQuestionName(requirement.id);
    const gate = gateValue(response.answers[gateName]);
    // 門の判定も記録に残す。不明のときは値 `null` にして、値 0 と区別する（Issue #384）
    judgments.push({
      questionId: gateName,
      kind: "gate",
      value: gate.kind === "known" ? gate.value : null,
      model: response.model,
      answeredBy: response.answeredBy,
    });
    // 門の値が「1 − 閾値」以下（はっきり集計を含まない）の要件では、集計の観点を未解決にしない（Issue #384）
    const gateClosed = gate.kind === "known" && gate.value <= 1 - input.threshold;
    for (const facet of CATALOG_FACETS) {
      const appliesName = catalogAppliesQuestionName(requirement.id, facet.id);
      const specifiedName = catalogQuestionName(requirement.id, facet.id);
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
      // 集計を含まないと分かっている要件では、集計の観点を未解決の事項にしない（Issue #384）
      if (gateClosed && CATALOG_AGGREGATION_FACET_IDS.has(facet.id)) continue;
      // 当てはまらない観点は、決まっていなくても未解決の事項にしない（Issue #366）
      if (applies >= input.threshold && specified < input.threshold) {
        unspecified.push({
          requirementId: requirement.id,
          requirementText: requirement.text,
          facetId: facet.id,
          question: facet.question,
          critical: facet.critical,
          specified,
        });
      }
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
