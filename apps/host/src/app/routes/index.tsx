// ホームの経路（`/`。M2.1。Issue #264）。**薄い入口**で、中身は src/app/home.tsx が持つ。
//
// **SSR をしない。** この画面はブラウザでだけ描かれ、インスタンス固有のデータはビルド済みの HTML に埋め込まない
// （dist/client/index.html は SPAシェルだけである。src/worker/index.test.ts が確かめる）。ログインの入口
// （/auth/login）も、一覧のデータ（/api/me/instances）も、同じ origin の経路で、host の Worker が gateway へ中継する。
import { createFileRoute } from "@tanstack/react-router";
import { createMusunestClient } from "@musunest/sdk";
import { Home } from "../home";

export const Route = createFileRoute("/")({ component: HomeRoute });

/** 同じ origin の `/api/*`。baseUrl を空にして、経路を相対のまま fetch する */
const client = createMusunestClient({ baseUrl: "" });

function HomeRoute() {
  // ルートの中身はブラウザでだけ描かれる（シェルには入らない）ので、window / navigator を読んでよい。
  // LINE の中のブラウザかと、外のブラウザへ開き直す URL の組み立てに使う（home.tsx）
  return <Home client={client} href={window.location.href} userAgent={navigator.userAgent} />;
}
