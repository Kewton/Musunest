// ★正本。entities 由来の型の源泉（企画書13章 Template as Contract）
// 型と語彙の定数は spec.ts、語彙の台帳の検査は vocabulary.ts、見本の読み取りは samples.ts にある。
// ファイルの場所（Node 側だけで使う）は "@musunest/appspec-schema/files" から取る。

export const PACKAGE_NAME = "@musunest/appspec-schema" as const;

export * from "./spec.js";
export {
  LEDGER_FIELDS,
  LEDGER_LIST_FIELDS,
  checkVocabularyLedger,
  type LedgerProblem,
} from "./vocabulary.js";

export {
  readNegativeIndex,
  readScoringScenario,
  type NegativeIndex,
  type NegativeSample,
  type ScenarioStep,
  type ScoringScenario,
  type StepExpectation,
} from "./samples.js";
