// data-api が公開する HTTP の契約（Issue #102）。
//
// **パス・応答の形・誤りコードをここに 1 か所で置く。** data-api（唯一の権限強制点）と、
// それを Service Binding 越しに呼ぶ gateway・host は、同じ契約を別々に書き写すと必ずずれる。
// だが両者が共有できる場所は限られる——host は data-api を参照できない（host → sdk だけ。CLAUDE.md
// 「依存の向き」）ので、共通の型は**依存を持たないこのパッケージ**に置く（data-api・sdk はここから読む）。
//
// **Worker の実行時コードと Cloudflare の型はここに出てこない。** 画面（host）が受け取る型に
// Worker 本体（env の binding・DO のクラス）を混ぜると、host が Worker を解決しようとする。
// この file が import するのは宣言の型（./spec.js）だけである（src/api.test.ts が走査して確かめる）。
//
// 経路・応答・誤りコードの意味は packages/data-api/README.md、宣言の意味は
// ./docs/semantics.md にある。M1.1 の `message` はまだ無いので、拒否の内容は項目名と検査名で返す。

import type { ActionKind, AppSpec } from "./spec.js";

// ── 経路 ────────────────────────────────────────────────────────
//
//   GET  /api/instances/:instanceId/spec
//   GET  /api/instances/:instanceId/views/:viewName
//   POST /api/instances/:instanceId/actions/:actionName
//
// 操作（action）の body は「項目名: 値」のオブジェクトである（正規化した JSON の宣言が正本）。
// 宣言に無い経路は作らない（任意の entity への汎用の書込口をこしらえない）。

/** 経路の先頭。インスタンスは登録表（control-plane）の ID で指す */
export const API_PREFIX = "/api/instances" as const;

export const API_SPEC_SEGMENT = "spec" as const;
export const API_VIEWS_SEGMENT = "views" as const;
export const API_ACTIONS_SEGMENT = "actions" as const;

export function apiSpecPath(instanceId: string): string {
  return `${API_PREFIX}/${encodeURIComponent(instanceId)}/${API_SPEC_SEGMENT}`;
}

export function apiViewPath(instanceId: string, viewName: string): string {
  return `${API_PREFIX}/${encodeURIComponent(instanceId)}/${API_VIEWS_SEGMENT}/${encodeURIComponent(viewName)}`;
}

export function apiActionPath(instanceId: string, actionName: string): string {
  return `${API_PREFIX}/${encodeURIComponent(instanceId)}/${API_ACTIONS_SEGMENT}/${encodeURIComponent(actionName)}`;
}

/** 読んだ経路。`kind` ごとに、宣言の名前で対象が決まる */
export type ApiRoute =
  | { readonly kind: "spec"; readonly instanceId: string }
  | { readonly kind: "view"; readonly instanceId: string; readonly viewName: string }
  | { readonly kind: "action"; readonly instanceId: string; readonly actionName: string };

/** その経路が受ける method。ほかは 405 である */
export function apiRouteMethod(route: ApiRoute): "GET" | "POST" {
  return route.kind === "action" ? "POST" : "GET";
}

/**
 * パスを経路に読む。契約の 3 経路に合わなければ `null`（呼ぶ側が 404 にする）。
 * 空の区切り（`//`）と読めないパーセント符号は、経路にしない——存在しないインスタンスとして扱う。
 */
