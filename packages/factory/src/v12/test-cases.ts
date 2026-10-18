// T2 の場合の形と展開（08-architecture-v1.2.md §4 の C4・§6。v1.2 手 3e・Issue #625）。
//
// 旗 `v12.ids` の走りだけ、T2 の LLM には値の要る試験の「場合」（要件・対象の行・種類・観測する性質・入力の値・参照の行の値・
// 期待）だけを短い schema で書かせ、骨組み（試験 ID・操作・対象の種類・時計・入力の契約の形・参照データの対象の要件 ID と種類・
// assertion・期待の null の欄）は**コードが導いて**今の試験の形（v1 の ②' の raw の形）へ展開する（LLM を呼ばない純粋な関数）。
//
//   - 行 ID は振り直さない（入力と参照の行の rowId・評価の対象の行・ref・list の値に書いた行 ID をそのまま保つ）
//   - observes は場合の値をそのまま使う（対象の種類 × 操作からは 1 つに決まらない。網羅の鍵を保つ）。組の誤りは展開後の
//     評価可能性の検査が今までどおり落とす
//   - 展開できない場合は固定文で落とす（黙って補わない・近い行に結ばない）。位置は cases の添字と欄名
//
// 展開した組には、呼ぶ側（`v11a/stages/test-spec.ts`）が今の形の検査と中身の検査を 1 つも省かずに掛ける。
import { TEST_KINDS, type TestKind, type TestOperation } from "../fixed-test.js";
import { isRecord, type Problem, type ShapeCheck } from "../stages/prompt.js";
import { TEST_SUITE_SCHEMA, checkTestSuiteOutput } from "../stages/test-suite.js";
import type { ComputationRowType, NameTable, NameTableRow } from "../v11a/names.js";
import { GENERATED_TEST_CLOCK } from "./generated-tests.js";
import type { LedgerView } from "./ledger.js";

/** 展開した試験の ID の接頭辞（コードが cases の順に連番を振る。コードが作る試験の `gen:` とは別） */
export const TEST_CASE_ID_PREFIX = "case:";

/** 展開した試験の固定の日時（コードが作る試験と同じ定数） */
export const TEST_CASE_CLOCK = GENERATED_TEST_CLOCK;

/** 場合の参照の行（行 ID・参照元 entity の行 ID・値の JSON 文字列） */
export interface TestCaseRow {
  readonly rowId: string;
  readonly entityId: string;
  readonly values: string;
}

/** 場合 1 つ（形の検査を通った raw。期待は kind と欄の組を展開で確かめる） */
export interface TestCase {
  readonly requirementId: string;
  readonly targetId: string;
  readonly kind: TestKind;
  readonly observes: string;
  readonly input: { readonly rowId: string; readonly values: string };
  readonly targetRowId: string | null;
  readonly rows: readonly TestCaseRow[];
  readonly expected: Readonly<Record<string, unknown>>;
  readonly emptyEntities: readonly string[];
}

/** 形の検査を通った場合の応答（分類は raw のまま。展開した組で今の形の検査が読む） */
export interface TestCasesOutput {
  readonly classifications: unknown;
  readonly cases: readonly TestCase[];
}

// ── JSON Schema（旗 ids の T2 の応答）──────────────────────────────────

/**
 * 場合の schema（旗 `v12.ids` の T2。strict の規則：すべての欄を required・additionalProperties false）。分類は今のまま。
 * observes の enum は台帳の順。期待は kind ごとの形（ok は value・error は code）の anyOf。
 */
