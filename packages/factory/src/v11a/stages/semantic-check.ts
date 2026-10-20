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
// 旗 `v12.ids` が on の走り（`ids` を渡したとき。Issue #700・#706）は、受理にも根拠を求める**別の契約**で要求する：コードが
// 要件の文と引用を決定的に文に分けて番号を振り（`semanticSentencesOf`。`<要件 ID>:t<n>`・`<要件 ID>:q<n>`）、要件ごとに 3 観点
// （所属・対象・確かめ方）の判定・行 ID・根拠の文の番号を返させる（`SEMANTIC_CHECK_IDS_SCHEMA`。文を写させない）。コードが
// 完全性・番号の実在と当該の要件への所属・行 ID の実在・所属の行の集合との一致を照らしてから（`checkSemanticEvidenceShape`。
// 引用の文字列の照合は使わない）、受理／拒否と種類を観点から導く（`deriveSemanticJudgment`。固定の順 unnecessary-ownership →
// missing-target → weak-verification の最初に当たった観点。引用はその観点の番号から引いた文）。導いた判定は今の
// `SemanticJudgment` の形のままで、観点ごとの根拠（番号のまま）は結果の `evidence` にだけ持つ。規則は R-sc-04 の文だけを
// ids on の文にする。B3' と共有する schema と形の検査の関数（`judgmentsSchema`・`checkJudgmentsShape`）は変えない。
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
import { PROPERTY_LEDGER_VIEW, type LedgerView } from "../../v12/ledger.js";

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

/** 旗 `v12.ids` の走りで文を差し替える規則（観点ごとの根拠の契約。Issue #700・#706） */
export const SEMANTIC_CHECK_IDS_RULE_ID = "R-sc-04";
/**
 * 旗 `v12.ids` の走りの R-sc-04 の文（観点ごとの根拠。受理にも根拠の文の番号が要り、総合の判定はコードが導く。Issue #700 で
 * 引用を写す文にし、#706 で文の番号を写す文にした）
 */
export const SEMANTIC_CHECK_IDS_RULE_TEXT =
  "観点ごとに、見た行の ID・判断・根拠にした文の番号（quoteId）を書く。番号はデータ「要件の文と引用」のその要件の番号をそのまま写し、文そのものを写さない。受理にも番号が要る。所属（ownership）は、その要件の所属の行を全部 examinedRowIds に挙げ、そのうち要件を満たすのに要らない行を unnecessaryRowIds に挙げる。対象（target）は、要件を満たすのに要る対象として表に在る行の ID を presentRowIds に挙げる。要る対象が表に無ければ verdict を missing にし、欠けた対象を名指す文の番号を書く。所属の行を持たない要件でない文は、presentRowIds を空にしてよい。確かめ方（verification）は、checks が確かめる決まりの文の番号を書き、確かめられない決まりがあれば verdict を weak にしてその決まりの文の番号を書く。受理・拒否の総合の判定と拒否の種類は書かない（コードが観点から導く）。";

/** 性質の台帳の受理条件の文を差し込む規則（R-sc-02 の (3) の末尾。Issue #548） */
export const SEMANTIC_CHECK_LEDGER_RULE_ID = "R-sc-02";
/** R-sc-02 の、台帳の文の前（3 つの観点。台帳の行に依らない文） */
const SEMANTIC_CHECK_LEDGER_RULE_HEAD =
  "要件ごとに 3 つを見る：(1) 所属の各行は、この要件を満たすのに必要か（unnecessary-ownership）。(2) この要件を満たすのに必要な対象（項目・計算・集計・操作・画面）が表に無いか（missing-target）。(3) 確かめ方の種類と checks は、要件の決まりを確かめられるか。決まりを含む要件を、在ることだけを見る構造の検査で確かめていれば弱い（weak-verification）。";

