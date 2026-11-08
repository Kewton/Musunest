// @musunest/factory —— OpenAI の Responses API の adapter（02-architecture.md §2・§2.1・§2.2）。
//
// 共通の契約の `LlmClient`（llm.ts）を、**`fetch` だけ**で実装する。手元でも Worker でも同じものが
// 動くように、Cloudflare 固有の API も Node 固有の API も使わない。**API キーを扱うのはここだけ**で、
// **環境変数は読まない**（読むのは手元の入口。別の Issue。§2.1・R-15）。
//
// 決めごと（§2・§2.2）：
//   * 構造化出力は Responses API の JSON Schema の出力（`text.format`）、道具付きは function calling。
//   * どちらも `store: false` と `max_output_tokens` を必ず送る。
//   * 推論の effort（`reasoning`）は、構造化と道具付きのどちらの要求も、effort があればそれ（段の名前で引いた口が載せる。
//     Issue #664・#751）、無ければ設定の値を送る。
//   * 規則（`instructions`）は**毎回**送る。会話はこちらで組み立てて `input` に並べる
//     （`previous_response_id` は送らない。§2 の「会話の状態」）。
//   * 依頼文などのデータは、規則とは別の入力として `<data>` で囲んで送る（§2.2「規則とデータを分ける」）。
//   * プロンプトのキャッシュは**明示の breakpoint**で当てる（`prompt_cache_options.mode = explicit`）。
//     文書の**最後のブロック**にだけ `prompt_cache_breakpoint` を付け、段ごとの指示（`rules`）は
//     文書の後ろの **developer** のメッセージに置く——上の `instructions` には breakpoint を置けない。
//     これで前置き（共通の規則と文書）が全段で同じになり、データが違っても当たる（#342・§2）。
//   * **構造化出力は、全段で同じ「封筒」の schema を送る**（`schema-envelope.ts`・#353）。出力の schema は
//     入力より前に置かれるので、段ごとに違うと前置きが別物になり、段をまたいでキャッシュが当たらない。
//     封筒の枝は `stage` の判別子で選び、応答の `result` を取り出して段へ渡す（`stage` が違えば形の誤り）。
//     封筒は options の `envelope` で選ぶ（既定 v1。v1.1α の段は別の封筒 `stage-envelope-v11a`。Issue #511。
//     経路 v1.2 の走りは旗の組から導いた封筒 `stage-envelope-v12` を全段で送る。Issue #588）。
//   * usage を共通の契約の形に直す。無い・壊れている（数でない・負・内訳が合計を超える）ときは
//     「usage なし」として返し、共通の口に予約を残させる（§1.5・R-6）。
//   * 誤りは型付きで分類する（`OpenAiAdapterError` の `kind`）。
//     HTTP の誤り（状態コード付き）・timeout・拒否・**未完了の応答**・形が合わない応答・
//     道具の引数が JSON として読めない・残高切れ。**JSON として読めても未完了の応答は成功にしない。**
import { callTimeoutMsForEffort } from "./limits.js";
import { validateSchema } from "./schema-check.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolRequest,
  LlmToolResponse,
  LlmTurn,
  LlmUsage,
  MalformedKind,
} from "./llm.js";
import {
  ENVELOPE_RESULT_KEY,
  ENVELOPE_STAGE_KEY,
  buildStageBranch,
  resolveStageEnvelope,
  type EnvelopeId,
  type ResolvedStageEnvelope,
  type StageEnvelopeEntry,
} from "./schema-envelope.js";

/** Responses API の既定のモデル（§2 の表「モデル」） */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

/**
 * usage のうち、キャッシュの**書き込み**のトークンを必ず持つ形（#302・#342）。共通の契約（`LlmUsage`）は
 * 書き込みの欄を任意にしている（古い記録を止めない）ので、wire から読んで必ず付ける adapter はここで必須にする。
 */
export interface OpenAiUsage extends LlmUsage {
  /** 入力のうち、キャッシュへ書き込んだトークン（wire に欄が無ければ 0） */
  readonly cacheWriteTokens: number;
}

/** Responses API の入口（1 か所に固定する。環境変数からは読まない） */
const RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * プロンプトのキャッシュの振り分けの鍵（`prompt_cache_key`）。**全段で同じ値**を送る——
 * 規則（共通の規則）と文書を入力の先頭に固定し、前置きを全段で同じにしたうえで、同じ鍵へ寄せる（§2）。
 */
export const OPENAI_PROMPT_CACHE_KEY = "musunest-factory";

/**
 * `extraBody` で受け付けない予約名（Issue #788）。**今の body が持ちうる欄の名前の全部**——要求によって省かれる欄
 * （`reasoning`・`text`・`tools`・`tool_choice`）も含む。`baseBody`・`buildStructuredBody`・`buildToolBody` が置く欄である。
 */
export const RESPONSES_BODY_RESERVED_KEYS: readonly string[] = [
  "model",
  "store",
  "max_output_tokens",
  "instructions",
  "prompt_cache_key",
  "prompt_cache_options",
  "input",
  "reasoning",
  "text",
  "tools",
  "tool_choice",
];

/** fetch の差し替え口。Workers・ブラウザ・Node のどれでも同じ形で呼べる範囲だけを要求する（§2.1） */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * adapter の誤りの種類（§2.2「拒否・不完全な応答」・§1.5・R-15）。呼ぶ側（共通の口・段）が
 * 「やり直すか・失敗にするか」を種類で分けられるようにする。
 */
export type OpenAiErrorKind =
  /** fetch 自体が失敗した（応答が返らなかった） */
  | "network"
  /** 呼び出しごとの timeout で打ち切った */
  | "timeout"
  /** HTTP の誤り（状態コード付き） */
  | "http"
  /** 要求そのものが不正（HTTP 400 など）。**同じ要求ではやり直しても通らない** */
  | "invalidRequest"
  /** 残高切れ（`insufficient_quota`） */
  | "balance"
  /** モデルが拒否した */
  | "refusal"
  /** 未完了の応答（`status` が完了でない・出力の上限で切れた） */
  | "incomplete"
  /** 形が合わない応答（JSON でない・schema に合わない・必須の欄が無い） */
  | "malformed"
  /** 道具の引数が JSON として読めない */
  | "toolArguments";

