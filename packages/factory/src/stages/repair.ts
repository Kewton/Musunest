// ⑥ 直す（道具付き）と、その往復（02-architecture.md §1・§1.3・§1.4・§1.5・§2.2・§4）。
//
// 直す役は**道具付き**で呼ぶ（共通の契約の往復の型。llm.ts の `LlmToolRequest`・`LlmToolResponse`）。
// ④⑤ の結果（静的チェック・試験・対応表）を受けて宣言を直し、道具（tools.ts の 3 つ）で自分で直した
// 候補を試す。**道具の引数はコードが形と値を確かめ**（tools.ts）、宣言の大きさ・道具の回数の上限を
// 当てる（§1.5）。
//
// **直す役は試験と要件の一覧を変えられない**（§1.3）。直した宣言と、受け付けた「期待は誤り」の主張
// （原文の引用つき。引用が実在しなければ受け付けない＝捏造を弾く）だけを返す。試験を書き換える欄を
// 返せば形の誤りとして断る。
//
// 外側（往復の回数・打ち切り・合否）はコードが決める（§1.1）：
//   - 直した後は、静的チェック・対応表・固定した試験を、**最後の版に対して必ず流し直す**（④⑤）
//   - 直しで前に通っていたものが落ちた（回帰）は、それも不一致として数える（§1）
//   - 主張があれば ⑥'（arbitrate.ts）へ渡し、維持・棄却・裁定不能を受ける（§1.3）
//   - 結果に付ける宣言の SHA-256 は、**流し直した版のもの**だけにする（古い版の結果に新しい版の
//     SHA-256 を付けない。§4）
//   - 往復の上限に触れたら、最後に静的チェックを通った版と、その版の流し直しの結果を返す（§1.5）
import { sha256Hex } from "@musunest/spec-engine";
import type { CallGateway, CallResult } from "../call.js";
import { checkDeclarationBytes, type AgentLimits } from "../limits.js";
import type { LlmToolRequest, LlmToolResponse, LlmToolResult, LlmTurn } from "../llm.js";
import type {
  ArbitrationResult,
  CorrespondenceEntry,
  CorrespondenceResult,
  Declaration,
  Dispute,
  OverturnedTest,
  RejectedDispute,
  RepairLoopResult,
  RepairResult,
  RequirementList,
  TestMismatch,
  TestRunResult,
  TestSuite,
  VersionChecks,
} from "../pipeline.js";
import { runArbitration } from "./arbitrate.js";
import { checkCorrespondence } from "./correspondence.js";
import {
  COMMON_RULES,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageFailure,
  type StageOutcome,
} from "./prompt.js";
import { runStaticCheck } from "./static-check.js";
import { runTests } from "./run-tests.js";
import {
  checkToolArguments,
  checkToolCallBudget,
  executeRepairTool,
  REPAIR_TOOLS,
  type RepairToolContext,
} from "./tools.js";
import { utf8ByteLength } from "./write.js";

/** ⑥ に足す規則（共通の規則は先頭に付ける。§1.3・§2.2） */
export const REPAIR_RULES: readonly string[] = [
  "あなたは、静的チェック・試験の結果・対応表の落ちを受けて、宣言（app.spec.yaml の原文）を直す役である。",
  "道具（静的チェック・試験の実行・対応表の確認）で、直した宣言の候補を自分で試してよい。",
  "固定した試験と要件の一覧は変えられない。試験を書き換えたり、要件を増減させたりしない。",
  "「この期待は誤り」と主張してよいのは、原文からの引用を添えたときだけである。引用は原文からそのまま写す。",
  "直し終えたら、応答を done にして、直した宣言（declaration）と主張（disputes）だけを返す。",
];

/** ⑥ の応答を確かめた結果（直した宣言と、受け付けた／受け付けなかった主張） */
export interface RepairAnswer {
  readonly declaration: Declaration;
  readonly disputes: readonly Dispute[];
  readonly rejected: readonly RejectedDispute[];
}

/**
 * ⑥ の応答（done の中身）の形を確かめる（§1.3・§2.2）。
 *
 *   - `declaration` が空でない文字列（YAML の原文）で、大きさが上限（§1.5）に収まっていること
 *   - `disputes` が並びで、各主張は試験の識別子を持つこと
 *   - **試験と要件の一覧を書き換える欄（`tests`・`requirements` など）は返せない**——余分な欄があれば断る
 *   - 主張は、**原文に実在する引用**を添えたときだけ受け付ける。引用が無い・実在しない・一覧に無い試験の
 *     主張は `rejected` に理由つきで残す（捏造を弾く）
 */
