// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StageProgress, formatElapsed } from "./StageProgress";

afterEach(cleanup);

describe("StageProgress", () => {
  it("段の表示名と経過時間を出す", () => {
    const { container } = render(
      <StageProgress progress={{ stage: "書く", elapsedSeconds: 83, estimatedUsd: 0.12 }} />,
    );
    expect(container.querySelector(".progress__stage")?.textContent).toBe("書く");
    expect(screen.getByText("1 分 23 秒")).toBeTruthy();
    expect(screen.getByText("$0.12")).toBeTruthy();
  });

  it("段の並びを出し、いまの段を印す", () => {
    render(
      <StageProgress progress={{ stage: "試験", elapsedSeconds: 5, estimatedUsd: 0.01 }} />,
    );
    const current = screen
      .getAllByText("試験")
      .find((node) => node.getAttribute("aria-current") === "step");
    expect(current).toBeTruthy();
    for (const name of ["名前の表", "書く", "点検"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  it("経過時間を時間・分・秒で書く", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(59)).toBe("59 秒");
    expect(formatElapsed(60)).toBe("1 分 0 秒");
    expect(formatElapsed(3_661)).toBe("1 時間 1 分");
  });

  it("画面の文言に宣言の用語を出さない", () => {
    const { container } = render(
      <StageProgress progress={{ stage: "点検", elapsedSeconds: 3, estimatedUsd: 0.02 }} />,
    );
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
  });
});
