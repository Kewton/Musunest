// ボード（M1.3。Issue #157）——`type: board` の一覧。**計算はしない**
// （workspace/mvp/m1/03-spec-layers-and-checker.md §2.3「計算はロジック層、見せ方は UI 層」）。
//
// この部品が決めるのは次の 4 つだけである。
//   1. 列の並び — **`columns` が指す選択肢（enum）の `options` に書いた順**である（docs/semantics.md「board」）。
//      **空の列も出す**（カードが 1 枚も無い列も見える）
//   2. 強調 — `highlight` が指す真偽の計算の値を、**行の `computed` からそのまま見る**。
//      **画面は式を評価しない**（`CLAUDE.md` の不変条件）。判定するのは Data API である。
//      **色だけに頼らない**——記号と文字の印を添える（`04` §7.2）。
//   3. カードに出す値 — その entity の項目を宣言の順に並べる（参照は呼ぶ側が名前へ写した文字列を渡す）
//   4. 行ごとのボタン — **API が返した `row.allowedActions` をそのまま見る**。
//      **画面がボタンを隠すのは親切であって守りではない**（断るのは data-api。`03` §2.2）
//
// **1 列に並べるカードの数には上限を置かない**（上限は M1.5 で決める。measurements.md §6）。
// 多いときは縦に伸び、列は折り返す（横には流さない）——**幅 360 CSS px でページを押し広げない**。
//
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。
// `flex-wrap` と `max-width: 100%` を inline で当て、狭い画面でも横スクロールを出さない。

import type { CSSProperties, ReactNode } from "react";
import type { Action, ApiRow, ApiValue, ApiViewBody, Entity } from "@musunest/sdk";

/** 1 つの列。`key` が保存される値（選択肢のキー）、`label` が画面に出す表示名である */
interface BoardColumn {
  readonly key: string;
  readonly label: string;
}

export interface BoardProps {
  readonly view: ApiViewBody;
  readonly entity: Entity | undefined;
  /** 列にする選択肢（enum）の項目の名前（宣言の `columns`） */
  readonly columns: string;
  /** 強調する行を選ぶ真偽の計算の名前（宣言の `highlight`）。無ければ強調しない */
  readonly highlight: string | undefined;
  /** 項目の名前を画面に出す文字列へ写す（`label` があればそれ、無ければ識別子。API の `labels` を見る） */
  readonly displayName: (name: string) => string;
  /** 項目の値を画面に出す文字列へ写す（参照は名前へ。呼ぶ側が渡す） */
  readonly labelOf: (field: string, value: ApiValue | undefined) => string;
  /** その entity の決まった値への書き換え（`set` を持つ操作。M1.3）。宣言の順 */
  readonly setActions: readonly Action[];
  /**
   * カードごとの消すボタン（参照されている行には断りの理由）。**table と同じ処理を呼ぶ側が渡す**——
   * この部品の中にボタンの出し方も断りの見せ方も持たない（Issue #214）。`undefined` なら何も出さない
   */
  readonly renderDelete: ((row: ApiRow) => ReactNode) | undefined;
  readonly onRunAction: (actionName: string, id: string) => void;
}

// ── 見た目（幅 360 CSS px で横に流さない。04 §7.2） ──────────────────────

const SCROLL_STYLE: CSSProperties = { maxWidth: "100%" };
const BOARD_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, maxWidth: "100%" };
const COLUMN_STYLE: CSSProperties = { flex: "1 1 160px", minWidth: 0, maxWidth: "100%" };
const TITLE_STYLE: CSSProperties = { margin: "0 0 8px", fontSize: "1rem" };
const FIELDS_STYLE: CSSProperties = { margin: 0 };
const FIELD_STYLE: CSSProperties = { display: "flex", gap: 4 };
const TERM_STYLE: CSSProperties = { fontWeight: "normal", color: "#4a4a4a" };
const VALUE_STYLE: CSSProperties = { margin: 0, overflowWrap: "anywhere" };
const MARK_STYLE: CSSProperties = { margin: "0 0 4px", fontWeight: "bold" };

/**
 * 強調の色（M1.3。Issue #176）。**色だけに頼らない**——線は二重にし、記号と文字の印も添える
 * （`04` §7.2「色 ＋ もう 1 つの手がかり」）。色が分からない人にも、色を使えない環境でも分かる。
 */
const HIGHLIGHT_BORDER_COLOR = "#b45309";
const HIGHLIGHT_BACKGROUND_COLOR = "#fef3c7";

