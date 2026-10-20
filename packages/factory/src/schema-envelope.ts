// 全段で同じ「封筒」の schema を送り、段をまたいでプロンプトのキャッシュを当てる（02-architecture.md §2・#353）。
//
// 出力の schema（`text.format`）は、入力より**前**に置かれる。段ごとに schema が違うと前置きが別物に
// なり、キャッシュは同じ段のくり返しでしか当たらない（#342 のあとの疎通で観測した——段をまたぐと毎回
// 4.9 万トークンを書き込んでいた）。そこで、構造化出力を使う段の schema を**全部 1 つの封筒にまとめ**、
// どの段でも同じ名前・同じ封筒を送る。段は、枝ごとに付けた `stage` の判別子（`enum` 1 つ）で選ぶ。
//
//   { type: "object", additionalProperties: false, required: ["result"],
//     properties: { result: { anyOf: [ <段の schema に stage を足したもの>, … ] } } }
//
// 枝の並びと中身は**決まった順**にする（同じ入力なら同じバイト列）。封筒は adapter（openai.ts）が送り、
// 応答から `result` を取り出して段へ渡す。段ごとの指示（どの枝で答えるか）は文書の後ろ＝前置きの外に
// 置くので、キャッシュは壊れない。
//
// v1.1α（`07-architecture-v1.1a.md` §3・D12・Issue #511）の段は、**別の封筒**（`stage-envelope-v11a`）に入れる。
// v1 の封筒に混ぜると v1 の要求のバイト列が変わるので、v1 の一覧・名前・`ENVELOPE_SCHEMA` の実体は変えず、
// adapter が封筒の識別子（`ENVELOPE_IDS`）で選ぶ。
//
// 経路 v1.2（`08-architecture-v1.2.md` §4.1・Issue #588）の段は、**さらに別の封筒**（`stage-envelope-v12`）に入れる。
// 一覧は `--pipeline v1.2` の旗の組（`V12_PIPELINE_FLAGS`）から導き、旗 on の段も台帳の導出を持たない段も同じ実体を
// 送る（1 本の走りの中で前置きを 1 種類にする）。後の手の段はこの一覧に足す（v1.1α の一覧には足さない）。
//
// 旗 `v12.ids` が on の v1.2 の走り（Issue #682）は、C2 の枝を検査の種類ごとの欄の schema にした**別の識別子**（`v1.2-ids`）の
// 封筒を全段で送る（名前は同じ `stage-envelope-v12`。一覧・段の順は同じで、変わる枝は C2 だけ）。識別子 `v1.2` の封筒は旧の C2 の
// 枝のまま残し、ids off の v1.2 の走りの要求をバイト列で変えない。どちらを送るかは入口が実効の旗で選ぶ。
//
// Issue #700 で、識別子 `v1.2-ids` の封筒の C3（T1''）の枝も観点ごとの根拠の schema（`SEMANTIC_CHECK_IDS_SCHEMA`）にした（違う枝は
// C2 と C3 の 2 つ）。識別子 `v1.2` の封筒の C3 の枝は旧の schema のまま——#682 の旧 C2 と違い、C3 は ids off の v1.2 の走りでも
// 走り、旧の schema で要求して旧の枝に解決される（ids off の要求をバイト列で変えない）。
import { QUESTIONS_SCHEMA, QUESTIONS_SCHEMA_NAME } from "./plan/questions.js";
import { SURFACE_SCHEMA, SURFACE_SCHEMA_NAME } from "./plan/surface.js";
import { ARBITRATION_SCHEMA, ARBITRATION_SCHEMA_NAME } from "./stages/arbitrate.js";
import { CORRESPONDENCE_SCHEMA, CORRESPONDENCE_SCHEMA_NAME } from "./stages/correspondence.js";
import { DESIGN_SCHEMA, DESIGN_SCHEMA_NAME } from "./stages/design.js";
import { MAPPING_REDO_SCHEMA, MAPPING_REDO_SCHEMA_NAME } from "./stages/repair.js";
import { REQUIREMENT_LIST_SCHEMA, REQUIREMENTS_SCHEMA_NAME } from "./stages/requirements.js";
import { REVERSE_CHECK_SCHEMA, REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import { TEST_SUITE_SCHEMA, TEST_SUITE_SCHEMA_NAME } from "./stages/test-suite.js";
import { DECLARATION_SCHEMA, WRITE_SCHEMA_NAME } from "./stages/write.js";
import { DECL_CHECK_SCHEMA, DECL_CHECK_SCHEMA_NAME } from "./v11a/stages/decl-check.js";
import { NAME_TABLE_SCHEMA, NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf } from "./v11a/stages/name-table.js";
import { SEMANTIC_CHECK_IDS_SCHEMA, SEMANTIC_CHECK_SCHEMA, SEMANTIC_CHECK_SCHEMA_NAME } from "./v11a/stages/semantic-check.js";
import { TEST_SPEC_SCHEMA, TEST_SPEC_SCHEMA_NAME, testSpecSchemaOf } from "./v11a/stages/test-spec.js";
import { DECLARATION_V11A_SCHEMA, WRITE_V11A_SCHEMA_NAME } from "./v11a/stages/write.js";
import { fromPublicV12Flags, ledgerViewOf, V12_PIPELINE_FLAGS, type V12Flags } from "./v12/ledger.js";
import { VOCABULARY_BUNDLES } from "./v12/ids.js";
import { MAPPING_SCHEMA_NAME, legacyMappingSchemaOf, mappingSchemaOf } from "./v12/stages/mapping.js";
import { VOCABULARY_SCHEMA_NAMES, vocabularySchemaOf } from "./v12/stages/vocabulary.js";

/** 封筒の識別子（adapter が選ぶ。既定は v1。`v1.2-ids` は旗 ids が on の v1.2 の走り。Issue #682） */
export const ENVELOPE_IDS = ["v1", "v1.1a", "v1.2", "v1.2-ids"] as const;

/** 封筒の識別子の型 */
export type EnvelopeId = (typeof ENVELOPE_IDS)[number];

/** 封筒の JSON Schema の名前。**全段で同じ**（`text.format.name`） */
export const ENVELOPE_SCHEMA_NAME = "stage-envelope";

/** 応答が枝の中身を包む欄の名前。adapter はこれを取り出して段へ渡す */
export const ENVELOPE_RESULT_KEY = "result";

/** 枝を選ぶ判別子の欄の名前。枝ごとに `enum` が 1 つだけの文字列 */
export const ENVELOPE_STAGE_KEY = "stage";

/** 封筒に入れる 1 つの段（判別子の値と、その段の schema） */
export interface StageEnvelopeEntry {
  /** その段の識別子（`stage` の値。段の `schemaName` と同じにする） */
  readonly stage: string;
  /** その段の JSON Schema（封筒の枝の下地） */
  readonly schema: unknown;
}

/**
 * 封筒に入れる段の一覧（**構造化出力を使う段**だけ。決まった順）。
 *
 * 段の順は、生成の流れに沿う（Plan の段 P3・P4 → ①〜⑥'・③ のやり直し）。道具付きの段（⑥ 直す）は
 * 入れない——道具の定義も前置きに入るので、直すどうしのくり返しでキャッシュが当たる（#353「道具付きの
 * 段は今のまま」）。判定の口（judge-llm）は問いごとに schema が変わるので入れない（adapter は、封筒に
 * 載っていない schema は今までどおりそのまま送る）。
 */
export const STAGE_ENVELOPE_ENTRIES: readonly StageEnvelopeEntry[] = [
  { stage: SURFACE_SCHEMA_NAME, schema: SURFACE_SCHEMA },
  { stage: QUESTIONS_SCHEMA_NAME, schema: QUESTIONS_SCHEMA },
  { stage: REQUIREMENTS_SCHEMA_NAME, schema: REQUIREMENT_LIST_SCHEMA },
  { stage: REVERSE_CHECK_SCHEMA_NAME, schema: REVERSE_CHECK_SCHEMA },
  { stage: DESIGN_SCHEMA_NAME, schema: DESIGN_SCHEMA },
  { stage: TEST_SUITE_SCHEMA_NAME, schema: TEST_SUITE_SCHEMA },
  { stage: WRITE_SCHEMA_NAME, schema: DECLARATION_SCHEMA },
  { stage: CORRESPONDENCE_SCHEMA_NAME, schema: CORRESPONDENCE_SCHEMA },
  { stage: ARBITRATION_SCHEMA_NAME, schema: ARBITRATION_SCHEMA },
  { stage: MAPPING_REDO_SCHEMA_NAME, schema: MAPPING_REDO_SCHEMA },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 段の schema に `stage` の判別子を足した、封筒の枝を作る（決まった順）。
 *
 * `stage` は枝の先頭の欄に置く（どの枝かが最初に見える）。**すべての欄は required にある**
 * （strict の規則。OpenAI が `additionalProperties: false` と全部の required を要求する）。
 */
export function buildStageBranch(entry: StageEnvelopeEntry): Record<string, unknown> {
  const schema = isRecord(entry.schema) ? entry.schema : {};
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter(
        (key): key is string => typeof key === "string" && key !== ENVELOPE_STAGE_KEY,
      )
    : [];
  return {
    ...schema,
    required: [ENVELOPE_STAGE_KEY, ...required],
    properties: {
      [ENVELOPE_STAGE_KEY]: {
        type: "string",
        enum: [entry.stage],
        description: `この枝の段（${entry.stage}）`,
      },
      ...properties,
    },
  };
}

/**
 * 段の一覧から封筒の schema を組み立てる（純粋。**同じ入力なら同じバイト列**）。
 * `result` の中身は、枝（段の schema に `stage` を足したもの）の `anyOf` である。
 */
export function buildEnvelopeSchema(
  entries: readonly StageEnvelopeEntry[] = STAGE_ENVELOPE_ENTRIES,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [ENVELOPE_RESULT_KEY],
    properties: {
      [ENVELOPE_RESULT_KEY]: {
        anyOf: entries.map(buildStageBranch),
      },
    },
  };
}

/** 全段で送る封筒の schema（起動時に 1 度だけ組む。全段で**同じ実体**を使う） */
export const ENVELOPE_SCHEMA: Record<string, unknown> = buildEnvelopeSchema();

/** v1.1α の封筒の JSON Schema の名前（v1.1α の全段で同じ。`text.format.name`） */
export const ENVELOPE_SCHEMA_NAME_V11A = "stage-envelope-v11a";

/**
 * v1.1α の封筒に入れる段の一覧（構造化出力を使う段だけ。決まった順）。
 *
 * 段の順は v1.1α の流れに沿う（T1 → T1'' → T2 → B1 → B3' → B5' 裁定）。裁定（⑥'）は v1 と共有する段で、
 * v1 の封筒にも載る（どちらの封筒で送るかは adapter が選んだ封筒で決まる）。道具付きの段（B5 直す）と、
 * 問いごとに schema が変わる判定の口（J4 を含む）は入れない。
 */
export const STAGE_ENVELOPE_ENTRIES_V11A: readonly StageEnvelopeEntry[] = [
  { stage: NAME_TABLE_SCHEMA_NAME, schema: NAME_TABLE_SCHEMA },
  { stage: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_SCHEMA },
  { stage: TEST_SPEC_SCHEMA_NAME, schema: TEST_SPEC_SCHEMA },
  { stage: WRITE_V11A_SCHEMA_NAME, schema: DECLARATION_V11A_SCHEMA },
  { stage: DECL_CHECK_SCHEMA_NAME, schema: DECL_CHECK_SCHEMA },
  { stage: ARBITRATION_SCHEMA_NAME, schema: ARBITRATION_SCHEMA },
];

/** v1.1α の全段で送る封筒の schema（起動時に 1 度だけ組む） */
export const ENVELOPE_SCHEMA_V11A: Record<string, unknown> = buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V11A);

