# MUSUNEST monorepo — 作業規律

## 不変条件（破ったらPRを落とす）

- **Data API が唯一の権限強制点。** gateway / host から D1・R2・DO を直接触らない
- **D1 は Control Plane 専用。** アプリのデータは Durable Object（SQLite）
- **IaC二層**：アカウント単位資源は `infra/terraform`、サービス単位は `wrangler.jsonc`。越境しない
- リクエスト経路は **TypeScript のみ**
- Cloudflare 固有APIは adapter 層に閉じ込める（`packages/app-do` を除く）
- Builder Plane（CommandAgent）のコードをこのリポジトリに持ち込まない。接点は headless契約 と `pins/` のみ
- **小さく保つ（M0〜M2前半）**：host は SSR にしない（SPAシェル＋Static Assets）。
  Workers for Platforms を使わない。Logpush を使わない（`observability.enabled` で代替）。
  `schedule:` トリガのワークフローを作らない。
  **アーキテクチャを課金プランに売らない** — 枠が足りなければ層を潰すのではなく払う
  （昇格トリガーは `workspace/mvp/m0/06-plan-and-limits.md` §5。触れたら議論せず即上げる）
  - **プラン（2026-09-18 現在）**：アカウント①（dev + staging）は **Workers Paid（$5/月＋従量）**。
    P-7 に抵触して上げた（staging の `/api` で data-api 単体 60.60 ms。`06` §5）。
    **アカウント②（production）は Free のまま**（出す前に上げる。`06` P-8）。
    上の 4 つの「使わない」は**プランに関係なく維持する**
- **先に安い手を試す（2026-09-18 所有者が決定。上と対になる）**：**払えば済むからと最初に払わない。**
  ①計算そのものを減らす → ②計算を別の場所へ移す（**サーバの CPU だけが計算の置き場ではない**。
  画面側・書き込みのとき・手元の機械）→ ③実行を分けて予算を分ける → ④払う、の順で検討する。
  **計算資源は共有の予算**である（$5 に含まれるのは月 3,000 万 CPU-ms。1 つの経路のものではない）。
  新しい機能を足すときは、いくら使うかを見積もる。
  - 例外：**昇格トリガー（P-1〜P-8）に触れたときは「議論せず即上げる」が優先**する。安い手は上げたあとで効かせる
  - 遅さの線は **D-1**（staging の `/api` で Worker 単体の CPU 最大 200 ms 超・200 件で測る）。
    **触れてもプランは上げない。作りに手を入れる**（`06` §5）

## 依存の向き

`infra/scripts/dep-graph.mjs` が正本。`pnpm lint` が package.json と tsconfig references の
両方を照合して機械強制する。**図を変えるときは dep-graph.mjs を直す。**

`A → B` は「A は B に依存してよい」。ここに無い向きは落ちる（2026-09-16 に下の 3 本を足した。`workspace/mvp/m1/00-open-questions.md` Q14）。

```
host          → sdk
gateway       → data-api, control-plane
data-api      → sdk, spec-engine, app-do, control-plane, appspec-schema
control-plane → spec-engine, appspec-schema
e2e           → sdk
sdk・spec-engine・app-do・connector → appspec-schema
```

- 足した 3 本：`data-api → control-plane`（D1 の登録表の定義と読み書き）、`control-plane → spec-engine`（publish の中身）、`e2e → sdk`
- **`infra/scripts` は pnpm workspace の外にあり、この検査が届かない。** 中身は workspace のパッケージに置き、
  `infra/scripts` には資格情報と Cloudflare への書き込みを扱う薄い呼び出しだけを置く（例：publish の中身は control-plane）
- `apps/*` … インターネットから直接到達する Worker（host, gateway）
- `packages/*` … **Service Binding 経由でしか到達できない**内部 Worker（data-api）と純粋なライブラリ
- `data-api` が `packages/` にあるのは意図的。**外部ルートを持たせない**規律をディレクトリで表現している

## このリポジトリは public である

- 公開しない文書（企画書・商標・名称検討）は **非公開リポジトリ `Kewton/Musunest-workspace`** にある
- 出典を示すとき：企画書は**章番号だけ**で参照する。**内容を引き写さない**
- 商標の結論（リスク評価・先行権利者名）、価格、moat 仮説、名称の代替候補を**ここに書かない**
- **CIログ・PRコメント・アーティファクトもすべて公開される。** Variables はマスクされない
  （`terraform plan` の扱いは `workspace/mvp/m0/04-cicd.md` §3.1）

### 資格情報の置き場所（2026-09-14）

