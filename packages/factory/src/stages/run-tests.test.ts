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
  type TestInputContract,
  type TestTarget,
} from "../pipeline.js";
import { bindTests } from "./bind.js";
import { holdsWriteAnonymous, resolveReferenceEntity, runTests } from "./run-tests.js";

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
  readonly inputContract?: TestInputContract;
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

  it("対応の名前が宣言に実在して対応表の外にあるときは、⑤a のやり直しに回す（③ のやり直しではない）", () => {
    const table: CorrespondenceResult = {
      entries: [entry("R-20", [{ kind: "entity", entity: null, name: "record" }])],
      misses: [],
    };
    const only = suiteOf([
      draft({
        id: "outside-real",
        target: roleTarget("R-20", "computation", "record.total"),
        operation: "compute",
        expected: { kind: "ok", value: 42 },
      }),
    ]);
    const result = runTests({
      app: APP,
      suite: only,
      correspondence: table,
      mappings: [{ roleId: "record.total", name: "total" }],
    });
    // total は宣言に実在し画面からも辿れる。対応表（R-20）が挙げていないだけなので、⑤a の表を作り直す。
    // ③ の対応（record.total → total）は正しく、③ をやり直しても直らない（Issue #322）
    expect(result.routes.map((route) => route.route)).toEqual(["correspondence-redo"]);
    expect(result.routes[0]?.requirementId).toBe("R-20");
    expect(result.routes[0]?.location).toEqual({ kind: "computation", entity: null, name: "total" });
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

// ── 8. 値の鍵を、提出された対応で項目の名前に写す（02 §1.3・Issue #320）──────

/**
 * 役割 ID の鍵で書いた入力と参照データを、提出された対応で宣言の項目の名前に写してから評価する試験の
 * 題材。`contains: this` の行ごとの集計（`member.shareCount`）と、`within: this_month` のアプリ全体の
 * 集計（`monthCount`）を持つ。題材は抽象的なものだけを使い、受入の題材の言葉は使わない。
 */
const MAPPED_DECLARATION = [
  "entities:",
  "  - name: member",
  "    fields:",
  "      name: string",
  "  - name: expense",
  "    fields:",
  "      amount: number",
  "      spentOn: date",
  "      payer:",
  "        type: ref",
  "        to: member",
  "      participants:",
  "        type: list",
  "        of: member",
  "views:",
  "  - name: members",
  "    type: list",
  "    entity: member",
  "    show: [name, shareCount]",
  "  - name: expenses",
  "    type: list",
  "    entity: expense",
  "    show: [amount]",
  "  - name: dashboard",
  "    type: dashboard",
  "    widgets:",
  "      - type: number",
  "        value: monthCount",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: shareCount",
  "    entity: member",
  "    aggregate:",
  "      count: expense",
  "      where:",
  "        participants:",
  "          contains: this",
  "    type: number",
  "  - name: monthCount",
  "    scope: app",
  "    aggregate:",
  "      count: expense",
  "      where:",
  "        spentOn:",
  "          within: this_month",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const MAPPED_APP = await normalized(MAPPED_DECLARATION);

/** 役割 ID の鍵で書いた参照データの 1 行 */
const refRoleRow = (
  requirementId: string,
  roleId: string,
  rowId: string,
  values: Readonly<Record<string, unknown>>,
): ReferenceRow => ({ target: roleTarget(requirementId, "entity", roleId), rowId, values });

const mappedCorrespondence: CorrespondenceResult = {
  entries: [
    entry("R-1", [
      { kind: "entity", entity: null, name: "member" },
      { kind: "computation", entity: "member", name: "shareCount" },
    ]),
    entry("R-2", [{ kind: "computation", entity: null, name: "monthCount" }]),
  ],
  misses: [],
};

/** ③ が提出した対応（役割 ID → 宣言の名前） */
const mappedMappings: readonly RoleNameMapping[] = [
  { roleId: "member", name: "member" },
  { roleId: "member.name", name: "name" },
  { roleId: "member.shareCount", name: "shareCount" },
  { roleId: "expense", name: "expense" },
  { roleId: "expense.amount", name: "amount" },
  { roleId: "expense.spentOn", name: "spentOn" },
  { roleId: "expense.payer", name: "payer" },
  { roleId: "expense.participants", name: "participants" },
  { roleId: "monthCount", name: "monthCount" },
];

describe("値の鍵を、提出された対応で項目の名前に写す（02 §1.3・Issue #320）", () => {
  it("contains: this の行ごとの集計：役割 ID の鍵が項目の名前へ写ってから評価される", () => {
    const test = draft({
      id: "share",
      target: roleTarget("R-1", "computation", "member.shareCount"),
      operation: "compute",
      input: { "member.name": "A" },
      inputContract: { rowId: "m1", targetRowId: "m1", emptyEntities: [] },
      referenceData: [
        refRoleRow("R-1", "expense", "e1", { "expense.amount": 100, "expense.participants": ["m1", "m2"] }),
        refRoleRow("R-1", "expense", "e2", { "expense.amount": 200, "expense.participants": ["m1"] }),
        refRoleRow("R-1", "expense", "e3", { "expense.amount": 300, "expense.participants": ["m2"] }),
      ],
      expected: { kind: "ok", value: 2 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    // 写さなければ participants の鍵が残り、this を含む行を数えられず null になる（疎通の確認で起きた形）
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("within: this_month のアプリ全体の集計：参照データの鍵が項目の名前へ写ってから評価される", () => {
    const test = draft({
      id: "month",
      target: roleTarget("R-2", "computation", "monthCount"),
      operation: "aggregate",
      referenceData: [
        refRoleRow("R-2", "expense", "e1", { "expense.spentOn": "2026-09-01", "expense.amount": 100 }),
        refRoleRow("R-2", "expense", "e2", { "expense.spentOn": "2026-09-15", "expense.amount": 200 }),
        refRoleRow("R-2", "expense", "e3", { "expense.spentOn": "2026-08-31", "expense.amount": 300 }),
      ],
      expected: { kind: "ok", value: 2 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    // 写さなければ spentOn の鍵が残り、今月の行を絞れず 0 になる（疎通の確認で起きた形）
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("対応に無い役割 ID の鍵があると、その試験は理由つきの未解決になる", () => {
    const test = draft({
      id: "input-unmapped",
      target: roleTarget("R-1", "computation", "member.shareCount"),
      operation: "compute",
      input: { "member.nickname": "A" },
      inputContract: { rowId: "m1", targetRowId: "m1", emptyEntities: [] },
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["input-unmapped"]);
    expect(result.unresolved[0]?.detail).toContain("member.nickname");
  });

  it("別の entity の項目の役割 ID の鍵があると、別の entity として理由つきの未解決になる", () => {
    const test = draft({
      id: "other-entity",
      target: roleTarget("R-1", "computation", "member.shareCount"),
      operation: "compute",
      input: { "expense.amount": 5 },
      inputContract: { rowId: "m1", targetRowId: "m1", emptyEntities: [] },
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["other-entity"]);
    expect(result.unresolved[0]?.detail).toContain("別の entity");
  });

  it("参照データの値の鍵に、対応に無い役割 ID があると未解決になる", () => {
    const test = draft({
      id: "ref-unmapped",
      target: roleTarget("R-1", "computation", "member.shareCount"),
      operation: "compute",
      input: { "member.name": "A" },
      inputContract: { rowId: "m1", targetRowId: "m1", emptyEntities: [] },
      referenceData: [refRoleRow("R-1", "expense", "e1", { "expense.nickname": "x" })],
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["ref-unmapped"]);
    expect(result.unresolved[0]?.detail).toContain("expense.nickname");
  });
});

describe("在ることだけの要件の create の操作は、構造の確認で通す（02 §1.3・Issue #320）", () => {
  const createSuite = suiteWithClassifications(
    [
      draft({
        id: "create",
        target: roleTarget("R-13", "operation", "record.add"),
        operation: "action",
        expected: { kind: "ok", value: null },
      }),
    ],
    [{ requirementId: "R-13", nature: "existence-only" }],
  );
  const createCorrespondence: CorrespondenceResult = {
    entries: [entry("R-13", [{ kind: "action", entity: "record", name: "add" }])],
    misses: [],
  };

  it("when の無い create の操作でも、未解決にならず構造の確認で一致する", () => {
    const result = runTests({
      app: APP,
      suite: createSuite,
      correspondence: createCorrespondence,
      mappings: [{ roleId: "record.add", name: "add" }],
    });
    // 実行は評価器で確かめられないが、create の操作と一覧があるので構造の確認で通る（未解決にしない）
    expect(result.unresolved).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });
});

// ── 9. 空であることを明示した entity（02 §1・②'・Issue #322）──────────────

describe("空であることを明示した entity は、空の集合として集計する（02 §1・②'・Issue #322）", () => {
  it("emptyEntities に挙げた entity は 0 件として扱われ、集計が 0 になる", () => {
    // `shareCount` は、member をこの行として expense を数える行ごとの集計。
    // 参照データが空でも、`emptyEntities: ["expense"]` があれば expense は「行が 0 件」と分かる
    const test = draft({
      id: "empty-collection",
      target: roleTarget("R-1", "computation", "member.shareCount"),
      operation: "compute",
      input: { "member.name": "A" },
      inputContract: { rowId: "m1", targetRowId: "m1", emptyEntities: ["expense"] },
      referenceData: [],
      expected: { kind: "ok", value: 0 },
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([test]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    // 空の集合を渡さなければ 0 ではなく null になり、不一致になる（疎通の確認で起きた形）
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

// ── 10. 項目 × 画面（02 §1.3・Issue #324）──────────────────────────────

/**
 * 「項目 × 画面」の試験に使う宣言（抽象的な題材）。`record` は一覧で `show` を明示して一部の項目だけを
 * 出し、`other` は `show` を省略して全部を出す（種類なしの一覧）。
 */
const FIELD_SCREEN_DECLARATION = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      shown: string",
  "      hidden: string",
  "  - name: other",
  "    fields:",
  "      anything: string",
  "views:",
  "  - name: records",
  "    type: table",
  "    entity: record",
  "    show: [shown]",
  "  - name: others",
  "    entity: other",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const FIELD_SCREEN_APP = await normalized(FIELD_SCREEN_DECLARATION);

/** 対応表（コードが確かめた後のもの）。要件ごとに、項目の場所を 1 つに決められるように並べてある */
const fieldScreenCorrespondence: CorrespondenceResult = {
  entries: [
    entry("R-1", [{ kind: "field", entity: "record", name: "shown" }]),
    entry("R-2", [{ kind: "field", entity: "record", name: "hidden" }]),
    entry("R-3", [{ kind: "field", entity: "other", name: "anything" }]),
  ],
  misses: [],
};

/** ③ が提出した対応（項目の役割 ID → 宣言の項目の名前） */
const fieldScreenMappings: readonly RoleNameMapping[] = [
  { roleId: "record.shown", name: "shown" },
  { roleId: "record.hidden", name: "hidden" },
  { roleId: "other.anything", name: "anything" },
];

/** 項目を対象にした画面の試験 1 件（操作は screen） */
const fieldScreenTest = (id: string, requirementId: string, roleId: string): Record<string, unknown> =>
  draft({
    id,
    target: roleTarget(requirementId, "field", roleId),
    operation: "screen",
    expected: { kind: "ok", value: null },
  });

describe("項目 × 画面（02 §1.3・Issue #324）", () => {
  it("項目が一覧か表から辿れれば通り、辿れなければ理由つきの不一致になり、未解決にならない", () => {
    const result = runTests({
      app: FIELD_SCREEN_APP,
      suite: suiteOf([
        fieldScreenTest("shown", "R-1", "record.shown"),
        fieldScreenTest("hidden", "R-2", "record.hidden"),
      ]),
      correspondence: fieldScreenCorrespondence,
      mappings: fieldScreenMappings,
    });
    // 未対応（未解決）ではなく、構造の確認で判定する。辿れない項目は不一致（理由つき）になる
    expect(result.unresolved).toEqual([]);
    expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual(["hidden"]);
    expect(result.mismatches[0]?.detail).toContain("画面から辿れない");
    // 不一致は ⑥ 直す（宣言の要素の欠落）へ回る
    expect(result.routes.find((route) => route.testId === "hidden")?.route).toBe("missing-element");
  });

  it("`show` を省略して全部を出す一覧の項目は、画面から辿れる（落ちにしない）", () => {
    const result = runTests({
      app: FIELD_SCREEN_APP,
      suite: suiteOf([fieldScreenTest("anything", "R-3", "other.anything")]),
      correspondence: fieldScreenCorrespondence,
      mappings: fieldScreenMappings,
    });
    expect({ mismatches: result.mismatches, unresolved: result.unresolved }).toEqual({
      mismatches: [],
      unresolved: [],
    });
    expect(result.routes).toEqual([]);
  });
});

// ── 11. 構造の検査（02 §1.3・Issue #387）──────────────────────────────

/** 構造の検査に使う対応表（対象と、参照する役割を、提出された対応で写せるように並べてある） */
const structureCorrespondence: CorrespondenceResult = {
  entries: [
    entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
    entry("R-3", [{ kind: "action", entity: "record", name: "close" }]),
    entry("R-9", [{ kind: "field", entity: "record", name: "amount" }]),
    entry("R-10", [{ kind: "field", entity: "payment", name: "payer" }]),
    entry("R-11", [{ kind: "field", entity: "payment", name: "shares" }]),
    entry("R-12", [{ kind: "view", entity: "record", name: "records" }]),
    entry("R-13", [{ kind: "action", entity: "record", name: "add" }]),
  ],
  misses: [],
};

const structureMappings: readonly RoleNameMapping[] = [
  { roleId: "record", name: "record" },
  { roleId: "person", name: "person" },
  { roleId: "record.total", name: "total" },
  { roleId: "record.close", name: "close" },
  { roleId: "record.add", name: "add" },
  { roleId: "record.amount", name: "amount" },
  { roleId: "payment.payer", name: "payer" },
  { roleId: "payment.shares", name: "shares" },
  { roleId: "record.records", name: "records" },
];

/** 構造の検査 1 件の下書き（操作は structure、期待は「成り立つ」、assertion を添える） */
const structureTest = (
  id: string,
  requirementId: string,
  kind: TestTarget["kind"],
  roleId: string,
  assertion: Record<string, unknown>,
): Record<string, unknown> => ({
  ...draft({
    id,
    target: roleTarget(requirementId, kind, roleId),
    operation: "structure",
    expected: { kind: "ok", value: true },
  }),
  assertion,
});

/** 構造の検査を、APP の宣言と構造の検査用の対応で流す */
const runStructureTests = (tests: readonly Record<string, unknown>[], app = APP) =>
  runTests({ app, suite: suiteOf(tests), correspondence: structureCorrespondence, mappings: structureMappings });

/** 構造の検査を流して、不一致になった試験 ID を返す */
const structureMismatchIds = (tests: readonly Record<string, unknown>[], app = APP): readonly string[] =>
  runStructureTests(tests, app).mismatches.map((mismatch) => mismatch.testId);

describe("構造の検査：field-type（02 §1.3・Issue #387）", () => {
  it("種類が合えば合格、種類違い・参照の取り違え・参照先違いは不一致", () => {
    // 種類が合えば合格
    expect(
      structureMismatchIds([
        structureTest("ft-ok", "R-9", "field", "record.amount", { check: "field-type", expected: "number" }),
      ]),
    ).toEqual([]);
    // 種類違いは不一致
    expect(
      structureMismatchIds([
        structureTest("ft-kind", "R-9", "field", "record.amount", { check: "field-type", expected: "string" }),
      ]),
    ).toEqual(["ft-kind"]);
    // ref を期待して参照の並び（list of）の項目は不一致
    expect(
      structureMismatchIds([
        structureTest("ft-ref-list", "R-11", "field", "payment.shares", {
          check: "field-type",
          expected: "ref",
          refEntity: "person",
        }),
      ]),
    ).toEqual(["ft-ref-list"]);
    // 文字列の並びと参照の並びの取り違え（参照の並びに、参照先を書かない期待）は不一致
    expect(
      structureMismatchIds([
        structureTest("ft-str-list", "R-11", "field", "payment.shares", { check: "field-type", expected: "list" }),
      ]),
    ).toEqual(["ft-str-list"]);
    // 参照の並びは、参照先が合えば合格
    expect(
      structureMismatchIds([
        structureTest("ft-list-ok", "R-11", "field", "payment.shares", {
          check: "field-type",
          expected: "list",
          refEntity: "person",
        }),
      ]),
    ).toEqual([]);
    // 参照先が違うと不一致
    expect(
      structureMismatchIds([
        structureTest("ft-target", "R-11", "field", "payment.shares", {
          check: "field-type",
          expected: "list",
          refEntity: "record",
        }),
      ]),
    ).toEqual(["ft-target"]);
    // ref は参照先が合えば合格、違えば不一致
    expect(
      structureMismatchIds([
        structureTest("ft-ref-ok", "R-10", "field", "payment.payer", {
          check: "field-type",
          expected: "ref",
          refEntity: "person",
        }),
      ]),
    ).toEqual([]);
    expect(
      structureMismatchIds([
        structureTest("ft-ref-target", "R-10", "field", "payment.payer", {
          check: "field-type",
          expected: "ref",
          refEntity: "record",
        }),
      ]),
    ).toEqual(["ft-ref-target"]);
  });
});

describe("構造の検査：action-kind・action-unconditioned（02 §1.3・Issue #387）", () => {
  it("種類違い・when のある操作は不一致", () => {
    // 種類が合えば合格（close は update）
    expect(
      structureMismatchIds([
        structureTest("ak-ok", "R-3", "operation", "record.close", { check: "action-kind", expected: "update" }),
      ]),
    ).toEqual([]);
    // 種類違いは不一致
    expect(
      structureMismatchIds([
        structureTest("ak-kind", "R-3", "operation", "record.close", { check: "action-kind", expected: "create" }),
      ]),
    ).toEqual(["ak-kind"]);
    // when の無い create は合格
    expect(
      structureMismatchIds([
        structureTest("au-ok", "R-13", "operation", "record.add", { check: "action-unconditioned" }),
      ]),
    ).toEqual([]);
    // when のある操作は不一致
    expect(
      structureMismatchIds([
        structureTest("au-when", "R-3", "operation", "record.close", { check: "action-unconditioned" }),
      ]),
    ).toEqual(["au-when"]);
  });
});

/**
 * 「構造の検査 view-shows」に使う宣言（抽象的な題材）。`records` は `show` に `shown` だけを出し、
 * `allRecords` は `show` を省いて全部を出し、`otherRecords` は別の項目だけを出す。
 */
const VIEWS_DECLARATION = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      shown: string",
  "      hidden: string",
  "      count: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [shown]",
  "  - name: allRecords",
  "    entity: record",
  "  - name: otherRecords",
  "    type: list",
  "    entity: record",
  "    show: [hidden]",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: doubled",
  "    entity: record",
  "    expression: count * 2",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const VIEWS_APP = await normalized(VIEWS_DECLARATION);

const viewsCorrespondence: CorrespondenceResult = {
  entries: [
    entry("R-1", [{ kind: "view", entity: "record", name: "records" }]),
    entry("R-2", [{ kind: "view", entity: "record", name: "allRecords" }]),
  ],
  misses: [],
};

const viewsMappings: readonly RoleNameMapping[] = [
  { roleId: "record.records", name: "records" },
  { roleId: "record.allRecords", name: "allRecords" },
  { roleId: "record.shown", name: "shown" },
  { roleId: "record.hidden", name: "hidden" },
  { roleId: "record.doubled", name: "doubled" },
];

describe("構造の検査：view-shows（02 §1.3・Issue #387）", () => {
  const viewTest = (id: string, requirementId: string, viewRoleId: string, role: string) =>
    structureTest(id, requirementId, "screen", viewRoleId, { check: "view-shows", role });
  const run = (tests: readonly Record<string, unknown>[]) =>
    runTests({ app: VIEWS_APP, suite: suiteOf(tests), correspondence: viewsCorrespondence, mappings: viewsMappings });

  it("表示していれば合格、表示しない部品・別の画面だけの表示は不一致", () => {
    // records は show に shown を出す → 合格
    expect(run([viewTest("vs-shown", "R-1", "record.records", "record.shown")]).mismatches).toEqual([]);
    // records は計算 doubled を表示しない → 不一致
    expect(
      run([viewTest("vs-computed", "R-1", "record.records", "record.doubled")]).mismatches.map(
        (mismatch) => mismatch.testId,
      ),
    ).toEqual(["vs-computed"]);
    // hidden は別の画面（otherRecords）にだけ出る → records では不一致
    expect(
      run([viewTest("vs-other", "R-1", "record.records", "record.hidden")]).mismatches.map(
        (mismatch) => mismatch.testId,
      ),
    ).toEqual(["vs-other"]);
  });

  it("`show` を省いた部品は、語彙の決まりどおりに全部を並べる", () => {
    expect(
      run([
        viewTest("vs-all-field", "R-2", "record.allRecords", "record.hidden"),
        viewTest("vs-all-computed", "R-2", "record.allRecords", "record.doubled"),
      ]).mismatches,
    ).toEqual([]);
  });
});

describe("構造の検査：aggregate-no-period（02 §1.3・Issue #387）", () => {
  it("行を結び付ける絞り込みだけなら合格・within を足すと不一致", () => {
    const contains = structureTest("an-ok", "R-1", "computation", "member.shareCount", {
      check: "aggregate-no-period",
    });
    const within = structureTest("an-within", "R-2", "computation", "monthCount", {
      check: "aggregate-no-period",
    });
    const result = runTests({
      app: MAPPED_APP,
      suite: suiteOf([contains, within]),
      correspondence: mappedCorrespondence,
      mappings: mappedMappings,
    });
    expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual(["an-within"]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("構造の検査：役割が結び付かないと未解決（02 §1.3・Issue #387）", () => {
  it("提出された対応に無い役割 ID の対象は未解決", () => {
    const unmapped = structureTest("su-unmapped", "R-9", "field", "record.unknown", {
      check: "field-type",
      expected: "number",
    });
    const result = runStructureTests([unmapped]);
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["su-unmapped"]);
    expect(result.routes[0]?.route).toBe("ambiguity");
  });

  it("参照する役割 ID に提出された対応が無いと未解決", () => {
    const refUnknown = structureTest("su-ref", "R-10", "field", "payment.payer", {
      check: "field-type",
      expected: "ref",
      refEntity: "person.unknown",
    });
    const result = runStructureTests([refUnknown]);
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["su-ref"]);
  });
});

describe("構造の検査の記録とほかの試験への影響（02 §1.3・Issue #387）", () => {
  it("1 件ごとに、試験 ID・要件 ID・検査の中身・結果を記録し、合格・不一致・未解決を区別する", () => {
    const ok = structureTest("s-ok", "R-9", "field", "record.amount", { check: "field-type", expected: "number" });
    const bad = structureTest("s-bad", "R-9", "field", "record.amount", { check: "field-type", expected: "string" });
    const unknown = structureTest("s-unknown", "R-9", "field", "record.unknown", {
      check: "field-type",
      expected: "number",
    });
    const result = runStructureTests([ok, bad, unknown]);
    expect(result.structural).toEqual([
      { testId: "s-ok", requirementId: "R-9", check: "field-type", result: "pass", detail: expect.any(String) },
      { testId: "s-bad", requirementId: "R-9", check: "field-type", result: "mismatch", detail: expect.any(String) },
      { testId: "s-unknown", requirementId: "R-9", check: "field-type", result: "unresolved", detail: expect.any(String) },
    ]);
  });

  it("構造の検査が成り立っても、ほかの試験の未解決は消えない", () => {
    const structure = structureTest("s-pass", "R-9", "field", "record.amount", {
      check: "field-type",
      expected: "number",
    });
    const unresolvedField = draft({
      id: "u-field",
      target: roleTarget("R-9", "field", "record.amount"),
      operation: "compute",
      expected: { kind: "ok", value: 0 },
    });
    const result = runStructureTests([structure, unresolvedField]);
    expect(result.mismatches).toEqual([]);
    // 構造の検査は合格しているのに、ほかの試験の未解決（入力の型）は残る
    expect(result.structural.map((entry) => entry.result)).toEqual(["pass"]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["u-field"]);
  });
});

// ── 12. 構造の検査：write-anonymous（02 §1.3・Issue #393）────────────────

/** `write` の権限を外した定義（read だけ） */
const READ_ONLY_APP = await normalized(
  DECLARATION_SOURCE.replace("  - name: write\n    subject: minIdentity\n", ""),
);
/** `read` の権限を外した定義（write と匿名の本人確認だけ） */
const WRITE_NO_READ_APP = await normalized(
  DECLARATION_SOURCE.replace("  - name: read\n    subject: minIdentity\n", ""),
);
/** 対象の操作（add）を消して、別の操作（close）だけを残した定義 */
const WITHOUT_ADD_APP = await normalized(
  DECLARATION_SOURCE.replace("  - name: add\n    entity: record\n    kind: create\n", ""),
);

/** write-anonymous の構造の検査 1 件（対象は操作 record.add） */
const writeAnonymousTest = (id: string, requirementId: string, roleId: string): Record<string, unknown> =>
  structureTest(id, requirementId, "operation", roleId, { check: "write-anonymous" });

describe("構造の検査：write-anonymous（02 §1.3・Issue #393）", () => {
  it("操作が在り、write があり、anonymous なら成り立つ", () => {
    const result = runStructureTests([writeAnonymousTest("wa-ok", "R-13", "record.add")]);
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("権限に write が無い宣言は不一致になる（action-kind・action-unconditioned が成り立っても）", () => {
    const result = runStructureTests(
      [
        structureTest("ak", "R-13", "operation", "record.add", { check: "action-kind", expected: "create" }),
        structureTest("au", "R-13", "operation", "record.add", { check: "action-unconditioned" }),
        writeAnonymousTest("wa", "R-13", "record.add"),
      ],
      READ_ONLY_APP,
    );
    // action-kind・action-unconditioned は成り立ち、write-anonymous だけが不一致になる
    expect(result.mismatches.map((mismatch) => mismatch.testId)).toEqual(["wa"]);
    expect(result.unresolved).toEqual([]);
  });

  it("read だけの宣言は不一致。read が無くても write と anonymous があれば成り立つ", () => {
    expect(structureMismatchIds([writeAnonymousTest("wa", "R-13", "record.add")], READ_ONLY_APP)).toEqual(["wa"]);
    expect(structureMismatchIds([writeAnonymousTest("wa", "R-13", "record.add")], WRITE_NO_READ_APP)).toEqual([]);
  });

  it("対象の操作を消して別の操作だけを残した宣言では成り立たない（未解決）", () => {
    const result = runStructureTests([writeAnonymousTest("wa", "R-13", "record.add")], WITHOUT_ADD_APP);
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["wa"]);
  });

  it("役割の対応が欠けていれば成り立たない（未解決）", () => {
    const withoutAdd = structureMappings.filter((mapping) => mapping.roleId !== "record.add");
    const result = runTests({
      app: APP,
      suite: suiteOf([writeAnonymousTest("wa", "R-13", "record.add")]),
      correspondence: structureCorrespondence,
      mappings: withoutAdd,
    });
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["wa"]);
  });

  it("別の entity の場所に結び付いた例では成り立たない", () => {
    const otherEntity: CorrespondenceResult = {
      entries: [entry("R-13", [{ kind: "action", entity: "person", name: "add" }])],
      misses: [],
    };
    const result = runTests({
      app: APP,
      suite: suiteOf([writeAnonymousTest("wa", "R-13", "record.add")]),
      correspondence: otherEntity,
      mappings: [{ roleId: "record.add", name: "add" }],
    });
    // 結び付いた場所は person の add だが、宣言の add は record に在る（別の entity として未解決）
    expect(result.unresolved.map((entry) => entry.testId)).toEqual(["wa"]);
  });

  it("判定の関数に不正な mode・subject を与えると成り立たない（防御）", () => {
    const withSpec = (permissions: readonly unknown[], mode: string): NormalizedAppSpec =>
      ({ spec: { permissions, minIdentity: { mode } } }) as unknown as NormalizedAppSpec;
    expect(holdsWriteAnonymous(withSpec([{ name: "write", subject: "minIdentity" }], "anonymous"))).toBe(true);
    expect(holdsWriteAnonymous(withSpec([{ name: "write", subject: "other" }], "anonymous"))).toBe(false);
    expect(holdsWriteAnonymous(withSpec([{ name: "write", subject: "minIdentity" }], "login"))).toBe(false);
    expect(holdsWriteAnonymous(withSpec([{ name: "read", subject: "minIdentity" }], "anonymous"))).toBe(false);
  });

  it("不正な mode・subject の宣言は、静的チェックが止める", async () => {
    expect((await normalizeSpec(DECLARATION_SOURCE.replace("mode: anonymous", "mode: login"))).ok).toBe(false);
    const badSubject = DECLARATION_SOURCE.replace(
      "  - name: write\n    subject: minIdentity",
      "  - name: write\n    subject: other",
    );
    expect((await normalizeSpec(badSubject)).ok).toBe(false);
  });

  it("write-anonymous の結果も、1 件ごとに記録される", () => {
    const result = runStructureTests([writeAnonymousTest("wa-ok", "R-13", "record.add")]);
    expect(result.structural).toEqual([
      {
        testId: "wa-ok",
        requirementId: "R-13",
        check: "write-anonymous",
        result: "pass",
        detail: expect.any(String),
      },
    ]);
  });
});


