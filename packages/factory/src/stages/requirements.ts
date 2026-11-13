// ① 要件にする（02-architecture.md §1・F-3・F-6）。
//
// 依頼文（原文）を、**1 行 1 要件**の一覧にする。各要件には、原文からの**引用**と、その**位置**
// （文字の範囲）を付ける。軽い曖昧さはどちらに決めたかを記録し、重大な曖昧さ（決め方で作るものが
// 変わる）は決めずに「未解決」として残す（F-6）。
//
// 入口で、依頼文の長さの上限（共通の上限値。§1.5）を**最初に**確かめる。超えていれば LLM を呼ばない。
// ①' の逆照合で落ちが見つかれば、その落ちをデータに足して**もう一度**この段を呼ぶ（やり直しは 1 回）。
import type { CallGateway } from "../call.js";
import { checkRequestText } from "../limits.js";
import type { Framing, Requirement, RequirementList, ReverseCheckMiss, SourceRange } from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  isRecord,
  ruleTexts,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ① の JSON Schema の名前 */
export const REQUIREMENTS_SCHEMA_NAME = "requirement-list";

/** ① に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const REQUIREMENTS_RULES: readonly string[] = [
  "依頼文（原文）を、1 行 1 要件の一覧にする。",
  "各要件には、原文からそのまま写した引用（quote）と、その位置（position。原文の文字の範囲 start/end）を付ける。",
  "位置（position）は目安でよい。引用（quote）は原文からそのまま写し、原文の中で 1 か所に決まる引用にする。",
  "「〜のアプリを作ってください」のように、アプリを作ってほしいと述べるだけでほかの条件を持たない文は、要件にせず framing に入れる。framing の各件にも、原文からそのまま写した引用（quote）と、その位置（position）を付ける。",
  "その枠の文に、アプリの名前・対象の人・目的などの条件が混ざっているときは、その条件の部分を要件にする（条件は framing に含めない）。",
  "軽い曖昧さは、どちらに決めたかを decisions に記録して書き進める。",
  "重大な曖昧さ（どちらに決めるかで作るものが変わる）は決めずに、unresolved にその問いを残す。",
];

/**
 * ① の JSON Schema（構造化出力）。欄の形の正本はこの schema で、コードの `checkRequirementOutput` が
 * 同じ形を手で確かめる（schema は adapter に渡り、違反はコードが見る。§2.2）。
 */
export const REQUIREMENT_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requirements", "framing", "decisions", "unresolved"],
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "quote", "position"],
        properties: {
          id: { type: "string", description: "要件の識別子（例 R-1）" },
          text: { type: "string", description: "要件の文" },
          quote: { type: "string", description: "原文からそのまま写した引用" },
          position: {
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
    },
    framing: {
      type: "array",
      description: "依頼の枠の文（要件にしない文）の一覧。無ければ空の配列",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "position"],
        properties: {
          quote: { type: "string", description: "原文からそのまま写した引用" },
          position: {
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
    },
    decisions: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
} as const;

/** ① が受け取るもの */
export interface RequirementsInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 信頼する文書（呼ぶ側から渡す） */
  readonly documents: readonly PromptDocument[];
  /** 共通の口 */
  readonly gateway: CallGateway;
  /** ①' の落ちを受けてやり直すときの、前回の一覧と落ち（1 回目のときは無い） */
  readonly redo?: {
    readonly previous: RequirementList;
    readonly misses: readonly ReverseCheckMiss[];
  };
}

function checkPosition(value: unknown, field: string, problems: Problem[]): SourceRange | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "位置は写像（object）であること" });
    return undefined;
  }
  const start = value["start"];
  const end = value["end"];
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (start as number) > (end as number)
  ) {
    problems.push({ field, message: "位置は 0 以上で start <= end の整数であること" });
    return undefined;
  }
  return { start: start as number, end: end as number };
}

/** 引用が原文に現れる開始位置をすべて返す（**重なる出現も含む**。Issue #382）。空の引用は空の並び */
function quoteStarts(source: string, quote: string): readonly number[] {
  if (quote === "") return [];
  const starts: number[] = [];
  let index = source.indexOf(quote);
  while (index !== -1) {
    starts.push(index);
    index = source.indexOf(quote, index + 1);
  }
  return starts;
}

