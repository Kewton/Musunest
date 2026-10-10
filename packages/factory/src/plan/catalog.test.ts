// 語彙の決めどころの目録（plan/catalog.ts）の unit テスト（04-plan-agent.md §3 P3・05-judge-model.md §3・Issue #366）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 5 つ。
//   1. 「当てはまる」が閾値未満の観点は、「決まっている」が低くても未指定にしない（Issue #366）
//   2. 「当てはまる」が閾値以上で「決まっている」が閾値未満の観点だけを未指定にする（ちょうどは指定と見なす）
//   3. 未指定の観点は、目録の `critical` をそのまま持ち、未解決の事項の文に要件の ID と文が入る
//   4. 要件 × 観点 × 2 問を 1 回の呼び出しで聞く（扇形）
//   5. 要件が無ければ判定を呼ばない
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judge.js";
import {
  CATALOG_FACETS,
  catalogAppliesQuestionName,
  catalogOpenIssue,
  catalogQuestionName,
  runCatalog,
  type CatalogRequirement,
} from "./catalog.js";

const NOUL_THRESHOLD = 0.6;

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 要件 1 件ぶんの全観点に、「当てはまる」と「決まっている」の確率を割り当てた答えを作る */
function uniformAnswers(
  requirementId: string,
  values: { readonly applies: number; readonly specified: number },
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
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

const REQUIREMENTS: readonly CatalogRequirement[] = [
  { id: "R-1", text: "件数を合計する" },
  { id: "R-2", text: "一覧を出す" },
];

describe("語彙の決めどころの目録（04 §3 P3・05 §3・Issue #366）", () => {
  it("すべて当てはまり、すべて指定されていれば、未指定は無い", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 0.9 }),
    };
    const { judge } = recordingJudge(answers);
    const result = await runCatalog({ requirements: REQUIREMENTS, judge, threshold: NOUL_THRESHOLD });
    expect(result.unspecified).toEqual([]);
  });

  it("「当てはまる」が閾値未満の観点は、「決まっている」が低くても未指定にしない", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-2", { applies: 0.2, specified: 0 }));
    const result = await runCatalog({
      requirements: [{ id: "R-2", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    expect(result.unspecified).toEqual([]);
  });

  it("「当てはまる」が閾値以上で「決まっている」が閾値未満の観点だけを未指定にし、目録の critical を持たせる", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-2", { applies: 1, specified: 0.2 }));
    const result = await runCatalog({
      requirements: [{ id: "R-2", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    // 目録の順に並ぶ
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
    expect(result.unspecified.every((facet) => facet.requirementId === "R-2")).toBe(true);
    expect(result.unspecified.every((facet) => facet.requirementText === "件数を合計する")).toBe(true);
    expect(result.unspecified.every((facet) => facet.specified === 0.2)).toBe(true);
    // critical は目録から写す
    const aggregation = result.unspecified.find((facet) => facet.facetId === "aggregation");
    expect(aggregation?.critical).toBe(true);
    const period = result.unspecified.find((facet) => facet.facetId === "period");
    expect(period?.critical).toBe(false);
  });

  it("閾値ちょうどは当てはまると指定の両方と見なし、未指定にしない（境目）", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-1", { applies: NOUL_THRESHOLD, specified: NOUL_THRESHOLD }));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    expect(result.unspecified).toEqual([]);
  });

  it("要件 × 観点 × 2 問を 1 回の呼び出しで聞く（扇形）", async () => {
    const answers = {
      ...uniformAnswers("R-1", { applies: 1, specified: 1 }),
      ...uniformAnswers("R-2", { applies: 1, specified: 1 }),
    };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, threshold: NOUL_THRESHOLD });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(
      REQUIREMENTS.length * CATALOG_FACETS.length * 2,
    );
    expect(requests[0]?.questions[catalogAppliesQuestionName("R-1", "aggregation")]).toMatchObject({ kind: "noul" });
    expect(requests[0]?.questions[catalogQuestionName("R-1", "aggregation")]).toMatchObject({ kind: "noul" });
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogAppliesQuestionName("R-2", "editable-by"));
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogQuestionName("R-2", "editable-by"));
  });

  it("要件が無ければ、判定を呼ばずに空を返す", async () => {
    const { judge, requests } = recordingJudge({});
    const result = await runCatalog({ requirements: [], judge, threshold: NOUL_THRESHOLD });
    expect(requests).toEqual([]);
    expect(result).toEqual({ unspecified: [], judgments: [] });
  });

  it("判定の記録に、当てはまるかと決まっているかの両方の分を残す", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-1", { applies: 0.9, specified: 0.3 }));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
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
    const { judge } = recordingJudge(uniformAnswers("R-1", { applies: 1, specified: 0.1 }));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
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
