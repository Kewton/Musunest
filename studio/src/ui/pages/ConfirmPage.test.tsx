// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../shared/api";
import { ConfirmPage } from "./ConfirmPage";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const jobOf = (): JobView => ({
  id: "job-1",
  request: "一覧を作りたい",
  state: "awaiting-confirm",
  stateLabel: "確認待ち",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: {
    requirements: ["一覧を新しい順に並べる", "題名と日付を表示する"],
    diff: {
      added: ["題名と日付を表示する"],
      changed: ["並び順を新しい順にした"],
      removed: ["写真の添付"],
    },
    limitations: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
    decided: ["画面の名前は「一覧」にする"],
  },
  progress: null,
  result: null,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
});

describe("ConfirmPage", () => {
  it("差分の 3 種を、それぞれの見出しの下に出す", () => {
    render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);

    const added = screen.getByRole("region", { name: "足したこと" });
    expect(within(added).getByText("題名と日付を表示する")).toBeTruthy();

    const changed = screen.getByRole("region", { name: "直したこと" });
    expect(within(changed).getByText("並び順を新しい順にした")).toBeTruthy();

    const removed = screen.getByRole("region", { name: "外したこと" });
    expect(within(removed).getByText("写真の添付")).toBeTruthy();
  });

  it("できないことと代わりの案を出す", () => {
    render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);
    const limitations = screen.getByRole("region", { name: "できないことと代わりの案" });
    expect(within(limitations).getByText("写真の添付")).toBeTruthy();
    expect(within(limitations).getByText("代わりに: 題名に写真の名前を書く")).toBeTruthy();
  });

  it("既定で決めたことを出す", () => {
    render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);
    const decided = screen.getByRole("region", { name: "既定で決めたこと" });
    expect(within(decided).getByText("画面の名前は「一覧」にする")).toBeTruthy();
  });

  it("要求の並びを出す", () => {
    render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);
    const requirements = screen.getByRole("region", { name: "つくるもの" });
    expect(within(requirements).getByText("一覧を新しい順に並べる")).toBeTruthy();
  });

  it("偽の時計で、答えの期限の残り分を出す", () => {
    render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);
    expect(screen.getByText("答えの期限まであと 30 分")).toBeTruthy();
  });

  it("「これで作る」で確定の要求を送る", () => {
    const onConfirm = vi.fn();
    render(<ConfirmPage job={jobOf()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "これで作る" }));
    expect(onConfirm).toHaveBeenCalledWith("build");
  });

  it("「直したい」はやめる要求を送る", () => {
    const onConfirm = vi.fn();
    render(<ConfirmPage job={jobOf()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "直したい" }));
    expect(onConfirm).toHaveBeenCalledWith("stop");
  });

  it("画面の文言に宣言の用語と ID の形を出さない", () => {
    const { container } = render(<ConfirmPage job={jobOf()} onConfirm={() => {}} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(container.textContent ?? "").not.toMatch(/\b[RI]\d+\b/);
  });
});
