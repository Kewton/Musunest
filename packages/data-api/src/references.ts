// 参照（`ref`・参照 list）の検査（Issue #106）。**保存する前に、参照先のレコードが実在するかを見る。**
//
// 静的チェック（spec-engine）が見るのは「参照先の entity が宣言に実在するか」までである。
// 値が入るのは実行のときなので、**実際の ID が同じインスタンスの参照先に存在するかは data-api が確かめる**
// （workspace/mvp/m1/README.md §3.1「判定は data-api」）。
//
// 断るのは 3 つである。どれも「参照先のレコードが、このインスタンスの、その entity に無い」に潰れる。
//   - 存在しない ID  … 参照先の一覧に無い
//   - 別 entity の ID … その entity の一覧に無い（`expense` の ID を `member` の参照に渡した、など）
//   - 別インスタンスの ID … レコードは 1 インスタンス 1 DO にあるので、この DO の一覧に無い
//
// 断ったら**保存しない**。返すのは、通らなかった項目の名前である（宣言の順。呼ぶ側が 422 にする）。
//
// ここは Cloudflare にもストレージにも触れない（参照先の一覧は引数で受け取る）。

import type { Entity, FieldDeclaration } from "@musunest/appspec-schema";
import { fieldKind, fieldTarget } from "@musunest/appspec-schema";
import type { RecordData } from "@musunest/app-do";

/**
 * 参照先のレコードを引く口。**DO の一覧（RecordStore.list）がそのまま満たす**
 * （この file が app-api を import しないで済むように、必要な形だけをここに書く）。
 */
export interface ReferenceSource {
  list(entity: string): Promise<readonly { readonly id: string }[]>;
}

export interface ReferenceCheckRequest {
  /** 入力の対象の entity（宣言） */
  readonly entity: Entity;
  /** 型の検査を通った入力（**宣言した項目だけ**を持つ） */
  readonly data: RecordData;
  /** 参照先の一覧を引く口（このインスタンスの DO） */
  readonly records: ReferenceSource;
}

/** 通ったか、通らなかった項目の名前（宣言の順） */
export type ReferenceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly fields: readonly string[] };

/** 1 つの参照の値が、参照先のレコードを指しているか */
function pointsAtExistingRecord(
  field: FieldDeclaration,
  value: unknown,
  ids: ReadonlySet<string>,
): boolean {
  if (fieldKind(field) === "ref") return typeof value === "string" && ids.has(value);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && ids.has(item))
  );
}

/**
 * 入力に含まれる参照が、すべて同じインスタンスの参照先のレコードを指しているかを見る。
 * 参照の項目が 1 つも無ければ、参照先の一覧は読まない（`ok`）。
 */
export async function checkReferences(request: ReferenceCheckRequest): Promise<ReferenceCheck> {
  const { entity, data, records } = request;
  const declared = Object.entries(entity.fields).filter(([, field]) => fieldTarget(field) !== null);
  if (declared.length === 0) return { ok: true };

  // 同じ参照先は 1 回だけ読む（1 回の操作で何度も一覧を読まない）
  const known = new Map<string, ReadonlySet<string>>();
  for (const target of new Set(declared.map(([, field]) => fieldTarget(field) ?? ""))) {
    const rows = await records.list(target);
    known.set(target, new Set(rows.map((row) => row.id)));
  }

  const fields: string[] = [];
  for (const [name, field] of declared) {
    const ids = known.get(fieldTarget(field) ?? "");
    if (ids === undefined || !pointsAtExistingRecord(field, data[name], ids)) fields.push(name);
  }
  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}