export function checkRepairAnswer(
  value: unknown,
  source: string,
  testIds: ReadonlySet<string>,
): ShapeCheck<RepairAnswer> {
  if (!isRecord(value)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "declaration" && key !== "disputes") {
      problems.push({ field: key, message: `直す役は欄 ${key} を返せない（直せるのは宣言だけ）` });
    }
  }
  const declaration = value["declaration"];
  if (typeof declaration !== "string" || declaration === "") {
    problems.push({ field: "declaration", message: "直した宣言は空でない文字列（YAML の原文）であること" });
  } else {
    const exceeded = checkDeclarationBytes(utf8ByteLength(declaration));
    if (exceeded !== undefined) {
      problems.push({
        field: "declaration",
        message: `宣言が上限 ${exceeded.max} バイトを超えている（${exceeded.actual}）`,
      });
    }
  }

  const disputes: Dispute[] = [];
  const rejected: RejectedDispute[] = [];
  const rawDisputes = value["disputes"];
  if (rawDisputes !== undefined) {
    if (!Array.isArray(rawDisputes)) {
      problems.push({ field: "disputes", message: "主張の並び（array）であること" });
    } else {
      rawDisputes.forEach((item, index) => {
        const field = `disputes[${index}]`;
        if (!isRecord(item)) {
          problems.push({ field, message: "主張は写像（object）であること" });
          return;
        }
        const testId = item["testId"];
        if (typeof testId !== "string" || testId === "") {
          problems.push({ field: `${field}.testId`, message: "試験 ID は空でない文字列であること" });
          return;
        }
        const quote = typeof item["quote"] === "string" ? item["quote"] : "";
        if (!testIds.has(testId)) {
          rejected.push({ testId, quote, reason: "一覧に無い試験 ID は主張できない（試験を書き換えられない）" });
          return;
        }
        if (quote === "") {
          rejected.push({ testId, quote, reason: "原文の引用が無い主張は受け付けない" });
          return;
        }
        if (!source.includes(quote)) {
          rejected.push({ testId, quote, reason: "引用が原文に実在しない（捏造）" });
          return;
        }
        disputes.push({ testId, quote });
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: { declaration: { source: declaration as string }, disputes, rejected },
  };
}

/** データとして囲む区切り（規則ではなくデータであることを、文字の上でも分かるようにする。§2.2） */
function wrapData(block: PromptData): string {
  return `<data name="${block.name}">\n${block.text}\n</data>`;
}

/** ⑥ の応答（done）を、共通の口を通して取るための計画 */
type ToolPlan = Omit<LlmToolRequest, "turns">;

/** ⑥ が受け取るもの（ある版の結果を受けて、宣言を直す。§1） */
export interface RepairStepInput {
  readonly source: string;
  readonly list: RequirementList;
  readonly suite: TestSuite;
  /** 直す対象の版と、その版の ④⑤ の結果 */
  readonly current: VersionChecks;
  /** ⑤a が挙げた場所（直しても変わらない。コードが実在を確かめ直す） */
  readonly correspondences: readonly CorrespondenceEntry[];
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** ⑥ のデータ（その段に渡すと決めた文脈だけ。§2.2） */
function buildRepairData(input: RepairStepInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: "原文", text: input.source },
    { name: "要件の一覧", text: serializeJson(input.list) },
    { name: "固定した試験", text: serializeJson(input.suite) },
    { name: "宣言", text: input.current.declaration.source },
    {
      name: "静的チェックの結果",
      text: serializeJson({
        passed: input.current.staticCheck.passed,
        diagnostics: input.current.staticCheck.diagnostics,
      }),
    },
  ];
  if (input.current.correspondence !== null) {
    data.push({ name: "対応表の落ち", text: serializeJson(input.current.correspondence.misses) });
  }
  if (input.current.testRun !== null) {
    data.push({ name: "試験の結果", text: serializeJson(input.current.testRun) });
  }
  return data;
}

/** 共通の口の失敗を、段の失敗に写す */
type ToolCallFailure = Exclude<CallResult<LlmToolResponse>, { readonly kind: "ok" }>;

function mapGatewayFailure(result: ToolCallFailure): StageFailure {
  switch (result.kind) {
    case "deadlineExceeded":
      return { kind: "deadline" };
    case "budgetExceeded":
      return { kind: "budget", maxCostUsd: result.maxCostUsd, remainingUsd: result.remainingUsd };
    case "limitExceeded":
      return { kind: "callLimit", limit: result.limit, max: result.max, actual: result.actual };
    case "incomplete":
      return { kind: "incomplete", reason: result.reason };
    case "invalidRequest":
      return { kind: "invalidRequest", code: result.code };
    case "failed":
      return { kind: "refused", attempts: result.attempts };
  }
}

/**
 * ⑥ を 1 往復ぶん回す（道具付き）。**直した宣言と主張だけ**を返す（直す役は試験と要件を変えられない）。
 *
 * 道具の呼び出しごとに、引数をコードが確かめ（形・値・宣言の大きさ）、回数の上限に照らす。合わなければ
 * 呼ばずに断る。道具の結果は往復（`turns`）へ積み、会話の状態はこちらで組み立てて毎回送る（§2）。
 */
export async function runRepairStep(input: RepairStepInput): Promise<StageOutcome<RepairResult>> {
  const testIds = new Set(input.suite.tests.map((test) => test.id));
  const plan: ToolPlan = {
    instructions: COMMON_RULES.join("\n"),
    documents: input.documents.map((document) => `${document.name}\n${document.text}`),
    rules: REPAIR_RULES,
    input: buildRepairData(input).map(wrapData).join("\n"),
    tools: REPAIR_TOOLS,
    maxOutputTokens: input.gateway.maxOutputTokens("repair"),
  };
  const context: RepairToolContext = {
    list: input.list,
    suite: input.suite,
    correspondences: input.correspondences,
  };

  let turns: readonly LlmTurn[] = [];
  let toolCalls = 0;
  while (true) {
    const result = await input.gateway.callWithTools({ ...plan, turns });
    if (result.kind !== "ok") return { ok: false, failure: mapGatewayFailure(result) };
    const response = result.value;
    if (response.kind === "done") {
      const checked = checkRepairAnswer(response.declaration, input.source, testIds);
      if (!checked.ok) {
        return { ok: false, failure: { kind: "malformed", attempts: 1, problems: checked.problems } };
      }
      return { ok: true, value: checked.value };
    }

    const budget = checkToolCallBudget(toolCalls, response.toolCalls.length);
    if (budget !== undefined) {
      return { ok: false, failure: { kind: "callLimit", limit: budget.limit, max: budget.max, actual: budget.actual } };
    }
    const results: LlmToolResult[] = [];
    for (const toolCall of response.toolCalls) {
      const checked = checkToolArguments(toolCall.name, toolCall.arguments);
      if (!checked.ok) {
        return { ok: false, failure: { kind: "unmet", attempts: 1, problems: checked.problems } };
      }
      const output = await executeRepairTool(checked.call, context);
      results.push({ toolCallId: toolCall.id, name: toolCall.name, output });
    }
    toolCalls += response.toolCalls.length;
    turns = [...turns, { role: "assistant", toolCalls: response.toolCalls }, { role: "tool", results }];
  }
}

/** 流し直しに必要な、直しても変わらない文脈 */
export interface RerunContext {
  readonly list: RequirementList;
  readonly suite: TestSuite;
  readonly correspondences: readonly CorrespondenceEntry[];
}

/**
 * ある版の宣言を、静的チェック・対応表・固定した試験に**流し直す**（§1）。
 * 宣言の SHA-256 は**この版のバイト列**から求める（古い版の結果へ付け替えない。§4）。
 * 静的チェックを通らなければ、⑤a 以降は流さず `null` を返す（成果物を返さない）。
 */
export async function checkDeclarationVersion(
  declaration: Declaration,
  context: RerunContext,
): Promise<VersionChecks> {
  const declarationSha256 = await sha256Hex(declaration.source);
  const staticCheck = await runStaticCheck(declaration);
  if (!staticCheck.passed || staticCheck.app === null) {
    return { declaration, declarationSha256, staticCheck, correspondence: null, testRun: null };
  }
  const misses = checkCorrespondence(staticCheck.app, context.list, context.correspondences);
  const correspondence: CorrespondenceResult = { entries: context.correspondences, misses };
  const testRun = runTests({ app: staticCheck.app, suite: context.suite, correspondence });
  return { declaration, declarationSha256, staticCheck, correspondence, testRun };
}

/** ⑥ の往復（直す → 流し直す → 裁定）を回す材料 */
export interface RepairLoopInput extends RerunContext {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** 直しに入る前の版（③ で書いた宣言と、その ④⑤ の結果） */
  readonly initial: VersionChecks;
  readonly limits: AgentLimits;
}

/** 試験の組のうち、落ちていないもの（一致した試験）の識別子を集める */
function passingIds(suite: TestSuite, testRun: TestRunResult | null): ReadonlySet<string> {
  const failing = new Set<string>();
  if (testRun !== null) {
    for (const mismatch of testRun.mismatches) failing.add(mismatch.testId);
    for (const unresolved of testRun.unresolved) failing.add(unresolved.testId);
  }
  return new Set(suite.tests.filter((test) => !failing.has(test.id)).map((test) => test.id));
}

/** すべて満たしているか（静的チェック通過・対応表の落ち 0・不一致 0・未解決 0。§1.4） */
function isSettled(current: VersionChecks, unresolved: readonly string[]): boolean {
  if (!current.staticCheck.passed) return false;
  if (current.correspondence === null || current.correspondence.misses.length > 0) return false;
  if (current.testRun === null) return false;
  if (current.testRun.mismatches.length > 0 || current.testRun.unresolved.length > 0) return false;
  return unresolved.length === 0;
}

/**
 * ⑥ → 流し直し（④⑤）→ ⑥' を、上限まで回す（§1・§1.3・§1.5）。
 *
 * 直した後は**必ず**最後の版へ流し直し、直しによる回帰は不一致として数える。主張は ⑥' で裁定し、
 * 棄却された試験は外す。上限に触れたら、最後に静的チェックを通った版と、その版の流し直しの結果を返す。
 */
export async function runRepairLoop(input: RepairLoopInput): Promise<StageOutcome<RepairLoopResult>> {
  const versions: VersionChecks[] = [input.initial];
  let current = input.initial;
  let lastPassed: VersionChecks | null = input.initial.staticCheck.passed ? input.initial : null;
  let rounds = 0;
  let limitReached = false;
  const upheld: string[] = [];
  const overturned: OverturnedTest[] = [];
  const unresolved: string[] = [];
  const regressions: TestMismatch[] = [];

  const withoutOverturned = (): TestSuite => ({
    tests: input.suite.tests.filter((test) => !overturned.some((entry) => entry.testId === test.id)),
  });

  let settled = passingIds(withoutOverturned(), current.testRun);
  while (!isSettled(current, unresolved)) {
    if (rounds >= input.limits.repairRoundTrips) {
      limitReached = true;
      break;
    }
    rounds += 1;
    const suite = withoutOverturned();
    const step = await runRepairStep({
      source: input.source,
      list: input.list,
      suite,
      current,
      correspondences: input.correspondences,
      documents: input.documents,
      gateway: input.gateway,
    });
    if (!step.ok) return step;

    if (step.value.disputes.length > 0) {
      const arbitration = await runArbitration({
        source: input.source,
        list: input.list,
        suite,
        declaration: step.value.declaration,
        disputes: step.value.disputes,
        documents: input.documents,
        gateway: input.gateway,
      });
      if (!arbitration.ok) return arbitration;
      collectArbitration(arbitration.value, upheld, overturned, unresolved);
    }

    const checks = await checkDeclarationVersion(step.value.declaration, {
      list: input.list,
      suite: withoutOverturned(),
      correspondences: input.correspondences,
    });
    const nowPassing = passingIds(withoutOverturned(), checks.testRun);
    for (const testId of settled) {
      if (!nowPassing.has(testId)) {
        regressions.push({ testId, detail: "直しで前に通っていた試験が落ちた（回帰）" });
      }
    }
    versions.push(checks);
    current = checks;
    settled = nowPassing;
    if (checks.staticCheck.passed) lastPassed = checks;
  }

  const final = lastPassed ?? input.initial;
  return {
    ok: true,
    value: {
      final,
      versions,
      rounds,
      limitReached,
      regressions,
      upheld,
      overturned,
      unresolved,
      list: input.list,
      suite: withoutOverturned(),
    },
  };
}

/** ⑥' の裁定を、重複させずに集める */
function collectArbitration(
  result: ArbitrationResult,
  upheld: string[],
  overturned: OverturnedTest[],
  unresolved: string[],
): void {
  for (const testId of result.upheld) if (!upheld.includes(testId)) upheld.push(testId);
  for (const entry of result.overturned) {
    if (!overturned.some((candidate) => candidate.testId === entry.testId)) overturned.push(entry);
  }
  for (const testId of result.unresolved) if (!unresolved.includes(testId)) unresolved.push(testId);
}