/** adapter が投げる型付きの誤り（§2.2）。`kind` で分類し、HTTP の誤りは `status` を持つ */
export class OpenAiAdapterError extends Error {
  readonly kind: OpenAiErrorKind;
  /** HTTP の誤りの状態コード（それ以外は `undefined`） */
  readonly status: number | undefined;
  /** 要求が不正なときの API の誤りの種類（例: `invalid_json_schema`）。無ければ `undefined` */
  readonly code: string | undefined;
  /**
   * 構造化出力の本文を形の誤り（`malformed`）とした種類の印（Issue #783）。**構造化出力の口**
   * （`callStructuredWire`）で今の検査の順のまま付ける。付かない `malformed`（道具付きの要求の呼び出しの形・
   * wire の JSON・外側・status の欠落・宣言の口）は `undefined`（共通の口が `other` として数える）。
   */
  readonly malformedKind: MalformedKind | undefined;

  constructor(kind: OpenAiErrorKind, message: string, status?: number, code?: string, malformedKind?: MalformedKind) {
    super(message);
    this.name = "OpenAiAdapterError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.malformedKind = malformedKind;
  }
}

/** 構造化出力の本文の形の誤りを、種類の印つきで投げる（Issue #783。共通の口がこの印を数える） */
function malformedWire(malformedKind: MalformedKind, message: string): OpenAiAdapterError {
  return new OpenAiAdapterError("malformed", message, undefined, undefined, malformedKind);
}

/**
 * 未完了の応答（`status` が完了でない・出力の上限で切れた。§2.2・§1.5）。
 *
 * 未完了でも **usage は付くことがある**——共通の口（call.ts）が、成功と同じように実際の費用で
 * 予約を精算できるように、理由と usage を持たせる。**出力の上限で切れた応答は、同じ要求で
 * やり直しても同じところで切れる**ので、共通の口は同じ要求のままやり直さない。
 */
export class OpenAiIncompleteError extends OpenAiAdapterError {
  /** 未完了の理由（`incomplete_details.reason`。例: `max_output_tokens`）。無ければ空文字 */
  readonly reason: string;
  /** 未完了でも付く usage。無ければ `undefined`（共通の口が予約を残す） */
  readonly usage: LlmUsage | undefined;

  constructor(reason: string, usage: LlmUsage | undefined, message: string) {
    super("incomplete", message);
    this.name = "OpenAiIncompleteError";
    this.reason = reason;
    this.usage = usage;
  }
}

/** adapter を作る関数の引数（Issue #284「やること」1） */
export interface OpenAiAdapterOptions {
  /** API キー。**環境変数からは読まない**。呼ぶ側（手元の入口）が渡す */
  readonly apiKey: string;
  /** モデル（既定 `gpt-6-luna`。§2） */
  readonly model?: string;
  /** 推論の effort（§2「品質優先で high から始める」）。渡さなければ送らない */
  readonly effort?: string;
  /** 差し込む `fetch`（既定 `globalThis.fetch`。§2.1） */
  readonly fetch?: FetchLike;
  /**
   * 呼び出しごとの timeout（ミリ秒）。指定しなければ effort から出す（`callTimeoutMsForEffort`）。
   * **合図（`signal`）が渡されたときは使わない**——呼ぶ側（共通の口）が呼び出しごとの timeout を
   * 持ち、締切の残りで頭を打つ（#302）。
   */
  readonly timeoutMs?: number;
  /**
   * 構造化出力で送る封筒（`schema-envelope.ts`。既定 v1）。v1.1α の走りでは `"v1.1a"`、v1.2 の走りでは
   * `"v1.2"` を渡す（Issue #511・#588）。
   * 選んだ封筒に載っていない schema（判定の口・差分専用の schema）は、今までどおりそのまま送る。
   */
  readonly envelope?: EnvelopeId;
}

/**
 * Responses API 互換の adapter を作る設定（Issue #771）。`openai.ts` と `ollama.ts` が共有する。
 * 宛先と「schema を文で示すか」だけを差し替え、要求の組み立て・応答の解釈・誤りの分類は同じ実装を使う。
 */
