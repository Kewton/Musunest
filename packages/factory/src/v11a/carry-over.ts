// 持ち越し（unresolved）の集合と、除く範囲（07-architecture-v1.1a.md §1.2・D14・D15。Issue #505）。
//
// 持ち越しの出どころは 4 つ：
//   - `name-table` … T1 の確かめ方が `unresolved`（理由と制約 ID）
//   - `semantic-check` … T1'' の拒否が（T1 の 2 回目のあとも）残った要件
//   - `decl-check` … B3' の点検が尽きるか停滞したあとに残った拒否（該当箇所・参照先を引き当てられない要件を含む）
//   - `coverage` … B6 の網羅の落ち（単位を失った要件）
//
// 集合は**採用した表・表の SHA が一致する完全な点検結果・宣言の SHA が一致する完全な点検結果・B6 の結果**から
// コードが導く。**SHA の合わない結果・不完全な結果（判定の欠落・重複・対象の外の要件 ID）は例外で断る**——
// 「点検していない」状態で、持ち越しを空にして先へ進む経路を作らない。
//
// 除く範囲（D14）：持ち越しの要件は一覧と所属から除き、**その要件だけが所属させる行**は B3 に渡す役割の表と
// 恒等の対応からも除く。別の要件も所属させる行（共有する行）は残す。残る要件が 0 なら全件持ち越し（D15）。
//
// 除いたあとに、**残る行・残る試験の参照が除いた行を指していれば例外で断る**（黙って進めない。窓口の判断
// 2026-10-16・PR #515）。参照している行ごと持ち越しへ回す案は採らない——持ち越しの出どころ（4 つ）の外の
// 理由で要件を増やすことになり、`carry-over.json` の契約が変わるためである。行の参照は所属 entity・
// 見出しの元の項目（`groupBy.field`）・参照先（`refEntity`）、試験の参照は対象・参照データの対象・空の entity・
// 構造の検査の `refEntity`・`role`・入力と参照データの値の鍵である。
//
// 要件でない文（Issue #550）：確かめ方の種類が台帳の「受理で除く」種類（`non-requirement`）で、T1'' が**受理した**要件は、
// 残る一覧から除き、**持ち越しに数えない**（`nonRequirements`。所属 0 行なので除く行は増えない）。拒否されれば今までどおり
// 持ち越し（出どころ semantic-check）。免除は T1'' の受理だけで決め、T1 の分類・要件の出どころ・**要件 ID の形を見ない**。
// 旗 off の表はこの種類を持てない（T1' が落とす）ので、off の持ち越しは今と同じになる。
//
// LLM を呼ばない純粋な関数だけを置く（表の SHA-256 を求めるので `deriveCarryOver` は Promise を返す）。
import type { FixedTest, TestSuite } from "../fixed-test.js";
import type { RequirementList } from "../pipeline.js";
import { isRecord } from "../stages/prompt.js";
import type { CoverageLoss } from "./coverage.js";
import { toV1, type V1Conversion } from "./convert.js";
import { nameTableSha256, ownersByRowId, type NameTable } from "./names.js";
import { PROPERTY_LEDGER_VIEW, type UpstreamLedgerView } from "../v12/ledger.js";

/** 持ち越しの出どころ */
export const CARRY_OVER_ORIGINS = ["name-table", "semantic-check", "decl-check", "coverage"] as const;
export type CarryOverOrigin = (typeof CARRY_OVER_ORIGINS)[number];

/** 意味の点検の 1 判定（受理／拒否。拒否は種類と引用を持つ） */
export type SemanticJudgment =
  | { readonly requirementId: string; readonly verdict: "accept" }
  | { readonly requirementId: string; readonly verdict: "reject"; readonly kind: string; readonly quote: string };

/** T1'' の完全な結果（表の SHA に結ぶ） */
export interface SemanticCheckResult {
  readonly tableSha256: string;
  readonly judgments: readonly SemanticJudgment[];
}

/** B3' の 1 判定（受理／拒否／該当箇所か参照先を引き当てられない＝`unmarked`） */
export type DeclJudgment =
  | SemanticJudgment
  | { readonly requirementId: string; readonly verdict: "unmarked" };

/** B3' の完全な結果（宣言の SHA に結ぶ） */
export interface DeclCheckResult {
  readonly declarationSha256: string;
  readonly judgments: readonly DeclJudgment[];
}

