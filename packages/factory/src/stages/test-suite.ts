// ②' 試験を作って固定する（02-architecture.md §1・§1.3・F-9・Issue #307）。
//
// **宣言を見せない**別の会話で、要件から期待を作らせる（宣言に合わせた期待を作らせない。§1.3）。
// だからこの段には要件の一覧だけを渡し、宣言は渡さない。
//
// Issue #307 で、②' の入力の契約と、固定する前のコードの検査を直した（疎通の確認で、固定した試験が
// 宣言の要素に結び付かず、直す段が締切まで回り続けた）：
//   - 要件ごとの**種類**を、②' が原文と要件の一覧から**独立に**分類し直す（設計の出力は見せない）。
//     設計の種類と食い違う要件は**決まりを含むほうへ倒し**、食い違いを結果に残す（`reconcileNatures`）
//   - **在ることだけ**の要件には、異常・境界の試験や検査（validate）の試験を作らない
//   - 試験の対象と参照の行を、**自由な文ではなく役割 ID** で指す。入力の契約（固定の行 ID・評価の対象の
//     行 ID・空の entity の集合）を足す
//   - 異常の期待を**操作ごとの型**にする（検査は誤りコード、計算・集計は値も許す）
//
// コードが次を確かめてから**固定する**。満たさなければ 1 回だけ作り直させ、それでも欠ける要件は
// 未達として持つ（合否はここでは決めない）：
//
//   - 試験の集合が空でない
//   - 要件 ID が ① の一覧に実在する
//   - 要件ごとの種類に応じて、正常・異常・境界（決まりを含む）か、正常だけ（在ることだけ）がそろう
//   - selector（要件 ID と役割 ID）が 1 つの要件と役割に一意に決まる
//   - 上限（要件ごとの試験の数・参照データの行数。§1.5）
import {
  REQUIREMENT_NATURES,
  TEST_KINDS,
  TEST_OPERATIONS,
  TEST_TARGET_KINDS,
  checkTestSuite,
  isRequirementNature,
  type RequirementClassification,
  type RequirementNature,
  type TestSuite,
  type TestTarget,
  type TestTargetKind,
} from "../fixed-test.js";
import { checkLimit } from "../limits.js";
import type { DesignResult, NatureDiscrepancy, RequirementList } from "../pipeline.js";
import type { CallGateway } from "../call.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ②' の JSON Schema の名前 */
export const TEST_SUITE_SCHEMA_NAME = "test-suite";

/** 作り直しの回数（1 回だけやり直す。§1） */
export const TEST_SUITE_ROUNDS = 2;

/** ②' に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const TEST_SUITE_RULES: readonly string[] = [
  "原文と要件の一覧だけから、要件ごとの種類（nature）を独立に分類し直す（設計の出力は見せられない）。決まり（条件・計算・検査）を含むなら ruled、在ることだけ（例「名前を持つメンバーを登録できる」）なら existence-only。分類は classifications に入れる。",
  "決まりを含む要件は、決まりの役割ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
  "在ることだけの要件は、正常のシナリオ 1 本か、構造の条件（create の操作がある・その entity の一覧か表に項目が出る・画面の部品がある）だけを固定する。**異常・境界の試験や検査（validate）の試験は作らない**。",
  "入力（input）と参照データの値（values）と期待の値（value）は、任意の JSON を表すので、**JSON の文字列**として書く（例: \"{\\\"amount\\\": 21}\"）。",
  "異常の期待は、操作ごとの型にする。検査（validate）の異常は誤りコード（expected.code）で確かめ、value は null にする。計算・集計（compute・aggregate）の異常は、値（expected.value）でもよい。それ以外の正常は値の JSON 文字列を value に入れ、code は null にする。",
  "対象（target）と参照の行（referenceData の target）は、名前ではなく**役割 ID（roleId）**で指す。役割 ID は ② の役割 ID の表のものを使う。宣言は見られないので、名前を書かない。",
  "入力の契約（inputContract）に、固定の行 ID（rowId）・評価の対象の行 ID（targetRowId。行を評価しないときは null）・空であることを明示する entity の役割 ID（emptyEntities）を入れる。",
  "時計（clock）は固定の日時（オフセット付きの ISO 8601）にする。",
  "要件 ID は①の一覧のものだけを使う。一覧に無い要件 ID を作らない。",
];

/**
 * ②' の JSON Schema（構造化出力）。**OpenAI の strict の規則に合わせる**（すべての節に `type`、
 * object は `additionalProperties: false` とすべての欄を `required`、任意の欄は null を許す型で表す。§2）。
 *
 * 入力・参照データの値・期待の値は**任意の JSON**（宣言を見る前には形が決まらない）なので、strict で
 * 表せるよう** JSON の文字列**として受ける。コード（`checkTestSuiteOutput`）が読んで値に戻す。
 */
