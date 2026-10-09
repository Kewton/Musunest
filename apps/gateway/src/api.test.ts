// /api/* の中継の判定と作法を、Cloudflare を使わずに確かめる（Issue #103 の受入試験）。
// 実機（workerd の Service Binding 越しの data-api）での疎通は src/index.test.ts が見る。
//
// ここで測るのは5つである。
//   1. vars.ENVIRONMENT 未設定・未知の値では、6 method のどれでも 404 になり、**下流は一度も呼ばれない**
//   2. production では、ログインしていない要求が 6 method のどれでも 401 UNAUTHENTICATED になり、
//      **下流は一度も呼ばれない**。ログインした利用者の要求だけが、識別を付けて中継される（M2.1。Issue #265）
//   3. dev / staging では、method・path・query・ヘッダ・body がそのまま下流へ届く
//   4. 下流の応答は status・content-type・body ごと保たれる（422 を 200 の HTML に化けさせない）
//   5. 中継そのものの失敗は非 2xx になり、内部 origin も資格情報も応答に載らない
// X-Musunest-Probe を付けても同じ——API を開ける合言葉にしない。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PREFIX,
  apiAccess,
  handleApi,
  isApiPath,
  LOGIN_REQUIRED_ENVIRONMENTS,
  RELAY_ENVIRONMENTS,
  RELAY_FAILURE_BODY,
  RELAY_FAILURE_STATUS,
  relaysApi,
  requiresLogin,
} from "./api.js";
import type { ApiEnv, DataApiRelay } from "./api.js";
import { IDENTITY_HEADER } from "./auth.js";

const GATEWAY_ORIGIN = "https://musunest-dev-gateway.example";
const PROBE_HEADER = "X-Musunest-Probe";

const apiRequest = (path: string, init?: RequestInit): Request => new Request(`${GATEWAY_ORIGIN}${path}`, init);

/**
 * 下流（data-api）の代わり。**呼ばれた Request を記録する**ので、呼出回数と内容を照合できる。
 * binding を叩く実体は adapter（src/cloudflare.ts）にあり、そちらは src/cloudflare.test.ts が見る。
 */
function recorder(respond: (request: Request) => Response | Promise<Response>): DataApiRelay & { readonly calls: Request[] } {
  const calls: Request[] = [];
  const relay: DataApiRelay = async (request) => {
    calls.push(request);
    return await respond(request);
  };
  return Object.assign(relay, { calls });
}

/** /api/* に送ってみる method。production ではログインが無ければ全部 401、dev / staging ではそのまま下流へ運ばれる */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** 記録した Request の1つ（noUncheckedIndexedAccess の下では calls[0] が undefined になり得るため） */
function sentTo(calls: readonly Request[], index = 0): Request {
  const request = calls[index];
  if (request === undefined) throw new Error(`下流が ${index + 1} 回以上呼ばれていない`);
  return request;
}

/** 中継しない ENVIRONMENT。未設定・未知の値（閉じる側に倒す）。production は別扱いである（ログインが要る） */
const CLOSED_ENVIRONMENTS = [
  ["未設定", undefined],
  ["空文字", ""],
  ["未知の値", "Prod"],
  ["別の env の名前", "stg"],
] as const;

describe("isApiPath（中継する経路）", () => {
  it.each([
    ["/api", true],
    ["/api/", true],
    ["/api/instances/i/spec", true],
    ["/api/instances/i/views/v", true],
    ["/healthz", false],
    ["/", false],
    ["/apis/instances", false],
    ["/apiary", false],
    ["/communities/c1/apps", false],
  ])("%s は %s", (path, expected) => {
    expect(isApiPath(path)).toBe(expected);
  });

  it("接頭辞は /api（host の run_worker_first と同じ範囲）", () => {
    expect(API_PREFIX).toBe("/api");
  });
});

describe("relaysApi（ログイン無しで中継する env を決める）", () => {
  it("dev と staging だけ中継する", () => {
    expect(RELAY_ENVIRONMENTS).toEqual(["dev", "staging"]);
    for (const environment of RELAY_ENVIRONMENTS) expect(relaysApi(environment)).toBe(true);
  });

  it.each([undefined, "", "production", "Prod", "dev ", "develop", "local"])("%j は中継しない（閉じる側）", (environment) => {
    expect(relaysApi(environment)).toBe(false);
  });
});

