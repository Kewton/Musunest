// 台本（`musunest-eval/plan-script/v1`）の答える役（04-plan-agent.md §2・§7・§9。Issue #444）。
//
// 評価の道具（#427）が持つ台本は、**質問 ID ではなく点検済みの事項（どの要件のどの決めどころか）**で
// 問いに答える。質問 ID・選択肢 ID・要件 ID は実行のたびに工場が付け直すので、台本はそれらを持たず、
// **目録の観点 ID** と**鍵（正規表現）**で指す。ここは、その台本を `PlanResponder` の口の実装にする。
//
// **当て方 v2**（Issue #444・#893）：問いの主の事項と、一緒に閉じる事項（`alsoCloses`）の**それぞれ**を、
// 台本の項目に**観点と鍵**で当てる。既知の観点どうしの不一致は当てない。**事項の観点が null で項目の観点が
// 非 null のとき（緩めた経路）に限り**、鍵を**事項の文だけ**に当てる（参照先の要件の文は連結しない）。
// それ以外は今までどおり事項の文と要件の文に当てる。当たった項目が**全部で 1 件**で、その答えが問いの
// 選択肢の 1 つに決まるときだけ答える。ID の字面で観点を補わない。
//
//   答えた（`answered`）… 1 件に当たり、答えが選択肢 1 つに決まった
//   不明（`unknown`）… 当たらない
//   重複（`duplicate`）… 2 件以上に当たる（主の事項と一緒に閉じる事項が**別の**項目に当たる場合も含む）
//   選択肢が決まらない（`no-choice`）… 1 件に当たったが、`choose` が 0 か 2 つ以上の選択肢に当たる
//   古い版（`stale-revision`）… 問いの版が、いまの Plan の版と違う
//
// **推奨で埋めない。** 台本に無い問い（`unknown`・`duplicate`・`no-choice`・`stale-revision`）は答えを
// 返さない——その事項は開いたまま残り、既存の往復と上限の扱いに乗る。`all-recommended` も返さない。
// 束の一部にだけ答えてもよい（答えの並びは空や一部でよい）。
//
// **実 API は呼ばない。** 差し込まれたデータ（台本）と、渡された照合の文脈だけで閉じる。
import type { PlanAnswerDraft } from "./answers.js";
import { CATALOG_FACETS } from "./catalog.js";
import type { PlanQuestion } from "./questions.js";
import type {
  PlanAnswerIssueContext,
  PlanAnswerOutcome,
  PlanAnswerQuestionContext,
  PlanAnswerRequest,
  PlanConfirmOutcome,
  PlanResponder,
} from "./run-plan.js";
import { isRecord } from "../stages/prompt.js";

/** 台本の契約の版（工場の入口で形を確かめる） */
export const PLAN_SCRIPT_SCHEMA = "musunest-eval/plan-script/v1" as const;
/** 当て方の版（往復の記録に残す。Issue #444・#893） */
export const SCRIPT_MATCHER_VERSION = "v2" as const;
/** 台本の `facet` に書ける、工場の目録の観点 ID（`catalog.ts` の一覧と同じ。`null` も許す） */
const CATALOG_FACET_IDS: ReadonlySet<string> = new Set(CATALOG_FACETS.map((facet) => facet.id));

/**
 * 照合の状態（**有限**。Issue #444）。往復の記録に残す区分である。
 */
export const SCRIPT_MATCH_STATES = ["answered", "unknown", "duplicate", "no-choice", "stale-revision"] as const;
export type ScriptMatchState = (typeof SCRIPT_MATCH_STATES)[number];

/**
 * 問い 1 つの照合の診断（**値を持たない**。件数・真偽・有限の状態だけ。Issue #893）。台本の鍵・根拠の
 * 文・事項の文・要件の文・事項 ID は入れない。
 */
export interface PlanScriptMatchDiagnosis {
  /** 観点を見ずに、鍵が全部当たった項目の数（事項をまたいで添字の重複を除く。鍵は事項の文と要件の文） */
  readonly keysOnlyEntries: number;
  /** そのうち、v2 の観点の条件（既知の観点の不一致）で落とした項目の数 */
  readonly facetRejectedEntries: number;
  /** v2 の緩めた経路で当たった項目があったか */
  readonly relaxed: boolean;
  /** 要件の文を連結すれば鍵が全部当たるが、事項の文だけでは当たらなかったので緩めた経路で落とした項目の数 */
  readonly requirementTextNeeded: number;
  /** 同じ問いに v1 の条件を当てたときの状態 */
  readonly v1State: ScriptMatchState;
}

