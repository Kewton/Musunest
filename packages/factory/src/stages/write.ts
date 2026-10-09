// ③ 書く（02-architecture.md §1・§1.5）。
//
// 設計（②）から、宣言（app.spec.yaml の原文）を書く。**共通の口を通してだけ** LLM を呼ぶ。
// 書いた直後に、**宣言の大きさの上限**（§1.5）を確かめる——上限を超えた宣言は、静的チェック（④）へ
// 渡さない。規則（instructions）とデータ（設計・要件の一覧）を分ける（§2.2）。
import type { CallGateway } from "../call.js";
import { checkDeclarationBytes } from "../limits.js";
import type { Declaration, DesignResult, RequirementList } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ③ の JSON Schema の名前 */
export const WRITE_SCHEMA_NAME = "declaration";

/** ③ の出力トークンの上限 */
export const WRITE_MAX_OUTPUT_TOKENS = 8_192;

/** ③ に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const WRITE_RULES: readonly string[] = [
  "設計（設計する段の出力）に従って、宣言（app.spec.yaml の原文）を 1 つ書く。",
  "宣言は 7 欄（entities・views・actions・validations・computed・permissions・minIdentity）をすべて書く。中身が無ければ `[]` と書く。",
  "文書（契約・語彙の意味・語彙の台帳）に無い語彙・キー・関数を使わない。",
  "設計で「書けない」とされた部分は、書かずに残す（設計に無いものを勝手に足さない）。",
  "出力は応答の declaration 欄に、YAML の原文として入れる。説明・前置き・後書きを付けない。",
];

/** ③ の JSON Schema（構造化出力）。宣言の原文（YAML）を文字列で受ける */
export const DECLARATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declaration"],
  properties: {
    declaration: {
      type: "string",
      description: "宣言（app.spec.yaml）の原文（7 欄をすべて書いた YAML）",
    },
  },
} as const;

/** ③ が受け取るもの */
export interface WriteInput {
  readonly list: RequirementList;
  readonly design: DesignResult;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** ③ の出力（宣言の原文と、その大きさ） */
export interface WrittenDeclaration {
  readonly declaration: Declaration;
  /** 宣言（原文）の UTF-8 のバイト数。上限（§1.5）に照らした値である */
  readonly byteLength: number;
}

/** ③ の応答の形を確かめる。宣言は空でない文字列（YAML の原文）であること */
export function checkWriteOutput(output: unknown): ShapeCheck<{ declaration: string }> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const declaration = output["declaration"];
  if (typeof declaration !== "string" || declaration === "") {
    return { ok: false, problems: [{ field: "declaration", message: "宣言は空でない文字列（YAML の原文）であること" }] };
  }
  return { ok: true, value: { declaration } };
}

/** 文字列の UTF-8 のバイト数（Cloudflare 固有の API も Node 固有の API も使わない） */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** ③ のデータ（その段に渡すと決めた文脈だけ。設計と要件の一覧） */
function buildData(list: RequirementList, design: DesignResult): readonly PromptData[] {
  return [
    { name: "要件の一覧", text: serializeJson(list) },
    { name: "設計", text: serializeJson(design) },
  ];
}

/**
 * ③ を 1 回呼ぶ。形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 * **書いた直後**に宣言の大きさの上限（§1.5）を確かめ、超えていれば呼び出しの上限として返す
 * ——上限を超えた宣言は静的チェックへ渡さない。
 */
export async function runWrite(input: WriteInput): Promise<StageOutcome<WrittenDeclaration>> {
  const request = buildStructuredRequest({
    rules: WRITE_RULES,
    documents: input.documents,
    data: buildData(input.list, input.design),
    schemaName: WRITE_SCHEMA_NAME,
    schema: DECLARATION_SCHEMA,
    maxOutputTokens: WRITE_MAX_OUTPUT_TOKENS,
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: checkWriteOutput });
  if (!answer.ok) return answer;
  const byteLength = utf8ByteLength(answer.value.declaration);
  const exceeded = checkDeclarationBytes(byteLength);
  if (exceeded !== undefined) {
    return {
      ok: false,
      failure: { kind: "limit", limit: exceeded.limit, max: exceeded.max, actual: exceeded.actual },
    };
  }
  return { ok: true, value: { declaration: { source: answer.value.declaration }, byteLength } };
}
