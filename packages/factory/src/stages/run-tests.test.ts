// ⑤b 試験を流す（stages/run-tests.ts）の unit テスト（02 §1・§1.3・F-9・R-8）。
//
// ここで固定したいのは 5 つ。
//   1. 使う評価器の 7 種類（計算の値・検査・操作の条件・印・アプリ全体の集計・見出しごとの集計・精算）を、
//      それぞれ流して**一致と不一致**を判定すること
//   2. 入力の型と操作の実行の試験は、流さずに未解決として数え、合格にしないこと
//   3. 存在しない entity を指す試験は、評価器が空の結果を返しても合格にならないこと
//   4. 結び付けられない試験は不一致として数えること
//   5. 前半から持ち越した未達（別 file：pipeline.test.ts）と合わせて、⑦ が合格にしないこと
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { evaluateRecord, fixedClock, normalizeSpec } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { checkTestSuite, type TestSuite } from "../fixed-test.js";
import { decideOutcome } from "../outcome.js";
import {
  toStageResults,
  type CorrespondenceEntry,
  type CorrespondenceResult,
  type FixedTest,
  type ReferenceRow,
  type RequirementClassification,
  type RoleNameMapping,
  type TestExpected,
  type TestTarget,
} from "../pipeline.js";
import { bindTests } from "./bind.js";
import { resolveReferenceEntity, runTests } from "./run-tests.js";

const CLOCK = "2026-09-16T12:00:00+09:00";

