// C2 要件の写像（08-architecture-v1.2.md §4 の C2・C2'・§4.1・§6・§9 の手 3a・3b。Issue #593・#594）。
//
// 旗 `v12.ids` が on の走りだけ、T1 の要件ごとの部分（所属・確かめ方・分類）を、要件の一覧を一覧の順に **5 件ごとに切った束**
// （最後の束は 5 未満でよい）ごとに 1 回ずつ書かせる。応答は要件ごとに `{requirementId, roles, verification, nature}` で、
// **要件 ID と行の ID を書かせ、コードが照らす**（方法論 03 の H2。写し・出典・引用は無い。08 §6）。
//
//   - データ：確定した仕様（要件の種類を外し、要件はその束の分だけ）・その束の要件（要件 ID・文・引用）・C1 の全行（**名前は
//     見せない**）・文書の名前と制約 ID。規則と schema は束で変わらない（静的。v1.2 の封筒のまま）
//   - 束の C2'（`inspectMappingBundle`）：束の完全性（その束の要件にちょうど 1 件。欠落・重複・一覧に無い ID・別の束の要件 ID）・
//     構造の検査の対象（`checkCheckTargets`）・所属の ID が行にある・今の T1' の (e)(g) を**その束の要件に**掛ける（要件ごとの
//     検査は要件の外を見ないので、表全体に掛けたときと同じ問題が出る）。落ちれば共通の窓口の形のやり直しで**その束だけ** 1 回
//     （前回の応答と問題をデータで。束ごとの回数は共有しない）。2 回続けば `unmet`
//   - 表全体の C2'（`assembleMappedTable`）：全束がそろったら一覧の順に 1 つの表に組み、C2' を 1 回掛ける。ここで残るのは要件に
//     帰属しない問題（どの要件にも所属しない行）だけで、束を推測せず固定文で止める（呼ぶ側が `mapping`・`unmet` にする）
//   - C3 の拒否のあとの 2 回目（呼ぶ側が `previous` を渡す）：拒否された要件を含む束だけを、前回のその束の応答・その束の拒否・
//     印をデータで足して **1 回だけ**呼ぶ。束の C2' に落ちても形の再試行は無い（08 §4.1）——`unmet`（`attempts` 1）を返し、
//     呼ぶ側はその束を前回の写像のまま、拒否の要件を持ち越す
//
// 構造の検査の対象の欄（Issue #594。方法論 03 の F4・H1・H2）：`verification.checks` は `[{check, targetId, sourceId}]` の並び。
// コードが対象の実在・種類・view-shows の対を照らし、対象の行を所属に足す（basis dependency・reason に検査の種類）。
//
// 参照の照合の数（`ReferenceCounts`。束ごとの記録に載せる）：照らした参照＝応答の要件 ID・所属の ID・検査の対象の ID の全部、
// 知らない ID＝一覧に無い要件 ID・行に無い所属や対象の ID、重複＝同じ要件 2 件・同じ要件の中の同じ行、別の束の ID＝一覧にあるが
// この束に無い要件 ID・要件 ID の欄に行の ID の形・所属や対象の欄に一覧の要件 ID。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import { REQUIREMENT_NATURES, STRUCTURAL_ASSERTIONS, isStructuralAssertionKind } from "../../fixed-test.js";
import { ROLE_OWNERSHIP_BASES, type Requirement, type RequirementList } from "../../pipeline.js";
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
  checkCheckTargets,
  checkMappedTable,
  nameTableSha256,
  ownershipWithCheckTargets,
  shapeOfMappingEntry,
  type MappingEntry,
  type NameTable,
  type NameTableCheckTarget,
  type NameTableRow,
} from "../../v11a/names.js";
import { planWithoutRequirementKinds, type SemanticRejection } from "../../v11a/stages/name-table.js";
import type { JudgeAdviceMarkEntry } from "../../v11a/stages/judge-advice.js";
import { ReferenceTally, idKindOf, type ReferenceCounts } from "../ids.js";
import type { LedgerView } from "../ledger.js";

/** C2 の JSON Schema の名前 */
export const MAPPING_SCHEMA_NAME = "mapping";

