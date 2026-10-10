// 工場の納品物（bundle）を受け取り、publish の前までの門を通してから publish する（Issue #248）。
//
// M1b で足す道（M1 の README §3.2 の 4）：**納品物から宣言を取り出し、M1a と同じ静的チェックと publish に渡す**。
// 中身は control-plane に置き、`infra/scripts` には資格情報と Cloudflare への書き込みの薄い呼び出しだけを置く
// （CLAUDE.md・Q20。00-open-questions.md §Q20）。
//
// 5 つの門を、この順に通す。**どれかが落ちたら publish しない**（R2 にも D1 にも書かない）。
//   ① manifest の照合（#247 の verifyBundleManifest。依存の Issues の部品を使う）
//   ② pins の `delivery_bundles` の、**その見本の値とだけ**比較（値が null なら比較を飛ばしたことを返す。
//      追記 1。見本は呼ぶ側が必ず渡す）
//   ③ 確定した仕様（`artifacts/plan.json`）の照合（Issue #335）。**無くてよい**（今の納品物と互換）。
//      あるときは #331 の検査を通し、manifest と検証の結果に載った仕様の SHA-256 が、`plan.json` から
//      計算した値（＝ `confirmation` の SHA）と一致することを確かめる
//   ④ headless の出力の受け入れの判定（#246 の readHeadlessSummary と judgeAcceptance。Q7）
//   ⑤ 納品物の中の宣言（`artifacts/app.spec.yaml`）を読み、静的チェックに通す（spec-engine の normalizeSpec）
//
// 5 つとも通ったら、既存の publish の中身（`publishSpec`。検査 → 正規化 → R2 の 2 個 → D1 の登録）へ、
// **読み取った宣言のバイト列のまま**渡す。**publish の中身をここに複製しない**（判定が 2 か所に分かれると、
// 門を通った宣言と書かれる宣言がずれる）。
//
// Node 側でだけファイルを読む。`node:fs`・`node:path` の型はこの package の tsconfig の types
// （workers-types）に無いので、使う関数の形だけをここに宣言し、**動的**に読む（bundle.ts と同じやり方）。

import type { Diagnostic } from "@musunest/spec-engine";
import { normalizeSpec } from "@musunest/spec-engine";
import { checkPlan, planDigest, PLAN_SHA256_PATTERN, type PlanProblem } from "@musunest/appspec-schema";
import {
  BundleManifestError,
  verifyBundleManifest,
  type BundleManifestVerification,
  type BundleProblem,
} from "./bundle.js";
import {
  DELIVERY_LEVELS,
  judgeAcceptance,
  readHeadlessSummary,
  type AcceptanceDecision,
  type DeliveryLevel,
} from "./headless.js";
import { publishSpec, type PublishDeps, type PublishSuccess } from "./publish.js";

/** 納品物の中の宣言の位置。納品物の直下からの相対 posix パス（`workspace/mvp/m1/README.md` §3.2）。 */
export const BUNDLE_DECLARATION_PATH = "artifacts/app.spec.yaml" as const;

/** 納品物の中の確定した仕様の位置（`04-plan-agent.md` §4・Issue #335）。 */
export const BUNDLE_PLAN_PATH = "artifacts/plan.json" as const;

/** 納品物の中の検証の結果の位置（宣言と、確定した仕様の SHA-256 を結び付ける。§4・R-3）。 */
export const BUNDLE_VERIFICATION_PATH = "artifacts/verification.json" as const;

/** 検証の結果が、確定した仕様の SHA-256 を載せる欄の名前（manifest の欄と同じ名前にする）。 */
export const PLAN_SHA256_FIELD = "plan_sha256" as const;

// ── pins の照合 ───────────────────────────────────────────────────

/** `pins/commandagent.json` の、見本ごとの納品物の欄。 */
export const DELIVERY_BUNDLES_FIELD = "delivery_bundles" as const;

/**
 * 工場の納品物の見本 3 つ（`delivery_bundles` のキーと一致する）。**入口はこのどれかを必ず受け取る**
 * （Issue #248 の追記 1。見本を取り違えても止まらない作りを直した）。fix した一覧なので、
 * pins を読まずに引数を検める。
 */
