// publish — 検査済みの見本を、原本と正規化した JSON の組で R2 に置き、D1 に登録する入口
// （Issue #101。workspace/mvp/m1/README.md §3.1・§10.2）。
//
//   pnpm exec tsx infra/scripts/publish.ts --env <dev|staging> --instance <id> --spec <app.spec.yaml>
//
// 中身（検査 → 正規化 → R2 の 2 個 → D1 の登録）は @musunest/control-plane に置いてある（Q14）。
// **ここが持つのは、引数の解釈・原本の読取・環境変数からの資格情報の取得・Cloudflare adapter の組立・
// 安全な結果表示だけ**である（03 §5.3。CLI 側に検査や正規化を複製しない）。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）─────────────────────────
//
//   - **production へは書き込みの前に断る。** --env は dev / staging だけ。CLOUDFLARE_ACCOUNT_ID が
//     production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指していても、API を呼ぶ前に止める
//   - 出すのは、成功なら **版・原本 SHA・インスタンス ID**、失敗なら **段と、値を持たない説明**だけ。
//     **トークン・Account ID・バケット名・R2 のキー・URL を出さない。** 例外の文言も出さない
//     （想定外の例外は種別だけ）。Cloudflare の API のエラー本文も出さない
//   - 原本のパスは引数。読めなければ API を呼ばずに止める
//
// ── 「はっきり差し替える」（--replace・#175）────────────────────────────────
//
//   宣言の語彙を足す Issue は、その語彙を使う見本を同じ Issue で書き換える（docs/parallel-development.md
//   §7.2）。**見本の原本 SHA-256 が変わる**ので、既定の publish（暗黙に差し替えない）では
//   `instance_conflict` で止まる。`--replace` を付けると、**はっきり差し替える**。
//
//   - **既定（--replace 無し）の挙動は変えない。** 参照先が違う SHA-256 なら `instance_conflict` で断る
//   - 差し替えてよい宣言かの判定は @musunest/control-plane が持つ（ここに判定を複製しない）。
//     ここが足すのは、**前の原本を読む口**（R2 の GET）と、**前後の SHA-256 の表示**だけである
//   - 差し替えたときは、前の原本の SHA-256 と、後の原本の SHA-256 を出す。**ホスト名・オリジン・
//     バケット名・Account ID は出さない**（CLAUDE.md。SHA-256 は原本のバイト列の digest である）
//
// ── なぜ Cloudflare の API を直接叩くか（wrangler を使わないか）────────────────────
//
// D1 の登録は**束縛引数**で値を渡す（registry.ts の規律。値を SQL へ埋め込むと、引用符を含む ID で
// 表が壊れる）。wrangler の `d1 execute` は束縛引数を取らないので、値の埋め込みが要る。Cloudflare の
// API なら `{ batch: [{ sql, params }] }` で束縛引数のまま、まとめて1回で実行できる。
//   R2 へ置く … PUT  /accounts/<id>/r2/buckets/<bucket>/objects/<key>（本文がオブジェクトの中身）
//   D1 を実行 … POST /accounts/<id>/d1/database/<database_id>/query（本文が { batch: [...] }）
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
  publishSpec,
  type PublishResult,
  type RegistryExecutor,
  type SpecReader,
  type SpecWriter,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
} from "../../packages/control-plane/src/index.ts";
import { ENVS, type Env } from "./sync-bindings.ts";

/** publish してよい env。**production は書き込みの前に断る**（Q5・README §7.3）。 */
export const PUBLISHABLE_ENVS: readonly Env[] = ["dev", "staging"];

/** D1 の登録表と R2 のバケット名を読む設定（リポジトリルートからの相対パス）。R2・D1 を binding しているのは data-api だけ。 */
export const DATA_API_CONFIG = "packages/data-api/wrangler.jsonc";
export const CONTROL_DB_BINDING = "CONTROL_DB";
export const BUNDLES_BINDING = "BUNDLES";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** 1回の API 呼び出しの上限 */
export const REQUEST_TIMEOUT_MS = 30_000;

export const EXIT_OK = 0;
export const EXIT_NG = 1;

