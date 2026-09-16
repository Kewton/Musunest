# @musunest/control-plane

Control Plane の D1（`musunest-<env>-control`）の中身を持つ。**D1 は Control Plane 専用**である
（`CLAUDE.md` 不変条件）。アプリの入力レコードや computed はここに持たない。それは Durable Object（SQLite）
にある（[`workspace/mvp/m1/README.md`](../../workspace/mvp/m1/README.md) §4）。

M1.1 で置くのは、宣言（`app.spec.yaml`）と、その宣言を使うインスタンスの登録である（#100）、
および宣言を R2 と D1 へ置く publish の中身である（#101）。
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

## 5. publish（宣言を R2 と D1 へ置く。Issue #101）

`src/publish.ts` が **検査 → 正規化 → R2 の 2 個 → D1 の登録** の順を 1 か所に持つ。静的チェックと正規化は
`@musunest/spec-engine` を呼び、**CLI 側に実装を複製しない**（判定が 2 か所に分かれると、CI と publish で
結果がずれる。03 §5.3）。R2・D1 を実際に触るのは注入された口（`SpecWriter`・`RegistryExecutor`）だけで、
ここに Cloudflare の型は出てこない（§3 と同じ考え方）。

入口は `infra/scripts/publish.ts` であり、そこが持つのは**引数の解釈・原本の読取・環境変数からの資格情報の
取得・Cloudflare adapter の組立・安全な結果表示**だけである。中身を control-plane に置くのは、`infra/scripts`
が pnpm workspace の外で `pnpm lint` の依存の検査が届かないためである（Q14・`CLAUDE.md`「依存の向き」）。

```ts
import { publishSpec, sourceObjectKey, normalizedObjectKey } from "@musunest/control-plane";

const result = await publishSpec(
  { specs, registry }, // specs: R2 に書く口（SpecWriter）、registry: D1 の実行者（RegistryExecutor）
  { source, instanceId }, // source: 原本の UTF-8 の文字列、instanceId: 宣言を使うインスタンス
);
if (result.ok) result.app; // AppRecord（原本 SHA・版・2 つの R2 キー）
else result.failure; // { stage, diagnostics, message, code }
```

| 決めごと | 中身 |
|---|---|
| R2 のキー | 原本 SHA を含む決定的な値。原本は `specs/<sha>/app.spec.yaml`、正規化した JSON は `specs/<sha>/normalized.json`。#100 の登録と #102 の取得が同じキーを使う |
| 順 | 検査 → 正規化 → R2 の 1 個目（原本。受け取ったバイト列のまま）→ R2 の 2 個目（#98 が作った JSON のまま）→ D1（アプリ → インスタンス） |
| 失敗の扱い | **R2 のどちらかで失敗したらインスタンスを登録しない。D1 で失敗したら成功と報告しない。** 失敗は `PublishFailure.stage`（`check` / `source` / `normalized` / `app` / `instance`）で分ける |
| 再実行 | **R2 と D1 をまたぐトランザクションがあるかのように扱わない。** 同じ入力の再実行で正しい状態へ到達する（R2 は同じキーへ上書き、D1 の登録は冪等。§2） |
| 競合 | 同じ原本を別インスタンスへは共有できる。既存インスタンスへ別 SHA を渡すと `instance_conflict` になり、元の参照を保つ |

### CLI（`infra/scripts/publish.ts`）

```bash
pnpm exec tsx infra/scripts/publish.ts --env <dev|staging> --instance <id> --spec <app.spec.yaml>
```

- **入力**：原本のパス（`--spec`。リポジトリの直下からの相対、または絶対）とインスタンス ID（`--instance`）。
  R2 のバケットと D1 の `database_id` は `packages/data-api/wrangler.jsonc` の `env.<env>` から読む（`infra:sync` の同期先）
- **資格情報**：環境変数 `CLOUDFLARE_API_TOKEN`（D1 Write と Workers R2 Storage: Edit）と `CLOUDFLARE_ACCOUNT_ID`（アカウント①）
- **出力**：成功は **版・原本 SHA・インスタンス ID**。失敗は段と、値を持たない説明。**トークン・Account ID・
  バケット名・R2 のキー・URL は出さない**（例外の文言も出さない）
- **production は書き込みの前に断る**（`--env` は dev / staging だけ）。検査に通らない宣言（#97 の負例）は
  R2 にも D1 にも書かない
- **終了コード**：0 成功 / 1 失敗（引数・資格情報・原本不存在・各段の失敗）
- **失敗の箇所と再実行**：`PublishFailure.stage` がどこで止まったかを示す。途中で止まっても、同じ入力を再実行すれば
  正しい状態へ到達する（R2 は同じキーへ上書き、D1 の登録は冪等）。実環境（dev / staging）への実行は
  `workspace/mvp/m1/README.md` §3.1 の手順で行い、証跡を残す

`src/publish.test.ts` が受入条件を確かめる（負例は #97 と同じ診断で R2・D1 の呼び出し 0 回、正例の読み戻し、
冪等・共有・競合、各段の失敗と再実行）。`infra/scripts/publish.test.ts` が入口を確かめる（引数・資格情報・
production の拒否・値の非漏洩・束縛引数・各段の失敗の差し込み）。
