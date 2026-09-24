// 文法の正本（規則の表）と実装を、**規則単位で**突き合わせる照合テスト（Issue #213）。
//
// 正本は `packages/appspec-schema/contract/rules.md`（規則の表）と `expression-grammar.md`（EBNF。優先順位と
// 結合則）、`app-spec.schema.json`（構造。別の Issue #211）である。ここが見るのは**規則の表の期待値**である
// ——正例・負例・境界を、静的チェック（`checkSpec`）と式の検査（`readExpression` / `analyzeExpression`）、
// 評価（`evaluateRecord`）に通す。
//
// 期待値は**表から書き写した**（実装から生成しない）。表の `expr: E ⇒ …` は式の検査、`eval: E ⇒ value=V` は
// 評価、`set P = V` と `add` は宣言（`FIXTURE` / `MIN` の 1 か所を差し替えたもの）の検査である。
//
// **規則の表の全規則に 1 件以上あることを、この file 自身が確かめる**（末尾の「網羅」）。
// 負例は 1 つの規則だけを破るように選ぶ（表 §0）。だから期待値は**その case で返るコードの全体**である
// ——集合として比べる（同じコードが 2 回出ることはある）。
//
// 不一致が見つかったら、期待値も実装も直さずに止めて窓口へ返す（`06` §2.2）。この file は緑であることを
// 要求する——赤のまま期待値を緩めない。
import { describe, expect, it } from "vitest";
import { APPSPEC_SCHEMA_VERSION, type NormalizedAppSpec } from "@musunest/appspec-schema";
import { CONTRACT_DIR, packageFile } from "@musunest/appspec-schema/files";
import { checkSpec } from "./check.js";
import { fixedClock } from "./clock.js";
import { evaluateRecord, type Evaluation } from "./evaluate.js";
import { analyzeExpression, readExpression, type ExpressionScope, type SpecType } from "./expression.js";

// ── 読み取りの道具（Node 側） ──────────────────────────────────────
//
// tsconfig の types は workers-types と node の両方を読み、グローバルの URL の型が食い違う
// （contract-structure.test.ts・check.test.ts と同じやり方）。
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;
const readText = (url: URL): string => fs.readFileSync(url, "utf8");

