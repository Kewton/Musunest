// 大きさの生成器（v1.1α の呼び出し数の回帰の契約試験の補助。Issue #546）。
//
// 要件の数 N と試験の数 M から、走らせる部分（`runGenerationV11a`）を偽物の LLM・偽物の判定で流すための材料を
// **決定的に**組む：確定した仕様・要件の一覧・名前の表と T1 の応答・J4 の偽物の判定の答え（印なし）・T1'' と B3' の判定・
// 試験の仕様（T2）の応答（要件ごとに正常・異常・境界を配って合計 M）・宣言。LLM は呼ばない純粋な関数である
// （同じ N・M からは、何度呼んでも深く等しい値を返す）。
//
// 題材は抽象的なものだけを使う（項目の値が正であること・画面に項目が出ること）。受入の題材の言葉は使わない。
//
// 要件は 2 種類に分ける：
//   - 値を縛る要件（ruled。固定した試験で確かめる）… 数値の項目 `v<i>` と同名の検査 `v<i> > 0`。試験は
//     正常・異常・境界の 3 件を配り、余った試験は正常の試験を足して配る（1 要件 16 件の上限の内側）
//   - 画面に出ればよい要件（existence-only。構造で確かめる）… 文字列の項目 `w<i>` と、それを出す表の画面
//     `view<i>`。試験は `view-shows` の 1 件
// 試験の数 M が少なく、3N に満たないときは、足りない分だけ後ろの要件を構造で確かめる要件にする
// （構造の要件は 1 件で済む）。M < N（要件ごとに最低 1 件）は作れないので例外にする。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { AGENT_LIMITS } from "../../limits.js";
import type { Requirement, RequirementList } from "../../pipeline.js";
import type { JudgeAnswer } from "../../judge.js";
import { draftOf, t1ResponseOf } from "./fixtures.js";
import type { NameTable, NameTableRow } from "../names.js";

/** 中央値（要件 15・試験 39）と観測した最大（要件 25・試験 68）。Issue #546 */
export const MEDIAN_SIZE = { requirements: 15, tests: 39 } as const;
export const MAX_SIZE = { requirements: 25, tests: 68 } as const;

const KINDS = ["normal", "abnormal", "boundary"] as const;
type Kind = (typeof KINDS)[number];

/** 判定の指摘の種類と引用（T1''・B3' の拒否の組み立て用） */
export type RejectionSpec = readonly [kind: string, quote: string];

/** 生成した材料（関数は呼ぶたびに新しい値を返す） */
export interface SizedMaterials {
  readonly requirementCount: number;
  readonly testCount: number;
  /** 構造で確かめる要件の数 */
  readonly structuralCount: number;
  /** 要件の ID（R1〜RN） */
  readonly ids: readonly string[];
  readonly source: string;
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly table: NameTable;
  /** T1 の応答（下書きの形。要件 ID を持たず写しを添える） */
  readonly nameTableResponse: () => Record<string, unknown>;
  /** J4 の偽物の判定の答え（所属の組ごと。印なし＝値 0.9） */
  readonly adviceAnswers: () => Readonly<Record<string, JudgeAnswer>>;
  /** T1'' と B3' の判定（`rejects` の要件だけ拒否。省けば全部受理） */
  readonly judgments: (rejects?: Readonly<Record<string, RejectionSpec>>) => { readonly judgments: readonly unknown[] };
  /** T2 の応答（正常・異常・境界を配って合計 M。`omitAbnormalOf` を指すと、その要件の異常の試験を外す） */
  readonly testSpecResponse: (options?: { readonly omitAbnormalOf?: string }) => { readonly classifications: readonly unknown[]; readonly tests: readonly unknown[] };
  /** 宣言の YAML（`defectOf` の要件の検査を、正常の試験が落ちる式にする） */
  readonly declaration: (defectOf?: readonly string[]) => string;
  /** 要件の文（引用に使う） */
  readonly textOf: (requirementId: string) => string;
}

function requirementOf(id: string, text: string): Requirement {
  return { id, text, quote: text, position: { start: 0, end: text.length } };
}

