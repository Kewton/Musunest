// ① 要件にする（stages/requirements.ts）の unit テスト（02 §1・F-3・F-6）。
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import type { RequirementList } from "../pipeline.js";
import {
  REQUIREMENTS_SCHEMA_NAME,
  checkRequirementOutput,
  runRequirements,
} from "./requirements.js";
import { checkRequirementCoverage, runReverseCheckLoop } from "./reverse-check.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  REQUIREMENT_LIST_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

describe("① が送る要求を観測する（02 §2.2）", () => {
  it("規則とデータが別で、データは原文だけ・JSON Schema が付く", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 原文はデータの側にだけ入る
    expect(request.input).toContain(SOURCE_TEXT);
    expect(request.instructions).not.toContain(SOURCE_TEXT);
    // データは 1 つ（原文だけ）。要件の一覧などはまだ無い
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
    // JSON Schema が付く
    expect(request.schemaName).toBe(REQUIREMENTS_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    // 文書は渡したものだけ
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("データに仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: `タスクを記録する。${INJECTED_INSTRUCTION}`,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });
});

describe("① の入口の上限（02 §1.5・依頼文の長さ）", () => {
  it("依頼文が上限を超えたら、呼ばずに断る", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: "あ".repeat(AGENT_LIMITS.requestTextChars + 1),
      documents: [],
      gateway: makeGateway(recording.client),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("limit");
    expect(recording.structured).toHaveLength(0);
  });
});

describe("① のやり直し（02 §1・①' の落ちを受けて）", () => {
  it("やり直すときは、前回の一覧と落ちをデータに足し、規則の側には入れない", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const outcome = await runRequirements({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      redo: {
        previous: REQUIREMENT_LIST,
        misses: [{ kind: "quote-not-found", requirementId: "R-9", detail: "引用が見つからない" }],
      },
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input).toContain("前回の要件の一覧");
    expect(request.input).toContain("逆照合で見つかった落ち");
    expect(request.instructions).not.toContain("前回の要件の一覧");
  });
});

describe("① の枠の文（Issue #372）", () => {
  it("framing を持つ応答を受け付け、framing の無い応答は空の配列として扱う", () => {
    const source = "タスクを記録する。アプリを作ってください";
    const withFraming = checkRequirementOutput(
      {
        requirements: [
          { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
        ],
        framing: [{ quote: "アプリを作ってください", position: { start: 9, end: 20 } }],
        decisions: [],
        unresolved: [],
      },
      source,
    );
    expect(withFraming.ok).toBe(true);
    if (!withFraming.ok) return;
    expect(withFraming.value.framing).toEqual([
      { quote: "アプリを作ってください", position: { start: 9, end: 20 } },
    ]);

    const withoutFraming = checkRequirementOutput(REQUIREMENT_LIST_OUTPUT);
    expect(withoutFraming.ok).toBe(true);
    if (!withoutFraming.ok) return;
    expect(withoutFraming.value.framing).toEqual([]);
  });

  it("引用が空の framing は、形の誤りになる", () => {
    const bad = checkRequirementOutput({
      requirements: [],
      framing: [{ quote: "", position: { start: 0, end: 1 } }],
      decisions: [],
      unresolved: [],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("framing[0].quote");
  });

  it("位置の範囲の原文と引用が合わない framing は、形の誤りになる", () => {
    const bad = checkRequirementOutput(
      {
        requirements: [],
        framing: [{ quote: "アプリ", position: { start: 0, end: 3 } }],
        decisions: [],
        unresolved: [],
      },
      SOURCE_TEXT,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("framing[0].position");
  });

  it("位置の合わない framing の応答は、1 回だけやり直す（2 回続くと失敗になる）", async () => {
    const badOutput = {
      requirements: [],
      framing: [{ quote: "アプリ", position: { start: 0, end: 3 } }],
      decisions: [],
      unresolved: [],
    };
    const bad = createRecordingClient([
      { kind: "structured", output: badOutput, usage: undefined },
      { kind: "structured", output: badOutput, usage: undefined },
    ]);
    const failed = await runRequirements({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");

    const recovered = createRecordingClient([
      { kind: "structured", output: badOutput, usage: undefined },
      { kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined },
    ]);
    const retried = await runRequirements({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recovered.client),
    });
    expect(retried.ok).toBe(true);
  });
});

describe("① の形の確認", () => {
  it("正しい応答は固定できる", () => {
    const checked = checkRequirementOutput(REQUIREMENT_LIST_OUTPUT);
    expect(checked.ok).toBe(true);
  });

  it("欄の形が合わなければ、欄つきで断る", () => {
    const bad = checkRequirementOutput({
      requirements: [{ id: "", text: "x", quote: 1, position: { start: 3, end: 1 } }],
      decisions: "nope",
      unresolved: [],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("requirements[0].id");
    expect(fields).toContain("requirements[0].quote");
    expect(fields).toContain("requirements[0].position");
    expect(fields).toContain("decisions");
  });

  it("要件の一覧が並びでなければ断る", () => {
    expect(checkRequirementOutput({ requirements: {}, decisions: [], unresolved: [] }).ok).toBe(false);
    expect(checkRequirementOutput("nope").ok).toBe(false);
  });
});

describe("① の位置の正規化（Issue #382）", () => {
  const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

  /** 1 件の要件を持つ応答（引用は原文からそのまま、位置だけを差し替える） */
  const requirementOutputAt = (position: { readonly start: number; readonly end: number }) => ({
    requirements: [{ id: "R-1", text: "記録できる", quote: "タスクを記録する", position }],
    decisions: [],
    unresolved: [],
  });

  const source = "タスクを記録する。";

  it("始まりが 1 文字ずれた位置は、形の誤りにならず、コードが求めた正しい位置で返る", () => {
    const checked = checkRequirementOutput(requirementOutputAt({ start: 1, end: 9 }), source);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.requirements[0]?.position).toEqual({ start: 0, end: 8 });
  });

  it("終わりだけずれた位置も、形の誤りにならず、引用の長さに合わせて返る", () => {
    const checked = checkRequirementOutput(requirementOutputAt({ start: 0, end: 10 }), source);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.requirements[0]?.position).toEqual({ start: 0, end: 8 });
  });

  it("範囲が原文の外の位置も、形の誤りにならず、引用の位置で返る", () => {
    const checked = checkRequirementOutput(requirementOutputAt({ start: 50, end: 60 }), source);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.requirements[0]?.position).toEqual({ start: 0, end: 8 });
  });

  it("LLM の位置が正しいときは、そのまま使い、positionCorrections は 0 になる", () => {
    const checked = checkRequirementOutput(requirementOutputAt({ start: 0, end: 8 }), source);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.requirements[0]?.position).toEqual({ start: 0, end: 8 });
    expect(checked.value.positionCorrections).toBe(0);
  });

  it("絵文字（UTF-16 で 2 単位の文字）を含む原文で、終わりが「始まり＋引用の長さ」になる", () => {
    const emojiSource = "🐶を記録する。";
    const quote = "🐶を記録する";
    const checked = checkRequirementOutput(
      {
        requirements: [{ id: "R-1", text: "記録できる", quote, position: { start: 3, end: 5 } }],
        decisions: [],
        unresolved: [],
      },
      emojiSource,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const position = checked.value.requirements[0]?.position;
    expect(position?.start).toBe(0);
    expect(position?.end).toBe(quote.length);
    expect(position?.end).toBe((position?.start ?? 0) + quote.length);
  });

  it("positionCorrections は、要件と枠の文を 1 件ずつ数える", () => {
    const countingSource = "タスクを記録する。アプリを作ってください";
    const checked = checkRequirementOutput(
      {
        requirements: [{ id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 1, end: 9 } }],
        framing: [{ quote: "アプリを作ってください", position: { start: 10, end: 20 } }],
        decisions: [],
        unresolved: [],
      },
      countingSource,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.positionCorrections).toBe(2);
  });

  it("同じ引用が原文に 2 か所あり位置がどちらとも一致しないとき、引用の誤りになり、やり直しの指示に「1 か所に決まる引用」が入る", async () => {
    const ambiguousSource = "同じ文。同じ文。";
    const ambiguous = {
      requirements: [{ id: "R-1", text: "同じ文を扱える", quote: "同じ文", position: { start: 5, end: 8 } }],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(ambiguous),
      structured({ uncovered: [] }),
      structured(ambiguous),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoop({
      source: ambiguousSource,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 位置を推測せず、引用の誤り（落ち）としてやり直す
    expect(outcome.value.redone).toBe(true);
    // やり直しの ① に渡す「逆照合で見つかった落ち」に、1 か所に決まる引用 への指示が入る
    const redoRequest = recording.structured[2];
    expect(redoRequest).toBeDefined();
    expect(redoRequest?.input).toContain("1 か所に決まる引用");
  });

  it("位置の誤り（position-mismatch）の field と message に、引用の値を埋めない（Issue #445）", () => {
    const marker = "MARKER445";
    const framingAt = (quote: string, position: { readonly start: number; readonly end: number }) => ({
      requirements: [],
      framing: [{ quote, position }],
      decisions: [],
      unresolved: [],
    });
    const problemsOf = (source: string, quote: string, position: { readonly start: number; readonly end: number }) => {
      const checked = checkRequirementOutput(framingAt(quote, position), source);
      expect(checked.ok).toBe(false);
      if (checked.ok) return [];
      return checked.problems;
    };

    // 原文に目印を含み、枠の文の引用にも目印を含める。分類は position-mismatch、位置は framing[添字].position
    const source = `${marker}。${marker}。`;
    const cases: readonly { readonly label: string; readonly quote: string; readonly position: { readonly start: number; readonly end: number } }[] = [
      // 原文に無い引用
      { label: "not-found", quote: `${marker}zzz`, position: { start: 0, end: 3 } },
      // 原文に 2 か所ある引用（重なる出現を含む）で、位置が 1 か所に決まらない
      { label: "ambiguous", quote: marker, position: { start: 1, end: marker.length + 2 } },
    ];
    for (const one of cases) {
      const problems = problemsOf(source, one.quote, one.position);
      expect(problems.length, one.label).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(problem.code, one.label).toBe("position-mismatch");
        expect(problem.field, one.label).toBe("framing[0].position");
      }
      expect(JSON.stringify(problems), one.label).not.toContain(marker);
    }
  });

  it("空の引用・原文に無い引用は、引用の誤りになる", () => {
    const list: RequirementList = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "", position: { start: 0, end: 0 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 0, end: 0 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const quoteMisses = checkRequirementCoverage(source, list).filter((miss) => miss.kind === "quote-not-found");
    expect(quoteMisses.map((miss) => miss.requirementId)).toEqual(["R-1", "R-2"]);
  });
});