/**
 * T1'' の規則の定義（旗 on なら台帳から組む。Issue #548）。省けば今の定数をそのまま返す。渡せば R-sc-02 の文を、
 * 3 つの観点の文 → 台帳の行の受理条件の文（台帳の順）で組み直す（ID・why・since は変えない）。台帳が default-value の
 * 行だけなら off の定数とバイト列で同じになる。`ids`（旗 `v12.ids`）が真なら、R-sc-04 の文を観点ごとの根拠の文にする
 * （ID・why は変えず、since に履歴を足す。Issue #700・#706）。ほかの規則の文と順は変えない。
 */
export function semanticCheckRuleDefinitionsOf(ledger?: LedgerView, ids = false): readonly RuleDefinition[] {
  if (ledger === undefined && !ids) return SEMANTIC_CHECK_RULE_DEFINITIONS;
  return SEMANTIC_CHECK_RULE_DEFINITIONS.map((definition) =>
    ledger !== undefined && definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID
      ? { ...definition, text: `${SEMANTIC_CHECK_LEDGER_RULE_HEAD}${ledger.t1AcceptanceTexts.join("")}` }
      : ids && definition.id === SEMANTIC_CHECK_IDS_RULE_ID
        ? { ...definition, text: SEMANTIC_CHECK_IDS_RULE_TEXT, since: `${definition.since}（旗 v12.ids の観点ごとの根拠の文は #700 で足し、#706 で文の番号を写す文にした）` }
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

// ── 旗 `v12.ids` の観点ごとの根拠の契約（Issue #700・#706）───────────────────────────

/** 文の切れ目（句点は前の文に含め、改行は捨てる。Issue #706） */
export const SEMANTIC_SENTENCE_BREAK = /(?<=。)|\n/;

/** 文に分ける（純粋・決定的。句点と改行で切り、前後の空白を除き、空を捨てる。どの文も元の文の部分文字列。Issue #706） */
export function splitSentences(text: string): readonly string[] {
  return text
    .split(SEMANTIC_SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** 番号つきの文（`<要件 ID>:t<n>` は要件の文、`<要件 ID>:q<n>` は引用。n は 1 から） */
export interface NumberedSentence {
  readonly id: string;
  readonly text: string;
}

/** 1 要件の番号つきの文と引用（データ「要件の文と引用」の ids on の形。Issue #706） */
export interface NumberedRequirementSentences {
  readonly requirementId: string;
  readonly text: readonly NumberedSentence[];
  readonly quote: readonly NumberedSentence[];
}

/** 点検の対象の要件の文と引用に番号を振る（純粋・決定的。一覧の順。同じ一覧からは同じ番号と文。Issue #706） */
export function semanticSentencesOf(list: RequirementList, targets: readonly string[]): readonly NumberedRequirementSentences[] {
  const targetSet = new Set(targets);
  const numbered = (requirementId: string, mark: "t" | "q", text: string): readonly NumberedSentence[] =>
    splitSentences(text).map((sentence, index) => ({ id: `${requirementId}:${mark}${String(index + 1)}`, text: sentence }));
  return list.requirements
    .filter((requirement) => targetSet.has(requirement.id))
    .map((requirement) => ({
      requirementId: requirement.id,
      text: numbered(requirement.id, "t", requirement.text),
      quote: numbered(requirement.id, "q", requirement.quote),
    }));
}

/** 観点ごとの根拠の写像の JSON Schema（全部 required・additionalProperties false・anyOf と nullable を使わない） */
const rowIdsSchema = { type: "array", items: { type: "string" } } as const;
/** 根拠の文の番号の JSON Schema（番号を enum にしない。全段で同じ実体の封筒を送るため。Issue #706） */
const quoteIdSchema = { type: "string", description: "根拠にした文の番号（データ「要件の文と引用」のその要件の番号を写す）" } as const;

/**
 * 旗 `v12.ids` の C3 の JSON Schema（Issue #700・#706）。要件ごとに 3 観点（所属・対象・確かめ方）の判定・行 ID・根拠の文の番号を
 * 持ち、受理／拒否と種類の欄を持たない（コードが観点から導く）
 */
export const SEMANTIC_CHECK_IDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["judgments"],
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "ownership", "target", "verification"],
        properties: {
          requirementId: { type: "string" },
          ownership: {
            type: "object",
            additionalProperties: false,
            required: ["examinedRowIds", "unnecessaryRowIds", "quoteId"],
            properties: {
              examinedRowIds: { ...rowIdsSchema, description: "点検した所属の行の ID（その要件の所属の行の全部）" },
              unnecessaryRowIds: { ...rowIdsSchema, description: "点検した所属の行のうち、要件を満たすのに要らない行の ID" },
              quoteId: quoteIdSchema,
            },
          },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "presentRowIds", "quoteId"],
            properties: {
              verdict: { type: "string", enum: ["present", "missing"] },
              presentRowIds: { ...rowIdsSchema, description: "要件を満たすのに要る対象として表に在る行の ID" },
              quoteId: quoteIdSchema,
            },
          },
          verification: {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "quoteId"],
            properties: {
              verdict: { type: "string", enum: ["sufficient", "weak"] },
              quoteId: quoteIdSchema,
            },
          },
        },
      },
    },
  },
} as const;

