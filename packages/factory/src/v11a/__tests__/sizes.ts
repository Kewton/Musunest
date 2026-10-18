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
//
// 旗の組（`flags`。省けば全部 off）を渡すと、その走りの段の schema に合う応答を組む（Issue #592）：旗 `v12.ledger` が on なら
// T1 の応答は台帳の導出の schema（行の型に `aggregate` を持つ。確かめ方は台帳の種類のうち fixed-test・structural）に合わせる。
// 表・判定・試験・宣言は旗によらず同じ値である。
//
// 台本 `codeWritten`（Issue #595。省けば今のまま）を渡すと、値を縛る要件の頭の 3 件を、台帳の型だけで値が決まる要件にする：
// R1 は既定値（選択肢の項目 `k1` の既定値 a1）、R2 は選択肢の集合（選択肢の項目 `k2`）、R3 はアプリ全体の件数（計算 `total`）。
// 組の試験の数は M のまま（R1・R2 は 1 件、R3 は正常・境界・異常の 3 件。余りはほかの値を縛る要件へ配る）。旗 `v12.ids` が on
// なら、T2 の応答からコードが作る試験（R1・R2 の 1 件と R3 の境界・異常）を除く（応答は M − 4 件・組は M 件）。台帳 on が要る。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { AGENT_LIMITS } from "../../limits.js";
import type { Requirement, RequirementList } from "../../pipeline.js";
import type { JudgeAnswer } from "../../judge.js";
import { codeIdRenameOf, draftOf, idsResponseList, idsResponsesOf, t1ResponseOf, withCodeIds } from "./fixtures.js";
import type { NameTable, NameTableRow } from "../names.js";
import { ledgerViewOf, resolveV12Flags, type V12Flags } from "../../v12/ledger.js";

/** 中央値（要件 15・試験 39）と観測した最大（要件 25・試験 68）。Issue #546 */
export const MEDIAN_SIZE = { requirements: 15, tests: 39 } as const;
export const MAX_SIZE = { requirements: 25, tests: 68 } as const;

const KINDS = ["normal", "abnormal", "boundary"] as const;
type Kind = (typeof KINDS)[number];

/** 台本の選択（Issue #595） */
export interface SizedOptions {
  /** 値を縛る要件の頭の 3 件を、既定値・選択肢の集合・アプリ全体の件数の要件にする（台帳 on が要る） */
  readonly codeWritten?: boolean;
}

/** 台本 `codeWritten` の旗 `v12.ids` の走りでコードが作る試験の数（R1・R2 の 1 件ずつと R3 の境界・異常） */
export const CODE_WRITTEN_TEST_COUNT = 4;

/** 判定の指摘の種類と引用（T1''・B3' の拒否の組み立て用） */
export type RejectionSpec = readonly [kind: string, quote: string];

