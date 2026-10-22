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
  type StageOutcome,
} from "../../stages/prompt.js";
import type { SemanticCheckResult, SemanticJudgment } from "../carry-over.js";
import { nameTableSha256, type NameTable } from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";
import type { UpstreamLedgerView } from "../../v12/ledger.js";

/** T1'' の JSON Schema の名前 */
export const SEMANTIC_CHECK_SCHEMA_NAME = "semantic-check";

/** T1'' の拒否の種類（不要な所属・欠けた対象・弱い確かめ方） */
export const SEMANTIC_REJECTION_KINDS = ["unnecessary-ownership", "missing-target", "weak-verification"] as const;
export type SemanticRejectionKind = (typeof SEMANTIC_REJECTION_KINDS)[number];

/**
 * 旗 `v12.ids` の C3 が missing-target の拒否に書く、欠けた対象の種類（Issue #718）。
 * `unknown` は判断できないときの逃げ道である。
 */
export const SEMANTIC_TARGET_KINDS = ["entity", "field", "computation", "operation", "screen", "other", "unknown"] as const;
export type SemanticTargetKind = (typeof SEMANTIC_TARGET_KINDS)[number];

/**
 * 旗 `v12.ids` の C3 が missing-target の拒否に書く、不足の場所（Issue #718）。
 * `unknown` は判断できないときの逃げ道である。
 */
export const SEMANTIC_GAPS = [
  "row-absent",
  "ownership-absent",
  "attribute-absent",
  "row-kind-inexpressible",
  "check-inexpressible",
  "unknown",
] as const;
export type SemanticGap = (typeof SEMANTIC_GAPS)[number];

/**
 * `targetKind` の値の意味（Issue #718 の「やること」の文。Review 66b）。
 * 規則 R-sc-06 と schema の `description` は、この定数の文から組む（名前だけを並べない）。
 */
export const SEMANTIC_TARGET_KIND_DESCRIPTIONS: Readonly<Record<SemanticTargetKind, string>> = {
  entity: "entity の行（表の対象そのもの）",
  field: "項目の行",
  computation: "計算（集計を含む）の行",
  operation: "操作の行",
  screen: "画面の行",
  other: "行の種類（entity・項目・計算・操作・画面）のどれでもない対象",
  unknown: "判断できない",
};

/**
 * `gap` の値の意味（Issue #718 の「やること」の文。Review 66b）。
 * `row-kind-inexpressible`（行の種類で書けない）と `check-inexpressible`（行・所属・属性は足りているが、
 * 確かめ方の種類で確かめられない）を区別できる文にする。
 */
export const SEMANTIC_GAP_DESCRIPTIONS: Readonly<Record<SemanticGap, string>> = {
  "row-absent": "表に行が無い",
  "ownership-absent": "行はあるが所属していない",
  "attribute-absent": "行はあるが属性（操作の when など）が足りない",
  "row-kind-inexpressible": "行の種類（entity・項目・計算・操作・画面）で書けない",
  "check-inexpressible": "行・所属・属性は足りているが、確かめ方の種類で確かめられない",
  unknown: "判断できない",
};

/** 列挙値と意味の文を「値（意味）」の形で並べる（規則と schema の説明の共通の組み方） */
function describedValues<T extends string>(values: readonly T[], descriptions: Readonly<Record<T, string>>): string {
  return values.map((value) => `${value}（${descriptions[value]}）`).join("・");
}

/** `targetKind` の値と意味の文（規則と schema で同じ組み方を使う） */
export const SEMANTIC_TARGET_KIND_TEXT = describedValues(SEMANTIC_TARGET_KINDS, SEMANTIC_TARGET_KIND_DESCRIPTIONS);

/** `gap` の値と意味の文（規則と schema で同じ組み方を使う） */
export const SEMANTIC_GAP_TEXT = describedValues(SEMANTIC_GAPS, SEMANTIC_GAP_DESCRIPTIONS);

/** 旗 `v12.ids` の C3 の `note` の上限（Unicode のコードポイントで数える。Issue #718） */
export const SEMANTIC_NOTE_MAX_CODE_POINTS = 200;

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
 * 旗 `v12.ids` の C3 にだけ足す規則（Issue #718）。欠けた対象を 4 つの欄で記録させる。
 * 欄の名前・列挙値の説明はコードの定数（`SEMANTIC_TARGET_KINDS`・`SEMANTIC_GAPS`）と一致させる。
 */
