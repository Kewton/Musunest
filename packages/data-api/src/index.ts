// ★唯一の権限強制点（Worker）。外部ルートを持たない。
//
// wrangler.jsonc の main。到達経路は gateway からの Service Binding だけで、
// workers_dev / preview_urls / routes はすべて切ってある（src/index.test.ts が設定を確かめる）。
//
// 応答するのは 6 経路である（Issue #102・#260。経路と応答の形は appspec-schema の src/api.ts が正本）:
//   GET  /healthz                                       … 貫通スモーク（03 §5）。M0 から変えない
//   GET  /api/instances/:instanceId/spec                … 正規化した JSON（Issue #98）
//   GET  /api/instances/:instanceId/views/:viewName     … 一覧（計算値つき）
//   POST /api/instances/:instanceId/actions/:actionName … 1 件の追加
//   GET  /api/me/instances                              … ログインした利用者のアプリの一覧（M2.1。Issue #260）
//   POST /identity/login                                … 利用者の登録の入口（M2.1。**`/api` の外**。gateway だけが呼ぶ）
//
// **ここが持つのは HTTP の作法だけ**である——経路の解析・method の検査・body の読み取り・
// 誤りコードから HTTP ステータスへの対応・例外を応答に漏らさないこと。何を読んで何を断るかは
// src/app-api.ts が決め、Cloudflare の API は src/cloudflare.ts が叩く。
//
// **時計はここで作る（実時計）。** ヘッダ・query・body から受け取る口は作らない（Q17）——
// 保存日時を外から決められると、採点の時計の意味が変わる。
import { AppInstanceDO } from "@musunest/app-do";
import {
  API_ERROR_STATUS,
  IDENTITY_HEADER,
  IDENTITY_LOGIN_PATH,
  apiErrorBody,
  apiRouteMethod,
  readApiRoute,
} from "@musunest/appspec-schema";
import type { ApiLoginRegistration, ApiRoute } from "@musunest/appspec-schema";
import type { ApiFailure, ApiResult, DataApiDeps, InstanceAccess } from "./app-api";
import { createFromAction, getSpec, getView } from "./app-api";
import { cloudflareDataApi, cloudflareIdentity, cloudflareProbes } from "./cloudflare";
import type { DataApiEnv } from "./cloudflare";
import { HEALTHZ_PATH } from "./contract";
import { runHealthz } from "./healthz";
import { listMyInstances, registerIdentity } from "./identity";

// DO のクラスは binding を持つ Worker の main から export しなければ解決されない。
// 実装の正本は app-do で、data-api は運ぶだけ。
export { AppInstanceDO };

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

/**
 * 断った結果を HTTP の応答にする。**例外の文言も資格情報も載せない。**
 *
 * ステータスは `API_ERROR_STATUS`（HTTP 契約の正本。`@musunest/appspec-schema` の `src/api.ts`）から引く。
 * **ここに 2 つ目の表を作らない**——data-api と gateway・host は同じ契約を別々に書き写すと必ずずれる
 * （`src/api.ts` の冒頭を参照）。コードを足すときは、正本の一覧と、それを固定しているテスト
 * （`src/index.test.ts` と appspec-schema の `src/api.test.ts`）を同じ PR で直す。
 */
function failureResponse(failure: ApiFailure, allow?: string): Response {
  const body = apiErrorBody(failure.error, failure);
  return json(
    body,
    API_ERROR_STATUS[failure.error],
    allow === undefined ? undefined : { allow },
  );
}

function respond<Body>(result: ApiResult<Body>): Response {
  return result.ok ? json(result.body, result.status) : failureResponse(result.failure);
}

function notAllowed(allow: string): Response {
  return failureResponse({ error: "METHOD_NOT_ALLOWED", fields: [], validations: [] }, allow);
}

function notFound(): Response {
  return failureResponse({ error: "NOT_FOUND", fields: [], validations: [] });
}

/**
 * 操作の body を読む。JSON として読めなければ `null`（呼ぶ側が 400 にする）。
 * **本文が空なら「項目が 1 つも無い入力」**として渡す——操作の入力を省いた要求は、
 * 構文の誤りではなく、項目が足りない入力である（`INPUT_REJECTED` か、宣言に無い操作の 404）。
 * オブジェクトでない JSON（並び・数・`null`）も同じ扱いにする。
 */
async function readActionBody(request: Request): Promise<Readonly<Record<string, unknown>> | null> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

/**
 * 利用者の Community への所属を、control-plane の登録（D1）から読む（M2.1。Issue #262）。
 * **data-api に SQL を書かない**——表の読み取りは control-plane（`cloudflareIdentity`）が持つ。
 * 「その利用者が属する Community のどれかが、このインスタンスを持っているか」で判定する
 * （M2.1 は 1 人 1 Community なので、ふつうは 1 回で決まる）。
 *
 * **`production` のときだけ呼ばれる**（ほかの env は検査そのものを掛けないので、この実体は一度も
 * 呼ばれない）。
 */
function instanceMembership(env: DataApiEnv): InstanceAccess {
  const identity = cloudflareIdentity(env);
  return {
    async owns(userId, instanceId) {
      for (const community of await identity.listCommunities(userId)) {
        const owned = await identity.listInstances(community.communityId);
        if (owned.some((owner) => owner.instanceId === instanceId)) return true;
      }
      return false;
    },
  };
}