/** カード。強調された行は**色と、色以外の印**の両方を持つ（`04` §7.2） */
function cardStyle(marked: boolean): CSSProperties {
  return {
    border: `${marked ? 2 : 1}px solid ${marked ? HIGHLIGHT_BORDER_COLOR : "#c9c9c9"}`,
    borderStyle: marked ? "double" : "solid",
    // 色（背景）。**強調されていないカードには色を付けない**
    ...(marked ? { backgroundColor: HIGHLIGHT_BACKGROUND_COLOR } : {}),
    borderRadius: 4,
    padding: 8,
    marginBottom: 8,
    maxWidth: "100%",
    overflowWrap: "anywhere",
  };
}

/**
 * 列。**`options` に書いた順**である（キーを書いた順が列の順になる。M1.3）。
 * `columns` が選択肢（enum）の項目でなければ空である（静的チェックが断るので、正しい宣言では起きない）。
 */
function boardColumnsOf(entity: Entity | undefined, name: string): readonly BoardColumn[] {
  const declaration = entity?.fields[name];
  if (declaration === undefined || typeof declaration === "string" || declaration.type !== "enum") {
    return [];
  }
  return Object.entries(declaration.options).map(([key, label]) => ({ key, label }));
}

/** その行の、列にする項目の値（キー）。文字列でなければどの列にも入らない */
function columnKeyOf(row: ApiRow, column: string): string | null {
  const value = row.fields[column];
  return typeof value === "string" ? value : null;
}

/** 強調する行か。**Data API が行に載せた真偽の値をそのまま見る**（画面は式を評価しない） */
const isHighlighted = (row: ApiRow, highlight: string | undefined): boolean =>
  highlight !== undefined && row.computed[highlight] === true;

/** その行で、その操作を実行してよいか（M1.3）。`allowedActions` が無ければ「条件が宣言されていない」＝実行できる */
const isAllowed = (row: ApiRow, actionName: string): boolean =>
  row.allowedActions === undefined || row.allowedActions.includes(actionName);

export function Board({
  view,
  entity,
  columns,
  highlight,
  displayName,
  labelOf,
  setActions,
  renderDelete,
  onRunAction,
}: BoardProps) {
  /** 強調の印の文字。`highlight` が指す計算の表示名（無ければ識別子）である（M1.3。Issue #176） */
  const highlightLabel = displayName(highlight ?? "");
  const boardColumns = boardColumnsOf(entity, columns);
  const fields = entity === undefined ? [] : Object.keys(entity.fields);
  const empty = view.rows.length === 0;

  return (
    <div className="board-scroll" data-state={empty ? "empty" : "ready"} style={SCROLL_STYLE}>
      <div className="board" style={BOARD_STYLE}>
        {boardColumns.map((column) => {
          const cards = view.rows.filter((row) => columnKeyOf(row, columns) === column.key);
          return (
            <section className="board-column" data-column={column.key} key={column.key} style={COLUMN_STYLE}>
              <h2 className="board-column-title" style={TITLE_STYLE}>
                {column.label}
              </h2>
              {cards.map((row) => (
                <article
                  className="board-card"
                  data-card={row.id}
                  data-highlighted={isHighlighted(row, highlight) ? "true" : "false"}
                  key={row.id}
                  style={cardStyle(isHighlighted(row, highlight))}
                >
                  {isHighlighted(row, highlight) && (
                    // **色だけに頼らない印**（記号と、強調の計算の表示名。M1.3。Issue #176）。
                    // 色（`cardStyle`）と、この印の**両方**が付く（`04` §7.2）
                    <p
                      className="highlight-mark"
                      role="img"
                      aria-label={`強調: ${highlightLabel}`}
                      style={MARK_STYLE}
                    >
                      <span aria-hidden="true">▲</span> {highlightLabel}
                    </p>
                  )}
                  <dl className="board-fields" style={FIELDS_STYLE}>
                    {fields.map((name) => (
                      <div className="board-field" data-field={name} key={name} style={FIELD_STYLE}>
                        <dt style={TERM_STYLE}>{displayName(name)}</dt>
                        <dd style={VALUE_STYLE}>{labelOf(name, row.fields[name])}</dd>
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
                  {/* カードごとの消すボタン（参照されている行には理由）。**table・一覧と同じ処理**を呼ぶ（Issue #214） */}
                  {renderDelete?.(row)}
                </article>
              ))}
            </section>
          );
        })}
      </div>
      {empty && (
        // 空でも**列は描く**（空の列も出すためである）。ここはその補足の文である
        <p className="state empty" data-state="empty">
          まだ記録がありません
        </p>
      )}
    </div>
  );
}
