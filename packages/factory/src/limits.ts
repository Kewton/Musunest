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
  /**
   * ジョブ全体の道具の呼び出しの回数（§1.5「⑥ の中の道具の呼び出しも数える」）。**共通の口の累計**
   * （`toolCalls` の getter）を、道具の束を**実行する前に**照らす——⑥ を複数回回しても、ジョブ全体の
   * 線を越えない（Issue #429）。
   */
  toolCalls: 24,
  /** 直しの往復の合計（§1.5「6 回」）。④→⑥→④ と ⑤→⑥ の往復の合計 */
  repairRoundTrips: 6,
  /**
   * 1 回の直す段（`runRepairStep`）の中で、共通の口から**成功して受け取った応答**（道具の束・最後の
   * 答え・最後の答えの形の直しの応答）の数の上限（§1.5・Issue #429）。値は **8**（所有者の決定
   * 2026-10-12）——道具 3 種 × 2 回の試行と、最後の答えの形の直し 1 回を収める。**再試行を含む実試行
   * 数や、usage を観測した段の `calls` とは別**に数える。
   */
  repairStepTurns: 8,
  /**
   * ③ の対応の表（役割 ID → 宣言の名前）の出し直しの回数（§1.5・§1.3.1・R2-12）。
   * 対応の表の不備（実在しない名前・種類違い・対応表の外）は ⑥ ではなく ③ のやり直しへ回す（#309）。
   * **この呼び出しも共通の口を通す**ので、予約と総呼び出しの上限に数えられる。
   */
  correspondenceRedos: 2,
  /**
   * ⑤a 対応表の点検（版ごとの作り直し）の回数（§1.5・§1.3.1・R2-12）。宣言が変われば ⑤a を
   * 作り直すので、作り直しの回数に上限を置く。**この呼び出しも共通の口を通す**。
   */
  correspondenceChecks: 6,
  /**
   * v1.1α の B3' 宣言の意味の点検の回数（07-architecture-v1.1a.md §1・D16。Issue #505）。B2・B3 を通った
   * 版ごとに掛け直すので回数に上限を置く。値は v1 の `correspondenceChecks` と同じ 6。**この呼び出しも
   * 共通の口を通す**。v1 の経路では使わない。
   */
  declChecks: 6,
  /**
   * 停滞と見なす、同じ不一致の続いた回数（§1.3.1・R2-10）。試験 ID・段・誤りの分類が同じ不一致が
   * これだけ続いたら、⑥ はそれ以上直さない（未解決のまま部分案で終える）。
   */
  stagnationRepeats: 2,
  /**
   * Plan で**合わせて**聞ける質問の数（04-plan-agent.md §2・§6 の 2「合わせて 10 問まで」）。
   * **往復をまたいで数える**——直し・再開で上限を戻さない。
   */
  planQuestions: 10,
  /** Plan の質問の往復の回数（04 §2・§6 の 2「往復は 3 回まで」）。**直し・再開で戻さない** */
  planRoundTrips: 3,
  /** 1 問の選択肢の数の上限（04 §6 の 3「選択肢 2〜4」）。下限は `PLAN_CHOICES_MIN` */
  planChoices: 4,
  /** 自由入力（答え）の長さの上限（文字数。04 §6 の 6「自由入力の長さの上限」） */
  planFreeTextChars: 500,
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
 * - **行き先ごとに数える** … ③ のやり直し（`correspondenceRedos`）・⑤a の作り直し（`correspondenceChecks`）
 * - **停滞を数える** … ⑥（`stagnationRepeats`。同じ不一致が続いた回数）
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
  toolCalls: "共通の口（call.ts）の累計を、道具の束を実行する前に照らす（ジョブ全体・⑥）",
  repairRoundTrips: "ステージ⑥（直す）から④・⑤ への往復",
  repairStepTurns: "ステージ⑥（直す）の 1 回の段の中の応答の往復",
  correspondenceRedos: "ステージ③（書く）の対応の表の出し直し（§1.3.1）",
  correspondenceChecks: "ステージ⑤a（対応表）の点検。版ごとに作り直す（§1.3.1）",
  declChecks: "v1.1α のステージ B3'（宣言の意味の点検）。版ごとに掛け直し、B5 を回す前に残りを確かめる（07 D16）",
  stagnationRepeats: "ステージ⑥（直す）の停滞の検知（同じ不一致が続いた回数）",
  planQuestions: "ステージ P4（質問を組み立てる）〜 P5（答えを反映する）。往復をまたいで数える（plan/session.ts）",
  planRoundTrips: "ステージ P4〜P5 の往復（plan/session.ts）。直し・再開で戻さない",
  planChoices: "ステージ P4（質問を組み立てる）の形の検査。選択肢 2〜4（plan/questions.ts）",
  planFreeTextChars: "ステージ P5（答えを反映する）の自由入力の検査（plan/answers.ts）",
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

// ── Plan の質問の上限（04-plan-agent.md §2・§6。P4〜P5・session.ts）──────────────

