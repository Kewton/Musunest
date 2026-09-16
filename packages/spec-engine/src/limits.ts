// 式の上限定数（Issue #97。2026-09-16 窓口が決定）。
//
// 静的チェックと評価（#98）が**同じ定数**を使うためにここへ置く。片方だけを変えると
// 「検査は通るのに店頭で動かない」ずれが生まれる（03-spec-layers-and-checker.md §5.3）。
// CPU 10 ms の実測から決めるアプリ全体の規模の目安とは別物である（README「上限」）。

export const EXPRESSION_LIMITS = {
  /** 式の文字数（JavaScript の文字列長）。これを超える式は解析せずに上限の診断を返す */
  maxLength: 200,
  /** AST の深さ。葉（名前・数の定数）を 1 と数える */
  maxDepth: 8,
  /** AST のノードの数 */
  maxNodes: 64,
} as const;

export type ExpressionLimits = typeof EXPRESSION_LIMITS;

/** 上限を超えたときの診断のコード。一覧は src/diagnostics.ts にある */
export const EXPRESSION_LIMIT_CODES = {
  maxLength: "LOGIC_EXPRESSION_TOO_LONG",
  maxDepth: "LOGIC_EXPRESSION_DEPTH_EXCEEDED",
  maxNodes: "LOGIC_EXPRESSION_NODES_EXCEEDED",
} as const satisfies Record<keyof ExpressionLimits, string>;

/** `EXPRESSION_LIMITS` の欄の名前。上限を 1 つずつ説明・記録するときに使う */
export const EXPRESSION_LIMIT_NAMES = {
  maxLength: "式の文字数",
  maxDepth: "式の深さ",
  maxNodes: "式のノード数",
} as const satisfies Record<keyof ExpressionLimits, string>;
