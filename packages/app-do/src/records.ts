// 宣言の entity のレコードを持つ表と、その読み書き（Issue #99）。
//
// **entity の名前を SQL の識別子へ埋め込まない。** 表は 1 つ（records）で、entity は
// `?` で束縛する値である。entity の名前が SQL の一部になる経路を作らない。
//
// このファイルは cloudflare:workers の実行時コードを import しない（型だけを使う）。
// DO のクラス（src/index.ts）から呼ばれる部品で、判定は持たない——
// 入力の型の検査・validation・権限・参照先の判断と computed の計算は data-api の責任である
// （contract.ts「宣言の entity のレコード」）。
import type {
  GuardedCreate,
  GuardedDelete,
  GuardedUpdate,
  RecordData,
  RecordStamp,
  ReferenceCount,
  ReferenceExpectation,
  ReferenceGuard,
  StoredRecord,
} from "./contract";

/** SQLite から読んだ 1 行。列名は表の定義と同じ。 */
interface RecordRow extends Record<string, SqlStorageValue> {
  entity: string;
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
  ordering: number;
}

/**
 * 保存の境界が受け取る時計と ID 生成器。
 *
 * テストは `RecordStamp` でこれを固定し、ID と日時を決め打ちにする。省略した値は
 * `systemRecordBoundary()`（実時計と UUID）のままになる。
 */
export interface RecordBoundary {
  now(): string;
  newId(): string;
}

/** 実時計と UUID を使う既定の境界。 */
export function systemRecordBoundary(): RecordBoundary {
  return {
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  };
}

/** `RecordStamp` で固定した境界を作る。省略された値だけを既定にまかせる。 */
export function recordBoundary(stamp: RecordStamp = {}): RecordBoundary {
  const system = systemRecordBoundary();
  const { now, id } = stamp;
  return {
    now: now === undefined ? system.now : () => now,
    newId: id === undefined ? system.newId : () => id,
  };
}

/**
 * 表を作る。DO のコンストラクタから呼ぶ（SQLite の DDL は同期 API）。
 *
 * `IF NOT EXISTS` なので migration を足さずに済む——既存の DO でも次の起動で表ができる。
 * 主キーは `(entity, id)` である。**同じ ID でも entity が違えば別の行**になる。
 */
