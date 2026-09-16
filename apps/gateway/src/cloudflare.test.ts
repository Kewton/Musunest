// adapter（Service Binding）を、Cloudflare を使わずに確かめる（Issue #103 の受入試験）。
//
// ここで測るのは **/api/* の宛先がどう決まるか** である——利用者の URL の origin を捨て、
// binding と固定の内部 origin に置き換える。**利用者の query やヘッダで外部 URL を選ばせない**のが要である
// （外部 URL を選べると、中継が任意の送信先を叩く口になる）。path・query・method・ヘッダ・body はそのまま運ぶ。
// 実機（workerd の Service Binding 越しの data-api）での疎通は src/index.test.ts が見る。
import { describe, expect, it } from "vitest";
import { cloudflareDataApiRelay } from "./cloudflare.js";
import type { GatewayEnv } from "./cloudflare.js";

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
