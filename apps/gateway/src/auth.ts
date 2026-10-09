// Google OIDC のログイン・コールバック・ログアウトと、署名付きセッション cookie の判定（M2.1。Issue #263）。
//
// **Cloudflare の API に触れない。** Google との token 交換、data-api への登録、cookie の署名・検証は
// adapter（src/cloudflare.ts）が注入する（src/healthz.ts と同じ形。CLAUDE.md 不変条件「Cloudflare 固有APIは
// adapter 層に閉じ込める」）。ここが決めるのは、経路・state の照合・セッション cookie の読み書き・何を断るかだけである。
//
//   /auth/login    … Google の認可画面へ 302。state を作って cookie に持ち、query にも載せる
//   /auth/callback … state を cookie と query の両方で照合 → code を token にする → data-api に登録する
//                    → セッション cookie を返す。**state が一致しなければ断る**（CSRF。cookie も query も要る）
//   /auth/logout   … セッション cookie を消して / へ戻す
//
// 決めたこと（2026-10-08 所有者）：
//   - ログインは gateway に置く手書きの Google OIDC。**Better Auth は使わない**
//   - セッションは署名付き cookie で持ち、**要求ごとに D1 を読まない**（gateway は D1 を持たない）。
//     中身は「利用者 ID」と「期限」だけで、HMAC-SHA256 の署名で守る。secret が無ければ常に無効（閉じる側）
//   - 外から届いた識別ヘッダ（IDENTITY_HEADER）は中継の前に必ず取り除き、セッションの値だけを載せる
//     （なりすましを通さない。src/api.ts の withIdentity）
//
// この file は **Cloudflare を使わずに** 全部を試せる（src/auth.test.ts）。Google の token の応答は adapter に
// 差し込み、data-api への登録も差し替える。実物の Google との往復は、人が発行するクライアント（Issue 23）が
// 揃ってから手元で確かめる（この Issue の検証は差し込みのテストで閉じる）。

// ── 経路（**/api の外**。gateway の /api 中継は運ばない）─────────────────────

/** ログインの入口。Google の認可画面へ送る */
export const AUTH_LOGIN_PATH = "/auth/login" as const;
/** コールバック。Google が code を付けて戻す */
export const AUTH_CALLBACK_PATH = "/auth/callback" as const;
/** ログアウト。セッション cookie を消す */
export const AUTH_LOGOUT_PATH = "/auth/logout" as const;

const AUTH_PATHS: readonly string[] = [AUTH_LOGIN_PATH, AUTH_CALLBACK_PATH, AUTH_LOGOUT_PATH];

/** 認証の入口か。**`/api` の外**に置く（中継は `/api` と `/api/...` だけを運ぶ）。 */
export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.includes(pathname);
}

// ── data-api の契約（**正本は @musunest/appspec-schema の src/api.ts**）──────────────
//
// gateway が参照できるのは @musunest/data-api の契約（contract.ts）だけだが、そこは識別ヘッダの名前と
// 登録の入口の経路を再輸出していない（data-api は appspec-schema から直接読む）。だから境界の定数として
// ここに写す。**値は src/auth.test.ts が固定する**——食い違えば、gateway と data-api のテストの両方が落ちる。

/**
 * ログインした利用者を表すヘッダ。**gateway だけが付ける**——外から届いた値は取り除いてから中継する
 * （なりすましを通さない）。値は利用者 ID。正本は appspec-schema の `IDENTITY_HEADER`。
 */
export const IDENTITY_HEADER = "X-Musunest-User" as const;

/**
 * 利用者の登録の入口の経路（**`/api` の外**）。gateway が OIDC のコールバックから Service Binding 越しにだけ
 * 呼ぶ。正本は appspec-schema の `IDENTITY_LOGIN_PATH`。
 */
export const IDENTITY_LOGIN_PATH = "/identity/login" as const;

// ── cookie ──────────────────────────────────────────────────────

/** セッションの cookie 名。中身は署名付き（HMAC-SHA256）。 */
export const SESSION_COOKIE = "musunest_session" as const;
/** OAuth の state を持つ cookie 名。ログインの往復の間だけ持つ。 */
export const OAUTH_STATE_COOKIE = "musunest_oauth_state" as const;
/** セッションの寿命（秒）。 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
/** state の寿命（秒）。 */
export const OAUTH_STATE_TTL_SECONDS = 60 * 10;

const SESSION_COOKIE_PATH = "/";
const OAUTH_STATE_COOKIE_PATH = "/auth";

// ── Google OIDC ─────────────────────────────────────────────────

/** Google の認可画面（手書きの OIDC）。 */
export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth" as const;
/** 求める範囲。`openid` が無いと id_token が返らない。 */
export const GOOGLE_SCOPE = "openid email profile" as const;
/** ログイン・ログアウトの後に戻す画面。**利用者の値で外へ飛ばさない**（open redirect を作らない）。 */
export const AFTER_AUTH_PATH = "/" as const;

// ── 依存（I/O の実体は adapter が注入する）───────────────────────────

/** Google が確かめた利用者。セッションの cookie には載せず、data-api の登録にだけ使う。 */
export interface GoogleIdentity {
  readonly googleSubject: string;
  readonly displayName: string;
}

/** code を Google の token にして、利用者を取り出す（adapter が fetch する）。失敗は null。 */
export type GoogleIdentityProvider = (input: {
  readonly code: string;
  readonly redirectUri: string;
}) => Promise<GoogleIdentity | null>;

