// 無償枠の実測（measure-free-tier.ts）の受入試験（Issue #25）。**実環境には一切届かない。**
//
// Cloudflare の API（サブドメイン・GraphQL）は、2026-09-14 に staging で記録した応答の形を固定データにして返す
// （サブドメイン・Account ID は作り物）。host への GET も差し替える。
// ヘッダがそのまま届くことだけは、ローカル（127.0.0.1）の HTTP サーバで確かめる。
//
//   1. 契約：Worker 名が各 wrangler.jsonc の env.staging と一致する。/ と深いリンクは run_worker_first に当たらず、/healthz は当たる
//   2. 読み取り：GraphQL の応答を窓ごとの行にする。errors は伏せてから落とし、認可エラーは「トークンを作らずに止める」
//   3. 判定：要確認 4（Static Assets）・要確認 2（Service Binding）・CPU 時間（要確認 1 を含む）。サンプリングの揺れを許す幅と、
//      Worker の名前が __unknown__ の間は判定しないこと
//   4. CLI：送る回数の上限・ヘッダ・窓・反映待ち・終了コード。出力に URL・サブドメイン・Account ID・トークンが無い
//   5. nodeGet：sec-fetch-mode: navigate が書き換えられずに届く
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  aboutSent,
  activityPlans,
  ANALYTICS_QUERY,
  analyticsVariables,
  countsOf,
  DASHBOARD_MEMBER_NAMES,
  DASHBOARD_ROUTES,
  DEEP_LINK_PATH,
  DEFAULT_PLAN,
  EXIT_NG,
  EXIT_OK,
  EXIT_TOUCHED,
  EXIT_UNDETERMINED,
  FREE_CPU_LIMIT_MS,
  judgeAssets,
  judgeCpu,
  judgeServiceBinding,
  MAX_REQUESTS,
  MeasureError,
  NAVIGATION_HEADERS,
  nodeGet,
  parseAnalytics,
  parseWindow,
  readCredentials,
  requestCount,
  ROOT_PATH,
  runApiMeasurement,
  runCli,
  sanitize,
  scriptName,
  TARGET_ENV,
  UNKNOWN_SCRIPT,
  WINDOW_PAD_MS,
  windowOf,
  WORKERS,
  type CliIo,
  type DriveRecord,
  type HttpResponse,
  type InvocationRow,
  type MeasurePolicy,
  type Worker,
} from "./measure-free-tier.ts";
import { API_WORKERS, type ApiWorker, type ExceededReading } from "./api-measure-fixture.ts";
import { HEALTHZ_PATH } from "./smoke.ts";
import type { Env } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONFIG_PATHS: Readonly<Record<Worker, string>> = {
  host: "apps/host/wrangler.jsonc",
  gateway: "apps/gateway/wrangler.jsonc",
  "data-api": "packages/data-api/wrangler.jsonc",
};

const readConfig = (path: string) => parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

// ── 固定データ（作り物の ID）─────────────────────────────────────────────────────

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROD_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const TOKEN = "test-token_ABCdef0123456789";
const SUBDOMAIN = "fake-sub-7f3a";
const HOSTNAME = `musunest-staging-host.${SUBDOMAIN}.workers.dev`;

/**
 * 2026-09-14 に staging で記録した応答（1回目の実測：/ と深いリンク 計 20 回・/healthz 20 回）。値はそのまま。
 *   - ページの窓：Worker の起動は 0、assets は 22 回
 *   - healthz の窓：host は sampleInterval 1.5 の重みで 27 回と出た。gateway・data-api は 20 回
 */
const RECORDED = {
  pagesInvocations: [],
  pagesAssets: [{ dimensions: { statusCode: 200 }, sum: { requests: 22 } }],
  healthzInvocations: [
    {
      avg: { sampleInterval: 1.5 },
      dimensions: { scriptName: "musunest-staging-host" },
      max: { cpuTime: 1564 },
      quantiles: { cpuTimeP50: 595, cpuTimeP99: 1564 },
      sum: { cpuTimeUs: 18224, errors: 0, requests: 27 },
    },
    {
      avg: { sampleInterval: 1 },
      dimensions: { scriptName: "musunest-staging-gateway" },
      max: { cpuTime: 1179 },
      quantiles: { cpuTimeP50: 611, cpuTimeP99: 1179 },
      sum: { cpuTimeUs: 12663, errors: 0, requests: 20 },
    },
    {
      avg: { sampleInterval: 1 },
      dimensions: { scriptName: "musunest-staging-data-api" },
      max: { cpuTime: 3770 },
      quantiles: { cpuTimeP50: 2276, cpuTimeP99: 3770 },
      sum: { cpuTimeUs: 47783, errors: 0, requests: 20 },
    },
  ],
};

/** 同じ窓を、Worker の名前が Analytics に反映される前（09:14 UTC まで）に読んだときの形。名前だけが __unknown__ だった。 */
const recordedBeforeNames = () =>
  withAccount({
    ...RECORDED,
    healthzInvocations: RECORDED.healthzInvocations.map((row) => ({ ...row, dimensions: { scriptName: UNKNOWN_SCRIPT } })),
  });

/** 記録した応答の GraphQL の本文。試験ごとに複製する（形を壊す試験が他を巻き込まないように）。 */
const recordedBody = () => withAccount(RECORDED);

function withAccount(account: object) {
  return structuredClone({ data: { viewer: { accounts: [account] } }, errors: null });
}

interface RowSpec {
  readonly name: string;
  readonly requests: number;
  readonly cpuTimeUs?: number;
  readonly cpuMaxUs?: number;
  readonly sampleInterval?: number;
  readonly errors?: number;
}

/** GraphQL の応答の1行（workersInvocationsAdaptive）。 */
function gqlRow(spec: RowSpec) {
  const cpuTimeUs = spec.cpuTimeUs ?? 1_000 * spec.requests;
  const cpuMaxUs = spec.cpuMaxUs ?? Math.round(cpuTimeUs / Math.max(1, spec.requests));
  return {
    avg: { sampleInterval: spec.sampleInterval ?? 1 },
    dimensions: { scriptName: spec.name },
    max: { cpuTime: cpuMaxUs },
    quantiles: { cpuTimeP50: Math.round(cpuMaxUs * 0.6), cpuTimeP99: cpuMaxUs },
    sum: { cpuTimeUs, errors: spec.errors ?? 0, requests: spec.requests },
  };
}

function gqlBody(parts: { readonly pages?: readonly RowSpec[]; readonly assets?: number; readonly healthz?: readonly RowSpec[] }) {
  return withAccount({
    pagesInvocations: (parts.pages ?? []).map(gqlRow),
    pagesAssets:
      parts.assets === undefined || parts.assets === 0 ? [] : [{ dimensions: { statusCode: 200 }, sum: { requests: parts.assets } }],
    healthzInvocations: (parts.healthz ?? []).map(gqlRow),
  });
}

/** healthz の窓で、3つの Worker が n 回ずつ（最大は host 0.8 ms・gateway 0.6 ms・data-api 2.5 ms）。 */
const chain = (n: number): RowSpec[] => [
  { name: scriptName("host"), requests: n, cpuTimeUs: 600 * n, cpuMaxUs: 800 },
  { name: scriptName("gateway"), requests: n, cpuTimeUs: 450 * n, cpuMaxUs: 600 },
  { name: scriptName("data-api"), requests: n, cpuTimeUs: 1_900 * n, cpuMaxUs: 2_500 },
];

const rowsOf = (specs: readonly RowSpec[]): readonly InvocationRow[] =>
  parseAnalytics(gqlBody({ healthz: specs }), []).healthz.invocations;

// ── 1. 契約 ───────────────────────────────────────────────────────────────

