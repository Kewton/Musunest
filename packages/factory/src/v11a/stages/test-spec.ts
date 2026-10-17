// T2 試験の仕様（07-architecture-v1.1a.md §1 の表・§1.1・§1.2・§1.3・§2.3。Issue #508）。
//
// 確定した仕様と名前の表（**名前を除く**）から、試験の組を LLM の別の会話で作って固定する。宣言も名前も
// 見せない（宣言に合わせた期待へ寄る口を作らない）。v1 の ②' は役割の表の呼び名を見ていたので、ここでは
// 呼び名の代わりに行の `role`（役割の説明）と `source`（出典）を見せる（§2.3）。
//
//   - 試験は表の `id` で対象を指す（D1）。形は v1 の ②' の schema に、試験ごとの**観測する性質**（`observes`）を
//     足したもの。コードは `observes` を**試験 ID → 性質の写像**に分け、`FixedTest` には入れない
//   - 要件ごとの種類は T2 が**独立に**分類する（T1 の分類も、確定した仕様の要件ごとの `kind` もデータに入れない）。T1 の分類（A1 の写しの
//     `nature`）と `reconcileNatures` で突き合わせ、食い違いは J2（`decideDiscrepantNatures`）で裁く。判定が
//     無い・答えが不正・確率が閾値未満なら `ruled` へ倒す（v1 と同じ。§1.1）
//   - 持ち越しの要件は一覧と所属から除き、その要件だけが所属させる行も表から除く（A1 の `pruneForCarryOver`。
//     §1.2）。持ち越しの要件の試験は、除いた一覧で v1 の検査が「一覧に無い要件 ID」として落とす
//   - 検査は、A1 の写し（`DesignResult`）で v1 の `checkSuitePlan` を**新契約**で呼び、評価可能性（対象の
//     種類・操作・`observes` の組が評価の方法の表にあるか。`02` §1.3）を足す。通ったら網羅の単位を A1 の
//     `coverageUnitsOf` で導いて返す（§1.3）
//
// Problem の `field` は位置（配列の添字と固定の欄名）、`message` は**固定文**である（要件 ID・表の `id`・
// 性質の値を埋めない。v1 の ②' と同じ規律。Issue #439）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import type { CallGateway } from "../../call.js";
import type {
  FixedTest,
  RequirementClassification,
  RequirementNature,
  StructuralAssertionKind,
  TestOperation,
  TestSuite,
  TestTargetKind,
} from "../../fixed-test.js";
import type { Judge } from "../../judge.js";
import type { DesignResult, NatureDiscrepancy, RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  shapeRejectedCandidate,
  withReference,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RejectedCandidate,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "../../stages/prompt.js";
import {
  NATURE_JUDGE_THRESHOLD_VERSION,
  TEST_SUITE_SCHEMA,
  checkSuitePlan,
  checkTestSuiteOutput,
  decideDiscrepantNatures,
  dropNonstructuralTests,
  reconcileNatures,
  type DroppedNonstructuralTest,
  type NatureDecision,
} from "../../stages/test-suite.js";
import type { CarryOver } from "../carry-over.js";
import { pruneForCarryOver } from "../carry-over.js";
import { coverageUnitsOf, type CoverageUnit } from "../coverage.js";
import { canonicalJson, deriveOwnership, type NameTable } from "../names.js";
import { exemptKindMessagesOf, type LedgerView, type PropertyRow, type PropertyT1, type PropertyT2 } from "../../v12/ledger.js";

/** T2 の JSON Schema の名前 */
export const TEST_SPEC_SCHEMA_NAME = "test-spec";

/** 作り直しの回数（1 回だけやり直す。v1 の ②' と同じ。§1 の表） */
export const TEST_SPEC_ROUNDS = 2;

// ── 観測する性質と評価の方法の表（02 §1.3・07 §2.3）──────────────────────

/**
 * 試験が観測する性質。`state-after-set`（操作に set を当てたあとの状態）は評価の方法の表で**未対応**であり、作れば
 * 落ちる（v1 は作ってから ⑤b で未解決にしていた）。`default-value`（項目の既定値）は、**表の確かめ方が
 * `default-value` の要件の、その選択肢の項目**にだけ作れる（ほかは落ちる。B4 が宣言の `default` と照合する。Issue #533）。
 */
export const TEST_OBSERVES = [
  "when",
  "value",
  "validation",
  "view-structure",
  "existence",
  "state-after-set",
  "default-value",
] as const;
export type TestObserves = (typeof TEST_OBSERVES)[number];

/** 評価の方法の表で未対応の性質 */
export const UNSUPPORTED_OBSERVES: readonly TestObserves[] = ["state-after-set"];

/** 評価の方法の表の 1 行（対象の種類・操作・観測する性質） */
export interface EvaluableCombination {
  readonly targetKind: TestTargetKind;
  readonly operation: Exclude<TestOperation, "structure">;
  readonly observes: TestObserves;
}

/** 評価の方法の表（構造の検査を除く。`02` §1.3 の表を、観測する性質まで含めて写したもの） */
export const EVALUABLE_COMBINATIONS: readonly EvaluableCombination[] = [
  { targetKind: "computation", operation: "compute", observes: "value" },
  { targetKind: "computation", operation: "aggregate", observes: "value" },
  { targetKind: "field", operation: "validate", observes: "validation" },
  { targetKind: "entity", operation: "validate", observes: "validation" },
  { targetKind: "operation", operation: "action", observes: "when" },
  { targetKind: "screen", operation: "screen", observes: "view-structure" },
  { targetKind: "field", operation: "screen", observes: "view-structure" },
  { targetKind: "entity", operation: "screen", observes: "existence" },
  // 項目の既定値（表の確かめ方が default-value の要件の、その選択肢の項目だけ。`checkEvaluability`。Issue #533）
  { targetKind: "field", operation: "validate", observes: "default-value" },
];

/**
 * 構造の検査（操作 `structure`）の、検査の中身ごとに合う観測する性質。画面に出ること（`view-shows`）は画面の
 * 構造、ほかの中身（項目の型・操作の種類・条件の無さ・期間の無さ・誰でも書けること）は宣言に在ることの確認。
 */
export const STRUCTURE_OBSERVES: Readonly<Record<StructuralAssertionKind, TestObserves>> = {
  "field-type": "existence",
  "action-kind": "existence",
  "action-unconditioned": "existence",
  "view-shows": "view-structure",
  "aggregate-no-period": "existence",
  "write-anonymous": "existence",
};

/** 既定値で確かめる要件の確かめ方（表から引いた、対象の選択肢の項目の `id` と期待するキー。Issue #533） */
export interface DefaultValueTarget {
  readonly fieldId: string;
  readonly value: string;
}

/**
 * 表の確かめ方が `default-value` の要件 → その選択肢の項目の `id` と期待するキー（Issue #533）。項目は所属の中の
 * 選択肢（enum）の項目の行（T1' がちょうど 1 つと確かめ済み）。1 つに決まらない要件は載せない（その要件の既定値の
 * 試験は評価可能性で落ちる。fail-closed）。持ち越しを除いた表を渡せば、持ち越しの要件は載らない。
 */
export function defaultValueTargetsOf(table: NameTable): ReadonlyMap<string, DefaultValueTarget> {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const rolesById = new Map(table.ownership.map((entry) => [entry.requirementId, entry.roles] as const));
  const targets = new Map<string, DefaultValueTarget>();
  for (const entry of table.verification) {
    if (entry.kind !== "default-value") continue;
    const fields = (rolesById.get(entry.requirementId) ?? []).filter((role) => {
      const row = rowById.get(role.id);
      return row !== undefined && row.kind === "field" && row.type === "enum";
    });
    const [only] = fields;
    if (fields.length === 1 && only !== undefined) targets.set(entry.requirementId, { fieldId: only.id, value: entry.value });
  }
  return targets;
}

/** 既定値の試験を、確かめ方が default-value でない要件・その項目でない対象に作ったときの固定文 */
export const DEFAULT_VALUE_NOT_ALLOWED_MESSAGE =
  "項目の既定値（default-value）の試験は、確かめ方が default-value の要件の、その選択肢の項目だけを対象にできる";

/**
 * 評価可能性：試験ごとの（対象の種類・操作・観測する性質）の組を、評価の方法の表に照らす（§2.3 の (i)）。
 * 未対応の性質・表に無い組・構造の検査の中身に合わない性質・性質の引けない試験を、固定文で落とす。
 * `default-value` の試験は、表（`table`。持ち越しを除いた表）の確かめ方が `default-value` の要件の、その選択肢の
 * 項目を対象にするときだけ表の組に照らす。ほかは固定文で落とす（表を渡さなければ全部落ちる。Issue #533）。
 */
export function checkEvaluability(
  suite: TestSuite,
  observes: ReadonlyMap<string, TestObserves>,
  table?: NameTable,
): readonly Problem[] {
  const problems: Problem[] = [];
  const defaults = table === undefined ? new Map<string, DefaultValueTarget>() : defaultValueTargetsOf(table);
  suite.tests.forEach((test, index) => {
    const field = `tests[${index}].observes`;
    const observed = observes.get(test.id);
    if (observed === undefined) {
      problems.push({ field, message: "観測する性質が引けない" });
      return;
    }
    if (UNSUPPORTED_OBSERVES.includes(observed)) {
      problems.push({
        field,
        message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）",
      });
      return;
    }
    if (observed === "default-value" && defaults.get(test.target.requirementId)?.fieldId !== test.target.roleId) {
      problems.push({ field, message: DEFAULT_VALUE_NOT_ALLOWED_MESSAGE });
      return;
    }
    if (test.operation === "structure") {
      const check = test.assertion?.check;
      if (check === undefined || STRUCTURE_OBSERVES[check] !== observed) {
        problems.push({ field, message: "構造の検査の観測する性質が、検査の中身に合わない" });
      }
      return;
    }
    const listed = EVALUABLE_COMBINATIONS.some(
      (entry) =>
        entry.targetKind === test.target.kind && entry.operation === test.operation && entry.observes === observed,
    );
    if (!listed) {
      problems.push({ field, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" });
    }
  });
  return problems;
}

/** 既定値の要件の試験の形の固定文（値を埋めない。Issue #533） */
export const DEFAULT_VALUE_TEST_MESSAGES = {
  kind: "既定値で確かめる要件の試験は、正常（normal）だけであること",
  operation: "既定値で確かめる要件の試験の操作は、検査（validate）であること",
  target: "既定値で確かめる要件の試験の対象は、確かめ方の選択肢の項目（field）であること",
  observes: "既定値で確かめる要件の試験の観測する性質は、default-value であること",
  expected: "既定値で確かめる要件の試験の期待は、確かめ方のキーを JSON の文字列で書いた ok であること",
  input: "既定値で確かめる要件の試験の入力は、空の写像であること",
  referenceData: "既定値で確かめる要件の試験の参照データは、空の並びであること",
} as const;

const isEmptyRecord = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 0;

/**
 * 応答（raw）で、期待の値が **JSON の文字列**（引用符つきで読み直すと文字列になる JSON の文字列）の試験 ID。v1 の形の
 * 検査は JSON として読めない値をそのままの文字列で残すので、decode 済みの値だけでは「引用符の無い値」を見分けられない。
 * 既定値の要件の試験の検査は、ここに無い試験を期待の不備として落とす（Issue #533）
 */
export function jsonStringExpectedIds(output: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isRecord(output) || !Array.isArray(output["tests"])) return ids;
  for (const raw of output["tests"] as readonly unknown[]) {
    if (!isRecord(raw) || typeof raw["id"] !== "string") continue;
    const expected = raw["expected"];
    if (!isRecord(expected) || typeof expected["value"] !== "string") continue;
    try {
      if (typeof JSON.parse(expected["value"]) === "string") ids.add(raw["id"]);
    } catch {
      // JSON として読めない値（引用符の無い値）は JSON の文字列でない
    }
  }
  return ids;
}

/**
 * 既定値の要件の試験の検査（Issue #533）。確かめ方が default-value の要件（`defaults`。持ち越しを除いた表から引く）の
 * **全試験**が、kind normal・operation validate・対象が確かめ方の項目・observes default-value・期待が ok で decode 済みの
 * 文字列が確かめ方の value と等しい・入力が空の写像・参照データが空の並び、でなければ固定文で落とす（位置は試験の
 * 添字と欄名）。期待の値は応答で JSON の文字列であること（`quoted`。`jsonStringExpectedIds` の値）。試験が無いことは
 * v1 の `checkSuitePlan` の「要件の試験が無い」が落とす（ここでは見ない）。
 */
export function checkDefaultValueTests(
  suite: TestSuite,
  observes: ReadonlyMap<string, TestObserves>,
  defaults: ReadonlyMap<string, DefaultValueTarget>,
  quoted: ReadonlySet<string>,
): readonly Problem[] {
  const problems: Problem[] = [];
  suite.tests.forEach((test, index) => {
    const target = defaults.get(test.target.requirementId);
    if (target === undefined) return;
    const at = `tests[${index}]`;
    if (test.kind !== "normal") problems.push({ field: `${at}.kind`, message: DEFAULT_VALUE_TEST_MESSAGES.kind });
    if (test.operation !== "validate") problems.push({ field: `${at}.operation`, message: DEFAULT_VALUE_TEST_MESSAGES.operation });
    if (test.target.kind !== "field" || test.target.roleId !== target.fieldId) {
      problems.push({ field: `${at}.target`, message: DEFAULT_VALUE_TEST_MESSAGES.target });
    }
    if (observes.get(test.id) !== "default-value") problems.push({ field: `${at}.observes`, message: DEFAULT_VALUE_TEST_MESSAGES.observes });
    const expected = test.expected;
    if (expected.kind !== "ok" || typeof expected.value !== "string" || expected.value !== target.value || !quoted.has(test.id)) {
      problems.push({ field: `${at}.expected`, message: DEFAULT_VALUE_TEST_MESSAGES.expected });
    }
    if (!isEmptyRecord(test.input)) problems.push({ field: `${at}.input`, message: DEFAULT_VALUE_TEST_MESSAGES.input });
    if (test.referenceData.length !== 0) {
      problems.push({ field: `${at}.referenceData`, message: DEFAULT_VALUE_TEST_MESSAGES.referenceData });
    }
  });
  return problems;
}

/** v1 の `checkSuitePlan` の、正常・異常・境界のそろいの不足の固定文のうち、既定値の要件で外す 2 つ（Issue #533） */
export const DEFAULT_VALUE_EXEMPT_MESSAGES: readonly string[] = ["abnormal の試験が無い", "boundary の試験が無い"];

/**
 * v1 の `checkSuitePlan` が返した問題から、既定値の要件の異常・境界の不足だけを外す（Issue #533）。外すのは、
 * **残る一覧の要件 ID → その要件の確かめ方（持ち越しを除いた表）が default-value → `field` がその要件の添字の位置
 * （`requirements[添字]`）と正確に一致し、`message` が 2 つの固定文のどちらかと完全一致**、の 3 条件をすべて満たす
 * 問題だけ。部分一致・別の位置・別の文は外さない。免除は表の確かめ方で決め、生成した試験の有無・数では決めない。
 */
export function exemptDefaultValueProblems(
  problems: readonly Problem[],
  list: RequirementList,
  defaults: ReadonlyMap<string, DefaultValueTarget>,
): readonly Problem[] {
  const exemptFields = new Set(
    list.requirements.flatMap((requirement, index) => (defaults.has(requirement.id) ? [`requirements[${index}]`] : [])),
  );
  if (exemptFields.size === 0) return problems;
  return problems.filter(
    (problem) => !(exemptFields.has(problem.field) && DEFAULT_VALUE_EXEMPT_MESSAGES.includes(problem.message)),
  );
}

// ── 旗 on：性質の台帳から導く検査（08 §5・Issue #547。off は上の定数と関数をそのまま使う）──────────

/** 台帳に無い観測する性質の試験の固定文（schema の enum を迂回しても、コードが落とす） */
export const LEDGER_UNREGISTERED_OBSERVES_MESSAGE = "観測する性質が性質の台帳に無い";

/** 確かめ方に結び付いた性質で確かめる要件の、対象の行と期待する値（表から引く。旗 on） */
export interface LedgerTarget {
  readonly row: PropertyRow & { readonly t1: PropertyT1; readonly t2: PropertyT2 };
  readonly fieldId: string;
  readonly value: string;
}

/**
 * 表の確かめ方が台帳の性質に結び付いた要件 → 対象の行の `id` と期待する値（`defaultValueTargetsOf` を台帳の行の
 * 記述子で引いたもの）。対象は所属の中の、記述子の種類・型の行がちょうど `count`（1）行のときだけ載せる（fail-closed）。
 */
export function ledgerTargetsOf(table: NameTable, ledger: LedgerView): ReadonlyMap<string, LedgerTarget> {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const rolesById = new Map(table.ownership.map((entry) => [entry.requirementId, entry.roles] as const));
  const targets = new Map<string, LedgerTarget>();
  for (const entry of table.verification) {
    const row = ledger.rowByVerificationKind.get(entry.kind);
    if (row === undefined || row.t1 === null || row.t2 === null) continue;
    const t1 = row.t1;
    const value = (entry as unknown as Record<string, unknown>)[t1.valueField];
    if (typeof value !== "string") continue;
    const fields = (rolesById.get(entry.requirementId) ?? []).filter((role) => {
      const owned = rowById.get(role.id);
      return owned !== undefined && owned.kind === t1.ownership.row.kind && (owned.type as unknown) === t1.ownership.row.type;
    });
    const [only] = fields;
    if (fields.length === t1.ownership.count && only !== undefined) {
      targets.set(entry.requirementId, { row: { ...row, t1, t2: row.t2 }, fieldId: only.id, value });
    }
  }
  return targets;
}

/**
 * 評価可能性（旗 on）。`checkEvaluability` と同じ順で、未対応・表に無い組・構造の検査の中身に合わない性質・性質の
 * 引けない試験を落とし、**台帳に無い性質を固定文で落とす**。確かめ方に結び付いた性質の試験は、その確かめ方の要件の
 * その行を対象にするときだけ台帳の組に照らす。
 */
export function checkEvaluabilityByLedger(
  suite: TestSuite,
  observes: ReadonlyMap<string, TestObserves>,
  table: NameTable | undefined,
  ledger: LedgerView,
): readonly Problem[] {
  const problems: Problem[] = [];
  const targets = table === undefined ? new Map<string, LedgerTarget>() : ledgerTargetsOf(table, ledger);
  suite.tests.forEach((test, index) => {
    const field = `tests[${index}].observes`;
    const observed: string | undefined = observes.get(test.id);
    if (observed === undefined) {
      problems.push({ field, message: "観測する性質が引けない" });
      return;
    }
    const row = ledger.rowByObserves.get(observed);
    if (row === undefined) {
      problems.push({ field, message: LEDGER_UNREGISTERED_OBSERVES_MESSAGE });
      return;
    }
    if (row.state === "registered-unsupported") {
      problems.push({ field, message: row.unsupportedMessage ?? LEDGER_UNREGISTERED_OBSERVES_MESSAGE });
      return;
    }
    if (row.t1 !== null && row.t2 !== null) {
      const target = targets.get(test.target.requirementId);
      if (target?.row.id !== row.id || target.fieldId !== test.target.roleId) {
        problems.push({ field, message: row.t2.messages.notAllowed });
        return;
      }
    }
    if (test.operation === "structure") {
      const check = test.assertion?.check;
      if (check === undefined || STRUCTURE_OBSERVES[check] !== observed) {
        problems.push({ field, message: "構造の検査の観測する性質が、検査の中身に合わない" });
      }
      return;
    }
    const listed = ledger.combinations.some(
      (entry) => entry.targetKind === test.target.kind && entry.operation === test.operation && entry.observes === observed,
    );
    if (!listed) {
      problems.push({ field, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" });
    }
  });
  return problems;
}

/**
 * 確かめ方に結び付いた性質で確かめる要件の試験の形（旗 on。`checkDefaultValueTests` を台帳の行の試験の型から掛けたもの）。
 * その要件の**全試験**が、必須の kind・操作・対象の行・観測する性質・期待の型（ok で、JSON の文字列で書いた値が確かめ方の
 * 値と等しい）・入力の形（空の写像）・参照データ（空の並び）に合わなければ、行の固定文で落とす。
 */
export function checkLedgerTests(
  suite: TestSuite,
  observes: ReadonlyMap<string, TestObserves>,
  targets: ReadonlyMap<string, LedgerTarget>,
  quoted: ReadonlySet<string>,
): readonly Problem[] {
  const problems: Problem[] = [];
  suite.tests.forEach((test, index) => {
    const target = targets.get(test.target.requirementId);
    if (target === undefined) return;
    const t2 = target.row.t2;
    const at = `tests[${index}]`;
    if (!t2.requiredKinds.includes(test.kind)) problems.push({ field: `${at}.kind`, message: t2.messages.kind });
    if (test.operation !== t2.operation) problems.push({ field: `${at}.operation`, message: t2.messages.operation });
    if (test.target.kind !== t2.targetKind || test.target.roleId !== target.fieldId) {
      problems.push({ field: `${at}.target`, message: t2.messages.target });
    }
    if (observes.get(test.id) !== target.row.id) problems.push({ field: `${at}.observes`, message: t2.messages.observes });
    const expected = test.expected;
    if (
      expected.kind !== t2.expected.kind ||
      typeof expected.value !== "string" ||
      expected.value !== target.value ||
      !quoted.has(test.id)
    ) {
      problems.push({ field: `${at}.expected`, message: t2.messages.expected });
    }
    if (!isEmptyRecord(test.input)) problems.push({ field: `${at}.input`, message: t2.messages.input });
    if (t2.referenceTargets.length === 0 && test.referenceData.length !== 0) {
      problems.push({ field: `${at}.referenceData`, message: t2.messages.referenceData });
    }
  });
  return problems;
}

/**
 * v1 の `checkSuitePlan` の問題から、確かめ方に結び付いた性質で確かめる要件の、試験の型の必須に無い kind の不足だけを
 * 外す（旗 on。`exemptDefaultValueProblems` と同じ 3 条件。外す文は台帳の行の必須の kind から導く）。
 */
export function exemptLedgerProblems(
  problems: readonly Problem[],
  list: RequirementList,
  targets: ReadonlyMap<string, LedgerTarget>,
): readonly Problem[] {
  const exempt = new Map<string, readonly string[]>();
  list.requirements.forEach((requirement, index) => {
    const target = targets.get(requirement.id);
    if (target !== undefined) exempt.set(`requirements[${index}]`, exemptKindMessagesOf(target.row.t2));
  });
  if (exempt.size === 0) return problems;
  return problems.filter((problem) => !(exempt.get(problem.field) ?? []).includes(problem.message));
}

// ── 規則（R-tsp-nn。②' の定義を元にする。v1 の TEST_SUITE_RULE_DEFINITIONS は変えない）──────

/**
 * T2 に足す規則の定義。**送る文は `text` から組む**。②' の R-suite-01〜14 を元に、対象を表の `id` で指す・
 * `observes` を 1 つ書く・名前を推測しない・種類を要件の文から独立に分類する・持ち越しの要件の試験を
 * 作らない、を足した（Issue #508）。
 */
export const TEST_SPEC_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-tsp-01",
    text: "確定した仕様と要件の一覧の文だけから、要件ごとの種類（nature）を独立に分類する（ほかの分類は見せられない。表・確かめ方・所属の欄は分類に使わない）。決まり（条件・計算・検査）を含むなら ruled、在ることだけなら existence-only。分類は classifications に入れる。",
    why: "種類を T1 とは独立に分類させ、分類の追認を作らない（07 §1.1。R-suite-01 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-02",
    text: "確かめ方が structural・default-value の要件を除いて、決まりを含む要件は、決まりの対象ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
    why: "決まりを含む要件に正常・異常・境界の試験を作らせる（R-suite-02 を元にする）。既定値だけを決める要件は R-tsp-16 の形だけで確かめる（Issue #533）",
    since: "Issue #508（default-value の除外は #533 で足した）",
  },
  {
    id: "R-tsp-03",
    text: "在ることだけの要件は、正常のシナリオ 1 本か、構造の条件（create の操作がある・その entity の一覧か表に項目が出る・画面の部品がある）だけを固定する。**異常・境界の試験や検査（validate）の試験は作らない**。",
    why: "在ることだけの要件に異常・境界の試験を作らせない（R-suite-03 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-04",
    text: "確かめ方が structural の要件には、checks の中身ごとに 1 本以上の**構造の検査だけを作る**。種類（ruled／existence）にかかわらず構造の検査だけを作り、正常・異常・境界の実行の試験（入力・画面・集計・操作の試験）は作らない。構造の検査は操作（operation）を structure にし、assertion に検査の中身を持つ。種類（kind）は normal だけ、期待（expected）は「成り立つ」（kind を ok・value を \"true\"・code を null）にする。",
    why: "構造で確かめる要件には構造の検査だけを固定させる（R-suite-04 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-05",
    text: "構造の検査の assertion.check は、確かめ方の checks の中身（field-type・action-kind・action-unconditioned・view-shows・aggregate-no-period・write-anonymous）と同じ値にする。assertion の expected・refEntity・role は検査の種類に応じて埋める——field-type は expected に項目の種類（string・number・date・list・ref・enum）、参照（ref・参照の並び）なら refEntity に参照先 entity の表の id。action-kind は expected に操作の種類（create・update・delete）。view-shows は role に、表示を期待する項目か計算の表の id。action-unconditioned・aggregate-no-period・write-anonymous は expected・refEntity・role を null にする。",
    why: "構造の検査の中身と参照の欄の埋め方を、確かめ方の checks と表の id に合わせる（R-suite-05 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-06",
    text: "構造の検査は、確かめ方が structural の要件だけを対象にする。構造の検査でない試験は assertion を null にする。確かめ方が structural の要件には、正常・異常・境界のそろいを求めない。",
    why: "構造の検査を構造の要件だけに当て、実行の試験と混ぜさせない（R-suite-06 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-07",
    text: "入力（input）と参照データの値（values）と期待の値（value）は、任意の JSON を表すので、**JSON の文字列**として書く（例: \"{\\\"f.example.amount\\\": 21}\"）。",
    why: "任意の JSON を、strict で表せる JSON の文字列として受けさせる（R-suite-07 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-08",
    text: "異常の期待は、操作ごとの型にする。検査（validate）の異常は誤りコード（expected.code）で確かめ、value は null にする。計算・集計（compute・aggregate）の異常は、値（expected.value）でもよい。それ以外の正常は値の JSON 文字列を value に入れ、code は null にする。",
    why: "異常の期待を操作ごとの型にし、検査と計算を分ける（R-suite-08 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-09",
    text: "対象（target）と参照の行（referenceData の target）は、**表の id** で指し、roleId の欄に書く。対象の id は、その要件の所属にある id から選ぶ。対象の種類（target.kind）は、その行の kind と同じにする。",
    why: "試験の対象を、宣言の名前ではなく表の id で指させる（07 D1・§2.3）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-10",
    text: "名前は見せられない。宣言で使う名前を推測して書かない。対象の意味は、表の行の role（役割の説明）・source（出典の要件と引用）・kind・type・entity・options・groupBy・refEntity から読む。",
    why: "名前を推測させず、宣言に合わせた期待へ寄る口を作らない（07 §2.3）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-11",
    text: "入力の契約（inputContract）に、固定の行 ID（rowId）・評価の対象の行 ID（targetRowId。行を評価しないときは null）・空であることを明示する entity の表の id（emptyEntities）を入れる。",
    why: "入力の契約（固定の行 ID・評価の対象・空の集合）を書かせる（R-suite-10 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-12",
    text: "所属 entity の決まったレコードの入力（input）と参照の行の値（values）の直下の鍵は、その entity の項目（kind が field）の表の id だけにする。行の ID は inputContract.rowId・referenceData[*].rowId に置き、値の鍵（id・rowId）にしない。",
    why: "値の鍵を所属 entity の項目の表の id に限り、行の ID を値の鍵に書かせない（R-suite-11 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-13",
    text: "時計（clock）は固定の日時（オフセット付きの ISO 8601）にする。",
    why: "時計を固定の日時にし、評価を再現できるようにする（R-suite-12 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-14",
    text: "要件 ID は要件の一覧のものだけを使う。一覧に無い要件 ID を作らない。確定した仕様にあっても一覧に無い要件（持ち越しの要件）の試験は作らない。",
    why: "一覧に無い要件 ID と、持ち越しの要件の試験を作らせない（07 §1.2。R-suite-13 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-15",
    text: "選択肢（enum）の項目の値は、表の options から選ぶ。見出しごとの集計の期待は、分ける元の項目の options の全キーを順に、heading と value だけで書き、集計元を読めない入力の期待は null にする。",
    why: "期待の値と見出しを、表の選択肢の参照表現に合わせ、別々の推測をなくす（R-suite-14 を元にする）",
    since: "Issue #508",
  },
  {
    id: "R-tsp-16",
    text: "試験ごとに、観測する性質（observes）を 1 つ書く。組は次のどれかに限る：計算 × compute・aggregate は value、項目・entity × validate は validation、操作 × action は when、画面 × screen は view-structure、項目 × screen は view-structure、entity × screen は existence、構造の検査（structure）は view-shows なら view-structure・ほかの中身なら existence。項目の既定値（default-value）の試験は、確かめ方が default-value の要件にだけ、次の形で 1 本以上作る：対象（target）はその要件の所属の選択肢の項目（target.kind は field）、kind は normal、operation は validate、observes は default-value、入力（input）は空の写像（\"{}\"）、参照データ（referenceData）は空の並び、期待（expected）は kind を ok・value を確かめ方の value のキーの JSON の文字列（例: キーが k1 なら \"\\\"k1\\\"\"）・code を null。その要件には異常・境界の試験を作らない。ほかの要件に default-value を書かない。操作に set を当てたあとの状態（state-after-set）は評価できないので、その試験は作らない。",
    why: "試験が観測する性質を評価の方法の表に照らせるようにし、評価できない試験を作らせない（07 §2.3・02 §1.3）。既定値の試験は、表で確定した確かめ方の要件にだけ、宣言の default と照合できる形で作らせる（方法論 03 §1 の H2。Issue #533）",
    since: "Issue #508（default-value の試験の形は #533 で足した）",
  },
];

/** T2 に足す規則（共通の規則は buildStructuredRequest が先頭に付ける。定義の `text` から組む） */
export const TEST_SPEC_RULES: readonly string[] = ruleTexts(TEST_SPEC_RULE_DEFINITIONS);

/** R-tsp-16 の、台帳の文の前（観測する性質の組。引き継いだ行の組は今の文のまま） */
const TEST_SPEC_LEDGER_FORM_HEAD =
  "試験ごとに、観測する性質（observes）を 1 つ書く。組は次のどれかに限る：計算 × compute・aggregate は value、項目・entity × validate は validation、操作 × action は when、画面 × screen は view-structure、項目 × screen は view-structure、entity × screen は existence、構造の検査（structure）は view-shows なら view-structure・ほかの中身なら existence。";

/**
 * T2 の規則の定義（旗 on なら台帳から組む。Issue #547）。省けば今の定数を返す。渡せば R-tsp-02 の除外（structural と、
 * 試験の型の必須の kind が normal だけの確かめ方の種類。台帳の順）と、R-tsp-16 の形の位置（有効の行の文 → 未対応の行の
 * 文。台帳の順）を台帳から組み直す（ID・why・since は変えない）。手 2a では off の定数とバイト列で同じになる。
 */
export function testSpecRuleDefinitionsOf(ledger?: LedgerView): readonly RuleDefinition[] {
  if (ledger === undefined) return TEST_SPEC_RULE_DEFINITIONS;
  return TEST_SPEC_RULE_DEFINITIONS.map((definition) => {
    if (definition.id === "R-tsp-02") {
      const excluded = ["structural", ...ledger.t2ExemptKinds].join("・");
      return {
        ...definition,
        text: `確かめ方が ${excluded} の要件を除いて、決まりを含む要件は、決まりの対象ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。`,
      };
    }
    if (definition.id === "R-tsp-16") {
      return {
        ...definition,
        text: `${TEST_SPEC_LEDGER_FORM_HEAD}${ledger.t2FormTexts.join("")}${ledger.t2UnsupportedTexts.join("")}`,
      };
    }
    return definition;
  });
}

// ── JSON Schema（②' の schema に、試験ごとの observes を足す）─────────────────

const SUITE_TEST_ITEMS = TEST_SUITE_SCHEMA.properties.tests.items;

/**
 * T2 の JSON Schema（構造化出力）。②' の schema（`TEST_SUITE_SCHEMA`）に、試験ごとの `observes` を足したもの。
 * OpenAI の strict の規則に合わせる（すべての欄を `required`、`additionalProperties: false`）。
 */
export const TEST_SPEC_SCHEMA = {
  ...TEST_SUITE_SCHEMA,
  properties: {
    ...TEST_SUITE_SCHEMA.properties,
    tests: {
      ...TEST_SUITE_SCHEMA.properties.tests,
      items: {
        ...SUITE_TEST_ITEMS,
        required: [...SUITE_TEST_ITEMS.required, "observes"],
        properties: {
          ...SUITE_TEST_ITEMS.properties,
          target: {
            ...SUITE_TEST_ITEMS.properties.target,
            properties: {
              ...SUITE_TEST_ITEMS.properties.target.properties,
              roleId: { type: "string", description: "表の id（その要件の所属にある id）" },
            },
          },
          observes: {
            type: "string",
            enum: [...TEST_OBSERVES],
            description: "試験が観測する性質（評価の方法の表の組に限る）",
          },
        },
      },
    },
  },
} as const;

/**
 * T2 の JSON Schema（旗 on なら observes の enum を台帳の順にする。Issue #547）。省けば今の定数を返す。欄の並びは
 * 変えない（off の定数とバイト列で同じ JSON になる）。
 */
export function testSpecSchemaOf(ledger?: LedgerView): typeof TEST_SPEC_SCHEMA {
  if (ledger === undefined) return TEST_SPEC_SCHEMA;
  const tests = TEST_SPEC_SCHEMA.properties.tests;
  return {
    ...TEST_SPEC_SCHEMA,
    properties: {
      ...TEST_SPEC_SCHEMA.properties,
      tests: {
        ...tests,
        items: {
          ...tests.items,
          properties: {
            ...tests.items.properties,
            observes: { ...tests.items.properties.observes, enum: [...ledger.observes] },
          },
        },
      },
    },
  } as unknown as typeof TEST_SPEC_SCHEMA;
}

// ── 形の検査 ──────────────────────────────────────────────────────

/** 形の検査を通った T2 の応答（組と、試験 ID → 観測する性質） */
export interface TestSpecOutput {
  readonly suite: TestSuite;
  readonly observes: ReadonlyMap<string, TestObserves>;
}

/**
 * T2 の応答の形を確かめる。組の形は v1 の `checkTestSuiteOutput`（`fixed-test.ts` が正本）に任せ、試験ごとの
 * `observes` が知っている値であることと、試験 ID が組の中で重ならないこと（写像の鍵になる）を足す。
 * `observes` は `FixedTest` に入れない（v1 の形の検査が知らない欄を落とす）。
 */
export function checkTestSpecOutput(output: unknown, ledger?: LedgerView): ShapeCheck<TestSpecOutput> {
  // 旗 on：知っている値は台帳の観測する性質（台帳の順。Issue #547）
  const known: readonly string[] = ledger === undefined ? TEST_OBSERVES : ledger.observes;
  const isKnown = (value: unknown): value is TestObserves => typeof value === "string" && known.includes(value);
  const base = checkTestSuiteOutput(output);
  // 写像でない・試験の並びが無い応答は、v1 の形の検査が断っている（その問題をそのまま返す）
  if (!isRecord(output) || !Array.isArray(output["tests"])) return { ok: false, problems: base.ok ? [] : base.problems };
  const rawTests: readonly unknown[] = output["tests"];
  const problems: Problem[] = base.ok ? [] : [...base.problems];
  const observes = new Map<string, TestObserves>();
  const seen = new Set<string>();
  rawTests.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const observed = raw["observes"];
    if (!isKnown(observed)) {
      problems.push({ field: `tests[${index}].observes`, message: `観測する性質は ${known.join("・")} のいずれかであること` });
    }
    const id = raw["id"];
    if (typeof id !== "string" || id === "") return;
    if (seen.has(id)) {
      problems.push({ field: `tests[${index}].id`, message: "試験の識別子が組の中で重なっている" });
      return;
    }
    seen.add(id);
    if (isKnown(observed)) observes.set(id, observed);
  });
  if (!base.ok || problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { suite: base.value, observes } };
}

