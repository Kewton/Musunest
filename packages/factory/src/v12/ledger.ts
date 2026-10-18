// 性質の台帳と v1.2 の旗（08-architecture-v1.2.md §5・§9 手 2。Issue #547）。
//
// **性質 1 つに 1 行。** T1 の確かめ方・T1' の所属の形・T1'' の受理条件・T2 の試験の型・網羅の鍵・B4 の照合・外の採点
// との対応・規則の文を、この 1 行から導く。台帳に無い性質は T1' の確かめ方・T2' の観測する性質・B4 の照合で拒否する。
// **正本はこのコード**で、人が読む写しは `methodology/ledger/properties.md`（試験が 1 要素 1 行で照らす。D2）。
//
// 旗 `v12.ledger`（`V12Flags.ledger`。既定 off）が on の走りでだけ、走らせる部分が `ledgerViewOf` の導出を T1・T1'・T2・
// T2'・評価口（B4・B5 の道具・版の再検査）へ渡す。off の走りは今の定数と関数をそのまま使い、ここを通らない。
// 手 2a（#547）は**載せ替えだけ**で、on で組んだ規則の文・schema・データの並びは off とバイト列で同じだった。
// 手 2b（#548）で 2 行目の `enum-membership`（選択肢の集合）を足し、T1''（R-sc-02 の受理条件）・B1（R-w11 の末尾）へも
// 台帳の文を差し込む。台帳から `enum-membership` の行を除いた導出は、今も off の定数とバイト列で同じである。
// 手 2c（#549）で 3 行目の `empty-aggregate`（集計の種類 × データ状態の空の値）を足す。確かめ方の種類は増やさず
// （fixed-test のまま）、T1 の計算の行の型に `aggregate`（集計の種類と集計元）を足し（種類の enum は台帳の表の順）、
// T2' が集計の試験の期待をこの行の表から導いた値と照らす。台帳からこの行を除いた導出は #548 の導出と同じである。
// 手 2d（#550）で、引き継いだ `when` の行の未定義の列（要件の決まりの型・T2 の試験の型・外の対応・T2 の規則の文）を埋め、
// T2' が操作の条件の試験の期待の型（ok なら真偽）と対象（条件を持つ操作の行）を照らす。あわせて 4 行目の
// `non-requirement`（決まりも対象の項目も無い説明文）を足す。確かめ方の種類は増えるが試験は作らず（観測する性質の一覧に
// 入れない）、T1''（独立の点検）が受理した要件だけを、持ち越しの導出が要件でない文として残る一覧から除く。
//
// 旗の正本もここに置く。手 4a（#551）で旗 `v12.search-repair`（内部の鍵 `searchRepair`。B5 のループの旗で、部品は
// `v12/search-repair.ts`）を足した。内部の鍵と公開の鍵の対応は `V12_FLAG_PUBLIC_NAMES` の 1 か所である。
// 手 3p（#592）で旗 `v12.ids`（内部の鍵・公開の鍵とも `ids`）を足した。手 3 の仕組み（C1・C2 の束・導ける欄）と呼び出しの
// 枠（`v12/limits.ts`）の旗で、手 3a〜3c は同じ旗の下で足す。
//
// 台帳は LLM を呼ばず、評価口を import しない（B4 の照合は名前で持ち、評価口が名前 → 関数の表を持つ）。
import type { AggregateKind } from "@musunest/appspec-schema";
import { TEST_KINDS, type TestKind, type TestOperation, type TestTargetKind } from "../fixed-test.js";

// ── 旗（v1.2 の旗の正本）──────────────────────────────────────────

/** v1.2 の旗（旗の名前 → 真偽）。後の手の旗はここに足す（鍵はコードの内部の名前。公開の名前は `V12_FLAG_PUBLIC_NAMES`） */
export interface V12Flags {
  /** 性質の台帳から確かめ方・観測する性質・評価の方法を導く（手 2。既定 off） */
  readonly ledger: boolean;
  /** B5 のループを探索型（一番良い版・厳密な減少・停滞での作り直し・候補の状態）にする（手 4a。既定 off。Issue #551） */
  readonly searchRepair: boolean;
  /**
   * 手 3 の仕組み（C1・C2 の束・導ける欄）と呼び出しの枠（段ごとの論理の枠・生成と判定で共有する実試行の門・判定の枝。
   * `v12/limits.ts`）を使う（手 3p。既定 off。Issue #592）
   */
  readonly ids: boolean;
}

/** 旗の名前の並び（`V12Flags` の鍵と同じ順） */
export const V12_FLAG_NAMES = ["ledger", "searchRepair", "ids"] as const satisfies readonly (keyof V12Flags)[];

/**
 * 内部の鍵 → 公開の鍵（**この 1 か所の対応**。Issue #551）。公開の鍵は `V12_PIPELINE_FLAGS`・要約と条件の記録の `v12_flags`
 * に出す名前で、小文字・数字・ハイフン・点の形（計測の道具の照合の形）。内部の鍵はコードの中の名前（`flags.searchRepair`）。
 */
export const V12_FLAG_PUBLIC_NAMES = {
  ledger: "ledger",
  searchRepair: "search-repair",
  ids: "ids",
} as const satisfies Readonly<Record<keyof V12Flags, string>>;

/** 旗の公開の名前 */
export type V12PublicFlagName = (typeof V12_FLAG_PUBLIC_NAMES)[keyof V12Flags];

/** 公開の鍵の旗の組（`V12_PIPELINE_FLAGS`・`v12_flags` の形） */
export type V12PublicFlags = { readonly [K in V12PublicFlagName]: boolean };

/** 公開の名前の並び（`V12_FLAG_NAMES` と同じ順） */
export const V12_PUBLIC_FLAG_NAMES: readonly V12PublicFlagName[] = V12_FLAG_NAMES.map((name) => V12_FLAG_PUBLIC_NAMES[name]);

/** 全部 off の旗（`flags` を省いた走り＝今の v1.1α） */
export const V12_FLAGS_OFF: Readonly<V12Flags> = { ledger: false, searchRepair: false, ids: false };

/**
 * `--pipeline v1.2` が流す旗の組（**merge 済みの手の旗を全部 on**。今は ledger・search-repair・ids）。**公開の鍵**で書く。計測の
 * 道具が読む契約の正本で、手元の入口はこの値から旗を組む（`fromPublicV12Flags`。写しを別に作らない）。v1.2 の走りの要約と
 * 条件の記録の `v12_flags` は、実際に使ったこの組を写す。
 */
export const V12_PIPELINE_FLAGS: Readonly<V12PublicFlags> = { ledger: true, "search-repair": true, ids: true };

/** 渡された旗（省いた名前は off）から、全部の名前を持つ実効の旗を組む */
export function resolveV12Flags(flags?: Partial<V12Flags>): V12Flags {
  return { ledger: flags?.ledger === true, searchRepair: flags?.searchRepair === true, ids: flags?.ids === true };
}

/** 実効の旗を公開の鍵の組にする（`V12_FLAG_NAMES` の順） */
export function toPublicV12Flags(flags: V12Flags): V12PublicFlags {
  return Object.fromEntries(V12_FLAG_NAMES.map((name) => [V12_FLAG_PUBLIC_NAMES[name], flags[name]])) as V12PublicFlags;
}

/** 公開の鍵の組（省いた名前は off）から、実効の旗を組む */
export function fromPublicV12Flags(flags: Partial<V12PublicFlags>): V12Flags {
  return resolveV12Flags(Object.fromEntries(V12_FLAG_NAMES.map((name) => [name, flags[V12_FLAG_PUBLIC_NAMES[name]] === true])));
}