/** 持ち越しを導く入力 */
export interface CarryOverInput {
  readonly list: RequirementList;
  /** 採用した表（SHA-256 はここから求めて、点検結果の SHA と照らす） */
  readonly table: NameTable;
  /** T1'' の完全な結果 */
  readonly semanticCheck: SemanticCheckResult;
  /** B3' の完全な結果と、採用した宣言の SHA（B 側へ進む前は省く） */
  readonly declCheck?: { readonly declarationSha256: string; readonly result: DeclCheckResult };
  /** B6 の結果（棄却のあとに省かずに渡す。棄却が無ければ空の並び） */
  readonly coverage?: readonly CoverageLoss[];
  /** 受理で除く確かめ方の種類を引く台帳の導出（省けばコードの台帳。Issue #550） */
  readonly ledger?: UpstreamLedgerView;
}

/** 持ち越しの理由 1 つ（出どころと理由） */
export interface CarryOverReason {
  readonly origin: CarryOverOrigin;
  readonly reason: string;
}

/** 要件ごとの持ち越し */
export interface CarryOverEntry {
  readonly requirementId: string;
  readonly reasons: readonly CarryOverReason[];
}

/** 持ち越しの集合と除く範囲 */
export interface CarryOver {
  /** 要件ごとの持ち越し（一覧の順） */
  readonly entries: readonly CarryOverEntry[];
  /** その要件だけが所属させる行の `id`（表の順。共有する行は入らない） */
  readonly excludedRowIds: readonly string[];
  /** 残る要件（一覧の順） */
  readonly remainingRequirementIds: readonly string[];
  /** 残る要件が 0 か（全件持ち越し。持ち越しと要件でない文で全件のときも真。D15） */
  readonly allCarried: boolean;
  /**
   * T1'' が受理した要件でない文の要件 ID（一覧の順）。残る一覧にも持ち越しにも入らない。1 件も無ければ欄を持たない
   * （今の記録とバイト列で同じにする。Issue #550）
   */
  readonly nonRequirements?: readonly string[];
}

/** 判定の完全性：対象の全要件にちょうど 1 判定（欠落・重複・対象の外は例外） */
function assertComplete(
  judgments: readonly { readonly requirementId: string; readonly verdict: string }[],
  targets: readonly string[],
  allowed: readonly string[],
  what: string,
): void {
  const targetSet = new Set(targets);
  const seen = new Set<string>();
  for (const judgment of judgments) {
    if (!targetSet.has(judgment.requirementId)) throw new Error(`${what}：対象の外の要件 ID の判定がある`);
    if (seen.has(judgment.requirementId)) throw new Error(`${what}：同じ要件の判定が重なっている`);
    if (!allowed.includes(judgment.verdict)) throw new Error(`${what}：判定の値が知らないものである`);
    seen.add(judgment.requirementId);
  }
  if (seen.size !== targetSet.size) throw new Error(`${what}：判定が欠けた要件がある（不完全な結果）`);
}

const reasonOf = (judgment: DeclJudgment): string =>
  judgment.verdict === "reject" ? judgment.kind : judgment.verdict;

/**
 * 持ち越しの集合と除く範囲を導く（§1.2）。SHA の合わない結果・不完全な結果は例外で断る。
 * B3' の対象は、T1・T1'' で持ち越しにならなかった要件である。
 */
