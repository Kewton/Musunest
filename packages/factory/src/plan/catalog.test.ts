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
  CATALOG_TARGET_STATUSES,
  INHERIT_FACET_KINDS,
  INHERIT_FACET_MISSES,
  catalogAppliesQuestionName,
  catalogDefaultOf,
  catalogGateQuestionName,
  catalogOpenIssue,
  catalogQuestionName,
  inheritFacetsForAnswer,
  runCatalog,
  type CatalogFacet,
  type FacetDefaultMatch,
  type CatalogRequirement,
  type InheritFacetInput,
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
    expect(result).toEqual({ unspecified: [], judgments: [], reviewed: [] });
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

  it("観点の一覧に integer と filter-combination が無い（Issue #406）", () => {
    const ids = CATALOG_FACETS.map((facet) => facet.id);
    expect(ids).not.toContain("integer");
    expect(ids).not.toContain("filter-combination");
    // 残るのは、集計の 5 観点と直せる人の 6 つである
    expect(ids).toEqual(["aggregation", "period", "current-period", "counted-state", "include-zero", "editable-by"]);
  });

  it("要件 1 件で、門 1 問と観点 6 × 2 問の 13 問だけを組み、外した 2 観点の問いは組まない（Issue #406）", async () => {
    const { judge, requests } = recordingJudge(uniformAnswers("R-1", { applies: 1, specified: 0 }));
    await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      source: SOURCE,
      threshold: NOUL_THRESHOLD,
    });
    const names = Object.keys(requests[0]?.questions ?? {});
    expect(names).toHaveLength(13);
    expect(names).toContain(catalogGateQuestionName("R-1"));
    expect(names).not.toContain(catalogAppliesQuestionName("R-1", "integer"));
    expect(names).not.toContain(catalogQuestionName("R-1", "integer"));
    expect(names).not.toContain(catalogAppliesQuestionName("R-1", "filter-combination"));
    expect(names).not.toContain(catalogQuestionName("R-1", "filter-combination"));
  });

  it("「決まっていない」の答えでも、外した 2 観点の未解決の事項を作らない（Issue #406）", async () => {
    const result = await runOne({ applies: 1, specified: 0 });
    const issueIds = result.unspecified.map(
      (facet) => `OI:${catalogQuestionName(facet.requirementId, facet.facetId)}`,
    );
    expect(issueIds).not.toContain("OI:catalog:R-1:integer");
    expect(issueIds).not.toContain("OI:catalog:R-1:filter-combination");
    // 未指定になるのは、残る 6 観点だけである
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
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

  it("直せる人は、門の値によらず当てはまりで今までどおり決まる", async () => {
    for (const gate of [0, 0.4, 0.5, 0.6, 1]) {
      const result = await runOne({ applies: 1, specified: 0, gate });
      const ids = result.unspecified.map((facet) => facet.facetId);
      // どの門の値でも、直せる人は当てはまり・決まっているで決まる
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

// ── Issue #408：許可の表（観点ごとの既定）────────────────────────────────

describe("許可の表——観点ごとの既定（04 §3「既定で決めてよいものは聞かない」・Issue #408）", () => {
  const facetOf = (id: string): CatalogFacet => {
    const facet = CATALOG_FACETS.find((candidate) => candidate.id === id);
    if (facet === undefined) throw new Error(`観点 ${id} が無い`);
    return facet;
  };

  it("表の行が、観点・対象の要件の条件・適用条件・値・理由を持ち、既定の無い観点（重大・権限）と区別できる", () => {
    // 表を持つ 3 観点：対象の要件の条件・適用条件・値・理由のどれも空でない
    for (const id of ["period", "current-period", "include-zero"]) {
      const def = facetOf(id).default;
      expect(def).toBeDefined();
      if (def === undefined) continue;
      expect(def.target).not.toBe("");
      expect(def.applies).not.toBe("");
      expect(def.value).not.toBe("");
      expect(def.reason).not.toBe("");
      expect(def.match).toBeTypeOf("function");
    }
    // 既定の無い観点（重大な aggregation・counted-state と、権限の editable-by）と区別できる
    expect(facetOf("aggregation").default).toBeUndefined();
    expect(facetOf("counted-state").default).toBeUndefined();
    expect(facetOf("editable-by").default).toBeUndefined();
    // 既定を持つのは、重大でない 3 観点だけである
    const withDefault = CATALOG_FACETS.filter((facet) => facet.default !== undefined).map((facet) => facet.id);
    expect(withDefault).toEqual(["period", "current-period", "include-zero"]);
    // 重大な観点には既定を持たせない（権限は重大でないが既定を持たない）
    expect(CATALOG_FACETS.every((facet) => facet.critical === false || facet.default === undefined)).toBe(true);
  });

  it("適用条件の判定を、合う要件・合わない要件・判定できない要件（閉じない）で対にする", () => {
    const facts = (aggregates: boolean | null) => ({ aggregates });
    for (const id of ["period", "current-period", "include-zero"]) {
      const def = facetOf(id).default;
      if (def === undefined) throw new Error(`観点 ${id} に既定が無い`);
      const match: FacetDefaultMatch = def.match(facts(true));
      expect(match).toBe("match");
      expect(def.match(facts(false))).toBe("no-match");
      // 判定できない（門の答えが無い・Noul でない・範囲の外）ときは閉じない
      expect(def.match(facts(null))).toBe("unknown");
    }
  });

  it("適用条件に合うときだけ値を返し、合わない・判定できない・既定の無い観点は返さない", () => {
    expect(catalogDefaultOf(facetOf("period"), { aggregates: true })).toEqual({
      value: "期間の条件を足さない",
      reason: expect.stringContaining("語彙の意味"),
    });
    expect(catalogDefaultOf(facetOf("period"), { aggregates: false })).toBeUndefined();
    expect(catalogDefaultOf(facetOf("period"), { aggregates: null })).toBeUndefined();
    expect(catalogDefaultOf(facetOf("editable-by"), { aggregates: true })).toBeUndefined();
  });

  it("期間の既定の値が「期間の条件を足さない」で、月の見出しごとの集計を含む要件でも「全期間」にならない", async () => {
    // 月の見出しごとの集計（語彙の意味 §groupby）を含む要件でも、期間の既定は「期間の条件を足さない」
    const { judge } = recordingJudge(uniformAnswers("R-1", { applies: 1, specified: 0, gate: 1 }));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "月ごとの件数を合計する" }],
      judge,
      source: "月ごとの件数を合計する。",
      threshold: NOUL_THRESHOLD,
    });
    const period = result.unspecified.find((facet) => facet.facetId === "period");
    expect(period).toBeDefined();
    const applied = catalogDefaultOf(facetOf("period"), { aggregates: true });
    // 語彙は月の見出しごとの集計を既定で直近 6 か月に絞る。だから「全期間」とは書かない
    expect(applied?.value).toBe("期間の条件を足さない");
    expect(applied?.value).not.toBe("全期間");
    expect(applied?.value).not.toContain("全期間");
    // 各観点の値も「全期間」を含まない
    for (const facet of CATALOG_FACETS) {
      expect(facet.default?.value ?? "").not.toContain("全期間");
    }
  });

  it("表の値・理由は、コードの定数で、語彙の意味を根拠に残す", () => {
    // 語彙の意味（§within・§groupby）を根拠にした注釈を、値と理由の両方で確かめられる
    expect(facetOf("period").default?.reason).toContain("語彙の意味");
    expect(facetOf("current-period").default?.reason).toContain("語彙の意味");
    expect(facetOf("include-zero").default?.reason).toContain("語彙の意味");
    // 「今の期間を含む」「0 件の見出しも出す」は、語彙の省略時の振る舞いと一致する
    expect(facetOf("current-period").default?.value).toBe("今の期間を含む");
    expect(facetOf("include-zero").default?.value).toBe("0 件の見出しも出す");
  });
});

// ── Issue #419：目録が点検した対象の一覧 ────────────────────────────────

describe("目録が点検した対象の一覧（04 §3 P3・Issue #419）", () => {
  /** 一覧から 1 つの観点の結果を引く */
  const statusOf = (result: Awaited<ReturnType<typeof runCatalog>>, facetId: string): string | undefined =>
    result.reviewed.find((target) => target.facetId === facetId)?.status;

  it("要件 × 観点で結果を持ち、当てはまらない・決まっている・開いているを区別する", async () => {
    const open = await runOne({ applies: 1, specified: 0.2, gate: 0.9 });
    expect(open.reviewed).toHaveLength(CATALOG_FACETS.length);
    expect(open.reviewed.every((target) => target.requirementId === "R-1")).toBe(true);
    expect(open.reviewed.map((target) => target.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
    expect(open.reviewed.every((target) => target.status === "開いている")).toBe(true);

    const notApplicable = await runOne({ applies: 0.2, specified: 0 });
    expect(notApplicable.reviewed.every((target) => target.status === "当てはまらない")).toBe(true);

    const decided = await runOne({ applies: 1, specified: 1 });
    expect(decided.reviewed.every((target) => target.status === "決まっている")).toBe(true);
  });

  it("門の閉じと閾値の境界が、既存の未指定の判定と同じ結果になる", async () => {
    // 閾値 0.6 → 門 0.4 は「1 − 閾値」ちょうど（以下なので閉じる）
    const closed = await runOne({ applies: 1, specified: 0, gate: 0.4 });
    for (const facetId of CATALOG_AGGREGATION_FACET_IDS) expect(statusOf(closed, facetId)).toBe("当てはまらない");
    expect(statusOf(closed, "editable-by")).toBe("開いている");
    // 未指定の判定（既存）と同じ——集計の観点は外れ、直せる人は残る
    expect(closed.unspecified.map((facet) => facet.facetId)).toEqual(OTHER_FACET_IDS);

    // 0.41 は境界の外（門を開ける）→ 今までどおり当てはまり・決まりで決まる
    const opened = await runOne({ applies: 1, specified: 0, gate: 0.41 });
    for (const facetId of CATALOG_AGGREGATION_FACET_IDS) expect(statusOf(opened, facetId)).toBe("開いている");
    expect(opened.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
  });

  it("門・当てはまり・決まりの判定の欠け・型違い・範囲外は「判定不明」になり、0 と区別される", async () => {
    const gateName = catalogGateQuestionName("R-1");
    const base = uniformAnswers("R-1", { applies: 1, specified: 0 });
    const run = (answers: Readonly<Record<string, JudgeAnswer | undefined>>) =>
      runCatalog({
        requirements: [{ id: "R-1", text: "件数を合計する" }],
        judge: customJudge(answers).judge,
        source: SOURCE,
        threshold: NOUL_THRESHOLD,
      });

    // 門の答えが無い → 集計の観点は「判定不明」、直せる人は当てはまり・決まりで決まる
    const noGate = { ...base };
    delete noGate[gateName];
    const missingGate = await run(noGate);
    expect(statusOf(missingGate, "aggregation")).toBe("判定不明");
    expect(statusOf(missingGate, "editable-by")).toBe("開いている");

    // 当てはまりが Noul でない → 「判定不明」（値 0 と区別）
    const scoreAnswer: JudgeAnswer = {
      kind: "score",
      score: 0.5,
      legend: ["a", "b"],
      probabilities: undefined,
      confidence: undefined,
    };
    const notNoul = await run({ ...base, [catalogAppliesQuestionName("R-1", "editable-by")]: scoreAnswer });
    expect(statusOf(notNoul, "editable-by")).toBe("判定不明");

    // 値 0（既知の 0）は「当てはまらない」で、判定不明と区別される
    const zero = await run({ ...base, [catalogAppliesQuestionName("R-1", "editable-by")]: noul(0) });
    expect(statusOf(zero, "editable-by")).toBe("当てはまらない");

    // 決まっているの値が範囲の外 → 「判定不明」
    const outOfRange = await run({ ...base, [catalogQuestionName("R-1", "editable-by")]: noul(1.5) });
    expect(statusOf(outOfRange, "editable-by")).toBe("判定不明");
  });

  it("既定で閉じた扱いは一覧に含めない（閉じるのは呼ぶ側）", async () => {
    // 表の既定が当たる要件でも、一覧は「開いている」のままで、既定の値・理由を持たない
    const result = await runOne({ applies: 1, specified: 0, gate: 1 });
    const period = result.reviewed.find((target) => target.facetId === "period");
    expect(period?.status).toBe("開いている");
    expect(Object.keys(period ?? {})).toEqual(["requirementId", "facetId", "status"]);
    // 結果は有限の 4 つだけで、「既定で決まっている」のような値は無い
    expect([...CATALOG_TARGET_STATUSES]).toEqual(["当てはまらない", "決まっている", "開いている", "判定不明"]);
  });
});

// ── Issue #461：答えから生まれた要件が引き継ぐ観点を、純関数で決める ──────────────

/** 引き継ぎの判定の入力（既定は、答えがコード作の目録の事項 1 つを解いた形） */
function inheritInput(overrides: Partial<InheritFacetInput> = {}): InheritFacetInput {
  return {
    answerId: "A:Q1-1",
    issueIds: ["OI:catalog:R-1:aggregation"],
    issues: [{ id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } }],
    catalogFacets: [{ issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" }],
    answerRequirements: [{ id: "R:A:Q1-1", text: "件数を合計できる" }],
    decisions: [],
    defaultClosures: [],
    sourceClosures: [],
    previous: [],
    ...overrides,
  };
}

describe("答えから生まれた要件の引き継ぎ（04 §3 P4・§6 の 1・Issue #461）", () => {
  const NO_MISSES = [
    { kind: "missing", count: 0 },
    { kind: "multiple", count: 0 },
    { kind: "mismatch", count: 0 },
  ] as const;

  it("種類と分類の一覧が有限で、決めた並びである", () => {
    expect([...INHERIT_FACET_KINDS]).toEqual(["a", "b", "c", "d"]);
    expect([...INHERIT_FACET_MISSES]).toEqual(["missing", "multiple", "mismatch"]);
  });

  it("集合の事項がコード作の目録の事項で、1 行・resolved・答えが一致すれば (a) になり、値は答え由来の要件の文と完全に一致する", () => {
    const result = inheritFacetsForAnswer(inheritInput());
    expect(result.facets).toEqual([
      {
        parentRequirementId: "R-1",
        facetId: "aggregation",
        kind: "a",
        basis: "A:Q1-1",
        value: "件数を合計できる",
        sourceIssueId: "OI:catalog:R-1:aggregation",
      },
    ]);
    expect(result.noParent).toBe(0);
    expect(result.multipleParents).toBe(0);
    expect(result.unresolved).toEqual(NO_MISSES);
  });

  it("主がモデル作でも、alsoCloses にコード作の事項があれば親になり (a) になる", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issueIds: ["OI:extra", "OI:catalog:R-1:aggregation"],
        issues: [
          { id: "OI:extra", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.kind)).toEqual(["a"]);
    expect(result.facets[0]?.facetId).toBe("aggregation");
    expect(result.noParent).toBe(0);
  });

  it("親の要件で resolved の観点が、答え (b)・依頼文 (b)・既定 (c)・引き継ぎ (d) に分類され、値がそれぞれ一致する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-1:counted-state", requirementId: "R-1", facetId: "counted-state" },
          { issueId: "OI:catalog:R-1:period", requirementId: "R-1", facetId: "period" },
          { issueId: "OI:catalog:R-1:include-zero", requirementId: "R-1", facetId: "include-zero" },
        ],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:counted-state", status: "resolved", resolution: { answer_id: "A:Q0-1" } },
          { id: "OI:catalog:R-1:period", status: "resolved", resolution: { decision_id: "D:source:OI:catalog:R-1:period" } },
          { id: "OI:catalog:R-1:include-zero", status: "resolved", resolution: { decision_id: "D:default:OI:catalog:R-1:include-zero" } },
          { id: "OI:catalog:R-1:editable-by", status: "resolved", resolution: { decision_id: "D:inherit:OI:catalog:R-1:editable-by" } },
        ],
        answerRequirements: [
          { id: "R:A:Q1-1", text: "件数を合計できる" },
          { id: "R:A:Q0-1", text: "会議を数える" },
        ],
        decisions: [
          { id: "D:source:OI:catalog:R-1:period", value: "期間の条件を足さない" },
          { id: "D:default:OI:catalog:R-1:include-zero", value: "0 件の見出しも出す" },
          { id: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" },
        ],
        sourceClosures: [
          {
            issueId: "OI:catalog:R-1:period",
            decisionId: "D:source:OI:catalog:R-1:period",
            value: "期間の条件を足さない",
          },
        ],
        defaultClosures: [
          {
            issueId: "OI:catalog:R-1:include-zero",
            facetId: "include-zero",
            decisionId: "D:default:OI:catalog:R-1:include-zero",
            value: "0 件の見出しも出す",
          },
        ],
        previous: [
          {
            issueId: "OI:catalog:R-1:editable-by",
            requirementId: "R-1",
            facetId: "editable-by",
            decisionId: "D:inherit:OI:catalog:R-1:editable-by",
            value: "直せる人は管理者",
          },
        ],
      }),
    );
    const byFacet = new Map(result.facets.map((facet) => [facet.facetId, facet]));
    expect(byFacet.get("aggregation")).toMatchObject({ kind: "a", basis: "A:Q1-1", value: "件数を合計できる" });
    expect(byFacet.get("counted-state")).toMatchObject({ kind: "b", basis: "A:Q0-1", value: "会議を数える" });
    expect(byFacet.get("period")).toMatchObject({ kind: "b", basis: "D:source:OI:catalog:R-1:period", value: "期間の条件を足さない" });
    expect(byFacet.get("include-zero")).toMatchObject({ kind: "c", basis: "D:default:OI:catalog:R-1:include-zero", value: "0 件の見出しも出す" });
    expect(byFacet.get("editable-by")).toMatchObject({ kind: "d", basis: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" });
    expect(result.unresolved).toEqual(NO_MISSES);
  });

  it("別の観点が別の答えで解決済みのとき、各観点の値が入れ替わらずそれぞれの答えの値を保つ", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-1:counted-state", requirementId: "R-1", facetId: "counted-state" },
        ],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:counted-state", status: "resolved", resolution: { answer_id: "A:Q0-1" } },
        ],
        answerRequirements: [
          { id: "R:A:Q1-1", text: "合計の文" },
          { id: "R:A:Q0-1", text: "状態の文" },
        ],
      }),
    );
    const byFacet = new Map(result.facets.map((facet) => [facet.facetId, facet]));
    expect(byFacet.get("aggregation")?.value).toBe("合計の文");
    expect(byFacet.get("counted-state")?.value).toBe("状態の文");
    expect(byFacet.get("aggregation")?.value).not.toBe(byFacet.get("counted-state")?.value);
  });

  it("自由入力を選択肢に分類した答えは、値が選択肢の文（要件に入った文）で、自由入力の原文ではない", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({ answerRequirements: [{ id: "R:A:Q1-1", text: "全員を数える" }] }),
    );
    expect(result.facets[0]?.value).toBe("全員を数える");
    expect(result.facets[0]?.value).not.toBe("みんなで数えて");
  });

  it("同じ入力から同じ結果になる", () => {
    const input = inheritInput({
      catalogFacets: [
        { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
        { issueId: "OI:catalog:R-1:period", requirementId: "R-1", facetId: "period" },
      ],
      issues: [
        { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
        { id: "OI:catalog:R-1:period", status: "resolved", resolution: { decision_id: "D:default:OI:catalog:R-1:period" } },
      ],
      decisions: [{ id: "D:default:OI:catalog:R-1:period", value: "期間の条件を足さない" }],
      defaultClosures: [
        {
          issueId: "OI:catalog:R-1:period",
          facetId: "period",
          decisionId: "D:default:OI:catalog:R-1:period",
          value: "期間の条件を足さない",
        },
      ],
    });
    expect(inheritFacetsForAnswer(input)).toEqual(inheritFacetsForAnswer(input));
  });

  it("集合のどこにもコード作の事項が無ければ、引き継がず親なしで報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issueIds: ["OI:extra"],
        issues: [{ id: "OI:extra", status: "resolved", resolution: { answer_id: "A:Q1-1" } }],
        catalogFacets: [],
      }),
    );
    expect(result.facets).toEqual([]);
    expect(result.noParent).toBe(1);
    expect(result.multipleParents).toBe(0);
    expect(result.unresolved).toEqual(NO_MISSES);
  });

  it("alsoCloses が別の要件のコード作の事項を含むなら、(a) だけを引き継ぎ、親が複数として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issueIds: ["OI:catalog:R-1:aggregation", "OI:catalog:R-2:aggregation"],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-2:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
        ],
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-2:aggregation", requirementId: "R-2", facetId: "aggregation" },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.kind)).toEqual(["a", "a"]);
    expect(result.facets.map((facet) => facet.parentRequirementId)).toEqual(["R-1", "R-2"]);
    expect(result.multipleParents).toBe(1);
    expect(result.noParent).toBe(0);
    expect(result.unresolved).toEqual(NO_MISSES);
  });

  it("親の事項の同じ ID が 2 行なら、引き継がず複数として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
        ],
      }),
    );
    expect(result.facets).toEqual([]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 1 },
      { kind: "mismatch", count: 0 },
    ]);
    expect(result.noParent).toBe(1);
  });

  it("問いが指した事項の解決が 0 行・別の答えで resolved なら、親にしない（親なし）", () => {
    const zeroRows = inheritFacetsForAnswer(inheritInput({ issues: [] }));
    expect(zeroRows.facets).toEqual([]);
    expect(zeroRows.noParent).toBe(1);
    expect(zeroRows.unresolved).toEqual(NO_MISSES);

    const otherAnswer = inheritFacetsForAnswer(
      inheritInput({
        issues: [{ id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q9-9" } }],
      }),
    );
    expect(otherAnswer.facets).toEqual([]);
    expect(otherAnswer.noParent).toBe(1);
    expect(otherAnswer.unresolved).toEqual(NO_MISSES);
  });

  it("受理一覧に無い答えの ID（R:<答え> が無い）なら、引き継がず欠落として報告する", () => {
    const result = inheritFacetsForAnswer(inheritInput({ answerRequirements: [] }));
    expect(result.facets).toEqual([]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 1 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 0 },
    ]);
    expect(result.noParent).toBe(0);
  });

  it("resolved の行に根拠が無い、または参照先（決定・記録）が無いなら、引き継がず欠落として報告する", () => {
    const noBasis = inheritFacetsForAnswer(
      inheritInput({ issues: [{ id: "OI:catalog:R-1:aggregation", status: "resolved" }] }),
    );
    expect(noBasis.facets).toEqual([]);
    expect(noBasis.unresolved).toEqual([
      { kind: "missing", count: 1 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 0 },
    ]);
    expect(noBasis.noParent).toBe(1);

    const noTarget = inheritFacetsForAnswer(
      inheritInput({
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-1:period", requirementId: "R-1", facetId: "period" },
        ],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:period", status: "resolved", resolution: { decision_id: "D:source:OI:catalog:R-1:period" } },
        ],
        decisions: [{ id: "D:source:OI:catalog:R-1:period", value: "期間の値" }],
        // sourceClosures に無い
      }),
    );
    expect(noTarget.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(noTarget.unresolved).toEqual([
      { kind: "missing", count: 1 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 0 },
    ]);
  });

  it("参照先が 2 つ以上（答えと決定の両方）なら、引き継がず複数として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issues: [
          {
            id: "OI:catalog:R-1:aggregation",
            status: "resolved",
            resolution: { answer_id: "A:Q1-1", decision_id: "D:default:OI:catalog:R-1:aggregation" },
          },
        ],
      }),
    );
    expect(result.facets).toEqual([]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 1 },
      { kind: "mismatch", count: 0 },
    ]);
  });

  it("記録の観点と対応表の観点が違うなら、引き継がず不一致として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-1:period", requirementId: "R-1", facetId: "period" },
        ],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:period", status: "resolved", resolution: { decision_id: "D:default:OI:catalog:R-1:period" } },
        ],
        decisions: [{ id: "D:default:OI:catalog:R-1:period", value: "期間の値" }],
        defaultClosures: [
          {
            issueId: "OI:catalog:R-1:period",
            facetId: "counted-state",
            decisionId: "D:default:OI:catalog:R-1:period",
            value: "期間の値",
          },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 1 },
    ]);
  });

  it("open の観点・目録が開かなかった観点・対応表に無い観点は、引き継がず件数にも数えない", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        issueIds: ["OI:extra", "OI:catalog:R-1:aggregation"],
        issues: [
          { id: "OI:extra", status: "open" },
          { id: "OI:catalog:R-1:aggregation", status: "open" },
        ],
      }),
    );
    expect(result.facets).toEqual([]);
    expect(result.unresolved).toEqual(NO_MISSES);
    expect(result.noParent).toBe(1);
  });

  // ── F1：参照先の件数と、根拠に対応する決定・記録の一致（Issue #461・レビュー指摘 F1）────

  /** (d) の分類を試す入力の土台：親 R-1 の aggregation を答えが解き、editable-by を引き継ぎの表が解いている */
  function inheritInputWithPrevious(overrides: Partial<InheritFacetInput> = {}): InheritFacetInput {
    return inheritInput({
      // editable-by は**引き継ぎの表**だけが持つ（対応表には入れない。実際の runPlan と同じ）
      catalogFacets: [
        { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
      ],
      issues: [
        { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
        {
          id: "OI:catalog:R-1:editable-by",
          status: "resolved",
          resolution: { decision_id: "D:inherit:OI:catalog:R-1:editable-by" },
        },
      ],
      decisions: [{ id: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" }],
      previous: [
        {
          issueId: "OI:catalog:R-1:editable-by",
          requirementId: "R-1",
          facetId: "editable-by",
          decisionId: "D:inherit:OI:catalog:R-1:editable-by",
          value: "直せる人は管理者",
        },
      ],
      ...overrides,
    });
  }

  it("土台：(d) として引き継ぎ、値が decision の値と一致する", () => {
    const result = inheritFacetsForAnswer(inheritInputWithPrevious());
    const editable = result.facets.find((facet) => facet.facetId === "editable-by");
    expect(editable).toMatchObject({ kind: "d", basis: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" });
    expect(result.unresolved).toEqual(NO_MISSES);
  });

  it("同じ決定 ID の 2 行があれば、その観点を引き継がず複数として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInputWithPrevious({
        decisions: [
          { id: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" },
          { id: "D:inherit:OI:catalog:R-1:editable-by", value: "別の値" },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 1 },
      { kind: "mismatch", count: 0 },
    ]);
  });

  it("同じ事項の既定の記録が 2 行あれば、その観点を引き継がず複数として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInput({
        catalogFacets: [
          { issueId: "OI:catalog:R-1:aggregation", requirementId: "R-1", facetId: "aggregation" },
          { issueId: "OI:catalog:R-1:include-zero", requirementId: "R-1", facetId: "include-zero" },
        ],
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          {
            id: "OI:catalog:R-1:include-zero",
            status: "resolved",
            resolution: { decision_id: "D:default:OI:catalog:R-1:include-zero" },
          },
        ],
        decisions: [{ id: "D:default:OI:catalog:R-1:include-zero", value: "0 件の見出しも出す" }],
        defaultClosures: [
          {
            issueId: "OI:catalog:R-1:include-zero",
            facetId: "include-zero",
            decisionId: "D:default:OI:catalog:R-1:include-zero",
            value: "0 件の見出しも出す",
          },
          {
            issueId: "OI:catalog:R-1:include-zero",
            facetId: "include-zero",
            decisionId: "D:default:OI:catalog:R-1:include-zero",
            value: "0 件の見出しも出す",
          },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 1 },
      { kind: "mismatch", count: 0 },
    ]);
  });

  it("行の decision_id を別の実在する決定へ変えると、古い previous.value をその別決定の根拠で d として返さない", () => {
    const result = inheritFacetsForAnswer(
      inheritInputWithPrevious({
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:editable-by", status: "resolved", resolution: { decision_id: "D:other" } },
        ],
        decisions: [
          { id: "D:inherit:OI:catalog:R-1:editable-by", value: "直せる人は管理者" },
          { id: "D:other", value: "別の値" },
        ],
      }),
    );
    // editable-by は引き継がず（不一致）、値も別決定の値で返らない
    expect(result.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 1 },
    ]);
  });

  it("previous.decisionId の参照先が欠けていれば、引き継がず欠落として報告する", () => {
    const result = inheritFacetsForAnswer(
      inheritInputWithPrevious({
        issues: [
          { id: "OI:catalog:R-1:aggregation", status: "resolved", resolution: { answer_id: "A:Q1-1" } },
          { id: "OI:catalog:R-1:editable-by", status: "resolved", resolution: { decision_id: "D:absent" } },
        ],
        decisions: [],
        previous: [
          {
            issueId: "OI:catalog:R-1:editable-by",
            requirementId: "R-1",
            facetId: "editable-by",
            decisionId: "D:absent",
            value: "直せる人は管理者",
          },
        ],
      }),
    );
    expect(result.facets.map((facet) => facet.facetId)).toEqual(["aggregation"]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 1 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 0 },
    ]);
  });

  it("親の別観点を辿る経路でも、同じ事項 ID の対応が 2 つ以上あれば、その観点を引き継がず複数として報告する", () => {
    // 質問が指す事項 M は一意。親の別観点を辿る経路で、同じ事項 X の対応が 2 行（period・counted-state）。
    const result = inheritFacetsForAnswer({
      answerId: "A:new",
      issueIds: ["M"],
      issues: [
        { id: "M", status: "resolved", resolution: { answer_id: "A:new" } },
        { id: "X", status: "resolved", resolution: { answer_id: "A:old" } },
      ],
      catalogFacets: [
        { issueId: "M", requirementId: "R-1", facetId: "aggregation" },
        { issueId: "X", requirementId: "R-1", facetId: "period" },
        { issueId: "X", requirementId: "R-1", facetId: "counted-state" },
      ],
      answerRequirements: [
        { id: "R:A:new", text: "V-new" },
        { id: "R:A:old", text: "V-old" },
      ],
      decisions: [],
      defaultClosures: [],
      sourceClosures: [],
      previous: [],
    });
    // 曖昧な 1 事項の対応から、2 観点を (b) として解決済みと扱わない（(a) の aggregation だけ）
    expect(result.facets).toEqual([
      {
        parentRequirementId: "R-1",
        facetId: "aggregation",
        kind: "a",
        basis: "A:new",
        value: "V-new",
        sourceIssueId: "M",
      },
    ]);
    expect(result.unresolved).toEqual([
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 1 },
      { kind: "mismatch", count: 0 },
    ]);
  });
});
