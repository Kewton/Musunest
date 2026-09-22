// アプリケーション関数（Issue #102）。**data-api が唯一の権限強制点である**という不変条件
// （CLAUDE.md）を、この file の 3 つの関数が引き受ける。
//
//   getSpec           … 登録から正規化した JSON を引いて返す（`read` の宣言が要る）
//   getView           … 一覧の行に計算値を足して返す（`read` の宣言が要る）
//   createFromAction  … 1 件追加する（`write` の宣言が要る）
//
// 依存は**引数で受け取る**（I/O の実体をここに置かない）:
//   - 登録（D1）は control-plane の関数を adapter が包んで渡す（InstanceRegistry）
//   - 正規化した JSON（R2）は adapter が読んで渡す（NormalizedSpecStore）
//   - レコード（DO）は adapter が包んで渡す（RecordStore）
//   - 時計は引数（Clock）。**HTTP から書き換える入口は作らない**（Q17）
//
// **Cloudflare にもストレージにも触れない。** ここが受け取る型に Worker 本体（env の binding・
// DO のクラス）は出てこない——画面（host）が受け取る型に混ざらないようにするためである
// （src/index.test.ts が走査して確かめる）。
//
// 決めたこと:
//   - 登録が無い → 404。R2 のオブジェクトが無い・壊れた JSON・欄が欠けている・SHA 不一致・
//     版違い → 503。**成功応答にも書込にもならない**
//   - 宣言した action だけを実行する。任意の entity への汎用の書込口は作らない
//   - 入力の検査は input.ts（項目の型 → computed → validation の順）
//   - 計算の値は保存しない。一覧と追加の応答でその都度求める（docs/semantics.md「computed」）
//   - **操作の条件（`when`。M1.3）が偽の行に対する操作は断る**（409 `ACTION_NOT_ALLOWED`）。
//     判定は**保存された行の値**で行い、一覧の行にも結果（`allowedActions`）を載せる——
//     **画面がボタンを隠すのは親切であって守りではない**（`03` §2.2）

import type {
  Action,
  ApiActionRef,
  ApiDeletedBody,
  ApiErrorCode,
  ApiGroupValue,
  ApiPermissions,
  ApiReference,
  ApiRow,
  ApiSpecBody,
  ApiTransfer,
  ApiViewBody,
  AppSpec,
  Entity,
  NormalizedAppSpec,
  View,
} from "@musunest/appspec-schema";
import {
  API_CREATED_STATUS,
  API_READ_STATUS,
  APPSPEC_SCHEMA_VERSION_PATTERN,
  FIELD_TYPES,
  PERIODS,
  RANKING_LIMIT_DEFAULT,
  actionKind,
  fieldKind,
  fieldLabel,
  fieldTarget,
  isAppComputed,
  isComputedExpression,
  isComputedSettle,
  isGroupComputed,
  isRowComputed,
  takesRow,
} from "@musunest/appspec-schema";
import type {
  GuardedCreate,
  GuardedDelete,
  GuardedUpdate,
  RecordData,
  RecordStamp,
  ReferenceExpectation,
  ReferenceGuard,
  StoredRecord,
} from "@musunest/app-do";
import type { AppRecord } from "@musunest/control-plane";
import type { Clock, SettleResult, SourceRecord, SourceRecords } from "@musunest/spec-engine";
import {
  aggregateSourceEntities,
  allowsAction,
  appAggregateSourceEntities,
  evaluateRecord,
  evaluateScope,
  groupSourceEntities,
  groupValuesOf,
  holdsExpression,
  settleEntity,
  settleSourceEntities,
  wholeYenFields,
} from "@musunest/spec-engine";
import { checkInput, checkReferences } from "./input.js";

// ── 依存（I/O の実体は adapter が渡す） ──────────────────────────────

/** インスタンスが参照する宣言の登録。control-plane の `resolveInstanceApp` が実体 */
export interface InstanceRegistry {
  /** 未登録は `null`（例外にしない） */
  resolve(instanceId: string): Promise<AppRecord | null>;
}

/** 正規化した JSON の置き場（R2）。無いキーは `null` */
export interface NormalizedSpecStore {
  read(key: string): Promise<string | null>;
}

