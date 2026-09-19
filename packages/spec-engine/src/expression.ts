// 式の解析（YAML → AST）と、実行しない型の検査。
//
// 静的チェック（check.ts）と評価（#98）が**同じ AST**を使う。式を 1 回だけ解析し、
// 検査は型を、評価は値を求める。字面の解釈が 2 か所に分かれると、通った式が動かない（03 §5.3）。
//
// ここは**式を実行しない**。`eval` / `Function` を使わない（03 §5.3・CLAUDE.md の不変条件）。
// 上限を超えた式は解析だけして診断を返し、先へ進まない（CPU を使い切らないため）。

import {
  ARITHMETIC_OPERATORS,
  BUILTIN_FUNCTIONS,
  COMPARISON_OPERATORS,
  DATE_FUNCTIONS,
  type ExpressionType,
} from "@musunest/appspec-schema";
import type { Diagnostic, DiagnosticCode, DiagnosticPosition } from "./diagnostics.js";
import { diagnostic } from "./diagnostics.js";
import { EXPRESSION_LIMIT_CODES, EXPRESSION_LIMITS, EXPRESSION_LIMIT_NAMES } from "./limits.js";

// ── 型 ──────────────────────────────────────────────────────────

/**
 * 式に現れる値の型。`unknown` は「決められない」——定義に無い名前、用意されていない関数、
 * 引数の型違い、`.` を使った参照、上限超えである。
 *
 * `unknown` は**どの型とも食い違わない**ものとして扱い、**式に 1 つでも誤りがあれば式全体を
 * `unknown` にする**。ここで打ち切らないと、1 つの誤りが後続の型の診断に化けて、
 * 返る誤りコードが増える（例：`max(participants, 1)` の引数の型違いが、計算の `type` の
 * 不一致にも化ける）。
 */
export type SpecType = ExpressionType | "unknown";

/** 式の解析に失敗した理由 */
export interface ExpressionError {
  /** 式の文字列の中の位置（0 始まり） */
  readonly offset: number;
  readonly message: string;
}

/** 式の検査で見つけた問題。位置は式の中のオフセット、コードは診断と同じ体系 */
export interface ExpressionProblem {
  readonly offset: number;
  readonly code: DiagnosticCode;
  readonly message: string;
}

// ── AST ────────────────────────────────────────────────────────

