// 段の共通のプロンプトと窓口（stages/prompt.ts）の unit テスト（02 §2.2）。
//
// ここで固定したいのは 3 つ。
//   1. 規則とデータが別の入力であること・データに仕込んだ「規則を無視せよ」が規則の側へ入らないこと
//   2. 構造化出力の要求には JSON Schema が付き、文書は呼ぶ側から渡ったものだけが入ること
//   3. 形が合わない応答は 1 回だけやり直し、誤りは種類ごとに段の失敗になること（拒否はやり直さない。#302）
import { describe, expect, it } from "vitest";
import { CONTRACT_DIR, packageFile, semanticsFile, vocabularyFile } from "@musunest/appspec-schema/files";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "../llm.js";
import { OpenAiIncompleteError } from "../openai.js";
import {
  DATA_IS_NOT_INSTRUCTIONS_RULE,
  STEP_ATTEMPTS,
  buildStructuredRequest,
  callStructuredChecked,
  constraintExcerpt,
  constraintIdsIn,
  isRecord,
  normalizeConstraintId,
  normalizeConstraintIds,
  ruleDefinitionDefects,
  ruleTexts,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StructuredPlan,
} from "./prompt.js";
import {
  INJECTED_INSTRUCTION,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

const REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "入力",
  schemaName: "sample",
  schema: { type: "object" },
  maxOutputTokens: 100,
};

interface NValue {
  readonly n: number;
}

function checkN(output: unknown): ShapeCheck<NValue> {
  if (!isRecord(output) || typeof output["n"] !== "number") {
    return { ok: false, problems: [{ field: "n", message: "数であること" }] };
  }
  return { ok: true, value: { n: output["n"] } };
}

const PLAN: StructuredPlan<NValue> = { request: REQUEST, check: checkN };

/** 拒否（refusal）を表す誤り（adapter が投げる形をまねる。#302） */
const refusalError = (): Error => Object.assign(new Error("モデルが拒否しました"), { kind: "refusal" });