/** data-api の `/identity/login` を呼ぶ（adapter が Service Binding 越しに叩く）。失敗は null。 */
export type IdentityRegistrar = (
  registration: GoogleIdentity,
) => Promise<{ readonly userId: string } | null>;

/** 署名付きセッションの中身。**利用者 ID と期限だけ**（表示名などは載せない）。 */
export interface SessionPayload {
  readonly userId: string;
  readonly expiresAt: number;
}

/**
 * セッション cookie の署名と検証（adapter が HMAC-SHA256 で実体を作る）。
 * secret が無ければ sign は null、verify は null を返す（**閉じる側**）。
 */
export interface SessionCodec {
  sign(payload: SessionPayload): Promise<string | null>;
  verify(value: string | null): Promise<SessionPayload | null>;
}

export interface AuthDeps {
  readonly google: GoogleIdentityProvider;
  readonly dataApi: IdentityRegistrar;
  readonly session: SessionCodec;
  /** state を作る（adapter が暗号学的乱数で作る）。 */
  readonly randomState: () => string;
  /** 今の時刻（ミリ秒）。差分の判定に使う。 */
  readonly now: () => number;
}

/** ログインの設定。Google の client_id と、戻り先（callback）の URL。 */
export interface AuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
}

// ── cookie の読み書き ─────────────────────────────────────────────

/** `Cookie` ヘッダから1つの値を読む。無ければ null。値は `;` を含まない前提（cookie の規則）。 */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Set-Cookie の値。HttpOnly・Secure・SameSite=Lax で、Path だけ経路ごとに変える。 */
function setCookie(name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 消す Set-Cookie の値（Max-Age=0。Path と属性は置いたときと同じにする）。 */
function clearCookie(name: string, path: string): string {
  return `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ── 認証の入口 ────────────────────────────────────────────────────

/** 302 の応答を作る。Set-Cookie を載せるときは headers に足す。 */
function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function json(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** method が違えば 405。`Allow` に受ける method を1つ載せる。 */
function methodNotAllowed(allow: string): Response {
  const headers = new Headers({ allow, "content-type": "application/json; charset=utf-8" });
  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers });
}

/**
 * 認証の入口（/auth/*）を捌く。経路ごとの handler に振り分けるだけである。
 * **Google の設定（client_id）が空なら、どの経路も 503 で閉じる**（閉じる側に倒す）。
 */
export async function handleAuth(request: Request, config: AuthConfig, deps: AuthDeps): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (pathname === AUTH_LOGIN_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return login(config, deps);
  }
  if (pathname === AUTH_CALLBACK_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return await callback(request, config, deps);
  }
  if (pathname === AUTH_LOGOUT_PATH) {
    return logout();
  }
  return json({ error: "not found" }, 404);
}

/** ログインの入口。state を cookie（HttpOnly）と query の両方に載せ、Google の認可画面へ送る。 */
function login(config: AuthConfig, deps: AuthDeps): Response {
  if (config.clientId === "") return json({ error: "auth unavailable" }, 503);

  const state = deps.randomState();
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", state);
  return redirect(url.href, [setCookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_COOKIE_PATH, OAUTH_STATE_TTL_SECONDS)]);
}

/**
 * コールバック。**state が cookie と query の両方で一致しなければ断る**（CSRF）。
 * 一致すれば code を Google の token にし、利用者を data-api に登録し、セッション cookie を返す。
 * どの失敗も state の cookie を消す（古い state を残さない）。
 */
async function callback(request: Request, config: AuthConfig, deps: AuthDeps): Promise<Response> {
  const clearState = clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_PATH);
  if (config.clientId === "") return json({ error: "auth unavailable" }, 503, [clearState]);

  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const cookieState = readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
  if (state === null || state === "" || cookieState === null || state !== cookieState) {
    return json({ error: "invalid state" }, 400, [clearState]);
  }

  const code = params.get("code");
  if (code === null || code === "") return json({ error: "invalid request" }, 400, [clearState]);

  const identity = await deps.google({ code, redirectUri: config.redirectUri });
  if (identity === null) return json({ error: "token exchange failed" }, 502, [clearState]);

  const registered = await deps.dataApi(identity);
  if (registered === null) return json({ error: "registration failed" }, 502, [clearState]);

  const expiresAt = deps.now() + SESSION_TTL_SECONDS * 1000;
  const token = await deps.session.sign({ userId: registered.userId, expiresAt });
  if (token === null) return json({ error: "auth unavailable" }, 503, [clearState]);

  return redirect(AFTER_AUTH_PATH, [
    setCookie(SESSION_COOKIE, token, SESSION_COOKIE_PATH, SESSION_TTL_SECONDS),
    clearState,
  ]);
}

/** ログアウト。セッション cookie を消して / へ戻す（サーバーの状態は無いので、消すだけでよい）。 */
function logout(): Response {
  return redirect(AFTER_AUTH_PATH, [clearCookie(SESSION_COOKIE, SESSION_COOKIE_PATH)]);
}

/**
 * セッション cookie から利用者 ID を読む。cookie が無い・署名が合わない・期限切れは null（**閉じる側**）。
 * 中継（src/api.ts）が、この値を IDENTITY_HEADER に載せる。
 */
export async function sessionUserId(
  request: Request,
  session: SessionCodec,
  now: () => number,
): Promise<string | null> {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (value === null || value === "") return null;
  const payload = await session.verify(value);
  if (payload === null || payload.expiresAt <= now()) return null;
  return payload.userId === "" ? null : payload.userId;
}
