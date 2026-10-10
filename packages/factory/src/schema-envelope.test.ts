// 全段で同じ「封筒」の schema（#353）の unit テスト。
//
// ここで固定したいのは 4 つ。
//   1. **全段の schema から封筒を作る**——構造化出力を使う段がすべて枝として入る
//   2. **同じ入力なら同じバイト列**——封筒の組み立ては純粋で、枝の並びも決まっている
//   3. **枝ごとに `stage` の判別子がある**——`enum` が 1 つの文字列
//   4. **strict の決まりを満たす**——object は `additionalProperties: false`、すべての欄が `required`
//
// 実 API は呼ばない。封筒は組み立てるだけで、送るのは adapter（openai.ts。試験は openai.test.ts）。
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_RESULT_KEY,
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_STAGE_KEY,
  STAGE_ENVELOPE_ENTRIES,
  buildEnvelopeSchema,
  buildStageBranch,
  envelopeStageFor,
  type StageEnvelopeEntry,
} from "./schema-envelope.js";

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

  it("段の名前から、その枝（段の schema）を引ける", () => {
    for (const entry of STAGE_ENVELOPE_ENTRIES) {
      expect(envelopeStageFor(entry.stage)?.schema, entry.stage).toBe(entry.schema);
    }
    // 封筒に載っていない schema（判定の口など）は引けない——adapter は封筒を送らない
    expect(envelopeStageFor("judge-answers")).toBeUndefined();
    expect(envelopeStageFor("out")).toBeUndefined();
  });
});
