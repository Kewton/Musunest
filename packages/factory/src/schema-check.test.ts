// JSON Schema の最小の検査（`schema-check.ts`。adapter と偽物の LLM が共有する）の unit テスト（Issue #590）。
//
// adapter から移しただけで規則は変えない。ここで語ごとに「合う値は通り、合わない値は箇所つきの 1 文で落ちる」を固定する。
import { describe, expect, it } from "vitest";
import { validateSchema } from "./schema-check.js";

describe("validateSchema", () => {
  it("schema が object でなければ何も断らない", () => {
    expect(validateSchema(undefined, 1)).toBeUndefined();
    expect(validateSchema(true, "x")).toBeUndefined();
  });

  it.each([
    ["string", "a", 1, "型が違います（string）"],
    ["number", 1.5, "1", "型が違います（number）"],
    ["integer", 2, 1.5, "型が違います（integer）"],
    ["boolean", true, 0, "型が違います（boolean）"],
    ["null", null, undefined, "型が違います（null）"],
    ["array", [], {}, "型が違います（array）"],
    ["object", {}, [], "型が違います（object）"],
  ])("型 %s", (type, good, bad, message) => {
    expect(validateSchema({ type }, good)).toBeUndefined();
    expect(validateSchema({ type }, bad)).toBe(message);
  });

  it("型の並び・enum・const", () => {
    expect(validateSchema({ type: ["string", "null"] }, null)).toBeUndefined();
    expect(validateSchema({ type: ["string", "null"] }, 1)).toBe("型がどれにも合いません");
    expect(validateSchema({ enum: ["a", "b"] }, "b")).toBeUndefined();
    expect(validateSchema({ enum: ["a", "b"] }, "c")).toBe("enum のどれでもありません");
    expect(validateSchema({ const: { k: 1 } }, { k: 1 })).toBeUndefined();
    expect(validateSchema({ const: "x" }, "y")).toBe("const と違います");
  });

  it("anyOf・oneOf・allOf", () => {
    expect(validateSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, 1)).toBeUndefined();
    expect(validateSchema({ anyOf: [{ type: "string" }] }, 1)).toBe("anyOf のどれにも合いません");
    expect(validateSchema({ oneOf: [{ type: "string" }, { type: "number" }] }, 1)).toBeUndefined();
    expect(validateSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)).toBe("oneOf は 1 つだけ合う必要があります");
    expect(validateSchema({ allOf: [{ type: "number" }, { minimum: 2 }] }, 1)).toBe("allOf のどれかに合いません");
  });

  it("object の required・properties・additionalProperties は箇所つきで落ちる", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string" }, b: { type: "object", properties: { c: { enum: [1] } } } },
    };
    expect(validateSchema(schema, { a: "x" })).toBeUndefined();
    expect(validateSchema(schema, {})).toBe("必須の欄がありません（a）");
    expect(validateSchema(schema, { a: "x", z: 1 })).toBe("余分な欄があります（z）");
    expect(validateSchema(schema, { a: 1 })).toBe("a: 型が違います（string）");
    expect(validateSchema(schema, { a: "x", b: { c: 2 } })).toBe("b: c: enum のどれでもありません");
  });

  it("array の items（単一・並び）", () => {
    expect(validateSchema({ items: { type: "string" } }, ["a", "b"])).toBeUndefined();
    expect(validateSchema({ items: { type: "string" } }, ["a", 1])).toBe("[1]: 型が違います（string）");
    expect(validateSchema({ items: [{ type: "string" }, { type: "number" }] }, ["a", "b"])).toBe("[1]: 型が違います（number）");
  });

  it("数の上下限と文字列の長さ", () => {
    expect(validateSchema({ minimum: 1, maximum: 3 }, 2)).toBeUndefined();
    expect(validateSchema({ minimum: 1 }, 0)).toBe("minimum 未満です");
    expect(validateSchema({ maximum: 3 }, 4)).toBe("maximum 超えです");
    expect(validateSchema({ minLength: 2, maxLength: 3 }, "ab")).toBeUndefined();
    expect(validateSchema({ minLength: 2 }, "a")).toBe("minLength 未満です");
    expect(validateSchema({ maxLength: 3 }, "abcd")).toBe("maxLength 超えです");
  });
});