/** アプリのレコードの置き場（1 インスタンス 1 DO）。判定は持たない */
export interface RecordStore {
  /**
   * 1 件追加する。**参照先の実在を、書くのと同じ呼出の中で確かめる**（M1.2）——
   * 「別の呼出で確かめる → 書く」にすると、その間に参照先が消えて孤立した参照が残る。
   * `expectations` が空なら、参照を見ない素の追加である。
   */
  create(
    entity: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedCreate>;
  list(entity: string): Promise<StoredRecord[]>;
  /** entity の 1 行を ID で引く。無ければ `null`（別 entity の ID でも `null`） */
  get(entity: string, id: string): Promise<StoredRecord | null>;
  /**
   * 1 行を書き換える。**ID・作成日時・登録順は保つ**（更新日時だけを進める）。
   * 無い行は `NOT_FOUND`。参照先の実在は、追加と同じく同じ呼出の中で確かめる（M1.2）。
   */
  update(
    entity: string,
    id: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedUpdate>;
  /**
   * 参照を確かめてから 1 行を消す（M1.2）。**確認と削除は 1 つの呼出の中で行う**——
   * 「一覧を読む → 消す」の 2 回の呼出にしない（その間に別の操作が参照を足すと、孤立した参照が残る）。
   * どの項目が参照なのか（`guards`）は、宣言から data-api が組み立てて渡す。
   */
  deleteGuarded(
    entity: string,
    id: string,
    guards: readonly ReferenceGuard[],
  ): Promise<GuardedDelete>;
}

export interface DataApiDeps {
  readonly registry: InstanceRegistry;
  readonly specs: NormalizedSpecStore;
  readonly records: RecordStore;
  /** 保存する日時と評価に使う時計。テストは fixedClock を差し込む（Q17） */
  readonly clock: Clock;
}

// ── 結果の形 ────────────────────────────────────────────────────

/** 成功の HTTP ステータス（読取 200 / 追加 201） */
export type ApiStatus = typeof API_READ_STATUS | typeof API_CREATED_STATUS;

export interface ApiSuccess<Body> {
  readonly ok: true;
  readonly status: ApiStatus;
  readonly body: Body;
}

/** 断った結果。`fields` と `validations` は `INPUT_REJECTED` のときだけ中身を持つ */
export interface ApiFailure {
  readonly error: ApiErrorCode;
  readonly fields: readonly string[];
  readonly validations: readonly string[];
  /**
   * 通らなかった検査の文言（`validations` と同じ並び。文言の無い検査は `null`）。
   * **文言を 1 つも宣言していない宣言では持たない**（M1.1 の応答を変えない。Issue #106）。
   */
  readonly validationMessages?: readonly (string | null)[];
  /**
   * 参照されているレコードを消そうとしたときの参照元（`REFERENCE_IN_USE` のときだけ。M1.2）。
   * **参照元の entity と項目、件数**を載せる（画面が理由を出せるようにする）。
   */
  readonly references?: readonly ApiReference[];
  /** 断った操作の名前（`ACTION_NOT_ALLOWED` のときだけ。M1.3） */
  readonly action?: string;
  /** その操作の条件（宣言の `when` の式。`ACTION_NOT_ALLOWED` のときだけ。M1.3） */
  readonly when?: string;
}

export interface ApiFailureResult {
  readonly ok: false;
  readonly failure: ApiFailure;
}

/**
 * 操作（`POST /actions/:name`）の応答。宣言した `kind` で決まる（M1.2）。
 *   `create` … 201 と、**書いた行**
 *   `update` … 200 と、**書き換えた行**
 *   `delete` … 200 と、**消したこと**（消せないときは 409 `REFERENCE_IN_USE`）
 */
export type ApiActionBody = ApiRow | ApiDeletedBody;

export type ApiResult<Body> = ApiSuccess<Body> | ApiFailureResult;

const ok = <Body>(status: ApiStatus, body: Body): ApiSuccess<Body> => ({ ok: true, status, body });

const fail = (
  error: ApiErrorCode,
  fields: readonly string[] = [],
  validations: readonly string[] = [],
  validationMessages?: readonly (string | null)[],
  references?: readonly ApiReference[],
): ApiFailureResult => ({
  ok: false,
  failure: {
    error,
    fields,
    validations,
    ...(validationMessages === undefined ? {} : { validationMessages }),
    ...(references === undefined ? {} : { references }),
  },
});

/**
 * 操作の条件（`when`）が成り立たない行への操作を断る（M1.3。409 `ACTION_NOT_ALLOWED`）。
 * **どの操作のどの条件で断ったかを載せる**——画面がそのまま見せられるようにする。
 * **`INPUT_REJECTED` を使い回さない**（「入力が悪い」と「いまその操作はできない」は別物である）。
 */
const notAllowed = (action: Action): ApiFailureResult => ({
  ok: false,
  failure: {
    error: "ACTION_NOT_ALLOWED",
    fields: [],
    validations: [],
    action: action.name,
    when: action.when ?? "",
  },
});

/**
 * 通らなかった検査の文言（`validations` と同じ並び）。文言を 1 つも宣言していなければ `undefined`
 * （＝応答に欄を載せない。読む側は検査の名前で識別する）。
 */
function messagesOf(
  app: NormalizedAppSpec,
  validations: readonly string[],
): readonly (string | null)[] | undefined {
  if (validations.length === 0) return undefined;
  const messages = validations.map(
    (name) => app.spec.validations.find((validation) => validation.name === name)?.message ?? null,
  );
  return messages.some((message) => message !== null) ? messages : undefined;
}

// ── 宣言の読み込み（登録 → R2 → 整合性） ─────────────────────────────

type SpecLoad =
  | { readonly ok: true; readonly app: NormalizedAppSpec }
  | { readonly ok: false; readonly error: "NOT_FOUND" | "SPEC_UNAVAILABLE" };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 写像が、名前の付いた文字列の欄をすべて持つか */
const hasStrings = (value: unknown, keys: readonly string[]): boolean =>
  isRecord(value) && keys.every((key) => typeof value[key] === "string");

/** 任意の欄。無いか、文字列であること（検査の文言 `message`。M1.2） */
const hasOptionalString = (value: unknown, key: string): boolean =>
  isRecord(value) && (value[key] === undefined || typeof value[key] === "string");

/**
 * 選択肢の項目（M1.3。`{type: enum, options, default}`）。`options` は「保存される値（キー）→
 * 画面に出す表示名」で、キーが 1 つ以上ある。`default` は書いてあるときだけ、`options` のキーで
 * なければならない（docs/semantics.md「enum」「default」）。
 *
 * **キーの重複はこの層では見られない。** `JSON.parse` は同じキーの後ろを残すので、重複したキーは
 * ここへ届く前に 1 つになる。重複を断るのは静的チェック（`DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE`）である。
 * ここが引き受けるのは「**配信された正規化 JSON に、この型の項目があっても読めるか**」である——
 * 読めないと `getSpec` / `getView` が 503 になり、静的チェックが通っていても画面が動かない（#145）。
 */
function isEnumDeclaration(value: Record<string, unknown>): boolean {
  const options = value["options"];
  if (!isRecord(options) || Object.keys(options).length === 0) return false;
  if (!Object.values(options).every((label) => typeof label === "string" && label !== "")) return false;
  const fallback = value["default"];
  return fallback === undefined || (typeof fallback === "string" && Object.hasOwn(options, fallback));
}

/**
 * 表示名（`label`。M1.3。Issue #176）は任意である。**載っているときだけ**、空でない文字列で
 * あることを要求する（空文字は表示名にならない。静的チェックも `SHAPE_LABEL_EMPTY` で断る）。
 */
function isOptionalLabel(value: Record<string, unknown>): boolean {
  const label = value["label"];
  return label === undefined || (typeof label === "string" && label !== "");
}

/**
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、写像**
 * （1 語の型を写像で書いた `{type: string, label}`・参照の `{type: ref, to}`・参照の並びの
 * `{type: list, of}`・選択肢の `{type: enum, options, default}`）の両方を受け取る（M1.2・M1.3）。
 */
function isFieldDeclaration(value: unknown): boolean {
  if (typeof value === "string") return (FIELD_TYPES as readonly string[]).includes(value);
  if (!isRecord(value)) return false;
  if (!isOptionalLabel(value)) return false;
  const type = value["type"];
  if (type === "ref") return typeof value["to"] === "string";
  // `of` の無い `{type: list}` は、文字列の並び（`label` を付けるときの写像の形）である
  if (type === "list") return value["of"] === undefined || typeof value["of"] === "string";
  if (type === "enum") return isEnumDeclaration(value);
  // 1 語の型を写像で書いたもの（`label` を付けるときの形。M1.3）
  return typeof type === "string" && (FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * 決まった値への書き換え（`set`。M1.3）の形。**項目名 → 文字列か数**である（式は書けないので、
 * 宣言に残るのは定数だけである）。空の写像は「書いていない」と区別が付かないので受け取らない。
 */
function isActionSetShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  if (entries.length === 0) return false;
  return entries.every((entry) => typeof entry === "string" || typeof entry === "number");
}

/**
 * 操作の形（M1.3）。`name`・`entity` に加えて、`set`（決まった値への書き換え）と
 * `when`（その行で操作してよい条件）を**載っているときだけ**確かめる。
 *
 * **配信された正規化 JSON を読めなくしない**のがここの仕事である——読めないと `getSpec` /
 * `getView` が 503 になり、静的チェックが通っていても画面が動かない（#145・#154 と同じ穴）。
 */
function isActionShape(action: unknown): boolean {
  if (!hasStrings(action, ["name", "entity"])) return false;
  if (!isRecord(action)) return false;
  if (action["set"] !== undefined && !isActionSetShape(action["set"])) return false;
  return action["when"] === undefined || typeof action["when"] === "string";
}

/**
 * 集計の `where` の 1 つの条件（M1.2・M1.4）。**正規化のあとは、どれも `op` を持つオブジェクト**である
 * （窓口の決定 2026-09-20）。`within`（期間の条件）は、この版の期間の名前（`PERIODS`）を持つ。
 */
function isWhereCondition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["op"] === "equals" || value["op"] === "contains") return true;
  return (
    value["op"] === "within" &&
    typeof value["period"] === "string" &&
    (PERIODS as readonly string[]).includes(value["period"])
  );
}

/**
 * 見出しごとに分ける対象（`groupBy`。M1.4。Issue #179）の形。`field` は文字列、`month` は真偽である。
 * **実在や型（`enum`・`date` かどうか）は静的チェックが見る**——ここが引き受けるのは
 * 「配信された正規化 JSON に、この欄があっても読めるか」だけである。
 */
function isGroupingShape(value: unknown): boolean {
  return isRecord(value) && typeof value["field"] === "string" && typeof value["month"] === "boolean";
}

/**
 * 集計（`aggregate`）の形（M1.2・M1.4）。`sum`・`avg` は対象の名前を持ち、`count` は持たない。
 * どちらも `where`（項目 → `op` を持つオブジェクト）を持ち、`groupBy`（見出しごとの集計。M1.4）と
 * `last`（見出しの上限）を**載っているときだけ**確かめる。
 */
function isAggregateShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value["kind"];
  if (kind !== "sum" && kind !== "count" && kind !== "avg") return false;
  if (typeof value["entity"] !== "string") return false;
  if (kind === "count" ? value["name"] !== null : typeof value["name"] !== "string") return false;
  const where = value["where"];
  if (!isRecord(where)) return false;
  if (!Object.values(where).every(isWhereCondition)) return false;
  if (value["groupBy"] !== undefined && !isGroupingShape(value["groupBy"])) return false;
  if (value["last"] !== undefined) {
    const last = value["last"];
    if (typeof last !== "number" || !Number.isInteger(last) || last < 1) return false;
  }
  return true;
}

