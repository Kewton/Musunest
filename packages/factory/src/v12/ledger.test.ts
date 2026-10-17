// 性質の台帳と v1.2 の旗（v12/ledger.ts）の試験（08-architecture-v1.2.md §5・§9 手 2。Issue #547）。
//
// 固定したいこと：
//   1. 全行に id・since・why・状態があり、id が台帳の中で一意（同じ id の行を 2 つ置くと落ちる。二点測定）
//   2. 有効で試験の型を持つ行の照合の名前が、評価口の表に全部ある
//   3. 台帳から導いた観測する性質・未対応・確かめ方の種類・評価の方法の表が、今の定数と同じ（並びも）
//   4. 行の固定文・規則の文が、今の段の定数・規則の文と同じ（台帳が今の振る舞いの写しになっている）
//   5. 人が読む写し（methodology/ledger/properties.md）の表が、コードの台帳と 1 要素 1 行で一致する（二点測定）
//
// LLM を呼ばない。外部の API を呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { TEST_KINDS, type FixedTest } from "../fixed-test.js";
import { ruleDefinitionDefects } from "../stages/prompt.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { coverageUnitKey } from "../v11a/coverage.js";
import { V11A_EVALUATION_NAMES } from "../v11a/evaluate.js";
import { NAME_TABLE_VERIFICATION_KINDS } from "../v11a/names.js";
import { SEMANTIC_CHECK_RULE_DEFINITIONS } from "../v11a/stages/semantic-check.js";
import { NAME_TABLE_RULE_DEFINITIONS, nameTableRuleDefinitionsOf } from "../v11a/stages/name-table.js";
import {
  DEFAULT_VALUE_EXEMPT_MESSAGES,
  DEFAULT_VALUE_NOT_ALLOWED_MESSAGE,
  DEFAULT_VALUE_TEST_MESSAGES,
  EVALUABLE_COMBINATIONS,
  TEST_OBSERVES,
  TEST_SPEC_RULE_DEFINITIONS,
  UNSUPPORTED_OBSERVES,
  testSpecRuleDefinitionsOf,
} from "../v11a/stages/test-spec.js";
import { WRITE_V11A_RULE_DEFINITIONS } from "../v11a/stages/write.js";
import {
  PROPERTY_COPY_HEADER,
  PROPERTY_LEDGER,
  PROPERTY_LEDGER_VIEW,
  PROPERTY_STATES,
  V12_FLAGS_OFF,
  V12_FLAG_NAMES,
  V12_PIPELINE_FLAGS,
  deriveLedgerView,
  exemptKindMessagesOf,
  ledgerRowDefects,
  ledgerViewOf,
  propertyCopyCells,
  resolveV12Flags,
  type PropertyRow,
} from "./ledger.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 人が読む写し（リポジトリの workspace の文書） */
const COPY_TEXT = fs.readFileSync(
  new URL("../../../../workspace/mvp/m1/agent/methodology/ledger/properties.md", import.meta.url),
  "utf8",
);

const rowOf = (id: string): PropertyRow => {
  const row = PROPERTY_LEDGER.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`前提が壊れた：台帳に ${id} が無い`);
  return row;
};
const DEFAULT_VALUE = rowOf("default-value");

// ── 1. 行の欄と id の一意 ─────────────────────────────────────────

