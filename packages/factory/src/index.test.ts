// 公開する面（index.ts）の unit テスト。
//
// ここで固定したいのは 2 つ。
//   1. 費用の予約・終わりの判定・LlmClient の偽物が、**パッケージの根から**読める
//   2. まだ LLM を呼ばない骨格である——ライブラリのソースが、外部の LLM の API と
//      Cloudflare・Node 固有の入口を持たない（Issue #278「LLM はまだ呼ばない」「純粋な TypeScript」）
import { describe, expect, it } from "vitest";
import {
  FakeLlmExhaustedError,
  JobBudget,
  PACKAGE_NAME,
  costOfUsageUsd,
  createFakeLlmClient,
  decideOutcome,
  estimateMaxCostUsd,
} from "./index.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

describe("公開する面", () => {
  it("パッケージ名が正しい", () => {
    expect(PACKAGE_NAME).toBe("@musunest/factory");
  });

  it("費用の予約・終わりの判定・LlmClient の偽物が、根から読める", () => {
    for (const entry of [
      JobBudget,
      estimateMaxCostUsd,
      costOfUsageUsd,
      decideOutcome,
      createFakeLlmClient,
      FakeLlmExhaustedError,
    ]) {
      expect(entry).toBeTypeOf("function");
    }
  });
});

describe("ライブラリは、外部の LLM の API と Cloudflare・Node 固有の入口を持たない", () => {
  const libraryFiles = ["budget.ts", "index.ts", "llm-fake.ts", "llm.ts", "outcome.ts", "pipeline.ts"];
  const forbidden = [
    "fetch(",
    "openai",
    "OPENAI_API_KEY",
    "cloudflare:workers",
    "wrangler",
    "node:fs",
    "node:crypto",
    "node:sqlite",
    "process.env",
  ];

  it.each(libraryFiles)("%s が禁じた入口を持たない", (file) => {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const token of forbidden) {
      expect(source.includes(token), `${file} に ${token} がある`).toBe(false);
    }
  });
});
