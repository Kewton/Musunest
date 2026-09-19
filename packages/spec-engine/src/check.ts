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
  APPSPEC_SECTIONS,
  COMPUTED_TYPES,
  DATE_VALUE_PATTERN,
  FIELD_TYPES,
  IDENTITY_MODES,
  NAME_PATTERN,
  PERMISSION_NAMES,
  PERMISSION_SUBJECTS,
  RESERVED_NAMES,
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
  type AggregateWhereOp,
  type AppSpec,
  type Computed,
  type ComputedType,
  type Entity,
  type FieldDeclaration,
  type FieldKind,
  type FieldType,
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

/** 集計の `where` の 1 つの条件（集計元の項目と、`this` との比べ方） */
interface AggregateWhereDraft {
  readonly field: string;
  readonly fieldNode: YamlNode;
  readonly op: AggregateWhereOp;
}

/** computed の集計（M1.2）。読み取った形で、意味の検査は組み立てのあとに行う */
interface AggregateDraft {
  readonly kind: "sum" | "count";
  /** 集計元の entity の名前（`sum` の `entity.name` の左、`count` の値） */
  readonly entity: string;
  readonly entityNode: YamlNode;
  /** `sum` の対象の名前。`count` では `null` */
  readonly name: string | null;
  readonly nameNode: YamlNode | null;
  readonly where: readonly AggregateWhereDraft[];
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

/** 参照の写像（`{type: ref, to: member}`・`{type: list, of: member}`）に書ける欄 */
const REF_DECLARATION_KEYS = ["type", "to", "of"] as const;

/** 選択肢の写像（`{type: enum, options: {...}, default: ...}`）に書ける欄（M1.3） */
const ENUM_DECLARATION_KEYS = ["type", "options", "default"] as const;

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

  // 選択肢（`type: enum`。M1.3）は、参照とは別の読み取りである（options と default を持つ）
  if (type === "enum") return readEnumFieldDeclaration(name, value, report);

  // 参照先の欄は、`ref` なら `to`、`list` なら `of` である。もう一方が書いてあれば断る
  const targetKey = type === "ref" ? "to" : type === "list" ? "of" : null;
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
    if (type === "list") return { declaration: "list", target: null, targetNode: null };
    if (type === "ref") {
      report("SHAPE_KEY_MISSING", `項目 ${name} の ref に to が無い（参照先の entity を書く）`, positionOf(value));
      return { declaration: null, target: null, targetNode: null };
    }
    if (isOneOf(FIELD_TYPES, type)) {
      return { declaration: type as FieldType, target: null, targetNode: null };
    }
    return unknownType(type, typeEntry.value);
  }
  if (targetEntry.value.kind !== "scalar" || targetEntry.value.text === "") {
    report(
      "SHAPE_VALUE_INVALID",
      `項目 ${name} の ${targetKey} は、参照先の entity の名前で書く`,
      positionOf(targetEntry.value),
    );
    return { declaration: null, target: null, targetNode: null };
  }
  const target = targetEntry.value.text;
  return {
    declaration: type === "ref" ? { type: "ref", to: target } : { type: "list", of: target },
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

  return {
    declaration: { type: "enum", options, ...(fallback === null ? {} : { default: fallback }) },
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

/** 表（`type: table`）の `show` の 1 つ。実在は、entity と計算を読んだあとで見る（`UI_FIELD_NOT_FOUND`） */
interface ShowFieldDraft {
  readonly name: string;
  readonly node: YamlNode;
}

/** 一覧（`views`）。M1.2 で `type`（種類）と `show`（表に出す名前の順）を足した */
interface ViewDraft extends EntityReferenceDraft {
  /** 一覧の種類。書いていなければ `null`（種類の指定の無い一覧。M1.1 と同じ） */
  readonly type: ViewType | null;
  /** 表に出す名前（宣言の順）。`show` を書いていなければ `null` */
  readonly show: readonly ShowFieldDraft[] | null;
}

/**
 * 一覧の `type` を読む（M1.2）。**語彙は閉じている**——書けるのは表（`table`）と精算の表示
 * （`settlement`）だけで、知らない種類は `SHAPE_KEY_UNKNOWN` である（`04` §7.3・§7.7）。
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

/** 表の `show`（出す項目と計算の名前。宣言の順）を読む。実在は、entity と計算を読んだあとで見る */
function readViewShow(member: MemberReader, report: Report): readonly ShowFieldDraft[] | null {
  const entry = entryOf(member.map, "show");
  if (entry === undefined) return null;
  if (entry.value.kind !== "seq") {
    report("SHAPE_VALUE_INVALID", "view の show は、出す名前を並べた [a, b] で書く", positionOf(entry.value));
    return null;
  }
  const fields: ShowFieldDraft[] = [];
  for (const item of entry.value.items) {
    if (item.kind !== "scalar" || item.text === "") {
      report("SHAPE_VALUE_INVALID", "view の show には、項目か計算の名前を書く", positionOf(item));
      continue;
    }
    fields.push({ name: item.text, node: item });
  }
  return fields;
}

/**
 * 一覧（`views`）を読む。**書ける欄は `type` が決める**（語彙は閉じている。src/spec.ts の `View`）。
 *   `type` なし … `name`・`entity`            （M1.1 と同じ。`show` は持たない）
 *   `table`     … 上に `type`・`show`
 *   `settlement`… 上に `type`                 （列の並びを持たないので `show` は書けない）
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
    member.only(type === "table" ? ["name", "entity", "type", "show"] : ["name", "entity", "type"]);

    const name = member.text("name");
    if (name !== null) checkName(name.text, "view", positionOf(name.node), report);
    const entity = member.text("entity");
    views.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
      type,
      show: type === "table" ? readViewShow(member, report) : null,
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
): { readonly entity: string; readonly node: YamlNode; readonly name: string } | null {
  if (value.kind !== "scalar" || value.text === "") {
    report("SHAPE_VALUE_INVALID", "computed の sum は「entity.項目か計算」の形で書く", positionOf(value));
    return null;
  }
  const [entity = "", name = "", ...rest] = value.text.split(".");
  if (entity === "" || name === "" || rest.length > 0) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      `computed の sum ${value.text} は「entity.項目か計算」の形で書く`,
      positionOf(value),
    );
    return null;
  }
  return { entity, node: value, name };
}

/** 集計の `where` を読む。`{項目: this}` と `{項目: {contains: this}}` だけを扱う */
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
      conditions.push({ field: condition.key, fieldNode, op: "equals" });
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
      conditions.push({ field: condition.key, fieldNode, op: "contains" });
      continue;
    }
    report(
      "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
      `集計の where の ${condition.key} は、this（参照の一致）か「contains: this」（参照の並びの包含）で書く`,
      positionOf(value),
    );
  }
  return conditions;
}

