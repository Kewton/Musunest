// B3' 宣言の意味の点検（07-architecture-v1.1a.md §1・§1.1・D4・D13。Issue #507）。
//
// 表が正しくても、builder が誤った式・条件・表示・既定値を書いたり、必要な振る舞いを表に無い要素へ移したり
// すれば、名前・型・到達の照合と有限の試験では捕まえきれない（§1.1）。**LLM の別の会話**が、要件ごとに
// 「宣言が要件の意味に合うか」だけを判定する（受理／拒否。拒否は種類つき・引用つき）。
//
// **宣言の全文を渡す**（v1 の ⑤a と同じ範囲。D13 の保証）。表の `id` ごとにコードが引き当てた該当箇所の印と
// 参照先（A1 の `markRows`）と、表に無い追加の要素の一覧（A1 の `extraElementsOf`。D4）を**添える**だけで、
// 点検の文脈を該当箇所に狭めない——狭めると、所属する計算は同じで参照する補助の計算の式だけが誤る場合を
// 見逃す。**試験・期待・合否は見せない。**
//
// 所属の行の印か参照先を引き当てられない要件（印が無い・参照先の経路が null・所属の行が無い）は、**呼ぶ前に
// 対象から外し**、戻り値で「文脈なし」（`unmarked`）として返す。受理しない。持ち越すのは A5 である。
//
// 完全性と引用の実在は T1'' と同じ（`checkJudgmentsShape`）。結果は宣言の SHA-256（原文の SHA-256。
// run.ts と同じ）に結ぶ。版ごとの掛け直しと回数（`declChecks`）は A5 が担う。
import type { ConfirmedPlan, NormalizedAppSpec } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import type { CallGateway } from "../../call.js";
import type { Declaration, RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  ruleTexts,
  serializeJson,
  type PromptDocument,
  type RuleDefinition,
  type StageOutcome,
} from "../../stages/prompt.js";
import { extraElementsOf, markRows, type DeclarationMark } from "../bind-by-id.js";
import type { DeclCheckResult, DeclJudgment } from "../carry-over.js";
import type { NameTable } from "../names.js";
import { checkJudgmentsShape, judgmentsSchema, quoteSources } from "./semantic-check.js";

/** B3' の JSON Schema の名前 */
export const DECL_CHECK_SCHEMA_NAME = "decl-check";

/**
 * B3' の拒否の種類。`mismatch` … 式・条件・表示・既定値が要件と食い違う、`auxiliary-mismatch` … 参照する
 * 補助の定義が要件と食い違う、`behavior-outside-ownership` … 必要な振る舞いが所属の外（追加の要素）にある、
 * `empty-location` … 該当箇所が空。
 */
export const DECL_REJECTION_KINDS = [
  "mismatch",
  "auxiliary-mismatch",
  "behavior-outside-ownership",
  "empty-location",
] as const;
export type DeclRejectionKind = (typeof DECL_REJECTION_KINDS)[number];

/** B3' に足す規則の定義（ID は `R-dc-nn`） */
export const DECL_CHECK_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-dc-01",
    text: "あなたは、アプリの宣言が要件の意味に合うかだけを、要件ごとに判定する。名前・種類・型・到達の照合はコードが済ませた。宣言を書き直さない。",
    why: "名前の照合（B3）とは別に、宣言の意味を別の会話で独立に点検する（§1.1・D13）",
    since: "Issue #507",
  },
  {
    id: "R-dc-02",
    text: "宣言の全文を読む。該当箇所の印は、所属の行が宣言のどこにあるか（どこを見るか）を示す手がかりであり、点検の範囲を狭めない。印の参照先や、印の外にある補助の計算・項目・追加の要素も、要件の意味に関わるなら見る。",
    why: "全文を見せて印は添えるだけにし、補助の定義だけの誤りを見逃さない（D13）",
    since: "Issue #507",
  },
  {
    id: "R-dc-03",
    text: "拒否の種類：所属の行の式・条件（when）・表示（show・highlight）・既定値が要件と食い違えば mismatch。所属の行が参照する補助の計算・項目の定義が要件と食い違えば auxiliary-mismatch。要件に要る振る舞いが所属の行ではなく追加の要素（表に無い要素）にあれば behavior-outside-ownership。所属の行の該当箇所が空で要件を満たさなければ empty-location。",
    why: "宣言の意味の抜け（式・条件・表示・既定値・補助の定義・所属の外への移動・空）を有限の種類で返させる（§1.1・D4）",
    since: "Issue #507",
  },
  {
    id: "R-dc-04",
    text: "判定は、データの「要件の文と引用」の要件ごとにちょうど 1 つ返す。requirementId はデータのまま写す。データに無い要件の判定を書かない。",
    why: "完全性（対象の全要件にちょうど 1 判定）をコードが確かめられる形にする（§1.1）",
    since: "Issue #507",
  },
  {
    id: "R-dc-05",
    text: "受理は、要件の意味に合うことを宣言で確かめたときだけにする。受理の kind と quote は null にする。合わなければ拒否にし、kind に種類を 1 つ、quote に要件の文か引用からそのまま写した根拠の文字列を書く。根拠を写せない拒否をしない。",
    why: "受理を既定にせず、拒否には要件からの引用を要する（追認も捏造も通さない。§1.1）",
    since: "Issue #507",
  },
];

