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
  APPSPEC_SECTIONS,
  COMPUTED_TYPES,
  FIELD_TYPES,
  IDENTITY_MODES,
  NAME_PATTERN,
  PERMISSION_NAMES,
  PERMISSION_SUBJECTS,
  RESERVED_NAMES,
  expressionTypeOf,
  fieldKind,
  fieldTarget,
  type Aggregate,
  type AggregateWhereOp,
  type AppSpec,
  type Computed,
  type ComputedType,
  type Entity,
  type FieldDeclaration,
  type FieldType,
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
  expressionDiagnostics,
  positionAt,
  readExpression,
  typeName,
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

interface ComputedDraft extends ExpressionDraft {
  readonly type: string;
  /** 集計（`aggregate`。M1.2）。式なら `null` */
  readonly aggregate: AggregateDraft | null;
  /** 読み取りの時点で断った（式と集計の両方・どちらも無い、など）。意味の検査を重ねない */
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

/**
 * 項目の宣言を読む。**文字列の 1 語（`string`・`number`・`list`）と、参照の写像の両方**を受け取る（#106）。
 * 参照先の entity が実在するかは、すべての entity を読んだあとで見る（`DATA_REF_TARGET_NOT_FOUND`）。
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
    return unknownType(value.text, value);
  }
  if (value.kind !== "map") {
    report("SHAPE_VALUE_INVALID", `項目 ${name} の型は型の名前か、参照の写像で書く`, positionOf(value));
    return { declaration: null, target: null, targetNode: null };
  }

  for (const entry of value.entries) {
    if (!isOneOf(REF_DECLARATION_KEYS, entry.key)) {
      report("SHAPE_KEY_UNKNOWN", `項目 ${name} の参照に欄 ${entry.key} は書けない（type と to / of だけ）`, {
        line: entry.keyLine,
        column: entry.keyColumn,
      });
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

/** `name` と `entity` を持つ欄（views・actions）を読む。entity の実在はここでは見ない */
function readEntityReferences(
  items: readonly YamlNode[],
  section: string,
  report: Report,
): readonly EntityReferenceDraft[] {
  const references: EntityReferenceDraft[] = [];
  for (const member of readMembers(items, section, ["name", "entity"], report)) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, section, positionOf(name.node), report);
    const entity = member.text("entity");
    references.push({
      name: name?.text ?? "",
      nameNode: name?.node ?? null,
      entity: entity?.text ?? "",
      entityNode: entity?.node ?? { kind: "null", line: 0, column: 0 },
    });
  }
  return references;
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