/** LLM の位置（start-end）が、原文のその範囲をちょうど指しているか */
function positionMatches(source: string, quote: string, position: SourceRange): boolean {
  return (
    position.start >= 0 &&
    position.end <= source.length &&
    position.start <= position.end &&
    source.slice(position.start, position.end) === quote
  );
}

/**
 * 引用から決めた位置（Issue #382）。`corrected` は、LLM の位置を引用から求め直したか（そのままで
 * よければ false）。
 */
interface DecidedPosition {
  readonly position: SourceRange;
  readonly corrected: boolean;
}

/**
 * 引用から位置を決める（Issue #382）。**LLM の位置をそのまま使うのは、その範囲の原文が引用と一致する
 * ときだけ**である。一致せず、引用が原文に **1 か所だけ**あれば、その位置にする（直した）。一致せず、
 * 引用が空か **2 か所以上**（重なる出現を含む）のときは、位置を推測せず `undefined` を返す（呼ぶ側が
 * 落ちとして扱う）。
 */
function decidePosition(source: string, quote: string, position: SourceRange): DecidedPosition | undefined {
  if (positionMatches(source, quote, position)) return { position, corrected: false };
  const starts = quoteStarts(source, quote);
  if (starts.length === 1) {
    const start = starts[0] as number;
    return { position: { start, end: start + quote.length }, corrected: true };
  }
  return undefined;
}

/**
 * 引用から位置を決める（Issue #382。P1 の正規化と、引用の修復の当てた後の正規化で共有する）。
 * **LLM の位置をそのまま使うのは、その範囲の原文が引用と一致するときだけ**である。一致せず、引用が原文に
 * **1 か所だけ**あれば、その位置にする（直した）。一致せず、引用が空か **2 か所以上**（重なる出現を含む）の
 * ときは、位置を推測せず `undefined` を返す（呼ぶ側が落ちとして扱う）。
 */
export function decideQuotePosition(
  source: string,
  quote: string,
  position: SourceRange,
): SourceRange | undefined {
  return decidePosition(source, quote, position)?.position;
}

/**
 * 引用が原文に無い・1 か所に決まらないときの誤りを、`problems` へ足す（Issue #382）。**2 か所以上ある
 * ときは、やり直しの指示で「1 か所に決まる引用にする」と伝える**。
 *
 * **Problem の `field` は位置、`message` は分類ごとの固定文**（引用の文字列＝原文の断片を埋めない。
 * 位置は `field`（`<添字>.position`）の添字と固定の欄名で示す。件数・位置の数値は数である。§1・①・
 * Issue #445）。
 */
function addUndecidedProblem(source: string, field: string, quote: string, position: SourceRange, problems: Problem[]): void {
  const count = quoteStarts(source, quote).length;
  if (count >= 2) {
    problems.push({
      field: `${field}.position`,
      code: "position-mismatch",
      message: `引用が原文に ${count} か所あり、位置が 1 か所に決まらない。前後を含めて、原文の中で 1 か所に決まる引用にする`,
    });
    return;
  }
  problems.push({
    field: `${field}.position`,
    code: "position-mismatch",
    message: `引用の位置（${position.start}-${position.end}）が、その引用の位置と一致しない`,
  });
}

function checkRequirement(value: unknown, field: string, problems: Problem[]): Requirement | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "要件は写像（object）であること" });
    return undefined;
  }
  const id = value["id"];
  const text = value["text"];
  const quote = value["quote"];
  let good = true;
  if (typeof id !== "string" || id === "") {
    problems.push({ field: `${field}.id`, message: "要件 ID は空でない文字列であること" });
    good = false;
  }
  if (typeof text !== "string" || text === "") {
    problems.push({ field: `${field}.text`, message: "要件の文は空でない文字列であること" });
    good = false;
  }
  if (typeof quote !== "string") {
    problems.push({ field: `${field}.quote`, message: "引用は文字列であること（原文からそのまま写す）" });
    good = false;
  }
  const position = checkPosition(value["position"], `${field}.position`, problems);
  if (position === undefined) good = false;
  if (!good || position === undefined) return undefined;
  return { id: id as string, text: text as string, quote: quote as string, position };
}

