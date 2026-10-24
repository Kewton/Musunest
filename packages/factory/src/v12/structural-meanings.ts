// 構造の検査の種類の意味（旗 `v12.ids`。Issue #732）。
//
// 6 つの種類（`STRUCTURAL_ASSERTIONS`）それぞれが**何を確かめるか**と対象の行の種類（`STRUCTURAL_TARGET_KINDS`）を、この 1 か所の表に
// 置く。C3（T1''）の R-sc-02 は、旗 ids on の走りだけ、この表から「構造の検査の読み方」の文を組む（`structuralReadingText`）。
// 文は要件の文を読まずに書ける一般の意味だけにする（題材の言葉・P の名前・値を入れない）。
// C2 の R-map-03 をこの表から組み直すことは範囲の外（別の Issue）。
import type { StructuralAssertionKind, TestTargetKind } from "../fixed-test.js";

/** 構造の検査の種類 1 つの意味（対象の行の種類と、何を確かめるか） */
export interface StructuralMeaning {
  readonly targetKind: TestTargetKind;
  /** 何を確かめるか（「〜こと」で終わる 1 文の述部。句点を含まない） */
  readonly meaning: string;
}

/** 構造の検査の種類 → 意味（鍵の集合は `STRUCTURAL_ASSERTIONS`、対象の行の種類は `STRUCTURAL_TARGET_KINDS` と一致する） */
export type StructuralMeaningTable = Readonly<Record<StructuralAssertionKind, StructuralMeaning>>;

/** 構造の検査の種類の意味の表（正本。並びは `STRUCTURAL_ASSERTIONS` の順） */
export const STRUCTURAL_MEANINGS: StructuralMeaningTable = {
  "field-type": { targetKind: "field", meaning: "項目の種類（参照なら参照先の entity も）が期待のとおりであること" },
  "action-kind": { targetKind: "operation", meaning: "操作の種類が期待のとおりであること" },
  "action-unconditioned": { targetKind: "operation", meaning: "操作が条件（when）を持たないこと" },
  "view-shows": { targetKind: "screen", meaning: "画面の部品が sourceId の項目か計算を表示すること" },
  "aggregate-no-period": { targetKind: "computation", meaning: "集計の絞り込みに期間の条件が無いこと" },
  "write-anonymous": { targetKind: "operation", meaning: "操作が本人確認と書き込みの権限で制限されず、誰でも書き込めること" },
};

/** 対象の行の種類の呼び名（規則の文に使う） */
const TARGET_KIND_WORDS: Readonly<Record<TestTargetKind, string>> = {
  entity: "entity",
  field: "項目",
  computation: "計算",
  operation: "操作",
  screen: "画面",
};

/**
 * 構造の検査の読み方の文（C3 の R-sc-02 の (3) のあとに置く。旗 ids on の走りだけ）を表から組む。種類の並びは表の鍵の順。
 */
export function structuralReadingText(meanings: StructuralMeaningTable = STRUCTURAL_MEANINGS): string {
  const kinds = (Object.keys(meanings) as StructuralAssertionKind[])
    .map((check) => `${check}（対象は${TARGET_KIND_WORDS[meanings[check].targetKind]}の行）は${meanings[check].meaning}`)
    .join("、");
  return (
    `構造の検査の読み方：確かめ方の targets は種類ごとの対象の行の並びで、同じ種類を複数の行に掛けた確かめ方は行ごとに 1 件の検査である。` +
    `各種類が確かめるのは次のことだけである：${kinds}。` +
    `(2) と (3) は targets の行の集合に対して見る。要件の決まりが及ぶ行が targets に欠けていれば missing-target、種類の意味が要件の決まりと合わなければ weak-verification で拒否する。`
  );
}
