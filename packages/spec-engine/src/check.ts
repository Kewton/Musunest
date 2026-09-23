// 宣言（app.spec.yaml）の静的チェック。**実行せずに**、形・データ層・ロジック層・権限を確かめる
// （workspace/mvp/m1/03-spec-layers-and-checker.md §5）。
//
// この file は 3 つに分かれている。
//   1. YAML の読み取り（位置つき）——写像・並び・スカラと、1 行の [a, b] だけを読む
//   2. 欄ごとの検査（形・データ層・ロジック層・UI・権限）
//   3. 公開の入口 checkSpec（YAML 原文 → 型検査済みの AppSpec、または診断の配列）
//
// **ここは式を評価しない。** AST の型だけを見る。ストレージ（D1・R2・DO）にも触れない。
// 読み取りに使うのは、この file と expression.ts と diagnostics.ts だけである（unit テストが走査して確かめる）。

import {
  ACTION_KINDS,
  AGGREGATE_KINDS,
  APPSPEC_SECTIONS,
  COMPUTED_SCOPES,
  COMPUTED_TYPES,
  DATE_VALUE_PATTERN,
  FIELD_TYPES,
  IDENTITY_MODES,
  NAME_PATTERN,
  PERIODS,
  PERMISSION_NAMES,
  PERMISSION_SUBJECTS,
  RESERVED_NAMES,
  VIEW_PART_TYPES,
  VIEW_TYPES,
  enumKeys,
  expressionTypeOf,
  fieldKind,
  fieldTarget,
  isEnumField,
  type ActionKind,
  type ActionSet,
  type ActionSetValue,
  type Aggregate,
  type AggregateKind,
  type AggregateWhereCondition,
  type AppSpec,
  type Computed,
  type ComputedScope,
  type ComputedType,
  type Entity,
  type FieldDeclaration,
  type FieldKind,
  type FieldType,
  type Period,
  type View,
  type ViewPart,
  type ViewPartType,
  type ViewType,
} from "@musunest/appspec-schema";
import {
  compareDiagnostics,
  diagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticPosition,
} from "./diagnostics.js";
import {
  analyzeExpression,
  isComparisonOperator,
  parseExpression,
  positionAt,
  readExpression,
  typeName,
  type AstNode,
  type ExpressionScope,
  type SpecType,
} from "./expression.js";

/** 検査の結果。成功は型検査済みの AppSpec、失敗は診断の配列（どちらも `diagnostics` を読める） */
export type CheckResult =
  | { readonly ok: true; readonly spec: AppSpec; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type Report = (code: DiagnosticCode, message: string, position: DiagnosticPosition) => void;

// ── 1. YAML の読み取り ──────────────────────────────────────────
//
// 読む形を絞る（README「読み取れる YAML」）。**この形から外れた入力は、読み飛ばさずに断る。**
// 読めない行を黙って捨てると、書いた宣言の一部が「無かったこと」になり、検査が空振りする
// （appspec-schema の台帳の読み取りと同じ理由。src/ledger-yaml.ts）。
//
// 値はすべて**文字列**として読む。YAML がほかの型に読む値（true・数・日付）は、
// 名前や型の検査で落ちる。ここで黙って解釈しない。

type YamlNode = YamlMap | YamlSeq | YamlScalar | YamlNull;

interface YamlMap {
  readonly kind: "map";
  readonly line: number;
  readonly column: number;
  readonly entries: readonly YamlEntry[];
}

interface YamlSeq {
  readonly kind: "seq";
  readonly line: number;
  readonly column: number;
  readonly items: readonly YamlNode[];
}

interface YamlScalar {
  readonly kind: "scalar";
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** 値が書かれていない（`fields:` の直後が空、など）。位置は `key:` の後ろを指す */
interface YamlNull {
  readonly kind: "null";
  readonly line: number;
  readonly column: number;
}

interface YamlEntry {
  readonly key: string;
  readonly keyLine: number;
  readonly keyColumn: number;
  readonly value: YamlNode;
}

interface YamlLine {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
}

interface YamlFailure {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** 値の先頭に置くと、YAML の別の書き方になる文字 */
const UNSUPPORTED_START = ["&", "*", "!", "|", ">", "{", "@", "`", "%"];
/** 欄の名前の先頭に置けない文字（YAML の indicator） */
const KEY_START = /^[-?[\]{},#&*!|>'"%@`]/;

class YamlReadFailure extends Error {
  readonly failure: YamlFailure;

  constructor(line: number, column: number, message: string) {
    super(message);
    this.failure = { line, column, message };
  }
}

/** コメントを落とす。YAML では、空白の直後の `#` からがコメントになる（値の中の `#` は残る） */
function stripComment(body: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body.slice(index, index + 1);
    const previous = body.slice(index - 1, index);
    if (single) {
      if (character === "'") single = false;
      continue;
    }
    if (double) {
      if (character === "\\") index += 1;
      else if (character === '"') double = false;
      continue;
    }
    if (character === "'") single = true;
    else if (character === '"') double = true;
    else if (character === "#" && (index === 0 || previous === " " || previous === "\t")) {
      return body.slice(0, index).trimEnd();
    }
  }
  return body.trimEnd();
}

/** 原文を、検査が読む行（空行とコメント行を落とし、インデントを数えたもの）にする */
function prepareLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  let started = false;
  source.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    const indentation = /^[ \t]*/.exec(raw)?.[0] ?? "";
    if (indentation.includes("\t")) {
      throw new YamlReadFailure(number, 1, "インデントにタブは使えない（空白で下げる）");
    }
    const indent = indentation.length;
    const body = stripComment(raw.slice(indent));
    if (body === "") return;
    if (body.trim() === "---") {
      if (started) {
        throw new YamlReadFailure(number, indent + 1, "宣言は 1 つだけ書ける（`---` は先頭に 1 つだけ）");
      }
      return;
    }
    if (body.trim() === "...") {
      throw new YamlReadFailure(number, indent + 1, "`...` は読み取れない");
    }
    started = true;
    lines.push({ number, indent, text: body });
  });
  return lines;
}

const isSequenceItem = (text: string): boolean => text === "-" || text.startsWith("- ");

/** `key:` の `:` の位置を返す（引用符の中の `:` は数えない）。無ければ null */
function findKeyColon(text: string): number | null {
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.slice(index, index + 1);
    if (single) {
      if (character === "'") single = false;
      continue;
    }
    if (double) {
      if (character === "\\") index += 1;
      else if (character === '"') double = false;
      continue;
    }
    if (character === "'") single = true;
    else if (character === '"') double = true;
    else if (character === ":") {
      const following = text.slice(index + 1, index + 2);
      if (following === "" || following === " " || following === "\t") return index;
    }
  }
  return null;
}

function readScalar(text: string, line: number, column: number): YamlScalar {
  const first = text.slice(0, 1);
  if (first === '"' || first === "'") {
    if (text.length < 2 || !text.endsWith(first)) {
      throw new YamlReadFailure(line, column, "引用符が閉じていない");
    }
    const body = text.slice(1, -1);
    const escapes: Readonly<Record<string, string>> = {
      n: "\n",
      t: "\t",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    const value =
      first === "'"
        ? body.replaceAll("''", "'")
        : body.replace(/\\(.)/g, (_whole, escaped: string) => {
            const replaced = escapes[escaped];
            if (replaced === undefined) {
              throw new YamlReadFailure(line, column, `\\${escaped} は読み取れない（\\n \\t \\r \\" \\\\ だけ）`);
            }
            return replaced;
          });
    return { kind: "scalar", line, column, text: value };
  }
  if (first === "") throw new YamlReadFailure(line, column, "値が空である");
  if (UNSUPPORTED_START.includes(first)) {
    throw new YamlReadFailure(
      line,
      column,
      `${first} から始まる値は読み取れない（アンカー・別名・タグ・ブロック・\`{ }\` の写像は書けない）`,
    );
  }
  if (text.includes(": ") || text.endsWith(":")) {
    throw new YamlReadFailure(line, column, "入れ子の写像は次の行に書く（値を 1 行に重ねて書けない）");
  }
  return { kind: "scalar", line, column, text };
}

/** 1 行に書いた値（スカラ、または `[a, b]` の並び）。`text` の 0 文字目は `columnBase` 列目にある */
function readInlineValue(text: string, line: number, columnBase: number): YamlNode {
  if (!text.startsWith("[")) return readScalar(text, line, columnBase);
  const inner = text.slice(1);
  if (!inner.endsWith("]")) {
    throw new YamlReadFailure(line, columnBase, "並びは 1 行の `[a, b]` で閉じて書く");
  }
  const body = inner.slice(0, -1);
  const items: YamlNode[] = [];
  if (body.trim() !== "") {
    let cursor = 1;
    for (const part of body.split(",")) {
      const offset = text.indexOf(part, cursor);
      const item = readScalar(part.trim(), line, columnBase + offset + (part.length - part.trimStart().length));
      if (/[[\]{},]/.test(item.text)) {
        throw new YamlReadFailure(line, item.column, "並びの要素に `[ ] { } ,` は書けない");
      }
      items.push(item);
      cursor = offset + part.length;
    }
  }
  return { kind: "seq", line, column: columnBase, items };
}

/** 位置つきの YAML の読み取り。読めない形は YamlReadFailure で止める（呼ぶ側が 1 つの診断にする） */
class YamlReader {
  readonly #lines: YamlLine[];
  #index = 0;

  constructor(lines: YamlLine[]) {
    this.#lines = lines;
  }

  read(): YamlNode {
    const first = this.#lines[0];
    if (first === undefined) throw new YamlReadFailure(1, 1, "宣言が空である");
    const node = this.#readBlock(first.indent);
    const rest = this.#lines[this.#index];
    if (rest !== undefined) {
      throw new YamlReadFailure(rest.number, rest.indent + 1, "行の始まりのインデントが、宣言の先頭と揃っていない");
    }
    return node;
  }

  #readBlock(indent: number): YamlNode {
    const line = this.#lines[this.#index];
    if (line === undefined) throw new YamlReadFailure(1, 1, "値が無い");
    return isSequenceItem(line.text) ? this.#readSequence(indent) : this.#readMapping(indent);
  }

  #readSequence(indent: number): YamlNode {
    const first = this.#lines[this.#index];
    const items: YamlNode[] = [];
    for (;;) {
      const line = this.#lines[this.#index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlReadFailure(line.number, line.indent + 1, "インデントが揃っていない");
      }
      if (!isSequenceItem(line.text)) break;
      items.push(this.#readSequenceItem(line, indent));
    }
    return { kind: "seq", line: first?.number ?? 1, column: indent + 1, items };
  }

  #readSequenceItem(line: YamlLine, indent: number): YamlNode {
    const content = line.text.startsWith("- ") ? line.text.slice(2) : "";
    const contentIndent = indent + 2;
    this.#index += 1;
    if (content === "") {
      const next = this.#lines[this.#index];
      if (next !== undefined && next.indent > indent) return this.#readBlock(next.indent);
      return { kind: "null", line: line.number, column: contentIndent + 1 };
    }
    // `- name: expense` を `name: expense` の行として読み直す（インデントは `- ` の分だけ下げる）。
    // 書き直した行は**まだ読んでいない**ので、位置を 1 つ戻してから読む
    if (findKeyColon(content) === null) {
      // 並びの要素が写像でない（`- expense` など）。値として読み、断るのは欄の検査に任せる
      return readInlineValue(content, line.number, contentIndent + 1);
    }
    this.#lines[this.#index - 1] = { number: line.number, indent: contentIndent, text: content };
    this.#index -= 1;
    return this.#readBlock(contentIndent);
  }

  #readMapping(indent: number): YamlNode {
    const first = this.#lines[this.#index];
    const entries: YamlEntry[] = [];
    for (;;) {
      const line = this.#lines[this.#index];
      if (line === undefined || line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlReadFailure(line.number, line.indent + 1, "インデントが揃っていない");
      }
      if (isSequenceItem(line.text)) {
        throw new YamlReadFailure(line.number, indent + 1, "写像の中に並びの `-` が来ている");
      }
      const colon = findKeyColon(line.text);
      if (colon === null) {
        throw new YamlReadFailure(line.number, indent + 1, "欄の形ではない（`欄: 値` で書く）");
      }
      const key = line.text.slice(0, colon).trim();
      // 欄の名前の**書式**はここで見ない（`2amount` のような名前は、名前の検査が
      // SHAPE_NAME_INVALID として断る。読み取りの誤りにすると、理由が伝わらない）
      if (key === "" || KEY_START.test(key)) {
        throw new YamlReadFailure(line.number, indent + 1, "欄の名前が読めない（`欄: 値` で書く）");
      }
      const afterColon = line.text.slice(colon + 1);
      const valueOffset = colon + 1 + (afterColon.length - afterColon.trimStart().length);
      const valueText = afterColon.trim();
      this.#index += 1;
      const value =
        valueText === ""
          ? this.#readNestedOrNull(line, indent, valueOffset)
          : readInlineValue(valueText, line.number, line.indent + valueOffset + 1);
      entries.push({ key, keyLine: line.number, keyColumn: indent + 1, value });
    }
    if (entries.length === 0) throw new YamlReadFailure(first?.number ?? 1, indent + 1, "値が無い");
    return { kind: "map", line: first?.number ?? 1, column: indent + 1, entries };
  }

  #readNestedOrNull(line: YamlLine, indent: number, valueOffset: number): YamlNode {
    const next = this.#lines[this.#index];
    if (next !== undefined && next.indent > indent) return this.#readBlock(next.indent);
    return { kind: "null", line: line.number, column: line.indent + valueOffset + 1 };
  }
}

/** YAML の原文を読む。読めなければ failure（呼ぶ側が 1 つの診断にする） */
function readYaml(source: string): { node: YamlNode | null; failure: YamlFailure | null } {
  try {
    return { node: new YamlReader(prepareLines(source)).read(), failure: null };
  } catch (thrown) {
    if (thrown instanceof YamlReadFailure) return { node: null, failure: thrown.failure };
    // 読み取りの不具合で外へ例外を出さない
    return { node: null, failure: { line: 1, column: 1, message: `YAML を読めなかった: ${String(thrown)}` } };
  }
}

// ── 2. 欄ごとの検査 ────────────────────────────────────────────

interface NamedDraft {
  readonly name: string;
  readonly nameNode: YamlNode | null;
}

interface EntityDraft extends NamedDraft {
  readonly fields: readonly FieldDraft[];
  readonly node: YamlNode;
}

interface FieldDraft {
  readonly name: string;
  /** 読めた宣言。読めなかったときは `null`（診断は既に出ている） */
  readonly declaration: FieldDeclaration | null;
  readonly node: YamlNode;
  /** 参照先の entity の名前（`ref`・`list of`）。参照でなければ `null` */
  readonly target: string | null;
  /** 参照先を書いた位置。診断の位置に使う */
  readonly targetNode: YamlNode | null;
}

interface EntityReferenceDraft extends NamedDraft {
  readonly entity: string;
  readonly entityNode: YamlNode;
}

interface ExpressionDraft extends EntityReferenceDraft {
  readonly expression: string;
  readonly expressionNode: YamlNode;
}

interface ValidationDraft extends ExpressionDraft {
  /** 保存できない理由の文言（M1.2）。書いていなければ `null` */
  readonly message: string | null;
}

/** 集計の `where` の 1 つの条件（集計元の項目と、比べ方） */
interface AggregateWhereDraft {
  readonly field: string;
  readonly fieldNode: YamlNode;
  /** 正規化後の比べ方（M1.2・M1.4）。`within` のときは期間の名前を持つ */
  readonly condition: AggregateWhereCondition;
}

/**
 * 見出しごとの集計（`groupBy`。M1.4。Issue #179）の、分ける対象。**実在と型は、entity を読んだ
 * あとで見る**（`LOGIC_AGGREGATE_TARGET_NOT_FOUND`・`LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE`）。
 */
interface AggregateGroupDraft {
  readonly entity: string;
  readonly entityNode: YamlNode;
  readonly field: string;
  readonly fieldNode: YamlNode;
  /** `true` なら `date` の項目を月でまとめる（`false` なら `enum` の項目の値ごと） */
  readonly month: boolean;
}

/** computed の集計（M1.2・M1.4）。読み取った形で、意味の検査は組み立てのあとに行う */
interface AggregateDraft {
  readonly kind: AggregateKind;
  /** 集計元の entity の名前（`sum`・`avg` の `entity.name` の左、`count` の値） */
  readonly entity: string;
  readonly entityNode: YamlNode;
  /** `sum`・`avg` の対象の名前。`count` では `null` */
  readonly name: string | null;
  readonly nameNode: YamlNode | null;
  readonly where: readonly AggregateWhereDraft[];
  /** 見出しごとに分ける対象（M1.4。Issue #179）。書いていなければ `null`（従来どおり 1 つの値） */
  readonly groupBy: AggregateGroupDraft | null;
  /** 見出しの数の上限（月で分けるときだけ。M1.4）。書いていなければ `null`（既定は 6） */
  readonly last: number | null;
}

/** 循環を組み立てるための、計算への参照（同じ entity の式か、集計の対象の計算） */
interface ComputedRef {
  readonly entity: string;
  readonly name: string;
}

/**
 * 精算（`settle`。M1.2）の宣言。**支出の entity と、そのうちの 3 つの項目**を指す。
 * 実在と型は、すべての entity を読んだあとで見る（`LOGIC_ENTITY_NOT_FOUND`・
 * `LOGIC_SETTLE_AMOUNT_NOT_NUMBER`・`LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH`）。
 */
