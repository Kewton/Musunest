// 欄だけの直し（08-architecture-v1.2.md §3 の決定 1 (c)・§4 のループの行「LLM は名前付きの失敗に対する欄の置き換えだけ、
// マージ・全検査・違反の数はコード」・§9 の手 4 の後半。Issue #553）。
//
// 旗 `v12.search-repair` が on の往復で、一番良い版の失敗が全部場所に写せたとき（`v12/locate.ts`）だけ、v1.1α の B5 の直す手
// （宣言の全文を書き直す道具付きの段）の代わりに呼ぶ。段の ID は `repair` のまま（記録の段の一覧を変えない）。
//
//   - 応答の schema は strict で、**往復ごとにコードが組む**（`fieldRepairSchemaOf`）。`replacements` の場所はこの往復の失敗の
//     場所だけの enum、`element` は置き換える要素の本文の文字列。`disputes` は v1 の直す段と同じ形。試験・要件・名前の表・網羅の
//     単位の欄は持たない
//   - 送り方（共通の封筒の外）：この段の schema の名前（`FIELD_REPAIR_SCHEMA_NAME`）は v1・v1.1α のどちらの封筒にも登録しない。
//     adapter は封筒の一覧に無い名前の要求の schema をそのまま `text.format` に載せる（判定の口と同じ道）ので、場所の enum が
//     モデルに届く。**その代わり、この段の要求の前置き（出力の schema）は他の段と別になり、段をまたぐキャッシュは当たらない**
//   - データは一番良い版の宣言の全文・失敗の一覧（試験 ID・要件 ID・種類・固定文・場所）・固定した試験・要件の一覧だけ。前の版の
//     失敗・会話を積まない（今の直す段が見せる範囲を超えない）
//   - 形の検査（`checkFieldRepairAnswer`）：場所が選択肢の外・同じ場所が 2 回・本文が読めない・要素の種類や名前が場所と違う・
//     余分な欄は固定文で落とし、問題（欄の名前と種類だけ）を返して 1 回だけ直させる（共通の窓口）。続けば `malformed`。主張は
//     v1 の直す段と同じ検査（引用が原文に無い主張は受けない）
//   - マージ（`mergeReplacements`。コード）：一番良い版の原文のうち、その要素の行の範囲だけを返った本文に置き換え、spec-engine の
//     読み取りで読み直し、**置き換えた要素の外の値が一番良い版と深く等しい**ことを確かめてから版にする。読めない・等しくない・
//     大きさの上限を超える、は固定文で断る（走らせる側が採れない版に数える）。マージのあとの静的チェックは走らせる側が省かない
//   - 追加の場所（旗 `v12.ids` の走りだけ。場所の結果が `additions` を持つとき。Issue #667）：場所の enum には追加の場所も入り、
//     データの各場所に種類（replace・add）を足し、規則 R-fr-07 を足す。追加の本文は検査 1 つで、name と entity が場所と同じこと
//     （違えば固定文で 1 回直させる）。マージは本文を validations の節の末尾に挿し込み、外の値が深く等しく、検査の数がちょうど追加の
//     数だけ増え、追加した要素がその位置に在ることを確かめてから版にする。off（`additions` が無い）の要求・形の検査・マージは今のまま
import { readSpecDocument } from "@musunest/spec-engine";
import type { CallGateway } from "../../call.js";
import { checkDeclarationBytes } from "../../limits.js";
import type { Dispute, RejectedDispute, RequirementList } from "../../pipeline.js";
import type { TestSuite } from "../../fixed-test.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "../../stages/prompt.js";
import { REPAIR_ANSWER_SCHEMA, checkRepairAnswer } from "../../stages/repair.js";
import { utf8ByteLength } from "../../stages/write.js";
import { canonicalJson } from "../../v11a/names.js";
import { declarationSpans, type DeclarationSpan, type FailureLocations, type ValidationAddition } from "../locate.js";

/** この段の schema の名前（どの封筒にも登録しない。`text.format.name` にそのまま載る） */
export const FIELD_REPAIR_SCHEMA_NAME = "field-repair";

