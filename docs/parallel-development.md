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

## 2. 送る

```bash
commandmate ask musubi --instance command-code "$(cat <依頼文のファイル>)" \
  --timeout 1800 --json > ask.json 2> ask.err
```

- **1 ターンが 10 分を超えることがある。** バックグラウンドで実行し、終了通知で回収する
- 返答が次の判断の入力なら**待つ**。並走させたい手渡しなら `--async` / `--reply-to`（`cmate-delegate` §8）
- 依頼文は**ファイルに残す**。再送・再現・引き継ぎのときに、同じ文字列を使えるようにする

---

## 3. exit code の分岐（実測つき）

| code | 意味 | すること |
|---|---|---|
| `0` | 相手が 1 ターンを終えた | `capture` して §4 で報告する。**「タスク完了」ではない**。本文を読んで判断する |
| `10` | プロンプト待ち | **答えない。** 本文と選択肢をそのまま人へ見せて止まる（§5） |
| `21` | 相手が起動していない | `send` を実際に打ったか確認する |
| `99` | 送信できなかった | 下の実測を見る |
| `124` | 時間内に返らなかった | `capture` して状況を人に見せる。**再送しない**（2 つ動く） |

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
- **相手の auto-yes は触らない**（`--auto-yes` を付けない、`commandmate auto-yes` を打たない）。有効にするのは**人が CommandMate の UI で**行う
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
| 6 | 管理 | PR を確認して squash merge。例外（運用文書・`.commandmate/`・`.tf`）は人へ回す |
| 7 | 管理 → 窓口 → 人 | 全部の merge が終わったら報告。そのあと 🧑 の Issue でデモと振り返り |

---

## 7. planner が読める Issue の書き方

**plan は Issue 本文だけを読む。** 本文の書き方がそのまま `scope.allow` と依存になる。

| 見出し | 書くこと | 書かないと / 書き方を誤ると |
|---|---|---|
| `## 対象ファイル` | **書いてよいパスだけ**を列挙する（glob 可。例：`packages/spec-engine/**`） | 無いと `no_suspected_files` で **dispatch 拒否**。glob を地の文に書いても `scope_pattern_dropped` で落ちる |
| `## 依存` | **素の `#番号` だけ** | 「#96 のあと（#97 と並列に進められる）」の括弧書きは**依存として読まれる**。並列の注記は別の節へ |
| `## 完了条件` | 機械で判定できる受入条件 | 空だと `no_acceptance_criteria`（merge runner の `--merge-prs` を使うときは停止する） |
| `## 参照` | 読むだけのファイル | — |
| 地の文 | **パスを書かない。** 「`pins/commandagent.json` は変えない」も書かない | 変えないはずのファイルが `scope.allow` に入り、変えるべきファイルが入らない |

- `human-only` ラベルの Issue（人がスマホでデモする等）は、**dispatch の対象から外す**
- 1 Issue = 1 パッケージ前後・語彙 1〜2 個。契約の goal は 8000 文字まで（`CLAUDE.md`）

### 2026-09-16 の実測（#115 の背景）

M1.1 の 9 件を最初に plan したときに起きたこと。

- #98・#99・#101 … `## 対象ファイル` が無く `no_suspected_files` → **dispatch 拒否**
- 既定の呼び出し … 地の文の `dep-graph.mjs` から推論 edge が生まれ、宣言依存と**閉路**（`cycle_detected`）。plan 自体が出せなかった
- #96 … 「変えない」と書いた `pins/commandagent.json` が `scope.allow` に入り、**本命の `packages/appspec-schema` が入らなかった**
- #99・#100 … 括弧書きの「（#97 と並列に進められる）」が依存として読まれ、別 Wave に落ちた

---

## 8. partial で返ってきたら

1. run directory（`.commandmate/orchestrate/runs/<run-id>/`）の `plan.json` の `warnings` と `result.json` の `status` を**自分で読む**。相手の要約だけで判断しない
2. **Issue を直すのは窓口である。** 管理やワーカーに本文を書き換えさせない
3. 直したら「**既定の呼び出しで再 plan**」を依頼する。`--no-infer` は閉路の回避策で、**それで通した plan は既定の plan を再現しない**