/** 1 要件の観点ごとの根拠（応答の写しのまま。番号のまま。診断にだけ書く） */
export interface SemanticEvidence {
  readonly requirementId: string;
  readonly ownership: { readonly examinedRowIds: readonly string[]; readonly unnecessaryRowIds: readonly string[]; readonly quoteId: string };
  readonly target: { readonly verdict: "present" | "missing"; readonly presentRowIds: readonly string[]; readonly quoteId: string };
  readonly verification: { readonly verdict: "sufficient" | "weak"; readonly quoteId: string };
}

/** 番号から引く文（番号 → 所属の要件と文） */
export type SentenceIndex = ReadonlyMap<string, { readonly requirementId: string; readonly text: string }>;

/** 観点ごとの根拠を照らす材料（表と一覧から組む） */
export interface SemanticEvidenceContext {
  /** 点検の対象の要件 ID（一覧の順） */
  readonly targets: readonly string[];
  /** 文の番号の引き表（`semanticSentencesOf` の全部の文） */
  readonly sentences: SentenceIndex;
  /** 要件ごとの所属の行の ID */
  readonly ownedRowIds: ReadonlyMap<string, readonly string[]>;
  /** 表の行の ID */
  readonly tableRowIds: ReadonlySet<string>;
  /** 対象の行を 0 件にしてよい要件（確かめ方が受理で除く性質＝要件でない文） */
  readonly emptyTargetAllowed: ReadonlySet<string>;
}

/** 番号の引き表を組む（純粋） */
export function sentenceIndexOf(numbered: readonly NumberedRequirementSentences[]): SentenceIndex {
  return new Map(
    numbered.flatMap((entry) => [...entry.text, ...entry.quote].map((sentence) => [sentence.id, { requirementId: entry.requirementId, text: sentence.text }] as const)),
  );
}

/** 観点ごとの根拠を照らす材料を組む（純粋。受理で除く確かめ方の種類は台帳から引く。省けばコードの台帳） */
export function semanticEvidenceContextOf(list: RequirementList, table: NameTable, ledger?: LedgerView): SemanticEvidenceContext {
  const excludedKinds = new Set((ledger ?? PROPERTY_LEDGER_VIEW).excludedWhenAcceptedKinds);
  const targets = semanticCheckTargets(list, table);
  return {
    targets,
    sentences: sentenceIndexOf(semanticSentencesOf(list, targets)),
    ownedRowIds: new Map(table.ownership.map((entry) => [entry.requirementId, entry.roles.map((role) => role.id)])),
    tableRowIds: new Set(table.rows.map((row) => row.id)),
    emptyTargetAllowed: new Set(table.verification.filter((entry) => excludedKinds.has(entry.kind)).map((entry) => entry.requirementId)),
  };
}

