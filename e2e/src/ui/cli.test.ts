// cli.ts の試験（Issue #233）。**実ブラウザは 1 回も開かない**（`launch` を差し替えて回数を数える）。
//
// 見るのは4つである。
//   1. 宛先の環境変数が無い・インスタンス ID に demo・e2e を含む、のときは**ブラウザを開かずに**非 0
//   2. 見本ごとのインスタンスは接頭辞から作る（`m15-ui` → `m15-ui-warikan`）
//   3. すべて合格したときだけ exit 0 で、レポートを書く
//   4. ログに URL・ホスト名・資格情報を出さない

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { createFakeApi, type FakeApi } from "../__tests__/index.js";
import { BASE_URL_ENV, EXIT_NG, EXIT_OK, INSTANCE_ENV, runCli, secretsOf } from "./cli.js";
import type { Scenario, Step } from "./scenarios.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** workers.dev のホスト名を使う（ログ・レポートに出ていないことを見る） */
const BASE = "https://musunest-staging-host.fixture-sub-7c2e91.workers.dev";
const INSTANCE = "m15-ui";
const TOKEN = "fixture-ci-token-3b7a9f2e";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musunest-ui-cli-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temporaryDirectories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 偽のブラウザ。**開かれた回数を数える**（1 回も開かないことを見る） */
const fakeBrowser = (): Browser =>
  ({
    newContext: async () => ({
      newPage: async () => ({ screenshot: async (): Promise<Uint8Array> => new Uint8Array([1]) }),
      close: async (): Promise<void> => {},
    }),
    close: async (): Promise<void> => {},
  }) as unknown as Browser;

const scenario = (name: string, suffix: string, steps: readonly Step[]): Scenario => ({
  name,
  suffix,
  run: async (ctx) => {
    const screenshot = await ctx.shot("open");
    return steps.map((entry) => ({ ...entry, screenshot }));
  },
});

const OK_STEP: Step = { step: "開始", ok: true, expected: "開ける", actual: "開いた" };

interface Harness {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly all: string;
  readonly launched: number;
  readonly dir: string;
}

