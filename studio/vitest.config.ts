import { defineConfig } from "vitest/config";

// vitest は NODE_ENV が既にあるとそれを尊重する。画面のテストは test の React で動かす。
process.env.NODE_ENV = "test";

// サーバの試験は node、画面の試験はファイル先頭の `// @vitest-environment jsdom` で切り替える。
// JSX は esbuild の automatic runtime で変換する（vite.config.ts の plugin-react は vite 8 を要求するため、
// vitest 3 が使う vite 7 とは食い違う）。
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 30_000,
  },
});