/**
 * 枠の文 1 件の**形**を確かめる（Issue #372）。引用は空でない文字列で、位置は範囲の形であること。
 * 位置と引用の一致は、応答の形を確かめたあとの正規化（Issue #382）で見る。
 */
function checkFraming(value: unknown, field: string, problems: Problem[]): Framing | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "枠の文は写像（object）であること" });
    return undefined;
  }
  const quote = value["quote"];
  let good = true;
  if (typeof quote !== "string" || quote === "") {
    problems.push({ field: `${field}.quote`, message: "引用は空でない文字列であること（原文からそのまま写す）" });
    good = false;
  }
  const position = checkPosition(value["position"], `${field}.position`, problems);
  if (position === undefined) good = false;
  if (!good || position === undefined || typeof quote !== "string") return undefined;
  return { quote, position };
}

/**
 * ① の応答の形を確かめる。合わない欄を**すべて**挙げて返す。`source` を渡すと、形を確かめたあとに
 * **正規化**として、要件と枠の文の 1 件ずつについて**コードが引用から位置を求める**（Issue #382）。
 *
 * 要件は、引用が原文に無い・1 か所に決まらないとき、位置を推測せずそのままにする（①' 逆照合が
 * `quote-not-found`・`position-mismatch` の**落ち**として見つける）。枠の文は ①' が引用を見ないので、
 * ここで**誤り**にする（`framing[i].position`）。
 */
export function checkRequirementOutput(output: unknown, source?: string): ShapeCheck<RequirementList> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", code: "shape", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  const raw = output["requirements"];
  const requirements: Requirement[] = [];
  if (!Array.isArray(raw)) {
    problems.push({ field: "requirements", message: "要件の一覧は並び（array）であること" });
  } else {
    raw.forEach((item, index) => {
      const checked = checkRequirement(item, `requirements[${index}]`, problems);
      if (checked !== undefined) requirements.push(checked);
    });
  }
  const framing: Framing[] = [];
  const rawFraming = output["framing"];
  if (rawFraming === undefined) {
    // 無いときは空の配列として扱う（記録した本物の応答にはこの欄が無い。Issue #372）
  } else if (!Array.isArray(rawFraming)) {
    problems.push({ field: "framing", message: "枠の文の一覧は並び（array）であること" });
  } else {
    rawFraming.forEach((item, index) => {
      const checked = checkFraming(item, `framing[${index}]`, problems);
      if (checked !== undefined) framing.push(checked);
    });
  }
  const decisions = checkStringArray(output["decisions"], "decisions", problems);
  const unresolved = checkStringArray(output["unresolved"], "unresolved", problems);
  if (problems.length > 0) {
    return { ok: false, problems: problems.map((problem) => ({ ...problem, code: problem.code ?? "shape" })) };
  }

  let positionCorrections = 0;
  let normalizedRequirements = requirements;
  let normalizedFraming = framing;
  if (source !== undefined) {
    normalizedRequirements = requirements.map((requirement) => {
      const decided = decidePosition(source, requirement.quote, requirement.position);
      if (decided === undefined) return requirement;
      if (decided.corrected) positionCorrections += 1;
      return { ...requirement, position: decided.position };
    });
    normalizedFraming = [];
    framing.forEach((frame, index) => {
      const decided = decidePosition(source, frame.quote, frame.position);
      if (decided === undefined) {
        addUndecidedProblem(source, `framing[${index}]`, frame.quote, frame.position, problems);
        return;
      }
      if (decided.corrected) positionCorrections += 1;
      normalizedFraming.push({ ...frame, position: decided.position });
    });
  }
  if (problems.length > 0) {
    return { ok: false, problems: problems.map((problem) => ({ ...problem, code: problem.code ?? "shape" })) };
  }
  return {
    ok: true,
    value: {
      requirements: normalizedRequirements,
      framing: normalizedFraming,
      decisions: decisions ?? [],
      unresolved: unresolved ?? [],
      ...(source === undefined ? {} : { positionCorrections }),
    },
  };
}

/** ① のデータ（その段に渡すと決めた文脈だけ） */
function buildData(input: RequirementsInput): readonly PromptData[] {
  const data: PromptData[] = [{ name: "原文", text: input.source }];
  if (input.redo !== undefined) {
    data.push({ name: "前回の要件の一覧", text: serializeJson(input.redo.previous) });
    data.push({ name: "逆照合で見つかった落ち", text: serializeJson(input.redo.misses) });
  }
  return data;
}

