# @musunest/data-api

**★唯一の権限強制点**（`CLAUDE.md` 不変条件）。宣言を R2 から読み、登録（D1）と突き合わせ、
入力の検査・権限の判定・計算・保存（Durable Object）を行う Worker である。

- **外部ルートを持たない。** `workers_dev` / `preview_urls` / `routes` をすべて切り、到達経路は
  gateway からの Service Binding だけにしてある（`wrangler.jsonc`。`src/index.test.ts` が env ごとに確かめる）
- **D1・R2・DO を触るのはこのパッケージだけ。** gateway と host は触らない（`CLAUDE.md` 不変条件）
- **Cloudflare 固有の API は `src/cloudflare.ts`（adapter）に閉じ込める。** 判定（何を読むか・何を断るか）は
  `src/app-api.ts` と `src/input.ts` が持ち、Cloudflare の型をそこへ持ち込まない

## 1. 公開する HTTP の契約（Issue #102）

経路・応答の形・誤りコードの**正本は `@musunest/appspec-schema` の `src/api.ts`** である。
data-api と sdk（host が使う）が同じ型を参照できる場所は、依存を持たないそのパッケージだけである
（host は data-api を参照できない。`CLAUDE.md`「依存の向き」）。`src/contract.ts` はそれを**再輸出するだけ**で、
パッケージの公開面（`package.json` の `exports`）は `contract.ts` 1 つである。

### 1.1 経路

| 経路 | method | 応答 |
|---|---|---|
| `/api/instances/:instanceId/spec` | GET | 200。正規化した JSON（Issue #98）＋操作の可否 |
| `/api/instances/:instanceId/views/:viewName` | GET | 200。一覧（行＋宣言順の列＋操作の可否） |
| `/api/instances/:instanceId/actions/:actionName` | POST | 201。書いた行（計算値つき） |
| `/healthz` | GET | 200 / 503（貫通スモーク。M0 から変えない） |

- **宣言した action だけを実行する。** 任意の entity への汎用の書込口は作らない
- 操作の body は「項目名: 値」のオブジェクトである。宣言に無い名前（計算の名前・`id`・`createdAt`・
  `updatedAt`・知らない項目）は**未知の項目として断る**
- 一覧の行は `id`・`createdAt`・`updatedAt`・`fields`・`computed` を持つ。行だけでなく
  `fields`・`computed`（宣言順）・`actions`・`permissions` を返すので、**画面は式を評価しなくてよい**

### 1.2 誤りコード

| コード | HTTP | いつ |
|---|---|---|
| `INVALID_JSON` | 400 | body が JSON として読めない |
| `INPUT_REJECTED` | 422 | 項目の型・検査に通らない。`fields` と `validations` を載せる |
| `PERMISSION_DENIED` | 403 | `read` / `write` の宣言が無い |
| `NOT_FOUND` | 404 | 不明な instance / view / action、契約に無い経路 |
| `METHOD_NOT_ALLOWED` | 405 | その経路が受けない method（`allow` ヘッダに受ける method を載せる） |
| `SPEC_UNAVAILABLE` | 503 | 登録が無い・R2 にオブジェクトが無い・壊れた JSON・欄の欠落・版違い・SHA 不一致 |

- **成功に見せかけた空の応答へ変換しない。** 読めなかったことは、読めたことにして返さない
- **例外の文言・binding の名前・資格情報を応答に載せない。** `SPEC_UNAVAILABLE` の本文は
  `{"error":"SPEC_UNAVAILABLE"}` だけである。詳細は Workers のログ（`observability.enabled`）にだけ出す
- 本文が空の操作の POST は「項目が 1 つも無い入力」として扱う（構文の誤りではない）

## 2. 判定（`src/app-api.ts`・`src/input.ts`）

1. **instance** を登録（D1。control-plane の `resolveInstanceApp`）で引く。無ければ 404
2. **正規化した JSON**（R2 の `normalized_key`）を読む。無ければ 503
3. **整合性**：`sourceSha256` と `schemaVersion` を登録と照合する。食い違えば 503
   （版の形が語彙の形でない場合も 503）
4. **権限**：`read` が無ければ spec・一覧を断り、`write` が無ければ追加を断る（どちらも 403）。
   M1.1 は `minIdentity: anonymous` なので、本人確認は行わない
5. **入力の検査**（`read`/`write` を通ったあと。意味は `packages/appspec-schema/docs/semantics.md`）
   - 項目の過不足と型 → computed → validation の順。**どこかで断ったら保存しない**
   - 型で断ったら、検査の式を評価しない（`validations` は空）。通らない項目は**すべて**返す
   - 数は**有限の数だけ**を受け取り、文字列を数へ暗黙に変換しない
   - `list` は空の並びと、同じ文字列が 2 回ある並びと、文字列でない要素を拒否する（Q18-2）
   - computed は**保存しない**。一覧と追加の応答でその都度求める
6. **保存**：DO に 1 件書く。日時と ID は**呼ぶ側の時計**が付ける（入力の値では決まらない）

## 3. 時計（Q17）

- 評価と保存は、**アプリケーション関数の引数で受け取った時計**（`Clock`）を使う
- リクエストの経路は実時計（`systemClock`）を使う。**ヘッダ・query・body から時計を差し替える入口は作らない**
  （`src/app-api.test.ts` が固定した時計で保存日時を採点し、`src/index.test.ts` が偽の日時を足しても
  保存日時が変わらないことを確かめる）
- 保存日時の正本は `packages/app-do`（DO）。data-api は `RecordStamp` として時計を渡すだけである

## 4. 置いてあるもの

| 場所 | 中身 |
|---|---|
| `src/contract.ts` | パッケージの公開面。healthz の契約と、HTTP 契約の**再輸出**（Worker を巻き込まない） |
| `src/index.ts` | Worker の入口。経路の解析・method の検査・body の読み取り・誤りコードの対応だけ |
| `src/app-api.ts` | 判定（登録・整合性・権限・一覧・追加）。I/O は引数で受け取る |
| `src/input.ts` | 入力の検査（型 → computed → validation） |
| `src/cloudflare.ts` | adapter。D1（control-plane の `RegistryExecutor`）・R2・DO の実体 |
| `src/healthz.ts` | 貫通スモークの判定（M0 から） |
| `wrangler.jsonc` | binding と vars。**infra:sync の同期先である**（`infra/scripts/sync-bindings.ts` が正本） |

## 5. 検証

```bash
pnpm --filter @musunest/data-api exec vitest run        # このパッケージの unit（workerd を含む）
pnpm check                                                # verify-parity → lint → typecheck → test → tf-*
```

- `src/app-api.test.ts` — 見本 `expense-log` の**採点のシナリオ 19 操作**を、差し替えた依存と固定した時計で流す
  （受理 4 件・拒否 15 件・最後の一覧の 4 行）。権限・整合性（登録なし・R2 なし・SHA 不一致・版違い・壊れた JSON）も
- `src/input.test.ts` — 入力の検査（型の順・有限の数・list の空と重複・未知の項目）
- `src/index.test.ts` — workerd 上の実機。経路・method・誤りコード・**生の `1e400`**・時計を上書きできないこと・
  拒否が DO を変えないこと・公開面に Worker 本体を含めないこと
- 実環境（staging）での確認は、この unit とは別に証跡を残す（Q16・Q17）
