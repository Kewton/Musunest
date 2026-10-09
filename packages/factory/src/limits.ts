// 共通の上限値（02-architecture.md §1.5・§2.2）。
//
// 段（パイプライン）と adapter が**同じ定数**を使うために 1 か所へ置く。値を 2 か所に書くと、
// 「検査は通るのに店頭で動かない」ずれが生まれる。どの段がどの上限をどこで確かめるかは
// `LIMIT_GUARDS` に型として置き、コメントで補う（§1.5・§2.2）。
//
// 値の出所：
//   requestTextChars・callCount・repairRoundTrips … §1.5 の表（案）
//   そのほか … §1.5・§2.2 が「上限を置く」とだけ決め、値は決めていないので、段階 1 の案として置く

export const AGENT_LIMITS = {
  /** 依頼文（原文）の文字数。超えたら受け付けない（§1.5「依頼文は 4,000 文字まで（案）」） */
  requestTextChars: 4_000,
  /** 宣言（`app.spec.yaml` のバイト列）の大きさ。spec-engine は式の上限だけなので、宣言全体はここで見る（R-5） */
  declarationBytes: 65_536,
  /** 要件 1 件あたりの試験の数（②'。§2.2「試験の数に上限を置く」） */
  testsPerRequirement: 16,
  /** 試験 1 件が参照するデータの行数（②'。§2.2「参照データの行数」） */
  referenceRowsPerTest: 64,
  /** 記録（往復の記録）の行数。偽物の LlmClient が返す記録も、これで抑える（§2.1） */
  recordRows: 256,
  /** ジョブ全体の LLM 呼び出しの回数（§1.5「全体で 24 回（案）」）。**再試行も数える** */
  callCount: 24,
  /** ジョブ全体の道具の呼び出しの回数（§1.5「⑥ の中の道具の呼び出しも数える」） */
  toolCalls: 24,
  /** 直しの往復の合計（§1.5「6 回」）。④→⑥→④ と ⑤→⑥ の往復の合計 */
  repairRoundTrips: 6,
} as const;

/** 上限の名前（`AGENT_LIMITS` の欄の名前） */
export type LimitName = keyof typeof AGENT_LIMITS;

/** 上限の値の組（段が受け取る上限。既定は `AGENT_LIMITS`） */
export type AgentLimits = { readonly [K in LimitName]: number };

/**
 * どの段が、どの上限を、どこで確かめるか（§1.5・§2.2）。
 *
 * - **入口で確かめる** … ①（`requestTextChars`）
 * - **組にするときに確かめる** … ②'（`testsPerRequirement`・`referenceRowsPerTest`）
 * - **呼ぶ前に確かめる** … 共通の口（`call.ts` が `callCount`・`toolCalls` を数える）
 * - **版ごとに確かめる** … ④・⑥（`declarationBytes`）
 * - **往復を数える** … ⑥→④・⑤（`repairRoundTrips`）
 *
 * `satisfies` で、`AGENT_LIMITS` のすべての上限に番人が書かれていることをコンパイル時に確かめる。
 */
export const LIMIT_GUARDS = {
  requestTextChars: "ステージ①（要件にする）の入口",
  declarationBytes: "ステージ④（静的チェック）と⑥（直す）。版ごとに確かめる",
  testsPerRequirement: "ステージ②'（試験を作って固定する）",
  referenceRowsPerTest: "ステージ②'（試験を作って固定する）",
  recordRows: "偽物の LlmClient の記録（試験）と、段ごとの記録",
  callCount: "共通の口（call.ts）。呼ぶ前に数える",
  toolCalls: "共通の口（call.ts）。道具付きの呼び出しで数える",
  repairRoundTrips: "ステージ⑥（直す）から④・⑤ への往復",
} as const satisfies Record<LimitName, string>;

/** 上限を超えたときの内容 */
export interface LimitExceeded {
  readonly limit: LimitName;
  /** 上限 */
  readonly max: number;
  /** 実際の値 */
  readonly actual: number;
}

/**
 * 上限に照らす。超えていれば内容を、収まっていれば `undefined` を返す。
 * 数えられる値（文字数・バイト数・行数・回数）は 0 以上の整数であること——そうでない値は、
 * 呼ぶ側の数え方の誤りなので例外にする（黙って通すと、上限が効いたつもりで効かない）。
 */
export function checkLimit(limit: LimitName, actual: number): LimitExceeded | undefined {
  if (!Number.isInteger(actual) || actual < 0) {
    throw new RangeError(`上限に照らす値は 0 以上の整数であること: ${limit}=${String(actual)}`);
  }
  const max = AGENT_LIMITS[limit];
  return actual > max ? { limit, max, actual } : undefined;
}

/** 依頼文（原文）の文字数の上限を確かめる（① の入口。§1.5） */
export function checkRequestText(text: string): LimitExceeded | undefined {
  return checkLimit("requestTextChars", text.length);
}

/** 宣言（バイト列）の大きさの上限を確かめる（④・⑥。R-5） */
export function checkDeclarationBytes(byteLength: number): LimitExceeded | undefined {
  return checkLimit("declarationBytes", byteLength);
}
