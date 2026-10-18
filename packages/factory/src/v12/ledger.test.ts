// 性質の台帳と v1.2 の旗（v12/ledger.ts）の試験（08-architecture-v1.2.md §5・§9 手 2。Issue #547）。
//
// 固定したいこと：
//   1. 全行に id・since・why・状態があり、id が台帳の中で一意（同じ id の行を 2 つ置くと落ちる。二点測定）
//   2. 有効で試験の型を持つ行の照合の名前が、評価口の表に全部ある
//   3. 台帳から導いた観測する性質・未対応・確かめ方の種類・評価の方法の表が、今の定数と同じ（並びも）
//   4. 行の固定文・規則の文が、今の段の定数・規則の文と同じ（台帳が今の振る舞いの写しになっている）
//   5. 人が読む写し（methodology/ledger/properties.md）の表が、コードの台帳と 1 要素 1 行で一致する（二点測定）
//   6. 手 2b（#548）：台帳から enum-membership の行を除いた導出は今の定数と同じで、今の台帳との差はその行の分だけ
//   7. 手 2c（#549）：台帳から empty-aggregate の行を除いた導出は #548 の導出と同じで、今の台帳との差はその行の分だけ。
//      集計の種類 × データ状態の表（一律の「空なら 0」でない）と、T1 の集計の種類の enum が表の順であること
//   8. 手 2d（#550）：when の行の列を埋め、non-requirement の行を足した。#549 の台帳（`LEDGER_ROWS_2C`）との差はこの 2 行の分
//      だけ（観測する性質は増えない・確かめ方の種類が 1 つ増える）。台帳の点検が受理で除く確かめ方の形を見ること
//   9. 手 3c（#595）：期待の値の書き手が default-value・enum-membership で code、empty-aggregate はコードが作る範囲（アプリ全体と
//      見出しごと × 選択肢）つき。旗 ids の T2 の文はコードが作る範囲だけを「作らない」に差し替え、ほかの行の文は今のまま
//
// LLM を呼ばない。外部の API を呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { TEST_KINDS, type FixedTest } from "../fixed-test.js";
import { ruleDefinitionDefects } from "../stages/prompt.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { coverageUnitKey } from "../v11a/coverage.js";
import { V11A_EVALUATION_NAMES } from "../v11a/evaluate.js";
import { NAME_TABLE_VERIFICATION_KINDS } from "../v11a/names.js";
import { SEMANTIC_CHECK_RULE_DEFINITIONS, semanticCheckRuleDefinitionsOf } from "../v11a/stages/semantic-check.js";
import { NAME_TABLE_RULE_DEFINITIONS, nameTableRuleDefinitionsOf } from "../v11a/stages/name-table.js";
import {
  DEFAULT_VALUE_EXEMPT_MESSAGES,
  DEFAULT_VALUE_NOT_ALLOWED_MESSAGE,
  DEFAULT_VALUE_TEST_MESSAGES,
  EVALUABLE_COMBINATIONS,
  TEST_OBSERVES,
  TEST_SPEC_RULE_DEFINITIONS,
  UNSUPPORTED_OBSERVES,
  testSpecRuleDefinitionsOf,
} from "../v11a/stages/test-spec.js";
import { WRITE_V11A_RULE_DEFINITIONS, writeV11aRuleDefinitionsOf } from "../v11a/stages/write.js";
import { LEDGER_ROWS_2C } from "../v11a/__tests__/fixtures.js";
import {
  PROPERTY_COPY_HEADER,
  PROPERTY_LEDGER,
  PROPERTY_LEDGER_VIEW,
  PROPERTY_STATES,
  OUTER_NOT_SCORED,
  V12_FLAGS_OFF,
  V12_FLAG_NAMES,
  V12_FLAG_PUBLIC_NAMES,
  V12_PUBLIC_FLAG_NAMES,
  fromPublicV12Flags,
  toPublicV12Flags,
  V12_PIPELINE_FLAGS,
  AGGREGATE_DATA_STATES,
  AGGREGATE_RANGES,
  aggregateStateValueOf,
  deriveLedgerView,
  exemptKindMessagesOf,
  ledgerRowDefects,
  ledgerViewOf,
  propertyCopyCells,
  resolveV12Flags,
  type PropertyRow,
  type V12Flags,
} from "./ledger.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 人が読む写し（リポジトリの workspace の文書） */
const COPY_TEXT = fs.readFileSync(
  new URL("../../../../workspace/mvp/m1/agent/methodology/ledger/properties.md", import.meta.url),
  "utf8",
);

const rowOf = (id: string): PropertyRow => {
  const row = PROPERTY_LEDGER.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`前提が壊れた：台帳に ${id} が無い`);
  return row;
};
const DEFAULT_VALUE = rowOf("default-value");
const ENUM_MEMBERSHIP = rowOf("enum-membership");
const EMPTY_AGGREGATE = rowOf("empty-aggregate");
const WHEN = rowOf("when");
const NON_REQUIREMENT = rowOf("non-requirement");
/**
 * 手 2a（#547）の台帳＝#549 の台帳（`LEDGER_ROWS_2C`。今の台帳から手 2d の分を戻したもの。#550）から enum-membership の行
 * （と手 2c の empty-aggregate の行。#549）を除いたもの。その導出は今の定数と同じ（載せ替えの不変）
 */
const LEDGER_2A = LEDGER_ROWS_2C.filter((row) => row.id !== "enum-membership" && row.id !== "empty-aggregate");
const VIEW_2A = deriveLedgerView(LEDGER_2A);
/** #548 の台帳＝#549 の台帳から empty-aggregate の行を除いたもの（Issue #549） */
const VIEW_2B = deriveLedgerView(LEDGER_ROWS_2C.filter((row) => row.id !== "empty-aggregate"));
/** #549 の台帳（手 2d の前。Issue #550） */
const VIEW_2C = deriveLedgerView(LEDGER_ROWS_2C);

// ── 1. 行の欄と id の一意 ─────────────────────────────────────────

