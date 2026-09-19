// 式の解析・型の検査・上限の unit テスト（Issue #97 の受入条件のうち、式に閉じる分）。
//
// ここで固定したいのは 3 つ。
//   1. 式を**実行せずに**型が決まる（`eval` / `Function` を使わない）
//   2. 決められない型（`unknown`）が**後続の診断に化けない**——1 つの誤りが 1 つの誤りコードになる
//   3. 上限（文字数 200・深さ 8・ノード 64）は**ちょうどは通り、1 超過で診断になる**
import { describe, expect, it } from "vitest";
import { BUILTIN_FUNCTIONS, DATE_FUNCTIONS } from "@musunest/appspec-schema";
import {
  analyzeExpression,
  countNodes,
  depthOf,
  parseExpression,
  positionAt,
  readExpression,
  type AstNode,
  type ExpressionScope,
} from "./expression.js";
import { EXPRESSION_LIMITS } from "./limits.js";

const parsed = (text: string): AstNode => {
  const result = parseExpression(text);
  if (!result.ok) throw new Error(`${text}: ${result.errors.map((e) => e.message).join(" / ")}`);
  return result.ast;
};

describe("式の解析（AST）", () => {
  it("数の定数・名前・かっこを読む", () => {
    expect(parsed("1.5")).toEqual({ kind: "number", value: 1.5, start: 0, end: 3 });
    expect(parsed("amount")).toEqual({ kind: "name", name: "amount", start: 0, end: 6 });
    expect(parsed("(amount)")).toMatchObject({ kind: "name", name: "amount" });
  });

  it("優先順位のとおりに組み立てる（`1 + 2 * 3` は足し算の右が掛け算）", () => {
    expect(parsed("1 + 2 * 3")).toMatchObject({
      kind: "binary",
      operator: "+",
      left: { kind: "number", value: 1 },
      right: { kind: "binary", operator: "*" },
    });
  });

  it("かっこで組み方が変わる（ノードは増えない）", () => {
    expect(parsed("(1 + 2) * 3")).toMatchObject({
      kind: "binary",
      operator: "*",
      left: { kind: "binary", operator: "+" },
      right: { kind: "number", value: 3 },
    });
    expect(countNodes(parsed("(1 + 2) * 3"))).toBe(countNodes(parsed("1 + 2 * 3")));
  });

  it("符号の - を読む", () => {
    expect(parsed("-amount")).toMatchObject({ kind: "unary", operator: "-", operand: { kind: "name" } });
    expect(parsed("- -1")).toMatchObject({ kind: "unary", operand: { kind: "unary" } });
  });

  it("店頭が用意した関数を読む（見本の式が読める）", () => {
    expect(parsed("amount - min(discount, amount)")).toMatchObject({ kind: "binary", operator: "-" });
    expect(parsed("len(participants)")).toMatchObject({ kind: "call", name: "len" });
    expect(parsed("paidAmount / max(1, headcount)")).toMatchObject({
      kind: "binary",
      operator: "/",
      right: { kind: "call", name: "max", args: [{ kind: "number" }, { kind: "name" }] },
    });
  });

  it("`.` を使った参照も読み取れる（読んで断るのは型の検査）", () => {
    expect(parsed("budget.limit")).toEqual({
      kind: "member",
      entity: "budget",
      name: "limit",
      start: 0,
      end: 12,
    });
  });

  it.each([
    ["式が空", ""],
    ["数の後で終わっている", "1 +"],
    ["かっこが閉じていない", "(1 + 2"],
    ["関数の引数が途中", "min(1,"],
    ["引数の区切りが違う", "min(1 2)"],
    ["`.` の後ろが名前でない", "budget.1"],
    ["比較の連鎖", "1 < 2 < 3"],
    ["文字列の定数が閉じていない", '"done'],
    ["文字列のエスケープ（M1.3 は書けない）", '"a\\"b"'],
    ["式に書けない文字（and）", "a && b"],
    ["式に書けない文字（指数）", "1e3"],
    ["数の後に余分がある", "1 2"],
  ])("%s は読めない", (_label, text) => {
    const result = parseExpression(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).not.toBe("");
    expect(result.errors[0]?.offset).toBeGreaterThanOrEqual(0);
  });

  it("読めない位置は、式の中の実際の位置を指す", () => {
    const result = parseExpression("1 + 2 # 3");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.offset).toBe(6);
  });

  it("AST のノード数と深さを数える（葉を 1 とする）", () => {
    expect(countNodes(parsed("amount"))).toBe(1);
    expect(depthOf(parsed("amount"))).toBe(1);
    expect(countNodes(parsed("1 + 2"))).toBe(3);
    expect(depthOf(parsed("1 + 2"))).toBe(2);
    expect(depthOf(parsed("min(1, 2)"))).toBe(2);
    expect(depthOf(parsed("min(max(1, 2), 2)"))).toBe(3);
  });

  it("式を実行しない（0 で割る式も、値ではなく型として読む）", () => {
    // 実行すれば Infinity になる。ここが返すのは型だけである
    const result = readExpression("1 / 0");
    expect(result.ok).toBe(true);
    expect(analyzeExpression(parsed("1 / 0"), noNames).type).toBe("number");
  });
});