export const TEST_SUITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classifications", "tests"],
  properties: {
    classifications: {
      type: "array",
      description: "原文と要件の一覧から独立に分類した、要件ごとの種類",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "nature"],
        properties: {
          requirementId: { type: "string" },
          nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "target",
          "kind",
          "operation",
          "clock",
          "input",
          "inputContract",
          "referenceData",
          "expected",
        ],
        properties: {
          id: { type: "string" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["requirementId", "kind", "roleId"],
            properties: {
              requirementId: { type: "string" },
              kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
              roleId: { type: "string", description: "役割 ID（② の役割 ID の表のもの）" },
            },
          },
          kind: { type: "string", enum: [...TEST_KINDS] },
          operation: { type: "string", enum: [...TEST_OPERATIONS] },
          clock: { type: "string" },
          input: { type: "string", description: "入力（レコード）の JSON 文字列" },
          inputContract: {
            type: "object",
            additionalProperties: false,
            required: ["rowId", "targetRowId", "emptyEntities"],
            properties: {
              rowId: { type: "string", description: "固定の行 ID（入力の行）" },
              targetRowId: {
                type: ["string", "null"],
                description: "評価の対象の行の ID（行を評価しないときは null）",
              },
              emptyEntities: {
                type: "array",
                items: { type: "string" },
                description: "空であることを明示する entity の役割 ID",
              },
            },
          },
          referenceData: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rowId", "target", "values"],
              properties: {
                rowId: { type: "string", description: "行の ID（固定）" },
                target: {
                  type: "object",
                  additionalProperties: false,
                  required: ["requirementId", "kind", "roleId"],
                  properties: {
                    requirementId: { type: "string" },
                    kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
                    roleId: { type: "string" },
                  },
                },
                values: { type: "string", description: "行の値（項目の役割 → 値）の JSON 文字列" },
              },
            },
          },
          expected: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value", "code"],
            properties: {
              kind: { type: "string", enum: ["ok", "error"] },
              value: { type: ["string", "null"], description: "期待する値の JSON 文字列（kind が error のときは null）" },
              code: { type: ["string", "null"], description: "期待する誤りコード（kind が ok のときは null）" },
            },
          },
        },
      },
    },
  },
} as const;

/** ②' が受け取るもの（要件の一覧だけ。宣言は渡さない） */
export interface TestSuiteInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /**
   * ② の設計（要件ごとの種類）。渡されたときだけ、②' の分類と突き合わせて（`reconcileNatures`）、
   * 種類に応じた検査（`checkSuitePlan`）を掛ける。渡されなければ旧来の検査だけを行う（後方互換）。
   */
  readonly design?: DesignResult;
}

/** selector の鍵（要件 ID と役割 ID。旧形式の自由な文の役割も受ける） */
function selectorRoleOf(target: TestTarget): string {
  return target.roleId ?? target.role ?? "";
}

function checkSelectorAmbiguity(list: RequirementList, suite: TestSuite, problems: Problem[]): void {
  const ids = list.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    problems.push({ field: "requirements", message: "要件 ID が一覧の中で重なっている（selector が一意に決まらない）" });
  }
  const kindOfSelector = new Map<string, TestTargetKind>();
  suite.tests.forEach((test, index) => {
    const key = `${test.target.requirementId}\u0000${selectorRoleOf(test.target)}`;
    const previous = kindOfSelector.get(key);
    if (previous === undefined) {
      kindOfSelector.set(key, test.target.kind);
      return;
    }
    if (previous !== test.target.kind) {
      problems.push({
        field: `tests[${index}].target`,
        message: `selector（要件 ${test.target.requirementId}・役割 ${selectorRoleOf(test.target)}）が一意に決まらない（対象の種類が ${previous} と ${test.target.kind} で食い違う）`,
      });
    }
  });
}

