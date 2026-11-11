// 所有者の了承の記録（U-H。Issue #865）。
//
// 部分案（verdict `partial`）を公開してよい、という所有者の決定を、**納品物の manifest の SHA-256 と
// 走り（`run_id`）に結び付けて**表す。門（bundle-publish）の ④ は、この記録が無ければ partial を
// `verdict_not_full` で断り、記録がこの納品物に一致するときだけ、その理由を外す。
//
// **形は信用しない。** S1 では呼ぶ側（所有者の手元）の申告である（`workspace/mvp/m2/studio-s1.md`
// §6・§7 ②）。S2 で data-api が認証した利用者から組み立てる。ここは記録の読み取りと検査・照合だけを
// 行い、ファイルにも API にも触らない。
//
// 了承で緩めないもの：`status`・`assurance`・①②③⑤の門。verdict `none` は了承があっても通さない。
// `full` の納品物に渡された了承は使わない（結果に「使わなかった」を返す）。
//
// 記録の形（JSON。キーは snake_case）：
//   {
//     "schema_version": "musunest.owner-approval/v1",
//     "manifest_sha256": "<小文字の 16 進 64 桁>",
//     "run_id": "<要約の run_id>",
//     "verdict": "partial",
//     "approved_by": "<了承した人>",
//     "approved_at": "<ISO 8601>"
//   }

// ── 記録の形（v1）────────────────────────────────────────────────

/** 了承の記録の版。S1 は呼ぶ側の申告（studio-s1 §7 ②）。 */
export const APPROVAL_SCHEMA_VERSION = "musunest.owner-approval/v1" as const;

/** 了承してよい verdict。**`partial` だけ**（`none` は了承があっても通さない）。 */
export const APPROVAL_VERDICT = "partial" as const;