/** B3' に足す規則（定義の `text` から組む） */
export const DECL_CHECK_RULES: readonly string[] = ruleTexts(DECL_CHECK_RULE_DEFINITIONS);

/** B3' の JSON Schema */
export const DECL_CHECK_SCHEMA = judgmentsSchema(DECL_REJECTION_KINDS);

/** B3' が受け取るもの */
export interface DeclCheckInput {
  /** 確定した仕様（引用の照合に使う。データには載せない） */
  readonly plan: ConfirmedPlan;
  /** 点検する要件の一覧（持ち越しを除いた残りの要件。§1.2） */
  readonly list: RequirementList;
  /** 名前の表（builder に見せた全行。印と追加の要素はこの表で引く） */
  readonly table: NameTable;
  /** B2・B3 を通った宣言（原文） */
  readonly declaration: Declaration;
  /** その宣言を正規化したもの */
  readonly app: NormalizedAppSpec;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** B3' の結果（宣言の SHA-256 に結ぶ完全な結果。`unmarked` の要件を含む） */
export interface DeclCheckOutput extends DeclCheckResult {
  /** LLM に点検させた要件 ID（一覧の順） */
  readonly targets: readonly string[];
  /** 印か参照先を引き当てられず、対象から外した要件 ID（一覧の順） */
  readonly unmarked: readonly string[];
}

/** 要件の所属の行の `id`（T1 の所属の順） */
function ownedIds(table: NameTable, requirementId: string): readonly string[] {
  return table.ownership.find((entry) => entry.requirementId === requirementId)?.roles.map((role) => role.id) ?? [];
}

/** 所属の行の印と参照先を全部引き当てられたか（所属の行が無い要件は引き当てられない） */
function hasContext(marks: ReadonlyMap<string, DeclarationMark>, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  return ids.every((id) => {
    const mark = marks.get(id);
    return mark !== undefined && mark.references.every((reference) => reference.path !== null);
  });
}

/**
 * B3' を 1 回呼ぶ。文脈を引き当てられない要件は呼ぶ前に外して `unmarked` で返す。対象が 0 件なら呼ばない。
 * 形・完全性・引用の落ちは共通の窓口が 1 回やり直し、2 回続けば `malformed`。
 */
export async function runDeclCheck(input: DeclCheckInput): Promise<StageOutcome<DeclCheckOutput>> {
  const declarationSha256 = await sha256Hex(input.declaration.source);
  const marks = markRows(input.app, input.table);
  const rowById = new Map(input.table.rows.map((row) => [row.id, row] as const));
  const targets: string[] = [];
  const unmarked: string[] = [];
  for (const requirement of input.list.requirements) {
    (hasContext(marks, ownedIds(input.table, requirement.id)) ? targets : unmarked).push(requirement.id);
  }
  const unmarkedSet = new Set(unmarked);
  const assemble = (judged: readonly DeclJudgment[]): DeclCheckOutput => {
    const byId = new Map(judged.map((judgment) => [judgment.requirementId, judgment] as const));
    return {
      declarationSha256,
      judgments: input.list.requirements.map((requirement) =>
        unmarkedSet.has(requirement.id)
          ? { requirementId: requirement.id, verdict: "unmarked" as const }
          : (byId.get(requirement.id) as DeclJudgment),
      ),
      targets,
      unmarked,
    };
  };
  if (targets.length === 0) return { ok: true, value: assemble([]) };

  const targetSet = new Set(targets);
  const request = buildStructuredRequest({
    rules: DECL_CHECK_RULES,
    documents: input.documents,
    data: [
      {
        name: "要件の文と引用",
        text: serializeJson(
          input.list.requirements
            .filter((requirement) => targetSet.has(requirement.id))
            .map((requirement) => ({ requirementId: requirement.id, text: requirement.text, quote: requirement.quote })),
        ),
      },
      {
        name: "所属の行",
        text: serializeJson(
          targets.map((requirementId) => ({
            requirementId,
            rows: ownedIds(input.table, requirementId).flatMap((id) => {
              const row = rowById.get(id);
              return row === undefined ? [] : [{ id: row.id, role: row.role, kind: row.kind, type: row.type, name: row.name }];
            }),
          })),
        ),
      },
      { name: "宣言", text: input.declaration.source },
      { name: "該当箇所の印", text: serializeJson([...marks.values()]) },
      { name: "追加の要素", text: serializeJson(extraElementsOf(input.app, input.table)) },
    ],
    schemaName: DECL_CHECK_SCHEMA_NAME,
    schema: DECL_CHECK_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("decl-check"),
  });
  const sources = quoteSources(input.plan, input.list);
  const answer = await callStructuredChecked(input.gateway, {
    request,
    check: (output) => checkJudgmentsShape(output, targets, DECL_REJECTION_KINDS, sources),
  });
  if (!answer.ok) return answer;
  return { ok: true, value: assemble(answer.value) };
}
