// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishFailureRecord, PublishSuccessRecord } from "../../shared/api";
import { PublishPanel, composeTryUrl, stageLabelOf } from "./PublishPanel";

afterEach(cleanup);

const success: PublishSuccessRecord = {
  ok: true,
  instanceId: "studio-20261111123456",
  level: "L2",
  manifestSha256: "a".repeat(64),
  path: "/apps/studio-20261111123456",
};

const failure: PublishFailureRecord = {
  ok: false,
  stage: "acceptance",
  message: "publish-bundle: NG 段 acceptance https://x.workers.dev/a " + "e".repeat(32),
};

describe("PublishPanel", () => {
  it("公開の要求を 1 回だけ送る（連打しても 1 回）", () => {
    const onPublish = vi.fn();
    render(<PublishPanel onPublish={onPublish} />);

    const button = screen.getByRole("button", { name: "公開する" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("公開済みならインスタンス ID と「開いて試す」を出す", () => {
    render(
      <PublishPanel
        publish={success}
        origin="https://staging.example"
        onPublish={() => {}}
      />,
    );
    expect(screen.getByText("公開しました")).toBeTruthy();
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    const link = screen.getByRole("link", { name: "開いて試す" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://staging.example/apps/studio-20261111123456");
  });

  it("オリジンが無ければ「開いて試す」を出さない（インスタンス ID は出す）", () => {
    render(<PublishPanel publish={success} origin={null} onPublish={() => {}} />);
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "開いて試す" })).toBeNull();
  });

  it("経路の無い応答では「開いて試す」を出さない", () => {
    const noPath = {
      ok: true,
      instanceId: "studio-20261111123456",
      level: "L2",
      manifestSha256: "a".repeat(64),
    } as unknown as PublishSuccessRecord;
    render(<PublishPanel publish={noPath} origin="https://staging.example" onPublish={() => {}} />);
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "開いて試す" })).toBeNull();
  });

  it("公開の失敗は止まった段を利用者の言葉で出し、値・URL・32 桁の 16 進を出さない", () => {
    const { container } = render(<PublishPanel publish={failure} onPublish={() => {}} />);
    expect(screen.getByText("公開できませんでした")).toBeTruthy();
    expect(screen.getByText(/受け入れの確認/)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toContain("workers.dev");
    expect(text).not.toContain("https://");
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/u);
  });

  it("リンクは経路とオリジンの両方があるときだけ組む", () => {
    expect(composeTryUrl("https://staging.example", "/apps/studio-1")).toBe(
      "https://staging.example/apps/studio-1",
    );
    expect(composeTryUrl("https://staging.example/", "apps/studio-1")).toBe(
      "https://staging.example/apps/studio-1",
    );
    expect(composeTryUrl(null, "/apps/studio-1")).toBeNull();
    expect(composeTryUrl("https://staging.example", null)).toBeNull();
    expect(composeTryUrl("javascript:alert(1)", "/apps/studio-1")).toBeNull();
  });

  it("知らない段は「公開の準備」にする", () => {
    expect(stageLabelOf("manifest")).toBe("納品物の照合");
    expect(stageLabelOf(null)).toBe("公開の準備");
    expect(stageLabelOf("unknown")).toBe("公開の準備");
  });

  it("画面の文言に宣言の用語を出さない", () => {
    const { container } = render(<PublishPanel publish={success} origin={null} onPublish={() => {}} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
  });
});
