// Google OIDC のログイン・コールバック・ログアウトと、署名付きセッションの判定を、**Cloudflare を使わずに**
// 確かめる（M2.1。Issue #263 の受入試験）。
//
// 見るのは5つである。
//   1. ログインは Google の認可画面へ 302 し、state を cookie と query の両方に載せる
//   2. **Google の token の応答を差し込むと**、コールバックが利用者を data-api に登録し、
//      検証できるセッション cookie を返す（受入条件）
//   3. **state が一致しないコールバックは 400 で断る**（cookie も query も要る。CSRF。受入条件）
//   4. ログアウトはセッション cookie を消す。client_id が無ければ認証は 503 で閉じる
//   5. セッション cookie の読み方（sessionUserId）。署名違い・期限切れ・cookie 無しは null（閉じる側）
//
// 実物の Google との往復は、人が発行するクライアント（Issue 23）が揃ってから手元で確かめる。
// ここでは token endpoint を差し替え、data-api への登録も差し替える。
import { describe, expect, it } from "vitest";
import {
  AUTH_CALLBACK_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  GOOGLE_AUTHORIZE_ENDPOINT,
  IDENTITY_HEADER,
  IDENTITY_LOGIN_PATH,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  handleAuth,
  isAuthPath,
  sessionUserId,
} from "./auth.js";
import type { AuthConfig, AuthDeps, GoogleIdentity } from "./auth.js";
import { cloudflareGoogleIdentity, cloudflareSession } from "./cloudflare.js";
import type { GatewayEnv } from "./cloudflare.js";

const ORIGIN = "https://musunest-dev-gateway.example";
const CLIENT_ID = "gateway-client-id.apps.googleusercontent.com";
const REDIRECT_URI = `${ORIGIN}${AUTH_CALLBACK_PATH}`;
const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const CLIENT_SECRET = "test-client-secret";

const CONFIG: AuthConfig = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI };
const OK_IDENTITY: GoogleIdentity = { googleSubject: "google-sub-a", displayName: "Aさん" };

/** adapter に渡す env。この file は Service Binding を叩かないので DATA_API は使わない。 */
function gatewayEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return { DATA_API: {} as Fetcher, ENVIRONMENT: "dev", GIT_SHA: "test", ...overrides };
}

/** 応答の Set-Cookie を配列で読む。Node の Headers（getSetCookie）で試す。 */
const setCookies = (res: Response): readonly string[] =>
  (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();

/** Set-Cookie の1つを名前で選ぶ（見つからなければ null）。 */
function namedCookie(cookies: readonly string[], name: string): string | null {
  const prefix = `${name}=`;
  return cookies.find((cookie) => cookie.startsWith(prefix)) ?? null;
}

/** Set-Cookie の値だけを取り出す（`name=value; Path=...` の value）。 */
function cookieValue(cookie: string): string {
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";");
  return cookie.slice(eq + 1, semi < 0 ? undefined : semi);
}

/** cookie を付けない呼び出し。 */
const requestTo = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, { headers });

/** コールバックの要求。query の state・code と、cookie の state を別々に指定できる。 */
function callbackRequest(queryState: string | null, code: string | null, cookieState: string | null): Request {
  const url = new URL(`${ORIGIN}${AUTH_CALLBACK_PATH}`);
  if (queryState !== null) url.searchParams.set("state", queryState);
  if (code !== null) url.searchParams.set("code", code);
  const headers = new Headers();
  if (cookieState !== null) headers.set("cookie", `${OAUTH_STATE_COOKIE}=${cookieState}`);
  return new Request(url, { headers });
}

/** 呼ばれた登録を記録する data-api の代わり。 */
function registrar(returned: { readonly userId: string } | null = { userId: "u-a" }): AuthDeps["dataApi"] & {
  readonly calls: GoogleIdentity[];
} {
  const calls: GoogleIdentity[] = [];
  return Object.assign(
    async (registration: GoogleIdentity) => {
      calls.push(registration);
      return returned;
    },
    { calls },
  );
}

