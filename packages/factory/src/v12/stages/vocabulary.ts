// C1 語彙（08-architecture-v1.2.md §4 の C1・C1'・§6・§9 の手 3a。Issue #593）。
//
// 旗 `v12.ids` が on の走りだけ、T1 の行の部分を **3 つの束**に分けて LLM に書かせる。LLM は共通の口（`CallGateway`）だけで
// 呼び、ID は**コードが応答の順に振る**（`v12/ids.ts`。方法論 03 の H1・H5）：
//
//   1. 束 1 `entities`  … `entities: [{name, role}]` → `E1`・`E2`…
//   2. 束 2 `fields`    … データに束 1 の行を足す。`fields: [{entity, name, role, fieldType, options, refEntity}]`（`entity`・
//      `refEntity` は束 1 の ID）→ entity ごとに `E{n}.F{m}`
//   3. 束 3 `behaviors` … データに束 1・2 の行を足す。計算・操作・画面の 3 つの並び → `C{n}`・`OP{n}`・`V{n}`
//
// 参照は文字列で受け、コードが実在・種類・束を照らす（`checkReference`。知らない ID・別の束の ID・種類違いは固定文。fail-closed）。
// そのあと組み上げた行に T1' の (b)(c)(d)（`checkVocabularyRows`。今の固定文）を掛ける。どれかに落ちれば**その束だけ**、共通の窓口
// （`callStructuredChecked`）の形のやり直しで 1 回作り直す（前回の応答と問題をデータで）。2 回落ちれば `unmet`（骨組みの形の
// 落ちが続いたときは今の窓口と同じ `malformed`）。
//
// schema は静的（走りごとに変わらない。台帳が集計の種類を持つ走りだけ、計算に `aggregate` を足す）で、v1.2 の封筒に載せる。
// 参照を ID の enum で閉じる形は最初の版から外す（窓口の判断 2026-10-18。enum の受理と費用が未確認）。行の出典は持たない
// （`IDS_NO_SOURCE`。写し・引用・位置の対応は無い。08 §6）。
import { ACTION_KINDS, VIEW_TYPES, type ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import type { RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  shapeRejectedCandidate,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RejectedCandidate,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
} from "../../stages/prompt.js";
import {
  COMPUTATION_FORMS,
  COMPUTATION_SCOPES,
  COMPUTATION_VALUE_TYPES,
  FIELD_ROW_TYPES,
  IDS_NO_SOURCE,
  NAME_TABLE_GROUP_BY_KINDS,
  checkVocabularyRows,
  type NameTableGroupBy,
  type NameTableKind,
  type NameTableRow,
  type NameTableRowType,
} from "../../v11a/names.js";
import { planWithoutRequirementKinds } from "../../v11a/stages/name-table.js";
import {
  ReferenceTally,
  checkReference,
  computationIdAt,
  entityIdAt,
  fieldIdAt,
  operationIdAt,
  screenIdAt,
  type ReferenceCounts,
  type VocabularyBundle,
} from "../ids.js";
import type { LedgerView } from "../ledger.js";

/** 束ごとの JSON Schema の名前（v1.2 の封筒の枝の判別子） */
export const VOCABULARY_SCHEMA_NAMES: Readonly<Record<VocabularyBundle, string>> = {
  entities: "vocabulary-entities",
  fields: "vocabulary-fields",
  behaviors: "vocabulary-behaviors",
};

/** 束ごとに足すデータの塊の名前 */
export const VOCABULARY_DATA_NAMES = {
  plan: "確定した仕様",
  list: "要件の一覧",
  entities: "entity の行",
  fields: "項目の行",
} as const;

// ── 規則 ─────────────────────────────────────────────────────────────

/** 3 束で共通に足す規則（名前の規則と「無い対象を足さない」） */
const COMMON_VOCABULARY_RULES: readonly RuleDefinition[] = [
  {
    id: "R-voc-01",
    text: "name は宣言でそのまま使う名前である。英字で始まる英数字にし、予約語を使わない。同じ種類の名前を重ねない（項目は同じ entity の中で重ねない。別の entity の項目と同じ名前はよい。行ごとの計算の名前を同じ entity の項目の名前と重ねない）。role は、その行が要件に対して何をするかを 1 文で書く役割の説明である。",
    why: "名前の規則と名前空間を spec-engine の静的チェックに合わせる（T1 の R-nt-02・R-nt-05 の名前と役割の部分。写しと引用は持たない。08 §6）",
    since: "Issue #593",
  },
  {
    id: "R-voc-02",
    text: "ID はコードが応答の順に振る。行に ID を書かない。前の束の行を指すときは、データに載った ID をそのまま書く。要件の一覧と確定した仕様に無い対象を足さない。前回の応答と前回の形の問題が渡されたときは、問題が指す箇所を直した応答を返す。",
    why: "ID を文に依らない形でコードが振り、参照はコードが照らす（方法論 03 の H1・H2。07 の D10 の写しを廃止する。08 §6）",
    since: "Issue #593",
  },
];

/** 束ごとの規則の定義（共通の規則 → 束の規則の順。ID は `R-voc-nn`） */
export const VOCABULARY_RULE_DEFINITIONS: Readonly<Record<VocabularyBundle, readonly RuleDefinition[]>> = {
  entities: [
    ...COMMON_VOCABULARY_RULES,
    {
      id: "R-voc-03",
      text: "確定した仕様と要件の一覧から、宣言の entity（記録の単位）を並べる。entities の 1 件は name と role だけを持つ。",
      why: "束 1 は entity だけを書かせ、項目・計算・操作・画面の参照先の ID を先に固定する（08 §4 の C1。方法論 03 の H5）",
      since: "Issue #593",
    },
  ],
  fields: [
    ...COMMON_VOCABULARY_RULES,
    {
      id: "R-voc-04",
      text: "entity の行の項目を並べる。entity には所属する entity の行の ID を書く。fieldType は項目の種類である。options は選択肢（enum）の項目だけに、宣言で使う順の重複の無いキーの並びを書く（ほかは null）。refEntity は参照の項目と参照の並びだけに、参照先の entity の行の ID を書く（ほかは null）。",
      why: "項目の所属・型・選択肢・参照先を束 1 の ID で書かせ、C1' で照合する（T1 の R-nt-03・R-nt-04 の項目の部分）",
      since: "Issue #593",
    },
  ],
  behaviors: [
    ...COMMON_VOCABULARY_RULES,
    {
      id: "R-voc-05",
      text: "computations は計算である。entity は行ごとの計算だけに所属する entity の行の ID を書く（アプリ全体・見出しごとは null）。valueType（値の型）・scope（row＝行ごと／app＝アプリ全体／groups＝見出しごと）・form（expression＝式／aggregate＝集計／settle＝精算）を書く。groupBy は見出しごとの集計だけに {kind: enum, field: 選択肢の項目の ID} か {kind: month, field: 日付の項目の ID} を書く（ほかは null）。",
      why: "計算の型の 3 つ組と見出しの元を束 1・2 の ID で書かせる（T1 の R-nt-03・R-nt-04 の計算の部分）",
      since: "Issue #593",
    },
    {
      id: "R-voc-06",
      text: "operations は操作である。entity に所属する entity の行の ID、action に操作の種類、hasWhen に when の有無を書く。screens は画面である。entity に表示する entity の行の ID（ダッシュボードは null）、view に画面の種類を書く。",
      why: "操作と画面の所属と型を束 1 の ID で書かせる（T1 の R-nt-03・R-nt-04 の操作・画面の部分）",
      since: "Issue #593",
    },
  ],
};

/** 台帳が集計の種類を持つ走りだけ足す規則（計算の `aggregate`） */
export const VOCABULARY_AGGREGATE_RULE: RuleDefinition = {
  id: "R-voc-07",
  text: "計算の aggregate は、種別が aggregate の計算だけに {kind: 集計の種類, entity: 集計元の entity の行の ID} を書く（ほかは null）。",
  why: "集計の種類と集計元を表で決める（台帳の empty-aggregate の行。Issue #549 の T1 の欄を束 3 に写す）",
  since: "Issue #593",
};

/** 束の規則の定義（台帳が集計の種類を持てば束 3 の末尾に `R-voc-07`） */
export function vocabularyRuleDefinitionsOf(bundle: VocabularyBundle, ledger?: LedgerView): readonly RuleDefinition[] {
  const base = VOCABULARY_RULE_DEFINITIONS[bundle];
  return bundle === "behaviors" && (ledger?.aggregateKinds.length ?? 0) > 0 ? [...base, VOCABULARY_AGGREGATE_RULE] : base;
}

// ── schema（静的。strict の規則に合わせる）─────────────────────────────

const stringField = (description: string) => ({ type: "string", description });
const objectOf = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arrayOf = (properties: Record<string, unknown>) => ({ type: "array", items: objectOf(properties) });

const ENTITIES_SCHEMA = objectOf({
  entities: arrayOf({ name: stringField("宣言で使う名前"), role: stringField("役割の説明（1 文）") }),
});

const FIELDS_SCHEMA = objectOf({
  fields: arrayOf({
    entity: stringField("所属する entity の行の ID"),
    name: stringField("宣言で使う名前"),
    role: stringField("役割の説明（1 文）"),
    fieldType: { type: "string", enum: [...FIELD_ROW_TYPES] },
    options: { type: ["array", "null"], items: { type: "string" } },
    refEntity: { type: ["string", "null"], description: "参照先の entity の行の ID" },
  }),
});

const groupBySchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["kind", "field"],
  properties: {
    kind: { type: "string", enum: [...NAME_TABLE_GROUP_BY_KINDS] },
    field: stringField("見出しの元の項目の行の ID"),
  },
};