// ── 台帳の行 ─────────────────────────────────────────────────────

/** 行の状態（有効／登録済み・未対応／削る候補） */
export const PROPERTY_STATES = ["active", "registered-unsupported", "removal-candidate"] as const;
export type PropertyState = (typeof PROPERTY_STATES)[number];

/** 状態の人が読む名前（写しの表の欄） */
export const PROPERTY_STATE_LABELS: Readonly<Record<PropertyState, string>> = {
  active: "有効",
  "registered-unsupported": "登録済み・未対応",
  "removal-candidate": "削る候補",
};

/**
 * 期待の値の書き手（§5 との段階の差）。手 2 は T2 の LLM が期待の値を書き、コードが台帳の行から導いた値と T2' で厳密に
 * 照らす（違えば拒否）。§5 の「値はコードだけで埋まる」（`code`）は手 3c（#595）で入れた：旗 `v12.ids` の走りだけ、
 * `code` の試験の型の試験は `v12/generated-tests.ts` が作り、T2 の LLM には書かせない（旗 off の走りは今までどおり LLM が書く）
 */
export const EXPECTED_VALUE_WRITERS = ["llm-written-code-checked", "code"] as const;
export type ExpectedValueWriter = (typeof EXPECTED_VALUE_WRITERS)[number];

/** 評価の方法の表の 1 組（対象の種類・操作。観測する性質は行の `id`） */
export interface PropertyCombination {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
}

/**
 * T1 の確かめ方と T1' の所属の形（確かめ方の種類に結び付いた性質だけが持つ）。所属は「`row` の種類・型の行を
 * `count` 行ちょうど＋その行の所属 entity（`entityAddedByCode`：コードが足すので書かなくてよい）」だけを許す。
 * `valueField` は確かめ方の欄（その行の options のキー）で、欄を持たない確かめ方は null（`value` は null で書く。
 * #548）。`optionsNonEmpty` は所属の行の options が空でないことを求める。`nature` は表の分類に求める値。
 */
export interface PropertyT1 {
  readonly kind: string;
  readonly valueField: "value" | null;
  readonly ownership: {
    /** 所属させる行の種類・型（所属 0 行の確かめ方は null＝どの行も所属させない。#550） */
    readonly row: { readonly kind: TestTargetKind; readonly type: string } | null;
    readonly count: number;
    readonly entityAddedByCode: boolean;
    readonly valueInOptions: boolean;
    readonly optionsNonEmpty: boolean;
  };
  /** 表の分類に求める値（null は分類の値を見ない＝欄は完全性の検査のために要るが値は使わない。#550） */
  readonly nature: "ruled" | "existence-only" | null;
  /**
   * 真なら、T1''（独立の点検）が受理した要件を、持ち越しの導出が要件でない文として残る一覧から除く（持ち越しに数えない・
   * 試験を作らない）。拒否されれば今までどおり持ち越し。T1 の分類・出どころ・要件 ID の形では除かない（#550）
   */
  readonly excludeWhenAccepted: boolean;
  /** T1' の固定文（値を埋めない） */
  readonly messages: {
    /** 下書きの形：欄が空でない文字列でない（欄を持たない確かめ方は、`value` が null でない） */
    readonly valueShape: string;
    /** 型付きの表：欄が空（欄を持たない確かめ方は、`value` が null でない） */
    readonly valueEmpty: string;
    /** 分類が記述子の値でない（分類の値を見ない記述子は null） */
    readonly nature: string | null;
    readonly count: string;
    readonly others: string;
    /** 欄の値が所属の行の options に無い（`valueInOptions` の行だけ） */
    readonly valueNotInOptions: string | null;
    /** 所属の行の options が空（`optionsNonEmpty` の行だけ） */
    readonly optionsEmpty: string | null;
  };
}

/**
 * 期待の型（#548 で `options の並び` を足した）。`verification-value` は確かめ方の欄の値を JSON の文字列で書いた
 * もの、`target-options` は対象の行の options のキーを表の順に並べた文字列の並び（decode 済みの値で、長さ・順まで照らす）
 */
export const EXPECTED_VALUE_SOURCES = ["verification-value", "target-options"] as const;
export type ExpectedValueSource = (typeof EXPECTED_VALUE_SOURCES)[number];

/** T2 の試験の型（確かめ方の種類に結び付いた性質だけが持つ。ほかの性質は今の検査のまま＝未定義） */
export interface PropertyT2 {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
  /** 作ってよい（そろえる）kind。ここに無い kind の不足は v1 の網羅の検査から外す */
  readonly requiredKinds: readonly TestKind[];
  /** 期待の型（kind・値の型・何と等しいか） */
  readonly expected: {
    readonly kind: "ok";
    readonly valueType: "json-string" | "json-string-array";
    readonly equals: ExpectedValueSource;
  };
  /** データ状態ごとの値（自然文の状態 → 期待） */
  readonly dataStates: readonly { readonly state: string; readonly value: ExpectedValueSource }[];
  /** 参照データの対象の種類（空なら参照データは空の並び） */
  readonly referenceTargets: readonly TestTargetKind[];
  /** 入力の形 */
  readonly input: "empty-record";
  /** 要件ごとの最小の本数 */
  readonly minTests: number;
  readonly expectedWriter: ExpectedValueWriter;
  /** T2' の固定文（値を埋めない） */
  readonly messages: {
    /** 確かめ方がこの種類でない要件・その項目でない対象に、この性質の試験を作った */
    readonly notAllowed: string;
    readonly kind: string;
    readonly operation: string;
    readonly target: string;
    readonly observes: string;
    readonly expected: string;
    readonly input: string;
    readonly referenceData: string;
  };
}

/** 集計のデータ状態（`empty` … 集計元を空と明示し行も置かない／`unread` … 空と明示せず行も置かない＝未読。#549） */
export const AGGREGATE_DATA_STATES = ["empty", "unread"] as const;
export type AggregateDataState = (typeof AGGREGATE_DATA_STATES)[number];

/**
 * 集計の範囲（#595）。`row` … 行ごと（type の scope が row）、`app` … アプリ全体、`groups-enum` … 見出しごと × 選択肢
 * （groupBy の kind が enum）、`groups-month` … 見出しごと × 月（groupBy の kind が month）
 */
export const AGGREGATE_RANGES = ["row", "app", "groups-enum", "groups-month"] as const;
export type AggregateRange = (typeof AGGREGATE_RANGES)[number];

/** 集計の範囲の人が読む名前（写しの表の欄） */
export const AGGREGATE_RANGE_LABELS: Readonly<Record<AggregateRange, string>> = {
  row: "行ごと",
  app: "アプリ全体",
  "groups-enum": "見出しごと × 選択肢",
  "groups-month": "見出しごと × 月",
};

/** データ状態ごとの値（`zero` … 0。見出しごとは見出しごとに 0／`null` … null。見出しごとは見出しごとに null） */
export const AGGREGATE_STATE_VALUES = ["zero", "null"] as const;
export type AggregateStateValue = (typeof AGGREGATE_STATE_VALUES)[number];

/**
 * 集計の試験の型（集計の種類 × データ状態で期待が決まる性質だけが持つ。#549）。対象は計算の行のうち種別 aggregate で、
 * 集計の種類と集計元（T1 の計算の行の型の `aggregate`）を持つ行。データ状態は入力の契約の `emptyEntities` に集計元が
 * あれば `empty`、無ければ `unread`（参照データに集計元の行があればこの型の試験ではない）。期待は ok で、値は
 * `values` の表から導く。見出しごと（groups）は、`empty` なら見出しごとに同じ値を並べ（enum は options の順の
 * `{heading, value}`、月は値だけ見る）、`unread` なら並び全体が null（評価器が集計元を読めないときの値）。
 */
