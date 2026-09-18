// 静的チェックが返す診断（03-spec-layers-and-checker.md §5.3）。
//
// 1 つの誤りは **3 つを組にして**返す：機械向けの誤りコード・人向けの説明・YAML の中の位置。
// 工場（CommandAgent）はコードで直し、人は説明を読む。**どれも空にしてはならない**（受入条件）。
//
// コードの形は appspec-schema の ERROR_CODE_PATTERN（`<種類>_<対象>_<問題>`）に従う。
// `<種類>` は SHAPE（形）と層の名前（DATA・LOGIC・UI・PERMISSION）である。
// 一覧（DIAGNOSTIC_CODES）は**この file が正本**で、README が同じ並びを人向けに説明する。

import { ERROR_CODE_PATTERN } from "@musunest/appspec-schema";

/** 1 始まりの位置。原文（YAML）の行と列を指す */
export interface DiagnosticPosition {
  readonly line: number;
  readonly column: number;
}

/** 1 つの誤り。`code`・日本語の `message`・位置の 3 つを必ず持つ */
export interface Diagnostic extends DiagnosticPosition {
  readonly code: DiagnosticCode;
  readonly message: string;
}

export const DIAGNOSTIC_CODES = [
  // ── 形（SHAPE） ──────────────────────────────────────────────
  /** YAML として読めない（この検査が読み取れる書き方の範囲外も含む。README「読み取れる YAML」） */
  "SHAPE_YAML_INVALID",
  /** 必須のキー・欄が無い */
  "SHAPE_KEY_MISSING",
  /** その版の語彙に無いキー・欄（`label`・`kind`・`required` など、まだ入っていない語彙。M1.2 では一覧の `type` の値もここで断る） */
  "SHAPE_KEY_UNKNOWN",
  /** 同じキーが 2 回ある */
  "SHAPE_KEY_DUPLICATE",
  /** 名前の書式違反（英字で始まる英数字ではない） */
  "SHAPE_NAME_INVALID",
  /** 値の形が違う（欄に並びを書くべきところに写像、`name` が空、など） */
  "SHAPE_VALUE_INVALID",
  /** 検査の文言（`message`）が、空でない文字列になっていない（M1.2） */
  "SHAPE_VALIDATION_MESSAGE_INVALID",
  /** 検査の途中で予期しない例外が出た（外へ投げない。位置は当てにできないので 1 行 1 列） */
  "SHAPE_CHECK_FAILED",

  // ── データ層（DATA） ─────────────────────────────────────────
  /** entity の名前が宣言の中で重なっている */
  "DATA_ENTITY_DUPLICATE_NAME",
  /** 同じ entity の中で項目の名前が重なっている */
  "DATA_FIELD_DUPLICATE_NAME",
  /** 店頭が付ける値の名前（`id`・`createdAt`・`updatedAt`）を項目名に使っている */
  "DATA_FIELD_NAME_RESERVED",
  /** M1.1 の項目の型（`string`・`number`・`list`）に無い型 */
  "DATA_FIELD_TYPE_UNKNOWN",
  /** 選択肢の項目（`type: enum`）の `options` が空である（M1.3）。キーを 1 つ以上書く */
  "DATA_FIELD_ENUM_OPTIONS_EMPTY",
  /** 選択肢の項目の `options` に、同じキーが 2 回ある（M1.3）。キーは保存される値なので重複させない */
  "DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE",
  /** 選択肢の項目の `default` が、`options` のキーのどれでもない（M1.3） */
  "DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS",
  /** 参照（`ref`）と参照の並び（`list of`）の、参照先の entity が宣言に無い（M1.2） */
  "DATA_REF_TARGET_NOT_FOUND",

  // ── ロジック層（LOGIC） ──────────────────────────────────────
  /** action・validation・computed の entity が宣言に無い */
  "LOGIC_ENTITY_NOT_FOUND",
  /** 式が参照する名前が、同じ entity の項目にも計算にも無い */
  "LOGIC_REFERENCE_NOT_FOUND",
  /** 別の entity を `.` で参照している（M1.1 は同じ entity の中だけ） */
  "LOGIC_REFERENCE_OUT_OF_ENTITY",
  /** 計算どうしの参照が循環している（自分自身を含む） */
  "LOGIC_COMPUTED_CYCLE",
  /** 計算の名前が、同じ entity の項目の名前と重なっている */
  "LOGIC_COMPUTED_NAME_CONFLICT",
  /** 計算の名前が、店頭が付ける値の名前（`id`・`createdAt`・`updatedAt`）である */
  "LOGIC_COMPUTED_NAME_RESERVED",
  /** 同じ entity の中で計算の名前が重なっている */
  "LOGIC_COMPUTED_DUPLICATE_NAME",
  /** 計算の式の型が `type` と合わない（式が真偽になる、など） */
  "LOGIC_COMPUTED_TYPE_MISMATCH",
  /** 計算の `type` が M1.1 の型（`number`）に無い */
  "LOGIC_COMPUTED_TYPE_UNKNOWN",
  /** computed の式と集計（`aggregate`）の形が不正である（両方ある・どちらも無い・`sum` と `count` の同時指定など。M1.2） */
  "LOGIC_AGGREGATE_FORM_INVALID",
  /** 集計の対象（entity・項目・計算）が宣言に無い（M1.2） */
  "LOGIC_AGGREGATE_TARGET_NOT_FOUND",
  /** 集計の対象（`sum`）が数ではない（M1.2） */
  "LOGIC_AGGREGATE_TARGET_NOT_NUMBER",
  /** 集計の `where` が、集計元の項目と `this` の参照型に合わない（M1.2） */
  "LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH",
  /** 精算（`settle`）の額の項目が、支出の entity の数の項目でない（M1.2） */
  "LOGIC_SETTLE_AMOUNT_NOT_NUMBER",
  /** 精算（`settle`）の払った人・割る人が、精算する entity を指す参照（ref・list of）でない（M1.2） */
  "LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH",
  /** 検査の式が真偽にならない */
  "LOGIC_VALIDATION_NOT_BOOLEAN",
  /** 検査の名前が重なっている */
  "LOGIC_VALIDATION_DUPLICATE_NAME",
  /** 操作の名前が重なっている */
  "LOGIC_ACTION_DUPLICATE_NAME",
  /** 操作の `kind`（種類）が M1.2 の語彙（`create`・`update`・`delete`）に無い（M1.2） */
  "LOGIC_ACTION_KIND_NOT_ALLOWED",
  /** 店頭が用意していない関数を使っている（M1.1 は `min`・`max`・`len` だけ） */
  "LOGIC_FUNCTION_NOT_ALLOWED",
  /** 関数に渡す引数の数が合わない */
  "LOGIC_FUNCTION_ARITY_MISMATCH",
  /** 関数に渡す引数の型が合わない */
  "LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH",
  /** 演算子の左右の型が合わない（数どうしの計算・比較に、数でないものを書いている） */
  "LOGIC_OPERAND_TYPE_MISMATCH",
  /** 式を解析できない（書けない文字・括弧の閉じ忘れ・比較の連鎖など） */
  "LOGIC_EXPRESSION_INVALID",
  /** 式の文字数が上限（200）を超えている */
  "LOGIC_EXPRESSION_TOO_LONG",
  /** 式の深さが上限（8）を超えている */
  "LOGIC_EXPRESSION_DEPTH_EXCEEDED",
  /** 式のノード数が上限（64）を超えている */
  "LOGIC_EXPRESSION_NODES_EXCEEDED",

  // ── UI 層（UI） ──────────────────────────────────────────────
  /** 一覧の entity が宣言に無い */
  "UI_ENTITY_NOT_FOUND",
  /** 一覧の名前が重なっている */
  "UI_VIEW_DUPLICATE_NAME",
  /** 表（`type: table`）の `show` に書いた名前が、その entity の項目にも計算にも無い（M1.2） */
  "UI_FIELD_NOT_FOUND",

  // ── 権限（PERMISSION） ──────────────────────────────────────
  /** M1.1 の権限の名前（`read`・`write`）に無い */
  "PERMISSION_NAME_NOT_ALLOWED",
  /** M1.1 の subject（`minIdentity`）に無い */
  "PERMISSION_SUBJECT_NOT_ALLOWED",
  /** M1 の本人確認の種類（`anonymous`）に無い */
  "PERMISSION_IDENTITY_MODE_NOT_ALLOWED",
  /** 同じ権限の名前が重なっている */
  "PERMISSION_DUPLICATE_NAME",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** 診断を 1 つ作る。メッセージに使う値は、呼ぶ側が原文から写す（診断から原文をたどれるように） */
export function diagnostic(
  code: DiagnosticCode,
  message: string,
  position: DiagnosticPosition,
): Diagnostic {
  return { code, message, line: position.line, column: position.column };
}

/**
 * 並べ替え。行 → 列 → コードの順にする。
 * 診断の並びを実行のたびに同じにして、CLI の出力とテストの突き合わせを安定させる。
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** 人が読む 1 行（CLI はこれに原本のパスを足して出す） */
export function formatDiagnostic({ line, column, code, message }: Diagnostic): string {
  return `${line} 行目 ${column} 列目: ${code}: ${message}`;
}

/**
 * コードが正本の一覧にあるか。検査の実装が一覧に無いコードを返したら、テストがこれで落とす
 * （一覧と実装がずれると、工場が読む誤りコードが文書化されないまま増える）。
 */
export function isDiagnosticCode(code: string): code is DiagnosticCode {
  return (DIAGNOSTIC_CODES as readonly string[]).includes(code);
}

/** 一覧のコードが、appspec-schema の誤りコードの形に合っているか */
export function isWellFormedDiagnosticCode(code: string): boolean {
  return ERROR_CODE_PATTERN.test(code);
}
