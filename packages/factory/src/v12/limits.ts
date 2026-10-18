// v1.2 の呼び出しの上限の表（08-architecture-v1.2.md §4.1。手 3p・Issue #592）。
//
// 枠は 3 層である。
//
//   - **論理の枠は段ごと**（`V12_STAGE_FRAMES`）。段のコードが今までどおり数える（回数の定数はそのまま）。単位は束ごと／段全体／
//     版ごと／往復ごとのどれかを列に持つ。手 3p では束を作らないので、今の v1.1α の段がそのまま列に写る（`V12_V11A_FRAME_MAP`）。
//     束の行（C1・C2 の束）は手 3a・3b が足す
//   - **実試行の門は本全体で 1 つ**（`V12_CALL_LIMITS.realAttempts`）。Plan と同じ `CallGate` で、生成の呼び出し・その再送・判定の
//     呼び出し・Jev→LLM の切り替え・再点検を 1 つの数で数える
//   - **判定の枝**は門の中の別枝（`V12_CALL_LIMITS.judgeBranch`）。判定だけの上限で、尽きれば判定を呼ばず本は止めない
//
// 本全体の論理呼び出し（`V12_CALL_LIMITS.logicalCalls`）は実行時の門を作らない——段の記録から数えた論理要求の合計が超えない
// ことを契約試験で固定する（実試行の門が先に効く）。
//
// 旗 `v12.ids`（`V12Flags.ids`。既定 off）が on の走りだけが、この表の門と枝を使う。off の走りは v1・v1.1α の上限の表
// （`AGENT_LIMITS`。`callCount` 24・判定は門に数えない）をそのまま通る。**`AGENT_LIMITS` には足さない。** 探索型の直しの予算の行
// （`SEARCH_REPAIR_BUDGET`。手 4a）も v1.2 の別の表で、ループの行はそこから写す。
import { AGENT_LIMITS } from "../limits.js";
import type { StageId } from "../record.js";
import type { RuleDefinition } from "../stages/prompt.js";
import { SEARCH_REPAIR_BUDGET } from "./search-repair.js";

// ── 本全体の暫定の上限 ─────────────────────────────────────────────

/** 本全体の暫定の上限（最初の 30 本の計測で見直す。値ごとの理由と見直す条件は `V12_CALL_LIMIT_DEFINITIONS`） */
export const V12_CALL_LIMITS = {
  /** 論理呼び出し（段がコードで組んだ要求の合計）。実行時の門は作らず、契約試験で固定する */
  logicalCalls: 72,
  /** 実試行の門（生成と判定で共有する `CallGate` の上限） */
  realAttempts: 144,
  /** 判定の枝（判定だけの実試行の上限。門の中の別枝） */
  judgeBranch: 80,
} as const;

/** 本全体の上限の名前 */
export type V12CallLimitName = keyof typeof V12_CALL_LIMITS;

/** 本全体の上限の組（走らせる部分が受け取る。既定は `V12_CALL_LIMITS`。試験は差し替える） */
export type V12CallLimits = { readonly [K in V12CallLimitName]: number };

/** 上限の定義（規則と同じく `why`・`since` を持ち、見直す条件 `review` を足す） */
export interface V12LimitDefinition extends RuleDefinition {
  readonly limit: V12CallLimitName;
  /** 見直す条件（最初の 30 本の計測で何が起きたら見直すか） */
  readonly review: string;
}

