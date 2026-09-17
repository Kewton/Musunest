// runner（warikan.ts）の試験（Issue #110）。**mock の fetch で、実環境には一切届かない。**
//
// 見るのは4つである。
//   1. SHA と版が一致すれば、A/B/C と夕食・タクシーを作り、shareAmount・paid/owed/balance・精算を採点する
//   2. **不一致・版違いでは、1つも書かない**（採点も後片付けもしない）
//   3. 途中の POST・一覧の照合を失敗させても、**後片付けは呼ばれ、支出より前にメンバーを消さない**
//   4. 後片付けが失敗したら、成功と報告しない

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMusunestClient } from "@musunest/sdk";
import { createFakeApi, type FakeApi, type FakeApiOptions } from "./__tests__/index.js";
import { DRAFT_SCHEMA_VERSION, SAMPLE_FILE, sha256Hex, runWarikan, type WarikanResult } from "./warikan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "https://staging.example";
const INSTANCE = "m12-e2e-warikan-test";

/** 原本（実物）。SHA はここから求める（live の実行と同じ道） */
const SOURCE = readFileSync(join(ROOT, SAMPLE_FILE), "utf8");
const SOURCE_SHA = await sha256Hex(SOURCE);

interface Harness {
  readonly api: FakeApi;
  readonly out: string[];
  readonly err: string[];
  run(options?: { readonly source?: string; readonly instanceId?: string }): Promise<WarikanResult>;
}

function harness(options: FakeApiOptions): Harness {
  const api = createFakeApi(options);
  const out: string[] = [];
  const err: string[] = [];
  const client = createMusunestClient({ baseUrl: BASE, fetch: api.fetch });
  return {
    api,
    out,
    err,
    run: (runOptions = {}) =>
      runWarikan({
        client,
        instanceId: runOptions.instanceId ?? INSTANCE,
        source: runOptions.source ?? SOURCE,
        expectedSchemaVersion: DRAFT_SCHEMA_VERSION,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }),
  };
}

/** 削除の action を、呼ばれた順に返す */
const deletes = (api: FakeApi): readonly string[] =>
  api.actions().filter((action) => action === "deleteExpense" || action === "deleteMember");

/** 支出の削除が、メンバーの削除より前にすべて済んでいるか（参照されているメンバーを先に消さない） */
function expensesDeletedFirst(api: FakeApi): boolean {
  const names = deletes(api);
  const firstMember = names.indexOf("deleteMember");
  const lastExpense = names.lastIndexOf("deleteExpense");
  if (firstMember === -1 || lastExpense === -1) return true;
  return lastExpense < firstMember;
}

describe("runWarikan：原本の照合と採点", () => {
  it("SHA と版が一致すれば、A/B/C と夕食・タクシーを作り、shareAmount・paid/owed/balance・精算を採点して片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA });
    const result = await h.run();

    expect(result, h.out.join("\n")).toEqual({ ok: true, reason: "" });
    const actions = h.api.actions();
    expect(actions.filter((action) => action === "addMember")).toHaveLength(3);
    expect(actions.filter((action) => action === "addExpense")).toHaveLength(2);
    // 専用データが残っていない
    expect(h.api.members()).toEqual([]);
    expect(h.api.expenses()).toEqual([]);
    expect(expensesDeletedFirst(h.api)).toBe(true);
    expect(h.out.join("\n")).toContain("採点した");
  });

  it("原本 SHA-256 が一致しなければ、1つも書かずに止まる（採点も後片付けもしない）", async () => {
    const h = harness({ sourceSha256: "0".repeat(64) });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("原本 SHA-256");
    expect(h.api.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(h.api.calls.map((call) => call.path)).toEqual([`/api/instances/${INSTANCE}/spec`]);
  });

  it("版が草案の版と違えば、1つも書かずに止まる", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, schemaVersion: "community.app-spec/v0.1" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("版");
    expect(h.api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("runWarikan：失敗の経路でも後片付けする", () => {
  it("途中の POST（タクシー）を失敗させても、作ったもの（夕食とメンバー）を支出 → メンバーの順に片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failExpense: "タクシー" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("タクシー");
    expect(deletes(h.api)).toContain("deleteExpense");
    expect(expensesDeletedFirst(h.api)).toBe(true);
    expect(h.api.members()).toEqual([]);
    expect(h.api.expenses()).toEqual([]);
  });

  it("一覧の照合（shareAmount）を失敗させても、片付けて、支出より前にメンバーを消さない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, breakView: "expenseList" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shareAmount");
    expect(deletes(h.api)).toContain("deleteExpense");
    expect(expensesDeletedFirst(h.api)).toBe(true);
    expect(h.api.members()).toEqual([]);
    expect(h.api.expenses()).toEqual([]);
  });

  it("精算（settle）の並びが違えば、値の不一致として非 0 になる", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, breakView: "settlement" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("精算");
    expect(expensesDeletedFirst(h.api)).toBe(true);
    expect(h.api.members()).toEqual([]);
    expect(h.api.expenses()).toEqual([]);
  });

  it("後片付け（メンバーの削除）が失敗したら、成功と報告しない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failDelete: "member" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("後片付け");
  });

  it("開始時に、前回の失敗の残り（参照されているメンバーを含む）を片付けてから作る", async () => {
    const h = harness({
      sourceSha256: SOURCE_SHA,
      seed: {
        members: [{ id: "member-old", name: "OLD" }],
        expenses: [{ id: "expense-old", description: "古い支出", amount: 900, payer: "member-old", participants: ["member-old"] }],
      },
    });
    const result = await h.run();

    expect(result.ok, h.out.join("\n")).toBe(true);
    const actions = h.api.actions();
    // 残りの片付け（削除）が、新しいメンバーの登録より前に来る
    expect(actions.indexOf("deleteExpense")).toBeLessThan(actions.indexOf("addMember"));
    expect(actions.indexOf("deleteMember")).toBeLessThan(actions.indexOf("addMember"));
    expect(h.api.members()).toEqual([]);
    expect(h.api.expenses()).toEqual([]);
  });
});