describe("requiresLogin（ログインした利用者にだけ中継する env を決める。M2.1。Issue #265）", () => {
  it("production だけがログインを要する", () => {
    expect(LOGIN_REQUIRED_ENVIRONMENTS).toEqual(["production"]);
    expect(requiresLogin("production")).toBe(true);
  });

  it.each([undefined, "", "dev", "staging", "Prod", "prod", "production "])("%j はログインを要さない", (environment) => {
    expect(requiresLogin(environment)).toBe(false);
  });
});

describe("apiAccess（env と利用者 ID の両方で中継の可否を決める）", () => {
  it.each(RELAY_ENVIRONMENTS)("%s はログインの有無によらず中継する", (environment) => {
    expect(apiAccess(environment, null)).toBe("relay");
    expect(apiAccess(environment, "u-a")).toBe("relay");
  });

  it("production はログインしていれば中継し、していなければ認証を求める", () => {
    expect(apiAccess("production", "u-a")).toBe("relay");
    expect(apiAccess("production", null)).toBe("unauthenticated");
    expect(apiAccess("production", "")).toBe("unauthenticated");
  });

  it.each([undefined, "", "Prod", "stg", "local"])("%j は中継しない（閉じる側。ログインしていても）", (environment) => {
    expect(apiAccess(environment, null)).toBe("closed");
    expect(apiAccess(environment, "u-a")).toBe("closed");
  });
});

describe("中継しない env（ENVIRONMENT の未設定・未知の値）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(CLOSED_ENVIRONMENTS)(
    "%s：6 method のどれでも 404 の JSON を返し、下流を一度も呼ばない",
    async (_, environment) => {
      const dataApi = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));

      for (const method of METHODS) {
        const res = await handleApi(apiRequest("/api/instances/i/spec", { method }), { ENVIRONMENT: environment }, dataApi);

        expect(res.status, method).toBe(404);
        expect(res.headers.get("content-type"), method).toMatch(/^application\/json/);
        expect(await res.json(), method).toEqual({ error: "not found" });
      }
      expect(dataApi.calls).toEqual([]);
    },
  );

  it.each(CLOSED_ENVIRONMENTS)(
    "%s：X-Musunest-Probe を付けても 404 のままで、下流を一度も呼ばない（合言葉で API を開けない）",
    async (_, environment) => {
      const dataApi = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));
      const res = await handleApi(
        apiRequest("/api/instances/i/actions/a", {
          method: "POST",
          headers: { "content-type": "application/json", [PROBE_HEADER]: "correct-probe-token-0123456789abcdef" },
          body: JSON.stringify({ description: "夕食", amount: 6600 }),
        }),
        { ENVIRONMENT: environment },
        dataApi,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
      expect(dataApi.calls).toEqual([]);
    },
  );
});