/** 材料を組む。N 件の要件・M 件の試験（N ≤ M ≤ N × 16） */
export function buildSized(requirementCount: number, testCount: number): SizedMaterials {
  if (!Number.isInteger(requirementCount) || requirementCount < 1) throw new RangeError("要件の数は 1 以上の整数であること");
  if (!Number.isInteger(testCount) || testCount < requirementCount) throw new RangeError("試験の数は要件の数以上であること");
  // 構造の要件の数：3 × (N − s) + s ≤ M を満たす最小の s（余りは正常の試験を足して配る）
  const structuralCount = Math.max(0, Math.ceil((3 * requirementCount - testCount) / 2));
  const ruledCount = requirementCount - structuralCount;
  if (ruledCount < 1) throw new RangeError("値を縛る要件が 1 件も取れない（試験の数が少なすぎる）");
  const extraTests = testCount - (3 * ruledCount + structuralCount);
  if ((3 * ruledCount + extraTests) / ruledCount > AGENT_LIMITS.testsPerRequirement) {
    throw new RangeError("試験の数が多すぎる（1 要件の上限を超える）");
  }

  const ids = Array.from({ length: requirementCount }, (_, index) => `R${index + 1}`);
  const isStructural = (index: number): boolean => index >= ruledCount;
  const textOfIndex = (index: number): string =>
    isStructural(index) ? `画面 view${index + 1} に項目 w${index + 1} の値が出る。` : `項目 v${index + 1} の値は 0 より大きい。`;
  const requirements = ids.map((id, index) => requirementOf(id, textOfIndex(index)));
  const list: RequirementList = { requirements, decisions: [], unresolved: [] };
  const source = requirements.map((requirement) => requirement.text).join("");

  const plan: ConfirmedPlan = {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: `plan-sized-${requirementCount}-${testCount}`,
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: source }],
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };

  const row = (
    partial: Pick<NameTableRow, "id" | "kind" | "entity" | "name" | "type"> & { readonly from: string },
  ): NameTableRow => ({
    id: partial.id,
    kind: partial.kind,
    entity: partial.entity,
    name: partial.name,
    role: `要件 ${partial.from} が使う対象`,
    source: { requirementId: partial.from, quote: requirements.find((item) => item.id === partial.from)?.text ?? "" },
    type: partial.type,
    options: null,
    groupBy: null,
    refEntity: null,
  });
  const rows: NameTableRow[] = [row({ id: "e.item", kind: "entity", entity: null, name: "item", type: null, from: "R1" })];
  ids.forEach((id, index) => {
    const n = index + 1;
    if (isStructural(index)) {
      rows.push(row({ id: `f.item.w${n}`, kind: "field", entity: "e.item", name: `w${n}`, type: "string", from: id }));
      rows.push(row({ id: `s.view${n}`, kind: "screen", entity: "e.item", name: `view${n}`, type: { view: "table" }, from: id }));
    } else {
      rows.push(row({ id: `f.item.v${n}`, kind: "field", entity: "e.item", name: `v${n}`, type: "number", from: id }));
    }
  });
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  const table: NameTable = {
    rows,
    ownership: ids.map((id, index) => ({
      requirementId: id,
      roles: (isStructural(index) ? [`f.item.w${index + 1}`, `s.view${index + 1}`] : [`f.item.v${index + 1}`]).map(stated),
    })),
    verification: ids.map((id, index) =>
      isStructural(index)
        ? { requirementId: id, kind: "structural" as const, reason: "画面に出ることだけを求める", checks: ["view-shows" as const] }
        : { requirementId: id, kind: "fixed-test" as const },
    ),
    classification: ids.map((id, index) => ({
      requirementId: id,
      nature: isStructural(index) ? ("existence-only" as const) : ("ruled" as const),
    })),
  };

  const rawTest = (options: {
    readonly id: string;
    readonly requirementId: string;
    readonly targetKind: string;
    readonly roleId: string;
    readonly kind: Kind;
    readonly operation: string;
    readonly observes: string;
    readonly input: unknown;
    readonly expected: { readonly kind: "ok" | "error"; readonly value: string | null; readonly code: string | null };
    readonly assertion: Record<string, unknown> | null;
  }): Record<string, unknown> => ({
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind: options.kind,
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: options.expected,
    assertion: options.assertion,
    observes: options.observes,
  });
  const validateTest = (index: number, kind: Kind, suffix: string): Record<string, unknown> => {
    const n = index + 1;
    const value = kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 5;
    return rawTest({
      id: `t${n}-${kind}${suffix}`,
      requirementId: `R${n}`,
      targetKind: "field",
      roleId: `f.item.v${n}`,
      kind,
      operation: "validate",
      observes: "validation",
      input: { [`f.item.v${n}`]: value },
      expected: kind === "abnormal" ? { kind: "error", value: null, code: "E_INVALID" } : { kind: "ok", value: "true", code: null },
      assertion: null,
    });
  };
  const viewTest = (index: number): Record<string, unknown> => {
    const n = index + 1;
    return rawTest({
      id: `t${n}-shows`,
      requirementId: `R${n}`,
      targetKind: "screen",
      roleId: `s.view${n}`,
      kind: "normal",
      operation: "structure",
      observes: "view-structure",
      input: {},
      expected: { kind: "ok", value: "true", code: null },
      assertion: { check: "view-shows", expected: null, refEntity: null, role: `f.item.w${n}` },
    });
  };

  const testSpecResponse = (options: { readonly omitAbnormalOf?: string } = {}) => {
    const tests: Record<string, unknown>[] = [];
    for (let index = 0; index < requirementCount; index += 1) {
      if (isStructural(index)) {
        tests.push(viewTest(index));
        continue;
      }
      for (const kind of KINDS) {
        if (kind === "abnormal" && options.omitAbnormalOf === `R${index + 1}`) continue;
        tests.push(validateTest(index, kind, ""));
      }
      // 余った試験は、値を縛る要件へ順に正常の試験を足して配る（同じ要件に 2 件以上のときは 2 周目以降）
      const share = Math.floor(extraTests / ruledCount) + (index < extraTests % ruledCount ? 1 : 0);
      for (let extra = 1; extra <= share; extra += 1) tests.push(validateTest(index, "normal", `-${extra + 1}`));
    }
    return {
      classifications: ids.map((id, index) => ({ requirementId: id, nature: isStructural(index) ? "existence-only" : "ruled" })),
      tests,
    };
  };

  const declaration = (defectOf: readonly string[] = []): string => {
    const lines: string[] = ["entities:", "  - name: item", "    fields:"];
    for (let index = 0; index < requirementCount; index += 1) {
      const n = index + 1;
      lines.push(isStructural(index) ? `      w${n}:` : `      v${n}:`, `        type: ${isStructural(index) ? "string" : "number"}`);
    }
    lines.push("computed: []");
    // 値を縛る要件の項目は、表に無い追加の画面 `overview` から辿れる（画面から辿れない項目は対応表の落ちになる）
    const views = Array.from({ length: requirementCount }, (_, index) => index).filter(isStructural);
    const shown = Array.from({ length: requirementCount }, (_, index) => index).filter((index) => !isStructural(index));
    lines.push("views:", "  - name: overview", "    type: table", "    entity: item", `    show: [${shown.map((index) => `v${index + 1}`).join(", ")}]`);
    for (const index of views) {
      lines.push(`  - name: view${index + 1}`, "    type: table", "    entity: item", `    show: [w${index + 1}]`);
    }
    lines.push("actions: []");
    const checks = Array.from({ length: requirementCount }, (_, index) => index).filter((index) => !isStructural(index));
    lines.push("validations:");
    for (const index of checks) {
      const n = index + 1;
      lines.push(`  - name: v${n}`, "    entity: item", `    expression: v${n} > ${defectOf.includes(`R${n}`) ? 1000 : 0}`);
    }
    lines.push("permissions:", "  - name: read", "    subject: minIdentity", "  - name: write", "    subject: minIdentity", "minIdentity:", "  mode: anonymous", "");
    return lines.join("\n");
  };

  return {
    requirementCount,
    testCount,
    structuralCount,
    ids,
    source,
    plan,
    list,
    table,
    nameTableResponse: () => t1ResponseOf(draftOf(list, table)),
    adviceAnswers: () => {
      const answers: Record<string, JudgeAnswer> = {};
      for (const entry of table.ownership) {
        for (const role of entry.roles) answers[`need:${entry.requirementId}:${role.id}`] = { kind: "noul", noul: 0.9 };
      }
      return answers;
    },
    judgments: (rejects = {}) => ({
      judgments: ids.map((id) => {
        const found = rejects[id];
        return found === undefined
          ? { requirementId: id, verdict: "accept", kind: null, quote: null }
          : { requirementId: id, verdict: "reject", kind: found[0], quote: found[1] };
      }),
    }),
    testSpecResponse,
    declaration,
    textOf: (requirementId) => requirements.find((requirement) => requirement.id === requirementId)?.text ?? "",
  };
}