export function testCasesSchemaOf(ledger: LedgerView) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["classifications", "cases"],
    properties: {
      classifications: TEST_SUITE_SCHEMA.properties.classifications,
      cases: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requirementId", "targetId", "kind", "observes", "input", "targetRowId", "rows", "expected", "emptyEntities"],
          properties: {
            requirementId: { type: "string" },
            targetId: { type: "string", description: "対象の表の id（その要件の所属にある id）" },
            kind: { type: "string", enum: [...TEST_KINDS] },
            observes: { type: "string", enum: [...ledger.observes], description: "試験が観測する性質（評価の方法の表の組に限る）" },
            input: {
              type: "object",
              additionalProperties: false,
              required: ["rowId", "values"],
              properties: {
                rowId: { type: "string", description: "入力の行の ID（固定）" },
                values: { type: "string", description: "入力の行の値（項目の表の id → 値）の JSON 文字列。無ければ空の写像" },
              },
            },
            targetRowId: { type: ["string", "null"], description: "評価の対象の行の ID（入力か参照の行の ID。行を評価しないときは null）" },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rowId", "entityId", "values"],
                properties: {
                  rowId: { type: "string", description: "参照の行の ID（固定）" },
                  entityId: { type: "string", description: "参照元の entity の表の id" },
                  values: { type: "string", description: "行の値（項目の表の id → 値）の JSON 文字列" },
                },
              },
            },
            expected: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "value"],
                  properties: {
                    kind: { type: "string", enum: ["ok"] },
                    value: { type: "string", description: "期待する値の JSON 文字列" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "code"],
                  properties: {
                    kind: { type: "string", enum: ["error"] },
                    code: { type: "string", description: "期待する誤りコード" },
                  },
                },
              ],
            },
            emptyEntities: { type: "array", items: { type: "string" }, description: "空であることを明示する entity の表の id" },
          },
        },
      },
    },
  } as const;
}

