// 固定する試験の判別可能な型（02-architecture.md §1.3・②'）。
//
// ②' の試験は、**宣言を見る前に**要件から作って固定する（宣言に合わせた期待を作らせない。§1.3）。
// だから、この型は**名前ではなく、要件 ID と役割で対象を指す**。名前は宣言を見ないと決まらないので、
// ここへ書けない（書いてしまうと、宣言を見てからでないと試験を作れなくなる）。
// あとで ⑤b で、実在の要素（entity・項目・計算・操作・画面の部品）に**結び付けられる**形にしてある。
//
// 1 件の試験は次を持つ（§1.3・②'）。
//   - `target` … 何を対象にするか（要件 ID・種類・役割）
//   - `kind` … 正常・異常・境界
//   - `operation` … 何をするか（計算・検査・操作・集計・画面）
//   - `clock` … 固定の日時（評価は時計に依存するので、試験は時計を固定する）
//   - `input` … 入力
//   - `referenceData` … 参照する他の entity の行
//   - `expected` … 期待（値か、誤りコード）
//
// 形は `checkFixedTest` が確かめる。合わないものは**断る**（固定してから気づくのでは遅い）。

/** 試験の種類（正常・異常・境界。§1.3） */
export const TEST_KINDS = ["normal", "abnormal", "boundary"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

/** 対象の種類（entity・項目・計算・操作・画面の部品。§1.3・②'） */
export const TEST_TARGET_KINDS = ["entity", "field", "computation", "operation", "screen"] as const;
export type TestTargetKind = (typeof TEST_TARGET_KINDS)[number];

/** 操作（計算・検査・操作の条件・集計・画面。②'） */
export const TEST_OPERATIONS = ["compute", "validate", "action", "aggregate", "screen"] as const;
export type TestOperation = (typeof TEST_OPERATIONS)[number];

/**
 * 対象の selector。**名前ではなく、要件 ID と役割で指す**（§1.3・②'）。
 * `role` は「合計を出す計算」「金額の項目」のような**役割の呼び名**で、宣言の名前ではない。
 */
export interface TestTarget {
  /** 要件 ID（① の一覧の 1 行。宣言を見る前に決まる） */
  readonly requirementId: string;
  /** 対象の種類 */
  readonly kind: TestTargetKind;
  /** 役割（名前ではなく、要件の中での働き） */
  readonly role: string;
}

/** 試験が参照する他の entity の行（②'。「参照データ」） */
export interface ReferenceRow {
  /** どの entity の行か（要件 ID と役割で指す） */
  readonly target: TestTarget;
  /** 行の値（項目の役割 → 値） */
  readonly values: Readonly<Record<string, unknown>>;
}

/** 期待。値か、誤りコードのどちらかである（異常の試験は誤りコードを期待する） */
export type TestExpected =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: string };

/** 固定した 1 件の試験（宣言を見る前に作り、以後は直す役も変えられない。§1.3） */
export interface FixedTest {
  readonly id: string;
  readonly target: TestTarget;
  readonly kind: TestKind;
  readonly operation: TestOperation;
  /** 固定の日時（オフセット付きの ISO 8601。時計に依存する値のため固定する） */
  readonly clock: string;
  readonly input: unknown;
  readonly referenceData: readonly ReferenceRow[];
  readonly expected: TestExpected;
}

/** ②' で固定する試験の組（コードが形を確かめて固定する） */
export interface TestSuite {
  readonly tests: readonly FixedTest[];
}

/** 形の合わない欄（欄の名前と、どう合わないか） */
export interface FixedTestProblem {
  readonly field: string;
  readonly message: string;
}

/** 固定の日時の形。spec-engine の `CLOCK_INSTANT_PATTERN` と同じ形（オフセットを必須にする） */
export const FIXED_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 固定の日時の形か（形と、実際に日時として読めることの両方を見る）。
 * オフセットを書いていない時刻は、実行する環境の時間帯によって別の瞬間を指すので読める形から外す。
 */
export function isFixedInstant(text: string): boolean {
  return FIXED_INSTANT_PATTERN.test(text) && !Number.isNaN(Date.parse(text));
}

/** 固定する試験の形を確かめた結果 */
export type FixedTestCheck =
  | { readonly ok: true; readonly test: FixedTest }
  | { readonly ok: false; readonly problems: readonly FixedTestProblem[] };

