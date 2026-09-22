// 静的チェックの unit テスト（Issue #97 の受入条件を、ここで固定する）。
//
//   1. 見本（expense-log・warikan）の診断が空で、7 欄を持つ AppSpec を返す
//   2. 負例 48 件で返る誤りコードの集合が、負例一覧の codes と**ちょうど一致**する
//   3. 診断は空でない日本語の説明と、該当する YAML の行・列を持つ
//   4. 不正 YAML・未知キー・未知参照・循環を拒否し、上限はちょうどが通り 1 超過で診断になる
//   5. 検査は式を実行せず、ストレージにも触れない
//
// **負例の本文と期待値は appspec-schema から読む**（このリポジトリの正本）。ここに写すと、
// 負例を足したときに片方だけが古くなる。土台の宣言は、この file の中で組み立てる。
import { describe, expect, it } from "vitest";
import {
  APPSPEC_SECTIONS,
  ERROR_CODE_PATTERN,
  enumKeys,
  readNegativeIndex,
  type AppSpecSection,
  type Computed,
  type FieldDeclaration,
  type NegativeSample,
} from "@musunest/appspec-schema";
import {
  negativeIndexFile,
  negativeSpecFile,
  NEGATIVES_DIR_NAME,
  sampleSpecFile,
  samplesDir,
} from "@musunest/appspec-schema/files";
import { checkSpec, type CheckResult } from "./check.js";
import {
  DIAGNOSTIC_CODES,
  isDiagnosticCode,
  isWellFormedDiagnosticCode,
  type Diagnostic,
} from "./diagnostics.js";
import { readExpression } from "./expression.js";
import { EXPRESSION_LIMITS } from "./limits.js";

// tsconfig の types は workers-types と node の両方を読み、**グローバルの URL の型が食い違う**
// （workers-types の URL を node:fs に渡せない）。このファイルは Node（vitest）で動くので、
// 使う関数の形だけをここで宣言する（appspec-schema・data-api のテストと同じやり方）。
interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): DirEntry[];
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const read = (url: URL): string => fs.readFileSync(url, "utf8");

/** samples/ の下の見本（負例のディレクトリは数えない） */
const sampleNames = fs
  .readdirSync(samplesDir(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== NEGATIVES_DIR_NAME)
  .map((entry) => entry.name);

const sampleText = read(sampleSpecFile("expense-log"));
const negativeIndex = readNegativeIndex(JSON.parse(read(negativeIndexFile())));
const negativeTexts = new Map(
  negativeIndex.negatives.map((negative) => [negative.name, read(negativeSpecFile(negative.name))]),
);
const negativeCases = negativeIndex.negatives.map((negative) => [negative.name, negative] as const);

const codesOf = (result: CheckResult): string[] =>
  [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].sort();
const messagesOf = (result: CheckResult, code: string): string =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => diagnostic.message)
    .join(" / ");

/** 断られることを先に固定してから、診断を読む */
const failure = (result: CheckResult): CheckResult => {
  expect(result.ok).toBe(false);
  return result;
};

/** 式で求める計算の式だけを取り出す（集計は式を持たない。M1.2） */
const expressionsOf = (computed: readonly Computed[]): string[] =>
  computed.flatMap((entry) => ("expression" in entry ? [entry.expression] : []));

/** 原文の中の文字列が、何行目の何列目から始まるか（診断の位置と突き合わせる） */
const locate = (text: string, needle: string): { line: number; column: number } => {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`原文に ${needle} が無い`);
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
};

// ── テストの土台（正しい宣言） ──────────────────────────────────

const BASE_PARTS: Readonly<Record<AppSpecSection, string>> = {
  entities: [
    "  - name: expense",
    "    fields:",
    "      amount: number",
    "      payer: string",
    "      participants: list",
  ].join("\n"),
  views: ["  - name: expenseList", "    entity: expense"].join("\n"),
  actions: ["  - name: addExpense", "    entity: expense"].join("\n"),
  validations: ["  - name: positiveAmount", "    entity: expense", "    expression: amount > 0"].join("\n"),
  computed: [
    "  - name: headcount",
    "    entity: expense",
    "    expression: len(participants)",
    "    type: number",
  ].join("\n"),
  permissions: ["  - name: read", "    subject: minIdentity"].join("\n"),
  minIdentity: "  mode: anonymous",
};

/** 土台の宣言。`parts` で欄を差し替えて、わざと間違えた宣言を作る */
const declaration = (parts: Partial<Record<AppSpecSection, string>> = {}): string =>
  APPSPEC_SECTIONS.map((section) => {
    const body = parts[section] ?? BASE_PARTS[section];
    // 字下げして書く欄は次の行から、`[]` や写像でない値は同じ行に書く
    return body.startsWith(" ") ? `${section}:\n${body}` : `${section}: ${body}`;
  }).join("\n");

/** 欄（と、その下の字下げした中身）を消す */
const withoutSection = (text: string, section: string): string => {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(`${section}:`)) {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith(" ")) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\n");
};

const computed = (name: string, expression: string, type = "number"): string =>
  [`  - name: ${name}`, "    entity: expense", `    expression: ${expression}`, `    type: ${type}`].join("\n");

const entitiess = (...blocks: readonly string[]): string => blocks.join("\n");

/** 葉が `leaves` 枚の釣り合った木（深さは log2(leaves) + 1、ノードは 2 * leaves - 1） */
const balanced = (leaves: number): string =>
  leaves === 1 ? "1" : `(${balanced(leaves / 2)}+${balanced(leaves / 2)})`;

/** `depth` 段の入れ子の関数呼び出し（外側の呼び出しを 1 段と数える） */
const nested = (depth: number): string => {
  let text = "1";
  for (let index = 1; index < depth; index += 1) text = `min(${text}, 1)`;
  return text;
};

// ── 1. 見本 ────────────────────────────────────────────────────

describe("見本 expense-log", () => {
  const result = checkSpec(sampleText);

  it("診断が空である", () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("7 欄を持つ AppSpec を返す", () => {
    if (!result.ok) throw new Error("診断が出ている");
    expect(Object.keys(result.spec)).toEqual([...APPSPEC_SECTIONS]);
    expect(result.spec.entities.map((entity) => entity.name)).toEqual(["expense"]);
    // 項目は書いた順のまま（一覧の列の順になる。docs/semantics.md「entity」）
    expect(result.spec.entities[0]?.fields).toEqual({
      description: "string",
      amount: "number",
      discount: "number",
      payer: "string",
      participants: "list",
    });
    expect(Object.keys(result.spec.entities[0]?.fields ?? {})).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
    ]);
    expect(result.spec.views).toEqual([{ name: "expenseList", entity: "expense" }]);
    expect(result.spec.actions).toEqual([{ name: "addExpense", entity: "expense" }]);
    expect(result.spec.validations).toEqual([
      { name: "positiveAmount", entity: "expense", expression: "amount > 0" },
      { name: "nonNegativeDiscount", entity: "expense", expression: "discount >= 0" },
    ]);
    expect(result.spec.computed).toEqual([
      { name: "paidAmount", entity: "expense", expression: "amount - min(discount, amount)", type: "number" },
      { name: "headcount", entity: "expense", expression: "len(participants)", type: "number" },
      { name: "shareAmount", entity: "expense", expression: "paidAmount / max(1, headcount)", type: "number" },
    ]);
    expect(result.spec.permissions).toEqual([
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ]);
    expect(result.spec.minIdentity).toEqual({ mode: "anonymous" });
  });

  it("計算の値を持たない（宣言を返すだけである）", () => {
    if (!result.ok) throw new Error("診断が出ている");
    for (const entry of result.spec.computed) {
      // 値の欄が増えていないことを、欄の名前で確かめる
      expect(Object.keys(entry).sort()).toEqual(["entity", "expression", "name", "type"]);
    }
  });

  it("見本の式は、#98 の評価が使うのと同じ解析で読める（上限の内側）", () => {
    if (!result.ok) throw new Error("診断が出ている");
    const expressions = [
      ...result.spec.validations.map((validation) => validation.expression),
      ...expressionsOf(result.spec.computed),
    ];
    expect(expressions).toHaveLength(5);
    for (const expression of expressions) {
      const parsed = readExpression(expression);
      expect(parsed.ok, expression).toBe(true);
      if (parsed.ok) expect(parsed.depth).toBeLessThanOrEqual(EXPRESSION_LIMITS.maxDepth);
    }
  });
});

// ── 1b. 見本（すべて静的チェックに通る） ──────────────────────────

describe("見本（appspec-schema の samples/）", () => {
  it("見本は 2 つ以上ある（1 つだけなら、以降のテストが 1 つの見本に依存する）", () => {
    expect(sampleNames.length).toBeGreaterThanOrEqual(2);
  });

  it.each(sampleNames)("見本 %s は静的チェックに通り、診断が空である", (name) => {
    const result = checkSpec(read(sampleSpecFile(name)));
    expect(result.diagnostics, name).toEqual([]);
    expect(result.ok, name).toBe(true);
  });

  it("warikan の参照は、参照先の entity 名を宣言から写している（M1.2）", () => {
    const result = checkSpec(read(sampleSpecFile("warikan")));
    if (!result.ok) throw new Error("warikan が静的チェックに通らない");
    const expense = result.spec.entities.find((entity) => entity.name === "expense");
    // 表示名（`label`。M1.3。Issue #176）も、宣言のまま写す
    expect(expense?.fields["payer"]).toEqual({ type: "ref", to: "member", label: "払った人" });
    expect(expense?.fields["participants"]).toEqual({ type: "list", of: "member", label: "割る人" });
    // **`label` を書かない項目は、識別子のまま（1 語のスカラ）**——warikan は `member.name` で示す
    const member = result.spec.entities.find((entity) => entity.name === "member");
    expect(member?.fields["name"]).toBe("string");
    // 参照の項目は、式の中では ID の文字列として読む（数ではない）
    expect(expressionsOf(result.spec.computed)).toEqual([
      "len(participants)",
      "amount / max(1, headcount)",
      "paid - owed",
    ]);
  });

  it("warikan の集計は、sum と where を宣言のまま写している（M1.2）", () => {
    const result = checkSpec(read(sampleSpecFile("warikan")));
    if (!result.ok) throw new Error("warikan が静的チェックに通らない");
    expect(result.spec.computed).toContainEqual({
      name: "paid",
      entity: "member",
      aggregate: { kind: "sum", entity: "expense", name: "amount", where: { payer: { op: "equals" } } },
      type: "number",
      label: "払った額",
    });
    expect(result.spec.computed).toContainEqual({
      name: "owed",
      entity: "member",
      aggregate: {
        kind: "sum",
        entity: "expense",
        name: "shareAmount",
        where: { participants: { op: "contains" } },
      },
      type: "number",
      label: "負担額",
    });
  });

  it("warikan の精算は、支出の entity と 3 つの項目を宣言のまま写している（M1.2）", () => {
    const result = checkSpec(read(sampleSpecFile("warikan")));
    if (!result.ok) throw new Error("warikan が静的チェックに通らない");
    expect(result.spec.computed).toContainEqual({
      name: "settlement",
      entity: "member",
      settle: { expense: "expense", amount: "amount", payer: "payer", shares: "participants" },
      label: "精算",
    });
    // 精算の値は数ではなく送金の並びなので、`type` を持たない
    const settle = result.spec.computed.find((entry) => entry.name === "settlement");
    expect(settle).toBeDefined();
    expect(settle !== undefined && "type" in settle).toBe(false);
  });

  it("warikan の一覧は、種類と show を宣言のまま写している（M1.2）", () => {
    const result = checkSpec(read(sampleSpecFile("warikan")));
    if (!result.ok) throw new Error("warikan が静的チェックに通らない");
    expect(result.spec.views).toEqual([
      // `show` を書かなければ、項目（宣言の順）に続いて計算（宣言の順）である
      // ——メンバーの表は name・paid・owed・balance の順に出る（受入条件）
      { name: "memberList", entity: "member", type: "table" },
      // `show` を書けば、その順で列が出る（計算の shareAmount を項目の間に置ける。受入条件）
      {
        name: "expenseList",
        entity: "expense",
        type: "table",
        show: ["description", "shareAmount", "amount", "payer"],
      },
      // 精算の表示は、列の並びを持たない
      { name: "settlement", entity: "member", type: "settlement" },
    ]);
  });

  it("warikan の検査の文言は、宣言した順のまま残る（M1.2）", () => {
    const result = checkSpec(read(sampleSpecFile("warikan")));
    if (!result.ok) throw new Error("warikan が静的チェックに通らない");
    expect(result.spec.validations).toEqual([
      {
        name: "positiveAmount",
        entity: "expense",
        expression: "amount > 0",
        message: "金額は 1 円以上にしてください",
      },
      {
        name: "someoneShares",
        entity: "expense",
        expression: "len(participants) > 0",
        message: "割る人を 1 人以上選んでください",
      },
    ]);
  });
});

