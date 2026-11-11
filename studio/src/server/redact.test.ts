import { describe, expect, it } from "vitest";
import { REDACTED, containsSecret, redactSecrets } from "./redact.js";

const SHA256_64 = "a".repeat(64);

describe("子の出力を伏せる", () => {
  it("32 桁の 16 進（Account ID）を伏せる", () => {
    const accountId = "0123456789abcdef0123456789abcdef";
    const text = redactSecrets(`account=${accountId}`);
    expect(text).not.toContain(accountId);
    expect(text).toContain(REDACTED);
  });

  it("workers.dev のホスト（サブドメインを含む）を伏せる", () => {
    const text = redactSecrets("host studio-abc.workers.dev を使う");
    expect(text).not.toContain("workers.dev");
    expect(text).toContain(REDACTED);
  });

  it("https:// で始まる URL を伏せる", () => {
    const text = redactSecrets("open https://example.test/apps/studio-1 now");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("example.test");
    expect(text).toBe(`open ${REDACTED} now`);
  });

  it("manifest の SHA-256（64 桁）は伏せない", () => {
    expect(redactSecrets(SHA256_64)).toBe(SHA256_64);
  });

  it("混ざった出力から伏せるべき値だけを消す", () => {
    const output = `publish-bundle: NG 段 manifest ${"b".repeat(32)} https://x.workers.dev/a`;
    const redacted = redactSecrets(output);
    expect(redacted).toContain("publish-bundle: NG 段 manifest");
    expect(redacted).not.toContain("b".repeat(32));
    expect(redacted).not.toContain("workers.dev");
    expect(redacted).not.toContain("https://");
    expect(containsSecret(redacted)).toBe(false);
  });
});