/** C2 の中身の回数（C3 の拒否で、拒否された要件を含む束だけ 1 回作り直す。回すのは呼ぶ側） */
export const MAPPING_ROUNDS = 2;

/** C2 の束の大きさ（要件の一覧を一覧の順にこの件数ごとに切る。最後の束は少なくてよい。08 §4.1） */
export const MAPPING_BUNDLE_SIZE = 5;

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

/** 束の完全性の固定文（欠落・重複・一覧に無い ID は表の検査と同じ文。別の束の要件 ID は束の文） */
export const MAPPING_BUNDLE_MESSAGES = {
  missing: "要件の所属が無い",
  duplicate: "同じ要件の項目が重なっている",
  unknown: "一覧に無い要件 ID である",
  crossBundle: "別の束の要件 ID である（この束の要件ではない）",
  checksShape: `checks は検査ごとの写像（check は ${STRUCTURAL_ASSERTIONS.join("・")} のいずれか、targetId は空でない文字列、sourceId は文字列か null）の並びであること`,
} as const;

/** 構造の検査の書き方（R-map-03 と台帳の文の頭で同じ文） */
const STRUCTURAL_RULE_TEXT =
  "構造で確かめるなら kind を structural にし、reason に理由、checks に構造の検査を 1 件ずつ並べる。検査ごとに check に検査の種類、targetId に検査が見る行の ID（field-type は項目、action-kind・action-unconditioned・write-anonymous は操作、view-shows は画面、aggregate-no-period は計算）、sourceId に view-shows なら画面と同じ entity の項目か計算の行の ID（entity を持たない画面は entity を持たない計算の ID）、ほかの検査は null を書く。検査の対象の行はコードが所属に足す。";

/** C2 の規則の定義（ID は `R-map-nn`） */
export const MAPPING_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-map-01",
    text: "要件の一覧の要件ごとに 1 件ずつ、requirementId に一覧の要件 ID をそのまま書く。一覧に無い要件 ID を書かない。同じ要件を 2 件書かない。",
    why: "要件を ID で指させ、欠落・重複・一覧に無い ID・別の束の ID をコードが照らす（方法論 03 の H2。07 の D10 の写しを廃止する。08 §6）。一覧は束の要件だけを渡す（08 §4.1）",
    since: "Issue #593（束ごとの一覧は Issue #594）",
  },
  {
    id: "R-map-02",
    text: "roles は、その要件が使う行の所属である。id には表の行の ID をそのまま書く。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。同じ要件の中で同じ行を 2 回書かない。どの要件にも所属しない行を残さない。",
    why: "所属の根拠を持たせ、共有と entity の所属はコードが導く（T1 の R-nt-07。D9）。行の ID はコードが照らす",
    since: "Issue #593",
  },
  {
    id: "R-map-03",
    text: `verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。${STRUCTURAL_RULE_TEXT}宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に根拠にした文書の制約 ID（文書の制約 ID の一覧にあるものだけ）を書く。要件の決まりが選択肢の項目の既定値だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる。使わない欄は null か空の並びにする。`,
    why: "確かめ方を所属と組で固定し、書けない要件は理由と制約 ID つきで持ち越す（T1 の R-nt-08）。構造の検査の対象は規則の文で所属を求めず、応答の欄で行の ID を書かせて対と所属をコードが導く（方法論 03 の F4・H1・H2）",
    since: "Issue #593（構造の検査の対象の欄は Issue #594）",
  },
  {
    id: "R-map-04",
    text: "nature は要件ごとの種類である。要件の文から分類する：値や振る舞いを縛る決まりを含むなら ruled、そのものが在ればよいなら existence-only にする。前回の写像・表の点検の拒否・助言の印が渡されたときは、拒否が指す要件を直した写像を返す。助言の印は参考であり、印だけを理由に所属を消さない。",
    why: "T2 の独立の分類と照らす元を要件の文だけから作らせ、2 回目に前回の写像と拒否を使わせる（T1 の R-nt-09・R-nt-10）",
    since: "Issue #593",
  },
];

