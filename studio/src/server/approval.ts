// 所有者の了承の記録を、工房のジョブの置き場所に書く（studio-s1.md §6 U-H・Issue #868 の目的・2）。
//
// 記録の形は control-plane の正本（`packages/control-plane/src/approval.ts`）に合わせる。判定は門が持つので、
// ここでは**記録を組む・ファイルに書く・読む**だけを行う（門の判定を工房に複製しない）。
//
// 記録には **manifest の SHA-256 と、要約の run_id** を入れる。公開の子（publish-bundle）は、この記録が
// いまの納品物と走りに一致するときだけ partial を受け入れる。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_SHA256_PATTERN,
  APPROVAL_VERDICT,
  readOwnerApproval,
  type OwnerApproval,
} from "@musunest/control-plane";

/** ジョブの置き場所に書く了承の記録のファイル名。 */
export const APPROVAL_FILE = "approval.json" as const;

/** 工房が了承した人として記録する名前（S1 は所有者の手元の申告である）。 */
export const STUDIO_APPROVED_BY = "studio-owner" as const;

/** 了承の記録の wire（control-plane の形。snake_case）。 */
export interface ApprovalRecord {
  readonly schema_version: typeof APPROVAL_SCHEMA_VERSION;
  readonly manifest_sha256: string;
  readonly run_id: string;
  readonly verdict: typeof APPROVAL_VERDICT;
  readonly approved_by: string;
  readonly approved_at: string;
}

/** 了承の記録を読めない・組めない。 */
export class ApprovalRecordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApprovalRecordError";
    this.code = code;
  }
}

export interface BuildApprovalRecordInput {
  /** 照合した納品物の manifest の SHA-256（小文字の 16 進 64 桁） */
  readonly manifestSha256: string;
  /** 要約の run_id（空でないこと） */
  readonly runId: string;
  /** 了承した時刻（ISO 8601） */
  readonly approvedAt: string;
  /** 了承した人（既定は工房の所有者） */
  readonly approvedBy?: string;
}

/**
 * 了承の記録を組む。**組んだ記録が control-plane の検査に通らなければ例外にする**（壊れた記録を
 * ファイルに書かない）。値を含む例外の文言は外へ出さない想定で、呼ぶ側がコードで分ける。
 */
export function buildApprovalRecord(input: BuildApprovalRecordInput): ApprovalRecord {
  if (!APPROVAL_SHA256_PATTERN.test(input.manifestSha256)) {
    throw new ApprovalRecordError("approval_manifest_sha256_malformed", "manifest の SHA-256 の形が違う");
  }
  const record: ApprovalRecord = {
    schema_version: APPROVAL_SCHEMA_VERSION,
    manifest_sha256: input.manifestSha256,
    run_id: input.runId,
    verdict: APPROVAL_VERDICT,
    approved_by: input.approvedBy ?? STUDIO_APPROVED_BY,
    approved_at: input.approvedAt,
  };
  const checked = readOwnerApproval(record);
  if (!checked.ok) throw new ApprovalRecordError(checked.code, checked.message);
  return record;
}

/** ジョブの置き場所の、了承の記録のパス。 */
export function approvalFilePath(jobDirectory: string): string {
  return join(jobDirectory, APPROVAL_FILE);
}

/** 了承の記録をファイルに書く（親のディレクトリを作る）。 */
export function writeApprovalFile(path: string, record: ApprovalRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** 了承の記録を読んで、control-plane の検査に通したものを返す。読めない・形が違えば例外にする。 */
export function readApprovalFile(path: string): OwnerApproval {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ApprovalRecordError("approval_unreadable", "了承の記録を読めない");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApprovalRecordError("approval_invalid_json", "了承の記録が JSON として読めない");
  }
  const checked = readOwnerApproval(parsed);
  if (!checked.ok) throw new ApprovalRecordError(checked.code, checked.message);
  return checked.approval;
}
