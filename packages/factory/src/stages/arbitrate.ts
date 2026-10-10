// ⑥' 期待の裁定（02-architecture.md §1・§1.3・R-2）。
//
// 直す役が「この期待は誤り」と主張したときだけ呼ぶ**別の会話**である。原文・要件の一覧・固定した試験・
// 宣言を渡し、**原文の引用を根拠に**、期待が誤りかを裁定させる。結果は 3 つ：
//
//   維持（uphold）     … 期待は正しい。宣言を直す（⑥ へ戻す）
//   棄却（overturn）   … 期待が誤り。理由と引用を記録して、その試験を外す
//   裁定不能（undecidable）… 決められない。未解決として残す（⑦ で合格にしない）
//
// 棄却は**原文の引用が実在するときだけ**認める（引用が無い・実在しない棄却は未解決へ落とす）。
// 主張に無い試験 ID を裁定させない（別の会話でも、試験を書き換えさせない）。合否はここでは決めない。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../call.js";
import type {
  ArbitrationResult,
  Declaration,
  Dispute,
  OverturnedTest,
  RequirementList,
  TestSuite,
} from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ⑥' の JSON Schema の名前 */
export const ARBITRATION_SCHEMA_NAME = "expectation-arbitration";

/** 裁定の判断（4 つ。§1.3・§5・Issue #334） */
export const ARBITRATION_VERDICTS = ["uphold", "overturn", "undecidable", "return-to-plan"] as const;
export type ArbitrationVerdict = (typeof ARBITRATION_VERDICTS)[number];

/** ⑥' に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const ARBITRATION_RULES: readonly string[] = [
  "あなたは、直す役が「この期待は誤り」と主張した試験について、原文に戻って裁定する役である。",
  "主張された試験ごとに 1 つの判断を返す。判断は uphold（維持。期待は正しい）・overturn（棄却。期待が誤り）・undecidable（裁定不能）のいずれかである。",
  "棄却（overturn）できるのは、原文からそのまま写した引用を添え、その引用が原文に実在するときだけである。引用の無い棄却は認めない。",
  "原文からは決められないときは undecidable にする。自分の推測で棄却しない。",
  "主張された試験 ID だけを判断する。主張に無い試験 ID を足さない。",
];

/** 確定した仕様を渡したときだけ足す規則（§5・Issue #334）。**正本は確定した仕様**である */
export const ARBITRATION_SETTLED_RULE =
  "「確定した仕様」が与えられたときは、それが正本である。主張が**確定した仕様そのものと食い違う**ときは、維持も棄却もせず return-to-plan（Plan に戻す）にする——仕様を変えるには Plan のやり直し（再確認）が要る。仕様の内側の細かな言い回しだけの食い違いは、これまでどおり原文への引用で裁定する。";

/** ⑥' の JSON Schema（構造化出力） */
export const ARBITRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      description: "主張された試験ごとの判断",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["testId", "verdict", "reason", "quote"],
        properties: {
          testId: { type: "string", description: "裁定する試験の識別子（主張のまま）" },
          verdict: { type: "string", enum: [...ARBITRATION_VERDICTS] },
          reason: { type: "string", description: "判断の理由（棄却のときは必須）" },
          quote: { type: "string", description: "棄却の根拠にした、原文に実在する引用（棄却のときは必須）" },
        },
      },
    },
  },
} as const;

/** ⑥' が受け取るもの（原文・要件の一覧・試験・宣言と、直す役の主張。§1.3） */
export interface ArbitrationInput {
  readonly source: string;
  readonly list: RequirementList;
  readonly suite: TestSuite;
  readonly declaration: Declaration;
  readonly disputes: readonly Dispute[];
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /**
   * 確定した仕様（`plan.json`。§5・Issue #334）。渡されたときは、これが正本である——主張が仕様そのものと
   * 食い違えば、裁定せず `return-to-plan`（Plan に戻す）にする。
   */
  readonly plan?: ConfirmedPlan;
}

/** 会話が返した 1 つの判断 */
interface RawDecision {
  readonly testId: string;
  readonly verdict: ArbitrationVerdict;
  readonly reason: string;
  readonly quote: string;
}

/**
 * ⑥' の応答の形を確かめ、裁定の結果に写す（§1.3・§5・Issue #334）。
 *
 *   - 主張された試験 ID の判断だけを受け付ける（主張に無い ID・重なった ID は断る）
 *   - 棄却は、理由と、原文に実在する引用がそろっているときだけ認める（そろわなければ未解決へ）
 *   - 判断の無い主張は未解決として残す（黙って合格にしない）
 *   - **確定した仕様を渡したとき**、`return-to-plan`（仕様と食い違う）の判断は `returnToPlan` に入れる。
 *     確定した仕様が無いときの `return-to-plan` は、戻す先が無いので未解決へ落とす
 */
