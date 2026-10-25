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
// 旗 `v12.ids` が on の走り（`ids` を渡したとき。Issue #732）は、R-sc-02 の 3 つの観点の文のあとに、構造の検査の種類の意味と
// targets の読み方の文（`v12/structural-meanings.ts` の表から組む）を置く。組む順は 3 つの観点 → 種類の意味 → 受理条件の文
// （台帳 on なら台帳の文）。拒否の種類・schema・完全性と引用の検査・対象・データは変えない。ids off は今の文とバイト列で同じ。
//
// 旗 `v12.ids` が on の走りは、さらに対象を要件 5 件ごとの束に分けて同時に呼ぶ（Issue #735。T2 の束と同じ大きさと同時数）。判定は
// 要件ごとに独立なので、1 回の大きな呼び出しを待たない。規則・文書・schema・表の行は束で同じで、要件の塊だけを束の要件にする。
// 束ごとに今の形の検査を掛け、合併した判定に全体の完全性を掛ける。形のやり直しは 2 回の点検を通じて段全体で束の数（k）まで
// （2026-10-24 所有者の決定）。ids off は今の 1 回の呼び出しのまま。
//
// 束が 2 つ以上の要求は、束の外の対象の要件（文と引用・所属・確かめ方・助言の印）を「参照のみ」の塊で渡し、その読み方の規則
// （`SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION`）を 1 つ足す（Issue #741）。ある要件の判定にほかの要件の文・所属が要ることがあり、
// 束に絞ると材料が欠けるため。関係する要件だけをコードで選ぶと取りこぼすので、束の外の対象を全部渡す。判定の対象・形の検査は
// 変えない（束の外の要件の判定は今の束の形の検査で落ちる）。束が 1 つの要求は今とバイト列で同じ。
//
// **完全性と引用の実在はコードが形として確かめる**（`checkJudgmentsShape`。B3' と共有）：対象の全要件に
// ちょうど 1 判定。欠落・重複・未知の要件 ID・確定した仕様にも要件の文にも見つからない引用・引用の無い拒否は
// 形の落ちで、共通の窓口が 1 回やり直し、2 回続けば `malformed`（点検していない状態で先へ進まない）。
// **受理を既定にしない**——欠落を受理で埋めない。結果は表の SHA-256 に結ぶ。
//
// 見せるもの：要件の文と引用・表の行（**`name` の欄は見せない**。`role`・`kind`・`type`・`options`・`groupBy`・
// `refEntity` は見せる）・所属・確かめ方・J4 の印。**試験・期待・合否・名前を見せない。** T1 の確かめ方が
// `unresolved` の要件は対象から除く（データにも応答の必須にも入れない）。J4 の印は助言で、判定を変えない（D5）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import type { RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  type Problem,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
  type StageOutcome,
} from "../../stages/prompt.js";
import type { SemanticCheckResult, SemanticJudgment } from "../carry-over.js";
import { nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import type { UpstreamLedgerView } from "../../v12/ledger.js";
import { STRUCTURAL_MEANINGS, structuralReadingText, type StructuralMeaningTable } from "../../v12/structural-meanings.js";
import { V12_T2_BUNDLE } from "../../v12/limits.js";
import { bundleRequirementIds } from "../../v12/test-cases.js";

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

/**
 * 旗 `v12.ids` の束が 2 つ以上の要求にだけ足す規則（Issue #741）。R-sc-01〜05 の共通の定義には入れない（束が 1 つの要求と旗 off の
 * 要求の規則は今のまま）
 */
export const SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION: RuleDefinition = {
  id: "R-sc-06",
  text: "データの「ほかの要件（参照のみ。判定しない）」の要件は、判定の材料（必要な対象が表に揃っているか・所属が正しいかを見るための、ほかの要件の文と所属）に使ってよいが、その要件の判定を返さない。判定の対象は、データの「要件の文と引用」の要件だけである。",
  why: "C3 を束に分けると、束の外の要件を参照する要件の判定の材料が欠ける。束の外の対象を参照のみで渡し、判定の対象は束の要件のまま保つ（方法論 03 の H3）",
  since: "Issue #741",
};

/** 束の外の対象を渡すデータの塊の名前（旗 `v12.ids` の束が 2 つ以上の要求だけ。Issue #741） */
export const SEMANTIC_CHECK_REFERENCE_DATA_NAME = "ほかの要件（参照のみ。判定しない）";

/** T1'' に足す規則（定義の `text` から組む） */
export const SEMANTIC_CHECK_RULES: readonly string[] = ruleTexts(SEMANTIC_CHECK_RULE_DEFINITIONS);

/** 性質の台帳の受理条件の文を差し込む規則（R-sc-02 の (3) の末尾。Issue #548） */
export const SEMANTIC_CHECK_LEDGER_RULE_ID = "R-sc-02";
/** R-sc-02 の、台帳の文の前（3 つの観点。台帳の行に依らない文） */
const SEMANTIC_CHECK_LEDGER_RULE_HEAD =
  "要件ごとに 3 つを見る：(1) 所属の各行は、この要件を満たすのに必要か（unnecessary-ownership）。(2) この要件を満たすのに必要な対象（項目・計算・集計・操作・画面）が表に無いか（missing-target）。(3) 確かめ方の種類と checks は、要件の決まりを確かめられるか。決まりを含む要件を、在ることだけを見る構造の検査で確かめていれば弱い（weak-verification）。";

/** R-sc-02 の、3 つの観点の文のあとの受理条件の文（台帳 off の定数の文。default-value の受理条件） */
const SEMANTIC_CHECK_ACCEPTANCE_TAIL = (() => {
  const text = SEMANTIC_CHECK_RULE_DEFINITIONS.find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID)?.text ?? "";
  if (!text.startsWith(SEMANTIC_CHECK_LEDGER_RULE_HEAD)) throw new Error("R-sc-02 の文が 3 つの観点の文で始まらない");
  return text.slice(SEMANTIC_CHECK_LEDGER_RULE_HEAD.length);
})();

