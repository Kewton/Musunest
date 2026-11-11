// 履歴の画面（Issue #870 の目的・6）。作ったもの・作っている途中を新しい順に並べ、
// 状態・日時・使った額・公開済みならインスタンス ID を出す。押すとそのジョブの画面へ移る。
// 今日の使った額と残りも出す。
import type { BudgetView, JobView, PublishRecord } from "../../shared/api";
import { formatUsd } from "../components/BudgetNote";

const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(ms: number): string {
  return dateTimeFormatter.format(new Date(ms));
}

/** 使った額。実額があればそれ、無ければ進みの概算 */
export function spentOf(job: JobView): number | null {
  if (typeof job.spentUsd === "number") return job.spentUsd;
  if (job.progress !== null) return job.progress.estimatedUsd;
  return null;
}

/** 新しい順（元の並びは変えない） */
export function newestFirst(jobs: readonly JobView[]): readonly JobView[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- 写しを並べ替えるだけ（ES2022 の lib に toSorted が無い）
  return [...jobs].sort((left, right) => right.createdAt - left.createdAt);
}

export interface HistoryPageProps {
  readonly jobs: readonly JobView[];
  readonly budget?: BudgetView | null;
  /** 画面がこの回の公開で覚えている結果（サーバの応答に無いときの代わり） */
  readonly publishes?: Readonly<Record<string, PublishRecord>>;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onOpen: (job: JobView) => void;
}

export function HistoryPage({
  jobs,
  budget = null,
  publishes = {},
  loading = false,
  error = null,
  onOpen,
}: HistoryPageProps) {
  const ordered = newestFirst(jobs);

  return (
    <section className="page" aria-labelledby="history-title">
      <div className="page__head">
        <h2 className="page__title" id="history-title">
          履歴
        </h2>
        <p className="page__lead">これまでの依頼です。開くと、そのときの画面に戻れます。</p>
      </div>

      <section className="budget" aria-label="今日の費用">
        {budget === null ? (
          <p className="budget__muted">費用を読み込んでいます…</p>
        ) : (
          <dl className="budget__figures">
            <div>
              <dt>今日の使った額</dt>
              <dd>{formatUsd(budget.spentUsd)}</dd>
            </div>
            <div>
              <dt>今日の残り</dt>
              <dd>{formatUsd(budget.remainingUsd)}</dd>
            </div>
          </dl>
        )}
      </section>

      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}

      {loading && ordered.length === 0 ? (
        <p className="page__hint">履歴を読み込んでいます…</p>
      ) : ordered.length === 0 ? (
        <p className="page__hint">まだ依頼はありません。</p>
      ) : (
        <ul className="history">
          {ordered.map((entry) => {
            const spent = spentOf(entry);
            const publish = publishes[entry.id] ?? entry.publish ?? null;
            const instanceId = publish?.ok === true ? publish.instanceId : null;
            return (
              <li key={entry.id}>
                <button type="button" className="history__item" onClick={() => onOpen(entry)}>
                  <span className="history__state">{entry.stateLabel}</span>
                  <span className="history__request">{entry.request}</span>
                  <span className="history__meta">
                    <span>{formatDateTime(entry.createdAt)}</span>
                    {spent === null ? null : <span>使った額 {formatUsd(spent)}</span>}
                    {instanceId === null ? null : (
                      <span className="history__instance">インスタンス ID: {instanceId}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