export interface ResponsesAdapterOptions extends OpenAiAdapterOptions {
  /** 固定の宛先（環境変数からは読まない） */
  readonly url: string;
  /**
   * 段の指示（`developer`）の最後に、JSON Schema の塊を 1 つ足すか（既定は足さない）。
   * Ollama の Responses API は `text.format` の JSON Schema で応答を縛らないので、形を要求の文でも伝える。
   */
  readonly presentSchema?: boolean;
  /**
   * 応答の本文が 1 組の囲み（```` ``` ```` … ```` ``` ````）で包まれているとき、中身を JSON として読むか
   * （既定は読まない）。Ollama の Responses API は、この条件で本文を囲みで返すことがある（Issue #777）。
   * **構造化出力の本文と、道具付きの要求の最後の答え（`done`）の本文だけ**に効く——道具の引数と wire の
   * JSON の読み方は変えない。囲みの規則に合わない本文（囲みの外に文字・囲みが 2 組以上・中身が JSON でない）は
   * 今のとおり `malformed` にする。
   */
  readonly readFencedJson?: boolean;
  /**
   * 最後の答えだけを求める印（`finalAnswerOnly`）のある道具付きの要求で、body から `tools` と `tool_choice` を
   * 外すか（既定は外さない）。Ollama では `tool_choice: "none"` が効かない応答がある（Issue #777）。
   * 印の無い要求の body は今のまま（道具の定義を送り、`tool_choice` は送らない）。
   */
  readonly finalAnswerWithoutTools?: boolean;
  /**
   * 封筒の段の構造化出力の要求だけ、`text.format.schema` を「外側の `result` の下にその段の枝
   * （`buildStageBranch`）を 1 つだけ置いた、その段だけの封筒全体」にするか（既定はしない。Issue #790）。
   * on にすると、**送る schema の上でも**その段の枝だけが正解になり、形の似た別の段の枝が選ばれにくくなる
   * （提供元が strict の schema を応答の生成に強く効かせる場合。OpenRouter の fp8 の走りで使う）。`text.format.name`
   * は今の封筒の名前のまま。**封筒の無い段・道具付きの要求・判定の口の要求は変えない**。off のとき body は
   * バイト列で今と同じ（OpenAI・Ollama の要求を変えない）。
   */
  readonly stageOnlyEnvelope?: boolean;
  /**
   * body を組み終えた**後（送る直前）に末尾へ足す固定の欄**（Issue #788）。渡さなければ body は今とバイト列で同じ。
   * 値は **JSON の値だけ**（再帰的に検査する）で、client を作るときに複製して固定する。**関数・`undefined`・
   * `bigint`・`symbol`・有限でない数・変換の口（`toJSON`）を持つ値**、**予約名**（今の body が持ちうる欄の
   * 名前の全部＝`RESPONSES_BODY_RESERVED_KEYS`）、JSON の列挙で先頭に来る整数の形の名前は受けず、client を
   * 作るときに投げる（fetch は 0 回）。`__proto__` は正当な JSON の名前として、値と末尾の位置を保って足す。
   * 構造化出力と道具付き（通常・`finalAnswerOnly`）のどちらの要求にも、同じ規則で足す。
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

interface WireConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly effort: string | undefined;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly envelope: EnvelopeId;
  readonly url: string;
  readonly presentSchema: boolean;
  readonly readFencedJson: boolean;
  readonly finalAnswerWithoutTools: boolean;
  /** 封筒の段の `text.format.schema` をその段の枝 1 つだけにするか（Issue #790） */
  readonly stageOnlyEnvelope: boolean;
  /** body の末尾へ足す固定の欄（複製して固定済み。渡さなければ `undefined`。Issue #788） */
  readonly extraBody: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Responses API 互換の `LlmClient` を作る（Issue #771）。宛先と schema の提示だけを設定で受け、
 * それ以外は OpenAI の Responses API の実装をそのまま使う。
 * `fetch` を差し込めるので、試験は実 API を呼ばずに要求の中身を観測できる。
 */
export function createResponsesLlmClient(options: ResponsesAdapterOptions): LlmClient {
  const request = options.fetch ?? globalThis.fetch;
  if (request === undefined) {
    throw new Error("fetch がありません。options.fetch で渡してください");
  }
  const config: WireConfig = {
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_OPENAI_MODEL,
    effort: options.effort,
    fetch: request,
    // 合図（signal）が渡されたときは使わない（呼ぶ側が timeout を持つ）。渡されないときの既定は、
    // 固定の 60 秒ではなく effort ごとの値にする（#302）。
    timeoutMs: options.timeoutMs ?? callTimeoutMsForEffort(options.effort ?? ""),
    envelope: options.envelope ?? "v1",
    url: options.url,
    presentSchema: options.presentSchema === true,
    readFencedJson: options.readFencedJson === true,
    finalAnswerWithoutTools: options.finalAnswerWithoutTools === true,
    // 封筒の段の schema をその段の枝 1 つだけにするか（既定 off。off は今とバイト列で同じ。Issue #790）
    stageOnlyEnvelope: options.stageOnlyEnvelope === true,
    // 予約名・整数の形の名前を弾いてから複製して固定する（作るときに投げる。fetch は 0 回。Issue #788）
    extraBody: prepareExtraBody(options.extraBody),
  };
  return {
    callStructured: <T>(structuredRequest: LlmStructuredRequest) =>
      callStructuredWire<T>(config, structuredRequest),
    callWithTools: (toolRequest: LlmToolRequest) => callToolsWire(config, toolRequest),
  };
}

/**
 * OpenAI の Responses API に対する `LlmClient` を作る（§2.1）。共有の実装の薄い包みで、
 * 宛先は今の値・schema の提示は無し（body はバイト列で今までと同じ）。Issue #771。
 */
export function createOpenAiLlmClient(options: OpenAiAdapterOptions): LlmClient {
  return createResponsesLlmClient({ ...options, url: RESPONSES_URL, presentSchema: false });
}

/**
 * 整数の形の名前（JSON の列挙で先頭に来る＝末尾追加を破る）か（Issue #788）。
 * `"0"`・`"12"` は真、`"01"`・`"-1"`・`"1.5"`・`"x"` は偽。
 */
function isIntegerFormKey(key: string): boolean {
  const value = Number(key);
  return Number.isInteger(value) && value >= 0 && String(value) === key;
}

/**
 * JSON の object として認めるもの（`null` の prototype か `Object.prototype` の **plain object だけ**）。
 * `Map`・`Set`・`Date`・`RegExp`・数の包み・クラスの実体などは JSON の値ではないので断る（Issue #788 レビュー 79C R1）。
 */
function isPlainJsonObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** その object が、名前の**own の関数**（`valueOf` などの変換の口）を持つか（Issue #788 レビュー 79C R1） */
function hasOwnFunctionHook(value: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name) && typeof (value as Record<string, unknown>)[name] === "function";
}

/**
 * 配列を、**入力の `map` も `Symbol.species` も呼ばずに**、新しい通常の配列へ**添字ごとに検査して複製**する
 * （Issue #788 レビュー 79C R1）。差し替えた `map` が関数を返して複製結果へ混ざる迂回を塞ぐ。
 * **穴**（`!(index in value)`）は JSON の値ではないので断る（client を作るとき。fetch 0 回）。
 */
function cloneJsonArray(value: readonly unknown[], path: string): unknown[] {
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) throw new Error(`extraBody の ${path}[${index}] に空きの添字があります`);
    copy.push(cloneJsonValue(value[index], `${path}[${index}]`));
  }
  return copy;
}

