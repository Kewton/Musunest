// Issue #875（原因 1）：性質の台帳の検査の式（validation-expression）の行が、受理の条件を文書の旧い文法（式＝比較 1 つ）の
// 言い換え「入力の値を 1 つの比較で縛る」で写していた。文書が式の結合（and・or・not）を許したあと写しが追従せず、範囲や
// 「どちらか」の決まりを検査の式に選ぶことを妨げていた。行の文を文書の式の文法に委ねる文に直す（旧の文は試験の定数に残す）。
//
// 二点測定：偽物も外部の API も使わない（台帳・規則の文・追加の場所の形の検査は純粋な関数）。
//   (1) 指紋：今の文では旗 ids の全体・上流の指紋が base（417e14f）から変わり、旧の文に戻すと base の値に戻る。off は変わらない
//   (2) 規則の文：旗 ids の C2・C3（と T1・T1''）へ送る文に「1 つの比較」が無く、新しい文が入る。旧の文に戻すと「1 つの比較」が入る。
//       off の要求はバイト列で同じ
//   (3) 回帰の守り：追加の場所の検査は、targets の項目だけを参照する and・or・not の式を受け取り、targets の外の項目を参照する式を
//       wrongReference で断る（受理の範囲だけを文書の文法に合わせ、targets の検査は残す）
//   (4) 題材の言葉は無い

import { readSpecDocument } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { validationWorldOfDocument } from "../v11a/bind-by-id.js";
import { nameTableRuleDefinitionsOf } from "../v11a/stages/name-table.js";
import { semanticCheckRuleDefinitionsOf } from "../v11a/stages/semantic-check.js";
import { BASE_IDS_LEDGER_BEFORE_875, OLD_VALIDATION_EXPRESSION_TEXTS, withOldValidationExpressionTexts } from "./__tests__/ledger.js";
import {
  PROPERTY_LEDGER,
  V12_FLAGS_OFF,
  deriveUpstreamLedgerView,
  fromPublicV12Flags,
  ledgerRowDefects,
  propertyLedgerSha256,
  upstreamLedgerSha256,
  type PropertyRow,
} from "./ledger.js";
import { FIELD_REPAIR_PROBLEMS, checkFieldRepairAnswer } from "./stages/field-repair.js";
import { mappingRuleDefinitionsOf } from "./stages/mapping.js";

const IDS = fromPublicV12Flags({ ids: true });
const OFF = fromPublicV12Flags({});
const OLD_PHRASE = "1 つの比較";
/** 新しい文が委ねる先（文書の式の文法）を述べる句 */
const NEW_PHRASE = "同じ entity の項目だけを参照する 1 つの検査の式で書ける決まり（書き方は文書の式の文法のとおり）";

const rowOf = (rows: readonly PropertyRow[] = PROPERTY_LEDGER): PropertyRow => {
  const row = rows.find((entry) => entry.id === "validation-expression");
  if (row === undefined) throw new Error("前提が壊れた：検査の式の行が無い");
  return row;
};

/** 旗 ids の C2・C3・T1・T1'' へ送る規則の文（台帳の行の文を差し込む規則だけでなく、規則の全文） */
const idsRuleTexts = (rows: readonly PropertyRow[]): readonly string[] => {
  const view = deriveUpstreamLedgerView(rows, { ...V12_FLAGS_OFF, ids: true });
  return [
    ...mappingRuleDefinitionsOf(view),
    ...semanticCheckRuleDefinitionsOf(view, true),
    ...nameTableRuleDefinitionsOf(view),
  ].map((definition) => definition.text);
};

/** off（と台帳だけ on）の T1・T1'' へ送る規則の文 */
const offRuleTexts = (rows: readonly PropertyRow[]): readonly string[] => {
  const views = [deriveUpstreamLedgerView(rows, V12_FLAGS_OFF), deriveUpstreamLedgerView(rows, { ...V12_FLAGS_OFF, ledger: true })];
  return views.flatMap((view) => [...nameTableRuleDefinitionsOf(view), ...semanticCheckRuleDefinitionsOf(view)].map((definition) => definition.text));
};

describe("(1) 指紋：旗 ids の全体・上流は変わり、旧の文に戻すと base（417e14f）に戻る。off は変わらない", () => {
  it("今の文では ids の全体・上流の指紋が base と違い、旧の文に戻すと base と等値", async () => {
    const whole = await propertyLedgerSha256(PROPERTY_LEDGER, IDS);
    const upstream = await upstreamLedgerSha256(PROPERTY_LEDGER, IDS);
    expect(whole).not.toBe(BASE_IDS_LEDGER_BEFORE_875.ledger);
    expect(upstream).not.toBe(BASE_IDS_LEDGER_BEFORE_875.upstream);
    // 取り直した今の値（台帳の試験・CLI の試験の定数と同じ）
    expect(whole).toBe("044963891242397e3120016c9e6e8e1c1daa9b1d0c0be46e767cd2836dbc881e");
    expect(await propertyLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.ledger);
    expect(await upstreamLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.upstream);
  });

  it("off の全体・上流の指紋は base と同じ（検査の式の行は旗 ids の行で、off の適用行に入らない）", async () => {
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("fd0adc6ddc5bf82c48ff8be3930a74fe86f469b623359aedb64af5bdfe1e08f5");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("421d105d258f0d810cc44173edcad4720e391c63760348308f7a97187dd88d42");
    expect(await propertyLedgerSha256(withOldValidationExpressionTexts(), OFF)).toBe(await propertyLedgerSha256(PROPERTY_LEDGER, OFF));
  });

  it("行の文は文書の式の文法に委ね、since に履歴（日付・この Issue）を持つ。B1・T2 の文・所属の形・targets の検査は変えない。台帳の点検は不備 0", () => {
    const row = rowOf();
    const old = rowOf(withOldValidationExpressionTexts());
    for (const text of [row.why, row.requirementRule, row.t1Acceptance, row.rules.t1, row.rules.t1Acceptance]) {
      expect(text).not.toContain(OLD_PHRASE);
      expect(text).toContain(NEW_PHRASE);
    }
    expect(row.since).toContain("Issue #800");
    expect(row.since).toContain("#875");
    expect(row.since).toContain("2026-11-11");
    // 変えない欄（B1・T2 の文・所属の形・targets の検査・T2 の型）
    expect(row.rules.b1).toBe(old.rules.b1);
    expect(row.rules.t2).toBe(old.rules.t2);
    expect(row.rules.t2Ids).toBe(old.rules.t2Ids);
    expect(row.t1).toEqual(old.t1);
    expect(row.t2Validation).toEqual(old.t2Validation);
    expect(row.combinations).toEqual(old.combinations);
    // 旧の文は旧の言い換えを持つ（試験の定数が旧の文であることの確かめ）
    expect(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1).toContain(OLD_PHRASE);
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
  });
});