/**
 * 問い 1 つの照合の結果（**値を持たない**。Issue #444）。識別には**コードが振った質問 ID・往復の版・
 * 当たった台本の項目の添字**を使う。**台本の鍵・根拠の文・事項 ID の文字列は入れない。**
 */
export interface PlanScriptMatch {
  readonly questionId: string;
  readonly revision: number;
  readonly state: ScriptMatchState;
  /** 1 件に当たったときの台本の項目の添字（`answered`・`no-choice` のときだけ。それ以外は `null`） */
  readonly entryIndex: number | null;
  /** 値を持たない診断（Issue #893） */
  readonly diagnosis: PlanScriptMatchDiagnosis;
}

/** 台本の答え（`choose`＝選択肢の文を指す鍵。`recommended`＝点検の結果、推奨でよいと決めた） */
export type PlanScriptAnswer =
  | { readonly kind: "choose"; readonly patterns: readonly RegExp[] }
  | { readonly kind: "recommended" };

/** 台本の項目 1 つ（読取り後。鍵は正規表現に組んである） */
export interface PlanScriptEntry {
  readonly id: string;
  /** 目録の観点 ID（目録に無い決めどころなら `null`） */
  readonly facet: string | null;
  /** 全部が当たること（要件と決めどころの両方を指す語を書く） */
  readonly keys: readonly RegExp[];
  readonly answer: PlanScriptAnswer;
}

/** 台本（形を確かめた後のもの） */
export interface PlanScript {
  readonly entries: readonly PlanScriptEntry[];
}