/**
 * `extraBody` の値を、**JSON の値の範囲**で再帰的に検査しながら複製する（Issue #788 レビュー R1・79C R1）。
 * 関数・`undefined`・`bigint`・`symbol`・有限でない数（`NaN`・`Infinity`）・変換の口（`toJSON`・own の
 * `valueOf`）を持つ値、JSON でない型（`Map`・`Set`・`Date`・`RegExp` など）は受けず、client を作るときに
 * 投げる（fetch 0 回）。`JSON.stringify` で欄が黙って消える・数が `null` に変わる・変換の口で鍵がすり替わる、
 * という迂回を塞ぐ。
 *
 * 配列は入力の `map`／species を呼ばず添字ごとに複製する（79C R1）。`__proto__` は予約名でも整数の形の
 * 名前でもない**正当な JSON の名前**なので、代入（setter を通して欄が消える）ではなく **own の data
 * property** として定義して保つ（レビュー R2）。
 */
function cloneJsonValue(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`extraBody の ${path} に有限でない数は渡せません`);
      return value;
    case "function":
      throw new Error(`extraBody の ${path} に関数は渡せません`);
    case "undefined":
      throw new Error(`extraBody の ${path} に undefined は渡せません`);
    case "bigint":
      throw new Error(`extraBody の ${path} に bigint は渡せません`);
    case "symbol":
      throw new Error(`extraBody の ${path} に symbol は渡せません`);
    default:
      break;
  }
  const record = value as Record<string, unknown> & { readonly toJSON?: unknown };
  if (typeof record.toJSON === "function" || hasOwnFunctionHook(value as object, "valueOf")) {
    throw new Error(`extraBody の ${path} に変換の口（toJSON・valueOf）を持つ値は渡せません`);
  }
  if (Array.isArray(value)) {
    return cloneJsonArray(value, path);
  }
  if (!isPlainJsonObject(value as object)) {
    throw new Error(`extraBody の ${path} に JSON でない型の値は渡せません`);
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    Object.defineProperty(clone, key, {
      value: cloneJsonValue(record[key], `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clone;
}

/** 値を深く凍らせる（複製した固定の欄が、あとから書き換わらないようにする。Issue #788） */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * `extraBody` を検査し、複製して固定する（Issue #788）。値は **JSON の値だけ**を再帰的に複製し
 * （`cloneJsonValue`）、**複製した後に実際に持つ鍵**へ予約名（`RESPONSES_BODY_RESERVED_KEYS`）と整数の形の
 * 名前の検査を当てる（変換の口は先に断るので、鍵は入力のまま。レビュー R1）。違反は client を作るときに
 * 投げる（fetch 0 回）。渡した値の複製を深く凍らせる（作るときの 1 回だけ）。
 */
function prepareExtraBody(
  extraBody: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (extraBody === undefined) return undefined;
  const clone = cloneJsonValue(extraBody, "extraBody") as Record<string, unknown>;
  const reserved = new Set(RESPONSES_BODY_RESERVED_KEYS);
  for (const key of Object.keys(clone)) {
    if (reserved.has(key)) throw new Error(`extraBody に予約名は渡せません: ${key}`);
    if (isIntegerFormKey(key)) throw new Error(`extraBody に整数の形の名前は渡せません: ${key}`);
  }
  return deepFreeze(clone);
}

/**
 * 組み終えた body の**末尾**に固定の欄を足す（送る直前。Issue #788）。予約名と整数の形の名前は作るときに
 * 弾いてあるので末尾に並ぶ。**object spread は `__proto__` も own の data property として写す**ので、
 * `Object.assign`（`__proto__` を prototype への代入として扱い欄が消える）と違って欄の名前・値・末尾の
 * 位置を保つ（レビュー R2）。渡さなければ body をそのまま返す。
 */
function applyExtraBody(
  body: Record<string, unknown>,
  extraBody: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (extraBody === undefined || Object.keys(extraBody).length === 0) return body;
  return { ...body, ...extraBody };
}

// ── 呼び出し（fetch と timeout。§1.5・§2.1）────────────────────────────────

/**
 * 1 回の実呼び出しをして、応答を object として返す。HTTP の誤りと、JSON でない本文をここで分類する。
 *
 * 打ち切りは 2 つの経路で起こる——自分の時計（`timeoutMs`）と、共通の口からの合図（`signal`）。
 * **合図が渡されたときは自分の時計を持たない**：呼び出しごとの timeout は呼ぶ側（共通の口）が持ち、
 * 締切の残りで頭を打ち、やり直しでは長くする（#302）。二重の時計があると、やり直しの timeout を
 * 伸ばせない。渡されないとき（adapter を単体で使うとき）だけ、自分で打ち切る。
 *
 * **合図（中断）は、本文を読み終えるまで保つ**（Issue #455）。ヘッダーを受けた時点で合図を外すと、
 * そのあと本文が止まったときに締切の中断が届かず、待ち続ける。読み終える（または失敗する）まで外さない。
 */
async function requestWire(
  config: WireConfig,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    signal === undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.timeoutMs)
      : undefined;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    let response: Response;
    try {
      response = await config.fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || signal?.aborted === true) {
        throw new OpenAiAdapterError("timeout", "呼び出しごとの timeout で打ち切りました");
      }
      throw new OpenAiAdapterError("network", `fetch が失敗しました: ${messageOf(error)}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (timedOut || signal?.aborted === true) {
        throw new OpenAiAdapterError("timeout", "呼び出しごとの timeout で打ち切りました");
      }
      throw new OpenAiAdapterError("network", `応答の本文を読めませんでした: ${messageOf(error)}`);
    }
    if (!response.ok) throw httpError(response.status, text);
    const parsed = tryParseJson(text);
    if (!parsed.ok) {
      throw new OpenAiAdapterError("malformed", "応答が JSON として読めません");
    }
    if (!isRecord(parsed.value)) {
      throw new OpenAiAdapterError("malformed", "応答が object ではありません");
    }
    return parsed.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * HTTP の誤りを分類する（§2.2・R-15）。
 *
 *   - `insufficient_quota` … 残高切れとして分ける
 *   - HTTP 400（`invalid_json_schema` など）… **要求そのものが不正**。同じ要求ではやり直しても通らない
 *   - それ以外 … 状態コード付きの HTTP の誤り
 *
 * **誤りの本文は残さない**——種類（`code`）だけを持つ。本文の全文は、記録にも例外にも入れない。
 */
function httpError(status: number, text: string): OpenAiAdapterError {
  const parsed = tryParseJson(text);
  const code = parsed.ok ? errorCodeOf(parsed.value) : undefined;
  if (code === "insufficient_quota") {
    return new OpenAiAdapterError("balance", `残高が足りません（HTTP ${status}）`, status);
  }
  if (code === "invalid_json_schema" || status === 400) {
    const kind = code ?? "invalid_request_error";
    return new OpenAiAdapterError("invalidRequest", `要求が不正です（HTTP ${status}、${kind}）`, status, kind);
  }
  return new OpenAiAdapterError("http", `HTTP の誤り（HTTP ${status}）`, status);
}

function errorCodeOf(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const { error } = value;
  if (typeof error.code === "string") return error.code;
  if (typeof error.type === "string") return error.type;
  return undefined;
}

// ── 要求の組み立て（§2・§2.2）─────────────────────────────────────────────

/**
 * 共通の要求を Responses API の body にする（`store: false`・`max_output_tokens`・`instructions`・
 * `prompt_cache_key`・`prompt_cache_options`）。`prompt_cache_key` は**全段で同じ値**を送り、
 * `prompt_cache_options.mode = explicit` で明示の breakpoint（`buildInput`）を効かせる（§2・#342）。
 */
function baseBody(
  config: WireConfig,
  instructions: string,
  input: readonly unknown[],
  maxOutputTokens: number,
  requestEffort?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    store: false,
    max_output_tokens: maxOutputTokens,
    instructions,
    prompt_cache_key: OPENAI_PROMPT_CACHE_KEY,
    prompt_cache_options: { mode: "explicit" },
    input,
  };
  // 要求に effort があればそれを、無ければ設定の値を送る（段ごとの effort。要求に無ければ body は今と同じ。Issue #664・#751）
  const effort = requestEffort ?? config.effort;
  if (effort !== undefined) body.reasoning = { effort };
  return body;
}

/**
 * 構造化出力の body（`text.format` に JSON Schema を置く。§2）。
 *
 * **封筒に載っている段**（`schema-envelope.ts`）のときは、段ごとの schema ではなく**全段で同じ封筒**を
 * 送る（#353）。これで出力の schema が全段で同じになり、段をまたいで前置きが一致してキャッシュが当たる。
 * どの枝で答えるかは、段ごとの指示（`stageInstruction`）で伝える。封筒に載っていない schema（判定の口など）は、
 * 今までどおりその要求の schema をそのまま送る。
 *
 * 封筒の段の枝は、**その要求の schema と深く等しい**ものにする（`resolveStageEnvelope`。Issue #549 の直し）。
 * 旗 on の段は台帳から schema を導くので、起動時の定数の封筒を送ると台帳の形がモデルに届かない。
 */
function buildStructuredBody(
  config: WireConfig,
  request: LlmStructuredRequest,
  envelope: ResolvedStageEnvelope | undefined,
): Record<string, unknown> {
  const entry = envelope?.entry;
  const body = baseBody(
    config,
    request.instructions,
    buildInput(
      request.documents,
      request.rules ?? [],
      request.input,
      entry === undefined ? undefined : stageInstruction(entry.stage),
      // schema を文で示す adapter（Ollama）だけ、段の指示の最後に schema の塊を足す（Issue #771）
      config.presentSchema ? schemaInstructionText(presentedStructuredSchema(envelope, request.schema)) : undefined,
    ),
    request.maxOutputTokens,
    request.effort,
  );
  body.text = {
    format: {
      type: "json_schema",
      name: envelope === undefined ? request.schemaName : envelope.name,
      // 封筒の段：既定は全段の枝の `anyOf`（今までと同じバイト列）。`stageOnlyEnvelope` が on のときだけ、
      // その段の枝 1 つだけの封筒にする（Issue #790）。封筒の無い段はその要求の schema のまま。
      schema:
        envelope === undefined
          ? request.schema
          : config.stageOnlyEnvelope
            ? buildStageOnlyEnvelopeSchema(envelope.entry)
            : envelope.schema,
      strict: true,
    },
  };
  return body;
}

/**
 * 外側の `result` の下に**その段の枝 1 つだけ**を置いた、その段だけの封筒全体を組む（Issue #790）。
 * `buildEnvelopeSchema` の枝を 1 つに絞った形で、`anyOf` を使わない。**`text.format` で送る schema**
 * （`stageOnlyEnvelope` が on の封筒の段）と、**Ollama が文で示す schema の塊**（`presentedStructuredSchema`）が
 * 同じ関数を共有する——送る形と文で示す形を 1 か所に固定する。枝は**その要求の schema から解決した枝**
 * （`resolveStageEnvelope` の `entry`）を渡す（起動時の定数の枝を渡さない）。
 */
function buildStageOnlyEnvelopeSchema(entry: StageEnvelopeEntry): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [ENVELOPE_RESULT_KEY],
    properties: {
      [ENVELOPE_RESULT_KEY]: buildStageBranch(entry),
    },
  };
}