/** 応答の欄（これ以外の欄は返せない） */
export const FIELD_REPAIR_ANSWER_KEYS = ["replacements", "disputes"] as const;

/** 置き換え 1 つの欄 */
const REPLACEMENT_KEYS = ["location", "element"] as const;

/**
 * この往復の応答の JSON Schema（strict。場所はこの往復の失敗の場所だけの enum）。`locations` は空にしない（呼ぶ側は場所に
 * 写した失敗が 1 つ以上あるときだけ呼ぶ）。
 */
export function fieldRepairSchemaOf(locations: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...FIELD_REPAIR_ANSWER_KEYS],
    properties: {
      replacements: {
        type: "array",
        description: "置き換える要素の並び（1 つの場所に 1 つまで）",
        items: {
          type: "object",
          additionalProperties: false,
          required: [...REPLACEMENT_KEYS],
          properties: {
            location: { type: "string", enum: [...locations], description: "置き換える要素の場所（選択肢から選ぶ）" },
            element: { type: "string", description: "置き換える要素の本文（YAML の原文）" },
          },
        },
      },
      disputes: REPAIR_ANSWER_SCHEMA.properties.disputes,
    },
  };
}

/** この段の規則（`why`・`since` つき。送る文は `text` から組む） */
export const FIELD_REPAIR_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-fr-01",
    text: "あなたは、宣言（app.spec.yaml の原文）のうち、門が名前を付けた失敗の場所の要素だけを置き換える役である。",
    why: "宣言の全文を書き直すと、失敗と関係の無い欄（2 回目で正しかった値）が動く（P1-r3・P10-r1。08 §3 の 1 (c)）",
    since: "Issue #553",
  },
  {
    id: "R-fr-02",
    text: "返せるのは、応答の location の選択肢にある場所の要素だけである。1 つの場所に 1 つまで返す。直さない場所は返さない。",
    why: "場所の選択肢はコードが失敗から閉じたもので、LLM の応答で広げない（方法論 03 §1 の H1・H4）",
    since: "Issue #553",
  },
  {
    id: "R-fr-03",
    text: "element には、その要素の本文を YAML のまま書く。並びの要素（検査・計算・操作・画面）は `-` で始まる行から、entity の項目は項目の名前の行から、その要素の終わりまでを書く。",
    why: "置き換える行の範囲はコードが決め、返った本文をその範囲にだけ当てる（08 §4 のループの行「マージはコード」）",
    since: "Issue #553",
  },
  {
    id: "R-fr-04",
    text: "要素の名前（entity・項目・計算・操作・画面の名前）と所属する entity は変えない。",
    why: "名前は名前の表で固定済みで、場所は名前で決まる。名前を変えると別の要素になる（07 §1.1）",
    since: "Issue #553",
  },
  {
    id: "R-fr-05",
    text: "固定した試験と要件の一覧は変えられない。試験・要件・名前の表・網羅の単位を書き換える欄を返さない。",
    why: "直す段は試験と要件を変えられない（02 §1.3。v1 の直す段と同じ）",
    since: "Issue #553",
  },
  {
    id: "R-fr-06",
    text: "試験の期待が誤りだと考えるときは、試験に合わせて宣言を曲げず、disputes に試験 ID と原文からそのまま写した引用を書く。",
    why: "主張は v1 の直す段と同じく引用つきで受け、裁定（B5'）へ渡す（02 §1.3）",
    since: "Issue #553",
  },
];

/** 旗 `v12.ids` の走りだけ足す規則（追加の場所。Issue #667） */
export const FIELD_REPAIR_IDS_R07_DEFINITION: RuleDefinition = {
  id: "R-fr-07",
  text: "追加の場所には、その entity と名前の検査 1 つの本文を `-` で始まる行から書く。名前と entity は変えない。式は要件と固定した試験から書く。別の要素を書かない。",
  why: "要求する検査が宣言に無い初版は、既存の欄の置換では直せず、場所なしとして全文の直しへ流れて段内の上限で止まった（#650 の原因 2。方法論 03 の H4）",
  since: "Issue #667",
};

