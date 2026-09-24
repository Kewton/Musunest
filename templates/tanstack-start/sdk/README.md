# sdk/ — 工場が使ってよい境界

`@musunest/sdk` が画面へ渡す**型付きクライアント**の経路である。
工場はこの境界を**使ってよい**が、**変えてはいけない**（正本は店頭が持つ）。

## 通ってよい経路

画面はデータ・通知へ、`@musunest/sdk` を経由して `/api` の **spec・view・action** だけを通る。

- **spec** … 宣言の取得
- **view** … 一覧の取得
- **action** … 更新

ここに無い経路を通ってはいけない。Data API は唯一の権限強制点であり
（CLAUDE.md「Data API が唯一の権限強制点」）、画面が D1・R2・Durable Object へ直接到達することはない。

## 何を置くか

M1 では境界の宣言だけを置く。実装は店頭が `@musunest/sdk` に入れる。

変えてよいかの正本は `../template.json` である（`zones[].factoryMutable`）。
