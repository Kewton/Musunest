// 作成中の画面（Issue #870 の目的・1）。段の表示名・経過時間・概算の額を出し、
// 閉じても履歴から戻れることを伝える。取り消しは、確かめのあとにだけ要求を送る。
import { useState } from "react";
import type { JobView } from "../../shared/api";
import { StageProgress } from "../components/StageProgress";

export interface ProgressPageProps {
  readonly job: JobView;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onCancel: () => void | Promise<void>;
}

export function ProgressPage({
  job,
  submitting = false,
  error = null,
  onCancel,
}: ProgressPageProps) {
  const [confirming, setConfirming] = useState(false);

  const cancel = (): void => {
    if (submitting) return;
    void onCancel();
  };

  return (
    <section className="page" aria-labelledby="progress-title">
      <div className="page__head">
        <h2 className="page__title" id="progress-title">
          {job.stateLabel}
        </h2>
        <p className="page__lead">作っています。終わるまで数分かかります。</p>
        <p className="page__hint">閉じても、履歴から続きを見られます。</p>
      </div>

      {job.progress === null ? (
        <p className="page__hint">進みを読み込んでいます…</p>
      ) : (
        <StageProgress progress={job.progress} />
      )}

      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}

      {confirming ? (
        <section className="block" aria-labelledby="cancel-confirm-title">
          <h3 className="block__title" id="cancel-confirm-title">
            取り消しますか？
          </h3>
          <p className="block__empty">ここまでの費用は残ります。取り消してよければ「取り消す」を押してください。</p>
          <div className="page__actions">
            <button
              type="button"
              className="button button--danger"
              disabled={submitting}
              onClick={cancel}
            >
              {submitting ? "取り消しています…" : "取り消す"}
            </button>
            <button
              type="button"
              className="button"
              disabled={submitting}
              onClick={() => setConfirming(false)}
            >
              やめる
            </button>
          </div>
        </section>
      ) : (
        <div className="page__actions">
          <button
            type="button"
            className="button"
            disabled={submitting}
            onClick={() => setConfirming(true)}
          >
            取り消し
          </button>
        </div>
      )}
    </section>
  );
}
