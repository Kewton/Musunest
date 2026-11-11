import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_NAME, HOME_ENV, resolveStudioHome, StudioHomeError } from "./home.js";

describe("resolveStudioHome", () => {
  it("既定はホームの下の .musunest-studio", () => {
    const home = "/home/example";
    expect(resolveStudioHome({ homeDir: home, env: {}, repoRoot: "/repo" })).toBe(resolve(home, DEFAULT_HOME_NAME));
  });

  it("環境変数で差し替えられる", () => {
    const dir = resolveStudioHome({ env: { [HOME_ENV]: "/var/studio-runs" }, repoRoot: "/repo" });
    expect(dir).toBe("/var/studio-runs");
  });

  it("リポジトリの中を指すと断る", () => {
    expect(() => resolveStudioHome({ env: { [HOME_ENV]: "/repo/studio-runs" }, repoRoot: "/repo" })).toThrow(StudioHomeError);
  });

  it("リポジトリの根そのものを指しても断る", () => {
    expect(() => resolveStudioHome({ env: { [HOME_ENV]: "/repo" }, repoRoot: "/repo" })).toThrow(StudioHomeError);
  });

  it("隣の名前はリポジトリの中とみなさない", () => {
    expect(resolveStudioHome({ env: { [HOME_ENV]: "/repo-other/runs" }, repoRoot: "/repo" })).toBe("/repo-other/runs");
  });
});
