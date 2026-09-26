// publish-bundle — 工場の納品物と headless の出力を、4 つの門を通してから publish する入口（Issue #248）。
//
//   pnpm exec tsx infra/scripts/publish-bundle.ts \
//     --env <dev|staging> --instance <id> --bundle <dir> --summary <file>
//
// 中身（manifest の照合 → pins の比較 → 受け入れの判定 → 宣言の静的チェック → publish）は
// @musunest/control-plane に置いてある（bundle-publish.ts。Q20・CLAUDE.md「依存の向き」）。
// **ここが持つのは、引数の解釈・納品物と summary と pins の読取・環境変数からの資格情報の取得・
// Cloudflare adapter の組立・安全な結果表示だけ**である。**書き込みは既存の publish の中身（publishSpec）を
// そのまま使う**（差し替えは `--replace`）。CLI 側に判定を複製しない。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」。既存の publish と同じ）────────
//
//   - **production へは書き込みの前に断る。** --env は dev / staging だけ。CLOUDFLARE_ACCOUNT_ID が
//     production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指していても、API を呼ぶ前に止める
//   - 出すのは、成功なら **manifest SHA・版・原本 SHA・インスタンス ID・水準・pins の状態**、
//     失敗なら **段と、値を持たない説明**だけ。**トークン・Account ID・バケット名・R2 のキー・URL・
//     ホスト名を出さない。** 例外の文言も出さない（想定外の例外は種別だけ）。Cloudflare の API の
//     エラー本文も出さない
//
// ── 4 つの門（どれかが落ちたら publish しない）──────────────────────────────
//
//   ① 納品物の manifest の照合（bundle-manifest.json の全ファイルの SHA-256 と大きさ）
//   ② pins の `delivery_bundles` の値との比較（値が null の見本は飛ばす）
//   ③ headless の出力（summary の最終行の v1 の JSON）の受け入れの判定（Q7）
//   ④ 納品物の中の宣言（artifacts/app.spec.yaml）の静的チェック
//   4 つとも通ると、読み取った宣言のまま既存の publish の中身へ渡す。
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BUNDLE_DECLARATION_PATH,
  publishBundle,
  type BundlePublishResult,
} from "../../packages/control-plane/src/index.ts";
import {
  DATA_API_CONFIG,
  EXIT_NG,
  EXIT_OK,
  INSTANCE_PATTERN,
  PublishError,
  PUBLISHABLE_ENVS,
  REQUEST_TIMEOUT_MS,
  cloudflareRegistryExecutor,
  cloudflareSpecReader,
  cloudflareSpecWriter,
  readCredentials,
  readPublishTarget,
  type CliIo,
} from "./publish.ts";
import { ENVS, type Env } from "./sync-bindings.ts";

/** `pins/commandagent.json`（リポジトリルートからの相対パス）。納品物の manifest の照合先。 */
export const PINS_FILE = "pins/commandagent.json" as const;