/** 本全体の上限の定義（値ごとに `why`・`since`・見直す条件） */
export const V12_CALL_LIMIT_DEFINITIONS: readonly V12LimitDefinition[] = [
  {
    id: "L-v12-01",
    limit: "logicalCalls",
    text: `本全体の論理呼び出しは ${String(V12_CALL_LIMITS.logicalCalls)} まで（実行時の門は作らず、段の記録から数えた論理要求の合計で契約試験が固定する）。`,
    why: "08 §4.1 の表の論理の最大 58 に、観測した最大の要件 25 で C2 が束 5 になる分 +6 と余白を足した暫定の値",
    since: "Issue #592",
    review: "最初の 30 本で門の停止が 1 本以上あれば、上限を上げる前に束の大きさを見直す",
  },
  {
    id: "L-v12-02",
    limit: "realAttempts",
    text: `実試行の門は本全体で 1 つ、${String(V12_CALL_LIMITS.realAttempts)} まで（生成の呼び出し・その再送・判定の呼び出し・Jev→LLM の切り替え・再点検の合計）。尽きれば生成は call-limit で止まる。`,
    why: "生成側の論理 72 × 通信の試行 2 から選んだ全体の暫定の打ち切り値（08 §4.1）。判定も通る門で全経路を完走できる上界ではない。締切 20 分・1 本 0.30 USD は変えない",
    since: "Issue #592",
    review: "実試行が論理の 1.2 倍を超えた本があれば通信の再送を調べる。門の停止が 1 本以上あれば束の大きさを見直す",
  },
  {
    id: "L-v12-03",
    limit: "judgeBranch",
    text: `判定の枝は ${String(V12_CALL_LIMITS.judgeBranch)} まで（判定だけの実試行。門の中の別枝）。尽きれば判定を呼ばず、J4 は未判定（gate）、J2 は ruled、落とし先へ切り替えず、本は止めない。`,
    why: "J4 は要件ごと 1 回 × 最大 2 回の点検、J2 は安全側に食い違いごと 1 回と仮定（要件 25 で 75 以下。再送の前の見積もり。08 §4.1）。判定は助言なので尽きても受理で埋めない（#432・#469）",
    since: "Issue #592",
    review: "判定の枝が尽きた本が出れば、J4 を束にするか枝を広げる",
  },
];

// ── 段ごとの論理の枠（§4.1 の列）─────────────────────────────────────

/** 枠の単位（束ごと／段全体／版ごと／往復ごと） */
export const V12_FRAME_UNITS = ["bundle", "stage", "version", "round-trip"] as const;
export type V12FrameUnit = (typeof V12_FRAME_UNITS)[number];

/** 単位の人が読む名前（§4.1 の列の書き方） */
export const V12_FRAME_UNIT_LABELS: Readonly<Record<V12FrameUnit, string>> = {
  bundle: "束ごと",
  stage: "段全体",
  version: "版ごと",
  "round-trip": "往復ごと",
};

/** 枠の 1 欄（回数と単位） */
export interface V12FrameCount {
  readonly count: number;
  readonly unit: V12FrameUnit;
}

/** v1.2 の段（§4 の段の列のうち、§4.1 の表に枠を持つ段） */
export const V12_FRAME_STAGES = ["C1", "C2", "C3", "C4", "C6", "loop", "rewrite"] as const;
export type V12FrameStage = (typeof V12_FRAME_STAGES)[number];

/** 段ごとの論理の枠の 1 行（初回・形のやり直し・中身のやり直し〔点検・修復・裁定を含む〕。無い欄は null） */
export interface V12StageFrame {
  readonly stage: V12FrameStage;
  readonly initial: V12FrameCount | null;
  readonly shape: V12FrameCount | null;
  readonly content: V12FrameCount | null;
  /** 版・往復の上限（版ごと・往復ごとの段だけ。ほかは null） */
  readonly maxUnits: number | null;
}

/**
 * 段ごとの論理の枠（§4.1 の列のまま）。C5（宣言のコンパイル）は手 6 の段で、この表にはまだ行を置かない。
 * ループの往復は探索型の直しの予算の行（`SEARCH_REPAIR_BUDGET`）、空の文脈での作り直しも同じ行から写す。
 */
export const V12_STAGE_FRAMES: readonly V12StageFrame[] = [
  { stage: "C1", initial: { count: 1, unit: "bundle" }, shape: { count: 1, unit: "bundle" }, content: null, maxUnits: null },
  {
    stage: "C2",
    initial: { count: 1, unit: "bundle" },
    shape: { count: 1, unit: "bundle" },
    content: { count: 1, unit: "bundle" },
    maxUnits: null,
  },
  {
    stage: "C3",
    initial: { count: 1, unit: "stage" },
    shape: { count: 1, unit: "stage" },
    content: { count: 1, unit: "stage" },
    maxUnits: null,
  },
  { stage: "C4", initial: { count: 1, unit: "bundle" }, shape: { count: 1, unit: "bundle" }, content: null, maxUnits: null },
  {
    stage: "C6",
    initial: { count: 1, unit: "version" },
    shape: { count: 2, unit: "stage" },
    content: null,
    maxUnits: AGENT_LIMITS.declChecks,
  },
  {
    stage: "loop",
    initial: null,
    shape: { count: 1, unit: "round-trip" },
    // 欄の置き換え 往復ごと 1 ＋ 裁定 往復ごと 0〜1
    content: { count: 2, unit: "round-trip" },
    maxUnits: SEARCH_REPAIR_BUDGET.repairRoundTrips,
  },
  {
    stage: "rewrite",
    initial: null,
    shape: { count: SEARCH_REPAIR_BUDGET.rewriteShapeRetries, unit: "stage" },
    content: { count: SEARCH_REPAIR_BUDGET.rewrites, unit: "stage" },
    maxUnits: null,
  },
];