// ── 1c. 選択肢（enum）と既定値（default）（M1.3。Issue #154） ──────────
//
// 選択肢は「保存される値（キー）と、画面に出す表示名の対」である。既定値（`default`）は
// `options` のキーのどれかでなければならない。**誤りのコードはそれぞれ別である**——
// 負例 3 本（samples/negatives の enum-*）が、同じことを外から確かめる。

/** 選択肢の項目 status を持つ expense の宣言。`status` を差し替えて誤りを作る */
const enumEntity = (status: readonly string[]): string =>
  [
    "  - name: expense",
    "    fields:",
    "      amount: number",
    "      payer: string",
    "      participants: list",
    ...status,
  ].join("\n");

/** 検査に通った宣言から、選択肢の項目 status を取り出す */
const enumStatusOf = (result: CheckResult): FieldDeclaration | undefined => {
  if (!result.ok) throw new Error("検査に通っていない");
  return result.spec.entities.find((entry) => entry.name === "expense")?.fields["status"];
};

describe("選択肢（enum）と既定値（default）（M1.3）", () => {
  const ENUM_STATUS: readonly string[] = [
    "      status:",
    "        type: enum",
    "        options:",
    "          todo: 未着手",
    "          doing: 進行中",
    "          done: 完了",
    "        default: todo",
  ];

  const withStatus = (status: readonly string[] = ENUM_STATUS): string =>
    declaration({ entities: enumEntity(status) });

  it("options と default を、書いた順のまま写す（受入条件）", () => {
    const result = checkSpec(withStatus());
    expect(result.diagnostics).toEqual([]);
    expect(enumStatusOf(result)).toEqual({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
      default: "todo",
    });
    // キーの順は書いた順のままである（M1.3 のボードは、この順に列を並べる）
    expect(enumKeys(enumStatusOf(result) ?? "string")).toEqual(["todo", "doing", "done"]);
  });

  it("default は書かなくてよい（欄そのものが無い。未入力のまま型の検査に掛かる）", () => {
    const result = checkSpec(withStatus(ENUM_STATUS.slice(0, 6)));
    expect(result.diagnostics).toEqual([]);
    expect(enumStatusOf(result)).toEqual({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
    });
  });

  it("3 つの誤りのコードは、それぞれ別である（受入条件）", () => {
    const cases: readonly (readonly string[])[] = [
      // options が空である
      ["      status:", "        type: enum", "        options:"],
      // default が options のキーのどれでもない
      ["      status:", "        type: enum", "        options:", "          todo: 未着手", "        default: doing"],
      // options のキーが重複している
      [
        "      status:",
        "        type: enum",
        "        options:",
        "          todo: 未着手",
        "          todo: 進行中",
      ],
    ];
    const codes = cases.map((status) => codesOf(failure(checkSpec(withStatus(status)))));
    expect(codes).toEqual([
      ["DATA_FIELD_ENUM_OPTIONS_EMPTY"],
      ["DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS"],
      ["DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE"],
    ]);
    // 3 つとも、正本の一覧（diagnostics.ts）にある
    for (const code of codes.flat()) expect(isDiagnosticCode(code)).toBe(true);
  });

  it("キーの重複は、写像の重複キーのコード（SHAPE_KEY_DUPLICATE）に化けない", () => {
    const text = withStatus([
      "      status:",
      "        type: enum",
      "        options:",
      "          todo: 未着手",
      "          todo: 進行中",
    ]);
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE"]);
    expect(messagesOf(result, "DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE")).toContain("todo");
    // 位置は、2 回目に書いたキーを指す
    expect(result.diagnostics[0]).toMatchObject(locate(text, "todo: 進行中"));
  });

  it("default がキーに無いときの位置は、書いた値を指す", () => {
    const text = withStatus([
      "      status:",
      "        type: enum",
      "        options:",
      "          todo: 未着手",
      "        default: doing",
    ]);
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS"]);
    expect(messagesOf(result, "DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS")).toContain("doing");
    expect(result.diagnostics[0]).toMatchObject(locate(text, "doing"));
  });

  it.each([
    ["enum を 1 語で書く", ["      status: enum"], "SHAPE_VALUE_INVALID"],
    ["options が無い", ["      status:", "        type: enum"], "SHAPE_KEY_MISSING"],
    [
      "options が写像でない",
      ["      status:", "        type: enum", "        options: [todo, doing]"],
      "SHAPE_VALUE_INVALID",
    ],
    [
      "options の表示名が空である",
      ["      status:", "        type: enum", "        options:", "          todo:"],
      "SHAPE_VALUE_INVALID",
    ],
    [
      "default が文字列でない",
      [
        "      status:",
        "        type: enum",
        "        options:",
        "          todo: 未着手",
        "        default:",
      ],
      "SHAPE_VALUE_INVALID",
    ],
    // `label` は M1.3 で実在の欄になったので、知らない欄は別の語で確かめる（#176。追記 4）
    ["enum に知らない欄を書く", [...ENUM_STATUS, "        unknownField: 状態"], "SHAPE_KEY_UNKNOWN"],
    [
      "参照の欄（to）を enum に書く",
      [...ENUM_STATUS, "        to: member"],
      "SHAPE_KEY_UNKNOWN",
    ],
  ] as const)("%s は %s で断る", (_label, status, code) => {
    expect(codesOf(failure(checkSpec(withStatus(status))))).toEqual([code]);
  });
});

// ── 1c. 日付（date）と「今日」（today()）（M1.3。Issue #155） ───────
//
// `date` は 1 語で書く型である（`ref` のような写像ではない）。式では**日付どうしでだけ**比べられ、
// `today()` は引数を取らない。落とすときの 2 つのコードは**別である**（受入条件）。

describe("日付（date）と「今日」（today()）（M1.3）", () => {
  /** 土台の entity に日付の項目を足したもの（ほかの欄は BASE_PARTS のまま。誤りを重ねない） */
  const dateEntity = `${BASE_PARTS.entities}\n      due: date`;

  /** 日付の項目を使う検査の式を 1 つ持つ宣言（`entities` は差し替えられる） */
  const dateDeclaration = (expression: string, entities: string = dateEntity): string =>
    declaration({
      entities,
      validations: [
        "  - name: dueBeforeToday",
        "    entity: expense",
        `    expression: ${expression}`,
      ].join("\n"),
    });

  it("due: date を書ける（宣言に date として残る。受入条件）", () => {
    const result = checkSpec(dateDeclaration("due < today()"));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.entities[0]?.fields["due"]).toBe("date");
  });

  it("日付どうしの比較は通り、today() も書ける（受入条件）", () => {
    expect(codesOf(checkSpec(dateDeclaration("due < today()")))).toEqual([]);
    expect(codesOf(checkSpec(dateDeclaration("due == today()")))).toEqual([]);
    expect(codesOf(checkSpec(dateDeclaration("today() <= due")))).toEqual([]);
  });

  it("日付の項目は 1 語で書く（知らない型は今までどおり断る）", () => {
    const text = declaration({ entities: `${BASE_PARTS.entities}\n      due: datetime` });
    expect(codesOf(failure(checkSpec(text)))).toEqual(["DATA_FIELD_TYPE_UNKNOWN"]);
  });

  it("日付は数の計算に使えない", () => {
    expect(codesOf(failure(checkSpec(dateDeclaration("due + amount > 0"))))).toEqual([
      "LOGIC_OPERAND_TYPE_MISMATCH",
    ]);
  });

  it("日付と数の比較は LOGIC_OPERAND_TYPE_MISMATCH で落ちる（受入条件。負例と同じ形）", () => {
    const result = failure(checkSpec(dateDeclaration("due < 1")));
    expect(codesOf(result)).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
  });

  it("today に引数を渡すと LOGIC_FUNCTION_ARITY_MISMATCH で落ちる（受入条件。負例と同じ形）", () => {
    const result = failure(checkSpec(dateDeclaration("due < today(1)")));
    expect(codesOf(result)).toEqual(["LOGIC_FUNCTION_ARITY_MISMATCH"]);
  });

  it("2 つの誤りコードは別である（受入条件）", () => {
    const compared = codesOf(failure(checkSpec(dateDeclaration("due < 1"))));
    const called = codesOf(failure(checkSpec(dateDeclaration("due < today(1)"))));
    expect(compared).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
    expect(called).toEqual(["LOGIC_FUNCTION_ARITY_MISMATCH"]);
    expect(compared).not.toEqual(called);
  });
});

// ── 1e. 決まった値への書き換え（set）とボタンを出す条件（when）（M1.3。Issue #156） ──
//
// **`when` はロジック層の守りである**（`03-spec-layers-and-checker.md` §2.2）。ここで確かめるのは
// 宣言の側だけ——**式は評価しない**。断るのは data-api で、それは app-api.test.ts が見る。
//
// 書ける欄は `kind` が決める（語彙は閉じている）。`set` に書けるのは**決まった値だけ**で、
// 値はその項目の型に合っていなければならない。負例 3 本（set-type-mismatch・set-with-expression・
// when-not-boolean）が、同じことを外から確かめる。

