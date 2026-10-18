// JSON Schema の最小の検査（§2.2「合否・持ち物はコードが決める」）。純粋な module。
//
// adapter（openai.ts）が本物の応答を照らすのと、偽物の LLM（llm-fake.ts）が記録を照らすのとで、
// **同じ関数を使う**（#590。偽物の層でも adapter と同じ規則で schema と形の検査のずれを観測するため）。
// 構造化出力の `strict: true` が本来の保証だが、よく使う語だけを見る（型・必須・properties・
// items・enum・const・結合・additionalProperties・数の上下限・文字列の長さ）。

/**
 * JSON Schema の**最小の**検査。構造化出力の `strict: true` が本来の保証だが、adapter は
 * 「形が合わない応答」を成功にしない（§2.2）。よく使う語だけを見る（型・必須・properties・
 * items・enum・const・結合・additionalProperties・数の上下限・文字列の長さ）。
 */
export function validateSchema(schema: unknown, value: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) return `型が違います（${type}）`;
  const types = asArray(type);
  if (types !== undefined && !types.some((one) => typeof one === "string" && matchesType(one, value))) {
    return "型がどれにも合いません";
  }
  const enumValues = asArray(schema.enum);
  if (enumValues !== undefined && !enumValues.some((candidate) => deepEqual(candidate, value))) {
    return "enum のどれでもありません";
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) return "const と違います";
  const anyOf = asArray(schema.anyOf);
  if (anyOf !== undefined && !anyOf.some((one) => validateSchema(one, value) === undefined)) {
    return "anyOf のどれにも合いません";
  }
  const oneOf = asArray(schema.oneOf);
  if (oneOf !== undefined) {
    const matched = oneOf.filter((one) => validateSchema(one, value) === undefined).length;
    if (matched !== 1) return "oneOf は 1 つだけ合う必要があります";
  }
  const allOf = asArray(schema.allOf);
  if (allOf !== undefined && allOf.some((one) => validateSchema(one, value) !== undefined)) {
    return "allOf のどれかに合いません";
  }
  if (isRecord(value)) {
    const error = validateObject(schema, value);
    if (error !== undefined) return error;
  }
  if (Array.isArray(value)) {
    const error = validateArray(schema, value);
    if (error !== undefined) return error;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return "minimum 未満です";
    if (typeof schema.maximum === "number" && value > schema.maximum) return "maximum 超えです";
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return "minLength 未満です";
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return "maxLength 超えです";
  }
  return undefined;
}

function validateObject(schema: Record<string, unknown>, value: Record<string, unknown>): string | undefined {
  const required = asArray(schema.required);
  if (required !== undefined) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) return `必須の欄がありません（${key}）`;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties !== undefined) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const error = validateSchema(propertySchema, value[key]);
      if (error !== undefined) return `${key}: ${error}`;
    }
  }
  if (schema.additionalProperties === false && properties !== undefined) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) return `余分な欄があります（${key}）`;
    }
  }
  return undefined;
}

function validateArray(schema: Record<string, unknown>, value: readonly unknown[]): string | undefined {
  const items = schema.items;
  if (isRecord(items)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateSchema(items, value[index]);
      if (error !== undefined) return `[${index}]: ${error}`;
    }
  } else {
    const tuple = asArray(items);
    if (tuple !== undefined) {
      for (let index = 0; index < value.length && index < tuple.length; index += 1) {
        const error = validateSchema(tuple[index], value[index]);
        if (error !== undefined) return `[${index}]: ${error}`;
      }
    }
  }
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
