// 画面の殻（Issue #869・Issue #870）。依頼 → 考え中 → 質問 → 確認 → 作成中 → 結果 →
// 公開 → 履歴 の流れを作り、走っている間は短い間隔で状態を問い合わせる。画面を外したら止める。
//
// 「開いて試す」のオリジンは HTML に埋めた `studio-staging-origin` から読み、画面の中だけで組む。
// **オリジンは保存しない・表示しない**（リンクの href の中だけ。禁止事項）。
import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveJobState } from "../shared/api";
import type {
  AnswersRequest,
  BudgetView,
  ConfirmOutcome,
  JobView,
  PublishRecord,
} from "../shared/api";
import { defaultApiClient, messageForApiError, type ApiClient } from "./api-client";
import { ConfirmPage } from "./pages/ConfirmPage";
import { HistoryPage } from "./pages/HistoryPage";
import { ProgressPage } from "./pages/ProgressPage";
import { QuestionsPage } from "./pages/QuestionsPage";
import { RequestPage } from "./pages/RequestPage";
import { ResultPage } from "./pages/ResultPage";
import { POLL_INTERVAL_MS, usePolling } from "./use-polling";

export interface AppProps {
  /** 試験で口を差し替える。既定は同じ origin の API */
  readonly client?: ApiClient;
}

type Screen = "home" | "request" | "history" | "job";

/** HTML に埋めた staging のオリジン。無ければ null（保存はしない。読み出すたびに消える） */
function readStagingOrigin(): string | null {
  if (typeof document === "undefined") return null;
  const content =
    document.querySelector<HTMLMetaElement>('meta[name="studio-staging-origin"]')?.content ?? "";
  const trimmed = content.trim();
  return trimmed === "" ? null : trimmed;
}

export function App({ client }: AppProps = {}) {
  const api = client ?? defaultApiClient;
  const [screen, setScreen] = useState<Screen>("home");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [jobs, setJobs] = useState<readonly JobView[]>([]);
  const [publishes, setPublishes] = useState<Record<string, PublishRecord>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [initialRequest, setInitialRequest] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publish, setPublish] = useState<PublishRecord | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const publishGate = useRef(false);
  const approveGate = useRef(false);

  const resetPublishState = useCallback((next: PublishRecord | null = null): void => {
    publishGate.current = false;
    approveGate.current = false;
    setPublish(next);
    setPublishing(false);
    setApproving(false);
    setApproved(next?.ok === true);
    setActionError(null);
  }, []);

  const rememberPublish = useCallback((id: string, record: PublishRecord): void => {
    setPublishes((current) => ({ ...current, [id]: record }));
  }, []);

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
    setHistoryLoading(true);
    setHistoryError(null);
    api
      .listJobs()
      .then((next) => {
        if (!cancelled) setJobs(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setHistoryError(messageForApiError(caught));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    api
      .getBudget()
      .then((next) => {
        if (!cancelled) setBudget(next);
      })
      .catch(() => {
        // 費用が読めなくても履歴は見せる（履歴の誤りだけを出す）
      });
    return () => {
      cancelled = true;
    };
  }, [api, screen]);

  const refreshJob = useCallback(async () => {
    if (jobId === null) return;
    try {
      const next = await api.getJob(jobId);
      setJob(next);
      if (next.publish !== undefined && next.publish !== null) {
        setPublish(next.publish);
        rememberPublish(jobId, next.publish);
      }
    } catch (caught) {
      setError(messageForApiError(caught));
    }
  }, [api, jobId, rememberPublish]);

  const polling = screen === "job" && jobId !== null && (job === null || isActiveJobState(job.state));
  usePolling(refreshJob, { intervalMs: POLL_INTERVAL_MS, enabled: polling });

  const openRequest = (): void => {
    setError(null);
    setInitialRequest("");
    setJob(null);
    setJobId(null);
    resetPublishState();
    setScreen("request");
  };

  const openHistory = (): void => {
    setError(null);
    setScreen("history");
  };

  const start = async (requestText: string): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const started = await api.startJob(requestText);
      resetPublishState();
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
        resetPublishState();
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

  const cancel = async (): Promise<void> => {
    if (jobId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      setJob(await api.cancelJob(jobId));
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const publishOnce = useCallback(async (): Promise<void> => {
    if (jobId === null || publishGate.current) return;
    publishGate.current = true;
    setPublishing(true);
    setActionError(null);
    try {
      const record = await api.publishJob(jobId);
      setPublish(record);
      rememberPublish(jobId, record);
      if (!record.ok) publishGate.current = false;
    } catch (caught) {
      setActionError(messageForApiError(caught));
      publishGate.current = false;
    } finally {
      setPublishing(false);
    }
  }, [api, jobId, rememberPublish]);

  const approveAndPublish = useCallback(
    async (manifestSha256: string): Promise<void> => {
      if (jobId === null || approveGate.current) return;
      approveGate.current = true;
      setApproving(true);
      setActionError(null);
      try {
        await api.approveJob(jobId, manifestSha256);
        setApproved(true);
        setApproving(false);
        await publishOnce();
      } catch (caught) {
        setActionError(messageForApiError(caught));
        setApproving(false);
        approveGate.current = false;
      }
    },
    [api, jobId, publishOnce],
  );

  const retry = (): void => {
    if (job === null) return;
    setInitialRequest(job.request);
    setError(null);
    setJob(null);
    setJobId(null);
    resetPublishState();
    setScreen("request");
  };

  const openHistoryJob = (candidate: JobView): void => {
    setError(null);
    setJob(candidate);
    setJobId(candidate.id);
    resetPublishState(candidate.publish ?? publishes[candidate.id] ?? null);
    setScreen("job");
  };

  const renderJob = () => {
    if (job === null) {
      return (
        <section className="page" aria-live="polite">
          <p className="page__lead">読み込んでいます…</p>
        </section>
      );
    }
    if (job.state === "awaiting-answer" && job.question !== null) {
      return (
        <QuestionsPage bundle={job.question} submitting={submitting} error={error} onAnswer={answer} />
      );
    }
    if (job.state === "awaiting-confirm" && job.confirmation !== null) {
      return <ConfirmPage job={job} submitting={submitting} error={error} onConfirm={confirm} />;
    }
    if (isActiveJobState(job.state)) {
      return <ProgressPage job={job} submitting={submitting} error={error} onCancel={cancel} />;
    }
    return (
      <ResultPage
        job={job}
        publish={publish}
        publishing={publishing}
        approving={approving}
        approved={approved}
        error={actionError}
        origin={readStagingOrigin()}
        onPublish={publishOnce}
        onApprove={approveAndPublish}
        onRetry={retry}
      />
    );
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
        <HistoryPage
          jobs={jobs}
          budget={budget}
          publishes={publishes}
          loading={historyLoading}
          error={historyError}
          onOpen={openHistoryJob}
        />
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
          <button type="button" className="studio__entry" onClick={openHistory}>
            履歴
          </button>
        </nav>
      </header>
      {renderScreen()}
    </main>
  );
}
