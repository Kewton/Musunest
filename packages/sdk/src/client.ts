// data-api の HTTP 契約（@musunest/appspec-schema の src/api.ts）を呼ぶ、型付きのクライアント（Issue #104）。
//
// 約束は2つある。
//   1. 経路と body を契約どおりに組む。URL の要素（instance・view・action の名前）は api.ts の api*Path が包む
//   2. **失敗を成功にしない。** HTTP status・誤りコード・fields・validations を保って返し、ネットワークの例外・
//      JSON でない応答・契約と違う形の応答は、成功の型へキャストせず失敗にする
//
// fetch と base URL は差し込める。host の画面は同じ origin の /api/* を叩くので `baseUrl: ""` でよい
// （相対 URL のまま fetch する）。e2e のように別の origin を指す場合は絶対 URL を渡す。

import { API_ERROR_CODES, VIEW_TYPES, apiActionPath, apiSpecPath, apiViewPath } from "@musunest/appspec-schema";
import type { ApiErrorCode, ApiRow, ApiSpecBody, ApiValue, ApiViewBody } from "@musunest/appspec-schema";

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
}

export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClientError };

export interface MusunestClient {
  /** `GET /api/instances/:instanceId/spec`。宣言と、操作の可否（`permissions`・`actions`） */
  getSpec(instanceId: string): Promise<ClientResult<ApiSpecBody>>;
  /** `GET /api/instances/:instanceId/views/:viewName`。宣言順の列と、登録順の行 */
  getView(instanceId: string, viewName: string): Promise<ClientResult<ApiViewBody>>;
  /** `POST /api/instances/:instanceId/actions/:actionName`。書いた行（計算値つき）が返る */
  addRecord(
    instanceId: string,
    actionName: string,
    input: Readonly<Record<string, ApiValue>>,
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
  return isRecord(value) && typeof value.name === "string" && typeof value.entity === "string";
}

/**
 * 項目の宣言。**文字列の 1 語（`string`・`number`・`list`）と、参照の写像**
 * （`{type: ref, to}`・`{type: list, of}`）の両方（M1.2）。
 */
function isFieldDeclaration(value: unknown): boolean {
  if (typeof value === "string") return value === "string" || value === "number" || value === "list";
  if (!isRecord(value)) return false;
  if (value.type === "ref") return typeof value.to === "string";
  if (value.type === "list") return typeof value.of === "string";
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

/** computed の 1 件は、式（`expression`）か集計（`aggregate`）の**どちらか一方**である（M1.2） */
function isComputedDeclaration(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.entity !== "string" ||
    value.type !== "number"
  ) {
    return false;
  }
  if (typeof value.expression === "string") return value.aggregate === undefined;
  return isAggregate(value.aggregate);
}

/**
 * 一覧の宣言。M1.2 で `type`（種類。語彙は `VIEW_TYPES` の 2 つだけ）と `show`（表に出す名前の順）を
 * 足した。**`show` は `type: table` のときだけ**である（書ける欄は `type` が決める）。
 */
function isView(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.entity !== "string") return false;
  if (value.type !== undefined) {
    if (typeof value.type !== "string" || !(VIEW_TYPES as readonly string[]).includes(value.type)) {
      return false;
    }
  }
  if (value.show === undefined) return true;
  return value.type === "table" && isStringArray(value.show);
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
    value.actions.every(isActionRef) &&
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
  return Object.values(value.computed).every((item) => item === null || typeof item === "number");
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
