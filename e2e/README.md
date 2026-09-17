# @musunest/e2e — staging の見本の採点

`deploy-staging` の貫通スモークのあとに回す、staging の e2e である（Issue #110）。
staging に置いた見本「旅行の割り勘」が、リポジトリの原本と同じ SHA-256 を持ち、同じ入力から同じ精算値を
返すことを、**host と同じ型付きクライアント（`@musunest/sdk`）** で確かめる。spec・view・action の経路を通る。

`workspace/mvp/m1/README.md` §3.1・§10.3、`workspace/mvp/m1/00-open-questions.md` Q16・Q17 に対応する。

## 何を確かめるか

1. 原本（`packages/appspec-schema/samples/warikan/app.spec.yaml`）の SHA-256 が、staging の spec 応答の
   `sourceSha256` と一致し、版が草案の版（`community.app-spec/v0.2-draft`）と一致すること。
   **一致しなければ、採点も後片付けも書込もせずに非 0 で止まる。**
2. 時計に依存しない採点の値（`workspace/mvp/m1/02-l2-spec-examples.md` §2.3）。**時計は上書きしない**
   （ログインの無い API に時刻を変える入口を作らない。Q17）。
   - 支出の `shareAmount`（夕食 2000 / タクシー 1000）
   - メンバーの `paid` / `owed` / `balance`（A 6000/3000/3000・B 3000/3000/0・C 0/3000/-3000）
   - 精算（settle）の送金の並び（C → A 3000 の 1 件だけ）

## 環境変数

| 名前 | 何 |
|---|---|
| `SMOKE_BASE_URL` | host のオリジン。貫通スモークと同じ（CI では staging 環境の Secret） |
| `E2E_INSTANCE_ID` | e2e 専用インスタンスの ID。**`demo` を含む ID は拒否する**（デモのデータを消さない） |

どちらかが欠けていれば、**1つも叩かずに非 0**。宛先は必ず環境変数で渡し、**`--base-url` のような引数にしない**
（pnpm がコマンド行を引数ごとログに出す）。URL・ホスト名・資格情報は、ログにも応答の生の本文にも出さない。

## 実行

```bash
# 通常の unit（外部接続なし。fetch を差し替えて runner・後片付け・失敗経路を検査する）
pnpm --filter @musunest/e2e test

# live（staging。SDK の dist と、見本を置いた専用インスタンスが要る）
pnpm build
SMOKE_BASE_URL=... E2E_INSTANCE_ID=m12-e2e-warikan pnpm --filter @musunest/e2e test:staging
```

**unit ゲート（`pnpm test`）は、資格情報も外部接続も要求しない。** live は `test:staging` で明示的に起動する。
終了 0 は、原本 SHA-256・採点の値・後片付けのすべてが成功したときだけである（欠落・不一致・通信の失敗・
後片付けの失敗は非 0。何もしなかったことを 0 と報告しない）。

## インスタンスと後片付け

- 使うのは **e2e 専用の固定 ID のインスタンス**だけ（CI は `m12-e2e-warikan`）。デモ・窓口が実機で見ている
  `m11-demo-expense-log`・`m12-demo-warikan` には触らない。
- CI（`deploy-staging`）が、貫通スモークのあとに `infra/scripts/publish.ts` で見本をそのインスタンスへ置く
  （窓口の手動 publish には頼らない。`00-open-questions.md` Q18-9）。
- 採点の前と後に、#109 の通常の削除 action で専用データを片付ける。**支出 → メンバー** の順である
  （逆にすると、支出から参照されているメンバーは消せず `REFERENCE_IN_USE`（409）で残る）。
  途中で失敗しても、最後に必ず片付ける（専用インスタンスのデータは、すべてこの e2e のもの）。
- 無認証の reset・時刻変更・全データ削除の API は増設しない（data-api の契約を変えない）。

## 既知の制約（この Issue の変更範囲の外）

`publish` は、既存インスタンスが別の SHA を指していると登録を張り替えない（`instance_conflict`。
`packages/control-plane/src/registry.ts`）。見本の原本が変わったときは、**同じインスタンスを更新せずに publish が
非 0 で止まる**（新しいインスタンスを勝手に作らないので、staging の DO にデータは溜まらない）。
「SHA が変われば同じインスタンスの登録を更新する」語彙は control-plane（#100・#101）の管轄であり、
この Issue の `scope.allow` の外である。

## 構成

| ファイル | 何 |
|---|---|
| `src/warikan.ts` | 採点の runner（照合 → 採点 → 片付け） |
| `src/cli.ts` | 入口（環境変数・伏せ字・終了コード） |
| `src/index.ts` | パッケージの公開面 |
| `src/warikan.test.ts`・`src/cli.test.ts` | unit（偽の fetch。実環境に届かない） |
| `src/__tests__/index.ts` | unit 用の data-api の代わり（warikan.test.ts・cli.test.ts が共有する） |