/** 納品物の manifest の SHA-256 の形（小文字の 16 進 64 桁）。 */
export const APPROVAL_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** `approved_at` の形（ISO 8601。時刻と、`Z` か時差を持つ）。 */
const APPROVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** 検査に通った了承の記録。 */
export interface OwnerApproval {
  readonly schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  readonly manifestSha256: string;
  readonly runId: string;
  readonly verdict: typeof APPROVAL_VERDICT;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

// ── 読み取りと検査 ────────────────────────────────────────────────

/** 了承の記録を断る理由。呼ぶ側が例外の文言に依存しないよう、原因はコードで分ける。 */
export const APPROVAL_READ_FAILURE_CODES = [
  "approval_not_an_object",
  "approval_schema_version_mismatch",
  "approval_manifest_sha256_malformed",
  "approval_run_id_malformed",
  "approval_verdict_not_partial",
  "approval_approved_by_malformed",
  "approval_approved_at_malformed",
] as const;
export type ApprovalReadFailureCode = (typeof APPROVAL_READ_FAILURE_CODES)[number];

export interface ApprovalReadFailure {
  readonly ok: false;
  readonly code: ApprovalReadFailureCode;
  /** 人が読む説明。**値（run_id・approved_by）を含めない** */
  readonly message: string;
}

export interface ApprovalReadSuccess {
  readonly ok: true;
  readonly approval: OwnerApproval;
}

export type ApprovalReadResult = ApprovalReadSuccess | ApprovalReadFailure;

const READ_FAILURE_MESSAGES = {
  approval_not_an_object: "了承の記録が JSON の写像でない",
  approval_schema_version_mismatch: `schema_version が ${APPROVAL_SCHEMA_VERSION} でない`,
  approval_manifest_sha256_malformed: "manifest_sha256 が小文字の 16 進 64 桁でない",
  approval_run_id_malformed: "run_id が空でない文字列でない",
  approval_verdict_not_partial: `verdict が ${APPROVAL_VERDICT} でない（partial の了承だけが使える）`,
  approval_approved_by_malformed: "approved_by が空でない文字列でない",
  approval_approved_at_malformed: "approved_at が ISO 8601 の文字列でない",
} as const satisfies Record<ApprovalReadFailureCode, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readFailure = (code: ApprovalReadFailureCode): ApprovalReadFailure => ({
  ok: false,
  code,
  message: READ_FAILURE_MESSAGES[code],
});

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * 了承の記録を読む。**例外を外へ出さない**（形の誤りは結果にする）。
 *
 * 断る条件：写像でない・`schema_version` が違う・`manifest_sha256` が小文字の 16 進 64 桁でない・
 * `run_id` が空・`verdict` が `partial` でない・`approved_by` が空・`approved_at` が ISO 8601 でない。
 */
export function readOwnerApproval(value: unknown): ApprovalReadResult {
  if (!isRecord(value)) return readFailure("approval_not_an_object");

  if (value["schema_version"] !== APPROVAL_SCHEMA_VERSION) {
    return readFailure("approval_schema_version_mismatch");
  }
  const manifestSha256 = value["manifest_sha256"];
  if (typeof manifestSha256 !== "string" || !APPROVAL_SHA256_PATTERN.test(manifestSha256)) {
    return readFailure("approval_manifest_sha256_malformed");
  }
  const runId = value["run_id"];
  if (!isNonEmptyString(runId)) return readFailure("approval_run_id_malformed");
  if (value["verdict"] !== APPROVAL_VERDICT) return readFailure("approval_verdict_not_partial");
  const approvedBy = value["approved_by"];
  if (!isNonEmptyString(approvedBy)) return readFailure("approval_approved_by_malformed");
  const approvedAt = value["approved_at"];
  if (typeof approvedAt !== "string" || !APPROVED_AT_PATTERN.test(approvedAt) || Number.isNaN(Date.parse(approvedAt))) {
    return readFailure("approval_approved_at_malformed");
  }

  return {
    ok: true,
    approval: {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      manifestSha256,
      runId,
      verdict: APPROVAL_VERDICT,
      approvedBy,
      approvedAt,
    },
  };
}

// ── 納品物への照合（門の ④）──────────────────────────────────────

/** 了承を照合する相手。`manifestSha256` は①で照合した manifest の SHA-256、`runId` は要約の `run_id`。 */
export interface ApprovalTarget {
  readonly manifestSha256: string;
  readonly runId: string | null;
  /** 要約の `verdict`（`partial` のときだけ了承を使える） */
  readonly verdict: string | null;
}

/** 門の ④ が了承を断る理由。**形・manifest・走りのどれが合わないかを分ける。** */
export const APPROVAL_REJECTION_CODES = [
  "approval_invalid",
  "approval_manifest_mismatch",
  "approval_run_mismatch",
] as const;
export type ApprovalRejectionCode = (typeof APPROVAL_REJECTION_CODES)[number];

/**
 * 了承の使い道。
 *   - `absent`：了承が渡されていない
 *   - `used`：partial の納品物に一致した（④の `verdict_not_full` を外す）
 *   - `unused`：了承は渡されたが使わない（`full`・`none` の納品物。**結果に「使わなかった」を返す**）
 *   - `rejected`：partial だが了承が合わない（新しい理由のコードで断る）
 */
export type ApprovalOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "used"; readonly approval: OwnerApproval }
  | { readonly kind: "unused"; readonly approval: OwnerApproval | null }
  | {
      readonly kind: "rejected";
      readonly code: ApprovalRejectionCode;
      /** 形が違うときだけ、読み取りの理由。照合の食い違いは `null` */
      readonly detail: ApprovalReadFailureCode | null;
      readonly approval: OwnerApproval | null;
    };

/** 了承が渡されていないときの既定値。 */
export const ABSENT_APPROVAL: ApprovalOutcome = { kind: "absent" };

/**
 * 了承を、納品物（manifest の SHA-256・要約の `run_id`）に照合する。
 *
 * **`partial` のときだけ使える。** `partial` でなければ、渡されていても `unused` を返す
 * （`full` と `none` は了承では通さない）。`partial` のときに形が違えば `approval_invalid`、
 * manifest が違えば `approval_manifest_mismatch`、`run_id` が違えば `approval_run_mismatch` で断る
 * （**別の走りの要約を渡す形も塞ぐ**）。
 */
export function evaluateApproval(value: unknown, target: ApprovalTarget): ApprovalOutcome {
  if (value === undefined || value === null) return ABSENT_APPROVAL;

  const read = readOwnerApproval(value);
  if (target.verdict !== APPROVAL_VERDICT) {
    return { kind: "unused", approval: read.ok ? read.approval : null };
  }
  if (!read.ok) {
    return { kind: "rejected", code: "approval_invalid", detail: read.code, approval: null };
  }
  if (read.approval.manifestSha256 !== target.manifestSha256) {
    return { kind: "rejected", code: "approval_manifest_mismatch", detail: null, approval: read.approval };
  }
  if (target.runId === null || read.approval.runId !== target.runId) {
    return { kind: "rejected", code: "approval_run_mismatch", detail: null, approval: read.approval };
  }
  return { kind: "used", approval: read.approval };
}