function readComputed(items: readonly YamlNode[], report: Report): readonly ComputedDraft[] {
  const computed: ComputedDraft[] = [];
  for (const member of readMembers(
    items,
    "computed",
    ["name", "entity", "expression", "aggregate", "type"],
    report,
  )) {
    const name = member.text("name");
    if (name !== null) checkName(name.text, "computed", positionOf(name.node), report);
    const entity = member.text("entity");
    const type = member.text("type");
    if (type !== null && !isOneOf(COMPUTED_TYPES, type.text)) {
      report(
        "LOGIC_COMPUTED_TYPE_UNKNOWN",
        `computed の type ${type.text} は M1.1 の型（${COMPUTED_TYPES.join("・")}）に無い`,
        positionOf(type.node),
      );
    }

    // 計算は、式（expression）と集計（aggregate）の**どちらか一方**である（docs/semantics.md「computed」）
    const expressionEntry = entryOf(member.map, "expression");
    const aggregateEntry = entryOf(member.map, "aggregate");
    let expression: { readonly text: string; readonly node: YamlNode } | null = null;
    if (expressionEntry !== undefined) {
      if (expressionEntry.value.kind === "scalar" && expressionEntry.value.text !== "") {
        expression = { text: expressionEntry.value.text, node: expressionEntry.value };
      } else {
        report("SHAPE_VALUE_INVALID", "computed の expression は空でない文字列で書く", positionOf(expressionEntry.value));
      }
    }
    const aggregate = aggregateEntry === undefined ? null : readAggregateDraft(aggregateEntry.value, report);
    if (expressionEntry === undefined && aggregateEntry === undefined) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `computed ${name?.text ?? ""} には、expression（式）か aggregate（集計）のどちらか一方を書く`,
        positionOf(member.map),
      );
    } else if (expressionEntry !== undefined && aggregateEntry !== undefined) {
      report(
        "LOGIC_AGGREGATE_FORM_INVALID",
        `computed ${name?.text ?? ""} に expression と aggregate を同時に書けない（どちらか一方である）`,
        positionOf(aggregateEntry.value),
      );
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
      malformed: (expression !== null) === (aggregate !== null),
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
    computed.filter((draft) => draft.entity === entity.name).map((draft) => [draft.name, draft.type]),
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
    const status = readExpression(validation.expression);
    if (!status.ok) {
      for (const problem of status.problems) {
        report(
          problem.code,
          `validation ${validation.name}: ${problem.message}`,
          positionAt(validation.expression, problem.offset, positionOf(validation.expressionNode)),
        );
      }
      continue;
    }
    const scope = scopeFor(entity, computed, index);
    const analysis = analyzeExpression(status.ast, scope);
    for (const found of expressionDiagnostics(
      analysis.problems,
      validation.expression,
      positionOf(validation.expressionNode),
    )) {
      report(found.code, `validation ${validation.name}: ${found.message}`, found);
    }
    if (analysis.type !== "unknown" && analysis.type !== "boolean") {
      report(
        "LOGIC_VALIDATION_NOT_BOOLEAN",
        `validation ${validation.name} の式は真偽にならなければならない（${typeName(analysis.type)}になる）`,
        positionOf(validation.expressionNode),
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
    // 読み取りの時点で断った（式と集計の両方・どちらも無い）ものは、意味の検査を重ねない
    if (draft.malformed) continue;
    if (draft.aggregate !== null) {
      checkAggregate(draft, draft.aggregate, entity, index, computed, report);
      continue;
    }
    if (draft.expression === "") continue;
    const status = readExpression(draft.expression);
    if (!status.ok) {
      for (const problem of status.problems) {
        report(
          problem.code,
          `computed ${draft.name}: ${problem.message}`,
          positionAt(draft.expression, problem.offset, positionOf(draft.expressionNode)),
        );
      }
      continue;
    }
    const analysis = analyzeExpression(status.ast, scopeFor(entity, computed, index));
    for (const problem of analysis.problems) {
      report(
        problem.code,
        `computed ${draft.name}: ${problem.message}`,
        positionAt(draft.expression, problem.offset, positionOf(draft.expressionNode)),
      );
    }
    // 自分自身の名前も残す（`a` が `a` を参照する自己循環を、循環の検査で見つけるため）
    draft.dependencies = analysis.names.map((name) => ({ entity: draft.entity, name }));
    const declared = isOneOf(COMPUTED_TYPES, draft.type) ? (draft.type as ComputedType) : null;
    if (declared !== null && analysis.type !== "unknown" && analysis.type !== declared) {
      report(
        "LOGIC_COMPUTED_TYPE_MISMATCH",
        `computed ${draft.name} の type は ${declared} だが、式は${typeName(analysis.type)}になる`,
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
    if (!isOneOf(COMPUTED_TYPES, draft.type) || draft.malformed) return null;
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
    views: views.map((draft) => ({ name: draft.name, entity: draft.entity })),
    actions: actions.map((draft) => ({ name: draft.name, entity: draft.entity })),
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
  readonly views: readonly EntityReferenceDraft[];
  readonly actions: readonly EntityReferenceDraft[];
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
  const views = readEntityReferences(collectItems(root, "views", report), "views", report);
  const actions = readEntityReferences(collectItems(root, "actions", report), "actions", report);
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
    if (!index.has(view.entity)) {
      report(
        "UI_ENTITY_NOT_FOUND",
        `view ${view.name} の entity ${view.entity} が宣言に無い`,
        positionOf(view.entityNode),
      );
    }
  }
  checkDuplicates(
    views.map((view) => ({ name: view.name, nameNode: view.nameNode })),
    "UI_VIEW_DUPLICATE_NAME",
    "view",
    report,
  );
  for (const action of actions) {
    if (!index.has(action.entity)) {
      report(
        "LOGIC_ENTITY_NOT_FOUND",
        `action ${action.name} の entity ${action.entity} が宣言に無い`,
        positionOf(action.entityNode),
      );
    }
  }
  checkDuplicates(
    actions.map((action) => ({ name: action.name, nameNode: action.nameNode })),
    "LOGIC_ACTION_DUPLICATE_NAME",
    "action",
    report,
  );

  checkValidations(validations, computed, index, report);
  checkComputed(computed, index, report);
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