/** 精算（`settle`）の宣言の形（M1.2）。支出の entity と、その 3 つの項目の名前を持つ */
function isSettleShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["expense", "amount", "payer", "shares"].every((key) => typeof value[key] === "string");
}

/**
 * computed の 1 件は、式（`expression`）か集計（`aggregate`）か精算（`settle`）の**どれか 1 つ**である（M1.2）。
 * 精算だけが `type` を持たない（値は数ではなく送金の並びである）。
 */
function isComputedShape(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (!isOptionalLabel(entry)) return false;
  const hasExpression = typeof entry["expression"] === "string";
  const hasAggregate = entry["aggregate"] !== undefined;
  const hasSettle = entry["settle"] !== undefined;
  if ([hasExpression, hasAggregate, hasSettle].filter(Boolean).length !== 1) return false;
  if (hasExpression) return true;
  return hasAggregate ? isAggregateShape(entry["aggregate"]) : isSettleShape(entry["settle"]);
}

/**
 * 一覧（`views`）の形（M1.4。Issue #180）。**ダッシュボード（`type: dashboard`）は `entity` を持たない**
 * ——行を並べず、アプリ全体の値（`scope`）を部品で見せるだけだからである。だから `name` だけを要求し、
 * `entity` があれば断る（`scope: app` の計算が `entity` を持たないのと同じ扱いである）。
 * 行を並べる一覧は、従来どおり `name` と `entity` を要する。
 */
function isViewShape(view: unknown): boolean {
  const dashboard = isRecord(view) && view["type"] === "dashboard";
  if (!hasStrings(view, dashboard ? ["name"] : ["name", "entity"])) return false;
  if (dashboard && view["entity"] !== undefined) return false;
  return true;
}

/** 宣言の 7 欄が、期待する形で揃っているか（**欄そのものが欠けていたら断る**） */
function isSpecShape(spec: unknown): spec is AppSpec {
  if (!isRecord(spec)) return false;
  const { entities, views, actions, validations, computed, permissions, minIdentity } = spec;
  if (!Array.isArray(entities)) return false;
  for (const entity of entities) {
    if (!hasStrings(entity, ["name"])) return false;
    if (!isRecord(entity) || !isRecord(entity["fields"])) return false;
    if (!Object.values(entity["fields"]).every(isFieldDeclaration)) return false;
  }
  // **すべての一覧に `entity` を要求しない**（M1.4。Issue #180）——`dashboard` は `entity` を持たない。
  // `entity` を要求したままにすると、`dashboard` を足した瞬間に `isSpecShape` が false を返し、
  // 9 ゲート緑・CI 緑のまま staging の `getSpec` が 503 になる（#154 で実際に起きた形）
  if (!Array.isArray(views) || !views.every(isViewShape)) return false;
  if (!Array.isArray(actions) || !actions.every(isActionShape)) return false;
  if (!Array.isArray(validations)) return false;
  for (const validation of validations) {
    if (!hasStrings(validation, ["name", "entity", "expression"])) return false;
    if (!hasOptionalString(validation, "message")) return false;
  }
  if (!Array.isArray(computed)) return false;
  for (const entry of computed) {
    // 精算（`settle`）は数ではなく送金の並びを返すので、`type` を持たない（M1.2）
    const settles = isRecord(entry) && entry["settle"] !== undefined;
    // **アプリ全体の計算（`scope: app`。M1.4）は `entity` を持たない**——どのレコードにも属さない
    const appScoped = isRecord(entry) && entry["scope"] === "app";
    // **見出しごとの集計（`type: groups`。M1.4。Issue #179）は `scope` も `entity` も持たない**
    const grouped = isRecord(entry) && entry["type"] === "groups";
    const strings = settles
      ? ["name", "entity"]
      : appScoped || grouped
        ? ["name", "type"]
        : ["name", "entity", "type"];
    if (!hasStrings(entry, strings)) return false;
    if (appScoped && entry["entity"] !== undefined) return false;
    if (grouped && (entry["entity"] !== undefined || entry["scope"] !== undefined)) return false;
    // 式・集計・精算のどれか 1 つである（M1.2）
    if (!isComputedShape(entry)) return false;
  }
  if (!Array.isArray(permissions) || !permissions.every((entry) => hasStrings(entry, ["name", "subject"]))) {
    return false;
  }
  return hasStrings(minIdentity, ["mode"]);
}

/**
 * 正規化した JSON（Issue #98）を読む。読めない・欄が欠けている・版の形が違うものは `null`。
 * **壊れた JSON を成功値に読み替えない。**
 */
export function readNormalizedApp(text: string): NormalizedAppSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { schemaVersion, sourceSha256, spec } = value;
  if (typeof schemaVersion !== "string" || !APPSPEC_SCHEMA_VERSION_PATTERN.test(schemaVersion)) return null;
  if (typeof sourceSha256 !== "string" || !SHA256_PATTERN.test(sourceSha256)) return null;
  if (!isSpecShape(spec)) return null;
  return { schemaVersion, sourceSha256, spec };
}

/**
 * インスタンスの宣言を読む。**登録と R2 のオブジェクトを突き合わせてから返す。**
 * 版と原本の SHA-256 が登録と食い違えば、読み書きを進めない（どちらも 503）。
 */
async function loadSpec(deps: DataApiDeps, instanceId: string): Promise<SpecLoad> {
  const registration = await deps.registry.resolve(instanceId);
  if (registration === null) return { ok: false, error: "NOT_FOUND" };
  const text = await deps.specs.read(registration.normalizedKey);
  if (text === null) return { ok: false, error: "SPEC_UNAVAILABLE" };
  const app = readNormalizedApp(text);
  if (app === null) return { ok: false, error: "SPEC_UNAVAILABLE" };
  if (app.sourceSha256 !== registration.sourceSha256) return { ok: false, error: "SPEC_UNAVAILABLE" };
  if (app.schemaVersion !== registration.schemaVersion) return { ok: false, error: "SPEC_UNAVAILABLE" };
  return { ok: true, app };
}