async function handleApi(
  request: Request,
  env: DataApiEnv,
  route: ApiRoute,
): Promise<Response> {
  const expected = apiRouteMethod(route);
  if (request.method !== expected) return notAllowed(expected);

  try {
    // 自分のアプリの一覧（M2.1）。対象の指定は無く、**識別ヘッダ**が対象を決める。
    // ヘッダが無ければ 401（判定は src/identity.ts が持ち、**D1 を読まない**）
    if (route.kind === "me") {
      return respond(
        await listMyInstances(
          { identity: cloudflareIdentity(env) },
          request.headers.get(IDENTITY_HEADER),
        ),
      );
    }

    // 実時計。リクエストの値では差し替えられない（Q17）
    // 所属の検査の材料（M2.1。Issue #262）。**production のときだけ** src/app-api.ts が掛ける——
    // dev と staging は M1 のまま開けておく（決定 2026-10-08）。検査を掛けない env では
    // `membership` の実体（D1 の読み取り）が一度も呼ばれない
    const deps: DataApiDeps = {
      ...cloudflareDataApi(env, route.instanceId),
      access: {
        environment: env.ENVIRONMENT,
        // gateway だけが付けるヘッダ。外から届いた値は gateway が取り除いてから中継する（Issue #263）
        userId: request.headers.get(IDENTITY_HEADER),
        membership: instanceMembership(env),
      },
    };
    switch (route.kind) {
      case "spec":
        return respond(await getSpec(deps, route.instanceId));
      case "view":
        return respond(await getView(deps, route.instanceId, route.viewName));
      case "action": {
        const input = await readActionBody(request);
        if (input === null) {
          return failureResponse({ error: "INVALID_JSON", fields: [], validations: [] });
        }
        return respond(await createFromAction(deps, route.instanceId, route.actionName, input));
      }
    }
  } catch (error) {
    // 依存（D1・R2・DO）の失敗。**文言はログにだけ出す**——応答は外へ出る
    // （binding の名前や資格情報の構成が混ざり得る。src/healthz.ts と同じ扱い）
    console.error("[data-api] api:", error);
    return failureResponse({ error: "SPEC_UNAVAILABLE", fields: [], validations: [] });
  }
}

/**
 * `POST /identity/login`（M2.1）。**gateway だけが呼ぶ入口**である——`/api` の外にあるので、
 * gateway の `/api` 中継からは届かない（Service Binding 越しにだけ届く）。body は Google OIDC の
 * subject と表示名である（`ApiLoginRegistration`）。**同じ subject の 2 回目は冪等**である。
 */
async function handleIdentityLogin(request: Request, env: DataApiEnv): Promise<Response> {
  if (request.method !== "POST") return notAllowed("POST");
  const body = await readActionBody(request);
  if (body === null) return failureResponse({ error: "INVALID_JSON", fields: [], validations: [] });
  const registration = loginRegistrationOf(body);
  if (!registration.ok) {
    return failureResponse({ error: "INPUT_REJECTED", fields: registration.fields, validations: [] });
  }
  try {
    return respond(
      await registerIdentity({ identity: cloudflareIdentity(env) }, registration.registration),
    );
  } catch (error) {
    // 依存（D1）の失敗。**文言はログにだけ出す**（binding の名前や資格情報が混ざり得る）
    console.error("[data-api] identity:", error);
    return failureResponse({ error: "SPEC_UNAVAILABLE", fields: [], validations: [] });
  }
}

/**
 * 登録の body を読む。**gateway だけが送る**——通らなければ項目名を返し、呼ぶ側が 422 にする
 * （`googleSubject` と `displayName` は空でない文字列である）。
 */
function loginRegistrationOf(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly registration: ApiLoginRegistration }
  | { readonly ok: false; readonly fields: readonly string[] } {
  const googleSubject = body["googleSubject"];
  const displayName = body["displayName"];
  const communityName = body["communityName"];
  const fields: string[] = [];
  if (typeof googleSubject !== "string" || googleSubject === "") fields.push("googleSubject");
  if (typeof displayName !== "string" || displayName === "") fields.push("displayName");
  if (communityName !== undefined && (typeof communityName !== "string" || communityName === "")) {
    fields.push("communityName");
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    registration: {
      googleSubject: googleSubject as string,
      displayName: displayName as string,
      ...(communityName === undefined ? {} : { communityName: communityName as string }),
    },
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTHZ_PATH) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });
      const { status, body } = await runHealthz(cloudflareProbes(env), {
        env: env.ENVIRONMENT,
        version: env.GIT_SHA,
      });
      return json(body, status);
    }

    // 利用者の登録の入口（M2.1。Issue #260）。**`/api` の外**にあるので、gateway の
    // `/api` 中継からは届かない——gateway が OIDC のコールバックで、Service Binding 越しにだけ呼ぶ
    if (url.pathname === IDENTITY_LOGIN_PATH) return handleIdentityLogin(request, env);

    const route = readApiRoute(url.pathname);
    if (route !== null) return handleApi(request, env, route);

    return notFound();
  },
} satisfies ExportedHandler<DataApiEnv>;
