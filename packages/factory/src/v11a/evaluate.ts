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
// `report` は版の結果を `VersionReport` の形で返す（`correspondence`＝導いた対応表と B3 の落ち、`testRun`、
// `routes`。v1.1α は対応の提出が無いので `defectMisses`・`redoMisses` は常に空）。静的チェックに落ちる版は
// `correspondence`・`testRun` を null にし、版の SHA-256（原文のバイト列）を持つ。
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import type { CorrespondenceResult, Declaration } from "../pipeline.js";
import type { VersionReport } from "../stages/repair.js";
import { runTests, type TestRunReport } from "../stages/run-tests.js";
import { runStaticCheck } from "../stages/static-check.js";
import type { DeclarationEvaluation, DeclarationEvaluator, EvaluationContext } from "../stages/tools.js";
import { bindTestsById } from "./bind-by-id.js";
import { identityMappings, toRoleEntries } from "./convert.js";
import type { NameTable } from "./names.js";
import { checkNames, type NameCheckResult } from "./name-check.js";

/** 評価口を作る材料（閉包で持つもの） */
export interface V11aEvaluatorInput {
  /** 名前の表（builder に見せた全行。結び付けと B3 の場所はこの表で引く） */
  readonly table: NameTable;
  /** 持ち越しで除いた行の `id`（文脈の一覧のどの要件も所属させない行は、これに足して除く） */
  readonly excludedRowIds?: readonly string[];
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
  const { table } = input;
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
    const bound = bindTestsById(app, table, context.suite);
    return runTests({
      app,
      suite: context.suite,
      correspondence,
      mappings,
      roles,
      bindings: { tests: bound.bindings, entityNames: bound.entityNames },
    });
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
