// `/apps/:instanceId` — 宣言からフォームと一覧を描く深いリンク（Issue #104）。
//
// **SSR をしない。** この画面はブラウザでだけ動き、インスタンス固有のデータはビルド済みの HTML に埋め込まない
// （dist/client/index.html は SPA シェルだけで、深いリンクも同じシェルを返す。src/worker/index.test.ts が確かめる）。
// データは同じ origin の `/api/*` から取る——host の Worker が gateway の先の data-api まで中継する（Issue #103）。
import { createFileRoute } from "@tanstack/react-router";
import { createMusunestClient } from "@musunest/sdk";
import { InstantRenderer } from "../renderer";

export const Route = createFileRoute("/apps/$instanceId")({ component: AppsInstance });

/** 同じ origin の `/api/*`。baseUrl を空にして、経路を相対のまま fetch する */
const client = createMusunestClient({ baseUrl: "" });

function AppsInstance() {
  const { instanceId } = Route.useParams();
  return <InstantRenderer instanceId={instanceId} client={client} />;
}
