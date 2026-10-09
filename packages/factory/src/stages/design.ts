// ② 設計する（02-architecture.md §1・F-4・F-5・F-7・F-8）。
//
// 要件ごとに、使う語彙と置き場所、そして**書けない部分**を返す。書けない部分は、その部分だけを
// 落とし、残りの書ける部分は残す設計にさせる（F-4）。無い語彙・キー・関数を作らせない（F-5）。
// ② には要件の一覧だけを渡す（宣言はまだ無い）。
import type { CallGateway } from "../call.js";
import type { DesignResult, RequirementDesign, RequirementList } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  isRecord,
  serializeJson,
  type Problem,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ② の JSON Schema の名前 */
export const DESIGN_SCHEMA_NAME = "requirement-design";

/** ② に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const DESIGN_RULES: readonly string[] = [
  "要件ごとに、使う語彙と、宣言のどの欄に置くか（placement）を決める。",
  "書けない部分は、その部分だけを unwritable に挙げる。書ける部分は残す（部分的に書けない要件でも、書ける部分は書く）。",
  "文書（契約・語彙の意味・語彙の台帳）に無い語彙・キー・関数は作らない。書けないものを、近い別の意味に書き換えない。",
  "要件ごとに 1 つの設計を返す。要件 ID は一覧のまま写す。",
];

/** ② の JSON Schema（構造化出力） */
export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["designs"],
  properties: {
    designs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "vocabulary", "placement", "unwritable"],
        properties: {
          requirementId: { type: "string" },
          vocabulary: { type: "array", items: { type: "string" } },
          placement: { type: "array", items: { type: "string" } },
          unwritable: { type: "array", items: { type: "string" }, description: "書けない部分（無ければ空）" },
        },
      },
    },
  },
} as const;

/** ② が受け取るもの */
export interface DesignInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

function checkDesign(value: unknown, field: string, problems: Problem[]): RequirementDesign | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "設計は写像（object）であること" });
    return undefined;
  }
  const requirementId = value["requirementId"];
  const validId = typeof requirementId === "string" && requirementId !== "";
  if (!validId) {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
  }
  const vocabulary = checkStringArray(value["vocabulary"], `${field}.vocabulary`, problems);
  const placement = checkStringArray(value["placement"], `${field}.placement`, problems);
  const unwritable = checkStringArray(value["unwritable"], `${field}.unwritable`, problems);
  if (!validId || vocabulary === undefined || placement === undefined || unwritable === undefined) {
    return undefined;
  }
  return { requirementId: requirementId as string, vocabulary, placement, unwritable };
}

/** ② の応答の形を確かめる */
export function checkDesignOutput(output: unknown): ShapeCheck<DesignResult> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["designs"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "designs", message: "設計の並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const designs: RequirementDesign[] = [];
  raw.forEach((item, index) => {
    const checked = checkDesign(item, `designs[${index}]`, problems);
    if (checked !== undefined) designs.push(checked);
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { designs } };
}

/** ② を 1 回呼ぶ。データは要件の一覧だけである */
export async function runDesign(input: DesignInput): Promise<StageOutcome<DesignResult>> {
  const request = buildStructuredRequest({
    rules: DESIGN_RULES,
    documents: input.documents,
    data: [{ name: "要件の一覧", text: serializeJson(input.list) }],
    schemaName: DESIGN_SCHEMA_NAME,
    schema: DESIGN_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("design"),
  });
  return callStructuredChecked(input.gateway, { request, check: checkDesignOutput });
}
