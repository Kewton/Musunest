// /api/* の中継（Issue #103）。
//
// ブラウザの API 呼出を gateway へ中継する。この file が決めるのは **中継してよいかどうか** と、
// 下流の応答をどう返すかだけである——binding をどう叩くかは adapter（src/worker/cloudflare.ts）が
// GatewayRelay として渡す（src/worker/healthz.ts と同じ形。CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。
//
// **認証が無い M1 の間、production の入口は /api/* で必ず 404 を返し、下流を一度も呼ばない。**
// 判定に使うのは vars.ENVIRONMENT だけである。probe の合言葉（X-Musunest-Probe）では開かない——
// あれは healthz の詳細を誰に返すかの話であって、API を開ける合言葉ではない。
//
// 応答は下流のものをそのまま返す（status・content-type・body）。**gateway → data-api の拒否（422 など）を
// 成功応答や SPA の HTML に置き換えない。** 中継そのものが失敗したときだけ、内部 origin も
// 資格情報も含まない固定の非 2xx を返す。
//
// 中継の入口は Static Assets の run_worker_first（/api/*）である。**この判定を通った要求は
// SPA シェルに落ちない**——シェルの HTML を API の応答にしないための分岐でもある。
//
// gateway 側（apps/gateway/src/api.ts）と同じ形を書き写している——host は gateway を import できない
// （infra/scripts/dep-graph.mjs で host が持てる依存は @musunest/sdk だけ）。食い違えば
// src/worker/index.test.ts の実機（host → gateway → data-api）が落ちる。
//
// M2.1（Issue #264）で、**ログインの経路（/auth/*）の中継**を足した。gateway の認証は `/api` の外にあるが
// （apps/gateway/src/auth.ts）、run_worker_first に入れて Worker が先に受ける——そうしないと SPA シェルが
// 返り、Google の認可画面へ送れない。**/api/* と違い vars.ENVIRONMENT で閉じない**（ログインは production
// でも要る。閉じるのは gateway が client_id の有無で行う）。作法——下流の応答をそのまま返し、中継そのものが
// 失敗したときだけ内部 origin も資格情報も含まない固定の非 2xx を返す——は /api/* と同じである。

/**
 * 中継する経路の接頭辞。**wrangler.jsonc の assets.run_worker_first と同じ範囲**にする
 * （/api/* は M2 ではなく今、gateway へ中継する。SPA シェルの HTML を API の応答にしない）。
 */
export const API_PREFIX = "/api" as const;

/**
 * 中継してよい vars.ENVIRONMENT の値。**ここに無い値（production・未設定・未知の値）では中継しない。**
 * production が本番のデータに届く入口を、宣言ではなくこの分岐1か所で閉じる（00 Q5）。
 */
export const RELAY_ENVIRONMENTS = ["dev", "staging"] as const;
export type RelayEnvironment = (typeof RELAY_ENVIRONMENTS)[number];

/** 判定に使う env。**ENVIRONMENT が無いことも型で許す**——未設定は「中継しない」側に倒す値である。 */
export interface ApiEnv {
  readonly ENVIRONMENT: string | undefined;
}

/** gateway を1回呼ぶ。binding と宛先（内部 origin）は adapter（src/worker/cloudflare.ts）が閉じ込める。 */
export type GatewayRelay = (request: Request) => Promise<Response>;

/**
 * 中継そのものが失敗したときの応答。**内部 origin も資格情報も載せない**（応答はインターネットへ出る）。
 * data-api の契約（appspec-schema の誤りコード）ではなく、中継層の失敗である。
 */
export const RELAY_FAILURE_STATUS = 502 as const;
export const RELAY_FAILURE_BODY = { error: "upstream unavailable" } as const;

/**
 * /api/* の入口か。`/api` だけの URL は host の run_worker_first（`/api/*`）に一致せず Static Assets が
 * 返すので、ここへは届かない。gateway への直接アクセスでは届くので、同じ範囲として扱う。
 */
export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** vars.ENVIRONMENT が中継してよい env を名乗っているか。未設定・未知の値は false（閉じる側）。 */
export function relaysApi(environment: string | undefined): boolean {
  return environment !== undefined && (RELAY_ENVIRONMENTS as readonly string[]).includes(environment);
}

// ── ログインの経路（/auth/*。M2.1。Issue #264）────────────────────────────
//
// gateway の Google OIDC のログイン・コールバック・ログアウトは **`/api` の外**にある
// （apps/gateway/src/auth.ts の /auth/login・/auth/callback・/auth/logout）。host はこれを SPA シェルに
// 落とさず gateway へ中継する——落とすと、Google の認可画面へ送れない。**env では閉じない**。

/**
 * ログインの経路の接頭辞。**wrangler.jsonc の assets.run_worker_first に入れる**——
 * そうしないと Static Assets が SPA シェルを返す（/api/* と同じ理由である）。
 */
export const AUTH_PREFIX = "/auth" as const;

/**
 * ログインの経路か。**範囲だけを見る**——`/auth` の下は gateway（apps/gateway/src/auth.ts の `isAuthPath`）が
 * 判定する（host は範囲をそのまま中継すればよい。gateway が未知の `/auth/...` を 404 にする）。
 */
export function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`);
}

/**
 * /api/* の入口。**中継してよい env でだけ**下流を呼ぶ。それ以外は下流を一度も呼ばずに 404 を返す
 * （healthz の詳細非公開と同じ「閉じる側」の倒し方で、SPA シェルの HTML も返さない）。
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  gateway: GatewayRelay,
): Promise<Response> {
  if (!relaysApi(env.ENVIRONMENT)) return json({ error: "not found" }, 404);

  try {
    // 下流の応答をそのまま返す。status・content-type・body は gateway のものに保たれる
    return await gateway(request);
  } catch (error) {
    // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。応答は外へ出る
    console.error("[host] api: gateway relay failed", error);
    return json(RELAY_FAILURE_BODY, RELAY_FAILURE_STATUS);
  }
}

/**
 * /auth/* の入口。**vars.ENVIRONMENT では閉じない**——ログインは dev / staging / production のどこでも要る
 * （production でも、自分のアプリを見るためにログインする。Issue #264 の決定）。識別も検査もしない——
 * 経路の範囲だけを見て、あとは gateway に任せる（Google の client_id が無ければ gateway が 503 で閉じる）。
 * 下流の応答（302 の Location・Set-Cookie など）はそのまま返す。中継そのものが失敗したときだけ、
 * /api/* と同じ固定の非 2xx を返す（内部 origin も資格情報も載せない）。
 */
export async function handleAuth(request: Request, gateway: GatewayRelay): Promise<Response> {
  try {
    return await gateway(request);
  } catch (error) {
    console.error("[host] auth: gateway relay failed", error);
    return json(RELAY_FAILURE_BODY, RELAY_FAILURE_STATUS);
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
