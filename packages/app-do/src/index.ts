// Durable Object（SQLite＋WebSocket）。cloudflare:workers を直接 import してよい唯一の場所。
//
// 企画書9章／03-workers-and-bindings.md §4：
//   - 1アプリインスタンス＝1 DO（SQLite付き）。D1 は Control Plane 専用
//   - クラス名 AppInstanceDO は固定する（改名＝migration）
//   - 初回 migration は必ず new_sqlite_classes。new_classes（KVバックエンド）で作ると
//     後から SQLite に移せない。そもそも Free で使えるのは SQLite 型 DO だけである
//   - DO は data-api にだけバインドする（gateway / host には出さない）
//
// wrangler.jsonc（このパッケージの local-dev ハーネス）と data-api 側の wrangler.jsonc は、
// どちらも下の APP_INSTANCE_DO_* を正本として同じ class_name / tag を書く。
import { DurableObject } from "cloudflare:workers";
import type {
  GuardedCreate,
  GuardedDelete,
  GuardedUpdate,
  HealthzResult,
  RecordData,
  RecordStamp,
  ReferenceExpectation,
  ReferenceGuard,
  StoredEntry,
  StoredRecord,
} from "./contract";
import * as records from "./records";

export * from "./contract";

/** DO がバインドされる Worker（M0 では local-dev ハーネス、M0-3 以降は data-api）の env。 */
export interface AppDoEnv {
  readonly APP_DO: DurableObjectNamespace<AppInstanceDO>;
}

interface KvRow extends Record<string, string> {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * 1アプリインスタンスに 1 つ割り当たる Durable Object。
 *
 * ストレージは SQLite（`ctx.storage.sql`）。この API は new_sqlite_classes で作られた
 * DO でしか使えないので、**このクラスが動くこと自体が migration の証拠になる**。
 */
export class AppInstanceDO extends DurableObject<AppDoEnv> {
  constructor(ctx: DurableObjectState, env: AppDoEnv) {
    super(ctx, env);
    // SQLite の DDL は同期 API。コンストラクタで張っておけば以降の呼び出しは前提を持てる。
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    // 宣言の entity のレコードの表（Issue #99）。kv と healthz はそのまま残す。
    records.ensureRecordsTable(ctx.storage.sql);
  }

  /** 03 §4 の最小実装。SQLite に1行書いて数え直す＝読み書きの往復を1回で見せる。 */
  async healthz(): Promise<HealthzResult> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _probe (k TEXT PRIMARY KEY, v TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _probe (k, v) VALUES ('healthz', ?)",
      new Date().toISOString(),
    );
    const rows = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT count(*) AS c FROM _probe")
      .toArray();
    return { ok: true, rows: Number(rows[0]?.c ?? 0) };
  }

