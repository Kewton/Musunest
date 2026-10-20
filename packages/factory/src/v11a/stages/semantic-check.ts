// T1'' 表の意味の点検（07-architecture-v1.1a.md §1・§1.1・追加判断 A。Issue #507）。
//
// 名前の固定が防ぐのは事後の付け替えだけで、要件に対する表の意味の点検は別に要る（§1.1）。**LLM の別の会話**が
// 要件ごとに 3 つを見る：所属の各行はこの要件に必要か／要件を満たすのに必要な対象が表に無いか／確かめ方の
// 種類と checks は要件の決まりを確かめられるか。判定は受理／拒否（種類つき・引用つき）である。
//
// 旗 `v12.ledger` が on の走り（`ledger` を渡したとき。Issue #548）は、R-sc-02 の (3) の末尾の受理条件の文を性質の
// 台帳の行から台帳の順で組む（default-value の文は今の文とバイト列で同じ）。拒否の種類・schema・完全性と引用の検査・
// 対象・データは変えない。off は今の定数のまま。
//
// **完全性と引用の実在はコードが形として確かめる**（`checkJudgmentsShape`。B3' と共有）：対象の全要件に
// ちょうど 1 判定。欠落・重複・未知の要件 ID・確定した仕様にも要件の文にも見つからない引用・引用の無い拒否は
// 形の落ちで、共通の窓口が 1 回やり直し、2 回続けば `malformed`（点検していない状態で先へ進まない）。
// **受理を既定にしない**——欠落を受理で埋めない。結果は表の SHA-256 に結ぶ。
//
// 旗 `v12.ids` の走り（Issue #662）は `runSemanticCheckBundled` で、対象の要件を 6 件ごとの束に切って同時に呼ぶ（束ごとのデータは
// 束の要件の文と引用・所属・確かめ方・印と**表の全行**。形のやり直しは段全体で通算 1。下の節）。off は `runSemanticCheck` のまま。
//
// 見せるもの：要件の文と引用・表の行（**`name` の欄は見せない**。`role`・`kind`・`type`・`options`・`groupBy`・
// `refEntity` は見せる）・所属・確かめ方・J4 の印。**試験・期待・合否・名前を見せない。** T1 の確かめ方が
// `unresolved` の要件は対象から除く（データにも応答の必須にも入れない）。J4 の印は助言で、判定を変えない（D5）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import type { RequirementList } from "../../pipeline.js";
import type { LlmStructuredRequest } from "../../llm.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  PREVIOUS_RESPONSE_DATA_NAME,
  ruleTexts,
  serializeJson,
  SHAPE_PROBLEMS_DATA_NAME,
  STEP_ATTEMPTS,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
  type StageOutcome,
} from "../../stages/prompt.js";
import type { SemanticCheckResult, SemanticJudgment } from "../carry-over.js";
import { nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import type { LedgerView } from "../../v12/ledger.js";
import { V12_C3_BUNDLE } from "../../v12/limits.js";

/** T1'' の JSON Schema の名前 */
export const SEMANTIC_CHECK_SCHEMA_NAME = "semantic-check";

/** T1'' の拒否の種類（不要な所属・欠けた対象・弱い確かめ方） */
export const SEMANTIC_REJECTION_KINDS = ["unnecessary-ownership", "missing-target", "weak-verification"] as const;
export type SemanticRejectionKind = (typeof SEMANTIC_REJECTION_KINDS)[number];

/** T1'' に足す規則の定義（ID は `R-sc-nn`） */
export const SEMANTIC_CHECK_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-sc-01",
    text: "あなたは、宣言の名前の表を、要件ごとに要件の意味に照らして点検する。表を作り直さない。名前の規則・一意・参照の形はコードが確かめ済みなので、要件の意味に合うかだけを判定する。",
    why: "名前の固定とは別に、表の意味を別の会話で独立に点検する（§1.1）",
    since: "Issue #507",
  },
  {
    id: "R-sc-02",
    text: "要件ごとに 3 つを見る：(1) 所属の各行は、この要件を満たすのに必要か（unnecessary-ownership）。(2) この要件を満たすのに必要な対象（項目・計算・集計・操作・画面）が表に無いか（missing-target）。(3) 確かめ方の種類と checks は、要件の決まりを確かめられるか。決まりを含む要件を、在ることだけを見る構造の検査で確かめていれば弱い（weak-verification）。確かめ方が default-value の要件は、要件の決まりが選択肢の項目の既定値 1 つだけで、value が要件の文の値と合うときだけ受理する。既定値のほかの決まり（入力の制約など）を含む要件や、value が要件の文の値と違う要件は受理せず、weak-verification で拒否する。",
    why: "表の意味の抜け（誤った所属・欠けた対象・弱い確かめ方）を見る 3 つの観点を固定する（§1.1）。既定値の確かめ方は試験の免除に効くので、決まりが既定値だけかと値の一致を独立に点検する（方法論 03 §1 の H1。Issue #533）",
    since: "Issue #507（default-value の受理の条件は #533 で足した）",
  },
  {
    id: "R-sc-03",
    text: "判定は、データの「要件の文と引用」の要件ごとにちょうど 1 つ返す。requirementId はデータのまま写す。データに無い要件の判定を書かない。",
    why: "完全性（対象の全要件にちょうど 1 判定）をコードが確かめられる形にする（§1.1）",
    since: "Issue #507",
  },
  {
    id: "R-sc-04",
    text: "受理は、3 つを確かめて問題が無いときだけにする。受理の kind と quote は null にする。問題があれば拒否にし、kind に 3 つの種類のどれか 1 つを、quote に要件の文か引用からそのまま写した根拠の文字列を書く。根拠を写せない拒否をしない。",
    why: "受理を既定にせず、拒否には要件からの引用を要する（追認も捏造も通さない。§1.1）",
    since: "Issue #507",
  },
  {
    id: "R-sc-05",
    text: "助言の印（不要の疑い・不明・確信度不明・未判定）は参考である。印だけを理由に拒否しない。印が無いことを受理の理由にしない。",
    why: "J4 は助言であって保証に数えない（D5・追加判断 A）",
    since: "Issue #507",
  },
];

