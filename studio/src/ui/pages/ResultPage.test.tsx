// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, PublishSuccessRecord } from "../../shared/api";
import { ResultPage } from "./ResultPage";

afterEach(cleanup);

const SHA = "abcdef0123456789".repeat(4);

const baseJob: JobView = {
  id: "job-1",
  request: "一覧を作りたい",
  state: "result",
  stateLabel: "結果",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: null,
  result: null,
  createdAt: 1,
  updatedAt: 2,
};

const fullJob: JobView = {
  ...baseJob,
  result: { verdict: "full", verdictLabel: "すべて満たしました", content: ["依頼どおりに作りました。"] },
};

const partialJob: JobView = {
  ...baseJob,
  manifestSha256: SHA,
  partial: {
    built: ["一覧を新しい順に並べる"],
    missing: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
    decided: ["画面の名前は「一覧」にする"],
  },
  result: { verdict: "partial", verdictLabel: "一部だけ満たしました", content: ["一覧を新しい順に並べる"] },
};

const published: PublishSuccessRecord = {
  ok: true,
  instanceId: "studio-20261111123456",
  level: "L2",
  manifestSha256: SHA,
  path: "/apps/studio-20261111123456",
};

const renderResult = (overrides: Partial<Parameters<typeof ResultPage>[0]> = {}) =>
  render(
    <ResultPage
      job={fullJob}
      onPublish={() => {}}
      onApprove={() => {}}
      onRetry={() => {}}
      {...overrides}
    />,
  );

describe("ResultPage（full）", () => {
  it("結果と公開のボタンを出す", () => {
    renderResult();
    expect(screen.getByText("すべて満たしました")).toBeTruthy();
    expect(screen.getByText("依頼どおりに作りました。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "公開する" })).toBeTruthy();
  });

  it("公開済みならインスタンス ID と「開いて試す」を出す", () => {
    renderResult({ publish: published, origin: "https://staging.example" });
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    const link = screen.getByRole("link", { name: "開いて試す" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://staging.example/apps/studio-20261111123456");
  });

  it("HTML に埋めたオリジンが無ければ「開いて試す」を出さない", () => {
    renderResult({ publish: published, origin: null });
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "開いて試す" })).toBeNull();
  });
});

describe("ResultPage（partial）", () => {
  it("了承の前は公開のボタンが無く、SHA をそのまま了承へ渡す", () => {
    const onApprove = vi.fn();
    renderResult({ job: partialJob, onApprove });

    expect(screen.queryByRole("button", { name: "公開する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "了承して公開する" }));
    expect(onApprove).toHaveBeenCalledWith(SHA);
  });

  it("了承のあとは公開のボタンを出す", () => {
    renderResult({ job: partialJob, approved: true });
    expect(screen.getByRole("button", { name: "公開する" })).toBeTruthy();
  });
});

describe("ResultPage（none・差し戻し・時間切れ）", () => {
  const noneJob: JobView = {
    ...baseJob,
    result: { verdict: "none", verdictLabel: "作れませんでした", content: ["写真を扱うものは作れません。"] },
  };

  it("none は理由と「依頼を直してやり直す」を出す", () => {
    const onRetry = vi.fn();
    renderResult({ job: noneJob, onRetry });
    expect(screen.getByText("作れませんでした")).toBeTruthy();
    expect(screen.getByText("写真を扱うものは作れません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "依頼を直してやり直す" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("差し戻しは理由と「依頼を直してやり直す」を出す", () => {
    const sentBack: JobView = {
      ...baseJob,
      state: "sent-back",
      stateLabel: "差し戻し",
      result: null,
    };
    renderResult({ job: sentBack });
    expect(screen.getByText("工場が、もう一度聞き直したいと返しました。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "依頼を直してやり直す" })).toBeTruthy();
  });

  it("時間切れは理由と「依頼を直してやり直す」を出す", () => {
    const timeout: JobView = {
      ...baseJob,
      state: "stopped",
      stateLabel: "止めた",
      stopReason: "timeout",
      stopReasonLabel: "時間切れ",
      result: null,
    };
    renderResult({ job: timeout });
    expect(screen.getByText("時間切れ")).toBeTruthy();
    expect(screen.getByRole("button", { name: "依頼を直してやり直す" })).toBeTruthy();
  });

  it("要件を固めきれなかった走りは、分類と直し方を出し、「工場の失敗」を出さない", () => {
    const cannotConfirm: JobView = {
      ...baseJob,
      state: "stopped",
      stateLabel: "止めた",
      stopReason: "cannot-confirm",
      stopReasonLabel: "要件を固めきれませんでした",
      stopReasonCategory: "質問の回数の中で決めきれないことが残りました",
      result: null,
    };
    renderResult({ job: cannotConfirm });

    expect(screen.getByText("要件を固めきれませんでした")).toBeTruthy();
    expect(screen.getByText(/質問の回数の中で決めきれないことが残りました/)).toBeTruthy();
    expect(screen.getByText(/決めてほしいことを依頼に書き足すと、固めやすくなります。/)).toBeTruthy();
    expect(screen.queryByText("工場の失敗")).toBeNull();
    expect(screen.getByRole("button", { name: "依頼を直してやり直す" })).toBeTruthy();
  });
});

describe("ResultPage の文言", () => {
  it("宣言の用語・要件の ID の形・32 桁の 16 進を出さない", () => {
    const { container } = renderResult({ job: partialJob });
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(container.textContent ?? "").not.toMatch(/\b[RI]\d+\b/u);
    expect(container.textContent ?? "").not.toMatch(/\b[0-9a-f]{32}\b/u);
  });
});