// ── 宣言から引く ────────────────────────────────────────────────

/** 宣言していない権限は誰にも与えない（docs/semantics.md「permission」） */
const permissionsOf = (app: NormalizedAppSpec): ApiPermissions => ({
  read: app.spec.permissions.some((permission) => permission.name === "read"),
  write: app.spec.permissions.some((permission) => permission.name === "write"),
});

/**
 * 宣言した操作（宣言の順）。`kind`（種類。M1.2）は**書いてあるときだけ載せる**——
 * 省略は `create` であり、載せると M1.1 の応答が変わってしまう（画面は無ければ create として読む）。
 */
const actionsOf = (app: NormalizedAppSpec): readonly ApiActionRef[] =>
  app.spec.actions.map((action) => ({
    name: action.name,
    entity: action.entity,
    ...(action.kind === undefined ? {} : { kind: action.kind }),
  }));

const computedNamesOf = (app: NormalizedAppSpec, entity: string): readonly string[] =>
  app.spec.computed
    // 精算（`settle`）は行ごとの値ではないので、一覧の列に出さない（M1.2）。
    // **真偽（`boolean`）の計算も列に出さない**（M1.3）——強調（`highlight`）が指すためだけに使い、
    // 値は行の `computed` に載せるが、列の並び（この応答の `computed`）には入れない。
    // **アプリ全体の計算（`scope: app`。M1.4）も列に出さない**——行ではなく、1 つの値だからである
    .filter((entry) => isRowComputed(entry) && entry.entity === entity && entry.type !== "boolean")
    .map((entry) => entry.name);

/**
 * **画面に出す名前（`label`。M1.3。Issue #176）**。項目と計算の両方を集める（名前 → 表示名）。
 * **`label` を書いていないものは入らない**——画面は、無ければ識別子をそのまま出す。
 *
 * **列に出さない計算（真偽の `boolean`。強調が指す）の `label` も入れる**——強調の印の文字に使う。
 * `label` が 1 つも無ければ `undefined`（＝応答に欄を載せない。M1.1〜M1.3 の応答を変えない）。
 */
function labelsOf(app: NormalizedAppSpec, entity: Entity): Readonly<Record<string, string>> | undefined {
  const labels: Record<string, string> = {};
  for (const [name, declaration] of Object.entries(entity.fields)) {
    const label = fieldLabel(declaration);
    if (label !== null) labels[name] = label;
  }
  for (const entry of app.spec.computed) {
    // アプリ全体の計算と、見出しごとの集計は entity を持たない（この一覧の entity のものではない）
    if (isAppComputed(entry) || isGroupComputed(entry) || entry.entity !== entity.name) continue;
    if (entry.label !== undefined) labels[entry.name] = entry.label;
  }
  return Object.keys(labels).length === 0 ? undefined : labels;
}

/**
 * ボードの強調（`highlight`。M1.3）が指す計算。名前と、行ごとに解く式である。
 * **式で求める真偽の計算だけ**を対象にする——集計と精算は数を返すので強調に使えない（静的チェックが断る）。
 */
interface Highlight {
  readonly name: string;
  readonly expression: string;
}

/**
 * 一覧の宣言から、強調に使う計算を引く。`highlight` を書いていなければ `undefined`
 * （応答の行に真偽の値を載せない）。**画面は式を評価しない**ので、解くのはここ（Data API）である。
 */
function highlightOf(app: NormalizedAppSpec, view: View, entity: string): Highlight | undefined {
  const name = view.highlight;
  if (name === undefined) return undefined;
  const entry = app.spec.computed.find(
    (candidate) => isRowComputed(candidate) && candidate.entity === entity && candidate.name === name,
  );
  if (entry === undefined || !isComputedExpression(entry)) return undefined;
  return { name, expression: entry.expression };
}

/** その entity に精算（`settle`）を宣言しているか。宣言が無ければ、応答に `settlement` を載せない */
const declaresSettle = (app: NormalizedAppSpec, entity: string): boolean =>
  app.spec.computed.some((entry) => isComputedSettle(entry) && entry.entity === entity);

/**
 * **アプリ全体の集計（`scope: app`。M1.4。Issue #177）の値**を、宣言の順に求める。
 * アプリ全体の計算が 1 つも宣言されていなければ `undefined`（＝応答に欄を載せない。
 * `settlement` と同じ約束である）。**行ごとの値ではない**——レコードの数に関わらず 1 つ返る。
 *
 * **1 回の取得でまとめて返す**（部品ごとに取りに行かない）。値が求められなかった計算は `null`
 * である（0 に読み替えない）。
 */
function scopeValuesOf(
  app: NormalizedAppSpec,
  clock: Clock,
  sources: SourceRecords,
): Readonly<Record<string, number | null>> | undefined {
  const declared = app.spec.computed.filter(isAppComputed);
  if (declared.length === 0) return undefined;
  const values = evaluateScope({ app, clock, sources });
  const scope: Record<string, number | null> = {};
  for (const entry of declared) scope[entry.name] = values[entry.name] ?? null;
  return scope;
}

/**
 * **見出しごとの集計（`groupBy`。M1.4。Issue #179）の値**を、宣言の順に求める。
 * 見出しごとの計算が 1 つも宣言されていなければ `undefined`（＝応答に欄を載せない。
 * `settlement`・`scope` と同じ約束である）。集計元を読めなかった計算は `null` である
 * ——**空の並び（合う行が無い）に読み替えない**。
 *
 * **行ごとの値でも、`scope` の値でもない**——「見出しと値」の組の並びを、専用の欄（`groups`）に載せる。
 */
function groupsValuesOf(
  app: NormalizedAppSpec,
  clock: Clock,
  sources: SourceRecords,
): Readonly<Record<string, readonly ApiGroupValue[] | null>> | undefined {
  const declared = app.spec.computed.filter(isGroupComputed);
  if (declared.length === 0) return undefined;
  const groups: Record<string, readonly ApiGroupValue[] | null> = {};
  for (const entry of declared) groups[entry.name] = groupValuesOf(app, entry.aggregate, sources, clock);
  return groups;
}

/**
 * **順位の部品（`type: ranking`。M1.4。Issue #182）が並べる相手**の entity の名前である（重複を除く）。
 * この entity のレコードを読んでおく——**行ごとに読み直さない**（D-1 の線。1 回の取得でまとめて返す）。
 */
function rankingEntitiesOf(view: View): readonly string[] {
  const names = new Set<string>();
  for (const part of view.widgets ?? []) {
    if (part.type === "ranking") names.add(part.entity);
  }
  return [...names];
}

