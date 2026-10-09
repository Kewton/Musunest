# @musunest/factory

プロダクト内の工場（**宣言だけを作る** LLM エージェント）の骨格である（Issue #278）。設計の正本は
[`workspace/mvp/m1/agent/02-architecture.md`](../../workspace/mvp/m1/agent/02-architecture.md) で、
要件は同 [`01-requirements.md`](../../workspace/mvp/m1/agent/01-requirements.md)。

**LLM はまだ呼ばない。** OpenAI の adapter とプロンプトは次の Issue である。このパッケージは
**純粋な TypeScript**（Cloudflare 固有の API も Node 固有の API も使わない）で、依存してよいのは
`@musunest/spec-engine` と `@musunest/appspec-schema` だけである（§3.1）。

## 1. 何をするか（この骨格が持つもの）

外側（段の順番・記録・打ち切り・合否）はコードが決め、内側の「書く・直す」段だけを LLM に任せる（§1）。
そのうち、次の 4 つを型と純粋な判定として置く。

| 置き場所 | 中身 | 出所 |
|---|---|---|
| `src/llm.ts` | `LlmClient` の型（構造化出力・道具付き・usage・予約）と、要求と応答の型 | §2・§2.1 |
| `src/llm-fake.ts` | 記録した応答を順に返す偽物の `LlmClient`（試験は API を呼ばない） | §2.1 |
| `src/budget.ts` | 費用の予約（呼ぶ前に最大費用を確保し、usage で精算する） | §1.5 |
| `src/outcome.ts` | 終わりの判定（合格／部分案／失敗 と `verdict`） | §1.4 |
| `src/pipeline.ts` | 段（① 要件にする 〜 ⑧ 納品物にする）の入力と出力の**型だけ** | §1 |

依存の向きは `factory → appspec-schema, spec-engine` だけである（control-plane には依存しない。
納品物の型は appspec-schema から取る。§3.1）。正本は
[`infra/scripts/dep-graph.mjs`](../../infra/scripts/dep-graph.mjs) で、`pnpm lint` が機械強制する。

## 2. LlmClient（§2・§2.1）

呼び出しは 2 つある。①'・②'・⑤a・⑥' の**構造化出力**（JSON Schema）と、⑥ の**道具付き**
（function calling）である（§2）。どちらも **usage**（入力・キャッシュ・出力・推論のトークン）を返す。
usage が返らないことがあるので、返り値は `LlmUsage | undefined` である。

```ts
import type { LlmClient, LlmUsage } from "@musunest/factory";

const client: LlmClient = /* 次の Issue で置く OpenAI の adapter */;
const response = await client.callStructured<{ requirements: unknown[] }>({
  instructions: "規則（毎回送る）",
  input: "依頼文（データとして囲んだ入力）",
  schemaName: "requirement-list",
  schema: { /* JSON Schema */ },
  maxOutputTokens: 1024,
});
response.output; // schema に適合した値
response.usage;  // LlmUsage | undefined
```

規則（`instructions`）と依頼文（`input`）を分けるのは、依頼文に仕込まれた命令への境界のためである
（§2.2）。**合否・持ち主・納品先はコードが決める。** LLM の出力のどの欄からも決めない。

## 3. 費用の予約（§1.5）

呼ぶ前に、その呼び出しの最大費用（入力の長さ × 単価 ＋ `max_output_tokens` × 単価）を予約し、
ジョブの残高を超えるなら**呼ばない**。usage が返ったら実際の費用で精算する。usage が返らなければ
**予約を残したまま**にする（呼んだ分を使ったか分からないので、残高を戻さない）。単価は引数で受け取る
（コードに埋め込まない）。

```ts
import { JobBudget, estimateMaxCostUsd } from "@musunest/factory";

const rates = { inputPerToken: 0.00000015, cachedInputPerToken: 0.000000075, outputPerToken: 0.0000006 };
const budget = new JobBudget(0.1); // ジョブ全体で 0.10 USD（C-1）
const maxCostUsd = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates });

const reserved = budget.reserve(maxCostUsd);
if (reserved.reserved) {
  const response = await client.callStructured(request);
  if (response.usage !== undefined) budget.settle(reserved.reservation, response.usage, rates);
  // usage が無ければ settle しない（予約は残る）
}
```

## 4. 終わりの判定（§1.4）

段の結果から、**合格**／**部分案**／**失敗** と、要約の `verdict`（`full`／`partial`／`none`）を
返す**純粋な関数**である。合否はコードが決める（LLM の自己申告では合格させない）。

| 結果 | `verdict` | 条件 |
|---|---|---|
| 合格 | `full` | 静的チェックを通過・対応表の落ちが 0・試験の不一致が 0・未解決が 0・書けない要件が 0 |
| 部分案 | `partial` | 静的チェックを通過。ただし、書けない要件がある／未解決を残した |
| 失敗 | `none` | 静的チェックを通過した版が無い、または上限に触れて部分案の条件も満たさない |

```ts
import { decideOutcome } from "@musunest/factory";

decideOutcome({
  staticCheckPassed: true,
  correspondenceMisses: 0,
  testMismatches: 0,
  unresolved: 0,
  unwritableRequirements: 0,
  limitReached: false,
}); // { result: "pass", verdict: "full" }
```

## 5. 段の型（§1）

`src/pipeline.ts` は ① 要件にする 〜 ⑧ 納品物にする の**入力と出力の型だけ**を持つ。段の中身
（プロンプト・道具・記録）は次の Issue 以降である。

## 6. テスト（受入条件との対応）

```bash
pnpm --filter @musunest/factory test    # unit（このパッケージ）
pnpm check                              # リポジトリ全体（verify-parity → lint → typecheck → test → tf）
```

| 受入条件（Issue #278） | 担保するテスト |
|---|---|
| `pnpm --filter @musunest/factory test` が exit 0 | 下の 4 本（`src/*.test.ts`） |
| 残高を超える呼び出しは予約できない／usage で精算される／usage が無ければ予約が残る | `src/budget.test.ts`「費用の予約」 |
| 3 つの結果それぞれの条件と、境目（未解決が 1 つでもあれば合格にならない・静的チェックを通った版が無ければ失敗） | `src/outcome.test.ts`「終わりの判定」 |
| 記録した応答と usage を順に返し、記録が尽きたら誤りになる | `src/llm-fake.test.ts`「偽物の LlmClient」 |
| 依存が `@musunest/spec-engine` と `@musunest/appspec-schema` だけで、依存の向きの検査が通る | `pnpm lint`（`infra/scripts/check-deps.mjs`）＋ `package.json`・`tsconfig.json` |
| `pnpm check` が exit 0 | リポジトリのゲート（`.commandmate/verify.yaml`） |

- **試験は偽物の `LlmClient` で閉じる。** 実 API は呼ばない（課金しない）。`src/index.test.ts` が、
  ライブラリのソースに外部の LLM の API と Cloudflare・Node 固有の入口が無いことを走査して確かめる