export function ensureRecordsTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS records (
       entity     TEXT    NOT NULL,
       id         TEXT    NOT NULL,
       data       TEXT    NOT NULL,
       created_at TEXT    NOT NULL,
       updated_at TEXT    NOT NULL,
       ordering   INTEGER NOT NULL,
       PRIMARY KEY (entity, id)
     )`,
  );
}

/**
 * 1 行を書く。ID は境界の ID 生成器、日時は境界の時計で付ける。
 *
 * 登録順は DO ごとの連番（`ordering`）である。**時刻が同じ行もこの列で安定して並ぶ。**
 * 連番の読み取りと INSERT はどちらも同期で、間に await が無い。DO は 1 つの要求を
 * 直列に処理するので、2 つの文の間に別の書き込みが割り込むことはない。
 */
export function insertRecord(
  sql: SqlStorage,
  entity: string,
  data: RecordData,
  boundary: RecordBoundary,
): StoredRecord {
  const id = boundary.newId();
  const now = boundary.now();
  const ordering = nextOrdering(sql);
  sql.exec(
    `INSERT INTO records (entity, id, data, created_at, updated_at, ordering)
     VALUES (?, ?, ?, ?, ?, ?)`,
    entity,
    id,
    JSON.stringify(data),
    now,
    now,
    ordering,
  );
  return { entity, id, data, createdAt: now, updatedAt: now, order: ordering };
}

/**
 * entity のすべての行を登録順（古いものが先）に返す。
 * 行が無ければ `[]` である——存在しない entity も同じ扱いにする。
 */
export function selectRecords(sql: SqlStorage, entity: string): StoredRecord[] {
  return sql
    .exec<RecordRow>(
      `SELECT entity, id, data, created_at, updated_at, ordering
         FROM records
        WHERE entity = ?
        ORDER BY ordering`,
      entity,
    )
    .toArray()
    .map(toStoredRecord);
}

/** 1 行を ID で引く。entity が違えば引けない（主キーが `(entity, id)` である）。無ければ `null`。 */
export function selectRecord(
  sql: SqlStorage,
  entity: string,
  id: string,
): StoredRecord | null {
  const rows = sql
    .exec<RecordRow>(
      `SELECT entity, id, data, created_at, updated_at, ordering
         FROM records
        WHERE entity = ? AND id = ?`,
      entity,
      id,
    )
    .toArray();
  const row = rows[0];
  return row === undefined ? null : toStoredRecord(row);
}

/**
 * 1 行を書き換える。**ID・作成日時・登録順は変えず、更新日時だけを進める。**
 * 無い行（別 entity の ID を含む）では 0 行が返るので `null` になる。
 */
export function updateRecord(
  sql: SqlStorage,
  entity: string,
  id: string,
  data: RecordData,
  boundary: RecordBoundary,
): StoredRecord | null {
  const rows = sql
    .exec<RecordRow>(
      `UPDATE records
          SET data = ?, updated_at = ?
        WHERE entity = ? AND id = ?
      RETURNING entity, id, data, created_at, updated_at, ordering`,
      JSON.stringify(data),
      boundary.now(),
      entity,
      id,
    )
    .toArray();
  const row = rows[0];
  return row === undefined ? null : toStoredRecord(row);
}

/** 1 行を消す。消せたかどうかを返す（無い行では `false`）。 */
export function deleteRecord(sql: SqlStorage, entity: string, id: string): boolean {
  // RETURNING で「実際に消えた行」を数える。存在しない ID の DELETE は 0 行になる。
  const deleted = sql
    .exec<{ id: string }>(
      `DELETE FROM records WHERE entity = ? AND id = ? RETURNING id`,
      entity,
      id,
    )
    .toArray();
  return deleted.length > 0;
}

// ── 参照されている行は消せない（Issue #109。M1.2） ──────────────────
//
// **判定はここに置かない。** どの項目が参照なのかは宣言が決めるので、data-api が
// `ReferenceGuard` / `ReferenceExpectation` の並び（entity・項目・並びかどうか）を組み立てて渡す。
// ここは「渡された項目が対象の ID を指している行を数える」「参照先が実在するかを見る」ことと、
// **数える・見ることと書くことを同じ呼出の中で行う**ことだけを受け持つ。

/** 1 つの参照の値が、対象の ID を指しているか（`ref` は一致、参照 list は包含） */
function pointsAt(data: RecordData, guard: ReferenceGuard, id: string): boolean {
  const value = data[guard.field];
  if (guard.list) return Array.isArray(value) && value.includes(id);
  return value === id;
}

/**
 * 対象を指している保存済みの行を、参照の項目ごとに数える（1 件以上あるものだけを返す）。
 * 順は渡された `guards` の順である（data-api が宣言の順に組み立てる）。
 */
export function countReferences(
  sql: SqlStorage,
  target: string,
  guards: readonly ReferenceGuard[],
): ReferenceCount[] {
  const references: ReferenceCount[] = [];
  for (const guard of guards) {
    const count = selectRecords(sql, guard.entity).filter((row) =>
      pointsAt(row.data, guard, target),
    ).length;
    if (count > 0) references.push({ ...guard, count });
  }
  return references;
}

/**
 * 書こうとしている行の参照先が、**このインスタンス**に実在するかを見る。
 * 通らなかった項目の名前を返す（宣言の順。空なら通った）。
 */
function missingReferences(
  sql: SqlStorage,
  data: RecordData,
  expectations: readonly ReferenceExpectation[],
): string[] {
  const fields: string[] = [];
  for (const expectation of expectations) {
    const value = data[expectation.field];
    const ids = expectation.list
      ? Array.isArray(value)
        ? value
        : []
      : typeof value === "string" && value !== ""
        ? [value]
        : [];
    // 1 件も指していない（型の検査が先に断る値である）か、1 つでも実在しなければ通らない
    if (ids.length === 0 || ids.some((id) => selectRecord(sql, expectation.to, id) === null)) {
      fields.push(expectation.field);
    }
  }
  return fields;
}

/**
 * 参照先の実在を確かめてから 1 行を追加する（M1.2）。**この関数の中に `await` が無い。**
 * data-api が別の呼出で確かめてから書くと、その間に参照先が消えて孤立した参照が残りうる。
 * DO は 1 つの要求を直列に処理するので、見ることと書くことの間に別の操作は割り込まない。
 */
export function insertRecordGuarded(
  sql: SqlStorage,
  entity: string,
  data: RecordData,
  boundary: RecordBoundary,
  expectations: readonly ReferenceExpectation[] = [],
): GuardedCreate {
  const fields = missingReferences(sql, data, expectations);
  if (fields.length > 0) return { ok: false, reason: "REFERENCE_NOT_FOUND", fields };
  return { ok: true, record: insertRecord(sql, entity, data, boundary) };
}

/**
 * 参照先の実在を確かめてから 1 行を書き換える（M1.2）。対象の行が無ければ `NOT_FOUND`、
 * 参照先が実在しなければ `REFERENCE_NOT_FOUND`（**どちらも書かない**）。`insertRecordGuarded` と同じく、
 * 見ることと書くことの間に `await` が無い。
 */
export function updateRecordGuarded(
  sql: SqlStorage,
  entity: string,
  id: string,
  data: RecordData,
  boundary: RecordBoundary,
  expectations: readonly ReferenceExpectation[] = [],
): GuardedUpdate {
  if (selectRecord(sql, entity, id) === null) return { ok: false, reason: "NOT_FOUND" };
  const fields = missingReferences(sql, data, expectations);
  if (fields.length > 0) return { ok: false, reason: "REFERENCE_NOT_FOUND", fields };
  const record = updateRecord(sql, entity, id, data, boundary);
  if (record === null) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, record };
}

/**
 * 参照を確かめてから 1 行を消す（M1.2）。**この関数の中に `await` が無い。**
 * DO は 1 つの要求を直列に処理するので、数えることと消すことの間に別の書込は割り込まない
 * ——参照の確認と削除の間に参照が足されて、孤立した参照が残ることはない。
 */
export function deleteRecordGuarded(
  sql: SqlStorage,
  entity: string,
  id: string,
  guards: readonly ReferenceGuard[],
): GuardedDelete {
  const record = selectRecord(sql, entity, id);
  if (record === null) return { ok: false, reason: "NOT_FOUND" };
  const references = countReferences(sql, id, guards);
  if (references.length > 0) return { ok: false, reason: "REFERENCE_IN_USE", references };
  deleteRecord(sql, entity, id);
  return { ok: true, record };
}

/** 次の登録順。行が無ければ 1。 */
function nextOrdering(sql: SqlStorage): number {
  const rows = sql
    .exec<{ next: number }>("SELECT COALESCE(MAX(ordering), 0) + 1 AS next FROM records")
    .toArray();
  return Number(rows[0]?.next ?? 1);
}

function toStoredRecord(row: RecordRow): StoredRecord {
  return {
    entity: row.entity,
    id: row.id,
    data: JSON.parse(row.data) as RecordData,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    order: row.ordering,
  };
}
