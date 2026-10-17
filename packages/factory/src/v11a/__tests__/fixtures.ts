// v1.1α の試験の共通の題材（Issue #505。後の Issue の試験も使う）。
//
// 抽象的な題材で組む：担当者（member）と項目（item）の 2 つの entity。**別 entity の同名の項目**
// （`member.title` と `item.title`）、選択肢・日付・参照の項目、行ごと・アプリ全体・見出しごと（enum・月）の
// 計算、when のある操作、表とダッシュボードの画面を持つ。宣言には表に無い**補助の計算**（`base`）と検査
// （`amount`）がある（追加の要素の一覧と、印の参照先の試験に使う）。
//
// 要件の一覧・名前の表・下書き（T1 の応答の形）・文書・宣言（YAML と正規化した JSON）を返す。
// 受入の題材の言葉は使わない。
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { normalizeSpec } from "@musunest/spec-engine";
import type { Requirement, RequirementList } from "../../pipeline.js";
import type { PromptDocument, RuleDefinition } from "../../stages/prompt.js";
import {
  copyLengthFor,
  requirementCopy,
  type ComputationAggregate,
  type NameTable,
  type NameTableDraft,
  type NameTableRow,
} from "../names.js";
import { PROPERTY_LEDGER, deriveLedgerView, type LedgerView } from "../../v12/ledger.js";
import { NAME_TABLE_RULE_DEFINITIONS, NAME_TABLE_SCHEMA_NAME } from "../stages/name-table.js";
import { SEMANTIC_CHECK_RULE_DEFINITIONS, SEMANTIC_CHECK_SCHEMA_NAME } from "../stages/semantic-check.js";
import { TEST_SPEC_RULE_DEFINITIONS, TEST_SPEC_SCHEMA_NAME } from "../stages/test-spec.js";
import { WRITE_V11A_SCHEMA_NAME } from "../stages/write.js";

const requirement = (id: string, text: string): Requirement => ({
  id,
  text,
  quote: text,
  position: { start: 0, end: text.length },
});

/** 要件の一覧（R1〜R5。R5 は書けない要件＝unresolved） */
export function fixtureList(): RequirementList {
  return {
    requirements: [
      requirement("R1", "項目を題名・金額・日付・区分・担当者つきで登録できる。"),
      requirement("R2", "担当者の名前と担当する項目の数、項目の題名を一覧で見られる。"),
      requirement("R3", "金額が 0 より大きい項目だけを締められる。"),
      requirement("R4", "区分ごとの件数と月ごとの金額の合計、全体の率をまとめの画面で見られる。"),
      requirement("R5", "外部の仕組みへ通知を送れる。"),
    ],
    decisions: [],
    unresolved: [],
  };
}

/**
 * 依頼文の引用（`quote`）が要件の文と別の文字列である要件の一覧（文は `fixtureList` と同じ。#505・#507 の
 * T1 の出典の引用の試験に使う）。どの引用も、どの要件の文にも別の要件の引用にも含まれない。
 */
export function fixtureListWithRequestQuotes(): RequirementList {
  const quotes = [
    "依頼の一つ目：記録の単位をまとめて登録したい",
    "依頼の二つ目：受け持ちを一覧で見たい",
    "依頼の三つ目：正の値のものだけを締めたい",
    "依頼の四つ目：まとめを一つの画面で見たい",
    "依頼の五つ目：外へ知らせを出したい",
  ];
  const base = fixtureList();
  return {
    ...base,
    requirements: base.requirements.map((requirement, index) => ({
      ...requirement,
      quote: quotes[index] as string,
      position: { start: 0, end: (quotes[index] as string).length },
    })),
  };
}

/** 段に渡す文書（制約 ID は `### ` の見出し） */
export const FIXTURE_DOCUMENTS: readonly PromptDocument[] = [
  { name: "契約", text: "# 契約\n\n### 外部への通知\n\n宣言は外部の仕組みへ通知を送れない。\n" },
];

/** 制約 ID（`FIXTURE_DOCUMENTS` の見出し） */
export const FIXTURE_CONSTRAINT_ID = "外部への通知";

