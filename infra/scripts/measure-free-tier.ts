// measure-free-tier — Free の枠に対する余裕を、staging の host で実測する（Issue #25。06 §7 の要確認 1・2・4）。
//
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts [--pages <m>] [--healthz <n>] [--cpu-limit-ms <ms>]
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --pages-window <since>/<until> --healthz-window <since>/<until> [--pages <m>] [--healthz <n>]
//
// 1つ目の形は、staging の host に GET を送り、Workers Analytics（GraphQL）に反映されるのを待って読み、判定する。
// 2つ目の形は GET を送らない。前に送った窓（1つ目の形が出力する）を Analytics から読み直すだけである。
// 資格情報は環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID（手元の .env の CI 用トークン。アカウント①）。
//
// ── なぜ Worker の中で測らないか ──────────────────────────────────────────────
//
// Workers の時計（performance.now・Date.now）は I/O のときにしか進まない。応答に「処理時間」を載せても CPU 時間にはならない。
// だから CPU 時間の正は Workers Analytics の invocation の cpuTime である（03 §5「無償枠の実測」）。
// Analytics は数分遅れて反映されるので、デプロイ直後の貫通スモーク（smoke.ts）には入れない（deploy-staging の 10分の線を削る）。
// 宛先はスモークと同じ staging の host で、スモークとは別に手元から回す。
//
// ── 何を送り、何を読むか ──────────────────────────────────────────────────────
//
//   ① Cloudflare の API で workers.dev のサブドメインを読み、host のオリジンを組み立てる（表示もファイルへの書き込みもしない）
//   ② ページ：/ と深いリンクを各 m 回。ブラウザのページ遷移と同じヘッダ（sec-fetch-mode: navigate）を付ける
//      PHASE_GAP を空けて、
//      /healthz を n 回。どちらも1回ずつ順に送り、SPAシェル（200 text/html）／全層 ok でなければその場で止める
//      合計は MAX_REQUESTS（50）以内。超える指定は1回も送らずに落とす
//   ③ Analytics を読む。2つの窓（ページ／healthz）を別々に集計し、2回続けて同じ値になったら反映済みとみなす
//        workersInvocationsAdaptive          … Worker（scriptName）ごとの sum.requests・sum.cpuTimeUs・max.cpuTime・
//                                              quantiles.cpuTimeP50/P99（cpuTime の単位はマイクロ秒）
//        workersAssetsRequestsAdaptiveGroups … Static Assets が返したリクエスト。hostname（host の workers.dev）で絞る
//   ④ 判定する
//        要確認 4 … ページの窓で Worker の起動が 0 で、assets の requests が送った数くらい → Static Assets は 100k/日 を消費しない
//        要確認 2 … healthz の窓で gateway・data-api の requests も送った数くらい → Service Binding の先も別の requests に数えられる
//        CPU     … Worker ごとの max の和（同じリクエストで3つとも max だった場合の上界）を上限と比べる。
//                   host の1回あたりの cpuTime が gateway・data-api の和より小さければ、host の値は下流を含まない（要確認 1）
//
// 窓は応答の Date ヘッダ（Cloudflare の時計）から作り、前後に WINDOW_PAD を足す。手元の時計のずれで窓がずれないようにするためである。
// ページの窓と healthz の窓が重なったら読まずに落とす（どちらのリクエストか区別できない）。
//
// ── サンプリング ────────────────────────────────────────────────────────────────
//
// Adaptive のデータセットは少ない数でも揺れる。2026-09-14 の実測では、20 回の起動が sampleInterval 1.5 の重みで 27 回・26 回と出たり、
// 重み 1 のまま 17 回と出たりした（ページ 20 回の assets は 22 回と 11 回）。だから回数を「送った数とぴったり」では比べない。
// 問いは「0 か、送った数くらいか」なので、半分から倍までを同じくらいとみなす（aboutSent）。
// CPU 時間の max と分位はサンプルから計算されるので、サンプリングがあれば取りこぼし得ると出力に書く。
//
// ── Worker 名が __unknown__ で返るとき ──────────────────────────────────────────
//
// 2026-09-14 の実測：その日の 08:01 UTC ごろに作られた staging の3つの Worker は、少なくとも 09:14 までの読み取りで scriptName（と scriptTag・
// environmentName）が __unknown__ で返り、09:33 には名前が入った。同じトークン・同じデータセットで、以前からある Worker の名前は読めた。
// だから権限でもデータセットや欄の選び方でもなく、新しい Worker の名前が Analytics に反映されるまでの遅れである（06 §7.1）。
// 名前の無い起動がある窓は判定しない（どの Worker か決められない）。時間を空けて、窓を指定して読み直す。
//
// ── Node の fetch を使わない GET ──────────────────────────────────────────────
//
// ページの GET は、ブラウザのページ遷移と同じヘッダ（sec-fetch-mode: navigate）で送る。Static Assets は、run_worker_first を配列で書かない
// 構成ではこのヘッダでナビゲーションを見分けて Worker を起動しない（一次情報：Static Assets の SPA のルーティング）。host は配列で書いているので
// ヘッダによらないはずだが、ブラウザと違う形で測ると、ルーティングの設定を変えたときに結論が黙って変わる。
// Node の fetch（undici）は sec-fetch-mode を cors に書き換えるので、host への GET は node:http(s) で送る。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）────────────────────────────
//
// **出すのは回数・ミリ秒・判定・窓の時刻だけ。** URL・ホスト名・サブドメイン・Account ID・スクリプトの ID・トークンを出さない
// （スクリプトの ID は読みもしない）。API のエラーの文言は、それらを伏せ、長さを切ってから出す。
//   - 実環境への操作は読み取りだけ：サブドメインの GET、GraphQL の読み取り、staging の host への GET。書き込みの API を呼ばない
//   - production（アカウント②）には届かない：宛先は staging の Worker 名に固定し、CLOUDFLARE_ACCOUNT_ID が
//     CLOUDFLARE_ACCOUNT_ID_PROD と同じなら1回も送らずに落とす
//   - 権限が足りない（401・403・GraphQL の認可エラー）ときは、トークンを作らずに止める
//
// ── 終了コード ──────────────────────────────────────────────────────────────
//
//   0 … 反映を確かめ、3つとも判定でき、設計の前提（Static Assets は Worker を起動しない・チェーン合計が上限内）が成り立った
//   1 … 引数・資格情報・GET・API の失敗。または前提が崩れた（Worker が起動した・CPU が上限を超え得る）
//   2 … 判定できない（反映を待ちきれない・他のリクエストが混ざった・名前がまだ入っていない）。窓を指定して読み直す
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HEALTHZ_PATH, judge as judgeHealthz } from "./smoke.ts";
import type { Env } from "./sync-bindings.ts";
// 経路のパスは契約の正本から組む（見本 dashboard の経路は api-measure-fixture の経路の型に入らないので、直接読む）
import { apiSpecPath, apiViewPath } from "../../packages/appspec-schema/src/api.ts";
// /api の経路の計測（Issue #111）の測定条件と判定の正本。ここから値は読むだけで、書き戻さない。
import {
  actionPath,
  API_GAP_MS,
  API_MEASURED_REQUESTS,
  API_MEMBER_NAMES,
  API_ROUTES,
  API_SIZES,
  API_WARMUP_REQUESTS,
  API_WORKERS,
  expensePlans,
  judgeP1,
  judgeP7,
  routeById,
  sizeById,
  type ApiSizeId,
  type ApiWorker,
  type ExceededReading,
  type P1Finding,
  type P7Finding,
  type Verdict,
  type Verdicts,
} from "./api-measure-fixture.ts";

/** 測る環境。production は別アカウントで、詳細を隠す healthz なので測らない。dev は常設していない。 */
export const TARGET_ENV = "staging" as const satisfies Env;

/** 経路の順（host → gateway → data-api。03 §1）。 */
export const WORKERS = ["host", "gateway", "data-api"] as const;
export type Worker = (typeof WORKERS)[number];

/** Worker 名。正本は各 wrangler.jsonc の env.<env>.name（食い違えば measure-free-tier.test.ts が落とす）。 */
export const scriptName = (worker: Worker, env: Env = TARGET_ENV): string => `musunest-${env}-${worker}`;

/** Analytics が Worker の名前を決められないときの値。 */
export const UNKNOWN_SCRIPT = "__unknown__";

export const ROOT_PATH = "/";
/** SPA のルーティングに任せる深いリンク。host の受入試験（apps/host/src/worker/index.test.ts）と同じパス。 */
export const DEEP_LINK_PATH = "/communities/c1/apps";

/** ブラウザのページ遷移が付けるヘッダ。Static Assets はこれでナビゲーションを見分ける。 */
export const NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
const HEALTHZ_HEADERS: Readonly<Record<string, string>> = { accept: "application/json" };

/** 1回の実測で host に送る GET の上限（Issue #25 で承認された枠）。 */
export const MAX_REQUESTS = 50;

/** Free の CPU 時間の上限（ミリ秒）。一次情報 https://developers.cloudflare.com/workers/platform/limits/#cpu-time（2026-09-14 に確認）。変わったら --cpu-limit-ms で与える。 */
export const FREE_CPU_LIMIT_MS = 10;

export interface Plan {
  /** / と深いリンクを、それぞれ何回送るか */
  readonly pages: number;
  /** /healthz を何回送るか */
  readonly healthz: number;
}

/** 既定は合計 40 回（上限 50 に 10 回の余裕）。 */
export const DEFAULT_PLAN: Plan = { pages: 10, healthz: 20 };

export const requestCount = (plan: Plan): number => plan.pages * 2 + plan.healthz;

export interface MeasurePolicy {
  /** 1回の GET（本文の読み取りまで）の上限 */
  readonly requestTimeoutMs: number;
  /** ページの GET と /healthz の GET の間を空ける時間。窓を分けるため */
  readonly phaseGapMs: number;
  /** 送り終えてから、最初に Analytics を読むまでの待ち */
  readonly firstReadDelayMs: number;
  /** Analytics を読み直す間隔 */
  readonly pollIntervalMs: number;
  /** 最初に読んでから、反映を待つ時間の上限 */
  readonly maxWaitMs: number;
}

/** GraphQL は1分に2回しか読まない（上限は 5 分に 300 回）。最悪でも 31 回・送り終えてから 16 分で終わる。 */
export const MEASURE_POLICY: MeasurePolicy = {
  requestTimeoutMs: 10_000,
  phaseGapMs: 8_000,
  firstReadDelayMs: 60_000,
  pollIntervalMs: 30_000,
  maxWaitMs: 15 * 60_000,
};

/** 窓の前後に足す幅。Date ヘッダは秒で切り捨てられ、Analytics の datetime はリクエストの始まりの秒なので。 */
export const WINDOW_PAD_MS = 2_000;

export const EXIT_OK = 0;
export const EXIT_NG = 1;
export const EXIT_UNDETERMINED = 2;
/** `--api` の計測で P-7 か P-1 に触れた（**管理を通じて窓口へ返す**。課金の操作は人が行う。Issue #111）。 */
export const EXIT_TOUCHED = 3;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class MeasureError extends Error {
  override name = "MeasureError";
}

// ── 資格情報と宛先 ──────────────────────────────────────────────────────────────

export interface Credentials {
  readonly token: string;
  readonly accountId: string;
}

/** CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む。値はエラーにも出さない。 */
export function readCredentials(env: Readonly<Record<string, string | undefined>>): Credentials {
  const token = env["CLOUDFLARE_API_TOKEN"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    throw new MeasureError(
      "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る（手元の .env の CI 用トークン。--env-file=.env で渡す）",
    );
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new MeasureError("CLOUDFLARE_API_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new MeasureError("CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）");
  }
  const production = env["CLOUDFLARE_ACCOUNT_ID_PROD"];
  if (production !== undefined && production.toLowerCase() === accountId.toLowerCase()) {
    throw new MeasureError(
      "CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。staging（アカウント①）でしか測らない",
    );
  }
  return { token, accountId };
}

/** workers.dev のサブドメインとして読める形か（DNS のラベル）。 */
const isSubdomain = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);

