// 一覧（M1.3。Issue #158）——`type: list` の一覧。**縦に積む**見せ方で、狭い画面に向く。
//
// この部品が決めるのは次の 3 つだけである。
//   1. 並べ方 — **`show` の順**である（扱いは `table` と揃える。書かなければ項目（宣言の順）に
//      続いて計算（宣言の順））。行は API が返した順（登録順）のまま
//   2. 絞り込み — `filters` の選択肢（**「すべて」を含む**）を出し、**画面の中だけで**行を絞る。
//      選択の初期状態は「すべて」である
//   3. 行ごとのボタン — **API が返した `row.allowedActions` をそのまま見る**
//      （画面は `when` の式を評価しない。断るのは data-api。`03` §2.2）
//
// **絞り込みは画面の中で行う。** Data API には絞り込みの引数を足さない（M1.3 は読むのは全件のまま。
// 上限は M1.5）。だから、選択を変えても通信は起きない。**選んだ値は持ち回さない**——再読み込みで消えてよい
// （URL にも保存にも残さない。そう決めたことを意味の文書に書く）。
//
// **0 件の見せ方を 2 つに分ける**（受入条件。`04` §7.3）。行が 1 件も無いときは「まだ記録がありません」、
// 絞り込んだ結果が 0 件のときは「条件に合う記録がありません」である。**どちらも空欄に読み替えない**。
//
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。
// `flex-wrap` と `max-width: 100%` を inline で当て、**表のように横へ流さない**（幅 360 CSS px）。

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Action, ApiRow, ApiValue, ApiViewBody } from "@musunest/sdk";

/** 絞り込みの 1 項目。`options` は**「すべて」を除いた**候補である（値と、画面に出す表示名） */
export interface FilterField {
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface ListScreenProps {
  readonly view: ApiViewBody;
  /** 並べる項目と計算の名前（宣言の `show` の順）。書いていなければ `undefined` */
  readonly show: readonly string[] | undefined;
  /** 画面で選んで絞り込む項目（宣言の `filters` の順）。無ければ絞り込みを出さない */
  readonly filters: readonly FilterField[];
  /** 項目の名前を画面に出す文字列へ写す（`label` があればそれ、無ければ識別子。API の `labels` を見る） */
  readonly displayName: (name: string) => string;
  /** 項目の値を画面に出す文字列へ写す（参照は名前へ。呼ぶ側が渡す） */
  readonly labelOf: (field: string, value: ApiValue | undefined) => string;
  /** その entity の決まった値への書き換え（`set` を持つ操作。M1.3）。宣言の順 */
  readonly setActions: readonly Action[];
  /**
   * 行ごとの消すボタン（参照されている行には断りの理由）。**table と同じ処理を呼ぶ側が渡す**——
   * この部品の中にボタンの出し方も断りの見せ方も持たない（Issue #214）。`undefined` なら何も出さない
   */
  readonly renderDelete: ((row: ApiRow) => ReactNode) | undefined;
  /**
   * 行ごとの「直す」の見せ方（`set` を持たない `kind: update`。M1.5。Issue #215）。**table・ボードと
   * 同じ処理を呼ぶ側が渡す**——この部品の中にボタンの出し方もフォームの開き方も持たない。
   * `undefined` なら何も出さない
   */
  readonly renderEdit: ((row: ApiRow) => ReactNode) | undefined;
  readonly onRunAction: (actionName: string, id: string) => void;
}

// ── 見た目（幅 360 CSS px で横に流さない。04 §7.2） ──────────────────────

const SCROLL_STYLE: CSSProperties = { maxWidth: "100%" };
const FILTERS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  margin: "0 0 12px",
  maxWidth: "100%",
};
const FILTER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  maxWidth: "100%",
};
const SELECT_STYLE: CSSProperties = { maxWidth: "100%", minHeight: 44 };
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0, maxWidth: "100%" };
const ROW_STYLE: CSSProperties = {
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
  marginBottom: 8,
  maxWidth: "100%",
  overflowWrap: "anywhere",
};
const FIELDS_STYLE: CSSProperties = { margin: 0 };
const FIELD_STYLE: CSSProperties = { display: "flex", gap: 4 };
const TERM_STYLE: CSSProperties = { fontWeight: "normal", color: "#4a4a4a" };
const VALUE_STYLE: CSSProperties = { margin: 0, overflowWrap: "anywhere" };

/** 選択肢の先頭に置く「すべて」の値。**初期状態はこれである**（絞り込んだ状態では始めない） */
const ALL = "";
const ALL_LABEL = "すべて";

