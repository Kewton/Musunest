// v1.1α の名前の表（T1 の出力・T1' の検査。07-architecture-v1.1a.md §2.1・D1・D3・D9・D10。Issue #505）。
//
// 名前の表は、**宣言で使う名前を test planner で 1 度だけ固定する**ための契約である。行は表の `id`
// （全体で一意。試験が対象を指す鍵。D1）・種類・所属 entity・宣言の名前・役割の説明・出典・型・選択肢・
// 見出しの元・参照先を持ち、行の外に要件ごとの所属（根拠つき）・確かめ方・分類を持つ。
//
// ここは **LLM を呼ばない純粋な関数**だけを置く（形・一意・名前の規則・参照・所属の fail-closed・要件 ID の
// 付け方・分類・導く欄・SHA-256）。T1 の段そのもの（プロンプト・呼び出し）は別の Issue（A2）が持つ。
//
// 要件 ID は**応答に書かせない**（D10）。T1 の応答（下書き `NameTableDraft`）は要件ごとの並びを**一覧の順**に
// 持ち、各要素に要件の文の写し（先頭の `copyLengthFor` 文字）を添える。コードが一覧の順で要件 ID を付け、
// 写しと照合する（入れ替え・取り違えの検知）。行の出典も写しで要件を指す。写しは**コードが切って T1 の
// データに載せ**、モデルはそれをそのまま写す（文字数を数えさせない。#505・#507）。行の出典の引用は、写しが
// 指す要件の文か、その要件の依頼文の引用（`Requirement.quote`）の部分文字列であること（`isSourceQuoteOf`）。
//
// `Problem` の `field` は位置（配列の添字）、`message` は**分類ごとの固定文**である——表の ID・名前・
// 要件 ID の値を埋めない（停止の要約と段の失敗の記録に写るため。v1 の `checkDesignOwnership` と同じ規律）。
//
// 導く欄（LLM に書かせない。D9）：
//   - 項目・計算・操作・画面を所属させた要件には、その所属 entity の行を basis `dependency`・reason に
//     導いた行の `id` を添えて足す（`deriveOwnership`）
//   - `shared` は所属の数（2 以上）から導く（`sharedRowIds`）。`aliasOf` は持たない（同じ場所を指す 2 つの
//     `id` は検査で落とす）
import {
  ACTION_KINDS,
  COMPUTED_TYPES,
  NAME_PATTERN,
  RESERVED_NAMES,
  VIEW_TYPES,
  type ActionKind,
  type ComputedType,
  type FieldKind,
  type ViewType,
} from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import {
  REQUIREMENT_NATURES,
  STRUCTURAL_ASSERTIONS,
  STRUCTURAL_FIELD_KINDS,
  STRUCTURAL_TARGET_KINDS,
  TEST_TARGET_KINDS,
  type RequirementNature,
  type StructuralAssertionKind,
  type TestTargetKind,
} from "../fixed-test.js";
import { ROLE_OWNERSHIP_BASES, type Requirement, type RequirementList, type RoleOwnershipBasis } from "../pipeline.js";
import {
  constraintIdsIn,
  isRecord,
  normalizeConstraintId,
  type Problem,
  type PromptDocument,
  type ShapeCheck,
} from "../stages/prompt.js";

// ── 型の値の一覧（D3。B3 の照合先は A5）────────────────────────────────

/** 表の行の種類（v1 の役割の表と同じ 5 種。`validation` は段階 2。D3） */
export const NAME_TABLE_KINDS = TEST_TARGET_KINDS;
export type NameTableKind = TestTargetKind;

/** 項目の型（`FieldKind`。宣言の項目の種類に 1 対 1） */
export const FIELD_ROW_TYPES: readonly FieldKind[] = STRUCTURAL_FIELD_KINDS;

/** 計算の値の型（`ComputedType`。宣言の `type`） */
export const COMPUTATION_VALUE_TYPES = COMPUTED_TYPES;

/**
 * 計算の範囲。`row` … 行ごと（`entity` を持つ）、`app` … アプリ全体（`scope: app`）、`groups` … 見出しごと
 * （`entity` も `scope` も持たない）。宣言の `entity`・`scope` の有無に 1 対 1。
 */
export const COMPUTATION_SCOPES = ["row", "app", "groups"] as const;
export type ComputationScope = (typeof COMPUTATION_SCOPES)[number];

/** 計算の種別。宣言の `expression`・`aggregate`・`settle` の欄の有無に 1 対 1 */
export const COMPUTATION_FORMS = ["expression", "aggregate", "settle"] as const;
export type ComputationForm = (typeof COMPUTATION_FORMS)[number];

/** 計算の型（値の型・範囲・種別の 3 つ組。§2.1） */
export interface ComputationRowType {
  readonly valueType: ComputedType;
  readonly scope: ComputationScope;
  readonly form: ComputationForm;
}

/** 操作の型（操作の種類と `when` の有無） */
export interface OperationRowType {
  readonly action: ActionKind;
  readonly hasWhen: boolean;
}

/** 画面の型（画面の種類） */
export interface ScreenRowType {
  readonly view: ViewType;
}

/** 行の型。entity は null、項目は `FieldKind`、計算・操作・画面は上の組 */
export type NameTableRowType = FieldKind | ComputationRowType | OperationRowType | ScreenRowType | null;

/** 見出しの元（enum の項目の値ごと／date の項目の月ごと）。表の `id` で項目を指す */
export type NameTableGroupBy =
  | { readonly kind: "enum"; readonly field: string }
  | { readonly kind: "month"; readonly field: string }
  | null;