/** host のホスト名。表示しない。 */
export const hostHostname = (subdomain: string, env: Env = TARGET_ENV): string =>
  `${scriptName("host", env)}.${subdomain}.workers.dev`;

// ── 出力を伏せる ───────────────────────────────────────────────────────────────

/** API のエラーの文言を出せる形にする。秘密の値・32 桁の 16 進・UUID・workers.dev のホスト名を伏せ、長さを切る。 */
export function sanitize(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) if (secret !== "") text = text.split(secret).join("<伏せた>");
  text = text
    .replace(/[\w.-]+\.workers\.dev/gi, "<伏せた>.workers.dev")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<伏せた>")
    .replace(/\b[0-9a-f]{32}\b/gi, "<伏せた>");
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
}

// ── host への GET ──────────────────────────────────────────────────────────────

export interface HttpResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** Date ヘッダ（Cloudflare の時計） */
  readonly date: string | null;
  readonly text: string;
}

/** 1回の GET。失敗は例外にする（文言はホスト名を含み得るので、呼び出し側は種別だけを使う）。 */
export type HttpGet = (url: URL, headers: Readonly<Record<string, string>>, timeoutMs: number) => Promise<HttpResponse>;

const MAX_BODY_BYTES = 1024 * 1024;

const firstHeader = (value: IncomingHttpHeaders[string]): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/**
 * node:http(s) で GET を1回送る。Node の fetch は sec-fetch-mode を書き換えるので使わない（冒頭「Node の fetch を使わない GET」）。
 * リダイレクトは辿らない。
 */
export const nodeGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: "GET", headers: { ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(Object.assign(new Error("body too large"), { name: "BodyTooLarge" }));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          contentType: firstHeader(res.headers["content-type"]),
          date: firstHeader(res.headers.date),
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", fail);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
    req.on("error", fail);
    req.end();
  });

/** GET の例外を、値を含まない種別にする。 */
function describeGetError(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return "タイムアウト";
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
}

/** content-type の media type だけ。読めないものは出さない。 */
function mediaType(contentType: string | null): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "不明";
}

/** ページの応答が SPAシェルか。Worker が受けていれば JSON（host の Worker は /healthz 以外に JSON の 404 を返す）になる。 */
export function checkPage(res: HttpResponse): string | undefined {
  if (res.status !== 200) return `HTTP ${res.status}（SPAシェルなら 200）`;
  const type = mediaType(res.contentType);
  if (type !== "text/html") return `content-type が ${type}（SPAシェルなら text/html。Worker が受けた疑い）`;
  return undefined;
}

/** /healthz の応答が全層 ok か。判定は貫通スモークと同じ（smoke.ts の judge）。 */
export function checkHealthz(res: HttpResponse): string | undefined {
  const verdict = judgeHealthz(
    { kind: "response", status: res.status, contentType: res.contentType, text: res.text },
    { env: TARGET_ENV, sha: undefined },
  );
  return verdict.ok ? undefined : `[${verdict.layers.join(", ")}] ${verdict.reason}`;
}

// ── 窓 ────────────────────────────────────────────────────────────────────────

/** Analytics を読む時間の窓（両端を含む。秒の精度の ISO 8601・UTC）。 */
export interface Window {
  readonly since: string;
  readonly until: string;
}

export interface PhaseRecord {
  readonly window: Window;
  /** 送ったリクエストの数（全部 ok だったもの） */
  readonly sent: number;
}

export interface DriveRecord {
  readonly pages: PhaseRecord;
  readonly healthz: PhaseRecord;
}

const toSecond = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** 観測した時刻の範囲から窓を作る。前後に WINDOW_PAD を足し、秒に丸める。 */
export function windowOf(firstMs: number, lastMs: number): Window {
  return {
    since: toSecond(Math.floor((firstMs - WINDOW_PAD_MS) / 1000) * 1000),
    until: toSecond(Math.ceil((lastMs + WINDOW_PAD_MS) / 1000) * 1000),
  };
}

/** `<since>/<until>` を読む。 */
export function parseWindow(raw: string, option: string): Window {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(raw);
  const since = match?.[1];
  const until = match?.[2];
  if (since === undefined || until === undefined || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    throw new MeasureError(`${option} は <since>/<until>（例 2026-09-14T09:00:00Z/2026-09-14T09:00:30Z）で書く`);
  }
  if (Date.parse(since) >= Date.parse(until)) throw new MeasureError(`${option} の since が until より後ろ`);
  return { since, until };
}

/** ページの窓が healthz の窓より前にあり、重ならないか。 */
function assertSeparated(record: DriveRecord): void {
  if (Date.parse(record.pages.window.until) >= Date.parse(record.healthz.window.since)) {
    throw new MeasureError("ページの窓と /healthz の窓が重なる。どちらのリクエストか区別できないので読まない");
  }
}

export const formatWindows = (record: DriveRecord, plan: Plan): string =>
  `--pages-window ${record.pages.window.since}/${record.pages.window.until} ` +
  `--healthz-window ${record.healthz.window.since}/${record.healthz.window.until} ` +
  `--pages ${plan.pages} --healthz ${plan.healthz}`;

// ── Analytics（GraphQL）────────────────────────────────────────────────────────

/**
 * 2つの窓を1回で読む。データセットと欄は一次情報とスキーマで確かめた（06 §7.1 の出典）。
 *   workersInvocationsAdaptive          … Worker（scriptName）ごとの起動の回数・cpuTime の和・max・分位
 *   workersAssetsRequestsAdaptiveGroups … Static Assets が返したリクエスト
 * scriptName_in に __unknown__ も入れる：名前がまだ入っていない起動を数え落とさない（冒頭「Worker 名が __unknown__ で返るとき」）。
 * workersAssetsRequestsAdaptiveGroups は statusCode を選ぶ。2026-09-14 の実測で、dimensions を選ばずに hostname で絞った集計は
 * 送ってから約 9 分空のままだった（statusCode を選ぶと、2回目の実測では約 1.5 分で読めた）。hostname は選ばない（応答にサブドメインを載せない）。
 */
const INVOCATION_FIELDS = `
        sum { requests errors cpuTimeUs }
        avg { sampleInterval }
        max { cpuTime }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }`;

export const ANALYTICS_QUERY = `query MeasureFreeTier($accountTag: string!, $scripts: [string!]!, $hostname: string!, $pagesSince: Time!, $pagesUntil: Time!, $healthzSince: Time!, $healthzUntil: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      pagesInvocations: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $pagesSince, datetime_leq: $pagesUntil, scriptName_in: $scripts }) {${INVOCATION_FIELDS}
      }
      pagesAssets: workersAssetsRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $pagesSince, datetime_leq: $pagesUntil, hostname: $hostname }) {
        sum { requests }
        dimensions { statusCode }
      }
      healthzInvocations: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $healthzSince, datetime_leq: $healthzUntil, scriptName_in: $scripts }) {${INVOCATION_FIELDS}
      }
    }
  }
}`;

export function analyticsVariables(accountId: string, hostname: string, record: DriveRecord): Record<string, unknown> {
  return {
    accountTag: accountId,
    scripts: [...WORKERS.map((worker) => scriptName(worker)), UNKNOWN_SCRIPT],
    hostname,
    pagesSince: record.pages.window.since,
    pagesUntil: record.pages.window.until,
    healthzSince: record.healthz.window.since,
    healthzUntil: record.healthz.window.until,
  };
}

/** workersInvocationsAdaptive の1行（scriptName ごと）。時間はマイクロ秒。 */
export interface InvocationRow {
  readonly scriptName: string;
  /** sum.requests。サンプリングされていれば重みを掛けた推定値 */
  readonly requests: number;
  readonly errors: number;
  readonly cpuTimeUs: number;
  readonly cpuMaxUs: number;
  readonly cpuP50Us: number;
  readonly cpuP99Us: number;
  readonly sampleInterval: number;
}

export interface Snapshot {
  readonly pages: { readonly invocations: readonly InvocationRow[]; readonly assets: number };
  readonly healthz: { readonly invocations: readonly InvocationRow[] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `sum.requests` のような経路で数を読む。 */
function readNumber(node: Record<string, unknown>, path: string): number {
  let value: unknown = node;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MeasureError(`Analytics の応答の形が違う: ${path} が数でない`);
  }
  return value;
}

function readRows(value: unknown, dataset: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new MeasureError(`Analytics の応答の形が違う: ${dataset} が行の配列でない`);
  }
  return value;
}

function readInvocations(value: unknown): InvocationRow[] {
  return readRows(value, "workersInvocationsAdaptive").map((node) => {
    const dimensions = node.dimensions;
    const name = isRecord(dimensions) ? dimensions.scriptName : undefined;
    if (typeof name !== "string") {
      throw new MeasureError("Analytics の応答の形が違う: workersInvocationsAdaptive の dimensions.scriptName が文字列でない");
    }
    return {
      scriptName: name,
      requests: readNumber(node, "sum.requests"),
      errors: readNumber(node, "sum.errors"),
      cpuTimeUs: readNumber(node, "sum.cpuTimeUs"),
      cpuMaxUs: readNumber(node, "max.cpuTime"),
      cpuP50Us: readNumber(node, "quantiles.cpuTimeP50"),
      cpuP99Us: readNumber(node, "quantiles.cpuTimeP99"),
      sampleInterval: readNumber(node, "avg.sampleInterval"),
    };
  });
}

/** GraphQL の認可エラーらしい文言か。 */
const AUTHZ_ERROR = /not authori[sz]ed|unauthori[sz]ed|authentication|permission|access denied|forbidden/i;

/** 権限が足りないときの失敗。トークンを作らずに止める（Issue #25）。 */
const permissionError = (what: string): MeasureError =>
  new MeasureError(
    `${what}の権限が足りない。トークンを作らずに止める（CI 用トークンの権限を人が確かめる。Analytics は Account Analytics: Read）`,
  );

/** GraphQL の応答を読む。errors があれば、伏せた文言で落とす。 */
export function parseAnalytics(body: unknown, secrets: readonly string[]): Snapshot {
  if (!isRecord(body)) throw new MeasureError("Analytics の応答が JSON オブジェクトでない");
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : ""));
    if (messages.some((m) => AUTHZ_ERROR.test(m))) throw permissionError("Analytics（GraphQL）を読む");
    throw new MeasureError(`Analytics がエラーを返した: ${messages.map((m) => sanitize(m, secrets)).join(", ")}`);
  }
  const data = body.data;
  const viewer = isRecord(data) ? data.viewer : undefined;
  const accounts = isRecord(viewer) ? viewer.accounts : undefined;
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isRecord(account)) {
    throw new MeasureError("Analytics の応答にアカウントが無い（CLOUDFLARE_ACCOUNT_ID とトークンの対象アカウントを確かめる）");
  }
  return {
    pages: {
      invocations: readInvocations(account.pagesInvocations),
      assets: readRows(account.pagesAssets, "workersAssetsRequestsAdaptiveGroups").reduce(
        (total, row) => total + readNumber(row, "sum.requests"),
        0,
      ),
    },
    healthz: { invocations: readInvocations(account.healthzInvocations) },
  };
}

/**
 * 送った回数と、Analytics の回数が「同じくらい」か。Adaptive のデータセットは少ない数でも揺れる
 * （2026-09-14 実測：20 回が、サンプリングの重みで 27 回・26 回、取りこぼしで 17 回、assets は 11 回と出た）。
 * 問いは「0 か、送った数くらいか」なので、半分から倍までを同じくらいとみなす。
 */
export const aboutSent = (value: number, sent: number): boolean => value >= sent / 2 && value <= sent * 2;

const totalRequests = (rows: readonly InvocationRow[]): number => rows.reduce((total, row) => total + row.requests, 0);

/** 送った分が Analytics に出揃ったように見えるか（/healthz の窓の起動・ページの窓の assets が、送った数の半分以上）。 */
export const reflected = (snapshot: Snapshot, record: DriveRecord): boolean =>
  totalRequests(snapshot.healthz.invocations) >= record.healthz.sent / 2 && snapshot.pages.assets >= record.pages.sent / 2;

