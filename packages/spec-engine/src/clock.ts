// 評価に差し込む時計（Issue #98。workspace/mvp/m1/00-open-questions.md Q17）。
//
// **評価は時計を引数で受け取り、内部で現在時刻を読まない。** M1.3 で「今日」（`today()`）が入ったので、
// 値が時計に依存する式が書けるようになった——だからこそ、読む場所をここ 1 か所に閉じる
// （採点は時計を固定した unit テストで行う。Q17）。
//
// **API に時計を書き換える入口は作らない**（Q17）。どの時計を使うかは、呼ぶ側（data-api とテスト）が決める。
// staging の e2e は時計に依存しない値だけを見る（README「評価」）。

/** 評価が見る「今」。ミリ秒（Unix epoch） */
export interface Clock {
  now(): number;
}

/**
 * オフセット付きの ISO 8601。採点のシナリオの `2026-09-16T12:00:00+09:00` と、`...Z` を読む。
 *
 * **オフセットを必須にする。** 書いていない時刻（`2026-09-16T12:00:00`）は、実行する環境の
 * 時間帯によって別の瞬間を指す。決定的でなくなるので、読める形から外す。
 */
export const CLOCK_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 差し込める時刻の形か（形と、実際に日時として読めることの両方を見る） */
export function isClockInstant(text: string): boolean {
  return CLOCK_INSTANT_PATTERN.test(text) && !Number.isNaN(Date.parse(text));
}

/**
 * 時刻を固定した時計（採点のシナリオの時計）。読めない時刻は例外にする——
 * 呼ぶ側が書いた定数の誤りであり、黙って別の時刻で採点すると緑の意味が変わる。
 */
export function fixedClock(instant: string): Clock {
  if (!isClockInstant(instant)) {
    throw new Error(
      `時計の時刻を読めない: ${instant}（オフセット付きの ISO 8601 で書く。例 2026-09-16T12:00:00+09:00）`,
    );
  }
  const milliseconds = Date.parse(instant);
  return { now: () => milliseconds };
}

/**
 * 実際の現在時刻を見る時計。data-api のリクエストの経路が使う（テストは fixedClock を使う）。
 * **ここだけが現在時刻を読む。** 評価の中は、渡された時計を通してだけ時刻に触れる。
 */
export function systemClock(): Clock {
  return { now: () => Date.now() };
}

/**
 * 日本時間（Asia/Tokyo）の UTC からのずれ（分）。**日本には夏時間が無いので、固定の +09:00 で数えられる。**
 */
export const TOKYO_OFFSET_MINUTES = 9 * 60;

/**
 * 日本時間（Asia/Tokyo）の「今日」を `YYYY-MM-DD` で返す（Issue #155。Q13）。
 *
 * **現在時刻は時計からだけ読む**（`clock.now()`）。式の評価は、この関数を通してだけ「今日」を知る——
 * だから採点は時計を固定すれば決定的になる（Q17）。端末の時間帯では数えない
 * （仲間うちで「今日」を揃えるためである。00-open-questions.md Q13）。
 */
export function todayInTokyo(clock: Clock): string {
  const shifted = new Date(clock.now() + TOKYO_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
