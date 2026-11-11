// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiQuestionBundle } from "../../shared/api";
import { QuestionsPage } from "./QuestionsPage";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const bundleOf = (): ApiQuestionBundle => ({
  revision: 3,
  questions: [
    {
      id: "q1",
      text: "一覧はどの順に並べますか？",
      choices: [
        { id: "newest", text: "新しい順" },
        { id: "oldest", text: "古い順" },
      ],
      recommended: { choiceId: "newest", reason: "最近のものから見られるから" },
      allowFreeText: true,
    },
    {
      id: "q2",
      text: "題名は何にしますか？",
      choices: [
        { id: "list", text: "一覧" },
        { id: "memo", text: "メモ" },
      ],
      recommended: { choiceId: "list", reason: "分かりやすいから" },
      allowFreeText: false,
    },
  ],
  remaining: { questions: 7, roundTrips: 2 },
  deadlineAt: Date.now() + 25 * 60_000,
});

describe("QuestionsPage", () => {
  it("おすすめの印と理由を出す", () => {
    render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    expect(screen.getAllByText("おすすめ")).toHaveLength(2);
    expect(screen.getByText("おすすめの理由: 最近のものから見られるから")).toBeTruthy();
  });

  it("往復 n/3 と残りの問数を出す", () => {
    render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    expect(screen.getByText("往復 1/3")).toBeTruthy();
    expect(screen.getByText("残りの問数 7")).toBeTruthy();
  });

  it("偽の時計で、答えの期限の残り分を出す", () => {
    render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    expect(screen.getByText("答えの期限まであと 25 分")).toBeTruthy();
  });

  it("全部推奨で進めるは全部推奨の要求を送る", () => {
    const onAnswer = vi.fn();
    render(<QuestionsPage bundle={bundleOf()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "全部推奨で進める" }));
    expect(onAnswer).toHaveBeenCalledWith({ kind: "all-recommended", revision: 3 });
  });

  it("自由入力が 500 字を超えると送れない", () => {
    render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    fireEvent.change(screen.getByLabelText("自由に入力する"), {
      target: { value: "あ".repeat(501) },
    });
    const button = screen.getByRole("button", { name: "この答えで進める" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("501/500")).toBeTruthy();
    expect(screen.getByText("自由入力は 500 字までです。")).toBeTruthy();
  });

  it("未回答の問いがあれば送れない", () => {
    render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    const button = screen.getByRole("button", { name: "この答えで進める" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("すべての問いに答えてください。")).toBeTruthy();
  });

  it("問いごとの答え（選択肢）を版つきで送る", () => {
    const onAnswer = vi.fn();
    render(<QuestionsPage bundle={bundleOf()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByLabelText("新しい順"));
    fireEvent.click(screen.getByLabelText("一覧"));
    fireEvent.click(screen.getByRole("button", { name: "この答えで進める" }));
    expect(onAnswer).toHaveBeenCalledWith({
      kind: "answers",
      revision: 3,
      answers: [
        { questionId: "q1", choiceId: "newest" },
        { questionId: "q2", choiceId: "list" },
      ],
    });
  });

  it("自由入力の答えを送る", () => {
    const onAnswer = vi.fn();
    render(<QuestionsPage bundle={bundleOf()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("自由に入力する"), {
      target: { value: "思いついた順" },
    });
    fireEvent.click(screen.getByLabelText("一覧"));
    fireEvent.click(screen.getByRole("button", { name: "この答えで進める" }));
    expect(onAnswer).toHaveBeenCalledWith({
      kind: "answers",
      revision: 3,
      answers: [
        { questionId: "q1", freeText: "思いついた順" },
        { questionId: "q2", choiceId: "list" },
      ],
    });
  });

  it("画面の文言に宣言の用語と ID の形を出さない", () => {
    const { container } = render(<QuestionsPage bundle={bundleOf()} onAnswer={() => {}} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(container.textContent ?? "").not.toMatch(/\b[RI]\d+\b/);
  });
});
