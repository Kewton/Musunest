// 語彙の決めどころの目録（plan/catalog.ts）の unit テスト（04-plan-agent.md §3 P3・05-judge-model.md §3・
// Issue #366・#384）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 7 つ。
//   1. 「当てはまる」が閾値未満の観点は、「決まっている」が低くても未指定にしない（Issue #366）
//   2. 「当てはまる」が閾値以上で「決まっている」が閾値未満の観点だけを未指定にする（ちょうどは指定と見なす）
//   3. 未指定の観点は、目録の `critical` をそのまま持ち、未解決の事項の文に要件の ID と文が入る
//   4. 要件ごとの門と、要件 × 観点 × 2 問を 1 回の呼び出しで聞く（扇形）
//   5. 要件が無ければ判定を呼ばない
//   6. 集計の門（Issue #384）——門の値が「1 − 閾値」以下なら集計の観点を未解決にせず、閾値以上なら今まで
//      どおり。その間と不明（答えが無い・Noul でない・範囲の外）は門を開けて今までどおり扱う
//   7. 観点の説明と 3 つの問いの文が決めた文と一致する
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest } from "../judge.js";
import {
  CATALOG_AGGREGATION_FACET_IDS,
  CATALOG_FACETS,
  catalogAppliesQuestionName,
  catalogGateQuestionName,
  catalogOpenIssue,
  catalogQuestionName,
  runCatalog,
  type CatalogRequirement,
} from "./catalog.js";

const NOUL_THRESHOLD = 0.6;

/** 依頼文（原文）。「決まっているか」の state に入り、要件の文が決まっているかを判定する材料になる */
const SOURCE = "件数を合計する。一覧を出す。";

/** 集計の観点でない（門によらず当てはまりで決まる）観点の ID を、目録の順で並べたもの */
const OTHER_FACET_IDS = CATALOG_FACETS.filter(
  (facet) => !CATALOG_AGGREGATION_FACET_IDS.has(facet.id),
).map((facet) => facet.id);

/** 観点の英語の説明（Issue #384。決めた文と一致することを確かめる） */
const POINTS: Readonly<Record<string, string>> = {
  aggregation: "what is counted and how it is shown (count records, add up a quantity, average, ...)",
  period: "which time period is covered (from when to when)",
  "current-period": "whether the current period (e.g. this month) is included",
  "counted-state": "which states of records are counted (e.g. only meetings that were actually held)",
  integer: "whether a value must be a whole number or may have decimals",
  "filter-combination": "how several filters combine when used together",
  "include-zero": "whether items with zero results are still shown",
  "editable-by": "who may edit or delete the records afterwards",
};

/** 「当てはまるか」の問いの文（Issue #384） */
const APPLIES_QUESTION =
  "Is `point` relevant to building `requirement`, i.e. would the app behave differently depending on how `point` is decided for this requirement?";

/** 「決まっているか」の問いの文（`source` は state の原文の欄の名前。Issue #384） */
const SPECIFIED_QUESTION = "Does `source` or `requirement` already decide `point` for this requirement?";

/** 門の問いの文（Issue #384） */
const GATE_QUESTION =
  "Does `requirement` ask the app to count, add up or otherwise compute a figure from records, or to show such a computed figure?";

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 問いの `instructions` を写像として読む（object でないときは undefined） */
function instructionsOf(question: JudgeQuestion | undefined): Record<string, unknown> | undefined {
  const instructions = question?.instructions;
  return typeof instructions === "object" ? (instructions as Record<string, unknown>) : undefined;
}

/**
 * 要件 1 件ぶんの全問に確率を割り当てた答えを作る。**門の値は既定で 1**（閾値以上＝今までどおり）に
 * するので、門を明示しない既存の試験は今までどおりの当てはまり・決まっているで決まる。
 */