/** 順位の基準（`by`）の値。行の計算値のうち、その名前の値である（数でなければ `null`） */
function rankedValueOf(row: ApiRow, by: string): number | null {
  const value = row.computed[by];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 順位の並べ替え（**降順。同じ値は登録した順**で安定させる。M1.4。Issue #182）。**基準の値が求められなかった
 * 行（`null`）は、数のある行の後ろ**に置く——順位が決まらないので、上位には入れない。同数（同じ `null` を含む）
 * は `index`（登録した順）で決める。
 */
function compareRanked(
  left: { readonly index: number; readonly value: number | null },
  right: { readonly index: number; readonly value: number | null },
): number {
  if (left.value === right.value) return left.index - right.index;
  if (left.value === null) return 1;
  if (right.value === null) return -1;
  return right.value - left.value;
}

/**
 * **順位の部品（`type: ranking`。M1.4。Issue #182）の値**を、部品の鍵（`name`）→ **行の並び**で求める。
 * 順位の部品が 1 つも宣言されていなければ `undefined`（＝応答に欄を載せない。`scope`・`groups` と同じ約束）。
 * 行を読めなかった順位（entity が宣言に無い）は **`null`** である——**空の並び（該当が 0 件）に読み替えない**。
 *
 * **並べ替えるのはここ（Data API）である**——画面は式も集計も評価しない（`CLAUDE.md` の不変条件）。
 * 返す行の形は `ApiRow` と同じにする（画面が 2 通りの読み方を持たない。追記 2）。件数は部品の `limit`
 * （省いたときは `RANKING_LIMIT_DEFAULT`。窓口の決定 2026-09-19）で切る。
 */
function rankingValuesOf(
  app: NormalizedAppSpec,
  view: View,
  clock: Clock,
  sources: SourceRecords,
  stored: Readonly<Record<string, readonly StoredRecord[]>>,
): Readonly<Record<string, readonly ApiRow[] | null>> | undefined {
  const parts = view.widgets ?? [];
  if (!parts.some((part) => part.type === "ranking")) return undefined;
  const ranking: Record<string, readonly ApiRow[] | null> = {};
  for (const part of parts) {
    if (part.type !== "ranking") continue;
    const entity = app.spec.entities.find((candidate) => candidate.name === part.entity);
    const rows = stored[part.entity];
    if (entity === undefined || rows === undefined) {
      ranking[part.name] = null;
      continue;
    }
    ranking[part.name] = rows
      .map((record) => toApiRow(app, entity.name, record, clock, sources))
      .map((row, index) => ({ row, index, value: rankedValueOf(row, part.by) }))
      .sort(compareRanked)
      .slice(0, part.limit ?? RANKING_LIMIT_DEFAULT)
      .map((entry) => entry.row);
  }
  return ranking;
}

// ── その行で操作してよいか（M1.3。Issue #156） ────────────────────────
//
// **`when` はロジック層の守りである**（`03` §2.2）。判定するのはここ（唯一の権限強制点）で、
// 画面はその答えを見てボタンを出し分けるだけである。一覧の行に判定の結果を載せるのは、
// **画面が式を評価しなくてよいようにする**ためである（CLAUDE.md の不変条件）。

/** 対象の行 1 件を取る操作（`update`・`delete`）。宣言の順のまま */
const rowActionsOf = (app: NormalizedAppSpec, entity: string): readonly Action[] =>
  app.spec.actions.filter((action) => action.entity === entity && takesRow(action));

/**
 * その entity の操作が 1 つでも条件（`when`）を持つか。持たなければ、応答に `allowedActions` を
 * 載せない（判定そのものが無いので、M1.2 の応答を変えない）。
 */
const declaresWhen = (app: NormalizedAppSpec, entity: string): boolean =>
  rowActionsOf(app, entity).some((action) => action.when !== undefined);

/**
 * **この行に対して、いま実行してよい操作の名前**（宣言の順）。条件を宣言していない entity では
 * `undefined`（＝応答に欄を載せない）。`when` を持たない操作はいつでも実行できるので、常に入る。
 */
function allowedActionsOf(
  app: NormalizedAppSpec,
  entity: string,
  record: StoredRecord,
  clock: Clock,
  sources: SourceRecords,
): readonly string[] | undefined {
  if (!declaresWhen(app, entity)) return undefined;
  return rowActionsOf(app, entity)
    .filter(
      (action) =>
        action.when === undefined ||
        allowsAction(
          { app, entity, record: record.data, clock, recordId: record.id, sources },
          action.when,
        ),
    )
    .map((action) => action.name);
}

/** 1 行を API の形にする。**計算の値は保存された値からその都度求める** */
function toApiRow(
  app: NormalizedAppSpec,
  entity: string,
  record: StoredRecord,
  clock: Clock,
  sources: SourceRecords,
  /** この行を参照している保存済みの行（M1.2）。`delete` を宣言していない entity では `undefined` */
  references?: readonly ApiReference[],
  /** ボードの強調（`highlight`。M1.3）。無ければ真偽の値を載せない */
  highlight?: Highlight,
): ApiRow {
  const { computed } = evaluateRecord({
    app,
    entity,
    record: record.data,
    clock,
    recordId: record.id,
    sources,
  });
  // 強調（`highlight`）の判定は**ここ（Data API）で行う**（M1.3）。画面は式を評価しない——
  // 真偽の計算の値を行の `computed` に載せ、画面はそれをそのまま見て印を付けるだけである。
  // **この名前は列の並び（`computedNamesOf`）には入らない**ので、一覧の列にはならない
  const values: Record<string, number | boolean | null> =
    highlight === undefined
      ? computed
      : {
          ...computed,
          [highlight.name]: holdsExpression(
            { app, entity, record: record.data, clock, recordId: record.id, sources },
            highlight.expression,
          ),
        };
  // 操作の条件（M1.3）。条件を宣言していない entity では欄そのものを載せない
  const allowedActions = allowedActionsOf(app, entity, record, clock, sources);
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    fields: record.data,
    computed: values,
    ...(references === undefined ? {} : { references }),
    ...(allowedActions === undefined ? {} : { allowedActions }),
  };
}

// ── 参照されている行は消せない（M1.2。Issue #109） ────────────────────
//
// 消せるかどうかは**保存済みの行**に依るので、静的チェックには判定できない（03 §5.1）。
// data-api（唯一の権限強制点）が、宣言から「どの項目が参照か」を組み立てる。消すときは
// **その並びを DO へ渡し、同じ呼出の中で数えて消してもらう**（確認と削除の間に参照が足されない）。
// 一覧の行にも「参照している行」を載せ、画面が消せる行にだけボタンを出す（守りはサーバ側）。

/** 対象を指す参照の項目（`ref` か参照 list） */
interface ReferenceField {
  readonly entity: string;
  readonly field: string;
  readonly list: boolean;
}

/** 宣言の中で `target` の entity を指す参照の項目を**すべて**集める（entity と項目の宣言の順） */
function referenceFieldsTo(spec: AppSpec, target: string): readonly ReferenceField[] {
  const fields: ReferenceField[] = [];
  for (const entity of spec.entities) {
    for (const [name, declaration] of Object.entries(entity.fields)) {
      if (fieldTarget(declaration) !== target) continue;
      fields.push({ entity: entity.name, field: name, list: fieldKind(declaration) === "list" });
    }
  }
  return fields;
}

/** 1 つの参照の値が、対象の ID を指しているか（`ref` は一致、参照 list は包含） */
function refersTo(value: unknown, field: ReferenceField, id: string): boolean {
  if (field.list) return Array.isArray(value) && value.includes(id);
  return value === id;
}

/**
 * これから書く行が指す参照（`ref`・参照 list）を、**保存の境界（DO）へ渡す形**にする。
 * 参照先の実在を、書き込むのと同じ呼出の中で見てもらうためである——data-api が別の呼出で
 * 確かめてから書くと、その間に参照先が消えて孤立した参照が残る（`id`・`createdAt` を境界が
 * 付け直すのと同じ考え方で、境界が規則をもう一度当てる）。
 */
