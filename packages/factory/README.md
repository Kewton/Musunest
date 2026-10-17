# @musunest/factory

プロダクト内の工場（**宣言だけを作る** LLM エージェント）である。設計の正本は
[`workspace/mvp/m1/agent/02-architecture.md`](../../workspace/mvp/m1/agent/02-architecture.md) で、
要件は同 [`01-requirements.md`](../../workspace/mvp/m1/agent/01-requirements.md)。

**外側（段の順番・記録・打ち切り・合否）はコードが決め、内側の「書く・直す」段だけを LLM に任せる**（§1）。
このパッケージは **純粋な TypeScript**（Cloudflare 固有の API も Node 固有の API も使わない）で、依存して
よいのは `@musunest/spec-engine` と `@musunest/appspec-schema` だけである（§3.1）。**環境変数とファイルを
扱うのは、手元の入口（`src/cli.ts`）と adapter（`src/openai.ts`）だけ**である。

## 1. 何をするか（このパッケージが持つもの）

| 置き場所 | 中身 | 出所 |
|---|---|---|
| `src/llm.ts` | `LlmClient` の型（構造化出力・道具付き・usage・予約）と、要求と応答の型 | §2・§2.1 |
| `src/llm-fake.ts` | 記録した応答を順に返す偽物の `LlmClient`（試験は API を呼ばない） | §2.1 |
| `src/budget.ts` | 費用の予約（呼ぶ前に最大費用を確保し、usage で精算する） | §1.5 |
| `src/call.ts` | 全 LLM 呼び出しを通す共通の口（予約・精算・回数・締切） | §1.5・§2.2 |
| `src/limits.ts` | 上限値（呼び出しの数・宣言の大きさ・依頼文の長さ…） | §1.5 |
| `src/outcome.ts` | 終わりの判定（合格／部分案／失敗 と `verdict`） | §1.4 |
| `src/fixed-test.ts` | ②' で固定する試験の型と形の確認 | §1.3 |
| `src/pipeline.ts` | 段（①〜⑧）の入力と出力の型と、⑦ の入力への写し | §1 |
| `src/openai.ts` | OpenAI の Responses API の adapter（**`fetch` だけ**。鍵を扱うのはここだけ） | §2.1 |
| `src/stages/*.ts` | 段（① 要件にする 〜 ⑥' 期待の裁定）。規則とデータを分け、道具の引数をコードが確かめる | §1・§2.2 |
| `src/record.ts` | 記録と要約の**欄**（段ごとの結果・トークン・裁定の数・失敗の帰属…）と、使用トークンの計 | §3.5・§4・S-5・S-7 |
| `src/bundle.ts` | ⑧ 納品物（manifest・要約・宣言・要件の一覧・対応表・試験の結果・申告・裁定・検証の結果） | §4 |
| `src/run.ts` | **段を決まった順に回す部分**（早期停止・⑦ の判定・⑧ の組み立て） | §1・§1.4・§1.5 |
| `src/cli.ts` | **手元の入口**（`factory:run`。鍵は環境変数から、文書はファイルから） | §3.2 |

依存の向きは `factory → appspec-schema, spec-engine` だけである（control-plane には依存しない。
納品物の型は appspec-schema から取る。§3.1）。正本は
[`infra/scripts/dep-graph.mjs`](../../infra/scripts/dep-graph.mjs) で、`pnpm lint` が機械強制する。

## 2. 手元から流す（`factory:run`。§3.2）

```bash
pnpm --filter @musunest/factory build
OPENAI_API_KEY=... pnpm --filter @musunest/factory factory:run -- <依頼文のファイル> --out <ディレクトリ>
```

- 段を **①→①'→②→②'→③→④→⑤a・⑤b→（⑥・⑥'）→⑦→⑧** の順に回す。完走する道では、逆照合（①'）・
  試験の固定（②'）・対応表（⑤a）・試験を流す（⑤b）を必ず通す（LLM の出力で段を飛ばさない。§1）。
- **早期停止**：① の入口・前半の段の失敗・依頼文の上限超え・残高切れ・締切切れ・呼び出しの数の超過では、
  その場で止め、止めた段と理由を記録する（§1.5・S-7）。