interface SettleDraft {
  readonly expense: string;
  readonly expenseNode: YamlNode;
  readonly amount: string;
  readonly amountNode: YamlNode;
  readonly payer: string;
  readonly payerNode: YamlNode;
  readonly shares: string;
  readonly sharesNode: YamlNode;
}

interface ComputedDraft extends ExpressionDraft {
  readonly type: string;
  /** 表示名（`label`。M1.3。Issue #176）。無ければ `null`（画面は識別子をそのまま出す） */
  readonly label: string | null;
  /**
   * 計算の範囲（M1.4。Issue #177）。`app` ならアプリ全体で 1 つの値である。
   * **`null` なら従来どおり、`entity` の行ごとの値**である。
   */
  readonly scope: ComputedScope | null;
  /** 集計（`aggregate`。M1.2）。式でも精算でもなければ `null` */
  readonly aggregate: AggregateDraft | null;
  /** 精算（`settle`。M1.2）。式でも集計でもなければ `null` */
  readonly settle: SettleDraft | null;
  /** 読み取りの時点で断った（式・集計・精算の重複や不足、など）。意味の検査を重ねない */
  readonly malformed: boolean;
  /** 依存する計算（循環の検査に使う）。式の参照と、集計の対象の計算を入れる */
  dependencies: ComputedRef[];
}

interface PermissionDraft {
  readonly name: string;
  readonly node: YamlNode;
  readonly subject: string;
  readonly subjectNode: YamlNode;
}

const isOneOf = (values: readonly string[], value: string): boolean => values.includes(value);
const positionOf = (node: { line: number; column: number }): DiagnosticPosition => ({
  line: node.line,
  column: node.column,
});

const entryOf = (map: YamlMap, key: string): YamlEntry | undefined =>
  map.entries.find((entry) => entry.key === key);

const entriesOf = (map: YamlMap, key: string): readonly YamlEntry[] =>
  map.entries.filter((entry) => entry.key === key);

/** 同じ写像の中で同じ欄が 2 回書かれていないか（2 回目からを断る） */
function reportDuplicateKeys(map: YamlMap, what: string, report: Report): void {
  const seen = new Set<string>();
  for (const entry of map.entries) {
    if (seen.has(entry.key)) {
      report("SHAPE_KEY_DUPLICATE", `${what}に欄 ${entry.key} が 2 回ある`, {
        line: entry.keyLine,
        column: entry.keyColumn,
      });
    }
    seen.add(entry.key);
  }
}

/** 宣言の並びの 1 つ（写像）を、決まった欄だけを持つものとして読む */
class MemberReader {
  readonly map: YamlMap;
  readonly #what: string;
  readonly #report: Report;

  constructor(map: YamlMap, what: string, report: Report) {
    this.map = map;
    this.#what = what;
    this.#report = report;
    reportDuplicateKeys(map, what, report);
  }

  /** 知らない欄を断る（語彙は閉じている。README「診断の一覧」） */
  only(keys: readonly string[]): void {
    for (const entry of this.map.entries) {
      if (!keys.includes(entry.key)) {
        this.#report("SHAPE_KEY_UNKNOWN", `${this.#what}に欄 ${entry.key} は書けない（M1.1 の語彙に無い）`, {
          line: entry.keyLine,
          column: entry.keyColumn,
        });
      }
    }
  }

  /** 必須の、空でない文字列の値 */
  text(key: string): { text: string; node: YamlNode } | null {
    const entry = entryOf(this.map, key);
    if (entry === undefined) {
      this.#report("SHAPE_KEY_MISSING", `${this.#what}に ${key} が無い`, positionOf(this.map));
      return null;
    }
    if (entry.value.kind !== "scalar" || entry.value.text === "") {
      this.#report("SHAPE_VALUE_INVALID", `${this.#what}の ${key} は空でない文字列で書く`, positionOf(entry.value));
      return null;
    }
    return { text: entry.value.text, node: entry.value };
  }

  /** 必須の写像の値（`fields:` など） */
  mapValue(key: string): YamlMap | null {
    const entry = entryOf(this.map, key);
    if (entry === undefined) {
      this.#report("SHAPE_KEY_MISSING", `${this.#what}に ${key} が無い`, positionOf(this.map));
      return null;
    }
    if (entry.value.kind !== "map") {
      this.#report(
        "SHAPE_VALUE_INVALID",
        `${this.#what}の ${key} は「名前: 値」を並べた写像で書く`,
        positionOf(entry.value),
      );
      return null;
    }
    return entry.value;
  }
}

/** 並びの要素を、決まった欄だけを持つ写像として読む */
function readMembers(
  items: readonly YamlNode[],
  section: string,
  keys: readonly string[],
  report: Report,
): readonly MemberReader[] {
  const members: MemberReader[] = [];
  items.forEach((item, index) => {
    if (item.kind !== "map") {
      report("SHAPE_VALUE_INVALID", `${section} の ${index + 1} 番目は「欄: 値」を並べた写像で書く`, positionOf(item));
      return;
    }
    const member = new MemberReader(item, `${section}[${index + 1}]`, report);
    member.only(keys);
    members.push(member);
  });
  return members;
}

/** 名前の書式を見る（重複や参照の診断は呼ぶ側） */
function checkName(name: string, what: string, position: DiagnosticPosition, report: Report): void {
  if (NAME_PATTERN.test(name)) return;
  report(
    "SHAPE_NAME_INVALID",
    `${what}の名前 ${name} は、英字で始まる英数字で書く（式の中で名前として読むため）`,
    position,
  );
}

/** 名前の重複を断る。空の名前は形の検査が受け持つので数えない */
function checkDuplicates(
  names: readonly NamedDraft[],
  code: DiagnosticCode,
  what: string,
  report: Report,
): void {
  const seen = new Set<string>();
  for (const { name, nameNode } of names) {
    if (name === "") continue;
    if (seen.has(name)) {
      report(code, `${what}の名前 ${name} が 2 回ある`, positionOf(nameNode ?? { line: 0, column: 0 }));
    }
    seen.add(name);
  }
}

/** 欄（並び）を、宣言に書かれた順に集める。欄そのものの形も見る */
function collectItems(root: YamlMap, section: string, report: Report): readonly YamlNode[] {
  const items: YamlNode[] = [];
  for (const entry of entriesOf(root, section)) {
    if (entry.value.kind === "seq") {
      items.push(...entry.value.items);
    } else if (entry.value.kind === "null") {
      report("SHAPE_VALUE_INVALID", `欄 ${section} が空である（中身が無ければ [] と書く）`, positionOf(entry.value));
    } else {
      report("SHAPE_VALUE_INVALID", `欄 ${section} は並びで書く（中身が無ければ []）`, positionOf(entry.value));
    }
  }
  return items;
}

/** 参照の写像（`{type: ref, to: member}`・`{type: list, of: member}`）に書ける欄。`label` は M1.3 */
const REF_DECLARATION_KEYS = ["type", "to", "of", "label"] as const;

/** 選択肢の写像（`{type: enum, options: {...}, default: ..., label: ...}`）に書ける欄（M1.3） */
const ENUM_DECLARATION_KEYS = ["type", "options", "default", "label"] as const;

/**
 * 表示名（`label`。M1.3。Issue #176）を読む。**空でない文字列**でなければならない。
 * 書いていなければ `null`。読めなかったときは `invalid` を立てる（意味の検査を重ねない）。
 *
 *   `label:`（値が無い）・空文字 → `SHAPE_LABEL_EMPTY`
 *   並び・写像                      → `SHAPE_LABEL_INVALID`
 */
function readLabel(
  value: YamlMap,
  what: string,
  report: Report,
): { readonly label: string | null; readonly invalid: boolean } {
  const entry = entryOf(value, "label");
  if (entry === undefined) return { label: null, invalid: false };
  const node = entry.value;
  if (node.kind === "null" || (node.kind === "scalar" && node.text === "")) {
    report("SHAPE_LABEL_EMPTY", `${what} の label は空でない文字列で書く（空文字は表示名にならない）`, positionOf(node));
    return { label: null, invalid: true };
  }
  if (node.kind !== "scalar") {
    report("SHAPE_LABEL_INVALID", `${what} の label は文字列で書く（並びや写像では書けない）`, positionOf(node));
    return { label: null, invalid: true };
  }
  return { label: node.text, invalid: false };
}

/** 読み取った宣言に、表示名（`label`）を重ねる。1 語の型は写像の形にする */
function withLabel(declaration: FieldDeclaration, label: string | null): FieldDeclaration {
  if (label === null) return declaration;
  return typeof declaration === "string" ? { type: declaration, label } : { ...declaration, label };
}

/**
 * 項目の宣言を読む。**文字列の 1 語（`string`・`number`・`list`）と、写像（参照・選択肢）の両方**を
 * 受け取る（#106・#154）。参照先の entity が実在するかは、すべての entity を読んだあとで見る
 * （`DATA_REF_TARGET_NOT_FOUND`）。
 */
function readFieldDeclaration(
  name: string,
  value: YamlNode,
  report: Report,
): { declaration: FieldDeclaration | null; target: string | null; targetNode: YamlNode | null } {
  const unknownType = (
    type: string,
    at: YamlNode,
  ): { declaration: null; target: null; targetNode: null } => {
    report(
      "DATA_FIELD_TYPE_UNKNOWN",
      `項目 ${name} の型 ${type} は M1 の型（${FIELD_TYPES.join("・")}・ref）に無い`,
      positionOf(at),
    );
    return { declaration: null, target: null, targetNode: null };
  };
  if (value.kind === "scalar") {
    if (isOneOf(FIELD_TYPES, value.text)) {
      return { declaration: value.text as FieldType, target: null, targetNode: null };
    }
    // `enum` は型の名前だが 1 語では書けない——`options` と `default` を並べた写像で書く（M1.3）
    if (value.text === "enum") {
      report(
        "SHAPE_VALUE_INVALID",
        `項目 ${name} の enum は 1 語で書けない（type: enum と、options と default を並べた写像で書く）`,
        positionOf(value),
      );
      return { declaration: null, target: null, targetNode: null };
    }
    return unknownType(value.text, value);
  }
  if (value.kind !== "map") {
    report("SHAPE_VALUE_INVALID", `項目 ${name} の型は型の名前か、参照の写像で書く`, positionOf(value));
    return { declaration: null, target: null, targetNode: null };
  }

  for (const entry of value.entries) {
    // 書ける欄は `type` が決める（語彙は閉じている）。`enum` は options と default を持つ（M1.3）
    const writtenType = entryOf(value, "type")?.value;
    const isEnum = writtenType?.kind === "scalar" && writtenType.text === "enum";
    if (!isOneOf(isEnum ? ENUM_DECLARATION_KEYS : REF_DECLARATION_KEYS, entry.key)) {
      report(
        "SHAPE_KEY_UNKNOWN",
        isEnum
          ? `項目 ${name} の enum に欄 ${entry.key} は書けない（type と options と default だけ）`
          : `項目 ${name} の参照に欄 ${entry.key} は書けない（type と to / of だけ）`,
        { line: entry.keyLine, column: entry.keyColumn },
      );
    }
  }

  const typeEntry = entryOf(value, "type");
  if (typeEntry === undefined) {
    report("SHAPE_KEY_MISSING", `項目 ${name} の参照に type が無い`, positionOf(value));
    return { declaration: null, target: null, targetNode: null };
  }
  if (typeEntry.value.kind !== "scalar" || typeEntry.value.text === "") {
    report("SHAPE_VALUE_INVALID", `項目 ${name} の type は型の名前で書く`, positionOf(typeEntry.value));
    return { declaration: null, target: null, targetNode: null };
  }
  const type = typeEntry.value.text;

  // 選択肢（`type: enum`。M1.3）は、参照とは別の読み取りである（options と default、label を持つ）
  if (type === "enum") return readEnumFieldDeclaration(name, value, report);

  // **知らない型は、ここで断る**（`label` の検査を重ねない。1 つの誤りを 2 つのコードにしない）
  const isRef = type === "ref";
  const isList = type === "list";
  if (!isRef && !isList && !isOneOf(FIELD_TYPES, type)) return unknownType(type, typeEntry.value);

  const nothing = { declaration: null, target: null, targetNode: null } as const;

  // 表示名（`label`。M1.3）。書いてあれば写像の形にして重ねる
  const label = readLabel(value, `項目 ${name}`, report);
  if (label.invalid) return nothing;

  // 参照先の欄は、`ref` なら `to`、`list` なら `of` である。もう一方が書いてあれば断る
  const targetKey = isRef ? "to" : isList ? "of" : null;
  for (const key of ["to", "of"] as const) {
    const stray = entryOf(value, key);
    if (stray !== undefined && key !== targetKey) {
      report("SHAPE_KEY_UNKNOWN", `項目 ${name} の ${type} に ${key} は書けない`, {
        line: stray.keyLine,
        column: stray.keyColumn,
      });
    }
  }

  const targetEntry = targetKey === null ? undefined : entryOf(value, targetKey);
  if (targetEntry === undefined) {
    // `of` の無い `{type: list}` は、文字列の並び（既存の `list`）として読む
    if (isList) return { declaration: withLabel("list", label.label), target: null, targetNode: null };
    if (isRef) {
      report("SHAPE_KEY_MISSING", `項目 ${name} の ref に to が無い（参照先の entity を書く）`, positionOf(value));
      return nothing;
    }
    return { declaration: withLabel(type as FieldType, label.label), target: null, targetNode: null };
  }
  if (targetEntry.value.kind !== "scalar" || targetEntry.value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      `項目 ${name} の ${targetKey} は、参照先の entity の名前で書く`,
      positionOf(targetEntry.value),
    );
    return nothing;
  }
  const target = targetEntry.value.text;
  return {
    declaration: withLabel(isRef ? { type: "ref", to: target } : { type: "list", of: target }, label.label),
    target,
    targetNode: targetEntry.value,
  };
}

/**
 * 選択肢の項目（`type: enum`。M1.3）を読む。**キー（保存される値）と表示名の対**（`options`）と、
 * 未入力のときに入れるキー（`default`）を読む。
 *
 * 落とすのは 3 つである（docs/semantics.md「enum」「default」）。
 *   - `options` が空 → `DATA_FIELD_ENUM_OPTIONS_EMPTY`
 *   - `options` のキーが重複 → `DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE`
 *     （**写像の重複キーを読む汎用の `SHAPE_KEY_DUPLICATE` とは別のコードにする**。保存される値が
 *     重なることは、欄の書き方の誤りではなく、宣言の意味の誤りである）
 *   - `default` が `options` のキーに無い → `DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS`
 *
 * `options` を読めなかったときは、`default` の照合を重ねない（誤りを 2 つ出さない）。
 */
function readEnumFieldDeclaration(
  name: string,
  value: YamlMap,
  report: Report,
): { declaration: FieldDeclaration | null; target: null; targetNode: null } {
  const nothing = { declaration: null, target: null, targetNode: null } as const;
  // 表示名（`label`。M1.3）も、選択肢の写像に書ける欄である。読めなければ組み立てない
  const label = readLabel(value, `項目 ${name}`, report);
  const optionsEntry = entryOf(value, "options");
  if (optionsEntry === undefined) {
    report(
      "SHAPE_KEY_MISSING",
      `項目 ${name} の enum に options が無い（保存される値と表示名の対を書く）`,
      positionOf(value),
    );
    return nothing;
  }

  const optionsNode = optionsEntry.value;
  if (optionsNode.kind !== "map") {
    // `options:` の直後が空（null）か、空の並び（`[]`）は「1 つも無い」である
    const empty =
      optionsNode.kind === "null" || (optionsNode.kind === "seq" && optionsNode.items.length === 0);
    if (empty) {
      report(
        "DATA_FIELD_ENUM_OPTIONS_EMPTY",
        `項目 ${name} の enum の options が空である（キーを 1 つ以上書く）`,
        positionOf(optionsNode),
      );
      return nothing;
    }
    report(
      "SHAPE_VALUE_INVALID",
      `項目 ${name} の enum の options は「キー: 表示名」を並べた写像で書く`,
      positionOf(optionsNode),
    );
    return nothing;
  }

  const options: Record<string, string> = {};
  const keys: string[] = [];
  for (const entry of optionsNode.entries) {
    if (entry.value.kind !== "scalar" || entry.value.text === "") {
      report(
        "SHAPE_VALUE_INVALID",
        `項目 ${name} の enum の options の ${entry.key} の表示名は、空でない文字列で書く`,
        positionOf(entry.value),
      );
      continue;
    }
    if (Object.hasOwn(options, entry.key)) {
      report(
        "DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE",
        `項目 ${name} の enum の options のキー ${entry.key} が 2 回ある（保存される値は重複させない）`,
        { line: entry.keyLine, column: entry.keyColumn },
      );
      continue;
    }
    options[entry.key] = entry.value.text;
    keys.push(entry.key);
  }
  if (keys.length === 0) {
    // 表示名がすべて読めなかった（`SHAPE_VALUE_INVALID` を既に出している）。誤りを重ねない
    return nothing;
  }

  const defaultEntry = entryOf(value, "default");
  let fallback: string | null = null;
  if (defaultEntry !== undefined) {
    if (defaultEntry.value.kind !== "scalar" || defaultEntry.value.text === "") {
      report(
        "SHAPE_VALUE_INVALID",
        `項目 ${name} の enum の default は、options のキーで書く`,
        positionOf(defaultEntry.value),
      );
    } else if (!Object.hasOwn(options, defaultEntry.value.text)) {
      report(
        "DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS",
        `項目 ${name} の enum の default ${defaultEntry.value.text} は、options のキーに無い（${keys.join("・")}）`,
        positionOf(defaultEntry.value),
      );
    } else {
      fallback = defaultEntry.value.text;
    }
  }

  if (label.invalid) return nothing;
  return {
    declaration: withLabel(
      { type: "enum", options, ...(fallback === null ? {} : { default: fallback }) },
      label.label,
    ),
    target: null,
    targetNode: null,
  };
}

