// data-api の HTTP 契約（@musunest/appspec-schema の src/api.ts）を呼ぶ、型付きのクライアント（Issue #104）。
//
// 約束は2つある。
//   1. 経路と body を契約どおりに組む。URL の要素（instance・view・action の名前）は api.ts の api*Path が包む
//   2. **失敗を成功にしない。** HTTP status・誤りコード・fields・validations を保って返し、ネットワークの例外・
//      JSON でない応答・契約と違う形の応答は、成功の型へキャストせず失敗にする
//
// fetch と base URL は差し込める。host の画面は同じ origin の /api/* を叩くので `baseUrl: ""` でよい
// （相対 URL のまま fetch する）。e2e のように別の origin を指す場合は絶対 URL を渡す。

import { API_ERROR_CODES, ACTION_KINDS, COMPUTED_TYPES, FIELD_TYPES, VIEW_TYPES, apiActionPath, apiSpecPath, apiViewPath } from "@musunest/appspec-schema";
import type {
  ApiDeletedBody,
  ApiErrorCode,
  ApiReference,
  ApiRow,
  ApiSpecBody,
  ApiValue,
  ApiViewBody,
} from "@musunest/appspec-schema";

/** fetch の差し替え口。Workers・ブラウザ・Node のどれでも同じ形で呼べる範囲だけを要求する */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 応答が返らなかった（fetch が例外を投げた）。`status` は無い */
export const NETWORK_FAILURE = "NETWORK_FAILURE" as const;
/** 応答は返ったが、契約の形（JSON であること・応答の型）になっていない */
export const INVALID_RESPONSE = "INVALID_RESPONSE" as const;

export type ClientErrorCode = ApiErrorCode | typeof NETWORK_FAILURE | typeof INVALID_RESPONSE;

export interface ClientError {
  /** HTTP status。ネットワークの失敗のときだけ `null`（status が無い） */
  readonly status: number | null;
  /** 契約の誤りコード、または SDK が見つけた失敗（`NETWORK_FAILURE` / `INVALID_RESPONSE`） */
  readonly code: ClientErrorCode;
  /** `INPUT_REJECTED` のとき、通らなかった項目の名前（ほかのコードでは空） */
  readonly fields: readonly string[];
  /** `INPUT_REJECTED` のとき、通らなかった検査の名前（宣言の順。ほかのコードでは空） */
  readonly validations: readonly string[];
  /**
   * 通らなかった検査の文言（`validations` と同じ並び。文言の無い検査は `null`）。
   * **宣言が文言を持たないときは無い**——画面は `validations` の名前で識別する（M1.1 と同じ）。
   */
  readonly validationMessages?: readonly (string | null)[];
  /**
   * 参照されているレコードを消そうとしたときの参照元（`REFERENCE_IN_USE` のときだけ。M1.2）。
   * **参照元の entity と項目、件数**である。画面はこれをそのまま見せる（消せない理由）。
   */
  readonly references?: readonly ApiReference[];
  /**
   * 断られた操作の名前と、その条件（`ACTION_NOT_ALLOWED` のときだけ。M1.3）。
   * **どの操作のどの条件で断られたか**を、画面がそのまま見せられるようにする。
   * **両方揃っているときだけ載せる**（片方だけでは理由にならない）。
   */
  readonly action?: string;
  readonly when?: string;
}

export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClientError };

