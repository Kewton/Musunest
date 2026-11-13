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
import { sha256Hex } from "@musunest/spec-engine";
import type { CallGateway } from "../call.js";
import type { Framing, Requirement, RequirementList, ReverseCheckMiss, ReverseCheckResult, SourceRange } from "../pipeline.js";
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
import { decideQuotePosition, runRequirements, runQuoteRepair, type QuoteRepair } from "./requirements.js";

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
  /**
   * この往復がどの直し方の後か（有限の値。Issue #917）。省けば初回（`initial`）。診断の往復の要素に写す。
   */
  readonly fix?: ReverseCheckFix;
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
  return checkRequirementCoverageDetailed(source, list).map((entry) => entry.miss);
}

/**
 * 引用・位置の落ちを、**その落ちを出した候補要件の一覧での位置**（`requirementIndex`）と対にして返す
 * （**値は入れない**。Issue #488）。一覧の候補要件は ID が重複しうる（一意性は仮定しない）ので、通し番号を
 * ID で引かず、**検出時の位置**を控える。覆いの落ち（`uncovered-source`）は特定の候補に属さないので
 * `undefined`。並びは `checkRequirementCoverage` と同じである。
 */
function checkRequirementCoverageDetailed(
  source: string,
  list: RequirementList,
): readonly { readonly miss: ReverseCheckMiss; readonly requirementIndex: number | undefined }[] {
  const detailed: { miss: ReverseCheckMiss; requirementIndex: number | undefined }[] = [];
  list.requirements.forEach((requirement, index) => {
    if (requirement.quote === "" || !source.includes(requirement.quote)) {
      detailed.push({
        miss: {
          kind: "quote-not-found",
          requirementId: requirement.id,
          detail: `引用「${requirement.quote}」が原文に見つからない`,
        },
        requirementIndex: index,
      });
      return;
    }
    const { start, end } = requirement.position;
    const inBounds = start >= 0 && end <= source.length && start <= end;
    if (!inBounds || source.slice(start, end) !== requirement.quote) {
      const occurrences = quoteOccurrences(source, requirement.quote);
      detailed.push({
        miss: {
          kind: "position-mismatch",
          requirementId: requirement.id,
          detail:
            occurrences >= 2
              ? `引用「${requirement.quote}」が原文に ${occurrences} か所あり、位置が 1 か所に決まらない。前後を含めて、原文の中で 1 か所に決まる引用にする`
              : `引用の位置（${start}-${end}）が、原文の「${requirement.quote}」の位置と一致しない`,
        },
        requirementIndex: index,
      });
    }
  });
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
      detailed.push({
        miss: {
          kind: "uncovered-source",
          range: sentence,
          detail: `原文の「${source.slice(sentence.start, sentence.end)}」がどの要件にも覆われていない`,
        },
        requirementIndex: undefined,
      });
    }
  }
  return detailed;
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

/**
 * 会話が返した生の範囲 1 つの行き先（**有限の 5 つ**。Issue #919）。
 *
 *   - `remaining` … 枠を差し引いたあとに中身のある断片が残った（一部が残る）
 *   - `framing` … 枠に全部含まれて消えた
 *   - `blank` … 空白・改行と記号だけで捨てた
 *   - `duplicate` … すでに落ちとして数えた範囲と同じで消えた
 *   - `outside` … 原文の外か空の範囲
 */
export const REVERSE_CHECK_RANGE_DESTINATIONS = [
  "remaining",
  "framing",
  "blank",
  "duplicate",
  "outside",
] as const;
export type ReverseCheckRangeDestination = (typeof REVERSE_CHECK_RANGE_DESTINATIONS)[number];

/**
 * 会話が返した生の範囲 1 つ（Issue #919）。**生の範囲**（会話が返した値）と、有限の行き先、残った断片の
 * 範囲（複数可）を持つ。範囲を切り出した文字列は持たない。並びは会話の応答の順である。
 */
export interface ReverseCheckTraceReportedRange {
  readonly range: SourceRange;
  readonly destination: ReverseCheckRangeDestination;
  /** 落ちとして残った断片の範囲（原文の上の位置。`remaining` 以外は空） */
  readonly fragments: readonly SourceRange[];
}

