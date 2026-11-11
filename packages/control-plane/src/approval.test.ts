// 所有者の了承の記録の読み取りと、納品物への照合の unit（U-H。Issue #865）。
//
// 見本は手で書いた JSON の写像である。門（bundle-publish）の ④ が使う判断——
// 形が正しいか・manifest の SHA-256 と run_id に一致するか・partial 以外に使わないか——を固定する。
import { describe, expect, it } from "vitest";
import {
  ABSENT_APPROVAL,
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_VERDICT,
  evaluateApproval,
  readOwnerApproval,
  type ApprovalTarget,
  type OwnerApproval,
} from "./approval.js";

const SHA = "a".repeat(64);

/** 正しい了承の記録（`overrides` で欄を差し替える） */
const approvalObject = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: APPROVAL_SCHEMA_VERSION,
  manifest_sha256: SHA,
  run_id: "run-2026-09-26-001",
  verdict: APPROVAL_VERDICT,
  approved_by: "owner",
  approved_at: "2026-11-11T09:00:00.000Z",
  ...overrides,
});

/** 読めるはずの記録を読み、了承を返す（読めなければテストを落とす）。 */
const read = (value: unknown): OwnerApproval => {
  const result = readOwnerApproval(value);
  if (!result.ok) throw new Error(`読めるはずの了承を断った: ${result.code}`);
  return result.approval;
};

const target = (overrides: Partial<ApprovalTarget> = {}): ApprovalTarget => ({
  manifestSha256: SHA,
  runId: "run-2026-09-26-001",
  verdict: "partial",
  ...overrides,
});

describe("readOwnerApproval — 形を検査する", () => {
  it("正しい記録を読む（snake_case の欄を camelCase に写す）", () => {
    const approval = read(approvalObject());
    expect(approval).toEqual({
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      manifestSha256: SHA,
      runId: "run-2026-09-26-001",
      verdict: APPROVAL_VERDICT,
      approvedBy: "owner",
      approvedAt: "2026-11-11T09:00:00.000Z",
    });
  });

  it("時差つきの approved_at（ISO 8601）も読む", () => {
    expect(read(approvalObject({ approved_at: "2026-11-11T18:00:00+09:00" })).approvedAt).toBe(
      "2026-11-11T18:00:00+09:00",
    );
  });

  it.each([
    ["写像でない（文字列）", "approval", "approval_not_an_object"],
    ["写像でない（配列）", [], "approval_not_an_object"],
    ["schema_version が違う", approvalObject({ schema_version: "musunest.owner-approval/v2" }), "approval_schema_version_mismatch"],
    ["manifest_sha256 が短い", approvalObject({ manifest_sha256: "a".repeat(63) }), "approval_manifest_sha256_malformed"],
    ["manifest_sha256 が大文字", approvalObject({ manifest_sha256: "A".repeat(64) }), "approval_manifest_sha256_malformed"],
    ["manifest_sha256 が文字列でない", approvalObject({ manifest_sha256: 42 }), "approval_manifest_sha256_malformed"],
    ["run_id が空", approvalObject({ run_id: "" }), "approval_run_id_malformed"],
    ["run_id が文字列でない", approvalObject({ run_id: null }), "approval_run_id_malformed"],
    ["verdict が full", approvalObject({ verdict: "full" }), "approval_verdict_not_partial"],
    ["verdict が none", approvalObject({ verdict: "none" }), "approval_verdict_not_partial"],
    ["approved_by が空", approvalObject({ approved_by: "" }), "approval_approved_by_malformed"],
    ["approved_at が ISO 8601 でない", approvalObject({ approved_at: "2026/11/11" }), "approval_approved_at_malformed"],
    ["approved_at が実在しない日付", approvalObject({ approved_at: "2026-13-40T00:00:00Z" }), "approval_approved_at_malformed"],
  ])("%s を断る（%s）", (_name, value, code) => {
    const result = readOwnerApproval(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("断るはず");
    expect(result.code).toBe(code);
  });
});

describe("evaluateApproval — 納品物に照合する", () => {
  it("了承が無ければ absent（今までの呼び方）", () => {
    expect(evaluateApproval(undefined, target())).toEqual(ABSENT_APPROVAL);
    expect(evaluateApproval(null, target())).toEqual(ABSENT_APPROVAL);
  });

  it("partial の納品物に、manifest の SHA と run_id が一致する了承は used", () => {
    const outcome = evaluateApproval(approvalObject(), target());
    expect(outcome.kind).toBe("used");
    if (outcome.kind !== "used") throw new Error("使うはず");
    expect(outcome.approval.manifestSha256).toBe(SHA);
    expect(outcome.approval.runId).toBe("run-2026-09-26-001");
  });

  it("manifest の SHA が 1 文字違えば approval_manifest_mismatch で断る", () => {
    const outcome = evaluateApproval(approvalObject({ manifest_sha256: "b".repeat(64) }), target());
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("断るはず");
    expect(outcome.code).toBe("approval_manifest_mismatch");
  });

  it("run_id が要約と違えば approval_run_mismatch で断る（別の走りの要約を渡す形を塞ぐ）", () => {
    const outcome = evaluateApproval(approvalObject({ run_id: "run-other" }), target());
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("断るはず");
    expect(outcome.code).toBe("approval_run_mismatch");
  });

  it("要約の run_id が null なら、了承があっても approval_run_mismatch で断る", () => {
    const outcome = evaluateApproval(approvalObject(), target({ runId: null }));
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("断るはず");
    expect(outcome.code).toBe("approval_run_mismatch");
  });

  it("形の違う了承は approval_invalid で断る（読み取りの理由を detail に残す）", () => {
    const outcome = evaluateApproval(approvalObject({ verdict: "full" }), target());
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("断るはず");
    expect(outcome.code).toBe("approval_invalid");
    expect(outcome.detail).toBe("approval_verdict_not_partial");
    expect(outcome.approval).toBeNull();
  });

  it("verdict none の納品物には了承を使わない（unused。none は通さない）", () => {
    const outcome = evaluateApproval(approvalObject(), target({ verdict: "none" }));
    expect(outcome.kind).toBe("unused");
  });

  it("full の納品物に了承が渡されたら使わず、unused を返す", () => {
    const outcome = evaluateApproval(approvalObject(), target({ verdict: "full" }));
    expect(outcome.kind).toBe("unused");
  });

  it("full の納品物に形の違う了承が渡されても、拒まない（使わないだけ）", () => {
    const outcome = evaluateApproval({ nope: true }, target({ verdict: "full" }));
    expect(outcome.kind).toBe("unused");
    if (outcome.kind !== "unused") throw new Error("使わないはず");
    expect(outcome.approval).toBeNull();
  });
});