export const NAME_TABLE_GROUP_BY_KINDS = ["enum", "month"] as const;

// ── 表の型 ────────────────────────────────────────────────────────

/**
 * 出典（要件 ID と引用）。引用は、その要件の文か依頼文の引用（`Requirement.quote`）の部分文字列である
 * （`isSourceQuoteOf`）。要件の文の中の位置は `sourcePositionOf` がコードで求める。
 */
export interface NameTableSource {
  readonly requirementId: string;
  readonly quote: string;
}

/** 表の 1 行 */
export interface NameTableRow {
  /** 表の ID（全体で一意。試験が対象を指す鍵。D1） */
  readonly id: string;
  readonly kind: NameTableKind;
  /** 所属 entity の `id`（entity 自身・アプリ全体の計算・見出しごとの集計・ダッシュボードは null） */
  readonly entity: string | null;
  /** 宣言で使う名前（`NAME_PATTERN` を満たし予約語でない） */
  readonly name: string;
  /** 要件に結んだ役割の説明（1 文） */
  readonly role: string;
  readonly source: NameTableSource;
  readonly type: NameTableRowType;
  /** 選択肢のキーの並び（enum の項目だけ。ほかは null） */
  readonly options: readonly string[] | null;
  readonly groupBy: NameTableGroupBy;
  /** 参照先 entity の `id`（参照の項目・参照の並びだけ。ほかは null） */
  readonly refEntity: string | null;
}

/** 所属の 1 件（根拠つき。basis・reason の形は v1 の `RoleOwnership` と同じ） */
export interface NameTableRoleOwnership {
  readonly id: string;
  readonly basis: RoleOwnershipBasis;
  /** `stated` は null、`dependency` は空でない文 */
  readonly reason: string | null;
}

/** 要件ごとの所属 */
export interface NameTableOwnership {
  readonly requirementId: string;
  readonly roles: readonly NameTableRoleOwnership[];
}

/**
 * 要件ごとの確かめ方（fixed-test／structural＋checks／unresolved＋reason＋constraintIds）。
 * structural の `reason` は v1 の `RequirementVerification` と同じ（fixed-test 以外は理由が要る）。
 */
export type NameTableVerification =
  | { readonly requirementId: string; readonly kind: "fixed-test" }
  | {
      readonly requirementId: string;
      readonly kind: "structural";
      readonly reason: string;
      readonly checks: readonly StructuralAssertionKind[];
    }
  | {
      readonly requirementId: string;
      readonly kind: "unresolved";
      readonly reason: string;
      readonly constraintIds: readonly string[];
    };

/** 要件ごとの分類（T1 が要件の文から分類する。Plan の `kind` から導かない。T2 の分類と照らす元。§1.1） */
export interface NameTableClassification {
  readonly requirementId: string;
  readonly nature: RequirementNature;
}

/** 名前の表（行と、行の外の所属・確かめ方・分類） */
export interface NameTable {
  readonly rows: readonly NameTableRow[];
  readonly ownership: readonly NameTableOwnership[];
  readonly verification: readonly NameTableVerification[];
  readonly classification: readonly NameTableClassification[];
}

// ── 下書き（T1 の応答。要件 ID を持たない。D10）──────────────────────

/** 下書きの出典（要件の文の写しと引用） */
export interface NameTableDraftSource {
  readonly copy: string;
  readonly quote: string;
}

export interface NameTableDraftRow extends Omit<NameTableRow, "source"> {
  readonly source: NameTableDraftSource;
}

type WithoutRequirementId<T> = T extends unknown ? Omit<T, "requirementId"> : never;
export type NameTableDraftVerification = WithoutRequirementId<NameTableVerification>;

/** 下書きの要件ごとの 1 件（**一覧の順**に並べ、要件の文の写しを添える） */
export interface NameTableDraftRequirement {
  readonly copy: string;
  readonly roles: readonly NameTableRoleOwnership[];
  readonly verification: NameTableDraftVerification;
  readonly nature: RequirementNature;
}

export interface NameTableDraft {
  readonly rows: readonly NameTableDraftRow[];
  readonly requirements: readonly NameTableDraftRequirement[];
}

// ── 要件の文の写し（D10）────────────────────────────────────────────

/**
 * 写しの最短の長さ（文字数。コードポイントで数える）。一覧の中で一意になる長さがこれより短くても、ここまでは
 * 写させる——1〜2 文字の写しは、別の要件の文を書いたことを見分けにくいからである。文がこれより短い要件は全文。
 */
export const MIN_COPY_LENGTH = 8;

const codePoints = (text: string): readonly string[] => Array.from(text);

/** 要件の文の先頭 `length` 文字（コードポイント）。文が短ければ全文 */
export function requirementCopy(text: string, length: number): string {
  return codePoints(text).slice(0, length).join("");
}

/**
 * 写しの長さを決める（D10）。一覧の全要件の先頭 `L` 文字が互いに異なる最小の `L`（`MIN_COPY_LENGTH` 以上）。
 * 全文が同じ要件が 2 つあれば、どの長さでも一意にならないので `null` を返す（表を見る前に落とす）。
 */
export function copyLengthFor(list: RequirementList): number | null {
  const texts = list.requirements.map((requirement) => requirement.text);
  if (new Set(texts).size !== texts.length) return null;
  const longest = Math.max(0, ...texts.map((text) => codePoints(text).length));
  for (let length = 1; length <= longest; length += 1) {
    const copies = texts.map((text) => requirementCopy(text, length));
    if (new Set(copies).size === copies.length) return Math.max(length, MIN_COPY_LENGTH);
  }
  return Math.max(longest, MIN_COPY_LENGTH);
}

