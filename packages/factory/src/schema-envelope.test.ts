// 全段で同じ「封筒」の schema（#353）の unit テスト。
//
// ここで固定したいのは 4 つ。
//   1. **全段の schema から封筒を作る**——構造化出力を使う段がすべて枝として入る
//   2. **同じ入力なら同じバイト列**——封筒の組み立ては純粋で、枝の並びも決まっている
//   3. **枝ごとに `stage` の判別子がある**——`enum` が 1 つの文字列
//   4. **strict の決まりを満たす**——object は `additionalProperties: false`、すべての欄が `required`
//   5. **v1.1α の段は別の封筒**（`stage-envelope-v11a`。Issue #511）——v1 の一覧・名前・実体は変わらず、
//      v1 の封筒に v1.1α の段の名前が 1 つも入らない
//   6. **経路 v1.2 の封筒は 1 つ**（`stage-envelope-v12`。Issue #588）——一覧は旗の組から導き、旗 on の段も台帳の
//      導出を持たない段も同じ実体を送る。v1・v1.1α の名前・一覧・実体は変わらない
//   7. **旗 ids on の v1.2 は識別子 `v1.2-ids`**（Issue #682）——名前・一覧・段の順は `v1.2` と同じで、違う枝は C2（検査の種類ごと
//      の欄）だけ。識別子 `v1.2`（ids off）・v1.1a・v1 の封筒は名前もバイト列も直す前と同じ
//
// 実 API は呼ばない。封筒は組み立てるだけで、送るのは adapter（openai.ts。試験は openai.test.ts）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_IDS,
  ENVELOPE_RESULT_KEY,
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_SCHEMA_NAME_V11A,
  ENVELOPE_SCHEMA_NAME_V12,
  ENVELOPE_SCHEMA_V11A,
  ENVELOPE_SCHEMA_V12,
  ENVELOPE_SCHEMA_V12_IDS,
  ENVELOPE_SCHEMA_V12_LEDGER,
  ENVELOPE_STAGE_KEY,
  STAGE_ENVELOPE_ENTRIES,
  STAGE_ENVELOPE_ENTRIES_V11A,
  STAGE_ENVELOPE_ENTRIES_V12,
  STAGE_ENVELOPE_ENTRIES_V12_IDS,
  STAGE_ENVELOPE_ENTRIES_V12_LEDGER,
  buildEnvelopeSchema,
  buildStageBranch,
  envelopeOf,
  envelopeStageFor,
  resolveStageEnvelope,
  stageEnvelopeEntriesV12Of,
  type StageEnvelopeEntry,
} from "./schema-envelope.js";
import { SURFACE_DIFF_SCHEMA_NAME } from "./plan/surface.js";
import { NAME_TABLE_SCHEMA, NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf } from "./v11a/stages/name-table.js";
import { SEMANTIC_CHECK_IDS_SCHEMA, SEMANTIC_CHECK_SCHEMA, SEMANTIC_CHECK_SCHEMA_NAME } from "./v11a/stages/semantic-check.js";
import { TEST_SPEC_SCHEMA_NAME, testSpecSchemaOf } from "./v11a/stages/test-spec.js";
import { PROPERTY_LEDGER_VIEW, V12_FLAGS_OFF, V12_PIPELINE_FLAGS, fromPublicV12Flags } from "./v12/ledger.js";
import { VOCABULARY_BUNDLES } from "./v12/ids.js";
import { MAPPING_SCHEMA_NAME, legacyMappingSchemaOf, mappingSchemaOf } from "./v12/stages/mapping.js";
import { VOCABULARY_SCHEMA_NAMES, vocabularySchemaOf } from "./v12/stages/vocabulary.js";

/** 旗 v12.ids の段の枝の名前（Issue #593） */
const IDS_STAGES = ["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 1 つの schema を再帰的に走査し、strict の決まりに反する箇所を集める（`stages/schema-strict.test.ts`
 * と同じ規則。対象は**枝**——封筒の `result` は `anyOf` の入れ物なので、ここには掛けない）。
 */
function strictProblems(schema: unknown): readonly string[] {
  const problems: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      problems.push(`${path}: schema が写像（object）でない`);
      return;
    }
    const type = node["type"];
    const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : undefined;
    if (types === undefined) problems.push(`${path}: type が無い`);
    if (types?.includes("object")) {
      if (node["additionalProperties"] !== false) {
        problems.push(`${path}: object の additionalProperties が false でない`);
      }
      const properties = node["properties"];
      if (properties === undefined) {
        const required = node["required"];
        if (required !== undefined && (!Array.isArray(required) || required.length > 0)) {
          problems.push(`${path}: properties が無いのに required がある`);
        }
      } else if (!isRecord(properties)) {
        problems.push(`${path}: properties が写像（object）でない`);
      } else {
        const required = Array.isArray(node["required"]) ? node["required"] : [];
        const listed = new Set(required.filter((key): key is string => typeof key === "string"));
        for (const key of Object.keys(properties)) {
          if (!listed.has(key)) problems.push(`${path}: 欄 ${key} が required に無い`);
        }
        for (const [key, child] of Object.entries(properties)) {
          walk(child, `${path}/properties/${key}`);
        }
      }
    }
    if (types?.includes("array")) {
      const items = node["items"];
      if (items === undefined) {
        problems.push(`${path}: array の items が無い`);
      } else if (Array.isArray(items)) {
        items.forEach((child, index) => walk(child, `${path}/items/${index}`));
      } else {
        walk(items, `${path}/items`);
      }
    }
    for (const branch of ["anyOf", "oneOf", "allOf"]) {
      const list = node[branch];
      if (Array.isArray(list)) list.forEach((child, index) => walk(child, `${path}/${branch}/${index}`));
    }
  };
  walk(schema, "#");
  return problems;
}

/** 封筒を、この試験で読みやすい形にする */
const envelope = ENVELOPE_SCHEMA as {
  readonly type: string;
  readonly additionalProperties: boolean;
  readonly required: readonly string[];
  readonly properties: Record<string, unknown>;
};

/** 封筒の `result`（枝の `anyOf`） */
function resultSchema(): { readonly anyOf: readonly Record<string, unknown>[] } {
  return envelope.properties[ENVELOPE_RESULT_KEY] as { readonly anyOf: readonly Record<string, unknown>[] };
}

