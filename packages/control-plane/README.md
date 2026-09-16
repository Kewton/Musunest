# @musunest/control-plane

Control Plane の D1（`musunest-<env>-control`）の中身を持つ。**D1 は Control Plane 専用**である
（`CLAUDE.md` 不変条件）。アプリの入力レコードや computed はここに持たない。それは Durable Object（SQLite）
にある（[`workspace/mvp/m1/README.md`](../../workspace/mvp/m1/README.md) §4）。

M1.1 で置くのは、宣言（`app.spec.yaml`）と、その宣言を使うインスタンスの登録である（#100）。
Better Auth / User / Community / Membership / AppGrant は M2 以降。

## 1. 登録表（`migrations/0002_app_registry.sql`）

| 表 | 主キー | 列 | 誰が使うか |
|---|---|---|---|
| `apps` | `source_sha256` | `schema_version`・`source_key`（原本の R2 キー）・`normalized_key`（正規化した JSON の R2 キー）・`created_at` | publish（#101）・data-api（#102） |
| `app_instances` | `instance_id` | `source_sha256`（参照するアプリ）・`created_at` | 同上 |

- **アプリは原本（`app.spec.yaml`）のバイト列の SHA-256 で識別する。** 小文字の16進64桁
- **アプリの入力レコードや computed は登録表に持たない**（`workspace/mvp/m1/README.md` §7.1）
- **作成日時は D1 の既定値**（`strftime('%Y-%m-%dT%H:%M:%fZ','now')`）。書く側は主キーと本文だけで足りる
- 外部キーは張らない。SQLite の `PRAGMA foreign_keys` は接続ごとに決まるので、未登録のアプリの拒否は
  読み書きの側（§3）で行う

## 2. 公開面

`src/contract.ts` が公開契約、`src/registry.ts` が SQL と行の読み取りである。

```ts
import { registerApp, getApp, registerInstance, getInstance, resolveInstanceApp } from "@musunest/control-plane";
```

| 関数 | すること |
|---|---|
| `registerApp(executor, registration)` | アプリを登録する。引数は `sourceSha256`・`schemaVersion`・`sourceKey`・`normalizedKey` |
| `getApp(executor, sourceSha256)` | SHA-256 でアプリを読む。**存在しない読取は `null`** |
| `registerInstance(executor, registration)` | インスタンスを登録する。引数は `instanceId`・`sourceSha256` |
| `getInstance(executor, instanceId)` | ID でインスタンスを読む。存在しない読取は `null` |
| `resolveInstanceApp(executor, instanceId)` | インスタンスから、それが使うアプリを解決する。どちらかが無ければ `null` |

失敗の種類は `RegistryError.code` で分ける（呼ぶ側が例外の文言に依存しない）。

| `code` | いつ |
|---|---|
| `app_conflict` | 同じ SHA-256 に、内容の違う宣言を登録しようとした |
| `instance_conflict` | 既存インスタンスの宣言を、暗黙に差し替えようとした |
| `app_not_found` | 未登録のアプリを指すインスタンスを登録しようとした |

**冪等性**：同じキー・同じ内容の2回目の登録は、行を増やさずに既存の行を返す。
**既存の行は書き換えない**（`ON CONFLICT ... DO NOTHING`。`DO UPDATE` にしない）。
**既存インスタンスの宣言差し替えを暗黙に行わない**（`instance_conflict` で止める）。

## 3. 実行者（`RegistryExecutor`）— Cloudflare の型を公開契約に持ち込まない

D1 を実際に触るのは `data-api` だけである（`CLAUDE.md` 不変条件）。control-plane は SQL と
その束縛引数、行の読み取りを持ち、実行は注入された `RegistryExecutor` に任せる。

```ts
interface RegistryExecutor {
  query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]>;   // D1: prepare().bind().all() の results
  execute(statement: SqlStatement): Promise<number>;                        // D1: prepare().bind().run() の meta.changes
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>; // D1: batch()（1トランザクション）
}
```

`data-api` の Cloudflare adapter は `D1Database` をこの形に包むだけでよい。
このパッケージに `D1Database` も `cloudflare:workers` も出てこない（`cloudflare:workers` の直接 import は
oxlint の `no-restricted-imports` が禁じている）。

読み書きの規律：

- **値も表名も SQL へ埋め込まない。** 表名は `contract.ts` の定数、値は束縛引数（`runbook §4.3`）
- **読み取りは列名を書く。** `SELECT *` を使わない。知らない列が増えても落ちないため
- **「読む→書く」は1回の `batch` にまとめる。** D1 の batch は1トランザクションなので、途中の状態を読まない

## 4. migration の適用

SQL の置き場は control-plane、当てるのは `data-api` の設定である
（`CONTROL_DB` を binding しているのが `data-api` だけのため）。手順は
[`docs/runbook/d1-migration.md`](../../docs/runbook/d1-migration.md) にある。

```bash
pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]
```

- **表を足すだけ**にしてある。1つ前のコード（`_musunest_meta` しか使わない data-api の healthz は
  `SELECT 1` だけ）がそのまま動く（runbook §4）
- staging / production へは CD が当てる。dev は手元から当てる
- `src/migration.test.ts` が、実 SQLite への適用（既存のメタ行が残ること）と、wrangler の適用管理を通した
  再適用（2回目は何も当てないこと）を確かめる
