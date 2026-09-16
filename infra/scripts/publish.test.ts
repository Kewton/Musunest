// publish の入口（infra/scripts/publish.ts）の試験（Issue #101）。**実環境には一切届かない**
// （動かす Cloudflare の API は偽物だけ）。
//
//   1. 引数の誤り（--env の欠落・未知の env・production 指定・--instance・--spec・知らないオプション・位置引数）は、
//      API を呼ばずに非 0 で終わる
//   2. 資格情報の不足・production のアカウント・原本不存在は、API を呼ばずに非 0 で終わる
//   3. 成功：原本と正規化した JSON の 2 個を、原本 SHA を含む決定的なキーへ PUT し、D1 には束縛引数で登録する。
//      出力は 版・原本 SHA・インスタンス ID（受入条件 2・5）
//   4. 失敗の差し込み（R2 の 1 個目・2 個目・D1 のアプリ・インスタンス）は成功を返さず、そこから先を行わない（受入条件 4）
//   5. 例外・応答の本文にトークン・Account ID・バケット名・URL が混ざっても、stdout/stderr に出ない（受入条件 5）
//
// fetch は偽物を差し込み、config と原本の読み取りは CliIo.readFile を差し替える（実ファイルの原本は読まない）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXIT_NG,
  EXIT_OK,
  PUBLISHABLE_ENVS,
  d1QueryPath,
  parseD1Results,
  r2ObjectPath,
  readCredentials,
  readPublishTarget,
  runCli,
  type CliIo,
} from "./publish.ts";
import { ENVS } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(ROOT, "packages/data-api/wrangler.jsonc");
const CONFIG = readFileSync(CONFIG_PATH, "utf8");

