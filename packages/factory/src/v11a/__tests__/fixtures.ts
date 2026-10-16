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
import type { PromptDocument } from "../../stages/prompt.js";
import {
  copyLengthFor,
  requirementCopy,
  type NameTable,
  type NameTableDraft,
  type NameTableRow,
} from "../names.js";

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
}

/**
 * 宣言の YAML を組み立てる。既定は表の全要素＋補助の計算 `base`＋検査 `amount`。補助を外すと `rate` の式は
 * 定数になり、表の全要素だけの宣言になる（検査も外したとき）。
 */
export function fixtureYaml(options: FixtureYamlOptions = {}): string {
  const helper = options.helper ?? true;
  const validation = options.validation ?? true;
  const closeItem = options.closeItem ?? true;
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
    "          alpha: アルファ",
    "          beta: ベータ",
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
