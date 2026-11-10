// 計画で了承して除いた部分（`parts` の `accepted_removal` かつ `accepted_unwritable` にある部分）の導出（Issue #841）。
//
// 旗 `v12.ids` の走りだけが使う。C2 に渡すデータの塊・C2' の部分 ID の受理・判定の材料（了承済みの持ち越し）・
// 記録の `accepted_removals` が、同じ導出を共有する。
//
// 読み（Issue #841 の契約。所有者の決定 11-10）：
//   - 了承済みの部分：`disposition` が `accepted_removal` で、かつ `accepted_unwritable` にある部分
//   - 全部が了承済みの要件：部分が 1 件以上あり、その全部が了承済みの部分である要件（空の `parts` は入らない）
//   - 混在の要件：了承済みの部分と、了承していない部分を両方持つ要件
//   - 全部が了承済みで書ける残りが無い要件だけ、自分の了承済みの部分 ID を根拠に unresolved にできる
//
// 部分 ID は正規化して照らす（文書の制約 ID・台帳の未対応の観測の ID と同じ文字列の扱い）。文書の ID と同じ
// 文字列の部分 ID は、C2' では文書の ID として受け、判定の材料では了承済みの持ち越しに数えない（衝突）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { normalizeConstraintId } from "../stages/prompt.js";

/** 了承して除いた部分 1 つ（要件 ID・部分 ID・部分の文） */
export interface AcceptedPart {
  readonly requirementId: string;
  readonly partId: string;
  readonly text: string;
}

/** 了承して除いた部分を持つ要件 1 つ（C2 のデータの塊に書く形） */
export interface AcceptedPartsRequirement {
  readonly requirementId: string;
  /** 了承して除いた部分の ID（`parts` の順。計画の値のまま） */
  readonly acceptedPartIds: readonly string[];
  /** 部分が 1 件以上あり、その全部が了承済みか */
  readonly allAccepted: boolean;
  /** 了承して除いた部分（`parts` の順） */
  readonly parts: readonly AcceptedPart[];
}

/** 要件ごとの部分の索引（C2' の受理と判定の材料が使う。部分 ID は正規化して持つ） */
export interface AcceptedPartRequirementBasis {
  /** 部分が 1 件以上あり、その全部が了承済みか */
  readonly allAccepted: boolean;
  /** 了承して除いた部分の ID（正規化） */
  readonly acceptedPartIds: ReadonlySet<string>;
  /** その要件の全部の部分の ID（正規化。了承していない部分も含む） */
  readonly partIds: ReadonlySet<string>;
}

/** C2' の受理と判定の材料が使う索引 */
export interface AcceptedPartBasis {
  /** 計画にある全部の部分の ID（正規化。どの要件のものかは問わない） */
  readonly anyPartIds: ReadonlySet<string>;
  /** 要件 ID → その要件の部分の索引 */
  readonly byRequirement: ReadonlyMap<string, AcceptedPartRequirementBasis>;
}

/** 了承して除いた部分の導出の結果 */
export interface AcceptedParts {
  /** 了承して除いた部分を 1 件以上持つ要件（計画の順） */
  readonly requirements: readonly AcceptedPartsRequirement[];
  /** 全部が了承済みの要件の ID（計画の順） */
  readonly allAcceptedRequirementIds: readonly string[];
  /** C2' の受理と判定の材料が使う索引 */
  readonly basis: AcceptedPartBasis;
}

/**
 * 計画から、了承して除いた部分を要件ごとに導く（純粋）。0 件なら `requirements` は空で、C2 の要求・C2'・
 * 判定の材料・記録は今のまま（何も足さない）。
 */
export function deriveAcceptedParts(plan: ConfirmedPlan): AcceptedParts {
  const accepted = new Set(plan.accepted_unwritable.map((entry) => normalizeConstraintId(entry.part_id)));
  const requirements: AcceptedPartsRequirement[] = [];
  const byRequirement = new Map<string, AcceptedPartRequirementBasis>();
  const anyPartIds = new Set<string>();
  for (const requirement of plan.requirements) {
    const acceptedParts = requirement.parts.filter(
      (part) => part.disposition === "accepted_removal" && accepted.has(normalizeConstraintId(part.id)),
    );
    const allAccepted = requirement.parts.length > 0 && acceptedParts.length === requirement.parts.length;
    byRequirement.set(requirement.id, {
      allAccepted,
      acceptedPartIds: new Set(acceptedParts.map((part) => normalizeConstraintId(part.id))),
      partIds: new Set(requirement.parts.map((part) => normalizeConstraintId(part.id))),
    });
    for (const part of requirement.parts) anyPartIds.add(normalizeConstraintId(part.id));
    if (acceptedParts.length === 0) continue;
    requirements.push({
      requirementId: requirement.id,
      acceptedPartIds: acceptedParts.map((part) => part.id),
      allAccepted,
      parts: acceptedParts.map((part) => ({ requirementId: requirement.id, partId: part.id, text: part.text })),
    });
  }
  return {
    requirements,
    allAcceptedRequirementIds: requirements.filter((entry) => entry.allAccepted).map((entry) => entry.requirementId),
    basis: { anyPartIds, byRequirement },
  };
}

/** 判定の材料（了承済みの持ち越し）の入力 */
export interface AcceptedCarryOverInput {
  /** 最終の持ち越し（出どころと理由） */
  readonly entries: readonly {
    readonly requirementId: string;
    readonly reasons: readonly { readonly origin: string; readonly reason: string }[];
  }[];
  /** 採用した表の unresolved の根拠（要件 ID → `constraintIds`） */
  readonly unresolvedConstraintIds: ReadonlyMap<string, readonly string[]>;
  readonly basis: AcceptedPartBasis;
  /** 文書の制約 ID（正規化） */
  readonly documentConstraintIds: ReadonlySet<string>;
  /** 台帳の未対応の観測の ID（正規化。台帳を受けない走りは空） */
  readonly observationIds: ReadonlySet<string>;
}

/**
 * 最終の持ち越しのうち、**了承済みの持ち越し**（full の妨げにしない）の要件 ID を返す（純粋）。次の 4 つを全部満たす：
 *   1. 出どころが name-table だけである
 *   2. 採用した表で unresolved である（`unresolvedConstraintIds` に根拠がある）
 *   3. 全部が了承済みの要件である（部分が 1 件以上）
 *   4. 正規化した根拠が 1 件以上あり、全部がその要件の了承済みの部分 ID で、文書の ID・観測の ID と同じ文字列ではない
 * 1 つでも欠ければ未解決のまま残す（fail-closed）。
 */
export function acceptedCarryOverIds(input: AcceptedCarryOverInput): readonly string[] {
  const ids: string[] = [];
  for (const entry of input.entries) {
    if (entry.reasons.length === 0 || !entry.reasons.every((reason) => reason.origin === "name-table")) continue;
    const requirement = input.basis.byRequirement.get(entry.requirementId);
    if (requirement === undefined || !requirement.allAccepted) continue;
    const raw = input.unresolvedConstraintIds.get(entry.requirementId);
    if (raw === undefined || raw.length === 0) continue;
    const normalized = raw.map((id) => normalizeConstraintId(id));
    if (normalized.some((id) => id === "")) continue;
    const accepted = normalized.every(
      (id) =>
        requirement.acceptedPartIds.has(id) &&
        !input.documentConstraintIds.has(id) &&
        !input.observationIds.has(id),
    );
    if (accepted) ids.push(entry.requirementId);
  }
  return ids;
}