const row = (
  partial: Pick<NameTableRow, "id" | "kind" | "entity" | "name" | "type"> &
    Partial<Pick<NameTableRow, "options" | "groupBy" | "refEntity">> & { readonly from: string; readonly quote: string },
): NameTableRow => ({
  id: partial.id,
  kind: partial.kind,
  entity: partial.entity,
  name: partial.name,
  role: `要件 ${partial.from} が使う対象`,
  source: { requirementId: partial.from, quote: partial.quote },
  type: partial.type,
  options: partial.options ?? null,
  groupBy: partial.groupBy ?? null,
  refEntity: partial.refEntity ?? null,
});

/** 名前の表の行（表の順） */
export function fixtureRows(): readonly NameTableRow[] {
  return [
    row({ id: "e.member", kind: "entity", entity: null, name: "member", type: null, from: "R2", quote: "担当者" }),
    row({ id: "e.item", kind: "entity", entity: null, name: "item", type: null, from: "R1", quote: "項目" }),
    row({ id: "f.member.title", kind: "field", entity: "e.member", name: "title", type: "string", from: "R2", quote: "担当者の名前" }),
    row({ id: "f.item.title", kind: "field", entity: "e.item", name: "title", type: "string", from: "R1", quote: "題名" }),
    row({ id: "f.item.owner", kind: "field", entity: "e.item", name: "owner", type: "ref", refEntity: "e.member", from: "R1", quote: "担当者" }),
    row({ id: "f.item.amount", kind: "field", entity: "e.item", name: "amount", type: "number", from: "R1", quote: "金額" }),
    row({ id: "f.item.day", kind: "field", entity: "e.item", name: "day", type: "date", from: "R1", quote: "日付" }),
    row({ id: "f.item.kind", kind: "field", entity: "e.item", name: "kind", type: "enum", options: ["alpha", "beta"], from: "R1", quote: "区分" }),
    row({
      id: "c.itemCount",
      kind: "computation",
      entity: "e.member",
      name: "itemCount",
      type: { valueType: "number", scope: "row", form: "aggregate" },
      from: "R2",
      quote: "担当する項目の数",
    }),
    row({
      id: "c.rate",
      kind: "computation",
      entity: null,
      name: "rate",
      type: { valueType: "number", scope: "app", form: "expression" },
      from: "R4",
      quote: "全体の率",
    }),
    row({
      id: "c.byKind",
      kind: "computation",
      entity: null,
      name: "byKind",
      type: { valueType: "groups", scope: "groups", form: "aggregate" },
      groupBy: { kind: "enum", field: "f.item.kind" },
      from: "R4",
      quote: "区分ごとの件数",
    }),
    row({
      id: "c.byMonth",
      kind: "computation",
      entity: null,
      name: "byMonth",
      type: { valueType: "groups", scope: "groups", form: "aggregate" },
      groupBy: { kind: "month", field: "f.item.day" },
      from: "R4",
      quote: "月ごとの金額の合計",
    }),
    row({ id: "o.addItem", kind: "operation", entity: "e.item", name: "addItem", type: { action: "create", hasWhen: false }, from: "R1", quote: "登録できる" }),
    row({ id: "o.closeItem", kind: "operation", entity: "e.item", name: "closeItem", type: { action: "update", hasWhen: true }, from: "R3", quote: "締められる" }),
    row({ id: "s.items", kind: "screen", entity: "e.item", name: "items", type: { view: "table" }, from: "R2", quote: "一覧で見られる" }),
    row({ id: "s.members", kind: "screen", entity: "e.member", name: "members", type: { view: "table" }, from: "R2", quote: "一覧で見られる" }),
    row({ id: "s.overview", kind: "screen", entity: null, name: "overview", type: { view: "dashboard" }, from: "R4", quote: "まとめの画面" }),
  ];
}

const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });

