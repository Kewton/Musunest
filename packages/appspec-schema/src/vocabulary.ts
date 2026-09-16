// 語彙の台帳（vocabulary.yaml）の行の検査（workspace/mvp/m1/04-spec-evolution.md §6.2）。
// 台帳は、語彙が「一周」（見本 → 採点のシナリオ → 型 → 静的チェック → 意味 → 実装）を
// 置き去りにしていないかを機械で確かめるためにある。**欄が 1 つでも欠けた行は通さない。**
//
// ここで見るのは行そのものだけである。見本・負例・意味の文書が実在するかは、
// ファイルを読める側（index.test.ts）が突き合わせる。

import {
  APPSPEC_SCHEMA_VERSION,
  ERROR_CODE_PATTERN,
  LAYERS,
  isDraftSchemaVersion,
} from "./spec.js";

/** 台帳の 1 行が持つ欄。順は 04 §6.2 の案のとおり。 */
export const LEDGER_FIELDS = [
  "name",
  "layer",
  "since",
  "samples",
  "negatives",
  "check_rules",
  "semantics",
  "runtime",
  "factory",
] as const;
export type LedgerField = (typeof LEDGER_FIELDS)[number];

/** 並び（`[a, b]`）で書く欄。ほかの欄は 1 つの文字列。 */
export const LEDGER_LIST_FIELDS = ["samples", "negatives", "check_rules", "runtime"] as const;

/** 工場（CommandAgent）がまだ扱えないことを表す値。草案の間はすべての行がこれである（04 §4・§6.2）。 */
export const FACTORY_UNSUPPORTED = "未対応";

export interface LedgerProblem {
  /** 台帳の中の何行目の語彙か（1 から数える） */
  readonly row: number;
  readonly field: LedgerField | "*";
  readonly message: string;
}

const LIST_FIELDS: ReadonlySet<string> = new Set(LEDGER_LIST_FIELDS);
const KNOWN_FIELDS: ReadonlySet<string> = new Set(LEDGER_FIELDS);

const VOCABULARY_NAME = /^[a-z][A-Za-z0-9]*$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `v0.2-draft（M1.1）` の形。版と、入ったマイルストーン。 */
const SINCE = /^v\d+\.\d+(?:-draft)?（M\d+(?:\.\d+)?）$/;
/** `docs/semantics.md#entity` の形。意味の文書と、その節の見出し。 */
const SEMANTICS = /^[\w./-]+\.md#[a-z0-9-]+$/;

const ITEM_FORMAT: Readonly<Record<string, readonly [RegExp, string]>> = {
  samples: [KEBAB, "見本の名前は小文字とハイフン"],
  negatives: [KEBAB, "負例の名前は小文字とハイフン"],
  check_rules: [ERROR_CODE_PATTERN, "誤りコードの形ではない"],
  runtime: [KEBAB, "動かす場所はパッケージの名前（小文字とハイフン）"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 台帳の行を検査し、見つかった問題をすべて返す。空の配列なら通ったことになる。
 * `schemaVersion` は台帳が属する版（既定はこのパッケージの版）。草案の間は `factory` が「未対応」でなければならない。
 */
export function checkVocabularyLedger(
  rows: unknown,
  schemaVersion: string = APPSPEC_SCHEMA_VERSION,
): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  if (!Array.isArray(rows)) {
    return [{ row: 0, field: "*", message: "台帳が並び（1 行に 1 つの語彙）になっていない" }];
  }
  if (rows.length === 0) {
    return [{ row: 0, field: "*", message: "台帳に語彙が 1 つも無い" }];
  }

  const seen = new Map<string, number>();
  rows.forEach((entry: unknown, index) => {
    const row = index + 1;
    const report = (field: LedgerField | "*", message: string) =>
      problems.push({ row, field, message });

    if (!isRecord(entry)) {
      report("*", "行が「欄: 値」の組になっていない");
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_FIELDS.has(key)) report("*", `知らない欄 ${key}`);
    }

    for (const field of LEDGER_FIELDS) {
      if (!Object.hasOwn(entry, field)) {
        report(field, "欄が無い");
        continue;
      }
      const value = entry[field];
      if (LIST_FIELDS.has(field)) {
        if (!Array.isArray(value)) {
          report(field, "並び（[a, b]）で書く");
          continue;
        }
        if (value.length === 0) report(field, "並びが空");
        const [format, hint] = ITEM_FORMAT[field] ?? [KEBAB, ""];
        value.forEach((item: unknown) => {
          if (typeof item !== "string" || !format.test(item)) {
            report(field, `${JSON.stringify(item)}: ${hint}`);
          }
        });
        if (new Set(value).size !== value.length) report(field, "同じ値が 2 回ある");
        continue;
      }
      if (typeof value !== "string") {
        report(field, "文字列で書く");
      } else if (value.trim() === "") {
        report(field, "値が空");
      }
    }

    const { name, layer, since, semantics, factory } = entry;
    if (typeof name === "string" && name !== "") {
      if (!VOCABULARY_NAME.test(name)) report("name", `${name}: 英小文字で始まる英数字で書く`);
      const first = seen.get(name);
      if (first !== undefined) report("name", `${name} は ${first} 行目にもある`);
      else seen.set(name, row);
    }
    if (typeof layer === "string" && layer !== "" && !(LAYERS as readonly string[]).includes(layer)) {
      report("layer", `${layer}: 層は ${LAYERS.join(" / ")} のどれか`);
    }
    if (typeof since === "string" && since !== "" && !SINCE.test(since)) {
      report("since", `${since}: 「v0.2-draft（M1.1）」の形で書く`);
    }
    if (typeof semantics === "string" && semantics !== "" && !SEMANTICS.test(semantics)) {
      report("semantics", `${semantics}: 「docs/semantics.md#<節>」の形で書く`);
    }
    if (
      typeof factory === "string" &&
      factory.trim() !== "" &&
      isDraftSchemaVersion(schemaVersion) &&
      factory !== FACTORY_UNSUPPORTED
    ) {
      report("factory", `草案（${schemaVersion}）の間は「${FACTORY_UNSUPPORTED}」と書く`);
    }
  });
  return problems;
}