function uniformAnswers(
  requirementId: string,
  values: { readonly applies: number; readonly specified: number; readonly gate?: number },
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {
    [catalogGateQuestionName(requirementId)]: noul(values.gate ?? 1),
  };
  for (const facet of CATALOG_FACETS) {
    answers[catalogAppliesQuestionName(requirementId, facet.id)] = noul(values.applies);
    answers[catalogQuestionName(requirementId, facet.id)] = noul(values.specified);
  }
  return answers;
}

/** 問いの答えを返しつつ、受け取った要求を残す偽物 */
function recordingJudge(answers: Readonly<Record<string, JudgeAnswer>>): {
  readonly judge: Judge;
  readonly requests: JudgeRequest[];
} {
  const inner = createFakeJudge(answers, { model: "fake-judge" });
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        return inner.judge(request);
      },
    },
    requests,
  };
}

/**
 * 用意した答えを**そのまま**返す偽物。偽物の判定（`createFakeJudge`）は答えの無い問いを誤りにするので、
 * 「答えが無い」「Noul でない」「範囲の外」を試すにはこちらを使う。
 */
function customJudge(answers: Readonly<Record<string, JudgeAnswer | undefined>>): {
  readonly judge: Judge;
  readonly requests: JudgeRequest[];
} {
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        const out: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) {
          const answer = answers[name];
          if (answer !== undefined) out[name] = answer;
        }
        return { answers: out, inputTokens: 0, model: "custom-judge", answeredBy: "fake" };
      },
    },
    requests,
  };
}

const REQUIREMENTS: readonly CatalogRequirement[] = [
  { id: "R-1", text: "件数を合計する" },
  { id: "R-2", text: "一覧を出す" },
];

/** 要件 1 件ぶんの目録を回す（門の値を指定できる） */
async function runOne(
  values: { readonly applies: number; readonly specified: number; readonly gate?: number },
  threshold = NOUL_THRESHOLD,
): Promise<Awaited<ReturnType<typeof runCatalog>>> {
  const { judge } = recordingJudge(uniformAnswers("R-1", values));
  return runCatalog({
    requirements: [{ id: "R-1", text: "件数を合計する" }],
    judge,
    source: SOURCE,
    threshold,
  });
}