describe("契約：宛先の Worker と経路", () => {
  it.each(WORKERS)("%s の Worker 名が wrangler.jsonc の env.staging.name と一致する", (worker) => {
    const config = readConfig(CONFIG_PATHS[worker]) as { env: Record<string, { name: string }> };
    expect(TARGET_ENV).toBe("staging");
    expect(config.env[TARGET_ENV]?.name).toBe(scriptName(worker));
  });

  const runWorkerFirst = (readConfig(CONFIG_PATHS.host) as { assets: { run_worker_first: string[] } }).assets
    .run_worker_first;
  const matches = (path: string) =>
    runWorkerFirst.some((pattern) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(path));

  it("/ と深いリンクは run_worker_first に当たらない（Static Assets が返すはずのパス）", () => {
    expect(matches(ROOT_PATH)).toBe(false);
    expect(matches(DEEP_LINK_PATH)).toBe(false);
  });

  it("/healthz は run_worker_first に当たる（host → gateway → data-api を踏む）", () => {
    expect(matches(HEALTHZ_PATH)).toBe(true);
  });

  it("ページの GET はブラウザのページ遷移と同じヘッダを付ける", () => {
    expect(NAVIGATION_HEADERS).toMatchObject({ "sec-fetch-mode": "navigate", accept: "text/html" });
  });

  it(`既定の回数は上限（${MAX_REQUESTS} 回）以内`, () => {
    expect(requestCount(DEFAULT_PLAN)).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  it("Free の CPU 時間の上限は 10 ms（2026-09-14 の一次情報）", () => {
    expect(FREE_CPU_LIMIT_MS).toBe(10);
  });

  it("GraphQL は一次情報とスキーマで確かめたデータセットと欄を読む", () => {
    for (const piece of [
      "workersInvocationsAdaptive",
      "workersAssetsRequestsAdaptiveGroups",
      "sum { requests errors cpuTimeUs }",
      "max { cpuTime }",
      "quantiles { cpuTimeP50 cpuTimeP99 }",
      "avg { sampleInterval }",
      "dimensions { scriptName }",
      "dimensions { statusCode }",
      "scriptName_in: $scripts",
      "hostname: $hostname",
    ]) {
      expect(ANALYTICS_QUERY).toContain(piece);
    }
    // 応答にサブドメインもスクリプトの ID も載せない
    expect(ANALYTICS_QUERY).not.toMatch(/dimensions \{[^}]*(hostname|scriptTag|scriptVersion)/);
  });

  it("GraphQL の変数：3つの Worker 名と __unknown__、host のホスト名、2つの窓", () => {
    const record: DriveRecord = {
      pages: { window: { since: "2026-09-14T09:00:00Z", until: "2026-09-14T09:00:10Z" }, sent: 20 },
      healthz: { window: { since: "2026-09-14T09:00:20Z", until: "2026-09-14T09:00:40Z" }, sent: 20 },
    };
    expect(analyticsVariables(ACCOUNT_ID, HOSTNAME, record)).toEqual({
      accountTag: ACCOUNT_ID,
      scripts: ["musunest-staging-host", "musunest-staging-gateway", "musunest-staging-data-api", UNKNOWN_SCRIPT],
      hostname: HOSTNAME,
      pagesSince: "2026-09-14T09:00:00Z",
      pagesUntil: "2026-09-14T09:00:10Z",
      healthzSince: "2026-09-14T09:00:20Z",
      healthzUntil: "2026-09-14T09:00:40Z",
    });
  });
});

describe("資格情報と窓", () => {
  const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };

  it("CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む", () => {
    expect(readCredentials(env)).toEqual({ token: TOKEN, accountId: ACCOUNT_ID });
  });

  it.each([
    ["トークンが無い", { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }],
    ["Account ID が空", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "" }],
    ["Account ID の形でない", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "not-an-account" }],
    ["トークンに改行", { CLOUDFLARE_API_TOKEN: `${TOKEN}\n`, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }],
    ["production のアカウントを指している", { ...env, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID.toUpperCase() }],
  ])("%s なら落とし、値を出さない", (_, input) => {
    let error: unknown;
    try {
      readCredentials(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MeasureError);
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(ACCOUNT_ID);
    expect(message).not.toContain("not-an-account");
  });

  it("別のアカウントの CLOUDFLARE_ACCOUNT_ID_PROD があっても通る", () => {
    expect(readCredentials({ ...env, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_ID }).accountId).toBe(ACCOUNT_ID);
  });

  it("窓は前後に 2 秒足して秒に丸める", () => {
    expect(windowOf(Date.parse("2026-09-14T09:00:00.400Z"), Date.parse("2026-09-14T09:00:05.100Z"))).toEqual({
      since: "2026-09-14T08:59:58Z",
      until: "2026-09-14T09:00:08Z",
    });
  });

  it.each([
    "2026-09-14T09:00:00Z",
    "2026-09-14T09:00:00Z/",
    "2026-09-14 09:00:00/2026-09-14 09:01:00",
    "2026-09-14T09:01:00Z/2026-09-14T09:00:00Z",
  ])("読めない窓（%s）は落とす", (raw) => {
    expect(() => parseWindow(raw, "--pages-window")).toThrow(MeasureError);
  });
});

// ── 2. 読み取り ─────────────────────────────────────────────────────────────