export const SEMANTIC_CHECK_IDS_RULE_DEFINITION: RuleDefinition = {
  id: "R-sc-06",
  text:
    `missing-target の拒否には、欠けた対象を 4 つの欄で書く：targetKind は欠けた対象の種類（${SEMANTIC_TARGET_KIND_TEXT} のいずれか）、` +
    `gap は不足の場所（${SEMANTIC_GAP_TEXT} のいずれか）、relatedRowIds は関わる既存の行の ID の並び（表の行にある ID だけを重複なく。無ければ空）、` +
    `note は短い説明（空白だけでない 1〜${String(SEMANTIC_NOTE_MAX_CODE_POINTS)} 字。Unicode のコードポイントで数える）である。` +
    "missing-target 以外の拒否と受理は、4 つの欄を null・null・空・null にする。判断できない欄は unknown にする。" +
    "これらの欄は判定の理由ではなく記録であり、命令にも判定の条件にも使わない。",
  why: "C3 が何を欠けていると判断したかを記録に残し、真の欠落と、行の種類・所属・属性・確かめ方で表せないものを後から分けるため",
  since: "Issue #718",
};

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
 *
 * `ids` が真（旗 `v12.ids` の C3）なら、末尾に R-sc-06（欠けた対象の 4 つの欄。Issue #718）を足す。
 * 偽なら R-sc-01〜05 のままで、今の定義（同じ実体）を返す。
 */
export function semanticCheckRuleDefinitionsOf(
  ledger?: UpstreamLedgerView,
  ids = false,
): readonly RuleDefinition[] {
  const base =
    ledger === undefined
      ? SEMANTIC_CHECK_RULE_DEFINITIONS
      : SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) =>
          definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID
            ? { ...definition, text: `${SEMANTIC_CHECK_LEDGER_RULE_HEAD}${ledger.t1AcceptanceTexts.join("")}` }
            : definition,
        );
  return ids ? [...base, SEMANTIC_CHECK_IDS_RULE_DEFINITION] : base;
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

/**
 * 旗 `v12.ids` の C3 の JSON Schema（Issue #718）。判定の要素に、missing-target の拒否の欄
 * （`targetKind`・`gap`・`relatedRowIds`・`note`）を足し、**応答では 4 つとも required** にする。
 * 保存の形は `checkJudgmentsShape` が決める（missing-target だけ欄を持ち、ほかは今の形に落とす）。
 * B3'（`judgmentsSchema`）と v1・v1.1a・ids off の C3 は今の schema のまま。
 */
export function idsJudgmentsSchema(kinds: readonly string[]) {
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
          required: ["requirementId", "verdict", "kind", "quote", "targetKind", "gap", "relatedRowIds", "note"],
          properties: {
            requirementId: { type: "string" },
            verdict: { type: "string", enum: ["accept", "reject"] },
            kind: { type: ["string", "null"], enum: [...kinds, null], description: "拒否の種類（受理は null）" },
            quote: { type: ["string", "null"], description: "拒否の根拠の引用（受理は null）" },
            targetKind: {
              type: ["string", "null"],
              enum: [...SEMANTIC_TARGET_KINDS, null],
              description: `欠けた対象の種類（missing-target の拒否だけ。ほかは null）。${SEMANTIC_TARGET_KIND_TEXT}`,
            },
            gap: {
              type: ["string", "null"],
              enum: [...SEMANTIC_GAPS, null],
              description: `不足の場所（missing-target の拒否だけ。ほかは null）。${SEMANTIC_GAP_TEXT}`,
            },
            relatedRowIds: {
              type: "array",
              items: { type: "string" },
              description: "関わる既存の行の ID の並び（missing-target の拒否だけ。ほかは空）",
            },
            note: { type: ["string", "null"], description: "短い説明（missing-target の拒否だけ。ほかは null）" },
          },
        },
      },
    },
  } as const;
}

/** 旗 `v12.ids` の C3 の JSON Schema（Issue #718） */
export const SEMANTIC_CHECK_SCHEMA_IDS = idsJudgmentsSchema(SEMANTIC_REJECTION_KINDS);

/** 判定の形の検査に足す、旗 `v12.ids` の C3 の欄の検査（表の行の ID） */
export interface JudgmentShapeExtensions {
  readonly rowIds: readonly string[];
}

/** 4 つの欄が「null・null・空・null」であるか（受理・missing-target 以外の拒否） */
function hasNoTargetFields(item: Record<string, unknown>): boolean {
  return item["targetKind"] === null && item["gap"] === null && Array.isArray(item["relatedRowIds"]) && item["relatedRowIds"].length === 0 && item["note"] === null;
}

