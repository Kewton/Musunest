---
name: musunest-ui-check
description: 画面テスト（3 つの見本の画面の操作をブラウザで流す。#233 の道具）を、窓口が手元から staging に対して流し、HTML のレポートを workspace/mvp/m1/ui-report/ に置いて PR にする。host・見本・配信の層に触れる PR が merge されたあと、人のデモの前、マイルストーンの終わりに使う。
---

# musunest-ui-check

3 つの見本（割り勘・タスク管理・ダッシュボード）と「残るか」の手順を、スマホと同じ幅（360 CSS px）のブラウザで**画面だけで**流し、合否・期待・実際・写真を HTML に書き出す。道具は `e2e/src/ui/`（#233）。

- **窓口が手元から流す。** CI には入れていない（所有者の決定 2026-09-25）
- レポートは**最新の 1 つだけを git で追跡する**（`workspace/mvp/m1/ui-report/`。毎回上書き）
- **人のスマホでの確認はやめない。** 機械の結果は補うもの

## 0. 流す前に（引き継ぎ）

`/musunest-handoff 書く` で README の「いま」を書き換える（例：「画面テストを実行中。落ちたら `Musunest-issue-<N>` の worktree と `workspace/mvp/m1/ui-report/` を見る」）。

## 1. 手順

1. **別の worktree で行う**（main の checkout は管理と共有しているので、ブランチを切らない）。レポートを PR にする Issue を用意し、`feat/<N>-ui-report` で worktree を作る。`./infra/scripts/link-env.sh` を実行する
2. `pnpm install --frozen-lockfile` → `pnpm build`（依存が変わっていたら install を忘れると build が落ちる）
3. ブラウザ本体を入れる（初回・Playwright の版が上がったときだけ。約 100MB がユーザーのキャッシュに入る）
   ```bash
   pnpm --filter @musunest/e2e exec playwright install chromium
   ```
4. **画面テスト専用のインスタンス**に `main` の見本を置く（毎回 `--replace`。**デモ用・e2e 用のインスタンスは使わない**）
   ```bash
   set -a; . ./.env; set +a
   for s in warikan task-board dashboard; do
     pnpm exec tsx infra/scripts/publish.ts --env staging --instance m15-ui-$s \
       --spec packages/appspec-schema/samples/$s/app.spec.yaml --replace
   done
   ```
5. **宛先を表示せずに**環境変数で渡して流す。オリジンは Cloudflare の API から組み立てる。**`echo` しない・ファイルに書かない・コマンド行の引数にしない**
   ```bash
   SUB=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['subdomain'])")
   SMOKE_BASE_URL="https://musunest-staging-host.$SUB.workers.dev" UI_INSTANCE_ID=m15-ui \
     pnpm --filter @musunest/e2e test:ui
   ```
   - `UI_INSTANCE_ID` は**接頭辞**。道具が `-warikan`・`-task-board`・`-dashboard` を付ける。`demo`・`e2e` を含む値は道具が断る
   - 道具は各手順の前にデータを空にし、終わったら片付ける
6. **レポートに秘密が無いことを確かめる**（道具も確かめるが、もう一度見る）
   ```bash
   grep -rlI -e "$SUB" -e "workers.dev" -e "$CLOUDFLARE_ACCOUNT_ID" workspace/mvp/m1/ui-report && echo LEAK || echo clean
   ```
   `LEAK` なら**コミットしない**。レポートを消して、原因を Issue にする
7. `workspace/mvp/m1/ui-report/` をコミットして PR を作る。本文に、合否の数・落ちた項目・流した `main` のコミットを書く。**運用文書なので人が merge する**
8. `/musunest-handoff 書く` で「いま」を「なし」に戻す

## 2. 結果の読み方

- 終了 0：全項目が合格し、片付けとレポートの書き出しも成功した
- 終了 1：`e2e-ui: NG <手順> / <項目>: 期待 … ≠ 実際 …` が落ちた項目。`workspace/mvp/m1/ui-report/index.html` で写真を見る
- **落ちたら、まず画面の不具合か道具の不具合かを見分ける。** 写真で、確かめたい一覧に切り替わっているか・値が出ているかを見る。道具の待ち方や目印の不一致なら道具の直しの Issue に、画面の不具合なら画面の Issue にする。**期待値を合わせてレポートを緑にしない**

## 3. やってはいけないこと

- デモ用（`*-demo-*`）・e2e 用（`*-e2e-*`）のインスタンスに流す
- 宛先（オリジン・サブドメイン）を表示する・ファイルに書く・引数で渡す
- レポートを手で直す
- 落ちた項目を残したまま「合格」と報告する
