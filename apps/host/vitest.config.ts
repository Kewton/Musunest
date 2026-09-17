import { defineConfig } from "vitest/config";

// vitest は NODE_ENV が既に設定されているとそれを尊重する。**production のビルドの React には `act` が無く**、
// component テスト（renderer.test.ts・form.test.ts）が「React.act is not a function」で全部落ちる。
// テストの間だけ test に固定する（worker のテストが起動する vite build へは持ち込まれない——
// src/worker/index.test.ts が NODE_ENV を落として子プロセスを起こす）。
process.env.NODE_ENV = "test";

// これが無いと vitest は vite.config.ts（vite-plugin と TanStack Start）を読み込んでしまう。
// src/worker/index.test.ts が host を実際にビルドし、実機の workerd（host・gateway・data-api の3つ）を起動するので、
// 既定の 5s では足りない（gateway と同じ）。
//
// esbuild.jsx … 画面の component テスト（renderer.test.ts・form.test.ts）が .tsx を読むので、
//   JSX を automatic runtime に変換する。**@vitejs/plugin-react は入れない**——plugin-react 6 は vite 8 を要求し、
//   vitest 3 が使う vite 7 と食い違う。DOM が要るテストは、ファイル先頭の `// @vitest-environment jsdom` で
//   切り替える（worker のテストは node のまま。node が既定である）。
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});