- **実行していない検査を「不一致 0」と扱わない。** ④ を通らない版のままなら、合格にしない（§1.4）。
- 出力は `bundle-manifest.json` と `artifacts/`（`app.spec.yaml`・`summary.json`・要件の一覧・対応表・
  試験の結果・申告・裁定・`verification.json`）。検証の結果には、**最後の宣言のバイト列の SHA-256** を書く
  （§4・R-3）。要約は最後の行に 1 行の JSON（`commandagent.headless-summary/v1`）で出す。
- 鍵が無ければ、**API を呼ばずに**使い方の誤り（終了コード 2）で終わる。単価は入口で渡す（日付付きの既定値）。

### 2.1 段単位の実行口（v1.1α。`08-architecture-v1.2.md` §8.3・Issue #544）

```bash
# T1〜T2' だけを流し、境界の checkpoint を書く
... factory:run -- <依頼文> --out a --pipeline v1.1a --plan-file plan.json --stage-end test-spec
# その T2／B1 の checkpoint から B1〜⑦ だけを流す
... factory:run -- <依頼文> --out b --pipeline v1.1a --plan-file plan.json --stage-start write --stage-input a/stage-checkpoint-t2-b1.json
```

- **旗**：`--stage-start <段>`・`--stage-end <段>`・`--stage-input <checkpoint>`。`--pipeline v1.1a --plan-file` と組んで
  だけ受ける（それ以外は `stage-range:pipeline`）。片方だけなら他方は経路の端（開始 T1・終了 ⑦）。
  **旗を省けば、v1 と v1.1α の要求・出力・要約・終了コードは今までとバイト列で同じ**（checkpoint も書かない）。
- **段の表**（定数で閉じる）：開始は `name-table`（T1）・`test-spec`（T2）・`write`（B1）、終了は `semantic-check`
  （T1'' まで）・`test-spec`（T2' まで）・`judge`（⑦ まで）。表に無い名前は `stage-range:unknown`、開始が終了より後は
  `stage-range:order`。開始 T1 に入力を付けたら `stage-input:not-needed`、開始 T2・B1 に入力が無ければ
  `stage-input:missing`（どれも終了コード 2）。
- **境界の checkpoint（再開の正本）**：範囲の中で通った境界ごとに 1 つ書く。境界は `t1-t2`（持ち越しを導き、T2 を
  呼ぶ直前）と `t2-b1`（T2' を終え、B1 を始める直前）。中身は確定した仕様と依頼文の SHA・採用した表・採用した T1'' の
  点検結果・J4 の助言・その時点の持ち越し（`t2-b1` では試験の組・observes・網羅の単位も）と版。**B3'・B6 で足した
  持ち越し・棄却・網羅の損失は入れない**（B の結果を上流へ戻さない）。中身全部を正規の形で並べた SHA-256 を
  **出力ダイジェスト**として段の走りの記録（`stage-run.json`）に残す。通常の走りや ⑦ の最終の記録は再開の入力に
  しない。
- **再開の入力の照合**（`--stage-input` は前の段の走りが書いた checkpoint。同じディレクトリの `stage-run.json` も
  読む）。**クライアントを作る前**に照合し、1 つでも合わなければ API を呼ばず、何も書かずに、固定の符号 1 行を
  標準エラーに出して**終了コード 4** で終わる：`stage-input:unreadable`（読めない）・`boundary`（開始の段の直前の
  境界の checkpoint でない・記録が宣言していない）・`version`（形・語彙・契約の版。prompt と工場の版は記録だけ）・
  `digest`（出力ダイジェスト）・`plan-sha256`・`source-sha256`（今の確定した仕様の検査の結果）・`table-sha256`・
  `semantic-sha256`・`targets`（今の T1'' と同じ関数で導いた対象と判定）・`carry-over`（既存の持ち越しの関数で導き
  直したもの）・`suite-sha256`（開始 B1。組の SHA・observes・網羅の単位）。
- **終了コード**：段の通過 0、範囲の中の早期停止 1、使い方の誤り 2、確定した仕様の道の差し戻し 3（今と同じ）、
  段の入力の照合の失敗 4。**3 と 4 は別の意味**である（3 は走った結果、4 は走る前に入力を断った）。
- **段の通過と納品の成功は別の指標**である。段の走りの記録の `stage_pass` は「範囲の中に早期停止が無く、終了の段の
  最後の記録が ok」で、終了 ⑦ のときは ⑦ の判定を `stage_judge_verdict` として別に置く。段の走りは**納品物（manifest
  と宣言の束）を書かず**、要約の `verdict` も書かない（publish の口へ何も渡さない）。門・合否の規則・上限は変えない。
