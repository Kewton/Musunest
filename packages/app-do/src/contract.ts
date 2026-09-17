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

// ── 参照されている行は消せない（Issue #109。M1.2） ────────────────────
//
// 消せるかどうかは**保存済みの行**に依るので、静的チェックには判定できない（03 §5.1）。
// だから data-api が「どの entity のどの項目が対象を指すか」を組み立てて DO へ渡し、
// **DO が同じ呼出の中で数えて消す**——確認と削除の間に別の操作が参照を足しても、孤立した参照を残さない。
//
// 参照を消すのは合図ではない（一緒に消す動作にはしない）。参照元が 1 件でもあれば断り、
// **参照元の entity と項目、件数**を返す（画面が理由を出せるようにする）。

/** 対象を指すかもしれない参照の項目（`ref` か参照 list） */
export interface ReferenceGuard {
  /** 参照している行の entity */
  readonly entity: string;
  /** 参照している項目の名前 */
  readonly field: string;
  /** 参照の並び（`list of`）か。`false` なら `ref`（1 件）である */
  readonly list: boolean;
}

/** 対象を指していた参照元。`count` は、その entity と項目で対象を指す保存済みの行の数（1 以上） */
export interface ReferenceCount extends ReferenceGuard {
  readonly count: number;
}

/**
 * これから書く行が指す参照（`ref` か参照 list。M1.2）。**書くのと同じ呼出で、参照先の実在を確かめる。**
 *
 * 参照の値を data-api が別の呼出で確かめてから書くと、その間に別の操作が参照先を消せてしまう
 * （孤立した参照が残る）。だから「どの項目が、どの entity を指すか」を渡し、DO が書く前に同じ
 * 呼出の中で見る。
 */
export interface ReferenceExpectation {
  /** 参照の項目の名前 */
  readonly field: string;
  /** 参照先の entity の名前 */
  readonly to: string;
  /** 参照の並び（`list of`）か。`false` なら `ref`（1 件）である */
  readonly list: boolean;
}

/** 参照の期待を満たさない（参照先のレコードが、このインスタンスのその entity に無い） */
export interface ReferenceMiss {
  readonly ok: false;
  readonly reason: "REFERENCE_NOT_FOUND";
  /** 通らなかった項目の名前（宣言の順） */
  readonly fields: readonly string[];
}

/** 条件つきの追加の結果。参照先が実在するときだけ書く */
export type GuardedCreate = { readonly ok: true; readonly record: StoredRecord } | ReferenceMiss;

/** 条件つきの更新の結果。対象が無ければ `NOT_FOUND`、参照先が実在しなければ `REFERENCE_NOT_FOUND` */
export type GuardedUpdate =
  | { readonly ok: true; readonly record: StoredRecord }
  | { readonly ok: false; readonly reason: "NOT_FOUND" }
  | ReferenceMiss;

/**
 * 参照を確かめてから消した結果。
 *   `ok` … 消せた（消した行を返す）
 *   `NOT_FOUND` … 対象の行が無い（別 entity の ID を指した場合も同じ）
 *   `REFERENCE_IN_USE` … 対象を指す保存済みの行が 1 件以上ある（`references` に参照元と件数）
 */
export type GuardedDelete =
  | { readonly ok: true; readonly record: StoredRecord }
  | { readonly ok: false; readonly reason: "NOT_FOUND" }
  | {
      readonly ok: false;
      readonly reason: "REFERENCE_IN_USE";
      readonly references: readonly ReferenceCount[];
    };