function referenceExpectationsFor(entity: Entity): readonly ReferenceExpectation[] {
  const expectations: ReferenceExpectation[] = [];
  for (const [field, declaration] of Object.entries(entity.fields)) {
    const to = fieldTarget(declaration);
    if (to === null) continue;
    expectations.push({ field, to, list: fieldKind(declaration) === "list" });
  }
  return expectations;
}

/** その entity に `delete` の操作を宣言しているか（していなければ、応答に `references` を載せない） */
const declaresDelete = (spec: AppSpec, entity: string): boolean =>
  spec.actions.some((action) => action.entity === entity && actionKind(action) === "delete");

/**
 * 一覧の行ごとに、**その行を参照している保存済みの行**を数える（M1.2）。
 * `delete` の操作を宣言していない entity では `null`（＝応答に `references` を載せない）。参照の項目が
 * 1 つも無ければ、レコードを読まずに「どの行も参照されていない」を返す。
 */
async function referencesByRow(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: Entity,
  rows: readonly StoredRecord[],
): Promise<ReadonlyMap<string, readonly ApiReference[]> | null> {
  if (!declaresDelete(app.spec, entity.name)) return null;
  const ids = rows.map((row) => row.id);
  const found = new Map<string, ApiReference[]>(ids.map((id) => [id, []]));
  const rowsByEntity = new Map<string, readonly StoredRecord[]>();
  for (const field of referenceFieldsTo(app.spec, entity.name)) {
    let sources = rowsByEntity.get(field.entity);
    if (sources === undefined) {
      sources = await deps.records.list(field.entity);
      rowsByEntity.set(field.entity, sources);
    }
    const counts = new Map<string, number>();
    for (const source of sources) {
      for (const id of ids) {
        if (refersTo(source.data[field.field], field, id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    // 宣言の順に積む（件数が 0 の項目は理由にしない）
    for (const [id, count] of counts) {
      found.get(id)?.push({ entity: field.entity, field: field.field, count });
    }
  }
  return found;
}

/** 行の `references`。`null`（宣言が無い）のときは `undefined` にして、欄そのものを載せない */
function referencesOf(
  index: ReadonlyMap<string, readonly ApiReference[]> | null,
  id: string,
): readonly ApiReference[] | undefined {
  return index === null ? undefined : (index.get(id) ?? []);
}

/**
 * 集計（`aggregate`）と精算（`settle`）に要る、ほかの entity のレコードを読む（M1.2）。
 * **同じインスタンスの DO から読む**ので、別インスタンスのレコードは混ざらない。
 * どちらも使わない宣言では 1 つも読まない。
 *
 * `extra` は**アプリ全体の集計（`scope: app`。M1.4）が要る entity** の名前である
 * （`appAggregateSourceEntities`）。`known` は**既に読んである行**——一覧の entity をアプリ全体の
 * 集計が指すとき、同じ行を 2 度読まないためである（D-1 の線。Issue #177 追記 3）。
 */
async function loadSources(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: string,
  extra: readonly string[] = [],
  known: Readonly<Record<string, readonly StoredRecord[]>> = {},
): Promise<SourceRecords> {
  const sources: Record<string, readonly SourceRecord[]> = {};
  const names = new Set([
    ...aggregateSourceEntities(app, entity),
    ...settleSourceEntities(app, entity),
    ...extra,
  ]);
  for (const name of names) {
    const rows = known[name] ?? (await deps.records.list(name));
    sources[name] = rows.map((row) => ({ id: row.id, data: row.data }));
  }
  return sources;
}

/**
 * その entity の精算（誰が誰へいくら）を求める。**宣言していなければ `undefined`**（応答に欄を載せない）。
 * 読めなかった支出の行があれば `null` にする——**空の並び（送金が要らない）に読み替えない**
 * （`computed` の `null` と同じ約束である）。
 */
function settlementOf(
  app: NormalizedAppSpec,
  entity: string,
  stored: readonly StoredRecord[],
  sources: SourceRecords,
): readonly ApiTransfer[] | null | undefined {
  if (!declaresSettle(app, entity)) return undefined;
  const result: SettleResult = settleEntity({
    app,
    entity,
    records: stored.map((record) => ({ id: record.id, data: record.data })),
    sources,
  });
  return result.ok ? result.transfers : null;
}

/**
 * 精算の対象の額は**整数円**である（Q18-6）。小数・数でない値は、入力の検査で断る
 * （型の検査と同じく、**保存もしないし、検査の式も評価しない**）。
 */
function checkWholeYen(
  app: NormalizedAppSpec,
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly fields: readonly string[] } {
  const fields = wholeYenFields(app, entity.name).filter((name) => {
    const value = input[name];
    return value !== undefined && (typeof value !== "number" || !Number.isInteger(value));
  });
  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}

// ── 公開の 3 操作 ───────────────────────────────────────────────

/** `GET /api/instances/:instanceId/spec`。`read` の宣言が無ければ 403 */
export async function getSpec(
  deps: DataApiDeps,
  instanceId: string,
): Promise<ApiResult<ApiSpecBody>> {
  const loaded = await loadSpec(deps, instanceId);
  if (!loaded.ok) return fail(loaded.error);
  const { app } = loaded;
  const permissions = permissionsOf(app);
  if (!permissions.read) return fail("PERMISSION_DENIED");
  return ok(API_READ_STATUS, {
    instanceId,
    schemaVersion: app.schemaVersion,
    sourceSha256: app.sourceSha256,
    spec: app.spec,
    permissions,
    actions: actionsOf(app),
  });
}

/**
 * `GET /api/instances/:instanceId/views/:viewName`。
 * 行・宣言順の表示に必要な情報（`fields`・`computed`）・操作の可否を返す。`read` が無ければ 403。
 */
export async function getView(
  deps: DataApiDeps,
  instanceId: string,
  viewName: string,
): Promise<ApiResult<ApiViewBody>> {
  const loaded = await loadSpec(deps, instanceId);
  if (!loaded.ok) return fail(loaded.error);
  const { app } = loaded;
  const view = app.spec.views.find((candidate) => candidate.name === viewName);
  if (view === undefined) return fail("NOT_FOUND");
  const permissions = permissionsOf(app);
  if (!permissions.read) return fail("PERMISSION_DENIED");
  // ダッシュボード（`type: dashboard`。M1.4。Issue #180）は**行を並べない**——`rows` は空の並びで、
  // 部品が読む値は `scope`（アプリ全体の集計。数値の部品）・`groups`（見出しごとの集計。棒・円の部品。
  // Issue #181）・`ranking`（順位の部品が並べる別の entity の行。Issue #182）に 1 回で載る。
  // `entity` も、行ごとの `fields`・`computed` も持たない。**部品ごとに取りに行かない**（1 回の取得でまとめて返す）。
  if (view.type === "dashboard") {
    // 順位の部品（`type: ranking`。M1.4。Issue #182）が並べる entity のレコードを読む。**行ごとに読み直さない**
    // ——1 回の取得でまとめて返す。読んだ行は `known` で渡し、集計の元を読むときに使い回す（同じ行を 2 度読まない）
    const rankingEntities = rankingEntitiesOf(view);
    const known: Record<string, readonly StoredRecord[]> = {};
    for (const name of rankingEntities) known[name] = await deps.records.list(name);
    // 数値の部品が読むアプリ全体の集計（`scope: app`）と、棒・円の部品が読む見出しごとの集計
    // （`type: groups`。Issue #181）と、順位の部品が指す entity の集計が要る entity を、**まとめて読む**
    const extra = [
      ...appAggregateSourceEntities(app),
      ...groupSourceEntities(app),
      ...rankingEntities.flatMap((name) => [name, ...aggregateSourceEntities(app, name)]),
    ];
    const sources = await loadSources(deps, app, "", extra, known);
    const scope = scopeValuesOf(app, deps.clock, sources);
    const groups = groupsValuesOf(app, deps.clock, sources);
    // 順位（M1.4。Issue #182）。**宣言が無ければ欄そのものを載せない**（`scope` と同じ約束）
    const ranking = rankingValuesOf(app, view, deps.clock, sources, known);
    return ok(API_READ_STATUS, {
      instanceId,
      view: view.name,
      fields: [],
      computed: [],
      permissions,
      actions: [],
      rows: [],
      ...(scope === undefined ? {} : { scope }),
      ...(groups === undefined ? {} : { groups }),
      ...(ranking === undefined ? {} : { ranking }),
    });
  }
  const entity = app.spec.entities.find((candidate) => candidate.name === view.entity);
  // 宣言の不整合（静的チェックが防ぐ）。読めない宣言として断る
  if (entity === undefined) return fail("SPEC_UNAVAILABLE");

  const stored = await deps.records.list(entity.name);
  // 集計の元を読む。**アプリ全体の集計（`scope: app`）と見出しごとの集計（`type: groups`。M1.4）が
  // 指す entity も足す**——一覧の entity を指していれば、いま読んだ行を使い回す（同じ行を 2 度読まない。D-1）
  const extra = [...appAggregateSourceEntities(app), ...groupSourceEntities(app)];
  const sources = await loadSources(deps, app, entity.name, extra, {
    [entity.name]: stored,
  });
  // 参照されている行（M1.2）。`delete` を宣言している entity にだけ、消せるかの材料を載せる
  const referenceIndex = await referencesByRow(deps, app, entity, stored);
  // 精算（M1.2）。宣言していれば、店頭が組んだ送金の並びを返す（読めなければ `null`。空の並びに読み替えない）
  const settlement = settlementOf(app, entity.name, stored, sources);
  // 強調（`highlight`。M1.3）。ボードの宣言があれば、真偽の計算を行ごとに解いて行に載せる
  const highlight = highlightOf(app, view, entity.name);
  // アプリ全体の集計（M1.4）。**宣言が無ければ欄そのものを載せない**
  const scope = scopeValuesOf(app, deps.clock, sources);
  // 見出しごとの集計（M1.4。Issue #179）。**宣言が無ければ欄そのものを載せない**（`scope` と同じ約束）
  const groups = groupsValuesOf(app, deps.clock, sources);
  // 表示名（`label`。M1.3）。**1 つも無ければ欄そのものを載せない**（M1.1〜M1.3 の応答を変えない）
  const labels = labelsOf(app, entity);
  return ok(API_READ_STATUS, {
    instanceId,
    view: view.name,
    entity: entity.name,
    fields: Object.keys(entity.fields),
    computed: computedNamesOf(app, entity.name),
    ...(labels === undefined ? {} : { labels }),
    permissions,
    actions: actionsOf(app).filter((action) => action.entity === entity.name),
    rows: stored.map((record) =>
      toApiRow(
        app,
        entity.name,
        record,
        deps.clock,
        sources,
        referencesOf(referenceIndex, record.id),
        highlight,
      ),
    ),
    ...(settlement === undefined ? {} : { settlement }),
    ...(scope === undefined ? {} : { scope }),
    ...(groups === undefined ? {} : { groups }),
  });
}

/**
 * `POST /api/instances/:instanceId/actions/:actionName`。`write` の宣言が無ければ 403。
 *
 * **何をするかは宣言した `kind`（種類）が決める**（M1.2。docs/semantics.md「action」「create」
 * 「update」「delete」）。入口の名前が `createFromAction` のままなのは、HTTP の経路（操作の実行）が
 * 1 つだからである（`src/index.ts` がこの 1 つを呼ぶ）。省略した `kind` は `create` として読む。
 *
 * **`when` を宣言した操作は、条件が成り立つ行にだけ通す**（M1.3）。成り立たなければ
 * 409 `ACTION_NOT_ALLOWED` で断り、**どの操作のどの条件か**を返す（docs/semantics.md「when」）。
 */
export async function createFromAction(
  deps: DataApiDeps,
  instanceId: string,
  actionName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  const loaded = await loadSpec(deps, instanceId);
  if (!loaded.ok) return fail(loaded.error);
  const { app } = loaded;
  const action = app.spec.actions.find((candidate) => candidate.name === actionName);
  if (action === undefined) return fail("NOT_FOUND");
  if (!permissionsOf(app).write) return fail("PERMISSION_DENIED");
  const entity = app.spec.entities.find((candidate) => candidate.name === action.entity);
  if (entity === undefined) return fail("SPEC_UNAVAILABLE");

  switch (actionKind(action)) {
    case "update":
      return updateFromAction(deps, app, action, entity, input);
    case "delete":
      return deleteFromAction(deps, app, action, entity, input);
    default:
      return createFromActionInput(deps, app, entity, input);
  }
}

/**
 * 操作の条件（`when`。M1.3）を、**保存された行の値**で判定する。成り立てば `null`、
 * 成り立たなければ断った結果を返す。
 *
 * **画面が送ってきても断る**（唯一の権限強制点）。画面がボタンを隠すのは親切であって守りではない
 * ——一覧の `allowedActions` は古くなっていることがあるので、実行のたびにここで測り直す。
 */
async function guardWhen(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  action: Action,
  entity: Entity,
  record: StoredRecord,
): Promise<ApiFailureResult | null> {
  if (action.when === undefined) return null;
  const sources = await loadSources(deps, app, entity.name);
  const allowed = allowsAction(
    {
      app,
      entity: entity.name,
      record: record.data,
      clock: deps.clock,
      recordId: record.id,
      sources,
    },
    action.when,
  );
  return allowed ? null : notAllowed(action);
}

/** `kind` の省略と `create`。1 件を追加し、**書いた行（計算値つき）** を返す（201） */
async function createFromActionInput(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  // 精算の対象の額は**整数円**である（Q18-6）。型の検査より先に、項目の名前を返して断る
  const whole = checkWholeYen(app, entity, input);
  if (!whole.ok) return fail("INPUT_REJECTED", whole.fields);

  const decided = checkInput({ app, entity, input, clock: deps.clock });
  if (!decided.ok) {
    return fail("INPUT_REJECTED", decided.fields, decided.validations, messagesOf(app, decided.validations));
  }

  // 参照（`ref`・参照 list）の値が、**このインスタンスの参照先のレコード**を指しているか（M1.2）。
  // 型を通ったあとに見る——存在しない ID・別 entity の ID・別インスタンスの ID はここで断る
  const referenced = await checkReferences({ entity, data: decided.data, records: deps.records });
  if (!referenced.ok) return fail("INPUT_REJECTED", referenced.fields);

  // 日時と ID は店頭（呼ぶ側の時計）が付ける。入力の値では決まらない
  const stamp: RecordStamp = {
    now: new Date(deps.clock.now()).toISOString(),
    id: crypto.randomUUID(),
  };
  // 参照先の実在は、**書くのと同じ呼出**でもう一度見る（確かめたあとに参照先が消えた場合の守り）
  const created = await deps.records.create(
    entity.name,
    decided.data,
    stamp,
    referenceExpectationsFor(entity),
  );
  if (!created.ok) return fail("INPUT_REJECTED", created.fields);
  return ok(API_CREATED_STATUS, await rowWithReferences(deps, app, entity, created.record));
}

/**
 * `kind: update`。対象のレコード 1 件を、**渡した項目で置き換える**（全項目の置換。部分更新ではない）。
 * **`set` を宣言した操作だけは別である**（M1.3）——入力は `id` だけで、`set` に書いた項目だけが
 * 書き換わる（ほかの項目は保存された値のまま。docs/semantics.md「set」）。
 * `id` は対象を指すために取り、保存する値には入らない。**`id` と `createdAt` は変えられない**
 * （入力に混ぜれば、宣言の項目に無い名前として断る）。成功したら **200 と、書き換えた行** を返す。
 */
async function updateFromAction(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  action: Action,
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  const target = readTargetId(input);
  if (!target.ok) return fail("INPUT_REJECTED", ["id"]);
  // 対象のレコードが無ければ 404（`write` の宣言は先に見ている）
  const current = await deps.records.get(entity.name, target.id);
  if (current === null) return fail("NOT_FOUND");

  // 操作の条件（M1.3）。**保存された行の値**で判定し、成り立たなければ書き換えない
  const blocked = await guardWhen(deps, app, action, entity, current);
  if (blocked !== null) return blocked;

  // 決まった値への書き換え（`set`。M1.3）は、**入力が `id` だけ**で、書き換わるのは書いた項目だけである
  // （ほかの項目は保存された値のまま）。`set` の無い `update` は、従来どおり全項目の置換である
  const next = valuesToWrite(action, current, target.data);
  if (!next.ok) return fail("INPUT_REJECTED", next.fields);

  // 置換する**レコード全体**に、型 → 計算 → 検査の式（input.ts）と、参照の検査（#106）を適用する
  const whole = checkWholeYen(app, entity, next.data);
  if (!whole.ok) return fail("INPUT_REJECTED", whole.fields);
  const decided = checkInput({ app, entity, input: next.data, clock: deps.clock });
  if (!decided.ok) {
    return fail("INPUT_REJECTED", decided.fields, decided.validations, messagesOf(app, decided.validations));
  }
  const referenced = await checkReferences({ entity, data: decided.data, records: deps.records });
  if (!referenced.ok) return fail("INPUT_REJECTED", referenced.fields);

  // ID と作成日時は境界（DO）が保つ。ここが渡すのは新しい値と、進める日時だけである。
  // 参照先の実在は、追加と同じく**書くのと同じ呼出**でもう一度見る（同時に参照先が消えた場合の守り）
  const stamp: RecordStamp = { now: new Date(deps.clock.now()).toISOString() };
  const updated = await deps.records.update(
    entity.name,
    target.id,
    decided.data,
    stamp,
    referenceExpectationsFor(entity),
  );
  if (!updated.ok) {
    // 直前まで在った行が消えている（同時の削除）か、参照先が消えている。**成功に見せない**
    return updated.reason === "NOT_FOUND"
      ? fail("NOT_FOUND")
      : fail("INPUT_REJECTED", updated.fields);
  }
  return ok(API_READ_STATUS, await rowWithReferences(deps, app, entity, updated.record));
}

/**
 * `kind: delete`。対象のレコード 1 件を消す。**参照されている行は消せない**（M1.2）。
 * どの項目が参照かは宣言から組み立て、**DO の同じ呼出の中で数えて消す**（孤立した参照を残さない）。
 * 消せないときは 409 `REFERENCE_IN_USE` と、**参照元の entity と項目、件数**を返す。
 */
async function deleteFromAction(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  action: Action,
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  const target = readTargetId(input);
  if (!target.ok) return fail("INPUT_REJECTED", ["id"]);
  // 消す入力は `id` だけである（項目の値を渡しても、黙って捨てない）
  const extra = Object.keys(target.data);
  if (extra.length > 0) return fail("INPUT_REJECTED", extra);

  // 操作の条件（M1.3）。条件を宣言している消す操作は、**保存された行の値**で判定してから消す
  if (action.when !== undefined) {
    const current = await deps.records.get(entity.name, target.id);
    if (current === null) return fail("NOT_FOUND");
    const blocked = await guardWhen(deps, app, action, entity, current);
    if (blocked !== null) return blocked;
  }

  const guards: readonly ReferenceGuard[] = referenceFieldsTo(app.spec, entity.name);
  const result: GuardedDelete = await deps.records.deleteGuarded(entity.name, target.id, guards);
  if (result.ok) {
    return ok(API_READ_STATUS, { entity: entity.name, id: result.record.id, deleted: true });
  }
  if (result.reason === "NOT_FOUND") return fail("NOT_FOUND");
  // 応答に載せるのは契約の 3 つ（参照元の entity と項目、件数）だけである。
  // 保存の境界が使う `list`（参照の並びか）は、外へ出す形ではない
  const references: readonly ApiReference[] = result.references.map((reference) => ({
    entity: reference.entity,
    field: reference.field,
    count: reference.count,
  }));
  return fail("REFERENCE_IN_USE", [], [], undefined, references);
}

/**
 * 書き換えたあとのレコード全体を組む（M1.3）。
 *
 *   `set` が無い … 入力の項目そのもの（従来の `update`。全項目の置換である）
 *   `set` がある … **保存された値に、決まった値を重ねたもの**。入力は `id` だけで、
 *                  ほかの項目を送ってきたら**黙って捨てずに断る**（余分な入力である）
 */
function valuesToWrite(
  action: Action,
  current: StoredRecord,
  input: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly fields: readonly string[] } {
  if (action.set === undefined) return { ok: true, data: input };
  const extra = Object.keys(input);
  if (extra.length > 0) return { ok: false, fields: extra };
  return { ok: true, data: { ...current.data, ...action.set } };
}

/** 直す・消すの入力から、対象のレコードの ID を取る（`ref` と同じく、空でない文字列だけを ID とする） */
function readTargetId(
  input: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly id: string; readonly data: Readonly<Record<string, unknown>> } | { readonly ok: false } {
  const id = input["id"];
  if (typeof id !== "string" || id === "") return { ok: false };
  const data = Object.fromEntries(Object.entries(input).filter(([name]) => name !== "id"));
  return { ok: true, id, data };
}

/** 1 行を、**消せるかの材料（`references`）つき**で返す（`delete` を宣言している entity だけ） */
async function rowWithReferences(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: Entity,
  record: StoredRecord,
): Promise<ApiRow> {
  const sources = await loadSources(deps, app, entity.name);
  const index = await referencesByRow(deps, app, entity, [record]);
  return toApiRow(app, entity.name, record, deps.clock, sources, referencesOf(index, record.id));
}