// ── データ ────────────────────────────────────────────────────────

/** データの塊の名前（1 回目の並び。やり直しでは末尾に前回の試験と前回の作り直しの指示を足す） */
export const TEST_SPEC_DATA_NAMES = ["確定した仕様", "要件の一覧", "対象の表", "要件ごとの確かめ方", "要件ごとの所属"] as const;

/** やり直しで足すデータの塊の名前（#439 と同じ作法） */
export const TEST_SPEC_RETRY_DATA_NAMES = ["前回の試験", "前回の作り直しの指示"] as const;

/**
 * やり直しで「前回の作り直しの指示」の後ろに足す、判定（J2）で決めた種類の塊の名前（方法論 03 §1 の H3。Issue #526）。
 * 決定が `judged` の要件だけを載せる（`fallback` は載せない）。決めた要件が無ければ足さない
 */
export const TEST_SPEC_DECIDED_NATURES_DATA_NAME = "判定で決めた種類";

/** 判定で決めた種類の塊の 1 行（要件 ID・種類） */
interface DecidedNatureRow {
  readonly requirementId: string;
  readonly nature: RequirementNature;
}

/** 表の行のうち T2 に見せる欄（**`name` は見せない**。§2.3） */
function visibleRows(table: NameTable): readonly unknown[] {
  return table.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    type: row.type,
    entity: row.entity,
    options: row.options,
    groupBy: row.groupBy,
    refEntity: row.refEntity,
    role: row.role,
    source: row.source,
  }));
}

