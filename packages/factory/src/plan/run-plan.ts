// Plan を 1 回流す口（04-plan-agent.md §2・§3・§6・§8。Issue #363）。
//
// P1〜P6（要件にする・逆照合・洗い出し・目録の点検・質問・答えの反映・照合と確定）を順に回し、
// **確定した仕様**まで進める。**端末にもファイルにも縛られない**——答える役（利用者）は口
// （`PlanResponder`）として外から差し込む。端末・ファイル・評価の利用者役は、この口の実装として外側に置く。
//
// 流れ：P1 要件にする・P2 逆照合（`runReverseCheckLoop`）→ P3 洗い出し（`runSurface`）と目録の点検
// （`runCatalog`）→ P4 質問（`runQuestions`）→ 往復の関数（`nextPlanStep`）で次の一歩を決める →
// 答える役の口で答えを受け取り P5 で反映する（`runAnswers`）→ …（上限は往復をまたいで数える）→
// P6 照合と確定（`runConfirm`）。
//
// 結果は 3 つの形である：**確定した**（`checkConfirmedPlan` を通った仕様）／**確定できない**（残った
// 重大な未解決の事項）／**止まった**（予算・締切・段の失敗・答える役が「やめる」）。
//
// LLM の呼び出しは生成と同じ共通の口（`CallGateway`）を通す。判定の口は #359 の予算の包み
// （`createBudgetedJudge`）で包む。**使った額（USD）と段ごとの記録**（生成の段の記録と同じ形）を結果に
// 入れ、呼ぶ側が Build に残りの予算（`remainingUsd`）を渡せるようにする。
//
// **実 API は呼ばない。** 差し込まれた `LlmClient`・`Judge`・`PlanResponder` だけを使い、鍵もファイルも
// 環境変数も扱わない（CLAUDE.md の不変条件）。
import {
  PLAN_SPEC_SCHEMA_VERSION,
  checkConfirmedPlan,
  type ConfirmedPlan,
  type PlanAcceptedUnwritable,
  type PlanAnswerInput,
  type PlanChange,
  type PlanDecision,
  type PlanInput,
  type PlanOpenIssue,
  type PlanPart,
  type PlanQuestionInput,
  type PlanRequirement,
  type PlanSourceInput,
} from "@musunest/appspec-schema";
import { JobBudget, type TokenRates } from "../budget.js";
import type { BundleJudgeUsage } from "../bundle.js";
import { CallGateway } from "../call.js";
import type { Judge } from "../judge.js";
import { JudgeBudgetExceededError, createBudgetedJudge, type BudgetedJudge } from "../judge-budget.js";
import { AGENT_LIMITS, type AgentLimits } from "../limits.js";
import type { LlmClient } from "../llm.js";
import type { SourceRange } from "../pipeline.js";
import { UsageMeter, usageDelta, type FailureKind, type StageStatus, type UsageSnapshot } from "../record.js";
import type { PromptDocument, StageFailure, StageOutcome } from "../stages/prompt.js";
import { runReverseCheckLoop, splitSourceSentences } from "../stages/reverse-check.js";
import { runAnswers, type ClassifiedAnswer, type PlanAnswerDraft } from "./answers.js";
import { catalogOpenIssue, runCatalog } from "./catalog.js";
import { runConfirm } from "./confirm.js";
import { runQuestions, type PlanQuestion } from "./questions.js";
import {
  nextPlanStep,
  remainingPlanBudget,
  type PlanConfirmationView,
  type PlanRemaining,
  type PlanTurn,
} from "./session.js";
import { runSurface } from "./surface.js";

/** Plan の段（記録の `stage` に使う。生成の段とは別の一覧である） */
export const PLAN_STAGE_IDS = [
  "requirements", // P1 要件にする・P2 逆照合（`runReverseCheckLoop`）
  "catalog", // P3 目録の点検（`runCatalog`）
  "surface", // P3 洗い出し（`runSurface`）
  "questions", // P4 質問を組み立てる（`runQuestions`）
  "answers", // P5 答えを反映する（`runAnswers`）
  "confirm", // P6 照合と確定（`runConfirm`）
] as const;
export type PlanStageId = (typeof PLAN_STAGE_IDS)[number];