describe("parseAnalytics：GraphQL の応答を窓ごとの行にする", () => {
  it("記録した応答を読める", () => {
    const snapshot = parseAnalytics(recordedBody(), []);
    expect(snapshot.pages).toEqual({ invocations: [], assets: 22 });
    expect(snapshot.healthz.invocations[0]).toEqual({
      scriptName: "musunest-staging-host",
      requests: 27,
      errors: 0,
      cpuTimeUs: 18224,
      cpuMaxUs: 1564,
      cpuP50Us: 595,
      cpuP99Us: 1564,
      sampleInterval: 1.5,
    });
  });

  it("assets は行の requests を足す。行が無ければ 0", () => {
    expect(parseAnalytics(gqlBody({ assets: 20 }), []).pages.assets).toBe(20);
    expect(parseAnalytics(gqlBody({}), []).pages.assets).toBe(0);
  });

  it("errors は Account ID・サブドメイン・ホスト名・UUID を伏せてから落とす", () => {
    const uuid = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    const body = { data: null, errors: [{ message: `unknown field "count" for account ${ACCOUNT_ID} host ${HOSTNAME} version ${uuid}` }] };
    let message = "";
    try {
      parseAnalytics(body, [ACCOUNT_ID, SUBDOMAIN]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unknown field \\"count\\"');
    expect(message).not.toContain(ACCOUNT_ID);
    expect(message).not.toContain(SUBDOMAIN);
    expect(message).not.toContain(uuid);
  });

  it("認可エラーは「トークンを作らずに止める」", () => {
    const body = { data: null, errors: [{ message: "not authorized for that account" }] };
    expect(() => parseAnalytics(body, [])).toThrow(/トークンを作らずに止める/);
  });

  it("形が違えば落とす", () => {
    const body = recordedBody() as { data: { viewer: { accounts: { healthzInvocations: { sum: Record<string, unknown> }[] }[] } } };
    body.data.viewer.accounts[0]!.healthzInvocations[0]!.sum.requests = "27";
    expect(() => parseAnalytics(body, [])).toThrow(/sum\.requests が数でない/);
    expect(() => parseAnalytics({ data: { viewer: { accounts: [] } } }, [])).toThrow(/アカウントが無い/);
  });

  it("sanitize は32桁の16進と workers.dev のホスト名を伏せ、長さを切る", () => {
    expect(sanitize(`x ${PROD_ACCOUNT_ID} y a-b.c.workers.dev`, [])).toBe(JSON.stringify("x <伏せた> y <伏せた>.workers.dev"));
    expect(sanitize("z".repeat(500), []).length).toBeLessThan(220);
  });

  it("送った数くらい（半分から倍まで）を同じとみなす。記録した揺れ（27・26・17・22・11 / 20）は全部入る", () => {
    for (const value of [20, 27, 26, 17, 22, 11, 10, 40]) expect(aboutSent(value, 20)).toBe(true);
    for (const value of [0, 9, 41]) expect(aboutSent(value, 20)).toBe(false);
  });

  it("countsOf は Worker ごとと __unknown__ を分けて数える", () => {
    expect(countsOf(parseAnalytics(recordedBeforeNames(), []).healthz.invocations)).toEqual({
      counts: { host: 0, gateway: 0, "data-api": 0 },
      unknown: 67,
    });
    expect(countsOf(parseAnalytics(recordedBody(), []).healthz.invocations)).toEqual({
      counts: { host: 27, gateway: 20, "data-api": 20 },
      unknown: 0,
    });
  });
});

// ── 3. 判定 ─────────────────────────────────────────────────────────────────

describe("judgeAssets：要確認 4（Static Assets は Worker を起動するか）", () => {
  const pages = (specs: readonly RowSpec[], assets: number) => parseAnalytics(gqlBody({ pages: specs, assets }), []).pages;

  it("記録した応答：Worker の起動が 0 で assets が送った数くらい（22 / 20）なら、起動しない", () => {
    expect(judgeAssets(parseAnalytics(recordedBody(), []).pages, 20)).toMatchObject({
      outcome: "not-invoked",
      counts: { host: 0, gateway: 0, "data-api": 0 },
      assets: 22,
    });
  });

  it("host が起動していれば、起動する（100k/日 を消費する）", () => {
    expect(judgeAssets(pages([{ name: scriptName("host"), requests: 10 }], 20), 20).outcome).toBe("invoked");
  });

  it("名前の無い起動があれば判定しない", () => {
    expect(judgeAssets(pages([{ name: UNKNOWN_SCRIPT, requests: 1 }], 20), 20)).toMatchObject({ outcome: "undetermined", unknown: 1 });
  });

  it("assets が送った数の半分に届かなければ判定しない", () => {
    expect(judgeAssets(pages([], 9), 20).outcome).toBe("undetermined");
  });
});

describe("judgeServiceBinding：要確認 2（Service Binding の先は別の requests か）", () => {
  it("記録した応答：gateway・data-api も送った数くらい（27・20・20 / 20）なら、別に数える。サンプリングを残す", () => {
    expect(judgeServiceBinding(parseAnalytics(recordedBody(), []).healthz.invocations, 20)).toMatchObject({
      outcome: "separate",
      counts: { host: 27, gateway: 20, "data-api": 20 },
      sampled: true,
    });
  });

  it("host だけが起動していれば、別に数えない", () => {
    expect(judgeServiceBinding(rowsOf(chain(20).slice(0, 1)), 20).outcome).toBe("not-separate");
  });

  it("host の回数が送った数と合わなければ（他のリクエストが混ざった）判定しない", () => {
    expect(judgeServiceBinding(rowsOf(chain(45)), 20).outcome).toBe("undetermined");
  });

  it("gateway だけが起動していなければ判定しない", () => {
    expect(judgeServiceBinding(rowsOf(chain(20).filter((spec) => spec.name !== scriptName("gateway"))), 20).outcome).toBe(
      "undetermined",
    );
  });

  it("記録した応答（名前が反映される前）は判定せず、時間を空けて読み直すよう言う", () => {
    const finding = judgeServiceBinding(parseAnalytics(recordedBeforeNames(), []).healthz.invocations, 20);
    expect(finding).toMatchObject({ outcome: "undetermined", unknown: 67 });
    expect(finding.reason).toContain("時間を空けて読み直す");
  });
});

describe("judgeCpu：Free の上限に対する余裕", () => {
  it("max の和が上限内なら、合算しても収まる。余裕と平均の和を出す", () => {
    const finding = judgeCpu(rowsOf(chain(20)), 20, 10);
    expect(finding).toMatchObject({ outcome: "within", downstreamExcluded: true });
    if (finding.outcome === "undetermined") throw new Error("unreachable");
    expect(finding.chainMaxMs).toBeCloseTo(3.9);
    expect(finding.marginMs).toBeCloseTo(6.1);
    expect(finding.chainMeanMs).toBeCloseTo(2.95);
    expect(finding.workers[0]).toEqual({ worker: "host", p50Ms: 0.48, p99Ms: 0.8, maxMs: 0.8, meanMs: 0.6, sampled: false });
  });

  it("記録した応答：チェーン合計の上界 6.51 ms（余裕 3.49 ms）。host の平均は下流の和より小さい", () => {
    const finding = judgeCpu(parseAnalytics(recordedBody(), []).healthz.invocations, 20, FREE_CPU_LIMIT_MS);
    expect(finding).toMatchObject({ outcome: "within", downstreamExcluded: true });
    if (finding.outcome === "undetermined") throw new Error("unreachable");
    expect(finding.chainMaxMs).toBeCloseTo(6.513);
    expect(finding.marginMs).toBeCloseTo(3.487);
    expect(finding.chainMeanMs).toBeCloseTo(18.224 / 27 + 12.663 / 20 + 47.783 / 20);
    expect(finding.workers.map((w) => [w.worker, w.sampled])).toEqual([
      ["host", true],
      ["gateway", false],
      ["data-api", false],
    ]);
  });

  it("単体では上限内でも、max の和が上限を超えれば over-if-summed", () => {
    expect(judgeCpu(rowsOf(chain(20).map((spec) => ({ ...spec, cpuMaxUs: 4_000 }))), 20, 10).outcome).toBe("over-if-summed");
  });

  it("単体で上限を超えれば over", () => {
    const specs = chain(20).map((spec, i) => (i === 2 ? { ...spec, cpuMaxUs: 10_500 } : spec));
    expect(judgeCpu(rowsOf(specs), 20, 10).outcome).toBe("over");
  });

  it("host の平均が下流の平均の和以上なら、下流を含まないとは言わない", () => {
    const specs = chain(20).map((spec, i) => (i === 0 ? { ...spec, cpuTimeUs: 100_000 } : spec));
    expect(judgeCpu(rowsOf(specs), 20, 10)).toMatchObject({ downstreamExcluded: false });
  });

  it("Worker が欠けている・回数が合わない・名前が無いなら判定しない", () => {
    expect(judgeCpu(rowsOf(chain(20).slice(0, 2)), 20, 10).outcome).toBe("undetermined");
    expect(judgeCpu(rowsOf(chain(5)), 20, 10).outcome).toBe("undetermined");
    expect(judgeCpu(parseAnalytics(recordedBeforeNames(), []).healthz.invocations, 20, 10).outcome).toBe("undetermined");
  });
});

// ── 4. CLI ────────────────────────────────────────────────────────────────

/** 試験用の方針。待ちの形は MEASURE_POLICY と同じで、時計は差し替える。 */
const FAST: MeasurePolicy = {
  requestTimeoutMs: 1_000,
  phaseGapMs: 8_000,
  firstReadDelayMs: 60_000,
  pollIntervalMs: 30_000,
  maxWaitMs: 5 * 60_000,
};

interface Sent {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface Harness {
  readonly code: number;
  readonly out: string[];
  readonly all: string;
  readonly sent: Sent[];
  readonly graphql: { readonly variables: Record<string, unknown> }[];
  readonly apiCalls: number;
}

const HOST_HEALTHZ_OK = JSON.stringify({
  service: "host",
  env: "staging",
  version: "a1b2c3d",
  checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
  elapsed_ms: 40,
});

interface HarnessOptions {
  readonly env?: Record<string, string | undefined>;
  /** n 回目（1 始まり）の GraphQL の応答 */
  readonly analytics?: (read: number) => unknown;
  /** host への GET の応答を差し替える */
  readonly respond?: (path: string, headers: Readonly<Record<string, string>>) => Omit<HttpResponse, "date">;
  readonly apiStatus?: number;
}

async function runHarness(argv: readonly string[], options: HarnessOptions = {}): Promise<Harness> {
  let now = Date.parse("2026-09-14T09:00:00.300Z");
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const graphql: { variables: Record<string, unknown> }[] = [];
  let apiCalls = 0;
  const io: CliIo = {
    env: options.env ?? { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: async (input, init) => {
      apiCalls++;
      const url = String(input);
      expect(url.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (options.apiStatus !== undefined) return new Response("{}", { status: options.apiStatus });
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/subdomain`)) {
        expect(init?.method ?? "GET").toBe("GET");
        return Response.json({ success: true, errors: [], result: { subdomain: SUBDOMAIN } });
      }
      if (url.endsWith("/graphql")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        expect(body.query).toBe(ANALYTICS_QUERY);
        graphql.push({ variables: body.variables });
        return Response.json(options.analytics?.(graphql.length) ?? gqlBody({}));
      }
      throw new Error(`想定外の API: ${url}`);
    },
    get: async (url, headers) => {
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe(HOSTNAME);
      sent.push({ path: url.pathname, headers });
      now += 150;
      const date = new Date(now).toUTCString();
      if (options.respond !== undefined) return { ...options.respond(url.pathname, headers), date };
      if (url.pathname === HEALTHZ_PATH) {
        return { status: 200, contentType: "application/json", date, text: HOST_HEALTHZ_OK };
      }
      return { status: 200, contentType: "text/html; charset=utf-8", date, text: "<!doctype html><div id=app></div>" };
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    policy: FAST,
  };
  const code = await runCli(argv, io);
  return { code, out, all: [...out, ...err].join("\n"), sent, graphql, apiCalls };
}

/** 出力のどこにも宛先・ID・トークンが無い。 */
function expectNothingSecret(run: Harness): void {
  for (const secret of [SUBDOMAIN, HOSTNAME, ACCOUNT_ID, TOKEN, "workers.dev", "https://"]) {
    expect(run.all).not.toContain(secret);
  }
}

/** 既定の回数（ページ 20・/healthz 20）がそのまま反映された応答。 */

/** 既定の回数（ページ 20・/healthz 20）がそのまま反映された応答。 */
const settled = gqlBody({ pages: [], assets: 20, healthz: chain(20) });

describe("CLI：送って、反映を待って、判定する", () => {
  it("既定では / と深いリンクを 10 回ずつ・/healthz を 20 回、合計 40 回だけ送り、判定できれば exit 0", async () => {
    const run = await runHarness([], {
      analytics: (read) => (read === 1 ? gqlBody({ assets: 8, healthz: chain(3) }) : settled),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.sent).toHaveLength(40);
    expect(run.sent.filter((s) => s.path === ROOT_PATH)).toHaveLength(10);
    expect(run.sent.filter((s) => s.path === DEEP_LINK_PATH)).toHaveLength(10);
    expect(run.sent.filter((s) => s.path === HEALTHZ_PATH)).toHaveLength(20);
    // ページを全部送ってから /healthz を送る
    expect(run.sent.findIndex((s) => s.path === HEALTHZ_PATH)).toBe(20);
    for (const s of run.sent.slice(0, 20)) expect(s.headers).toMatchObject(NAVIGATION_HEADERS);
    // 1回目は途中まで、2回目と3回目が同じ値で反映済み
    expect(run.graphql).toHaveLength(3);
    expect(run.out.at(-1)).toMatch(/^measure: OK/);
    expect(run.all).toContain("判定: Worker を起動しない（100k/日 を消費しない）");
    expect(run.all).toContain("判定: 別に数える（host への 1 回が 3 requests になる）");
    expect(run.all).toContain("判定: 合算しても上限（10 ms）に収まる");
    expectNothingSecret(run);
  });

  it("窓は Date ヘッダから作り、ページの窓と /healthz の窓は重ならない。読み直すための窓を出す", async () => {
    const run = await runHarness([], { analytics: () => settled });
    const variables = run.graphql[0]?.variables ?? {};
    expect(variables).toMatchObject({ accountTag: ACCOUNT_ID, hostname: HOSTNAME });
    const pagesUntil = Date.parse(String(variables.pagesUntil));
    const healthzSince = Date.parse(String(variables.healthzSince));
    expect(pagesUntil).toBeLessThan(healthzSince);
    expect(run.all).toContain(
      `--pages-window ${String(variables.pagesSince)}/${String(variables.pagesUntil)} --healthz-window ${String(variables.healthzSince)}/${String(variables.healthzUntil)}`,
    );
  });

  it(`合計が ${MAX_REQUESTS} 回を超える指定は、1回も送らず API も呼ばずに exit 1`, async () => {
    const run = await runHarness(["--pages", "15", "--healthz", "21"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.apiCalls).toBe(0);
    expect(run.all).toContain("1回の実測は 50 回まで");
  });

  it("CLOUDFLARE_ACCOUNT_ID が production のアカウントなら、1回も送らずに exit 1", async () => {
    const run = await runHarness([], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.apiCalls).toBe(0);
    expectNothingSecret(run);
  });

  it("API が 403 なら、トークンを作らずに止める（exit 1・1回も送らない）", async () => {
    const run = await runHarness([], { apiStatus: 403 });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.all).toContain("トークンを作らずに止める");
  });

  it("ページが SPAシェルでなければ（Worker が JSON を返した）その場で止め、Analytics を読まずに exit 1", async () => {
    const run = await runHarness([], {
      respond: (path) =>
        path === DEEP_LINK_PATH
          ? { status: 404, contentType: "application/json", text: '{"error":"not found"}' }
          : { status: 200, contentType: "text/html", text: "<!doctype html>" },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(2);
    expect(run.graphql).toHaveLength(0);
    expect(run.all).toContain(`ページ の 2 回目（${DEEP_LINK_PATH}）: HTTP 404`);
    expectNothingSecret(run);
  });

  it("/healthz が全層 ok でなければその場で止める", async () => {
    const run = await runHarness([], {
      respond: (path) =>
        path === HEALTHZ_PATH
          ? { status: 503, contentType: "application/json", text: HOST_HEALTHZ_OK.replace('"do":"ok"', '"do":"ng: boom"') }
          : { status: 200, contentType: "text/html", text: "<!doctype html>" },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(21);
    expect(run.graphql).toHaveLength(0);
  });

  it("反映を待ちきれなければ、上限までしか読まず、最後の値で判定して exit 2", async () => {
    const run = await runHarness([], {
      analytics: (read) => gqlBody({ assets: read * 2, healthz: chain(read) }),
    });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    // 最初に読んでから 5 分まで・30 秒ごと → 0 秒から 300 秒までの 11 回
    expect(run.graphql).toHaveLength(11);
    expect(run.all).toContain("反映を待ちきれなかった");
    expect(run.all).toContain("時間を空けて読み直す: --pages-window ");
  });

  it("記録した応答なら判定でき、サンプリングを注記して exit 0", async () => {
    const run = await runHarness([], { analytics: () => recordedBody() });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("サンプリングあり");
    expect(run.all).toContain("チェーン合計の上界（max の和）  6.51 ms（余裕 3.49 ms）");
    expectNothingSecret(run);
  });

  it("名前が反映される前の応答なら、判定できないとして exit 2", async () => {
    const run = await runHarness([], { analytics: () => recordedBeforeNames() });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("時間を空けて読み直す");
    expectNothingSecret(run);
  });

  it("ページで Worker が起動していれば、前提が崩れたとして exit 1", async () => {
    const run = await runHarness([], {
      analytics: () => gqlBody({ pages: [{ name: scriptName("host"), requests: 10 }], assets: 20, healthz: chain(20) }),
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("100k/日 を消費する");
  });

  it("窓を渡すと GET を送らずに読み直す（最初の待ちも無い）", async () => {
    const run = await runHarness(
      ["--pages-window", "2026-09-14T09:00:00Z/2026-09-14T09:00:10Z", "--healthz-window", "2026-09-14T09:00:20Z/2026-09-14T09:00:40Z"],
      { analytics: () => settled },
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.sent).toHaveLength(0);
    expect(run.graphql).toHaveLength(2);
    expect(run.graphql[0]?.variables).toMatchObject({ pagesSince: "2026-09-14T09:00:00Z", healthzUntil: "2026-09-14T09:00:40Z" });
  });

  it("重なる窓・片方だけの窓は落とす", async () => {
    const overlap = await runHarness([
      "--pages-window",
      "2026-09-14T09:00:00Z/2026-09-14T09:00:30Z",
      "--healthz-window",
      "2026-09-14T09:00:20Z/2026-09-14T09:00:40Z",
    ]);
    expect(overlap.code).toBe(EXIT_NG);
    expect(overlap.apiCalls).toBe(0);
    const half = await runHarness(["--pages-window", "2026-09-14T09:00:00Z/2026-09-14T09:00:30Z"]);
    expect(half.code).toBe(EXIT_NG);
  });

  it("引数の誤りは値を出さずに exit 1", async () => {
    const run = await runHarness(["https://secret.example.workers.dev"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).not.toContain("secret.example");
  });
});

// ── 5. nodeGet ────────────────────────────────────────────────────────────

/** 受けたヘッダを覚えるローカル（127.0.0.1）の HTTP サーバ。 */
async function withServer(run: (origin: string, received: Record<string, string | string[] | undefined>[]) => Promise<void>) {
  const received: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe("nodeGet：host への GET", () => {
  it("sec-fetch-mode: navigate が書き換えられずに届き、status・content-type・Date・本文を返す", async () => {
    await withServer(async (origin, received) => {
      const res = await nodeGet(new URL(DEEP_LINK_PATH, origin), NAVIGATION_HEADERS, 2_000);
      expect(res).toMatchObject({ status: 200, contentType: "text/html", text: "<!doctype html>" });
      expect(Number.isNaN(Date.parse(res.date ?? ""))).toBe(false);
      expect(received[0]?.["sec-fetch-mode"]).toBe("navigate");
    });
  });

  it("（使わない理由）Node の fetch は sec-fetch-mode を cors に書き換える。これが落ちたら冒頭の理由を見直す", async () => {
    await withServer(async (origin, received) => {
      await (await fetch(new URL(DEEP_LINK_PATH, origin), { headers: NAVIGATION_HEADERS })).text();
      expect(received[0]?.["sec-fetch-mode"]).toBe("cors");
    });
  });
});

// ── 6. /api の経路の計測（Issue #111。--api）────────────────────────────────────
//
// **実環境には一切届かない。** 時計・sleep・HTTP（Cloudflare の API と staging の host）・Analytics・
// 期間レポートを fake に差し替える。確かめるのは次の6つである。
//   1. 各経路・各規模を 5 回温め → 60 秒空けて → 20 回測る（温めと本測定の窓が分かれる）
//   2. 規模 2/20/200 件の準備（メンバー → 支出）と片付け（支出 → メンバー）の順
//   3. API の応答が失敗したら、その場で止める（片付けは必ず行う）
//   4. Analytics 不足・名前不明・反映待ち切れ・混入・読取権限不足では**非抵触にせず判断不能**
//   5. P-7 は 7.001 ms で抵触、7.000 ms と和 7.5 ms では非抵触（判定に和を使わない）
//   6. P-1 は過去 7 日の 1 件で抵触。読めなければ判断不能

const API_INSTANCE = "m12-cpu-warikan";

/** 試験用の待ち方。待ち時間は fake の時計が進むだけなので、現実の待ちは無い */
const API_FAST = {
  warmup: 5,
  measured: 20,
  gapMs: 60_000,
  firstReadDelayMs: 12_000,
  pollIntervalMs: 4_000,
  maxWaitMs: 60_000,
  requestTimeoutMs: 1_000,
} as const;

interface ApiCall {
  readonly method: string;
  readonly url: string;
  /** actions の経路の最後の段。GET の spec / views では空 */
  readonly action: string;
  /** この呼出のときの fake の時計（ミリ秒） */
  readonly at: number;
}

interface ApiFakeOptions {
  /** 本測定の窓の Worker ごとの max.cpuTime（µs）。既定は host 1000・gateway 800・data-api 5000 */
  readonly cpuMaxUs?: Partial<Record<ApiWorker, number>>;
  /** 窓の Worker ごとの回数（既定 20 = 送った数と同じ） */
  readonly requests?: number;
  /** Analytics の行が名乗る Worker 名の env（既定 staging。--env dev のときに dev を渡す） */
  readonly env?: Env;
  /** Worker の行を落とす（反映不足を作る） */
  readonly dropWorker?: ApiWorker;
  /** 名前が __unknown__ の起動を足す */
  readonly unknownRequests?: number;
  /** 反映待ちを終わらせない（読むたびに値が変わる） */
  readonly neverSettles?: boolean;
  /** Date ヘッダを固定する（温めと本測定の窓を重ねる） */
  readonly fixedDate?: boolean;
  /** 行の並びを読みごとに入れ替える（Analytics が並びを保証しないことを模す） */
  readonly reverseOrder?: boolean;
  /** この番号の窓だけ行を返さない（反映が 1 つの窓だけ遅れる） */
  readonly badWindowIndex?: number;
  /** この経路の index 回目の GET を失敗させる（index は宣言の読み込みを 1 とする） */
  readonly failGet?: { readonly routeId: string; readonly index: number; readonly status: number };
  /** 見本 dashboard の宣言と一覧を返す（Issue #216） */
  readonly dashboard?: boolean;
  /** 宣言からこの action を落とす（準備と片付けに要る action が無いことを作る） */
  readonly omitActions?: readonly string[];
  /** 宣言の activity の kind から options を落とす */
  readonly omitKindOptions?: boolean;
}

interface ApiFake {
  readonly fetch: typeof fetch;
  readonly calls: readonly ApiCall[];
  /** host への GET のパス（それ以外は含まない） */
  hostGets(): readonly ApiCall[];
  actions(): readonly string[];
  /** 操作の POST の入力（送った順） */
  posted(): readonly { readonly action: string; readonly input: Record<string, unknown> }[];
  sleeps(): readonly number[];
  queries(): readonly string[];
}

/** 一覧の行（fake の応答） */
const apiRow = (id: string, fields: Record<string, unknown>, computed: Record<string, number>): unknown => ({
  id,
  createdAt: "2026-09-17T03:00:00.000Z",
  updatedAt: "2026-09-17T03:00:00.000Z",
  fields,
  computed,
});

/** 経路の名前（/api/instances/<id>/spec と /views/<name> から引く） */
const apiRouteIdOf = (path: string): string => {
  if (path.endsWith("/spec")) return "spec";
  const match = /\/views\/([^/]+)$/.exec(path);
  return match?.[1] ?? path;
};

function createApiFake(options: ApiFakeOptions = {}, now: () => number = () => Date.now()): ApiFake {
  const members: { id: string; name: string }[] = [];
  const expenses: { id: string; description: string; amount: number; payer: string; participants: string[] }[] = [];
  const activities: { id: string; kind: string; date: string; attendees: string[]; cost: number }[] = [];
  const posted: { action: string; input: Record<string, unknown> }[] = [];
  const calls: ApiCall[] = [];
  const sleeps: number[] = [];
  const queries: string[] = [];
  const counts = new Map<string, number>();
  let counter = 0;
  let reads = 0;
  const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, "0")}`;

  const dateHeader = (): string => (options.fixedDate === true ? "Thu, 17 Sep 2026 03:00:00 GMT" : new Date(now()).toUTCString());
  const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status, headers: { date: dateHeader() } });

  const specActions = (
    options.dashboard === true
      ? [
          // 見本 dashboard の宣言の写し（名前は addMember・addActivity・deleteActivity・deleteMember）
          { name: "addMember", entity: "member", kind: "create" },
          { name: "addActivity", entity: "activity", kind: "create" },
          { name: "deleteActivity", entity: "activity", kind: "delete" },
          { name: "deleteMember", entity: "member", kind: "delete" },
        ]
      : [
          { name: "addMember", entity: "member" },
          { name: "addExpense", entity: "expense", kind: "create" },
          { name: "editExpense", entity: "expense", kind: "update" },
          { name: "deleteExpense", entity: "expense", kind: "delete" },
          { name: "deleteMember", entity: "member", kind: "delete" },
        ]
  ).filter((action) => !(options.omitActions ?? []).includes(action.name));
  const specEntities =
    options.dashboard === true
      ? [
          { name: "member", fields: { name: { type: "string", label: "名前" } } },
          {
            name: "activity",
            fields: {
              kind: {
                type: "enum",
                label: "種類",
                ...(options.omitKindOptions === true ? {} : { options: { practice: "練習", match: "試合", party: "飲み会" } }),
              },
              date: { type: "date", label: "日付" },
              attendees: { type: "list", of: "member", label: "参加した人" },
              cost: { type: "number", label: "費用" },
            },
          },
        ]
      : [{ name: "member", fields: { name: "string" } }];

  const handleGet = (url: URL): Response => {
    const routeId = apiRouteIdOf(url.pathname);
    const index = (counts.get(routeId) ?? 0) + 1;
    counts.set(routeId, index);
    if (options.failGet !== undefined && options.failGet.routeId === routeId && options.failGet.index === index) {
      return json({ error: "SPEC_UNAVAILABLE" }, options.failGet.status);
    }
    const instanceId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    if (routeId === "spec") {
      return json({
        instanceId,
        schemaVersion: "community.app-spec/v0.2",
        sourceSha256: "0".repeat(64),
        spec: {
          entities: specEntities,
          views: [],
          actions: specActions,
          validations: [],
          computed: [],
          permissions: [{ name: "read" }],
          minIdentity: { mode: "anonymous" },
        },
        permissions: { read: true, write: true },
        actions: specActions,
      });
    }
    if (routeId === "expenseList") {
      return json({
        instanceId,
        view: "expenseList",
        entity: "expense",
        fields: ["description", "amount", "payer", "participants"],
        computed: ["headcount", "shareAmount"],
        permissions: { read: true, write: true },
        actions: specActions.filter((action) => action.entity === "expense"),
        rows: expenses.map((expense) =>
          apiRow(
            expense.id,
            { description: expense.description, amount: expense.amount, payer: expense.payer, participants: expense.participants },
            { headcount: expense.participants.length, shareAmount: Math.floor(expense.amount / Math.max(1, expense.participants.length)) },
          ),
        ),
      });
    }
    if (routeId === "memberList" || routeId === "settlement") {
      return json({
        instanceId,
        view: routeId,
        entity: "member",
        fields: ["name"],
        computed: ["paid", "owed", "balance"],
        permissions: { read: true, write: true },
        actions: specActions.filter((action) => action.entity === "member"),
        rows: members.map((member) => apiRow(member.id, { name: member.name }, { paid: 0, owed: 0, balance: 0 })),
        ...(routeId === "settlement" ? { settlement: [] } : {}),
      });
    }
    if (options.dashboard === true && routeId === "dashboard") {
      // ダッシュボードは行を並べない（rows は空）。値は scope・groups・ranking に載る
      return json({
        instanceId,
        view: "dashboard",
        fields: [],
        computed: [],
        permissions: { read: true, write: true },
        actions: [],
        rows: [],
        scope: { activityCount: activities.length, attendeeTotal: 0, averageAttendees: null, averageCost: null },
        groups: { activitiesByMonth: [], activitiesByKind: [] },
        ranking: { topActivities: [] },
      });
    }
    if (options.dashboard === true && routeId === "activities") {
      return json({
        instanceId,
        view: "activities",
        entity: "activity",
        fields: ["kind", "date", "attendees", "cost"],
        computed: ["attendeeCount"],
        permissions: { read: true, write: true },
        actions: specActions.filter((action) => action.entity === "activity"),
        rows: activities.map((activity) =>
          apiRow(
            activity.id,
            { kind: activity.kind, date: activity.date, attendees: activity.attendees, cost: activity.cost },
            { attendeeCount: activity.attendees.length },
          ),
        ),
      });
    }
    if (options.dashboard === true && routeId === "members") {
      return json({
        instanceId,
        view: "members",
        entity: "member",
        fields: ["name"],
        computed: [],
        permissions: { read: true, write: true },
        actions: specActions.filter((action) => action.entity === "member"),
        rows: members.map((member) => apiRow(member.id, { name: member.name }, {})),
      });
    }
    return json({ error: "NOT_FOUND" }, 404);
  };

  const handleAction = (name: string, input: Record<string, unknown>): Response => {
    posted.push({ action: name, input });
    if (!specActions.some((action) => action.name === name)) return json({ error: "NOT_FOUND" }, 404);
    if (name === "addActivity") {
      const activity = {
        id: nextId("activity"),
        kind: String(input["kind"] ?? ""),
        date: String(input["date"] ?? ""),
        attendees: Array.isArray(input["attendees"]) ? (input["attendees"] as string[]) : [],
        cost: Number(input["cost"] ?? 0),
      };
      activities.push(activity);
      return json(apiRow(activity.id, { kind: activity.kind, date: activity.date }, {}), 201);
    }
    if (name === "deleteActivity") {
      const at = activities.findIndex((activity) => activity.id === String(input["id"] ?? ""));
      if (at < 0) return json({ error: "NOT_FOUND" }, 404);
      activities.splice(at, 1);
      return json({ entity: "activity", id: String(input["id"]), deleted: true });
    }
    if (name === "addMember") {
      const member = { id: nextId("member"), name: String(input["name"] ?? "") };
      members.push(member);
      return json(apiRow(member.id, { name: member.name }, {}), 201);
    }
    if (name === "addExpense") {
      const expense = {
        id: nextId("expense"),
        description: String(input["description"] ?? ""),
        amount: Number(input["amount"] ?? 0),
        payer: String(input["payer"] ?? ""),
        participants: Array.isArray(input["participants"]) ? (input["participants"] as string[]) : [],
      };
      expenses.push(expense);
      return json(apiRow(expense.id, { description: expense.description, amount: expense.amount }, {}), 201);
    }
    if (name === "deleteExpense" || name === "deleteMember") {
      const entity = name === "deleteExpense" ? "expense" : "member";
      const id = String(input["id"] ?? "");
      if (entity === "expense") {
        const at = expenses.findIndex((expense) => expense.id === id);
        if (at < 0) return json({ error: "NOT_FOUND" }, 404);
        expenses.splice(at, 1);
      } else {
        const referenced =
          expenses.some((expense) => expense.payer === id || expense.participants.includes(id)) ||
          activities.some((activity) => activity.attendees.includes(id));
        // #109：参照されているメンバーは消せない（支出を先に消さないと 409 で残る）
        if (referenced) return json({ error: "REFERENCE_IN_USE", references: [{ entity: "expense", field: "payer", count: 1 }] }, 409);
        const at = members.findIndex((member) => member.id === id);
        if (at < 0) return json({ error: "NOT_FOUND" }, 404);
        members.splice(at, 1);
      }
      return json({ entity, id, deleted: true });
    }
    return json({ error: "NOT_FOUND" }, 404);
  };

  /** 本測定の窓の行（Worker ごと1行）。窓の数は問い合わせの別名（w0・w1…）から数える */
  const analytics = (query: string): unknown => {
    reads++;
    const count = query.match(/w\d+: workersInvocationsAdaptive/g)?.length ?? 0;
    const accounts: Record<string, unknown> = {};
    for (let index = 0; index < count; index++) {
      if (options.badWindowIndex === index) {
        accounts[`w${index}`] = [];
        continue;
      }
      const rows: unknown[] = [];
      for (const worker of API_WORKERS) {
        if (worker === options.dropWorker) continue;
        const maxUs = (options.cpuMaxUs?.[worker] ?? { host: 1000, gateway: 800, "data-api": 5000 }[worker]) + (options.neverSettles === true ? reads * 100 : 0);
        const requests = options.requests ?? 20;
        rows.push({
          dimensions: { scriptName: scriptName(worker, options.env) },
          sum: { requests, errors: 0, cpuTimeUs: maxUs * requests },
          max: { cpuTime: maxUs },
          quantiles: { cpuTimeP50: maxUs, cpuTimeP99: maxUs },
          avg: { sampleInterval: 1 },
        });
      }
      if (options.unknownRequests !== undefined && options.unknownRequests > 0) {
        rows.push({
          dimensions: { scriptName: UNKNOWN_SCRIPT },
          sum: { requests: options.unknownRequests, errors: 0, cpuTimeUs: 1000 },
          max: { cpuTime: 1000 },
          quantiles: { cpuTimeP50: 1000, cpuTimeP99: 1000 },
          avg: { sampleInterval: 1 },
        });
      }
      if (options.reverseOrder === true && reads % 2 === 0) rows.reverse();
      accounts[`w${index}`] = rows;
    }
    return { data: { viewer: { accounts: [accounts] } }, errors: null };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const action = /\/actions\/([^/]+)$/.exec(path)?.[1] ?? "";
    calls.push({ method, url: `${url.host}${path}`, action: decodeURIComponent(action), at: now() });
    if (url.host === "api.cloudflare.com") {
      if (path.endsWith("/workers/subdomain")) {
        return json({ success: true, errors: [], result: { subdomain: "fake-sub-7f3a" } });
      }
      if (path.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        queries.push(body.query);
        return json(analytics(body.query));
      }
      return json({ success: false }, 404);
    }
    if (method === "GET") return handleGet(url);
    const input2 = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return handleAction(action, input2);
  };

  return {
    fetch: fetchImpl,
    calls,
    hostGets: () => calls.filter((call) => call.method === "GET" && !call.url.startsWith("api.cloudflare.com")),
    actions: () => calls.filter((call) => call.action !== "").map((call) => call.action),
    posted: () => posted,
    sleeps: () => sleeps,
    queries: () => queries,
  };
}

/** 計測モードの argv と fake の io を組む */
interface ApiRunOptions {
  readonly sample?: string;
  readonly sizes?: string;
  readonly routes?: string;
  readonly warm?: string;
  readonly count?: string;
  readonly env?: string;
  readonly maxRequests?: string;
  readonly fake?: ApiFakeOptions;
  readonly p1?: ExceededReading | undefined;
  readonly p1Throws?: boolean;
  readonly instance?: string;
  readonly extraArgv?: readonly string[];
  readonly policy?: typeof API_FAST;
}

async function runApiMode(options: ApiRunOptions = {}) {
  let clock = Date.parse("2026-09-17T03:00:00.000Z");
  const fake = createApiFake(options.fake ?? {}, () => clock);
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const io = {
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    policy: options.policy ?? API_FAST,
    readExceeded: async (): Promise<ExceededReading | undefined> => {
      if (options.p1Throws === true) throw new MeasureError("Analytics を読む権限が足りない");
      return options.p1 ?? { musunest: 0, unknown: 0, since: "2026-09-11", until: "2026-09-17" };
    },
  };
  const argv = [
    "--instance",
    options.instance ?? API_INSTANCE,
    ...(options.sample === undefined ? [] : ["--sample", options.sample]),
    ...(options.sizes === undefined ? [] : ["--sizes", options.sizes]),
    ...(options.routes === undefined ? [] : ["--routes", options.routes]),
    ...(options.env === undefined ? [] : ["--env", options.env]),
    ...(options.warm === undefined ? [] : ["--warm", options.warm]),
    ...(options.count === undefined ? [] : ["--count", options.count]),
    ...(options.maxRequests === undefined ? [] : ["--max-requests", options.maxRequests]),
    ...(options.extraArgv ?? []),
  ];
  const code = await runApiMeasurement(argv, io);
  return { code, out, err, all: [...out, ...err].join("\n"), fake, sleeps, io };
}

describe("API の計測：5 回温め → 60 秒空けて → 20 回測る", () => {
  it("spec の経路を、宣言の読み込み 1 回 + 温め 5 回 + 本測定 20 回 送り、温めと本測定の間を 60 秒空ける", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec" });
    expect(run.code).toBe(EXIT_OK);
    const specGets = run.fake.hostGets().filter((call) => call.url.endsWith("/spec"));
    expect(specGets).toHaveLength(26);
    const warmLast = specGets[5];
    const measuredFirst = specGets[6];
    expect(warmLast).toBeDefined();
    expect(measuredFirst).toBeDefined();
    expect((measuredFirst?.at ?? 0) - (warmLast?.at ?? 0)).toBeGreaterThanOrEqual(API_FAST.gapMs);
    expect(run.sleeps).toContain(API_FAST.gapMs);
    // Analytics は、本測定の窓だけを読む（w0 が 1 つ）。2 回続けて同じ値になるまで読む
    expect(run.fake.queries().length).toBeGreaterThanOrEqual(2);
    for (const query of run.fake.queries()) {
      expect(query.match(/w\d+: workersInvocationsAdaptive/g)).toHaveLength(1);
    }
    expect(run.all).toContain("本測定 20 回");
  });

  it("温めと本測定の窓が重なったら（同じ秒に収まったら）判定せずに止める", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { fixedDate: true } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("温めの窓と本測定の窓が重なる");
    expect(run.fake.queries()).toHaveLength(0);
  });
});

describe("API の計測：規模 2/20/200 件の準備と片付けの順", () => {
  it("規模ごとに メンバー3 → 支出N → （計測）→ 支出N削除 → メンバー3削除 の順で、支出が先に消える", async () => {
    const run = await runApiMode({ sizes: "basic,20,200", routes: "spec" });
    expect(run.code).toBe(EXIT_OK);
    const actions = run.fake.actions();
    expect(actions.filter((name) => name === "addMember")).toHaveLength(9);
    expect(actions.filter((name) => name === "addExpense")).toHaveLength(222);
    expect(actions.filter((name) => name === "deleteExpense")).toHaveLength(222);
    expect(actions.filter((name) => name === "deleteMember")).toHaveLength(9);
    // 支出の削除が、メンバーの削除より先（参照されているメンバーを先に消すと 409 で残る）
    expect(actions.indexOf("deleteExpense")).toBeLessThan(actions.indexOf("deleteMember"));
    // 先頭の規模（基本）は メンバー 3 → 支出 2 → 支出 2 削除 → メンバー 3 削除
    expect(actions.slice(0, 10)).toEqual([
      "addMember", "addMember", "addMember", "addExpense", "addExpense",
      "deleteExpense", "deleteExpense", "deleteMember", "deleteMember", "deleteMember",
    ]);
    expect(run.out.join("\n")).toContain("メンバー 3・支出 200");
  });

  it("準備と片付けは計測の窓の外（片付けの GET は本測定の窓の後）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec" });
    const specGets = run.fake.hostGets().filter((call) => call.url.endsWith("/spec"));
    // 宣言 1 + 温め 5 + 本測定 20 = 26。最後の 1 つが本測定の最後
    const lastMeasured = specGets[25];
    expect(lastMeasured).toBeDefined();
    // そのあとの最初の一覧の GET（片付け）は、窓の余白（WINDOW_PAD_MS）より後ろにある
    const after = run.fake
      .hostGets()
      .filter((call) => call.url.includes("/views/") && call.at > (lastMeasured?.at ?? 0));
    expect(after.length).toBeGreaterThan(0);
    expect((after[0]?.at ?? 0) - (lastMeasured?.at ?? 0)).toBeGreaterThanOrEqual(WINDOW_PAD_MS);
    expect(run.code).toBe(EXIT_OK);
  });
});

