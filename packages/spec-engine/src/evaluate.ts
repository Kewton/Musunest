// 検査済みの宣言とレコードから、computed の値と validation の失敗名を求める（Issue #98）。
// 意味は packages/appspec-schema/docs/semantics.md（「computed」「validation」）、層は
// workspace/mvp/m1/03-spec-layers-and-checker.md §2.3 にある。
//
// 引き受けるのは**同じ entity の中の計算**である（v0.1 からの `reference_scope: same_entity`）。
// 入力の型検査と保存は data-api の仕事で、ここは**型検査を通ったレコード**だけを受け取る。
//
// **入口は正規化した JSON（NormalizedAppSpec）だけである。** 未検査の YAML を評価に渡す口は無い
// （Q12。publish が作った成果物だけがここへ届く）。そのうえで、評価は式の上限を**もう一度**見る——
// 成果物が手で作られていても、上限を超えた式を成功値として返さないためである。
//
// 決めたこと（README「評価」）:
//   1. computed は**依存の順**に評価する（宣言の並びに依らない。docs/semantics.md「computed」）
//   2. 計算の途中で有限の数でなくなったら（0 で割る・桁あふれ）、computed は `null`、validation は不合格。
//      **不正な計算値を 0 に読み替えない**
//   3. validation は**宣言の順にすべて**評価し、真にならなかった名前を宣言の順に返す
//   4. 式の上限（文字数 200・深さ 8・ノード 64）は静的チェックと同じ EXPRESSION_LIMITS を使う
//   5. 計算値は戻り値にだけ入れる（渡されたレコードを書き換えない）
//   6. 時計は引数で受け取る（M1.1 の値は時計に依存しない。境界は src/clock.ts）
//
// **式を実行しない**（`eval` / `Function` を使わない。03 §5.3・CLAUDE.md の不変条件）。
// AST を歩いて値を求める。AST は readExpression の上限の内側でしか作らないので、歩く深さも有界である。

import {
  BUILTIN_FUNCTIONS,
  type Computed,
  type Entity,
  type NormalizedAppSpec,
} from "@musunest/appspec-schema";
import type { Clock } from "./clock.js";
import { isComparisonOperator, readExpression, type AstNode } from "./expression.js";

/** computed の値。求められなかった計算は `null`（画面では空。docs/semantics.md「computed」） */
export type ComputedValue = number | null;

/** 式の値。求められなかった値は `null`（**0 に読み替えない**） */
type EvaluatedValue = number | boolean | readonly unknown[] | null;

/** 評価の結果。computed の値（宣言の順）と、通らなかった検査の名前（宣言の順） */
export interface Evaluation {
  /** entity の計算の値（宣言の順）。計算が無ければ空 */
  readonly computed: Readonly<Record<string, ComputedValue>>;
  /** 通らなかった検査の名前（宣言の順）。空なら、このレコードは検査を通っている */
  readonly validations: readonly string[];
}

/** 評価に渡すもの。**宣言は検査済みのもの**（正規化した JSON）に限る */
export interface EvaluationRequest {
  /** 検査済みの宣言（publish が作った正規化した JSON。src/normalize.ts） */
  readonly app: NormalizedAppSpec;
  /** 評価する entity の名前 */
  readonly entity: string;
  /** 型検査を通った 1 件のレコード。**書き換えない** */
  readonly record: Readonly<Record<string, unknown>>;
  /** 差し込む時計（Q17） */
  readonly clock: Clock;
}

/**
 * 式を評価する環境。名前に値を結びつける関数と、差し込まれた時計を持つ。
 * `clock` は M1.3 の日付関数が読む席である——M1.1 の式は日付を読まないので、値は時計に依らない。
 */
interface EvaluationScope {
  /** 名前（項目か計算）を値にする。宣言に無い名前は `null` */
  readonly resolve: (name: string) => EvaluatedValue;
  /** 差し込まれた時計。読み取りはここを通す（評価の中で現在時刻を直接読まない） */
  readonly clock: Clock;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * レコードの値を、式が使える値にする。式に書けるのは数と（`len` の引数の）文字列の並びだけである
 * （docs/semantics.md「computed」）。それ以外は `null` にする——0 にも空の並びにも読み替えない。
 */
const asExpressionValue = (value: unknown): EvaluatedValue =>
  typeof value === "number" || Array.isArray(value) ? value : null;

/** 数どうしの計算。**有限の数でなくなったら `null`**（0 で割る・桁あふれ。ADR の決定 2） */
function arithmetic(operator: string, left: number, right: number): EvaluatedValue {
  const value =
    operator === "+"
      ? left + right
      : operator === "-"
        ? left - right
        : operator === "*"
          ? left * right
          : operator === "/"
            ? left / right
            : Number.NaN;
  return isFiniteNumber(value) ? value : null;
}

/** 数どうしの比較。両方が有限の数でなければ `null`（不合格にも真偽にもしない） */
function compare(operator: string, left: number, right: number): EvaluatedValue {
  switch (operator) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return null;
  }
}