/**
 * 判定の確率の閾値の既定（これ**未満**を未指定・未解決と見なす）。生成の
 * `UNWRITABLE_CONFIDENCE_THRESHOLD` と同じ側へ倒す。
 */
export const DEFAULT_PLAN_JUDGE_THRESHOLD = 0.6;

/**
 * Plan の段ごとの記録（生成の段の記録＝`StageRecord` と同じ形）。列挙した欄だけを持つ。
 * `stage` だけが生成の段の名前ではなく、Plan の段の名前（`PlanStageId`）である。
 */
export interface PlanStageRecord {
  readonly stage: PlanStageId;
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly failure_kind: FailureKind | null;
}

/** 早く止まった帰属（どの段の・どの種類の失敗か） */
export interface PlanFailure {
  readonly stage: PlanStageId;
  readonly kind: FailureKind;
}

/** 止まった理由（`declined` は答える役が「やめる」と言ったとき。それ以外は失敗の分類） */
export type PlanStopReason = "declined" | FailureKind;

/** 3 つの結果に共通する記録（使った額・残りの額・段ごとの記録・判定の呼び出し） */
export interface PlanResultBase {
  /** 段ごとの記録（生成の段の記録と同じ形） */
  readonly stages: readonly PlanStageRecord[];
  /** 使った額（USD。LLM と判定の費用を合わせたもの） */
  readonly spentUsd: number;
  /** 残りの予算（USD。呼ぶ側が Build に渡す） */
  readonly remainingUsd: number;
  /** 判定の呼び出しの数（答えた adapter ごと）と費用（USD） */
  readonly judge: BundleJudgeUsage;
}

/** Plan を 1 回流した結果（3 つの形） */
export type PlanResult =
  | ({ readonly kind: "confirmed"; readonly plan: ConfirmedPlan } & PlanResultBase)
  | ({ readonly kind: "cannot-confirm"; readonly openIssues: readonly PlanOpenIssue[] } & PlanResultBase)
  | ({ readonly kind: "stopped"; readonly reason: PlanStopReason; readonly failure: PlanFailure | null } & PlanResultBase);

/** 答える役に渡す、質問の束と残り */
export interface PlanAnswerRequest {
  readonly questions: readonly PlanQuestion[];
  readonly remaining: PlanRemaining;
}

/** 答える役の答え（問いごとの答え、または「全部推奨で進める」） */
export type PlanAnswerOutcome =
  | { readonly kind: "answers"; readonly answers: readonly PlanAnswerDraft[] }
  | { readonly kind: "all-recommended" };

/** 確認の画面への答え（「これで作る」か「やめる」） */
export type PlanConfirmOutcome = "build" | "stop";

/**
 * 答える役の口（port。04 §2・§7）。端末・ファイル・評価の利用者役は、この口の実装として**外側**に置く。
 *
 *   - `answer` … 質問の束と残り（質問の数・往復の数）を受け取り、答えか「全部推奨で進める」を返す
 *   - `confirm` … 確認の画面に出すもの（元の依頼との差分・書けないことと代わりの案）を受け取り、
 *     「これで作る」か「やめる」を返す
 */
export interface PlanResponder {
  answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome>;
  confirm(view: PlanConfirmationView): Promise<PlanConfirmOutcome>;
}