export interface MusunestClient {
  /** `GET /api/instances/:instanceId/spec`。宣言と、操作の可否（`permissions`・`actions`） */
  getSpec(instanceId: string): Promise<ClientResult<ApiSpecBody>>;
  /** `GET /api/instances/:instanceId/views/:viewName`。宣言順の列と、登録順の行 */
  getView(instanceId: string, viewName: string): Promise<ClientResult<ApiViewBody>>;
  /**
   * `POST /api/instances/:instanceId/actions/:actionName`。**宣言した `kind` で何をするかが決まる**（M1.2）。
   *   `create` … `input` は「項目名: 値」。201 と、書いた行が返る
   *   `update` … `input` は「`id` ＋ 項目の全部」。200 と、書き換えた行が返る
   * 消す（`delete`）は `deleteRecord` を使う（入力は `id` だけで、返るのは行ではない）。
   */
  addRecord(
    instanceId: string,
    actionName: string,
    input: Readonly<Record<string, ApiValue>>,
  ): Promise<ClientResult<ApiRow>>;
  /**
   * `kind: delete` の操作を実行する（M1.2）。`id` は消すレコードである。
   * **参照されている行は消せない**——`error.code` が `REFERENCE_IN_USE`（409）になり、
   * `error.references` に参照元の entity と項目、件数が入る（空の並びへ読み替えない）。
   */
  deleteRecord(
    instanceId: string,
    actionName: string,
    id: string,
  ): Promise<ClientResult<ApiDeletedBody>>;
  /**
   * **決まった値への書き換え**（`set` を宣言した `kind: update` の操作。M1.3）を、対象の行に対して
   * 実行する。入力は `id` だけで、書き換わるのは宣言の `set` に書いた項目だけである。
   *
   * **その行で条件（`when`）が成り立たなければ断られる**——`error.code` が `ACTION_NOT_ALLOWED`
   * （409）になり、`error.action` と `error.when` に**どの操作のどの条件か**が入る。
   * 成功したら 200 と、書き換えた行（`ApiRow`）が返る。
   */
  setRecord(
    instanceId: string,
    actionName: string,
    id: string,
  ): Promise<ClientResult<ApiRow>>;
}

export interface MusunestClientOptions {
  /** API の基点。同じ origin なら `""`（末尾の `/` は落とす） */
  readonly baseUrl: string;
  /** 差し替える fetch。既定は `globalThis.fetch` */
  readonly fetch?: FetchLike;
}

export function createMusunestClient(options: MusunestClientOptions): MusunestClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const request = options.fetch ?? globalThis.fetch;
  if (request === undefined) throw new Error("fetch が無い。options.fetch で渡す");

  return {
    getSpec: async (instanceId) =>
      decode(await send(request, base, apiSpecPath(instanceId), "GET"), isSpecBody),
    getView: async (instanceId, viewName) =>
      decode(await send(request, base, apiViewPath(instanceId, viewName), "GET"), isViewBody),
    addRecord: async (instanceId, actionName, input) =>
      decode(await send(request, base, apiActionPath(instanceId, actionName), "POST", input), isRow),
    deleteRecord: async (instanceId, actionName, id) =>
      decode(
        await send(request, base, apiActionPath(instanceId, actionName), "POST", { id }),
        isDeletedBody,
      ),
    setRecord: async (instanceId, actionName, id) =>
      decode(await send(request, base, apiActionPath(instanceId, actionName), "POST", { id }), isRow),
  };
}

/** 1 回の呼出。経路は api.ts が組んだものを使い、body は JSON で送る */
function send(
  request: FetchLike,
  base: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<ClientResult<Response>> {
  return request(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).then(
    (value): ClientResult<Response> => ({ ok: true, value }),
    (): ClientResult<Response> => ({ ok: false, error: failure(null, NETWORK_FAILURE) }),
  );
}

/** 応答を読んで、契約の型（`guard`）に合うときだけ成功にする */
async function decode<T>(
  result: ClientResult<Response>,
  guard: (value: unknown) => value is T,
): Promise<ClientResult<T>> {
  if (!result.ok) return result;
  const response = result.value;

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: failure(response.status, INVALID_RESPONSE) };
  }

  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    isJson = false;
  }

  if (!response.ok) return { ok: false, error: errorOf(response.status, isJson ? parsed : undefined) };
  if (!isJson || !guard(parsed)) return { ok: false, error: failure(response.status, INVALID_RESPONSE) };
  return { ok: true, value: parsed };
}