export interface PropertyAggregateT2 {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
  /** データ状態ごとの kind と自然文（並びは台帳の表の順） */
  readonly states: readonly { readonly state: AggregateDataState; readonly kind: TestKind; readonly label: string }[];
  /** 集計の種類ごとの、データ状態の値（**並びが T1 の schema の種類の enum の順**） */
  readonly values: readonly {
    readonly aggregate: AggregateKind;
    readonly empty: AggregateStateValue;
    readonly unread: AggregateStateValue;
  }[];
  /** 参照データの対象（集計元の行を含まない） */
  readonly referenceTargets: readonly TestTargetKind[];
  /** 入力の形（行ごとの計算なら写像＝この行） */
  readonly input: "row-record";
  /**
   * この型の表で期待を確かめる、ほかの観測する性質（参照データに集計元の行が無い集計の試験だけ。kind は見ない）
   */
  readonly alsoObserves: readonly string[];
  readonly minTests: number;
  /** `codeRanges` の外の範囲の期待の値の書き手 */
  readonly expectedWriter: ExpectedValueWriter;
  /**
   * コードが作る範囲（期待の値の書き手が `code`。#595）。旗 `v12.ids` の走りだけ、この範囲の集計の行の空・未読の試験は
   * `v12/generated-tests.ts` が作り、T2 の LLM には書かせない。範囲の外（行ごとは入力の行が要り、見出しごと × 月は見出しの数が
   * 宣言の `last` で決まり表から導けない）は `expectedWriter` のまま（LLM が書き T2' が照らす）
   */
  readonly codeRanges: readonly AggregateRange[];
  /** T2' の固定文（値を埋めない） */
  readonly messages: {
    /** 旗 `v12.ids`：コードが作る試験と同じ（要件・対象・性質・データ状態）の試験を LLM が書いた（#595） */
    readonly notAllowed: string;
    /** 対象が、集計の種類と集計元を持つ種別 aggregate の計算の行でない */
    readonly target: string;
    /** 参照データに集計元の entity の行がある */
    readonly referenceData: string;
    /** kind がデータ状態に合わない */
    readonly kind: string;
    /** 期待が表から導いた値と違う */
    readonly expected: string;
    /** ほかの観測する性質の試験の期待が、表から導いた値と違う */
    readonly alsoExpected: string;
  };
}

/**
 * 条件の試験の型（操作の条件のように、期待が真偽で決まる性質だけが持つ。#550）。対象は `targetKind` の行のうち型の
 * `targetFlag` が真の行（条件を持つ操作）。kind は `kinds` のどれでもよく、期待は ok なら decode 済みの値が真偽、error なら
 * 条件が成り立たないこと（v1 の評価器と同じ）。値は T2 の LLM が書き、T2' は型と対象だけを照らす。
 */
export interface PropertyConditionT2 {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
  /** 対象の行の型の真偽の欄（真の行だけを対象にできる） */
  readonly targetFlag: "hasWhen";
  /** T1 の確かめ方（台帳の外の種類） */
  readonly t1Kind: "fixed-test";
  readonly kinds: readonly TestKind[];
  /** 期待の型（ok は真偽・error は条件が成り立たないこと） */
  readonly expected: { readonly ok: "boolean"; readonly error: "condition-fails" };
  /** 入力の形（写像）と参照データ（任意） */
  readonly input: "record";
  readonly referenceData: "any";
  readonly expectedWriter: ExpectedValueWriter;
  /** T2' の固定文（値を埋めない） */
  readonly messages: {
    /** 対象が、条件を持つ（`targetFlag` が真の）行でない */
    readonly target: string;
    /** 期待が ok なのに、decode 済みの値が真偽でない（写像・文字列・数・null） */
    readonly expected: string;
  };
}

/** 規則の文（段ごとに足す 1 文。無ければ null） */
export interface PropertyRules {
  readonly t1: string | null;
  readonly t1Acceptance: string | null;
  readonly t2: string | null;
  /**
   * 旗 `v12.ids` の走りの T2 の文（コードが試験を作る範囲を「作らない（コードが作る）」に差し替えた文。#595）。null なら
   * `t2` の文をそのまま使う
   */
  readonly t2Ids: string | null;
  readonly b1: string | null;
}

/** 台帳の 1 行（性質 1 つ） */
export interface PropertyRow {
  /** 性質 ID（T2 の observes の値と同じ） */
  readonly id: string;
  readonly since: string;
  readonly why: string;
  readonly state: PropertyState;
  /** v1.1α から引き継いだ行（列の一部は未定義で、今の検査のまま） */
  readonly inherited: boolean;
  /** 要件の決まりの型（自然文。未定義なら null） */
  readonly requirementRule: string | null;
  readonly t1: PropertyT1 | null;
  /** T1'' の受理条件（文。未定義なら null） */
  readonly t1Acceptance: string | null;
  /** 評価の方法の表の組（構造の検査を除く） */
  readonly combinations: readonly PropertyCombination[];
  readonly t2: PropertyT2 | null;
  /** 集計の試験の型（集計の種類 × データ状態で期待が決まる性質だけ。ほかは null。#549） */
  readonly t2Aggregate: PropertyAggregateT2 | null;
  /** 条件の試験の型（期待が真偽で決まる性質だけ。ほかは null。#550） */
  readonly t2Condition: PropertyConditionT2 | null;
  /** 網羅の鍵の欄（`coverage.ts` の `coverageUnitKey` の欄。未定義なら null） */
  readonly coverageKey: readonly string[] | null;
  /** B4 の照合の名前（評価口が名前 → 関数の表を持つ。未対応なら null） */
  readonly evaluation: string | null;
  /** 外の採点との対応（v5 の check kind。「外は見ない」は `OUTER_NOT_SCORED`。未定義なら null） */
  readonly outer: string | null;
  /** 未対応の性質の試験を T2' で落とす固定文（未対応の行だけ） */
  readonly unsupportedMessage: string | null;
  readonly rules: PropertyRules;
}

/** 外の採点がこの性質を見ないことの印 */
export const OUTER_NOT_SCORED = "外は見ない" as const;

/** 空の集計の行の T2 の文（旗 off と、旗 `v12.ids` の走りの行ごと・見出しごと × 月の集計の文。#549・#595） */
const EMPTY_AGGREGATE_T2_RULE =
  "集計（計算の行の type の form が aggregate）の要件の境界（boundary）の試験は、集計元を空と明示し（入力の契約の emptyEntities にその行の type.aggregate.entity の id を入れ、参照データにその entity の行を置かない）、期待（expected）の value を集計の種類で決まる値にする：sum・count は 0（見出しごとは、enum の見出しなら options の全キーを順に heading と value 0 で並べ、月の見出しなら各見出しの value を 0 にする）、avg は null（見出しごとは各見出しの value を null にする）。異常（abnormal）の試験は集計元に触れず（emptyEntities に入れず、参照データにその entity の行も置かない）、期待の value を null にする。どちらも対象（target）はその計算の行、operation は aggregate、observes は empty-aggregate、期待の kind は ok・code は null にする。集計元の行を置かずに observes を value にした集計の試験も、期待は同じ値（空と明示すれば種類で決まる値、しなければ null）にする。正常の試験（observes は value）は今までどおり集計元の行を置いて作る。";

