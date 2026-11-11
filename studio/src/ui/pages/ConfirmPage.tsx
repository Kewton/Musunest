// 確認の画面（Issue #869 の目的・4）。要件・差分の 3 種・書けないことと代わりの案・
// 既定で決めたことを、それぞれの見出しの下に出す。「これで作る」で確定の要求を送る。
import { ANSWER_WAIT_MS } from "../../shared/api";
import type { ConfirmOutcome, JobView } from "../../shared/api";
import { remainingMinutes, useNow } from "../use-polling";

export interface ConfirmPageProps {
  readonly job: JobView;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onConfirm: (outcome: ConfirmOutcome) => void | Promise<void>;
}

export function ConfirmPage({
  job,
  submitting = false,
  error = null,
  onConfirm,
}: ConfirmPageProps) {
  const confirmation = job.confirmation;
  const now = useNow();
  if (confirmation === null) return null;

  const deadlineAt = job.question?.deadlineAt ?? job.updatedAt + ANSWER_WAIT_MS;
  const minutes = remainingMinutes(deadlineAt, now);

  return (
    <section className="page" aria-labelledby="confirm-title">
      <div className="page__head">
        <h2 className="page__title" id="confirm-title">
          この内容で作りますか？
        </h2>
        <p className="page__lead">あなたの言葉でまとめた内容です。違っていれば直せます。</p>
        {minutes === null ? null : (
          <p className="page__hint">
            {minutes === 0 ? "答えの期限を過ぎています" : `答えの期限まであと ${minutes} 分`}
          </p>
        )}
      </div>

      <section className="block" aria-labelledby="confirm-requirements">
        <h3 className="block__title" id="confirm-requirements">
          つくるもの
        </h3>
        <ul className="block__list">
          {confirmation.requirements.map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
        </ul>
      </section>

      <section className="block" aria-labelledby="confirm-added">
        <h3 className="block__title" id="confirm-added">
          足したこと
        </h3>
        {confirmation.diff.added.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {confirmation.diff.added.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="confirm-changed">
        <h3 className="block__title" id="confirm-changed">
          直したこと
        </h3>
        {confirmation.diff.changed.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {confirmation.diff.changed.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="confirm-removed">
        <h3 className="block__title" id="confirm-removed">
          外したこと
        </h3>
        {confirmation.diff.removed.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {confirmation.diff.removed.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="confirm-limitations">
        <h3 className="block__title" id="confirm-limitations">
          できないことと代わりの案
        </h3>
        {confirmation.limitations.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list block__list--limitations">
            {confirmation.limitations.map((limitation) => (
              <li key={limitation.what}>
                <span className="block__what">{limitation.what}</span>
                <span className="block__alternative">代わりに: {limitation.alternative}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="confirm-decided">
        <h3 className="block__title" id="confirm-decided">
          既定で決めたこと
        </h3>
        {confirmation.decided.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {confirmation.decided.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}

      <div className="page__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={submitting}
          onClick={() => {
            void onConfirm("build");
          }}
        >
          {submitting ? "送っています…" : "これで作る"}
        </button>
        <button
          type="button"
          className="button"
          disabled={submitting}
          onClick={() => {
            void onConfirm("stop");
          }}
        >
          直したい
        </button>
      </div>
    </section>
  );
}
