// 段を決まった順に回す部分（02-architecture.md §1・§1.4・§1.5・§3.2）。
//
// 外側（段の順番・記録・打ち切り・合否）はここ（コード）が決める。内側の「書く・直す」段だけを LLM に
// 任せる。**① の入口・前半の段の失敗・依頼文の上限・残高切れ・締切切れ・呼び出しの数の超過**では、
// その場で止め、止めた段と理由を記録する（§1.5・S-7）。
//
// 通常の完走の順序（§1）：①→①'→②→②'→③→④→⑤a・⑤b→（⑥・⑥'）→⑦→⑧。完走する道では、逆照合
// （①'）・試験の固定（②'）・対応表（⑤a）・試験を流す（⑤b）を必ず通す（LLM の出力で段を飛ばさない）。
// **実行していない検査（⑤a・⑤b）を「不一致 0」と扱わない**——④ を通らない版のままなら、静的チェックの
// 不通過として合格にしない（fail-closed。§1.4）。
//
// 共通の口（call.ts）を通してだけ LLM を呼ぶ。adapter は呼ぶ側が渡す（この file は API キーも環境変数も
// 触らない）。単価も引数で受け取る（コードに埋め込まない）。
import { sha256Hex } from "@musunest/spec-engine";
import { JobBudget, type TokenRates } from "./budget.js";
import { CallGateway } from "./call.js";
import { assembleBundle, type AssembledBundle } from "./bundle.js";
import { AGENT_LIMITS, checkRequestText, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { decideOutcome, type Outcome } from "./outcome.js";
import {
  toStageResults,
  type ArbitrationResult,
  type CorrespondenceEntry,
  type CorrespondenceResult,
  type Declaration,
  type Dispute,
  type JudgeMaterials,
  type OverturnedTest,
  type RejectedDispute,
  type TestSuite,
  type VersionChecks,
} from "./pipeline.js";
import {
  buildRunRecord,
  buildSummary,
  makeStageRecord,
  usageDelta,
  UsageMeter,
  type FailureAttribution,
  type FailureKind,
  type RunRecord,
  type StageId,
  type StageRecord,
  type StageStatus,
  type Summary,
  type UsageSnapshot,
} from "./record.js";
import { runArbitration } from "./stages/arbitrate.js";
import { checkCorrespondence, runCorrespondence } from "./stages/correspondence.js";
import { runDesign } from "./stages/design.js";
import type { PromptDocument, StageFailure, StageOutcome } from "./stages/prompt.js";
import { runRepairStep } from "./stages/repair.js";
import { runReverseCheckLoop } from "./stages/reverse-check.js";
import { runTests } from "./stages/run-tests.js";
import { runStaticCheck } from "./stages/static-check.js";
import { runTestSuite } from "./stages/test-suite.js";
import { runWrite } from "./stages/write.js";

/** 手元の入口（cli.ts）と試験が渡す、1 回の生成の入力 */
export interface GenerationInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 信頼する文書（契約・語彙の意味・語彙の台帳）。呼ぶ側から文字列で渡す */
  readonly documents: readonly PromptDocument[];
  /** 素の LLM の呼び出し（adapter）。**この file は API キーも環境変数も触らない** */
  readonly client: LlmClient;
  /** ジョブ全体の費用の上限（USD。§1.5） */
  readonly budgetUsd: number;
  /** トークンの単価（コードに埋め込まない） */
  readonly rates: TokenRates;
  /** いまの時刻（ミリ秒）。時計は差し込む（試験は固定する） */
  readonly now: () => number;
  /** 締切（ミリ秒。この時刻で打ち切る） */
  readonly deadline: number;
  /** 上限（既定は `AGENT_LIMITS`） */
  readonly limits?: AgentLimits;
  readonly runId: string;
  readonly storageUnit: string;
  /** 納品物の水準（既定 `L2`。宣言だけの納品物。§4） */
  readonly artifactLevel?: string;
  /** 工場の識別（`musunest-factory`。S-5） */
  readonly builder: string;
  readonly model: string;
  readonly effort: string;
  readonly promptVersion: string;
  readonly contractVersion: string;
  readonly specEngineVersion: string;
  readonly factoryVersion: string;
  /** 検証の道具の profile（manifest の `instrument.verification_profile`） */
  readonly verificationProfile?: string;
}

