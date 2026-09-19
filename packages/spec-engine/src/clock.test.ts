// 時計（評価に差し込む境界）の unit テスト（Issue #98。Q17。日本時間の「今日」は #155）。
//
// ここで固定したいのは 4 つ。
//   1. 採点のシナリオの時刻（オフセット付き）を、その瞬間として読む
//   2. **オフセットの無い時刻を読まない**——実行する環境の時間帯で意味が変わり、採点が決定的でなくなる
//   3. 実際の時計（systemClock）は現在時刻を返す。テストは固定した時計を使う
//   4. **「今日」（todayInTokyo）は日本時間（UTC+9）で数える**——端末の時間帯でも UTC でもない（Q13）
import { describe, expect, it } from "vitest";
import {
  CLOCK_INSTANT_PATTERN,
  TOKYO_OFFSET_MINUTES,
  fixedClock,
  isClockInstant,
  systemClock,
  thisMonthRangeInTokyo,
  todayInTokyo,
} from "./clock.js";

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

// ── 日本時間の「今日」（today()。#155。Q13） ─────────────────────────
//
// 「今日」は**店頭の時計で日本時間（UTC+9）**に数える。端末の時間帯でも、UTC でもない。
// 境界は 2 つある——UTC の日付が変わる時刻（日本時間 09:00）と、日本時間の日付が変わる時刻（UTC 15:00）。

