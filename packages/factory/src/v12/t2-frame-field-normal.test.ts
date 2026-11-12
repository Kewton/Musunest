// Issue #813：旗 `v12.ids` の T2 の必要な試験の枠で、値の対象もコードの試験も無い fixed-test の要件に、所属の項目の行を
// 正常の対象として示す（wave 82 の回帰。枠が空で「要件の試験が無い」が必ず落ちた）。
//
// 二点測定：偽物の LLM・題材に依らない人工の例（行は抽象的な ID）だけを使う。外部の API は呼ばない。
//   (1) 回帰の型の初回の枠：直した後は項目の行に正常 1 本、直す前（base）は空と `ruledExempt`（旧の挙動を試験に残す）
//   (2) 門は変えていない：項目の行に正常 1 本・三種は T2' を通り、0 本は「要件の試験が無い」で落ちる
//   (3) やり直しの枠：採った種類が ruled なら (1) と同じ枝、existence-only の枝は base と同じ
//   (4) 注記の事実：条件の無い操作だけ（対象外）は書ける対象も無い旨、項目を含む免除（コードの試験あり）は base と同じ
//   (5) 負例：値の対象を持つ要件・コードの試験のある免除・fixed-test でない免除は base と同じ
//   (6) R-tsp-02 の ids の文
//   (7) 変異の証跡は、base の組み立て（`baseRuledBranchOf`）との差で固定する
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import { TEST_KINDS } from "../fixed-test.js";
import { AGENT_LIMITS } from "../limits.js";
import type { RequirementList } from "../pipeline.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  casesResponseOf,
  createCheckedRecordingClient,
  fixtureTable,
  recordedStructured,
  retainingT2Client,
  withAggregates,
} from "../v11a/__tests__/fixtures.js";
import { deriveCarryOver } from "../v11a/carry-over.js";
import { nameTableSha256, type NameTable } from "../v11a/names.js";
import { TEST_SPEC_FRAMES_DATA_NAME, runTestSpec, testSpecRuleDefinitionsOf } from "../v11a/stages/test-spec.js";
import { generateTests, type GeneratedTests } from "./generated-tests.js";
import { withOldValidationExpressionTexts } from "./__tests__/ledger.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, fromPublicV12Flags, propertyLedgerSha256, upstreamLedgerSha256 } from "./ledger.js";
import {
  TEST_CASE_FRAME_TEXTS,
  initialTestCaseFramesOf,
  retryTestCaseFramesOf,
  type InitialTestCaseFrame,
  type RetryTestCaseFrame,
} from "./test-cases.js";

const LEDGER = PROPERTY_LEDGER_VIEW;
const LIMIT = AGENT_LIMITS.testsPerRequirement;

const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
type Def = readonly [id: string, text: string, roles: readonly string[], nature: "ruled" | "existence-only"];

/** 要件の定義から、一覧・表（行は題材の表の全行に集計の欄。確かめ方は fixed-test）を組む */
function scenario(defs: readonly Def[]) {
  const list: RequirementList = {
    requirements: defs.map(([id, text]) => ({ id, text, quote: text, position: { start: 0, end: text.length } })),
    decisions: [],
    unresolved: [],
  };
  const table: NameTable = {
    rows: withAggregates(fixtureTable()).rows,
    ownership: defs.map(([requirementId, , roles]) => ({ requirementId, roles: roles.map(stated) })),
    verification: defs.map(([requirementId]) => ({ requirementId, kind: "fixed-test" as const })),
    classification: defs.map(([requirementId, , , nature]) => ({ requirementId, nature })),
  };
  return { list, table };
}

/** 要件の一覧から確定した仕様を組む（段は `plan` の要件を文だけに使う） */
function planOf(list: RequirementList): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v813",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };
}

async function carryOf(list: RequirementList, table: NameTable) {
  const tableSha256 = await nameTableSha256(table);
  return deriveCarryOver({
    list,
    table,
    semanticCheck: { tableSha256, judgments: list.requirements.map(({ id }) => ({ requirementId: id, verdict: "accept" as const })) },
  });
}

interface RawTestOptions {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: string;
  readonly roleId: string;
  readonly kind?: "normal" | "abnormal" | "boundary";
  readonly operation: string;
  readonly observes: string;
  readonly input?: unknown;
  readonly expected?: Record<string, unknown>;
}

