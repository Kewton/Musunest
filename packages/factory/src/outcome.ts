// 終わりの判定（02-architecture.md §1.4）。
//
// 段の結果（静的チェックの通過・対応表の落ち・試験の不一致・未解決・書けない要件・上限に触れたか）
// から、合格／部分案／失敗 と、要約の `verdict`（`full`／`partial`／`none`）を返す**純粋な関数**。
// 合否はコードが決める（LLM の自己申告では合格させない）。

/** 段の結果（⑦ 終わりの判定の入力）。数を数える欄は、その段で数えた落ち・不一致・未解決の数である */
export interface StageResults {
  /** 静的チェックを通過した版があるか（④） */
  readonly staticCheckPassed: boolean;
  /** 対応表の落ちの数（⑤a） */
  readonly correspondenceMisses: number;
  /** 試験の不一致の数（⑤b。結び付けられなかった試験も含む） */
  readonly testMismatches: number;
  /** 未解決の数（重大な曖昧さ・裁定できなかった試験。①・⑥'） */
  readonly unresolved: number;
  /** 書けない要件の数（②） */
  readonly unwritableRequirements: number;
  /** 上限（呼び出しの数・直しの往復・費用・時間）に触れたか（§1.5） */
  readonly limitReached: boolean;
}

/** 3 つの結果（§1.4） */
export type OutcomeResult = "pass" | "partial" | "failed";

/** 納品物の要約の `verdict`（§4） */
export type Verdict = "full" | "partial" | "none";

/** ⑦ の判定の結果 */
export interface Outcome {
  readonly result: OutcomeResult;
  readonly verdict: Verdict;
}

/**
 * 段の結果から、合格／部分案／失敗 と `verdict` を返す（§1.4）。
 *
 * - **合格**：静的チェックを通過・対応表の落ちが 0・試験の不一致が 0・未解決が 0・書けない要件が 0
 * - **部分案**：静的チェックを通過。ただし、書けない要件がある／未解決を残した
 * - **失敗**：静的チェックを通過した版が無い、または上限に触れて部分案の条件も満たさない
 *
 * `limitReached` は、直しの往復が上限に触れて止まったかどうかの記録である。ここへ来る最後の分岐は、
 * 対応表の落ち・試験の不一致が残ったまま止まった場合で、終わりの判定としては失敗に倒す（fail-closed）。
 */
export function decideOutcome(stage: StageResults): Outcome {
  if (!stage.staticCheckPassed) {
    return { result: "failed", verdict: "none" };
  }
  const satisfied =
    stage.correspondenceMisses === 0 &&
    stage.testMismatches === 0 &&
    stage.unresolved === 0 &&
    stage.unwritableRequirements === 0;
  if (satisfied) {
    return { result: "pass", verdict: "full" };
  }
  if (stage.unwritableRequirements > 0 || stage.unresolved > 0) {
    return { result: "partial", verdict: "partial" };
  }
  return { result: "failed", verdict: "none" };
}