describe("規則とデータを分ける（02 §2.2）", () => {
  it("規則は instructions に、データは input にだけ置く", () => {
    const request = buildStructuredRequest({
      rules: ["段の規則"],
      documents: SAMPLE_DOCUMENTS,
      data: [
        { name: "原文", text: `タスクを記録する。${INJECTED_INSTRUCTION}` },
        { name: "要件の一覧", text: "[]" },
      ],
      schemaName: "sample",
      schema: { type: "object" },
      maxOutputTokens: 100,
    });

    // instructions には共通の規則だけが入る（段ごとの規則は入らない）
    expect(request.instructions).toContain(DATA_IS_NOT_INSTRUCTIONS_RULE);
    expect(request.instructions).not.toContain("段の規則");
    // 段ごとの規則は rules に入る（文書の後ろ・データの前に置かれる）
    expect(request.rules).toEqual(["段の規則"]);
    // データの中身は input の側にだけ入る
    expect(request.input).toContain("タスクを記録する。");
    expect(request.input).toContain("要件の一覧");
    // データに仕込んだ「規則を無視せよ」は、規則の側に入らない
    expect(request.input).toContain(INJECTED_INSTRUCTION);
    expect(request.instructions).not.toContain(INJECTED_INSTRUCTION);
    // データは規則の側に入らない
    expect(request.instructions).not.toContain("タスクを記録する。");
    // 文書は渡したものだけ
    expect(request.documents).toEqual(SAMPLE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
  });

  it("JSON Schema を付ける", () => {
    const request = buildStructuredRequest({
      rules: [],
      documents: [],
      data: [{ name: "原文", text: "タスクを記録する。" }],
      schemaName: "requirement-list",
      schema: { type: "object", required: ["requirements"] },
      maxOutputTokens: 100,
    });
    expect(request.schemaName).toBe("requirement-list");
    expect(request.schema).toEqual({ type: "object", required: ["requirements"] });
  });

  it("受入の題材の言葉を、規則・データ・文書のどこにも使わない", () => {
    const request = buildStructuredRequest({
      rules: ["段の規則"],
      documents: SAMPLE_DOCUMENTS,
      data: [{ name: "原文", text: "タスクを記録する。件数を合計する。" }],
      schemaName: "sample",
      schema: { type: "object" },
      maxOutputTokens: 100,
    });
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });
});

// ── 規則の定義（id・text・why・since。Issue #431）────────────────────

describe("規則の定義と、送信用の文の組み立て（Issue #431）", () => {
  const DEFINITIONS: readonly RuleDefinition[] = [
    { id: "R-x-01", text: "第一の文。", why: "第一の理由", since: "Issue #1" },
    { id: "R-x-02", text: "第二の文。", why: "第二の理由", since: "Issue #2", modes: ["M-01"] },
  ];

  it("定義の並びから、送信用の文の並びを定義の順に作る", () => {
    expect(ruleTexts(DEFINITIONS)).toEqual(["第一の文。", "第二の文。"]);
    expect(ruleTexts([])).toEqual([]);
  });

  it("正例：ID の重複も、why・since の欠落も無ければ、不備を返さない", () => {
    expect(ruleDefinitionDefects(DEFINITIONS)).toEqual([]);
  });

  it("負例：ID が重複していれば、不備を返す", () => {
    const duplicated: readonly RuleDefinition[] = [...DEFINITIONS, { ...DEFINITIONS[0]!, text: "別の文。" }];
    expect(ruleDefinitionDefects(duplicated).join("\n")).toContain("重複");
  });

  it("負例：why か since が空なら、不備を返す", () => {
    const noWhy: readonly RuleDefinition[] = [{ id: "R-x-03", text: "文。", why: "  ", since: "Issue #3" }];
    expect(ruleDefinitionDefects(noWhy).join("\n")).toContain("why");
    const noSince: readonly RuleDefinition[] = [{ id: "R-x-04", text: "文。", why: "理由", since: "" }];
    expect(ruleDefinitionDefects(noSince).join("\n")).toContain("since");
  });
});

describe("形が合わない応答は 1 回だけやり直す（02 §2.2）", () => {
  it("1 回目の応答が合えば、形の再試行は 0（Issue #446）", async () => {
    const recording = createRecordingClient([{ kind: "structured", output: { n: 1 }, usage: undefined }]);
    const gateway = makeGateway(recording.client);
    const outcome = await callStructuredChecked(gateway, PLAN);
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(1);
    expect(gateway.retryCounts.shape).toBe(0);
    expect(gateway.retryCounts.content).toBe(0);
  });

  it("形が合わない応答は 1 回だけやり直し、2 回目が合えば通る", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { bad: true }, usage: undefined },
      { kind: "structured", output: { n: 7 }, usage: undefined },
    ]);
    const gateway = makeGateway(recording.client);
    const outcome = await callStructuredChecked(gateway, PLAN);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ n: 7 });
    expect(recording.structured).toHaveLength(2);
    // 形のやり直しを 1 つ数える（Issue #446）
    expect(gateway.retryCounts.shape).toBe(1);
    expect(STEP_ATTEMPTS).toBe(2);
  });

  it("形が合わない応答が 2 回続くと段の失敗になる", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { bad: true }, usage: undefined },
      { kind: "structured", output: { also: "bad" }, usage: undefined },
    ]);
    const gateway = makeGateway(recording.client);
    const outcome = await callStructuredChecked(gateway, PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    expect(recording.structured).toHaveLength(2);
    // 2 回続けて落ちても、やり直しは 1 回（Issue #446）
    expect(gateway.retryCounts.shape).toBe(1);
  });

  it("問題の型の任意の code は、段の失敗まで保たれる（欄の名前と message の写し方は変えない。Issue #397）", async () => {
    const recording = createRecordingClient([
      { kind: "structured", output: { bad: true }, usage: undefined },
      { kind: "structured", output: { also: "bad" }, usage: undefined },
    ]);
    const plan: StructuredPlan<NValue> = {
      request: REQUEST,
      check: () => ({ ok: false, problems: [{ field: "n", message: "数であること", code: "shape" }] }),
    };
    const outcome = await callStructuredChecked(makeGateway(recording.client), plan);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (outcome.failure.kind !== "malformed") return;
    // 欄の名前と message（Build への写し方）はそのままに、分類（code）も保たれる
    expect(outcome.failure.problems).toEqual([{ field: "n", message: "数であること", code: "shape" }]);
  });

  it("拒否は、拒否として段の失敗にし、やり直さない（02 §2.2・#302）", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        throw refusalError();
      },
      async callWithTools(): Promise<LlmToolResponse> {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("refused");
    // 拒否はやり直さない（#302。§2.2「1 回だけやり直す」は形が合わない応答に限る）
    expect(calls).toBe(1);
  });

  it("分類できない例外は unknown として段の失敗にし、拒否に混ぜず、やり直さない（02 §2.2・#302）", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        throw new Error("分類できない");
      },
      async callWithTools(): Promise<LlmToolResponse> {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unknown");
    expect(calls).toBe(1);
  });
});

