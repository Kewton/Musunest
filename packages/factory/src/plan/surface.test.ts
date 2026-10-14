// P3 の洗い出し（plan/surface.ts）の unit テスト（04-plan-agent.md §3 P3・§5・U-P2）。
//
// **偽物の LLM で回す。実 API は呼ばない。** ここで固定したいのは 4 つ。
//   1. 規則とデータを分け、データは要件の一覧だけ・JSON Schema を付ける
//   2. 制約 ID の無い「書けない」は断る（#332 と同じ裏付け）
//   3. 文書に無い制約 ID を使った「書けない」も断る
//   4. 代わりの案（alternative）が無い「書けない」は形で断る
import { describe, expect, it } from "vitest";
import { JobBudget } from "../budget.js";
import { CallGateway } from "../call.js";
import { maxOutputTokensForEffort } from "../limits.js";
import { ENVELOPE_SCHEMA, envelopeStageFor } from "../schema-envelope.js";
import { COMMON_RULES, PREVIOUS_RESPONSE_DATA_NAME, SHAPE_PROBLEMS_DATA_NAME, serializeJson } from "../stages/prompt.js";
import type { LlmClient } from "../llm.js";
import {
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  makeGateway,
} from "../stages/__tests__/prompt.js";
import { SURFACE_DIFF_SCHEMA_NAME, SURFACE_RULES, SURFACE_SCHEMA, SURFACE_SCHEMA_NAME, SURFACE_SHOWN_ID_SOURCES, buildSurfaceDiffSchema, checkSurfaceOutput, checkSurfaceTargets, runSurface, surfaceIdReuseOf, type PlanSurface, type SurfaceCatalogData, type SurfaceContext, type SurfaceInput, type SurfaceShownIdSource, type SurfaceShownIssueIds, type SurfaceTargetAttempt } from "./surface.js";

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

  it("目印の制約 ID でも、message に値が出ず、field が添字を持つ（Issue #445）", async () => {
    const mark = "MARKER445";
    const output = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-1",
          requirementId: "R-1",
          part: "部分",
          constraintIds: [`未知-${mark}`],
          reason: "理由",
          alternative: "代わり",
        },
      ],
    };
    const result = await run(output).outcome;
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "unmet") return;
    expect(result.failure.problems.some((problem) => problem.code === "constraint-id-unknown")).toBe(true);
    expect(result.failure.problems[0]?.field).toBe("unwritable[0].constraintIds");
    expect(JSON.stringify(result.failure.problems)).not.toContain(mark);
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

// ── Issue #434：差分の洗い出しに、参照用の文脈を別のデータとして渡す ───────────