/**
 * T1'' の規則の定義（旗 on なら台帳から組む。Issue #548）。台帳を省き ids も off なら今の定数をそのまま返す。台帳を渡せば
 * R-sc-02 の文を、3 つの観点の文 → 台帳の行の受理条件の文（台帳の順）で組み直す（ID・why・since は変えない）。台帳が
 * default-value の行だけなら off の定数とバイト列で同じになる。
 * `ids` が真なら（旗 `v12.ids`。Issue #732）、3 つの観点の文のあとに構造の検査の読み方の文（`meanings` の表から組む）を
 * 置き、そのあとに受理条件の文（台帳を渡せば台帳の文、省けば今の default-value の文）を続ける。
 */
export function semanticCheckRuleDefinitionsOf(
  ledger?: UpstreamLedgerView,
  ids = false,
  meanings: StructuralMeaningTable = STRUCTURAL_MEANINGS,
): readonly RuleDefinition[] {
  if (ledger === undefined && !ids) return SEMANTIC_CHECK_RULE_DEFINITIONS;
  const reading = ids ? structuralReadingText(meanings) : "";
  const acceptance = ledger === undefined ? SEMANTIC_CHECK_ACCEPTANCE_TAIL : ledger.t1AcceptanceTexts.join("");
  return SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) =>
    definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID
      ? {
          ...definition,
          text: `${SEMANTIC_CHECK_LEDGER_RULE_HEAD}${reading}${acceptance}`,
          ...(ids ? { since: `${definition.since}。旗 v12.ids の走りの構造の検査の読み方は #732 で足した` } : {}),
        }
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
 * **対象の順**に並べ直した判定を返す。
 */