describe("全段で同じ「封筒」の schema（02 §2・#353）", () => {
  it("封筒には、構造化出力を使う段がすべて枝として入る", () => {
    // 枝の並びは、段の一覧の並び（決まった順）である
    expect(STAGE_ENVELOPE_ENTRIES.map((entry) => entry.stage)).toEqual([
      "plan-surface",
      "plan-questions",
      "requirement-list",
      "reverse-check",
      "requirement-design",
      "test-suite",
      "declaration",
      "requirement-correspondence",
      "expectation-arbitration",
      "role-name-mappings",
    ]);
    expect(resultSchema().anyOf).toHaveLength(STAGE_ENVELOPE_ENTRIES.length);
  });

  it("封筒の名前は全段で同じ値（`text.format.name`）", () => {
    expect(ENVELOPE_SCHEMA_NAME).toBe("stage-envelope");
    expect(typeof ENVELOPE_SCHEMA_NAME).toBe("string");
  });

  it("同じ入力なら同じバイト列（組み立ては純粋で、枝の並びも決まっている）", () => {
    const once = JSON.stringify(buildEnvelopeSchema());
    const twice = JSON.stringify(buildEnvelopeSchema());
    expect(twice).toBe(once);
    // 一度組んだ封筒も、同じ入力から組み直したものと同じ
    expect(JSON.stringify(ENVELOPE_SCHEMA)).toBe(once);
    // 枝の並びは、段の一覧の並びと一致する
    expect(resultSchema().anyOf.map((branch) => (branch.properties as Record<string, unknown>)[ENVELOPE_STAGE_KEY])).toEqual(
      STAGE_ENVELOPE_ENTRIES.map((entry) => ({
        type: "string",
        enum: [entry.stage],
        description: `この枝の段（${entry.stage}）`,
      })),
    );
  });

  it("封筒の入れ物（object）は、すべての欄が required で additionalProperties が false", () => {
    expect(envelope.type).toBe("object");
    expect(envelope.additionalProperties).toBe(false);
    expect(envelope.required).toEqual([ENVELOPE_RESULT_KEY]);
    expect(Object.keys(envelope.properties)).toEqual([ENVELOPE_RESULT_KEY]);
  });

  it("枝ごとに `stage` の判別子がある（`enum` が 1 つだけ）", () => {
    for (const [index, entry] of STAGE_ENVELOPE_ENTRIES.entries()) {
      const branch = resultSchema().anyOf[index] as Record<string, unknown>;
      const stage = (branch.properties as Record<string, unknown>)[ENVELOPE_STAGE_KEY] as {
        readonly type: string;
        readonly enum: readonly string[];
      };
      expect(stage.type, entry.stage).toBe("string");
      expect(stage.enum, entry.stage).toEqual([entry.stage]);
      expect((branch.required as readonly string[]).includes(ENVELOPE_STAGE_KEY), entry.stage).toBe(true);
    }
  });

  it.each(STAGE_ENVELOPE_ENTRIES)("$stage の枝が strict の決まりに合う", (entry: StageEnvelopeEntry) => {
    const branch = buildStageBranch(entry);
    expect(strictProblems(branch)).toEqual([]);
    // 段の schema の欄はそのまま残り、`stage` が先頭に足される
    const base = entry.schema as { readonly properties: Record<string, unknown> };
    expect(Object.keys(branch.properties as Record<string, unknown>)).toEqual([
      ENVELOPE_STAGE_KEY,
      ...Object.keys(base.properties),
    ]);
  });

  it("要件の段の枝は framing を必須にし、1 件の形（引用・位置）を入れ子で定める（Issue #372）", () => {
    const entry = STAGE_ENVELOPE_ENTRIES.find((candidate) => candidate.stage === "requirement-list");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const branch = buildStageBranch(entry);
    expect(strictProblems(branch)).toEqual([]);
    const required = branch.required as readonly string[];
    expect(required).toContain("framing");
    const properties = branch.properties as Record<string, unknown>;
    const framing = properties["framing"] as Record<string, unknown>;
    expect(framing.type).toBe("array");
    const items = framing.items as Record<string, unknown>;
    expect(items.type).toBe("object");
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["quote", "position"]);
    const itemProperties = items.properties as Record<string, unknown>;
    expect(itemProperties["quote"]).toMatchObject({ type: "string" });
    const position = itemProperties["position"] as Record<string, unknown>;
    expect(position.type).toBe("object");
    expect(position.required).toEqual(["start", "end"]);
  });

  it("試験の段の枝に assertion の欄があり、設計の段の枝に checks の欄がある（Issue #386）", () => {
    const testSuiteEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "test-suite");
    const designEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "requirement-design");
    expect(testSuiteEntry).toBeDefined();
    expect(designEntry).toBeDefined();
    if (testSuiteEntry === undefined || designEntry === undefined) return;

    const testBranch = buildStageBranch(testSuiteEntry);
    expect(strictProblems(testBranch)).toEqual([]);
    const testItems = (testBranch.properties as Record<string, unknown>)["tests"] as Record<string, unknown>;
    const testItem = testItems.items as Record<string, unknown>;
    expect(testItem.required as readonly string[]).toContain("assertion");
    const assertion = (testItem.properties as Record<string, unknown>)["assertion"] as Record<string, unknown>;
    expect(assertion.type).toEqual(["object", "null"]);
    const assertionProps = assertion.properties as Record<string, unknown>;
    for (const key of ["check", "expected", "refEntity", "role"]) {
      expect(Object.keys(assertionProps), key).toContain(key);
    }

    const designBranch = buildStageBranch(designEntry);
    expect(strictProblems(designBranch)).toEqual([]);
    const designItems = (designBranch.properties as Record<string, unknown>)["designs"] as Record<string, unknown>;
    const designItem = designItems.items as Record<string, unknown>;
    expect(designItem.required as readonly string[]).toContain("checks");
    const checks = (designItem.properties as Record<string, unknown>)["checks"] as Record<string, unknown>;
    expect(checks.type).toBe("array");
  });

  it("試験の段と設計の段の枝に、write-anonymous が入る（Issue #393）", () => {
    const testSuiteEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "test-suite");
    const designEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "requirement-design");
    expect(testSuiteEntry).toBeDefined();
    expect(designEntry).toBeDefined();
    if (testSuiteEntry === undefined || designEntry === undefined) return;

    const testBranch = buildStageBranch(testSuiteEntry);
    const testItems = (testBranch.properties as Record<string, unknown>)["tests"] as Record<string, unknown>;
    const testItem = testItems.items as Record<string, unknown>;
    const assertion = (testItem.properties as Record<string, unknown>)["assertion"] as Record<string, unknown>;
    const check = (assertion.properties as Record<string, unknown>)["check"] as { readonly enum: readonly string[] };
    expect(check.enum).toContain("write-anonymous");

    const designBranch = buildStageBranch(designEntry);
    const designItems = (designBranch.properties as Record<string, unknown>)["designs"] as Record<string, unknown>;
    const designItem = designItems.items as Record<string, unknown>;
    const branchChecks = (designItem.properties as Record<string, unknown>)["checks"] as Record<string, unknown>;
    const branchCheckItems = branchChecks.items as { readonly enum: readonly string[] };
    expect(branchCheckItems.enum).toContain("write-anonymous");
  });

  it("設計の段の枝に、選択肢（options）と所属（ownership）の欄があり、required で strict（Issue #418）", () => {
    const designEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "requirement-design");
    expect(designEntry).toBeDefined();
    if (designEntry === undefined) return;

    const designBranch = buildStageBranch(designEntry);
    expect(strictProblems(designBranch)).toEqual([]);
    // 役割 ID の表の行に、選択肢（options）が required で入る
    const roles = (designBranch.properties as Record<string, unknown>)["roles"] as Record<string, unknown>;
    const roleItem = roles.items as Record<string, unknown>;
    expect(roleItem.required as readonly string[]).toContain("options");
    expect(strictProblems(roleItem)).toEqual([]);
    // 要件ごとの設計に、所属（ownership）が required で入る
    const designs = (designBranch.properties as Record<string, unknown>)["designs"] as Record<string, unknown>;
    const designItem = designs.items as Record<string, unknown>;
    expect(designItem.required as readonly string[]).toContain("ownership");
    const ownership = (designItem.properties as Record<string, unknown>)["ownership"] as Record<string, unknown>;
    expect(ownership.type).toBe("array");
    expect(strictProblems(ownership)).toEqual([]);
  });

  it("設計の段の枝の役割の行に、見出しの元の項目（groupBy）が required で入る（Issue #433）", () => {
    const designEntry = STAGE_ENVELOPE_ENTRIES.find((entry) => entry.stage === "requirement-design");
    expect(designEntry).toBeDefined();
    if (designEntry === undefined) return;

    const designBranch = buildStageBranch(designEntry);
    expect(strictProblems(designBranch)).toEqual([]);
    const roles = (designBranch.properties as Record<string, unknown>)["roles"] as Record<string, unknown>;
    const roleItem = roles.items as Record<string, unknown>;
    expect(roleItem.required as readonly string[]).toContain("groupBy");
    const groupBy = (roleItem.properties as Record<string, unknown>)["groupBy"] as Record<string, unknown>;
    expect(groupBy.type).toEqual(["string", "null"]);
    expect(strictProblems(roleItem)).toEqual([]);
  });

  it("段の名前から、その枝（段の schema）を引ける", () => {
    for (const entry of STAGE_ENVELOPE_ENTRIES) {
      expect(envelopeStageFor(entry.stage)?.schema, entry.stage).toBe(entry.schema);
    }
    // 封筒に載っていない schema（判定の口など）は引けない——adapter は封筒を送らない
    expect(envelopeStageFor("judge-answers")).toBeUndefined();
    expect(envelopeStageFor("out")).toBeUndefined();
  });
});