describe("差分の洗い出しに、参照用の文脈を別のデータとして渡す（04 §3 P3・Issue #434）", () => {
  /** `<data name="…">…</data>` の中身を取り出す（データの欄ごとに確かめる） */
  const dataBlockOf = (input: string, name: string): string =>
    input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";

  /** 点検の対象（差分だけ。位置は 0〜0） */
  const DIFF_LIST = {
    requirements: [
      {
        id: "R:A:Q1-1",
        text: "確定した要件の文: 全員で数える\n参考の文脈: 問い Q1-1: 誰の分を数えるか 未解決の事項 OI-1: 誰の分を数えるか",
        quote: "全員で数える",
        position: { start: 0, end: 0 },
      },
    ],
    decisions: [],
    unresolved: [],
  };

  /** 目録の点検の結果（仮適用。3 つの欄の形は既存のまま） */
  const CATALOG: SurfaceCatalogData = {
    targets: [{ requirementId: "R:A:Q1-1", facetId: "period", status: "開いている" }],
    openIssues: [
      {
        id: "OI:catalog:R:A:Q1-1:period",
        requirementId: "R:A:Q1-1",
        facetId: "period",
        text: "要件 R:A:Q1-1 について：対象にする期間（いつからいつまでか）",
      },
    ],
    defaults: [],
  };

  /** 参照用の文脈（点検時点の全要件・既存の決定・了承除外・関係する問いと答え） */
  const CONTEXT: SurfaceContext = {
    requirements: [
      { id: "R-1", text: "タスクを記録できる", origin: "S-1" },
      { id: "R-2", text: "件数を合計できる", origin: "S-2" },
      { id: "R:A:Q1-1", text: "確定した要件の文: 全員で数える", origin: "A:Q1-1" },
    ],
    decisions: [
      {
        id: "D-1",
        subject: "既定で決めた",
        value: "記録の形は 1 行とした",
        reason: "Plan が既定で決めた（確認の画面で直せる）",
      },
    ],
    acceptedUnwritable: [
      {
        part_id: "P:U-0",
        alternative_id: "R:alt:U-0",
        basis: { doc_version: "v1", location: "部分", constraint_id: "記録" },
      },
    ],
    questionsAndAnswers: [
      { questionId: "Q1-1", question: "誰の分を数えるか", answerId: "A:Q1-1", answer: "全員で数える" },
    ],
  };

  /** 1 回まわして、送った要求と結果を返す */
  function runWith(options: { catalog?: SurfaceCatalogData; context?: SurfaceContext }) {
    const recorded = [
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
    ];
    const recording = createRecordingClient(recorded);
    const outcome = runSurface({
      list: DIFF_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      ...options,
    });
    return { recording, outcome };
  }

  it("参照用の文脈を渡すと、全要件・既存の決定・了承除外・関係する問いと答えが別々のデータとして入り、点検の対象は差分だけである", async () => {
    const { recording, outcome } = runWith({ catalog: CATALOG, context: CONTEXT });
    const result = await outcome;
    expect(result.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 要件の一覧 + 目録の 3 つ + 文脈の 4 つ = 8 つ
    expect(request.input.match(/<data name=/g)).toHaveLength(8);
    expect(request.input).toContain('<data name="点検時点の全要件">');
    expect(request.input).toContain('<data name="既存の決定">');
    expect(request.input).toContain('<data name="了承除外">');
    expect(request.input).toContain('<data name="関係する問いと答え">');
    // 点検の対象（要件の一覧）は、差分の R:A:Q1-1 だけである
    const target = dataBlockOf(request.input, "要件の一覧");
    expect(target).toContain("R:A:Q1-1");
    expect(target).not.toContain("R-1");
    expect(target).not.toContain("R-2");
    // 文脈には、全要件・既存の決定・了承除外・関係する問いと答えが入る
    expect(dataBlockOf(request.input, "点検時点の全要件")).toContain("R-2");
    expect(dataBlockOf(request.input, "既存の決定")).toContain("D-1");
    expect(dataBlockOf(request.input, "了承除外")).toContain("R:alt:U-0");
    expect(dataBlockOf(request.input, "関係する問いと答え")).toContain("A:Q1-1");
    // 代わりの案の採否・合否の目印の文字列は、文脈に入らない
    const contextText = ["点検時点の全要件", "既存の決定", "了承除外", "関係する問いと答え"]
      .map((name) => dataBlockOf(request.input, name))
      .join("\n");
    for (const marker of ["受理", "棄却", "合否", "採否", "accepted", "rejected"]) {
      expect(contextText).not.toContain(marker);
    }
    // 規則の側には、データの名前が入らない（規則とデータを分ける）
    expect(request.instructions).not.toContain("点検時点の全要件");
  });

  it("参照用の文脈を渡さなければ、要求のデータの数は既存のままである", async () => {
    const { recording, outcome } = runWith({ catalog: CATALOG });
    const result = await outcome;
    expect(result.ok).toBe(true);
    const request = recording.structured[0];
    if (request === undefined) return;
    // 要件の一覧 + 目録の 3 つ = 4 つ（文脈の分は増えない）
    expect(request.input.match(/<data name=/g)).toHaveLength(4);
    expect(request.input).not.toContain("点検時点の全要件");
    expect(request.input).not.toContain("関係する問いと答え");
  });
});

// ── Issue #434：応答が指す要件 ID を、点検の対象（その往復の差分）へ照合する ──────

describe("応答が指す要件 ID を、点検の対象（その往復の差分）へ照合する（04 §3 P3・Issue #434）", () => {
  /** 正しい応答を、形の検査を通した `PlanSurface` にする */
  function parsed(): PlanSurface {
    const checked = checkSurfaceOutput(SURFACE_OUTPUT);
    if (!checked.ok) throw new Error("題材の応答が不正です");
    return checked.value;
  }

  it("点検の対象の内側を指す応答は、断らない", () => {
    const target = checkSurfaceTargets(parsed(), new Set(["R-1", "R-2"]));
    expect(target.problems).toEqual([]);
    expect(target.dropped).toEqual([]);
    expect(target.keptUnwritable).toHaveLength(1);
  });

  it("点検の対象に無い要件を指す応答は、欄つきで断る（重複として除くものが無ければ）", () => {
    const target = checkSurfaceTargets(parsed(), new Set(["R:A:Q1-1"]));
    expect(target.problems).toEqual([
      {
        field: "unwritable[0].requirementId",
        code: "requirement-id-unknown",
        message: "点検の対象（その往復の差分）に無い要件を指している",
      },
      {
        field: "ambiguities[0].requirementId",
        code: "requirement-id-unknown",
        message: "点検の対象（その往復の差分）に無い要件を指している",
      },
    ]);
    expect(target.dropped).toEqual([]);
    expect(target.rejected).toHaveLength(2);
    // 誤りの文に、要件 ID の値を入れない（止まった記録に漏らさない）
    for (const problem of target.problems) {
      expect(problem.message).not.toContain("R-1");
      expect(problem.message).not.toContain("R:A:Q1-1");
    }
  });

  it("対象外の「書けない」の申告を、dropClaim が真を返したときだけ重複として除く（曖昧さは除かない）", () => {
    const target = checkSurfaceTargets(parsed(), new Set(["R:A:Q1-1"]), (claim) => claim.requirementId === "R-2");
    // 申告だけが除かれ、曖昧さは断られる
    expect(target.dropped.map((item) => item.index)).toEqual([0]);
    expect(target.dropped[0]?.claim.requirementId).toBe("R-2");
    expect(target.keptUnwritable).toEqual([]);
    expect(target.rejected.map((ref) => ref.kind)).toEqual(["ambiguity"]);
    expect(target.problems.map((problem) => problem.field)).toEqual(["ambiguities[0].requirementId"]);
  });

  it("dropClaim が偽を返す申告は、重複として除かず断る", () => {
    const target = checkSurfaceTargets(parsed(), new Set(["R:A:Q1-1"]), () => false);
    expect(target.dropped).toEqual([]);
    expect(target.problems.map((problem) => problem.field)).toEqual([
      "unwritable[0].requirementId",
      "ambiguities[0].requirementId",
    ]);
  });
});

// ── Issue #434（D2）：制約 ID の正規化は 1 回だけ ─────────────────────────────

describe("制約 ID の正規化は 1 回だけである（Issue #434・D2）", () => {
  it("接頭辞が 1 つ残る既知 ID は通り、保存する値も 1 回だけ外した形になる", async () => {
    // `### action` と `### ### ### action` の見出しを持つ文書 → 制約集合は `action` と `### action`
    const documents = [{ name: "語彙の意味", text: "### action\n説明。\n### ### ### action\n説明。" }];
    const output = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["### ### action"], reason: "理由", alternative: "代わり" },
      ],
    };
    const recorded = [
      { kind: "structured" as const, output, usage: undefined },
      { kind: "structured" as const, output, usage: undefined },
    ];
    const recording = createRecordingClient(recorded);
    const result = await runSurface({
      list: REQUIREMENT_LIST,
      documents,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 保存する値は、1 回だけ外した `### action`（繰り返し外さない）
    expect(result.value.unwritable[0]?.constraintIds).toEqual(["### action"]);
  });
});