/** 1 つの封筒（名前・schema・段の一覧） */
export interface StageEnvelope {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly entries: readonly StageEnvelopeEntry[];
}

/** v1.2 の封筒の JSON Schema の名前（`--pipeline v1.2` の全段で同じ。`text.format.name`。Issue #588） */
export const ENVELOPE_SCHEMA_NAME_V12 = "stage-envelope-v12";

/**
 * 旗の組から v1.2 の封筒の段の一覧を導く（純粋。Issue #588）。段の並びは v1.1α と同じで、旗 `v12.ledger` が on なら
 * T1・T2 の枝を台帳から導いた schema（`nameTableSchemaOf`・`testSpecSchemaOf`。段が渡すものと同じ導出）にする。
 * ほかの段は v1.1α と同じ枝。後の手の段は、その旗が on のときここで足す：旗 `v12.ids` が on なら、末尾に C1 の 3 束
 * （`vocabulary-*`）と C2（`mapping`）の枝を足す（schema は段が渡すものと同じ導出。Issue #593。C2 は検査の種類ごとの欄。Issue #682）。
 * 旗 `v12.ids` が on なら、C3（T1''）の枝も段が渡すものと同じ観点ごとの根拠の schema にする（Issue #700）。`ids` を省けば off。
 */
export function stageEnvelopeEntriesV12Of(flags: Pick<V12Flags, "ledger"> & Partial<Pick<V12Flags, "ids">>): readonly StageEnvelopeEntry[] {
  const ledger = ledgerViewOf(flags);
  const base =
    ledger === undefined
      ? STAGE_ENVELOPE_ENTRIES_V11A
      : STAGE_ENVELOPE_ENTRIES_V11A.map((entry) =>
          entry.stage === NAME_TABLE_SCHEMA_NAME
            ? { stage: entry.stage, schema: nameTableSchemaOf(ledger) }
            : entry.stage === TEST_SPEC_SCHEMA_NAME
              ? { stage: entry.stage, schema: testSpecSchemaOf(ledger) }
              : entry,
        );
  if (flags.ids !== true) return base;
  return [
    ...base.map((entry) => (entry.stage === SEMANTIC_CHECK_SCHEMA_NAME ? { stage: entry.stage, schema: SEMANTIC_CHECK_IDS_SCHEMA } : entry)),
    ...VOCABULARY_BUNDLES.map((bundle) => ({ stage: VOCABULARY_SCHEMA_NAMES[bundle], schema: vocabularySchemaOf(bundle, ledger) })),
    { stage: MAPPING_SCHEMA_NAME, schema: mappingSchemaOf(ledger) },
  ];
}

