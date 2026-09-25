// e2e/src/ui/redact.ts — 画面テストの出力から、宛先（URL・ホスト名）・Account ID・資格情報を伏せ、
// レポートへの混入を機械で断つ（Issue #233）。
//
// 画面テストは staging の本物の宛先を相手にする。宛先のオリジンは環境変数で渡し、
// **ログにもレポートにも出さない**（`e2e/src/cli.ts` と同じ扱い。`CLAUDE.md`「このリポジトリは public である」）。
// 写真（PNG）はピクセルなので URL を写さないが、**手順の期待・実際の文**には、画面の文字や例外の文言が
// 紛れ込みうる。だから書き出す前に、**混入を機械で見つけて失敗にする**——人が見て気づくのに頼らない
// （#110 の e2e が、ログの側で同じことをしている）。
//
// 見つけた理由は**値を含めずに**言う（`CLOUDFLARE_ACCOUNT_ID の値` のように名前だけ）。
// 例外の文言に値を載せると、失敗の報告そのものが漏えいになる。

import { CREDENTIAL_ENVS } from "../cli.js";

export { CREDENTIAL_ENVS };

/** 伏せ字に置き換えるときの文字列 */
export const REDACTED = "<伏せた>";

/** 値を出さずに「何が混入したか」を言うための組 */
export interface SecretValue {
  /** 伏せる理由の名前（環境変数の名前など）。**値そのものは入れない** */
  readonly name: string;
  readonly value: string;
}

/** 置き換え用（`g`）。`replace` は `lastIndex` に依らないので、使い回してよい */
const URL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const WORKERS_DEV = /(?:[a-z0-9_-]+\.)+workers\.dev(?![a-z0-9_-])/gi;
const ACCOUNT_ID = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g;

// **検査用（`g` を付けない）。** `test` は `g` 付きだと `lastIndex` を進めるので、検査と置き換えで分ける。
// Account ID の形は前後を 16 進で挟まない 32 桁である——**commit の 40 桁や SHA-256 の 64 桁を拾わない**
// （`\b` は `-` の前でも切れるので、`[0-9a-f]{32}` が 40 桁の一部に当たってしまう。前後を見る）。
const URL_SHAPE_FIND = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i;
const WORKERS_DEV_FIND = /(?:[a-z0-9_-]+\.)+workers\.dev(?![a-z0-9_-])/i;
const ACCOUNT_ID_FIND = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/;

/** レポートの書き出しを止めるときの失敗。**値を持たない** */
export class SecretLeakError extends Error {
  override name = "SecretLeakError";
}

/** 1 行を伏せる。渡された値 → workers のドメイン → URL → Account ID の形 の順に置き換える */
export function redactLine(line: string, values: readonly string[]): string {
  let out = line;
  for (const value of values) {
    if (value.length >= 8) out = out.split(value).join(REDACTED);
  }
  return out.replace(WORKERS_DEV, REDACTED).replace(URL_SHAPE, REDACTED).replace(ACCOUNT_ID, REDACTED);
}

/**
 * 混入しているものを、**値を含めない名前**で返す（重複は畳む）。
 * 渡された値は 8 文字以上だけを探す——短い値は普通の文字列に当たって誤検知になるためである。
 */
export function findLeaks(texts: readonly string[], secrets: readonly SecretValue[]): readonly string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const secret of secrets) {
      if (secret.value.length >= 8 && text.includes(secret.value)) found.add(`${secret.name} の値`);
    }
    if (URL_SHAPE_FIND.test(text)) found.add("URL");
    if (WORKERS_DEV_FIND.test(text)) found.add("workers の既定のドメイン");
    if (ACCOUNT_ID_FIND.test(text)) found.add("Account ID の形（16 進 32 桁）");
  }
  return [...found];
}

/** 混入があれば止める。**書き出す前に呼ぶ**（既存のレポートを壊さない） */
export function assertNoSecrets(texts: readonly string[], secrets: readonly SecretValue[]): void {
  const leaks = findLeaks(texts, secrets);
  if (leaks.length > 0) {
    throw new SecretLeakError(
      `レポートに秘密が混入している（${leaks.join("・")}）。**値を消してから流し直す**（レポートを手で直さない）`,
    );
  }
}
