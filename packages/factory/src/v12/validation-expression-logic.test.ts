// Issue #902：2026-11-12 の計測で、#875 が受理の条件を「文書の式の文法に委ねる」文に変えたあと P2 の成績が下がった。
// 所有者の決定で、検査の式（validation-expression）の行の規則の 2 セル（rules.t1・rules.t1Acceptance）だけを #875 の
// 前（b511936）の文に戻す。`requirementRule`・`why`・上位の受理条件は #875 の文のまま（since に履歴を足す）。
//
// 二点測定：
//   (1) 指紋：since だけを #875 の文に戻すと、旗 ids の台帳全体の指紋が対照の値 d4af4ab… に等値（ほかの欄・行を変えて
//       いないことを 1 本で縛る。requirementRule・why を 1 字変える変異で赤になることを一時的に確かめた）。ids の上流の
//       指紋は b511936 の値に戻り、off の全体・上流は変わらない。#875 の文に戻すと #875 の値（0449638…・a24dade1…）に戻る
//   (2) 規則の文：旗 ids の C2 の 2 つの形（通常・了承済み部分あり）と C3 の規則の文が、b511936 の規則の文とバイト列で同じ
//   (3) 回帰の守り：追加の場所の検査は、targets の項目だけを参照する and・or・not の式を受け取り、targets の外の項目を
//       参照する式を wrongReference で断る（受理の範囲の検査は今までどおり）
//   (4) 題材の言葉は無い

import { readSpecDocument } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { validationWorldOfDocument } from "../v11a/bind-by-id.js";
import { nameTableRuleDefinitionsOf } from "../v11a/stages/name-table.js";
import { SEMANTIC_CHECK_LEDGER_RULE_ID, semanticCheckRuleDefinitionsOf } from "../v11a/stages/semantic-check.js";
import {
  BASE_IDS_LEDGER_BEFORE_875,
  NEW_875_VALIDATION_EXPRESSION_TEXTS,
  OLD_VALIDATION_EXPRESSION_TEXTS,
  withNew875ValidationExpressionTexts,
  withOldValidationExpressionTexts,
  withSinceOnly875,
} from "./__tests__/ledger.js";
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
/** #875 の文が委ねる先（文書の式の文法）を述べる句 */
const NEW_PHRASE = "同じ entity の項目だけを参照する 1 つの検査の式で書ける決まり（書き方は文書の式の文法のとおり）";
/** since だけを #875 の文に戻した旗 ids の台帳全体の指紋（対照の値。ほかの欄・行を変えていないことを縛る） */
const CONTROL_IDS_WHOLE_WITH_875_SINCE = "d4af4ab1970275c7fae258cd37167c5c2253bcf3d5bcf8ac4884e6f3fb37f80b";

const rowOf = (rows: readonly PropertyRow[] = PROPERTY_LEDGER): PropertyRow => {
  const row = rows.find((entry) => entry.id === "validation-expression");
  if (row === undefined) throw new Error("前提が壊れた：検査の式の行が無い");
  return row;
};

const ruleOf = (definitions: readonly { readonly id: string; readonly text: string }[], id: string): string => {
  const definition = definitions.find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`前提が壊れた：規則 ${id} が無い`);
  return definition.text;
};

/** 旗 ids の C2 の 2 つの形（通常・了承済み部分あり）の規則の文 */
const c2TextsOf = (rows: readonly PropertyRow[]): { readonly normal: string; readonly accepted: string } => {
  const view = deriveUpstreamLedgerView(rows, { ...V12_FLAGS_OFF, ids: true });
  return {
    normal: ruleOf(mappingRuleDefinitionsOf(view), "R-map-03"),
    accepted: ruleOf(mappingRuleDefinitionsOf(view, true), "R-map-03"),
  };
};

/** 旗 ids の C3 の規則の文 */
const c3TextOf = (rows: readonly PropertyRow[]): string => {
  const view = deriveUpstreamLedgerView(rows, { ...V12_FLAGS_OFF, ids: true });
  return ruleOf(semanticCheckRuleDefinitionsOf(view, true), SEMANTIC_CHECK_LEDGER_RULE_ID);
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

describe("(1) 指紋：ids の上流は b511936 の値に戻り、全体は新しい値。off は変わらない", () => {
  it("ids の全体は新しい固定値、上流は b511936 の値に戻る。off の全体・上流は今までどおり", async () => {
    const whole = await propertyLedgerSha256(PROPERTY_LEDGER, IDS);
    expect(whole).not.toBe(BASE_IDS_LEDGER_BEFORE_875.ledger);
    expect(whole).toBe("555f169b3bbd1d6bd1d4032e14e99566e3dbc039710111841b25e3e334a01c3f");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.upstream);
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("fd0adc6ddc5bf82c48ff8be3930a74fe86f469b623359aedb64af5bdfe1e08f5");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("421d105d258f0d810cc44173edcad4720e391c63760348308f7a97187dd88d42");
  });

  it("since だけを #875 の文に戻すと、旗 ids の台帳全体の指紋が対照の値に等値（ほかの欄・行を変えていない）", async () => {
    expect(await propertyLedgerSha256(withSinceOnly875(), IDS)).toBe(CONTROL_IDS_WHOLE_WITH_875_SINCE);
  });

  it("#875 の文（since と規則の 2 セル）に戻すと、旗 ids の全体・上流の指紋が #875 の値に戻る（#875 の文を試験の定数に残した）", async () => {
    expect(await propertyLedgerSha256(withNew875ValidationExpressionTexts(), IDS)).toBe(
      "044963891242397e3120016c9e6e8e1c1daa9b1d0c0be46e767cd2836dbc881e",
    );
    expect(await upstreamLedgerSha256(withNew875ValidationExpressionTexts(), IDS)).toBe(
      "a24dade1c8030cdfea05f14514a012ffcdf124d14035c370134f16e379264e19",
    );
    // 旧の文（#875 の前）に戻すと b511936 の値に戻る（今までどおり）
    expect(await propertyLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.ledger);
    expect(await upstreamLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.upstream);
  });
});