/**
 * T2 に見せる確定した仕様。要件ごとの種類（`kind`：existence／constraining）を除く——T2 の分類（nature）を
 * Plan の種類から独立に保つ（§1.1。窓口の判断。#508）。ほかの欄はそのまま。
 */
function visiblePlan(plan: ConfirmedPlan): unknown {
  return {
    ...plan,
    requirements: plan.requirements.map(({ kind: _kind, ...rest }) => rest),
  };
}

/**
 * T2 のデータ。確定した仕様（要件ごとの種類を除く）・要件の一覧（持ち越しを除く）・表（名前を除く）・確かめ方・所属（持ち越しの要件と、
 * その要件だけの行を除く。導いた entity の所属を含む）の順。**要件ごとの種類（T1 の分類）は入れない**。
 * やり直しでは、前回に実際に検査した試験（外して種類を書き込んだ後の組の試験に、その観測する性質を添えたもの）と
 * 前回の作り直しの指示を末尾に足し、判定（J2）で決めた種類があればその後ろに足す（前置きは変えない。#439・#526）。
 */
function buildData(
  plan: ConfirmedPlan,
  list: RequirementList,
  table: NameTable,
  previous: readonly Problem[],
  previousTests: readonly unknown[] | undefined,
  decidedNatures: readonly DecidedNatureRow[],
  ledger?: LedgerView,
): readonly PromptData[] {
  const [planName, listName, tableName, verificationName, ownershipName] = TEST_SPEC_DATA_NAMES;
  const data: PromptData[] = [
    { name: planName, text: serializeJson(visiblePlan(plan)) },
    { name: listName, text: serializeJson(list) },
    { name: tableName, text: serializeJson(visibleRows(table)) },
    {
      name: verificationName,
      text: serializeJson(
        table.verification.map((entry) => ({
          requirementId: entry.requirementId,
          verificationKind: entry.kind,
          checks: entry.kind === "structural" ? entry.checks : [],
          // 既定値の要件にだけ、期待するキーを添える（ほかの項目は今までどおり。Issue #533）。旗 on なら、確かめ方に
          // 結び付いた性質の欄（台帳の行の `valueField`）を添える（Issue #547）
          ...(ledger === undefined
            ? entry.kind === "default-value"
              ? { value: entry.value }
              : {}
            : ledgerValueOf(ledger, entry)),
        })),
      ),
    },
    { name: ownershipName, text: serializeJson(deriveOwnership(table)) },
  ];
  if (previous.length > 0) {
    const [testsName, problemsName] = TEST_SPEC_RETRY_DATA_NAMES;
    if (previousTests !== undefined) data.push({ name: testsName, text: serializeJson(previousTests) });
    data.push({ name: problemsName, text: serializeJson(previous) });
    if (decidedNatures.length > 0) {
      data.push({ name: TEST_SPEC_DECIDED_NATURES_DATA_NAME, text: serializeJson(decidedNatures) });
    }
  }
  return data;
}

