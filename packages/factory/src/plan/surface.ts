// P3 洗い出す——**目録に無い曖昧さと、書けないこと**を LLM に挙げさせる（04-plan-agent.md §3 P3・§5・U-P2）。
//
// 語彙の決めどころの目録（catalog.ts）で拾えない曖昧さと、語彙の穴による**書けないこと**を、要件の一覧を
// 渡した会話に挙げさせる。書けないことには**文書の版を要する制約 ID**（契約の規則の `R-…` と語彙の意味の
// `### ` 見出し）を必須にし、#332 と同じ裏付けをコードで掛ける（根拠の無い「書けない」は断る）。
// 併せて、書けない部分には**代わりの案を 1 つ**出させる（U-P2「文書の語彙で書ける近い形を 1 つ」）。
//
// 段の作法（規則とデータの分離・構造化出力・形の確認と 1 回だけのやり直し）は stages/prompt.ts に合わせる。
import type { CallGateway } from "../call.js";
import type { RequirementList } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  constraintIdsIn,
  isRecord,
  serializeJson,
  type Problem,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "../stages/prompt.js";

/** P3 の洗い出しの JSON Schema の名前 */
export const SURFACE_SCHEMA_NAME = "plan-surface";

/** P3 の洗い出しに足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const SURFACE_RULES: readonly string[] = [
  "要件の一覧から、次を挙げる：**未解決の事項**（答えで作るものが変わる。重大か否か。語彙の決めどころの目録に無いもの）と、**語彙で書けないこと**。",
  "質問や観点の文は、利用者の言葉で書く。宣言の用語（entity・computed・selector など）を使わない。",
  "書けないことには、根拠にした**制約 ID**（constraintIds）を必須にする——渡した文書の本文にある「R-…」の ID か、語彙の意味の「### 」見出しの文だけを挙げる。文書に無い ID を作らない。",
  "書けないことには、**代わりの案**（alternative）を 1 つ書く——文書の語彙で書ける、近い形である。代わりの案を採るかどうかは利用者が決める。",
  "曖昧さ（まだ書ける）と、書けないこと（語彙の穴）を混ぜない。要件の言い直しや、すでに決まっていることは挙げない。",
];

/** P3 の洗い出しの JSON Schema（構造化出力） */
export const SURFACE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ambiguities", "unwritable"],
  properties: {
    ambiguities: {
      type: "array",
      description: "答えで作るものが変わる未解決の事項（目録に無い曖昧さ。04 §3 P3）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "requirementId", "text", "critical"],
        properties: {
          id: { type: "string", description: "未解決の事項の識別子" },
          requirementId: { type: "string", description: "対象の要件 ID" },
          text: { type: "string", description: "利用者の言葉で書いた問い" },
          critical: {
            type: "boolean",
            description: "重大か（決め方で作るものが変わるか）。真なら上限のあとも残ると確定できない",
          },
        },
      },
    },
    unwritable: {
      type: "array",
      description: "語彙で書けない部分（文書の版・箇所・制約 ID を必須にする。04 §3 P3）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "requirementId", "part", "constraintIds", "reason", "alternative"],
        properties: {
          id: { type: "string", description: "書けない部分の識別子" },
          requirementId: { type: "string", description: "対象の要件 ID" },
          part: { type: "string", description: "書けない部分" },
          constraintIds: {
            type: "array",
            items: { type: "string" },
            description: "根拠にした制約 ID（契約の規則の R-… と、語彙の意味の ### 見出し）",
          },
          reason: { type: "string", description: "書けない理由" },
          alternative: { type: "string", description: "代わりの案（文書の語彙で書ける近い形を 1 つ。U-P2）" },
        },
      },
    },
  },
} as const;

/** 目録に無い未解決の事項 1 つ（04 §4 `open_issues` の候補） */
export interface PlanAmbiguity {
  readonly id: string;
  readonly requirementId: string;
  /** 利用者の言葉で書いた問い */
  readonly text: string;
  readonly critical: boolean;
}

/** 書けない部分 1 つ（04 §4 `accepted_unwritable` の候補。U-P2 の代わりの案つき） */
export interface PlanUnwritable {
  readonly id: string;
  readonly requirementId: string;
  readonly part: string;
  readonly constraintIds: readonly string[];
  readonly reason: string;
  /** 代わりの案（文書の語彙で書ける近い形を 1 つ） */
  readonly alternative: string;
}

/** P3 の洗い出しの出力 */
export interface PlanSurface {
  readonly ambiguities: readonly PlanAmbiguity[];
  readonly unwritable: readonly PlanUnwritable[];
}

/** P3 の洗い出しが受け取るもの */
export interface SurfaceInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