/** 葉が `leaves` 枚の釣り合った木。深さは log2(leaves) + 1、ノードは 2 * leaves - 1 */
const balanced = (leaves: number): string =>
  leaves === 1 ? "1" : `(${balanced(leaves / 2)}+${balanced(leaves / 2)})`;

/** `depth` 段の入れ子の関数呼び出し。外側の呼び出しを 1 段と数える */
const nested = (depth: number): string => {
  let text = "1";
  for (let index = 1; index < depth; index += 1) text = `min(${text}, 1)`;
  return text;
};

describe("式の上限（文字数 200・深さ 8・ノード 64）", () => {
  it("文字数は 200 ちょうどが通り、201 で診断になる", () => {
    const exactly = `1 + 1${" ".repeat(EXPRESSION_LIMITS.maxLength - 5)}`;
    expect(exactly.length).toBe(EXPRESSION_LIMITS.maxLength);
    expect(readExpression(exactly).ok).toBe(true);

    const over = `${exactly} `;
    const result = readExpression(over);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toEqual(["LOGIC_EXPRESSION_TOO_LONG"]);
    expect(result.problems[0]?.message).toContain("200");
  });

  it("深さは 8 ちょうどが通り、9 で診断になる", () => {
    const allowed = nested(EXPRESSION_LIMITS.maxDepth);
    expect(depthOf(parsed(allowed))).toBe(EXPRESSION_LIMITS.maxDepth);
    expect(readExpression(allowed).ok).toBe(true);

    const over = nested(EXPRESSION_LIMITS.maxDepth + 1);
    expect(depthOf(parsed(over))).toBe(EXPRESSION_LIMITS.maxDepth + 1);
    const result = readExpression(over);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toEqual(["LOGIC_EXPRESSION_DEPTH_EXCEEDED"]);
    expect(result.problems[0]?.message).toContain("8");
  });

  it("ノード数は 64 ちょうどが通り、65 で診断になる", () => {
    const tree = balanced(32);
    const exactly = `-(${tree})`;
    expect(countNodes(parsed(exactly))).toBe(EXPRESSION_LIMITS.maxNodes);
    expect(depthOf(parsed(exactly))).toBeLessThanOrEqual(EXPRESSION_LIMITS.maxDepth);
    expect(readExpression(exactly).ok).toBe(true);

    const over = `1 + (${tree})`;
    expect(countNodes(parsed(over))).toBe(EXPRESSION_LIMITS.maxNodes + 1);
    const result = readExpression(over);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toEqual(["LOGIC_EXPRESSION_NODES_EXCEEDED"]);
    expect(result.problems[0]?.message).toContain("64");
  });

  it("上限の外の式は、解析も型の検査もしない（長さで打ち切る）", () => {
    const over = `1 + ${"(".repeat(EXPRESSION_LIMITS.maxLength)}`; // 読めない式だが、長さで先に止まる
    const result = readExpression(over);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.code)).toEqual(["LOGIC_EXPRESSION_TOO_LONG"]);
  });
});

