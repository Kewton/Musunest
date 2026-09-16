// app-do の「契約」。**cloudflare:workers を import しない。**
//
// wrangler.jsonc の class_name / migration tag と、DO の RPC が返す形をここに集める。
// runtime（src/index.ts）から切り離してあるのは、workerd の外——テスト・設定検査・
// 将来の data-api 側の型——からも同じ定数を参照できるようにするためである。

export const PACKAGE_NAME = "@musunest/app-do" as const;

/** wrangler.jsonc の durable_objects.bindings[].class_name と migrations の正本。 */
export const APP_INSTANCE_DO_CLASS_NAME = "AppInstanceDO" as const;

/** 初回 migration のタグ。deleted_classes を打つときの起点になる。 */
export const APP_INSTANCE_DO_INITIAL_MIGRATION_TAG = "v1" as const;

/** DO をバインドする Worker が使うバインド名。 */
export const APP_DO_BINDING_NAME = "APP_DO" as const;

/** SQLite ストレージ上の 1 行。RPC の戻り値なので構造化クローン可能な形だけを使う。 */
export interface StoredEntry {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
}

/** healthz の戻り値。data-api の貫通スモーク（03 §5）がそのまま JSON に載せる。 */
export interface HealthzResult {
  readonly ok: true;
  readonly rows: number;
}

// ── 宣言の entity のレコード（Issue #99） ──────────────────────────────
//
// 1 アプリインスタンスに 1 つの DO を割り当て、entity ごとのレコードを SQLite に置く
// （workspace/mvp/m1/README.md §4「app-do: 宣言の entity のレコードを持つ表」）。
// D1 は登録用、DO はアプリのデータ用という分離を保つ（CLAUDE.md 不変条件）。
//
// **渡すのは判定済みのデータだけである。** 入力の型の検査・validation・権限・参照先の判断と、
// computed の計算は data-api の責任で、DO は受け取った値をそのまま保存する
// （packages/appspec-schema/docs/semantics.md「action」「computed」）。

/**
 * レコードに入る値。**今の語彙が作る値だけ**を使う——項目の型は `string`・`number`・`list` で、
 * `list` は文字列の並びである（`packages/appspec-schema/docs/semantics.md`「string」「number」「list」）。
 * 語彙が増えたら、この型も同じ PR で広げる。
 *
 * 再帰する JSON の型（入れ子のオブジェクト）にはしない。DO の RPC は戻り値が
 * 構造化クローン可能かを型で確かめる（`Rpc.Serializable`）ので、再帰する型を戻り値に置くと
 * `TS2589` で `tsc` が落ちる。
 */
export type RecordValue = string | number | readonly string[];

/**
 * 保存する 1 件の入力データ。`computed` の値は入らない
 * （計算は保存しない。`packages/appspec-schema/docs/semantics.md`「computed」）。
 */
export type RecordData = Readonly<Record<string, RecordValue>>;

/**
 * 保存の境界が受け取る、店頭が付ける値（`workspace/mvp/m1/02-l2-spec-examples.md` §1）。
 * 省略した値は DO が実時計と UUID で埋める。
 *
 * 呼ぶ側（data-api）は自分の時計をここへ渡す（`00-open-questions.md` Q17）。
 * レコード ID・`createdAt`・`updatedAt` を付けるのは店頭であって、入力データの値ではない。
 */
export interface RecordStamp {
  /** `createdAt` と `updatedAt` に使う ISO 8601 の時刻。 */
  readonly now?: string;
  /** 新しいレコードの ID。 */
  readonly id?: string;
}

/** 保存した 1 行。RPC の戻り値なので構造化クローン可能な形だけを使う。 */
export interface StoredRecord {
  readonly entity: string;
  readonly id: string;
  readonly data: RecordData;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 登録順。1 から始まる連番で、時刻が同じ行もこの値で並ぶ。更新しても変わらない。 */
  readonly order: number;
}
