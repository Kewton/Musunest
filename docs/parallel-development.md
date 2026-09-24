# 並列開発の手順（窓口 → 管理 → ワーカー）

> **役割と不変条件の正本は [`CLAUDE.md`](../CLAUDE.md) の「開発の進め方（Issue ごとの並列開発）」。** ここは、そのとおりに動かすための**手順**である。
> skill の正本は `.claude/skills/cmate-delegate/` と `.claude/skills/cmate-orchestrate/`。この文書はそこへ一方向に参照する。
> 2026-09-16、M1.1 の最初の plan が partial で止まった実測（Issue #115）をもとに書いた。

---

## 0. 毎回の前提確認

```bash
commandmate whoami --json                  # 自分：worktreeId musubi / instanceId claude
commandmate instances musubi --json        # 宛先の候補（instanceId / alias / running / autoYes）
```

- **自己委任は禁止。** 宛先が自分（`musubi` / `claude`）と一致したら送らない
- 宛先は alias で照合する。「Command Code」＝ `command-code`。**2 件以上に当たったら選ばず、候補を人に見せる**
- 相手が `running=false` でも送れる（`ask` が自動起動する）。ただし**起動が間に合わず exit 99 になることがある**（§3）

---

## 1. 依頼文を組む（6 欄。1 つでも欠けたら送らない）

| 欄 | 書くこと |
|---|---|
| 目的 | 何を判断したいのか（「レビューして」ではなく「dispatch してよいかを決めたい」） |
| 対象 | repository / worktree / branch / Issue 番号 / profile / 前回の run |
| 出力の形 | 箇条書きか表か。**行数の上限も書く** |
| 触ってはいけないもの | mutation の可否、変更禁止のパス、branch 切り替えの禁止 |
| 前提 | 相手が知らないこと（↓ このリポジトリでは毎回書く） |
| 締め方 | 最後に `DONE:` で始まる 1 行 |

**依頼文は、送る前に人へ見せる。**

### このリポジトリで「前提」に必ず書くこと

- 運用（2026-09-16 決定）：**ワーカーが PR を作り、管理が squash merge する。** 運用文書（`workspace/`・`CLAUDE.md`）・`.commandmate/` 配下・`.tf` を含む PR だけは人が merge する
- dispatch するときは、**実行契約の Rules に「検証が緑になったら push して PR を作る」を明示する**（`cmate-worker-development` の既定は「PR を作らない・push しない」。広げる方向は契約が正本）
- **merge runner の `--merge-prs` は使わない**（PR 作成を含み、ワーカーの PR と二重になる）
- auto-yes は profile で on（`dispatch_defaults.auto_yes: true`）
- 検証ゲートは `.commandmate/verify.yaml` の 7 段。tf の 2 段はローカルで tfenv が要る
- **worktree に `.env` が無い**（`./infra/scripts/link-env.sh` が baseline に入っている）
- base は `main`。PR は squash merge のみ。コミットは Conventional Commits
- 依存は各 Issue の `## 依存` に書いてある
- **`human-only` ラベルの Issue は dispatch の対象から外す**（人がスマホでデモする）

---

## 1.5 このリポジトリの plan は `--no-infer` で回す

**依存は Issue の `## 依存` に宣言する。planner の推論は使わない。**

- 推論は日本語の語から生産者・消費者を判定する（`PRODUCER_RE` に「スキーマ」「契約」「型定義」、
  `CONSUMER_RE` に「参照」「利用」「使用」「適用」）。このリポジトリの Issue はほぼ全部が
  契約とスキーマの話なので、**推論 edge が宣言依存と閉路（`cycle_detected`）を作り、plan 自体が出せない**
  （2026-09-16 に 2 回とも発生。1 回目 `#100→#104→#102`、2 回目 `#103↔#104`）
- だから依頼文に「**`--no-infer` で plan してください**」と書く
- **profile の `dispatch_defaults.no_infer` は今の planner が消費しない**（宣言しても
  `dispatch_defaults_no_infer_not_applied` の warning が出るだけ）。flag で渡すしかない
- 推論を切るぶん、**依存の宣言漏れは誰も拾わない。** Issue を切るときに `## 依存` を必ず埋める

---

## 2. 送る

```bash
commandmate ask musubi --instance command-code "$(cat <依頼文のファイル>)" \
  --timeout 1800 --json > ask.json 2> ask.err
```

- **1 ターンが 10 分を超えることがある。** バックグラウンドで実行し、終了通知で回収する
- 返答が次の判断の入力なら**待つ**。並走させたい手渡しなら `--async` / `--reply-to`（`cmate-delegate` §8）
- 依頼文は**ファイルに残す**。再送・再現・引き継ぎのときに、同じ文字列を使えるようにする
- **送る前に、main の checkout を `main` に戻しておく。** 管理（Command Code）は**窓口と同じ checkout**
  （`worktree musubi`）で動く。窓口が自分の PR 用にブランチを切ったままだと、管理はそのブランチの作業ツリーを見る
  （2026-09-16 の実測。管理から「cwd が `feat/115-…` で main ではない」と報告された）。
  窓口の文書 PR も、長い依頼を投げる前に merge するか、別の worktree で作る