/** 空の試験集合・一覧に無い要件 ID・参照データの行数・selector の一意性を確かめる（種類によらない） */
function checkSuiteBasics(list: RequirementList, suite: TestSuite, problems: Problem[]): void {
  const idSet = new Set(list.requirements.map((requirement) => requirement.id));
  if (suite.tests.length === 0) {
    problems.push({ field: "tests", message: "試験の集合が空である" });
  }
  suite.tests.forEach((test, index) => {
    if (!idSet.has(test.target.requirementId)) {
      problems.push({
        field: `tests[${index}].target.requirementId`,
        message: `一覧に無い要件 ID: ${test.target.requirementId}`,
      });
    }
    const overRows = checkLimit("referenceRowsPerTest", test.referenceData.length);
    if (overRows !== undefined) {
      problems.push({
        field: `tests[${index}].referenceData`,
        message: `参照データの行が上限 ${overRows.max} を超えている（${overRows.actual}）`,
      });
    }
  });
  checkSelectorAmbiguity(list, suite, problems);
}

/** 要件ごとの試験の数と、種類に応じた種類のそろいを確かめる */
function checkKinds(
  list: RequirementList,
  suite: TestSuite,
  natures: ReadonlyMap<string, RequirementNature>,
  problems: Problem[],
): void {
  for (const requirement of list.requirements) {
    const mine = suite.tests.filter((test) => test.target.requirementId === requirement.id);
    if (mine.length === 0) {
      problems.push({ field: "tests", message: `要件 ${requirement.id} の試験が無い` });
      continue;
    }
    const overCount = checkLimit("testsPerRequirement", mine.length);
    if (overCount !== undefined) {
      problems.push({
        field: "tests",
        message: `要件 ${requirement.id} の試験が上限 ${overCount.max} を超えている（${overCount.actual}）`,
      });
    }
    const nature = natures.get(requirement.id) ?? "ruled";
    if (nature === "existence-only") {
      for (const test of mine) {
        if (test.kind !== "normal") {
          problems.push({
            field: "tests",
            message: `要件 ${requirement.id} は在ることだけなので、${test.kind} の試験を作らない`,
          });
        }
        if (test.operation === "validate") {
          problems.push({
            field: "tests",
            message: `要件 ${requirement.id} は在ることだけなので、検査（validate）の試験を作らない`,
          });
        }
      }
      continue;
    }
    const kinds = new Set(mine.map((test) => test.kind));
    for (const kind of TEST_KINDS) {
      if (!kinds.has(kind)) {
        problems.push({ field: "tests", message: `要件 ${requirement.id} に ${kind} の試験が無い` });
      }
    }
  }
}

/** 設計の役割 ID の表にある ID の集合 */
export function roleIdsOf(design: DesignResult): ReadonlySet<string> {
  return new Set((design.roles ?? []).map((entry) => entry.roleId));
}

/** 試験の対象・参照の行が、設計の役割 ID で指されているか（自由な文の役割だけなら断る） */
function checkRoleIds(suite: TestSuite, roleIds: ReadonlySet<string>, problems: Problem[]): void {
  const check = (target: TestTarget, field: string): void => {
    if (target.roleId === undefined) {
      problems.push({
        field: `${field}.roleId`,
        message: "役割 ID が無い（自由な文の役割だけの試験は固定しない）",
      });
      return;
    }
    if (!roleIds.has(target.roleId)) {
      problems.push({
        field: `${field}.roleId`,
        message: `役割 ID ${target.roleId} が設計の役割 ID の表に無い`,
      });
    }
  };
  suite.tests.forEach((test, index) => {
    check(test.target, `tests[${index}].target`);
    test.referenceData.forEach((row, rowIndex) => {
      check(row.target, `tests[${index}].referenceData[${rowIndex}].target`);
    });
  });
}

/** 異常の期待を、操作ごとの型に照らす（検査は誤りコード。計算・集計は値も許す） */
function checkExpectationKind(suite: TestSuite, problems: Problem[]): void {
  suite.tests.forEach((test, index) => {
    if (test.kind !== "abnormal" || test.operation !== "validate") return;
    if (test.expected.kind !== "error") {
      problems.push({
        field: `tests[${index}].expected`,
        message: "検査（validate）の異常は、誤りコード（expected.code）で確かめる",
      });
    }
  });
}

