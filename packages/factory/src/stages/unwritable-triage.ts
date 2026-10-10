// 設計の「書けない」の申告を、仕分けて裏を取る（05-judge-model.md §2.1・§3・§4・Issue #332）。
//
// ② 設計する、が出した `unwritable`（書けない部分の申告）を、**そのまま信じない**。1 件ずつを
// 判定の口（`Judge`。judge.ts。Jev・LLM・偽物が同じ口を実装する）に掛けて、次を行う。
//
//   1. **仕分け**（Choice 1 問）… 申告を「曖昧さ／語彙の穴／問題ではない」に分ける。
//      曖昧さは設計の `notes` に移し、語彙の穴ではないもの（要件の言い直しなど）は**落とす**（記録を残す）。
//   2. **裏付け**（Choice 1 問）… 語彙の穴だけについて、**制約 ID の節の抜粋**と主張を渡し、
//      「裏付ける／反する／書いていない」を聞く。**反する**なら、その要件だけ設計をやり直す（1 回まで）。
//      「書いていない」と、**確信度が閾値より低い**ものは、そのまま残して**印**を付ける（捨てない）。
//
// **判定は助言であって門ではない**（§4）。最終の合否は今の門（静的チェック・固定した試験・対応表）が
// 決める。ここが返すのは、`notes` に曖昧さを移し、裏付けの取れない申告に印を付けた設計と、落とした
// 申告・判定の記録（問いの ID・答え・確信度・答えたモデルの版）である（依頼文の全文は残さない。S-8）。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。`redoDesign` も差し込む
// （本番は ② の段をもう一度呼ぶ）ので、この file は LLM にも鍵にも触れない。
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";
import type { DesignOutput, RequirementDesignEntry, UnwritableClaim } from "./design.js";
import { constraintExcerpt, type PromptDocument } from "./prompt.js";

/** 申告の仕分けのラベル（§3） */
export const TRIAGE_LABELS = ["ambiguity", "vocabulary-hole", "not-a-problem"] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];

/** 語彙の穴の裏付けの答え（§3） */
export const SUPPORT_VERDICTS = ["supports", "contradicts", "not-stated"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

/** 仕分けの問いの名前の頭（問いの ID は `頭:要件 ID:申告の番号`） */
export const TRIAGE_QUESTION_PREFIX = "triage";
/** 裏付けの問いの名前の頭 */
export const SUPPORT_QUESTION_PREFIX = "support";

/** 仕分けの問いの ID（要件 ID と、その要件の中の申告の番号で決まる） */
export function triageQuestionName(requirementId: string, index: number): string {
  return `${TRIAGE_QUESTION_PREFIX}:${requirementId}:${index}`;
}

/** 裏付けの問いの ID */
export function supportQuestionName(requirementId: string, index: number): string {
  return `${SUPPORT_QUESTION_PREFIX}:${requirementId}:${index}`;
}

/** 判定 1 件の記録（納品物の `unwritable.json` に残す。依頼文の全文は残さない。§4・U-J3） */
export interface TriageJudgment {
  /** 問いの ID */
  readonly questionId: string;
  /** 答え（仕分けのラベル、または裏付けの判定） */
  readonly answer: string;
  /** 確信度（返せない adapter では `undefined`＝不明） */
  readonly confidence: number | undefined;
  /** 答えたモデルの版の ID */
  readonly model: string;
  /** 答えた adapter（jev・llm・fake） */
  readonly answeredBy: string;
}

/** 落とした申告 1 件（曖昧さ・問題ではない。Issue #332） */
export interface DroppedClaim {
  readonly requirementId: string;
  /** 書けないと申告された部分 */
  readonly part: string;
  /** 落とした理由の分類 */
  readonly label: TriageLabel;
  /** 申告が添えた理由 */
  readonly reason: string;
}

/** 残った申告（要件ごと。印つきかどうかを持つ） */
export interface KeptUnwritable {
  readonly requirementId: string;
  readonly claims: readonly UnwritableClaim[];
  /** 印つきで残したか（裏付けが「書いていない」・確信度が閾値未満） */
  readonly marked: boolean;
  /** 語彙の穴で「反する」と判定されて、設計をやり直したか */
  readonly redone: boolean;
}

/** 仕分けと裏付けの結果 */
export interface UnwritableTriageResult {
  /** 曖昧さを `notes` に移し、落とした申告を除いた設計 */
  readonly design: DesignOutput;
  /** 残った申告（要件ごと。空の要件は入らない） */
  readonly kept: readonly KeptUnwritable[];
  /** 落とした申告（曖昧さ・問題ではない） */
  readonly dropped: readonly DroppedClaim[];
  /** 判定の記録（問いの ID・答え・確信度・答えたモデルの版） */
  readonly judgments: readonly TriageJudgment[];
}

/** 仕分けと裏付けが受け取るもの */
export interface UnwritableTriageInput {
  /** ② の設計（新しい欄 `unwritableClaims`・`notes` を持つ） */
  readonly design: DesignOutput;
  /** 段に渡した文書（制約 ID の節の抜粋を取り出すのに使う） */
  readonly documents: readonly PromptDocument[];
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /** 確信度の閾値（`limits.ts` の 1 か所から取る） */
  readonly threshold: number;
  /**
   * 語彙の穴で「反する」と判定されたとき、その要件だけ設計をやり直す（1 回まで）。本番は ② の段を
   * 要件 1 つで呼び直す。省くとやり直さず、印つきで残す。
   */
  readonly redoDesign?: (requirementId: string) => Promise<RequirementDesignEntry | undefined>;
}

/** 作業中の要件（申告を仕分け・裏付けしながら作る） */
interface WorkingEntry {
  requirementId: string;
  entry: RequirementDesignEntry;
  /** 最初に申告があったか（空の要件は触らない） */
  readonly hadClaims: boolean;
  notes: string[];
  keptClaims: UnwritableClaim[];
  marked: boolean;
  redone: boolean;
}

function choiceOf(answer: JudgeAnswer | undefined): string | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.choice : undefined;
}

