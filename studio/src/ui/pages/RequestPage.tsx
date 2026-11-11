// 依頼の画面（Issue #869 の目的・1）。自由記述 1 欄と例のチップ、
// できること・まだできないこと、費用の表示。空では送れず、残りが足りなければ押せない。
import { useEffect, useState } from "react";
import type { BudgetView } from "../../shared/api";
import { BudgetNote, formatUsd, hasEnoughBudget } from "../components/BudgetNote";

export const MAX_REQUEST_CHARS = 4_000;

const EXAMPLES: readonly { readonly label: string; readonly text: string }[] = [
  {
    label: "割り勘",
    text: "旅行の割り勘を計算したい。人数と支払った額を入れると、1 人いくらかを出してほしい。",
  },
  {
    label: "当番",
    text: "掃除の当番を順番に回したい。誰がいつ担当かを一覧で見たい。",
  },
  {
    label: "貸し借り",
    text: "友だちとの貸し借りを記録したい。何をいつ貸したかを残したい。",
  },
];

export interface RequestPageProps {
  readonly budget: BudgetView | null;
  readonly budgetLoading?: boolean;
  readonly budgetError?: string | null;
  readonly initialRequest?: string;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onStart: (request: string) => void | Promise<void>;
}

export function RequestPage({
  budget,
  budgetLoading = false,
  budgetError = null,
  initialRequest = "",
  submitting = false,
  error = null,
  onStart,
}: RequestPageProps) {
  const [text, setText] = useState(initialRequest);
  // 依頼を直してやり直すときは、画面がすでに開いていても元の依頼文を入れる（Issue #886）。
  useEffect(() => {
    setText(initialRequest);
  }, [initialRequest]);
  const trimmed = text.trim();
  const enoughBudget = hasEnoughBudget(budget);
  const tooLong = text.length > MAX_REQUEST_CHARS;
  const canSend = trimmed !== "" && enoughBudget && !tooLong && !submitting;

  const reason = !enoughBudget
    ? "今日の残りが 1 回の上限に足りないため、送れません。明日また試してください。"
    : tooLong
      ? `依頼は ${MAX_REQUEST_CHARS} 字までです。`
      : trimmed === ""
        ? "依頼を書いてください。"
        : null;

  return (
    <section className="page" aria-labelledby="request-title">
      <div className="page__head">
        <h2 className="page__title" id="request-title">
          依頼を書く
        </h2>
        <p className="page__lead">どんなものを作りたいかを、ふだんの言葉で書いてください。</p>
      </div>

      <form
        className="page__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void onStart(trimmed);
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="request-text">
            つくりたいもの
          </label>
          <textarea
            id="request-text"
            className="field__input field__input--request"
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="例：旅行の割り勘を計算できるようにしたい"
          />
        </div>

        <div className="examples" aria-label="例">
          <p className="examples__lead">例から始める</p>
          <div className="examples__chips">
            {EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                className="chip"
                onClick={() => setText(example.text)}
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>

        <div className="notes">
          <section className="notes__block">
            <h3 className="notes__title">できること</h3>
            <ul className="notes__list">
              <li>身近な用事を、小さなアプリの形にまとめます。</li>
              <li>一覧・入力・計算など、よくある形を組み合わせます。</li>
              <li>できあがったものは、その場で開いて確かめられます。</li>
            </ul>
          </section>
          <section className="notes__block">
            <h3 className="notes__title">まだできないこと</h3>
            <ul className="notes__list">
              <li>写真や音声を扱うものは、まだ作れません。</li>
              <li>外部のサービスとつながるものは、まだ作れません。</li>
              <li>公開は、手元で確かめてからになります。</li>
            </ul>
          </section>
        </div>

        <BudgetNote budget={budget} loading={budgetLoading} error={budgetError} />

        {reason === null ? null : (
          <p className="page__warning" role="alert">
            {reason}
          </p>
        )}
        {error === null ? null : (
          <p className="page__warning" role="alert">
            {error}
          </p>
        )}

        <div className="page__actions">
          <button type="submit" className="button button--primary" disabled={!canSend}>
            {submitting ? "送っています…" : "依頼を送る"}
          </button>
          <p className="page__hint">
            1 回の上限は {budget === null ? "2.00 USD" : formatUsd(budget.perRunLimitUsd)} です。
          </p>
        </div>
      </form>
    </section>
  );
}
