// 構造の検査の種類の意味の表（純粋。Issue #732）。LLM を呼ばない。外部の API を呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS, STRUCTURAL_TARGET_KINDS } from "../fixed-test.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { STRUCTURAL_MEANINGS, structuralReadingText, type StructuralMeaningTable } from "./structural-meanings.js";

describe("構造の検査の種類の意味の表（1 か所。Issue #732）", () => {
  it("鍵の集合と並びが STRUCTURAL_ASSERTIONS と一致し、対象の行の種類が STRUCTURAL_TARGET_KINDS と一致する", () => {
    expect(Object.keys(STRUCTURAL_MEANINGS)).toEqual([...STRUCTURAL_ASSERTIONS]);
    for (const check of STRUCTURAL_ASSERTIONS) expect(STRUCTURAL_MEANINGS[check].targetKind, check).toBe(STRUCTURAL_TARGET_KINDS[check]);
  });

  it("意味の文は空でなく、句点を含まない 1 文の述部（「こと」で終わる）", () => {
    for (const check of STRUCTURAL_ASSERTIONS) {
      const { meaning } = STRUCTURAL_MEANINGS[check];
      expect(meaning.trim(), check).not.toBe("");
      expect(meaning.includes("。"), check).toBe(false);
      expect(meaning.endsWith("こと"), check).toBe(true);
    }
  });

  it("読み方の文は、6 種類すべての意味と対象の行の種類、targets の読み方（行ごとに 1 件）と (2)(3) の見方を含む", () => {
    const text = structuralReadingText();
    for (const check of STRUCTURAL_ASSERTIONS) {
      expect(text, check).toContain(`${check}（対象は`);
      expect(text, check).toContain(STRUCTURAL_MEANINGS[check].meaning);
    }
    expect(text).toContain("targets は種類ごとの対象の行の並びで、同じ種類を複数の行に掛けた確かめ方は行ごとに 1 件の検査である");
    expect(text).toContain("(2) と (3) は targets の行の集合に対して見る");
    expect(text).toContain("missing-target");
    expect(text).toContain("weak-verification");
    // 種類は表の鍵の順に並ぶ
    const at = STRUCTURAL_ASSERTIONS.map((check) => text.indexOf(`${check}（対象は`));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("二点測定：表の 1 文字を変えると読み方の文が変わる（表から組んでいる）", () => {
    const changed: StructuralMeaningTable = {
      ...STRUCTURAL_MEANINGS,
      "write-anonymous": { ...STRUCTURAL_MEANINGS["write-anonymous"], meaning: `${STRUCTURAL_MEANINGS["write-anonymous"].meaning}X` },
    };
    expect(structuralReadingText(changed)).not.toBe(structuralReadingText());
    expect(structuralReadingText(STRUCTURAL_MEANINGS)).toBe(structuralReadingText());
  });
});

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

describe("題材の言葉の走査（Issue #732 で足した・直したファイル）", () => {
  // cli.test.ts は題材の言葉を「無いこと」の照合の語として持つので、ソースの走査から外す（C3 の要求の走査は semantic-check.test.ts）
  it("意味の表・読み方の文・C3 の段・走らせる部分とその試験のソースに受入の題材の言葉が無い", () => {
    expectNoAcceptanceMaterial([structuralReadingText()]);
    const files = [
      "./structural-meanings.ts",
      "./structural-meanings.test.ts",
      "../v11a/stages/semantic-check.ts",
      "../v11a/stages/semantic-check.test.ts",
      "../v11a/run.ts",
      "../v11a/run.test.ts",
      "../v11a/stage-range.test.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
