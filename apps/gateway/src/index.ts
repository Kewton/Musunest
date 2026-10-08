// Community Gateway。認証・AppGrant 検査の入口（中身は M2）。**D1 / R2 / DO を直接触らない。**
//
// wrangler.jsonc の main。持つ binding は data-api への Service Binding（DATA_API）だけで、
// D1 / R2 / DO には data-api を経由してしか届かない（CLAUDE.md 不変条件「Data API が唯一の権限強制点」）。
// 設定は src/index.test.ts が env ごとに、import と型は src/.oxlintrc.json が lint で確かめる。
//
// 応答するのは Google OIDC のログイン・コールバック・ログアウト（/auth/*。M2.1・Issue #263）と、
// GET /healthz と /api/* の中継である（Issue #103）。/auth/* は **/api の外**で、判定は src/auth.ts、
// Google との往復とセッションの署名は src/cloudflare.ts が持つ。中継の前に、セッションが示す利用者 ID を
// 識別ヘッダに載せ替える（外から届いた値は src/api.ts が取り除く）。healthz は data-api の healthz を中継して
// 自分の結果を足す。**/api/* は dev / staging のときだけ data-api へ中継し、production・ENVIRONMENT の未設定・
// 未知の値では下流を一度も呼ばずに 404 にする**（00 Q5。判定と作法は src/api.ts、binding は src/cloudflare.ts）。
// gateway も workers.dev で直接届くので、この 404 は host 経由だけでなく直接アクセスにも効く。
// production（vars.HEALTHZ_DETAIL が probe）では、X-Musunest-Probe が secret と一致しない限り詳細を隠す（03 §5「セキュリティ上の注意」）。
import { handleApi, isApiPath } from "./api";
import { AUTH_CALLBACK_PATH, handleAuth, isAuthPath, sessionUserId } from "./auth";
import type { AuthConfig } from "./auth";
import {
  cloudflareAuthDeps,
  cloudflareDataApi,
  cloudflareDataApiRelay,
  cloudflareProbe,
  cloudflareSession,
} from "./cloudflare";
import type { GatewayEnv } from "./cloudflare";
import { HEALTHZ_PATH, PROBE_HEADER } from "./contract";
import { disclose, readHealthzDetail, runHealthz } from "./healthz";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

/**
 * ログインの設定。redirect_uri は**この要求の origin**（gateway が直接届く workers.dev のホスト）に
 * callback の経路を足したものである。client_id が無ければ認証は閉じる（src/auth.ts が 503 にする）。
 */
function authConfig(env: GatewayEnv, url: URL): AuthConfig {
  return {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    redirectUri: new URL(AUTH_CALLBACK_PATH, url.origin).href,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // 認証の入口（M2.1）。**/api の外**にあるので、中継より先に置く（/auth/* は中継の対象ではない）
    if (isAuthPath(url.pathname)) return handleAuth(request, authConfig(env, url), cloudflareAuthDeps(env));

    // /api/* の判定は healthz より先に置く。**下流を呼ぶのは dev / staging のときだけ**である。
    // セッションが示す利用者 ID を中継の前に載せる（外から届いた識別ヘッダは src/api.ts が取り除く）
    if (isApiPath(url.pathname)) {
      const userId = await sessionUserId(request, cloudflareSession(env), () => Date.now());
      return handleApi(request, env, cloudflareDataApiRelay(env), userId);
    }

    if (url.pathname !== HEALTHZ_PATH) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });

    const result = await runHealthz(cloudflareDataApi(env), {
      env: env.ENVIRONMENT,
      version: env.GIT_SHA,
    });
    const body = await disclose(
      result,
      readHealthzDetail(env.HEALTHZ_DETAIL),
      request.headers.get(PROBE_HEADER),
      cloudflareProbe(env),
    );
    return json(body, result.status);
  },
} satisfies ExportedHandler<GatewayEnv>;