/** インスタンス ID の形。URL と SQL の束縛引数に載るので、記号を絞る（値はエラーに出さない）。 */
export const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class PublishError extends Error {
  override name = "PublishError";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ── 設定（data-api の wrangler.jsonc）─────────────────────────────────────────

export interface PublishTarget {
  /** CONTROL_DB の database_id（D1 の API に渡す） */
  readonly databaseId: string;
  /** BUNDLES の bucket_name（R2 の API に渡す） */
  readonly bucketName: string;
}

/**
 * 純粋関数。data-api の wrangler.jsonc のテキストから、env の CONTROL_DB と BUNDLES を読む。
 * database_id が UUID の形でない（infra:sync 未実行で `<TF_OUTPUT>` のまま）・名前が `<...>-<env>-*` の形でない
 * なら PublishError（1つも書かない）。
 */
export function readPublishTarget(text: string, env: Env): PublishTarget {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first !== undefined) throw new PublishError(`${DATA_API_CONFIG} が壊れている（${printParseErrorCode(first.error)}）`);
  const block = isRecord(config) && isRecord(config["env"]) ? config["env"][env] : undefined;
  if (!isRecord(block)) throw new PublishError(`${DATA_API_CONFIG} に env.${env} が無い`);

  const d1 = Array.isArray(block["d1_databases"])
    ? block["d1_databases"].find((entry) => isRecord(entry) && entry["binding"] === CONTROL_DB_BINDING)
    : undefined;
  const databaseId = isRecord(d1) ? d1["database_id"] : undefined;
  const databaseName = isRecord(d1) ? d1["database_name"] : undefined;
  if (
    typeof databaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)
  ) {
    throw new PublishError(
      `${DATA_API_CONFIG} の env.${env}.d1_databases[${CONTROL_DB_BINDING}].database_id が UUID の形でない` +
        "（infra:sync で書き戻す。値は表示しない）",
    );
  }
  if (typeof databaseName !== "string" || !new RegExp(`-${env}-control$`).test(databaseName)) {
    throw new PublishError(`${DATA_API_CONFIG} の env.${env}.d1_databases[${CONTROL_DB_BINDING}] の名前が <name_prefix>-${env}-control の形でない`);
  }

  const r2 = Array.isArray(block["r2_buckets"])
    ? block["r2_buckets"].find((entry) => isRecord(entry) && entry["binding"] === BUNDLES_BINDING)
    : undefined;
  const bucketName = isRecord(r2) ? r2["bucket_name"] : undefined;
  if (typeof bucketName !== "string" || !new RegExp(`-${env}-bundles$`).test(bucketName)) {
    throw new PublishError(`${DATA_API_CONFIG} の env.${env}.r2_buckets[${BUNDLES_BINDING}] の名前が <name_prefix>-${env}-bundles の形でない`);
  }
  return { databaseId, bucketName };
}

// ── 資格情報 ─────────────────────────────────────────────────────────────────

export interface Credentials {
  readonly token: string;
  readonly accountId: string;
}

/** CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む。production のアカウントなら止める。値はエラーにも出さない。 */
export function readCredentials(env: Readonly<Record<string, string | undefined>>): Credentials {
  const token = env["CLOUDFLARE_API_TOKEN"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    throw new PublishError(
      "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る（アカウント①のトークン。D1 Write と Workers R2 Storage: Edit を持つもの）",
    );
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new PublishError("CLOUDFLARE_API_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new PublishError("CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）");
  }
  const production = env["CLOUDFLARE_ACCOUNT_ID_PROD"];
  if (production !== undefined && production.toLowerCase() === accountId.toLowerCase()) {
    throw new PublishError("CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。publish しない");
  }
  return { token, accountId };
}

// ── Cloudflare の API の経路 ─────────────────────────────────────────────────

/** D1 の問い合わせの API の経路。 */
export const d1QueryPath = (accountId: string, databaseId: string): string =>
  `/accounts/${accountId}/d1/database/${databaseId}/query`;

/**
 * R2 のオブジェクトの API の経路。キーの `/` はそのまま段にし、段ごとに URL エンコードする。
 * URL の解決が `.`・`..` の段を畳んで別のキーを指す形は、置かずに止める（キーは表示しない）。
 */
export function r2ObjectPath(accountId: string, bucket: string, key: string): string {
  if (key === "") throw new PublishError("空のキーへは置かない");
  const path = `/accounts/${accountId}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  if (new URL(`${CLOUDFLARE_API}${path}`).pathname !== `${new URL(CLOUDFLARE_API).pathname}${path}`) {
    throw new PublishError("URL の経路で正しく指せないキー（. や .. の段を含む）。置かずに止める（キーは表示しない）");
  }
  return path;
}

// ── CLI の入出力 ─────────────────────────────────────────────────────────────

export interface CliIo {
  /** リポジトリルート */
  readonly root: string;
  /** CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_ACCOUNT_ID_PROD を読む */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Cloudflare の API を呼ぶ */
  readonly fetch: typeof fetch;
  /** 原本と設定を読む */
  readonly readFile: (path: string) => string;
  readonly requestTimeoutMs: number;
}

const USAGE = `usage: pnpm exec tsx infra/scripts/publish.ts --env <${PUBLISHABLE_ENVS.join("|")}> --instance <id> --spec <app.spec.yaml>

  --env <env>        ${PUBLISHABLE_ENVS.join(" / ")} だけ。${ENVS.filter((e) => !PUBLISHABLE_ENVS.includes(e)).join(" / ")} は書き込みの前に断る
  --instance <id>    宣言を使うインスタンスの ID（${INSTANCE_PATTERN.source}）
  --spec <path>      原本（app.spec.yaml）のパス。リポジトリの直下からの相対、または絶対
  --replace          既存インスタンスの宣言を、**はっきり差し替える**（既定は差し替えない）。
                     差し替えてよい宣言でなければ replacement_conflict で断る（R2 にも D1 にも書かない）

検査 → 正規化 → R2（原本と正規化した JSON の 2 個）→ D1（アプリ → インスタンス）の順に置く。
検査に通らない宣言は R2 にも D1 にも書かない。R2 のどちらかで失敗したら登録せず、D1 で失敗したら成功と報告しない。
同じ入力の再実行で復旧できる。${DATA_API_CONFIG} の env.<env> の ${CONTROL_DB_BINDING} と ${BUNDLES_BINDING} を使う。
--replace のときは、**R2 へ書く前に**、前の原本の正規化した JSON を読んで、差し替えてよい宣言かを確かめる
（データ層が広がる差し替えだけを通す。packages/appspec-schema/docs/semantics.md「宣言の差し替え」）。
差し替えたときは、前の原本の SHA-256 と、後の原本の SHA-256 を出す。
資格情報は環境変数 CLOUDFLARE_API_TOKEN（D1 Write・Workers R2 Storage: Edit）と CLOUDFLARE_ACCOUNT_ID（アカウント①）。
成功は exit ${EXIT_OK}、失敗は exit ${EXIT_NG}。トークン・Account ID・バケット名・R2 のキー・URL は出さない。`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof PublishError) {
      io.err(`publish: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（URL・Account ID を含み得る）。種別だけ出す。
      const kind = e instanceof Error ? e.name : typeof e;
      const code = (e as { code?: unknown }).code;
      io.err(`publish: 予期しない失敗（${kind}${typeof code === "string" ? ` ${code}` : ""}）`);
    }
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        env: { type: "string" },
        instance: { type: "string" },
        spec: { type: "string" },
        replace: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む。コードだけで言い分ける（deploy-worker.ts と同じ）。
    const code = (e as { code?: unknown }).code;
    const what =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "知らないオプションがある"
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "位置引数は取らない"
          : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
            ? "オプションの値が無い"
            : "読めない";
    throw new PublishError(`引数が不正: ${what}（値は表示しない）\n${USAGE}`);
  }
}