// ── Issue #464：データで見せた事項 ID を使い回した応答を、形の検査で断る ──────────────

describe("データで見せた事項 ID を使い回した応答を、形の検査で断る（04 §3 P3・Issue #464）", () => {
  /** 4 つの提示元すべてに 1 つずつ ID を入れた「見せた ID」（初回の 2 種・差分の 4 種を兼ねる） */
  const SHOWN: SurfaceShownIssueIds = {
    catalog: ["OI:catalog:R-1:period"],
    defaults: ["OI:catalog:R-1:auto"],
    inherited: ["OI:catalog:R:A:Q1-1:aggregation"],
    decisions: ["OI:catalog:R-1:asked"],
  };
  /** 提示元ごとの代表 ID */
  const ID_OF_SOURCE: Readonly<Record<SurfaceShownIdSource, string>> = {
    catalog: "OI:catalog:R-1:period",
    defaults: "OI:catalog:R-1:auto",
    inherited: "OI:catalog:R:A:Q1-1:aggregation",
    decisions: "OI:catalog:R-1:asked",
  };
  /** 見せた ID を使った応答（未解決の事項 1 件） */
  const reuseOutput = (id: string) => ({
    ambiguities: [{ id, requirementId: "R-1", text: "使い回し", critical: true }],
    unwritable: [],
  });
  /** 見せていない新しい ID の応答 */
  const NEW_OUTPUT = {
    ambiguities: [{ id: "OI:new:1", requirementId: "R-1", text: "新しい事項", critical: true }],
    unwritable: [],
  };

  it("固定の規則に、新しい事項の ID の文が入る", () => {
    const text = SURFACE_RULES.join("\n");
    expect(text).toContain("新しい事項の ID は、データで見せた事項の ID と同じにしない");
    expect(text).toContain("新しい ID");
  });

  it("初回の 2 種・差分の 4 種のどの提示元の ID と一致しても、応答全体を issue-id-reused で断る", () => {
    for (const source of SURFACE_SHOWN_ID_SOURCES) {
      const checked = checkSurfaceOutput(reuseOutput(ID_OF_SOURCE[source]), SHOWN);
      expect(checked.ok, source).toBe(false);
      if (checked.ok) continue;
      expect(
        checked.problems.some(
          (problem) => problem.field === "ambiguities[0].id" && problem.code === "issue-id-reused",
        ),
        source,
      ).toBe(true);
      // 誤りの文に、事項 ID の値を入れない
      for (const problem of checked.problems) expect(problem.message).not.toContain("OI:");
    }
  });

  it("見せていない ID・新しい ID は受理する", () => {
    for (const output of [NEW_OUTPUT, reuseOutput("OI:catalog:R-9:period")]) {
      const checked = checkSurfaceOutput(output, SHOWN);
      expect(checked.ok).toBe(true);
    }
  });

  it("見せた ID を使った応答は、2 回続けば malformed で止まる", async () => {
    const recording = createRecordingClient([
      { kind: "structured" as const, output: reuseOutput("OI:catalog:R-1:period"), usage: undefined },
      { kind: "structured" as const, output: reuseOutput("OI:catalog:R-1:period"), usage: undefined },
    ]);
    const result = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      shownIssueIds: SHOWN,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "malformed") return;
    expect(result.failure.attempts).toBe(2);
    expect(result.failure.problems.some((problem) => problem.code === "issue-id-reused")).toBe(true);
  });

  it("断ったあとに受理した応答には、制約の検査が掛かる", async () => {
    // 1 回目：使い回しで断る。2 回目：形は正しいが、制約 ID が無い（制約の検査で断る）
    const badConstraint = {
      ambiguities: [],
      unwritable: [{ id: "U-1", requirementId: "R-2", part: "部分", constraintIds: [], reason: "理由", alternative: "代わり" }],
    };
    const recording = createRecordingClient([
      { kind: "structured" as const, output: reuseOutput("OI:catalog:R-1:period"), usage: undefined },
      { kind: "structured" as const, output: badConstraint, usage: undefined },
    ]);
    const result = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      shownIssueIds: SHOWN,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "unmet") return;
    expect(result.failure.problems.some((problem) => problem.code === "constraint-id-missing")).toBe(true);
  });

  it("断った件を、試行ごとに onIdReuse で知らせる（値は入れない）", async () => {
    const rejections: { attempt: number; distinctIds: number; bySource: readonly { source: string; count: number }[] }[] = [];
    const recording = createRecordingClient([
      { kind: "structured" as const, output: reuseOutput("OI:catalog:R-1:period"), usage: undefined },
      { kind: "structured" as const, output: NEW_OUTPUT, usage: undefined },
    ]);
    const result = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      shownIssueIds: SHOWN,
      onIdReuse: (rejection) => rejections.push(rejection),
    });
    expect(result.ok).toBe(true);
    // 1 回目だけ断った（2 回目は受理）
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.attempt).toBe(1);
    expect(rejections[0]?.distinctIds).toBe(1);
    expect(rejections[0]?.bySource.find((entry) => entry.source === "catalog")?.count).toBe(1);
    expect(rejections[0]?.bySource.find((entry) => entry.source === "defaults")?.count).toBe(0);
    // 値（ID）は渡さない
    expect(JSON.stringify(rejections)).not.toContain("OI:");
  });

  it("同じ ID が複数の提示元に当たるときは、各提示元に数える（合計は異なる数と一致しない）", () => {
    const both = { ...SHOWN, defaults: ["OI:catalog:R-1:period"] };
    const reuse = surfaceIdReuseOf(reuseOutput("OI:catalog:R-1:period"), both);
    expect(reuse.distinctIds).toBe(1);
    expect(reuse.bySource.find((entry) => entry.source === "catalog")?.count).toBe(1);
    expect(reuse.bySource.find((entry) => entry.source === "defaults")?.count).toBe(1);
    // 提示元の合計（2）は、異なる数（1）と一致しない
    expect(reuse.bySource.reduce((total, entry) => total + entry.count, 0)).toBe(2);
  });
});

