# 手元の工房（studio）

所有者が手元で「依頼 → 質問 → 確認 → 作る → 結果 → 公開」を触るための、配らない workspace の一員である。
この Issue（#864）は骨組みだけを置く。サーバは `node:http` だけで 127.0.0.1 に bind し、束ねた画面を返す。
設計と決定は [`workspace/mvp/m2/studio-s1.md`](../workspace/mvp/m2/studio-s1.md)。

## 開く

```bash
pnpm install
pnpm --filter @musunest/studio build
pnpm --filter @musunest/studio start
```

起動すると `http://127.0.0.1:4318` と表示される。**`localhost` ではなく `127.0.0.1` で開く**
（`localhost` が `::1` に解決される環境があり、サーバは 127.0.0.1 にしか bind しない）。
ポートは `STUDIO_PORT` で変えられる。

```bash
STUDIO_PORT=4500 pnpm --filter @musunest/studio start
```

`pnpm start` は `node --env-file-if-exists=../.env` で環境ファイルを読む。
**工房のコード自身は環境ファイルを開かない。**

## 画面と口

- `GET /` … 束ねた画面（`dist/client/index.html`）。起動ごとの合言葉を HTML に埋める
- `GET /api/health` … `{ ok: true, service: "@musunest/studio" }`

`/api/` の要求には合言葉のヘッダ `x-studio-token` が要る。合言葉は `index.html` の
`<meta name="studio-token">` に入っている。

## 守り

- **127.0.0.1 にだけ bind する。** 0.0.0.0 は使わない
- **Host の照合は全部の要求に掛ける。** `127.0.0.1:<port>` と `localhost:<port>` 以外は、
  `/api/` も `GET /`（HTML）も静的ファイルも **421**
- **合言葉が無い・違う `/api/` は 403。** 起動ごとに乱数で作る
- **POST は Origin が同じでなければ 403。** Origin の無い POST も 403
- 外部へ通信しない。WebSocket を使わない

## 記録の置き場所

走りの記録はリポジトリの外に置く。既定はホームの下の `.musunest-studio`。

| 変数 | 意味 |
|---|---|
| `STUDIO_HOME` | 記録の置き場所（既定 `~/.musunest-studio`） |
| `STUDIO_PORT` | listen するポート（既定 `4318`） |
| `STUDIO_STAGING_ORIGIN` | 画面の HTML に埋める staging のオリジン（`/api/` の応答・記録・標準出力には出さない） |

`STUDIO_HOME` がリポジトリの中を指すときは、起動を断る（`.gitignore` は触らない）。

## 検証

```bash
pnpm --filter @musunest/studio test       # サーバ（node）と画面（jsdom）
pnpm --filter @musunest/studio typecheck
pnpm --filter @musunest/studio lint
pnpm --filter @musunest/studio build
```

依存の向きは `studio → factory, control-plane, appspec-schema` だけ（`infra/scripts/dep-graph.mjs` が正本）。
