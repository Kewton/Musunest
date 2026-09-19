// e2e/src/cli.ts — staging の見本の採点の入口（Issue #110）。
//
//   pnpm --filter @musunest/e2e test:staging
//
// 宛先（host のオリジン）は環境変数 SMOKE_BASE_URL、e2e 専用のインスタンスの ID は環境変数
// E2E_INSTANCE_ID から受け取る。**どちらか欠けたら、1つも叩かずに非 0 で止まる。**
//
// ── なぜ引数で受けないか（CLAUDE.md「このリポジトリは public である」）─────────────────
// pnpm は実行するコマンド行を引数ごとログに出す。--base-url のような引数で宛先を渡すと、
// workers.dev のサブドメインが公開の CI ログに載る（無償枠を他人に消費させる入口になる）。
// **URL は一切表示しない。** 応答の生の本文も出さない（SDK が型にした値だけを使う）。
// 例外の文言は URL・ホスト名・資格情報を含み得るので、種別だけを出す。念のため出力は伏せてから出す。
//
// 終了 0 は、原本 SHA-256・採点の値・後片付けのすべてが成功したときだけである
// （宛先・インスタンスの欠落、SHA の不一致、値の不一致、通信の失敗、後片付けの失敗は非 0）。
// 何もしなかったことを 0 と報告しない（欠落は叩く前の失敗にする）。
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createMusunestClient } from "@musunest/sdk";
import type { FetchLike } from "@musunest/sdk";
import { SAMPLE_FILE as TASK_BOARD_SAMPLE_FILE, runTaskBoard } from "./task-board.js";
import { DRAFT_SCHEMA_VERSION, SAMPLE_FILE as WARIKAN_SAMPLE_FILE, errorKind, runWarikan } from "./warikan.js";

export const EXIT_OK = 0;
export const EXIT_NG = 1;

/** 宛先（host のオリジン）を渡す環境変数。smoke と同じ（CI では staging 環境の Secret） */
export const BASE_URL_ENV = "SMOKE_BASE_URL";
/** e2e 専用のインスタンスの ID を渡す環境変数。明示しないと動かない（デモのインスタンスを触らない） */
export const INSTANCE_ENV = "E2E_INSTANCE_ID";
/** 採点する見本を選ぶ環境変数。既定は warikan（値は秘密ではない） */
export const SAMPLE_ENV = "E2E_SAMPLE";
/** 採点できる見本。見本のディレクトリの名前と同じである */
export const SAMPLES = ["warikan", "task-board"] as const;
export type SampleName = (typeof SAMPLES)[number];

