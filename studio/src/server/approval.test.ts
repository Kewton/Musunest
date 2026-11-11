import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_SCHEMA_VERSION, APPROVAL_VERDICT } from "@musunest/control-plane";
import {
  ApprovalRecordError,
  approvalFilePath,
  buildApprovalRecord,
  readApprovalFile,
  writeApprovalFile,
} from "./approval.js";

const SHA = "c".repeat(64);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("了承の記録", () => {
  it("manifest の SHA と要約の run_id を入れる", () => {
    const record = buildApprovalRecord({
      manifestSha256: SHA,
      runId: "run-123",
      approvedAt: "2026-11-11T12:00:00.000Z",
    });
    expect(record.schema_version).toBe(APPROVAL_SCHEMA_VERSION);
    expect(record.manifest_sha256).toBe(SHA);
    expect(record.run_id).toBe("run-123");
    expect(record.verdict).toBe(APPROVAL_VERDICT);
    expect(record.approved_by).toBe("studio-owner");
  });

  it("SHA の形が違えば記録を組まない", () => {
    expect(() =>
      buildApprovalRecord({ manifestSha256: "short", runId: "run-1", approvedAt: "2026-11-11T12:00:00.000Z" }),
    ).toThrow(ApprovalRecordError);
  });

  it("書いた記録を control-plane の検査に通して読める", () => {
    const directory = mkdtempSync(join(tmpdir(), "musunest-approval-"));
    directories.push(directory);
    const path = approvalFilePath(directory);
    const record = buildApprovalRecord({
      manifestSha256: SHA,
      runId: "run-123",
      approvedAt: "2026-11-11T12:00:00.000Z",
    });
    writeApprovalFile(path, record);

    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved["manifest_sha256"]).toBe(SHA);
    expect(saved["run_id"]).toBe("run-123");

    const read = readApprovalFile(path);
    expect(read.manifestSha256).toBe(SHA);
    expect(read.runId).toBe("run-123");
  });
});