/** 性質の台帳の文を差し込む規則（R-map-03。T1 の R-nt-08 と同じ作法） */
const MAPPING_LEDGER_RULE_HEAD = `verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。${STRUCTURAL_RULE_TEXT}宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に根拠にした文書の制約 ID（文書の制約 ID の一覧にあるものだけ）を書く。`;
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
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["check", "targetId", "sourceId"],
                    properties: {
                      check: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] },
                      targetId: { type: "string", description: "検査が見る行の ID" },
                      sourceId: { type: ["string", "null"], description: "view-shows の組の行の ID（ほかの検査は null）" },
                    },
                  },
                },
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

/** C2 の束 1 つ（添字は 1 から。要件は一覧の順） */
export interface MappingBundle {
  readonly index: number;
  readonly requirements: readonly Requirement[];
}

/** 要件の一覧を一覧の順に `MAPPING_BUNDLE_SIZE` 件ごとの束に切る（要件 0 件なら束 0） */
export function mappingBundlesOf(list: RequirementList): readonly MappingBundle[] {
  const bundles: MappingBundle[] = [];
  for (let start = 0; start < list.requirements.length; start += MAPPING_BUNDLE_SIZE) {
    bundles.push({ index: bundles.length + 1, requirements: list.requirements.slice(start, start + MAPPING_BUNDLE_SIZE) });
  }
  return bundles;
}

