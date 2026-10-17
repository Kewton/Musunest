// 評価口（07-architecture-v1.1a.md §3・D11。Issue #510）。
//
// A6' の `DeclarationEvaluator` を v1.1α の側で作る。静的チェックを通った宣言（`app`）と**評価の文脈**
// （A6' の `EvaluationContext`：その時点の試験の組＝棄却で外した後の組・持ち越しを除いた要件の一覧と所属・版）を
// 受け、B3（`name-check.ts`）の落ちと、**表の `id` で試験 ID ごとに結び付けた**（A1 の `bindTestsById`。並びでは
// 引かない）⑤b の評価（`runTests`）の結果を返す。v1 の `bindTests`・⑤a の LLM は呼ばない。
//
// **表と除いた行は閉包で持ち、組・一覧・所属は毎回文脈から取る**——修復の輪は棄却のたびに有効な組を作り直す
// ので、初期の組を閉じ込めない。走らせる部分（B4）・⑥ の道具・版の再検査に**同じ関数**を渡す。
//
// **観測する性質（`observes`。T2 で固定した試験 ID → 性質の写像）も閉包で持つ**（必須。Issue #526）。B4 は、文脈の組の
// 試験のうち写像に無い試験 ID を v1 の `runTests` に渡さず、未解決に数える（詳細は固定文。行き先は v1 の `no-mapping` の
// 未解決と同じ `ambiguity`）。写像にある試験は、観測する性質が `default-value` のものを除いて v1 の `runTests` へ渡す。
//
// **観測する性質が `default-value` の試験（Issue #533）は v1 の `runTests` に渡さず、既定値専用の関数
// （`judgeDefaultValue`）で照合する**：表の行の場所（項目）で宣言の entity と項目を引き、項目が選択肢で `default` が
// 期待のキー（decode 済みの文字列。JSON として読み直さない）と完全一致なら合格。項目が無い・選択肢でない・default が
// 無い・キーが違う、は不一致（詳細は固定文。行き先は v1 の不一致と同じ `missing-element`）。期待が文字列でない試験は
// 未解決（行き先は v1 の未解決と同じ `ambiguity`）。検査（validate）の結び付けは使わない。default が options の外・空で
// あることは照合しない——静的チェック（`DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS` ほか）が断ち、落ちた版はここへ来ない。
// 結果は元の組の順で合流する。
//
// `report` は版の結果を `VersionReport` の形で返す（`correspondence`＝導いた対応表と B3 の落ち、`testRun`、
// `routes`。v1.1α は対応の提出が無いので `defectMisses`・`redoMisses` は常に空）。静的チェックに落ちる版は
// `correspondence`・`testRun` を null にし、版の SHA-256（原文のバイト列）を持つ。
import { enumDefault, isEnumField, type NormalizedAppSpec } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import type { CorrespondenceResult, Declaration } from "../pipeline.js";
import type { VersionReport } from "../stages/repair.js";
import { runTests, type TestRunReport } from "../stages/run-tests.js";
import { runStaticCheck } from "../stages/static-check.js";
import type { DeclarationEvaluation, DeclarationEvaluator, EvaluationContext } from "../stages/tools.js";
import type { FixedTest } from "../fixed-test.js";
import { bindTestsById } from "./bind-by-id.js";
import { identityMappings, toRoleEntries } from "./convert.js";
import type { NameTable } from "./names.js";
import { checkNames, type NameCheckResult } from "./name-check.js";
import type { TestObserves } from "./stages/test-spec.js";

/** 観測する性質の写像に無い試験の、未解決の詳細（固定文。試験 ID・性質を埋めない） */
export const UNMAPPED_OBSERVES_DETAIL = "試験の観測する性質が、試験の仕様の写像に無い";

/** 既定値の試験の照合の詳細（固定文。名前・キーを埋めない。Issue #533） */
export const DEFAULT_VALUE_DETAILS = {
  /** 期待が ok の文字列でない（未解決） */
  expectedNotString: "既定値の試験の期待が、文字列のキーでない",
  /** 対象が表の項目の行（所属 entity つき）に無い（未解決） */
  targetNotInTable: "既定値の試験の対象が、名前の表の項目の行に無い",
  /** 宣言に項目が無い（不一致） */
  fieldMissing: "既定値の試験の項目が、宣言に無い",
  /** 項目が選択肢でない（不一致） */
  notEnum: "既定値の試験の項目が、宣言で選択肢（enum）でない",
  /** default が無い（不一致） */
  defaultMissing: "既定値の試験の項目に、宣言の default が無い",
  /** default が期待のキーと違う（不一致） */
  defaultDiffers: "既定値の試験の項目の宣言の default が、期待のキーと違う",
} as const;

