// 工場の納品物（bundle）を受け取り、publish の前までの門を通してから publish する（Issue #248）。
//
// M1b で足す道（M1 の README §3.2 の 4）：**納品物から宣言を取り出し、M1a と同じ静的チェックと publish に渡す**。
// 中身は control-plane に置き、`infra/scripts` には資格情報と Cloudflare への書き込みの薄い呼び出しだけを置く
// （CLAUDE.md・Q20。00-open-questions.md §Q20）。
//
// 4 つの門を、この順に通す。**どれかが落ちたら publish しない**（R2 にも D1 にも書かない）。
//   ① manifest の照合（#247 の verifyBundleManifest。依存の Issues の部品を使う）
//   ② pins の `delivery_bundles` の値との比較（値が null なら比較を飛ばしたことを返す）
//   ③ headless の出力の受け入れの判定（#246 の readHeadlessSummary と judgeAcceptance。Q7）
//   ④ 納品物の中の宣言（`artifacts/app.spec.yaml`）を読み、静的チェックに通す（spec-engine の normalizeSpec）
//
// 4 つとも通ったら、既存の publish の中身（`publishSpec`。検査 → 正規化 → R2 の 2 個 → D1 の登録）へ、
// **読み取った宣言のバイト列のまま**渡す。**publish の中身をここに複製しない**（判定が 2 か所に分かれると、
// 門を通った宣言と書かれる宣言がずれる）。
//
// Node 側でだけファイルを読む。`node:fs`・`node:path` の型はこの package の tsconfig の types
// （workers-types）に無いので、使う関数の形だけをここに宣言し、**動的**に読む（bundle.ts と同じやり方）。

import type { Diagnostic } from "@musunest/spec-engine";
import { normalizeSpec } from "@musunest/spec-engine";
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

// ── pins の照合 ───────────────────────────────────────────────────

/** `pins/commandagent.json` の、見本ごとの納品物の欄。 */
export const DELIVERY_BUNDLES_FIELD = "delivery_bundles" as const;

/** 比較の結果の種類。`skipped` は「どの見本にも値が入っていないので比較を飛ばした」。 */
export const PIN_COMPARISON_STATUSES = ["matched", "skipped", "mismatch"] as const;
export type PinComparisonStatus = (typeof PIN_COMPARISON_STATUSES)[number];

/** 比較の結果。`samples` は値が入っていた見本、`matchedSamples` は一致した見本（`matched` のときだけ）。 */
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
 * 納品物の manifest の SHA-256 を、`pins/commandagent.json` の `delivery_bundles` の値と比べる。
 *
 * 見本ごとに値が入る（`manifest_sha256`。まだ工場の納品待ちなら `null`）。**`null` の見本は比べない。**
 *   - どの見本にも値が入っていなければ `skipped`（比較を飛ばしたことを返す）
 *   - 値のどれかと一致すれば `matched`（一致した見本を返す）
 *   - 値が入っているのにどれとも一致しなければ `mismatch`
 *
 * `delivery_bundles` が写像でない・値が文字列でも `null` でもなければ `BundlePinError`（安全側に倒す）。
 */
export function compareBundleManifestToPins(manifestSha256: string, pins: unknown): PinComparison {
  const deliveryBundles = isRecord(pins) ? pins[DELIVERY_BUNDLES_FIELD] : undefined;
  if (!isRecord(deliveryBundles)) {
    throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD} が写像でない`);
  }
  const samples: { readonly name: string; readonly sha256: string }[] = [];
  for (const [name, entry] of Object.entries(deliveryBundles)) {
    if (name.startsWith("$")) continue; // $comment などの説明の欄は見本として数えない
    if (!isRecord(entry)) throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD}.${name} が写像でない`);
    const value = entry["manifest_sha256"];
    if (value === null) continue;
    if (typeof value !== "string") {
      throw new BundlePinError("pins_malformed", `${DELIVERY_BUNDLES_FIELD}.${name}.manifest_sha256 が文字列でない`);
    }
    samples.push({ name, sha256: value });
  }
  const names = samples.map((sample) => sample.name);
  const matchedSamples = samples.filter((sample) => sample.sha256 === manifestSha256).map((sample) => sample.name);
  if (samples.length === 0) return { status: "skipped", samples: [], matchedSamples: [] };
  return matchedSamples.length === 0
    ? { status: "mismatch", samples: names, matchedSamples: [] }
    : { status: "matched", samples: names, matchedSamples };
}

// ── 納品物の中の宣言を読む（Node 側）──────────────────────────────