/** T1'' に足す規則（定義の `text` から組む） */
export const SEMANTIC_CHECK_RULES: readonly string[] = ruleTexts(SEMANTIC_CHECK_RULE_DEFINITIONS);

/** 性質の台帳の受理条件の文を差し込む規則（R-sc-02 の (3) の末尾。Issue #548） */
export const SEMANTIC_CHECK_LEDGER_RULE_ID = "R-sc-02";
/** R-sc-02 の、台帳の文の前（3 つの観点。台帳の行に依らない文） */
const SEMANTIC_CHECK_LEDGER_RULE_HEAD =
  "要件ごとに 3 つを見る：(1) 所属の各行は、この要件を満たすのに必要か（unnecessary-ownership）。(2) この要件を満たすのに必要な対象（項目・計算・集計・操作・画面）が表に無いか（missing-target）。(3) 確かめ方の種類と checks は、要件の決まりを確かめられるか。決まりを含む要件を、在ることだけを見る構造の検査で確かめていれば弱い（weak-verification）。";

/**
 * T1'' の規則の定義（旗 on なら台帳から組む。Issue #548）。省けば今の定数をそのまま返す。渡せば R-sc-02 の文を、
 * 3 つの観点の文 → 台帳の行の受理条件の文（台帳の順）で組み直す（ID・why・since は変えない）。台帳が default-value の
 * 行だけなら off の定数とバイト列で同じになる。
 */