function behaviorsSchemaOf(aggregateKinds: readonly string[]) {
  return objectOf({
    computations: arrayOf({
      entity: { type: ["string", "null"], description: "所属する entity の行の ID（行ごとの計算だけ）" },
      name: stringField("宣言で使う名前"),
      role: stringField("役割の説明（1 文）"),
      valueType: { type: "string", enum: [...COMPUTATION_VALUE_TYPES] },
      scope: { type: "string", enum: [...COMPUTATION_SCOPES] },
      form: { type: "string", enum: [...COMPUTATION_FORMS] },
      ...(aggregateKinds.length === 0
        ? {}
        : {
            aggregate: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["kind", "entity"],
              properties: {
                kind: { type: "string", enum: [...aggregateKinds] },
                entity: stringField("集計元の entity の行の ID"),
              },
            },
          }),
      groupBy: groupBySchema,
    }),
    operations: arrayOf({
      entity: stringField("所属する entity の行の ID"),
      name: stringField("宣言で使う名前"),
      role: stringField("役割の説明（1 文）"),
      action: { type: "string", enum: [...ACTION_KINDS] },
      hasWhen: { type: "boolean" },
    }),
    screens: arrayOf({
      entity: { type: ["string", "null"], description: "表示する entity の行の ID（ダッシュボードは null）" },
      name: stringField("宣言で使う名前"),
      role: stringField("役割の説明（1 文）"),
      view: { type: "string", enum: [...VIEW_TYPES] },
    }),
  });
}

