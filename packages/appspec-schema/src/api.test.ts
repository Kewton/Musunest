// data-api が公開する HTTP の契約（Issue #102）の unit テスト。
//
// ここが確かめるのは 3 つである。
//   1. 経路（path）— 組み立てと読み取りが 1 対 1 で、契約の 3 経路以外を経路にしない
//   2. 誤りコードと HTTP ステータス — Issue #102 が決めた対応（400 / 403 / 404 / 405 / 422 / 503）
//   3. 境界 — **この file が Cloudflare にも Worker にも依存しないこと。** 画面（host）と data-api は
//      ここを共有するので、ここが Worker を巻き込むと、両方が Worker を解決しようとする
//
// 3 はソースの走査で見る（Worker を import していれば、このテストは workerd の外で動くので
// import した時点で落ちるが、「import していないだけ」の偶然と区別できないため、字面でも確かめる）。
import { describe, expect, it } from "vitest";
import {
  API_ACTIONS_SEGMENT,
  API_CREATED_STATUS,
  API_ERROR_CODES,
  API_ERROR_STATUS,
  API_PREFIX,
  API_READ_STATUS,
  API_SPEC_SEGMENT,
  API_VIEWS_SEGMENT,
  apiActionPath,
  apiErrorBody,
  apiRouteMethod,
  apiSpecPath,
  apiViewPath,
  readApiRoute,
  type ApiErrorCode,
} from "./api.js";

interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;

const apiSource = fs.readFileSync(new URL("./api.ts", import.meta.url), "utf8");

describe("経路（api.ts）", () => {
  it("組み立てたパスを、そのまま経路として読める", () => {
    expect(apiSpecPath("inst-1")).toBe("/api/instances/inst-1/spec");
    expect(apiViewPath("inst-1", "expenseList")).toBe("/api/instances/inst-1/views/expenseList");
    expect(apiActionPath("inst-1", "addExpense")).toBe("/api/instances/inst-1/actions/addExpense");

    expect(readApiRoute(apiSpecPath("inst-1"))).toEqual({ kind: "spec", instanceId: "inst-1" });
    expect(readApiRoute(apiViewPath("inst-1", "expenseList"))).toEqual({
      kind: "view",
      instanceId: "inst-1",
      viewName: "expenseList",
    });
    expect(readApiRoute(apiActionPath("inst-1", "addExpense"))).toEqual({
      kind: "action",
      instanceId: "inst-1",
      actionName: "addExpense",
    });
  });

  it("値に含まれる記号は符号化する（区切りと取り違えない）", () => {
    const path = apiViewPath("a/b", "c d");
    expect(path).toBe("/api/instances/a%2Fb/views/c%20d");
    expect(readApiRoute(path)).toEqual({ kind: "view", instanceId: "a/b", viewName: "c d" });
  });

  it("末尾の `/` は同じ経路として読む", () => {
    expect(readApiRoute("/api/instances/inst-1/spec/")).toEqual({
      kind: "spec",
      instanceId: "inst-1",
    });
  });

  it.each([
    ["契約に無い欄", "/api/instances/inst-1/records"],
    ["知らない区分", "/api/instances/inst-1/things/x"],
    ["インスタンスだけ", "/api/instances/inst-1"],
    ["instance が無い", "/api/instances//spec"],
    ["深すぎる", "/api/instances/inst-1/views/expenseList/rows"],
    ["区切りが空", "/api/instances/inst-1/views//x"],
    ["別の API", "/api/apps/inst-1/spec"],
    ["API でない", "/healthz"],
    ["ルート", "/"],
    ["読めないパーセント符号", "/api/instances/%zz/spec"],
  ])("%s は経路にしない（404 になる）", (_label, pathname) => {
    expect(readApiRoute(pathname)).toBeNull();
  });

  it("読取は GET、操作は POST（ほかは 405 の材料になる）", () => {
    expect(apiRouteMethod({ kind: "spec", instanceId: "i" })).toBe("GET");
    expect(apiRouteMethod({ kind: "view", instanceId: "i", viewName: "v" })).toBe("GET");
    expect(apiRouteMethod({ kind: "action", instanceId: "i", actionName: "a" })).toBe("POST");
  });

  it("経路の先頭と区分の名前は定数で固定する（ずれたら読めなくなる）", () => {
    expect(API_PREFIX).toBe("/api/instances");
    expect([API_SPEC_SEGMENT, API_VIEWS_SEGMENT, API_ACTIONS_SEGMENT]).toEqual([
      "spec",
      "views",
      "actions",
    ]);
    expect(apiSpecPath("i").startsWith(API_PREFIX)).toBe(true);
  });
});