function readEntities(items: readonly YamlNode[], report: Report): readonly EntityDraft[] {
  const entities: EntityDraft[] = [];
  for (const member of readMembers(items, "entities", ["name", "fields"], report)) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, "entity", positionOf(name.node), report);
    const fields: FieldDraft[] = [];
    const fieldsMap = member.mapValue("fields");
    if (fieldsMap !== null) {
      const seen = new Set<string>();
      for (const entry of fieldsMap.entries) {
        checkName(entry.key, "項目", { line: entry.keyLine, column: entry.keyColumn }, report);
        if (isOneOf(RESERVED_NAMES, entry.key)) {
          report(
            "DATA_FIELD_NAME_RESERVED",
            `項目の名前 ${entry.key} は店頭が付ける値の名前である（区別が付かなくなる）`,
            { line: entry.keyLine, column: entry.keyColumn },
          );
        }
        if (seen.has(entry.key)) {
          report("DATA_FIELD_DUPLICATE_NAME", `項目の名前 ${entry.key} が 2 回ある`, {
            line: entry.keyLine,
            column: entry.keyColumn,
          });
        }
        seen.add(entry.key);
        const read = readFieldDeclaration(entry.key, entry.value, report);
        fields.push({ name: entry.key, node: entry.value, ...read });
      }
    }
    entities.push({ name: name?.text ?? "", nameNode: name?.node ?? null, fields, node: member.map });
  }
  checkDuplicates(entities, "DATA_ENTITY_DUPLICATE_NAME", "entity", report);
  return entities;
}

/** 決まった値への書き換え（`set`）の 1 つ（M1.3）。値の型と定数かどうかは、entity を読んだあとで見る */
interface ActionSetDraft {
  readonly field: string;
  readonly fieldNode: YamlNode;
  /** 書かれた値の字面（YAML はすべて文字列として読む。型に合わせて読み直すのは意味の検査） */
  readonly text: string;
  readonly node: YamlNode;
}

/**
 * 操作（`actions`）。M1.2 で種類 `kind` を、M1.3 で `set`（決まった値への書き換え）と
 * `when`（その行で操作してよい条件）を足した。**書ける欄は `kind` が決める**（語彙は閉じている）。
 */
interface ActionDraft extends EntityReferenceDraft {
  /** 操作の種類（M1.2）。書いていなければ `null`（＝ `create`。M1.1 の宣言の意味を変えない） */
  readonly kind: ActionKind | null;
  /** 決まった値への書き換え（M1.3）。書いていなければ `null` */
  readonly set: readonly ActionSetDraft[] | null;
  /** その行で操作してよい条件（M1.3）。書いていなければ `null` */
  readonly when: string | null;
  readonly whenNode: YamlNode | null;
}

/**
 * 操作の種類（`kind`。M1.2）を読む。**語彙は閉じている**——書けるのは `create`・`update`・`delete`
 * だけで、ほかの語は `LOGIC_ACTION_KIND_NOT_ALLOWED` である。省略は `null`（＝ `create`）にする。
 */
function readActionKind(member: MemberReader, report: Report): ActionKind | null {
  const entry = entryOf(member.map, "kind");
  if (entry === undefined) return null;
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      `action の kind は種類の名前（${ACTION_KINDS.join("・")}）で書く`,
      positionOf(entry.value),
    );
    return null;
  }
  const written = entry.value.text;
  if (!isOneOf(ACTION_KINDS, written)) {
    report(
      "LOGIC_ACTION_KIND_NOT_ALLOWED",
      `action の kind ${written} は書けない（M1.2 の操作の種類は ${ACTION_KINDS.join("・")} である）`,
      positionOf(entry.value),
    );
    return null;
  }
  return written as ActionKind;
}

/**
 * 操作に書ける欄（M1.3）。**`kind` が決める**（一覧の `show` と同じ考え方。語彙は閉じている）。
 *   `update` … 決まった値への書き換え（`set`）と、その行で操作してよい条件（`when`）
 *   `delete` … `when` だけ（書き換える値が無い）
 *   `create`（省略を含む）… どちらも書けない（対象の行が無いので、行ごとの条件も書き換えも無い）
 */
function actionKeys(kind: ActionKind | null): readonly string[] {
  const base = ["name", "entity", "kind"];
  if (kind === "update") return [...base, "set", "when"];
  if (kind === "delete") return [...base, "when"];
  return base;
}

/**
 * 決まった値への書き換え（`set`。M1.3）を読む。「項目名: 決まった値」を並べた写像である。
 * **値が型に合うか・定数かは、entity を読んだあとで見る**（`checkActions`）。
 */
function readActionSet(member: MemberReader, report: Report): readonly ActionSetDraft[] | null {
  const entry = entryOf(member.map, "set");
  if (entry === undefined) return null;
  if (entry.value.kind !== "map") {
    report(
      "SHAPE_VALUE_INVALID",
      "action の set は「項目: 決まった値」を並べた写像で書く",
      positionOf(entry.value),
    );
    return null;
  }
  reportDuplicateKeys(entry.value, "action の set", report);
  const values: ActionSetDraft[] = [];
  for (const assignment of entry.value.entries) {
    if (assignment.value.kind !== "scalar" || assignment.value.text === "") {
      report(
        "SHAPE_VALUE_INVALID",
        `action の set の ${assignment.key} は、空でない決まった値で書く`,
        positionOf(assignment.value),
      );
      continue;
    }
    values.push({
      field: assignment.key,
      fieldNode: {
        kind: "scalar",
        line: assignment.keyLine,
        column: assignment.keyColumn,
        text: assignment.key,
      },
      text: assignment.value.text,
      node: assignment.value,
    });
  }
  return values.length === 0 ? null : values;
}

/** その行で操作してよい条件（`when`。M1.3）を読む。真偽になるかは、entity を読んだあとで見る */
function readActionWhen(
  member: MemberReader,
  report: Report,
): { readonly text: string; readonly node: YamlNode } | null {
  const entry = entryOf(member.map, "when");
  if (entry === undefined) return null;
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      "action の when は、空でない真偽の式で書く",
      positionOf(entry.value),
    );
    return null;
  }
  return { text: entry.value.text, node: entry.value };
}

/**
 * 操作（`actions`）を読む。**書ける欄は `kind` が決める**ので、`kind` を先に読んでから
 * 知らない欄を断る（`readViews` と同じ形である）。entity の実在はここでは見ない。
 */
function readActions(items: readonly YamlNode[], report: Report): readonly ActionDraft[] {
  const actions: ActionDraft[] = [];
  items.forEach((item, index) => {
    if (item.kind !== "map") {
      report("SHAPE_VALUE_INVALID", `actions の ${index + 1} 番目は「欄: 値」を並べた写像で書く`, positionOf(item));
      return;
    }
    const member = new MemberReader(item, `actions[${index + 1}]`, report);
    const kind = readActionKind(member, report);
    member.only(actionKeys(kind));

    const name = member.text("name");
    if (name !== null) checkName(name.text, "actions", positionOf(name.node), report);
    const entity = member.text("entity");
    const when = kind === null || kind === "create" ? null : readActionWhen(member, report);
    actions.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
      kind,
      set: kind === "update" ? readActionSet(member, report) : null,
      when: when?.text ?? null,
      whenNode: when?.node ?? null,
    });
  });
  return actions;
}

/** 表（`type: table`）と一覧（`type: list`）の `show` / `filters` の 1 つ。実在を見るのは、entity と計算を読んだあと */
interface ShowFieldDraft {
  readonly name: string;
  readonly node: YamlNode;
}

/**
 * ダッシュボード（`type: dashboard`）の部品（`widgets` の 1 つ。M1.4。Issue #180・#181・#182）。
 * 数値（`number`）・棒（`bar`）・円（`pie`）と、順位（`ranking`）の部品を、1 つの形で持つ
 * （**書ける欄は種類で決める**）。**実在と種類は、entity と計算を読んだあとで見る**
 * （`checkDashboardWidgets`）。
 */
interface ViewPartDraft {
  /** 部品の種類。読めなかった（`type` が無い・知らない語）ときは `null`（`malformed` が立つ） */
  readonly kind: ViewPartType | null;
  /** 表示名（`label`）。無ければ `null`（画面は識別子をそのまま出す） */
  readonly label: string | null;
  /** 読み取りの時点で断った（必須の欄が無い・空、など）。意味の検査を重ねない（1 つの誤りを 2 つに数えない） */
  readonly malformed: boolean;
  // ── `value` で計算を指す部品（数値 `number`・棒 `bar`・円 `pie`。M1.4。Issue #180・#181） ──
  /** 指す計算の名前（数値はアプリ全体の集計、棒と円は見出しごとの集計） */
  readonly value: string;
  readonly valueNode: YamlNode;
  /** 単位（`unit`）。無ければ `null`（画面は数をそのまま見せる） */
  readonly unit: string | null;
  // ── 順位の部品（`type: ranking`。M1.4。Issue #182） ────────────
  /** 鍵（`name`）。1 つの一覧の `widgets` の中で重複しない */
  readonly name: string;
  readonly nameNode: YamlNode | null;
  /** 並べる相手の entity の名前 */
  readonly entity: string;
  readonly entityNode: YamlNode | null;
  /** 並べ替えの基準になる、行ごとの数の計算の名前 */
  readonly by: string;
  readonly byNode: YamlNode | null;
  /** 出す項目（宣言の順）。`show` を書いていなければ `null` */
  readonly show: readonly ShowFieldDraft[] | null;
  /** 件数の上限（1 以上）。書いていなければ `null`（既定は `RANKING_LIMIT_DEFAULT`） */
  readonly limit: number | null;
}

/** 位置を持たない値の代わり（読めなかった欄の位置に使う） */
const NO_NODE: YamlNode = { kind: "null", line: 0, column: 0 };

/**
 * `value` で計算を指す部品（数値 `number`・棒 `bar`・円 `pie`）に書ける欄。
 * **3 つとも同じである**——指す計算の種類（アプリ全体の集計か、見出しごとの集計か）だけが違う
 */
const VALUE_PART_KEYS = ["type", "value", "label", "unit"] as const;

/** 順位の部品（`type: ranking`）に書ける欄（M1.4。Issue #182）。**`name` は鍵なので必須である** */
const RANKING_PART_KEYS = ["type", "name", "label", "entity", "by", "show", "limit"] as const;

/** 一覧（`views`）。M1.2 で `type`（種類）と `show`（表に出す名前の順）、M1.3 でボードの `columns`・`highlight` と、一覧の `filters` を、M1.4 でダッシュボードの `widgets` を足した */
interface ViewDraft extends NamedDraft {
  /** 並べる行の entity。**ダッシュボード（`type: dashboard`）は持たない**ので `null`（M1.4） */
  readonly entity: string | null;
  readonly entityNode: YamlNode | null;
  /** 一覧の種類。書いていなければ `null`（種類の指定の無い一覧。M1.1 と同じ） */
  readonly type: ViewType | null;
  /** 表に出す名前（宣言の順）。`show` を書いていなければ `null` */
  readonly show: readonly ShowFieldDraft[] | null;
  /** ボードの列にする選択肢（`enum`）の項目の名前。`columns` を書いていなければ `null`（M1.3） */
  readonly columns: ShowFieldDraft | null;
  /** ボードで強調する行を選ぶ計算の名前。`highlight` を書いていなければ `null`（M1.3） */
  readonly highlight: ShowFieldDraft | null;
  /** 画面で絞り込む項目の名前（宣言の順）。`filters` を書いていなければ `null`（M1.3） */
  readonly filters: readonly ShowFieldDraft[] | null;
  /** ダッシュボードに並べる部品（宣言の順）。`widgets` を書いていなければ `null`（M1.4。Issue #180） */
  readonly widgets: readonly ViewPartDraft[] | null;
}

/**
 * 一覧の `type` を読む（M1.2・M1.3）。**語彙は閉じている**——書けるのは表（`table`）と精算の表示
 * （`settlement`）とボード（`board`）だけで、知らない種類は `SHAPE_KEY_UNKNOWN` である（`04` §7.3・§7.7）。
 */
function readViewType(member: MemberReader, report: Report): ViewType | null {
  const entry = entryOf(member.map, "type");
  if (entry === undefined) return null;
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      `view の type は種類の名前（${VIEW_TYPES.join("・")}）で書く`,
      positionOf(entry.value),
    );
    return null;
  }
  const written = entry.value.text;
  if (!isOneOf(VIEW_TYPES, written)) {
    report(
      "SHAPE_KEY_UNKNOWN",
      `view の type ${written} は書けない（M1.2 の一覧の種類は ${VIEW_TYPES.join("・")} である）`,
      positionOf(entry.value),
    );
    return null;
  }
  return written as ViewType;
}

/**
 * 一覧の、名前を並べる欄（表と一覧の `show`、一覧の `filters`。M1.3）を読む。
 * **実在と種類は、entity と計算を読んだあとで見る**（`UI_FIELD_NOT_FOUND`・
 * `UI_FILTER_FIELD_NOT_SHOWN`・`UI_FILTER_FIELD_NOT_FILTERABLE`）。
 */
function readViewNames(
  member: MemberReader,
  key: "show" | "filters",
  report: Report,
  /** 診断の文言の主語（`view` か `view の widgets[1]`）。順位の部品の `show` でも使う（M1.4。Issue #182） */
  subject = "view",
  /** 欄そのものが無いことを断るか（順位の部品の `show` は必須である。M1.4。Issue #182） */
  required = false,
): readonly ShowFieldDraft[] | null {
  const entry = entryOf(member.map, key);
  if (entry === undefined) {
    if (required) {
      report("SHAPE_KEY_MISSING", `${subject} に ${key} が無い（出す項目を 1 つ以上書く）`, positionOf(member.map));
    }
    return null;
  }
  if (entry.value.kind !== "seq") {
    report(
      "SHAPE_VALUE_INVALID",
      key === "show"
        ? `${subject} の show は、出す名前を並べた [a, b] で書く`
        : `${subject} の filters は、絞り込む項目の名前を並べた [a, b] で書く`,
      positionOf(entry.value),
    );
    return null;
  }
  const fields: ShowFieldDraft[] = [];
  for (const item of entry.value.items) {
    if (item.kind !== "scalar" || item.text === "") {
      report(
        "SHAPE_VALUE_INVALID",
        key === "show"
          ? `${subject} の show には、項目か計算の名前を書く`
          : `${subject} の filters には、項目の名前を書く`,
        positionOf(item),
      );
      continue;
    }
    fields.push({ name: item.text, node: item });
  }
  return fields;
}

/**
 * 一覧の、名前を 1 つ取る欄（ボードの `columns`・`highlight`。M1.3）を読む。
 * **実在と種類は、entity と計算を読んだあとで見る**（`UI_BOARD_COLUMNS_NOT_ENUM`・`UI_HIGHLIGHT_NOT_BOOLEAN`）。
 * `required` のときは、欄そのものが無ければ `SHAPE_KEY_MISSING` で断る（ボードは列が要る）。
 */
function readViewName(
  member: MemberReader,
  key: "columns" | "highlight",
  required: boolean,
  report: Report,
): ShowFieldDraft | null {
  const entry = entryOf(member.map, key);
  if (entry === undefined) {
    if (required) {
      report("SHAPE_KEY_MISSING", `view に ${key} が無い（ボードは列にする選択肢の項目を指す）`, positionOf(member.map));
    }
    return null;
  }
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report("SHAPE_VALUE_INVALID", `view の ${key} には、名前を 1 つ書く`, positionOf(entry.value));
    return null;
  }
  return { name: entry.value.text, node: entry.value };
}

/** 一覧の種類ごとに書ける欄。**書ける欄は `type` が決める**（語彙は閉じている。src/spec.ts の `View`） */
const VIEW_KEYS: Readonly<Record<ViewType, readonly string[]>> = {
  // M1.1 と同じ（`show` は持たない）
  table: ["name", "entity", "type", "show"],
  // 列の並びを持たないので `show` は書けない
  settlement: ["name", "entity", "type"],
  // ボード（M1.3）。列にする選択肢の項目（`columns`）と、強調する計算（`highlight`）
  board: ["name", "entity", "type", "columns", "highlight"],
  // 一覧（M1.3）。`show` の扱いは `table` と揃え、画面で絞り込む項目（`filters`）を持てる
  list: ["name", "entity", "type", "show", "filters"],
  // ダッシュボード（M1.4。Issue #180）。**行を並べないので `entity` を持たない**——部品（`widgets`）を並べる
  dashboard: ["name", "type", "widgets"],
};

/**
 * ダッシュボードの部品（`widgets`。M1.4。Issue #180・#181・#182）を読む。**1 つ以上書く**——欄そのものが
 * 無い・空の並びのときは `SHAPE_KEY_MISSING`（部品が無ければダッシュボードにならない）。
 *
 * **書ける欄は `type` が決める**（語彙は閉じている。`View` の `widgets`）。
 *   `number`     … `value`（アプリ全体の計算）と、任意の `label`・`unit`
 *   `bar`・`pie` … `value`（見出しごとの計算）と、任意の `label`・`unit`（M1.4。Issue #181）
 *   `ranking`    … 鍵 `name`・`entity`・`by`・`show` と、任意の `label`・`limit`（M1.4。Issue #182）
 *
 * 実在と種類は、entity と計算を読んだあとで見る（`UI_DASHBOARD_VALUE_NOT_APP_SCOPE`・
 * `UI_DASHBOARD_VALUE_NOT_GROUPS`・`UI_RANKING_BY_NOT_ROW_VALUE`・`UI_RANKING_BY_NOT_SHOWN`）。
 */