describe("決まった値への書き換え（set）とボタンを出す条件（when）（M1.3）", () => {
  const STATUS: readonly string[] = [
    "      status:",
    "        type: enum",
    "        options:",
    "          todo: 未着手",
    "          doing: 進行中",
    "          done: 完了",
    "        default: todo",
  ];

  /** 選択肢の項目 status を持つ expense に、操作を差し替えた宣言 */
  const withActions = (...lines: readonly string[]): string =>
    declaration({ entities: enumEntity(STATUS), actions: ["  - name: addExpense", "    entity: expense", ...lines].join("\n") });

  /** `kind: update` の操作 finish（`set` と `when` を持つ）を足す */
  const finish = (...lines: readonly string[]): string =>
    withActions("  - name: finish", "    entity: expense", "    kind: update", ...lines);

  it("set と when を持つ操作が通り、宣言にそのまま残る（受入条件）", () => {
    const text = finish("    set:", "      status: done", '    when: status != "done"');
    const result = checkSpec(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.actions).toEqual([
      { name: "addExpense", entity: "expense" },
      {
        name: "finish",
        entity: "expense",
        kind: "update",
        set: { status: "done" },
        when: 'status != "done"',
      },
    ]);
  });

  it("数の項目の set は、数として残る（YAML の字面を数へ読み直す）", () => {
    const result = checkSpec(finish("    set:", "      amount: 0"));
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) return;
    expect(result.spec.actions[1]).toEqual({
      name: "finish",
      entity: "expense",
      kind: "update",
      set: { amount: 0 },
    });
  });

  it("when は kind: delete にも書ける（set は書けない。書き換える値が無い）", () => {
    const remove = (...lines: readonly string[]): string =>
      withActions("  - name: dropExpense", "    entity: expense", "    kind: delete", ...lines);
    const ok = checkSpec(remove('    when: status == "done"'));
    expect(ok.diagnostics).toEqual([]);
    if (ok.ok) {
      expect(ok.spec.actions[1]).toEqual({
        name: "dropExpense",
        entity: "expense",
        kind: "delete",
        when: 'status == "done"',
      });
    }
    expect(codesOf(failure(checkSpec(remove("    set:", "      status: done"))))).toEqual([
      "SHAPE_KEY_UNKNOWN",
    ]);
  });

  it("create（kind の省略を含む）には set も when も書けない（語彙は閉じている）", () => {
    for (const kind of ["", "    kind: create"]) {
      const lines = kind === "" ? [] : [kind];
      expect(
        codesOf(failure(checkSpec(withActions("  - name: other", "    entity: expense", ...lines, '    when: status == "done"')))),
        kind,
      ).toEqual(["SHAPE_KEY_UNKNOWN"]);
      expect(
        codesOf(failure(checkSpec(withActions("  - name: other", "    entity: expense", ...lines, "    set:", "      status: done")))),
        kind,
      ).toEqual(["SHAPE_KEY_UNKNOWN"]);
    }
  });

  it("3 つの誤りのコードは、それぞれ別である（受入条件）", () => {
    const codes = [
      // set の値が、その項目の型に合わない（enum のキーに無い）
      codesOf(failure(checkSpec(finish("    set:", "      status: finished")))),
      // set に式を書いている
      codesOf(failure(checkSpec(finish("    set:", "      amount: amount + 1")))),
      // when が真偽にならない
      codesOf(failure(checkSpec(finish("    set:", "      status: done", "    when: payer")))),
    ];
    expect(codes).toEqual([
      ["LOGIC_ACTION_SET_TYPE_MISMATCH"],
      ["LOGIC_ACTION_SET_NOT_CONSTANT"],
      ["LOGIC_ACTION_WHEN_NOT_BOOLEAN"],
    ]);
    expect(new Set(codes.flat()).size).toBe(3);
  });

  it.each([
    ["set-type-mismatch", "LOGIC_ACTION_SET_TYPE_MISMATCH", "finished"],
    ["set-with-expression", "LOGIC_ACTION_SET_NOT_CONSTANT", "estimate"],
    ["when-not-boolean", "LOGIC_ACTION_WHEN_NOT_BOOLEAN", "finish"],
  ] as const)("負例 %s は %s **だけ**を返す（受入条件）", (name, code, where) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(messagesOf(result, code)).toContain(where);
  });

  it("set の項目が entity に無ければ断る（黙って捨てない）", () => {
    const result = failure(checkSpec(finish("    set:", "      ammount: 1")));
    expect(codesOf(result)).toEqual(["LOGIC_ACTION_SET_FIELD_NOT_FOUND"]);
    expect(messagesOf(result, "LOGIC_ACTION_SET_FIELD_NOT_FOUND")).toContain("ammount");
  });

  it("並びと参照の項目には、決まった値を書けない", () => {
    const result = failure(checkSpec(finish("    set:", "      participants: A")));
    expect(codesOf(result)).toEqual(["LOGIC_ACTION_SET_TYPE_MISMATCH"]);
    expect(messagesOf(result, "LOGIC_ACTION_SET_TYPE_MISMATCH")).toContain("participants");
  });

  it("set の値に式を書けば、型の食い違いではなく「定数ではない」で断る", () => {
    for (const value of ["amount + 1", "today()", "len(participants)", "-amount"]) {
      expect(codesOf(failure(checkSpec(finish("    set:", `      amount: ${value}`)))), value).toEqual([
        "LOGIC_ACTION_SET_NOT_CONSTANT",
      ]);
    }
    // 名前 1 つは「式」ではなく「決まった値の書き間違い」である（enum のキーに無い）
    expect(codesOf(failure(checkSpec(finish("    set:", "      status: doingg"))))).toEqual([
      "LOGIC_ACTION_SET_TYPE_MISMATCH",
    ]);
  });

  it("set の形が違えば、値の検査の前に形で断る", () => {
    expect(codesOf(failure(checkSpec(finish("    set: done"))))).toEqual(["SHAPE_VALUE_INVALID"]);
    expect(codesOf(failure(checkSpec(finish("    set:", "      status:"))))).toEqual(["SHAPE_VALUE_INVALID"]);
    expect(codesOf(failure(checkSpec(finish("    set:", "      status: done", "    when:"))))).toEqual([
      "SHAPE_VALUE_INVALID",
    ]);
  });

  it("when の式は、同じ entity の項目と計算だけを参照できる（検査の式と同じ扱い）", () => {
    expect(codesOf(failure(checkSpec(finish("    when: headcount > 0 == 1"))))).toEqual([
      "LOGIC_EXPRESSION_INVALID",
    ]);
    expect(codesOf(failure(checkSpec(finish("    when: ammount > 0"))))).toEqual([
      "LOGIC_REFERENCE_NOT_FOUND",
    ]);
    expect(codesOf(failure(checkSpec(finish("    when: budget.limit > 0"))))).toEqual([
      "LOGIC_REFERENCE_NOT_FOUND",
    ]);
    // 計算（computed）は参照できる
    expect(checkSpec(finish("    when: headcount > 0")).diagnostics).toEqual([]);
  });

  it("enum の項目を options に無いキーと比べたら落ちる（受入条件）", () => {
    const result = failure(checkSpec(finish('    when: status == "todu"')));
    expect(codesOf(result)).toEqual(["LOGIC_ENUM_KEY_NOT_FOUND"]);
    const message = messagesOf(result, "LOGIC_ENUM_KEY_NOT_FOUND");
    expect(message).toContain("todu");
    // 正しいキーの一覧を、人が読める形で添える
    expect(message).toContain("todo");
    // 位置は、比べている文字列の定数を指す
    const text = finish('    when: status == "todu"');
    expect(result.diagnostics[0]).toMatchObject(locate(text, '"todu"'));
  });

  it.each(["==", "!="] as const)("options のキーと %s で比べる式は通る", (operator) => {
    for (const key of ["todo", "doing", "done"]) {
      const result = checkSpec(finish(`    when: status ${operator} "${key}"`));
      expect(result.diagnostics, `${operator} ${key}`).toEqual([]);
    }
  });

  it("検査の式と計算の式でも、enum のキーの照合は効く（同じ経路で解く）", () => {
    const validation = declaration({
      entities: enumEntity(STATUS),
      validations: ["  - name: notArchived", "    entity: expense", '    expression: status != "archived"'].join("\n"),
    });
    expect(codesOf(failure(checkSpec(validation)))).toEqual(["LOGIC_ENUM_KEY_NOT_FOUND"]);
  });

  it("型の誤りがある式には、キーの照合を重ねない（1 つの誤りは 1 つのコード）", () => {
    // 綴りの間違い（参照が無い）だけを返す
    expect(codesOf(failure(checkSpec(finish('    when: statuss == "todu"'))))).toEqual([
      "LOGIC_REFERENCE_NOT_FOUND",
    ]);
  });
});

// ── 1f. 表示名（label）（M1.3。Issue #176） ─────────────────────────
//
// `label` は**画面に出すためだけ**の語彙である。付けられるのは**項目（`fields`）と計算（`computed`）
// の 2 つだけ**で（追記 2）、**式からは読めない**（式が読むのは識別子だけである）。無ければ識別子を
// そのまま出す。落とすときの 2 つのコードは**別である**——負例 2 本（label-empty・label-not-string）が、
// 同じことを外から確かめる。

describe("表示名（label）（M1.3）", () => {
  /** 項目と計算に `label` を付けた宣言（ほかの欄は土台のまま） */
  const labeled = (): string =>
    declaration({
      entities: [
        "  - name: member",
        "    fields:",
        "      name: string",
        "  - name: expense",
        "    fields:",
        "      amount:",
        "        type: number",
        "        label: 金額",
        "      payer: string",
        "      participants:",
        "        type: list",
        "        of: member",
        "        label: 割る人",
      ].join("\n"),
      computed: [
        "  - name: headcount",
        "    entity: expense",
        "    expression: len(participants)",
        "    type: number",
        "    label: 人数",
      ].join("\n"),
    });

  it("項目と計算の label が、宣言のまま残る（受入条件）", () => {
    const result = checkSpec(labeled());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expense = result.spec.entities.find((entity) => entity.name === "expense");
    // 写像で書いた 1 語の型は、`label` つきの写像として残る
    expect(expense?.fields["amount"]).toEqual({ type: "number", label: "金額" });
    // `label` を書かない項目は、識別子のまま（1 語のスカラ）
    expect(expense?.fields["payer"]).toBe("string");
    // 参照の並び（`list of`）にも `label` を書ける
    expect(expense?.fields["participants"]).toEqual({ type: "list", of: "member", label: "割る人" });
    expect(result.spec.computed[0]).toEqual({
      name: "headcount",
      entity: "expense",
      expression: "len(participants)",
      type: "number",
      label: "人数",
    });
  });

  it("label を書かなければ、計算の欄そのものが無い（識別子のまま出す）", () => {
    const result = checkSpec(declaration());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.spec.computed[0] ?? {}).sort()).toEqual([
      "entity",
      "expression",
      "name",
      "type",
    ]);
  });

  it.each([
    ["entity", declaration({ entities: `${BASE_PARTS.entities}\n    label: 金額` })],
    ["一覧（view）", declaration({ views: `${BASE_PARTS.views}\n    label: 支出` })],
    ["操作（action）", declaration({ actions: `${BASE_PARTS.actions}\n    label: 追加` })],
  ] as const)(
    "%s に label を書けば SHAPE_KEY_UNKNOWN（追記 2 で絞った範囲の外。受入条件）",
    (_where, text) => {
      const result = failure(checkSpec(text));
      expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
      expect(messagesOf(result, "SHAPE_KEY_UNKNOWN")).toContain("label");
    },
  );

  it("式の中から label を参照すれば LOGIC_REFERENCE_NOT_FOUND（受入条件）", () => {
    const text = declaration({
      entities: [
        "  - name: expense",
        "    fields:",
        "      amount:",
        "        type: number",
        "        label: 金額",
        "      participants: list",
      ].join("\n"),
      validations: ["  - name: positiveAmount", "    entity: expense", "    expression: label > 0"].join("\n"),
    });
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["LOGIC_REFERENCE_NOT_FOUND"]);
    expect(messagesOf(result, "LOGIC_REFERENCE_NOT_FOUND")).toContain("label");
  });

  it("空と、文字列でない label は、それぞれ別のコードで落ちる（受入条件）", () => {
    const empty = codesOf(
      failure(
        checkSpec(
          declaration({
            entities: [
              "  - name: expense",
              "    fields:",
              "      amount:",
              "        type: number",
              "        label:",
              "      participants: list",
            ].join("\n"),
          }),
        ),
      ),
    );
    const notString = codesOf(
      failure(
        checkSpec(
          declaration({
            computed: [
              "  - name: headcount",
              "    entity: expense",
              "    expression: len(participants)",
              "    type: number",
              "    label: [人数]",
            ].join("\n"),
          }),
        ),
      ),
    );
    expect(empty).toEqual(["SHAPE_LABEL_EMPTY"]);
    expect(notString).toEqual(["SHAPE_LABEL_INVALID"]);
    expect(empty).not.toEqual(notString);
    for (const code of [...empty, ...notString]) expect(isDiagnosticCode(code), code).toBe(true);
  });

  it.each([
    ["label-empty", "SHAPE_LABEL_EMPTY", "title"],
    ["label-not-string", "SHAPE_LABEL_INVALID", "overdue"],
  ] as const)("負例 %s は %s **だけ**を返す（受入条件）", (name, code, where) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(messagesOf(result, code)).toContain(where);
  });
});

// ── 2. 負例 54 件 ──────────────────────────────────────────────

describe("負例（appspec-schema の samples/negatives）", () => {
  it("負例の一覧は 54 件である（0 件なら以降のテストが空振りする。M1.3 の #176 で 2 本、M1.4 の #178 で 2 本、#179 で 2 本足した）", () => {
    expect(negativeIndex.negatives).toHaveLength(54);
  });

  it.each(negativeCases)(
    "%s: 返る誤りコードの集合が、一覧の codes とちょうど一致する",
    (name: string, negative: NegativeSample) => {
      const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
      expect(codesOf(result)).toEqual([...negative.codes].sort());
    },
  );

  it.each(negativeCases)("%s: どの診断も、説明が空でなく、原文の行と列を指す", (name: string) => {
    const text = negativeTexts.get(name) ?? "";
    const lines = text.split("\n");
    const diagnostics = failure(checkSpec(text)).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message, `${name} ${diagnostic.code}`).not.toBe("");
      expect(isDiagnosticCode(diagnostic.code), diagnostic.code).toBe(true);
      expect(diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(diagnostic.line).toBeLessThanOrEqual(lines.length);
      expect(diagnostic.column).toBeGreaterThanOrEqual(1);
      // 位置が指す行は、宣言の中身がある行である（空行やコメントを指さない）
      const pointed = lines[diagnostic.line - 1] ?? "";
      expect(pointed.trim(), `${name} ${diagnostic.code}`).not.toBe("");
      expect(pointed.trimStart().startsWith("#"), `${name} ${diagnostic.code}`).toBe(false);
    }
  });

  it.each([
    ["computed-cycle", "LOGIC_COMPUTED_CYCLE"],
    ["computed-other-entity", "LOGIC_REFERENCE_OUT_OF_ENTITY"],
    ["validation-not-boolean", "LOGIC_VALIDATION_NOT_BOOLEAN"],
    ["number-in-len", "LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH"],
    ["action-unknown-kind", "LOGIC_ACTION_KIND_NOT_ALLOWED"],
    ["view-unknown-type", "SHAPE_KEY_UNKNOWN"],
    ["table-unknown-field", "UI_FIELD_NOT_FOUND"],
    ["string-in-arithmetic", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["list-in-comparison", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["min-wrong-arity", "LOGIC_FUNCTION_ARITY_MISMATCH"],
    ["date-compared-with-number", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["today-with-argument", "LOGIC_FUNCTION_ARITY_MISMATCH"],
  ] as const)("%s は %s を返す（受入条件に名指しされた組）", (name, code) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it.each([
    ["ref-unknown-entity", "DATA_REF_TARGET_NOT_FOUND", "payer"],
    ["list-ref-unknown-entity", "DATA_REF_TARGET_NOT_FOUND", "participants"],
    ["validation-message-not-string", "SHAPE_VALIDATION_MESSAGE_INVALID", "message"],
  ] as const)("%s は %s を返す（M1.2 の受入条件）", (name, code, where) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    // 参照先が無いこと／文言が文字列でないこと**だけ**を返す（ほかの誤りに化けない）
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(messagesOf(result, code)).toContain(where);
  });

  it.each([
    ["string-in-arithmetic", "payer * 2", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["list-in-comparison", "participants > 0", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["min-wrong-arity", "min(amount)", "LOGIC_FUNCTION_ARITY_MISMATCH"],
  ] as const)("%s の位置は、該当する式の始まるところを指す", (name, expression, code) => {
    const text = negativeTexts.get(name) ?? "";
    const result = failure(checkSpec(text));
    const diagnostic = result.diagnostics.find((candidate) => candidate.code === code);
    expect(diagnostic, code).toBeDefined();
    // 式は YAML の値なので、位置は `expression: ` の後ろ（式の先頭）を指す
    expect({ line: diagnostic?.line, column: diagnostic?.column }).toEqual(locate(text, expression));
  });

  it("式の途中の誤りは、その名前の位置を指す（赤字の位置ではなく、参照の位置）", () => {
    const broken = sampleText.replace("expression: amount > 0", "expression: ammount > 0");
    const result = failure(checkSpec(broken));
    const diagnostic = result.diagnostics.find((entry) => entry.code === "LOGIC_REFERENCE_NOT_FOUND");
    expect(diagnostic).toMatchObject(locate(broken, "ammount > 0"));
  });
});

// ── 2b. 操作の種類（kind。M1.2。Issue #109） ────────────────────
//
// `kind` は M1.2 で入った語彙である。**語彙は閉じている**——書けるのは create・update・delete だけで、
// 省略は create（M1.1 の宣言の意味を変えない）である。**導入で正例になった `action-with-kind`**
// （`kind: create` を書いた操作）を、負例から正例へ移した。

describe("操作の種類（kind。M1.2）", () => {
  const action = (body: string): string =>
    declaration({ actions: `  - name: addExpense\n    entity: expense\n${body}` });

  it("kind: create を書ける（負例 action-with-kind の正例。受入条件）", () => {
    const result = checkSpec(action("    kind: create"));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.actions).toEqual([{ name: "addExpense", entity: "expense", kind: "create" }]);
    }
  });

  it.each(["create", "update", "delete"] as const)("kind: %s を書ける（3 つだけである）", (kind) => {
    const result = checkSpec(action(`    kind: ${kind}`));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.actions).toEqual([{ name: "addExpense", entity: "expense", kind }]);
  });

  it("kind を省略すると、欄そのものが無い（＝ create。M1.1 の宣言を変えない）", () => {
    const result = checkSpec(declaration());
    expect(result.diagnostics).toEqual([]);
    if (result.ok) expect(result.spec.actions).toEqual([{ name: "addExpense", entity: "expense" }]);
  });

  it("未知の kind は LOGIC_ACTION_KIND_NOT_ALLOWED（負例 action-unknown-kind。受入条件）", () => {
    const text = action("    kind: patch");
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["LOGIC_ACTION_KIND_NOT_ALLOWED"]);
    // **正本の一覧（diagnostics.ts の DIAGNOSTIC_CODES）にある**——実装側だけで定義しない
    expect(isDiagnosticCode("LOGIC_ACTION_KIND_NOT_ALLOWED")).toBe(true);
    expect(messagesOf(result, "LOGIC_ACTION_KIND_NOT_ALLOWED")).toContain("patch");
    // 位置は、書いた語を指す
    expect(result.diagnostics[0]).toMatchObject(locate(text, "patch"));
  });

  it("kind が空なら SHAPE_VALUE_INVALID（語彙の照合の前に、形で断る）", () => {
    expect(codesOf(failure(checkSpec(action("    kind:"))))).toEqual(["SHAPE_VALUE_INVALID"]);
  });

  it("kind 以外の欄は書けない（語彙は閉じている）", () => {
    expect(codesOf(failure(checkSpec(action("    when: true"))))).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });
});

