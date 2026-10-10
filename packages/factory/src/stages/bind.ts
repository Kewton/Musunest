// ⑤b 結び付け（02-architecture.md §1・§1.3）。
//
// 固定した試験の selector（要件 ID・種類・役割 ID）を、**③ が提出した対応（役割 ID → 宣言の名前）**で、
// 対応表（⑤a）が挙げた場所の中の実在の要素 1 つに結び付ける（§1.3・Issue #308）。**同じ種類の場所を
// 数えて推測しない。** 対応が無ければ「決まらない」ではなく**未解決**にする（`cause` で行き先を分ける）。
//
//   - 提出された対応の名前が、当たる種類の場所の中に**ちょうど 1 つ**あれば結び付ける
//   - 0 個なら対応表の外（対応の表の不備）・2 個以上なら曖昧（未解決）
//   - 提出された対応が無ければ未解決（1 つに決まらない）
//
// 実在そのものの確認は対応表（⑤a のコード）と、試験を流す段（⑤b）が行う——ここは「1 つに決まるか」を
// 見る（実在しない名前を挙げていれば、流す段で不一致になる）。
import type {
  CorrespondenceResult,
  DeclarationLocation,
  DeclarationLocationKind,
  FixedTest,
  RoleNameMapping,
  TestSuite,
} from "../pipeline.js";

/**
 * selector の種類が当たる、宣言の場所の種類（§1.3・②'）。
 * 検査（`validate`）は検査の式を対象にするので `validation` を指す。それ以外は selector の `kind` を写す。
 */
export function locationKindFor(test: FixedTest): DeclarationLocationKind {
  if (test.operation === "validate") return "validation";
  switch (test.target.kind) {
    case "entity":
      return "entity";
    case "field":
      return "field";
    case "computation":
      return "computation";
    case "operation":
      return "action";
    case "screen":
      return "view";
  }
}

/**
 * 結び付けられない理由（行き先を分ける。§1.3.1・Issue #308）。
 *
 *   - `no-table-entry`・`no-candidate`・`outside-table` … 対応の表の不備（③ のやり直し）
 *   - `ambiguous`・`no-mapping` … 意味の曖昧さ（未解決）
 */
export type BindCause = "no-table-entry" | "no-candidate" | "outside-table" | "ambiguous" | "no-mapping";

/** 1 件の試験を、宣言の実在の要素 1 つに結び付けた結果（理由つき） */
export type BindResult =
  | { readonly kind: "bound"; readonly testId: string; readonly location: DeclarationLocation }
  | { readonly kind: "unbound"; readonly testId: string; readonly detail: string; readonly cause: BindCause };

/** ⑤b 結び付けが受け取るもの（固定した試験の組と、対応表、③ が提出した対応） */
export interface BindInput {
  readonly suite: TestSuite;
  readonly correspondence: CorrespondenceResult;
  /** ③ が提出した「役割 ID → 宣言の名前」の対応（§1・Issue #308）。旧形式の経路では省ける */
  readonly mappings?: readonly RoleNameMapping[];
}

/**
 * 固定した試験の並びを、**③ が提出した対応**で対応表の場所へ結び付ける（§1.3・Issue #308）。
 *
 * selector の役割 ID の対応が、当たる種類の場所の中にちょうど 1 つあれば結び付ける。無ければ未解決
 * （`no-mapping`）、対応表の外なら `outside-table`、2 つ以上なら `ambiguous`。提出された対応が
 * 渡されなければ、旧来どおり当たる場所の数で決める（後方互換）。
 */
export function bindTests(input: BindInput): readonly BindResult[] {
  const mappings = input.mappings;
  return input.suite.tests.map((test) => {
    const roleId = test.target.roleId;
    const selector = `要件 ${test.target.requirementId}・役割 ${roleId ?? test.target.role ?? ""}`;
    const entry = input.correspondence.entries.find(
      (candidate) => candidate.requirementId === test.target.requirementId,
    );
    if (entry === undefined) {
      return {
        kind: "unbound",
        testId: test.id,
        cause: "no-table-entry",
        detail: `selector（${selector}）に対応表の項目が無い`,
      };
    }
    const want = locationKindFor(test);
    const candidates = entry.locations.filter((location) => location.kind === want);

    if (mappings !== undefined && roleId !== undefined) {
      const mapping = mappings.find((candidate) => candidate.roleId === roleId);
      if (mapping === undefined) {
        return {
          kind: "unbound",
          testId: test.id,
          cause: "no-mapping",
          detail: `selector（${selector}）に提出された対応が無い（1 つに決まらない）`,
        };
      }
      const matches = candidates.filter((location) => location.name === mapping.name);
      const [only, ...overflow] = matches;
      if (only === undefined) {
        return {
          kind: "unbound",
          testId: test.id,
          cause: "outside-table",
          detail: `selector（${selector}）の対応（${mapping.name}）に当たる ${want} の場所が対応表の外にある`,
        };
      }
      if (overflow.length > 0) {
        return {
          kind: "unbound",
          testId: test.id,
          cause: "ambiguous",
          detail: `selector（${selector}）の対応（${mapping.name}）に当たる ${want} の場所が ${matches.length} 個あり、1 つに決まらない`,
        };
      }
      return { kind: "bound", testId: test.id, location: only };
    }

    const [only, ...overflow] = candidates;
    if (only === undefined) {
      return {
        kind: "unbound",
        testId: test.id,
        cause: "no-candidate",
        detail: `selector（${selector}）に当たる ${want} の場所が無い`,
      };
    }
    if (overflow.length > 0) {
      return {
        kind: "unbound",
        testId: test.id,
        cause: "ambiguous",
        detail: `selector（${selector}）に当たる ${want} の場所が ${candidates.length} 個あり、1 つに決まらない`,
      };
    }
    return { kind: "bound", testId: test.id, location: only };
  });
}