/** 旗 on：確かめ方に結び付いた性質の欄（無ければ空の写像） */
function ledgerValueOf(ledger: LedgerView, entry: NameTable["verification"][number]): Record<string, unknown> {
  const t1 = ledger.rowByVerificationKind.get(entry.kind)?.t1;
  if (t1 === undefined || t1 === null) return {};
  return { [t1.valueField]: (entry as unknown as Record<string, unknown>)[t1.valueField] };
}

// ── 段 ────────────────────────────────────────────────────────────

/** T2 が受け取るもの */
export interface TestSpecInput {
  /** 確定した仕様（要件と出どころの正本） */
  readonly plan: ConfirmedPlan;
  /** 要件の一覧（持ち越しを含む全件。除くのはこの段） */
  readonly list: RequirementList;
  /** 採用した名前の表（全行） */
  readonly table: NameTable;
  /** 持ち越しの集合と除く範囲（A1 の `deriveCarryOver` の結果） */
  readonly carryOver: CarryOver;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** 判定の口（J2）。渡されたときだけ、種類が食い違った要件を聞く。無ければ `ruled` へ倒す */
  readonly judge?: Judge;
  /** 外した（構造で確かめる要件の、構造の検査でない）試験を、回ごとに受け取る口（v1 の ②' と同じ） */
  readonly onDropped?: (dropped: readonly DroppedNonstructuralTest[]) => void;
  /** 断った候補（形と中身）を断った時点で受け取る観測用の口（#501 の作法。省けば何もしない） */
  readonly onRejected?: (candidate: RejectedCandidate) => void;
  /** 性質の台帳の導出（旗 `v12.ledger` が on の走りだけが渡す。省けば今の定数と関数。Issue #547） */
  readonly ledger?: LedgerView;
}