export interface NumberLiteralNode {
  readonly kind: "number";
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

/**
 * 文字列の定数（M1.3。`"done"`）。**二重引用符だけで、エスケープは無い**
 * （`"` を含む文字列は書けない。docs/semantics.md「string」）。
 *
 * 使えるのは `==` と `!=` の比較だけである（`+` で繋げない）——文字列の演算を足すと、
 * 「決まった値を比べる」以上のことが式でできてしまう（小さく保つための線引き。2026-09-19 所有者）。
 */
export interface StringLiteralNode {
  readonly kind: "string";
  readonly start: number;
  readonly end: number;
  /** 引用符を外した中身 */
  readonly value: string;
}

/** 同じ entity の項目か計算の名前 */
export interface NameNode {
  readonly kind: "name";
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** `budget.limit` の形。M1.1 では書けない（読んで断るために持つ） */
export interface MemberNode {
  readonly kind: "member";
  readonly start: number;
  readonly end: number;
  readonly entity: string;
  readonly name: string;
}

export interface UnaryNode {
  readonly kind: "unary";
  readonly start: number;
  readonly end: number;
  readonly operator: "-";
  readonly operand: AstNode;
}

export interface BinaryNode {
  readonly kind: "binary";
  readonly start: number;
  readonly end: number;
  readonly operator: string;
  readonly left: AstNode;
  readonly right: AstNode;
}

export interface CallNode {
  readonly kind: "call";
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly args: readonly AstNode[];
}

export type AstNode =
  | NumberLiteralNode
  | StringLiteralNode
  | NameNode
  | MemberNode
  | UnaryNode
  | BinaryNode
  | CallNode;

export const isArithmeticOperator = (operator: string): boolean =>
  (ARITHMETIC_OPERATORS as readonly string[]).includes(operator);

export const isComparisonOperator = (operator: string): boolean =>
  (COMPARISON_OPERATORS as readonly string[]).includes(operator);

// ── 字句 ───────────────────────────────────────────────────────

type TokenKind = "number" | "string" | "name" | "operator" | "open" | "close" | "comma" | "dot";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const NUMBER_TEXT = /^\d+(?:\.\d+)?/;
const NAME_TEXT = /^[A-Za-z][A-Za-z0-9]*/;
const TWO_CHARACTER_OPERATORS = [">=", "<=", "==", "!="];
const ONE_CHARACTER_OPERATORS = [...ARITHMETIC_OPERATORS, ">", "<"];
const SPACES = [" ", "\t", "\n", "\r"];

/**
 * 式を字句に分ける。**どこかで読めなくなったら、その位置と理由を返して止める**
 * （読み飛ばして続けると、誤りの位置が後ろへずれる）。
 */
function tokenize(text: string): { tokens: Token[]; error: ExpressionError | null } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const character = text.slice(index, index + 1);
    if (SPACES.includes(character)) {
      index += 1;
      continue;
    }
    const two = TWO_CHARACTER_OPERATORS.find((operator) => rest.startsWith(operator));
    if (two !== undefined) {
      tokens.push({ kind: "operator", text: two, start: index, end: index + two.length });
      index += two.length;
      continue;
    }
    const one = ONE_CHARACTER_OPERATORS.find((operator) => rest.startsWith(operator));
    if (one !== undefined) {
      tokens.push({ kind: "operator", text: one, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    // 文字列の定数（M1.3）。**二重引用符だけ。エスケープは無い**ので、次の `"` までが中身である
    // （`\` は文字として扱う）。閉じていなければ、その位置で止める
    if (character === '"') {
      const closing = text.indexOf('"', index + 1);
      if (closing < 0) {
        return {
          tokens,
          error: {
            offset: index,
            message: '文字列の定数が " で閉じていない（エスケープは書けない）',
          },
        };
      }
      tokens.push({
        kind: "string",
        text: text.slice(index + 1, closing),
        start: index,
        end: closing + 1,
      });
      index = closing + 1;
      continue;
    }
    const number = NUMBER_TEXT.exec(rest);
    if (number) {
      tokens.push({ kind: "number", text: number[0], start: index, end: index + number[0].length });
      index += number[0].length;
      continue;
    }
    const name = NAME_TEXT.exec(rest);
    if (name) {
      tokens.push({ kind: "name", text: name[0], start: index, end: index + name[0].length });
      index += name[0].length;
      continue;
    }
    const punctuation: Readonly<Record<string, TokenKind>> = {
      "(": "open",
      ")": "close",
      ",": "comma",
      ".": "dot",
    };
    const kind = punctuation[character];
    if (kind !== undefined) {
      tokens.push({ kind, text: character, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    return {
      tokens,
      error: {
        offset: index,
        message: `${character} は式に書けない（数と文字列の定数・項目と計算の名前・+ - * / > >= < <= == != ・min max len today・かっこ だけを書ける）`,
      },
    };
  }
  return { tokens, error: null };
}

// ── 解析 ───────────────────────────────────────────────────────

class ParseFailure extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** 優先順位つきの再帰下降。字句は上限つきの式からしか作らないので、再帰の深さも有界である */
class Parser {
  readonly #tokens: readonly Token[];
  #position = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  parse(): AstNode {
    const node = this.#comparison();
    const rest = this.#peek();
    if (rest !== undefined) throw new ParseFailure(`${rest.text} が式の終わりに余分にある`, rest.start);
    return node;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#position];
  }

  #next(): Token | undefined {
    const token = this.#peek();
    this.#position += 1;
    return token;
  }

  #offsetForError(): number {
    const last = this.#tokens[this.#tokens.length - 1];
    return last === undefined ? 0 : last.end;
  }

  #expectClose(what: string): Token {
    const token = this.#next();
    if (token === undefined || token.kind !== "close") {
      throw new ParseFailure(`${what}が閉じていない`, this.#offsetForError());
    }
    return token;
  }

  #comparison(): AstNode {
    const left = this.#additive();
    const operator = this.#peek();
    if (operator === undefined || operator.kind !== "operator" || !isComparisonOperator(operator.text)) {
      return left;
    }
    this.#position += 1;
    const right = this.#additive();
    const chained = this.#peek();
    if (chained !== undefined && chained.kind === "operator" && isComparisonOperator(chained.text)) {
      throw new ParseFailure("比較は 1 つだけ書ける（`a < b < c` は書けない）", chained.start);
    }
    return { kind: "binary", operator: operator.text, left, right, start: left.start, end: right.end };
  }

  #additive(): AstNode {
    let node = this.#multiplicative();
    for (;;) {
      const operator = this.#peek();
      if (operator === undefined || operator.kind !== "operator") return node;
      if (operator.text !== "+" && operator.text !== "-") return node;
      this.#position += 1;
      const right = this.#multiplicative();
      node = { kind: "binary", operator: operator.text, left: node, right, start: node.start, end: right.end };
    }
  }