// ── v1.1α の封筒（07-architecture-v1.1a.md §3・D12・Issue #511）────────────────

/** v1.1α の段の名前（決まった順。⑥' の裁定は v1 と共有する） */
const V11A_STAGES = [
  "name-table",
  "semantic-check",
  "test-spec",
  "declaration-v11a",
  "decl-check",
  "expectation-arbitration",
] as const;

describe("v1.1α の段は別の封筒に入れ、v1 の封筒は変えない（D12・Issue #511）", () => {
  it("封筒の識別子は v1・v1.1a・v1.2・v1.2-ids（v1.2 は Issue #588。v1.2-ids は Issue #682）", () => {
    expect(ENVELOPE_IDS).toEqual(["v1", "v1.1a", "v1.2", "v1.2-ids"]);
  });

  it("v1 の一覧はちょうど今の 10 段の名前と順で、引数なしの組み立てが ENVELOPE_SCHEMA と深く等しい", () => {
    expect(STAGE_ENVELOPE_ENTRIES.map((entry) => entry.stage)).toEqual([
      "plan-surface",
      "plan-questions",
      "requirement-list",
      "reverse-check",
      "requirement-design",
      "test-suite",
      "declaration",
      "requirement-correspondence",
      "expectation-arbitration",
      "role-name-mappings",
    ]);
    expect(buildEnvelopeSchema()).toEqual(ENVELOPE_SCHEMA);
    expect(ENVELOPE_SCHEMA_NAME).toBe("stage-envelope");
  });

  it("v1 の封筒の JSON に v1.1a の段の名前が 1 つも無い（共有の裁定を除く）", () => {
    const json = JSON.stringify(ENVELOPE_SCHEMA);
    for (const stage of V11A_STAGES.filter((name) => name !== "expectation-arbitration")) {
      expect(json.includes(`"${stage}"`), stage).toBe(false);
    }
    expect(json.includes(ENVELOPE_SCHEMA_NAME_V11A)).toBe(false);
  });

  it("v1.1a の封筒は名前 stage-envelope-v11a で、決まった順の 6 枝", () => {
    expect(ENVELOPE_SCHEMA_NAME_V11A).toBe("stage-envelope-v11a");
    expect(STAGE_ENVELOPE_ENTRIES_V11A.map((entry) => entry.stage)).toEqual([...V11A_STAGES]);
    const result = (ENVELOPE_SCHEMA_V11A["properties"] as Record<string, unknown>)[ENVELOPE_RESULT_KEY] as {
      readonly anyOf: readonly Record<string, unknown>[];
    };
    expect(result.anyOf).toHaveLength(6);
    expect(ENVELOPE_SCHEMA_V11A["additionalProperties"]).toBe(false);
    expect(ENVELOPE_SCHEMA_V11A["required"]).toEqual([ENVELOPE_RESULT_KEY]);
  });

  it("v1.1a の枝ごとに stage の判別子（enum 1 つ）があり、全欄が required で additionalProperties が false", () => {
    const result = (ENVELOPE_SCHEMA_V11A["properties"] as Record<string, unknown>)[ENVELOPE_RESULT_KEY] as {
      readonly anyOf: readonly Record<string, unknown>[];
    };
    for (const [index, entry] of STAGE_ENVELOPE_ENTRIES_V11A.entries()) {
      const branch = result.anyOf[index] as Record<string, unknown>;
      const stage = (branch["properties"] as Record<string, unknown>)[ENVELOPE_STAGE_KEY] as {
        readonly type: string;
        readonly enum: readonly string[];
      };
      expect(stage.type, entry.stage).toBe("string");
      expect(stage.enum, entry.stage).toEqual([entry.stage]);
      expect(branch["additionalProperties"], entry.stage).toBe(false);
      expect(strictProblems(branch), entry.stage).toEqual([]);
    }
  });

  it("v1.1a の封筒も、同じ入力なら同じバイト列", () => {
    const once = JSON.stringify(buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V11A));
    expect(JSON.stringify(buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V11A))).toBe(once);
    expect(JSON.stringify(ENVELOPE_SCHEMA_V11A)).toBe(once);
  });

  it("envelopeStageFor は既定（v1）で v1.1a の名前を引けず、\"v1.1a\" で引ける", () => {
    for (const entry of STAGE_ENVELOPE_ENTRIES_V11A) {
      expect(envelopeStageFor(entry.stage, "v1.1a")?.schema, entry.stage).toBe(entry.schema);
    }
    for (const stage of V11A_STAGES.filter((name) => name !== "expectation-arbitration")) {
      expect(envelopeStageFor(stage), stage).toBeUndefined();
      expect(envelopeStageFor(stage, "v1"), stage).toBeUndefined();
    }
    // v1 だけの段は v1.1a の封筒から引けない（adapter はその schema をそのまま送る）
    expect(envelopeStageFor("requirement-design", "v1.1a")).toBeUndefined();
    expect(envelopeStageFor("judge-answers", "v1.1a")).toBeUndefined();
  });
});

