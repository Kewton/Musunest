// 台帳の狭い YAML の読み取り。読める形は一般の YAML と同じ結果になり、読めない形は例外になることを見る。
// 読めない行を黙って捨てると、欠けた欄が「無かったこと」になって台帳の検査が空振りする。
import { describe, expect, it } from "vitest";
import { LedgerYamlError, readLedgerYaml } from "./ledger-yaml.js";

describe("readLedgerYaml", () => {
  it("行・続きの欄・並び・コメントを読む", () => {
    const rows = readLedgerYaml(
      [
        "# 見出しのコメント",
        "",
        "- name: entity   # 行末のコメント",
        "  layer: data",
        "  samples: [expense-log, warikan]",
        "  runtime: []",
        "  # 行の途中のコメント",
        "  semantics: docs/semantics.md#entity",
        "  since: v0.2（M1.1）",
        "- name: list",
        "  factory: 未対応",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        name: "entity",
        layer: "data",
        samples: ["expense-log", "warikan"],
        runtime: [],
        semantics: "docs/semantics.md#entity",
        since: "v0.2（M1.1）",
      },
      { name: "list", factory: "未対応" },
    ]);
  });

  it("CRLF の行末でも同じに読む", () => {
    expect(readLedgerYaml("- name: entity\r\n  layer: data\r\n")).toEqual([
      { name: "entity", layer: "data" },
    ]);
  });

  it("行が無ければ空の配列を返す", () => {
    expect(readLedgerYaml("# コメントだけ\n\n")).toEqual([]);
  });

  it.each([
    ["最初の行の前に続きの欄がある", "  name: entity\n", 1],
    ["タブで下げている", "- name: entity\n\tlayer: data\n", 2],
    ["4 文字下げている", "- name: entity\n    layer: data\n", 2],
    ["入れ子の書き方", "- name: entity\n  fields:\n    amount: number\n", 2],
    ["「:」の後に空白が無い", "- name:entity\n", 1],
    ["欄の名前に大文字がある", "- Name: entity\n", 1],
    ["同じ欄が 2 回ある", "- name: entity\n  name: list\n", 2],
    ["引用符", '- name: "entity"\n', 1],
    ["別名", "- name: *entity\n", 1],
    ["ブロックの文字列", "- semantics: |\n", 1],
    ["値の中の「: 」", "- semantics: a: b\n", 1],
    ["閉じていない並び", "- samples: [a, b\n", 1],
    ["並びの中の入れ子", "- samples: [a, [b]]\n", 1],
    ["並びの空の要素", "- samples: [a, , b]\n", 1],
    ["真偽に読まれる値", "- factory: true\n", 1],
    ["YAML 1.1 で真偽に読まれる値", "- factory: yes\n", 1],
    ["null に読まれる値", "- factory: ~\n", 1],
    ["数に読まれる値", "- since: 0.2\n", 1],
    ["日付に読まれる値", "- since: 2026-09-16\n", 1],
    ["並びの中の数", "- samples: [a, 1]\n", 1],
    ["文書の区切り", "---\n- name: entity\n", 1],
  ])("%s は読まずに例外にする", (_label, source, line) => {
    expect(() => readLedgerYaml(source)).toThrow(LedgerYamlError);
    try {
      readLedgerYaml(source);
    } catch (error) {
      expect((error as LedgerYamlError).line).toBe(line);
    }
  });
});
