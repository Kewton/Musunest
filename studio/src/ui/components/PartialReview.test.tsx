// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartialReview, shortSha } from "./PartialReview";

afterEach(cleanup);

const SHA = "0123456789abcdef".repeat(4);

const renderReview = (overrides: Partial<Parameters<typeof PartialReview>[0]> = {}) =>
  render(
    <PartialReview
      built={["一覧を新しい順に並べる", "題名と日付を表示する"]}
      missing={[{ what: "写真の添付", alternative: "題名に写真の名前を書く" }]}
      decided={["画面の名前は「一覧」にする"]}
      manifestSha={SHA}
      onApprove={() => {}}
      {...overrides}
    />,
  );

describe("PartialReview", () => {
  it("できたこと・できなかったこと・決めたことの 3 つの見出しを出す", () => {
    renderReview();

    const built = screen.getByRole("region", { name: "できたこと" });
    expect(within(built).getByText("一覧を新しい順に並べる")).toBeTruthy();

    const missing = screen.getByRole("region", { name: "できなかったこと" });
    expect(within(missing).getByText("写真の添付")).toBeTruthy();
    expect(within(missing).getByText("代わりに: 題名に写真の名前を書く")).toBeTruthy();

    const decided = screen.getByRole("region", { name: "決めたこと" });
    expect(within(decided).getByText("画面の名前は「一覧」にする")).toBeTruthy();
  });

  it("SHA の短い形を出し、64 桁と 32 桁の 16 進を出さない", () => {
    const { container } = renderReview();
    expect(screen.getByText(`いまの納品物の SHA（短い形）: ${shortSha(SHA)}`)).toBeTruthy();
    expect(shortSha(SHA)).toHaveLength(12);
    const text = container.textContent ?? "";
    expect(text).not.toContain(SHA);
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/u);
  });

  it("了承の要求に、画面が見せた SHA をそのまま入れる", () => {
    const onApprove = vi.fn();
    renderReview({ onApprove });
    fireEvent.click(screen.getByRole("button", { name: "了承して公開する" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(SHA);
  });

  it("了承の前は公開のボタンを置かない", () => {
    renderReview();
    expect(screen.queryByRole("button", { name: "公開する" })).toBeNull();
  });

  it("SHA が無ければ了承できない", () => {
    renderReview({ manifestSha: null });
    const button = screen.getByRole("button", { name: "了承して公開する" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("画面の文言に宣言の用語を出さない", () => {
    const { container } = renderReview();
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
  });
});