describe("台帳の行：全行に id・since・why・状態があり、id が一意", () => {
  it("今の台帳は不備 0 で、全行の id・since・why が空でなく、状態が 3 つのどれか", () => {
    expect(ledgerRowDefects(PROPERTY_LEDGER)).toEqual([]);
    expect(PROPERTY_LEDGER.length).toBeGreaterThan(0);
    for (const row of PROPERTY_LEDGER) {
      expect(row.id.trim(), row.id).not.toBe("");
      expect(row.since.trim(), row.id).not.toBe("");
      expect(row.why.trim(), row.id).not.toBe("");
      expect(PROPERTY_STATES, row.id).toContain(row.state);
    }
    expect(new Set(PROPERTY_LEDGER.map((row) => row.id)).size).toBe(PROPERTY_LEDGER.length);
  });

  it("二点測定：同じ id の行を 2 つ置くと不備になり、導出が例外で断る（元の台帳は通る）", () => {
    expect(() => deriveLedgerView(PROPERTY_LEDGER)).not.toThrow();
    const duplicated = [...PROPERTY_LEDGER, { ...DEFAULT_VALUE, t1: null, t2: null }];
    expect(ledgerRowDefects(duplicated)).toEqual(["性質の id default-value が台帳の中で重なっている"]);
    expect(() => deriveLedgerView(duplicated)).toThrow("台帳の中で重なっている");
  });

  it("二点測定：since・why・id が空・知らない状態の行は不備になる", () => {
    const broken = (patch: Partial<PropertyRow>) => ledgerRowDefects(PROPERTY_LEDGER.map((row) => (row.id === "when" ? { ...row, ...patch } : row)));
    expect(broken({ since: " " })).toEqual(["性質 when の since が空である"]);
    expect(broken({ why: "" })).toEqual(["性質 when の why が空である"]);
    expect(broken({ state: "unknown" as PropertyRow["state"] })).toEqual(["性質 when の状態が知らない値である"]);
    expect(broken({ id: "" })).toEqual(["行 0 の id が空である"]);
  });

  it("状態に合わない欄は不備になる（未対応に照合の名前・有効に照合の名前が無い・確かめ方の種類の重なり）", () => {
    const patched = (id: string, patch: Partial<PropertyRow>) => PROPERTY_LEDGER.map((row) => (row.id === id ? { ...row, ...patch } : row));
    expect(ledgerRowDefects(patched("state-after-set", { evaluation: "v1-run-tests" }))).toEqual([
      "性質 state-after-set は未対応なのに、照合の名前がある",
    ]);
    expect(ledgerRowDefects(patched("when", { evaluation: null }))).toEqual(["性質 when は有効なのに、照合の名前が無い"]);
    expect(ledgerRowDefects(patched("when", { t1: DEFAULT_VALUE.t1, t2: DEFAULT_VALUE.t2 }))).toEqual([
      "性質 default-value の確かめ方の種類 default-value が重なっている",
    ]);
  });
});

// ── 2. 照合の名前 ─────────────────────────────────────────────────

describe("B4 の照合の名前：有効で試験の型（または評価の方法の組）を持つ行の名前が、評価口の表に全部ある", () => {
  it("今の台帳の有効の行の照合の名前は、全部 V11A_EVALUATION_NAMES にある", () => {
    const names = V11A_EVALUATION_NAMES as readonly string[];
    const active = PROPERTY_LEDGER.filter((row) => row.state !== "registered-unsupported" && (row.t2 !== null || row.combinations.length > 0));
    expect(active.map((row) => row.id)).toEqual(["when", "value", "validation", "view-structure", "existence", "default-value"]);
    for (const row of active) expect(names, row.id).toContain(row.evaluation);
    // 未対応の行は照合の名前を持たない（B4 は未解決にする）
    expect(rowOf("state-after-set").evaluation).toBeNull();
  });

  it("二点測定：表に無い名前を持つ行は、この照合から外れる", () => {
    const names = V11A_EVALUATION_NAMES as readonly string[];
    const changed = { ...DEFAULT_VALUE, evaluation: "no-such-evaluation" };
    expect(names).toContain(DEFAULT_VALUE.evaluation);
    expect(names).not.toContain(changed.evaluation);
  });
});

// ── 3. 導出と今の定数 ─────────────────────────────────────────────