export const DELIVERY_BUNDLE_SAMPLES = ["warikan", "task-board", "dashboard"] as const;
export type DeliveryBundleSample = (typeof DELIVERY_BUNDLE_SAMPLES)[number];

/** 比較の結果の種類。`skipped` は「その見本に値が入っていないので比較を飛ばした」。 */
export const PIN_COMPARISON_STATUSES = ["matched", "skipped", "mismatch"] as const;
export type PinComparisonStatus = (typeof PIN_COMPARISON_STATUSES)[number];

/** 比較の結果。`samples` は値が入っていた見本（＝引数の見本）、`matchedSamples` は一致した見本（`matched` のときだけ）。 */
export interface PinComparison {
  readonly status: PinComparisonStatus;
  readonly samples: readonly string[];
  readonly matchedSamples: readonly string[];
}

/** pins の欄が読めないときの失敗。呼ぶ側が例外の文言に依存しないよう、原因はコードで分ける。 */
export const PIN_ERROR_CODES = ["pins_malformed"] as const;
export type PinErrorCode = (typeof PIN_ERROR_CODES)[number];

export class BundlePinError extends Error {
  readonly code: PinErrorCode;

  constructor(code: PinErrorCode, message: string) {
    super(message);
    this.name = "BundlePinError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 納品物の manifest の SHA-256 を、`pins/commandagent.json` の `delivery_bundles` の**その見本の値とだけ**比べる
 * （Issue #248 の追記 1。見本を取り違えても止まるようにした）。
 *
 * 見本ごとに値が入る（`manifest_sha256`。まだ工場の納品待ちなら `null`）。**`null` なら比べない。**
 *   - その見本の値が `null` なら `skipped`（比較を飛ばしたことを返す）
 *   - その見本の値と一致すれば `matched`
 *   - 値が入っているのに一致しなければ `mismatch`（**別の見本の値とだけ一致しても mismatch である。**）
 *
 * `delivery_bundles` が写像でない・その見本の欄が写像でない・値が文字列でも `null` でもなければ
 * `BundlePinError`（安全側に倒す）。
 */
export function compareBundleManifestToPins(
  manifestSha256: string,
  pins: unknown,
  sample: DeliveryBundleSample,
): PinComparison {
  const deliveryBundles = isRecord(pins) ? pins[DELIVERY_BUNDLES_FIELD] : undefined;
  if (!isRecord(deliveryBundles)) {
    throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD} が写像でない`);
  }
  const entry = deliveryBundles[sample];
  if (!isRecord(entry)) {
    throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD}.${sample} が写像でない`);
  }
  const value = entry["manifest_sha256"];
  if (value === null) return { status: "skipped", samples: [], matchedSamples: [] };
  if (typeof value !== "string") {
    throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD}.${sample}.manifest_sha256 が文字列でない`);
  }
  return value === manifestSha256
    ? { status: "matched", samples: [sample], matchedSamples: [sample] }
    : { status: "mismatch", samples: [sample], matchedSamples: [] };
}

// ── 納品物の中のファイルを読む（Node 側）────────────────────────

interface NodeFs {
  readFileSync(path: string): Uint8Array;
}
interface NodePath {
  join(...parts: readonly string[]): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const decoder = new TextDecoder();

/** 納品物の直下からの相対 posix パスのファイルを、UTF-8 の文字列として読む。 */
async function readBundleFile(directory: string, relative: string): Promise<string> {
  const [fs, path] = (await Promise.all([importUntyped("node:fs"), importUntyped("node:path")])) as [NodeFs, NodePath];
  const bytes = fs.readFileSync(path.join(directory, ...relative.split("/")));
  return decoder.decode(bytes);
}

const readBundleDeclaration = (directory: string): Promise<string> =>
  readBundleFile(directory, BUNDLE_DECLARATION_PATH);

/**
 * 検証の結果（`artifacts/verification.json`）が載せる、確定した仕様の SHA-256 を読む（Issue #335）。
 * 読めない・JSON でない・欄が無い・形が違えば `null`（門は「一致しない」として断る）。
 */
async function readVerificationPlanSha256(directory: string): Promise<string | null> {
  let source: string;
  try {
    source = await readBundleFile(directory, BUNDLE_VERIFICATION_PATH);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const value = parsed[PLAN_SHA256_FIELD];
  return typeof value === "string" && PLAN_SHA256_PATTERN.test(value) ? value : null;
}

// ── 公開の入口 ────────────────────────────────────────────────────

/** 止まった段。①manifest ②pins ③plan ④acceptance ⑤declaration、そして既存の publish。 */
export const BUNDLE_PUBLISH_STAGES = ["manifest", "pins", "plan", "acceptance", "declaration", "publish"] as const;
export type BundlePublishStage = (typeof BUNDLE_PUBLISH_STAGES)[number];

/** publish の中身に渡す口（`publishSpec` と同じ。書き込みは偽の口で差し替えられる）。 */
export type BundlePublishDeps = PublishDeps;

export interface BundlePublishRequest {
  /** 工場の納品物のディレクトリ（直下に `bundle-manifest.json`） */
  readonly bundleDirectory: string;
  /** headless の stdout の全文（前の行は人向けの出力。最終行が v1 の要約） */
  readonly summaryStdout: string;
  /** `pins/commandagent.json` を JSON として読んだ値（`delivery_bundles` のこの見本の値を読む） */
  readonly pins: unknown;
  /** どの見本か（`delivery_bundles` のキー。pins の比較はこの見本の値とだけ行う） */
  readonly sample: DeliveryBundleSample;
  /** 宣言を使うインスタンスの ID */
  readonly instanceId: string;
  /** 既存インスタンスの宣言を、**はっきり差し替える**（`publishSpec` と同じ。既定は `false`） */
  readonly replace?: boolean;
}

export interface BundlePublishSuccess {
  readonly ok: true;
  /** 納品物の manifest（`bundle-manifest.json`）自身のバイト列の SHA-256 */
  readonly manifestSha256: string;
  /** 受け入れの判定に使った水準（manifest の `artifact_level`） */
  readonly level: DeliveryLevel;
  /** pins の照合の結果（`matched` か `skipped`） */
  readonly pin: PinComparison;
  /** 確定した仕様（`plan.json`）の SHA-256。**無い納品物は `null`**（今の納品物と互換） */
  readonly planSha256: string | null;
  /** 既存の publish の中身の結果 */
  readonly publish: PublishSuccess;
}

/** 確定した仕様（`plan.json`）を断る理由のコード。呼ぶ側が例外の文言に依存しないように分ける。 */
export const BUNDLE_PLAN_FAILURE_CODES = [
  /** `plan.json` を読めない・JSON でない */
  "plan_unreadable",
  /** #331 の検査に通らない（形・ID の参照・了承・解決） */
  "plan_invalid",
  /** `confirmation` の SHA-256 が、いまの仕様のそれと一致しない（確認が失効している） */
  "confirmation_expired",
  /** manifest か検証の結果に載った仕様の SHA-256 が、`plan.json` から計算した値と一致しない */
  "plan_sha256_mismatch",
] as const;
export type BundlePlanFailureCode = (typeof BUNDLE_PLAN_FAILURE_CODES)[number];

/** 確定した仕様を断った理由。`problems` は `plan_invalid` のときだけ（#331 の検査が見つけたもの）。 */
export interface BundlePlanFailure {
  readonly code: BundlePlanFailureCode;
  readonly problems: readonly PlanProblem[];
}

export interface BundlePublishFailure {
  readonly ok: false;
  readonly stage: BundlePublishStage;
  /** 人が読む説明。**資格情報・ホスト名・Account ID・R2 のキー・URL を含めない** */
  readonly message: string;
  /** 静的チェックの診断（段 `declaration` と `publish` のときだけ） */
  readonly diagnostics: readonly Diagnostic[];
  /** manifest の食い違い（段 `manifest` のときだけ） */
  readonly problems: readonly BundleProblem[];
  /** pins の照合の結果（段 `pins` 以降のときだけ） */
  readonly pin: PinComparison | null;
  /** 確定した仕様の検査の失敗（段 `plan` のときだけ）。それ以外は `null` */
  readonly plan: BundlePlanFailure | null;
  /** 受け入れの判定（段 `acceptance` 以降のときだけ） */
  readonly acceptance: AcceptanceDecision | null;
}

export type BundlePublishResult = BundlePublishSuccess | BundlePublishFailure;

const MESSAGES = {
  manifest_unreadable: "納品物の manifest を読めない、または形が違う（publish しない）",
  manifest_problems: "納品物の manifest の照合に通らない（publish しない）",
  pins_malformed: "pins の delivery_bundles を読めない（publish しない）",
  pins_mismatch: "manifest の SHA-256 が pins の値と一致しない（publish しない）",
  level_unknown: "納品物の artifact_level が L2・L3・L4 のいずれでもない（受け入れを判定できない）",
  acceptance: "headless の出力が受け入れの条件を満たさない（publish しない）",
  plan_unreadable: `納品物の中の確定した仕様（${BUNDLE_PLAN_PATH}）を読めない（publish しない）`,
  plan_invalid: "確定した仕様が検査に通らない（publish しない）",
  confirmation_expired: "確定した仕様の確認が失効している（仕様の SHA-256 と confirmation が一致しない）",
  plan_sha256_mismatch: `確定した仕様の SHA-256 が、manifest と検証の結果（${BUNDLE_VERIFICATION_PATH}）に載った値と一致しない（publish しない）`,
  declaration_unreadable: `納品物の中の宣言（${BUNDLE_DECLARATION_PATH}）を読めない（publish しない）`,
  declaration: "宣言が静的チェックに通らない（publish しない）",
} as const;

const fail = (
  stage: BundlePublishStage,
  message: string,
  fields: {
    readonly diagnostics?: readonly Diagnostic[];
    readonly problems?: readonly BundleProblem[];
    readonly pin?: PinComparison;
    readonly plan?: BundlePlanFailure;
    readonly acceptance?: AcceptanceDecision;
  } = {},
): BundlePublishFailure => ({
  ok: false,
  stage,
  message,
  diagnostics: fields.diagnostics ?? [],
  problems: fields.problems ?? [],
  pin: fields.pin ?? null,
  plan: fields.plan ?? null,
  acceptance: fields.acceptance ?? null,
});

const isDeliveryLevel = (value: string): value is DeliveryLevel => (DELIVERY_LEVELS as readonly string[]).includes(value);

/**
 * 納品物のディレクトリと headless の出力を受け取り、5 つの門（manifest の照合・pins との比較・
 * 確定した仕様の照合・受け入れの判定・宣言の静的チェック）を通したものだけを、既存の publish の中身
 * （`publishSpec`）へ渡す。
 *
 * **どれかが落ちたら publish しない。** 段（`failure.stage`）で止まった門が分かる。`pins` の段は、
 * **その見本の値**が入っているのに一致しなかったときである（その値が `null` の `skipped` は通る）。
 * `plan` の段は、納品物に確定した仕様（`plan.json`）があるのに、#331 の検査・確認の SHA・manifest と
 * 検証の結果の SHA-256 のどれかが通らなかったときである（**`plan.json` が無ければこの段は飛ぶ**）。
 *
 * 例外を外へ出さない（門の失敗は結果にする）。呼ぶ側（CLI）は、結果をそのまま安全に出せる。
 */
export async function publishBundle(
  deps: BundlePublishDeps,
  request: BundlePublishRequest,
): Promise<BundlePublishResult> {
  // ① manifest の照合（依存の Issue #247 の部品）。ファイル単位の食い違いは problems に並ぶ
  let verified: BundleManifestVerification;
  try {
    verified = await verifyBundleManifest(request.bundleDirectory);
  } catch (error) {
    const message = error instanceof BundleManifestError ? error.message : MESSAGES.manifest_unreadable;
    return fail("manifest", message);
  }
  if (verified.problems.length > 0) {
    return fail("manifest", MESSAGES.manifest_problems, { problems: verified.problems });
  }

  // ② pins の delivery_bundles の、**その見本の値とだけ**比較する（その値が null なら飛ばす）
  let pin: PinComparison;
  try {
    pin = compareBundleManifestToPins(verified.manifestSha256, request.pins, request.sample);
  } catch (error) {
    return fail("pins", error instanceof BundlePinError ? error.message : MESSAGES.pins_malformed);
  }
  if (pin.status === "mismatch") return fail("pins", MESSAGES.pins_mismatch, { pin });

  // ③ 確定した仕様（plan.json）があれば、#331 の検査と SHA-256 の照合を行う（Issue #335）。
  //    **無くてよい**（今の納品物と互換）。manifest の `files` に載っていれば、① で存在とバイト列が
  //    確かめられている。あるときは、manifest と検証の結果に載った仕様の SHA-256 のどちらも、
  //    plan.json から計算した値（＝ confirmation の SHA）と一致しなければ断る。
  const hasPlan = verified.manifest.files.some((file) => file.path === BUNDLE_PLAN_PATH);
  let planSha256: string | null = null;
  if (hasPlan) {
    let plan: unknown;
    try {
      plan = JSON.parse(await readBundleFile(request.bundleDirectory, BUNDLE_PLAN_PATH)) as unknown;
    } catch {
      return fail("plan", MESSAGES.plan_unreadable, { pin, plan: { code: "plan_unreadable", problems: [] } });
    }

    // #331 の検査（形・ID の参照・了承・解決）。**別の誤りは別の値**で返るので、そのまま載せる
    const planProblems = checkPlan(plan);
    if (planProblems.length > 0) {
      return fail("plan", MESSAGES.plan_invalid, { pin, plan: { code: "plan_invalid", problems: planProblems } });
    }

    // 確認の SHA が、いまの仕様のそれと一致しなければ「確認が失効している」
    planSha256 = await planDigest(plan);
    const confirmation = isRecord(plan) ? plan["confirmation"] : undefined;
    const confirmationSha = isRecord(confirmation) ? confirmation["sha256"] : undefined;
    if (confirmationSha !== planSha256) {
      return fail("plan", MESSAGES.confirmation_expired, { pin, plan: { code: "confirmation_expired", problems: [] } });
    }

    // manifest と検証の結果に載った仕様の SHA-256 が、**どちらも**同じ値でなければ断る
    const recorded = [verified.planSha256, await readVerificationPlanSha256(request.bundleDirectory)];
    if (recorded.some((value) => value !== planSha256)) {
      return fail("plan", MESSAGES.plan_sha256_mismatch, { pin, plan: { code: "plan_sha256_mismatch", problems: [] } });
    }
  }

  // ④ headless の出力の受け入れの判定（依存の Issue #246。Q7。水準は manifest の artifact_level）
  const level = verified.manifest.artifact_level;
  if (!isDeliveryLevel(level)) return fail("acceptance", MESSAGES.level_unknown, { pin });
  const read = readHeadlessSummary(request.summaryStdout);
  if (!read.ok) return fail("acceptance", read.message, { pin });
  const acceptance = judgeAcceptance(read.summary, level);
  if (!acceptance.accepted) return fail("acceptance", MESSAGES.acceptance, { pin, acceptance });

  // ⑤ 納品物の中の宣言を読み、静的チェックに通す（spec-engine。publish の中身と同じ判定を使う）
  let source: string;
  try {
    source = await readBundleDeclaration(request.bundleDirectory);
  } catch {
    return fail("declaration", MESSAGES.declaration_unreadable, { pin, acceptance });
  }
  const checked = await normalizeSpec(source);
  if (!checked.ok) return fail("declaration", MESSAGES.declaration, { pin, acceptance, diagnostics: checked.diagnostics });

  // 5 つとも通った。既存の publish の中身へ、読み取った宣言のまま渡す
  const published = await publishSpec(deps, {
    source,
    instanceId: request.instanceId,
    ...(request.replace === true ? { replace: true } : {}),
  });
  if (!published.ok) {
    return fail("publish", published.failure.message, { pin, acceptance, diagnostics: published.failure.diagnostics });
  }
  return { ok: true, manifestSha256: verified.manifestSha256, level, pin, planSha256, publish: published };
}