const rowsKey = (rows: readonly InvocationRow[]): string =>
  rows
    .map((row) => JSON.stringify(row))
    .toSorted()
    .join("\n");

/** 2回の読み取りが同じ値か。 */
export const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
  a.pages.assets === b.pages.assets &&
  rowsKey(a.pages.invocations) === rowsKey(b.pages.invocations) &&
  rowsKey(a.healthz.invocations) === rowsKey(b.healthz.invocations);

export interface WorkerCounts {
  /** Worker ごとの起動の回数。起動が無ければ 0 */
  readonly counts: Readonly<Record<Worker, number>>;
  /** 名前が __unknown__ の起動の回数 */
  readonly unknown: number;
}

export function countsOf(rows: readonly InvocationRow[]): WorkerCounts {
  const counts = Object.fromEntries(
    WORKERS.map((worker) => [worker, totalRequests(rows.filter((row) => row.scriptName === scriptName(worker)))]),
  ) as Record<Worker, number>;
  return { counts, unknown: totalRequests(rows.filter((row) => row.scriptName === UNKNOWN_SCRIPT)) };
}

const unknownReason = (unknown: number): string =>
  `名前が ${UNKNOWN_SCRIPT} の起動が ${unknown} 回あり、Worker に割り当てられない` +
  "（Worker を作ってから約 1.5 時間は名前が入らなかった。06 §7.1。時間を空けて読み直す）";

// ── 判定 ──────────────────────────────────────────────────────────────────────

/** 要確認 4：Static Assets へのリクエストは Worker を起動するか。 */
export interface AssetsFinding extends WorkerCounts {
  readonly outcome: "not-invoked" | "invoked" | "undetermined";
  readonly sent: number;
  readonly assets: number;
  readonly reason: string;
}

export function judgeAssets(pages: Snapshot["pages"], sent: number): AssetsFinding {
  const base = { ...countsOf(pages.invocations), sent, assets: pages.assets };
  const invoked = WORKERS.reduce((total, worker) => total + base.counts[worker], 0);
  if (invoked > 0) {
    return { ...base, outcome: "invoked", reason: `ページの GET で Worker が ${invoked} 回起動した（100k/日 を消費する）` };
  }
  if (base.unknown > 0) return { ...base, outcome: "undetermined", reason: unknownReason(base.unknown) };
  if (!aboutSent(pages.assets, sent)) {
    return {
      ...base,
      outcome: "undetermined",
      reason: `assets の requests（${pages.assets} 回）が送った数（${sent} 回）と合わない（反映待ちか、窓がずれたか、他のリクエストが混ざった）`,
    };
  }
  return { ...base, outcome: "not-invoked", reason: "Worker を起動しない（100k/日 を消費しない）" };
}

/** 要確認 2：Service Binding の呼び出しは、別の requests として数えられるか。 */
export interface ServiceBindingFinding extends WorkerCounts {
  readonly outcome: "separate" | "not-separate" | "undetermined";
  readonly sent: number;
  readonly sampled: boolean;
  readonly reason: string;
}

export function judgeServiceBinding(invocations: readonly InvocationRow[], sent: number): ServiceBindingFinding {
  const { counts, unknown } = countsOf(invocations);
  const base = { counts, unknown, sent, sampled: invocations.some((row) => row.sampleInterval !== 1) };
  if (unknown > 0) return { ...base, outcome: "undetermined", reason: unknownReason(unknown) };
  if (!aboutSent(counts.host, sent)) {
    return {
      ...base,
      outcome: "undetermined",
      reason: `host の起動（${counts.host} 回）が送った数（${sent} 回）と合わない（他のリクエストが混ざったか、反映が足りない）`,
    };
  }
  if (aboutSent(counts.gateway, sent) && aboutSent(counts["data-api"], sent)) {
    return { ...base, outcome: "separate", reason: `別に数える（host への 1 回が ${WORKERS.length} requests になる）` };
  }
  if (counts.gateway === 0 && counts["data-api"] === 0) {
    return { ...base, outcome: "not-separate", reason: "別に数えない（host への 1 回が 1 request のまま）" };
  }
  return { ...base, outcome: "undetermined", reason: "gateway・data-api の起動が送った数と合わず、0 でもない" };
}

export interface WorkerCpu {
  readonly worker: Worker;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  /** サンプリングされた（回数・和は推定値、max・分位は取りこぼし得る） */
  readonly sampled: boolean;
}

/** CPU 時間：Free の上限に対する余裕（要確認 1 を含む）。 */
export type CpuFinding =
  | { readonly outcome: "undetermined"; readonly reason: string }
  | {
      /** within: 合算しても上限内。over-if-summed: 単体では上限内だが合算すると超え得る。over: 単体で超えた */
      readonly outcome: "within" | "over-if-summed" | "over";
      readonly limitMs: number;
      /** 経路の順 */
      readonly workers: readonly WorkerCpu[];
      /** 3つの max の和。同じリクエストで3つとも max だった場合の上界 */
      readonly chainMaxMs: number;
      /** 3つの平均（cpuTimeUs ÷ requests）の和 */
      readonly chainMeanMs: number;
      readonly marginMs: number;
      readonly errors: number;
      /** host の cpuTime が下流の分を含まないと言えるか（host の平均 < gateway と data-api の平均の和） */
      readonly downstreamExcluded: boolean;
      readonly reason: string;
    };

const toMs = (us: number): number => us / 1000;

export function judgeCpu(invocations: readonly InvocationRow[], sent: number, limitMs: number): CpuFinding {
  const { unknown } = countsOf(invocations);
  if (unknown > 0) return { outcome: "undetermined", reason: unknownReason(unknown) };
  const workers: WorkerCpu[] = [];
  let errors = 0;
  for (const worker of WORKERS) {
    const rows = invocations.filter((row) => row.scriptName === scriptName(worker));
    const [row] = rows;
    if (rows.length !== 1 || row === undefined || !aboutSent(row.requests, sent)) {
      return {
        outcome: "undetermined",
        reason: `${worker} の起動（${totalRequests(rows)} 回・${rows.length} 行）が送った数（${sent} 回）と合わない`,
      };
    }
    errors += row.errors;
    workers.push({
      worker,
      p50Ms: toMs(row.cpuP50Us),
      p99Ms: toMs(row.cpuP99Us),
      maxMs: toMs(row.cpuMaxUs),
      // requests と cpuTimeUs は同じ重みの推定値なので、サンプリングされていても割ってよい
      meanMs: toMs(row.cpuTimeUs / row.requests),
      sampled: row.sampleInterval !== 1,
    });
  }
  const [host, gateway, dataApi] = workers;
  if (host === undefined || gateway === undefined || dataApi === undefined) {
    return { outcome: "undetermined", reason: "Worker が3つ揃わない" };
  }
  const chainMaxMs = workers.reduce((total, w) => total + w.maxMs, 0);
  const base = {
    limitMs,
    workers,
    chainMaxMs,
    chainMeanMs: workers.reduce((total, w) => total + w.meanMs, 0),
    marginMs: limitMs - chainMaxMs,
    errors,
    downstreamExcluded: host.meanMs < gateway.meanMs + dataApi.meanMs,
  };
  const over = workers.filter((w) => w.maxMs > limitMs);
  if (over.length > 0) {
    return { ...base, outcome: "over", reason: `${over.map((w) => w.worker).join("・")} が単体で上限（${limitMs} ms）を超えた` };
  }
  if (chainMaxMs > limitMs) {
    return {
      ...base,
      outcome: "over-if-summed",
      reason: `単体では上限内だが、チェーンで合算すると上限（${limitMs} ms）を超え得る（06 §4.1 の退路：Workers Paid）`,
    };
  }
  return { ...base, outcome: "within", reason: `合算しても上限（${limitMs} ms）に収まる` };
}

// ── /api の経路の計測（Issue #111。--api）────────────────────────────────────────
//
// 測る条件（経路・規模・温め方・P-7/P-1 の線）は api-measure-fixture.ts が正本である。ここが持つのは
// **送る・待つ・読む**である。時計・sleep・HTTP・Analytics・期間レポートは io から受け取る（unit は fake を渡す）。
//
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --api --instance <計測用の ID> [--env dev|staging]
//
// ── 手順 ──────────────────────────────────────────────────────────────────────
//   1. 宣言（spec の経路）を読み、action の名前を引く（**計測の窓の外**）
//   2. P-1：過去 7 日の上限超過を、既存の期間レポート（free-tier-report.ts）を **別に読んで**判定する
//      （20 回の窓で 0 件という理由だけで非抵触にしない）
//   3. 規模ごとに：前の残りを片付ける → 準備する（**計測の窓の外**）→ 経路ごとに **5 回温め → 60 秒空けて →
//      20 回測る** → 片付ける（支出 → メンバーの順。#109 の delete）
//   4. 本測定の窓だけを Analytics から読み（2 回続けて同じ値になり、送った分が出揃うまで待つ）、P-7 を判定する
//
// 既定の宛先は staging（#111 と同じ）。`--env dev` は、`limits.cpu_ms` を自分で設定して Free の壁を
// アカウント①の中で再現するときに使う（Issue #152）。回数の上限は `--max-requests` で明示的に広げられる
// （既定 50。経路を合算して緩めるのとは別）。
//
// ── 見本（--sample。Issue #216）─────────────────────────────────────────────────
//   warikan   … 既定。支出の見本（#111 の実測と同じ。規模は支出 2・20・200 件）
//   dashboard … サークルの活動の見本（packages/appspec-schema/samples/dashboard）。規模は**活動** 2・20・200 件。
//               メンバー 4 人 → 活動 N 件（日付は日本時間の今月と先月に散らす）を準備し、
//               dashboard（アプリ全体の集計・見出しごとの集計・順位）・activities・members の一覧を測る。
//               片付けは**活動 → メンバー**の順（参照されているメンバーは消せない）
//
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --api --sample dashboard --instance <計測用の ID> --sizes 200
//
// 回数の上限（MAX_REQUESTS・`--max-requests`）は **1 窓で送る GET（温め + 本測定）** の上限であって、準備の POST は
// 数えない。準備と片付けは計測の窓の外で、Analytics の判定にも入らない——warikan の 200 件（支出 200 件の POST）と
// 同じ扱いである。dashboard の 200 件も、準備の POST は メンバー 4 + 活動 200、片付けは同じ数の delete になる。
//
// ── 終了コード ────────────────────────────────────────────────────────────────
//   0 … すべて判定できて、P-7・P-1 のどちらにも触れていない
//   1 … 引数・資格情報・HTTP・API の失敗（**応答が失敗したらその場で止める**。片付けは必ず行う）
//   2 … 判定できない（Analytics 不足・名前不明・反映待ち切れ・混入・読取権限不足）
//   3 … P-7 か P-1 に触れた（**管理を通じて窓口へ返す**。Workers Paid への変更は人が行う）

/** 計測用インスタンスの ID の形（publish の検査と同じ）。値はエラーに出さない */
const API_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** デモ・窓口のインスタンスを触らないための目印（専用の計測インスタンスの ID に demo を含めない） */
const API_DEMO_INSTANCE = /demo/i;

export const API_FLAG = "--api";

/**
 * `--api` を向けてよい env。production は別アカウントで `/api/*` が 404 なので測らない（README §7.3・Q5）。
 * 既定は staging（#111 の実測と同じ）。dev は、上限を自分で設定して Free の壁を再現するときに使う（Issue #152）。
 */
export const API_ENVS: readonly Env[] = ["dev", "staging"];

/** `--api` の待ち方。既定は「5 回温め → 60 秒空けて → 20 回測る」（Q15・06 §8 の再測と同じ）。 */
export interface ApiMeasurePolicy {
  /** 本測定の前に送る回数（温め） */
  readonly warmup: number;
  /** 1 経路・1 規模ごとに測る回数 */
  readonly measured: number;
  /** 温めと本測定の間。**窓を分ける**ために空ける */
  readonly gapMs: number;
  readonly firstReadDelayMs: number;
  readonly pollIntervalMs: number;
  readonly maxWaitMs: number;
  readonly requestTimeoutMs: number;
}