function confidenceOf(answer: JudgeAnswer | undefined): number | undefined {
  return answer !== undefined && answer.kind === "choice" ? answer.confidence : undefined;
}

/**
 * 設計の `unwritable` を仕分けて裏を取る（§3）。判定は差し込まれた `Judge` だけを使う（実 API は呼ばない）。
 * 申告が 1 件も無ければ、判定を呼ばずにそのまま返す。
 */
export async function runUnwritableTriage(input: UnwritableTriageInput): Promise<UnwritableTriageResult> {
  const judgments: TriageJudgment[] = [];
  const dropped: DroppedClaim[] = [];
  const works: WorkingEntry[] = input.design.designs.map((entry) => ({
    requirementId: entry.requirementId,
    entry,
    hadClaims: entry.unwritableClaims.length > 0,
    notes: [...entry.notes],
    keptClaims: [],
    marked: false,
    redone: false,
  }));

  // ── 1. 仕分け（曖昧さ／語彙の穴／問題ではない）──────────────────────
  const triageQuestions: Record<string, JudgeQuestion> = {};
  const triageTargets: { work: WorkingEntry; claim: UnwritableClaim; index: number }[] = [];
  const triageState: {
    requirementId: string;
    part: string;
    reason: string;
    constraintIds: readonly string[];
  }[] = [];
  for (const work of works) {
    work.entry.unwritableClaims.forEach((claim, index) => {
      const name = triageQuestionName(work.requirementId, index);
      triageQuestions[name] = {
        kind: "choice",
        instructions:
          "次の『書けない』の申告は、どの種類か。本当に書けない（語彙の穴）ものだけが vocabulary-hole である。",
        criteria: {
          ambiguity: "曖昧さ・決めたこと・不確かさのメモ（語彙の穴ではない）",
          "vocabulary-hole": "文書の語彙に無いために書けない（語彙の穴）",
          "not-a-problem": "問題ではない（要件の言い直しなど。実際には書けている）",
        },
      };
      triageState.push({
        requirementId: work.requirementId,
        part: claim.part,
        reason: claim.reason,
        constraintIds: claim.constraintIds,
      });
      triageTargets.push({ work, claim, index });
    });
  }
  if (triageTargets.length === 0) {
    return { design: input.design, kept: [], dropped, judgments };
  }

  const classify = await input.judge.judge({ state: { claims: triageState }, questions: triageQuestions });
  const vocabularyHoles: { work: WorkingEntry; claim: UnwritableClaim; index: number }[] = [];
  for (const target of triageTargets) {
    const name = triageQuestionName(target.work.requirementId, target.index);
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
      // 曖昧さは `notes` へ移し、書けない申告からは外す（記録は残す）
      target.work.notes.push(target.claim.part);
      dropped.push({
        requirementId: target.work.requirementId,
        part: target.claim.part,
        label: "ambiguity",
        reason: target.claim.reason,
      });
    } else if (label === "not-a-problem") {
      dropped.push({
        requirementId: target.work.requirementId,
        part: target.claim.part,
        label: "not-a-problem",
        reason: target.claim.reason,
      });
    } else if (label === "vocabulary-hole") {
      vocabularyHoles.push(target);
    } else {
      // 知らないラベルは、印つきで残す（捨てない）
      target.work.keptClaims.push(target.claim);
      target.work.marked = true;
    }
  }

  // ── 2. 語彙の穴の裏付け（制約 ID の節の抜粋と主張）──────────────────
  if (vocabularyHoles.length > 0) {
    const supportQuestions: Record<string, JudgeQuestion> = {};
    const supportState: {
      requirementId: string;
      part: string;
      reason: string;
      excerpt: string;
    }[] = [];
    for (const target of vocabularyHoles) {
      const name = supportQuestionName(target.work.requirementId, target.index);
      supportQuestions[name] = {
        kind: "choice",
        instructions:
          "抜粋（文書の該当の節）が、申告（書けない部分）を裏付けるか。抜粋に書かれていなければ not-stated。",
        criteria: {
          supports: "抜粋が主張を裏付ける",
          contradicts: "抜粋が主張に反する",
          "not-stated": "抜粋に書いていない",
        },
      };
      supportState.push({
        requirementId: target.work.requirementId,
        part: target.claim.part,
        reason: target.claim.reason,
        excerpt: constraintExcerpt(input.documents, target.claim.constraintIds),
      });
    }
    const support = await input.judge.judge({ state: { claims: supportState }, questions: supportQuestions });
    for (const target of vocabularyHoles) {
      const name = supportQuestionName(target.work.requirementId, target.index);
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
      // 同じ要件の別の申告で既にやり直していれば、その申告はやり直した設計に置き換わっている（触らない）
      if (target.work.redone) continue;
      // 「反する」なら、その要件だけ設計をやり直す（1 回まで）。やり直せたら、やり直した設計を採る
      if (verdict === "contradicts" && !target.work.redone && input.redoDesign !== undefined) {
        const redone = await input.redoDesign(target.work.requirementId);
        if (redone !== undefined) {
          target.work.entry = redone;
          target.work.keptClaims = [...redone.unwritableClaims];
          target.work.notes = [...redone.notes, ...target.work.notes];
          target.work.redone = true;
          continue;
        }
      }
      // 裏付けが取れない（「書いていない」）・確信度が閾値未満・やり直せない場合は、印つきで残す
      target.work.keptClaims.push(target.claim);
      if (verdict !== "supports" || confidence === undefined || confidence < input.threshold) {
        target.work.marked = true;
      }
    }
  }

  // ── 結果を組み立てる ────────────────────────────────────────────
  const designs: RequirementDesignEntry[] = works.map((work) => {
    if (!work.hadClaims && !work.redone) return work.entry;
    return {
      ...work.entry,
      unwritable: work.keptClaims.map((claim) => claim.part),
      unwritableClaims: work.keptClaims,
      notes: work.notes,
    };
  });
  const kept: KeptUnwritable[] = works
    .filter((work) => work.keptClaims.length > 0)
    .map((work) => ({
      requirementId: work.requirementId,
      claims: work.keptClaims,
      marked: work.marked,
      redone: work.redone,
    }));
  return {
    design: { ...(input.design.roles === undefined ? {} : { roles: input.design.roles }), designs },
    kept,
    dropped,
    judgments,
  };
}
