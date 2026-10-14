// P3 の「書けない」の申告を、確認の前に判定の口で独立に点検する
// （04-plan-agent.md §3 P3・05-judge-model.md §3・4・Issue #432）。
//
// P3 の洗い出し（surface.ts）が挙げた「書けないこと」は、制約 ID が文書に実在するかだけをコードが
// 確かめ（`checkSurfaceConstraints`）、そのまま `accepted_unwritable`（了承して除く部分）と代わりの案の
// 要件になる。**申告の中身が正しいか**（本当に語彙の穴か・その要件に必要か・制約の節が主張を裏付けるか）
// は点検していない。ここは、Build 側の仕分け（`stages/unwritable-triage.ts`・05 §3）と**同じ作法**で、
// 申告 1 件ずつを次に掛ける（本体は共有しない——入力が P3 の申告の形で、② の設計の型と違うため）。
//
//   1. **仕分け**（Choice 1 問／申告）… 申告を「曖昧さ／語彙の穴／問題ではない」に分ける。**曖昧さ**は
//      開いている事項に写す候補にし（**重大**。了承除外になるはずだった部分を聞かずに落とさない）、
//      **問題ではない**は落とす（分類つき。要件はそのまま残す）。
//   2. **裏付け**（Choice 1 問／語彙の穴の申告）… **申告の全部の制約 ID** の節の抜粋（`constraintExcerpt`）
//      と主張を渡し、「裏付ける／反する／書いていない」を聞く。
//   3. **再点検**（Choice 2 問／未確定の申告。**Luna の別の会話**）… 主の点検で**確信度が閾値未満・
//      確信度が返らない（不明）・裏付けが「書いていない」**だった申告を、独立の会話で点検し直す
//      （05 §3「確信度が低いものは Luna の別の会話に回す」「『書いていない』なら Luna に回す」）。
//      再点検は、申告と対象の要件を**点検の対象のデータ**として渡し、**根拠はコードが用意した有限の
//      ID（節）から選ばせ、本文はコードが取り出す**（閉じた判定と証跡）。生成役の会話・代わりの案の
//      採否・Build の合否は引き継がない（state は空）。
//
// **判定は助言であって門ではない**（05 §4）。点検は申告を**減らす・止める方向にだけ**効く——答えで
// 了承除外を増やさない。受理するのは、仕分けと裏付け（再点検なら分類と根拠）の両方が取れたときだけ
// である。未確定の申告が残れば、呼ぶ側（`runPlan`）が Plan を確定させない（決定⑤）。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。再点検の宛先（Luna）は、
// 呼ぶ側が**明示的に渡した口**（`recheckJudge`）だけを使う——合成した口をもう一度呼ぶと主（Jev）が
// 答え直すだけなので、落とし先が無ければ再点検せず未点検に残す。鍵もファイルも環境変数も扱わない。
import type { Judge, JudgeAnswer, JudgeChoiceQuestion, JudgeQuestion, JudgeResponse } from "../judge.js";
import {
  JudgeBudgetExceededError,
  JudgeCallLimitExceededError,
  JudgeDeadlineExceededError,
} from "../judge-budget.js";
import { constraintExcerpt, type PromptDocument } from "../stages/prompt.js";
import type { PlanSurface, PlanUnwritable } from "./surface.js";

/** 申告の仕分けのラベル（§3） */
export const SURFACE_TRIAGE_LABELS = ["ambiguity", "vocabulary-hole", "not-a-problem"] as const;
export type SurfaceTriageLabel = (typeof SURFACE_TRIAGE_LABELS)[number];

/** 語彙の穴の裏付けの答え（§3） */
export const SURFACE_SUPPORT_VERDICTS = ["supports", "contradicts", "not-stated"] as const;
export type SurfaceSupportVerdict = (typeof SURFACE_SUPPORT_VERDICTS)[number];

