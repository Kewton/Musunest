// /api/* の中継（Issue #103）。
//
// ブラウザの API 呼出を data-api へ中継する。この file が決めるのは **中継してよいかどうか** と、
// 下流の応答をどう返すかだけである——binding をどう叩くかは adapter（src/cloudflare.ts）が
// DataApiRelay として渡す（src/healthz.ts と同じ形。CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。
//
// **判定に使うのは vars.ENVIRONMENT と、セッションが示す利用者 ID だけである。**
//   - dev / staging … ログインの有無によらず中継する（M1 のまま。決定 2026-10-08）
//   - production    … **ログインした利用者だけ**中継する（M2.1。Issue #265）。ログインしていない要求は
//                     下流を一度も呼ばずに 401 UNAUTHENTICATED で断る（data-api の契約と同じ応答）
//   - 未設定・未知の値 … 中継せず、下流を一度も呼ばずに 404（閉じる側）
// probe の合言葉（X-Musunest-Probe）では開かない——あれは healthz の詳細を誰に返すかの話であって、
// API を開ける合言葉ではない。
//
// 応答は下流のものをそのまま返す（status・content-type・body）。**data-api の拒否（422 など）を
// 成功応答や SPA の HTML に置き換えない。** 中継そのものが失敗したときだけ、内部 origin も
// 資格情報も含まない固定の非 2xx を返す。
//
// host 側（apps/host/src/worker/api.ts）は同じ形を書き写している——host は gateway を import できない
// （infra/scripts/dep-graph.mjs で host が持てる依存は @musunest/sdk だけ）。食い違えば
// src/index.test.ts の実機（host → gateway → data-api）が落ちる。
//
// M2.1（Issue #263）で、中継の前に**識別ヘッダの付け替え**が入った（withIdentity）。
// 外から届いた IDENTITY_HEADER は必ず取り除き、セッションが示す利用者 ID だけを載せる
// ——利用者の値でなりすませない。M2.1（Issue #265）で、production の入口に**ログインの検査**が入り、
// ログインしていない要求は下流へ渡さない。ここは Cloudflare を使わないので、src/api.test.ts が見る。
import { API_ERROR_STATUS, apiErrorBody } from "@musunest/data-api";
import { IDENTITY_HEADER } from "./auth";

/**
 * 中継する経路の接頭辞。**host の wrangler.jsonc の assets.run_worker_first と同じ範囲**にする
 * （/api/* は M2 ではなく今、gateway へ中継する。SPA シェルの HTML を API の応答にしない）。
 */
export const API_PREFIX = "/api" as const;

/**
 * **ログイン無しで**中継してよい vars.ENVIRONMENT の値。**dev と staging だけ**である
 * ——M1 の間の開け方をそのまま残し、全環境にログインをそろえるのは M2.3（決定 2026-10-08）。
 */
export const RELAY_ENVIRONMENTS = ["dev", "staging"] as const;
export type RelayEnvironment = (typeof RELAY_ENVIRONMENTS)[number];

/**
 * **ログインした利用者にだけ**中継する vars.ENVIRONMENT の値。**production だけ**である（M2.1。Issue #265）。
 * production が本番のデータに届く入口を、宣言ではなくこの分岐1か所のログインの検査で開ける（00 Q5）。
 */
export const LOGIN_REQUIRED_ENVIRONMENTS = ["production"] as const;
export type LoginRequiredEnvironment = (typeof LOGIN_REQUIRED_ENVIRONMENTS)[number];

/** 判定に使う env。**ENVIRONMENT が無いことも型で許す**——未設定は「中継しない」側に倒す値である。 */
export interface ApiEnv {
  readonly ENVIRONMENT: string | undefined;
}

/** data-api を1回呼ぶ。binding と宛先（内部 origin）は adapter（src/cloudflare.ts）が閉じ込める。 */
export type DataApiRelay = (request: Request) => Promise<Response>;

/**
 * 中継そのものが失敗したときの応答。**内部 origin も資格情報も載せない**（応答は外へ出る）。
 * data-api の契約（appspec-schema の誤りコード）ではなく、中継層の失敗である。
 */
