// 探索型の直しの部品（08-architecture-v1.2.md §3 の決定 1 (c)・§4 のループの行・§9 の手 4 の前半。Issue #551）。
//
// 旗 `v12.search-repair`（`V12Flags.searchRepair`。既定 off）が on の走りでだけ、v1.1α の B5 のループ（`v11a/run.ts`）が
// ここの関数で版を比べる。**純粋な関数と定数だけ**を置き、LLM・評価口・段を呼ばない。
//
//   - 版の違反の数（`countViolations`）：静的チェックに落ちた版は、通った版のどれよりも悪い（最悪）。通った版は、B3 の結び付けの
//     落ち・B3' の拒否・B3' の unmarked・B4 の不一致・B4 の未解決の件数の重みつきの和。B3' を流していない版（点検が尽きた・
//     B3 に落ちた）は理由と宣言の SHA-256 を持ち、拒否と unmarked を「不明」（null）として、0 に数えない（fail-closed）
//   - 採るかの判定（`isStrictlyBetter`）：一番良い版より**厳密に**小さいときだけ採る。等しければ採らない。不明を持つ候補は、
//     静的チェックに落ちた版のほかのどの版よりも良いとは見なさない
//   - 停滞（`stagnationAction`）：採れない版が `stagnationRepeats`（v1 と同じ 2）続いたら停滞。1 回目は作り直し、作り直しの
//     あとにもう一度停滞したら止める（`stagnation`）
//   - 予算の行（`SEARCH_REPAIR_BUDGET`。§4.1）：往復 6・作り直し 1 回（形のやり直し 1 を含む）。**v1 の上限の表
//     （`AGENT_LIMITS`）には足さない**。共通の口の実試行の門・締切・予算・B3' の点検 6 回はそのまま掛かる
//     v1.2 の呼び出しの上限の表（段ごとの論理の枠・実試行の門・判定の枝。旗 `v12.ids`。Issue #592）は `v12/limits.ts` に置き、
//     ループと作り直しの行はここの値から写す
//   - 作り直しに渡す名前付きの失敗の一覧（`namedFailuresOf`。試験 ID・要件 ID・種類と、種類ごとの固定文だけ）
//   - 探索の記録の形（`SearchRepairRecord`。納品物の `search-repair.json` に書くのは `v11a/bundle-v11a.ts`）
import type { RuleDefinition } from "../stages/prompt.js";

// ── 違反の種類と重み ───────────────────────────────────────────────