function readWidgets(member: MemberReader, report: Report): readonly ViewPartDraft[] {
  const entry = entryOf(member.map, "widgets");
  if (entry === undefined) {
    report("SHAPE_KEY_MISSING", "view に widgets が無い（dashboard は部品を 1 つ以上並べる）", positionOf(member.map));
    return [];
  }
  if (entry.value.kind !== "seq") {
    report("SHAPE_VALUE_INVALID", "view の widgets は、部品を並べた [ … ] で書く", positionOf(entry.value));
    return [];
  }
  if (entry.value.items.length === 0) {
    report(
      "SHAPE_KEY_MISSING",
      "view の widgets が空である（dashboard は部品を 1 つ以上並べる）",
      positionOf(entry.value),
    );
    return [];
  }
  const parts: ViewPartDraft[] = [];
  entry.value.items.forEach((item, index) => {
    if (item.kind !== "map") {
      report(
        "SHAPE_VALUE_INVALID",
        `view の widgets の ${index + 1} 番目は「欄: 値」を並べた写像で書く`,
        positionOf(item),
      );
      return;
    }
    const what = `widgets[${index + 1}]`;
    const widget = new MemberReader(item, what, report);
    // 部品の種類。**語彙は閉じている**——数値（`number`）・棒（`bar`）・円（`pie`）・順位（`ranking`）である
    const typeEntry = entryOf(item, "type");
    const writtenType = typeEntry?.value.kind === "scalar" ? typeEntry.value.text : null;
    const kind: ViewPartType | null =
      writtenType !== null && isOneOf(VIEW_PART_TYPES, writtenType) ? (writtenType as ViewPartType) : null;
    if (typeEntry === undefined) {
      report(
        "SHAPE_KEY_MISSING",
        `view の ${what} に type が無い（書ける部品は ${VIEW_PART_TYPES.join("・")} である）`,
        positionOf(item),
      );
    } else if (kind === null) {
      report(
        "SHAPE_KEY_UNKNOWN",
        `view の ${what} の type ${writtenType ?? "?"} は書けない（書ける部品は ${VIEW_PART_TYPES.join("・")} である）`,
        positionOf(typeEntry.value),
      );
    }
    // 知らない種類のときは、`type` だけを認める（ほかの欄はすべて SHAPE_KEY_UNKNOWN になる）。
    // 数値・棒・円は `value` で計算を指すので、書ける欄は同じである（`VALUE_PART_KEYS`）
    widget.only(kind === "ranking" ? RANKING_PART_KEYS : kind === null ? ["type"] : VALUE_PART_KEYS);
    // 表示名（`label`）は、どの部品でも任意である。書いてあれば空でない文字列でなければならない
    const { label } = readLabel(item, `view の ${what}`, report);

    // `value` で計算を指す部品（数値 `number`・棒 `bar`・円 `pie`）。読む欄は 3 つとも同じである
    if (kind !== null && kind !== "ranking") {
      // 指す計算（`value`）。必須の、空でない文字列である
      const value = widget.text("value");
      // 単位（`unit`）は任意である。書いてあれば空でない文字列でなければならない
      const unit = readUnit(widget, what, report);
      parts.push({
        kind,
        label,
        // `value` を読めなかった（無い・空）ときは、実在の検査を重ねない（`SHAPE_KEY_MISSING` が既に出ている）
        malformed: value === null,
        value: value?.text ?? "",
        valueNode: value?.node ?? NO_NODE,
        unit,
        name: "",
        nameNode: null,
        entity: "",
        entityNode: null,
        by: "",
        byNode: null,
        show: null,
        limit: null,
      });
      return;
    }

    if (kind === "ranking") {
      // 鍵（`name`）。必須で、書き方は項目や計算と同じ識別子である（`label` とは別物である）
      const name = widget.text("name");
      if (name !== null) checkName(name.text, `view の ${what} の鍵`, positionOf(name.node), report);
      const entity = widget.text("entity");
      const by = widget.text("by");
      // 出す項目（`show`）は必須である。実在は、entity を読んだあとで見る（`checkRankingPart`）
      const show = readViewNames(widget, "show", report, `view の ${what}`, true);
      // 件数の上限（`limit`）は任意である。書いてあれば 1 以上の整数でなければならない
      const limit = readRankingLimit(widget, what, report);
      parts.push({
        kind,
        label,
        malformed: name === null || entity === null || by === null || show === null,
        value: "",
        valueNode: NO_NODE,
        unit: null,
        name: name?.text ?? "",
        nameNode: name?.node ?? null,
        entity: entity?.text ?? "",
        entityNode: entity?.node ?? null,
        by: by?.text ?? "",
        byNode: by?.node ?? null,
        show,
        limit,
      });
      return;
    }

    // 知らない種類（`kind` が `null`）。意味の検査を重ねない（`SHAPE_KEY_UNKNOWN` が既に出ている）
    parts.push({
      kind: null,
      label,
      malformed: true,
      value: "",
      valueNode: NO_NODE,
      unit: null,
      name: "",
      nameNode: null,
      entity: "",
      entityNode: null,
      by: "",
      byNode: null,
      show: null,
      limit: null,
    });
  });
  return parts;
}

/**
 * 順位の部品の件数の上限（`limit`。M1.4。Issue #182）を読む。**任意**である。書いてあれば
 * **1 以上の整数**でなければならない（上位いくつを出すか。省いたときの既定は `RANKING_LIMIT_DEFAULT`）。
 */
function readRankingLimit(member: MemberReader, what: string, report: Report): number | null {
  const entry = entryOf(member.map, "limit");
  if (entry === undefined) return null;
  const value = entry.value;
  if (value.kind !== "scalar" || !/^[1-9]\d*$/.test(value.text)) {
    report(
      "SHAPE_VALUE_INVALID",
      `view の ${what} の limit は、1 以上の整数で書く（上位いくつを出すか）`,
      positionOf(value),
    );
    return null;
  }
  return Number(value.text);
}

/**
 * 部品の単位（`unit`。M1.4。Issue #180）を読む。**任意**である。書いてあれば、空でない文字列で
 * なければならない（「回」「人」「円」など。空文字は単位にならない）。
 */
function readUnit(member: MemberReader, what: string, report: Report): string | null {
  const entry = entryOf(member.map, "unit");
  if (entry === undefined) return null;
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report("SHAPE_VALUE_INVALID", `view の ${what} の unit は空でない文字列で書く`, positionOf(entry.value));
    return null;
  }
  return entry.value.text;
}

/**
 * 一覧（`views`）を読む。**書ける欄は `type` が決める**（語彙は閉じている。src/spec.ts の `View`）。
 *   `type` なし … `name`・`entity`            （M1.1 と同じ。`show` は持たない）
 *   `table`     … 上に `type`・`show`
 *   `settlement`… 上に `type`                 （列の並びを持たないので `show` は書けない）
 *   `board`     … 上に `type`・`columns`（必須）・`highlight`（任意。M1.3）
 *   `list`      … 上に `type`・`show`・`filters`（M1.3）
 *   `dashboard` … 上に `type`・`widgets`（必須。M1.4。**`entity` は書けない**）
 */
function readViews(items: readonly YamlNode[], report: Report): readonly ViewDraft[] {
  const views: ViewDraft[] = [];
  items.forEach((item, index) => {
    if (item.kind !== "map") {
      report("SHAPE_VALUE_INVALID", `views の ${index + 1} 番目は「欄: 値」を並べた写像で書く`, positionOf(item));
      return;
    }
    const member = new MemberReader(item, `views[${index + 1}]`, report);
    const type = readViewType(member, report);
    member.only(type === null ? ["name", "entity", "type"] : VIEW_KEYS[type]);

    const name = member.text("name");
    if (name !== null) checkName(name.text, "view", positionOf(name.node), report);
    // **ダッシュボードは行を並べないので `entity` を持たない**（M1.4。Issue #180）。書けば、上の
    // `member.only` が `SHAPE_KEY_UNKNOWN` で断る（`scope: app` に `entity` を書いたときと揃える）
    const entity = type === "dashboard" ? null : member.text("entity");
    const hasShow = type === "table" || type === "list";
    views.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      entity: entity?.text ?? null,
      entityNode: entity?.node ?? null,
      type,
      show: hasShow ? readViewNames(member, "show", report) : null,
      // ボードの `columns` は必須である（列が無ければボードにならない）。`highlight` は任意である
      columns: type === "board" ? readViewName(member, "columns", true, report) : null,
      highlight: type === "board" ? readViewName(member, "highlight", false, report) : null,
      // 絞り込み（`filters`）は一覧（`type: list`）でだけ書ける（M1.3）
      filters: type === "list" ? readViewNames(member, "filters", report) : null,
      // 部品（`widgets`）はダッシュボード（`type: dashboard`）でだけ書ける（M1.4）
      widgets: type === "dashboard" ? readWidgets(member, report) : null,
    });
  });
  checkDuplicates(
    views.map((view) => ({ name: view.name, nameNode: view.nameNode })),
    "UI_VIEW_DUPLICATE_NAME",
    "view",
    report,
  );
  return views;
}

/**
 * 検査の文言（任意。M1.2）。書いてあれば、**空でない文字列**でなければならない
 * （並び・写像・空は `SHAPE_VALIDATION_MESSAGE_INVALID`。docs/semantics.md「message」）。
 */
function readValidationMessage(member: MemberReader, report: Report): string | null {
  const entry = entryOf(member.map, "message");
  if (entry === undefined) return null;
  if (entry.value.kind !== "scalar" || entry.value.text === "") {
    report(
      "SHAPE_VALIDATION_MESSAGE_INVALID",
      "validation の message は空でない文字列で書く（並びや写像では書けない）",
      positionOf(entry.value),
    );
    return null;
  }
  return entry.value.text;
}

function readValidations(items: readonly YamlNode[], report: Report): readonly ValidationDraft[] {
  const validations: ValidationDraft[] = [];
  for (const member of readMembers(
    items,
    "validations",
    ["name", "entity", "expression", "message"],
    report,
  )) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, "validation", positionOf(name.node), report);
    const entity = member.text("entity");
    const expression = member.text("expression");
    validations.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
      expression: expression?.text ?? "",
      expressionNode: expression?.node ?? { kind: "null", line: 0, column: 0 },
      message: readValidationMessage(member, report),
    });
  }
  checkDuplicates(validations, "LOGIC_VALIDATION_DUPLICATE_NAME", "validation", report);
  return validations;
}

/** `sum: <entity>.<項目か計算>` を読む。形が「entity.名前」でなければ LOGIC_AGGREGATE_FORM_INVALID */
function readAggregateTarget(
  value: YamlNode,
  report: Report,
  /** 集計の種類（`sum`・`avg`）。診断の文言に使う */
  kind: AggregateKind,
): { readonly entity: string; readonly node: YamlNode; readonly name: string } | null {
  if (value.kind !== "scalar" || value.text === "") {
    report("SHAPE_VALUE_INVALID", `computed の ${kind} は「entity.項目か計算」の形で書く`, positionOf(value));
    return null;
  }
  const [entity = "", name = "", ...rest] = value.text.split(".");
  if (entity === "" || name === "" || rest.length > 0) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed の ${kind} ${value.text} は「entity.項目か計算」の形で書く`,
      positionOf(value),
    );
    return null;
  }
  return { entity, node: value, name };
}

/**
 * 集計の `where` を読む。**正規化のあとは、条件を「`op` を持つオブジェクト」に揃える**（窓口の決定
 * 2026-09-20）。書く側の形は 3 つである（M1.2・M1.4）。
 *   `{項目: this}`                    → `{ op: "equals" }`
 *   `{項目: {contains: this}}`        → `{ op: "contains" }`
 *   `{項目: {within: this_month}}`    → `{ op: "within", period: "this_month" }`
 *
 * 期間の名前はここで見る（語彙は閉じている）。**指せる項目の種類（`date` だけ）は、集計元の entity を
 * 読んだあとで見る**（`checkAggregate`）。
 */
function readWhereDraft(entry: YamlEntry | undefined, report: Report): readonly AggregateWhereDraft[] {
  if (entry === undefined) return [];
  if (entry.value.kind !== "map") {
    report(
      "SHAPE_VALUE_INVALID",
      "computed の aggregate の where は「項目: this」を並べた写像で書く",
      positionOf(entry.value),
    );
    return [];
  }
  reportDuplicateKeys(entry.value, "aggregate の where", report);
  const conditions: AggregateWhereDraft[] = [];
  for (const condition of entry.value.entries) {
    const fieldNode: YamlNode = {
      kind: "scalar",
      line: condition.keyLine,
      column: condition.keyColumn,
      text: condition.key,
    };
    const value = condition.value;
    if (value.kind === "scalar" && value.text === "this") {
      conditions.push({ field: condition.key, fieldNode, condition: { op: "equals" } });
      continue;
    }
    const contains = value.kind === "map" ? entryOf(value, "contains") : undefined;
    if (
      value.kind === "map" &&
      contains !== undefined &&
      value.entries.length === 1 &&
      contains.value.kind === "scalar" &&
      contains.value.text === "this"
    ) {
      conditions.push({ field: condition.key, fieldNode, condition: { op: "contains" } });
      continue;
    }
    // 期間の条件（`within`。M1.4）。比べる相手は**期間の名前**である（`this` ではない）
    const within = value.kind === "map" ? entryOf(value, "within") : undefined;
    if (value.kind === "map" && within !== undefined && value.entries.length === 1) {
      const period = within.value;
      if (period.kind !== "scalar" || period.text === "") {
        report(
          "SHAPE_VALUE_INVALID",
          `集計の where の ${condition.key} の within は、期間の名前（${PERIODS.join("・")}）で書く`,
          positionOf(period),
        );
        continue;
      }
      if (!isOneOf(PERIODS, period.text)) {
        report(
          "LOGIC_AGGREGATE_WHERE_PERIOD_NOT_ALLOWED",
          `集計の where の ${condition.key} の期間 ${period.text} は書けない（M1.4 の期間は ${PERIODS.join("・")} である）`,
          positionOf(period),
        );
        continue;
      }
      conditions.push({
        field: condition.key,
        fieldNode,
        condition: { op: "within", period: period.text as Period },
      });
      continue;
    }
    report(
      "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
      `集計の where の ${condition.key} は、this（参照の一致）か「contains: this」（参照の並びの包含）か「within: <期間>」（期間の条件）で書く`,
      positionOf(value),
    );
  }
  return conditions;
}

/** `groupBy` の `<entity>.<項目>` を読む（月の形と、値ごとの形で共通。M1.4。Issue #179） */
function readGroupTarget(
  value: YamlNode,
  report: Report,
): { readonly entity: string; readonly field: string; readonly node: YamlNode } | null {
  if (value.kind !== "scalar" || value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      "computed の aggregate の groupBy は「<entity>.<項目>」の形で書く",
      positionOf(value),
    );
    return null;
  }
  const [entity = "", field = "", ...rest] = value.text.split(".");
  if (entity === "" || field === "" || rest.length > 0) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed の aggregate の groupBy ${value.text} は「<entity>.<項目>」の形で書く`,
      positionOf(value),
    );
    return null;
  }
  return { entity, field, node: value };
}

/**
 * 見出しごとに分ける対象（`groupBy`。M1.4。Issue #179）を読む。書ける形は 2 つである。
 *   `<entity>.<enum の項目>`          … 値ごとに分ける（見出しは `options` のキー）
 *   `{month: <entity>.<date の項目>}` … 月でまとめる（見出しは `YYYY-MM`）
 * 分けられる型かどうかは、entity を読んだあとで見る（`LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE`）。
 */
function readGroupByDraft(entry: YamlEntry | undefined, report: Report): AggregateGroupDraft | null {
  if (entry === undefined) return null;
  const value = entry.value;
  if (value.kind === "map") {
    const month = entryOf(value, "month");
    if (month === undefined || value.entries.length !== 1) {
      report(
        "SHAPE_VALUE_INVALID",
        "computed の aggregate の groupBy は、月でまとめるとき「{month: <entity>.<日付の項目>}」と書く（ほかの欄は書けない）",
        positionOf(value),
      );
      return null;
    }
    const target = readGroupTarget(month.value, report);
    if (target === null) return null;
    return { entity: target.entity, entityNode: target.node, field: target.field, fieldNode: target.node, month: true };
  }
  const target = readGroupTarget(value, report);
  if (target === null) return null;
  return { entity: target.entity, entityNode: target.node, field: target.field, fieldNode: target.node, month: false };
}

/** 見出しの数の上限（`last`。M1.4）を読む。1 以上の整数である */
function readGroupLast(entry: YamlEntry | undefined, report: Report): number | null {
  if (entry === undefined) return null;
  const value = entry.value;
  if (value.kind !== "scalar" || !/^[1-9]\d*$/.test(value.text)) {
    report(
      "SHAPE_VALUE_INVALID",
      "computed の aggregate の last は、1 以上の整数で書く（直近いくつの見出しか）",
      positionOf(value),
    );
    return null;
  }
  return Number(value.text);
}