/** schema の塊の頭の文（Ollama の Responses API は `text.format` で応答を縛らないので、形を文でも伝える。Issue #771） */
const SCHEMA_INSTRUCTION = "次の JSON Schema に合う JSON だけを返す。";

/** 段の指示の最後に足す schema の塊（固定の文と schema の本文を 1 つの内容の塊にする） */
function schemaInstructionText(schema: unknown): string {
  return `${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`;
}

/**
 * 文で示す schema（Ollama だけ。Issue #771）。封筒の段なら、**外側の `result` の下にその段の枝を置いた
 * 「その段だけの封筒全体」**——`text.format` で送る封筒と同じ形を文でも伝える。封筒の無い段はその要求の schema。
 */
function presentedStructuredSchema(
  envelope: ResolvedStageEnvelope | undefined,
  requestSchema: unknown,
): unknown {
  if (envelope === undefined) return requestSchema;
  return buildStageOnlyEnvelopeSchema(envelope.entry);
}

/**
 * 段ごとの指示に足す、封筒のどの枝で答えるかの指示（#353）。段ごとの指示は文書の後ろ＝前置きの外に
 * 置かれるので、足しても前置き（キャッシュの効く部分）は変わらない。封筒の枝を選ばせるために、応答の
 * `stage` をその段の名前にするようはっきり伝える。**段の規則の本文は変えない**——別の内容の塊として、
 * 同じ developer のメッセージに足す（規則とデータを分ける作法を保ち、段の規則のレンダリングは変えない）。
 */