/** 違反の数に数える種類（この順に和を取り、記録の内訳もこの順） */
export const VIOLATION_KINDS = [
  "correspondence-miss",
  "decl-rejection",
  "decl-unmarked",
  "test-mismatch",
  "test-unresolved",
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/** 違反の種類ごとの重みの定義（規則と同じく `why`・`since` を持つ。`text` は人が読む定義の文） */
export interface ViolationWeightDefinition extends RuleDefinition {
  readonly kind: ViolationKind;
  readonly weight: number;
}

/** 重み（初期値はすべて 1。種類ごとの定数） */
export const VIOLATION_WEIGHTS: readonly ViolationWeightDefinition[] = [
  {
    id: "W-sr-01",
    kind: "correspondence-miss",
    weight: 1,
    text: "B3 の結び付けの落ち 1 件を 1 と数える。",
    why: "名前の照合の落ちは門の失敗であり、直す段に名前付きで渡る（08 §4 のループの行）。初期値は種類で差を付けない",
    since: "Issue #551",
  },
  {
    id: "W-sr-02",
    kind: "decl-rejection",
    weight: 1,
    text: "B3' の拒否 1 件を 1 と数える。",
    why: "宣言の意味の点検の拒否が残る版は full にならない（07 D13）。初期値は種類で差を付けない",
    since: "Issue #551",
  },
  {
    id: "W-sr-03",
    kind: "decl-unmarked",
    weight: 1,
    text: "B3' で文脈（該当箇所・参照先）を引き当てられない要件 1 件を 1 と数える。",
    why: "候補の unmarked で一覧と組を縮めると、捨てるべき版が比較の文脈を変える。確定した文脈では違反として数える（Issue #551）",
    since: "Issue #551",
  },
  {
    id: "W-sr-04",
    kind: "test-mismatch",
    weight: 1,
    text: "B4 の不一致 1 件を 1 と数える。",
    why: "停滞 8 本は B4 の不一致が 2 版続いたもの（08 §3 の 1 (c)）。初期値は種類で差を付けない",
    since: "Issue #551",
  },
  {
    id: "W-sr-05",
    kind: "test-unresolved",
    weight: 1,
    text: "B4 の未解決 1 件を 1 と数える。",
    why: "流せない試験は合格に数えない（v1 の ⑦ と同じ向き）。初期値は種類で差を付けない",
    since: "Issue #551",
  },
];

/** 種類 → 重み */
const weightOf = (kind: ViolationKind): number => VIOLATION_WEIGHTS.find((entry) => entry.kind === kind)?.weight ?? 1;

// ── 探索の規則 ───────────────────────────────────────────────────

/** 探索の規則（ループのコードが守ること。LLM には送らない。`ruleDefinitionDefects` で不備を照らす） */
export const SEARCH_REPAIR_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-sr-01",
    text: "一番良い版を保ち、直す段には常に一番良い版とその失敗だけを渡す。最終の版は一番良い版である。",
    why: "今のループは直した版を無条件に次の版にするので、良くなった版を悪い版で上書きできる（方法論 03 §1 の H4。08 §3 の 1 (c)）",
    since: "Issue #551",
  },
  {
    id: "R-sr-02",
    text: "違反の数が一番良い版より厳密に小さい候補だけを採る。等しい候補は採らない。",
    why: "同数の版を採ると、2 回目の直しで正しかった値が動く版を採れる（P1-r3・P10-r1。08 §3 の 1 (c)）",
    since: "Issue #551",
  },
  {
    id: "R-sr-03",
    text: "静的チェックに落ちた版は、通った版のどれよりも悪い。B3' を流していない版は拒否を不明とし、0 に数えず、静的チェックに落ちた版のほかのどの版よりも良いとは見なさない。",
    why: "点検していない版を、点検して拒否 0 の版より良いと判定すると、点検の門を迂回できる（fail-closed）",
    since: "Issue #551",
  },
  {
    id: "R-sr-04",
    text: "採れない候補が stagnationRepeats 続いたら停滞とし、1 回目は空の文脈で宣言を作り直す。作り直しのあとにもう一度停滞したら stagnation で止める。",
    why: "同じ文脈で同じ直しを繰り返すと効かない（方法論 03 §1 の H5。08 §3 の 1 (c)・§4 のループの行）",
    since: "Issue #551",
  },
  {
    id: "R-sr-05",
    text: "候補の評価で生じた状態（B3' の unmarked の持ち越し）は候補の内に置き、採ったときだけ確定へ移す。候補の B3・B4 は確定した文脈で流し、一番良い版と同じ文脈の数で比べる。",
    why: "今の版の評価は unmarked をその場で共有の持ち越しに入れて一覧と組を縮めるので、捨てるべき版が共有の状態を変える（Issue #551）",
    since: "Issue #551",
  },
  {
    id: "R-sr-06",
    text: "確定した文脈が変わったら（候補を採った・棄却のあとの網羅で持ち越した）、一番良い版の違反の数をコードの検査（B3・B4）だけで数え直す。B3' の拒否は、持ち越しになった要件の分を除いて引き継ぐ。",
    why: "文脈が変われば数の基準が変わる。数え直しに判定・点検の呼び出しを足さない（08 §4.1 の予算）",
    since: "Issue #551",
  },
];

// ── 予算の行（§4.1。v1 の上限の表とは別）──────────────────────────────

