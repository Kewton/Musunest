# S1 手元の工房（studio）——設計と決定

> 置き場所：`workspace/mvp/m2/studio-s1.md`（人の PR で置く）。S1 の Issue（工房の 8 本）の参照の正本。
> 2026-11-11 起案。工場（`packages/factory`）は変えない。

## 1. 目的

所有者が手元の画面で「漠然とした依頼 → Plan の質問に選択式で答える（10 問・3 往復まで・推奨つき・自由入力）→ 確認 → Build → 結果を見る → partial なら了承 → staging へ公開」を通せるようにする。目指す UX は `workspace/mvp/m1/agent/04-plan-agent.md` §1・§2、結果の 3 つ（full／partial／none）は `workspace/mvp/m1/agent/02-architecture.md` §1.4。

S1 は**手元の工房**、S2 は 02 §3.3 の形（Queue・factory の Worker・ジョブの表）で staging に置く。S1 の目的は UX を早く触って直すことで、Cloudflare の資源・Secret を増やさない（先に安い手）。

## 2. 所有者の決定（2026-11-11）

| # | 決定 |
|---|---|
| D1 | S1（手元）から進める |
| D2 | S1 の Issue と PR のレビューは Claude_sub が行う |
| D3 | 費用の上限は **1 回 2.00 USD・1 日 4.00 USD** |
| D4 | partial は**所有者の了承のあと**公開してよい（02 §5 U-H） |
| D5 | 公開先は **staging のインスタンス `studio-*`** だけ（production へは出さない） |

所有者が推奨どおりと決めた（2026-11-11。もとは確認待ちの C1・C2）：

- **C1（決定）**：S1 の工房の公開は、所有者が手元から publish-bundle で出す既存の経路と同じとみなす（新しい例外ではない）。S2 で data-api の後ろへ移す（§7 ①）
- **C2（決定）**：工房の 1 日 4.00 USD は、計測の 1 日 4 USD と同じ財布か。**決定（推奨どおり）**：工房の台帳は工房の走りだけを数える。両方を使う日は、合計を所有者が意識する

## 3. 決定のあとに分かったこと（案を直した点）

- **staging には所属の検査が無い**（data-api の app-api の所属の確かめは production だけ）。`studio-*` は「URL を知る人なら開ける」で、e2e の試しのインスタンスと同じ扱い。所有者だけに絞るのは M2.3（§7 ⑤）
- **門は partial を断る**（`packages/control-plane/src/headless.ts` の `judgeAcceptance`：verdict が full でなければ `verdict_not_full`）。了承して公開するには、門に「所有者の了承の記録（manifest の SHA-256 に結び付けた）がある partial を受け入れる」口を足す。`publishSpec` を直接呼んで近道しない（CLAUDE.md 工場の条件 1）
- **門は見本の名前を必須にしている**（`packages/control-plane/src/bundle-publish.ts` の `sample`。3 つの見本のどれか）。利用者のアプリには見本が無い（§6 U-A）
- **画面は host に置かない**：host を手元で動かすには gateway・data-api の連なりが要り重い。S1 は `e2e/` と同じく workspace の一員で配らない `studio/`（手元のサーバ＋画面）。依存は `studio → factory, control-plane, appspec-schema`。S2 で画面を host へ移す（§7 ③）
- **工場は変えない**：Plan は利用者と往復するので、CLI の `--answers`（先に答えを知っている形）では足りない。工房のサーバが factory の公開の口（`runPlan`）に「画面の答えを待つ答え役」を差し込み、Build は標準の組を CLI と同じ口で呼ぶ
- 走りの記録はリポジトリの外（既定はホームの下の `.musunest-studio`）。`.gitignore` を触らない

## 4. 工場の呼び方（工房の走らせる役が頼る事実）

### 4.1 Plan

- `runPlan`（`packages/factory/src/plan/run-plan.ts`）は答える役を口 `PlanResponder` として受ける。口は 2 つの async 関数：
  - `answer(request)`：`questions`・`remaining`（残りの問数・往復）・`revision`・`issues` を受け、`{kind:"answers", answers}` か `{kind:"all-recommended"}` を返す
  - `confirm(view)`：確認の画面に出すもの（`PlanConfirmationView`：下書きの仕様・差分・書けないことと代わりの案・既定で決めたこと）を受け、`"build"` か `"stop"` を返す
- `runPlan` は往復ごと・確認ごとにこの Promise を await する → **画面の答えが届くまで解決しない Promise** を返せば、往復をまたいで画面と同期できる
- 上限（10 問・3 往復・自由入力 500 字）は工場が持つ（`AGENT_LIMITS`・`nextPlanStep`）。画面は残りを出すだけ
- 公開されている口：`runPlan` と Plan の型、`createOpenAiLlmClient`・`assembleJudge`・`loadDocumentsFromFiles`・`modelRatesOf`・`MODEL_RATES`・`VOCABULARY_VERSION`・`runCli`
- **締切は絶対時刻で、人の待ちも消費する。** 締切は生成の呼び出しの前・確認の前・確定を返す前に照らす。だから Plan の締切は「答えの待ちの上限の合計＋計算の余裕」以上にする：**答えの待ち 1 回 30 分・Plan の締切 180 分**。締切は門でしか照らさないので、長くしても費用は増えない
- `runPlan` は答え役が投げた例外を握らずに投げ直し、そのとき使った額は返らない → 取り消しは子プロセスを止める形にし、費用は概算（§4.4）で締める

### 4.2 Build の入力の包み（`plan-result.json`）