/** v1.1α から引き継いだ行の共通の欄 */
const INHERITED = {
  since: "Issue #508（台帳への集約は #547）",
  state: "active",
  inherited: true,
  requirementRule: null,
  t1: null,
  t1Acceptance: null,
  t2: null,
  t2Aggregate: null,
  t2Condition: null,
  coverageKey: null,
  evaluation: "v1-run-tests",
  outer: null,
  unsupportedMessage: null,
  rules: { t1: null, t1Acceptance: null, t2: null, t2Ids: null, b1: null },
} as const;

/**
 * 性質の台帳（**並びは今の観測する性質の並び**＝T2 の observes の enum の順）。v1.1α の評価の方法の表の組
 * （value・validation・when・view-structure・existence）は引き継いだ有効の行、`state-after-set` は登録済み・未対応、
 * 最初の新しい行は `default-value`（#533 の列をそのまま写す）、2 つ目は `enum-membership`（選択肢の集合。#548）、3 つ目は
 * `empty-aggregate`（集計の種類 × データ状態の空の値。#549）、4 つ目は `non-requirement`（要件でない説明文。#550）。
 * 引き継いだ `when` の行は、手 2d（#550）で未定義の列（網羅の鍵を除く）を埋めた。
 */
export const PROPERTY_LEDGER: readonly PropertyRow[] = [
  {
    ...INHERITED,
    id: "when",
    since: "Issue #508（台帳への集約は #547・列の定義は #550）",
    why: "操作の条件（when）を、操作 × action の試験の真偽で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    requirementRule: "操作ができる条件（いつ実行できるか）を決める要件",
    combinations: [{ targetKind: "operation", operation: "action" }],
    t2Condition: {
      targetKind: "operation",
      operation: "action",
      targetFlag: "hasWhen",
      t1Kind: "fixed-test",
      kinds: TEST_KINDS,
      expected: { ok: "boolean", error: "condition-fails" },
      input: "record",
      referenceData: "any",
      expectedWriter: "llm-written-code-checked",
      messages: {
        target: "操作の条件（when）の試験の対象は、条件（when）を持つ操作の行であること",
        expected: "操作の条件（when）の試験の期待は、ok なら真偽（true・false）であること（操作後の状態を書かない）",
      },
    },
    outer: "advanceAction",
    rules: {
      t1: null,
      t1Acceptance: null,
      t2: "操作 × action の試験（observes は when）の期待（expected）は、操作の条件（when）が成り立つなら kind を ok・value を true、成り立たないなら kind を ok・value を false（か kind を error）にする。操作後の状態（写像・文字列・数）を期待に書かない。条件（when）の無い操作（表の type の hasWhen が false の行）に action の試験を作らない（その要件は構造の検査か別の対象で確かめる）。",
      t2Ids: null,
      b1: null,
    },
  },
  {
    ...INHERITED,
    id: "value",
    why: "計算と集計の値を、計算 × compute・aggregate の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    combinations: [
      { targetKind: "computation", operation: "compute" },
      { targetKind: "computation", operation: "aggregate" },
    ],
  },
  {
    ...INHERITED,
    id: "validation",
    why: "項目と entity の検査を、validate の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    combinations: [
      { targetKind: "field", operation: "validate" },
      { targetKind: "entity", operation: "validate" },
    ],
  },
  {
    ...INHERITED,
    id: "view-structure",
    why: "画面の構造を、画面・項目 × screen の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    combinations: [
      { targetKind: "screen", operation: "screen" },
      { targetKind: "field", operation: "screen" },
    ],
  },
  {
    ...INHERITED,
    id: "existence",
    why: "entity が在ることを、entity × screen の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    combinations: [{ targetKind: "entity", operation: "screen" }],
  },
  {
    ...INHERITED,
    id: "state-after-set",
    why: "操作に set を当てたあとの状態は評価の方法が無い（v1 は作ってから ⑤b で未解決にしていた。07 §2.3）。作れば T2' で落とす",
    state: "registered-unsupported",
    combinations: [],
    evaluation: null,
    unsupportedMessage: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）",
    rules: {
      t1: null,
      t1Acceptance: null,
      t2: "操作に set を当てたあとの状態（state-after-set）は評価できないので、その試験は作らない。",
      t2Ids: null,
      b1: null,
    },
  },
  {
    id: "default-value",
    since: "Issue #533（台帳への集約は #547）",
    why: "選択肢の項目の既定値だけを決める要件を、評価できる試験の形を試験より前に表で確定して確かめる（方法論 03 §1 の H2・H1。台帳 F5）",
    state: "active",
    inherited: false,
    requirementRule: "選択肢の項目の既定値（未入力のとき保存の時点で入る値）がどのキーかだけを決める要件。条件・計算・検査・操作後の状態を含む要件は当たらない",
    t1: {
      kind: "default-value",
      valueField: "value",
      ownership: {
        row: { kind: "field", type: "enum" },
        count: 1,
        entityAddedByCode: true,
        valueInOptions: true,
        optionsNonEmpty: false,
      },
      nature: "ruled",
      excludeWhenAccepted: false,
      messages: {
        valueShape: "既定値で確かめる要件の value は空でない文字列（期待する既定値のキー）であること",
        valueEmpty: "既定値で確かめる要件の value が空である",
        nature: "既定値で確かめる要件の分類は ruled であること",
        count: "既定値で確かめる要件は、選択肢（enum）の項目をちょうど 1 つ所属させること",
        others: "既定値で確かめる要件は、選択肢の項目とその所属 entity のほかの行を所属させないこと",
        valueNotInOptions: "既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い",
        optionsEmpty: null,
      },
    },
    t1Acceptance: "決まりが既定値 1 つだけで、value が要件の文の値と合うときだけ受理する。既定値のほかの決まりを含む要件・値の違う要件は weak-verification で拒否する",
    combinations: [{ targetKind: "field", operation: "validate" }],
    t2: {
      targetKind: "field",
      operation: "validate",
      requiredKinds: ["normal"],
      expected: { kind: "ok", valueType: "json-string", equals: "verification-value" },
      dataStates: [{ state: "未入力で保存した行", value: "verification-value" }],
      referenceTargets: [],
      input: "empty-record",
      minTests: 1,
      expectedWriter: "code",
      messages: {
        notAllowed: "項目の既定値（default-value）の試験は、確かめ方が default-value の要件の、その選択肢の項目だけを対象にできる",
        kind: "既定値で確かめる要件の試験は、正常（normal）だけであること",
        operation: "既定値で確かめる要件の試験の操作は、検査（validate）であること",
        target: "既定値で確かめる要件の試験の対象は、確かめ方の選択肢の項目（field）であること",
        observes: "既定値で確かめる要件の試験の観測する性質は、default-value であること",
        expected: "既定値で確かめる要件の試験の期待は、確かめ方のキーを JSON の文字列で書いた ok であること",
        input: "既定値で確かめる要件の試験の入力は、空の写像であること",
        referenceData: "既定値で確かめる要件の試験の参照データは、空の並びであること",
      },
    },
    t2Aggregate: null,
    t2Condition: null,
    coverageKey: ["requirementId", "targetId", "kind", "operation", "observes"],
    evaluation: "default-value",
    outer: "enumDefault",
    unsupportedMessage: null,
    rules: {
      t1: "要件の決まりが「選択肢の項目の既定値（未入力のとき保存の時点で入る値）がどのキーか」だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる（entity はコードが足す）。条件・計算・検査・操作後の状態を含む要件には default-value を使わない。default-value でなければ value は null にする。",
      t1Acceptance:
        "確かめ方が default-value の要件は、要件の決まりが選択肢の項目の既定値 1 つだけで、value が要件の文の値と合うときだけ受理する。既定値のほかの決まり（入力の制約など）を含む要件や、value が要件の文の値と違う要件は受理せず、weak-verification で拒否する。",
      t2: "項目の既定値（default-value）の試験は、確かめ方が default-value の要件にだけ、次の形で 1 本以上作る：対象（target）はその要件の所属の選択肢の項目（target.kind は field）、kind は normal、operation は validate、observes は default-value、入力（input）は空の写像（\"{}\"）、参照データ（referenceData）は空の並び、期待（expected）は kind を ok・value を確かめ方の value のキーの JSON の文字列（例: キーが k1 なら \"\\\"k1\\\"\"）・code を null。その要件には異常・境界の試験を作らない。ほかの要件に default-value を書かない。",
      t2Ids:
        "項目の既定値（default-value）の試験は作らない（確かめ方が default-value の要件は要件の一覧に無く、その試験はコードが作る）。どの要件の試験にも observes を default-value と書かない。",
      b1: "固定した試験のうち observes が default-value の試験は、対象の選択肢の項目の default に、その試験の期待（expected.value）のキーを書くことを求める。",
    },
  },
  {
    id: "enum-membership",
    since: "Issue #548",
    why: "選択肢の項目の値が挙げた選択肢のどれかであることだけを決める要件を、表で確定した選択肢の集合と宣言の options の照合で確かめる（名前の一致に頼らない。08 §8.2 の (c)①・M-03）",
    state: "active",
    inherited: false,
    requirementRule: "選択肢の項目の値が、挙げた選択肢のどれかであることだけを決める要件。条件・計算・既定値・入力の制約などほかの決まりを含む要件は当たらない",
    t1: {
      kind: "enum-membership",
      valueField: null,
      ownership: {
        row: { kind: "field", type: "enum" },
        count: 1,
        entityAddedByCode: true,
        valueInOptions: false,
        optionsNonEmpty: true,
      },
      nature: "ruled",
      excludeWhenAccepted: false,
      messages: {
        valueShape: "選択肢の集合で確かめる要件の value は null であること",
        valueEmpty: "選択肢の集合で確かめる要件の value は null であること",
        nature: "選択肢の集合で確かめる要件の分類は ruled であること",
        count: "選択肢の集合で確かめる要件は、選択肢（enum）の項目をちょうど 1 つ所属させること",
        others: "選択肢の集合で確かめる要件は、選択肢の項目とその所属 entity のほかの行を所属させないこと",
        valueNotInOptions: null,
        optionsEmpty: "選択肢の集合で確かめる要件の、所属させた選択肢の項目の options が空である",
      },
    },
    t1Acceptance: "決まりが選択肢の集合だけで、所属の項目の options が要件の文の選択肢と過不足なく合うときだけ受理する。ほかの決まりを含む要件・選択肢の合わない要件は weak-verification で拒否する",
    combinations: [{ targetKind: "field", operation: "validate" }],
    t2: {
      targetKind: "field",
      operation: "validate",
      requiredKinds: ["normal"],
      expected: { kind: "ok", valueType: "json-string-array", equals: "target-options" },
      dataStates: [{ state: "選択肢の項目の宣言", value: "target-options" }],
      referenceTargets: [],
      input: "empty-record",
      minTests: 1,
      expectedWriter: "code",
      messages: {
        notAllowed: "選択肢の集合（enum-membership）の試験は、確かめ方が enum-membership の要件の、その選択肢の項目だけを対象にできる",
        kind: "選択肢の集合で確かめる要件の試験は、正常（normal）だけであること",
        operation: "選択肢の集合で確かめる要件の試験の操作は、検査（validate）であること",
        target: "選択肢の集合で確かめる要件の試験の対象は、確かめ方の選択肢の項目（field）であること",
        observes: "選択肢の集合で確かめる要件の試験の観測する性質は、enum-membership であること",
        expected: "選択肢の集合で確かめる要件の試験の期待は、対象の項目の options のキーを表の順に並べた並びを JSON で書いた ok であること",
        input: "選択肢の集合で確かめる要件の試験の入力は、空の写像であること",
        referenceData: "選択肢の集合で確かめる要件の試験の参照データは、空の並びであること",
      },
    },
    t2Aggregate: null,
    t2Condition: null,
    coverageKey: ["requirementId", "targetId", "kind", "operation", "observes"],
    evaluation: "enum-membership",
    outer: OUTER_NOT_SCORED,
    unsupportedMessage: null,
    rules: {
      t1: "要件の決まりが「選択肢（enum）の項目の値は、挙げた選択肢のどれかである」だけなら kind を enum-membership にし、その項目だけを所属させ（entity はコードが足す）、value は null にする。選択肢はその項目の options で表す。条件・計算・既定値・入力の制約などほかの決まりを含む要件には enum-membership を使わない。",
      t1Acceptance:
        "確かめ方が enum-membership の要件は、要件の決まりが選択肢の集合だけで、所属させた選択肢の項目の options が要件の文の選択肢と過不足なく合うときだけ受理する。選択肢のほかの決まり（入力の制約など）を含む要件や、options が要件の文の選択肢と合わない要件は受理せず、weak-verification で拒否する。",
      t2: "選択肢の集合（enum-membership）の試験は、確かめ方が enum-membership の要件にだけ、次の形で 1 本以上作る：対象（target）はその要件の所属の選択肢の項目（target.kind は field）、kind は normal、operation は validate、observes は enum-membership、入力（input）は空の写像（\"{}\"）、参照データ（referenceData）は空の並び、期待（expected）は kind を ok・value をその項目の表の options のキーを表の順に並べた並びの JSON の文字列（例: キーが k1・k2 なら \"[\\\"k1\\\",\\\"k2\\\"]\"）・code を null。その要件には異常・境界の試験を作らない。ほかの要件に enum-membership を書かない。",
      t2Ids:
        "選択肢の集合（enum-membership）の試験は作らない（確かめ方が enum-membership の要件は要件の一覧に無く、その試験はコードが作る）。どの要件の試験にも observes を enum-membership と書かない。",
      b1: "固定した試験のうち observes が enum-membership の試験は、対象の選択肢の項目の options を、名前の表の行の options のキーの順で書くことを求める。",
    },
  },
  {
    id: "empty-aggregate",
    since: "Issue #549",
    why: "集計元が空・未読のときの集計の値を、集計の種類 × データ状態の表で試験より前に確定し、「読めない（null）」と「空（0）」の契約を T2 に見せる（一律の「空なら 0」は誤り。08 §5・§8.2 の (a)①）",
    state: "active",
    inherited: false,
    requirementRule: "集計（件数・合計・平均。行ごと・アプリ全体・見出しごと）の要件のうち、集計元が空・未読のときの値",
    t1: null,
    t1Acceptance: null,
    combinations: [{ targetKind: "computation", operation: "aggregate" }],
    t2: null,
    t2Aggregate: {
      targetKind: "computation",
      operation: "aggregate",
      states: [
        { state: "empty", kind: "boundary", label: "集計元を空と明示し行を置かない" },
        { state: "unread", kind: "abnormal", label: "集計元に触れない" },
      ],
      values: [
        { aggregate: "sum", empty: "zero", unread: "null" },
        { aggregate: "count", empty: "zero", unread: "null" },
        { aggregate: "avg", empty: "null", unread: "null" },
      ],
      referenceTargets: [],
      input: "row-record",
      alsoObserves: ["value"],
      minTests: 1,
      expectedWriter: "llm-written-code-checked",
      codeRanges: ["app", "groups-enum"],
      messages: {
        notAllowed:
          "アプリ全体と選択肢の見出しごとの集計の、集計元が空・未読の試験はコードが作るので、同じ要件・対象・データ状態の試験を書かないこと",
        target: "空の集計（empty-aggregate）の試験の対象は、集計の種類と集計元を持つ種別 aggregate の計算の行であること",
        referenceData: "空の集計（empty-aggregate）の試験の参照データに、集計元の entity の行を置かないこと",
        kind: "空の集計（empty-aggregate）の試験の kind は、集計元を空と明示するなら boundary、集計元に触れないなら abnormal であること",
        expected: "空の集計（empty-aggregate）の試験の期待は、集計の種類とデータ状態で決まる値（台帳の表）を書いた ok であること",
        alsoExpected: "集計元の行が無い集計の試験の期待は、集計の種類とデータ状態で決まる値（台帳の表。空と明示すれば種類の値、しなければ null）であること",
      },
    },
    t2Condition: null,
    coverageKey: ["requirementId", "targetId", "kind", "operation", "observes"],
    evaluation: "v1-run-tests",
    outer: OUTER_NOT_SCORED,
    unsupportedMessage: null,
    rules: {
      t1: "計算の行の type の aggregate には、種別（form）が aggregate の計算なら、集計の種類（kind：sum は合計・count は件数・avg は平均）と集計元の entity の行の id（entity）を書く。見出しごとの集計の集計元は、見出しの元の項目の所属 entity にする。種別が aggregate でない計算と、計算でない行の aggregate は null にする。",
      t1Acceptance: null,
      t2: EMPTY_AGGREGATE_T2_RULE,
      t2Ids:
        `集計（計算の行の type の form が aggregate）の行のうち、アプリ全体（type の scope が app）の行と、選択肢の見出しごと（groupBy の kind が enum）の行の、集計元を空と明示した境界（boundary）の試験と集計元に触れない異常（abnormal）の試験は作らない（コードが作る）。その行には、集計元の行を参照データに置いた正常の試験（observes は value）だけを作る。行ごと（type の scope が row）の集計と月の見出しごと（groupBy の kind が month）の集計の行は、次のとおり作る：${EMPTY_AGGREGATE_T2_RULE}`,
      b1: "名前の表の計算の行の type に aggregate があれば、宣言のその計算の aggregate の種類（sum・count・avg）と集計元の entity を、その行の aggregate の種類と、集計元の entity の行の名前のとおりに書く。",
    },
  },
  {
    id: "non-requirement",
    since: "Issue #550",
    why: "目的を述べる前置きのように決まりも対象の項目も無い文を、試験を作らずに扱う。免除は T1''（独立の点検）の受理だけで決め、受理されなければ持ち越す（出どころや要件 ID の形では免除しない。08 §5・§8.2）",
    state: "active",
    inherited: false,
    requirementRule: "決まりも対象の項目も無い説明文（目的を述べる前置きなど）",
    t1: {
      kind: "non-requirement",
      valueField: null,
      ownership: {
        row: null,
        count: 0,
        entityAddedByCode: false,
        valueInOptions: false,
        optionsNonEmpty: false,
      },
      nature: null,
      excludeWhenAccepted: true,
      messages: {
        valueShape: "要件でない文（non-requirement）の value は null であること",
        valueEmpty: "要件でない文（non-requirement）の value は null であること",
        nature: null,
        count: "要件でない文（non-requirement）には行を所属させないこと",
        others: "要件でない文（non-requirement）には行を所属させないこと",
        valueNotInOptions: null,
        optionsEmpty: null,
      },
    },
    t1Acceptance: "文に決まりも対象（項目・計算・集計・操作・画面）も無いときだけ受理する。決まりか対象があれば weak-verification で拒否する",
    combinations: [],
    t2: null,
    t2Aggregate: null,
    t2Condition: null,
    coverageKey: null,
    evaluation: null,
    outer: OUTER_NOT_SCORED,
    unsupportedMessage: null,
    rules: {
      t1: "決まりも対象の項目も無い説明文（目的を述べる前置きなど）だけ kind を non-requirement にし、行を所属させず（roles は空の並び）、value は null にする。要件の出どころ（答えから来た・了承した代替先）では決めない。決まり（条件・計算・検査・既定値・選択肢）か対象（項目・計算・集計・操作・画面）を含む文には non-requirement を使わない。",
      t1Acceptance:
        "確かめ方が non-requirement の要件は、要件の文に決まりも対象（項目・計算・集計・操作・画面）も無いときだけ受理する。決まりか対象を含む要件は受理せず、weak-verification で拒否する。要件の出どころや要件 ID の形を受理の理由にしない。",
      t2: null,
      t2Ids: null,
      b1: null,
    },
  },
];