/** 探索型の直しの予算の行（v1.2 の別の表。`AGENT_LIMITS` には足さない） */
export const SEARCH_REPAIR_BUDGET = {
  /** 直しの往復（v1 の `repairRoundTrips` と同じ値） */
  repairRoundTrips: 6,
  /** 停滞と見なす、採れない版の続いた数（v1 の `stagnationRepeats` と同じ値） */
  stagnationRepeats: 2,
  /** 空の文脈での作り直し（B1 をもう 1 回）の回数 */
  rewrites: 1,
  /** 作り直しの形のやり直し（共通の窓口の 1 回。作り直し 1 回の内に含む） */
  rewriteShapeRetries: 1,
} as const;

/** 予算の行の定義（値ごとに `why`・`since`） */
export const SEARCH_REPAIR_BUDGET_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "B-sr-01",
    text: `直しの往復は ${String(SEARCH_REPAIR_BUDGET.repairRoundTrips)} 回まで。`,
    why: "v1 の往復の上限と同じ値（08 §4 のループの行「往復 6」）。門を緩めない",
    since: "Issue #551",
  },
  {
    id: "B-sr-02",
    text: `採れない版が ${String(SEARCH_REPAIR_BUDGET.stagnationRepeats)} 続いたら停滞とする。`,
    why: "v1 の停滞の回数と同じ値（08 §4 のループの行「停滞 2」）",
    since: "Issue #551",
  },
  {
    id: "B-sr-03",
    text: `空の文脈での作り直しは ${String(SEARCH_REPAIR_BUDGET.rewrites)} 回まで（形のやり直し ${String(SEARCH_REPAIR_BUDGET.rewriteShapeRetries)} 回を含む）。`,
    why: "§4.1 の表の「空の文脈での作り直し（停滞時）」の行（段全体 1 回・形 1）。呼び出しの上限・締切・予算は変えない",
    since: "Issue #551",
  },
];

// ── 版の違反の数 ──────────────────────────────────────────────────

/** B3' を流していない理由 */
export type DeclUnknownReason = "static-check" | "name-check" | "exhausted";

/** 版の検査の事実（件数だけ） */
export interface VersionFacts {
  readonly declarationSha256: string;
  readonly staticCheckPassed: boolean;
  /** B3 の結び付けの落ち */
  readonly correspondenceMisses: number;
  /** B3' の結果（流していなければ理由） */
  readonly decl:
    | { readonly ran: true; readonly rejections: number; readonly unmarked: number }
    | { readonly ran: false; readonly reason: DeclUnknownReason };
  /** B4 の不一致 */
  readonly testMismatches: number;
  /** B4 の未解決 */
  readonly testUnresolved: number;
}

/** 版の違反の数 */
export type VersionViolations =
  | { readonly kind: "static-check-failed"; readonly declarationSha256: string }
  | {
      readonly kind: "counted";
      readonly declarationSha256: string;
      /** 種類ごとの件数（不明は null） */
      readonly breakdown: Readonly<Record<ViolationKind, number | null>>;
      /** 分かっている件数の重みつきの和（不明は和に入れない。比べ方は `isStrictlyBetter`） */
      readonly knownTotal: number;
      /** B3' を流していない版の理由と宣言の SHA-256（流した版は null） */
      readonly unknown: { readonly reason: DeclUnknownReason; readonly declarationSha256: string } | null;
    };

/** 版の違反の数を数える（純粋） */
export function countViolations(facts: VersionFacts): VersionViolations {
  if (!facts.staticCheckPassed) return { kind: "static-check-failed", declarationSha256: facts.declarationSha256 };
  const breakdown: Record<ViolationKind, number | null> = {
    "correspondence-miss": facts.correspondenceMisses,
    "decl-rejection": facts.decl.ran ? facts.decl.rejections : null,
    "decl-unmarked": facts.decl.ran ? facts.decl.unmarked : null,
    "test-mismatch": facts.testMismatches,
    "test-unresolved": facts.testUnresolved,
  };
  const knownTotal = VIOLATION_KINDS.reduce((sum, kind) => sum + (breakdown[kind] ?? 0) * weightOf(kind), 0);
  return {
    kind: "counted",
    declarationSha256: facts.declarationSha256,
    breakdown,
    knownTotal,
    unknown: facts.decl.ran ? null : { reason: facts.decl.reason, declarationSha256: facts.declarationSha256 },
  };
}