/** 名前の表（正例。問題 0） */
export function fixtureTable(): NameTable {
  return {
    rows: fixtureRows(),
    ownership: [
      {
        requirementId: "R1",
        roles: ["f.item.title", "f.item.amount", "f.item.day", "f.item.kind", "f.item.owner", "o.addItem"].map(stated),
      },
      // R2 は別 entity の同名の項目（member.title と item.title）を 2 つ所属させる
      { requirementId: "R2", roles: ["f.member.title", "f.item.title", "c.itemCount", "s.members", "s.items"].map(stated) },
      { requirementId: "R3", roles: ["o.closeItem", "f.item.amount"].map(stated) },
      { requirementId: "R4", roles: ["c.byKind", "c.byMonth", "c.rate", "s.overview"].map(stated) },
      { requirementId: "R5", roles: [] },
    ],
    verification: [
      { requirementId: "R1", kind: "fixed-test" },
      { requirementId: "R2", kind: "structural", reason: "画面に出ることだけを求める", checks: ["view-shows"] },
      { requirementId: "R3", kind: "fixed-test" },
      { requirementId: "R4", kind: "fixed-test" },
      { requirementId: "R5", kind: "unresolved", reason: "宣言で書けない", constraintIds: [FIXTURE_CONSTRAINT_ID] },
    ],
    classification: [
      { requirementId: "R1", nature: "ruled" },
      { requirementId: "R2", nature: "existence-only" },
      { requirementId: "R3", nature: "ruled" },
      { requirementId: "R4", nature: "ruled" },
      { requirementId: "R5", nature: "existence-only" },
    ],
  };
}

/**
 * 既定値の要件（Issue #533）。区分の項目（`f.item.kind`。options は alpha・beta）の既定値だけを決める要件 R6 の文。
 * 抽象的な文で、受入の題材の言葉は使わない。
 */
export const DEFAULT_VALUE_REQUIREMENT_TEXT = "項目の区分は、未入力なら保存の時点で alpha になる。";

/** 題材の一覧に、既定値の要件 R6 を末尾に足したもの（`fixtureList` の値は変えない。Issue #533） */
export function fixtureDefaultValueList(text: string = DEFAULT_VALUE_REQUIREMENT_TEXT): RequirementList {
  const base = fixtureList();
  return { ...base, requirements: [...base.requirements, requirement("R6", text)] };
}

/**
 * 題材の表に、既定値の要件 R6 を足したもの（Issue #533）。R6 は区分の項目だけを名指しで所属させ（entity はコードが
 * 足す）、確かめ方は default-value（value は `value`）、分類は ruled。行は題材の表のまま（`fixtureTable` の値は変えない）。
 */
export function fixtureDefaultValueTable(value = "alpha"): NameTable {
  const base = fixtureTable();
  return {
    rows: base.rows,
    ownership: [...base.ownership, { requirementId: "R6", roles: [stated("f.item.kind")] }],
    verification: [...base.verification, { requirementId: "R6", kind: "default-value", value }],
    classification: [...base.classification, { requirementId: "R6", nature: "ruled" }],
  };
}

/**
 * 選択肢の集合の要件（Issue #548）。区分の項目（`f.item.kind`。options は alpha・beta）の値が挙げた選択肢のどれかで
 * あることだけを決める要件 R6 の文。抽象的な文で、受入の題材の言葉は使わない。
 */
export const ENUM_MEMBERSHIP_REQUIREMENT_TEXT = "項目の区分は、alpha・beta のどれかである。";

/** 題材の一覧に、選択肢の集合の要件 R6 を末尾に足したもの（`fixtureList` の値は変えない。Issue #548） */
export function fixtureEnumMembershipList(text: string = ENUM_MEMBERSHIP_REQUIREMENT_TEXT): RequirementList {
  return fixtureDefaultValueList(text);
}

/**
 * 題材の表に、選択肢の集合の要件 R6 を足したもの（Issue #548）。R6 は区分の項目だけを名指しで所属させ（entity は
 * コードが足す）、確かめ方は enum-membership（欄は無し）、分類は ruled。`options` を渡せば区分の項目の options を
 * その並びに替える（ほかの行は題材の表のまま。`fixtureTable` の値は変えない）。
 */
