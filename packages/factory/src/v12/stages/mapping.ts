// C2 要件の写像（08-architecture-v1.2.md §4 の C2・C2'・§6・§9 の手 3a。Issue #593）。
//
// 旗 `v12.ids` が on の走りだけ、T1 の要件ごとの部分（所属・確かめ方・分類）を **1 回の呼び出し**で書かせる（束に分けるのは
// 手 3b）。応答は要件ごとに `{requirementId, roles, verification, nature}` で、**要件 ID と行の ID を書かせ、コードが照らす**
// （方法論 03 の H2。写し・出典・引用は無い。08 §6）。
//
//   - データ：確定した仕様（要件の種類を外す）・要件の一覧（要件 ID・文・引用）・C1 の行（**名前は見せない**）・文書の名前と制約 ID
//   - C2'（`checkMappedTable`）：要件ごとにちょうど 1 件（欠落・重複・一覧に無い ID）・所属の ID が行にある・今の T1' の (e)(g)。
//     落ちれば共通の窓口の形のやり直しで 1 回（前回の応答と問題をデータで）。2 回続けば `unmet`
//   - C3 の拒否のあとの 2 回目（呼ぶ側が `previous` を渡す）：前回の写像・拒否・印をデータで足し、**1 回だけ**呼ぶ。C2' に落ちても
//     形の再試行は無い（08 §4.1）——`unmet`（`attempts` 1）を返し、呼ぶ側は前回の写像のまま拒否の要件を持ち越す
//
// 参照の照合の数（`ReferenceCounts`）：照らした参照＝応答の要件 ID と所属の ID の全部、知らない ID＝一覧に無い要件 ID・行に無い
// 所属の ID、重複＝同じ要件 2 件・同じ要件の中の同じ行、別の束の ID＝要件 ID の欄に行の ID の形・所属の欄に一覧の要件 ID。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
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
  type Problem,
  type PromptData,
  type PromptDocument,
  type RejectedCandidate,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
} from "../../stages/prompt.js";
import {
  NAME_TABLE_VERIFICATION_KINDS,
  checkMappedTable,
  nameTableSha256,
  shapeOfMappingEntry,
  type MappingEntry,
  type NameTable,
  type NameTableRow,
} from "../../v11a/names.js";
import { planWithoutRequirementKinds, type SemanticRejection } from "../../v11a/stages/name-table.js";
import type { JudgeAdviceMarkEntry } from "../../v11a/stages/judge-advice.js";
import { ReferenceTally, idKindOf, type ReferenceCounts } from "../ids.js";
import type { LedgerView } from "../ledger.js";

/** C2 の JSON Schema の名前 */
export const MAPPING_SCHEMA_NAME = "mapping";

/** C2 の中身の回数（C3 の拒否で 1 回だけ作り直す。回すのは呼ぶ側） */
export const MAPPING_ROUNDS = 2;

/** データの塊の名前 */
export const MAPPING_DATA_NAMES = {
  plan: "確定した仕様",
  list: "要件の一覧",
  rows: "表の行",
  documents: "文書",
  response: "前回の写像",
  rejections: "表の点検の拒否",
  advice: "助言の印",
} as const;

/** C2 の規則の定義（ID は `R-map-nn`） */
export const MAPPING_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-map-01",
    text: "要件の一覧の要件ごとに 1 件ずつ、requirementId に一覧の要件 ID をそのまま書く。一覧に無い要件 ID を書かない。同じ要件を 2 件書かない。",
    why: "要件を ID で指させ、欠落・重複・一覧に無い ID をコードが照らす（方法論 03 の H2。07 の D10 の写しを廃止する。08 §6）",
    since: "Issue #593",
  },
  {
    id: "R-map-02",
    text: "roles は、その要件が使う行の所属である。id には表の行の ID をそのまま書く。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。同じ要件の中で同じ行を 2 回書かない。どの要件にも所属しない行を残さない。",
    why: "所属の根拠を持たせ、共有と entity の所属はコードが導く（T1 の R-nt-07。D9）。行の ID はコードが照らす",
    since: "Issue #593",
  },
  {
    id: "R-map-03",
    text: "verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。構造で確かめるなら kind を structural にし、reason に理由、checks に構造の検査を並べ、検査ごとに合う種類の行を所属させる。宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に根拠にした文書の制約 ID（文書の制約 ID の一覧にあるものだけ）を書く。要件の決まりが選択肢の項目の既定値だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる。使わない欄は null か空の並びにする。",
    why: "確かめ方を所属と組で固定し、書けない要件は理由と制約 ID つきで持ち越す（T1 の R-nt-08）",
    since: "Issue #593",
  },
  {
    id: "R-map-04",
    text: "nature は要件ごとの種類である。要件の文から分類する：値や振る舞いを縛る決まりを含むなら ruled、そのものが在ればよいなら existence-only にする。前回の写像・表の点検の拒否・助言の印が渡されたときは、拒否が指す要件を直した写像を返す。助言の印は参考であり、印だけを理由に所属を消さない。",
    why: "T2 の独立の分類と照らす元を要件の文だけから作らせ、2 回目に前回の写像と拒否を使わせる（T1 の R-nt-09・R-nt-10）",
    since: "Issue #593",
  },
];