// ── 台帳の点検 ───────────────────────────────────────────────────

/**
 * 台帳の行の不備（`id`・`since`・`why`・状態が無い・`id` の重なり・状態に合わない欄）。不備の文は行の `id` を含む
 * （台帳はコードで、文は人が直すための診断）。不備のある台帳からは導かない（`deriveLedgerView` が例外で断る）。
 */
export function ledgerRowDefects(rows: readonly PropertyRow[]): readonly string[] {
  const defects: string[] = [];
  const seen = new Set<string>();
  const kinds = new Set<string>();
  rows.forEach((row, index) => {
    const at = row.id.trim() === "" ? `行 ${String(index)}` : `性質 ${row.id}`;
    if (row.id.trim() === "") defects.push(`${at} の id が空である`);
    else if (seen.has(row.id)) defects.push(`性質の id ${row.id} が台帳の中で重なっている`);
    seen.add(row.id);
    if (row.since.trim() === "") defects.push(`${at} の since が空である`);
    if (row.why.trim() === "") defects.push(`${at} の why が空である`);
    if (!(PROPERTY_STATES as readonly string[]).includes(row.state)) defects.push(`${at} の状態が知らない値である`);
    if (row.state === "registered-unsupported") {
      if (row.unsupportedMessage === null) defects.push(`${at} は未対応なのに、落とす固定文が無い`);
      if (row.evaluation !== null) defects.push(`${at} は未対応なのに、照合の名前がある`);
    } else if (row.evaluation === null && row.t1?.excludeWhenAccepted !== true) {
      defects.push(`${at} は有効なのに、照合の名前が無い`);
    }
    if (row.t1 !== null) {
      if (kinds.has(row.t1.kind)) defects.push(`${at} の確かめ方の種類 ${row.t1.kind} が重なっている`);
      kinds.add(row.t1.kind);
      if (row.t2 === null && !row.t1.excludeWhenAccepted) defects.push(`${at} は確かめ方の種類を持つのに、試験の型が無い`);
      const { ownership, messages, valueField } = row.t1;
      if (row.t1.nature !== null && messages.nature === null) defects.push(`${at} は分類を求めるのに、固定文が無い`);
      if ((ownership.row === null) !== (ownership.count === 0)) {
        defects.push(`${at} の所属の形が、行の種類の無いことと所属 0 行で食い違う`);
      }
      if (row.t1.excludeWhenAccepted) {
        // 受理で除く確かめ方（要件でない文。#550）：所属 0 行・試験を作らない・照合しない・受理条件の文がある
        if (ownership.count !== 0) defects.push(`${at} は受理で除くのに、行を所属させる`);
        if (row.t2 !== null || row.t2Aggregate !== null || row.t2Condition !== null || row.combinations.length > 0) {
          defects.push(`${at} は受理で除くのに、試験の型か評価の方法の表の組がある`);
        }
        if (row.evaluation !== null) defects.push(`${at} は受理で除くのに、照合の名前がある`);
        if (row.t1Acceptance === null || row.rules.t1Acceptance === null) defects.push(`${at} は受理で除くのに、受理条件が無い`);
      }
      if (ownership.valueInOptions && (valueField === null || messages.valueNotInOptions === null)) {
        defects.push(`${at} は欄の値を options に照らすのに、欄か固定文が無い`);
      }
      if (ownership.optionsNonEmpty && messages.optionsEmpty === null) {
        defects.push(`${at} は options が空でないことを求めるのに、固定文が無い`);
      }
      if (row.t2 !== null && row.t2.expected.equals === "verification-value" && valueField === null) {
        defects.push(`${at} の期待は確かめ方の欄の値なのに、確かめ方に欄が無い`);
      }
    }
    // コードが作る試験の型（#595）：入力は空の写像・参照データは空（コードが値を埋められる形）で、旗 `v12.ids` の文がある
    if (row.t2 !== null && row.t2.expectedWriter === "code") {
      if (row.t2.input !== "empty-record" || row.t2.referenceTargets.length > 0) {
        defects.push(`${at} は期待の値をコードが書くのに、入力か参照データが空でない`);
      }
      if (row.rules.t2Ids === null) defects.push(`${at} は期待の値をコードが書くのに、旗 ids の T2 の文が無い`);
    }
    if (row.t2Aggregate !== null) {
      const { states, values, targetKind, operation } = row.t2Aggregate;
      const stateNames = states.map((entry) => entry.state);
      if (stateNames.length !== AGGREGATE_DATA_STATES.length || AGGREGATE_DATA_STATES.some((state) => !stateNames.includes(state))) {
        defects.push(`${at} の集計の試験の型のデータ状態が、空と未読をちょうど 1 つずつ持たない`);
      }
      const aggregateKinds = values.map((entry) => entry.aggregate);
      if (aggregateKinds.length === 0 || new Set(aggregateKinds).size !== aggregateKinds.length) {
        defects.push(`${at} の集計の試験の型の種類の表が、空か重なっている`);
      }
      if (!row.combinations.some((entry) => entry.targetKind === targetKind && entry.operation === operation)) {
        defects.push(`${at} の集計の試験の型の組が、評価の方法の表の組に無い`);
      }
      const { codeRanges } = row.t2Aggregate;
      if (
        new Set(codeRanges).size !== codeRanges.length ||
        codeRanges.some((range) => !(AGGREGATE_RANGES as readonly string[]).includes(range))
      ) {
        defects.push(`${at} の集計の試験の型のコードが作る範囲が、知らない値か重なっている`);
      }
      if (codeRanges.length > 0 && row.rules.t2Ids === null) {
        defects.push(`${at} はコードが作る範囲を持つのに、旗 ids の T2 の文が無い`);
      }
    }
    if (row.t2Condition !== null) {
      const { kinds: conditionKinds, targetKind, operation } = row.t2Condition;
      if (conditionKinds.length === 0 || new Set(conditionKinds).size !== conditionKinds.length) {
        defects.push(`${at} の条件の試験の型の kind が、空か重なっている`);
      }
      if (!row.combinations.some((entry) => entry.targetKind === targetKind && entry.operation === operation)) {
        defects.push(`${at} の条件の試験の型の組が、評価の方法の表の組に無い`);
      }
    }
  });
  return defects;
}

