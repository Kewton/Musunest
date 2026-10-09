// ⑤b 結び付け（02-architecture.md §1・§1.3）。
//
// 固定した試験の selector（要件 ID・種類・役割）を、**結び付けの規則**で宣言の実在の要素 1 つに
// 結び付ける。対応表（⑤a）が挙げた場所を通し、selector の種類に当たる場所を数える：
//
//   - 0 個   … 結び付けられない（不一致。理由つき）
//   - 1 個   … 結び付ける
//   - 2 個以上 … 1 つに決まらない（不一致。理由つき）
//
// 実在そのものの確認は対応表（⑤a のコード）と、試験を流す段（⑤b）が行う——ここは「1 つに決まるか」を
// 見る（実在しない名前を挙げていれば、流す段で不一致になる）。
import type {
  CorrespondenceResult,
  DeclarationLocationKind,
  FixedTest,
  TestBinding,
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

/** ⑤b 結び付けが受け取るもの（固定した試験の組と、対応表） */
export interface BindInput {
  readonly suite: TestSuite;
  readonly correspondence: CorrespondenceResult;
}

/**
 * 固定した試験の並びを、対応表が挙げた場所へ結び付ける。**1 件ずつ、当たる場所の数で決める**。
 * 対応表の項目が無い要件・当たる場所が 0 個・2 個以上のときは、`unbound`（理由つき）を返す。
 */
export function bindTests(input: BindInput): readonly TestBinding[] {
  return input.suite.tests.map((test) => {
    const selector = `要件 ${test.target.requirementId}・役割 ${test.target.role}`;
    const entry = input.correspondence.entries.find(
      (candidate) => candidate.requirementId === test.target.requirementId,
    );
    if (entry === undefined) {
      return { kind: "unbound", testId: test.id, detail: `selector（${selector}）に対応表の項目が無い` };
    }
    const want = locationKindFor(test);
    const candidates = entry.locations.filter((location) => location.kind === want);
    const [only, ...overflow] = candidates;
    if (only === undefined) {
      return { kind: "unbound", testId: test.id, detail: `selector（${selector}）に当たる ${want} の場所が無い` };
    }
    if (overflow.length > 0) {
      return {
        kind: "unbound",
        testId: test.id,
        detail: `selector（${selector}）に当たる ${want} の場所が ${candidates.length} 個あり、1 つに決まらない`,
      };
    }
    return { kind: "bound", testId: test.id, location: only };
  });
}
