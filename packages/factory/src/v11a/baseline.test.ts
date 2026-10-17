// v1.1α の比較元のバイトの記録の契約試験（08-architecture-v1.2.md §9 の手 2 の前提・Issue #546）。
//
// 手 2 の各 Issue が「旗が off なら今の v1.1α とバイト列で同じ」を機械で示せるように、**今の v1.1α の走りの
// 記録**（比較元の commit `800411c`＝統合 branch の #544 を merge した後。`fb9e122` の子孫）を、v1 の比較元の記録
// （`bundle.test.ts`・`cli.test.ts` の節。凍結した `2cd1586`）と同じ道具（`__tests__/baseline-capture.ts`）で取り、
// 候補の src の module に同じ道具を当てて深く等しいことを確かめる。記録は 5 本（library 4・CLI 1）。
//
// 外部の API は呼ばない。応答・確定した仕様・偽物の判定の答えはすべて合成（抽象的な題材）で、時計は 0 に固定する。
// 受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import {
  captureBaselineV11a,
  captureCliBaseline,
  type BaselineCliCapture,
  type BaselineCliScenarios,
  type BaselineV11aCapture,
  type BaselineV11aScenarios,
} from "../__tests__/baseline-capture.js";
import { BUNDLE_MANIFEST_FILE } from "../bundle.js";
import * as factoryModule from "../index.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 記録の fixture（`__fixtures__/baseline-v11a-800411c/`）を UTF-8 の文字列として読む */
const baselineText = (name: string): string =>
  fs.readFileSync(new URL(`../__fixtures__/baseline-v11a-800411c/${name}`, import.meta.url), "utf8");

/** 比較元の commit（#544 を merge した統合 branch の commit。完全な SHA） */
const BASE_COMMIT = "800411c17d7746b5197f7c4bc06a7df320fe6691";

interface Library {
  readonly procedure: readonly string[];
  readonly baseCommit: string;
  readonly captures: readonly BaselineV11aCapture[];
}

interface CliRecord {
  readonly procedure: readonly string[];
  readonly baseCommit: string;
  readonly definitions: BaselineCliScenarios;
  readonly captures: readonly BaselineCliCapture[];
}

const scenariosText = baselineText("scenarios.json");
const libraryText = baselineText("library.json");
const cliText = baselineText("cli.json");
const definitions = JSON.parse(scenariosText) as BaselineV11aScenarios;
const library = JSON.parse(libraryText) as Library;
const cliRecord = JSON.parse(cliText) as CliRecord;

/** 記録の要約（headless 契約の要約）の欄 */
const summaryOf = (capture: BaselineV11aCapture | undefined) =>
  (capture?.judgment.summary ?? {}) as { readonly exit_code: number; readonly stop_reason: string };

/** 記録の段の記録の段 ID の並び */
const stageIdsOf = (capture: BaselineV11aCapture | undefined): readonly string[] =>
  ((capture?.judgment.stages ?? []) as readonly { readonly stage: string }[]).map((record) => record.stage);

/** 手順の欄に要る語（v1 の記録と同じ） */
const PROCEDURE_WORDS = ["checkout", "build", "道具の呼び方"] as const;

