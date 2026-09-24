// ★正本。entities 由来の型の源泉（企画書13章 Template as Contract）
// 型と語彙の定数は spec.ts、語彙の台帳の検査は vocabulary.ts、見本の読み取りは samples.ts にある。
// data-api が公開する HTTP の契約（経路・応答・誤りコード）は api.ts にある（Issue #102）。
// 契約（contract/ の全ファイル）の SHA-256 は contract.ts にある（#213）。
// ファイルの場所（Node 側だけで使う）は "@musunest/appspec-schema/files" から取る。

export const PACKAGE_NAME = "@musunest/appspec-schema" as const;

export * from "./api.js";
export * from "./spec.js";
// 契約のハッシュは**純粋な計算だけ**を根から出す。ファイルから読む側（contractDirectory・
// contractFiles・contractHash）は Node 側だけのもので、読み込みに node:fs を使う（contract.ts の注記）
export {
  CONTRACT_DIRECTORY,
  contractDigest,
  orderContractFiles,
  type ContractFile,
} from "./contract.js";
export {
  LEDGER_FIELDS,
  LEDGER_LIST_FIELDS,
  checkVocabularyLedger,
  type LedgerProblem,
} from "./vocabulary.js";

export {
  readNegativeIndex,
  readScoringScenario,
  resolveScenarioIds,
  scenarioIds,
  SCENARIO_ID_PREFIX,
  type NegativeIndex,
  type NegativeSample,
  type ScenarioStep,
  type ScoringScenario,
  type StepExpectation,
} from "./samples.js";