export const API_MEASURE_POLICY: ApiMeasurePolicy = {
  warmup: API_WARMUP_REQUESTS,
  measured: API_MEASURED_REQUESTS,
  gapMs: API_GAP_MS,
  firstReadDelayMs: 60_000,
  pollIntervalMs: 30_000,
  maxWaitMs: 15 * 60_000,
  requestTimeoutMs: 10_000,
};

/** 過去 7 日の上限超過を読む口（P-1）。既定は free-tier-report.ts を動的に読む（値は出力に出さない）。 */
export type ExceededReader = (
  io: ApiMeasureIo,
  credentials: Credentials,
  secrets: readonly string[],
) => Promise<ExceededReading | undefined>;

/** `--api` が使う口。時計・sleep・HTTP・Analytics・期間レポートを差し替えられる。 */
export interface ApiMeasureIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Cloudflare の API（サブドメイン・GraphQL）と staging の専用インスタンス（/api/*）を呼ぶ */
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly policy: ApiMeasurePolicy;
  /** P-1。読めなければ undefined を返す（例外でもよい。呼ぶ側が判断不能にする） */
  readonly readExceeded: ExceededReader;
}

/** 本測定の窓のあとに空ける時間。**片付けと次の温めを窓の外へ出す**（窓の前後の余白より長く）。 */
export const API_OUTSIDE_WINDOW_MS = WINDOW_PAD_MS + 1_000;

/** 測る経路（見本ごと）。warikan は api-measure-fixture の API_ROUTES をそのまま使う */
export interface MeasureRoute {
  readonly id: string;
  readonly label: string;
  /** 一覧の名前。spec の経路は持たない（パスが違う） */
  readonly viewName?: string;
}

/** 規模（見本ごと）。id は `--sizes` で選ぶ名前で、どの見本も basic・20・200 */
export interface MeasureSize {
  readonly id: ApiSizeId;
  readonly label: string;
}

/** 経路のパス。**契約の正本（appspec-schema の api.ts）から組む**——ここで書き直さない */
const measureRoutePath = (instanceId: string, route: MeasureRoute): string =>
  route.viewName === undefined ? apiSpecPath(instanceId) : apiViewPath(instanceId, route.viewName);

interface MeasureWindow {
  readonly size: MeasureSize;
  readonly route: MeasureRoute;
  /** 温めの窓。**記録用**（判定には使わない） */
  readonly warm: Window;
  /** 本測定の窓。判定に使う */
  readonly measured: Window;
  readonly sent: number;
}

interface WindowReading {
  readonly window: MeasureWindow;
  readonly rows: readonly InvocationRow[];
  /** 読めなかった理由（全窓共通）。読めていれば undefined */
  readonly error: string | undefined;
  /** 反映済み（回数が送った数くらい）で、2 回続けて同じ値になった */
  readonly settled: boolean;
}

interface WindowFinding {
  readonly window: MeasureWindow;
  readonly verdict: Verdict;
  readonly p7: P7Finding | undefined;
  readonly requests: Verdicts;
  readonly errors: number;
  readonly sampled: boolean;
  readonly reason: string;
}

const API_INVOCATION_FIELDS = `
        sum { requests errors cpuTimeUs }
        avg { sampleInterval }
        max { cpuTime }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }`;

/** 本測定の窓を、1 回の GraphQL でまとめて読む（窓ごとに別名を付ける）。 */
export function apiAnalyticsQuery(windows: readonly Window[]): string {
  const aliases = windows
    .map(
      (window, index) =>
        `      w${index}: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: "${window.since}", datetime_leq: "${window.until}", scriptName_in: $scripts }) {${API_INVOCATION_FIELDS}
      }`,
    )
    .join("\n");
  return `query ApiMeasure($accountTag: string!, $scripts: [string!]!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
${aliases}
    }
  }
}`;
}

/** GraphQL の応答を、窓ごとの行に分ける。 */
export function parseApiAnalytics(
  body: unknown,
  count: number,
  secrets: readonly string[],
): readonly (readonly InvocationRow[])[] {
  if (!isRecord(body)) throw new MeasureError("Analytics の応答が JSON オブジェクトでない");
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : ""));
    if (messages.some((m) => AUTHZ_ERROR.test(m))) throw permissionError("Analytics（GraphQL）を読む");
    throw new MeasureError(`Analytics がエラーを返した: ${messages.map((m) => sanitize(m, secrets)).join(", ")}`);
  }
  const data = body.data;
  const viewer = isRecord(data) ? data.viewer : undefined;
  const accounts = isRecord(viewer) ? viewer.accounts : undefined;
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isRecord(account)) {
    throw new MeasureError("Analytics の応答にアカウントが無い（CLOUDFLARE_ACCOUNT_ID とトークンの対象アカウントを確かめる）");
  }
  return Array.from({ length: count }, (_, index) => readInvocations(account[`w${index}`]));
}

const workerRows = (
  rows: readonly InvocationRow[],
  worker: ApiWorker,
  env: Env = TARGET_ENV,
): readonly InvocationRow[] => rows.filter((row) => row.scriptName === scriptName(worker, env));

const requestsOf = (rows: readonly InvocationRow[], worker: ApiWorker, env: Env = TARGET_ENV): number =>
  totalRequests(workerRows(rows, worker, env));

const requestsByWorker = (rows: readonly InvocationRow[], env: Env = TARGET_ENV): Verdicts => ({
  host: requestsOf(rows, "host", env),
  gateway: requestsOf(rows, "gateway", env),
  "data-api": requestsOf(rows, "data-api", env),
});

interface ApiResponse {
  readonly status: number;
  /** Date ヘッダ（Cloudflare の時計）。読めなければ undefined */
  readonly dateMs: number | undefined;
  readonly body: Record<string, unknown>;
}

/** 応答の本文から誤りコードだけを読む（**その他の値は出さない**）。 */
function apiErrorCode(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const code = isRecord(parsed) ? parsed["error"] : undefined;
    return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** `/api/*` へ GET を1回送る。**失敗したらその場で止める**（例外にする）。 */
async function apiFetch(
  io: ApiMeasureIo,
  url: URL,
  label: string,
  instanceId?: string,
): Promise<ApiResponse> {
  let res: Response;
  try {
    res = await io.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(io.policy.requestTimeoutMs),
    });
  } catch (e) {
    throw new MeasureError(`${label}が届かない（${describeGetError(e)}）。ここで止める`);
  }
  const dateHeader = res.headers.get("date");
  const served = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
  const text = await res.text();
  if (!res.ok) {
    const code = apiErrorCode(text);
    throw new MeasureError(`${label}が HTTP ${res.status}${code === undefined ? "" : `（${code}）`}。API の失敗なのでここで止める`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MeasureError(`${label}の応答が JSON でない（画面や data-api の層が崩れている疑い）。ここで止める`);
  }
  if (!isRecord(body)) throw new MeasureError(`${label}の応答がオブジェクトでない。ここで止める`);
  if (instanceId !== undefined && body["instanceId"] !== instanceId) {
    throw new MeasureError(`${label}の応答の instanceId が違う（別のインスタンスへ届いている疑い）。ここで止める`);
  }
  return { status: res.status, dateMs: Number.isNaN(served) ? undefined : served, body };
}

/** `/api/*` へ POST（操作）を1回送る。**失敗したらその場で止める**。 */
async function apiPost(
  io: ApiMeasureIo,
  url: URL,
  input: Readonly<Record<string, unknown>>,
  label: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await io.fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(io.policy.requestTimeoutMs),
    });
  } catch (e) {
    throw new MeasureError(`${label}が届かない（${describeGetError(e)}）。ここで止める`);
  }
  const text = await res.text();
  if (!res.ok) {
    const code = apiErrorCode(text);
    throw new MeasureError(`${label}が HTTP ${res.status}${code === undefined ? "" : `（${code}）`}。ここで止める`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MeasureError(`${label}の応答が JSON でない。ここで止める`);
  }
  if (!isRecord(body)) throw new MeasureError(`${label}の応答がオブジェクトでない。ここで止める`);
  return body;
}

/** entity ごとの、準備（create）と片付け（delete）の action の名前 */
interface EntityActions {
  readonly create: string;
  readonly delete: string;
}

/**
 * 宣言（spec 応答）から、準備と片付けに要る action の名前を引く（宣言が変われば追随する）。
 * entity と kind で引く——名前を決め打ちしない。
 */
function apiActionNames<E extends string>(
  spec: Record<string, unknown>,
  entities: readonly E[],
): Readonly<Record<E, EntityActions>> {
  const actions = Array.isArray(spec["actions"]) ? spec["actions"].filter(isRecord) : [];
  const pick = (entity: string, kind: "create" | "delete"): string | undefined => {
    const found = actions.find(
      (action) => action["entity"] === entity && (typeof action["kind"] === "string" ? action["kind"] : "create") === kind,
    );
    const name = found?.["name"];
    return typeof name === "string" ? name : undefined;
  };
  const picked: Partial<Record<E, EntityActions>> = {};
  for (const entity of entities) {
    const create = pick(entity, "create");
    const remove = pick(entity, "delete");
    if (create === undefined || remove === undefined) {
      throw new MeasureError(`宣言に、準備と片付けに要る action が無い（${entities.join("・")} の create と delete）`);
    }
    picked[entity] = { create, delete: remove };
  }
  return picked as Record<E, EntityActions>;
}

/** 一覧の行を読む（準備の片付けに使う）。 */
async function apiViewRows(
  io: ApiMeasureIo,
  origin: string,
  instanceId: string,
  route: MeasureRoute,
  label: string,
): Promise<readonly Record<string, unknown>[]> {
  const res = await apiFetch(io, new URL(measureRoutePath(instanceId, route), origin), label, instanceId);
  const rows = res.body["rows"];
  if (!Array.isArray(rows) || !rows.every(isRecord)) {
    throw new MeasureError(`一覧 ${route.id} の応答の形が違う（rows が行の配列でない）。ここで止める`);
  }
  return rows;
}

const rowId = (row: Record<string, unknown>, label: string): string => {
  const id = row["id"];
  if (typeof id !== "string" || id === "") throw new MeasureError(`${label} の行に id が無い。ここで止める`);
  return id;
};

/** 片付けの 1 段。一覧の行を読み、その行を action で消す */
interface CleanUpStep {
  readonly route: MeasureRoute;
  readonly action: string;
}

/** 宣言を読んだあとの、見本ごとの準備と片付け */
interface SampleSetup {
  /** 規模のデータを作る（**計測の窓の外**）。出力に出す内訳（件数だけ）を返す */
  readonly prepare: (io: ApiMeasureIo, origin: string, instanceId: string, size: MeasureSize) => Promise<string>;
  /** 片付けの順。**参照する側 → される側**（逆にすると、参照されている行は消せず 409 で残る） */
  readonly cleanUp: readonly CleanUpStep[];
  /** 出力に出す片付けの順（例「支出 → メンバー」） */
  readonly cleanUpOrder: string;
}

export const API_SAMPLES = ["warikan", "dashboard"] as const;
export type ApiSampleId = (typeof API_SAMPLES)[number];
/** 既定の見本（#111 の実測と同じ） */
export const DEFAULT_API_SAMPLE: ApiSampleId = "warikan";

/** 測る見本（`--sample`。Issue #216） */
interface ApiSample {
  readonly id: ApiSampleId;
  readonly routes: readonly MeasureRoute[];
  readonly sizes: readonly MeasureSize[];
  /** 宣言（spec 応答）から action の名前などを引き、準備と片付けを組む。足りなければ MeasureError */
  readonly setup: (spec: Record<string, unknown>) => SampleSetup;
}

/** 準備の create を 1 回送り、作った行の id を返す */
async function apiCreate(
  io: ApiMeasureIo,
  origin: string,
  instanceId: string,
  action: string,
  input: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created = await apiPost(io, new URL(actionPath(instanceId, action), origin), input, `操作 ${action}`);
  return rowId(created, `操作 ${action}`);
}