/** strict の schema の形の試験 1 件（入力・期待の値は JSON の文字列） */
function rawTest(options: RawTestOptions): Record<string, unknown> {
  const kind = options.kind ?? "normal";
  const errorExpected = kind === "abnormal" && options.operation === "validate";
  return {
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind,
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input ?? {}),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected:
      options.expected ?? (errorExpected ? { kind: "error", value: null, code: "E_INVALID" } : { kind: "ok", value: "1", code: null }),
    assertion: null,
    observes: options.observes,
  };
}

const KINDS = ["normal", "abnormal", "boundary"] as const;

/** 項目（金額）の検査の試験（既定は三種。`kinds` で欠けを作る） */
const fieldTests = (requirementId: string, kinds: readonly ("normal" | "abnormal" | "boundary")[] = KINDS) =>
  kinds.map((kind) =>
    rawTest({
      id: `${requirementId.toLowerCase()}-${kind}`,
      requirementId,
      targetKind: "field",
      roleId: "f.item.amount",
      kind,
      operation: "validate",
      observes: "validation",
      input: { "f.item.amount": kind === "abnormal" ? -1 : 5 },
    }),
  );

/** 段を流す（旗 ids・台帳 on。応答は v1 の形で書き、場合の形に書き換える） */
async function runScenario(materials: ReturnType<typeof scenario>, outputs: readonly unknown[]) {
  const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
  const gateway = makeGateway(retainingT2Client(recording.client), { maxAttempts: 1 });
  const outcome = await runTestSpec({
    plan: planOf(materials.list),
    list: materials.list,
    documents: FIXTURE_DOCUMENTS,
    table: materials.table,
    carryOver: await carryOf(materials.list, materials.table),
    gateway,
    ledger: LEDGER,
    ids: true,
  });
  return { outcome, recording };
}

/** 場合の形の応答（v1 の形の試験の並びを書き換える。場合で書けない材料は使わない） */
const asCases = (outputs: readonly { readonly classifications?: readonly unknown[]; readonly tests: readonly unknown[] }[]) =>
  outputs.map((output) => casesResponseOf(output));

/** 要求から、必要な試験の枠を組む（本番と同じ純粋な関数） */
function initialFrameOf(materials: ReturnType<typeof scenario>, requirementId = "R1"): InitialTestCaseFrame {
  const generated = generateTests({ table: materials.table, ledger: LEDGER, list: materials.list });
  const [frame] = initialTestCaseFramesOf({ table: materials.table, ledger: LEDGER, list: materials.list, generated }, [requirementId]);
  if (frame === undefined) throw new Error("前提が壊れた：枠が無い");
  return frame;
}

/** 要求から、やり直しの枠を組む（採った種類と、組へ足したコードの試験を渡す） */
function retryFrameOf(
  materials: ReturnType<typeof scenario>,
  nature: "ruled" | "existence-only",
  kept: Pick<GeneratedTests, "tests" | "observes"> = { tests: [], observes: new Map() },
  requirementId = "R1",
): RetryTestCaseFrame {
  const [frame] = retryTestCaseFramesOf(
    { table: materials.table, ledger: LEDGER, list: materials.list, natures: new Map([[requirementId, nature]]), kept },
    [requirementId],
    [],
  );
  if (frame === undefined) throw new Error("前提が壊れた：やり直しの枠が無い");
  return frame;
}

/**
 * base（#800 の組み立て）の ruled の枝。免除の集合（値の対象が無い）なら空と `ruledExempt`、そうでなければ三種と値の対象。
 * この Issue で変わる前の挙動を、試験に残す（変異の証跡 (7)）
 */
function baseRuledBranchOf(frame: InitialTestCaseFrame): { readonly kinds: readonly string[]; readonly caseTargets: readonly string[]; readonly note: string } {
  return frame.valueTargets.length === 0
    ? { kinds: [], caseTargets: [], note: TEST_CASE_FRAME_TEXTS.ruledExempt }
    : { kinds: [...TEST_KINDS], caseTargets: frame.valueTargets, note: TEST_CASE_FRAME_TEXTS.ruled };
}

