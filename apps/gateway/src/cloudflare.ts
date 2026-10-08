// Cloudflare の adapter。Service Binding（Fetcher）と Workers 固有の API を叩くのはこのファイルだけ。
//
// binding の型と、healthz が data-api を呼ぶ実体、/api/* を data-api へ中継する実体、
// X-Musunest-Probe を時間一定で照合する実体を置く。
// 判定と応答の形は src/healthz.ts と src/api.ts が持つ。
// **D1 / R2 / DO の binding をここに足さない**（CLAUDE.md 不変条件。src/.oxlintrc.json が型と import で落とす）。
import { HEALTHZ_PATH as DATA_API_HEALTHZ_PATH } from "@musunest/data-api";
import { IDENTITY_LOGIN_PATH } from "./auth";
import type {
  AuthDeps,
  GoogleIdentity,
  GoogleIdentityProvider,
  IdentityRegistrar,
  SessionCodec,
  SessionPayload,
} from "./auth";
import type { DataApiRelay } from "./api";
import type { DataApiHealthz, ProbeVerifier } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars、wrangler secret。名前は src/contract.ts の定数と一致させる。 */
export interface GatewayEnv {
  /** data-api への Service Binding。data-api は外部ルートを持たないので、届く経路はこれだけ（03 §1） */
  readonly DATA_API: Fetcher;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
  /** 詳細を誰に返すか（src/contract.ts の HealthzDetail）。未設定・書き違いは隠す側に倒す（src/healthz.ts） */
  readonly HEALTHZ_DETAIL?: string;
  /** wrangler secret（src/contract.ts の PROBE_TOKEN_SECRET）。wrangler.jsonc に書かない。置いていない env では無い */
  readonly MUSUNEST_PROBE_TOKEN?: string;
  /**
   * Google OIDC の client_id。**公開情報**だが、クライアント（Issue 23）がまだ無いので wrangler.jsonc に置かず、
   * deploy までに `wrangler secret put` で入れる。未設定なら認証は閉じる（/auth/* が 503。src/auth.ts）。
   */
  readonly GOOGLE_CLIENT_ID?: string;
  /** wrangler secret。Google OIDC の client secret。**リポジトリに書かない**（04 §7）。 */
  readonly GOOGLE_CLIENT_SECRET?: string;
  /** wrangler secret。セッション cookie の署名鍵（HMAC-SHA256）。**リポジトリに書かない**。 */
  readonly SESSION_SECRET?: string;
}

/**
 * Service Binding へのリクエストの origin。宛先は binding が決め、ホスト名は解決に使われない。
 * data-api が見るのはパスだけである。
 */
const DATA_API_ORIGIN = "https://data-api.internal";

export function cloudflareDataApi(env: GatewayEnv): DataApiHealthz {
  return () => env.DATA_API.fetch(new URL(DATA_API_HEALTHZ_PATH, DATA_API_ORIGIN));
}

/**
 * /api/* のリクエストを data-api へ1回中継する。**宛先は binding と固定の内部 origin が決める**——
 * 利用者の URL の origin は捨て、path と query だけを保つ（利用者の query やヘッダに外部 URL を
 * 選ばせない）。method・ヘッダ・body は元の Request のまま運び、応答はそのまま返す
 * （status・content-type・body を data-api のものに保つ）。
 */
export function cloudflareDataApiRelay(env: GatewayEnv): DataApiRelay {
  return (request) => {
    const url = new URL(request.url);
    return env.DATA_API.fetch(new Request(new URL(url.pathname + url.search, DATA_API_ORIGIN), request));
  };
}

// ── 認証（M2.1。Issue #263）─────────────────────────────────────────
//
// Google の token 交換・data-api への登録・セッション cookie の署名という **I/O の実体**をここに置く。
// 判定（経路・state の照合・何を断るか）は src/auth.ts が持つ。Cloudflare 固有の値は使わない
// ——fetch と WebCrypto だけである（`crypto.subtle.timingSafeEqual` は Workers 固有なので使わない。
// HMAC の比較は移植できる形にして、src/cloudflare.test.ts が Node でも試せるようにする）。

/** Google の token endpoint。code を id_token に交換する。 */
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** id_token の iss として許す値（Google は両方の表記を返す）。 */
const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

/**
 * Google の token 交換（手書きの OIDC）。code を token endpoint へ送り、id_token から subject と表示名を読む。
 * **token は token endpoint から TLS と client secret 越しに直接受け取る**ので署名は検証しないが、
 * aud（自分宛か）と iss（Google か）は確かめる。失敗・未設定は null（**閉じる側**）。値はログにも応答にも出さない。
 *
 * `fetchImpl` はテストが差し込む（実物は Workers / Node の fetch）。
 */
export function cloudflareGoogleIdentity(
  env: GatewayEnv,
  fetchImpl: typeof fetch = fetch,
): GoogleIdentityProvider {
  return async ({ code, redirectUri }) => {
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") {
      return null;
    }

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      console.error("[gateway] auth: google token exchange failed", error);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      console.error(`[gateway] auth: google token endpoint returned HTTP ${res.status}`);
      return null;
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error) {
      console.error("[gateway] auth: token body is not JSON", error);
      return null;
    }
    return readGoogleIdentity(raw, clientId);
  };
}