export function checkJudgmentsShape(
  output: unknown,
  targets: readonly string[],
  kinds: readonly string[],
  sources: readonly string[],
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

/**
 * 旗 `v12.ids` の C3 の形のやり直しの予算（Issue #735。2026-10-24 所有者の決定）。2 回の点検（round）を通じて段全体で `limit` 回まで、
 * 同じ round の 1 つの束につき 1 回まで（後者は共通の窓口の試行 2 回で効く）。`limit` は要件の一覧の数を束の大きさで割った束の数
 * （k）で、C3 の論理の最大は初回 k ＋ 再点検 k ＋ 形 k の 3k になる。`used` は使った順に、どの round のどの束（0 から）が使ったか
 */
export interface SemanticShapeRetryBudget {
  readonly limit: number;
  readonly used: { readonly round: number; readonly bundle: number }[];
}

/** 形のやり直しの予算を作る（k＝要件の一覧の数を `V12_T2_BUNDLE.size` で割って切り上げた数。round を通じて 1 つを渡す） */
export function semanticShapeRetryBudgetOf(list: RequirementList): SemanticShapeRetryBudget {
  return { limit: Math.ceil(list.requirements.length / V12_T2_BUNDLE.size), used: [] };
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
  readonly ledger?: UpstreamLedgerView;
  /**
   * 構造の検査の読み方を R-sc-02 に足す（旗 `v12.ids` が on の走りだけが真で渡す。省けば今の文。Issue #732）。真の走りは、対象を
   * 一覧の順に `V12_T2_BUNDLE.size` 件ごとの束に切り、束を同時に呼ぶ（Issue #735）
   */
  readonly ids?: boolean;
  /** 旗 `v12.ids` の点検の回（1 から。形のやり直しの予算の記録に使う。省けば 1。Issue #735） */
  readonly round?: number;
  /**
   * 旗 `v12.ids` の形のやり直しの予算（2 回の点検で同じものを渡す。省けば、この呼び出しだけの新しい予算。Issue #735）
   */
  readonly shapeRetries?: SemanticShapeRetryBudget;
  /** 旗 `v12.ids` の束を同時に始める数の上限（省けば `V12_T2_BUNDLE.concurrency`。試験が順序に依らないことを確かめる。Issue #735） */
  readonly bundleConcurrency?: number;
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

/** 束の判定の合併の問題（固定文。値を埋めない。Issue #735） */
export const SEMANTIC_MERGE_MESSAGES = {
  unknown: "要件 ID が点検の対象に無い",
  duplicate: "同じ要件の判定が重なっている",
  missing: "判定が無い要件がある",
} as const;

/**
 * 束の判定を合併し、全体の完全性（対象の全要件にちょうど 1 判定・対象に無い要件 ID が無い）を確かめる（Issue #735）。束の検査を
 * 通った判定の並びでも、ここで改めて確かめる。通れば**対象の順**に並べ直した判定を返す
 */
export function mergeSemanticJudgments(
  targets: readonly string[],
  bundles: readonly (readonly SemanticJudgment[])[],
): ShapeCheck<readonly SemanticJudgment[]> {
  const targetSet = new Set(targets);
  const byId = new Map<string, SemanticJudgment>();
  const problems: Problem[] = [];
  bundles.forEach((judgments, bundle) => {
    judgments.forEach((judgment, index) => {
      const field = `bundles[${String(bundle)}].judgments[${String(index)}].requirementId`;
      if (!targetSet.has(judgment.requirementId)) problems.push({ field, message: SEMANTIC_MERGE_MESSAGES.unknown });
      else if (byId.has(judgment.requirementId)) problems.push({ field, message: SEMANTIC_MERGE_MESSAGES.duplicate });
      else byId.set(judgment.requirementId, judgment);
    });
  });
  targets.forEach((requirementId, index) => {
    if (!byId.has(requirementId)) problems.push({ field: `requirements[${String(index)}]`, message: SEMANTIC_MERGE_MESSAGES.missing });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: targets.map((requirementId) => byId.get(requirementId) as SemanticJudgment) };
}

/** 束の結果（判定か段の失敗か例外） */
type SemanticBundleResult =
  | { readonly kind: "ok"; readonly judgments: readonly SemanticJudgment[] }
  | { readonly kind: "failed"; readonly failure: StageFailure }
  | { readonly kind: "thrown"; readonly error: unknown };

/**
 * T1'' を 1 回呼ぶ。形・完全性・引用の落ちは共通の窓口が 1 回やり直し、2 回続けば `malformed`。
 * 対象が 0 件なら呼ばずに空の結果を返す（全件持ち越しの停止は A5 が判定する。D15）。
 *
 * 旗 `v12.ids` の走り（Issue #735）は、対象を一覧の順に `V12_T2_BUNDLE.size` 件ごとの束に切り、束ごとに 1 つの要求にする
 * （要件の文と引用・所属・確かめ方・助言の印はその束の要件だけ、表の行は全行。対象が 1〜5 件なら要求は 1 つで今とバイト列で同じ）。
 * 束は `V12_T2_BUNDLE.concurrency` 本まで同時に始め、同じ口（予算・門・締切・時計・単価・effort・timeout と口の計を共有）で呼ぶ。
 * 束の形の検査は今の `checkJudgmentsShape` をその束の対象で掛け、形のやり直しは予算（`shapeRetries`）が残るときだけ使う。どれか
 * 1 つの束が落ちても、全部の束の終わりを待ってから、一覧の順で最初に落ちた束の失敗を段の失敗にする（ほかの束の判定を採らない。
 * T2 の束と同じ）。全部の束が通れば合併して全体の完全性を確かめる。
 */
export async function runSemanticCheck(input: SemanticCheckInput): Promise<StageOutcome<SemanticCheckOutput>> {
  const tableSha256 = await nameTableSha256(input.table);
  const targets = semanticCheckTargets(input.list, input.table);
  if (targets.length === 0) return { ok: true, value: { tableSha256, judgments: [], targets } };
  const rules =
    input.ledger === undefined && input.ids !== true
      ? SEMANTIC_CHECK_RULES
      : ruleTexts(semanticCheckRuleDefinitionsOf(input.ledger, input.ids === true));
  const sources = quoteSources(input.plan, input.list);
  if (input.ids !== true) {
    const answer = await callStructuredChecked(input.gateway, {
      request: semanticCheckRequest(input, rules, targets),
      check: (output) => checkJudgmentsShape(output, targets, SEMANTIC_REJECTION_KINDS, sources),
    });
    if (!answer.ok) return answer;
    return { ok: true, value: { tableSha256, judgments: answer.value, targets } };
  }

  const round = input.round ?? 1;
  const shapeRetries = input.shapeRetries ?? semanticShapeRetryBudgetOf(input.list);
  const bundles = bundleRequirementIds(targets, V12_T2_BUNDLE.size);
  // 束が 2 つ以上なら、束の外の対象を参照のみで渡し、その読み方の規則を足す（Issue #741。束が 1 つなら今の要求のまま）
  const bundleRules = bundles.length > 1 ? [...rules, ...ruleTexts([SEMANTIC_CHECK_REFERENCE_RULE_DEFINITION])] : rules;
  const callBundle = async (bundle: number): Promise<SemanticBundleResult> => {
    const bundleTargets = bundles[bundle] ?? [];
    let attempt = 0;
    let refused: readonly Problem[] | undefined;
    const check = (output: unknown): ShapeCheck<readonly SemanticJudgment[]> => {
      attempt += 1;
      const checked = checkJudgmentsShape(output, bundleTargets, SEMANTIC_REJECTION_KINDS, sources);
      if (checked.ok || attempt > 1) return checked;
      // 形のやり直しは段全体の予算が残るときだけ（残らなければ再試行せずに形の落ちで断る。共通の窓口は変えない）
      if (shapeRetries.used.length < shapeRetries.limit) {
        shapeRetries.used.push({ round, bundle });
        return checked;
      }
      refused = checked.problems;
      return { ok: true, value: [] };
    };
    const references = bundles.length > 1 ? targets.filter((id) => !bundleTargets.includes(id)) : undefined;
    const answer = await callStructuredChecked(input.gateway, {
      request: semanticCheckRequest(input, bundleRules, bundleTargets, references),
      check,
    });
    if (!answer.ok) return { kind: "failed", failure: answer.failure };
    if (refused !== undefined) return { kind: "failed", failure: { kind: "malformed", attempts: 1, problems: refused } };
    return { kind: "ok", judgments: answer.value };
  };

  const results: (SemanticBundleResult | undefined)[] = bundles.map(() => undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < bundles.length) {
      const bundle = next;
      next += 1;
      let result: SemanticBundleResult;
      try {
        result = await callBundle(bundle);
      } catch (error) {
        result = { kind: "thrown", error };
      }
      results[bundle] = result;
    }
  };
  const concurrency = input.bundleConcurrency ?? V12_T2_BUNDLE.concurrency;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, bundles.length)) }, worker));
  // 一覧の順で最初に落ちた束（例外を含む）を段の結果にする（完了の順に依らない）
  for (const result of results) {
    if (result === undefined || result.kind === "ok") continue;
    if (result.kind === "thrown") throw result.error;
    return { ok: false, failure: result.failure };
  }
  const merged = mergeSemanticJudgments(
    targets,
    results.map((result) => (result?.kind === "ok" ? result.judgments : [])),
  );
  if (!merged.ok) return { ok: false, failure: { kind: "malformed", attempts: 1, problems: merged.problems } };
  return { ok: true, value: { tableSha256, judgments: merged.value, targets } };
}