/** 再点検の仕分けの答え（語彙の穴か・問題ではないか・曖昧さか・判定不能か。Issue #432） */
export const SURFACE_RECHECK_KINDS = ["vocabulary-hole", "not-a-problem", "ambiguity", "undecidable"] as const;
export type SurfaceRecheckKind = (typeof SURFACE_RECHECK_KINDS)[number];

/**
 * 有限の答えの集合の判定（`includes` の型を避けるための小さな道具）。**未知の答えを確信度で分けない**
 * ——仕分け・裏付けとも、まずここで所属を確かめ、未知なら確信度にかかわらず未点検にする。
 */
const TRIAGE_LABELS: ReadonlySet<string> = new Set(SURFACE_TRIAGE_LABELS);
const SUPPORT_VERDICTS: ReadonlySet<string> = new Set(SURFACE_SUPPORT_VERDICTS);
const RECHECK_KINDS: ReadonlySet<string> = new Set(SURFACE_RECHECK_KINDS);

/** 再点検の根拠の問いで、どの節も述べていないことを示す選択肢の名前（Issue #432） */
export const SURFACE_RECHECK_NO_EVIDENCE = "none" as const;

/** 仕分けの問いの名前の頭（Plan 用に別に決める。Build の `triage:`・`support:` と混ぜない。Issue #432）。 */
export const SURFACE_TRIAGE_QUESTION_PREFIX = "plan-triage";
/** 裏付けの問いの名前の頭（Plan 用） */
export const SURFACE_SUPPORT_QUESTION_PREFIX = "plan-support";
/** 再点検の仕分けの問いの名前の頭（Plan 用。Luna の別の会話。Issue #432） */
export const SURFACE_RECHECK_KIND_QUESTION_PREFIX = "plan-recheck-kind";
/** 再点検の根拠の問いの名前の頭 */
export const SURFACE_RECHECK_EVIDENCE_QUESTION_PREFIX = "plan-recheck-evidence";

/** 仕分けの問いの ID（申告の番号で決まる。問いの名前だけでは判定が読めないので、欄に申告を載せる） */
export function surfaceTriageQuestionName(index: number): string {
  return `${SURFACE_TRIAGE_QUESTION_PREFIX}:${index}`;
}

/** 裏付けの問いの ID */
export function surfaceSupportQuestionName(index: number): string {
  return `${SURFACE_SUPPORT_QUESTION_PREFIX}:${index}`;
}

/**
 * 仕分けの問い（T1）。**今の点検の問い**をそのまま組み立てる——比較の道具（`claim-forms.ts`）は、
 * この関数を呼ぶ（文・criteria・順を変えない。Issue #459）。
 */
export function surfaceTriageQuestion(claim: PlanUnwritable): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      // 対象の申告（部分と理由と制約 ID）を問いの欄に載せる（問いの名前だけでは判定が読めない。Issue #376）
      part: claim.part,
      reason: claim.reason,
      constraintIds: claim.constraintIds,
      ask: "Which kind of 'cannot write' claim is this? Only a claim that is genuinely unwritable because the vocabulary is missing is a vocabulary-hole.",
    },
    criteria: {
      ambiguity: "曖昧さ・決めたこと・不確かさのメモ（語彙の穴ではない）",
      "vocabulary-hole": "文書の語彙に無いために書けない（語彙の穴）",
      "not-a-problem": "問題ではない（要件の言い直しなど。実際には書けている）",
    },
  };
}

/**
 * 裏付けの問い（S1）。**今の点検の問い**をそのまま組み立てる——比較の道具は、この関数を呼ぶ
 * （文・criteria・順を変えない。Issue #459）。抜粋は申告の制約 ID の節から取り出す。
 */
