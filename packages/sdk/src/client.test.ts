// SDK の型付きクライアント（Issue #104）。**mock の fetch で、経路と応答の扱いを照合する。**
//
// 見るのは3つである。
//   1. 3 経路（spec・一覧・action）の method・URL の要素（エンコードを含む）・body
//   2. 成功の型（ApiSpecBody・ApiViewBody・ApiRow）
//   3. **失敗が成功に化けないこと。** 422 の fields・validations を保ち、ネットワークの例外・JSON でない応答・
//      契約と違う形の応答は、成功の型へキャストせず失敗にする

import { describe, expect, it } from "vitest";
import type { ApiRow, ApiSpecBody, ApiViewBody } from "@musunest/appspec-schema";
import { INVALID_RESPONSE, NETWORK_FAILURE, createMusunestClient, displayNameOf } from "./client.js";
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

// ── 一覧の種類（type・show）と精算（settlement）（M1.2。Issue #142） ──────────
//
// 画面（host）が判断に使う値なので、**契約と違う形は成功にしない**。精算は「欄が無い」（宣言が無い）と
// 「null」（読めなかった）を区別したまま渡す——空の並びに読み替えると、送金が要らない状態と混ざる。

describe("一覧の宣言（type・show）と精算（settlement）", () => {
  it("一覧の type と show を、型付きで受け取る（種類は table・settlement だけ）", async () => {
    const spec = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        views: [
          { name: "expenseList", entity: "expense", type: "table", show: ["description", "shareAmount"] },
          { name: "settlement", entity: "member", type: "settlement" },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, spec));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("ボードの columns と highlight を、型付きで受け取る（M1.3。受入条件）", async () => {
    const spec = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          { name: "overdue", entity: "expense", expression: 'description == "x"', type: "boolean" },
        ],
        views: [
          { name: "expenseList", entity: "expense", type: "board", columns: "status", highlight: "overdue" },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, spec));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("行の computed に真偽（boolean）も載る（強調の判定の結果。M1.3。受入条件）", async () => {
    const row = { ...ROW, computed: { shareAmount: 2000, overdue: true } };
    const stub = recordingFetch(() => json(200, { ...VIEW, rows: [row] }));

    expect(await clientWith(stub.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, rows: [row] },
    });
  });

  it("知らない type や、type なしの show は INVALID_RESPONSE（キャストしない）", async () => {
    const cases: unknown[] = [
      // `board` は M1.3 で語彙に入ったので、知らない種類は別の語で確かめる
      [{ name: "expenseList", entity: "expense", type: "calendar" }],
      [{ name: "expenseList", entity: "expense", show: ["description"] }],
      [{ name: "expenseList", entity: "expense", type: "table", show: "description" }],
      // `columns`・`highlight` は `type: board` のときだけである
      [{ name: "expenseList", entity: "expense", type: "table", columns: "status" }],
      [{ name: "expenseList", entity: "expense", type: "board", columns: ["status"] }],
    ];
    for (const views of cases) {
      const stub = recordingFetch(() => json(200, { ...SPEC, spec: { ...SPEC.spec, views } }));
      expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });

  it("精算の並びをそのまま渡し、null（読めなかった）と欄が無い（宣言が無い）を区別する", async () => {
    const settlement = [{ from: "m3", to: "m1", amount: 3000 }];

    const withSettlement = recordingFetch(() => json(200, { ...VIEW, settlement }));
    expect(await clientWith(withSettlement.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, settlement },
    });

    const unavailable = recordingFetch(() => json(200, { ...VIEW, settlement: null }));
    expect(await clientWith(unavailable.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, settlement: null },
    });

    const none = recordingFetch(() => json(200, VIEW));
    expect(await clientWith(none.fetch).getView("inst-1", "expenseList")).toEqual({ ok: true, value: VIEW });
  });

  it("契約と違う形の精算は INVALID_RESPONSE", async () => {
    const stub = recordingFetch(() =>
      json(200, { ...VIEW, settlement: [{ from: "m3", to: "m1", amount: "3000" }] }),
    );

    expect(await clientWith(stub.fetch).getView("inst-1", "expenseList")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});

// ── アプリ全体の集計（`scope: app`）と平均（`avg`）（M1.4。Issue #177） ──
//
// 値は一覧の応答の `scope`（計算の名前 → 数か `null`）に載る。**欄が無い**（宣言が無い）ことと、
// 値が `null`（求められなかった）ことを区別したまま渡す。宣言の側は `scope: app` と `avg` を受ける
// ——受けないと `getSpec` が失敗し、画面が開かない（#145・#154 と同じ穴）。

describe("アプリ全体の集計（scope）と平均（avg）", () => {
  it("計算の値として受け取り、欄が無いときと null を区別する", async () => {
    const scope = { activityCount: 3, averageAttendees: 2, averageCost: null };

    const withScope = recordingFetch(() => json(200, { ...VIEW, scope }));
    expect(await clientWith(withScope.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, scope },
    });

    // **欄そのものが無い**（宣言が無い）のは、値が null のときとは別の事実である
    const none = recordingFetch(() => json(200, VIEW));
    expect(await clientWith(none.fetch).getView("inst-1", "expenseList")).toEqual({ ok: true, value: VIEW });
  });

  it("数でも null でもない値は INVALID_RESPONSE", async () => {
    const stub = recordingFetch(() => json(200, { ...VIEW, scope: { averageCost: "5000" } }));

    expect(await clientWith(stub.fetch).getView("inst-1", "expenseList")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("scope: app と avg の宣言（正規化 JSON）を受け取る", async () => {
    const withScope: ApiSpecBody = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          ...SPEC.spec.computed,
          {
            name: "averageAmount",
            scope: "app",
            aggregate: { kind: "avg", entity: "expense", name: "amount", where: {} },
            type: "number",
          },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, withScope));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: withScope });
  });

  it("where の期間の条件（within）を受け取り、知らない期間や古い形は INVALID_RESPONSE（M1.4。Issue #178）", async () => {
    const computedWith = (where: unknown): unknown => ({
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          ...SPEC.spec.computed,
          {
            name: "thisMonthAmount",
            scope: "app",
            aggregate: { kind: "avg", entity: "expense", name: "amount", where },
            type: "number",
          },
        ],
      },
    });

    // 期間の条件は `op` と `period` を持つオブジェクトである（窓口の決定 2026-09-20）
    const accepted = computedWith({ paidOn: { op: "within", period: "this_month" } });
    const okStub = recordingFetch(() => json(200, accepted));
    expect(await clientWith(okStub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: accepted });

    // 知らない期間の名前は成功にしない
    const unknownPeriod = recordingFetch(() =>
      json(200, computedWith({ paidOn: { op: "within", period: "last_week" } })),
    );
    expect(await clientWith(unknownPeriod.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });

    // 条件は**どれも `op` を持つオブジェクト**である（文字列の `equals` は古い形である）
    const oldShape = recordingFetch(() => json(200, computedWith({ paidOn: "equals" })));
    expect(await clientWith(oldShape.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("scope: app に entity を書いた宣言は INVALID_RESPONSE（成功にしない）", async () => {
    const broken = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          ...SPEC.spec.computed,
          {
            name: "bad",
            scope: "app",
            entity: "expense",
            aggregate: { kind: "count", entity: "expense", name: null, where: {} },
            type: "number",
          },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, broken));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});

// ── 見出しごとの集計（`groupBy`・`groups`）（M1.4。Issue #179） ──
//
// 値は一覧の応答の `groups`（計算の名前 → 「見出しと値」の組の並び）に載る。**欄が無い**（宣言が無い）
// ことと、値が `null`（求められなかった）ことを区別したまま渡す。宣言の側は `groupBy` と `type: groups`
// を受ける——受けないと `getSpec` が失敗し、画面が開かない（#145・#154 と同じ穴）。

describe("見出しごとの集計（groupBy・groups）", () => {
  it("計算の値として受け取り、欄が無いときと null を区別する", async () => {
    const groups = {
      byKind: [
        { heading: "practice", value: 2 },
        { heading: "match", value: null },
      ],
    };

    const withGroups = recordingFetch(() => json(200, { ...VIEW, groups }));
    expect(await clientWith(withGroups.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, groups },
    });

    // **欄そのものが無い**（宣言が無い）のは、値が `null` のときとは別の事実である
    const none = recordingFetch(() => json(200, VIEW));
    expect(await clientWith(none.fetch).getView("inst-1", "expenseList")).toEqual({ ok: true, value: VIEW });
  });

  it("組の形が違う値（見出しが文字列でない・値が数でも null でもない）は INVALID_RESPONSE", async () => {
    const cases: unknown[] = [
      { byKind: [{ heading: 1, value: 2 }] },
      { byKind: [{ heading: "practice", value: "2" }] },
      { byKind: "practice" },
    ];
    for (const groups of cases) {
      const stub = recordingFetch(() => json(200, { ...VIEW, groups }));
      expect(await clientWith(stub.fetch).getView("inst-1", "expenseList")).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });

  it("groupBy と type: groups の宣言（正規化 JSON）を受け取る", async () => {
    const withGroups: ApiSpecBody = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          ...SPEC.spec.computed,
          {
            name: "byKind",
            aggregate: {
              kind: "count",
              entity: "expense",
              name: null,
              where: {},
              groupBy: { field: "amount", month: false },
            },
            type: "groups",
          },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, withGroups));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: withGroups });
  });

  it("type: groups に entity を書いた宣言は INVALID_RESPONSE（成功にしない）", async () => {
    const broken = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          ...SPEC.spec.computed,
          {
            name: "bad",
            entity: "expense",
            aggregate: {
              kind: "count",
              entity: "expense",
              name: null,
              where: {},
              groupBy: { field: "amount", month: false },
            },
            type: "groups",
          },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, broken));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});

