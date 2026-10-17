// T1 名前の表（07-architecture-v1.1a.md §1・§2.1・D9・D10。Issue #507）。
//
// 宣言で使う名前を test planner で 1 度だけ固定する表を、LLM に**1 回の呼び出し**で書かせる。応答は
// 構造化出力（schema 名 `name-table`）で受け、2 段で確かめる：
//
//   1. **形**（`checkNameTableResponseShape`）… 応答の骨組み（写像・`rows`・`requirements` が写像の並び）。
//      落ちは共通の窓口（`callStructuredChecked`・`STEP_ATTEMPTS`）が 1 回やり直し、2 回続けば `malformed`
//   2. **T1'**（A1 の `inspectNameTable`）… 下書きの形・要件 ID の付け方（一覧の順と写しの照合）・表の検査。
//      落ちれば `unmet`（`attempts` 1。問題は A1 の固定文）
//
// **中身の 2 回目は呼ぶ側（A5）が回す**（`NAME_TABLE_ROUNDS`）。呼ぶ側は任意の `previous` に、前回の候補
// （raw の応答）・前回の作り直しの指示（問題）・T1'' の拒否・J4 の印を渡し、この段はそれを**この順で**データの
// 塊として `input` の末尾に足す。前置き（`instructions`・`documents`・`rules`・schema・`maxOutputTokens`）は
// 1 文字も変えない。中身のやり直しを共通の口へ告げる（`noteRetry("content")`）のも、回す側の仕事である。
//
// 要件 ID は**応答に書かせない**（D10）。要件の一覧のデータには、要件ごとに**コードが切った写し**（`copy`。
// `requirementCopy(text, copyLengthFor(list))`）・要件の文（`text`）・依頼文の引用（`requestQuote`）を並べ、
// モデルには写しをそのまま写させる——文字数を数えさせない（v1.1α の比較で、モデルは写しの長さを数えられず
// 全文や別の長さを写した。#505・#507）。照合は今までどおり完全一致で、応答の要件ごとの並びに、A1 の関数が
// 一覧の順で要件 ID を付ける。行の出典の引用は、写しが指す要件の文か依頼文の引用の部分文字列なら受ける
// （A1 の `isSourceQuoteOf`。依頼文の引用は、要件の文の引用と取り違えないよう `requestQuote` の名で載せる）。
// 要件ごとの分類（`nature`）は**要件の文から**分類させる——確定した仕様のデータから Plan の `kind` を外して
// 渡す（試験も見せない。T2 が独立に分類し、食い違いは J2 が裁く。§1.1）。
//
// 応答の `type` は、strict の schema に載せるため**欄を並べた写像**（`fieldType`・`valueType`・`scope`・
// `form`・`action`・`hasWhen`・`view`）で受け、行の種類に合う欄だけを A1 の型（`NameTableRowType`）へ写して
// から T1' に掛ける。種類に合わない欄が null でなければ T1' の落ちに足す（黙って捨てない）。
import { ACTION_KINDS, VIEW_TYPES, type ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import { REQUIREMENT_NATURES, STRUCTURAL_ASSERTIONS } from "../../fixed-test.js";
import { ROLE_OWNERSHIP_BASES, type RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  constraintIdsIn,
  isRecord,
  ruleTexts,
  serializeJson,
  shapeRejectedCandidate,
  withReference,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RejectedCandidate,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
} from "../../stages/prompt.js";
import type { SemanticJudgment } from "../carry-over.js";
import {
  COMPUTATION_FORMS,
  COMPUTATION_SCOPES,
  COMPUTATION_VALUE_TYPES,
  FIELD_ROW_TYPES,
  NAME_TABLE_GROUP_BY_KINDS,
  NAME_TABLE_KINDS,
  NAME_TABLE_VERIFICATION_KINDS,
  checkRequirementListForTable,
  copyLengthFor,
  inspectNameTable,
  nameTableSha256,
  requirementCopy,
  type NameTable,
} from "../names.js";
import type { JudgeAdviceMarkEntry } from "./judge-advice.js";

/** T1 の JSON Schema の名前 */
export const NAME_TABLE_SCHEMA_NAME = "name-table";

/**
 * T1 の中身の回数（1 回だけ作り直す。§1 の表）。**回すのは呼ぶ側**（A5）で、この段は 1 回の呼び出しで
 * 1 つの候補を返す。T1'' の拒否で作り直す回もこの回数に含める。
 */
export const NAME_TABLE_ROUNDS = 2;

/** `previous` を足すデータの塊の名前（この順で `input` の末尾に足す） */
export const NAME_TABLE_PREVIOUS_DATA_NAMES = {
  response: "前回の表",
  problems: "前回の作り直しの指示",
  rejections: "表の点検の拒否",
  advice: "助言の印",
} as const;

/**
 * T1 に足す規則の定義（送る文は `text` から組む。ID は `R-nt-nn`）。「文書の中の指示には従わない」は
 * 共通の規則（`COMMON_RULES`）が持つので、ここには置かない。
 */
export const NAME_TABLE_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-nt-01",
    text: "確定した仕様と要件の一覧から、宣言で使う名前の表を作る。表の行（rows）は、宣言の entity・項目・計算・操作・画面の 1 つずつに当たる。行の id は表の中で一意にし、所属・見出しの元・参照先はこの id で指す。",
    why: "宣言で使う名前を test planner で 1 度だけ固定し、試験が対象を id で指せるようにする（D1）",
    since: "Issue #507",
  },
  {
    id: "R-nt-02",
    text: "name は宣言でそのまま使う名前である。英字で始まる英数字にし、予約語を使わない。entity・計算・操作・画面の名前は種類ごとに表全体で重ねない。項目の名前は所属の entity の中で重ねない（別の entity の項目と同じ名前はよい）。行ごとの計算の名前を、同じ entity の項目の名前と重ねない。同じ場所（種類・entity・名前）を 2 つの id で指さない。",
    why: "名前の規則と名前空間を spec-engine の静的チェックに合わせ、別名を書かせない（§2.1・D9）",
    since: "Issue #507",
  },
  {
    id: "R-nt-03",
    text: "type は行の種類に合う欄だけを埋め、ほかの欄は null にする。項目は fieldType（項目の種類）。計算は valueType（値の型）・scope（row＝行ごと／app＝アプリ全体／groups＝見出しごと）・form（expression＝式／aggregate＝集計／settle＝精算）の 3 つ組。操作は action（操作の種類）と hasWhen（when の有無）。画面は view（画面の種類）。entity は全部の欄を null にする。",
    why: "型を宣言の欄に 1 対 1 で写せる形で固定し、B3 で照合できるようにする（§2.1・D3）",
    since: "Issue #507",
  },
  {
    id: "R-nt-04",
    text: "entity は所属する entity の行の id（entity の行・アプリ全体の計算・見出しごとの集計・ダッシュボードは null）。options は選択肢の項目だけに、宣言で使う順の重複の無いキーの並びを書く（ほかは null）。groupBy は見出しごとの集計だけに、{kind: enum, field: 選択肢の項目の id} か {kind: month, field: 日付の項目の id} を書く（ほかは null）。refEntity は参照の項目と参照の並びだけに、参照先の entity の id を書く（ほかは null）。",
    why: "参照・選択肢・見出しの元・参照先を表の id で書かせ、T1' で照合できるようにする（§2.1）",
    since: "Issue #507",
  },
  {
    id: "R-nt-05",
    text: "role は、その行が要件に対して何をするかを 1 文で書く役割の説明である。source は出典である。source.copy には、その行を求める要件の、要件の一覧の copy を 1 文字も変えずにそのまま写す。source.quote には、その要件の text か requestQuote の一部を 1 文字も変えずに写す（言い換えない。別の要件の text・requestQuote から写さない）。",
    why: "名前と分けて意味を持たせ、T1''・T2 が名前を見ずに点検・試験できるようにする（§2.1・§2.3）。写しはコードが渡し、引用は依頼文の引用からも受ける（#505・#507）",
    since: "Issue #507（写しと引用の受け方は #505・#507 の比較の観測で改めた）",
  },
  {
    id: "R-nt-06",
    text: "requirements には、要件の一覧の要件ごとに 1 件ずつ、一覧と同じ順で並べる。要件 ID は書かない。各件の copy には、一覧のその要件の copy を 1 文字も変えずにそのまま写す（text の全文や、自分で切った長さを書かない）。",
    why: "要件 ID を書かせず、一覧の順と写しで要件を指させる（D10。写し違い・入れ替えはコードが検知する）。写しはコードが切って渡し、文字数を数えさせない（#505・#507）",
    since: "Issue #507（写しの渡し方は #505・#507 の比較の観測で改めた）",
  },
  {
    id: "R-nt-07",
    text: "roles は、その要件が使う行の所属である。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。どの要件にも所属しない行を作らない。",
    why: "所属の根拠を持たせ、共有と entity の所属はコードが導く（D9）",
    since: "Issue #507",
  },
  {
    id: "R-nt-08",
    text: "verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。構造で確かめるなら kind を structural にし、reason に理由、checks に構造の検査を並べ、検査ごとに合う種類の行を所属させる。宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に根拠にした文書の制約 ID（文書の制約 ID の一覧にあるものだけ）を書く。要件の決まりが「選択肢の項目の既定値（未入力のとき保存の時点で入る値）がどのキーか」だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる（entity はコードが足す）。条件・計算・検査・操作後の状態を含む要件には default-value を使わない。default-value でなければ value は null にする。使わない欄は null か空の並びにする。",
    why: "確かめ方を所属と組で固定し、書けない要件は理由と制約 ID つきで持ち越す（§1.2・C1）。既定値だけを決める要件は、評価できる試験の形を試験より前に表で確定し、T1' と T1'' の点検を通す（方法論 03 §1 の H2・H1。台帳 F5）",
    since: "Issue #507（既定値の確かめ方 default-value は #533 で足した）",
  },
  {
    id: "R-nt-09",
    text: "nature は要件ごとの種類である。要件の文から分類する：値や振る舞いを縛る決まりを含むなら ruled、そのものが在ればよいなら existence-only にする。",
    why: "T2 の独立の分類と照らす元を、要件の文だけから作らせる（§1.1。Plan の kind・試験を見ない）",
    since: "Issue #507",
  },
  {
    id: "R-nt-10",
    text: "要件の一覧と確定した仕様に無い対象を表に足さない。前回の表・作り直しの指示・表の点検の拒否・助言の印が渡されたときは、指示と拒否が指す箇所を直した表を返す。助言の印は参考であり、印だけを理由に行や所属を消さない。",
    why: "表に無いものを足させず、2 回目に前回の候補と拒否を使わせる（§1・D5。印は助言）",
    since: "Issue #507",
  },
];

