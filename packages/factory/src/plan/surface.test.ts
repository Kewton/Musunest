// P3 の洗い出し（plan/surface.ts）の unit テスト（04-plan-agent.md §3 P3・§5・U-P2）。
//
// **偽物の LLM で回す。実 API は呼ばない。** ここで固定したいのは 4 つ。
//   1. 規則とデータを分け、データは要件の一覧だけ・JSON Schema を付ける
//   2. 制約 ID の無い「書けない」は断る（#332 と同じ裏付け）
//   3. 文書に無い制約 ID を使った「書けない」も断る
//   4. 代わりの案（alternative）が無い「書けない」は形で断る
import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  makeGateway,
} from "../stages/__tests__/prompt.js";
import { SURFACE_SCHEMA_NAME, checkSurfaceOutput, runSurface } from "./surface.js";

/** 正しい応答（未解決の事項 1 件・書けないこと 1 件） */
const SURFACE_OUTPUT = {
  ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true }],
  unwritable: [
    {
      id: "U-1",
      requirementId: "R-2",
      part: "アプリ自体の名前",
      constraintIds: ["アプリの名前・説明"],
      reason: "宣言に欄が無い",
      alternative: "題名を画面の見出しとして置く",
    },
  ],
};

function run(output: unknown) {
  // 形が合わない応答は 1 回だけやり直すので、記録は 2 つ用意する
  const recorded = [
    { kind: "structured" as const, output, usage: undefined },
    { kind: "structured" as const, output, usage: undefined },
  ];
  const recording = createRecordingClient(recorded);
  return {
    recording,
    outcome: runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    }),
  };
}

describe("P3 の洗い出しが送る要求を観測する（04 §2.2）", () => {
  it("規則とデータが別で、データは要件の一覧だけ・JSON Schema が付く", async () => {
    const { recording, outcome } = run(SURFACE_OUTPUT);
    const result = await outcome;
    expect(result.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.schemaName).toBe(SURFACE_SCHEMA_NAME);
    expect(request.input).toContain("要件の一覧");
    expect(request.instructions).not.toContain("要件の一覧");
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
    // データは要件の一覧ただ 1 つ（原文は渡さない。04 §2.2）
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
  });
});

describe("P3 の形の確認", () => {
  it("正しい応答は固定できる", () => {
    const checked = checkSurfaceOutput(SURFACE_OUTPUT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.ambiguities).toHaveLength(1);
    expect(checked.value.unwritable[0]?.alternative).toBe("題名を画面の見出しとして置く");
  });

  it("代わりの案が無ければ、欄つきで断る（U-P2）", () => {
    const bad = checkSurfaceOutput({
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-2", part: "部分", constraintIds: ["記録"], reason: "理由" },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("unwritable[0].alternative");
  });
});

describe("P3 の書けないことの裏付け（04 §3 P3・#332）", () => {
  it("制約 ID の無い書けないことは断る（やり直しても通らなければ unmet）", async () => {
    const output = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-1",
          requirementId: "R-2",
          part: "部分",
          constraintIds: [],
          reason: "理由",
          alternative: "代わり",
        },
      ],
    };
    const { outcome } = run(output);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.problems.some((problem) => problem.field === "unwritable[0].constraintIds")).toBe(true);
  });

  it("文書に無い制約 ID を使った書けないことも断る", async () => {
    const output = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-1",
          requirementId: "R-2",
          part: "部分",
          constraintIds: ["文書に無い ID"],
          reason: "理由",
          alternative: "代わり",
        },
      ],
    };
    const { outcome } = run(output);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.problems.some((problem) => problem.message.includes("文書に無い制約 ID"))).toBe(true);
  });

  it("文書にある制約 ID（契約の R-… と語彙の ### 見出し）なら通す", async () => {
    const output = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["R-2"], reason: "理由", alternative: "代わり" },
        { id: "U-2", requirementId: "R-2", part: "部分", constraintIds: ["合計"], reason: "理由", alternative: "代わり" },
      ],
    };
    const { outcome } = run(output);
    const result = await outcome;
    expect(result.ok).toBe(true);
  });
});
