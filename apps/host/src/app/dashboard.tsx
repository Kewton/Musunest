// ダッシュボード（M1.4。Issue #180・#181・#182）——`type: dashboard` の一覧。**行を並べない**——
// 計算した値そのものを部品（`widgets`）で並べる。M1.1〜M1.3 の画面は「行の一覧」だったが、
// ここが初めて値そのものを並べる形である。
//
// この部品が決めるのは次の 3 つだけである。
//   1. どの値を出すか — 部品が指す値（**数値は `view.scope`**、**棒と円は `view.groups`**、
//      **順位は `view.ranking`**）をそのまま見せる。**画面は式も集計も評価しない**（`CLAUDE.md` の
//      不変条件。判定も集計も並べ替えも Data API が行う）
//   2. 単位（`unit`）と表示名（`label`）をどう出すか — 宣言に書いてあれば添える（「回」「人」「円」）
//   3. **値が `null` のときは「—」で見せる**——0 と区別する（docs/semantics.md「computed」「avg」）
//
// 棒（`bar`）と円（`pie`）は `chart.tsx` が（M1.4。Issue #181）、順位（`ranking`）は `ranking.tsx` が描く
// （M1.4。Issue #182）。ここが決めるのは、**どの部品をどの値（`scope` か `groups` か `ranking` か）に
// 結びつけるか**である。
//
// **部品は 4 つの状態を持つ**（workspace/mvp/m1/04-spec-evolution.md §7.3）——空・多い・エラー・権限なし。
// 権限なし（`read` が無い）は API が 403 を返し、画面（renderer）がその理由を出す。この部品が持つのは
// 空（部品が 1 つも無い）・多い（部品が多い）・エラー（値を載せる欄が無い）である。
//
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。
// 部品は**折り返して縦に伸びる**——**幅 360 CSS px で、ページ全体を横に押し広げない**（`04` §7.2）。

import type { CSSProperties } from "react";
import { displayNameOf } from "@musunest/sdk";
import type { ApiValue, ApiViewBody } from "@musunest/sdk";
import { Chart } from "./chart";
import type { ChartPart } from "./chart";
import { Ranking } from "./ranking";
import type { RankingPart } from "./ranking";

/**
 * 数値の部品（`View` の `widgets` の 1 つ。M1.4。Issue #180）。`label`（表示名）と `unit`（単位）は
 * 任意である。**宣言の型（`@musunest/appspec-schema` の `NumberPart`）と構造的に同じ**である
 * （画面が持てる依存は sdk だけなので、型はここで写す。`View` の `widgets` から代入できる）。
 */
export interface DashboardNumberPart {
  readonly type: "number";
  /** 指すアプリ全体の計算の名前。`view.scope` をこの名前で引く */
  readonly value: string;
  /** 表示名（`label`）。無ければ `value` の識別子をそのまま見せる */
  readonly label?: string;
  /** 単位（「回」「人」「円」など）。無ければ数をそのまま見せる */
  readonly unit?: string;
}

/**
 * ダッシュボードに並べる部品（M1.4。Issue #180・#181・#182）。**指す値の欄が種類で決まる**。
 *   - 数値（`number`）… `view.scope`（1 つの数）
 *   - 棒（`bar`）・円（`pie`）… `view.groups`（見出しと値の組の並び）。型は `chart.tsx` の `ChartPart`
 *   - 順位（`ranking`）… `view.ranking`（鍵 → 別の entity の行の並び）。型は `ranking.tsx` の `RankingPart`
 */
export type DashboardPart = DashboardNumberPart | ChartPart | RankingPart;