// ── 引用の修復（Issue #917）──────────────────────────────────────────────
//
// 逆照合（①'）の落ちが**来歴だけ**（引用の不在・位置の不一致だけ）のとき、一覧の全体を作り直す代わりに、
// 落ちを指された候補の**引用と位置だけ**を出し直させる。**Plan の経路が明示の選択で有効にしたときだけ**
// 使う（既定の Build の経路は今までどおり全体の作り直し）。要件の本文・id・ほかの候補・枠・decisions・
// unresolved は出させず、コードが前の一覧へ当てる——ほかの候補は前の一覧のまま保たれる。

/** 引用の修復の JSON Schema の名前（新しい段は作らず、`requirements` の出力の上限を使う） */
export const REQUIREMENT_QUOTE_REPAIR_SCHEMA_NAME = "requirement-quote-repair";

/**
 * 引用の修復に足す規則（Issue #917）。**指された候補の引用と位置だけ**を返させ、本文を変えさせない。
 * 規則の ID・理由・履歴は PR の本文に書く（方法論 04 §3）。
 */
export const REQUIREMENT_QUOTE_REPAIR_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-rq-01",
    text: "あなたは、要件の一覧のうち、指された候補の引用（quote）と位置（position）だけを直す役である。",
    why: "来歴（引用・位置）の落ちを直すのに、落ちていない要件の本文と引用まで出し直させると、作り直しが意味を壊す（Issue #917）",
    since: "Issue #917",
  },
  {
    id: "R-rq-02",
    text: "要件の本文（text）と識別子（id）は変えない。候補を増やさない・減らさない。指された番号の候補だけを返す。",
    why: "修復の範囲を落ちより広げない。指されていない候補はコードが前の一覧のまま保つ（Issue #917）",
    since: "Issue #917",
  },
  {
    id: "R-rq-03",
    text: "引用（quote）は原文からそのまま写し、原文の中で 1 か所に決まる引用にする（前後を含めて長くする）。位置（position）はその引用の文字の範囲にする。",
    why: "引用の実在と位置は P2 のコードが検査する。1 か所に決まらない引用は位置を取り違えるので、前後を含めさせる（Issue #917）",
    since: "Issue #917",
  },
];

/** 引用の修復の規則（`text` の並び。規則と定義が食い違わないよう定義から組む） */
export const REQUIREMENT_QUOTE_REPAIR_RULES: readonly string[] = ruleTexts(
  REQUIREMENT_QUOTE_REPAIR_RULE_DEFINITIONS,
);

/**
 * 引用の修復の JSON Schema（Issue #917）。**番号ごとの引用と位置だけ**を返させ、要件の本文・id・ほかの
 * 候補・枠・decisions・unresolved を出させない。番号は一覧の位置（0 始まりの添字）である。
 */
export const REQUIREMENT_QUOTE_REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repairs"],
  properties: {
    repairs: {
      type: "array",
      description: "指された候補の番号ごとの、引用と位置",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "quote", "position"],
        properties: {
          index: { type: "integer", minimum: 0, description: "一覧の候補の番号（0 始まりの添字）" },
          quote: { type: "string", description: "原文からそのまま写した引用" },
          position: {
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
    },
  },
} as const;

/**
 * 引用の修復の 1 件（番号・引用・位置。Issue #917）。番号は**一覧の位置（添字）**である——一覧の候補は
 * ID が重複しうるので、ID では当て先が決まらない。
 */
export interface QuoteRepair {
  readonly index: number;
  readonly quote: string;
  readonly position: SourceRange;
}

/** 引用の修復が受け取るもの（原文・文書・前の一覧・対象の番号とその落ちだけ。Issue #917） */
export interface QuoteRepairInput {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  readonly previous: RequirementList;
  /** 修復の対象（一覧の添字。重複しない。呼ぶ側が並べ替えない） */
  readonly targets: readonly number[];
  /** 対象の候補の落ち（対象の番号のものだけ） */
  readonly misses: readonly ReverseCheckMiss[];
}