const isEnv = (v: string): v is Env => (ENVS as readonly string[]).includes(v);

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.env === undefined) throw new PublishError(`--env が無い\n${USAGE}`);
  if (!isEnv(values.env)) throw new PublishError(`未知の env（${PUBLISHABLE_ENVS.join(" / ")} のいずれか。値は表示しない）`);
  const env = values.env;
  if (!PUBLISHABLE_ENVS.includes(env)) {
    throw new PublishError(`--env ${env} へは publish しない（書き込みの前に断る）。${PUBLISHABLE_ENVS.join(" / ")} だけ`);
  }
  const instanceId = values.instance;
  if (instanceId === undefined || instanceId === "") throw new PublishError(`--instance が無い（インスタンス ID）\n${USAGE}`);
  if (!INSTANCE_PATTERN.test(instanceId)) {
    throw new PublishError("--instance は英字で始まる英数字と . _ - で書く（値は表示しない）");
  }
  const specPath = values.spec;
  if (specPath === undefined || specPath === "") throw new PublishError(`--spec が無い（原本 app.spec.yaml のパス）\n${USAGE}`);
  // 差し替えは既定で off。**指定が無いときの挙動を変えない**（既存インスタンスの宣言は暗黙に差し替えない）
  const replace = values.replace === true;

  // 原本を先に読む（読めなければ、資格情報も設定も要らない）
  const source = readSource(io, specPath);
  const target = readPublishTarget(readConfig(io), env);
  const credentials = readCredentials(io.env);

  io.out(
    `publish: env=${env} の R2（${BUNDLES_BINDING}）と D1（${CONTROL_DB_BINDING}）へ、検査済みの宣言を置く` +
      (replace ? "（--replace: 既存インスタンスの宣言を差し替える）" : ""),
  );

  const result = await publishSpec(
    {
      specs: cloudflareSpecWriter(io, credentials, target.bucketName),
      registry: cloudflareRegistryExecutor(io, credentials, target.databaseId),
      // 差し替えのときだけ、前の原本を読む口を渡す（差し替えない経路に R2 の読み取りを足さない）
      ...(replace ? { readSpec: cloudflareSpecReader(io, credentials, target.bucketName) } : {}),
    },
    { source, instanceId, replace },
  );
  return report(io, env, specPath, result);
}

/** 原本のパスを決めて読む。リポジトリの直下からの相対はそれを基準にし、絶対パスはそのまま使う。 */
function readSource(io: CliIo, specPath: string): string {
  const path = isAbsolute(specPath) ? specPath : resolve(io.root, specPath);
  try {
    return io.readFile(path);
  } catch {
    throw new PublishError("原本を読めない（--spec のパス。値は表示しない）");
  }
}

function readConfig(io: CliIo): string {
  try {
    return io.readFile(join(io.root, DATA_API_CONFIG));
  } catch {
    throw new PublishError(`${DATA_API_CONFIG} が読めない`);
  }
}

/** 結果を安全に出す。診断は #97 の 1 行（`<原本>:<行>:<列>: <コード>: <説明>`）で出す。 */
function report(io: CliIo, env: Env, specPath: string, result: PublishResult): number {
  if (result.ok) {
    io.out(
      `publish: OK  env=${env}: 版 ${result.app.schemaVersion} / 原本 SHA ${result.app.sourceSha256} / インスタンス ${result.instance.instanceId}`,
    );
    // 差し替えたときだけ、何から何へ変えたかを残す（#175）。値は SHA-256 とインスタンス ID だけである
    if (result.replacedSourceSha256 !== null) {
      io.out(
        `publish: 差し替え  env=${env}: 前の原本 SHA ${result.replacedSourceSha256} → 後の原本 SHA ${result.app.sourceSha256}` +
          `（インスタンス ${result.instance.instanceId}）`,
      );
    }
    return EXIT_OK;
  }
  const { failure } = result;
  io.err(`publish: NG  ${failure.message}`);
  for (const diagnostic of failure.diagnostics) {
    io.err(`  ${specPath}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code}: ${diagnostic.message}`);
  }
  io.err(
    `publish: NG  env=${env}（段 ${failure.stage}${failure.code === null ? "" : ` / ${failure.code}`}）。` +
      "書き込みは一部だけ済んでいる可能性がある。同じ入力で再実行する",
  );
  return EXIT_NG;
}

// ── Cloudflare adapter ───────────────────────────────────────────────────────

interface RequestSpec {
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
  /** 本文。省略すると本文なし */
  readonly body?: string;
  readonly contentType?: string;
}

interface ApiResponse {
  readonly status: number;
  /** JSON として読めなければ undefined */
  readonly body: unknown;
}

