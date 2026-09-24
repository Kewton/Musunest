# templates/tanstack-start

Template as Contract（企画書 13 章）の実体。工場（CommandAgent）がアプリを作るときのひな形で、
**店頭が正本を持つ契約**である。

M1 では**境界だけ**を置く。動く TanStack Start の雛形は作らない（実行時の依存を足さない）。

## 境界（3 つの領域）

| 領域 | 工場が変えてよいか | 何を置くか |
| --- | --- | --- |
| `core/` | いいえ | 店頭が正本を持つ部分。工場は読むだけ |
| `sdk/` | いいえ（使ってよい） | 画面が使う型付きクライアント `@musunest/sdk` の `/api` 経路（spec・view・action） |
| `app-zone/` | はい | 工場が L3/L4 のコードを置く場所 |

正本は `template.json`（`zones[].factoryMutable`）。各領域の詳細は各 README にある。

## tarball を作る

同じ入力から同じバイト列の tarball を作る。Node の標準ライブラリだけで動き、依存を足さない。

```bash
pnpm --filter @musunest/template-tanstack-start tarball
# → dist/tanstack-start-0.1.0.tar.gz を作り、SHA-256 を標準出力に出す
```

- 入るのは 3 つの領域・`template.json`・この README だけ。`src/`・`dist/`・`node_modules/` は入らない
- 並び順（path のバイト順）・所有者（uid/gid 0）・権限（0644）・時刻（mtime 0）・
  gzip のヘッダ時刻（MTIME 0）を固定する。元ファイルの時刻を変えても、中身が同じなら SHA-256 は変わらない
- 出力先は `dist/`（追跡しない）

配布は GitHub Releases のアセットで行う。アセットを置くことと `pins/` を埋めることは #38 で窓口が行う
（この Issue では置かない）。
