// 比較元のバイトの記録を取る道具（v1.1α A6'。`07-architecture-v1.1a.md` §3・Issue #506）。
//
// v1.1α は v1 の段（⑤b・⑥ の道具・版の再検査・納品物）に**任意の差し込み口**を足す。省けば v1 の振る舞い・
// 要求・出力がバイト列で同じであることを、**凍結した比較元（main `2cd1586`）から取った記録**と照らして
// 確かめる。この道具は、工場の module（export の集合）を**引数で受け**、合成の経路の定義で `runGeneration` を
// 流し、観測した値を JSON の値にして返す純粋な関数である：
//
//   - 要求の全体（adapter に渡す構造化出力・道具付きの要求の列。締切の合図 `signal` は値を持たないので、
//     有無だけを残す）
//   - 結び付けの結果（納品物の固定した試験・対応表・提出された対応を、その module の `bindTests` に通したもの）
//   - 道具の結果（道具付きの要求の履歴に返した、道具の出力の列）
//   - 納品物の全ファイルの SHA-256 と大きさ・manifest、診断のファイルの SHA-256 と大きさ
//   - 判定（`outcome`・`stopped`・差し戻し・段の記録・要約）
//
// **ファイルも環境変数も触らない。** 本物のモデル・API・鍵は使わない——応答は経路の定義に書いた合成の応答を、
// その module の偽物の LlmClient（`createFakeLlmClient`）が返し、時計は 0 に固定する。同じ module と同じ
// 定義からは、同じ値が出る。比較元の記録は、凍結した比較元の checkout を build した dist の module に
// この道具を当てて取る（手順は記録の fixture の先頭の欄）。
import { sha256Hex } from "@musunest/spec-engine";
import type * as FactoryIndex from "../index.js";

/** 道具が使う、工場の module の export（比較元の dist と候補の src のどちらでも同じ名前で引く） */
export type BaselineFactoryModule = Pick<
  typeof FactoryIndex,
  "runGeneration" | "createFakeLlmClient" | "bindTests" | "bundleFiles" | "AGENT_LIMITS"
>;

/** 経路の定義に書く、生成の入力のうち経路に依らない欄（題材は抽象的なもの） */
export interface BaselineRunBase {
  readonly source: string;
  readonly documents: readonly { readonly name: string; readonly text: string }[];
  readonly budgetUsd: number;
  readonly rates: { readonly inputPerToken: number; readonly cachedInputPerToken: number; readonly outputPerToken: number };
  readonly deadline: number;
  readonly runId: string;
  readonly storageUnit: string;
  readonly builder: string;
  readonly model: string;
  readonly effort: string;
  readonly promptVersion: string;
  readonly contractVersion: string;
  readonly specEngineVersion: string;
  readonly factoryVersion: string;
}

/** 1 つの経路の定義（合成の応答と、経路ごとの入力） */
export interface BaselineScenario {
  readonly name: string;
  /** 偽物の LlmClient が順に返す、合成の応答 */
  readonly recorded: readonly unknown[];
  /** 確定した仕様（差し戻しの経路で使う） */
  readonly plan?: unknown;
  /** 設計の契約の版（省けば新契約） */
  readonly designVersion?: string;
  /** 上限の一部の上書き（module の `AGENT_LIMITS` に重ねる） */
  readonly limits?: Readonly<Record<string, number>>;
}

/** 経路の定義の全体（`scenarios.json`） */
export interface BaselineScenarios {
  readonly base: BaselineRunBase;
  readonly scenarios: readonly BaselineScenario[];
}

/** 1 つの経路で観測した値（JSON の値） */
export interface BaselineCapture {
  readonly name: string;
  readonly requests: readonly unknown[];
  readonly bindings: unknown;
  readonly toolResults: readonly unknown[];
  readonly bundle: {
    readonly files: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[];
    readonly manifest: unknown;
  } | null;
  readonly diagnostics: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[];
  readonly judgment: {
    readonly outcome: unknown;
    readonly stopped: unknown;
    readonly returnToPlan: boolean | null;
    readonly stages: unknown;
    readonly summary: unknown;
  };
}

type GenerationInput = Parameters<BaselineFactoryModule["runGeneration"]>[0];
type RecordedCall = Parameters<BaselineFactoryModule["createFakeLlmClient"]>[0][number];
type LlmClient = GenerationInput["client"];

/** 文字列の UTF-8 のバイト列の SHA-256（16 進）と大きさ（spec-engine の `sha256Hex`。Worker でも Node でも動く） */
async function digestOf(text: string): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  return { sha256: await sha256Hex(text), sizeBytes: new TextEncoder().encode(text).length };
}