export function surfaceSupportQuestion(
  claim: PlanUnwritable,
  documents: readonly PromptDocument[],
): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      // 申告の全部の制約 ID の節の抜粋と、主張（部分と理由）を問いの欄に載せる（Issue #376）
      part: claim.part,
      reason: claim.reason,
      excerpt: constraintExcerpt(documents, claim.constraintIds),
      ask: "Does the excerpt (the relevant section of the documents) support the claim that this part cannot be written? If the excerpt does not state it, answer not-stated.",
    },
    criteria: {
      supports: "抜粋が主張を裏付ける",
      contradicts: "抜粋が主張に反する",
      "not-stated": "抜粋に書いていない",
    },
  };
}

/** 再点検の仕分けの問いの ID */
export function surfaceRecheckKindQuestionName(index: number): string {
  return `${SURFACE_RECHECK_KIND_QUESTION_PREFIX}:${index}`;
}

/** 再点検の根拠の問いの ID */
export function surfaceRecheckEvidenceQuestionName(index: number): string {
  return `${SURFACE_RECHECK_EVIDENCE_QUESTION_PREFIX}:${index}`;
}

/** 落とした申告の分類（`not-a-problem`・裏付けが `contradicts`。Issue #432） */
export const SURFACE_DROPPED_CODES = ["not-a-problem", "contradicts"] as const;
export type SurfaceDroppedCode = (typeof SURFACE_DROPPED_CODES)[number];

/**
 * 未点検の分類（確信度が閾値未満・裏付けが「書いていない」・答えが読めない。Issue #432）。
 * **有限の 3 値**で、確定できなかった理由の分類（`PLAN_DIAGNOSIS_CODES`）にも写す。
 */
export const SURFACE_UNCHECKED_CODES = ["not-stated", "low-confidence", "unknown"] as const;
export type SurfaceUncheckedCode = (typeof SURFACE_UNCHECKED_CODES)[number];

/** 点検の段階（診断に残す。Issue #432）。`unexecuted` は判定を呼ぶ前に止まった印 */
export const SURFACE_CHECK_STAGES = ["unexecuted", "triage", "support", "recheck"] as const;
export type SurfaceCheckStage = (typeof SURFACE_CHECK_STAGES)[number];

/** 判定 1 件の記録（問いの ID・答え・確信度・答えたモデルの版・adapter。依頼文の全文は残さない。§4） */
export interface SurfaceJudgment {
  /** 問いの ID */
  readonly questionId: string;
  /** 答え（仕分けのラベル、または裏付けの判定。読めないときは `unknown`） */
  readonly answer: string;
  /** 確信度（返せない adapter では `undefined`＝不明） */
  readonly confidence: number | undefined;
  /** 答えたモデルの版の ID */
  readonly model: string;
  /** 答えた adapter（jev・llm・fake） */
  readonly answeredBy: string;
}

/** 落とした申告 1 件（分類つき。要件はそのまま残す。Issue #432） */
export interface SurfaceDroppedClaim {
  /** 申告の番号（`surface.unwritable` の位置。欄の名前の組み立てにだけ使う） */
  readonly index: number;
  readonly requirementId: string;
  /** 書けないと申告された部分 */
  readonly part: string;
  /** 申告が添えた理由 */
  readonly reason: string;
  /** 落とした理由の分類 */
  readonly code: SurfaceDroppedCode;
}

/** 曖昧さと判定された申告 1 件（開いている事項に写す候補。重大。Issue #432） */
export interface SurfaceAmbiguityClaim {
  readonly index: number;
  readonly requirementId: string;
  readonly part: string;
  readonly reason: string;
}

/** 未点検の申告 1 件（分類つき。Issue #432） */
export interface SurfaceUncheckedClaim {
  readonly index: number;
  readonly requirementId: string;
  readonly part: string;
  /** 未点検の理由の分類 */
  readonly code: SurfaceUncheckedCode;
}

/**
 * 申告 1 件ずつの診断（Issue #432）。**受理・落とした・途中停止のどれも**残す——申告の添字・要件 ID・
 * 部分・理由・制約 ID・文書の版と、点検の段階・分類・adapter・確信度・根拠 ID を結び付ける。
 * 中間の（まだ確定していない）申告は、そこまでに点検した段階の印を持つ。
 */