/**
 * 固定する前にコードが確かめる（§1）。合わない欄を**すべて**挙げて返す。役割 ID の検査はしない
 * （旧形式の記録も通すため。新しい設計を渡す `checkSuitePlan` を使う）。
 */
export function checkSuiteAgainstRequirements(list: RequirementList, suite: TestSuite): readonly Problem[] {
  const problems: Problem[] = [];
  checkSuiteBasics(list, suite, problems);
  checkKinds(list, suite, new Map(), problems);
  return problems;
}

/**
 * 設計と分類を突き合わせた結果を、種類に応じて確かめる（§1・②'・Issue #307）。合わない欄を**すべて**返す。
 * `natures` は `reconcileNatures` の結果（設計の種類と ②' の分類を突き合わせた、実際に使う種類）。
 */
export function checkSuitePlan(
  list: RequirementList,
  suite: TestSuite,
  design: DesignResult,
  natures: ReadonlyMap<string, RequirementNature>,
): readonly Problem[] {
  const problems: Problem[] = [];
  checkSuiteBasics(list, suite, problems);
  checkKinds(list, suite, natures, problems);
  checkRoleIds(suite, roleIdsOf(design), problems);
  checkExpectationKind(suite, problems);
  return problems;
}

/** ②' の分類を、② の設計と突き合わせた結果（実際に使う種類と、食い違った要件） */
export interface NatureReconciliation {
  readonly natures: ReadonlyMap<string, RequirementNature>;
  readonly discrepancies: readonly NatureDiscrepancy[];
}

/** ② の設計から、要件ごとの種類を取り出す */
function designNaturesOf(design: DesignResult): ReadonlyMap<string, RequirementNature> {
  const natures = new Map<string, RequirementNature>();
  for (const entry of design.designs) {
    if (entry.nature !== undefined) natures.set(entry.requirementId, entry.nature);
  }
  return natures;
}

/**
 * ②' が独立に分類した種類を、② の設計の種類と突き合わせる（§1・②'・Issue #307）。
 * **食い違った要件は「決まりを含む」ほうへ倒し**、食い違いを結果に残す。片方しか無ければそれを採り、
 * どちらも無ければ `ruled`（決まりを含む。見落としを合格にしない側へ倒す）。
 */
export function reconcileNatures(
  design: DesignResult,
  classifications: readonly RequirementClassification[] | undefined,
): NatureReconciliation {
  const designNatures = designNaturesOf(design);
  const classified = new Map<string, RequirementNature>();
  for (const entry of classifications ?? []) classified.set(entry.requirementId, entry.nature);
  const natures = new Map<string, RequirementNature>();
  const discrepancies: NatureDiscrepancy[] = [];
  const ids = new Set<string>([...designNatures.keys(), ...classified.keys()]);
  for (const id of ids) {
    const fromDesign = designNatures.get(id);
    const fromClassified = classified.get(id);
    if (fromDesign !== undefined && fromClassified !== undefined && fromDesign !== fromClassified) {
      natures.set(id, "ruled");
      discrepancies.push({ requirementId: id, design: fromDesign, classified: fromClassified, resolved: "ruled" });
      continue;
    }
    natures.set(id, fromDesign ?? fromClassified ?? "ruled");
  }
  return { natures, discrepancies };
}

/**
 * 任意の JSON を表す文字列なら、読んで値に戻す（strict の schema に合わせて文字列で受けるため。§2）。
 * 文字列でなければそのまま返す（記録した試験の fixture は、そのままの値で渡ってくる）。
 */
function decodeJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 生の試験 1 件の、任意の JSON を表す欄（input・referenceData の values・expected の value）を値に戻す */
function decodeTest(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const test: Record<string, unknown> = { ...raw };
  if ("input" in test) test["input"] = decodeJsonValue(test["input"]);
  const rawRows = test["referenceData"];
  if (Array.isArray(rawRows)) {
    test["referenceData"] = rawRows.map((row) =>
      isRecord(row) && "values" in row ? { ...row, values: decodeJsonValue(row["values"]) } : row,
    );
  }
  const rawExpected = test["expected"];
  if (isRecord(rawExpected) && "value" in rawExpected) {
    test["expected"] = { ...rawExpected, value: decodeJsonValue(rawExpected["value"]) };
  }
  return test;
}

