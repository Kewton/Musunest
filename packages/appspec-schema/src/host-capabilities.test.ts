// 実行環境の能力の定義（host-capabilities.ts）の unit テスト（Issue #953）。
//
// ここで固定するのは 3 つ。
//   1. 定義の形：版がある・ID が一意・事実の文と範囲の文が空でない（純粋関数の検査で落とせる）
//   2. 能力の文が、意味の文書（契約・語彙の意味・語彙の台帳）に現れない（保証の持ち主を 1 か所に置く）
//   3. 文は事実と範囲だけで、判定への指示・題材の語を含まない（点検の門を緩める推論を書かない）
//
// **文が実装と合っているかは、ここでは判定しない。** それは実装の試験（画面の 4 例と正規化の 1 例）が
// 固定する——この定義は、その試験の名前に ID を入れて結び付ける（Issue #953 のやること 5）。
import { describe, expect, it } from "vitest";
import { CONTRACT_DIR, packageFile, semanticsFile, vocabularyFile } from "./files.js";
import { orderContractFiles } from "./contract.js";
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITIES_VERSION,
  HOST_CAPABILITY_FIRST_VIEW,
  checkHostCapabilities,
  type HostCapabilities,
} from "./host-capabilities.js";

// tsconfig の types は workers-types だけなので、node:fs の型が無い。
// このファイルは Node（vitest）で動くので、使う関数の形だけをここで宣言する（index.test.ts と同じやり方）。
interface DirEntry {
  readonly name: string;
}
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): readonly DirEntry[];
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;

/** 契約のディレクトリの全ファイルを連結する（`loadDocumentsFromFiles` と同じ順・同じ除外） */
function readContract(): string {
  const directory = packageFile(`${CONTRACT_DIR}/`);
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."));
  // 並べ方は契約の正本（`orderContractFiles`）と同じにする（名前の昇順）
  return orderContractFiles(names.map((name) => ({ path: name, content: "" })))
    .map((file) => fs.readFileSync(new URL(file.path, directory), "utf8"))
    .join("\n");
}

/** 能力の文（事実と範囲）の全部 */
const CAPABILITY_TEXTS: readonly string[] = HOST_CAPABILITIES.capabilities.flatMap((capability) => [
  ...capability.facts,
  capability.scope,
]);

/** 最初の能力（本番の定義の 1 件目） */
const FIRST = HOST_CAPABILITIES.capabilities[0];

/** 与えた能力の並びを持つ定義を作る（検査の試験用） */
function withCapabilities(capabilities: readonly NonNullable<typeof FIRST>[], version = "v1"): HostCapabilities {
  return { version, capabilities };
}

describe("実行環境の能力と申告の点検：能力の定義の形（Issue #953）", () => {
  it("版があり、ID が一意で、事実の文と範囲の文が空でない", () => {
    expect(HOST_CAPABILITIES.version).toBe(HOST_CAPABILITIES_VERSION);
    expect(HOST_CAPABILITIES.version.trim()).not.toBe("");
    expect(HOST_CAPABILITIES.capabilities).toHaveLength(1);
    expect(FIRST?.id).toBe(HOST_CAPABILITY_FIRST_VIEW);
    expect(FIRST?.facts).toHaveLength(4);
    for (const fact of FIRST?.facts ?? []) expect(fact.trim()).not.toBe("");
    expect(FIRST?.scope.trim()).not.toBe("");
    // 本番の定義は、検査で問題が出ない
    expect(checkHostCapabilities(HOST_CAPABILITIES)).toEqual([]);
  });

  it("版・ID の一意・空の文は、純粋関数の検査で落とす", () => {
    if (FIRST === undefined) throw new Error("能力の定義が空である");

    expect(checkHostCapabilities(withCapabilities([FIRST, FIRST]))).toEqual(["id-duplicated"]);
    expect(checkHostCapabilities(withCapabilities([FIRST], " "))).toEqual(["version-empty"]);
    expect(checkHostCapabilities(withCapabilities([{ ...FIRST, id: " " }]))).toEqual(["id-empty"]);
    expect(checkHostCapabilities(withCapabilities([{ ...FIRST, facts: [] }]))).toEqual(["facts-empty"]);
    expect(checkHostCapabilities(withCapabilities([{ ...FIRST, facts: ["", "事実"] }]))).toEqual(["fact-empty"]);
    expect(checkHostCapabilities(withCapabilities([{ ...FIRST, scope: " " }]))).toEqual(["scope-empty"]);
  });

  it("文は事実と範囲だけで、判定への指示・題材の語を含まない", () => {
    for (const text of CAPABILITY_TEXTS) {
      // 「だから書ける」「欄が無くても書ける」のような推論・指示を書かない
      expect(text).not.toContain("だから書ける");
      expect(text).not.toContain("書け");
      expect(text).not.toContain("判定");
      expect(text).not.toContain("答え");
      // 受入の題材の語・値・本の番号を入れない
      expect(text).not.toContain("支出");
      expect(text).not.toContain("割り勘");
    }
  });

  it("能力の文は、文書の読み込みの結果（契約・語彙の意味・語彙の台帳）に現れない", () => {
    const documents = [readContract(), fs.readFileSync(semanticsFile(), "utf8"), fs.readFileSync(vocabularyFile(), "utf8")];
    for (const text of [...CAPABILITY_TEXTS, HOST_CAPABILITY_FIRST_VIEW]) {
      for (const document of documents) expect(document).not.toContain(text);
    }
  });
});