/** 誤りの本文。契約の誤りコードが読めればそれを保ち、読めなければ `INVALID_RESPONSE` にする */
function errorOf(status: number, body: unknown): ClientError {
  if (
    isRecord(body) &&
    typeof body.error === "string" &&
    (API_ERROR_CODES as readonly string[]).includes(body.error)
  ) {
    const code = body.error as ApiErrorCode;
    if (code === "REFERENCE_IN_USE") {
      // 消せない理由（参照元と件数）。**載っていなければ欄ごと落とす**（空の並びに読み替えない）
      if (body.references === undefined) return failure(status, code);
      if (!isReferences(body.references)) return failure(status, INVALID_RESPONSE);
      return { status, code, fields: [], validations: [], references: body.references };
    }
    if (code === "ACTION_NOT_ALLOWED") {
      // 断られた理由（どの操作のどの条件か）。**両方揃っているときだけ載せる**
      // （片方だけの応答をでっち上げない。`references` と同じ約束である）
      if (body.action === undefined && body.when === undefined) return failure(status, code);
      if (typeof body.action !== "string" || typeof body.when !== "string") {
        return failure(status, INVALID_RESPONSE);
      }
      return { status, code, fields: [], validations: [], action: body.action, when: body.when };
    }
    if (code !== "INPUT_REJECTED") return failure(status, code);
    // 拒否の内容（項目名と検査名）が契約の形のときだけ、その2つを載せる
    if (!isStringArray(body.fields) || !isStringArray(body.validations)) {
      return failure(status, INVALID_RESPONSE);
    }
    // 文言は、載っているときだけ契約の形（`validations` と同じ長さの「文字列か null」の並び）を要求する
    let messages: readonly (string | null)[] | undefined;
    if (body.validationMessages !== undefined) {
      if (!isMessageArray(body.validationMessages, body.validations.length)) {
        return failure(status, INVALID_RESPONSE);
      }
      messages = body.validationMessages;
    }
    return {
      status,
      code,
      fields: body.fields,
      validations: body.validations,
      ...(messages === undefined ? {} : { validationMessages: messages }),
    };
  }
  return failure(status, INVALID_RESPONSE);
}

function failure(status: number | null, code: ClientErrorCode): ClientError {
  return { status, code, fields: [], validations: [] };
}

// ── 応答の形（契約と突き合わせる）────────────────────────────────
//
// **「それらしい」だけでは成功にしない。** 応答が SPA シェルの HTML でも、欄が欠けた JSON でも、
// 契約の型に合わなければ失敗にする（呼ぶ側が「読めた」と誤解しないため）。

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** 検査の文言の並び（`validations` と同じ長さで、要素は文字列か null） */
const isMessageArray = (value: unknown, length: number): value is (string | null)[] =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((item) => item === null || typeof item === "string");

const isApiValue = (value: unknown): boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isPermissions(value: unknown): boolean {
  return isRecord(value) && typeof value.read === "boolean" && typeof value.write === "boolean";
}

function isActionRef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.entity !== "string") {
    return false;
  }
  // 操作の種類（M1.2）は任意。載っているときだけ、語彙（create・update・delete）に合うことを要求する
  return (
    value.kind === undefined ||
    (typeof value.kind === "string" && (ACTION_KINDS as readonly string[]).includes(value.kind))
  );
}

/**
 * 宣言の操作（`AppSpec.actions`）。`ApiActionRef` に加えて、M1.3 の `set`（決まった値への書き換え）と
 * `when`（その行で操作してよい条件）を、**載っているときだけ**確かめる。
 *
 * **1 語の型と同じく、知らない形を成功にしない**——ただし語彙が増えたときに配信側だけが古いまま
 * 残ると、`getSpec` が失敗して画面が動かなくなる（#145・#154 と同じ穴）ので、ここは M1.3 の
 * 語彙をそのまま受け取る形にしてある。
 */
function isActionDeclaration(value: unknown): boolean {
  if (!isActionRef(value) || !isRecord(value)) return false;
  if (value.set !== undefined) {
    if (!isRecord(value.set) || Object.keys(value.set).length === 0) return false;
    const values = Object.values(value.set);
    if (!values.every((entry) => typeof entry === "string" || typeof entry === "number")) return false;
  }
  return value.when === undefined || typeof value.when === "string";
}

/** 消せない理由の 1 件（M1.2）。参照元の entity と項目、件数（1 以上） */
function isReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.entity === "string" &&
    typeof value.field === "string" &&
    typeof value.count === "number" &&
    Number.isInteger(value.count) &&
    value.count >= 1
  );
}

function isReferences(value: unknown): value is readonly ApiReference[] {
  return Array.isArray(value) && value.every(isReference);
}

/**
 * 選択肢の項目（M1.3。`{type: enum, options, default}`）。`options` は「保存される値（キー）→
 * 画面に出す表示名」で、キーが 1 つ以上ある。`default` は書いてあるときだけ、`options` のキーで
 * なければならない（docs/semantics.md「enum」「default」）。
 */
