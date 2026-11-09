// Issue #832：旗 `v12.ids` の T2 で、検査の式の台帳の行の文が、場合の observes に schema の enum に無い
// validation-expression を肯定で書かせていた矛盾を直す（項目の行は null と書き、コードが確かめ方から埋める）。
//
// 二点測定：偽物の LLM・題材に依らない人工の表（行は抽象的な ID）だけを使う。外部の API は呼ばない。
//   (1) 文の矛盾：旗 ids の T2 の文に、schema の enum に無い性質を肯定で書かせる指示が 0 件。旧の文に戻すと 1 件で赤
//   (2) 新しい文：null と書くこと・targets の項目の行から対象を選ぶことを述べる（等値で固定）。off と台帳だけ on は base と同じ
//   (3) 門を保つ：observes が null は validation-expression に展開され T2' を通り、value は observesLegacy で落ち、
//       validation-expression は形（enum）で落ちる。fixed-test の条件つき操作の value は今までどおり落ちる
//   (4) schema：場合の schema の observes の enum が base（value・empty-aggregate・null）と等値
//   (5) 指紋：ids の全体の指紋は変わる。T2 の文を旧に戻すと base（#816）の値に戻り、off・上流は変わらない
//   (6) 要求：ids の T2 の要求（R-tsp-16）は、旧の文に戻す復元で base の指紋と等値。off と台帳だけ on は base と同じ
//   (7) 題材の言葉は無い
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { fixtureTable } from "../v11a/__tests__/fixtures.js";
import type { NameTable } from "../v11a/names.js";
import { checkEvaluabilityByLedger, checkTestSpecOutput, testSpecRuleDefinitionsOf } from "../v11a/stages/test-spec.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import {
  PROPERTY_LEDGER,
  PROPERTY_LEDGER_VIEW,
  PROPERTY_LEDGER_VIEW_IDS,
  deriveLedgerView,
  fromPublicV12Flags,
  propertyLedgerSha256,
  upstreamLedgerSha256,
  type PropertyRow,
} from "./ledger.js";
import {
  TEST_CASE_EXPAND_MESSAGES,
  checkTestCasesOutput,
  computationObservesOf,
  expandTestCases,
  testCasesSchemaOf,
} from "./test-cases.js";

const IDS = fromPublicV12Flags({ ids: true });
const LEDGER_IDS = PROPERTY_LEDGER_VIEW_IDS;

const rowOf = (id: string): PropertyRow => {
  const row = PROPERTY_LEDGER.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`前提が壊れた：行が無い ${id}`);
  return row;
};

/** Issue #832 の前の検査の式の行の旗 ids の T2 の文（旧の文は消さずに試験の定数に残す） */
const OLD_VALIDATION_EXPRESSION_T2 =
  "場合の観測する性質（observes）は、確かめ方が validation-expression の要件の項目・entity の行の場合だけ validation-expression と書き、対象（targetId）はその要件の targets の項目の行から選ぶ。確かめ方がこの種類でない要件の項目・entity の行の場合は validation-expression と書かない。";

/** Issue #832 の後の検査の式の行の旗 ids の T2 の文（等値で固定する） */
const NEW_VALIDATION_EXPRESSION_T2 =
  "確かめ方が validation-expression の要件は、その targets の項目（field）の行に場合を書く（対象（targetId）はその要件の targets の項目の行から選ぶ）。その場合の観測する性質（observes）は null と書く。validation-expression はコードが確かめ方から埋めるので、どの場合にも observes を validation-expression と書かない。確かめ方がこの種類でない要件の項目・entity の行の場合も、observes は null と書く。";

const withOldT2 = (rows: readonly PropertyRow[] = PROPERTY_LEDGER): readonly PropertyRow[] =>
  rows.map((row) => (row.id === "validation-expression" ? { ...row, rules: { ...row.rules, t2Ids: OLD_VALIDATION_EXPRESSION_T2 } } : row));

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** 場合の observes の enum に入ってよい値（計算の行の性質と null）。これ以外を肯定で書かせてはいけない */
const AFFIRMATIVE_ALLOWED = new Set<string>([...computationObservesOf(LEDGER_IDS), "null"]);
const PROPERTY_IDS = PROPERTY_LEDGER.map((row) => row.id);

/**
 * 文が「性質 ID と書き」「性質 ID と書く」の肯定で指示している、enum に無い性質の ID。negative の「と書かない」は許す
 * （`と書[きく]` は `と書かな` に一致しない）
 */
const affirmativeNonEnumIds = (text: string): readonly string[] =>
  PROPERTY_IDS.filter(
    (id) => !AFFIRMATIVE_ALLOWED.has(id) && new RegExp(`(?<![A-Za-z0-9-])${escape(id)}(?![A-Za-z0-9-])[^。]{0,16}と書[きく]`, "u").test(text),
  );

