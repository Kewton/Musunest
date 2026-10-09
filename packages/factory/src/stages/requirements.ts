// ① 要件にする（02-architecture.md §1・F-3・F-6）。
//
// 依頼文（原文）を、**1 行 1 要件**の一覧にする。各要件には、原文からの**引用**と、その**位置**
// （文字の範囲）を付ける。軽い曖昧さはどちらに決めたかを記録し、重大な曖昧さ（決め方で作るものが
// 変わる）は決めずに「未解決」として残す（F-6）。
//
// 入口で、依頼文の長さの上限（共通の上限値。§1.5）を**最初に**確かめる。超えていれば LLM を呼ばない。
// ①' の逆照合で落ちが見つかれば、その落ちをデータに足して**もう一度**この段を呼ぶ（やり直しは 1 回）。
import type { CallGateway } from "../call.js";
import { checkRequestText } from "../limits.js";
import type { Requirement, RequirementList, ReverseCheckMiss, SourceRange } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ① の JSON Schema の名前 */
export const REQUIREMENTS_SCHEMA_NAME = "requirement-list";

/** ① の出力トークンの上限 */
export const REQUIREMENTS_MAX_OUTPUT_TOKENS = 4_096;

/** ① に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const REQUIREMENTS_RULES: readonly string[] = [
  "依頼文（原文）を、1 行 1 要件の一覧にする。",
  "各要件には、原文からそのまま写した引用（quote）と、その位置（position。原文の文字の範囲 start/end）を付ける。",
  "軽い曖昧さは、どちらに決めたかを decisions に記録して書き進める。",
  "重大な曖昧さ（どちらに決めるかで作るものが変わる）は決めずに、unresolved にその問いを残す。",
];

/**
 * ① の JSON Schema（構造化出力）。欄の形の正本はこの schema で、コードの `checkRequirementOutput` が
 * 同じ形を手で確かめる（schema は adapter に渡り、違反はコードが見る。§2.2）。
 */
export const REQUIREMENT_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requirements", "decisions", "unresolved"],
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "quote", "position"],
        properties: {
          id: { type: "string", description: "要件の識別子（例 R-1）" },
          text: { type: "string", description: "要件の文" },
          quote: { type: "string", description: "原文からそのまま写した引用" },
          position: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    decisions: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
} as const;

/** ① が受け取るもの */
export interface RequirementsInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 信頼する文書（呼ぶ側から渡す） */
  readonly documents: readonly PromptDocument[];
  /** 共通の口 */
  readonly gateway: CallGateway;
  /** ①' の落ちを受けてやり直すときの、前回の一覧と落ち（1 回目のときは無い） */
  readonly redo?: {
    readonly previous: RequirementList;
    readonly misses: readonly ReverseCheckMiss[];
  };
}

function checkPosition(value: unknown, field: string, problems: Problem[]): SourceRange | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "位置は写像（object）であること" });
    return undefined;
  }
  const start = value["start"];
  const end = value["end"];
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (start as number) > (end as number)
  ) {
    problems.push({ field, message: "位置は 0 以上で start <= end の整数であること" });
    return undefined;
  }
  return { start: start as number, end: end as number };
}

function checkRequirement(value: unknown, field: string, problems: Problem[]): Requirement | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "要件は写像（object）であること" });
    return undefined;
  }
  const id = value["id"];
  const text = value["text"];
  const quote = value["quote"];
  let good = true;
  if (typeof id !== "string" || id === "") {
    problems.push({ field: `${field}.id`, message: "要件 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof text !== "string" || text === "") {
    problems.push({ field: `${field}.text`, message: "要件の文は空でない文字列であること" });
    good = false;
  }
  if (typeof quote !== "string") {
    problems.push({ field: `${field}.quote`, message: "引用は文字列であること（原文からそのまま写す）" });
    good = false;
  }
  const position = checkPosition(value["position"], `${field}.position`, problems);
  if (position === undefined) good = false;
  if (!good || position === undefined) return undefined;
  return { id: id as string, text: text as string, quote: quote as string, position };
}

/** ① の応答の形を確かめる。合わない欄を**すべて**挙げて返す */
export function checkRequirementOutput(output: unknown): ShapeCheck<RequirementList> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  const raw = output["requirements"];
  const requirements: Requirement[] = [];
  if (!Array.isArray(raw)) {
    problems.push({ field: "requirements", message: "要件の一覧は並び（array）であること" });
  } else {
    raw.forEach((item, index) => {
      const checked = checkRequirement(item, `requirements[${index}]`, problems);
      if (checked !== undefined) requirements.push(checked);
    });
  }
  const decisions = checkStringArray(output["decisions"], "decisions", problems);
  const unresolved = checkStringArray(output["unresolved"], "unresolved", problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      requirements,
      decisions: decisions ?? [],
      unresolved: unresolved ?? [],
    },
  };
}

/** ① のデータ（その段に渡すと決めた文脈だけ） */
function buildData(input: RequirementsInput): readonly PromptData[] {
  const data: PromptData[] = [{ name: "原文", text: input.source }];
  if (input.redo !== undefined) {
    data.push({ name: "前回の要件の一覧", text: serializeJson(input.redo.previous) });
    data.push({ name: "逆照合で見つかった落ち", text: serializeJson(input.redo.misses) });
  }
  return data;
}

/**
 * ① を 1 回呼ぶ。入口で依頼文の長さを確かめ、超えていれば呼ばずに `limit` を返す。
 * 形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 */
export async function runRequirements(input: RequirementsInput): Promise<StageOutcome<RequirementList>> {
  const exceeded = checkRequestText(input.source);
  if (exceeded !== undefined) {
    return {
      ok: false,
      failure: { kind: "limit", limit: exceeded.limit, max: exceeded.max, actual: exceeded.actual },
    };
  }
  const request = buildStructuredRequest({
    rules: REQUIREMENTS_RULES,
    documents: input.documents,
    data: buildData(input),
    schemaName: REQUIREMENTS_SCHEMA_NAME,
    schema: REQUIREMENT_LIST_SCHEMA,
    maxOutputTokens: REQUIREMENTS_MAX_OUTPUT_TOKENS,
  });
  return callStructuredChecked(input.gateway, { request, check: checkRequirementOutput });
}
