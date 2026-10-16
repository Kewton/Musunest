// B1 書く（v1.1α。07-architecture-v1.1a.md §1 の表・D4。Issue #509）。
//
// 確定した仕様・名前の表（全行）・固定した試験・文書から、宣言（app.spec.yaml の原文）を書く。
// v1 の ③ と違い、**対応（mappings）の提出は無い**——名前は表で固定済みで、builder は表の名前どおりに書く。
// 対応は A1 の恒等の写し（`identityMappings`）がコードで作る。名前の推測が無いので、③ の対応の出し直し
// （`correspondenceRedos`）は呼ばない。
//
// 表に無い補助の要素は、要件に要るときだけ足せる（D4）。**その一覧はこの段では作らない**——A1 の
// `extraElementsOf` が唯一の正本で、B2 のあとに A5 が呼んで B3' に渡す（二重の抽出を置かない）。
//
// 共通の口（`CallGateway`）を通してだけ LLM を呼ぶ。v1 の ③ の規則・schema・`runWrite` は変えない。
import type { CallGateway } from "../../call.js";
import type { TestSuite } from "../../fixed-test.js";
import { checkDeclarationBytes } from "../../limits.js";
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
  type StageOutcome,
} from "../../stages/prompt.js";
import { utf8ByteLength } from "../../stages/write.js";
import { sha256Hex } from "@musunest/spec-engine";
import type { NameTable } from "../names.js";

/** B1 の JSON Schema の名前 */
export const WRITE_V11A_SCHEMA_NAME = "declaration-v11a";

/** B1 のデータの名前（この順に並べる。文書は共通の `documents` の口で渡す） */
export const WRITE_V11A_DATA_NAMES = ["確定した仕様", "名前の表", "固定した試験"] as const;

/**
 * B1 に足す規則の定義。**送る文は `text` から組む**。ID は `R-w11-nn`。
 */
export const WRITE_V11A_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-w11-01",
    text: "確定した仕様・名前の表・固定した試験・文書に従って、宣言（app.spec.yaml の原文）を 1 つ書く。",
    why: "確定した入力から宣言を 1 つ書かせる（D4）",
    since: "Issue #509",
  },
  {
    id: "R-w11-02",
    text: "宣言は 7 欄（entities・views・actions・validations・computed・permissions・minIdentity）をすべて書く。中身が無ければ `[]` と書く。",
    why: "宣言の 7 欄をすべて書かせ、中身が無い欄も明示させる",
    since: "Issue #509",
  },
  {
    id: "R-w11-03",
    text: "文書（契約・語彙の意味・語彙の台帳）に無い語彙・キー・関数を使わない。",
    why: "文書に無い語彙・キー・関数を使わせない（v1 の R-write-03 と同じ）",
    since: "Issue #509",
  },
  {
    id: "R-w11-04",
    text: "名前の表の各行の `name` を、宣言でそのまま使う。別の名前に付け替えない。表の行の `id` は宣言に書かない。",
    why: "名前の推測を無くす。対応は表の恒等の写しがコードで作るので、名前の食い違いは照合で落ちる（D4）",
    since: "Issue #509",
  },
  {
    id: "R-w11-05",
    text: "項目の型は表の `type` のとおりに書く。選択肢（enum）の項目の `options` は、表の `options` のキーを同じ順で使う。参照の項目と参照の並びは、表の `refEntity` が指す entity を参照先に書く。",
    why: "型・選択肢の順・参照先を表から外させない（宣言と固定する試験の表現を揃える）",
    since: "Issue #509",
  },
  {
    id: "R-w11-06",
    text: "見出しごとの集計の `groupBy` は、表の `groupBy` が指す項目で分ける。種類が月（month）のときは、その日付の項目を月ごとに分ける。",
    why: "見出しごとの集計の分け方（enum の値ごと・月ごと）を表のとおりに書かせる",
    since: "Issue #509",
  },
  {
    id: "R-w11-07",
    text: "表に無い補助の要素（計算・検査など）は、要件に要るときだけ足してよい。ただし表の名前を奪わない（表にある名前を別の要素に使わない）。",
    why: "補助の要素を許しつつ、表の名前の取り違えを防ぐ（D4。一覧は A1 の関数が作る）",
    since: "Issue #509",
  },
  {
    id: "R-w11-08",
    text: "固定した試験と名前の表は変えられない。試験に合わせて表の名前や型を変えず、表と試験が指すものを宣言に書く。",
    why: "builder から試験と表を変えさせない（試験は宣言を見る前に固定する）",
    since: "Issue #509",
  },
  {
    id: "R-w11-09",
    text: "出力は応答の declaration 欄に、YAML の原文として入れる。説明・前置き・後書きを付けない。",
    why: "宣言を declaration 欄に原文で入れさせ、前置きを付けさせない（§2.2）",
    since: "Issue #509",
  },
];

