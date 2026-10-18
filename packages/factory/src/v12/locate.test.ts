// 失敗の場所（v12/locate.ts）の試験（08-architecture-v1.2.md §3 の 1 (c)・§4 のループの行・§9 の手 4 の後半。Issue #553）。
//
// 純粋な関数だけを照らす。LLM・判定・時計を使わない。題材は v1.1α の共通の題材（`v11a/__tests__/fixtures.ts`）。
import { describe, expect, it } from "vitest";
import type { FixedTest, TestSuite } from "../fixed-test.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { FIXTURE_YAML, fixtureTable } from "../v11a/__tests__/fixtures.js";
import {
  canRepairFields,
  declarationSpans,
  locateFailures,
  spanOf,
  UNLOCATED_REASONS,
  type LocateInput,
} from "./locate.js";
import { NAMED_FAILURE_MESSAGES } from "./search-repair.js";

const TABLE = fixtureTable();

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const nodeFs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 試験 1 本（対象の行・操作だけを決める。ほかの欄は場所に効かない） */
const test = (id: string, requirementId: string, kind: string, roleId: string, operation: string): FixedTest =>
  ({
    id,
    target: { requirementId, kind, roleId },
    kind: "normal",
    operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: "true", code: null },
  }) as unknown as FixedTest;

const SUITE: TestSuite = {
  tests: [
    test("r1-validate", "R1", "field", "f.item.amount", "validate"),
    test("r3-when", "R3", "operation", "o.closeItem", "action"),
    test("r4-rate", "R4", "computation", "c.rate", "compute"),
    test("r1-entity", "R1", "entity", "e.item", "validate"),
    test("x-missing-row", "R1", "field", "f.item.none", "validate"),
    test("r2-title", "R2", "field", "f.member.title", "validate"),
  ],
};

/** 静的チェック・B3・B3'・B4 を通った版（失敗は上書きする） */
const input = (overrides: Partial<LocateInput> = {}): LocateInput => ({
  source: FIXTURE_YAML,
  table: TABLE,
  suite: SUITE,
  staticCheckPassed: true,
  diagnostics: [],
  correspondenceMisses: [],
  rejections: [],
  unmarked: [],
  mismatches: [],
  unresolved: [],
  ...overrides,
});

/** 原文の中で、ちょうど 1 回現れる行の 1 始まりの番号 */
const lineOf = (source: string, text: string): number => {
  const lines = source.split("\n");
  const found = lines.flatMap((line, index) => (line === text ? [index + 1] : []));
  if (found.length !== 1) throw new Error(`前提が壊れた：行が 1 つでない（${text}）`);
  return found[0] ?? 0;
};

describe("宣言の要素の行の範囲", () => {
  it("entity の項目・検査・計算・操作・画面の範囲を決まった順で出し、範囲の行を並べると要素の原文になる", () => {
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた：題材の宣言が読めない");
    expect(read.spans.map((span) => span.key)).toEqual([
      "field:member.title",
      "field:item.title",
      "field:item.owner",
      "field:item.amount",
      "field:item.day",
      "field:item.kind",
      "validation:item.amount",
      "computation:member.itemCount",
      "computation:base",
      "computation:rate",
      "computation:byKind",
      "computation:byMonth",
      "action:item.addItem",
      "action:item.closeItem",
      "view:item.items",
      "view:member.members",
      "view:overview",
    ]);
    const lines = FIXTURE_YAML.split("\n");
    const textOf = (key: string): string => {
      const span = read.spans.find((candidate) => candidate.key === key);
      if (span === undefined) throw new Error(`範囲が無い: ${key}`);
      return lines.slice(span.start, span.end).join("\n");
    };
    expect(textOf("field:item.kind")).toBe(
      ["      kind:", "        type: enum", "        options:", "          alpha: アルファ", "          beta: ベータ"].join("\n"),
    );
    expect(textOf("computation:rate")).toBe(["  - name: rate", "    scope: app", "    expression: base * 2", "    type: number"].join("\n"));
    expect(textOf("action:item.closeItem")).toBe(
      ["  - name: closeItem", "    entity: item", "    kind: update", "    set:", "      kind: beta", "    when: amount > 0"].join("\n"),
    );
    expect(textOf("view:overview")).toContain("        value: byKind");
  });

  it("読めない宣言は範囲を出さない。行の数え方が読み取りの値と合わない節（流れの書き方）の要素は出さない", () => {
    expect(declarationSpans("entities: [\n").ok).toBe(false);
    const flow = FIXTURE_YAML.replace("validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n", "validations: []\n");
    const read = declarationSpans(flow);
    if (!read.ok) throw new Error("前提が壊れた：読めない");
    expect(read.spans.some((span) => span.kind === "validation")).toBe(false);
  });

  it("場所の要素はちょうど 1 つのときだけ引ける（entity は置き換えの単位でない・名前の重なる要素は引かない）", () => {
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた");
    expect(spanOf(read.spans, { kind: "computation", entity: null, name: "rate" })?.key).toBe("computation:rate");
    expect(spanOf(read.spans, { kind: "field", entity: "member", name: "title" })?.key).toBe("field:member.title");
    expect(spanOf(read.spans, { kind: "entity", entity: null, name: "item" })).toBeUndefined();
    expect(spanOf(read.spans, { kind: "computation", entity: null, name: "missing" })).toBeUndefined();
    const twice = [...read.spans, ...read.spans.filter((span) => span.key === "computation:rate")];
    expect(spanOf(twice, { kind: "computation", entity: null, name: "rate" })).toBeUndefined();
  });
});