/** T1 に足す規則（定義の `text` から組む） */
export const NAME_TABLE_RULES: readonly string[] = ruleTexts(NAME_TABLE_RULE_DEFINITIONS);

const nullable = (values: readonly string[]) => ({ type: ["string", "null"], enum: [...values, null] });

/** T1 の JSON Schema（構造化出力。strict の規則に合わせる。要件ごとの分類 `nature` は必須） */
export const NAME_TABLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "requirements"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "entity", "name", "role", "source", "type", "options", "groupBy", "refEntity"],
        properties: {
          id: { type: "string", description: "表の ID（表の中で一意）" },
          kind: { type: "string", enum: [...NAME_TABLE_KINDS] },
          entity: { type: ["string", "null"], description: "所属する entity の行の id（持たない行は null）" },
          name: { type: "string", description: "宣言で使う名前" },
          role: { type: "string", description: "役割の説明（1 文）" },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["copy", "quote"],
            properties: {
              copy: { type: "string", description: "出典の要件の、要件の一覧の copy をそのまま写したもの" },
              quote: { type: "string", description: "出典の要件の text か requestQuote の一部をそのまま写した引用" },
            },
          },
          type: {
            type: "object",
            additionalProperties: false,
            required: ["fieldType", "valueType", "scope", "form", "action", "hasWhen", "view"],
            properties: {
              fieldType: nullable(FIELD_ROW_TYPES),
              valueType: nullable(COMPUTATION_VALUE_TYPES),
              scope: nullable(COMPUTATION_SCOPES),
              form: nullable(COMPUTATION_FORMS),
              action: nullable(ACTION_KINDS),
              hasWhen: { type: ["boolean", "null"] },
              view: nullable(VIEW_TYPES),
            },
          },
          options: { type: ["array", "null"], items: { type: "string" } },
          groupBy: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["kind", "field"],
            properties: {
              kind: { type: "string", enum: [...NAME_TABLE_GROUP_BY_KINDS] },
              field: { type: "string", description: "見出しの元の項目の id" },
            },
          },
          refEntity: { type: ["string", "null"], description: "参照先の entity の id" },
        },
      },
    },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["copy", "roles", "verification", "nature"],
        properties: {
          copy: { type: "string", description: "要件の一覧の、この要件の copy をそのまま写したもの" },
          roles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "basis", "reason"],
              properties: {
                id: { type: "string" },
                basis: { type: "string", enum: [...ROLE_OWNERSHIP_BASES] },
                reason: { type: ["string", "null"] },
              },
            },
          },
          verification: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason", "checks", "constraintIds", "value"],
            properties: {
              kind: { type: "string", enum: [...NAME_TABLE_VERIFICATION_KINDS] },
              reason: { type: ["string", "null"] },
              checks: { type: "array", items: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] } },
              constraintIds: { type: "array", items: { type: "string" } },
              value: { type: ["string", "null"], description: "default-value の期待する既定値のキー（ほかの種類は null）" },
            },
          },
          nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
        },
      },
    },
  },
} as const;