/** 旗 `v12.ids` の走りの規則（off の規則の後ろに R-fr-07 を足す。off の規則はそのまま） */
export const FIELD_REPAIR_IDS_RULE_DEFINITIONS: readonly RuleDefinition[] = [...FIELD_REPAIR_RULE_DEFINITIONS, FIELD_REPAIR_IDS_R07_DEFINITION];

/** 場所の種類（旗 `v12.ids` の走りのデータだけ。置換・追加） */
export type FieldLocationKind = "replace" | "add";

/** 検査の要素が持てる欄（追加の場所・旗 ids の走りの検査の置換の場所で照らす） */
const VALIDATION_ELEMENT_KEYS = ["name", "entity", "expression", "message"] as const;

/** データの塊の名前（この順に並べる） */
export const FIELD_REPAIR_DATA_NAMES = ["宣言", "失敗の一覧", "固定した試験", "要件の一覧"] as const;

/** 置き換え 1 つ */
export interface FieldReplacement {
  readonly location: string;
  readonly element: string;
}

/** 応答を確かめた結果（置き換えと、受け付けた／受け付けなかった主張） */
export interface FieldRepairAnswer {
  readonly replacements: readonly FieldReplacement[];
  readonly disputes: readonly Dispute[];
  readonly rejected: readonly RejectedDispute[];
}

/** 形の検査の固定文（値を埋めない） */
export const FIELD_REPAIR_PROBLEMS = {
  notObject: "応答は写像（object）であること",
  extraKey: "直す役はこの欄を返せない（返せるのは replacements と disputes だけ）",
  notArray: "置き換えの並び（array）であること",
  replacementNotObject: "置き換えは写像（object）であること",
  replacementExtraKey: "置き換えはこの欄を持てない（持てるのは location と element だけ）",
  outsideChoices: "場所が選択肢の外である",
  duplicate: "同じ場所が 2 回ある",
  emptyElement: "要素の本文は空でない文字列であること",
  unreadable: "要素の本文が読めない",
  wrongKind: "要素の種類が場所と違う",
  wrongName: "要素の名前か所属する entity が場所と違う",
  notValidation: "検査の場所の本文は検査 1 つであること（持てる欄は name・entity・expression・message だけ）",
} as const;

/** 本文の前後の空行を除き、共通の字下げを外した行（空なら空の並び） */
export function dedentElement(element: string): readonly string[] {
  const lines = element.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(common)));
}

/** 本文を照らす場所の要素（種類・名前・所属 entity） */
type ElementTarget = Pick<DeclarationSpan, "kind" | "entity" | "name">;

/**
 * 本文 1 つを単独で読み、場所の要素（種類・名前・所属 entity）と合うかを確かめる（合わなければ固定文）。`validationOnly` が真
 * （旗 ids の走りの検査の場所）なら、並びの要素が検査の欄だけを持つことも照らす
 */
function elementProblem(element: string, span: ElementTarget, validationOnly = false): string | null {
  const lines = dedentElement(element);
  if (lines.length === 0) return FIELD_REPAIR_PROBLEMS.emptyElement;
  const isItem = /^-(\s|$)/.test(lines[0] ?? "");
  if ((span.kind === "field") === isItem) return FIELD_REPAIR_PROBLEMS.wrongKind;
  const read = readSpecDocument(["element:", ...lines.map((line) => (line === "" ? "" : `  ${line}`))].join("\n"));
  if (!read.ok || !isRecord(read.document)) return FIELD_REPAIR_PROBLEMS.unreadable;
  const value = read.document["element"];
  if (span.kind === "field") {
    if (!isRecord(value)) return FIELD_REPAIR_PROBLEMS.unreadable;
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === span.name ? null : FIELD_REPAIR_PROBLEMS.wrongName;
  }
  if (!Array.isArray(value) || value.length !== 1) return FIELD_REPAIR_PROBLEMS.wrongKind;
  const item: unknown = value[0];
  if (!isRecord(item)) return FIELD_REPAIR_PROBLEMS.wrongKind;
  if (validationOnly && Object.keys(item).some((key) => !(VALIDATION_ELEMENT_KEYS as readonly string[]).includes(key))) {
    return FIELD_REPAIR_PROBLEMS.notValidation;
  }
  const entity = typeof item["entity"] === "string" ? item["entity"] : null;
  return item["name"] === span.name && entity === span.entity ? null : FIELD_REPAIR_PROBLEMS.wrongName;
}