/** 段ごとの論理の枠の定義（行ごとに `why`・`since`） */
export const V12_STAGE_FRAME_DEFINITIONS: readonly (RuleDefinition & { readonly stage: V12FrameStage })[] = [
  { id: "F-v12-c1", stage: "C1", text: "C1（語彙）は束ごとに初回 1・形のやり直し 1。", why: "08 §4.1 の C1 の行（束 3。束ごとに形 1 回）", since: "Issue #592" },
  {
    id: "F-v12-c2",
    stage: "C2",
    text: "C2（要件の写像）は束ごとに初回 1・形のやり直し 1・中身のやり直し 1（C3 の拒否で該当の束だけ）。",
    why: "08 §4.1 の C2 の行（要件 5 件ごとの束。やり直しの形の再試行は無し）",
    since: "Issue #592",
  },
  {
    id: "F-v12-c3",
    stage: "C3",
    text: "C3（表の意味の点検）は段全体で初回 1・形のやり直し 1・拒否後の再点検 1。",
    why: "08 §4.1 の C3 の行（T1'' と同じ）",
    since: "Issue #592",
  },
  { id: "F-v12-c4", stage: "C4", text: "C4（試験）は束ごとに初回 1・形のやり直し 1。", why: "08 §4.1 の C4 の行（値が要る試験 13 件ごとの束）", since: "Issue #592" },
  {
    id: "F-v12-c6",
    stage: "C6",
    text: `C6（宣言の意味の点検）は版ごとに 1・形のやり直しは段全体で 2・版は ${String(AGENT_LIMITS.declChecks)} まで。`,
    why: "08 §4.1 の C6 の行（B3' そのまま。版の上限は v1.1α の declChecks と同じ値）",
    since: "Issue #592",
  },
  {
    id: "F-v12-loop",
    stage: "loop",
    text: `ループは往復 ${String(SEARCH_REPAIR_BUDGET.repairRoundTrips)} まで。往復ごとに形のやり直し 1・欄の置き換え 1・裁定 0〜1。`,
    why: "08 §4.1 のループの行（往復 6 は v1 の repairRoundTrips と同じ値。探索型の直しの予算の行から写す）",
    since: "Issue #592",
  },
  {
    id: "F-v12-rewrite",
    stage: "rewrite",
    text: `空の文脈での作り直しは段全体で ${String(SEARCH_REPAIR_BUDGET.rewrites)} 回・形のやり直し ${String(SEARCH_REPAIR_BUDGET.rewriteShapeRetries)}。`,
    why: "08 §4.1 の「空の文脈での作り直し（停滞時）」の行（探索型の直しの予算の行から写す）",
    since: "Issue #592",
  },
];

/**
 * 今の v1.1α の段が、枠のどの行に写るか（手 3p は束を作らないので、段全体が 1 つの束に当たる。束の行は手 3a・3b が足す）。
 * `rounds` は段の中身のやり直しを含む回数（T1 2 回・T2 2 回）、`shapeAttempts` は 1 回の要求の形の試行（2＝形のやり直し 1）、
 * `units` は版・往復の上限（B3' 6 版・B5 往復 6）。値は段のコードの定数と同じで、試験が照らす（ここで値を変えない）。
 */
