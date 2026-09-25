// e2e/src/ui/cli.ts — 画面テストの入口（Issue #233）。
//
//   pnpm --filter @musunest/e2e test:ui
//
// 宛先（host のオリジン）は環境変数 SMOKE_BASE_URL、画面テスト専用インスタンスの**接頭辞**は
// 環境変数 UI_INSTANCE_ID から受け取る。見本ごとのインスタンスは `<接頭辞>-<見本>` である
// （`m15-ui` → `m15-ui-warikan`・`m15-ui-task-board`・`m15-ui-dashboard`。Issue #234 の手順と同じ）。
//
// ── なぜ引数で受けないか（CLAUDE.md「このリポジトリは public である」）─────────────────
// pnpm は実行するコマンド行を引数ごとログに出す。--base-url のような引数で宛先を渡すと、
// workers.dev のサブドメインが公開のログに載る。**URL は一切表示しない。** 例外の文言も出さない（種別だけ）。
// 出力は伏せてから出す（`e2e/src/cli.ts` と同じ扱い）。
//
// ── ブラウザを開く前に落とすもの ────────────────────────────────────────────────
// 宛先が無い・URL として読めない・インスタンス ID が無い・`demo` か `e2e` を含む、のときは
// **1 回もブラウザを開かずに非 0 で止まる**（デモと e2e のデータを壊さない。何もしなかったことを 0 と報告しない）。
//
// 終了 0 は、4 つの手順のすべての項目が合格し、片付けも成功し、レポートを書けたときだけである。

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { createMusunestClient } from "@musunest/sdk";
import type { FetchLike } from "@musunest/sdk";
import { CREDENTIAL_ENVS, E2eError, EXIT_NG, EXIT_OK, INSTANCE_PATTERN, originOf, redact } from "../cli.js";
import { errorKind } from "../warikan.js";
import type { SecretValue } from "./redact.js";
import { runUi } from "./run.js";
import { MOBILE_WIDTH, SCENARIOS, type Scenario } from "./scenarios.js";

export { EXIT_NG, EXIT_OK };

/** 宛先（host のオリジン）を渡す環境変数。smoke・e2e と同じ */
export const BASE_URL_ENV = "SMOKE_BASE_URL";
/** 画面テスト専用インスタンスの接頭辞を渡す環境変数。**デモと e2e のインスタンスを触らない** */
export const INSTANCE_ENV = "UI_INSTANCE_ID";
/** レポートの置き場（リポジトリの直下からの相対パス）。**最新の 1 つだけを git で追跡する** */
export const REPORT_DIR = "workspace/mvp/m1/ui-report";

/** 画面テストが使う見本（インスタンスの接尾辞）。**手順の定義から導く**（写しを作らない） */
export const SUFFIXES: readonly string[] = [...new Set(SCENARIOS.map((scenario) => scenario.suffix))];

/** デモ・e2e のインスタンスに触らないための目印（`demo`・`e2e` を含む ID は断る） */
const FORBIDDEN_INSTANCE = /(?:demo|e2e)/i;

const USAGE = `usage: pnpm --filter @musunest/e2e test:ui

引数は取らない。宛先とインスタンスは環境変数から受け取る（URL をコマンド行に出さない）。
  ${BASE_URL_ENV}   host のオリジン
  ${INSTANCE_ENV}   画面テスト専用インスタンスの接頭辞（${SUFFIXES.join(" / ")} を付けて使う）

3 つの見本の画面の操作（割り勘・タスク管理・ダッシュボード）と「残るか」を、幅 ${MOBILE_WIDTH} CSS px の
ブラウザで流し、合否・期待・実際・写真を ${REPORT_DIR}/ に書き出す（前回は上書きする）。
宛先の環境変数が無い・インスタンス ID に demo・e2e を含む、のときは**ブラウザを開かずに**止まる。
すべて合格し、片付けもレポートの書き出しも成功したときだけ exit ${EXIT_OK}。`;

export interface CliIo {
  /** SMOKE_BASE_URL・UI_INSTANCE_ID を読む。資格情報の名前は伏せるためにも読む */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch: FetchLike;
  /** ブラウザを開く。既定は playwright の chromium。**試験は差し替えて、開かないことを見る** */
  readonly launch: () => Promise<Browser>;
  /** リポジトリの直下 */
  readonly root: string;
  /** レポートの置き場。既定は `<root>/workspace/mvp/m1/ui-report`（試験は差し替える） */
  readonly reportDir?: string;
  readonly now: () => Date;
  /** 流す手順。既定は 4 つ（試験用） */
  readonly scenarios?: readonly Scenario[];
  /** 実行したコミットを読む（既定は git。試験は差し替える） */
  readonly readCommit?: (root: string) => string;
}

