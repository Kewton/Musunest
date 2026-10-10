// すべての段の構造化出力の JSON Schema と、道具の引数の JSON Schema を走査し、**OpenAI の strict の
// 規則に合っているか**を、API を呼ばずに確かめる（02 §2・§2.2）。
//
// strict の規則（この試験が固定するもの）：
//   - すべての節に `type` がある
//   - object は `additionalProperties: false` を持ち、`properties` のすべての欄が `required` にある
//     （任意の欄は null を許す型で表す）
//   - array は `items` を持つ
//
// これに反すると API が HTTP 400（`invalid_json_schema`）で断る（Issue #300 の疎通の確認で起きた）。
// だから、要求を送る前に、ここで気づけるようにする。実 API は呼ばない。
import { describe, expect, it } from "vitest";
import { ARBITRATION_RULES, ARBITRATION_SCHEMA } from "./arbitrate.js";
import { CORRESPONDENCE_SCHEMA } from "./correspondence.js";
import { DESIGN_SCHEMA } from "./design.js";
import { REPAIR_ANSWER_SCHEMA, MAPPING_REDO_SCHEMA } from "./repair.js";
import { REQUIREMENT_LIST_SCHEMA } from "./requirements.js";
import { REVERSE_CHECK_SCHEMA } from "./reverse-check.js";
import { TEST_SUITE_SCHEMA } from "./test-suite.js";
import { REPAIR_TOOLS } from "./tools.js";
import { DECLARATION_SCHEMA } from "./write.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 走査する schema の一覧（すべての段の構造化出力と、道具の引数） */
export const STAGE_SCHEMAS: readonly { readonly name: string; readonly schema: unknown }[] = [
  { name: "requirements（①）", schema: REQUIREMENT_LIST_SCHEMA },
  { name: "reverse-check（①'）", schema: REVERSE_CHECK_SCHEMA },
  { name: "design（②）", schema: DESIGN_SCHEMA },
  { name: "test-suite（②'）", schema: TEST_SUITE_SCHEMA },
  { name: "write（③）", schema: DECLARATION_SCHEMA },
  { name: "correspondence（⑤a）", schema: CORRESPONDENCE_SCHEMA },
  { name: "arbitration（⑥'）", schema: ARBITRATION_SCHEMA },
  { name: "role-name-mappings（③ のやり直し）", schema: MAPPING_REDO_SCHEMA },
  { name: "repair の最後の答え（⑥）", schema: REPAIR_ANSWER_SCHEMA },
  ...REPAIR_TOOLS.map((tool) => ({ name: `道具 ${tool.name}（⑥）`, schema: tool.parameters })),
];

/**
 * 1 つの schema を再帰的に走査し、strict の規則に反する箇所を JSON Pointer の形で集める。
 * 合っていれば空。**すべての節**（properties・items・anyOf など）を辿る。
 */
export function strictSchemaProblems(schema: unknown): readonly string[] {
  const problems: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      problems.push(`${path}: schema が写像（object）でない`);
      return;
    }
    const type = node["type"];
    const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : undefined;
    if (types === undefined) {
      problems.push(`${path}: type が無い`);
    } else if (types.length === 0 || !types.every((one) => typeof one === "string")) {
      problems.push(`${path}: type が文字列（または文字列の並び）でない`);
    }
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
        const required = node["required"];
        if (!Array.isArray(required)) {
          problems.push(`${path}: required が無い`);
        } else {
          const listed = new Set(required.filter((key): key is string => typeof key === "string"));
          for (const key of Object.keys(properties)) {
            if (!listed.has(key)) problems.push(`${path}: 欄 ${key} が required に無い`);
          }
          for (const key of listed) {
            if (!(key in properties)) problems.push(`${path}: required の ${key} が properties に無い`);
          }
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
    const defs = node["$defs"];
    if (isRecord(defs)) {
      for (const [key, child] of Object.entries(defs)) walk(child, `${path}/$defs/${key}`);
    }
  };
  walk(schema, "#");
  return problems;
}