// ── 見本 warikan（#111）────────────────────────────────────────────────────────

const WARIKAN_SAMPLE: ApiSample = {
  id: "warikan",
  routes: API_ROUTES,
  sizes: API_SIZES,
  setup: (spec) => {
    const actions = apiActionNames(spec, ["member", "expense"] as const);
    return {
      // 規模のデータを作る。メンバー → 支出の順
      prepare: async (io, origin, instanceId, size) => {
        const memberIds: string[] = [];
        for (const name of API_MEMBER_NAMES) {
          memberIds.push(await apiCreate(io, origin, instanceId, actions.member.create, { name }));
        }
        const plans = expensePlans(sizeById(size.id));
        for (const plan of plans) {
          const payer = memberIds[plan.payerIndex];
          const participants = plan.participantIndexes.map((index) => memberIds[index]);
          if (payer === undefined || participants.some((id) => id === undefined)) {
            throw new MeasureError(`${size.id} の支出（${plan.description}）の参照先が決まらない。ここで止める`);
          }
          await apiCreate(io, origin, instanceId, actions.expense.create, {
            description: plan.description,
            amount: plan.amount,
            payer,
            participants,
          });
        }
        return `メンバー ${memberIds.length}・支出 ${plans.length}`;
      },
      cleanUp: [
        { route: routeById("expenseList"), action: actions.expense.delete },
        { route: routeById("memberList"), action: actions.member.delete },
      ],
      cleanUpOrder: "支出 → メンバー",
    };
  },
};

// ── 見本 dashboard（Issue #216。samples/dashboard/app.spec.yaml）──────────────────
//
// D-1（staging の /api で Worker 単体の CPU 最大 200 ms 超・**200 件**で測る。06 §5）を、アプリ全体の集計・
// 見出しごとの集計・順位を持つ見本で測る。200 件は **活動（activity）の件数**である。
// 活動の日付は**日本時間の今月と先月に半分ずつ**散らす——`within: this_month` の絞り込みと、月ごとの集計
// （`groupBy: month`）の両方に行が当たるようにするためである。項目の名前は見本の写し（warikan の
// description・amount と同じ扱い）で、`kind` の値だけは宣言の `options` から読む（選択肢が変われば追随する）。

/** 測る経路。宣言の名前は見本 app.spec.yaml の写し */
export const DASHBOARD_ROUTES: readonly MeasureRoute[] = [
  { id: "spec", label: "宣言の読み込み" },
  { id: "dashboard", label: "ダッシュボード（アプリ全体の集計・見出しごとの集計・順位）", viewName: "dashboard" },
  { id: "activities", label: "活動の一覧", viewName: "activities" },
  { id: "members", label: "メンバーの一覧", viewName: "members" },
];

export interface DashboardSize extends MeasureSize {
  /** 活動の件数 */
  readonly activities: number;
}

/** 規模は3段階。**活動**を 2・20・200 件（200 件が D-1 の線） */
export const DASHBOARD_SIZES: readonly DashboardSize[] = [
  { id: "basic", label: "基本（活動 2 件）", activities: 2 },
  { id: "20", label: "20 件（活動 20 件）", activities: 20 },
  { id: "200", label: "200 件（活動 200 件）", activities: 200 },
];

/** メンバー（**規模によらず 4 人**）。参加した人（attendees）が 1〜4 人になるように */
export const DASHBOARD_MEMBER_NAMES = ["A", "B", "C", "D"] as const;

/** 1 件の活動の入力。attendees は `DASHBOARD_MEMBER_NAMES` の添字で持つ */
export interface ActivityPlan {
  readonly kind: string;
  /** `YYYY-MM-DD`（日本時間の今月か先月） */
  readonly date: string;
  readonly attendeeIndexes: readonly number[];
  readonly cost: number;
}

const JST_OFFSET_MS = 9 * 60 * 60_000;
const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * 規模の活動の並び。偶数番目を**日本時間の今月**、奇数番目を**先月**にする（日は 1〜28 日を巡る。どの月にもある日）。
 * 種類は `kinds`（宣言の `options` のキー）を順に巡り、参加した人は 1〜4 人、費用は 500 円刻みで巡る。
 */
export function activityPlans(activities: number, kinds: readonly string[], nowMs: number): readonly ActivityPlan[] {
  if (kinds.length === 0) throw new MeasureError("活動の種類（kind の選択肢）が無い");
  const jst = new Date(nowMs + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  const months = [`${year}-${pad2(month + 1)}`, month === 0 ? `${year - 1}-12` : `${year}-${pad2(month)}`] as const;
  const plans: ActivityPlan[] = [];
  for (let index = 0; index < activities; index++) {
    const attendees = 1 + (index % DASHBOARD_MEMBER_NAMES.length);
    plans.push({
      kind: kinds[index % kinds.length] ?? "",
      date: `${months[index % 2]}-${pad2(1 + (Math.floor(index / 2) % 28))}`,
      attendeeIndexes: Array.from({ length: attendees }, (_, at) => at),
      cost: 500 * (1 + (index % 10)),
    });
  }
  return plans;
}

/** 宣言の `entity` の `field` が enum なら、その `options` のキー（宣言の順）を返す。無ければ MeasureError */
function enumOptionsOf(spec: Record<string, unknown>, entity: string, field: string): readonly string[] {
  const declaration = spec["spec"];
  const entities =
    isRecord(declaration) && Array.isArray(declaration["entities"]) ? declaration["entities"].filter(isRecord) : [];
  const fields = entities.find((candidate) => candidate["name"] === entity)?.["fields"];
  const node = isRecord(fields) ? fields[field] : undefined;
  const options = isRecord(node) && node["type"] === "enum" && isRecord(node["options"]) ? Object.keys(node["options"]) : [];
  if (options.length === 0) throw new MeasureError(`宣言に、準備に要る ${entity} の ${field} の選択肢（enum の options）が無い`);
  return options;
}

const dashboardRoute = (id: string): MeasureRoute => {
  const route = DASHBOARD_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new MeasureError(`dashboard の経路 ${id} が無い`);
  return route;
};

const DASHBOARD_SAMPLE: ApiSample = {
  id: "dashboard",
  routes: DASHBOARD_ROUTES,
  sizes: DASHBOARD_SIZES,
  setup: (spec) => {
    const actions = apiActionNames(spec, ["member", "activity"] as const);
    const kinds = enumOptionsOf(spec, "activity", "kind");
    return {
      // 規模のデータを作る。メンバー → 活動の順
      prepare: async (io, origin, instanceId, size) => {
        const found = DASHBOARD_SIZES.find((candidate) => candidate.id === size.id);
        if (found === undefined) throw new MeasureError(`dashboard の規模 ${size.id} が無い`);
        const memberIds: string[] = [];
        for (const name of DASHBOARD_MEMBER_NAMES) {
          memberIds.push(await apiCreate(io, origin, instanceId, actions.member.create, { name }));
        }
        // 日付は準備を始めた時点の日本時間で決める（今月と先月に半分ずつ）
        const plans = activityPlans(found.activities, kinds, io.now());
        for (const plan of plans) {
          const attendees = plan.attendeeIndexes.map((index) => memberIds[index]);
          if (attendees.some((id) => id === undefined)) {
            throw new MeasureError(`${size.id} の活動（${plan.date}）の参照先が決まらない。ここで止める`);
          }
          await apiCreate(io, origin, instanceId, actions.activity.create, {
            kind: plan.kind,
            date: plan.date,
            attendees,
            cost: plan.cost,
          });
        }
        return `メンバー ${memberIds.length}・活動 ${plans.length}`;
      },
      cleanUp: [
        { route: dashboardRoute("activities"), action: actions.activity.delete },
        { route: dashboardRoute("members"), action: actions.member.delete },
      ],
      cleanUpOrder: "活動 → メンバー",
    };
  },
};

const API_SAMPLE_BY_ID: Readonly<Record<ApiSampleId, ApiSample>> = { warikan: WARIKAN_SAMPLE, dashboard: DASHBOARD_SAMPLE };

/**
 * 専用インスタンスのデータを片付ける（**計測の窓の外**。Issue #111「#109 の操作で片付ける」）。
 * **参照する側 → される側**の順に消す（warikan は支出 → メンバー、dashboard は活動 → メンバー）——
 * 逆にすると、参照されているメンバーは消せず（409）、データが残る。
 */
async function apiCleanUp(io: ApiMeasureIo, origin: string, instanceId: string, setup: SampleSetup): Promise<number> {
  let deleted = 0;
  for (const step of setup.cleanUp) {
    const rows = await apiViewRows(io, origin, instanceId, step.route, `一覧 ${step.route.id}`);
    for (const row of rows) {
      await apiPost(
        io,
        new URL(actionPath(instanceId, step.action), origin),
        { id: rowId(row, `一覧 ${step.route.id}`) },
        `操作 ${step.action}`,
      );
      deleted++;
    }
  }
  return deleted;
}

/** 1 つの段（温め／本測定）を順に送る。1 回でも失敗したらその場で止める。 */
async function apiSendPhase(
  io: ApiMeasureIo,
  origin: string,
  instanceId: string,
  route: MeasureRoute,
  count: number,
): Promise<PhaseRecord> {
  const path = measureRoutePath(instanceId, route);
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (let index = 1; index <= count; index++) {
    const startedAt = io.now();
    const res = await apiFetch(io, new URL(path, origin), `${route.id} の ${index} 回目`, instanceId);
    const served = res.dateMs;
    first = Math.min(first, served === undefined ? startedAt : served);
    last = Math.max(last, served === undefined ? io.now() : served);
  }
  return { window: windowOf(first, last), sent: count };
}

/** 温めの窓と本測定の窓が重ならないこと（窓を分ける）。 */
function assertWindowSeparated(window: MeasureWindow, gapMs: number): void {
  if (Date.parse(window.warm.until) >= Date.parse(window.measured.since)) {
    throw new MeasureError(
      `${window.size.id} / ${window.route.id}: 温めの窓と本測定の窓が重なる（${gapMs} ms 空けているのに重なった）。判定できないので止める`,
    );
  }
}

/** 本測定の窓どうしが重ならないこと（混ざった窓で判定しない）。 */
function assertNoOverlap(existing: readonly MeasureWindow[], candidate: MeasureWindow): void {
  for (const window of existing) {
    const [a, b] =
      Date.parse(window.measured.since) <= Date.parse(candidate.measured.since)
        ? [window.measured, candidate.measured]
        : [candidate.measured, window.measured];
    if (Date.parse(a.until) >= Date.parse(b.since)) {
      throw new MeasureError(
        `${window.size.id} / ${window.route.id} と ${candidate.size.id} / ${candidate.route.id} の本測定の窓が重なる。混ざった窓で判定しない`,
      );
    }
  }
}

/** 窓の起動が、送った数くらい出揃っているか（Worker ごと）。 */
const apiReflected = (rows: readonly InvocationRow[], sent: number, env: Env = TARGET_ENV): boolean =>
  API_WORKERS.every((worker) => requestsOf(rows, worker, env) >= sent / 2);

/**
 * 窓の値を比べるための正規の鍵。**行の並びは Analytics が保証しない**ので、並べ替えてから比べる
 * （並びだけで「変わった」と見なすと、いつまでも落ち着かない）。
 */
const apiWindowKey = (rows: readonly InvocationRow[]): string =>
  rows.map((row) => JSON.stringify(row)).toSorted().join("\n");

/**
 * 本測定の窓を読む。**窓ごとに**「回数が送った数くらい（反映済み）」で「2 回続けて同じ値」に
 * なったら、その窓は判定できる。**1 つの窓が落ち着かないだけで、ほかの窓を判断不能にしない。**
 * 上限まで待って落ち着かなかった窓は、判断不能のまま返す（非抵触とも 0 とも報告しない）。
 */
async function apiReadWindows(
  io: ApiMeasureIo,
  credentials: Credentials,
  secrets: readonly string[],
  windows: readonly MeasureWindow[],
  env: Env,
): Promise<readonly WindowReading[]> {
  if (windows.length === 0) return [];
  io.out(
    `api-measure: ${io.policy.firstReadDelayMs / 1000} 秒待ってから Analytics を読む` +
      `（${io.policy.pollIntervalMs / 1000} 秒ごと・最大 ${io.policy.maxWaitMs / 60_000} 分）`,
  );
  await io.sleep(io.policy.firstReadDelayMs);
  const query = apiAnalyticsQuery(windows.map((window) => window.measured));
  const startedAt = io.now();
  const previous: (string | undefined)[] = windows.map(() => undefined);
  const settled: boolean[] = windows.map(() => false);
  let last: readonly (readonly InvocationRow[])[] = windows.map(() => []);
  for (let attempt = 1; ; attempt++) {
    let body: unknown;
    try {
      body = await callApi(io, credentials, "/graphql", {
        method: "POST",
        body: JSON.stringify({
          query,
          variables: { accountTag: credentials.accountId, scripts: [...API_WORKERS.map((worker) => scriptName(worker, env)), UNKNOWN_SCRIPT] },
        }),
      });
    } catch (e) {
      const reason = e instanceof MeasureError ? e.message : `Analytics を読めない（${e instanceof Error ? e.name : typeof e}）`;
      io.out(`api-measure: Analytics を読めなかった（${reason}）。判断不能にする`);
      return windows.map((window) => ({ window, rows: [], error: reason, settled: false }));
    }
    last = parseApiAnalytics(body, windows.length, secrets);
    let allSettled = true;
    windows.forEach((window, index) => {
      const rows = last[index] ?? [];
      const key = apiWindowKey(rows);
      if (!settled[index] && apiReflected(rows, window.sent, env) && previous[index] === key) settled[index] = true;
      previous[index] = key;
      if (!settled[index]) allSettled = false;
    });
    if (allSettled) {
      io.out(`api-measure: 反映を確かめた（全 ${windows.length} 窓が 2 回続けて同じ値。読んだ回数 ${attempt}）`);
      break;
    }
    if (io.now() - startedAt + io.policy.pollIntervalMs > io.policy.maxWaitMs) {
      io.out(`api-measure: 反映を待ちきれなかった（読んだ回数 ${attempt}）。落ち着かなかった窓は判断不能にする`);
      break;
    }
    await io.sleep(io.policy.pollIntervalMs);
  }
  return windows.map((window, index) => ({
    window,
    rows: last[index] ?? [],
    error: undefined,
    settled: settled[index] ?? false,
  }));
}

/** 1 つの窓を判定する。**未測定・不足・混入・名前不明は非抵触にせず判断不能**にする。 */
function apiJudgeWindow(reading: WindowReading, env: Env): WindowFinding {
  const base: {
    window: MeasureWindow;
    requests: Verdicts;
    errors: number;
    sampled: boolean;
  } = {
    window: reading.window,
    requests: requestsByWorker(reading.rows, env),
    errors: reading.rows.reduce((total, row) => total + row.errors, 0),
    sampled: reading.rows.some((row) => row.sampleInterval !== 1),
  };
  const undetermined = (reason: string): WindowFinding => ({ ...base, verdict: "undetermined", p7: undefined, reason });
  if (reading.error !== undefined) return undetermined(reading.error);
  if (!reading.settled) return undetermined("反映を待ちきれなかった（2 回続けて同じ値にならなかったか、回数が送った数と合わなかった）");
  if (reading.rows.length === 0) return undetermined("Analytics にこの窓の行が無い（反映待ち）");
  const unknown = totalRequests(reading.rows.filter((row) => row.scriptName === UNKNOWN_SCRIPT));
  if (unknown > 0) return undetermined(unknownReason(unknown));
  for (const worker of API_WORKERS) {
    const rows = workerRows(reading.rows, worker, env);
    if (rows.length !== 1) return undetermined(`${worker} の行が 1 つでない（${rows.length} 行。反映待ちか、記録の粒度が違う）`);
    const requests = requestsOf(reading.rows, worker, env);
    if (!aboutSent(requests, reading.window.sent)) {
      return undetermined(`${worker} の回数（${requests}）が送った数（${reading.window.sent}）と合わない（反映待ちか、他の通信の混入）`);
    }
  }
  const p7 = judgeP7({
    host: maxOf(reading.rows, "host", env),
    gateway: maxOf(reading.rows, "gateway", env),
    "data-api": maxOf(reading.rows, "data-api", env),
  });
  return { ...base, verdict: p7.verdict, p7, reason: p7.reason };
}

const maxOf = (rows: readonly InvocationRow[], worker: ApiWorker, env: Env = TARGET_ENV): number =>
  workerRows(rows, worker, env).reduce((max, row) => Math.max(max, row.cpuMaxUs), 0);

/** P-1：過去 7 日の上限超過を、既存の期間レポート（free-tier-report.ts）を**別に読んで**判定する。 */
async function apiReadP1(io: ApiMeasureIo, credentials: Credentials, secrets: readonly string[]): Promise<P1Finding> {
  try {
    const reading = await io.readExceeded(io, credentials, secrets);
    if (reading === undefined) return judgeP1(undefined, "期間レポートが空を返した");
    return judgeP1(reading, undefined);
  } catch (e) {
    const reason = e instanceof MeasureError ? e.message : `期間レポートを読めない（${e instanceof Error ? e.name : typeof e}）`;
    return judgeP1(undefined, reason);
  }
}

/**
 * 既定の P-1 の読取。**既存の期間レポート（free-tier-report.ts）の Query と集計をそのまま使う。**
 * 動的 import にしてあるのは、この file が free-tier-report を静的に読むと循環になるため
 * （free-tier-report → この file）。値は出力に出さず、件数と日付だけを返す。
 */
const realReadExceeded: ExceededReader = async (io, credentials, secrets) => {
  const { REPORT_QUERY, parsePeriod, parseReport, reportVariables, summarizeExceeded } = await import("./free-tier-report.ts");
  const period = parsePeriod({}, io.now());
  const body = await callApi(io, credentials, "/graphql", {
    method: "POST",
    body: JSON.stringify({ query: REPORT_QUERY, variables: reportVariables(credentials.accountId, period) }),
  });
  const data = parseReport(body, "アカウント①", secrets);
  const exceeded = summarizeExceeded(data.invocations);
  return { musunest: exceeded.musunest, unknown: exceeded.unknown, since: period.since, until: period.until };
};

/** 計測に入る前の確認。引数から規模と経路を決める。 */
function apiParseArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        instance: { type: "string" },
        env: { type: "string" },
        sample: { type: "string" },
        sizes: { type: "string" },
        routes: { type: "string" },
        warm: { type: "string" },
        count: { type: "string" },
        "max-requests": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new MeasureError(`引数が不正（値は表示しない）\n${API_USAGE}`);
  }
}