/** `--pipeline v1.2` の実効の旗（`V12_PIPELINE_FLAGS` から組む） */
const PIPELINE_V12_FLAGS = fromPublicV12Flags(V12_PIPELINE_FLAGS);

/**
 * 識別子 `v1.2` の封筒に入れる段の一覧（`--pipeline v1.2` の旗の組 `V12_PIPELINE_FLAGS` から導く。Issue #588）。
 *
 * Issue #682 で C2 の段の schema を検査の種類ごとの欄に替えたが、この一覧の C2 の枝は**旧の schema（`legacyMappingSchemaOf`）の
 * まま**にする——旗 ids off の v1.2 の走りが送る封筒のバイト列を変えないためだけに残す（旧の枝は段の要求には使わない）。ids on の
 * 走りは識別子 `v1.2-ids` の一覧（`STAGE_ENVELOPE_ENTRIES_V12_IDS`）を送る。
 *
 * Issue #700 で C3 の段の schema を旗 ids on だけ観点ごとの根拠に替えたので、この一覧の C3 の枝も**旧の schema（`SEMANTIC_CHECK_SCHEMA`）の
 * まま**にする。C2 と違い、C3 は ids off の v1.2 の走りでも旧の schema で要求し、この旧の枝に解決される（バイト列を変えない）。
 */