describe("v1.1α の比較元のバイトの記録（library）", () => {
  it("先頭の欄に取り方の手順があり、4 つの語と比較元の commit の完全な SHA がある", () => {
    expect(Object.keys(library)[0]).toBe("procedure");
    expect(library.baseCommit).toBe(BASE_COMMIT);
    const procedure = library.procedure.join("\n");
    for (const word of [...PROCEDURE_WORDS, "captureBaselineV11a", library.baseCommit]) {
      expect(procedure).toContain(word);
    }
    // 比較元は #533（既定値の変更）を含む fb9e122 の子孫である
    expect(procedure).toContain("fb9e122");
  });

  it("4 経路の記録があり、経路が意図どおりに分かれている（完走・早期停止・持ち越しと停滞・修復で完走）", () => {
    expect(definitions.scenarios.map((scenario) => scenario.name)).toEqual([
      "full",
      "name-table-stop",
      "carry-over-stagnation",
      "repair-full",
    ]);
    expect(library.captures.map((capture) => capture.name)).toEqual(definitions.scenarios.map((scenario) => scenario.name));
    const [full, stop, stagnation, repair] = library.captures;

    expect(full?.judgment.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(full?.toolResults).toEqual([]);
    expect(full?.bundle?.files.at(-1)?.path).toBe(BUNDLE_MANIFEST_FILE);

    // T1' に 2 回落ちて止まる：段 name-table・unmet・終了コード 1・納品物無し
    expect(stop?.judgment.stopped).toMatchObject({ stage: "name-table", kind: "unmet" });
    expect(summaryOf(stop).exit_code).toBe(1);
    expect(stop?.bundle).toBeNull();
    expect(stop?.diagnostics.length).toBeGreaterThan(0);

    // T1'' の拒否が残って持ち越し・B4 の不一致が 2 版続いて停滞で partial
    expect(stagnation?.judgment.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(summaryOf(stagnation).stop_reason).toBe("stagnation");
    const stagnationStages = stageIdsOf(stagnation);
    expect(stagnationStages.filter((stage) => stage === "name-table")).toHaveLength(2);
    expect(stagnationStages.filter((stage) => stage === "repair")).toHaveLength(1);
    expect(stagnation?.toolResults).toEqual([]);

    // B4 の不一致 → B5 の修復で full
    expect(repair?.judgment.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(repair?.requests.some((request) => (request as { kind: string }).kind === "tools")).toBe(true);
    expect(stageIdsOf(repair)).toContain("repair");

    for (const capture of library.captures) {
      expect(capture.requests.length, capture.name).toBeGreaterThan(0);
      // 偽物の判定は J4 で要件ごとに 1 要求（問いは所属の組ごと）を受ける。T1' で止まる経路は J4 まで届かない
      if (capture.name === "name-table-stop") expect(capture.judgeQuestions, capture.name).toEqual([]);
      else expect(capture.judgeQuestions.length, capture.name).toBeGreaterThan(0);
    }
  });

  it("経路 3 の記録に、内外の切り分けの型を写した 3 試験の不一致の固定文と行き先が残る", () => {
    const stagnation = library.captures[2];
    const testRun = stagnation?.testRun as {
      readonly mismatches: readonly { readonly testId: string; readonly detail: string }[];
      readonly unresolved: readonly { readonly testId: string; readonly detail: string }[];
      readonly routes: readonly { readonly testId: string; readonly route: string; readonly detail: string }[];
    };
    const mismatch = (testId: string) => testRun.mismatches.find((entry) => entry.testId === testId)?.detail;
    const route = (testId: string) => testRun.routes.find((entry) => entry.testId === testId)?.route;
    // (a)① 集計元を空と明示した集計に null を期待：期待と違う（実際は 0）
    expect(mismatch("r4-empty-aggregate")).toBe("アプリ全体の集計 rate が期待と違う（期待 null、実際 0）");
    expect(route("r4-empty-aggregate")).toBe("missing-element");
    // (a)③ 操作の試験の期待に操作後の状態（写像）：期待は真偽
    expect(mismatch("r3-operation-state")).toBe("操作 closeItem の条件 の期待は真偽（true / false）であること");
    expect(route("r3-operation-state")).toBe("missing-element");
    // (c)① 名前付きの検査の無い選択肢の項目を validation の観測で確かめる：表の ID が指す場所が宣言に無い
    expect(mismatch("r1-option-validate")).toBe("表の ID が指す場所が宣言に無い");
    expect(route("r1-option-validate")).toBe("correspondence-defect");
    expect(testRun.mismatches).toHaveLength(3);
    expect(testRun.unresolved).toEqual([]);
  });

  it("3 試験は、同じ要件を評価できる形で書いた正例と対になる（正例は経路 1 に含まれ、不一致が無い）", () => {
    const pairs = ["r4-empty-aggregate", "r3-operation-state", "r1-option-validate"];
    const fullTestRun = library.captures[0]?.testRun as { readonly mismatches: unknown[]; readonly unresolved: unknown[] };
    expect(fullTestRun.mismatches).toEqual([]);
    expect(fullTestRun.unresolved).toEqual([]);
    const fullScenario = definitions.scenarios[0];
    const negativeScenario = definitions.scenarios[2];
    const testsOf = (recorded: readonly unknown[] | undefined): readonly { id: string }[] => {
      const structured = (recorded ?? []).find(
        (call) => (call as { output?: { tests?: unknown } }).output?.tests !== undefined,
      ) as { output: { tests: readonly { id: string }[] } } | undefined;
      return structured?.output.tests ?? [];
    };
    for (const id of pairs) {
      expect(testsOf(fullScenario?.recorded).map((test) => test.id), id).toContain(id);
      expect(testsOf(negativeScenario?.recorded).map((test) => test.id), id).toContain(id);
    }
  });

  it("経路 3 は T1'' の拒否が 2 回目にも残って持ち越しになり、J4 の印が 2 回目のデータに載る", () => {
    const stagnation = library.captures[2];
    // J4 は T1 のたびに要件ごとに 1 要求：4 要件 × 2 回
    expect(stagnation?.judgeQuestions).toHaveLength(8);
    const second = stagnation?.requests[2] as { request: { input: string } } | undefined;
    expect(second?.request.input).toContain("suspect-unnecessary");
  });

  it("候補の src の module に同じ道具を当てると、4 経路すべてで記録と深く等しい", async () => {
    const captures = await captureBaselineV11a(factoryModule, definitions);
    expect(captures).toHaveLength(library.captures.length);
    captures.forEach((capture, index) => {
      expect(capture, capture.name).toEqual(library.captures[index]);
    });
  });

  it("記録と 1 バイトでも違えば落ちる（要求の 1 文字・ファイルの SHA-256 の 1 文字）", async () => {
    const captures = await captureBaselineV11a(factoryModule, definitions);
    const first = captures[0];
    if (first === undefined) throw new Error("前提が壊れた");
    const request = first.requests[0] as { request: { input: string } };
    const changedRequest = structuredClone(first) as BaselineV11aCapture;
    (changedRequest.requests[0] as { request: { input: string } }).request.input = `${request.request.input} `;
    expect(changedRequest).not.toEqual(library.captures[0]);
    const changedFile = structuredClone(first) as unknown as { bundle: { files: { sha256: string }[] } };
    const file = changedFile.bundle.files[0];
    if (file === undefined) throw new Error("前提が壊れた");
    file.sha256 = `${file.sha256.slice(0, -1)}${file.sha256.endsWith("0") ? "1" : "0"}`;
    expect(changedFile).not.toEqual(library.captures[0]);
  });
});

describe("v1.1α の比較元のバイトの記録（手元の入口）", () => {
  it("先頭の欄に取り方の手順があり、比較元の commit の完全な SHA と手順の語がある", () => {
    expect(Object.keys(cliRecord)[0]).toBe("procedure");
    expect(cliRecord.baseCommit).toBe(BASE_COMMIT);
    expect(cliRecord.baseCommit).toBe(library.baseCommit);
    const procedure = cliRecord.procedure.join("\n");
    for (const word of [...PROCEDURE_WORDS, "captureCliBaseline", cliRecord.baseCommit]) {
      expect(procedure).toContain(word);
    }
  });

  it("1 経路（--pipeline v1.1a と --plan-file。完走）で、終了コード 0・条件の記録と要約と 7 つの記録のファイルが残る", () => {
    expect(cliRecord.captures.map((capture) => capture.name)).toEqual(
      cliRecord.definitions.scenarios.map((scenario) => scenario.name),
    );
    expect(cliRecord.captures).toHaveLength(1);
    const [capture] = cliRecord.captures;
    expect(capture?.exitCode).toBe(0);
    expect(capture?.clientOptions).toEqual([{ model: "gpt-6-luna", effort: "high", envelope: "v1.1a" }]);
    expect(JSON.parse(capture?.summary ?? "{}")).toMatchObject({ verdict: "full", prompt_version: "v1.1a" });
    const paths = capture?.files.map((file) => file.path) ?? [];
    for (const path of ["build-record.json", BUNDLE_MANIFEST_FILE, "artifacts/app.spec.yaml", "artifacts/name-table.json", "artifacts/verification-v11a.json"]) {
      expect(paths, path).toContain(path);
    }
    // 要求は封筒の枝（v1.1α の段）だけ：名前の表・表の意味の点検・試験の仕様・書く・宣言の点検
    expect(capture?.requests).toHaveLength(5);
  });

  it("候補の src の module に同じ道具を当てると、body・全ファイルの SHA-256 と manifest・要約・終了コードが記録と深く等しい", async () => {
    const captures = await captureCliBaseline(factoryModule, cliRecord.definitions);
    expect(captures).toHaveLength(cliRecord.captures.length);
    for (const [index, capture] of captures.entries()) {
      const expected = cliRecord.captures[index]!;
      expect(capture.clientOptions, capture.name).toEqual(expected.clientOptions);
      expect(capture.requests, capture.name).toEqual(expected.requests);
      expect(capture.files, capture.name).toEqual(expected.files);
      expect(capture.manifest, capture.name).toEqual(expected.manifest);
      expect(capture.summary, capture.name).toBe(expected.summary);
      expect(capture.exitCode, capture.name).toBe(expected.exitCode);
    }
    expect(captures).toEqual(cliRecord.captures);
  });
});

describe("記録・経路の定義の中身", () => {
  it("記録と経路の定義に、鍵の値・題材の言葉が無い", () => {
    for (const text of [scenariosText, libraryText, cliText]) {
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
      expect(text).not.toContain("baseline-fake-key");
      expect(text).not.toContain("OPENAI_API_KEY");
      expect(text).not.toContain("JEV_API_KEY");
      expect(text).not.toMatch(/Bearer\s/);
    }
  });

  it("v1 の比較元の記録（2cd1586）と取り違えていない（v1.1α の記録の比較元は v1 の凍結した commit と別）", () => {
    expect(library.baseCommit).not.toBe("2cd1586f856fb1cdecf75ef035826cbffe539e69");
    expect(library.baseCommit.startsWith("800411c")).toBe(true);
  });
});
