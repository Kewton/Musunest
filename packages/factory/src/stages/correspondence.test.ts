// ⑤a 対応表（stages/correspondence.ts）の unit テスト（02 §1・F-2・F-8・R-1）。
//
// ここで固定したいのは 4 つ。
//   1. コードが確かめる：宣言に無い名前・画面から辿れない計算を落ちにし、`show` を省略して全部を出す
//      一覧の計算は落ちにしないこと
//   2. 要件の対応そのものが無いことも落ちにすること
//   3. 送った要求を観測する：原文・要件の一覧・宣言の 3 つだけをデータに置き、JSON Schema を付け、
//      規則とデータを分け、受入の題材の言葉を使わないこと
//   4. 偽物が受け取った要求を読む（予定の答えを返すだけの試験で閉じない）
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { normalizeSpec } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DESIGN_CONTRACT,
  type CorrespondenceEntry,
  type Declaration,
  type RoleEntry,
  type RoleNameMapping,
} from "../pipeline.js";
import {
  CORRESPONDENCE_REDO_DEFINITION,
  CORRESPONDENCE_REDO_RULE,
  CORRESPONDENCE_RULE_DEFINITIONS,
  CORRESPONDENCE_RULES,
  CORRESPONDENCE_SCHEMA_NAME,
  CORRESPONDENCE_SETTLED_DEFINITION,
  CORRESPONDENCE_SETTLED_RULE,
  checkCorrespondence,
  checkCorrespondenceOutput,
  checkRoleMappings,
  runCorrespondence,
  type CorrespondenceInput,
  type RequirementRoleOwnership,
} from "./correspondence.js";
import { ruleDefinitionDefects, ruleTexts } from "./prompt.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 手で書いた宣言（抽象的な題材。受入の題材の言葉は使わない） */
const DECLARATION_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      title: string",
  "      amount: number",
  "  - name: other",
  "    fields:",
  "      count: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [title, amount, total]",
  "  - name: others",
  "    type: table",
  "    entity: other",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: total",
  "    entity: record",
  "    expression: amount * 2",
  "    type: number",
  "  - name: hidden",
  "    entity: record",
  "    expression: amount + 1",
  "    type: number",
  "  - name: otherTotal",
  "    entity: other",
  "    expression: count * 2",
  "    type: number",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const DECLARATION: Declaration = { source: DECLARATION_SOURCE };