// ── (1) 文の矛盾 ───────────────────────────────────────────────────

describe("(1) 旗 ids の T2 の文：場合の schema の enum に無い性質を肯定で書かせる指示が 0 件", () => {
  it("今の旗 ids の T2 の文は 0 件（negative の「と書かない」は許す）", () => {
    const texts = LEDGER_IDS.t2IdsFormTexts;
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.flatMap(affirmativeNonEnumIds)).toEqual([]);
  });

  it("変異：旧の文に戻した台帳では、検査の式の 1 件で赤になる", () => {
    const restored = deriveLedgerView(withOldT2(), IDS);
    expect(restored.t2IdsFormTexts.flatMap(affirmativeNonEnumIds)).toEqual(["validation-expression"]);
  });
});

// ── (2) 新しい文 ───────────────────────────────────────────────────

describe("(2) 新しい文：null と書くこと・targets の項目の行から対象を選ぶことを述べる。off と台帳だけ on は base と同じ", () => {
  it("検査の式の行の文は固定の文に等しく、null・targets の項目の行・肯定の validation-expression の不在を述べる", () => {
    const text = rowOf("validation-expression").rules.t2Ids;
    expect(text).toBe(NEW_VALIDATION_EXPRESSION_T2);
    expect(text).toContain("observes）は null と書く");
    expect(text).toContain("targets の項目の行から選ぶ");
    expect(text).not.toMatch(/validation-expression と書[きく]/u);
    // 旧の文は使っていない（旧の文は試験の定数にだけ残す）
    expect(text).not.toBe(OLD_VALIDATION_EXPRESSION_T2);
  });

  it("off と台帳だけ on の R-tsp-16 は base と同じ（検査の式の行の文は ids の見方だけに入る）", async () => {
    const off = testSpecRuleDefinitionsOf().find((definition) => definition.id === "R-tsp-16")?.text ?? "";
    const ledgerOnly = testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, false).find((definition) => definition.id === "R-tsp-16")?.text ?? "";
    expect(await sha256Hex(off)).toBe("f5c637495623376d647f70b27e7a588527e3e28fb76830020796702093cc1378");
    expect(await sha256Hex(ledgerOnly)).toBe("01aa4cb158ab5e174119228caf6b6dfb07da53bdbb76976bbc740fe5e5c13e73");
    expect(off).not.toContain(NEW_VALIDATION_EXPRESSION_T2);
    expect(ledgerOnly).not.toContain(NEW_VALIDATION_EXPRESSION_T2);
  });
});

// ── (3) 門を保つ ───────────────────────────────────────────────────

/** 題材の表（R1 は検査の式で f.item.title を縛る。R3 は fixed-test） */
const TABLE: NameTable = (() => {
  const base = fixtureTable();
  return {
    ...base,
    verification: base.verification.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", kind: "validation-expression" as const, targets: ["f.item.title"] } : entry,
    ),
  };
})();

const rawCase = (patch: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  requirementId: "R1",
  targetId: "f.item.title",
  kind: "normal",
  observes: null,
  input: { rowId: "row-1", values: "{}" },
  targetRowId: null,
  rows: [],
  expected: { kind: "ok", value: "true" },
  emptyEntities: [],
  ...patch,
});

/** 形の検査を通した場合の応答（通らなければ前提が壊れた） */
const shaped = (raw: Record<string, unknown>) => {
  const checked = checkTestCasesOutput({ classifications: [], cases: [raw] }, LEDGER_IDS);
  if (!checked.ok) throw new Error(`前提が壊れた：形に落ちた ${JSON.stringify(checked.problems)}`);
  return checked.value;
};

