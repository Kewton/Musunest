// 性質の台帳と v1.2 の旗（08-architecture-v1.2.md §5・§9 手 2。Issue #547）。
//
// **性質 1 つに 1 行。** T1 の確かめ方・T1' の所属の形・T1'' の受理条件・T2 の試験の型・網羅の鍵・B4 の照合・外の採点
// との対応・規則の文を、この 1 行から導く。台帳に無い性質は T1' の確かめ方・T2' の観測する性質・B4 の照合で拒否する。
// **正本はこのコード**で、人が読む写しは `methodology/ledger/properties.md`（試験が 1 要素 1 行で照らす。D2）。
//
// 旗 `v12.ledger`（`V12Flags.ledger`。既定 off）が on の走りでだけ、走らせる部分が `ledgerViewOf` の導出を T1・T1'・T2・
// T2'・評価口（B4・B5 の道具・版の再検査）へ渡す。off の走りは今の定数と関数をそのまま使い、ここを通らない。
// 手 2a（この Issue）は**載せ替えだけ**で、on で組んだ規則の文・schema・データの並びは off とバイト列で同じである。
// T1''・B1 の規則の文の列は記録するが、その段への配線は手 2b で足す。
//
// 台帳は LLM を呼ばず、評価口を import しない（B4 の照合は名前で持ち、評価口が名前 → 関数の表を持つ）。
import { TEST_KINDS, type TestKind, type TestOperation, type TestTargetKind } from "../fixed-test.js";

// ── 旗（v1.2 の旗の正本）──────────────────────────────────────────

/** v1.2 の旗（旗の名前 → 真偽）。後の手の旗（探索型の直しなど）はここに足す */
export interface V12Flags {
  /** 性質の台帳から確かめ方・観測する性質・評価の方法を導く（手 2。既定 off） */
  readonly ledger: boolean;
}

/** 旗の名前の並び（`V12Flags` の鍵と同じ順） */
export const V12_FLAG_NAMES = ["ledger"] as const satisfies readonly (keyof V12Flags)[];

/** 全部 off の旗（`flags` を省いた走り＝今の v1.1α） */
export const V12_FLAGS_OFF: Readonly<V12Flags> = { ledger: false };

/**
 * `--pipeline v1.2` が流す旗の組（**merge 済みの手の旗を全部 on**。今は ledger だけ）。計測の道具が読む契約の正本で、
 * 手元の入口はこの値から旗を組む（写しを別に作らない）。v1.2 の走りの要約と条件の記録の `v12_flags` は、実際に使った
 * この組を写す。
 */
export const V12_PIPELINE_FLAGS: Readonly<V12Flags> = { ledger: true };

