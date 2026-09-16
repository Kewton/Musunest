// 登録表（apps / app_instances）の読み書き。**SQL と引数の束縛、行の読み取りをここに集める。**
//
// 表の正本は migrations/0002_app_registry.sql。実行は注入された RegistryExecutor が行う
// （型は src/contract.ts。Cloudflare の型は使わない）。
//
// 規律：
//   - SQL へ値や表名を埋め込まない。表名は contract.ts の定数、値は必ず束縛引数（runbook §4.3）
//   - 読み取りは列名を書く（SELECT * を使わない）。知らない列が増えても落ちないため
//   - 書き込みは列名を書く。既存行は書き換えない（ON CONFLICT ... DO NOTHING）
//   - 「読む→書く」を1回の batch にまとめる。D1 の batch は1トランザクションなので、途中の状態を読まない
import {
  APP_INSTANCES_TABLE,
  APPS_TABLE,
  RegistryError,
  type AppInstanceRecord,
  type AppInstanceRegistration,
  type AppRecord,
  type AppRegistration,
  type RegistryExecutor,
  type SqlRow,
} from "./contract.js";

const APP_COLUMNS = "source_sha256, schema_version, source_key, normalized_key, created_at";
const INSTANCE_COLUMNS = "instance_id, source_sha256, created_at";

const SELECT_APP = `SELECT ${APP_COLUMNS} FROM ${APPS_TABLE} WHERE source_sha256 = ?`;
const SELECT_INSTANCE = `SELECT ${INSTANCE_COLUMNS} FROM ${APP_INSTANCES_TABLE} WHERE instance_id = ?`;
const SELECT_INSTANCE_APP =
  `SELECT a.source_sha256, a.schema_version, a.source_key, a.normalized_key, a.created_at` +
  ` FROM ${APP_INSTANCES_TABLE} i JOIN ${APPS_TABLE} a ON a.source_sha256 = i.source_sha256` +
  ` WHERE i.instance_id = ?`;

const toAppRecord = (row: SqlRow): AppRecord => ({
  sourceSha256: row["source_sha256"] as string,
  schemaVersion: row["schema_version"] as string,
  sourceKey: row["source_key"] as string,
  normalizedKey: row["normalized_key"] as string,
  createdAt: row["created_at"] as string,
});

const toInstanceRecord = (row: SqlRow): AppInstanceRecord => ({
  instanceId: row["instance_id"] as string,
  sourceSha256: row["source_sha256"] as string,
  createdAt: row["created_at"] as string,
});

/** 同じ SHA-256 の既存行が、登録しようとした内容と同じかを比べる（created_at は含めない）。 */
const sameAppContent = (record: AppRecord, registration: AppRegistration): boolean =>
  record.schemaVersion === registration.schemaVersion &&
  record.sourceKey === registration.sourceKey &&
  record.normalizedKey === registration.normalizedKey;

/** 原本 SHA-256 でアプリを読む。未登録は null（例外にしない）。 */
export async function getApp(executor: RegistryExecutor, sourceSha256: string): Promise<AppRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_APP, params: [sourceSha256] });
  const row = rows[0];
  return row === undefined ? null : toAppRecord(row);
}

/** インスタンス ID でインスタンスを読む。未登録は null。 */
export async function getInstance(executor: RegistryExecutor, instanceId: string): Promise<AppInstanceRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_INSTANCE, params: [instanceId] });
  const row = rows[0];
  return row === undefined ? null : toInstanceRecord(row);
}

/** インスタンスから、それが参照するアプリを解決する。インスタンスかアプリのどちらかが無ければ null。 */
export async function resolveInstanceApp(
  executor: RegistryExecutor,
  instanceId: string,
): Promise<AppRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_INSTANCE_APP, params: [instanceId] });
  const row = rows[0];
  return row === undefined ? null : toAppRecord(row);
}

/**
 * アプリを登録する。同じ SHA-256・同じ内容の2回目は既存の行を返す（冪等）。
 * 同じ SHA-256 で内容が違えば RegistryError("app_conflict") を投げ、既存の行は変えない。
 */
export async function registerApp(
  executor: RegistryExecutor,
  registration: AppRegistration,
): Promise<AppRecord> {
  const [, read] = await executor.batch([
    {
      sql:
        `INSERT INTO ${APPS_TABLE} (source_sha256, schema_version, source_key, normalized_key)` +
        ` VALUES (?, ?, ?, ?) ON CONFLICT(source_sha256) DO NOTHING`,
      params: [registration.sourceSha256, registration.schemaVersion, registration.sourceKey, registration.normalizedKey],
    },
    { sql: SELECT_APP, params: [registration.sourceSha256] },
  ]);
  const row = read?.rows[0];
  if (row === undefined) {
    throw new RegistryError("app_conflict", `${APPS_TABLE} へ登録した行を読めなかった`);
  }
  const record = toAppRecord(row);
  if (!sameAppContent(record, registration)) {
    throw new RegistryError("app_conflict", `同じ SHA-256 で内容の違う宣言は登録できない`);
  }
  return record;
}

/**
 * インスタンスを登録する。参照先のアプリが未登録なら RegistryError("app_not_found") を投げ、行を入れない。
 * 同じ ID・同じ参照の2回目は既存の行を返す（冪等）。同じ ID で参照先が違えば
 * RegistryError("instance_conflict") を投げ、既存の行は変えない（既存インスタンスの宣言差し替えを暗黙に行わない）。
 */
export async function registerInstance(
  executor: RegistryExecutor,
  registration: AppInstanceRegistration,
): Promise<AppInstanceRecord> {
  const { instanceId, sourceSha256 } = registration;
  const [, read] = await executor.batch([
    {
      // apps に行が無ければ0件挿入になる（未登録のアプリを指す行を入れない）。
      // 既存行には触らない（DO NOTHING。ON CONFLICT ... DO UPDATE にしない）
      sql:
        `INSERT INTO ${APP_INSTANCES_TABLE} (instance_id, source_sha256)` +
        ` SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${APPS_TABLE} WHERE source_sha256 = ?)` +
        ` ON CONFLICT(instance_id) DO NOTHING`,
      params: [instanceId, sourceSha256, sourceSha256],
    },
    { sql: SELECT_INSTANCE, params: [instanceId] },
  ]);
  const row = read?.rows[0];
  if (row === undefined) {
    // 挿入も既存行の一致もしなかった＝参照先のアプリが未登録
    throw new RegistryError("app_not_found", `未登録のアプリを指すインスタンスは登録できない`);
  }
  const record = toInstanceRecord(row);
  if (record.sourceSha256 !== sourceSha256) {
    throw new RegistryError("instance_conflict", `既存インスタンスの宣言は暗黙に差し替えない`);
  }
  return record;
}