/** 正規表現の鍵の並びを確かめ、組み立てる（1 件以上・空でない文字列・正規表現として読める） */
function compilePatterns(
  value: unknown,
  field: string,
): { readonly patterns: readonly RegExp[] } | { readonly error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${field}: 正規表現の並び（1 件以上）であること` };
  }
  const patterns: RegExp[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const pattern = value[index];
    if (typeof pattern !== "string" || pattern === "") {
      return { error: `${field}[${index}]: 空でない文字列であること` };
    }
    try {
      patterns.push(new RegExp(pattern));
    } catch {
      return { error: `${field}[${index}]: 正規表現として読めません` };
    }
  }
  return { patterns };
}

/**
 * 台本の答えの形を確かめる（`choose` と `recommended: true` の**ちょうど一方**。`field` は位置）。
 * 両方を持つ・どちらも無い・`recommended` が真でない・`choose` が正規表現の並びでない場合は不正。
 */
function checkScriptAnswer(value: unknown, field: string): PlanScriptAnswer | { readonly error: string } {
  if (!isRecord(value)) return { error: `${field}: 答えは写像（object）であること` };
  const recommended = value["recommended"];
  const choose = value["choose"];
  if (recommended !== undefined && choose !== undefined) {
    return { error: `${field}: choose と recommended のちょうど一方を書くこと（両方は不可）` };
  }
  if (choose !== undefined) {
    const compiled = compilePatterns(choose, `${field}.choose`);
    if ("error" in compiled) return compiled;
    return { kind: "choose", patterns: compiled.patterns };
  }
  if (recommended === true) return { kind: "recommended" };
  if (recommended !== undefined) return { error: `${field}.recommended: 真であること` };
  return { error: `${field}: choose（選択肢の鍵の並び）か recommended（真）のちょうど一方を書くこと` };
}

/**
 * 台本の項目 1 つの形を確かめる（`id` は一意・`facet` は目録の観点 ID か `null`・`keys` は正規表現の
 * 並び・`answer` は `choose` と `recommended: true` のちょうど一方・`basis` は空でない）。`basis` は
 * 検査したあと保持しない。**誤りの文は位置だけ**（ID・鍵・根拠の値を埋めない）。
 */
function checkScriptEntry(value: unknown, index: number, seen: Set<string>): PlanScriptEntry | { readonly error: string } {
  const field = `entries[${index}]`;
  if (!isRecord(value)) return { error: `${field}: 項目は写像（object）であること` };
  const id = value["id"];
  if (typeof id !== "string" || id === "") return { error: `${field}.id: 識別子は空でない文字列であること` };
  if (seen.has(id)) return { error: `${field}.id: 識別子が重複している` };
  seen.add(id);
  const rawFacet = value["facet"];
  const facet =
    rawFacet === null ? null : typeof rawFacet === "string" && CATALOG_FACET_IDS.has(rawFacet) ? rawFacet : undefined;
  if (facet === undefined) return { error: `${field}.facet: 目録の観点 ID か null であること` };
  const compiled = compilePatterns(value["keys"], `${field}.keys`);
  if ("error" in compiled) return compiled;
  const answer = checkScriptAnswer(value["answer"], `${field}.answer`);
  if ("error" in answer) return answer;
  if (typeof value["basis"] !== "string" || value["basis"] === "") {
    return { error: `${field}.basis: 根拠は空でない文字列であること` };
  }
  return { id, facet, keys: compiled.patterns, answer };
}

/**
 * 台本の文字列を読む（工場の入口の形の検査）。v1 の表（`eval/README.md` §5.6.2）と、評価の道具の
 * `validateScript` に合わせて、`schema`・`subject`・整数の `version`・`entries[]`（`id` の一意・
 * `facet`・`keys`・`answer`・`basis`）を確かめる。形の不正は人（とコード）の読む文にして返す
 * （例外にしない）。**推奨で流さない**——形が不正なら止める（呼ぶ側が使い方の誤りにする）。
 */
export function parsePlanScript(text: string): PlanScript | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "台本が JSON として読めません" };
  }
  if (!isRecord(value)) return { error: "台本は写像（object）であること" };
  if (value["schema"] !== PLAN_SCRIPT_SCHEMA) {
    return { error: `台本の版（schema）が ${PLAN_SCRIPT_SCHEMA} ではありません` };
  }
  if (typeof value["subject"] !== "string" || value["subject"] === "") {
    return { error: "台本の subject は空でない文字列であること" };
  }
  if (!Number.isInteger(value["version"])) return { error: "台本の version は整数であること" };
  const rawEntries = value["entries"];
  if (!Array.isArray(rawEntries)) return { error: "台本の項目（entries）は並び（array）であること" };
  const entries: PlanScriptEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = checkScriptEntry(rawEntries[index], index, seen);
    if ("error" in entry) return entry;
    entries.push(entry);
  }
  return { entries };
}

/**
 * 観点が食い違わないか（Issue #444）。**観点を求める項目**（`entryFacet` が非 `null`）は、**観点が欠けた
 * 値**（`issueFacet` が `null`）の事項には当たらない——ID の字面で補わない。v2 の緩めた経路はこれとは
 * 別に扱う（`matchesUnderV2`）。
 */
function facetMatches(entryFacet: string | null, issueFacet: string | null): boolean {
  if (entryFacet === null) return true;
  if (issueFacet === null) return false;
  return entryFacet === issueFacet;
}

/** 既知の観点どうしが食い違うか（v2 で落とす条件。どちらかが null なら食い違わない） */
function isKnownFacetMismatch(entryFacet: string | null, issueFacet: string | null): boolean {
  return entryFacet !== null && issueFacet !== null && entryFacet !== issueFacet;
}

/** 鍵（正規表現）が**全部**、事項の文に当たるか */
function keysMatchText(entry: PlanScriptEntry, text: string): boolean {
  return entry.keys.every((pattern) => pattern.test(text));
}

/** 鍵（正規表現）が**全部**、事項の文（と、あれば参照先の要件の文）に当たるか */
function keysMatchFull(entry: PlanScriptEntry, issue: PlanAnswerIssueContext): boolean {
  const text = issue.requirement === null ? issue.text : `${issue.text}\n${issue.requirement.text}`;
  return keysMatchText(entry, text);
}

/**
 * 当て方 v2 で項目が事項に当たるか（Issue #893）。**事項の観点が null で項目の観点が非 null のとき**だけ、
 * 鍵を事項の文だけに当てる（要件の文は連結しない）。それ以外は今までどおり観点を照らし、鍵を事項の文と
 * 要件の文に当てる。
 */
function matchesUnderV2(entry: PlanScriptEntry, issue: PlanAnswerIssueContext): boolean {
  if (issue.facetId === null && entry.facet !== null) return keysMatchText(entry, issue.text);
  if (!facetMatches(entry.facet, issue.facetId)) return false;
  return keysMatchFull(entry, issue);
}

/** 当て方 v1 で項目が事項に当たるか（診断の `v1_state` を求めるためだけに残す。Issue #893） */
function matchesUnderV1(entry: PlanScriptEntry, issue: PlanAnswerIssueContext): boolean {
  if (!facetMatches(entry.facet, issue.facetId)) return false;
  return keysMatchFull(entry, issue);
}

/** 主の事項と一緒に閉じる事項のそれぞれを当て、当たった項目の添字を集める（重複は 1 件に数える） */
function matchedIndexes(
  script: PlanScript,
  context: PlanAnswerQuestionContext | undefined,
  predicate: (entry: PlanScriptEntry, issue: PlanAnswerIssueContext) => boolean,
): Set<number> {
  const matched = new Set<number>();
  if (context === undefined) return matched;
  for (const issue of [context.main, ...context.alsoCloses]) {
    script.entries.forEach((entry, entryIndex) => {
      if (predicate(entry, issue)) matched.add(entryIndex);
    });
  }
  return matched;
}

/** 当たった項目の集合から照合の状態を決める（1 件だけなら、その答えが選択肢 1 つに決まるかを見る） */
function resolveFromMatched(
  script: PlanScript,
  question: PlanQuestion,
  matched: ReadonlySet<number>,
): { readonly state: ScriptMatchState; readonly entryIndex: number | null; readonly choiceId?: string } {
  if (matched.size === 0) return { state: "unknown", entryIndex: null };
  if (matched.size > 1) return { state: "duplicate", entryIndex: null };
  const entryIndex = [...matched][0] as number;
  const entry = script.entries[entryIndex] as PlanScriptEntry;
  const choiceId =
    entry.answer.kind === "recommended"
      ? recommendedChoiceId(question)
      : chooseChoiceId(question, entry.answer.patterns);
  if (choiceId === undefined) return { state: "no-choice", entryIndex };
  return { state: "answered", entryIndex, choiceId };
}

/**
 * 問い 1 つの診断を求める（**値を持たない**。Issue #893）。観点を見ずに鍵が全部当たった項目の数・そのうち
 * 既知の観点の不一致で落とした項目の数・緩めた経路で当たったか・緩めた経路で要件の文が要ると落とした項目の
 * 数を持つ。落とした項目は、v2 でどの事項にも当たらなかったものだけを数える。
 */
function diagnose(
  script: PlanScript,
  context: PlanAnswerQuestionContext | undefined,
  matchedByV2: ReadonlySet<number>,
  v1State: ScriptMatchState,
): PlanScriptMatchDiagnosis {
  if (context === undefined) {
    return {
      keysOnlyEntries: 0,
      facetRejectedEntries: 0,
      relaxed: false,
      requirementTextNeeded: 0,
      v1State,
    };
  }
  const keysOnly = new Set<number>();
  const facetRejected = new Set<number>();
  const requirementNeeded = new Set<number>();
  let relaxed = false;
  for (const issue of [context.main, ...context.alsoCloses]) {
    script.entries.forEach((entry, entryIndex) => {
      const fullMatch = keysMatchFull(entry, issue);
      if (fullMatch) keysOnly.add(entryIndex);
      if (fullMatch && isKnownFacetMismatch(entry.facet, issue.facetId)) facetRejected.add(entryIndex);
      if (issue.facetId === null && entry.facet !== null) {
        // 緩めた経路：鍵は事項の文だけに当てる
        if (keysMatchText(entry, issue.text)) relaxed = true;
        else if (fullMatch) requirementNeeded.add(entryIndex);
      }
    });
  }
  return {
    keysOnlyEntries: keysOnly.size,
    facetRejectedEntries: [...facetRejected].filter((entryIndex) => !matchedByV2.has(entryIndex)).length,
    relaxed,
    requirementTextNeeded: [...requirementNeeded].filter((entryIndex) => !matchedByV2.has(entryIndex)).length,
    v1State,
  };
}

/** `choose` が全部当たる選択肢が**ちょうど 1 つ**ならその ID。0 か 2 つ以上なら `undefined` */
function chooseChoiceId(question: PlanQuestion, patterns: readonly RegExp[]): string | undefined {
  const matched = question.choices.filter((choice) => patterns.every((pattern) => pattern.test(choice.text)));
  return matched.length === 1 ? matched[0]?.id : undefined;
}

/**
 * 推奨の選択肢の ID（Issue #444）。**実在する推奨の選択肢**に決まるときだけ返す——推奨が無い・推奨が
 * 問いの選択肢に無いときは `undefined`（最初の選択肢で代用しない。`no-choice` として記録する）。
 */
function recommendedChoiceId(question: PlanQuestion): string | undefined {
  const choiceId = question.recommended?.choiceId;
  if (choiceId === undefined) return undefined;
  return question.choices.some((choice) => choice.id === choiceId) ? choiceId : undefined;
}

/** 1 往復の記録（提示した問いと返した答え。`cli-plan.ts` の `PlanTranscriptRound` と同形。Issue #444） */
export interface PlanScriptRoundRecord {
  readonly questions: readonly PlanQuestion[];
  readonly answers: readonly PlanAnswerDraft[];
  readonly allRecommended: boolean;
}

/**
 * 台本の答える役が、往復の記録へ書き込む口（`cli-plan.ts` の往復の記録が実装する）。**値ではなく、
 * コードが振った ID・版・状態・添字**、提示した問いと返した答えだけを渡す（Issue #444）。
 */
export interface PlanScriptRecordSink {
  /** 問い 1 つの照合の結果 */
  readonly match?: (match: PlanScriptMatch) => void;
  /** 確認の画面の答え（`build` か `stop`） */
  readonly confirmation?: (decision: PlanConfirmOutcome) => void;
  /** 1 往復（提示した問いと返した答え。部分・空の答えも残す） */
  readonly round?: (round: PlanScriptRoundRecord) => void;
}

/** 何も記録しない既定の口（単体の試験と、記録を要さない呼び出し用） */
const NO_SINK: PlanScriptRecordSink = {};

/**
 * 台本の答える役（04 §7・§9。Issue #444・#893）。各問いについて、主の事項と一緒に閉じる事項を台本の項目に
 * **観点と鍵**で当て、1 件に当たったときだけ選択肢を返す。**当たらない問いは答えを返さず**、その事項は
 * 開いたまま残る。確認の画面の答えは、答えのファイルの形と同じ `build` である（§5）。
 */
export function createScriptPlanResponder(
  script: PlanScript,
  sink: PlanScriptRecordSink = NO_SINK,
): PlanResponder {
  return {
    async answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome> {
      const drafts: PlanAnswerDraft[] = [];
      request.questions.forEach((question, index) => {
        const context = request.issues[index];
        // 古い版の問いには答えない（いまの Plan の版と問いの版を照合する）
        const stale = question.revision !== request.revision;
        const matchedV2 = stale ? new Set<number>() : matchedIndexes(script, context, matchesUnderV2);
        const resolved = stale
          ? { state: "stale-revision" as const, entryIndex: null, choiceId: undefined }
          : resolveFromMatched(script, question, matchedV2);
        const v1State: ScriptMatchState = stale
          ? "stale-revision"
          : resolveFromMatched(script, question, matchedIndexes(script, context, matchesUnderV1)).state;
        const diagnosis = diagnose(script, context, matchedV2, v1State);
        sink.match?.({
          questionId: question.id,
          revision: question.revision,
          state: resolved.state,
          entryIndex: resolved.entryIndex,
          diagnosis,
        });
        if (resolved.state !== "answered" || resolved.choiceId === undefined) return;
        drafts.push({
          id: `A:${question.id}`,
          questionId: question.id,
          revision: question.revision,
          choiceId: resolved.choiceId,
        });
      });
      // 提示した問いの束と返した答え（部分・空の答えも）を、既存の往復の記録に残す（F1・Issue #444）
      sink.round?.({ questions: request.questions, answers: drafts, allRecommended: false });
      // 推奨で埋めない。束の一部にだけ答えてよい（答えの並びは空や一部でよい）
      return { kind: "answers", answers: drafts };
    },
    async confirm(): Promise<PlanConfirmOutcome> {
      // 確認の画面の答えは、答えのファイルの形と同じ（自動で「これで作る」。§5・Issue #444）
      sink.confirmation?.("build");
      return "build";
    },
  };
}