/** 渡された旗（省いた名前は off）から、全部の名前を持つ実効の旗を組む */
export function resolveV12Flags(flags?: Partial<V12Flags>): V12Flags {
  return { ledger: flags?.ledger === true };
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
 * 照らす（違えば拒否）。§5 の「値はコードだけで埋まる」（`code`）は手 3 で入れる
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
 * `valueField` は確かめ方の欄（その行の options のキー）。`nature` は表の分類に求める値。
 */
export interface PropertyT1 {
  readonly kind: string;
  readonly valueField: "value";
  readonly ownership: {
    readonly row: { readonly kind: TestTargetKind; readonly type: string };
    readonly count: number;
    readonly entityAddedByCode: boolean;
    readonly valueInOptions: boolean;
  };
  readonly nature: "ruled" | "existence-only";
  /** T1' の固定文（値を埋めない） */
  readonly messages: {
    /** 下書きの形：欄が空でない文字列でない */
    readonly valueShape: string;
    /** 型付きの表：欄が空 */
    readonly valueEmpty: string;
    readonly nature: string;
    readonly count: string;
    readonly others: string;
    readonly valueNotInOptions: string;
  };
}

/** T2 の試験の型（確かめ方の種類に結び付いた性質だけが持つ。ほかの性質は今の検査のまま＝未定義） */
export interface PropertyT2 {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
  /** 作ってよい（そろえる）kind。ここに無い kind の不足は v1 の網羅の検査から外す */
  readonly requiredKinds: readonly TestKind[];
  /** 期待の型（kind・値の型・何と等しいか） */
  readonly expected: { readonly kind: "ok"; readonly valueType: "json-string"; readonly equals: "verification-value" };
  /** データ状態ごとの値（自然文の状態 → 期待） */
  readonly dataStates: readonly { readonly state: string; readonly value: "verification-value" }[];
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

/** 規則の文（段ごとに足す 1 文。無ければ null） */
export interface PropertyRules {
  readonly t1: string | null;
  readonly t1Acceptance: string | null;
  readonly t2: string | null;
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

/** v1.1α から引き継いだ行の共通の欄 */
const INHERITED = {
  since: "Issue #508（台帳への集約は #547）",
  state: "active",
  inherited: true,
  requirementRule: null,
  t1: null,
  t1Acceptance: null,
  t2: null,
  coverageKey: null,
  evaluation: "v1-run-tests",
  outer: null,
  unsupportedMessage: null,
  rules: { t1: null, t1Acceptance: null, t2: null, b1: null },
} as const;

/**
 * 性質の台帳（**並びは今の観測する性質の並び**＝T2 の observes の enum の順）。v1.1α の評価の方法の表の組
 * （value・validation・when・view-structure・existence）は引き継いだ有効の行、`state-after-set` は登録済み・未対応、
 * 最初の新しい行は `default-value`（#533 の列をそのまま写す）。
 */
export const PROPERTY_LEDGER: readonly PropertyRow[] = [
  {
    ...INHERITED,
    id: "when",
    why: "操作の条件（when）を、操作 × action の試験の真偽で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3）",
    combinations: [{ targetKind: "operation", operation: "action" }],
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
      ownership: { row: { kind: "field", type: "enum" }, count: 1, entityAddedByCode: true, valueInOptions: true },
      nature: "ruled",
      messages: {
        valueShape: "既定値で確かめる要件の value は空でない文字列（期待する既定値のキー）であること",
        valueEmpty: "既定値で確かめる要件の value が空である",
        nature: "既定値で確かめる要件の分類は ruled であること",
        count: "既定値で確かめる要件は、選択肢（enum）の項目をちょうど 1 つ所属させること",
        others: "既定値で確かめる要件は、選択肢の項目とその所属 entity のほかの行を所属させないこと",
        valueNotInOptions: "既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い",
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
      expectedWriter: "llm-written-code-checked",
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
    coverageKey: ["requirementId", "targetId", "kind", "operation", "observes"],
    evaluation: "default-value",
    outer: "enumDefault",
    unsupportedMessage: null,
    rules: {
      t1: "要件の決まりが「選択肢の項目の既定値（未入力のとき保存の時点で入る値）がどのキーか」だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる（entity はコードが足す）。条件・計算・検査・操作後の状態を含む要件には default-value を使わない。default-value でなければ value は null にする。",
      t1Acceptance:
        "確かめ方が default-value の要件は、要件の決まりが選択肢の項目の既定値 1 つだけで、value が要件の文の値と合うときだけ受理する。既定値のほかの決まり（入力の制約など）を含む要件や、value が要件の文の値と違う要件は受理せず、weak-verification で拒否する。",
      t2: "項目の既定値（default-value）の試験は、確かめ方が default-value の要件にだけ、次の形で 1 本以上作る：対象（target）はその要件の所属の選択肢の項目（target.kind は field）、kind は normal、operation は validate、observes は default-value、入力（input）は空の写像（\"{}\"）、参照データ（referenceData）は空の並び、期待（expected）は kind を ok・value を確かめ方の value のキーの JSON の文字列（例: キーが k1 なら \"\\\"k1\\\"\"）・code を null。その要件には異常・境界の試験を作らない。ほかの要件に default-value を書かない。",
      b1: "固定した試験のうち observes が default-value の試験は、対象の選択肢の項目の default に、その試験の期待（expected.value）のキーを書くことを求める。",
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
    } else if (row.evaluation === null) {
      defects.push(`${at} は有効なのに、照合の名前が無い`);
    }
    if (row.t1 !== null) {
      if (kinds.has(row.t1.kind)) defects.push(`${at} の確かめ方の種類 ${row.t1.kind} が重なっている`);
      kinds.add(row.t1.kind);
      if (row.t2 === null) defects.push(`${at} は確かめ方の種類を持つのに、試験の型が無い`);
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
  /** 観測する性質（台帳の全行。台帳の順） */
  readonly observes: readonly string[];
  /** 未対応の性質（台帳の順） */
  readonly unsupportedObserves: readonly string[];
  /** 評価の方法の表（有効・削る候補の行の組。台帳の順） */
  readonly combinations: readonly LedgerCombination[];
  /** T1 の規則に差し込む文（台帳の順） */
  readonly t1RuleTexts: readonly string[];
  /** T2 の規則の形の位置に差し込む文（有効・削る候補の行。台帳の順） */
  readonly t2FormTexts: readonly string[];
  /** T2 の規則の末尾に差し込む、未対応の性質の試験を作らせない文（台帳の順） */
  readonly t2UnsupportedTexts: readonly string[];
  /** 正常・異常・境界のそろいを求めない確かめ方の種類（試験の型の必須の kind が normal だけの行。台帳の順） */
  readonly t2ExemptKinds: readonly string[];
  /** 観測する性質 → 行 */
  readonly rowByObserves: ReadonlyMap<string, PropertyRow>;
  /** 確かめ方の種類 → 行（確かめ方に結び付いた行だけ） */
  readonly rowByVerificationKind: ReadonlyMap<string, PropertyRow>;
}

const isOnlyNormal = (kinds: readonly TestKind[]): boolean => kinds.length === 1 && kinds[0] === "normal";

/** 台帳から導く。不備のある台帳は例外で断る（fail-closed。LLM を呼ばない） */
export function deriveLedgerView(rows: readonly PropertyRow[]): LedgerView {
  const defects = ledgerRowDefects(rows);
  if (defects.length > 0) throw new Error(`性質の台帳：${defects.join("／")}`);
  const evaluable = rows.filter((row) => row.state !== "registered-unsupported");
  const bound = rows.filter((row): row is PropertyRow & { readonly t1: PropertyT1 } => row.t1 !== null);
  return {
    rows,
    verificationKinds: [...BASE_VERIFICATION_KINDS, ...bound.map((row) => row.t1.kind)],
    observes: rows.map((row) => row.id),
    unsupportedObserves: rows.filter((row) => row.state === "registered-unsupported").map((row) => row.id),
    combinations: evaluable.flatMap((row) => row.combinations.map((entry) => ({ ...entry, observes: row.id }))),
    t1RuleTexts: rows.flatMap((row) => (row.rules.t1 === null ? [] : [row.rules.t1])),
    t2FormTexts: evaluable.flatMap((row) => (row.rules.t2 === null ? [] : [row.rules.t2])),
    t2UnsupportedTexts: rows
      .filter((row) => row.state === "registered-unsupported")
      .flatMap((row) => (row.rules.t2 === null ? [] : [row.rules.t2])),
    t2ExemptKinds: bound.filter((row) => row.t2 !== null && isOnlyNormal(row.t2.requiredKinds)).map((row) => row.t1.kind),
    rowByObserves: new Map(rows.map((row) => [row.id, row] as const)),
    rowByVerificationKind: new Map(bound.map((row) => [row.t1.kind, row] as const)),
  };
}

/** 今の台帳から導いたもの（旗 on の走りが渡す） */
export const PROPERTY_LEDGER_VIEW: LedgerView = deriveLedgerView(PROPERTY_LEDGER);

/** 旗から、段へ渡す台帳の導出を選ぶ（旗 ledger が off なら undefined＝段は今の定数と関数を使う） */
export function ledgerViewOf(flags: V12Flags): LedgerView | undefined {
  return flags.ledger ? PROPERTY_LEDGER_VIEW : undefined;
}

/** 試験の型の必須に無い kind の、v1 の網羅の検査の固定文（`${kind} の試験が無い`。外す文） */
export function exemptKindMessagesOf(t2: PropertyT2): readonly string[] {
  return TEST_KINDS.filter((kind) => !t2.requiredKinds.includes(kind)).map((kind) => `${kind} の試験が無い`);
}

// ── 人が読む写し（methodology/ledger/properties.md の表）─────────────

/** 写しの表の見出し（1 行 1 性質） */
export const PROPERTY_COPY_HEADER = ["id", "状態", "since", "T1 の kind", "T2 の形", "期待の値の書き手", "B4", "外の対応", "why"] as const;

/** 写しの表の 1 行（コードの台帳の 1 行から組む。欄の中の `|` は書かない） */
export function propertyCopyCells(row: PropertyRow): readonly string[] {
  const state = `${PROPERTY_STATE_LABELS[row.state]}${row.inherited ? "（v1.1α から引き継ぎ・列の一部は未定義）" : ""}`;
  const shape =
    row.t2 === null
      ? row.combinations.length === 0
        ? "—"
        : `未定義（組：${row.combinations.map((entry) => `${entry.targetKind} × ${entry.operation}`).join("・")}）`
      : `${row.t2.targetKind} × ${row.t2.operation}・${row.t2.requiredKinds.join("・")}・期待 ${row.t2.expected.kind} の ${row.t2.expected.valueType}・入力 ${row.t2.input}・参照データ ${row.t2.referenceTargets.length === 0 ? "空" : row.t2.referenceTargets.join("・")}・${String(row.t2.minTests)} 本以上`;
  return [
    row.id,
    state,
    row.since,
    row.t1?.kind ?? "—",
    shape,
    row.t2?.expectedWriter ?? "—",
    row.evaluation ?? "—",
    row.outer ?? "未定義",
    row.why,
  ];
}
