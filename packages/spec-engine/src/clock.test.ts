// 時計（評価に差し込む境界）の unit テスト（Issue #98。Q17）。
//
// ここで固定したいのは 3 つ。
//   1. 採点のシナリオの時刻（オフセット付き）を、その瞬間として読む
//   2. **オフセットの無い時刻を読まない**——実行する環境の時間帯で意味が変わり、採点が決定的でなくなる
//   3. 実際の時計（systemClock）は現在時刻を返す。テストは固定した時計を使う
import { describe, expect, it } from "vitest";
import { CLOCK_INSTANT_PATTERN, fixedClock, isClockInstant, systemClock } from "./clock.js";

/** 見本 expense-log の採点のシナリオの時計（appspec-schema の samples。ここでは値だけを使う） */
const SCENARIO_CLOCK = "2026-09-16T12:00:00+09:00";

describe("固定した時計（採点のシナリオ）", () => {
  it("オフセット付きの時刻を、その瞬間として読む", () => {
    const clock = fixedClock(SCENARIO_CLOCK);
    expect(clock.now()).toBe(Date.parse(SCENARIO_CLOCK));
    // 日本時間の 12:00 は、UTC の 03:00 である
    expect(clock.now()).toBe(Date.parse("2026-09-16T03:00:00Z"));
  });

  it("何度読んでも同じ時刻を返す（固定）", () => {
    const clock = fixedClock(SCENARIO_CLOCK);
    expect(clock.now()).toBe(clock.now());
  });

  it("Z のオフセットも読む", () => {
    expect(fixedClock("1999-12-31T23:59:59Z").now()).toBe(Date.parse("1999-12-31T23:59:59Z"));
  });

  it("小数点以下の秒も読む", () => {
    expect(fixedClock("2026-09-16T12:00:00.500+09:00").now()).toBe(
      Date.parse("2026-09-16T12:00:00.500+09:00"),
    );
  });

  it.each([
    ["オフセットが無い（実行する環境の時間帯で意味が変わる）", "2026-09-16T12:00:00"],
    ["オフセットの形が違う", "2026-09-16T12:00:00+0900"],
    ["日付の形が違う", "2026/09/16 12:00:00"],
    ["時刻ではない", "today"],
    ["空", ""],
  ])("%s 時刻は読まない", (_label, instant) => {
    expect(isClockInstant(instant)).toBe(false);
    expect(() => fixedClock(instant)).toThrow(/時計の時刻を読めない/);
  });

  it("日時として読めない値は、形が合っていても読まない", () => {
    // 形は合うが、月が 13 以上なので日時として読めない
    expect(CLOCK_INSTANT_PATTERN.test("2026-13-45T12:00:00+09:00")).toBe(true);
    expect(isClockInstant("2026-13-45T12:00:00+09:00")).toBe(false);
    expect(() => fixedClock("2026-13-45T12:00:00+09:00")).toThrow(/時計の時刻を読めない/);
  });
});

describe("実際の時計", () => {
  it("現在時刻を返す（テストは固定した時計を使う）", () => {
    const before = Date.now();
    const now = systemClock().now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
