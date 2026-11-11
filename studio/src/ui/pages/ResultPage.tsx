// 結果の画面（Issue #870 の目的・2〜5）。full は公開、partial は了承してから公開、
// none・差し戻し・時間切れは理由と「依頼を直してやり直す」を出す。
//
// 公開の失敗は、止まった門の段を利用者の言葉で出す（値・URL を出さない）。
import type { JobView, PublishRecord } from "../../shared/api";
import { PartialReview } from "../components/PartialReview";
import { PublishPanel } from "../components/PublishPanel";

export interface ResultPageProps {
  readonly job: JobView;
  readonly publish?: PublishRecord | null;
  readonly publishing?: boolean;
  readonly approving?: boolean;
  /** 了承が済んだか（partial だけが使う。済むまで公開のボタンを出さない） */
  readonly approved?: boolean;
  readonly error?: string | null;
  /** HTML に埋めた staging のオリジン（無ければ null） */
  readonly origin?: string | null;
  readonly onPublish: () => void | Promise<void>;
  readonly onApprove: (manifestSha: string) => void | Promise<void>;
  readonly onRetry: () => void;
}

export function ResultPage({
  job,
  publish = null,
  publishing = false,
  approving = false,
  approved = false,
  error = null,
  origin = null,
  onPublish,
  onApprove,
  onRetry,
}: ResultPageProps) {
  const result = job.result;

  if (result === null) {
    if (job.stopReason === "cannot-confirm") {
      return (
        <TerminalPage
          job={job}
          title={job.stopReasonLabel ?? "要件を固めきれませんでした"}
          reason={`${job.stopReasonCategory ?? "理由を分類できませんでした"} 決めてほしいことを依頼に書き足すと、固めやすくなります。`}
          error={error}
          onRetry={onRetry}
        />
      );
    }
    return (
      <TerminalPage
        job={job}
        title={job.stateLabel}
        reason={reasonOf(job)}
        error={error}
        onRetry={onRetry}
      />
    );
  }

  if (result.verdict === "none") {
    return (
      <TerminalPage
        job={job}
        title={result.verdictLabel}
        reason={result.content.length === 0 ? "作れませんでした。" : result.content.join(" ")}
        error={error}
        onRetry={onRetry}
      />
    );
  }

  if (result.verdict === "partial") {
    const details = job.partial;
    return (
      <section className="page" aria-labelledby="result-title">
        <div className="page__head">
          <h2 className="page__title" id="result-title">
            {result.verdictLabel}
          </h2>
          <p className="page__lead">できたこと・できなかったことを確かめてから、公開してください。</p>
        </div>

        <PartialReview
          built={details?.built ?? result.content}
          missing={details?.missing ?? []}
          decided={details?.decided ?? []}
          manifestSha={job.manifestSha256 ?? null}
          approving={approving}
          error={approved ? null : error}
          onApprove={onApprove}
        />

        {approved ? (
          <PublishPanel
            publish={publish}
            publishing={publishing}
            error={error}
            origin={origin}
            onPublish={onPublish}
            label="公開する"
          />
        ) : null}
      </section>
    );
  }

  return (
    <section className="page" aria-labelledby="result-title">
      <div className="page__head">
        <h2 className="page__title" id="result-title">
          {result.verdictLabel}
        </h2>
        <p className="page__lead">作ったものを staging へ公開できます。</p>
      </div>

      {result.content.length === 0 ? null : (
        <ul className="block__list">
          {result.content.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <PublishPanel
        publish={publish}
        publishing={publishing}
        error={error}
        origin={origin}
        onPublish={onPublish}
        label="公開する"
      />
    </section>
  );
}

/** 止まった理由（利用者の言葉）。値・URL は出さない */
export function reasonOf(job: JobView): string {
  if (job.stopReasonLabel !== null) return job.stopReasonLabel;
  if (job.state === "sent-back") return job.note ?? "工場が、もう一度聞き直したいと返しました。";
  if (job.stateLabel !== "") return job.stateLabel;
  return "止まりました。";
}

interface TerminalPageProps {
  readonly job: JobView;
  readonly title: string;
  readonly reason: string;
  readonly error: string | null;
  readonly onRetry: () => void;
}

function TerminalPage({ job, title, reason, error, onRetry }: TerminalPageProps) {
  return (
    <section className="page" aria-labelledby="result-title">
      <div className="page__head">
        <h2 className="page__title" id="result-title">
          {title}
        </h2>
        <p className="page__lead">{reason}</p>
      </div>

      <div className="block">
        <h3 className="block__title">この依頼</h3>
        <p className="block__empty">{job.request}</p>
      </div>

      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}

      <div className="page__actions">
        <button type="button" className="button button--primary" onClick={onRetry}>
          依頼を直してやり直す
        </button>
      </div>
    </section>
  );
}