async function cli(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly api?: FakeApi;
    readonly scenarios?: readonly Scenario[];
  } = {},
): Promise<Harness> {
  const out: string[] = [];
  const err: string[] = [];
  const dir = await tempDirectory();
  let launched = 0;
  const api = options.api ?? createFakeApi({ sourceSha256: "0".repeat(64) });
  const code = await runCli(argv, {
    env: { [BASE_URL_ENV]: BASE, [INSTANCE_ENV]: INSTANCE, ...options.env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: api.fetch,
    launch: () => {
      launched += 1;
      return Promise.resolve(fakeBrowser());
    },
    root: ROOT,
    reportDir: dir,
    now: () => new Date("2026-09-25T08:00:00.000Z"),
    readCommit: () => "abc1234",
    ...(options.scenarios === undefined ? {} : { scenarios: options.scenarios }),
  });
  return { code, out, err, all: [...out, ...err].join("\n"), launched, dir };
}

/** 宛先・ホスト名・資格情報が、出力のどこにも現れていない */
function expectNothingSecret(harness: Harness): void {
  expect(harness.all).not.toContain("workers.dev");
  expect(harness.all).not.toContain("fixture-sub-7c2e91");
  expect(harness.all).not.toContain(BASE);
  expect(harness.all).not.toContain(TOKEN);
  expect(harness.all).not.toMatch(/https?:\/\//);
}

describe("runCli：合格の経路", () => {
  it("手順がすべて合格すれば exit 0。見本ごとのインスタンスを使い、レポートを書く", async () => {
    const api = createFakeApi({ sourceSha256: "0".repeat(64) });
    const harness = await cli([], { api, scenarios: [scenario("割り勘", "warikan", [OK_STEP])] });

    expect(harness.code, harness.all).toBe(EXIT_OK);
    expect(harness.launched).toBe(1);
    expect(harness.all).toContain("e2e-ui: OK");
    expectNothingSecret(harness);
    // 見本ごとのインスタンスは、接頭辞 + 見本の名前である（デモ・e2e の ID は使わない）
    const paths = api.calls.map((call) => call.path).join("\n");
    expect(paths).toContain("/instances/m15-ui-warikan/");
    expect(paths).not.toMatch(/demo|e2e/i);
    expect(await readFile(join(harness.dir, "index.html"), "utf8")).toContain("合格");
  });

  it("項目が落ちれば exit 1（どの手順のどの項目かを出す）", async () => {
    const harness = await cli([], {
      scenarios: [scenario("割り勘", "warikan", [{ step: "精算", ok: false, expected: "1 件", actual: "0 件" }])],
    });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("割り勘 / 精算");
    expectNothingSecret(harness);
  });
});

describe("runCli：ブラウザを開く前に落とす", () => {
  it.each([
    ["宛先（SMOKE_BASE_URL）が無い", { [BASE_URL_ENV]: undefined }, "宛先が無い"],
    ["宛先が空", { [BASE_URL_ENV]: "" }, "宛先が無い"],
    ["宛先が URL として読めない", { [BASE_URL_ENV]: "not a url" }, "URL として読めない"],
    ["宛先がオリジンでない（パスを含む）", { [BASE_URL_ENV]: "https://staging.example/foo" }, "オリジンだけを書く"],
    ["インスタンス ID が無い", { [INSTANCE_ENV]: undefined }, "インスタンス ID が無い"],
    ["インスタンス ID が空", { [INSTANCE_ENV]: "" }, "インスタンス ID が無い"],
    ["インスタンス ID が demo を含む", { [INSTANCE_ENV]: "m15-demo-ui" }, "demo・e2e を含む ID は触らない"],
    ["インスタンス ID が e2e を含む", { [INSTANCE_ENV]: "m12-e2e-warikan" }, "demo・e2e を含む ID は触らない"],
    ["インスタンス ID の形が違う", { [INSTANCE_ENV]: "bad id!" }, "demo・e2e を含む ID は触らない"],
  ])("%s なら、1 回もブラウザを開かずに exit 1", async (_, env, message) => {
    const harness = await cli([], { env, scenarios: [scenario("割り勘", "warikan", [OK_STEP])] });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.launched).toBe(0);
    expect(harness.err.join("\n")).toContain(message);
    expect(harness.out.join("\n")).not.toContain("OK");
    expectNothingSecret(harness);
  });

  it("知らない引数は非 0（値は出さない）。--help は exit 0", async () => {
    const bad = await cli([BASE]);
    expect(bad.code).toBe(EXIT_NG);
    expect(bad.launched).toBe(0);
    expect(bad.err.join("\n")).toContain("引数が不正");
    expect(bad.all).not.toContain(BASE);
    expectNothingSecret(bad);

    const help = await cli(["--help"]);
    expect(help.code).toBe(EXIT_OK);
    expect(help.launched).toBe(0);
    expect(help.out[0]).toMatch(/^usage: pnpm --filter @musunest\/e2e test:ui/);
  });

  it("secretsOf は、宛先のオリジンとホスト名を伏せる対象に入れる", () => {
    const secrets = secretsOf({}, BASE);
    expect(secrets.map((secret) => secret.name)).toContain("SMOKE_BASE_URL");
    expect(secrets.map((secret) => secret.name)).toContain("宛先のホスト名");
  });
});

describe("runCli：URL・資格情報を漏らさない", () => {
  it("URL と資格情報を含む例外を差し込んでも、種別しか出さない", async () => {
    const api = createFakeApi({
      sourceSha256: "0".repeat(64),
      unreachable: `fetch failed: ${BASE}/api/instances/${INSTANCE}-warikan/spec (token ${TOKEN})`,
    });
    const harness = await cli([], { api, env: { CLOUDFLARE_API_TOKEN: TOKEN, SMOKE_PROBE_TOKEN: TOKEN } });

    expect(harness.code).toBe(EXIT_NG);
    // SDK が例外の文言を捨て、種別（NETWORK_FAILURE）にしている
    expect(harness.err.join("\n")).toContain("NETWORK_FAILURE");
    expectNothingSecret(harness);
  });

  it("結果に宛先が紛れていたら、書き出さずに exit 1（ログにも出さない）", async () => {
    const harness = await cli([], {
      scenarios: [
        scenario("割り勘", "warikan", [{ step: "開始", ok: true, expected: "開ける", actual: `${BASE}/apps/m15-ui-warikan` }]),
      ],
    });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("レポートを書けない");
    expectNothingSecret(harness);
    await expect(readFile(join(harness.dir, "index.html"))).rejects.toThrow();
  });
});
