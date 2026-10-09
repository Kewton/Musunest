// ①' 逆照合（02-architecture.md §1・§1.2）。
//
// 原文と一覧**だけ**を渡した別の会話で、原文のどの部分が一覧のどれにも対応しないかを挙げさせる。
// そのうえで**コードが**次を確かめる（会話の申告だけに頼らない。§1.2）：
//
//   - 引用が原文に実在するか
//   - 引用の位置（文字の範囲）が合うか
//   - 原文の文が、どれかの要件の位置に覆われているか
//
// 落ちがあれば ① をやり直す（1 回まで）。やり直しても残った落ちは**未達**として最後まで持つ。
import type { CallGateway } from "../call.js";
import type { RequirementList, ReverseCheckMiss, ReverseCheckResult, SourceRange } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";
import { runRequirements } from "./requirements.js";

/** ①' の JSON Schema の名前 */
export const REVERSE_CHECK_SCHEMA_NAME = "reverse-check";

/** ①' に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const REVERSE_CHECK_RULES: readonly string[] = [
  "あなたは、作った要件の一覧を、原文に戻って点検する役である。",
  "原文のどの部分が、一覧のどの要件にも対応していないかを挙げる。",
  "要件の一覧だけを渡されるので、原文に書かれていて一覧に無いものを、位置（文字の範囲）で挙げる。",
];

/** ①' の JSON Schema（構造化出力） */
export const REVERSE_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["uncovered"],
  properties: {
    uncovered: {
      type: "array",
      description: "どの要件にも対応しない原文の部分（文字の範囲）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end"],
        properties: {
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;

/** ①' が受け取るもの（原文と一覧だけ） */
export interface ReverseCheckInput {
  readonly source: string;
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** ①' の会話の答え */
interface ReverseCheckAnswer {
  readonly uncovered: readonly SourceRange[];
}

/** 原文を文に切り分けるときの区切り（文の終わりと改行） */
const SENTENCE_BREAKS = new Set(["。", "．", "！", "？", "!", "?"]);

const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";

/**
 * 原文を文に切り分け、**前後の空白を除いた**文字の範囲を返す（コードが覆いを数えるのに使う）。
 * 区切りは文の終わりの記号と改行である。空の文は返さない。
 */
export function splitSourceSentences(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = -1;
  const push = (end: number): void => {
    if (start < 0) return;
    let from = start;
    let to = end;
    while (from < to && isSpace(source[from] ?? "")) from += 1;
    while (to > from && isSpace(source[to - 1] ?? "")) to -= 1;
    if (to > from) ranges.push({ start: from, end: to });
    start = -1;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) continue;
    if (start < 0) {
      if (!isSpace(char)) start = index;
      continue;
    }
    if (SENTENCE_BREAKS.has(char)) {
      push(index + 1);
      continue;
    }
    if (char === "\n") push(index);
  }
  if (start >= 0) push(source.length);
  return ranges;
}

/**
 * コードの検査（会話ではなくコードが見つける。§1・§1.2）：引用が原文に実在すること・位置が合うこと・
 * 原文の文がどれかの要件の位置に覆われていること。見つけた落ちを返す。
 */
export function checkRequirementCoverage(source: string, list: RequirementList): readonly ReverseCheckMiss[] {
  const misses: ReverseCheckMiss[] = [];
  for (const requirement of list.requirements) {
    if (requirement.quote === "" || !source.includes(requirement.quote)) {
      misses.push({
        kind: "quote-not-found",
        requirementId: requirement.id,
        detail: `引用「${requirement.quote}」が原文に見つからない`,
      });
      continue;
    }
    const { start, end } = requirement.position;
    const inBounds = start >= 0 && end <= source.length && start <= end;
    if (!inBounds || source.slice(start, end) !== requirement.quote) {
      misses.push({
        kind: "position-mismatch",
        requirementId: requirement.id,
        detail: `引用の位置（${start}-${end}）が、原文の「${requirement.quote}」の位置と一致しない`,
      });
    }
  }
  const positions = list.requirements.map((requirement) => requirement.position);
  for (const sentence of splitSourceSentences(source)) {
    const covered = positions.some((position) => position.start < sentence.end && sentence.start < position.end);
    if (!covered) {
      misses.push({
        kind: "uncovered-source",
        range: sentence,
        detail: `原文の「${source.slice(sentence.start, sentence.end)}」がどの要件にも覆われていない`,
      });
    }
  }
  return misses;
}

/** ①' の応答の形を確かめる */
export function checkReverseCheckOutput(output: unknown): ShapeCheck<ReverseCheckAnswer> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["uncovered"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "uncovered", message: "覆われていない部分の並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const uncovered: SourceRange[] = [];
  raw.forEach((item, index) => {
    const field = `uncovered[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "部分は写像（object）であること" });
      return;
    }
    const start = item["start"];
    const end = item["end"];
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (start as number) > (end as number)) {
      problems.push({ field, message: "部分は 0 以上で start <= end の整数であること" });
      return;
    }
    uncovered.push({ start: start as number, end: end as number });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { uncovered } };
}

/** コードが見つけた落ちに、会話が挙げた部分（原文の中にあるもの）を足す。範囲が同じものは重ねない */
function mergeUncovered(
  codeMisses: readonly ReverseCheckMiss[],
  reported: readonly SourceRange[],
  source: string,
): readonly ReverseCheckMiss[] {
  const misses: ReverseCheckMiss[] = [...codeMisses];
  const seen = new Set(
    codeMisses
      .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
      .map((miss) => `${miss.range.start}-${miss.range.end}`),
  );
  for (const range of reported) {
    if (range.start < 0 || range.end > source.length || range.start >= range.end) continue;
    const key = `${range.start}-${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    misses.push({
      kind: "uncovered-source",
      range,
      detail: `逆照合の会話が挙げた、覆われていない部分「${source.slice(range.start, range.end)}」`,
    });
  }
  return misses;
}

/**
 * ①' を 1 回呼ぶ。会話の答えは形だけを確かめ、**落ちはコードが見つけたものを正**として
 * 会話の申告を足す。`quotesValid` は引用の実在と位置の一致の有無である。
 */
export async function runReverseCheck(input: ReverseCheckInput): Promise<StageOutcome<ReverseCheckResult>> {
  const data: readonly PromptData[] = [
    { name: "原文", text: input.source },
    { name: "要件の一覧", text: serializeJson(input.list) },
  ];
  const request = buildStructuredRequest({
    rules: REVERSE_CHECK_RULES,
    documents: input.documents,
    data,
    schemaName: REVERSE_CHECK_SCHEMA_NAME,
    schema: REVERSE_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("reverse-check"),
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: checkReverseCheckOutput });
  if (!answer.ok) return answer;
  const misses = mergeUncovered(checkRequirementCoverage(input.source, input.list), answer.value.uncovered, input.source);
  const uncovered = misses
    .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
    .map((miss) => miss.range);
  const quotesValid = !misses.some((miss) => miss.kind === "quote-not-found" || miss.kind === "position-mismatch");
  return { ok: true, value: { uncovered, quotesValid, misses } };
}

/** ①' と ① のやり直しをまとめた入力 */
export interface ReverseCheckLoopInput {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** ①' と ① のやり直しの結果 */
export interface ReverseCheckLoopResult {
  /** やり直した後の一覧 */
  readonly list: RequirementList;
  /** やり直した後の逆照合の結果 */
  readonly report: ReverseCheckResult;
  /** ① をやり直したか */
  readonly redone: boolean;
  /** やり直しても残った落ち（未達。無ければ空） */
  readonly unmet: readonly ReverseCheckMiss[];
}

/**
 * ① → ①' を回し、落ちがあれば ① を**1 回だけ**やり直す（§1）。
 * やり直しても残った落ちは未達として返す（合否はここでは決めない）。
 */
export async function runReverseCheckLoop(input: ReverseCheckLoopInput): Promise<StageOutcome<ReverseCheckLoopResult>> {
  const first = await runRequirements({
    source: input.source,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!first.ok) return first;
  const initial = await runReverseCheck({
    source: input.source,
    list: first.value,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!initial.ok) return initial;
  if (initial.value.misses.length === 0) {
    return { ok: true, value: { list: first.value, report: initial.value, redone: false, unmet: [] } };
  }
  const redone = await runRequirements({
    source: input.source,
    documents: input.documents,
    gateway: input.gateway,
    redo: { previous: first.value, misses: initial.value.misses },
  });
  if (!redone.ok) return redone;
  const second = await runReverseCheck({
    source: input.source,
    list: redone.value,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!second.ok) return second;
  return {
    ok: true,
    value: { list: redone.value, report: second.value, redone: true, unmet: second.value.misses },
  };
}