/** 呼ばれたかを見る Google の代わり（state の検査で止まることを確かめる）。 */
function googleProvider(identity: GoogleIdentity | null = OK_IDENTITY): AuthDeps["google"] & {
  readonly calls: { readonly code: string; readonly redirectUri: string }[];
} {
  const calls: { code: string; redirectUri: string }[] = [];
  return Object.assign(
    async (input: { readonly code: string; readonly redirectUri: string }) => {
      calls.push(input);
      return identity;
    },
    { calls },
  );
}

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    google: googleProvider(),
    dataApi: registrar(),
    session: cloudflareSession(gatewayEnv({ SESSION_SECRET })),
    randomState: () => "state-1",
    now: () => NOW,
    ...overrides,
  };
}

/** 差し込む Google の token の応答（id_token を持つ JSON）を返す fetch。 */
function tokenFetch(claims: Record<string, unknown>): typeof fetch {
  const idToken = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.signature`;
  return (async () =>
    Response.json({ access_token: "access-token", id_token: idToken, token_type: "Bearer", expires_in: 3600 })) as unknown as typeof fetch;
}

/** JSON を base64url にする（テストの id_token を組むため。adapter の実装とは別に持つ）。 */
function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("isAuthPath（認証の入口）", () => {
  it("認証の経路は /auth/login・/auth/callback・/auth/logout だけ（**/api の外**）", () => {
    for (const path of [AUTH_LOGIN_PATH, AUTH_CALLBACK_PATH, AUTH_LOGOUT_PATH]) {
      expect(isAuthPath(path)).toBe(true);
      expect(path.startsWith("/api")).toBe(false);
    }
    for (const other of ["/api", "/api/me/instances", "/auth", "/auth/login/extra", "/healthz", IDENTITY_LOGIN_PATH]) {
      expect(isAuthPath(other), other).toBe(false);
    }
  });

  it("識別ヘッダと登録の入口の値は appspec-schema と一致する（正本は appspec-schema の src/api.ts）", () => {
    expect(IDENTITY_HEADER).toBe("X-Musunest-User");
    expect(IDENTITY_LOGIN_PATH).toBe("/identity/login");
  });
});

describe("ログインの入口（/auth/login）", () => {
  it("Google の認可画面へ 302 し、state を cookie と query の両方に載せる", async () => {
    const res = await handleAuth(requestTo(AUTH_LOGIN_PATH), CONFIG, deps({ randomState: () => "the-state" }));

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location ?? ORIGIN);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("state")).toBe("the-state");

    const cookie = namedCookie(setCookies(res), OAUTH_STATE_COOKIE);
    expect(cookie).not.toBeNull();
    expect(cookieValue(cookie ?? "")).toBe("the-state");
    expect(cookie).toMatch(/HttpOnly/);
  });

  it("client_id が無ければ 503 で閉じる（認証は設定されるまで閉じる側）", async () => {
    const res = await handleAuth(requestTo(AUTH_LOGIN_PATH), { clientId: "", redirectUri: REDIRECT_URI }, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth unavailable" });
  });
});

describe("コールバック（/auth/callback）", () => {
  it("Google の token の応答を差し込むと、利用者を data-api に登録し、検証できるセッション cookie を返す", async () => {
    const env = gatewayEnv({
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
    });
    // **token の応答を差し込む**。id_token を持ち、aud は自分、iss は Google
    const google = cloudflareGoogleIdentity(
      env,
      tokenFetch({ aud: CLIENT_ID, iss: "https://accounts.google.com", sub: "google-sub-a", name: "Aさん" }),
    );
    const dataApi = registrar({ userId: "u-a" });
    const session = cloudflareSession(env);

    const res = await handleAuth(callbackRequest("state-1", "code-1", "state-1"), CONFIG, {
      google,
      dataApi,
      session,
      randomState: () => "state-1",
      now: () => NOW,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    // data-api に Google の subject と表示名で登録している
    expect(dataApi.calls).toEqual([{ googleSubject: "google-sub-a", displayName: "Aさん" }]);

    // セッション cookie を返し、その値は利用者 ID に戻せる（署名も期限も正しい）
    const cookie = namedCookie(setCookies(res), SESSION_COOKIE);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(await session.verify(cookieValue(cookie ?? ""))).toEqual({
      userId: "u-a",
      expiresAt: NOW + SESSION_TTL_SECONDS * 1000,
    });
  });

  it("state が一致しないコールバックは 400 で断り、登録も Google への往復もしない", async () => {
    const google = googleProvider();
    const dataApi = registrar();
    const d = deps({ google, dataApi });

    const cases = [
      ["別の値", "query-state", "cookie-state"],
      ["query が無い", null, "cookie-state"],
      ["cookie が無い", "query-state", null],
      ["query が空", "", "cookie-state"],
    ] as const;
    for (const [label, queryState, cookieState] of cases) {
      const res = await handleAuth(callbackRequest(queryState, "code-1", cookieState), CONFIG, d);
      expect(res.status, label).toBe(400);
      expect(await res.json(), label).toEqual({ error: "invalid state" });
    }
    expect(google.calls).toEqual([]);
    expect(dataApi.calls).toEqual([]);
  });

  it("state は一致しても code が無ければ 400（Google へも data-api へも進まない）", async () => {
    const google = googleProvider();
    const dataApi = registrar();
    const res = await handleAuth(callbackRequest("s", null, "s"), CONFIG, deps({ google, dataApi }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request" });
    expect(google.calls).toEqual([]);
    expect(dataApi.calls).toEqual([]);
  });

  it("token の交換に失敗したら 502 で、登録しない", async () => {
    const dataApi = registrar();
    const res = await handleAuth(
      callbackRequest("s", "code", "s"),
      CONFIG,
      deps({ google: googleProvider(null), dataApi }),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "token exchange failed" });
    expect(dataApi.calls).toEqual([]);
  });

  it("data-api への登録に失敗したら 502 で、セッション cookie を出さない", async () => {
    const res = await handleAuth(
      callbackRequest("s", "code", "s"),
      CONFIG,
      deps({ dataApi: registrar(null) }),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "registration failed" });
    expect(namedCookie(setCookies(res), SESSION_COOKIE)).toBeNull();
  });

  it("error の応答でも state の cookie を消す（古い state を残さない）", async () => {
    const res = await handleAuth(callbackRequest("other", "code", "cookie"), CONFIG, deps());
    const cookie = namedCookie(setCookies(res), OAUTH_STATE_COOKIE);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("ログアウト（/auth/logout）", () => {
  it("セッション cookie を消して / へ戻す", async () => {
    const res = await handleAuth(requestTo(AUTH_LOGOUT_PATH), CONFIG, deps());

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = namedCookie(setCookies(res), SESSION_COOKIE);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("sessionUserId（セッションの読み方）", () => {
  const session = cloudflareSession(gatewayEnv({ SESSION_SECRET }));
  const withCookie = (value: string): Request =>
    new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${value}` } });

  it("署名が正しく期限内なら利用者 ID を返す", async () => {
    const token = await session.sign({ userId: "u-a", expiresAt: NOW + 1000 });
    expect(token).not.toBeNull();
    expect(await sessionUserId(withCookie(token ?? ""), session, () => NOW)).toBe("u-a");
  });

  it("期限切れは null（閉じる側）", async () => {
    const token = await session.sign({ userId: "u-a", expiresAt: NOW - 1 });
    expect(await sessionUserId(withCookie(token ?? ""), session, () => NOW)).toBeNull();
  });

  it("署名が違えば null", async () => {
    const token = await session.sign({ userId: "u-a", expiresAt: NOW + 1000 });
    const tampered = `${token ?? ""}x`;
    expect(await sessionUserId(withCookie(tampered), session, () => NOW)).toBeNull();
  });

  it("cookie が無ければ null", async () => {
    expect(await sessionUserId(new Request(ORIGIN), session, () => NOW)).toBeNull();
  });

  it("SESSION_SECRET が無ければ、正しい署名でも null（閉じる側）", async () => {
    const unsigned = cloudflareSession(gatewayEnv());
    expect(await sessionUserId(withCookie("whatever"), unsigned, () => NOW)).toBeNull();
  });
});
