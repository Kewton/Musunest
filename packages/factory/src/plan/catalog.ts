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

/**
 * 既定を当てるかの判定（コードが判定できる**事実だけ**を見る。Issue #408）。`unknown` は「判定できない」
 * であり、そのときは閉じない（表の外として扱う）。
 */
export type FacetDefaultMatch = "match" | "no-match" | "unknown";

/**
 * 既定を当てるかの判定に使う**事実**（Issue #408）。**依頼文・答え・モデルの出力の文字列は入れない**——
 * 目録の判定の結果のように、コードが確かめられるものだけを持つ。`null` は「判定できない」である。
 */
export interface FacetDefaultFacts {
  /**
   * 対象の要件が、記録を数える・合計する・数字を求めることを含むと**判定できた**か（目録の門の判定）。
   * 門の答えが無い・Noul でない・範囲の外なら `null`（判定できない）。
   */
  readonly aggregates: boolean | null;
}

/**
 * 目録の観点の**既定**（許可の表の 1 行。04 §3「既定で決めてよいものは聞かない」・Issue #408）。
 * 行は 観点（`CatalogFacet.id`）・対象の要件の条件（`target`）・適用条件（`applies`）・定数の値（`value`）・
 * 理由（`reason`）を持つ。値は**コードの定数だけ**にする——依頼文・答え・モデルの出力の文字列を使わない。
 *
 * `match` は適用条件を**コードで判定**する。確かめられない要件には `unknown` を返し、閉じない。
 */
export interface CatalogFacetDefault {
  /** 対象の要件の条件（人が読む説明。語彙の意味で確かめられた対象と形式） */
  readonly target: string;
  /** 適用条件（人が読む説明。コードが判定できる事実だけで書く） */
  readonly applies: string;
  /** 定数の値（コードの定数だけ） */
  readonly value: string;
  /** 理由（決定を組む側が観点の ID を添える） */
  readonly reason: string;
  /** 適用条件をコードで判定する（`match` のときだけ閉じる） */
  readonly match: (facts: FacetDefaultFacts) => FacetDefaultMatch;
}

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
  /**
   * 許可の表の既定（Issue #408）。**無い観点（重大・権限）は閉じない**。重大（`aggregation`・
   * `counted-state`）と権限（`editable-by`）には付けない。
   */
  readonly default?: CatalogFacetDefault;
}

/**
 * 集計の対象だと**判定できた**要件にだけ当てる既定の適用条件（Issue #408）。目録の門の判定
 * （`aggregates`）だけを見る。判定できないときは `unknown` にして閉じない。
 */