/**
 * 引用の修復の応答の形を確かめる（Issue #917）。`targets` を渡すと、**対象外の番号を含む・番号が重複する・
 * 対象の番号が欠ける**を形の誤りにする（今の形のやり直し 1 回の口を使う）。問題の `field` は位置、`message`
 * は固定文で、**引用の値は埋めない**。
 */
export function checkQuoteRepairOutput(
  output: unknown,
  targets: readonly number[],
): ShapeCheck<{ readonly repairs: readonly QuoteRepair[] }> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", code: "shape", message: "応答は写像（object）であること" }] };
  }
  const raw = output["repairs"];
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ field: "repairs", code: "shape", message: "修復の並び（array）であること" }],
    };
  }
  const problems: Problem[] = [];
  const repairs: QuoteRepair[] = [];
  const wanted = new Set(targets);
  const seen = new Set<number>();
  raw.forEach((item, index) => {
    const field = `repairs[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, code: "shape", message: "修復は写像（object）であること" });
      return;
    }
    const repairIndex = item["index"];
    const quote = item["quote"];
    if (!Number.isInteger(repairIndex) || !wanted.has(repairIndex as number)) {
      // 値は入れない——対象外の番号そのものは、応答の中の位置（`field` の添字）で示す
      problems.push({ field: `${field}.index`, code: "shape", message: "対象の番号であること" });
      return;
    }
    if (seen.has(repairIndex as number)) {
      problems.push({ field: `${field}.index`, code: "shape", message: "番号が重複している" });
      return;
    }
    seen.add(repairIndex as number);
    if (typeof quote !== "string") {
      problems.push({ field: `${field}.quote`, code: "shape", message: "引用は文字列であること（原文からそのまま写す）" });
      return;
    }
    const position = checkPosition(item["position"], `${field}.position`, problems);
    if (position === undefined) return;
    repairs.push({ index: repairIndex as number, quote, position });
  });
  for (const target of targets) {
    if (!seen.has(target)) {
      problems.push({ field: "repairs", code: "shape", message: "対象の番号が欠けている" });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { repairs } };
}

/** 引用の修復のデータ（原文・前の一覧・対象の番号とその落ちだけ。Issue #917） */
function buildQuoteRepairData(input: QuoteRepairInput): readonly PromptData[] {
  return [
    { name: "原文", text: input.source },
    { name: "前回の要件の一覧", text: serializeJson(input.previous) },
    { name: "直す対象の番号", text: serializeJson(input.targets) },
    { name: "直す対象の落ち", text: serializeJson(input.misses) },
  ];
}

/**
 * 引用の修復を 1 回呼ぶ（Issue #917）。**Plan の経路が明示の選択で有効にしたときだけ**呼ぶ。P1 と同じ出力の
 * 上限（`requirements` の段）を使い、新しい段名を作らない。形が合わない応答は 1 回だけやり直す。
 */
export async function runQuoteRepair(
  input: QuoteRepairInput,
): Promise<StageOutcome<{ readonly repairs: readonly QuoteRepair[] }>> {
  const request = buildStructuredRequest({
    rules: REQUIREMENT_QUOTE_REPAIR_RULES,
    documents: input.documents,
    data: buildQuoteRepairData(input),
    schemaName: REQUIREMENT_QUOTE_REPAIR_SCHEMA_NAME,
    schema: REQUIREMENT_QUOTE_REPAIR_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("requirements"),
  });
  return callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkQuoteRepairOutput(output, input.targets),
  });
}

/**
 * ① を 1 回呼ぶ。入口で依頼文の長さを確かめ、超えていれば呼ばずに `limit` を返す。
 * 形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 */
export async function runRequirements(input: RequirementsInput): Promise<StageOutcome<RequirementList>> {
  const exceeded = checkRequestText(input.source);
  if (exceeded !== undefined) {
    return {
      ok: false,
      failure: { kind: "limit", limit: exceeded.limit, max: exceeded.max, actual: exceeded.actual },
    };
  }
  const request = buildStructuredRequest({
    rules: REQUIREMENTS_RULES,
    documents: input.documents,
    data: buildData(input),
    schemaName: REQUIREMENTS_SCHEMA_NAME,
    schema: REQUIREMENT_LIST_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("requirements"),
  });
  return callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkRequirementOutput(output, input.source),
  });
}