  #multiplicative(): AstNode {
    let node = this.#unary();
    for (;;) {
      const operator = this.#peek();
      if (operator === undefined || operator.kind !== "operator") return node;
      if (operator.text !== "*" && operator.text !== "/") return node;
      this.#position += 1;
      const right = this.#unary();
      node = { kind: "binary", operator: operator.text, left: node, right, start: node.start, end: right.end };
    }
  }

  #unary(): AstNode {
    const token = this.#peek();
    if (token !== undefined && token.kind === "operator" && token.text === "-") {
      this.#position += 1;
      const operand = this.#unary();
      return { kind: "unary", operator: "-", operand, start: token.start, end: operand.end };
    }
    return this.#primary();
  }

  #primary(): AstNode {
    const token = this.#next();
    if (token === undefined) throw new ParseFailure("式が途中で終わっている", this.#offsetForError());
    if (token.kind === "number") {
      return { kind: "number", value: Number(token.text), start: token.start, end: token.end };
    }
    if (token.kind === "string") {
      return { kind: "string", value: token.text, start: token.start, end: token.end };
    }
    if (token.kind === "name") {
      const following = this.#peek();
      if (following !== undefined && following.kind === "dot") {
        this.#position += 1;
        const member = this.#next();
        if (member === undefined || member.kind !== "name") {
          throw new ParseFailure("`.` の後ろには名前が要る（`budget.limit` の形）", following.end);
        }
        return {
          kind: "member",
          entity: token.text,
          name: member.text,
          start: token.start,
          end: member.end,
        };
      }
      if (following !== undefined && following.kind === "open") {
        this.#position += 1;
        const args: AstNode[] = [];
        if (this.#peek()?.kind === "close") {
          const close = this.#next();
          return { kind: "call", name: token.text, args, start: token.start, end: close?.end ?? token.end };
        }
        for (;;) {
          args.push(this.#comparison());
          const separator = this.#next();
          if (separator === undefined) {
            throw new ParseFailure("関数の `)` が閉じていない", this.#offsetForError());
          }
          if (separator.kind === "comma") continue;
          if (separator.kind === "close") {
            return { kind: "call", name: token.text, args, start: token.start, end: separator.end };
          }
          throw new ParseFailure(`${separator.text} は関数の引数の区切りに書けない`, separator.start);
        }
      }
      return { kind: "name", name: token.text, start: token.start, end: token.end };
    }
    if (token.kind === "open") {
      const inner = this.#comparison();
      this.#expectClose("かっこ");
      return inner;
    }
    throw new ParseFailure(`${token.text} から式が始まっている`, token.start);
  }
}

export type ParseResult =
  | { readonly ok: true; readonly ast: AstNode }
  | { readonly ok: false; readonly errors: readonly ExpressionError[] };

/** 式を AST に解析する（上限は見ない。上限まで含めて見るのは readExpression） */
export function parseExpression(text: string): ParseResult {
  const { tokens, error } = tokenize(text);
  if (error !== null) return { ok: false, errors: [error] };
  try {
    return { ok: true, ast: new Parser(tokens).parse() };
  } catch (thrown) {
    // 解析器の不具合で外へ例外を出さない。読めなかった入力は「読めなかった」として返す
    const offset = thrown instanceof ParseFailure ? thrown.offset : 0;
    const message = thrown instanceof ParseFailure ? thrown.message : "式を解析できない";
    return { ok: false, errors: [{ offset: Math.max(0, Math.min(offset, text.length)), message }] };
  }
}

/** AST のノードの数（葉も数える） */
export function countNodes(node: AstNode): number {
  switch (node.kind) {
    case "number":
    case "string":
    case "name":
    case "member":
      return 1;
    case "unary":
      return 1 + countNodes(node.operand);
    case "binary":
      return 1 + countNodes(node.left) + countNodes(node.right);
    case "call":
      return 1 + node.args.reduce((total, arg) => total + countNodes(arg), 0);
  }
}

/** AST の深さ。葉（名前・数の定数）を 1 と数える */
export function depthOf(node: AstNode): number {
  switch (node.kind) {
    case "number":
    case "string":
    case "name":
    case "member":
      return 1;
    case "unary":
      return 1 + depthOf(node.operand);
    case "binary":
      return 1 + Math.max(depthOf(node.left), depthOf(node.right));
    case "call":
      return 1 + node.args.reduce((max, arg) => Math.max(max, depthOf(arg)), 0);
  }
}

export type ExpressionReadResult =
  | { readonly ok: true; readonly ast: AstNode; readonly nodes: number; readonly depth: number }
  | { readonly ok: false; readonly problems: readonly ExpressionProblem[] };

function limitProblem(limit: keyof typeof EXPRESSION_LIMITS, actual: number): ExpressionProblem {
  return {
    offset: 0,
    code: EXPRESSION_LIMIT_CODES[limit],
    message: `${EXPRESSION_LIMIT_NAMES[limit]}が上限を超えている（${actual} > ${EXPRESSION_LIMITS[limit]}）`,
  };
}

/**
 * 式を讀んで、解析と上限を見る。**解析できた式だけを先へ渡す。**
 * 上限はここで打ち切るので、#98 の評価もこれを通してから実行する。
 */
export function readExpression(text: string): ExpressionReadResult {
  if (text.length > EXPRESSION_LIMITS.maxLength) {
    return { ok: false, problems: [limitProblem("maxLength", text.length)] };
  }
  const parsed = parseExpression(text);
  if (!parsed.ok) {
    return {
      ok: false,
      problems: parsed.errors.map((error) => ({
        offset: error.offset,
        code: "LOGIC_EXPRESSION_INVALID",
        message: `式を解析できない: ${error.message}`,
      })),
    };
  }
  const nodes = countNodes(parsed.ast);
  const depth = depthOf(parsed.ast);
  const problems: ExpressionProblem[] = [];
  if (depth > EXPRESSION_LIMITS.maxDepth) problems.push(limitProblem("maxDepth", depth));
  if (nodes > EXPRESSION_LIMITS.maxNodes) problems.push(limitProblem("maxNodes", nodes));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, ast: parsed.ast, nodes, depth };
}