/** 束の JSON Schema（台帳が集計の種類を持つ走りだけ、束 3 の計算に `aggregate` を足す） */
export function vocabularySchemaOf(bundle: VocabularyBundle, ledger?: LedgerView): Record<string, unknown> {
  switch (bundle) {
    case "entities":
      return ENTITIES_SCHEMA;
    case "fields":
      return FIELDS_SCHEMA;
    case "behaviors":
      return behaviorsSchemaOf(ledger?.aggregateKinds ?? []);
  }
}

// ── 段 ───────────────────────────────────────────────────────────────

/** C1 の 1 束が受け取るもの */
export interface VocabularyBundleInput {
  readonly bundle: VocabularyBundle;
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** 前の束までに組んだ行（束 1 は空） */
  readonly rows: readonly NameTableRow[];
  /** 性質の台帳の導出（旗 `v12.ledger` が on の走りだけ） */
  readonly ledger?: LedgerView;
  /** 断った候補を受け取る観測用の口（省けば何もしない。要求・回数・結果は変わらない） */
  readonly onRejected?: (candidate: RejectedCandidate) => void;
}

/** C1 の 1 束の結果。参照の照合の数は成否によらず返す（段の記録に書く） */
export type VocabularyBundleOutcome =
  | { readonly ok: true; readonly rows: readonly NameTableRow[]; readonly response: unknown; readonly references: ReferenceCounts }
  | { readonly ok: false; readonly failure: StageFailure; readonly references: ReferenceCounts };

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** 束の応答の骨組み（写像・並び・欄の型）。合わない欄を全部挙げる */
function skeletonProblems(bundle: VocabularyBundle, output: unknown): readonly Problem[] {
  if (!isRecord(output)) return [{ field: "", message: "応答は写像（object）であること" }];
  const problems: Problem[] = [];
  const keys: readonly string[] = bundle === "entities" ? ["entities"] : bundle === "fields" ? ["fields"] : ["computations", "operations", "screens"];
  for (const key of keys) {
    const items = output[key];
    if (!Array.isArray(items)) {
      problems.push({ field: key, message: "並び（array）であること" });
      continue;
    }
    items.forEach((item, index) => {
      const at = `${key}[${String(index)}]`;
      if (!isRecord(item)) {
        problems.push({ field: at, message: "写像（object）であること" });
        return;
      }
      if (typeof item["name"] !== "string") problems.push({ field: `${at}.name`, message: "名前は文字列であること" });
      if (!nonEmpty(item["role"])) problems.push({ field: `${at}.role`, message: "役割の説明は空でない文字列であること" });
      if (key !== "entities" && !isNullableString(item["entity"])) {
        problems.push({ field: `${at}.entity`, message: "ID は文字列か null であること" });
      }
      if (key === "fields") {
        if (!isNullableString(item["refEntity"])) problems.push({ field: `${at}.refEntity`, message: "ID は文字列か null であること" });
        const options = item["options"];
        if (options !== null && !(Array.isArray(options) && options.every((option) => typeof option === "string"))) {
          problems.push({ field: `${at}.options`, message: "選択肢は null か、文字列の並びであること" });
        }
      }
      if (key === "computations") {
        const groupBy = item["groupBy"];
        if (groupBy !== null && !(isRecord(groupBy) && typeof groupBy["field"] === "string")) {
          problems.push({ field: `${at}.groupBy`, message: "見出しの元は null か、種類と項目の ID の写像であること" });
        }
        const aggregate = item["aggregate"];
        if (aggregate !== undefined && aggregate !== null && !(isRecord(aggregate) && typeof aggregate["entity"] === "string")) {
          problems.push({ field: `${at}.aggregate`, message: "aggregate は null か、集計の種類と集計元の ID の写像であること" });
        }
      }
      if (key === "operations" && typeof item["hasWhen"] !== "boolean") {
        problems.push({ field: `${at}.hasWhen`, message: "hasWhen は真偽値であること" });
      }
    });
  }
  return problems;
}