export interface SurfaceClaimDiagnostic {
  readonly index: number;
  readonly requirementId: string;
  readonly part: string;
  readonly reason: string;
  readonly constraintIds: readonly string[];
  /** 文書（語彙）の版 */
  readonly docVersion: string;
  /** 点検の段階（仕分け・裏付け・再点検） */
  readonly stage: SurfaceCheckStage;
  /** 分類（仕分けのラベル・裏付けの判定・落とした分類・未点検の分類・再点検の判定） */
  readonly classification: string;
  /** 答えた adapter（jev・llm・fake。答えが無ければ `none`） */
  readonly adapter: string;
  /** 確信度（不明は `null`） */
  readonly confidence: number | null;
  /** 根拠の ID（受理のときだけ。無ければ `null`） */
  readonly evidenceId: string | null;
}

/** 点検の結果（受理・落とした・曖昧さへ・未点検と、判定の記録と診断） */
export interface SurfaceCheckResult {
  /** 受理した申告（語彙の穴で裏付けが取れたもの。呼ぶ側が了承除外にする） */
  readonly accepted: readonly PlanUnwritable[];
  /** 落とした申告（問題ではない・裏付けが反する。分類つき） */
  readonly dropped: readonly SurfaceDroppedClaim[];
  /** 曖昧さと判定された申告（開いている事項に写す候補） */
  readonly ambiguities: readonly SurfaceAmbiguityClaim[];
  /** 未点検の申告（裏付けが書いていない・確信度が閾値未満・答えが読めない） */
  readonly unchecked: readonly SurfaceUncheckedClaim[];
  /** 判定の記録（仕分け・裏付け・再点検のすべて） */
  readonly judgments: readonly SurfaceJudgment[];
  /** 申告 1 件ずつの診断（受理・落とした・途中停止のどれも） */
  readonly diagnostics: readonly SurfaceClaimDiagnostic[];
}

/** 点検が受け取るもの */
export interface SurfaceCheckInput {
  /** P3 の出力（申告の一覧） */
  readonly surface: PlanSurface;
  /** 段に渡した文書（制約 ID の節の抜粋を取り出すのに使う） */
  readonly documents: readonly PromptDocument[];
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む）。落とし先（Luna）は `recheckJudge` から取る */
  readonly judge: Judge;
  /**
   * **再点検専用の Luna の口**（同じ Plan 予算で包んだもの。Issue #432）。無ければ再点検せず、未確定の
   * 申告は未点検に残す——合成した口をもう一度呼ぶと主（Jev）が答え直すだけなので、主を再点検には使わない。
   */
  readonly recheckJudge?: Judge;
  /** 確信度の閾値（これ**未満**は未確定） */
  readonly threshold: number;
  /** 対象の要件の文（要件 ID → 文）。再点検の対象のデータに使う（Issue #432） */
  readonly requirements: ReadonlyMap<string, string>;
  /** 文書（語彙）の版。診断に残す（Issue #432） */
  readonly docVersion: string;
  /**
   * 途中までに得た分類と判定を報告する口（任意。Issue #432）。仕分け・裏付けのあとに呼ぶ——続く段の
   * 予算が尽きても、**そこまでに終えた点検を呼ぶ側が残せる**ようにする。段の成否・停止の意味は変えない。
   */
  readonly onProgress?: (result: SurfaceCheckResult) => void;
}

/** 答えから、選んだ選択肢を取り出す（choice でない・無いときは `undefined`） */
function choiceOf(answer: JudgeAnswer | undefined): string | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.choice : undefined;
}

/** 答えから、確信度を取り出す（choice でない・無いときは `undefined`＝不明） */
function confidenceOf(answer: JudgeAnswer | undefined): number | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.confidence : undefined;
}

/** まだ確定していない申告（再点検へ回す。Issue #432） */
interface PendingClaim {
  readonly claim: PlanUnwritable;
  readonly index: number;
  readonly stage: SurfaceCheckStage;
  /** 未確定だといった理由の分類（`low-confidence`・`unknown-confidence`・`not-stated`） */
  readonly classification: string;
  readonly adapter: string;
  readonly confidence: number | null;
}