function checkAmbiguity(value: unknown, field: string, problems: Problem[]): PlanAmbiguity | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "未解決の事項は写像（object）であること" });
    return undefined;
  }
  let good = true;
  const id = value["id"];
  const requirementId = value["requirementId"];
  const text = value["text"];
  const critical = value["critical"];
  if (typeof id !== "string" || id === "") {
    problems.push({ field: `${field}.id`, message: "識別子は空でない文字列であること" });
    good = false;
  }
  if (typeof requirementId !== "string" || requirementId === "") {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof text !== "string" || text === "") {
    problems.push({ field: `${field}.text`, message: "問いは空でない文字列であること" });
    good = false;
  }
  if (typeof critical !== "boolean") {
    problems.push({ field: `${field}.critical`, message: "重大かは真偽（boolean）であること" });
    good = false;
  }
  if (!good) return undefined;
  return { id: id as string, requirementId: requirementId as string, text: text as string, critical: critical as boolean };
}

function checkUnwritable(value: unknown, field: string, problems: Problem[]): PlanUnwritable | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "書けない部分は写像（object）であること" });
    return undefined;
  }
  const id = value["id"];
  const requirementId = value["requirementId"];
  const part = value["part"];
  const reason = value["reason"];
  const alternative = value["alternative"];
  let good = true;
  if (typeof id !== "string" || id === "") {
    problems.push({ field: `${field}.id`, message: "識別子は空でない文字列であること" });
    good = false;
  }
  if (typeof requirementId !== "string" || requirementId === "") {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof part !== "string" || part === "") {
    problems.push({ field: `${field}.part`, message: "書けない部分は空でない文字列であること" });
    good = false;
  }
  if (typeof reason !== "string" || reason === "") {
    problems.push({ field: `${field}.reason`, message: "書けない理由は空でない文字列であること" });
    good = false;
  }
  if (typeof alternative !== "string" || alternative === "") {
    problems.push({ field: `${field}.alternative`, message: "代わりの案は空でない文字列であること（U-P2）" });
    good = false;
  }
  const constraintIds = checkStringArray(value["constraintIds"], `${field}.constraintIds`, problems);
  if (constraintIds === undefined) good = false;
  if (!good || constraintIds === undefined) return undefined;
  return {
    id: id as string,
    requirementId: requirementId as string,
    part: part as string,
    constraintIds,
    reason: reason as string,
    alternative: alternative as string,
  };
}

/** P3 の洗い出しの応答の形を確かめる */
export function checkSurfaceOutput(output: unknown): ShapeCheck<PlanSurface> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  const rawAmbiguities = output["ambiguities"];
  const ambiguities: PlanAmbiguity[] = [];
  if (!Array.isArray(rawAmbiguities)) {
    problems.push({ field: "ambiguities", message: "未解決の事項の並び（array）であること" });
  } else {
    rawAmbiguities.forEach((item, index) => {
      const checked = checkAmbiguity(item, `ambiguities[${index}]`, problems);
      if (checked !== undefined) ambiguities.push(checked);
    });
  }
  const rawUnwritable = output["unwritable"];
  const unwritable: PlanUnwritable[] = [];
  if (!Array.isArray(rawUnwritable)) {
    problems.push({ field: "unwritable", message: "書けない部分の並び（array）であること" });
  } else {
    rawUnwritable.forEach((item, index) => {
      const checked = checkUnwritable(item, `unwritable[${index}]`, problems);
      if (checked !== undefined) unwritable.push(checked);
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { ambiguities, unwritable } };
}

/**
 * 書けないことの申告が、**渡した文書の本文の制約 ID に裏付けられている**かを確かめる（04 §3 P3・#332）。
 * 制約 ID の無い申告と、文書に無い ID を使った申告を断る。未解決の事項（ambiguities）には掛けない。
 */
export function checkSurfaceConstraints(
  surface: PlanSurface,
  documents: readonly PromptDocument[],
): readonly Problem[] {
  const known = constraintIdsIn(documents);
  const problems: Problem[] = [];
  surface.unwritable.forEach((item, index) => {
    const field = `unwritable[${index}].constraintIds`;
    if (item.constraintIds.length === 0) {
      problems.push({
        field,
        message: "書けないことには、根拠にした制約 ID が要る（文書の R-… または ### 見出し）",
      });
      return;
    }
    for (const id of item.constraintIds) {
      if (!known.has(id)) problems.push({ field, message: `文書に無い制約 ID: ${id}` });
    }
  });
  return problems;
}

/**
 * P3 の洗い出しを 1 回呼ぶ。データは要件の一覧だけである。形が合わない応答は 1 回だけやり直し、
 * 制約 ID の裏付けが取れない申告は断る（`unmet`）。
 */
export async function runSurface(input: SurfaceInput): Promise<StageOutcome<PlanSurface>> {
  const request = buildStructuredRequest({
    rules: SURFACE_RULES,
    documents: input.documents,
    data: [{ name: "要件の一覧", text: serializeJson(input.list) }],
    schemaName: SURFACE_SCHEMA_NAME,
    schema: SURFACE_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("design"),
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: checkSurfaceOutput });
  if (!answer.ok) return answer;
  const problems = checkSurfaceConstraints(answer.value, input.documents);
  if (problems.length > 0) {
    return { ok: false, failure: { kind: "unmet", attempts: 1, problems } };
  }
  return answer;
}
