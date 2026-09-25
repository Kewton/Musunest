// run.ts の試験（Issue #233）。**実環境には一切届かない**（偽のブラウザ・偽の手順・偽の fetch）。
//
// 見るのは5つである。
//   1. 差し込んだ手順を流し、合格ならレポートを書く（ブラウザは 1 回だけ。写真も書く）
//   2. 落ちた項目があれば不合格だが、**片付け（API）は必ず行う**（参照の向きも吸収する）
//   3. 手順が例外を投げても、落ちた項目を記録して**次の手順へ進む**
//   4. 前の片付けが失敗したら、その手順は流さずに 1 項目を記録する（空でなければ確かめられない）
//   5. 結果に宛先が紛れていたら、**レポートを書かずに**不合格にする

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { createMusunestClient } from "@musunest/sdk";
import { createFakeApi } from "../__tests__/index.js";
import type { SecretValue } from "./redact.js";
import { runUi } from "./run.js";
import type { Scenario, ScenarioContext, Step } from "./scenarios.js";

const BASE = "https://musunest-staging-host.fixture-sub-7c2e91.workers.dev";
const COMMIT = "9a7013a4c1e2d3f405162738495a6b7c8d9e0f12";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musunest-ui-run-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temporaryDirectories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 偽のブラウザ。**画面を開かない**（手順は偽なので、page の中身は使われない） */
function fakeBrowser(): { browser: Browser; contexts: () => number; closed: () => boolean } {
  let opened = 0;
  let closed = false;
  const page = { screenshot: async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]) };
  const context = { newPage: async () => page, close: async (): Promise<void> => {} };
  const browser = {
    newContext: async (): Promise<typeof context> => {
      opened += 1;
      return context;
    },
    close: async (): Promise<void> => {
      closed = true;
    },
  };
  return { browser: browser as unknown as Browser, contexts: () => opened, closed: () => closed };
}

const scenario = (name: string, suffix: string, run: (ctx: ScenarioContext) => Promise<readonly Step[]>): Scenario => ({
  name,
  suffix,
  run,
});

const step = (overrides: Partial<Step> = {}): Step => ({
  step: "開始",
  ok: true,
  expected: "開ける",
  actual: "開いた",
  ...overrides,
});

interface HarnessOptions {
  readonly seed?: Parameters<typeof createFakeApi>[0]["seed"];
  readonly failDelete?: "expense" | "member";
}

async function harness(options: HarnessOptions = {}) {
  const api = createFakeApi({
    sourceSha256: "0".repeat(64),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.failDelete === undefined ? {} : { failDelete: options.failDelete }),
  });
  const client = createMusunestClient({ baseUrl: "https://staging.example", fetch: api.fetch });
  const { browser, contexts, closed } = fakeBrowser();
  return { api, client, browser, contexts, closed };
}

const common = (dir: string) => ({
  baseUrl: "https://staging.example",
  instanceId: "m15-ui",
  reportDir: dir,
  now: () => new Date("2026-09-25T08:00:00.000Z"),
  commit: COMMIT,
  out: () => {},
  err: () => {},
});

describe("runUi：合格と、レポートの書き出し", () => {
  it("差し込んだ手順を流し、合格ならレポートを書く（ブラウザは 1 回・写真も書く）", async () => {
    const dir = await tempDirectory();
    const { api, client, browser, contexts, closed } = await harness({
      seed: { members: [{ id: "member-old", name: "OLD" }] },
    });

    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.resolve(browser),
      secrets: [],
      scenarios: [
        scenario("割り勘", "warikan", async (ctx) => [step({ screenshot: await ctx.shot("open") })]),
      ],
    });

    expect(result.ok, result.reason).toBe(true);
    expect(contexts()).toBe(1);
    expect(closed()).toBe(true);
    // 前の片付けは API で行う（画面の手順の外）
    expect(api.members()).toEqual([]);
    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toContain("合格");
    expect(html).toContain(COMMIT);
    expect(await readdir(join(dir, "shots"))).toEqual(["warikan-open.png"]);
    expect(html).toContain("warikan-open.png");
  });

  it("ブラウザを開けなければ、手順を流さずに不合格にする", async () => {
    const dir = await tempDirectory();
    const { client } = await harness();
    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.reject(new Error(`開けない ${BASE}`)),
      secrets: [],
      scenarios: [scenario("割り勘", "warikan", async () => [step()])],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ブラウザを開けない");
    expect(result.steps).toEqual([]);
  });
});

describe("runUi：落ちても片付ける", () => {
  it("項目が落ちれば不合格。それでも片付けは呼ばれ、前の残り（参照されているメンバー）も消える", async () => {
    const dir = await tempDirectory();
    const { api, client, browser } = await harness({
      seed: {
        members: [{ id: "member-old", name: "OLD" }],
        expenses: [{ id: "expense-old", description: "古い支出", amount: 900, payer: "member-old", participants: ["member-old"] }],
      },
    });

    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.resolve(browser),
      secrets: [],
      scenarios: [
        scenario("割り勘", "warikan", async () => [step({ step: "精算", ok: false, expected: "1 件", actual: "0 件" })]),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("合格でない項目");
    expect(api.actions()).toContain("deleteExpense");
    expect(api.members()).toEqual([]);
    expect(api.expenses()).toEqual([]);
    expect(result.steps).toHaveLength(1);
  });

  it("手順が例外を投げても、落ちた項目を記録して次の手順へ進む", async () => {
    const dir = await tempDirectory();
    const { client, browser } = await harness();

    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.resolve(browser),
      secrets: [],
      scenarios: [
        scenario("割り勘", "warikan", () => Promise.reject(new Error("boom"))),
        scenario("タスク管理", "task-board", async () => [step()]),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.steps.map((entry) => entry.scenario)).toEqual(["割り勘", "タスク管理"]);
    expect(result.steps[0]?.actual).toContain("予期しない失敗");
    expect(result.steps[1]?.ok).toBe(true);
  });

  it("前の片付けが失敗したら、その手順は流さずに 1 項目を記録する", async () => {
    const dir = await tempDirectory();
    const { client, browser } = await harness({
      failDelete: "member",
      seed: { members: [{ id: "member-old", name: "OLD" }] },
    });
    let ran = false;

    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.resolve(browser),
      secrets: [],
      scenarios: [
        scenario("割り勘", "warikan", async () => {
          ran = true;
          return [step()];
        }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.step).toBe("前の片付け（API）");
    expect(result.steps[0]?.ok).toBe(false);
  });
});

describe("runUi：宛先が紛れたら、レポートを書かない", () => {
  it("結果に URL があれば、書き出しに失敗して不合格になる", async () => {
    const dir = await tempDirectory();
    const { client, browser } = await harness();
    const secrets: readonly SecretValue[] = [{ name: "SMOKE_BASE_URL", value: BASE }];

    const result = await runUi({
      ...common(dir),
      client,
      launch: () => Promise.resolve(browser),
      secrets,
      scenarios: [scenario("割り勘", "warikan", async () => [step({ actual: `${BASE}/apps/m15-ui-warikan` })])],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("レポートを書けない");
    await expect(readFile(join(dir, "index.html"))).rejects.toThrow();
  });
});