/**
 * P3 の「書けない」の申告を、判定の口で仕分け・裏付け・再点検する（04 §3 P3・05 §3・Issue #432）。
 *
 * **推測で了承除外を増やさない**：受理するのは、仕分けと裏付け（再点検なら分類と根拠）の両方が取れた
 * ときだけである。**確信度が返らない（不明）を低い確信度と同じにせず**、どちらも再点検へ回す印にする
 * （E）。再点検は一度だけ行い、同じ問いを繰り返さない。
 */
export async function runSurfaceCheck(input: SurfaceCheckInput): Promise<SurfaceCheckResult> {
  const judgments: SurfaceJudgment[] = [];
  const accepted: PlanUnwritable[] = [];
  const dropped: SurfaceDroppedClaim[] = [];
  const ambiguities: SurfaceAmbiguityClaim[] = [];
  const unchecked: SurfaceUncheckedClaim[] = [];
  const diagnostics = new Map<number, SurfaceClaimDiagnostic>();

  const claims = input.surface.unwritable;

  const baseOf = (claim: PlanUnwritable, index: number): Omit<SurfaceClaimDiagnostic, "stage" | "classification" | "adapter" | "confidence" | "evidenceId"> => ({
    index,
    requirementId: claim.requirementId,
    part: claim.part,
    reason: claim.reason,
    constraintIds: claim.constraintIds,
    docVersion: input.docVersion,
  });

  const setDiagnostic = (
    claim: PlanUnwritable,
    index: number,
    stage: SurfaceCheckStage,
    classification: string,
    adapter: string,
    confidence: number | null,
    evidenceId: string | null,
  ): void => {
    diagnostics.set(index, { ...baseOf(claim, index), stage, classification, adapter, confidence, evidenceId });
  };

  const snapshot = (): SurfaceCheckResult => ({
    accepted: accepted.slice(),
    dropped: dropped.slice(),
    ambiguities: ambiguities.slice(),
    unchecked: unchecked.slice(),
    judgments: judgments.slice(),
    diagnostics: claims
      .map((_claim, index) => diagnostics.get(index))
      .filter((entry): entry is SurfaceClaimDiagnostic => entry !== undefined),
  });

  const report = (): void => {
    input.onProgress?.(snapshot());
  };

  if (claims.length === 0) return snapshot();

  // **最初の判定を呼ぶ前に**、全申告の最小データと「未実行」の印を登録して報告する（Issue #432）。最初の
  // 判定の予約が失敗しても、`plan-surface-check.json` に申告が 1 件も残らない（申告が無かった場合と区別
  // できない）ことを避ける。
  claims.forEach((claim, index) => setDiagnostic(claim, index, "unexecuted", "unexecuted", "none", null, null));
  report();

  // ── 1. 仕分け（曖昧さ／語彙の穴／問題ではない）──────────────────────
  const triageQuestions: Record<string, JudgeQuestion> = {};
  claims.forEach((claim, index) => {
    // 問いの組み立ては**道具と共有する 1 つの関数**（`surfaceTriageQuestion`。Issue #459）
    triageQuestions[surfaceTriageQuestionName(index)] = surfaceTriageQuestion(claim);
  });
  const classify = await safeJudge(input.judge, { state: {}, questions: triageQuestions });

  const holes: { readonly claim: PlanUnwritable; readonly index: number }[] = [];
  const pending: PendingClaim[] = [];
  claims.forEach((claim, index) => {
    if (classify === null) {
      // 判定の口が使えない（両方の adapter の失敗）。申告は未確定のまま残す（確認へ進ませない）
      unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
      setDiagnostic(claim, index, "triage", "unknown", "none", null, null);
      return;
    }
    const name = surfaceTriageQuestionName(index);
    const answer = classify.answers[name];
    const label = choiceOf(answer);
    const confidence = confidenceOf(answer);
    judgments.push({
      questionId: name,
      answer: label ?? "unknown",
      confidence,
      model: classify.model,
      answeredBy: classify.answeredBy,
    });
    if (label === undefined || !TRIAGE_LABELS.has(label)) {
      // **未知の答えは、確信度にかかわらず**未点検として残す（拒否が確信度で変わらないように。Issue #432）
      unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
      setDiagnostic(claim, index, "triage", "unknown", classify.answeredBy, confidence ?? null, null);
    } else if (confidence === undefined || confidence < input.threshold) {
      // **独立の仕分けが成立していない**（確信度が閾値未満・不明）。分類先へ流す前に、再点検へ回す印にする
      // （E：不明を低い確信度と同じにせず、別の印にする。Issue #432）。
      const mark = confidence === undefined ? "unknown-confidence" : "low-confidence";
      pending.push({ claim, index, stage: "triage", classification: mark, adapter: classify.answeredBy, confidence: confidence ?? null });
      setDiagnostic(claim, index, "triage", mark, classify.answeredBy, confidence ?? null, null);
    } else if (label === "ambiguity") {
      ambiguities.push({ index, requirementId: claim.requirementId, part: claim.part, reason: claim.reason });
      setDiagnostic(claim, index, "triage", "ambiguity", classify.answeredBy, confidence, null);
    } else if (label === "not-a-problem") {
      dropped.push({
        index,
        requirementId: claim.requirementId,
        part: claim.part,
        reason: claim.reason,
        code: "not-a-problem",
      });
      setDiagnostic(claim, index, "triage", "not-a-problem", classify.answeredBy, confidence, null);
    } else {
      // vocabulary-hole（有限のラベルは上で確かめ済み）。裏付けはこれから。途中で止まっても診断に残るよう、
      // 仕分けの結果を先に置く（Issue #432）
      holes.push({ claim, index });
      setDiagnostic(claim, index, "triage", "vocabulary-hole", classify.answeredBy, confidence, null);
    }
  });
  report();

  // ── 2. 語彙の穴の裏付け（制約 ID の節の抜粋と主張）──────────────────
  if (holes.length > 0) {
    const supportQuestions: Record<string, JudgeQuestion> = {};
    for (const { claim, index } of holes) {
      // 問いの組み立ては**道具と共有する 1 つの関数**（`surfaceSupportQuestion`。Issue #459）
      supportQuestions[surfaceSupportQuestionName(index)] = surfaceSupportQuestion(claim, input.documents);
    }
    const support = await safeJudge(input.judge, { state: {}, questions: supportQuestions });

    for (const { claim, index } of holes) {
      if (support === null) {
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
        setDiagnostic(claim, index, "support", "unknown", "none", null, null);
        continue;
      }
      const name = surfaceSupportQuestionName(index);
      const answer = support.answers[name];
      const verdict = choiceOf(answer);
      const confidence = confidenceOf(answer);
      judgments.push({
        questionId: name,
        answer: verdict ?? "unknown",
        confidence,
        model: support.model,
        answeredBy: support.answeredBy,
      });
      if (verdict === undefined || !SUPPORT_VERDICTS.has(verdict)) {
        // **未知の答えは、確信度にかかわらず**未点検として残す（Issue #432）
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
        setDiagnostic(claim, index, "support", "unknown", support.answeredBy, confidence ?? null, null);
      } else if (verdict === "not-stated") {
        // 裏付けが「書いていない」→ 再点検へ（05 §3）
        pending.push({ claim, index, stage: "support", classification: "not-stated", adapter: support.answeredBy, confidence: confidence ?? null });
        setDiagnostic(claim, index, "support", "not-stated", support.answeredBy, confidence ?? null, null);
      } else if (confidence === undefined || confidence < input.threshold) {
        // 確信度が閾値未満・不明 → 再点検へ（E）
        const mark = confidence === undefined ? "unknown-confidence" : "low-confidence";
        pending.push({ claim, index, stage: "support", classification: mark, adapter: support.answeredBy, confidence: confidence ?? null });
        setDiagnostic(claim, index, "support", mark, support.answeredBy, confidence ?? null, null);
      } else if (verdict === "supports") {
        accepted.push(claim);
        setDiagnostic(claim, index, "support", "supports", support.answeredBy, confidence, null);
      } else {
        // contradicts（有限の判定は上で確かめ済み）
        dropped.push({
          index,
          requirementId: claim.requirementId,
          part: claim.part,
          reason: claim.reason,
          code: "contradicts",
        });
        setDiagnostic(claim, index, "support", "contradicts", support.answeredBy, confidence, null);
      }
    }
    report();
  }

  // ── 3. 再点検（Luna の別の会話。独立の点検。Issue #432）──────────────
  if (pending.length > 0) {
    // 再点検の宛先は、呼ぶ側が**明示的に渡した Luna の口**だけを使う（Issue #432）。合成した口をもう一度
    // 呼ぶと主（Jev）が答え直すだけなので、主を再点検には使わない。Luna の口が無ければ再点検せず未点検に残す。
    const luna = input.recheckJudge;
    if (luna === undefined) {
      for (const entry of pending) {
        unchecked.push({ index: entry.index, requirementId: entry.claim.requirementId, part: entry.claim.part, code: "unknown" });
        setDiagnostic(entry.claim, entry.index, "recheck", "unknown", "none", null, null);
      }
      report();
      return snapshot();
    }
    const kindQuestions: Record<string, JudgeQuestion> = {};
    const evidenceQuestions: Record<string, JudgeQuestion> = {};
    for (const entry of pending) {
      const requirement = input.requirements.get(entry.claim.requirementId) ?? "";
      kindQuestions[surfaceRecheckKindQuestionName(entry.index)] = {
        kind: "choice",
        instructions: {
          // 申告と対象の要件を、点検の対象のデータとして渡す（生成役の会話は引き継がない）
          requirement,
          part: entry.claim.part,
          reason: entry.claim.reason,
          ask: "Is this claim a genuine vocabulary hole that is needed to build the requirement? Answer undecidable if it cannot be decided from the given data.",
        },
        criteria: {
          "vocabulary-hole": "文書の語彙に無いために書けない（語彙の穴）",
          "not-a-problem": "問題ではない（要件の言い直しなど。実際には書けている）",
          ambiguity: "曖昧さ・決めたこと・不確かさのメモ（語彙の穴ではない）",
          undecidable: "与えられたデータでは判定できない",
        },
      };
      const candidates = entry.claim.constraintIds.map((id) => ({
        id,
        section: constraintExcerpt(input.documents, [id]),
      }));
      const evidenceCriteria: Record<string, string> = {};
      for (const candidate of candidates) evidenceCriteria[candidate.id] = `節 ${candidate.id} が書けないことを述べている`;
      evidenceCriteria[SURFACE_RECHECK_NO_EVIDENCE] = "どの節も述べていない";
      evidenceQuestions[surfaceRecheckEvidenceQuestionName(entry.index)] = {
        kind: "choice",
        instructions: {
          part: entry.claim.part,
          reason: entry.claim.reason,
          // 根拠はコードが用意した有限の ID（節）から選ばせ、本文はコードが取り出す（証跡）
          candidates,
          ask: `Which candidate section (by id) states that this part cannot be written in the vocabulary? Answer ${SURFACE_RECHECK_NO_EVIDENCE} if no candidate states it.`,
        },
        criteria: evidenceCriteria,
      };
    }
    const recheck = await safeJudge(luna, { state: {}, questions: { ...kindQuestions, ...evidenceQuestions } });

    for (const entry of pending) {
      const { claim, index } = entry;
      if (recheck === null) {
        // 落とし先も使えない → 未確定のまま残す（確認へ進ませない）
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
        setDiagnostic(claim, index, "recheck", "unknown", "none", null, null);
        continue;
      }
      const kindName = surfaceRecheckKindQuestionName(index);
      const evidenceName = surfaceRecheckEvidenceQuestionName(index);
      const kind = choiceOf(recheck.answers[kindName]);
      const kindConfidence = confidenceOf(recheck.answers[kindName]);
      const evidence = choiceOf(recheck.answers[evidenceName]);
      judgments.push({
        questionId: kindName,
        answer: kind ?? "unknown",
        confidence: kindConfidence,
        model: recheck.model,
        answeredBy: recheck.answeredBy,
      });
      judgments.push({
        questionId: evidenceName,
        answer: evidence ?? "unknown",
        confidence: confidenceOf(recheck.answers[evidenceName]),
        model: recheck.model,
        answeredBy: recheck.answeredBy,
      });
      const evidenceId =
        evidence !== undefined && claim.constraintIds.includes(evidence) ? evidence : null;
      if (kind === undefined || !RECHECK_KINDS.has(kind)) {
        // 未知の判定・読めない答えは、確信度にかかわらず未点検（Issue #432）
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
        setDiagnostic(claim, index, "recheck", "unknown", recheck.answeredBy, kindConfidence ?? null, null);
      } else if (kind === "not-a-problem") {
        dropped.push({ index, requirementId: claim.requirementId, part: claim.part, reason: claim.reason, code: "not-a-problem" });
        setDiagnostic(claim, index, "recheck", "not-a-problem", recheck.answeredBy, kindConfidence ?? null, null);
      } else if (kind === "ambiguity") {
        ambiguities.push({ index, requirementId: claim.requirementId, part: claim.part, reason: claim.reason });
        setDiagnostic(claim, index, "recheck", "ambiguity", recheck.answeredBy, kindConfidence ?? null, null);
      } else if (kind === "undecidable") {
        // 判定不能 → 未点検
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
        setDiagnostic(claim, index, "recheck", "unknown", recheck.answeredBy, kindConfidence ?? null, null);
      } else if (evidenceId !== null) {
        // vocabulary-hole かつ根拠（節）が取れたときだけ受理する（分類と根拠の両方）
        accepted.push(claim);
        setDiagnostic(claim, index, "recheck", "vocabulary-hole", recheck.answeredBy, kindConfidence ?? null, evidenceId);
      } else {
        // 語彙の穴だが根拠が取れない → 未点検（根拠不足）
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "not-stated" });
        setDiagnostic(claim, index, "recheck", "not-stated", recheck.answeredBy, kindConfidence ?? null, null);
      }
    }
    report();
  }

  return snapshot();
}

/**
 * 判定の口を 1 回呼ぶ。**判定が失敗しても工場は止めない**（05 §6「Jev が止まっても工場は止まらない」）
 * ——ただし**予算・締切・総呼び出し数の門で止まったときは投げ直す**（呼ぶ側が段の失敗（`budget`・
 * `deadline`・`call-limit`）として記録し、申告を通さない。Issue #432）。それ以外の失敗は `null` にして、
 * 呼び側が「未確定」として扱う（確認へ進ませない）。
 */
async function safeJudge(judge: Judge, request: Parameters<Judge["judge"]>[0]): Promise<JudgeResponse | null> {
  try {
    return await judge.judge(request);
  } catch (error) {
    if (
      error instanceof JudgeBudgetExceededError ||
      error instanceof JudgeDeadlineExceededError ||
      error instanceof JudgeCallLimitExceededError
    ) {
      throw error;
    }
    // `stop` の印を持つ誤り（記録の口の欠落など）も**握らずに投げ直す**——点検できないものを未確定に
    // 化けさせず、呼ぶ側が止められるようにする（Issue #459・F7）。
    if (typeof error === "object" && error !== null && (error as { readonly stop?: unknown }).stop === true) {
      throw error;
    }
    return null;
  }
}