describe("(2) 規則の文：旗 ids の C2・C3（と T1・T1''）に「1 つの比較」が無く、新しい文が入る。off はバイト列で同じ", () => {
  it("今の文：旗 ids の規則に旧の言い換えが無く、T1 の文と T1'' の受理条件の文が入る", () => {
    const texts = idsRuleTexts(PROPERTY_LEDGER).join("\n");
    expect(texts).not.toContain(OLD_PHRASE);
    expect(texts).toContain(rowOf().rules.t1 ?? "前提が壊れた");
    expect(texts).toContain(rowOf().rules.t1Acceptance ?? "前提が壊れた");
    // C2（写像）と C3（点検）のそれぞれに入る
    const view = deriveUpstreamLedgerView(PROPERTY_LEDGER, { ...V12_FLAGS_OFF, ids: true });
    expect(mappingRuleDefinitionsOf(view).map((definition) => definition.text).join("\n")).toContain(NEW_PHRASE);
    expect(semanticCheckRuleDefinitionsOf(view, true).map((definition) => definition.text).join("\n")).toContain(NEW_PHRASE);
  });

  it("赤：旧の文に戻すと旗 ids の規則に「1 つの比較」が入る", () => {
    expect(idsRuleTexts(withOldValidationExpressionTexts()).join("\n")).toContain(OLD_PHRASE);
  });

  it("off と台帳だけ on の T1・T1'' の規則の文は、旧の文の台帳とバイト列で同じ", () => {
    expect(offRuleTexts(PROPERTY_LEDGER)).toEqual(offRuleTexts(withOldValidationExpressionTexts()));
    expect(offRuleTexts(PROPERTY_LEDGER).join("\n")).not.toContain(NEW_PHRASE);
  });
});

/** 追加の場所の本文（検査 1 つ） */
const body = (expression: string): string => ["- name: bounded", "  entity: item", `  expression: ${expression}`].join("\n");

describe("(3) 回帰の守り：追加の場所の検査は and・or・not の式を受け取り、targets の外を参照する式を wrongReference で断る", () => {
  const SOURCE = [
    "entities:",
    "  - name: item",
    "    fields:",
    "      low:",
    "        type: number",
    "      high:",
    "        type: number",
    "      extra:",
    "        type: number",
    "validations: []",
    "actions: []",
    "views: []",
    "permissions: []",
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");
  const KEY = "validation:item.low+high";
  const read = readSpecDocument(SOURCE);
  if (!read.ok) throw new Error("前提が壊れた：宣言が読めない");
  const context = {
    locations: [KEY],
    spans: [],
    source: SOURCE,
    testIds: new Set<string>(),
    additions: [{ key: KEY, entity: "item", targets: ["low", "high"] }],
    world: validationWorldOfDocument(read.document as Record<string, unknown>),
    takenNames: new Set(["item", "low", "high", "extra"]),
  };
  const answer = (expression: string) => ({ replacements: [{ location: KEY, element: body(expression) }], disputes: [] });

  it.each(["low >= 0 and high <= 100", "low > 0 or high > 0", "not (low > 0 or high > 0)", "not (low > high) and high <= 100"])(
    "targets の項目だけを参照する式 %s を受け取る",
    (expression) => {
      expect(checkFieldRepairAnswer(answer(expression), context)).toEqual({
        ok: true,
        value: { replacements: [{ location: KEY, element: body(expression) }], disputes: [], rejected: [] },
      });
    },
  );

  it.each(["low >= 0 and extra <= 100", "low > 0 or extra > 0", "not (high > 0 or extra > 0)", "low >= 0 and high <= 100 and extra > 0"])(
    "targets の外の項目を参照する式 %s を wrongReference で断る",
    (expression) => {
      expect(checkFieldRepairAnswer(answer(expression), context)).toEqual({
        ok: false,
        problems: [{ field: "replacements[0].element", message: FIELD_REPAIR_PROBLEMS.wrongReference }],
      });
    },
  );
});

describe("(4) 題材の言葉は無い", () => {
  it("行の新しい文・旗 ids の規則に題材の言葉が無い", () => {
    const row = rowOf();
    for (const text of [row.why, row.requirementRule, row.t1Acceptance, row.rules.t1, row.rules.t1Acceptance, ...idsRuleTexts(PROPERTY_LEDGER)]) {
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text ?? "").not.toContain(word);
    }
  });
});