function matchAggregationFacet(facts: FacetDefaultFacts): FacetDefaultMatch {
  if (facts.aggregates === null) return "unknown";
  return facts.aggregates ? "match" : "no-match";
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
    default: {
      target: "集計の要件（記録を数える・合計する・数字を求めることを含むと判定できた要件）",
      applies: "目録の門の判定が「集計を含む」と言っている要件。判定できない要件には当てない",
      // 語彙の意味 §within：期間の条件（`within`）を書かなければ期間で絞らない。**「全期間」とは書かない**
      // ——月の見出しごとの集計（§groupby）は、語彙が `last` の既定の直近 6 か月に絞るので、全期間ではない。
      value: "期間の条件を足さない",
      reason: "語彙は、期間の条件（within）を書かなければ期間で絞らない（語彙の意味 §within）",
      match: matchAggregationFacet,
    },
  },
  {
    id: "current-period",
    question: "今の期間（今月など）を含むかどうか",
    point: "whether the current period (e.g. this month) is included",
    critical: false,
    default: {
      target: "集計の要件（見出しごとの集計など、語彙の意味 §within・§groupby で確かめられた対象）",
      applies: "目録の門の判定が「集計を含む」と言っている要件。判定できない要件には当てない",
      // 語彙の意味 §within：期間で絞らなければ（月の見出しごとの既定の 6 か月でも）今の期間を含む
      value: "今の期間を含む",
      reason: "語彙は、期間の条件（within）を書かなければ期間で絞らず、今の期間を含む（語彙の意味 §within）",
      match: matchAggregationFacet,
    },
  },
  {
    id: "counted-state",
    question: "どの状態のものを数えるか",
    point: "which states of records are counted (e.g. only meetings that were actually held)",
    critical: true,
    // 重大なので既定を持たせない（Issue #408）
  },
  {
    id: "include-zero",
    question: "0 件のときも表示するかどうか",
    point: "whether items with zero results are still shown",
    critical: false,
    default: {
      target: "見出しごとの集計（語彙の意味 §groupby で確かめられた対象）",
      applies: "目録の門の判定が「集計を含む」と言っている要件。判定できない要件には当てない",
      // 語彙の意味 §groupby：値が 0 の見出しも出す（データの無い月も 0 と数える）
      value: "0 件の見出しも出す",
      reason: "語彙は、見出しごとの集計で、値が 0 の見出し（データの無い月）も出す（語彙の意味 §groupby）",
      match: matchAggregationFacet,
    },
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

/**
 * 目録の観点の既定を、コードが判定できる事実に照らして**当てるか**を決める（Issue #408）。適用条件が
 * `match` のときだけ、値と理由を返す。`no-match`・`unknown`（判定できない）と、既定の無い観点は
 * `undefined`（閉じない）。
 */
export function catalogDefaultOf(
  facet: CatalogFacet,
  facts: FacetDefaultFacts,
): { readonly value: string; readonly reason: string } | undefined {
  const def = facet.default;
  if (def === undefined) return undefined;
  return def.match(facts) === "match" ? { value: def.value, reason: def.reason } : undefined;
}

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

/**
 * 目録が点検した 1 つの対象（要件 × 観点）の結果（Issue #419）。値は有限の 4 つ——「当てはまらない」
 * （その観点がその要件に関係しない）・「決まっている」（依頼か答えで指定されている）・「開いている」
 * （指定されておらず、答えで作るものが変わる）・「判定不明」（判定が欠け・Noul 以外・非有限・0〜1 の外
 * で、確定できない）。**「不明」を値 0 と区別する**（#384 のまま）。
 */
export const CATALOG_TARGET_STATUSES = ["当てはまらない", "決まっている", "開いている", "判定不明"] as const;
export type CatalogTargetStatus = (typeof CATALOG_TARGET_STATUSES)[number];

/** 目録が点検した対象 1 つ（要件 ID・観点 ID・結果。Issue #419） */
export interface CatalogTarget {
  readonly requirementId: string;
  readonly facetId: string;
  readonly status: CatalogTargetStatus;
}

/** 目録の判定の結果 */
export interface CatalogResult {
  /** 指定されていない観点（当てはまるかつ閾値より低いものだけ）。要件の順・観点の順に並ぶ */
  readonly unspecified: readonly UnspecifiedFacet[];
  readonly judgments: readonly CatalogJudgment[];
  /**
   * 目録が点検した対象の一覧（要件 × 観点 と結果。Issue #419）。**許可の表の既定の適用は含めない**
   * ——既定で閉じるのは呼ぶ側（`runPlan`）の仕事である。要件の順・観点の順に並ぶ。
   */
  readonly reviewed: readonly CatalogTarget[];
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

/**
 * 検証した Noul の値（答えが無い・Noul でない・数でない・0〜1 の外は「不明」）。**欠けを 0 にする
 * `noulValue` とは別**——不明を値 0 と区別する（Issue #384）。
 */
export type JudgmentValue = { readonly kind: "known"; readonly value: number } | { readonly kind: "unknown" };

/**
 * 答えから、検証した Noul の値を取り出す（Issue #384）。**欠けを 0 にする `noulValue` は門と一覧には
 * 使わない**——答えが無い・Noul でない答え・数でない値・0〜1 の外の値は、値 0 と区別して「不明」にする。
 * 不明のときは門を開けて（今までどおり扱って）取りこぼしを避ける。
 */
export function judgmentValue(answer: JudgeAnswer | undefined): JudgmentValue {
  if (answer === undefined || answer.kind !== "noul") return { kind: "unknown" };
  const value = answer.noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { kind: "unknown" };
  }
  return { kind: "known", value };
}

/**
 * 目録が点検した 1 つの対象（要件 × 観点）の結果を、閾値と門の閉じに照らして**1 か所で**決める
 * （Issue #419）。優先の順は既存の目録の条件（閾値・門の閉じ）と同じにする。
 *
 *   - 集計の観点は、門の判定が不明なら「判定不明」（適用そのものを確定できない）、門がはっきり閉じて
 *     いれば（`1 − 閾値` 以下）「当てはまらない」
 *   - 当てはまりの判定が不明なら「判定不明」、閾値未満なら「当てはまらない」
 *   - 決まっているかの判定が不明なら「判定不明」、閾値以上なら「決まっている」、未満なら「開いている」
 */
export function catalogTargetStatus(input: {
  readonly aggregation: boolean;
  readonly gate: JudgmentValue;
  readonly applies: JudgmentValue;
  readonly specified: JudgmentValue;
  readonly threshold: number;
}): CatalogTargetStatus {
  if (input.aggregation) {
    if (input.gate.kind === "unknown") return "判定不明";
    if (input.gate.value <= 1 - input.threshold) return "当てはまらない";
  }
  if (input.applies.kind === "unknown") return "判定不明";
  if (input.applies.value < input.threshold) return "当てはまらない";
  if (input.specified.kind === "unknown") return "判定不明";
  return input.specified.value < input.threshold ? "開いている" : "決まっている";
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
  if (input.requirements.length === 0) return { unspecified: [], judgments: [], reviewed: [] };

  // state には、問いをまたいで共通に要るものだけを残す（対象の文は問いの欄に載せた。Issue #376）。
  // 「決まっているか」は依頼で指定されているかを見るので、原文を state に入れて渡す。
  const state = {
    source: input.source,
    requirements: input.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
  };
  const response = await input.judge.judge({ state, questions });

  const unspecified: UnspecifiedFacet[] = [];
  const judgments: CatalogJudgment[] = [];
  // 点検した対象の一覧（要件 × 観点 と結果。Issue #419）
  const reviewed: CatalogTarget[] = [];
  for (const requirement of input.requirements) {
    const gateName = catalogGateQuestionName(requirement.id);
    const gate = judgmentValue(response.answers[gateName]);
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
      // 点検した対象の一覧に、要件 × 観点 の結果を加える（欠け・Noul 以外・非有限・0〜1 の外は
      // 値 0 と区別して「判定不明」にする。Issue #419）
      reviewed.push({
        requirementId: requirement.id,
        facetId: facet.id,
        status: catalogTargetStatus({
          aggregation: CATALOG_AGGREGATION_FACET_IDS.has(facet.id),
          gate,
          applies: judgmentValue(response.answers[appliesName]),
          specified: judgmentValue(response.answers[specifiedName]),
          threshold: input.threshold,
        }),
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
  return { unspecified, judgments, reviewed };
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
