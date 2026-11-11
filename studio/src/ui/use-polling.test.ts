// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remainingMinutes, usePolling } from "./use-polling";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePolling", () => {
  it("決めた間隔で問い合わせる", () => {
    const task = vi.fn();
    renderHook(() => usePolling(task, { intervalMs: 2_000 }));

    expect(task).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(task).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("画面を外すと問い合わせを止める", () => {
    const task = vi.fn();
    const { unmount } = renderHook(() => usePolling(task, { intervalMs: 2_000 }));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(task).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("偽なら問い合わせない", () => {
    const task = vi.fn();
    renderHook(() => usePolling(task, { intervalMs: 2_000, enabled: false }));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(task).not.toHaveBeenCalled();
  });
});

describe("remainingMinutes", () => {
  it("期限までの分を切り上げる", () => {
    expect(remainingMinutes(25 * 60_000, 0)).toBe(25);
    expect(remainingMinutes(25 * 60_000 - 1, 0)).toBe(25);
    expect(remainingMinutes(24 * 60_000 + 1, 0)).toBe(25);
  });

  it("過ぎていたら 0、期限が無ければ null", () => {
    expect(remainingMinutes(-1, 0)).toBe(0);
    expect(remainingMinutes(null, 0)).toBeNull();
  });
});
