// 性質の台帳の試験の補助（Issue #875）。検査の式（validation-expression）の行の、文書の式の文法に委ねる前の文（旧の文）と、
// その文に戻した台帳を組む関数を置く。旧の文は消さずに試験の定数に残す（#816・#832 と同じ作法）。製品のコードはこの値を読まない。
//
// 旧の文は、文書の旧い文法（式＝比較 1 つ）を「入力の値を 1 つの比較で縛る」と言い換えて写していた。文書が式の結合
// （and・or・not）を許したあと追従せず、範囲や「どちらか」の決まりを検査の式に選ぶことを妨げていた。

import { PROPERTY_LEDGER, type PropertyRow } from "../ledger.js";

/** Issue #875 の前の検査の式の行の欄（`since`・`why`・`requirementRule`・`t1Acceptance`・`rules.t1`・`rules.t1Acceptance`） */
export const OLD_VALIDATION_EXPRESSION_TEXTS = {
  since: "Issue #800",
  why: "入力の値を 1 つの比較で縛る決まりを、対象の項目ごとの検査（validate）の試験で確かめる。決まりの無い要件に検査の試験を作らせないため、式で書ける決まりだけを受理し、対象を targets の項目に限る（方法論 03 の H2・H1。08 §5・§8.2）",
  requirementRule: "入力の値を 1 つの比較で縛る決まりだけを決める要件",
  t1Acceptance:
    "確かめ方が検査の式（validation-expression）の要件は、要件の決まりが入力の値を 1 つの比較で縛る決まりだけで、targets がその決まりが縛る項目と過不足なく合うときだけ受理する。式で書けない決まりを含む要件や targets の合わない要件は受理せず、weak-verification で拒否する",
  rulesT1:
    "要件の決まりが「入力の値を 1 つの比較で縛る」だけなら kind を validation-expression にし、targets にその決まりが縛る項目（同じ entity の項目の行の ID）を 1 つ以上書く。entity と対象の項目はコードが所属に足す。value は null にする。式で書けない決まり・項目を縛らない決まり・複数の entity にまたがる項目を含む要件には validation-expression を使わない。",
  rulesT1Acceptance:
    "確かめ方が validation-expression の要件は、要件の決まりが入力の値を 1 つの比較で縛る決まりだけで、targets がその決まりが縛る項目と過不足なく合うときだけ受理する。式で書けない決まりを含む要件や targets の合わない要件は受理せず、weak-verification で拒否する。",
} as const;

/**
 * Issue #875 の前（417e14f だけの base）の旗 ids の全体・上流の指紋。検査の式の行の文を旧の文に戻すと、この値に戻る
 */
export const BASE_IDS_LEDGER_BEFORE_875 = {
  ledger: "65c1f276c2f72cc7fbe947397ee214da740dcdbd1680bdd001f61f889d141487",
  upstream: "dc21dd0177557eec5af22eafe2355a41f99884ab4e063d6745e30ae9c554c110",
} as const;

/** 検査の式の行の文を Issue #875 の前の文に戻した台帳（ほかの行・欄は変えない） */
export function withOldValidationExpressionTexts(rows: readonly PropertyRow[] = PROPERTY_LEDGER): readonly PropertyRow[] {
  const old = OLD_VALIDATION_EXPRESSION_TEXTS;
  return rows.map((row) =>
    row.id !== "validation-expression"
      ? row
      : {
          ...row,
          since: old.since,
          why: old.why,
          requirementRule: old.requirementRule,
          t1Acceptance: old.t1Acceptance,
          rules: { ...row.rules, t1: old.rulesT1, t1Acceptance: old.rulesT1Acceptance },
        },
  );
}

/**
 * Issue #875 の検査の式の行の文（この Issue #902 で `rules.t1`・`rules.t1Acceptance` だけを #875 の前の文に戻した。
 * 戻す前の文は消さずに試験の定数に残す（#816・#832 と同じ作法）。製品のコードはこの値を読まない
 */
export const NEW_875_VALIDATION_EXPRESSION_TEXTS = {
  since:
    "Issue #800（受理の条件を文書の式の文法に委ねたのは 2026-11-11 の #875。台帳の文が文書の旧い文法〔式＝比較 1 つ〕を言い換えて写し、文書が式の結合を許したあと追従しなかったため）",
  rulesT1:
    "要件の決まりが同じ entity の項目だけを参照する 1 つの検査の式で書ける決まり（書き方は文書の式の文法のとおり）だけなら kind を validation-expression にし、targets にその決まりが縛る項目（同じ entity の項目の行の ID）を 1 つ以上書く。entity と対象の項目はコードが所属に足す。value は null にする。式で書けない決まり・項目を縛らない決まり・複数の entity にまたがる項目を含む要件には validation-expression を使わない。",
  rulesT1Acceptance:
    "確かめ方が validation-expression の要件は、要件の決まりが同じ entity の項目だけを参照する 1 つの検査の式で書ける決まり（書き方は文書の式の文法のとおり）だけで、targets がその決まりが縛る項目と過不足なく合うときだけ受理する。式で書けない決まりを含む要件や targets の合わない要件は受理せず、weak-verification で拒否する。",
} as const;

/** 検査の式の行の `since` だけを Issue #875 の文に戻した台帳（ほかの欄は今のまま） */
export function withSinceOnly875(rows: readonly PropertyRow[] = PROPERTY_LEDGER): readonly PropertyRow[] {
  const since = NEW_875_VALIDATION_EXPRESSION_TEXTS.since;
  return rows.map((row) => (row.id === "validation-expression" ? { ...row, since } : row));
}

/** 検査の式の行を Issue #875 の文に戻した台帳（`since` と規則の 2 セル。`why`・`requirementRule`・上位の受理条件は今のまま） */
export function withNew875ValidationExpressionTexts(rows: readonly PropertyRow[] = PROPERTY_LEDGER): readonly PropertyRow[] {
  const new875 = NEW_875_VALIDATION_EXPRESSION_TEXTS;
  return rows.map((row) =>
    row.id !== "validation-expression"
      ? row
      : {
          ...row,
          since: new875.since,
          rules: { ...row.rules, t1: new875.rulesT1, t1Acceptance: new875.rulesT1Acceptance },
        },
  );
}