describe("台帳から導いたものが今の定数と同じ（旗 on の載せ替えの不変）", () => {
  it("観測する性質の並び・未対応の並び・確かめ方の種類の並びが、今の定数と深く等しい", () => {
    expect(PROPERTY_LEDGER_VIEW.observes).toEqual([...TEST_OBSERVES]);
    expect(PROPERTY_LEDGER_VIEW.unsupportedObserves).toEqual([...UNSUPPORTED_OBSERVES]);
    expect(PROPERTY_LEDGER_VIEW.verificationKinds).toEqual([...NAME_TABLE_VERIFICATION_KINDS]);
  });

  it("評価の方法の表の組の数が 9 で、今の表と同じ組の集合（照らす側は `some` で引くので並びは振る舞いに効かない）", () => {
    const key = (entry: { targetKind: string; operation: string; observes: string }) => `${entry.targetKind}|${entry.operation}|${entry.observes}`;
    expect(PROPERTY_LEDGER_VIEW.combinations).toHaveLength(9);
    expect(EVALUABLE_COMBINATIONS).toHaveLength(9);
    expect(new Set(PROPERTY_LEDGER_VIEW.combinations.map(key))).toEqual(new Set(EVALUABLE_COMBINATIONS.map(key)));
  });

  it("除外する確かめ方の種類・外す v1 の文が、今の R-tsp-02 の除外と免除の文と同じ", () => {
    expect(PROPERTY_LEDGER_VIEW.t2ExemptKinds).toEqual(["default-value"]);
    if (DEFAULT_VALUE.t2 === null) throw new Error("前提が壊れた");
    expect(exemptKindMessagesOf(DEFAULT_VALUE.t2)).toEqual([...DEFAULT_VALUE_EXEMPT_MESSAGES]);
    expect(TEST_KINDS.filter((kind) => !DEFAULT_VALUE.t2?.requiredKinds.includes(kind))).toEqual(["abnormal", "boundary"]);
  });

  it("default-value の行の T2' の固定文が今の定数と同じ", () => {
    const { notAllowed, ...messages } = DEFAULT_VALUE.t2?.messages ?? { notAllowed: "" };
    expect(notAllowed).toBe(DEFAULT_VALUE_NOT_ALLOWED_MESSAGE);
    expect(messages).toEqual(DEFAULT_VALUE_TEST_MESSAGES);
  });

  it("網羅の鍵の欄が、今の網羅の単位の鍵（`coverageUnitKey`）の欄と同じ", () => {
    const test: FixedTest = {
      id: "t",
      target: { requirementId: "R1", kind: "field", roleId: "f.x" },
      kind: "normal",
      operation: "validate",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      referenceData: [],
      expected: { kind: "ok", value: "k1" },
    };
    const key = coverageUnitKey(test, new Map([["t", "default-value"]]), new Map([["R1", "ruled" as const]]));
    const fields = Object.keys(JSON.parse(key ?? "{}") as Record<string, unknown>).filter((name) => name !== "basis");
    expect([...fields].sort()).toEqual([...(DEFAULT_VALUE.coverageKey ?? [])].sort());
  });

  it("旗から導出を選ぶ：on なら今の台帳の導出、off なら undefined（段は今の定数と関数）", () => {
    expect(ledgerViewOf({ ledger: true })).toBe(PROPERTY_LEDGER_VIEW);
    expect(ledgerViewOf({ ledger: false })).toBeUndefined();
    expect(ledgerViewOf(resolveV12Flags())).toBeUndefined();
    expect(resolveV12Flags()).toEqual(V12_FLAGS_OFF);
    expect(Object.keys(V12_PIPELINE_FLAGS)).toEqual([...V12_FLAG_NAMES]);
    expect(V12_PIPELINE_FLAGS).toEqual({ ledger: true });
  });
});

// ── 4. 規則の文 ──────────────────────────────────────────────────