/** T1'' の拒否 1 件（A1 の `SemanticJudgment` の拒否の側） */
export type SemanticRejection = Extract<SemanticJudgment, { readonly verdict: "reject" }>;

/** 前回の候補と、作り直しの材料（呼ぶ側が 2 回目に渡す） */
export interface NameTablePrevious {
  /** 前回の候補（形の検査に掛けた raw の応答） */
  readonly response: unknown;
  /** 前回の作り直しの指示（T1' の問題。T1'' の拒否で作り直すときは空でよい） */
  readonly problems: readonly Problem[];
  /** T1'' の拒否（要件 ID は、渡すときに要件の文の写しへ置き換える） */
  readonly rejections: readonly SemanticRejection[];
  /** J4 の印（要件 ID は、渡すときに要件の文の写しへ置き換える） */
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** T1 が受け取るもの */
export interface NameTableInput {
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  readonly previous?: NameTablePrevious;
  /**
   * 断った候補（形と中身）を、断った時点で 1 候補につき 1 回受け取る観測用の口（#501 の作法）。**省けば
   * 何もしない**——口の有無で、送る要求・検査・やり直しの回数・結果は変わらない。
   */
  readonly onRejected?: (candidate: RejectedCandidate) => void;
}

/** T1 の結果（表・表の SHA-256・形の検査に掛けた raw の応答） */
export interface NameTableOutput {
  readonly table: NameTable;
  readonly tableSha256: string;
  readonly response: unknown;
}

/**
 * T1 の結果。失敗の側は `StageOutcome` と同じで、**中身（T1'）で断ったときだけ** raw の応答を持つ
 * （呼ぶ側が 2 回目の `previous.response` に渡す）。
 */
export type NameTableOutcome =
  | { readonly ok: true; readonly value: NameTableOutput }
  | { readonly ok: false; readonly failure: StageFailure; readonly response?: unknown };

/** 形の検査（応答の骨組み）。合わない欄を**すべて**挙げる。値は埋めない */
export function checkNameTableResponseShape(output: unknown): ShapeCheck<Record<string, unknown>> {
  if (!isRecord(output)) return { ok: false, problems: [{ field: "", message: "名前の表は写像（object）であること" }] };
  const problems: Problem[] = [];
  for (const key of ["rows", "requirements"] as const) {
    const items = output[key];
    if (!Array.isArray(items)) {
      problems.push({ field: key, message: "並び（array）であること" });
      continue;
    }
    items.forEach((item, index) => {
      if (!isRecord(item)) problems.push({ field: `${key}[${index}]`, message: "写像（object）であること" });
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: output };
}

/** 行の種類ごとに、応答の `type` の写像から使う欄 */
const TYPE_KEYS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  entity: [],
  field: ["fieldType"],
  computation: ["valueType", "scope", "form"],
  operation: ["action", "hasWhen"],
  screen: ["view"],
};
const TYPE_KEYS = ["fieldType", "valueType", "scope", "form", "action", "hasWhen", "view"] as const;

/**
 * 応答の `type`（欄を並べた写像）を、行の種類に合う A1 の型へ写す。種類に合わない欄が null でなければ
 * 問題に足す。`type` が写像でない（すでに A1 の形の文字列・null）・種類が知らない値のときは写さない
 * （A1 の検査が形の落ちにする）。
 */
export function toNameTableDraftValue(output: Record<string, unknown>): {
  readonly value: Record<string, unknown>;
  readonly problems: readonly Problem[];
} {
  const problems: Problem[] = [];
  const rows = (output["rows"] as readonly unknown[]).map((item, index) => {
    if (!isRecord(item)) return item;
    const kind = item["kind"];
    const type = item["type"];
    const used = typeof kind === "string" ? TYPE_KEYS_BY_KIND[kind] : undefined;
    if (used === undefined || !isRecord(type)) return item;
    const extra = TYPE_KEYS.some((key) => !used.includes(key) && type[key] !== undefined && type[key] !== null);
    if (extra) problems.push({ field: `rows[${index}].type`, message: "行の種類に合わない型の欄が null でない" });
    let converted: unknown;
    switch (kind) {
      case "entity":
        converted = null;
        break;
      case "field":
        converted = type["fieldType"];
        break;
      default:
        converted = Object.fromEntries(used.map((key) => [key, type[key]]));
    }
    return { ...item, type: converted };
  });
  return { value: { ...output, rows }, problems };
}

/** 確定した仕様から、要件の Plan の `kind` を外す（分類を要件の文から作らせる。§1.1） */
export function planWithoutRequirementKinds(plan: ConfirmedPlan): unknown {
  return {
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      const { kind: _kind, ...rest } = requirement;
      return rest;
    }),
  };
}

