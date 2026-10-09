// 公開する面（index.ts）の unit テスト。
//
// ここで固定したいのは 3 つ。
//   1. 費用の予約・終わりの判定・LlmClient の偽物が、**パッケージの根から**読める
//   2. 段・回す部分（run.ts）・adapter（openai.ts）・納品物（bundle.ts）・記録（record.ts）・手元の入口
//      （cli.ts）も、**パッケージの根から**読める（Issue #288「公開する面を足す」）
//   3. ライブラリのファイル（手元の入口と adapter を除く）が、外部の LLM の API と Cloudflare・Node 固有の
//      入口を持たない（Issue #278「純粋な TypeScript」・Issue #288「新しいライブラリのファイルを足す」）
import { describe, expect, it } from "vitest";
import {
  FakeLlmExhaustedError,
  JobBudget,
  PACKAGE_NAME,
  assembleBundle,
  buildRunRecord,
  buildSummary,
  costOfUsageUsd,
  createFakeLlmClient,
  createOpenAiLlmClient,
  decideOutcome,
  estimateMaxCostUsd,
  parseCliArguments,
  runGeneration,
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

  it("段・回す部分・adapter・納品物・記録・手元の入口が、根から読める", () => {
    for (const entry of [
      runGeneration,
      assembleBundle,
      buildRunRecord,
      buildSummary,
      createOpenAiLlmClient,
      parseCliArguments,
    ]) {
      expect(entry).toBeTypeOf("function");
    }
  });
});

describe("ライブラリは、外部の LLM の API と Cloudflare・Node 固有の入口を持たない", () => {
  // 手元の入口（cli.ts）と adapter（openai.ts）だけが、環境変数・ファイル・`fetch` を扱える
  const libraryFiles = [
    "budget.ts",
    "bundle.ts",
    "call.ts",
    "fixed-test.ts",
    "index.ts",
    "limits.ts",
    "llm-fake.ts",
    "llm.ts",
    "outcome.ts",
    "pipeline.ts",
    "record.ts",
    "run.ts",
    "stages/arbitrate.ts",
    "stages/bind.ts",
    "stages/correspondence.ts",
    "stages/design.ts",
    "stages/prompt.ts",
    "stages/repair.ts",
    "stages/requirements.ts",
    "stages/reverse-check.ts",
    "stages/run-tests.ts",
    "stages/static-check.ts",
    "stages/test-suite.ts",
    "stages/tools.ts",
    "stages/write.ts",
  ];
  const forbidden = [
    "fetch(",
    // 外部の LLM の API の入口（ホスト名）と、鍵を読む環境変数。**adapter（openai.ts）は別扱い**なので、
    // 根（index.ts）が adapter を再公開しても、この印には触れない
    "api.openai.com",
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