/** 集計（`aggregate`）を読む。意味の検査（対象の実在・型・where の整合）は組み立てのあとに行う */
function readAggregateDraft(value: YamlNode, report: Report): AggregateDraft | null {
  if (value.kind !== "map") {
    report(
      "SHAPE_VALUE_INVALID",
      "computed の aggregate は「sum / count / where」を並べた写像で書く",
      positionOf(value),
    );
    return null;
  }
  reportDuplicateKeys(value, "aggregate", report);
  for (const entry of value.entries) {
    if (!isOneOf(["sum", "count", "where"], entry.key)) {
      report(
        "SHAPE_KEY_UNKNOWN",
        `computed の aggregate に欄 ${entry.key} は書けない（sum と count と where だけ）`,
        { line: entry.keyLine, column: entry.keyColumn },
      );
    }
  }
  const sum = entryOf(value, "sum");
  const count = entryOf(value, "count");
  if (sum !== undefined && count !== undefined) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      "computed の aggregate に sum と count を同時に書けない（どちらか一方である）",
      positionOf(count.value),
    );
    return null;
  }
  if (sum === undefined && count === undefined) {
    report(
      "LOGIC_AGGREGATE_FORM_INVALID",
      "computed の aggregate には sum（合計）か count（行数）のどちらか一方を書く",
      positionOf(value),
    );
    return null;
  }
  const where = readWhereDraft(entryOf(value, "where"), report);
  if (sum !== undefined) {
    const target = readAggregateTarget(sum.value, report);
    if (target === null) return null;
    return {
      kind: "sum",
      entity: target.entity,
      entityNode: target.node,
      name: target.name,
      nameNode: target.node,
      where,
    };
  }
  const value_ = count?.value;
  if (value_ === undefined || value_.kind !== "scalar" || value_.text === "") {
    report("SHAPE_VALUE_INVALID", "computed の count は集計元の entity の名前で書く", positionOf(value_ ?? value));
    return null;
  }
  return { kind: "count", entity: value_.text, entityNode: value_, name: null, nameNode: null, where };
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
    ["name", "entity", "expression", "aggregate", "settle", "type"],
    report,
  )) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, "computed", positionOf(name.node), report);
    const entity = member.text("entity");

    // 計算は、式（expression）・集計（aggregate）・精算（settle）の**どれか 1 つ**である
    // （docs/semantics.md「computed」「settle」）
    const expressionEntry = entryOf(member.map, "expression");
    const aggregateEntry = entryOf(member.map, "aggregate");
    const settleEntry = entryOf(member.map, "settle");
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
    const label = `computed ${name?.text ?? ""}`;
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
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
      expression: expression?.text ?? "",
      expressionNode: expression?.node ?? { kind: "null", line: 0, column: 0 },
      type: type?.text ?? "",
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
      .filter((draft) => draft.entity === entity.name && draft.settle === null)
      .map((draft) => [draft.name, draft.type]),
  );
  return {
    resolveName: (name: string): SpecType | null => {
      // 項目を先に見る（計算の名前が項目と重なっているとき、自分自身の参照に化けないため）
      const field = fields.get(name);
      if (field !== undefined) return field;
      const type = computedTypes.get(name);
      if (type !== undefined) return isOneOf(COMPUTED_TYPES, type) ? (type as ComputedType) : "unknown";
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
 * 集計の意味を検査する（M1.2）。集計元の entity・対象（項目か計算）・where の整合を見る。
 * 対象が計算なら、その計算を依存として覚える（**entity をまたぐ循環**を `checkCycles` が見つけられるように）。
 */
function checkAggregate(
  draft: ComputedDraft,
  aggregate: AggregateDraft,
  outputEntity: EntityDraft,
  index: ReadonlyMap<string, EntityDraft>,
  computed: readonly ComputedDraft[],
  report: Report,
): void {
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

  if (aggregate.kind === "sum") {
    const name = aggregate.name ?? "";
    const field = source.fields.find((candidate) => candidate.name === name);
    let targetType: string | null = null;
    if (field !== undefined) {
      targetType = field.declaration === null ? null : expressionTypeOf(field.declaration);
    } else {
      const target = computed.find((entry) => entry.entity === source.name && entry.name === name);
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

  for (const condition of aggregate.where) {
    const field = source.fields.find((candidate) => candidate.name === condition.field);
    if (field === undefined) {
      report(
        "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
        `computed ${draft.name} の集計の where の項目 ${condition.field} が、集計元 entity ${aggregate.entity} に無い`,
        positionOf(condition.fieldNode),
      );
      continue;
    }
    const declaration = field.declaration;
    const kind = declaration === null ? null : fieldKind(declaration);
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
        `computed ${draft.name} の集計の where の ${condition.field} は、${outputEntity.name} を指す${expected}でなければならない`,
        positionOf(condition.fieldNode),
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

function checkComputed(
  computed: readonly ComputedDraft[],
  index: ReadonlyMap<string, EntityDraft>,
  report: Report,
): void {
  for (const draft of computed) {
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
 * 計算どうしの参照の循環を断る。**entity をまたぐ**（集計の対象が別の entity の計算である）こともあるので、
 * 宣言全体を 1 つのグラフにして見る（M1.2）。辺は「同じ entity の式の参照」と「集計の対象の計算」である。
 */
function checkCycles(computed: readonly ComputedDraft[], report: Report): void {
  const byKey = new Map<string, ComputedDraft>();
  for (const draft of computed) {
    if (draft.entity === "" || draft.name === "") continue;
    const key = `${draft.entity}\u0000${draft.name}`;
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
    const labels = component.map((draft) => `${draft.entity}.${draft.name}`);
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

/** 読み取った集計を、宣言の形（`Aggregate`）にする。`where` は項目 → 比べ方の写像にする */
function buildAggregate(draft: AggregateDraft): Aggregate {
  const where: Record<string, AggregateWhereOp> = {};
  for (const condition of draft.where) where[condition.field] = condition.op;
  return { kind: draft.kind, entity: draft.entity, name: draft.name, where };
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
    if (draft.settle !== null) {
      // 精算は数ではなく送金の並びを返すので、`type` を持たない（docs/semantics.md「settle」）
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
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
    if (draft.aggregate === null) {
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
        expression: draft.expression,
        type: draft.type as ComputedType,
      });
    } else {
      builtComputed.push({
        name: draft.name,
        entity: draft.entity,
        aggregate: buildAggregate(draft.aggregate),
        type: draft.type as ComputedType,
      });
    }
  }
  return {
    entities: built,
    // 種類（`type`）と表に出す名前（`show`）は、書いてあるときだけ入れる（M1.1 の宣言に欄を足さない）
    views: views.map((draft) => ({
      name: draft.name,
      entity: draft.entity,
      ...(draft.type === null ? {} : { type: draft.type }),
      ...(draft.show === null ? {} : { show: draft.show.map((field) => field.name) }),
    })),
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
    const entity = index.get(view.entity);
    if (entity === undefined) {
      report(
        "UI_ENTITY_NOT_FOUND",
        `view ${view.name} の entity ${view.entity} が宣言に無い`,
        positionOf(view.entityNode),
      );
      // entity が無ければ、表に出す名前も見られない（誤りを重ねない）
      continue;
    }
    // 表に出す名前は、その entity の項目か、**行ごとの値になる**計算でなければならない（M1.2）。
    // 精算（settle）は送金の並びを返すので列に無い（data-api の computedNamesOf と同じ扱いである）
    for (const field of view.show ?? []) {
      const isField = entity.fields.some((candidate) => candidate.name === field.name);
      const isComputed = computed.some(
        (entry) => entry.entity === entity.name && entry.name === field.name && entry.settle === null,
      );
      if (!isField && !isComputed) {
        report(
          "UI_FIELD_NOT_FOUND",
          `view ${view.name} の show の ${field.name} が、entity ${entity.name} の項目にも計算にも無い`,
          positionOf(field.node),
        );
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
