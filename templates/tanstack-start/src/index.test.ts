// 公開面の検査（Issue #229）。tarball の中身は pack.test.ts が見る。ここは入口だけ。

import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, collectTemplateEntries, createTarball, packTemplate } from "./index.js";

describe("@musunest/template-tanstack-start の公開面", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/template-tanstack-start");
  });

  it("tarball を作る関数を公開する", () => {
    expect(typeof createTarball).toBe("function");
    expect(typeof collectTemplateEntries).toBe("function");
    expect(typeof packTemplate).toBe("function");
  });
});