// ── production はログインした利用者にだけ開く（M2.1。Issue #265 の受入条件）───────────
//
// production では、ログインしていない /api/* の要求を**下流を一度も呼ばずに** 401 UNAUTHENTICATED で断る。
// ログインした要求だけを、セッションの利用者 ID（識別ヘッダ）を付けて中継する。dev と staging は
// M1 のまま開けておく（決定 2026-10-08）。
describe("production はログインした利用者にだけ開く（下流を呼ばずに 401 で断る）", () => {
  const env: ApiEnv = { ENVIRONMENT: "production" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ログインしていない要求は、6 method のどれでも 401 の JSON を返し、下流を一度も呼ばない", async () => {
    const dataApi = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));

    for (const method of METHODS) {
      const res = await handleApi(apiRequest("/api/instances/i/spec", { method }), env, dataApi, null);

      expect(res.status, method).toBe(401);
      expect(res.headers.get("content-type"), method).toMatch(/^application\/json/);
      expect(await res.json(), method).toEqual({ error: "UNAUTHENTICATED" });
    }
    expect(dataApi.calls).toEqual([]);
  });

  it("X-Musunest-Probe を付けても 401 のままで、下流を一度も呼ばない（合言葉で API を開けない）", async () => {
    const dataApi = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/a", {
        method: "POST",
        headers: { "content-type": "application/json", [PROBE_HEADER]: "correct-probe-token-0123456789abcdef" },
        body: JSON.stringify({ description: "夕食", amount: 6600 }),
      }),
      env,
      dataApi,
      null,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(dataApi.calls).toEqual([]);
  });

  it("ログインした利用者の要求は、利用者の識別を付けて下流へ中継する", async () => {
    const dataApi = recorder(() => Response.json({ instances: [] }, { status: 200 }));
    const res = await handleApi(
      apiRequest("/api/me/instances", { headers: { [IDENTITY_HEADER]: "attacker-chosen-id" } }),
      env,
      dataApi,
      "u-member",
    );

    expect(dataApi.calls).toHaveLength(1);
    // 外から届いた値は落ち、セッションの利用者 ID だけが載る（なりすましを通さない）
    expect(sentTo(dataApi.calls).headers.get(IDENTITY_HEADER)).toBe("u-member");
    expect(res.status).toBe(200);
  });

  it("ログインしていれば、下流の応答（422 など）をそのまま返す", async () => {
    const rejected = { error: "INPUT_REJECTED", fields: ["amount"], validations: [] };
    const dataApi = recorder(() => Response.json(rejected, { status: 422 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/addExpense", { method: "POST", body: "{}" }),
      env,
      dataApi,
      "u-member",
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(rejected);
  });

  it("識別ヘッダを外から付けても、ログインが無ければ下流を呼ばずに 401（なりすましで開けない）", async () => {
    const dataApi = recorder(() => Response.json({}, { status: 200 }));
    const res = await handleApi(
      apiRequest("/api/me/instances", { headers: { [IDENTITY_HEADER]: "u-attacker" } }),
      env,
      dataApi,
      null,
    );

    expect(res.status).toBe(401);
    expect(dataApi.calls).toEqual([]);
  });
});

describe.each(RELAY_ENVIRONMENTS)("中継する env（%s）", (environment) => {
  const env: ApiEnv = { ENVIRONMENT: environment };

  it("GET の path と query をそのまま下流へ渡す（宛先の origin は adapter が決める）", async () => {
    const dataApi = recorder(() => Response.json({ rows: [] }, { status: 200 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/views/expenseList?page=2&q=%E5%A4%95%E9%A3%9F&q=2", { headers: { accept: "application/json" } }),
      env,
      dataApi,
    );

    expect(dataApi.calls).toHaveLength(1);
    const sent = sentTo(dataApi.calls);
    const url = new URL(sent.url);
    expect(url.origin).toBe(GATEWAY_ORIGIN);
    expect(url.pathname).toBe("/api/instances/i/views/expenseList");
    // query は順序も含めてそのまま運ぶ（decode しない）
    expect(url.search).toBe("?page=2&q=%E5%A4%95%E9%A3%9F&q=2");
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(res.status).toBe(200);
  });

  it("POST の JSON の body と content-type をそのまま下流へ渡す", async () => {
    const body = JSON.stringify({ description: "夕食", amount: 6600, participants: ["A", "B"] });
    const dataApi = recorder(() => Response.json({ id: "r1" }, { status: 201 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/addExpense", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      env,
      dataApi,
    );

    expect(dataApi.calls).toHaveLength(1);
    const sent = sentTo(dataApi.calls);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.text()).toBe(body);
    expect(res.status).toBe(201);
  });

  it("下流はリクエスト1つにつき1回だけ呼ばれる", async () => {
    const dataApi = recorder(() => Response.json({}, { status: 200 }));
    for (const method of METHODS) {
      await handleApi(apiRequest("/api/instances/i/spec", { method }), env, dataApi);
    }
    expect(dataApi.calls).toHaveLength(METHODS.length);
  });
});

describe("下流の応答をそのまま返す（status・本文・content-type）", () => {
  it.each([
    [200, { instanceId: "i", rows: [] }],
    [201, { id: "r1", createdAt: "2026-09-16T00:00:00.000Z" }],
    [400, { error: "INVALID_JSON" }],
    [403, { error: "PERMISSION_DENIED" }],
    [404, { error: "NOT_FOUND" }],
    [422, { error: "INPUT_REJECTED", fields: ["amount"], validations: ["amountPositive"] }],
    [503, { error: "SPEC_UNAVAILABLE" }],
  ])("下流の HTTP %i を、status・本文・content-type ごと保つ", async (status, body) => {
    const dataApi = recorder(() => Response.json(body, { status }));
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, dataApi);

    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(body);
  });

  it("拒否（422）は JSON のままで、200 の SPA HTML に化けない", async () => {
    const rejected = { error: "INPUT_REJECTED", fields: ["amount"], validations: [] };
    const dataApi = recorder(() => Response.json(rejected, { status: 422 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/addExpense", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { ENVIRONMENT: "dev" },
      dataApi,
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).not.toMatch(/text\/html/);
    expect(await res.json()).toEqual(rejected);
  });

  it("本文のない応答（204）も status ごと保つ", async () => {
    const dataApi = recorder(() => new Response(null, { status: 204 }));
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, dataApi);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("中継そのものの失敗（下流に届かない）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(RELAY_ENVIRONMENTS)(
    "%s：下流が例外を投げたら非 2xx になり、内部 origin も資格情報も応答に載らない",
    async (environment) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const leaked = new TypeError("fetch failed: https://data-api.internal/api/instances (token=probe-token-value)");
      const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: environment }, () => Promise.reject(leaked));

      expect(res.status).toBe(RELAY_FAILURE_STATUS);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual(RELAY_FAILURE_BODY);
      for (const leakedText of ["data-api.internal", "probe-token-value", "fetch failed", "TypeError"]) {
        expect(text).not.toContain(leakedText);
      }
      // 詳細は Workers のログにだけ出す（応答は外へ出る）
      expect(error).toHaveBeenCalledWith("[gateway] api: data_api relay failed", leaked);
    },
  );

  it("Error 以外が投げられても落ちずに非 2xx にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, () => Promise.reject("boom"));
    expect(res.status).toBe(RELAY_FAILURE_STATUS);
    expect(await res.json()).toEqual(RELAY_FAILURE_BODY);
  });

  it("中継しない env では、下流が使えない状態でも 404 のまま（呼ばないので中継の失敗にもならない）", async () => {
    const dataApi = recorder(() => {
      throw new Error("relay is not expected to be called");
    });
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "Prod" }, dataApi);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(dataApi.calls).toEqual([]);
  });

  it("production でログインしていない要求も、下流が使えない状態で 401 のまま（呼ばないので中継の失敗にならない）", async () => {
    const dataApi = recorder(() => {
      throw new Error("relay is not expected to be called");
    });
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "production" }, dataApi);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(dataApi.calls).toEqual([]);
  });
});