/**
 * 出典の引用が、その要件の文か依頼文の引用（`Requirement.quote`）の部分文字列か（#505・#507）。完全一致の
 * 部分文字列だけを受ける——正規化しない（空白・記号・言い換えを吸収しない）。別の要件の文・引用は見ない。
 */
export function isSourceQuoteOf(requirement: Requirement, quote: string): boolean {
  return quote !== "" && (requirement.text.includes(quote) || requirement.quote.includes(quote));
}

/** 全文が同じ要件を挙げる（表を見る前に落とす。Plan 側の重複。D10） */
export function checkRequirementListForTable(list: RequirementList): readonly Problem[] {
  const problems: Problem[] = [];
  const firstIndexOf = new Map<string, number>();
  list.requirements.forEach((requirement, index) => {
    if (firstIndexOf.has(requirement.text)) {
      problems.push({ field: `requirements[${index}]`, message: "全文が同じ要件が一覧にある（写しで要件を区別できない）" });
    } else {
      firstIndexOf.set(requirement.text, index);
    }
  });
  return problems;
}

// ── (a) 下書きの形 ────────────────────────────────────────────────

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function shapeOfType(kind: NameTableKind, value: unknown, field: string, problems: Problem[]): NameTableRowType | undefined {
  switch (kind) {
    case "entity":
      if (value !== null) {
        problems.push({ field, message: "entity の行の型は null であること" });
        return undefined;
      }
      return null;
    case "field":
      if (!isOneOf(FIELD_ROW_TYPES, value)) {
        problems.push({ field, message: `項目の型は ${FIELD_ROW_TYPES.join("・")} のいずれかであること` });
        return undefined;
      }
      return value;
    case "computation": {
      if (!isRecord(value)) {
        problems.push({ field, message: "計算の型は「値の型・範囲・種別」の写像であること" });
        return undefined;
      }
      let good = true;
      if (!isOneOf(COMPUTATION_VALUE_TYPES, value["valueType"])) {
        problems.push({ field: `${field}.valueType`, message: `計算の値の型は ${COMPUTATION_VALUE_TYPES.join("・")} のいずれかであること` });
        good = false;
      }
      if (!isOneOf(COMPUTATION_SCOPES, value["scope"])) {
        problems.push({ field: `${field}.scope`, message: `計算の範囲は ${COMPUTATION_SCOPES.join("・")} のいずれかであること` });
        good = false;
      }
      if (!isOneOf(COMPUTATION_FORMS, value["form"])) {
        problems.push({ field: `${field}.form`, message: `計算の種別は ${COMPUTATION_FORMS.join("・")} のいずれかであること` });
        good = false;
      }
      if (!good) return undefined;
      return {
        valueType: value["valueType"] as ComputedType,
        scope: value["scope"] as ComputationScope,
        form: value["form"] as ComputationForm,
      };
    }
    case "operation": {
      if (!isRecord(value)) {
        problems.push({ field, message: "操作の型は「操作の種類・when の有無」の写像であること" });
        return undefined;
      }
      let good = true;
      if (!isOneOf(ACTION_KINDS, value["action"])) {
        problems.push({ field: `${field}.action`, message: `操作の種類は ${ACTION_KINDS.join("・")} のいずれかであること` });
        good = false;
      }
      if (typeof value["hasWhen"] !== "boolean") {
        problems.push({ field: `${field}.hasWhen`, message: "when の有無は真偽であること" });
        good = false;
      }
      if (!good) return undefined;
      return { action: value["action"] as ActionKind, hasWhen: value["hasWhen"] as boolean };
    }
    case "screen": {
      if (!isRecord(value) || !isOneOf(VIEW_TYPES, value["view"])) {
        problems.push({ field, message: `画面の型は、画面の種類（${VIEW_TYPES.join("・")}）の写像であること` });
        return undefined;
      }
      return { view: value["view"] as ViewType };
    }
  }
}

function shapeOfGroupBy(value: unknown, field: string, problems: Problem[]): NameTableGroupBy | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isOneOf(NAME_TABLE_GROUP_BY_KINDS, value["kind"]) || !isNonEmptyString(value["field"])) {
    problems.push({ field, message: "見出しの元は null か、enum・month の種類と項目の ID の写像であること" });
    return undefined;
  }
  return { kind: value["kind"], field: value["field"] } as NameTableGroupBy;
}

function shapeOfOptions(value: unknown, field: string, problems: Problem[]): readonly string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    problems.push({ field, message: "選択肢は null か、空でない文字列の並びであること" });
    return undefined;
  }
  return value as readonly string[];
}

function shapeOfNullableId(value: unknown, field: string, problems: Problem[]): string | null | undefined {
  if (value === null) return null;
  if (!isNonEmptyString(value)) {
    problems.push({ field, message: "ID は空でない文字列か null であること" });
    return undefined;
  }
  return value;
}