describe("語彙の決めどころの目録（04 §3 P3・05 §3・Issue #366）", () => {
  it("すべて当てはまり、すべて指定されていれば、未指定は無い", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 0.9 }),
    };
    const { judge } = recordingJudge(answers);
    const result = await runCatalog({ requirements: REQUIREMENTS, judge, source: SOURCE, threshold: NOUL_THRESHOLD });
    expect(result.unspecified).toEqual([]);
  });

  it("「当てはまる」が閾値未満の観点は、「決まっている」が低くても未指定にしない", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-2", { applies: 0.2, specified: 0 }));
    const result = await runCatalog({
      requirements: [{ id: "R-2", text: "件数を合計する" }],
      judge,
      source: SOURCE,
      threshold: NOUL_THRESHOLD,
    });
    expect(result.unspecified).toEqual([]);
  });

  it("「当てはまる」が閾値以上で「決まっている」が閾値未満の観点だけを未指定にし、目録の critical を持たせる", async () => {
    const result = await runOne({ applies: 1, specified: 0.2 });
    // 目録の順に並ぶ
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
    expect(result.unspecified.every((facet) => facet.requirementId === "R-1")).toBe(true);
    expect(result.unspecified.every((facet) => facet.requirementText === "件数を合計する")).toBe(true);
    expect(result.unspecified.every((facet) => facet.specified === 0.2)).toBe(true);
    // critical は目録から写す
    const aggregation = result.unspecified.find((facet) => facet.facetId === "aggregation");
    expect(aggregation?.critical).toBe(true);
    const period = result.unspecified.find((facet) => facet.facetId === "period");
    expect(period?.critical).toBe(false);
  });

  it("閾値ちょうどは当てはまると指定の両方と見なし、未指定にしない（境目）", async () => {
    const result = await runOne({ applies: NOUL_THRESHOLD, specified: NOUL_THRESHOLD });
    expect(result.unspecified).toEqual([]);
  });

  it("要件ごとの門と、要件 × 観点 × 2 問を 1 回の呼び出しで聞く（扇形）", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 1 }),
    };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, source: SOURCE, threshold: NOUL_THRESHOLD });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(
      REQUIREMENTS.length * (CATALOG_FACETS.length * 2 + 1),
    );
    expect(requests[0]?.questions[catalogGateQuestionName("R-1")]).toMatchObject({ kind: "noul" });
    expect(requests[0]?.questions[catalogAppliesQuestionName("R-1", "aggregation")]).toMatchObject({ kind: "noul" });
    expect(requests[0]?.questions[catalogQuestionName("R-1", "aggregation")]).toMatchObject({ kind: "noul" });
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogGateQuestionName("R-2"));
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogAppliesQuestionName("R-2", "editable-by"));
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogQuestionName("R-2", "editable-by"));
  });

  it("「決まっているか」の呼び出しの state に依頼文（原文）を入れる（Issue #376）", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 1 }),
    };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, source: SOURCE, threshold: NOUL_THRESHOLD });
    expect(requests[0]?.state).toMatchObject({ source: SOURCE });
  });

  it("問いの instructions は object で、対象の要件の文・観点の英語の説明・英語の問いを載せる（Issue #376）", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 1 }),
    };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, source: SOURCE, threshold: NOUL_THRESHOLD });

    const questions = requests[0]?.questions ?? {};
    const applies1 = questions[catalogAppliesQuestionName("R-1", "aggregation")];
    const specified1 = questions[catalogQuestionName("R-1", "aggregation")];
    const specified2 = questions[catalogQuestionName("R-2", "aggregation")];

    // instructions は object（対象の文を問いの中に載せる）
    expect(applies1?.instructions).toBeTypeOf("object");
    expect(specified1?.instructions).toMatchObject({
      requirement: "件数を合計する",
      point: expect.stringContaining("count"),
    });
    // 「当てはまるか」の問いにも、同じ対象の要件の文が入る
    expect(instructionsOf(applies1)?.requirement).toBe("件数を合計する");
    // 問いの文は英語（両方の問いとも）
    expect(instructionsOf(applies1)?.question).toMatch(/^[\x20-\x7E]+$/);
    const questionText = instructionsOf(specified1)?.question;
    expect(typeof questionText).toBe("string");
    expect(String(questionText)).toMatch(/^[\x20-\x7E]+$/);
    // 同じ呼び出しの中の 2 つの問い（R-1 と R-2）で、対象の文が別々になる
    expect(instructionsOf(specified2)).toMatchObject({ requirement: "一覧を出す" });
    expect(instructionsOf(specified1)?.requirement).not.toBe(instructionsOf(specified2)?.requirement);
  });

  it("要件が無ければ、判定を呼ばずに空を返す", async () => {
    const { judge, requests } = recordingJudge({});
    const result = await runCatalog({ requirements: [], judge, source: SOURCE, threshold: NOUL_THRESHOLD });
    expect(requests).toEqual([]);
    expect(result).toEqual({ unspecified: [], judgments: [] });
  });

  it("判定の記録に、当てはまるかと決まっているかの両方の分を残す", async () => {
    const result = await runOne({ applies: 0.9, specified: 0.3 });
    const forFacet = result.judgments.filter((judgment) => judgment.questionId.endsWith(":aggregation"));
    expect(forFacet).toEqual([
      {
        questionId: catalogAppliesQuestionName("R-1", "aggregation"),
        kind: "applies",
        value: 0.9,
        model: "fake-judge",
        answeredBy: "fake",
      },
      {
        questionId: catalogQuestionName("R-1", "aggregation"),
        kind: "specified",
        value: 0.3,
        model: "fake-judge",
        answeredBy: "fake",
      },
    ]);
  });

  it("未指定の観点は、未解決の事項（open）に写せ、文に要件の ID と文が入る", async () => {
    const result = await runOne({ applies: 1, specified: 0.1 });
    const first = result.unspecified[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(catalogOpenIssue(first)).toEqual({
      id: `OI:${catalogQuestionName("R-1", first.facetId)}`,
      text: `要件 R-1「件数を合計する」について：${first.question}`,
      critical: first.critical,
      status: "open",
    });
  });
});