describe("未完了の応答は、拒否と分けて段の失敗にする（02 §2.2・§1.5）", () => {
  it("拒否ではなく incomplete（理由付き）にし、同じ要求のままやり直さない", async () => {
    let calls = 0;
    const client: LlmClient = {
      async callStructured() {
        calls += 1;
        throw new OpenAiIncompleteError("max_output_tokens", undefined, "応答が完了していません");
      },
      async callWithTools() {
        throw new Error("未使用");
      },
    };
    const outcome = await callStructuredChecked(makeGateway(client), PLAN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "incomplete", reason: "max_output_tokens" });
    expect(calls).toBe(1);
  });
});

// ── 文書の本文から制約 ID を取り出す（02 §1・②・Issue #332）──────────────

describe("制約 ID の取り出しと、節の抜粋（Issue #332）", () => {
  it("契約の規則の R-… と、語彙の意味の ### 見出しを、制約 ID として取り出す", () => {
    const ids = constraintIdsIn(SAMPLE_DOCUMENTS);
    expect(ids.has("R-1")).toBe(true);
    expect(ids.has("R-2")).toBe(true);
    expect(ids.has("R-14")).toBe(true);
    expect(ids.has("記録")).toBe(true);
    expect(ids.has("合計")).toBe(true);
    expect(ids.has("アプリの名前・説明")).toBe(true);
    // 文書に無い ID は入らない
    expect(ids.has("R-999")).toBe(false);
  });

  it("制約 ID の節の抜粋を、見出しとその本文／規則の行から取り出す", () => {
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["アプリの名前・説明"])).toBe(
      "### アプリの名前・説明\nアプリ自体の名前や説明を置く欄は無い。",
    );
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["R-1"])).toBe("R-1 宣言は、閉じた語彙だけを使う。");
    // 知らない ID は何も返さない
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, ["R-999"])).toBe("");
    expect(constraintExcerpt(SAMPLE_DOCUMENTS, [])).toBe("");
  });
});

// ── 制約 ID の正規化（Issue #398）──────────────────────────────────

describe("制約 ID の正規化（Issue #398）", () => {
  it("見出しの接頭辞・全体を囲むバッククォート・前後の空白を、1 回だけ外す", () => {
    expect(normalizeConstraintId("### action")).toBe("action");
    expect(normalizeConstraintId("`R-TYPE-07`")).toBe("R-TYPE-07");
    expect(normalizeConstraintId("  action  ")).toBe("action");
    expect(normalizeConstraintId("## action")).toBe("action");
    // 内部の記号・大文字小文字は変えない
    expect(normalizeConstraintId("`R-TYPE-07` の文")).toBe("`R-TYPE-07` の文");
  });

  it("正規化した結果に当てても変わらない（冪等）", () => {
    for (const raw of ["### action", "`R-TYPE-07`", "  action  ", "## action"]) {
      const once = normalizeConstraintId(raw);
      expect(normalizeConstraintId(once), raw).toBe(once);
    }
  });

  it("片側だけのバッククォート・# が 4 個以上・空は、正規化しても知らない ID のままである", () => {
    const known = constraintIdsIn(SAMPLE_DOCUMENTS);
    for (const raw of ["`action", "action`", "#### action", "", "R-999"]) {
      expect(known.has(normalizeConstraintId(raw)), raw).toBe(false);
    }
  });

  it("### ### action は 1 回だけ外すので、知らない ID のまま残る", () => {
    // 2 回外すと action になってしまう。1 回だけなので ### action のまま残る
    expect(normalizeConstraintId("### ### action")).toBe("### action");
    expect(constraintIdsIn(SAMPLE_DOCUMENTS).has("### action")).toBe(false);
  });

  it("正規化して重なった ID は 1 つになり、空になったものは落ちる", () => {
    expect(normalizeConstraintIds(["`computed`", "### computed", "computed"])).toEqual(["computed"]);
    expect(normalizeConstraintIds(["", "` `", "action"])).toEqual(["action"]);
  });

  it("旧形式（R-1 の形）は、文書にあるときだけ集合に入る", () => {
    expect(constraintIdsIn(SAMPLE_DOCUMENTS).has("R-1")).toBe(true);
    expect(constraintIdsIn([{ name: "契約", text: "R-TYPE-01 だけがある。" }]).has("R-1")).toBe(false);
  });
});

// ── 制約 ID の節の抜粋の範囲（Issue #398）────────────────────────────