/** 生成した材料（関数は呼ぶたびに新しい値を返す） */
export interface SizedMaterials {
  readonly requirementCount: number;
  readonly testCount: number;
  /** 組んだ旗の組（省いた名前は off） */
  readonly flags: V12Flags;
  /** 構造で確かめる要件の数 */
  readonly structuralCount: number;
  /** 要件の ID（R1〜RN） */
  readonly ids: readonly string[];
  readonly source: string;
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly table: NameTable;
  /** T1 の応答（下書きの形。要件 ID を持たず写しを添える。旗 `v12.ids` が off の走りだけ） */
  readonly nameTableResponse: () => Record<string, unknown>;
  /**
   * 表を組む段の応答を呼ばれる順に（旗 `v12.ids` が on なら C1 の 3 束と C2 の 1 つ、off なら T1 の 1 つ。Issue #593・#627）
   */
  readonly tableResponses: () => readonly Record<string, unknown>[];
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

/** 材料を組む。N 件の要件・M 件の試験（N ≤ M ≤ N × 16）。旗の組を渡せば、その走りの schema に合う応答を組む */
export function buildSized(
  requirementCount: number,
  testCount: number,
  flags?: Partial<V12Flags>,
  options: SizedOptions = {},
): SizedMaterials {
  const resolvedFlags = resolveV12Flags(flags);
  const ledger = ledgerViewOf(resolvedFlags);
  const codeWritten = options.codeWritten === true;
  if (!Number.isInteger(requirementCount) || requirementCount < 1) throw new RangeError("要件の数は 1 以上の整数であること");
  if (!Number.isInteger(testCount) || testCount < requirementCount) throw new RangeError("試験の数は要件の数以上であること");
  if (codeWritten && !resolvedFlags.ledger) throw new RangeError("台本 codeWritten は台帳 on の走りだけ");
  // 構造の要件の数：3 × (N − s) + s ≤ M を満たす最小の s（余りは正常の試験を足して配る）
  const structuralCount = Math.max(0, Math.ceil((3 * requirementCount - testCount) / 2));
  const ruledCount = requirementCount - structuralCount;
  if (ruledCount < 1) throw new RangeError("値を縛る要件が 1 件も取れない（試験の数が少なすぎる）");
  // 台本 codeWritten の頭の 3 件（既定値・選択肢の集合・アプリ全体の件数）は余りを配らない
  const leading = codeWritten ? 3 : 0;
  if (ruledCount - leading < 1) throw new RangeError("台本 codeWritten に値を縛る要件が足りない");
  const extraTests = testCount - (3 * ruledCount + structuralCount) + (codeWritten ? 4 : 0);
  const plainCount = ruledCount - leading;
  if ((3 * plainCount + extraTests) / plainCount > AGENT_LIMITS.testsPerRequirement) {
    throw new RangeError("試験の数が多すぎる（1 要件の上限を超える）");
  }

  const ids = Array.from({ length: requirementCount }, (_, index) => `R${index + 1}`);
  const isStructural = (index: number): boolean => index >= ruledCount;
  /** 台本 codeWritten の頭の 3 件の役（ほかは null） */
  const leadingOf = (index: number): "default" | "enum" | "aggregate" | null =>
    !codeWritten || index >= leading ? null : (["default", "enum", "aggregate"] as const)[index] ?? null;
  const LEADING_TEXTS = { default: "項目 k1 は、未入力なら保存の時点で a1 になる。", enum: "項目 k2 は、a1・a2 のどれかである。", aggregate: "項目の件数を見られる。" } as const;
  const textOfIndex = (index: number): string => {
    const lead = leadingOf(index);
    if (lead !== null) return LEADING_TEXTS[lead];
    return isStructural(index) ? `画面 view${index + 1} に項目 w${index + 1} の値が出る。` : `項目 v${index + 1} の値は 0 より大きい。`;
  };
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
    const lead = leadingOf(index);
    if (lead === "default" || lead === "enum") {
      rows.push({ ...row({ id: `f.item.k${n}`, kind: "field", entity: "e.item", name: `k${n}`, type: "enum", from: id }), options: ["a1", "a2"] });
    } else if (lead === "aggregate") {
      rows.push(
        row({
          id: "c.total",
          kind: "computation",
          entity: null,
          name: "total",
          type: { valueType: "number", scope: "app", form: "aggregate", aggregate: { kind: "count", entity: "e.item" } },
          from: id,
        }),
      );
    } else if (isStructural(index)) {
      rows.push(row({ id: `f.item.w${n}`, kind: "field", entity: "e.item", name: `w${n}`, type: "string", from: id }));
      rows.push(row({ id: `s.view${n}`, kind: "screen", entity: "e.item", name: `view${n}`, type: { view: "table" }, from: id }));
    } else {
      rows.push(row({ id: `f.item.v${n}`, kind: "field", entity: "e.item", name: `v${n}`, type: "number", from: id }));
    }
  });
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  const baseTable: NameTable = {
    rows,
    ownership: ids.map((id, index) => {
      const lead = leadingOf(index);
      const roles =
        lead === "default" || lead === "enum"
          ? [`f.item.k${index + 1}`]
          : lead === "aggregate"
          ? ["c.total", "e.item"]
          : isStructural(index)
          ? [`f.item.w${index + 1}`, `s.view${index + 1}`]
          : [`f.item.v${index + 1}`];
      return { requirementId: id, roles: roles.map(stated) };
    }),
    verification: ids.map((id, index) => {
      const lead = leadingOf(index);
      if (lead === "default") return { requirementId: id, kind: "default-value" as const, value: "a1" };
      if (lead === "enum") return { requirementId: id, kind: "enum-membership" as const };
      return isStructural(index)
        ? { requirementId: id, kind: "structural" as const, reason: "画面に出ることだけを求める", checks: ["view-shows" as const] }
        : { requirementId: id, kind: "fixed-test" as const };
    }),
    classification: ids.map((id, index) => ({
      requirementId: id,
      nature: isStructural(index) ? ("existence-only" as const) : ("ruled" as const),
    })),
  };
  // 旗 `v12.ids` の走りは、表の ID をコードの形（E1・E1.F2・V1…）にし、行を C1 が組む順に並べ、出典を持たない（Issue #593）。
  // 試験の仕様の応答も同じ ID で対象を指す。off の走りの値は変えない
  const rename = resolvedFlags.ids ? codeIdRenameOf(baseTable) : new Map<string, string>();
  const rid = (id: string): string => rename.get(id) ?? id;
  const table: NameTable = resolvedFlags.ids ? withCodeIds(baseTable) : baseTable;

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
    readonly emptyEntities?: readonly string[];
    readonly referenceData?: readonly Record<string, unknown>[];
  }): Record<string, unknown> => ({
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind: options.kind,
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: options.emptyEntities ?? [] },
    referenceData: options.referenceData ?? [],
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
      roleId: rid(`f.item.v${n}`),
      kind,
      operation: "validate",
      observes: "validation",
      input: { [rid(`f.item.v${n}`)]: value },
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
      roleId: rid(`s.view${n}`),
      kind: "normal",
      operation: "structure",
      observes: "view-structure",
      input: {},
      expected: { kind: "ok", value: "true", code: null },
      assertion: { check: "view-shows", expected: null, refEntity: null, role: rid(`f.item.w${n}`) },
    });
  };

  /** 台本 codeWritten の頭の 3 件の試験（旗 `v12.ids` が on なら、コードが作る試験を除いた値の要る試験だけ） */
  const leadingTests = (index: number, lead: "default" | "enum" | "aggregate"): Record<string, unknown>[] => {
    const n = index + 1;
    const fieldTest = (observes: string, value: unknown) =>
      rawTest({
        id: `t${n}-${observes}`,
        requirementId: `R${n}`,
        targetKind: "field",
        roleId: rid(`f.item.k${n}`),
        kind: "normal",
        operation: "validate",
        observes,
        input: {},
        expected: { kind: "ok", value: JSON.stringify(value), code: null },
        assertion: null,
      });
    if (lead === "default") return resolvedFlags.ids ? [] : [fieldTest("default-value", "a1")];
    if (lead === "enum") return resolvedFlags.ids ? [] : [fieldTest("enum-membership", ["a1", "a2"])];
    const aggregateTest = (kind: Kind, observes: string, value: unknown, emptyEntities: readonly string[], referenceData: readonly Record<string, unknown>[]) =>
      rawTest({
        id: `t${n}-${kind}`,
        requirementId: `R${n}`,
        targetKind: "computation",
        roleId: rid("c.total"),
        kind,
        operation: "aggregate",
        observes,
        input: {},
        expected: { kind: "ok", value: JSON.stringify(value), code: null },
        assertion: null,
        emptyEntities,
        referenceData,
      });
    const sourceRows = [1, 2].map((row) => ({
      target: { requirementId: `R${n}`, kind: "entity", roleId: rid("e.item") },
      rowId: `item-${String(row)}`,
      values: "{}",
    }));
    return [
      aggregateTest("normal", "value", 2, [], sourceRows),
      ...(resolvedFlags.ids
        ? []
        : [aggregateTest("boundary", "empty-aggregate", 0, [rid("e.item")], []), aggregateTest("abnormal", "empty-aggregate", null, [], [])]),
    ];
  };

  const testSpecResponse = (options: { readonly omitAbnormalOf?: string } = {}) => {
    const tests: Record<string, unknown>[] = [];
    for (let index = 0; index < requirementCount; index += 1) {
      const lead = leadingOf(index);
      if (lead !== null) {
        tests.push(...leadingTests(index, lead));
        continue;
      }
      if (isStructural(index)) {
        tests.push(viewTest(index));
        continue;
      }
      for (const kind of KINDS) {
        if (kind === "abnormal" && options.omitAbnormalOf === `R${index + 1}`) continue;
        tests.push(validateTest(index, kind, ""));
      }
      // 余った試験は、値を縛る要件へ順に正常の試験を足して配る（同じ要件に 2 件以上のときは 2 周目以降）
      const share = Math.floor(extraTests / plainCount) + (index - leading < extraTests % plainCount ? 1 : 0);
      for (let extra = 1; extra <= share; extra += 1) tests.push(validateTest(index, "normal", `-${extra + 1}`));
    }
    return {
      // 旗 v12.ids の走りは、コードが試験を作る要件（既定値・選択肢の集合）を T2 の一覧から除くので、その分類も書かない
      classifications: ids
        .map((id, index) => ({ requirementId: id, nature: isStructural(index) ? "existence-only" : "ruled", lead: leadingOf(index) }))
        .filter((entry) => !(resolvedFlags.ids && (entry.lead === "default" || entry.lead === "enum")))
        .map(({ requirementId, nature }) => ({ requirementId, nature })),
      tests,
    };
  };

  const declaration = (defectOf: readonly string[] = []): string => {
    const lines: string[] = ["entities:", "  - name: item", "    fields:"];
    for (let index = 0; index < requirementCount; index += 1) {
      const n = index + 1;
      const lead = leadingOf(index);
      if (lead === "default" || lead === "enum") {
        lines.push(`      k${n}:`, "        type: enum", "        options:", "          a1: A1", "          a2: A2", ...(lead === "default" ? ["        default: a1"] : []));
        continue;
      }
      if (lead === "aggregate") continue;
      lines.push(isStructural(index) ? `      w${n}:` : `      v${n}:`, `        type: ${isStructural(index) ? "string" : "number"}`);
    }
    lines.push(...(codeWritten ? ["computed:", "  - name: total", "    scope: app", "    aggregate:", "      count: item", "    type: number"] : ["computed: []"]));
    // 値を縛る要件の項目は、表に無い追加の画面 `overview` から辿れる（画面から辿れない項目は対応表の落ちになる）
    const views = Array.from({ length: requirementCount }, (_, index) => index).filter(isStructural);
    const shownName = (index: number): string | null => {
      const lead = leadingOf(index);
      return lead === "aggregate" ? null : lead !== null ? `k${index + 1}` : `v${index + 1}`;
    };
    const shown = Array.from({ length: requirementCount }, (_, index) => index)
      .filter((index) => !isStructural(index))
      .flatMap((index) => {
        const name = shownName(index);
        return name === null ? [] : [name];
      });
    lines.push("views:", "  - name: overview", "    type: table", "    entity: item", `    show: [${shown.join(", ")}]`);
    for (const index of views) {
      lines.push(`  - name: view${index + 1}`, "    type: table", "    entity: item", `    show: [w${index + 1}]`);
    }
    if (codeWritten) lines.push("  - name: totals", "    type: dashboard", "    widgets:", "      - type: number", "        value: total");
    lines.push("actions: []");
    const checks = Array.from({ length: requirementCount }, (_, index) => index).filter((index) => !isStructural(index) && leadingOf(index) === null);
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
    flags: resolvedFlags,
    structuralCount,
    ids,
    source,
    plan,
    list,
    table,
    nameTableResponse: () => t1ResponseOf(draftOf(list, table), ledger),
    tableResponses: () => (resolvedFlags.ids ? idsResponseList(idsResponsesOf(list, table, ledger)) : [t1ResponseOf(draftOf(list, table), ledger)]),
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