/** 並べる列。**`show` の順**、書かなければ項目（宣言の順）に続いて計算（宣言の順）——`table` と同じ */
function columnsOf(
  view: ApiViewBody,
  show: readonly string[] | undefined,
): readonly { readonly name: string; readonly computed: boolean }[] {
  if (show === undefined) {
    return [
      ...view.fields.map((name) => ({ name, computed: false })),
      ...view.computed.map((name) => ({ name, computed: true })),
    ];
  }
  return show.map((name) => ({ name, computed: !view.fields.includes(name) }));
}

/** その行の、その項目の値。**絞り込みはキー（`enum` のキー・`ref` の ID）で比べる** */
function filterValueOf(row: ApiRow, name: string): string {
  const value = row.fields[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** 計算の値。**返ってきた値をそのまま見せる**（求められなかった `null` は「—」。0 と区別する） */
const computedText = (value: number | boolean | null | undefined): string =>
  value === null ? "—" : value === undefined ? "" : String(value);

/** その行で、その操作を実行してよいか。`allowedActions` が無ければ「条件が宣言されていない」＝実行できる */
const isAllowed = (row: ApiRow, actionName: string): boolean =>
  row.allowedActions === undefined || row.allowedActions.includes(actionName);

export function ListScreen({
  view,
  show,
  filters,
  displayName,
  labelOf,
  setActions,
  renderDelete,
  renderEdit,
  onRunAction,
}: ListScreenProps) {
  // 絞り込みの選択。**初期状態は「すべて」**である。この状態だけが持ち、持ち回さない（再読み込みで消えてよい）
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const columns = columnsOf(view, show);

  const rows = view.rows.filter((row) =>
    filters.every((filter) => {
      const selected = chosen[filter.name] ?? ALL;
      return selected === ALL || filterValueOf(row, filter.name) === selected;
    }),
  );
  const empty = view.rows.length === 0;
  const filteredEmpty = !empty && rows.length === 0;

  return (
    <div
      className="list"
      data-state={empty ? "empty" : filteredEmpty ? "filteredEmpty" : "ready"}
      style={SCROLL_STYLE}
    >
      {filters.length > 0 && (
        <div className="list-filters" role="group" aria-label="絞り込み" style={FILTERS_STYLE}>
          {filters.map((filter) => (
            <label className="list-filter" data-filter={filter.name} key={filter.name} style={FILTER_STYLE}>
              {filter.name}
              <select
                value={chosen[filter.name] ?? ALL}
                style={SELECT_STYLE}
                onChange={(event) => {
                  const value = event.target.value;
                  setChosen((current) => ({ ...current, [filter.name]: value }));
                }}
              >
                <option value={ALL}>{ALL_LABEL}</option>
                {filter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {!empty && (
        <ul className="list-rows" style={LIST_STYLE}>
          {rows.map((row) => (
            <li className="list-row" data-row={row.id} key={row.id} style={ROW_STYLE}>
              <dl className="list-fields" style={FIELDS_STYLE}>
                {columns.map((column) => (
                  <div className="list-field" data-field={column.name} key={column.name} style={FIELD_STYLE}>
                    <dt style={TERM_STYLE}>{displayName(column.name)}</dt>
                    <dd style={VALUE_STYLE}>
                      {column.computed
                        ? computedText(row.computed[column.name])
                        : labelOf(column.name, row.fields[column.name])}
                    </dd>
                  </div>
                ))}
              </dl>
              {setActions
                .filter((action) => isAllowed(row, action.name))
                .map((action) => (
                  <button
                    type="button"
                    className="run-action"
                    data-action={action.name}
                    data-row={row.id}
                    key={action.name}
                    onClick={() => onRunAction(action.name, row.id)}
                  >
                    {action.name}
                  </button>
                ))}
              {/* 行ごとの消すボタン（参照されている行には理由）。**table・ボードと同じ処理**を呼ぶ（Issue #214） */}
              {renderDelete?.(row)}
              {/* 行ごとの「直す」。**table・ボードと同じ処理**を呼ぶ（M1.5。Issue #215） */}
              {renderEdit?.(row)}
            </li>
          ))}
        </ul>
      )}
      {empty && (
        <p className="state empty" data-state="empty">
          まだ記録がありません
        </p>
      )}
      {filteredEmpty && (
        // **0 件（絞り込みの結果）**は、行が 1 件も無いときとは別の文言である（空欄にも読み替えない）
        <p className="state empty" data-state="filteredEmpty">
          条件に合う記録がありません
        </p>
      )}
    </div>
  );
}