/** 検査を通る、最小の宣言（spec-engine のテストと同じ形） */
const DECLARATION = [
  "entities:",
  "  - name: expense",
  "    fields:",
  "      amount: number",
  "      participants: list",
  "views: []",
  "actions: []",
  "validations:",
  "  - name: positiveAmount",
  "    entity: expense",
  "    expression: amount > 0",
  "computed:",
  "  - name: headcount",
  "    entity: expense",
  "    expression: len(participants)",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 目印。トークン・Account ID・バケット名・URL の代わり */
const TOKEN = "fixture-token-6f2a9c1d";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const PROD_ACCOUNT = "fedcba9876543210fedcba9876543210";
const BUCKET = "musunest-dev-bundles";
const URL_SENTINEL = "https://api.cloudflare.com/client/v4/accounts";
const MARKERS = [TOKEN, ACCOUNT, PROD_ACCOUNT, BUCKET, URL_SENTINEL, "cloudflare.com"];

const SPEC_ARG = "packages/appspec-schema/samples/expense-log/app.spec.yaml";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

/** Cloudflare の API の偽物。R2 へは PUT、D1 へは POST が来る。 */
class FakeCloudflare {
  readonly calls: Call[] = [];
  failR2At = 0;
  failD1At = 0;
  /** 設定すると、次の fetch がこれを投げる（URL に目印を載せた例外の再現に使う） */
  throwOnce: unknown;
  /** 設定すると、D1 が JSON でない本文を返す（壊れた応答の再現に使う） */
  rawD1Body: string | null = null;
  #r2 = 0;
  #d1 = 0;
  readonly #apps = new Map<string, Record<string, unknown>>();
  readonly #instances = new Map<string, Record<string, unknown>>();

  handle(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    if (this.throwOnce !== undefined) {
      const thrown = this.throwOnce;
      this.throwOnce = undefined;
      throw thrown;
    }
    if (url.includes("/r2/buckets/")) {
      this.#r2 += 1;
      if (this.failR2At !== 0 && this.#r2 === this.failR2At) {
        return Promise.resolve(
          Response.json({ success: false, errors: [{ code: 10000, message: `denied ${ACCOUNT} ${BUCKET} ${url}` }] }, { status: 500 }),
        );
      }
      return Promise.resolve(Response.json({ success: true, result: {} }));
    }
    if (url.includes("/d1/database/")) {
      this.#d1 += 1;
      if (this.rawD1Body !== null) return Promise.resolve(new Response(this.rawD1Body, { status: 200 }));
      if (this.failD1At !== 0 && this.#d1 === this.failD1At) {
        return Promise.resolve(Response.json({ success: false, errors: [{ code: 7500, message: `denied ${ACCOUNT} ${url}` }] }, { status: 500 }));
      }
      return Promise.resolve(Response.json(this.#answer(init?.body)));
    }
    return Promise.resolve(Response.json({ success: false }, { status: 404 }));
  }

  /** D1 の応答を、来た束縛引数から組み立てる（登録の読み書きの最小の再現） */
  #answer(raw: unknown): unknown {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as { batch: { sql: string; params: string[] }[] }) : { batch: [] };
    const result = parsed.batch.map(({ sql, params }) => {
      if (sql.includes("INSERT INTO apps")) {
        const [sha, version, sourceKey, normalizedKey] = params;
        if (sha !== undefined && !this.#apps.has(sha)) {
          this.#apps.set(sha, {
            source_sha256: sha,
            schema_version: version,
            source_key: sourceKey,
            normalized_key: normalizedKey,
            created_at: "2026-09-16T00:00:00.000Z",
          });
        }
        return { results: [], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("INSERT INTO app_instances")) {
        const [instanceId, sha] = params;
        if (instanceId !== undefined && sha !== undefined && this.#apps.has(sha) && !this.#instances.has(instanceId)) {
          this.#instances.set(instanceId, { instance_id: instanceId, source_sha256: sha, created_at: "2026-09-16T00:00:00.000Z" });
        }
        return { results: [], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("FROM app_instances")) {
        const [instanceId] = params;
        const row = instanceId === undefined ? undefined : this.#instances.get(instanceId);
        return { results: row === undefined ? [] : [row], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("FROM apps")) {
        const [sha] = params;
        const row = sha === undefined ? undefined : this.#apps.get(sha);
        return { results: row === undefined ? [] : [row], success: true, meta: { changes: 0 } };
      }
      throw new Error("偽の D1 が知らない文");
    });
    return { success: true, result };
  }
}

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly all: string;
  readonly calls: readonly Call[];
}

async function publish(
  argv: readonly string[],
  options: { env?: Readonly<Record<string, string | undefined>>; cloudflare?: FakeCloudflare; spec?: string | null } = {},
): Promise<Run> {
  const cloudflare = options.cloudflare ?? new FakeCloudflare();
  const out: string[] = [];
  const err: string[] = [];
  const spec = options.spec === undefined ? DECLARATION : options.spec;
  const io: CliIo = {
    root: ROOT,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...options.env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: (input, init) => cloudflare.handle(String(input), init),
    readFile: (path) => {
      if (path === CONFIG_PATH) return CONFIG;
      if (spec === null) throw new Error("ENOENT");
      return spec;
    },
    requestTimeoutMs: 5_000,
  };
  const code = await runCli(argv, io);
  return { code, out, err, all: [...out, ...err].join("\n"), calls: cloudflare.calls };
}

const dev = (extra: readonly string[] = []): string[] => ["--env", "dev", "--instance", "e2e-expense-log", "--spec", SPEC_ARG, ...extra];

/** 目印が1つも出ていない。 */
function expectNothingSecret(run: Run): void {
  for (const marker of MARKERS) expect(run.all).not.toContain(marker);
  expect(run.all).not.toMatch(/https?:\/\//);
}

describe("引数と資格情報の誤りは、API を呼ばずに非 0 で終わる", () => {
  it("--help は使い方を出して exit 0。API を呼ばない", async () => {
    const run = await publish(["--help"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([]);
    expect(run.out[0]).toMatch(/^usage: pnpm exec tsx infra\/scripts\/publish\.ts --env <dev\|staging>/);
  });

  const ARG_CASES: readonly { readonly name: string; readonly argv: readonly string[]; readonly message: string }[] = [
    { name: "--env が無い", argv: ["--instance", "x", "--spec", SPEC_ARG], message: "--env が無い" },
    { name: "未知の env（値を出さない）", argv: ["--env", URL_SENTINEL, "--instance", "x", "--spec", SPEC_ARG], message: "未知の env" },
    { name: "--instance が無い", argv: ["--env", "dev", "--spec", SPEC_ARG], message: "--instance が無い" },
    { name: "--instance が形に合わない（値を出さない）", argv: ["--env", "dev", "--instance", `${URL_SENTINEL}/x`, "--spec", SPEC_ARG], message: "--instance は" },
    { name: "--spec が無い", argv: ["--env", "dev", "--instance", "x"], message: "--spec が無い" },
    { name: "知らないオプション", argv: ["--env", "dev", "--instance", "x", "--spec", SPEC_ARG, "--yes"], message: "引数が不正: 知らないオプションがある" },
    { name: "位置引数（値を出さない）", argv: ["--env", "dev", "--instance", "x", SPEC_ARG], message: "引数が不正: 位置引数は取らない" },
  ];

  it.each(ARG_CASES)("$name", async ({ argv, message }) => {
    const run = await publish(argv);
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.err[0]).toContain(`publish: ${message}`);
    expectNothingSecret(run);
  });

  it.each(ENVS.filter((env) => !PUBLISHABLE_ENVS.includes(env)).map((env) => ({ env })))("--env $env は、書き込みの前に断る", async ({ env }) => {
    const run = await publish(["--env", env, "--instance", "x", "--spec", SPEC_ARG]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.err[0]).toContain(`--env ${env} へは publish しない（書き込みの前に断る）`);
  });

  const CREDENTIAL_CASES: readonly { readonly name: string; readonly env: Readonly<Record<string, string | undefined>>; readonly message: string }[] = [
    { name: "トークンが無い", env: { CLOUDFLARE_API_TOKEN: undefined }, message: "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る" },
    { name: "Account ID が無い", env: { CLOUDFLARE_ACCOUNT_ID: undefined }, message: "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る" },
    { name: "Account ID の形でない", env: { CLOUDFLARE_ACCOUNT_ID: "fixture-not-an-account" }, message: "CLOUDFLARE_ACCOUNT_ID が Account ID の形" },
    { name: "トークンに空白がある", env: { CLOUDFLARE_API_TOKEN: `${TOKEN} x` }, message: "CLOUDFLARE_API_TOKEN にヘッダに載せられない文字" },
    { name: "production のアカウント", env: { CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT }, message: "CLOUDFLARE_ACCOUNT_ID が production のアカウント" },
  ];

  it.each(CREDENTIAL_CASES)("$name なら、API を呼ばずに exit 1。値は出さない", async ({ env, message }) => {
    const run = await publish(dev(), { env });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.err[0]).toContain(`publish: ${message}`);
    expectNothingSecret(run);
    expect(run.all).not.toContain("fixture-not-an-account");
  });

  it("原本が読めなければ、API を呼ばずに exit 1", async () => {
    const run = await publish(dev(), { spec: null });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.err[0]).toContain("publish: 原本を読めない（--spec のパス");
  });
});

describe("成功：2 個のオブジェクトを決定的なキーへ置き、D1 へ束縛引数で登録する", () => {
  it("版・原本 SHA・インスタンス ID を出して exit 0。PUT の本文と、束縛引数を確かめる", async () => {
    const run = await publish(dev());
    expect(run.code, run.all).toBe(EXIT_OK);

    const sha = /原本 SHA ([0-9a-f]{64})/.exec(run.all)?.[1] ?? "";
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(run.out.at(-1)).toBe(
      `publish: OK  env=dev: 版 community.app-spec/v0.2-draft / 原本 SHA ${sha} / インスタンス e2e-expense-log`,
    );

    // R2 へ 2 個（原本はそのまま、JSON は #98 の成果物）
    const puts = run.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.url).toContain(`/objects/specs/${sha}/app.spec.yaml`);
    expect(puts[0]?.body).toBe(DECLARATION);
    expect(puts[1]?.url).toContain(`/objects/specs/${sha}/normalized.json`);
    expect(JSON.parse(puts[1]?.body ?? "null")).toMatchObject({ sourceSha256: sha, schemaVersion: "community.app-spec/v0.2-draft" });

    // D1 へ 2 回（アプリ → インスタンス）。値は束縛引数で渡し、SQL には埋め込まない
    const posts = run.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    const app = JSON.parse(posts[0]?.body ?? "null") as { batch: { sql: string; params: string[] }[] };
    expect(app.batch[0]?.sql).not.toContain(sha);
    expect(app.batch[0]?.params).toEqual([sha, "community.app-spec/v0.2-draft", `specs/${sha}/app.spec.yaml`, `specs/${sha}/normalized.json`]);
    const instance = JSON.parse(posts[1]?.body ?? "null") as { batch: { sql: string; params: string[] }[] };
    expect(instance.batch[0]?.params).toEqual(["e2e-expense-log", sha, sha]);

    expectNothingSecret(run);
  });

  it("同じ入力の 2 回でも exit 0（登録は冪等。値は出さない）", async () => {
    const cloudflare = new FakeCloudflare();
    const first = await publish(dev(), { cloudflare });
    const second = await publish(dev(), { cloudflare });
    expect(first.code, first.all).toBe(EXIT_OK);
    expect(second.code, second.all).toBe(EXIT_OK);
    expect(second.out.at(-1)).toBe(first.out.at(-1));
    expectNothingSecret(second);
  });
});

describe("失敗の差し込み：成功を返さず、そこから先を行わない", () => {
  const FAILURE_CASES: readonly {
    readonly name: string;
    readonly stage: string;
    readonly puts: number;
    readonly posts: number;
    readonly apply: (cloudflare: FakeCloudflare) => void;
  }[] = [
    { name: "R2 の 1 個目", stage: "source", puts: 1, posts: 0, apply: (c) => { c.failR2At = 1; } },
    { name: "R2 の 2 個目", stage: "normalized", puts: 2, posts: 0, apply: (c) => { c.failR2At = 2; } },
    { name: "D1 のアプリ", stage: "app", puts: 2, posts: 1, apply: (c) => { c.failD1At = 1; } },
    { name: "D1 のインスタンス", stage: "instance", puts: 2, posts: 2, apply: (c) => { c.failD1At = 2; } },
  ];

  it.each(FAILURE_CASES)("$name で失敗：段 $stage を出して exit 1、そこから先は呼ばない", async ({ stage, puts, posts, apply }) => {
    const cloudflare = new FakeCloudflare();
    apply(cloudflare);
    const run = await publish(dev(), { cloudflare });
    expect(run.code).toBe(EXIT_NG);
    expect(run.err.join("\n")).toContain(`段 ${stage}`);
    expect(run.calls.filter((c) => c.method === "PUT")).toHaveLength(puts);
    expect(run.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
    expectNothingSecret(run);
  });

  it("失敗したあと、同じ入力の再実行で正しい状態（exit 0）へ到達する", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failR2At = 2;
    const failed = await publish(dev(), { cloudflare });
    expect(failed.code).toBe(EXIT_NG);

    const retried = await publish(dev(), { cloudflare });
    expect(retried.code, retried.all).toBe(EXIT_OK);
    expectNothingSecret(retried);
  });
});

describe("伏せる：例外と応答に目印が混ざっても出さない", () => {
  it("例外の文言に URL・Account ID・バケット名が入っていても、値を持たない段の説明だけを出す", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.throwOnce = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${URL_SENTINEL}/${ACCOUNT}/r2/buckets/${BUCKET}/objects`), { code: "ECONNREFUSED" }),
    });
    const run = await publish(dev(), { cloudflare });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("原本を R2 に書けなかった");
    expectNothingSecret(run);
  });

  it("D1 の応答の本文に目印が入っていても、本文を出さずに exit 1", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.rawD1Body = `<html>${URL_SENTINEL}/${ACCOUNT}/${BUCKET}</html>`;
    const run = await publish(dev(), { cloudflare });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("段 app");
    expectNothingSecret(run);
  });
});

describe("純粋関数", () => {
  it("readPublishTarget：実物の設定から dev の CONTROL_DB と BUNDLES を読む", () => {
    expect(readPublishTarget(CONFIG, "dev")).toEqual({
      databaseId: "b573e00e-98af-498a-873e-ad5373767179",
      bucketName: BUCKET,
    });
    expect(readPublishTarget(CONFIG, "staging").bucketName).toBe("musunest-staging-bundles");
  });

  const TARGET_CASES: readonly { readonly name: string; readonly text: string; readonly message: string }[] = [
    {
      name: "database_id が未同期（<TF_OUTPUT>）",
      text: CONFIG.replace("b573e00e-98af-498a-873e-ad5373767179", "<TF_OUTPUT>"),
      message: "UUID の形でない",
    },
    {
      name: "バケット名の env が違う",
      text: CONFIG.replace('"bucket_name": "musunest-dev-bundles"', '"bucket_name": "musunest-staging-bundles"'),
      message: "-dev-bundles の形でない",
    },
    { name: "env が無い", text: '{"env":{}}', message: "env.dev が無い" },
  ];

  it.each(TARGET_CASES)("readPublishTarget：$name なら止める（1つも書かない）", ({ text, message }) => {
    expect(() => readPublishTarget(text, "dev")).toThrow(message);
  });

  it("readCredentials：Account ID の形と production のアカウントを確かめる", () => {
    expect(readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toEqual({ token: TOKEN, accountId: ACCOUNT });
    expect(() =>
      readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: PROD_ACCOUNT, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT }),
    ).toThrow("production のアカウント");
  });

  it("d1QueryPath / r2ObjectPath：Account ID と database_id、キーの段を URL エンコードする", () => {
    expect(d1QueryPath(ACCOUNT, "db-id")).toBe(`/accounts/${ACCOUNT}/d1/database/db-id/query`);
    expect(r2ObjectPath(ACCOUNT, BUCKET, "specs/abc/app.spec.yaml")).toBe(
      `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/specs/abc/app.spec.yaml`,
    );
    expect(r2ObjectPath(ACCOUNT, BUCKET, "specs/a b/c")).toBe(`/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/specs/a%20b/c`);
    expect(() => r2ObjectPath(ACCOUNT, BUCKET, "specs/../other")).toThrow("URL の経路で正しく指せないキー");
    expect(() => r2ObjectPath(ACCOUNT, BUCKET, "")).toThrow("空のキー");
  });

  it("parseD1Results：success と result の配列を読む。形が違えば止める", () => {
    expect(parseD1Results({ success: true, result: [{ results: [{ a: 1 }], meta: { changes: 2 } }] })).toEqual([
      { rows: [{ a: 1 }], changes: 2 },
    ]);
    for (const body of [{ success: false, result: [] }, { success: true }, { success: true, result: [{ meta: {} }] }]) {
      expect(() => parseD1Results(body)).toThrow("D1 の応答の形が想定と違う");
    }
  });
});
