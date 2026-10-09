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

/**
 * 要件の種類（決まりを含む／在ることだけ。§1・②・Issue #307）。
 *
 * - `ruled`（決まりを含む）… 決まりの役割ごとに、正常・異常・境界の試験を作る
 * - `existence-only`（在ることだけ）… 正常のシナリオ 1 本か、構造の条件だけを固定する。
 *   **異常・境界の試験や検査を求めない**（疎通の確認で、検査の場所が無いのに検査の試験が作られた）
 */
export const REQUIREMENT_NATURES = ["ruled", "existence-only"] as const;
export type RequirementNature = (typeof REQUIREMENT_NATURES)[number];

/**
 * ②' が、原文と要件の一覧だけから**独立に**分類した、要件ごとの種類（§1・②'・Issue #307）。
 * 設計の出力は見せない（設計に合わせた分類を作らせない）。
 */
export interface RequirementClassification {
  readonly requirementId: string;
  readonly nature: RequirementNature;
}

/** 対象の種類（entity・項目・計算・操作・画面の部品。§1.3・②'） */
export const TEST_TARGET_KINDS = ["entity", "field", "computation", "operation", "screen"] as const;
export type TestTargetKind = (typeof TEST_TARGET_KINDS)[number];

/** 操作（計算・検査・操作の条件・集計・画面。②'） */
export const TEST_OPERATIONS = ["compute", "validate", "action", "aggregate", "screen"] as const;
export type TestOperation = (typeof TEST_OPERATIONS)[number];

/**
 * 対象の selector。**名前ではなく、要件 ID と役割 ID で指す**（§1.3・②'・Issue #307）。
 *
 * `roleId` は「entity の文脈を含む ID」（例 `member`・`member.name`・`session.bookCount`。
 * ② の役割 ID の表で固定する）。`role` は**旧形式の自由な文の役割**で、② の役割 ID の表で
 * それが役割 ID だと確かめられなければ断る——ここでは後方互換のためだけに残す。
 */
export interface TestTarget {
  /** 要件 ID（① の一覧の 1 行。宣言を見る前に決まる） */
  readonly requirementId: string;
  /** 対象の種類 */
  readonly kind: TestTargetKind;
  /** 役割 ID（entity の文脈を含む ID。② の役割 ID の表で固定する） */
  readonly roleId?: string;
  /** 旧形式の役割（自由な文。②' の新しい契約では使わない） */
  readonly role?: string;
}

/** 試験が参照する他の entity の行（②'。「参照データ」） */
export interface ReferenceRow {
  /** どの entity の行か（要件 ID と役割 ID で指す） */
  readonly target: TestTarget;
  /** 行の ID（固定。試験の入力の契約の「固定の行 ID」。§1・②'・Issue #307） */
  readonly rowId?: string;
  /** 行の値（項目の役割 → 値） */
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * 試験の入力の契約（§1・②'・Issue #307）。②' の入力に、**固定の行 ID・評価の対象の行 ID・
 * 空の entity の集合の明示**を足す。任意の欄で、無ければ省ける（旧形式の記録は省く）。
 */
export interface TestInputContract {
  /** 入力の行の ID（固定。参照データの行と結び付ける） */
  readonly rowId: string;
  /** 評価の対象の行の ID（行を評価しないときは null） */
  readonly targetRowId: string | null;
  /** 空であることを明示する entity の役割 ID の並び（「無い」と「空」を区別する） */
  readonly emptyEntities: readonly string[];
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
  /** 入力の契約（固定の行 ID・評価の対象の行 ID・空の集合。§1・②'）。旧形式の記録では省ける */
  readonly inputContract?: TestInputContract;
  readonly referenceData: readonly ReferenceRow[];
  readonly expected: TestExpected;
}

/** ②' で固定する試験の組（コードが形を確かめて固定する） */
export interface TestSuite {
  readonly tests: readonly FixedTest[];
  /** ②' が独立に分類した要件ごとの種類（§1・②'）。旧形式の記録では省ける */
  readonly classifications?: readonly RequirementClassification[];
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

/** 要件の種類（決まりを含む／在ることだけ）か */
export const isRequirementNature = (value: unknown): value is RequirementNature =>
  typeof value === "string" && (REQUIREMENT_NATURES as readonly string[]).includes(value);

function checkTarget(value: unknown, field: string, problems: FixedTestProblem[]): TestTarget | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "対象は写像（object）であること" });
    return undefined;
  }
  const requirementId = value["requirementId"];
  const kind = value["kind"];
  const role = value["role"];
  const roleId = value["roleId"];
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
  const hasRole = role !== undefined;
  const hasRoleId = roleId !== undefined;
  if (hasRole && (typeof role !== "string" || role === "")) {
    problems.push({ field: `${field}.role`, message: "役割は空でない文字列であること（名前ではなく役割で指す）" });
    good = false;
  }
  if (hasRoleId && (typeof roleId !== "string" || roleId === "")) {
    problems.push({ field: `${field}.roleId`, message: "役割 ID は空でない文字列であること" });
    good = false;
  }
  if (!hasRole && !hasRoleId) {
    problems.push({
      field: `${field}.roleId`,
      message: "役割 ID（または旧形式の役割）が空でない文字列であること",
    });
    good = false;
  }
  if (!good) return undefined;
  return {
    requirementId: requirementId as string,
    kind: kind as TestTargetKind,
    ...(hasRole ? { role: role as string } : {}),
    ...(hasRoleId ? { roleId: roleId as string } : {}),
  };
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
  const rowId = value["rowId"];
  if (rowId !== undefined && (typeof rowId !== "string" || rowId === "")) {
    problems.push({ field: `${field}.rowId`, message: "行の ID は空でない文字列であること" });
    return undefined;
  }
  if (target === undefined) return undefined;
  return { target, ...(rowId === undefined ? {} : { rowId: rowId as string }), values };
}

/** 入力の契約（固定の行 ID・評価の対象の行 ID・空の集合）の形を確かめる（§1・②'・Issue #307） */
function checkInputContract(value: unknown, problems: FixedTestProblem[]): TestInputContract | undefined {
  if (!isRecord(value)) {
    problems.push({ field: "inputContract", message: "入力の契約は写像（object）であること" });
    return undefined;
  }
  let good = true;
  const rowId = value["rowId"];
  if (typeof rowId !== "string" || rowId === "") {
    problems.push({ field: "inputContract.rowId", message: "固定の行 ID は空でない文字列であること" });
    good = false;
  }
  const targetRowId = value["targetRowId"];
  if (targetRowId !== null && (typeof targetRowId !== "string" || targetRowId === "")) {
    problems.push({
      field: "inputContract.targetRowId",
      message: "評価の対象の行 ID は空でない文字列か null であること",
    });
    good = false;
  }
  const rawEmpty = value["emptyEntities"];
  const emptyEntities: string[] = [];
  if (!Array.isArray(rawEmpty)) {
    problems.push({ field: "inputContract.emptyEntities", message: "空の集合は文字列の並びであること" });
    good = false;
  } else {
    rawEmpty.forEach((item, index) => {
      if (typeof item !== "string" || item === "") {
        problems.push({ field: `inputContract.emptyEntities[${index}]`, message: "空でない文字列であること" });
        good = false;
      } else {
        emptyEntities.push(item);
      }
    });
  }
  if (!good) return undefined;
  return { rowId: rowId as string, targetRowId: targetRowId as string | null, emptyEntities };
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
  const inputContract = "inputContract" in value ? checkInputContract(value["inputContract"], problems) : undefined;
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
      ...(inputContract === undefined ? {} : { inputContract }),
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
