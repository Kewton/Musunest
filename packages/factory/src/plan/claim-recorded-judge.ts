// 記録した**主の応答**を、再点検の口なしで流し直すための記録の口（Issue #459）。
//
// 「再点検なし」の基準の経路は、点検の関数を**再点検の口なしで**呼ぶ。そのときに主へ送る要求は、
// 「再点検あり」で実際に送ったものと**同じ**である。だから、主の応答を**要求の内容のハッシュ**で引いて
// 返す記録の口を作れば、**同じ点検の関数をそのまま**流し直せる——途中報告から作るのではなく、記録した
// 応答を返すだけである（05 §3・Issue #459）。
//
//   - **記録に無い要求では止まる**（空の配列を成功とも申告無しとも読ませない）
//   - 記録の口の呼び出しは**実 API の試行にも使用量にも数えない**（ただの `Judge` の実装であって、
//     予算の包みも門も通らない）
import { sha256Hex } from "@musunest/spec-engine";
import type { Judge, JudgeRequest, JudgeResponse } from "../judge.js";

/** 記録した応答 1 件（要求の内容のハッシュ → 応答） */
export interface RecordedJudgeEntry {
  readonly requestHash: string;
  readonly response: JudgeResponse;
}

/** 要求の内容を、ハッシュの対象に写す（**合図（`signal`）は入れない**——呼ぶ側の都合で変わるため） */
export function callHashMaterial(request: JudgeRequest): unknown {
  return { state: request.state, questions: request.questions };
}

/** 要求の内容のハッシュ（合図を除く。要求の一致を判定に使う） */
export async function createCallHash(request: JudgeRequest): Promise<string> {
  return sha256Hex(JSON.stringify(callHashMaterial(request)));
}

/** 記録に無い要求を流したときに投げる誤り（止める） */
export class RecordedJudgeMissError extends Error {
  constructor(readonly requestHash: string) {
    super(`記録に無い要求です（${requestHash}）`);
    this.name = "RecordedJudgeMissError";
  }
}

/**
 * 記録した応答を、要求の内容のハッシュで引いて返す記録の口。**記録に無い要求では投げる**——空の配列を
 * 成功とも申告無しとも読ませない。**実 API は呼ばない**ので、試行にも使用量にも数えない。
 */
export function createRecordedJudge(entries: readonly RecordedJudgeEntry[]): Judge {
  const byHash = new Map<string, JudgeResponse>();
  for (const entry of entries) byHash.set(entry.requestHash, entry.response);
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const hash = await createCallHash(request);
      const response = byHash.get(hash);
      if (response === undefined) throw new RecordedJudgeMissError(hash);
      return response;
    },
  };
}

/** 記録の口の記録先（要求のハッシュと応答を積む） */
export interface JudgeRecorder {
  readonly entries: RecordedJudgeEntry[];
}

/** 空の記録先を作る */
export function createJudgeRecorder(): JudgeRecorder {
  return { entries: [] };
}

/**
 * 判定の口を包み、**受け取った要求の内容のハッシュと応答**を記録する。包んだ口は、要求をそのまま
 * 下の口へ渡し、応答をそのまま返す（挙動を変えない）。
 */
export function recordJudge(judge: Judge, recorder: JudgeRecorder): Judge {
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const response = await judge.judge(request);
      recorder.entries.push({ requestHash: await createCallHash(request), response });
      return response;
    },
  };
}
