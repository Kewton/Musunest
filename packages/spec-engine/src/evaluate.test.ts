// 評価（同じ entity の中の計算と検査）の unit テスト（Issue #98 の受入条件のうち、評価に閉じる分）。
//
// ここで固定したいのは 7 つ。
//   1. 見本 expense-log の計算値が、採点のシナリオ（正本）の期待値と一致する（時計を差し込む）
//   2. computed を参照する computed が、宣言の並びによらず依存の順に評価される
//   3. validation は宣言の順に**すべて**評価し、失敗名をその順で返す
//   4. 0 で割る・桁あふれの計算値は null で、それを使う検査は不合格（**0 に読み替えない**）
//   5. 計算値は戻り値にだけ入り、渡したレコードを書き換えない
//   6. 評価側も式の上限（文字数 200・深さ 8・ノード 64）を適用し、1 超過を成功値にしない
//   7. 日付（`date`）と「今日」（`today()`）を、差し込んだ時計で評価する（M1.3。値は時計にだけ依存する）
//
// 値の期待値は、見本の隣の採点のシナリオ（appspec-schema の正本）から読む。ここに写すと、
// 見本やシナリオを直したときに片方だけが古くなる。窓口が受入条件に書いた 4 件の数字は、
// シナリオと突き合わせたうえで、別の it にそのまま書く。
import { describe, expect, it } from "vitest";
import {
  APPSPEC_SCHEMA_VERSION,
  ARITHMETIC_OPERATORS,
  BUILTIN_FUNCTIONS,
  COMPARISON_OPERATORS,
  readScoringScenario,
  type Computed,
  type NormalizedAppSpec,
  type Validation,
} from "@musunest/appspec-schema";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import { checkSpec } from "./check.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { allowsAction, evaluateRecord, type Evaluation } from "./evaluate.js";
import { countNodes, depthOf, parseExpression, readExpression } from "./expression.js";
import { EXPRESSION_LIMITS } from "./limits.js";
import { normalizeSpec } from "./normalize.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const readText = (url: URL): string => fs.readFileSync(url, "utf8");

const sampleText = readText(sampleSpecFile("expense-log"));
const scenario = readScoringScenario(JSON.parse(readText(sampleScenarioFile("expense-log"))));