function stageInstruction(stage: string): string {
  return `応答は全段で同じ「封筒」の形（{"result": {…}}）で返す。枝は stage で選ぶ——この段の stage は "${stage}" である（result.stage を "${stage}" にすること）。`;
}

/**
 * 道具付きの body（`tools` に function calling を置き、往復を `input` に並べる。§2・R-2）。
 *
 * 要求が最後の答えの schema を持つときは、**道具と一緒に構造化出力（`text.format`）も送る**（#304）
 * ——これで、モデルが道具を使い終えたあとの最後の文の形が、この schema に決まる（strict）。
 */
function buildToolBody(config: WireConfig, request: LlmToolRequest): Record<string, unknown> {
  const input = [
    ...buildInput(
      request.documents,
      request.rules ?? [],
      request.input,
      undefined,
      // 最後の答えの schema を持つ道具付きの要求だけ、schema の塊を足す（schema の無い道具だけの要求には足さない。Issue #771）
      config.presentSchema && request.schema !== undefined ? schemaInstructionText(request.schema) : undefined,
    ),
    ...turnsToInput(request.turns),
  ];
  const body = baseBody(config, request.instructions, input, request.maxOutputTokens, request.effort);
  // 印のある要求で道具を外す設定のとき（Ollama。Issue #777）は、道具の定義と `tool_choice` の**両方**を
  // 送らない——`tool_choice: "none"` が効かない応答があるので、道具そのものを外す。instructions・入力・
  // 履歴・最後の答えの schema・上限・effort は今のまま。印の無い要求の body は今のまま。
  const answerWithoutTools = config.finalAnswerWithoutTools && request.finalAnswerOnly === true;
  if (!answerWithoutTools) {
    body.tools = request.tools.map(toFunctionTool);
    // 最後の答えだけを求める印があるときだけ、道具を選ばせない（旗 `v12.ids` の探索 on の全文の直し。Issue #768）。
    // 印が無ければ body はバイト列で今と同じ（道具の定義と履歴は印があっても送る）。
    if (request.finalAnswerOnly === true) body.tool_choice = "none";
  }
  if (request.schema !== undefined) {
    body.text = {
      format: {
        type: "json_schema",
        name: request.schemaName,
        schema: request.schema,
        strict: true,
      },
    };
  }
  return body;
}

/**
 * 規則とは別の入力（§2.2・#342）。**文書を先頭に固定し**（キャッシュの効く前置き）、段ごとの規則を
 * その直後に、依頼のデータを**さらに後ろ**に置く。データは `<data>` で囲む（規則ではないことが字の上でも
 * 分かる）。キャッシュの**明示の breakpoint は、文書の最後のブロックにだけ**付ける——これで前置き
 * （共通の規則と文書）が全段で同じになり、段ごとの規則とデータが違っても当たる（§2・#342）。
 */
function buildInput(
  documents: readonly string[],
  rules: readonly string[],
  data: string,
  stageInstructionText?: string,
  schemaInstruction?: string,
): unknown[] {
  const items: unknown[] = [];
  documents.forEach((document, index) => {
    items.push(userText(document, index === documents.length - 1));
  });
  const rulesText = rules.join("\n");
  if (rulesText !== "" || stageInstructionText !== undefined || schemaInstruction !== undefined) {
    items.push(developerText(rulesText, stageInstructionText, schemaInstruction));
  }
  items.push(userText(`<data>\n${data}\n</data>`));
  return items;
}

/** 文書・データの 1 項目（`user`）。`cacheBreakpoint` のときだけ、キャッシュの明示の breakpoint を付ける */
function userText(text: string, cacheBreakpoint = false): Record<string, unknown> {
  const part: Record<string, unknown> = { type: "input_text", text };
  if (cacheBreakpoint) part.prompt_cache_breakpoint = { mode: "explicit" };
  return { role: "user", content: [part] };
}

/**
 * 段ごとの指示の 1 項目（`developer`）。上の `instructions` には breakpoint を置けないので、
 * 段ごとの規則は文書の後ろに置く（前置きを全段で同じに保つ。§2・#342）。
 *
 * 段の規則は 1 つ目の内容の塊（`<rules>` の囲み）に、封筒の枝を選ばせる指示（#353）は 2 つ目の
 * 内容の塊に置く——段の規則の本文を変えずに足せる。
 */
function developerText(
  rulesText: string,
  stageInstructionText?: string,
  schemaInstruction?: string,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (rulesText !== "") content.push({ type: "input_text", text: `<rules>\n${rulesText}\n</rules>` });
  if (stageInstructionText !== undefined) {
    content.push({ type: "input_text", text: stageInstructionText });
  }
  // schema の塊は**最後の内容の塊**に置く（Issue #771）。規則も封筒の指示も無い要求では、これだけの
  // developer を新しく置く（文書の breakpoint より後ろなので、前置きは変わらない）。
  if (schemaInstruction !== undefined) {
    content.push({ type: "input_text", text: schemaInstruction });
  }
  return { role: "developer", content };
}