/** T2 の結果 */
export interface TestSpecValue {
  /** 固定した試験の組（外して、採った種類を書き込んだ後） */
  readonly suite: TestSuite;
  /** 試験 ID → 観測する性質（固定した組の試験だけ） */
  readonly observes: ReadonlyMap<string, TestObserves>;
  /** 網羅の単位（A1 の `coverageUnitsOf`。B6 が同じ関数で掛け直す） */
  readonly coverage: readonly CoverageUnit[];
  /** 試験の組と観測する性質の SHA-256（正規化した JSON。`testSuiteSha256`） */
  readonly sha256: string;
  /** 回数（1 から） */
  readonly rounds: number;
  /** 採った要件ごとの種類（網羅の検査と網羅の単位に使ったもの） */
  readonly natures: ReadonlyMap<string, RequirementNature>;
  /** T1 と T2 の分類の食い違い（採った種類と、判定か fallback か） */
  readonly discrepancies: readonly NatureDiscrepancy[];
  /** 固定の前に外した試験（回ごとに数える） */
  readonly dropped: readonly DroppedNonstructuralTest[];
}

/**
 * 試験の組の SHA-256（キーを並べ替えた正規化 JSON）。組と、試験 ID → 観測する性質を 1 つの JSON にして測る
 * （観測する性質は FixedTest の外に持つので、組だけを測ると性質の差し替えを SHA が見逃す。窓口の判断。#508）
 */
