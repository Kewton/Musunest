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
  type StageFailure,
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
 * 中身と見なさない記号（Issue #377）。箇条書きの印や句読点である。空白・改行とあわせて「中身の無い
 * 範囲」を作る。
 */
const BLANK_MARKS = new Set([
  "-",
  "*",
  "・",
  "•",
  "‐",
  "–",
  "—",
  "、",
  "。",
  "，",
  "．",
  ",",
  ".",
  ":",
  "：",
  ";",
  "；",
]);

/**
 * 中身の無い範囲かどうかを判定する（Issue #377）。空白・改行と `BLANK_MARKS` の記号だけの範囲は
 * 「中身が無い」と見なす。空の範囲（`start >= end`）も中身が無い。
 */
export function isBlankRange(source: string, range: SourceRange): boolean {
  for (let index = range.start; index < range.end; index += 1) {
    const char = source[index];
    if (char === undefined || !(isSpace(char) || BLANK_MARKS.has(char))) return false;
  }
  return true;
}

/**
 * 範囲の前後の空白を詰める（中身の判定と、落ちとして残す範囲に使う。Issue #377）。
 */
function trimWhitespace(source: string, range: SourceRange): SourceRange {
  let start = range.start;
  let end = range.end;
  while (start < end && isSpace(source[start] ?? "")) start += 1;
  while (end > start && isSpace(source[end - 1] ?? "")) end -= 1;
  return { start, end };
}

/**
 * 原文を文に切り分け、**前後の空白を除いた**文字の範囲を返す（コードが覆いを数えるのに使う）。
 * 区切りは文の終わりの記号と改行である。空の文と、**中身の無い文（空白・改行と記号だけ）は返さない**
 * （Issue #377。原文に記号だけの行があっても、覆いの検査で落ちにしない）。
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
    if (to > from && !isBlankRange(source, { start: from, end: to })) ranges.push({ start: from, end: to });
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
 * 位置と重なる原文の文を、**文の順にすべて**返す（Issue #487）。重なりの定義は P2 の構造上の覆いと
 * 同じ（`文の始まり < 位置の終わり` かつ `位置の始まり < 文の終わり`）にする。どの文とも重ならなければ
 * 空の並びを返す。**純粋な関数**である——P2 の覆いの数え上げと、P6 へ運ぶ対応（要件の範囲 → 文の入力の
 * 並び）の両方が、この 1 つの定義を使う。
 */
export function overlappingSentences(source: string, position: SourceRange): readonly SourceRange[] {
  return splitSourceSentences(source).filter(
    (sentence) => position.start < sentence.end && sentence.start < position.end,
  );
}

/**
 * 引用が原文に現れる回数（**重なる出現も含む**。Issue #382）。空の引用は 0。
 */
function quoteOccurrences(source: string, quote: string): number {
  if (quote === "") return 0;
  let count = 0;
  let index = source.indexOf(quote);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(quote, index + 1);
  }
  return count;
}