// ── 一覧（list）と絞り込み（filters）（M1.3。Issue #158） ──────────────
//
// 画面（host）が絞り込みの候補を宣言から読むので、**契約と違う形は成功にしない**。
// また、`getView` の経路に**絞り込みの引数（query）が増えていない**ことを URL で確かめる（受入条件）。

describe("一覧（list）と絞り込み（filters）（M1.3）", () => {
  const listSpec = (views: unknown) => ({ ...SPEC, spec: { ...SPEC.spec, views } });

  it("type: list と show・filters を、型付きで受け取る（受入条件）", async () => {
    const spec = listSpec([
      { name: "taskList", entity: "expense", type: "list", show: ["description", "amount"], filters: ["amount"] },
    ]);
    const stub = recordingFetch(() => json(200, spec));
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("契約と違う形は INVALID_RESPONSE（キャストしない）", async () => {
    const cases: unknown[] = [
      // filters は `type: list` のときだけである
      [{ name: "expenseList", entity: "expense", type: "table", filters: ["amount"] }],
      // filters は名前の並びでなければならない
      [{ name: "taskList", entity: "expense", type: "list", filters: "amount" }],
      // `type: list` の `show` も並びでなければならない
      [{ name: "taskList", entity: "expense", type: "list", show: "description" }],
    ];
    for (const views of cases) {
      const stub = recordingFetch(() => json(200, listSpec(views)));
      expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });

  it("getView の経路に、絞り込みの引数（query）を足していない（受入条件）", async () => {
    const stub = recordingFetch(() => json(200, VIEW));
    await clientWith(stub.fetch).getView("inst-1", "taskList");

    // 経路は契約のとおりで、`?` 以降（絞り込みの引数）を持たない。読むのは今までどおり全件である
    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/views/taskList`);
    expect(stub.calls[0]?.url).not.toContain("?");
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

// ── 消す（kind: delete）と、消せない理由（M1.2。Issue #109） ──────────────
//
// 画面（host）が消せるかどうかを出す材料なので、**契約と違う形は成功にしない**。
// `REFERENCE_IN_USE`（409）は参照元と件数を保って渡す——空の並びに読み替えると、
// 消せない理由が消える（`settlement` の `null` と同じ約束である）。

describe("消す（M1.2）", () => {
  const DELETED = { entity: "member", id: "m1", deleted: true } as const;

  it("method は POST、body は id だけ、消したことが返る", async () => {
    const stub = recordingFetch(() => json(200, DELETED));
    const result = await clientWith(stub.fetch).deleteRecord("inst-1", "deleteMember", "m1");

    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/actions/deleteMember`);
    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(stub.calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(stub.calls[0]?.init.body))).toEqual({ id: "m1" });
    expect(result).toEqual({ ok: true, value: DELETED });
  });

  it("行ではない応答（deleted が true でない）は INVALID_RESPONSE", async () => {
    const stub = recordingFetch(() => json(200, { entity: "member", id: "m1" }));
    expect(await clientWith(stub.fetch).deleteRecord("inst-1", "deleteMember", "m1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("409 REFERENCE_IN_USE は、参照元と件数を保つ（消せない理由を落とさない）", async () => {
    const references = [
      { entity: "expense", field: "payer", count: 1 },
      { entity: "expense", field: "participants", count: 2 },
    ];
    const stub = recordingFetch(() => json(409, { error: "REFERENCE_IN_USE", references }));

    expect(await clientWith(stub.fetch).deleteRecord("inst-1", "deleteMember", "m1")).toEqual({
      ok: false,
      error: { status: 409, code: "REFERENCE_IN_USE", fields: [], validations: [], references },
    });
  });

  it("参照元が載っていなければ、欄を作らない（空の並びに読み替えない）", async () => {
    const stub = recordingFetch(() => json(409, { error: "REFERENCE_IN_USE" }));
    const result = await clientWith(stub.fetch).deleteRecord("inst-1", "deleteMember", "m1");

    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: "REFERENCE_IN_USE", fields: [], validations: [] },
    });
    // 欄そのものが無い
    expect(result.ok === false && Object.hasOwn(result.error, "references")).toBe(false);
  });

  it("参照元の形が契約と違えば INVALID_RESPONSE（でっち上げない）", async () => {
    const stub = recordingFetch(() =>
      json(409, { error: "REFERENCE_IN_USE", references: [{ entity: "expense", field: "payer" }] }),
    );
    expect(await clientWith(stub.fetch).deleteRecord("inst-1", "deleteMember", "m1")).toEqual({
      ok: false,
      error: { status: 409, code: INVALID_RESPONSE, fields: [], validations: [] },
    });
  });
});

