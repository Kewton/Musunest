// 作成中の段の進み（Issue #870 の目的・1）。段の表示名・経過時間・概算の額を出す。
// 段の並びは工場の段の表示名（名前の表 → 試験 → 書く → 点検）に合わせる。
import type { ApiProgress } from "../../shared/api";
import { formatUsd } from "./BudgetNote";

/** 段の並び（工場が進みに出す表示名） */
export const STAGE_NAMES = ["名前の表", "試験", "書く", "点検"] as const;

/** 秒を、利用者の言葉の経過時間にする（1 分未満は秒だけ） */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours} 時間 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

export interface StageProgressProps {
  readonly progress: ApiProgress;
}

export function StageProgress({ progress }: StageProgressProps) {
  const current = STAGE_NAMES.findIndex((name) => name === progress.stage);

  return (
    <section className="progress" aria-label="作成中の進み">
      <p className="progress__stage" aria-live="polite">
        {progress.stage}
      </p>
      <ul className="progress__stages" aria-label="段の並び">
        {STAGE_NAMES.map((name, index) => (
          <li
            key={name}
            className={
              index === current
                ? "progress__step progress__step--current"
                : index < current
                  ? "progress__step progress__step--done"
                  : "progress__step"
            }
            {...(index === current ? { "aria-current": "step" as const } : {})}
          >
            {name}
          </li>
        ))}
      </ul>
      <dl className="progress__figures">
        <div>
          <dt>経過時間</dt>
          <dd>{formatElapsed(progress.elapsedSeconds)}</dd>
        </div>
        <div>
          <dt>概算の額</dt>
          <dd>{formatUsd(progress.estimatedUsd)}</dd>
        </div>
      </dl>
    </section>
  );
}