/** 要求から締切の合図（`signal`。値を持たない）を外し、有無だけを残す */
function requestRecord(kind: "structured" | "tools", request: object): unknown {
  const { signal, ...rest } = request as { readonly signal?: unknown };
  return { kind, hasSignal: signal !== undefined, request: rest };
}

/** JSON の値にそろえる（`undefined` の欄を落とす。記録の fixture と同じ形で比べるため） */
function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 成果物の並びから、path の JSON を読む（無ければ undefined） */
function readJson(files: readonly { readonly path: string; readonly text: string }[], path: string): unknown {
  const found = files.find((file) => file.path === path);
  return found === undefined ? undefined : (JSON.parse(found.text) as unknown);
}

/**
 * 納品物の材料（固定した試験・対応表・提出された対応）を、その module の `bindTests` に通す。
 * 納品物が無い（早期停止）ときは `null`。
 */
function bindingsOf(
  factory: BaselineFactoryModule,
  artifacts: readonly { readonly path: string; readonly text: string }[] | null,
): unknown {
  if (artifacts === null) return null;
  const suite = (readJson(artifacts, "artifacts/test-suite.json") as { readonly suite: unknown }).suite;
  const correspondence = readJson(artifacts, "artifacts/correspondence.json");
  const mappings = (readJson(artifacts, "artifacts/mappings.json") as { readonly mappings: unknown }).mappings;
  if (correspondence === null) return null;
  return factory.bindTests({
    suite,
    correspondence,
    mappings,
  } as Parameters<BaselineFactoryModule["bindTests"]>[0]);
}

/** 道具付きの要求の履歴から、道具の出力を順に集める（同じ呼び出しの ID は 1 度だけ） */
function toolResultsOf(tools: readonly { readonly turns: readonly unknown[] }[]): readonly unknown[] {
  const seen = new Set<string>();
  const results: unknown[] = [];
  for (const request of tools) {
    for (const turn of request.turns as readonly { readonly role: string; readonly results?: readonly { readonly toolCallId: string }[] }[]) {
      if (turn.role !== "tool") continue;
      for (const result of turn.results ?? []) {
        if (seen.has(result.toolCallId)) continue;
        seen.add(result.toolCallId);
        results.push(result);
      }
    }
  }
  return results;
}

/** 1 つの経路を流し、観測した値を返す */
export async function captureScenario(
  factory: BaselineFactoryModule,
  base: BaselineRunBase,
  scenario: BaselineScenario,
): Promise<BaselineCapture> {
  const inner = factory.createFakeLlmClient(scenario.recorded as readonly RecordedCall[]);
  const requests: unknown[] = [];
  const tools: { readonly turns: readonly unknown[] }[] = [];
  const client: LlmClient = {
    async callStructured(request) {
      requests.push(requestRecord("structured", request));
      return inner.callStructured(request);
    },
    async callWithTools(request) {
      requests.push(requestRecord("tools", request));
      tools.push({ turns: [...request.turns] });
      return inner.callWithTools(request);
    },
  };
  const input = {
    ...base,
    client,
    now: () => 0,
    ...(scenario.plan === undefined ? {} : { plan: scenario.plan }),
    ...(scenario.designVersion === undefined ? {} : { designVersion: scenario.designVersion }),
    ...(scenario.limits === undefined ? {} : { limits: { ...factory.AGENT_LIMITS, ...scenario.limits } }),
  } as GenerationInput;
  const result = await factory.runGeneration(input);

  const files = result.bundle === null ? null : factory.bundleFiles(result.bundle);
  const bundle =
    result.bundle === null || files === null
      ? null
      : {
          files: await Promise.all(files.map(async (file) => ({ path: file.path, ...(await digestOf(file.text)) }))),
          manifest: result.bundle.manifest,
        };
  const diagnostics = await Promise.all(
    result.diagnostics.map(async (file) => ({ path: file.path, ...(await digestOf(file.text)) })),
  );
  return toJsonValue({
    name: scenario.name,
    requests,
    bindings: bindingsOf(factory, result.bundle === null ? null : result.bundle.artifacts),
    toolResults: toolResultsOf(tools),
    bundle,
    diagnostics,
    judgment: {
      outcome: result.outcome,
      stopped: result.stopped,
      returnToPlan: result.returnToPlan ?? null,
      stages: result.record.stages,
      summary: result.summary,
    },
  });
}

/** 経路の定義の全部を順に流す（1 つの経路ごとに新しい偽物の LlmClient を使う） */
export async function captureBaseline(
  factory: BaselineFactoryModule,
  definitions: BaselineScenarios,
): Promise<readonly BaselineCapture[]> {
  const captures: BaselineCapture[] = [];
  for (const scenario of definitions.scenarios) {
    captures.push(await captureScenario(factory, definitions.base, scenario));
  }
  return captures;
}