export function testSuiteSha256(suite: TestSuite, observes: ReadonlyMap<string, TestObserves>): Promise<string> {
  return sha256Hex(canonicalJson({ suite, observes: Object.fromEntries(observes) }));
}

/** 採った種類を、組の分類に書き込む（v1 の ②' と同じ扱い） */
function withAdoptedNatures(suite: TestSuite, adopted: ReadonlyMap<string, RequirementNature>): TestSuite {
  if (adopted.size === 0) return suite;
  const out: { requirementId: string; nature: RequirementNature }[] = [];
  const seen = new Set<string>();
  for (const entry of suite.classifications ?? []) {
    out.push({ requirementId: entry.requirementId, nature: adopted.get(entry.requirementId) ?? entry.nature });
    seen.add(entry.requirementId);
  }
  for (const [requirementId, nature] of adopted) {
    if (!seen.has(requirementId)) out.push({ requirementId, nature });
  }
  return { ...suite, classifications: out };
}

/**
 * T2 の分類の完全性：残る要件（持ち越しを除いた一覧）の全部に、分類がちょうど 1 件あること（§1.1）。
 * 欠落・重複・一覧に無い要件 ID を固定文で落とす。共有の `reconcileNatures` は片方の分類しか無ければそれを
 * 採るので、照合の前にここで断る（T1 の分類だけで種類を決めさせない。レビュー #521 の指摘 1）。
 */