function isEnumDeclaration(value: Record<string, unknown>): boolean {
  const options = value.options;
  if (!isRecord(options) || Object.keys(options).length === 0) return false;
  if (!Object.values(options).every((label) => typeof label === "string" && label !== "")) return false;
  const fallback = value.default;
  return fallback === undefined || (typeof fallback === "string" && Object.hasOwn(options, fallback));
}

/**
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`・`date`）と、写像**
 * （参照の `{type: ref, to}`・`{type: list, of}`、選択肢の `{type: enum, options, default}`）の両方
 * （M1.2・M1.3）。**1 語の型は `FIELD_TYPES` を正本にする**——ここで型の名前を写すと、語彙が増えたときに
 * 配信側だけが古いまま残り、`getSpec` が失敗して画面が動かなくなる（#145・#154 と同じ穴）。
 */
function isFieldDeclaration(value: unknown): boolean {
  if (typeof value === "string") return (FIELD_TYPES as readonly string[]).includes(value);
  if (!isRecord(value)) return false;
  if (value.type === "ref") return typeof value.to === "string";
  if (value.type === "list") return typeof value.of === "string";
  if (value.type === "enum") return isEnumDeclaration(value);
  return false;
}

function isEntity(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.fields)) return false;
  return Object.values(value.fields).every(isFieldDeclaration);
}

function isExpression(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.entity !== "string" ||
    typeof value.expression !== "string"
  ) {
    return false;
  }
  // 検査の文言（`message`）は任意。載っているときだけ文字列であることを要求する（M1.2）
  return value.message === undefined || typeof value.message === "string";
}

/**
 * 集計（`aggregate`）の形（M1.2）。`sum` は対象の名前を持ち、`count` は持たない。
 * どちらも `where`（項目 → `equals` / `contains`）を持つ。
 */
function isAggregate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  if (kind !== "sum" && kind !== "count") return false;
  if (typeof value.entity !== "string") return false;
  if (kind === "sum" ? typeof value.name !== "string" : value.name !== null) return false;
  if (!isRecord(value.where)) return false;
  return Object.values(value.where).every((op) => op === "equals" || op === "contains");
}

/**
 * 精算（`settle`）の宣言（M1.2）。支出の entity と、その 3 つの項目（額・払った人・割る人）の名前を、
 * **いずれも文字列で**持つ（docs/semantics.md「settle」）。**`type` を持たない**——値は数ではなく、
 * 送金の並び（送金元・送金先・正の送金額）だからである。
 */
function isSettleDeclaration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["expense", "amount", "payer", "shares"].every((key) => typeof value[key] === "string");
}

/**
 * computed の 1 件は、式（`expression`）・集計（`aggregate`）・精算（`settle`）の**どれか 1 つ**である
 * （M1.2。同時には書けない）。精算だけが `type` を持たない（値は数ではなく送金の並びである）。
 */
function isComputedDeclaration(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.entity !== "string") {
    return false;
  }
  const forms = [
    typeof value.expression === "string",
    value.aggregate !== undefined,
    value.settle !== undefined,
  ].filter(Boolean).length;
  if (forms !== 1) return false;
  // 式の計算の型は `COMPUTED_TYPES`（正本）で見る（`number` と、M1.3 の `boolean`）。
  // 集計は数を返すので `number` だけである
  if (typeof value.expression === "string") {
    return typeof value.type === "string" && (COMPUTED_TYPES as readonly string[]).includes(value.type);
  }
  if (value.aggregate !== undefined) return value.type === "number" && isAggregate(value.aggregate);
  return isSettleDeclaration(value.settle);
}

/**
 * 一覧の宣言。M1.2 で `type`（種類。語彙は `VIEW_TYPES`：`table`・`settlement`・`board`・`list`）と
 * `show`（表に出す名前の順）を、M1.3 でボードの `columns`（必須）・`highlight`（任意）と、一覧の
 * `filters`（任意）を足した。**書ける欄は `type` が決める**（語彙は閉じている）。
 */
