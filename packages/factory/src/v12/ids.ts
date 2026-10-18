// v1.2 の ID はコードが振る（08-architecture-v1.2.md §4 の C1・C1'・C2・C2'・§6。手 3a・Issue #593）。
//
// 旗 `v12.ids` が on の走りだけが使う、**LLM を呼ばない純粋な関数**を置く：
//
//   - ID の振り方（`entityIdAt`・`fieldIdAt`・`computationIdAt`・`operationIdAt`・`screenIdAt`）。応答の**並び**で決まる
//     （同じ応答なら同じ ID。並びを入れ替えれば ID が変わる）。値の文字は見ない——要件の文や名前に依らない（方法論 03 の H1）
//   - ID の形から種類を読む（`idKindOf`）。形に合わない文字列は「知らない ID」
//   - 参照の照合（`checkReference`）：知らない ID・別の束の ID・種類違いを固定文で落とし（fail-closed。近い ID に結び付けない）、
//     照らした参照・知らない ID・重複・別の束の ID の 4 つを数える（`ReferenceCounts`。ID の値は数に入れない）
//
// 束ごとに参照できる種類は固定である：束 2（項目）は束 1 の entity（E）だけ、束 3（計算・操作・画面）は E と項目（F）だけ。
// 束 2 の応答に F・C・OP・V の形の ID（まだ振っていない ID）が来れば「別の束の ID」で落とす。
import type { NameTableKind } from "../v11a/names.js";
import type { Problem } from "../stages/prompt.js";

// ── ID の形 ─────────────────────────────────────────────────────────

/** entity の ID（応答の順に 1 から） */
export const entityIdAt = (index: number): string => `E${String(index + 1)}`;
/** 項目の ID（entity ごとに応答の順に 1 から） */
export const fieldIdAt = (entityId: string, index: number): string => `${entityId}.F${String(index + 1)}`;
/** 計算の ID */
export const computationIdAt = (index: number): string => `C${String(index + 1)}`;
/** 操作の ID */
export const operationIdAt = (index: number): string => `OP${String(index + 1)}`;
/** 画面の ID */
export const screenIdAt = (index: number): string => `V${String(index + 1)}`;

const ID_PATTERNS: readonly (readonly [NameTableKind, RegExp])[] = [
  ["entity", /^E[1-9][0-9]*$/],
  ["field", /^E[1-9][0-9]*\.F[1-9][0-9]*$/],
  ["computation", /^C[1-9][0-9]*$/],
  ["operation", /^OP[1-9][0-9]*$/],
  ["screen", /^V[1-9][0-9]*$/],
];

/** ID の形から種類を読む（形に合わなければ null） */
export function idKindOf(id: string): NameTableKind | null {
  for (const [kind, pattern] of ID_PATTERNS) if (pattern.test(id)) return kind;
  return null;
}

// ── 束 ───────────────────────────────────────────────────────────────

/** C1 の束（1 entity・2 項目・3 計算と操作と画面） */
export const VOCABULARY_BUNDLES = ["entities", "fields", "behaviors"] as const;
export type VocabularyBundle = (typeof VOCABULARY_BUNDLES)[number];

/** 束ごとに参照してよい行の種類（それより前の束で振った種類だけ） */
export const BUNDLE_REFERABLE_KINDS: Readonly<Record<VocabularyBundle, readonly NameTableKind[]>> = {
  entities: [],
  fields: ["entity"],
  behaviors: ["entity", "field"],
};

// ── 固定文 ───────────────────────────────────────────────────────────

/** ID の照合の固定文（ID の値・名前を埋めない） */
export const ID_MESSAGES = {
  unknown: "知らない ID である（この表で振った ID に無い）",
  crossBundle: "別の束の ID である（この束で参照できるのは前の束で振った ID だけ）",
  wrongKind: "参照先の ID の種類が違う",
  duplicateRow: "同じ場所（種類・entity・名前）を指す行が束の中で重なっている",
  unknownRequirement: "一覧に無い要件 ID である",
  duplicateRequirement: "同じ要件の項目が重なっている",
  missingRequirement: "要件の写像が無い",
  unknownRole: "所属の ID が表の行に無い",
  duplicateRole: "同じ要件の中で所属が重なっている",
} as const;

// ── 参照の照合の数 ───────────────────────────────────────────────────

/** 参照の照合の数（段の記録 `vocabulary`・`mapping` の欄。ID の値は持たない） */
export interface ReferenceCounts {
  /** 照らした参照（応答に書かれた ID の参照の全部） */
  readonly checked: number;
  /** 知らない ID（形に合わない・振っていない・一覧に無い） */
  readonly unknown: number;
  /** 重複（同じ場所を指す行・同じ要件 2 件・同じ要件の中の同じ行） */
  readonly duplicate: number;
  /** 別の束の ID */
  readonly crossBundle: number;
}

export const ZERO_REFERENCE_COUNTS: ReferenceCounts = { checked: 0, unknown: 0, duplicate: 0, crossBundle: 0 };

/** 2 つの数を足す */
export function addReferenceCounts(a: ReferenceCounts, b: ReferenceCounts): ReferenceCounts {
  return {
    checked: a.checked + b.checked,
    unknown: a.unknown + b.unknown,
    duplicate: a.duplicate + b.duplicate,
    crossBundle: a.crossBundle + b.crossBundle,
  };
}

/** 数え上げの入れ物（照合の関数が足していく） */
export class ReferenceTally {
  checked = 0;
  unknown = 0;
  duplicate = 0;
  crossBundle = 0;

  get counts(): ReferenceCounts {
    return { checked: this.checked, unknown: this.unknown, duplicate: this.duplicate, crossBundle: this.crossBundle };
  }
}

/**
 * C1 の束の中の参照 1 つを照らす（fail-closed）。`known` はこの束より前に振った ID → 種類、`want` はこの位置が求める種類。
 * 合わなければ固定文の問題を足して false。数は `tally` に足す（照らした参照は必ず 1 つ増える）。
 */
export function checkReference(
  id: string,
  field: string,
  bundle: VocabularyBundle,
  known: ReadonlyMap<string, NameTableKind>,
  want: NameTableKind,
  problems: Problem[],
  tally: ReferenceTally,
): boolean {
  tally.checked += 1;
  const kind = idKindOf(id);
  if (kind !== null && !BUNDLE_REFERABLE_KINDS[bundle].includes(kind)) {
    tally.crossBundle += 1;
    problems.push({ field, message: ID_MESSAGES.crossBundle });
    return false;
  }
  const actual = known.get(id);
  if (kind === null || actual === undefined) {
    tally.unknown += 1;
    problems.push({ field, message: ID_MESSAGES.unknown });
    return false;
  }
  if (actual !== want) {
    problems.push({ field, message: ID_MESSAGES.wrongKind });
    return false;
  }
  return true;
}