/** 観点ごとの根拠の形の検査の固定文（値は埋めない。Issue #700・#706） */
export const SEMANTIC_EVIDENCE_MESSAGES = {
  perspective: "観点の写像（object）が無い",
  rowIds: "行の ID は文字列の並び（array）であること",
  examinedMissing: "点検した所属の行に、その要件の所属の行の欠けがある",
  examinedExtra: "点検した所属の行に、その要件の所属の外の行がある",
  examinedDuplicate: "点検した所属の行の ID が重なっている",
  unnecessaryOutside: "不要と判断した行が、点検した所属の行の外にある",
  unnecessaryDuplicate: "不要と判断した行の ID が重なっている",
  targetVerdict: "対象の判断は present・missing のいずれかであること",
  presentUnknown: "対象として挙げた行が表に無い",
  presentDuplicate: "対象として挙げた行の ID が重なっている",
  presentEmpty: "対象が在るとしたのに、表に在る対象の行を 1 つも挙げていない",
  verificationVerdict: "確かめ方の判断は sufficient・weak のいずれかであること",
  quoteIdEmpty: "根拠の文の番号が要る",
  quoteIdUnknown: "根拠の文の番号がデータに無い",
  quoteIdForeign: "根拠の文の番号が他の要件のもの",
} as const;

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const hasDuplicate = (ids: readonly string[]): boolean => new Set(ids).size !== ids.length;

/**
 * 旗 `v12.ids` の C3 の応答の形と根拠を確かめる（Issue #700・#706）。対象の全要件にちょうど 1 判定（`checkJudgmentsShape` と同じ
 * 固定文）・3 観点がそろう・所属の点検が要件の所属の行の集合と一致する（欠け・余分・重複）・不要の行が点検した行の内で重ならない・
 * 対象の行が表に在り重ならない・present なら 1 件以上（要件でない文の要件だけ 0 件を許す）・3 観点の文の番号が空でなく、データに
 * 在り、その要件のもの。引用の文字列の照合は使わない。合わない欄を**すべて**挙げる（`message` は固定文。値は埋めない）。通れば
 * **対象の順**に並べ直した根拠を返す。受理を既定にしない
 */