export const STAGE_ENVELOPE_ENTRIES_V12: readonly StageEnvelopeEntry[] = stageEnvelopeEntriesV12Of(PIPELINE_V12_FLAGS).map((entry) =>
  entry.stage === MAPPING_SCHEMA_NAME
    ? { stage: entry.stage, schema: legacyMappingSchemaOf(ledgerViewOf(PIPELINE_V12_FLAGS)) }
    : entry.stage === SEMANTIC_CHECK_SCHEMA_NAME
      ? { stage: entry.stage, schema: SEMANTIC_CHECK_SCHEMA }
      : entry,
);

/** 識別子 `v1.2` の全段で送る封筒の schema（起動時に 1 度だけ組む。全段で**同じ実体**を使う） */
export const ENVELOPE_SCHEMA_V12: Record<string, unknown> = buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12);

/**
 * 識別子 `v1.2-ids` の封筒に入れる段の一覧（旗 ids が on の v1.2 の走り。`V12_PIPELINE_FLAGS` から導き、C2 の枝は段が渡すものと
 * 同じ導出＝検査の種類ごとの欄。Issue #682）。一覧・段の順は識別子 `v1.2` と同じで、違う枝は C2 と C3（観点ごとの根拠。Issue #700）の 2 つ
 */
export const STAGE_ENVELOPE_ENTRIES_V12_IDS: readonly StageEnvelopeEntry[] = stageEnvelopeEntriesV12Of(PIPELINE_V12_FLAGS);