/** 評価口を作る材料（閉包で持つもの） */
export interface V11aEvaluatorInput {
  /** 名前の表（builder に見せた全行。結び付けと B3 の場所はこの表で引く） */
  readonly table: NameTable;
  /** 持ち越しで除いた行の `id`（文脈の一覧のどの要件も所属させない行は、これに足して除く） */
  readonly excludedRowIds?: readonly string[];
  /** 観測する性質（T2 で固定した試験 ID → 性質の写像。必須。写像に無い試験は B4 で未解決に数える） */
  readonly observes: ReadonlyMap<string, TestObserves>;
}

/** v1.1α の評価口（B3・B4 と、その組み合わせ） */
export interface V11aEvaluator {
  /** B3（文脈の一覧・所属で照合する） */
  readonly nameCheck: (app: NormalizedAppSpec, context: EvaluationContext) => NameCheckResult;
  /** B4（文脈の組を、表の `id` で試験 ID ごとに結び付けて流す） */
  readonly runTests: (app: NormalizedAppSpec, context: EvaluationContext, correspondence: CorrespondenceResult) => TestRunReport;
  /** A6' の評価口（B3 → B4。⑥ の道具・版の再検査に渡す） */
  readonly evaluate: DeclarationEvaluator;
  /** 版の結果（静的チェック → 評価口）。版の SHA-256 を持つ */
  readonly report: (declaration: Declaration, context: EvaluationContext) => Promise<VersionReport>;
}

/** 評価口を作る。表と除いた行は閉包で持ち、組・一覧・所属は呼ぶたびに文脈から取る */
export function createV11aEvaluator(input: V11aEvaluatorInput): V11aEvaluator {
  const { table, observes } = input;
  const excludedRowIds = input.excludedRowIds ?? [];
  const mappings = identityMappings(table);
  const roles = toRoleEntries(table);

  const nameCheck = (app: NormalizedAppSpec, context: EvaluationContext): NameCheckResult =>
    checkNames({
      app,
      table,
      list: context.list,
      ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
      excludedRowIds,
    });

  const runTestsOf = (
    app: NormalizedAppSpec,
    context: EvaluationContext,
    correspondence: CorrespondenceResult,
  ): TestRunReport => {
    // 写像にあり既定値の試験でないものだけを v1 の `runTests` に渡す（分類はそのまま。並びは組のまま）
    const mapped = context.suite.tests.filter((test) => observes.has(test.id) && observes.get(test.id) !== "default-value");
    const suite = { ...context.suite, tests: mapped };
    const bound = bindTestsById(app, table, suite);
    const report = runTests({
      app,
      suite,
      correspondence,
      mappings,
      roles,
      bindings: { tests: bound.bindings, entityNames: bound.entityNames },
    });
    if (mapped.length === context.suite.tests.length) return report;
    return mergeReports(context.suite.tests, report, observes, (test) => judgeDefaultValue(app, table, test));
  };

  const evaluate: DeclarationEvaluator = (app, _declaration, context): DeclarationEvaluation => {
    const checked = nameCheck(app, context);
    const correspondence: CorrespondenceResult = { entries: checked.entries, misses: checked.misses };
    return { correspondence, testRun: runTestsOf(app, context, correspondence) };
  };

  const report = async (declaration: Declaration, context: EvaluationContext): Promise<VersionReport> => {
    const declarationSha256 = await sha256Hex(declaration.source);
    const staticCheck = await runStaticCheck(declaration);
    if (!staticCheck.passed || staticCheck.app === null) {
      return {
        declaration,
        declarationSha256,
        staticCheck,
        correspondence: null,
        testRun: null,
        routes: [],
        defectMisses: [],
        redoMisses: [],
      };
    }
    const evaluation = await evaluate(staticCheck.app, declaration, context);
    return {
      declaration,
      declarationSha256,
      staticCheck,
      correspondence: evaluation.correspondence,
      testRun: evaluation.testRun,
      routes: evaluation.testRun.routes,
      defectMisses: [],
      redoMisses: [],
    };
  };

  return { nameCheck, runTests: runTestsOf, evaluate, report };
}

/** 既定値の試験 1 件の判定（合格・不一致・未解決と、その詳細の固定文） */
export type DefaultValueVerdict =
  | { readonly kind: "match" }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "unresolved"; readonly detail: string };

/**
 * 既定値の試験 1 件を宣言と照合する（Issue #533。B4・B5 の道具・版の再検査は同じ関数を通る）。対象の表の行（項目）の
 * 所属 entity と項目の名前で宣言の項目を引き、選択肢の項目の `default`（`enumDefault`）が期待のキー（decode 済みの
 * 文字列）と完全一致なら合格。純粋な関数で、同じ入力からは同じ判定になる。
 */
