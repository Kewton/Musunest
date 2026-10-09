// ②' 試験を作って固定する（02-architecture.md §1・§1.3・F-9）。
//
// **宣言を見せない**別の会話で、要件から期待を作らせる（宣言に合わせた期待を作らせない。§1.3）。
// だからこの段には要件の一覧だけを渡し、宣言は渡さない。
//
// コードが次を確かめてから**固定する**。満たさなければ 1 回だけ作り直させ、それでも欠ける要件は
// 未達として持つ（合否はここでは決めない）：
//
//   - 試験の集合が空でない
//   - 要件 ID が ① の一覧に実在する
//   - 要件ごとに、正常・異常・境界がそろう
//   - selector（要件 ID と役割）が 1 つの要件と役割に一意に決まる
//   - 上限（要件ごとの試験の数・参照データの行数。§1.5）
import { TEST_KINDS, checkTestSuite, type TestSuite, type TestTargetKind } from "../fixed-test.js";
import { checkLimit } from "../limits.js";
import type { RequirementList } from "../pipeline.js";
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

/** ②' の出力トークンの上限 */
export const TEST_SUITE_MAX_OUTPUT_TOKENS = 8_192;

/** 作り直しの回数（1 回だけやり直す。§1） */
export const TEST_SUITE_ROUNDS = 2;

/** ②' に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const TEST_SUITE_RULES: readonly string[] = [
  "要件ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
  "対象（target）は名前ではなく、要件 ID と役割（role）で指す。宣言は見られないので、名前を書かない。",
  "時計（clock）は固定の日時（オフセット付きの ISO 8601）にする。",
  "異常の試験の期待は誤りコード（expected.kind = error）、それ以外は値（expected.kind = ok）にする。",
  "要件 ID は①の一覧のものだけを使う。一覧に無い要件 ID を作らない。",
];

/** ②' の JSON Schema（構造化出力） */
export const TEST_SUITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tests"],
  properties: {
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "target", "kind", "operation", "clock", "input", "referenceData", "expected"],
        properties: {
          id: { type: "string" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["requirementId", "kind", "role"],
            properties: {
              requirementId: { type: "string" },
              kind: { type: "string", enum: ["entity", "field", "computation", "operation", "screen"] },
              role: { type: "string" },
            },
          },
          kind: { type: "string", enum: [...TEST_KINDS] },
          operation: { type: "string", enum: ["compute", "validate", "action", "aggregate", "screen"] },
          clock: { type: "string" },
          input: {},
          referenceData: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["target", "values"],
              properties: {
                target: {
                  type: "object",
                  additionalProperties: false,
                  required: ["requirementId", "kind", "role"],
                  properties: {
                    requirementId: { type: "string" },
                    kind: { type: "string", enum: ["entity", "field", "computation", "operation", "screen"] },
                    role: { type: "string" },
                  },
                },
                values: { type: "object" },
              },
            },
          },
          expected: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: ["ok", "error"] },
              value: {},
              code: { type: "string" },
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
}

function checkSelectorAmbiguity(list: RequirementList, suite: TestSuite, problems: Problem[]): void {
  const ids = list.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    problems.push({ field: "requirements", message: "要件 ID が一覧の中で重なっている（selector が一意に決まらない）" });
  }
  const kindOfSelector = new Map<string, TestTargetKind>();
  suite.tests.forEach((test, index) => {
    const key = `${test.target.requirementId}\u0000${test.target.role}`;
    const previous = kindOfSelector.get(key);
    if (previous === undefined) {
      kindOfSelector.set(key, test.target.kind);
      return;
    }
    if (previous !== test.target.kind) {
      problems.push({
        field: `tests[${index}].target`,
        message: `selector（要件 ${test.target.requirementId}・役割 ${test.target.role}）が一意に決まらない（対象の種類が ${previous} と ${test.target.kind} で食い違う）`,
      });
    }
  });
}

/**
 * 固定する前にコードが確かめる（§1）。合わない欄を**すべて**挙げて返す。
 * 空なら固定してよい。挙げた数が 0 でなければ、その内容で 1 回だけ作り直させる。
 */
export function checkSuiteAgainstRequirements(list: RequirementList, suite: TestSuite): readonly Problem[] {
  const problems: Problem[] = [];
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
    const kinds = new Set(mine.map((test) => test.kind));
    for (const kind of TEST_KINDS) {
      if (!kinds.has(kind)) {
        problems.push({ field: "tests", message: `要件 ${requirement.id} に ${kind} の試験が無い` });
      }
    }
  }
  return problems;
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
  const checked = checkTestSuite(tests);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  return { ok: true, value: checked.suite };
}

/** ②' のデータ（要件の一覧だけ。やり直しのときは前回の作り直しの指示を足す） */
function buildData(list: RequirementList, previous: readonly Problem[]): readonly PromptData[] {
  const data: PromptData[] = [{ name: "要件の一覧", text: serializeJson(list) }];
  if (previous.length > 0) {
    data.push({ name: "前回の作り直しの指示", text: serializeJson(previous) });
  }
  return data;
}

/** ②' の結果（固定した試験の組と、やり直した回数） */
export interface TestSuiteValue {
  readonly suite: TestSuite;
  readonly rounds: number;
}

/**
 * ②' を回す。形は `callStructuredChecked` が 1 回だけやり直し、コードの検査（`checkSuiteAgainstRequirements`）
 * に合わなければ**1 回だけ作り直させる**。それでも合わなければ `unmet`（未達）として、欠けの内容を返す。
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
      maxOutputTokens: TEST_SUITE_MAX_OUTPUT_TOKENS,
    });
    const answer = await callStructuredChecked(input.gateway, { request, check: checkTestSuiteOutput });
    if (!answer.ok) return answer;
    const problems = checkSuiteAgainstRequirements(input.list, answer.value);
    if (problems.length === 0) {
      return { ok: true, value: { suite: answer.value, rounds: round } };
    }
    previous = problems;
  }
  return { ok: false, failure: { kind: "unmet", attempts: TEST_SUITE_ROUNDS, problems: previous } };
}