/** 形の検査に渡す文脈 */
export interface FieldRepairCheckContext {
  /** この往復の場所の選択肢 */
  readonly locations: readonly string[];
  /** 一番良い版の要素の範囲（場所の名前 → 範囲） */
  readonly spans: readonly DeclarationSpan[];
  /** 原文（主張の引用を照らす） */
  readonly source: string;
  /** 固定した試験の ID（主張できる試験） */
  readonly testIds: ReadonlySet<string>;
  /** 追加の場所（旗 `v12.ids` の走りだけ。渡せば検査の場所の本文が検査 1 つであることも照らす。Issue #667） */
  readonly additions?: readonly ValidationAddition[];
}

/**
 * 応答の形を確かめる（純粋）。余分な欄・場所が選択肢の外・同じ場所が 2 回・本文が空か読めない・要素の種類や名前が場所と違う、は
 * 欄の名前と固定文だけの問題にする。主張は v1 の直す段と同じ検査（`checkRepairAnswer`）に掛ける。
 */
export function checkFieldRepairAnswer(value: unknown, context: FieldRepairCheckContext): ShapeCheck<FieldRepairAnswer> {
  if (!isRecord(value)) return { ok: false, problems: [{ field: "", message: FIELD_REPAIR_PROBLEMS.notObject }] };
  const problems: Problem[] = [];
  for (const key of Object.keys(value)) {
    if (!(FIELD_REPAIR_ANSWER_KEYS as readonly string[]).includes(key)) problems.push({ field: key, message: FIELD_REPAIR_PROBLEMS.extraKey });
  }
  const replacements: FieldReplacement[] = [];
  const raw = value["replacements"];
  if (!Array.isArray(raw)) {
    problems.push({ field: "replacements", message: FIELD_REPAIR_PROBLEMS.notArray });
  } else {
    const seen = new Set<string>();
    raw.forEach((item: unknown, index) => {
      const field = `replacements[${String(index)}]`;
      if (!isRecord(item)) {
        problems.push({ field, message: FIELD_REPAIR_PROBLEMS.replacementNotObject });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!(REPLACEMENT_KEYS as readonly string[]).includes(key)) problems.push({ field: `${field}.${key}`, message: FIELD_REPAIR_PROBLEMS.replacementExtraKey });
      }
      const location = item["location"];
      const addition = context.additions?.find((candidate) => candidate.key === location);
      const span: ElementTarget | undefined = typeof location === "string" && context.locations.includes(location)
        ? addition === undefined
          ? context.spans.find((candidate) => candidate.key === location)
          : { kind: "validation", entity: addition.entity, name: addition.name }
        : undefined;
      if (typeof location !== "string" || span === undefined) {
        problems.push({ field: `${field}.location`, message: FIELD_REPAIR_PROBLEMS.outsideChoices });
        return;
      }
      if (seen.has(location)) {
        problems.push({ field: `${field}.location`, message: FIELD_REPAIR_PROBLEMS.duplicate });
        return;
      }
      seen.add(location);
      const element = item["element"];
      if (typeof element !== "string" || element.trim() === "") {
        problems.push({ field: `${field}.element`, message: FIELD_REPAIR_PROBLEMS.emptyElement });
        return;
      }
      const problem = elementProblem(element, span, context.additions !== undefined && span.kind === "validation");
      if (problem !== null) {
        problems.push({ field: `${field}.element`, message: problem });
        return;
      }
      replacements.push({ location, element });
    });
  }
  // 主張は v1 の直す段と同じ検査（宣言の欄は形の上の置き場だけ。主張の欄の問題だけを拾う）
  const disputes = checkRepairAnswer({ declaration: "-", disputes: value["disputes"] }, context.source, context.testIds);
  if (!disputes.ok) {
    for (const problem of disputes.problems) if (problem.field.startsWith("disputes")) problems.push(problem);
  }
  if (problems.length > 0 || !disputes.ok) return { ok: false, problems };
  return { ok: true, value: { replacements, disputes: disputes.value.disputes, rejected: disputes.value.rejected } };
}