/** 識別子 `v1.2-ids` の全段で送る封筒の schema（起動時に 1 度だけ組む。全段で**同じ実体**を使う。Issue #682） */
export const ENVELOPE_SCHEMA_V12_IDS: Record<string, unknown> = buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12_IDS);

/** 封筒の識別子から封筒を引く（v1 は今までと同じ名前・同じ実体。`v1.2-ids` の名前は `v1.2` と同じ。Issue #682） */
export function envelopeOf(envelope: EnvelopeId = "v1"): StageEnvelope {
  return envelope === "v1.2-ids"
    ? { name: ENVELOPE_SCHEMA_NAME_V12, schema: ENVELOPE_SCHEMA_V12_IDS, entries: STAGE_ENVELOPE_ENTRIES_V12_IDS }
    : envelope === "v1.2"
      ? { name: ENVELOPE_SCHEMA_NAME_V12, schema: ENVELOPE_SCHEMA_V12, entries: STAGE_ENVELOPE_ENTRIES_V12 }
      : envelope === "v1.1a"
        ? { name: ENVELOPE_SCHEMA_NAME_V11A, schema: ENVELOPE_SCHEMA_V11A, entries: STAGE_ENVELOPE_ENTRIES_V11A }
        : { name: ENVELOPE_SCHEMA_NAME, schema: ENVELOPE_SCHEMA, entries: STAGE_ENVELOPE_ENTRIES };
}

/**
 * その schema の名前の段を、選んだ封筒（既定は v1）から引く（無ければ `undefined`）。
 * adapter は、ここで引けたときだけ封筒を送る（引けない schema——判定の口など——は今までどおりそのまま）。
 */
export function envelopeStageFor(schemaName: string, envelope: EnvelopeId = "v1"): StageEnvelopeEntry | undefined {
  return envelopeOf(envelope).entries.find((entry) => entry.stage === schemaName);
}