export function checkArbitrationOutput(
  output: unknown,
  disputes: readonly Dispute[],
  source: string,
  plan?: ConfirmedPlan,
): ShapeCheck<ArbitrationResult> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["decisions"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "decisions", message: "判断の並び（array）であること" }] };
  }
  const disputed = new Set(disputes.map((dispute) => dispute.testId));
  const problems: Problem[] = [];
  const decided = new Map<string, RawDecision>();
  raw.forEach((item, index) => {
    const field = `decisions[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "判断は写像（object）であること" });
      return;
    }
    const testId = item["testId"];
    if (typeof testId !== "string" || testId === "") {
      problems.push({ field: `${field}.testId`, message: "試験 ID は空でない文字列であること" });
      return;
    }
    if (!disputed.has(testId)) {
      problems.push({ field: `${field}.testId`, message: `主張に無い試験 ID は裁定できない: ${testId}` });
      return;
    }
    if (decided.has(testId)) {
      problems.push({ field: `${field}.testId`, message: `試験 ${testId} の判断が重なっている` });
      return;
    }
    const verdict = item["verdict"];
    if (typeof verdict !== "string" || !(ARBITRATION_VERDICTS as readonly string[]).includes(verdict)) {
      problems.push({
        field: `${field}.verdict`,
        message: `判断は ${ARBITRATION_VERDICTS.join("・")} のいずれかであること`,
      });
      return;
    }
    const reason = typeof item["reason"] === "string" ? item["reason"] : "";
    const quote = typeof item["quote"] === "string" ? item["quote"] : "";
    decided.set(testId, { testId, verdict: verdict as ArbitrationVerdict, reason, quote });
  });
  if (problems.length > 0) return { ok: false, problems };

  const upheld: string[] = [];
  const overturned: OverturnedTest[] = [];
  const unresolved: string[] = [];
  const returnToPlan: string[] = [];
  for (const dispute of disputes) {
    const decision = decided.get(dispute.testId);
    if (decision === undefined) {
      unresolved.push(dispute.testId);
      continue;
    }
    if (decision.verdict === "uphold") {
      upheld.push(dispute.testId);
      continue;
    }
    if (decision.verdict === "return-to-plan") {
      // 仕様を変えるには Plan のやり直しが要る。戻す先（確定した仕様）が無ければ未解決へ落とす
      if (plan === undefined) {
        unresolved.push(dispute.testId);
      } else {
        returnToPlan.push(dispute.testId);
      }
      continue;
    }
    if (
      decision.verdict === "overturn" &&
      decision.reason !== "" &&
      decision.quote !== "" &&
      source.includes(decision.quote)
    ) {
      overturned.push({ testId: dispute.testId, reason: decision.reason, quote: decision.quote });
      continue;
    }
    unresolved.push(dispute.testId);
  }
  return { ok: true, value: { upheld, overturned, unresolved, returnToPlan } };
}

/** ⑥' のデータ（その段に渡すと決めた文脈だけ。§2.2）。確定した仕様があるときは、それを正本として渡す */
function buildData(input: ArbitrationInput): readonly PromptData[] {
  const basis: PromptData =
    input.plan === undefined
      ? { name: "原文", text: input.source }
      : { name: "確定した仕様", text: serializeJson(input.plan) };
  return [
    basis,
    { name: "要件の一覧", text: serializeJson(input.list) },
    { name: "固定した試験", text: serializeJson(input.suite) },
    { name: "宣言", text: input.declaration.source },
    { name: "直す役の主張", text: serializeJson(input.disputes) },
  ];
}

/**
 * ⑥' を 1 回呼ぶ。形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 * 裁定は**コードの検査（`checkArbitrationOutput`）を通ったものだけ**を返す。
 */
export async function runArbitration(input: ArbitrationInput): Promise<StageOutcome<ArbitrationResult>> {
  const request = buildStructuredRequest({
    rules: input.plan === undefined ? ARBITRATION_RULES : [...ARBITRATION_RULES, ARBITRATION_SETTLED_RULE],
    documents: input.documents,
    data: buildData(input),
    schemaName: ARBITRATION_SCHEMA_NAME,
    schema: ARBITRATION_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("arbitration"),
  });
  return callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkArbitrationOutput(output, input.disputes, input.source, input.plan),
  });
}
