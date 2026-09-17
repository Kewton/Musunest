// 静的チェックの unit テスト（Issue #97 の受入条件を、ここで固定する）。
//
//   1. 見本（expense-log・warikan）の診断が空で、7 欄を持つ AppSpec を返す
//   2. 負例 27 件で返る誤りコードの集合が、負例一覧の codes と**ちょうど一致**する
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
  readNegativeIndex,
  type AppSpecSection,
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
      ...result.spec.computed.map((entry) => entry.expression),
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
    expect(expense?.fields["payer"]).toEqual({ type: "ref", to: "member" });
    expect(expense?.fields["participants"]).toEqual({ type: "list", of: "member" });
    // 参照の項目は、式の中では ID の文字列として読む（数ではない）
    expect(result.spec.computed.map((entry) => entry.expression)).toEqual([
      "len(participants)",
      "amount / max(1, headcount)",
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

// ── 2. 負例 27 件 ──────────────────────────────────────────────

describe("負例（appspec-schema の samples/negatives）", () => {
  it("負例の一覧は 27 件である（0 件なら以降のテストが空振りする）", () => {
    expect(negativeIndex.negatives).toHaveLength(27);
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
    ["action-with-kind", "SHAPE_KEY_UNKNOWN"],
    ["view-with-type", "SHAPE_KEY_UNKNOWN"],
    ["string-in-arithmetic", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["list-in-comparison", "LOGIC_OPERAND_TYPE_MISMATCH"],
    ["min-wrong-arity", "LOGIC_FUNCTION_ARITY_MISMATCH"],
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
    ["view の要素", declaration({ views: `${BASE_PARTS.views}\n    type: table` }), "type"],
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