// ── 導出（旗 on の段が読むもの）──────────────────────────────────

/** 台帳の外にある確かめ方の種類（性質に結び付かない種類。並びは今の確かめ方の並びの頭） */
export const BASE_VERIFICATION_KINDS = ["fixed-test", "structural", "unresolved"] as const;

/** 評価の方法の表の 1 行（対象の種類・操作・観測する性質） */
export interface LedgerCombination extends PropertyCombination {
  readonly observes: string;
}

/** 台帳から導いたもの（旗 on の段が受け取る） */
export interface LedgerView {
  readonly rows: readonly PropertyRow[];
  /** 確かめ方の種類（台帳の外の種類＋台帳の行の種類。台帳の順） */
  readonly verificationKinds: readonly string[];
  /** 観測する性質（台帳の全行のうち、受理で除く確かめ方の行＝試験を作らない行を除く。台帳の順。#550） */
  readonly observes: readonly string[];
  /** 未対応の性質（台帳の順） */
  readonly unsupportedObserves: readonly string[];
  /** 評価の方法の表（有効・削る候補の行の組。台帳の順） */
  readonly combinations: readonly LedgerCombination[];
  /** T1 の規則に差し込む文（台帳の順） */
  readonly t1RuleTexts: readonly string[];
  /** T1'' の規則（R-sc-02 の (3) の末尾）に差し込む受理条件の文（台帳の順。#548） */
  readonly t1AcceptanceTexts: readonly string[];
  /** B1 の規則（R-w11 の末尾）に差し込む文（有効・削る候補の行。台帳の順。#548） */
  readonly b1RuleTexts: readonly string[];
  /** T2 の規則の形の位置に差し込む文（有効・削る候補の行。台帳の順） */
  readonly t2FormTexts: readonly string[];
  /**
   * 旗 `v12.ids` の走りの T2 の規則の形の位置に差し込む文（`t2FormTexts` の各行の文を、旗 ids の文があればそれに差し替えたもの。
   * 台帳の順。#595）
   */
  readonly t2IdsFormTexts: readonly string[];
  /** T2 の規則の末尾に差し込む、未対応の性質の試験を作らせない文（台帳の順） */
  readonly t2UnsupportedTexts: readonly string[];
  /** 正常・異常・境界のそろいを求めない確かめ方の種類（試験の型の必須の kind が normal だけの行。台帳の順） */
  readonly t2ExemptKinds: readonly string[];
  /** 観測する性質 → 行 */
  readonly rowByObserves: ReadonlyMap<string, PropertyRow>;
  /** 確かめ方の種類 → 行（確かめ方に結び付いた行だけ） */
  readonly rowByVerificationKind: ReadonlyMap<string, PropertyRow>;
  /** T1'' が受理すれば要件でない文として残る一覧から除く確かめ方の種類（台帳の順。#550） */
  readonly excludedWhenAcceptedKinds: readonly string[];
  /** 条件の試験の型を持つ行（有効・削る候補の行。台帳の順。#550） */
  readonly conditionRows: readonly (PropertyRow & { readonly t2Condition: PropertyConditionT2 })[];
  /** 集計の試験の型を持つ行（有効・削る候補の行。台帳の順。#549） */
  readonly aggregateRows: readonly (PropertyRow & { readonly t2Aggregate: PropertyAggregateT2 })[];
  /**
   * T1 の計算の行の型の `aggregate` の種類（集計の試験の型の表の順。重なりは 1 つ。空なら `aggregate` は台帳に無く、
   * T1 の schema に欄を足さず、書いた表は T1' が形で落とす。#549）
   */
  readonly aggregateKinds: readonly AggregateKind[];
}

