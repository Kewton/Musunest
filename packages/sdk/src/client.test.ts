// SDK の型付きクライアント（Issue #104）。**mock の fetch で、経路と応答の扱いを照合する。**
//
// 見るのは3つである。
//   1. 3 経路（spec・一覧・action）の method・URL の要素（エンコードを含む）・body
//   2. 成功の型（ApiSpecBody・ApiViewBody・ApiRow）
//   3. **失敗が成功に化けないこと。** 422 の fields・validations を保ち、ネットワークの例外・JSON でない応答・
//      契約と違う形の応答は、成功の型へキャストせず失敗にする

import { describe, expect, it } from "vitest";
import type { ApiRow, ApiSpecBody, ApiViewBody } from "@musunest/appspec-schema";
import { INVALID_RESPONSE, NETWORK_FAILURE, createMusunestClient } from "./client.js";
import type { FetchLike } from "./client.js";

const BASE = "https://api.example";

/** 1 回の呼出を記録する fetch の差し替え。`reply` は呼出ごとに評価する */
function recordingFetch(reply: () => Response): {
  readonly fetch: FetchLike;
  readonly calls: { readonly url: string; readonly init: RequestInit }[];
} {
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(reply());
  };
  return { fetch, calls };
}

/** JSON の応答。`status < 400` を成功として扱う（Response の実装に依存しない最小の形） */
function json(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** JSON として読めない応答（SPA シェルや proxy の HTML など） */
function raw(status: number, text: string): Response {
  return { ok: status < 400, status, text: () => Promise.resolve(text) } as unknown as Response;
}

/** 例外を投げる fetch（ネットワークが届かない） */
function throwingFetch(): FetchLike {
  return () => Promise.reject(new Error("connection refused"));
}

const SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "a".repeat(64),
  spec: {
    entities: [{ name: "expense", fields: { description: "string", amount: "number", participants: "list" } }],
    views: [{ name: "expenseList", entity: "expense" }],
    actions: [{ name: "addExpense", entity: "expense" }],
    validations: [{ name: "positiveAmount", entity: "expense", expression: "amount > 0" }],
    computed: [{ name: "shareAmount", entity: "expense", expression: "amount", type: "number" }],
    permissions: [{ name: "read", subject: "minIdentity" }],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
};

const ROW: ApiRow = {
  id: "r1",
  createdAt: "2026-09-16T12:00:00+09:00",
  updatedAt: "2026-09-16T12:00:00+09:00",
  fields: { description: "夕食", amount: 6600, participants: ["A", "B", "C"] },
  computed: { shareAmount: 2000 },
};

const VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "expenseList",
  entity: "expense",
  fields: ["description", "amount", "participants"],
  computed: ["shareAmount"],
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
  rows: [ROW],
};

const clientWith = (fetch: FetchLike) => createMusunestClient({ baseUrl: BASE, fetch });

describe("GET /api/instances/:instanceId/spec", () => {
  it("method は GET、URL の要素はエンコードされ、成功の型で返る", async () => {
    const stub = recordingFetch(() => json(200, SPEC));
    const result = await clientWith(stub.fetch).getSpec("inst /1");

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst%20%2F1/spec`);
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(stub.calls[0]?.init.body).toBeUndefined();
    expect(result).toEqual({ ok: true, value: SPEC });
  });

  it("404 は NOT_FOUND として status を保つ（成功にしない）", async () => {
    const stub = recordingFetch(() => json(404, { error: "NOT_FOUND" }));
    const result = await clientWith(stub.fetch).getSpec("missing");

    expect(result).toEqual({
      ok: false,
      error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] },
    });
  });
});

describe("GET /api/instances/:instanceId/views/:viewName", () => {
  it("view の名前をエンコードし、成功の型で返る", async () => {
    const stub = recordingFetch(() => json(200, VIEW));
    const result = await clientWith(stub.fetch).getView("inst-1", "a/b c");

    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/views/a%2Fb%20c`);
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(result).toEqual({ ok: true, value: VIEW });
  });

  it("403 は PERMISSION_DENIED として status を保つ", async () => {
    const stub = recordingFetch(() => json(403, { error: "PERMISSION_DENIED" }));
    const result = await clientWith(stub.fetch).getView("inst-1", "expenseList");

    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: "PERMISSION_DENIED", fields: [], validations: [] },
    });
  });
});

