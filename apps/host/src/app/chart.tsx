// 棒（`bar`）と円（`pie`）のグラフの部品（M1.4。Issue #181）——`type: dashboard` の中に並べる。
//
// この部品が決めるのは次の 4 つだけである。
//   1. どの値を出すか — 部品が指す計算の「見出しと値の組の並び」（応答の `groups`。M1.4。Issue #179）を
//      そのまま見せる。**画面は式も集計も評価しない**（`CLAUDE.md` の不変条件。集計は Data API が行う）。
//      見出しは**保存される値のほう**（`enum` は `options` のキー、月は `YYYY-MM`）なので、
//      呼ぶ側が `headingOf` で表示名に写す
//   2. 見せ方 — **色だけに頼らない**（`04` §7.2）。見出しと値は**文字でも読める**ようにし、円は
//      **割合（%）も数字で出す**。**外の部品（グラフの library）を足さない**——SVG を自分で組む。
//      SVG は `aria-hidden="true"` にして、**読み上げは表（`<table>`）が受け持つ**（窓口の決定 2026-09-19）
//   3. 4 つの状態（`04` §7.3）——空・多い・エラー・権限なし。**「多い」は見出しが 12 個以上**である
//   4. 幅 — **横幅 360 CSS px で崩れない**（`04` §7.2）。棒は**縦に積み**（横に流さない）、
//      円は決まった大きさ（`max-width: 100%`）にする
//
// **操作の要素を作らない**（見るだけの部品である。キーボードで到達する必要も無い。`04` §7.3）。
// 見た目はこの file の中に置く（`renderer.css` はこの Issue の変更してよい範囲に入っていない）。

import type { CSSProperties } from "react";

/** 見出しごとの集計（`type: groups`。M1.4。Issue #179）の 1 組。API が返す `groups` の 1 つと同じ形である */
export interface ChartEntry {
  readonly heading: string;
  readonly value: number | null;
}

/**
 * 棒（`bar`）と円（`pie`）の部品（宣言の `widgets` のうち、`type` が `bar`・`pie` のもの）。
 * **宣言の型と構造的に同じ**である（画面が持てる依存は sdk だけなので、型はここで写す）。
 */
export interface ChartPart {
  readonly type: "bar" | "pie";
  /** 指す見出しごとの集計の名前。`view.groups` をこの名前で引く */
  readonly value: string;
  /** 表示名（`label`）。無ければ `value` の識別子をそのまま見せる */
  readonly label?: string;
  /** 値の単位（「回」「人」など）。無ければ数をそのまま見せる */
  readonly unit?: string;
}

export interface ChartProps {
  readonly part: ChartPart;
  /** 部品が指す計算の値（`groups[value]`）。`null` は求められなかった（エラー。「—」で見せる） */
  readonly entries: readonly ChartEntry[] | null;
  /** 見出しを画面に出す文字列へ写す（`enum` は宣言の `options`。無ければそのまま） */
  readonly headingOf: (heading: string) => string;
}

/**
 * 「多い」と見なす見出しの数（`04` §7.3「見出しが 12 個以上」）。棒は縦に積んで全部を出し、
 * 円は上位 `PIE_TOP` 件と「その他」にまとめる。
 */
export const MANY_HEADINGS = 12;
/** 円が「多い」ときに残す見出しの数（上位いくつを円に描くか） */
export const PIE_TOP = 8;
/** 円がまとめた見出しの名前（**捨てたのではなく、1 つにまとめた**ことが分かる文字にする） */
export const OTHER_HEADING = "その他";

// ── 見た目（横幅 360 CSS px で横に流さない。04 §7.2） ────────────────────

const CHART_STYLE: CSSProperties = {
  maxWidth: "100%",
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
  marginTop: 12,
};
const TITLE_STYLE: CSSProperties = { margin: "0 0 8px", fontSize: "1rem" };
const SVG_STYLE: CSSProperties = { display: "block", maxWidth: "100%" };
const PIE_SVG_STYLE: CSSProperties = {
  display: "block",
  width: 160,
  height: 160,
  maxWidth: "100%",
};
const TABLE_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: "100%",
  borderCollapse: "collapse",
  marginTop: 8,
  tableLayout: "fixed",
};
const CAPTION_STYLE: CSSProperties = { textAlign: "left", fontWeight: "bold", paddingBottom: 4 };
const CELL_STYLE: CSSProperties = {
  borderTop: "1px solid #e0e0e0",
  padding: "2px 4px",
  textAlign: "left",
  overflowWrap: "anywhere",
};