export function readApiRoute(pathname: string): ApiRoute | null {
  const trimmed = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  const parts = trimmed.split("/");
  // 先頭は空（`/` で始まる）。空の区切りはそのまま残すので、下の長さの検査で落ちる
  if (parts.shift() !== "") return null;
  if (parts.shift() !== "api" || parts.shift() !== "instances") return null;

  const instanceId = decodeSegment(parts.shift());
  if (instanceId === null || instanceId === "") return null;

  const section = parts.shift();
  if (section === API_SPEC_SEGMENT) {
    return parts.length === 0 ? { kind: "spec", instanceId } : null;
  }
  if (section === API_VIEWS_SEGMENT) {
    const viewName = parts.length === 1 ? decodeSegment(parts[0]) : null;
    return viewName === null || viewName === "" ? null : { kind: "view", instanceId, viewName };
  }
  if (section === API_ACTIONS_SEGMENT) {
    const actionName = parts.length === 1 ? decodeSegment(parts[0]) : null;
    return actionName === null || actionName === ""
      ? null
      : { kind: "action", instanceId, actionName };
  }
  return null;
}

/** パーセント符号を戻す。読めない符号は経路にしない（例外を外へ出さない） */
function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// ── 応答：成功 ────────────────────────────────────────────────

/** 読取の成功（spec・一覧）と、直す・消すの成功（M1.2） */
export const API_READ_STATUS = 200 as const;
/** 追加の成功 */
export const API_CREATED_STATUS = 201 as const;

/**
 * 対象を参照している保存済みの行（M1.2）。消せない理由を、**参照元の entity と項目、件数**で返す。
 * 消せないことの判断は data-api（唯一の権限強制点）が行い、画面はこの値をそのまま見せる。
 */
export interface ApiReference {
  /** 参照している行の entity */
  readonly entity: string;
  /** 参照している項目（`ref` か参照 list） */
  readonly field: string;
  /** その entity と項目で、対象を指している保存済みの行の数（1 以上） */
  readonly count: number;
}

/**
 * レコードの値。今の語彙（`string`・`number`・`list`）が作る値だけを使う
 * （./docs/semantics.md「string」「number」「list」）。語彙が増えたら、この型も同じ PR で広げる。
 */
export type ApiValue = string | number | readonly string[];

/** 一覧の 1 行。**項目と計算値を分けて返す**ので、画面は式を評価しなくてよい */
export interface ApiRow {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 項目の値（宣言の順は一覧の `fields` が持つ） */
  readonly fields: Readonly<Record<string, ApiValue>>;
  /**
   * 計算の値。求められなかった計算は `null`（画面では空。計算の値は保存しない）。
   *
   * **M1.3 で真偽（`boolean`）も載せられるようにした**（Issue #157）。ボードの強調（`highlight`）が
   * 指す真偽の計算の値である。**判定するのは Data API**（唯一の権限強制点）で、画面は式を評価しない
   * ——この値をそのまま見て、真の行に印を付けるだけである（`CLAUDE.md` の不変条件）。
   * 真偽の計算は一覧の列には出さない（一覧の応答の `computed` の並びには入らない）。
   */
  readonly computed: Readonly<Record<string, number | boolean | null>>;
  /**
   * この行を**参照している**保存済みの行（M1.2）。消せるかどうかを画面が判断するために載せる
   * （消せないことの判断は data-api が行い、画面はボタンを出さないだけで守りではない。`03` §2.2）。
   *
   * **その entity に `delete` の操作を宣言しているときだけ載せる**——宣言が無ければ
   * 削除ボタンも出ないので、M1.1 の応答を変えない。空の並びは「参照されていない（消せる）」である。
   * `null` へ読み替えない（`settlement` と同じ約束である）。
   */
  readonly references?: readonly ApiReference[];
  /**
   * **この行に対して、いま実行してよい操作の名前**（M1.3）。対象の行 1 件を取る操作
   * （`kind: update`・`kind: delete`）のうち、`when` が真のものを**宣言の順**で並べる。
   * `when` を持たない操作はいつでも実行できるので、常に入る。
   *
   * **その entity の操作が 1 つでも `when` を持つときだけ載せる**——持たなければ判定そのものが
   * 無いので、M1.2 の応答を変えない。`undefined` は「条件が宣言されていない」であって
   * 「何もできない」ではない。空の並びは「どの操作もいまはできない」である（`references` と同じ約束）。
   *
   * **判定するのは Data API である**（唯一の権限強制点）。画面はこの並びを見てボタンを出し分けるが、
   * それは親切であって守りではない——条件を満たさない操作は Data API が
   * `ACTION_NOT_ALLOWED` で断る（`03` §2.2）。
   */
  readonly allowedActions?: readonly string[];
}

