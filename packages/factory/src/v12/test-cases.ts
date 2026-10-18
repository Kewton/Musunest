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

// ── 束（手 3f・Issue #626）───────────────────────────────────────────
//
// 束の中で閉じる条件（束ごとに見る）は、分類がその束の要件にちょうど 1 件と、場合の要件 ID がその束の要件であることだけ。網羅・総数・
// 重複・分類の照合・J2 などの合併した組の条件は、ここでは見ない（呼ぶ側が合併後に 1 回だけ掛ける）。

/** 束の完全性の固定文（値を埋めない） */
export const TEST_CASE_BUNDLE_MESSAGES = {
  unknown: "要件の一覧に無い要件 ID の分類である",
  outside: "別の束の要件 ID の分類である",
  duplicate: "同じ要件の分類が重なっている",
  missing: "束の要件の分類が無い",
  caseOutside: "場合の要件 ID が別の束の要件である",
  caseUnknown: "場合の要件 ID が要件の一覧に無い",
  retained: "書き直さない（保持した）要件の分類である",
  caseRetained: "場合の要件 ID が書き直さない（保持した）要件である",
  unattributed: "問題を束に帰属できない",
} as const;

/** 要件 ID の並びを、並びの順で `size` 件ごとの束に切る（最後の束は `size` 未満でよい。空の並びは束 0） */
export function bundleRequirementIds(ids: readonly string[], size: number): readonly (readonly string[])[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("束の大きさは 1 以上の整数であること");
  const bundles: string[][] = [];
  for (let start = 0; start < ids.length; start += size) bundles.push(ids.slice(start, start + size));
  return bundles;
}

/**
 * 束の完全性（束の中で閉じる条件だけ）。分類がその束の要件にちょうど 1 件（欠落・重複・別の束の要件 ID・一覧に無い要件 ID）で、
 * 場合の要件 ID が別の束の要件でも一覧に無い要件でもないこと。位置はその束の応答の添字（`classifications[i]`・`cases[i]`・束の中の
 * `requirements[i]`）。`requestedIds` は全部の束の要件（要求の一覧）、`knownIds` は残る要件の一覧（要求の一覧を含む）。一覧にあるが
 * どの束にも無い要件（コードの試験だけで確かめる要件）の分類・場合はここでは断らず、合併後の検査が今までどおりの固定文で断る。
 * 中身のやり直し（手 3g・Issue #651）では `bundleIds` は書き直す要件だけで、`retainedIds`（同じ束の保持した要件）の分類・場合が
 * 応答にあれば、別の束の要件とは別の固定文で断る
 */
export function checkBundleCompleteness(
  output: TestCasesOutput,
  bundleIds: readonly string[],
  requestedIds: readonly string[],
  knownIds: readonly string[],
  retainedIds: readonly string[] = [],
): readonly Problem[] {
  const problems: Problem[] = [];
  const inBundle = new Set(bundleIds);
  const retained = new Set(retainedIds);
  const requested = new Set(requestedIds);
  const known = new Set([...knownIds, ...requestedIds]);
  const seen = new Set<string>();
  const classifications = Array.isArray(output.classifications) ? (output.classifications as readonly unknown[]) : [];
  classifications.forEach((entry, index) => {
    const field = `classifications[${String(index)}].requirementId`;
    const id = isRecord(entry) && typeof entry["requirementId"] === "string" ? entry["requirementId"] : undefined;
    if (id === undefined || !known.has(id)) {
      problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.unknown });
      return;
    }
    if (retained.has(id)) {
      problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.retained });
      return;
    }
    if (!inBundle.has(id)) {
      if (requested.has(id)) problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.outside });
      return;
    }
    if (seen.has(id)) {
      problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.duplicate });
      return;
    }
    seen.add(id);
  });
  bundleIds.forEach((id, index) => {
    if (!seen.has(id)) problems.push({ field: `requirements[${String(index)}]`, message: TEST_CASE_BUNDLE_MESSAGES.missing });
  });
  output.cases.forEach((entry, index) => {
    const field = `cases[${String(index)}].requirementId`;
    if (!known.has(entry.requirementId)) problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.caseUnknown });
    else if (retained.has(entry.requirementId)) problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.caseRetained });
    else if (!inBundle.has(entry.requirementId) && requested.has(entry.requirementId)) {
      problems.push({ field, message: TEST_CASE_BUNDLE_MESSAGES.caseOutside });
    }
  });
  return problems;
}