describe("API の計測：応答が失敗したらその場で止める", () => {
  it("本測定の 3 回目が 503 なら、そこで止めて片付けだけを行う（exit 1）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      fake: { failGet: { routeId: "spec", index: 9, status: 503 } },
    });
    // 宣言 1 + 温め 5 + 本測定 3（3 回目で失敗）
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("HTTP 503");
    expect(run.fake.hostGets().filter((call) => call.url.endsWith("/spec"))).toHaveLength(9);
    expect(run.fake.queries()).toHaveLength(0);
    // 片付け（支出 → メンバー）は行う
    expect(run.fake.actions().filter((name) => name.startsWith("delete"))).toContain("deleteExpense");
  });

  it("宣言（spec）の応答が失敗しても、そこで止める", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      fake: { failGet: { routeId: "spec", index: 1, status: 503 } },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("HTTP 503");
    expect(run.fake.actions()).toHaveLength(0);
  });
});

describe("API の計測：判断不能（非抵触と報告しない）", () => {
  it("Worker の行が欠けていれば判断不能（exit 2）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { dropWorker: "gateway" } });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("判断不能");
    expect(run.all).toContain("gateway");
  });

  it("名前が __unknown__ の起動があれば判断不能", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { unknownRequests: 3 } });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain(UNKNOWN_SCRIPT);
  });

  it("窓の回数が送った数より多ければ（他の通信の混入）判断不能", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { requests: 100 } });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("合わない");
  });

  it("窓の回数が足りなければ（反映不足）判断不能", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { requests: 2 } });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("反映を待ちきれなかった");
  });

  it("反映を待ちきれなければ判断不能", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { neverSettles: true } });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("反映を待ちきれなかった");
  });

  it("行の並びが読みごとに変わっても、値が同じなら落ち着いたと見なす", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", fake: { reverseOrder: true } });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("触れていない");
  });

  it("1 つの窓が落ち着かなくても、ほかの窓は判定する（巻き込まない）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec,expenseList",
      fake: { badWindowIndex: 1 },
    });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    // 1 つ目の窓（spec）は判定できている（Worker ごとの max が出る）
    expect(run.all).toContain("basic / spec: host 1.00 ms");
    expect(run.all).toContain("data-api 5.00 ms");
    // 2 つ目の窓（expenseList）だけが判断不能（max を出さない）
    expect(run.all).toContain("basic / expenseList: —");
    expect(run.all).toContain("判断不能");
  });

  it("過去 7 日の期間レポートを読めなければ P-1 は判断不能（P-7 が非抵触でも exit 2）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", p1Throws: true });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("P-1: 判断不能");
    expect(run.all).toContain("非抵触と報告しない");
  });
});