/**
 * 候補を採るか（一番良い版より厳密に良いか）。静的チェックに落ちた候補は採らない。一番良い版が静的チェックに落ちていれば、
 * 通った候補を採る。B3' を流していない候補（不明を持つ）は採らない。ほかは分かっている和が厳密に小さいときだけ採る。
 */
export function isStrictlyBetter(candidate: VersionViolations, best: VersionViolations): boolean {
  if (candidate.kind === "static-check-failed") return false;
  if (best.kind === "static-check-failed") return true;
  if (candidate.unknown !== null) return false;
  return candidate.knownTotal < best.knownTotal;
}

// ── 停滞 ─────────────────────────────────────────────────────────

/** 次の手（直す・作り直す・止める） */
export type StagnationAction = "repair" | "rewrite" | "stop";

/** 採れない版の続いた数と作り直しの回数から、次の手を決める */
export function stagnationAction(
  notAdopted: number,
  rewritesUsed: number,
  budget: { readonly stagnationRepeats: number; readonly rewrites: number } = SEARCH_REPAIR_BUDGET,
): StagnationAction {
  if (notAdopted < budget.stagnationRepeats) return "repair";
  return rewritesUsed < budget.rewrites ? "rewrite" : "stop";
}

/** 候補 1 つのあとの、採れない版の続いた数（採れば 0 に戻る） */
export function notAdoptedAfter(notAdopted: number, adopted: boolean): number {
  return adopted ? 0 : notAdopted + 1;
}

// ── 作り直しに渡す名前付きの失敗 ───────────────────────────────────────

/** 名前付きの失敗の種類 */
export const NAMED_FAILURE_KINDS = ["static-check", ...VIOLATION_KINDS] as const;
export type NamedFailureKind = (typeof NAMED_FAILURE_KINDS)[number];

/** 種類ごとの固定文（値・宣言の原文・会話を埋めない） */
export const NAMED_FAILURE_MESSAGES: Readonly<Record<NamedFailureKind, string>> = {
  "static-check": "宣言が静的チェックに落ちた",
  "correspondence-miss": "名前の表の行が宣言に結び付かない",
  "decl-rejection": "宣言の意味の点検が要件を拒否した",
  "decl-unmarked": "宣言に要件の該当箇所か参照先が無い",
  "test-mismatch": "固定した試験の期待と宣言の振る舞いが一致しない",
  "test-unresolved": "固定した試験を宣言に対して流せない",
};

/** 作り直しに渡す失敗 1 件（試験 ID・要件 ID・種類と固定文だけ） */
export interface NamedFailure {
  readonly testId: string | null;
  readonly requirementId: string | null;
  readonly kind: NamedFailureKind;
  readonly message: string;
}

/** 一番良い版に残った失敗（ID だけ） */
export interface NamedFailureSource {
  readonly staticCheckPassed: boolean;
  readonly correspondenceMisses: readonly { readonly requirementId: string }[];
  readonly rejections: readonly { readonly requirementId: string }[];
  readonly unmarked: readonly string[];
  readonly mismatches: readonly { readonly testId: string }[];
  readonly unresolved: readonly { readonly testId: string }[];
  /** 試験 ID → 要件 ID（固定した組から。無ければ null） */
  readonly requirementOfTest: (testId: string) => string | null;
}