// ── 式の中の位置を、YAML の位置へ写す ────────────────────────────

/**
 * 式の中のオフセットを、YAML の行と列にする。
 *
 * 式が 1 行に収まっているとき、位置は**文字単位で正しい**（診断はこの形で出す）。
 * 引用符つきの値では、引用符の分だけ後ろへずれる（式の本文と原文の字面が同じでないため）。
 */
export function positionAt(text: string, offset: number, base: DiagnosticPosition): DiagnosticPosition {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lineBreaks = before.split("\n").length - 1;
  if (lineBreaks === 0) return { line: base.line, column: base.column + before.length };
  const lastBreak = before.lastIndexOf("\n");
  return { line: base.line + lineBreaks, column: before.length - lastBreak };
}

/** 式の問題を、診断（原文の位置つき）にする */
export function expressionDiagnostics(
  problems: readonly ExpressionProblem[],
  text: string,
  base: DiagnosticPosition,
): Diagnostic[] {
  return problems.map((problem) =>
    diagnostic(problem.code, problem.message, positionAt(text, problem.offset, base)),
  );
}

// ── 実行しない型の検査 ──────────────────────────────────────────

/**
 * 式の名前を宣言に突き合わせる口。check.ts が entity ごとに作る。
 * **ここに値を持ち込まない**（レコードを渡すと、検査がデータに依存してしまう）。
 */