export const RELAY_FAILURE_STATUS = 502 as const;
export const RELAY_FAILURE_BODY = { error: "upstream unavailable" } as const;

/**
 * /api/* の入口か。`/api` だけの URL も API の入口として数える（host の run_worker_first は
 * `/api/*` なので host には届かないが、gateway への直接アクセスは届く）。
 */
export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** vars.ENVIRONMENT が**ログイン無しで**中継してよい env を名乗っているか。未設定・未知の値は false（閉じる側）。 */
export function relaysApi(environment: string | undefined): boolean {
  return environment !== undefined && (RELAY_ENVIRONMENTS as readonly string[]).includes(environment);
}

/** vars.ENVIRONMENT が**ログインした利用者にだけ**中継する env を名乗っているか。未設定・未知の値は false。 */
export function requiresLogin(environment: string | undefined): boolean {
  return environment !== undefined && (LOGIN_REQUIRED_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * /api/* の要求をどう扱うか。**env と、セッションが示す利用者 ID の両方**で決まる。
 *   "relay"           … 下流へ中継する
 *   "unauthenticated" … ログインを要する env（production）でログインしていない。**下流を呼ばずに 401**
 *   "closed"          … 中継しない env（未設定・未知の値）。**下流を呼ばずに 404**
 */
export type ApiAccess = "relay" | "unauthenticated" | "closed";

export function apiAccess(environment: string | undefined, userId: string | null): ApiAccess {
  if (relaysApi(environment)) return "relay";
  if (!requiresLogin(environment)) return "closed";
  return userId === null || userId === "" ? "unauthenticated" : "relay";
}

/**
 * /api/* の入口。**中継してよいと決まったときだけ**下流を呼ぶ。そうでなければ下流を一度も呼ばずに断る
 * ——未設定・未知の値は 404、ログインを要する env（production）でログインしていなければ 401
 * （healthz の詳細非公開と同じ「閉じる側」の倒し方で、SPA シェルの HTML も返さない）。
 *
 * `userId` はセッションが示す利用者 ID（ログインしていなければ null。判定は src/auth.ts の
 * sessionUserId）。中継の前に withIdentity で**識別ヘッダを付け替える**。
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  dataApi: DataApiRelay,
  userId: string | null = null,
): Promise<Response> {
  const access = apiAccess(env.ENVIRONMENT, userId);
  // 中継しない env（未設定・未知の値）は、下流を一度も呼ばずに 404（従来どおり。SPA シェルの HTML も返さない）
  if (access === "closed") return json({ error: "not found" }, 404);
  // ログインを要する env（production）でログインしていない要求は、下流を一度も呼ばずに 401。
  // 本文と status は data-api の契約（UNAUTHENTICATED）と同じ——クライアントは gateway が断ったのか
  // data-api が断ったのかを見分けられない（SDK はどちらも 401 として扱う）
  if (access === "unauthenticated") {
    return json(apiErrorBody("UNAUTHENTICATED"), API_ERROR_STATUS.UNAUTHENTICATED);
  }

  try {
    // 下流の応答をそのまま返す。status・content-type・body は data-api のものに保たれる
    return await dataApi(withIdentity(request, userId));
  } catch (error) {
    // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。応答は host を経て外へ出る
    console.error("[gateway] api: data_api relay failed", error);
    return json(RELAY_FAILURE_BODY, RELAY_FAILURE_STATUS);
  }
}

/**
 * 中継する Request を作る。**外から届いた識別ヘッダは必ず取り除く**——gateway がセッションから決めた
 * 利用者 ID だけを載せる（`userId` が null ならヘッダそのものを載せない）。外からの値で利用者を
 * 名乗れない（なりすましを通さない。data-api は識別ヘッダの無い一覧を 401 で断る）。
 */
export function withIdentity(request: Request, userId: string | null): Request {
  const headers = new Headers(request.headers);
  headers.delete(IDENTITY_HEADER);
  if (userId !== null && userId !== "") headers.set(IDENTITY_HEADER, userId);
  return new Request(request, { headers });
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
