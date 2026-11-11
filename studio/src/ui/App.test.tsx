// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

describe("App", () => {
  it("「新しく作る」と「履歴」の2つの入口を出す", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "新しく作る" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "履歴" })).toBeTruthy();
  });

  it("画面の文言に entity・computed・view・action の語を出さない", () => {
    const { container } = render(<App />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
  });
});
