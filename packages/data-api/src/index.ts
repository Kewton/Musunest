// ★唯一の権限強制点（Worker）。外部ルートを持たない。
//
// wrangler.jsonc の main。到達経路は gateway からの Service Binding だけで、
// workers_dev / preview_urls / routes はすべて切ってある（src/index.test.ts が設定を確かめる）。
//
// 応答するのは 4 経路である（Issue #102。経路と応答の形は appspec-schema の src/api.ts が正本）:
//   GET  /healthz                                       … 貫通スモーク（03 §5）。M0 から変えない
//   GET  /api/instances/:instanceId/spec                … 正規化した JSON（Issue #98）
//   GET  /api/instances/:instanceId/views/:viewName     … 一覧（計算値つき）
//   POST /api/instances/:instanceId/actions/:actionName … 1 件の追加
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
  apiErrorBody,
  apiRouteMethod,
  readApiRoute,
} from "@musunest/appspec-schema";
import type { ApiRoute } from "@musunest/appspec-schema";
import type { ApiFailure, ApiResult } from "./app-api";
import { createFromAction, getSpec, getView } from "./app-api";
import { cloudflareDataApi, cloudflareProbes } from "./cloudflare";
import type { DataApiEnv } from "./cloudflare";
import { HEALTHZ_PATH } from "./contract";
import { runHealthz } from "./healthz";

// DO のクラスは binding を持つ Worker の main から export しなければ解決されない。
// 実装の正本は app-do で、data-api は運ぶだけ。
export { AppInstanceDO };

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

/** 断った結果を HTTP の応答にする。**例外の文言も資格情報も載せない** */
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

async function handleApi(
  request: Request,
  env: DataApiEnv,
  route: ApiRoute,
): Promise<Response> {
  const expected = apiRouteMethod(route);
  if (request.method !== expected) return notAllowed(expected);

  // 実時計。リクエストの値では差し替えられない（Q17）
  const deps = cloudflareDataApi(env, route.instanceId);
  try {
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

    const route = readApiRoute(url.pathname);
    if (route !== null) return handleApi(request, env, route);

    return notFound();
  },
} satisfies ExportedHandler<DataApiEnv>;
