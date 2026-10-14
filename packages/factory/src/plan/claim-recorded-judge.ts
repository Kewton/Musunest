// 記録した**主の応答**を、再点検の口なしで流し直すための記録の口（Issue #459）。
//
// 「再点検なし」の基準の経路は、点検の関数を**再点検の口なしで**呼ぶ。そのときに主へ送る要求は、
// 「再点検あり」で実際に送ったものと**同じ**である。だから、主の応答を**要求の内容のハッシュ**で引いて
// 返す記録の口を作れば、**同じ点検の関数をそのまま**流し直せる。**成功した応答だけでなく、門・予算の
// 停止も保存・再生する**——途中で止まった基準と、最後まで進んだ基準を比較できるようにする（F7）。
//
//   - **記録に無い要求では止まる**（空の配列を成功とも申告無しとも読ませない）。`RecordedJudgeMissError`
//     は `stop` の印を持ち、点検の `safeJudge` が握らずに投げ直す（欠落を「unknown」に化けさせない）。
//   - 記録の口の呼び出しは**実 API の試行にも使用量にも数えない**（ただの `Judge` の実装であって、
//     予算の包みも門も通らない）。
import { sha256Hex } from "@musunest/spec-engine";
import type { Judge, JudgeRequest, JudgeResponse } from "../judge.js";
import {
  JudgeBudgetExceededError,
  JudgeCallLimitExceededError,
  JudgeDeadlineExceededError,
} from "../judge-budget.js";

/**
 * 記録した 1 件（成功した応答か、停止・失敗か）。**問いの ID**も残す——生の答えを、元の run・束の申告
 * に対応づけられるようにする（Issue #459・N5）。
 */
export type RecordedJudgeEntry =
  | {
      readonly kind: "response";
      readonly requestHash: string;
      readonly questionIds: readonly string[];
      readonly response: JudgeResponse;
    }
  | {
      readonly kind: "stop";
      readonly requestHash: string;
      readonly questionIds: readonly string[];
      readonly errorName: string;
      readonly message: string;
    };

/** 要求の内容を、ハッシュの対象に写す（**合図（`signal`）は入れない**——呼ぶ側の都合で変わるため） */
export function callHashMaterial(request: JudgeRequest): unknown {
  return { state: request.state, questions: request.questions };
}

/** 要求の内容のハッシュ（合図を除く。要求の一致を判定に使う） */
export async function createCallHash(request: JudgeRequest): Promise<string> {
  return sha256Hex(JSON.stringify(callHashMaterial(request)));
}

/**
 * 記録に無い要求を流したときに投げる誤り（止める）。**`stop` の印を持つ**——点検の `safeJudge` が握らずに
 * 投げ直す（記録の欠落を「unknown」に化けさせない。F7）。
 */
export class RecordedJudgeMissError extends Error {
  readonly stop = true;
  constructor(readonly requestHash: string) {
    super(`記録に無い要求です（${requestHash}）`);
    this.name = "RecordedJudgeMissError";
  }
}

/** 保存した停止・失敗を、その種類の誤りとして作り直す（点検の `safeJudge` が握らずに投げ直す） */
function reconstructStop(errorName: string, message: string): Error {
  if (errorName === "JudgeCallLimitExceededError") return new JudgeCallLimitExceededError(0);
  if (errorName === "JudgeBudgetExceededError") return new JudgeBudgetExceededError(0, 0);
  if (errorName === "JudgeDeadlineExceededError") return new JudgeDeadlineExceededError();
  const error = new Error(message);
  error.name = errorName;
  return error;
}

/**
 * 記録した応答・停止を、要求の内容のハッシュで引いて返す記録の口。**記録に無い要求では投げる**——空の
 * 配列を成功とも申告無しとも読ませない。**実 API は呼ばない**ので、試行にも使用量にも数えない。
 */
export function createRecordedJudge(entries: readonly RecordedJudgeEntry[]): Judge {
  const byHash = new Map<string, RecordedJudgeEntry>();
  for (const entry of entries) byHash.set(entry.requestHash, entry);
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const hash = await createCallHash(request);
      const entry = byHash.get(hash);
      if (entry === undefined) throw new RecordedJudgeMissError(hash);
      if (entry.kind === "response") return entry.response;
      throw reconstructStop(entry.errorName, entry.message);
    },
  };
}

/** 記録の口の記録先（要求のハッシュと、応答か停止を積む） */
export interface JudgeRecorder {
  readonly entries: RecordedJudgeEntry[];
}

/** 空の記録先を作る */
export function createJudgeRecorder(): JudgeRecorder {
  return { entries: [] };
}

/**
 * 判定の口を包み、**受け取った要求の内容のハッシュと、応答か停止**を記録する（F7）。包んだ口は、要求を
 * そのまま下の口へ渡し、応答をそのまま返す。**下の口が投げたら停止・失敗も記録してから投げ直す**——
 * 途中で止まった基準を、記録の口で再現できるようにする。
 */
export function recordJudge(judge: Judge, recorder: JudgeRecorder): Judge {
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const requestHash = await createCallHash(request);
      const questionIds = Object.keys(request.questions);
      try {
        const response = await judge.judge(request);
        recorder.entries.push({ kind: "response", requestHash, questionIds, response });
        return response;
      } catch (error) {
        recorder.entries.push({
          kind: "stop",
          requestHash,
          questionIds,
          errorName: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
