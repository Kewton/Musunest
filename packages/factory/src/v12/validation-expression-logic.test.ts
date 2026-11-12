// Issue #906：検査の式（validation-expression）の行の規則の 2 セル（rules.t1・rules.t1Acceptance）に、比較を and・or・not で
// 結んだ 1 つの入力の条件を最小限に足す。#902 で #875 の前の文に戻した限定（同じ entity の項目・入力の値を縛る・targets の
// 完全性）は保ち、広い #875 の文（文書の式の文法に委ねる）には戻さない。`requirementRule`・`why`・上位の受理条件は変えない。
//
// 二点測定：
//   (1) 指紋：前の文・#875 の文・変更後の文の 3 つを試験の定数に残し、ids の全体・上流の指紋を等値で照らす。off は変わらない
//   (2) 規則の 2 セル：変更後の文は目的に固定した文とバイト列で同じ。足した句を取り除くと前の文にバイト列で戻る。
//       #875 の句（文書の式の文法のとおり）を含まず、#875 の 2 セルと等値でない。前の文の限定は残る
//   (3) 規則の文：足した句が C2 の通常・了承済み部分ありと C3 の規則の文に入る（変更前の台帳では入らない）。#875 の句は入らない
//   (4) 回帰の守り：追加の場所の検査は、targets の項目だけを参照する and・or・not の式を受け取り、targets の外を参照する式を
//       wrongReference で断る（構文の門は今までどおり）
//   (5) 題材の言葉は無い

import { readSpecDocument } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { validationWorldOfDocument } from "../v11a/bind-by-id.js";
import { nameTableRuleDefinitionsOf, nameTableSchemaOf } from "../v11a/stages/name-table.js";
import { SEMANTIC_CHECK_LEDGER_RULE_ID, semanticCheckRuleDefinitionsOf } from "../v11a/stages/semantic-check.js";
import {
  ADDED_906_PHRASES,
  BASE_IDS_LEDGER_BEFORE_875,
  NEW_875_VALIDATION_EXPRESSION_TEXTS,
  NEW_906_VALIDATION_EXPRESSION_TEXTS,
  OLD_VALIDATION_EXPRESSION_TEXTS,
  UNCHANGED_906_VALIDATION_EXPRESSION_TEXTS,
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
/** #875 の文・#875 の句（変更後の規則の 2 セルにも C2・C3 にも入らない） */
const PHRASE_875 = "文書の式の文法のとおり";
/** 前の文の限定の句（変更後も残る） */
const LIMIT_PHRASE_COMPARISON = "1 つの比較";
const LIMIT_PHRASE_TARGETS = "targets がその決まりが縛る項目と過不足なく合う";
const LIMIT_PHRASE_SCOPE = "式で書けない決まり・項目を縛らない決まり・複数の entity にまたがる項目を含む要件には validation-expression を使わない";
/** 変更後の旗 ids の台帳全体の指紋 */
const IDS_WHOLE_906 = "1d174d9d9029b71b766a0e0096fb757a80d84043779736bc491c9121ee0dc379";
/** 変更後の旗 ids の上流の部分の指紋 */
const IDS_UPSTREAM_906 = "b62f975c58906d1b45ee6279ab1d9b003029efc6cd248e4f00a6caccacf38c84";
/** since だけを #875 の文に戻した旗 ids の台帳全体の指紋（対象の値。ほかの欄・行を変えていないことを縛る） */
const CONTROL_IDS_WHOLE_WITH_875_SINCE = "88cb9daefacf54c66df66e17192aeadb934cb4ae7d3d982d9f025efb7cfe0dfd";

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

describe("(1) 指紋：前の文・#875 の文・変更後の文の 3 つを等値で照らす。off は変わらない", () => {
  it("ids の全体・上流は変更後の固定値。off の全体・上流は今までどおり", async () => {
    const whole = await propertyLedgerSha256(PROPERTY_LEDGER, IDS);
    // #875・#902 の値と違う（足した句と since の履歴の分だけ変わる）
    expect(whole).not.toBe("555f169b3bbd1d6bd1d4032e14e99566e3dbc039710111841b25e3e334a01c3f");
    expect(whole).not.toBe("044963891242397e3120016c9e6e8e1c1daa9b1d0c0be46e767cd2836dbc881e");
    expect(whole).toBe(IDS_WHOLE_906);
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, IDS)).toBe(IDS_UPSTREAM_906);
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("fd0adc6ddc5bf82c48ff8be3930a74fe86f469b623359aedb64af5bdfe1e08f5");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, OFF)).toBe("421d105d258f0d810cc44173edcad4720e391c63760348308f7a97187dd88d42");
  });

  it("since だけを #875 の文に戻すと、旗 ids の台帳全体の指紋が対象の値に等値（ほかの欄・行を変えていない）", async () => {
    expect(await propertyLedgerSha256(withSinceOnly875(), IDS)).toBe(CONTROL_IDS_WHOLE_WITH_875_SINCE);
  });

  it("#875 の文に戻すと #875 の指紋に戻り、前の文に戻すと b511936 の指紋に戻る（3 つの文を定数に残した）", async () => {
    expect(await propertyLedgerSha256(withNew875ValidationExpressionTexts(), IDS)).toBe(
      "044963891242397e3120016c9e6e8e1c1daa9b1d0c0be46e767cd2836dbc881e",
    );
    expect(await upstreamLedgerSha256(withNew875ValidationExpressionTexts(), IDS)).toBe(
      "a24dade1c8030cdfea05f14514a012ffcdf124d14035c370134f16e379264e19",
    );
    // 前の文（#875 の前）に戻すと b511936 の値に戻る
    expect(await propertyLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.ledger);
    expect(await upstreamLedgerSha256(withOldValidationExpressionTexts(), IDS)).toBe(BASE_IDS_LEDGER_BEFORE_875.upstream);
  });
});