- **予算と締切の単位は段の走り 1 本**（`budget_scope: "stage-run"`）。`--budget`・`--deadline` をその走りの始まりから
  当て、前の走りで使った額と時間は引かない。記録の `conditions` に model・effort・文書の指紋・判定の口の構成（鍵は
  書かない）・版・予算と締切を残す。

## 3. LlmClient（§2・§2.1）

呼び出しは 2 つある。①'・②'・⑤a・⑥' の**構造化出力**（JSON Schema）と、⑥ の**道具付き**
（function calling）である（§2）。どちらも **usage**（入力・キャッシュ・出力・推論のトークン）を返す。
usage が返らないことがあるので、返り値は `LlmUsage | undefined` である。

```ts
import type { LlmClient, LlmUsage } from "@musunest/factory";

const client: LlmClient = createOpenAiLlmClient({ apiKey, model: "gpt-6-luna", effort: "high" });
```

規則（`instructions`）と依頼文（`input`）を分けるのは、依頼文に仕込まれた命令への境界のためである
（§2.2）。**合否・持ち主・納品先はコードが決める。** LLM の出力のどの欄からも決めない。

## 4. 費用の予約（§1.5）

呼ぶ前に、その呼び出しの最大費用（入力の長さ × 単価 ＋ `max_output_tokens` × 単価）を予約し、
ジョブの残高を超えるなら**呼ばない**。usage が返ったら実際の費用で精算する。usage が返らなければ
**予約を残したまま**にする。単価は引数で受け取る（コードに埋め込まない）。

```ts
import { JobBudget, estimateMaxCostUsd } from "@musunest/factory";

const budget = new JobBudget(0.1); // ジョブ全体で 0.10 USD（C-1）
```

## 5. 終わりの判定（§1.4）

段の結果から、**合格**／**部分案**／**失敗** と、要約の `verdict`（`full`／`partial`／`none`）を
返す**純粋な関数**である。合否はコードが決める（LLM の自己申告では合格させない）。

| 結果 | `verdict` | 条件 |
|---|---|---|
| 合格 | `full` | 静的チェックを通過・対応表の落ちが 0・試験の不一致が 0・未解決が 0・書けない要件が 0 |
| 部分案 | `partial` | 静的チェックを通過。ただし、書けない要件がある／未解決を残した |
| 失敗 | `none` | 静的チェックを通過した版が無い、または上限に触れて部分案の条件も満たさない |

## 6. テスト（受入条件との対応）

```bash
pnpm --filter @musunest/factory test    # unit（このパッケージ）
pnpm check                              # リポジトリ全体（verify-parity → lint → typecheck → test → tf）
```

| 受入条件（Issue #288） | 担保するテスト |
|---|---|
| `pnpm --filter @musunest/factory test` が exit 0 | 下の各テスト |
| 通常の完走（合格と部分案の道。逆照合・試験の固定・対応表・試験を流す段が必ず通る） | `src/run.test.ts`「通常の完走」 |
| 早期停止（前半の段の失敗・依頼文の上限超え・残高切れ・締切切れ・呼び出しの数の超過） | `src/run.test.ts`「早期停止」 |
| 未実行の検査がある結果が合格にならない | `src/run.test.ts`「未実行の検査」 |
| 納品物（manifest の SHA-256 と大きさ・検証の結果の SHA-256・要約の wire） | `src/bundle.test.ts` |
| 記録（列挙した欄だけ・禁じた内容を入れない・版と裁定の数と失敗の帰属） | `src/record.test.ts` |
| 手元の入口（鍵が無ければ API を呼ばずに使い方の誤り・偽物で納品物を書く） | `src/cli.test.ts` |
| ライブラリが `fetch(`・環境変数・Node 固有の API を持たない（新しいファイルを含む） | `src/index.test.ts` |
| `pnpm check` が exit 0 | リポジトリのゲート（`.commandmate/verify.yaml`） |

- **試験は偽物の `LlmClient` で閉じる。** 実 API は呼ばない（課金しない）。
- **ワーカーは API を呼ばない。** adapter（`src/openai.ts`）は `fetch` だけを使い、鍵は環境変数から
  読まない（呼ぶ側が渡す）。`src/index.test.ts` が、手元の入口と adapter を除くライブラリのソースに、
  外部の LLM の API と Cloudflare・Node 固有の入口が無いことを走査して確かめる。