// ── 3. 形（7 欄・未知キー・名前・重複・値の形） ──────────────────

describe("形の検査", () => {
  it("土台の宣言は通る（これが緑でなければ、ほかのテストは意味を持たない）", () => {
    const result = checkSpec(declaration());
    expect(result.diagnostics, messagesOf(result, "SHAPE_KEY_MISSING")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(APPSPEC_SECTIONS)("欄 %s が無ければ断る", (section) => {
    const result = failure(checkSpec(withoutSection(declaration(), section)));
    expect(codesOf(result)).toContain("SHAPE_KEY_MISSING");
    expect(messagesOf(result, "SHAPE_KEY_MISSING")).toContain(section);
  });

  it.each([
    ["宣言の直下", `${declaration()}\nintegrations: []`, "integrations"],
    ["entity の要素", declaration({ entities: `${BASE_PARTS.entities}\n    label: 金額` }), "label"],
    ["view の要素", declaration({ views: `${BASE_PARTS.views}\n    label: 支出` }), "label"],
    ["minIdentity", `${declaration()}\n  google: true`, "google"],
  ] as const)("%s に語彙の無いキー %s を書くと断る", (_where, text, key) => {
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
    expect(messagesOf(result, "SHAPE_KEY_UNKNOWN")).toContain(key);
  });

  it.each([
    ["entity の名前が英字で始まらない", declaration({ entities: entitiess(BASE_PARTS.entities, "  - name: 支出\n    fields:\n      amount: number") })],
    ["項目の名前が数字で始まる", declaration({ entities: "  - name: expense\n    fields:\n      2amount: number", validations: "[]", computed: "[]" })],
    ["validation の名前にハイフン", declaration({ validations: "  - name: positive-amount\n    entity: expense\n    expression: amount > 0" })],
  ] as const)("%s は断る", (_label, text) => {
    expect(codesOf(failure(checkSpec(text)))).toEqual(["SHAPE_NAME_INVALID"]);
  });

  it.each([
    ["名前が空である", declaration({ entities: "  - name:\n    fields:\n      amount: number", validations: "[]", computed: "[]" })],
    ["entity の要素が写像でない", declaration({ entities: "  - expense", validations: "[]", computed: "[]" })],
    ["`fields:` が空である", declaration({ entities: "  - name: expense\n    fields:", validations: "[]", computed: "[]" })],
    ["宣言が写像でない", "- name: expense"],
    ["欄が並びでない", declaration({ entities: "3", validations: "[]", computed: "[]" })],
    ["minIdentity が写像でない", declaration({ minIdentity: "anonymous" })],
    ["`mode` が空である", declaration({ minIdentity: "  mode:" })],
    ["計算の `type` が空である", declaration({ computed: "  - name: headcount\n    entity: expense\n    expression: 1\n    type:" })],
  ] as const)("%s は断る", (_label, text) => {
    expect(codesOf(failure(checkSpec(text)))).toContain("SHAPE_VALUE_INVALID");
  });

  it("entity の要素に fields が無ければ、欠けていることを断る", () => {
    const result = failure(
      checkSpec(declaration({ entities: "  - name: member", views: "[]", actions: "[]", validations: "[]", computed: "[]" })),
    );
    expect(codesOf(result)).toEqual(["SHAPE_KEY_MISSING"]);
    expect(messagesOf(result, "SHAPE_KEY_MISSING")).toContain("fields");
  });

  it.each([
    ["entity", declaration({ entities: entitiess(BASE_PARTS.entities, "  - name: expense\n    fields:\n      amount: number") }), "DATA_ENTITY_DUPLICATE_NAME"],
    ["項目", declaration({ entities: "  - name: expense\n    fields:\n      amount: number\n      amount: number", validations: "[]", computed: "[]" }), "DATA_FIELD_DUPLICATE_NAME"],
    ["computed", declaration({ computed: entitiess(computed("headcount", "len(participants)"), computed("headcount", "1")) }), "LOGIC_COMPUTED_DUPLICATE_NAME"],
    ["validation", declaration({ validations: entitiess(BASE_PARTS.validations, "  - name: positiveAmount\n    entity: expense\n    expression: amount > 1") }), "LOGIC_VALIDATION_DUPLICATE_NAME"],
    ["view", declaration({ views: entitiess(BASE_PARTS.views, BASE_PARTS.views) }), "UI_VIEW_DUPLICATE_NAME"],
    ["action", declaration({ actions: entitiess(BASE_PARTS.actions, BASE_PARTS.actions) }), "LOGIC_ACTION_DUPLICATE_NAME"],
    ["権限", declaration({ permissions: entitiess(BASE_PARTS.permissions, BASE_PARTS.permissions) }), "PERMISSION_DUPLICATE_NAME"],
  ] as const)("同じ %s の名前が 2 つあれば断る", (_label, text, code) => {
    expect(codesOf(failure(checkSpec(text)))).toEqual([code]);
  });

  it("同じ欄を 2 回書けば断る", () => {
    const result = failure(checkSpec(`${declaration()}\nviews: []`));
    expect(codesOf(result)).toContain("SHAPE_KEY_DUPLICATE");
  });
});

// ── 3b. 一覧の種類と、表に出す名前（M1.2。Issue #142） ──────────────
//
// `views` の `type` と `show` は M1.2 で入った語彙である。**導入で正例になった `view-with-type`**
// （`type: table` を書いた一覧）を、負例から正例へ移した。**書ける欄は `type` が決める**（語彙は閉じている）。

describe("一覧の種類と、表に出す名前（M1.2）", () => {
  it("type: table を書ける（負例 view-with-type の正例。受入条件）", () => {
    const result = checkSpec(declaration({ views: `${BASE_PARTS.views}\n    type: table` }));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.views).toEqual([{ name: "expenseList", entity: "expense", type: "table" }]);
    }
  });

  it("type: settlement を書ける（精算の表示は列の並びを持たない）", () => {
    const result = checkSpec(declaration({ views: `${BASE_PARTS.views}\n    type: settlement` }));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.views).toEqual([{ name: "expenseList", entity: "expense", type: "settlement" }]);
    }
  });

  it("show は、実在する項目と計算の名前なら通り、書いた順のまま残る", () => {
    const result = checkSpec(
      declaration({ views: `${BASE_PARTS.views}\n    type: table\n    show: [payer, headcount, amount]` }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.views[0]?.show).toEqual(["payer", "headcount", "amount"]);
  });

  it("知らない種類は SHAPE_KEY_UNKNOWN（負例 view-unknown-type。受入条件）", () => {
    // `board` は M1.3 で語彙に入ったので、知らない種類は別の語で確かめる
    const result = failure(checkSpec(declaration({ views: `${BASE_PARTS.views}\n    type: calendar` })));
    expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
    expect(messagesOf(result, "SHAPE_KEY_UNKNOWN")).toContain("calendar");
  });

  it("show に entity の項目にも計算にも無い名前を書けば UI_FIELD_NOT_FOUND（位置はその名前を指す）", () => {
    const text = declaration({ views: `${BASE_PARTS.views}\n    type: table\n    show: [amount, ammount]` });
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["UI_FIELD_NOT_FOUND"]);
    expect(messagesOf(result, "UI_FIELD_NOT_FOUND")).toContain("ammount");
    expect(result.diagnostics[0]).toMatchObject(locate(text, "ammount"));
  });

  it("show は type: table のときだけ書ける（種類が、書ける欄を決める）", () => {
    // 種類を書かない一覧（M1.1）は show を知らない
    expect(codesOf(failure(checkSpec(declaration({ views: `${BASE_PARTS.views}\n    show: [amount]` }))))).toEqual([
      "SHAPE_KEY_UNKNOWN",
    ]);
    // 精算の表示は列の並びを持たない
    expect(
      codesOf(
        failure(checkSpec(declaration({ views: `${BASE_PARTS.views}\n    type: settlement\n    show: [amount]` }))),
      ),
    ).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });
});

// ── 3c. ボード（board）と強調（highlight）（M1.3。Issue #157） ──────────
//
// `columns` は選択肢（enum）の項目を、`highlight` は真偽（boolean）を返す計算を指さなければならない。
// **落とすときの 2 つのコードは別である**——負例 2 本（board-columns-not-enum・highlight-not-boolean）が、
// 同じことを外から確かめる。`boolean` の計算は列（`show`）には出さない。

