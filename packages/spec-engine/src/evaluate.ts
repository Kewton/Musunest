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
//   6. 時計は引数で受け取る。値が時計に依存するのは `today()`（日本時間の「今日」）だけである（M1.3。Q13）
//   7. entity をまたぐ集計（`aggregate`）は、**同じインスタンスのレコード**だけを、渡された `sources` から見る
//      （M1.2。別インスタンスの ID は存在しない）。合う行が 0 件なら 0、対象の値に `null` が 1 つでもあれば
//      `null` にする（**空集合の 0 と区別し、黙って 0 に読み替えない**）
//   8. 日付（`date`）の値は `YYYY-MM-DD` の文字列として扱い、**日付どうしでだけ比べる**（M1.3）。
//      形の合わない値は `null` にして、真偽にも数にもしない（`date` と `number` の比較は静的チェックが断る）
//   9. 操作の条件（`when`。M1.3）は、検査の式と**同じ環境**で解く（`allowsAction`）。**真になったときだけ通す**
//      ——偽と「値が求まらない」を区別せず、どちらも通さない（決定 3 と同じ扱いである）
//
// **式を実行しない**（`eval` / `Function` を使わない。03 §5.3・CLAUDE.md の不変条件）。
// AST を歩いて値を求める。AST は readExpression の上限の内側でしか作らないので、歩く深さも有界である。

import {
  BUILTIN_FUNCTIONS,
  DATE_FUNCTIONS,
  DATE_VALUE_PATTERN,
  fieldKind,
  isAppComputed,
  isComputedAggregate,
  isComputedExpression,
  isRowComputed,
  type Aggregate,
  type AppComputed,
  type ComputedExpression,
  type Entity,
  type FieldKind,
  type NormalizedAppSpec,
  type RowComputed,
} from "@musunest/appspec-schema";
import {
  avgValues,
  hasConditions,
  matchesWhere,
  sumValues,
  type SourceRecord,
  type SourceRecords,
} from "./aggregate.js";
import { todayInTokyo, type Clock } from "./clock.js";
import { isComparisonOperator, readExpression, type AstNode } from "./expression.js";

// 集計の評価に使う道具（`where` の判定・要るレコードの集め方・合計の畳み方）は src/aggregate.ts にある。
// データを読む側（data-api）が「どの entity のレコードを渡せばよいか」を知れるように、ここから再輸出する
// （パッケージの根は index.ts が `./evaluate.js` を出している）。
export * from "./aggregate.js";

// 精算（`settle`。M1.2）の道具も同じ理由でここから再輸出する。**精算は行ごとの値ではない**ので、
// この file の評価（`evaluateRecord`）は精算の計算を解かない——呼ぶ側（data-api）が一覧を組むときに、
// `settleEntity` を別に呼ぶ（docs/semantics.md「settle」）。
export * from "./settle.js";

/** computed の値。求められなかった計算は `null`（画面では空。docs/semantics.md「computed」） */
export type ComputedValue = number | null;

/** 式の値。求められなかった値は `null`（**0 に読み替えない**）。日付は `YYYY-MM-DD` の文字列である */
type EvaluatedValue = number | boolean | string | readonly unknown[] | null;

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
  /**
   * このレコードの ID（M1.2）。集計の `where` の `this` は、この値と比べる。
   * 項目の値に `id` は入らないので、集計を使うときはここで渡す。
   */
  readonly recordId?: string;
  /**
   * 集計の元になる、**同じインスタンス**のレコード（entity の名前 → そのレコードの並び。M1.2）。
   * 集計を使わない宣言では渡さなくてよい。**「キーが無い」と「空の並び」は別の意味である**——
   * 前者は集計を `null`（読めていない）、後者は 0（読めたが 0 件）にする。
   */
  readonly sources?: SourceRecords;
}

/**
 * 式を評価する環境。名前に値を結びつける関数と、差し込まれた時計を持つ。
 * `clock` は `today()`（日本時間の「今日」）が読む——**評価の中で現在時刻を直接読まない**（Q17）。
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
 * レコードの値を、式が使える値にする。式に書けるのは数・日付（`YYYY-MM-DD` の文字列）・
 * （`len` の引数の）文字列の並びだけである（docs/semantics.md「computed」「date」）。
 * それ以外は `null` にする——0 にも空の並びにも読み替えない。
 */
