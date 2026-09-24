// 宣言の構造の正本（JSON Schema）を、見本と形の負例に当てる unit テスト（Issue #211）。
//
// 文法の正本は packages/appspec-schema/contract/ に置く（構造は JSON Schema、式は EBNF、規則は表。
// workspace/mvp/m1/06-grammar-and-authoring-trial.md §2.1）。この file が見るのは**構造**である——
// 式の文法と上限、型の組み合わせ、名前解決は、別の正本が受け持つ。
//
//   1. 見本 4 つを読んだ結果が、すべて schema に通る
//   2. 形の負例（SHAPE_* で落ちる負例）が、schema でも落ちる
//   3. 語彙は閉じている（知らない欄を受けない）
//
// **読む側を 2 つ持たない。** YAML を読むのは静的チェック（check.ts）の読み取りであり、ここはその結果
// （readSpecDocument）に schema を当てるだけである。schema を読むテストを spec-engine に置くのは
// 依存の向きによる（appspec-schema は依存先を持たない。Issue #211 の注記）。
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { readNegativeIndex, type NegativeSample } from "@musunest/appspec-schema";
import {
  appSpecSchemaFile,
  NEGATIVES_DIR_NAME,
  negativeIndexFile,
  negativeSpecFile,
  sampleSpecFile,
  samplesDir,
} from "@musunest/appspec-schema/files";
import { readSpecDocument } from "./check.js";

// tsconfig の types は workers-types と node の両方を読み、**グローバルの URL の型が食い違う**
// （workers-types の URL を node:fs に渡せない）。このファイルは Node（vitest）で動くので、
// 使う関数の形だけをここで宣言する（check.test.ts と同じやり方）。
interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
}
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): DirEntry[];
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const read = (url: URL): string => fs.readFileSync(url, "utf8");

/** 構造の正本（JSON Schema）。読み込めても compile が通らなければ、ここで落ちる */
const validate: ValidateFunction = new Ajv({ allErrors: true }).compile(
  JSON.parse(read(appSpecSchemaFile())) as AnySchema,
);

/**
 * この schema が**構造として見られない**形の誤り。理由を添えてここに明示する。
 * **ここに無い誤りコードは、schema でも落ちることをこの file が要求する**——黙って飛ばさない。
 *
 *   `SHAPE_YAML_INVALID`  … YAML として読めない入力。**読んだデータが無い**ので、schema に当てる対象が無い
 *                           （読めない入力を断るのは読み取りの規則であり、文法の契約の別の部分である。06 §2.1）
 *   `SHAPE_KEY_DUPLICATE` … 同じキーの重複。読み取りは写像を名前つきのオブジェクトにするので、
 *                           **2 回目は 1 回目を上書きし、重複は JSON のデータに残らない**
 */
const STRUCTURALLY_UNSEEN: readonly string[] = ["SHAPE_YAML_INVALID", "SHAPE_KEY_DUPLICATE"];

/** samples/ の下の見本（負例のディレクトリは数えない） */
const sampleNames = fs
  .readdirSync(samplesDir(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== NEGATIVES_DIR_NAME)
  .map((entry) => entry.name);

const negativeIndex = readNegativeIndex(JSON.parse(read(negativeIndexFile())));

const shapeCodesOf = (negative: NegativeSample): readonly string[] =>
  negative.codes.filter((code) => code.startsWith("SHAPE_"));

/** 形（`SHAPE_*`）の誤りで落ちる負例。このうち、schema が見られるものを下で要求する */
const shapeNegatives = negativeIndex.negatives.filter((negative) => shapeCodesOf(negative).length > 0);
/** schema に見られないと明示した誤り**だけ**で落ちる負例。それ以外は 1 つも飛ばさない */
const unseenNegatives = shapeNegatives.filter((negative) =>
  shapeCodesOf(negative).every((code) => STRUCTURALLY_UNSEEN.includes(code)),
);
const observableNegatives = shapeNegatives.filter((negative) => !unseenNegatives.includes(negative));

/** 宣言の原文を読んで、JSON の値にする */
const documentOf = (source: string): unknown => {
  const result = readSpecDocument(source);
  if (!result.ok) throw new Error(`YAML を読めなかった: ${result.failure.message}`);
  return result.document;
};

/** 直前に validate が落ちた理由（落ちていないときは空文字） */
const errorsOf = (): string =>
  (validate.errors ?? [])
    .map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? ""}`)
    .join(" / ");

describe("宣言の構造（JSON Schema。文法の正本 ①）", () => {
  it("見本は 4 つある（1 つだけなら、構造の正本を 1 つの見本でしか測っていない）", () => {
    expect(sampleNames.length).toBeGreaterThanOrEqual(4);
  });

  it.each(sampleNames)("見本 %s を読んだ結果は schema に通る", (name) => {
    const document = documentOf(read(sampleSpecFile(name)));
    const ok = validate(document);
    expect(ok, errorsOf()).toBe(true);
  });

  it("形の負例（SHAPE_*）が 1 つ以上ある（無ければ、この測りは空振りする）", () => {
    expect(shapeNegatives.length).toBeGreaterThanOrEqual(1);
  });

  it.each(observableNegatives.map((negative) => negative.name))(
    "形の負例 %s は schema でも落ちる",
    (name) => {
      const document = documentOf(read(negativeSpecFile(name)));
      expect(validate(document)).toBe(false);
    },
  );

  it("飛ばす負例は、理由つきで明示した誤りだけである（黙って飛ばさない）", () => {
    const skipped = new Set(unseenNegatives.flatMap((negative) => shapeCodesOf(negative)));
    for (const code of skipped) expect(STRUCTURALLY_UNSEEN).toContain(code);
  });

  it("同じキーの重複は、読んだデータに残らない（この schema では見られない）", () => {
    // 負例 key-duplicate と同じ形（entity の中で `name` を 2 回書く）。写像 → オブジェクトのとき、
    // 2 回目が 1 回目を上書きするので、構造としては正しい宣言になる
    const duplicated = [
      "entities:",
      "  - name: expense",
      "    name: expense",
      "    fields:",
      "      amount: number",
      "views: []",
      "actions: []",
      "validations: []",
      "computed: []",
      "permissions: []",
      "minIdentity:",
      "  mode: anonymous",
      "",
    ].join("\n");
    const result = readSpecDocument(duplicated);
    expect(result.ok, "読めなかった").toBe(true);
    if (!result.ok) return;
    expect(validate(result.document)).toBe(true);
  });

  it("読めない YAML は、schema に当てるデータが無い（読み取りの規則はこの schema の外）", () => {
    // 負例 yaml-invalid と同じ形（並びが 1 行で閉じていない）。断るのは読み取りであって、構造ではない
    expect(readSpecDocument("entities: [expense\n").ok).toBe(false);
  });

  it("語彙は閉じている（宣言の直下に知らない欄を書けない）", () => {
    const document = documentOf(read(sampleSpecFile("expense-log"))) as Record<string, unknown>;
    expect(validate({ ...document, budget: [] })).toBe(false);
  });

  it("語彙は閉じている（entity の直下に知らない欄を書けない）", () => {
    const document = documentOf(read(sampleSpecFile("expense-log"))) as Record<string, unknown>;
    const entities = document["entities"] as readonly Record<string, unknown>[];
    expect(validate({ ...document, entities: [{ ...entities[0], label: "支出" }] })).toBe(false);
  });
});