export function judgeDefaultValue(app: NormalizedAppSpec, table: NameTable, test: FixedTest): DefaultValueVerdict {
  const expected = test.expected;
  if (expected.kind !== "ok" || typeof expected.value !== "string") {
    return { kind: "unresolved", detail: DEFAULT_VALUE_DETAILS.expectedNotString };
  }
  const row = table.rows.find((candidate) => candidate.id === test.target.roleId);
  const entityRow = row?.entity === null || row === undefined ? undefined : table.rows.find((candidate) => candidate.id === row.entity);
  if (row === undefined || row.kind !== "field" || entityRow === undefined || entityRow.kind !== "entity") {
    return { kind: "unresolved", detail: DEFAULT_VALUE_DETAILS.targetNotInTable };
  }
  const entity = app.spec.entities.find((candidate) => candidate.name === entityRow.name);
  const declared = entity !== undefined && Object.hasOwn(entity.fields, row.name) ? entity.fields[row.name] : undefined;
  if (declared === undefined) return { kind: "mismatch", detail: DEFAULT_VALUE_DETAILS.fieldMissing };
  if (!isEnumField(declared)) return { kind: "mismatch", detail: DEFAULT_VALUE_DETAILS.notEnum };
  const declaredDefault = enumDefault(declared);
  if (declaredDefault === null) return { kind: "mismatch", detail: DEFAULT_VALUE_DETAILS.defaultMissing };
  if (declaredDefault !== expected.value) return { kind: "mismatch", detail: DEFAULT_VALUE_DETAILS.defaultDiffers };
  return { kind: "match" };
}

/**
 * v1 の `runTests` の結果に、v1 に渡さなかった試験の結果を組の並びで差し込む。写像に無い試験の未解決・行き先
 * （`ambiguity`）・構造の検査の記録（構造の検査なら）は、v1 の `no-mapping` の未解決と同じ形で、詳細だけ固定文にする。
 * 既定値の試験は `judgeDefault` の判定を、v1 の不一致（行き先 `missing-element`）・未解決（`ambiguity`）と同じ形で
 * 足す。v1 に渡した試験の結果は変えない。
 */
function mergeReports(
  tests: readonly FixedTest[],
  report: TestRunReport,
  observes: ReadonlyMap<string, TestObserves>,
  judgeDefault: (test: FixedTest) => DefaultValueVerdict,
): TestRunReport {
  const mismatches: TestRunReport["mismatches"][number][] = [];
  const unresolved: TestRunReport["unresolved"][number][] = [];
  const routes: TestRunReport["routes"][number][] = [];
  const structural: TestRunReport["structural"][number][] = [];
  const at = { mismatches: 0, unresolved: 0, routes: 0, structural: 0 };
  // v1 の結果は写像にある試験の並びどおりで、1 件の試験から各欄に高々 1 件ずつ出る
  const take = <T extends { readonly testId: string }>(from: readonly T[], key: keyof typeof at, to: T[], testId: string): void => {
    const entry = from[at[key]];
    if (entry !== undefined && entry.testId === testId) {
      to.push(entry);
      at[key] += 1;
    }
  };
  for (const test of tests) {
    if (observes.get(test.id) === "default-value") {
      const verdict = judgeDefault(test);
      if (verdict.kind === "mismatch") {
        mismatches.push({ testId: test.id, detail: verdict.detail });
        routes.push({ testId: test.id, route: "missing-element", detail: verdict.detail });
      } else if (verdict.kind === "unresolved") {
        unresolved.push({ testId: test.id, detail: verdict.detail });
        routes.push({ testId: test.id, route: "ambiguity", detail: verdict.detail });
      }
      continue;
    }
    if (observes.has(test.id)) {
      take(report.mismatches, "mismatches", mismatches, test.id);
      take(report.unresolved, "unresolved", unresolved, test.id);
      take(report.routes, "routes", routes, test.id);
      take(report.structural, "structural", structural, test.id);
      continue;
    }
    unresolved.push({ testId: test.id, detail: UNMAPPED_OBSERVES_DETAIL });
    routes.push({ testId: test.id, route: "ambiguity", detail: UNMAPPED_OBSERVES_DETAIL });
    if (test.operation === "structure" && test.assertion !== undefined) {
      structural.push({
        testId: test.id,
        requirementId: test.target.requirementId,
        check: test.assertion.check,
        result: "unresolved",
        detail: UNMAPPED_OBSERVES_DETAIL,
      });
    }
  }
  return { mismatches, unresolved, routes, structural };
}
