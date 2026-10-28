// 公開する面（index.ts）の unit テスト。
//
// ここで固定したいのは 3 つ。
//   1. 費用の予約・終わりの判定・LlmClient の偽物が、**パッケージの根から**読める
//   2. 段・回す部分（run.ts）・adapter（openai.ts）・納品物（bundle.ts）・記録（record.ts）・手元の入口
//      （cli.ts）も、**パッケージの根から**読める（Issue #288「公開する面を足す」）
//   3. ライブラリのファイル（手元の入口と adapter を除く）が、外部の LLM の API と Cloudflare・Node 固有の
//      入口を持たない（Issue #278「純粋な TypeScript」・Issue #288「新しいライブラリのファイルを足す」）
//   4. v1.1α（v11a/）の契約・段・走らせる部分・記録も根から読め、v11a の全ファイルが禁じた入口を持たない（Issue #511）
import { describe, expect, it } from "vitest";
import type { Judge } from "./index.js";
import {
  ALL_CARRIED_PROBLEM,
  DECL_CHECK_SCHEMA_NAME,
  FakeLlmExhaustedError,
  NAME_TABLE_SCHEMA_NAME,
  SEMANTIC_CHECK_SCHEMA_NAME,
  TEST_SPEC_SCHEMA_NAME,
  V11A_ARTIFACT_NAMES,
  WRITE_V11A_SCHEMA_NAME,
  bindTestsById,
  buildV11aArtifacts,
  checkNameTable,
  checkNames,
  coverageUnitsOf,
  createV11aEvaluator,
  deriveCarryOver,
  nameTableSha256,
  runDeclCheck,
  runGenerationV11a,
  runJudgeAdvice,
  runNameTable,
  runSemanticCheck,
  runTestSpec,
  runWriteV11a,
  toV1,
  JobBudget,
  PACKAGE_NAME,
  assembleBundle,
  buildRunRecord,
  buildSummary,
  costOfUsageUsd,
  createFakeJudge,
  createFakeLlmClient,
  createFallbackJudge,
  createJevJudge,
  createLlmJudge,
  createOllamaLlmClient,
  createOpenAiLlmClient,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OPENAI_MODEL,
  decideOutcome,
  estimateMaxCostUsd,
  nextPlanStep,
  parseCliArguments,
  runAnswers,
  runCatalog,
  runConfirm,
  runGeneration,
  runPlan,
  runQuestions,
  runSurface,
} from "./index.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** v11a/ の試験でないファイル（ディレクトリを読んで求める。`__tests__/` と `*.test.ts` を除く） */
function v11aLibraryFiles(): readonly string[] {
  return fs
    .readdirSync(new URL("./v11a/", import.meta.url), { recursive: true })
    .map((path) => `v11a/${path.split("\\").join("/")}`)
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/__tests__/"))
    .sort();
}

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

  it("Ollama の adapter と既定のモデルが、根から読める（Issue #771）", () => {
    expect(createOllamaLlmClient).toBeTypeOf("function");
    expect(DEFAULT_OLLAMA_MODEL).toBe("deepseek-v4.1-flash:cloud");
    // OpenAI の既定は今のまま（provider を省いた走りを変えない）
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6-luna");
  });

  it("判定の口の型と 3 つの adapter が、根から読める（Issue #330）", () => {
    for (const entry of [createJevJudge, createLlmJudge, createFakeJudge, createFallbackJudge]) {
      expect(entry).toBeTypeOf("function");
    }
    // 判定の口の型（`Judge`）が根から読める
    const judge: Judge = createFakeJudge({});
    expect(judge.judge).toBeTypeOf("function");
  });

  it("Plan の段（P1〜P6）の入口が、根から読める（Issue #333）", () => {
    for (const entry of [runCatalog, runSurface, runQuestions, runAnswers, runConfirm, nextPlanStep]) {
      expect(entry).toBeTypeOf("function");
    }
  });

  it("Plan を 1 回流す口が、根から読める（Issue #363）", () => {
    expect(runPlan).toBeTypeOf("function");
  });

  it("v1.1α の契約・段・走らせる部分・記録が、根から読める（Issue #511）", () => {
    // 契約（名前の表・v1 の型への写し・id の結び付け・持ち越し・網羅の単位）
    for (const entry of [checkNameTable, nameTableSha256, toV1, bindTestsById, deriveCarryOver, coverageUnitsOf]) {
      expect(entry).toBeTypeOf("function");
    }
    // 段（T1・T1''・J4・T2・B1・B3'）
    for (const entry of [runNameTable, runSemanticCheck, runJudgeAdvice, runTestSpec, runWriteV11a, runDeclCheck]) {
      expect(entry).toBeTypeOf("function");
    }
    expect([
      NAME_TABLE_SCHEMA_NAME,
      SEMANTIC_CHECK_SCHEMA_NAME,
      TEST_SPEC_SCHEMA_NAME,
      WRITE_V11A_SCHEMA_NAME,
      DECL_CHECK_SCHEMA_NAME,
    ]).toEqual(["name-table", "semantic-check", "test-spec", "declaration-v11a", "decl-check"]);
    // 走らせる部分・名前の照合（B3）・評価口・記録
    for (const entry of [runGenerationV11a, checkNames, createV11aEvaluator, buildV11aArtifacts]) {
      expect(entry).toBeTypeOf("function");
    }
    expect(ALL_CARRIED_PROBLEM.field).toBe("requirements");
    expect(Object.keys(V11A_ARTIFACT_NAMES)).toHaveLength(7);
  });
});

describe("ライブラリは、外部の LLM の API と Cloudflare・Node 固有の入口を持たない", () => {
  // 手元の入口（cli.ts）と adapter（openai.ts・judge-jev.ts）だけが、環境変数・ファイル・`fetch` を扱える
  // （`judge-jev.ts` は Jev の外部の入口を持つ adapter なので、この走査から外す。Issue #330）
  const libraryFiles = [
    "budget.ts",
    "bundle.ts",
    "call.ts",
    "fixed-test.ts",
    "index.ts",
    "judge-fake.ts",
    "judge-llm.ts",
    "judge.ts",
    "limits.ts",
    "llm-fake.ts",
    "llm.ts",
    "outcome.ts",
    "pipeline.ts",
    "record.ts",
    "run.ts",
    "plan/answers.ts",
    "plan/catalog.ts",
    "plan/confirm.ts",
    "plan/questions.ts",
    "plan/run-plan.ts",
    "plan/session.ts",
    "plan/surface.ts",
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
    // v1.1α（Issue #511）
    "v11a/bind-by-id.ts",
    "v11a/bundle-v11a.ts",
    "v11a/carry-over.ts",
    "v11a/convert.ts",
    "v11a/coverage.ts",
    "v11a/evaluate.ts",
    "v11a/name-check.ts",
    "v11a/names.ts",
    "v11a/run.ts",
    "v11a/stages/decl-check.ts",
    "v11a/stages/judge-advice.ts",
    "v11a/stages/name-table.ts",
    "v11a/stages/semantic-check.ts",
    "v11a/stages/test-spec.ts",
    "v11a/stages/write.ts",
  ];

  it("v11a のライブラリのファイル（試験を除く）が、走査の一覧に全部ある", () => {
    const listed = libraryFiles.filter((file) => file.startsWith("v11a/"));
    expect(listed).toEqual(v11aLibraryFiles());
  });
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