describe("操作の種類（kind）と、行の参照元（M1.2）", () => {
  it("操作の kind を型付きで受け取る（create・update・delete だけ）", async () => {
    const spec = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        actions: [
          { name: "addExpense", entity: "expense", kind: "create" },
          { name: "editExpense", entity: "expense", kind: "update" },
          { name: "deleteExpense", entity: "expense", kind: "delete" },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, spec));
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("知らない kind は INVALID_RESPONSE（キャストしない）", async () => {
    const stub = recordingFetch(() =>
      json(200, { ...SPEC, spec: { ...SPEC.spec, actions: [{ name: "a", entity: "expense", kind: "patch" }] } }),
    );
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("行の references をそのまま渡し、契約と違う形は INVALID_RESPONSE", async () => {
    const references = [{ entity: "expense", field: "payer", count: 1 }];
    const withReferences = recordingFetch(() => json(200, { ...VIEW, rows: [{ ...ROW, references }] }));
    expect(await clientWith(withReferences.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: { ...VIEW, rows: [{ ...ROW, references }] },
    });

    const broken = recordingFetch(() =>
      json(200, { ...VIEW, rows: [{ ...ROW, references: [{ entity: "expense", count: 0 }] }] }),
    );
    expect(await clientWith(broken.fetch).getView("inst-1", "expenseList")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});

// ── 選択肢（enum）と既定値（default）（M1.3。Issue #154） ──────────────
//
// 画面（host）は**選択肢と既定値**を宣言から読む。だから契約と違う形は成功にしない（キャストしない）。

describe("選択肢（enum）と既定値（default）の宣言", () => {
  const enumSpec = (status: unknown) => ({
    ...SPEC,
    spec: { ...SPEC.spec, entities: [{ name: "task", fields: { title: "string", status } }] },
  });

  it("options と default を、型付きで受け取る（受入条件）", async () => {
    const spec = enumSpec({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
      default: "todo",
    });
    const stub = recordingFetch(() => json(200, spec));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("default は書かなくてよい（欄そのものが無い）", async () => {
    const spec = enumSpec({ type: "enum", options: { todo: "未着手" } });
    const stub = recordingFetch(() => json(200, spec));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("契約と違う形は INVALID_RESPONSE（options が空・default がキーに無い・表示名が空）", async () => {
    const cases: unknown[] = [
      { type: "enum", options: {} },
      { type: "enum", options: { todo: "未着手" }, default: "doing" },
      { type: "enum", options: { todo: "" } },
      { type: "enum" },
    ];
    for (const status of cases) {
      const stub = recordingFetch(() => json(200, enumSpec(status)));
      expect(await clientWith(stub.fetch).getSpec("inst-1"), JSON.stringify(status)).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });
});

// ── 表示名（label）（M1.3。Issue #176） ──────────────────────────────
//
// 画面（host）は**表示名を宣言から読む**。SDK は契約の形（`label`・`labels`）を受け取り、
// 契約と違う形は成功にしない。**`displayNameOf` は SDK から再輸出し、画面と読み方を共有する**。

describe("表示名（label）の宣言と応答", () => {
  const labeledSpec = () => ({
    ...SPEC,
    spec: {
      ...SPEC.spec,
      entities: [
        { name: "task", fields: { title: { type: "string", label: "やること" }, due: "date" } },
      ],
      computed: [
        {
          name: "overdue",
          entity: "task",
          type: "boolean",
          label: "期限切れ",
          expression: "due < today()",
        },
      ],
    },
  });

  it("項目と計算の label を、型付きで受け取る（受入条件）", async () => {
    const spec = labeledSpec();
    const stub = recordingFetch(() => json(200, spec));
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("一覧の応答の labels を、そのまま渡す（受入条件）", async () => {
    const view = { ...VIEW, labels: { description: "内容", shareAmount: "1 人あたり" } };
    const stub = recordingFetch(() => json(200, view));
    expect(await clientWith(stub.fetch).getView("inst-1", "expenseList")).toEqual({
      ok: true,
      value: view,
    });
  });

  it("契約と違う形は INVALID_RESPONSE（成功にしない）", async () => {
    const badFields: unknown[] = [
      { type: "string", label: "" },
      { type: "string", label: 1 },
      { type: "string", label: ["やること"] },
    ];
    for (const title of badFields) {
      const spec = { ...SPEC, spec: { ...SPEC.spec, entities: [{ name: "task", fields: { title } }] } };
      const stub = recordingFetch(() => json(200, spec));
      expect(await clientWith(stub.fetch).getSpec("inst-1"), JSON.stringify(title)).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
    // 計算の label も同じである
    const badComputed = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        computed: [
          { name: "overdue", entity: "expense", type: "boolean", label: 1, expression: "amount > 0" },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, badComputed));
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("labels の形が契約と違えば INVALID_RESPONSE（でっち上げない）", async () => {
    for (const labels of [{ description: "" }, { description: 1 }, ["a"]]) {
      const stub = recordingFetch(() => json(200, { ...VIEW, labels }));
      expect(await clientWith(stub.fetch).getView("inst-1", "expenseList"), JSON.stringify(labels)).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });

  it("displayNameOf を SDK から再輸出している（画面と読み方を共有する）", () => {
    expect(displayNameOf({ title: "やること" }, "title")).toBe("やること");
    // label を書かなければ識別子のまま
    expect(displayNameOf(undefined, "title")).toBe("title");
  });
});

// ── 項目の型（1 語の語彙。M1.3。Issue #155） ─────────────────────────
//
// 1 語の型は `FIELD_TYPES`（appspec-schema の正本）で判定する。**ここに型の名前を写すと、語彙が
// 増えたときに配信側だけが古いまま残り、正しい宣言でも `getSpec` が失敗して画面が動かなくなる**
// （#145・#154 と同じ穴。データが配られても画面が出ない、という形で効く）。

describe("項目の型（1 語の語彙）", () => {
  /** 1 語の型を 1 つ持つ task の宣言 */
  const withType = (type: string): unknown => ({
    ...SPEC,
    spec: {
      ...SPEC.spec,
      entities: [{ name: "task", fields: { title: type } }],
    },
  });

  it.each(["string", "number", "list", "date"] as const)(
    "%s を型として受け取る（日付は M1.3 で入った。受入条件）",
    async (type) => {
      const stub = recordingFetch(() => json(200, withType(type)));

      expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({ ok: true });
    },
  );

  it.each(["datetime", "boolean", "ref"])(
    "知らない 1 語の型 %s は INVALID_RESPONSE（キャストしない）",
    async (type) => {
      const stub = recordingFetch(() => json(200, withType(type)));

      expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    },
  );
});

// ── 決まった値への書き換え（set）と、条件が成り立たない断り（M1.3。Issue #156） ──
//
// **失敗を成功にしない**のはここでも同じである。409 `ACTION_NOT_ALLOWED` は
// **どの操作のどの条件か**を保って渡す（画面がそのまま見せる）。片方だけの応答は成功にしない。

describe("決まった値への書き換え（M1.3）", () => {
  const SET_ROW: ApiRow = { ...ROW, allowedActions: ["finish"] };

  it("method は POST、body は id だけ、書き換えた行が返る", async () => {
    const stub = recordingFetch(() => json(200, SET_ROW));
    const result = await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1");

    expect(stub.calls[0]?.url).toBe(`${BASE}/api/instances/inst-1/actions/finish`);
    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(stub.calls[0]?.init.body))).toEqual({ id: "t1" });
    expect(result).toEqual({ ok: true, value: SET_ROW });
  });

  it("行に allowedActions が載っていれば保つ（空の並びも意味を持つ）", async () => {
    const empty = { ...ROW, allowedActions: [] };
    const stub = recordingFetch(() => json(200, empty));
    expect(await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1")).toEqual({
      ok: true,
      value: empty,
    });
  });

  it("allowedActions の形が契約と違えば INVALID_RESPONSE（でっち上げない）", async () => {
    const stub = recordingFetch(() => json(200, { ...ROW, allowedActions: [1, 2] }));
    expect(await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("409 ACTION_NOT_ALLOWED は、操作の名前と条件を保つ（断りの理由を落とさない）", async () => {
    const stub = recordingFetch(() =>
      json(409, { error: "ACTION_NOT_ALLOWED", action: "finish", when: 'status != "done"' }),
    );
    expect(await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1")).toEqual({
      ok: false,
      error: {
        status: 409,
        code: "ACTION_NOT_ALLOWED",
        fields: [],
        validations: [],
        action: "finish",
        when: 'status != "done"',
      },
    });
  });

  it("理由が載っていなければ、欄を作らない（読み替えない）", async () => {
    const stub = recordingFetch(() => json(409, { error: "ACTION_NOT_ALLOWED" }));
    const result = await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1");

    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: "ACTION_NOT_ALLOWED", fields: [], validations: [] },
    });
    expect(result.ok === false && Object.hasOwn(result.error, "action")).toBe(false);
  });

  it("理由の形が契約と違えば INVALID_RESPONSE（片方だけは理由にならない）", async () => {
    for (const body of [
      { error: "ACTION_NOT_ALLOWED", action: "finish" },
      { error: "ACTION_NOT_ALLOWED", when: 'status != "done"' },
      { error: "ACTION_NOT_ALLOWED", action: 1, when: 2 },
    ]) {
      const stub = recordingFetch(() => json(409, body));
      expect(await clientWith(stub.fetch).setRecord("inst-1", "finish", "t1")).toEqual({
        ok: false,
        error: { status: 409, code: INVALID_RESPONSE, fields: [], validations: [] },
      });
    }
  });

  it("宣言の set と when を持つ spec を読める（配信側が新しい語彙で落ちない）", async () => {
    const spec: ApiSpecBody = {
      ...SPEC,
      spec: {
        ...SPEC.spec,
        actions: [
          { name: "addExpense", entity: "expense" },
          {
            name: "finish",
            entity: "expense",
            kind: "update",
            set: { description: "done", amount: 0 },
            when: 'description != "done"',
          },
        ],
      },
    };
    const stub = recordingFetch(() => json(200, spec));
    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: spec });
  });

  it("set の形が契約と違う spec は成功にしない", async () => {
    for (const set of [{}, { status: null }, "done"]) {
      const spec = {
        ...SPEC,
        spec: {
          ...SPEC.spec,
          actions: [{ name: "finish", entity: "expense", kind: "update", set }],
        },
      };
      const stub = recordingFetch(() => json(200, spec));
      expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
        ok: false,
        error: { code: INVALID_RESPONSE },
      });
    }
  });
});

// ── ダッシュボード（`dashboard`）と数値の部品（M1.4。Issue #180） ──────────
//
// **ダッシュボードの一覧は `entity` を持たない**（行を並べない。追記 4）。部品（`widgets`）は `number`
// だけで、`value` を要し、`label`・`unit` は任意である。受けないと `getSpec` が失敗し、画面が開かない。

describe("ダッシュボード（dashboard）と数値の部品", () => {
  const DASHBOARD_SPEC = {
    ...SPEC,
    spec: {
      ...SPEC.spec,
      views: [
        {
          name: "dashboard",
          type: "dashboard",
          widgets: [
            { type: "number", label: "今月の活動", value: "activityCount", unit: "回" },
            // `label` と `unit` は任意である
            { type: "number", value: "averageCost" },
          ],
        },
      ],
    },
  };

  it("dashboard の一覧と widgets を、型付きで受け取る（受入条件）", async () => {
    const stub = recordingFetch(() => json(200, DASHBOARD_SPEC));

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toEqual({ ok: true, value: DASHBOARD_SPEC });
  });

  it("entity を持たない一覧の応答（rows は空）を受け取る（受入条件）", async () => {
    // **`entity` が無い**（ダッシュボード）。rows は空の並びで、値は scope に載る
    const body = {
      instanceId: "inst-1",
      view: "dashboard",
      fields: [],
      computed: [],
      permissions: { read: true, write: true },
      actions: [],
      rows: [],
      scope: { activityCount: 3, averageCost: null },
    };
    const stub = recordingFetch(() => json(200, body));

    expect(await clientWith(stub.fetch).getView("inst-1", "dashboard")).toEqual({ ok: true, value: body });
  });

  it("dashboard に entity を書いた宣言は INVALID_RESPONSE（行を並べない）", async () => {
    const stub = recordingFetch(() =>
      json(200, {
        ...SPEC,
        spec: {
          ...SPEC.spec,
          views: [
            { name: "dashboard", entity: "expense", type: "dashboard", widgets: [{ type: "number", value: "activityCount" }] },
          ],
        },
      }),
    );

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("widgets の形が契約と違う dashboard は INVALID_RESPONSE", async () => {
    const badWidgets: unknown[] = [
      // widgets そのものが無い（部品が無ければダッシュボードにならない）
      undefined,
      // 空の並び
      [],
      // 知らない部品の種類
      [{ type: "bar", value: "activityCount" }],
      // `value` が無い
      [{ type: "number" }],
      // `unit` が空文字
      [{ type: "number", value: "activityCount", unit: "" }],
      // `label` が空文字
      [{ type: "number", value: "activityCount", label: "" }],
    ];
    for (const widgets of badWidgets) {
      const view: Record<string, unknown> = { name: "dashboard", type: "dashboard" };
      if (widgets !== undefined) view["widgets"] = widgets;
      const stub = recordingFetch(() => json(200, { ...SPEC, spec: { ...SPEC.spec, views: [view] } }));

      expect(await clientWith(stub.fetch).getSpec("inst-1"), JSON.stringify(widgets)).toMatchObject({
        ok: false,
        error: { status: 200, code: INVALID_RESPONSE },
      });
    }
  });

  it("dashboard 以外の一覧に widgets を書いた宣言は INVALID_RESPONSE", async () => {
    const stub = recordingFetch(() =>
      json(200, {
        ...SPEC,
        spec: {
          ...SPEC.spec,
          views: [
            { name: "expenseList", entity: "expense", widgets: [{ type: "number", value: "activityCount" }] },
          ],
        },
      }),
    );

    expect(await clientWith(stub.fetch).getSpec("inst-1")).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});