export async function deriveCarryOver(input: CarryOverInput): Promise<CarryOver> {
  const { list, table } = input;
  const ids = list.requirements.map((requirement) => requirement.id);
  const reasons = new Map<string, CarryOverReason[]>();
  const add = (requirementId: string, origin: CarryOverOrigin, reason: string): void => {
    const listed = reasons.get(requirementId) ?? [];
    listed.push({ origin, reason });
    reasons.set(requirementId, listed);
  };

  const tableSha256 = await nameTableSha256(table);
  if (input.semanticCheck.tableSha256 !== tableSha256) {
    throw new Error("持ち越し：表の意味の点検の結果が、採用した表の SHA-256 と合わない");
  }

  // name-table（T1 の unresolved）
  const verificationById = new Map(table.verification.map((entry) => [entry.requirementId, entry] as const));
  for (const id of ids) {
    const verification = verificationById.get(id);
    if (verification === undefined) throw new Error("持ち越し：採用した表に確かめ方の無い要件がある");
    if (verification.kind === "unresolved") add(id, "name-table", verification.reason);
  }

  // semantic-check（T1''。対象は unresolved を除く全要件）。受理で除く確かめ方の要件は、受理されたときだけ要件でない文
  const semanticTargets = ids.filter((id) => !reasons.has(id));
  assertComplete(input.semanticCheck.judgments, semanticTargets, ["accept", "reject"], "表の意味の点検");
  const excludedKinds = new Set((input.ledger ?? PROPERTY_LEDGER_VIEW).excludedWhenAcceptedKinds);
  const nonRequirementSet = new Set<string>();
  for (const judgment of input.semanticCheck.judgments) {
    if (judgment.verdict === "reject") add(judgment.requirementId, "semantic-check", judgment.kind);
    else if (excludedKinds.has(verificationById.get(judgment.requirementId)?.kind ?? "")) nonRequirementSet.add(judgment.requirementId);
  }
  const nonRequirements = ids.filter((id) => nonRequirementSet.has(id));

  // decl-check（B3'。対象は T1・T1'' で残った要件。要件でない文は対象に入れない）
  if (input.declCheck !== undefined) {
    const { declarationSha256, result } = input.declCheck;
    if (result.declarationSha256 !== declarationSha256) {
      throw new Error("持ち越し：宣言の意味の点検の結果が、採用した宣言の SHA-256 と合わない");
    }
    const declTargets = ids.filter((id) => !reasons.has(id) && !nonRequirementSet.has(id));
    assertComplete(result.judgments, declTargets, ["accept", "reject", "unmarked"], "宣言の意味の点検");
    for (const judgment of result.judgments) {
      if (judgment.verdict !== "accept") add(judgment.requirementId, "decl-check", reasonOf(judgment));
    }
  }

  // coverage（B6）
  if (input.coverage !== undefined) {
    const known = new Set(ids.filter((id) => !nonRequirementSet.has(id)));
    const seen = new Set<string>();
    for (const loss of input.coverage) {
      if (!known.has(loss.requirementId)) throw new Error("持ち越し：網羅の落ちに一覧の外の要件 ID がある");
      if (seen.has(loss.requirementId)) throw new Error("持ち越し：網羅の落ちに同じ要件が重なっている");
      if (loss.units.length === 0) throw new Error("持ち越し：網羅の落ちに失った単位が無い");
      seen.add(loss.requirementId);
      add(loss.requirementId, "coverage", "lost-coverage-units");
    }
  }

  const carried = new Set(reasons.keys());
  const owners = ownersByRowId(table);
  const excludedRowIds = table.rows
    .filter((row) => {
      const rowOwners = owners.get(row.id) ?? [];
      return rowOwners.length > 0 && rowOwners.every((owner) => carried.has(owner));
    })
    .map((row) => row.id);
  const dangling = danglingRowReferences(table, new Set(excludedRowIds));
  if (dangling.length > 0) {
    throw new Error("持ち越し：残る行の参照（所属 entity・見出しの元・参照先）が除いた行を指している");
  }
  const remainingRequirementIds = ids.filter((id) => !carried.has(id) && !nonRequirementSet.has(id));
  return {
    entries: ids.flatMap((id) => {
      const listed = reasons.get(id);
      return listed === undefined ? [] : [{ requirementId: id, reasons: listed }];
    }),
    excludedRowIds,
    remainingRequirementIds,
    allCarried: remainingRequirementIds.length === 0,
    ...(nonRequirements.length === 0 ? {} : { nonRequirements }),
  };
}

/** 除いた行を指す参照の位置（`field` は位置、`message` は固定文。値は埋めない） */
export interface DanglingReference {
  readonly field: string;
  readonly message: string;
}

/** 残る行（除かない行）の参照が、除いた行を指す位置を挙げる（所属 entity・`groupBy.field`・`refEntity`） */
export function danglingRowReferences(table: NameTable, excluded: ReadonlySet<string>): readonly DanglingReference[] {
  const found: DanglingReference[] = [];
  table.rows.forEach((row, index) => {
    if (excluded.has(row.id)) return;
    if (row.entity !== null && excluded.has(row.entity)) {
      found.push({ field: `rows[${index}].entity`, message: "残る行の所属 entity が除いた行を指している" });
    }
    if (row.groupBy !== null && excluded.has(row.groupBy.field)) {
      found.push({ field: `rows[${index}].groupBy.field`, message: "残る行の見出しの元が除いた行を指している" });
    }
    if (row.refEntity !== null && excluded.has(row.refEntity)) {
      found.push({ field: `rows[${index}].refEntity`, message: "残る行の参照先が除いた行を指している" });
    }
  });
  return found;
}