/** 集計（`aggregate`）を読む。意味の検査（対象の実在・型・where の整合）は組み立てのあとに行う */
function readAggregateDraft(value: YamlNode, report: Report): AggregateDraft | null {
  if (value.kind !== "map") {
    report(
      "SHAPE_VALUE_INVALID",
      `computed の aggregate は「${AGGREGATE_KINDS.join(" / ")} / where」を並べた写像で書く`,
      positionOf(value),
    );
    return null;
  }
  reportDuplicateKeys(value, "aggregate", report);
  for (const entry of value.entries) {
    if (!isOneOf([...AGGREGATE_KINDS, "where", "groupBy", "last"], entry.key)) {
      report(
        "SHAPE_KEY_UNKNOWN",
        `computed の aggregate に欄 ${entry.key} は書けない（${AGGREGATE_KINDS.join(" と ")} と where と groupBy と last だけ）`,
        { line: entry.keyLine, column: entry.keyColumn },
      );
    }
  }
  // `sum`・`count`・`avg` の**どれか 1 つ**である（M1.2・M1.4。同時には書けない）
  const present = AGGREGATE_KINDS.filter((kind) => entryOf(value, kind) !== undefined);
  if (present.length > 1) {
    const second = present[1] ?? "";
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed の aggregate に ${present.join(" と ")} を同時に書けない（どれか 1 つである）`,
      positionOf(entryOf(value, second)?.value ?? value),
    );
    return null;
  }
  if (present.length === 0) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed の aggregate には ${AGGREGATE_KINDS.join("（合計）・")} のどれか 1 つを書く`,
      positionOf(value),
    );
    return null;
  }
  const kind = present[0];
  if (kind === undefined) return null;
  const where = readWhereDraft(entryOf(value, "where"), report);
  // 見出しごとの集計（M1.4。Issue #179）。**書いていなければ従来どおり 1 つの値**である
  const groupBy = readGroupByDraft(entryOf(value, "groupBy"), report);
  const last = readGroupLast(entryOf(value, "last"), report);
  if (kind === "count") {
    const entity = entryOf(value, "count")?.value;
    if (entity === undefined || entity.kind !== "scalar" || entity.text === "") {
      report("SHAPE_VALUE_INVALID", "computed の count は集計元の entity の名前で書く", positionOf(entity ?? value));
      return null;
    }
    return { kind, entity: entity.text, entityNode: entity, name: null, nameNode: null, where, groupBy, last };
  }
  const target = readAggregateTarget(entryOf(value, kind)?.value ?? value, report, kind);
  if (target === null) return null;
  return {
    kind,
    entity: target.entity,
    entityNode: target.node,
    name: target.name,
    nameNode: target.node,
    where,
    groupBy,
    last,
  };
}

/**
 * 精算（`settle`。M1.2）を読む。`expense`（割り勘の支出の entity）と、その entity の項目の名前を
 * 3 つ——`amount`（額）・`payer`（払った人）・`shares`（割る人）——を読む。
 * 実在と型は組み立てのあとで見る（entity をすべて読むまで分からない）。
 */
function readSettleDraft(value: YamlNode, report: Report): SettleDraft | null {
  if (value.kind !== "map") {
    report(
      "SHAPE_VALUE_INVALID",
      "computed の settle は「expense / amount / payer / shares」を並べた写像で書く",
      positionOf(value),
    );
    return null;
  }
  const member = new MemberReader(value, "computed の settle", report);
  member.only(["expense", "amount", "payer", "shares"]);
  const expense = member.text("expense");
  const amount = member.text("amount");
  const payer = member.text("payer");
  const shares = member.text("shares");
  if (expense === null || amount === null || payer === null || shares === null) return null;
  return {
    expense: expense.text,
    expenseNode: expense.node,
    amount: amount.text,
    amountNode: amount.node,
    payer: payer.text,
    payerNode: payer.node,
    shares: shares.text,
    sharesNode: shares.node,
  };
}

function readComputed(items: readonly YamlNode[], report: Report): readonly ComputedDraft[] {
  const computed: ComputedDraft[] = [];
  for (const member of readMembers(
    items,
    "computed",
    ["name", "scope", "entity", "expression", "aggregate", "settle", "type", "label"],
    report,
  )) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, "computed", positionOf(name.node), report);
    const label = `computed ${name?.text ?? ""}`;
    // 表示名（`label`。M1.3。Issue #176）。項目と同じく、空でない文字列で書く
    const display = readLabel(member.map, label, report);

    // 計算の範囲（M1.4。Issue #177）。`scope: app` なら**どのレコードにも属さない**——
    // `entity` を持たず、`settle`（精算）も書けない。意味の検査は組み立てのあとに行う
    const scopeEntry = entryOf(member.map, "scope");
    let scope: ComputedScope | null = null;
    if (scopeEntry !== undefined) {
      if (scopeEntry.value.kind === "scalar" && isOneOf(COMPUTED_SCOPES, scopeEntry.value.text)) {
        scope = scopeEntry.value.text as ComputedScope;
      } else {
        report(
          "SHAPE_VALUE_INVALID",
          `${label} の scope は ${COMPUTED_SCOPES.join("・")}（アプリ全体）だけを書ける`,
          positionOf(scopeEntry.value),
        );
      }
    }
    // 見出しごとの集計（`type: groups`。M1.4。Issue #179）は **`scope` も `entity` も持たない**——
    // 分ける対象は `aggregate` の `groupBy` が持つ。`type` を先に見て、欄の要否を決める
    const rawTypeEntry = entryOf(member.map, "type");
    const isGroups = rawTypeEntry?.value.kind === "scalar" && rawTypeEntry.value.text === "groups";
    const entityEntry = entryOf(member.map, "entity");
    let entity: { readonly text: string; readonly node: YamlNode } | null = null;
    if (isGroups) {
      for (const [key, extra] of [
        ["scope", scopeEntry],
        ["entity", entityEntry],
      ] as const) {
        if (extra !== undefined) {
          report(
            "SHAPE_KEY_UNKNOWN",
            `${label} は type: groups である（${key} は書かない。分ける対象は aggregate の groupBy が持つ）`,
            { line: extra.keyLine, column: extra.keyColumn },
          );
        }
      }
      // `scope: app` と書いていても、上の検査で断っている（entity と同じ扱いである）
      scope = null;
    } else if (scope === "app") {
      // アプリ全体の計算は entity を持たない。書いてあれば断る（黙って捨てない）
      if (entityEntry !== undefined) {
        report(
          "SHAPE_KEY_UNKNOWN",
          `${label} は scope: app である（entity は書かない。どのレコードにも属さない）`,
          { line: entityEntry.keyLine, column: entityEntry.keyColumn },
        );
      }
    } else {
      entity = member.text("entity");
    }

    // 計算は、式（expression）・集計（aggregate）・精算（settle）の**どれか 1 つ**である
    // （docs/semantics.md「computed」「settle」）
    const expressionEntry = entryOf(member.map, "expression");
    const aggregateEntry = entryOf(member.map, "aggregate");
    const settleEntry = entryOf(member.map, "settle");
    // アプリ全体の計算に精算は書けない（精算する人の entity が要る。M1.4）
    if (scope === "app" && settleEntry !== undefined) {
      report(
        "SHAPE_KEY_UNKNOWN",
        `${label} は scope: app である（settle は書かない。精算する entity が要る）`,
        { line: settleEntry.keyLine, column: settleEntry.keyColumn },
      );
    }
    let expression: { readonly text: string; readonly node: YamlNode } | null = null;
    if (expressionEntry !== undefined) {
      if (expressionEntry.value.kind === "scalar" && expressionEntry.value.text !== "") {
        expression = { text: expressionEntry.value.text, node: expressionEntry.value };
      } else {
        report("SHAPE_VALUE_INVALID", "computed の expression は空でない文字列で書く", positionOf(expressionEntry.value));
      }
    }
    const aggregate = aggregateEntry === undefined ? null : readAggregateDraft(aggregateEntry.value, report);
    const settle = settleEntry === undefined ? null : readSettleDraft(settleEntry.value, report);

    const forms = [expressionEntry, aggregateEntry, settleEntry].filter(
      (entry) => entry !== undefined,
    ).length;
    if (forms === 0) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `${label} には、expression（式）か aggregate（集計）か settle（精算）のどれか 1 つを書く`,
        positionOf(member.map),
      );
    } else if (forms > 1) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `${label} に expression・aggregate・settle を同時に書けない（どれか 1 つである）`,
        positionOf((settleEntry ?? aggregateEntry ?? expressionEntry)?.value ?? member.map),
      );
    }

    // 精算の値は数ではなく送金の並びなので、`type` を持たない。式と集計の `type` は必須である
    let type: { readonly text: string; readonly node: YamlNode } | null = null;
    if (settleEntry === undefined) {
      type = member.text("type");
      if (type !== null && !isOneOf(COMPUTED_TYPES, type.text)) {
        report(
          "LOGIC_COMPUTED_TYPE_UNKNOWN",
          `computed の type ${type.text} は M1.1 の型（${COMPUTED_TYPES.join("・")}）に無い`,
          positionOf(type.node),
        );
      }
    } else {
      const written = entryOf(member.map, "type");
      if (written !== undefined) {
        report(
          "SHAPE_KEY_UNKNOWN",
          `${label} は settle である（結果は送金の並びなので、type は書かない）`,
          { line: written.keyLine, column: written.keyColumn },
        );
      }
    }

    computed.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      label: display.label,
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
      expression: expression?.text ?? "",
      expressionNode: expression?.node ?? { kind: "null", line: 0, column: 0 },
      type: type?.text ?? "",
      scope,
      aggregate,
      settle,
      malformed: forms !== 1 || (settleEntry !== undefined && settle === null),
      dependencies: [],
    });
  }
  checkDuplicates(computed, "LOGIC_COMPUTED_DUPLICATE_NAME", "computed", report);
  return computed;
}

function readPermissions(items: readonly YamlNode[], report: Report): readonly PermissionDraft[] {
  const permissions: PermissionDraft[] = [];
  for (const member of readMembers(items, "permissions", ["name", "subject"], report)) {
    const name = member.text("name");
    const subject = member.text("subject");
    if (name !== null && !isOneOf(PERMISSION_NAMES, name.text)) {
      report(
        "PERMISSION_NAME_NOT_ALLOWED",
        `権限の名前 ${name.text} は M1.1 の権限（${PERMISSION_NAMES.join("・")}）に無い`,
        positionOf(name.node),
      );
    }
    if (subject !== null && !isOneOf(PERMISSION_SUBJECTS, subject.text)) {
      report(
        "PERMISSION_SUBJECT_NOT_ALLOWED",
        `権限の subject ${subject.text} は M1.1 の subject（${PERMISSION_SUBJECTS.join("・")}）に無い`,
        positionOf(subject.node),
      );
    }
    permissions.push({
      name: name?.text ?? "",
      node: name?.node ?? { kind: "null", line: 0, column: 0 },
      subject: subject?.text ?? "",
      subjectNode: subject?.node ?? { kind: "null", line: 0, column: 0 },
    });
  }
  const named = permissions.map((permission) => ({ name: permission.name, nameNode: permission.node }));
  checkDuplicates(named, "PERMISSION_DUPLICATE_NAME", "権限", report);
  return permissions;
}

/** 本人確認。`mode` だけを持つ写像である */
function checkMinIdentity(entry: YamlEntry | undefined, report: Report): void {
  if (entry === undefined) {
    report("SHAPE_KEY_MISSING", "欄 minIdentity が無い（7 欄すべてを書く）", { line: 1, column: 1 });
    return;
  }
  if (entry.value.kind !== "map") {
    report("SHAPE_VALUE_INVALID", "欄 minIdentity は「`mode: 値`」を並べた写像で書く", positionOf(entry.value));
    return;
  }
  const member = new MemberReader(entry.value, "minIdentity", report);
  member.only(["mode"]);
  const mode = member.text("mode");
  if (mode !== null && !isOneOf(IDENTITY_MODES, mode.text)) {
    report(
      "PERMISSION_IDENTITY_MODE_NOT_ALLOWED",
      `minIdentity の mode ${mode.text} は M1 の本人確認（${IDENTITY_MODES.join("・")}）に無い`,
      positionOf(mode.node),
    );
  }
}

// ── 3. ロジック層（式・参照・循環） ──────────────────────────────

/** entity の名前 → 宣言。同じ名前が 2 つあるときは、先に書いたほうを使う（重複は別に断る） */
function entityIndex(entities: readonly EntityDraft[]): ReadonlyMap<string, EntityDraft> {
  const index = new Map<string, EntityDraft>();
  for (const entity of entities) {
    if (entity.name !== "" && !index.has(entity.name)) index.set(entity.name, entity);
  }
  return index;
}

/** その entity を対象にした式の名前解決（項目と計算だけ。レコードは持たない） */
function scopeFor(
  entity: EntityDraft,
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
): ExpressionScope {
  const fields = new Map<string, SpecType>(
    entity.fields.map((field) => [
      field.name,
      field.declaration === null ? "unknown" : expressionTypeOf(field.declaration),
    ]),
  );
  const computedTypes = new Map(
    computed
      // 精算は行ごとの値ではないので、式から参照できない（名前としても型としても出さない）
      // 真偽（`boolean`）の計算も同じである（M1.3）——**強調（`highlight`）が指すためだけに使い**、
      // ほかの式からは参照できない（評価側も `computed` に入れないので、判定が食い違わない）
      .filter(
        (draft) => draft.entity === entity.name && draft.settle === null && draft.type !== "boolean",
      )
      .map((draft) => [draft.name, draft.type]),
  );
  return {
    resolveName: (name: string): SpecType | null => {
      // 項目を先に見る（計算の名前が項目と重なっているとき、自分自身の参照に化けないため）
      const field = fields.get(name);
      if (field !== undefined) return field;
      const type = computedTypes.get(name);
      if (type !== undefined) {
        // 見出しごとの集計（`groups`）は行ごとの値ではないので、式から参照できない
        return isOneOf(COMPUTED_TYPES, type) && type !== "groups" ? (type as SpecType) : "unknown";
      }
      return null;
    },
    entityName: (name: string): string | null => (index.has(name) ? name : null),
  };
}

/** 式を読んで型を求めた結果。読めなかった（診断を出した）ときは `null` を返す */
interface ExpressionCheck {
  readonly type: SpecType;
  /** 式が参照した名前（計算どうしの循環を見るのに使う） */
  readonly names: readonly string[];
}

/**
 * **アプリ全体の計算（`scope: app`）**の式の名前解決（M1.4。Issue #177）。
 * 参照できるのは、**ほかのアプリ全体の計算だけ**である——entity の項目も、行ごとの計算も見えない
 * （どのレコードにも属さないので、参照する相手が決まらない）。`.` を使った参照も書けない。
 */
function appScopeFor(computed: readonly ComputedDraft[]): ExpressionScope {
  const types = new Map(
    computed
      .filter((draft) => draft.scope === "app" && draft.settle === null)
      .map((draft) => [draft.name, draft.type]),
  );
  return {
    resolveName: (name: string): SpecType | null => {
      const type = types.get(name);
      if (type === undefined) return null;
      // 見出しごとの集計（`groups`）は数ではないので、アプリ全体の式から参照できない
      return isOneOf(COMPUTED_TYPES, type) && type !== "groups" ? (type as SpecType) : "unknown";
    },
    entityName: () => null,
  };
}

/** AST の子を、書いた順に返す（式の中を歩くため） */
function childrenOf(node: AstNode): readonly AstNode[] {
  switch (node.kind) {
    case "number":
    case "string":
    case "name":
    case "member":
      return [];
    case "unary":
      return [node.operand];
    case "binary":
      return [node.left, node.right];
    case "call":
      return node.args;
  }
}

/**
 * 選択肢（`enum`）の項目を、`options` に無いキーと比べていないか（M1.3）。
 *
 * 型だけを見る `analyzeExpression` には、`enum` のキーの並びが見えない（`enum` の値の型は
 * ただの文字列である）。**打ち間違い（`status == "todu"`）は動かす前に止めたい**ので、
 * 宣言を持っているこちら側で、比較の左右を突き合わせる（docs/semantics.md「enum」「when」）。
 */
