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
// LLM を呼ばない純粋な関数だけを置く（表の SHA-256 を求めるので `deriveCarryOver` は Promise を返す）。
import type { RequirementList } from "../pipeline.js";
import type { CoverageLoss } from "./coverage.js";
import { toV1, type V1Conversion } from "./convert.js";
import { nameTableSha256, ownersByRowId, type NameTable } from "./names.js";

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
  /** 残る要件が 0 か（全件持ち越し。D15） */
  readonly allCarried: boolean;
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

  // semantic-check（T1''。対象は unresolved を除く全要件）
  const semanticTargets = ids.filter((id) => !reasons.has(id));
  assertComplete(input.semanticCheck.judgments, semanticTargets, ["accept", "reject"], "表の意味の点検");
  for (const judgment of input.semanticCheck.judgments) {
    if (judgment.verdict === "reject") add(judgment.requirementId, "semantic-check", judgment.kind);
  }

  // decl-check（B3'。対象は T1・T1'' で残った要件）
  if (input.declCheck !== undefined) {
    const { declarationSha256, result } = input.declCheck;
    if (result.declarationSha256 !== declarationSha256) {
      throw new Error("持ち越し：宣言の意味の点検の結果が、採用した宣言の SHA-256 と合わない");
    }
    const declTargets = ids.filter((id) => !reasons.has(id));
    assertComplete(result.judgments, declTargets, ["accept", "reject", "unmarked"], "宣言の意味の点検");
    for (const judgment of result.judgments) {
      if (judgment.verdict !== "accept") add(judgment.requirementId, "decl-check", reasonOf(judgment));
    }
  }

  // coverage（B6）
  if (input.coverage !== undefined) {
    const known = new Set(ids);
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
  const remainingRequirementIds = ids.filter((id) => !carried.has(id));
  return {
    entries: ids.flatMap((id) => {
      const listed = reasons.get(id);
      return listed === undefined ? [] : [{ requirementId: id, reasons: listed }];
    }),
    excludedRowIds,
    remainingRequirementIds,
    allCarried: remainingRequirementIds.length === 0,
  };
}

/** 持ち越しを除いた版（一覧・表・v1 の写し） */
export interface PrunedForCarryOver {
  readonly list: RequirementList;
  readonly table: NameTable;
  /** 除いた表の v1 の写し（B3 に渡す役割の表・恒等の対応・所属） */
  readonly conversion: V1Conversion;
}

/**
 * 一覧・所属・B3 に渡す役割の表と恒等の対応から、持ち越しの要件と、その要件だけが所属させる行を除いた版を返す
 * （D14。共有する行は残す）。builder に見せる表（全行）は呼ぶ側が別に持つ。
 */
export function pruneForCarryOver(list: RequirementList, table: NameTable, carryOver: CarryOver): PrunedForCarryOver {
  const carried = new Set(carryOver.entries.map((entry) => entry.requirementId));
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
  return {
    list: { ...list, requirements: list.requirements.filter((requirement) => !carried.has(requirement.id)) },
    table: pruned,
    conversion: toV1(pruned),
  };
}
