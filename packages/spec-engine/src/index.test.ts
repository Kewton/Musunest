// 公開する面（index.ts）の unit テスト。
//
// ここで固定したいのは 2 つ。
//   1. 検査・正規化・評価・時計の入口が、**パッケージの根から**読める（ほかのパッケージはここだけを見る）
//   2. ライブラリのソース（#98 で足した 3 本）が、式の実行とストレージの入口を持たない
//      （#97 の check.test.ts が見ている一覧に、#98 の分を足して確かめる）
//
// 宣言を検査 → 正規化 → 評価、の通しもここで 1 回だけ流す。入口が 4 つ揃って初めて
// 「未検査の YAML を評価に渡せない」経路になる（評価の入口は正規化した成果物だけを受け取る）。
import { describe, expect, it } from "vitest";
import {
  ARITHMETIC_OPERATORS,
  BUILTIN_FUNCTIONS,
  COMPARISON_OPERATORS,
  EXPRESSION_LIMITS,
  NORMALIZED_JSON_INDENT,
  PACKAGE_NAME,
  checkSpec,
  evaluateRecord,
  fixedClock,
  isClockInstant,
  normalizeSpec,
  readExpression,
  serializeNormalizedAppSpec,
  sha256Hex,
  systemClock,
} from "./index.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 検査を通る、最小の宣言（見本から項目と計算を 1 つずつ借りる） */
const DECLARATION = [
  "entities:",
  "  - name: expense",
  "    fields:",
  "      amount: number",
  "      participants: list",
  "views: []",
  "actions: []",
  "validations:",
  "  - name: positiveAmount",
  "    entity: expense",
  "    expression: amount > 0",
  "computed:",
  "  - name: headcount",
  "    entity: expense",
  "    expression: len(participants)",
  "    type: number",
  "  - name: shareAmount",
  "    entity: expense",
  "    expression: amount / max(1, headcount)",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

describe("公開する面", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/spec-engine");
  });

  it("検査・正規化・評価・時計の入口が、根から読める", () => {
    for (const entry of [
      checkSpec,
      normalizeSpec,
      serializeNormalizedAppSpec,
      sha256Hex,
      evaluateRecord,
      fixedClock,
      systemClock,
      isClockInstant,
      readExpression,
    ]) {
      expect(typeof entry).toBe("function");
    }
  });

  it("検査と評価が共有する定数も、根から読める", () => {
    expect(EXPRESSION_LIMITS).toEqual({ maxLength: 200, maxDepth: 8, maxNodes: 64 });
    expect(NORMALIZED_JSON_INDENT).toBe(2);
    // 正本（appspec-schema）の語彙が、同じ並びで読める
    expect(ARITHMETIC_OPERATORS).toEqual(["+", "-", "*", "/"]);
    expect(COMPARISON_OPERATORS).toEqual([">", ">=", "<", "<=", "==", "!="]);
    expect(Object.keys(BUILTIN_FUNCTIONS)).toEqual(["min", "max", "len"]);
  });

  it("宣言 → 正規化した JSON → 計算、の通しが根から流せる", async () => {
    const checked = checkSpec(DECLARATION);
    expect(checked.ok).toBe(true);
    const normalized = await normalizeSpec(DECLARATION);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(Object.keys(normalized.app)).toEqual(["schemaVersion", "sourceSha256", "spec"]);
    expect(JSON.parse(normalized.json)).toEqual(normalized.app);
    expect(serializeNormalizedAppSpec(normalized.app)).toBe(normalized.json);
    // 評価は正規化した成果物だけを受け取る（未検査の YAML を渡す口が無い）
    const evaluation = evaluateRecord({
      app: normalized.app,
      entity: "expense",
      record: { amount: 900, participants: ["A", "B"] },
      clock: fixedClock("2026-09-16T12:00:00+09:00"),
    });
    expect(evaluation).toEqual({ computed: { headcount: 2, shareAmount: 450 }, validations: [] });
  });
});

describe("ライブラリのソースは、式の実行とストレージの入口を持たない", () => {
  const libraryFiles = ["clock.ts", "evaluate.ts", "normalize.ts", "index.ts"];
  const forbidden = [
    "eval(",
    "new Function",
    "@musunest/app-do",
    "cloudflare:workers",
    "wrangler",
    "node:fs",
    "node:sqlite",
    "node:crypto",
    "fetch(",
    "writeFile",
  ];

  it.each(libraryFiles)("%s が禁じた入口を持たない", (file) => {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const token of forbidden) {
      expect(source.includes(token), `${file} に ${token} がある`).toBe(false);
    }
  });
});