/** 消した結果（M1.2）。消せたときだけ返す（消せないときは 409 `REFERENCE_IN_USE` である） */
export interface ApiDeletedBody {
  readonly entity: string;
  /** 消した行の ID */
  readonly id: string;
  readonly deleted: true;
}

/**
 * 操作の 1 つ。画面はこれを見て、追加のフォームと削除のボタンを出す。
 * `kind` は M1.2 で足した**操作の種類**である（`create`・`update`・`delete`）。
 * **宣言で省略したときは欄そのものを載せない**（M1.1 の応答を変えない。省略の意味は `create` である）。
 */
export interface ApiActionRef {
  readonly name: string;
  readonly entity: string;
  /** 操作の種類（宣言にあるときだけ）。無ければ `create` として読む */
  readonly kind?: ActionKind;
}

/**
 * 精算の 1 件（M1.2）。**送金元と送金先はメンバーのレコードの ID**、額は**正の数**である。
 * 差し引きが 0 の人と、自分の送金は現れない。並びは「金額の大きい順（同額は登録順）」で組んだ順である
 * （docs/semantics.md「settle」）。画面は計算し直さず、この並びをそのまま見せる。
 */
export interface ApiTransfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/** このインスタンスで今できること。宣言していない権限は誰にも与えない（./docs/semantics.md「permission」） */
export interface ApiPermissions {
  readonly read: boolean;
  readonly write: boolean;
}

/**
 * アプリ全体の集計（`scope: app`。M1.4。Issue #177）の値。**求められなかった値は `null`** である
 * ——0 にも空の並びにも読み替えない（`computed` と同じ約束である。./docs/semantics.md「computed」「avg」）。
 */
export type ApiScopeValue = number | null;

/** `GET /api/instances/:instanceId/spec` の本文（正規化した JSON。Issue #98） */
export interface ApiSpecBody {
  readonly instanceId: string;
  /** 変換に使ったスキーマの版 */
  readonly schemaVersion: string;
  /** 原本（app.spec.yaml）のバイト列の SHA-256。登録と照合した値 */
  readonly sourceSha256: string;
  readonly spec: AppSpec;
  readonly permissions: ApiPermissions;
  /** 宣言した操作（宣言の順） */
  readonly actions: readonly ApiActionRef[];
}

/**
 * `GET /api/instances/:instanceId/views/:viewName` の本文。
 * 行だけでなく、**宣言順の表示に必要な情報（`fields`・`computed`）と操作の可否（`actions`・`permissions`）**
 * を返す——SDK が受け取る JSON だけで画面が作れるようにする。
 */