/** 棒の 1 行の高さと、棒そのものの高さ（SVG の座標。`viewBox` の中で使う） */
const BAR_ROW = 18;
const BAR_HEIGHT = 12;
/** 棒の色。**色だけに頼らない**ので、これは飾りである（見出しと値は文字でも読める） */
const BAR_FILL = "#4a6fa5";
/** 円の扇形の色（`PIE_TOP` 件ぶん。あふれたら繰り返す）と、「その他」の色 */
const PIE_COLORS = ["#4a6fa5", "#7a9e7e", "#c9a227", "#b05a5a", "#7b6ca8", "#4f9aa8", "#a87b4a"];
const PIE_OTHER_COLOR = "#8a8a8a";

/** 数を、小数第 1 位まで（四捨五入）で見せる。整数はそのままである（「avg」の節と同じ決めごと） */
function numberText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 値の表示。**単位を添え**、求められなかった値（`null`）は「—」で見せて **0 と区別する** */
function valueText(value: number | null, unit: string | undefined): string {
  const text = value === null ? "—" : numberText(value);
  return unit === undefined ? text : `${text} ${unit}`;
}

/**
 * 割合（%）。**全体が 0 のときは求められない**ので「—」で見せ、0% と区別する
 * （0 件の平均を `null` にするのと同じ考え方である。窓口の決定 2026-09-19）。
 */
function percentText(value: number | null, total: number): string {
  if (value === null || total <= 0) return "—";
  return `${numberText((value / total) * 100)}%`;
}

/** 円の凡例と扇形の 1 つ。`raw` は表示する値（「その他」は合計である） */
interface PieSlice {
  readonly key: string;
  readonly heading: string;
  readonly raw: number | null;
  readonly color: string;
}

/**
 * 円の扇形と凡例を組む（**円だけの決めごと**である）。**見出しが「多い」ときは上位 `PIE_TOP` 件と
 * 「その他」にまとめる**（`04` §7.3）——全部を 1 つの円に描くと、細い扇形が読めなくなるためである。
 * 「多い」でなければ、**宣言の順のまま全部**を描く（月は古い順、`enum` は `options` の順）。
 */
function pieSlicesOf(
  entries: readonly ChartEntry[],
  headingOf: (heading: string) => string,
): readonly PieSlice[] {
  if (entries.length < MANY_HEADINGS) {
    return entries.map((entry, index) => ({
      key: entry.heading,
      heading: headingOf(entry.heading),
      raw: entry.value,
      color: PIE_COLORS[index % PIE_COLORS.length] ?? PIE_OTHER_COLOR,
    }));
  }
  // 上位は**値の大きい順**である（同じ値は宣言の順のまま。並べ替えは安定である）
  const ranked = [...entries].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const shown = ranked.slice(0, PIE_TOP);
  const rest = ranked.slice(PIE_TOP);
  const slices: PieSlice[] = shown.map((entry, index) => ({
    key: entry.heading,
    heading: headingOf(entry.heading),
    raw: entry.value,
    color: PIE_COLORS[index % PIE_COLORS.length] ?? PIE_OTHER_COLOR,
  }));
  if (rest.length > 0) {
    slices.push({
      key: "__other__",
      heading: OTHER_HEADING,
      raw: rest.reduce((sum, entry) => sum + (entry.value ?? 0), 0),
      color: PIE_OTHER_COLOR,
    });
  }
  return slices;
}

/** 全体（割合の分母）。求められなかった値（`null`）は数えない */
const totalOf = (entries: readonly ChartEntry[]): number =>
  entries.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

/**
 * 棒の見た目。**SVG を自分で組む**（外の部品を足さない）。**0 の棒は描かない**（`04` §7.3「空」）。
 * 高さだけを見せるので、**文字（見出しと値）は表が受け持つ**——`aria-hidden="true"` である。
 */
function BarVisual({ entries }: { readonly entries: readonly ChartEntry[] }) {
  const max = Math.max(0, ...entries.map((entry) => entry.value ?? 0));
  const height = entries.length * BAR_ROW;
  return (
    <svg
      className="chart-svg chart-bars"
      aria-hidden="true"
      role="presentation"
      data-chart-bars={entries.length}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      style={SVG_STYLE}
    >
      {entries.map((entry, index) => {
        const value = entry.value ?? 0;
        // **0 の棒を描かない**（値の無い月を棒として見せない）
        if (value <= 0 || max <= 0) return null;
        return (
          <rect
            key={entry.heading}
            data-bar={entry.heading}
            x={0}
            y={index * BAR_ROW + (BAR_ROW - BAR_HEIGHT) / 2}
            width={(value / max) * 100}
            height={BAR_HEIGHT}
            fill={BAR_FILL}
          />
        );
      })}
    </svg>
  );
}

/**
 * 円の見た目。**SVG を自分で組む**。扇形は円の弧ではなく、**円周を `pathLength` で 100 に正規化した
 * `stroke-dasharray`** で描く（依存を足さず、arc の計算も要らない）。`aria-hidden="true"` である。
 */