export function fixtureEnumMembershipTable(options?: readonly string[]): NameTable {
  const base = fixtureTable();
  return {
    rows: options === undefined ? base.rows : base.rows.map((entry) => (entry.id === "f.item.kind" ? { ...entry, options } : entry)),
    ownership: [...base.ownership, { requirementId: "R6", roles: [stated("f.item.kind")] }],
    verification: [...base.verification, { requirementId: "R6", kind: "enum-membership" }],
    classification: [...base.classification, { requirementId: "R6", nature: "ruled" }],
  };
}

/** 名前の表を T1 の応答の形（下書き。要件 ID を持たず、写しを添える）に戻す */
export function draftOf(list: RequirementList, table: NameTable): NameTableDraft {
  const length = copyLengthFor(list);
  if (length === null) throw new Error("前提が壊れた：全文が同じ要件がある");
  const copyOf = (requirementId: string): string => {
    const text = list.requirements.find((candidate) => candidate.id === requirementId)?.text;
    if (text === undefined) throw new Error("前提が壊れた：一覧に無い要件 ID");
    return requirementCopy(text, length);
  };
  return {
    rows: table.rows.map((entry) => ({
      ...entry,
      source: { copy: copyOf(entry.source.requirementId), quote: entry.source.quote },
    })),
    requirements: list.requirements.map((item) => {
      const ownership = table.ownership.find((entry) => entry.requirementId === item.id);
      const verification = table.verification.find((entry) => entry.requirementId === item.id);
      const classification = table.classification.find((entry) => entry.requirementId === item.id);
      if (ownership === undefined || verification === undefined || classification === undefined) {
        throw new Error("前提が壊れた：要件の欄が欠けている");
      }
      const { requirementId: _omit, ...rest } = verification;
      return { copy: copyOf(item.id), roles: ownership.roles, verification: rest, nature: classification.nature };
    }),
  };
}

/** 宣言の組み立ての選択（既定は全部入り） */
export interface FixtureYamlOptions {
  /** 表に無い補助の計算 `base`（`rate` の式が参照する）を入れるか */
  readonly helper?: boolean;
  /** 表に無い検査 `amount` を入れるか */
  readonly validation?: boolean;
  /** 表の操作 `closeItem` を入れるか（外すと表の名前が宣言に無い） */
  readonly closeItem?: boolean;
  /** 区分の項目 `kind` の options のキーの並び（既定は alpha・beta。Issue #548） */
  readonly kindOptions?: readonly string[];
}

/** 区分の項目の options の表示名（キー → 表示名） */
const KIND_OPTION_LABELS: Readonly<Record<string, string>> = { alpha: "アルファ", beta: "ベータ", gamma: "ガンマ" };

/**
 * 宣言の YAML を組み立てる。既定は表の全要素＋補助の計算 `base`＋検査 `amount`。補助を外すと `rate` の式は
 * 定数になり、表の全要素だけの宣言になる（検査も外したとき）。
 */