/** 試験の組の形を確かめた結果 */
export type TestSuiteCheck =
  | { readonly ok: true; readonly suite: TestSuite }
  | { readonly ok: false; readonly problems: readonly FixedTestProblem[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTestKind = (value: unknown): value is TestKind =>
  typeof value === "string" && (TEST_KINDS as readonly string[]).includes(value);

const isTargetKind = (value: unknown): value is TestTargetKind =>
  typeof value === "string" && (TEST_TARGET_KINDS as readonly string[]).includes(value);

const isTestOperation = (value: unknown): value is TestOperation =>
  typeof value === "string" && (TEST_OPERATIONS as readonly string[]).includes(value);

function checkTarget(value: unknown, field: string, problems: FixedTestProblem[]): TestTarget | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "対象は写像（object）であること" });
    return undefined;
  }
  const requirementId = value["requirementId"];
  const kind = value["kind"];
  const role = value["role"];
  let good = true;
  if (typeof requirementId !== "string" || requirementId === "") {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
    good = false;
  }
  if (!isTargetKind(kind)) {
    problems.push({
      field: `${field}.kind`,
      message: `対象の種類は ${TEST_TARGET_KINDS.join("・")} のいずれかであること`,
    });
    good = false;
  }
  if (typeof role !== "string" || role === "") {
    problems.push({ field: `${field}.role`, message: "役割は空でない文字列であること（名前ではなく役割で指す）" });
    good = false;
  }
  if (!good) return undefined;
  return { requirementId: requirementId as string, kind: kind as TestTargetKind, role: role as string };
}

function checkReferenceRow(
  value: unknown,
  field: string,
  problems: FixedTestProblem[],
): ReferenceRow | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "参照データの行は写像（object）であること" });
    return undefined;
  }
  const target = checkTarget(value["target"], `${field}.target`, problems);
  const values = value["values"];
  if (!isRecord(values)) {
    problems.push({ field: `${field}.values`, message: "参照データの行の値は写像（object）であること" });
    return undefined;
  }
  if (target === undefined) return undefined;
  return { target, values };
}

function checkReferenceData(
  value: unknown,
  problems: FixedTestProblem[],
): readonly ReferenceRow[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ field: "referenceData", message: "参照データは並び（array）であること" });
    return undefined;
  }
  const rows: ReferenceRow[] = [];
  let good = true;
  value.forEach((row, index) => {
    const checked = checkReferenceRow(row, `referenceData[${index}]`, problems);
    if (checked === undefined) good = false;
    else rows.push(checked);
  });
  return good ? rows : undefined;
}

function checkExpected(value: unknown, problems: FixedTestProblem[]): TestExpected | undefined {
  if (!isRecord(value)) {
    problems.push({ field: "expected", message: "期待は写像（object）であること" });
    return undefined;
  }
  const kind = value["kind"];
  if (kind === "ok") {
    if (!("value" in value)) {
      problems.push({ field: "expected.value", message: "期待が ok なら value があること" });
      return undefined;
    }
    return { kind: "ok", value: value["value"] };
  }
  if (kind === "error") {
    const code = value["code"];
    if (typeof code !== "string" || code === "") {
      problems.push({ field: "expected.code", message: "期待が error なら code は空でない文字列であること" });
      return undefined;
    }
    return { kind: "error", code };
  }
  problems.push({ field: "expected.kind", message: "期待の種類は ok か error であること" });
  return undefined;
}

/**
 * 固定する試験の形を確かめる。合わない欄を**すべて**挙げて返す（1 つ直すたびにやり直させない）。
 * 形が合えば、型の付いた試験を返す（固定できる）。
 */
export function checkFixedTest(value: unknown): FixedTestCheck {
  if (!isRecord(value)) {
    return { ok: false, problems: [{ field: "", message: "試験は写像（object）であること" }] };
  }
  const problems: FixedTestProblem[] = [];
  const id = value["id"];
  if (typeof id !== "string" || id === "") {
    problems.push({ field: "id", message: "識別子は空でない文字列であること" });
  }
  const target = checkTarget(value["target"], "target", problems);
  const kind = value["kind"];
  if (!isTestKind(kind)) {
    problems.push({ field: "kind", message: `種類は ${TEST_KINDS.join("・")} のいずれかであること` });
  }
  const operation = value["operation"];
  if (!isTestOperation(operation)) {
    problems.push({ field: "operation", message: `操作は ${TEST_OPERATIONS.join("・")} のいずれかであること` });
  }
  const clock = value["clock"];
  if (typeof clock !== "string" || !isFixedInstant(clock)) {
    problems.push({
      field: "clock",
      message: "時計はオフセット付きの ISO 8601（例 2026-09-16T12:00:00+09:00）であること",
    });
  }
  if (!("input" in value)) {
    problems.push({ field: "input", message: "入力があること" });
  }
  const referenceData = checkReferenceData(value["referenceData"], problems);
  const expected = checkExpected(value["expected"], problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    test: {
      id: id as string,
      target: target as TestTarget,
      kind: kind as TestKind,
      operation: operation as TestOperation,
      clock: clock as string,
      input: value["input"],
      referenceData: referenceData as readonly ReferenceRow[],
      expected: expected as TestExpected,
    },
  };
}

/** 試験の組の形を確かめる。欄の名前は `tests[i].…` として返す */
export function checkTestSuite(values: readonly unknown[]): TestSuiteCheck {
  const problems: FixedTestProblem[] = [];
  const tests: FixedTest[] = [];
  values.forEach((value, index) => {
    const checked = checkFixedTest(value);
    if (checked.ok) {
      tests.push(checked.test);
      return;
    }
    for (const problem of checked.problems) {
      problems.push({
        field: problem.field === "" ? `tests[${index}]` : `tests[${index}].${problem.field}`,
        message: problem.message,
      });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, suite: { tests } };
}