// ── Issue #483：差分の洗い出しの要件 ID を、差分からコードで組んだ選択肢（schema の enum）に限る ──────

describe("差分の洗い出しの schema（enum）を、その往復の差分から組む（04 §3 P3・Issue #483）", () => {
  /** その往復の差分の要件 ID（順どおり・重複なし） */
  const DIFF_IDS = ["R:A:Q1-1", "R:A:Q1-2"] as const;

  /** 試験と同じ単価（`makeGateway` と同じ値。予約の式を独立に組み立てる） */
  const RATES = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

  /**
   * 差分の要件 ID を（渡す・渡さないの両方で）1 回まわす。予算は任意で絞れる。**予約の額を読めるように、
   * `JobBudget` と `CallGateway` をここで直接組む**（`makeGateway` は `JobBudget` を返さない）。
   * 応答は usage 不明なので、成功しても予約は精算されず `reservedUsd` に残る（§1.5）。
   */
  function runWith(options: { targetRequirementIds?: readonly [string, ...string[]]; budgetUsd?: number }) {
    const recording = createRecordingClient([
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
    ]);
    const budget = new JobBudget(options.budgetUsd ?? 10);
    const gateway = new CallGateway({
      client: recording.client,
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 60_000,
      maxAttempts: 1,
    });
    const outcome = runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway,
      ...(options.targetRequirementIds === undefined ? {} : { targetRequirementIds: options.targetRequirementIds }),
    });
    return { recording, budget, gateway, outcome };
  }

  /** `<data name="…">…</data>` の中身を取り出す */
  const dataBlockOf = (input: string, name: string): string =>
    input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";

  /** `requirementId` の欄の `enum` と `description` を落とした写し（形の比較に使う） */
  function withoutRequirementIdContract(schema: unknown): unknown {
    const copy = JSON.parse(JSON.stringify(schema)) as {
      properties: Record<string, { items: { properties: Record<string, Record<string, unknown>> } }>;
    };
    for (const section of ["ambiguities", "unwritable"]) {
      const field = copy.properties[section]?.items.properties.requirementId;
      if (field !== undefined) {
        delete field.enum;
        delete field.description;
      }
    }
    return copy;
  }

  /** 組んだ schema の、両方の欄の要件 ID の `enum` を直接読む */
  function enumsOf(built: Record<string, unknown>): {
    readonly ambiguities: readonly string[] | undefined;
    readonly unwritable: readonly string[] | undefined;
  } {
    const properties = built["properties"] as {
      readonly ambiguities: { readonly items: { readonly properties: { readonly requirementId: { readonly enum?: readonly string[] } } } };
      readonly unwritable: { readonly items: { readonly properties: { readonly requirementId: { readonly enum?: readonly string[] } } } };
    };
    return {
      ambiguities: properties.ambiguities.items.properties.requirementId.enum,
      unwritable: properties.unwritable.items.properties.requirementId.enum,
    };
  }

  it("(a) 並びを渡すと、差分専用の名前になり、両方の欄の enum が並びのとおりで、SURFACE_SCHEMA は変わらない", async () => {
    const { recording, outcome } = runWith({ targetRequirementIds: DIFF_IDS });
    expect((await outcome).ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.schemaName).toBe(SURFACE_DIFF_SCHEMA_NAME);
    // 組んだ schema は、純粋な関数の結果に一致する
    expect(request.schema).toEqual(buildSurfaceDiffSchema(DIFF_IDS));
    const schema = request.schema as {
      properties: {
        ambiguities: { items: { properties: { requirementId: { enum: readonly string[] } } } };
        unwritable: { items: { properties: { requirementId: { enum: readonly string[] } } } };
      };
    };
    expect(schema.properties.ambiguities.items.properties.requirementId.enum).toEqual([...DIFF_IDS]);
    expect(schema.properties.unwritable.items.properties.requirementId.enum).toEqual([...DIFF_IDS]);
    // enum と description を除いた schema は、SURFACE_SCHEMA と等しい
    expect(withoutRequirementIdContract(request.schema)).toEqual(withoutRequirementIdContract(SURFACE_SCHEMA));
    // SURFACE_SCHEMA そのものは、呼んだあとも変わらない
    expect(SURFACE_SCHEMA.properties.ambiguities.items.properties.requirementId).toEqual({
      type: "string",
      description: "対象の要件 ID",
    });
    expect(SURFACE_SCHEMA.properties.unwritable.items.properties.requirementId).toEqual({
      type: "string",
      description: "対象の要件 ID",
    });
  });

  it("(a2) 並びに重複があっても、両方の欄の enum は最初の出現の順で一意になる（SURFACE_SCHEMA は不変）", () => {
    // 重複の入力：両方の欄とも、最初の出現の順（R:b → R:a）で一意になる
    const duplicated = enumsOf(buildSurfaceDiffSchema(["R:b", "R:a", "R:b"] as const));
    expect(duplicated.ambiguities).toEqual(["R:b", "R:a"]);
    expect(duplicated.unwritable).toEqual(["R:b", "R:a"]);
    // 並べ替えない（挿入の順のまま）
    expect(duplicated.ambiguities).not.toEqual(["R:a", "R:b"]);
    // 1 件の入力：その 1 件だけ
    const single = enumsOf(buildSurfaceDiffSchema(["R:a"] as const));
    expect(single.ambiguities).toEqual(["R:a"]);
    expect(single.unwritable).toEqual(["R:a"]);
    // enum と description を除いた形は SURFACE_SCHEMA と等しく、SURFACE_SCHEMA は変わらない（enum を持たない）
    expect(withoutRequirementIdContract(buildSurfaceDiffSchema(["R:b", "R:a", "R:b"] as const))).toEqual(
      withoutRequirementIdContract(SURFACE_SCHEMA),
    );
    expect("enum" in SURFACE_SCHEMA.properties.ambiguities.items.properties.requirementId).toBe(false);
    expect("enum" in SURFACE_SCHEMA.properties.unwritable.items.properties.requirementId).toBe(false);
  });

  it("(b) 並びを渡さないと、要求は変更前と等しく、データの塊の数も変わらない", async () => {
    const { recording, outcome } = runWith({});
    expect((await outcome).ok).toBe(true);
    const request = recording.structured[0];
    if (request === undefined) return;
    expect(request.schemaName).toBe(SURFACE_SCHEMA_NAME);
    // schema は SURFACE_SCHEMA そのもの（写しを作らない）
    expect(request.schema).toBe(SURFACE_SCHEMA);
    expect(request.instructions).toBe(COMMON_RULES.join("\n"));
    expect(request.rules).toEqual(SURFACE_RULES);
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
    expect(request.input).toBe(`<data name="要件の一覧">\n${serializeJson(REQUIREMENT_LIST)}\n</data>`);
    expect(request.maxOutputTokens).toBe(maxOutputTokensForEffort("high", "surface"));
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
  });

  it("(c) 並びを渡すと「出力に許される要件 ID」の塊がちょうど 1 つ増え、instructions・documents・rules は変わらない", async () => {
    const bare = runWith({});
    const withList = runWith({ targetRequirementIds: DIFF_IDS });
    expect((await bare.outcome).ok).toBe(true);
    expect((await withList.outcome).ok).toBe(true);
    const without = bare.recording.structured[0];
    const request = withList.recording.structured[0];
    if (without === undefined || request === undefined) return;
    const names = [...request.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names.filter((name) => name === "出力に許される要件 ID")).toHaveLength(1);
    // 「要件の一覧」の直後である
    expect(names[0]).toBe("要件の一覧");
    expect(names[1]).toBe("出力に許される要件 ID");
    // JSON として読むと、渡した並びに等しい
    expect(JSON.parse(dataBlockOf(request.input, "出力に許される要件 ID"))).toEqual([...DIFF_IDS]);
    // 渡さないときと、前置きは変わらない
    expect(request.instructions).toBe(without.instructions);
    expect(request.documents).toEqual(without.documents);
    expect(request.rules).toEqual(without.rules);
    expect(request.maxOutputTokens).toBe(without.maxOutputTokens);
  });

  it("(d) 差分専用の名前は封筒から引けず、ENVELOPE_SCHEMA は変わらない", () => {
    expect(envelopeStageFor(SURFACE_DIFF_SCHEMA_NAME)).toBeUndefined();
    expect(JSON.stringify(ENVELOPE_SCHEMA)).not.toContain(SURFACE_DIFF_SCHEMA_NAME);
    // 初回の洗い出しの段は、今までどおり封筒に載っている
    expect(envelopeStageFor(SURFACE_SCHEMA_NAME)?.stage).toBe(SURFACE_SCHEMA_NAME);
    expect(JSON.stringify(ENVELOPE_SCHEMA)).toContain(SURFACE_SCHEMA_NAME);
  });

  it("(d2) 実際に予約された額の前後差が、schema とデータの増分（独立に数えたもの）と一致する", async () => {
    const bare = runWith({});
    const withList = runWith({ targetRequirementIds: DIFF_IDS });
    expect((await bare.outcome).ok).toBe(true);
    expect((await withList.outcome).ok).toBe(true);
    // usage 不明の成功応答なので、予約は精算されず reservedUsd に残る（§1.5）
    const reservedWithout = bare.budget.reservedUsd;
    const reservedWith = withList.budget.reservedUsd;
    // 実際に予約された額は、並びを渡した方が多い
    expect(reservedWith).toBeGreaterThan(reservedWithout);
    // 増分を、schema（の名前・enum・description）とデータの塊（囲みを含む）の文字数から独立に数える
    const schemaDelta =
      JSON.stringify({ name: SURFACE_DIFF_SCHEMA_NAME, schema: buildSurfaceDiffSchema(DIFF_IDS) }).length -
      JSON.stringify({ name: SURFACE_SCHEMA_NAME, schema: SURFACE_SCHEMA }).length;
    const dataDelta = `\n<data name="出力に許される要件 ID">\n${serializeJson(DIFF_IDS)}\n</data>`.length;
    // 予約の差は、その増分に対応する分だけである（同じ文書・同じ出力の上限）
    expect(reservedWith - reservedWithout).toBeCloseTo((schemaDelta + dataDelta) * RATES.inputPerToken, 10);
  });

  it("(d3) 予算が渡さない要求の予約の分しか無ければ、渡した要求は budget で止まり、渡さない要求は 1 回開始して成功する", async () => {
    // 渡さない要求の予約の額を、実際の残り（reservedUsd）から測る
    const measured = runWith({});
    expect((await measured.outcome).ok).toBe(true);
    const reservation = measured.budget.reservedUsd;
    expect(reservation).toBeGreaterThan(0);

    // 対照：同じ残高（予約 = 残高 は通る）で、並びを渡さない方は 1 回開始して成功する
    const control = runWith({ budgetUsd: reservation });
    expect((await control.outcome).ok).toBe(true);
    expect(control.gateway.counts.attempts.started).toBe(1);

    // 本題：並びを渡した方は、同じ残高では予約が通らず budget で止まり、開始は 0
    const limited = runWith({ targetRequirementIds: DIFF_IDS, budgetUsd: reservation });
    const result = await limited.outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("budget");
    expect(limited.gateway.counts.attempts.started).toBe(0);
    expect(limited.gateway.counts.attempts.not_started.budget).toBe(1);
  });
});