describe("(2) 行の文：規則の 2 セルだけが #875 の前の文に戻り、why・requirementRule・上位の受理条件は #875 の文のまま", () => {
  it("rules.t1・rules.t1Acceptance は b511936 の文とバイト列で同じ。why・requirementRule・t1Acceptance は今までどおり", () => {
    const row = rowOf();
    expect(row.rules.t1).toBe(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(row.rules.t1Acceptance).toBe(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance);
    for (const text of [row.why, row.requirementRule, row.t1Acceptance]) {
      expect(text).not.toContain(OLD_PHRASE);
      expect(text).toContain(NEW_PHRASE);
    }
    for (const text of [row.rules.t1, row.rules.t1Acceptance]) {
      expect(text).toContain(OLD_PHRASE);
      expect(text).not.toContain(NEW_PHRASE);
    }
    // since に履歴（2026-11-12・この Issue・規則の 2 セルだけを戻し、requirementRule・why・上位の受理条件は #875 のまま）
    expect(row.since.startsWith(NEW_875_VALIDATION_EXPRESSION_TEXTS.since.slice(0, -1))).toBe(true);
    expect(row.since).toContain("2026-11-11 の #875");
    for (const marker of ["2026-11-12", "#902", "rules.t1", "rules.t1Acceptance", "requirementRule", "why", "t1Acceptance"]) {
      expect(row.since).toContain(marker);
    }
    // 変えない欄（B1・T2 の文・所属の形・targets の検査・T2 の型）
    const old = rowOf(withOldValidationExpressionTexts());
    expect(row.rules.b1).toBe(old.rules.b1);
    expect(row.rules.t2).toBe(old.rules.t2);
    expect(row.rules.t2Ids).toBe(old.rules.t2Ids);
    expect(row.t1).toEqual(old.t1);
    expect(row.t2Validation).toEqual(old.t2Validation);
    expect(row.combinations).toEqual(old.combinations);
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
  });
});

describe("(3) 規則の文：旗 ids の C2 の 2 つの形と C3 の規則の文が b511936 の文とバイト列で同じ", () => {
  it("C2 の通常・了承済み部分ありの 2 つの形と C3 の文が、#875 の前の台帳から導いた文と等値。規則の 2 セルを差し込む", () => {
    const now = { ...c2TextsOf(PROPERTY_LEDGER), c3: c3TextOf(PROPERTY_LEDGER) };
    const before = { ...c2TextsOf(withOldValidationExpressionTexts()), c3: c3TextOf(withOldValidationExpressionTexts()) };
    expect(now).toEqual(before);
    expect(now.normal).toContain(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(now.accepted).toContain(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(now.c3).toContain(OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance);
    expect(now.normal).not.toContain(NEW_PHRASE);
    expect(now.accepted).not.toContain(NEW_PHRASE);
    expect(now.c3).not.toContain(NEW_PHRASE);
  });

  it("off と台帳だけ on の T1・T1'' の規則の文は、今の台帳と旧の文の台帳でバイト列で同じ", () => {
    expect(offRuleTexts(PROPERTY_LEDGER)).toEqual(offRuleTexts(withOldValidationExpressionTexts()));
  });
});

/** 追加の場所の本文（検査 1 つ） */
const body = (expression: string): string => ["- name: bounded", "  entity: item", `  expression: ${expression}`].join("\n");

describe("(4) 回帰の守り：追加の場所の検査は and・or・not の式を受け取り、targets の外を参照する式を wrongReference で断る", () => {
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

describe("(5) 題材の言葉は無い", () => {
  it("行の文・旧の文・旗 ids の規則に題材の言葉が無い", () => {
    const row = rowOf();
    for (const text of [row.why, row.requirementRule, row.t1Acceptance, row.rules.t1, row.rules.t1Acceptance, ...idsRuleTexts(PROPERTY_LEDGER)]) {
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text ?? "").not.toContain(word);
    }
  });
});