const isOnlyNormal = (kinds: readonly TestKind[]): boolean => kinds.length === 1 && kinds[0] === "normal";

/** 台帳から導く。不備のある台帳は例外で断る（fail-closed。LLM を呼ばない） */
export function deriveLedgerView(rows: readonly PropertyRow[]): LedgerView {
  const defects = ledgerRowDefects(rows);
  if (defects.length > 0) throw new Error(`性質の台帳：${defects.join("／")}`);
  const evaluable = rows.filter((row) => row.state !== "registered-unsupported");
  const bound = rows.filter((row): row is PropertyRow & { readonly t1: PropertyT1 } => row.t1 !== null);
  const aggregateRows = evaluable.filter(
    (row): row is PropertyRow & { readonly t2Aggregate: PropertyAggregateT2 } => row.t2Aggregate !== null,
  );
  // 受理で除く確かめ方の行は試験を作らないので、観測する性質に入れない（T2 の schema の enum・T2' の台帳の引きの外。#550）
  const observable = rows.filter((row) => row.t1?.excludeWhenAccepted !== true);
  return {
    rows,
    verificationKinds: [...BASE_VERIFICATION_KINDS, ...bound.map((row) => row.t1.kind)],
    observes: observable.map((row) => row.id),
    unsupportedObserves: rows.filter((row) => row.state === "registered-unsupported").map((row) => row.id),
    combinations: evaluable.flatMap((row) => row.combinations.map((entry) => ({ ...entry, observes: row.id }))),
    t1RuleTexts: rows.flatMap((row) => (row.rules.t1 === null ? [] : [row.rules.t1])),
    t1AcceptanceTexts: rows.flatMap((row) => (row.rules.t1Acceptance === null ? [] : [row.rules.t1Acceptance])),
    b1RuleTexts: evaluable.flatMap((row) => (row.rules.b1 === null ? [] : [row.rules.b1])),
    t2FormTexts: evaluable.flatMap((row) => (row.rules.t2 === null ? [] : [row.rules.t2])),
    t2IdsFormTexts: evaluable.flatMap((row) => {
      const text = row.rules.t2Ids ?? row.rules.t2;
      return text === null ? [] : [text];
    }),
    t2UnsupportedTexts: rows
      .filter((row) => row.state === "registered-unsupported")
      .flatMap((row) => (row.rules.t2 === null ? [] : [row.rules.t2])),
    t2ExemptKinds: bound.filter((row) => row.t2 !== null && isOnlyNormal(row.t2.requiredKinds)).map((row) => row.t1.kind),
    rowByObserves: new Map(observable.map((row) => [row.id, row] as const)),
    rowByVerificationKind: new Map(bound.map((row) => [row.t1.kind, row] as const)),
    excludedWhenAcceptedKinds: bound.filter((row) => row.t1.excludeWhenAccepted).map((row) => row.t1.kind),
    conditionRows: evaluable.filter(
      (row): row is PropertyRow & { readonly t2Condition: PropertyConditionT2 } => row.t2Condition !== null,
    ),
    aggregateRows,
    aggregateKinds: [...new Set(aggregateRows.flatMap((row) => row.t2Aggregate.values.map((entry) => entry.aggregate)))],
  };
}

