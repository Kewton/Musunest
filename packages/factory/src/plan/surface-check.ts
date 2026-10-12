// P3 の「書けない」の申告を、確認の前に判定の口で独立に点検する
// （04-plan-agent.md §3 P3・05-judge-model.md §3・4・Issue #432）。
//
// P3 の洗い出し（surface.ts）が挙げた「書けないこと」は、制約 ID が文書に実在するかだけをコードが
// 確かめ（`checkSurfaceConstraints`）、そのまま `accepted_unwritable`（了承して除く部分）と代わりの案の
// 要件になる。**申告の中身が正しいか**（本当に語彙の穴か・制約の節が主張を裏付けるか）は点検していない。
// ここは、Build 側の仕分け（`stages/unwritable-triage.ts`・05 §3）と**同じ作法**で、申告 1 件ずつを
// 次に掛ける（本体は共有しない——入力が P3 の申告の形で、② の設計の型と違うため）。
//
//   1. **仕分け**（Choice 1 問／申告）… 申告を「曖昧さ／語彙の穴／問題ではない」に分ける。
//      **曖昧さ**は開いている事項に写す候補にし（**重大**。了承除外になるはずだった部分を聞かずに
//      落とさない）、**問題ではない**は落とす（分類つき。要件はそのまま残す）。
//   2. **裏付け**（Choice 1 問／語彙の穴の申告）… **申告の全部の制約 ID** の節の抜粋（`constraintExcerpt`）
//      と主張を渡し、「裏付ける／反する／書いていない」を聞く。**裏付ける**かつ**確信度が閾値以上**の
//      ものだけを `accepted` にする。**反する**は落とし（分類つき）、**書いていない**・確信度が閾値
//      未満・答えが読めない（unknown）は**未点検**として残す。
//
// **判定は助言であって門ではない**（05 §4）。点検は申告を**減らす・止める方向にだけ**効く——答えで
// 了承除外を増やさない。未点検が 1 件でも残れば、呼ぶ側（`runPlan`）が Plan を確定させない。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。鍵もファイルも環境変数も
// 扱わない（CLAUDE.md の不変条件）。
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";
import { constraintExcerpt, type PromptDocument } from "../stages/prompt.js";
import type { PlanSurface, PlanUnwritable } from "./surface.js";

/** 申告の仕分けのラベル（§3） */
export const SURFACE_TRIAGE_LABELS = ["ambiguity", "vocabulary-hole", "not-a-problem"] as const;
export type SurfaceTriageLabel = (typeof SURFACE_TRIAGE_LABELS)[number];

/** 語彙の穴の裏付けの答え（§3） */
export const SURFACE_SUPPORT_VERDICTS = ["supports", "contradicts", "not-stated"] as const;
export type SurfaceSupportVerdict = (typeof SURFACE_SUPPORT_VERDICTS)[number];

/**
 * 仕分けの問いの名前の頭（Plan 用に別に決める。Build の `triage:`・`support:` と混ぜない。Issue #432）。
 * 問いの ID は `plan-triage:<申告の番号>`。
 */
export const SURFACE_TRIAGE_QUESTION_PREFIX = "plan-triage";
/** 裏付けの問いの名前の頭（Plan 用） */
export const SURFACE_SUPPORT_QUESTION_PREFIX = "plan-support";

/** 仕分けの問いの ID（申告の番号で決まる。問いの名前だけでは判定が読めないので、欄に申告を載せる） */
export function surfaceTriageQuestionName(index: number): string {
  return `${SURFACE_TRIAGE_QUESTION_PREFIX}:${index}`;
}

/** 裏付けの問いの ID */
export function surfaceSupportQuestionName(index: number): string {
  return `${SURFACE_SUPPORT_QUESTION_PREFIX}:${index}`;
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

/** 点検の結果（受理・落とした・曖昧さへ・未点検と、判定の記録） */
export interface SurfaceCheckResult {
  /** 受理した申告（語彙の穴で裏付けが取れたもの。呼ぶ側が了承除外にする） */
  readonly accepted: readonly PlanUnwritable[];
  /** 落とした申告（問題ではない・裏付けが反する。分類つき） */
  readonly dropped: readonly SurfaceDroppedClaim[];
  /** 曖昧さと判定された申告（開いている事項に写す候補） */
  readonly ambiguities: readonly SurfaceAmbiguityClaim[];
  /** 未点検の申告（裏付けが書いていない・確信度が閾値未満・答えが読めない） */
  readonly unchecked: readonly SurfaceUncheckedClaim[];
  /** 判定の記録（仕分けと裏付けの両方） */
  readonly judgments: readonly SurfaceJudgment[];
}

/** 点検が受け取るもの */
export interface SurfaceCheckInput {
  /** P3 の出力（申告の一覧） */
  readonly surface: PlanSurface;
  /** 段に渡した文書（制約 ID の節の抜粋を取り出すのに使う） */
  readonly documents: readonly PromptDocument[];
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /** 確信度の閾値（これ**未満**は未点検） */
  readonly threshold: number;
}

/** 答えから、選んだ選択肢を取り出す（choice でない・無いときは `undefined`） */
function choiceOf(answer: JudgeAnswer | undefined): string | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.choice : undefined;
}