| 置き場所 | 置くもの |
|---|---|
| リポジトリ Secret | dev/staging のトークン、R2 の鍵、**`CLOUDFLARE_ACCOUNT_ID`**、**`R2_S3_ENDPOINT`** |
| **`production` 環境 Secret** | **`CLOUDFLARE_API_TOKEN_PROD`**、**`CLOUDFLARE_ACCOUNT_ID_PROD`**、**`SMOKE_BASE_URL`**（production の host の独自ドメインのオリジン `https://app.musunest.com`。2026-09-15 から。秘密ではないが置き場所は変えない）、**`MUSUNEST_PROBE_TOKEN`**（production の `/healthz` の合言葉。32 文字以上） |
| **`staging` 環境 Secret** | **`SMOKE_BASE_URL`**（staging の host の workers.dev のオリジン。`deploy-staging` の貫通スモークの宛先） |
| GitHub に置かない | `TF_CLOUDFLARE_API_TOKEN_PROD`（production への apply は人が手元から） |
| リポジトリ Variable | 公開してよい値だけ（`TFSTATE_BUCKET` など） |

- **Account ID と、それを含む値（R2 のエンドポイント URL）を Variable にしない。** ログに平文で出る
- **本番の資格情報をリポジトリ全体の Secret にしない。** `pull_request` のワークフローは PR 側のブランチの定義で
  動くので、ワークフローを書き換えた PR から届いてしまう。`production` 環境（`v*` タグ・承認必須）に閉じ込める
- **PR で production の plan を回さない**（`04` §3）
- **workers.dev の URL を Variable にも CI のコマンド行にも出さない。** サブドメインがログに載る。貫通スモークの宛先は Secret から環境変数で渡し
  （`--base-url` を使わない）、`wrangler deploy` の出力は `infra/scripts/deploy-worker.ts` を通してホスト名を伏せる（`04` §4）
- **`MUSUNEST_PROBE_TOKEN` は `production` 環境の Secret の1か所だけに置く。** `deploy-production` が deploy のたびに
  `--secrets-file` で host と gateway に載せ（`deploy-worker.ts` が一時ファイルに書いてすぐ消す）、貫通スモークには `SMOKE_PROBE_TOKEN` として渡す。
  **手で `wrangler secret put` をしない**（`04` §5）
- **`production` 環境を宣言するのは `deploy-production.yml` だけ。** 他のワークフローに本番の Secret の名前を書かない（`deploy-worker.test.ts` が走査する）

## 手順

- 作業は必ず Issue から。ブランチは `feat/<issue番号>-<slug>`
- **監督側（人・オーケストレーター）の運用文書・CI・設定の変更も Issue を立ててから出す。** PR は `Closes #N` で Issue を閉じる。
  Issue を閉じない途中の PR は `Refs #N` でよいが、**その Issue を閉じる PR が必ず `Closes` を持つ**（2026-09-15・M0 清算 `workspace/mvp/m0/05-acceptance.md` §6）
- コミットは **Conventional Commits**（`feat:` `fix:` `chore:` `docs:` `ci:` `refactor:` `test:`）
- PR は **squash merge のみ**。squash のコミットメッセージ = PRタイトル
- `main` は保護。直接 push しない。緊急時の管理者バイパスは可能だが、**使ったら Issue に理由を残す**

## 開発の進め方（Issue ごとの並列開発。2026-09-16 所有者が決定）

- **1 Issue = 1 worker。Issue ごとに並列で進める。**
- 体制は次の 4 層である。**窓口は main の Claude、ワーカーの管理は main の Command Code** と分ける。

```
人
└─ main の Claude（worktree musubi / instance claude）      ← 窓口。開発を推進する
   └─ main の Command Code（worktree musubi / instance command-code）  ← ワーカーの管理（cmate-orchestrate）
      ├─ feat/<issue> の Command Code   ← ワーカー（1 Issue に 1 人）
      ├─ feat/<issue> の Command Code
      └─ …（Issue の数だけ）
```

- 並列開発は、窓口の Claude が **`cmate-delegate`** で main の **Command Code** へ依頼して始める。
  依頼の中身は「**`cmate-orchestrate` で Issue ドリブンの並列開発をする**」
- **手順の正本は [`docs/parallel-development.md`](docs/parallel-development.md)**（依頼文の 6 欄・送り方・exit code・報告の形・段取り・partial の直し方）
- **plan は `--no-infer` で回す。** 依存は Issue に宣言する。推論は日本語の語（スキーマ・契約・参照…）から
  誤った edge を作り、閉路で plan が出せなくなる（2026-09-16 に 2 回発生）
- **長い依頼を投げる前に、main の checkout を `main` に戻す。** 管理は窓口と同じ checkout で動く
- 宛先は alias から解決する（`commandmate instances musubi --json`）。**instance-id を推測で渡さない**
- profile は `.commandmate/profiles/musubi.json`（branch `feat/{number}-{slug}`、
  worktree `../{repo}-issue-{number}`、baseline に `link-env.sh`）。
  **worktree を作るのは `cmate-worktree-setup`** であって dispatch ではない。
  **ワーカーの CLI は worktree の既定（`cliToolId`）で決まるので、roster を `command-code` だけにする**
  （`docs/parallel-development.md` §6.1。provider をリポジトリに持つ作業は #118）

