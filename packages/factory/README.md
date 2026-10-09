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