describe("(2) 行の文：規則の 2 セルだけが変わり、足した句を取り除くと前の文に戻る。why・requirementRule・上位の受理条件は今までどおり", () => {
  it("rules.t1・rules.t1Acceptance は目的に固定した文とバイト列で同じ。足した句を取り除くと前の文に戻る", () => {
    const row = rowOf();
    expect(row.rules.t1).toBe(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(row.rules.t1Acceptance).toBe(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance);
    // 足した句を取り除くと、前の文（`__tests__/ledger.ts` の前の文の定数）とバイト列で同じ
    expect(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1.replace(ADDED_906_PHRASES.rulesT1, "")).toBe(
      OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1,
    );
    expect(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance.replace(ADDED_906_PHRASES.rulesT1Acceptance, "")).toBe(
      OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance,
    );
    // 前の文の限定の句は残る
    for (const text of [row.rules.t1, row.rules.t1Acceptance]) expect(text).toContain(LIMIT_PHRASE_COMPARISON);
    expect(row.rules.t1).toContain(LIMIT_PHRASE_SCOPE);
    expect(row.rules.t1Acceptance).toContain(LIMIT_PHRASE_TARGETS);
    // #875 の句は含まず、#875 の 2 セルと等値でない
    for (const text of [row.rules.t1, row.rules.t1Acceptance]) {
      expect(text).not.toContain(PHRASE_875);
      expect(text).not.toContain(NEW_PHRASE);
    }
    expect(row.rules.t1).not.toBe(NEW_875_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(row.rules.t1Acceptance).not.toBe(NEW_875_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance);
  });

  it("why・requirementRule・上位の受理条件・ほかの文は今までどおり（#875 の文のまま）", () => {
    const row = rowOf();
    for (const text of [row.why, row.requirementRule, row.t1Acceptance]) {
      expect(text).not.toContain(OLD_PHRASE);
      expect(text).toContain(NEW_PHRASE);
    }
    // since に履歴（2026-11-12・この Issue・前の文の限定を保ち最小の言い足しにした理由）
    expect(row.since).toContain("2026-11-11 の #875");
    for (const marker of ["2026-11-12", "#902", "#906", "rules.t1", "rules.t1Acceptance", "requirementRule", "why", "t1Acceptance", "最小の言い足し"]) {
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
    // 変えない 3 欄は前後でバイト列が同じ（#875 の文のまま）
    expect(row.why).toBe(UNCHANGED_906_VALIDATION_EXPRESSION_TEXTS.why);
    expect(row.requirementRule).toBe(UNCHANGED_906_VALIDATION_EXPRESSION_TEXTS.requirementRule);
    expect(row.t1Acceptance).toBe(UNCHANGED_906_VALIDATION_EXPRESSION_TEXTS.t1Acceptance);
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
  });
});

describe("(3) 規則の文：足した句が旗 ids の C2 の 2 つの形と C3 の規則の文に入り、#875 の句は入らない", () => {
  it("C2 の通常・了承済み部分ありに rules.t1 の句、C3 に rules.t1Acceptance の句が入る。変更前の台帳では入らない（二点測定）", () => {
    const now = { ...c2TextsOf(PROPERTY_LEDGER), c3: c3TextOf(PROPERTY_LEDGER) };
    expect(now.normal).toContain(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(now.accepted).toContain(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1);
    expect(now.c3).toContain(NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance);
    expect(now.normal).toContain(ADDED_906_PHRASES.rulesT1);
    expect(now.accepted).toContain(ADDED_906_PHRASES.rulesT1);
    expect(now.c3).toContain(ADDED_906_PHRASES.rulesT1Acceptance);
    // #875 の句は入らない
    expect(now.normal).not.toContain(NEW_PHRASE);
    expect(now.accepted).not.toContain(NEW_PHRASE);
    expect(now.c3).not.toContain(NEW_PHRASE);
    // 二点測定：変更前の台帳（前の文）から導いた規則の文には、足した句が入らない
    const before = { ...c2TextsOf(withOldValidationExpressionTexts()), c3: c3TextOf(withOldValidationExpressionTexts()) };
    expect(before.normal).not.toContain(ADDED_906_PHRASES.rulesT1);
    expect(before.accepted).not.toContain(ADDED_906_PHRASES.rulesT1);
    expect(before.c3).not.toContain(ADDED_906_PHRASES.rulesT1Acceptance);
    expect(now.normal).not.toEqual(before.normal);
    expect(now.accepted).not.toEqual(before.accepted);
    expect(now.c3).not.toEqual(before.c3);
  });

  it("off と台帳だけ on の T1・T1'' の規則の文は、今の台帳と前の文の台帳でバイト列で同じ（off は検査の式の行を読まない）", () => {
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

/** 規則の定義のうち、前後で text が変わる id */
const changedRuleIds = (
  now: readonly { readonly id: string; readonly text: string }[],
  before: readonly { readonly id: string; readonly text: string }[],
): readonly string[] => now.filter((entry) => before.find((other) => other.id === entry.id)?.text !== entry.text).map((entry) => entry.id);

describe("(3b) 送る規則・schema・データの差は C2 の R-map-03 と C3 の R-sc-02 の文だけ。C1 の規則・schema は変えない", () => {
  it("C2 の 2 つの形と C3 の規則で前後で文が変わるのは R-map-03・R-sc-02 だけ", () => {
    const now = deriveUpstreamLedgerView(PROPERTY_LEDGER, { ...V12_FLAGS_OFF, ids: true });
    const before = deriveUpstreamLedgerView(withOldValidationExpressionTexts(), { ...V12_FLAGS_OFF, ids: true });
    expect(changedRuleIds(mappingRuleDefinitionsOf(now), mappingRuleDefinitionsOf(before))).toEqual(["R-map-03"]);
    expect(changedRuleIds(mappingRuleDefinitionsOf(now, true), mappingRuleDefinitionsOf(before, true))).toEqual(["R-map-03"]);
    expect(changedRuleIds(semanticCheckRuleDefinitionsOf(now, true), semanticCheckRuleDefinitionsOf(before, true))).toEqual(["R-sc-02"]);
  });

  it("C1 の規則・schema は台帳の見方（off・台帳だけ on）から導いて前後でバイト列が同じ（C1 の段のコードは変えない）", () => {
    for (const flags of [V12_FLAGS_OFF, { ...V12_FLAGS_OFF, ledger: true }]) {
      const now = deriveUpstreamLedgerView(PROPERTY_LEDGER, flags);
      const before = deriveUpstreamLedgerView(withOldValidationExpressionTexts(), flags);
      expect(nameTableRuleDefinitionsOf(now)).toEqual(nameTableRuleDefinitionsOf(before));
      expect(nameTableSchemaOf(now)).toEqual(nameTableSchemaOf(before));
    }
  });

  it("台帳の見方のデータ・schema・上限・旗に効く欄は前後で等値（変わるのは検査の式の行の T1 の文と T1'' の受理条件の文だけ）", () => {
    const now = deriveUpstreamLedgerView(PROPERTY_LEDGER, { ...V12_FLAGS_OFF, ids: true });
    const before = deriveUpstreamLedgerView(withOldValidationExpressionTexts(), { ...V12_FLAGS_OFF, ids: true });
    const { t1RuleTexts: _nowT1, t1IdsRuleTexts: _nowIds, t1AcceptanceTexts: _nowAccept, ...nowRest } = now;
    const { t1RuleTexts: _beforeT1, t1IdsRuleTexts: _beforeIds, t1AcceptanceTexts: _beforeAccept, ...beforeRest } = before;
    expect(nowRest).toEqual(beforeRest);
    // 変わるのは検査の式の行の 1 文ずつ（ほかの行の文は同じ）
    expect(now.t1RuleTexts).not.toEqual(before.t1RuleTexts);
    expect(now.t1RuleTexts).toEqual(
      before.t1RuleTexts.map((text) => (text === OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1 ? NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1 : text)),
    );
    expect(now.t1AcceptanceTexts).toEqual(
      before.t1AcceptanceTexts.map((text) =>
        text === OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance ? NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance : text,
      ),
    );
    // off の見方（検査の式の行を読まない）は前後で深く等しい
    expect(deriveUpstreamLedgerView(PROPERTY_LEDGER, V12_FLAGS_OFF)).toEqual(deriveUpstreamLedgerView(withOldValidationExpressionTexts(), V12_FLAGS_OFF));
  });
});

describe("(5) 題材の言葉は無い", () => {
  it("行の文・前の文・#875 の文・旗 ids の規則に題材の言葉が無い", () => {
    const row = rowOf();
    const texts = [
      row.why,
      row.requirementRule,
      row.t1Acceptance,
      row.rules.t1,
      row.rules.t1Acceptance,
      NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1,
      NEW_906_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance,
      NEW_875_VALIDATION_EXPRESSION_TEXTS.rulesT1,
      NEW_875_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance,
      OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1,
      OLD_VALIDATION_EXPRESSION_TEXTS.rulesT1Acceptance,
      ...idsRuleTexts(PROPERTY_LEDGER),
    ];
    for (const text of texts) {
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text ?? "").not.toContain(word);
    }
  });
});
