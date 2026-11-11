// 画面とサーバの間の型（共有）の入口。Issue #866 の目的・1。
//
// 実体は `src/server/runner.ts` に置いている。studio/tsconfig.json の `include` が
// `src/index.ts` と `src/server/**/*` だけで、合成プロジェクト（`composite`）はプログラムに入る file を
// すべて include で列挙することを要求するため、サーバの source から `src/shared/api.ts` を直接 import
// すると TS6307 で typecheck が落ちる。`studio/tsconfig.json` はこの Issue の変更範囲の外なので、
// 共有の型は `src/server` の中で実行時の依存を持たない file に置き、この file から再輸出する。
export * from "../server/runner.js";
