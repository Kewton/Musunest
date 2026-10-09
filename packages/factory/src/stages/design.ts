// ② 設計する（02-architecture.md §1・F-4・F-5・F-7・F-8・Issue #307）。
//
// 要件ごとに、使う語彙と置き場所、そして**書けない部分**を返す。書けない部分は、その部分だけを
// 落とし、残りの書ける部分は残す設計にさせる（F-4）。無い語彙・キー・関数を作らせない（F-5）。
// ② には要件の一覧だけを渡す（宣言はまだ無い）。
//
// Issue #307 で、② の出力に次を足した（疎通の確認で、固定した試験が宣言の要素に結び付かなかった）：
//   - **役割 ID の表**（entity の文脈を含む ID・対象の種類・所属の entity。共有と別名は明示の欄でだけ許す）
//   - 要件ごとの**種類**（決まりを含む／在ることだけ）と**確かめ方**（固定した試験／構造の条件／未解決）
//
// 形（`checkDesignOutput`）と**中身の点検**（`checkDesignPlan`）を分ける。形の確認は旧形式の記録
// （役割 ID の表・種類・確かめ方が無い）も通す（後方互換）。中身の点検は、新しい欄を持つ設計にだけ
// 掛ける（`isPlannedDesign`）——旧形式の記録を壊さず、新しい設計は必須の欄を満たすことを強制する。
import type {
  DesignResult,
  RequirementDesign,
  RequirementList,
  RequirementVerification,
  RoleEntry,
} from "../pipeline.js";
import { REQUIREMENT_VERIFICATION_KINDS } from "../pipeline.js";
import { REQUIREMENT_NATURES, TEST_TARGET_KINDS, isRequirementNature } from "../fixed-test.js";
import type { CallGateway } from "../call.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  isRecord,
  serializeJson,
  type Problem,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ② の JSON Schema の名前 */
export const DESIGN_SCHEMA_NAME = "requirement-design";

/** ② に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const DESIGN_RULES: readonly string[] = [
  "要件ごとに、使う語彙と、宣言のどの欄に置くか（placement）を決める。",
  "書けない部分は、その部分だけを unwritable に挙げる。書ける部分は残す（部分的に書けない要件でも、書ける部分は書く）。",
  "文書（契約・語彙の意味・語彙の台帳）に無い語彙・キー・関数は作らない。書けないものを、近い別の意味に書き換えない。",
  "要件ごとに 1 つの設計を返す。要件 ID は一覧のまま写す。",
  "役割 ID の表（roles）を作る。役割 ID は entity の文脈を含む ID（例 member・member.name・session.bookCount）にし、対象の種類（kind）と、所属の entity の役割 ID（entity）を付ける。entity 自身の行は entity を null にする。",
  "同じ名前の対象を複数の役割 ID にするときは、共有（shared を true）か別名（aliasOf を元の役割 ID）を明示する。明示しなければ、同じ名前の対象を 1 つの役割 ID にまとめる。",
  "同名の別 entity を同じ役割 ID にしない。別 entity の同名の対象は、別の役割 ID にする。",
  "要件ごとに、種類（nature）を決める。決まり（条件・計算・検査）を含むなら ruled、在ることだけ（例「名前を持つメンバーを登録できる」）なら existence-only。",
  "要件ごとに、確かめ方（verification）を決める。固定した試験で確かめるなら fixed-test、構造の条件で確かめるなら structural、いまは確かめられないなら unresolved。fixed-test 以外は reason（理由）を書く。",
];

/** ② の JSON Schema（構造化出力。strict の規則に合わせる） */
export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roles", "designs"],
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["roleId", "kind", "entity", "name", "shared", "aliasOf"],
        properties: {
          roleId: { type: "string", description: "役割 ID（entity の文脈を含む。例 member.name）" },
          kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
          entity: { type: ["string", "null"], description: "所属の entity の役割 ID（entity 自身は null）" },
          name: { type: "string", description: "対象の名前（役割 ID の中の呼び名）" },
          shared: { type: "boolean", description: "共有を明示したか（複数の要件が同じ entity を使う）" },
          aliasOf: { type: ["string", "null"], description: "別名なら元の役割 ID（別名でなければ null）" },
        },
      },
    },
    designs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "nature", "verification", "vocabulary", "placement", "unwritable"],
        properties: {
          requirementId: { type: "string" },
          nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
          verification: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: {
              kind: { type: "string", enum: [...REQUIREMENT_VERIFICATION_KINDS] },
              reason: {
                type: ["string", "null"],
                description: "試験を作らないときの理由（fixed-test のときは null）",
              },
            },
          },
          vocabulary: { type: "array", items: { type: "string" } },
          placement: { type: "array", items: { type: "string" } },
          unwritable: { type: "array", items: { type: "string" }, description: "書けない部分（無ければ空）" },
        },
      },
    },
  },
} as const;