/** 性質の台帳の文を差し込む規則（R-map-03。T1 の R-nt-08 と同じ作法） */
const MAPPING_LEDGER_RULE_HEAD =
  "verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。構造で確かめるなら kind を structural にし、reason に理由、checks に構造の検査を並べ、検査ごとに合う種類の行を所属させる。宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に根拠にした文書の制約 ID（文書の制約 ID の一覧にあるものだけ）を書く。";
const MAPPING_LEDGER_RULE_TAIL = "使わない欄は null か空の並びにする。";

/** C2 の規則の定義（旗 `v12.ledger` が on なら R-map-03 を台帳の文で組み直す） */
export function mappingRuleDefinitionsOf(ledger?: LedgerView): readonly RuleDefinition[] {
  if (ledger === undefined) return MAPPING_RULE_DEFINITIONS;
  return MAPPING_RULE_DEFINITIONS.map((definition) =>
    definition.id === "R-map-03"
      ? { ...definition, text: `${MAPPING_LEDGER_RULE_HEAD}${ledger.t1RuleTexts.join("")}${MAPPING_LEDGER_RULE_TAIL}` }
      : definition,
  );
}

/** C2 の JSON Schema（静的。確かめ方の kind の enum は台帳の種類の並び。strict の規則に合わせる） */
export function mappingSchemaOf(ledger?: LedgerView): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["requirements"],
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requirementId", "roles", "verification", "nature"],
          properties: {
            requirementId: { type: "string", description: "要件の一覧の要件 ID" },
            roles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "basis", "reason"],
                properties: {
                  id: { type: "string", description: "表の行の ID" },
                  basis: { type: "string", enum: [...ROLE_OWNERSHIP_BASES] },
                  reason: { type: ["string", "null"] },
                },
              },
            },
            verification: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "value", "reason", "checks", "constraintIds"],
              properties: {
                kind: { type: "string", enum: [...(ledger?.verificationKinds ?? NAME_TABLE_VERIFICATION_KINDS)] },
                value: { type: ["string", "null"], description: "確かめ方の値（選択肢のキー。ほかの種類は null）" },
                reason: { type: ["string", "null"] },
                checks: { type: "array", items: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] } },
                constraintIds: { type: "array", items: { type: "string" } },
              },
            },
            nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
          },
        },
      },
    },
  };
}