/**
 * T1'' の要求（`targets` の要件だけのデータ。表の行は全行。旗 off と対象 5 件以下の ids on は今の要求とバイト列で同じ）。
 * `references` を渡せば（旗 `v12.ids` の束が 2 つ以上。Issue #741）、その要件の文と引用・所属・確かめ方・助言の印を、束の塊と同じ形・
 * 一覧の順で「参照のみ」の塊 1 つにまとめて末尾に足す
 */
function semanticCheckRequest(
  input: SemanticCheckInput,
  rules: readonly string[],
  targets: readonly string[],
  references?: readonly string[],
) {
  const requirementsOf = (ids: ReadonlySet<string>) =>
    input.list.requirements
      .filter((requirement) => ids.has(requirement.id))
      .map((requirement) => ({ requirementId: requirement.id, text: requirement.text, quote: requirement.quote }));
  const entriesOf = <T extends { readonly requirementId: string }>(ids: ReadonlySet<string>, entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => ids.has(entry.requirementId));
  const targetSet = new Set(targets);
  const ofTargets = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] => entriesOf(targetSet, entries);
  const referenceSet = new Set(references ?? []);
  const referenceData =
    references === undefined
      ? []
      : [
          {
            name: SEMANTIC_CHECK_REFERENCE_DATA_NAME,
            text: serializeJson({
              要件の文と引用: requirementsOf(referenceSet),
              要件ごとの所属: entriesOf(referenceSet, input.table.ownership),
              確かめ方: entriesOf(referenceSet, input.table.verification),
              助言の印: entriesOf(referenceSet, input.advice ?? []),
            }),
          },
        ];
  return buildStructuredRequest({
    rules,
    documents: input.documents,
    data: [
      { name: "要件の文と引用", text: serializeJson(requirementsOf(targetSet)) },
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
      ...referenceData,
    ],
    schemaName: SEMANTIC_CHECK_SCHEMA_NAME,
    schema: SEMANTIC_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("semantic-check"),
  });
}
