// 公開先のインスタンス ID（studio-s1.md §6・Issue #868 の目的・3）。
//
// 工房から作るインスタンスは `studio-<YYYYMMDDHHmmss>` だけである。**画面から自由に決めさせない**し、
// env も受け取らない（公開先は staging に固定する。`publish.ts` の引数を組む関数も env を取らない）。
// 名前は手元の時刻で作る（所有者が手元で試すための使い捨ての場所である）。
export const STUDIO_INSTANCE_PREFIX = "studio-" as const;

/** `studio-` のあとに 14 桁の時刻（YYYYMMDDHHmmss）。 */
export const STUDIO_INSTANCE_PATTERN = /^studio-\d{14}$/u;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 時刻から、公開先のインスタンス ID を組む。 */
export function stampInstanceId(now: Date): string {
  const stamp =
    `${now.getFullYear()}` +
    `${pad2(now.getMonth() + 1)}` +
    `${pad2(now.getDate())}` +
    `${pad2(now.getHours())}` +
    `${pad2(now.getMinutes())}` +
    `${pad2(now.getSeconds())}`;
  return `${STUDIO_INSTANCE_PREFIX}${stamp}`;
}

/** 工房が作ったインスタンス ID の形か。 */
export function isStudioInstanceId(value: string): boolean {
  return STUDIO_INSTANCE_PATTERN.test(value);
}