describe("ボード（board）と強調（highlight）（M1.3）", () => {
  const STATUS: readonly string[] = [
    "      status:",
    "        type: enum",
    "        options:",
    "          todo: 未着手",
    "          doing: 進行中",
    "          done: 完了",
    "        default: todo",
  ];

  /** 選択肢の項目 status と数の項目 estimate を持つ task の宣言に、ボードの一覧を差し込む */
  const withBoard = (viewLines: readonly string[], computedLines: readonly string[] = []): string =>
    declaration({
      entities: [
        "  - name: task",
        "    fields:",
        "      title: string",
        "      estimate: number",
        ...STATUS,
      ].join("\n"),
      views: ["  - name: taskBoard", "    entity: task", "    type: board", ...viewLines].join("\n"),
      actions: "[]",
      validations: "[]",
      computed: computedLines.length === 0 ? "[]" : computedLines.join("\n"),
    });

  const computedBlock = (name: string, expression: string, type: string): string =>
    [`  - name: ${name}`, "    entity: task", `    expression: ${expression}`, `    type: ${type}`].join("\n");

  const OVERDUE = computedBlock("overdue", 'title == "x"', "boolean");

  it("type: board を書け、columns と highlight が宣言のまま残る（受入条件）", () => {
    const result = checkSpec(withBoard(["    columns: status", "    highlight: overdue"], [OVERDUE]));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.views).toEqual([
      { name: "taskBoard", entity: "task", type: "board", columns: "status", highlight: "overdue" },
    ]);
  });

  it("highlight は書かなくてよい（columns だけのボード）", () => {
    const result = checkSpec(withBoard(["    columns: status"]));
    expect(result.diagnostics).toEqual([]);
    if (result.ok) {
      expect(result.spec.views[0]).toEqual({
        name: "taskBoard",
        entity: "task",
        type: "board",
        columns: "status",
      });
    }
  });

  it("columns が enum でなければ UI_BOARD_COLUMNS_NOT_ENUM で落ちる（受入条件。負例と同じ形）", () => {
    const text = withBoard(["    columns: estimate"]);
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["UI_BOARD_COLUMNS_NOT_ENUM"]);
    expect(messagesOf(result, "UI_BOARD_COLUMNS_NOT_ENUM")).toContain("estimate");
    // 位置は、`columns` に書いた行を指す
    expect(result.diagnostics[0]).toMatchObject({ line: locate(text, "columns: estimate").line });
    expect(isDiagnosticCode("UI_BOARD_COLUMNS_NOT_ENUM")).toBe(true);
  });

  it("highlight が真偽の計算でなければ UI_HIGHLIGHT_NOT_BOOLEAN で落ちる（受入条件。負例と同じ形）", () => {
    const text = withBoard(["    columns: status", "    highlight: count"], [
      computedBlock("count", "estimate + 1", "number"),
    ]);
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["UI_HIGHLIGHT_NOT_BOOLEAN"]);
    expect(messagesOf(result, "UI_HIGHLIGHT_NOT_BOOLEAN")).toContain("count");
    expect(result.diagnostics[0]).toMatchObject(locate(text, "count"));
    expect(isDiagnosticCode("UI_HIGHLIGHT_NOT_BOOLEAN")).toBe(true);
  });

  it("2 つの誤りコードは別である（受入条件）", () => {
    const columns = codesOf(failure(checkSpec(withBoard(["    columns: estimate"]))));
    const highlight = codesOf(
      failure(checkSpec(withBoard(["    columns: status", "    highlight: estimate"]))),
    );
    expect(columns).toEqual(["UI_BOARD_COLUMNS_NOT_ENUM"]);
    expect(highlight).toEqual(["UI_HIGHLIGHT_NOT_BOOLEAN"]);
    expect(columns).not.toEqual(highlight);
  });

  it.each([
    ["board-columns-not-enum", "UI_BOARD_COLUMNS_NOT_ENUM", "estimate"],
    ["highlight-not-boolean", "UI_HIGHLIGHT_NOT_BOOLEAN", "estimate"],
  ] as const)("負例 %s は %s **だけ**を返す（受入条件）", (name, code, where) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(messagesOf(result, code)).toContain(where);
  });

  it("columns は必須である（ボードは列が要る）", () => {
    const result = failure(checkSpec(withBoard([])));
    expect(codesOf(result)).toEqual(["SHAPE_KEY_MISSING"]);
    expect(messagesOf(result, "SHAPE_KEY_MISSING")).toContain("columns");
  });

  it("書ける欄は type が決める（board に show は書けず、table に columns は書けない）", () => {
    expect(codesOf(failure(checkSpec(withBoard(["    columns: status", "    show: [title]"]))))).toEqual([
      "SHAPE_KEY_UNKNOWN",
    ]);
    expect(
      codesOf(
        failure(
          checkSpec(
            declaration({ views: `${BASE_PARTS.views}\n    type: table\n    columns: status` }),
          ),
        ),
      ),
    ).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });

  it("columns が写像や並びなら、形で断る（名前を 1 つ書く）", () => {
    expect(codesOf(failure(checkSpec(withBoard(["    columns: [status]"]))))).toEqual([
      "SHAPE_VALUE_INVALID",
    ]);
  });

  it("boolean の計算は列（show）にできない（一覧の列に出さない。受入条件）", () => {
    const text = declaration({
      entities: [
        "  - name: task",
        "    fields:",
        "      title: string",
        ...STATUS,
      ].join("\n"),
      views: ["  - name: taskList", "    entity: task", "    type: table", "    show: [title, overdue]"].join("\n"),
      actions: "[]",
      validations: "[]",
      computed: OVERDUE,
    });
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["UI_FIELD_NOT_FOUND"]);
    expect(messagesOf(result, "UI_FIELD_NOT_FOUND")).toContain("overdue");
  });

  it("集計（aggregate）には boolean を書けない（数を返す。受入条件の線引き）", () => {
    const text = declaration({
      entities: [
        "  - name: task",
        "    fields:",
        "      title: string",
        ...STATUS,
      ].join("\n"),
      views: "[]",
      actions: "[]",
      validations: "[]",
      computed: [
        "  - name: count",
        "    entity: task",
        "    aggregate:",
        "      count: task",
        "    type: boolean",
      ].join("\n"),
    });
    expect(codesOf(failure(checkSpec(text)))).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });

  it("式の計算の type: boolean は、真偽になる式だけが通る（型が食い違えば断る）", () => {
    expect(checkSpec(withBoard(["    columns: status", "    highlight: overdue"], [OVERDUE])).ok).toBe(true);
    expect(
      codesOf(
        failure(
          checkSpec(
            withBoard(["    columns: status"], [computedBlock("overdue", "estimate + 1", "boolean")]),
          ),
        ),
      ),
    ).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });
});

// ── 3d. 一覧（list）と絞り込み（filters）（M1.3。Issue #158） ────────────
//
// `type: list` は `show` を `table` と同じ扱いで持ち、`filters`（UX 層）で画面の中を絞り込める。
// **絞り込みは画面の中で行う**ので、静的チェックが見るのは「指せる項目か」だけである。落とすときの
// 2 つのコードは**別である**——負例 2 本（filters-unsupported-field・filters-field-not-shown）が、
// 同じことを外から確かめる。

describe("一覧（list）と絞り込み（filters）（M1.3）", () => {
  const STATUS: readonly string[] = [
    "      status:",
    "        type: enum",
    "        options:",
    "          todo: 未着手",
    "          doing: 進行中",
    "          done: 完了",
    "        default: todo",
  ];

  /** 選択肢の項目 status と参照の項目 assignee を持つ task に、一覧（type: list）を差し込む */
  const withList = (viewLines: readonly string[]): string =>
    declaration({
      entities: [
        "  - name: member",
        "    fields:",
        "      name: string",
        "  - name: task",
        "    fields:",
        "      title: string",
        "      estimate: number",
        "      assignee:",
        "        type: ref",
        "        to: member",
        ...STATUS,
      ].join("\n"),
      views: ["  - name: taskList", "    entity: task", "    type: list", ...viewLines].join("\n"),
      actions: "[]",
      validations: "[]",
      computed: "[]",
    });

  it("type: list を書け、show と filters が宣言のまま残る（受入条件）", () => {
    const result = checkSpec(
      withList(["    show: [title, status, assignee]", "    filters: [assignee, status]"]),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.views).toEqual([
      {
        name: "taskList",
        entity: "task",
        type: "list",
        show: ["title", "status", "assignee"],
        filters: ["assignee", "status"],
      },
    ]);
  });

  it("show の扱いは table と揃う（書いた順のまま。実在しない名前は UI_FIELD_NOT_FOUND）", () => {
    const result = checkSpec(withList(["    show: [status, title]"]));
    expect(result.diagnostics).toEqual([]);
    if (result.ok) expect(result.spec.views[0]?.show).toEqual(["status", "title"]);
    // 実在しない名前は、table と同じコードで断る
    expect(codesOf(failure(checkSpec(withList(["    show: [title, ammount]"]))))).toEqual([
      "UI_FIELD_NOT_FOUND",
    ]);
  });

  it("filters は、show にあり enum か ref の項目なら通る（宣言の順のまま）", () => {
    for (const filters of ["[status]", "[assignee]", "[]"]) {
      const result = checkSpec(withList(["    show: [title, status, assignee]", `    filters: ${filters}`]));
      expect(result.diagnostics, filters).toEqual([]);
    }
  });

  it("2 つの誤りのコードは、それぞれ別である（受入条件）", () => {
    const unsupported = codesOf(
      failure(checkSpec(withList(["    show: [title, estimate]", "    filters: [estimate]"]))),
    );
    const notShown = codesOf(failure(checkSpec(withList(["    show: [title]", "    filters: [status]"]))));
    expect(unsupported).toEqual(["UI_FILTER_FIELD_NOT_FILTERABLE"]);
    expect(notShown).toEqual(["UI_FILTER_FIELD_NOT_SHOWN"]);
    expect(unsupported).not.toEqual(notShown);
    // コードは正本の一覧（diagnostics.ts の DIAGNOSTIC_CODES）にある
    for (const code of [...unsupported, ...notShown]) expect(isDiagnosticCode(code)).toBe(true);
  });

  it.each([
    ["filters-unsupported-field", "UI_FILTER_FIELD_NOT_FILTERABLE", "estimate"],
    ["filters-field-not-shown", "UI_FILTER_FIELD_NOT_SHOWN", "status"],
  ] as const)("負例 %s は %s **だけ**を返す（受入条件）", (name, code, where) => {
    const result = failure(checkSpec(negativeTexts.get(name) ?? ""));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(messagesOf(result, code)).toContain(where);
  });

  it("filters は type: list のときだけ書ける（語彙は閉じている）", () => {
    // 表（type: table）は filters を知らない
    expect(
      codesOf(failure(checkSpec(declaration({ views: `${BASE_PARTS.views}\n    type: table\n    filters: [payer]` })))),
    ).toEqual(["SHAPE_KEY_UNKNOWN"]);
    // 種類を書かない一覧（M1.1）も同じ
    expect(
      codesOf(failure(checkSpec(declaration({ views: `${BASE_PARTS.views}\n    filters: [payer]` })))),
    ).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });

  it("filters の形が違えば、名前の照合の前に形で断る", () => {
    expect(codesOf(failure(checkSpec(withList(["    show: [title]", "    filters: status"]))))).toEqual([
      "SHAPE_VALUE_INVALID",
    ]);
  });

  it("show を書いていなければ、項目（宣言の順）が並ぶものとして扱う", () => {
    const result = checkSpec(withList(["    filters: [status]"]));
    expect(result.diagnostics).toEqual([]);
    if (result.ok) expect(result.spec.views[0]?.filters).toEqual(["status"]);
  });

  it("負例 view-unknown-type は、list が実在の語になっても負例のままである（追記3）", () => {
    const text = negativeTexts.get("view-unknown-type") ?? "";
    // #157 が実在の語でない button に差し替えてある（list に変わっていない）
    expect(text).toContain("type: button");
    expect(codesOf(failure(checkSpec(text)))).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });
});

// ── 4. データ層・ロジック層・UI・権限 ──────────────────────────

describe("データ層・ロジック層・UI・権限の検査", () => {
  it("店頭が付ける値の名前は、項目にも計算にも使えない", () => {
    const field = failure(
      checkSpec(declaration({ entities: "  - name: expense\n    fields:\n      createdAt: string", validations: "[]", computed: "[]" })),
    );
    expect(codesOf(field)).toEqual(["DATA_FIELD_NAME_RESERVED"]);
    const computedReserved = failure(
      checkSpec(declaration({ computed: computed("id", "len(participants)") })),
    );
    expect(codesOf(computedReserved)).toEqual(["LOGIC_COMPUTED_NAME_RESERVED"]);
  });

  it("M1.1 に無い項目の型は断る", () => {
    const result = failure(
      checkSpec(declaration({ entities: "  - name: expense\n    fields:\n      amount: integer\n      participants: list" })),
    );
    expect(codesOf(result)).toEqual(["DATA_FIELD_TYPE_UNKNOWN"]);
    expect(messagesOf(result, "DATA_FIELD_TYPE_UNKNOWN")).toContain("integer");
  });

  it("計算の名前が項目の名前と重なれば断る", () => {
    const result = failure(checkSpec(declaration({ computed: computed("amount", "len(participants)") })));
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_NAME_CONFLICT"]);
  });

  it("M1.1 に無い計算の型は断る", () => {
    const result = failure(checkSpec(declaration({ computed: computed("headcount", "len(participants)", "string") })));
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_TYPE_UNKNOWN"]);
  });

  it("計算の式と type が食い違えば断る", () => {
    const result = failure(checkSpec(declaration({ computed: computed("isPositive", "amount > 0") })));
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });

  it("検査の式が真偽にならなければ断る", () => {
    const result = failure(
      checkSpec(declaration({ validations: "  - name: positiveAmount\n    entity: expense\n    expression: amount" })),
    );
    expect(codesOf(result)).toEqual(["LOGIC_VALIDATION_NOT_BOOLEAN"]);
  });

  it("未知の参照を断る（同じ entity の項目と計算だけを見る）", () => {
    const result = failure(
      checkSpec(declaration({ validations: "  - name: positiveAmount\n    entity: expense\n    expression: ammount > 0" })),
    );
    expect(codesOf(result)).toEqual(["LOGIC_REFERENCE_NOT_FOUND"]);
  });

  it("別の entity をドットで参照すると断る", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: entitiess(BASE_PARTS.entities, "  - name: budget\n    fields:\n      limit: number"),
          computed: computed("overBudget", "amount - budget.limit"),
          validations: "[]",
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_REFERENCE_OUT_OF_ENTITY"]);
    expect(messagesOf(result, "LOGIC_REFERENCE_OUT_OF_ENTITY")).toContain("budget");
  });

  it("未知の entity を参照する view・action を断る", () => {
    expect(codesOf(failure(checkSpec(declaration({ views: "  - name: expenseList\n    entity: expence" }))))).toEqual([
      "UI_ENTITY_NOT_FOUND",
    ]);
    expect(codesOf(failure(checkSpec(declaration({ actions: "  - name: addExpense\n    entity: expence" }))))).toEqual([
      "LOGIC_ENTITY_NOT_FOUND",
    ]);
  });

  it("未知の entity を参照する validation・computed を断る", () => {
    expect(
      codesOf(
        failure(
          checkSpec(
            declaration({
              validations: "  - name: positiveAmount\n    entity: expence\n    expression: amount > 0",
            }),
          ),
        ),
      ),
    ).toEqual(["LOGIC_ENTITY_NOT_FOUND"]);
    expect(
      codesOf(
        failure(
          checkSpec(
            declaration({ computed: "  - name: headcount\n    entity: expence\n    expression: len(participants)\n    type: number" }),
          ),
        ),
      ),
    ).toEqual(["LOGIC_ENTITY_NOT_FOUND"]);
  });

  it("権限の名前・subject と、本人確認の種類を断る", () => {
    expect(codesOf(failure(checkSpec(declaration({ permissions: "  - name: admin\n    subject: minIdentity" }))))).toEqual([
      "PERMISSION_NAME_NOT_ALLOWED",
    ]);
    expect(codesOf(failure(checkSpec(declaration({ permissions: "  - name: write\n    subject: owner" }))))).toEqual([
      "PERMISSION_SUBJECT_NOT_ALLOWED",
    ]);
    expect(codesOf(failure(checkSpec(declaration({ minIdentity: "  mode: google" }))))).toEqual([
      "PERMISSION_IDENTITY_MODE_NOT_ALLOWED",
    ]);
  });
});

