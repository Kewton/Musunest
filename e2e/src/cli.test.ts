// CLI（cli.ts）の試験（Issue #110）。**mock の fetch で、実環境には一切届かない。**
//
// 見るのは4つである。
//   1. 宛先・インスタンスの欠落は、1つも叩かずに非 0（何もしなかったことを 0 と報告しない）
//   2. 終了 0 は、SHA・値・後片付けのすべてが成功したときだけ
//   3. URL を含む例外を差し込んでも、ログに URL・ホスト名・資格情報が現れない
//   4. 引数の誤りは、値を表示せずに非 0

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi, type FakeApiOptions } from "./__tests__/index.js";
import { BASE_URL_ENV, EXIT_NG, EXIT_OK, INSTANCE_ENV, SAMPLE_ENV, SOURCE_ENV, runCli } from "./cli.js";
import { SAMPLE_FILE, sha256Hex } from "./warikan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** workers.dev のホスト名を使う（ログに出ていないことを見る） */
const BASE = "https://musunest-staging-host.fixture-sub-7c2e91.workers.dev";
const INSTANCE = "m12-e2e-warikan-cli-test";
const TOKEN = "fixture-ci-token-3b7a9f2e";

const SOURCE = readFileSync(join(ROOT, SAMPLE_FILE), "utf8");
const SOURCE_SHA = await sha256Hex(SOURCE);

/**
 * 工場の納品物から取り出した宣言の原本の見立て（`E2E_SOURCE_FILE` で渡すパス）。
 * 中身は照合先の SHA-256 にしか使わないので、見本の原本と違う文字列であればよい。
 */
const SOURCE_FILE_PATH = "/factory/delivery/m12-warikan/app.spec.yaml";
const DELIVERED_SOURCE = "delivered: app.spec.yaml\n";
const DELIVERED_SHA = await sha256Hex(DELIVERED_SOURCE);
/** `E2E_SOURCE_FILE` のときだけ納品物を返し、それ以外は見本の原本を返す（どちらを読んだかを見る） */
const readByPath = (path: string): string => (path === resolve(ROOT, SOURCE_FILE_PATH) ? DELIVERED_SOURCE : SOURCE);

interface Harness {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly all: string;
  readonly api: FakeApi | undefined;
}

async function cli(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly apiOptions?: FakeApiOptions;
    readonly api?: FakeApi;
    readonly readFile?: (path: string) => string;
  } = {},
): Promise<Harness> {
  const api = options.api ?? (options.apiOptions === undefined ? undefined : createFakeApi(options.apiOptions));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { [BASE_URL_ENV]: BASE, [INSTANCE_ENV]: INSTANCE, ...options.env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: api?.fetch ?? (() => Promise.reject(new Error(`no fetch (${BASE})`))),
    readFile: options.readFile ?? (() => SOURCE),
    root: ROOT,
  });
  return { code, out, err, all: [...out, ...err].join("\n"), api };
}