export function checkClassificationCompleteness(
  list: RequirementList,
  classifications: readonly RequirementClassification[] | undefined,
): readonly Problem[] {
  const problems: Problem[] = [];
  const known = new Set(list.requirements.map((requirement) => requirement.id));
  const seen = new Set<string>();
  (classifications ?? []).forEach((entry, index) => {
    const field = `classifications[${index}].requirementId`;
    if (!known.has(entry.requirementId)) {
      problems.push({ field, message: "要件の一覧に無い要件 ID の分類である" });
      return;
    }
    if (seen.has(entry.requirementId)) {
      problems.push({ field, message: "同じ要件の分類が重なっている" });
      return;
    }
    seen.add(entry.requirementId);
  });
  list.requirements.forEach((requirement, index) => {
    if (!seen.has(requirement.id)) problems.push({ field: `requirements[${index}]`, message: "要件の分類が無い" });
  });
  return problems;
}

/** 一度決めた種類の判断（判断した回の T2 の分類と、judged／fallback） */
interface DecidedNature {
  readonly classified: RequirementNature;
  readonly decision: NatureDecision;
}

/**
 * 種類を採る。T1 の分類と食い違ったことのある要件は、**その回の分類が一致しても食い違っても**、一度決めた
 * 判断（judged なら選んだ種類、fallback なら ruled）を採り、食い違いの記録も判断した回のものを返す
 * （§1.1「前の判断を保つ」。レビュー #521 の指摘 2）。ほかの要件は共有の `reconcileNatures` に任せる。
 */
function adoptNatures(
  design: DesignResult,
  classifications: readonly RequirementClassification[] | undefined,
  decided: ReadonlyMap<string, DecidedNature>,
): { readonly natures: ReadonlyMap<string, RequirementNature>; readonly discrepancies: readonly NatureDiscrepancy[] } {
  const natures = new Map(reconcileNatures(design, classifications).natures);
  const discrepancies: NatureDiscrepancy[] = [];
  for (const [requirementId, { classified, decision }] of decided) {
    const entry = design.designs.find((candidate) => candidate.requirementId === requirementId);
    if (entry?.nature === undefined) continue;
    if (decision.kind === "judged") {
      natures.set(requirementId, decision.nature);
      discrepancies.push({
        requirementId,
        design: entry.nature,
        classified,
        resolved: decision.nature,
        resolution: "judged",
        probability: decision.probability,
        model: decision.model,
        thresholdVersion: NATURE_JUDGE_THRESHOLD_VERSION,
      });
    } else {
      natures.set(requirementId, "ruled");
      discrepancies.push({ requirementId, design: entry.nature, classified, resolved: "ruled", resolution: "fallback" });
    }
  }
  return { natures, discrepancies };
}

/**
 * 判定（J2）で決めた要件だけの採った種類（決めた順）。判定の失敗・確率不足で `ruled` へ倒した `fallback` は含めない
 * （Issue #526。決定は 1 回の生成で 1 度だけなので、渡しても分類の独立性は変わらない）
 */
function judgedNatures(decided: ReadonlyMap<string, DecidedNature>): readonly DecidedNatureRow[] {
  const rows: DecidedNatureRow[] = [];
  for (const [requirementId, { decision }] of decided) {
    if (decision.kind === "judged") rows.push({ requirementId, nature: decision.nature });
  }
  return rows;
}

/** 組の試験だけに絞った、試験 ID → 観測する性質 */
function observesOf(tests: readonly FixedTest[], observes: ReadonlyMap<string, TestObserves>): ReadonlyMap<string, TestObserves> {
  const out = new Map<string, TestObserves>();
  for (const test of tests) {
    const observed = observes.get(test.id);
    if (observed !== undefined) out.set(test.id, observed);
  }
  return out;
}

/**
 * T2 を回す。形は `callStructuredChecked` が 1 回だけやり直し、コードの検査に合わなければ**1 回だけ作り直させる**。
 * 2 回で落ちれば `unmet`。分類が残る要件にちょうど 1 件ずつでなければ、照合の前に中身の落ちとして作り直させる。
 * 同じ要件の種類は 1 回の生成の中で 1 度だけ判定に聞き、決めた判断を以後の回でも保つ（その回に一致しても）。
 *
 * 前提（満たさなければ例外。LLM を呼ばない）：残る要件が 1 つ以上ある（全件持ち越しなら T2 を呼ばない。D15）・
 * 持ち越しを除いた行の参照が残る行を指していない（A1 の `pruneForCarryOver`）・残る要件の全部に表の確かめ方と
 * 分類がある。
 */