describe("誤りコードと HTTP ステータス（Issue #102 の案）", () => {
  it("コードとステータスの対応は、契約の案のとおりである", () => {
    expect(API_ERROR_STATUS).toEqual({
      INVALID_JSON: 400,
      INPUT_REJECTED: 422,
      PERMISSION_DENIED: 403,
      NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      SPEC_UNAVAILABLE: 503,
      // 参照されているレコードの削除（M1.2）。**列挙する欄である**（隠さない）
      REFERENCE_IN_USE: 409,
      // 操作の条件（when）が成り立たない行への操作（M1.3）。**INPUT_REJECTED を使い回さない**
      ACTION_NOT_ALLOWED: 409,
    });
    // コードの一覧とステータスの一覧がずれない（足し忘れをここで止める）
    expect(new Set(Object.keys(API_ERROR_STATUS))).toEqual(new Set(API_ERROR_CODES));
  });

  it("成功のステータスは 200 と 201（**成功に見せかけた空の応答を作らない**）", () => {
    expect(API_READ_STATUS).toBe(200);
    expect(API_CREATED_STATUS).toBe(201);
    // 成功のステータスに、誤りのコードは 1 つも混ざらない
    for (const code of API_ERROR_CODES) expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });

  it("INPUT_REJECTED だけが項目名と検査名を載せる", () => {
    expect(apiErrorBody("INPUT_REJECTED", { fields: ["amount"], validations: [] })).toEqual({
      error: "INPUT_REJECTED",
      fields: ["amount"],
      validations: [],
    });
    expect(
      apiErrorBody("INPUT_REJECTED", { fields: [], validations: ["positiveAmount"] }),
    ).toEqual({ error: "INPUT_REJECTED", fields: [], validations: ["positiveAmount"] });
    // 引数を渡し忘れても、空の配列として載る（キーが消えると読む側が分岐を間違える）
    expect(apiErrorBody("INPUT_REJECTED")).toEqual({
      error: "INPUT_REJECTED",
      fields: [],
      validations: [],
    });
    for (const code of API_ERROR_CODES.filter(
      (candidate): candidate is Exclude<ApiErrorCode, "INPUT_REJECTED"> =>
        candidate !== "INPUT_REJECTED",
    )) {
      expect(apiErrorBody(code)).toEqual({ error: code });
      expect(Object.keys(apiErrorBody(code))).toEqual(["error"]);
    }
  });

  it("REFERENCE_IN_USE だけが参照元と件数を載せる（M1.2）", () => {
    const references = [
      { entity: "expense", field: "payer", count: 1 },
      { entity: "expense", field: "participants", count: 2 },
    ];
    expect(apiErrorBody("REFERENCE_IN_USE", { references })).toEqual({
      error: "REFERENCE_IN_USE",
      references,
    });
    // 参照元が無ければ欄を載せない（空の並びで「参照元が無い」と言わない。そのときは 409 にならない）
    expect(apiErrorBody("REFERENCE_IN_USE")).toEqual({ error: "REFERENCE_IN_USE" });
    expect(apiErrorBody("REFERENCE_IN_USE", { references: [] })).toEqual({ error: "REFERENCE_IN_USE" });
    // ほかの誤りには載らない
    expect(apiErrorBody("NOT_FOUND", { references })).toEqual({ error: "NOT_FOUND" });
  });
});

describe("操作の条件（when）の断り（M1.3。Issue #156）", () => {
  it("ACTION_NOT_ALLOWED だけが、どの操作のどの条件かを載せる", () => {
    expect(apiErrorBody("ACTION_NOT_ALLOWED", { action: "finish", when: 'status != "done"' })).toEqual({
      error: "ACTION_NOT_ALLOWED",
      action: "finish",
      when: 'status != "done"',
    });
    // **両方揃っているときだけ載せる**（片方だけでは「どの操作のどの条件か」にならない）
    expect(apiErrorBody("ACTION_NOT_ALLOWED", { action: "finish" })).toEqual({
      error: "ACTION_NOT_ALLOWED",
    });
    expect(apiErrorBody("ACTION_NOT_ALLOWED", { when: "x" })).toEqual({ error: "ACTION_NOT_ALLOWED" });
    expect(apiErrorBody("ACTION_NOT_ALLOWED")).toEqual({ error: "ACTION_NOT_ALLOWED" });
    // ほかの誤りには載らない
    expect(apiErrorBody("NOT_FOUND", { action: "finish", when: "x" })).toEqual({ error: "NOT_FOUND" });
  });

  it("INPUT_REJECTED とは別のコードである（画面の出し方が変わる）", () => {
    expect(API_ERROR_CODES).toContain("ACTION_NOT_ALLOWED");
    expect(API_ERROR_STATUS.ACTION_NOT_ALLOWED).toBe(409);
    expect(API_ERROR_STATUS.ACTION_NOT_ALLOWED).not.toBe(API_ERROR_STATUS.INPUT_REJECTED);
  });
});

describe("境界（api.ts は Worker を巻き込まない）", () => {
  it.each([
    "cloudflare:workers",
    "@cloudflare/workers-types",
    "@musunest/app-do",
    "@musunest/data-api",
    "node:",
    "DataApiEnv",
    "AppInstanceDO",
    "D1Database",
    "R2Bucket",
    "DurableObjectNamespace",
  ])("%s を参照しない", (token) => {
    expect(apiSource).not.toContain(token);
  });

  it("依存は宣言の型（./spec.js）だけである", () => {
    const imported = [...apiSource.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(imported)).toEqual(new Set(["./spec.js"]));
  });
});
