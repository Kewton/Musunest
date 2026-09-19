// control-plane の「公開契約」。**Cloudflare の型をここへ持ち込まない。**
//
// D1 を実際に触るのは data-api だけである（CLAUDE.md 不変条件）。control-plane は
// SQL とその束縛引数、行の読み取りを持ち、実行は注入された RegistryExecutor に任せる。
// data-api の Cloudflare adapter は D1Database を RegistryExecutor に合わせて包むだけで、
// このファイルには D1Database も cloudflare:workers も出てこない
// （cloudflare:workers の直接 import は oxlint の no-restricted-imports が禁じる）。
//
// 表の名前をここに置くのは、SQL（src/registry.ts）・マイグレーション・テストが同じ1か所を
// 見るようにするためである。SQL の本体は src/registry.ts に集める。

/** 宣言（原本と正規化した JSON）を、原本の SHA-256 で識別して登録する表。migrations/0002_app_registry.sql と一致させる。 */
export const APPS_TABLE = "apps" as const;

/** 宣言を使うインスタンスを登録する表。参照するアプリは SHA-256 で指す。 */
export const APP_INSTANCES_TABLE = "app_instances" as const;

/** D1 へ渡せる値。**SQL へ埋め込まず、必ず束縛引数として渡す**（src/registry.ts の規律）。 */
export type SqlValue = string | number | null;

/** 1つの文と、その束縛引数。`?` の順に並べる。 */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

/** 行。列名 → 値。読み取りは列名で行い、知らない列が増えても落ちないようにする（runbook §4.3）。 */
export type SqlRow = Readonly<Record<string, unknown>>;

/** 一括実行（batch）の1文の結果。D1 の D1Result と同じく、読み取りの rows と書き込みの changes を持つ。 */
export interface SqlResult<Row = SqlRow> {
  readonly rows: readonly Row[];
  readonly changes: number;
}

/**
 * 注入された実行者。data-api の Cloudflare adapter は D1Database をこれに合わせて包む：
 *   query   … db.prepare(sql).bind(...params).all() の results
 *   execute … 同 .run() の meta.changes（変更行数）
 *   batch   … db.batch(statements) の各 D1Result（results と meta.changes）。1つのトランザクションで走る
 * これだけを実装すれば control-plane の読み書きを使える。
 */
export interface RegistryExecutor {
  query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]>;
  execute(statement: SqlStatement): Promise<number>;
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
}

/** 登録したアプリの行。`created_at` は D1 の既定値が入る。 */
export interface AppRecord {
  /** 原本（app.spec.yaml）のバイト列の SHA-256。小文字の16進64桁。この表のキー */
  readonly sourceSha256: string;
  /** 変換に使ったスキーマの版（例 `community.app-spec/v0.2-draft`） */
  readonly schemaVersion: string;
  /** 原本の R2 キー */
  readonly sourceKey: string;
  /** 正規化した JSON の R2 キー */
  readonly normalizedKey: string;
  readonly createdAt: string;
}

/** 登録したインスタンスの行。 */
export interface AppInstanceRecord {
  /** インスタンス ID。この表のキー */
  readonly instanceId: string;
  /** 参照するアプリの原本 SHA-256 */
  readonly sourceSha256: string;
  readonly createdAt: string;
}

/** アプリの登録入力。同じ内容の2回目は冪等、同じ SHA-256 で内容が違えば競合として失敗する。 */
export interface AppRegistration {
  readonly sourceSha256: string;
  readonly schemaVersion: string;
  readonly sourceKey: string;
  readonly normalizedKey: string;
}

/** インスタンスの登録入力。参照先のアプリは登録済みでなければならない。 */
export interface AppInstanceRegistration {
  readonly instanceId: string;
  readonly sourceSha256: string;
}

export const REGISTRY_ERROR_CODES = [
  "app_conflict",
  "instance_conflict",
  "app_not_found",
  "replacement_conflict",
] as const;
export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

/**
 * 登録の失敗。原因はコードで分ける（呼ぶ側が例外の文言に依存しないように）。
 *   app_conflict         … 同じ SHA-256 に内容の違う宣言を登録しようとした
 *   instance_conflict    … 既存インスタンスの宣言を暗黙に差し替えようとした（または差し替えの途中で別の書き込みが入った）
 *   app_not_found        … 未登録のアプリを指すインスタンスを登録しようとした
 *   replacement_conflict … はっきり差し替えようとしたが、差し替えてよい宣言ではない（#175）。
 *                          保存済みのレコードの読み方を変える差し替え（項目を消す・型を変える・entity の名前を変える）を断る
 */
export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}
