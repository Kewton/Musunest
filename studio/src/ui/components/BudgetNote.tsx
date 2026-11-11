// 費用の表示（Issue #869 の目的・1）。1 回の上限と今日の残りを出し、
// 残りが 1 回の上限に足りなければ理由を出す。
import type { BudgetView } from "../../shared/api";

const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number): string {
  return formatter.format(value);
}

/** 今日の残りで 1 回の依頼を始められるか */
export function hasEnoughBudget(budget: BudgetView | null): boolean {
  if (budget === null) return false;
  return budget.remainingUsd + 1e-9 >= budget.perRunLimitUsd;
}

export interface BudgetNoteProps {
  readonly budget: BudgetView | null;
  readonly loading?: boolean;
  readonly error?: string | null;
}

export function BudgetNote({ budget, loading = false, error = null }: BudgetNoteProps) {
  return (
    <section className="budget" aria-label="費用">
      <p className="budget__lead">所要は数分です。</p>
      {budget === null ? (
        loading ? <p className="budget__muted">費用を読み込んでいます…</p> : null
      ) : (
        <>
          <dl className="budget__figures">
            <div>
              <dt>1 回の上限</dt>
              <dd>{formatUsd(budget.perRunLimitUsd)}</dd>
            </div>
            <div>
              <dt>今日の残り</dt>
              <dd>{formatUsd(budget.remainingUsd)}</dd>
            </div>
          </dl>
          {hasEnoughBudget(budget) ? null : (
            <p className="budget__warning" role="alert">
              今日の残りが 1 回の上限（{formatUsd(budget.perRunLimitUsd)}）に足りません。明日また試してください。
            </p>
          )}
        </>
      )}
      {error === null ? null : (
        <p className="budget__warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