const asExpressionValue = (value: unknown, kind: FieldKind): EvaluatedValue => {
  // 日付の項目は `YYYY-MM-DD` の文字列として式に渡す（形が違う値は式の値にしない）
  if (kind === "date") {
    return typeof value === "string" && DATE_VALUE_PATTERN.test(value) ? value : null;
  }
  // 文字列・選択肢のキー・参照の ID は、文字列の定数と比べられる（M1.3。docs/semantics.md「string」）
  if (kind === "string" || kind === "enum" || kind === "ref") {
    return typeof value === "string" ? value : null;
  }
  return typeof value === "number" || Array.isArray(value) ? value : null;
};

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
function compareNumbers(operator: string, left: number, right: number): EvaluatedValue {
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

/**
 * 文字列どうしの比較。日付（`YYYY-MM-DD`）は**桁数が揃った文字列なので、辞書の順が暦の順と一致する**（M1.3）。
 *
 * 文字列の定数（M1.3）と `enum` のキー・`ref` の ID も同じ文字列なので、ここが受け持つ。
 * **大小の比較を書けるのは日付だけ**で、ただの文字列は `==`・`!=` しか書けない——それを断るのは
 * 静的チェックである（評価は、通った式だけを解く）。
 */
function compareTexts(operator: string, left: string, right: string): EvaluatedValue {
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

/**
 * 比較。**数どうし、または文字列どうし（日付を含む）のときだけ**真偽を返す——型の食い違い
 * （`date` と `number`）は静的チェックが断るが、評価も真偽にしない
 * （`null` にして、検査は通らないものとして扱う）。
 */
function compare(operator: string, left: EvaluatedValue, right: EvaluatedValue): EvaluatedValue {
  if (isFiniteNumber(left) && isFiniteNumber(right)) return compareNumbers(operator, left, right);
  if (typeof left === "string" && typeof right === "string") return compareTexts(operator, left, right);
  return null;
}

/**
 * 店頭が用意した関数の値を求める（正本は appspec-schema の `BUILTIN_FUNCTIONS` と `DATE_FUNCTIONS`）。
 * 用意されていない関数は `null`。
 */
function callValue(name: string, args: readonly EvaluatedValue[], clock: Clock): EvaluatedValue {
  // 日付の関数（M1.3）。いまは `today` だけである。**時計は引数で受け取る**
  // （Q17。評価の中で現在時刻を直接読まない）
  if (Object.hasOwn(DATE_FUNCTIONS, name)) {
    return name === "today" && args.length === 0 ? todayInTokyo(clock) : null;
  }
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
    case "string":
      // 文字列の定数（M1.3）。引用符を外した中身をそのまま値にする
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
      // 比較は数どうしと日付どうし（ほかは `null`）。計算は有限の数どうしだけである
      if (isComparisonOperator(node.operator)) return compare(node.operator, left, right);
      if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null;
      return arithmetic(node.operator, left, right);
    }
    case "call":
      return callValue(
        node.name,
        node.args.map((argument) => evaluateNode(argument, scope)),
        scope.clock,
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

/** 式で求める計算の値。有限の数にならなければ `null`（決定 2） */
function computedValueOf(entry: ComputedExpression, scope: EvaluationScope): ComputedValue {
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
 * 評価の途中で共有するもの。集計は entity をまたぐので、**同じ（entity・レコード・計算）を解き続けない**
 * ための目印を、再帰のすべてで共有する（循環を null にする。検査が断るが、手で作った成果物でも止まらない）。
 */
interface EvaluationState {
  readonly visiting: Set<string>;
}

/**
 * 集計の値を求める（M1.2）。**同じインスタンスのレコードだけ**を見る。
 * 対象の値に `null`（有限の数でなくなった計算など）が 1 つでもあれば `null`（決定 7。`sumValues`）。
 */
function aggregateValueOf(
  aggregate: Aggregate,
  request: EvaluationRequest,
  state: EvaluationState,
): ComputedValue {
  const { app, recordId, sources } = request;
  // 「まだ読んでいない」（キーが無い）は 0 ではなく null にする。読めて 0 件（空の並び）だけが 0 である
  if (sources === undefined) return null;
  const rows = sources[aggregate.entity];
  if (rows === undefined) return null;
  // `where` は `this`（このレコードの ID）と比べる。ID が無ければ判定できないので、0 にせず null にする
  if (hasConditions(aggregate.where) && recordId === undefined) return null;
  const thisId = recordId ?? "";
  const matched = rows.filter((row) => matchesWhere(aggregate.where, row.data, thisId));
  if (aggregate.kind === "count") return matched.length;
  if (aggregate.name === null) return null;
  const target: Entity | undefined = app.spec.entities.find(
    (candidate) => candidate.name === aggregate.entity,
  );
  if (target === undefined) return null;
  const name = aggregate.name;
  const values = matched.map((row) => sourceValueOf(target, name, row, request, state));
  // `avg`（M1.4）は、値の無い行を数えない（`avgValues` の注記）。`sum` は 1 つでも欠ければ `null`
  return aggregate.kind === "sum" ? sumValues(values) : avgValues(values);
}

/**
 * 集計の対象の値を 1 件から求める。項目なら値を、計算なら**その計算を解いた値**を返す
 * （`sum: expense.shareAmount` は、支出ごとの `shareAmount` を足す）。数でなければ `null`。
 */
function sourceValueOf(
  target: Entity,
  name: string,
  row: SourceRecord,
  request: EvaluationRequest,
  state: EvaluationState,
): number | null {
  if (Object.hasOwn(target.fields, name)) {
    const value = row.data[name];
    return isFiniteNumber(value) ? value : null;
  }
  const evaluation = evaluateEntity(
    { ...request, entity: target.name, record: row.data, recordId: row.id },
    state,
  );
  const value = evaluation.computed[name];
  return isFiniteNumber(value) ? value : null;
}

/** 1 件のレコードを評価する。集計の元の行を解くときは、同じ state を渡して再帰する */
/** 1 件のレコードのための、式を解く材料（環境と、行ごとの計算） */
interface PreparedRecord {
  readonly scope: EvaluationScope;
  /** その entity の、行ごとの値になる計算（宣言の順） */
  readonly declared: readonly RowComputed[];
  /** 計算を依存の順に求める（同じレコードの中では 1 回だけ解く） */
  readonly resolveComputed: (name: string) => ComputedValue;
}

/**
 * 1 件のレコードの式を解く材料を組む。宣言に無い entity は `null`（呼ぶ側が空として扱う）。
 *
 * **検査の式（`validation`）も操作の条件（`when`。M1.3）も、ここで組んだ同じ環境で解く**——
 * 「保存してよいか」と「この行で操作してよいか」が、別々の名前解決を持つと食い違う。
 */
function prepareRecord(request: EvaluationRequest, state: EvaluationState): PreparedRecord | null {
  const { app, entity: entityName, record, clock } = request;
  const entity: Entity | undefined = app.spec.entities.find(
    (candidate) => candidate.name === entityName,
  );
  if (entity === undefined) return null;
  // **真偽（`boolean`）の計算は、行の `computed` に入れない**（M1.3）。強調（`highlight`）が指すためだけに
  // 使い、値は data-api が `holdsExpression` で解いて行に載せる（Issue #157）。ここが数だけを返すので、
  // 一覧の応答の `computed` に真偽が混ざらない（列にも出さない）
  const declared = forEntity(
    app.spec.computed.filter(isRowComputed),
    entityName,
  ).filter((entry) => entry.type !== "boolean");

  const values = new Map<string, ComputedValue>();
  const declaredByName = new Map(declared.map((entry) => [entry.name, entry]));

  const scope: EvaluationScope = {
    clock,
    resolve: (name) => {
      // 項目を先に見る（名前は重ならないが、検査と同じ優先の付け方にしておく）
      const declaration = entity.fields[name];
      if (declaration !== undefined) return asExpressionValue(record[name], fieldKind(declaration));
      return resolveComputed(name);
    },
  };

  /** 計算を依存の順に求める。宣言の並びに依らない（決定 1） */
  function resolveComputed(name: string): ComputedValue {
    const known = values.get(name);
    if (known !== undefined) return known;
    const entry = declaredByName.get(name);
    if (entry === undefined) return null;
    // 目印は「entity・レコード・計算」の 3 つ組である（集計をまたぐ循環も止める）
    const key = `${entityName}\u0000${request.recordId ?? ""}\u0000${name}`;
    if (state.visiting.has(key)) return null;
    state.visiting.add(key);
    const value = isComputedExpression(entry)
      ? computedValueOf(entry, scope)
      : isComputedAggregate(entry)
        ? aggregateValueOf(entry.aggregate, request, state)
        : null;
    state.visiting.delete(key);
    values.set(name, value);
    return value;
  }

  return { scope, declared, resolveComputed };
}

function evaluateEntity(request: EvaluationRequest, state: EvaluationState): Evaluation {
  const prepared = prepareRecord(request, state);
  if (prepared === null) return { computed: {}, validations: [] };

  const computed: Record<string, ComputedValue> = {};
  for (const entry of prepared.declared) computed[entry.name] = prepared.resolveComputed(entry.name);

  // 宣言の順にすべて評価する（決定 3。途中で打ち切らない）
  const failed = forEntity(request.app.spec.validations, request.entity)
    .filter((validation) => !holds(validation.expression, prepared.scope))
    .map((validation) => validation.name);

  return { computed, validations: failed };
}

/**
 * 1 件のレコードを評価する。**渡されたレコードを書き換えない**（決定 5）。
 *
 * - `computed` … 計算の値。依存の順に求めるが、返す並びは**宣言の順**である
 * - `validations` … 通らなかった検査の名前（宣言の順）。すべて評価する（途中で打ち切らない）
 * - 集計（`aggregate`）は、渡された `sources` のレコードだけを見る（決定 7。M1.2）
 *
 * 宣言に無い entity は、計算も検査も無いものとして空を返す（呼ぶ側が先に entity の実在を見る）。
 */
export function evaluateRecord(request: EvaluationRequest): Evaluation {
  return evaluateEntity(request, { visiting: new Set<string>() });
}

// ── アプリ全体の集計（`scope: app`。M1.4。Issue #177） ──────────────────
//
// **行ではなく、アプリ全体で 1 つの値**を求める。出力先のレコードが無いので `this` も無く、
// 集計の `where` も持てない（`this` を書けば静的チェックが断る。期間の条件は #178 で足す）。
// 参照できるのは**ほかのアプリ全体の計算だけ**である（entity の項目や行ごとの計算は見えない）。
// 行ごとの値と同じく、**値は保存しない**——一覧を返すたびにここで求める。

/** アプリ全体の値を求めるのに渡すもの。**集計の元のレコードは `sources` から見る** */
export interface ScopeEvaluationRequest {
  readonly app: NormalizedAppSpec;
  readonly clock: Clock;
  /** 集計の元になる、**同じインスタンス**のレコード（entity の名前 → そのレコードの並び） */
  readonly sources: SourceRecords;
}

/** アプリ全体の計算を解くときの、循環を止めるための目印（名前は宣言の中で一意である） */
interface ScopeState {
  readonly visiting: Set<string>;
}

/**
 * アプリ全体の集計の値を求める。**`where` を持てない**——出力先のレコードが無く、`this` を
 * 比べる相手が居ないからである。持っていれば（手で作った成果物でも）`null` にして、
 * 条件を黙って無視しない。
 */
function appAggregateValueOf(
  aggregate: Aggregate,
  request: ScopeEvaluationRequest,
  state: ScopeState,
): ComputedValue {
  const { app, sources } = request;
  // 「まだ読んでいない」（キーが無い）は 0 ではなく null にする。読めて 0 件（空の並び）だけが 0 である
  const rows = sources[aggregate.entity];
  if (rows === undefined) return null;
  if (hasConditions(aggregate.where)) return null;
  if (aggregate.kind === "count") return rows.length;
  if (aggregate.name === null) return null;
  const target = app.spec.entities.find((candidate) => candidate.name === aggregate.entity);
  if (target === undefined) return null;
  const name = aggregate.name;
  const rowRequest: EvaluationRequest = {
    app,
    clock: request.clock,
    entity: aggregate.entity,
    record: {},
    sources,
  };
  const values = rows.map((row) => sourceValueOf(target, name, row, rowRequest, state));
  return aggregate.kind === "sum" ? sumValues(values) : avgValues(values);
}

/**
 * アプリ全体の計算の値を、**宣言の順**に求める。依存（ほかのアプリ全体の計算）は再帰で解き、
 * 循環は `null` にする（検査が断るが、手で作った成果物でも止まらない）。
 * 求める値は数だけである——アプリ全体の計算の `type` は `number` だからである。
 */
function evaluateScopeValues(
  request: ScopeEvaluationRequest,
  state: ScopeState,
): Readonly<Record<string, ComputedValue>> {
  const declared: readonly AppComputed[] = request.app.spec.computed.filter(isAppComputed);
  const byName = new Map(declared.map((entry) => [entry.name, entry]));
  const values = new Map<string, ComputedValue>();

  const scope: EvaluationScope = { clock: request.clock, resolve: (name) => resolve(name) };

  /** 依存の順に求める。同じ名前は 1 回だけ解く（返す並びは宣言の順である） */
  function resolve(name: string): ComputedValue {
    const known = values.get(name);
    if (known !== undefined) return known;
    const entry = byName.get(name);
    if (entry === undefined) return null;
    if (state.visiting.has(name)) return null;
    state.visiting.add(name);
    const value =
      "expression" in entry
        ? numberOrNull(valueOfExpression(entry.expression, scope))
        : appAggregateValueOf(entry.aggregate, request, state);
    state.visiting.delete(name);
    values.set(name, value);
    return value;
  }

  const result: Record<string, ComputedValue> = {};
  for (const entry of declared) result[entry.name] = resolve(entry.name);
  return result;
}

/**
 * **アプリ全体の計算（`scope: app`）の値を、宣言の順に求める**（M1.4。Issue #177）。
 * アプリ全体の計算が 1 つも無ければ空である（呼ぶ側は、空なら応答に欄を載せない）。
 *
 * 集計は `sources` のレコードだけを見る（`sources` にキーが無ければ `null`）。
 * **これは行ごとの値ではなく、アプリ全体で 1 つだけの値である**——レコードの数に関わらず 1 つ返る。
 */
export function evaluateScope(request: ScopeEvaluationRequest): Readonly<Record<string, ComputedValue>> {
  return evaluateScopeValues(request, { visiting: new Set<string>() });
}

/** 値を計算の値（数か `null`）にする。有限の数でなければ `null`（0 に読み替えない） */
const numberOrNull = (value: EvaluatedValue): ComputedValue => (isFiniteNumber(value) ? value : null);

/**
 * 操作の条件（`when`。M1.3）が、この 1 件で成り立つかを求める。**真になったときだけ `true`** である
 * （偽も、値が求まらなかった（`null`）も、どちらも `false`。検査の式と同じ扱いである）。
 *
 * **これはロジック層の守りの材料である**——呼ぶ側（data-api）が、この値で操作を断る。
 * 画面がボタンを隠すのは親切であって守りではない（`03-spec-layers-and-checker.md` §2.2）。
 *
 * 宣言に無い entity は `false`（呼ぶ側が先に entity の実在を見る。成功に読み替えない）。
 */
export function allowsAction(request: EvaluationRequest, when: string): boolean {
  return holdsExpression(request, when);
}

/**
 * その式が、この 1 件で真になるか（M1.3）。**真になったときだけ `true`** である
 * （偽も、値が求まらなかった（`null`）も `false`。`when` と同じ扱いである）。
 *
 * **ボードの強調（`highlight`）の判定が使う**——`highlight` が指す真偽の計算の式を、その行で解く。
 * 判定するのは Data API（唯一の権限強制点）で、結果を行の `computed` に載せる。
 * 画面は式を評価しない（`CLAUDE.md` の不変条件）。
 *
 * 宣言に無い entity は `false`（呼ぶ側が先に entity の実在を見る。成功に読み替えない）。
 */
export function holdsExpression(request: EvaluationRequest, expression: string): boolean {
  const prepared = prepareRecord(request, { visiting: new Set<string>() });
  return prepared === null ? false : holds(expression, prepared.scope);
}