describe("要求の schema から送る封筒を決める（封筒の枝＝段が渡した schema。Issue #549 の直し）", () => {
  it("段の schema が選んだ封筒の枝と等しければ、その封筒の実体（v1・v1.1a の全段。旗 off は今と同じ）", () => {
    for (const entry of STAGE_ENVELOPE_ENTRIES) {
      const resolved = resolveStageEnvelope(entry.stage, entry.schema);
      expect(resolved?.schema, entry.stage).toBe(ENVELOPE_SCHEMA);
      expect(resolved?.name, entry.stage).toBe(ENVELOPE_SCHEMA_NAME);
      expect(resolved?.entry, entry.stage).toBe(entry);
    }
    for (const entry of STAGE_ENVELOPE_ENTRIES_V11A) {
      const resolved = resolveStageEnvelope(entry.stage, JSON.parse(JSON.stringify(entry.schema)), "v1.1a");
      expect(resolved?.schema, entry.stage).toBe(ENVELOPE_SCHEMA_V11A);
      expect(resolved?.name, entry.stage).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    }
  });

  it("旗 on の封筒は T1・T2 の枝だけが台帳から導いた schema で、ほかの枝は v1.1a と同じ", () => {
    expect(STAGE_ENVELOPE_ENTRIES_V12_LEDGER.map((entry) => entry.stage)).toEqual(
      STAGE_ENVELOPE_ENTRIES_V11A.map((entry) => entry.stage),
    );
    for (const [index, entry] of STAGE_ENVELOPE_ENTRIES_V12_LEDGER.entries()) {
      const expected =
        entry.stage === NAME_TABLE_SCHEMA_NAME
          ? nameTableSchemaOf(PROPERTY_LEDGER_VIEW)
          : entry.stage === TEST_SPEC_SCHEMA_NAME
            ? testSpecSchemaOf(PROPERTY_LEDGER_VIEW)
            : STAGE_ENVELOPE_ENTRIES_V11A[index]?.schema;
      expect(entry.schema, entry.stage).toEqual(expected);
    }
    expect(ENVELOPE_SCHEMA_V12_LEDGER).toEqual(buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12_LEDGER));
    expect(ENVELOPE_SCHEMA_V12_LEDGER).not.toEqual(ENVELOPE_SCHEMA_V11A);
  });

  it("旗 on の T1・T2 の schema（台帳から導いたもの）は、どちらも旗 on の封筒の同じ実体で送る（T1 と T2 の間でキャッシュが当たる）", () => {
    const t1 = resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf(PROPERTY_LEDGER_VIEW), "v1.1a");
    const t2 = resolveStageEnvelope(TEST_SPEC_SCHEMA_NAME, testSpecSchemaOf(PROPERTY_LEDGER_VIEW), "v1.1a");
    expect(t1?.schema).toBe(ENVELOPE_SCHEMA_V12_LEDGER);
    expect(t2?.schema).toBe(ENVELOPE_SCHEMA_V12_LEDGER);
    expect(t1?.name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(t1?.entry.schema).toEqual(nameTableSchemaOf(PROPERTY_LEDGER_VIEW));
    // 台帳の導出を持たない段は、要求の schema が旗 off と同じなので v1.1a の封筒のまま（adapter は要求から旗を区別できない）
    for (const entry of STAGE_ENVELOPE_ENTRIES_V12_LEDGER) {
      if (entry.stage === NAME_TABLE_SCHEMA_NAME || entry.stage === TEST_SPEC_SCHEMA_NAME) continue;
      expect(resolveStageEnvelope(entry.stage, entry.schema, "v1.1a")?.schema, entry.stage).toBe(ENVELOPE_SCHEMA_V11A);
    }
  });

  it("どの封筒の枝とも違う schema は、選んだ封筒のその段の枝だけを差し替える。v1 の封筒では旗 on の封筒を選ばない", () => {
    const custom = { ...NAME_TABLE_SCHEMA, description: "差し替え" };
    const resolved = resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, custom, "v1.1a");
    expect(resolved?.entry).toEqual({ stage: NAME_TABLE_SCHEMA_NAME, schema: custom });
    expect(resolved?.schema).toEqual(
      buildEnvelopeSchema(
        STAGE_ENVELOPE_ENTRIES_V11A.map((entry) =>
          entry.stage === NAME_TABLE_SCHEMA_NAME ? { stage: entry.stage, schema: custom } : entry,
        ),
      ),
    );
    const requirement = STAGE_ENVELOPE_ENTRIES[2] as StageEnvelopeEntry;
    const changed = { ...(requirement.schema as Record<string, unknown>), description: "差し替え" };
    const v1 = resolveStageEnvelope(requirement.stage, changed);
    expect(v1?.name).toBe(ENVELOPE_SCHEMA_NAME);
    expect(v1?.schema).toEqual(
      buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES.map((entry) => (entry === requirement ? { stage: entry.stage, schema: changed } : entry))),
    );
  });

  it("選んだ封筒に載っていない名前は undefined（adapter はその schema をそのまま送る）", () => {
    expect(resolveStageEnvelope("judge-answers", {}, "v1.1a")).toBeUndefined();
    expect(resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA)).toBeUndefined();
    expect(resolveStageEnvelope("requirement-design", {}, "v1.1a")).toBeUndefined();
  });

  it("旗 on の封筒の枝も strict の規則を満たす", () => {
    const result = (ENVELOPE_SCHEMA_V12_LEDGER["properties"] as Record<string, unknown>)[ENVELOPE_RESULT_KEY] as {
      readonly anyOf: readonly Record<string, unknown>[];
    };
    for (const [index, branch] of result.anyOf.entries()) {
      expect(strictProblems(branch), String(index)).toEqual([]);
      expect(branch).toEqual(buildStageBranch(STAGE_ENVELOPE_ENTRIES_V12_LEDGER[index] as StageEnvelopeEntry));
    }
  });
});