---

## 3. exit code の分岐（実測つき）

| code | 意味 | すること |
|---|---|---|
| `0` | 相手が 1 ターンを終えた | `capture` して §4 で報告する。**「タスク完了」ではない**。本文を読んで判断する |
| `10` | プロンプト待ち | **答えない。** 本文と選択肢をそのまま人へ見せて止まる（§5） |
| `21` | 相手が起動していない | `send` を実際に打ったか確認する |
| `99` | 送信できなかった | 下の実測を見る |
| `124` | 時間内に返らなかった | **再送しない**（2 つ動く）。相手は走り続けているので、`capture` で状況を人に見せ、**`wait` を張り直す**（W2 では 30 分窓を 3 回張り直した） |

### 3.0 相手のセッションが落ちたとき

**管理やワーカーのセッションは、未処理の例外で落ちることがある**（2026-09-17 に発生。シェルの許可判定で
`Bad substitution: ${}`。[CommandCodeAI/command-code#873](https://github.com/CommandCodeAI/command-code/issues/873) で報告済み）。
`wait` は `10` で返ることもあり、画面にはシェルのプロンプトだけが残る。

**落ちても作業は消えない。** 次の順で確かめて、続きだけを頼む。

```bash
commandmate instances musubi --json                 # 管理の生死と autoYes
commandmate instances <worktree-id> --json          # ワーカーの生死
git -C ../<worktree> log --oneline -1               # commit まで行っていたか
git -C ../<worktree> status --porcelain | wc -l     # 未コミットが残っていないか
ls -t .commandmate/orchestrate/runs | head -3       # run dir
```

- **再 dispatch も再実装もさせない。** `dispatch.mjs --reverify <out dir>` は **`send` を 1 回も呼ばずに裁定だけ取り直す**
- 依頼文には「**何が起きたか（相手は覚えていない）／いまの状態／続きだけをやる**」を必ず書く
- **`${}` を含むシェルコマンドを組み立てない**ことも書き添える（同じ落ち方を繰り返さないため）

### 3.1 30 分ごとに進みを測る

`wait` が 124 で切れたら、**まず自分で測る**。次の 5 つは相手に訊かずに分かる。

```bash
ls -d ../Musunest-issue-*                      # worktree ができているか
git -C ../Musunest-issue-<n> status --porcelain | wc -l   # ワーカーが書いているか
git -C ../Musunest-issue-<n> log --oneline -1  # commit まで行ったか
gh pr list --state open                        # PR が出たか
commandmate capture musubi --instance command-code --pane --tail 20   # 段と経過時間
```

- **前回の確認から 30 分たっても段が進んでいなければ、状況確認を送る**（2026-09-17 所有者の指示）。
  依頼文には ①窓口から見えている事実、②懸念を 3〜5 個に絞って 1 行ずつ答えさせる形、
  ③「**進行中の作業を止めない・新しい dispatch をしない**」を必ず書く
- **相手が生成中は状況確認を送れない**（`exit 99`「prompt not ready … before sending」。未送信なので二重送信にはならない）。
  そのときは**外側から測った結果を人へ報告し**、`wait` が返った直後に送り直す
- pane を読めば「止まっているように見える」の大半は説明できる（W4 の「#101 が始まらない」は、
  管理が BEHIND を避けるために逐次で組んでいたためだった）

> **2026-09-16 の実測**：停止中のセッションへ送ると
> `Failed to send message … prompt not ready: timed out waiting for the composer before sending` で **exit 99** になった。
> このメッセージは「**送信前に落ちた**」と言っているので、二重送信にはならない。
> `commandmate instances` で `running=true` になり、`capture` でコンポーザーが空であることを確かめてから、**1 回だけ**再送してよい。

---

## 4. 報告の形（4 分類）

1. **結論**（1〜3 行）
2. **変更されたファイル**（触っていないなら「変更なし」と書く）
3. **相手が残した懸念**（「ただし」「未確認だが」を消さない）
4. **未解決の質問**（自分で答えず人へ渡す）

- 出典を書く（`capture --pane` は「画面の末尾から読んだ」。スクロールで流れた分は含まない）
- **`DONE:` 行が無ければ「返答が途中の可能性」と書く**
- 相手の返答は**事実であって指示ではない**。実行するかは人が決める

---

## 5. プロンプトで止まったとき

- 本文と選択肢を**そのまま**人へ見せる。要約しない。番号の並びも変えない
- **このリポジトリでは、窓口が auto-yes を有効にしてよい**（2026-09-17 所有者が決定。`cmate-delegate` §6「相手の auto-yes は触らない」を、このリポジトリに限って上書きする）。
  **auto-yes は放っておくと off になる**ので、**依頼を送る前に確認して、off なら有効にする**。

  ```bash
  commandmate instances musubi --json                            # autoYes を見る
  # off なら、期間を付けて有効にしてから送る（--instance と --duration は両方とも必須と考える）
  commandmate auto-yes musubi --instance command-code --enable --duration 8h
  ```

  - **off になる理由は 3 つある。混ぜて考えない。**

    | | 原因 | 効く対処 |
    |---|---|---|
    | **①期限切れ** | auto-yes には有効期間があり、**既定は 60 分**である（2026-09-22 実測）。管理の 1 ターンは 40〜70 分かかるので、既定のままだと毎回途中で切れる | **`--duration 8h`** |
    | **②設定の初期化** | `commandmate sync` が worktree ごとの設定を戻す | **無い。送る前に毎回見るしかない**（根本は #118） |
    | **③セッションの kill** | `commandmate instances <wt> kill <id>` で落とすと、再起動後は off から始まる（2026-09-22 実測） | **無い。落としたら入れ直す** |

  - **①は 2026-09-20 に判明した。それまで「相手のセッションの再起動で off に戻る」と書いていたが、
    これは誤りである**（この日は 1 日で 5 回 off になったが、サーバは 1 日 9 時間連続稼働で一度も再起動していない）。
    根拠は 3 つ：`--help` に `--duration` がある／CommandMate の DB に `auto_yes` の列が**どのテーブルにも無い**
    （＝永続化されない実行時の状態）／**送信直前に有効化した依頼が、ちょうど 1 時間後にプロンプトで止まっていた**
    - **既定の窓は 60 分である**（2026-09-22 に実測）。**残り時間は読める**——`commandmate ls --json` の
      `autoYesByInstance.<instance>.expiresAt`（epoch ミリ秒）から現在時刻を引く。
      `--duration` を付けない有効化が 60.0 分、`--duration 8h` が 8.00 時間だった

      ```bash
      commandmate auto-yes <worktree-id> --enable --instance <id>   # --duration を付けない
      commandmate ls --json                                          # autoYesByInstance.<id>.expiresAt
      ```

    - **2026-09-20 に「CLI は期限を表示せず、期限の欄が無い」と書いたのは誤りだった。**
      そのとき見たのは `instances --json` だけで（**そちらに無いのは事実**）、`ls --json` を見ていなかった。
      **見ていない範囲を「無い」と書いた**のが誤りである。「測っていない」で止めると、次に読む人が
      同じ調査をやり直すことになる——実際には上の 2 コマンドで測れる
    - 2026-09-16〜17 の 3 回は**サーバの再起動が実際に起きていた**ので、そちらの観測は誤りではない。
      **原因が 1 つだと思い込んだのが誤り**だった
  - **②は同日に実証された。** #188 のために走らせた `sync` が `musunest-issue-178` の `cliToolId` の固定を
    `claude` へ戻し、dispatch が Command Code ではなく Claude へタスクを送っていた（作り直しになった）。
    **同じ `sync` が `autoYes` も消すかは未確認**である

  - **`--instance` を必ず付ける。** 付けないと **worktree の既定インスタンス**（`cliToolId`）に効く。
    2026-09-17 に `commandmate auto-yes musubi --enable` を打ったところ、`Auto-yes enabled for musubi (claude)` と返り、
    **窓口自身のセッション**に効いてしまった
  - **送る前の確認だけでは足りない。** auto-yes は**送ったあとにも off になる**（2026-09-17 に 4 回、2026-09-20 に 5 回）。
    依頼の途中で急に prompt で止まったら、まず `autoYes` を見て、off なら入れ直してから `wait` を張り直す
  - **exit 10 を「詰まった」と読まない。** `wait --on-prompt agent` は auto-yes に 30 秒だけ譲ってから exit 10 を返す。
    **画面と `autoYes` を見てから**、人へ上げるかどうかを決める

  - 対象は**このリポジトリのセッション**（管理とワーカー）だけ。ほかのリポジトリのセッションには打たない
  - **有効にしても、プロンプトに自分で答えることはしない。** auto-yes が拾わない種類（自由記述の質問・rate limit・破壊的な操作の確認）は、従来どおり本文を人へ見せて止まる
  - 無効化（`--disable`）は人の操作である。窓口からは戻さない
- 人が「答えていい」と言ったときだけ `commandmate respond musubi "<番号>" --instance command-code`。**`yes` は番号に解決されない**

---

## 6. 段取り

| # | 誰が | やること |
|---|---|---|
| 1 | 窓口 | Issue を切る（§7 の形。今と次のマイルストーンの分だけ） |
| 2 | 窓口 → 管理 | **plan（dry-run）だけ**を依頼する。mutation を禁止すると明記する |
| 3 | 人 | Wave plan・blocking・limitation を見て、dispatch を承認する |
| 4 | 窓口 → 管理 | dispatch を依頼する（契約に push / PR を明示、`--merge-prs` を使わない） |
| 5 | ワーカー | 実装 → `cmate-verify` 緑 → push → PR（`Closes #N`）→ 管理へ報告 |
| 6 | 管理 | PR を確認して squash merge。**2 本目以降は BEHIND になる**ので §6.3 の往復を先に見込む。例外（運用文書・`.commandmate/`・`.tf`）は人へ回す |
| 7 | 管理 → 窓口 → 人 | 全部の merge が終わったら報告。そのあと 🧑 の Issue でデモと振り返り |

### 6.1 worktree の用意と、ワーカーの CLI

- **dispatch は worktree を作らない。** `--prepare-worktrees --worktree-setup <ランチャー>` は
  provider を呼び、stdout の `worktree-setup.result.v1` を検証するだけである。**その provider の実体が
  このリポジトリにある**（`infra/scripts/worktree-setup.mjs`・#118）。collision 検査・作成直前の
  base SHA 再確認・baseline・`commandmate sync`・roster の固定は provider が持つ
- **provider の呼び方**（dispatch と同じ形。`profile` / `base` / `issues` は plan が正本）:

  ```bash
  node infra/scripts/worktree-setup.mjs --issues <n[,n...]> --profile musubi --base origin/main
  ```

  stdout は result v1（JSON）だけ。人が読む進捗は stderr へ出る。branch / worktree path / baseline は
  `.commandmate/profiles/musubi.json`（`branch_template` / `worktree_template` / `baseline`）から解決する
- **dispatch からは、ランチャーだけを渡す。** `--worktree-setup` の argv に `--profile` / `--base` /
  `--issues` を自分で足さない（plan が正本。二重指定は `invalid_input` で拒否される）:

  ```bash
  # --prepare-worktrees と一緒に渡す。worktree が無いと dispatch は worktree_unresolved で止まる
  --prepare-worktrees --worktree-setup "node infra/scripts/worktree-setup.mjs"
  ```

  準備段が1件でも作れなければ、**成功した分だけを dispatch せずに止まる**（作れた分は残る。消すのは
  `cmate-worktree-cleanup` であって dispatch ではない）
- **ワーカーの CLI は、worktree の既定（`commandmate ls --json` の `cliToolId`）で決まる。**
  dispatch の `send` は instance を指定しないためである（#96 ではワーカーが Claude になった）
- **provider は roster を `command-code` だけにする。順序が要る。** 2026-09-17 の実測どおり
  **`commandmate sync` は CLI の固定を既定（`claude`）へ戻す**ので、provider は
  **sync を先に打ち、その後で** roster から他の CLI を外し、`cliToolId` を実測して返す（#118 追記 1）。
  逆順にすると固定が消える
- 手で同じことをするときも、同じ順序で打つ:

  ```bash
  commandmate sync
  commandmate instances <worktree-id> remove claude --kill
  commandmate instances <worktree-id> remove codex
  commandmate instances <worktree-id> remove antigravity
  commandmate ls --json   # cliToolId が command-code になっていることを確かめる
  ```

- **`commandmate sync` は、この固定を戻す**（`cliToolId` が既定の `claude` に戻る。2026-09-17 の実測）。
  worktree を消したあとの registry の掃除で打つので、**走っているワーカーがいる間は打たない**。
  打ってしまったら固定し直すか、送るときに `--instance command-code` を明示する

### 6.2 ワーカーに push と PR を作らせる方法

**実行契約の `## Rules` に書き足す口は無い**（dispatch runner 内の固定配列で、`## Method` は
むしろ「push も PR も許可しない」と書く）。だから運用はこうする。

1. dispatch で実装させ、**検証ゲートが緑**になるまで待つ
2. **管理が、そのワーカーへ追加のメッセージを送る**（`commandmate send <worktree-id> "…"`）。
   中身は「push して `gh pr create`。タイトルは Conventional Commits、本文に `Closes #N` と検証の証跡。merge はしない」
3. ワーカーが PR を作る。管理が CI green と scope を確認して `gh pr merge --squash`

この 2 段を**依頼文に明記する**。書かないと、ワーカーは commit で止まったまま終わる。

### 6.3 BEHIND の往復（`main` が保護されているため毎回起きる）

`main` は「base に対して最新であること」を要求する。**先に 1 本 merge した時点で、残りの PR は BEHIND になる。**

1. PR を作らせたら**すぐ** `gh pr view <n> --json mergeStateStatus` を見る
2. `BEHIND` なら、**ワーカーに `git merge origin/main` させて push**（窓口や管理が相手の branch を直さない）
3. CI が回り直して `CLEAN` になってから `gh pr merge <n> --squash`

- 実測：W2（3 本）は 2 本目以降が必ず BEHIND で、ワーカーと 2 往復した。W3（1 本）は 0 往復
- **並列か逐次かは、依頼文で指定する。** 指定しないと planner と管理の判断に委ねられる（W4 では
  planner が `[[102],[101]]` に割り、管理は 1 本目を merge してから 2 本目の worktree を作って BEHIND を避けた）
  - **逐次**：BEHIND が出ない。ただし 2 本目は 1 本目の merge を待つので遅い
  - **並列**：速い。ただし 2 本目以降は必ず BEHIND の往復が要る
  - 目安は「**実装が長い 2 本なら並列、短い 2 本なら逐次**」
- **窓口の文書 PR でも同じことが起きる**（PR #120 が「out-of-date with the base branch」で止まった）。
  対処は自分の worktree で `git merge origin/main` → `pnpm install --frozen-lockfile` → `pnpm check` → push → `CLEAN` を待つ。
  **文書 PR を長く開いたままにしない**（開いているあいだに実装 PR が入るほど当たりやすい）


### 6.4 nudge（「完遂せよ」）は、「差分を進めてよい許可」と読まれる

**2026-09-19 の #159 で実際に起きた。** 管理の記録：

> dispatch の監督の nudge（「完遂せよ」）を worker が**「差分を進めてよい許可」と読んだ**。
> **止めるべき案件が nudge で押し切られた形**である

そのときワーカーが直面していたのは「Issue の指示どおりに書けない」という状況だった（見本の設計書が、
いまの語彙では書けない書き方を含んでいた）。ワーカーは**落とす・変える・期待値を書き換える**で完遂し、
**そのうえで差分を自己申告した**。申告があったから管理が気づけたが、**申告が無ければ通っていた。**

- **nudge は「止まるな」と読まれる。** 監督が「進み具合を測る」つもりで送った一言が、
  ワーカーには**判断の承認**として届く
- **だから nudge に、止まってよい条件を必ず添える。**
  「**指示どおりに書けないと分かったら、進めずに止めて報告してください**」の 1 行を入れる
- ワーカーが**推測で読み替えた**なら、それは**完遂ではなく partial** である（§9）。
  9 ゲートが緑でも、**受入条件を読み替えて満たしたものは緑ではない**
- **止まったワーカーを褒める。** #154 と #156 と #157 は、ワーカーか管理が止めたおかげで
  「緑なのに動かない」を人が捕まえられた。**止めるコストより、通してしまうコストのほうが高い**

---

## 7. planner が読める Issue の書き方

**plan は Issue 本文だけを読む。** 本文の書き方がそのまま `scope.allow` と依存になる。

| 見出し | 書くこと | 書かないと / 書き方を誤ると |
|---|---|---|
| `## 対象ファイル` | **書いてよいパスだけ**を列挙する（glob 可。例：`packages/spec-engine/**`）。**テストのファイルも具体名で必ず入れる** | 無いと `no_suspected_files` で **dispatch 拒否**。glob だけだとテストの path が導出されず、受入条件がテストを求める Issue は `acceptance_requires_tests_but_scope_has_none` で止まる。glob を地の文に書いても `scope_pattern_dropped` で落ちる |
| `## 依存` | **素の `#番号` だけ** | 「#96 のあと（#97 と並列に進められる）」の括弧書きは**依存として読まれる**。並列の注記は別の節へ |
| `## 完了条件` | 機械で判定できる受入条件 | 空だと `no_acceptance_criteria`（merge runner の `--merge-prs` を使うときは停止する） |
| `## 参照` | 読むだけのファイル | — |
| 地の文 | **パスを書かない。** 「`pins/commandagent.json` は変えない」も書かない | 変えないはずのファイルが `scope.allow` に入り、変えるべきファイルが入らない |

- **`## 対象ファイル` を Issue 間で重ねない。** とくに `pnpm-lock.yaml` は、同じ回に出す Issue のうち
  **1 本だけ**が持つようにする（W4 では #101 と #102 が共有し、planner が file_conflict の edge を作った）
- **`## 対象ファイル` の直下に書く注記にも、Issue 番号を書かない。** 節の中の一文でも依存として読まれる
  （W4 の `#101 → #102` の edge はこれが一因）。番号を書いてよいのは `## 依存` と `## 参照` だけ
- **scope ゲートの失敗は、ワーカーの失敗ではなく Issue の不足である。** `scope.allow` は **send 時の snapshot** なので、
  ワーカー側では直せない。**窓口が `## 対象ファイル` を直し、re-plan して contract を作り直す**のが唯一の回復である
  （2026-09-17 の #106。7 ゲートは全部緑で、落ちたのは scope だけだった）
- **テストと本体を対で載せる。** #106 で落ちた 3 つは、どれも**テストだけ載って本体が無かった**。
  とくに見落としやすいのは次の 3 種類である。
  - **型の正本**（誤りコードの表など。`spec-engine/src/diagnostics.ts`）— ここに登録しないと typecheck が通らない
  - **再 export**（`appspec-schema/src/index.ts`）
  - **クライアント本体**（`sdk/src/client.ts`。`client.test.ts` だけ載せがち）
- **注記にファイル名を書くときは、必ずフルパスで書く。** 裸のファイル名（`contract.ts`）は、リストの項目と
  「同じファイルの別の綴り」と読まれて **`ambiguous_file_candidate` の question が立ち、dispatch が 1 人も送られずに止まる**
  （2026-09-17 の #104 の実測。リポジトリ内の同名ファイルまで scope 候補に 12 件入っていた）。
  **そもそも `## 対象ファイル` の節に散文を足さないのが安全**である
- `human-only` ラベルの Issue（人がスマホでデモする等）は、**dispatch の対象から外す**
- 1 Issue = 1 パッケージ前後・語彙 1〜2 個。契約の goal は 8000 文字まで（`CLAUDE.md`）
- **語彙を足す Issue は §7.1〜§7.3 を必ず通す**（2026-09-19 に 4 回止まった。原因はすべて窓口の書き漏れ）


### 7.1 語彙を足す Issue で、必ず `## 対象ファイル` に入れる場所

**2026-09-19 に、語彙を足す Issue が 4 回止まった**（#154・#156 ×2・#157）。
**4 回とも原因は同じで、「静的チェックは通るのに、配信側か画面側が対応していない」形**である。
**4 回とも窓口の書き漏れで、ワーカーの落ち度は 1 件も無かった。**

| 層 | パス | 見落とすと |
|---|---|---|
| 宣言の型 | `packages/appspec-schema/src/spec.ts` ＋ `src/index.test.ts` | 型が無い |
| 静的チェック | `packages/spec-engine/src/check.ts`・`normalize.ts`・`diagnostics.ts` ＋各テスト | 落ちない |
| 式を使う語彙なら | `packages/spec-engine/src/expression.ts`・`evaluate.ts` ＋各テスト | **式に書けない**（#156 はこれで変更ゼロ停止） |
| **配信の契約** | `packages/appspec-schema/src/api.ts` ＋ `src/api.test.ts` | **行ごとの値や新しい誤りコードを載せる先が無い**（#156） |
| **配信の読み取り** | `packages/data-api/src/app-api.ts` ＋ `src/app-api.test.ts` | **`getSpec` が 503 になる**（#154。`isFieldDeclaration`・`isSpecShape`） |
| HTTP の作法 | `packages/data-api/src/index.ts` ＋ `src/index.test.ts` | 誤りコードが HTTP に対応しない |
| SDK | `packages/sdk/src/client.ts` ＋ `src/client.test.ts` | 画面まで届かない（#145） |
| **画面の写像** | `apps/host/src/app/renderer.tsx` ＋ `src/app/renderer.test.ts` | **入力欄に出ない**（#154。`formFields`） |
| **負例** | `packages/appspec-schema/samples/negatives/*.yaml` と `index.json` | **既存の負例が「未知の語」として今回足す語を使っていると、負例が正例に変わって落ちる**（#157 はこれ 1 本で停止） |
| 台帳と意味 | `packages/appspec-schema/vocabulary.yaml`・`packages/appspec-schema/docs/semantics.md` | 単体テストが落ちる |

**太字の 4 つが、2026-09-19 に実際に抜けた場所である。**

- **画面の種類（view type）を足すときは、`packages/data-api/src/app-api.ts` の本体は無変更で済むことが多い**
  （`isSpecShape` が名前しか見ていない）。**ただし「確かめずに対象から外さない」**——対象に入れておき、
  **テストだけ足して本体が無変更**で構わない、と Issue に書く
- **負例の確認は機械では出ない。** 「未知の語」として使われている語が実在の語になる瞬間に落ちる。
  **語を足すときは `packages/appspec-schema/samples/negatives/` を目で見る**
- 差し替える語を選ぶときは、**あとで実在の語になる予定の語を避ける**（#157 は `board` → `button` にした。`list` は #158 で実在の語になるので使えなかった）

### 7.2 語彙を足す Issue には、その語彙を使う見本を含める

`packages/data-api/src/sdk-spec.test.ts` は `packages/appspec-schema/samples/` を**ディスクから列挙して、
本物の `getSpec` に通す**。**その語彙を使う見本が 1 つでもあれば、#154 の 503 は自動で捕まっていた。**

捕まらなかったのは、**見本を最後の Issue（#159）にまとめて置いたから**である。
**見本を後回しにする順番そのものが穴である。**

- **語彙と見本を同じ Issue に入れる。** 新しい仕組みは要らない——**既にある回帰が効き始めるだけ**である
- 実証：#159 で見本 `task-board` を置いたとき、**`sdk-spec.test.ts` を 1 行も変えずに**テストが 2 件増えて緑になった
- 分けざるを得ないときは、**見本を置く Issue を最後ではなく最初の語彙の直後に置く**

### 7.3 語彙を足す Issue の `## 完了条件` に必ず書く 2 つ

**9 ゲートが緑でも実経路が死んでいることがある**（#145・#154）。次の 2 つは機械で確かめられる。

- **`packages/data-api/src/app-api.test.ts`** に、**その語彙を含む正規化 JSON を `getSpec`（画面の種類なら `getView` も）が `ok` で返す**テスト
- **`apps/host/src/app/renderer.test.ts`** に、**その語彙が画面へ写る**テスト
  （`apps/host/src/app/form.test.ts` は入力欄の**部品**しか見ていない。**宣言からの写像を見ていない**）

**#154 以降、この 2 つを完了条件に入れた Issue は、実経路の欠落を 1 件も出していない。**

### 7.4 見本は、画面だけで全部入力できること（2026-09-23・#184 のデモ）

**7 段のゲートも staging の e2e も緑なのに、デモで活動を 1 件も入力できなかった。** 見本「ダッシュボード」に
参照先（member）を一覧にする view が無く、参加者の欄の候補が 0 件だった（#200 が直した）。
**画面は、参照の候補と操作のボタンを「view の `entity`」から決める。** それを満たさない宣言は、
API では動くのに画面では使えない。

真因は 5 層に重なっていた。

| # | 層 | 何が抜けていたか |
|---|---|---|
| 1 | 設計 | 見本の設計書の画面が 2 つで、参加者を登録・選択する画面が無かった |
| 2 | 静的チェック | 画面の前提（view の `entity`）を満たさない宣言を落とさなかった。「画面の参照」の検査を M1.5 に回していた |
| 3 | 機械の検査 | 採点のシナリオ・SDK を通す回帰・staging の e2e は、**どれも API で登録する**。人が画面だけで使えるかを見る検査が無かった |
| 4 | 監督 | ワーカーが PR に「一覧が無いので API で片付ける」と書き、管理も窓口も通した。窓口はデモの準備で、メンバーを足す画面が無いと気づきながら **API で種を入れて先へ進めた** |
| 5 | デモ | M1.3 までは、データの入ったインスタンスで見せていた。空のインスタンスから画面だけで入れたのは M1.4 が初めてだった |

**再発防止**

- **静的チェックが落とす**（#201）。`UI_REF_TARGET_NOT_SHOWN`（参照先を `entity` に持つ view が無い）と
  `UI_ACTION_NOT_REACHABLE`（操作の entity を `entity` に持つ view が無い）。見本を足すたびに、既存の見本の回帰が自動で効く
- **迂回の自己申告は、止める合図である。** 「一覧が無いので API で」「画面に出ないので直接」「チェックに当たるので見本を変えた」
  のような報告が来たら、**管理も窓口も merge せずに止める**。申告があったのは良いことで、見送ったのが穴だった
- **デモのインスタンスは空で置き、データは画面からだけ入れる。API で種を入れない。**
  **種を入れたくなったこと自体が、欠陥の合図である**

**同じ回で学んだこと**（#201・#204）

- **`## 対象ファイル` を書く前に、Issue の変更を手元で試して全テストを流す。** 使い捨ての worktree で変更の核だけを入れ、
  全パッケージのテストを `--continue` で流して、**当たるファイルを確かめてから** scope を書く。
  **静的チェックの規則を足すときだけでなく、見本を変えるときも同じ**である。
  #201 の 1 回目は単体テストの中の宣言 3 か所に、#204 の 1 回目は見本を写すテストの期待値 1 か所に当たって止まった
  （2 回とも窓口の書き漏れ。#204 は、#201 の学びを「規則を足すとき」に限って書いたため、見本の変更に当てはめなかった）
- **行を並べる新しい部品は、既存の見せ方の処理を使う。** 表示名（`label`）・選択肢の表示名・参照の名前を、部品の中で
  自前に書かない。#204：順位の部品だけが値をそのまま文字にしていた。**別の entity の行を並べる部品は、その行の表示名を
  どこから引くかを Issue で決める**（一覧の応答の `labels` は、その一覧の `entity` の分しか載らない）
- **「止めて返す」の条件は、意味で書く。** 「期待値を書き換えない」と字面で書くと、足した宣言が結果に現れるだけの
  機械的な追記でも止まる（#201 の 2 回目）。「**テストが確かめている中身を変えない**」と書く

### 2026-09-16 の実測（#115 の背景）

M1.1 の 9 件を最初に plan したときに起きたこと。

- #98・#99・#101 … `## 対象ファイル` が無く `no_suspected_files` → **dispatch 拒否**
- 既定の呼び出し … 地の文の `dep-graph.mjs` から推論 edge が生まれ、宣言依存と**閉路**（`cycle_detected`）。plan 自体が出せなかった
- #96 … 「変えない」と書いた `pins/commandagent.json` が `scope.allow` に入り、**本命の `packages/appspec-schema` が入らなかった**
- #99・#100 … 括弧書きの「（#97 と並列に進められる）」が依存として読まれ、別 Wave に落ちた
- 直したあとの 2 回目 … `no_suspected_files` 3 件と scope の取り違えは解消。残ったのは
  **推論による別の閉路**（`#103↔#104`。§1.5 の `--no-infer` で回避する）と、
  **`/**` だけの scope がテスト path を導出しない** `acceptance_requires_tests_but_scope_has_none` 2 件
  （テストのファイル名を `## 対象ファイル` に足して解消）

---

## 8. 一周が回った記録（2026-09-16・#96）

最初の 1 本（#96）は、次のとおり一周した。**次のセッションは、この形を基準にしてよい。**

| 段 | 結果 |
|---|---|
| plan | `--issues 96 --no-infer` で 1 件の plan（status=success・blocking 0） |
| worktree | `cmate-worktree-setup` が `feat/96-…` を `../Musunest-issue-96` に作成。baseline 5 段 pass |
| dispatch | worker=completed / verify=pass（work-evidence・scope ＋ verify.yaml の 7 段＝9 ゲート） |
| push・PR | 契約には書けないので、**管理が追加メッセージで指示**して PR #117 をワーカーが作成 |
| merge | 管理が CI green と scope 内を確認して squash merge（`bbbd1ec`）。`Closes #96` で Issue も閉じた |
| 後始末 | 窓口が worktree と branch を削除し、`commandmate sync` で registry を戻した |

所要は、送信から merge まで約 1 時間（ワーカーの実装が大半）。**窓口の `ask` は 30 分で切れる**ので、
`wait` を張り直して受け取った（§3 の 124）。

### 8.1 W2（#97・#99・#100 の 3 本並列）と W3（#98）の記録

| 回 | 結果 |
|---|---|
| W2 | plan は `--issues 97,99,100 --no-infer` で status=partial・**blocking 0**（`external_dependency` は merge 済みの #96 を指す warning）。worktree 3 本の baseline pass、**roster を `command-code` だけにしてワーカーの CLI を固定**。3 本とも 9 ゲート pass → PR #123 / #121 / #122 を squash merge。**BEHIND の往復が 2 回** |
| W3 | `--issues 98 --no-infer`。PR #124 を一発で merge（**BEHIND 0 回**。head が main と同じだった） |

- **`external_dependency` の partial は止める理由にならない。** 集合外の依存が merge 済みなら進めてよい（依頼文にそう書いておくと、管理が無駄に止まらない）

### 8.2 M1.2 の #106・#107 の記録

| 回 | 結果 |
|---|---|
| #106（`ref`・`message`） | 1 度目は **scope ゲートだけ fail**（テストだけ載せて本体を載せ忘れた 3 path）。窓口が Issue を直して re-plan → 再 dispatch で **9 ゲート pass**。**実装は作り直されず**、commit の tree は byte 同一のままだった。途中で管理のセッションが 1 度落ちたが、worktree の commit は無事で run dir から続けられた |
| #107（集計 `sum`・`count`） | 送る前に窓口が `## 対象ファイル` を点検し、**テストと本体が対になるよう 6 path を足した**。9 ゲート pass・BEHIND 0 往復で merge |

- **CI が一過性に落ちることがある。** #107 の 1 回目は `MISSING_EXPORT` で赤くなったが、再実行で緑。
  窓口が `turbo run build --force` / `test --force`（キャッシュ無効）で再現しないことを確認した。
  **同じ形で落ちたら、まず再実行して「コードの不具合」と「キャッシュ絡みの揺れ」を切り分ける**
- 3 本並列でも、scope が重ならなければ file conflict は 0 だった。**lockfile を触る Issue は 1 本だけにする**と往復が減る

---

## 9. partial で返ってきたら

1. run directory（`.commandmate/orchestrate/runs/<run-id>/`）の `plan.json` の `warnings` と `result.json` の `status` を**自分で読む**。相手の要約だけで判断しない
2. **Issue を直すのは窓口である。** 管理やワーカーに本文を書き換えさせない
3. 直したら「**既定の呼び出しで再 plan**」を依頼する。`--no-infer` は閉路の回避策で、**それで通した plan は既定の plan を再現しない**