/** C3 の拒否のあとの 2 回目の材料 */
export interface MappingPrevious {
  /** 前回の写像（raw の応答） */
  readonly response: unknown;
  readonly rejections: readonly SemanticRejection[];
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** C2 が受け取るもの */
export interface MappingInput {
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** C1 が組んだ行（出典は null） */
  readonly rows: readonly NameTableRow[];
  readonly previous?: MappingPrevious;
  readonly ledger?: LedgerView;
  readonly onRejected?: (candidate: RejectedCandidate) => void;
}

/** C2 の結果（表・表の SHA-256・raw の応答）。参照の照合の数は成否によらず返す */
export type MappingOutcome =
  | {
      readonly ok: true;
      readonly value: { readonly table: NameTable; readonly tableSha256: string; readonly response: unknown };
      readonly references: ReferenceCounts;
    }
  | { readonly ok: false; readonly failure: StageFailure; readonly references: ReferenceCounts };

/** 骨組み（写像・`requirements` が写像の並び） */
function skeletonProblems(output: unknown): readonly Problem[] {
  if (!isRecord(output)) return [{ field: "", message: "応答は写像（object）であること" }];
  const items = output["requirements"];
  if (!Array.isArray(items)) return [{ field: "requirements", message: "並び（array）であること" }];
  return items.flatMap((item, index) => (isRecord(item) ? [] : [{ field: `requirements[${String(index)}]`, message: "写像（object）であること" }]));
}

/** 応答の参照を数える（純粋。ID の値は数に入れない） */
export function countMappingReferences(list: RequirementList, rows: readonly NameTableRow[], output: unknown, tally: ReferenceTally): void {
  if (!isRecord(output) || !Array.isArray(output["requirements"])) return;
  const requirementIds = new Set(list.requirements.map((requirement) => requirement.id));
  const rowIds = new Set(rows.map((row) => row.id));
  const seenRequirements = new Set<string>();
  for (const entry of output["requirements"] as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const requirementId = entry["requirementId"];
    if (typeof requirementId === "string") {
      tally.checked += 1;
      if (!requirementIds.has(requirementId)) {
        if (idKindOf(requirementId) !== null) tally.crossBundle += 1;
        else tally.unknown += 1;
      } else if (seenRequirements.has(requirementId)) tally.duplicate += 1;
      seenRequirements.add(requirementId);
    }
    const roles = Array.isArray(entry["roles"]) ? (entry["roles"] as readonly unknown[]) : [];
    const seenRoles = new Set<string>();
    for (const role of roles) {
      const id = isRecord(role) ? role["id"] : undefined;
      if (typeof id !== "string") continue;
      tally.checked += 1;
      if (!rowIds.has(id)) {
        if (requirementIds.has(id)) tally.crossBundle += 1;
        else tally.unknown += 1;
      } else if (seenRoles.has(id)) tally.duplicate += 1;
      seenRoles.add(id);
    }
  }
}

/** 応答（骨組みは通った）から表を組み、C2' を掛ける（純粋） */
export function inspectMapping(
  list: RequirementList,
  rows: readonly NameTableRow[],
  output: Record<string, unknown>,
  documents: readonly PromptDocument[],
  ledger?: LedgerView,
): { readonly ok: true; readonly table: NameTable } | { readonly ok: false; readonly problems: readonly Problem[] } {
  const problems: Problem[] = [];
  const entries = (output["requirements"] as readonly unknown[]).map((item, index) =>
    shapeOfMappingEntry(item, `requirements[${String(index)}]`, problems, ledger === undefined ? {} : { ledger }),
  );
  if (problems.length > 0) return { ok: false, problems };
  const shaped = entries as readonly MappingEntry[];
  // 一覧の順に並べる（応答の順は表の SHA に効かせない。重複・一覧に無い ID は応答の順のまま後ろに置き、C2' が落とす）
  const order = new Map(list.requirements.map((requirement, index) => [requirement.id, index] as const));
  const sorted = shaped
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (order.get(a.entry.requirementId) ?? list.requirements.length + a.index) - (order.get(b.entry.requirementId) ?? list.requirements.length + b.index) || a.index - b.index)
    .map(({ entry }) => entry);
  const table: NameTable = {
    rows,
    ownership: sorted.map((entry) => ({ requirementId: entry.requirementId, roles: entry.roles })),
    verification: sorted.map((entry) => ({ ...entry.verification, requirementId: entry.requirementId })),
    classification: sorted.map((entry) => ({ requirementId: entry.requirementId, nature: entry.nature })),
  };
  const tableProblems = checkMappedTable(list, table, documents, ledger === undefined ? {} : { ledger });
  return tableProblems.length > 0 ? { ok: false, problems: tableProblems } : { ok: true, table };
}

function rawResponseText(output: unknown): string {
  return serializeJson(output).replaceAll("<", "\\u003c");
}