/** 要求の枠（データの塊） */
function framesIn(input: string): readonly (InitialTestCaseFrame & RetryTestCaseFrame)[] {
  const match = new RegExp(`<data name="${TEST_SPEC_FRAMES_DATA_NAME}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error("前提が壊れた：枠の塊が無い");
  return JSON.parse(match[1] ?? "[]") as readonly (InitialTestCaseFrame & RetryTestCaseFrame)[];
}

// ── (1) 回帰の型の初回の枠 ──────────────────────────────────────────────

describe("(1) 回帰の型（項目＋条件の無い create の操作・fixed-test・表の分類 ruled）の初回の枠", () => {
  /** 回帰の型：所属は条件（when）の無い create の操作 1 行と項目 1 行、コードの試験は 0 本 */
  const REGRESSION = scenario([["R1", "金額のある項目の記録を残せる。", ["o.addItem", "f.item.amount"], "ruled"]]);

  it("直した後：ruled の枝は kinds [normal]・caseTargets [所属の項目の行]・新しい固定文", () => {
    const frame = initialFrameOf(REGRESSION);
    expect(frame.codeTests).toEqual([]);
    expect(frame.valueTargets).toEqual([]);
    expect(frame.ifRuled).toEqual({
      kinds: ["normal"],
      caseTargets: ["f.item.amount"],
      note: TEST_CASE_FRAME_TEXTS.ruledNormalOnly,
      codeIfTableRuled: [],
      remaining: LIMIT,
    });
  });

  it("直す前（base）の同じ枠：kinds []・caseTargets []・注記 ruledExempt（旧の挙動として残す）", () => {
    const frame = initialFrameOf(REGRESSION);
    // 旧（#800）の組み立てでは、値の対象が無い要件の ruled の枝を空にし、注記を画面・entity の文のままにしていた
    expect(baseRuledBranchOf(frame)).toEqual({ kinds: [], caseTargets: [], note: TEST_CASE_FRAME_TEXTS.ruledExempt });
    // 変異の証跡 (7)：新しい期待は旧の期待と違う（枠を base の組み立てに戻せば (1) は赤になる）
    expect(frame.ifRuled.kinds).not.toEqual(baseRuledBranchOf(frame).kinds);
    expect(frame.ifRuled.caseTargets).not.toEqual(baseRuledBranchOf(frame).caseTargets);
    expect(frame.ifRuled.note).not.toBe(baseRuledBranchOf(frame).note);
  });
});

// ── (2) 門は変えていない ───────────────────────────────────────────────

describe("(2) T2' の門は変えていない：項目の行に正常 1 本・三種は通り、0 本は「要件の試験が無い」で落ちる", () => {
  const REGRESSION = scenario([["R1", "金額のある項目の記録を残せる。", ["o.addItem", "f.item.amount"], "ruled"]]);
  const classified = [{ requirementId: "R1", nature: "ruled" as const }];

  it("項目の行に正常の場合 1 本を書いた応答は T2' を通る", async () => {
    const { outcome } = await runScenario(REGRESSION, asCases([{ classifications: classified, tests: fieldTests("R1", ["normal"]) }]));
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.suite.tests.filter((test) => test.target.requirementId === "R1")).toHaveLength(1);
  });

  it("0 本の応答は、直した後も「要件の試験が無い」で落ちる（枠が空でも門は緩めない）", async () => {
    // 組全体が空だと「試験の集合が空である」になるので、ほかの要件（コードの在ることの試験を持つ R2）の枠を置く
    const withOther = scenario([
      ["R1", "金額のある項目の記録を残せる。", ["o.addItem", "f.item.amount"], "ruled"],
      ["R2", "題名を持つ。", ["f.item.title"], "ruled"],
    ]);
    const empty = asCases([{ classifications: [...classified, { requirementId: "R2", nature: "ruled" as const }], tests: [] }]);
    // 2 回目（書き直し）も同じ応答にして、門の判定まで届かせる
    const { outcome } = await runScenario(withOther, [...empty, ...empty]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error(`unmet でない：${JSON.stringify(outcome)}`);
    expect(outcome.failure.problems.map((problem) => problem.message)).toContain("要件の試験が無い");
  });

  it("項目の行に三種を書いた応答も通る（直す前と同じ）", async () => {
    const { outcome } = await runScenario(REGRESSION, asCases([{ classifications: classified, tests: fieldTests("R1") }]));
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.suite.tests.filter((test) => test.target.requirementId === "R1")).toHaveLength(3);
  });

  it("要求の枠にも、直した後の枝が載る（偽物の LLM が読む実物）", async () => {
    const { recording } = await runScenario(REGRESSION, asCases([{ classifications: classified, tests: fieldTests("R1", ["normal"]) }]));
    const [frame] = framesIn(recording.structured[0]?.input ?? "");
    expect(frame?.ifRuled).toMatchObject({ kinds: ["normal"], caseTargets: ["f.item.amount"], note: TEST_CASE_FRAME_TEXTS.ruledNormalOnly });
  });
});

// ── (3) やり直しの枠 ───────────────────────────────────────────────────

describe("(3) やり直しの枠：採った種類が ruled なら (1) と同じ枝、existence-only の枝は base と同じ", () => {
  const REGRESSION = scenario([["R1", "金額のある項目の記録を残せる。", ["o.addItem", "f.item.amount"], "ruled"]]);

  it("採った種類が ruled：kinds [normal]・caseTargets [所属の項目の行]・新しい固定文（不足の文は付け方のまま）", () => {
    const frame = retryFrameOf(REGRESSION, "ruled");
    expect(frame).toMatchObject({
      adopted: "ruled",
      kinds: ["normal"],
      caseTargets: ["f.item.amount"],
      maxCases: null,
      note: TEST_CASE_FRAME_TEXTS.ruledNormalOnly,
      missing: [],
      remaining: LIMIT,
    });
  });

  it("existence-only の枝は base と同じ（条件つきの試験は採った種類の枝にだけ載る）", () => {
    const initial = initialFrameOf(REGRESSION);
    const frame = retryFrameOf(REGRESSION, "existence-only");
    const { kinds, caseTargets, maxCases, remaining } = initial.ifExistenceOnly;
    expect({ kinds: frame.kinds, caseTargets: frame.caseTargets, maxCases: frame.maxCases, remaining: frame.remaining }).toEqual({
      kinds,
      caseTargets,
      maxCases,
      remaining,
    });
    expect(frame).toMatchObject({ adopted: "existence-only", kinds: [], caseTargets: [], maxCases: 0, note: TEST_CASE_FRAME_TEXTS.unsupported });
  });
});

// ── (4) 注記の事実 ─────────────────────────────────────────────────────

describe("(4) 注記の事実：fixed-test でコードの試験 0 本の免除の要件だけ、ruled の枝の注記を事実に合わせる", () => {
  it("所属が条件の無い操作だけ（観測外の反例 (c)。対象外）：kinds・caseTargets は空のまま、注記だけ「値の対象も書ける対象も無い」", () => {
    const operationOnly = scenario([["R1", "金額のある項目の記録を残せる。", ["o.addItem"], "ruled"]]);
    const frame = initialFrameOf(operationOnly);
    expect(frame.codeTests).toEqual([]);
    expect(frame.valueTargets).toEqual([]);
    expect(frame.ifRuled).toEqual({
      kinds: [],
      caseTargets: [],
      note: TEST_CASE_FRAME_TEXTS.ruledNoWritableTarget,
      codeIfTableRuled: [],
      remaining: LIMIT,
    });
    // 注記は「値の対象」と「書ける対象」の事実だけを言い、値の対象が無い理由を画面・entity に求めない
    expect(TEST_CASE_FRAME_TEXTS.ruledNoWritableTarget).toContain("値の対象");
    expect(TEST_CASE_FRAME_TEXTS.ruledNoWritableTarget).toContain("書ける対象");
  });

  it("所属が項目だけ・画面＋項目・entity＋項目（コードの在ることの試験あり）の枠は base とバイト列で同じ（注記 ruledExempt のまま）", () => {
    for (const roles of [
      ["f.item.amount"],
      ["s.items", "f.item.title"],
      ["e.item", "f.item.amount"],
    ] as const) {
      const materials = scenario([["R1", "金額か題名を持つ。", roles, "ruled"]]);
      const frame = initialFrameOf(materials);
      expect(frame.codeTests.length, roles.join("+")).toBeGreaterThan(0);
      expect(JSON.stringify(frame.ifRuled), roles.join("+")).toBe(
        JSON.stringify({
          kinds: [],
          caseTargets: [],
          note: TEST_CASE_FRAME_TEXTS.ruledExempt,
          codeIfTableRuled: [],
          remaining: LIMIT - frame.codeTests.length,
        }),
      );
      expect(baseRuledBranchOf(frame).note, roles.join("+")).toBe(TEST_CASE_FRAME_TEXTS.ruledExempt);
    }
  });
});

// ── (5) 負例（base と同じ枠のまま）─────────────────────────────────────

describe("(5) 負例：値の対象を持つ要件・コードの試験のある免除・fixed-test でない免除は base と同じ枠のまま", () => {
  it("値の対象（計算の行）を持つ要件の ruled の枝は三種と値の対象のまま", () => {
    const materials = scenario([["R1", "全体の率を見られる。", ["c.rate"], "ruled"]]);
    const frame = initialFrameOf(materials);
    expect(frame.valueTargets).toEqual(["c.rate"]);
    expect(frame.ifRuled).toEqual({
      kinds: [...TEST_KINDS],
      caseTargets: ["c.rate"],
      note: TEST_CASE_FRAME_TEXTS.ruled,
      codeIfTableRuled: [],
      remaining: LIMIT - frame.codeTests.length,
    });
    expect(frame.ifRuled).toEqual({ ...baseRuledBranchOf(frame), codeIfTableRuled: [], remaining: LIMIT - frame.codeTests.length });
  });

  it("コードの試験が 1 本以上ある免除の要件の枠は ruledExempt のまま（x2: 変異は (4) の 2 つ目を赤にする）", () => {
    const materials = scenario([["R1", "金額を持つ。", ["f.item.amount"], "ruled"]]);
    const frame = initialFrameOf(materials);
    expect(frame.codeTests.length).toBeGreaterThan(0);
    expect(frame.ifRuled.note).toBe(TEST_CASE_FRAME_TEXTS.ruledExempt);
  });

  it("確かめ方が fixed-test でない免除の要件（所属に項目の行があり、コードの試験が 0 本でも）は ruledExempt のまま", () => {
    const base = scenario([["R1", "金額を持つ。", ["f.item.amount"], "ruled"]]);
    const table: NameTable = { ...base.table, verification: [{ requirementId: "R1", kind: "structural", reason: "構造で確かめる", checks: [] }] };
    const generated: GeneratedTests = { tests: [], observes: new Map(), excludedRequirementIds: [], stopped: [], existenceOnlyTestIds: new Set() };
    const [frame] = initialTestCaseFramesOf({ table, ledger: LEDGER, list: base.list, generated }, ["R1"]);
    if (frame === undefined) throw new Error("前提が壊れた：枠が無い");
    expect(frame.codeTests).toEqual([]);
    expect(frame.valueTargets).toEqual([]);
    expect(frame.ifRuled).toMatchObject({ kinds: [], caseTargets: [], note: TEST_CASE_FRAME_TEXTS.ruledExempt });
  });
});

// ── (6) R-tsp-02 の ids の文 ───────────────────────────────────────────

describe("(6) R-tsp-02 の ids の文：免除の事実に合わせ、上限の文で終わる。off と台帳だけ on の文は base と同じ", () => {
  const idsText = () => testSpecRuleDefinitionsOf(LEDGER, true).find((definition) => definition.id === "R-tsp-02")?.text ?? "";
  const ledgerOnlyText = () => testSpecRuleDefinitionsOf(LEDGER, false).find((definition) => definition.id === "R-tsp-02")?.text ?? "";
  const offText = () => testSpecRuleDefinitionsOf(undefined).find((definition) => definition.id === "R-tsp-02")?.text ?? "";
  const limitText = `要件ごとの試験は、コードが作った分を含めて ${String(LIMIT)} 本まで。必要な試験の枠の残る本数（remaining）を超えて場合を書かない。`;

  it("新しい文は「所属が画面・entity の行だけの要件は三種を求めない（枠が空）」を含まず、免除の事実と上限の文で終える", () => {
    const text = idsText();
    expect(text).not.toContain("所属が画面・entity の行だけの要件は三種を求めない（枠が空）");
    expect(text).toContain("値の対象が無い要件は三種を求めない。そのうち枠に項目の行が示された要件は、その行に正常の場合を 1 本以上書く。");
    expect(text.endsWith(limitText)).toBe(true);
    // since に本 Issue を足し、why は off と同じ
    const ids = testSpecRuleDefinitionsOf(LEDGER, true).find((definition) => definition.id === "R-tsp-02");
    expect(ids?.since).toContain("#813");
    expect(ids?.why).toBe(testSpecRuleDefinitionsOf(undefined).find((definition) => definition.id === "R-tsp-02")?.why);
  });

  it("off の文と台帳だけ on の文は base と同じ", () => {
    expect(offText()).toBe("確かめ方が structural・default-value の要件を除いて、決まりを含む要件は、決まりの対象ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。");
    expect(ledgerOnlyText()).toBe(
      "確かめ方が structural・default-value・enum-membership の要件を除いて、決まりを含む要件は、決まりの対象ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
    );
    expect(ledgerOnlyText()).not.toContain("#813");
  });
});

// ── 台帳の指紋（off は #813 の受入条件「base と同じ」のまま。ids on は #816 で変わる）──────

describe("台帳の全体・上流の指紋（off は base と同じ。ids on は #816 で変わる）", () => {
  it("off の全体・上流を直す前（base）の値と等値で照らす。ids on は #816 で変わり、#806 の値は `${...}_806` に残す", async () => {
    const off = fromPublicV12Flags({});
    const ids = fromPublicV12Flags({ ids: true });
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, off)).toBe("fd0adc6ddc5bf82c48ff8be3930a74fe86f469b623359aedb64af5bdfe1e08f5");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, off)).toBe("421d105d258f0d810cc44173edcad4720e391c63760348308f7a97187dd88d42");
    // Issue #816：R2（ids の上流の指紋を段が受ける見方から組む）と R3（検査の式の行の B1 の文）で ids on の 2 つの値が変わる。
    // 旧の値（#806 の後）は `_806` に残し、#816 の値と違うことを照らす
    const base806 = {
      ledger: "bfb08678980fa71aa03b1ad012a9a397ebcefa73b404c8fcb52943157eb86d5d",
      upstream: "22b8b846038207ed3acbcde92a7f64fbb3f3e843ebe2a11835fb9a9f8c275a71",
    };
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, ids)).not.toBe(base806.ledger);
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, ids)).not.toBe(base806.upstream);
    // #816 の値（台帳の試験（ledger.test.ts）と CLI の試験（cli.test.ts）の定数と同じ）
    // Issue #832：検査の式の行の旗 ids の T2 の文を null と書く形に直したので、ids の全体の指紋だけが変わる
    // （旧の #816 の値 fac851157… は、T2 の文を旧の文に戻すと等値になる。ledger.test.ts の (3) で照らす）
    // Issue #875：検査の式の行の文を文書の式の文法に委ねたので、ids の全体・上流の指紋が変わる。旧の文に戻すと #832 の後の値
    // （65c1f276…・dc21dd01…）に戻る
    // Issue #902：規則の 2 セルだけを #875 の前の文に戻したので、ids の全体は変わり（since の履歴を足すため）、上流は
    // b511936 の値（dc21dd01…）に戻る。旧の文に戻す照合（下の 2 行）は今までどおり
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, ids)).toBe("555f169b3bbd1d6bd1d4032e14e99566e3dbc039710111841b25e3e334a01c3f");
    expect(await upstreamLedgerSha256(PROPERTY_LEDGER, ids)).toBe("dc21dd0177557eec5af22eafe2355a41f99884ab4e063d6745e30ae9c554c110");
    expect(await propertyLedgerSha256(withOldValidationExpressionTexts(), ids)).toBe("65c1f276c2f72cc7fbe947397ee214da740dcdbd1680bdd001f61f889d141487");
    expect(await upstreamLedgerSha256(withOldValidationExpressionTexts(), ids)).toBe("dc21dd0177557eec5af22eafe2355a41f99884ab4e063d6745e30ae9c554c110");
  });
});

// ── 題材の言葉が無い（要求・試験・fixture）────────────────────────────

describe("題材の言葉は無い", () => {
  it("枠の固定文・新しい試験の値に、題材の言葉が無い", () => {
    const materials = scenario([["R1", "金額のある項目の記録を残せる。", ["o.addItem", "f.item.amount"], "ruled"]]);
    const frame = initialFrameOf(materials);
    expectNoAcceptanceMaterial([JSON.stringify(TEST_CASE_FRAME_TEXTS), JSON.stringify(frame), JSON.stringify(testSpecRuleDefinitionsOf(LEDGER, true))]);
  });
});