- `--plan-file` が読む包みを組む helper（`cli-plan.ts`）は公開されていない（index に無く、package の exports は `"."` だけ）→ **工房が包みを組む**
- 最上位の欄：`schema_version`（`musunest-factory/plan-only-result/v1`）・`outcome`（`confirmed`）・`plan`・`plan_sha256`（appspec-schema の `planDigest`）・`source_sha256`（依頼文の SHA-256）・`conditions`・`stop`
- 工場の検査：版・確定・確定仕様の検査・`planDigest` の一致・依頼文の SHA の一致・語彙の版。拒否は 1 行を出して終了コード 2
- 写しのずれは、組んだ包みを偽の LLM で `runCli --plan-file` に通す試験で CI が捕まえる

### 4.3 Build（標準の組）

- `--build-from`・`--factory-budget-usd` は計測の道具の旗で、工場には `--plan-file`・`--budget` として渡る。工房が渡す引数：
  `<依頼文> --out <納品物> --pipeline v1.2 --plan-file <包み> --model gpt-6-luna --effort medium --stage-effort test-spec=high --stage-model test-spec=gpt-6.1-terra --budget <2.00 − Plan の額>`
- 出力：納品物（manifest・宣言・要約・要件・書けないこと・確定仕様・検証の結果）・診断・Build の記録・checkpoint。要約は log の最後の 1 行の JSON で、**門の `summaryStdout` になる**
- 終了コード：0（納品物あり）・1（納品物なし）・2（使い方・包みの誤り）・**3（Plan への差し戻し）**。S1 は差し戻しで Plan を再開せず、「依頼を直してやり直す」へ導く

### 4.4 進み・取り消し・費用

- 工場は全部のファイルを最後に書く → 進みは `CliDeps.makeClient` で LLM の口を包み、要求の `schemaName` から段の表示名を引く。未知は「作業中」。LLM 判定も同じ client を通るので進みに出る
- 同じ包みで tokens × 単価（要求の `model` があればその単価）の概算を数える。Jev の判定は client を通らないので概算に入らない
- `runCli` は止める口を持たない → **工房自身の子プロセスの中で library として呼ぶ**。取り消し・待ちの上限＝子を止める。factory の index を import しても cli の `main` は入口の照合で動かない
- 子に渡す環境は絞る：工場の子は LLM の鍵（と Jev の鍵）だけ、公開の子は Cloudflare の変数だけ

## 5. 費用の上限（D3）

- 走りの開始で 2.00 を予約し、終われば実額（Plan＋Build）で置き換える。「今日の実額＋未決の予約＋2.00 > 4.00」なら開始を断る（4.00 ちょうどは通る）。日付は手元の時刻
- 子が落ちた・止めた走りは最後の概算で締め、「概算」の印を残す
- 同時に走るのは 1 本。上限を画面から変える口は作らない

## 6. 門の扱い（U-A・U-H）

- **U-A（利用者のアプリ）**：見本の代わりに「利用者のアプリ」を明示した要求では、②を比べずに「比べる対象が無い」を返す。見本と両方・どちらも無い要求は断る。見本の manifest の SHA と一致する納品物を「利用者のアプリ」で出したら断る（見本の照合を避ける穴を塞ぐ）
- **U-H（partial の了承）**：了承の記録 `{schema_version, manifest_sha256, run_id, verdict:"partial", approved_by, approved_at}`。④で verdict が partial、記録の manifest の SHA が①の SHA と一致、`run_id` が要約の `run_id` と一致するときだけ `verdict_not_full` を外す。status・assurance・①②③⑤は変えない。none は通さない。full に渡された了承は使わない
- **近道ではない理由**：①③⑤は変えず、④は verdict の条件だけを納品物の SHA と走りに結び付いた了承で外し、②は方針を明示の状態で返す。門を迂回する道は増えない
- **S1 の限り**：了承の `approved_by` と「利用者のアプリ」の印は呼ぶ側の申告である。S1 は所有者の手元だけなので許容し、S2 では data-api が認証した利用者から組み立てる（§7 ②）
- 公開は `infra/scripts/publish-bundle.ts` を子プロセスで呼ぶ（Cloudflare の adapter を工房に複製しない）。env は staging に固定。publish-bundle は production のアカウントを断り、ホスト名・Account ID を出さない

## 7. S2 へ持ち越すもの

| # | 何を | メモ |
|---|---|---|
| ① | 公開を data-api の後ろへ移す | S1 は所有者の手元の publish-bundle と同じ経路（C1） |
| ② | 了承・利用者のアプリの印を、data-api が認証した利用者から組み立てる | S1 は呼ぶ側の申告 |
| ③ | 画面を host へ移す | 画面の型は S1 のものを引き継ぐ |
| ④ | 試しのインスタンスを消す口 | staging に `studio-*` が溜まる。e2e の残りと一緒に |
| ⑤ | `studio-*` の所属の検査 | M2.3 の範囲 |
| ⑥ | 工場の `cli-plan` の公開（包みの写しをやめる） | 工場の変更なので方法論に従う。採るかは S1 の試用のあと |

## 8. 安全

- サーバは 127.0.0.1 にだけ bind。起動ごとの合言葉を画面の HTML に埋め、`/api/` は合言葉のヘッダを要る。**Host の照合は静的ファイルを含む全部の要求にかける**（DNS rebinding で合言葉が抜けない）。POST は Origin が同じでなければ断る
- 「開いて試す」の staging のオリジンは手元の環境変数（`STUDIO_STAGING_ORIGIN`）から HTML に埋めるだけ。`/api/` の応答・記録・標準出力に入れない
- 工房は環境ファイルを自分で開かない（起動のコマンドが Node の `--env-file` で読む）
- 工房の公開の子は `infra/scripts` を tsx で起こすので、依存の向きの照合の外にある。工房はリポジトリの checkout の中から起動する
- このリポジトリは public：workers.dev のサブドメイン・Account ID・トークン・依頼の原文の個人的な中身を、記録・PR・振り返りに書かない

