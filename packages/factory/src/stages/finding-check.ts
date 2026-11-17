// 指摘の確かめ（Issue #967）。
//
// P2（逆照合）の会話が「原文のこの部分が一覧に無い」と指したとき、その指摘を**別の呼び出し**で 1 件ずつ
// 確かめる段である。確かめ役には**指摘の範囲と、それを含む文**、原文、その往復の一覧だけを渡す——P2 の
// 出力の種類・対象 ID・説明、ほかの指摘、コードの落ち、前の回の判定、正解の表、過去の記録は渡さない。
//
// 出力は `{verdict, requirement_ids, reason}` の strict な構造化出力である。3 回とも `carried` か
// `not-a-condition` のときだけ、呼ぶ側（reverse-check の往復）が指摘を落ちから外す。**この段は判定を
// 返すだけで、外すかどうかは決めない**——3 回の一致と ID の確かめは呼ぶ側の仕事である。
import type { CallGateway } from "../call.js";
import type { RequirementList, SourceRange } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  type Problem,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** 確かめ役の JSON Schema の名前 */
export const FINDING_CHECK_SCHEMA_NAME = "finding-check";

/**
 * 確かめ役の規則（R-rfc-01〜05。Issue #967）。文・why・since・modes は Issue 本文の「規則の全文」と
 * **byte で同じ**にする。modes はすべて M-21（条件の欠落の検出の側の誤検出）。
 */
export const FINDING_CHECK_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-rfc-01",
    text: "指摘された断片だけでなく、それを含む文の中での働きで決める。",
    why: "断片だけを見ると、条件の語を背景の語と取り違える",
    since: "Issue #967",
    modes: ["M-21"],
  },
  {
    id: "R-rfc-02",
    text: "断片が運ぶ内容が、一覧のどれかの要件の本文に表されていれば（言い換えでもよい）、carried とする。引用は出典の目印にすぎず、本文に表されているかで決める。断片の修飾が文の中の複数の項目に掛かるときは、項目ごとに確かめ、掛かる項目のどれか 1 つの要件の本文にでも表されていなければ carried としない。",
    why: "一部の項目の要件だけを見て「表されている」とすると、本当の欠落を外す（試作の v1 で観測）",
    since: "Issue #967",
    modes: ["M-21"],
  },
  {
    id: "R-rfc-03",
    text: "利用者の事情・理由・背景・評価・感想・つなぎ・挨拶の語で、作るものの動作・対象・条件・制約を加えないものは、not-a-condition とする。",
    why: "P2 の誤指摘の多くはこの型である",
    since: "Issue #967",
    modes: ["M-21"],
  },
  {
    id: "R-rfc-04",
    text: "断片が、作るものの動作・対象・時点・期限・数量・否定・例外・適用の範囲・指定の文言のいずれかを運び、それがどの要件の本文にも表されていなければ、missing とする。",
    why: "R-rcm-01 の条件の種類と同じ線で、本当の欠落を保つ",
    since: "Issue #967",
    modes: ["M-21"],
  },
  {
    id: "R-rfc-05",
    text: "迷うときは missing とする。",
    why: "外すことは門を緩める。見逃し（黙った欠落）は挙げすぎより重い（R-rcm-04 と同じ向き）",
    since: "Issue #967",
    modes: ["M-21"],
  },
];

/** 確かめ役の規則の文（定義の順のまま） */
export function findingCheckRules(): readonly string[] {
  return ruleTexts(FINDING_CHECK_RULE_DEFINITIONS);
}

/** 確かめ役の判定（**有限の 3 つ**） */
export const FINDING_CHECK_VERDICTS = ["missing", "carried", "not-a-condition"] as const;
export type FindingCheckVerdict = (typeof FINDING_CHECK_VERDICTS)[number];

/** 確かめ役の答え */
export interface FindingCheckAnswer {
  readonly verdict: FindingCheckVerdict;
  readonly requirementIds: readonly string[];
  readonly reason: string;
}