export interface ExpressionScope {
  /** 同じ entity の項目か計算の名前として解決する。無ければ null */
  resolveName(name: string): SpecType | null;
  /** entity の名前ならその名前を返す（`.` を使った参照を断るため。同じ entity の名前でも返す） */
  entityName(name: string): string | null;
}

export interface ExpressionAnalysis {
  /** 式の型。`unknown` は決められなかったことを表す（呼ぶ側が「食い違い無し」として扱う） */
  readonly type: SpecType;
  readonly problems: readonly ExpressionProblem[];
  /** 式が参照した名前（計算どうしの循環を見るのに使う） */
  readonly names: readonly string[];
}

const TYPE_NAMES: Readonly<Record<SpecType, string>> = {
  number: "数",
  string: "文字列",
  list: "文字列の並び",
  boolean: "真偽",
  date: "日付",
  unknown: "決められない",
};

export function typeName(type: SpecType): string {
  return TYPE_NAMES[type];
}

const isNumberCompatible = (type: SpecType): boolean => type === "number" || type === "unknown";

/**
 * 比較の左右の型。**同じ型どうしだけ**を比べられる（M1.3。docs/semantics.md「date」「string」）。
 * 片方が日付なら、もう片方も日付でなければならない——`due < 1` は `LOGIC_OPERAND_TYPE_MISMATCH` になる。
 * 片方が文字列なら、もう片方も文字列である（`==`・`!=` だけ。下の `isOrderedComparison`）。
 */
const comparisonOperand = (left: SpecType, right: SpecType): SpecType =>
  left === "date" || right === "date"
    ? "date"
    : left === "string" || right === "string"
      ? "string"
      : "number";

/** 大小の比較（`==`・`!=` 以外）。文字列には使えない（M1.3。「決まった値を比べる」だけを許す） */
const isOrderedComparison = (operator: string): boolean =>
  isComparisonOperator(operator) && operator !== "==" && operator !== "!=";

const isOperandCompatible = (type: SpecType, expected: SpecType): boolean =>
  type === "unknown" || type === expected;

/**
 * 式に書ける関数の定義。**正本は appspec-schema の 2 つの表を合わせたもの**である——
 * `min`・`max`・`len`（M1.1）と `today`（M1.3）。表が分かれているのは、M1.1 の関数の一覧
 * （`BUILTIN_FUNCTIONS`）を読む側の意味を変えないためである（appspec-schema の DATE_FUNCTIONS の注記）。
 */
const EXPRESSION_FUNCTIONS = { ...BUILTIN_FUNCTIONS, ...DATE_FUNCTIONS };

type ExpressionFunctionName = keyof typeof EXPRESSION_FUNCTIONS;

const isBuiltinFunction = (name: string): name is ExpressionFunctionName =>
  Object.hasOwn(EXPRESSION_FUNCTIONS, name);