/** 一番良い版の失敗を、名前付きの失敗の一覧にする（重なりを除き、種類の順・見つけた順。純粋） */
export function namedFailuresOf(source: NamedFailureSource): readonly NamedFailure[] {
  const failures: NamedFailure[] = [];
  const push = (kind: NamedFailureKind, testId: string | null, requirementId: string | null): void => {
    if (failures.some((entry) => entry.kind === kind && entry.testId === testId && entry.requirementId === requirementId)) return;
    failures.push({ testId, requirementId, kind, message: NAMED_FAILURE_MESSAGES[kind] });
  };
  if (!source.staticCheckPassed) {
    push("static-check", null, null);
    return failures;
  }
  for (const miss of source.correspondenceMisses) push("correspondence-miss", null, miss.requirementId);
  for (const rejection of source.rejections) push("decl-rejection", null, rejection.requirementId);
  for (const requirementId of source.unmarked) push("decl-unmarked", null, requirementId);
  for (const mismatch of source.mismatches) push("test-mismatch", mismatch.testId, source.requirementOfTest(mismatch.testId));
  for (const entry of source.unresolved) push("test-unresolved", entry.testId, source.requirementOfTest(entry.testId));
  return failures;
}

// ── 探索の記録 ───────────────────────────────────────────────────

/** 版の出どころ（B1 の初回・B5 の直し・空の文脈での作り直し） */
export type SearchVersionOrigin = "write" | "repair" | "rewrite";

/** 探索の記録の 1 版 */
export interface SearchVersionRecord {
  readonly origin: SearchVersionOrigin;
  readonly declarationSha256: string;
  readonly violations: VersionViolations;
  readonly adopted: boolean;
  /** 捨てた候補の状態の要約（採った版は null）。確定へ移さなかった unmarked の要件 ID と B3' の拒否の数 */
  readonly discarded: { readonly unmarked: readonly string[]; readonly rejections: number } | null;
}

/** 一番良い版の数え直し（確定した文脈が変わったとき） */
export interface SearchRecountRecord {
  /** 何で文脈が変わったか（候補を採った・棄却のあとの網羅） */
  readonly cause: "adopted" | "coverage";
  readonly declarationSha256: string;
  readonly violations: VersionViolations;
}

/** 往復の直す手（手 4a の宣言の全文を直す段・手 4b の欄だけの直し。Issue #553） */
export type SearchRepairHand = "repair" | "field-repair";

/** 探索の記録の 1 往復（直す手の種類・場所の数・場所なしの数。欄だけの直しのマージを断ったら、その固定文。旗 ids の走りは追加の場所の数） */
export interface SearchRoundRecord {
  readonly hand: SearchRepairHand;
  /** 場所に写した失敗の場所の数（重複なし） */
  readonly locations: number;
  /** 場所なしの失敗の数 */
  readonly unlocated: number;
  /** 欄だけの直しのマージを断った固定文（断らなかった・手 4a の往復は null） */
  readonly refused: string | null;
  /** 追加の場所の数（旗 `v12.ids` の走りだけ欄を持つ。off の記録は今のまま。Issue #667） */
  readonly additions?: number;
}

/** 探索の記録（旗 on の走りだけ。版の順） */
export interface SearchRepairRecord {
  readonly versions: readonly SearchVersionRecord[];
  readonly recounts: readonly SearchRecountRecord[];
  /** 一番良い版（最終の版）の宣言の SHA-256 */
  readonly bestDeclarationSha256: string;
  /** 作り直しをしたか */
  readonly rewritten: boolean;
  /** 往復ごとの直す手（往復の順。走らせる部分が組む。Issue #553） */
  readonly rounds?: readonly SearchRoundRecord[];
}

/**
 * 探索の記録の JSON（`search-repair.json` の本文）の末尾に、往復ごとの直す手の欄 `rounds` を足す（純粋。Issue #553）。ほかの欄の
 * 値と順は変えない（同じ字下げ・末尾の改行 1 つ）。
 */
export function withSearchRounds(text: string, rounds: readonly SearchRoundRecord[]): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return `${JSON.stringify({ ...parsed, rounds }, null, 2)}\n`;
}