/** 1 問の選択肢の数の下限（04 §6 の 3「選択肢 2〜4」）。上限は `AGENT_LIMITS.planChoices` */
export const PLAN_CHOICES_MIN = 2;

/**
 * Plan で合わせて聞く質問の数が上限を超えているかを確かめる（04 §2・§6 の 2）。
 * `count` は**往復をまたいだ合計**である（直し・再開で戻さない）。
 */
export function checkPlanQuestions(count: number): LimitExceeded | undefined {
  return checkLimit("planQuestions", count);
}

/** Plan の質問の往復の回数が上限を超えているかを確かめる（04 §2・§6 の 2） */
export function checkPlanRoundTrips(count: number): LimitExceeded | undefined {
  return checkLimit("planRoundTrips", count);
}

// ── 段の出力の上限（effort ごと。§1.5・§2）────────────────────────

/**
 * 推論の effort の値（§2「品質優先で `high` から始める」）。
 * 出力の上限を段ごとに決めるのに使う。**値はここ（共通の置き場所）にだけ置く**。
 */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** effort を指定しなかったときの既定（§2）。入口の既定（`high`）と同じ側へ倒す */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

/** LLM を呼ぶ段（出力の上限を持つ段。Plan の P3・P4 と、①〜②'・③・⑤a・⑥・⑥'、v1.1α の T1・T1''・T2・B3'） */
export const OUTPUT_STAGES = [
  "surface", // P3 洗い出す（目録に無い曖昧さ・書けないこと）
  "questions", // P4 質問を組み立てる
  "requirements", // ① 要件にする
  "reverse-check", // ①' 逆照合
  "design", // ② 設計する
  "test-suite", // ②' 試験を作って固定する
  "write", // ③ 書く
  "correspondence", // ⑤a 対応表
  "repair", // ⑥ 直す
  "arbitration", // ⑥' 期待の裁定
  // v1.1α の段（07-architecture-v1.1a.md §3。Issue #505）。末尾に足すだけ
  "name-table", // T1 名前の表
  "semantic-check", // T1'' 表の意味の点検
  "test-spec", // T2 試験の仕様
  "decl-check", // B3' 宣言の意味の点検
] as const;
export type OutputStage = (typeof OUTPUT_STAGES)[number];

/**
 * effort ごと・段ごとの出力トークンの上限（`max_output_tokens`。§1.5・§2）。**値は暫定**で、
 * 成功率・費用・所要は今後の計測で確かめる。
 *
 * **推論のトークンもこの上限に含まれる。** 2026-10-11 の手元の計測（60 本）では、打ち切り
 * （`incomplete`）が 7 本あった——設計の段 4 本（`low` の 3 本は上限 2,048、`high` の 1 本は上限
 * 16,384 のうち推論に大半を使って達した）と、質問の段 1 本（当時は設計の段の値を借りていた）、
 * 要件の段 2 本（複数の呼び出しの合計しか記録が無く、理由は確定していない）。打ち切った呼び出しも
 * 費用が掛かり、やり直さずにそこで終わる。そこで、**初期値として余白を取り、Plan の段にも自分の
 * 値を持たせる**。
 *
 *   - 2026-10-09・#332 で `medium` を `high` と同じ値にした（受入の試験で `medium` が途中で切れた）。
 *   - 今回（Issue #399）は、`low` を `medium`（= `high`）と**同じ値**にし（`low` の設計の余白が
 *     足りなかった）、設計の段を 32,768 に上げ、Plan の洗い出し（`surface`）と質問（`questions`）を
 *     段に足して**自分の名前で値を持つ**ようにした（値は設計の段と同じ）。**effort そのもの
 *     （全段で同じ値）は変えない。** 3 つの effort の値は今のところ同じである。
 */
export const STAGE_MAX_OUTPUT_TOKENS: Record<ReasoningEffort, Record<OutputStage, number>> = {
  low: {
    surface: 32_768,
    questions: 32_768,
    requirements: 16_384,
    "reverse-check": 8_192,
    design: 32_768,
    "test-suite": 32_768,
    write: 32_768,
    correspondence: 16_384,
    repair: 32_768,
    arbitration: 16_384,
    "name-table": 32_768,
    "semantic-check": 16_384,
    "test-spec": 32_768,
    "decl-check": 16_384,
  },
  medium: {
    surface: 32_768,
    questions: 32_768,
    requirements: 16_384,
    "reverse-check": 8_192,
    design: 32_768,
    "test-suite": 32_768,
    write: 32_768,
    correspondence: 16_384,
    repair: 32_768,
    arbitration: 16_384,
    "name-table": 32_768,
    "semantic-check": 16_384,
    "test-spec": 32_768,
    "decl-check": 16_384,
  },
  high: {
    surface: 32_768,
    questions: 32_768,
    requirements: 16_384,
    "reverse-check": 8_192,
    design: 32_768,
    "test-suite": 32_768,
    write: 32_768,
    correspondence: 16_384,
    repair: 32_768,
    arbitration: 16_384,
    "name-table": 32_768,
    "semantic-check": 16_384,
    "test-spec": 32_768,
    "decl-check": 16_384,
  },
};

