// runner（dashboard.ts）の試験（Issue #183）。**mock の client で、実環境には一切届かない。**
//
// 見るのは4つである。
//   1. SHA と版が一致すれば、メンバー A・B・C と活動 5 件をそろえ、時計に依存しない値
//      （活動の行・種類ごとの件数・順位）を採点し、専用データを片付ける（活動 → メンバーの順）
//   2. **不一致・版違いでは、1つも書かない**（採点も後片付けもしない）
//   3. 一覧の照合・活動の登録を失敗させても、**後片付けは呼ばれる**
//   4. 後片付けが失敗したら、成功と報告しない

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFakeDashboardApi,
  type FakeDashboardApi,
  type FakeDashboardOptions,
} from "./__tests__/dashboard.js";
import { SAMPLE_FILE, runDashboard, type DashboardResult } from "./dashboard.js";
import { DRAFT_SCHEMA_VERSION, sha256Hex } from "./warikan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTANCE = "m12-e2e-dashboard-test";
const SOURCE = readFileSync(join(ROOT, SAMPLE_FILE), "utf8");
const SOURCE_SHA = await sha256Hex(SOURCE);

interface Harness {
  readonly api: FakeDashboardApi;
  readonly out: string[];
  readonly err: string[];
  run(options?: { readonly source?: string; readonly instanceId?: string }): Promise<DashboardResult>;
}

function harness(options: FakeDashboardOptions): Harness {
  const api = createFakeDashboardApi(options);
  const out: string[] = [];
  const err: string[] = [];
  return {
    api,
    out,
    err,
    run: (runOptions = {}) =>
      runDashboard({
        client: api.client,
        instanceId: runOptions.instanceId ?? INSTANCE,
        source: runOptions.source ?? SOURCE,
        expectedSchemaVersion: DRAFT_SCHEMA_VERSION,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }),
  };
}

const countOf = (api: FakeDashboardApi, name: string): number =>
  api.actions().filter((action) => action === name).length;

describe("runDashboard：原本の照合と採点", () => {
  it("SHA と版が一致すれば、A・B・C と活動 5 件をそろえ、採点して片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA });
    const result = await h.run();

    expect(result, h.out.join("\n")).toEqual({ ok: true, reason: "" });
    expect(countOf(h.api, "addMember")).toBe(3);
    expect(countOf(h.api, "addActivity")).toBe(5);
    // 専用データが残っていない（活動 → メンバーの順に消す）
    expect(h.api.activities()).toEqual([]);
    expect(h.api.members()).toEqual([]);
    expect(h.out.join("\n")).toContain("採点した");
  });

  it("原本 SHA-256 が一致しなければ、1つも書かずに止まる（採点も後片付けもしない）", async () => {
    const h = harness({ sourceSha256: "0".repeat(64) });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("原本 SHA-256");
    expect(h.api.actions()).toEqual([]);
    expect(h.api.calls.filter((call) => call.kind !== "getSpec")).toEqual([]);
  });

  it("版が草案の版と違えば、1つも書かずに止まる", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, schemaVersion: "community.app-spec/v0.1" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("版");
    expect(h.api.actions()).toEqual([]);
  });

  it("前回の失敗の残り（活動）を片付けてから作る", async () => {
    const h = harness({
      sourceSha256: SOURCE_SHA,
      seed: { activities: [{ id: "activity-seed-0", kind: "match", date: "2026-09-01", attendees: [], cost: 100 }] },
    });
    const result = await h.run();

    expect(result.ok, h.out.join("\n")).toBe(true);
    // 最初の片付け（削除）が、活動を作るより前に来る
    expect(h.api.actions().indexOf("deleteActivity")).toBeLessThan(h.api.actions().indexOf("addActivity"));
    expect(h.api.activities()).toEqual([]);
  });
});

describe("runDashboard：失敗の経路でも後片付けする", () => {
  it("一覧の照合（活動の行）を失敗させても、片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, breakView: "activities" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("attendeeCount");
    expect(countOf(h.api, "deleteActivity")).toBeGreaterThan(0);
    expect(h.api.activities()).toEqual([]);
    expect(h.api.members()).toEqual([]);
  });

  it("活動の登録を失敗させても、作ったものを片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failActivity: "2026-09-12" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("2026-09-12");
    expect(h.api.activities()).toEqual([]);
    expect(h.api.members()).toEqual([]);
  });

  it("後片付け（活動の削除）が失敗したら、成功と報告しない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failDelete: "activity" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("後片付け");
  });

  it("後片付け（メンバーの削除）が失敗したら、成功と報告しない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failDelete: "member" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("後片付け");
  });

  it("通信できないときは例外にする（値を含む文言は、呼ぶ側（cli.ts）が捨てる）", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, unreachable: "fetch failed: https://example/ops" });
    await expect(h.run()).rejects.toThrow();
  });
});