export interface ApiViewBody {
  readonly instanceId: string;
  readonly view: string;
  readonly entity: string;
  /**
   * 項目の名前（宣言の順）。**表（`type: table`）の列の順ではない**——列の順は宣言の `show` が
   * あればそちらが決め、無ければ「この並び（項目の宣言の順）に続いて `computed` の並び」である
   * （declaration 側の `View.show` と ./docs/semantics.md「table」）。行の値はこの並びで読める。
   */
  readonly fields: readonly string[];
  /** 計算の名前（宣言の順） */
  readonly computed: readonly string[];
  readonly permissions: ApiPermissions;
  /** その entity への操作（宣言の順） */
  readonly actions: readonly ApiActionRef[];
  /** すべての行（登録した順。古いものが先） */
  readonly rows: readonly ApiRow[];
  /**
   * 精算（M1.2）。その entity に `settle` の計算を宣言していれば、店頭が組んだ送金の並びを返す。
   * **宣言が無ければこの欄を載せない**（M1.1 の応答を変えない。`validationMessages` と同じ扱い）。
   * 読めなかった（支出のレコードが壊れている）ときは **`null`** である——空の並び（送金が要らない）と
   * 区別し、**空の並びに読み替えない**（`computed` の `null` と同じ約束である）
   */
  readonly settlement?: readonly ApiTransfer[] | null;
  /**
   * **アプリ全体の集計（`scope: app`。M1.4。Issue #177）の値**。計算の名前 → その値である
   * （宣言の順）。求められなかった値は `null` で、**0 に読み替えない**。
   *
   * **宣言が無ければこの欄を載せない**（`settlement` と同じ約束である）。行ごとの値（`rows`）とは
   * 別の欄である——アプリ全体の集計は、どのレコードにも属さない（`scope: app`）。
   * **1 回の取得でまとめて返す**（部品ごとに取りに行かない）。値は data-api が求める
   * ——**画面は式も集計も評価しない**（`CLAUDE.md` の不変条件）。
   */
  readonly scope?: Readonly<Record<string, ApiScopeValue>>;
}

/** `POST /api/instances/:instanceId/actions/:actionName` の本文。**書いた行**（計算値つき）を返す */
export type ApiCreatedBody = ApiRow;

// ── 応答：誤り ────────────────────────────────────────────────

/**
 * 誤りコード（HTTP の案。Issue #102）。**成功に見せかけた空配列へ変換しない**——
 * 読めなかったことは、読めたことにして返すのではなく、このコードで返す。
 */