// ── 段ごとの effort（`--pipeline v1.2` の `--stage-effort`。Issue #664）────────────

/**
 * 段ごとに effort を指定できる段（`--stage-effort <段>=<値>`。Issue #664）。**実際に配線する段だけ**を置く——
 * C1 語彙・C2 要件の写像・C3 表の意味の点検・T2 試験の仕様（束の口を含む）・B1 書く・B3' 宣言の意味の点検。
 * ここに無い段は入口で断る（既定へ黙って倒さない）。段の口は共通の口（`CallGateway.forStage`）が引く。
 */
export const STAGE_EFFORT_STAGES = ["vocabulary", "mapping", "semantic-check", "test-spec", "write", "decl-check"] as const;
export type StageEffortStage = (typeof STAGE_EFFORT_STAGES)[number];

/** 段ごとの effort の組（段 → 値。指定の無い段は口の 1 つの effort のまま。Issue #664） */
export type StageEfforts = Readonly<Partial<Record<StageEffortStage, ReasoningEffort>>>;

/** effort を指定できる段か（Issue #664） */
export function isStageEffortStage(value: string): value is StageEffortStage {
  return (STAGE_EFFORT_STAGES as readonly string[]).includes(value);
}

/**
 * 申告の仕分け・裏付けの**確信度の閾値**（§4・Issue #332）。判定の口（Jev・LLM）が返す確信度が
 * これより低い答えは、コードがそのまま使わない——申告は**印つきで残す**（捨てない）。値はここ 1 か所に置く。
 */
export const UNWRITABLE_CONFIDENCE_THRESHOLD = 0.6;

/** 知っている effort か（知らない値は既定へ倒す。段を止めない） */
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * 段の出力の上限（`max_output_tokens`）を、effort と段から引く（§1.5・§2）。
 * **上限の値は `STAGE_MAX_OUTPUT_TOKENS`（この共通の置き場所）にだけ置く**——
 * 段の側で値を書くと、effort の取り違えが「検査は通るのに店頭で切れる」ずれになる。
 * 知らない effort は `DEFAULT_REASONING_EFFORT`（`high`）へ倒す。
 */
export function maxOutputTokensForEffort(effort: string, stage: OutputStage): number {
  const key: ReasoningEffort = isReasoningEffort(effort) ? effort : DEFAULT_REASONING_EFFORT;
  return STAGE_MAX_OUTPUT_TOKENS[key][stage];
}

// ── 呼び出しごとの timeout（effort ごと。§1.5・#302）─────────────────

/**
 * 呼び出し 1 回ごとの timeout（ミリ秒）の基準を、effort ごとに置く（§1.5「呼び出しごとに timeout」・
 * #302「呼び出しの timeout を締切と effort から決める」）。
 *
 * 2026-10-09 の疎通の確認で、固定の 60 秒が原因で段が止まった：設計の段は 1 回 36〜52 秒かかり、
 * 出力の大きい試験を作る段は 60 秒を超えて 2 回とも打ち切られた。effort が高いほど推論に時間を
 * 使うので、effort ごとに置く——
 *
 *   - `high` … 5 分。試験を作る段の出力の上限（`STAGE_MAX_OUTPUT_TOKENS`）が `medium` の 4 倍で、
 *     推論にも時間を使う。ジョブの既定の締切 10 分の中に、設計・試験の大きい段が収まる長さ
 *   - `medium` … 2 分。固定値だった 60 秒の 2 倍
 *   - `low` … 1 分。速さを優先する段の試しうち用
 *
 * **実際に使う値は、ジョブの締切の残りを超えない**（`effectiveCallTimeoutMs`）。値はここにだけ置く。
 */
export const CALL_TIMEOUT_BY_EFFORT: Record<ReasoningEffort, number> = {
  low: 60_000,
  medium: 120_000,
  high: 300_000,
};

/**
 * 呼び出しごとの timeout の基準を、effort から引く（#302）。知らない effort は
 * `DEFAULT_REASONING_EFFORT`（`high`）へ倒す（段を止めない）。
 */
export function callTimeoutMsForEffort(effort: string): number {
  const key: ReasoningEffort = isReasoningEffort(effort) ? effort : DEFAULT_REASONING_EFFORT;
  return CALL_TIMEOUT_BY_EFFORT[key];
}

/**
 * 実際に使う呼び出しごとの timeout（ミリ秒。#302）。effort から出した基準（または呼ぶ側の指定）と、
 * ジョブの締切の残りを比べ、**残りを超えない**方を返す。残りが尽きていれば 0（呼ばない）。
 */
export function effectiveCallTimeoutMs(options: {
  /** 推論の effort（基準の出所） */
  readonly effort: string;
  /** ジョブの締切の残り（ミリ秒） */
  readonly remainingMs: number;
  /** 呼ぶ側の指定（手元の入口の `--timeout` など）。無ければ effort の基準 */
  readonly timeoutMs?: number;
}): number {
  const wanted = options.timeoutMs ?? callTimeoutMsForEffort(options.effort);
  return Math.max(0, Math.min(wanted, options.remainingMs));
}