/** ② が受け取るもの */
export interface DesignInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** 役割 ID の表の 1 行の形を確かめる */
function checkRoleEntry(value: unknown, field: string, problems: Problem[]): RoleEntry | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "役割 ID の表の行は写像（object）であること" });
    return undefined;
  }
  let good = true;
  const roleId = value["roleId"];
  if (typeof roleId !== "string" || roleId === "") {
    problems.push({ field: `${field}.roleId`, message: "役割 ID は空でない文字列であること" });
    good = false;
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(TEST_TARGET_KINDS as readonly string[]).includes(kind)) {
    problems.push({ field: `${field}.kind`, message: `対象の種類は ${TEST_TARGET_KINDS.join("・")} のいずれかであること` });
    good = false;
  }
  const entity = value["entity"];
  if (entity !== null && (typeof entity !== "string" || entity === "")) {
    problems.push({ field: `${field}.entity`, message: "所属の entity の役割 ID は空でない文字列か null であること" });
    good = false;
  }
  const name = value["name"];
  if (typeof name !== "string" || name === "") {
    problems.push({ field: `${field}.name`, message: "対象の名前は空でない文字列であること" });
    good = false;
  }
  const shared = value["shared"];
  if (typeof shared !== "boolean") {
    problems.push({ field: `${field}.shared`, message: "共有の印は真偽（boolean）であること" });
    good = false;
  }
  const aliasOf = value["aliasOf"];
  if (aliasOf !== null && (typeof aliasOf !== "string" || aliasOf === "")) {
    problems.push({ field: `${field}.aliasOf`, message: "別名の元の役割 ID は空でない文字列か null であること" });
    good = false;
  }
  if (!good) return undefined;
  return {
    roleId: roleId as string,
    kind: kind as RoleEntry["kind"],
    entity: entity as string | null,
    name: name as string,
    shared: shared as boolean,
    aliasOf: aliasOf as string | null,
  };
}

/** 確かめ方の形を確かめる（fixed-test 以外は理由が要る） */
function checkVerification(value: unknown, field: string, problems: Problem[]): RequirementVerification | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "確かめ方は写像（object）であること" });
    return undefined;
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(REQUIREMENT_VERIFICATION_KINDS as readonly string[]).includes(kind)) {
    problems.push({ field: `${field}.kind`, message: `確かめ方は ${REQUIREMENT_VERIFICATION_KINDS.join("・")} のいずれかであること` });
    return undefined;
  }
  if (kind === "fixed-test") return { kind: "fixed-test" };
  const reason = value["reason"];
  if (typeof reason !== "string" || reason === "") {
    problems.push({ field: `${field}.reason`, message: `確かめ方 ${kind} には理由（reason）が要る（空でない文字列）` });
    return undefined;
  }
  return { kind: kind as "structural" | "unresolved", reason };
}