const parseIds = <T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  option: string,
): readonly T[] => {
  if (raw === undefined || raw === "") return allowed;
  const chosen = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const unknown = chosen.filter((part) => !(allowed as readonly string[]).includes(part));
  if (unknown.length > 0 || chosen.length === 0) throw new MeasureError(`${option} は ${allowed.join("|")} から選ぶ（値は表示しない）`);
  return allowed.filter((value) => chosen.includes(value));
};

export async function runApiMeasurement(argv: readonly string[], io: ApiMeasureIo): Promise<number> {
  try {
    return await apiRun(argv, io);
  } catch (e) {
    if (e instanceof MeasureError) io.err(`api-measure: ${e.message}`);
    else io.err(`api-measure: 予期しない失敗（${e instanceof Error ? e.name : typeof e}）`);
    return EXIT_NG;
  }
}

async function apiRun(argv: readonly string[], io: ApiMeasureIo): Promise<number> {
  const values = apiParseArgs(argv);
  if (values.help === true) {
    io.out(API_USAGE);
    return EXIT_OK;
  }
  const instanceId = values.instance;
  if (instanceId === undefined || instanceId === "") throw new MeasureError(`--instance が無い（計測用インスタンスの ID）\n${API_USAGE}`);
  if (!API_INSTANCE_PATTERN.test(instanceId)) throw new MeasureError("--instance は英字で始まる英数字と . _ - で書く（値は表示しない）");
  if (API_DEMO_INSTANCE.test(instanceId)) {
    throw new MeasureError("--instance に demo を含む ID は使わない（デモ・窓口のインスタンスを触らない。専用の計測インスタンスを明示する）");
  }
  const envRaw = values.env;
  if (envRaw !== undefined && !(API_ENVS as readonly string[]).includes(envRaw)) {
    throw new MeasureError(
      `--env ${JSON.stringify(envRaw)} は測らない（${API_ENVS.join(" / ")} だけ）。` +
        "production は別アカウントで /api/* が 404 なので測らない。1 回も送らずに止める",
    );
  }
  const env: Env = envRaw === undefined ? TARGET_ENV : (envRaw as Env);
  const sampleRaw = values.sample ?? DEFAULT_API_SAMPLE;
  if (!(API_SAMPLES as readonly string[]).includes(sampleRaw)) {
    throw new MeasureError(`--sample は ${API_SAMPLES.join("|")} から選ぶ（値は表示しない）。1 回も送らずに止める`);
  }
  const sample = API_SAMPLE_BY_ID[sampleRaw as ApiSampleId];
  // 経路と規模は見本ごとに違う（dashboard の経路は spec・dashboard・activities・members）
  const sizeIds = parseIds(values.sizes, sample.sizes.map((size) => size.id), "--sizes");
  const sizes = sample.sizes.filter((size) => sizeIds.includes(size.id));
  const routeIds = parseIds(values.routes, sample.routes.map((route) => route.id), "--routes");
  const routes = sample.routes.filter((route) => routeIds.includes(route.id));
  const warmup = positiveInteger(values.warm, "--warm", io.policy.warmup);
  const measured = positiveInteger(values.count, "--count", io.policy.measured);
  // 1 経路・1 規模あたりに送る回数の上限。既定は Issue #25 で承認された枠（50）。
  // Issue #152 の「継続して 200 回」の実測では、**明示的に**上げる（--max-requests 205。経路を合算して緩めるのとは別）。
  const maxRequests = positiveInteger(values["max-requests"], "--max-requests", MAX_REQUESTS);
  if (warmup + measured > maxRequests) {
    throw new MeasureError(
      `温め ${warmup} + 本測定 ${measured} が ${maxRequests} を超える。**経路を合算して上限を緩めない**（1 経路・1 規模ごとに ${maxRequests} 以内）。1 回も送らずに止める`,
    );
  }

  const credentials = readCredentials(io.env);
  const subdomain = await readSubdomain(io, credentials);
  const hostname = hostHostname(subdomain, env);
  const origin = `https://${hostname}`;
  const secrets = [credentials.token, credentials.accountId, subdomain, hostname];

  // 1. 宣言を読み、action の名前を引く（読み取りだけ。計測の窓の外）。見本に要る action が無ければ、何も書かずに止める
  const spec = await apiFetch(io, new URL(apiSpecPath(instanceId), origin), "spec（宣言）", instanceId);
  const setup = sample.setup(spec.body);

  // 2. P-1（過去 7 日。窓の外。既存の期間レポートを別に読む）
  const p1 = await apiReadP1(io, credentials, secrets);

  io.out(`api-measure: env=${env} の計測用インスタンス（${instanceId}）で測る（見本 ${sample.id}）`);
  io.out(`api-measure: 経路 ${routes.map((route) => route.id).join("・")} / 規模 ${sizes.map((size) => size.id).join("・")}`);
  io.out(
    `api-measure: 各経路・各規模を ${warmup} 回温め → ${io.policy.gapMs / 1000} 秒空けて → ${measured} 回測る` +
      `（合計 ${warmup + measured} 回 ≤ ${maxRequests}/窓。全経路を合算しない）`,
  );

  // 3. 規模ごとに：片付け → 準備 → 計測 → 片付け（準備と片付けは窓の外）
  const windows: MeasureWindow[] = [];
  try {
    for (const size of sizes) {
      await apiCleanUp(io, origin, instanceId, setup);
      const created = await setup.prepare(io, origin, instanceId, size);
      io.out(`api-measure: ${size.id} を準備した（${created}。計測の窓の外）`);
      for (const route of routes) {
        const warm = await apiSendPhase(io, origin, instanceId, route, warmup);
        await io.sleep(io.policy.gapMs);
        const measuredPhase = await apiSendPhase(io, origin, instanceId, route, measured);
        const window: MeasureWindow = { size, route, warm: warm.window, measured: measuredPhase.window, sent: measured };
        assertWindowSeparated(window, io.policy.gapMs);
        assertNoOverlap(windows, window);
        windows.push(window);
        io.out(
          `api-measure: ${size.id} / ${route.id} を送った（温め ${warm.sent} 回 → ${io.policy.gapMs / 1000} 秒 → ` +
            `本測定 ${measuredPhase.sent} 回。本測定の窓 ${measuredPhase.window.since}〜${measuredPhase.window.until}）`,
        );
        // 片付けと次の温めを、本測定の窓の外へ出す（窓の余白より長く空ける）
        await io.sleep(API_OUTSIDE_WINDOW_MS);
      }
      await apiCleanUp(io, origin, instanceId, setup);
      io.out(`api-measure: ${size.id} を片付けた（${setup.cleanUpOrder}の順）`);
    }
  } finally {
    // 途中で失敗しても、専用インスタンスのデータは片付ける（残すと次の計測や e2e に混ざる）
    try {
      const removed = await apiCleanUp(io, origin, instanceId, setup);
      if (removed > 0) io.out(`api-measure: 残りを片付けた（${removed} 行）`);
    } catch {
      io.err("api-measure: 片付けに失敗した（専用インスタンスにデータが残っている可能性がある）");
    }
  }

  // 4. Analytics を読み（本測定の窓だけ）、P-7 を判定する
  const readings = await apiReadWindows(io, credentials, secrets, windows, env);
  const findings = readings.map((reading) => apiJudgeWindow(reading, env));

  io.out("");
  io.out("══ 結果（本測定の窓。Worker ごとの max.cpuTime）");
  for (const finding of findings) {
    const p7 = finding.p7;
    const max = p7 === undefined ? "—" : API_WORKERS.map((worker) => `${worker} ${fmtMs(p7.maxMs[worker])}`).join("・");
    const requests = API_WORKERS.map((worker) => `${worker} ${finding.requests[worker]}`).join("・");
    const sum = p7 === undefined ? "—" : `記録: 和 ${fmtMs(p7.sumMs)}（判定に使わない）`;
    io.out(
      `  ${finding.window.size.id} / ${finding.window.route.id}: ${max}  ${sum}  ` +
        `回数 ${requests}  errors ${finding.errors}  窓 ${finding.window.measured.since}〜${finding.window.measured.until}` +
        (finding.sampled ? "  注: サンプリングあり（max は取りこぼし得る）" : ""),
    );
    io.out(`    判定: ${verdictLabel(finding.verdict)} — ${finding.reason}`);
  }
  io.out("");
  io.out("══ P-1（過去 7 日の上限超過。既存の期間レポートを別に読む）");
  io.out(`  判定: ${verdictLabel(p1.verdict)} — ${p1.reason}`);
  io.out("");
  io.out("══ 判定");
  io.out(`  P-7: ${verdictLabel(apiOverall(findings, "touched"))} — ${apiOverallReason(findings)}`);
  io.out(`  P-1: ${verdictLabel(p1.verdict)} — ${p1.reason}`);

  if (findings.some((finding) => finding.verdict === "touched") || p1.verdict === "touched") {
    io.out("api-measure: 触れた 管理を通じて窓口へ返す（Workers Paid への変更は人が行う。構成は崩さない）");
    return EXIT_TOUCHED;
  }
  if (findings.some((finding) => finding.verdict === "undetermined") || p1.verdict === "undetermined") {
    io.out("api-measure: 判断不能 未測定を 0 や成功として記録しない。時間を空けて測り直す");
    return EXIT_UNDETERMINED;
  }
  io.out("api-measure: OK 判定できた（結果は workspace/mvp/m1/measurements.md に記録する）");
  return EXIT_OK;
}

