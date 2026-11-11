// C2（要件の写像の所属）と C3（表の意味の点検の判定）の形の拒否を、**本文を保存せず**、失敗した対象と再試行での
// 回復を特定できる形で残す診断（Issue #898。方法論 03 の H4。失敗のモード M-17）。
//
// この 1 か所が診断の**型・直列化関数・出力ファイル名**の対応を定める。通常の Build（`runGenerationV11a`）と段指定の
// 走り（`runStageRangeV11a`）の両方が、同じ `buildStopDiagnosticsFile` で同じ名前のファイルを書く（二重に定義しない）。
//
// **本文を残さない。** 記録は既定のキーと固定の分類から組み、対象 ID は実行入力の対象から選ぶ。応答が持つ未知の ID・
// 自由文・問題の `message`・例外の文・余分なプロパティは写さない。`Problem` の `field` や `message` から分類を
// 逆算しない——分類は発生側（`names.ts` の所属の検査・`semantic-check.ts` の形の検査）が付ける。
//
// **診断は制御に効かない。** 呼び出し側は、記録を受け取って例外を投げても段の結果・要求・試行・予算・持ち越し・
// 採用する表を変えない（`reportStopDiagnostic`）。診断を作る側は、処理対象（応答・表・問題）を診断のために変えない。
import { createHash } from "node:crypto";
import type { Problem } from "../stages/prompt.js";
import { serializeJson } from "../stages/prompt.js";

/** 診断の置き場所（納品物ではなく診断のディレクトリの下。`--out` の直下からの相対パス） */
export const STOP_DIAGNOSTICS_FILE = "diagnostics/stop-diagnostics.json" as const;

/** C2（所属不備）の問題の固定分類（同じ `field` でも分岐ごとに別の値にする） */
export const C2_PROBLEM_CLASSES = [
  "unknown-ownership-id", // 所属の表の ID が表の行に無い
  "duplicate-ownership-id", // 同じ要件の中で同じ行を 2 回所属させている
  "unowned-row", // どの要件にも所属しない行
  "other", // 上記以外（所属の不備ではない問題）
] as const;
export type C2ProblemClass = (typeof C2_PROBLEM_CLASSES)[number];

/** C2 の検査の局面（初回・部分書き直し・全体再試行・合併後の検査） */
export const C2_PHASES = ["initial", "rewrite", "rebuild", "merged"] as const;
export type C2Phase = (typeof C2_PHASES)[number];

/** C3（判定の完全性・形）の問題の固定分類 */
export const C3_PROBLEM_CLASSES = [
  "missing-judgment", // 対象の要件に判定が無い
  "unknown-target", // 判定の要件 ID が対象に無い
  "duplicate-judgment", // 同じ要件の判定が重なっている
  "bad-verdict", // 判定の値が accept・reject のいずれでもない
  "bad-kind", // 拒否の種類が有限の一覧に無い
  "bad-quote", // 引用が空・見つからない
  "not-object", // 応答・判定が写像でない
  "not-array", // 判定が並びでない
  "bad-accept-payload", // 受理の kind・quote が null でない
  "other", // 上記以外
] as const;
export type C3ProblemClass = (typeof C3_PROBLEM_CLASSES)[number];

/** C3 の試行の結末（回復・受理・失敗・応答を観測していない） */
export const C3_STATUSES = ["accepted", "recovered", "failed", "not-started"] as const;
export type C3Status = (typeof C3_STATUSES)[number];

/** 問題の安全な位置（分からない位置は null。未知の ID を表の行へ無理に結び付けない） */
export interface StopDiagnosticPosition {
  /** 表の行の添字 */
  readonly row_index: number | null;
  /** 所属の並びの添字（要件ごとの所属） */
  readonly ownership_index: number | null;
  /** 所属の中の役割の添字 */
  readonly role_index: number | null;
}

/** 位置を持たない問題 */
export const NO_POSITION: StopDiagnosticPosition = Object.freeze({ row_index: null, ownership_index: null, role_index: null });

/** C2 の問題 1 つ（分類と安全な位置だけ。`field`・`message`・ID の生値は持たない） */
export interface C2ProblemDiagnostic extends StopDiagnosticPosition {
  readonly class: C2ProblemClass;
}

/** C2 の診断 1 件（1 回の検査。`problems` は既存の `Problem` と同じ件数・同じ順） */
export interface C2StopDiagnostic {
  readonly kind: "c2";
  /** C2 の回（1 から） */
  readonly round: number;
  readonly phase: C2Phase;
  /** 形の試行（1 から。局面が合併後の検査なら null） */
  readonly attempt: number | null;
  readonly problems: readonly C2ProblemDiagnostic[];
}