async function callApi(io: CliIo, credentials: Credentials, request: RequestSpec, what: string): Promise<ApiResponse> {
  let res: Response;
  try {
    res = await io.fetch(`${CLOUDFLARE_API}${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${credentials.token}`,
        ...(request.contentType === undefined ? {} : { "content-type": request.contentType }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(io.requestTimeoutMs),
    });
  } catch (e) {
    // 例外の文言は URL（Account ID・バケット・キー）を含み得る。種別だけを出す
    const cause = (e as { cause?: unknown }).cause;
    const code = isRecord(cause) ? cause["code"] : (e as { code?: unknown }).code;
    const kind = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
    throw new PublishError(`${what}: Cloudflare の API に届かない（${kind}）`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** 2xx でなければ止める。**応答の本文は出さない**（バケット名・キー・URL を含み得る）。 */
function ensureOk(res: ApiResponse, what: string): void {
  if (res.status === 401 || res.status === 403) {
    throw new PublishError(`${what}: 権限が無い（HTTP ${res.status}）。CLOUDFLARE_API_TOKEN の権限を確かめる`);
  }
  if (res.status === 429) {
    throw new PublishError(`${what}: Cloudflare の API のレート制限に掛かった。少し空けて再実行する`);
  }
  if (res.status < 200 || res.status > 299 || (isRecord(res.body) && res.body["success"] === false)) {
    throw new PublishError(`${what}: HTTP ${res.status}`);
  }
}

interface QueryOutcome {
  readonly rows: readonly SqlRow[];
  readonly changes: number;
}

/** D1 の応答（{ success, result: [{ results, meta: { changes } }] }）を読む。形が違えば止める。 */
export function parseD1Results(body: unknown): readonly QueryOutcome[] {
  const result = isRecord(body) ? body["result"] : undefined;
  if (!isRecord(body) || body["success"] !== true || !Array.isArray(result)) {
    throw new PublishError("D1 の応答の形が想定と違う（success と result の配列）");
  }
  return result.map((outcome) => {
    const rows = isRecord(outcome) ? outcome["results"] : undefined;
    const meta = isRecord(outcome) ? outcome["meta"] : undefined;
    const changes = isRecord(meta) ? meta["changes"] : undefined;
    if (!Array.isArray(rows)) throw new PublishError("D1 の応答の形が想定と違う（result[].results が無い）");
    return { rows: rows as readonly SqlRow[], changes: typeof changes === "number" ? changes : 0 };
  });
}

/**
 * D1 を RegistryExecutor の形で包む。`{ batch: [...] }` で、束縛引数のまま、まとめて1回で実行する
 * （D1 の API は複数の文を semicolon で並べたものを1つの batch として実行する）。
 */
export function cloudflareRegistryExecutor(io: CliIo, credentials: Credentials, databaseId: string): RegistryExecutor {
  const path = d1QueryPath(credentials.accountId, databaseId);
  const executeBatch = async (statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> => {
    const body = JSON.stringify({ batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
    const res = await callApi(io, credentials, { method: "POST", path, body, contentType: "application/json" }, "D1 を実行");
    ensureOk(res, "D1 を実行");
    return parseD1Results(res.body).map((outcome) => ({ rows: outcome.rows, changes: outcome.changes }));
  };
  return {
    query: async <Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> => {
      const [outcome] = await executeBatch([statement]);
      return (outcome?.rows ?? []) as readonly Row[];
    },
    execute: async (statement: SqlStatement): Promise<number> => {
      const [outcome] = await executeBatch([statement]);
      return outcome?.changes ?? 0;
    },
    batch: executeBatch,
  };
}

/** R2 を SpecWriter の形で包む。`PUT /accounts/<id>/r2/buckets/<bucket>/objects/<key>`。 */
export function cloudflareSpecWriter(io: CliIo, credentials: Credentials, bucketName: string): SpecWriter {
  return {
    write: async (key, body) => {
      const path = r2ObjectPath(credentials.accountId, bucketName, key);
      const res = await callApi(io, credentials, { method: "PUT", path, body, contentType: "application/octet-stream" }, "R2 へ置く");
      ensureOk(res, "R2 へ置く");
    },
  };
}

/**
 * R2 を SpecReader の形で包む（#175。差し替えのときだけ使う）。
 * `GET /accounts/<id>/r2/buckets/<bucket>/objects/<key>`。中身を JSON として読んで返す
 * （読めなければ `undefined`）。**応答の本文はそのまま出さない**——判定は呼ぶ側が行う。
 */
export function cloudflareSpecReader(io: CliIo, credentials: Credentials, bucketName: string): SpecReader {
  return {
    read: async (key) => {
      const path = r2ObjectPath(credentials.accountId, bucketName, key);
      const res = await callApi(io, credentials, { method: "GET", path }, "R2 から読む");
      ensureOk(res, "R2 から読む");
      return res.body;
    },
  };
}

const defaultIo: CliIo = {
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFileSync(path, "utf8"),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};

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