interface NodeFs {
  readFileSync(path: string): Uint8Array;
}
interface NodePath {
  join(...parts: readonly string[]): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const decoder = new TextDecoder();

async function readBundleDeclaration(directory: string): Promise<string> {
  const [fs, path] = (await Promise.all([importUntyped("node:fs"), importUntyped("node:path")])) as [NodeFs, NodePath];
  const bytes = fs.readFileSync(path.join(directory, ...BUNDLE_DECLARATION_PATH.split("/")));
  return decoder.decode(bytes);
}

// ── 公開の入口 ────────────────────────────────────────────────────

/** 止まった段。①manifest ②pins ③acceptance ④declaration、そして既存の publish。 */
export const BUNDLE_PUBLISH_STAGES = ["manifest", "pins", "acceptance", "declaration", "publish"] as const;
export type BundlePublishStage = (typeof BUNDLE_PUBLISH_STAGES)[number];

/** publish の中身に渡す口（`publishSpec` と同じ。書き込みは偽の口で差し替えられる）。 */
export type BundlePublishDeps = PublishDeps;

export interface BundlePublishRequest {
  /** 工場の納品物のディレクトリ（直下に `bundle-manifest.json`） */
  readonly bundleDirectory: string;
  /** headless の stdout の全文（前の行は人向けの出力。最終行が v1 の要約） */
  readonly summaryStdout: string;
  /** `pins/commandagent.json` を JSON として読んだ値（`delivery_bundles` を読む） */
  readonly pins: unknown;
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
  /** 既存の publish の中身の結果 */
  readonly publish: PublishSuccess;
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
    readonly acceptance?: AcceptanceDecision;
  } = {},
): BundlePublishFailure => ({
  ok: false,
  stage,
  message,
  diagnostics: fields.diagnostics ?? [],
  problems: fields.problems ?? [],
  pin: fields.pin ?? null,
  acceptance: fields.acceptance ?? null,
});

const isDeliveryLevel = (value: string): value is DeliveryLevel => (DELIVERY_LEVELS as readonly string[]).includes(value);

/**
 * 納品物のディレクトリと headless の出力を受け取り、4 つの門（manifest の照合・pins との比較・
 * 受け入れの判定・宣言の静的チェック）を通したものだけを、既存の publish の中身（`publishSpec`）へ渡す。
 *
 * **どれかが落ちたら publish しない。** 段（`failure.stage`）で止まった門が分かる。`pins` の段は、
 * 値が入っているのに一致しなかったときである（どの見本にも値が無い `skipped` は通る）。
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

  // ② pins の delivery_bundles の値との比較（null の見本は飛ばす）
  let pin: PinComparison;
  try {
    pin = compareBundleManifestToPins(verified.manifestSha256, request.pins);
  } catch (error) {
    return fail("pins", error instanceof BundlePinError ? error.message : MESSAGES.pins_malformed);
  }
  if (pin.status === "mismatch") return fail("pins", MESSAGES.pins_mismatch, { pin });

  // ③ headless の出力の受け入れの判定（依存の Issue #246。Q7。水準は manifest の artifact_level）
  const level = verified.manifest.artifact_level;
  if (!isDeliveryLevel(level)) return fail("acceptance", MESSAGES.level_unknown, { pin });
  const read = readHeadlessSummary(request.summaryStdout);
  if (!read.ok) return fail("acceptance", read.message, { pin });
  const acceptance = judgeAcceptance(read.summary, level);
  if (!acceptance.accepted) return fail("acceptance", MESSAGES.acceptance, { pin, acceptance });

  // ④ 納品物の中の宣言を読み、静的チェックに通す（spec-engine。publish の中身と同じ判定を使う）
  let source: string;
  try {
    source = await readBundleDeclaration(request.bundleDirectory);
  } catch {
    return fail("declaration", MESSAGES.declaration_unreadable, { pin, acceptance });
  }
  const checked = await normalizeSpec(source);
  if (!checked.ok) return fail("declaration", MESSAGES.declaration, { pin, acceptance, diagnostics: checked.diagnostics });

  // 4 つとも通った。既存の publish の中身へ、読み取った宣言のまま渡す
  const published = await publishSpec(deps, {
    source,
    instanceId: request.instanceId,
    ...(request.replace === true ? { replace: true } : {}),
  });
  if (!published.ok) {
    return fail("publish", published.failure.message, { pin, acceptance, diagnostics: published.failure.diagnostics });
  }
  return { ok: true, manifestSha256: verified.manifestSha256, level, pin, publish: published };
}