const SAMPLE_FILE_OF: Readonly<Record<SampleName, string>> = {
  warikan: WARIKAN_SAMPLE_FILE,
  "task-board": TASK_BOARD_SAMPLE_FILE,
};
/** 環境に残っていてもログに出さない値（この CLI 自身は使わない）。伏せる側でも持つ */
export const CREDENTIAL_ENVS = ["SMOKE_PROBE_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/** インスタンス ID の形（publish の検査と同じ。値はエラーに出さない） */
export const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** デモ・窓口のインスタンスに触らないための目印（専用インスタンスの ID に demo を含めない） */
const DEMO_INSTANCE = /demo/i;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class E2eError extends Error {
  override name = "E2eError";
}

export interface CliIo {
  /** SMOKE_BASE_URL・E2E_INSTANCE_ID・E2E_SAMPLE を読む。資格情報の名前は伏せるためにも読む */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch: FetchLike;
  /** 原本を読む（既定は実ファイル。試験は差し替える） */
  readonly readFile: (path: string) => string;
  /** リポジトリの直下 */
  readonly root: string;
}

const USAGE = `usage: pnpm --filter @musunest/e2e test:staging

引数は取らない。宛先・インスタンス・見本は環境変数から受け取る（URL をコマンド行に出さない）。
  ${BASE_URL_ENV}   host のオリジン（CI では staging 環境の Secret）
  ${INSTANCE_ENV}   e2e 専用のインスタンスの ID（デモのインスタンスは触らない）
  ${SAMPLE_ENV}     採点する見本（${SAMPLES.join(" / ")}。既定は warikan）

見本（${WARIKAN_SAMPLE_FILE}・${TASK_BOARD_SAMPLE_FILE}）の原本 SHA-256 と版を照合し、
**時計に依存しない**採点の値（割り勘: shareAmount・paid/owed/balance・精算。タスク管理: ボードの列・
タスクの項目・openTasks・finish）を比べ、専用データを片付ける。期限切れのような時計に依る値は、
時計を差し込んだ unit で採点する（ここでは見ない）。
すべて成功したときだけ exit ${EXIT_OK}。それ以外は exit ${EXIT_NG}。`;

/** 採点する見本を読む。既定は warikan。知らない名前は止める（値は表示しない） */
export function sampleOf(raw: string | undefined): SampleName {
  if (raw === undefined || raw === "") return "warikan";
  if ((SAMPLES as readonly string[]).includes(raw)) return raw as SampleName;
  throw new E2eError(`${SAMPLE_ENV} は ${SAMPLES.join(" / ")} のどれかを渡す（値は表示しない）`);
}

const URL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const WORKERS_DEV_HOST = /(?:[a-z0-9_-]+\.)+workers\.dev(?![a-z0-9_-])/gi;
export const REDACTED = "<伏せた>";

/** 1行を伏せる。資格情報の値 → workers.dev のホスト名 → URL の形 の順に置き換える */
export function redact(line: string, values: readonly string[]): string {
  let out = line;
  for (const value of values) {
    if (value.length >= 8) out = out.split(value).join(REDACTED);
  }
  return out.replace(WORKERS_DEV_HOST, `<伏せた>.workers.dev`).replace(URL_SHAPE, REDACTED);
}

/** 宛先を、オリジンだけの URL として読む。値はエラーに出さない。 */
export function originOf(raw: string | undefined, source: string): string {
  if (raw === undefined || raw === "") {
    throw new E2eError(`宛先が無い: 環境変数 ${BASE_URL_ENV} に host のオリジンを渡す`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // TypeError の input に値がそのまま入る。捨てる。
    throw new E2eError(`${source} が URL として読めない（値は表示しない）`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new E2eError(`${source} は http(s) の URL を書く（値は表示しない）`);
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new E2eError(`${source} はオリジンだけを書く。パス・クエリ・資格情報を含めない（値は表示しない）`);
  }
  return url.origin;
}

/** 専用インスタンスの ID を読む。空・形が違う・デモの目印を含むものは止める（値は表示しない）。 */
export function instanceOf(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new E2eError(`インスタンス ID が無い: 環境変数 ${INSTANCE_ENV} に e2e 専用インスタンスの ID を渡す`);
  }
  if (!INSTANCE_PATTERN.test(raw) || DEMO_INSTANCE.test(raw)) {
    throw new E2eError(`${INSTANCE_ENV} は e2e 専用インスタンスの ID を渡す（demo を含む ID は触らない。値は表示しない）`);
  }
  return raw;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const values = CREDENTIAL_ENVS.map((name) => io.env[name]).filter((value): value is string => typeof value === "string");
  const out = (line: string): void => io.out(redact(line, values));
  const err = (line: string): void => io.err(redact(line, values));
  try {
    return await run(argv, io, out, err);
  } catch (e) {
    if (e instanceof E2eError) err(`e2e: ${e.message}`);
    else err(`e2e: 予期しない失敗（${errorKind(e)}）`);
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: { help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む（URL を位置引数で渡した誤りなど）。コードだけで言い分ける。
    const code = (e as { code?: unknown }).code;
    const what =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "知らないオプションがある"
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "位置引数は取らない"
          : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
            ? "オプションの値が無い"
            : "読めない";
    throw new E2eError(`引数が不正: ${what}（値は表示しない）\n${USAGE}`);
  }
}

async function run(
  argv: readonly string[],
  io: CliIo,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    out(USAGE);
    return EXIT_OK;
  }
  // 欠落は叩く前の失敗にする（何もしなかったことを 0 と報告しない）
  const baseUrl = originOf(io.env[BASE_URL_ENV], BASE_URL_ENV);
  const instanceId = instanceOf(io.env[INSTANCE_ENV]);
  const sample = sampleOf(io.env[SAMPLE_ENV]);
  const sampleFile = SAMPLE_FILE_OF[sample];
  const source = readSource(io, sampleFile);

  const client = createMusunestClient({ baseUrl, fetch: io.fetch });
  out(`e2e: staging の見本（${sampleFile}）を採点する（instance=${instanceId}）`);
  const result =
    sample === "task-board"
      ? await runTaskBoard({ client, instanceId, source, expectedSchemaVersion: DRAFT_SCHEMA_VERSION, out, err })
      : await runWarikan({ client, instanceId, source, expectedSchemaVersion: DRAFT_SCHEMA_VERSION, out, err });
  if (result.ok) {
    const scored =
      sample === "task-board"
        ? "原本 SHA-256・ボードの列・タスクの項目・openTasks・finish"
        : "原本 SHA-256・shareAmount・paid/owed/balance・精算";
    out(`e2e: OK  ${instanceId} の見本が一致した（${scored}）`);
    return EXIT_OK;
  }
  err(`e2e: NG  ${result.reason}`);
  return EXIT_NG;
}

/** 原本を読む。読めなければ値を含まない説明で止める */
function readSource(io: CliIo, sampleFile: string): string {
  try {
    return io.readFile(join(io.root, sampleFile));
  } catch {
    throw new E2eError(`原本（${sampleFile}）を読めない`);
  }
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (url, init) => fetch(url, init),
  readFile: (path) => readFileSync(path, "utf8"),
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
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
