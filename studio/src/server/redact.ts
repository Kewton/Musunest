// 子の出力から、記録・応答に出してはいけない値を伏せる（Issue #868 の目的・5）。
//
// 公開の子（publish-bundle）は、トークン・Account ID・ホスト名・URL を出さない作りだが、
// 想定外の出力が混じっても保存・API の応答に出さないように、工房の側でも伏せる。
// 伏せる対象は次の 3 つである。
//   - 32 桁の 16 進（Cloudflare の Account ID）
//   - workers.dev のホスト（サブドメインを含む）
//   - `https://`・`http://` で始まる URL
//
// 64 桁の 16 進（納品物の manifest の SHA-256）は伏せない。32 桁の 16 進の照合は単語の境界で行うので、
// 64 桁の文字列の内側には当たらない。
export const REDACTED = "[伏せた]" as const;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/giu;
const WORKERS_DEV_PATTERN = /\b(?:[a-z0-9-]+\.)*workers\.dev\b/giu;
const HEX32_PATTERN = /\b[0-9a-f]{32}\b/giu;

/** 伏せるべき値が混じっているか（試験と、保存前の確認に使う）。 */
export function containsSecret(text: string): boolean {
  URL_PATTERN.lastIndex = 0;
  WORKERS_DEV_PATTERN.lastIndex = 0;
  HEX32_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(text) || WORKERS_DEV_PATTERN.test(text) || HEX32_PATTERN.test(text);
}

/** 32 桁の 16 進・workers.dev・URL を `[伏せた]` に置き換える。 */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_PATTERN, REDACTED)
    .replace(WORKERS_DEV_PATTERN, REDACTED)
    .replace(HEX32_PATTERN, REDACTED);
}
