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

import type {
  ApiActionRef,
  ApiDeletedBody,
  ApiErrorCode,
  ApiPermissions,
  ApiReference,
  ApiRow,
  ApiSpecBody,
  ApiTransfer,
  ApiViewBody,
  AppSpec,
  Entity,
  NormalizedAppSpec,
} from "@musunest/appspec-schema";
import {
  API_CREATED_STATUS,
  API_READ_STATUS,
  APPSPEC_SCHEMA_VERSION_PATTERN,
  FIELD_TYPES,
  actionKind,
  fieldKind,
  fieldTarget,
  isComputedSettle,
  isRowComputed,
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
  evaluateRecord,
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
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、写像**
 * （参照の `{type: ref, to}`・`{type: list, of}`、選択肢の `{type: enum, options, default}`）の両方
 * を受け取る（M1.2・M1.3）。
 */
function isFieldDeclaration(value: unknown): boolean {
  if (typeof value === "string") return (FIELD_TYPES as readonly string[]).includes(value);
  if (!isRecord(value)) return false;
  if (value["type"] === "ref") return typeof value["to"] === "string";
  if (value["type"] === "list") return typeof value["of"] === "string";
  if (value["type"] === "enum") return isEnumDeclaration(value);
  return false;
}

/** 集計（`aggregate`）の形（M1.2）。`sum` は対象の名前を持ち、`count` は持たない */
function isAggregateShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value["kind"];
  if (kind !== "sum" && kind !== "count") return false;
  if (typeof value["entity"] !== "string") return false;
  if (kind === "sum" ? typeof value["name"] !== "string" : value["name"] !== null) return false;
  const where = value["where"];
  if (!isRecord(where)) return false;
  return Object.values(where).every((op) => op === "equals" || op === "contains");
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
  const hasExpression = typeof entry["expression"] === "string";
  const hasAggregate = entry["aggregate"] !== undefined;
  const hasSettle = entry["settle"] !== undefined;
  if ([hasExpression, hasAggregate, hasSettle].filter(Boolean).length !== 1) return false;
  if (hasExpression) return true;
  return hasAggregate ? isAggregateShape(entry["aggregate"]) : isSettleShape(entry["settle"]);
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
  if (!Array.isArray(views) || !views.every((view) => hasStrings(view, ["name", "entity"]))) return false;
  if (!Array.isArray(actions) || !actions.every((action) => hasStrings(action, ["name", "entity"]))) return false;
  if (!Array.isArray(validations)) return false;
  for (const validation of validations) {
    if (!hasStrings(validation, ["name", "entity", "expression"])) return false;
    if (!hasOptionalString(validation, "message")) return false;
  }
  if (!Array.isArray(computed)) return false;
  for (const entry of computed) {
    // 精算（`settle`）は数ではなく送金の並びを返すので、`type` を持たない（M1.2）
    const settles = isRecord(entry) && entry["settle"] !== undefined;
    if (!hasStrings(entry, settles ? ["name", "entity"] : ["name", "entity", "type"])) return false;
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
    // 精算（`settle`）は行ごとの値ではないので、一覧の列に出さない（M1.2）
    .filter((entry) => entry.entity === entity && isRowComputed(entry))
    .map((entry) => entry.name);

/** その entity に精算（`settle`）を宣言しているか。宣言が無ければ、応答に `settlement` を載せない */
const declaresSettle = (app: NormalizedAppSpec, entity: string): boolean =>
  app.spec.computed.some((entry) => entry.entity === entity && isComputedSettle(entry));

/** 1 行を API の形にする。**計算の値は保存された値からその都度求める** */
function toApiRow(
  app: NormalizedAppSpec,
  entity: string,
  record: StoredRecord,
  clock: Clock,
  sources: SourceRecords,
  /** この行を参照している保存済みの行（M1.2）。`delete` を宣言していない entity では `undefined` */
  references?: readonly ApiReference[],
): ApiRow {
  const { computed } = evaluateRecord({
    app,
    entity,
    record: record.data,
    clock,
    recordId: record.id,
    sources,
  });
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    fields: record.data,
    computed,
    ...(references === undefined ? {} : { references }),
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
 */
async function loadSources(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: string,
): Promise<SourceRecords> {
  const sources: Record<string, readonly SourceRecord[]> = {};
  const names = new Set([...aggregateSourceEntities(app, entity), ...settleSourceEntities(app, entity)]);
  for (const name of names) {
    const rows = await deps.records.list(name);
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
  const entity = app.spec.entities.find((candidate) => candidate.name === view.entity);
  // 宣言の不整合（静的チェックが防ぐ）。読めない宣言として断る
  if (entity === undefined) return fail("SPEC_UNAVAILABLE");

  const stored = await deps.records.list(entity.name);
  const sources = await loadSources(deps, app, entity.name);
  // 参照されている行（M1.2）。`delete` を宣言している entity にだけ、消せるかの材料を載せる
  const referenceIndex = await referencesByRow(deps, app, entity, stored);
  // 精算（M1.2）。宣言していれば、店頭が組んだ送金の並びを返す（読めなければ `null`。空の並びに読み替えない）
  const settlement = settlementOf(app, entity.name, stored, sources);
  return ok(API_READ_STATUS, {
    instanceId,
    view: view.name,
    entity: entity.name,
    fields: Object.keys(entity.fields),
    computed: computedNamesOf(app, entity.name),
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
      ),
    ),
    ...(settlement === undefined ? {} : { settlement }),
  });
}

/**
 * `POST /api/instances/:instanceId/actions/:actionName`。`write` の宣言が無ければ 403。
 *
 * **何をするかは宣言した `kind`（種類）が決める**（M1.2。docs/semantics.md「action」「create」
 * 「update」「delete」）。入口の名前が `createFromAction` のままなのは、HTTP の経路（操作の実行）が
 * 1 つだからである（`src/index.ts` がこの 1 つを呼ぶ）。省略した `kind` は `create` として読む。
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
      return updateFromAction(deps, app, entity, input);
    case "delete":
      return deleteFromAction(deps, app, entity, input);
    default:
      return createFromActionInput(deps, app, entity, input);
  }
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
 * `id` は対象を指すために取り、保存する値には入らない。**`id` と `createdAt` は変えられない**
 * （入力に混ぜれば、宣言の項目に無い名前として断る）。成功したら **200 と、書き換えた行** を返す。
 */
async function updateFromAction(
  deps: DataApiDeps,
  app: NormalizedAppSpec,
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  const target = readTargetId(input);
  if (!target.ok) return fail("INPUT_REJECTED", ["id"]);
  // 対象のレコードが無ければ 404（`write` の宣言は先に見ている）
  const current = await deps.records.get(entity.name, target.id);
  if (current === null) return fail("NOT_FOUND");

  // 置換する**レコード全体**に、型 → 計算 → 検査の式（input.ts）と、参照の検査（#106）を適用する
  const whole = checkWholeYen(app, entity, target.data);
  if (!whole.ok) return fail("INPUT_REJECTED", whole.fields);
  const decided = checkInput({ app, entity, input: target.data, clock: deps.clock });
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
  entity: Entity,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiActionBody>> {
  const target = readTargetId(input);
  if (!target.ok) return fail("INPUT_REJECTED", ["id"]);
  // 消す入力は `id` だけである（項目の値を渡しても、黙って捨てない）
  const extra = Object.keys(target.data);
  if (extra.length > 0) return fail("INPUT_REJECTED", extra);

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
