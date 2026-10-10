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
import {
  assembleBundle,
  type AssembledBundle,
  type BundleDroppedClaim,
  type BundleTriageJudgment,
  type UnwritableRequirement,
} from "./bundle.js";
import type { Judge } from "./judge.js";
import { AGENT_LIMITS, UNWRITABLE_CONFIDENCE_THRESHOLD, checkRequestText, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { decideOutcome, type Outcome } from "./outcome.js";
import {
  toStageResults,
  type ArbitrationResult,
  type CorrespondenceEntry,
  type CorrespondenceResult,
  type CorrespondenceMiss,
  type Declaration,
  type Dispute,
  type JudgeMaterials,
  type OverturnedTest,
  type RejectedDispute,
  type RoleEntry,
  type RoleNameMapping,
  type TestRunResult,
  type TestSuite,
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
  type StopReason,
  type Summary,
  type UsageSnapshot,
} from "./record.js";
import { runArbitration } from "./stages/arbitrate.js";
import {
  checkCorrespondence,
  checkRoleMappings,
  runCorrespondence,
} from "./stages/correspondence.js";
import { runDesign } from "./stages/design.js";
import type { PromptDocument, StageFailure, StageOutcome } from "./stages/prompt.js";
import { runUnwritableTriage, type UnwritableTriageResult } from "./stages/unwritable-triage.js";
import {
  failureSignature,
  isStagnant,
  runCorrespondenceRedo,
  runRepairStep,
  type VersionReport,
} from "./stages/repair.js";
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
  /**
   * 呼び出し 1 回ごとの timeout の基準（ミリ秒）。指定しなければ effort から出す（#302）。
   * 手元の入口（`--timeout`）が渡す。実際に使う値は締切の残りを超えず、やり直しでは長くする。
   */
  readonly callTimeoutMs?: number;
  /**
   * 判定の口（judge.ts・Issue #330）。渡されたときだけ、② の「書けない」の申告を**仕分けて裏を取る**
   * （`unwritable-triage.ts`・Issue #332）。渡さなければ申告をそのまま残す（記録の再生など、判定を
   * 差し込まない道）。**判定は助言であって門ではない**——答えで合否を開けない（§4）。
   */
  readonly judge?: Judge;
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

/** 段の失敗を、記録の失敗の分類に写す（§2.2・S-7・#302）。呼び出しの誤りの種類はそのまま写す */
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

/**
 * 段の失敗を、記録の失敗の帰属に写す（S-7・#304）。**要求そのものが不正な誤り**のときは、やり直しても
 * 通らないので、**誤りの種類（`code`。例 `invalid_json_schema`）だけ**を残す（本文の全文は残さない。S-8）。
 *
 * **形が合わなかった（`malformed`）・コードの検査に合わなかった（`unmet`）**ときは、どの欄がどう
 * 合わなかったか（欄の名前と、問題の種類）を残す（ほかの段の「形が合わない」「未達」も同じ扱い）。
 * 残すのは**欄の名前と種類だけ**で、値の中身（宣言の原文・依頼文）は残さない（#304）。
 */
function stageFailureAttribution(stage: StageId, failure: StageFailure): FailureAttribution {
  const kind = stageFailureToKind(failure);
  if (failure.kind === "invalidRequest") return { stage, kind, code: failure.code };
  if ((failure.kind === "malformed" || failure.kind === "unmet") && failure.problems.length > 0) {
    return {
      stage,
      kind,
      problems: failure.problems.map((problem) => ({ field: problem.field, message: problem.message })),
    };
  }
  return { stage, kind };
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
 * ⑦ へ渡す未解決の数を、重複なく数える（§1.4・#306）。
 *
 * 未解決は 2 か所から出る——**期待の裁定の未解決**（⑥'）と、**最終版の試験を流した結果の未解決**（⑤b。
 * 入力の型・操作の実行など、評価器で確かめられない試験）。未解決だけが残った版を合格にしないため、
 * **両方を数える**（#306 の直す前は裁定の未解決だけを渡していた）。同じ試験 ID が両方にあるときは 1 つに数える。
 */
export function countUnresolvedTests(
  arbitrationUnresolved: readonly string[],
  testRun: TestRunResult | null,
): number {
  const ids = new Set<string>(arbitrationUnresolved);
  for (const unresolved of testRun?.unresolved ?? []) ids.add(unresolved.testId);
  return ids.size;
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
    effort: input.effort,
    ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
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
      if (!outcome.ok) throw new RunStop(stageFailureAttribution(stage, outcome.failure));
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
      stopReason: attribution.kind,
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

    // ② 設計する（書けなかった要件の一覧を、⑦ と ⑧ のために組んでおく）
    const rawDesign = await runStageOk("design", () =>
      runDesign({ list: requirementList.list, documents: input.documents, gateway }),
    );

    // ② の「書けない」の申告を、仕分けて裏を取る（Issue #332）。判定の口（`judge`）が渡されたときだけ
    // 回す——記録の再生のように判定を差し込まない道では、申告をそのまま残す。**判定は助言であって門では
    // ない**ので、判定が失敗しても走りは止めない（申告をそのまま残す。§4・§6）。
    let triage: UnwritableTriageResult | undefined;
    if (input.judge !== undefined && rawDesign.designs.some((entry) => entry.unwritableClaims.length > 0)) {
      const judge = input.judge;
      try {
        triage = await runUnwritableTriage({
          design: rawDesign,
          documents: input.documents,
          judge,
          threshold: UNWRITABLE_CONFIDENCE_THRESHOLD,
          // 語彙の穴で「反する」と判定されたとき、その要件だけ設計をやり直す（1 回まで）
          redoDesign: async (requirementId) => {
            const list = {
              ...requirementList.list,
              requirements: requirementList.list.requirements.filter(
                (requirement) => requirement.id === requirementId,
              ),
            };
            const outcome = await runDesign({ list, documents: input.documents, gateway });
            return outcome.ok ? outcome.value.designs[0] : undefined;
          },
        });
      } catch {
        triage = undefined;
      }
    }
    const design = triage?.design ?? rawDesign;

    // 書けなかった要件を、要件の文と引用つきで並べる（Issue #326・#332）。仕分けを回したときは**残った
    // 申告だけ**（曖昧さは `notes` へ移り、問題ではないものは落ちている）。回していないときは `unwritable`
    // が空でない要件をそのまま使う。要件の文と引用は ① の一覧から写す（設計は ID しか持たない）。
    const unwritableParts: readonly { requirementId: string; parts: readonly string[] }[] =
      triage === undefined
        ? design.designs
            .filter((entry) => entry.unwritable.length > 0)
            .map((entry) => ({ requirementId: entry.requirementId, parts: entry.unwritable }))
        : triage.kept.map((entry) => ({
            requirementId: entry.requirementId,
            parts: entry.claims.map((claim) => claim.part),
          }));
    const unwritable: readonly UnwritableRequirement[] = unwritableParts.map(({ requirementId, parts }) => {
      const requirement = requirementList.list.requirements.find((candidate) => candidate.id === requirementId);
      return {
        requirementId,
        text: requirement?.text ?? "",
        quote: requirement?.quote ?? "",
        unwritable: parts,
      };
    });
    const unwritableRequirements = unwritable.length;

    // 判定の記録（問いの ID・答え・確信度・答えたモデルの版）と、落とした申告・印つきの要件（Issue #332）
    const triageJudgments: readonly BundleTriageJudgment[] = (triage?.judgments ?? []).map((judgment) => ({
      question_id: judgment.questionId,
      answer: judgment.answer,
      confidence: judgment.confidence ?? null,
      model: judgment.model,
      answered_by: judgment.answeredBy,
    }));
    const triageDropped: readonly BundleDroppedClaim[] = (triage?.dropped ?? []).map((claim) => ({
      requirement_id: claim.requirementId,
      part: claim.part,
      label: claim.label,
      reason: claim.reason,
    }));
    const markedRequirements: readonly string[] = (triage?.kept ?? [])
      .filter((entry) => entry.marked)
      .map((entry) => entry.requirementId);

    // ②' 試験を作って固定する（宣言を見る前に固定する。§1.3）。**② の設計（役割 ID の表と要件ごとの
    // 種類）を渡す**——渡さないと ②' は設計が無いときの古い経路に入り、種類の突き合わせと役割 ID の
    // 検査が効かない（Issue #316。疎通の確認では、在ることだけの要件に異常・境界の試験を求めて落ちた）。
    const testSuite = await runStageOk("test-suite", () =>
      runTestSuite({ list: requirementList.list, design, documents: input.documents, gateway }),
    );

    // ③ 書く
    const written = await runStageOk("write", () =>
      runWrite({ list: requirementList.list, design, documents: input.documents, gateway }),
    );

    // 棄却で外した試験を除いた、いまの固定した試験。**分類（classifications）は落とさない**
    // ——落とすと、要件ごとの種類が既定（決まりを含む）に戻り、在ることだけの要件の create の試験が
    // 構造の確認ではなく操作の実行として未解決になる（Issue #322）。
    const withoutOverturned = (): TestSuite => ({
      ...(testSuite.suite.classifications === undefined
        ? {}
        : { classifications: testSuite.suite.classifications }),
      tests: testSuite.suite.tests.filter((test) => !overturned.some((entry) => entry.testId === test.id)),
    });

    // ② の設計が固定した役割 ID の表と、③ が提出した「役割 ID → 宣言の名前」の対応（§1.3・Issue #309）。
    // 新形式（役割 ID で指す）のときだけ、結び付けの部品へ渡す。旧形式は種類の数で決める。
    const roles: readonly RoleEntry[] | undefined = design.roles;
    let mappings: readonly RoleNameMapping[] = written.mappings;
    const useMappings = (): boolean => mappings.length > 0 || roles !== undefined;

    // ⑤a の対応表。**同じ宣言の版（SHA-256）のときだけ使い回し**、宣言が変われば作り直す（§1.3.1・#309）
    let entries: readonly CorrespondenceEntry[] | null = null;
    let entriesSha: string | null = null;
    let correspondenceCalls = 0;
    // ③ の対応の表の出し直しの回数（§1.5）
    let redos = 0;

    /**
     * ある版に ④⑤a⑤b を流す（④ を通らなければ⑤a 以降は流さない）。**版の整合**：宣言が変われば
     * ⑤a を作り直し、古い版の対応・結び付け・試験の結果を使わない（§1.3.1・R2-11・Issue #309）。
     * ⑤a の作り直しの上限に触れたら `null` を返す（呼ぶ側が上限として止める）。
     */
    const evaluate = async (declaration: Declaration): Promise<VersionReport | null> => {
      const staticCheck = await runStage("static-check", () => runStaticCheck(declaration));
      const declarationSha256 = await sha256Hex(declaration.source);
      if (!staticCheck.passed || staticCheck.app === null) {
        return { declaration, declarationSha256, staticCheck, correspondence: null, testRun: null, routes: [], defectMisses: [] };
      }
      const app = staticCheck.app;
      let currentEntries = entries;
      if (currentEntries === null || entriesSha !== declarationSha256) {
        if (currentEntries !== null && correspondenceCalls >= limits.correspondenceChecks) return null;
        correspondenceCalls += 1;
        const result = await runStageOk("correspondence", () =>
          runCorrespondence({
            source: input.source,
            list: requirementList.list,
            declaration,
            app,
            documents: input.documents,
            gateway,
            ...(roles === undefined ? {} : { roles }),
            ...(useMappings() ? { mappings } : {}),
          }),
        );
        currentEntries = result.entries;
        entries = currentEntries;
        entriesSha = declarationSha256;
      }
      // ⑤a の落ちを、対応の表の不備（③ のやり直し）と、それ以外（宣言の要素の欠落、⑥）に分ける（§1.3.1・Issue #324）。
      // **画面から辿れない場所は「宣言の要素の欠落」**なので、③ のやり直しには数えない（⑥ 直すへ回す）
      const entriesMisses = checkCorrespondence(app, requirementList.list, currentEntries);
      const mappingMisses =
        roles !== undefined && useMappings()
          ? checkRoleMappings(app, roles, currentEntries, mappings)
          : [];
      const defectMisses = mappingMisses.filter((miss) => miss.route === "correspondence-defect");
      const correspondence: CorrespondenceResult = {
        entries: currentEntries,
        misses: [...entriesMisses, ...mappingMisses],
      };
      const report = await runStage("run-tests", async () =>
        runTests({
          app,
          suite: withoutOverturned(),
          correspondence,
          ...(useMappings() ? { mappings } : {}),
        }),
      );
      return {
        declaration,
        declarationSha256,
        staticCheck,
        correspondence,
        testRun: report,
        routes: report.routes,
        defectMisses,
      };
    };

    const isSettled = (report: VersionReport): boolean =>
      report.staticCheck.passed &&
      report.correspondence !== null &&
      report.correspondence.misses.length === 0 &&
      report.testRun !== null &&
      report.testRun.mismatches.length === 0 &&
      report.testRun.unresolved.length === 0 &&
      unresolved.length === 0;

    const first = await evaluate(written.declaration);
    if (first === null) throw new RunStop({ stage: "correspondence", kind: "call-limit" });
    let current: VersionReport = first;
    let lastPassed: VersionReport | null = current.staticCheck.passed ? current : null;
    let rounds = 0;
    let limitReached = false;
    let stopReason: StopReason = "completed";
    let stagnant = false;
    const history: string[] = [failureSignature(current)];

    // ⑥（または ⑤a・③ のやり直し）→ 流し直し（④⑤）→ ⑥' を、上限まで回す（§1・§1.3・§1.5・§1.3.1・#322）
    while (!isSettled(current)) {
      // 停滞の検知：同じ不一致（試験 ID・段・誤りの分類。名前は数えない）が続いたら、それ以上直さない
      if (isStagnant(history, limits.stagnationRepeats)) {
        stagnant = true;
        stopReason = "stagnation";
        break;
      }

      // ⑤a のやり直し：対応の名前が宣言に実在するのに、⑤a の対応表の外にあるとき（Issue #322）。
      // ③ の対応は正しく、足りないのは ⑤a の対応表の場所なので、**③ のやり直しでも ⑥ でもない**。
      // 落ちた場所を伝えて ⑤a を作り直し、同じ宣言のまま結び付けと試験を流し直す。
      const redoRoutes = current.routes.filter((route) => route.route === "correspondence-redo");
      if (
        redoRoutes.length > 0 &&
        roles !== undefined &&
        useMappings() &&
        current.staticCheck.app !== null
      ) {
        if (correspondenceCalls >= limits.correspondenceChecks) {
          limitReached = true;
          stopReason = "limit";
          break;
        }
        correspondenceCalls += 1;
        const app = current.staticCheck.app;
        const previousMisses: readonly CorrespondenceMiss[] = redoRoutes.map((route) => ({
          requirementId: route.requirementId ?? "",
          ...(route.location === undefined ? {} : { location: route.location }),
          detail: route.detail,
        }));
        const retry = await runStageOk("correspondence", () =>
          runCorrespondence({
            source: input.source,
            list: requirementList.list,
            declaration: current.declaration,
            app,
            documents: input.documents,
            gateway,
            roles,
            ...(useMappings() ? { mappings } : {}),
            previousMisses,
          }),
        );
        // 宣言は変えない。作り直した対応表で、結び付けと試験を流し直す（Issue #322）
        entries = retry.entries;
        entriesSha = current.declarationSha256;
        const next = await evaluate(current.declaration);
        if (next === null) {
          limitReached = true;
          stopReason = "limit";
          break;
        }
        current = next;
        if (current.staticCheck.passed) lastPassed = current;
        history.push(failureSignature(current));
        continue;
      }

      // 対応の表の不備（③ のやり直し）と、それ以外（⑥ 直す）を分ける（§1.3.1・Issue #309）
      const defect =
        current.defectMisses.length + current.routes.filter((route) => route.route === "correspondence-defect").length;
      if (defect > 0 && roles !== undefined && useMappings()) {
        if (redos >= limits.correspondenceRedos) {
          limitReached = true;
          stopReason = "limit";
          break;
        }
        redos += 1;
        const redo = await runStageOk("write", () =>
          runCorrespondenceRedo({
            source: input.source,
            list: requirementList.list,
            roles,
            declaration: current.declaration,
            documents: input.documents,
            gateway,
          }),
        );
        mappings = redo.mappings;
        // 宣言は変えない。⑤a は同じ版なので使い回し、結び付けと試験だけ流し直す
        const next = await evaluate(current.declaration);
        if (next === null) {
          limitReached = true;
          stopReason = "limit";
          break;
        }
        current = next;
        history.push(failureSignature(current));
        continue;
      }

      // ⑥ 直す（要素の欠落・未解決）。宣言が変われば ⑤a を作り直す
      if (rounds >= limits.repairRoundTrips) {
        limitReached = true;
        stopReason = "limit";
        break;
      }
      rounds += 1;
      const step = await runStageOk("repair", () =>
        runRepairStep({
          source: input.source,
          list: requirementList.list,
          suite: withoutOverturned(),
          current,
          correspondences: current.correspondence?.entries ?? [],
          ...(useMappings() ? { mappings } : {}),
          ...(roles === undefined ? {} : { roles }),
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
      const next = await evaluate(step.declaration);
      if (next === null) {
        limitReached = true;
        stopReason = "limit";
        break;
      }
      current = next;
      if (current.staticCheck.passed) lastPassed = current;
      history.push(failureSignature(current));
    }

    const final = lastPassed ?? current;

    // 停滞で止めたら、残った不一致を**未解決**として数え、部分案で終える（§1.3.1・Issue #309）
    if (stagnant) {
      for (const route of current.routes) if (!unresolved.includes(route.testId)) unresolved.push(route.testId);
    }

    // ⑦ 終わりの判定。**実行していない検査は「不一致 0」にしない**（`null` のときは 1 として渡す）。
    // 未解決は、最終版の試験の結果の未解決と、期待の裁定の未解決の両方を数える（#306）。
    const materials: JudgeMaterials = {
      staticCheckPassed: final.staticCheck.passed,
      correspondenceMisses: final.correspondence === null ? 1 : final.correspondence.misses.length,
      testMismatches: final.testRun === null ? 1 : final.testRun.mismatches.length,
      testUnresolved: countUnresolvedTests(unresolved, final.testRun),
      unwritableRequirements,
      limitReached,
      carriedOver: { reverseCheck: carriedReverseCheck, testSuite: [] },
    };
    const outcome = await runStage("judge", async () => decideOutcome(toStageResults(materials)));
    // 停滞で止めても、納品物は部分案として返す（早期停止ではない。止めた理由は `stop_reason` に出す）。
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
      stopReason,
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
      unwritable,
      triage: triageJudgments,
      markedRequirements,
      dropped: triageDropped,
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
