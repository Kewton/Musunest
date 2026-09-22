// ダッシュボード（M1.4。Issue #180）——`type: dashboard` の一覧。**行を並べない**——
// 計算した値そのものを部品（`widgets`）で並べる。M1.1〜M1.3 の画面は「行の一覧」だったが、
// ここが初めて値そのものを並べる形である。
//
// この部品が決めるのは次の 3 つだけである。
//   1. どの値を出すか — 部品が指す計算の値（`view.scope`。**計算の名前 → 値**）をそのまま見せる。
//      **画面は式も集計も評価しない**（`CLAUDE.md` の不変条件。判定も集計も Data API が行う）
//   2. 単位（`unit`）と表示名（`label`）をどう出すか — 宣言に書いてあれば添える（「回」「人」「円」）
//   3. **値が `null` のときは「—」で見せる**——0 と区別する（docs/semantics.md「computed」「avg」）
//
// **部品は 4 つの状態を持つ**（workspace/mvp/m1/04-spec-evolution.md §7.3）——空・多い・エラー・権限なし。
// 権限なし（`read` が無い）は API が 403 を返し、画面（renderer）がその理由を出す。この部品が持つのは
// 空（部品が 1 つも無い）・多い（部品が多い）・エラー（値を載せる `scope` が無い）である。
//
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。
// 部品は**折り返して縦に伸びる**——**幅 360 CSS px で、ページ全体を横に押し広げない**（`04` §7.2）。

import type { CSSProperties } from "react";
import type { ApiViewBody } from "@musunest/sdk";

/**
 * 数値の部品の形（`View` の `widgets` の 1 つ。M1.4。Issue #180）。`label`（表示名）と `unit`（単位）は
 * 任意である。**宣言の型（`@musunest/appspec-schema` の `NumberPart`）と構造的に同じ**である
 * （画面が持てる依存は sdk だけなので、型はここで写す。`View` の `widgets` から代入できる）。
 */
export interface DashboardPart {
  readonly type: "number";
  /** 指すアプリ全体の計算の名前。`view.scope` をこの名前で引く */
  readonly value: string;
  /** 表示名（`label`）。無ければ `value` の識別子をそのまま見せる */
  readonly label?: string;
  /** 単位（「回」「人」「円」など）。無ければ数をそのまま見せる */
  readonly unit?: string;
}

export interface DashboardProps {
  readonly view: ApiViewBody;
  /** 並べる部品（宣言の `widgets` の順）。書いていなければ空である */
  readonly parts: readonly DashboardPart[];
}

// ── 見た目（幅 360 CSS px で横に流さない。04 §7.2） ──────────────────────

const SCROLL_STYLE: CSSProperties = { maxWidth: "100%" };
const PARTS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  margin: 0,
  maxWidth: "100%",
};
const PART_STYLE: CSSProperties = {
  flex: "1 1 120px",
  minWidth: 0,
  maxWidth: "100%",
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
};
const TERM_STYLE: CSSProperties = { margin: 0, fontSize: "0.9rem", color: "#4a4a4a" };
const VALUE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "1.5rem",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

/**
 * 部品が多いと見なす数（M1.4。Issue #181 の「見出しが 12 個以上」と揃える）。
 * **上限は置かない**——多いときも全部を折り返して並べる（画面は壊れない）。
 */
export const MANY_PARTS = 12;

/**
 * 計算の値を、画面に出す文字列にする。**API が返した値をそのまま見せる**（画面は式も集計も評価しない）。
 * 求められなかった値の `null` は「—」で見せ、**0 と区別する**（docs/semantics.md「computed」）。
 * 数は小数第 1 位まで（四捨五入）で見せ、整数はそのままにする（`2000` を `2000.0` にしない。「avg」の節）。
 */
function valueText(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 部品の表示名。**宣言の `label` があればそれ、無ければ `value` の識別子をそのまま出す** */
const partHeading = (part: DashboardPart): string => part.label ?? part.value;

/** 部品の値。**単位を添えて見せる**（`label` と揃えて、`null` のときも単位は出す） */
function partValueText(part: DashboardPart, scope: Readonly<Record<string, number | null>>): string {
  const value = scope[part.value] ?? null;
  const text = valueText(value);
  return part.unit === undefined ? text : `${text} ${part.unit}`;
}

export function Dashboard({ view, parts }: DashboardProps) {
  const scope = view.scope;

  // **値を載せる `scope` が無い**——部品が指す値を読めなかった（配信された応答の不整合である）。
  // 空の値に読み替えず、読めなかったことをそのまま出す
  if (scope === undefined) {
    return (
      <p className="state failure" data-state="dashboardUnavailable" role="alert">
        集計の値を表示できません
      </p>
    );
  }

  // **空**：部品が 1 つも無ければ、出すものが無い（正しい宣言では起きない。守りは静的チェック）
  if (parts.length === 0) {
    return (
      <p className="state empty" data-state="empty">
        表示する部品がありません
      </p>
    );
  }

  // **多い**：部品が多いときも上限を置かない（全部を折り返して並べる）。状態だけを伝える
  const state = parts.length >= MANY_PARTS ? "many" : "ready";

  return (
    <div className="dashboard" data-state={state} style={SCROLL_STYLE}>
      <dl className="dashboard-parts" aria-label="アプリ全体の集計" style={PARTS_STYLE}>
        {parts.map((part) => (
          <div className="dashboard-part" data-part={part.value} key={part.value} style={PART_STYLE}>
            <dt style={TERM_STYLE}>{partHeading(part)}</dt>
            <dd style={VALUE_STYLE}>{partValueText(part, scope)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