const verdictLabel = (verdict: Verdict): string =>
  verdict === "touched" ? "触れた" : verdict === "undetermined" ? "判断不能" : "触れていない";

const apiOverall = (findings: readonly WindowFinding[], verdict: Verdict): Verdict =>
  findings.some((finding) => finding.verdict === verdict) ? verdict : "clear";

function apiOverallReason(findings: readonly WindowFinding[]): string {
  const touched = findings.filter((finding) => finding.verdict === "touched");
  if (touched.length > 0) {
    return touched
      .map((finding) => `${finding.window.size.id} / ${finding.window.route.id} で ${finding.reason}`)
      .join(" / ");
  }
  const undetermined = findings.filter((finding) => finding.verdict === "undetermined");
  if (undetermined.length > 0) {
    return undetermined
      .map((finding) => `${finding.window.size.id} / ${finding.window.route.id} が判断不能（${finding.reason}）`)
      .join(" / ");
  }
  return `測った ${findings.length} 窓のすべてで、どの Worker の最大も単体で 7 ms を超えていない`;
}

export const API_USAGE = `usage: pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --api --instance <id> [--sample <${API_SAMPLES.join("|")}>] [--env <${API_ENVS.join("|")}>] [--sizes basic,20,200] [--routes <a,b>] [--warm <n>] [--count <n>] [--max-requests <n>]

  --api                   /api の経路（#102 の spec・支出一覧・member の集計一覧・#108 の精算結果）の CPU 時間を測る
  --instance <id>         計測用インスタンスの ID（**必須**。demo を含む ID は使わない）
  --env <env>             測る環境（既定 ${TARGET_ENV}）。${API_ENVS.join(" / ")} だけ。production は別アカウントで /api/* が 404 なので測らない
                          dev は、上限を自分で設定して Free の壁を再現するときに使う（Issue #152）
  --sample <name>         測る見本（既定 ${DEFAULT_API_SAMPLE}）。${API_SAMPLES.join(" / ")}（Issue #216）
  --sizes <a,b>           規模（既定は全部。basic・20・200）
                          warikan: basic = A/B/C と 2 支出、20・200 は支出の件数
                          dashboard: メンバー 4 人と活動 2・20・200 件（日付は日本時間の今月と先月）
  --routes <a,b>          経路（既定は全部）
                          warikan: ${API_ROUTES.map((route) => route.id).join("・")}
                          dashboard: ${DASHBOARD_ROUTES.map((route) => route.id).join("・")}
  --warm <n>              温めの回数（既定 ${API_WARMUP_REQUESTS}）／ --count <n> 本測定の回数（既定 ${API_MEASURED_REQUESTS}）
  --max-requests <n>      1 経路・1 規模あたりに送る回数の上限（既定 ${MAX_REQUESTS}）。温め + 本測定 はこれ以下
                          （**経路を合算しない**）。既定を上げるのは、枠を明示的に広げるときだけ（Issue #152 の 200 回）

各経路・各規模を ${API_WARMUP_REQUESTS} 回温め → ${API_GAP_MS / 1000} 秒空けて → ${API_MEASURED_REQUESTS} 回測る。
準備と片付けは計測の窓の外（#109 の delete で片付ける。準備の POST は回数の上限に数えない）。CPU 時間は Workers Analytics の worker 別 cpuTime の max。
資格情報は環境変数 CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（手元の .env。アカウント①）。
出すのは回数・ミリ秒・判定・窓の時刻だけ。URL・ホスト名・Account ID・トークンを出さない。
exit ${EXIT_OK}: 判定できて非抵触／${EXIT_NG}: 失敗／${EXIT_UNDETERMINED}: 判断不能／${EXIT_TOUCHED}: P-7 か P-1 に触れた`;

// ── 出力 ──────────────────────────────────────────────────────────────────────

const fmtMs = (value: number): string => `${value.toFixed(2)} ms`;

/** 表の1列。 */
const col = (text: string): string => text.padStart(10);

const SAMPLED_NOTE = "サンプリングあり（回数・和は推定値、max・分位は取りこぼし得る）";

export function formatAssets(finding: AssetsFinding): string[] {
  return [
    `── 要確認 4：Static Assets へのリクエストは Worker を起動するか（/ と深いリンク 計 ${finding.sent} 回）`,
    ...WORKERS.map((worker) => `  ${worker.padEnd(9)} ${finding.counts[worker]} 回の起動（workersInvocationsAdaptive）`),
    ...(finding.unknown > 0 ? [`  ${UNKNOWN_SCRIPT} ${finding.unknown} 回の起動`] : []),
    `  assets    ${finding.assets} 回（workersAssetsRequestsAdaptiveGroups）`,
    `  判定: ${finding.reason}`,
  ];
}

export function formatServiceBinding(finding: ServiceBindingFinding): string[] {
  return [
    `── 要確認 2：Service Binding の呼び出しは別の requests として数えられるか（/healthz ${finding.sent} 回）`,
    ...WORKERS.map((worker) => `  ${worker.padEnd(9)} ${finding.counts[worker]} 回（workersInvocationsAdaptive の sum.requests）`),
    ...(finding.unknown > 0 ? [`  ${UNKNOWN_SCRIPT} ${finding.unknown} 回`] : []),
    ...(finding.sampled ? [`  注: ${SAMPLED_NOTE}`] : []),
    `  判定: ${finding.reason}`,
  ];
}

export function formatCpu(finding: CpuFinding, sent: number, limitMs: number): string[] {
  const head = `── CPU 時間（/healthz ${sent} 回。上限 ${limitMs} ms）`;
  if (finding.outcome === "undetermined") return [head, `  判定: 判定できない — ${finding.reason}`];
  return [
    head,
    `  ${"".padEnd(9)} ${col("p50")} ${col("p99")} ${col("max")} ${col("平均")}`,
    ...finding.workers.map(
      (w) =>
        `  ${w.worker.padEnd(9)} ${col(fmtMs(w.p50Ms))} ${col(fmtMs(w.p99Ms))} ${col(fmtMs(w.maxMs))} ${col(fmtMs(w.meanMs))}` +
        (w.sampled ? `  ${SAMPLED_NOTE}` : ""),
    ),
    `  チェーン合計の上界（max の和）  ${fmtMs(finding.chainMaxMs)}（余裕 ${fmtMs(finding.marginMs)}）`,
    `  チェーン合計の平均             ${fmtMs(finding.chainMeanMs)}`,
    ...(finding.errors > 0 ? [`  errors ${finding.errors} 回`] : []),
    finding.downstreamExcluded
      ? "  要確認 1: host の cpuTime は gateway・data-api の分を含まない（host の平均 < 下流の平均の和）。Worker ごとに別に記録されている"
      : "  要確認 1: host の平均が下流の平均の和以上なので、host の cpuTime が下流を含むかは言えない",
    `  判定: ${finding.reason}`,
  ];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface CliIo {
  /** 環境変数。CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（・CLOUDFLARE_ACCOUNT_ID_PROD）を読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Cloudflare の API（サブドメイン・GraphQL）を呼ぶ */
  fetch: typeof fetch;
  /** host への GET */
  get: HttpGet;
  /** 壁時計（エポックからのミリ秒） */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  policy: MeasurePolicy;
  /** `--api` の待ち方。既定は API_MEASURE_POLICY（5 回温め → 60 秒 → 20 回） */
  readonly apiPolicy?: ApiMeasurePolicy;
  /** `--api` の P-1。既定は free-tier-report.ts を動的に読む */
  readonly readExceeded?: ExceededReader;
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const USAGE = `usage: pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts [--pages <m>] [--healthz <n>] [--cpu-limit-ms <ms>]
       pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --pages-window <since>/<until> --healthz-window <since>/<until> [--pages <m>] [--healthz <n>]

  --pages <m>             / と深いリンクを、それぞれ m 回送る（既定 ${DEFAULT_PLAN.pages}）
  --healthz <n>           /healthz を n 回送る（既定 ${DEFAULT_PLAN.healthz}）。2m + n は ${MAX_REQUESTS} 以下
  --cpu-limit-ms <ms>     CPU 時間の上限（既定 ${FREE_CPU_LIMIT_MS}。一次情報が変わったら与える）
  --pages-window, --healthz-window
                          GET を送らず、前に送った窓を Analytics から読み直す（1つ目の形が出力する値をそのまま渡す）
  --api                   /api の経路の CPU 時間を測るモード（--instance が要る。上の形とは別。--api --help を参照）

宛先は ${TARGET_ENV} の host（Worker 名 ${scriptName("host")}）。URL は Cloudflare の API から組み立て、表示しない。
資格情報は環境変数 CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（アカウント①の CI 用トークン）。
出すのは回数・ミリ秒・判定・窓の時刻だけ。
exit ${EXIT_OK}: 判定できて前提が成り立った／${EXIT_NG}: 失敗か前提が崩れた／${EXIT_UNDETERMINED}: 判定できない（窓を指定して読み直す）`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof MeasureError) {
      io.err(`measure: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（URL・ID を含み得る）。種別だけ出す。
      io.err(`measure: 予期しない失敗（${e instanceof Error ? e.name : typeof e}）`);
    }
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        pages: { type: "string" },
        healthz: { type: "string" },
        "cpu-limit-ms": { type: "string" },
        "pages-window": { type: "string" },
        "healthz-window": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    // parseArgs の文言は引数をそのまま含む。値を出さない。
    throw new MeasureError(`引数が不正（値は表示しない）\n${USAGE}`);
  }
}

function positiveInteger(raw: string | undefined, option: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,3}$/.test(raw)) throw new MeasureError(`${option} は 1 以上の整数`);
  return Number(raw);
}

/** Cloudflare の API を呼ぶのに要る最小の口（measure・`--api`・期間レポートの読取で共有する）。 */
export interface ApiCaller {
  readonly fetch: typeof fetch;
  readonly policy: { readonly requestTimeoutMs: number };
}

async function callApi(io: ApiCaller, credentials: Credentials, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await io.fetch(`${CLOUDFLARE_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(io.policy.requestTimeoutMs),
    });
  } catch (e) {
    throw new MeasureError(`Cloudflare の API に届かない（${describeGetError(e)}）`);
  }
  if (res.status === 401 || res.status === 403) {
    throw permissionError(path === "/graphql" ? "Analytics（GraphQL）を読む" : "Workers のサブドメインを読む");
  }
  if (res.status === 429) throw new MeasureError("Cloudflare の API のレート制限に掛かった。5 分以上空けて読み直す");
  try {
    return await res.json();
  } catch {
    throw new MeasureError(`Cloudflare の API の応答が JSON でない（HTTP ${res.status}）`);
  }
}