/** C3 の診断 1 件（1 つの束の 1 回の形の試行） */
export interface C3StopDiagnostic {
  readonly kind: "c3";
  /** 点検の回（1 から） */
  readonly round: number;
  /** 束の添字（0 から。一覧の順） */
  readonly bundle_index: number;
  /** 形の試行（1 から） */
  readonly attempt: number;
  /** その束の対象の要件 ID（一覧の順） */
  readonly targets: readonly string[];
  /** 欠落した判定の要件 ID（対象の順。応答を観測していない試行は空で `observed` が偽） */
  readonly missing: readonly string[];
  /** 問題の固定分類（既存の `Problem` と同じ件数・同じ順） */
  readonly problems: readonly C3ProblemClass[];
  /** 形の検査に渡した `output` を `serializeJson` で直列化した UTF-8 の SHA-256（観測していなければ null） */
  readonly response_sha256: string | null;
  /** 応答を観測したか（偽のとき `missing` の空は「欠落 0」ではなく未観測） */
  readonly observed: boolean;
  readonly status: C3Status;
}

export type StopDiagnostic = C2StopDiagnostic | C3StopDiagnostic;

/**
 * 形の検査に渡した `output` の SHA-256（`serializeJson` の UTF-8）。HTTP の本文ではなく、adapter を通した後の
 * 構造化出力が対象である（Issue #898 の対象範囲）。
 */
export function responseSha256(output: unknown): string {
  return createHash("sha256").update(serializeJson(output), "utf8").digest("hex");
}

/**
 * C2 の問題と分類・位置を、既存の `Problem` と同じ件数・同じ順の診断の並びにする。分類が足りない・位置が無い
 * 場合は `other`・全て null で埋める（**値を推測しない**。件数は `problems` に合わせる）。
 */
export function c2ProblemsOf(
  problems: readonly Problem[],
  classifications: readonly C2ProblemClass[] | undefined,
  positions: readonly (StopDiagnosticPosition | null)[] | undefined,
): readonly C2ProblemDiagnostic[] {
  return problems.map((_, index) => {
    const position = positions?.[index] ?? NO_POSITION;
    return {
      class: classifications?.[index] ?? "other",
      row_index: position.row_index,
      ownership_index: position.ownership_index,
      role_index: position.role_index,
    };
  });
}

/** C2 の診断 1 件を組む（分類・位置は既存の問題と同じ順。件数は既存の問題に合わせる） */
export function c2StopDiagnostic(input: {
  readonly round: number;
  readonly phase: C2Phase;
  readonly attempt: number | null;
  readonly problems: readonly Problem[];
  readonly classifications?: readonly C2ProblemClass[];
  readonly positions?: readonly (StopDiagnosticPosition | null)[];
}): C2StopDiagnostic {
  return {
    kind: "c2",
    round: input.round,
    phase: input.phase,
    attempt: input.attempt,
    problems: c2ProblemsOf(input.problems, input.classifications, input.positions),
  };
}

/**
 * 診断を渡す。**渡し先が例外を投げても制御を変えない**（診断は観測だけで、段の結果・要求・試行・予算・持ち越し・
 * 採用する表に効かない）。呼び出し側の制御はここで止めない。
 */
export function reportStopDiagnostic(
  sink: ((record: StopDiagnostic) => void) | undefined,
  record: StopDiagnostic,
): void {
  if (sink === undefined) return;
  try {
    sink(record);
  } catch {
    // 診断の口の失敗は制御に効かせない（握りつぶす）
  }
}

/**
 * 診断のファイルを組む（純粋）。記録が 0 件ならファイルを作らない。**manifest は組まない**（診断であって納品物ではない）。
 * 直列化の形はこの 1 か所だけで決める。
 */
export function buildStopDiagnosticsFile(
  records: readonly StopDiagnostic[],
): readonly { readonly path: string; readonly text: string }[] {
  return records.length === 0
    ? []
    : [{ path: STOP_DIAGNOSTICS_FILE, text: serializeStopDiagnostics(records) }];
}

/** 診断の直列化（既定の 2 字下げ + 末尾の改行 1 つ。ほかの診断のファイルと同じ形） */
export function serializeStopDiagnostics(records: readonly StopDiagnostic[]): string {
  return `${JSON.stringify({ records }, null, 2)}\n`;
}