describe("API の計測：P-7 と P-1 の判定", () => {
  it("単体の最大が 7.000 ms 以下で和が 7 ms を超えても非抵触（exit 0）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      fake: { cpuMaxUs: { host: 3000, gateway: 2500, "data-api": 2000 } },
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("触れていない");
    expect(run.all).toContain("和 7.50 ms");
    expect(run.all).toContain("判定に使わない");
  });

  it("単体の最大が 7.001 ms なら P-7 に触れる（exit 3）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      fake: { cpuMaxUs: { host: 1000, gateway: 800, "data-api": 7001 } },
    });
    expect(run.code).toBe(EXIT_TOUCHED);
    expect(run.all).toContain("P-7");
    expect(run.all).toContain("触れた");
    expect(run.all).toContain("管理を通じて窓口へ返す");
  });

  it("7.000 ms ちょうどなら P-7 に触れない（exit 0）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      fake: { cpuMaxUs: { host: 7000, gateway: 7000, "data-api": 7000 } },
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("触れていない");
  });

  it("過去 7 日に上限超過が 1 件あれば P-1 に触れる（P-7 が非抵触でも exit 3）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      p1: { musunest: 1, unknown: 0, since: "2026-09-11", until: "2026-09-17" },
    });
    expect(run.code).toBe(EXIT_TOUCHED);
    expect(run.all).toContain("P-1: 触れた");
  });
});

