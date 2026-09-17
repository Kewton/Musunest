// 精算の表示（M1.2。Issue #142）。**計算はしない**——API が返した送金の並びをそのまま見せる
// （workspace/mvp/m1/03-spec-layers-and-checker.md §2.3「計算はロジック層、見せ方は UI 層」）。
//
// 送金元・送金先は、精算に現れる人の**レコードの ID** である（packages/appspec-schema/src/api.ts の
// ApiTransfer）。この部品が決めるのは次の 3 つだけである。
//   1. ID を名前へ写す（引けなければ ID のまま出す。**分からないものを消さない**）
//   2. 額を整数円で、3 桁の区切りを入れて見せる（`C さん → A さん 3,000 円`。Q18-6）
//   3. 空の状態を出す（「送金は要りません」）
//
// **エラー（`null`。読めなかった）と権限なしは、この部品ではなく画面が受け取る。**
// 読めなかった精算を空の並びに読み替えると、「送金が要らない」と混ざる（docs/semantics.md「settlement」）。

import type { ApiRow, ApiTransfer } from "@musunest/sdk";

export interface SettlementListProps {
  /** 送金の並び。`null` は読めなかった（**空の並びに読み替えない**） */
  readonly transfers: readonly ApiTransfer[] | null;
  /** 精算に現れる人のレコード（ID から名前を引くのに使う） */
  readonly rows: readonly ApiRow[];
  /** 名前として見せる項目。引けなければ `null`（そのときは ID を出す） */
  readonly labelField: string | null;
}

export function SettlementList({ transfers, rows, labelField }: SettlementListProps) {
  if (transfers === null) {
    return (
      <p className="state failure" data-state="settlementUnavailable">
        精算の結果を表示できません
      </p>
    );
  }

  if (transfers.length === 0) {
    return (
      <p className="state empty" data-state="settlementEmpty">
        送金は要りません
      </p>
    );
  }

  return (
    <ul className="settlement" aria-label="精算">
      {transfers.map((transfer) => (
        <li className="settlement-transfer" key={`${transfer.from}\u0000${transfer.to}`}>
          {transferText(transfer, rows, labelField)}
        </li>
      ))}
    </ul>
  );
}

/** 1 件の文（`C さん → A さん 3,000 円`）。**並べ替えと区切りのみ**で、計算はしない */
function transferText(
  transfer: ApiTransfer,
  rows: readonly ApiRow[],
  labelField: string | null,
): string {
  const from = labelOf(rows, labelField, transfer.from);
  const to = labelOf(rows, labelField, transfer.to);
  return `${from} さん → ${to} さん ${formatYen(transfer.amount)} 円`;
}

/** 名前。引けなければ ID をそのまま返す（renderer の参照の表示と同じ扱いである） */
function labelOf(rows: readonly ApiRow[], labelField: string | null, id: string): string {
  if (labelField === null) return id;
  const value = rows.find((row) => row.id === id)?.fields[labelField];
  return typeof value === "string" && value !== "" ? value : id;
}

/**
 * 額を 3 桁の区切りで見せる（整数円。Q18-6）。**丸めない**——宣言が整数円だけを受け取るので、
 * ここで値を変えると「API が返した値をそのまま見せる」という約束を破ることになる。
 */
function formatYen(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
