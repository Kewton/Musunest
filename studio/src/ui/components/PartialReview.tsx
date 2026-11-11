// partial の結果の了承（Issue #870 の目的・3）。できたこと・できなかったこと・決めたことを
// 並べ、納品物の SHA の短い形を添えて「了承して公開する」を出す。
//
// **了承の前は公開のボタンを置かない。** 了承の要求には、画面が見せた SHA をそのまま入れる。
// 了承を既定で済ませる口・自動の口は作らない（禁止事項）。
import type { ApiPartialLimitation } from "../../shared/api";

/** SHA の短い形（先頭 12 桁）。32 桁の 16 進を画面に出さないため */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export interface PartialReviewProps {
  readonly built: readonly string[];
  readonly missing: readonly ApiPartialLimitation[];
  readonly decided: readonly string[];
  /** 了承の要求にそのまま送る SHA（無ければ了承できない） */
  readonly manifestSha: string | null;
  readonly approving?: boolean;
  readonly error?: string | null;
  readonly onApprove: (manifestSha: string) => void | Promise<void>;
}

export function PartialReview({
  built,
  missing,
  decided,
  manifestSha,
  approving = false,
  error = null,
  onApprove,
}: PartialReviewProps) {
  const canApprove = manifestSha !== null && manifestSha !== "" && !approving;

  return (
    <div className="partial">
      <section className="block" aria-labelledby="partial-built">
        <h3 className="block__title" id="partial-built">
          できたこと
        </h3>
        {built.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {built.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="partial-missing">
        <h3 className="block__title" id="partial-missing">
          できなかったこと
        </h3>
        {missing.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list block__list--limitations">
            {missing.map((entry) => (
              <li key={entry.what}>
                <span className="block__what">{entry.what}</span>
                <span className="block__alternative">代わりに: {entry.alternative}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="partial-decided">
        <h3 className="block__title" id="partial-decided">
          決めたこと
        </h3>
        {decided.length === 0 ? (
          <p className="block__empty">なし</p>
        ) : (
          <ul className="block__list">
            {decided.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="partial-sha">
        <h3 className="block__title" id="partial-sha">
          この内容でよければ
        </h3>
        <p className="block__empty">
          いまの納品物の SHA（短い形）:{manifestSha === null ? "読み込めませんでした" : ` ${shortSha(manifestSha)}`}
        </p>
        {error === null ? null : (
          <p className="page__warning" role="alert">
            {error}
          </p>
        )}
        <div className="page__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!canApprove}
            onClick={() => {
              if (manifestSha === null) return;
              void onApprove(manifestSha);
            }}
          >
            {approving ? "了承しています…" : "了承して公開する"}
          </button>
        </div>
      </section>
    </div>
  );
}