/** この段が受け取るもの */
export interface FieldRepairInput {
  /** 原文（主張の引用を照らす。データには載せない） */
  readonly source: string;
  readonly list: RequirementList;
  readonly suite: TestSuite;
  /** 一番良い版の宣言の原文 */
  readonly declaration: string;
  /** 一番良い版の失敗の場所（場所なしが 0・場所が 1 つ以上のものだけを渡す） */
  readonly failures: FailureLocations;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/**
 * この段のデータ（見せる範囲は今の直す段を超えない。前の版の失敗・会話を積まない）。旗 `v12.ids` の走り（場所の結果が `additions`
 * を持つ）だけ、失敗の一覧の各場所を場所の名前と種類（replace・add）の組にする（Issue #667）
 */
export function buildFieldRepairData(input: Pick<FieldRepairInput, "list" | "suite" | "declaration" | "failures">): readonly PromptData[] {
  const additions = input.failures.additions;
  const failures = input.failures.located.map((failure) => ({
    testId: failure.testId,
    requirementId: failure.requirementId,
    kind: failure.kind,
    message: failure.message,
    locations:
      additions === undefined
        ? failure.locations
        : failure.locations.map((location) => ({
            location,
            kind: (additions.some((addition) => addition.key === location) ? "add" : "replace") satisfies FieldLocationKind,
          })),
  }));
  const [declaration, failureList, suite, list] = FIELD_REPAIR_DATA_NAMES;
  return [
    { name: declaration, text: input.declaration },
    { name: failureList, text: serializeJson(failures) },
    { name: suite, text: serializeJson(input.suite) },
    { name: list, text: serializeJson(input.list) },
  ];
}

/**
 * 欄だけの直しを 1 回呼ぶ（共通の口だけ）。形が合わなければ問題を返して 1 回だけ直させ、続けば `malformed`。場所に写した失敗が
 * 無い・場所なしがある入力では呼ばない（呼んだら前提の誤り）。
 */
export async function runFieldRepair(input: FieldRepairInput): Promise<StageOutcome<FieldRepairAnswer>> {
  const { locations, unlocated, spans } = input.failures;
  if (locations.length === 0 || unlocated.length > 0) {
    throw new Error("欄だけの直し：場所の無い失敗が残る往復では呼ばない（回す部分の前提が壊れた）");
  }
  const additions = input.failures.additions;
  const request = buildStructuredRequest({
    rules: ruleTexts(additions === undefined ? FIELD_REPAIR_RULE_DEFINITIONS : FIELD_REPAIR_IDS_RULE_DEFINITIONS),
    documents: input.documents,
    data: buildFieldRepairData(input),
    schemaName: FIELD_REPAIR_SCHEMA_NAME,
    schema: fieldRepairSchemaOf(locations),
    maxOutputTokens: input.gateway.maxOutputTokens("repair"),
  });
  const testIds = new Set(input.suite.tests.map((test) => test.id));
  const outcome = await callStructuredChecked(input.gateway, {
    request,
    check: (output) =>
      checkFieldRepairAnswer(output, { locations, spans, source: input.source, testIds, ...(additions === undefined ? {} : { additions }) }),
  });
  return outcome.ok ? { ok: true, value: outcome.value } : outcome;
}

// ── マージ（コード）─────────────────────────────────────────────────

/** マージを断る理由の固定文 */
export const MERGE_REFUSALS = {
  unknownLocation: "置き換えの場所が一番良い版の要素に無い",
  bytes: "置き換えた版が宣言の大きさの上限を超える",
  unreadable: "置き換えた版が宣言として読めない",
  outside: "置き換えた要素の外の値が一番良い版と等しくない",
  noSection: "追加の先の検査の節（validations）が宣言に無い",
  added: "追加した検査がその位置に無いか、検査の数が追加の数だけ増えていない",
} as const;
export type MergeRefusal = (typeof MERGE_REFUSALS)[keyof typeof MERGE_REFUSALS];

/** 範囲の行の原文 */
const spanText = (lines: readonly string[], span: DeclarationSpan): string => lines.slice(span.start, span.end).join("\n");

/** マージの結果 */
export type MergeResult = { readonly ok: true; readonly source: string } | { readonly ok: false; readonly refusal: MergeRefusal };

/** 読み取りの値から、置き換えた要素を外したもの（比べるための写し。並びの要素は位置を残して null にする） */
function withoutSlots(document: unknown, spans: readonly DeclarationSpan[]): unknown {
  const copy = JSON.parse(JSON.stringify(document ?? null)) as unknown;
  if (!isRecord(copy)) return copy;
  for (const span of spans) {
    const section = copy[span.slot.section];
    if (!Array.isArray(section)) continue;
    if ("field" in span.slot) {
      const entity: unknown = section[span.slot.index];
      if (isRecord(entity) && isRecord(entity["fields"])) delete entity["fields"][span.slot.field];
    } else if (span.slot.index < section.length) {
      section[span.slot.index] = null;
    }
  }
  return copy;
}

/** 行の編集 1 つ（`start` から `remove` 行を `lines` に替える） */
interface LineEdit {
  readonly start: number;
  readonly remove: number;
  readonly lines: readonly string[];
}

/**
 * 追加の本文を validations の節の末尾に挿し込む編集（旗 ids の走りだけ。Issue #667）。並びの節は最後の中身の行の後ろに、
 * `validations: []` の節は並びの形に直して挿し込む。節が無い・ほかの流れの書き方は null（断る）。字下げは節の要素の `-` の位置
 * （要素が無ければ、ほかの並びの節の要素の位置。無ければ 2）にそろえる。
 */
function insertionEdit(lines: readonly string[], bodies: readonly string[], spans: readonly DeclarationSpan[]): LineEdit | null {
  const isContentLine = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");
  const fallbackIndent = spans.find((span) => span.kind !== "field")?.indent ?? 2;
  const padded = (indent: number): readonly string[] =>
    bodies.flatMap((body) => dedentElement(body).map((line) => (line === "" ? "" : `${" ".repeat(indent)}${line}`)));
  const empty = lines.findIndex((line) => /^validations:\s*\[\s*\]\s*(#.*)?$/.test(line));
  const block = lines.findIndex((line) => /^validations:\s*(#.*)?$/.test(line));
  if (block < 0) return empty < 0 ? null : { start: empty, remove: 1, lines: ["validations:", ...padded(fallbackIndent)] };
  let last = block;
  let itemIndent: number | null = null;
  for (let index = block + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isContentLine(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (itemIndent === null) itemIndent = indent;
    last = index;
  }
  return { start: last + 1, remove: 0, lines: padded(itemIndent ?? fallbackIndent) };
}

/** 読み取りの値の validations（無い・null は空の並び。並びでなければ null） */
const validationsOf = (document: unknown): unknown[] | null => {
  if (!isRecord(document)) return null;
  const value = document["validations"] ?? [];
  return Array.isArray(value) ? value : null;
};

/**
 * 一番良い版の原文に置き換えを当てる（純粋）。各要素の行の範囲だけを、字下げをその要素の最初の行にそろえた本文に替え、
 * spec-engine の読み取りで読み直し、置き換えた要素の外の値と要素の数が一番良い版と深く等しいときだけ版にする。
 *
 * `additions`（旗 `v12.ids` の走りだけ。Issue #667）を渡せば、追加の場所の本文を validations の節の末尾に場所の順で挿し込み、
 * 置換と追加の外の値が一番良い版と深く等しく、検査の数がちょうど追加の数だけ増え、追加した検査がその位置（末尾）に在ることも
 * 確かめる。節が無い宣言は断る。
 */
export function mergeReplacements(
  declaration: string,
  replacements: readonly FieldReplacement[],
  spans: readonly DeclarationSpan[],
  additions: readonly ValidationAddition[] = [],
): MergeResult {
  const targets: { readonly span: DeclarationSpan; readonly lines: readonly string[] }[] = [];
  const inserted: { readonly addition: ValidationAddition; readonly element: string }[] = [];
  for (const replacement of replacements) {
    const addition = additions.find((candidate) => candidate.key === replacement.location);
    if (addition !== undefined) {
      inserted.push({ addition, element: replacement.element });
      continue;
    }
    const span = spans.find((candidate) => candidate.key === replacement.location);
    if (span === undefined) return { ok: false, refusal: MERGE_REFUSALS.unknownLocation };
    const pad = " ".repeat(span.indent);
    targets.push({ span, lines: dedentElement(replacement.element).map((line) => (line === "" ? "" : `${pad}${line}`)) });
  }
  const lines = declaration.split("\n");
  const edits: LineEdit[] = targets.map((target) => ({ start: target.span.start, remove: target.span.end - target.span.start, lines: target.lines }));
  if (inserted.length > 0) {
    const edit = insertionEdit(lines, inserted.map((entry) => entry.element), spans);
    if (edit === null) return { ok: false, refusal: MERGE_REFUSALS.noSection };
    edits.push(edit);
  }
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) lines.splice(edit.start, edit.remove, ...edit.lines);
  const source = lines.join("\n");
  if (checkDeclarationBytes(utf8ByteLength(source)) !== undefined) return { ok: false, refusal: MERGE_REFUSALS.bytes };
  const before = readSpecDocument(declaration);
  const after = readSpecDocument(source);
  if (!before.ok || !after.ok) return { ok: false, refusal: MERGE_REFUSALS.unreadable };
  const replaced = targets.map((target) => target.span);
  let beforeValues = withoutSlots(before.document, replaced);
  let afterValues = withoutSlots(after.document, replaced);
  if (inserted.length > 0) {
    // 検査の数がちょうど追加の数だけ増え、末尾の検査が追加の場所の（entity・名前）と同じ順で並ぶこと
    const beforeList = validationsOf(beforeValues);
    const afterList = validationsOf(afterValues);
    if (beforeList === null || afterList === null || afterList.length !== beforeList.length + inserted.length) {
      return { ok: false, refusal: MERGE_REFUSALS.added };
    }
    const tail = afterList.slice(beforeList.length);
    const placed = inserted.every(({ addition }, index) => {
      const item: unknown = tail[index];
      return isRecord(item) && item["name"] === addition.name && item["entity"] === addition.entity;
    });
    if (!placed) return { ok: false, refusal: MERGE_REFUSALS.added };
    beforeValues = { ...(beforeValues as Record<string, unknown>), validations: beforeList };
    afterValues = { ...(afterValues as Record<string, unknown>), validations: afterList.slice(0, beforeList.length) };
  }
  if (canonicalJson(beforeValues) !== canonicalJson(afterValues)) {
    return { ok: false, refusal: MERGE_REFUSALS.outside };
  }
  // 要素の並び（場所の名前と順）が同じで、置き換えていない要素の原文の行がバイト列で同じこと（重なったキーのように、読み取りの
  // 値では見えない変化も断る）。追加した検査は、その場所の名前で節の末尾の位置に在ること
  const merged = declarationSpans(source);
  if (!merged.ok) return { ok: false, refusal: MERGE_REFUSALS.unreadable };
  const beforeLines = declaration.split("\n");
  const replacedKeys = new Set(replaced.map((span) => span.key));
  const addedKeys = new Set(inserted.map((entry) => entry.addition.key));
  const kept = merged.spans.filter((span) => !addedKeys.has(span.key));
  const same =
    kept.length === spans.length &&
    kept.every((span, index) => {
      const original = spans[index];
      if (original === undefined || original.key !== span.key) return false;
      return replacedKeys.has(span.key) || spanText(lines, span) === spanText(beforeLines, original);
    });
  if (!same) return { ok: false, refusal: MERGE_REFUSALS.outside };
  if (inserted.length > 0) {
    const count = validationsOf(after.document)?.length ?? 0;
    const at = inserted.every(({ addition }, index) => {
      const found = merged.spans.filter((span) => span.key === addition.key);
      const slot = found[0]?.slot;
      return found.length === 1 && slot?.section === "validations" && slot.index === count - inserted.length + index;
    });
    if (!at) return { ok: false, refusal: MERGE_REFUSALS.added };
  }
  return { ok: true, source };
}