/**
 * コードの検査（会話ではなくコードが見つける。§1・§1.2）：引用が原文に実在すること・位置が合うこと・
 * 原文の文がどれかの要件の位置に覆われていること。見つけた落ちを返す。
 *
 * 位置が合わないとき、**引用が原文に 2 か所以上ある**（重なる出現を含む）なら、位置を 1 か所に決められ
 * ないので、やり直しの指示で「前後を含めて、原文の中で 1 か所に決まる引用にする」と伝える（Issue #382）。
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
      const occurrences = quoteOccurrences(source, requirement.quote);
      misses.push({
        kind: "position-mismatch",
        requirementId: requirement.id,
        detail:
          occurrences >= 2
            ? `引用「${requirement.quote}」が原文に ${occurrences} か所あり、位置が 1 か所に決まらない。前後を含めて、原文の中で 1 か所に決まる引用にする`
            : `引用の位置（${start}-${end}）が、原文の「${requirement.quote}」の位置と一致しない`,
      });
    }
  }
  // 枠の文（要件にしない文）の範囲も「覆われている」と数える（Issue #372）
  const positions = [
    ...list.requirements.map((requirement) => requirement.position),
    ...(list.framing ?? []).map((framing) => framing.position),
  ];
  // 覆いの数え上げは `overlappingSentences`（Issue #487）と同じ定義にする——P6 へ運ぶ対応と重なりの
  // 定義がずれないように、1 つの関数で数える（P2 の結果は変えない）。
  const covered = new Set<string>();
  for (const position of positions) {
    for (const sentence of overlappingSentences(source, position)) {
      covered.add(`${sentence.start}-${sentence.end}`);
    }
  }
  for (const sentence of splitSourceSentences(source)) {
    if (!covered.has(`${sentence.start}-${sentence.end}`)) {
      misses.push({
        kind: "uncovered-source",
        range: sentence,
        detail: `原文の「${source.slice(sentence.start, sentence.end)}」がどの要件にも覆われていない`,
      });
    }
  }
  return misses;
}

/**
 * 原文の範囲から、枠の範囲を取り除く（Issue #372）。枠にすべて含まれていれば空の並びを返し、一部だけ
 * 重なれば差し引いた残りを返し、重ならなければそのまま返す。**枠の文に混ざった条件を消さない**。
 */
function removeFraming(range: SourceRange, framing: readonly SourceRange[]): readonly SourceRange[] {
  let pieces: SourceRange[] = [range];
  for (const frame of framing) {
    const next: SourceRange[] = [];
    for (const piece of pieces) {
      if (frame.end <= piece.start || piece.end <= frame.start) {
        next.push(piece);
        continue;
      }
      if (frame.start > piece.start) next.push({ start: piece.start, end: frame.start });
      if (frame.end < piece.end) next.push({ start: frame.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

/** ①' の応答の形を確かめる */
export function checkReverseCheckOutput(output: unknown): ShapeCheck<ReverseCheckAnswer> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", code: "shape", message: "応答は写像（object）であること" }] };
  }
  const raw = output["uncovered"];
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ field: "uncovered", code: "shape", message: "覆われていない部分の並び（array）であること" }],
    };
  }
  const problems: Problem[] = [];
  const uncovered: SourceRange[] = [];
  raw.forEach((item, index) => {
    const field = `uncovered[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, code: "shape", message: "部分は写像（object）であること" });
      return;
    }
    const start = item["start"];
    const end = item["end"];
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (start as number) > (end as number)) {
      problems.push({ field, code: "shape", message: "部分は 0 以上で start <= end の整数であること" });
      return;
    }
    uncovered.push({ start: start as number, end: end as number });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { uncovered } };
}

/** コードの落ちに会話の申告を足した結果（`droppedBlankMisses` は捨てた断片の数。Issue #377） */
interface MergedUncovered {
  readonly misses: readonly ReverseCheckMiss[];
  readonly droppedBlankMisses: number;
}

/**
 * コードが見つけた落ちに、会話が挙げた部分（原文の中にあるもの）を足す。範囲が同じものは重ねない。
 *
 * 会話が挙げた範囲は、**枠の範囲にすべて含まれるときだけ落とす**（Issue #372）。一部だけ重なるときは、
 * 枠の範囲を差し引いた残りを覆われていない範囲として残す（枠の文に混ざった条件を消さない）。重ならない
 * ものはそのまま残す。
 *
 * 差し引いた残りは、**断片ごとに前後の空白を詰め、中身の無い断片（空白・改行と記号だけ。Issue #377）は
 * 捨てる**。中身のある断片は、原文の上の位置のまま落ちとして残す。捨てた断片の数を返す。
 */
function mergeUncovered(
  codeMisses: readonly ReverseCheckMiss[],
  reported: readonly SourceRange[],
  source: string,
  framing: readonly SourceRange[],
): MergedUncovered {
  const misses: ReverseCheckMiss[] = [...codeMisses];
  const seen = new Set(
    codeMisses
      .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
      .map((miss) => `${miss.range.start}-${miss.range.end}`),
  );
  let droppedBlankMisses = 0;
  for (const range of reported) {
    if (range.start < 0 || range.end > source.length || range.start >= range.end) continue;
    for (const piece of removeFraming(range, framing)) {
      const trimmed = trimWhitespace(source, piece);
      if (isBlankRange(source, trimmed)) {
        droppedBlankMisses += 1;
        continue;
      }
      const key = `${trimmed.start}-${trimmed.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      misses.push({
        kind: "uncovered-source",
        range: trimmed,
        detail: `逆照合の会話が挙げた、覆われていない部分「${source.slice(trimmed.start, trimmed.end)}」`,
      });
    }
  }
  return { misses, droppedBlankMisses };
}