async function readSubdomain(io: ApiCaller, credentials: Credentials): Promise<string> {
  const body = await callApi(io, credentials, `/accounts/${credentials.accountId}/workers/subdomain`);
  const result = isRecord(body) ? body.result : undefined;
  const subdomain = isRecord(result) ? result.subdomain : undefined;
  if (!isRecord(body) || body.success !== true || !isSubdomain(subdomain)) {
    throw new MeasureError("Workers のサブドメインが読めない（workers.dev のサブドメインが無いか、応答の形が違う）");
  }
  return subdomain;
}

/** 1つの段（ページ／healthz）を順に送る。1回でも ok でなければその場で止める。 */
async function sendPhase(
  io: CliIo,
  origin: URL,
  paths: readonly string[],
  headers: Readonly<Record<string, string>>,
  check: (res: HttpResponse) => string | undefined,
  label: string,
): Promise<PhaseRecord> {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const [i, path] of paths.entries()) {
    const startedAt = io.now();
    let res: HttpResponse;
    try {
      res = await io.get(new URL(path, origin), headers, io.policy.requestTimeoutMs);
    } catch (e) {
      throw new MeasureError(`${label} の ${i + 1} 回目（${path}）が届かない（${describeGetError(e)}）。ここで止める`);
    }
    const problem = check(res);
    if (problem !== undefined) throw new MeasureError(`${label} の ${i + 1} 回目（${path}）: ${problem}。ここで止める`);
    // Cloudflare の時計を使う。Date ヘッダが無ければ手元の時計（送る前と受けた後）
    const served = res.date === null ? Number.NaN : Date.parse(res.date);
    first = Math.min(first, Number.isNaN(served) ? startedAt : served);
    last = Math.max(last, Number.isNaN(served) ? io.now() : served);
  }
  return { window: windowOf(first, last), sent: paths.length };
}

async function drive(io: CliIo, origin: URL, plan: Plan): Promise<DriveRecord> {
  const pagePaths = Array.from({ length: plan.pages }, () => [ROOT_PATH, DEEP_LINK_PATH]).flat();
  const pages = await sendPhase(io, origin, pagePaths, NAVIGATION_HEADERS, checkPage, "ページ");
  io.out(`measure: ページ ${pages.sent}/${pages.sent} 回が SPAシェル（200 text/html）`);
  await io.sleep(io.policy.phaseGapMs);
  const healthzPaths = Array.from({ length: plan.healthz }, () => HEALTHZ_PATH);
  const healthz = await sendPhase(io, origin, healthzPaths, HEALTHZ_HEADERS, checkHealthz, HEALTHZ_PATH);
  io.out(`measure: ${HEALTHZ_PATH} ${healthz.sent}/${healthz.sent} 回が全層 ok`);
  return { pages, healthz };
}

interface Reading {
  readonly snapshot: Snapshot;
  readonly settled: boolean;
}

/** 反映を待って読む。2回続けて同じ値で、送った分が出揃っていれば反映済み。上限を超えて待たない。 */
async function readUntilSettled(read: () => Promise<Snapshot>, record: DriveRecord, io: CliIo): Promise<Reading> {
  const { policy } = io;
  const startedAt = io.now();
  let previous: Snapshot | undefined;
  for (let attempt = 1; ; attempt++) {
    const snapshot = await read();
    if (previous !== undefined && reflected(snapshot, record) && sameSnapshot(previous, snapshot)) {
      io.out(`measure: 反映を確かめた（2 回続けて同じ値。読んだ回数 ${attempt}）`);
      return { snapshot, settled: true };
    }
    previous = snapshot;
    if (io.now() - startedAt + policy.pollIntervalMs > policy.maxWaitMs) {
      io.out(`measure: 反映を待ちきれなかった（${policy.maxWaitMs / 60_000} 分・読んだ回数 ${attempt}）。最後に読んだ値で判定する`);
      return { snapshot, settled: false };
    }
    io.out(
      `measure: 反映待ち（${attempt} 回目: ${HEALTHZ_PATH} の窓の起動 ${totalRequests(snapshot.healthz.invocations)} 回・` +
        `ページの窓の assets ${snapshot.pages.assets} 回）… ${policy.pollIntervalMs / 1000} 秒後に読み直す`,
    );
    await io.sleep(policy.pollIntervalMs);
  }
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  // `--api` は引数の形が別である（--instance が要る）。ここで分ける。
  if (argv.includes(API_FLAG)) {
    return runApiMeasurement(
      argv.filter((arg) => arg !== API_FLAG),
      apiIoOf(io),
    );
  }
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  const plan: Plan = {
    pages: positiveInteger(values.pages, "--pages", DEFAULT_PLAN.pages),
    healthz: positiveInteger(values.healthz, "--healthz", DEFAULT_PLAN.healthz),
  };
  const limitRaw = values["cpu-limit-ms"];
  const limitMs = limitRaw === undefined ? FREE_CPU_LIMIT_MS : Number(limitRaw);
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new MeasureError("--cpu-limit-ms は正の数");
  const pagesWindow = values["pages-window"];
  const healthzWindow = values["healthz-window"];
  if ((pagesWindow === undefined) !== (healthzWindow === undefined)) {
    throw new MeasureError("--pages-window と --healthz-window は両方渡す（読み直すとき）か、両方渡さない（送るとき）");
  }
  const replay: DriveRecord | undefined =
    pagesWindow === undefined || healthzWindow === undefined
      ? undefined
      : {
          pages: { window: parseWindow(pagesWindow, "--pages-window"), sent: plan.pages * 2 },
          healthz: { window: parseWindow(healthzWindow, "--healthz-window"), sent: plan.healthz },
        };
  if (replay === undefined && requestCount(plan) > MAX_REQUESTS) {
    throw new MeasureError(`送る回数が ${requestCount(plan)} 回（2 × --pages + --healthz）。1回の実測は ${MAX_REQUESTS} 回まで。1回も送らずに止める`);
  }
  if (replay !== undefined) assertSeparated(replay);

  const credentials = readCredentials(io.env);
  const subdomain = await readSubdomain(io, credentials);
  const hostname = hostHostname(subdomain);
  const secrets = [credentials.token, credentials.accountId, subdomain, hostname];

  let record: DriveRecord;
  if (replay === undefined) {
    io.out(
      `measure: ${TARGET_ENV} の host に GET を送る（${ROOT_PATH} と深いリンクを各 ${plan.pages} 回・${HEALTHZ_PATH} を ${plan.healthz} 回。` +
        `合計 ${requestCount(plan)} 回 ≤ ${MAX_REQUESTS}）`,
    );
    record = await drive(io, new URL(`https://${hostname}`), plan);
    assertSeparated(record);
    io.out(`measure: 読み直すとき: ${formatWindows(record, plan)}`);
    io.out(
      `measure: ${io.policy.firstReadDelayMs / 1000} 秒待ってから Analytics を読む` +
        `（${io.policy.pollIntervalMs / 1000} 秒ごと・最大 ${io.policy.maxWaitMs / 60_000} 分）`,
    );
    await io.sleep(io.policy.firstReadDelayMs);
  } else {
    record = replay;
    io.out(`measure: GET を送らず、窓を Analytics から読み直す（${formatWindows(record, plan)}）`);
  }

  const read = async (): Promise<Snapshot> =>
    parseAnalytics(
      await callApi(io, credentials, "/graphql", {
        method: "POST",
        body: JSON.stringify({ query: ANALYTICS_QUERY, variables: analyticsVariables(credentials.accountId, hostname, record) }),
      }),
      secrets,
    );
  const { snapshot, settled } = await readUntilSettled(read, record, io);

  const assets = judgeAssets(snapshot.pages, record.pages.sent);
  const serviceBinding = judgeServiceBinding(snapshot.healthz.invocations, record.healthz.sent);
  const cpu = judgeCpu(snapshot.healthz.invocations, record.healthz.sent, limitMs);
  io.out("");
  for (const line of formatAssets(assets)) io.out(line);
  io.out("");
  for (const line of formatServiceBinding(serviceBinding)) io.out(line);
  io.out("");
  for (const line of formatCpu(cpu, record.healthz.sent, limitMs)) io.out(line);
  io.out("");

  if (assets.outcome === "invoked" || cpu.outcome === "over" || cpu.outcome === "over-if-summed") {
    io.out("measure: NG 設計の前提が崩れた（06 §5 の昇格トリガーを確かめる）");
    return EXIT_NG;
  }
  if (!settled || assets.outcome === "undetermined" || serviceBinding.outcome === "undetermined" || cpu.outcome === "undetermined") {
    io.out(`measure: 判定できない項目がある。時間を空けて読み直す: ${formatWindows(record, plan)}`);
    return EXIT_UNDETERMINED;
  }
  io.out("measure: OK 判定できた（結果は 06 §7 の表に日付・回数と一緒に書く）");
  return EXIT_OK;
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  get: nodeGet,
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  policy: MEASURE_POLICY,
};

/** `--api` の io を、CLI の io から組む。unit は apiPolicy と readExceeded を差し替える。 */
function apiIoOf(io: CliIo): ApiMeasureIo {
  return {
    env: io.env,
    out: io.out,
    err: io.err,
    fetch: io.fetch,
    now: io.now,
    sleep: io.sleep,
    policy: io.apiPolicy ?? API_MEASURE_POLICY,
    readExceeded: io.readExceeded ?? realReadExceeded,
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void runCli(process.argv.slice(2), defaultIo).then((code) => {
    process.exitCode = code;
  });
}