export async function runTestSpec(input: TestSpecInput): Promise<StageOutcome<TestSpecValue>> {
  if (input.carryOver.allCarried) {
    throw new Error("T2：残る要件が 0 である（全件持ち越しなら T2 を呼ばない）");
  }
  const pruned = pruneForCarryOver(input.list, input.table, input.carryOver);
  const list = pruned.list;
  const design: DesignResult = pruned.conversion.design;
  if (list.requirements.length === 0) {
    throw new Error("T2：残る要件が 0 である（全件持ち越しなら T2 を呼ばない）");
  }
  for (const requirement of list.requirements) {
    const entry = design.designs.find((candidate) => candidate.requirementId === requirement.id);
    if (entry === undefined || entry.nature === undefined) {
      throw new Error("T2：残る要件に、表の確かめ方か分類が無い");
    }
  }

  // 既定値で確かめる要件（持ち越しを除いた表の確かめ方から引く。免除・評価可能性・試験の形の検査に使う。Issue #533）。
  // 旗 on なら、確かめ方に結び付いた性質で確かめる要件を台帳から引く（Issue #547）
  const ledger = input.ledger;
  const defaults = defaultValueTargetsOf(pruned.table);
  const targets = ledger === undefined ? undefined : ledgerTargetsOf(pruned.table, ledger);
  const rules = ledger === undefined ? TEST_SPEC_RULES : ruleTexts(testSpecRuleDefinitionsOf(ledger));
  const schema = testSpecSchemaOf(ledger);
  const check = (output: unknown): ShapeCheck<TestSpecOutput> => checkTestSpecOutput(output, ledger);

  let previous: readonly Problem[] = [];
  let previousTests: readonly unknown[] | undefined;
  const decided = new Map<string, DecidedNature>();
  const droppedAll: DroppedNonstructuralTest[] = [];
  const onRejected = input.onRejected;
  for (let round = 1; round <= TEST_SPEC_ROUNDS; round += 1) {
    const request = buildStructuredRequest({
      rules,
      documents: input.documents,
      data: buildData(input.plan, list, pruned.table, previous, previousTests, judgedNatures(decided), ledger),
      schemaName: TEST_SPEC_SCHEMA_NAME,
      schema,
      maxOutputTokens: input.gateway.maxOutputTokens("test-spec"),
    });
    let shapeRejections = 0;
    const answer = await callStructuredChecked(input.gateway, {
      request,
      check: ledger === undefined ? checkTestSpecOutput : check,
      ...(onRejected === undefined
        ? {}
        : {
            onShapeRejected: (rejection) => {
              shapeRejections += 1;
              onRejected(shapeRejectedCandidate(round, rejection));
            },
          }),
    });
    if (!answer.ok) return answer;
    const generated = answer.value.suite;

    // 構造で確かめる要件の、構造の検査でない試験を、照合と固定の前に外す（v1 の ②' と同じ）
    const dropResult = dropNonstructuralTests(design, generated, round);
    if (dropResult.dropped.length > 0) {
      for (const entry of dropResult.dropped) droppedAll.push(entry);
      input.onDropped?.(dropResult.dropped);
    }

    // 分類の完全性を照合の前に確かめる。欠ければ判定に聞かず、中身の落ちとして作り直させる
    const classificationProblems = checkClassificationCompleteness(list, generated.classifications);
    let suite: TestSuite = dropResult.suite;
    let observes = observesOf(suite.tests, answer.value.observes);
    let problems: readonly Problem[] = classificationProblems;
    if (classificationProblems.length === 0) {
      // 食い違った要件のうち、まだ決めていないものを 1 回の呼び出しにまとめて判定に聞く（判定の口が無ければ fallback）
      const fresh = reconcileNatures(design, generated.classifications).discrepancies.filter(
        (entry) => !decided.has(entry.requirementId),
      );
      if (fresh.length > 0) {
        // 既定値で確かめる要件は判定に聞かず、既存の fallback（ruled）で採る（表の分類は T1' が ruled と確かめ済み。Issue #533）
        const exempted: ReadonlyMap<string, unknown> = targets ?? defaults;
        const asked = fresh.filter((entry) => !exempted.has(entry.requirementId)).map((entry) => entry.requirementId);
        const verdicts =
          input.judge === undefined || asked.length === 0
            ? new Map<string, NatureDecision>()
            : await decideDiscrepantNatures({ judge: input.judge, list, requirementIds: asked });
        for (const entry of fresh) {
          decided.set(entry.requirementId, { classified: entry.classified, decision: verdicts.get(entry.requirementId) ?? { kind: "fallback" } });
        }
      }
      const reconciled = adoptNatures(design, generated.classifications, decided);
      const adopted = new Map<string, RequirementNature>();
      for (const entry of reconciled.discrepancies) adopted.set(entry.requirementId, entry.resolved);
      suite = withAdoptedNatures(dropResult.suite, adopted);
      observes = observesOf(suite.tests, answer.value.observes);

      // v1 の検査（新契約）＋評価可能性。持ち越しの要件の試験は、除いた一覧で「一覧に無い要件 ID」として落ちる
      // v1 の検査は組全体と残る一覧で 1 回だけ呼び、既定値の要件の異常・境界の不足の 2 文だけを外す（Issue #533）
      problems =
        targets === undefined || ledger === undefined
          ? [
              ...exemptDefaultValueProblems(checkSuitePlan(list, suite, design, reconciled.natures), list, defaults),
              ...checkEvaluability(suite, observes, pruned.table),
              ...checkDefaultValueTests(suite, observes, defaults, jsonStringExpectedIds(answer.output)),
            ]
          : [
              ...exemptLedgerProblems(checkSuitePlan(list, suite, design, reconciled.natures), list, targets),
              ...checkEvaluabilityByLedger(suite, observes, pruned.table, ledger),
              ...checkLedgerTests(suite, observes, targets, jsonStringExpectedIds(answer.output)),
            ];
      if (problems.length === 0) {
        const coverage = coverageUnitsOf({ suite, observes, natures: reconciled.natures });
        return {
          ok: true,
          value: {
            suite,
            observes,
            coverage,
            sha256: await testSuiteSha256(suite, observes),
            rounds: round,
            natures: reconciled.natures,
            discrepancies: reconciled.discrepancies,
            dropped: droppedAll,
          },
        };
      }
    }
    onRejected?.({
      kind: "content",
      round,
      attempt: shapeRejections + 1,
      target: suite,
      response: answer.output,
      inspectionList: list,
      problems: withReference(problems, "target"),
    });
    previous = problems;
    previousTests = suite.tests.map((test) => ({ ...test, observes: observes.get(test.id) ?? null }));
    if (round < TEST_SPEC_ROUNDS) input.gateway.noteRetry("content");
  }
  return { ok: false, failure: { kind: "unmet", attempts: TEST_SPEC_ROUNDS, problems: previous } };
}
