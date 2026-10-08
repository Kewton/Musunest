// adapter（Service Binding）を、Cloudflare を使わずに確かめる（Issue #103 の受入試験）。
//
// ここで測るのは **/api/* の宛先がどう決まるか** である——利用者の URL の origin を捨て、
// binding と固定の内部 origin に置き換える。**利用者の query やヘッダで外部 URL を選ばせない**のが要である
// （外部 URL を選べると、中継が任意の送信先を叩く口になる）。path・query・method・ヘッダ・body はそのまま運ぶ。
// 実機（workerd の Service Binding 越しの data-api）での疎通は src/index.test.ts が見る。
import { describe, expect, it } from "vitest";
import {
  cloudflareDataApiRelay,
  cloudflareGoogleIdentity,
  cloudflareIdentityRegistrar,
  cloudflareSession,
} from "./cloudflare.js";
import type { GatewayEnv } from "./cloudflare.js";
import { IDENTITY_LOGIN_PATH } from "./auth.js";

/** data-api へのリクエストの origin（src/cloudflare.ts の DATA_API_ORIGIN）。host 名は解決に使われない */
const DATA_API_ORIGIN = "https://data-api.internal";

/** Service Binding の代わり。**渡された Request を記録する**（呼出回数と内容を照合する） */
function binding(respond: (request: Request) => Response = () => Response.json({ ok: true })): {
  readonly env: GatewayEnv;
  readonly calls: Request[];
} {
  const calls: Request[] = [];
  const fetcher = {
    fetch: async (input: Request) => {
      calls.push(input);
      return respond(input);
    },
  } as unknown as Fetcher;
  return { calls, env: { DATA_API: fetcher, ENVIRONMENT: "dev", GIT_SHA: "test" } satisfies GatewayEnv };
}

/** 記録した Request の1つ（noUncheckedIndexedAccess の下では calls[0] が undefined になり得るため） */
function sentTo(calls: readonly Request[], index = 0): Request {
  const request = calls[index];
  if (request === undefined) throw new Error(`下流が ${index + 1} 回以上呼ばれていない`);
  return request;
}

describe("cloudflareDataApiRelay（/api/* の宛先）", () => {
  it("宛先の origin を固定の内部 origin に置き換える", async () => {
    const { env, calls } = binding();
    await cloudflareDataApiRelay(env)(new Request("https://musunest-dev-gateway.example/api/instances/i/spec"));

    expect(calls).toHaveLength(1);
    const sent = new URL(sentTo(calls).url);
    expect(sent.origin).toBe(DATA_API_ORIGIN);
    expect(sent.pathname).toBe("/api/instances/i/spec");
  });

  it("利用者の URL の origin では宛先を選べない（別のホスト名でも binding の宛先へ行く）", async () => {
    const { env, calls } = binding();
    await cloudflareDataApiRelay(env)(new Request("https://evil.example/api/instances/i/spec"));

    expect(new URL(sentTo(calls).url).origin).toBe(DATA_API_ORIGIN);
    expect(sentTo(calls).url).not.toContain("evil.example");
  });

  it("query をそのまま運ぶ（query に URL を書いても宛先は変わらない）", async () => {
    const { env, calls } = binding();
    await cloudflareDataApiRelay(env)(
      new Request("https://musunest-dev-gateway.example/api/instances/i/views/v?page=2&target=https%3A%2F%2Fevil.example"),
    );

    const sent = new URL(sentTo(calls).url);
    expect(sent.origin).toBe(DATA_API_ORIGIN);
    expect(sent.search).toBe("?page=2&target=https%3A%2F%2Fevil.example");
  });

  it("method・ヘッダ・body をそのまま運ぶ", async () => {
    const { env, calls } = binding();
    const body = JSON.stringify({ description: "夕食", amount: 6600 });
    await cloudflareDataApiRelay(env)(
      new Request("https://musunest-dev-gateway.example/api/instances/i/actions/addExpense", {
        method: "POST",
        headers: { "content-type": "application/json", "x-musunest-probe": "probe-value" },
        body,
      }),
    );

    const sent = sentTo(calls);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("x-musunest-probe")).toBe("probe-value");
    expect(await sent.text()).toBe(body);
  });

  it("下流の応答をそのまま返す（status・content-type・body を組み替えない）", async () => {
    const rejected = { error: "INPUT_REJECTED", fields: ["amount"], validations: [] };
    const { env } = binding(() => Response.json(rejected, { status: 422 }));
    const res = await cloudflareDataApiRelay(env)(new Request("https://musunest-dev-gateway.example/api/instances/i/spec"));

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(rejected);
  });

  it("binding はリクエスト1つにつき1回だけ呼ばれる", async () => {
    const { env, calls } = binding();
    const relay = cloudflareDataApiRelay(env);
    await relay(new Request("https://musunest-dev-gateway.example/api/instances/i/spec"));
    await relay(new Request("https://musunest-dev-gateway.example/api/instances/i/views/v"));
    expect(calls).toHaveLength(2);
  });
});