/** データの塊 1 つに、`<` を JSON の Unicode エスケープへ置き換えて raw の応答を入れる（共通の窓口と同じ区切り） */
function rawResponseText(output: unknown): string {
  return serializeJson(output).replaceAll("<", "\\u003c");
}

function copyByRequirementId(list: RequirementList, length: number): ReadonlyMap<string, string> {
  return new Map(list.requirements.map((requirement) => [requirement.id, requirementCopy(requirement.text, length)]));
}

function copyOf(copies: ReadonlyMap<string, string>, requirementId: string): string {
  const copy = copies.get(requirementId);
  if (copy === undefined) throw new Error("名前の表：前回の拒否・助言の印の要件 ID が一覧に無い");
  return copy;
}

/** T1 の要求のデータ（確定した仕様・要件の一覧・文書。`previous` があればこの順で 4 塊を足す） */
function buildData(input: NameTableInput, length: number): readonly PromptData[] {
  const data: PromptData[] = [
    { name: "確定した仕様", text: serializeJson(planWithoutRequirementKinds(input.plan)) },
    {
      name: "要件の一覧",
      text: serializeJson({
        requirements: input.list.requirements.map((requirement) => ({
          copy: requirementCopy(requirement.text, length),
          text: requirement.text,
          requestQuote: requirement.quote,
        })),
      }),
    },
    {
      name: "文書",
      text: serializeJson({
        names: input.documents.map((document) => document.name),
        constraintIds: [...constraintIdsIn(input.documents)],
      }),
    },
  ];
  const previous = input.previous;
  if (previous !== undefined) {
    const copies = copyByRequirementId(input.list, length);
    data.push({ name: NAME_TABLE_PREVIOUS_DATA_NAMES.response, text: rawResponseText(previous.response) });
    data.push({ name: NAME_TABLE_PREVIOUS_DATA_NAMES.problems, text: serializeJson(previous.problems) });
    data.push({
      name: NAME_TABLE_PREVIOUS_DATA_NAMES.rejections,
      text: serializeJson(
        previous.rejections.map((rejection) => ({
          copy: copyOf(copies, rejection.requirementId),
          kind: rejection.kind,
          quote: rejection.quote,
        })),
      ),
    });
    data.push({
      name: NAME_TABLE_PREVIOUS_DATA_NAMES.advice,
      text: serializeJson(
        previous.advice.map((entry) => ({ copy: copyOf(copies, entry.requirementId), id: entry.id, mark: entry.mark })),
      ),
    });
  }
  return data;
}