export const API_ERROR_CODES = [
  /** body が JSON として読めない */
  "INVALID_JSON",
  /** 項目の型・検査に通らない。`fields` と `validations` を返す */
  "INPUT_REJECTED",
  /** `read` / `write` の宣言が無い */
  "PERMISSION_DENIED",
  /** 不明な instance / view / action */
  "NOT_FOUND",
  /** その経路が受けない method */
  "METHOD_NOT_ALLOWED",
  /** 登録・R2 のオブジェクト・宣言の整合性（版・SHA）が不良 */
  "SPEC_UNAVAILABLE",
  /** 参照されているレコードを消そうとした（M1.2。`references` を返す。docs/semantics.md「delete」） */
  "REFERENCE_IN_USE",
  /**
   * 操作の条件（`when`）が、その行で成り立たない（M1.3。`action` と `when` を返す）。
   * **`INPUT_REJECTED` を使い回さない**——「入力が悪い」と「いまその操作はできない」は別物で、
   * 画面の出し方も変わる（打ち直させるのではなく、その行ではできないことを伝える）。
   */
  "ACTION_NOT_ALLOWED",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * 誤りコードと HTTP ステータス。コードが先で、ステータスはそこから決まる。
 *
 * **コードを足すときは、この一覧と、それを固定しているテスト（`packages/data-api/src/index.test.ts` と
 * `src/api.test.ts`）を同じ PR で直す。** 一覧の外にステータスを隠す（列挙しない欄にする）ことはしない——
 * 隠すと、応答を組む側（data-api の `src/index.ts`）とテストが、同じ表を別々に読むことになる。
 */
export const API_ERROR_STATUS = {
  INVALID_JSON: 400,
  INPUT_REJECTED: 422,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  SPEC_UNAVAILABLE: 503,
  /** 参照されているレコードを消そうとした（M1.2）。`references` を返す */
  REFERENCE_IN_USE: 409,
  /** 操作の条件（`when`）が成り立たない（M1.3）。`action` と `when` を返す */
  ACTION_NOT_ALLOWED: 409,
} as const satisfies Record<ApiErrorCode, number>;

/**
 * 型の検査で通らなかった項目と、通らなかった検査の名前。**どちらも宣言順の材料を持つ**。
 * 検査が文言（`message`）を宣言していれば、名前と文言の対応も載せる（M1.2。Issue #106）。
 */
export interface ApiRejectedBody {
  readonly error: "INPUT_REJECTED";
  /** 型・参照の検査で通らなかった項目（宣言の順のあとに、未知の項目を入力の順で続ける） */
  readonly fields: readonly string[];
  /** 通らなかった検査の名前（宣言の順） */
  readonly validations: readonly string[];
  /**
   * 通らなかった検査の文言（`validations` と**同じ並び**。文言の無い検査は `null`）。
   * **文言を 1 つも宣言していない宣言では、この欄を載せない**——M1.1 の応答（検査名だけ）を
   * 変えないためである。読む側は、無ければ検査の名前で識別する（#102 の約束を保つ）。
   */
  readonly validationMessages?: readonly (string | null)[];
}

/** それ以外の誤り。**例外の内部情報も資格情報も載せない**（応答は外へ出る。data-api の README） */
export interface ApiFailureBody {
  readonly error: Exclude<ApiErrorCode, "INPUT_REJECTED">;
}

/**
 * 参照されているレコードを消そうとしたときの本文（M1.2。409 `REFERENCE_IN_USE`）。
 * **参照元の entity と項目、件数を載せる**——画面が「なぜ消せないか」をそのまま見せられるようにする。
 * 件数が 0 のときは欄を載せない（そのときは 409 にならない）。
 */
export interface ApiReferenceInUseBody {
  readonly error: "REFERENCE_IN_USE";
  readonly references?: readonly ApiReference[];
}

/**
 * 操作の条件（`when`）が成り立たない行に操作を送ったときの本文（M1.3。409 `ACTION_NOT_ALLOWED`）。
 * **どの操作のどの条件で断ったかを載せる**——画面がそのまま見せられるようにする。
 * 条件は**宣言に書いてある式そのもの**である（評価の途中経過も、行の値も載せない）。
 */
export interface ApiActionNotAllowedBody {
  readonly error: "ACTION_NOT_ALLOWED";
  /** 断った操作の名前（宣言の `actions` の `name`） */
  readonly action: string;
  /** その操作の条件（宣言の `when` の式） */
  readonly when: string;
}

export type ApiErrorBody =
  | ApiRejectedBody
  | ApiReferenceInUseBody
  | ApiActionNotAllowedBody
  | ApiFailureBody;

/**
 * 誤りの本文を組む。`INPUT_REJECTED` のときだけ `fields` と `validations` を載せ
 * （ほかのコードでは項目名も検査名も無いので、空の配列を載せない）、`REFERENCE_IN_USE` のときだけ
 * `references` を、`ACTION_NOT_ALLOWED` のときだけ `action` と `when` を載せる。
 * `validationMessages` は、**文言が 1 つでもあるとき**だけ `validations` と同じ並びで載せる。
 */
export function apiErrorBody(
  error: ApiErrorCode,
  details?: {
    readonly fields?: readonly string[];
    readonly validations?: readonly string[];
    readonly validationMessages?: readonly (string | null)[];
    readonly references?: readonly ApiReference[];
    readonly action?: string;
    readonly when?: string;
  },
): ApiErrorBody {
  if (error === "INPUT_REJECTED") {
    const fields = details?.fields ?? [];
    const validations = details?.validations ?? [];
    const messages = details?.validationMessages;
    if (messages === undefined || messages.length === 0) return { error, fields, validations };
    return { error, fields, validations, validationMessages: messages };
  }
  if (error === "REFERENCE_IN_USE") {
    const references = details?.references;
    if (references === undefined || references.length === 0) return { error };
    return { error, references };
  }
  if (error === "ACTION_NOT_ALLOWED") {
    // **どちらも揃っているときだけ載せる。** 片方だけでは「どの操作のどの条件か」にならない
    const action = details?.action;
    const when = details?.when;
    if (action === undefined || when === undefined) return { error };
    return { error, action, when };
  }
  return { error };
}