/** 行の雛形（ID・種類・所属・名前・役割と、型・選択肢・見出しの元・参照先。出典は持たない） */
function rowOf(
  partial: Pick<NameTableRow, "id" | "kind" | "entity" | "name" | "role" | "type"> &
    Partial<Pick<NameTableRow, "options" | "groupBy" | "refEntity">>,
): NameTableRow {
  return {
    id: partial.id,
    kind: partial.kind,
    entity: partial.entity,
    name: partial.name,
    role: partial.role,
    source: IDS_NO_SOURCE,
    type: partial.type,
    options: partial.options ?? null,
    groupBy: partial.groupBy ?? null,
    refEntity: partial.refEntity ?? null,
  };
}

/** 組み上げの結果（新しい行・各行の応答の位置・問題） */
interface Assembled {
  readonly rows: readonly NameTableRow[];
  readonly labels: readonly string[];
  readonly problems: readonly Problem[];
}

/**
 * 束の応答（骨組みは通った）に ID を振り、参照を照らして行を組む（純粋）。参照に落ちた行は組まない（ID も振らない。後の行の
 * ID の番号は応答の順のまま）。数は `tally` に足す。
 */
export function assembleVocabularyBundle(
  bundle: VocabularyBundle,
  output: Record<string, unknown>,
  previous: readonly NameTableRow[],
  tally: ReferenceTally,
  ledger?: LedgerView,
): Assembled {
  const problems: Problem[] = [];
  const known = new Map<string, NameTableKind>(previous.map((row) => [row.id, row.kind] as const));
  const rows: NameTableRow[] = [];
  const labels: string[] = [];
  const items = (key: string): readonly Record<string, unknown>[] => output[key] as readonly Record<string, unknown>[];
  const ref = (value: unknown, field: string, want: NameTableKind): boolean =>
    value === null || checkReference(value as string, field, bundle, known, want, problems, tally);
  const push = (row: NameTableRow, label: string): void => {
    rows.push(row);
    labels.push(label);
  };
  switch (bundle) {
    case "entities":
      items("entities").forEach((item, index) => {
        push(rowOf({ id: entityIdAt(index), kind: "entity", entity: null, name: item["name"] as string, role: item["role"] as string, type: null }), `entities[${String(index)}]`);
      });
      break;
    case "fields": {
      const perEntity = new Map<string, number>();
      items("fields").forEach((item, index) => {
        const at = `fields[${String(index)}]`;
        const entityOk = ref(item["entity"], `${at}.entity`, "entity") && item["entity"] !== null;
        if (item["entity"] === null) problems.push({ field: `${at}.entity`, message: "項目の所属 entity が無い" });
        const refOk = ref(item["refEntity"], `${at}.refEntity`, "entity");
        if (!entityOk || !refOk) return;
        const entity = item["entity"] as string;
        const m = perEntity.get(entity) ?? 0;
        perEntity.set(entity, m + 1);
        push(
          rowOf({
            id: fieldIdAt(entity, m),
            kind: "field",
            entity,
            name: item["name"] as string,
            role: item["role"] as string,
            type: item["fieldType"] as NameTableRowType,
            options: item["options"] as readonly string[] | null,
            refEntity: item["refEntity"] as string | null,
          }),
          at,
        );
      });
      break;
    }
    case "behaviors": {
      const withAggregate = (ledger?.aggregateKinds.length ?? 0) > 0;
      items("computations").forEach((item, index) => {
        const at = `computations[${String(index)}]`;
        const aggregate = item["aggregate"];
        const groupBy = item["groupBy"];
        const ok = [
          ref(item["entity"], `${at}.entity`, "entity"),
          isRecord(aggregate) ? ref(aggregate["entity"], `${at}.aggregate.entity`, "entity") : true,
          isRecord(groupBy) ? ref(groupBy["field"], `${at}.groupBy.field`, "field") : true,
        ].every(Boolean);
        if (!ok) return;
        const type = { valueType: item["valueType"], scope: item["scope"], form: item["form"] };
        push(
          rowOf({
            id: computationIdAt(index),
            kind: "computation",
            entity: item["entity"] as string | null,
            name: item["name"] as string,
            role: item["role"] as string,
            type: (withAggregate || (aggregate !== undefined && aggregate !== null) ? { ...type, aggregate: aggregate ?? null } : type) as NameTableRowType,
            groupBy: (groupBy ?? null) as NameTableGroupBy,
          }),
          at,
        );
      });
      items("operations").forEach((item, index) => {
        const at = `operations[${String(index)}]`;
        if (!ref(item["entity"], `${at}.entity`, "entity")) return;
        push(
          rowOf({
            id: operationIdAt(index),
            kind: "operation",
            entity: item["entity"] as string | null,
            name: item["name"] as string,
            role: item["role"] as string,
            type: { action: item["action"], hasWhen: item["hasWhen"] } as NameTableRowType,
          }),
          at,
        );
      });
      items("screens").forEach((item, index) => {
        const at = `screens[${String(index)}]`;
        if (!ref(item["entity"], `${at}.entity`, "entity")) return;
        push(
          rowOf({
            id: screenIdAt(index),
            kind: "screen",
            entity: item["entity"] as string | null,
            name: item["name"] as string,
            role: item["role"] as string,
            type: { view: item["view"] } as NameTableRowType,
          }),
          at,
        );
      });
      break;
    }
  }
  // 同じ場所（種類・entity・名前）を指す行の重複を数える（固定文は C1' の (c) が出す）
  const nameOf = new Map([...previous, ...rows].map((row) => [row.id, row.name] as const));
  const seen = new Set(previous.map((row) => `${row.kind}\u0000${row.entity === null ? "" : (nameOf.get(row.entity) ?? "")}\u0000${row.name}`));
  for (const row of rows) {
    const location = `${row.kind}\u0000${row.entity === null ? "" : (nameOf.get(row.entity) ?? "")}\u0000${row.name}`;
    if (seen.has(location)) tally.duplicate += 1;
    seen.add(location);
  }
  return { rows, labels, problems };
}