export function fixtureYaml(options: FixtureYamlOptions = {}): string {
  const helper = options.helper ?? true;
  const validation = options.validation ?? true;
  const closeItem = options.closeItem ?? true;
  const kindOptions = options.kindOptions ?? ["alpha", "beta"];
  return [
    "entities:",
    "  - name: member",
    "    fields:",
    "      title:",
    "        type: string",
    "  - name: item",
    "    fields:",
    "      title:",
    "        type: string",
    "      owner:",
    "        type: ref",
    "        to: member",
    "      amount:",
    "        type: number",
    "      day:",
    "        type: date",
    "      kind:",
    "        type: enum",
    "        options:",
    ...kindOptions.map((key) => `          ${key}: ${KIND_OPTION_LABELS[key] ?? key}`),
    "computed:",
    "  - name: itemCount",
    "    entity: member",
    "    aggregate:",
    "      count: item",
    "      where:",
    "        owner: this",
    "    type: number",
    ...(helper
      ? ["  - name: base", "    scope: app", "    aggregate:", "      sum: item.amount", "    type: number"]
      : []),
    "  - name: rate",
    "    scope: app",
    `    expression: ${helper ? "base * 2" : "2 * 3"}`,
    "    type: number",
    "  - name: byKind",
    "    aggregate:",
    "      count: item",
    "      groupBy: item.kind",
    "    type: groups",
    "  - name: byMonth",
    "    aggregate:",
    "      sum: item.amount",
    "      groupBy:",
    "        month: item.day",
    "      last: 6",
    "    type: groups",
    "views:",
    "  - name: items",
    "    type: table",
    "    entity: item",
    "    show: [title, amount, kind]",
    "  - name: members",
    "    type: table",
    "    entity: member",
    "    show: [title, itemCount]",
    "  - name: overview",
    "    type: dashboard",
    "    widgets:",
    "      - type: number",
    "        value: rate",
    ...(helper ? ["      - type: number", "        value: base"] : []),
    "      - type: bar",
    "        value: byMonth",
    "      - type: pie",
    "        value: byKind",
    "actions:",
    "  - name: addItem",
    "    entity: item",
    ...(closeItem
      ? [
          "  - name: closeItem",
          "    entity: item",
          "    kind: update",
          "    set:",
          "      kind: beta",
          "    when: amount > 0",
        ]
      : []),
    ...(validation
      ? ["validations:", "  - name: amount", "    entity: item", "    expression: amount > 0"]
      : ["validations: []"]),
    "permissions:",
    "  - name: read",
    "    subject: minIdentity",
    "  - name: write",
    "    subject: minIdentity",
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");
}

/** 宣言（表の全要素＋補助の計算 `base`＋検査 `amount`） */
export const FIXTURE_YAML = fixtureYaml();

/** 正規化した宣言（YAML を静的チェックに通したもの。通らなければ前提が壊れた） */
export async function normalizedFixture(source: string = FIXTURE_YAML): Promise<NormalizedAppSpec> {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`前提が壊れた：${result.diagnostics.map((diagnostic) => diagnostic.code).join("・")}`);
  }
  return result.app;
}

// ── 旗 on の要求の差の範囲（Issue #548）──────────────────────────────

const ENUM_MEMBERSHIP_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
if (ENUM_MEMBERSHIP_ROW === undefined) throw new Error("前提が壊れた：台帳に enum-membership の行が無い");
/** 台帳の enum-membership の行の、文に差し込む文（T1・T1''・T2） */
const ENUM_MEMBERSHIP_SENTENCES = [ENUM_MEMBERSHIP_ROW.rules.t1, ENUM_MEMBERSHIP_ROW.rules.t1Acceptance, ENUM_MEMBERSHIP_ROW.rules.t2].filter(
  (text): text is string => text !== null,
);

/**
 * 旗 on の要求（の JSON の値）から、台帳の enum-membership の行の分を除く（Issue #548）。文の中の T1・T1''・T2 の文と
 * 種類の並びの `・enum-membership`（R-tsp-02 の除外・種類の一覧の固定文）を消し、並びから値 `enum-membership`（schema の
 * enum）と B1 の文の要素を外す。手 2a の要求とバイト列で同じになることを、旗 on の差の範囲の試験が照らす。
 */
export function withoutEnumMembership(value: unknown): unknown {
  if (typeof value === "string") {
    return ENUM_MEMBERSHIP_SENTENCES.reduce((text, sentence) => text.split(sentence).join(""), value).split("・enum-membership").join("");
  }
  if (Array.isArray(value)) {
    return value
      .filter((element) => element !== "enum-membership" && element !== ENUM_MEMBERSHIP_ROW?.rules.b1)
      .map(withoutEnumMembership);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutEnumMembership(entry)]));
  }
  return value;
}