// ── 識別ヘッダの付け替え（M2.1。Issue #263 の受入条件）─────────────────────────
//
// **外から届いた識別ヘッダ（IDENTITY_HEADER）は、中継の前に必ず取り除く。** gateway がセッションから
// 決めた利用者 ID だけを載せる——利用者の値でなりすませない。production はログインが無ければ
// 付け替える前に 401、未設定・未知の値は付け替える前に 404 になる（いずれも下流を呼ばない）。
describe("識別ヘッダの付け替え（なりすましを通さない）", () => {
  const env: ApiEnv = { ENVIRONMENT: "dev" };

  it("外から届いた値は取り除き、セッションの利用者 ID だけを載せる", async () => {
    const dataApi = recorder(() => Response.json({ instances: [] }, { status: 200 }));
    await handleApi(
      apiRequest("/api/me/instances", { headers: { [IDENTITY_HEADER]: "attacker-chosen-id" } }),
      env,
      dataApi,
      "u-a",
    );

    expect(sentTo(dataApi.calls).headers.get(IDENTITY_HEADER)).toBe("u-a");
  });

  it("ログインしていなければ、外から届いた値は落ちる（ヘッダそのものを載せない）", async () => {
    const dataApi = recorder(() => Response.json({ error: "UNAUTHENTICATED" }, { status: 401 }));
    await handleApi(
      apiRequest("/api/me/instances", { headers: { [IDENTITY_HEADER]: "attacker-chosen-id" } }),
      env,
      dataApi,
      null,
    );

    expect(sentTo(dataApi.calls).headers.get(IDENTITY_HEADER)).toBeNull();
  });

  it("取り除くのは識別ヘッダだけである（他のヘッダはそのまま運ぶ）", async () => {
    const dataApi = recorder(() => Response.json({}, { status: 200 }));
    await handleApi(
      apiRequest("/api/me/instances", { headers: { accept: "application/json", [IDENTITY_HEADER]: "attacker" } }),
      env,
      dataApi,
      "u-a",
    );

    const sent = sentTo(dataApi.calls);
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(sent.headers.get(IDENTITY_HEADER)).toBe("u-a");
  });

  it("中継しない env（未知の値）では、付け替える前に 404 で下流を一度も呼ばない", async () => {
    const dataApi = recorder(() => Response.json({}, { status: 200 }));
    const res = await handleApi(
      apiRequest("/api/me/instances", { headers: { [IDENTITY_HEADER]: "attacker" } }),
      { ENVIRONMENT: "Prod" },
      dataApi,
      "u-a",
    );

    expect(res.status).toBe(404);
    expect(dataApi.calls).toEqual([]);
  });
});