/** `runPlan` が受け取るもの（端末にもファイルにも縛られない） */
export interface PlanRunInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 信頼する文書（契約・語彙の意味・語彙の台帳）。呼ぶ側が文字列で渡す */
  readonly documents: readonly PromptDocument[];
  /** 素の LLM の呼び出し（adapter）。**この file は鍵も環境変数も触らない** */
  readonly client: LlmClient;
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /** 答える役の口（端末・ファイル・評価の利用者役は外側に置く） */
  readonly responder: PlanResponder;
  /** Plan の費用の上限（USD。呼ぶ側が Plan と Build で分けて渡す。§8） */
  readonly budgetUsd: number;
  /** トークンの単価（コードに埋め込まない） */
  readonly rates: TokenRates;
  /** いまの時刻（ミリ秒）。時計は差し込む（試験は固定する） */
  readonly now: () => number;
  /** 締切（ミリ秒。この時刻で打ち切る） */
  readonly deadline: number;
  /** 推論の effort（段の出力の上限と、呼び出しごとの timeout の基準を決める） */
  readonly effort: string;
  /** 仕様の ID（`plan_id`） */
  readonly planId: string;
  /** P3 が照らした文書（語彙）の版（`vocabulary_version`） */
  readonly vocabularyVersion: string;
  /** 確認した人（`confirmed_by`） */
  readonly confirmedBy: string;
  /** 上限（既定は `AGENT_LIMITS`） */
  readonly limits?: AgentLimits;
  /** 呼び出し 1 回ごとの timeout の基準（ミリ秒）。指定しなければ effort から出す */
  readonly callTimeoutMs?: number;
  /** 判定の確率の閾値（既定は `DEFAULT_PLAN_JUDGE_THRESHOLD`） */
  readonly judgeThreshold?: number;
  /** 自由入力の長さの上限（既定は `AGENT_LIMITS.planFreeTextChars`） */
  readonly freeTextMax?: number;
  /** 判定の呼び出しの出力の上界（予約に使う。既定は判定の adapter の既定） */
  readonly judgeMaxOutputTokens?: number;
}

/** 早く止まる合図（`runPlan` の中だけで使う） */
class PlanStop extends Error {
  readonly failure: PlanFailure;
  constructor(failure: PlanFailure) {
    super(`段 ${failure.stage} で止まりました（${failure.kind}）`);
    this.name = "PlanStop";
    this.failure = failure;
  }
}

/** 段の失敗を、記録の失敗の分類に写す（run.ts と同じ扱い） */
function stageFailureToKind(failure: StageFailure): FailureKind {
  switch (failure.kind) {
    case "limit":
      return "limit";
    case "deadline":
      return "deadline";
    case "budget":
      return "budget";
    case "callLimit":
      return "call-limit";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "http":
      return "http";
    case "balance":
      return "balance";
    case "malformed":
      return "malformed";
    case "refused":
      return "refused";
    case "toolArguments":
      return "tool-arguments";
    case "invalidRequest":
      return "invalid-request";
    case "incomplete":
      return "incomplete";
    case "unknown":
      return "unknown";
    case "unmet":
      return "unmet";
  }
}

/** 質問を、確定した仕様の入力（`PlanQuestionInput`）に写す */
function toQuestionInput(question: PlanQuestion): PlanQuestionInput {
  const recommended = question.recommended ?? { choiceId: question.choices[0]?.id ?? "", reason: "" };
  return {
    id: question.id,
    kind: "question",
    open_issue_id: question.openIssueId,
    text: question.text,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    recommended: { choice_id: recommended.choiceId, reason: recommended.reason },
  };
}

/** 答え 1 つを、確定した仕様の入力（`PlanAnswerInput`）に写す。選択肢か自由入力のちょうど一方を持つ */
function toAnswerInput(answer: PlanAnswerDraft): PlanAnswerInput | undefined {
  if (answer.choiceId !== undefined) {
    return { id: answer.id, kind: "answer", question_id: answer.questionId, choice_id: answer.choiceId };
  }
  if (answer.freeText !== undefined && answer.freeText !== "") {
    return { id: answer.id, kind: "answer", question_id: answer.questionId, free_text: answer.freeText };
  }
  return undefined;
}

/** 答えから増えた要件（「足した」の関係と、答えの出どころを持つ） */
function answerRequirement(answerId: string, text: string): PlanRequirement {
  return {
    id: `R:${answerId}`,
    text,
    kind: "constraining",
    origin: { input_id: answerId, quote: text },
    change: { kind: "added", answer_id: answerId },
    parts: [],
  };
}