/**
 * 旗 `v12.ledger` が on の走りの封筒の段の一覧（Issue #549 の直し）。識別子 `v1.1a` の要求で、段の schema が旗 on の枝と
 * 等しいときに使う（library の呼び手が `v1.1a` を渡したときの振る舞い。名前は v1.1α の封筒と同じ）。
 *
 * Issue #588 では v1.2 の封筒の一覧の別名だった。Issue #593 で v1.2 の封筒に C1・C2 の枝（旗 `v12.ids`）を足したので、
 * **別名は残し、旗 `ids` を含まない組（ledger だけ on）の一覧に固定する**——識別子 `v1.1a` の旗 on の library の呼び手が送る
 * 封筒のバイト列は #588 のまま変わらない（C1・C2 の段を呼ばない走りに、その枝を足さない）。入口（CLI）はここを通らない。
 */
export const STAGE_ENVELOPE_ENTRIES_V12_LEDGER: readonly StageEnvelopeEntry[] = stageEnvelopeEntriesV12Of({ ledger: true, ids: false });

/** 旗 `v12.ledger` が on の走りで送る封筒の schema（ids を含まない一覧から組む。Issue #588・#593） */
export const ENVELOPE_SCHEMA_V12_LEDGER: Record<string, unknown> = buildEnvelopeSchema(STAGE_ENVELOPE_ENTRIES_V12_LEDGER);

/** 1 つの要求について送る封筒（その段の枝と、封筒の名前・schema） */
export interface ResolvedStageEnvelope {
  /** その段の枝の下地（段の名前と、**その要求が渡した schema** と深く等しい schema） */
  readonly entry: StageEnvelopeEntry;
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

function sameSchema(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 要求の段の名前と schema から、送る封筒を決める（Issue #549 の直し）。選んだ封筒に載っていない名前は `undefined`
 * （adapter は今までどおりその schema をそのまま送る）。
 *
 * 封筒の枝は**段が渡した schema と深く等しく**なければならない——段は台帳から schema を導く（旗 on の T1・T2）ので、
 * 起動時に組んだ定数の封筒を送ると、検証の側だけが台帳の形を求め、モデルには届かない。次の順で選ぶ：
 *
 *   1. 段の schema が選んだ封筒の枝と等しい … その封筒の実体（旗 off と v1 は今までとバイト列で同じ。v1.2 は
 *      旗の組から導いた一覧なので、`--pipeline v1.2` の全段が同じ実体になる。Issue #588）
 *   2. v1.1α の封筒で、段の schema が旗 on の封筒の枝と等しい … 旗 on の封筒（library の呼び手が `v1.1a` を渡した
 *      ときの振る舞い。入口の v1.2 の走りは識別子 `v1.2` を渡すので、ここを通らない）
 *   3. どちらでもない … 選んだ封筒のその段の枝だけを段の schema に差し替えた封筒（段ごとに組む）
 */
export function resolveStageEnvelope(
  schemaName: string,
  schema: unknown,
  envelope: EnvelopeId = "v1",
): ResolvedStageEnvelope | undefined {
  const selected = envelopeOf(envelope);
  const entry = selected.entries.find((candidate) => candidate.stage === schemaName);
  if (entry === undefined) return undefined;
  if (sameSchema(entry.schema, schema)) return { entry, name: selected.name, schema: selected.schema };
  if (envelope === "v1.1a") {
    const ledgerEntry = STAGE_ENVELOPE_ENTRIES_V12_LEDGER.find((candidate) => candidate.stage === schemaName);
    if (ledgerEntry !== undefined && sameSchema(ledgerEntry.schema, schema)) {
      return { entry: ledgerEntry, name: selected.name, schema: ENVELOPE_SCHEMA_V12_LEDGER };
    }
  }
  const replaced: StageEnvelopeEntry = { stage: entry.stage, schema };
  return {
    entry: replaced,
    name: selected.name,
    schema: buildEnvelopeSchema(selected.entries.map((candidate) => (candidate === entry ? replaced : candidate))),
  };
}