| | やること |
|---|---|
| **窓口**（人・main の Claude） | Issue を切る（`cmate-issue-authoring`）／依存と粒度を決める／依頼文を組んで人に見せてから送る／`.commandmate/` 配下・`.tf`・`.gitignore`・ディレクトリの移動／**運用文書（`workspace/`・`CLAUDE.md`）を含む PR は人が読んで merge**／auto-yes で応答されない停止（rate limit・自由記述の質問）の回収／管理の報告を人へ伝える |
| **管理**（main の Command Code） | `cmate-orchestrate` の plan → dispatch とワーカーの監督（`cmate-orchestrate-monitor`）／**ワーカーが出した PR を確認して squash merge する**／機械で判定できる受入は uat（`cmate-acceptance-test`）まで／**全部の merge が終わったら窓口へ報告する** |
| **ワーカー**（feat/<issue> のセッション。**CLI は Command Code に固定する**） | `cmate-worker-development` に従って 1 Issue を実装し、`cmate-verify` で検証する。**緑になったら push して PR を作り、管理へ報告する**（タイトルは Conventional Commits、本文に `Closes #N` と検証の証跡）。**merge はしない** |

### 流れ

1. **窓口**が Issue を切り、`cmate-delegate` で**管理**へ依頼する（依頼文は送る前に人へ見せる）
2. **管理**が plan（依存と file 衝突）を作り、人の承認を得てから worktree を用意して dispatch する
3. **ワーカー**が実装し、`cmate-verify` が緑になったら **push して PR を作り、管理へ報告する**
   （**push と PR は実行契約に書けない**。検証が緑になった時点で、管理が追加のメッセージで指示する。`docs/parallel-development.md` §6.2）
4. **管理**が PR を確認し（検証の証跡・CI green・scope の内側）、**squash merge する**。
   運用文書（`workspace/`・`CLAUDE.md`）・`.commandmate/` 配下・`.tf` を含む PR だけは**人が読んで merge** する
5. 全部の merge が終わったら、**管理が窓口へ報告**する。窓口が人へ伝える

- **ワーカーの push と PR は、管理が追加のメッセージで指示する。** `cmate-worker-development` の既定は
  「PR を作らない・push しない」で、**dispatch の実行契約に書き足す口は無い**（2026-09-16 の実測）。
  だから「検証が緑になったら push して PR を作る」は、**dispatch のあとに管理が送る**（`docs/parallel-development.md` §6.2）
- **merge runner に PR を作らせない**（`merge.mjs --merge-prs` は PR 作成を含み、ワーカーの PR と二重になる）。
  管理は、ワーカーが作った PR を CI green の確認のうえ `gh pr merge --squash` で merge する
- **スマホでのデモと振り返りは人が行う**（🧑 の Issue。マイルストーンごと。`workspace/mvp/roadmap.md` §1）。
  uat が見るのは機械で判定できる分だけである
- **dispatch は auto-yes を基本にする**（`dispatch_defaults.auto_yes: true`）。ワーカーの yes/no と選択のプロンプトは自動で応答し、run を止めない
  - **窓口は、依頼を送る前に相手の `autoYes` を確認し、off なら `commandmate auto-yes <worktree-id> --enable` を打ってよい**
    （2026-09-17 所有者が決定。`cmate-delegate` §6 をこのリポジトリに限って上書きする。`docs/parallel-development.md` §5）。
    有効にしても、**プロンプトに自分で答えることはしない**
  - auto-yes が効くのは**ワーカーのプロンプトだけ**である。**merge は別のゲート**で、auto-yes では決まらない（merge runner を使うときは `--approve` が無ければ何も mutate しない）
  - 止めたい run は `--no-auto-yes` を付ける（production に触る変更・`.tf`・`.commandmate/` を含むときなど）。`--unattended` と auto-yes は併用できない（`invalid_input`）
- 実行契約（`.commandmate/tasks/*.yaml`）の goal は **8000 文字まで**。対象のソースが概ね 30 本を超える Issue、
  `.tf`・`.gitignore`・ディレクトリの移動を含む Issue は **dispatch できない**
  - **原則は Issue を分割する。** 1 Issue = 1 パッケージ前後・語彙 1〜2 個まで落とせば、たいていは dispatch できる形になる
  - **どうしても分けられないときだけ、人に判断を委ねる**（監督側が手で行うか、別の切り方にするか）。窓口が勝手に手で進めない