/** 手で書いた宣言（抽象的な題材。受入の題材の言葉は使わない）。7 種類の評価器をすべて使う */
const DECLARATION_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "      status:",
  "        type: enum",
  "        options:",
  "          open: 未処理",
  "          closed: 完了",
  "        default: open",
  "  - name: person",
  "    fields:",
  "      name: string",
  "  - name: payment",
  "    fields:",
  "      amount: number",
  "      payer:",
  "        type: ref",
  "        to: person",
  "      shares:",
  "        type: list",
  "        of: person",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [amount, total]",
  "  - name: board",
  "    type: board",
  "    entity: record",
  "    columns: status",
  "    highlight: isOpen",
  "  - name: dashboard",
  "    type: dashboard",
  "    widgets:",
  "      - type: number",
  "        value: grandTotal",
  "      - type: bar",
  "        value: byStatus",
  "  - name: settlement",
  "    type: settlement",
  "    entity: person",
  "actions:",
  "  - name: add",
  "    entity: record",
  "    kind: create",
  "  - name: close",
  "    entity: record",
  "    kind: update",
  "    set:",
  "      status: closed",
  '    when: status == "open"',
  "validations:",
  "  - name: positive",
  "    entity: record",
  "    expression: amount > 0",
  "computed:",
  "  - name: total",
  "    entity: record",
  "    expression: amount * 2",
  "    type: number",
  "  - name: isOpen",
  "    entity: record",
  '    expression: status == "open"',
  "    type: boolean",
  "  - name: grandTotal",
  "    scope: app",
  "    aggregate:",
  "      sum: record.amount",
  "    type: number",
  "  - name: byStatus",
  "    aggregate:",
  "      count: record",
  "      groupBy: record.status",
  "    type: groups",
  "  - name: settlement",
  "    entity: person",
  "    settle:",
  "      expense: payment",
  "      amount: amount",
  "      payer: payer",
  "      shares: shares",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(" / ")}`);
  }
  return result.app;
};

const APP = await normalized(DECLARATION_SOURCE);

const target = (requirementId: string, kind: TestTarget["kind"], role: string): TestTarget => ({
  requirementId,
  kind,
  role,
});

const refRow = (
  requirementId: string,
  role: string,
  values: Readonly<Record<string, unknown>>,
): ReferenceRow => ({ target: target(requirementId, "entity", role), values });

const entry = (
  requirementId: string,
  locations: readonly CorrespondenceEntry["locations"][number][],
): CorrespondenceEntry => ({ requirementId, locations });

/**
 * 対応表（コードが確かめた後のもの）。要件 ID ごとに、場所を 1 つに決められるように並べてある。
 * R-5〜R-8 は、参照データの対象を実在の entity に結び付けるためにも使う。
 */
const correspondence: CorrespondenceResult = {
  entries: [
    entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
    entry("R-2", [{ kind: "validation", entity: "record", name: "positive" }]),
    entry("R-3", [{ kind: "action", entity: "record", name: "close" }]),
    entry("R-4", [{ kind: "computation", entity: "record", name: "isOpen" }]),
    entry("R-5", [
      { kind: "computation", entity: null, name: "grandTotal" },
      { kind: "entity", entity: null, name: "record" },
    ]),
    entry("R-6", [
      { kind: "computation", entity: null, name: "byStatus" },
      { kind: "entity", entity: null, name: "record" },
    ]),
    entry("R-7", [
      { kind: "computation", entity: "person", name: "settlement" },
      { kind: "entity", entity: null, name: "person" },
    ]),
    entry("R-8", [{ kind: "entity", entity: null, name: "payment" }]),
    entry("R-9", [{ kind: "field", entity: "record", name: "amount" }]),
    entry("R-10", [{ kind: "entity", entity: null, name: "record" }]),
    entry("R-11", [{ kind: "computation", entity: "ghost", name: "ghostTotal" }]),
  ],
  misses: [],
};

/** 1 件の試験の下書き（省略した欄は既定で埋める） */
interface Draft {
  readonly id: string;
  readonly target: TestTarget;
  readonly operation: FixedTest["operation"];
  readonly input?: unknown;
  readonly referenceData?: readonly ReferenceRow[];
  readonly expected: TestExpected;
}

const draft = (over: Draft): Record<string, unknown> => ({
  kind: "normal",
  clock: CLOCK,
  input: {},
  referenceData: [],
  ...over,
});

function suiteOf(tests: readonly unknown[]): TestSuite {
  const checked = checkTestSuite(tests);
  if (!checked.ok) {
    throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  }
  return checked.suite;
}

const runOne = (test: Record<string, unknown>) =>
  runTests({ app: APP, suite: suiteOf([test]), correspondence });

/** 一致する（不一致も未解決も出ない）ことを確かめる */
function expectMatch(test: Record<string, unknown>): void {
  const result = runOne(test);
  expect({ mismatches: result.mismatches, unresolved: result.unresolved }).toEqual({
    mismatches: [],
    unresolved: [],
  });
}

/** 不一致になる（その試験の id が挙がる）ことを確かめる */
function expectMismatch(test: Record<string, unknown>): void {
  const result = runOne(test);
  expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual([String(test["id"])]);
}

// ── 1. 使う評価器（7 種類） ──────────────────────────────────────

describe("使う評価器（02 §1・§1.3）", () => {
  it("計算の値：evaluateRecord の computed を期待と比べる", () => {
    const base: Draft = {
      id: "compute",
      target: target("R-1", "computation", "合計を出す計算"),
      operation: "compute",
      input: { amount: 21 },
      expected: { kind: "ok", value: 42 },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, expected: { kind: "ok", value: 43 } }));
  });

  it("検査：evaluateRecord の validations を期待と比べる", () => {
    const base: Draft = {
      id: "validate",
      target: target("R-2", "entity", "正の額の検査"),
      operation: "validate",
      input: { amount: -1 },
      expected: { kind: "error", code: "positive" },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, expected: { kind: "ok", value: null } }));
  });

  it("操作の条件：allowsAction を期待と比べる", () => {
    const base: Draft = {
      id: "action",
      target: target("R-3", "operation", "閉じる操作"),
      operation: "action",
      input: { status: "open" },
      expected: { kind: "ok", value: true },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, expected: { kind: "ok", value: false } }));
  });

  it("印：holdsExpression を期待と比べる", () => {
    const base: Draft = {
      id: "mark",
      target: target("R-4", "computation", "未処理の印"),
      operation: "screen",
      input: { status: "open" },
      expected: { kind: "ok", value: true },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, input: { status: "closed" } }));
  });

  it("アプリ全体の集計：evaluateScope を期待と比べる", () => {
    const rows = [refRow("R-5", "記録する行", { amount: 10 }), refRow("R-5", "記録する行", { amount: 20 })];
    const base: Draft = {
      id: "app",
      target: target("R-5", "computation", "全体の合計"),
      operation: "aggregate",
      referenceData: rows,
      expected: { kind: "ok", value: 30 },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, expected: { kind: "ok", value: 31 } }));
  });

  it("見出しごとの集計：groupValuesOf を期待と比べる", () => {
    const rows = [
      refRow("R-6", "記録する行", { status: "open" }),
      refRow("R-6", "記録する行", { status: "closed" }),
      refRow("R-6", "記録する行", { status: "open" }),
    ];
    const base: Draft = {
      id: "groups",
      target: target("R-6", "computation", "状態ごとの件数"),
      operation: "aggregate",
      referenceData: rows,
      expected: {
        kind: "ok",
        value: [
          { heading: "open", value: 2 },
          { heading: "closed", value: 1 },
        ],
      },
    };
    expectMatch(draft(base));
    expectMismatch(
      draft({
        ...base,
        expected: {
          kind: "ok",
          value: [
            { heading: "open", value: 1 },
            { heading: "closed", value: 2 },
          ],
        },
      }),
    );
  });

  it("精算：settleEntity を期待と比べる", () => {
    const rows = [
      refRow("R-7", "人", {}),
      refRow("R-7", "人", {}),
      refRow("R-7", "人", {}),
      refRow("R-8", "支払い", { amount: 1000, payer: "person-1", shares: ["person-1", "person-2", "person-3"] }),
    ];
    const base: Draft = {
      id: "settle",
      target: target("R-7", "computation", "精算"),
      operation: "compute",
      referenceData: rows,
      expected: {
        kind: "ok",
        value: [
          { from: "person-2", to: "person-1", amount: 333 },
          { from: "person-3", to: "person-1", amount: 333 },
        ],
      },
    };
    expectMatch(draft(base));
    expectMismatch(draft({ ...base, expected: { kind: "ok", value: [] } }));
  });
});

// ── 2. 未解決（評価器で確かめられない試験） ──────────────────────

describe("入力の型と操作の実行は、未解決として数え、合格にしない（02 §1.3・U-G）", () => {
  const inputType = draft({
    id: "input-type",
    target: target("R-9", "field", "金額の項目"),
    operation: "compute",
    expected: { kind: "ok", value: 0 },
  });
  const actionExecution = draft({
    id: "action-exec",
    target: target("R-10", "entity", "記録する行"),
    operation: "action",
    expected: { kind: "ok", value: 0 },
  });

  it("どちらも未解決に数え、不一致には数えない", () => {
    const result = runTests({ app: APP, suite: suiteOf([inputType, actionExecution]), correspondence });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["input-type", "action-exec"]);
  });

  it("未解決が残るかぎり、⑦ は合格（full）にしない", () => {
    const result = runTests({ app: APP, suite: suiteOf([inputType, actionExecution]), correspondence });
    const stage = toStageResults({
      staticCheckPassed: true,
      correspondenceMisses: 0,
      testMismatches: result.mismatches.length,
      testUnresolved: result.unresolved.length,
      unwritableRequirements: 0,
      limitReached: false,
      carriedOver: { reverseCheck: [], testSuite: [] },
    });
    expect(decideOutcome(stage).verdict).not.toBe("full");
  });
});

// ── 3. 存在しない entity・結び付けられない試験 ──────────────────

describe("結び付けと実在（02 §1・R-8）", () => {
  it("存在しない entity を指す試験は、評価器が空の結果を返しても合格にならない", () => {
    // 前提：評価器は存在しない entity にも空の結果を返す（R-8）
    const empty = evaluateRecord({ app: APP, entity: "ghost", record: {}, clock: fixedClock(CLOCK) });
    expect(empty).toEqual({ computed: {}, validations: [] });

    const ghost = draft({
      id: "ghost",
      target: target("R-11", "computation", "存在しない合計"),
      operation: "compute",
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({ app: APP, suite: suiteOf([ghost]), correspondence });
    expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual(["ghost"]);
    expect(result.mismatches[0]?.detail).toContain("ghostTotal");
  });

  it("種類が当たる場所が無い selector は、不一致として数える", () => {
    const unmatched = draft({
      id: "unmatched",
      target: target("R-9", "computation", "当たらない計算"),
      operation: "compute",
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({ app: APP, suite: suiteOf([unmatched]), correspondence });
    expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual(["unmatched"]);
  });
});

// ── 4. 提出された対応（③ の提出）で結び付ける（02 §1.3・R2-6・Issue #308）──

/** 役割 ID で対象を指す selector */
const roleTarget = (requirementId: string, kind: TestTarget["kind"], roleId: string): TestTarget => ({
  requirementId,
  kind,
  roleId,
});

describe("参照の entity は、提出された対応で結び付く（02 §1.3・R2-6・Issue #308）", () => {
  it("対応表の先頭の entity ではなく、提出された対応の名前を使う", () => {
    const table: CorrespondenceResult = {
      entries: [
        entry("R-7", [
          { kind: "entity", entity: null, name: "person" },
          { kind: "entity", entity: null, name: "payment" },
          { kind: "computation", entity: "person", name: "settlement" },
        ]),
      ],
      misses: [],
    };
    const mappings: readonly RoleNameMapping[] = [
      { roleId: "person", name: "person" },
      { roleId: "payment", name: "payment" },
    ];
    const rowTarget = roleTarget("R-7", "entity", "payment");

    // 提出された対応があれば、参照の entity は payment に結び付く
    expect(
      resolveReferenceEntity(rowTarget, { app: APP, suite: suiteOf([]), correspondence: table, mappings }),
    ).toBe("payment");
    // 対応が無ければ、対応表の先頭の entity（person）を採る古い経路になる
    expect(resolveReferenceEntity(rowTarget, { app: APP, suite: suiteOf([]), correspondence: table })).toBe("person");
  });
});

describe("同じ種類の場所が複数あっても、提出された対応が無ければ未解決にする（02 §1.3・Issue #308）", () => {
  it("view の場所が 4 個で対応が無ければ、不一致ではなく未解決に数える", () => {
    const table: CorrespondenceResult = {
      entries: [
        entry("R-30", [
          { kind: "view", entity: "record", name: "listA" },
          { kind: "view", entity: "record", name: "listB" },
          { kind: "view", entity: "record", name: "listC" },
          { kind: "view", entity: "record", name: "listD" },
        ]),
      ],
      misses: [],
    };
    const only = suiteOf([
      draft({
        id: "v",
        target: roleTarget("R-30", "screen", "record.list"),
        operation: "screen",
        expected: { kind: "ok", value: null },
      }),
    ]);
    const result = runTests({ app: APP, suite: only, correspondence: table, mappings: [] });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["v"]);
    expect(result.routes[0]?.route).toBe("ambiguity");
  });
});

// ── 5. 評価の方法は、対象の種類 × 操作で決める（02 §1.3・Issue #308）──────

/** 要件ごとの種類（②' の独立の分類）を付けた試験の組 */
function suiteWithClassifications(
  tests: readonly unknown[],
  classifications: readonly RequirementClassification[],
): TestSuite {
  const checked = checkTestSuite(tests);
  if (!checked.ok) throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return { tests: checked.suite.tests, classifications };
}

describe("評価の方法の表（02 §1.3・Issue #308）", () => {
  const methodCorrespondence: CorrespondenceResult = {
    entries: [
      entry("R-3", [{ kind: "entity", entity: null, name: "record" }]),
      entry("R-9", [{ kind: "field", entity: "record", name: "amount" }]),
      entry("R-12", [{ kind: "view", entity: "record", name: "records" }]),
      entry("R-13", [{ kind: "entity", entity: null, name: "record" }]),
    ],
    misses: [],
  };
  const methodMappings: readonly RoleNameMapping[] = [
    { roleId: "record", name: "record" },
    { roleId: "record.amount", name: "amount" },
    { roleId: "record.records", name: "records" },
  ];
  const suite = suiteWithClassifications(
    [
      // 操作の実行（set を当てたあとの状態）… 未対応（未解決）
      draft({
        id: "op-exec",
        target: roleTarget("R-3", "entity", "record"),
        operation: "action",
        expected: { kind: "ok", value: true },
      }),
      // 項目の既定値 … 未対応（未解決）
      draft({
        id: "field-default",
        target: roleTarget("R-9", "field", "record.amount"),
        operation: "compute",
        expected: { kind: "ok", value: 0 },
      }),
      // 画面 … 構造の確認（view が実在し、show の名前が実在する）
      draft({
        id: "screen",
        target: roleTarget("R-12", "screen", "record.records"),
        operation: "screen",
        expected: { kind: "ok", value: null },
      }),
      // 在ることだけの entity … 構造の確認（create の操作がある）
      draft({
        id: "existence",
        target: roleTarget("R-13", "entity", "record"),
        operation: "compute",
        expected: { kind: "ok", value: null },
      }),
    ],
    [{ requirementId: "R-13", nature: "existence-only" }],
  );

  it("操作の実行と項目の既定値は未解決に数え、画面と在ることだけの要件は構造の確認で判定する", () => {
    const result = runTests({
      app: APP,
      suite,
      correspondence: methodCorrespondence,
      mappings: methodMappings,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId).sort()).toEqual(["field-default", "op-exec"]);
    const routes = new Map(result.routes.map((route) => [route.testId, route.route]));
    expect(routes.get("op-exec")).toBe("ambiguity");
    expect(routes.get("field-default")).toBe("ambiguity");
    // 画面と在ることだけの要件は、不一致でも未解決でもない（構造の確認で一致した）
    expect(routes.has("screen")).toBe(false);
    expect(routes.has("existence")).toBe(false);
  });
});

// ── 6. 失敗を、行き先へ振り分ける（02 §1.3.1・Issue #308）──────────────

describe("失敗を行き先へ振り分ける（02 §1.3.1・Issue #308）", () => {
  const routeSuite = suiteOf([
    draft({
      id: "table-defect",
      target: roleTarget("R-20", "computation", "record.total"),
      operation: "compute",
      expected: { kind: "ok", value: 42 },
    }),
    draft({
      id: "element-missing",
      target: roleTarget("R-21", "computation", "record.ghost"),
      operation: "compute",
      expected: { kind: "ok", value: 0 },
    }),
    draft({
      id: "ambiguous",
      target: roleTarget("R-22", "screen", "record.records"),
      operation: "screen",
      expected: { kind: "ok", value: null },
    }),
  ]);
  const routeCorrespondence: CorrespondenceResult = {
    entries: [
      entry("R-20", [{ kind: "computation", entity: "record", name: "total" }]),
      entry("R-21", [{ kind: "computation", entity: "record", name: "ghost" }]),
      entry("R-22", [
        { kind: "view", entity: "record", name: "listA" },
        { kind: "view", entity: "record", name: "listB" },
      ]),
    ],
    misses: [],
  };
  const routeMappings: readonly RoleNameMapping[] = [
    { roleId: "record.total", name: "対応表に無い名前" },
    { roleId: "record.ghost", name: "ghost" },
  ];

  it("『対応の表の不備』『要素の欠落』『曖昧さ』に振り分ける", () => {
    const result = runTests({
      app: APP,
      suite: routeSuite,
      correspondence: routeCorrespondence,
      mappings: routeMappings,
    });
    const routes = new Map(result.routes.map((route) => [route.testId, route.route]));
    expect(routes.get("table-defect")).toBe("correspondence-defect");
    expect(routes.get("element-missing")).toBe("missing-element");
    expect(routes.get("ambiguous")).toBe("ambiguity");
    // 対応の表の不備・要素の欠落は不一致、曖昧さは未解決
    expect(result.mismatches.map((mismatch) => mismatch.testId).sort()).toEqual([
      "element-missing",
      "table-defect",
    ]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["ambiguous"]);
  });
});

// ── 7. 名前の付け替えは、結び付けと判定を変えない（02 §1.3.1・Issue #308）──

describe("名前の付け替えは、結び付けと判定を変えない（02 §1.3.1・Issue #308）", () => {
  const suite = suiteOf([
    draft({
      id: "t1",
      target: roleTarget("R-1", "computation", "record.total"),
      operation: "compute",
      input: { amount: 21 },
      expected: { kind: "ok", value: 42 },
    }),
  ]);

  it("提出された対応で結び付き、entity の名前を付け替えても合格に寄らない", async () => {
    const table: CorrespondenceResult = {
      entries: [
        entry("R-1", [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ]),
      ],
      misses: [],
    };
    const mappings: readonly RoleNameMapping[] = [
      { roleId: "record", name: "record" },
      { roleId: "record.total", name: "total" },
    ];
    // 提出された対応で、計算 total に結び付く（対応表の先頭の場所ではない）
    const bound = bindTests({ suite, correspondence: table, mappings });
    expect(bound[0]?.kind).toBe("bound");

    // 宣言の entity を、試験の文に合わせて付け替えた版（疎通の確認で起きた形）
    const renamedSource = DECLARATION_SOURCE.replaceAll("record", "renamed");
    const renamedApp = await normalized(renamedSource);
    // 対応表と対応も一貫して付け替えれば、同じ判定（名前で合否は動かない）
    const renamedTable: CorrespondenceResult = {
      entries: [
        entry("R-1", [
          { kind: "entity", entity: null, name: "renamed" },
          { kind: "computation", entity: "renamed", name: "total" },
        ]),
      ],
      misses: [],
    };
    const renamedMappings: readonly RoleNameMapping[] = [
      { roleId: "record", name: "renamed" },
      { roleId: "record.total", name: "total" },
    ];
    const consistent = runTests({
      app: renamedApp,
      suite,
      correspondence: renamedTable,
      mappings: renamedMappings,
    });
    expect(consistent.mismatches).toEqual([]);

    // 宣言だけを付け替えて対応を据え置くと、結び付け先が実在せず合格に寄らない
    const stale = runTests({ app: renamedApp, suite, correspondence: table, mappings });
    expect(stale.mismatches.map((mismatch) => mismatch.testId)).toEqual(["t1"]);
  });
});