describe("経路 v1.2 の封筒は 1 つ（旗の組から導き、全段で同じ実体を送る。Issue #588）", () => {
  const ledgerStages: readonly string[] = [NAME_TABLE_SCHEMA_NAME, TEST_SPEC_SCHEMA_NAME];

  it("v1.2 の封筒は名前 stage-envelope-v12 で、一覧は --pipeline v1.2 の旗の組から導いたもの", () => {
    expect(ENVELOPE_SCHEMA_NAME_V12).toBe("stage-envelope-v12");
    // C2 の枝は旧の schema（ids off の v1.2 の封筒を保つためだけ。Issue #682）、C3 の枝も旧の schema（ids off の v1.2 の C3 は旧の
    // schema で要求する。Issue #700）。ほかの枝は旗の組から導いたもの
    expect(STAGE_ENVELOPE_ENTRIES_V12).toEqual(
      stageEnvelopeEntriesV12Of(fromPublicV12Flags(V12_PIPELINE_FLAGS)).map((entry) =>
        entry.stage === MAPPING_SCHEMA_NAME
          ? { stage: entry.stage, schema: legacyMappingSchemaOf(PROPERTY_LEDGER_VIEW) }
          : entry.stage === SEMANTIC_CHECK_SCHEMA_NAME
            ? { stage: entry.stage, schema: SEMANTIC_CHECK_SCHEMA }
            : entry,
      ),
    );
    expect(ENVELOPE_SCHEMA_V12).toEqual(buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12));
    expect(envelopeOf("v1.2")).toEqual({ name: "stage-envelope-v12", schema: ENVELOPE_SCHEMA_V12, entries: STAGE_ENVELOPE_ENTRIES_V12 });
    expect(envelopeOf("v1.2").schema).toBe(ENVELOPE_SCHEMA_V12);
    // 今の旗の組（ledger on）では、T1・T2 の枝だけが台帳から導いた schema で、ほかの枝は v1.1α と同じ。旗 ids が on なので
    // 末尾に C1 の 3 束と C2 の枝がある（Issue #593。下の describe で照らす）
    expect(STAGE_ENVELOPE_ENTRIES_V12.map((entry) => entry.stage)).toEqual([...V11A_STAGES, ...IDS_STAGES]);
    for (const [index, entry] of STAGE_ENVELOPE_ENTRIES_V12.slice(0, V11A_STAGES.length).entries()) {
      const expected =
        entry.stage === NAME_TABLE_SCHEMA_NAME
          ? nameTableSchemaOf(PROPERTY_LEDGER_VIEW)
          : entry.stage === TEST_SPEC_SCHEMA_NAME
            ? testSpecSchemaOf(PROPERTY_LEDGER_VIEW)
            : STAGE_ENVELOPE_ENTRIES_V11A[index]?.schema;
      expect(entry.schema, entry.stage).toEqual(expected);
    }
    // 旗 ledger が off なら v1.1α と同じ一覧（導出は旗の組だけで決まる）
    expect(stageEnvelopeEntriesV12Of(V12_FLAGS_OFF)).toEqual(STAGE_ENVELOPE_ENTRIES_V11A);
  });

  it("v1.2 の封筒の枝は strict の規則を満たし、T1 の枝の行の型に aggregate がある", () => {
    const result = (ENVELOPE_SCHEMA_V12["properties"] as Record<string, unknown>)[ENVELOPE_RESULT_KEY] as {
      readonly anyOf: readonly Record<string, unknown>[];
    };
    expect(result.anyOf).toHaveLength(STAGE_ENVELOPE_ENTRIES_V12.length);
    for (const [index, branch] of result.anyOf.entries()) {
      expect(strictProblems(branch), String(index)).toEqual([]);
      expect(branch).toEqual(buildStageBranch(STAGE_ENVELOPE_ENTRIES_V12[index] as StageEnvelopeEntry));
    }
    const t1 = result.anyOf[0] as {
      readonly properties: { readonly rows: { readonly items: { readonly properties: { readonly type: { readonly properties: Record<string, unknown> } } } } };
    };
    expect(t1.properties.rows.items.properties.type.properties).toHaveProperty("aggregate");
  });

  it("識別子 v1.2 では、旗 on の T1・T2 と T1''・B1・B3'・B5' が同じ実体の封筒（名前 stage-envelope-v12）を送る", () => {
    const requests = [
      { stage: NAME_TABLE_SCHEMA_NAME, schema: nameTableSchemaOf(PROPERTY_LEDGER_VIEW) },
      { stage: TEST_SPEC_SCHEMA_NAME, schema: testSpecSchemaOf(PROPERTY_LEDGER_VIEW) },
      ...STAGE_ENVELOPE_ENTRIES_V11A.filter((entry) => !ledgerStages.includes(entry.stage)),
    ];
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      const resolved = resolveStageEnvelope(request.stage, JSON.parse(JSON.stringify(request.schema)), "v1.2");
      expect(resolved?.schema, request.stage).toBe(ENVELOPE_SCHEMA_V12);
      expect(resolved?.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V12);
      expect(resolved?.entry.stage, request.stage).toBe(request.stage);
      expect(resolved?.entry.schema, request.stage).toEqual(request.schema);
    }
  });

  it("識別子 v1.2 で枝と違う schema は、v1.2 の封筒のその段の枝だけを差し替える（名前は stage-envelope-v12）", () => {
    // 旗 off の T1 の schema（台帳の導出なし）は v1.2 の枝と違う
    const resolved = resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA, "v1.2");
    expect(resolved?.name).toBe(ENVELOPE_SCHEMA_NAME_V12);
    expect(resolved?.entry).toEqual({ stage: NAME_TABLE_SCHEMA_NAME, schema: NAME_TABLE_SCHEMA });
    expect(resolved?.schema).toEqual(
      buildEnvelopeSchema(
        STAGE_ENVELOPE_ENTRIES_V12.map((entry) =>
          entry.stage === NAME_TABLE_SCHEMA_NAME ? { stage: entry.stage, schema: NAME_TABLE_SCHEMA } : entry,
        ),
      ),
    );
    expect(resolved?.schema).not.toBe(ENVELOPE_SCHEMA_V12);
  });

  it("識別子 v1.2 の一覧に無い名前（判定の口・差分の洗い出し・v1 だけの段）は undefined（その schema をそのまま送る）", () => {
    for (const name of ["judge-answers", SURFACE_DIFF_SCHEMA_NAME, "requirement-design"]) {
      expect(resolveStageEnvelope(name, {}, "v1.2"), name).toBeUndefined();
      expect(envelopeStageFor(name, "v1.2"), name).toBeUndefined();
    }
  });

  it("v1・v1.1α の名前・一覧・実体は v1.2 の封筒と別のまま（v1.2 の名前がどちらの封筒にも無い）", () => {
    expect(envelopeOf("v1").schema).toBe(ENVELOPE_SCHEMA);
    expect(envelopeOf("v1.1a").schema).toBe(ENVELOPE_SCHEMA_V11A);
    expect(envelopeOf("v1.1a").name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(ENVELOPE_SCHEMA_V12).not.toEqual(ENVELOPE_SCHEMA_V11A);
    for (const schema of [ENVELOPE_SCHEMA, ENVELOPE_SCHEMA_V11A]) {
      expect(JSON.stringify(schema).includes(ENVELOPE_SCHEMA_NAME_V12)).toBe(false);
    }
    // 識別子 v1.1a の 2 番目の規則（旗 on の枝と等しければ旗 on の封筒・名前は v1.1α）は今のまま
    const t1 = resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf(PROPERTY_LEDGER_VIEW), "v1.1a");
    expect(t1?.name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(t1?.schema).toBe(ENVELOPE_SCHEMA_V12_LEDGER);
  });
});

