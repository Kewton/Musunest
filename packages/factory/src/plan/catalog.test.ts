// 語彙の決めどころの目録（plan/catalog.ts）の unit テスト（04-plan-agent.md §3 P3・05-judge-model.md §3）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 4 つ。
//   1. 「決まっている」確率が閾値**未満**の観点だけを未指定にする（ちょうどは指定と見なす）
//   2. 未指定の観点は、目録の `critical` をそのまま持つ
//   3. 要件 × 観点を 1 回の呼び出しで聞く（扇形。問いは `catalog:要件 ID:観点 ID`）
//   4. 要件が無ければ判定を呼ばない
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judge.js";
import {
  CATALOG_FACETS,
  catalogOpenIssue,
  catalogQuestionName,
  runCatalog,
  type CatalogRequirement,
} from "./catalog.js";

const NOUL_THRESHOLD = 0.6;

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 要件 1 件ぶんの全観点に、同じ確率を割り当てた答えを作る */
function uniformAnswers(requirementId: string, value: number): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const facet of CATALOG_FACETS) {
    answers[catalogQuestionName(requirementId, facet.id)] = noul(value);
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

describe("語彙の決めどころの目録（04 §3 P3・05 §3）", () => {
  it("すべて指定されていれば、未指定は無い", async () => {
    const answers = { ...uniformAnswers("R-1", 1), ...uniformAnswers("R-2", 0.9) };
    const { judge } = recordingJudge(answers);
    const result = await runCatalog({ requirements: REQUIREMENTS, judge, threshold: NOUL_THRESHOLD });
    expect(result.unspecified).toEqual([]);
  });

  it("確率が閾値未満の観点だけを未指定にし、目録の critical を持たせる", async () => {
    const answers = { ...uniformAnswers("R-1", 1), ...uniformAnswers("R-2", 0.2) };
    const { judge } = recordingJudge(answers);
    const result = await runCatalog({
      requirements: [{ id: "R-2", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    // 目録の順に並ぶ
    expect(result.unspecified.map((facet) => facet.facetId)).toEqual(CATALOG_FACETS.map((facet) => facet.id));
    expect(result.unspecified.every((facet) => facet.requirementId === "R-2")).toBe(true);
    expect(result.unspecified.every((facet) => facet.specified === 0.2)).toBe(true);
    // critical は目録から写す
    const aggregation = result.unspecified.find((facet) => facet.facetId === "aggregation");
    expect(aggregation?.critical).toBe(true);
    const period = result.unspecified.find((facet) => facet.facetId === "period");
    expect(period?.critical).toBe(false);
  });

  it("閾値ちょうどは指定と見なし、未指定にしない（境目）", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-1", NOUL_THRESHOLD));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    expect(result.unspecified).toEqual([]);
  });

  it("要件 × 観点を 1 回の呼び出しで聞く（扇形）", async () => {
    const answers = { ...uniformAnswers("R-1", 1), ...uniformAnswers("R-2", 1) };
    const { judge, requests } = recordingJudge(answers);
    await runCatalog({ requirements: REQUIREMENTS, judge, threshold: NOUL_THRESHOLD });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(REQUIREMENTS.length * CATALOG_FACETS.length);
    expect(requests[0]?.questions[catalogQuestionName("R-1", "aggregation")]).toMatchObject({ kind: "noul" });
    expect(Object.keys(requests[0]?.questions ?? {})).toContain(catalogQuestionName("R-2", "editable-by"));
  });

  it("要件が無ければ、判定を呼ばずに空を返す", async () => {
    const { judge, requests } = recordingJudge({});
    const result = await runCatalog({ requirements: [], judge, threshold: NOUL_THRESHOLD });
    expect(requests).toEqual([]);
    expect(result).toEqual({ unspecified: [], judgments: [] });
  });

  it("判定の記録に、問いの ID・確率・モデルの版を残す", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-1", 0.3));
    const result = await runCatalog({
      requirements: [{ id: "R-1", text: "件数を合計する" }],
      judge,
      threshold: NOUL_THRESHOLD,
    });
    expect(result.judgments[0]).toEqual({
      questionId: catalogQuestionName("R-1", "aggregation"),
      specified: 0.3,
      model: "fake-judge",
      answeredBy: "fake",
    });
  });

  it("未指定の観点は、未解決の事項（open）に写せる", async () => {
    const { judge } = recordingJudge(uniformAnswers("R-1", 0.1));
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
      text: first.question,
      critical: first.critical,
      status: "open",
    });
  });
});