/** B1 に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const WRITE_V11A_RULES: readonly string[] = ruleTexts(WRITE_V11A_RULE_DEFINITIONS);

/** B1 の JSON Schema（構造化出力）。宣言の原文だけを受ける（`mappings` は無い） */
export const DECLARATION_V11A_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declaration"],
  properties: {
    declaration: {
      type: "string",
      description: "宣言（app.spec.yaml）の原文（7 欄をすべて書いた YAML）",
    },
  },
} as const;

/** B1 が受け取るもの */
export interface WriteV11aInput {
  /** 確定した仕様（要件の一覧） */
  readonly list: RequirementList;
  /** 名前の表（持ち越しで除いた行も含む全行） */
  readonly table: NameTable;
  /** 固定した試験 */
  readonly suite: TestSuite;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** 形に落ちた応答を 1 候補 1 回、落ちた時点で受け取る任意の口（Issue #501 の作法。要求・回数・結果に効かない） */
  readonly onRejected?: (candidate: RejectedCandidate) => void;
}

/** B1 の出力 */
export interface WrittenDeclarationV11a {
  readonly declaration: string;
  /** 宣言（原文）の UTF-8 のバイト数 */
  readonly byteLength: number;
  /** 宣言（原文）の SHA-256 */
  readonly declarationSha256: string;
}

/** B1 の応答の形を確かめる。宣言は空でない文字列であること */
export function checkWriteV11aOutput(output: unknown): ShapeCheck<{ declaration: string }> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const problems: Problem[] = [];
  const declaration = output["declaration"];
  if (typeof declaration !== "string" || declaration === "") {
    problems.push({ field: "declaration", message: "宣言は空でない文字列（YAML の原文）であること" });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { declaration: declaration as string } };
}

/** 名前の表の全行を、B1 に見せる欄だけにする（出典・所属・確かめ方・分類は見せない） */
function tableRowsForWriter(table: NameTable): readonly unknown[] {
  return table.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    entity: row.entity,
    name: row.name,
    type: row.type,
    options: row.options,
    groupBy: row.groupBy,
    refEntity: row.refEntity,
    role: row.role,
  }));
}

/** B1 のデータ（確定した仕様・名前の表・固定した試験の順） */
function buildData(input: WriteV11aInput): readonly PromptData[] {
  return [
    { name: WRITE_V11A_DATA_NAMES[0], text: serializeJson(input.list) },
    { name: WRITE_V11A_DATA_NAMES[1], text: serializeJson(tableRowsForWriter(input.table)) },
    { name: WRITE_V11A_DATA_NAMES[2], text: serializeJson(input.suite) },
  ];
}

/**
 * B1 を 1 回呼ぶ。形が合わない応答は共通の窓口が 1 回だけやり直す。**書いた直後**に宣言の大きさの上限
 * （`declarationBytes`。③ と同じ関数）を確かめ、超えていれば `limit` で断る（静的チェックへ渡さない）。
 */
export async function runWriteV11a(input: WriteV11aInput): Promise<StageOutcome<WrittenDeclarationV11a>> {
  const request = buildStructuredRequest({
    rules: WRITE_V11A_RULES,
    documents: input.documents,
    data: buildData(input),
    schemaName: WRITE_V11A_SCHEMA_NAME,
    schema: DECLARATION_V11A_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("write"),
  });
  const onRejected = input.onRejected;
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: checkWriteV11aOutput,
    ...(onRejected === undefined
      ? {}
      : { onShapeRejected: (rejection) => onRejected(shapeRejectedCandidate(1, rejection)) }),
  });
  if (!answer.ok) return answer;
  const declaration = answer.value.declaration;
  const byteLength = utf8ByteLength(declaration);
  const exceeded = checkDeclarationBytes(byteLength);
  if (exceeded !== undefined) {
    return {
      ok: false,
      failure: { kind: "limit", limit: exceeded.limit, max: exceeded.max, actual: exceeded.actual },
    };
  }
  return { ok: true, value: { declaration, byteLength, declarationSha256: await sha256Hex(declaration) } };
}
