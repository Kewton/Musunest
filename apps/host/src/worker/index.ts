// PWA Host Shell の Worker。**SSR をしない。ページを返さない。**
//
// wrangler.jsonc の main。ページロード（/・深いリンク・JS / CSS）は Static Assets が Worker を起動せずに返すので、
// ここに届くのは assets.run_worker_first に書いた /api/* と /healthz だけである（03 §2・06 §4.1）。
// React / TanStack Start をここから import しない（src/.oxlintrc.json が落とす。バンドルに入らないことは src/worker/index.test.ts が見る）。
//
// 持つ binding は gateway への Service Binding（GATEWAY）だけで、D1 / R2 / DO を直接触らない（CLAUDE.md 不変条件）。
// 応答するのは GET /healthz と /api/* の中継である（Issue #103）。healthz は gateway の healthz を中継して
// 自分の結果を足す。**/api/* は dev / staging のときだけ gateway へ中継し、production・ENVIRONMENT の未設定・
// 未知の値では下流を一度も呼ばずに 404 にする**（00 Q5。判定と作法は src/worker/api.ts、binding は src/worker/cloudflare.ts）。
// この 404 は JSON で、SPA シェルの HTML ではない（/api/* を Worker が先に受ける理由の1つ）。
// production（vars.HEALTHZ_DETAIL が probe）では、X-Musunest-Probe が secret と一致しない限り詳細を隠す（03 §5「セキュリティ上の注意」）。
import { handleApi, isApiPath } from "./api";
import { cloudflareGateway, cloudflareGatewayRelay, cloudflareProbe } from "./cloudflare";
import type { HostEnv } from "./cloudflare";
import { HEALTHZ_PATH, PROBE_HEADER } from "./contract";
import { disclose, readHealthzDetail, runHealthz } from "./healthz";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // /api/* の判定は healthz より先に置く。**下流を呼ぶのは dev / staging のときだけ**である
    if (isApiPath(url.pathname)) return handleApi(request, env, cloudflareGatewayRelay(env));

    if (url.pathname !== HEALTHZ_PATH) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });

    const result = await runHealthz(cloudflareGateway(env), {
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
} satisfies ExportedHandler<HostEnv>;