describe("参照（ref）と検査の文言（message）（M1.2）", () => {
  const MEMBER = "  - name: member\n    fields:\n      name: string";
  const expenseWithFields = (...fields: readonly string[]): string =>
    declaration({
      entities: entitiess(MEMBER, `  - name: expense\n    fields:\n${fields.join("\n")}`),
      validations: "[]",
      computed: "[]",
    });
  const expenseOf = (result: CheckResult): Readonly<Record<string, unknown>> | undefined => {
    if (!result.ok) return undefined;
    return result.spec.entities.find((entity) => entity.name === "expense")?.fields;
  };

  it("参照先の entity があれば通り、宣言は参照の写像として残る", () => {
    const result = checkSpec(
      expenseWithFields(
        "      payer:",
        "        type: ref",
        "        to: member",
        "      participants:",
        "        type: list",
        "        of: member",
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(expenseOf(result)).toEqual({
      payer: { type: "ref", to: "member" },
      participants: { type: "list", of: "member" },
    });
  });

  it("ref の参照先の entity が無ければ DATA_REF_TARGET_NOT_FOUND", () => {
    const result = failure(
      checkSpec(expenseWithFields("      payer:", "        type: ref", "        to: menber", "      participants: list")),
    );
    expect(codesOf(result)).toEqual(["DATA_REF_TARGET_NOT_FOUND"]);
    expect(messagesOf(result, "DATA_REF_TARGET_NOT_FOUND")).toContain("menber");
  });

  it("参照の並び（list of）の参照先が無ければ DATA_REF_TARGET_NOT_FOUND", () => {
    const result = failure(
      checkSpec(
        expenseWithFields(
          "      payer: string",
          "      participants:",
          "        type: list",
          "        of: menber",
        ),
      ),
    );
    expect(codesOf(result)).toEqual(["DATA_REF_TARGET_NOT_FOUND"]);
    expect(messagesOf(result, "DATA_REF_TARGET_NOT_FOUND")).toContain("participants");
  });

  it("ref に to が無ければ、欠けていることを断る", () => {
    const result = failure(checkSpec(expenseWithFields("      payer:", "        type: ref", "      participants: list")));
    expect(codesOf(result)).toEqual(["SHAPE_KEY_MISSING"]);
    expect(messagesOf(result, "SHAPE_KEY_MISSING")).toContain("to");
  });

  it("ref に of を書けば断る（参照先の欄は to だけ）", () => {
    const result = failure(
      checkSpec(expenseWithFields("      payer:", "        type: ref", "        of: member", "      participants: list")),
    );
    expect(codesOf(result)).toContain("SHAPE_KEY_UNKNOWN");
  });

  it("of の無い list の写像は、文字列の並びとして読む（既存の list と同じ）", () => {
    const result = checkSpec(expenseWithFields("      payer: string", "      participants:", "        type: list"));
    expect(result.ok).toBe(true);
    expect(expenseOf(result)?.["participants"]).toBe("list");
  });

  it("検査の文言は、文字列なら通り、宣言にそのまま残る", () => {
    const result = checkSpec(
      declaration({
        validations:
          "  - name: positiveAmount\n    entity: expense\n    expression: amount > 0\n    message: 金額は 1 円以上にしてください",
      }),
    );
    expect(result.diagnostics).toEqual([]);
    if (result.ok) expect(result.spec.validations[0]?.message).toBe("金額は 1 円以上にしてください");
  });

  it("文言が空なら SHAPE_VALIDATION_MESSAGE_INVALID", () => {
    const result = failure(
      checkSpec(
        declaration({
          validations: "  - name: positiveAmount\n    entity: expense\n    expression: amount > 0\n    message:",
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["SHAPE_VALIDATION_MESSAGE_INVALID"]);
  });

  it("文言の HTML も、文字列としてそのまま残る（画面がテキストとして出す）", () => {
    const result = checkSpec(
      declaration({
        validations:
          "  - name: positiveAmount\n    entity: expense\n    expression: amount > 0\n    message: <b>金額</b>は 1 円以上にしてください",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.validations[0]?.message).toBe("<b>金額</b>は 1 円以上にしてください");
    }
  });
});

describe("計算の循環", () => {
  it("自分自身を参照する計算を断る", () => {
    const result = failure(checkSpec(declaration({ computed: computed("first", "first + 1") })));
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
    expect(messagesOf(result, "LOGIC_COMPUTED_CYCLE")).toContain("first");
  });

  it("2 つが互いを参照する循環を断る（負例 computed-cycle と同じ形）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: entitiess(computed("first", "second + 1"), computed("second", "first + 1")),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("3 つ以上の循環も断る（どれが循環か、説明に出す）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: entitiess(
            computed("first", "second + 1"),
            computed("second", "third + 1"),
            computed("third", "first + 1"),
          ),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
    expect(result.diagnostics).toHaveLength(3);
    expect(messagesOf(result, "LOGIC_COMPUTED_CYCLE")).toContain("first");
  });

  it("循環していない参照の連なりは通る", () => {
    const result = checkSpec(
      declaration({
        computed: entitiess(
          computed("total", "amount + 1"),
          computed("headcount", "len(participants)"),
          computed("share", "total + headcount"),
        ),
      }),
    );
    expect(result.ok, messagesOf(result, "LOGIC_COMPUTED_CYCLE")).toBe(true);
  });
});

// ── 4b. 集計（aggregate。M1.2） ──────────────────────────────────
//
// 見本 warikan が使う形（`sum: expense.amount` と `count: expense`、`where` の `this`）を土台に、
// 受入条件が名指しした「sum/count 併記・未知 where 項目・不正な contains 対象」も固定する。

describe("集計（aggregate。M1.2）", () => {
  const MEMBER = "  - name: member\n    fields:\n      name: string";
  const EXPENSE = [
    "  - name: expense",
    "    fields:",
    "      amount: number",
    "      payer:",
    "        type: ref",
    "        to: member",
    "      participants:",
    "        type: list",
    "        of: member",
  ].join("\n");
  const entities = (): string => entitiess(MEMBER, EXPENSE);

  /** member の集計を 1 つ作る。`body` は aggregate の中身（`sum` / `count` / `where`） */
  const aggregateBlock = (name: string, body: readonly string[]): string =>
    [
      `  - name: ${name}`,
      "    entity: member",
      "    aggregate:",
      ...body.map((line) => `      ${line}`),
      "    type: number",
    ].join("\n");

  const withAggregate = (body: readonly string[]): string =>
    declaration({ entities: entities(), validations: "[]", computed: aggregateBlock("total", body) });

  it("sum の対象が数の項目なら通り、宣言に集計の形で残る", () => {
    const result = checkSpec(withAggregate(["sum: expense.amount", "where:", "  payer: this"]));
    expect(result.diagnostics, messagesOf(result, "LOGIC_AGGREGATE_TARGET_NOT_FOUND")).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.computed).toEqual([
      {
        name: "total",
        entity: "member",
        aggregate: { kind: "sum", entity: "expense", name: "amount", where: { payer: { op: "equals" } } },
        type: "number",
      },
    ]);
  });

  it("count と、参照の並びの contains が通る", () => {
    const result = checkSpec(
      withAggregate(["count: expense", "where:", "  participants:", "    contains: this"]),
    );
    expect(result.ok, messagesOf(result, "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH")).toBe(true);
    if (!result.ok) return;
    expect(result.spec.computed[0]).toMatchObject({
      name: "total",
      entity: "member",
      aggregate: {
        kind: "count",
        entity: "expense",
        name: null,
        where: { participants: { op: "contains" } },
      },
    });
  });

  it("sum の対象が別 entity の計算でも通る（集計を参照する式も通る）", () => {
    const result = checkSpec(
      declaration({
        entities: entities(),
        validations: "[]",
        computed: entitiess(
          computed("share", "amount - 1"),
          aggregateBlock("total", ["sum: expense.share"]),
        ),
      }),
    );
    expect(result.ok, messagesOf(result, "LOGIC_AGGREGATE_TARGET_NOT_FOUND")).toBe(true);
  });

  it("sum と count を同時に書けば LOGIC_AGGREGATE_FORM_INVALID", () => {
    const result = failure(checkSpec(withAggregate(["sum: expense.amount", "count: expense"])));
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_FORM_INVALID"]);
  });

  it("式と集計の併記、どちらも無い計算は LOGIC_AGGREGATE_FORM_INVALID", () => {
    const both = declaration({
      entities: entities(),
      validations: "[]",
      computed: [
        "  - name: total",
        "    entity: member",
        "    expression: 1",
        "    aggregate:",
        "      count: expense",
        "    type: number",
      ].join("\n"),
    });
    expect(codesOf(failure(checkSpec(both)))).toEqual(["LOGIC_AGGREGATE_FORM_INVALID"]);

    const neither = declaration({
      entities: entities(),
      validations: "[]",
      computed: ["  - name: total", "    entity: member", "    type: number"].join("\n"),
    });
    expect(codesOf(failure(checkSpec(neither)))).toEqual(["LOGIC_AGGREGATE_FORM_INVALID"]);
  });

  it("未知の where 項目と、比べ方の取り違えは LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH", () => {
    // 集計元に無い項目
    expect(codesOf(failure(checkSpec(withAggregate(["count: expense", "where:", "  ammount: this"]))))).toEqual([
      "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
    ]);
    // 参照（ref）に contains（参照の並びでなければ contains できない）
    expect(
      codesOf(failure(checkSpec(withAggregate(["count: expense", "where:", "  payer:", "    contains: this"])))),
    ).toEqual(["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"]);
    // 参照の並び（list of）に equals（一致では判定できない）
    expect(codesOf(failure(checkSpec(withAggregate(["count: expense", "where:", "  participants: this"]))))).toEqual([
      "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
    ]);
    // 数に equals（this はレコードの ID であり、数ではない）
    expect(codesOf(failure(checkSpec(withAggregate(["count: expense", "where:", "  amount: this"]))))).toEqual([
      "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
    ]);
  });

  // ── 期間の条件（within）と「今月」（M1.4。Issue #178） ────────────────

  /** `date` の項目を持つ支出（`within` の正例に使う） */
  const EXPENSE_WITH_DATE = [
    "  - name: expense",
    "    fields:",
    "      amount: number",
    "      paidOn: date",
  ].join("\n");
  const withDateAggregate = (body: readonly string[]): string =>
    declaration({
      entities: entitiess(MEMBER, EXPENSE_WITH_DATE),
      validations: "[]",
      computed: aggregateBlock("total", body),
    });

  it("期間の条件（within）は、集計元の date の項目を指せば通り、op と period を持つ条件として残る", () => {
    const result = checkSpec(
      withDateAggregate(["sum: expense.amount", "where:", "  paidOn:", "    within: this_month"]),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.computed).toMatchObject([
      {
        name: "total",
        entity: "member",
        aggregate: {
          kind: "sum",
          entity: "expense",
          name: "amount",
          where: { paidOn: { op: "within", period: "this_month" } },
        },
      },
    ]);
  });

  it("期間の条件（within）が date でない項目を指せば LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH（負例と同じ形）", () => {
    expect(
      codesOf(
        failure(
          checkSpec(withDateAggregate(["sum: expense.amount", "where:", "  amount:", "    within: this_month"])),
        ),
      ),
    ).toEqual(["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"]);
  });

  it("知らない期間の名前を書けば LOGIC_AGGREGATE_WHERE_PERIOD_NOT_ALLOWED（負例と同じ形）", () => {
    const result = failure(
      checkSpec(withDateAggregate(["sum: expense.amount", "where:", "  paidOn:", "    within: last_week"])),
    );
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_WHERE_PERIOD_NOT_ALLOWED"]);
    // 期間の名前の誤りは、指す項目の誤り（別のコード）と取り違えない
    expect(codesOf(result)).not.toContain("LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH");
  });

  it("within は、アプリ全体の集計（scope: app）でも通る（this を要らない。M1.4）", () => {
    const result = checkSpec(
      declaration({
        entities: entitiess(MEMBER, EXPENSE_WITH_DATE),
        validations: "[]",
        computed: [
          [
            "  - name: thisMonthTotal",
            "    scope: app",
            "    aggregate:",
            "      sum: expense.amount",
            "      where:",
            "        paidOn:",
            "          within: this_month",
            "    type: number",
          ].join("\n"),
        ].join("\n"),
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("集計の対象は、entity・項目・計算の実在と、数であることを見る", () => {
    expect(codesOf(failure(checkSpec(withAggregate(["count: expence"]))))).toEqual([
      "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
    ]);
    expect(codesOf(failure(checkSpec(withAggregate(["sum: expense.ammount"]))))).toEqual([
      "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
    ]);
    expect(codesOf(failure(checkSpec(withAggregate(["sum: expense.payer"]))))).toEqual([
      "LOGIC_AGGREGATE_TARGET_NOT_NUMBER",
    ]);
    // `entity.名前` の形でない sum
    expect(codesOf(failure(checkSpec(withAggregate(["sum: expense"]))))).toEqual([
      "LOGIC_AGGREGATE_FORM_INVALID",
    ]);
  });

  it("自分自身を集計する計算は、循環として断る", () => {
    const self = declaration({
      entities: entities(),
      validations: "[]",
      computed: aggregateBlock("total", ["sum: member.total"]),
    });
    expect(codesOf(failure(checkSpec(self)))).toEqual(["LOGIC_COMPUTED_CYCLE"]);
  });
});

// ── 4c. 精算（settle。M1.2） ─────────────────────────────────────
//
// 見本 warikan が使う形（支出の entity と、その額・払った人・割る人）を土台に、
// 新しい誤りコード（数の項目でない額・精算する entity を指さない参照）と、
// 式・集計との択一（`type` を持たないこと）を固定する。

describe("精算（settle。M1.2）", () => {
  const MEMBER = "  - name: member\n    fields:\n      name: string";
  const EXPENSE = [
    "  - name: expense",
    "    fields:",
    "      description: string",
    "      amount: number",
    "      payer:",
    "        type: ref",
    "        to: member",
    "      participants:",
    "        type: list",
    "        of: member",
  ].join("\n");
  const entities = (): string => entitiess(MEMBER, EXPENSE);

  /** 支出の entity と 3 つの項目を指す、正しい精算の中身 */
  const SETTLE = ["expense: expense", "amount: amount", "payer: payer", "shares: participants"];

  /** member の精算を 1 つ作る。`body` は settle の中身、`extra` は computed の欄を足すのに使う */
  const settleBlock = (body: readonly string[], extra: readonly string[] = []): string =>
    [
      "  - name: settlement",
      "    entity: member",
      "    settle:",
      ...body.map((line) => `      ${line}`),
      ...extra,
    ].join("\n");

  const withSettle = (body: readonly string[], extra: readonly string[] = []): string =>
    declaration({ entities: entities(), validations: "[]", computed: settleBlock(body, extra) });

  it("支出の entity と 3 つの項目を指す精算は通り、宣言に settle の形で残る（type を持たない）", () => {
    const result = checkSpec(withSettle(SETTLE));
    expect(result.diagnostics, messagesOf(result, "LOGIC_ENTITY_NOT_FOUND")).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.computed).toEqual([
      {
        name: "settlement",
        entity: "member",
        settle: { expense: "expense", amount: "amount", payer: "payer", shares: "participants" },
      },
    ]);
  });

  it("式と精算の併記は LOGIC_AGGREGATE_FORM_INVALID、精算に type を書けば SHAPE_KEY_UNKNOWN", () => {
    const both = declaration({
      entities: entities(),
      validations: "[]",
      computed: settleBlock(SETTLE, ["    expression: 1"]),
    });
    expect(codesOf(failure(checkSpec(both)))).toEqual(["LOGIC_AGGREGATE_FORM_INVALID"]);

    // 精算の値は数ではなく送金の並びなので、`type` は書かない
    expect(codesOf(failure(checkSpec(withSettle(SETTLE, ["    type: number"]))))).toEqual([
      "SHAPE_KEY_UNKNOWN",
    ]);
  });

  it("精算の額が、支出の entity の数の項目でなければ LOGIC_SETTLE_AMOUNT_NOT_NUMBER", () => {
    // 文字列の項目
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: description", "payer: payer", "shares: participants"])))))
      .toEqual(["LOGIC_SETTLE_AMOUNT_NOT_NUMBER"]);
    // 参照（ref）の項目
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: payer", "payer: payer", "shares: participants"])))))
      .toEqual(["LOGIC_SETTLE_AMOUNT_NOT_NUMBER"]);
    // 支出の entity に無い項目
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: ammount", "payer: payer", "shares: participants"])))))
      .toEqual(["LOGIC_SETTLE_AMOUNT_NOT_NUMBER"]);
  });

  it("精算の払った人・割る人が、精算する entity を指す参照でなければ LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH", () => {
    // 払った人が参照（ref）でない
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: amount", "payer: amount", "shares: participants"])))))
      .toEqual(["LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH"]);
    // 割る人が参照の並び（list of）でない
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: amount", "payer: payer", "shares: payer"])))))
      .toEqual(["LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH"]);
  });

  it("支出の entity が宣言に無ければ LOGIC_ENTITY_NOT_FOUND、欄が足りなければ SHAPE_KEY_MISSING", () => {
    expect(codesOf(failure(checkSpec(withSettle(["expense: expence", "amount: amount", "payer: payer", "shares: participants"])))))
      .toEqual(["LOGIC_ENTITY_NOT_FOUND"]);
    expect(codesOf(failure(checkSpec(withSettle(["expense: expense", "amount: amount", "payer: payer"])))))
      .toEqual(["SHAPE_KEY_MISSING"]);
  });

  it("同じ entity に精算を 2 つ書けば断る（2 つ目を黙って捨てない）", () => {
    const twice = declaration({
      entities: entities(),
      validations: "[]",
      computed: entitiess(settleBlock(SETTLE), settleBlock(SETTLE).replace("name: settlement", "name: settlement2")),
    });
    expect(codesOf(failure(checkSpec(twice)))).toEqual(["LOGIC_COMPUTED_DUPLICATE_NAME"]);
  });
});

// ── 5. 不正な YAML ─────────────────────────────────────────────

describe("不正な YAML は断る（例外を外へ出さない）", () => {
  it.each([
    ["空の原文", ""],
    ["コメントだけ", "# 宣言が無い"],
    ["インデントがタブ", "entities:\n\t- name: expense"],
    ["並びが閉じていない", "entities: [expense"],
    ["引用符が閉じていない", 'minIdentity:\n  mode: "anonymous'],
    ["欄の形ではない行", "entities\n  - name: expense"],
    ["インデントが揃っていない", "entities:\n  - name: expense\n      fields: {}"],
    ["写像を 1 行で書いている", "minIdentity: { mode: anonymous }"],
    ["アンカーを使っている", "minIdentity: &mode\n  mode: anonymous"],
    ["ブロックの値を書いている", "minIdentity: |\n  mode: anonymous"],
    ["タグを書いている", "minIdentity: !!map"],
    ["`...` の行がある", "entities: []\n..."],
    ["宣言が 2 つ（`---` が 2 回）", "---\nentities: []\n---\nviews: []"],
  ] as const)("%s を断り、例外を投げない", (_label, text) => {
    const result = failure(checkSpec(text));
    expect(codesOf(result)).toEqual(["SHAPE_YAML_INVALID"]);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toBe("");
      expect(diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(diagnostic.column).toBeGreaterThanOrEqual(1);
    }
  });

  it("制御文字のような、読めない入力でも診断を返す", () => {
    const result = failure(checkSpec("\u0000\u0001: \u0002"));
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("先頭の `---` 1 つは読み飛ばす（YAML の始まりの印）", () => {
    expect(checkSpec(`---\n${declaration()}`).ok).toBe(true);
  });
});

// ── 6. 式の上限（宣言を通したときに診断になる） ──────────────────

describe("式の上限", () => {
  it("式の文字数は 200 ちょうどが通り、201 で診断になる", () => {
    // 長い名前の項目を使う（200 文字でもノード数と深さの上限に収まる式にする）
    const longName = `a${"b".repeat(EXPRESSION_LIMITS.maxLength - 5)}`;
    const exactly = `${longName} + 1`;
    expect(exactly).toHaveLength(EXPRESSION_LIMITS.maxLength);
    const entities = entitiess(
      "  - name: expense\n    fields:",
      `      ${longName}: number`,
      "      amount: number",
      "      participants: list",
    );
    const allowed = checkSpec(declaration({ entities, computed: computed("total", exactly) }));
    expect(allowed.diagnostics, messagesOf(allowed, "LOGIC_EXPRESSION_TOO_LONG")).toEqual([]);
    expect(allowed.ok).toBe(true);

    const over = failure(checkSpec(declaration({ computed: computed("total", `${longName}b + 1`) })));
    expect(codesOf(over)).toEqual(["LOGIC_EXPRESSION_TOO_LONG"]);
  });

  it("式の深さは 8 ちょうどが通り、9 で診断になる", () => {
    const allowed = checkSpec(declaration({ computed: computed("headcount", nested(EXPRESSION_LIMITS.maxDepth)) }));
    expect(allowed.ok, messagesOf(allowed, "LOGIC_EXPRESSION_DEPTH_EXCEEDED")).toBe(true);

    const over = failure(
      checkSpec(declaration({ computed: computed("headcount", nested(EXPRESSION_LIMITS.maxDepth + 1)) })),
    );
    expect(codesOf(over)).toEqual(["LOGIC_EXPRESSION_DEPTH_EXCEEDED"]);
    expect(messagesOf(over, "LOGIC_EXPRESSION_DEPTH_EXCEEDED")).toContain("上限");
  });

  it("式のノード数は 64 ちょうどが通り、65 で診断になる", () => {
    const allowed = checkSpec(declaration({ computed: computed("headcount", `-(${balanced(32)})`) }));
    expect(allowed.ok, messagesOf(allowed, "LOGIC_EXPRESSION_NODES_EXCEEDED")).toBe(true);

    const over = failure(checkSpec(declaration({ computed: computed("headcount", `1 + (${balanced(32)})`) })));
    expect(codesOf(over)).toEqual(["LOGIC_EXPRESSION_NODES_EXCEEDED"]);
  });

  it("上限の診断も、式の位置を持つ", () => {
    const text = declaration({ computed: computed("headcount", nested(EXPRESSION_LIMITS.maxDepth + 1)) });
    const result = failure(checkSpec(text));
    const diagnostic = result.diagnostics.find((entry) => entry.code === "LOGIC_EXPRESSION_DEPTH_EXCEEDED");
    expect(diagnostic).toMatchObject(locate(text, "min(min("));
  });
});

// ── 7. 式を実行しない・ストレージに触れない ──────────────────────

describe("検査は式を実行しない・ストレージに触れない", () => {
  it("eval / Function / fetch を禁じた状態でも、見本と負例を検査できる", () => {
    // 実行していれば、ここで仕込んだ入り口を必ず踏む（踏まないことを実測する）。
    // `eval` は識別子そのものが lint（eslint/no-eval）で禁じられているので、名前を文字列で扱う
    const globalScope = globalThis as unknown as Record<string, unknown>;
    const texts = [sampleText, ...negativeTexts.values()];
    const originalEval = globalScope["eval"];
    const originalFunction = globalScope["Function"];
    const originalFetch = globalScope["fetch"];
    let touched = 0;
    const counted = (what: string) => () => {
      touched += 1;
      throw new Error(`${what} を呼んだ`);
    };
    let results: CheckResult[] = [];
    try {
      globalScope["eval"] = counted("eval");
      globalScope["Function"] = counted("Function");
      globalScope["fetch"] = counted("fetch");
      results = texts.map((text) => checkSpec(text));
    } finally {
      globalScope["eval"] = originalEval;
      globalScope["Function"] = originalFunction;
      globalScope["fetch"] = originalFetch;
    }

    expect(touched).toBe(0);
    expect(results).toHaveLength(1 + negativeIndex.negatives.length);
    expect(results[0]?.ok).toBe(true);
  });

  it("数になる式も、値ではなく型として読む（0 で割る式は診断にならない）", () => {
    // 実行すれば Infinity になる。静的チェックは型だけを見るので通る（値は #98 の仕事）
    const result = checkSpec(declaration({ computed: computed("ratio", "amount / 0") }));
    expect(result.ok, messagesOf(result, "LOGIC_OPERAND_TYPE_MISMATCH")).toBe(true);
  });

  it("ライブラリのソースは、式の実行とストレージの入口を持たない", () => {
    const libraryFiles = ["check.ts", "diagnostics.ts", "expression.ts", "limits.ts", "index.ts"];
    const forbidden = [
      "eval(",
      "new Function",
      "@musunest/app-do",
      "cloudflare:workers",
      "wrangler",
      "node:fs",
      "node:sqlite",
      "fetch(",
      "writeFile",
    ];
    for (const file of libraryFiles) {
      const source = read(new URL(`./${file}`, import.meta.url));
      for (const token of forbidden) {
        expect(source.includes(token), `${file} に ${token} がある`).toBe(false);
      }
    }
  });

  it("CLI は原本を読むだけで、書き込みも式の実行もしない", () => {
    const source = read(new URL("./cli.ts", import.meta.url));
    // 原本を読むのは CLI の仕事である（検査の中身ではない）
    expect(source).toContain('from "node:fs"');
    expect(source).toContain("readFileSync");
    for (const token of ["eval(", "new Function", "@musunest/app-do", "cloudflare:workers", "fetch(", "writeFileSync"]) {
      expect(source.includes(token), `cli.ts に ${token} がある`).toBe(false);
    }
  });
});

// ── 8. 診断の一覧（工場が読む誤りコード） ────────────────────────

describe("診断の一覧", () => {
  it("コードは重複せず、既存の誤りコードの形に合っている", () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
    for (const code of DIAGNOSTIC_CODES) {
      expect(code, code).toMatch(ERROR_CODE_PATTERN);
      expect(isWellFormedDiagnosticCode(code), code).toBe(true);
      expect(isDiagnosticCode(code), code).toBe(true);
    }
  });

  it("負例の一覧が期待するコードは、すべてこの一覧にある", () => {
    for (const negative of negativeIndex.negatives) {
      for (const code of negative.codes) expect(isDiagnosticCode(code), code).toBe(true);
    }
  });

  it("検査が返す診断は、すべてこの一覧にある", () => {
    const cases = [
      declaration(),
      sampleText,
      ...negativeTexts.values(),
      "",
      "\u0000\u0001: \u0002",
    ];
    const seen = new Set<Diagnostic["code"]>();
    for (const text of cases) {
      for (const diagnostic of checkSpec(text).diagnostics) {
        expect(isDiagnosticCode(diagnostic.code), diagnostic.code).toBe(true);
        seen.add(diagnostic.code);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

// ── アプリ全体の集計（`scope: app`）と平均（`avg`）（M1.4。Issue #177） ──
//
// **アプリ全体の計算は `entity` を持たない**（どのレコードにも属さない）。参照できるのは
// ほかのアプリ全体の計算だけで、集計の `where` に `this` は書けない。負例 2 本
// （aggregate-app-scope-uses-this・avg-target-not-number）が、同じことを外から確かめる。

/** アプリ全体の計算 1 つ（`scope: app`）。`body` は aggregate の中身か expression の行 */
const appComputed = (name: string, body: readonly string[], type = "number"): string =>
  [`  - name: ${name}`, "    scope: app", ...body.map((line) => `    ${line}`), `    type: ${type}`].join("\n");

const APP_COUNT = appComputed("activityCount", ["aggregate:", "  count: expense"]);
const APP_AVG = appComputed("averageAmount", ["aggregate:", "  avg: expense.amount"]);
const APP_SUM = appComputed("totalAmount", ["aggregate:", "  sum: expense.amount"]);

describe("アプリ全体の集計（scope: app）と平均（avg）（M1.4）", () => {
  it("見本 dashboard は静的チェックに通り、scope: app と avg を宣言のまま写す", () => {
    const result = checkSpec(read(sampleSpecFile("dashboard")));
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("dashboard が静的チェックに通らない");
    // **アプリ全体の計算は entity を持たない**（写しても足さない）
    expect(result.spec.computed).toContainEqual({
      name: "activityCount",
      scope: "app",
      aggregate: {
        kind: "count",
        entity: "activity",
        name: null,
        where: { date: { op: "within", period: "this_month" } },
      },
      type: "number",
    });
    expect(result.spec.computed).toContainEqual({
      name: "averageCost",
      scope: "app",
      aggregate: {
        kind: "avg",
        entity: "activity",
        name: "cost",
        where: { date: { op: "within", period: "this_month" } },
      },
      type: "number",
    });
    // 行ごとの計算（attendeeCount）は従来どおり entity を持つ
    expect(result.spec.computed).toContainEqual({
      name: "attendeeCount",
      entity: "activity",
      expression: "len(attendees)",
      type: "number",
    });
  });

  it("count・sum・avg を、アプリ全体の集計として読める", () => {
    const result = checkSpec(declaration({ computed: [APP_COUNT, APP_SUM, APP_AVG].join("\n") }));
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("アプリ全体の集計が通らない");
    expect(result.spec.computed.map((entry) => entry.name)).toEqual([
      "activityCount",
      "totalAmount",
      "averageAmount",
    ]);
  });

  it("アプリ全体の式は、ほかのアプリ全体の計算を参照できる", () => {
    const result = checkSpec(
      declaration({
        computed: [APP_SUM, appComputed("doubled", ["expression: totalAmount * 2"])].join("\n"),
      }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("アプリ全体の集計の where に this を書けば LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH（負例と同じ形）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [appComputed("paid", ["aggregate:", "  sum: expense.amount", "  where:", "    payer: this"])].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"]);
    expect(messagesOf(result, "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH")).toContain("this");
  });

  it("avg の対象が数でなければ LOGIC_AGGREGATE_TARGET_NOT_NUMBER（負例と同じ形）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [appComputed("averagePayer", ["aggregate:", "  avg: expense.payer"])].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_TARGET_NOT_NUMBER"]);
    // 2 本の負例は、それぞれ別の誤りコードで落ちる（1 つの誤りを 2 つに数えない）
    const usesThis = failure(
      checkSpec(
        declaration({
          computed: [appComputed("paid", ["aggregate:", "  sum: expense.amount", "  where:", "    payer: this"])].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).not.toEqual(codesOf(usesThis));
  });

  it("scope: app に entity を書けば SHAPE_KEY_UNKNOWN（どのレコードにも属さない）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [
            ["  - name: activityCount", "    scope: app", "    entity: expense", "    aggregate:", "      count: expense", "    type: number"].join("\n"),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });

  it("scope に app 以外を書けば SHAPE_VALUE_INVALID（語彙は閉じている）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [
            [
              "  - name: activityCount",
              "    scope: user",
              "    entity: expense",
              "    aggregate:",
              "      count: expense",
              "    type: number",
            ].join("\n"),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["SHAPE_VALUE_INVALID"]);
  });

  it("アプリ全体の計算に settle を書けば SHAPE_KEY_UNKNOWN（精算する entity が要る）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [
            [
              "  - name: settlement",
              "    scope: app",
              "    settle:",
              "      expense: expense",
              "      amount: amount",
              "      payer: payer",
              "      shares: participants",
            ].join("\n"),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });

  it("アプリ全体の式が entity の項目を参照すれば LOGIC_REFERENCE_NOT_FOUND", () => {
    const result = failure(
      checkSpec(declaration({ computed: [appComputed("bad", ["expression: amount + 1"])].join("\n") })),
    );
    expect(codesOf(result)).toEqual(["LOGIC_REFERENCE_NOT_FOUND"]);
  });

  it("アプリ全体の値は数である（真偽の計算は書けない）", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [appComputed("flag", ["aggregate:", "  count: expense"], "boolean")].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });

  it("アプリ全体の計算でも、参照の循環は断る", () => {
    const result = failure(
      checkSpec(
        declaration({
          computed: [
            appComputed("first", ["expression: second + 1"]),
            appComputed("second", ["expression: first + 1"]),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
  });
});

// ── 見出しごとの集計（`groupBy`）と並びを返す型（`groups`）（M1.4。Issue #179） ──
//
// **分けられるのは `enum`（値ごと）と `date`（月ごと）だけ**である。`type: groups` の計算は
// `groupBy` を持つ集計を要り、`entity` も `scope` も持たない（どのレコードにも属さない）。
// 負例 2 本（groupby-field-not-groupable・groups-in-show）が、同じことを外から確かめる。

const GROUP_ENTITIES = [
  "  - name: expense",
  "    fields:",
  "      paidOn: date",
  "      amount: number",
  "      kind:",
  "        type: enum",
  "        options:",
  "          food: 食事",
  "          travel: 移動",
].join("\n");

/** 見出しごとの集計 1 つ（`type: groups`）。`body` は aggregate の中身（この関数が 4 文字下げる） */
const groupComputed = (name: string, body: readonly string[]): string =>
  [`  - name: ${name}`, ...body.map((line) => `    ${line}`), "    type: groups"].join("\n");

const BY_KIND = groupComputed("byKind", ["aggregate:", "  count: expense", "  groupBy: expense.kind"]);
const BY_MONTH = groupComputed("byMonth", [
  "aggregate:",
  "  count: expense",
  "  groupBy:",
  "    month: expense.paidOn",
  "  last: 6",
]);

describe("見出しごとの集計（groupBy）と並びを返す型（groups）（M1.4。Issue #179）", () => {
  it("enum・月の groupBy と last を、宣言のまま写す", () => {
    const result = checkSpec(
      declaration({ entities: GROUP_ENTITIES, computed: [BY_KIND, BY_MONTH].join("\n") }),
    );
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("見出しごとの集計が通らない");
    // `type: groups` の計算は **entity も scope も持たない**（写しても足さない）
    expect(result.spec.computed).toContainEqual({
      name: "byKind",
      aggregate: { kind: "count", entity: "expense", name: null, where: {}, groupBy: { field: "kind", month: false } },
      type: "groups",
    });
    expect(result.spec.computed).toContainEqual({
      name: "byMonth",
      aggregate: {
        kind: "count",
        entity: "expense",
        name: null,
        where: {},
        groupBy: { field: "paidOn", month: true },
        last: 6,
      },
      type: "groups",
    });
  });

  it("type: groups に groupBy が無ければ LOGIC_COMPUTED_TYPE_MISMATCH", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [groupComputed("bad", ["aggregate:", "  count: expense"])].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });

  it("groupBy を type: number の集計に書けば LOGIC_COMPUTED_TYPE_MISMATCH（type: groups だけが持つ）", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [
            ["  - name: bad", "    entity: expense", "    aggregate:", "      count: expense", "      groupBy: expense.kind", "    type: number"].join("\n"),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_COMPUTED_TYPE_MISMATCH"]);
  });

  it("分けられない項目（数）を groupBy に書けば LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE（負例と同じ形）", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [groupComputed("bad", ["aggregate:", "  count: expense", "  groupBy: expense.amount"])].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE"]);
    // 月の形でも、日付でない項目は同じコードで断る
    const month = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [
            groupComputed("bad", ["aggregate:", "  count: expense", "  groupBy:", "    month: expense.amount"]),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(month)).toEqual(["LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE"]);
  });

  it("last を enum の groupBy に書けば LOGIC_AGGREGATE_FORM_INVALID（月で分けるときだけ）", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [
            groupComputed("bad", ["aggregate:", "  count: expense", "  groupBy: expense.kind", "  last: 6"]),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["LOGIC_AGGREGATE_FORM_INVALID"]);
  });

  it("見出しごとの集計を一覧の show に書けば UI_FIELD_NOT_FOUND（負例と同じ形）", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          views: [
            "  - name: expenseList",
            "    type: table",
            "    entity: expense",
            "    show: [amount, byKind]",
          ].join("\n"),
          computed: [BY_KIND].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["UI_FIELD_NOT_FOUND"]);
  });

  it("type: groups に entity を書けば SHAPE_KEY_UNKNOWN（どのレコードにも属さない）", () => {
    const result = failure(
      checkSpec(
        declaration({
          entities: GROUP_ENTITIES,
          computed: [
            ["  - name: bad", "    entity: expense", "    aggregate:", "      count: expense", "      groupBy: expense.kind", "    type: groups"].join("\n"),
          ].join("\n"),
        }),
      ),
    );
    expect(codesOf(result)).toEqual(["SHAPE_KEY_UNKNOWN"]);
  });

  it("見本 dashboard の見出しごとの集計を、宣言のまま写す（語彙と見本が一致している）", () => {
    const result = checkSpec(read(sampleSpecFile("dashboard")));
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("dashboard が静的チェックに通らない");
    expect(result.spec.computed).toContainEqual({
      name: "activitiesByMonth",
      aggregate: {
        kind: "count",
        entity: "activity",
        name: null,
        where: {},
        groupBy: { field: "date", month: true },
        last: 6,
      },
      type: "groups",
    });
    expect(result.spec.computed).toContainEqual({
      name: "activitiesByKind",
      aggregate: {
        kind: "count",
        entity: "activity",
        name: null,
        where: {},
        groupBy: { field: "kind", month: false },
      },
      type: "groups",
    });
  });
});