function shapeOfRow(value: unknown, field: string, problems: Problem[]): NameTableDraftRow | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "行は写像（object）であること" });
    return undefined;
  }
  const before = problems.length;
  const id = value["id"];
  if (!isNonEmptyString(id)) problems.push({ field: `${field}.id`, message: "表の ID は空でない文字列であること" });
  const kind = value["kind"];
  const kindOk = isOneOf(NAME_TABLE_KINDS, kind);
  if (!kindOk) problems.push({ field: `${field}.kind`, message: `行の種類は ${NAME_TABLE_KINDS.join("・")} のいずれかであること` });
  const entity = shapeOfNullableId(value["entity"], `${field}.entity`, problems);
  const name = value["name"];
  if (typeof name !== "string") problems.push({ field: `${field}.name`, message: "名前は文字列であること" });
  const role = value["role"];
  if (!isNonEmptyString(role)) problems.push({ field: `${field}.role`, message: "役割の説明は空でない文字列であること" });
  const source = value["source"];
  if (!isRecord(source) || !isNonEmptyString(source["copy"]) || !isNonEmptyString(source["quote"])) {
    problems.push({ field: `${field}.source`, message: "出典は「要件の文の写し・引用」の写像であること" });
  }
  const type = kindOk ? shapeOfType(kind, value["type"], `${field}.type`, problems) : undefined;
  const options = shapeOfOptions(value["options"], `${field}.options`, problems);
  const groupBy = shapeOfGroupBy(value["groupBy"], `${field}.groupBy`, problems);
  const refEntity = shapeOfNullableId(value["refEntity"], `${field}.refEntity`, problems);
  if (problems.length !== before) return undefined;
  const src = source as Record<string, unknown>;
  return {
    id: id as string,
    kind: kind as NameTableKind,
    entity: entity as string | null,
    name: name as string,
    role: role as string,
    source: { copy: src["copy"] as string, quote: src["quote"] as string },
    type: type as NameTableRowType,
    options: options as readonly string[] | null,
    groupBy: groupBy as NameTableGroupBy,
    refEntity: refEntity as string | null,
  };
}

function shapeOfRoleOwnership(value: unknown, field: string, problems: Problem[]): NameTableRoleOwnership | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "所属は「表の ID・根拠・理由」の写像であること" });
    return undefined;
  }
  const before = problems.length;
  const id = value["id"];
  if (!isNonEmptyString(id)) problems.push({ field: `${field}.id`, message: "所属の表の ID は空でない文字列であること" });
  const basis = value["basis"];
  const basisOk = isOneOf(ROLE_OWNERSHIP_BASES, basis);
  if (!basisOk) problems.push({ field: `${field}.basis`, message: `所属の根拠は ${ROLE_OWNERSHIP_BASES.join("・")} のいずれかであること` });
  const reason = value["reason"];
  if (basisOk && basis === "dependency") {
    if (!isNonEmptyString(reason)) {
      problems.push({ field: `${field}.reason`, message: "依存の所属には理由（reason）が要る（空でない文字列）" });
    }
  } else if (basisOk && reason !== null) {
    problems.push({ field: `${field}.reason`, message: "名指し（stated）の所属の理由は null であること" });
  }
  if (problems.length !== before) return undefined;
  return { id: id as string, basis: basis as RoleOwnershipBasis, reason: typeof reason === "string" ? reason : null };
}

function shapeOfVerification(value: unknown, field: string, problems: Problem[]): NameTableDraftVerification | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "確かめ方は写像（object）であること" });
    return undefined;
  }
  const kind = value["kind"];
  if (kind === "fixed-test") return { kind };
  if (kind === "structural") {
    const before = problems.length;
    if (!isNonEmptyString(value["reason"])) {
      problems.push({ field: `${field}.reason`, message: "構造で確かめる理由は空でない文字列であること" });
    }
    const checks = value["checks"];
    if (!Array.isArray(checks) || !checks.every((check) => isOneOf(STRUCTURAL_ASSERTIONS, check))) {
      problems.push({ field: `${field}.checks`, message: `checks は ${STRUCTURAL_ASSERTIONS.join("・")} の並びであること` });
    }
    if (problems.length !== before) return undefined;
    return { kind, reason: value["reason"] as string, checks: checks as readonly StructuralAssertionKind[] };
  }
  if (kind === "unresolved") {
    const before = problems.length;
    if (typeof value["reason"] !== "string") {
      problems.push({ field: `${field}.reason`, message: "未解決の理由は文字列であること" });
    }
    const ids = value["constraintIds"];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      problems.push({ field: `${field}.constraintIds`, message: "制約 ID は文字列の並びであること" });
    }
    if (problems.length !== before) return undefined;
    return { kind, reason: value["reason"] as string, constraintIds: ids as readonly string[] };
  }
  problems.push({ field: `${field}.kind`, message: "確かめ方の種類は fixed-test・structural・unresolved のいずれかであること" });
  return undefined;
}

function shapeOfDraftRequirement(value: unknown, field: string, problems: Problem[]): NameTableDraftRequirement | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "要件ごとの 1 件は写像（object）であること" });
    return undefined;
  }
  const before = problems.length;
  if (!isNonEmptyString(value["copy"])) problems.push({ field: `${field}.copy`, message: "要件の文の写しは空でない文字列であること" });
  const rolesRaw = value["roles"];
  const roles: NameTableRoleOwnership[] = [];
  if (!Array.isArray(rolesRaw)) {
    problems.push({ field: `${field}.roles`, message: "所属は並び（array）であること" });
  } else {
    rolesRaw.forEach((item, index) => {
      const role = shapeOfRoleOwnership(item, `${field}.roles[${index}]`, problems);
      if (role !== undefined) roles.push(role);
    });
  }
  const verification = shapeOfVerification(value["verification"], `${field}.verification`, problems);
  const nature = value["nature"];
  if (!isOneOf(REQUIREMENT_NATURES, nature)) {
    problems.push({ field: `${field}.nature`, message: `分類は ${REQUIREMENT_NATURES.join("・")} のいずれかであること` });
  }
  if (problems.length !== before || verification === undefined) return undefined;
  return { copy: value["copy"] as string, roles, verification, nature: nature as RequirementNature };
}