describe("台帳の行：全行に id・since・why・状態があり、id が一意", () => {
  it("今の台帳は不備 0 で、全行の id・since・why が空でなく、状態が 3 つのどれか", () => {
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
    expect(PROPERTY_LEDGER.length).toBeGreaterThan(0);
    for (const row of PROPERTY_LEDGER) {
      expect(row.id.trim(), row.id).not.toBe("");
      expect(row.since.trim(), row.id).not.toBe("");
      expect(row.why.trim(), row.id).not.toBe("");
      expect(PROPERTY_STATES, row.id).toContain(row.state);
    }
    expect(new Set(PROPERTY_LEDGER.map((row) => row.id)).size).toBe(PROPERTY_LEDGER.length);
  });

  it("二点測定：同じ id の行を 2 つ置くと不備になり、導出が例外で断る（元の台帳は通る）", () => {
    expect(() => deriveLedgerView(PROPERTY_LEDGER)).not.toThrow();
    const duplicated = [...PROPERTY_LEDGER, { ...DEFAULT_VALUE, t1: null, t2: null }];
    expect(ledgerRowDefects(duplicated)).toEqual(["性質の id default-value が台帳の中で重なっている"]);
    expect(() => deriveLedgerView(duplicated)).toThrow("台帳の中で重なっている");
  });

  it("二点測定：since・why・id が空・知らない状態の行は不備になる", () => {
    const broken = (patch: Partial<PropertyRow>) => ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "when" ? { ...row, ...patch } : row)));
    expect(broken({ since: " " })).toEqual(["性質 when の since が空である"]);
    expect(broken({ why: "" })).toEqual(["性質 when の why が空である"]);
    expect(broken({ state: "unknown" as PropertyRow["state"] })).toEqual(["性質 when の状態が知らない値である"]);
    expect(broken({ id: "" })).toEqual(["行 0 の id が空である"]);
  });

  it("状態に合わない欄は不備になる（未対応に照合の名前・有効に照合の名前が無い・確かめ方の種類の重なり）", () => {
    const patched = (id: string, patch: Partial<PropertyRow>) => PROPERTY_LEDGER.map((row) => (row.id === id ? { ...row, ...patch } : row));
    expect(ledgerRowDefects(patched("state-after-set", { evaluation: "v1-run-tests" }))).toEqual([
      "性質 state-after-set は未対応なのに、照合の名前がある",
    ]);
    expect(ledgerRowDefects(patched("when", { evaluation: null }))).toEqual(["性質 when は有効なのに、照合の名前が無い"]);
    // 期待の値をコードが書く試験の型を、旗 ids の文の無い行へ写すと、その不備も出る（Issue #595）
    expect(ledgerRowDefects(patched("when", { t1: DEFAULT_VALUE.t1, t2: DEFAULT_VALUE.t2 }))).toEqual([
      "性質 when は期待の値をコードが書くのに、旗 ids の T2 の文が無い",
      "性質 default-value の確かめ方の種類 default-value が重なっている",
    ]);
  });

  it("二点測定：確かめ方の記述子と固定文・期待の型が食い違う行は不備になる（Issue #548。今の台帳は通る）", () => {
    if (ENUM_MEMBERSHIP.t1 === null || ENUM_MEMBERSHIP.t2 === null || DEFAULT_VALUE.t1 === null) throw new Error("前提が壊れた");
    const t1 = ENUM_MEMBERSHIP.t1;
    const t2 = ENUM_MEMBERSHIP.t2;
    const patched = (patch: Partial<PropertyRow>) =>
      ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "enum-membership" ? { ...row, ...patch } : row)));
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
    expect(patched({ t1: { ...t1, ownership: { ...t1.ownership, valueInOptions: true } } })).toEqual([
      "性質 enum-membership は欄の値を options に照らすのに、欄か固定文が無い",
    ]);
    expect(patched({ t1: { ...t1, messages: { ...t1.messages, optionsEmpty: null } } })).toEqual([
      "性質 enum-membership は options が空でないことを求めるのに、固定文が無い",
    ]);
    expect(patched({ t2: { ...t2, expected: { ...t2.expected, equals: "verification-value" } } })).toEqual([
      "性質 enum-membership の期待は確かめ方の欄の値なのに、確かめ方に欄が無い",
    ]);
    expect(() => deriveLedgerView(PROPERTY_LEDGER.map((row) => (row.id === "enum-membership" ? { ...row, t1: { ...t1, valueField: null, ownership: { ...t1.ownership, valueInOptions: true } } } : row)))).toThrow(
      "性質 enum-membership は欄の値を options に照らすのに、欄か固定文が無い",
    );
  });

  it("enum-membership の行：確かめ方は欄を持たず、所属の形は enum の項目 1 行＋entity・ruled・options が空でない、期待は options の並び、外は見ない", () => {
    expect(ENUM_MEMBERSHIP.state).toBe("active");
    expect(ENUM_MEMBERSHIP.since).toBe("Issue #548");
    expect(ENUM_MEMBERSHIP.t1?.kind).toBe("enum-membership");
    expect(ENUM_MEMBERSHIP.t1?.valueField).toBeNull();
    expect(ENUM_MEMBERSHIP.t1?.nature).toBe("ruled");
    expect(ENUM_MEMBERSHIP.t1?.ownership).toEqual({
      row: { kind: "field", type: "enum" },
      count: 1,
      entityAddedByCode: true,
      valueInOptions: false,
      optionsNonEmpty: true,
    });
    // default-value と同じ記述子から、value の照合を除き options が空でないことを足したもの
    expect({ ...DEFAULT_VALUE.t1?.ownership, valueInOptions: false, optionsNonEmpty: true }).toEqual(ENUM_MEMBERSHIP.t1?.ownership);
    expect(ENUM_MEMBERSHIP.t2?.expected).toEqual({ kind: "ok", valueType: "json-string-array", equals: "target-options" });
    expect(ENUM_MEMBERSHIP.t2?.requiredKinds).toEqual(["normal"]);
    expect(ENUM_MEMBERSHIP.t2?.referenceTargets).toEqual([]);
    expect(ENUM_MEMBERSHIP.t2?.input).toBe("empty-record");
    // 期待の値の書き手は code（旗 v12.ids の走りでコードが作る。Issue #595）
    expect(ENUM_MEMBERSHIP.t2?.expectedWriter).toBe("code");
    expect(ENUM_MEMBERSHIP.combinations).toEqual([{ targetKind: "field", operation: "validate" }]);
    expect(ENUM_MEMBERSHIP.evaluation).toBe("enum-membership");
    expect(ENUM_MEMBERSHIP.outer).toBe(OUTER_NOT_SCORED);
    // 期待の例は抽象のキー
    expect(ENUM_MEMBERSHIP.rules.t2).toContain("k1・k2");
  });
});

// ── 2. 照合の名前 ─────────────────────────────────────────────────

describe("B4 の照合の名前：有効で試験の型（または評価の方法の組）を持つ行の名前が、評価口の表に全部ある", () => {
  it("今の台帳の有効の行の照合の名前は、全部 V11A_EVALUATION_NAMES にある", () => {
    const names = V11A_EVALUATION_NAMES as readonly string[];
    const active = PROPERTY_LEDGER.filter((row) => row.state !== "registered-unsupported" && (row.t2 !== null || row.combinations.length > 0));
    expect(active.map((row) => row.id)).toEqual([
      "when",
      "value",
      "validation",
      "view-structure",
      "existence",
      "default-value",
      "enum-membership",
      "empty-aggregate",
    ]);
    for (const row of active) expect(names, row.id).toContain(row.evaluation);
    // 未対応の行は照合の名前を持たない（B4 は未解決にする）
    expect(rowOf("state-after-set").evaluation).toBeNull();
  });

  it("二点測定：表に無い名前を持つ行は、この照合から外れる", () => {
    const names = V11A_EVALUATION_NAMES as readonly string[];
    const changed = { ...DEFAULT_VALUE, evaluation: "no-such-evaluation" };
    expect(names).toContain(DEFAULT_VALUE.evaluation);
    expect(names).not.toContain(changed.evaluation);
  });
});

// ── 3. 導出と今の定数 ─────────────────────────────────────────────