describe("API の計測：上限と境界", () => {
  it("経路を合算して上限を緩めない（4 経路 × 25 回でも、1 経路ずつは 50 回以内）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec,expenseList,memberList,settlement" });
    expect(run.code).toBe(EXIT_OK);
    // 4 経路 × (温め 5 + 本測定 20) = 100 回を送っている（合算して上限を緩めていない）
    expect(run.fake.hostGets().length).toBeGreaterThan(100);
  });

  it("温め + 本測定が 50 回を超える指定は、1 回も送らずに exit 1", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", warm: "30", count: "21" });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
    expect(run.all).toContain("合算して上限を緩めない");
  });

  it("demo を含むインスタンス ID は触らない（exit 1・1 回も送らない）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", instance: "m12-demo-warikan" });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
  });

  it("--instance が無ければ exit 1・1 回も送らない", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", instance: "" });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
  });

  it("--api --help は使い方を出して exit 0", async () => {
    const run = await runApiMode({ extraArgv: ["--help"] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("--instance");
  });
});

describe("API の計測：env と回数の上限（Issue #152）", () => {
  it("--env dev は dev の Worker 名を読む（既定は staging のまま）", async () => {
    const dev = await runApiMode({ sizes: "basic", routes: "spec", env: "dev", fake: { env: "dev" } });
    expect(dev.code).toBe(EXIT_OK);
    expect(dev.all).toContain("env=dev");

    // 同じ dev の行でも、--env を渡さなければ staging の名前を探すので判定できない（env が効いていることの裏取り）
    const staged = await runApiMode({ sizes: "basic", routes: "spec", fake: { env: "dev" } });
    expect(staged.code).toBe(EXIT_UNDETERMINED);
  });

  it("--env production は測らない（exit 1・1 回も送らない）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", env: "production" });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
    expect(run.all).toContain("別アカウント");
  });

  it("--max-requests を明示すると、温め 5 + 本測定 200 を 1 窓で送れる（既定の 50 は動かさない）", async () => {
    const run = await runApiMode({
      sizes: "basic",
      routes: "spec",
      warm: "5",
      count: "200",
      maxRequests: "205",
      fake: { requests: 200 },
    });
    expect(run.code).toBe(EXIT_OK);
    // 宣言 1 + 温め 5 + 本測定 200
    expect(run.fake.hostGets().filter((call) => call.url.endsWith("/spec"))).toHaveLength(206);
    expect(run.all).toContain("205");
    expect(run.fake.queries().length).toBeGreaterThanOrEqual(2);
  });

  it("--max-requests の既定は 50 のまま（200 回は明示しないと送れない）", async () => {
    const run = await runApiMode({ sizes: "basic", routes: "spec", warm: "5", count: "200", fake: { requests: 200 } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
    expect(run.all).toContain("50");
  });
});

