import { describe, expect, it } from "vitest";
import { STUDIO_INSTANCE_PATTERN, isStudioInstanceId, stampInstanceId } from "./instance-id.js";

describe("公開先のインスタンス ID", () => {
  it("studio-<YYYYMMDDHHmmss> を手元の時刻で作る", () => {
    const id = stampInstanceId(new Date(2026, 10, 11, 12, 34, 56));
    expect(id).toBe("studio-20261111123456");
    expect(STUDIO_INSTANCE_PATTERN.test(id)).toBe(true);
    expect(isStudioInstanceId(id)).toBe(true);
  });

  it("studio- 以外・桁数違いは工房のインスタンスではない", () => {
    expect(isStudioInstanceId("studio-2026")).toBe(false);
    expect(isStudioInstanceId("preview-20261111123456")).toBe(false);
    expect(isStudioInstanceId("studio-2026111112345a")).toBe(false);
  });
});