describe("台帳から導いたものが今の定数と同じ（旗 on の載せ替えの不変。手 2b では enum-membership の行を除いた導出）", () => {
  it("観測する性質の並び・未対応の並び・確かめ方の種類の並びが、今の定数と深く等しい（今の台帳は enum-membership が末尾に 1 つ増えるだけ）", () => {
    expect(VIEW_2A.observes).toEqual([...TEST_OBSERVES]);
    expect(VIEW_2A.unsupportedObserves).toEqual([...UNSUPPORTED_OBSERVES]);
    expect(VIEW_2A.verificationKinds).toEqual([...NAME_TABLE_VERIFICATION_KINDS]);
    expect(VIEW_2B.observes).toEqual([...TEST_OBSERVES, "enum-membership"]);
    expect(VIEW_2B.unsupportedObserves).toEqual([...UNSUPPORTED_OBSERVES]);
    expect(VIEW_2B.verificationKinds).toEqual([...NAME_TABLE_VERIFICATION_KINDS, "enum-membership"]);
    // 手 2c（#549）：観測する性質が末尾に 1 つ増える。確かめ方の種類は増えない（fixed-test のまま）
    expect(VIEW_2C.observes).toEqual([...TEST_OBSERVES, "enum-membership", "empty-aggregate"]);
    expect(VIEW_2C.unsupportedObserves).toEqual([...UNSUPPORTED_OBSERVES]);
    expect(VIEW_2C.verificationKinds).toEqual(VIEW_2B.verificationKinds);
    // 手 2d（#550）：観測する性質は増えない（non-requirement は試験を作らない）。確かめ方の種類は末尾に 1 つ増える
    expect(PROPERTY_LEDGER_VIEW.observes).toEqual(VIEW_2C.observes);
    expect(PROPERTY_LEDGER_VIEW.unsupportedObserves).toEqual([...UNSUPPORTED_OBSERVES]);
    expect(PROPERTY_LEDGER_VIEW.verificationKinds).toEqual([...VIEW_2C.verificationKinds, "non-requirement"]);
  });

  it("評価の方法の表の組の数が 9 で、今の表と同じ組の集合（照らす側は `some` で引くので並びは振る舞いに効かない）。今の台帳は field × validate × enum-membership の 1 組だけ多い", () => {
    const key = (entry: { targetKind: string; operation: string; observes: string }) => `${entry.targetKind}|${entry.operation}|${entry.observes}`;
    expect(VIEW_2A.combinations).toHaveLength(9);
    expect(EVALUABLE_COMBINATIONS).toHaveLength(9);
    expect(new Set(VIEW_2A.combinations.map(key))).toEqual(new Set(EVALUABLE_COMBINATIONS.map(key)));
    expect(VIEW_2B.combinations).toHaveLength(10);
    expect(new Set(VIEW_2B.combinations.map(key))).toEqual(new Set([...EVALUABLE_COMBINATIONS.map(key), "field|validate|enum-membership"]));
    // 手 2c（#549）：computation × aggregate × empty-aggregate の 1 組だけ多い
    expect(VIEW_2C.combinations).toHaveLength(11);
    expect(new Set(VIEW_2C.combinations.map(key))).toEqual(
      new Set([...EVALUABLE_COMBINATIONS.map(key), "field|validate|enum-membership", "computation|aggregate|empty-aggregate"]),
    );
    // 手 2d（#550）：組は増えない（when の組は引き継いだまま・non-requirement は組を持たない）
    expect(PROPERTY_LEDGER_VIEW.combinations).toEqual(VIEW_2C.combinations);
  });

  it("除外する確かめ方の種類・外す v1 の文が、今の R-tsp-02 の除外と免除の文と同じ（enum-membership も同じ免除の文）", () => {
    expect(VIEW_2A.t2ExemptKinds).toEqual(["default-value"]);
    expect(PROPERTY_LEDGER_VIEW.t2ExemptKinds).toEqual(["default-value", "enum-membership"]);
    if (ENUM_MEMBERSHIP.t2 === null) throw new Error("前提が壊れた");
    expect(exemptKindMessagesOf(ENUM_MEMBERSHIP.t2)).toEqual([...DEFAULT_VALUE_EXEMPT_MESSAGES]);
    if (DEFAULT_VALUE.t2 === null) throw new Error("前提が壊れた");
    expect(exemptKindMessagesOf(DEFAULT_VALUE.t2)).toEqual([...DEFAULT_VALUE_EXEMPT_MESSAGES]);
    expect(TEST_KINDS.filter((kind) => !DEFAULT_VALUE.t2?.requiredKinds.includes(kind))).toEqual(["abnormal", "boundary"]);
  });

  it("default-value の行の T2' の固定文が今の定数と同じ", () => {
    const { notAllowed, ...messages } = DEFAULT_VALUE.t2?.messages ?? { notAllowed: "" };
    expect(notAllowed).toBe(DEFAULT_VALUE_NOT_ALLOWED_MESSAGE);
    expect(messages).toEqual(DEFAULT_VALUE_TEST_MESSAGES);
  });

  it("網羅の鍵の欄が、今の網羅の単位の鍵（`coverageUnitKey`）の欄と同じ", () => {
    const test: FixedTest = {
      id: "t",
      target: { requirementId: "R1", kind: "field", roleId: "f.x" },
      kind: "normal",
      operation: "validate",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      referenceData: [],
      expected: { kind: "ok", value: "k1" },
    };
    const key = coverageUnitKey(test, new Map([["t", "default-value"]]), new Map([["R1", "ruled" as const]]));
    const fields = Object.keys(JSON.parse(key ?? "{}") as Record<string, unknown>).filter((name) => name !== "basis");
    expect([...fields].sort()).toEqual([...(DEFAULT_VALUE.coverageKey ?? [])].sort());
    expect(ENUM_MEMBERSHIP.coverageKey).toEqual(DEFAULT_VALUE.coverageKey);
  });

  it("旗から導出を選ぶ：on なら今の台帳の導出、off なら undefined（段は今の定数と関数）", () => {
    expect(ledgerViewOf({ ledger: true })).toBe(PROPERTY_LEDGER_VIEW);
    expect(ledgerViewOf({ ledger: false })).toBeUndefined();
    expect(ledgerViewOf(resolveV12Flags())).toBeUndefined();
    expect(resolveV12Flags()).toEqual(V12_FLAGS_OFF);
    expect(Object.keys(V12_PIPELINE_FLAGS)).toEqual(V12_FLAG_NAMES.map((name) => V12_FLAG_PUBLIC_NAMES[name]));
    expect(V12_PIPELINE_FLAGS).toEqual({ ledger: true, "search-repair": true, ids: true });
  });

  it("内部の鍵と公開の鍵の対応（1 か所の定数）：全部の旗が両方向に写り、公開の鍵は小文字・数字・ハイフン・点の形で重ならない（Issue #551）", () => {
    // 計測の道具の照合の形（score-agent.mjs の isFlagMap の旗の名前の形）
    const FLAG_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
    expect(Object.keys(V12_FLAG_PUBLIC_NAMES)).toEqual([...V12_FLAG_NAMES]);
    expect(V12_FLAG_PUBLIC_NAMES).toEqual({ ledger: "ledger", searchRepair: "search-repair", ids: "ids" });
    expect(V12_PUBLIC_FLAG_NAMES).toEqual(["ledger", "search-repair", "ids"]);
    expect(new Set(V12_PUBLIC_FLAG_NAMES).size).toBe(V12_FLAG_NAMES.length);
    for (const name of V12_PUBLIC_FLAG_NAMES) expect(name).toMatch(FLAG_NAME);
    for (const name of Object.keys(V12_PIPELINE_FLAGS)) expect(name).toMatch(FLAG_NAME);
    // 1 つだけ on の組を、内部 → 公開 → 内部・公開 → 内部 → 公開の両方向に写す
    for (const name of V12_FLAG_NAMES) {
      const only = { ...V12_FLAGS_OFF, [name]: true };
      const published = toPublicV12Flags(only);
      expect(Object.entries(published).filter(([, on]) => on).map(([key]) => key)).toEqual([V12_FLAG_PUBLIC_NAMES[name]]);
      expect(fromPublicV12Flags(published)).toEqual(only);
      expect(toPublicV12Flags(fromPublicV12Flags({ [V12_FLAG_PUBLIC_NAMES[name]]: true }))).toEqual(published);
    }
    expect(toPublicV12Flags(V12_FLAGS_OFF)).toEqual({ ledger: false, "search-repair": false, ids: false });
    expect(fromPublicV12Flags({})).toEqual(V12_FLAGS_OFF);
    expect(fromPublicV12Flags(V12_PIPELINE_FLAGS)).toEqual({ ledger: true, searchRepair: true, ids: true });
    expect(toPublicV12Flags(fromPublicV12Flags(V12_PIPELINE_FLAGS))).toEqual(V12_PIPELINE_FLAGS);
    // 公開の鍵はコードの内部の鍵としては読まない（resolveV12Flags は内部の鍵だけを読む）
    // ids は内部の鍵と公開の鍵が同じ名前なので、どちらで読んでも on（Issue #592）
    expect(resolveV12Flags(V12_PIPELINE_FLAGS as unknown as Partial<V12Flags>)).toEqual({ ledger: true, searchRepair: false, ids: true });
  });
});

// ── 4. 規則の文 ──────────────────────────────────────────────────