const USAGE = `usage: pnpm exec tsx infra/scripts/publish-bundle.ts --env <${PUBLISHABLE_ENVS.join("|")}> --instance <id> --bundle <dir> --summary <file>

  --env <env>        ${PUBLISHABLE_ENVS.join(" / ")} だけ。${ENVS.filter((e) => !PUBLISHABLE_ENVS.includes(e)).join(" / ")} は書き込みの前に断る
  --instance <id>    宣言を使うインスタンスの ID（${INSTANCE_PATTERN.source}）
  --bundle <dir>     工場の納品物のディレクトリ（直下に bundle-manifest.json）
  --summary <file>   headless の stdout の全文（--summary-json の最終行を含む）を保存したファイル
  --replace          既存インスタンスの宣言を、**はっきり差し替える**（既定は差し替えない）

① manifest の照合 → ② pins の delivery_bundles との比較 → ③ headless の出力の受け入れの判定 →
④ 納品物の中の宣言（${BUNDLE_DECLARATION_PATH}）の静的チェック、の 4 つがすべて通ったときだけ、
既存の publish の中身（publishSpec）へ渡す。どれかが落ちれば、R2 にも D1 にも書かない。
${PINS_FILE} の delivery_bundles を使う（値が null の見本は比較を飛ばす）。
資格情報は環境変数 CLOUDFLARE_API_TOKEN（D1 Write・Workers R2 Storage: Edit）と CLOUDFLARE_ACCOUNT_ID（アカウント①）。
成功は exit ${EXIT_OK}、失敗は exit ${EXIT_NG}。トークン・Account ID・バケット名・R2 のキー・URL・ホスト名は出さない。`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof PublishError) {
      io.err(`publish-bundle: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（URL・Account ID を含み得る）。種別だけ出す
      const kind = e instanceof Error ? e.name : typeof e;
      const code = (e as { code?: unknown }).code;
      io.err(`publish-bundle: 予期しない失敗（${kind}${typeof code === "string" ? ` ${code}` : ""}）`);
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
        bundle: { type: "string" },
        summary: { type: "string" },
        replace: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む。コードだけで言い分ける（publish.ts と同じ）
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
  const bundleArg = values.bundle;
  if (bundleArg === undefined || bundleArg === "") throw new PublishError(`--bundle が無い（納品物のディレクトリ）\n${USAGE}`);
  const summaryArg = values.summary;
  if (summaryArg === undefined || summaryArg === "") throw new PublishError(`--summary が無い（headless の stdout のファイル）\n${USAGE}`);
  // 差し替えは既定で off。**指定が無いときの挙動を変えない**（既存インスタンスの宣言は暗黙に差し替えない）
  const replace = values.replace === true;

  const bundleDirectory = resolvePath(io, bundleArg);
  const summaryPath = resolvePath(io, summaryArg);
  const summaryStdout = readText(io, summaryPath, "summary を読めない（--summary のパス。値は表示しない）");
  const pins = readPins(io);
  const target = readPublishTarget(readConfig(io), env);
  const credentials = readCredentials(io.env);

  io.out(
    `publish-bundle: env=${env} の R2（BUNDLES）と D1（CONTROL_DB）へ、4 つの門を通した納品物を置く` +
      (replace ? "（--replace: 既存インスタンスの宣言を差し替える）" : ""),
  );

  const result = await publishBundle(
    {
      specs: cloudflareSpecWriter(io, credentials, target.bucketName),
      registry: cloudflareRegistryExecutor(io, credentials, target.databaseId),
      // 差し替えのときだけ、前の原本を読む口を渡す（差し替えない経路に R2 の読み取りを足さない）
      ...(replace ? { readSpec: cloudflareSpecReader(io, credentials, target.bucketName) } : {}),
    },
    { bundleDirectory, summaryStdout, pins, instanceId, ...(replace ? { replace: true } : {}) },
  );
  return report(io, env, result);
}

/** 引数のパスを決める。リポジトリの直下からの相対はそれを基準にし、絶対パスはそのまま使う。 */
function resolvePath(io: CliIo, path: string): string {
  return isAbsolute(path) ? path : resolve(io.root, path);
}

function readText(io: CliIo, path: string, message: string): string {
  try {
    return io.readFile(path);
  } catch {
    throw new PublishError(message);
  }
}

/** pins を読んで JSON として解釈する。読めなければ、API を呼ぶ前に止める。 */
function readPins(io: CliIo): unknown {
  const text = readText(io, join(io.root, PINS_FILE), `${PINS_FILE} が読めない`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublishError(`${PINS_FILE} が JSON として読めない`);
  }
}

function readConfig(io: CliIo): string {
  try {
    return io.readFile(join(io.root, DATA_API_CONFIG));
  } catch {
    throw new PublishError(`${DATA_API_CONFIG} が読めない`);
  }
}

/** 結果を安全に出す。診断は #97 の 1 行（`<宣言>:<行>:<列>: <コード>: <説明>`）で出す。 */
function report(io: CliIo, env: Env, result: BundlePublishResult): number {
  if (result.ok) {
    io.out(
      `publish-bundle: OK  env=${env}: manifest SHA ${result.manifestSha256} / 版 ${result.publish.app.schemaVersion}` +
        ` / 原本 SHA ${result.publish.app.sourceSha256} / インスタンス ${result.publish.instance.instanceId}` +
        ` / 水準 ${result.level} / pins ${result.pin.status}`,
    );
    if (result.publish.replacedSourceSha256 !== null) {
      io.out(
        `publish-bundle: 差し替え  env=${env}: 前の原本 SHA ${result.publish.replacedSourceSha256} → 後の原本 SHA ${result.publish.app.sourceSha256}` +
          `（インスタンス ${result.publish.instance.instanceId}）`,
      );
    }
    return EXIT_OK;
  }
  io.err(`publish-bundle: NG  ${result.message}`);
  for (const diagnostic of result.diagnostics) {
    io.err(`  ${BUNDLE_DECLARATION_PATH}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code}: ${diagnostic.message}`);
  }
  for (const problem of result.problems) {
    io.err(`  ${problem.path}: ${problem.kind}: ${problem.detail}`);
  }
  if (result.stage === "publish") {
    io.err(
      `publish-bundle: NG  env=${env}（段 ${result.stage}）。書き込みは一部だけ済んでいる可能性がある。同じ入力で再実行する`,
    );
  } else {
    io.err(`publish-bundle: NG  env=${env}（段 ${result.stage}）。4 つの門のどれかで止めたので、書き込みはしていない`);
  }
  return EXIT_NG;
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