/**
 * T1 を 1 回呼ぶ。形の落ちは共通の窓口が 1 回やり直し（2 回続けば `malformed`）、T1'（A1 の
 * `inspectNameTable`）に落ちれば `unmet`（`attempts` 1）。全文が同じ要件が一覧にあれば、呼ばずに
 * `unmet`（`attempts` 0）にする（表を見る前に落とす。D10）。
 */
export async function runNameTable(input: NameTableInput): Promise<NameTableOutcome> {
  const listProblems = checkRequirementListForTable(input.list);
  const length = copyLengthFor(input.list);
  if (listProblems.length > 0 || length === null) {
    return { ok: false, failure: { kind: "unmet", attempts: 0, problems: listProblems } };
  }
  const round = input.previous === undefined ? 1 : 2;
  const request = buildStructuredRequest({
    rules: NAME_TABLE_RULES,
    documents: input.documents,
    data: buildData(input, length),
    schemaName: NAME_TABLE_SCHEMA_NAME,
    schema: NAME_TABLE_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("name-table"),
  });
  let shapeRejections = 0;
  const onRejected = input.onRejected;
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: checkNameTableResponseShape,
    ...(onRejected === undefined
      ? {}
      : {
          onShapeRejected: (rejection) => {
            shapeRejections += 1;
            onRejected(shapeRejectedCandidate(round, rejection));
          },
        }),
  });
  if (!answer.ok) return answer;

  const converted = toNameTableDraftValue(answer.value);
  const inspected = inspectNameTable(input.list, converted.value, input.documents);
  const problems = [...converted.problems, ...(inspected.ok ? [] : inspected.problems)];
  if (inspected.ok && problems.length === 0) {
    return {
      ok: true,
      value: { table: inspected.table, tableSha256: await nameTableSha256(inspected.table), response: answer.output },
    };
  }
  onRejected?.({
    kind: "content",
    round,
    attempt: shapeRejections + 1,
    target: converted.value,
    response: answer.output,
    inspectionList: input.list,
    problems: withReference(problems, "target"),
  });
  return { ok: false, failure: { kind: "unmet", attempts: 1, problems }, response: answer.output };
}
