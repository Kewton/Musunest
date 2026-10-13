// Plan の開いている事項（open_issues）の、**解決の対象の一意化**と**同じ ID の行の衝突の検出**を、
// **純粋な関数**で扱う（Issue #460）。
//
// 解決の対象は、**同じ ID の open の行がちょうど 1 行のときだけ**その行にする。0 行なら閉じず、2 行以上
// なら ID だけで閉じない——**同じ ID の行を畳まない・まとめて閉じない**。ID の一致は同一内容の証明では
// ない（出どころの種類・文・重大度の一致でも同一の事項は証明できない）。聞いていない重大な事項を、ID の
// 一致だけで閉じない。
//
// 行を足すときは、**同じ ID の行（状態を問わない）が既にあれば衝突**として見分ける。衝突の判定に、
// 状態・文・重大度・出どころの種類・対応する要件は使わない（どれかが違えば別の事項であり、同じでも同一と
// 証明できない）。
//
// この file は端末もファイルも LLM も触らない（CLAUDE.md の不変条件）。
import type { PlanOpenIssue } from "@musunest/appspec-schema";

/**
 * 解決の対象の分類（有限の 3 つ）。**同じ ID の open の行の件数だけ**で決まる——状態・文・重大度・
 * 出どころ・対応する要件は見ない。解決済みの行は書き換えない（前の resolution を保つ）。
 *
 *   - `one` … 同じ ID の open の行がちょうど 1 行。その行（`index`）を解決する
 *   - `none` … 同じ ID の open の行が 0 行。何も閉じない
 *   - `multiple` … 同じ ID の open の行が 2 行以上。**どの行も閉じない**（黙って片方を選ばない）
 */
export type PlanResolveTarget =
  | { readonly kind: "one"; readonly index: number }
  | { readonly kind: "none" }
  | { readonly kind: "multiple"; readonly count: number };

/**
 * 解決の対象を、**同じ ID の open の行の件数**から決める（**純粋な関数**。Issue #460）。同じ ID の行が
 * 0・1・2 行以上と、状態 open／resolved のどの組合せでも、返り値は `one`・`none`・`multiple` のちょうど
 * 1 つに落ちる。
 */
export function resolveTargetOf(
  openIssues: readonly PlanOpenIssue[],
  issueId: string,
): PlanResolveTarget {
  const indexes: number[] = [];
  openIssues.forEach((issue, index) => {
    if (issue.id === issueId && issue.status === "open") indexes.push(index);
  });
  if (indexes.length === 0) return { kind: "none" };
  if (indexes.length === 1) return { kind: "one", index: indexes[0] as number };
  return { kind: "multiple", count: indexes.length };
}

/**
 * 開いている事項に**行を足す側**の出どころの種類（有限）。**ID の接頭辞からは推測しない**——`runPlan` が
 * 内部の対応で持ち、記録の分類にだけ使う。公開契約（`PlanOpenIssue`）は変えない（Issue #460）。
 */
export const PLAN_OPEN_ISSUE_SOURCES = [
  /** 要件化（P1）の未解決 */
  "unresolved",
  /** P3 の曖昧さ（初回・差分の点検） */
  "surface",
  /** 目録の未指定の観点（初回・差分の点検） */
  "catalog",
  /** P3 の申告の点検で曖昧さと判定した申告（初回・差分の点検） */
  "surface-check",
  /** 答えの矛盾からの再質問 */
  "contradiction",
] as const;
export type PlanOpenIssueSource = (typeof PLAN_OPEN_ISSUE_SOURCES)[number];

/**
 * 同じ ID の行が 2 行以上ある組（衝突。Issue #460）。**状態・文・重大度・出どころの種類・対応する要件は
 * 見ない**——どれが同じでも、1 行に畳んでよい証明にはならない。
 */
export interface PlanOpenIssueCollision {
  /** 先にあった行の位置 */
  readonly existingIndex: number;
  /** あとから現れた行の位置 */
  readonly addedIndex: number;
}

/**
 * 行の並びのなかで、**同じ ID の行が既にある**組をすべて返す（**純粋な関数**。Issue #460）。並びの順に
 * 見て、各 ID の最初の行の位置（`existingIndex`）と、あとから現れた行の位置（`addedIndex`）の組にする。
 */
export function detectOpenIssueCollisions(
  rows: readonly PlanOpenIssue[],
): readonly PlanOpenIssueCollision[] {
  const firstIndexById = new Map<string, number>();
  const collisions: PlanOpenIssueCollision[] = [];
  rows.forEach((row, index) => {
    const first = firstIndexById.get(row.id);
    if (first === undefined) firstIndexById.set(row.id, index);
    else collisions.push({ existingIndex: first, addedIndex: index });
  });
  return collisions;
}

/**
 * 申告の点検で曖昧さと判定した申告を写す、開いている事項の ID（Issue #460）。**点検の番号**（1 始まり。
 * 初回が 1、各差分で増える）を含める——局所の添字（`index`）は点検ごとに 0 から振られるので、これが
 * 無いと差分の点検が往復ごとに同じ ID を作り得る。**ID の形を変えるのは、この申告点検の曖昧さだけ**で
 * ある。往復をまたいで衝突しない形にする。
 */
export function surfaceCheckOpenIssueId(check: number, index: number): string {
  return `OI:surface-check:${check}:${index}`;
}

/** 衝突した行の件数（既存の出どころ × 追加の出どころの組ごと。Issue #460） */
export interface PlanOpenIssueConflictKindCount {
  readonly existing: PlanOpenIssueSource;
  readonly added: PlanOpenIssueSource;
  readonly count: number;
}

/**
 * 開いている事項の衝突の記録（**値は入れない**。件数と有限の分類と版だけ。Issue #460）。事項 ID・要件 ID・
 * 文・答えは写さない。
 */
export interface PlanOpenIssueConflicts {
  /** 同じ ID の行が 2 つ以上あった ID の件数 */
  readonly ids: number;
  /** 衝突した行の件数（既存の出どころ × 追加の出どころの組ごと） */
  readonly rows: readonly PlanOpenIssueConflictKindCount[];
  /** 解決の対象が 0 行だった件数 */
  readonly emptyTargets: number;
  /** 衝突を検出した往復の版（無ければ null） */
  readonly round: number | null;
}