/**
 * コードが見つけた落ち 1 件（Issue #919）。種類・候補の添字（1 始まり。覆いの落ちは `null`）・範囲
 * （覆いの落ちだけ。それ以外は `null`）。**落ちの説明の文は持たない**。
 */
export interface ReverseCheckTraceCodeMiss {
  readonly kind: ReverseCheckMiss["kind"];
  readonly requirement: number | null;
  readonly range: SourceRange | null;
}

/** P2 に渡した要件の一覧の全体（Issue #919）。候補の本文・引用と枠の引用は「生成役が出した値」である */
export interface ReverseCheckTraceList {
  readonly requirements: readonly Requirement[];
  readonly framing: readonly Framing[];
  readonly decisions: readonly string[];
  readonly unresolved: readonly string[];
}

/**
 * 1 往復の逆照合の診断（Issue #919）。その往復を照らした一覧の全体と、「要件の一覧」のデータの文の
 * SHA-256、会話が返した生の範囲（応答の順）、コードが見つけた落ち。
 */
export interface ReverseCheckTraceRound {
  readonly fix: ReverseCheckFix;
  readonly list: ReverseCheckTraceList;
  readonly listSha256: string;
  readonly reported: readonly ReverseCheckTraceReportedRange[];
  readonly codeMisses: readonly ReverseCheckTraceCodeMiss[];
}

/**
 * 逆照合の往復ごとの診断（Issue #919）。原文は複写せず、SHA-256 と長さだけを持つ。往復の並びは実行の順
 * である。判定・やり直し・持ち越し・P3 以降の入力には使わない（点検の材料である）。
 */
export interface ReverseCheckTrace {
  readonly sourceSha256: string;
  readonly sourceLength: number;
  readonly rounds: readonly ReverseCheckTraceRound[];
}

/** コードの落ちに会話の申告を足した結果（`droppedBlankMisses` は捨てた断片の数。Issue #377） */
interface MergedUncovered {
  readonly misses: readonly ReverseCheckMiss[];
  readonly droppedBlankMisses: number;
  /**
   * 会話が挙げた断片ごとの、**元の範囲が枠と重なっていたか**（差し引く前に求める。Issue #488）。`misses` の
   * 会話分（`uncovered-source` の会話の行）と同じ並びである。**真偽値だけ**で、元の範囲は持たない。
   */
  readonly conversationFramingOverlaps: readonly boolean[];
  /** 会話が返した生の範囲ごとの行き先と残った断片（応答の順。Issue #919） */
  readonly reported: readonly ReverseCheckTraceReportedRange[];
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
  // 会話が挙げた断片ごとの、**元の範囲が枠と重なっていたか**（差し引く前に求める。Issue #488）。
  // `misses` の会話分と同じ並びである。
  const conversationFramingOverlaps: boolean[] = [];
  const seen = new Set(
    codeMisses
      .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
      .map((miss) => `${miss.range.start}-${miss.range.end}`),
  );
  let droppedBlankMisses = 0;
  const reportedTraces: ReverseCheckTraceReportedRange[] = [];
  for (const range of reported) {
    if (range.start < 0 || range.end > source.length || range.start >= range.end) {
      reportedTraces.push({ range, destination: "outside", fragments: [] });
      continue;
    }
    // 差し引く前に、元の範囲が枠と一部でも重なったかを求める（残った断片へ真偽値だけを引き継ぐ）
    const overlappedFraming = framing.some((frame) => frame.start < range.end && range.start < frame.end);
    const pieces = removeFraming(range, framing);
    if (pieces.length === 0) {
      reportedTraces.push({ range, destination: "framing", fragments: [] });
      continue;
    }
    const fragments: SourceRange[] = [];
    let sawDuplicate = false;
    for (const piece of pieces) {
      const trimmed = trimWhitespace(source, piece);
      if (isBlankRange(source, trimmed)) {
        droppedBlankMisses += 1;
        continue;
      }
      const key = `${trimmed.start}-${trimmed.end}`;
      if (seen.has(key)) {
        sawDuplicate = true;
        continue;
      }
      seen.add(key);
      fragments.push(trimmed);
      misses.push({
        kind: "uncovered-source",
        range: trimmed,
        detail: `逆照合の会話が挙げた、覆われていない部分「${source.slice(trimmed.start, trimmed.end)}」`,
      });
      conversationFramingOverlaps.push(overlappedFraming);
    }
    const destination: ReverseCheckRangeDestination =
      fragments.length > 0 ? "remaining" : sawDuplicate ? "duplicate" : "blank";
    reportedTraces.push({ range, destination, fragments });
  }
  return { misses, droppedBlankMisses, conversationFramingOverlaps, reported: reportedTraces };
}