- **ワーカーは `.commandmate/verify.yaml` を直さない**（下の検証ゲートの節）。ゲートを足す必要に気づいたら、止めて人に返す

### Issue の書き方（planner が読める形）

**plan は Issue 本文だけを読む。本文がそのまま `scope.allow` と依存になる**（2026-09-16 の実測。#115）。

- **`## 対象ファイル` に、書いてよいパスだけを列挙する**（glob 可）。この見出しが無い Issue は
  `no_suspected_files` で **dispatch できない**。地の文や `## 参照` に書いた glob は落ちる。
  **テストのファイルも具体名で入れる**（glob だけだとテストの path が導出されず止まる）
- **`## 依存` には素の `#番号` だけを書く。** 「#96 のあと（#97 と並列に進められる）」の括弧書きは
  **依存として読まれる**。並列の注記は別の節へ書く
- **地の文にパスを書かない。** 「このファイルは変えない」と書いたパスまで `scope.allow` に入り、
  推論された依存が宣言依存と閉路を作って plan 自体が出なくなる
- **`## 完了条件`**（機械で判定できる受入条件）を必ず書く
- 人がやる Issue には `human-only` ラベルを付け、**dispatch の対象から外す**

## コマンド

```bash
pnpm install          # corepack 経由で pnpm 10.13.1 が使われる
pnpm check            # verify-parity → lint → typecheck → test（PR前に必ず通す）
pnpm build
terraform version     # .terraform-version（1.16.2）を tfenv がピンする
```

## 検証ゲート（誰が何を直すか）

**合格の定義は [`.commandmate/verify.yaml`](.commandmate/verify.yaml) と `.github/workflows/ci.yml` の
`lint-typecheck-unit` の2か所にあり、7段（deps / verify-parity / lint / typecheck / unit / tf-fmt / tf-validate）が順序まで一致する。**

| | 直せる人 | 理由 |
|---|---|---|
| **`.commandmate/` 配下**（verify.yaml・scripts・profiles） | **人（監督側）だけ** | CommandMate がワーカーの編集範囲から外す。**審判を書き換えられる被審判は審判されていない** |
| `.github/workflows/ci.yml` | ワーカーも可 | ただしゲートを足すと verify-parity が落ちる（↓） |

- **ゲートの追加・削除は、人が `verify.yaml` と `ci.yml` を1コミットで同時に直す。**
- ワーカーが `ci.yml` だけにゲートを足すと、`pnpm check:verify-parity` が落ちて PR はマージできない。
  **それが「人の手が要る」ことの合図である。** ワーカーは止まって人に返すこと。`verify.yaml` を直そうとしない。
- `ci.yml` の `lint-typecheck-unit` で `run:` を持つステップには、**直前の1行**に目印が要る。
  **目印の無い run ステップを足しても落ちる**（`- run:` 形式も `- name:` の次行に `run:` を書く形式も数える）。
  - ゲートなら `# verify-gate: <id>`（verify.yaml の gate id と順序まで照合される）
  - ゲートではない準備なら `# verify-setup: <理由>`（理由は必須。照合の対象外になる）
  - 目印とステップの間に別のコメントを挟むと、目印として効かない
- 照合するのは「どのゲートがどの順で走るか」まで。コマンドの文字列の一致までは見ない。
  **だからゲートの中身は `.commandmate/scripts/` に1本だけ置き、verify.yaml と ci.yml の両方から同じものを呼ぶ**
  （同じコマンドを2か所に書くと、中身だけがズレても parity check は気づかない）。

### Terraform のゲート（tf-fmt / tf-validate）

- `.commandmate/scripts/check-terraform.sh` が実体。**資格情報を一切使わない**（`init -backend=false`）
- 入っている terraform が `.terraform-version` と一致しなければ落ちる。**ローカルでは tfenv が要る**
- 検証用の作業領域は `.terraform-validate/`（ignore 済み）。実 apply 用の `.terraform/` とは分けてあるので、
  実 backend で init 済みの環境ディレクトリでもゲートは落ちない

## git worktree で並列作業するとき

**`.env` は追跡していないので worktree には存在しない。** Terraform も
`verify-cf-tokens.py` も、そのままでは動かない。worktree を作ったら最初にこれを実行する。

```bash
./infra/scripts/link-env.sh    # primary checkout の .env へ symlink を張る
```

コピーではなく symlink なのは、トークンが 2026-12-07 に失効するため。
primary の `.env` を1回直せば全 worktree に効く。

`.commandmate/profiles/musubi.json` の `baseline` に入れてあるので、
`cmate-worktree-setup` 経由なら自動で走る。**手で worktree を切ったときは自分で実行すること。**

> `.claude/skills` と `.agents/skills` を追跡しているのも同じ理由である。
> **worktree には tracked なファイルしか複製されない。**