export const V12_V11A_FRAME_MAP: readonly {
  readonly v11a: StageId;
  readonly frames: readonly V12FrameStage[];
  readonly rounds: number;
  readonly shapeAttempts: number;
  readonly units: number | null;
}[] = [
  { v11a: "name-table", frames: ["C1", "C2"], rounds: 2, shapeAttempts: 2, units: null },
  { v11a: "semantic-check", frames: ["C3"], rounds: 2, shapeAttempts: 2, units: null },
  { v11a: "test-spec", frames: ["C4"], rounds: 2, shapeAttempts: 2, units: null },
  { v11a: "decl-check", frames: ["C6"], rounds: 1, shapeAttempts: 2, units: AGENT_LIMITS.declChecks },
  { v11a: "repair", frames: ["loop"], rounds: 1, shapeAttempts: 2, units: AGENT_LIMITS.repairRoundTrips },
  { v11a: "arbitration", frames: ["loop"], rounds: 1, shapeAttempts: 2, units: AGENT_LIMITS.repairRoundTrips },
  // B1 の初回は C5（手 6）の段でこの表の外。B1 の空の文脈での作り直し（旗 v12.search-repair）がこの行に写る
  { v11a: "write", frames: ["rewrite"], rounds: 1, shapeAttempts: 2, units: null },
];

/**
 * 旗 `v12.ids` の段（手 3a。Issue #593）が、枠のどの行に写るか。C1 は束 3 つ（`units`）で、束ごとに初回 1・形のやり直し 1
 * （`shapeAttempts` 2）。C2 は束 1 つ（全要件を 1 回で写す。手 3b の要件 5 件ごとの束は Issue #627 で戻した）で、初回の形の
 * やり直し 1・C3 の拒否のあとの 2 回目 1（`rounds` 2。2 回目は形の再試行を持たない）。値は段のコードの定数と同じで、試験が照らす
 * （ここで値を変えない）。
 */
export const V12_IDS_FRAME_MAP: readonly {
  readonly stage: StageId;
  readonly frame: V12FrameStage;
  readonly rounds: number;
  readonly shapeAttempts: number;
  readonly units: number;
  /** 段の論理要求の最大（初回・形のやり直し・中身のやり直しの合計） */
  readonly maxLogical: number;
}[] = [
  { stage: "vocabulary", frame: "C1", rounds: 1, shapeAttempts: 2, units: 3, maxLogical: 6 },
  { stage: "mapping", frame: "C2", rounds: 2, shapeAttempts: 2, units: 1, maxLogical: 3 },
];

// ── 旗 `v12.ids` の T2 の束（手 3f・Issue #626）──────────────────────────

/**
 * T2（C4）の束の大きさと同時数。残る要件の一覧を一覧の順で `size` 件ごとに切り（最後の束は `size` 未満でよい）、束の呼び出しを
 * `concurrency` 本まで同時に始める（超えた分は待つ）。値ごとの理由と見直す条件は `V12_T2_BUNDLE_DEFINITIONS`
 */
export const V12_T2_BUNDLE = {
  /** 1 束の要件の数（手 3b の C2 の束と同じ 5） */
  size: 5,
  /** 同時に始める束の数の上限（観測した最大の要件 25 で束 5） */
  concurrency: 5,
} as const;

/** T2 の束の定数の定義（値ごとに `why`・`since`・見直す条件） */
export const V12_T2_BUNDLE_DEFINITIONS: readonly (RuleDefinition & {
  readonly key: keyof typeof V12_T2_BUNDLE;
  readonly review: string;
})[] = [
  {
    id: "B-v12-t2-size",
    key: "size",
    text: `T2 は残る要件を一覧の順で ${String(V12_T2_BUNDLE.size)} 件ごとの束に切り、束ごとに 1 つの論理呼び出しにする。`,
    why: "1 回の応答が大きいほど 1 回が長く、やり直しが全部を動かす（手 3b の C2 と同じ構造）。束の大きさは C2 の束と同じ 5",
    since: "Issue #626",
    review: "束ごとの推論の固定分で出力トークンが 1.6 倍を超えれば束を大きくする。束で 1 回目の通過率が下がれば小さくする",
  },
  {
    id: "B-v12-t2-concurrency",
    key: "concurrency",
    text: `T2 の束の呼び出しは ${String(V12_T2_BUNDLE.concurrency)} 本まで同時に始め、超えた束は先の束の終わりを待つ。`,
    why: "観測した最大の要件 25 で束 5 を 1 度に始め、壁の時間を 1 束分に近づける（逐次の合計にしない）",
    since: "Issue #626",
    review: "計測で提供側の同時数の制限による待ち・再送が出れば、この値を下げる（再送の口は変えない）",
  },
];