/** 宛先・ホスト名・資格情報が、出力のどこにも現れていない */
function expectNothingSecret(harness: Harness): void {
  expect(harness.all).not.toContain("workers.dev");
  expect(harness.all).not.toContain("fixture-sub-7c2e91");
  expect(harness.all).not.toContain(BASE);
  expect(harness.all).not.toContain(TOKEN);
  expect(harness.all).not.toMatch(/https?:\/\//);
}

describe("runCli：成功と、終了 0 の条件", () => {
  it("SHA・値・後片付けがすべて成功したときだけ exit 0。ログに宛先を出さない", async () => {
    const harness = await cli([], { apiOptions: { sourceSha256: SOURCE_SHA } });

    expect(harness.code, harness.all).toBe(EXIT_OK);
    expect(harness.out.join("\n")).toContain("e2e: OK");
    expect(harness.api?.members()).toEqual([]);
    expect(harness.api?.expenses()).toEqual([]);
    expectNothingSecret(harness);
  });

  it("原本 SHA-256 が一致しなければ exit 1（採点を報告しない）", async () => {
    const harness = await cli([], { apiOptions: { sourceSha256: "0".repeat(64) } });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("原本 SHA-256");
    expect(harness.out.join("\n")).not.toContain("OK");
    expectNothingSecret(harness);
  });

  it("採点の値が一致しなければ exit 1", async () => {
    const harness = await cli([], { apiOptions: { sourceSha256: SOURCE_SHA, breakView: "expenseList" } });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("shareAmount");
    expect(harness.out.join("\n")).not.toContain("OK");
  });

  it("後片付けに失敗したら exit 1", async () => {
    const harness = await cli([], { apiOptions: { sourceSha256: SOURCE_SHA, failDelete: "member" } });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("後片付け");
  });
});

describe("runCli：照合先の原本（E2E_SOURCE_FILE）", () => {
  it("渡すと、そのファイルの SHA-256 を照合先にする（見本の原本の SHA では通らない）", async () => {
    const delivered = await cli([], {
      env: { [SOURCE_ENV]: SOURCE_FILE_PATH },
      apiOptions: { sourceSha256: DELIVERED_SHA },
      readFile: readByPath,
    });
    expect(delivered.code, delivered.all).toBe(EXIT_OK);
    expect(delivered.out.join("\n")).toContain("e2e: OK");

    // 見本の原本の SHA を照合先にしていると、渡したファイルを読んでいないことになる
    const sample = await cli([], {
      env: { [SOURCE_ENV]: SOURCE_FILE_PATH },
      apiOptions: { sourceSha256: SOURCE_SHA },
      readFile: readByPath,
    });
    expect(sample.code).toBe(EXIT_NG);
    expect(sample.err.join("\n")).toContain("原本 SHA-256");
  });

  it("渡さなければ今までどおり見本の原本を使う（差し替えのパスは読まない）", async () => {
    const harness = await cli([], {
      apiOptions: { sourceSha256: SOURCE_SHA },
      readFile: (path) => {
        if (path === resolve(ROOT, SOURCE_FILE_PATH)) throw new Error("E2E_SOURCE_FILE を読んではいけない");
        return SOURCE;
      },
    });

    expect(harness.code, harness.all).toBe(EXIT_OK);
  });

  it("そのファイルを読めないときは exit 1。パスを出さない", async () => {
    const harness = await cli([], {
      env: { [SOURCE_ENV]: SOURCE_FILE_PATH },
      apiOptions: { sourceSha256: DELIVERED_SHA },
      readFile: () => {
        throw new Error(`ENOENT ${SOURCE_FILE_PATH}`);
      },
    });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("原本");
    expect(harness.all).not.toContain(SOURCE_FILE_PATH);
  });
});

describe("runCli：欠落は叩く前の失敗にする", () => {
  it.each([
    ["宛先（SMOKE_BASE_URL）が無い", { [BASE_URL_ENV]: undefined }, "宛先が無い"],
    ["宛先が空", { [BASE_URL_ENV]: "" }, "宛先が無い"],
    ["インスタンス ID が無い", { [INSTANCE_ENV]: undefined }, "インスタンス ID が無い"],
    ["インスタンス ID が空", { [INSTANCE_ENV]: "" }, "インスタンス ID が無い"],
    ["デモのインスタンスを指している", { [INSTANCE_ENV]: "m12-demo-warikan" }, "demo を含む ID は触らない"],
    ["宛先が URL として読めない", { [BASE_URL_ENV]: "not a url" }, "URL として読めない"],
    ["宛先がオリジンでない（パスを含む）", { [BASE_URL_ENV]: "https://staging.example/foo" }, "オリジンだけを書く"],
    ["知らない見本を選んでいる", { [SAMPLE_ENV]: "no-such-sample" }, "のどれかを渡す"],
  ])("%s なら、1つも叩かずに exit 1（値を出さない）", async (_, env, message) => {
    const harness = await cli([], { env, apiOptions: { sourceSha256: SOURCE_SHA } });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain(message);
    expect(harness.out.join("\n")).not.toContain("OK");
    expectNothingSecret(harness);
  });
});

describe("runCli：URL・資格情報を漏らさない", () => {
  it("URL と資格情報を含む例外を差し込んでも、種別しか出さない", async () => {
    const api = createFakeApi({
      sourceSha256: SOURCE_SHA,
      unreachable: `fetch failed: ${BASE}/api/instances/${INSTANCE}/spec (token ${TOKEN})`,
    });
    const harness = await cli([], {
      api,
      env: { CLOUDFLARE_API_TOKEN: TOKEN, SMOKE_PROBE_TOKEN: TOKEN },
    });

    expect(harness.code).toBe(EXIT_NG);
    // SDK が例外の文言を捨て、種別（NETWORK_FAILURE）にしている
    expect(harness.err.join("\n")).toContain("NETWORK_FAILURE");
    expectNothingSecret(harness);
  });

  it("原本を読めない（例外の文言に URL と資格情報が入っていても）exit 1。値は出さない", async () => {
    const harness = await cli([], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      readFile: () => {
        throw new Error(`ENOENT ${BASE}?token=${TOKEN}`);
      },
    });

    expect(harness.code).toBe(EXIT_NG);
    expect(harness.err.join("\n")).toContain("原本");
    expectNothingSecret(harness);
  });
});

describe("runCli：引数", () => {
  it("知らない引数は非 0（値を出さない）。--help は exit 0", async () => {
    const bad = await cli([BASE]);
    expect(bad.code).toBe(EXIT_NG);
    expect(bad.err.join("\n")).toContain("引数が不正");
    expect(bad.all).not.toContain(BASE);
    expectNothingSecret(bad);

    const help = await cli(["--help"]);
    expect(help.code).toBe(EXIT_OK);
    expect(help.out[0]).toMatch(/^usage: pnpm --filter @musunest\/e2e test:staging/);
  });
});
