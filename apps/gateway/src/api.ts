// /api/* の中継（Issue #103）。
//
// ブラウザの API 呼出を data-api へ中継する。この file が決めるのは **中継してよいかどうか** と、
// 下流の応答をどう返すかだけである——binding をどう叩くかは adapter（src/cloudflare.ts）が
// DataApiRelay として渡す（src/healthz.ts と同じ形。CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。
//
// **認証が無い M1 の間、production の入口は /api/* で必ず 404 を返し、下流を一度も呼ばない。**
// 判定に使うのは vars.ENVIRONMENT だけである。probe の合言葉（X-Musunest-Probe）では開かない——
// あれは healthz の詳細を誰に返すかの話であって、API を開ける合言葉ではない。
//
// 応答は下流のものをそのまま返す（status・content-type・body）。**data-api の拒否（422 など）を
// 成功応答や SPA の HTML に置き換えない。** 中継そのものが失敗したときだけ、内部 origin も
// 資格情報も含まない固定の非 2xx を返す。
//
// host 側（apps/host/src/worker/api.ts）は同じ形を書き写している——host は gateway を import できない
// （infra/scripts/dep-graph.mjs で host が持てる依存は @musunest/sdk だけ）。食い違えば
// src/index.test.ts の実機（host → gateway → data-api）が落ちる。

/**
 * 中継する経路の接頭辞。**host の wrangler.jsonc の assets.run_worker_first と同じ範囲**にする
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

/** vars.ENVIRONMENT が中継してよい env を名乗っているか。未設定・未知の値は false（閉じる側）。 */
export function relaysApi(environment: string | undefined): boolean {
  return environment !== undefined && (RELAY_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * /api/* の入口。**中継してよい env でだけ**下流を呼ぶ。それ以外は下流を一度も呼ばずに 404 を返す
 * （healthz の詳細非公開と同じ「閉じる側」の倒し方で、SPA シェルの HTML も返さない）。
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  dataApi: DataApiRelay,
): Promise<Response> {
  if (!relaysApi(env.ENVIRONMENT)) return json({ error: "not found" }, 404);

  try {
    // 下流の応答をそのまま返す。status・content-type・body は data-api のものに保たれる
    return await dataApi(request);
  } catch (error) {
    // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。応答は host を経て外へ出る
    console.error("[gateway] api: data_api relay failed", error);
    return json(RELAY_FAILURE_BODY, RELAY_FAILURE_STATUS);
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