/** C2 の要求のデータ（`previous` があればこの順で 3 塊を足す） */
function buildData(input: MappingInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: MAPPING_DATA_NAMES.plan, text: serializeJson(planWithoutRequirementKinds(input.plan)) },
    {
      name: MAPPING_DATA_NAMES.list,
      text: serializeJson({
        requirements: input.list.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text, quote: requirement.quote })),
      }),
    },
    {
      name: MAPPING_DATA_NAMES.rows,
      // 名前は見せない（C2・C3・T2 に名前を見せない）
      text: serializeJson(
        input.rows.map((row) => ({
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
    {
      name: MAPPING_DATA_NAMES.documents,
      text: serializeJson({ names: input.documents.map((document) => document.name), constraintIds: [...constraintIdsIn(input.documents)] }),
    },
  ];
  const previous = input.previous;
  if (previous !== undefined) {
    data.push({ name: MAPPING_DATA_NAMES.response, text: rawResponseText(previous.response) });
    data.push({
      name: MAPPING_DATA_NAMES.rejections,
      text: serializeJson(previous.rejections.map((rejection) => ({ requirementId: rejection.requirementId, kind: rejection.kind, quote: rejection.quote }))),
    });
    data.push({
      name: MAPPING_DATA_NAMES.advice,
      text: serializeJson(previous.advice.map((entry) => ({ requirementId: entry.requirementId, id: entry.id, mark: entry.mark }))),
    });
  }
  return data;
}

/**
 * C2 を 1 回回す。初回は C2' に落ちれば共通の窓口が 1 回だけ作り直させ、2 回続けば `unmet`（骨組みの形が続けば `malformed`）。
 * `previous` を渡した 2 回目は 1 回だけ呼び、C2' に落ちれば `unmet`（`attempts` 1）。
 */
export async function runMapping(input: MappingInput): Promise<MappingOutcome> {
  const { ledger } = input;
  const tally = new ReferenceTally();
  const round = input.previous === undefined ? 1 : 2;
  let lastWasSkeleton = false;
  const inspect = (output: unknown): ShapeCheck<NameTable> => {
    const skeleton = skeletonProblems(output);
    lastWasSkeleton = skeleton.length > 0;
    if (skeleton.length > 0) return { ok: false, problems: skeleton };
    countMappingReferences(input.list, input.rows, output, tally);
    const inspected = inspectMapping(input.list, input.rows, output as Record<string, unknown>, input.documents, ledger);
    return inspected.ok ? { ok: true, value: inspected.table } : inspected;
  };
  const request = buildStructuredRequest({
    rules: ruleTexts(mappingRuleDefinitionsOf(ledger)),
    documents: input.documents,
    data: buildData(input),
    schemaName: MAPPING_SCHEMA_NAME,
    schema: mappingSchemaOf(ledger),
    maxOutputTokens: input.gateway.maxOutputTokens("name-table"),
  });
  const onRejected = input.onRejected;
  const onShapeRejected =
    onRejected === undefined ? {} : { onShapeRejected: (rejection: Parameters<typeof shapeRejectedCandidate>[1]) => onRejected(shapeRejectedCandidate(round, rejection)) };
  if (round === 2) {
    // 2 回目は形の再試行を持たない（08 §4.1）：窓口には骨組みだけを掛けさせ、C2' は 1 回だけ掛ける
    let inspected: ShapeCheck<NameTable> | undefined;
    const answer = await callStructuredChecked(input.gateway, {
      request,
      check: (output) => {
        inspected = inspect(output);
        return { ok: true, value: output };
      },
    });
    if (!answer.ok) return { ok: false, failure: answer.failure, references: tally.counts };
    const result = inspected as ShapeCheck<NameTable>;
    if (!result.ok) {
      onRejected?.({ kind: "shape", round, attempt: 1, response: answer.output, problems: result.problems.map((problem) => ({ ...problem, reference: "response" })) });
      return { ok: false, failure: { kind: "unmet", attempts: 1, problems: result.problems }, references: tally.counts };
    }
    return { ok: true, value: { table: result.value, tableSha256: await nameTableSha256(result.value), response: answer.output }, references: tally.counts };
  }
  const answer = await callStructuredChecked(input.gateway, { request, check: inspect, ...onShapeRejected });
  if (answer.ok) {
    return { ok: true, value: { table: answer.value, tableSha256: await nameTableSha256(answer.value), response: answer.output }, references: tally.counts };
  }
  const failure: StageFailure =
    answer.failure.kind === "malformed" && !lastWasSkeleton
      ? { kind: "unmet", attempts: answer.failure.attempts, problems: answer.failure.problems }
      : answer.failure;
  return { ok: false, failure, references: tally.counts };
}
