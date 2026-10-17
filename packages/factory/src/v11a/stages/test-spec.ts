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

/** T2 の JSON Schema の名前 */
export const TEST_SPEC_SCHEMA_NAME = "test-spec";

/** 作り直しの回数（1 回だけやり直す。v1 の ②' と同じ。§1 の表） */
export const TEST_SPEC_ROUNDS = 2;

// ── 観測する性質と評価の方法の表（02 §1.3・07 §2.3）──────────────────────

/**
 * 試験が観測する性質。`state-after-set`（操作に set を当てたあとの状態）と `default-value`（項目の既定値）は
 * 評価の方法の表で**未対応**であり、作れば落ちる（v1 は作ってから ⑤b で未解決にしていた）。
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
export const UNSUPPORTED_OBSERVES: readonly TestObserves[] = ["state-after-set", "default-value"];

const isTestObserves = (value: unknown): value is TestObserves =>
  typeof value === "string" && (TEST_OBSERVES as readonly string[]).includes(value);

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

/**
 * 評価可能性：試験ごとの（対象の種類・操作・観測する性質）の組を、評価の方法の表に照らす（§2.3 の (i)）。
 * 未対応の性質・表に無い組・構造の検査の中身に合わない性質・性質の引けない試験を、固定文で落とす。
 */
export function checkEvaluability(suite: TestSuite, observes: ReadonlyMap<string, TestObserves>): readonly Problem[] {
  const problems: Problem[] = [];
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
        message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態・項目の既定値の試験は作らない）",
      });
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
    text: "確かめ方が structural の要件を除いて、決まりを含む要件は、決まりの対象ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
    why: "決まりを含む要件に正常・異常・境界の試験を作らせる（R-suite-02 を元にする）",
    since: "Issue #508",
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
    text: "試験ごとに、観測する性質（observes）を 1 つ書く。組は次のどれかに限る：計算 × compute・aggregate は value、項目・entity × validate は validation、操作 × action は when、画面 × screen は view-structure、項目 × screen は view-structure、entity × screen は existence、構造の検査（structure）は view-shows なら view-structure・ほかの中身なら existence。操作に set を当てたあとの状態（state-after-set）と項目の既定値（default-value）は評価できないので、その試験は作らない。",
    why: "試験が観測する性質を評価の方法の表に照らせるようにし、評価できない試験を作らせない（07 §2.3・02 §1.3）",
    since: "Issue #508",
  },
];

/** T2 に足す規則（共通の規則は buildStructuredRequest が先頭に付ける。定義の `text` から組む） */
export const TEST_SPEC_RULES: readonly string[] = ruleTexts(TEST_SPEC_RULE_DEFINITIONS);

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
export function checkTestSpecOutput(output: unknown): ShapeCheck<TestSpecOutput> {
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
    if (!isTestObserves(observed)) {
      problems.push({ field: `tests[${index}].observes`, message: `観測する性質は ${TEST_OBSERVES.join("・")} のいずれかであること` });
    }
    const id = raw["id"];
    if (typeof id !== "string" || id === "") return;
    if (seen.has(id)) {
      problems.push({ field: `tests[${index}].id`, message: "試験の識別子が組の中で重なっている" });
      return;
    }
    seen.add(id);
    if (isTestObserves(observed)) observes.set(id, observed);
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

  let previous: readonly Problem[] = [];
  let previousTests: readonly unknown[] | undefined;
  const decided = new Map<string, DecidedNature>();
  const droppedAll: DroppedNonstructuralTest[] = [];
  const onRejected = input.onRejected;
  for (let round = 1; round <= TEST_SPEC_ROUNDS; round += 1) {
    const request = buildStructuredRequest({
      rules: TEST_SPEC_RULES,
      documents: input.documents,
      data: buildData(input.plan, list, pruned.table, previous, previousTests, judgedNatures(decided)),
      schemaName: TEST_SPEC_SCHEMA_NAME,
      schema: TEST_SPEC_SCHEMA,
      maxOutputTokens: input.gateway.maxOutputTokens("test-spec"),
    });
    let shapeRejections = 0;
    const answer = await callStructuredChecked(input.gateway, {
      request,
      check: checkTestSpecOutput,
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
        const verdicts =
          input.judge === undefined
            ? new Map<string, NatureDecision>()
            : await decideDiscrepantNatures({ judge: input.judge, list, requirementIds: fresh.map((entry) => entry.requirementId) });
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
      problems = [...checkSuitePlan(list, suite, design, reconciled.natures), ...checkEvaluability(suite, observes)];
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