/** 合併した場合の応答と、合併の位置 → 束（束の添字と束の中の添字）の対応 */
export interface MergedTestCases {
  readonly output: TestCasesOutput;
  /** 合併の場合の添字 → [束の添字, 束の中の添字] */
  readonly caseOrigin: readonly (readonly [number, number])[];
  /** 合併の分類の添字 → [束の添字, 束の中の添字] */
  readonly classificationOrigin: readonly (readonly [number, number])[];
}

/** 分類の要件 ID（写像で文字列のときだけ） */
const classificationIdOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry["requirementId"] === "string" ? entry["requirementId"] : undefined;

/**
 * 束の応答を 1 つの応答に合併する（重ねを除かない。重ねは合併後の検査が落とす）。`order`（要求の一覧の要件 ID の順）を渡せば、
 * **要件の一覧の順に要件ごと、要件の中は応答の順**に並べる（初回もやり直しも同じ規則。どの要件を書き直しても並びの規則は
 * 変わらない。一覧に無い要件 ID の分類・場合は末尾に束の順・束の中の順で置く。Issue #651）。省けば束の順・束の中の順
 */
export function mergeBundleCases(outputs: readonly TestCasesOutput[], order?: readonly string[]): MergedTestCases {
  const cases: TestCase[] = [];
  const classifications: unknown[] = [];
  const caseOrigin: (readonly [number, number])[] = [];
  const classificationOrigin: (readonly [number, number])[] = [];
  outputs.forEach((output, bundle) => {
    output.cases.forEach((entry, index) => {
      cases.push(entry);
      caseOrigin.push([bundle, index]);
    });
    (Array.isArray(output.classifications) ? (output.classifications as readonly unknown[]) : []).forEach((entry, index) => {
      classifications.push(entry);
      classificationOrigin.push([bundle, index]);
    });
  });
  if (order === undefined) return { output: { classifications, cases }, caseOrigin, classificationOrigin };
  const rank = new Map(order.map((id, index) => [id, index] as const));
  const rankOf = (id: string | undefined): number => (id === undefined ? order.length : (rank.get(id) ?? order.length));
  // 安定な並べ替え（同じ要件の中は束の順・応答の順のまま）
  const sorted = <T>(entries: readonly T[], origins: readonly (readonly [number, number])[], idOf: (entry: T) => string | undefined) =>
    entries
      .map((entry, index) => ({ entry, origin: origins[index] as readonly [number, number], rank: rankOf(idOf(entry)), index }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const sortedCases = sorted(cases, caseOrigin, (entry) => entry.requirementId);
  const sortedClassifications = sorted(classifications, classificationOrigin, classificationIdOf);
  return {
    output: { classifications: sortedClassifications.map((item) => item.entry), cases: sortedCases.map((item) => item.entry) },
    caseOrigin: sortedCases.map((item) => item.origin),
    classificationOrigin: sortedClassifications.map((item) => item.origin),
  };
}

/** 束へ帰属させた問題（束ごとの問題は位置をその束の応答の添字へ写したもの）と、帰属できない問題 */
export interface AttributedProblems {
  readonly byBundle: ReadonlyMap<number, readonly Problem[]>;
  readonly unattributed: readonly Problem[];
}

/**
 * 合併後の組の問題を束へ帰属させる（推測しない）。要件の位置（要求の一覧の `requirements[i]`。束は一覧の順で切ってあるので
 * `i` を束の大きさで割る）・場合の位置（`cases[i]…`）・分類の位置（`classifications[i]…`）を持つ問題だけを、その束へ、その束の
 * 中の添字に写して渡す。ほかの位置（コードが作った試験・応答全体など）は帰属できない問題として返す
 */
export function attributeProblemsToBundles(
  problems: readonly Problem[],
  merged: MergedTestCases,
  bundles: readonly (readonly string[])[],
): AttributedProblems {
  const byBundle = new Map<number, Problem[]>();
  const unattributed: Problem[] = [];
  const push = (bundle: number, problem: Problem): void => {
    const list = byBundle.get(bundle) ?? [];
    list.push(problem);
    byBundle.set(bundle, list);
  };
  const requirementOrigin: (readonly [number, number])[] = bundles.flatMap((ids, bundle) => ids.map((_, index) => [bundle, index] as const));
  for (const problem of problems) {
    const match = /^(requirements|cases|classifications)\[(\d+)\](.*)$/.exec(problem.field);
    if (match === null) {
      unattributed.push(problem);
      continue;
    }
    const [, head = "", at = "", rest = ""] = match;
    const origins = head === "requirements" ? requirementOrigin : head === "cases" ? merged.caseOrigin : merged.classificationOrigin;
    const origin = origins[Number(at)];
    if (origin === undefined || (head === "requirements" && rest !== "")) {
      unattributed.push(problem);
      continue;
    }
    const [bundle, local] = origin;
    push(bundle, { ...problem, field: `${head}[${String(local)}]${rest}` });
  }
  return { byBundle, unattributed };
}

// ── 要件への帰属と中身のやり直しの単位（手 3g・Issue #651）──────────────────
//
// 中身のやり直しは、問題の帰属した要件だけを書き直させる（同じ束の問題の無かった要件の分類と場合は初回のまま保持する）。束は
// 「帰属した要件を含む束」。保持の寿命は 1 回の T2 の呼び出しの中だけ（呼ぶ側が呼び出しの外に出さない）。

/** 要件へ帰属させた問題（位置は合併した応答の位置のまま）と、帰属できない問題 */
export interface RequirementAttributedProblems {
  /** 要件 ID → その要件の問題（入力の順）。鍵は要求の一覧の順、そのあとに一覧に無い要件 ID を初めて現れた順 */
  readonly byRequirement: ReadonlyMap<string, readonly Problem[]>;
  readonly unattributed: readonly Problem[];
}

const POSITION = /^(requirements|cases|classifications)\[(\d+)\](.*)$/;

/**
 * 合併後の組の問題を要件へ帰属させる（純粋。推測しない）。要件の位置（要求の一覧の `requirements[i]`）はその要件、場合の位置
 * （`cases[i]…`）はその場合の要件 ID、分類の位置（`classifications[i]…`）はその分類の要件 ID。ほかの位置（コードが作った試験・
 * 応答全体・添字の外・要件 ID の無い分類など）は帰属できない問題として返す
 */
export function attributeProblemsToRequirements(
  problems: readonly Problem[],
  output: TestCasesOutput,
  requestedIds: readonly string[],
): RequirementAttributedProblems {
  const grouped = new Map<string, Problem[]>();
  const unattributed: Problem[] = [];
  const classifications = Array.isArray(output.classifications) ? (output.classifications as readonly unknown[]) : [];
  for (const problem of problems) {
    const match = POSITION.exec(problem.field);
    const [, head = "", at = "", rest = ""] = match ?? [];
    const index = Number(at);
    const id =
      match === null
        ? undefined
        : head === "requirements"
          ? rest === ""
            ? requestedIds[index]
            : undefined
          : head === "cases"
            ? output.cases[index]?.requirementId
            : classificationIdOf(classifications[index]);
    if (id === undefined) {
      unattributed.push(problem);
      continue;
    }
    const list = grouped.get(id) ?? [];
    list.push(problem);
    grouped.set(id, list);
  }
  const byRequirement = new Map<string, readonly Problem[]>();
  for (const id of requestedIds) {
    const list = grouped.get(id);
    if (list !== undefined) byRequirement.set(id, list);
  }
  for (const [id, list] of grouped) if (!byRequirement.has(id)) byRequirement.set(id, list);
  return { byRequirement, unattributed };
}

/** 束 1 つの中身のやり直しの単位（書き直す要件・保持した要件・その要件の前回の場合と問題。位置は書き直す要件の並びへ写す） */
export interface BundleRetryPlan {
  /** 書き直す要件（問題の帰属した、この束の要件。束の中の順。要求の一覧・確かめ方・所属・分類の完全性の対象） */
  readonly rewrite: readonly string[];
  /** 保持した要件（束の残り。束の中の順） */
  readonly retained: readonly string[];
  /**
   * 前回の出力から捨てて書き直させる要件 ID（書き直す要件と、この束が書いた一覧に無い要件〔コードの試験だけで確かめる要件〕の
   * うち問題の帰属したもの）
   */
  readonly discard: readonly string[];
  /** 捨てる要件の前回の場合（展開前の形。合併の順） */
  readonly cases: readonly TestCase[];
  /** 捨てる要件の問題（位置は `requirements[書き直す要件の添字]`・`cases[前回の場合の添字]`・`classifications[捨てる分類の添字]`） */
  readonly problems: readonly Problem[];
}

/**
 * 要件へ帰属させた問題から、束ごとの中身のやり直しの単位を作る（純粋）。束は帰属した要件を含む束だけ。要求の一覧に無い要件 ID
 * （束の形の検査が断らない、コードの試験だけで確かめる要件）の場合・分類の問題は、それを書いた束（合併の出どころ）へ渡す。
 * 問題は捨てる要件の順・要件の中は入力の順で、位置を書き直す要件の並び（要件・前回の場合・前回の分類）の添字へ写す
 */
export function bundleRetryPlansOf(
  attributed: ReadonlyMap<string, readonly Problem[]>,
  merged: MergedTestCases,
  bundles: readonly (readonly string[])[],
): ReadonlyMap<number, BundleRetryPlan> {
  const classifications = Array.isArray(merged.output.classifications) ? (merged.output.classifications as readonly unknown[]) : [];
  const bundled = new Set(bundles.flat());
  const plans = new Map<number, BundleRetryPlan>();
  bundles.forEach((ids, bundle) => {
    const rewrite = ids.filter((id) => attributed.has(id));
    // 一覧に無い要件 ID は、その問題の位置（場合・分類）をこの束が書いたときだけ、この束で捨てて書き直させる
    const foreign = new Set<string>();
    for (const [id, list] of attributed) {
      if (bundled.has(id)) continue;
      for (const problem of list) {
        const [, head = "", at = ""] = POSITION.exec(problem.field) ?? [];
        const origin = head === "cases" ? merged.caseOrigin[Number(at)] : head === "classifications" ? merged.classificationOrigin[Number(at)] : undefined;
        if (origin?.[0] === bundle) foreign.add(id);
      }
    }
    const discard = [...rewrite, ...[...attributed.keys()].filter((id) => foreign.has(id))];
    if (discard.length === 0) return;
    const discarded = new Set(discard);
    const caseAt = new Map<number, number>();
    const cases: TestCase[] = [];
    merged.output.cases.forEach((entry, index) => {
      if (!discarded.has(entry.requirementId) || merged.caseOrigin[index]?.[0] !== bundle) return;
      caseAt.set(index, cases.length);
      cases.push(entry);
    });
    const classificationAt = new Map<number, number>();
    classifications.forEach((entry, index) => {
      const id = classificationIdOf(entry);
      if (id !== undefined && discarded.has(id) && merged.classificationOrigin[index]?.[0] === bundle) {
        classificationAt.set(index, classificationAt.size);
      }
    });
    const problems = discard.flatMap((id) =>
      (attributed.get(id) ?? []).flatMap((problem) => {
        const [, head = "", at = "", rest = ""] = POSITION.exec(problem.field) ?? [];
        if (head === "requirements") return [{ ...problem, field: `requirements[${String(rewrite.indexOf(id))}]` }];
        const local = head === "cases" ? caseAt.get(Number(at)) : classificationAt.get(Number(at));
        // 一覧に無い要件 ID の問題は、それを書いた束にだけ渡す（ほかの束が書いた同じ要件 ID の位置は渡さない）
        return local === undefined ? [] : [{ ...problem, field: `${head}[${String(local)}]${rest}` }];
      }),
    );
    plans.set(bundle, { rewrite, retained: ids.filter((id) => !discarded.has(id)), discard, cases, problems });
  });
  return plans;
}

/**
 * 保持した要件の前回の分類と場合（値・observes・参照の行・順を変えない）に、書き直した要件の新しい応答を重ねた束の出力。
 * 前回の分類と場合のうち捨てる要件（`discard`）のものだけを除き、新しい応答はそのまま足す（並べ替えは合併が要件の一覧の順で行う）
 */
export function retainedBundleOutput(previous: TestCasesOutput, discard: readonly string[], answer: TestCasesOutput): TestCasesOutput {
  const discarded = new Set(discard);
  const keep = (id: string | undefined): boolean => id === undefined || !discarded.has(id);
  const previousClassifications = Array.isArray(previous.classifications) ? (previous.classifications as readonly unknown[]) : [];
  const answerClassifications = Array.isArray(answer.classifications) ? (answer.classifications as readonly unknown[]) : [];
  return {
    classifications: [...previousClassifications.filter((entry) => keep(classificationIdOf(entry))), ...answerClassifications],
    cases: [...previous.cases.filter((entry) => keep(entry.requirementId)), ...answer.cases],
  };
}
