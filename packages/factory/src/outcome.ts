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
  /** 書けない要件の数（②。書けない部分＝語彙の穴が残った要件だけ） */
  readonly unwritableRequirements: number;
  /**
   * 書けないと申告された要件のうち、**了承して除いた部分（`accepted_unwritable`）の内側だけ**の数
   * （§5・Issue #334）。**確定した仕様を正本にしたときだけ**入れる。了承済みの部分は、利用者が
   * 確認の画面で了承したものである——**合格（full）を妨げない**。
   *
   * 突き合わせは部分 ID で行い、`unwritableRequirements - acceptedUnwritable` が「Plan の見落とし」
   * （了承の外の書けない部分）である。省いたとき（確定した仕様が無いとき）は 0 と見なす。
   */
  readonly acceptedUnwritable?: number;
  /**
   * 設計の `notes` だけがある要件の数（②・Issue #332）。**部分案の理由にはしない**——`notes` は
   * 曖昧さ・決めたこと・不確かさのメモであり、書けないことではない。`decideOutcome` はこの欄を見ない
   * （見るのは `unwritableRequirements`。書ける部分が残っている要件を、メモだけでは部分案にしない）。
   */
  readonly notedRequirements?: number;
  /** 上限（呼び出しの数・直しの往復・費用・時間）に触れたか（§1.5） */
  readonly limitReached: boolean;
}

/** 3 つの結果（§1.4） */
export type OutcomeResult = "pass" | "partial" | "failed";

/** 納品物の要約の `verdict`（§4） */
export type Verdict = "full" | "partial" | "none";

/**
 * 部分案の理由（§5・Issue #334）。設計が「書けない」と申告した部分が、了承して除いた部分
 * （`accepted_unwritable`）の**外**にあるときの理由である——利用者が了承していない仕様の欠けなので、
 * Plan に戻して P3 をやり直す。
 */
export const PLAN_OVERSIGHT_REASON = "Plan の見落とし" as const;

/** ⑦ の判定の結果 */
export interface Outcome {
  readonly result: OutcomeResult;
  readonly verdict: Verdict;
  /** 部分案の理由（部分案のときだけ。例: `"Plan の見落とし"`。§1.4・§5・Issue #334） */
  readonly reason?: string;
}

/**
 * 段の結果から、合格／部分案／失敗 と `verdict` を返す（§1.4）。
 *
 * - **合格**：静的チェックを通過・対応表の落ちが 0・試験の不一致が 0・未解決が 0・**了承の外の**
 *   書けない要件が 0。**了承して除いた部分（`acceptedUnwritable`）だけが書けない仕様は合格（full）である**
 *   （§5・Issue #334）
 * - **部分案**：静的チェックを通過。ただし、了承の外の書けない要件がある（理由「Plan の見落とし」）／
 *   未解決を残した
 * - **失敗**：静的チェックを通過した版が無い、または上限に触れて部分案の条件も満たさない
 *
 * `limitReached` は、直しの往復が上限に触れて止まったかどうかの記録である。ここへ来る最後の分岐は、
 * 対応表の落ち・試験の不一致が残ったまま止まった場合で、終わりの判定としては失敗に倒す（fail-closed）。
 */
export function decideOutcome(stage: StageResults): Outcome {
  if (!stage.staticCheckPassed) {
    return { result: "failed", verdict: "none" };
  }
  // 了承して除いた部分は、合格を妨げない。了承の外にある書けない部分だけが「Plan の見落とし」である
  const accepted = stage.acceptedUnwritable ?? 0;
  const oversight = Math.max(0, stage.unwritableRequirements - accepted);
  const satisfied =
    stage.correspondenceMisses === 0 &&
    stage.testMismatches === 0 &&
    stage.unresolved === 0 &&
    oversight === 0;
  if (satisfied) {
    return { result: "pass", verdict: "full" };
  }
  if (oversight > 0 || stage.unresolved > 0) {
    // 「Plan の見落とし」の理由は、確定した仕様を正本にしたとき（`acceptedUnwritable` が入っているとき）にだけ出す
    const reason =
      oversight > 0 && stage.acceptedUnwritable !== undefined ? { reason: PLAN_OVERSIGHT_REASON } : {};
    return { result: "partial", verdict: "partial", ...reason };
  }
  return { result: "failed", verdict: "none" };
}