/** 試験が参照する表の `id`（対象・参照データの対象・空の entity・構造の検査・入力と参照データの値の鍵） */
function referencedIdsOf(test: FixedTest): readonly string[] {
  const ids: string[] = [];
  if (test.target.roleId !== undefined) ids.push(test.target.roleId);
  for (const row of test.referenceData) {
    if (row.target.roleId !== undefined) ids.push(row.target.roleId);
    ids.push(...Object.keys(row.values));
  }
  if (test.inputContract !== undefined) ids.push(...test.inputContract.emptyEntities);
  if (test.assertion?.refEntity !== undefined) ids.push(test.assertion.refEntity);
  if (test.assertion?.role !== undefined) ids.push(test.assertion.role);
  if (isRecord(test.input)) ids.push(...Object.keys(test.input));
  return ids;
}

/** 残る試験の参照が、除いた行を指す位置を挙げる（`field` は試験の添字） */
export function danglingTestReferences(suite: TestSuite, excluded: ReadonlySet<string>): readonly DanglingReference[] {
  const found: DanglingReference[] = [];
  suite.tests.forEach((test, index) => {
    if (referencedIdsOf(test).some((id) => excluded.has(id))) {
      found.push({ field: `tests[${index}]`, message: "残る試験の参照が除いた行を指している" });
    }
  });
  return found;
}

/** 持ち越しを除いた版（一覧・表・v1 の写し） */
export interface PrunedForCarryOver {
  readonly list: RequirementList;
  readonly table: NameTable;
  /** 除いた表の v1 の写し（B3 に渡す役割の表・恒等の対応・所属） */
  readonly conversion: V1Conversion;
  /** 残る要件の試験（試験の組を渡したときだけ） */
  readonly suite?: TestSuite;
}

/**
 * 一覧・所属・B3 に渡す役割の表と恒等の対応から、持ち越しの要件と、その要件だけが所属させる行を除いた版を返す
 * （D14。共有する行は残す）。T1'' が受理した要件でない文（`nonRequirements`）も一覧・所属・確かめ方・分類・試験から除く
 * （所属 0 行なので除く行は増えない。Issue #550）。builder に見せる表（全行）は呼ぶ側が別に持つ。試験の組を渡せば、残る要件の試験に
 * 絞り、その参照が除いた行を指していれば例外で断る。残る行の参照が除いた行を指していても例外で断る。
 */
export function pruneForCarryOver(
  list: RequirementList,
  table: NameTable,
  carryOver: CarryOver,
  suite?: TestSuite,
): PrunedForCarryOver {
  const carried = new Set([
    ...carryOver.entries.map((entry) => entry.requirementId),
    ...(carryOver.nonRequirements ?? []),
  ]);
  const excluded = new Set(carryOver.excludedRowIds);
  const keep = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => !carried.has(entry.requirementId));
  const pruned: NameTable = {
    rows: table.rows.filter((row) => !excluded.has(row.id)),
    ownership: keep(table.ownership).map((entry) => ({
      requirementId: entry.requirementId,
      roles: entry.roles.filter((role) => !excluded.has(role.id)),
    })),
    verification: keep(table.verification),
    classification: keep(table.classification),
  };
  if (danglingRowReferences(table, excluded).length > 0) {
    throw new Error("持ち越し：残る行の参照（所属 entity・見出しの元・参照先）が除いた行を指している");
  }
  const remainingSuite =
    suite === undefined
      ? undefined
      : {
          tests: suite.tests.filter((test) => !carried.has(test.target.requirementId)),
          ...(suite.classifications === undefined
            ? {}
            : { classifications: suite.classifications.filter((entry) => !carried.has(entry.requirementId)) }),
        };
  if (remainingSuite !== undefined && danglingTestReferences(remainingSuite, excluded).length > 0) {
    throw new Error("持ち越し：残る試験の参照が除いた行を指している");
  }
  return {
    list: { ...list, requirements: list.requirements.filter((requirement) => !carried.has(requirement.id)) },
    table: pruned,
    conversion: toV1(pruned),
    ...(remainingSuite === undefined ? {} : { suite: remainingSuite }),
  };
}