/** token endpoint の応答から id_token を読み、subject と表示名にする。読めなければ null。 */
function readGoogleIdentity(raw: unknown, clientId: string): GoogleIdentity | null {
  if (!isRecord(raw)) return null;
  const idToken = raw["id_token"];
  if (typeof idToken !== "string") return null;

  const claims = readJwtClaims(idToken);
  if (claims === null) return null;
  const issuer = claims["iss"];
  if (claims["aud"] !== clientId || typeof issuer !== "string" || !GOOGLE_ISSUERS.includes(issuer)) return null;

  const subject = claims["sub"];
  if (typeof subject !== "string" || subject === "") return null;
  const name = claims["name"];
  const email = claims["email"];
  const displayName =
    typeof name === "string" && name !== "" ? name : typeof email === "string" && email !== "" ? email : null;
  if (displayName === null) return null;
  return { googleSubject: subject, displayName };
}

/** id_token（JWT）の payload を読む。署名は見ない（token endpoint から直接受け取るため）。 */
function readJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (payload === undefined) return null;
  const json = decodeUtf8(payload);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return isRecord(raw) ? raw : null;
}

/**
 * data-api の `/identity/login` を Service Binding 越しに1回呼ぶ（gateway だけが呼ぶ入口）。
 * 失敗（届かない・非 2xx・応答が読めない）は null。文言はログにだけ出す（応答は外へ出る）。
 */
export function cloudflareIdentityRegistrar(env: GatewayEnv): IdentityRegistrar {
  return async (registration) => {
    let res: Response;
    try {
      res = await env.DATA_API.fetch(
        new Request(new URL(IDENTITY_LOGIN_PATH, DATA_API_ORIGIN), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        }),
      );
    } catch (error) {
      console.error("[gateway] auth: identity registration failed", error);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      console.error(`[gateway] auth: data-api identity login returned HTTP ${res.status}`);
      return null;
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error) {
      console.error("[gateway] auth: identity body is not JSON", error);
      return null;
    }
    if (!isRecord(raw) || typeof raw["userId"] !== "string" || raw["userId"] === "") return null;
    return { userId: raw["userId"] };
  };
}

/**
 * 署名付きセッション。`body.mac` の形で、body は `{ userId, expiresAt }` の JSON を base64url にしたもの、
 * mac は secret を鍵にした HMAC-SHA256 の base64url である。**secret が無ければ sign も verify も閉じる**。
 * 比較は移植できる形（長さを先に弾いてから XOR）にして、Node で動く src/cloudflare.test.ts で試せるようにする。
 */
export function cloudflareSession(env: GatewayEnv): SessionCodec {
  return {
    async sign(payload: SessionPayload): Promise<string | null> {
      const secret = env.SESSION_SECRET;
      if (secret === undefined || secret === "") return null;
      const body = encodeUtf8(JSON.stringify(payload));
      const mac = new Uint8Array(await hmac(secret, body));
      return `${body}.${base64urlEncode(mac)}`;
    },
    async verify(value: string | null): Promise<SessionPayload | null> {
      const secret = env.SESSION_SECRET;
      if (secret === undefined || secret === "" || value === null) return null;
      const dot = value.indexOf(".");
      if (dot <= 0 || value.indexOf(".", dot + 1) >= 0) return null;

      const body = value.slice(0, dot);
      const presented = base64urlDecode(value.slice(dot + 1));
      if (presented === null) return null;
      const expected = new Uint8Array(await hmac(secret, body));
      if (!timingSafeEqual(expected, presented)) return null;

      const json = decodeUtf8(body);
      if (json === null) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        return null;
      }
      if (!isRecord(raw) || typeof raw["userId"] !== "string" || raw["userId"] === "") return null;
      if (typeof raw["expiresAt"] !== "number") return null;
      return { userId: raw["userId"], expiresAt: raw["expiresAt"] };
    },
  };
}

/** index.ts が使う束。Google の token 交換・data-api への登録・セッションの実体を adapter としてまとめる。 */
export function cloudflareAuthDeps(env: GatewayEnv): AuthDeps {
  return {
    google: cloudflareGoogleIdentity(env),
    dataApi: cloudflareIdentityRegistrar(env),
    session: cloudflareSession(env),
    randomState: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return await crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

/** 時間一定の比較（移植できる形）。長さの違いは先に弾く（HMAC の長さは秘密ではない）。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array | null {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function encodeUtf8(value: string): string {
  return base64urlEncode(encoder.encode(value));
}

function decodeUtf8(value: string): string | null {
  const bytes = base64urlDecode(value);
  return bytes === null ? null : decoder.decode(bytes);
}

/**
 * X-Musunest-Probe の値を secret MUSUNEST_PROBE_TOKEN と時間一定で比べる。
 * 両方を SHA-256 にしてから crypto.subtle.timingSafeEqual（Workers 固有）で比べるので、長さの違いも時間に出ない。
 * secret が無い・空なら常に false（閉じる側に倒す）。値は応答にもログにも出さない。
 */
export function cloudflareProbe(env: GatewayEnv): ProbeVerifier {
  return async (presented) => {
    const secret = env.MUSUNEST_PROBE_TOKEN;
    if (secret === undefined || secret === "" || presented === null) return false;
    const [actual, expected] = await Promise.all([sha256(presented), sha256(secret)]);
    return crypto.subtle.timingSafeEqual(actual, expected);
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}
