// 画面の殻（Issue #869）。依頼 → 考え中 → 質問 → 確認 → 結果 の流れを作り、
// 走っている間は短い間隔で状態を問い合わせる。画面を外したら問い合わせを止める。
import { useCallback, useEffect, useState } from "react";
import { isActiveJobState } from "../shared/api";
import type { AnswersRequest, BudgetView, ConfirmOutcome, JobView } from "../shared/api";
import { defaultApiClient, messageForApiError, type ApiClient } from "./api-client";
import { ConfirmPage } from "./pages/ConfirmPage";
import { QuestionsPage } from "./pages/QuestionsPage";
import { RequestPage } from "./pages/RequestPage";
import { POLL_INTERVAL_MS, usePolling } from "./use-polling";

export interface AppProps {
  /** 試験で口を差し替える。既定は同じ origin の API */
  readonly client?: ApiClient;
}

type Screen = "home" | "request" | "history" | "job";

export function App({ client }: AppProps = {}) {
  const api = client ?? defaultApiClient;
  const [screen, setScreen] = useState<Screen>("home");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [jobs, setJobs] = useState<readonly JobView[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [initialRequest, setInitialRequest] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (screen !== "request") return;
    let cancelled = false;
    setBudgetLoading(true);
    setBudgetError(null);
    api
      .getBudget()
      .then((next) => {
        if (!cancelled) setBudget(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setBudgetError(messageForApiError(caught));
      })
      .finally(() => {
        if (!cancelled) setBudgetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, screen]);

  useEffect(() => {
    if (screen !== "history") return;
    let cancelled = false;
    setHistoryError(null);
    api
      .listJobs()
      .then((next) => {
        if (!cancelled) setJobs(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setHistoryError(messageForApiError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [api, screen]);

  const refreshJob = useCallback(async () => {
    if (jobId === null) return;
    try {
      setJob(await api.getJob(jobId));
    } catch (caught) {
      setError(messageForApiError(caught));
    }
  }, [api, jobId]);

  const polling = screen === "job" && jobId !== null && (job === null || isActiveJobState(job.state));
  usePolling(refreshJob, { intervalMs: POLL_INTERVAL_MS, enabled: polling });

  const openRequest = (): void => {
    setError(null);
    setInitialRequest("");
    setScreen("request");
  };

  const start = async (requestText: string): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const started = await api.startJob(requestText);
      setJob(started);
      setJobId(started.id);
      setScreen("job");
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const answer = async (answers: AnswersRequest): Promise<void> => {
    if (jobId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      setJob(await api.answerQuestions(jobId, answers));
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async (outcome: ConfirmOutcome): Promise<void> => {
    if (jobId === null || job === null) return;
    const originalRequest = job.request;
    setSubmitting(true);
    setError(null);
    try {
      if (outcome === "stop") {
        await api.confirmJob(jobId, "stop");
        setJob(null);
        setJobId(null);
        setInitialRequest(originalRequest);
        setScreen("request");
        return;
      }
      setJob(await api.confirmJob(jobId, "build"));
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const openHistoryJob = (candidate: JobView): void => {
    setError(null);
    setJob(candidate);
    setJobId(candidate.id);
    setScreen("job");
  };

  const renderJob = () => {
    if (job === null) {
      return <ThinkingView />;
    }
    if (job.state === "awaiting-answer" && job.question !== null) {
      return (
        <QuestionsPage bundle={job.question} submitting={submitting} error={error} onAnswer={answer} />
      );
    }
    if (job.state === "awaiting-confirm" && job.confirmation !== null) {
      return <ConfirmPage job={job} submitting={submitting} error={error} onConfirm={confirm} />;
    }
    return <ThinkingView job={job} />;
  };

  const renderScreen = () => {
    if (screen === "request") {
      return (
        <RequestPage
          budget={budget}
          budgetLoading={budgetLoading}
          budgetError={budgetError}
          initialRequest={initialRequest}
          submitting={submitting}
          error={error}
          onStart={start}
        />
      );
    }
    if (screen === "history") {
      return (
        <section className="page" aria-labelledby="history-title">
          <div className="page__head">
            <h2 className="page__title" id="history-title">
              履歴
            </h2>
            <p className="page__lead">これまでの依頼です。開くと続きから見られます。</p>
          </div>
          {historyError === null ? null : (
            <p className="page__warning" role="alert">
              {historyError}
            </p>
          )}
          {jobs.length === 0 ? (
            <p className="page__hint">まだ依頼はありません。</p>
          ) : (
            <ul className="history">
              {jobs.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="history__item"
                    onClick={() => openHistoryJob(entry)}
                  >
                    <span className="history__state">{entry.stateLabel}</span>
                    <span className="history__request">{entry.request}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }
    if (screen === "job") {
      return renderJob();
    }
    return (
      <>
        <p className="studio__lead">
          依頼を言葉で書いて、質問に答えて、作ったものを見る。
        </p>
        <p className="studio__hint">まずは「新しく作る」から始めてください。</p>
      </>
    );
  };

  return (
    <main className="studio">
      <header className="studio__header">
        <p className="studio__eyebrow">手元の工房</p>
        <h1 className="studio__title">MUSUNEST</h1>
        <nav className="studio__entries" aria-label="入口">
          <button type="button" className="studio__entry studio__entry--primary" onClick={openRequest}>
            新しく作る
          </button>
          <button
            type="button"
            className="studio__entry"
            onClick={() => {
              setError(null);
              setScreen("history");
            }}
          >
            履歴
          </button>
        </nav>
      </header>
      {renderScreen()}
    </main>
  );
}

interface ThinkingViewProps {
  readonly job?: JobView | null;
}

function ThinkingView({ job = null }: ThinkingViewProps) {
  if (job === null) {
    return (
      <section className="page" aria-live="polite">
        <p className="page__lead">依頼を送りました。考えています…</p>
        <p className="page__hint">閉じても履歴から戻れます。</p>
      </section>
    );
  }

  if (job.state === "result" && job.result !== null) {
    return (
      <section className="page" aria-labelledby="result-title">
        <div className="page__head">
          <h2 className="page__title" id="result-title">
            {job.result.verdictLabel}
          </h2>
        </div>
        <ul className="block__list">
          {job.result.content.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    );
  }

  const active = isActiveJobState(job.state);
  return (
    <section className="page" aria-live="polite" aria-labelledby="progress-title">
      <div className="page__head">
        <h2 className="page__title" id="progress-title">
          {job.stateLabel}
        </h2>
        {job.progress === null ? null : (
          <>
            <p className="page__lead">{job.progress.stage}</p>
            <p className="page__hint">経過 {job.progress.elapsedSeconds} 秒</p>
          </>
        )}
        {active ? <p className="page__hint">閉じても履歴から戻れます。</p> : null}
      </div>
      {active ? null : (
        <div className="page__actions">
          {job.stopReasonLabel === null ? null : (
            <p className="page__warning">{job.stopReasonLabel}</p>
          )}
        </div>
      )}
    </section>
  );
}