describe("規則の文：台帳の行の文が今の段の規則の文と同じ（T1・T1''・T2・B1）", () => {
  const textOf = (definitions: readonly { id: string; text: string }[], id: string): string =>
    definitions.find((definition) => definition.id === id)?.text ?? "";

  it("T1 の文は R-nt-08 に、T2 の文は R-tsp-16 に、T1'' の文は R-sc-02 に、B1 の文は R-w11-10 に、そのまま在る", () => {
    expect(textOf(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08")).toContain(DEFAULT_VALUE.rules.t1 ?? "（無い）");
    expect(textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16")).toContain(DEFAULT_VALUE.rules.t2 ?? "（無い）");
    expect(textOf(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16")).toContain(rowOf("state-after-set").rules.t2 ?? "（無い）");
    expect(textOf(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02")).toContain(DEFAULT_VALUE.rules.t1Acceptance ?? "（無い）");
    expect(textOf(WRITE_V11A_RULE_DEFINITIONS, "R-w11-10")).toBe(DEFAULT_VALUE.rules.b1);
  });

  it("旗 on で組んだ T1・T2 の規則の定義は off の定数と深く等しく、規則の不備は on・off とも 0", () => {
    for (const [on, off] of [
      [nameTableRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), NAME_TABLE_RULE_DEFINITIONS],
      [testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), TEST_SPEC_RULE_DEFINITIONS],
    ] as const) {
      expect(on).toEqual(off);
      expect(ruleDefinitionDefects(on)).toEqual([]);
      expect(ruleDefinitionDefects(off)).toEqual([]);
    }
    // T1''・B1 は手 2a では台帳から組まない（今の定数のまま。不備 0）
    expect(ruleDefinitionDefects(SEMANTIC_CHECK_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects(WRITE_V11A_RULE_DEFINITIONS)).toEqual([]);
  });

  it("台帳の文・欄に受入の題材の言葉が無い", () => {
    const text = JSON.stringify(PROPERTY_LEDGER);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(COPY_TEXT).not.toContain(word);
  });
});

// ── 5. 人が読む写し ──────────────────────────────────────────────

/** 写しの文書から表を読む（見出しの行の次の区切りの行のあとの、`|` で始まる行） */
function copyTableOf(markdown: string): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  const lines = markdown.split("\n");
  const headerLine = `| ${PROPERTY_COPY_HEADER.join(" | ")} |`;
  const at = lines.indexOf(headerLine);
  if (at < 0) return { header: [], rows: [] };
  const cells = (line: string) => line.slice(1, -1).split(" | ").map((cell) => cell.trim());
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(cells(line.trim()));
  }
  return { header: cells(headerLine), rows };
}

/** 写しとコードの台帳の食い違い（欠け・余り・欄の食い違い） */
function copyDefects(markdown: string, ledger: readonly PropertyRow[]): readonly string[] {
  const table = copyTableOf(markdown);
  const defects: string[] = [];
  if (table.header.length === 0) return ["写しに表の見出しが無い"];
  const expected = ledger.map(propertyCopyCells);
  const ids = new Set(expected.map((cells) => cells[0]));
  for (const cells of expected) {
    const found = table.rows.filter((row) => row[0] === cells[0]);
    if (found.length === 0) defects.push(`写しに ${cells[0]} の行が無い`);
    else if (found.length > 1) defects.push(`写しに ${cells[0]} の行が重なっている`);
    else if (JSON.stringify(found[0]) !== JSON.stringify(cells)) defects.push(`写しの ${cells[0]} の行がコードと違う`);
  }
  for (const row of table.rows) if (!ids.has(row[0] ?? "")) defects.push(`写しに台帳に無い ${row[0] ?? ""} の行がある`);
  if (JSON.stringify(table.rows.map((row) => row[0])) !== JSON.stringify(expected.map((cells) => cells[0]))) {
    defects.push("写しの行の並びが台帳の順と違う");
  }
  return defects;
}

describe("人が読む写し（methodology/ledger/properties.md）がコードの台帳と 1 要素 1 行で一致する（D2）", () => {
  it("写しの表は台帳と同じ行数・同じ並びで、各行の欄がコードから組んだ欄と同じ", () => {
    const table = copyTableOf(COPY_TEXT);
    expect(table.header).toEqual([...PROPERTY_COPY_HEADER]);
    expect(table.rows).toEqual(PROPERTY_LEDGER.map(propertyCopyCells));
    expect(copyDefects(COPY_TEXT, PROPERTY_LEDGER)).toEqual([]);
  });

  it("二点測定：写しから行を 1 つ消すと落ちる", () => {
    const line = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith("| state-after-set |"));
    if (line === undefined) throw new Error("前提が壊れた");
    expect(copyDefects(COPY_TEXT.replace(`${line}\n`, ""), PROPERTY_LEDGER)).toContain("写しに state-after-set の行が無い");
  });

  it("二点測定：写しの行の状態を変えると落ちる（コードの状態を変えても落ちる）", () => {
    const changedCopy = COPY_TEXT.replace("| default-value | 有効 |", "| default-value | 削る候補 |");
    expect(changedCopy).not.toBe(COPY_TEXT);
    expect(copyDefects(changedCopy, PROPERTY_LEDGER)).toEqual(["写しの default-value の行がコードと違う"]);
    const changedCode = PROPERTY_LEDGER.map((row) => (row.id === "default-value" ? { ...row, state: "removal-candidate" as const } : row));
    expect(copyDefects(COPY_TEXT, changedCode)).toEqual(["写しの default-value の行がコードと違う"]);
  });

  it("二点測定：コードに行を足して写しに無いと落ち、写しにだけ行があっても落ちる", () => {
    const added = [...PROPERTY_LEDGER, { ...rowOf("when"), id: "enum-membership" }];
    expect(copyDefects(COPY_TEXT, added)).toContain("写しに enum-membership の行が無い");
    const extraLine = `| ${propertyCopyCells({ ...rowOf("when"), id: "enum-membership" }).join(" | ")} |`;
    const lastRow = COPY_TEXT.split("\n").find((candidate) => candidate.startsWith("| default-value |"));
    if (lastRow === undefined) throw new Error("前提が壊れた");
    expect(copyDefects(COPY_TEXT.replace(lastRow, `${lastRow}\n${extraLine}`), PROPERTY_LEDGER)).toContain(
      "写しに台帳に無い enum-membership の行がある",
    );
  });
});