/** 分類の並びの形を確かめる（新しい欄。旧形式の記録では省ける） */
function checkClassifications(value: unknown, problems: Problem[]): readonly RequirementClassification[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ field: "classifications", message: "分類の並び（array）であること" });
    return undefined;
  }
  const classifications: RequirementClassification[] = [];
  let good = true;
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push({ field: `classifications[${index}]`, message: "分類は写像（object）であること" });
      good = false;
      return;
    }
    const requirementId = item["requirementId"];
    if (typeof requirementId !== "string" || requirementId === "") {
      problems.push({ field: `classifications[${index}].requirementId`, message: "要件 ID は空でない文字列であること" });
      good = false;
    }
    const nature = item["nature"];
    if (!isRequirementNature(nature)) {
      problems.push({
        field: `classifications[${index}].nature`,
        message: `種類は ${REQUIREMENT_NATURES.join("・")} のいずれかであること`,
      });
      good = false;
      return;
    }
    classifications.push({ requirementId: requirementId as string, nature });
  });
  return good ? classifications : undefined;
}

/** ②' の応答の形を確かめる（欄の形は fixed-test.ts の `checkTestSuite` が正本） */
export function checkTestSuiteOutput(output: unknown): ShapeCheck<TestSuite> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const tests = output["tests"];
  if (!Array.isArray(tests)) {
    return { ok: false, problems: [{ field: "tests", message: "試験の一覧は並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  let classifications: readonly RequirementClassification[] | undefined;
  if ("classifications" in output) {
    classifications = checkClassifications(output["classifications"], problems);
  }
  const checked = checkTestSuite(tests.map(decodeTest));
  if (!checked.ok) {
    return { ok: false, problems: [...problems, ...checked.problems] };
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: { tests: checked.suite.tests, ...(classifications === undefined ? {} : { classifications }) },
  };
}

/** ②' のデータ（要件の一覧だけ。やり直しのときは前回の作り直しの指示を足す） */
function buildData(list: RequirementList, previous: readonly Problem[]): readonly PromptData[] {
  const data: PromptData[] = [{ name: "要件の一覧", text: serializeJson(list) }];
  if (previous.length > 0) {
    data.push({ name: "前回の作り直しの指示", text: serializeJson(previous) });
  }
  return data;
}

/** ②' の結果（固定した試験の組と、やり直した回数、設計と食い違った種類） */
export interface TestSuiteValue {
  readonly suite: TestSuite;
  readonly rounds: number;
  /** ②' の分類と ② の設計が食い違った要件（決まりを含むほうへ倒した。§1・②'・Issue #307） */
  readonly discrepancies: readonly NatureDiscrepancy[];
}

/**
 * ②' を回す。形は `callStructuredChecked` が 1 回だけやり直し、コードの検査に合わなければ
 * **1 回だけ作り直させる**。設計が渡されたときは、分類との食い違いを決まりを含むほうへ倒し、
 * 種類に応じた検査（`checkSuitePlan`）を掛ける。それでも合わなければ `unmet`（未達）として、欠けの
 * 内容を返す。
 */
export async function runTestSuite(input: TestSuiteInput): Promise<StageOutcome<TestSuiteValue>> {
  let previous: readonly Problem[] = [];
  for (let round = 1; round <= TEST_SUITE_ROUNDS; round += 1) {
    const request = buildStructuredRequest({
      rules: TEST_SUITE_RULES,
      documents: input.documents,
      data: buildData(input.list, previous),
      schemaName: TEST_SUITE_SCHEMA_NAME,
      schema: TEST_SUITE_SCHEMA,
      maxOutputTokens: input.gateway.maxOutputTokens("test-suite"),
    });
    const answer = await callStructuredChecked(input.gateway, { request, check: checkTestSuiteOutput });
    if (!answer.ok) return answer;
    let problems: readonly Problem[];
    let discrepancies: readonly NatureDiscrepancy[] = [];
    if (input.design === undefined) {
      problems = checkSuiteAgainstRequirements(input.list, answer.value);
    } else {
      const reconciled = reconcileNatures(input.design, answer.value.classifications);
      discrepancies = reconciled.discrepancies;
      problems = checkSuitePlan(input.list, answer.value, input.design, reconciled.natures);
    }
    if (problems.length === 0) {
      return { ok: true, value: { suite: answer.value, rounds: round, discrepancies } };
    }
    previous = problems;
  }
  return { ok: false, failure: { kind: "unmet", attempts: TEST_SUITE_ROUNDS, problems: previous } };
}
