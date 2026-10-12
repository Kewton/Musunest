// P3 の洗い出し（plan/surface.ts）の unit テスト（04-plan-agent.md §3 P3・§5・U-P2）。
//
// **偽物の LLM で回す。実 API は呼ばない。** ここで固定したいのは 4 つ。
//   1. 規則とデータを分け、データは要件の一覧だけ・JSON Schema を付ける
//   2. 制約 ID の無い「書けない」は断る（#332 と同じ裏付け）
//   3. 文書に無い制約 ID を使った「書けない」も断る
//   4. 代わりの案（alternative）が無い「書けない」は形で断る
import { describe, expect, it } from "vitest";
import { maxOutputTokensForEffort } from "../limits.js";
import {
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  makeGateway,
} from "../stages/__tests__/prompt.js";
import { SURFACE_RULES, SURFACE_SCHEMA_NAME, checkSurfaceOutput, runSurface, type SurfaceCatalogData } from "./surface.js";

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

  it("出力の上限は、自分の段（surface）の値になる（02 §1.5・Issue #399）", async () => {
    const { recording, outcome } = run(SURFACE_OUTPUT);
    await outcome;
    expect(recording.structured[0]?.maxOutputTokens).toBe(maxOutputTokensForEffort("high", "surface"));
  });
});

// ── Issue #419：目録の点検の結果をデータに渡す ─────────────────────────

describe("目録の点検の結果をデータに渡す（04 §3 P3・Issue #419）", () => {
  /** 目録の点検の結果（3 つの欄。値と理由はコードの定数） */
  const CATALOG: SurfaceCatalogData = {
    targets: [{ requirementId: "R-1", facetId: "period", status: "開いている" }],
    openIssues: [
      {
        id: "OI:catalog:R-1:period",
        requirementId: "R-1",
        facetId: "period",
        text: "要件 R-1「タスクを記録できる」について：対象にする期間（いつからいつまでか）",
      },
    ],
    defaults: [
      {
        issueId: "OI:catalog:R-1:current-period",
        requirementId: "R-1",
        facetId: "current-period",
        value: "今の期間を含む",
        reason: "語彙は、期間の条件（within）を書かなければ期間で絞らず、今の期間を含む（語彙の意味 §within）",
      },
    ],
  };

  it("3 つの欄が、別々のデータ（<data name=>）として入る", async () => {
    const recorded = [
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
    ];
    const recording = createRecordingClient(recorded);
    const outcome = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      catalog: CATALOG,
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 要件の一覧 + 3 つの欄で、データは 4 つ
    expect(request.input.match(/<data name=/g)).toHaveLength(4);
    expect(request.input).toContain('<data name="要件の一覧">');
    expect(request.input).toContain('<data name="目録が点検した対象">');
    expect(request.input).toContain('<data name="開いている事項">');
    expect(request.input).toContain('<data name="仮に適用した既定">');
    // 規則の側には、データの名前が入らない（規則とデータを分ける）
    expect(request.instructions).not.toContain("仮に適用した既定");
  });

  it("規則の文に「目録に無いもの」の一律の文が無く、挙げない条件と挙げる条件がある", () => {
    const text = SURFACE_RULES.join("\n");
    // 一律の文（置き換える前の規則）が無い
    expect(text).not.toContain("目録に無いもの");
    // 挙げない条件：同じ要件の同じ決めどころを、開いた事項か仮に適用した既定が覆う
    expect(text).toContain("同じ要件の同じ決めどころ");
    expect(text).toContain("開いている事項");
    expect(text).toContain("仮に適用した既定");
    // 挙げる条件：対象違い・判定不明・矛盾・重大・明示と既定の衝突・書けないこと
    expect(text).toContain("対象の要件が違う");
    expect(text).toContain("判定不明");
    expect(text).toContain("当てはまらない");
    expect(text).toContain("矛盾");
    expect(text).toContain("重大");
    expect(text).toContain("明示");
    expect(text).toContain("書けない");
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
    // 分類（コード）も残る（Issue #397）
    expect(result.failure.problems[0]?.code).toBe("constraint-id-missing");
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
    // 分類（コード）も残る（Issue #397）
    expect(result.failure.problems[0]?.code).toBe("constraint-id-unknown");
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

// ── 計測で断られた形が通り、門は緩めない（Issue #398）──────────────────

describe("計測で断られた形が通り、門は緩めない（Issue #398）", () => {
  it("実物の ID と記号つきの見出しが通る", async () => {
    const output = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["R-VOCAB-01"], reason: "理由", alternative: "代わり" },
        { id: "U-2", requirementId: "R-1", part: "部分", constraintIds: ["R-TYPE-07"], reason: "理由", alternative: "代わり" },
        { id: "U-3", requirementId: "R-1", part: "部分", constraintIds: ["R-NAME-10"], reason: "理由", alternative: "代わり" },
        { id: "U-4", requirementId: "R-1", part: "部分", constraintIds: ["### computed"], reason: "理由", alternative: "代わり" },
        { id: "U-5", requirementId: "R-1", part: "部分", constraintIds: ["### 宣言の全体"], reason: "理由", alternative: "代わり" },
      ],
    };
    const { outcome } = run(output);
    const result = await outcome;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 申告に残す ID も正規化後である（Issue #398）
    expect(result.value.unwritable[0]?.constraintIds).toEqual(["R-VOCAB-01"]);
    expect(result.value.unwritable[3]?.constraintIds).toEqual(["computed"]);
    expect(result.value.unwritable[4]?.constraintIds).toEqual(["宣言の全体"]);
  });

  it("文書に無い ID と、正規化しても知らない ID は今までどおり断る", async () => {
    for (const id of ["R-999", "### ### computed", "#### nope", "`computed", "computed`"]) {
      const output = {
        ambiguities: [],
        unwritable: [
          { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: [id], reason: "理由", alternative: "代わり" },
        ],
      };
      const result = await run(output).outcome;
      expect(result.ok, id).toBe(false);
      if (result.ok || result.failure.kind !== "unmet") continue;
      expect(result.failure.problems[0]?.code, id).toBe("constraint-id-unknown");
    }
  });

  it("規則の文と断る文言に、記号つき（### ）の例が無い", async () => {
    for (const rule of SURFACE_RULES) expect(rule).not.toContain("### ");
    const output = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: [], reason: "理由", alternative: "代わり" },
      ],
    };
    const result = await run(output).outcome;
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "unmet") return;
    for (const problem of result.failure.problems) expect(problem.message).not.toContain("### ");
  });
});