/** (a) T1 の応答（下書き）の形を確かめる。合わない欄を**すべて**挙げる */
export function checkNameTableDraftShape(value: unknown): ShapeCheck<NameTableDraft> {
  const problems: Problem[] = [];
  if (!isRecord(value)) return { ok: false, problems: [{ field: "", message: "名前の表は写像（object）であること" }] };
  const rows: NameTableDraftRow[] = [];
  const rowsRaw = value["rows"];
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    problems.push({ field: "rows", message: "行は空でない並びであること" });
  } else {
    rowsRaw.forEach((item, index) => {
      const row = shapeOfRow(item, `rows[${index}]`, problems);
      if (row !== undefined) rows.push(row);
    });
  }
  const requirements: NameTableDraftRequirement[] = [];
  const requirementsRaw = value["requirements"];
  if (!Array.isArray(requirementsRaw)) {
    problems.push({ field: "requirements", message: "要件ごとの並びは並び（array）であること" });
  } else {
    requirementsRaw.forEach((item, index) => {
      const requirement = shapeOfDraftRequirement(item, `requirements[${index}]`, problems);
      if (requirement !== undefined) requirements.push(requirement);
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { rows, requirements } };
}

// ── (f) 要件 ID を付ける（D10）────────────────────────────────────────

export type ResolveResult =
  | { readonly ok: true; readonly table: NameTable }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/**
 * (f) 下書きに、**一覧の順で**要件 ID を付ける。要件ごとの並びの i 番目は一覧の i 番目の要件であり、
 * その写しが要件の文の先頭 `copyLengthFor` 文字と一致しなければ落とす（入れ替え・取り違え・長さ違い）。
 * 行の出典の写しは、それと一致する要件にちょうど 1 つ当たり、**引用がその要件の文か依頼文の引用の部分文字列**
 * であれば（`isSourceQuoteOf`）、その要件 ID を付ける（引用が別の要件の文・引用に在っても結び付け直さない）。
 * 全文が同じ要件が一覧にあれば、**表を見る前に**落とす。
 */
export function resolveNameTableDraft(list: RequirementList, draft: NameTableDraft): ResolveResult {
  const listProblems = checkRequirementListForTable(list);
  const length = copyLengthFor(list);
  if (listProblems.length > 0 || length === null) return { ok: false, problems: listProblems };

  const problems: Problem[] = [];
  const copies = list.requirements.map((requirement) => requirementCopy(requirement.text, length));
  if (draft.requirements.length !== list.requirements.length) {
    problems.push({ field: "requirements", message: "要件ごとの並びの数が一覧の要件の数と合わない" });
  }
  draft.requirements.forEach((entry, index) => {
    const expected = copies[index];
    if (expected === undefined) return;
    if (codePoints(entry.copy).length !== codePoints(expected).length) {
      problems.push({ field: `requirements[${index}].copy`, message: "要件の文の写しが指示した長さと合わない" });
    } else if (entry.copy !== expected) {
      problems.push({ field: `requirements[${index}].copy`, message: "要件の文の写しが一覧の同じ位置の要件と合わない" });
    }
  });
  const sources = draft.rows.map((row, index) => {
    const matches = copies.flatMap((copy, at) => (copy === row.source.copy ? [at] : []));
    const [only] = matches;
    if (matches.length !== 1 || only === undefined) {
      problems.push({ field: `rows[${index}].source.copy`, message: "出典の要件の文の写しが一覧のどの要件とも合わない" });
      return undefined;
    }
    // 引用は、写しが指す**その要件の原文**（要件の文か依頼文の引用。#505・#507）の部分文字列であること。
    // 別の要件の原文に在っても結び付け直さない（推測で別の要件に結び付けない。fail-closed。窓口の判断
    // 2026-10-16・PR #515）
    const requirement = list.requirements[only];
    if (requirement === undefined || !isSourceQuoteOf(requirement, row.source.quote)) {
      problems.push({ field: `rows[${index}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" });
      return undefined;
    }
    return list.requirements[only]?.id;
  });
  if (problems.length > 0) return { ok: false, problems };

  const ids = list.requirements.map((requirement) => requirement.id);
  const table: NameTable = {
    rows: draft.rows.map((row, index) => ({
      ...row,
      source: { requirementId: sources[index] as string, quote: row.source.quote },
    })),
    ownership: draft.requirements.map((entry, index) => ({ requirementId: ids[index] as string, roles: entry.roles })),
    verification: draft.requirements.map((entry, index) => ({
      ...entry.verification,
      requirementId: ids[index] as string,
    })),
    classification: draft.requirements.map((entry, index) => ({
      requirementId: ids[index] as string,
      nature: entry.nature,
    })),
  };
  return { ok: true, table };
}

// ── 導く欄（D9）──────────────────────────────────────────────────────

/**
 * 要件ごとの所属に、**導いた entity の所属**を足して返す（LLM に書かせない。D9）。項目・計算・操作・画面を
 * 所属させた要件に、その所属 entity の行が無ければ、basis `dependency`・reason に導いた行の `id` を添えて
 * 足す（同じ entity を複数の行から導くときは最初の行の `id`）。表に無い `id`・entity でない所属先は導かない
 * （検査が別に落とす）。並びは T1 の所属のあとに、導いた順で置く。
 */
export function deriveOwnership(table: NameTable): readonly NameTableOwnership[] {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  return table.ownership.map((entry) => {
    const owned = new Set(entry.roles.map((role) => role.id));
    const derived: NameTableRoleOwnership[] = [];
    for (const role of entry.roles) {
      const row = rowById.get(role.id);
      if (row === undefined || row.entity === null || owned.has(row.entity)) continue;
      if (rowById.get(row.entity)?.kind !== "entity") continue;
      owned.add(row.entity);
      derived.push({ id: row.entity, basis: "dependency", reason: row.id });
    }
    return derived.length === 0 ? entry : { requirementId: entry.requirementId, roles: [...entry.roles, ...derived] };
  });
}

/** 行の `id` ごとに、所属させた要件 ID の並び（導いた所属を含む。表の順。重なりは 1 つ） */
export function ownersByRowId(table: NameTable): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, string[]>();
  for (const entry of deriveOwnership(table)) {
    for (const role of entry.roles) {
      const list = owners.get(role.id) ?? [];
      if (!list.includes(entry.requirementId)) list.push(entry.requirementId);
      owners.set(role.id, list);
    }
  }
  return owners;
}

/** `shared` を導く：所属させた要件が 2 つ以上の行の `id` の集合（D9） */
export function sharedRowIds(table: NameTable): ReadonlySet<string> {
  const shared = new Set<string>();
  for (const [id, owners] of ownersByRowId(table)) if (owners.length >= 2) shared.add(id);
  return shared;
}

/**
 * 出典の引用の位置（要件の文の中の最初の出現）。要件の文に無ければ null——依頼文の引用だけから写した出典
 * （`isSourceQuoteOf` は受ける）は、要件の文の中に位置を持たない。
 */
export function sourcePositionOf(
  list: RequirementList,
  source: NameTableSource,
): { readonly start: number; readonly end: number } | null {
  const text = list.requirements.find((requirement) => requirement.id === source.requirementId)?.text;
  if (text === undefined || source.quote === "") return null;
  const start = text.indexOf(source.quote);
  return start < 0 ? null : { start, end: start + source.quote.length };
}

// ── (b)〜(g) 表の検査（T1'）────────────────────────────────────────────

const isComputationType = (type: NameTableRowType): type is ComputationRowType =>
  type !== null && typeof type === "object" && "valueType" in type;
const isScreenType = (type: NameTableRowType): type is ScreenRowType =>
  type !== null && typeof type === "object" && "view" in type;

/** 行の型と種類の組（形の再確認。型付きで組み立てた表にも掛ける） */
function checkRowType(row: NameTableRow, field: string, problems: Problem[]): void {
  const shapeProblems: Problem[] = [];
  shapeOfType(row.kind, row.type, `${field}.type`, shapeProblems);
  problems.push(...shapeProblems);
  if (shapeProblems.length > 0 || !isComputationType(row.type)) return;
  const { valueType, scope, form } = row.type;
  if ((scope === "groups") !== (valueType === "groups")) {
    problems.push({ field: `${field}.type`, message: "見出しごとの範囲と値の型 groups は組で使うこと" });
  }
  if (scope === "groups" && form !== "aggregate") {
    problems.push({ field: `${field}.type`, message: "見出しごとの計算の種別は aggregate であること" });
  }
  if (form === "settle" && scope !== "row") {
    problems.push({ field: `${field}.type`, message: "精算の計算の範囲は row であること" });
  }
}

/** 所属 entity を持つべき行か（null であるべきなら false） */
function needsEntity(row: NameTableRow): boolean {
  switch (row.kind) {
    case "entity":
      return false;
    case "field":
    case "operation":
      return true;
    case "computation":
      return isComputationType(row.type) ? row.type.scope === "row" : true;
    case "screen":
      return isScreenType(row.type) ? row.type.view !== "dashboard" : true;
  }
}

/**
 * (b)〜(g) 名前の表を、要件の一覧と文書に照らして確かめる（T1'）。合わない欄を**すべて**返す。
 *
 *   (b) `id` の一意
 *   (c) 名前の規則（`NAME_PATTERN`・`RESERVED_NAMES`）と名前空間ごとの一意（entity・計算・操作・画面は種類ごとに
 *       全体、項目は所属 entity の中。別 entity の同名の項目は許す）。同じ（種類・entity・名前）を指す 2 つの `id`。
 *       行ごとの計算と同じ entity の項目の同名
 *   (d) 参照（`entity`・`groupBy.field`・`refEntity` が表にあり種類が合う。enum の見出しの元は options を持ち、
 *       月の見出しの元は date）と、型・選択肢・出典の形
 *   (e) 所属の fail-closed（fixed-test・structural は所属 1 件以上、structural は checks ごとに種類の合う所属、
 *       unresolved は理由と文書にある制約 ID。どの要件にも所属しない行）
 *   (g) 所属・確かめ方・分類が一覧の全要件にちょうど 1 つ（欠落・重複・一覧に無い要件 ID・未知の分類）
 *
 * (a) 応答の形は `checkNameTableDraftShape`、(f) 要件 ID の付け方は `resolveNameTableDraft` が受け持つ。
 */
export function checkNameTable(
  list: RequirementList,
  table: NameTable,
  documents: readonly PromptDocument[],
): readonly Problem[] {
  const problems: Problem[] = [];
  const rowById = new Map<string, NameTableRow>();

  // (b) id の一意
  table.rows.forEach((row, index) => {
    if (rowById.has(row.id)) problems.push({ field: `rows[${index}].id`, message: "表の ID が重なっている" });
    else rowById.set(row.id, row);
  });

  // (c) 名前の規則・名前空間・同じ場所
  const namespaceSeen = new Set<string>();
  const locationSeen = new Set<string>();
  table.rows.forEach((row, index) => {
    const field = `rows[${index}].name`;
    if (!NAME_PATTERN.test(row.name)) {
      problems.push({ field, message: "名前が規則（英字で始まる英数字）に合わない" });
    } else if ((RESERVED_NAMES as readonly string[]).includes(row.name)) {
      problems.push({ field, message: "名前が予約語である" });
    }
    const namespace = row.kind === "field" ? `field\u0000${row.entity ?? ""}\u0000${row.name}` : `${row.kind}\u0000${row.name}`;
    if (namespaceSeen.has(namespace)) problems.push({ field, message: "同じ名前空間に同じ名前の行がある" });
    namespaceSeen.add(namespace);
    // 行ごとの計算の名前は、同じ entity の項目の名前と重ねない（spec-engine の LOGIC_COMPUTED_NAME_CONFLICT と
    // 同じ線。別 entity の同名は許す。窓口の判断 2026-10-16・PR #515）
    if (row.kind === "computation" && row.entity !== null) {
      const clash = table.rows.some(
        (other) => other.kind === "field" && other.entity === row.entity && other.name === row.name,
      );
      if (clash) problems.push({ field, message: "計算の名前が同じ entity の項目の名前と重なっている" });
    }
    const entityName = row.entity === null ? "" : (rowById.get(row.entity)?.name ?? `\u0001${row.entity}`);
    const location = `${row.kind}\u0000${entityName}\u0000${row.name}`;
    if (locationSeen.has(location)) {
      problems.push({ field: `rows[${index}]`, message: "同じ場所（種類・entity・名前）を指す ID が 2 つある（別名は書けない）" });
    }
    locationSeen.add(location);
  });

  // (d) 参照・型・選択肢・出典
  const requirementById = new Map(list.requirements.map((requirement) => [requirement.id, requirement] as const));
  table.rows.forEach((row, index) => {
    const field = `rows[${index}]`;
    checkRowType(row, field, problems);
    if (row.role.trim() === "") problems.push({ field: `${field}.role`, message: "役割の説明が空である" });
    const sourceRequirement = requirementById.get(row.source.requirementId);
    if (sourceRequirement === undefined) {
      problems.push({ field: `${field}.source.requirementId`, message: "出典の要件 ID が一覧に無い" });
    } else if (!isSourceQuoteOf(sourceRequirement, row.source.quote)) {
      problems.push({ field: `${field}.source.quote`, message: "出典の引用が要件の文に無い" });
    }

    if (needsEntity(row)) {
      if (row.entity === null || rowById.get(row.entity)?.kind !== "entity") {
        problems.push({ field: `${field}.entity`, message: "所属 entity の ID が表の entity の行に無い" });
      }
    } else if (row.entity !== null) {
      problems.push({ field: `${field}.entity`, message: "この行は所属 entity を持たない（null であること）" });
    }

    const isEnumField = row.kind === "field" && row.type === "enum";
    if (isEnumField) {
      const options = row.options;
      if (options === null || options.length === 0) {
        problems.push({ field: `${field}.options`, message: "選択肢の項目に options が無い" });
      } else if (new Set(options).size !== options.length || options.some((key) => key.trim() === "")) {
        problems.push({ field: `${field}.options`, message: "options は空でない重複の無いキーの並びであること" });
      }
    } else if (row.options !== null) {
      problems.push({ field: `${field}.options`, message: "options を持てるのは選択肢（enum）の項目だけである" });
    }

    if (row.groupBy !== null) {
      if (row.kind !== "computation") {
        problems.push({ field: `${field}.groupBy`, message: "見出しの元を持てるのは計算の行だけである" });
      } else {
        const target = rowById.get(row.groupBy.field);
        if (target === undefined || target.kind !== "field") {
          problems.push({ field: `${field}.groupBy.field`, message: "見出しの元の項目の ID が表の項目の行に無い" });
        } else if (row.groupBy.kind === "enum" && (target.options === null || target.options.length === 0)) {
          problems.push({ field: `${field}.groupBy.field`, message: "見出しの元の項目に選択肢（options）が無い" });
        } else if (row.groupBy.kind === "month" && target.type !== "date") {
          problems.push({ field: `${field}.groupBy.field`, message: "月の見出しの元の項目が日付（date）でない" });
        }
      }
    }

    const takesRef = row.kind === "field" && (row.type === "ref" || row.type === "list");
    if (row.refEntity !== null) {
      if (!takesRef) {
        problems.push({ field: `${field}.refEntity`, message: "参照先を持てるのは参照の項目と参照の並びだけである" });
      } else if (rowById.get(row.refEntity)?.kind !== "entity") {
        problems.push({ field: `${field}.refEntity`, message: "参照先の ID が表の entity の行に無い" });
      }
    } else if (row.kind === "field" && row.type === "ref") {
      problems.push({ field: `${field}.refEntity`, message: "参照の項目に参照先が無い" });
    }
  });

  // (g) 要件ごとにちょうど 1 つ（所属・確かめ方・分類）
  const once = <T extends { readonly requirementId: string }>(entries: readonly T[], name: string, missing: string) => {
    const byId = new Map<string, T>();
    entries.forEach((entry, index) => {
      if (!requirementById.has(entry.requirementId)) {
        problems.push({ field: `${name}[${index}].requirementId`, message: "一覧に無い要件 ID である" });
      } else if (byId.has(entry.requirementId)) {
        problems.push({ field: `${name}[${index}].requirementId`, message: "同じ要件の項目が重なっている" });
      } else {
        byId.set(entry.requirementId, entry);
      }
    });
    list.requirements.forEach((requirement, index) => {
      if (!byId.has(requirement.id)) problems.push({ field: `requirements[${index}]`, message: missing });
    });
    return byId;
  };
  once(table.ownership, "ownership", "要件の所属が無い");
  const verificationById = once(table.verification, "verification", "要件の確かめ方が無い");
  once(table.classification, "classification", "要件の分類が無い");
  table.classification.forEach((entry, index) => {
    if (!isOneOf(REQUIREMENT_NATURES, entry.nature)) {
      problems.push({ field: `classification[${index}].nature`, message: `分類の値は ${REQUIREMENT_NATURES.join("・")} のいずれかであること` });
    }
  });

  // (e) 所属の形と fail-closed
  table.ownership.forEach((entry, oIndex) => {
    const seen = new Set<string>();
    entry.roles.forEach((role, rIndex) => {
      const field = `ownership[${oIndex}].roles[${rIndex}]`;
      if (!rowById.has(role.id)) problems.push({ field: `${field}.id`, message: "所属の表の ID が表に無い" });
      else if (seen.has(role.id)) problems.push({ field: `${field}.id`, message: "同じ要件の中で所属が重なっている" });
      seen.add(role.id);
      const shapeProblems: Problem[] = [];
      shapeOfRoleOwnership(role, field, shapeProblems);
      problems.push(...shapeProblems);
    });
  });
  const derived = new Map(deriveOwnership(table).map((entry) => [entry.requirementId, entry] as const));
  const ownedKinds = (requirementId: string): ReadonlySet<NameTableKind> =>
    new Set(
      (derived.get(requirementId)?.roles ?? []).flatMap((role) => {
        const row = rowById.get(role.id);
        return row === undefined ? [] : [row.kind];
      }),
    );
  const constraintIds = constraintIdsIn(documents);
  table.verification.forEach((entry, index) => {
    const field = `verification[${index}]`;
    if (verificationById.get(entry.requirementId) !== entry) return;
    const kinds = ownedKinds(entry.requirementId);
    switch (entry.kind) {
      case "fixed-test":
        if (kinds.size === 0) problems.push({ field, message: "固定した試験で確かめる要件に所属が無い" });
        return;
      case "structural": {
        if (entry.reason.trim() === "") problems.push({ field: `${field}.reason`, message: "構造で確かめる理由が空である" });
        if (kinds.size === 0) problems.push({ field, message: "構造で確かめる要件に所属が無い" });
        if (entry.checks.length === 0) problems.push({ field: `${field}.checks`, message: "構造で確かめる要件に checks が無い" });
        const seen = new Set<StructuralAssertionKind>();
        entry.checks.forEach((check, cIndex) => {
          if (seen.has(check)) problems.push({ field: `${field}.checks[${cIndex}]`, message: "checks の中身が重なっている" });
          seen.add(check);
          const want = STRUCTURAL_TARGET_KINDS[check];
          if (want !== undefined && !kinds.has(want)) {
            problems.push({ field: `${field}.checks[${cIndex}]`, message: "checks の検査に合う種類の所属が無い" });
          }
        });
        return;
      }
      case "unresolved":
        if (entry.reason.trim() === "") problems.push({ field: `${field}.reason`, message: "未解決の理由が空である" });
        if (entry.constraintIds.length === 0) {
          problems.push({ field: `${field}.constraintIds`, message: "未解決の要件に制約 ID が無い" });
        }
        entry.constraintIds.forEach((id, cIndex) => {
          if (!constraintIds.has(normalizeConstraintId(id))) {
            problems.push({ field: `${field}.constraintIds[${cIndex}]`, message: "制約 ID が文書に無い" });
          }
        });
        return;
    }
  });
  const owners = ownersByRowId(table);
  table.rows.forEach((row, index) => {
    if (!owners.has(row.id)) problems.push({ field: `rows[${index}]`, message: "どの要件にも所属しない行がある" });
  });
  return problems;
}

/** (a)・(f)・(b)〜(g) をまとめて掛ける（T1' の入口） */
export function inspectNameTable(
  list: RequirementList,
  value: unknown,
  documents: readonly PromptDocument[],
): ResolveResult {
  const listProblems = checkRequirementListForTable(list);
  if (listProblems.length > 0) return { ok: false, problems: listProblems };
  const shape = checkNameTableDraftShape(value);
  if (!shape.ok) return shape;
  const resolved = resolveNameTableDraft(list, shape.value);
  if (!resolved.ok) return resolved;
  const problems = checkNameTable(list, resolved.table, documents);
  return problems.length > 0 ? { ok: false, problems } : resolved;
}

// ── SHA-256 ───────────────────────────────────────────────────────────

/** キーを並べ替えた正規化 JSON（配列の順は保つ。`undefined` の欄は落とす） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** 名前の表の SHA-256（行・所属・確かめ方・分類を含む正規化 JSON。行の順も効く） */
export function nameTableSha256(table: NameTable): Promise<string> {
  return sha256Hex(
    canonicalJson({
      rows: table.rows,
      ownership: table.ownership,
      verification: table.verification,
      classification: table.classification,
    }),
  );
}
