// 質問 1 つのカード（Issue #869 の目的・3）。選択肢・おすすめの印と理由・自由入力を持つ。
// 自由入力は 500 字まで。超えたら送れない（送る側が isTooLong を見る）。
import type { ApiQuestion } from "../../shared/api";

export const MAX_FREE_TEXT_CHARS = 500;

export interface AnswerDraft {
  readonly choiceId?: string;
  readonly freeText?: string;
}

export interface QuestionCardProps {
  readonly question: ApiQuestion;
  readonly draft: AnswerDraft;
  readonly position: number;
  readonly onChange: (next: AnswerDraft) => void;
}

/** 選択肢か自由入力のどちらかで答えているか */
export function isAnswered(question: ApiQuestion, draft: AnswerDraft): boolean {
  if (draft.choiceId !== undefined) {
    return question.choices.some((choice) => choice.id === draft.choiceId);
  }
  return (draft.freeText ?? "").trim() !== "";
}

/** 自由入力が上限を超えているか */
export function isTooLong(draft: AnswerDraft): boolean {
  return (draft.freeText?.length ?? 0) > MAX_FREE_TEXT_CHARS;
}

export function QuestionCard({ question, draft, position, onChange }: QuestionCardProps) {
  const freeText = draft.freeText ?? "";
  const tooLong = isTooLong(draft);
  const freeTextId = `free-${question.id}`;

  return (
    <fieldset className="question">
      <legend className="question__title">
        問 {position}. {question.text}
      </legend>
      <div className="question__choices">
        {question.choices.map((choice) => (
          <div className="question__choice" key={choice.id}>
            <label className="question__label">
              <input
                type="radio"
                name={`question-${question.id}`}
                checked={draft.choiceId === choice.id}
                onChange={() => onChange({ choiceId: choice.id })}
              />
              <span>{choice.text}</span>
            </label>
            {choice.id === question.recommended.choiceId ? (
              <span className="question__recommended">おすすめ</span>
            ) : null}
          </div>
        ))}
      </div>
      <p className="question__reason">おすすめの理由: {question.recommended.reason}</p>
      {question.allowFreeText ? (
        <div className="field">
          <label className="field__label" htmlFor={freeTextId}>
            自由に入力する
          </label>
          <textarea
            id={freeTextId}
            className="field__input"
            rows={3}
            value={freeText}
            aria-invalid={tooLong}
            onChange={(event) => onChange({ freeText: event.target.value })}
          />
          <p className={tooLong ? "field__count field__count--over" : "field__count"}>
            {freeText.length}/{MAX_FREE_TEXT_CHARS}
          </p>
          {tooLong ? (
            <p className="field__error" role="alert">
              自由入力は {MAX_FREE_TEXT_CHARS} 字までです。
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