function checkDesign(value: unknown, field: string, problems: Problem[]): RequirementDesign | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "設計は写像（object）であること" });
    return undefined;
  }
  const requirementId = value["requirementId"];
  const validId = typeof requirementId === "string" && requirementId !== "";
  if (!validId) {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
  }
  const natureRaw = value["nature"];
  let nature: RequirementDesign["nature"];
  if (natureRaw !== undefined) {
    if (!isRequirementNature(natureRaw)) {
      problems.push({ field: `${field}.nature`, message: `種類は ${REQUIREMENT_NATURES.join("・")} のいずれかであること` });
    } else {
      nature = natureRaw;
    }
  }
  const verificationRaw = value["verification"];
  const verification =
    verificationRaw === undefined ? undefined : checkVerification(verificationRaw, `${field}.verification`, problems);
  const vocabulary = checkStringArray(value["vocabulary"], `${field}.vocabulary`, problems);
  const placement = checkStringArray(value["placement"], `${field}.placement`, problems);
  const unwritable = checkStringArray(value["unwritable"], `${field}.unwritable`, problems);
  if (
    !validId ||
    vocabulary === undefined ||
    placement === undefined ||
    unwritable === undefined ||
    (verificationRaw !== undefined && verification === undefined)
  ) {
    return undefined;
  }
  return {
    requirementId: requirementId as string,
    ...(nature === undefined ? {} : { nature }),
    ...(verification === undefined ? {} : { verification }),
    vocabulary,
    placement,
    unwritable,
  };
}

/** ② の応答の形を確かめる（新しい欄は、あるときだけ形を見る。旧形式の記録は省ける） */
export function checkDesignOutput(output: unknown): ShapeCheck<DesignResult> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["designs"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "designs", message: "設計の並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const designs: RequirementDesign[] = [];
  raw.forEach((item, index) => {
    const checked = checkDesign(item, `designs[${index}]`, problems);
    if (checked !== undefined) designs.push(checked);
  });
  let roles: readonly RoleEntry[] | undefined;
  const rawRoles = output["roles"];
  if (rawRoles !== undefined) {
    if (!Array.isArray(rawRoles)) {
      problems.push({ field: "roles", message: "役割 ID の表は並び（array）であること" });
    } else {
      const entries: RoleEntry[] = [];
      let good = true;
      rawRoles.forEach((item, index) => {
        const checked = checkRoleEntry(item, `roles[${index}]`, problems);
        if (checked === undefined) good = false;
        else entries.push(checked);
      });
      if (good) roles = entries;
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { ...(roles === undefined ? {} : { roles }), designs } };
}

/** 新しい欄（役割 ID の表・種類・確かめ方）を持つ設計か（中身の点検を掛けるかの判定） */
export function isPlannedDesign(design: DesignResult): boolean {
  if (design.roles !== undefined) return true;
  return design.designs.some((entry) => entry.nature !== undefined || entry.verification !== undefined);
}

/** 役割 ID の表の、同名の対象についての規則（§1・②・Issue #307） */
function checkRoleTable(roles: readonly RoleEntry[]): readonly Problem[] {
  const problems: Problem[] = [];
  // 同じ役割 ID は 1 つに決まること（同じ役割 ID を別の名前・別の entity に使い回さない）
  const firstById = new Map<string, RoleEntry>();
  roles.forEach((entry, index) => {
    const previous = firstById.get(entry.roleId);
    if (previous === undefined) {
      firstById.set(entry.roleId, entry);
      return;
    }
    if (previous.name !== entry.name || previous.entity !== entry.entity) {
      problems.push({
        field: `roles[${index}]`,
        message: `役割 ID ${entry.roleId} を、別の対象（名前 ${previous.name}・所属 ${String(previous.entity)}）に使い回している（1 つの役割 ID は 1 つの対象にだけ使う）`,
      });
    }
  });
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      const a = roles[i];
      const b = roles[j];
      if (a === undefined || b === undefined || a.name !== b.name) continue;
      if (a.entity !== b.entity) {
        // 同名の別 entity を同じ役割 ID にした（潰した）
        if (a.roleId === b.roleId) {
          problems.push({
            field: `roles[${j}]`,
            message: `同名の別 entity（${String(a.entity)} と ${String(b.entity)}）を同じ役割 ID ${a.roleId} にしている`,
          });
        }
        continue;
      }
      if (a.roleId !== b.roleId) {
        // 同じ名前の対象が、共有も別名も明示せずに複数の役割 ID になっている
        const declared = a.shared || b.shared || a.aliasOf !== null || b.aliasOf !== null;
        if (!declared) {
          problems.push({
            field: `roles[${j}]`,
            message: `同じ名前 ${a.name} の対象が、共有も別名も明示せずに ${a.roleId} と ${b.roleId} の 2 つの役割 ID になっている`,
          });
        }
      }
    }
  }
  return problems;
}

