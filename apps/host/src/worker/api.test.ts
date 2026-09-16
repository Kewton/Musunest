// /api/* の中継の判定と作法を、Cloudflare を使わずに確かめる（Issue #103 の受入試験）。
// 実機（workerd の Service Binding 越しの gateway → data-api）での疎通は src/worker/index.test.ts が見る。
//
// ここで測るのは4つである（apps/gateway/src/api.test.ts と同じ観点。host は gateway を import できないので、
// 同じ判定を書き写している側が食い違っていないことを、両方のファイルが同じ形で押さえる）。
//   1. production・vars.ENVIRONMENT 未設定・未知の値では、6 method のどれでも 404 になり、**下流は一度も呼ばれない**。
//      X-Musunest-Probe を付けても同じ——API を開ける合言葉にしない
//   2. dev / staging では、method・path・query・ヘッダ・body がそのまま下流へ届く
//   3. 下流の応答は status・content-type・body ごと保たれる（422 を 200 の SPA HTML に化けさせない）
//   4. 中継そのものの失敗は非 2xx になり、内部 origin も資格情報も応答に載らない
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PREFIX,
  handleApi,
  isApiPath,
  RELAY_ENVIRONMENTS,
  RELAY_FAILURE_BODY,
  RELAY_FAILURE_STATUS,
  relaysApi,
} from "./api.js";
import type { ApiEnv, GatewayRelay } from "./api.js";

const HOST_ORIGIN = "https://musunest-dev-host.example";
const PROBE_HEADER = "X-Musunest-Probe";

const apiRequest = (path: string, init?: RequestInit): Request => new Request(`${HOST_ORIGIN}${path}`, init);

/**
 * 下流（gateway）の代わり。**呼ばれた Request を記録する**ので、呼出回数と内容を照合できる。
 * binding を叩く実体は adapter（src/worker/cloudflare.ts）にあり、そちらは src/worker/cloudflare.test.ts が見る。
 */
function recorder(respond: (request: Request) => Response | Promise<Response>): GatewayRelay & { readonly calls: Request[] } {
  const calls: Request[] = [];
  const relay: GatewayRelay = async (request) => {
    calls.push(request);
    return await respond(request);
  };
  return Object.assign(relay, { calls });
}

/** /api/* に送ってみる method。production では全部 404 になり、dev / staging ではそのまま下流へ運ばれる */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** 記録した Request の1つ（noUncheckedIndexedAccess の下では calls[0] が undefined になり得るため） */
function sentTo(calls: readonly Request[], index = 0): Request {
  const request = calls[index];
  if (request === undefined) throw new Error(`下流が ${index + 1} 回以上呼ばれていない`);
  return request;
}

/** 中継してはいけない ENVIRONMENT。production と、未設定・未知の値（閉じる側に倒す） */
const BLOCKED_ENVIRONMENTS = [
  ["production", "production"],
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

  it("接頭辞は /api（wrangler.jsonc の assets.run_worker_first と同じ範囲）", () => {
    expect(API_PREFIX).toBe("/api");
  });
});

describe("relaysApi（vars.ENVIRONMENT で中継を決める）", () => {
  it("dev と staging だけ中継する", () => {
    expect(RELAY_ENVIRONMENTS).toEqual(["dev", "staging"]);
    for (const environment of RELAY_ENVIRONMENTS) expect(relaysApi(environment)).toBe(true);
  });

  it.each([undefined, "", "production", "Prod", "dev ", "develop", "local"])("%j は中継しない（閉じる側）", (environment) => {
    expect(relaysApi(environment)).toBe(false);
  });
});

describe("中継しない env（production・ENVIRONMENT の未設定・未知の値）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(BLOCKED_ENVIRONMENTS)(
    "%s：6 method のどれでも 404 の JSON を返し、下流を一度も呼ばない",
    async (_, environment) => {
      const gateway = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));

      for (const method of METHODS) {
        const res = await handleApi(apiRequest("/api/instances/i/spec", { method }), { ENVIRONMENT: environment }, gateway);

        expect(res.status, method).toBe(404);
        expect(res.headers.get("content-type"), method).toMatch(/^application\/json/);
        expect(await res.json(), method).toEqual({ error: "not found" });
      }
      expect(gateway.calls).toEqual([]);
    },
  );

  it.each(BLOCKED_ENVIRONMENTS)(
    "%s：X-Musunest-Probe を付けても 404 のままで、下流を一度も呼ばない（合言葉で API を開けない）",
    async (_, environment) => {
      const gateway = recorder(() => Response.json({ error: "NOT_FOUND" }, { status: 404 }));
      const res = await handleApi(
        apiRequest("/api/instances/i/actions/a", {
          method: "POST",
          headers: { "content-type": "application/json", [PROBE_HEADER]: "correct-probe-token-0123456789abcdef" },
          body: JSON.stringify({ description: "夕食", amount: 6600 }),
        }),
        { ENVIRONMENT: environment },
        gateway,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
      expect(gateway.calls).toEqual([]);
    },
  );
});

