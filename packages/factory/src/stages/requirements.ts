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
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
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
 * 引用が原文に無い・1 か所に決まらないときの誤りを、`problems` へ足す（Issue #382）。**2 か所以上ある
 * ときは、やり直しの指示で「1 か所に決まる引用にする」と伝える**。
 */
function addUndecidedProblem(source: string, field: string, quote: string, position: SourceRange, problems: Problem[]): void {
  const count = quoteStarts(source, quote).length;
  if (count >= 2) {
    problems.push({
      field: `${field}.position`,
      code: "position-mismatch",
      message: `引用「${quote}」が原文に ${count} か所あり、位置が 1 か所に決まらない。前後を含めて、原文の中で 1 か所に決まる引用にする`,
    });
    return;
  }
  problems.push({
    field: `${field}.position`,
    code: "position-mismatch",
    message: `引用の位置（${position.start}-${position.end}）が、原文の「${quote}」の位置と一致しない`,
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