/** 店頭が用意した関数（正本は appspec-schema の BUILTIN_FUNCTIONS）。用意されていない関数は `null` */
function callValue(name: string, args: readonly EvaluatedValue[]): EvaluatedValue {
  if (!Object.hasOwn(BUILTIN_FUNCTIONS, name)) return null;
  if (name === "len") {
    const [only] = args;
    return Array.isArray(only) ? only.length : null;
  }
  const [left, right] = args;
  if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null;
  return name === "min" ? Math.min(left, right) : Math.max(left, right);
}

/** AST を歩いて値を求める。**式を実行しない**（`eval` / `Function` を使わない） */
function evaluateNode(node: AstNode, scope: EvaluationScope): EvaluatedValue {
  switch (node.kind) {
    case "number":
      return node.value;
    case "name":
      return scope.resolve(node.name);
    case "member":
      // `.` を使った参照は M1.1 では書けない（検査が LOGIC_REFERENCE_OUT_OF_ENTITY で断る）
      return null;
    case "unary": {
      const operand = evaluateNode(node.operand, scope);
      if (!isFiniteNumber(operand)) return null;
      const value = -operand;
      return isFiniteNumber(value) ? value : null;
    }
    case "binary": {
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null;
      return isComparisonOperator(node.operator)
        ? compare(node.operator, left, right)
        : arithmetic(node.operator, left, right);
    }
    case "call":
      return callValue(
        node.name,
        node.args.map((argument) => evaluateNode(argument, scope)),
      );
  }
}

/**
 * 式を値にする。**読めない式は `null`** にする——上限（文字数 200・深さ 8・ノード 64）を超えた式も
 * ここで止まる（決定 4。評価側でも同じ定数を見る）。
 */
function valueOfExpression(expression: string, scope: EvaluationScope): EvaluatedValue {
  const read = readExpression(expression);
  if (!read.ok) return null;
  return evaluateNode(read.ast, scope);
}

/** 計算の値。有限の数にならなければ `null`（決定 2） */
function computedValueOf(entry: Computed, scope: EvaluationScope): ComputedValue {
  const value = valueOfExpression(entry.expression, scope);
  return isFiniteNumber(value) ? value : null;
}

/** 検査が通ったか。**真になったときだけ**通ったものとする（真偽にならない値は通さない。決定 3） */
const holds = (expression: string, scope: EvaluationScope): boolean =>
  valueOfExpression(expression, scope) === true;

/** 宣言から、その entity を対象にしたものを取り出す（宣言の順のまま） */
const forEntity = <T extends { readonly entity: string }>(
  entries: readonly T[],
  entity: string,
): readonly T[] => entries.filter((entry) => entry.entity === entity);

/**
 * 1 件のレコードを評価する。**渡されたレコードを書き換えない**（決定 5）。
 *
 * - `computed` … 計算の値。依存の順に求めるが、返す並びは**宣言の順**である
 * - `validations` … 通らなかった検査の名前（宣言の順）。すべて評価する（途中で打ち切らない）
 *
 * 宣言に無い entity は、計算も検査も無いものとして空を返す（呼ぶ側が先に entity の実在を見る）。
 */
export function evaluateRecord(request: EvaluationRequest): Evaluation {
  const { app, entity: entityName, record, clock } = request;
  const entity: Entity | undefined = app.spec.entities.find(
    (candidate) => candidate.name === entityName,
  );
  if (entity === undefined) return { computed: {}, validations: [] };
  const declared = forEntity(app.spec.computed, entityName);
  const validations = forEntity(app.spec.validations, entityName);

  const values = new Map<string, ComputedValue>();
  const declaredByName = new Map(declared.map((entry) => [entry.name, entry]));
  // 循環は null にする。検査が断る（LOGIC_COMPUTED_CYCLE）が、手で作った成果物を渡されても止まらないため
  const visiting = new Set<string>();

  const scope: EvaluationScope = {
    clock,
    resolve: (name) => {
      // 項目を先に見る（名前は重ならないが、検査と同じ優先の付け方にしておく）
      if (Object.hasOwn(entity.fields, name)) return asExpressionValue(record[name]);
      return resolveComputed(name);
    },
  };

  /** 計算を依存の順に求める。宣言の並びに依らない（決定 1） */
  function resolveComputed(name: string): ComputedValue {
    const known = values.get(name);
    if (known !== undefined) return known;
    const entry = declaredByName.get(name);
    if (entry === undefined) return null;
    if (visiting.has(name)) return null;
    visiting.add(name);
    const value = computedValueOf(entry, scope);
    visiting.delete(name);
    values.set(name, value);
    return value;
  }

  const computed: Record<string, ComputedValue> = {};
  for (const entry of declared) computed[entry.name] = resolveComputed(entry.name);

  // 宣言の順にすべて評価する（決定 3。途中で打ち切らない）
  const failed = validations
    .filter((validation) => !holds(validation.expression, scope))
    .map((validation) => validation.name);

  return { computed, validations: failed };
}