export function checkSemanticEvidenceShape(output: unknown, context: SemanticEvidenceContext): ShapeCheck<readonly SemanticEvidence[]> {
  if (!isRecord(output)) return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  const raw = output["judgments"];
  if (!Array.isArray(raw)) return { ok: false, problems: [{ field: "judgments", message: "判定は並び（array）であること" }] };
  const problems: Problem[] = [];
  const targetSet = new Set(context.targets);
  const byId = new Map<string, SemanticEvidence>();
  const seen = new Set<string>();
  /** 文の番号を照らす（空・データに無い・他の要件の番号）。通れば true */
  const quoteIdOk = (value: unknown, requirementId: string, field: string): boolean => {
    if (typeof value !== "string" || value.trim() === "") {
      problems.push({ field, message: SEMANTIC_EVIDENCE_MESSAGES.quoteIdEmpty });
      return false;
    }
    const sentence = context.sentences.get(value);
    if (sentence === undefined) {
      problems.push({ field, message: SEMANTIC_EVIDENCE_MESSAGES.quoteIdUnknown });
      return false;
    }
    if (sentence.requirementId !== requirementId) {
      problems.push({ field, message: SEMANTIC_EVIDENCE_MESSAGES.quoteIdForeign });
      return false;
    }
    return true;
  };
  /** 観点の写像を取り出す（無ければ問題を足して undefined） */
  const perspectiveOf = (item: Record<string, unknown>, key: string, field: string): Record<string, unknown> | undefined => {
    const value = item[key];
    if (isRecord(value)) return value;
    problems.push({ field: `${field}.${key}`, message: SEMANTIC_EVIDENCE_MESSAGES.perspective });
    return undefined;
  };
  /** 行の ID の並びを取り出す（文字列の並びでなければ問題を足して undefined） */
  const rowIdsOf = (value: unknown, field: string): readonly string[] | undefined => {
    if (isStringArray(value)) return value;
    problems.push({ field, message: SEMANTIC_EVIDENCE_MESSAGES.rowIds });
    return undefined;
  };
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
    const before = problems.length;

    // (1) 所属：点検した行＝その要件の所属の行の全部（欠け・余分・重複）。不要の行は点検した行の内で重ならない
    const ownership = perspectiveOf(item, "ownership", field);
    let examined: readonly string[] | undefined;
    let unnecessary: readonly string[] | undefined;
    if (ownership !== undefined) {
      examined = rowIdsOf(ownership["examinedRowIds"], `${field}.ownership.examinedRowIds`);
      if (examined !== undefined) {
        const owned = context.ownedRowIds.get(requirementId) ?? [];
        const examinedSet = new Set(examined);
        const ownedSet = new Set(owned);
        const at = `${field}.ownership.examinedRowIds`;
        if (owned.some((id) => !examinedSet.has(id))) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.examinedMissing });
        if (examined.some((id) => !ownedSet.has(id))) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.examinedExtra });
        if (hasDuplicate(examined)) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.examinedDuplicate });
      }
      unnecessary = rowIdsOf(ownership["unnecessaryRowIds"], `${field}.ownership.unnecessaryRowIds`);
      if (unnecessary !== undefined) {
        const at = `${field}.ownership.unnecessaryRowIds`;
        const examinedSet = new Set(examined ?? []);
        if (examined !== undefined && unnecessary.some((id) => !examinedSet.has(id))) {
          problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.unnecessaryOutside });
        }
        if (hasDuplicate(unnecessary)) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.unnecessaryDuplicate });
      }
      quoteIdOk(ownership["quoteId"], requirementId, `${field}.ownership.quoteId`);
    }

    // (2) 対象：判断は present・missing。挙げた行は表に在り重ならない。present は 1 件以上（要件でない文の要件だけ 0 件を許す）
    const target = perspectiveOf(item, "target", field);
    if (target !== undefined) {
      const verdict = target["verdict"];
      if (verdict !== "present" && verdict !== "missing") {
        problems.push({ field: `${field}.target.verdict`, message: SEMANTIC_EVIDENCE_MESSAGES.targetVerdict });
      }
      const present = rowIdsOf(target["presentRowIds"], `${field}.target.presentRowIds`);
      if (present !== undefined) {
        const at = `${field}.target.presentRowIds`;
        if (present.some((id) => !context.tableRowIds.has(id))) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.presentUnknown });
        if (hasDuplicate(present)) problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.presentDuplicate });
        if (verdict === "present" && present.length === 0 && !context.emptyTargetAllowed.has(requirementId)) {
          problems.push({ field: at, message: SEMANTIC_EVIDENCE_MESSAGES.presentEmpty });
        }
      }
      quoteIdOk(target["quoteId"], requirementId, `${field}.target.quoteId`);
    }

    // (3) 確かめ方：判断は sufficient・weak。決まりの文の番号が要る（行 ID は求めない）
    const verification = perspectiveOf(item, "verification", field);
    if (verification !== undefined) {
      const verdict = verification["verdict"];
      if (verdict !== "sufficient" && verdict !== "weak") {
        problems.push({ field: `${field}.verification.verdict`, message: SEMANTIC_EVIDENCE_MESSAGES.verificationVerdict });
      }
      quoteIdOk(verification["quoteId"], requirementId, `${field}.verification.quoteId`);
    }

    if (problems.length !== before || ownership === undefined || target === undefined || verification === undefined) return;
    byId.set(requirementId, {
      requirementId,
      ownership: {
        examinedRowIds: examined as readonly string[],
        unnecessaryRowIds: unnecessary as readonly string[],
        quoteId: ownership["quoteId"] as string,
      },
      target: {
        verdict: target["verdict"] as "present" | "missing",
        presentRowIds: target["presentRowIds"] as readonly string[],
        quoteId: target["quoteId"] as string,
      },
      verification: { verdict: verification["verdict"] as "sufficient" | "weak", quoteId: verification["quoteId"] as string },
    });
  });
  context.targets.forEach((requirementId, index) => {
    if (!seen.has(requirementId)) problems.push({ field: `requirements[${index}]`, message: "判定が無い要件がある" });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: context.targets.map((requirementId) => byId.get(requirementId) as SemanticEvidence) };
}

