// AppSpec v0.2 の草案の型と、語彙の定数。M1.1 の語彙は v0.1 と同じ（workspace/mvp/m1/04-spec-evolution.md §1）。
// 意味は ../docs/semantics.md、版の表記と層の形の決め方は ../README.md にある。
// 語彙を足すときは、この file・vocabulary.yaml・samples/・docs/semantics.md を同じ PR で直す（04 §2）。

/**
 * AppSpec スキーマの版。M1.1〜M1.4 は草案なので `-draft` を付ける。
 * M1.5 で `community.app-spec/v0.2` に固め、同じコミットで pins/commandagent.json の
 * appspec_schema を差し替える（00-open-questions.md Q9。理由は README.md「版の表記」）。
 */
export const APPSPEC_SCHEMA_VERSION = "community.app-spec/v0.2-draft" as const;

/** 版の表記の形。固めた版は `-draft` を持たない。 */
export const APPSPEC_SCHEMA_VERSION_PATTERN = /^community\.app-spec\/v\d+\.\d+(?:-draft)?$/;

export const isDraftSchemaVersion = (version: string): boolean => version.endsWith("-draft");

// ── 層（03-spec-layers-and-checker.md §1） ─────────────────────────────

/** 宣言の層。`permission` は全層に効く。`integration` は席だけ残す（03 §2.5。M1 では欄が無い）。 */
export const LAYERS = ["integration", "data", "logic", "permission", "ui", "ux"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * 宣言の欄。v0.1 と同じ 7 欄を、同じ順で横に並べる（層の形の仮決め。README.md「層の形」）。
 * 7 欄はすべて書く。中身が無ければ `[]` と書く。
 */
export const APPSPEC_SECTIONS = [
  "entities",
  "views",
  "actions",
  "validations",
  "computed",
  "permissions",
  "minIdentity",
] as const;
export type AppSpecSection = (typeof APPSPEC_SECTIONS)[number];

/** 欄がどの層に属するか。横並びの宣言では、層はこの表で決まる。 */
export const SECTION_LAYER = {
  entities: "data",
  views: "ui",
  actions: "logic",
  validations: "logic",
  computed: "logic",
  permissions: "permission",
  minIdentity: "permission",
} as const satisfies Record<AppSpecSection, Layer>;

// ── 名前 ────────────────────────────────────────────────────────

/** entity・項目・検査・計算・一覧・操作の名前。式の中で名前として読めるように、英字で始まる英数字に限る。 */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** 店頭が付ける値の名前。項目と計算の名前には使えない（02 §1）。 */
export const RESERVED_NAMES = ["id", "createdAt", "updatedAt"] as const;

// ── データ層 ─────────────────────────────────────────────────────

/** 項目の型（文字列の 1 語で書けるもの。M1.1）。意味は docs/semantics.md。 */
export const FIELD_TYPES = ["string", "number", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 参照の項目（M1.2）。ほかの entity のレコード 1 件を、その ID で指す。
 * 宣言では `{type: ref, to: <entity>}` と書く（docs/semantics.md「ref」）。
 */
export interface RefFieldDeclaration {
  readonly type: "ref";
  /** 参照先の entity の名前 */
  readonly to: string;
}

/**
 * 参照の並び（M1.2）。ほかの entity のレコードの ID の並び。宣言では `{type: list, of: <entity>}` と書く。
 * `of` の無い `list`（文字列の並び）は `"list"` の 1 語で書く。
 */
export interface RefListFieldDeclaration {
  readonly type: "list";
  readonly of: string;
}

/**
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、参照の写像の両方を受け取る**
 * （既存の見本はこの 1 語で書いてある）。
 */
export type FieldDeclaration = FieldType | RefFieldDeclaration | RefListFieldDeclaration;

/** 画面と入力の検査が使う項目の種類。`ref` は別の entity のレコード 1 件を指す（M1.2） */
export type FieldKind = FieldType | "ref";

/** 項目の種類を返す。`{type: list, of: ...}` は `"list"` である */
export function fieldKind(field: FieldDeclaration): FieldKind {
  if (typeof field === "string") return field;
  return field.type === "ref" ? "ref" : "list";
}

/** 参照先の entity の名前（`ref` と `list of`）。参照でなければ `null` */
export function fieldTarget(field: FieldDeclaration): string | null {
  if (typeof field === "string") return null;
  return field.type === "ref" ? field.to : field.of;
}

/**
 * 式が読む型。**`ref` の値は ID の文字列である**（数ではないので、計算には使えない）。
 * `list` は文字列の並びと同じく `len` に渡せる。
 */
export function expressionTypeOf(field: FieldDeclaration): ExpressionType {
  const kind = fieldKind(field);
  return kind === "ref" ? "string" : kind;
}

export interface Entity {
  readonly name: string;
  /**
   * 項目名 → 宣言。M1.1 の項目はすべて必須。**書いた順が一覧の列の順になる。**
   * 参照（`ref`・参照 list）の値は、参照先のレコードの ID である（M1.2）。
   */
  readonly fields: Readonly<Record<string, FieldDeclaration>>;
}

// ── ロジック層 ───────────────────────────────────────────────────

/** 保存してよい条件。式が真にならなければ保存しない。 */
export interface Validation {
  readonly name: string;
  readonly entity: string;
  readonly expression: string;
  /**
   * 保存できない理由の文言（任意。M1.2）。付いていなければ、画面と応答は**検査の名前**で識別する
   * （M1.1 の `expense-log` は文言を持たない）。docs/semantics.md「message」。
   */
  readonly message?: string;
}

/** computed の型（M1.1 は数だけ）。 */
export const COMPUTED_TYPES = ["number"] as const;
export type ComputedType = (typeof COMPUTED_TYPES)[number];

/**
 * 集計の対象を絞る条件（where。M1.2）。集計元の項目の名前 → 比べ方である。
 * 比べる相手は常に `this`（出力先の entity の、今のレコードの ID）である。
 *   `equals`   … 参照（`ref`）の一致（`{payer: this}`）
 *   `contains` … 参照の並び（`list of`）の包含（`{participants: {contains: this}}`）
 */
export const AGGREGATE_WHERE_OPS = ["equals", "contains"] as const;
export type AggregateWhereOp = (typeof AGGREGATE_WHERE_OPS)[number];

/** 集計の条件。空なら全行が対象である。意味は docs/semantics.md「aggregate」にある */
export type AggregateWhere = Readonly<Record<string, AggregateWhereOp>>;

/**
 * entity をまたぐ集計（M1.2）。`sum: <entity>.<項目か計算>` か `count: <entity>` の**どちらか一方**である。
 * 集計は**同じインスタンス**のレコードだけを見る（別インスタンスの ID は存在しない）。
 */
export interface Aggregate {
  /** `sum` は合計、`count` は該当する行数 */
  readonly kind: "sum" | "count";
  /** 集計元の entity の名前 */
  readonly entity: string;
  /** `sum` のときの、合計する項目か計算の名前。`count` では `null` である */
  readonly name: string | null;
  /** 対象を絞る条件。空なら全行である */
  readonly where: AggregateWhere;
}

/** 式で求める計算（v0.1 からの形）。v0.1 の computed_contract の entry_fields と同じ 4 つのキーを持つ。 */
export interface ComputedExpression {
  readonly name: string;
  readonly entity: string;
  readonly expression: string;
  readonly type: ComputedType;
}

/** 集計で求める計算（M1.2）。`expression` と `aggregate` は択一である */
export interface ComputedAggregate {
  readonly name: string;
  readonly entity: string;
  readonly aggregate: Aggregate;
  readonly type: ComputedType;
}

/** 同じ entity の中の計算（式か集計）。計算の値は保存しない。 */
export type Computed = ComputedExpression | ComputedAggregate;

/** 式で求める計算か（`aggregate` の側と区別する） */
export const isComputedExpression = (computed: Computed): computed is ComputedExpression =>
  "expression" in computed;

/** 種類の指定の無い操作。M1.1 では、その entity への 1 件の追加を意味する。 */
export interface Action {
  readonly name: string;
  readonly entity: string;
}

/** 式の値の型。`boolean` は比べた結果にだけ現れる（項目の型にも computed の型にも無い）。 */
export type ExpressionType = "number" | "string" | "list" | "boolean";

/** 店頭が用意する関数（M1.1）。引数の数は固定。 */
export const BUILTIN_FUNCTIONS = {
  min: { params: ["number", "number"], returns: "number" },
  max: { params: ["number", "number"], returns: "number" },
  len: { params: ["list"], returns: "number" },
} as const satisfies Record<
  string,
  { readonly params: readonly ExpressionType[]; readonly returns: ExpressionType }
>;
export type BuiltinFunctionName = keyof typeof BUILTIN_FUNCTIONS;

/** 数どうしの計算。結果は数。 */
export const ARITHMETIC_OPERATORS = ["+", "-", "*", "/"] as const;
/** 数どうしの比較。結果は真偽。 */
export const COMPARISON_OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;

// ── UI 層 ───────────────────────────────────────────────────────

/** 種類の指定の無い一覧。M1.1 では、その entity のすべてのレコードを登録順に並べる。 */
export interface View {
  readonly name: string;
  readonly entity: string;
}

// ── 権限 ────────────────────────────────────────────────────────

export const PERMISSION_NAMES = ["read", "write"] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const PERMISSION_SUBJECTS = ["minIdentity"] as const;
export type PermissionSubject = (typeof PERMISSION_SUBJECTS)[number];

export interface Permission {
  readonly name: PermissionName;
  readonly subject: PermissionSubject;
}

/** 使うのに最低限必要な本人確認。M1 はログインが無いので `anonymous` だけ。 */
export const IDENTITY_MODES = ["anonymous"] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

export interface MinIdentity {
  readonly mode: IdentityMode;
}

// ── 宣言 ────────────────────────────────────────────────────────

/** `app.spec.yaml` を読んだ形。書き方の検査は spec-engine の静的チェックが行う。 */
export interface AppSpec {
  readonly entities: readonly Entity[];
  readonly views: readonly View[];
  readonly actions: readonly Action[];
  readonly validations: readonly Validation[];
  readonly computed: readonly Computed[];
  readonly permissions: readonly Permission[];
  readonly minIdentity: MinIdentity;
}

/**
 * publish の時点で作る、正規化した JSON（00-open-questions.md Q12・04 §3）。
 * data-api と画面はこれだけを読む。M1.1 の草案では、中身は静的チェックを通った宣言そのものである。
 */
export interface NormalizedAppSpec {
  /** 変換に使ったスキーマの版 */
  readonly schemaVersion: string;
  /** 原本（app.spec.yaml）のバイト列の SHA-256。小文字の 16 進 64 桁 */
  readonly sourceSha256: string;
  readonly spec: AppSpec;
}

// ── 静的チェックの誤りコード ─────────────────────────────────────

/**
 * 誤りコードの形。先頭は確かめる種類（03 §5.1）で、`SHAPE` は形、ほかは層の名前。
 * 体系は spec-engine の静的チェック（#97）で確定する。台帳と負例に書いたコードはその草案である。
 */
export const ERROR_CODE_PATTERN = /^(?:SHAPE|DATA|LOGIC|PERMISSION|UI|UX|INTEGRATION)(?:_[A-Z0-9]+)+$/;

// ── 語彙 ────────────────────────────────────────────────────────

/**
 * この版で使える語彙と、その層。vocabulary.yaml（語彙の台帳）の行と 1 対 1 に対応する。
 * 型の側と台帳の側のどちらかだけに語彙を足すと、unit テストで落ちる。
 */
export const VOCABULARY = {
  entity: "data",
  string: "data",
  number: "data",
  list: "data",
  ref: "data",
  validation: "logic",
  message: "logic",
  computed: "logic",
  aggregate: "logic",
  sum: "logic",
  count: "logic",
  min: "logic",
  max: "logic",
  len: "logic",
  action: "logic",
  view: "ui",
  permission: "permission",
  anonymous: "permission",
} as const satisfies Record<string, Layer>;
export type VocabularyName = keyof typeof VOCABULARY;