describe("旗 v12.ids の C1・C2 の枝は v1.2 の封筒にだけ載る（Issue #593）", () => {
  it("v1.2-ids の封筒の末尾に C1 の 3 束と C2 の枝があり、schema は段が渡すものと同じ導出（strict）。v1.2 の封筒の末尾は C2 だけが旧の schema", () => {
    const tail = STAGE_ENVELOPE_ENTRIES_V12_IDS.slice(V11A_STAGES.length);
    const vocabulary = VOCABULARY_BUNDLES.map((bundle) => ({ stage: VOCABULARY_SCHEMA_NAMES[bundle], schema: vocabularySchemaOf(bundle, PROPERTY_LEDGER_VIEW) }));
    expect(tail).toEqual([...vocabulary, { stage: MAPPING_SCHEMA_NAME, schema: mappingSchemaOf(PROPERTY_LEDGER_VIEW) }]);
    for (const entry of tail) {
      expect(strictProblems(buildStageBranch(entry)), entry.stage).toEqual([]);
      const resolved = resolveStageEnvelope(entry.stage, JSON.parse(JSON.stringify(entry.schema)), "v1.2-ids");
      expect(resolved?.schema, entry.stage).toBe(ENVELOPE_SCHEMA_V12_IDS);
    }
    expect(STAGE_ENVELOPE_ENTRIES_V12.slice(V11A_STAGES.length)).toEqual([
      ...vocabulary,
      { stage: MAPPING_SCHEMA_NAME, schema: legacyMappingSchemaOf(PROPERTY_LEDGER_VIEW) },
    ]);
    for (const entry of STAGE_ENVELOPE_ENTRIES_V12) expect(strictProblems(buildStageBranch(entry)), entry.stage).toEqual([]);
  });

  it("C2 の枝の checks の欄（targetId・sourceId）は v1.2・v1.2-ids の封筒の JSON にだけある。v1・v1.1α の封筒には無い（Issue #594・#682）", () => {
    const branch = STAGE_ENVELOPE_ENTRIES_V12_IDS.find((entry) => entry.stage === MAPPING_SCHEMA_NAME);
    expect(branch?.schema).toEqual(mappingSchemaOf(PROPERTY_LEDGER_VIEW));
    for (const key of ['"targetId"', '"sourceId"']) {
      for (const schema of [ENVELOPE_SCHEMA_V12, ENVELOPE_SCHEMA_V12_IDS]) expect(JSON.stringify(schema).includes(key), key).toBe(true);
      for (const schema of [ENVELOPE_SCHEMA, ENVELOPE_SCHEMA_V11A, ENVELOPE_SCHEMA_V12_LEDGER]) expect(JSON.stringify(schema).includes(key), key).toBe(false);
    }
  });

  it("v1・v1.1α の封筒の JSON に C1・C2 の名前が無く、識別子 v1・v1.1a では引けない", () => {
    for (const name of IDS_STAGES) {
      for (const schema of [ENVELOPE_SCHEMA, ENVELOPE_SCHEMA_V11A]) expect(JSON.stringify(schema).includes(`"${name}"`), name).toBe(false);
      expect(envelopeStageFor(name, "v1"), name).toBeUndefined();
      expect(envelopeStageFor(name, "v1.1a"), name).toBeUndefined();
    }
  });

  it("別名（旗 ledger の封筒）は残し、ids を含まない組に固定する：#588 の一覧（ledger on・ids off の導出）と同じで C1・C2 の枝が無い", () => {
    expect(STAGE_ENVELOPE_ENTRIES_V12_LEDGER).toEqual(stageEnvelopeEntriesV12Of({ ledger: true, ids: false }));
    expect(STAGE_ENVELOPE_ENTRIES_V12_LEDGER).toEqual(stageEnvelopeEntriesV12Of({ ledger: true }));
    expect(STAGE_ENVELOPE_ENTRIES_V12_LEDGER.map((entry) => entry.stage)).toEqual([...V11A_STAGES]);
    for (const name of IDS_STAGES) expect(JSON.stringify(ENVELOPE_SCHEMA_V12_LEDGER).includes(`"${name}"`), name).toBe(false);
    // 識別子 v1.1a の旗 on の library の呼び手は、今までどおり ids を含まない封筒を送る（入口の v1.2 はここを通らない）
    const t1 = resolveStageEnvelope(NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf(PROPERTY_LEDGER_VIEW), "v1.1a");
    expect(t1?.schema).toBe(ENVELOPE_SCHEMA_V12_LEDGER);
    expect(t1?.schema).not.toEqual(ENVELOPE_SCHEMA_V12);
    // 旗 off（全部 off）の v1.2 の導出は v1.1α と同じ一覧のまま
    expect(stageEnvelopeEntriesV12Of({ ledger: false, ids: false })).toBe(STAGE_ENVELOPE_ENTRIES_V11A);
  });
});

