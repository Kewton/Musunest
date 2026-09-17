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

/**
 * 操作を 1 回行った結果。`rejected` のとき、その入力は保存されない。
 * 受理した手順は `bind` で**書いた行の ID に名前を付ける**（M1.2。後ろの手順と期待値が `$名前` で指す）。
 */
export type StepExpectation =
  | { readonly accepted: true; readonly bind?: string }
  | {
      readonly rejected: {
        /** 型の検査で通らなかった項目（順不同）。ここが空でなければ、検査の式は評価しない */
        readonly fields: readonly string[];
        /** 通らなかった検査の名前（宣言の順） */
        readonly validations: readonly string[];
      };
    };

/**
 * 手順の入力と期待値の中で、**その時点までに登録したレコードの ID** を指す書き方（`"$A"`）。
 * 動的に割り当てられる ID を、シナリオの A・B・C と対応づけるための表現である（M1.2）。
 */
export const SCENARIO_ID_PREFIX = "$" as const;

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

/**
 * 決まったキーだけを持つことを確かめる。`$comment` は人向けの注記として許す。
 * `optional` に挙げたキーは、あっても無くてもよい（`bind` は受理した手順だけが持つ）。
 */
function expectKeys(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "オブジェクトではない");
  for (const key of Object.keys(value)) {
    if (key !== "$comment" && !keys.includes(key) && !optional.includes(key)) {
      fail(path, `知らないキー ${key}`);
    }
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
    const record = expectKeys(value, path, ["accepted"], ["bind"]);
    if (record.accepted !== true) fail(`${path}.accepted`, "true ではない");
    if (record.bind === undefined) return { accepted: true };
    return { accepted: true, bind: expectString(record.bind, `${path}.bind`, NAME_PATTERN) };
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
  checkScenarioIds(steps, views);
  return { sample, clock, steps, views };
}

// ── 動的に割り当てた ID（`bind` と `$名前`） ────────────────────────────

/** `$A` が指す名前を集める（入力と、一覧の期待値の両方から） */
function collectScenarioRefs(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith(SCENARIO_ID_PREFIX)) found.add(value.slice(SCENARIO_ID_PREFIX.length));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScenarioRefs(item, found);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectScenarioRefs(item, found);
  }
}

/**
 * `bind` の名前が重ならないことと、`$名前` がすべて `bind` された名前を指すことを確かめる。
 * **打ち間違いを黙って通さない**（存在しない ID を期待値に書いたことに気づけなくなる）。
 */
function checkScenarioIds(
  steps: readonly ScenarioStep[],
  views: Readonly<Record<string, readonly unknown[]>>,
): void {
  const bound = new Set<string>();
  steps.forEach((step, index) => {
    if ("accepted" in step.expect && step.expect.bind !== undefined) {
      if (bound.has(step.expect.bind)) {
        fail(`scenario.steps[${index}].bind`, `${step.expect.bind} が 2 回ある`);
      }
      bound.add(step.expect.bind);
    }
  });

  const used = new Set<string>();
  for (const step of steps) collectScenarioRefs(step.input, used);
  collectScenarioRefs(views, used);
  for (const name of used) {
    if (!bound.has(name)) {
      fail("scenario", `${SCENARIO_ID_PREFIX}${name} を指す手順が無い（bind された名前ではない）`);
    }
  }
}

/** `bind` した名前を、宣言の順に返す（`$名前` を実際の ID に置き換えるときに使う） */
export function scenarioIds(scenario: ScoringScenario): readonly string[] {
  const names: string[] = [];
  for (const step of scenario.steps) {
    if ("accepted" in step.expect && step.expect.bind !== undefined) names.push(step.expect.bind);
  }
  return names;
}

/**
 * 入力と期待値の中の `$名前` を、**実際に登録して得た ID** に置き換える。
 * 名前が無ければ例外にする（ID をでっち上げない。呼ぶ順は登録した順である）。
 */
export function resolveScenarioIds(
  value: unknown,
  ids: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith(SCENARIO_ID_PREFIX)) return value;
    const name = value.slice(SCENARIO_ID_PREFIX.length);
    const id = ids[name];
    if (id === undefined) fail("scenario", `${value} の ID がまだ登録されていない`);
    return id;
  }
  if (Array.isArray(value)) return value.map((item) => resolveScenarioIds(item, ids));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveScenarioIds(item, ids)]),
    );
  }
  return value;
}
