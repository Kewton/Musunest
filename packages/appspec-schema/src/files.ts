// パッケージに置いたファイル（語彙の台帳・見本・負例・採点のシナリオ・意味の文書）の場所。
// Node 側（テストと手元のコマンド）だけで使う。Worker は宣言をファイルから読まない（R2 の正規化した JSON を読む）。
// だから "@musunest/appspec-schema" の本体とは分けて "@musunest/appspec-schema/files" から出す。
//
// 使い方（spec-engine のテストなど）:
//   import { negativeSpecFile, sampleSpecFile } from "@musunest/appspec-schema/files";
//   readFileSync(sampleSpecFile("expense-log"), "utf8");

/** 台帳（パッケージの直下からの相対パス） */
export const VOCABULARY_FILE = "vocabulary.yaml";
/** M1.1 での意味の文書 */
export const SEMANTICS_FILE = "docs/semantics.md";
/** 見本のディレクトリ。見本 1 つにつき 1 ディレクトリ（app.spec.yaml と scenario.json） */
export const SAMPLES_DIR = "samples";
/** 負例のディレクトリ。samples/ の中で、この名前だけは見本ではない */
export const NEGATIVES_DIR_NAME = "negatives";
/** 見本の宣言のファイル名 */
export const SPEC_FILE_NAME = "app.spec.yaml";
/** 採点のシナリオのファイル名 */
export const SCENARIO_FILE_NAME = "scenario.json";
/** 負例の一覧のファイル名 */
export const NEGATIVE_INDEX_FILE_NAME = "index.json";
/** 負例の宣言のファイル名の末尾（<name>.app.spec.yaml） */
export const NEGATIVE_SPEC_SUFFIX = `.${SPEC_FILE_NAME}`;

/**
 * パッケージの直下からの相対パスを、file: の URL にする。node:fs の関数は URL をそのまま受け取る。
 * このファイルは src/ と dist/ のどちらから読まれても、1 つ上がパッケージの直下になる。
 */
export function packageFile(relativePath: string): URL {
  const here = (import.meta as ImportMeta & { url: string }).url;
  return new URL(`../${relativePath}`, here);
}

export const vocabularyFile = (): URL => packageFile(VOCABULARY_FILE);
export const semanticsFile = (): URL => packageFile(SEMANTICS_FILE);
export const samplesDir = (): URL => packageFile(`${SAMPLES_DIR}/`);
export const sampleSpecFile = (sample: string): URL =>
  packageFile(`${SAMPLES_DIR}/${sample}/${SPEC_FILE_NAME}`);
export const sampleScenarioFile = (sample: string): URL =>
  packageFile(`${SAMPLES_DIR}/${sample}/${SCENARIO_FILE_NAME}`);
export const negativesDir = (): URL => packageFile(`${SAMPLES_DIR}/${NEGATIVES_DIR_NAME}/`);
export const negativeIndexFile = (): URL =>
  packageFile(`${SAMPLES_DIR}/${NEGATIVES_DIR_NAME}/${NEGATIVE_INDEX_FILE_NAME}`);
export const negativeSpecFile = (negative: string): URL =>
  packageFile(`${SAMPLES_DIR}/${NEGATIVES_DIR_NAME}/${negative}${NEGATIVE_SPEC_SUFFIX}`);