/** C3 の拒否のあとの 2 回目の材料（その束の分だけ） */
export interface MappingPrevious {
  /** 前回のその束の写像（raw の応答） */
  readonly response: unknown;
  readonly rejections: readonly SemanticRejection[];
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** C2 の束 1 つが受け取るもの */
export interface MappingBundleInput {
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly bundle: MappingBundle;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** C1 が組んだ行（出典は null） */
  readonly rows: readonly NameTableRow[];
  readonly previous?: MappingPrevious;
  readonly ledger?: LedgerView;
  readonly onRejected?: (candidate: RejectedCandidate) => void;
}

/** 束の写像（その束の要件ごとの 1 件。所属に検査の対象の行を足した後。束の要件の順） */
export interface MappedBundle {
  readonly entries: readonly MappingEntry[];
  /** raw の応答（2 回目の「前回の写像」に渡す） */
  readonly response: unknown;
}

/** C2 の束 1 つの結果。参照の照合の数は成否によらず返す */
export type MappingBundleOutcome =
  | { readonly ok: true; readonly value: MappedBundle; readonly references: ReferenceCounts }
  | { readonly ok: false; readonly failure: StageFailure; readonly references: ReferenceCounts };

/** 骨組み（写像・`requirements` が写像の並び） */
function skeletonProblems(output: unknown): readonly Problem[] {
  if (!isRecord(output)) return [{ field: "", message: "応答は写像（object）であること" }];
  const items = output["requirements"];
  if (!Array.isArray(items)) return [{ field: "requirements", message: "並び（array）であること" }];
  return items.flatMap((item, index) => (isRecord(item) ? [] : [{ field: `requirements[${String(index)}]`, message: "写像（object）であること" }]));
}

const checksOf = (entry: Record<string, unknown>): readonly unknown[] => {
  const verification = entry["verification"];
  return isRecord(verification) && Array.isArray(verification["checks"]) ? (verification["checks"] as readonly unknown[]) : [];
};

/** 束の応答の参照を数える（純粋。ID の値は数に入れない） */
export function countMappingReferences(
  list: RequirementList,
  bundle: MappingBundle,
  rows: readonly NameTableRow[],
  output: unknown,
  tally: ReferenceTally,
): void {
  if (!isRecord(output) || !Array.isArray(output["requirements"])) return;
  const requirementIds = new Set(list.requirements.map((requirement) => requirement.id));
  const bundleIds = new Set(bundle.requirements.map((requirement) => requirement.id));
  const rowIds = new Set(rows.map((row) => row.id));
  const seenRequirements = new Set<string>();
  /** 行を指す欄の ID（所属・検査の対象）を数える。`seen` を渡せば重複を数える */
  const countRowId = (id: unknown, seen?: Set<string>): void => {
    if (typeof id !== "string") return;
    tally.checked += 1;
    if (!rowIds.has(id)) {
      if (requirementIds.has(id)) tally.crossBundle += 1;
      else tally.unknown += 1;
    } else if (seen?.has(id) === true) tally.duplicate += 1;
    seen?.add(id);
  };
  for (const entry of output["requirements"] as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const requirementId = entry["requirementId"];
    if (typeof requirementId === "string") {
      tally.checked += 1;
      if (!bundleIds.has(requirementId)) {
        if (requirementIds.has(requirementId) || idKindOf(requirementId) !== null) tally.crossBundle += 1;
        else tally.unknown += 1;
      } else if (seenRequirements.has(requirementId)) tally.duplicate += 1;
      seenRequirements.add(requirementId);
    }
    const roles = Array.isArray(entry["roles"]) ? (entry["roles"] as readonly unknown[]) : [];
    const seenRoles = new Set<string>();
    for (const role of roles) countRowId(isRecord(role) ? role["id"] : undefined, seenRoles);
    for (const check of checksOf(entry)) {
      if (!isRecord(check)) continue;
      countRowId(check["targetId"]);
      countRowId(check["sourceId"]);
    }
  }
}

/**
 * 応答の要件ごとの 1 件の形（検査の対象の欄を読んで検査の種類の並びに写し、所属・確かめ方・分類の形は T1 の下書きと同じ関数）。
 * 構造で確かめる要件は確かめ方に対象を持たせる。合わなければ問題に足して undefined
 */
function shapeOfBundleEntry(
  value: unknown,
  field: string,
  problems: Problem[],
  ledger?: LedgerView,
): MappingEntry | undefined {
  let targets: NameTableCheckTarget[] | undefined;
  let item = value;
  if (isRecord(value) && isRecord(value["verification"]) && Array.isArray(value["verification"]["checks"])) {
    const verification = value["verification"];
    const raw = verification["checks"] as readonly unknown[];
    const read = raw.map((check): NameTableCheckTarget | undefined =>
      isRecord(check) &&
      isStructuralAssertionKind(check["check"]) &&
      typeof check["targetId"] === "string" &&
      check["targetId"].trim() !== "" &&
      (check["sourceId"] === null || typeof check["sourceId"] === "string")
        ? { check: check["check"], targetId: check["targetId"], sourceId: check["sourceId"] }
        : undefined,
    );
    if (read.some((target) => target === undefined)) {
      problems.push({ field: `${field}.verification.checks`, message: MAPPING_BUNDLE_MESSAGES.checksShape });
      return undefined;
    }
    targets = read as NameTableCheckTarget[];
    item = { ...value, verification: { ...verification, checks: targets.map((target) => target.check) } };
  }
  const entry = shapeOfMappingEntry(item, field, problems, ledger === undefined ? {} : { ledger });
  if (entry === undefined || entry.verification.kind !== "structural") return entry;
  return { ...entry, verification: { ...entry.verification, targets: targets ?? [] } };
}

const indexedField = /^(ownership|verification|classification)\[(\d+)\](.*)$/;

/**
 * 束の応答（骨組みは通った）に束の C2' を掛ける（純粋）。束の完全性・検査の対象・その束の要件に掛けた C2'。通れば束の要件の順の
 * 写像（所属に検査の対象の行を足した後）を返す。問題の位置は応答の `requirements[j]` に写す
 */
export function inspectMappingBundle(
  list: RequirementList,
  bundle: MappingBundle,
  rows: readonly NameTableRow[],
  output: Record<string, unknown>,
  documents: readonly PromptDocument[],
  ledger?: LedgerView,
): { readonly ok: true; readonly entries: readonly MappingEntry[] } | { readonly ok: false; readonly problems: readonly Problem[] } {
  const problems: Problem[] = [];
  const items = output["requirements"] as readonly unknown[];
  const shaped = items.map((item, index) => shapeOfBundleEntry(item, `requirements[${String(index)}]`, problems, ledger));
  if (problems.length > 0) return { ok: false, problems };
  const entries = shaped as readonly MappingEntry[];

  // 束の完全性（その束の要件にちょうど 1 件）
  const listIds = new Set(list.requirements.map((requirement) => requirement.id));
  const bundleOrder = new Map(bundle.requirements.map((requirement, index) => [requirement.id, index] as const));
  const firstAt = new Map<string, number>();
  entries.forEach((entry, index) => {
    const field = `requirements[${String(index)}].requirementId`;
    if (!bundleOrder.has(entry.requirementId)) {
      problems.push({ field, message: listIds.has(entry.requirementId) ? MAPPING_BUNDLE_MESSAGES.crossBundle : MAPPING_BUNDLE_MESSAGES.unknown });
    } else if (firstAt.has(entry.requirementId)) {
      problems.push({ field, message: MAPPING_BUNDLE_MESSAGES.duplicate });
    } else {
      firstAt.set(entry.requirementId, index);
    }
  });
  bundle.requirements.forEach((requirement) => {
    if (!firstAt.has(requirement.id)) problems.push({ field: "requirements", message: MAPPING_BUNDLE_MESSAGES.missing });
  });

  // 束の要件の順に並べ、検査の対象を照らして所属に足す（対象に問題がある要件は足さない。落ちる応答は採用しない）
  const present = bundle.requirements.filter((requirement) => firstAt.has(requirement.id));
  const responseIndex = present.map((requirement) => firstAt.get(requirement.id) as number);
  const ordered = responseIndex.map((index) => {
    const entry = entries[index] as MappingEntry;
    if (entry.verification.kind !== "structural" || entry.verification.targets === undefined) return entry;
    const before = problems.length;
    checkCheckTargets(rows, entry.verification.targets, `requirements[${String(index)}].verification`, problems);
    return problems.length !== before ? entry : { ...entry, roles: ownershipWithCheckTargets(entry.roles, entry.verification.targets) };
  });

  // その束の要件に C2' を掛ける（行の検査と孤立した行は表全体で見る。位置は応答の要件ごとの 1 件へ写す）
  const table = tableOf(rows, ordered);
  const tableProblems = checkMappedTable({ ...list, requirements: present }, table, documents, ledger === undefined ? {} : { ledger });
  for (const problem of tableProblems) {
    const match = indexedField.exec(problem.field);
    if (match === null) continue;
    const [, name, at, rest] = match;
    const index = responseIndex[Number(at)];
    const suffix = name === "ownership" ? "" : name === "verification" ? ".verification" : ".nature";
    const tail = name === "classification" ? (rest ?? "").replace(/^\.nature/, "") : (rest ?? "");
    problems.push({ ...problem, field: `requirements[${String(index)}]${suffix}${tail}` });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries: ordered };
}

function tableOf(rows: readonly NameTableRow[], entries: readonly MappingEntry[]): NameTable {
  return {
    rows,
    ownership: entries.map((entry) => ({ requirementId: entry.requirementId, roles: entry.roles })),
    verification: entries.map((entry) => ({ ...entry.verification, requirementId: entry.requirementId })),
    classification: entries.map((entry) => ({ requirementId: entry.requirementId, nature: entry.nature })),
  };
}

/**
 * 全束の写像を一覧の順に 1 つの表に組み、表全体の C2' を 1 回掛ける（純粋）。束の C2' を通った写像なら、残るのは要件に帰属しない
 * 問題（どの要件にも所属しない行）だけである。問題があれば束を推測せずそのまま返す
 */
export async function assembleMappedTable(
  list: RequirementList,
  rows: readonly NameTableRow[],
  bundles: readonly MappedBundle[],
  documents: readonly PromptDocument[],
  ledger?: LedgerView,
): Promise<
  { readonly ok: true; readonly table: NameTable; readonly tableSha256: string } | { readonly ok: false; readonly problems: readonly Problem[] }
> {
  // 一覧の順に並べる（重複・一覧に無い ID は捨てずに後ろへ残し、表全体の C2' が落とす。束の C2' を通った写像なら起きない）
  const order = new Map(list.requirements.map((requirement, index) => [requirement.id, index] as const));
  const entries = bundles
    .flatMap((bundle) => bundle.entries)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (order.get(a.entry.requirementId) ?? list.requirements.length + a.index) - (order.get(b.entry.requirementId) ?? list.requirements.length + b.index) || a.index - b.index)
    .map(({ entry }) => entry);
  const table = tableOf(rows, entries);
  const problems = checkMappedTable(list, table, documents, ledger === undefined ? {} : { ledger });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, table, tableSha256: await nameTableSha256(table) };
}

