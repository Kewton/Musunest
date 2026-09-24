// AppSpec v0.2 の草案の型と、語彙の定数。M1.1 の語彙は v0.1 と同じ（workspace/mvp/m1/04-spec-evolution.md §1）。
// 意味は ../docs/semantics.md、版の表記と層の形の決め方は ../README.md にある。
// 語彙を足すときは、この file・vocabulary.yaml・samples/・docs/semantics.md を同じ PR で直す（04 §2）。

/**
 * AppSpec スキーマの版。M1.5 で `community.app-spec/v0.2` に固めた——同じコミットで
 * pins/commandagent.json の appspec_schema を、この版と契約（contract/）の SHA-256 に
 * 差し替えた（00-open-questions.md Q9。理由は README.md「版の表記」）。
 */
export const APPSPEC_SCHEMA_VERSION = "community.app-spec/v0.2" as const;

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

/** 項目の型（文字列の 1 語で書けるもの。M1.1。`date` は M1.3）。意味は docs/semantics.md。 */
export const FIELD_TYPES = ["string", "number", "list", "date"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 日付の値の形（M1.3。docs/semantics.md「date」）。**保存する形は `YYYY-MM-DD` の文字列**である。
 * 日付どうしの比較は、この形の文字列をそのまま比べる（同じ桁数なので辞書の順が暦の順と一致する）。
 *
 * **Data API が唯一の権限強制点である**——この形でない値は、入力の型の検査（data-api）で断る。
 */
export const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 表示名（`label`。M1.3。Issue #176）。**画面に出すためだけ**に使い、式からは読めない
 * （式が読むのは識別子だけである。混ぜると名前解決が 2 通りになる）。
 *
 * - **任意**である。書かなければ識別子（項目名・計算の名前）をそのまま出す
 * - **空でない文字列**である。空文字は静的チェックが `SHAPE_LABEL_EMPTY` で断る
 * - **付けられるのは項目（`fields`）と計算（`computed`）の 2 つだけ**である
 *   （entity・一覧・操作には付けない。書けば `SHAPE_KEY_UNKNOWN` で断る）
 * - **保存される値は変わらない。** 宣言の中だけの飾りである
 * - **`label` は式の中の名前としては読めない**（`label` を参照する式は `LOGIC_REFERENCE_NOT_FOUND`）
 */
export interface LabeledDeclaration {
  /** 画面に出す名前。書かなければ識別子のまま */
  readonly label?: string;
}

/**
 * 1 語の型を写像で書いたもの（M1.3。Issue #176）。`label` を付けるには写像の形が要る
 * （`{type: string, label: やること}`）。`{type: list}` は `of` の無い文字列の並びである。
 */
export interface SimpleFieldDeclaration extends LabeledDeclaration {
  readonly type: FieldType;
}

/**
 * 参照の項目（M1.2）。ほかの entity のレコード 1 件を、その ID で指す。
 * 宣言では `{type: ref, to: <entity>}` と書く（docs/semantics.md「ref」）。
 */
export interface RefFieldDeclaration extends LabeledDeclaration {
  readonly type: "ref";
  /** 参照先の entity の名前 */
  readonly to: string;
}

/**
 * 参照の並び（M1.2）。ほかの entity のレコードの ID の並び。宣言では `{type: list, of: <entity>}` と書く。
 * `of` の無い `list`（文字列の並び）は `"list"` の 1 語で書く。
 */
export interface RefListFieldDeclaration extends LabeledDeclaration {
  readonly type: "list";
  readonly of: string;
}

/**
 * 選択肢の項目（M1.3）。**保存される値（キー）と、画面に出す表示名の対**を持つ。
 *
 * ```yaml
 * status:
 *   type: enum
 *   options:
 *     todo: 未着手
 *     doing: 進行中
 *   default: todo
 * ```
 *
 * - キー（`options` の左側）は**保存される値**である。重複させない。1 つ以上書く
 * - 表示名（右側）は画面に出す。**保存するのは表示名ではなくキーである**
 * - `default` は任意で、**`options` のキーのどれか**である。未入力のとき、保存の時点で入れる
 * - キーを書いた順は、画面に出す選択肢の順になる（M1.3 のボードの列はこの順に並ぶ）
 *
 * 意味は docs/semantics.md「enum」「default」にある。
 */
export interface EnumFieldDeclaration extends LabeledDeclaration {
  readonly type: "enum";
  /** 保存される値（キー）→ 画面に出す表示名。キーは重複させない。1 つ以上 */
  readonly options: Readonly<Record<string, string>>;
  /** 未入力のときに保存の時点で入れるキー。`options` のキーのどれかである */
  readonly default?: string;
}

/**
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、写像（1 語の型・参照・選択肢）の両方**を
 * 受け取る（既存の見本は 1 語で書いてある）。**`label` を付けるときは写像で書く**（M1.3。Issue #176）。
 */
export type FieldDeclaration =
  | FieldType
  | SimpleFieldDeclaration
  | RefFieldDeclaration
  | RefListFieldDeclaration
  | EnumFieldDeclaration;

/** 項目の宣言に書かれた表示名（`label`）。書いていなければ `null`（画面は識別子をそのまま出す） */
export const fieldLabel = (declaration: FieldDeclaration): string | null =>
  typeof declaration === "string" ? null : (declaration.label ?? null);

/** 画面と入力の検査が使う項目の種類。`ref` は別の entity のレコード 1 件を指す（M1.2） */
export type FieldKind = FieldType | "ref" | "enum";

/** 項目の種類を返す。`{type: list, of: ...}` は `"list"`、`{type: enum, ...}` は `"enum"` である */
export function fieldKind(field: FieldDeclaration): FieldKind {
  if (typeof field === "string") return field;
  return field.type;
}

/** 参照先の entity の名前（`ref` と `list of`）。参照でなければ `null`（選択肢の項目も `null`） */
export function fieldTarget(field: FieldDeclaration): string | null {
  if (typeof field === "string") return null;
  if (field.type === "ref") return field.to;
  // `of` を持つのは参照の並び（`{type: list, of}`）だけである（`{type: list}` は文字列の並び）
  return "of" in field ? field.of : null;
}

/** 選択肢の項目か（`options` と `default` を持つ写像） */
export const isEnumField = (field: FieldDeclaration): field is EnumFieldDeclaration =>
  typeof field !== "string" && field.type === "enum";

/** 選択肢のキーの並び（宣言の順）。選択肢の項目でなければ空である */
export const enumKeys = (field: FieldDeclaration): readonly string[] =>
  isEnumField(field) ? Object.keys(field.options) : [];

/** 未入力のときに入れるキー。無ければ（選択肢の項目でなければ）`null` である */
export const enumDefault = (field: FieldDeclaration): string | null =>
  isEnumField(field) ? (field.default ?? null) : null;

/**
 * 式が読む型。**`ref` の値は ID の文字列、`enum` の値はキーの文字列である**（数ではないので、
 * 計算には使えない）。`list` は文字列の並びと同じく `len` に渡せる。
 *
 * **M1.3 で式に文字列の定数（`"done"`）が入った**（`==`・`!=` の比較だけ）。だから
 * `status == "done"` が書ける——ただし `enum` の項目と比べる定数は、静的チェックが
 * `options` のキーであることを確かめる（docs/semantics.md「enum」「when」）。
 */
export function expressionTypeOf(field: FieldDeclaration): ExpressionType {
  const kind = fieldKind(field);
  return kind === "ref" || kind === "enum" ? "string" : kind;
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

/**
 * computed の型。M1.1 は数（`number`）だけだったが、**M1.3 で真偽（`boolean`）を足し**、
 * **M1.4 で並び（`groups`）を足した**（Issue #157・#179）。
 *
 * **`boolean` の計算は、ボードの強調（`highlight`）が指すためだけに使う。** 一覧の列には出さない
 * （一覧の応答の `computed` の並びにも入らない。data-api の `computedNamesOf` が外す）。
 * 集計（`aggregate`）と精算（`settle`）は数を返すので、`boolean` は式で求める計算だけである。
 *
 * **`groups` の計算は、見出しごとの集計（`groupBy`）の結果（「見出しと値」の組の並び）である。**
 * これも一覧の列には出さない（`boolean` と同じ扱い。グラフの部品が指すためだけに使う）。
 * `groups` は **`scope: app` も `entity` も持たない**——1 つの行の値でも、1 つの数でもなく、
 * アプリ全体で 1 つの並びだからである（`ComputedGroups` の注記）。
 */
export const COMPUTED_TYPES = ["number", "boolean", "groups"] as const;
export type ComputedType = (typeof COMPUTED_TYPES)[number];

/**
 * 見出しごとの集計（`groupBy`。M1.4。Issue #179）の、見出しの数の上限の既定である。
 * **月で分けるとき**（`groupBy: { month: ... }`）に使う——直近いくつの月を返すか。窓口の決定
 * 2026-09-19（`workspace/mvp/m1/02-l2-spec-examples.md` §4.3 の叩き台は `last: 6`）。
 */
export const GROUP_LIMIT_DEFAULT = 6;

/**
 * 見出しごとに分ける対象（`aggregate` の `groupBy`。M1.4。Issue #179）。**集計元の entity の項目**を指す。
 *
 *   `{ field: "kind", month: false }` … `enum` の項目の値ごとに分ける（見出しは `options` のキー）
 *   `{ field: "date", month: true }`  … `date` の項目を**月**でまとめる（見出しは `YYYY-MM`）
 *
 * **分けられるのは `enum` と `date` の 2 つだけ**である（M1.4）。ほかの型を指せば静的チェックが
 * `LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE` で断る。意味は docs/semantics.md「groupBy」にある。
 */
export interface AggregateGrouping {
  /** 分ける対象の項目の名前（`aggregate.entity` の項目） */
  readonly field: string;
  /** `true` なら `date` の項目を月でまとめる（`false` なら `enum` の項目の値ごと） */
  readonly month: boolean;
}

/**
 * 期間の名前（`within` の比べる相手。M1.4。Issue #178）。**語彙は閉じている**——いま書けるのは
 * `this_month`（日本時間の今月）だけである。意味は docs/semantics.md「within」にある。
 */
export const PERIODS = ["this_month"] as const;
export type Period = (typeof PERIODS)[number];

/**
 * 集計の対象を絞る条件の、1 つの比べ方（where の右側。M1.2・M1.4）。
 * **正規化のあとは、どれも `op` を持つオブジェクトに揃える**（窓口の決定 2026-09-20）——
 * 読む側が値ごとに型を見分けなくてよくするためである。
 *
 *   `{ op: "equals" }`                       … 参照（`ref`）の一致（書く側は `{payer: this}`）
 *   `{ op: "contains" }`                     … 参照の並び（`list of`）の包含（書く側は `{participants: {contains: this}}`）
 *   `{ op: "within", period: this_month }`   … 期間の絞り込み（書く側は `{date: {within: this_month}}`。M1.4）
 *
 * `equals`・`contains` の比べる相手は常に `this`（出力先の entity の、今のレコードの ID）である。
 * `within` の比べる相手は**期間の名前**である。**指せるのは `date` の項目だけ**である（M1.4）。
 */
export type AggregateWhereCondition =
  | { readonly op: "equals" }
  | { readonly op: "contains" }
  | { readonly op: "within"; readonly period: Period };

/** 条件の種類（`op`）に書ける名前。意味は docs/semantics.md「aggregate」「within」にある */
export const AGGREGATE_WHERE_OPS = ["equals", "contains", "within"] as const;
export type AggregateWhereOp = (typeof AGGREGATE_WHERE_OPS)[number];

/** 集計の条件。空なら全行が対象である。意味は docs/semantics.md「aggregate」「within」にある */
export type AggregateWhere = Readonly<Record<string, AggregateWhereCondition>>;

/**
 * 集計の種類（M1.2・M1.4）。**語彙は閉じている**——書けるのはこの 3 つだけである。
 *   `sum`   … 合う行の、対象の値を足す
 *   `count` … 合う行の数を数える
 *   `avg`   … 合う行の、対象の値の平均（M1.4。Issue #177）。**値の無い行は数えない**
 */
export const AGGREGATE_KINDS = ["sum", "count", "avg"] as const;
export type AggregateKind = (typeof AGGREGATE_KINDS)[number];

/**
 * entity をまたぐ集計（M1.2）。`sum: <entity>.<項目か計算>`・`count: <entity>`・
 * `avg: <entity>.<項目か計算>` の**どれか 1 つ**である。
 * 集計は**同じインスタンス**のレコードだけを見る（別インスタンスの ID は存在しない）。
 */
export interface Aggregate {
  /** `sum` は合計、`count` は該当する行数、`avg` は平均（M1.4） */
  readonly kind: AggregateKind;
  /** 集計元の entity の名前 */
  readonly entity: string;
  /** `sum`・`avg` のときの、対象の項目か計算の名前。`count` では `null` である */
  readonly name: string | null;
  /**
   * 対象を絞る条件。空なら全行である。**条件はどれも `op` を持つオブジェクトである**
   * （`AggregateWhereCondition`）。`within`（期間の条件）は **`date` の項目だけ**を指せる（M1.4）
   */
  readonly where: AggregateWhere;
  /**
   * **見出しごとに分ける**（M1.4。Issue #179）。書けば、集計は**1 つの値ではなく「見出しと値」の組の
   * 並び**になる（`type: groups` の計算だけが持つ）。書かなければ、従来どおり 1 つの値である。
   */
  readonly groupBy?: AggregateGrouping;
  /**
   * 見出しの数の上限（M1.4。Issue #179）。**月で分けるときだけ**書ける——直近いくつの月を返すか。
   * 省略したときは `GROUP_LIMIT_DEFAULT`（6）である。`enum` で分けるときは書けない
   * （見出しは `options` のキーの全部である）。
   */
  readonly last?: number;
}

/**
 * 計算の範囲（M1.4。Issue #177）。**書かなければ、従来どおり 1 つの entity の行ごとの値**である。
 *   `app` … アプリ全体で 1 つの値。**どのレコードにも属さない**（`entity` を持たない）
 *
 * アプリ全体の集計は、`where` の `this`（出力先のレコードの ID）を持たない——出力先のレコードが
 * 無いからである。`where` に `this`（`equals`・`contains`）を書けば静的チェックが
 * `LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` で断る。**期間の条件（`within`）は書ける**（M1.4。Issue #178）
 * ——比べる相手が時刻ではなく期間の名前だからである。
 */
export const COMPUTED_SCOPES = ["app"] as const;
export type ComputedScope = (typeof COMPUTED_SCOPES)[number];

/**
 * アプリ全体の計算と、見出しごとの集計が `entity` を持たないことを、型の上で表す。
 *
 * **どちらもどのレコードにも属さないので `entity` を書けない。** 正規化した JSON にも
 * `entity` は現れない。ここで `undefined` として宣言しておくのは、**`entity` を読む既存のコード
 * （精算など）をそのまま型検査に通す**ためである——それらを扱う側は、`entity` を読む前に
 * `isAppComputed`・`isGroupComputed` で分ける（`scope`・`type` を持つかどうかで見る）。
 */
interface AppScopeNoEntity {
  /** アプリ全体の計算と見出しごとの集計は `entity` を持たない（型の上だけの欄である） */
  readonly entity?: undefined;
}

/**
 * アプリ全体で 1 つの値になる、式の計算（M1.4。Issue #177）。
 * **`entity` を持たない**——どのレコードにも属さない。参照できるのは、ほかのアプリ全体の計算だけである。
 */
export interface ComputedAppExpression extends AppScopeNoEntity, LabeledDeclaration {
  readonly name: string;
  readonly scope: ComputedScope;
  readonly expression: string;
  readonly type: ComputedType;
}

/**
 * アプリ全体で 1 つの値になる、集計の計算（M1.4。Issue #177）。
 * **`entity` を持たない**——どのレコードにも属さない。`where` は `this` を持てない（`Aggregate` の注記）。
 * **期間の条件（`within`）は書ける**——比べる相手が時刻ではなく期間の名前だからである（M1.4）
 */
export interface ComputedAppAggregate extends AppScopeNoEntity, LabeledDeclaration {
  readonly name: string;
  readonly scope: ComputedScope;
  readonly aggregate: Aggregate;
  readonly type: ComputedType;
}

/**
 * **見出しごとの集計**（M1.4。Issue #179）。`type: groups` で、`aggregate` に `groupBy` を持つ。
 * 値は「見出しと値」の組の並びである（`AggregateGrouping`）。
 *
 * **`entity` も `scope` も持たない。** これは行ごとの値でも、1 つの数でもなく、**アプリ全体で 1 つの
 * 並び**だからである——どのレコードにも属さず、`scope: app` の「1 つの数」とも別の欄に載る
 * （`packages/appspec-schema/src/api.ts` の `ApiViewBody.groups`）。`groupBy` が指す項目の
 * 集計元は `aggregate.entity` が持つので、`entity` を別に書く必要が無い。
 * 意味は docs/semantics.md「groups」「groupBy」にある。
 */
export interface ComputedGroups extends AppScopeNoEntity, LabeledDeclaration {
  readonly name: string;
  readonly aggregate: Aggregate;
  readonly type: "groups";
}

/** 式で求める計算（v0.1 からの形）。v0.1 の computed_contract の entry_fields と同じ 4 つのキーを持つ。 */
export interface ComputedExpression extends LabeledDeclaration {
  readonly name: string;
  readonly entity: string;
  readonly expression: string;
  readonly type: ComputedType;
}

/** 集計で求める計算（M1.2）。`expression` と `aggregate` は択一である */
export interface ComputedAggregate extends LabeledDeclaration {
  readonly name: string;
  readonly entity: string;
  readonly aggregate: Aggregate;
  readonly type: ComputedType;
}

/**
 * 精算の宣言（M1.2）。**メンバーの差し引き額から、送金の組を出す**（Q18-4。`settle`）。
 * 宣言では「どの支出をどう割ったか」だけを指し、送金の組み方は店頭の関数が決める（`03` §2.3）。
 *
 *   expense … 割り勘の支出の entity（`entity` と同じインスタンスのレコード）
 *   amount  … その支出の額の項目（数。**整数円**である。Q18-6）
 *   payer   … 払った人（`entity` への参照）
 *   shares  … 割る人（`entity` への参照の並び）
 *
 * **余りの配賦の語彙は足さない**（Q18-5）。基準額（1 人あたりの切り捨てた額）は宣言の `owed` が持ち、
 * 余りを誰が負担するかは `settle` の内部規約（Q13）が決める（docs/semantics.md「settle」）。
 */
export interface SettleDeclaration {
  readonly expense: string;
  readonly amount: string;
  readonly payer: string;
  readonly shares: string;
}

/**
 * 精算で求める計算（M1.2）。`expression`・`aggregate` と**択一**である。
 * **`type` を持たない**——値は数ではなく、送金（送金元・送金先・正の送金額）の並びである。
 */
export interface ComputedSettle extends LabeledDeclaration {
  readonly name: string;
  readonly entity: string;
  readonly settle: SettleDeclaration;
}

/** 計算（式・集計・精算・見出しごとの集計のどれか）。計算の値は保存しない。 */
export type Computed =
  | ComputedExpression
  | ComputedAggregate
  | ComputedSettle
  | ComputedAppExpression
  | ComputedAppAggregate
  | ComputedGroups;

/**
 * アプリ全体で 1 つの値になる計算（M1.4。Issue #177）。**`entity` を持たない**ので、
 * 行ごとの値（`RowComputed`）とは別のものである。`scope: app` の**数**だけであり、
 * 見出しごとの集計（`ComputedGroups`）は含まない——あちらは数ではなく並びである（`isGroupComputed`）。
 */
export type AppComputed = ComputedAppExpression | ComputedAppAggregate;

/** 行ごとの値になる計算（式か集計）。精算と、見出しごとの集計は含まない */
export type RowComputed = ComputedExpression | ComputedAggregate;

/** 式で求める計算か（`aggregate`・`settle` の側と区別する）。アプリ全体の式も `true` である */
export const isComputedExpression = (
  computed: Computed,
): computed is ComputedExpression | ComputedAppExpression => "expression" in computed;

/** 集計で求める計算か（`expression`・`settle` の側と区別する）。アプリ全体の集計も `true` である */
export const isComputedAggregate = (
  computed: Computed,
): computed is ComputedAggregate | ComputedAppAggregate | ComputedGroups => "aggregate" in computed;

/**
 * **見出しごとの集計**（`type: groups`。M1.4。Issue #179）か。**`type` が `groups` かどうか**で見る
 * ——`scope` も `entity` も持たないので、どちらでも見分けられないからである。
 *
 * **行ごとの値でも、アプリ全体の 1 つの数でもない**（一覧の列に出さず、行の `computed` にも、
 * `scope` の欄にも入れない）。値は一覧の応答の `groups` に載る。
 */
export const isGroupComputed = (computed: Computed): computed is ComputedGroups =>
  "type" in computed && computed.type === "groups";

/**
 * アプリ全体の計算か（M1.4。Issue #177）。**`scope` を持つかどうか**で見る——
 * `entity` を持つかどうかで見ないのは、アプリ全体の計算が `entity` を「持たない」ことを
 * 型で表しているからである（`entity` を読む前に、必ずこれで分ける）。
 */
export const isAppComputed = (computed: Computed): computed is AppComputed => "scope" in computed;

/** 精算の計算か（行ごとの値を持たない唯一の計算である） */
export const isComputedSettle = (computed: Computed): computed is ComputedSettle =>
  "settle" in computed;

/**
 * 行ごとの値になる計算か。**精算と、アプリ全体の計算と、見出しごとの集計が `false`** である
 * （どれも「1 つの行の値」ではない。`RowComputed` の注記を見ること）。
 */
export const isRowComputed = (computed: Computed): computed is RowComputed =>
  !isComputedSettle(computed) && !isAppComputed(computed) && !isGroupComputed(computed);

/**
 * 操作の種類（M1.2。`kind`）。**語彙は閉じている**——書けるのはこの 3 つだけである。
 *   `create` … その entity に 1 件を追加する（従来の操作）
 *   `update` … 対象のレコード 1 件を、渡した項目で**置き換える**（`id` を取る）
 *   `delete` … 対象のレコード 1 件を消す（`id` を取る。参照されているものは消せない）
 * 意味は docs/semantics.md「action」「create」「update」「delete」にある。
 */
export const ACTION_KINDS = ["create", "update", "delete"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * 決まった値（`set` の右側。M1.3）。**式は書けない**ので、値は定数だけである
 * （数の項目は数、ほかの項目は文字列。`list` と `ref` の項目には書けない。docs/semantics.md「set」）。
 */
export type ActionSetValue = string | number;

/**
 * 決まった値への書き換え（`set`。M1.3）。項目名 → その項目に書く決まった値である。
 * **`kind: update` の操作にだけ書ける**（書き換える対象の行がある操作だけが持てる）。
 */
export type ActionSet = Readonly<Record<string, ActionSetValue>>;

/**
 * 操作。**`kind` を省略すると `create`** である（M1.1 の宣言をそのまま読めるようにする）。
 * `update` と `delete` は、入力を「項目名: 値」ではなく**対象のレコードの ID**で指す（M1.2）。
 *
 * M1.3 で `set`（決まった値への書き換え）と `when`（その行で操作してよい条件）を足した。
 * **どちらも書ける欄は `kind` が決める**（語彙は閉じている。docs/semantics.md「set」「when」）。
 *   `kind: update` … `set` と `when` を書ける
 *   `kind: delete` … `when` を書ける（書き換える値は無い）
 *   `create`（省略を含む）… どちらも書けない（対象の行が無い）
 */
export interface Action {
  readonly name: string;
  readonly entity: string;
  /** 操作の種類（M1.2）。書かなければ `create` である */
  readonly kind?: ActionKind;
  /**
   * 決まった値への書き換え（M1.3）。書いてあれば、この操作は**対象のレコードの ID だけ**を取り、
   * ここに書いた項目だけを書き換える（ほかの項目は変わらない）。`kind: update` にだけ書ける
   */
  readonly set?: ActionSet;
  /**
   * その行で操作してよい条件（M1.3）。**その entity の 1 件について評価する真偽の式**である。
   * **これはロジック層の守りであって画面の飾りではない**——偽の行への操作は Data API が断り、
   * 画面はボタンを出さないだけである（`workspace/mvp/m1/03-spec-layers-and-checker.md` §2.2）
   */
  readonly when?: string;
}

/** 操作の種類。省略は `create` として読む（M1.1 の宣言の意味を変えない） */
export const actionKind = (action: Action): ActionKind => action.kind ?? "create";

/** 対象の行 1 件を取る操作か（`update`・`delete`）。`when` を書けるのはこの 2 つだけである（M1.3） */
export const takesRow = (action: Action): boolean => actionKind(action) !== "create";

/**
 * 式の値の型。`boolean` は比べた結果にだけ現れる（項目の型にも computed の型にも無い）。
 * `date` は日付の項目と `today()` だけが作る（M1.3）。**ほかの型とは比べられない**
 * （`date` と `number` の比較は静的チェックが断る。docs/semantics.md「date」）。
 */
export type ExpressionType = "number" | "string" | "list" | "boolean" | "date";

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

/**
 * 店頭が用意する**日付の関数**（M1.3）。引数の数は固定で、いまは `today()` だけである。
 *
 * **`BUILTIN_FUNCTIONS` に混ぜない。** あちらは M1.1 の関数（数と並び）の一覧であり、
 * 「この版で使える関数は何か」をその一覧そのもので見る実装とテストがある——日付を混ぜると、
 * M1.1 の宣言を読む側の意味が変わる。**式が見る関数は 2 つの表の合わせ技**である
 * （呼ぶ側がまとめる。spec-engine の expression.ts）。
 *
 * `returns` が `date` であることに意味がある——日付の値は数でも文字列でもなく、
 * **日付どうしでだけ比べられる**（docs/semantics.md「date」）。
 */
export const DATE_FUNCTIONS = {
  /** 日本時間（Asia/Tokyo）の「今日」（`YYYY-MM-DD`）。**引数を取らない**（Q13） */
  today: { params: [], returns: "date" },
} as const satisfies Record<
  string,
  { readonly params: readonly ExpressionType[]; readonly returns: ExpressionType }
>;

/** 数どうしの計算。結果は数。 */
export const ARITHMETIC_OPERATORS = ["+", "-", "*", "/"] as const;
/** 数どうしの比較。結果は真偽。 */
export const COMPARISON_OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;

// ── UI 層 ───────────────────────────────────────────────────────

/**
 * 一覧の種類（M1.2・M1.3。04 §7.3）。`views` の `type` に書ける語彙は**この 4 つだけ**である。
 *   `table`      … 表。項目と計算を列に並べる（`show` で列と順を選べる）
 *   `settlement` … 精算の表示。API が返した送金の並び（送金元・送金先の ID と額）を、
 *                  メンバーの名前に対応づけて見せる。**画面は計算しない**（`03` §2.3）
 *   `board`      … ボード（M1.3）。`columns` が指す選択肢（`enum`）の**キーの順**に列を作り、
 *                  その値ごとにカードを並べる。`highlight` が指す真偽の計算が真の行に印を付ける
 *   `list`       … 一覧（M1.3）。**縦に積む**見せ方で、狭い画面に向く。`show` の扱いは `table` と
 *                  揃え、`filters` で画面の中を絞り込める（docs/semantics.md「view」「filters」）
 *   `dashboard`  … ダッシュボード（M1.4。Issue #180）。**行を並べない**——計算した値そのものを
 *                  `widgets` に並べる。**`entity` を持たない**（アプリ全体の値を並べるだけである）
 *
 * **`list` は、データ層の項目の型 `list`（文字列の並び）と同じ語である**——1 つの語が 2 つの層に
 * 現れるのは、この語だけである（語彙の台帳は 1 行 1 語彙なので、画面の種類の側は台帳に行を分けず、
 * 「view」の節で扱う。`vocabulary.yaml` の注記も見ること）。
 *
 * **`dashboard` も、データ層の項目の型としての `number` と同じ語を使う**——部品の種類 `number` は
 * 台帳に行を分けず、「dashboard」の節で扱う（`board` の `columns`・`highlight` と同じ扱いである）。
 * 棒 `bar`・円 `pie`（M1.4。Issue #181）と順位 `ranking`（M1.4。Issue #182）は**同じ語がほかの層に
 * 無い**ので、台帳に自分の行を持つ。
 */
export const VIEW_TYPES = ["table", "settlement", "board", "list", "dashboard"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/**
 * ダッシュボード（`type: dashboard`）に並べる部品の種類（M1.4。Issue #180・#181・#182）。
 * **語彙は閉じている**——この版で書けるのは数値 `number`（#180）・棒 `bar`・円 `pie`（#181）・
 * 順位 `ranking`（#182）である。
 */
export const VIEW_PART_TYPES = ["number", "bar", "pie", "ranking"] as const;
export type ViewPartType = (typeof VIEW_PART_TYPES)[number];

/**
 * 順位の部品（`type: ranking`。M1.4。Issue #182）の、件数の上限を省いたときの既定である。
 * **上位いくつの行を返すか**（窓口の決定 2026-09-19。`workspace/mvp/m1/02-l2-spec-examples.md` §4.3 の
 * 叩き台は `limit: 5`）。意味は docs/semantics.md「ranking」にある。
 */
export const RANKING_LIMIT_DEFAULT = 5;

/**
 * 数値の部品（`type: number`。M1.4。Issue #180）。**アプリ全体の集計（`scope: app`）の計算**を
 * 1 つ指し、その値を単位つきで見せる。
 *
 * ```yaml
 * widgets:
 *   - { type: number, label: 今月の活動, value: activityCount, unit: 回 }
 * ```
 *
 * - **`value` は、アプリ全体の集計の計算の名前だけを指せる**（`scope: app`）。行ごとの計算を
 *   指せば静的チェックが `UI_DASHBOARD_VALUE_NOT_APP_SCOPE` で断る——ダッシュボードは行を並べないので、
 *   どの行の値かが決まらないからである（docs/semantics.md「dashboard」）
 * - **単位（`unit`）は任意**である（「回」「人」「円」など）。書かなければ数をそのまま見せる
 * - **表示名（`label`）も任意**である。書かなければ `value` の識別子をそのまま見せる
 * - **値が求められなかった（`null`）ときは画面が「—」で見せ、0 と区別する**（「computed」の節と同じ）
 */
export interface NumberPart extends LabeledDeclaration {
  readonly type: "number";
  /** アプリ全体の集計（`scope: app`）の計算の名前 */
  readonly value: string;
  /** 単位（「回」「人」「円」など。任意）。書かなければ数をそのまま見せる */
  readonly unit?: string;
}

/**
 * 棒の部品（`type: bar`。M1.4。Issue #181）。**見出しごとの集計（`type: groups`）の計算**を 1 つ指し、
 * 「見出しと値」の組の並びを**棒**で見せる（「月ごとの活動回数」など）。
 *
 * ```yaml
 * widgets:
 *   - { type: bar, label: 月ごとの活動回数, value: activitiesByMonth, unit: 回 }
 * ```
 *
 * - **`value` は、見出しごとの集計（`type: groups`）の計算の名前だけを指せる。** ほか（アプリ全体の
 *   集計・行ごとの計算・実在しない名前）を指せば静的チェックが `UI_DASHBOARD_VALUE_NOT_GROUPS` で断る
 *   ——棒は「見出しと値の組の並び」を描く部品だからである（docs/semantics.md「bar」）
 * - **色だけに頼らない。** 見出しと値は**文字でも読める**（表が受け持つ。`04` §7.2）
 * - 値は一覧の応答の `groups`（計算の名前 → 組の並び）に載る。**新しい欄は作らない**（「groups」の節）
 */
export interface BarPart extends LabeledDeclaration {
  readonly type: "bar";
  /** 見出しごとの集計（`type: groups`）の計算の名前 */
  readonly value: string;
  /** 値の単位（「回」「人」など。任意）。書かなければ数をそのまま見せる */
  readonly unit?: string;
}

/**
 * 円の部品（`type: pie`。M1.4。Issue #181）。**見出しごとの集計（`type: groups`）の計算**を 1 つ指し、
 * 「見出しと値」の組の並びを**円**で見せる（「種類の内訳」など）。凡例に**割合（%）**も数字で出す。
 *
 * ```yaml
 * widgets:
 *   - { type: pie, label: 種類の内訳, value: activitiesByKind, unit: 回 }
 * ```
 *
 * 指せる計算と、値の載り方は棒（`BarPart`）と同じである（docs/semantics.md「pie」）。
 */
export interface PiePart extends LabeledDeclaration {
  readonly type: "pie";
  /** 見出しごとの集計（`type: groups`）の計算の名前 */
  readonly value: string;
  /** 値の単位（「回」「人」など。任意）。書かなければ数をそのまま見せる */
  readonly unit?: string;
}

/**
 * 順位の部品（`type: ranking`。M1.4。Issue #182）。**行を並べる部品**であって、値を 1 つ出す部品ではない
 * ——`entity` の行を、`by` の降順で `limit` 件だけ並べる（`01` §1.1）。
 *
 * ```yaml
 * widgets:
 *   - type: ranking
 *     name: topActivities
 *     label: 参加の多い活動
 *     entity: activity
 *     by: attendeeCount
 *     show: [date, kind, attendeeCount]
 * ```
 *
 * - **`name` は鍵である**（必須）。同じ一覧の `widgets` の中で重複させない。書き方は項目や計算と
 *   同じ識別子（`^[A-Za-z][A-Za-z0-9]*$`）である。**`label`（表示名）とは別物である**——`name` は鍵、
 *   `label` は画面に出す文字である。数値・棒・円の部品は `value`（計算の名前）が鍵になるが、
 *   順位の部品は `value` を持たないので、鍵にできる名前を自分で持つ
 * - **`entity` は並べる相手**である。**`by` は並べ替えの基準**——その entity の**行ごとの数の計算**
 *   （`computed`）だけを指せる。**アプリ全体の集計（`scope: app`）は指せない**（行ごとの値が無いため）
 *   ——指せば静的チェックが `UI_RANKING_BY_NOT_ROW_VALUE` で断る
 * - **`by` は `show` に含めなければならない**（出す項目の 1 つとして基準を見せる）。含めなければ
 *   `UI_RANKING_BY_NOT_SHOWN` である
 * - **`show` は出す項目**（その entity の項目か、行ごとの値になる計算）である。書いた順に出す
 * - **`limit` は件数の上限**（任意）。省略したときは `RANKING_LIMIT_DEFAULT`（5）である
 * - **表示名（`label`）は任意**である。書かなければ `name` を見出しに使う
 * - **行の形は `ApiRow` と同じ**である（画面が 2 通りの読み方を持たない。`packages/appspec-schema/src/api.ts`）。
 *   値は一覧の応答の**兄弟の欄 `ranking`**（鍵 → 行の並び、または `null`）に載る
 *
 * 意味は docs/semantics.md「ranking」にある。
 */
export interface RankingPart extends LabeledDeclaration {
  readonly type: "ranking";
  /** 鍵。同じ一覧の `widgets` の中で重複しない（`label` とは別物である） */
  readonly name: string;
  /** 並べる相手の entity の名前 */
  readonly entity: string;
  /** 並べ替えの基準になる、`entity` の行ごとの数の計算の名前 */
  readonly by: string;
  /** 出す項目（`entity` の項目か、行ごとの値になる計算）の名前。宣言の順に出す。`by` を必ず含める */
  readonly show: readonly string[];
  /** 件数の上限（1 以上）。省略したときは `RANKING_LIMIT_DEFAULT`（5）である */
  readonly limit?: number;
}

/**
 * ダッシュボードに並べる部品（M1.4。Issue #180・#181・#182）。数値（`number`）・棒（`bar`）・円（`pie`）・
 * 順位（`ranking`）である。**指せる先は種類で決まる**——数値はアプリ全体の集計、棒と円は見出しごとの
 * 集計、順位は並べる entity の行ごとの計算（`by`）である。
 */
export type ViewPart = NumberPart | BarPart | PiePart | RankingPart;

/**
 * 一覧。種類の指定の無い一覧（M1.1）は、その entity のすべてのレコードを登録順に並べる。
 *
 * M1.2 で `type` と `show` を足し、M1.3 でボード（`board`）の `columns`・`highlight` と、
 * 一覧（`list`）の `filters` を足した。**書ける欄は `type` が決める**（語彙は閉じている）。
 *   `type` なし（M1.1 と同じ）… `name`・`entity` だけ
 *   `type: table`            … 上に `type`・`show`
 *   `type: settlement`       … 上に `type`。`show` は書けない（列の並びを持たない）
 *   `type: board`            … 上に `type`・`columns`（必須）・`highlight`（任意）
 *   `type: list`             … 上に `type`・`show`（任意。扱いは `table` と同じ）・`filters`（任意）
 *   `type: dashboard`        … 上に `type`・`widgets`（必須。M1.4。Issue #180）。**`entity` は書かない**
 */
export interface View {
  readonly name: string;
  /**
   * 並べる行の entity。**`dashboard` は持たない**（M1.4。Issue #180）——行を並べず、アプリ全体の値を
   * 並べるだけだからである（`scope: app` の計算が `entity` を持たないのと同じ理由である）。
   * 正規化した JSON にも `entity` は現れない。書けば静的チェックが `SHAPE_KEY_UNKNOWN` で断る。
   */
  readonly entity?: string;
  /** 一覧の種類（M1.2・M1.3）。書かなければ種類の指定の無い一覧である */
  readonly type?: ViewType;
  /**
   * 表に出す、同じ entity の項目と計算（行ごとの値になる計算）の名前。
   * **書いた順が列の順**になる。書かなければ、項目（宣言の順）に続いて計算（宣言の順）である。
   * 実在しない名前は静的チェックが `UI_FIELD_NOT_FOUND` で断る。`type: table` と `type: list` で書ける。
   */
  readonly show?: readonly string[];
  /**
   * ボードの列にする、同じ entity の選択肢（`enum`）の項目の名前（M1.3）。**`type: board` では必須**である。
   * **列の並びは、その `options` に書いた順**である（`enumKeys` の順）。値が空の列も出す。
   * 選択肢（`enum`）の項目でなければ、静的チェックが `UI_BOARD_COLUMNS_NOT_ENUM` で断る。
   */
  readonly columns?: string;
  /**
   * ボードで強調する行を選ぶ、同じ entity の**真偽を返す計算**の名前（M1.3。任意）。
   * 真の行には印を付ける——**色だけに頼らない**（記号と文字を添える。`04` §7.2）。
   * 判定は Data API が行い、結果を一覧の行の `computed` に載せる（画面は式を評価しない）。
   * 真偽を返す計算でなければ、静的チェックが `UI_HIGHLIGHT_NOT_BOOLEAN` で断る。
   */
  readonly highlight?: string;
  /**
   * 一覧（`type: list`）で、**画面が選んで絞り込む**項目の名前（M1.3。UX 層。`04` §7.1）。
   * `show` に並べた名前のうち、**選択肢（`enum`）か参照（`ref`）の項目だけ**を指せる——
   * 値の候補を宣言から機械で出せるのが、この 2 つだけだからである（docs/semantics.md「filters」）。
   *
   * - 実在しない、または `show` に無い名前は静的チェックが `UI_FILTER_FIELD_NOT_SHOWN` で断る
   * - `enum` でも `ref` でもない項目は `UI_FILTER_FIELD_NOT_FILTERABLE` で断る
   *
   * **絞り込みは画面の中で行う。** Data API には絞り込みの引数を足さない（M1.3 は読むのは全件のまま。
   * 上限は M1.5）。選んだ値は**再読み込みで消えてよい**（持ち回さない）。
   * `type: list` のときだけ書ける（ほかの種類は列の並びを持たない）。
   */
  readonly filters?: readonly string[];
  /**
   * ダッシュボード（`type: dashboard`）に並べる部品（M1.4。Issue #180・#181・#182）。**`type: dashboard`
   * では必須**である（部品が無ければダッシュボードにならない）。**1 つ以上の部品を書く**——空の並びは
   * 静的チェックが `SHAPE_KEY_MISSING` で断る。ほかの種類の一覧では書けない（`SHAPE_KEY_UNKNOWN`）。
   *
   * 部品は、数値（`number`）・棒（`bar`）・円（`pie`）・順位（`ranking`）である。**指せる先は種類で決まる**
   * ——数値は**アプリ全体の集計**（`scope: app`）、棒と円は**見出しごとの集計**（`type: groups`）、
   * 順位は**並べる entity の行ごとの計算**（`by`）である。
   *
   * **値は部品ごとに取りに行かない。** 1 回の取得でまとめて返る——数値は応答の `scope` に（M1.4。Issue
   * #177）、棒と円の「見出しと値の組の並び」は応答の `groups` に（M1.4。Issue #179・#181）、順位の部品が
   * 返す別の entity の行は応答の兄弟の欄 `ranking` に載る（M1.4。Issue #182。`scope` の欄には混ぜない）。
   */
  readonly widgets?: readonly ViewPart[];
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
  enum: "data",
  default: "data",
  date: "data",
  validation: "logic",
  message: "logic",
  computed: "logic",
  aggregate: "logic",
  scope: "logic",
  sum: "logic",
  count: "logic",
  avg: "logic",
  within: "logic",
  groupBy: "logic",
  groups: "logic",
  settle: "logic",
  min: "logic",
  max: "logic",
  len: "logic",
  today: "logic",
  action: "logic",
  create: "logic",
  update: "logic",
  delete: "logic",
  set: "logic",
  when: "logic",
  view: "ui",
  table: "ui",
  settlement: "ui",
  board: "ui",
  dashboard: "ui",
  bar: "ui",
  pie: "ui",
  ranking: "ui",
  label: "ui",
  filters: "ux",
  permission: "permission",
  anonymous: "permission",
} as const satisfies Record<string, Layer>;
export type VocabularyName = keyof typeof VOCABULARY;