/** 宣言を検査して正規化する。**評価の入口はこの成果物だけ**である（未検査の YAML は渡せない） */
const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((d) => d.code).join(" / ")}`);
  }
  return result.app;
};

const sampleApp = await normalized(sampleText);
/** 採点のシナリオの時計（2026-09-16T12:00:00+09:00） */
const scoringClock = fixedClock(scenario.clock);

const evaluate = (
  app: NormalizedAppSpec,
  record: Readonly<Record<string, unknown>>,
  clock: Clock = scoringClock,
): Evaluation => evaluateRecord({ app, entity: "expense", record, clock });

// ── 宣言を組み立てる道具 ────────────────────────────────────────

/** 欄を書く。中身が無ければ、同じ行に `[]` と書く（YAML の読み取りの範囲。check.ts の表） */
const block = (section: string, lines: readonly string[]): string =>
  lines.length === 0 ? `${section}: []` : `${section}:\n${lines.join("\n")}`;

const validationBlock = (name: string, expression: string, entity = "expense"): string =>
  [`  - name: ${name}`, `    entity: ${entity}`, `    expression: ${expression}`].join("\n");

const computedBlock = (name: string, expression: string, entity = "expense"): string =>
  [`  - name: ${name}`, `    entity: ${entity}`, `    expression: ${expression}`, "    type: number"].join(
    "\n",
  );

const declaration = (
  options: {
    readonly computed?: readonly string[];
    readonly validations?: readonly string[];
    readonly fields?: readonly string[];
  } = {},
): string =>
  [
    block("entities", [
      "  - name: expense",
      "    fields:",
      ...(options.fields ?? ["amount: number", "discount: number", "participants: list"]).map(
        (field) => `      ${field}`,
      ),
    ]),
    block("views", []),
    block("actions", []),
    block("validations", options.validations ?? [validationBlock("positiveAmount", "amount > 0")]),
    block("computed", options.computed ?? []),
    block("permissions", []),
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");

const appOf = (source: string): Promise<NormalizedAppSpec> => normalized(source);

/**
 * 手で作った成果物。**検査を通っていない**宣言を評価へ渡す経路を測るために使う
 * （上限を超えた式・循環は checkSpec が断るので、成果物を直接組み立てるしかない）。
 */
const handBuilt = (options: {
  readonly computed?: readonly Computed[];
  readonly validations?: readonly Validation[];
}): NormalizedAppSpec => ({
  schemaVersion: APPSPEC_SCHEMA_VERSION,
  sourceSha256: "0".repeat(64),
  spec: {
    entities: [{ name: "expense", fields: { amount: "number", participants: "list" } }],
    views: [],
    actions: [],
    validations: options.validations ?? [],
    computed: options.computed ?? [],
    permissions: [],
    minIdentity: { mode: "anonymous" },
  },
});

const numberComputed = (name: string, expression: string): Computed => ({
  name,
  entity: "expense",
  expression,
  type: "number",
});

// ── 1. 見本 expense-log の計算（差し込んだ時計） ────────────────────

describe("見本 expense-log の計算（差し込んだ時計 2026-09-16T12:00:00+09:00）", () => {
  it("採点のシナリオ（正本）の期待値と一致する", () => {
    const accepted = scenario.steps.flatMap((step) =>
      "accepted" in step.expect ? [{ name: step.name, input: step.input }] : [],
    );
    const rows = scenario.views["expenseList"] ?? [];
    // 受け入れた操作の順に、一覧の行が並ぶ（登録順。docs/semantics.md「view」）
    expect(accepted).toHaveLength(rows.length);
    accepted.forEach((step, index) => {
      const row = rows[index] ?? {};
      const evaluation = evaluate(sampleApp, step.input);
      expect(evaluation.computed, step.name).toEqual({
        paidAmount: row["paidAmount"],
        headcount: row["headcount"],
        shareAmount: row["shareAmount"],
      });
      expect(evaluation.validations, step.name).toEqual([]);
    });
  });

  it.each([
    [
      "夕食（クーポン 600 円）",
      { description: "夕食", amount: 6600, discount: 600, payer: "A", participants: ["A", "B", "C"] },
      { paidAmount: 6000, headcount: 3, shareAmount: 2000 },
    ],
    [
      "タクシー",
      { description: "タクシー", amount: 3000, discount: 0, payer: "B", participants: ["A", "B", "C"] },
      { paidAmount: 3000, headcount: 3, shareAmount: 1000 },
    ],
    [
      "割引が金額を超えたコーヒー",
      { description: "コーヒー", amount: 400, discount: 500, payer: "C", participants: ["C"] },
      { paidAmount: 0, headcount: 1, shareAmount: 0 },
    ],
    [
      "内容が空の支出",
      { description: "", amount: 900, discount: 0, payer: "B", participants: ["B", "C"] },
      { paidAmount: 900, headcount: 2, shareAmount: 450 },
    ],
  ] as const)("%s は paidAmount/headcount/shareAmount をこの値にする", (_name, record, expected) => {
    const evaluation = evaluate(sampleApp, record);
    expect(evaluation.computed).toEqual(expected);
    expect(evaluation.validations).toEqual([]);
  });

  it("検査で断る入力は、失敗した検査の名前を宣言の順に返す", () => {
    const failing = scenario.steps.flatMap((step) => {
      const expected = step.expect;
      if (!("rejected" in expected)) return [];
      // 型の検査で断る入力は data-api の担当である。ここは検査の式で断る入力を評価する
      if (expected.rejected.fields.length > 0) return [];
      return [{ name: step.name, input: step.input, validations: expected.rejected.validations }];
    });
    expect(failing.length).toBeGreaterThan(0);
    for (const step of failing) {
      expect(evaluate(sampleApp, step.input).validations, step.name).toEqual(step.validations);
    }
  });

  it("型が正しい amount=0, discount=-100 は positiveAmount, nonNegativeDiscount の順で返す", () => {
    const evaluation = evaluate(sampleApp, {
      description: "返品",
      amount: 0,
      discount: -100,
      payer: "A",
      participants: ["A"],
    });
    expect(evaluation.validations).toEqual(["positiveAmount", "nonNegativeDiscount"]);
    // 検査は途中で打ち切らない。両方が出る（決定 3）。計算は、断られた入力でも式のとおりに求める
    expect(evaluation.computed).toEqual({ paidAmount: 100, headcount: 1, shareAmount: 100 });
  });

  it("計算の値は宣言の順に返る", () => {
    const evaluation = evaluate(sampleApp, {
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    });
    expect(Object.keys(evaluation.computed)).toEqual(["paidAmount", "headcount", "shareAmount"]);
  });

  it("差し込む時計を変えても、M1.1 の計算値は変わらない（Q17）", () => {
    const record = {
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    };
    const expected = evaluate(sampleApp, record).computed;
    for (const clock of [
      fixedClock(scenario.clock),
      fixedClock("2030-01-01T00:00:00+09:00"),
      fixedClock("1999-12-31T23:59:59Z"),
      systemClock(),
    ]) {
      const evaluation = evaluate(sampleApp, record, clock);
      expect(evaluation.computed, String(clock.now())).toEqual(expected);
      expect(evaluation.validations, String(clock.now())).toEqual([]);
    }
  });
});

// ── 2. 計算の依存の順（宣言の並びに依らない） ────────────────────

describe("computed を参照する computed の依存の順", () => {
  it("shareAmount を先に宣言しても、依存の順に評価して同じ値になる", async () => {
    const app = await appOf(
      declaration({
        computed: [
          computedBlock("shareAmount", "paidAmount / max(1, headcount)"),
          computedBlock("headcount", "len(participants)"),
          computedBlock("paidAmount", "amount - min(discount, amount)"),
        ],
      }),
    );
    const evaluation = evaluate(app, { amount: 6600, discount: 600, participants: ["A", "B", "C"] });
    expect(evaluation.computed).toEqual({ shareAmount: 2000, headcount: 3, paidAmount: 6000 });
    // 値は依存の順に求めるが、返す並びは宣言の順である
    expect(Object.keys(evaluation.computed)).toEqual(["shareAmount", "headcount", "paidAmount"]);
  });

  it("3 段の依存でも、宣言と逆向きの順に値を求める", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [
          computedBlock("top", "middle / 2"),
          computedBlock("middle", "base + 1"),
          computedBlock("base", "amount * 2"),
        ],
      }),
    );
    expect(evaluate(app, { amount: 5 }).computed).toEqual({ top: 5.5, middle: 11, base: 10 });
  });

  it("宣言の並びを変えても、値は同じである", async () => {
    const forward = await appOf(
      declaration({
        computed: [
          computedBlock("base", "amount * 2"),
          computedBlock("middle", "base + 1"),
          computedBlock("top", "middle / 2"),
        ],
      }),
    );
    const backward = await appOf(
      declaration({
        computed: [
          computedBlock("top", "middle / 2"),
          computedBlock("middle", "base + 1"),
          computedBlock("base", "amount * 2"),
        ],
      }),
    );
    const record = { amount: 5 };
    expect(evaluate(forward, record).computed).toEqual(evaluate(backward, record).computed);
  });

  it("循環を手で作った成果物で渡されても止まらない（null になる）", () => {
    const app = handBuilt({
      computed: [numberComputed("first", "second + 1"), numberComputed("second", "first + 1")],
    });
    expect(evaluate(app, { amount: 1 })).toEqual({
      computed: { first: null, second: null },
      validations: [],
    });
  });

  it("宣言に無い名前を参照していても止まらない（null になる）", () => {
    const app = handBuilt({ computed: [numberComputed("missing", "unknownName + 1")] });
    expect(evaluate(app, { amount: 1 }).computed).toEqual({ missing: null });
  });
});

// ── 3. 0 で割る・桁あふれ（null。0 に読み替えない） ──────────────

describe("有限の数でなくなった計算", () => {
  it("1 / 0 の計算は null になり、それを使う検査は不合格になる", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [computedBlock("ratio", "amount / (amount - amount)")],
        validations: [validationBlock("ratioPositive", "ratio > 0")],
      }),
    );
    expect(evaluate(app, { amount: 100 })).toEqual({
      computed: { ratio: null },
      validations: ["ratioPositive"],
    });
  });

  it("桁あふれ（有限の数でなくなった値）も null になる", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [computedBlock("huge", "amount * amount")],
      }),
    );
    // 有限の数の入力でも、掛けた結果が有限でなくなることがある
    expect(evaluate(app, { amount: 1e308 }).computed).toEqual({ huge: null });
    expect(evaluate(app, { amount: 2 }).computed).toEqual({ huge: 4 });
  });

  it("符号や関数の途中で有限でなくなっても null になる", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [
          computedBlock("negated", "-amount"),
          computedBlock("computedMin", "min(amount, -amount)"),
          computedBlock("computedMax", "max(amount, -amount)"),
        ],
      }),
    );
    expect(evaluate(app, { amount: Number.POSITIVE_INFINITY }).computed).toEqual({
      negated: null,
      computedMin: null,
      computedMax: null,
    });
    expect(evaluate(app, { amount: 3 }).computed).toEqual({ negated: -3, computedMin: -3, computedMax: 3 });
  });

  it("max(1, headcount) は数値を返す（0 で割らないための守り）", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number", "participants: list"],
        computed: [
          computedBlock("headcount", "len(participants)"),
          computedBlock("guard", "max(1, headcount)"),
          computedBlock("shareAmount", "amount / max(1, headcount)"),
        ],
      }),
    );
    // 割る人が空でも 0 で割らない（list は空を許さないので M1.1 では起こらないが、守りは効く）
    expect(evaluate(app, { amount: 900, participants: [] }).computed).toEqual({
      headcount: 0,
      guard: 1,
      shareAmount: 900,
    });
    expect(evaluate(app, { amount: 900, participants: ["A", "B"] }).computed).toEqual({
      headcount: 2,
      guard: 2,
      shareAmount: 450,
    });
  });

  it("不正な計算値を 0 に読み替えない（0 なら通る検査が、不合格のままである）", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [computedBlock("ratio", "amount / (amount - amount)")],
        validations: [validationBlock("ratioIsZero", "ratio == 0")],
      }),
    );
    // null を 0 に読み替えていれば `ratio == 0` が真になり、この検査は通ってしまう
    expect(evaluate(app, { amount: 100 }).validations).toEqual(["ratioIsZero"]);
  });

  it("計算の値が有限でなければ、値の比較は真にならない", async () => {
    const app = await appOf(
      declaration({
        fields: ["amount: number"],
        computed: [computedBlock("ratio", "amount / (amount - amount)")],
        validations: [validationBlock("ratioNotZero", "ratio != 0")],
      }),
    );
    expect(evaluate(app, { amount: 100 }).validations).toEqual(["ratioNotZero"]);
  });
});

// ── 4. レコードを書き換えない ──────────────────────────────────

/** 入れ子も凍らせる。書き込めば（ESM は strict mode なので）例外になる */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

describe("計算値は戻り値にだけ入る", () => {
  it("渡したレコードを書き換えない", () => {
    const record = deepFreeze({
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    });
    const snapshot = JSON.stringify(record);
    const evaluation = evaluate(sampleApp, record);
    expect(evaluation.computed).toEqual({ paidAmount: 6000, headcount: 3, shareAmount: 2000 });
    expect(JSON.stringify(record)).toBe(snapshot);
    // 計算の名前が、レコードの側に現れない
    for (const name of Object.keys(evaluation.computed)) {
      expect(Object.hasOwn(record, name), name).toBe(false);
    }
    expect(Object.keys(record)).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
    ]);
  });

  it("同じレコードを 2 回評価しても、同じ値になる（1 回目が 2 回目に効かない）", () => {
    const record = { amount: 6600, discount: 600, participants: ["A", "B", "C"] };
    const first = evaluate(sampleApp, record);
    const second = evaluate(sampleApp, record);
    expect(second).toEqual(first);
  });

  it("計算の値の入れ物は、呼ぶたびに別である", () => {
    const record = { amount: 100, discount: 0, participants: ["A"] };
    const first = evaluate(sampleApp, record);
    const second = evaluate(sampleApp, record);
    expect(first.computed).not.toBe(second.computed);
  });
});

// ── 5. 式の上限（評価側も同じ定数を使う） ────────────────────────

/** 式を、指定した文字数まで空白で埋める（空白は字句の区切りなので、値は変わらない） */
const padded = (expression: string, length: number): string =>
  `${expression}${" ".repeat(Math.max(0, length - expression.length))}`;

/** `depth` 段の入れ子の関数呼び出し（外側の呼び出しを 1 段と数える）。値は数 */
const nested = (depth: number): string => {
  let text = "1";
  for (let index = 1; index < depth; index += 1) text = `min(${text}, 1)`;
  return text;
};

/** `depth` 段で、値が真偽になる式（検査に使う）。最後に比べるので、途中は数のままである */
const nestedComparison = (depth: number): string => {
  let text = "amount";
  for (let index = 1; index < depth - 1; index += 1) text = `min(${text}, 1)`;
  return `${text} > 0`;
};

/** 葉が `leaves` 枚の釣り合った木。深さは log2(leaves) + 1、ノードは 2 * leaves - 1 */
const balanced = (leaves: number): string =>
  leaves === 1 ? "1" : `(${balanced(leaves / 2)}+${balanced(leaves / 2)})`;

const shapes = (expression: string): { readonly nodes: number; readonly depth: number } => {
  const parsed = parseExpression(expression);
  if (!parsed.ok) throw new Error(`${expression}: 解析できない`);
  return { nodes: countNodes(parsed.ast), depth: depthOf(parsed.ast) };
};

describe("式の上限（文字数 200・深さ 8・ノード 64）", () => {
  it("上限の値は、静的チェックと評価で同じ定数である（定義が 1 か所）", () => {
    expect(EXPRESSION_LIMITS).toEqual({ maxLength: 200, maxDepth: 8, maxNodes: 64 });
    // 読み取りの入口が、ちょうどの内側と 1 超過を分けている
    expect(readExpression(padded("1 + 1", EXPRESSION_LIMITS.maxLength)).ok).toBe(true);
    expect(readExpression(padded("1 + 1", EXPRESSION_LIMITS.maxLength + 1)).ok).toBe(false);
  });

  /** 検査を通っていない成果物（手で作ったもの）から、1 つの計算の値を求める */
  const handBuiltValue = (expression: string, record: Readonly<Record<string, unknown>> = { amount: 1 }) =>
    evaluate(handBuilt({ computed: [numberComputed("value", expression)] }), record).computed["value"];

  /** 検査を通った宣言から、1 つの計算の値を求める（検査が受け取る側の実測） */
  const checkedValue = async (expression: string): Promise<unknown> => {
    const app = await appOf(declaration({ computed: [computedBlock("value", expression)] }));
    return evaluate(app, { amount: 1 }).computed["value"];
  };

  /** 検査を通っていない成果物から、1 つの検査の失敗名を求める */
  const handBuiltFailures = (expression: string): readonly string[] =>
    evaluate(handBuilt({ validations: [{ name: "check", entity: "expense", expression }] }), {
      amount: 1,
    }).validations;

  it.each<{ label: string; length: number; value: number | null }>([
    { label: "1 つ手前", length: EXPRESSION_LIMITS.maxLength - 1, value: 2 },
    { label: "ちょうど", length: EXPRESSION_LIMITS.maxLength, value: 2 },
    { label: "1 超過", length: EXPRESSION_LIMITS.maxLength + 1, value: null },
  ])("文字数が $label の式の計算値は $value である", ({ length, value }) => {
    const expression = padded("1 + 1", length);
    expect(expression).toHaveLength(length);
    expect(handBuiltValue(expression)).toBe(value);
  });

  it("文字数の上限を超えた式は、静的チェックも断る（ちょうどと 1 超過を作る）", () => {
    // YAML の値は読み取りで前後の空白が落ちる（check.ts）。長さは名前で作る（check.test.ts と同じやり方）
    const longName = `a${"b".repeat(EXPRESSION_LIMITS.maxLength - 5)}`;
    const fields = ["amount: number", `${longName}: number`];
    const exactly = `${longName} + 1`;
    expect(exactly).toHaveLength(EXPRESSION_LIMITS.maxLength);
    const allowed = checkSpec(declaration({ fields, computed: [computedBlock("value", exactly)] }));
    expect(allowed.ok, "ちょうど 200 文字は通る").toBe(true);
    const over = checkSpec(declaration({ fields, computed: [computedBlock("value", `${longName}b + 1`)] }));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(new Set(over.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(["LOGIC_EXPRESSION_TOO_LONG"]),
    );
  });

  it.each<{ label: string; length: number; failed: readonly string[] }>([
    { label: "1 つ手前", length: EXPRESSION_LIMITS.maxLength - 1, failed: [] },
    { label: "ちょうど", length: EXPRESSION_LIMITS.maxLength, failed: [] },
    { label: "1 超過", length: EXPRESSION_LIMITS.maxLength + 1, failed: ["check"] },
  ])("文字数が $label の検査の式の失敗名は $failed である", ({ length, failed }) => {
    const expression = padded("amount > 0", length);
    expect(expression).toHaveLength(length);
    expect(handBuiltFailures(expression)).toEqual(failed);
  });

  it.each([
    { label: "1 つ手前", depth: EXPRESSION_LIMITS.maxDepth - 1 },
    { label: "ちょうど", depth: EXPRESSION_LIMITS.maxDepth },
  ])("深さが $label の式は、検査を通り、計算では数になる", async ({ depth }) => {
    const expression = nested(depth);
    expect(shapes(expression).depth).toBe(depth);
    expect(await checkedValue(expression)).toBe(1);
  });

  it("深さが 1 超過の式は、検査も評価も成功値にしない", () => {
    const expression = nested(EXPRESSION_LIMITS.maxDepth + 1);
    expect(shapes(expression).depth).toBe(EXPRESSION_LIMITS.maxDepth + 1);
    expect(checkSpec(declaration({ computed: [computedBlock("value", expression)] })).ok).toBe(false);
    expect(handBuiltValue(expression)).toBeNull();
  });

  it.each<{ label: string; depth: number; failed: readonly string[] }>([
    { label: "1 つ手前", depth: EXPRESSION_LIMITS.maxDepth - 1, failed: [] },
    { label: "ちょうど", depth: EXPRESSION_LIMITS.maxDepth, failed: [] },
    { label: "1 超過", depth: EXPRESSION_LIMITS.maxDepth + 1, failed: ["check"] },
  ])("深さが $label の検査の式の失敗名は $failed である", ({ depth, failed }) => {
    const expression = nestedComparison(depth);
    expect(shapes(expression).depth).toBe(depth);
    expect(handBuiltFailures(expression)).toEqual(failed);
  });

  it.each([
    { label: "1 つ手前（63）", expression: balanced(32), nodes: 63, depth: 6, expected: 32 },
    { label: "ちょうど（64）", expression: `-(${balanced(32)})`, nodes: 64, depth: 7, expected: -32 },
  ])("ノード数が $label の式は、検査を通り、計算では $expected になる", async ({
    expression,
    nodes,
    depth,
    expected,
  }) => {
    expect(shapes(expression)).toEqual({ nodes, depth });
    expect(await checkedValue(expression)).toBe(expected);
  });

  it("ノード数が 1 超過の式は、検査も評価も成功値にしない", () => {
    const expression = `1 + (${balanced(32)})`;
    expect(shapes(expression).nodes).toBe(EXPRESSION_LIMITS.maxNodes + 1);
    expect(checkSpec(declaration({ computed: [computedBlock("value", expression)] })).ok).toBe(false);
    expect(handBuiltValue(expression)).toBeNull();
  });

  it("上限の内側の検査の式は、検査を通り、評価で不合格にならない", async () => {
    const expressions = [
      padded("amount > 0", EXPRESSION_LIMITS.maxLength),
      nestedComparison(EXPRESSION_LIMITS.maxDepth),
    ];
    for (const expression of expressions) {
      const app = await appOf(declaration({ validations: [validationBlock("check", expression)] }));
      expect(evaluate(app, { amount: 1 }).validations, expression).toEqual([]);
    }
  });

  it("検査を通っていない成果物でも、上限を超えた式を成功値にしない", () => {
    const tooLong = padded("1 + 1", EXPRESSION_LIMITS.maxLength + 1);
    const tooDeep = nested(EXPRESSION_LIMITS.maxDepth + 1);
    const tooMany = `1 + (${balanced(32)})`;
    const app = handBuilt({
      computed: [
        numberComputed("tooLong", tooLong),
        numberComputed("tooDeep", tooDeep),
        numberComputed("tooMany", tooMany),
      ],
      validations: [
        {
          name: "longHolds",
          entity: "expense",
          expression: padded("amount > 0", EXPRESSION_LIMITS.maxLength + 1),
        },
        {
          name: "deepHolds",
          entity: "expense",
          expression: nestedComparison(EXPRESSION_LIMITS.maxDepth + 1),
        },
      ],
    });
    expect(evaluate(app, { amount: 1 })).toEqual({
      computed: { tooLong: null, tooDeep: null, tooMany: null },
      validations: ["longHolds", "deepHolds"],
    });
  });
});

// ── 6. 語彙（演算子・関数）の網羅 ────────────────────────────────

describe("式に書けるもの（正本の一覧をすべて評価する）", () => {
  const ARITHMETIC_RESULTS: Readonly<Record<string, number>> = { "+": 16, "-": 8, "*": 48, "/": 3 };

  it.each(ARITHMETIC_OPERATORS)("数どうしの計算 %s を評価する", async (operator) => {
    const app = await appOf(
      declaration({ computed: [computedBlock("value", `12 ${operator} 4`)] }),
    );
    expect(evaluate(app, { amount: 1 }).computed).toEqual({ value: ARITHMETIC_RESULTS[operator] });
  });

  it.each(COMPARISON_OPERATORS)("数どうしの比較 %s を評価する", async (operator) => {
    const holds = [">", ">=", "!="].includes(operator); // 4 と 2 を比べる
    const app = await appOf(
      declaration({ validations: [validationBlock("check", `4 ${operator} 2`)] }),
    );
    expect(evaluate(app, { amount: 1 }).validations).toEqual(holds ? [] : ["check"]);
  });

  it.each(Object.keys(BUILTIN_FUNCTIONS))("店頭が用意した関数 %s を評価する", async (name) => {
    const expected: Readonly<Record<string, number>> = { min: 2, max: 4, len: 3 };
    const expression = name === "len" ? "len(participants)" : `${name}(4, 2)`;
    const app = await appOf(
      declaration({
        fields: ["amount: number", "participants: list"],
        computed: [computedBlock("value", expression)],
      }),
    );
    expect(evaluate(app, { amount: 1, participants: ["A", "B", "C"] }).computed).toEqual({
      value: expected[name],
    });
  });

  it("用意されていない関数・`.` を使った参照は値にしない（検査が断るもの）", () => {
    const app = handBuilt({
      computed: [
        numberComputed("unknownFunction", "round(1)"),
        numberComputed("member", "budget.limit"),
      ],
    });
    expect(evaluate(app, { amount: 1 }).computed).toEqual({
      unknownFunction: null,
      member: null,
    });
  });

  it("項目に無い名前は null になる（型検査は data-api の担当である）", () => {
    expect(evaluate(sampleApp, { amount: "3000", discount: 0, participants: ["A"] }).computed).toEqual({
      paidAmount: null,
      headcount: 1,
      shareAmount: null,
    });
    expect(evaluate(sampleApp, { discount: 0, participants: ["A"] }).computed).toEqual({
      paidAmount: null,
      headcount: 1,
      shareAmount: null,
    });
  });
});

// ── 7. 日付（date）と「今日」（today()）（M1.3。Issue #155） ──────────
//
// 採点は**時計を差し込んで**行う（Q17）。値が時計に依存するのは `today()` だけである。
// **評価のどこにも `Date.now()` の直接の呼び出しが無い**ことを、走査でも確かめる（受入条件）。

/** 日付の項目を使う検査の式を 1 つ持つ宣言（entity は土台の expense） */
const dueDeclaration = (expression: string): string =>
  declaration({
    fields: ["amount: number", "due: date"],
    validations: [validationBlock("dueBeforeToday", expression)],
  });

describe("日付（date）と「今日」（today()）（M1.3）", () => {
  /** 採点のシナリオと同じ、日本時間の 12:00（2026-09-16）に固定した時計 */
  const clock = fixedClock("2026-09-16T12:00:00+09:00");

  const failuresOf = async (
    expression: string,
    record: Readonly<Record<string, unknown>>,
    at: Clock = clock,
  ): Promise<readonly string[]> => {
    const app = await appOf(dueDeclaration(expression));
    return evaluateRecord({ app, entity: "expense", record, clock: at }).validations;
  };

  it("due < today() を評価する（昨日は真・今日は偽・明日は偽・未入力は偽。受入条件）", async () => {
    expect(await failuresOf("due < today()", { amount: 1, due: "2026-09-15" }), "昨日は真").toEqual([]);
    expect(await failuresOf("due < today()", { amount: 1, due: "2026-09-16" }), "今日は偽").toEqual([
      "dueBeforeToday",
    ]);
    expect(await failuresOf("due < today()", { amount: 1, due: "2026-09-17" }), "明日は偽").toEqual([
      "dueBeforeToday",
    ]);
    // 未入力は真偽にならない（`null`）ので通らない。**0 にも空の並びにも読み替えない**
    expect(await failuresOf("due < today()", { amount: 1 }), "未入力は偽").toEqual(["dueBeforeToday"]);
    expect(await failuresOf("due < today()", { amount: 1, due: "" }), "空文字は偽").toEqual([
      "dueBeforeToday",
    ]);
  });

  it("時計を差し替えると、同じレコードでも結果が変わる（時計が効いていることの確認）", async () => {
    const record = { amount: 1, due: "2026-09-16" };
    expect(await failuresOf("due < today()", record, clock)).toEqual(["dueBeforeToday"]);
    expect(await failuresOf("due < today()", record, fixedClock("2026-09-17T12:00:00+09:00"))).toEqual([]);
  });

  it("「今日」は日本時間で数える（UTC ではまだ前日である瞬間でも、日本時間では当日）", async () => {
    // 日本時間の 2026-09-16 08:59（UTC では 2026-09-15 23:59）と、
    // 日本時間の 2026-09-16 09:00（UTC の日付が変わった直後）
    for (const at of [fixedClock("2026-09-15T23:59:00Z"), fixedClock("2026-09-16T00:00:00Z")]) {
      expect(
        await failuresOf("due == today()", { amount: 1, due: "2026-09-16" }, at),
        String(at.now()),
      ).toEqual([]);
    }
  });

  it.each([
    ["<", "2026-09-15", true],
    ["<", "2026-09-16", false],
    ["<=", "2026-09-16", true],
    [">", "2026-09-17", true],
    [">", "2026-09-16", false],
    [">=", "2026-09-16", true],
    ["==", "2026-09-16", true],
    ["!=", "2026-09-17", true],
  ] as const)("due %s today() は due が %s のとき %s である", async (operator, due, holds) => {
    const validations = await failuresOf(`due ${operator} today()`, { amount: 1, due });
    expect(validations).toEqual(holds ? [] : ["dueBeforeToday"]);
  });

  it("日付と数の比較は、評価でも真偽にしない（静的チェックが断る式を手で渡した場合）", () => {
    // 検査を通っていない成果物（手で作ったもの）を渡す経路。日付と数は型が食い違うので、
    // 評価も真偽を返さない（`null` にして、検査は通らないものとして扱う）
    const app: NormalizedAppSpec = {
      schemaVersion: APPSPEC_SCHEMA_VERSION,
      sourceSha256: "0".repeat(64),
      spec: {
        entities: [{ name: "expense", fields: { due: "date" } }],
        views: [],
        actions: [],
        validations: [
          { name: "dateAndNumber", entity: "expense", expression: "due < 1" },
          { name: "dateAndDate", entity: "expense", expression: "due < today()" },
        ],
        computed: [],
        permissions: [],
        minIdentity: { mode: "anonymous" },
      },
    };
    const validations = evaluateRecord({
      app,
      entity: "expense",
      record: { due: "2026-09-15" },
      clock,
    }).validations;
    // 日付どうしの比較だけが通り、日付と数の比較は通らない
    expect(validations).toEqual(["dateAndNumber"]);
  });

  it("評価のどこにも Date.now() の直接の呼び出しが無い（受入条件）", () => {
    // 現在時刻を読むのは、時計の境界（clock.ts）だけである
    for (const file of ["evaluate.ts", "expression.ts"]) {
      const source = readText(new URL(`./${file}`, import.meta.url));
      expect(source.includes("Date.now"), `${file} に Date.now がある`).toBe(false);
    }
    expect(readText(new URL("./clock.ts", import.meta.url))).toContain("Date.now()");
  });
});

// ── 操作の条件（when）と文字列の比較（M1.3。Issue #156） ─────────────────
//
// **`when` はロジック層の守りである**（`03-spec-layers-and-checker.md` §2.2）。ここが返す真偽で
// data-api が操作を断る。**真になったときだけ通す**——偽と「値が求まらない」を区別しない
// （検査の式と同じ扱いである）。

const WHEN_SOURCE = [
  "entities:",
  "  - name: task",
  "    fields:",
  "      title: string",
  "      status:",
  "        type: enum",
  "        options:",
  "          todo: 未着手",
  "          doing: 進行中",
  "          done: 完了",
  "        default: todo",
  "views:",
  "  - name: taskList",
  "    entity: task",
  "actions:",
  "  - name: addTask",
  "    entity: task",
  "  - name: start",
  "    entity: task",
  "    kind: update",
  "    set:",
  "      status: doing",
  '    when: status == "todo"',
  "  - name: finish",
  "    entity: task",
  "    kind: update",
  "    set:",
  "      status: done",
  '    when: status != "done"',
  "validations: []",
  "computed: []",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
].join("\n");

describe("操作の条件（when）の評価（M1.3）", () => {
  const whenClock = fixedClock("2026-09-16T12:00:00+09:00");

  const allows = async (actionName: string, record: Readonly<Record<string, unknown>>) => {
    const app = await normalized(WHEN_SOURCE);
    const action = app.spec.actions.find((candidate) => candidate.name === actionName);
    if (action?.when === undefined) throw new Error(`${actionName} に when が無い`);
    return allowsAction({ app, entity: "task", record, clock: whenClock }, action.when);
  };

  it.each([
    ["todo", true, true],
    ["doing", false, true],
    ["done", false, false],
  ] as const)("status が %s のとき、start は %s・finish は %s である", async (status, start, finish) => {
    expect(await allows("start", { title: "宿の予約", status })).toBe(start);
    expect(await allows("finish", { title: "宿の予約", status })).toBe(finish);
  });

  it("値が求まらない行は、どの操作も通さない（偽と同じ扱いにする）", async () => {
    // 項目そのものが無い・型が違う値は `null` になり、比較は真偽にならない
    expect(await allows("start", { title: "宿の予約" })).toBe(false);
    expect(await allows("start", { title: "宿の予約", status: 1 })).toBe(false);
    expect(await allows("finish", { title: "宿の予約", status: null })).toBe(false);
  });

  it("宣言に無い entity は通さない（成功に読み替えない）", async () => {
    const app = await normalized(WHEN_SOURCE);
    expect(allowsAction({ app, entity: "member", record: {}, clock: whenClock }, "1 == 1")).toBe(false);
  });

  it("読めない式は通さない（上限を超えた式も同じ）", async () => {
    const app = await normalized(WHEN_SOURCE);
    const request = { app, entity: "task", record: { title: "t", status: "todo" }, clock: whenClock };
    expect(allowsAction(request, 'status == "todo')).toBe(false);
    expect(allowsAction(request, `1 == ${"(".repeat(EXPRESSION_LIMITS.maxLength)}1`)).toBe(false);
    // 真になる式だけが通る
    expect(allowsAction(request, 'status == "todo"')).toBe(true);
  });

  it("文字列の定数は、項目の値とそのまま比べる（`enum` のキー・`ref` の ID・`string`）", async () => {
    const app = await normalized(WHEN_SOURCE);
    const of = (record: Readonly<Record<string, unknown>>, when: string): boolean =>
      allowsAction({ app, entity: "task", record, clock: whenClock }, when);
    expect(of({ title: "宿の予約", status: "todo" }, 'title == "宿の予約"')).toBe(true);
    expect(of({ title: "宿の予約", status: "todo" }, 'title != "宿の予約"')).toBe(false);
    // 空の文字列も 1 つの値である（0 にも「無い」にも読み替えない）
    expect(of({ title: "", status: "todo" }, 'title == ""')).toBe(true);
  });

  it("検査の式でも文字列の比較が効く（同じ環境で解く）", async () => {
    const source = WHEN_SOURCE.replace(
      "validations: []",
      ["validations:", "  - name: notDone", "    entity: task", '    expression: status != "done"'].join("\n"),
    );
    const app = await normalized(source);
    const evaluateTask = (record: Readonly<Record<string, unknown>>) =>
      evaluateRecord({ app, entity: "task", record, clock: whenClock }).validations;
    expect(evaluateTask({ title: "t", status: "doing" })).toEqual([]);
    expect(evaluateTask({ title: "t", status: "done" })).toEqual(["notDone"]);
  });
});