/** 答えから、確信度を取り出す（choice でない・無いときは `undefined`＝不明） */
function confidenceOf(answer: JudgeAnswer | undefined): number | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.confidence : undefined;
}

/**
 * P3 の「書けない」の申告を、判定の口で仕分け・裏付けする（04 §3 P3・05 §3・Issue #432）。判定は差し込まれた
 * `Judge` だけを使う（実 API は呼ばない）。申告が 1 件も無ければ、判定を呼ばずに空の結果を返す。
 *
 * **推測で了承除外を増やさない**：裏付けが取れた（`supports` かつ確信度が閾値以上）申告だけを `accepted`
 * にする。低確信・「書いていない」・読めない答案は `unchecked` として残し、呼ぶ側が確定を止める。
 */
export async function runSurfaceCheck(input: SurfaceCheckInput): Promise<SurfaceCheckResult> {
  const judgments: SurfaceJudgment[] = [];
  const accepted: PlanUnwritable[] = [];
  const dropped: SurfaceDroppedClaim[] = [];
  const ambiguities: SurfaceAmbiguityClaim[] = [];
  const unchecked: SurfaceUncheckedClaim[] = [];

  const claims = input.surface.unwritable;
  if (claims.length === 0) {
    return { accepted, dropped, ambiguities, unchecked, judgments };
  }

  // ── 1. 仕分け（曖昧さ／語彙の穴／問題ではない）──────────────────────
  const triageQuestions: Record<string, JudgeQuestion> = {};
  claims.forEach((claim, index) => {
    triageQuestions[surfaceTriageQuestionName(index)] = {
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
  });
  // state には、問いをまたいで共通に要るものは無い（対象の申告は問いの欄へ移した。依頼文の全文も残さない）
  const classify = await input.judge.judge({ state: {}, questions: triageQuestions });

  const holes: { readonly claim: PlanUnwritable; readonly index: number }[] = [];
  claims.forEach((claim, index) => {
    const name = surfaceTriageQuestionName(index);
    const answer = classify.answers[name];
    const label = choiceOf(answer);
    judgments.push({
      questionId: name,
      answer: label ?? "unknown",
      confidence: confidenceOf(answer),
      model: classify.model,
      answeredBy: classify.answeredBy,
    });
    if (label === "ambiguity") {
      ambiguities.push({ index, requirementId: claim.requirementId, part: claim.part, reason: claim.reason });
    } else if (label === "not-a-problem") {
      dropped.push({
        index,
        requirementId: claim.requirementId,
        part: claim.part,
        reason: claim.reason,
        code: "not-a-problem",
      });
    } else if (label === "vocabulary-hole") {
      holes.push({ claim, index });
    } else {
      // 知らないラベル・答えが読めないものは、捨てずに未点検として残す（確定を止める）
      unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code: "unknown" });
    }
  });

  // ── 2. 語彙の穴の裏付け（制約 ID の節の抜粋と主張）──────────────────
  if (holes.length > 0) {
    const supportQuestions: Record<string, JudgeQuestion> = {};
    for (const { claim, index } of holes) {
      supportQuestions[surfaceSupportQuestionName(index)] = {
        kind: "choice",
        instructions: {
          // 申告の全部の制約 ID の節の抜粋と、主張（部分と理由）を問いの欄に載せる（Issue #376）
          part: claim.part,
          reason: claim.reason,
          excerpt: constraintExcerpt(input.documents, claim.constraintIds),
          ask: "Does the excerpt (the relevant section of the documents) support the claim that this part cannot be written? If the excerpt does not state it, answer not-stated.",
        },
        criteria: {
          supports: "抜粋が主張を裏付ける",
          contradicts: "抜粋が主張に反する",
          "not-stated": "抜粋に書いていない",
        },
      };
    }
    // state には、問いをまたいで共通に要るものは無い（対象の申告と抜粋は問いの欄へ移した）
    const support = await input.judge.judge({ state: {}, questions: supportQuestions });

    for (const { claim, index } of holes) {
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
      const uncheckedClaim = (code: SurfaceUncheckedCode): void => {
        unchecked.push({ index, requirementId: claim.requirementId, part: claim.part, code });
      };
      if (verdict === undefined) {
        // 答えが読めない（unknown）
        uncheckedClaim("unknown");
      } else if (confidence === undefined || confidence < input.threshold) {
        // 確信度が閾値未満（返せない adapter は不明）。裏付けが取れたことにしない
        uncheckedClaim("low-confidence");
      } else if (verdict === "supports") {
        accepted.push(claim);
      } else if (verdict === "contradicts") {
        dropped.push({
          index,
          requirementId: claim.requirementId,
          part: claim.part,
          reason: claim.reason,
          code: "contradicts",
        });
      } else if (verdict === "not-stated") {
        uncheckedClaim("not-stated");
      } else {
        uncheckedClaim("unknown");
      }
    }
  }

  return { accepted, dropped, ambiguities, unchecked, judgments };
}