// ── Issue #484：照合を check の中へ移し、対象外の参照を形のやり直しへ返す ───────────────

describe("照合を check の中へ移し、対象外の参照を形のやり直しへ返す（04 §3 P3・Issue #484）", () => {
  /** その往復の差分の要件 ID（点検の対象） */
  const DIFF_IDS = ["R:A:Q1-1"] as const;
  /** `<data name="…">…</data>` の中身を取り出す（データの欄ごとに確かめる） */
  const dataBlockOf = (input: string, name: string): string =>
    input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";
  /** 対象外の要件 ID を指す未解決の事項 1 件 */
  const OUT_OF_SCOPE = {
    ambiguities: [{ id: "OI-x", requirementId: "R-1", text: "対象外の事項", critical: true }],
    unwritable: [],
  };
  /** 点検の対象の内側を指す未解決の事項 1 件 */
  const IN_SCOPE = {
    ambiguities: [{ id: "OI-y", requirementId: "R:A:Q1-1", text: "対象内の事項", critical: true }],
    unwritable: [],
  };
  /** 対象外の要件 ID を指す「書けない」の申告 1 件 */
  const OUT_OF_SCOPE_CLAIM = {
    ambiguities: [],
    unwritable: [
      { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };
  /** 形で落ちる応答（代わりの案が無い） */
  const BAD_SHAPE = {
    ambiguities: [],
    unwritable: [
      { id: "U-1", requirementId: "R:A:Q1-1", part: "部分", constraintIds: ["記録"], reason: "理由" },
    ],
  };
  /** 点検の対象の内側だが、文書に無い制約 ID を使う申告 */
  const BAD_CONSTRAINT = {
    ambiguities: [],
    unwritable: [
      { id: "U-1", requirementId: "R:A:Q1-1", part: "部分", constraintIds: ["文書に無い ID"], reason: "理由", alternative: "代案" },
    ],
  };
  /** 対象外の参照と制約の誤り（空の制約）が同居する応答 */
  const MIXED_CONSTRAINT = {
    ambiguities: [{ id: "OI-o", requirementId: "R-1", text: "対象外の事項", critical: true }],
    unwritable: [
      { id: "U-1", requirementId: "R:A:Q1-1", part: "部分", constraintIds: [], reason: "理由", alternative: "代案" },
    ],
  };

  /** 照合を渡して 1 回まわす（記録・共通の口・試行の結果を返す） */
  function runTarget(outputs: readonly unknown[], options: Partial<SurfaceInput> = {}) {
    const recorded = outputs.map((output) => ({ kind: "structured" as const, output, usage: undefined }));
    const recording = createRecordingClient(recorded);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    const attempts: SurfaceTargetAttempt[] = [];
    const outcome = runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway,
      targetRequirementIds: DIFF_IDS,
      dropClaim: () => false,
      onTargetAttempt: (attempt) => attempts.push(attempt),
      ...options,
    });
    return { recording, gateway, attempts, outcome };
  }

  it("(a) 1 試行目が対象外、2 試行目が対象内なら、やり直し 1 回で成功し、2 試行目の input に前回の応答と問題の塊が入る", async () => {
    const { recording, gateway, outcome } = runTarget([OUT_OF_SCOPE, IN_SCOPE]);
    const result = await outcome;
    expect(result.ok).toBe(true);
    // 呼び出しは 2、形のやり直しの告知は 1（新しい呼び出しの枠を作らない）
    expect(recording.structured).toHaveLength(2);
    expect(gateway.counts.attempts.started).toBe(2);
    expect(gateway.counts.retries.shape).toBe(1);
    const first = recording.structured[0];
    const second = recording.structured[1];
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    // 前回の問題の塊：欄・分類・今の固定文（値を入れない）
    const problemsBlock = dataBlockOf(second.input, SHAPE_PROBLEMS_DATA_NAME);
    expect(JSON.parse(problemsBlock)).toEqual([
      {
        field: "ambiguities[0].requirementId",
        code: "requirement-id-unknown",
        message: "点検の対象（その往復の差分）に無い要件を指している",
      },
    ]);
    // 誤りの文と欄に、要件 ID の値を入れない
    expect(problemsBlock).not.toContain("R-1");
    expect(problemsBlock).not.toContain("R:A:Q1-1");
    // #479 の前回の応答の塊があり、JSON として読むと 1 試行目の output と等しい
    expect(JSON.parse(dataBlockOf(second.input, PREVIOUS_RESPONSE_DATA_NAME))).toEqual(OUT_OF_SCOPE);
    // 前置き（instructions・documents・rules・schema）は 1 試行目と等しい
    expect(second.instructions).toBe(first.instructions);
    expect(second.documents).toEqual(first.documents);
    expect(second.rules).toEqual(first.rules);
    expect(second.schema).toEqual(first.schema);
  });

  it("(b) 2 試行とも対象外を指すと、unmet・試行 2・最後の試行の問題（requirement-id-unknown）で終わり、呼び出しは 2 のまま", async () => {
    const { gateway, outcome } = runTarget([OUT_OF_SCOPE, OUT_OF_SCOPE]);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.attempts).toBe(2);
    expect(result.failure.problems).toEqual([
      {
        field: "ambiguities[0].requirementId",
        code: "requirement-id-unknown",
        message: "点検の対象（その往復の差分）に無い要件を指している",
      },
    ]);
    expect(gateway.counts.attempts.started).toBe(2);
  });

  it("(c) 1 試行目が照合で、2 試行目が形の検査で落ちると、malformed・試行 2（前の試行の対象の誤りで上書きしない）", async () => {
    const { outcome } = runTarget([OUT_OF_SCOPE, BAD_SHAPE]);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("malformed");
    if (result.failure.kind !== "malformed") return;
    expect(result.failure.attempts).toBe(2);
    expect(result.failure.problems.some((problem) => problem.field === "unwritable[0].alternative")).toBe(true);
    expect(result.failure.problems.some((problem) => problem.code === "requirement-id-unknown")).toBe(false);
  });

  it("(c2) 1 試行目が事項 ID の使い回し、2 試行目が対象外を指すと、unmet・試行 2・やり直しの告知 1・呼び出し 2（追加の開始なし）", async () => {
    const SHOWN: SurfaceShownIssueIds = { catalog: ["OI:shown"], defaults: [], inherited: [], decisions: [] };
    const REUSE = {
      ambiguities: [{ id: "OI:shown", requirementId: "R:A:Q1-1", text: "使い回し", critical: true }],
      unwritable: [],
    };
    const { gateway, outcome } = runTarget([REUSE, OUT_OF_SCOPE], { shownIssueIds: SHOWN });
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.attempts).toBe(2);
    expect(result.failure.problems.some((problem) => problem.code === "requirement-id-unknown")).toBe(true);
    expect(gateway.counts.retries.shape).toBe(1);
    expect(gateway.counts.attempts.started).toBe(2);
  });

  it("(c3) 1 試行目が対象の照合で落ち、2 試行目の呼び出しを adapter が malformed で返すと、adapter の malformed のまま終わる", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>() {
        calls += 1;
        if (calls === 1) return { output: OUT_OF_SCOPE as T, usage: undefined };
        throw Object.assign(new Error("adapter の形の誤り"), { kind: "malformed" });
      },
      async callWithTools() {
        throw new Error("使わない");
      },
    };
    const outcome = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(client, { maxAttempts: 1 }),
      targetRequirementIds: DIFF_IDS,
      dropClaim: () => false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    if (outcome.failure.kind !== "malformed") return;
    // adapter の malformed は problems を持たない（対象の誤りに写さない）
    expect(outcome.failure.problems).toEqual([]);
  });

  it("(d) 対象外の申告が受理済みの再申告なら 1 試行目で通り（呼び出し 1）、除かれる。見分けない再申告は断る", async () => {
    // 重複として除く（1 試行目で通る）
    const dropped = runTarget([OUT_OF_SCOPE_CLAIM], { dropClaim: () => true });
    const droppedResult = await dropped.outcome;
    expect(droppedResult.ok).toBe(true);
    expect(dropped.recording.structured).toHaveLength(1);
    if (droppedResult.ok) expect(droppedResult.value.unwritable).toEqual([]);
    // 重複と認めない（対象外として断り、やり直しの 2 回目も同じなら unmet）
    const rejected = runTarget([OUT_OF_SCOPE_CLAIM, OUT_OF_SCOPE_CLAIM], { dropClaim: () => false });
    const rejectedResult = await rejected.outcome;
    expect(rejectedResult.ok).toBe(false);
    if (rejectedResult.ok) return;
    expect(rejectedResult.failure.kind).toBe("unmet");
    if (rejectedResult.failure.kind !== "unmet") return;
    expect(rejectedResult.failure.problems.some((problem) => problem.code === "requirement-id-unknown")).toBe(true);
  });

  it("(e) 照合を通り、制約の裏付けで落ちる応答は、今のとおり unmet・constraint-id-unknown で、呼び出しは増えない", async () => {
    const { gateway, outcome } = runTarget([BAD_CONSTRAINT]);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.attempts).toBe(1);
    expect(result.failure.problems).toEqual([
      { field: "unwritable[0].constraintIds", code: "constraint-id-unknown", message: "文書に無い制約 ID である" },
    ]);
    expect(gateway.counts.attempts.started).toBe(1);
  });

  it("(e2) 対象外の参照と制約の誤りが同居すると、1 試行目で unmet・制約の誤りで止まり、呼び出しは 1（参照のやり直しへ回さない）", async () => {
    const { gateway, outcome } = runTarget([MIXED_CONSTRAINT]);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("unmet");
    if (result.failure.kind !== "unmet") return;
    expect(result.failure.problems.some((problem) => problem.code === "constraint-id-missing")).toBe(true);
    expect(result.failure.problems.some((problem) => problem.code === "requirement-id-unknown")).toBe(false);
    expect(gateway.counts.attempts.started).toBe(1);
  });

  it("(f) 結果の口は、check が実行された試行（形で落ちた試行を含む）だけに、試行の番号と結果つきで呼ばれる", async () => {
    // 形で落ちて、やり直しで受理
    const shapeThenOk = runTarget([BAD_SHAPE, IN_SCOPE]);
    expect((await shapeThenOk.outcome).ok).toBe(true);
    expect(shapeThenOk.attempts.map((attempt) => [attempt.attempt, attempt.result])).toEqual([
      [1, "shape"],
      [2, "accepted"],
    ]);
    expect(shapeThenOk.attempts[0]?.target).toBeUndefined();
    expect(shapeThenOk.attempts[1]?.target).toBeDefined();

    // 対象の照合で落ちて、やり直しで受理
    const targetThenOk = runTarget([OUT_OF_SCOPE, IN_SCOPE]);
    expect((await targetThenOk.outcome).ok).toBe(true);
    expect(targetThenOk.attempts.map((attempt) => [attempt.attempt, attempt.result])).toEqual([
      [1, "target"],
      [2, "accepted"],
    ]);

    // check に届かなかった試行（2 試行目を adapter が malformed で返す）には行を作らない
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>() {
        calls += 1;
        if (calls === 1) return { output: OUT_OF_SCOPE as T, usage: undefined };
        throw Object.assign(new Error("adapter の形の誤り"), { kind: "malformed" });
      },
      async callWithTools() {
        throw new Error("使わない");
      },
    };
    const attempts: SurfaceTargetAttempt[] = [];
    const notReached = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(client, { maxAttempts: 1 }),
      targetRequirementIds: DIFF_IDS,
      dropClaim: () => false,
      onTargetAttempt: (attempt) => attempts.push(attempt),
    });
    expect(notReached.ok).toBe(false);
    if (!notReached.ok) expect(notReached.failure.kind).toBe("malformed");
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1]);

    // 始めなかった試行（予算が無い）には行を作らない
    const notStarted = runTarget([OUT_OF_SCOPE], { gateway: makeGateway(createRecordingClient([]).client, { budgetUsd: 0, maxAttempts: 1 }) });
    const notStartedResult = await notStarted.outcome;
    expect(notStartedResult.ok).toBe(false);
    if (!notStartedResult.ok) expect(notStartedResult.failure.kind).toBe("budget");
    expect(notStarted.attempts).toEqual([]);
  });

  it("(g) 照合を渡さないと、要求・呼び出しの数・結果は今のまま", async () => {
    const recorded = [
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
      { kind: "structured" as const, output: SURFACE_OUTPUT, usage: undefined },
    ];
    const recording = createRecordingClient(recorded);
    const outcome = await runSurface({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    // 呼び出しは 1 回で、データの塊は要件の一覧だけ（要求は変更前と同じ）
    expect(recording.structured).toHaveLength(1);
    expect(recording.structured[0]?.input.match(/<data name=/g)).toHaveLength(1);
    expect(recording.structured[0]?.input).not.toContain(SHAPE_PROBLEMS_DATA_NAME);
  });
});
