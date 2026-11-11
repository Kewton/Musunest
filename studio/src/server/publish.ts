// 結果の画面から staging へ公開する（studio-s1.md §6・Issue #868 の目的・1〜7）。
//
// **公開は必ず門（publishBundle）を通す。** 工房は Cloudflare の adapter も門の判定も持たず、手元の
// 公開の入口（`infra/scripts/publish-bundle.ts`）を子プロセスで呼ぶだけである。
//
//   - env は staging に固定する（引数を組む関数は env を受け取らない）
//   - インスタンスは `studio-<YYYYMMDDHHmmss>` だけ（画面から決めさせない。`instance-id.ts`）
//   - 既存の見本ではなく、利用者のアプリとして出す（`--user-app`）
//   - partial は所有者の了承の記録（`approval.ts`）を `--approval` で渡したときだけ公開する
//   - 子に渡す環境は Cloudflare の変数と実行に要る最小のものだけ（LLM の鍵は渡さない）
//   - 子の出力は `redact.ts` で伏せてから保存する
//
// 保存するのは、成功ならインスタンス ID・水準・manifest の SHA-256、失敗なら止まった段と値を持たない
// 説明だけである（`<home>/jobs/<id>/publish.json`）。standard output・記録にオリジンは出さない。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readHeadlessSummary,
  verifyBundleManifest,
} from "@musunest/control-plane";
import {
  ApprovalRecordError,
  approvalFilePath,
  buildApprovalRecord,
  readApprovalFile,
  writeApprovalFile,
  type ApprovalRecord,
} from "./approval.js";
import { stampInstanceId } from "./instance-id.js";
import { ApiError } from "./jobs.js";
import { redactSecrets } from "./redact.js";
import type { JobState, ResultVerdict } from "./runner.js";

/** 公開先の env。**staging に固定する**（production・dev へは出さない）。 */
export const PUBLISH_ENV = "staging" as const;

/** 工房が子プロセスで起こす公開の入口（リポジトリの根からの相対パス）。 */
export const PUBLISH_CHILD_SCRIPT = "infra/scripts/publish-bundle.ts" as const;

/** ジョブの置き場所に保存する公開の結果のファイル名。 */
export const PUBLISH_RESULT_FILE = "publish.json" as const;

/** 工場が置く要約のファイル名（`factory-child.ts` の `FACTORY_SUMMARY_FILE` と同じ）。 */
export const PUBLISH_SUMMARY_FILE = "summary.json" as const;

/**
 * 公開の子に渡してよい環境変数。**Cloudflare の 2 つの変数と production の Account ID だけ**を
 * 工房の環境から写し、LLM の鍵（OPENAI_API_KEY・JEV_API_KEY など）は渡さない。
 */
export const PUBLISH_CHILD_ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID_PROD",
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
] as const;

/** 子へ渡す環境を作る（定義されている鍵だけを写す）。 */
export function publishChildEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const key of PUBLISH_CHILD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") childEnv[key] = value;
  }
  return childEnv;
}

export interface PublishArgsInput {
  /** `studio-<YYYYMMDDHHmmss>`（`instance-id.ts` が作る） */
  readonly instanceId: string;
  /** 納品物のディレクトリ（直下に `bundle-manifest.json`） */
  readonly bundleDir: string;
  /** headless の要約を保存したファイル */
  readonly summaryFile: string;
  /** 了承の記録のファイル（partial のときだけ） */
  readonly approvalFile?: string;
}

/**
 * 公開の入口に渡す引数を組む。**env は受け取らない**——公開先は staging に固定である。
 * full の公開は `--approval` を含まず、partial の公開だけが了承のファイルを渡す。
 */
export function buildPublishArgs(input: PublishArgsInput): readonly string[] {
  const args = [
    "--env",
    PUBLISH_ENV,
    "--instance",
    input.instanceId,
    "--user-app",
    "--bundle",
    input.bundleDir,
    "--summary",
    input.summaryFile,
  ];
  return input.approvalFile === undefined ? args : [...args, "--approval", input.approvalFile];
}

/** 公開の子に渡す入力。 */
export interface PublishChildInput {
  /** `publish-bundle` に渡す引数（`tsx` とスクリプトのパスは含めない） */
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  /** リポジトリの根（`pnpm exec tsx infra/scripts/...` をここで起こす） */
  readonly cwd: string;
}

/** 公開の子の結果。 */
export interface PublishChildResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 公開の子を起こす口（試験は偽物を差し込む。Cloudflare を呼ばない）。 */
export type PublishChildRunner = (input: PublishChildInput) => Promise<PublishChildResult>;

/** 出力の上限（壊れた子が無限に書いても、保存が膨らまないようにする）。 */
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;

/**
 * 本物の公開の子を起こす。工房はリポジトリの checkout の中から起動している前提である
 * （`infra/scripts` の入口を tsx で起こすため。README にも書く）。
 */