// ── 認証の adapter（M2.1。Issue #263）───────────────────────────────
//
// Google の token の応答の読み方、data-api への登録、セッション cookie の署名を、Cloudflare を使わずに
// 確かめる。**この file は Node（vitest）で走る**ので、HMAC の比較は移植できる形にしてある
// （crypto.subtle.timingSafeEqual のような Workers 固有の API を使うと、ここで落ちる）。

/** 差し込む Google の token の応答（id_token を持つ JSON）を返す fetch。 */
function tokenFetch(claims: Record<string, unknown>, init: ResponseInit = {}): typeof fetch {
  const idToken = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.signature`;
  return (async () =>
    Response.json({ access_token: "at", id_token: idToken, token_type: "Bearer", expires_in: 3600 }, init)) as unknown as typeof fetch;
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const CLIENT_ID = "gateway-client-id.apps.googleusercontent.com";
const GOOGLE_ENV: Partial<GatewayEnv> = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "client-secret" };

/** 記録用の DATA_API を持つ env に、認証の設定を足す。 */
const withEnv = (extra: Partial<GatewayEnv>): GatewayEnv => ({ ...binding().env, ...extra });

describe("cloudflareGoogleIdentity（Google の token の応答の読み方）", () => {
  it("id_token から subject と表示名を読む（aud は自分・iss は Google）", async () => {
    const identity = await cloudflareGoogleIdentity(
      withEnv(GOOGLE_ENV),
      tokenFetch({ aud: CLIENT_ID, iss: "https://accounts.google.com", sub: "sub-a", name: "Aさん" }),
    )({ code: "code", redirectUri: "https://gateway.example/auth/callback" });

    expect(identity).toEqual({ googleSubject: "sub-a", displayName: "Aさん" });
  });

  it("aud が自分でなければ null（他人宛の token を使わない）", async () => {
    const identity = await cloudflareGoogleIdentity(
      withEnv(GOOGLE_ENV),
      tokenFetch({ aud: "other-client", iss: "https://accounts.google.com", sub: "sub-a", name: "A" }),
    )({ code: "code", redirectUri: "https://gateway.example/auth/callback" });
    expect(identity).toBeNull();
  });

  it("iss が Google でなければ null", async () => {
    const identity = await cloudflareGoogleIdentity(
      withEnv(GOOGLE_ENV),
      tokenFetch({ aud: CLIENT_ID, iss: "https://evil.example", sub: "sub-a", name: "A" }),
    )({ code: "code", redirectUri: "https://gateway.example/auth/callback" });
    expect(identity).toBeNull();
  });

  it("name が無ければ email を表示名にする", async () => {
    const identity = await cloudflareGoogleIdentity(
      withEnv(GOOGLE_ENV),
      tokenFetch({ aud: CLIENT_ID, iss: "accounts.google.com", sub: "sub-a", email: "a@example.com" }),
    )({ code: "code", redirectUri: "https://gateway.example/auth/callback" });
    expect(identity).toEqual({ googleSubject: "sub-a", displayName: "a@example.com" });
  });

  it.each([
    ["HTTP 400", () => tokenFetch({}, { status: 400 })],
    ["JSON でない本文", () => (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch],
    ["id_token が無い", () => (async () => Response.json({ access_token: "at" })) as unknown as typeof fetch],
    ["sub が無い", () => tokenFetch({ aud: CLIENT_ID, iss: "accounts.google.com", name: "A" })],
    ["name も email も無い", () => tokenFetch({ aud: CLIENT_ID, iss: "accounts.google.com", sub: "sub-a" })],
  ] satisfies [string, () => typeof fetch][])("%s なら null（閉じる側）", async (_, makeFetch) => {
    const identity = await cloudflareGoogleIdentity(withEnv(GOOGLE_ENV), makeFetch())({
      code: "code",
      redirectUri: "https://gateway.example/auth/callback",
    });
    expect(identity).toBeNull();
  });

  it("client secret が無ければ、fetch を呼ばずに null", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    const identity = await cloudflareGoogleIdentity(
      withEnv({ GOOGLE_CLIENT_ID: CLIENT_ID }),
      fetchImpl,
    )({ code: "code", redirectUri: "https://gateway.example/auth/callback" });

    expect(identity).toBeNull();
    expect(called).toBe(0);
  });
});

describe("cloudflareIdentityRegistrar（data-api への登録）", () => {
  it("IDENTITY_LOGIN_PATH へ POST し、subject と表示名を送り、userId を返す", async () => {
    const { env, calls } = binding(() => Response.json({ userId: "u-a", communityId: "c-a" }));

    const registered = await cloudflareIdentityRegistrar(env)({ googleSubject: "sub-a", displayName: "Aさん" });

    expect(registered).toEqual({ userId: "u-a" });
    const sent = sentTo(calls);
    expect(new URL(sent.url).pathname).toBe(IDENTITY_LOGIN_PATH);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.json()).toEqual({ googleSubject: "sub-a", displayName: "Aさん" });
  });

  it.each([
    ["非 2xx", () => Response.json({ error: "SPEC_UNAVAILABLE" }, { status: 503 })],
    ["JSON でない本文", () => new Response("<html>", { status: 200 })],
    ["userId が無い", () => Response.json({ communityId: "c-a" })],
    ["userId が空", () => Response.json({ userId: "" })],
  ] satisfies [string, () => Response][])("%s なら null（登録できなかったことにする）", async (_, respond) => {
    const { env } = binding(respond);
    expect(await cloudflareIdentityRegistrar(env)({ googleSubject: "sub-a", displayName: "A" })).toBeNull();
  });
});

describe("cloudflareSession（署名付きセッション）", () => {
  const session = (secret: string | undefined) =>
    cloudflareSession(secret === undefined ? withEnv({}) : withEnv({ SESSION_SECRET: secret }));

  it("sign した値を verify すると、同じ中身に戻る", async () => {
    const codec = session("secret-0123456789");
    const token = await codec.sign({ userId: "u-a", expiresAt: 12345 });
    expect(token).not.toBeNull();
    expect(await codec.verify(token)).toEqual({ userId: "u-a", expiresAt: 12345 });
  });

  it("中身を書き換えると署名が合わず null", async () => {
    const codec = session("secret-0123456789");
    const token = (await codec.sign({ userId: "u-a", expiresAt: 12345 })) ?? "";
    const [body = "", mac = ""] = token.split(".");
    const tampered = `${base64url(JSON.stringify({ userId: "u-b", expiresAt: 12345 }))}.${mac}`;
    expect(body).not.toBe("");
    expect(await codec.verify(tampered)).toBeNull();
  });

  it("別の secret では verify できない", async () => {
    const token = await session("secret-one-0123456").sign({ userId: "u-a", expiresAt: 12345 });
    expect(await session("secret-two-0123456").verify(token)).toBeNull();
  });

  it.each([[undefined], [""]])("secret が無ければ sign は null、verify も null（閉じる側）", async (secret) => {
    const codec = session(secret);
    expect(await codec.sign({ userId: "u-a", expiresAt: 12345 })).toBeNull();
    expect(await codec.verify("body.mac")).toBeNull();
  });

  it.each([["形式が違う", "no-dot-here"], ["区切りが多い", "a.b.c"], ["mac が空", "body."], ["body が空", ".mac"]])(
    "形式が壊れている（%s）と null",
    async (_, value) => {
      expect(await session("secret-0123456789").verify(value)).toBeNull();
    },
  );
});