/** 1 回の生成の結果 */
export interface GenerationResult {
  /** ⑦ の合否 */
  readonly outcome: Outcome;
  /** 段ごとの記録（要約に入る欄も持つ） */
  readonly record: RunRecord;
  /** 納品物の要約（appspec-schema の wire。手元の入口が最後の行に出す） */
  readonly summary: Summary;
  /** ⑧ の納品物。早期停止では `null`（宣言まで届かなかった） */
  readonly bundle: AssembledBundle | null;
  /** 早期停止の帰属（どの段の・どの種類の失敗か）。完走なら `null` */
  readonly stopped: FailureAttribution | null;
}

/** 早期停止を、段の外へ伝えるための合図（runGeneration の中でだけ使う） */
class RunStop extends Error {
  readonly attribution: FailureAttribution;
  constructor(attribution: FailureAttribution) {
    super(`段 ${attribution.stage} で止まりました（${attribution.kind}）`);
    this.name = "RunStop";
    this.attribution = attribution;
  }
}

/** 段の失敗を、記録の失敗の分類に写す（§2.2・S-7） */
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
    case "malformed":
      return "malformed";
    case "refused":
      return "refused";
    case "unmet":
      return "unmet";
  }
}

/** 要約の `assurance`（試験と対応表が覆った範囲。§4） */
function assuranceOf(outcome: Outcome): string {
  if (outcome.result === "pass") return "full";
  if (outcome.result === "partial") return "partial";
  return "none";
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

/**
 * 段を順に回して、1 回の生成を流す（§1・§1.4・§1.5）。
 *
 * 早期停止では `bundle` を返さない（⑧ へ届かない）。完走では、合否・記録・要約・納品物を返す。
 * **合否はコード（`decideOutcome`）が決める**（LLM の自己申告では合格させない）。
 */
export async function runGeneration(input: GenerationInput): Promise<GenerationResult> {
  const limits = input.limits ?? AGENT_LIMITS;
  const meter = new UsageMeter();
  const budget = new JobBudget(input.budgetUsd);
  const gateway = new CallGateway({
    client: meter.wrap(input.client),
    budget,
    rates: input.rates,
    now: input.now,
    deadline: input.deadline,
    limits,
  });
  const startedAt = input.now();
  const stages: StageRecord[] = [];
  const upheld: string[] = [];
  const overturned: OverturnedTest[] = [];
  const unresolved: string[] = [];
  const disputes: Dispute[] = [];
  const rejected: RejectedDispute[] = [];

  const pushRecord = (
    stage: StageId,
    status: StageStatus,
    before: UsageSnapshot,
    start: number,
    failureKind: FailureKind | null,
  ): void => {
    stages.push(
      makeStageRecord(stage, status, input.now() - start, usageDelta(before, meter.snapshot), failureKind),
    );
  };

  /** 値を返す段（④・⑤b・⑦）を回し、所要時間とトークンを記録する */
  const runStage = async <T>(stage: StageId, fn: () => Promise<T>): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    try {
      const value = await fn();
      pushRecord(stage, "ok", before, start, null);
      return value;
    } catch (error) {
      pushRecord(stage, "failed", before, start, error instanceof RunStop ? error.attribution.kind : null);
      throw error;
    }
  };

  /**
   * LLM の段を回す。**段の失敗は、記録してから早期停止にする**（止めた段と理由を残す。S-7）。
   * 失敗は `runStage` の内側で判定するので、その段の記録は `failed` になる。
   */
  const runStageOk = async <T>(stage: StageId, fn: () => Promise<StageOutcome<T>>): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    let value: T;
    try {
      const outcome = await fn();
      if (!outcome.ok) throw new RunStop({ stage, kind: stageFailureToKind(outcome.failure) });
      value = outcome.value;
    } catch (error) {
      pushRecord(stage, "failed", before, start, error instanceof RunStop ? error.attribution.kind : null);
      throw error;
    }
    pushRecord(stage, "ok", before, start, null);
    return value;
  };

  const buildRecord = (failure: FailureAttribution | null): RunRecord =>
    buildRunRecord({
      builder: input.builder,
      model: input.model,
      effort: input.effort,
      prompt_version: input.promptVersion,
      contract_version: input.contractVersion,
      spec_engine_version: input.specEngineVersion,
      factory_version: input.factoryVersion,
      stages: stages.slice(),
      arbitration: { upheld: upheld.length, overturned: overturned.length, undecidable: unresolved.length },
      budget_remaining_usd: budget.remainingUsd,
      missing_usage_calls: meter.snapshot.missing_usage_calls,
      failure,
    });

  const stopResult = (attribution: FailureAttribution): GenerationResult => {
    const outcome: Outcome = { result: "failed", verdict: "none" };
    const record = buildRecord(attribution);
    const summary = buildSummary(record, {
      run_id: input.runId,
      verdict: "none",
      assurance: "none",
      duration_secs: (input.now() - startedAt) / 1000,
      provider_cost_usd: budget.spentUsd,
      stop_class: attribution.kind,
      exit_code: 1,
    });
    return { outcome, record, summary, bundle: null, stopped: attribution };
  };

  try {
    // ① の入口：依頼文の上限。超えていれば LLM を呼ばずに止める（§1.5）
    if (checkRequestText(input.source) !== undefined) {
      pushRecord("requirements", "failed", meter.snapshot, input.now(), "limit");
      throw new RunStop({ stage: "requirements", kind: "limit" });
    }

    // ① → ①'（逆照合。落ちがあれば ① を 1 回だけやり直す。§1）
    const requirementList = await runStageOk("reverse-check", () =>
      runReverseCheckLoop({ source: input.source, documents: input.documents, gateway }),
    );
    const carriedReverseCheck = requirementList.unmet.map((miss) => `${miss.kind}: ${miss.detail}`);

    // ② 設計する（書けない要件の数を、⑦ のために数えておく）
    const design = await runStageOk("design", () =>
      runDesign({ list: requirementList.list, documents: input.documents, gateway }),
    );
    const unwritableRequirements = design.designs.filter((entry) => entry.unwritable.length > 0).length;

    // ②' 試験を作って固定する（宣言を見る前に固定する。§1.3）
    const testSuite = await runStageOk("test-suite", () =>
      runTestSuite({ list: requirementList.list, documents: input.documents, gateway }),
    );

    // ③ 書く
    const written = await runStageOk("write", () =>
      runWrite({ list: requirementList.list, design, documents: input.documents, gateway }),
    );

    // 棄却で外した試験を除いた、いまの固定した試験
    const withoutOverturned = (): TestSuite => ({
      tests: testSuite.suite.tests.filter((test) => !overturned.some((entry) => entry.testId === test.id)),
    });

    // ⑤a の対応表は 1 回だけ取る（別の会話。§1.2）。④ を通った版で初めて呼ぶ
    let entries: readonly CorrespondenceEntry[] | null = null;

    /** ある版に ④⑤a⑤b を流す（④ を通らなければ⑤a 以降は流さない） */
    const evaluate = async (declaration: Declaration): Promise<VersionChecks> => {
      const staticCheck = await runStage("static-check", () => runStaticCheck(declaration));
      const declarationSha256 = await sha256Hex(declaration.source);
      const app = staticCheck.app;
      if (!staticCheck.passed || app === null) {
        return { declaration, declarationSha256, staticCheck, correspondence: null, testRun: null };
      }
      if (entries === null) {
        const correspondence = await runStageOk("correspondence", () =>
          runCorrespondence({
            source: input.source,
            list: requirementList.list,
            declaration,
            app,
            documents: input.documents,
            gateway,
          }),
        );
        entries = correspondence.entries;
      }
      const currentEntries: readonly CorrespondenceEntry[] = entries;
      const correspondence: CorrespondenceResult = {
        entries: currentEntries,
        misses: checkCorrespondence(app, requirementList.list, currentEntries),
      };
      const testRun = await runStage("run-tests", async () =>
        runTests({ app, suite: withoutOverturned(), correspondence }),
      );
      return { declaration, declarationSha256, staticCheck, correspondence, testRun };
    };

    let current = await evaluate(written.declaration);
    let lastPassed: VersionChecks | null = current.staticCheck.passed ? current : null;
    let rounds = 0;
    let limitReached = false;

    const isSettled = (checks: VersionChecks): boolean =>
      checks.staticCheck.passed &&
      checks.correspondence !== null &&
      checks.correspondence.misses.length === 0 &&
      checks.testRun !== null &&
      checks.testRun.mismatches.length === 0 &&
      checks.testRun.unresolved.length === 0 &&
      unresolved.length === 0;

    // ⑥ → 流し直し（④⑤）→ ⑥' を、往復の上限まで回す（§1・§1.3・§1.5）
    while (!isSettled(current)) {
      if (rounds >= limits.repairRoundTrips) {
        limitReached = true;
        break;
      }
      rounds += 1;
      const step = await runStageOk("repair", () =>
        runRepairStep({
          source: input.source,
          list: requirementList.list,
          suite: withoutOverturned(),
          current,
          correspondences: entries ?? [],
          documents: input.documents,
          gateway,
        }),
      );
      for (const dispute of step.disputes) disputes.push(dispute);
      for (const item of step.rejected) rejected.push(item);
      if (step.disputes.length > 0) {
        const arbitration = await runStageOk("arbitration", () =>
          runArbitration({
            source: input.source,
            list: requirementList.list,
            suite: withoutOverturned(),
            declaration: step.declaration,
            disputes: step.disputes,
            documents: input.documents,
            gateway,
          }),
        );
        collectArbitration(arbitration, upheld, overturned, unresolved);
      }
      const checks = await evaluate(step.declaration);
      current = checks;
      if (checks.staticCheck.passed) lastPassed = checks;
    }

    const final = lastPassed ?? current;

    // ⑦ 終わりの判定。**実行していない検査は「不一致 0」にしない**（`null` のときは 1 として渡す）
    const materials: JudgeMaterials = {
      staticCheckPassed: final.staticCheck.passed,
      correspondenceMisses: final.correspondence === null ? 1 : final.correspondence.misses.length,
      testMismatches: final.testRun === null ? 1 : final.testRun.mismatches.length,
      testUnresolved: unresolved.length,
      unwritableRequirements,
      limitReached,
      carriedOver: { reverseCheck: carriedReverseCheck, testSuite: [] },
    };
    const outcome = await runStage("judge", async () => decideOutcome(toStageResults(materials)));
    const failure: FailureAttribution | null =
      outcome.result === "failed"
        ? final.staticCheck.passed
          ? { stage: "repair", kind: "unmet" }
          : { stage: "static-check", kind: "incomplete" }
        : null;

    // ⑧ 納品物にする（記録と要約を組んでから、納品物に埋め込む）
    const record = buildRecord(failure);
    const summary = buildSummary(record, {
      run_id: input.runId,
      verdict: outcome.verdict,
      assurance: assuranceOf(outcome),
      duration_secs: (input.now() - startedAt) / 1000,
      provider_cost_usd: budget.spentUsd,
      stop_class: failure === null ? "completed" : failure.kind,
      exit_code: outcome.result === "failed" ? 1 : 0,
    });
    const bundle = await assembleBundle({
      runId: input.runId,
      storageUnit: input.storageUnit,
      artifactLevel: input.artifactLevel ?? "L2",
      declaration: final.declaration,
      declarationSha256: final.declarationSha256,
      outcome,
      summary,
      requirements: requirementList.list,
      correspondence: final.correspondence,
      testRun: final.testRun,
      disputes,
      rejected,
      arbitration: { upheld, overturned, unresolved },
      builder: input.builder,
      verificationProfile: input.verificationProfile ?? "musunest-factory/l2",
      specEngineVersion: input.specEngineVersion,
      factoryVersion: input.factoryVersion,
    });
    return { outcome, record, summary, bundle, stopped: failure };
  } catch (error) {
    if (error instanceof RunStop) return stopResult(error.attribution);
    throw error;
  }
}