export function semanticCheckRuleDefinitionsOf(ledger?: LedgerView): readonly RuleDefinition[] {
  if (ledger === undefined) return SEMANTIC_CHECK_RULE_DEFINITIONS;
  return SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) =>
    definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID
      ? { ...definition, text: `${SEMANTIC_CHECK_LEDGER_RULE_HEAD}${ledger.t1AcceptanceTexts.join("")}` }
      : definition,
  );
}

/** 判定の並びの JSON Schema（拒否の種類だけが段で違う。T1''・B3' で共有） */
export function judgmentsSchema(kinds: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["judgments"],
    properties: {
      judgments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requirementId", "verdict", "kind", "quote"],
          properties: {
            requirementId: { type: "string" },
            verdict: { type: "string", enum: ["accept", "reject"] },
            kind: { type: ["string", "null"], enum: [...kinds, null], description: "拒否の種類（受理は null）" },
            quote: { type: ["string", "null"], description: "拒否の根拠の引用（受理は null）" },
          },
        },
      },
    },
  } as const;
}

/** T1'' の JSON Schema */
export const SEMANTIC_CHECK_SCHEMA = judgmentsSchema(SEMANTIC_REJECTION_KINDS);

/** 文字列の葉をすべて集める（確定した仕様の引用の照合に使う） */
function stringLeaves(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, into));
  else if (isRecord(value)) Object.values(value).forEach((item) => stringLeaves(item, into));
}

/** 引用を探す元（確定した仕様の文字列・要件の文と引用） */
export function quoteSources(plan: ConfirmedPlan, list: RequirementList): readonly string[] {
  const sources: string[] = [];
  stringLeaves(plan, sources);
  for (const requirement of list.requirements) sources.push(requirement.text, requirement.quote);
  return sources;
}

/**
 * 判定の並びの形と完全性を確かめる（T1''・B3' で共有）。対象の全要件にちょうど 1 判定・拒否は有限の種類と
 * 見つかる引用。合わない欄を**すべて**挙げる（`field` は位置、`message` は固定文。値は埋めない）。通れば
 * **対象の順**に並べ直した判定を返す。`otherBundles`（旗 `v12.ids` の C3 の束だけが渡す。Issue #662）にある要件 ID は
 * 「別の束の要件 ID」の固定文で落とす（省けば今までどおり「点検の対象に無い」）。
 */