/** 束のデータ（確定した仕様・要件の一覧・前の束の行） */
function buildData(input: VocabularyBundleInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: VOCABULARY_DATA_NAMES.plan, text: serializeJson(planWithoutRequirementKinds(input.plan)) },
    {
      name: VOCABULARY_DATA_NAMES.list,
      text: serializeJson({ requirements: input.list.requirements.map((requirement) => ({ text: requirement.text })) }),
    },
  ];
  const entities = input.rows.filter((row) => row.kind === "entity");
  if (input.bundle !== "entities") {
    data.push({
      name: VOCABULARY_DATA_NAMES.entities,
      text: serializeJson(entities.map((row) => ({ id: row.id, name: row.name, role: row.role }))),
    });
  }
  if (input.bundle === "behaviors") {
    data.push({
      name: VOCABULARY_DATA_NAMES.fields,
      text: serializeJson(
        input.rows
          .filter((row) => row.kind === "field")
          .map((row) => ({
            id: row.id,
            entity: row.entity,
            name: row.name,
            role: row.role,
            fieldType: row.type,
            options: row.options,
            refEntity: row.refEntity,
          })),
      ),
    });
  }
  return data;
}

/** 行の位置 `rows[i]` を束の応答の位置へ置き換える（前の束の行は束の名前のまま） */
function relabel(problems: readonly Problem[], labels: readonly string[]): readonly Problem[] {
  return problems.map((problem) => ({
    ...problem,
    field: problem.field.replace(/^rows\[(\d+)\]/, (whole, index: string) => labels[Number(index)] ?? whole),
  }));
}