/**
 * ①' を 1 回呼び、その結果と、**往復の診断**を組む（Issue #488）。会話の答えは形だけを確かめ、落ちは
 * コードが見つけたものを正として会話の申告を足す。診断には、会話の断片ごとの「元の範囲が枠と重なったか」
 * （差し引く前に求める）まで写す——`ReverseCheckResult`（pipeline の型）には欄を足さない。
 *
 * `runReverseCheck`（結果だけを返す）と ①' → ① のループ（結果と診断の両方が要る）が共有する。
 */
export async function runReverseCheckWithDiagnosis(
  input: ReverseCheckInput,
): Promise<
  StageOutcome<{
    readonly result: ReverseCheckResult;
    readonly round: ReverseCheckRoundDiagnosis;
    /** この往復の一覧・SHA-256・会話の生の範囲・コードの落ち（Issue #919） */
    readonly trace: ReverseCheckTraceRound;
  }>
> {
  const framing = input.list.framing ?? [];
  const framingPositions = framing.map((entry) => entry.position);
  // 「要件の一覧」のデータの文。要求にそのまま渡し、診断の SHA-256 もこの文から取る（Issue #919）
  const listText = serializeJson({ ...input.list, framing });
  const listSha256 = await sha256Hex(listText);
  const data: readonly PromptData[] = [
    { name: "原文", text: input.source },
    // 枠の文（要件にしない文）も一覧に含めて渡す（無いときは空の配列。Issue #372）
    { name: "要件の一覧", text: listText },
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
  // コードの落ちは 1 回だけ求め、覆いの数え上げと診断の両方に使う（Issue #919）
  const codeMisses = checkRequirementCoverageDetailed(input.source, input.list);
  const merged = mergeUncovered(
    codeMisses.map((entry) => entry.miss),
    answer.value.uncovered,
    input.source,
    framingPositions,
  );
  const misses = merged.misses;
  const uncovered = misses
    .filter((miss): miss is Extract<ReverseCheckMiss, { kind: "uncovered-source" }> => miss.kind === "uncovered-source")
    .map((miss) => miss.range);
  const quotesValid = !misses.some((miss) => miss.kind === "quote-not-found" || miss.kind === "position-mismatch");
  const result: ReverseCheckResult = { uncovered, quotesValid, misses, droppedBlankMisses: merged.droppedBlankMisses };
  const round = diagnoseReverseCheckRound(
    input.source,
    input.list,
    misses,
    merged.droppedBlankMisses,
    merged.conversationFramingOverlaps,
    input.fix,
  );
  const trace: ReverseCheckTraceRound = {
    fix: input.fix ?? "initial",
    list: {
      requirements: input.list.requirements.map((requirement) => ({ ...requirement })),
      framing: framing.map((entry) => ({ ...entry })),
      decisions: [...input.list.decisions],
      unresolved: [...input.list.unresolved],
    },
    listSha256,
    reported: merged.reported.map((entry) => ({
      range: { start: entry.range.start, end: entry.range.end },
      destination: entry.destination,
      fragments: entry.fragments.map((fragment) => ({ start: fragment.start, end: fragment.end })),
    })),
    // コードが見つけた落ちだけを写す（会話の申告は reported に残る）。説明の文は持たない
    codeMisses: codeMisses.map((entry) => ({
      kind: entry.miss.kind,
      requirement: entry.requirementIndex === undefined ? null : entry.requirementIndex + 1,
      range:
        entry.miss.kind === "uncovered-source"
          ? { start: entry.miss.range.start, end: entry.miss.range.end }
          : null,
    })),
  };
  return { ok: true, value: { result, round, trace } };
}

/**
 * ①' を 1 回呼ぶ。会話の答えは形だけを確かめ、**落ちはコードが見つけたものを正**として
 * 会話の申告を足す。`quotesValid` は引用の実在と位置の一致の有無である。
 */
export async function runReverseCheck(input: ReverseCheckInput): Promise<StageOutcome<ReverseCheckResult>> {
  const outcome = await runReverseCheckWithDiagnosis(input);
  return outcome.ok ? { ok: true, value: outcome.value.result } : outcome;
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
  /**
   * 会話が挙げた断片で、**元の範囲が枠と重なっていたか**（差し引く前に求める。Issue #488）。コードの落ちは
   * `false`。**真偽値だけ**で、元の範囲・位置は持たない。
   */
  readonly framingOverlap: boolean;
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
  /**
   * この往復を照らした一覧を、どの直し方で作ったか（有限の値。Issue #917）。初回は `initial`。
   * 値（引用・原文の断片・位置・要件 ID）は入れない。
   */
  readonly fix: ReverseCheckFix;
}

/**
 * 一覧を直した方法（**有限の 3 つ**。Issue #917）。**診断の直下には欄を足さず**、往復の要素に載せる。
 */
export const REVERSE_CHECK_FIXES = [
  /** 直していない（P1 の初回の一覧） */
  "initial",
  /** 一覧の全体を作り直した（従来のやり直し） */
  "whole-redo",
  /** 落ちを指された候補の引用と位置だけを直した（Issue #917） */
  "quote-repair",
] as const;
export type ReverseCheckFix = (typeof REVERSE_CHECK_FIXES)[number];

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
 * 見つけた側・重なる文番号・関わる候補要件の通し番号・枠をまたいだか）を返す。**引用・原文の断片・文字の
 * 位置・要件の ID は入れない**——番号はこの往復の一覧に限って有効である。
 *
 * 見つけた側と候補要件の通し番号は、コードの落ち（`checkRequirementCoverageDetailed`）を**その往復の中で
 * 数え直して**求める（落ちの型を変えず、pipeline の型に欄を足さない）。候補要件の ID は重複しうるので、
 * 通し番号は ID ではなく**検出時の位置**から取る。`misses` はコードの落ちと会話の申告を合わせた一覧である
 * （コードの落ちが先、会話の申告が後）。`conversationFramingOverlaps` は会話の断片ごとの、元の範囲が枠と
 * 重なっていたかである（`misses` の会話分と同じ並び。渡さなければ空として扱う）。
 */
export function diagnoseReverseCheckRound(
  source: string,
  list: RequirementList,
  misses: readonly ReverseCheckMiss[],
  droppedBlankMisses: number,
  conversationFramingOverlaps: readonly boolean[] = [],
  fix: ReverseCheckFix = "initial",
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
  // コードの落ちを、その落ちを出した候補の位置つきで数え直す（ID の重複に依存しない。Issue #488）
  const codeMisses = checkRequirementCoverageDetailed(source, list);
  const codeCount = codeMisses.length;
  const codeUncoveredCount = codeMisses.filter((entry) => entry.miss.kind === "uncovered-source").length;
  let uncoveredSeen = 0;
  const entries: ReverseCheckMissEntry[] = [];
  misses.forEach((miss, index) => {
    if (miss.kind === "uncovered-source") {
      uncoveredSeen += 1;
      const foundBy = uncoveredSeen <= codeUncoveredCount ? "code" : "conversation";
      // 会話の断片は、元の範囲が枠と重なっていたかを引き継ぐ（コードの落ちは false）
      const conversationIndex = uncoveredSeen - codeUncoveredCount - 1;
      const framingOverlap =
        foundBy === "conversation" ? conversationFramingOverlaps[conversationIndex] ?? false : false;
      entries.push({
        kind: miss.kind,
        foundBy,
        sentences: sentenceNumbersOf(miss.range),
        requirements: requirementNumbersOf(miss.range),
        framingOverlap,
      });
      return;
    }
    // 引用・位置の落ちは、検出時の候補の位置（`index < codeCount` の対応）から通し番号を取る
    const detail = index < codeCount ? codeMisses[index] : undefined;
    const requirementIndex = detail?.requirementIndex;
    const requirement = requirementIndex === undefined ? undefined : list.requirements[requirementIndex];
    entries.push({
      kind: miss.kind,
      foundBy: "code",
      // 引用が原文に無ければ、重なる文は無い（位置は当てにしない）。位置の食い違いは、その要件の位置の文
      sentences:
        miss.kind === "quote-not-found" || requirement === undefined
          ? []
          : sentenceNumbersOf(requirement.position),
      requirements: requirementIndex === undefined ? [] : [requirementIndex + 1],
      framingOverlap: false,
    });
  });
  return {
    misses: countReverseCheckMisses(source, list, misses),
    droppedBlankMisses,
    sentenceCount: sentences.length,
    requirementCount: list.requirements.length,
    sentences: coverage,
    missEntries: entries,
    fix,
  };
}

/** ①' と ① のやり直しをまとめた入力 */
export interface ReverseCheckLoopInput {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /**
   * 落ちが来歴だけのときに**引用の修復**を使うか（Issue #917）。**Plan の経路が明示の選択で有効にする**。
   * 省けば（Plan を経ない Build の経路）今までどおり全体の作り直しを使う——呼び出しの列・要求のバイト列・
   * 結果を変えない。
   */
  readonly quoteRepair?: boolean;
}

/** ①' と ① のやり直しの結果 */
export interface ReverseCheckLoopResult {
  /** やり直した後の一覧 */
  readonly list: RequirementList;
  /** やり直した後の逆照合の結果 */
  readonly report: ReverseCheckResult;
  /** ① をやり直したか（**一覧の全体を作り直した**か。Issue #917 で意味を変えない） */
  readonly redone: boolean;
  /** 引用の修復を当てたか（Issue #917。全体の作り直しとは別に数える） */
  readonly repaired: boolean;
  /** やり直しても残った落ち（未達。無ければ空） */
  readonly unmet: readonly ReverseCheckMiss[];
  /** 往復ごとの落ちの内訳（種類ごと・出どころごと。Issue #430） */
  readonly diagnosis: ReverseCheckDiagnosis;
  /**
   * 往復ごとの一覧・SHA-256・会話の生の範囲・コードの落ち（Issue #919）。**任意の欄**——判定・やり直し・
   * 持ち越しには使わず、Plan を経ない Build の経路は読まない。
   */
  readonly trace?: ReverseCheckTrace;
}

/** 引用・位置の落ち（来歴の落ち）の種類か（Issue #917） */
function isProvenanceMiss(miss: ReverseCheckMiss): boolean {
  return miss.kind === "quote-not-found" || miss.kind === "position-mismatch";
}

/** 落ちが**来歴だけ**か（覆いの落ちを 1 件も含まない。Issue #917）。**種類だけで決め**、題材・ID・文で決めない */
export function isProvenanceOnlyMisses(misses: readonly ReverseCheckMiss[]): boolean {
  return misses.length > 0 && misses.every(isProvenanceMiss);
}

/**
 * 引用の修復の答えを、前の一覧へ当てる（Issue #917）。**指された候補だけ**を差し替え、id と本文は変えない。
 * 位置の不一致の修復では、新しい引用が**元の引用を部分文字列として含む**ことを要求し、満たさない修復は
 * 当てずに落ちとして残す（`source.slice` の比較に使う元の引用は、前の一覧の候補のものである）。当てた引用と
 * 位置は、P1 の正規化（`decideQuotePosition`）を通し、決められなければそのまま残す——引用の実在と位置は
 * P2 のコードの検査が落ちとして見つける。
 */
export function applyQuoteRepairs(
  source: string,
  previous: RequirementList,
  repairs: readonly QuoteRepair[],
  targets: readonly number[],
): RequirementList {
  const byIndex = new Map(repairs.map((repair) => [repair.index, repair] as const));
  const wanted = new Set(targets);
  return {
    ...previous,
    requirements: previous.requirements.map((requirement, index) => {
      if (!wanted.has(index)) return requirement;
      const repair = byIndex.get(index);
      if (repair === undefined) return requirement;
      // 位置の不一致の修復では、元の引用を含む引用だけを当てる（前後を足して 1 か所に決める）
      const originalIsMissing = requirement.quote === "" || !source.includes(requirement.quote);
      if (!originalIsMissing && !repair.quote.includes(requirement.quote)) return requirement;
      const decided = decideQuotePosition(source, repair.quote, repair.position);
      return {
        ...requirement,
        quote: repair.quote,
        position: decided ?? repair.position,
      };
    }),
  };
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
  /** 引用の修復（Issue #917。Plan の経路だけ） */
  "quote-repair",
  /** 引用の修復の後の逆照合（Issue #917） */
  "reverse-check-repair",
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
      /** 止まるまでに終えた往復の分の、一覧・SHA-256・会話の生の範囲・コードの落ち（Issue #919） */
      readonly trace?: ReverseCheckTrace;
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
  /** 終えた往復の一覧・SHA-256・会話の生の範囲・コードの落ち（Issue #919） */
  const traces: ReverseCheckTraceRound[] = [];
  // 原文は複写せず、SHA-256 と長さだけを診断に持つ（Issue #919）。呼び出しの列・要求は変えない
  const sourceSha256 = await sha256Hex(input.source);
  const buildTrace = (): ReverseCheckTrace => ({
    sourceSha256,
    sourceLength: input.source.length,
    rounds: traces,
  });
  /** ① のやり直し（**一覧の全体を作り直した**）を**終えた**か（Issue #430） */
  let redoCompleted = false;
  /** 引用の修復を当てたか（Issue #917） */
  let repaired = false;
  /** 止まったときの結果（終えた往復の分だけを持ち、やり直し後の落ちは無い） */
  const stop = (failure: StageFailure, operation: ReverseCheckOperation): ReverseCheckLoopOutcome => ({
    ok: false,
    failure,
    operation,
    diagnosis: { rounds, redone: redoCompleted, unmet: emptyReverseCheckMissCounts() },
    trace: buildTrace(),
  });
  const first = await runRequirements({
    source: input.source,
    documents: input.documents,
    gateway: input.gateway,
  });
  if (!first.ok) return stop(first.failure, "requirements");
  const initial = await runReverseCheckWithDiagnosis({
    source: input.source,
    list: first.value,
    documents: input.documents,
    gateway: input.gateway,
    fix: "initial",
  });
  if (!initial.ok) return stop(initial.failure, "reverse-check");
  // 往復の診断は、①' の実行の中で組んだものを使う（会話の断片の枠の重なりまで持つ。Issue #488）
  rounds.push(initial.value.round);
  traces.push(initial.value.trace);
  if (initial.value.result.misses.length === 0) {
    return {
      ok: true,
      value: {
        list: first.value,
        report: initial.value.result,
        redone: false,
        repaired: false,
        unmet: [],
        diagnosis: { rounds, redone: false, unmet: emptyReverseCheckMissCounts() },
        trace: buildTrace(),
      },
    };
  }

  // ── 経路の表（Issue #917）───────────────────────────────────────────────
  //   初回の落ち          経路
  //   なし                  P1 → P2（ここまでで返る）
  //   覆いを含む            作り直し → P2 →（来歴だけが残れば）修復 → P2
  //   来歴だけ（修復 off）  作り直し → P2（従来のまま。Plan を経ない Build の既定）
  //   来歴だけ（修復 on）   修復 → P2 →（覆いを含めば）作り直し → P2
  // 修復も作り直しも、1 回の流れで最大 1 回。使い切って落ちが残れば、問いの前に確定を止める（呼ぶ側）。
  let current = first.value;
  let currentReport = initial.value.result;
  let repairTried = false;
  const useRepair = input.quoteRepair === true;

  /** 引用の修復を 1 回だけ試す。`"ok"` なら `current` を直した一覧に差し替えた */
  const tryQuoteRepair = async (): Promise<ReverseCheckLoopOutcome | "ok" | "skip"> => {
    if (repairTried) return "skip";
    repairTried = true;
    // 対象は、この一覧のコードの検査（引用・位置）が出した候補の位置（添字）である
    const detailed = checkRequirementCoverageDetailed(input.source, current);
    const targets = detailed.flatMap((entry) =>
      entry.requirementIndex !== undefined && isProvenanceMiss(entry.miss) ? [entry.requirementIndex] : [],
    );
    if (targets.length === 0) return "skip";
    const outcome = await runQuoteRepair({
      source: input.source,
      documents: input.documents,
      gateway: input.gateway,
      previous: current,
      targets,
      misses: detailed.map((entry) => entry.miss).filter(isProvenanceMiss),
    });
    if (!outcome.ok) return stop(outcome.failure, "quote-repair");
    current = applyQuoteRepairs(input.source, current, outcome.value.repairs, targets);
    repaired = true;
    const after = await runReverseCheckWithDiagnosis({
      source: input.source,
      list: current,
      documents: input.documents,
      gateway: input.gateway,
      fix: "quote-repair",
    });
    if (!after.ok) return stop(after.failure, "reverse-check-repair");
    rounds.push(after.value.round);
    traces.push(after.value.trace);
    currentReport = after.value.result;
    return "ok";
  };

  /** 一覧の全体を作り直す（従来のやり直し。1 回だけ） */
  const tryWholeRedo = async (): Promise<ReverseCheckLoopOutcome | "ok" | "skip"> => {
    if (redoCompleted) return "skip";
    const redone = await runRequirements({
      source: input.source,
      documents: input.documents,
      gateway: input.gateway,
      redo: { previous: current, misses: currentReport.misses },
    });
    if (!redone.ok) return stop(redone.failure, "requirements-redo");
    // ここから先は、① のやり直しが成功している（2 回目の逆照合で止まっても `redone` を true にする）
    redoCompleted = true;
    const second = await runReverseCheckWithDiagnosis({
      source: input.source,
      list: redone.value,
      documents: input.documents,
      gateway: input.gateway,
      fix: "whole-redo",
    });
    if (!second.ok) return stop(second.failure, "reverse-check-redo");
    rounds.push(second.value.round);
    traces.push(second.value.trace);
    current = redone.value;
    currentReport = second.value.result;
    return "ok";
  };

  /** 直し方をすべて使い切ったときの終わり（落ちが残っていれば、そのまま未達として返す） */
  const finish = (): ReverseCheckLoopOutcome => ({
    ok: true,
    value: {
      list: current,
      report: currentReport,
      redone: redoCompleted,
      repaired,
      unmet: currentReport.misses,
      diagnosis: {
        rounds,
        redone: redoCompleted,
        unmet: countReverseCheckMisses(input.source, current, currentReport.misses),
      },
      trace: buildTrace(),
    },
  });

  // 修復を先に使う経路（来歴だけの落ち）と、作り直しを先に使う経路（覆いを含む・修復 off）。
  if (useRepair && isProvenanceOnlyMisses(currentReport.misses)) {
    const firstStep = await tryQuoteRepair();
    if (firstStep !== "ok") return firstStep === "skip" ? finish() : firstStep;
    // 修復の後の照らし直しで覆いを含めば、全体の作り直しへ 1 回進む
    if (currentReport.misses.length > 0 && !isProvenanceOnlyMisses(currentReport.misses)) {
      const secondStep = await tryWholeRedo();
      if (secondStep !== "ok") return secondStep === "skip" ? finish() : secondStep;
    }
    return finish();
  }

  const redoStep = await tryWholeRedo();
  if (redoStep !== "ok") return redoStep === "skip" ? finish() : redoStep;
  // 作り直しの後に来歴だけが残れば、修復へ 1 回進む
  if (useRepair && isProvenanceOnlyMisses(currentReport.misses)) {
    const repairStep = await tryQuoteRepair();
    if (repairStep !== "ok") return repairStep === "skip" ? finish() : repairStep;
  }
  return finish();
}