describe("制約 ID の節の抜粋の範囲（Issue #398）", () => {
  const DOCUMENTS: readonly PromptDocument[] = [
    {
      name: "語彙の意味",
      text: [
        "## 宣言の全体",
        "全体の本文。",
        "## データ層",
        "データ層の本文。",
        "### 前半",
        "前半の本文。",
        "#### 子の節",
        "子の本文。",
        "### 後半",
        "後半の本文。",
      ].join("\n"),
    },
    { name: "語彙の台帳", text: "次の文書の本文。" },
  ];

  it("対象の本文と子の節を含み、次の同じ段か上の段の節を含まない", () => {
    expect(constraintExcerpt(DOCUMENTS, ["前半"])).toBe(
      ["### 前半", "前半の本文。", "#### 子の節", "子の本文。"].join("\n"),
    );
  });

  it("許可した ## の抜粋も、同じ段か上の段の見出しで止まる", () => {
    expect(constraintExcerpt(DOCUMENTS, ["宣言の全体"])).toBe(["## 宣言の全体", "全体の本文。"].join("\n"));
  });

  it("次の文書の本文を含まない", () => {
    expect(constraintExcerpt(DOCUMENTS, ["後半"])).toBe(["### 後半", "後半の本文。"].join("\n"));
    expect(constraintExcerpt(DOCUMENTS, ["後半"])).not.toContain("次の文書の本文。");
  });

  it("知らない ID・許可していない見出しの抜粋は空", () => {
    expect(constraintExcerpt(DOCUMENTS, ["知らない"])).toBe("");
    expect(constraintExcerpt(DOCUMENTS, ["データ層"])).toBe("");
  });
});

// ── 実物の文書から制約 ID を取り出す（Issue #398）──────────────────────

interface NodeFileSystem {
  readdirSync(path: URL): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fileSystem = (await importUntyped("node:fs")) as NodeFileSystem;

/** 入口（cli.ts）と同じ順と連結で、契約・語彙の意味・語彙の台帳を読む（Issue #398） */
function realDocuments(): readonly PromptDocument[] {
  const contractDirectory = packageFile(`${CONTRACT_DIR}/`);
  const names = fileSystem
    .readdirSync(contractDirectory)
    .filter((name) => !name.startsWith("."))
    .sort();
  const contractParts = names.map((name) => fileSystem.readFileSync(new URL(name, contractDirectory), "utf8"));
  return [
    { name: "契約", text: contractParts.join("\n") },
    { name: "語彙の意味", text: fileSystem.readFileSync(semanticsFile(), "utf8") },
    { name: "語彙の台帳", text: fileSystem.readFileSync(vocabularyFile(), "utf8") },
  ];
}

/**
 * 期待する規則の ID を、実装と独立に列挙する（本番の正規表現から作らない。Issue #398）：
 * TYPE 01〜14・NAME 01〜13・LIMIT 01〜06・RESERVED 01〜02・VOCAB 01〜13・YAML 01〜09 の計 57。
 */
const EXPECTED_RULE_IDS: readonly string[] = [
  ...prefixRange("R-TYPE", 14),
  ...prefixRange("R-NAME", 13),
  ...prefixRange("R-LIMIT", 6),
  ...prefixRange("R-RESERVED", 2),
  ...prefixRange("R-VOCAB", 13),
  ...prefixRange("R-YAML", 9),
];

function prefixRange(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

describe("実物の文書から制約 ID を取り出す（Issue #398）", () => {
  const ids = constraintIdsIn(realDocuments());

  it("実物の規則の ID 57 個がそろって取れ、規則の形の ID はそれとちょうど一致する", () => {
    expect(EXPECTED_RULE_IDS).toHaveLength(57);
    expect(EXPECTED_RULE_IDS.filter((id) => !ids.has(id))).toEqual([]);
    // 規則の形（R-<英大文字>-<数字>）の ID は、期待の 57 個を過不足なく含む
    const ruleLike = [...ids].filter((id) => /^R-[A-Z]+-\d+$/.test(id));
    expect(new Set(ruleLike)).toEqual(new Set(EXPECTED_RULE_IDS));
  });

  it("語彙の意味の見出しと、明示した許可の ## の見出しが入る", () => {
    expect(ids.has("R-TYPE-01")).toBe(true);
    expect(ids.has("R-VOCAB-01")).toBe(true);
    expect(ids.has("number")).toBe(true);
    expect(ids.has("computed")).toBe(true);
    expect(ids.has("宣言の全体")).toBe(true);
  });

  it("許可していない ## の見出しは入らない", () => {
    expect(ids.has("データ層")).toBe(false);
    expect(ids.has("ロジック層")).toBe(false);
  });
});