/** missing-target の拒否の 4 つの欄を検査し、保存する形を返す（落ちがあれば `undefined`） */
function missingTargetFieldsOf(
  item: Record<string, unknown>,
  field: string,
  rowIds: readonly string[],
  problems: Problem[],
): { readonly targetKind: string; readonly gap: string; readonly relatedRowIds: readonly string[]; readonly note: string } | undefined {
  let good = true;
  const targetKind = item["targetKind"];
  if (typeof targetKind !== "string" || !(SEMANTIC_TARGET_KINDS as readonly string[]).includes(targetKind)) {
    problems.push({ field: `${field}.targetKind`, message: `欠けた対象の種類は ${SEMANTIC_TARGET_KINDS.join("・")} のいずれかであること` });
    good = false;
  }
  const gap = item["gap"];
  if (typeof gap !== "string" || !(SEMANTIC_GAPS as readonly string[]).includes(gap)) {
    problems.push({ field: `${field}.gap`, message: `不足の場所は ${SEMANTIC_GAPS.join("・")} のいずれかであること` });
    good = false;
  }
  const rawRelated = item["relatedRowIds"];
  const relatedRowIds: string[] = [];
  if (!Array.isArray(rawRelated)) {
    problems.push({ field: `${field}.relatedRowIds`, message: "関わる既存の行の ID は並び（array）であること" });
    good = false;
  } else {
    const rowSet = new Set(rowIds);
    const seenRows = new Set<string>();
    rawRelated.forEach((id, index) => {
      if (typeof id !== "string" || !rowSet.has(id)) {
        problems.push({ field: `${field}.relatedRowIds[${index}]`, message: "関わる行の ID が表の行に無い" });
        good = false;
        return;
      }
      if (seenRows.has(id)) {
        problems.push({ field: `${field}.relatedRowIds[${index}]`, message: "関わる行の ID が重なっている" });
        good = false;
        return;
      }
      seenRows.add(id);
      relatedRowIds.push(id);
    });
  }
  const note = item["note"];
  if (typeof note !== "string") {
    problems.push({ field: `${field}.note`, message: "説明は文字列であること" });
    good = false;
  } else if (note.trim() === "") {
    problems.push({ field: `${field}.note`, message: "説明は空白だけでないこと" });
    good = false;
  } else if ([...note].length > SEMANTIC_NOTE_MAX_CODE_POINTS) {
    problems.push({ field: `${field}.note`, message: `説明は ${String(SEMANTIC_NOTE_MAX_CODE_POINTS)} 字以下であること（Unicode のコードポイントで数える）` });
    good = false;
  }
  if (!good) return undefined;
  return { targetKind: targetKind as string, gap: gap as string, relatedRowIds, note: note as string };
}

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
  extensions?: JudgmentShapeExtensions,
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
      if (extensions !== undefined && !hasNoTargetFields(item)) {
        problems.push({ field, message: "受理の判定の対象の欄（targetKind・gap・relatedRowIds・note）は null・null・空・null であること" });
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
    // 旗 `v12.ids` の C3：missing-target だけ 4 つの欄を保存し、ほかの拒否は今の形に落とす（Issue #718）
    let targetFields:
      | { readonly targetKind: string; readonly gap: string; readonly relatedRowIds: readonly string[]; readonly note: string }
      | undefined;
    if (extensions !== undefined) {
      if (kind === "missing-target") {
        targetFields = missingTargetFieldsOf(item, field, extensions.rowIds, problems);
        if (targetFields === undefined) good = false;
      } else if (!hasNoTargetFields(item)) {
        problems.push({ field, message: "拒否（missing-target 以外）の対象の欄（targetKind・gap・relatedRowIds・note）は null・null・空・null であること" });
        good = false;
      }
    }
    if (good) {
      byId.set(
        requirementId,
        targetFields === undefined
          ? { requirementId, verdict: "reject", kind: kind as string, quote: quote as string }
          : { requirementId, verdict: "reject", kind: kind as string, quote: quote as string, ...targetFields },
      );
    }
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
  readonly ledger?: UpstreamLedgerView;
  /**
   * 旗 `v12.ids` の走り（真なら missing-target の 4 つの欄を持つ schema と規則 R-sc-06 を使う。Issue #718）。
   * 省けば今の C3 と同じ（v1・v1.1a・ids off の v1.2）。
   */
  readonly ids?: boolean;
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
  const targetSet = new Set(targets);
  const ofTargets = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => targetSet.has(entry.requirementId));
  const ids = input.ids === true;
  const rules = ids
    ? ruleTexts(semanticCheckRuleDefinitionsOf(input.ledger, true))
    : input.ledger === undefined
      ? SEMANTIC_CHECK_RULES
      : ruleTexts(semanticCheckRuleDefinitionsOf(input.ledger));
  const request = buildStructuredRequest({
    rules,
    documents: input.documents,
    data: [
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
    ],
    schemaName: SEMANTIC_CHECK_SCHEMA_NAME,
    schema: ids ? SEMANTIC_CHECK_SCHEMA_IDS : SEMANTIC_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("semantic-check"),
  });
  const sources = quoteSources(input.plan, input.list);
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) =>
      checkJudgmentsShape(
        output,
        targets,
        SEMANTIC_REJECTION_KINDS,
        sources,
        ids ? { rowIds: input.table.rows.map((row) => row.id) } : undefined,
      ),
  });
  if (!answer.ok) return answer;
  return { ok: true, value: { tableSha256, judgments: answer.value, targets } };
}