// ── 形の検査 ──────────────────────────────────────────────────────

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/** JSON の文字列を読み直した値が写像か（読めなければ偽） */
function decodesToRecord(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

/** 場合の形の固定文（値を埋めない） */
export const TEST_CASE_SHAPE_MESSAGES = {
  cases: "場合の一覧は並び（array）であること",
  case: "場合は写像（object）であること",
  requirementId: "要件 ID は空でない文字列であること",
  targetId: "対象の表の id は空でない文字列であること",
  kind: `種類は ${TEST_KINDS.join("・")} のいずれかであること`,
  input: "入力は行の ID（rowId）と値の JSON 文字列（values）の写像であること",
  inputRowId: "入力の行の ID は空でない文字列であること",
  inputValues: "入力の値は JSON の文字列であること",
  targetRowId: "評価の対象の行 ID は空でない文字列か null であること",
  rows: "参照の行は並び（array）であること",
  row: "参照の行は写像（object）であること",
  rowId: "参照の行の ID は空でない文字列であること",
  entityId: "参照元の entity の表の id は空でない文字列であること",
  rowValues: "参照の行の値は写像（object）の JSON 文字列であること",
  expected: "期待は kind が ok か error の写像であること",
  emptyEntities: "空の集合は空でない文字列の並びであること",
} as const;

/**
 * 場合の応答の形を確かめる（旗 `v12.ids` の T2）。分類の形は v1 の `checkTestSuiteOutput` に任せ、場合ごとに schema の型と、
 * 参照の行の値が写像の JSON 文字列であること（v1 の形の検査と同じ）を見る。表との整合は展開（`expandTestCases`）が見る。
 */
export function checkTestCasesOutput(output: unknown, ledger: LedgerView): ShapeCheck<TestCasesOutput> {
  if (!isRecord(output)) return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  const problems: Problem[] = [];
  const classified = checkTestSuiteOutput({ ...("classifications" in output ? { classifications: output["classifications"] } : {}), tests: [] });
  if (!classified.ok) problems.push(...classified.problems);
  const rawCases = output["cases"];
  if (!Array.isArray(rawCases)) {
    problems.push({ field: "cases", message: TEST_CASE_SHAPE_MESSAGES.cases });
    return { ok: false, problems };
  }
  const known: readonly string[] = ledger.observes;
  const cases: TestCase[] = [];
  (rawCases as readonly unknown[]).forEach((raw, index) => {
    const at = `cases[${index}]`;
    if (!isRecord(raw)) {
      problems.push({ field: at, message: TEST_CASE_SHAPE_MESSAGES.case });
      return;
    }
    const before = problems.length;
    if (!isNonEmptyString(raw["requirementId"])) problems.push({ field: `${at}.requirementId`, message: TEST_CASE_SHAPE_MESSAGES.requirementId });
    if (!isNonEmptyString(raw["targetId"])) problems.push({ field: `${at}.targetId`, message: TEST_CASE_SHAPE_MESSAGES.targetId });
    const kind = raw["kind"];
    if (typeof kind !== "string" || !(TEST_KINDS as readonly string[]).includes(kind)) {
      problems.push({ field: `${at}.kind`, message: TEST_CASE_SHAPE_MESSAGES.kind });
    }
    const observes = raw["observes"];
    if (typeof observes !== "string" || !known.includes(observes)) {
      problems.push({ field: `${at}.observes`, message: `観測する性質は ${known.join("・")} のいずれかであること` });
    }
    const input = raw["input"];
    if (!isRecord(input)) {
      problems.push({ field: `${at}.input`, message: TEST_CASE_SHAPE_MESSAGES.input });
    } else {
      if (!isNonEmptyString(input["rowId"])) problems.push({ field: `${at}.input.rowId`, message: TEST_CASE_SHAPE_MESSAGES.inputRowId });
      if (typeof input["values"] !== "string") problems.push({ field: `${at}.input.values`, message: TEST_CASE_SHAPE_MESSAGES.inputValues });
    }
    const targetRowId = raw["targetRowId"];
    if (targetRowId !== null && !isNonEmptyString(targetRowId)) {
      problems.push({ field: `${at}.targetRowId`, message: TEST_CASE_SHAPE_MESSAGES.targetRowId });
    }
    const rows = raw["rows"];
    if (!Array.isArray(rows)) {
      problems.push({ field: `${at}.rows`, message: TEST_CASE_SHAPE_MESSAGES.rows });
    } else {
      (rows as readonly unknown[]).forEach((row, rowIndex) => {
        const rowAt = `${at}.rows[${rowIndex}]`;
        if (!isRecord(row)) {
          problems.push({ field: rowAt, message: TEST_CASE_SHAPE_MESSAGES.row });
          return;
        }
        if (!isNonEmptyString(row["rowId"])) problems.push({ field: `${rowAt}.rowId`, message: TEST_CASE_SHAPE_MESSAGES.rowId });
        if (!isNonEmptyString(row["entityId"])) problems.push({ field: `${rowAt}.entityId`, message: TEST_CASE_SHAPE_MESSAGES.entityId });
        const values = row["values"];
        if (typeof values !== "string" || !decodesToRecord(values)) {
          problems.push({ field: `${rowAt}.values`, message: TEST_CASE_SHAPE_MESSAGES.rowValues });
        }
      });
    }
    const expected = raw["expected"];
    if (!isRecord(expected) || (expected["kind"] !== "ok" && expected["kind"] !== "error")) {
      problems.push({ field: `${at}.expected`, message: TEST_CASE_SHAPE_MESSAGES.expected });
    }
    const empty = raw["emptyEntities"];
    if (!Array.isArray(empty) || !(empty as readonly unknown[]).every(isNonEmptyString)) {
      problems.push({ field: `${at}.emptyEntities`, message: TEST_CASE_SHAPE_MESSAGES.emptyEntities });
    }
    if (problems.length === before) cases.push(raw as unknown as TestCase);
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { classifications: output["classifications"], cases } };
}

// ── 展開 ─────────────────────────────────────────────────────────

/** 展開できない場合の固定文（値を埋めない。位置は cases の添字と欄名） */
export const TEST_CASE_EXPAND_MESSAGES = {
  target: "対象の行が表に無い",
  entity: "参照の行の参照元が、表の entity の行でない",
  valueKey: "参照の行の値の鍵が、その entity の項目の行の id でない",
  duplicateRowId: "同じ場合の中で行の ID が重なっている",
  targetRowId: "評価の対象の行の ID が、その場合の入力か参照の行の ID でない",
  emptyEntity: "空と明示する entity が、表の entity の行でない",
  expected: "期待の kind と欄が合わない（ok は value だけ、error は空でない code だけを書く）",
} as const;

/** 展開した結果（今の試験の形の raw の応答と、試験 ID → 場合の添字の対応表） */
export type TestCasesExpansion =
  | {
      readonly ok: true;
      /** 今の T2 の応答の形（分類と、observes を添えた raw の試験の並び。値の欄は場合の JSON 文字列のまま） */
      readonly output: { readonly classifications: unknown; readonly tests: readonly Record<string, unknown>[] };
      /** 展開した試験 ID → 場合の添字 */
      readonly caseIndexById: ReadonlyMap<string, number>;
    }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** 対象の行の種類から操作を導く（計算は種別 aggregate なら aggregate・ほかは compute、項目と entity は validate、操作は action） */
export function caseOperationOf(row: NameTableRow): TestOperation {
  switch (row.kind) {
    case "computation":
      return (row.type as ComputationRowType | null)?.form === "aggregate" ? "aggregate" : "compute";
    case "field":
    case "entity":
      return "validate";
    case "operation":
      return "action";
    case "screen":
      // 画面の試験はコードが作る（#624）。展開後の検査（LLM の screen の試験を落とす固定文）が今までどおり落とす
      return "screen";
  }
}

/** 期待の kind と欄の組が合うか（ok は value の文字列だけ、error は空でない code だけ） */
function expectedOf(expected: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const keys = Object.keys(expected).sort();
  if (expected["kind"] === "ok") {
    return keys.join(",") === "kind,value" && typeof expected["value"] === "string"
      ? { kind: "ok", value: expected["value"], code: null }
      : undefined;
  }
  return keys.join(",") === "code,kind" && isNonEmptyString(expected["code"])
    ? { kind: "error", value: null, code: expected["code"] }
    : undefined;
}

/** 値の JSON 文字列の直下の鍵（写像でなければ空） */
function valueKeysOf(text: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? Object.keys(value) : [];
  } catch {
    return [];
  }
}

/**
 * 場合を今の試験の形へ展開する（純粋。同じ場合と表から同じ組）。試験 ID は `case:` と cases の順の連番、操作は対象の行の種類から、
 * 対象の種類は行の kind、時計は定数、入力の契約は場合の rowId・targetRowId・emptyEntities のまま、参照データは rows ごとに
 * 場合の rowId・対象（要件 ID・kind entity・場合の entity の行 ID）・値のまま、assertion は null、期待は kind に応じて value か
 * code を null で補う。表と合わない場合は 1 つでもあれば全部の問題を固定文で返す（補わない）。
 */
export function expandTestCases(output: TestCasesOutput, table: NameTable): TestCasesExpansion {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const isEntity = (id: string): boolean => rowById.get(id)?.kind === "entity";
  const problems: Problem[] = [];
  const tests: Record<string, unknown>[] = [];
  const caseIndexById = new Map<string, number>();
  output.cases.forEach((entry, index) => {
    const at = `cases[${index}]`;
    const before = problems.length;
    const row = rowById.get(entry.targetId);
    if (row === undefined) problems.push({ field: `${at}.targetId`, message: TEST_CASE_EXPAND_MESSAGES.target });
    const seen = new Set<string>([entry.input.rowId]);
    entry.rows.forEach((reference, rowIndex) => {
      const rowAt = `${at}.rows[${rowIndex}]`;
      if (seen.has(reference.rowId)) problems.push({ field: `${rowAt}.rowId`, message: TEST_CASE_EXPAND_MESSAGES.duplicateRowId });
      seen.add(reference.rowId);
      if (!isEntity(reference.entityId)) {
        problems.push({ field: `${rowAt}.entityId`, message: TEST_CASE_EXPAND_MESSAGES.entity });
        return;
      }
      const foreign = valueKeysOf(reference.values).some((key) => {
        const field = rowById.get(key);
        return field === undefined || field.kind !== "field" || field.entity !== reference.entityId;
      });
      if (foreign) problems.push({ field: `${rowAt}.values`, message: TEST_CASE_EXPAND_MESSAGES.valueKey });
    });
    if (entry.targetRowId !== null && !seen.has(entry.targetRowId)) {
      problems.push({ field: `${at}.targetRowId`, message: TEST_CASE_EXPAND_MESSAGES.targetRowId });
    }
    entry.emptyEntities.forEach((id, emptyIndex) => {
      if (!isEntity(id)) problems.push({ field: `${at}.emptyEntities[${emptyIndex}]`, message: TEST_CASE_EXPAND_MESSAGES.emptyEntity });
    });
    const expected = expectedOf(entry.expected);
    if (expected === undefined) problems.push({ field: `${at}.expected`, message: TEST_CASE_EXPAND_MESSAGES.expected });
    if (problems.length > before || row === undefined || expected === undefined) return;
    const id = `${TEST_CASE_ID_PREFIX}${String(index + 1)}`;
    caseIndexById.set(id, index);
    tests.push({
      id,
      target: { requirementId: entry.requirementId, kind: row.kind, roleId: entry.targetId },
      kind: entry.kind,
      operation: caseOperationOf(row),
      clock: TEST_CASE_CLOCK,
      input: entry.input.values,
      inputContract: { rowId: entry.input.rowId, targetRowId: entry.targetRowId, emptyEntities: [...entry.emptyEntities] },
      referenceData: entry.rows.map((reference) => ({
        rowId: reference.rowId,
        target: { requirementId: entry.requirementId, kind: "entity", roleId: reference.entityId },
        values: reference.values,
      })),
      expected,
      assertion: null,
      observes: entry.observes,
    });
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, output: { classifications: output.classifications, tests }, caseIndexById };
}

// ── 問題の位置の写し（展開後の組 → 場合）─────────────────────────────

/** 試験の欄の位置 → 場合の欄の位置（骨組みの欄はコードが導くので、導いた元の欄か場合そのものへ写す） */
function caseFieldOf(rest: string): string {
  const reference = /^\.referenceData\[(\d+)\](.*)$/.exec(rest);
  if (reference !== null) {
    const [, rowIndex = "", tail = ""] = reference;
    const at = `.rows[${rowIndex}]`;
    if (tail.startsWith(".target.requirementId")) return ".requirementId";
    if (tail.startsWith(".target")) return `${at}.entityId`;
    if (tail.startsWith(".values")) return `${at}${tail}`;
    return tail.startsWith(".rowId") ? `${at}.rowId` : at;
  }
  if (rest.startsWith(".referenceData")) return ".rows";
  if (rest.startsWith(".inputContract.rowId")) return ".input.rowId";
  if (rest.startsWith(".inputContract.targetRowId")) return ".targetRowId";
  if (rest.startsWith(".inputContract.emptyEntities")) return rest.slice(".inputContract".length);
  if (rest.startsWith(".inputContract")) return ".input";
  if (rest.startsWith(".input")) return `.input.values${rest.slice(".input".length)}`;
  if (rest.startsWith(".target.requirementId")) return ".requirementId";
  if (rest.startsWith(".target") || rest.startsWith(".operation")) return ".targetId";
  for (const kept of [".kind", ".observes", ".expected"]) if (rest.startsWith(kept)) return rest;
  // 試験 ID・時計・assertion はコードが決める欄なので、場合そのものを指す
  return "";
}

/**
 * 展開後の組の位置（`tests[添字]…`）の問題を、場合の位置（`cases[添字]…`）へ写す（展開の対応表で引く）。組の試験は
 * `tests`（外したあとの組の並び）の添字で引き、場合から展開した試験でない（コードが作った試験・対応の無い）位置は変えない。
 */
export function toCasePositions(
  problems: readonly Problem[],
  tests: readonly { readonly id: string }[],
  caseIndexById: ReadonlyMap<string, number>,
): readonly Problem[] {
  return problems.map((problem) => {
    const match = /^tests\[(\d+)\](.*)$/.exec(problem.field);
    if (match === null) return problem;
    const [, testIndex = "", rest = ""] = match;
    const id = tests[Number(testIndex)]?.id;
    const caseIndex = id === undefined ? undefined : caseIndexById.get(id);
    if (caseIndex === undefined) return problem;
    return { ...problem, field: `cases[${String(caseIndex)}]${caseFieldOf(rest)}` };
  });
}
