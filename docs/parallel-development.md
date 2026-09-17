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
  **auto-yes は相手のセッションの再起動で off に戻る**（2026-09-16〜17 に 3 回。CLI の自動更新で再起動が起きる）ので、**依頼を送る前に確認して、off なら有効にする**。

  ```bash
  commandmate instances musubi --json                            # autoYes を見る
  commandmate auto-yes musubi --instance command-code --enable   # off なら有効にしてから送る
  ```

  - **`--instance` を必ず付ける。** 付けないと **worktree の既定インスタンス**（`cliToolId`）に効く。
    2026-09-17 に `commandmate auto-yes musubi --enable` を打ったところ、`Auto-yes enabled for musubi (claude)` と返り、
    **窓口自身のセッション**に効いてしまった
  - **送る前の確認だけでは足りない。** auto-yes は**送ったあとにも off に戻る**（同日 4 回）。
    依頼の途中で急に prompt で止まったら、まず `autoYes` を見て、off なら入れ直してから `wait` を張り直す

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

### 6.1 worktree の用意と、ワーカーの CLI（2026-09-16 の実測）

- **dispatch は worktree を作らない。** `--prepare-worktrees --worktree-setup <ランチャー>` で
  provider に作らせる形だが、**`cmate-worktree-setup` は手順であって runner を持たない**。
  リポジトリに provider の実体を置く作業は **#118**。それまでは、**管理が `cmate-worktree-setup` の手順で
  worktree を作ってから、`--prepare-worktrees` 無しで dispatch する**
- **ワーカーの CLI は、worktree の既定（`commandmate ls --json` の `cliToolId`）で決まる。**
  dispatch の `send` は instance を指定しないためである（#96 ではワーカーが Claude になった）
- **Command Code に固定するには、worktree の roster から他の CLI を外す**（外した順に既定が次へ移り、
  1 つだけ残すとそれが `cliToolId` になる）

```bash
commandmate instances <worktree-id> remove claude --kill
commandmate instances <worktree-id> remove codex
commandmate instances <worktree-id> remove antigravity
commandmate ls --json   # cliToolId が command-code になっていることを確かめる
```

- **`commandmate sync` は、この固定を戻す**（`cliToolId` が既定の `claude` に戻る。2026-09-17 の実測）。
  sync は worktree を消したあとの registry の掃除で打つので、**走っているワーカーがいる間は打たない**。
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
