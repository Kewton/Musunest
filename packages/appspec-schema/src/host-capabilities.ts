// 実行環境（画面と正規化）が実装として保証していることの定義（Issue #953）。
//
// **意味の文書（contract/・docs/semantics.md・vocabulary.yaml）には置かない。** ここに置く理由は、
// 保証の持ち主を 1 か所に決め、**その文を、申告の独立点検の材料にだけ**渡すためである。意味の文書に書くと、
// P1・P2・引用の修復・洗い出し・問いの段の共通の前置きが変わり、文書の指紋も変わる（#943 の前後比較）。
//
// ここが持つのは**事実と範囲だけ**である。「だから書ける」「欄が無くても書ける」のような推論・指示は
// 書かない——点検の判定の口が、保証の外の申告（通知・定刻の切り替えなど）にも同じ推論を当てはめないため。
// 事実の文は 1 つずつ、実装の試験（画面の 4 例と正規化の 1 例）に 1 対 1 で当たる。
//
// 版は、文の意味を変えたときに上げる。点検の材料は版つきの定義をそのまま載せるので、記録のハッシュが
// 版ごとに変わり、古い記録を新しい文の記録として扱わない。

/** 能力の定義の版（文の意味を変えたら上げる） */
export const HOST_CAPABILITIES_VERSION = "v1" as const;

/** 最初の能力の ID（画面が先頭の一覧を初めに開く保証。試験の名前にも文字列で入れる） */
export const HOST_CAPABILITY_FIRST_VIEW = "first-view-declaration-order" as const;

/** 能力 1 つの定義。**ID・事実の文の並び・範囲の文**だけを持つ */
export interface HostCapability {
  readonly id: string;
  /** 実装が保証する事実の文（推論・指示を含めない） */
  readonly facts: readonly string[];
  /** 保証の及ぶ範囲の文（保証の外を「できる」と読ませない） */
  readonly scope: string;
}

/** 実行環境の能力の定義（版と能力の並び） */
export interface HostCapabilities {
  readonly version: string;
  readonly capabilities: readonly HostCapability[];
}

/** 検査で見つかった問題（有限の集合。文は持たない） */
export const HOST_CAPABILITIES_PROBLEMS = [
  "version-empty",
  "id-empty",
  "id-duplicated",
  "facts-empty",
  "fact-empty",
  "scope-empty",
] as const;
export type HostCapabilitiesProblem = (typeof HOST_CAPABILITIES_PROBLEMS)[number];

/**
 * 定義の形を検査する（版がある・ID が一意・事実の文と範囲の文が空でない）。**純粋関数**である——
 * 定義を読むだけで、正しさの判断（文が実装と合っているか）はしない。それは実装の試験が固定する。
 */
export function checkHostCapabilities(definition: HostCapabilities): readonly HostCapabilitiesProblem[] {
  const problems: HostCapabilitiesProblem[] = [];
  if (definition.version.trim() === "") problems.push("version-empty");
  const seen = new Set<string>();
  for (const capability of definition.capabilities) {
    const id = capability.id.trim();
    if (id === "") {
      problems.push("id-empty");
    } else if (seen.has(id)) {
      problems.push("id-duplicated");
    } else {
      seen.add(id);
    }
    if (capability.facts.length === 0) problems.push("facts-empty");
    for (const fact of capability.facts) {
      if (fact.trim() === "") problems.push("fact-empty");
    }
    if (capability.scope.trim() === "") problems.push("scope-empty");
  }
  return problems;
}

/**
 * 本番の定義。事実の文は、画面の 4 例と正規化の 1 例に 1 対 1 で当たる:
 *   ① 画面の 1 例目（先頭が集計の画面でも初めにそれを開く）と正規化の例（宣言の順を変えない）
 *   ② 画面の 2 例目（先頭が別の種類なら、集計の画面が後ろにあっても先頭を開く）
 *   ③ 画面の 3 例目（一覧が 0 個なら、一覧が無い状態を出す）
 *   ④ 画面の 4 例目（先頭の一覧の読み込みが拒まれたら理由を出し、2 番目を読まない）
 */
export const HOST_CAPABILITIES: HostCapabilities = {
  version: HOST_CAPABILITIES_VERSION,
  capabilities: [
    {
      id: HOST_CAPABILITY_FIRST_VIEW,
      facts: [
        "画面は、宣言の順で先頭の一覧を初めに開く",
        "種類で選ばない（集計の画面が後ろにあっても、先頭の一覧を開く）",
        "一覧が 0 個なら、何も開かない",
        "先頭の一覧が読めなければ理由を出し、ほかの一覧へ移らない",
      ],
      scope: "この保証は、初めに開く一覧の選択だけに及ぶ",
    },
  ],
};