/**
 * ①' を 1 回呼ぶ。会話の答えは形だけを確かめ、**落ちはコードが見つけたものを正**として
 * 会話の申告を足す。`quotesValid` は引用の実在と位置の一致の有無である。
 */
export async function runReverseCheck(input: ReverseCheckInput): Promise<StageOutcome<ReverseCheckResult>> {
  const framing = input.list.framing ?? [];
  const framingPositions = framing.map((entry) => entry.position);
  const data: readonly PromptData[] = [
    { name: "原文", text: input.source },
    // 枠の文（要件にしない文）も一覧に含めて渡す（無いときは空の配列。Issue #372）
    { name: "要件の一覧", text: serializeJson({ ...input.list, framing }) },
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
  const merged = mergeUncovered(
    checkRequirementCoverage(input.source, input.list),
    answer.value.uncovered,
    input.source,
    framingPositions,
  );
  const misses = merged.misses;
  const uncovered = misses
    .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
    .map((miss) => miss.range);
  const quotesValid = !misses.some((miss) => miss.kind === "quote-not-found" || miss.kind === "position-mismatch");
  return { ok: true, value: { uncovered, quotesValid, misses, droppedBlankMisses: merged.droppedBlankMisses } };
}

/**
 * 落ちの件数の内訳（Issue #430）。**件数だけ**を持ち、落ちの文言・引用・原文の断片・位置は入れない
 * （`02-failure-modes.md` §1）。`uncovered-source` は、コードが見つけた分（`code`）と会話が挙げた分
 * （`conversation`）に分ける。
 */
export interface ReverseCheckMissCounts {
  readonly quoteNotFound: number;
  readonly positionMismatch: number;
  readonly uncoveredSource: {
    readonly code: number;
    readonly conversation: number;
  };
}

/** 落ちを見つけた側（有限の 2 つ。Issue #488）。 */
export const REVERSE_CHECK_FOUND_BY = [
  /** コードが見つけた落ち（引用の実在・位置・覆い） */
  "code",
  /** 逆照合の会話が挙げた落ち（覆われていない部分） */
  "conversation",
] as const;
export type ReverseCheckFoundBy = (typeof REVERSE_CHECK_FOUND_BY)[number];

/**
 * 指摘 1 件の、**番号と有限の分類だけ**の記録（Issue #488）。種類・見つけた側・重なる原文の文の番号・
 * 関わる候補要件の通し番号を持つ。**引用・原文の断片・文字の位置・要件の ID は入れない**（番号は各往復の
 * 一覧に限って有効である。`02-failure-modes.md` §1・#445）。
 */
export interface ReverseCheckMissEntry {
  /** 落ちの種類（`quote-not-found`・`position-mismatch`・`uncovered-source`） */
  readonly kind: ReverseCheckMiss["kind"];
  /** 見つけた側（コード／会話） */
  readonly foundBy: ReverseCheckFoundBy;
  /** 重なる原文の文の番号（原文を `splitSourceSentences` で切った順、1 始まり。無ければ空） */
  readonly sentences: readonly number[];
  /** 関わる候補要件の通し番号（その往復の一覧の順、1 始まり。無ければ空） */
  readonly requirements: readonly number[];
}

/**
 * 原文の文 1 つの覆い（Issue #488）。文番号（1 始まり）と、**引用（位置）が重なる候補要件の通し番号**の
 * 並び、枠と重なるかを持つ。値・ID は入れない。
 */
export interface ReverseCheckSentenceCoverage {
  /** 原文を `splitSourceSentences` で切った順の文番号（1 始まり） */
  readonly sentence: number;
  /** 引用（位置）が重なる候補要件の通し番号（その往復の一覧の順、1 始まり） */
  readonly requirements: readonly number[];
  /** 枠の範囲と重なるか */
  readonly framing: boolean;
}

/** 1 往復の逆照合の診断（Issue #430・#488）。落ちの件数の内訳・捨てた断片の数と、番号による対応。 */
export interface ReverseCheckRoundDiagnosis {
  readonly misses: ReverseCheckMissCounts;
  readonly droppedBlankMisses: number;
  /** 原文の文の数 */
  readonly sentenceCount: number;
  /** その往復の一覧の候補要件の数 */
  readonly requirementCount: number;
  /** 文ごとの覆い（文番号の順） */
  readonly sentences: readonly ReverseCheckSentenceCoverage[];
  /** 指摘 1 件ごとの、番号と分類だけの記録（値は入れない） */
  readonly missEntries: readonly ReverseCheckMissEntry[];
}

/** 逆照合の往復ごとの診断（Issue #430）。往復の一覧・やり直したか・やり直し後に残った落ちの内訳。 */
export interface ReverseCheckDiagnosis {
  /** 往復ごとの内訳（初回、やり直しがあればそのあと。止まったときは、止まるまでに終えた往復の分） */
  readonly rounds: readonly ReverseCheckRoundDiagnosis[];
  /** ① をやり直したか */
  readonly redone: boolean;
  /** やり直しても残った落ち（`unmet`）の件数の内訳 */
  readonly unmet: ReverseCheckMissCounts;
}

/** 0 件の落ちの内訳 */
export function emptyReverseCheckMissCounts(): ReverseCheckMissCounts {
  return { quoteNotFound: 0, positionMismatch: 0, uncoveredSource: { code: 0, conversation: 0 } };
}

/** 往復の無い診断（止まる前の初期値） */
export function emptyReverseCheckDiagnosis(): ReverseCheckDiagnosis {
  return { rounds: [], redone: false, unmet: emptyReverseCheckMissCounts() };
}

/**
 * 落ちの件数を、種類ごと（`quote-not-found`・`position-mismatch`・`uncovered-source`）と、
 * `uncovered-source` の出どころごと（コードが見つけた分・会話が挙げた分）に数える（Issue #430）。
 *
 * 出どころは、コードの落ち（`checkRequirementCoverage`）を**その往復の中で数え直して**求める
 * （落ちの型は変えず、pipeline の型に欄を足さない）。`misses` はコードの落ちと会話の申告を合わせた
 * 一覧である。**件数だけ**を数え、文言・引用・位置は入れない。
 */
export function countReverseCheckMisses(
  source: string,
  list: RequirementList,
  misses: readonly ReverseCheckMiss[],
): ReverseCheckMissCounts {
  let quoteNotFound = 0;
  let positionMismatch = 0;
  let uncovered = 0;
  for (const miss of misses) {
    if (miss.kind === "quote-not-found") quoteNotFound += 1;
    else if (miss.kind === "position-mismatch") positionMismatch += 1;
    else uncovered += 1;
  }
  const codeUncovered = checkRequirementCoverage(source, list).filter(
    (miss) => miss.kind === "uncovered-source",
  ).length;
  return {
    quoteNotFound,
    positionMismatch,
    uncoveredSource: { code: codeUncovered, conversation: uncovered - codeUncovered },
  };
}

/**
 * 1 往復の逆照合の診断を、**番号と有限の分類だけ**で組む（Issue #488）。原文の文の数と一覧の候補要件の
 * 数、文ごとの覆い（文番号・引用が重なる候補要件の通し番号・枠の有無）、指摘 1 件ごとの記録（種類・
 * 見つけた側・重なる文番号・関わる候補要件の通し番号）を返す。**引用・原文の断片・文字の位置・要件の ID
 * は入れない**——番号はこの往復の一覧に限って有効である。
 *
 * 見つけた側は、コードの落ち（`checkRequirementCoverage`）を**その往復の中で数え直して**求める（落ちの型を
 * 変えず、pipeline の型に欄を足さない。`countReverseCheckMisses` と同じ手）。`misses` はコードの落ちと
 * 会話の申告を合わせた一覧である（コードの落ちが先、会話の申告が後）。
 */
export function diagnoseReverseCheckRound(
  source: string,
  list: RequirementList,
  misses: readonly ReverseCheckMiss[],
  droppedBlankMisses: number,
): ReverseCheckRoundDiagnosis {
  const sentences = splitSourceSentences(source);
  const overlaps = (left: SourceRange, right: SourceRange): boolean =>
    left.start < right.end && right.start < left.end;
  const sentenceNumbersOf = (range: SourceRange): readonly number[] =>
    sentences.flatMap((sentence, index) => (overlaps(sentence, range) ? [index + 1] : []));
  const requirementNumbersOf = (range: SourceRange): readonly number[] =>
    list.requirements.flatMap((requirement, index) =>
      overlaps(requirement.position, range) ? [index + 1] : [],
    );
  const coverage: readonly ReverseCheckSentenceCoverage[] = sentences.map((sentence, index) => ({
    sentence: index + 1,
    requirements: requirementNumbersOf(sentence),
    framing: (list.framing ?? []).some((frame) => overlaps(frame.position, sentence)),
  }));
  const codeUncoveredCount = checkRequirementCoverage(source, list).filter(
    (miss) => miss.kind === "uncovered-source",
  ).length;
  let uncoveredSeen = 0;
  const entries: ReverseCheckMissEntry[] = [];
  for (const miss of misses) {
    if (miss.kind === "uncovered-source") {
      uncoveredSeen += 1;
      entries.push({
        kind: miss.kind,
        foundBy: uncoveredSeen <= codeUncoveredCount ? "code" : "conversation",
        sentences: sentenceNumbersOf(miss.range),
        requirements: requirementNumbersOf(miss.range),
      });
      continue;
    }
    const ordinal = list.requirements.findIndex((requirement) => requirement.id === miss.requirementId) + 1;
    const requirement = list.requirements.find((candidate) => candidate.id === miss.requirementId);
    entries.push({
      kind: miss.kind,
      foundBy: "code",
      // 引用が原文に無ければ、重なる文は無い（位置は当てにしない）。位置の食い違いは、その要件の位置の文
      sentences:
        miss.kind === "quote-not-found" || requirement === undefined
          ? []
          : sentenceNumbersOf(requirement.position),
      requirements: ordinal > 0 ? [ordinal] : [],
    });
  }
  return {
    misses: countReverseCheckMisses(source, list, misses),
    droppedBlankMisses,
    sentenceCount: sentences.length,
    requirementCount: list.requirements.length,
    sentences: coverage,
    missEntries: entries,
  };
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
  /** 往復ごとの落ちの内訳（種類ごと・出どころごと。Issue #430） */
  readonly diagnosis: ReverseCheckDiagnosis;
}

/**
 * ① → ①' を回し、落ちがあれば ① を**1 回だけ**やり直す（§1）。
 * やり直しても残った落ちは未達として返す（合否はここでは決めない）。
 */
export async function runReverseCheckLoop(input: ReverseCheckLoopInput): Promise<StageOutcome<ReverseCheckLoopResult>> {
  const outcome = await runReverseCheckLoopWithOperation(input);
  if (!outcome.ok) return { ok: false, failure: outcome.failure };
  return { ok: true, value: outcome.value };
}

/** P1/P2 のどの呼び出しで止まったか（有限の値。Issue #397） */
export const REVERSE_CHECK_OPERATIONS = [
  /** 要件にする（① の 1 回目） */
  "requirements",
  /** 逆照合（①' の 1 回目） */
  "reverse-check",
  /** 要件にするのやり直し（① の 2 回目） */
  "requirements-redo",
  /** 逆照合のやり直し（①' の 2 回目） */
  "reverse-check-redo",
] as const;
export type ReverseCheckOperation = (typeof REVERSE_CHECK_OPERATIONS)[number];

/**
 * ① → ①' の停止（**どの呼び出しで止まったか**を付ける。Issue #397）。P1/P2 は 1 つの段の記録に
 * まとまっているので、失敗に `operation`（有限の値）を付けて、記録と診断で区別できるようにする。
 * 呼ぶ回数・やり直す条件・止まる結果は `runReverseCheckLoop` と同じである。
 */
export type ReverseCheckLoopOutcome =
  | { readonly ok: true; readonly value: ReverseCheckLoopResult }
  | {
      readonly ok: false;
      readonly failure: StageFailure;
      readonly operation: ReverseCheckOperation;
      /** 止まるまでに終えた往復の分の内訳（Issue #430） */
      readonly diagnosis: ReverseCheckDiagnosis;
    };

/**
 * ① → ①' を回し、落ちがあれば ① を**1 回だけ**やり直す（§1）。やり直しても残った落ちは未達として
 * 返す（合否はここでは決めない）。**止まったときは、どの呼び出しで止まったかを返す**（Issue #397）。
 * あわせて、往復ごとの落ちの件数の内訳（種類ごと・出どころごと。Issue #430）を返す——止まったときは、
 * 止まるまでに終えた往復の分だけを持つ。
 */
export async function runReverseCheckLoopWithOperation(
  input: ReverseCheckLoopInput,
): Promise<ReverseCheckLoopOutcome> {
  /** 終えた往復の診断（止まったときは、止まるまでに終えた分だけを持つ） */
  const rounds: ReverseCheckRoundDiagnosis[] = [];
  /** ① のやり直しを**終えた**か（やり直しの要求が失敗したときは false のまま。Issue #430） */
  let redoCompleted = false;
  /** 止まったときの結果（終えた往復の分だけを持ち、やり直し後の落ちは無い） */
  const stop = (failure: StageFailure, operation: ReverseCheckOperation): ReverseCheckLoopOutcome => ({
    ok: false,
    failure,
    operation,
    diagnosis: { rounds, redone: redoCompleted, unmet: emptyReverseCheckMissCounts() },
  });
  const first = await runRequirements({
    source: input.source,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!first.ok) return stop(first.failure, "requirements");
  const initial = await runReverseCheck({
    source: input.source,
    list: first.value,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!initial.ok) return stop(initial.failure, "reverse-check");
  rounds.push(
    diagnoseReverseCheckRound(input.source, first.value, initial.value.misses, initial.value.droppedBlankMisses),
  );
  if (initial.value.misses.length === 0) {
    return {
      ok: true,
      value: {
        list: first.value,
        report: initial.value,
        redone: false,
        unmet: [],
        diagnosis: { rounds, redone: false, unmet: emptyReverseCheckMissCounts() },
      },
    };
  }
  const redone = await runRequirements({
    source: input.source,
    documents: input.documents,
    gateway: input.gateway,
    redo: { previous: first.value, misses: initial.value.misses },
  });
  if (!redone.ok) return stop(redone.failure, "requirements-redo");
  // ここから先は、① のやり直しが成功している（2 回目の逆照合で止まっても `redone` を true にする）
  redoCompleted = true;
  const second = await runReverseCheck({
    source: input.source,
    list: redone.value,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!second.ok) return stop(second.failure, "reverse-check-redo");
  rounds.push(
    diagnoseReverseCheckRound(input.source, redone.value, second.value.misses, second.value.droppedBlankMisses),
  );
  return {
    ok: true,
    value: {
      list: redone.value,
      report: second.value,
      redone: true,
      unmet: second.value.misses,
      diagnosis: {
        rounds,
        redone: true,
        unmet: countReverseCheckMisses(input.source, redone.value, second.value.misses),
      },
    },
  };
}