/** 今の台帳から導いたもの（旗 on の走りが渡す） */
export const PROPERTY_LEDGER_VIEW: LedgerView = deriveLedgerView(PROPERTY_LEDGER);

/** 旗から、段へ渡す台帳の導出を選ぶ（旗 ledger が off なら undefined＝段は今の定数と関数を使う） */
export function ledgerViewOf(flags: Pick<V12Flags, "ledger">): LedgerView | undefined {
  return flags.ledger ? PROPERTY_LEDGER_VIEW : undefined;
}

/** 試験の型の必須に無い kind の、v1 の網羅の検査の固定文（`${kind} の試験が無い`。外す文） */
export function exemptKindMessagesOf(t2: PropertyT2): readonly string[] {
  return TEST_KINDS.filter((kind) => !t2.requiredKinds.includes(kind)).map((kind) => `${kind} の試験が無い`);
}

/**
 * 集計の試験の型の表から、1 つの見出し（行ごと・アプリ全体なら値そのもの）の値を導く（LLM を呼ばない。#549）。
 * 種類が表に無ければ undefined（呼ぶ側が落とす）。見出しごとに並べるのは呼ぶ側（T2'）で、見出しごとの `unread` は並び全体が
 * null になる（評価器が集計元を読めないときの値）。
 */
export function aggregateStateValueOf(
  t2: PropertyAggregateT2,
  aggregate: string,
  state: AggregateDataState,
): 0 | null | undefined {
  const entry = t2.values.find((candidate) => candidate.aggregate === aggregate);
  if (entry === undefined) return undefined;
  return entry[state] === "zero" ? 0 : null;
}

// ── 人が読む写し（methodology/ledger/properties.md の表）─────────────

/** 写しの表の見出し（1 行 1 性質） */
export const PROPERTY_COPY_HEADER = ["id", "状態", "since", "T1 の kind", "T2 の形", "期待の値の書き手", "B4", "外の対応", "why"] as const;

/** 写しの表の 1 行（コードの台帳の 1 行から組む。欄の中の `|` は書かない） */
export function propertyCopyCells(row: PropertyRow): readonly string[] {
  const state = `${PROPERTY_STATE_LABELS[row.state]}${row.inherited ? "（v1.1α から引き継ぎ・列の一部は未定義）" : ""}`;
  const aggregate = row.t2Aggregate;
  const condition = row.t2Condition;
  const shape =
    condition !== null
      ? `${condition.targetKind} × ${condition.operation}（${condition.targetFlag} が真の行）・${condition.kinds.join("・")}・期待 ok は真偽・error は条件が成り立たない・入力 ${condition.input}・参照データ ${condition.referenceData}`
      : row.t1?.excludeWhenAccepted === true
      ? "無し（試験を作らない。T1'' が受理すれば要件でない文として残る一覧から除く）"
      : aggregate !== null
      ? `${aggregate.targetKind} × ${aggregate.operation}・${aggregate.states.map((entry) => `${entry.kind}（${entry.label}）`).join("・")}・期待 ok の種類 × データ状態の値（${aggregate.values.map((entry) => `${entry.aggregate} は空 ${entry.empty}・未読 ${entry.unread}`).join("／")}）・入力 ${aggregate.input}・参照データ 集計元の行なし・${String(aggregate.minTests)} 本以上`
      : row.t2 === null
      ? row.combinations.length === 0
        ? "—"
        : `未定義（組：${row.combinations.map((entry) => `${entry.targetKind} × ${entry.operation}`).join("・")}）`
      : `${row.t2.targetKind} × ${row.t2.operation}・${row.t2.requiredKinds.join("・")}・期待 ${row.t2.expected.kind} の ${row.t2.expected.valueType}・入力 ${row.t2.input}・参照データ ${row.t2.referenceTargets.length === 0 ? "空" : row.t2.referenceTargets.join("・")}・${String(row.t2.minTests)} 本以上`;
  // 集計の試験の型は、コードが作る範囲とその外の範囲で書き手を分けて書く（#595）
  const aggregateWriter =
    aggregate === null
      ? undefined
      : aggregate.codeRanges.length === 0
      ? aggregate.expectedWriter
      : `code（${aggregate.codeRanges.map((range) => AGGREGATE_RANGE_LABELS[range]).join("・")}）／${aggregate.expectedWriter}（${AGGREGATE_RANGES.filter((range) => !aggregate.codeRanges.includes(range))
          .map((range) => AGGREGATE_RANGE_LABELS[range])
          .join("・")}）`;
  return [
    row.id,
    state,
    row.since,
    row.t1?.kind ?? condition?.t1Kind ?? "—",
    shape,
    row.t2?.expectedWriter ?? aggregateWriter ?? condition?.expectedWriter ?? "—",
    row.evaluation ?? "—",
    row.outer ?? "未定義",
    row.why,
  ];
}