describe("旗 ids on の v1.2 は識別子 v1.2-ids の封筒を全段で送る（C2 の枝が検査の種類ごとの欄・C3 の枝が観点ごとの根拠。Issue #682・#700）", () => {
  const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  it("v1.2-ids の封筒は名前 stage-envelope-v12・一覧と段の順は v1.2 と同じで、違う枝は C2 と C3 の 2 つ（ほかの枝は v1.2 と深く等しい。Issue #700）", () => {
    expect(envelopeOf("v1.2-ids")).toEqual({ name: ENVELOPE_SCHEMA_NAME_V12, schema: ENVELOPE_SCHEMA_V12_IDS, entries: STAGE_ENVELOPE_ENTRIES_V12_IDS });
    expect(envelopeOf("v1.2-ids").schema).toBe(ENVELOPE_SCHEMA_V12_IDS);
    expect(STAGE_ENVELOPE_ENTRIES_V12_IDS).toEqual(stageEnvelopeEntriesV12Of(fromPublicV12Flags(V12_PIPELINE_FLAGS)));
    expect(ENVELOPE_SCHEMA_V12_IDS).toEqual(buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12_IDS));
    expect(STAGE_ENVELOPE_ENTRIES_V12_IDS.map((entry) => entry.stage)).toEqual(STAGE_ENVELOPE_ENTRIES_V12.map((entry) => entry.stage));
    const changed = STAGE_ENVELOPE_ENTRIES_V12_IDS.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(STAGE_ENVELOPE_ENTRIES_V12[index]));
    expect(changed.map((entry) => entry.stage)).toEqual([SEMANTIC_CHECK_SCHEMA_NAME, MAPPING_SCHEMA_NAME]);
    // C3 の枝は、ids on は観点ごとの根拠・識別子 v1.2 は旧の schema のまま（Issue #700）
    expect(STAGE_ENVELOPE_ENTRIES_V12_IDS.find((entry) => entry.stage === SEMANTIC_CHECK_SCHEMA_NAME)?.schema).toBe(SEMANTIC_CHECK_IDS_SCHEMA);
    expect(STAGE_ENVELOPE_ENTRIES_V12.find((entry) => entry.stage === SEMANTIC_CHECK_SCHEMA_NAME)?.schema).toBe(SEMANTIC_CHECK_SCHEMA);
    expect(ENVELOPE_SCHEMA_V12_IDS).not.toEqual(ENVELOPE_SCHEMA_V12);
  });

  it("v1.2-ids の封筒の全枝が strict の走査で問題 0。C2 の枝の checks は 6 欄が全部 required で、各欄と checks が null を許し、view-shows だけ sourceId を持つ", () => {
    const result = (ENVELOPE_SCHEMA_V12_IDS["properties"] as Record<string, unknown>)[ENVELOPE_RESULT_KEY] as {
      readonly anyOf: readonly Record<string, unknown>[];
    };
    expect(result.anyOf).toHaveLength(STAGE_ENVELOPE_ENTRIES_V12_IDS.length);
    for (const [index, branch] of result.anyOf.entries()) {
      expect(strictProblems(branch), String(index)).toEqual([]);
      expect(branch).toEqual(buildStageBranch(STAGE_ENVELOPE_ENTRIES_V12_IDS[index] as StageEnvelopeEntry));
    }
    const mapping = result.anyOf.find((branch) => JSON.stringify(branch).includes(`"enum":["${MAPPING_SCHEMA_NAME}"]`)) as Record<string, unknown>;
    const at = (node: unknown, ...keys: readonly string[]): Record<string, unknown> =>
      keys.reduce((current, key) => (current as Record<string, unknown>)[key], node) as Record<string, unknown>;
    const checks = at(mapping, "properties", "requirements", "items", "properties", "verification", "properties", "checks");
    expect(checks["type"]).toEqual(["object", "null"]);
    expect(checks["required"]).toEqual(["field-type", "action-kind", "action-unconditioned", "view-shows", "aggregate-no-period", "write-anonymous"]);
    for (const [name, field] of Object.entries(checks["properties"] as Record<string, Record<string, unknown>>)) {
      expect(field["type"], name).toEqual(["object", "null"]);
      expect(Object.keys(field["properties"] as Record<string, unknown>), name).toEqual(name === "view-shows" ? ["targetId", "sourceId"] : ["targetId"]);
    }
    expect(JSON.stringify(mapping).includes('"anyOf"')).toBe(false);
  });

  it("識別子 v1.2-ids では、C1・C2 と T1''〜B5' の全段が同じ実体（1 種類のバイト列）の封筒を送る。新しい C2 の schema を識別子 v1.2 で送ると第 3 の道（段ごとの差し替え）に落ちる", () => {
    // ids on の C3 は観点ごとの根拠の schema で要求する（Issue #700）
    const requests = [
      { stage: NAME_TABLE_SCHEMA_NAME, schema: nameTableSchemaOf(PROPERTY_LEDGER_VIEW) },
      { stage: TEST_SPEC_SCHEMA_NAME, schema: testSpecSchemaOf(PROPERTY_LEDGER_VIEW) },
      { stage: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_IDS_SCHEMA },
      ...STAGE_ENVELOPE_ENTRIES_V11A.filter(
        (entry) => entry.stage !== NAME_TABLE_SCHEMA_NAME && entry.stage !== TEST_SPEC_SCHEMA_NAME && entry.stage !== SEMANTIC_CHECK_SCHEMA_NAME,
      ),
      ...VOCABULARY_BUNDLES.map((bundle) => ({ stage: VOCABULARY_SCHEMA_NAMES[bundle], schema: vocabularySchemaOf(bundle, PROPERTY_LEDGER_VIEW) })),
      { stage: MAPPING_SCHEMA_NAME, schema: mappingSchemaOf(PROPERTY_LEDGER_VIEW) },
    ];
    expect(requests).toHaveLength(10);
    const sent = new Set<string>();
    for (const request of requests) {
      const resolved = resolveStageEnvelope(request.stage, JSON.parse(JSON.stringify(request.schema)), "v1.2-ids");
      expect(resolved?.schema, request.stage).toBe(ENVELOPE_SCHEMA_V12_IDS);
      expect(resolved?.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V12);
      expect(resolved?.entry.schema, request.stage).toEqual(request.schema);
      sent.add(JSON.stringify({ name: resolved?.name, schema: resolved?.schema }));
    }
    expect(sent.size).toBe(1);
    const viaOld = resolveStageEnvelope(MAPPING_SCHEMA_NAME, mappingSchemaOf(PROPERTY_LEDGER_VIEW), "v1.2");
    expect(viaOld?.schema).not.toBe(ENVELOPE_SCHEMA_V12);
    // 識別子 v1.2 の封筒の C2 の枝だけを差し替えた封筒＝v1.2-ids の封筒の C3 の枝を旧の schema に戻したもの（違う枝が C2 と C3 の 2 つ。Issue #700）
    expect(viaOld?.schema).toEqual(
      buildEnvelopeSchema(
        STAGE_ENVELOPE_ENTRIES_V12_IDS.map((entry) => (entry.stage === SEMANTIC_CHECK_SCHEMA_NAME ? { stage: entry.stage, schema: SEMANTIC_CHECK_SCHEMA } : entry)),
      ),
    );
    expect(viaOld?.schema).not.toEqual(ENVELOPE_SCHEMA_V12_IDS);
  });

  it("識別子 v1.2（ids off の v1.2）・v1.1a・v1 の封筒と旗 ledger の封筒は、名前もバイト列も直す前（d38e132 で測った SHA-256）と同じ", () => {
    // 直す前の値：d38e132 の schema-envelope.ts・mapping.ts で `JSON.stringify(envelopeOf(id))`（名前・schema・一覧）の SHA-256 を
    // 測った値（Issue #682。新しいコードの出力から作っていない）
    expect(sha256(envelopeOf("v1"))).toBe("28740c52eae8c0b7cc644d69dbc099d0174ecc1634ba6628b7e2fa0b4dbe3125");
    expect(sha256(envelopeOf("v1.1a"))).toBe("475734e2330cfb2fd48989734bf0cde89776e2c14706d6cf0ab8c0bb4b048185");
    expect(sha256(envelopeOf("v1.2"))).toBe("28b0768157370312928db7753e4970542141d58e30cb07eb2bf30f9ed8920543");
    expect(sha256(ENVELOPE_SCHEMA_V12_LEDGER)).toBe("abdeba13ddc7d23490bea15f3320a0fe15f75f4b05444dd0e498762fba195d34");
    expect(envelopeOf("v1.2").name).toBe("stage-envelope-v12");
    expect(envelopeOf("v1.1a").name).toBe("stage-envelope-v11a");
    expect(envelopeOf("v1").name).toBe("stage-envelope");
  });
});

