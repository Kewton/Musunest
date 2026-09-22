// 順位の部品（M1.4。Issue #182）——`type: ranking` の部品。**行を並べる唯一の部品**である。
//
// この部品が決めるのは次の 4 つだけである。
//   1. **どの行を、どの順で出すか** — API（Data API）が `by` の降順で並べ、`limit` で切った行を
//      **そのままの順で見せる**。**画面は式も集計も評価しないし、並べ替えもしない**（`CLAUDE.md` の不変条件）。
//      同数の順（登録した順）も API が決める——画面は受け取った順を崩さない
//   2. **何を出すか** — 宣言の `show` に書いた名前を、その順に見せる（項目は `fields` から、計算は
//      `computed` から読む。**どちらであるかは行の値を見て決める**）
//   3. **見出しをどう出すか** — `label` があればそれを、無ければ `name` を見出しにする
//   4. **値が `null` のときは「—」で見せる**——0 と区別する（docs/semantics.md「computed」）
//
// **部品は 4 つの状態を持つ**（workspace/mvp/m1/04-spec-evolution.md §7.3）——空・多い・エラー・権限なし。
// 権限なし（`read` が無い）は API が 403 を返し、画面（renderer）がその理由を出す。この部品が持つのは
// 空（該当が 0 件）・多い（行が多い）・エラー（順位を載せる値が無い・求められなかった）である。
//
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。
// **表のように横に流さない**——**幅 360 CSS px で、ページ全体を横に押し広げない**（`04` §7.2）。

import type { CSSProperties } from "react";
import type { ApiRow, ApiValue } from "@musunest/sdk";

/**
 * 順位の部品の形（`View` の `widgets` の 1 つ。M1.4。Issue #182）。`label`（表示名）と `limit`（件数の上限）は
 * 任意である。**宣言の型（`@musunest/appspec-schema` の `RankingPart`）と構造的に同じ**である
 * （画面が持てる依存は sdk だけなので、型はここで写す。`View` の `widgets` から代入できる）。
 */
export interface RankingPart {
  readonly type: "ranking";
  /** 鍵。応答の `ranking` の欄を引く名前である（`label` とは別物である） */
  readonly name: string;
  /** 並べる相手の entity */
  readonly entity: string;
  /** 並べ替えの基準になる、行ごとの数の計算の名前 */
  readonly by: string;
  /** 出す項目（宣言の順） */
  readonly show: readonly string[];
  /** 件数の上限。無ければ API が既定（5）を適用する——画面は切らない */
  readonly limit?: number;
  /** 表示名（`label`）。無ければ `name` を見出しにする */
  readonly label?: string;
}

export interface RankingProps {
  readonly part: RankingPart;
  /**
   * 鍵（`part.name`）で引いた行の並び。**求められなければ `null`**、宣言が無ければ `undefined` である
   * ——どちらも「空の並び」には読み替えない（0 件と区別する）。
   */
  readonly rows: readonly ApiRow[] | null | undefined;
  /** 見出しに使う表示名（`label`）。無ければ名前をそのまま返す */
  readonly displayName?: (name: string) => string;
}

// ── 見た目（幅 360 CSS px で横に流さない。04 §7.2） ──────────────────────

const ROOT_STYLE: CSSProperties = { maxWidth: "100%" };
const HEADING_STYLE: CSSProperties = { margin: "0 0 4px", fontSize: "0.9rem", color: "#4a4a4a" };
const ROWS_STYLE: CSSProperties = { margin: 0, paddingLeft: 0, listStyle: "none", maxWidth: "100%" };
const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: 8,
  minWidth: 0,
  maxWidth: "100%",
  padding: "4px 0",
  borderTop: "1px solid #e2e2e2",
};
const POSITION_STYLE: CSSProperties = { minWidth: "1.5em", fontWeight: 700, color: "#4a4a4a" };
const CELL_STYLE: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word" };

/**
 * 行が多いと見なす数（M1.4。Issue #180 の `MANY_PARTS` と揃える）。**上限は置かない**——
 * 多いときも全部を折り返して並べる（画面は壊れない。切るのは API の `limit` の仕事である）。
 */
export const MANY_ROWS = 12;

const isList = (value: ApiValue | undefined): value is readonly string[] => Array.isArray(value);

/** 項目の値。`list` は入力の順のまま読める形にし、無い値は空欄にする */
function fieldText(value: ApiValue | undefined): string {
  if (value === undefined) return "";
  if (isList(value)) return value.join(", ");
  return String(value);
}

/** 数を、小数第 1 位まで（四捨五入）で見せる。整数はそのままである */
function numberText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 計算の値。求められなかった値の `null` は「—」で見せ、**0 と区別する**（docs/semantics.md「computed」） */
function computedText(value: number | boolean | null | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "—";
  return typeof value === "number" ? numberText(value) : String(value);
}

/**
 * 1 つのセルの値。**項目（`fields`）にあればその値、無ければ計算（`computed`）の値**である
 * （名前は重ならないので、応答の項目に無ければ計算である。`renderer.tsx` の表と同じ読み方である）。
 */
function cellText(row: ApiRow, name: string): string {
  const field = row.fields[name];
  return field === undefined ? computedText(row.computed[name]) : fieldText(field);
}

/** 部品の見出し。**宣言の `label` があればそれ、無ければ鍵（`name`）をそのまま出す** */
const partHeading = (part: RankingPart): string => part.label ?? part.name;

export function Ranking({ part, rows, displayName }: RankingProps) {
  const heading = partHeading(part);

  // **エラー**：順位を載せる値が無い（宣言はあるのに応答が無い＝配信された応答の不整合）か、
  // 求められなかった（`null`）。どちらも空の並びに読み替えず、読めなかったことをそのまま出す
  if (rows === undefined || rows === null) {
    return (
      <section className="ranking" data-state="rankingUnavailable" data-ranking={part.name}>
        <h3 style={HEADING_STYLE}>{heading}</h3>
        <p className="state failure" role="alert">
          順位を表示できません
        </p>
      </section>
    );
  }

  // **空**：行が 1 件も無ければ、出すものが無い（0 件と「求められなかった」を区別する）
  if (rows.length === 0) {
    return (
      <section className="ranking" data-state="empty" data-ranking={part.name}>
        <h3 style={HEADING_STYLE}>{heading}</h3>
        <p className="state empty">該当がありません</p>
      </section>
    );
  }

  // **多い**：行が多いときも上限を置かない（全部を折り返して並べる）。状態だけを伝える
  const state = rows.length >= MANY_ROWS ? "many" : "ready";
  const headingOf = displayName ?? ((name: string) => name);

  return (
    <section
      className="ranking"
      data-state={state}
      data-ranking={part.name}
      data-by={part.by}
      style={ROOT_STYLE}
    >
      <h3 style={HEADING_STYLE}>{heading}</h3>
      <ol className="ranking-rows" style={ROWS_STYLE}>
        {rows.map((row, index) => (
          <li className="ranking-row" data-rank={index + 1} data-row={row.id} key={row.id} style={ROW_STYLE}>
            <span className="ranking-rank" style={POSITION_STYLE}>
              {index + 1}
            </span>
            {part.show.map((name) => (
              <span className="ranking-cell" data-name={name} key={name}>
                <span className="ranking-cell-name">{headingOf(name)}</span>
                <span className="ranking-cell-value" style={CELL_STYLE}>
                  {cellText(row, name)}
                </span>
              </span>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