describe("POST /api/instances/:instanceId/actions/:actionName", () => {
  it("method は POST、body は JSON、content-type を付け、書いた行が返る", async () => {
    const stub = recordingFetch(() => json(201, ROW));
    const input = { description: "夕食", amount: 6600, participants: ["A", "B", "C"] };
    const result = await clientWith(stub.fetch).addRecord("inst-1", "addExpense", input);

    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/actions/addExpense`);
    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(stub.calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(stub.calls[0]?.init.body))).toEqual(input);
    expect(result).toEqual({ ok: true, value: ROW });
  });

  it("422 は fields と validations を保つ（拒否の内容を落とさない）", async () => {
    const stub = recordingFetch(() =>
      json(422, { error: "INPUT_REJECTED", fields: ["amount", "participants"], validations: ["positiveAmount"] }),
    );
    const result = await clientWith(stub.fetch).addRecord("inst-1", "addExpense", {});

    expect(result).toEqual({
      ok: false,
      error: {
        status: 422,
        code: "INPUT_REJECTED",
        fields: ["amount", "participants"],
        validations: ["positiveAmount"],
      },
    });
  });

  it("422 でも本文が契約の形でなければ、fields・validations をでっち上げず INVALID_RESPONSE にする", async () => {
    const stub = recordingFetch(() => json(422, { error: "INPUT_REJECTED", fields: "amount", validations: null }));
    const result = await clientWith(stub.fetch).addRecord("inst-1", "addExpense", {});

    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: INVALID_RESPONSE, fields: [], validations: [] },
    });
  });
});

describe("失敗を成功にしない", () => {
  it("ネットワークの例外は NETWORK_FAILURE（status は null）", async () => {
    const result = await clientWith(throwingFetch()).getSpec("inst-1");

    expect(result).toEqual({
      ok: false,
      error: { status: null, code: NETWORK_FAILURE, fields: [], validations: [] },
    });
  });

  it("JSON でない 200 の応答（HTML）は INVALID_RESPONSE", async () => {
    const stub = recordingFetch(() => raw(200, "<!DOCTYPE html><html><body>MUSUNEST</body></html>"));
    const result = await clientWith(stub.fetch).getView("inst-1", "expenseList");

    expect(result).toEqual({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE, fields: [], validations: [] },
    });
  });

  it("契約と違う形の 200 の応答は INVALID_RESPONSE（キャストしない）", async () => {
    const missing = recordingFetch(() => json(200, { hello: "world" }));
    expect(await clientWith(missing.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });

    const specShape = recordingFetch(() =>
      json(200, { ...SPEC, permissions: { read: true } }),
    );
    expect(await clientWith(specShape.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });

    const rowsShape = recordingFetch(() =>
      json(200, { ...VIEW, rows: [{ ...ROW, computed: { shareAmount: "2000" } }] }),
    );
    expect(await clientWith(rowsShape.fetch).getView("inst-1", "expenseList")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("未知の誤りコードは INVALID_RESPONSE に落ちる", async () => {
    const stub = recordingFetch(() => json(500, { error: "SOMETHING_ELSE" }));
    const result = await clientWith(stub.fetch).getSpec("inst-1");

    expect(result).toEqual({
      ok: false,
      error: { status: 500, code: INVALID_RESPONSE, fields: [], validations: [] },
    });
  });
});

describe("base URL", () => {
  it("末尾のスラッシュを落として経路を足す。空なら相対のまま（host の同じ origin）", async () => {
    const trailing = recordingFetch(() => json(200, SPEC));
    await createMusunestClient({ baseUrl: `${BASE}/`, fetch: trailing.fetch }).getSpec("inst-1");
    expect(trailing.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/spec`);

    const relative = recordingFetch(() => json(200, SPEC));
    await createMusunestClient({ baseUrl: "", fetch: relative.fetch }).getSpec("inst-1");
    expect(relative.calls[0]?.url).toBe("/api/instances/inst-1/spec");
  });
});