describe("規則の文：台帳の行の文が今の段の規則の文と同じ（T1・T1''・T2・B1）", () => {
  const textOf = (definitions: readonly { id: string; text: string }[], id: string): string =>
    definitions.find((definition) => definition.id === id)?.text ?? "";

  it("T1 の文は R-nt-08 に、T2 の文は R-tsp-16 に、T1'' の文は R-sc-02 に、B1 の文は R-w11-10 に、そのまま在る", () => {
    expect(textOf(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08")).toContain(DEFAULT_VALUE.rules.t1 ?? "（無い）");
    expect(textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16")).toContain(DEFAULT_VALUE.rules.t2 ?? "（無い）");
    expect(textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16")).toContain(rowOf("state-after-set").rules.t2 ?? "（無い）");
    expect(textOf(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02")).toContain(DEFAULT_VALUE.rules.t1Acceptance ?? "（無い）");
    expect(textOf(WRITE_V11A_RULE_DEFINITIONS, "R-w11-10")).toBe(DEFAULT_VALUE.rules.b1);
  });

  it("enum-membership の行を除いた台帳で組んだ T1・T1''・T2・B1 の規則の定義は off の定数と深く等しく、規則の不備は on・off とも 0", () => {
    for (const [on, off] of [
      [nameTableRuleDefinitionsOf(VIEW_2A), NAME_TABLE_RULE_DEFINITIONS],
      [semanticCheckRuleDefinitionsOf(VIEW_2A), SEMANTIC_CHECK_RULE_DEFINITIONS],
      [testSpecRuleDefinitionsOf(VIEW_2A), TEST_SPEC_RULE_DEFINITIONS],
      [writeV11aRuleDefinitionsOf(VIEW_2A), WRITE_V11A_RULE_DEFINITIONS],
    ] as const) {
      expect(on).toEqual(off);
      expect(ruleDefinitionDefects(on)).toEqual([]);
      expect(ruleDefinitionDefects(off)).toEqual([]);
    }
    expect(semanticCheckRuleDefinitionsOf()).toBe(SEMANTIC_CHECK_RULE_DEFINITIONS);
    expect(writeV11aRuleDefinitionsOf()).toBe(WRITE_V11A_RULE_DEFINITIONS);
  });

  it("#548 の台帳（empty-aggregate の行を除いた導出）で組んだ規則と off の差は enum-membership の文だけ（R-nt-08・R-sc-02・R-tsp-02・R-tsp-16 の文と R-w11-11 の 1 行）で、規則の不備は 0", () => {
    const { t1, t1Acceptance, t2, b1 } = ENUM_MEMBERSHIP.rules;
    if (t1 === null || t1Acceptance === null || t2 === null || b1 === null) throw new Error("前提が壊れた");
    const insertedAfter = (text: string, anchor: string | null, added: string): string => {
      if (anchor === null || !text.includes(anchor)) throw new Error("前提が壊れた");
      return text.replace(anchor, `${anchor}${added}`);
    };
    const withText = (definitions: readonly { id: string; text: string }[], id: string, text: string) =>
      definitions.map((definition) => (definition.id === id ? { ...definition, text } : definition));
    expect(nameTableRuleDefinitionsOf(VIEW_2B)).toEqual(
      withText(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08", insertedAfter(textOf(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08"), DEFAULT_VALUE.rules.t1, t1)),
    );
    expect(semanticCheckRuleDefinitionsOf(VIEW_2B)).toEqual(
      withText(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02", `${textOf(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02")}${t1Acceptance}`),
    );
    expect(testSpecRuleDefinitionsOf(VIEW_2B)).toEqual(
      withText(
        withText(
          TEST_SPEC_RULE_DEFINITIONS,
          "R-tsp-02",
          textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-02").replace("structural・default-value の要件", "structural・default-value・enum-membership の要件"),
        ),
        "R-tsp-16",
        insertedAfter(textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16"), DEFAULT_VALUE.rules.t2, t2),
      ),
    );
    const write = writeV11aRuleDefinitionsOf(VIEW_2B);
    expect(write.slice(0, -1)).toEqual(WRITE_V11A_RULE_DEFINITIONS);
    expect(write.at(-1)).toEqual({ id: "R-w11-11", text: b1, why: `性質の台帳の行 enum-membership の B1 の文（${ENUM_MEMBERSHIP.why}）`, since: "Issue #548" });
    for (const definitions of [
      nameTableRuleDefinitionsOf(VIEW_2B),
      semanticCheckRuleDefinitionsOf(VIEW_2B),
      testSpecRuleDefinitionsOf(VIEW_2B),
      write,
    ]) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
    }
  });

  it("#549 の台帳で組んだ規則と #548 の台帳の差は empty-aggregate の文だけ（R-nt-08・R-tsp-16 の文と R-w11-12 の 1 行。T1'' は同じ）で、規則の不備は 0（Issue #549）", () => {
    const { t1, t1Acceptance, t2, b1 } = EMPTY_AGGREGATE.rules;
    if (t1 === null || t2 === null || b1 === null) throw new Error("前提が壊れた");
    expect(t1Acceptance).toBeNull();
    const appended = (definitions: readonly { id: string; text: string }[], id: string, anchor: string | null, added: string) =>
      definitions.map((definition) => {
        if (definition.id !== id) return definition;
        if (anchor === null || !definition.text.includes(anchor)) throw new Error("前提が壊れた");
        return { ...definition, text: definition.text.replace(anchor, `${anchor}${added}`) };
      });
    expect(nameTableRuleDefinitionsOf(VIEW_2C)).toEqual(
      appended(nameTableRuleDefinitionsOf(VIEW_2B), "R-nt-08", ENUM_MEMBERSHIP.rules.t1, t1),
    );
    expect(semanticCheckRuleDefinitionsOf(VIEW_2C)).toEqual(semanticCheckRuleDefinitionsOf(VIEW_2B));
    expect(testSpecRuleDefinitionsOf(VIEW_2C)).toEqual(
      appended(testSpecRuleDefinitionsOf(VIEW_2B), "R-tsp-16", ENUM_MEMBERSHIP.rules.t2, t2),
    );
    const write = writeV11aRuleDefinitionsOf(VIEW_2C);
    expect(write.slice(0, -1)).toEqual(writeV11aRuleDefinitionsOf(VIEW_2B));
    expect(write.at(-1)).toEqual({ id: "R-w11-12", text: b1, why: `性質の台帳の行 empty-aggregate の B1 の文（${EMPTY_AGGREGATE.why}）`, since: "Issue #549" });
    // R-tsp-02 の除外は変わらない（免除は無い：boundary・abnormal を empty-aggregate で満たす）
    expect(VIEW_2C.t2ExemptKinds).toEqual(VIEW_2B.t2ExemptKinds);
    for (const definitions of [nameTableRuleDefinitionsOf(VIEW_2C), testSpecRuleDefinitionsOf(VIEW_2C), write]) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
    }
  });

  it("導出の T1'' の受理条件の文・B1 の文は台帳の順（default-value → enum-membership）", () => {
    expect(VIEW_2B.t1AcceptanceTexts).toEqual([DEFAULT_VALUE.rules.t1Acceptance, ENUM_MEMBERSHIP.rules.t1Acceptance]);
    expect(VIEW_2B.b1RuleTexts).toEqual([DEFAULT_VALUE.rules.b1, ENUM_MEMBERSHIP.rules.b1]);
    // 手 2c（#549）：T1'' の受理条件は増えず、B1 の文は末尾に empty-aggregate の 1 文が増える
    expect(VIEW_2C.t1AcceptanceTexts).toEqual(VIEW_2B.t1AcceptanceTexts);
    expect(VIEW_2C.b1RuleTexts).toEqual([DEFAULT_VALUE.rules.b1, ENUM_MEMBERSHIP.rules.b1, EMPTY_AGGREGATE.rules.b1]);
    // 手 2d（#550）：T1'' の受理条件の文は末尾に non-requirement の 1 文が増え、B1 の文は増えない
    expect(PROPERTY_LEDGER_VIEW.t1AcceptanceTexts).toEqual([...VIEW_2C.t1AcceptanceTexts, NON_REQUIREMENT.rules.t1Acceptance]);
    expect(PROPERTY_LEDGER_VIEW.b1RuleTexts).toEqual(VIEW_2C.b1RuleTexts);
    expect(VIEW_2A.t1AcceptanceTexts).toEqual([DEFAULT_VALUE.rules.t1Acceptance]);
    expect(VIEW_2A.b1RuleTexts).toEqual([DEFAULT_VALUE.rules.b1]);
  });

  it("二点測定：台帳の enum-membership の B1 の文を 1 文字変えると、組んだ R-w11-11 の文が変わる（台帳から組んでいる）", () => {
    const changed = PROPERTY_LEDGER.map((row) => (row.id === "enum-membership" ? { ...row, rules: { ...row.rules, b1: `${row.rules.b1 ?? ""}。` } } : row));
    const view = deriveLedgerView(changed);
    expect(writeV11aRuleDefinitionsOf(view).find((definition) => definition.id === "R-w11-11")?.text).toBe(`${ENUM_MEMBERSHIP.rules.b1 ?? ""}。`);
    expect(semanticCheckRuleDefinitionsOf(view)).toEqual(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW));
  });

  it("今の台帳で組んだ規則と #549 の台帳の差は when・non-requirement の文だけ（R-nt-08・R-sc-02・R-tsp-16 の文。B1・R-tsp-02 は同じ）で、規則の不備は 0（Issue #550）", () => {
    const whenT2 = WHEN.rules.t2;
    const { t1, t1Acceptance, t2, b1 } = NON_REQUIREMENT.rules;
    if (whenT2 === null || t1 === null || t1Acceptance === null) throw new Error("前提が壊れた");
    expect(t2).toBeNull();
    expect(b1).toBeNull();
    const withRule = (definitions: readonly { id: string; text: string }[], id: string, text: (before: string) => string) =>
      definitions.map((definition) => (definition.id === id ? { ...definition, text: text(definition.text) } : definition));
    const appended = (anchor: string | null, added: string) => (text: string): string => {
      if (anchor === null || !text.includes(anchor)) throw new Error("前提が壊れた");
      return text.replace(anchor, `${anchor}${added}`);
    };
    // T1：R-nt-08 の台帳の文の末尾（empty-aggregate の文の次）に non-requirement の文
    expect(nameTableRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)).toEqual(
      withRule(nameTableRuleDefinitionsOf(VIEW_2C), "R-nt-08", appended(EMPTY_AGGREGATE.rules.t1, t1)),
    );
    // T1''：R-sc-02 の末尾に non-requirement の受理条件の文
    expect(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)).toEqual(
      withRule(semanticCheckRuleDefinitionsOf(VIEW_2C), "R-sc-02", (text) => `${text}${t1Acceptance}`),
    );
    // T2：R-tsp-16 の台帳の文の頭（when は台帳の 1 行目）に when の文。R-tsp-02 の除外は変わらない
    const head = TEST_SPEC_RULE_DEFINITIONS.find((definition) => definition.id === "R-tsp-16")?.text.split(DEFAULT_VALUE.rules.t2 ?? "（無い）")[0] ?? "";
    expect(head).not.toBe("");
    expect(testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)).toEqual(
      withRule(testSpecRuleDefinitionsOf(VIEW_2C), "R-tsp-16", appended(head, whenT2)),
    );
    expect(writeV11aRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)).toEqual(writeV11aRuleDefinitionsOf(VIEW_2C));
    expect(PROPERTY_LEDGER_VIEW.t2ExemptKinds).toEqual(VIEW_2C.t2ExemptKinds);
    for (const definitions of [
      nameTableRuleDefinitionsOf(PROPERTY_LEDGER_VIEW),
      semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW),
      testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW),
      writeV11aRuleDefinitionsOf(PROPERTY_LEDGER_VIEW),
    ]) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
    }
  });

  it("台帳の文・欄に受入の題材の言葉が無い", () => {
    const text = JSON.stringify(PROPERTY_LEDGER);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(COPY_TEXT).not.toContain(word);
  });
});

// ── 5. 人が読む写し ──────────────────────────────────────────────

/** 写しの文書から表を読む（見出しの行の次の区切りの行のあとの、`|` で始まる行） */
function copyTableOf(markdown: string): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  const lines = markdown.split("\n");
  const headerLine = `| ${PROPERTY_COPY_HEADER.join(" | ")} |`;
  const at = lines.indexOf(headerLine);
  if (at < 0) return { header: [], rows: [] };
  const cells = (line: string) => line.slice(1, -1).split(" | ").map((cell) => cell.trim());
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(cells(line.trim()));
  }
  return { header: cells(headerLine), rows };
}

/** 写しとコードの台帳の食い違い（欠け・余り・欄の食い違い） */
function copyDefects(markdown: string, ledger: readonly PropertyRow[]): readonly string[] {
  const table = copyTableOf(markdown);
  const defects: string[] = [];
  if (table.header.length === 0) return ["写しに表の見出しが無い"];
  const expected = ledger.map(propertyCopyCells);
  const ids = new Set(expected.map((cells) => cells[0]));
  for (const cells of expected) {
    const found = table.rows.filter((row) => row[0] === cells[0]);
    if (found.length === 0) defects.push(`写しに ${cells[0]} の行が無い`);
    else if (found.length > 1) defects.push(`写しに ${cells[0]} の行が重なっている`);
    else if (JSON.stringify(found[0]) !== JSON.stringify(cells)) defects.push(`写しの ${cells[0]} の行がコードと違う`);
  }
  for (const row of table.rows) if (!ids.has(row[0] ?? "")) defects.push(`写しに台帳に無い ${row[0] ?? ""} の行がある`);
  if (JSON.stringify(table.rows.map((row) => row[0])) !== JSON.stringify(expected.map((cells) => cells[0]))) {
    defects.push("写しの行の並びが台帳の順と違う");
  }
  return defects;
}

describe("人が読む写し（methodology/ledger/properties.md）がコードの台帳と 1 要素 1 行で一致する（D2）", () => {
  it("写しの表は台帳と同じ行数・同じ並びで、各行の欄がコードから組んだ欄と同じ", () => {
    const table = copyTableOf(COPY_TEXT);
    expect(table.header).toEqual([...PROPERTY_COPY_HEADER]);
    expect(table.rows).toEqual(PROPERTY_LEDGER.map(propertyCopyCells));
    expect(copyDefects(COPY_TEXT, PROPERTY_LEDGER)).toEqual([]);
  });

  it("二点測定：写しから行を 1 つ消すと落ちる", () => {
    const line = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith("| state-after-set |"));
    if (line === undefined) throw new Error("前提が壊れた");
    expect(copyDefects(COPY_TEXT.replace(`${line}\n`, ""), PROPERTY_LEDGER)).toContain("写しに state-after-set の行が無い");
  });

  it("二点測定：写しの行の状態を変えると落ちる（コードの状態を変えても落ちる）", () => {
    const changedCopy = COPY_TEXT.replace("| default-value | 有効 |", "| default-value | 削る候補 |");
    expect(changedCopy).not.toBe(COPY_TEXT);
    expect(copyDefects(changedCopy, PROPERTY_LEDGER)).toEqual(["写しの default-value の行がコードと違う"]);
    const changedCode = PROPERTY_LEDGER.map((row) => (row.id === "default-value" ? { ...row, state: "removal-candidate" as const } : row));
    expect(copyDefects(COPY_TEXT, changedCode)).toEqual(["写しの default-value の行がコードと違う"]);
  });

  it("二点測定：コードに行を足して写しに無いと落ち、写しにだけ行があっても落ちる", () => {
    const added = [...PROPERTY_LEDGER, { ...rowOf("when"), id: "no-such-property" }];
    expect(copyDefects(COPY_TEXT, added)).toContain("写しに no-such-property の行が無い");
    const extraLine = `| ${propertyCopyCells({ ...rowOf("when"), id: "no-such-property" }).join(" | ")} |`;
    const lastRow = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith("| enum-membership |"));
    if (lastRow === undefined) throw new Error("前提が壊れた");
    expect(copyDefects(COPY_TEXT.replace(lastRow, `${lastRow}\n${extraLine}`), PROPERTY_LEDGER)).toContain(
      "写しに台帳に無い no-such-property の行がある",
    );
    // 手 2b の行：写しから enum-membership の行を消すと落ちる
    expect(copyDefects(COPY_TEXT.replace(`${lastRow}\n`, ""), PROPERTY_LEDGER)).toContain("写しに enum-membership の行が無い");
  });
});

// ── 7. 手 2c：empty-aggregate（集計の種類 × データ状態の空の値。Issue #549）──────────────────

describe("empty-aggregate の行：集計の種類 × データ状態の表（一律の「空なら 0」でない）と、T1 の集計の種類の enum が表の順", () => {
  it("行の欄：確かめ方の種類は無く（fixed-test のまま）、組は computation × aggregate、照合は v1 の runTests、外は見ない、T1'' の受理条件の文は無い", () => {
    expect(EMPTY_AGGREGATE.state).toBe("active");
    expect(EMPTY_AGGREGATE.since).toBe("Issue #549");
    expect(EMPTY_AGGREGATE.inherited).toBe(false);
    expect(EMPTY_AGGREGATE.t1).toBeNull();
    expect(EMPTY_AGGREGATE.t2).toBeNull();
    expect(EMPTY_AGGREGATE.t1Acceptance).toBeNull();
    expect(EMPTY_AGGREGATE.rules.t1Acceptance).toBeNull();
    expect(EMPTY_AGGREGATE.combinations).toEqual([{ targetKind: "computation", operation: "aggregate" }]);
    expect(EMPTY_AGGREGATE.evaluation).toBe("v1-run-tests");
    expect(EMPTY_AGGREGATE.outer).toBe(OUTER_NOT_SCORED);
    expect(EMPTY_AGGREGATE.coverageKey).toEqual(DEFAULT_VALUE.coverageKey);
    expect(EMPTY_AGGREGATE.t2Aggregate?.expectedWriter).toBe("llm-written-code-checked");
    expect(EMPTY_AGGREGATE.t2Aggregate?.referenceTargets).toEqual([]);
    expect(EMPTY_AGGREGATE.t2Aggregate?.alsoObserves).toEqual(["value"]);
    // 確かめ方の種類に結び付かない（T1 の種類の enum・R-tsp-02 の除外は変わらない）
    expect(PROPERTY_LEDGER_VIEW.rowByVerificationKind.has("empty-aggregate")).toBe(false);
    for (const row of PROPERTY_LEDGER.filter((entry) => entry.id !== "empty-aggregate")) expect(row.t2Aggregate, row.id).toBeNull();
  });

  it("データ状態：空は boundary、未読は abnormal。値の表：sum・count は空 0・未読 null、avg は空も未読も null（一律の「空なら 0」でない）", () => {
    const t2 = EMPTY_AGGREGATE.t2Aggregate;
    if (t2 === null) throw new Error("前提が壊れた");
    expect(t2.states.map((entry) => [entry.state, entry.kind])).toEqual([
      ["empty", "boundary"],
      ["unread", "abnormal"],
    ]);
    expect(t2.states.map((entry) => entry.state)).toEqual([...AGGREGATE_DATA_STATES]);
    const table = Object.fromEntries(
      t2.values.map((entry) => [entry.aggregate, AGGREGATE_DATA_STATES.map((state) => aggregateStateValueOf(t2, entry.aggregate, state))]),
    );
    expect(table).toEqual({ sum: [0, null], count: [0, null], avg: [null, null] });
    // 表に無い種類は導かない（呼ぶ側が落とす）
    expect(aggregateStateValueOf(t2, "max", "empty")).toBeUndefined();
  });

  it("T1 の計算の行の型の aggregate の種類は表の順（sum・count・avg）。#548 の台帳・手 2a の台帳には無い（schema に欄を足さない）", () => {
    expect(PROPERTY_LEDGER_VIEW.aggregateKinds).toEqual(["sum", "count", "avg"]);
    expect(PROPERTY_LEDGER_VIEW.aggregateRows.map((row) => row.id)).toEqual(["empty-aggregate"]);
    expect(VIEW_2B.aggregateKinds).toEqual([]);
    expect(VIEW_2A.aggregateKinds).toEqual([]);
    // 二点測定：表の順を入れ替えると enum の順も変わる（台帳から導いている）
    const t2 = EMPTY_AGGREGATE.t2Aggregate;
    if (t2 === null) throw new Error("前提が壊れた");
    const reordered = PROPERTY_LEDGER.map((row) =>
      row.id === "empty-aggregate" ? { ...row, t2Aggregate: { ...t2, values: [...t2.values].reverse() } } : row,
    );
    expect(deriveLedgerView(reordered).aggregateKinds).toEqual(["avg", "count", "sum"]);
  });

  it("二点測定：集計の試験の型が表・状態・組と食い違う行は不備になる（今の台帳は通る）", () => {
    const t2 = EMPTY_AGGREGATE.t2Aggregate;
    if (t2 === null) throw new Error("前提が壊れた");
    const patched = (patch: Partial<PropertyRow>) =>
      ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "empty-aggregate" ? { ...row, ...patch } : row)));
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
    expect(patched({ t2Aggregate: { ...t2, states: t2.states.slice(0, 1) } })).toEqual([
      "性質 empty-aggregate の集計の試験の型のデータ状態が、空と未読をちょうど 1 つずつ持たない",
    ]);
    expect(patched({ t2Aggregate: { ...t2, values: [] } })).toEqual(["性質 empty-aggregate の集計の試験の型の種類の表が、空か重なっている"]);
    expect(patched({ t2Aggregate: { ...t2, values: [...t2.values, t2.values[0]!] } })).toEqual([
      "性質 empty-aggregate の集計の試験の型の種類の表が、空か重なっている",
    ]);
    expect(patched({ combinations: [{ targetKind: "computation", operation: "compute" }] })).toEqual([
      "性質 empty-aggregate の集計の試験の型の組が、評価の方法の表の組に無い",
    ]);
  });

  it("規則の文：T1 の文は計算の行に種類と集計元を書く 1 文、T2 の文は空の境界・未読の異常の期待の値、B1 の文は表の行のとおりに書く 1 文。題材の言葉は無い", () => {
    expect(EMPTY_AGGREGATE.rules.t1).toContain("集計の種類（kind：sum は合計・count は件数・avg は平均）と集計元の entity の行の id（entity）を書く");
    expect(EMPTY_AGGREGATE.rules.t2).toContain("emptyEntities");
    expect(EMPTY_AGGREGATE.rules.t2).toContain("sum・count は 0");
    expect(EMPTY_AGGREGATE.rules.t2).toContain("avg は null");
    expect(EMPTY_AGGREGATE.rules.t2).toContain("期待の value を null にする");
    expect(EMPTY_AGGREGATE.rules.t2).toContain("observes は empty-aggregate");
    expect(EMPTY_AGGREGATE.rules.b1).toContain("aggregate の種類（sum・count・avg）と集計元の entity");
    const text = JSON.stringify(EMPTY_AGGREGATE);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
  });

  it("二点測定：写しから empty-aggregate の行を消すと落ち、写しの値の欄を変えても落ちる", () => {
    const line = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith("| empty-aggregate |"));
    if (line === undefined) throw new Error("前提が壊れた");
    expect(copyDefects(COPY_TEXT.replace(`${line}\n`, ""), PROPERTY_LEDGER)).toContain("写しに empty-aggregate の行が無い");
    expect(copyDefects(COPY_TEXT.replace("avg は空 null", "avg は空 zero"), PROPERTY_LEDGER)).toEqual(["写しの empty-aggregate の行がコードと違う"]);
    // 写しの説明に値の表がある（人が読む）
    expect(COPY_TEXT).toContain("〔avg／空〕null");
    expect(COPY_TEXT).toContain("〔どの種類も／未読〕null");
  });
});

// ── 8. 手 2d：when（操作の条件）と non-requirement（要件でない文。Issue #550）──────────────────

describe("when の行：引き継いだ行の未定義の列を埋める（期待は真偽・対象は条件を持つ操作の行）", () => {
  it("行の欄：新しい行は足さず（id は 1 つ）、有効・引き継ぎのまま、要件の決まりの型・T2 の試験の型・外の対応・T2 の規則の文が埋まり、網羅の鍵・T1'' の受理条件は今のまま", () => {
    expect(PROPERTY_LEDGER.filter((row) => row.id === "when")).toHaveLength(1);
    expect(WHEN.state).toBe("active");
    expect(WHEN.inherited).toBe(true);
    expect(WHEN.requirementRule).toBe("操作ができる条件（いつ実行できるか）を決める要件");
    expect(WHEN.t1).toBeNull();
    expect(WHEN.t1Acceptance).toBeNull();
    expect(WHEN.t2).toBeNull();
    expect(WHEN.t2Aggregate).toBeNull();
    expect(WHEN.t2Condition).toEqual({
      targetKind: "operation",
      operation: "action",
      targetFlag: "hasWhen",
      t1Kind: "fixed-test",
      kinds: ["normal", "abnormal", "boundary"],
      expected: { ok: "boolean", error: "condition-fails" },
      input: "record",
      referenceData: "any",
      expectedWriter: "llm-written-code-checked",
      messages: WHEN.t2Condition?.messages,
    });
    expect(WHEN.combinations).toEqual([{ targetKind: "operation", operation: "action" }]);
    expect(WHEN.coverageKey).toBeNull();
    expect(WHEN.evaluation).toBe("v1-run-tests");
    expect(WHEN.outer).toBe("advanceAction");
    expect(WHEN.rules.t1).toBeNull();
    expect(WHEN.rules.t1Acceptance).toBeNull();
    expect(WHEN.rules.b1).toBeNull();
    expect(WHEN.rules.t2).toContain("value を true");
    expect(WHEN.rules.t2).toContain("value を false");
    expect(WHEN.rules.t2).toContain("操作後の状態");
    expect(WHEN.rules.t2).toContain("hasWhen が false の行）に action の試験を作らない");
    // state-after-set は登録済み・未対応のまま
    expect(rowOf("state-after-set").state).toBe("registered-unsupported");
    // 導出：条件の試験の型を持つ行は when だけ。#549 の台帳には無い
    expect(PROPERTY_LEDGER_VIEW.conditionRows.map((row) => row.id)).toEqual(["when"]);
    expect(VIEW_2C.conditionRows).toEqual([]);
    const text = JSON.stringify(WHEN);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
  });

  it("二点測定：条件の試験の型が組・kind と食い違う行は不備になる（今の台帳は通る）", () => {
    const t2 = WHEN.t2Condition;
    if (t2 === null) throw new Error("前提が壊れた");
    const patched = (patch: Partial<PropertyRow>) => ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "when" ? { ...row, ...patch } : row)));
    expect(patched({})).toEqual([]);
    expect(patched({ t2Condition: { ...t2, kinds: [] } })).toEqual(["性質 when の条件の試験の型の kind が、空か重なっている"]);
    expect(patched({ t2Condition: { ...t2, kinds: ["normal", "normal"] } })).toEqual(["性質 when の条件の試験の型の kind が、空か重なっている"]);
    expect(patched({ combinations: [{ targetKind: "field", operation: "validate" }] })).toEqual([
      "性質 when の条件の試験の型の組が、評価の方法の表の組に無い",
    ]);
  });
});

describe("non-requirement の行：決まりも対象の項目も無い説明文。T1'' の受理だけで有効になる", () => {
  it("行の欄：確かめ方の種類 non-requirement（欄なし）・所属 0 行・分類の値は見ない・受理で除く、受理条件の文がある、試験の型・組・網羅・B4 は無い、外は見ない", () => {
    expect(PROPERTY_LEDGER.at(-1)?.id).toBe("non-requirement");
    expect(NON_REQUIREMENT.state).toBe("active");
    expect(NON_REQUIREMENT.inherited).toBe(false);
    expect(NON_REQUIREMENT.since).toBe("Issue #550");
    expect(NON_REQUIREMENT.requirementRule).toBe("決まりも対象の項目も無い説明文（目的を述べる前置きなど）");
    expect(NON_REQUIREMENT.t1?.kind).toBe("non-requirement");
    expect(NON_REQUIREMENT.t1?.valueField).toBeNull();
    expect(NON_REQUIREMENT.t1?.nature).toBeNull();
    expect(NON_REQUIREMENT.t1?.excludeWhenAccepted).toBe(true);
    expect(NON_REQUIREMENT.t1?.ownership).toEqual({ row: null, count: 0, entityAddedByCode: false, valueInOptions: false, optionsNonEmpty: false });
    expect(NON_REQUIREMENT.t1Acceptance).toContain("決まりも対象（項目・計算・集計・操作・画面）も無いときだけ受理する");
    expect(NON_REQUIREMENT.t1Acceptance).toContain("weak-verification");
    expect(NON_REQUIREMENT.t2).toBeNull();
    expect(NON_REQUIREMENT.t2Aggregate).toBeNull();
    expect(NON_REQUIREMENT.t2Condition).toBeNull();
    expect(NON_REQUIREMENT.combinations).toEqual([]);
    expect(NON_REQUIREMENT.coverageKey).toBeNull();
    expect(NON_REQUIREMENT.evaluation).toBeNull();
    expect(NON_REQUIREMENT.outer).toBe(OUTER_NOT_SCORED);
    expect(NON_REQUIREMENT.rules.t1).toContain("kind を non-requirement にし、行を所属させず");
    expect(NON_REQUIREMENT.rules.t1).toContain("要件の出どころ（答えから来た・了承した代替先）では決めない");
    expect(NON_REQUIREMENT.rules.t1Acceptance).toContain("要件 ID の形を受理の理由にしない");
    const text = JSON.stringify(NON_REQUIREMENT);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
  });

  it("導出：確かめ方の種類に入り、観測する性質・評価の方法の表・T2 の除外には入らない（試験を作らない＝一覧から除く）", () => {
    expect(PROPERTY_LEDGER_VIEW.verificationKinds.at(-1)).toBe("non-requirement");
    expect(PROPERTY_LEDGER_VIEW.rowByVerificationKind.get("non-requirement")).toBe(NON_REQUIREMENT);
    expect(PROPERTY_LEDGER_VIEW.excludedWhenAcceptedKinds).toEqual(["non-requirement"]);
    expect(VIEW_2C.excludedWhenAcceptedKinds).toEqual([]);
    expect(PROPERTY_LEDGER_VIEW.observes).not.toContain("non-requirement");
    expect(PROPERTY_LEDGER_VIEW.rowByObserves.has("non-requirement")).toBe(false);
    expect(PROPERTY_LEDGER_VIEW.combinations.some((entry) => entry.observes === "non-requirement")).toBe(false);
    expect(PROPERTY_LEDGER_VIEW.t2ExemptKinds).not.toContain("non-requirement");
    expect(PROPERTY_LEDGER_VIEW.t1RuleTexts.at(-1)).toBe(NON_REQUIREMENT.rules.t1);
    expect(PROPERTY_LEDGER_VIEW.t1AcceptanceTexts.at(-1)).toBe(NON_REQUIREMENT.rules.t1Acceptance);
  });

  it("二点測定：受理で除く確かめ方の行が、行を所属させる・試験の型か組を持つ・照合の名前を持つ・受理条件が無いと不備になる（今の台帳は通る）", () => {
    const t1 = NON_REQUIREMENT.t1;
    if (t1 === null || DEFAULT_VALUE.t2 === null) throw new Error("前提が壊れた");
    const patched = (patch: Partial<PropertyRow>) =>
      ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "non-requirement" ? { ...row, ...patch } : row)));
    expect(patched({})).toEqual([]);
    expect(patched({ t1: { ...t1, ownership: { ...t1.ownership, row: { kind: "field", type: "enum" }, count: 1 } } })).toEqual([
      "性質 non-requirement は受理で除くのに、行を所属させる",
    ]);
    expect(patched({ t1: { ...t1, ownership: { ...t1.ownership, count: 1 } } })).toEqual([
      "性質 non-requirement の所属の形が、行の種類の無いことと所属 0 行で食い違う",
      "性質 non-requirement は受理で除くのに、行を所属させる",
    ]);
    expect(patched({ t2: DEFAULT_VALUE.t2 })).toEqual([
      "性質 non-requirement は受理で除くのに、試験の型か評価の方法の表の組がある",
      "性質 non-requirement の期待は確かめ方の欄の値なのに、確かめ方に欄が無い",
      // 期待の値をコードが書く試験の型には旗 ids の文が要る（Issue #595）
      "性質 non-requirement は期待の値をコードが書くのに、旗 ids の T2 の文が無い",
    ]);
    expect(patched({ combinations: [{ targetKind: "field", operation: "validate" }] })).toEqual([
      "性質 non-requirement は受理で除くのに、試験の型か評価の方法の表の組がある",
    ]);
    expect(patched({ evaluation: "v1-run-tests" })).toEqual(["性質 non-requirement は受理で除くのに、照合の名前がある"]);
    expect(patched({ t1Acceptance: null })).toEqual(["性質 non-requirement は受理で除くのに、受理条件が無い"]);
    expect(patched({ rules: { ...NON_REQUIREMENT.rules, t1Acceptance: null } })).toEqual(["性質 non-requirement は受理で除くのに、受理条件が無い"]);
    // 受理で除かない確かめ方は、試験の型と照合の名前が無ければ今までどおり不備
    expect(patched({ t1: { ...t1, excludeWhenAccepted: false } })).toEqual([
      "性質 non-requirement は有効なのに、照合の名前が無い",
      "性質 non-requirement は確かめ方の種類を持つのに、試験の型が無い",
    ]);
    // 分類を求める記述子に固定文が無い
    expect(patched({ t1: { ...t1, nature: "ruled" } })).toEqual(["性質 non-requirement は分類を求めるのに、固定文が無い"]);
  });

  it("二点測定：写しから when・non-requirement の行を消すと落ち、写しの値の欄を変えても落ちる。行の数は 2c より 1 多い（2a より 3 多い）", () => {
    expect(PROPERTY_LEDGER).toHaveLength(LEDGER_ROWS_2C.length + 1);
    expect(PROPERTY_LEDGER).toHaveLength(LEDGER_2A.length + 3);
    for (const id of ["when", "non-requirement"]) {
      const line = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith(`| ${id} |`));
      if (line === undefined) throw new Error("前提が壊れた");
      expect(copyDefects(COPY_TEXT.replace(`${line}\n`, ""), PROPERTY_LEDGER)).toContain(`写しに ${id} の行が無い`);
    }
    expect(copyDefects(COPY_TEXT.replace("| advanceAction |", "| 未定義 |"), PROPERTY_LEDGER)).toEqual(["写しの when の行がコードと違う"]);
    expect(copyDefects(COPY_TEXT, LEDGER_ROWS_2C)).toEqual([
      "写しの when の行がコードと違う",
      "写しに台帳に無い non-requirement の行がある",
      "写しの行の並びが台帳の順と違う",
    ]);
    expect(COPY_TEXT).toContain("**有効になるのは T1''（独立の点検）が受理したときだけ**");
  });
});

// ── 9. 手 3c：期待の値の書き手（コードが作る試験。Issue #595）──────────────────

describe("期待の値の書き手：default-value・enum-membership は code、empty-aggregate はコードが作る範囲つき（Issue #595）", () => {
  it("行の欄：書き手が code の行は試験の型が空の写像・空の参照データで、旗 ids の T2 の文を持つ。empty-aggregate のコードが作る範囲はアプリ全体と見出しごと × 選択肢で、範囲の外は llm-written-code-checked のまま", () => {
    expect(DEFAULT_VALUE.t2?.expectedWriter).toBe("code");
    expect(ENUM_MEMBERSHIP.t2?.expectedWriter).toBe("code");
    expect(EMPTY_AGGREGATE.t2Aggregate?.codeRanges).toEqual(["app", "groups-enum"]);
    expect(EMPTY_AGGREGATE.t2Aggregate?.expectedWriter).toBe("llm-written-code-checked");
    expect(WHEN.t2Condition?.expectedWriter).toBe("llm-written-code-checked");
    expect(AGGREGATE_RANGES).toEqual(["row", "app", "groups-enum", "groups-month"]);
    for (const row of [DEFAULT_VALUE, ENUM_MEMBERSHIP]) {
      expect(row.t2?.input, row.id).toBe("empty-record");
      expect(row.t2?.referenceTargets, row.id).toEqual([]);
    }
    // 旗 ids の文があるのはコードが作る行だけ。ほかの行は null（今の文をそのまま使う）
    expect(PROPERTY_LEDGER.filter((row) => row.rules.t2Ids !== null).map((row) => row.id)).toEqual(["default-value", "enum-membership", "empty-aggregate"]);
  });

  it("旗 ids の T2 の文：既定値・選択肢の集合は作らない文、空の集計はアプリ全体と見出しごと × 選択肢の境界・異常を作らない文の後ろに今の文（行ごと・月の見出しごとに使う）をそのまま続ける。題材の言葉は無い", () => {
    expect(DEFAULT_VALUE.rules.t2Ids).toContain("試験は作らない");
    expect(DEFAULT_VALUE.rules.t2Ids).toContain("コードが作る");
    expect(ENUM_MEMBERSHIP.rules.t2Ids).toContain("試験は作らない");
    const ids = EMPTY_AGGREGATE.rules.t2Ids ?? "";
    expect(ids).toContain("アプリ全体（type の scope が app）");
    expect(ids).toContain("選択肢の見出しごと（groupBy の kind が enum）");
    expect(ids).toContain("行ごと（type の scope が row）の集計と月の見出しごと（groupBy の kind が month）");
    expect(ids.endsWith(EMPTY_AGGREGATE.rules.t2 ?? "（無い）")).toBe(true);
    const text = JSON.stringify(PROPERTY_LEDGER.map((row) => row.rules.t2Ids));
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
  });

  it("導出：旗 ids の T2 の文の並びは、台帳の T2 の文の並びの各行を旗 ids の文に差し替えたもの（行の数・順は同じ）。旗 ids の文を持たない台帳では同じ", () => {
    const view = PROPERTY_LEDGER_VIEW;
    expect(view.t2IdsFormTexts).toHaveLength(view.t2FormTexts.length);
    const evaluableWithText = PROPERTY_LEDGER.filter((row) => row.state !== "registered-unsupported" && row.rules.t2 !== null);
    expect(view.t2IdsFormTexts).toEqual(evaluableWithText.map((row) => row.rules.t2Ids ?? row.rules.t2));
    expect(view.t2FormTexts).toEqual(evaluableWithText.map((row) => row.rules.t2));
    const withoutIds = deriveLedgerView(PROPERTY_LEDGER.map((row) => ({ ...row, rules: { ...row.rules, t2Ids: null } })).map((row) =>
      row.t2 === null ? row : { ...row, t2: { ...row.t2, expectedWriter: "llm-written-code-checked" as const } },
    ).map((row) => (row.t2Aggregate === null ? row : { ...row, t2Aggregate: { ...row.t2Aggregate, codeRanges: [] } })));
    expect(withoutIds.t2IdsFormTexts).toEqual(withoutIds.t2FormTexts);
  });

  it("二点測定：書き手が code の行の旗 ids の文を消す・入力を空の写像でなくす・コードが作る範囲を重ねる／知らない値にする・範囲を持つのに文を消すと不備になる（今の台帳は通る）", () => {
    const patched = (id: string, patch: (row: PropertyRow) => PropertyRow) => ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === id ? patch(row) : row)));
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
    expect(patched("default-value", (row) => ({ ...row, rules: { ...row.rules, t2Ids: null } }))).toEqual([
      "性質 default-value は期待の値をコードが書くのに、旗 ids の T2 の文が無い",
    ]);
    expect(patched("enum-membership", (row) => (row.t2 === null ? row : { ...row, t2: { ...row.t2, referenceTargets: ["entity"] } }))).toEqual([
      "性質 enum-membership は期待の値をコードが書くのに、入力か参照データが空でない",
    ]);
    const aggregate = EMPTY_AGGREGATE.t2Aggregate;
    if (aggregate === null) throw new Error("前提が壊れた");
    expect(patched("empty-aggregate", (row) => ({ ...row, t2Aggregate: { ...aggregate, codeRanges: ["app", "app"] } }))).toEqual([
      "性質 empty-aggregate の集計の試験の型のコードが作る範囲が、知らない値か重なっている",
    ]);
    expect(patched("empty-aggregate", (row) => ({ ...row, t2Aggregate: { ...aggregate, codeRanges: ["scope" as never] } }))).toEqual([
      "性質 empty-aggregate の集計の試験の型のコードが作る範囲が、知らない値か重なっている",
    ]);
    expect(patched("empty-aggregate", (row) => ({ ...row, rules: { ...row.rules, t2Ids: null } }))).toEqual([
      "性質 empty-aggregate はコードが作る範囲を持つのに、旗 ids の T2 の文が無い",
    ]);
  });

  it("写しの期待の値の書き手の列：default-value・enum-membership は code、empty-aggregate は範囲つき（code の範囲／llm-written-code-checked の範囲）。写しの欄を戻すと落ちる", () => {
    const writerOf = (row: PropertyRow) => propertyCopyCells(row)[PROPERTY_COPY_HEADER.indexOf("期待の値の書き手")];
    expect(writerOf(DEFAULT_VALUE)).toBe("code");
    expect(writerOf(ENUM_MEMBERSHIP)).toBe("code");
    expect(writerOf(EMPTY_AGGREGATE)).toBe("code（アプリ全体・見出しごと × 選択肢）／llm-written-code-checked（行ごと・見出しごと × 月）");
    expect(writerOf(WHEN)).toBe("llm-written-code-checked");
    expect(copyDefects(COPY_TEXT, PROPERTY_LEDGER)).toEqual([]);
    const reverted = COPY_TEXT.replace("| code（アプリ全体・見出しごと × 選択肢）／llm-written-code-checked（行ごと・見出しごと × 月） |", "| llm-written-code-checked |");
    expect(reverted).not.toBe(COPY_TEXT);
    expect(copyDefects(reverted, PROPERTY_LEDGER)).toEqual(["写しの empty-aggregate の行がコードと違う"]);
  });
});
