// 見本の隣に置く JSON（採点のシナリオ・負例の一覧）の形と、その読み取り。
// YAML の読み取りは spec-engine の仕事なので、ここに置く付き物は JSON にしてある（どの側からも依存なしで読める）。
// 形が合わなければ例外にする。黙って読み飛ばすと、採点しなかったことが緑に化ける。

import { ERROR_CODE_PATTERN, NAME_PATTERN } from "./spec.js";

// ── 負例の一覧（samples/negatives/index.json） ─────────────────────────

/** 1 か所だけわざと間違えた宣言。本体は samples/negatives/<name>.app.spec.yaml にある。 */
export interface NegativeSample {
  readonly name: string;
  /** 静的チェックがこの負例で出す誤りコード（草案。体系は #97 で確定する） */
  readonly codes: readonly string[];
  /** どこをどう間違えたか（人向け） */
  readonly why: string;
}

export interface NegativeIndex {
  readonly negatives: readonly NegativeSample[];
}

// ── 採点のシナリオ（samples/<name>/scenario.json） ─────────────────────

/** 操作を 1 回行った結果。`rejected` のとき、その入力は保存されない。 */
export type StepExpectation =
  | { readonly accepted: true }
  | {
      readonly rejected: {
        /** 型の検査で通らなかった項目（順不同）。ここが空でなければ、検査の式は評価しない */
        readonly fields: readonly string[];
        /** 通らなかった検査の名前（宣言の順） */
        readonly validations: readonly string[];
      };
    };

export interface ScenarioStep {
  readonly name: string;
  /** 宣言の actions にある操作の名前 */
  readonly action: string;
  /** 操作に渡す入力。わざと型の違う値も入れるので、中身は検査しない */
  readonly input: Readonly<Record<string, unknown>>;
  readonly expect: StepExpectation;
}

export interface ScoringScenario {
  /** samples/ の下の見本の名前 */
  readonly sample: string;
  /** 差し込む時計（日本時間のオフセット付き ISO 8601。00-open-questions.md Q13・Q17） */
  readonly clock: string;
  /** 先頭から順に行う操作 */
  readonly steps: readonly ScenarioStep[];
  /** すべての操作のあとの一覧。一覧の名前 → 行（登録順）。行は項目と計算値だけで比べる */
  readonly views: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
}

// ── 読み取り ─────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+09:00$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

/** 決まったキーだけを持つことを確かめる。`$comment` は人向けの注記として許す。 */
function expectKeys(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "オブジェクトではない");
  for (const key of Object.keys(value)) {
    if (key !== "$comment" && !keys.includes(key)) fail(path, `知らないキー ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(path, `キー ${key} が無い`);
  }
  return value;
}

function expectString(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "") fail(path, "空でない文字列ではない");
  if (pattern && !pattern.test(value)) fail(path, `${value} は ${pattern} の形ではない`);
  return value;
}

function expectStrings(
  value: unknown,
  path: string,
  pattern: RegExp,
  { nonEmpty }: { nonEmpty: boolean },
): string[] {
  if (!Array.isArray(value)) fail(path, "配列ではない");
  if (nonEmpty && value.length === 0) fail(path, "空の配列");
  const items = value.map((item: unknown, i) => expectString(item, `${path}[${i}]`, pattern));
  if (new Set(items).size !== items.length) fail(path, "同じ値が 2 回ある");
  return items;
}

/** samples/negatives/index.json を読む。 */
export function readNegativeIndex(value: unknown): NegativeIndex {
  const root = expectKeys(value, "index", ["negatives"]);
  if (!Array.isArray(root.negatives) || root.negatives.length === 0) {
    fail("index.negatives", "空でない配列ではない");
  }
  const names = new Set<string>();
  const negatives = root.negatives.map((entry: unknown, i): NegativeSample => {
    const path = `index.negatives[${i}]`;
    const record = expectKeys(entry, path, ["name", "codes", "why"]);
    const name = expectString(record.name, `${path}.name`, KEBAB);
    if (names.has(name)) fail(`${path}.name`, `${name} が 2 回ある`);
    names.add(name);
    return {
      name,
      codes: expectStrings(record.codes, `${path}.codes`, ERROR_CODE_PATTERN, { nonEmpty: true }),
      why: expectString(record.why, `${path}.why`),
    };
  });
  return { negatives };
}

function readExpectation(value: unknown, path: string): StepExpectation {
  if (isRecord(value) && Object.hasOwn(value, "accepted")) {
    const record = expectKeys(value, path, ["accepted"]);
    if (record.accepted !== true) fail(`${path}.accepted`, "true ではない");
    return { accepted: true };
  }
  const record = expectKeys(value, path, ["rejected"]);
  const rejected = expectKeys(record.rejected, `${path}.rejected`, ["fields", "validations"]);
  const fields = expectStrings(rejected.fields, `${path}.rejected.fields`, NAME_PATTERN, {
    nonEmpty: false,
  });
  const validations = expectStrings(
    rejected.validations,
    `${path}.rejected.validations`,
    NAME_PATTERN,
    { nonEmpty: false },
  );
  if (fields.length === 0 && validations.length === 0) {
    fail(`${path}.rejected`, "fields と validations の両方が空（何で断られるのかが無い）");
  }
  if (fields.length > 0 && validations.length > 0) {
    fail(`${path}.rejected`, "型の検査で通らないときは、検査の式を評価しない（validations は空）");
  }
  return { rejected: { fields, validations } };
}

/** samples/<name>/scenario.json を読む。 */
export function readScoringScenario(value: unknown): ScoringScenario {
  const root = expectKeys(value, "scenario", ["sample", "clock", "steps", "views"]);
  const sample = expectString(root.sample, "scenario.sample", KEBAB);
  const clock = expectString(root.clock, "scenario.clock", CLOCK);
  if (Number.isNaN(Date.parse(clock))) fail("scenario.clock", `${clock} は日時として読めない`);

  if (!Array.isArray(root.steps) || root.steps.length === 0) {
    fail("scenario.steps", "空でない配列ではない");
  }
  const steps = root.steps.map((entry: unknown, i): ScenarioStep => {
    const path = `scenario.steps[${i}]`;
    const record = expectKeys(entry, path, ["name", "action", "input", "expect"]);
    if (!isRecord(record.input)) fail(`${path}.input`, "オブジェクトではない");
    return {
      name: expectString(record.name, `${path}.name`),
      action: expectString(record.action, `${path}.action`, NAME_PATTERN),
      input: record.input,
      expect: readExpectation(record.expect, `${path}.expect`),
    };
  });

  if (!isRecord(root.views) || Object.keys(root.views).length === 0) {
    fail("scenario.views", "一覧が 1 つも無い");
  }
  const views: Record<string, Readonly<Record<string, unknown>>[]> = {};
  for (const [view, rows] of Object.entries(root.views)) {
    const path = `scenario.views.${view}`;
    expectString(view, path, NAME_PATTERN);
    if (!Array.isArray(rows)) fail(path, "配列ではない");
    views[view] = rows.map((row: unknown, i) => {
      if (!isRecord(row)) fail(`${path}[${i}]`, "オブジェクトではない");
      return row;
    });
  }
  return { sample, clock, steps, views };
}
