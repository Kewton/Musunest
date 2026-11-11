import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStudioAppServer } from "./main.js";
import { createFakeRunner } from "./runner-fake.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "musunest-main-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("工房のサーバの組み立て", () => {
  it("差し込んだ走らせる役でジョブを始める", () => {
    const runner = createFakeRunner();
    const app = createStudioAppServer({ staticDir: "/virtual/client", token: "t", home, runner });

    const view = app.jobs.start("日付順の一覧を作って");
    expect(view.state).toBe("awaiting-answer");
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]?.request).toBe("日付順の一覧を作って");
  });
});