/** これまでの往復を Responses API の入力の項目に直す（こちらで組み立てて毎回送る。§2） */
function turnsToInput(turns: readonly LlmTurn[]): unknown[] {
  const items: unknown[] = [];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      for (const call of turn.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? null),
        });
      }
    } else {
      for (const result of turn.results) {
        items.push({
          type: "function_call_output",
          call_id: result.toolCallId,
          output: JSON.stringify(result.output ?? null),
        });
      }
    }
  }
  return items;
}

function toFunctionTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

// ── 応答の解釈（§2.2）───────────────────────────────────────────────────

async function callStructuredWire<T>(
  config: WireConfig,
  request: LlmStructuredRequest,
): Promise<LlmStructuredResponse<T>> {
  // 送る封筒と応答の取り出しは同じ枝で行う（その要求の schema と深く等しい枝。Issue #549 の直し）
  const envelope = resolveStageEnvelope(request.schemaName, request.schema, config.envelope);
  const entry = envelope?.entry;
  const wire = await requestWire(
    config,
    applyExtraBody(buildStructuredBody(config, request, envelope), config.extraBody),
    request.signal,
  );
  const usage = parseUsage(wire.usage);
  requireCompleted(wire, usage);
  requireNoRefusal(wire);
  const text = extractOutputText(wire);
  if (text === undefined) throw malformedWire("no-body", "構造化出力の本文がありません");
  const parsed = parseResponseJson(text, config.readFencedJson);
  if (!parsed.ok) throw malformedWire("not-json", "構造化出力が JSON として読めません");
  const output =
    entry === undefined ? requireSchema(request.schema, parsed.value) : unwrapEnvelope(entry, parsed.value);
  return { output: output as T, usage };
}

/** schema に合うことを確かめ、合えばその値を返す（合わなければ形の誤り。§2.2） */
function requireSchema(schema: unknown, value: unknown): unknown {
  const schemaError = validateSchema(schema, value);
  if (schemaError !== undefined) {
    throw malformedWire("schema", `schema に合いません: ${schemaError}`);
  }
  return value;
}

/**
 * 封筒の応答から `result` を取り出して段へ渡す（#353）。**`stage` がその段でなければ形の誤り**にする
 * ——枝を間違えて答えた応答は、その段の答えではない。取り出した中身は、その段の枝（段の schema に
 * `stage` を足したもの）に合うことを確かめてから、判別子の `stage` を落として返す。こうすると、段の
 * 側の検査は今までと同じ中身を見ることになる。
 */
function unwrapEnvelope(entry: StageEnvelopeEntry, value: unknown): unknown {
  if (!isRecord(value)) {
    throw malformedWire("envelope", "封筒の応答が object ではありません");
  }
  const result = value[ENVELOPE_RESULT_KEY];
  if (!isRecord(result)) {
    throw malformedWire("envelope", "封筒の応答に result がありません");
  }
  if (result[ENVELOPE_STAGE_KEY] !== entry.stage) {
    throw malformedWire("wrong-stage", `封筒の stage が違います（期待 ${entry.stage}）`);
  }
  requireSchema(buildStageBranch(entry), result);
  const output: Record<string, unknown> = { ...result };
  delete output[ENVELOPE_STAGE_KEY];
  return output;
}

async function callToolsWire(config: WireConfig, request: LlmToolRequest): Promise<LlmToolResponse> {
  const wire = await requestWire(config, applyExtraBody(buildToolBody(config, request), config.extraBody), request.signal);
  const usage = parseUsage(wire.usage);
  requireCompleted(wire, usage);
  requireNoRefusal(wire);
  const toolCalls = extractFunctionCalls(wire);
  if (toolCalls.length > 0) return { kind: "toolCalls", toolCalls, usage };
  const text = extractOutputText(wire);
  if (text === undefined) throw new OpenAiAdapterError("malformed", "宣言の本文がありません");
  const parsed = parseResponseJson(text, config.readFencedJson);
  if (!parsed.ok) throw new OpenAiAdapterError("malformed", "宣言が JSON として読めません");
  return { kind: "done", declaration: parsed.value, usage };
}

/**
 * 応答の本文を JSON として読む（Issue #777）。`readFenced` が真で、本文が 1 組の囲み（```` ``` ```` … ```` ``` ````）
 * で包まれていれば、中身を読む。包まれていなければ本文をそのまま読む——**囲みの外に文字がある・囲みが 2 組以上・
 * 中身が JSON でない**ときは、ここで中身を読んで失敗し、今のとおり `malformed` になる。
 *
 * 構造化出力の本文と、道具付きの要求の最後の答え（`done`）の本文だけに使う。**道具の引数（`parseToolArguments`）と
 * wire の JSON（`requestWire`）の読み方は変えない**——道具の引数の囲みは今のとおり読めない。
 */
function parseResponseJson(text: string, readFenced: boolean): JsonResult {
  if (readFenced) {
    const inner = unfencedBody(text);
    if (inner !== undefined) return tryParseJson(inner);
  }
  return tryParseJson(text);
}

/**
 * 前後の空白を除いた本文が 1 組の囲みで包まれていれば、中身（囲みの間の行を改行でつないだもの）を返す。
 * 包まれていなければ `undefined`（Issue #777）。
 *
 *   1 組とみなす条件：最初の行が ```` ``` ```` **ちょうど 3 個**だけ、またはその直後に言語の印を 1 語だけ
 *   （バッククォートを含めず、空白も無し）続けた行で、最後の行が ```` ``` ```` ちょうど 3 個だけの行であり、
 *   その間に ```` ``` ```` で始まる行が無いこと。改行は `\n`・`\r\n`・`\r` のどれでもよい。JSON の文字列の中の
 *   バッククォートは囲みとみなさない（最初の行が ```` ``` ```` ちょうど 3 個で始まらないため）。
 */
