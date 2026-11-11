// 質問の画面（Issue #869 の目的・3）。カードで最大 10 問。往復 n/3・残りの問数・
// 答えの期限の残り分を出し、「全部推奨で進める」と問いごとの答えの両方を送れる。
import { useState } from "react";
import type { AnswersRequest, ApiQuestionBundle, SubmittedAnswer } from "../../shared/api";
import {
  QuestionCard,
  isAnswered,
  isTooLong,
  type AnswerDraft,
} from "../components/QuestionCard";
import { remainingMinutes, useNow } from "../use-polling";

const MAX_QUESTIONS_PER_ROUND = 10;
const MAX_ROUND_TRIPS = 3;

export interface QuestionsPageProps {
  readonly bundle: ApiQuestionBundle;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onAnswer: (answers: AnswersRequest) => void | Promise<void>;
}

export function QuestionsPage({
  bundle,
  submitting = false,
  error = null,
  onAnswer,
}: QuestionsPageProps) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const now = useNow();
  const questions = bundle.questions.slice(0, MAX_QUESTIONS_PER_ROUND);

  const draftOf = (id: string): AnswerDraft => drafts[id] ?? {};
  const tooLong = questions.some((question) => isTooLong(draftOf(question.id)));
  const unanswered = questions.some((question) => !isAnswered(question, draftOf(question.id)));
  const canSend = !tooLong && !unanswered && !submitting;

  const remainingRoundTrips = Math.max(0, bundle.remaining.roundTrips);
  const usedRoundTrips = Math.max(
    0,
    Math.min(MAX_ROUND_TRIPS, MAX_ROUND_TRIPS - remainingRoundTrips),
  );
  const minutes = remainingMinutes(bundle.deadlineAt, now);

  const sendAnswers = (): void => {
    if (!canSend) return;
    const answers: SubmittedAnswer[] = questions.map((question) => {
      const draft = draftOf(question.id);
      if (draft.choiceId !== undefined) {
        return { questionId: question.id, choiceId: draft.choiceId };
      }
      return { questionId: question.id, freeText: draft.freeText ?? "" };
    });
    void onAnswer({ kind: "answers", revision: bundle.revision, answers });
  };

  return (
    <section className="page" aria-labelledby="questions-title">
      <div className="page__head">
        <h2 className="page__title" id="questions-title">
          いくつか教えてください
        </h2>
        <p className="page__lead">作るものを決めるために、まとめて聞きます。</p>
        <ul className="status">
          <li>往復 {usedRoundTrips}/{MAX_ROUND_TRIPS}</li>
          <li>残りの問数 {bundle.remaining.questions}</li>
          {minutes === null ? null : (
            <li>{minutes === 0 ? "答えの期限を過ぎています" : `答えの期限まであと ${minutes} 分`}</li>
          )}
        </ul>
      </div>

      <div className="questions">
        {questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            question={question}
            position={index + 1}
            draft={draftOf(question.id)}
            onChange={(next) => {
              setDrafts((current) => ({ ...current, [question.id]: next }));
            }}
          />
        ))}
      </div>

      {tooLong ? (
        <p className="page__warning" role="alert">
          自由入力は 500 字までです。短くしてください。
        </p>
      ) : unanswered ? (
        <p className="page__warning" role="alert">
          すべての問いに答えてください。
        </p>
      ) : null}
      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}

      <div className="page__actions">
        <button type="button" className="button button--primary" disabled={!canSend} onClick={sendAnswers}>
          {submitting ? "送っています…" : "この答えで進める"}
        </button>
        <button
          type="button"
          className="button"
          disabled={submitting}
          onClick={() => {
            void onAnswer({ kind: "all-recommended", revision: bundle.revision });
          }}
        >
          全部推奨で進める
        </button>
      </div>
    </section>
  );
}
