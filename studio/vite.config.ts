import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 画面（SPA の殻）だけを束ねる。サーバは `tsc -b` が dist/server へ出す。
// 束ねた HTML は、サーバが `{{NAME}}` を置き換えてから返す（src/server/page.ts）。
export default defineConfig({
  plugins: [viteReact()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