// ── 型の検査（宣言の名前解決を差し替えて、式だけを見る） ──────────────

const noNames: ExpressionScope = { resolveName: () => null, entityName: () => null };

/** 型の検査に渡す、名前 → 型（`date` は M1.3 で入った。#155） */
type FieldTypes = Readonly<Record<string, "number" | "string" | "list" | "date">>;

/** 見本の expense に近い名前の環境。`ammount` のような綴りの間違いは解決しない */
const expense = (fields: FieldTypes): ExpressionScope => ({
  resolveName: (name) => Object.hasOwn(fields, name) ? (fields[name] ?? null) : null,
  entityName: (name) => (name === "budget" ? "budget" : null),
});

const analyze = (
  text: string,
  fields: FieldTypes = {},
): { type: string; codes: readonly string[] } => {
  const status = readExpression(text);
  if (!status.ok) throw new Error(`${text}: ${status.problems.map((p) => p.message).join(" / ")}`);
  const analysis = analyzeExpression(status.ast, expense(fields));
  return { type: analysis.type, codes: analysis.problems.map((p) => p.code) };
};

describe("式の型（実行しない）", () => {
  const fields = {
    amount: "number",
    discount: "number",
    payer: "string",
    participants: "list",
  } as const;

  it("見本の式は、型も参照も問題ない", () => {
    expect(analyze("amount - min(discount, amount)", fields)).toEqual({ type: "number", codes: [] });
    expect(analyze("len(participants)", fields)).toEqual({ type: "number", codes: [] });
    expect(analyze("amount / max(1, amount)", fields)).toEqual({ type: "number", codes: [] });
    expect(analyze("amount > 0", fields)).toEqual({ type: "boolean", codes: [] });
    expect(analyze("discount >= 0", fields)).toEqual({ type: "boolean", codes: [] });
  });

  it("文字列を計算に使うと、演算の型が食い違う（結果の型は決められない）", () => {
    expect(analyze("payer * 2", fields)).toEqual({ type: "unknown", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] });
  });

  it("並びを数と比べると、演算の型が食い違う", () => {
    expect(analyze("participants > 0", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
  });

  it("店頭が用意していない関数は断る", () => {
    expect(analyze("round(amount)", fields)).toEqual({ type: "unknown", codes: ["LOGIC_FUNCTION_NOT_ALLOWED"] });
  });

  it("引数の数が違えば断り、引数の型は見ない（1 つの誤りを 2 つにしない）", () => {
    expect(analyze("min(amount)", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_FUNCTION_ARITY_MISMATCH"],
    });
  });

  it("引数の型が違えば断る", () => {
    expect(analyze("len(amount)", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH"],
    });
    expect(analyze("max(participants, 1)", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH"],
    });
  });

  it("定義に無い名前は断る（綴りの間違い）", () => {
    expect(analyze("ammount > 0", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_REFERENCE_NOT_FOUND"],
    });
  });

  it("別の entity をドットで参照すると断る", () => {
    expect(analyze("amount - budget.limit", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_REFERENCE_OUT_OF_ENTITY"],
    });
  });

  it("決められない型は、後続の診断に化けない（1 つの誤りは 1 つのコードになる）", () => {
    // 綴りの間違いだけを返す。「真偽でない」を重ねて出さない
    expect(analyze("ammount > 0", fields)).toEqual({ type: "unknown", codes: ["LOGIC_REFERENCE_NOT_FOUND"] });
    // 用意されていない関数だけを返す。「計算の type と食い違う」を重ねて出さない
    expect(analyze("round(amount) + 1", fields)).toEqual({
      type: "unknown",
      codes: ["LOGIC_FUNCTION_NOT_ALLOWED"],
    });
  });

  it("参照した名前を返す（計算どうしの循環を組み立てるのに使う）", () => {
    const status = readExpression("second + first * 2");
    if (!status.ok) throw new Error("解析できない");
    const analysis = analyzeExpression(status.ast, expense({}));
    expect(analysis.names).toEqual(["second", "first"]);
  });

  it("店頭が用意した関数の定義は、appspec-schema が正本である", () => {
    expect(Object.keys(BUILTIN_FUNCTIONS)).toEqual(["min", "max", "len"]);
    // 日付の関数（M1.3）は別の表である。**M1.1 の関数の一覧に混ぜない**（混ぜると、その一覧を
    // 読む側の意味が変わる。appspec-schema の DATE_FUNCTIONS の注記）
    expect(Object.keys(DATE_FUNCTIONS)).toEqual(["today"]);
  });
});

// ── 日付（date）と「今日」（today()）（M1.3。#155） ──────────────────
//
// 比べられるのは**数どうし**（従来）と**日付どうし**だけである。日付と数を混ぜると
// `LOGIC_OPERAND_TYPE_MISMATCH`、`today()` に引数を渡すと `LOGIC_FUNCTION_ARITY_MISMATCH` になる
// （**別の誤りコードである**。受入条件）。

describe("日付と「今日」の型（M1.3）", () => {
  const due: FieldTypes = {
    amount: "number",
    discount: "number",
    payer: "string",
    participants: "list",
    due: "date",
  };

  it.each(["<", "<=", ">", ">=", "==", "!="] as const)(
    "日付どうしは %s で比べられ、結果は真偽になる（受入条件）",
    (operator) => {
      expect(analyze(`due ${operator} today()`, due)).toEqual({ type: "boolean", codes: [] });
      expect(analyze(`due ${operator} due`, due)).toEqual({ type: "boolean", codes: [] });
    },
  );

  it("日付と数の比較は、演算の型が食い違う（受入条件）", () => {
    expect(analyze("due < 1", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
    expect(analyze("amount < today()", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
    expect(analyze("today() > amount", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
  });

  it("日付は数の計算に使えない", () => {
    expect(analyze("due + 1", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
    expect(analyze("-due", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
    });
  });

  it("today に引数を渡すと、引数の数が食い違う（受入条件）", () => {
    expect(analyze("today(1)", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_FUNCTION_ARITY_MISMATCH"],
    });
    expect(analyze("today()", due)).toEqual({ type: "date", codes: [] });
  });

  it("2 つの誤りコードは別である（日付と数の比較・today の引数。受入条件）", () => {
    const compared = analyze("due < 1", due).codes;
    const called = analyze("today(1)", due).codes;
    expect(compared).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
    expect(called).toEqual(["LOGIC_FUNCTION_ARITY_MISMATCH"]);
    expect(compared).not.toEqual(called);
  });

  it("日付の名前を綴り間違えれば、参照が無いことを断る（1 つの誤りは 1 つのコード）", () => {
    expect(analyze("duo < today()", due)).toEqual({
      type: "unknown",
      codes: ["LOGIC_REFERENCE_NOT_FOUND"],
    });
  });
});

// ── 文字列の定数（M1.3。#156） ─────────────────────────────────────
//
// 小さく保つための線引き（2026-09-19 所有者）は 3 つである。
//   1. **二重引用符だけ。エスケープは無い**（`"` を含む文字列は書けない）
//   2. **使えるのは `==` と `!=` の比較だけ**（大小は比べない）
//   3. **`+` で繋げない**（文字列の演算を足すと、「決まった値を比べる」以上のことができてしまう）

describe("文字列の定数（M1.3）", () => {
  const texts: FieldTypes = {
    amount: "number",
    payer: "string",
    participants: "list",
    due: "date",
  };

  it("文字列の定数を読む（引用符を外した中身が値になる）", () => {
    expect(parsed('"done"')).toEqual({ kind: "string", value: "done", start: 0, end: 6 });
    // 中身が空の文字列も書ける（葉として 1 ノードである）
    expect(parsed('""')).toMatchObject({ kind: "string", value: "" });
    expect(countNodes(parsed('"done"'))).toBe(1);
    expect(depthOf(parsed('"done"'))).toBe(1);
  });

  it.each(["==", "!="] as const)("文字列は %s で比べられ、結果は真偽になる（受入条件）", (operator) => {
    expect(analyze(`payer ${operator} "A"`, texts)).toEqual({ type: "boolean", codes: [] });
    expect(analyze(`"A" ${operator} payer`, texts)).toEqual({ type: "boolean", codes: [] });
    expect(analyze(`"A" ${operator} "B"`, texts)).toEqual({ type: "boolean", codes: [] });
  });

  it.each(["<", "<=", ">", ">="] as const)(
    "文字列の大小（%s）は書けない（== と != だけ。受入条件）",
    (operator) => {
      expect(analyze(`payer ${operator} "A"`, texts)).toEqual({
        type: "unknown",
        codes: ["LOGIC_OPERAND_TYPE_MISMATCH"],
      });
    },
  );

  it("エスケープは書けない（`\\\"` を含む式は読めない。受入条件）", () => {
    // 二重引用符だけで、`\` は文字として扱う。`"` を含む文字列は書けない
    for (const text of ['"a\\"b"', '"done', 'payer == "A']) {
      const result = parseExpression(text);
      expect(result.ok, text).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.message, text).not.toBe("");
    }
    // 読めない式は LOGIC_EXPRESSION_INVALID になる（診断の経路も確かめる）
    const read = readExpression('payer == "A');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((problem) => problem.code)).toEqual(["LOGIC_EXPRESSION_INVALID"]);
  });

  it("`+` で繋げない（文字列は計算に使えない。受入条件）", () => {
    // 左右の両方が数でなければ、両方が食い違いとして返る（既存の binary の扱いと同じ）
    expect(analyze('payer + "A"', texts)).toEqual({
      type: "unknown",
      codes: ["LOGIC_OPERAND_TYPE_MISMATCH", "LOGIC_OPERAND_TYPE_MISMATCH"],
    });
    expect(analyze('"A" + "B"', texts).type).toBe("unknown");
    expect(new Set(analyze('"A" + "B"', texts).codes)).toEqual(new Set(["LOGIC_OPERAND_TYPE_MISMATCH"]));
    // 引き算・掛け算・符号も同じである
    expect(analyze('"A" * 2', texts).codes).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
    expect(analyze('-"A"', texts).codes).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
  });

  it("文字列と、数・日付・並びは比べられない（型が食い違う）", () => {
    expect(analyze('amount == "A"', texts).codes).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
    expect(analyze('due == "2026-09-15"', texts).codes).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
    expect(analyze('participants == "A"', texts).codes).toEqual(["LOGIC_OPERAND_TYPE_MISMATCH"]);
  });

  it("文字列の定数は `len` にも渡せない（引数の型が食い違う）", () => {
    expect(analyze('len("done")', texts).codes).toEqual(["LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH"]);
  });
});

describe("式の中の位置を原文へ写す", () => {
  it("1 行の中は文字単位で正しい", () => {
    expect(positionAt("amount > 0", 0, { line: 24, column: 17 })).toEqual({ line: 24, column: 17 });
    expect(positionAt("amount > 0", 5, { line: 24, column: 17 })).toEqual({ line: 24, column: 22 });
  });

  it("改行を含む式は、行と列を進める", () => {
    expect(positionAt("a +\nb", 4, { line: 3, column: 10 })).toEqual({ line: 4, column: 1 });
  });

  it("式の外の位置は、式の端に丸める", () => {
    expect(positionAt("ab", 99, { line: 1, column: 1 })).toEqual({ line: 1, column: 3 });
    expect(positionAt("ab", -5, { line: 1, column: 1 })).toEqual({ line: 1, column: 1 });
  });
});