function unfencedBody(text: string): string | undefined {
  const lines = text.trim().split(/\r\n|\r|\n/);
  if (lines.length < 2) return undefined;
  if (!isFenceStart(lines[0] ?? "")) return undefined;
  if ((lines[lines.length - 1] ?? "").trim() !== "```") return undefined;
  const inner = lines.slice(1, -1);
  if (inner.some((line) => line.trimStart().startsWith("```"))) return undefined;
  return inner.join("\n");
}

/**
 * 行が囲みの始まりか（Issue #777。厳密化はレビュー R1）。バッククォート**ちょうど 3 個**だけの行、または
 * その直後に言語の印を**1 語だけ**（バッククォートを含まず、空白も無し）続けた行だけを始まりとみなす。
 *
 * 4 個以上・6 個などの余分なバッククォートや、印の末尾に ```` ``` ```` が続く行（例 ```` ```json``` ````）は
 * 始まりではない。`/^```\S+$/` は後ろの `\S+` にバッククォートを許すので、これらを「印 1 語」として受理し、
 * 閉じの 3 個を印の一部として飲み込んでしまう——`unfencedBody` の「1 組だけ」の限定を超えて malformed を
 * 成功に変える（R1 の不具合）。
 */
function isFenceStart(line: string): boolean {
  const value = line.trim();
  return value === "```" || /^```[^`\s]+$/.test(value);
}

/**
 * 応答が完了していることを確かめる（§2.2・§1.5）。`status` が `completed` でなければ未完了として
 * 分類する。**出力が JSON として読めても、未完了なら成功にしない**（`status` を先に見る）。
 * 未完了には、理由と（分かっていれば）usage を添える——共通の口が予約を精算できるようにする。
 */
function requireCompleted(wire: Record<string, unknown>, usage: LlmUsage | undefined): void {
  const status = wire.status;
  if (typeof status !== "string") {
    throw new OpenAiAdapterError("malformed", "応答に status がありません");
  }
  if (status !== "completed") {
    const reason = incompleteReasonValue(wire);
    throw new OpenAiIncompleteError(
      reason,
      usage,
      `応答が完了していません（status=${status}${reason === "" ? "" : `, reason=${reason}`}）`,
    );
  }
}

/** `incomplete_details.reason` を読む（無ければ空文字） */
function incompleteReasonValue(wire: Record<string, unknown>): string {
  const details = wire.incomplete_details;
  if (isRecord(details) && typeof details.reason === "string") return details.reason;
  return "";
}

/** 出力に拒否（`refusal`）があれば分類する（§2.2「拒否・不完全な応答」） */
function requireNoRefusal(wire: Record<string, unknown>): void {
  for (const item of outputItems(wire)) {
    if (!isRecord(item)) continue;
    for (const part of asArray(item.content) ?? []) {
      if (isRecord(part) && part.type === "refusal") {
        const text = typeof part.refusal === "string" ? part.refusal : "";
        throw new OpenAiAdapterError("refusal", `モデルが拒否しました${text === "" ? "" : `: ${text}`}`);
      }
    }
  }
}

function outputItems(wire: Record<string, unknown>): readonly unknown[] {
  return asArray(wire.output) ?? [];
}

/** 出力のテキストをまとめる（`output_text` の content を連結する） */
function extractOutputText(wire: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const item of outputItems(wire)) {
    if (!isRecord(item) || item.type !== "message") continue;
    for (const part of asArray(item.content) ?? []) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/** 道具の呼び出しを取り出す。引数が JSON として読めなければ `toolArguments` にする（§2.2） */
function extractFunctionCalls(wire: Record<string, unknown>): LlmToolCall[] {
  const calls: LlmToolCall[] = [];
  for (const item of outputItems(wire)) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    const id = item.call_id;
    const name = item.name;
    if (typeof id !== "string" || typeof name !== "string") {
      throw new OpenAiAdapterError("malformed", "道具の呼び出しの形が違います");
    }
    calls.push({ id, name, arguments: parseToolArguments(item.arguments) });
  }
  return calls;
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") {
    throw new OpenAiAdapterError("toolArguments", "道具の引数が文字列ではありません");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  const parsed = tryParseJson(trimmed);
  if (!parsed.ok) {
    throw new OpenAiAdapterError("toolArguments", "道具の引数が JSON として読めません");
  }
  return parsed.value;
}

// ── usage（§1.5・R-6）───────────────────────────────────────────────────

/**
 * usage を共通の契約の形（＋キャッシュの書き込み。#302）に直す。**無い・壊れているときは
 * `undefined`**（「usage なし」）を返し、共通の口に予約を残させる。壊れている＝数でない・負・
 * 整数でない・内訳が合計を超える。
 *
 * キャッシュの**読み取り**（`cached_tokens`）と**書き込み**（`cache_write_tokens`）は分けて持つ。
 * 書き込みの欄が無い wire は 0 として扱う（記録を止めない）。
 */
function parseUsage(value: unknown): OpenAiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = detailCount(value.input_tokens_details, "cached_tokens");
  const cacheWriteTokens = detailCount(value.input_tokens_details, "cache_write_tokens");
  const reasoningTokens = detailCount(value.output_tokens_details, "reasoning_tokens");
  if (cachedInputTokens === undefined || cacheWriteTokens === undefined || reasoningTokens === undefined) {
    return undefined;
  }
  if (cachedInputTokens > inputTokens) return undefined;
  if (cacheWriteTokens > inputTokens) return undefined;
  if (reasoningTokens > outputTokens) return undefined;
  return { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 内訳（`input_tokens_details` など）の 1 つの数。無ければ 0、壊れていれば `undefined` */
function detailCount(details: unknown, key: string): number | undefined {
  if (details === undefined) return 0;
  if (!isRecord(details)) return undefined;
  const raw = details[key];
  if (raw === undefined) return 0;
  return nonNegativeInteger(raw);
}

// ── 小さな道具立て ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function tryParseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