describe("集計の門（04 §3 P3・Issue #384）", () => {
  it("門の値が「1 − 閾値」以下の要件では、集計の観点を未解決にしない（当てはまり・決まっているによらず）", async () => {
    // 閾値 0.6 のとき、門の値 0.4 以下は「はっきり集計を含まない」
    for (const values of [
      { applies: 1, specified: 0 },
      { applies: 1, specified: 1 },
      { applies: 0, specified: 0 },
    ]) {
      const result = await runOne({ ...values, gate: 0.2 });
      // 当てはまり・決まっているの値によらず、集計の観点は未解決の事項にならない
      expect(result.unspecified.every((facet) => !CATALOG_AGGREGATION_FACET_IDS.has(facet.facetId))).toBe(true);
    }
    // 当てはまり・決まっているでは未指定になる組み合わせでも、集計の観点は外れ、それ以外は今までどおり
    const result = await runOne({ applies: 1, specified: 0, gate: 0.2 });
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(OTHER_FACET_IDS);
  });

  it("門の値が閾値以上の要件では、今までどおり当てはまり・決まっているで決まる", async () => {
    const result = await runOne({ applies: 1, specified: 0, gate: 0.9 });
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
  });

  it("閾値 0.6 のとき、門の値 0.4 以下は集計の観点を外し、0.4 を超えると今までどおり、0.6 ちょうども今までどおり", async () => {
    const idsOf = async (gate: number) => (await runOne({ applies: 1, specified: 0, gate })).unspecified.map((f) => f.facetId);
    // 0.4 は「1 − 閾値」ちょうど（以下なので外す）
    expect(await idsOf(0.4)).toEqual(OTHER_FACET_IDS);
    expect(await idsOf(0)).toEqual(OTHER_FACET_IDS);
    // 0.4 を超えると門を開けて今までどおり（0.5 は閾値未満でも門は開く）
    expect(await idsOf(0.41)).toEqual(CATALOG_FACETS.map((f) => f.id));
    expect(await idsOf(0.5)).toEqual(CATALOG_FACETS.map((f) => f.id));
    // 閾値ちょうど（0.6）も今までどおり
    expect(await idsOf(0.6)).toEqual(CATALOG_FACETS.map((f) => f.id));
    expect(await idsOf(1)).toEqual(CATALOG_FACETS.map((f) => f.id));
  });

  it("門の答えが無い・Noul でない・範囲の外のときは「不明」として今までどおり扱い、記録で値 0 と区別する", async () => {
    const gateName = catalogGateQuestionName("R-1");
    const allIds = CATALOG_FACETS.map((facet) => facet.id);
    const base = uniformAnswers("R-1", { applies: 1, specified: 0 });
    const run = (answers: Readonly<Record<string, JudgeAnswer | undefined>>) =>
      runCatalog({
        requirements: [{ id: "R-1", text: "件数を合計する" }],
        judge: customJudge(answers).judge,
        source: SOURCE,
        threshold: NOUL_THRESHOLD,
      });

    // 答えが無い
    const missing = { ...base };
    delete missing[gateName];
    const noAnswer = await run(missing);
    expect(noAnswer.unspecified.map((facet) => facet.facetId)).toEqual(allIds);
    expect(noAnswer.judgments.find((judgment) => judgment.kind === "gate")?.value).toBeNull();

    // Noul でない答え
    const scoreAnswer: JudgeAnswer = {
      kind: "score",
      score: 0.5,
      legend: ["a", "b"],
      probabilities: undefined,
      confidence: undefined,
    };
    const notNoul = await run({ ...base, [gateName]: scoreAnswer });
    expect(notNoul.unspecified.map((facet) => facet.facetId)).toEqual(allIds);
    expect(notNoul.judgments.find((judgment) => judgment.kind === "gate")?.value).toBeNull();

    // 範囲の外の値（1 を超える・負）
    const tooBig = await run({ ...base, [gateName]: noul(1.5) });
    expect(tooBig.unspecified.map((facet) => facet.facetId)).toEqual(allIds);
    expect(tooBig.judgments.find((judgment) => judgment.kind === "gate")?.value).toBeNull();
    const negative = await run({ ...base, [gateName]: noul(-0.1) });
    expect(negative.unspecified.map((facet) => facet.facetId)).toEqual(allIds);
    expect(negative.judgments.find((judgment) => judgment.kind === "gate")?.value).toBeNull();

    // 値 0 は「不明」ではなく既知の 0（集計の観点を外す）。記録でも null と区別される
    const zero = await run({ ...base, [gateName]: noul(0) });
    expect(zero.judgments.find((judgment) => judgment.kind === "gate")?.value).toBe(0);
    expect(zero.unspecified.map((facet) => facet.facetId)).toEqual(OTHER_FACET_IDS);
  });

  it("整数か・絞り込みの組み合わせ・直せる人は、門の値によらず当てはまりで今までどおり決まる", async () => {
    for (const gate of [0, 0.4, 0.5, 0.6, 1]) {
      const result = await runOne({ applies: 1, specified: 0, gate });
      const ids = result.unspecified.map((facet) => facet.facetId);
      // どの門の値でも、この 3 つの観点は当てはまり・決まっているで決まる
      expect(ids).toEqual(expect.arrayContaining([...OTHER_FACET_IDS]));
    }
  });

  it("門の問いに対象の要件の文が入り、同じ呼び出しの中で要件ごとに別々になる", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 1 }),
    };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, source: SOURCE, threshold: NOUL_THRESHOLD });

    const questions = requests[0]?.questions ?? {};
    const gate1 = questions[catalogGateQuestionName("R-1")];
    const gate2 = questions[catalogGateQuestionName("R-2")];
    expect(instructionsOf(gate1)?.requirement).toBe("件数を合計する");
    expect(instructionsOf(gate2)?.requirement).toBe("一覧を出す");
    expect(instructionsOf(gate1)?.requirement).not.toBe(instructionsOf(gate2)?.requirement);
  });

  it("観点の説明と 3 つの問いの文が決めた文と一致し、「決まっているか」が参照する欄の名前が state の欄の名前と一致する", async () => {
    const { judge, requests } = recordingJudge(uniformAnswers("R-1", { applies: 1, specified: 1 }));
    await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      source: SOURCE,
      threshold: NOUL_THRESHOLD,
    });

    const questions = requests[0]?.questions ?? {};
    const points = Object.fromEntries(CATALOG_FACETS.map((facet) => [facet.id, facet.point]));
    expect(points).toEqual(POINTS);
    expect(instructionsOf(questions[catalogAppliesQuestionName("R-1", "aggregation")])?.question).toBe(
      APPLIES_QUESTION,
    );
    expect(instructionsOf(questions[catalogQuestionName("R-1", "aggregation")])?.question).toBe(SPECIFIED_QUESTION);
    expect(instructionsOf(questions[catalogGateQuestionName("R-1")])?.question).toBe(GATE_QUESTION);
    // 「決まっているか」が参照する欄の名前（`source`）が、state の原文の欄の名前と一致する
    expect(Object.keys(requests[0]?.state ?? {})).toContain("source");
    expect(SPECIFIED_QUESTION).toContain("`source`");
  });

  it("門の判定が、種類 gate として値と一緒に judgments に残る", async () => {
    const result = await runOne({ applies: 1, specified: 0, gate: 0.9 });
    expect(result.judgments.find((judgment) => judgment.kind === "gate")).toEqual({
      questionId: catalogGateQuestionName("R-1"),
      kind: "gate",
      value: 0.9,
      model: "fake-judge",
      answeredBy: "fake",
    });
  });
});