/** 確かめ役の JSON Schema（構造化出力。strict） */
export const FINDING_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "requirement_ids", "reason"],
  properties: {
    verdict: {
      type: "string",
      enum: [...FINDING_CHECK_VERDICTS],
      description: "missing（欠落である）・carried（要件の本文に表されている）・not-a-condition（条件ではない）のいずれか",
    },
    requirement_ids: {
      type: "array",
      items: { type: "string" },
      description: "carried のとき、内容を表している要件の ID（一覧の ID だけを書く）",
    },
    reason: { type: "string", description: "判定の理由（短く）" },
  },
} as const;

/** 確かめ役が受け取るもの（原文・一覧・指摘の範囲と、それを含む文だけ） */
export interface FindingCheckInput {
  readonly source: string;
  /** その往復の一覧（要件の id・本文・引用と、枠の引用だけを渡す） */
  readonly list: RequirementList;
  /** 指摘の範囲（原文の上の位置） */
  readonly range: SourceRange;
  /** 指摘の範囲を含む文（`splitSourceSentences` の文。複数の文にまたがればすべて） */
  readonly sentences: readonly string[];
  readonly gateway: CallGateway;
}

/** 確かめ役の応答の形を確かめる */
export function checkFindingCheckOutput(output: unknown): ShapeCheck<FindingCheckAnswer> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", code: "shape", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  const verdict = output["verdict"];
  if (typeof verdict !== "string" || !(FINDING_CHECK_VERDICTS as readonly string[]).includes(verdict)) {
    problems.push({ field: "verdict", code: "shape", message: "missing・carried・not-a-condition のいずれかであること" });
  }
  const rawIds = output["requirement_ids"];
  const requirementIds: string[] = [];
  if (!Array.isArray(rawIds)) {
    problems.push({ field: "requirement_ids", code: "shape", message: "文字列の並び（array）であること" });
  } else {
    rawIds.forEach((item, index) => {
      if (typeof item !== "string") {
        problems.push({ field: `requirement_ids[${index}]`, code: "shape", message: "文字列であること" });
        return;
      }
      requirementIds.push(item);
    });
  }
  const reason = output["reason"];
  if (typeof reason !== "string") {
    problems.push({ field: "reason", code: "shape", message: "文字列であること" });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      verdict: verdict as FindingCheckVerdict,
      requirementIds,
      reason: reason as string,
    },
  };
}

/**
 * 確かめ役の要求を組み立て、1 回だけ呼ぶ（形のやり直しは共通の口と同じ 1 回）。
 *
 * データは**原文・その往復の一覧・指摘の範囲と含む文**の 3 つだけである。文書（契約など）は渡さない。
 * 同じ指摘の 3 回の要求が byte で同じになるよう、データの並びと直列化を固定する。
 */
export async function runFindingCheck(input: FindingCheckInput): Promise<StageOutcome<FindingCheckAnswer>> {
  const framings = (input.list.framing ?? []).map((framing) => ({ quote: framing.quote }));
  const listText = serializeJson({
    requirements: input.list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      quote: requirement.quote,
    })),
    framing: framings,
  });
  const rangeText = serializeJson({
    text: input.source.slice(input.range.start, input.range.end),
    start: input.range.start,
    end: input.range.end,
    sentences: input.sentences.slice(),
  });
  const request = buildStructuredRequest({
    rules: findingCheckRules(),
    documents: [],
    data: [
      { name: "原文", text: input.source },
      { name: "要件の一覧", text: listText },
      { name: "指摘の範囲", text: rangeText },
    ],
    schemaName: FINDING_CHECK_SCHEMA_NAME,
    schema: FINDING_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("finding-check"),
  });
  return callStructuredChecked(input.gateway, { request, check: checkFindingCheckOutput });
}

/**
 * 1 回の判定を、3 回の一致に使う形へ正規化する（Issue #967）。`carried` で要件 ID が空か、一覧に無い ID を
 * 含む回は **missing と数える**（形の抑え。意味の正しさは見ない）。それ以外は判定をそのまま返す。
 */
export function normalizeFindingCheckVerdict(
  list: RequirementList,
  answer: FindingCheckAnswer,
): FindingCheckVerdict {
  if (answer.verdict !== "carried") return answer.verdict;
  if (answer.requirementIds.length === 0) return "missing";
  const known = new Set(list.requirements.map((requirement) => requirement.id));
  if (!answer.requirementIds.every((id) => known.has(id))) return "missing";
  return "carried";
}
