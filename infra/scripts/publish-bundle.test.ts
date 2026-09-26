// publish-bundle の入口（infra/scripts/publish-bundle.ts）の試験（Issue #248）。**実環境には一切届かない**
// （動かす Cloudflare の API は偽物だけ。納品物はテストの中で作った一時ディレクトリ）。
//
//   1. 引数の誤り（--env の欠落・未知の env・production 指定・--instance・--bundle・--summary・
//      知らないオプション・位置引数）は、API を呼ばずに非 0 で終わる
//   2. 資格情報の不足・production のアカウントは、API を呼ばずに非 0 で終わる（既存の publish と同じ）
//   3. 4 つの門（manifest・pins・acceptance・declaration）のどれかが落ちると、**API を呼ばずに**非 0 で終わる（受入条件 1）
//   4. 4 つとも通ると、既存の publish の中身が R2 と D1 を触る（受入条件 2）
//   5. 出力にトークン・Account ID・バケット名・URL・ホスト名が出ない（受入条件 3）
//
// pins と summary の読み取りは CliIo.readFile を差し替える（実ファイルは納品物だけ）。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_MANIFEST_FILE, BUNDLE_MANIFEST_SCHEMA_VERSION } from "../../packages/control-plane/src/index.ts";
import {
  DATA_API_CONFIG,
  EXIT_NG,
  EXIT_OK,
  PUBLISHABLE_ENVS,
  runCli as runPublish,
  type CliIo,
} from "./publish.ts";
import { PINS_FILE, runCli } from "./publish-bundle.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(ROOT, DATA_API_CONFIG);
const CONFIG = readFileSync(CONFIG_PATH, "utf8");
const PINS_PATH = join(ROOT, PINS_FILE);
const SUMMARY_PATH = join(ROOT, "summary.json");

/** 検査を通る、最小の宣言（publish.test.ts と同じ形） */
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

/** 手で書いた headless v1 の要約（L2 が受け入る値） */
const SUMMARY = `${JSON.stringify({
  schema_version: "commandagent.headless-summary/v1",
  run_id: "run-2026-09-26-001",
  verdict: "full",
  assurance: "partial",
  score: 0.98,
  acceptance_sheet_path: "acceptance/sheet.json",
  artifacts_dir: "artifacts",
  events_path: "events.jsonl",
  duration_secs: 12.5,
  provider_cost_usd: 0.42,
  provider_usage_by_role: {},
  stop_class: "completed",
  directive_round: 1,
  status: "completed",
  gate: "S",
  stop_reason: null,
  next_action: null,
  changed_files: ["artifacts/app.spec.yaml"],
  verify_commands: [],
  exit_code: 0,
})}\n`;

/** 目印。トークン・Account ID・バケット名・URL の代わり */
const TOKEN = "fixture-token-6f2a9c1d";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const PROD_ACCOUNT = "fedcba9876543210fedcba9876543210";
const BUCKET = "musunest-dev-bundles";
const URL_SENTINEL = "https://api.cloudflare.com/client/v4/accounts";
const MARKERS = [TOKEN, ACCOUNT, PROD_ACCOUNT, BUCKET, URL_SENTINEL, "cloudflare.com"];

const allNullPins = (): Record<string, unknown> => ({
  delivery_bundles: {
    warikan: { manifest_sha256: null, source_run: null },
    "task-board": { manifest_sha256: null, source_run: null },
    dashboard: { manifest_sha256: null, source_run: null },
  },
});

// ── 小さな納品物を一時ディレクトリに作る ─────────────────────────

const encoder = new TextEncoder();
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newBundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "musunest-publish-bundle-"));
  roots.push(root);
  return root;
}

function writeBundleFile(root: string, relative: string, content: string): void {
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content);
}

/** 納品物を作り、manifest 自身の SHA-256 を返す。`tamper` は manifest の後に書き換えるパス。 */
async function makeBundle(
  options: { readonly declaration?: string; readonly artifactLevel?: string; readonly tamper?: string } = {},
): Promise<{ readonly root: string; readonly manifestSha256: string }> {
  const root = newBundleRoot();
  const declaration = options.declaration ?? DECLARATION;
  const declarationBytes = encoder.encode(declaration);
  writeBundleFile(root, "artifacts/app.spec.yaml", declaration);
  const manifest = {
    schema_version: BUNDLE_MANIFEST_SCHEMA_VERSION,
    storage_unit: "R2_delivery_unit",
    source_run: "e_test_001",
    artifact_level: options.artifactLevel ?? "L2",
    expected_verdict: "full",
    instrument: { binary_sha256: "b".repeat(64), verification_profile: "community-mini-app" },
    files: [
      { path: "artifacts/app.spec.yaml", sha256: await sha256Hex(declarationBytes), size_bytes: declarationBytes.byteLength },
    ],
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, BUNDLE_MANIFEST_FILE), text);
  if (options.tamper !== undefined) writeBundleFile(root, options.tamper, "tampered\n");
  return { root, manifestSha256: await sha256Hex(encoder.encode(text)) };
}