/** 2 つの JSON の値の違う場所（葉の位置。並びの長さが違えばその並びの位置）を、見つけた順に返す */
export function jsonDiffPaths(left: unknown, right: unknown, path = "$"): readonly string[] {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [path];
    return left.flatMap((entry, index) => jsonDiffPaths(entry, right[index], `${path}[${String(index)}]`));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    return keys.flatMap((key) =>
      jsonDiffPaths((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`),
    );
  }
  return Object.is(left, right) ? [] : [path];
}

const ruleAt = (definitions: readonly RuleDefinition[], id: string): string => {
  const index = definitions.findIndex((definition) => definition.id === id);
  if (index < 0) throw new Error(`前提が壊れた：規則 ${id} が無い`);
  return `$.rules[${String(index)}]`;
};

/**
 * 旗 on の要求が手 2a（off）と違ってよい場所（段の schema の名前 → 要求の中の位置。Issue #548）。T1 は R-nt-08 と
 * schema の確かめ方の種類の enum、T1'' は R-sc-02、T2 は R-tsp-02・R-tsp-16 と schema の観測する性質の enum、B1 は
 * 規則の並び（末尾に 1 文増える）。ほかの段・ほかの位置は違ってはいけない。
 */
export const ENUM_MEMBERSHIP_REQUEST_DIFF: Readonly<Record<string, readonly string[]>> = {
  [NAME_TABLE_SCHEMA_NAME]: [
    ruleAt(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08"),
    "$.schema.properties.requirements.items.properties.verification.properties.kind.enum",
  ],
  [SEMANTIC_CHECK_SCHEMA_NAME]: [ruleAt(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02")],
  [TEST_SPEC_SCHEMA_NAME]: [
    ruleAt(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-02"),
    ruleAt(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16"),
    "$.schema.properties.tests.items.properties.observes.enum",
  ],
  [WRITE_V11A_SCHEMA_NAME]: ["$.rules"],
};

/** 要求の差：on と off の要求の並びの、要求ごとの違う場所（schema の名前つき。道具の要求は `tools`） */
export function requestDiffsOf(
  on: readonly unknown[],
  off: readonly unknown[],
): readonly { readonly schemaName: string; readonly paths: readonly string[] }[] {
  return on.map((request, index) => ({
    schemaName: (request as { readonly schemaName?: string }).schemaName ?? "tools",
    paths: jsonDiffPaths(request, off[index]),
  }));
}

/**
 * 手 2a（#547）の台帳の導出＝今の台帳から enum-membership の行（と、手 2c で足した empty-aggregate の行。Issue #549）を
 * 除いたもの（Issue #548）。旗 on の段がこれを受けた要求・結果は off とバイト列で同じ（載せ替えの不変）。今の台帳との差は
 * `withoutLedgerAdditions` で除く分だけ。
 */
export const LEDGER_VIEW_2A: LedgerView = deriveLedgerView(
  PROPERTY_LEDGER.filter((entry) => entry.id !== "enum-membership" && entry.id !== "empty-aggregate"),
);

// ── 集計の種類と集計元（旗 on の T1 の計算の行の型の `aggregate`。Issue #549）──────────────────

/**
 * 題材の表の計算の行の、集計の種類と集計元（宣言 `FIXTURE_YAML` の集計と同じ）。種別 aggregate でない計算は null。
 * 旗 on で台帳が集計の種類を持つ走りの T1 の応答は、計算の行ごとにこの欄を持つ（strict の schema で必須）。
 */
export const FIXTURE_AGGREGATES: Readonly<Record<string, ComputationAggregate | null>> = {
  "c.itemCount": { kind: "count", entity: "e.item" },
  "c.rate": null,
  "c.byKind": { kind: "count", entity: "e.item" },
  "c.byMonth": { kind: "sum", entity: "e.item" },
};

/** 計算の行に `aggregate` を足した行（表に無い計算の行は、種別 aggregate なら置き換えずに残す＝呼ぶ側が渡す） */
function rowWithAggregate(entry: NameTableRow, aggregates: Readonly<Record<string, ComputationAggregate | null>>): NameTableRow {
  if (entry.kind !== "computation" || entry.type === null || typeof entry.type !== "object" || !("valueType" in entry.type)) return entry;
  if (!Object.hasOwn(aggregates, entry.id)) return entry;
  return { ...entry, type: { ...entry.type, aggregate: aggregates[entry.id] ?? null } };
}

/**
 * 表の計算の行に、集計の種類と集計元（`FIXTURE_AGGREGATES` に `extra` を重ねたもの）を足した表（Issue #549）。旗 on で
 * 台帳が集計の種類を持つ走りの T1 の応答・表に使う（題材の表の値は変えない。off の走りには渡さない＝未登録で落ちる）。
 */
export function withAggregates(
  table: NameTable,
  extra: Readonly<Record<string, ComputationAggregate | null>> = {},
): NameTable {
  const aggregates = { ...FIXTURE_AGGREGATES, ...extra };
  return { ...table, rows: table.rows.map((entry) => rowWithAggregate(entry, aggregates)) };
}

/**
 * 記録した T1 の応答（行の並びを持つ構造化出力）の計算の行に、集計の種類と集計元を足す（Issue #549。記録の値は変えず、
 * 写しを返す）。旗 on の走りで手 2p の記録の経路を流すときに使う（行の id は題材の表と同じ）。
 */
export function withAggregateResponses<T>(recorded: readonly T[]): readonly T[] {
  return recorded.map((call) => {
    const output = (call as { readonly output?: unknown }).output;
    if (output === null || typeof output !== "object" || !Array.isArray((output as { rows?: unknown }).rows)) return call;
    const rows = ((output as { rows: unknown[] }).rows).map((entry) => {
      const raw = entry as { id?: unknown; kind?: unknown; type?: unknown };
      if (raw.kind !== "computation" || typeof raw.id !== "string" || raw.type === null || typeof raw.type !== "object") return entry;
      return { ...raw, type: { ...(raw.type as object), aggregate: FIXTURE_AGGREGATES[raw.id] ?? null } };
    });
    return { ...call, output: { ...(output as object), rows } };
  });
}

// ── 旗 on の要求の差の範囲（Issue #549）──────────────────────────────

const EMPTY_AGGREGATE_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
if (EMPTY_AGGREGATE_ROW === undefined) throw new Error("前提が壊れた：台帳に empty-aggregate の行が無い");
/** 台帳の empty-aggregate の行の、文に差し込む文（T1・T2） */
const EMPTY_AGGREGATE_SENTENCES = [EMPTY_AGGREGATE_ROW.rules.t1, EMPTY_AGGREGATE_ROW.rules.t2].filter(
  (text): text is string => text !== null,
);
/** JSON の文字列の中の、計算の行の型の `aggregate` の欄（null か、種類と集計元だけの写像。前の `,` ごと） */
const AGGREGATE_FIELD_PATTERN =
  /,\s*\\?"aggregate\\?":\s*(?:null|\{\s*\\?"kind\\?":\s*\\?"(?:sum|count|avg)\\?",\s*\\?"entity\\?":\s*\\?"[^"\\]*\\?"\s*\})/g;

/**
 * 旗 on の要求（の JSON の値）から、台帳の empty-aggregate の行の分を除く（Issue #549）。文の中の T1・T2 の文・観測する
 * 性質の並びの `・empty-aggregate` と、データの JSON の文字列の中の計算の行の `aggregate` の欄を消し、並びから値
 * `empty-aggregate`（schema の observes の enum）と B1 の文の要素を外し、T1 の schema の行の型から `aggregate` の欄
 * （properties と required）を外す。#548 の台帳（`LEDGER_VIEW_2B`）の要求とバイト列で同じになることを、
 * 旗 on の差の範囲の試験が照らす。
 */
export function withoutEmptyAggregate(value: unknown): unknown {
  if (typeof value === "string") {
    return EMPTY_AGGREGATE_SENTENCES.reduce((text, sentence) => text.split(sentence).join(""), value)
      .replace(AGGREGATE_FIELD_PATTERN, "")
      .split("・empty-aggregate")
      .join("");
  }
  if (Array.isArray(value)) {
    return value
      .filter((element) => element !== "empty-aggregate" && element !== EMPTY_AGGREGATE_ROW?.rules.b1)
      .map(withoutEmptyAggregate);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = record["properties"] as Record<string, unknown> | undefined;
    const isRowType = properties !== undefined && properties !== null && typeof properties === "object" && "fieldType" in properties && "aggregate" in properties;
    const entries = Object.entries(record).map(([key, entry]): [string, unknown] => {
      if (isRowType && key === "properties") {
        const { aggregate: _omit, ...rest } = entry as Record<string, unknown>;
        return [key, withoutEmptyAggregate(rest)];
      }
      if (isRowType && key === "required" && Array.isArray(entry)) return [key, entry.filter((name) => name !== "aggregate")];
      return [key, withoutEmptyAggregate(entry)];
    });
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * 旗 on の要求が #548 の台帳（`LEDGER_VIEW_2B`）と違ってよい場所のうち、表のデータに依らない場所（段の schema の名前 → 要求の
 * 中の位置。Issue #549）。T1 は R-nt-08 と schema の行の型（required の並びと aggregate の欄）、T2 は R-tsp-16 と schema の
 * 観測する性質の enum、B1 は規則の並び（末尾に 1 文増える）。表の計算の行が `aggregate` を持つ走りは、表を載せるデータ（`$.input`）も違う（試験ごとに名指しする）。
 */
export const EMPTY_AGGREGATE_REQUEST_DIFF: Readonly<Record<string, readonly string[]>> = {
  [NAME_TABLE_SCHEMA_NAME]: [
    ruleAt(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08"),
    "$.schema.properties.rows.items.properties.type.required",
    "$.schema.properties.rows.items.properties.type.properties.aggregate",
  ],
  [TEST_SPEC_SCHEMA_NAME]: [ruleAt(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16"), "$.schema.properties.tests.items.properties.observes.enum"],
  [WRITE_V11A_SCHEMA_NAME]: ["$.rules"],
};

/**
 * 今の台帳の on の要求が off（手 2a）と違ってよい場所（表のデータに依らない場所。Issue #548・#549）。`ENUM_MEMBERSHIP_REQUEST_DIFF`
 * と `EMPTY_AGGREGATE_REQUEST_DIFF` を、要求の中で見つかる順（`jsonDiffPaths` の順）に合わせたもの。
 */
export const LEDGER_REQUEST_DIFF: Readonly<Record<string, readonly string[]>> = {
  [NAME_TABLE_SCHEMA_NAME]: [
    ruleAt(NAME_TABLE_RULE_DEFINITIONS, "R-nt-08"),
    "$.schema.properties.rows.items.properties.type.required",
    "$.schema.properties.rows.items.properties.type.properties.aggregate",
    "$.schema.properties.requirements.items.properties.verification.properties.kind.enum",
  ],
  [SEMANTIC_CHECK_SCHEMA_NAME]: [ruleAt(SEMANTIC_CHECK_RULE_DEFINITIONS, "R-sc-02")],
  [TEST_SPEC_SCHEMA_NAME]: [
    ruleAt(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-02"),
    ruleAt(TEST_SPEC_RULE_DEFINITIONS, "R-tsp-16"),
    "$.schema.properties.tests.items.properties.observes.enum",
  ],
  [WRITE_V11A_SCHEMA_NAME]: ["$.rules"],
};

/** 今の台帳の on の要求から、台帳に足した行（enum-membership・empty-aggregate）の分を除く（手 2a の要求と比べる） */
export function withoutLedgerAdditions(value: unknown): unknown {
  return withoutEnumMembership(withoutEmptyAggregate(value));
}

/**
 * #548 の台帳の導出＝今の台帳から empty-aggregate の行を除いたもの（Issue #549）。旗 on の段がこれを受けた要求・結果は、
 * #548 までの旗 on と同じ。今の台帳との差は `withoutEmptyAggregate` で除く分だけ。
 */
export const LEDGER_VIEW_2B: LedgerView = deriveLedgerView(PROPERTY_LEDGER.filter((entry) => entry.id !== "empty-aggregate"));
