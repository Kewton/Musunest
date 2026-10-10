// 本物の応答の再生の試験（Issue #322）。
//
// 2026-10-10 の疎通で、本物の OpenAI が返した応答の記録（7 回分。第 0 段の「読書会」の題材）を、偽物の
// LlmClient の記録として写し、① から ⑦ まで流し直す。段ごとの試験は通るのに、本物の応答で流すとつなぎの
// 抜けが見つかることが続いたので、記録を再生して手元で捕まえられるようにする。
//
// **実 API は呼ばない。** 記録した応答を返す偽物（llm-fake.ts）で閉じる。記録は応答の中身と usage だけで、
// 鍵や依頼者の情報は含まない。記録の写しは `__fixtures__/smoke-reading-club/responses.json` と `request.md`。
// **Issue #332 で、設計の段（② `requirement-design`）の応答だけを新しい形**（`unwritable` の要素を「部分・
// 制約 ID・理由」の組にし、`notes` を足す）**に手で直した**——直した箇所と理由は同ディレクトリの
// `CHANGES.md` にある。**ほかの段の応答は変えていない。** 手直しの後の**ファイル全体**のバイト列を、
// SHA-256 の試験で固定する。
//
// **1 回分だけ手で書いた応答が要る。** ③ が提出した対応の名前（dashboard）は宣言に実在するが、⑤a の
// 対応表の R-1 の場所に無い。だから ⑤a のやり直しが 1 回増える（Issue #322 の直し 3）。記録は ③ の
// やり直しの応答（role-name-mappings）で終わっているので、そのままでは ⑤a のやり直しの呼び出しで尽きる。
// 手で書いた ⑤a のやり直しの応答は、**記録とは別のファイル（この file）**に置く（記録の responses.json は
// この応答を含まない）。記録の ⑤a の応答に、要件 R-1 の場所としてダッシュボードを足したものである。
//
// **結果は部分案（partial）**である。記録の設計は、要件 R-1 の「アプリ自体の名前・説明」を書けない
// （`unwritable`）と正しく申告している。`02-architecture.md` §1.4 により、書けない要件があれば部分案に
// なる（つなぎの抜け——試験の不一致・未解決・対応表の落ち——は 0 である）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeRunInput } from "./__tests__/run.js";
import { UNWRITABLE_FILE, VERIFICATION_FILE, type BundleUnwritable, type BundleVerification } from "./bundle.js";
import type { RecordedCall } from "./llm-fake.js";
import type { LlmUsage } from "./llm.js";
import { runGeneration } from "./run.js";
import { createRecordingClient } from "./stages/__tests__/prompt.js";
import { MAPPING_REDO_SCHEMA_NAME } from "./stages/repair.js";

/** 記録を読むための最小の file system（Node の型に依らない。index.test.ts と同じ手） */
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 写した記録（responses.json）のバイト列の SHA-256。**設計の段の応答だけを手で直した後の**値である */
const RECORDING_SHA256 = "dd6e55ad29754c516294da53b17781958c71400c16fe8c4c63941c883c6bdeee";

const fixtureUrl = (name: string): URL => new URL(`./__fixtures__/smoke-reading-club/${name}`, import.meta.url);

/** 記録の原文（request.md）。① の引用の実在・位置は、この原文と突き合わせられる */
const REQUEST = fs.readFileSync(fixtureUrl("request.md"), "utf8");
/** 記録（responses.json）の本文。**設計の段の応答だけを手で直したもの**（SHA-256 の試験で確かめる） */
const RECORDING_TEXT = fs.readFileSync(fixtureUrl("responses.json"), "utf8");

/** 記録した 1 回（OpenAI の Responses API の形。中身と usage だけを使う） */
interface RawResponse {
  readonly call: string;
  readonly schema: string;
  readonly output: readonly {
    readonly type: string;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
  }[];
  readonly usage: {
    readonly input_tokens: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
    readonly output_tokens: number;
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  };
}

const RECORDED = JSON.parse(RECORDING_TEXT) as readonly RawResponse[];

/** 記録した 1 回の構造化出力（`message` の `output_text` を読む） */
function recordedOutput(response: RawResponse): unknown {
  const message = response.output.find((item) => item.type === "message");
  const text = message?.content?.find((item) => item.type === "output_text")?.text;
  if (text === undefined) throw new Error(`記録 ${response.call} に構造化出力の本文がありません`);
  return JSON.parse(text);
}