const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((diagnostic) => diagnostic.code).join(" / ")}`);
  }
  return result.app;
};

const APP = await normalized(DECLARATION_SOURCE);

const entry = (
  requirementId: string,
  locations: readonly CorrespondenceEntry["locations"][number][],
): CorrespondenceEntry => ({ requirementId, locations });

describe("コードが確かめる（実在・画面からの到達。02 §1）", () => {
  it("宣言に無い名前を落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "field", entity: "record", name: "missing" }]),
      entry("R-2", [{ kind: "computation", entity: "other", name: "otherTotal" }]),
    ]);
    const miss = misses.find((candidate) => candidate.location?.name === "missing");
    expect(miss).toBeDefined();
    expect(miss?.detail).toContain("missing");
  });

  it("画面から辿れない計算を落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
      entry("R-2", [{ kind: "computation", entity: "record", name: "hidden" }]),
    ]);
    const miss = misses.find((candidate) => candidate.location?.name === "hidden");
    expect(miss).toBeDefined();
    expect(miss?.detail).toContain("画面から辿れない");
  });

  it("`show` を省略して全部を出す一覧の計算は、画面から辿れる（落ちにしない）", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
      entry("R-2", [{ kind: "computation", entity: "other", name: "otherTotal" }]),
    ]);
    expect(misses).toEqual([]);
  });

  it("要件の対応そのものが無いことも落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      entry("R-1", [{ kind: "computation", entity: "record", name: "total" }]),
    ]);
    const miss = misses.find((candidate) => candidate.requirementId === "R-2");
    expect(miss).toBeDefined();
    expect(miss?.location).toBeUndefined();
    expect(miss?.detail).toContain("R-2");
  });
});

// ── ③ の提出した対応の独立の点検（02 §1.2・Issue #308） ────────────────

/** ② の役割 ID の表（③ の提出した対応を点検するのに使う） */
const ROLES: readonly RoleEntry[] = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null },
  { roleId: "record.title", kind: "field", entity: "record", name: "title", shared: false, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
];

/** ⑤a の対応表（R-1 に、entity・項目 title・計算 total・一覧 records を挙げる） */
const TABLE: readonly CorrespondenceEntry[] = [
  {
    requirementId: "R-1",
    locations: [
      { kind: "entity", entity: null, name: "record" },
      { kind: "field", entity: "record", name: "title" },
      { kind: "computation", entity: "record", name: "total" },
      { kind: "view", entity: null, name: "records" },
    ],
  },
  { requirementId: "R-2", locations: [{ kind: "computation", entity: "other", name: "otherTotal" }] },
];

/** 通る対応（record・title・total。amount は対応表に挙げていない） */
const VALID_MAPPINGS: readonly RoleNameMapping[] = [
  { roleId: "record", name: "record" },
  { roleId: "record.title", name: "title" },
  { roleId: "record.total", name: "total" },
];

const withMapping = (
  base: readonly RoleNameMapping[],
  roleId: string,
  name: string,
): readonly RoleNameMapping[] => [...base.filter((mapping) => mapping.roleId !== roleId), { roleId, name }];

const missFor = (mappings: readonly RoleNameMapping[], roles: readonly RoleEntry[] = ROLES) =>
  checkRoleMappings(APP, roles, TABLE, mappings, { version: LEGACY_DESIGN_CONTRACT });

describe("③ の提出した対応を、コードが独立に点検する（02 §1.2・Issue #308）", () => {
  it("実在して対応表の内側にある対応は、落ちにしない", () => {
    expect(missFor(VALID_MAPPINGS)).toEqual([]);
  });

  it("実在しない名前を落ちにする", () => {
    const misses = missFor(withMapping(VALID_MAPPINGS, "record.total", "ghost"));
    expect(misses.map((miss) => miss.detail).join("\n")).toContain("実在しない");
  });

  it("対象の種類が合わない名前（種類違い）を落ちにする", () => {
    // 項目の役割に、計算の名前（total）を対応させている
    const misses = missFor(withMapping(VALID_MAPPINGS, "record.title", "total"));
    expect(misses.map((miss) => miss.detail).join("\n")).toContain("合わない");
  });

  it("対応表の外にある場所を落ちにする", () => {
    // amount は宣言に実在し画面からも辿れるが、対応表（R-1）は挙げていない
    const misses = missFor([...VALID_MAPPINGS, { roleId: "record.amount", name: "amount" }]);
    expect(misses.map((miss) => miss.detail).join("\n")).toContain("対応表の外");
  });

  it("役割 ID の表に無い役割 ID も、対応表の外として落ちにする", () => {
    const misses = missFor([...VALID_MAPPINGS, { roleId: "record.ghost", name: "title" }]);
    expect(misses.map((miss) => miss.detail).join("\n")).toContain("対応表の外");
  });

  it("共有も別名も明示せずに同じ場所へ二重に対応していれば、落ちにする", () => {
    const roles: readonly RoleEntry[] = [
      ...ROLES,
      { roleId: "record.title2", kind: "field", entity: "record", name: "title", shared: false, aliasOf: null },
    ];
    const misses = missFor([...VALID_MAPPINGS, { roleId: "record.title2", name: "title" }], roles);
    expect(misses.map((miss) => miss.detail).join("\n")).toContain("共有");
  });

  it("共有を明示していれば、同じ場所への二重の対応を落ちにしない", () => {
    const roles: readonly RoleEntry[] = [
      ...ROLES,
      { roleId: "record.title2", kind: "field", entity: "record", name: "title", shared: true, aliasOf: null },
    ];
    expect(missFor([...VALID_MAPPINGS, { roleId: "record.title2", name: "title" }], roles)).toEqual([]);
  });
});

describe("空の対応の場所も落ちにする（02 §1・R2-2・Issue #308）", () => {
  it("要件の対応が空なら、落ちにする", () => {
    const misses = checkCorrespondence(APP, REQUIREMENT_LIST, [
      { requirementId: "R-1", locations: [] },
      { requirementId: "R-2", locations: [{ kind: "computation", entity: "other", name: "otherTotal" }] },
    ]);
    expect(misses.find((miss) => miss.requirementId === "R-1")?.detail).toContain("空");
  });
});

describe("⑤a の形の確認（02 §2.2）", () => {
  it("場所の形が合わなければ、欄つきで断る", () => {
    const bad = checkCorrespondenceOutput({
      entries: [{ requirementId: "", locations: [{ kind: "nope", entity: 1, name: "" }] }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const fields = bad.problems.map((problem) => problem.field);
    expect(fields).toContain("entries[0].requirementId");
    expect(fields).toContain("entries[0].locations[0].kind");
    expect(fields).toContain("entries[0].locations[0].name");
  });

  it("対応表の並びでなければ断る", () => {
    expect(checkCorrespondenceOutput({ entries: {} }).ok).toBe(false);
    expect(checkCorrespondenceOutput(null).ok).toBe(false);
  });
});

describe("⑤a が送る要求を観測する（02 §2.2・§1）", () => {
  const answer = {
    entries: [
      { requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] },
      { requirementId: "R-2", locations: [{ kind: "computation", entity: "other", name: "otherTotal" }] },
    ],
  };

  it("原文・要件の一覧・宣言の 3 つだけをデータに置き、JSON Schema を付ける", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const outcome = await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input.match(/<data name=/g)).toHaveLength(3);
    expect(request.input).toContain("原文");
    expect(request.input).toContain("要件の一覧");
    expect(request.input).toContain("宣言");
    expect(request.input).toContain(DECLARATION_SOURCE);
    expect(request.instructions).not.toContain(DECLARATION_SOURCE);
    expect(request.schemaName).toBe(CORRESPONDENCE_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("原文に仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    await runCorrespondence({
      source: `${SOURCE_TEXT}${INJECTED_INSTRUCTION}`,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("渡すと決めていない文脈（余分な欄）は、データにも規則にも入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const withExtra = {
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      testSuiteSentinel: "SUITE_SENTINEL",
    } as unknown as CorrespondenceInput;
    await runCorrespondence(withExtra);
    const request = recording.structured[0];
    expect(request?.input).not.toContain("SUITE_SENTINEL");
    expect(request?.instructions).not.toContain("SUITE_SENTINEL");
  });
});

describe("⑤a の点検役に、期待の値と試験の合否を見せない（02 §1.2・Issue #308）", () => {
  const EXPECTED_SENTINEL = "EXPECTED_VALUE_SENTINEL";
  const RESULT_SENTINEL = "TEST_RESULT_SENTINEL";
  const answer = {
    entries: [{ requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] }],
  };

  it("提出された対応は渡すが、期待の値と試験の合否は渡さない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const input = {
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      roles: ROLES,
      mappings: VALID_MAPPINGS,
      // 期待の値と試験の合否に当たる余分な欄（点検役へ渡ってはならない）
      expected: { kind: "ok", value: EXPECTED_SENTINEL },
      testRun: { mismatches: [{ testId: RESULT_SENTINEL, detail: RESULT_SENTINEL }], unresolved: [] },
      suite: [{ id: RESULT_SENTINEL }],
    } as unknown as CorrespondenceInput;
    await runCorrespondence(input);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 提出された対応は、独立に点検させるために渡す
    expect(request.input).toContain("提出された対応");
    expect(request.input).toContain("record.total");
    // 期待の値と試験の合否は、規則・データ・文書のどこにも入らない
    const texts = [request.instructions, ...(request.rules ?? []), request.input, ...request.documents];
    for (const text of texts) {
      expect(text).not.toContain(EXPECTED_SENTINEL);
      expect(text).not.toContain(RESULT_SENTINEL);
    }
  });
});

describe("⑤a の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ entries: "nope" }), structured({ entries: "nope" })]);
    const failed = await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");
  });
});

// ── 「画面から辿れない」項目の落ちは、⑥ 直すに回し、要件 ID を入れる（02 §1.3.1・Issue #324）──

/** 一部の項目を `show` で出し、別の項目を出していない宣言（抽象的な題材） */
const FIELD_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      shown: string",
  "      hidden: string",
  "views:",
  "  - name: records",
  "    type: table",
  "    entity: record",
  "    show: [shown]",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const FIELD_APP = await normalized(FIELD_SOURCE);

const FIELD_ROLES: readonly RoleEntry[] = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null },
  { roleId: "record.shown", kind: "field", entity: "record", name: "shown", shared: true, aliasOf: null },
  { roleId: "record.hidden", kind: "field", entity: "record", name: "hidden", shared: false, aliasOf: null },
];

const FIELD_TABLE: readonly CorrespondenceEntry[] = [
  {
    requirementId: "R-1",
    locations: [
      { kind: "entity", entity: null, name: "record" },
      { kind: "field", entity: "record", name: "shown" },
      { kind: "field", entity: "record", name: "hidden" },
    ],
  },
];

const FIELD_MAPPINGS: readonly RoleNameMapping[] = [
  { roleId: "record", name: "record" },
  { roleId: "record.shown", name: "shown" },
  { roleId: "record.hidden", name: "hidden" },
];

describe("「画面から辿れない」項目の落ちは、⑥ 直すに回し、要件 ID を入れる（02 §1.3.1・Issue #324）", () => {
  it("一覧の `show` に出ていない項目の落ちに、もとの要件 ID と、⑥ 直すの行き先を付ける", () => {
    const misses = checkRoleMappings(FIELD_APP, FIELD_ROLES, FIELD_TABLE, FIELD_MAPPINGS, {
      version: LEGACY_DESIGN_CONTRACT,
    });
    const miss = misses.find((candidate) => candidate.location?.name === "hidden");
    expect(miss).toBeDefined();
    // ③ のやり直しではなく、宣言の要素の欠落として ⑥ 直すへ回す（Issue #324）
    expect(miss?.route).toBe("missing-element");
    // 落ちには、その場所を挙げている要件の ID を入れる（空にしない）
    expect(miss?.requirementId).toBe("R-1");
    expect(miss?.detail).toContain("画面から辿れない");
  });

  it("`show` に出ている項目は、落ちにしない", () => {
    const misses = checkRoleMappings(FIELD_APP, FIELD_ROLES, FIELD_TABLE, FIELD_MAPPINGS, {
      version: LEGACY_DESIGN_CONTRACT,
    });
    expect(misses.some((miss) => miss.location?.name === "shown")).toBe(false);
  });

  it("実在しない名前の落ちには、③ のやり直しの行き先を付ける", () => {
    const misses = checkRoleMappings(
      FIELD_APP,
      FIELD_ROLES,
      FIELD_TABLE,
      [
        { roleId: "record", name: "record" },
        { roleId: "record.shown", name: "ghost" },
        { roleId: "record.hidden", name: "hidden" },
      ],
      { version: LEGACY_DESIGN_CONTRACT },
    );
    const miss = misses.find((candidate) => candidate.location?.name === "ghost");
    expect(miss?.route).toBe("correspondence-defect");
  });
});

// ── 要件ごとの所属を、⑤a が独立に点検する（新契約。Issue #431）────────────────

/** 新契約の役割 ID の表（entity `record`・項目 `amount`・計算 `total`） */
const PERMS_ROLES: readonly RoleEntry[] = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
];

/** 3 つの役割すべての対応（名前は宣言に実在する） */
const PERMS_MAPPINGS: readonly RoleNameMapping[] = [
  { roleId: "record", name: "record" },
  { roleId: "record.amount", name: "amount" },
  { roleId: "record.total", name: "total" },
];

/** R-1 が、名指しされない項目 `amount` を含めて 3 つの役割に所属する（新契約） */
const PERMS_OWNERSHIP: readonly RequirementRoleOwnership[] = [
  {
    requirementId: "R-1",
    ownership: [
      { roleId: "record", basis: "dependency", reason: "行の所属として参照するため" },
      { roleId: "record.amount", basis: "dependency", reason: "入力の行に保存する項目として参照するため" },
      { roleId: "record.total", basis: "stated", reason: null },
    ],
  },
];

const permsCheck = (
  entries: readonly CorrespondenceEntry[],
  mappings: readonly RoleNameMapping[] = PERMS_MAPPINGS,
  ownership: readonly RequirementRoleOwnership[] = PERMS_OWNERSHIP,
) => checkRoleMappings(APP, PERMS_ROLES, entries, mappings, { ownership });

describe("要件ごとの所属を、⑤a が独立に点検する（新契約。Issue #431）", () => {
  it("所属の場所がその要件の対応表の外にあり、宣言に実在するときは、要件 ID と場所つきで ⑤a のやり直しに回す", () => {
    // R-1 の対応表は entity record と計算 total だけを挙げ、項目 amount を挙げていない
    const table: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ];
    const misses = permsCheck(table);
    const miss = misses.find((candidate) => candidate.route === "correspondence-redo");
    expect(miss).toBeDefined();
    expect(miss?.requirementId).toBe("R-1");
    expect(miss?.location).toEqual({ kind: "field", entity: "record", name: "amount" });
  });

  it("同じ例で、対応の名前が宣言に無ければ correspondence-defect になる", () => {
    const table: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ];
    const ghost = PERMS_MAPPINGS.map((mapping) =>
      mapping.roleId === "record.amount" ? { roleId: "record.amount", name: "ghost" } : mapping,
    );
    const misses = permsCheck(table, ghost);
    const miss = misses.find(
      (candidate) => candidate.requirementId === "R-1" && candidate.location?.name === "ghost",
    );
    expect(miss?.route).toBe("correspondence-defect");
  });

  it("同じ操作を 2 要件が所属させ、対応表が片方にだけ載せた例では、もう片方の要件 ID で落ちる（表全体では通っていた）", () => {
    const ownership: readonly RequirementRoleOwnership[] = [
      {
        requirementId: "R-1",
        ownership: [
          { roleId: "record", basis: "dependency", reason: "行の所属として参照するため" },
          { roleId: "record.total", basis: "stated", reason: null },
        ],
      },
      {
        requirementId: "R-2",
        ownership: [
          { roleId: "record", basis: "dependency", reason: "行の所属として参照するため" },
          // 同じ操作（計算 total）を R-2 も所属させている
          { roleId: "record.total", basis: "dependency", reason: "同じ計算を共有するため" },
        ],
      },
    ];
    // 対応表は R-1 にだけ total を載せ、R-2 には載せていない（表全体では total が挙がっている＝通っていた）
    const table: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
      { requirementId: "R-2", locations: [{ kind: "entity", entity: null, name: "record" }] },
    ];
    const misses = permsCheck(table, PERMS_MAPPINGS, ownership);
    const miss = misses.find(
      (candidate) => candidate.route === "correspondence-redo" && candidate.location?.name === "total",
    );
    expect(miss?.requirementId).toBe("R-2");
  });

  it("表の役割の対応が提出されていなければ correspondence-defect で、要件 ID が空でない", () => {
    const table: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "field", entity: "record", name: "amount" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ];
    const missing = PERMS_MAPPINGS.filter((mapping) => mapping.roleId !== "record.amount");
    const misses = permsCheck(table, missing);
    const miss = misses.find((candidate) => candidate.detail.includes("提出されていない"));
    expect(miss?.route).toBe("correspondence-defect");
    expect(miss?.requirementId).not.toBe("");
  });

  it("表の役割の対応が重複していれば correspondence-defect で、要件 ID が空でない", () => {
    const table: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "field", entity: "record", name: "amount" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ];
    const duplicated = [...PERMS_MAPPINGS, { roleId: "record.total", name: "total" }];
    const misses = permsCheck(table, duplicated);
    const miss = misses.find((candidate) => candidate.detail.includes("重複"));
    expect(miss?.route).toBe("correspondence-defect");
    expect(miss?.requirementId).not.toBe("");
  });
});

describe("⑤a の要求に、要件ごとの所属を別のデータで渡す（新契約。Issue #431）", () => {
  const EXPECTED_SENTINEL = "EXPECTED_VALUE_SENTINEL";
  const PLACEMENT_SENTINEL = "PLACEMENT_SENTINEL";
  const NOTES_SENTINEL = "NOTES_SENTINEL";
  const answer = {
    entries: [{ requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] }],
  };

  it("要件ごとの所属は別の <data name= で入り、期待の値・合否・placement・notes の目印は入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const input = {
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      roles: PERMS_ROLES,
      mappings: PERMS_MAPPINGS,
      ownership: PERMS_OWNERSHIP,
      // 期待の値・合否・設計の自由文に当たる余分な欄（点検役へ渡ってはならない）
      expected: { kind: "ok", value: EXPECTED_SENTINEL },
      testRun: { mismatches: [{ testId: EXPECTED_SENTINEL, detail: EXPECTED_SENTINEL }], unresolved: [] },
      placement: [PLACEMENT_SENTINEL],
      notes: [NOTES_SENTINEL],
    } as unknown as CorrespondenceInput;
    await runCorrespondence(input);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input).toContain(`<data name="要件ごとの所属">`);
    expect(request.input).toContain("record.amount");
    const texts = [request.instructions, ...(request.rules ?? []), request.input, ...request.documents];
    for (const text of texts) {
      expect(text).not.toContain(EXPECTED_SENTINEL);
      expect(text).not.toContain(PLACEMENT_SENTINEL);
      expect(text).not.toContain(NOTES_SENTINEL);
    }
  });
});

describe("⑤a の規則：申告を独立に点検し、実在だけで足させない（Issue #431）", () => {
  it("規則の文に「実在するので…挙げる」が無く、申告・独立に点検・実在だけで挙げない・追認の文がある", () => {
    const rules = CORRESPONDENCE_RULES.join("\n");
    expect(rules).not.toContain("実在するので、その要件を満たす場所として挙げる");
    expect(rules).toContain("申告");
    expect(rules).toContain("独立に点検");
    expect(rules).toContain("実在するという理由だけで場所を挙げない");
    expect(rules).toContain("追認");
    // やり直しの規則にも、実在だけで挙げる文は無い
    expect(CORRESPONDENCE_REDO_RULE).not.toContain("実在するので、その要件を満たす場所として挙げる");
    for (const definition of [
      ...CORRESPONDENCE_RULE_DEFINITIONS,
      CORRESPONDENCE_REDO_DEFINITION,
      CORRESPONDENCE_SETTLED_DEFINITION,
    ]) {
      expect(definition.text).not.toContain("実在するので、その要件を満たす場所として挙げる");
    }
  });

  it("やり直しの要求のデータに、前回の落ちが要件 ID と場所つきで入る", async () => {
    const recording = createRecordingClient([structured({ entries: [] })]);
    await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      roles: PERMS_ROLES,
      mappings: PERMS_MAPPINGS,
      ownership: PERMS_OWNERSHIP,
      previousMisses: [
        { requirementId: "R-1", location: { kind: "field", entity: "record", name: "amount" }, detail: "要件 R-1 の対応表に無い" },
      ],
    });
    const request = recording.structured[0];
    expect(request?.input).toContain("前回の対応表の落ち");
    expect(request?.input).toContain("R-1");
    expect(request?.input).toContain("amount");
    expect(request?.rules ?? []).toContain(CORRESPONDENCE_REDO_RULE);
  });
});

describe("⑤a の規則の定義の整合（Issue #431）", () => {
  const ALL_DEFINITIONS = [
    ...CORRESPONDENCE_RULE_DEFINITIONS,
    CORRESPONDENCE_REDO_DEFINITION,
    CORRESPONDENCE_SETTLED_DEFINITION,
  ];

  it("配列は 9 件で、やり直し・確定した仕様と合わせて、ID の重複が無く why・since が空でない", () => {
    expect(CORRESPONDENCE_RULE_DEFINITIONS).toHaveLength(9);
    expect(ruleDefinitionDefects(ALL_DEFINITIONS)).toEqual([]);
  });

  it("送信用の配列と単独の文が、定義の text と順まで一致する", () => {
    expect(CORRESPONDENCE_RULES).toEqual(ruleTexts(CORRESPONDENCE_RULE_DEFINITIONS));
    expect(CORRESPONDENCE_REDO_RULE).toBe(CORRESPONDENCE_REDO_DEFINITION.text);
    expect(CORRESPONDENCE_SETTLED_RULE).toBe(CORRESPONDENCE_SETTLED_DEFINITION.text);
  });

  it("要求の規則の文が、定義の text の結合と一致する（やり直しの規則を含む）", async () => {
    const plain = createRecordingClient([structured({ entries: [] })]);
    await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(plain.client, { maxAttempts: 1 }),
      roles: PERMS_ROLES,
      mappings: PERMS_MAPPINGS,
      ownership: PERMS_OWNERSHIP,
    });
    expect(plain.structured[0]?.rules ?? []).toEqual(ruleTexts(CORRESPONDENCE_RULE_DEFINITIONS));

    const redo = createRecordingClient([structured({ entries: [] })]);
    await runCorrespondence({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      declaration: DECLARATION,
      app: APP,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(redo.client, { maxAttempts: 1 }),
      roles: PERMS_ROLES,
      mappings: PERMS_MAPPINGS,
      ownership: PERMS_OWNERSHIP,
      previousMisses: [{ requirementId: "R-1", detail: "対応表の外" }],
    });
    expect(redo.structured[0]?.rules ?? []).toEqual([
      ...ruleTexts(CORRESPONDENCE_RULE_DEFINITIONS),
      CORRESPONDENCE_REDO_DEFINITION.text,
    ]);
  });
});

// ── 確定した仕様が正本で、一覧の文は補足である（§5・Issue #391）──────────────

describe("確定した仕様が正本で、一覧の文は補足である（§5・Issue #391）", () => {
  it("確定した仕様を渡したときの決まりの文に、正本と補足の旨がある", () => {
    expect(CORRESPONDENCE_SETTLED_RULE).toContain("正本");
    expect(CORRESPONDENCE_SETTLED_RULE).toContain("補足");
  });
});

// ── 新契約で所属が欠けた入力は、照合なしの成功にしない（Issue #431・レビュー 1）──

describe("新契約で所属が欠けた入力は、照合なしの成功にしない（Issue #431）", () => {
  /** 全ての所属の場所が対応表の内側にある（所属さえあれば落ちにしない） */
  const completeTable: readonly CorrespondenceEntry[] = [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "field", entity: "record", name: "amount" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
  ];

  it("所属を渡さなければ（版も省略）、要件ごとの照合を省略せず、入力の不備として断る", () => {
    // 所属が無いと、要件ごとの照合は一度も走らず、表全体の内側の検査にも戻らない＝黙って通ってしまう
    const misses = checkRoleMappings(APP, PERMS_ROLES, completeTable, PERMS_MAPPINGS);
    expect(misses.some((miss) => miss.detail.includes("入力の不備"))).toBe(true);
    expect(misses).not.toEqual([]);
  });

  it("所属が空でも、入力の不備として断る", () => {
    const misses = checkRoleMappings(APP, PERMS_ROLES, completeTable, PERMS_MAPPINGS, { ownership: [] });
    expect(misses.some((miss) => miss.detail.includes("入力の不備"))).toBe(true);
  });

  it("所属があり、対応表から所属の場所を落としていれば、黙って通らない（⑤a のやり直し／③ の不備）", () => {
    const shortTable: readonly CorrespondenceEntry[] = [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ];
    const misses = checkRoleMappings(APP, PERMS_ROLES, shortTable, PERMS_MAPPINGS, {
      ownership: PERMS_OWNERSHIP,
    });
    expect(misses.some((miss) => miss.route === "correspondence-redo")).toBe(true);
  });
});

// ── 所属 entity の対応が無いときは、null の場所で実在と誤認しない（レビュー 2）──

describe("所属 entity の対応が無いときは、null の場所で実在と誤認しない（Issue #431）", () => {
  const roles: readonly RoleEntry[] = [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
  ];
  // 計算の対応（record.total → total）は正しいが、所属 entity の対応（record）だけ欠けている
  const mappings: readonly RoleNameMapping[] = [{ roleId: "record.total", name: "total" }];
  const ownership: readonly RequirementRoleOwnership[] = [
    {
      requirementId: "R-1",
      ownership: [
        { roleId: "record", basis: "dependency", reason: "行の所属として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
  ];

  it("所属 entity の mapping が引けない役割は、null の場所を組まず correspondence-redo を足さない", () => {
    // 場所を未確定として扱い、実在（entity を問わない）と誤認しない。③ の不備は別に出す
    const misses = checkRoleMappings(APP, roles, [entry("R-1", [])], mappings, { ownership });
    expect(misses.some((miss) => miss.route === "correspondence-redo")).toBe(false);
    // ③ の対応そのものの不備（entity の mapping 欠落）は落ちとして残る
    expect(misses.some((miss) => miss.route === "correspondence-defect")).toBe(true);
  });
});