/**
 * 観点ごとの根拠から判定を導く（純粋。Issue #700・#706）。不要の行が 1 件以上・対象が missing・確かめ方が weak のどれかなら拒否で、
 * 種類は **unnecessary-ownership → missing-target → weak-verification の固定の順で最初に当たった観点**、引用はその観点の番号から
 * 引いた文（`checkSemanticEvidenceShape` を通った番号。原文の部分文字列）。どれも無ければ受理（観点に問題があれば必ず拒否。受理に
 * 寄せない）
 */
export function deriveSemanticJudgment(evidence: SemanticEvidence, sentences: SentenceIndex): SemanticJudgment {
  const { requirementId } = evidence;
  const quoteOf = (quoteId: string): string => {
    const sentence = sentences.get(quoteId);
    if (sentence === undefined) throw new Error(`照らしていない文の番号から判定を導こうとした：${quoteId}`);
    return sentence.text;
  };
  if (evidence.ownership.unnecessaryRowIds.length > 0) {
    return { requirementId, verdict: "reject", kind: "unnecessary-ownership", quote: quoteOf(evidence.ownership.quoteId) };
  }
  if (evidence.target.verdict === "missing") {
    return { requirementId, verdict: "reject", kind: "missing-target", quote: quoteOf(evidence.target.quoteId) };
  }
  if (evidence.verification.verdict === "weak") {
    return { requirementId, verdict: "reject", kind: "weak-verification", quote: quoteOf(evidence.verification.quoteId) };
  }
  return { requirementId, verdict: "accept" };
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
  /** 旗 `v12.ids` が on の走りだけ真。観点ごとの根拠の契約で要求し、判定はコードが導く（省けば今の契約。Issue #700） */
  readonly ids?: boolean;
}

/** T1'' の結果（表の SHA-256 に結ぶ完全な結果と、点検の対象の要件 ID） */
export interface SemanticCheckOutput extends SemanticCheckResult {
  readonly targets: readonly string[];
  /** 旗 `v12.ids` の走りだけ、要件ごとの観点の根拠（対象の順。回ごとの診断にだけ書く。Issue #700） */
  readonly evidence?: readonly SemanticEvidence[];
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
  if (targets.length === 0) return { ok: true, value: { tableSha256, judgments: [], targets, ...(input.ids === true ? { evidence: [] } : {}) } };
  const targetSet = new Set(targets);
  const ofTargets = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => targetSet.has(entry.requirementId));
  // 旗 `v12.ids`：要件の文と引用はコードが文に分けて番号を振った形で見せる（Issue #706）
  const numbered = input.ids === true ? semanticSentencesOf(input.list, targets) : [];
  const request = buildStructuredRequest({
    rules:
      input.ledger === undefined && input.ids !== true
        ? SEMANTIC_CHECK_RULES
        : ruleTexts(semanticCheckRuleDefinitionsOf(input.ledger, input.ids === true)),
    documents: input.documents,
    data: [
      {
        name: "要件の文と引用",
        text: serializeJson(
          input.ids === true
            ? numbered
            : input.list.requirements
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
    schema: input.ids === true ? SEMANTIC_CHECK_IDS_SCHEMA : SEMANTIC_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("semantic-check"),
  });
  if (input.ids === true) {
    // 旗 `v12.ids`：根拠の照合違反は形の落ち（共通の窓口が 1 回やり直し、2 回続けば malformed）。判定は観点から導く（Issue #700・#706）
    const context = semanticEvidenceContextOf(input.list, input.table, input.ledger);
    const answer = await callStructuredChecked(input.gateway, { request, check: (output) => checkSemanticEvidenceShape(output, context) });
    if (!answer.ok) return answer;
    const judgments = answer.value.map((evidence) => deriveSemanticJudgment(evidence, context.sentences));
    return { ok: true, value: { tableSha256, judgments, targets, evidence: answer.value } };
  }
  const sources = quoteSources(input.plan, input.list);
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkJudgmentsShape(output, targets, SEMANTIC_REJECTION_KINDS, sources),
  });
  if (!answer.ok) return answer;
  return { ok: true, value: { tableSha256, judgments: answer.value, targets } };
}