/** 記録した usage を、共通の型（LlmUsage）に写す */
function recordedUsage(response: RawResponse): LlmUsage {
  return {
    inputTokens: response.usage.input_tokens,
    cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
    reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** 記録した 1 回の応答（ある schema）を探す */
function recordedBySchema(schema: string): RawResponse {
  const found = RECORDED.find((response) => response.schema === schema);
  if (found === undefined) throw new Error(`記録に ${schema} の応答がありません`);
  return found;
}

/** 記録を、偽物の LlmClient が返す形（構造化出力の並び）にする */
const recordedCalls = (): readonly RecordedCall[] =>
  RECORDED.map((response) => ({
    kind: "structured",
    output: recordedOutput(response),
    usage: recordedUsage(response),
  }));

/**
 * **手で書いた** ⑤a のやり直しの応答（記録とは別。この file に置く）。記録の ⑤a の応答に、要件 R-1 の
 * 場所としてダッシュボード（宣言に実在する一覧）を足したものである（Issue #322 の直し 3 で、⑤a の
 * やり直しが 1 回増えるため）。
 */
function handWrittenCorrespondenceRedo(): RecordedCall {
  const recorded = recordedBySchema("requirement-correspondence");
  const output = recordedOutput(recorded) as {
    readonly entries: readonly { readonly requirementId: string; readonly locations: readonly unknown[] }[];
  };
  return {
    kind: "structured",
    output: {
      entries: output.entries.map((entry) =>
        entry.requirementId === "R-1"
          ? { requirementId: "R-1", locations: [{ kind: "view", entity: null, name: "dashboard" }] }
          : entry,
      ),
    },
    usage: undefined,
  };
}

/** 記録の設計が「書けない（unwritable）」と申告した要件（空の申告は除く。新しい形の部分だけ） */
function recordedUnwritable(): readonly {
  readonly requirementId: string;
  readonly unwritable: readonly string[];
}[] {
  const design = recordedBySchema("requirement-design");
  const output = recordedOutput(design) as {
    readonly designs: readonly {
      readonly requirementId: string;
      readonly unwritable: readonly { readonly part: string }[];
    }[];
  };
  return output.designs
    .filter((entry) => entry.unwritable.length > 0)
    .map((entry) => ({
      requirementId: entry.requirementId,
      unwritable: entry.unwritable.map((claim) => claim.part),
    }));
}

const verificationOf = (
  bundle: { readonly artifacts: readonly { readonly path: string; readonly text: string }[] } | null,
): BundleVerification => {
  if (bundle === null) throw new Error("納品物がありません");
  const found = bundle.artifacts.find((artifact) => artifact.path === VERIFICATION_FILE);
  if (found === undefined) throw new Error("検証の結果がありません");
  return JSON.parse(found.text) as BundleVerification;
};

/** 納品物から、書けなかった要件の一覧（`artifacts/unwritable.json`）を読む（Issue #326） */
const unwritableOf = (
  bundle: { readonly artifacts: readonly { readonly path: string; readonly text: string }[] } | null,
): BundleUnwritable => {
  if (bundle === null) throw new Error("納品物がありません");
  const found = bundle.artifacts.find((artifact) => artifact.path === UNWRITABLE_FILE);
  if (found === undefined) throw new Error("書けなかった要件の一覧がありません");
  return JSON.parse(found.text) as BundleUnwritable;
};

/** 記録の並びで、① から ⑦ まで流す（原文は記録の request.md を使う）。受け取った要求も残す */
function runReplay(calls: readonly RecordedCall[]) {
  const recording = createRecordingClient(calls);
  return { recording, run: runGeneration(makeRunInput(recording.client, { source: REQUEST })) };
}

describe("本物の応答の再生（Issue #322）", () => {
  it("写した記録は、設計の段の応答だけを手で直した後のバイト列のままである", () => {
    const hash = createHash("sha256").update(RECORDING_TEXT).digest("hex");
    expect(hash).toBe(RECORDING_SHA256);
  });

  it("記録と、手で足した ⑤a のやり直しの応答 1 回分で、① から ⑦ まで流すと、部分案（partial）になる", async () => {
    const { recording, run } = runReplay([...recordedCalls(), handWrittenCorrespondenceRedo()]);
    const result = await run;

    // 早期停止はしない（① から ⑦ まで通る）
    expect(result.stopped).toBeNull();
    expect(result.bundle).not.toBeNull();

    // つなぎの抜けは 0：試験の不一致・未解決・対応表の落ち・未実行の検査
    const verification = verificationOf(result.bundle);
    expect(verification.correspondence_misses).toBe(0);
    expect(verification.test_mismatches).toBe(0);
    expect(verification.test_unresolved).toBe(0);
    expect(verification.unexecuted_inspections).toEqual([]);

    // 結果は部分案。その理由は、設計が要件 R-1 の「アプリ自体の名前・説明」を書けないと申告したことだけ
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(verification.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(recordedUnwritable()).toEqual([{ requirementId: "R-1", unwritable: ["アプリ自体の名前・説明"] }]);

    // #326：記録の設計が書けないと申告した要件 R-1 が、納品物の「書けなかった要件の一覧」に出る
    // （要件の文と引用は ① の記録から写す）
    const list = unwritableOf(result.bundle);
    expect(list.unwritable).toEqual([
      {
        requirementId: "R-1",
        text: "読書会の記録アプリを作成する。",
        quote: "読書会の記録アプリを作ってください。",
        unwritable: ["アプリ自体の名前・説明"],
      },
    ]);
    // 一覧も、検証の結果と同じ宣言の版（SHA-256）に結び付いている
    expect(list.declaration_sha256).toBe(verification.declaration_sha256);

    // ⑤a のやり直しが走る（③ のやり直しは走らない）。⑥ 直すにも入らない
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages.filter((stage) => stage === "correspondence").length).toBeGreaterThanOrEqual(2);
    expect(stages).not.toContain("repair");
    expect(recording.structured.every((request) => request.schemaName !== MAPPING_REDO_SCHEMA_NAME)).toBe(true);
  });

  it("手で足した応答を除いた記録だけで流すと、⑤a のやり直しで記録が尽きる", async () => {
    const { run } = runReplay(recordedCalls());
    const result = await run;

    // 合格にはならない。⑤a のやり直しの呼び出しで、記録した応答が尽きる
    expect(result.outcome.result).not.toBe("pass");
    expect(result.stopped?.stage).toBe("correspondence");
    expect(result.bundle).toBeNull();
  });
});