export function checkJudgmentsShape(
  output: unknown,
  targets: readonly string[],
  kinds: readonly string[],
  sources: readonly string[],
  otherBundles?: ReadonlySet<string>,
): ShapeCheck<readonly SemanticJudgment[]> {
  if (!isRecord(output)) return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  const raw = output["judgments"];
  if (!Array.isArray(raw)) return { ok: false, problems: [{ field: "judgments", message: "判定は並び（array）であること" }] };
  const problems: Problem[] = [];
  const targetSet = new Set(targets);
  const byId = new Map<string, SemanticJudgment>();
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const field = `judgments[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "判定は写像（object）であること" });
      return;
    }
    const requirementId = item["requirementId"];
    if (typeof requirementId === "string" && otherBundles?.has(requirementId) === true) {
      problems.push({ field: `${field}.requirementId`, message: SEMANTIC_CHECK_BUNDLE_MESSAGES.crossBundle });
      return;
    }
    if (typeof requirementId !== "string" || !targetSet.has(requirementId)) {
      problems.push({ field: `${field}.requirementId`, message: "要件 ID が点検の対象に無い" });
      return;
    }
    if (seen.has(requirementId)) {
      problems.push({ field: `${field}.requirementId`, message: "同じ要件の判定が重なっている" });
      return;
    }
    seen.add(requirementId);
    const verdict = item["verdict"];
    const kind = item["kind"];
    const quote = item["quote"];
    if (verdict === "accept") {
      if (kind !== null || quote !== null) {
        problems.push({ field, message: "受理の判定の種類と引用は null であること" });
        return;
      }
      byId.set(requirementId, { requirementId, verdict: "accept" });
      return;
    }
    if (verdict !== "reject") {
      problems.push({ field: `${field}.verdict`, message: "判定の値は accept・reject のいずれかであること" });
      return;
    }
    let good = true;
    if (typeof kind !== "string" || !kinds.includes(kind)) {
      problems.push({ field: `${field}.kind`, message: `拒否の種類は ${kinds.join("・")} のいずれかであること` });
      good = false;
    }
    if (typeof quote !== "string" || quote.trim() === "") {
      problems.push({ field: `${field}.quote`, message: "拒否には引用が要る" });
      good = false;
    } else if (!sources.some((source) => source.includes(quote))) {
      problems.push({ field: `${field}.quote`, message: "引用が確定した仕様にも要件の文にも無い" });
      good = false;
    }
    if (good) byId.set(requirementId, { requirementId, verdict: "reject", kind: kind as string, quote: quote as string });
  });
  targets.forEach((requirementId, index) => {
    if (!seen.has(requirementId)) problems.push({ field: `requirements[${index}]`, message: "判定が無い要件がある" });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: targets.map((requirementId) => byId.get(requirementId) as SemanticJudgment) };
}

/** T1'' が受け取るもの */
export interface SemanticCheckInput {
  /** 確定した仕様（引用の照合に使う。データには載せない） */
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  /** T1' を通った表 */
  readonly table: NameTable;
  /** J4 の印（`judgeAdviceMarks` の値。省けば空） */
  readonly advice?: readonly JudgeAdviceMarkEntry[];
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** 性質の台帳の導出（旗 `v12.ledger` が on の走りだけが渡す。省けば今の定数。Issue #548） */
  readonly ledger?: LedgerView;
}

/** T1'' の結果（表の SHA-256 に結ぶ完全な結果と、点検の対象の要件 ID） */
export interface SemanticCheckOutput extends SemanticCheckResult {
  readonly targets: readonly string[];
}

/** T1'' の対象（T1 の確かめ方が `unresolved` でない要件。一覧の順） */
export function semanticCheckTargets(list: RequirementList, table: NameTable): readonly string[] {
  const unresolved = new Set(
    table.verification.filter((entry) => entry.kind === "unresolved").map((entry) => entry.requirementId),
  );
  return list.requirements.filter((requirement) => !unresolved.has(requirement.id)).map((requirement) => requirement.id);
}

/**
 * T1'' を 1 回呼ぶ。形・完全性・引用の落ちは共通の窓口が 1 回やり直し、2 回続けば `malformed`。
 * 対象が 0 件なら呼ばずに空の結果を返す（全件持ち越しの停止は A5 が判定する。D15）。
 */
export async function runSemanticCheck(input: SemanticCheckInput): Promise<StageOutcome<SemanticCheckOutput>> {
  const tableSha256 = await nameTableSha256(input.table);
  const targets = semanticCheckTargets(input.list, input.table);
  if (targets.length === 0) return { ok: true, value: { tableSha256, judgments: [], targets } };
  const request = semanticCheckRequest(input, targets, input.gateway);
  const sources = quoteSources(input.plan, input.list);
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkJudgmentsShape(output, targets, SEMANTIC_REJECTION_KINDS, sources),
  });
  if (!answer.ok) return answer;
  return { ok: true, value: { tableSha256, judgments: answer.value, targets } };
}

/**
 * T1'' の要求のデータ（対象の要件の文と引用・**表の全行**・対象の所属・確かめ方・印）。`targets` に入れた要件だけを載せる
 * （旗 `v12.ids` の束はその束の要件だけ。表の行は束で削らない。Issue #662）。対象の全部を渡せば今の要求とバイト列で同じ
 */
function semanticCheckData(input: SemanticCheckInput, targets: readonly string[]): readonly PromptData[] {
  const targetSet = new Set(targets);
  const ofTargets = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => targetSet.has(entry.requirementId));
  return [
    {
      name: "要件の文と引用",
      text: serializeJson(
        input.list.requirements
          .filter((requirement) => targetSet.has(requirement.id))
          .map((requirement) => ({ requirementId: requirement.id, text: requirement.text, quote: requirement.quote })),
      ),
    },
    {
      name: "表の行",
      text: serializeJson(
        input.table.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          entity: row.entity,
          role: row.role,
          type: row.type,
          options: row.options,
          groupBy: row.groupBy,
          refEntity: row.refEntity,
        })),
      ),
    },
    { name: "要件ごとの所属", text: serializeJson(ofTargets(input.table.ownership)) },
    { name: "確かめ方", text: serializeJson(ofTargets(input.table.verification)) },
    { name: "助言の印", text: serializeJson(ofTargets(input.advice ?? [])) },
  ];
}

/** T1'' の要求（規則と schema は静的。データだけが対象で変わる。`extra` は形のやり直しのデータの塊） */
function semanticCheckRequest(
  input: SemanticCheckInput,
  targets: readonly string[],
  gateway: CallGateway,
  extra: readonly PromptData[] = [],
): LlmStructuredRequest {
  return buildStructuredRequest({
    rules: input.ledger === undefined ? SEMANTIC_CHECK_RULES : ruleTexts(semanticCheckRuleDefinitionsOf(input.ledger)),
    documents: input.documents,
    data: [...semanticCheckData(input, targets), ...extra],
    schemaName: SEMANTIC_CHECK_SCHEMA_NAME,
    schema: SEMANTIC_CHECK_SCHEMA,
    maxOutputTokens: gateway.maxOutputTokens("semantic-check"),
  });
}

// ── 旗 `v12.ids` の C3 の束（Issue #662）────────────────────────────────
//
// 対象の要件を一覧の順で 6 件ごとの束に切り、束ごとに 1 つの論理呼び出しにして同時に始める。束の条件は**自分の要件の判定の形**
// だけ（束の要件にちょうど 1 判定・別の束の要件 ID・対象に無い ID・拒否の種類と引用の実在・受理の null。今の検査を束の対象で
// 掛ける）。合併後の条件（全対象にちょうど 1 判定・表の SHA の一致）は走らせる部分が掛ける。
//
// **形のやり直しは段全体で通算 1**（初回と再点検をまたぐ。束ごとに配り直さない）：ある回で形に落ちた束がちょうど 1 つで枠が未使用
// なら、その束だけ 1 回やり直す（前回の応答と問題をデータで。共通の口へ形の再試行として告げる）。2 束以上が同じ回で落ちた・
// 枠を使い切った・やり直しの束がまた落ちた → 追加の要求なく `malformed`。1 束の失敗（形・通信・timeout・締切・予算）を受理で
// 埋めず、一部の束だけで進まない（全束の答えが揃うまで待ち、どれかが失敗なら段の失敗）。

/**
 * 形のやり直しのデータの塊（前回の応答 → 前回の形の問題）。共通の窓口（`callStructuredChecked`）の形のやり直しと同じ名前・同じ
 * 直列化・同じ順で、1 回目の要求の末尾に足すとバイト列で同じ要求になる（前置き・規則・schema は変えない）
 */
function shapeRetryData(output: unknown, problems: readonly Problem[]): readonly PromptData[] {
  const rows = problems.map((problem) => ({
    field: problem.field,
    ...(problem.code === undefined ? {} : { code: problem.code }),
    message: problem.message,
  }));
  return [
    { name: PREVIOUS_RESPONSE_DATA_NAME, text: serializeJson(output).replaceAll("<", "\\u003c") },
    { name: SHAPE_PROBLEMS_DATA_NAME, text: serializeJson(rows) },
  ];
}

/** 束の形の検査の固定文（値を埋めない） */
export const SEMANTIC_CHECK_BUNDLE_MESSAGES = {
  crossBundle: "別の束の要件 ID である（この束で判定するのはデータの要件だけ）",
} as const;

/** 段全体の形のやり直しの枠（初回と再点検をまたいで通算 1。走らせる部分が 1 つ作り、回ごとに渡す） */
export interface SemanticCheckShapeFrame {
  used: boolean;
}

/** 対象の要件を一覧の順で `size` 件ごとの束に切る（最後の束は `size` 未満でよい。対象 0 件なら束 0） */
export function semanticCheckBundles(targets: readonly string[], size: number = V12_C3_BUNDLE.size): readonly (readonly string[])[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("束の大きさは 1 以上の整数であること");
  const bundles: string[][] = [];
  for (let start = 0; start < targets.length; start += size) bundles.push(targets.slice(start, start + size));
  return bundles;
}

/** 並びの各要素に `run` を掛ける。同時に走らせるのは `limit` 本まで（結果は並びの順。どれかが失敗しても残りは走らせ切る） */
export async function mapConcurrently<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Map<number, R>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results.set(index, await run(items[index] as T, index));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return items.map((_, index) => results.get(index) as R);
}

/** 旗 `v12.ids` の C3 の束で回す 1 回の入力 */
export interface SemanticCheckBundledInput extends SemanticCheckInput {
  /** 束の添字 → 口（予算・門・締切・時計は呼ぶ側が共有させる）。省けば全部の束が `gateway` を使う */
  readonly bundleGateway?: (bundle: number) => CallGateway;
  /** 束を同時に始める数の上限（省けば `V12_C3_BUNDLE.concurrency`） */
  readonly bundleConcurrency?: number;
  /** 段全体の形のやり直しの枠（初回と再点検で同じものを渡す） */
  readonly shapeFrame: SemanticCheckShapeFrame;
}

/** 束で回した結果（合併した判定と、束ごとに見せた表の SHA-256） */
export interface SemanticCheckBundledOutput extends SemanticCheckOutput {
  /** 束ごとに見せた表の SHA-256（束の順。合併後に採用した表と照らす） */
  readonly bundleTableSha256s: readonly string[];
}

/** 1 束の 1 回の答え（呼び出しの失敗・形の落ち・形を通った判定） */
type BundleAttempt =
  | { readonly kind: "failure"; readonly failure: StageFailure }
  | { readonly kind: "shape"; readonly output: unknown; readonly problems: readonly Problem[] }
  | { readonly kind: "ok"; readonly judgments: readonly SemanticJudgment[]; readonly tableSha256: string };

/**
 * 旗 `v12.ids` の C3 を束で 1 回（初回か再点検）回す（Issue #662）。対象 0 件なら呼ばずに空の結果を返す（今と同じ）。
 * 対象が 6 件以下なら束 1 つで、要求とデータは今の `runSemanticCheck` とバイト列で同じ。
 */
export async function runSemanticCheckBundled(input: SemanticCheckBundledInput): Promise<StageOutcome<SemanticCheckBundledOutput>> {
  const tableSha256 = await nameTableSha256(input.table);
  const targets = semanticCheckTargets(input.list, input.table);
  if (targets.length === 0) return { ok: true, value: { tableSha256, judgments: [], targets, bundleTableSha256s: [] } };
  const bundles = semanticCheckBundles(targets);
  const sources = quoteSources(input.plan, input.list);
  // 束の口は束を初めて呼ぶときに作る（呼ぶ側が束の開始の時刻をそこで取る）
  const gateways: (CallGateway | undefined)[] = bundles.map(() => undefined);
  const gatewayOf = (bundle: number): CallGateway => {
    const made = gateways[bundle] ?? input.bundleGateway?.(bundle) ?? input.gateway;
    gateways[bundle] = made;
    return made;
  };
  const callBundle = async (bundle: number, retry?: { readonly output: unknown; readonly problems: readonly Problem[] }): Promise<BundleAttempt> => {
    const gateway = gatewayOf(bundle);
    const ids = bundles[bundle] ?? [];
    const inBundle = new Set(ids);
    const otherBundles = new Set(targets.filter((id) => !inBundle.has(id)));
    const request = semanticCheckRequest(input, ids, gateway, retry === undefined ? [] : shapeRetryData(retry.output, retry.problems));
    // 共通の窓口は 1 回だけ呼ぶ（形の落ちは値として受け取り、やり直すかは全束の答えが揃ってから段全体の枠で決める）。束の要求は
    // 待ちを挟まずに組んで呼ぶ（同時に始める）
    const answer = await callStructuredChecked(gateway, {
      request,
      check: (output): ShapeCheck<{ readonly output: unknown; readonly checked: ShapeCheck<readonly SemanticJudgment[]> }> => ({
        ok: true,
        value: { output, checked: checkJudgmentsShape(output, ids, SEMANTIC_REJECTION_KINDS, sources, otherBundles) },
      }),
    });
    if (!answer.ok) return { kind: "failure", failure: answer.failure };
    const { checked } = answer.value;
    if (!checked.ok) return { kind: "shape", output: answer.value.output, problems: checked.problems };
    // 束に見せた表（要求の「表の行」の元）の SHA-256（合併後に採用した表と照らす）
    return { kind: "ok", judgments: checked.value, tableSha256: await nameTableSha256(input.table) };
  };

  const attempts = await mapConcurrently(bundles, input.bundleConcurrency ?? V12_C3_BUNDLE.concurrency, (_, bundle) => callBundle(bundle));
  // 呼び出しの失敗（通信・timeout・締切・予算・門）は束の順で最初のものを段の失敗にする（受理で埋めない・一部で進まない）
  const failed = attempts.find((attempt): attempt is Extract<BundleAttempt, { kind: "failure" }> => attempt.kind === "failure");
  if (failed !== undefined) return { ok: false, failure: failed.failure };
  const shaped = attempts.flatMap((attempt, bundle) => (attempt.kind === "shape" ? [{ bundle, attempt }] : []));
  const located = (bundle: number, problems: readonly Problem[]): readonly Problem[] =>
    bundles.length === 1 ? problems : problems.map((problem) => ({ ...problem, field: `bundles[${String(bundle)}].${problem.field}` }));
  if (shaped.length > 0) {
    const [only] = shaped;
    if (shaped.length > 1 || input.shapeFrame.used || only === undefined) {
      return {
        ok: false,
        failure: { kind: "malformed", attempts: 1, problems: shaped.flatMap((entry) => located(entry.bundle, entry.attempt.problems)) },
      };
    }
    // 形に落ちた束がちょうど 1 つで枠が未使用：その束だけ 1 回やり直す（共通の口へ形の再試行として告げる）
    input.shapeFrame.used = true;
    gatewayOf(only.bundle).noteRetry("shape");
    const retried = await callBundle(only.bundle, { output: only.attempt.output, problems: only.attempt.problems });
    if (retried.kind === "failure") return { ok: false, failure: retried.failure };
    if (retried.kind === "shape") {
      return { ok: false, failure: { kind: "malformed", attempts: STEP_ATTEMPTS, problems: located(only.bundle, retried.problems) } };
    }
    attempts[only.bundle] = retried;
  }
  const answered = attempts.filter((attempt): attempt is Extract<BundleAttempt, { kind: "ok" }> => attempt.kind === "ok");
  if (answered.length !== bundles.length) throw new Error("表の意味の点検：束の答えが揃っていない（回す部分の前提が壊れた）");
  return {
    ok: true,
    value: {
      tableSha256,
      // 束は対象の一覧の順の連続した切れ目なので、束の順につなげば一覧の順になる
      judgments: answered.flatMap((attempt) => attempt.judgments),
      targets,
      bundleTableSha256s: answered.map((attempt) => attempt.tableSha256),
    },
  };
}