// ── §1 の参照の fixture（`FIXTURE` と `MIN`） ───────────────────────
//
// rules.md §1 のままの文字列である。期待値を「実装から生成」しないため、ここは原文の写しにする。
const FIXTURE = [
  "entities:",
  "  - name: member",
  "    fields:",
  "      name: string",
  "  - name: expense",
  "    fields:",
  "      description: string",
  "      amount: number",
  "      discount: number",
  "      payer:",
  "        type: ref",
  "        to: member",
  "      participants:",
  "        type: list",
  "        of: member",
  "      spentOn: date",
  "      kind:",
  "        type: enum",
  "        options:",
  "          food: 食べ物",
  "          travel: 移動",
  "        default: food",
  "views:",
  "  - name: expenseList",
  "    type: table",
  "    entity: expense",
  "  - name: memberList",
  "    entity: member",
  "  - name: dashboard",
  "    type: dashboard",
  "    widgets:",
  "      - type: number",
  "        value: expenseCount",
  "        unit: 件",
  "actions:",
  "  - name: addExpense",
  "    entity: expense",
  "  - name: editExpense",
  "    entity: expense",
  "    kind: update",
  "validations:",
  "  - name: positiveAmount",
  "    entity: expense",
  "    expression: amount > 0",
  "computed:",
  "  - name: paidAmount",
  "    entity: expense",
  "    type: number",
  "    expression: amount - discount",
  "  - name: headcount",
  "    entity: expense",
  "    type: number",
  "    expression: len(participants)",
  "  - name: overdue",
  "    entity: expense",
  "    type: boolean",
  "    expression: spentOn < today()",
  "  - name: expenseCount",
  "    scope: app",
  "    type: number",
  "    aggregate:",
  "      count: expense",
  "  - name: expenseByKind",
  "    aggregate:",
  "      count: expense",
  "      groupBy: expense.kind",
  "    type: groups",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const MIN = [
  "entities: []",
  "views: []",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

// ── 差し替え（`set P = V`） ────────────────────────────────────────
//
// 文字列の 1 か所を置き換える。**見つからなければ落ち、2 回以上あれば落ちる**——黙って別の場所を
// 触ると、測っているものが変わる。表の `set` をこの形で書く。
type Edit = readonly [find: string, replace: string];

function mutate(base: string, edits: readonly Edit[]): string {
  let text = base;
  for (const [find, replace] of edits) {
    const first = text.indexOf(find);
    if (first < 0) throw new Error(`差し替えの目印が見つからない: ${JSON.stringify(find)}`);
    if (text.indexOf(find, first + find.length) >= 0) {
      throw new Error(`差し替えの目印が 2 回以上ある: ${JSON.stringify(find)}`);
    }
    text = text.slice(0, first) + replace + text.slice(first + find.length);
  }
  return text;
}

interface SpecCase {
  readonly rule: string;
  readonly what: string;
  readonly base: string;
  readonly edits?: readonly Edit[];
  /** 期待するコードの全体（空なら OK＝診断なし） */
  readonly codes: readonly string[];
}

function specCodes(base: string, edits: readonly Edit[] = []): { ok: boolean; codes: readonly string[] } {
  const result = checkSpec(mutate(base, edits));
  return { ok: result.ok, codes: result.diagnostics.map((diagnostic) => diagnostic.code) };
}

// ── 式の検査（`expr: E ⇒ …`） ──────────────────────────────────────
//
// §1 の Γ（entity `expense` の名前 → 型）。表の Γ をそのまま写す。`entityName` は、`.` を使った参照を
// 断れるように、宣言にある entity の名前を返す（`expense`・`member`）。
const GAMMA_TYPES: Readonly<Record<string, SpecType>> = {
  amount: "number",
  discount: "number",
  description: "string",
  spentOn: "date",
  participants: "list",
  payer: "string",
  kind: "string",
  paidAmount: "number",
  headcount: "number",
  overdue: "boolean",
};

const GAMMA: ExpressionScope = {
  resolveName: (name) => GAMMA_TYPES[name] ?? null,
  entityName: (name) => (name === "expense" || name === "member" ? name : null),
};

interface ExprCase {
  readonly rule: string;
  readonly what: string;
  readonly expression: string;
  /** OK のときの型（`type=` の期待値） */
  readonly type?: SpecType;
  /** コードが返る場合の期待値（全体） */
  readonly codes?: readonly string[];
}

function expressionResult(expression: string): { type: SpecType | null; codes: readonly string[] } {
  const read = readExpression(expression);
  if (!read.ok) return { type: null, codes: read.problems.map((problem) => problem.code) };
  const analysis = analyzeExpression(read.ast, GAMMA);
  return { type: analysis.type, codes: analysis.problems.map((problem) => problem.code) };
}

// ── 評価（`eval: E ⇒ value=V`） ────────────────────────────────────
//
// 関数の定義（正本）と時計を差し込んで、1 件のレコードで式を解く。宣言は**手で組む**——上限を超えた式は
// 静的チェックを通らないので、評価側だけを見るには検査済みの成果物を直接渡すしかない（evaluate.ts の注記）。
const CLOCK = fixedClock("2026-09-16T12:00:00+09:00");

function evaluateApp(
  parts: {
    readonly computed?: readonly { readonly name: string; readonly expression: string }[];
    readonly validations?: readonly { readonly name: string; readonly expression: string }[];
  },
  record: Readonly<Record<string, unknown>> = {},
): Evaluation {
  const app: NormalizedAppSpec = {
    schemaVersion: APPSPEC_SCHEMA_VERSION,
    sourceSha256: "0".repeat(64),
    spec: {
      entities: [{ name: "expense", fields: { amount: "number", discount: "number" } }],
      views: [],
      actions: [],
      validations: (parts.validations ?? []).map((entry) => ({
        name: entry.name,
        entity: "expense",
        expression: entry.expression,
      })),
      computed: (parts.computed ?? []).map((entry) => ({
        name: entry.name,
        entity: "expense",
        type: "number" as const,
        expression: entry.expression,
      })),
      permissions: [],
      minIdentity: { mode: "anonymous" },
    },
  };
  return evaluateRecord({ app, entity: "expense", record, clock: CLOCK });
}

const probeValue = (expression: string, record: Readonly<Record<string, unknown>> = {}): number | null =>
  evaluateApp({ computed: [{ name: "probe", expression }] }, record).computed["probe"] ?? null;

/** 式を、ちょうど `n` 文字になるまで空白で埋める（rules.md §4 の `pad`） */
const pad = (expression: string, n: number): string => expression + " ".repeat(n - expression.length);

/**
 * `1` を `min(…, 1)` で `k - 1` 回包む（rules.md §4 の `deep`。深さがちょうど `k` になる）。
 * `deep(8)` は `min(` を 7 つ持ち、深さは 8 である——上限（8）を超えない最後の点になる。
 */
function deep(k: number): string {
  let text = "1";
  for (let index = 0; index < k - 1; index += 1) text = `min(${text}, 1)`;
  return text;
}

/** 葉を `leaves` 個持つ、釣り合った `+` の木（rules.md §4 の `tree`。節の数は `2 * leaves - 1`） */
function tree(leaves: number): string {
  if (leaves === 1) return "1";
  const half = leaves / 2;
  return `(${tree(half)} + ${tree(half)})`;
}

// ── 規則ごとの case ────────────────────────────────────────────────

const specCases: readonly SpecCase[] = [
  // ── §2 値の型（R-TYPE） ──────────────────────────────────────
  {
    rule: "R-TYPE-07",
    what: "boolean を式で作って計算の型に合わせられる（正例）",
    base: FIXTURE,
    edits: [["    expression: spentOn < today()", "    expression: amount > 0"]],
    codes: [],
  },
  {
    rule: "R-TYPE-10",
    what: "行の計算の結果の型が type と食い違う（負例）",
    base: FIXTURE,
    edits: [["  - name: overdue\n    entity: expense\n    type: boolean", "  - name: overdue\n    entity: expense\n    type: number"]],
    codes: ["LOGIC_COMPUTED_TYPE_MISMATCH"],
  },
  {
    rule: "R-TYPE-10",
    what: "boolean の計算は type: boolean なら通る（境界）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-TYPE-11",
    what: "検査の式が真偽なら通る（正例）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: amount == 0"]],
    codes: [],
  },
  {
    rule: "R-TYPE-11",
    what: "検査の式が数になる（負例）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: amount"]],
    codes: ["LOGIC_VALIDATION_NOT_BOOLEAN"],
  },
  {
    rule: "R-TYPE-11",
    what: "境界 `amount >= 0` は真偽である",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: amount >= 0"]],
    codes: [],
  },
  {
    rule: "R-TYPE-12",
    what: "when が真偽なら通る（正例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    when: kind == \"food\"\n"]],
    codes: [],
  },
  {
    rule: "R-TYPE-12",
    what: "when が数になる（負例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    when: description\n"]],
    codes: ["LOGIC_ACTION_WHEN_NOT_BOOLEAN"],
  },
  {
    rule: "R-TYPE-12",
    what: "境界 `kind != \"food\"` も真偽である",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    when: kind != \"food\"\n"]],
    codes: [],
  },
  {
    rule: "R-TYPE-13",
    what: "set は項目の型に合う決まった値なら通る（正例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    set:\n      kind: food\n"]],
    codes: [],
  },
  {
    rule: "R-TYPE-13",
    what: "set に式は書けない（負例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    set:\n      amount: amount + 1\n"]],
    codes: ["LOGIC_ACTION_SET_NOT_CONSTANT"],
  },
  {
    rule: "R-TYPE-13",
    what: "set の enum は options のキーでなければならない（境界）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    set:\n      kind: nosuch\n"]],
    codes: ["LOGIC_ACTION_SET_TYPE_MISMATCH"],
  },
  {
    rule: "R-TYPE-13",
    what: "set に並び（list）は書けない（境界）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: update\n    set:\n      participants: x\n"]],
    codes: ["LOGIC_ACTION_SET_TYPE_MISMATCH"],
  },

  // ── §3 名前解決（R-NAME） ────────────────────────────────────
  {
    rule: "R-NAME-01",
    what: "同じ entity の項目と計算を裸の名前で参照できる（正例）",
    base: FIXTURE,
    edits: [["    expression: len(participants)", "    expression: amount + paidAmount"]],
    codes: [],
  },
  {
    rule: "R-NAME-01",
    what: "無い名前は見つからない（負例）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: ammount > 0"]],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-01",
    what: "別の entity の項目は見つからない（境界）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: name > 0"]],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-02",
    what: "`.` を使わない参照は書ける（正例）",
    base: FIXTURE,
    edits: [["    expression: len(participants)", "    expression: paidAmount + 1"]],
    codes: [],
  },
  {
    rule: "R-NAME-02",
    what: "`.` を使った参照は書けない（負例）",
    base: FIXTURE,
    edits: [["    expression: amount - discount", "    expression: expense.amount"]],
    codes: ["LOGIC_REFERENCE_OUT_OF_ENTITY"],
  },
  {
    rule: "R-NAME-02",
    what: "`.` の左が entity でなければ見つからない（境界）",
    base: FIXTURE,
    edits: [["    expression: amount - discount", "    expression: nosuch.x"]],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-03",
    what: "項目と重ならない計算の名前は通る（正例）",
    base: FIXTURE,
    edits: [["  - name: paidAmount\n    entity: expense\n    type: number", "  - name: total\n    entity: expense\n    type: number"]],
    codes: [],
  },
  {
    rule: "R-NAME-03",
    what: "計算の名前が同じ entity の項目と重なる（負例）",
    base: FIXTURE,
    edits: [["  - name: paidAmount\n    entity: expense\n    type: number", "  - name: amount\n    entity: expense\n    type: number"]],
    codes: ["LOGIC_COMPUTED_NAME_CONFLICT"],
  },
  {
    rule: "R-NAME-03",
    what: "計算の名前が別の計算と重なる（境界）",
    base: FIXTURE,
    edits: [["  - name: headcount\n    entity: expense\n    type: number", "  - name: paidAmount\n    entity: expense\n    type: number"]],
    codes: ["LOGIC_COMPUTED_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-04",
    what: "参照の先を辿っても循環しない（正例）",
    base: FIXTURE,
    edits: [["    expression: len(participants)", "    expression: paidAmount"]],
    codes: [],
  },
  {
    rule: "R-NAME-04",
    what: "計算どうしが互いを参照する（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: a\n    entity: expense\n    type: number\n    expression: b\n  - name: b\n    entity: expense\n    type: number\n    expression: a\n"]],
    codes: ["LOGIC_COMPUTED_CYCLE"],
  },
  {
    rule: "R-NAME-04",
    what: "自分自身を参照する（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: loop\n    entity: expense\n    type: number\n    expression: loop + 1\n"]],
    codes: ["LOGIC_COMPUTED_CYCLE"],
  },
  {
    rule: "R-NAME-05",
    what: "enum の項目と options のキーを比べる（正例）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: kind == \"food\""]],
    codes: [],
  },
  {
    rule: "R-NAME-05",
    what: "options に無いキーと比べる（負例）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: kind == \"todu\""]],
    codes: ["LOGIC_ENUM_KEY_NOT_FOUND"],
  },
  {
    rule: "R-NAME-05",
    what: "`!=` でも options に無いキーは断る（境界）",
    base: FIXTURE,
    edits: [["    expression: amount > 0", "    expression: kind != \"nope\""]],
    codes: ["LOGIC_ENUM_KEY_NOT_FOUND"],
  },
  {
    rule: "R-NAME-06",
    what: "app の式から別の app の計算を参照できる（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: doubleCount\n    scope: app\n    type: number\n    expression: expenseCount * 2\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-06",
    what: "app の式から行の計算は見えない（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: badApp\n    scope: app\n    type: number\n    expression: paidAmount\n"]],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-06",
    what: "app の式でも `.` は書けない（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: badApp\n    scope: app\n    type: number\n    expression: expense.amount\n"]],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-07",
    what: "label を付けても識別子で参照できる（正例）",
    base: FIXTURE,
    edits: [
      ["  - name: paidAmount\n    entity: expense\n    type: number\n", "  - name: paidAmount\n    entity: expense\n    type: number\n    label: 支払額\n"],
      ["    expression: len(participants)", "    expression: paidAmount + 1"],
    ],
    codes: [],
  },
  {
    rule: "R-NAME-07",
    what: "label は名前として解決しない（負例）",
    base: FIXTURE,
    edits: [
      ["  - name: paidAmount\n    entity: expense\n    type: number\n", "  - name: paidAmount\n    entity: expense\n    type: number\n    label: total\n"],
      ["    expression: len(participants)", "    expression: total"],
    ],
    codes: ["LOGIC_REFERENCE_NOT_FOUND"],
  },
  {
    rule: "R-NAME-07",
    what: "label が実在の識別子と同じでも、参照は識別子で解決する（境界）",
    base: FIXTURE,
    edits: [
      ["  - name: paidAmount\n    entity: expense\n    type: number\n", "  - name: paidAmount\n    entity: expense\n    type: number\n    label: amount\n"],
      ["    expression: len(participants)", "    expression: amount"],
    ],
    codes: [],
  },
  {
    rule: "R-NAME-08",
    what: "名前が重ならなければ通る（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-NAME-08",
    what: "entity の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["\nviews:\n", "\n  - name: expense\n    fields:\n      x: string\nviews:\n"]],
    codes: ["DATA_ENTITY_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "同じ entity の項目の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      amount: number\n      spentOn: date"]],
    codes: ["DATA_FIELD_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "計算の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: paidAmount\n    entity: expense\n    type: number\n    expression: 1\n"]],
    codes: ["LOGIC_COMPUTED_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "検査の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["validations:\n", "validations:\n  - name: positiveAmount\n    entity: expense\n    expression: amount > 0\n"]],
    codes: ["LOGIC_VALIDATION_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "一覧の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["views:\n", "views:\n  - name: expenseList\n    entity: expense\n"]],
    codes: ["UI_VIEW_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "操作の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["actions:\n", "actions:\n  - name: addExpense\n    entity: expense\n"]],
    codes: ["LOGIC_ACTION_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "権限の名前が重なる（負例）",
    base: FIXTURE,
    edits: [["permissions:\n", "permissions:\n  - name: read\n    subject: minIdentity\n"]],
    codes: ["PERMISSION_DUPLICATE_NAME"],
  },
  {
    rule: "R-NAME-08",
    what: "順位の部品の鍵が重なる（境界）",
    base: FIXTURE,
    edits: [
      [
        "    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n",
        "    widgets:\n      - type: ranking\n        name: top\n        entity: expense\n        by: paidAmount\n        show: [description, paidAmount]\n      - type: ranking\n        name: top\n        entity: expense\n        by: paidAmount\n        show: [description, paidAmount]\n",
      ],
    ],
    codes: ["UI_RANKING_NAME_DUPLICATE"],
  },
  {
    rule: "R-NAME-09",
    what: "集計の対象が数の項目なら通る（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: sumAmt\n    scope: app\n    type: number\n    aggregate:\n      sum: expense.amount\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-09",
    what: "集計の対象の entity が無い（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: sumAmt\n    scope: app\n    type: number\n    aggregate:\n      sum: expence.amount\n"]],
    codes: ["LOGIC_AGGREGATE_TARGET_NOT_FOUND"],
  },
  {
    rule: "R-NAME-09",
    what: "集計の対象が数でない（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: sumText\n    scope: app\n    type: number\n    aggregate:\n      sum: expense.description\n"]],
    codes: ["LOGIC_AGGREGATE_TARGET_NOT_NUMBER"],
  },
  {
    rule: "R-NAME-10",
    what: "where が参照の一致なら通る（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: myExpenses\n    entity: member\n    type: number\n    aggregate:\n      count: expense\n      where:\n        payer: this\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-10",
    what: "where が参照でない項目を指す（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: bad\n    entity: member\n    type: number\n    aggregate:\n      count: expense\n      where:\n        amount: this\n"]],
    codes: ["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"],
  },
  {
    rule: "R-NAME-10",
    what: "app の集計に this は書けない（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: badApp\n    scope: app\n    type: number\n    aggregate:\n      count: expense\n      where:\n        payer: this\n"]],
    codes: ["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"],
  },
  {
    rule: "R-NAME-11",
    what: "within が今月を指すなら通る（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: thisMonth\n    scope: app\n    type: number\n    aggregate:\n      count: expense\n      where:\n        spentOn:\n          within: this_month\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-11",
    what: "語彙に無い期間は断る（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: bad\n    scope: app\n    type: number\n    aggregate:\n      count: expense\n      where:\n        spentOn:\n          within: last_week\n"]],
    codes: ["LOGIC_AGGREGATE_WHERE_PERIOD_NOT_ALLOWED"],
  },
  {
    rule: "R-NAME-11",
    what: "within は date の項目だけを指せる（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: bad\n    scope: app\n    type: number\n    aggregate:\n      count: expense\n      where:\n        amount:\n          within: this_month\n"]],
    codes: ["LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH"],
  },
  {
    rule: "R-NAME-12",
    what: "groupBy が enum の項目なら通る（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: byKind\n    type: groups\n    aggregate:\n      count: expense\n      groupBy: expense.kind\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-12",
    what: "groupBy が分けられない型を指す（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: byAmount\n    type: groups\n    aggregate:\n      count: expense\n      groupBy: expense.amount\n"]],
    codes: ["LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE"],
  },
  {
    rule: "R-NAME-12",
    what: "月で分けないのに last を書く（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: byKind\n    type: groups\n    aggregate:\n      count: expense\n      groupBy: expense.kind\n      last: 3\n"]],
    codes: ["LOGIC_AGGREGATE_FORM_INVALID"],
  },
  {
    rule: "R-NAME-13",
    what: "順位の by が行の数の計算で、show に含まれる（正例）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: topExpenses\n        entity: expense\n        by: paidAmount\n        show: [description, paidAmount]\n"]],
    codes: [],
  },
  {
    rule: "R-NAME-13",
    what: "順位の by が app の集計を指す（負例）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: topExpenses\n        entity: expense\n        by: expenseCount\n        show: [description]\n"]],
    codes: ["UI_RANKING_BY_NOT_ROW_VALUE"],
  },
  {
    rule: "R-NAME-13",
    what: "順位の by が show に無い（境界）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: topExpenses\n        entity: expense\n        by: paidAmount\n        show: [description]\n"]],
    codes: ["UI_RANKING_BY_NOT_SHOWN"],
  },

  // ── §4 上限（R-LIMIT。01〜03 は式の検査、04 は評価、05〜06 は宣言） ──
  {
    rule: "R-LIMIT-05",
    what: "月で分ける集計に last を書ける（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: expenseByMonth\n    type: groups\n    aggregate:\n      count: expense\n      groupBy:\n        month: expense.spentOn\n      last: 3\n"]],
    codes: [],
  },
  {
    rule: "R-LIMIT-05",
    what: "last は 1 以上（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: expenseByMonth\n    type: groups\n    aggregate:\n      count: expense\n      groupBy:\n        month: expense.spentOn\n      last: 0\n"]],
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-LIMIT-05",
    what: "last: 1 は通る（境界・最小）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: expenseByMonth\n    type: groups\n    aggregate:\n      count: expense\n      groupBy:\n        month: expense.spentOn\n      last: 1\n"]],
    codes: [],
  },
  {
    rule: "R-LIMIT-05",
    what: "last を省いても通る（境界・既定 6）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: expenseByMonth\n    type: groups\n    aggregate:\n      count: expense\n      groupBy:\n        month: expense.spentOn\n"]],
    codes: [],
  },
  {
    rule: "R-LIMIT-06",
    what: "順位の limit を書ける（正例）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: top\n        entity: expense\n        by: paidAmount\n        show: [paidAmount]\n        limit: 3\n"]],
    codes: [],
  },
  {
    rule: "R-LIMIT-06",
    what: "limit は 1 以上（負例）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: top\n        entity: expense\n        by: paidAmount\n        show: [paidAmount]\n        limit: 0\n"]],
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-LIMIT-06",
    what: "limit: 1 は通る（境界・最小）",
    base: FIXTURE,
    edits: [["    widgets:\n      - type: number\n        value: expenseCount\n        unit: 件\n", "    widgets:\n      - type: ranking\n        name: top\n        entity: expense\n        by: paidAmount\n        show: [paidAmount]\n        limit: 1\n"]],
    codes: [],
  },

  // ── §5 予約語（R-RESERVED） ──────────────────────────────────
  {
    rule: "R-RESERVED-01",
    what: "予約語でない項目名は通る（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-RESERVED-01",
    what: "項目名に createdAt を使う（負例）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      createdAt: string"]],
    codes: ["DATA_FIELD_NAME_RESERVED"],
  },
  {
    rule: "R-RESERVED-01",
    what: "項目名に updatedAt を使う（境界）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      updatedAt: string"]],
    codes: ["DATA_FIELD_NAME_RESERVED"],
  },
  {
    rule: "R-RESERVED-02",
    what: "予約語でない計算の名前は通る（正例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: total\n    entity: expense\n    type: number\n    expression: amount\n"]],
    codes: [],
  },
  {
    rule: "R-RESERVED-02",
    what: "計算の名前に updatedAt を使う（負例）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: updatedAt\n    entity: expense\n    type: number\n    expression: amount\n"]],
    codes: ["LOGIC_COMPUTED_NAME_RESERVED"],
  },
  {
    rule: "R-RESERVED-02",
    what: "計算の名前に id を使う（境界）",
    base: FIXTURE,
    edits: [["computed:\n", "computed:\n  - name: id\n    entity: expense\n    type: number\n    expression: amount\n"]],
    codes: ["LOGIC_COMPUTED_NAME_RESERVED"],
  },

  // ── §6 閉じた語彙（R-VOCAB） ─────────────────────────────────
  {
    rule: "R-VOCAB-01",
    what: "知っている欄だけなら通る（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-VOCAB-01",
    what: "知らない欄を書く（負例）",
    base: FIXTURE,
    edits: [["minIdentity:\n  mode: anonymous\n", "minIdentity:\n  mode: anonymous\n  foo: 1\n"]],
    codes: ["SHAPE_KEY_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-01",
    what: "知らない最上位の欄を書く（境界）",
    base: MIN,
    edits: [["minIdentity:\n  mode: anonymous\n", "minIdentity:\n  mode: anonymous\napp:\n  x: y\n"]],
    codes: ["SHAPE_KEY_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-02",
    what: "7 欄すべて書いてあれば通る（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-VOCAB-02",
    what: "欄が無い（負例）",
    base: MIN,
    edits: [["entities: []\n", ""]],
    codes: ["SHAPE_KEY_MISSING"],
  },
  {
    rule: "R-VOCAB-02",
    what: "minIdentity が無い（境界）",
    base: MIN,
    edits: [["minIdentity:\n  mode: anonymous\n", ""]],
    codes: ["SHAPE_KEY_MISSING"],
  },
  {
    rule: "R-VOCAB-03",
    what: "同じ欄が 2 回ある（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: anonymous\n  mode: anonymous\n"]],
    codes: ["SHAPE_KEY_DUPLICATE"],
  },
  {
    rule: "R-VOCAB-03",
    what: "最上位の欄が 2 回ある（境界）",
    base: MIN,
    edits: [["views: []\n", "views: []\nviews: []\n"]],
    codes: ["SHAPE_KEY_DUPLICATE"],
  },
  {
    rule: "R-VOCAB-04",
    what: "7 欄ちょうどなら通る（正例）",
    base: MIN,
    codes: [],
  },
  {
    rule: "R-VOCAB-04",
    what: "欄が欠ける（負例）",
    base: MIN,
    edits: [["computed: []\n", ""]],
    codes: ["SHAPE_KEY_MISSING"],
  },
  {
    rule: "R-VOCAB-04",
    what: "8 つ目の欄を足す（境界）",
    base: MIN,
    edits: [["minIdentity:\n  mode: anonymous\n", "minIdentity:\n  mode: anonymous\nextra: []\n"]],
    codes: ["SHAPE_KEY_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-05",
    what: "中身が無い欄は [] と書く（正例）",
    base: MIN,
    codes: [],
  },
  {
    rule: "R-VOCAB-05",
    what: "欄に値が無い（負例）",
    base: MIN,
    edits: [["validations: []\n", "validations:\n"]],
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-VOCAB-05",
    what: "欄を写像で書く（境界）",
    base: MIN,
    edits: [["validations: []\n", "validations:\n  a: b\n"]],
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-VOCAB-06",
    what: "項目の型は 1 語で書ける（正例）",
    base: FIXTURE,
    edits: [["      discount: number", "      discount: number\n      count: number"]],
    codes: [],
  },
  {
    rule: "R-VOCAB-06",
    what: "知らない項目の型（負例）",
    base: FIXTURE,
    edits: [["      amount: number", "      amount: integer"]],
    codes: ["DATA_FIELD_TYPE_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-06",
    what: "boolean は項目の型ではない（境界）",
    base: FIXTURE,
    edits: [["      amount: number", "      amount: boolean"]],
    codes: ["DATA_FIELD_TYPE_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-07",
    what: "kind に delete を書ける（正例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n    kind: delete\n"]],
    codes: [],
  },
  {
    rule: "R-VOCAB-07",
    what: "kind を省くと create として読む（正例）",
    base: FIXTURE,
    edits: [["  - name: editExpense\n    entity: expense\n    kind: update\n", "  - name: editExpense\n    entity: expense\n"]],
    codes: [],
  },
  {
    rule: "R-VOCAB-07",
    what: "知らない kind（負例）",
    base: FIXTURE,
    edits: [["    kind: update\n", "    kind: patch\n"]],
    codes: ["LOGIC_ACTION_KIND_NOT_ALLOWED"],
  },
  {
    rule: "R-VOCAB-08",
    what: "view の type は table（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-VOCAB-08",
    what: "知らない view の type（負例）",
    base: FIXTURE,
    edits: [["    type: table\n", "    type: button\n"]],
    codes: ["SHAPE_KEY_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-08",
    what: "知らない部品の type（境界）",
    base: FIXTURE,
    edits: [["      - type: number\n        value: expenseCount\n        unit: 件\n", "      - type: chart\n        value: expenseCount\n        unit: 件\n"]],
    codes: ["SHAPE_KEY_UNKNOWN"],
  },
  {
    rule: "R-VOCAB-09",
    what: "権限の語彙は閉じている（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-VOCAB-09",
    what: "知らない権限の名前（負例）",
    base: FIXTURE,
    edits: [["  - name: read\n", "  - name: admin\n"]],
    codes: ["PERMISSION_NAME_NOT_ALLOWED"],
  },
  {
    rule: "R-VOCAB-09",
    what: "知らない subject（境界）",
    base: FIXTURE,
    edits: [["  - name: read\n    subject: minIdentity\n", "  - name: read\n    subject: owner\n"]],
    codes: ["PERMISSION_SUBJECT_NOT_ALLOWED"],
  },
  {
    rule: "R-VOCAB-09",
    what: "知らない本人確認の mode（境界）",
    base: FIXTURE,
    edits: [["  mode: anonymous\n", "  mode: google\n"]],
    codes: ["PERMISSION_IDENTITY_MODE_NOT_ALLOWED"],
  },
  {
    rule: "R-VOCAB-11",
    what: "英字で始まる名前は通る（正例）",
    base: MIN,
    edits: [["entities: []\n", "entities:\n  - name: e1\n    fields:\n      a: string\n"]],
    codes: [],
  },
  {
    rule: "R-VOCAB-11",
    what: "数字で始まる名前（負例）",
    base: MIN,
    edits: [["entities: []\n", "entities:\n  - name: 1e\n    fields:\n      a: string\n"]],
    codes: ["SHAPE_NAME_INVALID"],
  },
  {
    rule: "R-VOCAB-11",
    what: "英字で始まらない名前（境界）",
    base: MIN,
    edits: [["entities: []\n", "entities:\n  - name: _e\n    fields:\n      a: string\n"]],
    codes: ["SHAPE_NAME_INVALID"],
  },
  {
    rule: "R-VOCAB-12",
    what: "enum は options と default を持つ（正例）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      status:\n        type: enum\n        options:\n          a: A\n        default: a"]],
    codes: [],
  },
  {
    rule: "R-VOCAB-12",
    what: "options が空（負例）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      status:\n        type: enum\n        options:"]],
    codes: ["DATA_FIELD_ENUM_OPTIONS_EMPTY"],
  },
  {
    rule: "R-VOCAB-12",
    what: "options のキーが重なる（負例）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      status:\n        type: enum\n        options:\n          a: A\n          a: B\n"]],
    codes: ["DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE"],
  },
  {
    rule: "R-VOCAB-12",
    what: "default が options に無い（境界）",
    base: FIXTURE,
    edits: [["      spentOn: date", "      spentOn: date\n      status:\n        type: enum\n        options:\n          a: A\n        default: b\n"]],
    codes: ["DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS"],
  },
  {
    rule: "R-VOCAB-13",
    what: "参照先の entity が実在する（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-VOCAB-13",
    what: "参照先の entity が無い（負例）",
    base: FIXTURE,
    edits: [["        to: member\n", "        to: menber\n"]],
    codes: ["DATA_REF_TARGET_NOT_FOUND"],
  },
  {
    rule: "R-VOCAB-13",
    what: "`of` の無い list は文字列の並び（境界）",
    base: FIXTURE,
    edits: [["      participants:\n        type: list\n        of: member\n", "      participants: list\n"]],
    codes: [],
  },

  // ── §7 YAML の読み取り（R-YAML） ─────────────────────────────
  {
    rule: "R-YAML-01",
    what: "写像と並びを読む（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-YAML-01",
    what: "最上位が並びである（負例）",
    base: "- a\n",
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-YAML-01",
    what: "欄の形でも並びの形でもない行（境界）",
    base: MIN,
    edits: [["views: []\n", "views: []\njustText\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-02",
    what: "1 行の並びを読む（正例）",
    base: FIXTURE,
    edits: [["  - name: expenseList\n    type: table\n    entity: expense\n", "  - name: expenseList\n    type: table\n    entity: expense\n    show: [description, amount]\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-02",
    what: "閉じていない並び（負例）",
    base: FIXTURE,
    edits: [["  - name: expenseList\n    type: table\n    entity: expense\n", "  - name: expenseList\n    type: table\n    entity: expense\n    show: [description\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-02",
    what: "空の並びは書ける（境界）",
    base: FIXTURE,
    edits: [["  - name: expenseList\n    type: table\n    entity: expense\n", "  - name: expenseList\n    type: table\n    entity: expense\n    show: []\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-03",
    what: "値の後ろのコメントを落とす（正例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: anonymous # comment\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-03",
    what: "空白の後の # だけがコメント（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: anon#ymous\n"]],
    codes: ["PERMISSION_IDENTITY_MODE_NOT_ALLOWED"],
  },
  {
    rule: "R-YAML-03",
    what: "コメントだけの行は無視する（境界）",
    base: MIN,
    edits: [["entities: []\n", "# これはコメントである\nentities: []\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-04",
    what: "引用符つきのスカラを読む（正例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: \"anonymous\"\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-04",
    what: "閉じていない引用符（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: \"anonymous\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-04",
    what: "読み取れないエスケープ（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: \"a\\qb\"\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-04",
    what: "空文字は語彙の検査に回す（境界）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: \"\"\n"]],
    codes: ["SHAPE_VALUE_INVALID"],
  },
  {
    rule: "R-YAML-05",
    what: "すべてのスカラを文字列として読む（正例）",
    base: MIN,
    codes: [],
  },
  {
    rule: "R-YAML-05",
    what: "true は真偽ではなく文字列である（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: true\n"]],
    codes: ["PERMISSION_IDENTITY_MODE_NOT_ALLOWED"],
  },
  {
    rule: "R-YAML-05",
    what: "名前の場所の数は文字列として名前の検査に回す（境界）",
    base: MIN,
    edits: [["entities: []\n", "entities:\n  - name: 123\n    fields:\n      a: string\n"]],
    codes: ["SHAPE_NAME_INVALID"],
  },
  {
    rule: "R-YAML-06",
    what: "先頭の --- は 1 つだけ（正例）",
    base: MIN,
    edits: [["entities: []\n", "---\nentities: []\n"]],
    codes: [],
  },
  {
    rule: "R-YAML-06",
    what: "2 つ目の ---（負例）",
    base: MIN,
    edits: [["minIdentity:\n  mode: anonymous\n", "minIdentity:\n  mode: anonymous\n---\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-06",
    what: "... は読み取れない（負例）",
    base: MIN,
    edits: [["minIdentity:\n  mode: anonymous\n", "minIdentity:\n  mode: anonymous\n...\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "入れ子の写像は次の行に書く（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-YAML-07",
    what: "流れの写像は読まない（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: {a: 1}\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "アンカーは読まない（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: &a anonymous\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "別名は読まない（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: *a\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "タグは読まない（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: !m anonymous\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "ブロックの値は読まない（境界）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: |\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-07",
    what: "@ から始まる値は読まない（境界）",
    base: MIN,
    edits: [["  mode: anonymous\n", "  mode: @x\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-08",
    what: "空白で下げる（正例）",
    base: MIN,
    codes: [],
  },
  {
    rule: "R-YAML-08",
    what: "インデントにタブを使う（負例）",
    base: MIN,
    edits: [["  mode: anonymous\n", "\tmode: anonymous\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-09",
    what: "入れ子の写像を次の行に書く（正例）",
    base: FIXTURE,
    codes: [],
  },
  {
    rule: "R-YAML-09",
    what: "値に `: ` を含められない（負例）",
    base: FIXTURE,
    edits: [["      description: string", "      description: a: b"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-09",
    what: "参照も流れの形では書けない（負例）",
    base: FIXTURE,
    edits: [["      payer:\n        type: ref\n        to: member\n", "      payer: {type: ref, to: member}\n"]],
    codes: ["SHAPE_YAML_INVALID"],
  },
  {
    rule: "R-YAML-09",
    what: "引用符の中の `: ` と `#` は値として残る（境界）",
    base: FIXTURE,
    edits: [["  - name: paidAmount\n    entity: expense\n    type: number\n", "  - name: paidAmount\n    entity: expense\n    type: number\n    label: \"a: b # c\"\n"]],
    codes: [],
  },
];

const exprCases: readonly ExprCase[] = [
  // R-TYPE-01..09
  { rule: "R-TYPE-01", what: "`+` `-` `*` `/` は数と数（正例）", expression: "amount + discount", type: "number" },
  { rule: "R-TYPE-01", what: "数でないものを掛ける（負例）", expression: "description * 2", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-01", what: "0 * 0 は数（境界）", expression: "0 * 0", type: "number" },
  { rule: "R-TYPE-02", what: "単項 - は数に付く（正例）", expression: "-amount", type: "number" },
  { rule: "R-TYPE-02", what: "数でないものに単項 -（負例）", expression: "-description", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-02", what: "単項 - は入れ子にできる（境界）", expression: "- -amount", type: "number" },
  { rule: "R-TYPE-03", what: "数の比較は真偽（正例）", expression: "amount >= discount", type: "boolean" },
  { rule: "R-TYPE-03", what: "数と文字列を比べる（負例）", expression: "amount >= description", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-03", what: "同じ数どうしを == で比べる（境界）", expression: "amount == amount", type: "boolean" },
  { rule: "R-TYPE-04", what: "日付どうしの比較は真偽（正例）", expression: "spentOn < today()", type: "boolean" },
  { rule: "R-TYPE-04", what: "日付と数を比べる（負例）", expression: "spentOn < amount", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-04", what: "日付どうしを == で比べる（境界）", expression: "spentOn == today()", type: "boolean" },
  { rule: "R-TYPE-05", what: "文字列（enum のキー）は == で比べる（正例）", expression: "kind == \"food\"", type: "boolean" },
  { rule: "R-TYPE-05", what: "文字列に大小の比較は使えない（負例）", expression: "kind < \"food\"", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-05", what: "空文字も値である（境界）", expression: "description != \"\"", type: "boolean" },
  { rule: "R-TYPE-06", what: "list は len に渡す（正例）", expression: "len(participants) > 0", type: "boolean" },
  { rule: "R-TYPE-06", what: "list を演算子の相手にできない（負例）", expression: "participants == 1", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-06", what: "len の結果を 0 と比べる（境界）", expression: "len(participants) == 0", type: "boolean" },
  { rule: "R-TYPE-07", what: "boolean は演算子の相手にできない（負例・+）", expression: "(amount > 0) + 1", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-07", what: "boolean どうしも比べられない（境界）", expression: "(amount > 0) == (discount > 0)", codes: ["LOGIC_OPERAND_TYPE_MISMATCH"] },
  { rule: "R-TYPE-08", what: "min/max は数の 2 引数（正例）", expression: "max(1, headcount)", type: "number" },
  { rule: "R-TYPE-08", what: "min に引数が足りない（負例）", expression: "min(amount)", codes: ["LOGIC_FUNCTION_ARITY_MISMATCH"] },
  { rule: "R-TYPE-08", what: "today は 0 引数（境界）", expression: "today()", type: "date" },
  { rule: "R-TYPE-09", what: "引数の型が合う（正例）", expression: "len(participants)", type: "number" },
  { rule: "R-TYPE-09", what: "len に数を渡す（負例）", expression: "len(amount)", codes: ["LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH"] },
  { rule: "R-TYPE-09", what: "max(0, 0) は数（境界）", expression: "max(0, 0)", type: "number" },
  // R-LIMIT-01..03
  { rule: "R-LIMIT-01", what: "文字数はちょうど 200 まで（正例）", expression: pad("1 + 1", 200), type: "number" },
  { rule: "R-LIMIT-01", what: "199 は通る（境界・直前）", expression: pad("1 + 1", 199), type: "number" },
  { rule: "R-LIMIT-01", what: "200 は通る（境界・ちょうど）", expression: pad("1 + 1", 200), type: "number" },
  { rule: "R-LIMIT-01", what: "201 は超える（境界・超過）", expression: pad("1 + 1", 201), codes: ["LOGIC_EXPRESSION_TOO_LONG"] },
  { rule: "R-LIMIT-02", what: "深さ 8 は通る（正例）", expression: deep(8), type: "number" },
  { rule: "R-LIMIT-02", what: "深さ 7 は通る（境界・直前）", expression: deep(7), type: "number" },
  { rule: "R-LIMIT-02", what: "深さ 9 は超える（境界・超過）", expression: deep(9), codes: ["LOGIC_EXPRESSION_DEPTH_EXCEEDED"] },
  { rule: "R-LIMIT-03", what: "節 64 は通る（正例）", expression: `-(${tree(32)})`, type: "number" },
  { rule: "R-LIMIT-03", what: "節 63 は通る（境界・直前）", expression: tree(32), type: "number" },
  { rule: "R-LIMIT-03", what: "節 65 は超える（境界・超過）", expression: `1 + (${tree(32)})`, codes: ["LOGIC_EXPRESSION_NODES_EXCEEDED"] },
  // R-VOCAB-10
  { rule: "R-VOCAB-10", what: "用意された関数は使える（正例）", expression: "min(1, 2)", type: "number" },
  { rule: "R-VOCAB-10", what: "用意されていない関数（負例）", expression: "round(amount)", codes: ["LOGIC_FUNCTION_NOT_ALLOWED"] },
  { rule: "R-VOCAB-10", what: "() の無い today は普通の名前（境界）", expression: "today", codes: ["LOGIC_REFERENCE_NOT_FOUND"] },
];

interface EvalCase {
  readonly rule: string;
  readonly what: string;
  readonly expression: string;
  readonly record?: Readonly<Record<string, unknown>>;
  /** 期待する値。`null` は「求められなかった」である（0 に読み替えない） */
  readonly value: number | null;
}

const evalCases: readonly EvalCase[] = [
  { rule: "R-TYPE-14", what: "有限の割り算はその値（正例）", expression: "1 / 2", value: 0.5 },
  { rule: "R-TYPE-14", what: "0 で割ると null（負例）", expression: "1 / 0", value: null },
  { rule: "R-TYPE-14", what: "0 / 5 は 0 である（境界）", expression: "0 / 5", value: 0 },
  { rule: "R-LIMIT-04", what: "上限の内側の式は値を返す（正例）", expression: "amount + 1", record: { amount: 2 }, value: 3 },
];

// ── 実行 ────────────────────────────────────────────────────────────

describe("規則の表との照合（文法の正本 = rules.md）", () => {
  it("FIXTURE と MIN は、それ自体が 0 診断である（照合の土台）", () => {
    expect(checkSpec(FIXTURE).ok, "FIXTURE が赤い").toBe(true);
    expect(checkSpec(MIN).ok, "MIN が赤い").toBe(true);
  });

  it.each(specCases)("$rule: $what", (testCase) => {
    const { ok, codes } = specCodes(testCase.base, testCase.edits);
    if (testCase.codes.length === 0) {
      expect(codes, `診断が出た: ${codes.join(", ")}`).toEqual([]);
      expect(ok).toBe(true);
    } else {
      expect(new Set(codes), `コードが違う: ${codes.join(", ")}`).toEqual(new Set(testCase.codes));
      expect(ok).toBe(false);
    }
  });

  it.each(exprCases)("$rule: $what", (testCase) => {
    const { type, codes } = expressionResult(testCase.expression);
    if (testCase.codes !== undefined) {
      expect(new Set(codes), `コードが違う: ${codes.join(", ")}`).toEqual(new Set(testCase.codes));
      // 読めなかった式は型が `null`、読めたが誤りのある式は `unknown` である
      expect(["unknown", null]).toContain(type);
    } else {
      expect(codes, `診断が出た: ${codes.join(", ")}`).toEqual([]);
      expect(type).toBe(testCase.type);
    }
  });

  it.each(evalCases)("$rule: $what", (testCase) => {
    expect(probeValue(testCase.expression, testCase.record ?? {})).toBe(testCase.value);
  });

  it("R-LIMIT-04: 上限を超えた式は成功値にしない（負例）", () => {
    // 手で組んだ成果物でも、評価は上限をもう一度見る（evaluate.ts の決定 4）。`0` でも `true` でもない
    const evaluation = evaluateApp(
      {
        computed: [
          { name: "big", expression: pad("amount + 1", 201) },
          { name: "small", expression: "amount + 1" },
        ],
        validations: [{ name: "v", expression: pad("amount > 0", 201) }],
      },
      { amount: 2 },
    );
    expect(evaluation.computed["small"]).toBe(3);
    expect(evaluation.computed["big"]).toBeNull();
    expect(evaluation.computed["big"]).not.toBe(0);
    expect(evaluation.validations).toContain("v");
  });

  it("R-LIMIT-04: ちょうど 200 文字の式は普通に評価できる（境界）", () => {
    const evaluation = evaluateApp({ validations: [{ name: "v", expression: pad("amount > 0", 200) }] }, { amount: 2 });
    expect(evaluation.validations).toEqual([]);
  });
});

// ── 網羅（規則の表の全規則に 1 件以上） ──────────────────────────────
//
// 規則の ID は**表から読む**（この file に書き写さない）。読み取った集合と、case が名乗る集合を
// 突き合わせる——片方だけを直すと落ちる。
describe("規則の網羅", () => {
  const rulesText = readText(packageFile(`${CONTRACT_DIR}/rules.md`));
  const declared = [...new Set(rulesText.match(/R-[A-Z]+-\d+/g) ?? [])].sort();
  const covered = new Set<string>([
    ...specCases.map((testCase) => testCase.rule),
    ...exprCases.map((testCase) => testCase.rule),
    ...evalCases.map((testCase) => testCase.rule),
    // R-LIMIT-04 の評価の case は上の 2 つである（evalCases の正例と、この file の負例・境界）
  ]);

  it("規則の表には規則がある（空の表を測っていない）", () => {
    expect(declared.length).toBeGreaterThanOrEqual(50);
  });

  it("表のすべての規則に、照合テストが 1 件以上ある", () => {
    const missing = declared.filter((rule) => !covered.has(rule));
    expect(missing, `照合テストの無い規則: ${missing.join(", ")}`).toEqual([]);
  });

  it("case が名乗る規則は、表にある（打ち間違いを混ぜない）", () => {
    const unknown = [...covered].filter((rule) => !declared.includes(rule)).sort();
    expect(unknown, `表に無い規則: ${unknown.join(", ")}`).toEqual([]);
  });
});
