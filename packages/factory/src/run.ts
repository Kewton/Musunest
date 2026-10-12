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
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex, type Diagnostic } from "@musunest/spec-engine";
import { JobBudget, type TokenRates } from "./budget.js";
import { CallGateway } from "./call.js";
import {
  assembleBundle,
  buildDiagnostics,
  materialCounts,
  toBundleNatureDiscrepancies,
  toDroppedNonstructuralTests,
  UNEXECUTED,
  type AssembledBundle,
  type BundleArtifact,
  type BundleDroppedClaim,
  type BundleJudgeUsage,
  type BundleMaterialEntry,
  type BundleNatureDiscrepancy,
  type BundleSummary,
  type BundleTriageJudgment,
  type InspectionCount,
  type MaterialKind,
  type UnwritableRequirement,
} from "./bundle.js";
import type { Judge } from "./judge.js";
import { createBudgetedJudge, type BudgetedJudge } from "./judge-budget.js";
import { AGENT_LIMITS, UNWRITABLE_CONFIDENCE_THRESHOLD, checkRequestText, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { decideOutcome, type Outcome } from "./outcome.js";
import {
  acceptedUnwritablePartIds,
  LEGACY_DESIGN_CONTRACT,
  requirementsFromPlan,
  toStageResults,
  type ArbitrationResult,
  type CorrespondenceEntry,
  type CorrespondenceResult,
  type CorrespondenceMiss,
  type Declaration,
  type DesignContractVersion,
  type DesignResult,
  type Dispute,
  type JudgeMaterials,
  type OverturnedTest,
  type RejectedDispute,
  type RequirementDesign,
  type RequirementList,
  type RoleEntry,
  type RoleNameMapping,
  type StaticCheckResult,
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
  type StageOperation,
  type StageRecord,
  type StageStatus,
  type StopReason,
  type UsageSnapshot,
} from "./record.js";
import { runArbitration } from "./stages/arbitrate.js";
import {
  checkCorrespondence,
  checkRoleMappings,
  runCorrespondence,
  type RequirementRoleOwnership,
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
import { runTestSuite, type DroppedNonstructuralTest } from "./stages/test-suite.js";
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
   *
   * **生成の中では、この口を予算に結び付けた包みで包む**（`judge-budget.ts`・Issue #359）。判定の
   * 呼び出し（Jev の入力トークン・LLM の出力トークン）も、段の呼び出しと同じ予算で予約・精算する。
   * 予約できないときは判定を呼ばず、申告をそのまま残す（判定は助言。§4）。
   */
  readonly judge?: Judge;
  /**
   * 確定した仕様（Plan の契約 `plan.json`。#331・§5・Issue #334）。**渡されたときは、これが全段の正本**である
   * ——① と ①' を行わず、②'・⑤a・⑥' の根拠も原文ではなくこの仕様の要件と出どころにする。渡さなければ、
   * これまでどおり依頼文（原文）から ① → ①' を回す。
   */
  readonly plan?: ConfirmedPlan;
  /**
   * 設計の契約の版（決定 ⑨・Issue #418）。`legacy` を明示したときだけ、過去の記録の読み込みとして
   * 旧形式の設計を通す。省けば**新契約**——初回の設計・単一要件の作り直し・②' に**同じ値**を渡す。
   */
  readonly designVersion?: DesignContractVersion;
}

/** 1 回の生成の結果 */
export interface GenerationResult {
  /** ⑦ の合否 */
  readonly outcome: Outcome;
  /** 段ごとの記録（要約に入る欄も持つ） */
  readonly record: RunRecord;
  /** 納品物の要約（appspec-schema の wire に、判定の呼び出しの数・費用を足したもの。手元の入口が最後の行に出す） */
  readonly summary: BundleSummary;
  /** ⑧ の納品物。早期停止では `null`（宣言まで届かなかった） */
  readonly bundle: AssembledBundle | null;
  /** 早期停止の帰属（どの段の・どの種類の失敗か）。完走なら `null` */
  readonly stopped: FailureAttribution | null;
  /**
   * 早期停止の診断の成果物（Issue #417）。早期停止では、段が受理した時点で積んだ材料だけから組む
   * （一覧と、在る材料のファイル）。完走では空。**合否・stop_reason・終了コードの決め方には使わない**。
   */
  readonly diagnostics: readonly BundleArtifact[];
  /**
   * ⑥' が、確定した仕様そのものと食い違う主張を見つけて **Plan に戻した**か（§5・Issue #334）。
   * `true` のとき、走りは差し戻しで止まっている（差し戻しは 1 回まで）。確定した仕様が無ければ `false`。
   */
  readonly returnToPlan?: boolean;
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

/**
 * 仕分けが呼ぶ設計のやり直し（`redoDesign`。Issue #410）を、段 `design` の記録（`operation` は
 * `"redo-design"`）として残す包み。**戻り方は変えない**（門を緩めない）。
 *
 *   - 段が成功 → `ok` の記録を足し、値（設計の出力）を返す
 *   - 段が失敗（`StageOutcome` が `ok` でない）→ `failed` の記録（分類は `stageFailureToKind`）を足し、
 *     今までどおり `undefined` を返す（仕分けは申告を印つきで残し、走りは止めない）
 *   - **予期しない例外** → `failed`（分類 `unknown`）の記録を足して、**同じ例外を投げ直す**（外側の
 *     既存の catch に委ね、仕分け全体を採らず元の設計に戻す）
 *
 * 段の失敗と例外の 2 経路を直接試験できるよう、走らせるもの（`call`）と記録の口（`push`）を外から
 * 受け取る。所要時間は `now` の差で出す。
 */
export async function redoDesignRecorded<T>(input: {
  /** 段を回す（本番は ② の設計を要件 1 つで呼び直す `runDesign`） */
  readonly call: () => Promise<StageOutcome<T>>;
  /** いまの時刻（ミリ秒。時計は差し込む） */
  readonly now: () => number;
  /** 記録を足す（段は `design`・`operation` は `"redo-design"`。所要時間と分類を受け取る） */
  readonly push: (status: StageStatus, durationMs: number, failureKind: FailureKind | null) => void;
}): Promise<T | undefined> {
  const start = input.now();
  let outcome: StageOutcome<T>;
  try {
    outcome = await input.call();
  } catch (error) {
    input.push("failed", input.now() - start, "unknown");
    throw error;
  }
  if (!outcome.ok) {
    input.push("failed", input.now() - start, stageFailureToKind(outcome.failure));
    return undefined;
  }
  input.push("ok", input.now() - start, null);
  return outcome.value;
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

// ── 段が受理した材料の入れ物（Issue #417）────────────────────────────
//
// **段が受理した時点で積む**（成功の戻り値だけに頼らない。#392 の外した試験と同じ考え）。早期停止でも、
// ここに積んだ材料だけを診断の成果物として返す。完走では、同じ材料を納品物の成果物に足す。

/** 段が受理した材料の 1 つ（値と、その版。Issue #417） */
interface MaterialSlot<T> {
  readonly value: T;
  readonly stageIndex: number;
  readonly sha256: string;
}

/** 候補の宣言の 1 版（③ か ⑥ が返した原文と、その版の静的チェックの結果。Issue #417） */
interface CandidateDeclaration {
  readonly source: string;
  readonly sha256: string;
  /** その版が静的チェックを通ったか（最終の判定の前の、通過だけの記録） */
  staticCheckPassed: boolean;
}

/** 評価の行（組み立てる間は可変。Issue #417） */
interface MutableEvaluationRow {
  declaration_sha256: string;
  static_check_passed: boolean;
  static_check_diagnostics: number;
  correspondence_misses: InspectionCount;
  test_mismatches: InspectionCount;
  test_unresolved: InspectionCount;
  routes: Record<string, number>;
}

/** 材料の JSON の SHA-256（版の値。Issue #417） */
const materialDigest = (value: unknown): Promise<string> => sha256Hex(JSON.stringify(value));

/** 失敗の行き先ごとの件数（試験 ID・文言は持たない。Issue #417） */
const countRoutes = (routes: readonly { readonly route: string }[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const route of routes) counts[route.route] = (counts[route.route] ?? 0) + 1;
  return counts;
};

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
  // 判定の口（渡されたときだけ）を、**この生成の予算に結び付けた包み**で包む（Issue #359）。判定の
  // 呼び出し（Jev の入力トークン・LLM の出力トークン）も、段の呼び出しと同じ予算で予約・精算する。
  // 予約できなければ判定を呼ばず、下の仕分けが握って申告をそのまま残す（判定は助言。§4・§6）。
  const judgeBudget: BudgetedJudge | undefined =
    input.judge === undefined ? undefined : createBudgetedJudge({ judge: input.judge, budget, rates: input.rates });
  const startedAt = input.now();
  const stages: StageRecord[] = [];
  const upheld: string[] = [];
  const overturned: OverturnedTest[] = [];
  const unresolved: string[] = [];
  const disputes: Dispute[] = [];
  const rejected: RejectedDispute[] = [];
  /** ⑥' が確定した仕様と食い違う主張を見つけて Plan に戻したか（§5・Issue #334） */
  let returnToPlan = false;
  /** Plan に戻した試験 ID（差し戻しの記録。§5・Issue #334） */
  const returnedToPlan: string[] = [];

  /** 段が受理した材料の入れ物（Issue #417）。段が ok で採った時点で積む */
  const materialStore: {
    design: MaterialSlot<DesignResult> | null;
    testSuite: MaterialSlot<TestSuite> | null;
    mappings: MaterialSlot<readonly RoleNameMapping[]> | null;
    declarations: CandidateDeclaration[];
    evaluations: Map<string, MutableEvaluationRow>;
    staticChecks: Map<string, { readonly passed: boolean; readonly diagnostics: readonly Diagnostic[] }>;
  } = {
    design: null,
    testSuite: null,
    mappings: null,
    declarations: [],
    evaluations: new Map(),
    staticChecks: new Map(),
  };

  /** 材料を、受理した段の記録の添字と一緒に積む */
  const acceptSlot = async <T>(value: T, stageIndex: number): Promise<MaterialSlot<T>> => ({
    value,
    stageIndex,
    sha256: await materialDigest(value),
  });

  /** ある段の、最後に ok になった記録の添字（受理した段。無ければ -1） */
  const lastOkStageIndex = (stage: StageId): number => {
    for (let index = stages.length - 1; index >= 0; index -= 1) {
      const record = stages[index];
      if (record !== undefined && record.stage === stage && record.status === "ok") return index;
    }
    return -1;
  };

  /** いまの段の記録から、材料ごとの状態を決める（Issue #417） */
  const materialEntries = (): readonly BundleMaterialEntry[] => {
    const ran = (stage: StageId): boolean => stages.some((record) => record.stage === stage);
    const ok = (stage: StageId): boolean =>
      stages.some((record) => record.stage === stage && record.status === "ok");
    const slot = (
      material: MaterialKind,
      value: MaterialSlot<unknown> | null,
      stage: StageId,
    ): BundleMaterialEntry =>
      value === null
        ? { material, state: ran(stage) ? "unaccepted" : "unexecuted" }
        : { material, state: "accepted", version: { stage_index: value.stageIndex, sha256: value.sha256 } };
    // 宣言は、最後に静的チェックを通った版（無ければ最後の候補）を候補として示す（最終の判定は別）
    const passed = materialStore.declarations.filter((entry) => entry.staticCheckPassed);
    const declaration = passed.at(-1) ?? materialStore.declarations.at(-1);
    return [
      slot("design", materialStore.design, "design"),
      slot("test_suite", materialStore.testSuite, "test-suite"),
      slot("mappings", materialStore.mappings, "write"),
      {
        material: "declaration",
        state:
          materialStore.declarations.length > 0
            ? "candidate"
            : ran("write") || ran("repair")
              ? "unaccepted"
              : "unexecuted",
        ...(declaration === undefined
          ? {}
          : { version: { sha256: declaration.sha256 }, static_check_passed: declaration.staticCheckPassed }),
      },
      {
        material: "correspondence",
        state: ok("correspondence") ? "accepted" : ran("correspondence") ? "unaccepted" : "unexecuted",
      },
      { material: "test_run", state: ok("run-tests") ? "accepted" : ran("run-tests") ? "unaccepted" : "unexecuted" },
      {
        material: "evaluation",
        state: ok("static-check") ? "accepted" : ran("static-check") ? "unaccepted" : "unexecuted",
      },
    ];
  };

  /** 候補の宣言と、その版の静的チェックの結果を積む（③ か ⑥ が返すたび） */
  const recordDeclaration = (declaration: Declaration, sha256: string, staticCheck: StaticCheckResult): void => {
    materialStore.staticChecks.set(sha256, { passed: staticCheck.passed, diagnostics: staticCheck.diagnostics });
    const existing = materialStore.declarations.find((entry) => entry.sha256 === sha256);
    if (existing === undefined) {
      materialStore.declarations.push({
        source: declaration.source,
        sha256,
        staticCheckPassed: staticCheck.passed,
      });
    } else {
      existing.staticCheckPassed = staticCheck.passed;
    }
  };

  /** 評価の行を積む（④ の結果を受け取った時点）。同じ宣言の SHA-256 の行があれば、それを返す */
  const evaluationRow = (sha256: string, staticCheck: StaticCheckResult): MutableEvaluationRow => {
    let row = materialStore.evaluations.get(sha256);
    if (row === undefined) {
      row = {
        declaration_sha256: sha256,
        static_check_passed: staticCheck.passed,
        static_check_diagnostics: staticCheck.diagnostics.length,
        correspondence_misses: UNEXECUTED,
        test_mismatches: UNEXECUTED,
        test_unresolved: UNEXECUTED,
        routes: {},
      };
      materialStore.evaluations.set(sha256, row);
    } else {
      row.static_check_passed = staticCheck.passed;
      row.static_check_diagnostics = staticCheck.diagnostics.length;
    }
    return row;
  };

  /** 診断の成果物を組む（早期停止のとき。積んだ材料だけから。Issue #417） */
  const diagnosticsFor = (attribution: FailureAttribution, record: RunRecord): readonly BundleArtifact[] =>
    buildDiagnostics({
      stopped: { stage: attribution.stage, kind: attribution.kind },
      materials: materialEntries(),
      evaluations: [...materialStore.evaluations.values()],
      counts: materialCounts(record.stages),
      ...(materialStore.design === null ? {} : { design: materialStore.design.value }),
      ...(materialStore.testSuite === null ? {} : { testSuite: materialStore.testSuite.value }),
      ...(materialStore.mappings === null ? {} : { mappings: materialStore.mappings.value }),
      ...(materialStore.declarations.length === 0
        ? {}
        : { declarations: materialStore.declarations.map((entry) => ({ sha256: entry.sha256, declaration: entry.source })) }),
      ...(materialStore.staticChecks.size === 0
        ? {}
        : {
            staticChecks: [...materialStore.staticChecks.entries()].map(([sha256, check]) => ({
              declaration_sha256: sha256,
              passed: check.passed,
              diagnostics: check.diagnostics,
            })),
          }),
    });

  const pushRecord = (
    stage: StageId,
    status: StageStatus,
    before: UsageSnapshot,
    start: number,
    failureKind: FailureKind | null,
    operation: StageOperation | null = null,
  ): void => {
    stages.push(
      makeStageRecord(stage, status, input.now() - start, usageDelta(before, meter.snapshot), failureKind, operation),
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

  /** 判定の呼び出しの数（答えた adapter ごと）と費用（USD）。要約の `judge` 欄に入れる（Issue #359） */
  const judgeUsageOf = (): BundleJudgeUsage => ({
    calls_by_adapter: judgeBudget?.callsByAdapter ?? { jev: 0, llm: 0, fake: 0 },
    cost_usd: judgeBudget?.spentUsd ?? 0,
  });

  /**
   * ②' で種類が食い違った要件の記録（要約に残す。Issue #373）。②' まで届かなければ空の並びのまま。
   */
  let natureDiscrepancies: readonly BundleNatureDiscrepancy[] = [];

  /**
   * ②' が固定の前に外した、**構造で確かめる要件の構造の検査でない試験**（回ごと。Issue #392）。②' から
   * 通知の口（`onDropped`）で受け取る——**②' が最後に失敗しても・後の段で早く止まっても**要約に残すため、
   * 成功の戻り値だけに頼らない。②' まで届かなければ空のまま（要約の欄は省く）。
   */
  const droppedTests: DroppedNonstructuralTest[] = [];

  const stopResult = (attribution: FailureAttribution): GenerationResult => {
    const outcome: Outcome = { result: "failed", verdict: "none" };
    const record = buildRecord(attribution);
    const droppedSummary = toDroppedNonstructuralTests(droppedTests);
    const summary: BundleSummary = {
      ...buildSummary(record, {
        run_id: input.runId,
        verdict: "none",
        assurance: "none",
        duration_secs: (input.now() - startedAt) / 1000,
        provider_cost_usd: budget.spentUsd,
        stop_class: attribution.kind,
        stopReason: attribution.kind,
        exit_code: 1,
      }),
      judge: judgeUsageOf(),
      nature_discrepancies: natureDiscrepancies,
      ...(droppedSummary === undefined ? {} : { dropped_nonstructural_tests: droppedSummary }),
    };
    return {
      outcome,
      record,
      summary,
      bundle: null,
      stopped: attribution,
      diagnostics: diagnosticsFor(attribution, record),
    };
  };

  try {
    // 入口：**確定した仕様（Plan の契約）があれば、それを正本にする**——① と ①' は行わず、その要件を
    // そのまま使う（§5・Issue #334）。無ければ、これまでどおり ① の入口 → ①' を回す。
    let requirementList: RequirementList;
    let carriedReverseCheck: readonly string[];
    if (input.plan !== undefined) {
      requirementList = requirementsFromPlan(input.plan);
      carriedReverseCheck = [];
    } else {
      // ① の入口：依頼文の上限。超えていれば LLM を呼ばずに止める（§1.5）
      if (checkRequestText(input.source) !== undefined) {
        pushRecord("requirements", "failed", meter.snapshot, input.now(), "limit");
        throw new RunStop({ stage: "requirements", kind: "limit" });
      }
      // ① → ①'（逆照合。落ちがあれば ① を 1 回だけやり直す。§1）
      const reverse = await runStageOk("reverse-check", () =>
        runReverseCheckLoop({ source: input.source, documents: input.documents, gateway }),
      );
      requirementList = reverse.list;
      carriedReverseCheck = reverse.unmet.map((miss) => `${miss.kind}: ${miss.detail}`);
    }

    // 設計の契約の版（決定 ⑨・Issue #418）。呼ぶ側が明示し、初回の設計・作り直し・②' へ同じ値を渡す。
    const versionField: { readonly version?: DesignContractVersion } =
      input.designVersion === undefined ? {} : { version: input.designVersion };

    // ② 設計する（書けなかった要件の一覧を、⑦ と ⑧ のために組んでおく）
    const rawDesign = await runStageOk("design", () =>
      runDesign({ list: requirementList, documents: input.documents, gateway, ...versionField }),
    );

    // ② の「書けない」の申告を、仕分けて裏を取る（Issue #332）。判定の口（`judge`）が渡されたときだけ
    // 回す——記録の再生のように判定を差し込まない道では、申告をそのまま残す。**判定は助言であって門では
    // ない**ので、判定が失敗しても走りは止めない（申告をそのまま残す。§4・§6）。
    let triage: UnwritableTriageResult | undefined;
    if (judgeBudget !== undefined && rawDesign.designs.some((entry) => entry.unwritableClaims.length > 0)) {
      // 単一要件の作り直しの**基準**（採用した設計）を、呼ぶ側（ここ）が持つ（Issue #418）。1 件目の採用を
      // 反映した全体を、2 件目の点検の基準にする（採用と更新を同時に行う）。
      const adoptedDesigns = new Map<string, RequirementDesign>(
        rawDesign.designs.map((entry) => [entry.requirementId, entry]),
      );
      // 判定の口は**予算に結び付けた包み**（judgeBudget）である（Issue #359）。予約できなければ
      // `JudgeBudgetExceededError` を投げ、ここで握って申告をそのまま残す（判定は助言。§4・§6）。
      try {
        triage = await runUnwritableTriage({
          design: rawDesign,
          documents: input.documents,
          judge: judgeBudget,
          threshold: UNWRITABLE_CONFIDENCE_THRESHOLD,
          // 語彙の穴で「反する」と判定されたとき、その要件だけ設計をやり直す（1 回まで）
          redoDesign: async (requirementId) => {
            const list = {
              ...requirementList,
              requirements: requirementList.requirements.filter(
                (requirement) => requirement.id === requirementId,
              ),
            };
            // 他の要件の採用済みの設計を基準にする（対象の要件は除く。Issue #418）
            const others = [...adoptedDesigns.values()].filter((entry) => entry.requirementId !== requirementId);
            // やり直しの 1 回を、段 `design` の記録（`operation` は `"redo-design"`）として残す
            // （Issue #410）。**戻り方は変えない**——段の失敗は今までどおり `undefined` を返し、例外は
            // 記録を足して投げ直し、外側の既存の catch に委ねる。
            const before = meter.snapshot;
            const value = await redoDesignRecorded({
              call: () =>
                runDesign({
                  list,
                  documents: input.documents,
                  gateway,
                  ...versionField,
                  redo: { roles: rawDesign.roles ?? [], adopted: others, wholeList: requirementList },
                }),
              now: input.now,
              push: (status, durationMs, failureKind) => {
                stages.push(
                  makeStageRecord(
                    "design",
                    status,
                    durationMs,
                    usageDelta(before, meter.snapshot),
                    failureKind,
                    "redo-design",
                  ),
                );
              },
            });
            const entry = value?.designs[0];
            // 採用を基準へ反映する（同時に更新。Issue #418）
            if (entry !== undefined) adoptedDesigns.set(requirementId, entry);
            return entry;
          },
        });
      } catch {
        triage = undefined;
      }
    }
    const design = triage?.design ?? rawDesign;
    // ② の設計を、受理した時点で材料として積む（仕分けのあとに採った版。Issue #417）
    materialStore.design = await acceptSlot(design, lastOkStageIndex("design"));

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
      const requirement = requirementList.requirements.find((candidate) => candidate.id === requirementId);
      return {
        requirementId,
        text: requirement?.text ?? "",
        quote: requirement?.quote ?? "",
        unwritable: parts,
      };
    });
    const unwritableRequirements = unwritable.length;

    // 確定した仕様があるときは、設計の「書けない」を `accepted_unwritable`（了承して除いた部分の**部分 ID**）と
    // 突き合わせる（§5・Issue #334）。**了承済みの部分だけが書けない要件は、合格（full）を妨げない**。
    // 了承の外にある「書けない」は「Plan の見落とし」として部分案になる（`decideOutcome`）。
    const acceptedTextsByRequirement = new Map<string, ReadonlySet<string>>();
    if (input.plan !== undefined) {
      const acceptedIds = acceptedUnwritablePartIds(input.plan);
      for (const requirement of input.plan.requirements) {
        const texts = new Set<string>();
        for (const part of requirement.parts) if (acceptedIds.has(part.id)) texts.add(part.text);
        if (texts.size > 0) acceptedTextsByRequirement.set(requirement.id, texts);
      }
    }
    const acceptedUnwritable =
      input.plan === undefined
        ? undefined
        : unwritable.filter((entry) =>
            entry.unwritable.every(
              (part) => acceptedTextsByRequirement.get(entry.requirementId)?.has(part) === true,
            ),
          ).length;

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
    // `judge` は**予算に結び付けた包み**（judgeBudget）をそのまま渡す（Issue #373）——種類が食い違った
    // 要件の判定の呼び出しも、段の呼び出しと同じ予算で予約・精算し、要約の `judge` 欄に数える。
    const testSuite = await runStageOk("test-suite", () =>
      runTestSuite({
        list: requirementList,
        design,
        documents: input.documents,
        gateway,
        ...versionField,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(judgeBudget === undefined ? {} : { judge: judgeBudget }),
        // 固定の前に外した試験を、**回ごとに**受け取る（②' が最後に失敗しても・後の段で早く止まっても
        // 要約に残すため。成功の戻り値だけに頼らない。Issue #392）
        onDropped: (dropped) => {
          for (const entry of dropped) droppedTests.push(entry);
        },
      }),
    );
    natureDiscrepancies = toBundleNatureDiscrepancies(testSuite.discrepancies);
    // ②' の固定した試験の組（分類込み。棄却で外す前）を、受理した時点で材料として積む（Issue #417）
    materialStore.testSuite = await acceptSlot(testSuite.suite, lastOkStageIndex("test-suite"));

    // ③ 書く
    const written = await runStageOk("write", () =>
      runWrite({ list: requirementList, design, documents: input.documents, gateway }),
    );
    // ③ が提出した対応を、受理した時点で材料として積む（Issue #417）
    materialStore.mappings = await acceptSlot(written.mappings, lastOkStageIndex("write"));

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
    // 要件ごとの所属（② の設計から写す。Issue #431）。**版は呼ぶ側が明示する**——互換（`legacy`）を
    // 明示したときだけ渡さず、従来の表全体の点検を保つ。省いた新契約では、設計の所属をそのまま渡す。
    const ownership: readonly RequirementRoleOwnership[] | undefined =
      input.designVersion === LEGACY_DESIGN_CONTRACT
        ? undefined
        : design.designs.map((entry) => ({
            requirementId: entry.requirementId,
            ownership: entry.ownership ?? [],
          }));

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
      // ④ の結果を受け取った時点で、候補の宣言と評価の行を積む（Issue #417）。⑤a・⑤b の完了時に、
      // **同じ宣言の SHA-256 の行**へ追記する。
      recordDeclaration(declaration, declarationSha256, staticCheck);
      const row = evaluationRow(declarationSha256, staticCheck);
      if (!staticCheck.passed || staticCheck.app === null) {
        return {
          declaration,
          declarationSha256,
          staticCheck,
          correspondence: null,
          testRun: null,
          routes: [],
          defectMisses: [],
          redoMisses: [],
        };
      }
      const app = staticCheck.app;
      let currentEntries = entries;
      if (currentEntries === null || entriesSha !== declarationSha256) {
        if (currentEntries !== null && correspondenceCalls >= limits.correspondenceChecks) return null;
        correspondenceCalls += 1;
        const result = await runStageOk("correspondence", () =>
          runCorrespondence({
            source: input.source,
            list: requirementList,
            declaration,
            app,
            documents: input.documents,
            gateway,
            ...(input.plan === undefined ? {} : { plan: input.plan }),
            ...(roles === undefined ? {} : { roles }),
            ...(useMappings() ? { mappings } : {}),
            ...(ownership === undefined ? {} : { ownership }),
            ...(input.designVersion === undefined ? {} : { version: input.designVersion }),
          }),
        );
        currentEntries = result.entries;
        entries = currentEntries;
        entriesSha = declarationSha256;
      }
      // ⑤a の落ちを、対応の表の不備（③ のやり直し）・要件の対応表の外（⑤a のやり直し）・それ以外
      // （宣言の要素の欠落、⑥）に分ける（§1.3.1・Issue #324・#431）。**画面から辿れない場所は「宣言の
      // 要素の欠落」**なので、③ のやり直しには数えない（⑥ 直すへ回す）
      const entriesMisses = checkCorrespondence(app, requirementList, currentEntries);
      const mappingMisses =
        roles !== undefined && useMappings()
          ? checkRoleMappings(app, roles, currentEntries, mappings, {
              ...(ownership === undefined ? {} : { ownership }),
              ...(input.designVersion === undefined ? {} : { version: input.designVersion }),
            })
          : [];
      const defectMisses = mappingMisses.filter((miss) => miss.route === "correspondence-defect");
      const redoMisses = mappingMisses.filter((miss) => miss.route === "correspondence-redo");
      const correspondence: CorrespondenceResult = {
        entries: currentEntries,
        misses: [...entriesMisses, ...mappingMisses],
      };
      // ⑤a の完了時に、同じ宣言の SHA-256 の行へ追記する（件数だけ。試験 ID と文言は持たない。Issue #417）
      row.correspondence_misses = correspondence.misses.length;
      const report = await runStage("run-tests", async () =>
        runTests({
          app,
          suite: withoutOverturned(),
          correspondence,
          ...(useMappings() ? { mappings } : {}),
          ...(roles === undefined ? {} : { roles }),
        }),
      );
      // ⑤b の完了時に、同じ宣言の SHA-256 の行へ追記する（件数と、行き先ごとの件数だけ。Issue #417）
      row.test_mismatches = report.mismatches.length;
      row.test_unresolved = report.unresolved.length;
      row.routes = countRoutes(report.routes);
      return {
        declaration,
        declarationSha256,
        staticCheck,
        correspondence,
        testRun: report,
        routes: report.routes,
        defectMisses,
        redoMisses,
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

      // ⑤a のやり直し：対応の名前が宣言に実在するのに ⑤a の対応表の外にあるとき（Issue #322・#431）。
      // ③ の対応は正しく、足りないのは ⑤a の対応表の場所なので、**③ のやり直しでも ⑥ でもない**。
      // 落ちた場所を伝えて ⑤a を作り直し、同じ宣言のまま結び付けと試験を流し直す。落ちは 2 経路から来る
      // ——⑤b の構造の検査の行き先（`routes`）と、⑤a の**要件ごとの点検**の落ち（`redoMisses`）。
      const redoRoutes = current.routes.filter((route) => route.route === "correspondence-redo");
      const redoMisses = current.redoMisses;
      if (
        (redoRoutes.length > 0 || redoMisses.length > 0) &&
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
        const previousMisses: readonly CorrespondenceMiss[] = [
          ...redoRoutes.map((route) => ({
            requirementId: route.requirementId ?? "",
            ...(route.location === undefined ? {} : { location: route.location }),
            detail: route.detail,
          })),
          ...redoMisses.map((miss) => ({
            requirementId: miss.requirementId,
            ...(miss.location === undefined ? {} : { location: miss.location }),
            detail: miss.detail,
          })),
        ];
        const retry = await runStageOk("correspondence", () =>
          runCorrespondence({
            source: input.source,
            list: requirementList,
            declaration: current.declaration,
            app,
            documents: input.documents,
            gateway,
            roles,
            ...(input.plan === undefined ? {} : { plan: input.plan }),
            ...(useMappings() ? { mappings } : {}),
            ...(ownership === undefined ? {} : { ownership }),
            ...(input.designVersion === undefined ? {} : { version: input.designVersion }),
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
            list: requirementList,
            roles,
            declaration: current.declaration,
            documents: input.documents,
            gateway,
          }),
        );
        mappings = redo.mappings;
        // ③ のやり直しの対応（最新）を材料として積み直す（Issue #417）
        materialStore.mappings = await acceptSlot(redo.mappings, lastOkStageIndex("write"));
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
          list: requirementList,
          suite: withoutOverturned(),
          current,
          correspondences: current.correspondence?.entries ?? [],
          ...(useMappings() ? { mappings } : {}),
          ...(roles === undefined ? {} : { roles }),
          ...(ownership === undefined ? {} : { ownership }),
          ...(input.designVersion === undefined ? {} : { version: input.designVersion }),
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
            list: requirementList,
            suite: withoutOverturned(),
            declaration: step.declaration,
            disputes: step.disputes,
            documents: input.documents,
            gateway,
            ...(input.plan === undefined ? {} : { plan: input.plan }),
          }),
        );
        collectArbitration(arbitration, upheld, overturned, unresolved);
        // 確定した仕様そのものと食い違う主張があれば、裁定せず Plan に戻して止める（差し戻しは 1 回まで。§5）
        if (arbitration.returnToPlan !== undefined && arbitration.returnToPlan.length > 0) {
          returnToPlan = true;
          for (const testId of arbitration.returnToPlan) if (!returnedToPlan.includes(testId)) returnedToPlan.push(testId);
          stopReason = "unresolved";
          break;
        }
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
      ...(acceptedUnwritable === undefined ? {} : { acceptedUnwritable }),
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
    const droppedSummary = toDroppedNonstructuralTests(droppedTests);
    const summary: BundleSummary = {
      ...buildSummary(record, {
        run_id: input.runId,
        verdict: outcome.verdict,
        assurance: assuranceOf(outcome),
        duration_secs: (input.now() - startedAt) / 1000,
        provider_cost_usd: budget.spentUsd,
        stop_class: failure === null ? "completed" : failure.kind,
        stopReason,
        exit_code: outcome.result === "failed" ? 1 : 0,
      }),
      judge: judgeUsageOf(),
      nature_discrepancies: natureDiscrepancies,
      ...(droppedSummary === undefined ? {} : { dropped_nonstructural_tests: droppedSummary }),
    };
    const bundle = await assembleBundle({
      runId: input.runId,
      storageUnit: input.storageUnit,
      artifactLevel: input.artifactLevel ?? "L2",
      declaration: final.declaration,
      declarationSha256: final.declarationSha256,
      outcome,
      summary,
      requirements: requirementList,
      unwritable,
      triage: triageJudgments,
      markedRequirements,
      dropped: triageDropped,
      correspondence: final.correspondence,
      testRun: final.testRun,
      disputes,
      rejected,
      arbitration: {
        upheld,
        overturned,
        unresolved,
        ...(returnedToPlan.length === 0 ? {} : { returnToPlan: returnedToPlan }),
      },
      builder: input.builder,
      verificationProfile: input.verificationProfile ?? "musunest-factory/l2",
      specEngineVersion: input.specEngineVersion,
      factoryVersion: input.factoryVersion,
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      // 受理した材料（設計・固定した試験・提出された対応）と、材料の状態・版ごとの評価の行（Issue #417）。
      // 完走では、同じ材料を納品物の成果物へ足す（設計・試験・対応の 3 ファイルと、検証の結果の欄）。
      design,
      testSuite: testSuite.suite,
      mappings,
      materials: materialEntries(),
      evaluations: [...materialStore.evaluations.values()],
    });
    return {
      outcome,
      record,
      summary,
      bundle,
      stopped: failure,
      diagnostics: [],
      ...(returnToPlan ? { returnToPlan: true } : {}),
    };
  } catch (error) {
    if (error instanceof RunStop) return stopResult(error.attribution);
    throw error;
  }
}