export function runPublishChild(input: PublishChildInput): Promise<PublishChildResult> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn("pnpm", ["exec", "tsx", PUBLISH_CHILD_SCRIPT, ...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolveResult({ code: 127, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolveResult({ code, stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CHILD_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CHILD_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/** 公開が成功したときの記録。 */
export interface PublishSuccessRecord {
  readonly ok: true;
  /** `studio-<YYYYMMDDHHmmss>` */
  readonly instanceId: string;
  /** 納品物の水準（manifest の `artifact_level`） */
  readonly level: string;
  /** 照合した納品物の manifest の SHA-256 */
  readonly manifestSha256: string;
  /** 画面が「開いて試す」に使う経路（オリジンは含めない） */
  readonly path: string;
}

/** 公開が失敗したときの記録。**段と、値を持たない説明だけ**を持つ。 */
export interface PublishFailureRecord {
  readonly ok: false;
  /** 止まった門の段（`publish-bundle` の出力から読む）。読めなければ null */
  readonly stage: string | null;
  /** 伏せた説明（URL・Account ID・workers.dev を含めない） */
  readonly message: string;
}

export type PublishRecord = PublishSuccessRecord | PublishFailureRecord;

/** 公開の対象のジョブ（routes.ts が `JobView` から作る）。 */
export interface PublishJob {
  readonly id: string;
  readonly state: JobState;
  readonly verdict: ResultVerdict | null;
}

export interface StudioPublishOptions {
  /** 記録の置き場所（ジョブは `<home>/jobs/<id>`） */
  readonly home: string;
  /** 工房の環境（子へは allowlist だけを渡す） */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** いまの時刻（試験は固定する） */
  readonly now?: () => number;
  /** 子を起こす口（試験は偽物を差し込む） */
  readonly runChild?: PublishChildRunner;
  /** リポジトリの根（既定はこの file から 3 つ上） */
  readonly repoRoot?: string;
}

const JOB_ID = /^[A-Za-z0-9-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defaultRepoRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 保存した公開の結果を読む（壊れていれば null）。 */
function readPublishRecord(path: string): PublishRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (
    parsed["ok"] === true &&
    typeof parsed["instanceId"] === "string" &&
    typeof parsed["level"] === "string" &&
    typeof parsed["manifestSha256"] === "string" &&
    typeof parsed["path"] === "string"
  ) {
    return {
      ok: true,
      instanceId: parsed["instanceId"],
      level: parsed["level"],
      manifestSha256: parsed["manifestSha256"],
      path: parsed["path"],
    };
  }
  const stage = parsed["stage"];
  const message = parsed["message"];
  if (parsed["ok"] === false && (stage === null || typeof stage === "string") && typeof message === "string") {
    return { ok: false, stage, message };
  }
  return null;
}

/** 子の出力から、止まった段を読む（`publish-bundle: NG ... （段 manifest）`）。 */
function readStage(output: string): string | null {
  const match = /段\s+([a-z_]+)/u.exec(output);
  return match?.[1] ?? null;
}

/**
 * 子の出力から、値を持たない説明を作る。**`publish-bundle:` で始まる行だけ**を拾い、
 * URL・Account ID・workers.dev を伏せる（パスや、資格情報らしい行をそのまま保存しない）。
 */
function readFailureMessage(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("publish-bundle:"));
  if (lines.length === 0) return "公開の子が失敗した（値を含まない説明は無い）";
  const message = redactSecrets(lines.join(" / "));
  return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
}

/**
 * 工房の公開。ジョブの置き場所（`<home>/jobs/<id>`）の納品物を、公開の入口（子プロセス）へ渡す。
 * **門の判定は持たない**——partial の受け入れは子の `publish-bundle` が行う。
 */
export class StudioPublisher {
  private readonly home: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly clock: () => number;
  private readonly runChild: PublishChildRunner;
  private readonly repoRoot: string;

  constructor(options: StudioPublishOptions) {
    this.home = options.home;
    this.env = options.env;
    this.clock = options.now ?? (() => Date.now());
    this.runChild = options.runChild ?? runPublishChild;
    this.repoRoot = options.repoRoot ?? defaultRepoRoot();
  }

  /** ジョブの置き場所。 */
  jobDirectory(jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new ApiError(404, "not_found", "ジョブの ID が壊れている");
    return join(this.home, "jobs", jobId);
  }

  /** 納品物の manifest の SHA-256 と水準（control-plane の照合の関数で出す）。 */
  async manifest(jobId: string): Promise<{ readonly sha256: string; readonly level: string }> {
    try {
      const verified = await verifyBundleManifest(this.jobDirectory(jobId));
      return { sha256: verified.manifestSha256, level: verified.manifest.artifact_level };
    } catch {
      throw new ApiError(409, "manifest-unreadable", "納品物の manifest を読めない");
    }
  }

  /** 保存した公開の結果（まだ公開していなければ null）。 */
  storedResult(jobId: string): PublishRecord | null {
    return readPublishRecord(join(this.jobDirectory(jobId), PUBLISH_RESULT_FILE));
  }

  /**
   * partial の結果に、所有者の了承を記録する。**画面から送られた SHA が、いまの納品物の SHA と
   * 一致するときだけ**書く。記録には manifest の SHA と要約の run_id を入れる。
   */
  async approve(job: PublishJob, manifestSha256: string): Promise<ApprovalRecord> {
    this.requireResult(job);
    if (job.verdict !== "partial") {
      throw new ApiError(409, "not-partial", "partial の結果だけが了承できる");
    }
    const directory = this.jobDirectory(job.id);
    const current = await this.manifest(job.id);
    if (manifestSha256 !== current.sha256) {
      throw new ApiError(409, "approval-sha-mismatch", "画面の SHA がいまの納品物と違う");
    }
    const runId = this.summaryRunId(directory);
    const record = buildApprovalRecord({
      manifestSha256: current.sha256,
      runId,
      approvedAt: new Date(this.clock()).toISOString(),
    });
    try {
      writeApprovalFile(approvalFilePath(directory), record);
    } catch (error) {
      if (error instanceof ApprovalRecordError) {
        throw new ApiError(409, "approval-invalid", "了承の記録を書けない");
      }
      throw error;
    }
    return record;
  }

  /**
   * 結果のジョブを staging へ公開する。**同じジョブの 2 回目の公開は 409**（成功したら公開済み）。
   * partial は、いまの納品物に一致する了承の記録があるときだけ公開する。
   */
  async publish(job: PublishJob): Promise<PublishRecord> {
    this.requireResult(job);
    if (job.verdict === "none") {
      throw new ApiError(409, "nothing-to-publish", "作れなかった結果は公開できない");
    }
    const existing = this.storedResult(job.id);
    if (existing?.ok === true) {
      throw new ApiError(409, "already-published", "このジョブは公開済みである");
    }

    const directory = this.jobDirectory(job.id);
    const current = await this.manifest(job.id);

    let approvalFile: string | undefined;
    if (job.verdict === "partial") {
      const path = approvalFilePath(directory);
      if (!existsSync(path)) {
        throw new ApiError(409, "approval-required", "partial の公開には所有者の了承が要る");
      }
      let approval: { readonly manifestSha256: string };
      try {
        approval = readApprovalFile(path);
      } catch (error) {
        if (error instanceof ApprovalRecordError) {
          throw new ApiError(409, "approval-invalid", "了承の記録が読めない");
        }
        throw error;
      }
      if (approval.manifestSha256 !== current.sha256) {
        throw new ApiError(409, "approval-stale", "了承の SHA がいまの納品物と違う");
      }
      approvalFile = path;
    }

    this.assertNotProduction();

    const instanceId = stampInstanceId(new Date(this.clock()));
    const args = buildPublishArgs({
      instanceId,
      bundleDir: directory,
      summaryFile: join(directory, PUBLISH_SUMMARY_FILE),
      ...(approvalFile === undefined ? {} : { approvalFile }),
    });
    const result = await this.runChild({
      args,
      env: publishChildEnv(this.env),
      cwd: this.repoRoot,
    });

    if (result.code === 0) {
      const record: PublishSuccessRecord = {
        ok: true,
        instanceId,
        level: current.level,
        manifestSha256: current.sha256,
        path: `/apps/${instanceId}`,
      };
      this.writeResult(directory, record);
      return record;
    }

    const failure: PublishFailureRecord = {
      ok: false,
      stage: readStage(`${result.stdout}\n${result.stderr}`),
      message: readFailureMessage(`${result.stdout}\n${result.stderr}`),
    };
    this.writeResult(directory, failure);
    return failure;
  }

  /** 結果が出ているジョブだけを扱う。 */
  private requireResult(job: PublishJob): void {
    if (job.state !== "result" || job.verdict === null) {
      throw new ApiError(409, "not-ready", "結果が出ていないジョブは公開できない");
    }
  }

  /** 要約の run_id を読む（了承の記録に入れる）。 */
  private summaryRunId(directory: string): string {
    let text: string;
    try {
      text = readFileSync(join(directory, PUBLISH_SUMMARY_FILE), "utf8");
    } catch {
      throw new ApiError(409, "summary-unreadable", "結果の要約を読めない");
    }
    const read = readHeadlessSummary(text);
    if (!read.ok || read.summary.runId === null || read.summary.runId === "") {
      throw new ApiError(409, "summary-invalid", "結果の要約から run_id を読めない");
    }
    return read.summary.runId;
  }

  /** production のアカウントが渡っていたら、子を起こす前に断る。 */
  private assertNotProduction(): void {
    const account = this.env["CLOUDFLARE_ACCOUNT_ID"];
    const production = this.env["CLOUDFLARE_ACCOUNT_ID_PROD"];
    if (
      account !== undefined &&
      account !== "" &&
      production !== undefined &&
      production !== "" &&
      account.toLowerCase() === production.toLowerCase()
    ) {
      throw new ApiError(409, "production-account", "production のアカウントへは公開しない");
    }
  }

  /** 結果を保存する（途中の書きかけを読ませないよう、仮ファイルから rename する）。 */
  private writeResult(directory: string, record: PublishRecord): void {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, PUBLISH_RESULT_FILE);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    // 同じディレクトリの中で rename する（別の装置をまたがない）
    renameSync(temporary, path);
  }
}

/** 工房の公開を作る。 */
export function createStudioPublisher(options: StudioPublishOptions): StudioPublisher {
  return new StudioPublisher(options);
}