function rawResponseText(output: unknown): string {
  return serializeJson(output).replaceAll("<", "\\u003c");
}

/** 確定した仕様から要件の種類を外し、要件をその束の分だけにする */
function bundlePlan(plan: ConfirmedPlan, bundle: MappingBundle): unknown {
  const ids = new Set(bundle.requirements.map((requirement) => requirement.id));
  const visible = planWithoutRequirementKinds(plan) as Record<string, unknown>;
  const requirements = visible["requirements"] as readonly { readonly id: string }[];
  return { ...visible, requirements: requirements.filter((requirement) => ids.has(requirement.id)) };
}

/** C2 の束の要求のデータ（`previous` があればこの順で 3 塊を足す） */
function buildData(input: MappingBundleInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: MAPPING_DATA_NAMES.plan, text: serializeJson(bundlePlan(input.plan, input.bundle)) },
    {
      name: MAPPING_DATA_NAMES.list,
      text: serializeJson({
        requirements: input.bundle.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text, quote: requirement.quote })),
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
 * C2 の束を 1 回回す。初回は束の C2' に落ちれば共通の窓口が**その束だけ** 1 回作り直させ、2 回続けば `unmet`（骨組みの形が
 * 続けば `malformed`）。`previous` を渡した 2 回目は 1 回だけ呼び、束の C2' に落ちれば `unmet`（`attempts` 1）。
 */
