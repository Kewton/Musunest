// ④ 静的チェック（stages/static-check.ts）の unit テスト（02 §1・Q-4）。
//
// ここで固定したいのは 3 つ。
//   1. 通った宣言は、正規化した JSON（`app`）を返す（⑤a 以降はこれを使う）
//   2. 通らない宣言は、spec-engine が返した誤りコードと位置を**そのまま**返す（自分で足さない）
//   3. 通らなかったときは `app` を返さない（成果物を返さない。src/normalize.ts の規約 1）
import { describe, expect, it } from "vitest";
import type { Declaration } from "../pipeline.js";
import { runStaticCheck } from "./static-check.js";

/** 7 欄をすべて書いた、通る宣言（抽象的な題材） */
const VALID = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      title: string",
  "views: []",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 1 か所だけ型を間違えた宣言（`DATA_FIELD_TYPE_UNKNOWN` になる） */
const INVALID = VALID.replace("title: string", "title: nosuchtype");

const declaration = (source: string): Declaration => ({ source });

describe("④ 静的チェック（02 §1・Q-4）", () => {
  it("通った宣言は、正規化した JSON を返す（診断は空）", async () => {
    const result = await runStaticCheck(declaration(VALID));
    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.app).not.toBeNull();
    expect(result.app?.spec.entities.map((entity) => entity.name)).toEqual(["record"]);
  });

  it("通らない宣言は、誤りコードと位置をそのまま返し、成果物を返さない", async () => {
    const result = await runStaticCheck(declaration(INVALID));
    expect(result.passed).toBe(false);
    expect(result.app).toBeNull();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "DATA_FIELD_TYPE_UNKNOWN")).toBe(true);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).not.toBe("");
      expect(diagnostic.message).not.toBe("");
      expect(diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(diagnostic.column).toBeGreaterThanOrEqual(1);
    }
  });
});