describe("失敗の場所：B4・B3・B3'・静的チェックが正しい要素に写り、写せない失敗は場所なし", () => {
  it("B4 の不一致は試験の対象の行から（検査の試験は同じ名前の検査、操作・計算はその要素）、B3 の落ちはその場所から、B3' の拒否は所属させた行から写る", () => {
    const result = locateFailures(
      input({
        correspondenceMisses: [{ requirementId: "R4", location: { kind: "computation", entity: null, name: "byKind" }, detail: "落ち" }],
        rejections: [{ requirementId: "R4" }],
        mismatches: [{ testId: "r1-validate" }, { testId: "r3-when" }],
        unresolved: [{ testId: "r4-rate" }],
      }),
    );
    expect(result.unlocated).toEqual([]);
    expect(result.located).toEqual([
      { testId: null, requirementId: "R4", kind: "correspondence-miss", message: NAMED_FAILURE_MESSAGES["correspondence-miss"], locations: ["computation:byKind"] },
      {
        testId: null,
        requirementId: "R4",
        kind: "decl-rejection",
        message: NAMED_FAILURE_MESSAGES["decl-rejection"],
        locations: ["computation:byKind", "computation:byMonth", "computation:rate", "view:overview"],
      },
      { testId: "r1-validate", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"], locations: ["validation:item.amount"] },
      { testId: "r3-when", requirementId: "R3", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"], locations: ["action:item.closeItem"] },
      { testId: "r4-rate", requirementId: "R4", kind: "test-unresolved", message: NAMED_FAILURE_MESSAGES["test-unresolved"], locations: ["computation:rate"] },
    ]);
    // 場所の並びは最初に現れた順・重複なし
    expect(result.locations).toEqual([
      "computation:byKind",
      "computation:byMonth",
      "computation:rate",
      "view:overview",
      "validation:item.amount",
      "action:item.closeItem",
    ]);
    expect(canRepairFields(result)).toBe(true);
  });

  it("静的チェックの問題は、その位置を含む要素へ写る。要素の外の位置（節の見出し・permissions）は場所なし", () => {
    const result = locateFailures(
      input({
        staticCheckPassed: false,
        diagnostics: [
          { line: lineOf(FIXTURE_YAML, "    expression: base * 2") },
          { line: lineOf(FIXTURE_YAML, "        to: member") },
          { line: lineOf(FIXTURE_YAML, "permissions:") },
        ],
        mismatches: [{ testId: "r3-when" }],
      }),
    );
    // 静的チェックに落ちた版は静的チェックの問題だけ（namedFailuresOf と同じ向き）
    expect(result.located.map((failure) => [failure.kind, failure.locations])).toEqual([
      ["static-check", ["computation:rate"]],
      ["static-check", ["field:item.owner"]],
    ]);
    expect(result.unlocated).toEqual([
      { testId: null, requirementId: null, kind: "static-check", message: NAMED_FAILURE_MESSAGES["static-check"], reason: "outside-element" },
    ]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("負例：行の場所が無い・要素が宣言に無い（entity の行・宣言から消えた要素）失敗は場所なしに入り、近い要素に写らない", () => {
    const withoutClose = FIXTURE_YAML.replace(
      "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
      "",
    );
    const result = locateFailures(
      input({
        source: withoutClose,
        correspondenceMisses: [
          { requirementId: "R3", location: { kind: "action", entity: "item", name: "closeItem" }, detail: "宣言に無い" },
          { requirementId: "R2", detail: "対応そのものが無い" },
        ],
        rejections: [{ requirementId: "R5" }],
        unmarked: ["R4"],
        mismatches: [{ testId: "r1-entity" }, { testId: "x-missing-row" }, { testId: "r2-title" }, { testId: "not-in-suite" }],
      }),
    );
    expect(result.located).toEqual([]);
    expect(result.locations).toEqual([]);
    expect(result.unlocated.map((failure) => [failure.kind, failure.testId ?? failure.requirementId, failure.reason])).toEqual([
      ["correspondence-miss", "R3", "no-element"],
      ["correspondence-miss", "R2", "no-row-location"],
      // R5 は所属させた行が無い
      ["decl-rejection", "R5", "no-row-location"],
      ["decl-unmarked", "R4", "no-element"],
      // entity の行は置き換えの単位でない
      ["test-mismatch", "r1-entity", "no-element"],
      ["test-mismatch", "x-missing-row", "no-row-location"],
      // 検査 title は宣言に無い（項目 member.title が在っても、近い要素に写さない）
      ["test-mismatch", "r2-title", "no-element"],
      ["test-mismatch", "not-in-suite", "no-row-location"],
    ]);
    expect(UNLOCATED_REASONS).toEqual(["no-row-location", "no-element", "outside-element"]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("拒否の所属は導いた entity の所属を含み、entity の行を含む拒否（R3 は操作と項目から entity item を導く）は場所なし", () => {
    const result = locateFailures(input({ rejections: [{ requirementId: "R3" }], mismatches: [{ testId: "r3-when" }] }));
    expect(result.unlocated.map((failure) => [failure.kind, failure.requirementId, failure.reason])).toEqual([["decl-rejection", "R3", "no-element"]]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("拒否の要件が所属させた行の 1 つでも写せなければ、その拒否は場所なし（一部の場所だけに写さない）", () => {
    const table = {
      ...TABLE,
      ownership: TABLE.ownership.map((entry) =>
        entry.requirementId === "R4" ? { ...entry, roles: [...entry.roles, { id: "e.item", basis: "stated" as const, reason: null }] } : entry,
      ),
    };
    const result = locateFailures(input({ table, rejections: [{ requirementId: "R4" }], mismatches: [{ testId: "r3-when" }] }));
    expect(result.unlocated.map((failure) => [failure.requirementId, failure.reason])).toEqual([["R4", "no-element"]]);
    expect(result.locations).toEqual(["action:item.closeItem"]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("並びは決定的：同じ版と文脈で 2 回同じ結果。重なった失敗は 1 つ", () => {
    const value = input({ mismatches: [{ testId: "r3-when" }, { testId: "r3-when" }, { testId: "r1-validate" }], unresolved: [{ testId: "r1-entity" }] });
    const first = locateFailures(value);
    expect(locateFailures(value)).toEqual(first);
    expect(JSON.stringify(locateFailures(value))).toBe(JSON.stringify(first));
    expect(first.located.map((failure) => failure.testId)).toEqual(["r3-when", "r1-validate"]);
    expect(first.unlocated.map((failure) => failure.testId)).toEqual(["r1-entity"]);
  });

  it("場所に写した失敗が無い往復は欄だけの直しを使わない", () => {
    expect(canRepairFields(locateFailures(input()))).toBe(false);
  });
});

describe("題材の言葉の走査（Issue #553 で足した・直したファイル）", () => {
  it("場所・欄だけの直し・探索の部品とその試験のソースに受入の題材の言葉が無い", () => {
    const files = [
      "./locate.ts",
      "./locate.test.ts",
      "./search-repair.ts",
      "./search-repair.test.ts",
      "./stages/field-repair.ts",
      "./stages/field-repair.test.ts",
      "./stages/field-repair-wire.test.ts",
      "../v11a/run.ts",
      "../v11a/run.test.ts",
      "../v11a/__tests__/fixtures.ts",
      "../index.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => nodeFs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