describe("API の計測：CLI への結線", () => {
  it("runCli が --api を API の計測へ回す（既存の計測コマンドに API 用のモードを足す）", async () => {
    let clock = Date.parse("2026-09-17T03:00:00.000Z");
    const fake = createApiFake({}, () => clock);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["--api", "--instance", API_INSTANCE, "--sizes", "basic", "--routes", "spec"], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetch: fake.fetch,
      get: async () => ({ status: 200, contentType: "text/html", date: null, text: "" }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      policy: { requestTimeoutMs: 1_000, phaseGapMs: 8_000, firstReadDelayMs: 60_000, pollIntervalMs: 30_000, maxWaitMs: 300_000 },
      apiPolicy: API_FAST,
      readExceeded: async () => ({ musunest: 0, unknown: 0, since: "2026-09-11", until: "2026-09-17" }),
    });
    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("api-measure");
  });
});

// ── 見本 dashboard（--sample dashboard。Issue #216）──────────────────────────────
//
//   1. メンバー 4 → 活動 N（日付は日本時間の今月と先月・kind は宣言の options・attendees は作ったメンバー）→ 計測 →
//      活動 N 削除 → メンバー 4 削除 の順。action の名前は宣言から entity と kind で引く
//   2. 経路は spec・dashboard・activities・members（warikan の経路は選べない）
//   3. 準備と片付けに要る action・kind の選択肢が宣言に無ければ、何も書かずに止める（exit 1）
//   4. 出力に URL・サブドメイン・Account ID・トークンが無い