function isView(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.entity !== "string") return false;
  if (value.type !== undefined) {
    if (typeof value.type !== "string" || !(VIEW_TYPES as readonly string[]).includes(value.type)) {
      return false;
    }
  }
  // `show` は `type: table` と `type: list` のときだけ（扱いは同じ。ほかの種類は列の並びを持たない）
  if (value.show !== undefined && !((value.type === "table" || value.type === "list") && isStringArray(value.show))) {
    return false;
  }
  // ボードの `columns`・`highlight` は `type: board` のときだけ。どちらも名前 1 つである
  if (value.columns !== undefined) {
    if (value.type !== "board" || typeof value.columns !== "string") return false;
  }
  if (value.highlight !== undefined) {
    if (value.type !== "board" || typeof value.highlight !== "string") return false;
  }
  // 絞り込み（M1.3）は `type: list` のときだけ。名前の並びである（実在と種類は静的チェックが見る）
  if (value.filters !== undefined) {
    if (value.type !== "list" || !isStringArray(value.filters)) return false;
  }
  return true;
}

/** 精算の 1 件（M1.2）。送金元・送金先はレコードの ID、額は正の数である */
function isTransfer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.amount === "number"
  );
}

/**
 * 一覧の応答の精算（M1.2）。**欄が無い**（その entity に `settle` の宣言が無い）か、`null`
 * （読めなかった）か、送金の並びである。`null` を空の並びに読み替えない（契約のとおりに渡す）。
 */
function isSettlement(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every(isTransfer));
}

function isAppSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.entities) &&
    value.entities.every(isEntity) &&
    Array.isArray(value.views) &&
    value.views.every(isView) &&
    Array.isArray(value.actions) &&
    value.actions.every(isActionDeclaration) &&
    Array.isArray(value.validations) &&
    value.validations.every(isExpression) &&
    Array.isArray(value.computed) &&
    value.computed.every(isComputedDeclaration) &&
    Array.isArray(value.permissions) &&
    value.permissions.every((permission) => isRecord(permission) && typeof permission.name === "string") &&
    isRecord(value.minIdentity) &&
    typeof value.minIdentity.mode === "string"
  );
}

function isRow(value: unknown): value is ApiRow {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return false;
  }
  if (!isRecord(value.fields) || !Object.values(value.fields).every(isApiValue)) return false;
  if (!isRecord(value.computed)) return false;
  // 計算の値は数か `null`。**M1.3 で真偽（`boolean`）も載る**（強調（`highlight`）の判定の結果。Issue #157）
  if (
    !Object.values(value.computed).every(
      (item) => item === null || typeof item === "number" || typeof item === "boolean",
    )
  ) {
    return false;
  }
  // 参照されている行（M1.2）は任意。**載っているときだけ**契約の形を要求する
  // （`delete` を宣言している entity だけが載せる。空の並びは「参照されていない」である）
  if (value.references !== undefined && !isReferences(value.references)) return false;
  // その行で実行してよい操作（M1.3）も任意である。**空の並びは「いまはどれもできない」**であって、
  // 「条件が宣言されていない」（欄そのものが無い）とは別の意味である。読み替えない
  return value.allowedActions === undefined || isStringArray(value.allowedActions);
}

/** 消した結果（M1.2。`kind: delete` の応答）。行ではなく、消せたことを表す */
function isDeletedBody(value: unknown): value is ApiDeletedBody {
  return (
    isRecord(value) &&
    typeof value.entity === "string" &&
    typeof value.id === "string" &&
    value.deleted === true
  );
}

function isSpecBody(value: unknown): value is ApiSpecBody {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.schemaVersion === "string" &&
    typeof value.sourceSha256 === "string" &&
    isAppSpec(value.spec) &&
    isPermissions(value.permissions) &&
    Array.isArray(value.actions) &&
    value.actions.every(isActionRef)
  );
}

function isViewBody(value: unknown): value is ApiViewBody {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.view === "string" &&
    typeof value.entity === "string" &&
    isStringArray(value.fields) &&
    isStringArray(value.computed) &&
    isPermissions(value.permissions) &&
    Array.isArray(value.actions) &&
    value.actions.every(isActionRef) &&
    Array.isArray(value.rows) &&
    value.rows.every(isRow) &&
    // 精算（M1.2）。**欄が無い**（宣言が無い）ときと `null`（読めなかった）ときを区別したまま渡す
    (value.settlement === undefined || isSettlement(value.settlement))
  );
}