/**
 * 設計の中身を、要件の一覧に照らして確かめる（§1・②・Issue #307）。合わない欄を**すべて**挙げて返す。
 *
 *   - 役割 ID の表がある（空でない）
 *   - 一覧の要件 ID ごとに、設計が 1 つあり、種類（nature）と確かめ方（verification）がある
 *   - fixed-test 以外の確かめ方には理由がある
 *   - 同名の対象の規則（共有・別名の明示、同名の別 entity を潰さない）
 */
export function checkDesignPlan(list: RequirementList, design: DesignResult): readonly Problem[] {
  const problems: Problem[] = [];
  const roles = design.roles;
  if (roles === undefined || roles.length === 0) {
    problems.push({ field: "roles", message: "役割 ID の表は空でない並びであること" });
  } else {
    problems.push(...checkRoleTable(roles));
  }

  const byId = new Map<string, RequirementDesign>();
  for (const entry of design.designs) {
    if (byId.has(entry.requirementId)) {
      problems.push({ field: "designs", message: `要件 ID ${entry.requirementId} の設計が重なっている` });
    }
    byId.set(entry.requirementId, entry);
  }
  const idSet = new Set(list.requirements.map((requirement) => requirement.id));
  for (const entry of design.designs) {
    if (!idSet.has(entry.requirementId)) {
      problems.push({ field: "designs", message: `一覧に無い要件 ID: ${entry.requirementId}` });
    }
  }
  for (const requirement of list.requirements) {
    const entry = byId.get(requirement.id);
    if (entry === undefined) {
      problems.push({ field: "designs", message: `要件 ${requirement.id} の設計が無い` });
      continue;
    }
    if (entry.nature === undefined) {
      problems.push({ field: "designs", message: `要件 ${requirement.id} に種類（決まりを含む／在ることだけ）が無い` });
    }
    if (entry.verification === undefined) {
      problems.push({ field: "designs", message: `要件 ${requirement.id} に確かめ方が無い` });
    }
  }
  return problems;
}

/** ② を 1 回呼ぶ。データは要件の一覧だけである */
export async function runDesign(input: DesignInput): Promise<StageOutcome<DesignResult>> {
  const request = buildStructuredRequest({
    rules: DESIGN_RULES,
    documents: input.documents,
    data: [{ name: "要件の一覧", text: serializeJson(input.list) }],
    schemaName: DESIGN_SCHEMA_NAME,
    schema: DESIGN_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("design"),
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: checkDesignOutput });
  if (!answer.ok) return answer;
  // 新しい欄を持つ設計（本番の応答）だけ、中身の点検を掛ける。旧形式の記録（試験の fixture）は通す
  if (isPlannedDesign(answer.value)) {
    const problems = checkDesignPlan(input.list, answer.value);
    if (problems.length > 0) {
      return { ok: false, failure: { kind: "unmet", attempts: 1, problems } };
    }
  }
  return answer;
}
