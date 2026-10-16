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
import { NAME_TABLE_SCHEMA, NAME_TABLE_SCHEMA_NAME } from "./v11a/stages/name-table.js";
import { SEMANTIC_CHECK_SCHEMA, SEMANTIC_CHECK_SCHEMA_NAME } from "./v11a/stages/semantic-check.js";
import { TEST_SPEC_SCHEMA, TEST_SPEC_SCHEMA_NAME } from "./v11a/stages/test-spec.js";
import { DECLARATION_V11A_SCHEMA, WRITE_V11A_SCHEMA_NAME } from "./v11a/stages/write.js";

/** 封筒の識別子（adapter が選ぶ。既定は v1） */
export const ENVELOPE_IDS = ["v1", "v1.1a"] as const;

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

/** 封筒の識別子から封筒を引く（v1 は今までと同じ名前・同じ実体） */
export function envelopeOf(envelope: EnvelopeId = "v1"): StageEnvelope {
  return envelope === "v1.1a"
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