/**
 * C1 の 1 束を回す。骨組みの形・参照の照合・C1'（`checkVocabularyRows`）に落ちれば共通の窓口が 1 回だけ作り直させ、2 回続けば
 * `unmet`（骨組みの形が 2 回続いたときは `malformed`）。通れば前の束の行に新しい行を足した並びを返す。
 */
export async function runVocabularyBundle(input: VocabularyBundleInput): Promise<VocabularyBundleOutcome> {
  const { bundle, ledger } = input;
  const tally = new ReferenceTally();
  const previousLabels = input.rows.map((row, index) => `${row.kind}s[${String(index)}]`);
  let lastWasSkeleton = false;
  const check = (output: unknown): ShapeCheck<readonly NameTableRow[]> => {
    const skeleton = skeletonProblems(bundle, output);
    lastWasSkeleton = skeleton.length > 0;
    if (skeleton.length > 0) return { ok: false, problems: skeleton };
    const assembled = assembleVocabularyBundle(bundle, output as Record<string, unknown>, input.rows, tally, ledger);
    const rows = [...input.rows, ...assembled.rows];
    const tableProblems = relabel(
      checkVocabularyRows(input.list, rows, ledger === undefined ? {} : { ledger }),
      [...previousLabels, ...assembled.labels],
    );
    const problems = [...assembled.problems, ...tableProblems];
    return problems.length > 0 ? { ok: false, problems } : { ok: true, value: rows };
  };
  const request = buildStructuredRequest({
    rules: ruleTexts(vocabularyRuleDefinitionsOf(bundle, ledger)),
    documents: input.documents,
    data: buildData(input),
    schemaName: VOCABULARY_SCHEMA_NAMES[bundle],
    schema: vocabularySchemaOf(bundle, ledger),
    maxOutputTokens: input.gateway.maxOutputTokens("name-table"),
  });
  const onRejected = input.onRejected;
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check,
    ...(onRejected === undefined ? {} : { onShapeRejected: (rejection) => onRejected(shapeRejectedCandidate(1, rejection)) }),
  });
  if (answer.ok) return { ok: true, rows: answer.value, response: answer.output, references: tally.counts };
  const failure: StageFailure =
    answer.failure.kind === "malformed" && !lastWasSkeleton
      ? { kind: "unmet", attempts: answer.failure.attempts, problems: answer.failure.problems }
      : answer.failure;
  return { ok: false, failure, references: tally.counts };
}