describe("(3) 門を保つ：直す前と後で同じ判定", () => {
  it("observes が null：validation-expression に展開され、T2' を通る", () => {
    const expanded = expandTestCases(shaped(rawCase()), TABLE, LEDGER_IDS);
    if (!expanded.ok) throw new Error(`通るはず：${JSON.stringify(expanded.problems)}`);
    const checked = checkTestSpecOutput(expanded.output, LEDGER_IDS);
    if (!checked.ok) throw new Error(`通るはず：${JSON.stringify(checked.problems)}`);
    const { suite, observes } = checked.value;
    expect(observes.get(suite.tests[0]?.id ?? "")).toBe("validation-expression");
    expect(checkEvaluabilityByLedger(suite, observes, TABLE, LEDGER_IDS)).toEqual([]);
  });

  it("observes が value：observesLegacy で落ち、補われない（#653 の門を緩めない）", () => {
    const expanded = expandTestCases(shaped(rawCase({ observes: "value" })), TABLE, LEDGER_IDS);
    expect(expanded.ok).toBe(false);
    if (expanded.ok) throw new Error("落ちるはず");
    expect(expanded.problems.map((problem) => problem.message)).toContain(TEST_CASE_EXPAND_MESSAGES.observesLegacy);
  });

  it("observes が validation-expression：形の検査（enum）で落ちる", () => {
    const checked = checkTestCasesOutput({ classifications: [], cases: [rawCase({ observes: "validation-expression" })] }, LEDGER_IDS);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("落ちるはず");
    expect(checked.problems.map((problem) => problem.message)).toContain(
      "観測する性質は value・empty-aggregate のいずれか（計算の行の場合）か null であること",
    );
  });

  it("確かめ方が fixed-test の要件の条件つき操作の行に value：今までどおり落ちる", () => {
    const expanded = expandTestCases(
      shaped(rawCase({ requirementId: "R3", targetId: "o.closeItem", observes: "value" })),
      TABLE,
      LEDGER_IDS,
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) throw new Error("落ちるはず");
    expect(expanded.problems.map((problem) => problem.message)).toContain(TEST_CASE_EXPAND_MESSAGES.observesLegacy);
  });
});

// ── (4) schema ─────────────────────────────────────────────────────

describe("(4) 場合の schema：observes の enum は base（value・empty-aggregate・null）と等値", () => {
  it("enum は base と同じで、validation-expression を含まない", () => {
    const observes = testCasesSchemaOf(LEDGER_IDS).properties.cases.items.properties.observes;
    expect(observes.enum).toEqual(["value", "empty-aggregate", null]);
    expect([...observes.enum]).toEqual([...computationObservesOf(LEDGER_IDS), null]);
    expect(observes.enum).not.toContain("validation-expression");
  });
});

// ── (5)(6) 指紋・要求 ──────────────────────────────────────────────

describe("(5)(6) 指紋と要求：ids の全体は変わり、T2 の文を旧に戻すと base に戻る。off・上流は変わらない", () => {
  it("(5) ids の全体の指紋は #816 の値から変わり、T2 の文を戻すと #816 の値に等値。off の全体・上流と ids の上流は base と同じ", async () => {
    const off = fromPublicV12Flags({});
    const now = await propertyLedgerSha256(PROPERTY_LEDGER, IDS);
    expect(now).toBe("65c1f276c2f72cc7fbe947397ee214da740dcdbd1680bdd001f61f889d141487");
    // Issue #816 の値（この Issue の前）。T2 の文だけを旧の文に戻すとこの値に戻る
    const base816 = "fac851157c424650e597a3fe8c8e0b4156ec983c835d7f3e90b1f147284d27e4";
    expect(now).not.toBe(base816);
    expect(await propertyLedgerSha256(withOldT2(), IDS)).toBe(base816);
    // off の全体・上流と ids の上流は変えない（上流の見方は T2 の文を読まない）
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, off)).toBe("fd0adc6ddc5bf82c48ff8be3930a74fe86f469b623359aedb64af5bdfe1e08f5");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, off)).toBe("421d105d258f0d810cc44173edcad4720e391c63760348308f7a97187dd88d42");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, IDS)).toBe("dc21dd0177557eec5af22eafe2355a41f99884ab4e063d6745e30ae9c554c110");
  });

  it("(6) ids の T2 の要求（R-tsp-16）の指紋は変わり、旧の文に戻す復元で base の指紋と等値", async () => {
    const textOf = (ledger: typeof LEDGER_IDS): string =>
      testSpecRuleDefinitionsOf(ledger, true).find((definition) => definition.id === "R-tsp-16")?.text ?? "";
    const now = await sha256Hex(textOf(LEDGER_IDS));
    expect(now).toBe("e7c3415339348d4298f23183cbcbe597e94fb49bd358a0e91ca47487c86299b3");
    // 旧の文に戻すと base（この Issue の前）の要求の指紋に戻る
    expect(await sha256Hex(textOf(deriveLedgerView(withOldT2(), IDS)))).toBe(
      "7ceb6c5181cb49ce4ab15a0f51d703e9fa8971dfd7b3a6484e099a825484733d",
    );
  });
});

// ── (7) 題材の言葉は無い ───────────────────────────────────────────

describe("(7) 題材の言葉は無い", () => {
  it("新しい文・旧の文・旗 ids の T2 の文の全部に、題材の言葉が無い", () => {
    expectNoAcceptanceMaterial([
      NEW_VALIDATION_EXPRESSION_T2,
      OLD_VALIDATION_EXPRESSION_T2,
      JSON.stringify(LEDGER_IDS.t2IdsFormTexts),
    ]);
  });
});