describe("旗 ids on の C3 の枝は観点ごとの根拠の schema（strict。v1.2-ids の封筒にだけ載る。Issue #700）", () => {
  const at = (node: unknown, ...keys: readonly string[]): Record<string, unknown> =>
    keys.reduce((current, key) => (current as Record<string, unknown>)[key], node) as Record<string, unknown>;

  it("v1.2-ids の C3 の枝は strict の走査で問題 0・anyOf と nullable が無く、3 観点が全部 required（観点の中の欄も全部 required）", () => {
    const branch = buildStageBranch({ stage: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_IDS_SCHEMA });
    expect(strictProblems(branch)).toEqual([]);
    const text = JSON.stringify(SEMANTIC_CHECK_IDS_SCHEMA);
    expect(text.includes('"anyOf"')).toBe(false);
    expect(text.includes('"null"')).toBe(false);
    expect(text.includes("nullable")).toBe(false);
    const item = at(SEMANTIC_CHECK_IDS_SCHEMA, "properties", "judgments", "items");
    expect(item["required"]).toEqual(["requirementId", "ownership", "target", "verification"]);
    expect(at(item, "properties", "ownership")["required"]).toEqual(["examinedRowIds", "unnecessaryRowIds", "quote"]);
    expect(at(item, "properties", "target")["required"]).toEqual(["verdict", "presentRowIds", "quote"]);
    expect(at(item, "properties", "verification")["required"]).toEqual(["verdict", "quote"]);
    expect(at(item, "properties", "target", "properties", "verdict")["enum"]).toEqual(["present", "missing"]);
    expect(at(item, "properties", "verification", "properties", "verdict")["enum"]).toEqual(["sufficient", "weak"]);
    // 受理／拒否と種類の欄は持たない（コードが観点から導く）
    expect(Object.keys(at(item, "properties"))).not.toContain("verdict");
    expect(Object.keys(at(item, "properties"))).not.toContain("kind");
  });

  it("C3 の観点の欄（examinedRowIds）は v1.2-ids の封筒の JSON にだけあり、v1・v1.1a・v1.2・旗 ledger の封筒には無い。ids off の v1.2 の C3 の要求（旧の schema）は v1.2 の封筒の実体に解決される", () => {
    expect(JSON.stringify(ENVELOPE_SCHEMA_V12_IDS).includes('"examinedRowIds"')).toBe(true);
    for (const schema of [ENVELOPE_SCHEMA, ENVELOPE_SCHEMA_V11A, ENVELOPE_SCHEMA_V12, ENVELOPE_SCHEMA_V12_LEDGER]) {
      expect(JSON.stringify(schema).includes('"examinedRowIds"')).toBe(false);
    }
    expect(resolveStageEnvelope(SEMANTIC_CHECK_SCHEMA_NAME, JSON.parse(JSON.stringify(SEMANTIC_CHECK_SCHEMA)), "v1.2")?.schema).toBe(ENVELOPE_SCHEMA_V12);
    expect(resolveStageEnvelope(SEMANTIC_CHECK_SCHEMA_NAME, JSON.parse(JSON.stringify(SEMANTIC_CHECK_IDS_SCHEMA)), "v1.2-ids")?.schema).toBe(ENVELOPE_SCHEMA_V12_IDS);
    expect(resolveStageEnvelope(SEMANTIC_CHECK_SCHEMA_NAME, JSON.parse(JSON.stringify(SEMANTIC_CHECK_SCHEMA)), "v1.1a")?.schema).toBe(ENVELOPE_SCHEMA_V11A);
  });
});