describe.each(RELAY_ENVIRONMENTS)("中継する env（%s）", (environment) => {
  const env: ApiEnv = { ENVIRONMENT: environment };

  it("GET の path と query をそのまま下流へ渡す（宛先の origin は adapter が決める）", async () => {
    const gateway = recorder(() => Response.json({ rows: [] }, { status: 200 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/views/expenseList?page=2&q=%E5%A4%95%E9%A3%9F&q=2", { headers: { accept: "application/json" } }),
      env,
      gateway,
    );

    expect(gateway.calls).toHaveLength(1);
    const sent = sentTo(gateway.calls);
    const url = new URL(sent.url);
    expect(url.origin).toBe(HOST_ORIGIN);
    expect(url.pathname).toBe("/api/instances/i/views/expenseList");
    // query は順序も含めてそのまま運ぶ（decode しない）
    expect(url.search).toBe("?page=2&q=%E5%A4%95%E9%A3%9F&q=2");
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(res.status).toBe(200);
  });

  it("POST の JSON の body と content-type をそのまま下流へ渡す", async () => {
    const body = JSON.stringify({ description: "夕食", amount: 6600, participants: ["A", "B"] });
    const gateway = recorder(() => Response.json({ id: "r1" }, { status: 201 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/addExpense", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      env,
      gateway,
    );

    expect(gateway.calls).toHaveLength(1);
    const sent = sentTo(gateway.calls);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(await sent.text()).toBe(body);
    expect(res.status).toBe(201);
  });

  it("下流はリクエスト1つにつき1回だけ呼ばれる", async () => {
    const gateway = recorder(() => Response.json({}, { status: 200 }));
    for (const method of METHODS) {
      await handleApi(apiRequest("/api/instances/i/spec", { method }), env, gateway);
    }
    expect(gateway.calls).toHaveLength(METHODS.length);
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
    const gateway = recorder(() => Response.json(body, { status }));
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, gateway);

    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(body);
  });

  it("拒否（422）は JSON のままで、200 の SPA HTML に化けない", async () => {
    const rejected = { error: "INPUT_REJECTED", fields: ["amount"], validations: [] };
    const gateway = recorder(() => Response.json(rejected, { status: 422 }));
    const res = await handleApi(
      apiRequest("/api/instances/i/actions/addExpense", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { ENVIRONMENT: "dev" },
      gateway,
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).not.toMatch(/text\/html/);
    expect(await res.json()).toEqual(rejected);
  });

  it("本文のない応答（204）も status ごと保つ", async () => {
    const gateway = recorder(() => new Response(null, { status: 204 }));
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, gateway);
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
      const leaked = new TypeError("fetch failed: https://gateway.internal/api/instances (token=probe-token-value)");
      const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: environment }, () => Promise.reject(leaked));

      expect(res.status).toBe(RELAY_FAILURE_STATUS);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual(RELAY_FAILURE_BODY);
      for (const leakedText of ["gateway.internal", "probe-token-value", "fetch failed", "TypeError"]) {
        expect(text).not.toContain(leakedText);
      }
      // 詳細は Workers のログにだけ出す（応答はインターネットへ出る）
      expect(error).toHaveBeenCalledWith("[host] api: gateway relay failed", leaked);
    },
  );

  it("Error 以外が投げられても落ちずに非 2xx にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "dev" }, () => Promise.reject("boom"));
    expect(res.status).toBe(RELAY_FAILURE_STATUS);
    expect(await res.json()).toEqual(RELAY_FAILURE_BODY);
  });

  it("中継しない env では、下流が使えない状態でも 404 のまま（呼ばないので中継の失敗にもならない）", async () => {
    const gateway = recorder(() => {
      throw new Error("relay is not expected to be called");
    });
    const res = await handleApi(apiRequest("/api/instances/i/spec"), { ENVIRONMENT: "production" }, gateway);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(gateway.calls).toEqual([]);
  });
});