export interface DashboardProps {
  readonly view: ApiViewBody;
  /** 並べる部品（宣言の `widgets` の順）。書いていなければ空である */
  readonly parts: readonly DashboardPart[];
  /**
   * 見出しを画面に出す文字列へ写す（グラフの `enum` の見出しを宣言の `options` の表示名にする）。
   * 第 1 引数は**見出しごとの集計の名前**（部品の `value`）である——どの計算の見出しかで、見る
   * `options` が変わるからである。書かなければ、受け取った見出しをそのまま出す（月は `YYYY-MM` のまま）。
   */
  readonly headingOf?: (groupName: string, heading: string) => string;
  /**
   * **順位の部品の項目の見出し**（宣言の `label`。無ければ識別子）を引く（M1.4。Issue #204）。
   * 順位は**別の entity の行**を並べるので、その entity の宣言から引く——ダッシュボードは `entity` を
   * 持たないので、応答の `labels` が載らず、名前の対応が手元に無いからである。
   * 書かなければ、受け取った名前をそのまま出す（識別子のまま）。
   */
  readonly itemLabelOf?: (entityName: string, item: string) => string;
  /**
   * **順位の部品の項目の値**を画面に出す文字列へ写す（M1.4。Issue #204）。**一覧・ボードと同じ処理**
   * （選択肢のキーを宣言の `options` の表示名に写す `displayOf`）を呼ぶ側が渡す。部品の中に写し方を
   * 持たない。書かなければ、値をそのまま見せる。
   */
  readonly valueLabelOf?: (entityName: string, field: string, value: ApiValue | undefined) => string;
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
/** 順位の部品の入れ物。**行を並べるので、数値の部品より広く取る**（折り返しは順位の部品が持つ） */
const RANKING_PART_STYLE: CSSProperties = {
  flex: "1 1 100%",
  minWidth: 0,
  maxWidth: "100%",
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
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

/** 数値の部品の表示名。**宣言の `label` があればそれ、無ければ `value` の識別子をそのまま出す** */
const partHeading = (part: DashboardNumberPart): string => part.label ?? part.value;

/** 数値の部品の値。**単位を添えて見せる**（`label` と揃えて、`null` のときも単位は出す） */
function partValueText(part: DashboardNumberPart, scope: Readonly<Record<string, number | null>>): string {
  const value = scope[part.value] ?? null;
  const text = valueText(value);
  return part.unit === undefined ? text : `${text} ${part.unit}`;
}

export function Dashboard({ view, parts, headingOf, itemLabelOf, valueLabelOf }: DashboardProps) {
  const scope = view.scope;
  const groups = view.groups;
  const numberParts = parts.filter((part): part is DashboardNumberPart => part.type === "number");
  const chartParts = parts.filter(
    (part): part is ChartPart => part.type === "bar" || part.type === "pie",
  );
  const rankingParts = parts.filter((part): part is RankingPart => part.type === "ranking");

  // **空**：部品が 1 つも無ければ、出すものが無い（正しい宣言では起きない。守りは静的チェック）
  if (parts.length === 0) {
    return (
      <p className="state empty" data-state="empty">
        表示する部品がありません
      </p>
    );
  }

  // **値を載せる `scope` が無い**——数値の部品が指す値を読めなかった（配信された応答の不整合である）。
  // 空の値に読み替えず、読めなかったことをそのまま出す
  if (numberParts.length > 0 && scope === undefined) {
    return (
      <p className="state failure" data-state="dashboardUnavailable" role="alert">
        集計の値を表示できません
      </p>
    );
  }

  // **値を載せる `groups` が無い**——棒・円の部品が指す「見出しと値の組の並び」を読めなかった（同上。
  // M1.4。Issue #181）
  if (chartParts.length > 0 && groups === undefined) {
    return (
      <p className="state failure" data-state="dashboardUnavailable" role="alert">
        集計の値を表示できません
      </p>
    );
  }

  // **順位を載せる `ranking` が無い**——順位の部品が並べる行を読めなかった（同じく応答の不整合である）
  if (rankingParts.length > 0 && view.ranking === undefined) {
    return (
      <p className="state failure" data-state="rankingUnavailable" role="alert">
        順位を表示できません
      </p>
    );
  }

  // **多い**：部品が多いときも上限を置かない（全部を折り返して並べる）。状態だけを伝える
  const state = parts.length >= MANY_PARTS ? "many" : "ready";
  const heading = headingOf ?? ((_groupName: string, headingText: string) => headingText);

  return (
    <div className="dashboard" data-state={state} style={SCROLL_STYLE}>
      {numberParts.length > 0 && (
        <dl className="dashboard-parts" aria-label="アプリ全体の集計" style={PARTS_STYLE}>
          {numberParts.map((part) => (
            <div className="dashboard-part" data-part={part.value} key={part.value} style={PART_STYLE}>
              <dt style={TERM_STYLE}>{partHeading(part)}</dt>
              <dd style={VALUE_STYLE}>{partValueText(part, scope ?? {})}</dd>
            </div>
          ))}
        </dl>
      )}
      {chartParts.map((part) => (
        // グラフは**API が返した `groups` をそのまま見せる**（画面は式も集計も評価しない）。
        // 値が求められなかった部品（`null`）は「—」で見せ、空の並びに読み替えない
        <Chart
          key={part.value}
          part={part}
          entries={groups?.[part.value] ?? null}
          headingOf={(headingText) => heading(part.value, headingText)}
        />
      ))}
      {/* 順位の部品（M1.4。Issue #182）。**API が並べた順をそのまま見せる**——画面は並べ替えない。
          鍵は `view.ranking` を引く名前である。**求められなかった順位（`null`）は「順位を表示できません」** */}
      {rankingParts.map((part) => (
        <div className="dashboard-part dashboard-ranking" data-part={part.name} key={part.name} style={RANKING_PART_STYLE}>
          <Ranking
            part={part}
            rows={view.ranking === undefined ? undefined : (view.ranking[part.name] ?? null)}
            // 見出しは手元の宣言の表示名（ダッシュボードの応答には `labels` が載らない）。無ければ識別子
            displayName={(name) => itemLabelOf?.(part.entity, name) ?? displayNameOf(view.labels, name)}
            // 値は**一覧・ボードと同じ処理**を通す（選択肢のキーを表示名へ。Issue #204）。渡されなければ
            // 部品が値をそのまま見せる（`exactOptionalPropertyTypes` なので、無いときは欄ごと渡さない）
            {...(valueLabelOf === undefined
              ? {}
              : {
                  labelOf: (field: string, value: ApiValue | undefined) =>
                    valueLabelOf(part.entity, field, value),
                })}
          />
        </div>
      ))}
    </div>
  );
}