// ── Cloudflare の API の偽物 ─────────────────────────────────────

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

/** R2 への PUT は成功、D1 への POST は登録の最小の再現を返す。 */
class FakeCloudflare {
  readonly calls: Call[] = [];
  readonly #apps = new Map<string, Record<string, unknown>>();
  readonly #instances = new Map<string, Record<string, unknown>>();

  handle(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    if (url.includes("/r2/buckets/")) return Promise.resolve(Response.json({ success: true, result: {} }));
    if (url.includes("/d1/database/")) return Promise.resolve(Response.json(this.#answer(init?.body)));
    return Promise.resolve(Response.json({ success: false }, { status: 404 }));
  }

  #answer(raw: unknown): unknown {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as { batch: { sql: string; params: (string | number | null)[] }[] }) : { batch: [] };
    const result = parsed.batch.map(({ sql, params }) => {
      if (sql.includes("INSERT INTO app_instances")) {
        const [instanceId, sha] = params;
        if (typeof instanceId === "string" && typeof sha === "string" && this.#apps.has(sha) && !this.#instances.has(instanceId)) {
          this.#instances.set(instanceId, { instance_id: instanceId, source_sha256: sha, created_at: "2026-09-26T00:00:00.000Z" });
        }
        return { results: [], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("INSERT INTO apps")) {
        const [sha, version, sourceKey, normalizedKey] = params;
        if (typeof sha === "string" && !this.#apps.has(sha)) {
          this.#apps.set(sha, {
            source_sha256: sha,
            schema_version: version,
            source_key: sourceKey,
            normalized_key: normalizedKey,
            created_at: "2026-09-26T00:00:00.000Z",
          });
        }
        return { results: [], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("FROM app_instances")) {
        const [instanceId] = params;
        const row = typeof instanceId === "string" ? this.#instances.get(instanceId) : undefined;
        return { results: row === undefined ? [] : [row], success: true, meta: { changes: 0 } };
      }
      if (sql.includes("FROM apps")) {
        const [sha] = params;
        const row = typeof sha === "string" ? this.#apps.get(sha) : undefined;
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

async function run(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly pins?: string;
    readonly summary?: string;
    readonly cloudflare?: FakeCloudflare;
  } = {},
): Promise<Run> {
  const cloudflare = options.cloudflare ?? new FakeCloudflare();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    root: ROOT,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...options.env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: (input, init) => cloudflare.handle(String(input), init),
    readFile: (path) => {
      if (path === CONFIG_PATH) return CONFIG;
      if (path === PINS_PATH) return options.pins ?? JSON.stringify(allNullPins());
      if (path === SUMMARY_PATH) return options.summary ?? SUMMARY;
      return readFileSync(path, "utf8");
    },
    requestTimeoutMs: 5_000,
  };
  const code = await runCli(argv, io);
  return { code, out, err, all: [...out, ...err].join("\n"), calls: cloudflare.calls };
}

const args = (bundle: string, extra: readonly string[] = []): string[] => [
  "--env",
  "dev",
  "--instance",
  "e2e-warikan",
  "--bundle",
  bundle,
  "--summary",
  "summary.json",
  ...extra,
];

/** 目印が1つも出ていない。 */
function expectNothingSecret(runResult: Run): void {
  for (const marker of MARKERS) expect(runResult.all).not.toContain(marker);
  expect(runResult.all).not.toMatch(/https?:\/\//);
}

// ── 引数と資格情報の誤りは、API を呼ばずに非 0 で終わる ───────────

describe("引数と資格情報の誤りは、API を呼ばずに非 0 で終わる", () => {
  it("--help は使い方を出して exit 0。API を呼ばない", async () => {
    const runResult = await run(["--help"]);
    expect(runResult.code).toBe(EXIT_OK);
    expect(runResult.calls).toEqual([]);
    expect(runResult.out[0]).toMatch(/^usage: pnpm exec tsx infra\/scripts\/publish-bundle\.ts --env <dev\|staging>/);
  });

  const ARG_CASES: readonly { readonly name: string; readonly argv: readonly string[]; readonly message: string }[] = [
    { name: "--env が無い", argv: ["--instance", "x", "--bundle", "b", "--summary", "s"], message: "--env が無い" },
    { name: "未知の env（値を出さない）", argv: ["--env", URL_SENTINEL, "--instance", "x", "--bundle", "b", "--summary", "s"], message: "未知の env" },
    { name: "production は断る", argv: ["--env", "production", "--instance", "x", "--bundle", "b", "--summary", "s"], message: "へは publish しない" },
    { name: "--instance が無い", argv: ["--env", "dev", "--bundle", "b", "--summary", "s"], message: "--instance が無い" },
    { name: "--instance が形に合わない（値を出さない）", argv: ["--env", "dev", "--instance", `${URL_SENTINEL}/x`, "--bundle", "b", "--summary", "s"], message: "--instance は" },
    { name: "--bundle が無い", argv: ["--env", "dev", "--instance", "x", "--summary", "s"], message: "--bundle が無い" },
    { name: "--summary が無い", argv: ["--env", "dev", "--instance", "x", "--bundle", "b"], message: "--summary が無い" },
    { name: "知らないオプション", argv: ["--env", "dev", "--instance", "x", "--bundle", "b", "--summary", "s", "--yes"], message: "引数が不正: 知らないオプションがある" },
    { name: "位置引数（値を出さない）", argv: ["--env", "dev", "--instance", "x", "b", "--summary", "s"], message: "引数が不正: 位置引数は取らない" },
  ];

  it.each(ARG_CASES)("$name", async ({ argv, message }) => {
    const runResult = await run(argv);
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain(message);
    expectNothingSecret(runResult);
  });

  it("資格情報が無ければ、API を呼ばずに非 0", async () => {
    const bundle = await makeBundle();
    const runResult = await run(args(bundle.root), { env: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined } });
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("CLOUDFLARE_API_TOKEN");
    expectNothingSecret(runResult);
  });

  it("CLOUDFLARE_ACCOUNT_ID が production を指していれば、API を呼ばずに非 0", async () => {
    const bundle = await makeBundle();
    const runResult = await run(args(bundle.root), { env: { CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT, CLOUDFLARE_ACCOUNT_ID: PROD_ACCOUNT } });
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("production");
    expectNothingSecret(runResult);
  });
});

// ── 受入条件 1：門が落ちると API を呼ばない ───────────────────────

describe("4 つの門のどれかが落ちると、API を呼ばずに非 0 で終わる", () => {
  it("manifest の照合に通らないと、段 manifest で止まる", async () => {
    const bundle = await makeBundle({ tamper: "artifacts/app.spec.yaml" });
    const runResult = await run(args(bundle.root));
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("段 manifest");
    expectNothingSecret(runResult);
  });

  it("manifest の SHA-256 が pins の値と一致しないと、段 pins で止まる", async () => {
    const bundle = await makeBundle();
    const pins = JSON.stringify({ delivery_bundles: { warikan: { manifest_sha256: "0".repeat(64), source_run: "r" } } });
    const runResult = await run(args(bundle.root), { pins });
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("段 pins");
    expectNothingSecret(runResult);
  });

  it("受け入れの条件を満たさないと、段 acceptance で止まる", async () => {
    const bundle = await makeBundle();
    const summary = `${JSON.stringify({ ...JSON.parse(SUMMARY), verdict: "partial" })}\n`;
    const runResult = await run(args(bundle.root), { summary });
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("段 acceptance");
    expectNothingSecret(runResult);
  });

  it("宣言が静的チェックに通らないと、段 declaration で止まる", async () => {
    const bundle = await makeBundle({ declaration: "entities: []\n" });
    const runResult = await run(args(bundle.root));
    expect(runResult.code).toBe(EXIT_NG);
    expect(runResult.calls).toEqual([]);
    expect(runResult.all).toContain("段 declaration");
    expectNothingSecret(runResult);
  });
});

// ── 受入条件 2・3：4 つとも通ると publish の中身が R2 / D1 を触る ──

describe("4 つとも通ると、既存の publish の中身が R2 と D1 を触る", () => {
  it("pins の値がすべて null（比較を飛ばす）でも、宣言を R2 と D1 へ置く", async () => {
    const bundle = await makeBundle();
    const runResult = await run(args(bundle.root));

    expect(runResult.code).toBe(EXIT_OK);
    const puts = runResult.calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.url).toMatch(/\/objects\/specs\/[0-9a-f]{64}\/app\.spec\.yaml$/);
    expect(puts[1]?.url).toMatch(/\/objects\/specs\/[0-9a-f]{64}\/normalized\.json$/);
    expect(runResult.calls.some((call) => call.method === "POST" && call.url.includes("/d1/database/"))).toBe(true);
    // 宣言は読み取ったバイト列のまま R2 へ置く
    expect(puts[0]?.body).toBe(DECLARATION);
    // 出してよい値（manifest SHA・版・原本 SHA・インスタンス ID・水準・pins の状態）だけ
    expect(runResult.all).toContain(bundle.manifestSha256);
    expect(runResult.all).toContain("e2e-warikan");
    expect(runResult.all).toContain("pins skipped");
    expectNothingSecret(runResult);
  });

  it("pins の値が manifest の SHA-256 と一致すれば matched として通す", async () => {
    const bundle = await makeBundle();
    const pins = JSON.stringify({ delivery_bundles: { warikan: { manifest_sha256: bundle.manifestSha256, source_run: "r" } } });
    const runResult = await run(args(bundle.root), { pins });

    expect(runResult.code).toBe(EXIT_OK);
    expect(runResult.all).toContain("pins matched");
    expectNothingSecret(runResult);
  });
});

// ── 既存の publish と同じ PUBLISHABLE_ENVS を使う ────────────────

describe("公開してよい env", () => {
  it("既存の publish と同じ dev / staging だけ", () => {
    expect(PUBLISHABLE_ENVS).toEqual(["dev", "staging"]);
  });

  it("runPublish と publish-bundle は別の入口である（取り違えない）", () => {
    expect(runCli).not.toBe(runPublish);
  });
});