function checkEnumComparisons(
  ast: AstNode,
  entity: EntityDraft,
  label: string,
  text: string,
  base: DiagnosticPosition,
  report: Report,
): void {
  const keysOf = (name: string): readonly string[] | null => {
    const field = entity.fields.find((candidate) => candidate.name === name);
    if (field === undefined || field.declaration === null) return null;
    return isEnumField(field.declaration) ? enumKeys(field.declaration) : null;
  };
  const compare = (name: AstNode, literal: AstNode): void => {
    if (name.kind !== "name" || literal.kind !== "string") return;
    const keys = keysOf(name.name);
    if (keys === null || keys.includes(literal.value)) return;
    report(
      "LOGIC_ENUM_KEY_NOT_FOUND",
      `${label}: ${name.name} と比べている "${literal.value}" は、選択肢のキーに無い（${keys.join("・")}）`,
      positionAt(text, literal.start, base),
    );
  };
  const walk = (node: AstNode): void => {
    if (node.kind === "binary" && isComparisonOperator(node.operator)) {
      compare(node.left, node.right);
      compare(node.right, node.left);
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(ast);
}

/**
 * 1 つの式を、その entity の宣言に突き合わせて検査する（検査の式・計算の式・操作の条件で共通）。
 * **式は評価しない。** 診断は `label` を頭に付けて報告し、位置は原文の中の位置へ写す。
 */
function checkExpression(
  text: string,
  node: YamlNode,
  label: string,
  entity: EntityDraft,
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): ExpressionCheck | null {
  const base = positionOf(node);
  const status = readExpression(text);
  if (!status.ok) {
    for (const problem of status.problems) {
      report(problem.code, `${label}: ${problem.message}`, positionAt(text, problem.offset, base));
    }
    return null;
  }
  const analysis = analyzeExpression(status.ast, scopeFor(entity, computed, index));
  for (const problem of analysis.problems) {
    report(problem.code, `${label}: ${problem.message}`, positionAt(text, problem.offset, base));
  }
  // 型の誤りが出ている式に、選択肢のキーの照合を重ねない（1 つの誤りを 2 つ以上のコードにしない）
  if (analysis.problems.length === 0) {
    checkEnumComparisons(status.ast, entity, label, text, base, report);
  }
  return { type: analysis.type, names: analysis.names };
}

/**
 * **アプリ全体の計算（`scope: app`）**の式を検査する（M1.4。Issue #177）。参照できるのは
 * ほかのアプリ全体の計算だけで、選択肢（`enum`）のキーの照合は無い（参照する項目が無い）。
 * **式は評価しない。**
 */
function checkAppExpression(
  text: string,
  node: YamlNode,
  label: string,
  computed: readonly ComputedDraft[],
  report: Report,
): ExpressionCheck | null {
  const base = positionOf(node);
  const status = readExpression(text);
  if (!status.ok) {
    for (const problem of status.problems) {
      report(problem.code, `${label}: ${problem.message}`, positionAt(text, problem.offset, base));
    }
    return null;
  }
  const analysis = analyzeExpression(status.ast, appScopeFor(computed));
  for (const problem of analysis.problems) {
    report(problem.code, `${label}: ${problem.message}`, positionAt(text, problem.offset, base));
  }
  return { type: analysis.type, names: analysis.names };
}

function checkValidations(
  validations: readonly ValidationDraft[],
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  for (const validation of validations) {
    const entity = index.get(validation.entity);
    if (entity === undefined) {
      report(
        "LOGIC_ENTITY_NOT_FOUND",
        `validation ${validation.name} の entity ${validation.entity} が宣言に無い`,
        positionOf(validation.entityNode),
      );
      continue;
    }
    if (validation.expression === "") continue;
    const checked = checkExpression(
      validation.expression,
      validation.expressionNode,
      `validation ${validation.name}`,
      entity,
      computed,
      index,
      report,
    );
    if (checked === null) continue;
    if (checked.type !== "unknown" && checked.type !== "boolean") {
      report(
        "LOGIC_VALIDATION_NOT_BOOLEAN",
        `validation ${validation.name} の式は真偽にならなければならない（${typeName(checked.type)}になる）`,
        positionOf(validation.expressionNode),
      );
    }
  }
}

/** 数の定数（`set` に書ける形）。符号つきの整数と小数だけである */
const NUMBER_CONSTANT = /^-?\d+(?:\.\d+)?$/;

/**
 * 書かれた字面が**式**か（`set` の値が決まった値でないときに、理由を分けるために見る）。
 * 名前 1 つ（`doing`）と定数は式と数えない——それは「決まった値の書き間違い」だからである。
 */
function looksLikeExpression(text: string): boolean {
  const parsed = parseExpression(text);
  if (!parsed.ok) return false;
  const { kind } = parsed.ast;
  return kind === "binary" || kind === "unary" || kind === "call" || kind === "member";
}

/**
 * 決まった値への書き換え（`set`。M1.3）の 1 つを検査する。
 *
 * **書けるのは決まった値だけである**（式は書けない。式を許すと計算と操作の境目が消える）。
 * 値は**その項目の型に合っていなければならない**——`enum` なら `options` のキーのどれかである
 * （docs/semantics.md「set」）。
 */
function checkActionSet(
  action: ActionDraft,
  assignment: ActionSetDraft,
  entity: EntityDraft,
  report: Report,
): void {
  const label = `action ${action.name} の set`;
  const field = entity.fields.find((candidate) => candidate.name === assignment.field);
  if (field === undefined) {
    report(
      "LOGIC_ACTION_SET_FIELD_NOT_FOUND",
      `${label} の項目 ${assignment.field} が、entity ${entity.name} に無い`,
      positionOf(assignment.fieldNode),
    );
    return;
  }
  // 項目の型そのものが読めていない（診断は既に出ている）。誤りを重ねない
  if (field.declaration === null) return;

  /** 式を書いている（決まった値ではない）。**型の食い違いとは別のコードで断る** */
  const rejectExpression = (): void => {
    report(
      "LOGIC_ACTION_SET_NOT_CONSTANT",
      `${label} の ${assignment.field} には決まった値だけを書ける（式は書けない）`,
      positionOf(assignment.node),
    );
  };

  /** 決まった値として読めなかったときに、式なのか書き間違いなのかを分けて断る */
  const reject = (expected: string): void => {
    if (looksLikeExpression(assignment.text)) {
      rejectExpression();
      return;
    }
    report(
      "LOGIC_ACTION_SET_TYPE_MISMATCH",
      `${label} の ${assignment.field} の値 ${assignment.text} は、${expected}`,
      positionOf(assignment.node),
    );
  };

  switch (fieldKind(field.declaration)) {
    case "number":
      if (!NUMBER_CONSTANT.test(assignment.text)) reject("数の定数で書く");
      return;
    case "date":
      if (!DATE_VALUE_PATTERN.test(assignment.text)) reject("日付（YYYY-MM-DD）で書く");
      return;
    case "enum": {
      const keys = enumKeys(field.declaration);
      if (!keys.includes(assignment.text)) reject(`選択肢のキーに無い（${keys.join("・")}）`);
      return;
    }
    case "string":
      // 文字列は何でも書けるが、式の字面は決まった値にしない（計算と操作の境目を消さない）
      if (looksLikeExpression(assignment.text)) rejectExpression();
      return;
    default:
      // `list` と `ref`。並びと参照先の ID は、宣言に埋め込む決まった値ではない
      report(
        "LOGIC_ACTION_SET_TYPE_MISMATCH",
        `${label} の ${assignment.field} には決まった値を書けない（並びと参照の項目は set で書けない）`,
        positionOf(assignment.node),
      );
  }
}

/**
 * 操作（`actions`）の意味を検査する。entity の実在と、M1.3 で足した `set`・`when` を見る。
 *
 * **`when` は検査の式と同じ扱いである**——その entity の 1 件について評価する真偽の式で、
 * 参照できるのは同じ entity の項目と計算だけである（docs/semantics.md「when」）。
 */
function checkActions(
  actions: readonly ActionDraft[],
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  for (const action of actions) {
    const entity = index.get(action.entity);
    if (entity === undefined) {
      report(
        "LOGIC_ENTITY_NOT_FOUND",
        `action ${action.name} の entity ${action.entity} が宣言に無い`,
        positionOf(action.entityNode),
      );
      continue;
    }
    for (const assignment of action.set ?? []) checkActionSet(action, assignment, entity, report);
    if (action.when === null || action.whenNode === null) continue;
    const checked = checkExpression(
      action.when,
      action.whenNode,
      `action ${action.name} の when`,
      entity,
      computed,
      index,
      report,
    );
    if (checked === null) continue;
    if (checked.type !== "unknown" && checked.type !== "boolean") {
      report(
        "LOGIC_ACTION_WHEN_NOT_BOOLEAN",
        `action ${action.name} の when は真偽にならなければならない（${typeName(checked.type)}になる）`,
        positionOf(action.whenNode),
      );
    }
  }
}

/**
 * 集計の意味を検査する（M1.2・M1.4）。集計元の entity・対象（項目か計算）・where の整合を見る。
 * 対象が計算なら、その計算を依存として覚える（**entity をまたぐ循環**を `checkCycles` が見つけられるように）。
 *
 * `outputEntity` は**集計の出力先の entity** である。`null` なら出力先のレコードが無い——
 * アプリ全体の集計（`scope: app`）と、見出しごとの集計（`type: groups`）である。どちらも
 * `where` の `this` は書けない（比べる相手が居ない。期間の条件は書ける）。
 *
 * `groups` が `true` のときは**見出しごとの集計**（M1.4。Issue #179）として見る——`groupBy` を要り、
 * 分けられるのは `enum` と `date` だけで、対象（`sum`・`avg`）は**項目だけ**である。
 */
function checkAggregate(
  draft: ComputedDraft,
  aggregate: AggregateDraft,
  outputEntity: EntityDraft | null,
  index: ReadonlyMap<string, EntityDraft>,
  computed: readonly ComputedDraft[],
  report: Report,
  groups = false,
): void {
  if (groups && aggregate.groupBy === null) {
    report(
      "LOGIC_COMPUTED_TYPE_MISMATCH",
      `computed ${draft.name} は type: groups である（集計に groupBy を書く）`,
      positionOf(aggregate.entityNode),
    );
    return;
  }
  if (!groups && aggregate.groupBy !== null) {
    report(
      "LOGIC_COMPUTED_TYPE_MISMATCH",
      `computed ${draft.name} の集計の groupBy は、type: groups のときだけ書ける（見出しごとの集計である）`,
      positionOf(aggregate.entityNode),
    );
    return;
  }
  // `last` は見出しの上限なので、見出しごとの集計（`groupBy`）と一緒でなければ意味を持たない
  if (!groups && aggregate.last !== null) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed ${draft.name} の集計の last は、groupBy と一緒に書く（見出しの数の上限である）`,
      positionOf(aggregate.entityNode),
    );
  }
  const source = index.get(aggregate.entity);
  if (source === undefined) {
    report(
      "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
      `computed ${draft.name} の集計の対象 entity ${aggregate.entity} が宣言に無い`,
      positionOf(aggregate.entityNode),
    );
    // 元の entity が無ければ、対象も where も見られない（誤りを重ねない）
    return;
  }

  // 見出しごとの集計（M1.4。Issue #179）。**分けられるのは `enum`（値ごと）と `date`（月ごと）だけ**である
  if (groups && aggregate.groupBy !== null) {
    const grouping = aggregate.groupBy;
    if (grouping.entity !== aggregate.entity) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `computed ${draft.name} の groupBy の entity ${grouping.entity} は、集計元 ${aggregate.entity} と一致しなければならない`,
        positionOf(grouping.entityNode),
      );
    }
    const field = source.fields.find((candidate) => candidate.name === grouping.field);
    if (field === undefined) {
      report(
        "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
        `computed ${draft.name} の groupBy の項目 ${aggregate.entity}.${grouping.field} が、集計元 entity に無い`,
        positionOf(grouping.fieldNode),
      );
    } else {
      const declaration = field.declaration;
      const groupable = grouping.month
        ? declaration !== null && fieldKind(declaration) === "date"
        : declaration !== null && isEnumField(declaration);
      if (!groupable) {
        report(
          "LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE",
          grouping.month
            ? `computed ${draft.name} の groupBy の ${aggregate.entity}.${grouping.field} は、月でまとめられる日付（date）の項目でなければならない`
            : `computed ${draft.name} の groupBy の ${aggregate.entity}.${grouping.field} は、選択肢（enum）の項目でなければならない（分けられるのは enum と date だけである）`,
          positionOf(grouping.fieldNode),
        );
      }
    }
    if (aggregate.last !== null && !grouping.month) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `computed ${draft.name} の集計の last は、月で分けるときだけ書ける（enum の見出しは options のキーの全部である）`,
        positionOf(grouping.fieldNode),
      );
    }
  }

  // `count` は値を読まない。`sum`・`avg` は対象が数でなければならない（M1.2・M1.4）
  if (aggregate.kind !== "count") {
    const name = aggregate.name ?? "";
    const field = source.fields.find((candidate) => candidate.name === name);
    let targetType: string | null = null;
    if (field !== undefined) {
      targetType = field.declaration === null ? null : expressionTypeOf(field.declaration);
    } else if (groups) {
      // **見出しごとの集計の対象は項目だけ**である（評価が行ごとの計算を持たない）
      report(
        "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
        `computed ${draft.name} の集計の対象 ${aggregate.entity}.${name} が、項目に無い（見出しごとの集計の対象は項目だけである）`,
        positionOf(aggregate.nameNode ?? aggregate.entityNode),
      );
    } else {
      const target = computed.find(
        (entry) => entry.scope === null && entry.entity === source.name && entry.name === name,
      );
      if (target === undefined) {
        report(
          "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
          `computed ${draft.name} の集計の対象 ${aggregate.entity}.${name} が、項目にも計算にも無い`,
          positionOf(aggregate.nameNode ?? aggregate.entityNode),
        );
      } else {
        draft.dependencies.push({ entity: source.name, name });
        // 対象の計算の型が読めないときは、型の食い違いを重ねて出さない（LOGIC_COMPUTED_TYPE_UNKNOWN が既に出る）
        if (isOneOf(COMPUTED_TYPES, target.type)) targetType = target.type;
      }
    }
    if (targetType !== null && targetType !== "number") {
      report(
        "LOGIC_AGGREGATE_TARGET_NOT_NUMBER",
        `computed ${draft.name} の集計の対象 ${aggregate.entity}.${name} は数でなければならない（${typeName(targetType as SpecType)}である）`,
        positionOf(aggregate.nameNode ?? aggregate.entityNode),
      );
    }
  }

  for (const { field: name, fieldNode, condition } of aggregate.where) {
    const field = source.fields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      report(
        "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
        `computed ${draft.name} の集計の where の項目 ${name} が、集計元 entity ${aggregate.entity} に無い`,
        positionOf(fieldNode),
      );
      continue;
    }
    const declaration = field.declaration;
    const kind = declaration === null ? null : fieldKind(declaration);
    // 期間の条件（`within`。M1.4）は、**集計元の `date` の項目だけ**を指せる。
    // 出力先のレコードを持たない集計（`scope: app`・`type: groups`）でも書ける（`this` を要らない）
    if (condition.op === "within") {
      if (kind !== "date") {
        report(
          "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
          `computed ${draft.name} の集計の where の ${name} は、${aggregate.entity} の日付（date）の項目でなければならない（期間で絞れるのは日付だけである）`,
          positionOf(fieldNode),
        );
      }
      continue;
    }
    // `this`（出力先のレコードの ID）と比べる条件は、出力先のレコードが要る（M1.4）
    if (outputEntity === null) {
      report(
        "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
        `computed ${draft.name} の集計の where に this は書けない（出力先のレコードが無い）`,
        positionOf(fieldNode),
      );
      continue;
    }
    const target = declaration === null ? null : fieldTarget(declaration);
    const pointsToOutput = target === outputEntity.name;
    const ok =
      condition.op === "equals"
        ? kind === "ref" && pointsToOutput
        : kind === "list" && target !== null && pointsToOutput;
    if (!ok) {
      const expected = condition.op === "equals" ? "参照（ref）" : "参照の並び（list of）";
      report(
        "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
        `computed ${draft.name} の集計の where の ${name} は、${outputEntity.name} を指す${expected}でなければならない`,
        positionOf(fieldNode),
      );
    }
  }
}

/**
 * 精算（`settle`。M1.2）の意味を検査する。支出の entity が実在すること、額の項目が数であること、
 * 払った人と割る人が**精算する entity を指す参照**であることを見る。
 *
 * **余りの配賦は見ない**——それは語彙ではなく店頭の内部規約（Q18-5。src/allocation.ts）である。
 */
function checkSettle(
  draft: ComputedDraft,
  settle: SettleDraft,
  members: EntityDraft,
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  const label = `computed ${draft.name}`;
  const source = index.get(settle.expense);
  if (source === undefined) {
    report(
      "LOGIC_ENTITY_NOT_FOUND",
      `${label} の精算の支出の entity ${settle.expense} が宣言に無い`,
      positionOf(settle.expenseNode),
    );
    // 支出の entity が無ければ、その項目も見られない（誤りを重ねない）
    return;
  }

  const declaredType = (name: string): FieldDeclaration | null => {
    const field = source.fields.find((candidate) => candidate.name === name);
    return field === undefined ? null : field.declaration;
  };
  const pointsToMembers = (declaration: FieldDeclaration | null, kind: FieldKind): boolean =>
    declaration !== null && fieldKind(declaration) === kind && fieldTarget(declaration) === members.name;

  const amount = declaredType(settle.amount);
  if (amount === null || fieldKind(amount) !== "number") {
    report(
      "LOGIC_SETTLE_AMOUNT_NOT_NUMBER",
      `${label} の精算の額 ${settle.expense}.${settle.amount} は、支出の entity の数の項目でなければならない`,
      positionOf(settle.amountNode),
    );
  }
  if (!pointsToMembers(declaredType(settle.payer), "ref")) {
    report(
      "LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH",
      `${label} の精算の払った人 ${settle.expense}.${settle.payer} は、${members.name} を指す参照（ref）でなければならない`,
      positionOf(settle.payerNode),
    );
  }
  if (!pointsToMembers(declaredType(settle.shares), "list")) {
    report(
      "LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH",
      `${label} の精算の割る人 ${settle.expense}.${settle.shares} は、${members.name} を指す参照の並び（list of）でなければならない`,
      positionOf(settle.sharesNode),
    );
  }
}

/**
 * 精算（`settle`）は、**entity に 1 つだけ**書ける。応答の精算の欄は 1 つであり、2 つ書かれても
 * 2 つ目は読まれない——**黙って捨てずに断る**（読めない行を捨てると、書いた宣言が無かったことになる）。
 */
function checkSettleSlots(computed: readonly ComputedDraft[], report: Report): void {
  const declared = new Set<string>();
  for (const draft of computed) {
    if (draft.settle === null || draft.entity === "") continue;
    if (declared.has(draft.entity)) {
      report(
        "LOGIC_COMPUTED_DUPLICATE_NAME",
        `entity ${draft.entity} に精算（settle）が 2 つある（精算は entity に 1 つだけ書ける）`,
        positionOf(draft.nameNode ?? { line: 1, column: 1 }),
      );
      continue;
    }
    declared.add(draft.entity);
  }
}

/**
 * ダッシュボード（`type: dashboard`）の部品を検査する（M1.4。Issue #180・#181・#182）。
 *
 * **指せる先は、部品の種類で決まる。** ダッシュボードは**行を並べない**ので、数値・棒・円には
 * 行ごとの計算を載せる場所が無い（どの行の値かが決まらない）。
 *   - 数値の部品（`number`）… **アプリ全体の集計（`scope: app`）の計算**（1 つの数）
 *   - 棒（`bar`）・円（`pie`）… **見出しごとの集計（`type: groups`）の計算**（見出しと値の組の並び）
 *
 * **2 つを別のコードにする**（`UI_DASHBOARD_VALUE_NOT_APP_SCOPE` と `UI_DASHBOARD_VALUE_NOT_GROUPS`）
 * ——指す先が別物であり、1 つの誤りを 2 つに数えないためである。
 *
 * **順位の部品**は、鍵（`name`）が 1 つの一覧の中で重複せず、基準（`by`）がその entity の行ごとの数の
 * 計算であり（アプリ全体の集計は指せない）、`by` が `show` に含まれることを見る（`checkRankingPart`）。
 */
function checkDashboardWidgets(
  view: ViewDraft,
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  const parts = view.widgets ?? [];
  // 順位の部品の鍵（`name`）は、応答の `ranking` の欄を引く名前である（M1.4。Issue #182）。
  // **1 つの一覧の中で重複させない**（欠落・形は読み取りの時点で断っている）
  checkDuplicates(
    parts
      .filter((part) => part.kind === "ranking")
      .map((part) => ({ name: part.name, nameNode: part.nameNode })),
    "UI_RANKING_NAME_DUPLICATE",
    `view ${view.name} の widgets の鍵`,
    report,
  );
  for (const part of parts) {
    // 種類を読めなかった部品・必須の欄を読めなかった部品は、ここでは見ない（1 つの誤りを 2 つのコードに数えない）
    if (part.malformed || part.kind === null) continue;
    if (part.kind === "number") {
      const isAppScope = computed.some(
        (entry) => entry.scope === "app" && entry.settle === null && !entry.malformed && entry.name === part.value,
      );
      if (!isAppScope) {
        report(
          "UI_DASHBOARD_VALUE_NOT_APP_SCOPE",
          `view ${view.name} の widgets の ${part.value} が、アプリ全体の集計（scope: app）の計算でない`,
          positionOf(part.valueNode),
        );
      }
      continue;
    }
    if (part.kind === "bar" || part.kind === "pie") {
      // 棒（`bar`）・円（`pie`）は、見出しごとの集計（`type: groups`）を指さなければならない
      const isGroups = computed.some(
        (entry) => entry.type === "groups" && !entry.malformed && entry.name === part.value,
      );
      if (!isGroups) {
        report(
          "UI_DASHBOARD_VALUE_NOT_GROUPS",
          `view ${view.name} の widgets の ${part.kind} が指す ${part.value} は、見出しごとの集計（type: groups）の計算でない`,
          positionOf(part.valueNode),
        );
      }
      continue;
    }
    checkRankingPart(view, part, computed, index, report);
  }
}

/**
 * 順位の部品（`type: ranking`。M1.4。Issue #182）の意味を検査する。
 *
 * - **基準（`by`）は、並べる entity の行ごとの数の計算**（`computed`）でなければならない。
 *   **アプリ全体の集計（`scope: app`）は指せない**（行ごとの値が無く、どの行を上位にするか決まらない）。
 *   実在しない名前・行ごとの計算でない名前も、同じ `UI_RANKING_BY_NOT_ROW_VALUE` で断る
 * - **`by` は出す項目（`show`）に含めなければならない**（基準も出す項目の 1 つとして見せる）——
 *   含めなければ `UI_RANKING_BY_NOT_SHOWN`
 * - **出す項目は、その entity の項目か、行ごとの値になる計算**でなければならない（`UI_FIELD_NOT_FOUND`）
 */
function checkRankingPart(
  view: ViewDraft,
  part: ViewPartDraft,
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  const label = `view ${view.name} の widgets[${part.name}]`;
  const entity = index.get(part.entity);
  if (entity === undefined) {
    report(
      "UI_ENTITY_NOT_FOUND",
      `${label} の entity ${part.entity} が宣言に無い`,
      positionOf(part.entityNode ?? NO_NODE),
    );
    // entity が無ければ、基準も出す項目も見られない（誤りを重ねない）
    return;
  }
  // 基準（`by`）は、**その entity の行ごとの数の計算**である（アプリ全体の集計は entity を持たないので一致しない）
  const by = computed.find(
    (entry) =>
      entry.entity === entity.name &&
      entry.name === part.by &&
      entry.settle === null &&
      entry.type === "number" &&
      !entry.malformed,
  );
  if (by === undefined) {
    report(
      "UI_RANKING_BY_NOT_ROW_VALUE",
      `${label} の by の ${part.by} が、${entity.name} の行ごとの数の計算でない（アプリ全体の集計は指せない）`,
      positionOf(part.byNode ?? NO_NODE),
    );
    // 基準そのものを指せていないので、`show` に含まれているかは見ない（1 つの誤りを 2 つのコードにしない）
  } else if (!(part.show ?? []).some((field) => field.name === part.by)) {
    report(
      "UI_RANKING_BY_NOT_SHOWN",
      `${label} の by の ${part.by} が、出す項目（show）に無い`,
      positionOf(part.byNode ?? NO_NODE),
    );
  }
  // 出す項目は、その entity の項目か、**行ごとの値になる**計算である（精算と、真偽と、見出しごとの集計は出せない）
  for (const field of part.show ?? []) {
    const isField = entity.fields.some((candidate) => candidate.name === field.name);
    const isComputed = computed.some(
      (entry) =>
        entry.entity === entity.name &&
        entry.name === field.name &&
        entry.settle === null &&
        entry.type !== "boolean" &&
        entry.type !== "groups",
    );
    if (!isField && !isComputed) {
      report(
        "UI_FIELD_NOT_FOUND",
        `${label} の show の ${field.name} が、entity ${entity.name} の項目にも計算にも無い`,
        positionOf(field.node),
      );
    }
  }
}

/**
 * **アプリ全体の計算（`scope: app`。M1.4。Issue #177）**の意味を検査する。
 * entity に属さないので、項目との名前の重なりも、精算も見ない（精算は読み取りの時点で断る）。
 * 参照できるのは**ほかのアプリ全体の計算だけ**である。
 */
function checkAppComputed(
  draft: ComputedDraft,
  index: ReadonlyMap<string, EntityDraft>,
  computed: readonly ComputedDraft[],
  report: Report,
): void {
  if (isOneOf(RESERVED_NAMES, draft.name)) {
    report(
      "LOGIC_COMPUTED_NAME_RESERVED",
      `computed の名前 ${draft.name} は店頭が付ける値の名前である`,
      positionOf(draft.nameNode ?? draft.expressionNode),
    );
    return;
  }
  if (draft.malformed) return;
  // アプリ全体の値は数である——真偽（`boolean`）は行ごとの強調（`highlight`）が指すためだけに使う（M1.3）
  if (draft.type === "boolean") {
    report(
      "LOGIC_COMPUTED_TYPE_MISMATCH",
      `computed ${draft.name} は scope: app である（値は数である。type は number を書く）`,
      positionOf(draft.nameNode ?? draft.expressionNode),
    );
    return;
  }
  if (draft.aggregate !== null) {
    checkAggregate(draft, draft.aggregate, null, index, computed, report);
    return;
  }
  if (draft.expression === "") return;
  const checked = checkAppExpression(
    draft.expression,
    draft.expressionNode,
    `computed ${draft.name}`,
    computed,
    report,
  );
  if (checked === null) return;
  // 依存は entity を持たない（アプリ全体の計算の名前で引く）。循環の検査がここを辿る
  draft.dependencies = checked.names.map((name) => ({ entity: "", name }));
  const declared = isOneOf(COMPUTED_TYPES, draft.type) ? (draft.type as ComputedType) : null;
  if (declared !== null && checked.type !== "unknown" && checked.type !== declared) {
    report(
      "LOGIC_COMPUTED_TYPE_MISMATCH",
      `computed ${draft.name} の type は ${declared} だが、式は${typeName(checked.type)}になる`,
      positionOf(draft.expressionNode),
    );
  }
}

/**
 * **見出しごとの集計（`type: groups`。M1.4。Issue #179）**の意味を検査する。
 * entity に属さない（`scope` も `entity` も持たない）ので、項目との名前の重なりも、精算も見ない。
 * 集計元・`groupBy` の対象・`last` は `checkAggregate`（`groups = true`）が見る。
 */
function checkGroupComputed(
  draft: ComputedDraft,
  index: ReadonlyMap<string, EntityDraft>,
  computed: readonly ComputedDraft[],
  report: Report,
): void {
  if (isOneOf(RESERVED_NAMES, draft.name)) {
    report(
      "LOGIC_COMPUTED_NAME_RESERVED",
      `computed の名前 ${draft.name} は店頭が付ける値の名前である`,
      positionOf(draft.nameNode ?? draft.expressionNode),
    );
    return;
  }
  // 読み取りの時点で断った（式・集計・精算の重複や不足）ものは、意味の検査を重ねない
  if (draft.malformed) return;
  if (draft.aggregate === null) {
    report(
      "LOGIC_COMPUTED_TYPE_MISMATCH",
      `computed ${draft.name} は type: groups である（集計に groupBy を書く）`,
      positionOf(draft.nameNode ?? draft.expressionNode),
    );
    return;
  }
  checkAggregate(draft, draft.aggregate, null, index, computed, report, true);
}

function checkComputed(
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  for (const draft of computed) {
    // 見出しごとの集計（`type: groups`。M1.4。Issue #179）は entity にも scope にも属さない
    if (draft.type === "groups") {
      checkGroupComputed(draft, index, computed, report);
      continue;
    }
    // アプリ全体の計算（`scope: app`。M1.4）は entity に属さないので、別の検査をする
    if (draft.scope === "app") {
      checkAppComputed(draft, index, computed, report);
      continue;
    }
    const entity = index.get(draft.entity);
    if (entity === undefined) {
      report(
        "LOGIC_ENTITY_NOT_FOUND",
        `computed ${draft.name} の entity ${draft.entity} が宣言に無い`,
        positionOf(draft.entityNode),
      );
      continue;
    }
    const conflict = entity.fields.find((field) => field.name === draft.name);
    if (conflict !== undefined) {
      report(
        "LOGIC_COMPUTED_NAME_CONFLICT",
        `computed の名前 ${draft.name} が、同じ entity ${entity.name} の項目の名前と重なっている`,
        positionOf(draft.nameNode ?? conflict.node),
      );
      continue;
    }
    if (isOneOf(RESERVED_NAMES, draft.name)) {
      report(
        "LOGIC_COMPUTED_NAME_RESERVED",
        `computed の名前 ${draft.name} は店頭が付ける値の名前である`,
        positionOf(draft.nameNode ?? draft.expressionNode),
      );
      continue;
    }
    // 読み取りの時点で断った（式・集計・精算の重複や不足）ものは、意味の検査を重ねない
    if (draft.malformed) continue;
    if (draft.settle !== null) {
      checkSettle(draft, draft.settle, entity, index, report);
      continue;
    }
    if (draft.aggregate !== null) {
      // 集計（`aggregate`）は数を返す。**真偽（`boolean`）は式で求める計算だけである**（M1.3）——
      // 真偽の計算は強調（`highlight`）が指すためにだけ使い、集計では作れない
      if (draft.type === "boolean") {
        report(
          "LOGIC_COMPUTED_TYPE_MISMATCH",
          `computed ${draft.name} は集計なので数を返す（type は number である。boolean は書けない）`,
          positionOf(draft.nameNode ?? draft.expressionNode),
        );
        continue;
      }
      checkAggregate(draft, draft.aggregate, entity, index, computed, report);
      continue;
    }
    if (draft.expression === "") continue;
    const checked = checkExpression(
      draft.expression,
      draft.expressionNode,
      `computed ${draft.name}`,
      entity,
      computed,
      index,
      report,
    );
    if (checked === null) continue;
    // 自分自身の名前も残す（`a` が `a` を参照する自己循環を、循環の検査で見つけるため）
    draft.dependencies = checked.names.map((name) => ({ entity: draft.entity, name }));
    const declared = isOneOf(COMPUTED_TYPES, draft.type) ? (draft.type as ComputedType) : null;
    if (declared !== null && checked.type !== "unknown" && checked.type !== declared) {
      report(
        "LOGIC_COMPUTED_TYPE_MISMATCH",
        `computed ${draft.name} の type は ${declared} だが、式は${typeName(checked.type)}になる`,
        positionOf(draft.expressionNode),
      );
    }
  }
}

/** 強く連結した部分（Tarjan）。2 つ以上、または自分自身へ戻る辺があれば循環である */
function stronglyConnected<T>(nodes: readonly T[], edges: (node: T) => readonly T[]): readonly (readonly T[])[] {
  const order = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const components: T[][] = [];
  let counter = 0;

  const connect = (node: T): void => {
    order.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges(node)) {
      if (!order.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, order.get(next) ?? 0));
      }
    }
    if (low.get(node) !== order.get(node)) return;
    const component: T[] = [];
    for (;;) {
      const popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      component.push(popped);
      if (popped === node) break;
    }
    components.push(component);
  };

  for (const node of nodes) {
    if (!order.has(node)) connect(node);
  }
  return components;
}

/**
 * 計算どうしの参照の循環を断る。**entity をまたぐ**（集計の対象が別の entity の計算である）ことも、
 * **アプリ全体の計算**（`scope: app`）が別のアプリ全体の計算を参照することもあるので、
 * 宣言全体を 1 つのグラフにして見る（M1.2・M1.4）。辺は「同じ entity の式の参照」と
 * 「集計の対象の計算」である（アプリ全体の依存は entity が空である）。
 */
function checkCycles(computed: readonly ComputedDraft[], report: Report): void {
  // アプリ全体の計算は entity を持たないので、空の entity を名前空間にする（`\u0000名前`）
  const keyOf = (draft: ComputedDraft): string =>
    `${draft.scope === "app" ? "" : draft.entity}\u0000${draft.name}`;
  const labelOf = (draft: ComputedDraft): string =>
    draft.scope === "app" ? `app.${draft.name}` : `${draft.entity}.${draft.name}`;
  const byKey = new Map<string, ComputedDraft>();
  for (const draft of computed) {
    if (draft.name === "") continue;
    if (draft.entity === "" && draft.scope !== "app") continue;
    const key = keyOf(draft);
    if (!byKey.has(key)) byKey.set(key, draft);
  }
  const nodes = [...byKey.values()];
  const edges = (node: ComputedDraft): readonly ComputedDraft[] =>
    node.dependencies
      .map((dependency) => byKey.get(`${dependency.entity}\u0000${dependency.name}`))
      .filter((candidate): candidate is ComputedDraft => candidate !== undefined);
  for (const component of stronglyConnected(nodes, edges)) {
    const first = component[0];
    const selfLoop = component.length === 1 && first !== undefined && edges(first).includes(first);
    if (component.length === 1 && !selfLoop) continue;
    const labels = component.map((draft) => labelOf(draft));
    for (const draft of component) {
      const where =
        labels.length === 1
          ? `${labels[0]} が自分自身を参照している`
          : `${labels.join(" と ")} が互いを参照している`;
      report(
        "LOGIC_COMPUTED_CYCLE",
        `computed の参照が循環している（${where}）`,
        positionOf(draft.nameNode ?? draft.expressionNode),
      );
    }
  }
}

// ── 4. 宣言を組み立てる ────────────────────────────────────────

/**
 * 読み取った `set` を、宣言の形（`ActionSet`）にする（M1.3）。**数の項目だけ数にする**——
 * YAML はすべて文字列として読むので、ここで型に合わせて読み直す（検査はもう通っている）。
 */
function buildActionSet(values: readonly ActionSetDraft[]): ActionSet {
  const set: Record<string, ActionSetValue> = {};
  for (const assignment of values) {
    set[assignment.field] = NUMBER_CONSTANT.test(assignment.text)
      ? Number(assignment.text)
      : assignment.text;
  }
  return set;
}

/** 読み取った集計を、宣言の形（`Aggregate`）にする。`where` は項目 → 比べ方（`op` を持つオブジェクト）にする */
function buildAggregate(draft: AggregateDraft): Aggregate {
  const where: Record<string, AggregateWhereCondition> = {};
  for (const condition of draft.where) where[condition.field] = condition.condition;
  return {
    kind: draft.kind,
    entity: draft.entity,
    name: draft.name,
    where,
    // 見出しごとの集計（M1.4。Issue #179）。**書いてあるときだけ入れる**（従来の宣言に欄を足さない）
    ...(draft.groupBy === null
      ? {}
      : { groupBy: { field: draft.groupBy.field, month: draft.groupBy.month } }),
    ...(draft.last === null ? {} : { last: draft.last }),
  };
}

/**
 * 読み取った部品を、宣言の形（`ViewPart`）にする。**表示名・単位・件数の上限は書いてあるときだけ入れる**
 * （M1.4。Issue #180・#181・#182）。**種類を読めなかった部品があれば `null`**（組み立てない）。
 */
function buildWidgets(drafts: readonly ViewPartDraft[]): readonly ViewPart[] | null {
  const parts: ViewPart[] = [];
  for (const draft of drafts) {
    if (draft.kind === null) return null;
    const label = draft.label === null ? {} : { label: draft.label };
    // 数値（`number`）・棒（`bar`）・円（`pie`）は、`value` で計算を指す（書ける欄も同じである）
    if (draft.kind === "number" || draft.kind === "bar" || draft.kind === "pie") {
      const common = {
        value: draft.value,
        ...label,
        ...(draft.unit === null ? {} : { unit: draft.unit }),
      };
      if (draft.kind === "bar") parts.push({ type: "bar", ...common });
      else if (draft.kind === "pie") parts.push({ type: "pie", ...common });
      else parts.push({ type: "number", ...common });
      continue;
    }
    parts.push({
      type: "ranking",
      name: draft.name,
      entity: draft.entity,
      by: draft.by,
      show: (draft.show ?? []).map((field) => field.name),
      ...label,
      ...(draft.limit === null ? {} : { limit: draft.limit }),
    });
  }
  return parts;
}

function buildSpec(drafts: Drafts): AppSpec | null {
  const { entities, views, actions, validations, computed, permissions, identityMode } = drafts;
  const built: Entity[] = [];
  for (const entity of entities) {
    const fields: Record<string, FieldDeclaration> = {};
    for (const field of entity.fields) {
      if (field.declaration === null) return null;
      fields[field.name] = field.declaration;
    }
    built.push({ name: entity.name, fields });
  }
  const builtComputed: Computed[] = [];
  for (const draft of computed) {
    if (draft.malformed) return null;
    // 表示名（`label`。M1.3。Issue #176）は、書いてあるときだけ入れる（無ければ識別子のまま）
    const label = draft.label === null ? {} : { label: draft.label };
    if (draft.settle !== null) {
      // 精算は数ではなく送金の並びを返すので、`type` を持たない（docs/semantics.md「settle」）
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
        ...label,
        settle: {
          expense: draft.settle.expense,
          amount: draft.settle.amount,
          payer: draft.settle.payer,
          shares: draft.settle.shares,
        },
      });
      continue;
    }
    if (!isOneOf(COMPUTED_TYPES, draft.type)) return null;
    // 見出しごとの集計（`type: groups`。M1.4。Issue #179）は **entity も scope も持たない**
    // （groupBy が分ける対象を持つ）。`groupBy` の無い groups は組み立てない
    if (draft.type === "groups") {
      if (draft.aggregate === null || draft.aggregate.groupBy === null) return null;
      builtComputed.push({
        name: draft.name,
        ...label,
        aggregate: buildAggregate(draft.aggregate),
        type: "groups",
      });
      continue;
    }
    // アプリ全体の計算（`scope: app`。M1.4）は **entity を持たない**（どのレコードにも属さない）
    if (draft.scope === "app") {
      builtComputed.push(
        draft.aggregate === null
          ? {
              name: draft.name,
              ...label,
              scope: draft.scope,
              expression: draft.expression,
              type: draft.type as ComputedType,
            }
          : {
              name: draft.name,
              ...label,
              scope: draft.scope,
              aggregate: buildAggregate(draft.aggregate),
              type: draft.type as ComputedType,
            },
      );
      continue;
    }
    if (draft.aggregate === null) {
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
        ...label,
        expression: draft.expression,
        type: draft.type as ComputedType,
      });
    } else {
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
        ...label,
        aggregate: buildAggregate(draft.aggregate),
        type: draft.type as ComputedType,
      });
    }
  }
  // 種類（`type`）と、種類ごとの欄（`show`・`columns`・`highlight`・`filters`・`widgets`）は、書いてある
  // ときだけ入れる（M1.1 の宣言に欄を足さない）。**ダッシュボードは `entity` を持たない**（M1.4）——
  // 行を並べないので、正規化した JSON にも `entity` を現さない
  const builtViews: View[] = [];
  for (const draft of views) {
    // 部品（`widgets`）はダッシュボードのときだけある。**種類を読めなかった部品があれば組み立てない**
    let widgets: readonly ViewPart[] | undefined;
    if (draft.widgets !== null) {
      const built = buildWidgets(draft.widgets);
      if (built === null) return null;
      widgets = built;
    }
    builtViews.push({
      name: draft.name,
      ...(draft.entity === null ? {} : { entity: draft.entity }),
      ...(draft.type === null ? {} : { type: draft.type }),
      ...(draft.show === null ? {} : { show: draft.show.map((field) => field.name) }),
      ...(draft.columns === null ? {} : { columns: draft.columns.name }),
      ...(draft.highlight === null ? {} : { highlight: draft.highlight.name }),
      ...(draft.filters === null ? {} : { filters: draft.filters.map((field) => field.name) }),
      ...(widgets === undefined ? {} : { widgets }),
    });
  }
  return {
    entities: built,
    views: builtViews,
    // 種類（`kind`）と、M1.3 の `set`・`when` は**書いてあるときだけ**入れる
    // （M1.1・M1.2 の宣言に欄を足さない。`kind` の省略は create である）
    actions: actions.map((draft) => ({
      name: draft.name,
      entity: draft.entity,
      ...(draft.kind === null ? {} : { kind: draft.kind }),
      ...(draft.set === null ? {} : { set: buildActionSet(draft.set) }),
      ...(draft.when === null ? {} : { when: draft.when }),
    })),
    validations: validations.map((draft) => ({
      name: draft.name,
      entity: draft.entity,
      expression: draft.expression,
      // 文言は書いてあるときだけ入れる（M1.1 の宣言に欄を足さない）
      ...(draft.message === null ? {} : { message: draft.message }),
    })),
    computed: builtComputed,
    permissions: permissions.map((draft) => ({
      name: draft.name as AppSpec["permissions"][number]["name"],
      subject: draft.subject as AppSpec["permissions"][number]["subject"],
    })),
    minIdentity: { mode: identityMode as AppSpec["minIdentity"]["mode"] },
  };
}

// ── 5. 公開の入口 ──────────────────────────────────────────────

/**
 * 検査が読み取った宣言。診断が 1 つも無いときだけ、ここから AppSpec を組み立てる。
 * 途中で読めなかった場合は null（読めなかったことは、診断として既に記録されている）。
 */
interface Drafts {
  readonly entities: readonly EntityDraft[];
  readonly views: readonly ViewDraft[];
  readonly actions: readonly ActionDraft[];
  readonly validations: readonly ValidationDraft[];
  readonly computed: readonly ComputedDraft[];
  readonly permissions: readonly PermissionDraft[];
  readonly identityMode: string;
}

function readIdentityMode(root: YamlMap): string {
  const entry = entryOf(root, "minIdentity");
  if (entry?.value.kind !== "map") return "";
  const mode = entryOf(entry.value, "mode");
  return mode?.value.kind === "scalar" ? mode.value.text : "";
}

/** 宣言を読んで、欄ごとに検査する。読めなければ null（例外は投げない） */
function inspect(source: string, report: Report): Drafts | null {
  const { node, failure } = readYaml(source);
  if (failure !== null) {
    report("SHAPE_YAML_INVALID", `YAML を読めない: ${failure.message}`, {
      line: failure.line,
      column: failure.column,
    });
    return null;
  }
  if (node === null) {
    report("SHAPE_YAML_INVALID", "宣言が空である", { line: 1, column: 1 });
    return null;
  }
  if (node.kind !== "map") {
    report("SHAPE_VALUE_INVALID", "宣言は「`欄: 値`」を並べた写像で書く", positionOf(node));
    return null;
  }

  const root = node;
  reportDuplicateKeys(root, "宣言", report);
  for (const entry of root.entries) {
    if (!isOneOf(APPSPEC_SECTIONS, entry.key)) {
      report("SHAPE_KEY_UNKNOWN", `欄 ${entry.key} は書けない（M1.1 の語彙に無い）`, {
        line: entry.keyLine,
        column: entry.keyColumn,
      });
    }
  }
  for (const section of APPSPEC_SECTIONS) {
    if (entriesOf(root, section).length === 0) {
      report("SHAPE_KEY_MISSING", `欄 ${section} が無い（7 欄すべてを書く。中身が無ければ [] と書く）`, {
        line: root.line,
        column: root.column,
      });
    }
  }

  const entities = readEntities(collectItems(root, "entities", report), report);
  const views = readViews(collectItems(root, "views", report), report);
  const actions = readActions(collectItems(root, "actions", report), report);
  const validations = readValidations(collectItems(root, "validations", report), report);
  const computed = readComputed(collectItems(root, "computed", report), report);
  const permissions = readPermissions(collectItems(root, "permissions", report), report);
  checkMinIdentity(entryOf(root, "minIdentity"), report);

  const index = entityIndex(entities);
  // 参照（`ref`・参照 list）の参照先の entity が、宣言の中に実在するか（M1.2）
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.target === null || index.has(field.target)) continue;
      report(
        "DATA_REF_TARGET_NOT_FOUND",
        `entity ${entity.name} の項目 ${field.name} の参照先 entity ${field.target} が宣言に無い`,
        positionOf(field.targetNode ?? entity.node),
      );
    }
  }
  for (const view of views) {
    // ダッシュボード（`type: dashboard`）は**行を並べない**——entity の実在を見ず、部品が指す値を見る（M1.4。Issue #180）
    if (view.type === "dashboard") {
      checkDashboardWidgets(view, computed, index, report);
      continue;
    }
    const entity = index.get(view.entity ?? "");
    if (entity === undefined) {
      report(
        "UI_ENTITY_NOT_FOUND",
        `view ${view.name} の entity ${view.entity} が宣言に無い`,
        positionOf(view.entityNode ?? view.nameNode ?? { line: 1, column: 1 }),
      );
      // entity が無ければ、表に出す名前も見られない（誤りを重ねない）
      continue;
    }
    // 表に出す名前は、その entity の項目か、**行ごとの値になる**計算でなければならない（M1.2）。
    // 精算（settle）は送金の並びを返し、真偽（`boolean`）の計算は強調（`highlight`）の判定にだけ使うので、
    // どちらも列に無い（data-api の computedNamesOf と同じ扱いである）
    for (const field of view.show ?? []) {
      const isField = entity.fields.some((candidate) => candidate.name === field.name);
      const isComputed = computed.some(
        (entry) =>
          entry.entity === entity.name &&
          entry.name === field.name &&
          entry.settle === null &&
          // 真偽（強調が指す）と、見出しごとの集計（並びを返す）は列に出さない（M1.3・M1.4）
          entry.type !== "boolean" &&
          entry.type !== "groups",
      );
      if (!isField && !isComputed) {
        report(
          "UI_FIELD_NOT_FOUND",
          `view ${view.name} の show の ${field.name} が、entity ${entity.name} の項目にも計算にも無い`,
          positionOf(field.node),
        );
      }
    }
    // ボードの `columns` は、その entity の**選択肢（`enum`）の項目**を指さなければならない（M1.3）。
    // 列の並びは、その `options` に書いた順である（key を読むのは画面である）
    const columns = view.columns;
    if (columns !== null) {
      const field = entity.fields.find((candidate) => candidate.name === columns.name);
      const isEnum = field !== undefined && field.declaration !== null && isEnumField(field.declaration);
      if (!isEnum) {
        report(
          "UI_BOARD_COLUMNS_NOT_ENUM",
          `view ${view.name} の columns の ${columns.name} が、entity ${entity.name} の選択肢（enum）の項目でない`,
          positionOf(columns.node),
        );
      }
    }
    // ボードの `highlight` は、その entity の**真偽を返す計算**を指さなければならない（M1.3）。
    // 真偽の計算は行ごとの値なので、精算（settle）ではない
    if (view.highlight !== null) {
      const highlightName = view.highlight.name;
      const isBoolean = computed.some(
        (entry) =>
          entry.entity === entity.name &&
          entry.name === highlightName &&
          entry.settle === null &&
          entry.type === "boolean",
      );
      if (!isBoolean) {
        report(
          "UI_HIGHLIGHT_NOT_BOOLEAN",
          `view ${view.name} の highlight の ${highlightName} が、entity ${entity.name} の真偽を返す計算でない`,
          positionOf(view.highlight.node),
        );
      }
    }
    // 絞り込み（`filters`。M1.3）は、**`show` に並べた名前のうち、選択肢（`enum`）か参照（`ref`）の
    // 項目だけ**を指さなければならない——値の候補を宣言から機械で出せるのが、この 2 つの型だけだから
    // である（docs/semantics.md「filters」）。`show` を書いていなければ、項目（宣言の順）が並ぶ
    if (view.filters !== null) {
      const shown =
        view.show === null ? entity.fields.map((field) => field.name) : view.show.map((field) => field.name);
      for (const filter of view.filters) {
        if (!shown.includes(filter.name)) {
          report(
            "UI_FILTER_FIELD_NOT_SHOWN",
            `view ${view.name} の filters の ${filter.name} が、show に無い`,
            positionOf(filter.node),
          );
          // `show` に無い名前は、種類を見るまでもない（1 つの誤りを 2 つのコードにしない）
          continue;
        }
        const field = entity.fields.find((candidate) => candidate.name === filter.name);
        const filterable =
          field !== undefined &&
          field.declaration !== null &&
          (isEnumField(field.declaration) || fieldKind(field.declaration) === "ref");
        if (!filterable) {
          report(
            "UI_FILTER_FIELD_NOT_FILTERABLE",
            `view ${view.name} の filters の ${filter.name} が、entity ${entity.name} の選択肢（enum）でも参照（ref）でもない`,
            positionOf(filter.node),
          );
        }
      }
    }
  }
  checkDuplicates(
    actions.map((action) => ({ name: action.name, nameNode: action.nameNode })),
    "LOGIC_ACTION_DUPLICATE_NAME",
    "action",
    report,
  );

  checkActions(actions, computed, index, report);
  checkValidations(validations, computed, index, report);
  checkComputed(computed, index, report);
  checkSettleSlots(computed, report);
  checkCycles(computed, report);

  return { entities, views, actions, validations, computed, permissions, identityMode: readIdentityMode(root) };
}

/**
 * **画面から届くか**を検査する（M1.4。Issue #201）。宣言が**それ以外の検査をすべて通った**ときにだけ見る
 * ——ここは「正しい宣言なのに、API では動くのに画面では入力できない」という**書き漏れ**を落とす規則で、
 * ほかの誤りが 1 つでもある宣言では、そもそも画面の形が決まらない（1 つの誤りを 2 つに数えない）。
 *
 * 画面（host）は、次の 2 つを**view の直下の `entity`** を手がかりに決めている
 * （ダッシュボードの部品が持つ `entity` は数えない——部品は入力欄を出さない）。
 *   1. 参照（`ref`・参照の並び）の候補 … **参照先の entity** を `entity` に持つ view の行
 *   2. 操作（追加・書き換え・削除）のボタンとフォーム … **その操作の entity** を `entity` に持つ view
 *
 * 満たさないと、参照は選べず、操作は押せない（`UI_REF_TARGET_NOT_SHOWN`・`UI_ACTION_NOT_REACHABLE`）。
 */
function checkReachability(view: Drafts, report: Report): void {
  const index = entityIndex(view.entities);
  // 「`entity` に持つ view」は、**view の直下の `entity` だけ**を数える（部品の `entity` は数えない）
  const shown = new Set(
    view.views.map((entry) => entry.entity).filter((entity): entity is string => entity !== null),
  );
  for (const entity of view.entities) {
    for (const field of entity.fields) {
      // 参照先の entity が実在しない（`DATA_REF_TARGET_NOT_FOUND`）ときは重ねない
      if (field.target === null || !index.has(field.target) || shown.has(field.target)) continue;
      report(
        "UI_REF_TARGET_NOT_SHOWN",
        `entity ${entity.name} の項目 ${field.name} が参照する entity ${field.target} を、entity に持つ view が 1 つも無い（画面で選べない）`,
        positionOf(field.node),
      );
    }
  }
  for (const action of view.actions) {
    // 操作の entity が実在しない（`LOGIC_ENTITY_NOT_FOUND`）ときは重ねない
    if (!index.has(action.entity) || shown.has(action.entity)) continue;
    report(
      "UI_ACTION_NOT_REACHABLE",
      `action ${action.name} の entity ${action.entity} を、entity に持つ view が 1 つも無い（画面から届かない）`,
      positionOf(action.nameNode ?? action.entityNode),
    );
  }
}

/**
 * 宣言（YAML の原文）を検査する。**式を実行せず、ストレージにも触れない。**
 *
 * - 成功：型検査済みの `AppSpec` と、空の診断
 * - 失敗：診断の配列（`code`・日本語の `message`・原文の `line` / `column`。1 始まり）
 *
 * **例外を外へ出さない。** 解析できない入力も、読めなかったという診断にして返す
 * （呼ぶ側がプロセスを落とすかどうかを決められるようにする）。
 */
export function checkSpec(source: string): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (code, message, position) => {
    diagnostics.push(diagnostic(code, message, position));
  };
  const failure = (): CheckResult => ({
    ok: false,
    diagnostics: [...diagnostics].sort(compareDiagnostics),
  });

  let drafts: Drafts | null = null;
  try {
    drafts = inspect(source, report);
  } catch (thrown) {
    // 検査の不具合でプロセスを落とさない。落ちたことを診断として返す
    report("SHAPE_CHECK_FAILED", `検査の途中で予期しない例外が出た: ${String(thrown)}`, {
      line: 1,
      column: 1,
    });
    return failure();
  }

  if (diagnostics.length > 0) return failure();
  // **画面から届くか**（M1.4。Issue #201）は、ほかの検査をすべて通った宣言にだけ重ねる
  if (drafts !== null) checkReachability(drafts, report);
  if (diagnostics.length > 0) return failure();
  const spec = drafts === null ? null : buildSpec(drafts);
  if (spec === null) {
    report("SHAPE_CHECK_FAILED", "宣言を組み立てられなかった（診断が出ていないのに型が決まらない）", {
      line: 1,
      column: 1,
    });
    return failure();
  }
  return { ok: true, diagnostics: [], spec };
}