  async put(key: string, value: string): Promise<StoredEntry> {
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      updatedAt,
    );
    return { key, value, updatedAt };
  }

  async get(key: string): Promise<StoredEntry | null> {
    const rows = this.ctx.storage.sql
      .exec<KvRow>("SELECT key, value, updated_at FROM kv WHERE key = ?", key)
      .toArray();
    const row = rows[0];
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : null;
  }

  async list(): Promise<StoredEntry[]> {
    return this.ctx.storage.sql
      .exec<KvRow>("SELECT key, value, updated_at FROM kv ORDER BY key")
      .toArray()
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  async delete(key: string): Promise<boolean> {
    // RETURNING で「実際に消えた行」を数える。存在しないキーの DELETE は 0 行になる。
    const deleted = this.ctx.storage.sql
      .exec<{ key: string }>("DELETE FROM kv WHERE key = ? RETURNING key", key)
      .toArray();
    return deleted.length > 0;
  }

  /** DO ストレージのバイト数。無償枠は 1オブジェクト 1GB（06 §2）なので M1 以降で監視する。 */
  async storageSize(): Promise<number> {
    return this.ctx.storage.sql.databaseSize;
  }

  // ── 宣言の entity のレコード（Issue #99） ────────────────────────────
  //
  // M1.1 の公開操作は「1 件の追加」と「一覧」だけである（workspace/mvp/m1/README.md §10.2）。
  // 1 件取得・更新・削除は保存の部品として今から出す——#102 は追加と一覧だけを使い、
  // 更新・削除は M1.2 の語彙（直す・消す）が来たときに使う。
  //
  // **受け取るのは判定済みのデータだけである。** 入力の検査・権限・参照先の判断は data-api が行い、
  // DO は保存だけを受け持つ（contract.ts「宣言の entity のレコード」）。

  /**
   * entity に 1 件追加し、書いた行を返す。
   * `stamp` を渡すと ID と日時を固定できる（呼ぶ側の時計を使う。#102）。
   */
  async createRecord(
    entity: string,
    data: RecordData,
    stamp?: RecordStamp,
  ): Promise<StoredRecord> {
    return records.insertRecord(
      this.ctx.storage.sql,
      entity,
      data,
      records.recordBoundary(stamp),
    );
  }

  /** entity のすべての行を登録順（古いものが先）に返す。1 件も無ければ `[]`。 */
  async listRecords(entity: string): Promise<StoredRecord[]> {
    return records.selectRecords(this.ctx.storage.sql, entity);
  }

  /**
   * 参照先の実在を確かめてから 1 件追加する（M1.2。Issue #109）。
   *
   * **data-api が別の呼出で参照を確かめてから書くと、その間に参照先が消えて孤立した参照が残る。**
   * だから「どの項目がどの entity を指すか」（`expectations`）を渡してもらい、ここで書く前に見る。
   * `records.insertRecordGuarded` の中に `await` が無いので、見ることと書くことは 1 つの処理になる。
   */
  async createRecordGuarded(
    entity: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedCreate> {
    return records.insertRecordGuarded(
      this.ctx.storage.sql,
      entity,
      data,
      records.recordBoundary(stamp),
      expectations,
    );
  }

  /** entity の 1 行を ID で引く。無ければ `null`。別 entity の ID では引けない。 */
  async getRecord(entity: string, id: string): Promise<StoredRecord | null> {
    return records.selectRecord(this.ctx.storage.sql, entity, id);
  }

  /**
   * entity の 1 行を書き換える。ID・作成日時・登録順は変えず、更新日時だけを進める。
   * 無い行では `null`（別 entity の ID を指定した場合も同じ）。
   */
  async updateRecord(
    entity: string,
    id: string,
    data: RecordData,
    stamp?: RecordStamp,
  ): Promise<StoredRecord | null> {
    return records.updateRecord(
      this.ctx.storage.sql,
      entity,
      id,
      data,
      records.recordBoundary(stamp),
    );
  }

  /** entity の 1 行を消す。消せたかどうかを返す（無い行では `false`）。 */
  async deleteRecord(entity: string, id: string): Promise<boolean> {
    return records.deleteRecord(this.ctx.storage.sql, entity, id);
  }

  /**
   * 参照先の実在を確かめてから 1 行を書き換える（M1.2。Issue #109）。
   * `createRecordGuarded` と同じく、見ることと書くことが 1 つの処理である。
   */
  async updateRecordGuarded(
    entity: string,
    id: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedUpdate> {
    return records.updateRecordGuarded(
      this.ctx.storage.sql,
      entity,
      id,
      data,
      records.recordBoundary(stamp),
      expectations,
    );
  }

  /**
   * 参照を確かめてから 1 行を消す（M1.2。Issue #109）。
   *
   * **確認と削除は同じ呼出の中で行う。** data-api が「どの entity のどの項目が対象を指すか」
   * （`guards`）を組み立てて渡し、ここが数えて消す。独立した RPC（一覧 → 削除）を順に `await`
   * する形にしない——その間に別の操作が参照を足すと、孤立した参照が残るためである
   * （`records.deleteRecordGuarded` の中に `await` が無い）。
   */
  async deleteRecordGuarded(
    entity: string,
    id: string,
    guards: readonly ReferenceGuard[],
  ): Promise<GuardedDelete> {
    return records.deleteRecordGuarded(this.ctx.storage.sql, entity, id, guards);
  }

  /**
   * WebSocket の受け口。Hibernation API（`ctx.acceptWebSocket`）を使う。
   * 素の `server.accept()` にすると接続中ずっと DO が課金対象で起きたままになる。
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 受け取った本文を SQLite に落としてから echo する。WS 経路でも永続化が効くことを見せる。 */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const entry = await this.put(`ws:${crypto.randomUUID()}`, text);
    ws.send(JSON.stringify({ type: "echo", text, key: entry.key, rows: this.#count() }));
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // 1005（No Status Received）/ 1006（Abnormal Closure）はこちらから送り返せない。
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  #count(): number {
    const rows = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT count(*) AS c FROM kv")
      .toArray();
    return Number(rows[0]?.c ?? 0);
  }
}