/**
 * 画面テスト専用インスタンスの接頭辞を読む。
 * 空・形が違う・**`demo` か `e2e` を含む**ものは止める（値は表示しない）。
 */
export function instancePrefixOf(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new E2eError(`インスタンス ID が無い: 環境変数 ${INSTANCE_ENV} に画面テスト専用の ID を渡す`);
  }
  if (!INSTANCE_PATTERN.test(raw) || FORBIDDEN_INSTANCE.test(raw)) {
    throw new E2eError(
      `${INSTANCE_ENV} は画面テスト専用の ID を渡す（demo・e2e を含む ID は触らない。値は表示しない）`,
    );
  }
  for (const suffix of SUFFIXES) {
    const derived = `${raw}-${suffix}`;
    if (!INSTANCE_PATTERN.test(derived) || FORBIDDEN_INSTANCE.test(derived)) {
      throw new E2eError(`${INSTANCE_ENV} から作る ID（${suffix}）が形に合わない（値は表示しない）`);
    }
  }
  return raw;
}

/** 伏せる値・混入を探す値。**宛先のオリジンとホスト、資格情報**である */
export function secretsOf(
  env: Readonly<Record<string, string | undefined>>,
  origin: string,
): readonly SecretValue[] {
  const secrets: SecretValue[] = [{ name: BASE_URL_ENV, value: origin }];
  try {
    const host = new URL(origin).host;
    if (host !== "") secrets.push({ name: "宛先のホスト名", value: host });
  } catch {
    // originOf が URL として読んでいるので、ここへは来ない
  }
  for (const name of CREDENTIAL_ENVS) {
    const value = env[name];
    if (typeof value === "string" && value !== "") secrets.push({ name, value });
  }
  return secrets;
}

/** 実行したコミットを読む。読めなければ空（レポートは「不明」と出す） */
export function readCommit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // 資格情報の値と宛先を、出力から伏せる（`e2e/src/cli.ts` と同じ）
  const values = [...CREDENTIAL_ENVS, BASE_URL_ENV]
    .map((name) => io.env[name])
    .filter((value): value is string => typeof value === "string" && value !== "");
  const out = (line: string): void => io.out(redact(line, values));
  const err = (line: string): void => io.err(redact(line, values));
  try {
    return await run(argv, io, out, err);
  } catch (e) {
    if (e instanceof E2eError) err(`e2e-ui: ${e.message}`);
    else err(`e2e-ui: 予期しない失敗（${errorKind(e)}）`);
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む（URL を位置引数で渡した誤りなど）。コードだけで言い分ける
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

  // **欠落・誤りはブラウザを開く前に落とす**（デモと e2e のデータを壊さない）
  const baseUrl = originOf(io.env[BASE_URL_ENV], BASE_URL_ENV);
  const instanceId = instancePrefixOf(io.env[INSTANCE_ENV]);
  const secrets = secretsOf(io.env, baseUrl);
  const commit = (io.readCommit ?? readCommit)(io.root);
  const reportDir = io.reportDir ?? join(io.root, REPORT_DIR);

  const client = createMusunestClient({ baseUrl, fetch: io.fetch });
  out(`e2e-ui: 画面テストを流す（宛先は出さない。instance=${instanceId}）`);
  const result = await runUi({
    baseUrl,
    instanceId,
    client,
    launch: io.launch,
    reportDir,
    secrets,
    now: io.now,
    commit,
    ...(io.scenarios === undefined ? {} : { scenarios: io.scenarios }),
    out,
    err,
  });

  for (const step of result.steps) {
    if (!step.ok) err(`e2e-ui: NG  ${step.scenario} / ${step.step}: 期待 ${step.expected} ≠ 実際 ${step.actual}`);
  }
  if (result.ok) {
    out(`e2e-ui: OK  ${result.steps.length} 項目がすべて合格した。レポートは ${REPORT_DIR}/`);
    return EXIT_OK;
  }
  err(`e2e-ui: NG  ${result.reason}`);
  return EXIT_NG;
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (url, init) => fetch(url, init),
  launch: () => chromium.launch(),
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  now: () => new Date(),
};

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  void runCli(process.argv.slice(2), defaultIo).then((code) => {
    process.exitCode = code;
  });
}