/** 式の型を、宣言の名前解決の上で求める。**式は評価しない**（値を求めない） */
export function analyzeExpression(ast: AstNode, scope: ExpressionScope): ExpressionAnalysis {
  const problems: ExpressionProblem[] = [];
  const names: string[] = [];

  const visit = (node: AstNode): SpecType => {
    switch (node.kind) {
      case "number":
        return "number";
      case "string":
        return "string";
      case "name": {
        names.push(node.name);
        const resolved = scope.resolveName(node.name);
        if (resolved === null) {
          problems.push({
            offset: node.start,
            code: "LOGIC_REFERENCE_NOT_FOUND",
            message: `${node.name} は、この entity の項目にも計算にも無い`,
          });
          return "unknown";
        }
        return resolved;
      }
      case "member": {
        const entity = scope.entityName(node.entity);
        problems.push({
          offset: node.start,
          code: entity === null ? "LOGIC_REFERENCE_NOT_FOUND" : "LOGIC_REFERENCE_OUT_OF_ENTITY",
          message:
            entity === null
              ? `${node.entity} という entity が無い`
              : `${node.entity} は entity の名前である（M1.1 は同じ entity の項目と計算だけを、ドットを使わずに参照できる）`,
        });
        return "unknown";
      }
      case "unary": {
        const operand = visit(node.operand);
        if (!isNumberCompatible(operand)) {
          problems.push({
            offset: node.operand.start,
            code: "LOGIC_OPERAND_TYPE_MISMATCH",
            message: `符号 - は数に付ける（${typeName(operand)}が来ている）`,
          });
          return "unknown";
        }
        return "number";
      }
      case "binary": {
        const left = visit(node.left);
        const right = visit(node.right);
        const comparison = isComparisonOperator(node.operator);
        // 計算は数どうしだけである。比較は、同じ型どうし（数・日付・文字列）だけを許す（M1.3）
        const expected = comparison ? comparisonOperand(left, right) : "number";
        const phrase =
          expected === "date"
            ? "日付どうしを比べる"
            : expected === "string"
              ? "文字列どうしを比べる"
              : comparison
                ? "数どうしを比べる"
                : "数どうしの計算";
        let mismatch = false;
        if (!isOperandCompatible(left, expected)) {
          mismatch = true;
          problems.push({
            offset: node.left.start,
            code: "LOGIC_OPERAND_TYPE_MISMATCH",
            message: `${node.operator} は${phrase}に使う（左が${typeName(left)}）`,
          });
        }
        if (!isOperandCompatible(right, expected)) {
          mismatch = true;
          problems.push({
            offset: node.right.start,
            code: "LOGIC_OPERAND_TYPE_MISMATCH",
            message: `${node.operator} は${phrase}に使う（右が${typeName(right)}）`,
          });
        }
        if (mismatch) return "unknown";
        // 文字列は「同じか違うか」だけを比べられる（大小は比べない。docs/semantics.md「string」）。
        // 左右の型が揃っていることを先に見てから断る（1 つの誤りを 2 つにしない）
        if (expected === "string" && isOrderedComparison(node.operator)) {
          problems.push({
            offset: node.start,
            code: "LOGIC_OPERAND_TYPE_MISMATCH",
            message: `${node.operator} は文字列に使えない（文字列は == と != だけで比べられる）`,
          });
          return "unknown";
        }
        return comparison ? "boolean" : "number";
      }
      case "call": {
        const args = node.args.map(visit);
        if (!isBuiltinFunction(node.name)) {
          problems.push({
            offset: node.start,
            code: "LOGIC_FUNCTION_NOT_ALLOWED",
            message: `${node.name} は店頭が用意していない（${Object.keys(EXPRESSION_FUNCTIONS).join("・")} だけ）`,
          });
          return "unknown";
        }
        const signature = EXPRESSION_FUNCTIONS[node.name];
        if (args.length !== signature.params.length) {
          problems.push({
            offset: node.start,
            code: "LOGIC_FUNCTION_ARITY_MISMATCH",
            message: `${node.name} は引数を ${signature.params.length} つ取る（${args.length} つ来ている）`,
          });
          return "unknown";
        }
        let mismatch = false;
        args.forEach((type, index) => {
          const expected = signature.params[index] ?? "number";
          if (type !== "unknown" && type !== expected) {
            mismatch = true;
            problems.push({
              offset: node.args[index]?.start ?? node.start,
              code: "LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH",
              message: `${node.name} の ${index + 1} 番目の引数は${typeName(expected)}（${typeName(type)}が来ている）`,
            });
          }
        });
        return mismatch ? "unknown" : signature.returns;
      }
    }
  };

  const raw = visit(ast);
  const ordered = [...problems].sort((a, b) => a.offset - b.offset);
  // 式に 1 つでも誤りがあれば、型は決められないものとして扱う。誤りの内側の型から
  // 「計算の type と食い違う」「検査が真偽でない」を重ねて出すと、**1 つの誤りが 2 つ以上の
  // コードになる**（受入条件は、負例ごとに返るコードの集合を固定している）。
  return { type: ordered.length > 0 ? "unknown" : raw, problems: ordered, names };
}