export async function runMappingBundle(input: MappingBundleInput): Promise<MappingBundleOutcome> {
  const { ledger } = input;
  const tally = new ReferenceTally();
  const round = input.previous === undefined ? 1 : 2;
  let lastWasSkeleton = false;
  const inspect = (output: unknown): ShapeCheck<readonly MappingEntry[]> => {
    const skeleton = skeletonProblems(output);
    lastWasSkeleton = skeleton.length > 0;
    if (skeleton.length > 0) return { ok: false, problems: skeleton };
    countMappingReferences(input.list, input.bundle, input.rows, output, tally);
    const inspected = inspectMappingBundle(input.list, input.bundle, input.rows, output as Record<string, unknown>, input.documents, ledger);
    return inspected.ok ? { ok: true, value: inspected.entries } : inspected;
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
    // 2 回目は形の再試行を持たない（08 §4.1）：窓口には骨組みだけを掛けさせ、束の C2' は 1 回だけ掛ける
    let inspected: ShapeCheck<readonly MappingEntry[]> | undefined;
    const answer = await callStructuredChecked(input.gateway, {
      request,
      check: (output) => {
        inspected = inspect(output);
        return { ok: true, value: output };
      },
    });
    if (!answer.ok) return { ok: false, failure: answer.failure, references: tally.counts };
    const result = inspected as ShapeCheck<readonly MappingEntry[]>;
    if (!result.ok) {
      onRejected?.({ kind: "shape", round, attempt: 1, response: answer.output, problems: result.problems.map((problem) => ({ ...problem, reference: "response" })) });
      return { ok: false, failure: { kind: "unmet", attempts: 1, problems: result.problems }, references: tally.counts };
    }
    return { ok: true, value: { entries: result.value, response: answer.output }, references: tally.counts };
  }
  const answer = await callStructuredChecked(input.gateway, { request, check: inspect, ...onShapeRejected });
  if (answer.ok) return { ok: true, value: { entries: answer.value, response: answer.output }, references: tally.counts };
  const failure: StageFailure =
    answer.failure.kind === "malformed" && !lastWasSkeleton
      ? { kind: "unmet", attempts: answer.failure.attempts, problems: answer.failure.problems }
      : answer.failure;
  return { ok: false, failure, references: tally.counts };
}
