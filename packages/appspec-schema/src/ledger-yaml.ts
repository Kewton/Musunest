// 語彙の台帳（vocabulary.yaml）を、このパッケージのテストで読むための**狭い** YAML の読み取り。
//
// なぜ YAML のライブラリを使わないか：appspec-schema は依存を持たない（infra/scripts/dep-graph.mjs）。
// ライブラリを足すと pnpm-lock.yaml が変わり、この Issue の範囲を越える。YAML を読む本番の仕組みは
// spec-engine が持つ（宣言の変換。00-open-questions.md Q12）。
//
// だから台帳の書き方を、次の形だけに絞る。**この形から外れた行は読み飛ばさず、例外にする。**
// 読めない行を黙って捨てると、欠けた欄が「無かったこと」になり、台帳の検査が空振りする。
//
//   # コメントの行
//   - name: entity            ← 行の始まり。「- 」の直後に「欄: 値」
//     layer: data             ← 続きの欄は 2 文字下げる
//     samples: [expense-log]  ← 並びは 1 行の [a, b]
//
// 値はすべて文字列として読む。YAML が文字列以外に読む値（true・null・数・日付など）は、
// ほかの YAML の読み取りと結果が食い違うので、書けないことにする。
// この形の範囲では、一般の YAML の読み取り（YAML 1.2）と同じ結果になる。

export type LedgerYamlValue = string | readonly string[];
export type LedgerYamlRow = Readonly<Record<string, LedgerYamlValue>>;

export class LedgerYamlError extends Error {
  constructor(
    readonly line: number,
    reason: string,
  ) {
    super(`vocabulary.yaml ${line} 行目: ${reason}`);
    this.name = "LedgerYamlError";
  }
}

const KEY_VALUE = /^([a-z][a-z_]*): (.*)$/;
/** 値の先頭に置くと YAML の別の書き方になる文字（YAML 1.2 の indicator） */
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** YAML が文字列以外に読む値（YAML 1.2 core schema と、YAML 1.1 の真偽・日付） */
const NON_STRING = [
  /^(?:true|false|yes|no|on|off|y|n|null|~)$/i,
  /^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?$/,
  /^[-+]?\.(?:inf|nan)$/i,
  /^0[xo][0-9a-fA-F]+$/,
  /^\d{4}-\d{1,2}-\d{1,2}/,
];

function stripComment(text: string): string {
  // YAML では、空白の直後の # からがコメントになる（`docs/semantics.md#entity` の # はコメントではない）
  const at = text.search(/\s#/);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}

function plainScalar(text: string, line: number, inFlow: boolean): string {
  if (text === "") throw new LedgerYamlError(line, "値が空（入れ子の書き方は読めない）");
  if (INDICATOR_START.test(text)) {
    throw new LedgerYamlError(line, `${text}: 引用符・入れ子・別名などの書き方は読めない`);
  }
  if (text.includes(": ") || text.endsWith(":")) {
    throw new LedgerYamlError(line, `${text}: 値の中に「: 」を書けない`);
  }
  if (inFlow && /[[\]{},]/.test(text)) {
    throw new LedgerYamlError(line, `${text}: 並びの要素に [ ] { } , を書けない`);
  }
  if (NON_STRING.some((pattern) => pattern.test(text))) {
    throw new LedgerYamlError(line, `${text}: YAML が文字列以外に読む値は書けない`);
  }
  return text;
}

function value(text: string, line: number): LedgerYamlValue {
  if (!text.startsWith("[")) return plainScalar(text, line, false);
  if (!text.endsWith("]")) throw new LedgerYamlError(line, "並びは 1 行の [a, b] で書く");
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => plainScalar(item.trim(), line, true));
}

/** 台帳の本文を読み、行（語彙）の配列を返す。読めない形があれば LedgerYamlError を投げる。 */
export function readLedgerYaml(text: string): LedgerYamlRow[] {
  const rows: Record<string, LedgerYamlValue>[] = [];
  let current: Record<string, LedgerYamlValue> | undefined;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (/^\s*(?:#.*)?$/.test(raw)) return;

    let body: string;
    if (raw.startsWith("- ")) {
      current = {};
      rows.push(current);
      body = raw.slice(2);
    } else if (raw.startsWith("  ") && current) {
      body = raw.slice(2);
    } else {
      throw new LedgerYamlError(line, "行は「- 欄: 値」か、2 文字下げた「欄: 値」で書く");
    }

    const match = KEY_VALUE.exec(body);
    if (!match) throw new LedgerYamlError(line, "「欄: 値」の形ではない（欄は英小文字と _）");
    const [, key = "", rest = ""] = match;
    if (Object.hasOwn(current, key)) throw new LedgerYamlError(line, `欄 ${key} が 2 回ある`);
    current[key] = value(stripComment(rest).trim(), line);
  });
  return rows;
}