describe("すべての段の schema と道具の引数の schema が、strict の規則に合う（02 §2・§2.2）", () => {
  it("走査する schema の一覧に、すべての段と道具が入っている", () => {
    expect(STAGE_SCHEMAS.map((entry) => entry.name)).toEqual([
      "requirements（①）",
      "reverse-check（①'）",
      "design（②）",
      "test-suite（②'）",
      "write（③）",
      "correspondence（⑤a）",
      "arbitration（⑥'）",
      "role-name-mappings（③ のやり直し）",
      "repair の最後の答え（⑥）",
      "道具 static-check（⑥）",
      "道具 run-tests（⑥）",
      "道具 check-correspondence（⑥）",
    ]);
  });

  it.each(STAGE_SCHEMAS)("$name の schema が strict に合う", ({ schema }) => {
    expect(strictSchemaProblems(schema)).toEqual([]);
  });

  it("試験を作る段（②'）の input に type がある（Issue #300 の疎通で断られた箇所）", () => {
    const tests = TEST_SUITE_SCHEMA.properties.tests.items.properties;
    expect(strictSchemaProblems(tests.input)).toEqual([]);
    // 任意の JSON は strict で表せないので、JSON の文字列として受ける
    expect(tests.input.type).toBe("string");
  });

  it("直す段の最後の答え（⑥）の schema は、宣言（文字列）と主張の並びを決める（#304）", () => {
    expect(strictSchemaProblems(REPAIR_ANSWER_SCHEMA)).toEqual([]);
    expect(REPAIR_ANSWER_SCHEMA.properties.declaration.type).toBe("string");
    expect(REPAIR_ANSWER_SCHEMA.properties.disputes.type).toBe("array");
  });

  it("走査は、strict に反する schema を見つける（この試験自体が効いていることの確認）", () => {
    expect(strictSchemaProblems({ type: "object", properties: { a: {} } })).not.toEqual([]);
    expect(strictSchemaProblems({ type: "object", additionalProperties: false, required: [], properties: {} })).toEqual([]);
    expect(strictSchemaProblems({ type: "string" })).toEqual([]);
    expect(strictSchemaProblems({})).toEqual(["#: type が無い"]);
    expect(strictSchemaProblems({ type: "array" })).toEqual(["#: array の items が無い"]);
  });

  it("段の規則は、スキーマと別に置かれている（規則が schema に混ざらない）", () => {
    // 規則（プロンプト）と schema は別のもの。規則は schema の走査の対象ではない
    expect(ARBITRATION_RULES.length).toBeGreaterThan(0);
    expect(strictSchemaProblems(ARBITRATION_SCHEMA)).toEqual([]);
  });

  it("設計（②）の schema は、役割 ID の表と、要件ごとの種類・確かめ方を必須にする（#307）", () => {
    expect(strictSchemaProblems(DESIGN_SCHEMA)).toEqual([]);
    expect(DESIGN_SCHEMA.required).toContain("roles");
    expect(DESIGN_SCHEMA.properties.designs.items.required).toEqual(
      expect.arrayContaining(["nature", "verification"]),
    );
    expect(strictSchemaProblems(DESIGN_SCHEMA.properties.roles.items)).toEqual([]);
    expect(DESIGN_SCHEMA.properties.roles.items.required).toEqual(
      expect.arrayContaining(["roleId", "kind", "entity", "shared", "aliasOf"]),
    );
  });

  it("試験を作る段（②'）の schema は、分類・役割 ID・入力の契約を必須にする（#307）", () => {
    expect(strictSchemaProblems(TEST_SUITE_SCHEMA)).toEqual([]);
    expect(TEST_SUITE_SCHEMA.required).toEqual(expect.arrayContaining(["classifications", "tests"]));
    const test = TEST_SUITE_SCHEMA.properties.tests.items;
    expect(test.required).toEqual(expect.arrayContaining(["inputContract"]));
    // 対象は自由な文の役割（role）ではなく、役割 ID（roleId）で指す
    expect(test.properties.target.required).toEqual(expect.arrayContaining(["roleId"]));
    expect(test.properties.target.required).not.toContain("role");
    expect(strictSchemaProblems(test.properties.inputContract)).toEqual([]);
    expect(test.properties.inputContract.properties.emptyEntities.type).toBe("array");
  });

  it("書く段（③）の schema は、役割 ID → 宣言の名前の対応（mappings）を必須にする（#308）", () => {
    expect(strictSchemaProblems(DECLARATION_SCHEMA)).toEqual([]);
    expect(DECLARATION_SCHEMA.required).toContain("mappings");
    const mappings = DECLARATION_SCHEMA.properties.mappings;
    expect(mappings.type).toBe("array");
    expect(strictSchemaProblems(mappings.items)).toEqual([]);
    expect(mappings.items.required).toEqual(expect.arrayContaining(["roleId", "name"]));
  });
});