const DASHBOARD_INSTANCE = "m15-cpu-dashboard";

/** 出力に秘密の値が無いこと（API の計測の出力） */
function expectApiNothingSecret(all: string): void {
  for (const secret of [TOKEN, ACCOUNT_ID, SUBDOMAIN, HOSTNAME, "workers.dev", "https://"]) {
    expect(all).not.toContain(secret);
  }
}

describe("API の計測：見本 dashboard の準備と片付け（Issue #216）", () => {
  it("200 件：メンバー 4 → 活動 200 → （計測）→ 活動 200 削除 → メンバー 4 削除 の順で、活動が先に消える", async () => {
    const run = await runApiMode({
      sample: "dashboard",
      sizes: "200",
      routes: "dashboard",
      instance: DASHBOARD_INSTANCE,
      fake: { dashboard: true },
    });
    expect(run.code).toBe(EXIT_OK);
    const actions = run.fake.actions();
    expect(actions.filter((name) => name === "addMember")).toHaveLength(4);
    expect(actions.filter((name) => name === "addActivity")).toHaveLength(200);
    expect(actions.filter((name) => name === "deleteActivity")).toHaveLength(200);
    expect(actions.filter((name) => name === "deleteMember")).toHaveLength(4);
    // warikan の action は呼ばない
    expect(actions.some((name) => name.includes("Expense"))).toBe(false);
    // メンバー → 活動 → 活動の削除 → メンバーの削除（参照されているメンバーを先に消すと 409 で残る）
    expect(actions.slice(0, 4)).toEqual(["addMember", "addMember", "addMember", "addMember"]);
    expect(actions.lastIndexOf("addActivity")).toBeLessThan(actions.indexOf("deleteActivity"));
    expect(actions.lastIndexOf("deleteActivity")).toBeLessThan(actions.indexOf("deleteMember"));
    // ダッシュボードを 温め 5 + 本測定 20 回 読む（準備と片付けの一覧の GET は activities・members）
    expect(run.fake.hostGets().filter((call) => call.url.endsWith("/views/dashboard"))).toHaveLength(25);
    const out = run.out.join("\n");
    expect(out).toContain("見本 dashboard");
    expect(out).toContain("メンバー 4・活動 200");
    expect(out).toContain("活動 → メンバーの順");
    expect(out).toContain("200 / dashboard: host 1.00 ms");
    expectApiNothingSecret(run.all);
  });

  it("活動の入力：日付は日本時間の今月と先月に半分ずつ、kind は宣言の options、attendees は作ったメンバーの id", async () => {
    const run = await runApiMode({
      sample: "dashboard",
      sizes: "200",
      routes: "spec",
      instance: DASHBOARD_INSTANCE,
      fake: { dashboard: true },
    });
    expect(run.code).toBe(EXIT_OK);
    const addMembers = run.fake.posted().filter((post) => post.action === "addMember");
    expect(addMembers.map((post) => post.input["name"])).toEqual([...DASHBOARD_MEMBER_NAMES]);
    // fake の id は作った順の通し番号（member-0001…member-0004）
    const memberIds = new Set(addMembers.map((_, index) => `member-${String(index + 1).padStart(4, "0")}`));
    const inputs = run.fake.posted().filter((post) => post.action === "addActivity").map((post) => post.input);
    expect(inputs).toHaveLength(200);
    // fake の時計は 2026-09-17T03:00Z（日本時間 9 月 17 日）。今月 = 2026-09、先月 = 2026-08
    const dates = inputs.map((input) => String(input["date"]));
    expect(dates.filter((date) => date.startsWith("2026-09-"))).toHaveLength(100);
    expect(dates.filter((date) => date.startsWith("2026-08-"))).toHaveLength(100);
    expect(dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))).toBe(true);
    expect(new Set(inputs.map((input) => input["kind"]))).toEqual(new Set(["practice", "match", "party"]));
    for (const input of inputs) {
      const attendees = input["attendees"] as string[];
      expect(attendees.length).toBeGreaterThanOrEqual(1);
      expect(attendees.length).toBeLessThanOrEqual(DASHBOARD_MEMBER_NAMES.length);
      expect(attendees.every((id) => memberIds.has(id))).toBe(true);
      expect(typeof input["cost"]).toBe("number");
    }
  });

  it("経路の既定は spec・dashboard・activities・members の 4 つ（窓も 4 つ）", async () => {
    const run = await runApiMode({ sample: "dashboard", sizes: "basic", instance: DASHBOARD_INSTANCE, fake: { dashboard: true } });
    expect(run.code).toBe(EXIT_OK);
    expect(DASHBOARD_ROUTES.map((route) => route.id)).toEqual(["spec", "dashboard", "activities", "members"]);
    for (const query of run.fake.queries()) expect(query.match(/w\d+: workersInvocationsAdaptive/g)).toHaveLength(4);
    for (const id of ["spec", "dashboard", "activities", "members"]) expect(run.all).toContain(`basic / ${id}: host`);
    expect(run.out.join("\n")).toContain("メンバー 4・活動 2");
  });

  it("warikan の経路は dashboard では選べない（exit 1・1 回も送らない）", async () => {
    const run = await runApiMode({ sample: "dashboard", routes: "expenseList", instance: DASHBOARD_INSTANCE, fake: { dashboard: true } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
    expect(run.all).toContain("--routes は spec|dashboard|activities|members から選ぶ");
  });

  it("知らない見本は測らない（exit 1・1 回も送らない・値を出さない）", async () => {
    const run = await runApiMode({ sample: "secret-sample-x", instance: DASHBOARD_INSTANCE });
    expect(run.code).toBe(EXIT_NG);
    expect(run.fake.calls).toHaveLength(0);
    expect(run.all).toContain("--sample は warikan|dashboard から選ぶ");
    expect(run.all).not.toContain("secret-sample-x");
  });
});

describe("API の計測：見本 dashboard の宣言が足りないとき（Issue #216）", () => {
  it.each(["addActivity", "deleteActivity", "deleteMember"])(
    "宣言に %s が無ければ、準備も片付けもせずに止める（exit 1）",
    async (omitted) => {
      const run = await runApiMode({
        sample: "dashboard",
        sizes: "200",
        routes: "dashboard",
        instance: DASHBOARD_INSTANCE,
        fake: { dashboard: true, omitActions: [omitted] },
      });
      expect(run.code).toBe(EXIT_NG);
      expect(run.all).toContain("宣言に、準備と片付けに要る action が無い（member・activity の create と delete）");
      expect(run.fake.actions()).toHaveLength(0);
      expect(run.fake.queries()).toHaveLength(0);
      expectApiNothingSecret(run.all);
    },
  );

  it("warikan の宣言に dashboard を向けても、action が無いとして止める（別の見本のインスタンスを書き換えない）", async () => {
    const run = await runApiMode({ sample: "dashboard", sizes: "basic", routes: "spec", instance: DASHBOARD_INSTANCE });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("member・activity の create と delete");
    expect(run.fake.actions()).toHaveLength(0);
  });

  it("activity の kind に選択肢（options）が無ければ、何も書かずに止める（exit 1）", async () => {
    const run = await runApiMode({
      sample: "dashboard",
      sizes: "basic",
      routes: "spec",
      instance: DASHBOARD_INSTANCE,
      fake: { dashboard: true, omitKindOptions: true },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("activity の kind の選択肢");
    expect(run.fake.actions()).toHaveLength(0);
  });
});

describe("activityPlans：活動の日付は日本時間の今月と先月", () => {
  it("日本時間で月が変わっていれば、UTC がまだ前の月でも日本時間の月を今月にする", () => {
    // 2026-01-31T16:00Z = 日本時間 2026-02-01 01:00
    const plans = activityPlans(4, ["practice"], Date.parse("2026-01-31T16:00:00.000Z"));
    expect(plans.map((plan) => plan.date)).toEqual(["2026-02-01", "2026-01-01", "2026-02-02", "2026-01-02"]);
  });

  it("1 月の先月は前の年の 12 月。日は 28 日までを巡る", () => {
    const plans = activityPlans(60, ["practice", "match"], Date.parse("2026-01-10T00:00:00.000Z"));
    expect(plans[1]?.date).toBe("2025-12-01");
    expect(plans.every((plan) => Number(plan.date.slice(8)) <= 28)).toBe(true);
    expect(plans[56]?.date).toBe("2026-01-01");
    expect(plans.map((plan) => plan.kind).slice(0, 3)).toEqual(["practice", "match", "practice"]);
  });

  it("選択肢が無ければ落とす", () => {
    expect(() => activityPlans(2, [], Date.parse("2026-09-17T03:00:00.000Z"))).toThrow(MeasureError);
  });
});
