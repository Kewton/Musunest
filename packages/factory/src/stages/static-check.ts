// ④ 静的チェック（02-architecture.md §1・Q-4）。
//
// 書いた宣言（YAML の原文）を、spec-engine の `normalizeSpec` に通す。**誤りコードと位置は
// そのまま返す**（自分で検査を足さない。§1・Q-5）。通過したときだけ、正規化した JSON（`NormalizedAppSpec`）
// を取り出して⑤a 以降へ渡す——評価器は**検査済みの宣言**しか受け取らない（Q12）。
import { normalizeSpec } from "@musunest/spec-engine";
import type { Declaration, StaticCheckResult } from "../pipeline.js";

/**
 * 宣言を静的チェックする。`normalizeSpec` の結果をそのまま写す。
 * 通過（`ok`）なら `passed: true`・診断は空・`app` に正規化した JSON を入れる。通らなければ
 * `passed: false`・診断をそのまま・`app` は `null`（成果物を返さない。src/normalize.ts の規約 1）。
 */
export async function runStaticCheck(declaration: Declaration): Promise<StaticCheckResult> {
  const result = await normalizeSpec(declaration.source);
  if (result.ok) {
    return { passed: true, diagnostics: [], app: result.app };
  }
  return { passed: false, diagnostics: result.diagnostics, app: null };
}