/** 答えが指す要件の文（選択肢に当たるなら選択肢の文、そうでなければ自由入力） */
function requirementTextOf(answer: ClassifiedAnswer, question: PlanQuestion): string {
  if (answer.choiceId !== undefined) {
    const choice = question.choices.find((candidate) => candidate.id === answer.choiceId);
    if (choice !== undefined) return choice.text;
  }
  return answer.freeText ?? question.text;
}

/**
 * Plan を 1 回流す（04 §2・§3・§6・§8）。
 *
 * 段を決まった順に回し、答える役の口が答えたら答えを反映し、往復の上限（合わせて 10 問・3 往復）まで
 * 進める。上限のあとも重大な未解決の事項が残れば「確定できない」、確認で「やめる」なら「止まった」、
 * 予算・締切・段の失敗でも「止まった」を返す。**確定した仕様は `checkConfirmedPlan` を通ったものだけ**を
 * 「確定した」として返す。
 */
export async function runPlan(input: PlanRunInput): Promise<PlanResult> {
  const limits = input.limits ?? AGENT_LIMITS;
  const threshold = input.judgeThreshold ?? DEFAULT_PLAN_JUDGE_THRESHOLD;
  const meter = new UsageMeter();
  const budget = new JobBudget(input.budgetUsd);
  const gateway = new CallGateway({
    client: meter.wrap(input.client),
    budget,
    rates: input.rates,
    now: input.now,
    deadline: input.deadline,
    limits,
    effort: input.effort,
    ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
  });
  // 判定の口を、**この Plan の予算に結び付けた包み**で包む（#359）。判定の費用も、段の呼び出しと同じ
  // 予算で予約・精算する。予約できなければ判定を呼ばずに `JudgeBudgetExceededError` になる（止まる）。
  const judgeBudget: BudgetedJudge = createBudgetedJudge({
    judge: input.judge,
    budget,
    rates: input.rates,
    ...(input.judgeMaxOutputTokens === undefined ? {} : { maxOutputTokens: input.judgeMaxOutputTokens }),
  });
  const stages: PlanStageRecord[] = [];

  const pushRecord = (
    stage: PlanStageId,
    status: StageStatus,
    before: UsageSnapshot,
    start: number,
    failureKind: FailureKind | null,
  ): void => {
    const delta = usageDelta(before, meter.snapshot);
    stages.push({
      stage,
      status,
      duration_ms: input.now() - start,
      calls: delta.calls,
      missing_usage_calls: delta.missing_usage_calls,
      input_tokens: delta.input_tokens,
      cached_input_tokens: delta.cached_input_tokens,
      cache_write_tokens: delta.cache_write_tokens,
      output_tokens: delta.output_tokens,
      reasoning_tokens: delta.reasoning_tokens,
      failure_kind: failureKind,
    });
  };

  /** 値を返す段（目録の点検・答えの反映・照合と確定）を回し、所要時間とトークンを記録する */
  const runStage = async <T>(stage: PlanStageId, fn: () => Promise<T>): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    try {
      const value = await fn();
      pushRecord(stage, "ok", before, start, null);
      return value;
    } catch (error) {
      if (error instanceof PlanStop) {
        pushRecord(stage, "failed", before, start, error.failure.kind);
        throw error;
      }
      if (error instanceof JudgeBudgetExceededError) {
        pushRecord(stage, "failed", before, start, "budget");
        throw new PlanStop({ stage, kind: "budget" });
      }
      pushRecord(stage, "failed", before, start, "unknown");
      throw error;
    }
  };

  /** LLM の段を回す。**段の失敗は、記録してから早期停止にする**（止めた段と理由を残す） */
  const runStageOutcome = async <T>(stage: PlanStageId, fn: () => Promise<StageOutcome<T>>): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    let value: T;
    try {
      const outcome = await fn();
      if (!outcome.ok) throw new PlanStop({ stage, kind: stageFailureToKind(outcome.failure) });
      value = outcome.value;
    } catch (error) {
      if (error instanceof PlanStop) {
        pushRecord(stage, "failed", before, start, error.failure.kind);
        throw error;
      }
      if (error instanceof JudgeBudgetExceededError) {
        pushRecord(stage, "failed", before, start, "budget");
        throw new PlanStop({ stage, kind: "budget" });
      }
      pushRecord(stage, "failed", before, start, "unknown");
      throw error;
    }
    pushRecord(stage, "ok", before, start, null);
    return value;
  };

  const resultBase = (): PlanResultBase => ({
    stages: stages.slice(),
    spentUsd: budget.spentUsd,
    remainingUsd: budget.remainingUsd,
    judge: { calls_by_adapter: judgeBudget.callsByAdapter, cost_usd: judgeBudget.spentUsd },
  });

  try {
    // ── P1 要件にする・P2 逆照合（① → ①'。落ちがあれば ① を 1 回だけやり直す）────────────
    const reverse = await runStageOutcome("requirements", () =>
      runReverseCheckLoop({ source: input.source, documents: input.documents, gateway }),
    );
    const list = reverse.list;

    // ── 入力（原文）と、原文を覆う要件を組む ──────────────────────────────
    // 原文を文に切り、文ごとに 1 つの `source` の入力を作る（`checkSourceCoverage` が文と入力の本文を
    // 突き合わせるので、本文は文そのものにする）。要件の出どころは、その位置を覆う文の入力にする。
    const sentences = splitSourceSentences(input.source);
    const sourceInputs: PlanSourceInput[] = sentences.map((range, index) => ({
      id: `S-${index + 1}`,
      kind: "source",
      text: input.source.slice(range.start, range.end),
    }));
    const sourceInputFor = (position: SourceRange): string | undefined => {
      const covering =
        sentences.find((range) => range.start < position.end && position.start < range.end) ??
        sentences.find((range) => range.start <= position.start && position.start < range.end);
      if (covering !== undefined) return sourceInputs[sentences.indexOf(covering)]?.id;
      return sourceInputs[0]?.id;
    };

    const questionInputs: PlanQuestionInput[] = [];
    const answerInputs: PlanAnswerInput[] = [];
    const requirements: PlanRequirement[] = list.requirements.flatMap((requirement) => {
      const inputId = sourceInputFor(requirement.position);
      if (inputId === undefined) return [];
      return [
        {
          id: requirement.id,
          text: requirement.text,
          kind: "existence" as const,
          origin: { input_id: inputId, quote: requirement.quote },
          parts: [],
        },
      ];
    });
    const decisions: PlanDecision[] = list.decisions.map((decision, index) => ({
      id: `D-${index + 1}`,
      subject: "既定で決めた",
      value: decision,
      reason: "Plan が既定で決めた（確認の画面で直せる）",
    }));
    const openIssues: PlanOpenIssue[] = list.unresolved.map((text, index) => ({
      id: `OI:unresolved:${index + 1}`,
      text,
      critical: true,
      status: "open",
    }));

    // ── P3 洗い出し（目録に無い曖昧さ）──────────────────────────────
    const surface = await runStageOutcome("surface", () =>
      runSurface({ list, documents: input.documents, gateway }),
    );
    for (const ambiguity of surface.ambiguities) {
      openIssues.push({
        id: ambiguity.id,
        text: ambiguity.text,
        critical: ambiguity.critical,
        status: "open",
      });
    }

    // ── P3 目録の点検（語彙の決めどころ）────────────────────────────
    const catalog = await runStage("catalog", () =>
      runCatalog({
        requirements: list.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
        judge: judgeBudget,
        threshold,
      }),
    );
    for (const facet of catalog.unspecified) openIssues.push(catalogOpenIssue(facet));

    // 書けないことを、了承して除く部分（`accepted_unwritable`）に写す（§4・U-P2）。代わりの案は、
    // 宣言で書ける近い形を 1 つ出したものなので、要件として残し、部分から代わりの案の ID で指す。
    const acceptedUnwritable: PlanAcceptedUnwritable[] = [];
    for (const item of surface.unwritable) {
      const index = requirements.findIndex((requirement) => requirement.id === item.requirementId);
      const target = requirements[index];
      if (target === undefined) continue;
      const alternativeId = `R:alt:${item.id}`;
      const part: PlanPart = { id: `P:${item.id}`, text: item.part, disposition: "accepted_removal" };
      requirements[index] = { ...target, parts: [...target.parts, part] };
      requirements.push({
        id: alternativeId,
        text: item.alternative,
        kind: "existence",
        origin: { input_id: target.origin.input_id, quote: item.alternative },
        parts: [],
      });
      acceptedUnwritable.push({
        part_id: part.id,
        alternative_id: alternativeId,
        basis: {
          doc_version: input.vocabularyVersion,
          location: item.part,
          constraint_id: item.constraintIds[0] ?? "",
        },
      });
    }

    // ── 往復（P4 質問 → 次の一歩 → P5 答えの反映）────────────────────────
    let revision = 1;
    const turns: PlanTurn[] = [];
    const priorAnswers: ClassifiedAnswer[] = [];
    const askedQuestionIds = new Set<string>();
    let followUpQuestions: readonly PlanQuestion[] = [];
    let allRecommended = false;

    const planDraft = () => ({
      schema_version: PLAN_SPEC_SCHEMA_VERSION,
      plan_id: input.planId,
      revision,
      vocabulary_version: input.vocabularyVersion,
      inputs: [...sourceInputs, ...questionInputs, ...answerInputs] as readonly PlanInput[],
      requirements: requirements as readonly PlanRequirement[],
      open_issues: openIssues as readonly PlanOpenIssue[],
      decisions,
      accepted_unwritable: acceptedUnwritable,
    });
    const confirmationView = (): PlanConfirmationView => ({
      plan: planDraft(),
      diff: requirements.flatMap((requirement): readonly PlanChange[] =>
        requirement.change === undefined ? [] : [requirement.change],
      ),
      unwritable: acceptedUnwritable,
    });

    const resolveIssue = (issueId: string, answerId: string): void => {
      const index = openIssues.findIndex((issue) => issue.id === issueId);
      const issue = openIssues[index];
      if (issue === undefined) return;
      openIssues[index] = { ...issue, status: "resolved", resolution: { answer_id: answerId } };
    };

    for (;;) {
      const view = confirmationView();
      const open = openIssues.filter((issue) => issue.status === "open");
      const preRemaining = remainingPlanBudget(turns);
      const willAsk =
        open.length > 0 && !allRecommended && preRemaining.questions > 0 && preRemaining.roundTrips > 0;

      let questions: readonly PlanQuestion[] = [];
      if (willAsk) {
        const generated = await runStageOutcome("questions", () =>
          runQuestions({
            source: input.source,
            openIssues: open,
            remaining: preRemaining.questions,
            revision,
            documents: input.documents,
            gateway,
          }),
        );
        // 前の往復の矛盾から組み立てた問い（まだ未解決の事項に対応するものだけ）を足す（§6 の 7）
        const openIds = new Set(openIssues.map((issue) => issue.id));
        const carried = followUpQuestions.filter((question) => openIds.has(question.openIssueId));
        questions = [...generated, ...carried];
      }

      const step = nextPlanStep({
        source: input.source,
        turns,
        openIssues,
        questions,
        view,
        allRecommended,
      });
      if (step.kind === "cannot-confirm") {
        return { kind: "cannot-confirm", openIssues: step.openIssues, ...resultBase() };
      }
      if (step.kind === "confirm") {
        const decision = await input.responder.confirm(view);
        if (decision === "stop") {
          return { kind: "stopped", reason: "declined", failure: null, ...resultBase() };
        }
        break;
      }

      // ── 質問を出す（P4）。残りの問数の範囲だけを出す ────────────────────
      const asked = step.questions;
      for (const question of asked) {
        if (askedQuestionIds.has(question.id)) continue;
        askedQuestionIds.add(question.id);
        questionInputs.push(toQuestionInput(question));
      }

      const answer = await input.responder.answer({ questions: asked, remaining: step.remaining });

      if (answer.kind === "all-recommended") {
        // 「全部推奨で進める」——どの問いも推奨で閉じ、確認に進む（§2）
        allRecommended = true;
        const drafts: PlanAnswerDraft[] = [];
        for (const question of asked) {
          const recommended = question.recommended;
          if (recommended === undefined) continue;
          const answerId = `A:${question.id}`;
          answerInputs.push({
            id: answerId,
            kind: "answer",
            question_id: question.id,
            choice_id: recommended.choiceId,
          });
          const choice = question.choices.find((candidate) => candidate.id === recommended.choiceId);
          requirements.push(answerRequirement(answerId, choice?.text ?? recommended.reason));
          resolveIssue(question.openIssueId, answerId);
          drafts.push({ id: answerId, questionId: question.id, revision, choiceId: recommended.choiceId });
        }
        turns.push({ questions: asked, answers: drafts });
        revision += 1;
        continue;
      }

      // ── 答えを反映する（P5）。コードで断った答えは要件にしない ────────────
      const answerResult = await runStage("answers", () =>
        runAnswers({
          questions: asked,
          answers: answer.answers,
          revision,
          source: input.source,
          priorAnswers,
          judge: judgeBudget,
          ...(input.freeTextMax === undefined ? {} : { freeTextMax: input.freeTextMax }),
        }),
      );
      const byId = new Map(answer.answers.map((draft) => [draft.id, draft]));
      for (const accepted of answerResult.accepted) {
        const draft = byId.get(accepted.answerId);
        const question = asked.find((candidate) => candidate.id === accepted.questionId);
        if (draft === undefined || question === undefined) continue;
        const text = requirementTextOf(accepted, question);
        if (text === "") continue;
        const answerInput = toAnswerInput(draft);
        if (answerInput === undefined) continue;
        answerInputs.push(answerInput);
        requirements.push(answerRequirement(draft.id, text));
        resolveIssue(question.openIssueId, draft.id);
        priorAnswers.push(accepted);
      }
      // 矛盾から組み立てた問いを、次の往復に回す（§6 の 7）。対応する未解決の事項を開いておく
      for (const followUp of answerResult.followUpQuestions) {
        if (!openIssues.some((issue) => issue.id === followUp.openIssueId)) {
          openIssues.push({
            id: followUp.openIssueId,
            text: followUp.text,
            critical: true,
            status: "open",
          });
        }
      }
      followUpQuestions = answerResult.followUpQuestions;
      turns.push({ questions: asked, answers: answer.answers });
      revision += 1;
    }

    // ── P6 照合と確定。**`checkConfirmedPlan` を通ったものだけ**を「確定した」として返す ──────
    const confirmed = await runStage("confirm", () =>
      runConfirm({
        planId: input.planId,
        revision,
        vocabularyVersion: input.vocabularyVersion,
        source: input.source,
        inputs: [...sourceInputs, ...questionInputs, ...answerInputs],
        requirements,
        openIssues,
        decisions,
        acceptedUnwritable,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date(input.now()).toISOString(),
        judge: judgeBudget,
        threshold,
      }),
    );
    const problems = await checkConfirmedPlan(confirmed.plan);
    if (!confirmed.confirmed || problems.length > 0) {
      return {
        kind: "cannot-confirm",
        openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
        ...resultBase(),
      };
    }
    return { kind: "confirmed", plan: confirmed.plan, ...resultBase() };
  } catch (error) {
    if (error instanceof PlanStop) {
      return { kind: "stopped", reason: error.failure.kind, failure: error.failure, ...resultBase() };
    }
    throw error;
  }
}
