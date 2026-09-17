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
  ApiCreatedBody,
  ApiErrorCode,
  ApiPermissions,
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
  isComputedSettle,
  isRowComputed,
} from "@musunest/appspec-schema";
import type { RecordData, RecordStamp, StoredRecord } from "@musunest/app-do";
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
  create(entity: string, data: RecordData, stamp: RecordStamp): Promise<StoredRecord>;
  list(entity: string): Promise<StoredRecord[]>;
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
}

export interface ApiFailureResult {
  readonly ok: false;
  readonly failure: ApiFailure;
}

export type ApiResult<Body> = ApiSuccess<Body> | ApiFailureResult;

const ok = <Body>(status: ApiStatus, body: Body): ApiSuccess<Body> => ({ ok: true, status, body });

const fail = (
  error: ApiErrorCode,
  fields: readonly string[] = [],
  validations: readonly string[] = [],
  validationMessages?: readonly (string | null)[],
): ApiFailureResult => ({
  ok: false,
  failure: {
    error,
    fields,
    validations,
    ...(validationMessages === undefined ? {} : { validationMessages }),
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
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、参照の写像**
 * （`{type: ref, to}`・`{type: list, of}`）の両方を受け取る（M1.2）。
 */
function isFieldDeclaration(value: unknown): boolean {
  if (typeof value === "string") return (FIELD_TYPES as readonly string[]).includes(value);
  if (!isRecord(value)) return false;
  if (value["type"] === "ref") return typeof value["to"] === "string";
  if (value["type"] === "list") return typeof value["of"] === "string";
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

/** 宣言した操作（宣言の順）。M1.1 の操作はレコードの内容による条件を持たない */
const actionsOf = (app: NormalizedAppSpec): readonly ApiActionRef[] =>
  app.spec.actions.map((action) => ({ name: action.name, entity: action.entity }));

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
  };
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
    rows: stored.map((record) => toApiRow(app, entity.name, record, deps.clock, sources)),
    ...(settlement === undefined ? {} : { settlement }),
  });
}

/**
 * `POST /api/instances/:instanceId/actions/:actionName`。`write` の宣言が無ければ 403。
 * 入力の検査に通れば 1 件保存し、**作成した行（計算値つき）** を返す。断った入力は保存しない。
 */
export async function createFromAction(
  deps: DataApiDeps,
  instanceId: string,
  actionName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<ApiResult<ApiCreatedBody>> {
  const loaded = await loadSpec(deps, instanceId);
  if (!loaded.ok) return fail(loaded.error);
  const { app } = loaded;
  const action = app.spec.actions.find((candidate) => candidate.name === actionName);
  if (action === undefined) return fail("NOT_FOUND");
  if (!permissionsOf(app).write) return fail("PERMISSION_DENIED");
  const entity = app.spec.entities.find((candidate) => candidate.name === action.entity);
  if (entity === undefined) return fail("SPEC_UNAVAILABLE");

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
  const record = await deps.records.create(entity.name, decided.data, stamp);
  // 集計（`aggregate`）は、**このインスタンスの**ほかの entity のレコードを見る（M1.2）
  const sources = await loadSources(deps, app, entity.name);
  return ok(API_CREATED_STATUS, toApiRow(app, entity.name, record, deps.clock, sources));
}
