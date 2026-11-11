// 短い間隔の問い合わせ（Issue #869 の目的・2）。WebSocket は使わない（禁止事項）。
// 画面を外したら止める（component の unmount で interval を消す）。
import { useEffect, useRef, useState } from "react";

export const POLL_INTERVAL_MS = 2_000;
export const CLOCK_INTERVAL_MS = 30_000;

export interface PollingOptions {
  readonly intervalMs: number;
  /** 偽なら間隔を回さない（既定は真） */
  readonly enabled?: boolean;
}

export function usePolling(task: () => void | Promise<void>, options: PollingOptions): void {
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  const enabled = options.enabled ?? true;
  const intervalMs = options.intervalMs;

  useEffect(() => {
    if (!enabled) return;
    const run = async (): Promise<void> => {
      try {
        await taskRef.current();
      } catch {
        // 誤りは task 側が画面に出す。間隔は止めない。
      }
    };
    const id = setInterval(() => {
      void run();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}

/** 経過時間の表示を進めるための現在時刻（ms） */
export function useNow(intervalMs: number = CLOCK_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 答えの期限まであと何分か（切り上げ。過ぎていたら 0） */
export function remainingMinutes(deadlineAt: number | null, now: number): number | null {
  if (deadlineAt === null) return null;
  return Math.max(0, Math.ceil((deadlineAt - now) / 60_000));
}
