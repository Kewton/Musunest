// 入力の検査（Issue #102）。**宣言の項目の型 → computed → validation の順**で進める。
// 意味は packages/appspec-schema/docs/semantics.md（「validation」「action」）にある。
//
// 決めごと（この順で進み、どこかで断ったら保存しない）:
//   1. 型の検査：項目の過不足と、各項目の型。通らない項目を**すべて**返す（順は問わない）。
//      ここで断ったら、**検査の式も計算の式も評価しない**（`validations` は空で返す）
//   2. 計算：型の検査を通った入力で computed の値を出す（保存はしない）
//   3. 検査の式：宣言の順にすべて評価し、真にならなかった名前を宣言の順に返す
//
// 数の型は**有限の数だけ**を受け取る（`1e400` のように読むと無限大になる値は受け取らない）。
// 文字列を数へ暗黙に変換しない。`list` は空の並びと重複を拒否する（Q18-2）。
// `id`・`createdAt`・`updatedAt` と計算の名前は宣言の項目ではないので、**未知の項目として**断る。
//
// ここは Cloudflare にもストレージにも触れない（呼ぶ側が渡す値だけで決まる）。

import type { Entity, FieldDeclaration, NormalizedAppSpec } from "@musunest/appspec-schema";
import { fieldKind } from "@musunest/appspec-schema";
import type { RecordData, RecordValue } from "@musunest/app-do";
import type { Clock } from "@musunest/spec-engine";
import { evaluateRecord } from "@musunest/spec-engine";

// 参照（`ref`・参照 list）の検査は references.ts にある。**入力の検査の一部**（型 → 参照）なので、
// 呼ぶ側（app-api.ts）が入力の検査だけを読めば済むように、この入口からも読めるようにする
// （app-api.ts が相対で読むのはこの file だけである。src/index.test.ts が字面で確かめる）。
export { checkReferences } from "./references.js";
export type { ReferenceCheck, ReferenceCheckRequest, ReferenceSource } from "./references.js";

/** 型の検査を通った入力。**宣言した項目だけ**を持ち、宣言の順に並ぶ */
export interface AcceptedInput {
  readonly ok: true;
  readonly data: RecordData;
}

/** 型の検査で断った入力。通らなかった項目の名前（宣言の順のあとに、未知の項目を入力の順で続ける） */
export interface RejectedInput {
  readonly ok: false;
  readonly fields: readonly string[];
}

export type InputCheck = AcceptedInput | RejectedInput;

/** 保存してよいと決まった入力。計算の値は返すだけで、保存はしない */
export interface AcceptedRecord extends AcceptedInput {
  readonly computed: Readonly<Record<string, number | null>>;
}

/** 断った入力。型で断ったときは `validations` が空である（検査の式を評価していない） */
export interface RejectedRecord extends RejectedInput {
  readonly validations: readonly string[];
}

export type InputDecision = AcceptedRecord | RejectedRecord;

export interface InputRequest {
  /** 検査済みの宣言（正規化した JSON。Issue #98）。未検査の YAML は渡せない */
  readonly app: NormalizedAppSpec;
  /** 入力の対象の entity（呼ぶ側が宣言から引いて渡す） */
  readonly entity: Entity;
  /** 操作に渡された「項目名: 値」のオブジェクト。**書き換えない** */
  readonly input: Readonly<Record<string, unknown>>;
  /** 差し込む時計（Q17）。M1.1 の値は時計に依らないが、境界はここを通す */
  readonly clock: Clock;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * 1 つの項目の値を読む。型に合わなければ `null`（この関数の戻り値で `null` は「合わない」の意味しか
 * 持たない——`string` も `number` も `list` も `ref` も `null` を作らない）。
 *
 * **`ref` は空でない文字列（参照先の ID）だけを受け取る。** その ID が同じインスタンスの
 * 参照先のレコードに実在するかは、型を通ったあとに references.ts が見る（二段構え。M1.2）。
 */
function readValue(field: FieldDeclaration, value: unknown): RecordValue | null {
  switch (fieldKind(field)) {
    case "string":
      // 空の文字列も 1 つの値として受け取る（docs/semantics.md「string」）
      return typeof value === "string" ? value : null;
    case "number":
      return isFiniteNumber(value) ? value : null;
    case "ref":
      // 参照の値は、参照先のレコードの ID である（空文字は ID にならない）
      return typeof value === "string" && value !== "" ? value : null;
    case "list": {
      if (!Array.isArray(value) || value.length === 0) return null;
      if (!value.every((item): item is string => typeof item === "string")) return null;
      // 同じ文字列が 2 回ある並びは受け取らない
      if (new Set<string>(value).size !== value.length) return null;
      return [...value];
    }
  }
}

/**
 * 項目の過不足と型を見る。通らない項目を**すべて**返す。
 * 保存する値は**宣言した項目だけ**（未知の項目を黙って落として保存しない——断る）。
 */
export function checkInputTypes(
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): InputCheck {
  const fields: string[] = [];
  const data: Record<string, RecordValue> = {};

  for (const [name, field] of Object.entries(entity.fields)) {
    if (!Object.hasOwn(input, name)) {
      // 足りない項目（M1.1 の項目はすべて必須。docs/semantics.md「entity」）
      fields.push(name);
      continue;
    }
    const value = readValue(field, input[name]);
    if (value === null) {
      fields.push(name);
      continue;
    }
    data[name] = value;
  }

  // 宣言の項目に無い名前（計算の名前・店頭が付ける値・知らない項目）は、入力の順に断る
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(entity.fields, name)) fields.push(name);
  }

  return fields.length > 0 ? { ok: false, fields } : { ok: true, data };
}

/**
 * 入力の検査を、決められた順で行う。**型で断ったら検査の式を評価しない。**
 * 通った入力と計算の値だけを返す（保存は呼ぶ側）。
 */
export function checkInput(request: InputRequest): InputDecision {
  const { app, entity, input, clock } = request;
  const typed = checkInputTypes(entity, input);
  if (!typed.ok) return { ok: false, fields: typed.fields, validations: [] };

  const evaluation = evaluateRecord({
    app,
    entity: entity.name,
    record: typed.data,
    clock,
  });
  if (evaluation.validations.length > 0) {
    return { ok: false, fields: [], validations: evaluation.validations };
  }
  return { ok: true, data: typed.data, computed: evaluation.computed };
}