describe("日本時間の「今日」", () => {
  it("日本時間のずれは +9 時間である（日本には夏時間が無い）", () => {
    expect(TOKYO_OFFSET_MINUTES).toBe(9 * 60);
  });

  it("採点のシナリオの時計（日本時間の 12:00）では、その日の日付になる", () => {
    expect(todayInTokyo(fixedClock(SCENARIO_CLOCK))).toBe("2026-09-16");
    // 日本時間の 12:00 は UTC の 03:00 である（同じ瞬間）
    expect(todayInTokyo(fixedClock("2026-09-16T03:00:00Z"))).toBe("2026-09-16");
  });

  it("UTC の日付が変わっても（日本時間 09:00 の前後でも）、日本時間の日付は変わらない（受入条件）", () => {
    // 日本時間の 08:59 は UTC の前日 23:59 である。UTC で数えれば「昨日」になる
    expect(todayInTokyo(fixedClock("2026-09-16T08:59:59+09:00"))).toBe("2026-09-16");
    // 日本時間の 09:00 に UTC の日付が変わるが、日本時間の日付は同じである
    expect(todayInTokyo(fixedClock("2026-09-16T09:00:00+09:00"))).toBe("2026-09-16");
    expect(todayInTokyo(fixedClock("2026-09-15T23:59:00Z"))).toBe("2026-09-16");
    expect(todayInTokyo(fixedClock("2026-09-16T00:00:00Z"))).toBe("2026-09-16");
  });

  it("日本時間の 00:00（UTC の 15:00）で日付が変わる", () => {
    expect(todayInTokyo(fixedClock("2026-09-16T14:59:59Z"))).toBe("2026-09-16");
    expect(todayInTokyo(fixedClock("2026-09-16T15:00:00Z"))).toBe("2026-09-17");
  });

  it("UTC の日付では数えない（両者が食い違う瞬間で確かめる）", () => {
    const clock = fixedClock("2026-09-15T15:30:00Z"); // 日本時間の 2026-09-16 00:30
    expect(new Date(clock.now()).toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(todayInTokyo(clock)).toBe("2026-09-16");
  });

  it("差し込んだ時計だけを読む（時計を替えれば「今日」も変わる）", () => {
    expect(todayInTokyo(fixedClock("2026-09-16T12:00:00+09:00"))).toBe("2026-09-16");
    expect(todayInTokyo(fixedClock("2026-09-17T12:00:00+09:00"))).toBe("2026-09-17");
    expect(todayInTokyo(fixedClock("2026-12-31T12:00:00+09:00"))).toBe("2026-12-31");
  });

  it("月と年をまたぐ境界でも、日本時間で数える", () => {
    // 日本時間の 2026-10-01 00:00（UTC の 2026-09-30 15:00）
    expect(todayInTokyo(fixedClock("2026-09-30T15:00:00Z"))).toBe("2026-10-01");
    // 日本時間の 2027-01-01 00:00（UTC の 2026-12-31 15:00）
    expect(todayInTokyo(fixedClock("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });

  it("返すのは YYYY-MM-DD の形である（保存する形と同じ）", () => {
    expect(todayInTokyo(fixedClock(SCENARIO_CLOCK))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── 日本時間の「今月」（within: this_month。#178。Q17） ────────────────
//
// 期間の条件（`within`）の境目は「**日本時間の月初 00:00:00 以上、翌月初 00:00:00 未満**」である。
// **時計は引数で受け取る**——式の評価の中で現在時刻を直接読まない（Q17）。

describe("日本時間の「今月」の範囲（within: this_month）", () => {
  it("採点のシナリオの時計（日本時間の 2026-09-15）では、2026-09 の半開区間になる", () => {
    expect(thisMonthRangeInTokyo(fixedClock(SCENARIO_CLOCK))).toEqual({
      from: "2026-09-01",
      to: "2026-10-01",
    });
  });

  it("月初の 0 時ちょうどは、その月に入る（受入条件）", () => {
    expect(thisMonthRangeInTokyo(fixedClock("2026-10-01T00:00:00+09:00"))).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
    });
  });

  it("前月の末日の 23:59 は、まだ前の月である（受入条件）", () => {
    expect(thisMonthRangeInTokyo(fixedClock("2026-09-30T23:59:59+09:00"))).toEqual({
      from: "2026-09-01",
      to: "2026-10-01",
    });
  });

  it("UTC の日付が変わっても、日本時間の「今月」で決める", () => {
    // UTC の 2026-09-30 15:00 は、日本時間の 2026-10-01 00:00 である
    expect(thisMonthRangeInTokyo(fixedClock("2026-09-30T15:00:00Z"))).toEqual({
      from: "2026-10-01",
      to: "2026-11-01",
    });
    // 日本時間の 2026-09-30 23:59（UTC はまだ 14:59）は、まだ 9 月である
    expect(thisMonthRangeInTokyo(fixedClock("2026-09-30T14:59:59Z"))).toEqual({
      from: "2026-09-01",
      to: "2026-10-01",
    });
  });

  it("年をまたぐ境目でも、日本時間で数える", () => {
    // 日本時間の 2026-12-31 → 2026-12 の区間。翌月初は 2027-01-01 である
    expect(thisMonthRangeInTokyo(fixedClock("2026-12-31T12:00:00+09:00"))).toEqual({
      from: "2026-12-01",
      to: "2027-01-01",
    });
    // 日本時間の 2027-01-01 00:00（UTC の 2026-12-31 15:00）
    expect(thisMonthRangeInTokyo(fixedClock("2026-12-31T15:00:00Z"))).toEqual({
      from: "2027-01-01",
      to: "2027-02-01",
    });
  });

  it("月をまたぐ境目でも、翌月初は翌月の 1 日である", () => {
    expect(thisMonthRangeInTokyo(fixedClock("2026-01-31T12:00:00+09:00"))).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(thisMonthRangeInTokyo(fixedClock("2026-02-28T12:00:00+09:00"))).toEqual({
      from: "2026-02-01",
      to: "2026-03-01",
    });
  });

  it("差し込んだ時計だけを読む（時計を替えれば「今月」も替わる）", () => {
    expect(thisMonthRangeInTokyo(fixedClock("2026-09-16T12:00:00+09:00")).from).toBe("2026-09-01");
    expect(thisMonthRangeInTokyo(fixedClock("2026-10-16T12:00:00+09:00")).from).toBe("2026-10-01");
  });
});