function PieVisual({ slices }: { readonly slices: readonly PieSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + (slice.raw ?? 0), 0);
  let consumed = 0;
  return (
    <svg
      className="chart-svg chart-pie"
      aria-hidden="true"
      role="presentation"
      viewBox="0 0 100 100"
      style={PIE_SVG_STYLE}
    >
      <g transform="rotate(-90 50 50)">
        {total <= 0
          ? // 値が全部 0 のときは扇形を作らない（**0 の扇形を描かない**）。円の枠だけを見せる
            <circle cx={50} cy={50} r={40} fill="none" stroke="#e0e0e0" strokeWidth={18} />
          : slices.map((slice) => {
              const share = ((slice.raw ?? 0) / total) * 100;
              const offset = consumed;
              consumed += share;
              if (share <= 0) return null;
              return (
                <circle
                  key={slice.key}
                  data-slice={slice.key}
                  cx={50}
                  cy={50}
                  r={40}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={18}
                  pathLength={100}
                  strokeDasharray={`${share} ${100 - share}`}
                  strokeDashoffset={-offset}
                />
              );
            })}
      </g>
    </svg>
  );
}

/**
 * グラフの表（**読み上げが受け持つ**形である。窓口の決定 2026-09-19）。見出しの列と値の列を持ち、
 * `<caption>` に部品の名前を入れる。円は**割合（%）の列**も持つ。**色を見なくても読める。**
 */
function ChartTable({
  title,
  type,
  rows,
  unit,
  total,
}: {
  readonly title: string;
  readonly type: "bar" | "pie";
  readonly rows: readonly PieSlice[];
  readonly unit: string | undefined;
  readonly total: number;
}) {
  return (
    <table className="chart-table" style={TABLE_STYLE}>
      <caption style={CAPTION_STYLE}>{title}</caption>
      <thead>
        <tr>
          <th scope="col" style={CELL_STYLE}>
            見出し
          </th>
          <th scope="col" style={CELL_STYLE}>
            値
          </th>
          {type === "pie" && (
            <th scope="col" style={CELL_STYLE}>
              割合
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="chart-entry" key={row.key} data-heading={row.key}>
            <th scope="row" style={CELL_STYLE}>
              {row.heading}
            </th>
            <td style={CELL_STYLE}>{valueText(row.raw, unit)}</td>
            {type === "pie" && <td style={CELL_STYLE}>{percentText(row.raw, total)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 棒（`bar`）・円（`pie`）の部品。**部品の名前**（表示名）と、`entries` の状態で決まる 4 つの状態を出す。
 *   - `entries` が `null` … **エラー**。値を求められなかった（「—」。0 と区別する）
 *   - `entries` が空 … **空**。「データがありません」
 *   - 見出しが `MANY_HEADINGS` 個以上 … **多い**（棒は全部を縦に積み、円はまとめる）
 *   - それ以外 … そのまま描く
 * **権限なし**は API が 403 を返し、画面（renderer）がその理由を出す。この部品は描かれない。
 */
export function Chart({ part, entries, headingOf }: ChartProps) {
  const title = part.label ?? part.value;
  const attributes = {
    className: "chart",
    "data-chart": part.value,
    "data-chart-type": part.type,
    style: CHART_STYLE,
  } as const;

  if (entries === null) {
    return (
      <section {...attributes} data-state="error">
        <h3 className="chart-title" style={TITLE_STYLE}>
          {title}
        </h3>
        <p className="state chart-unavailable" data-state="chartUnavailable">
          —
        </p>
      </section>
    );
  }

  if (entries.length === 0) {
    return (
      <section {...attributes} data-state="empty">
        <h3 className="chart-title" style={TITLE_STYLE}>
          {title}
        </h3>
        <p className="state empty" data-state="empty">
          データがありません
        </p>
      </section>
    );
  }

  const state = entries.length >= MANY_HEADINGS ? "many" : "ready";
  // 棒は宣言の順のまま全部を縦に積む。円は「多い」ときだけ上位と「その他」にまとめる（`pieSlicesOf`）
  const slices =
    part.type === "pie"
      ? pieSlicesOf(entries, headingOf)
      : entries.map((entry, index) => ({
          key: entry.heading,
          heading: headingOf(entry.heading),
          raw: entry.value,
          color: PIE_COLORS[index % PIE_COLORS.length] ?? BAR_FILL,
        }));
  return (
    <section {...attributes} data-state={state}>
      {part.type === "bar" ? <BarVisual entries={entries} /> : <PieVisual slices={slices} />}
      <ChartTable title={title} type={part.type} rows={slices} unit={part.unit} total={totalOf(entries)} />
    </section>
  );
}
