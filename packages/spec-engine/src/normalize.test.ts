// 正規化（宣言 → 正規化した JSON）の unit テスト（Issue #98 の受入条件のうち、正規化に閉じる分）。
//
// ここで固定したいのは 4 つ。
//   1. 同じ原本からは同じ**バイト列**になる（現在時刻・乱数・実行回数を混ぜない。Q12）
//   2. `sourceSha256` は**原本そのもの**（改行とコメントを含む UTF-8 のバイト列）の SHA-256 である
//   3. 項目・検査・計算の**宣言順**を並べ替えない（並びは意味を持つ。docs/semantics.md）
//   4. 検査に通らない原本（#97 の負例 24 件）は**正規化しない**（成果物を返さない）
//
// 原本と負例は appspec-schema から読む（このリポジトリの正本）。ここに写すと、見本を直したときに
// 片方だけが古くなる。SHA-256 の突き合わせは、この実装とは別に node:crypto で計算する
// （同じ関数で計算すると、どちらも間違っているときに緑になる）。
import { describe, expect, it, vi } from "vitest";
import { APPSPEC_SCHEMA_VERSION, readNegativeIndex } from "@musunest/appspec-schema";
import { negativeIndexFile, negativeSpecFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import { checkSpec } from "./check.js";
import {
  NORMALIZED_JSON_INDENT,
  normalizeSpec,
  serializeNormalizedAppSpec,
  sha256Hex,
} from "./normalize.js";

// tsconfig の types は workers-types と node の両方を読み、グローバルの URL の型が食い違う
// （workers-types の URL を node:fs に渡せない）。このファイルは Node（vitest）で動くので、
// 使う関数の形だけをここで宣言する（check.test.ts と同じやり方）。
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
  readFileSync(path: URL): Uint8Array;
}
interface Sha256Hash {
  update(data: Uint8Array): Sha256Hash;
  digest(encoding: "hex"): string;
}
interface NodeCrypto {
  createHash(algorithm: string): Sha256Hash;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const nodeCrypto = (await importUntyped("node:crypto")) as NodeCrypto;

const readBytes = (url: URL): Uint8Array => fs.readFileSync(url);
const readText = (url: URL): string => fs.readFileSync(url, "utf8");

/** この実装を通さない、独立した SHA-256（原本のバイト列から直接） */
const independentSha256 = (bytes: Uint8Array): string =>
  nodeCrypto.createHash("sha256").update(bytes).digest("hex");

const sampleBytes = readBytes(sampleSpecFile("expense-log"));
const sampleText = readText(sampleSpecFile("expense-log"));
const negativeIndex = readNegativeIndex(JSON.parse(readText(negativeIndexFile())));
const negativeTexts = new Map(
  negativeIndex.negatives.map((negative) => [negative.name, readText(negativeSpecFile(negative.name))]),
);

/** 検査を通ることを先に固定してから、正規化した成果物を読む */
const normalized = async (source: string) => {
  const result = await normalizeSpec(source);
  if (!result.ok) throw new Error(`正規化できない: ${result.diagnostics.map((d) => d.code).join(" / ")}`);
  return result;
};

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];

// ── 見本（正例） ────────────────────────────────────────────────

const sample = await normalized(sampleText);

describe("見本 expense-log の正規化", () => {
  const result = sample;

  it("版・SHA-256・spec の 3 つを、この順に持つ", () => {
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.app)).toEqual(["schemaVersion", "sourceSha256", "spec"]);
    expect(result.app.schemaVersion).toBe(APPSPEC_SCHEMA_VERSION);
    expect(result.app.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sourceSha256 は、原本のバイト列の独立した計算と一致する", async () => {
    expect(result.app.sourceSha256).toBe(independentSha256(sampleBytes));
    // 文字列から計算しても同じになる（原本の読み取りで符号化が変わっていない）
    expect(result.app.sourceSha256).toBe(await sha256Hex(sampleText));
  });

  it("原本にコメントを足すと SHA は変わる（コメントと改行も原本である）", async () => {
    const withComment = `${sampleText}# あとから足した説明\n`;
    const other = await normalized(withComment);
    expect(other.app.sourceSha256).not.toBe(result.app.sourceSha256);
    // 検査が読む宣言は変わらない。変わるのはハッシュだけである
    expect(other.app.spec).toEqual(result.app.spec);
  });

  it("空白やコメントを書き換えても、宣言の意味が同じなら spec は同じである", async () => {
    const withBlankLine = sampleText.replace("entities:", "\nentities:");
    const other = await normalized(withBlankLine);
    expect(other.app.spec).toEqual(result.app.spec);
    expect(other.app.sourceSha256).not.toBe(result.app.sourceSha256);
  });

  it("JSON から元の宣言に戻せる（検査が返す AppSpec と同じ）", () => {
    const checked = checkSpec(sampleText);
    if (!checked.ok) throw new Error("検査で診断が出ている");
    expect(JSON.parse(result.json).spec).toEqual(checked.spec);
    expect(serializeNormalizedAppSpec(result.app)).toBe(result.json);
  });
});

// ── 決定的であること（同じバイト列） ──────────────────────────────

describe("同じ原本からは同じバイト列になる", () => {
  it("何度正規化しても、JSON のバイト列が一致する", async () => {
    const first = await normalized(sampleText);
    const bytes = utf8(first.json);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await normalized(sampleText);
      expect(utf8(again.json)).toEqual(bytes);
      expect(again.app.sourceSha256).toBe(first.app.sourceSha256);
    }
  });

  it("現在時刻と乱数を変えても、バイト列は変わらない", async () => {
    const first = await normalized(sampleText);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    try {
      const again = await normalized(sampleText);
      expect(utf8(again.json)).toEqual(utf8(first.json));
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });
});

// ── 宣言の順（並べ替えない） ────────────────────────────────────

describe("宣言の順を並べ替えない", () => {
  it("項目・計算・検査の順が、原本の順のまま JSON に出る", async () => {
    const parsed = JSON.parse((await normalized(sampleText)).json) as {
      spec: {
        entities: readonly { fields: Readonly<Record<string, string>> }[];
        computed: readonly { name: string }[];
        validations: readonly { name: string }[];
      };
    };
    // 項目の順は一覧の列の順になる（docs/semantics.md「entity」）
    expect(Object.keys(parsed.spec.entities[0]?.fields ?? {})).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
    ]);
    expect(parsed.spec.computed.map((entry) => entry.name)).toEqual([
      "paidAmount",
      "headcount",
      "shareAmount",
    ]);
    expect(parsed.spec.validations.map((entry) => entry.name)).toEqual([
      "positiveAmount",
      "nonNegativeDiscount",
    ]);
  });

  it("計算を逆向きに宣言した原本でも、その順のままにする（無条件の並べ替えをしない）", async () => {
    const text = [
      "entities:",
      "  - name: expense",
      "    fields:",
      "      amount: number",
      "      participants: list",
      "views: []",
      "actions: []",
      "validations:",
      "  - name: hasPeople",
      "    entity: expense",
      "    expression: headcount > 0",
      "computed:",
      "  - name: headcount",
      "    entity: expense",
      "    expression: len(participants)",
      "    type: number",
      "  - name: doubled",
      "    entity: expense",
      "    expression: headcount * 2",
      "    type: number",
      "permissions: []",
      "minIdentity:",
      "  mode: anonymous",
      "",
    ].join("\n");
    const parsed = JSON.parse((await normalized(text)).json) as {
      spec: { computed: readonly { name: string }[]; validations: readonly { name: string }[] };
    };
    // 依存の順（headcount → doubled）と、宣言の順が同じであることを確かめてから並びを見る
    expect(parsed.spec.computed.map((entry) => entry.name)).toEqual(["headcount", "doubled"]);
    expect(parsed.spec.validations.map((entry) => entry.name)).toEqual(["hasPeople"]);
    const { json } = await normalized(text);
    expect(json.indexOf('"headcount"')).toBeLessThan(json.indexOf('"doubled"'));
    expect(json.indexOf('"hasPeople"')).toBeLessThan(json.indexOf('"headcount"'));
  });
});

// ── 出力の規約 ─────────────────────────────────────────────────

describe("正規化した JSON の出力の規約", () => {
  it("字下げは 2 文字で、改行は LF、末尾に改行 1 つである", async () => {
    const { json } = await normalized(sampleText);
    expect(NORMALIZED_JSON_INDENT).toBe(2);
    expect(json).not.toContain("\r");
    expect(json.endsWith("\n")).toBe(true);
    expect(json.endsWith("\n\n")).toBe(false);
    for (const line of json.split("\n").slice(0, -1)) {
      const indent = line.length - line.trimStart().length;
      expect(indent % NORMALIZED_JSON_INDENT, line).toBe(0);
    }
  });

  it("キーの並べ替えをしない（3 つが書いた順に出る）", async () => {
    const { json } = await normalized(sampleText);
    expect(json.startsWith("{\n")).toBe(true);
    expect(json.indexOf('"schemaVersion"')).toBeLessThan(json.indexOf('"sourceSha256"'));
    expect(json.indexOf('"sourceSha256"')).toBeLessThan(json.indexOf('"spec"'));
  });
});

// ── 負例（検査に通らない原本は正規化しない） ──────────────────────

describe("検査に通らない原本は正規化しない（#97 の負例）", () => {
  const cases = negativeIndex.negatives.map(
    (negative) => [negative.name, negative] as const,
  );

  it.each(cases)("負例 %s は成果物を返さず、#97 と同じ診断になる", async (name, negative) => {
    const text = negativeTexts.get(name) ?? "";
    const result = await normalizeSpec(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 返るコードの集合が、負例の一覧（正本）とちょうど一致する
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(negative.codes),
    );
    // 成果物の欄そのものを持たない（受け取った側が中身を読めない）
    expect(Object.hasOwn(result, "app")).toBe(false);
    expect(Object.hasOwn(result, "json")).toBe(false);
  });

  it("診断の 3 つ組（コード・説明・位置）は、検査の結果のままである", async () => {
    const first = negativeIndex.negatives[0];
    if (first === undefined) throw new Error("負例が空");
    const text = negativeTexts.get(first.name) ?? "";
    const result = await normalizeSpec(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(checkSpec(text).diagnostics);
  });

  it("空の原本も、成果物を返さない", async () => {
    const result = await normalizeSpec("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SHAPE_YAML_INVALID");
  });
});

// ── 選択肢（enum）と既定値（default）（M1.3。Issue #154） ─────────────
//
// 選択肢は「保存される値（キー）→ 表示名」の写像である。**書いた順が意味を持つ**ので
// （M1.3 のボードはこの順に列を並べる）、正規化した JSON でも順を並べ替えない（規約 3）。

const ENUM_SOURCE = [
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

describe("選択肢（enum）と既定値（default）の正規化（M1.3）", () => {
  it("options と default が、書いた順のまま JSON に残る（受入条件）", async () => {
    const result = await normalized(ENUM_SOURCE);
    const task = result.app.spec.entities.find((entity) => entity.name === "task");
    expect(task?.fields["status"]).toEqual({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
      default: "todo",
    });
    // キーの並べ替えをしない（書いた順が、画面に出す選択肢の順である）
    const json = result.json;
    expect(json.indexOf('"todo"')).toBeLessThan(json.indexOf('"doing"'));
    expect(json.indexOf('"doing"')).toBeLessThan(json.indexOf('"done"'));
  });

  it("default を書かなければ、欄そのものが無い", async () => {
    const result = await normalized(ENUM_SOURCE.replace("        default: todo\n", ""));
    const task = result.app.spec.entities.find((entity) => entity.name === "task");
    expect(task?.fields["status"]).toEqual({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
    });
  });
});

// ── 決まった値への書き換え（set）とボタンを出す条件（when）の正規化（M1.3。Issue #156） ──
//
// **publish で通り、正規化した JSON に残ること**が受入条件である。data-api と画面はこの JSON
// だけを読むので、ここで落ちれば「静的チェックは通るのに画面が動かない」になる（#145 と同じ穴）。

const SET_WHEN_SOURCE = [
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

describe("set と when の正規化（M1.3）", () => {
  it("set と when を持つ操作が publish でき、正規化した JSON に残る（受入条件）", async () => {
    const result = await normalized(SET_WHEN_SOURCE);
    expect(result.app.spec.actions).toEqual([
      { name: "addTask", entity: "task" },
      {
        name: "start",
        entity: "task",
        kind: "update",
        set: { status: "doing" },
        when: 'status == "todo"',
      },
      {
        name: "finish",
        entity: "task",
        kind: "update",
        set: { status: "done" },
        when: 'status != "done"',
      },
    ]);
    // 文字列の定数は、引用符ごと JSON に残る（式の字面を書き換えない）
    expect(result.json).toContain('status == \\"todo\\"');
  });

  it("set も when も持たない操作には、欄そのものが無い（M1.1・M1.2 の応答を変えない）", async () => {
    const result = await normalized(SET_WHEN_SOURCE);
    expect(Object.keys(result.app.spec.actions[0] ?? {})).toEqual(["name", "entity"]);
  });

  it("宣言の順は並べ替えない（操作の順が、画面のボタンの順になる）", async () => {
    const result = await normalized(SET_WHEN_SOURCE);
    expect(result.app.spec.actions.map((action) => action.name)).toEqual([
      "addTask",
      "start",
      "finish",
    ]);
    expect(result.json.indexOf('"start"')).toBeLessThan(result.json.indexOf('"finish"'));
  });

  it("同じ原本からは同じバイト列になる（set と when を足しても変わらない約束）", async () => {
    const first = await normalized(SET_WHEN_SOURCE);
    const second = await normalized(SET_WHEN_SOURCE);
    expect(utf8(first.json)).toEqual(utf8(second.json));
  });
});

// ── 一覧（list）と絞り込み（filters）の正規化（M1.3。Issue #158） ──
//
// **publish で通り、正規化した JSON に残ること**が受入条件である。data-api と画面はこの JSON だけを
// 読むので、ここで落ちれば「静的チェックは通るのに画面が動かない」になる（#145 と同じ穴）。

const LIST_SOURCE = [
  "entities:",
  "  - name: member",
  "    fields:",
  "      name: string",
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
  "      assignee:",
  "        type: ref",
  "        to: member",
  "views:",
  "  - name: taskList",
  "    entity: task",
  "    type: list",
  "    show: [title, status, assignee]",
  "    filters: [assignee, status]",
  "actions:",
  "  - name: addTask",
  "    entity: task",
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

describe("一覧（list）と絞り込み（filters）の正規化（M1.3）", () => {
  it("type: list・show・filters が、書いた順のまま JSON に残る（受入条件）", async () => {
    const result = await normalized(LIST_SOURCE);
    // 並びは配列の順で比べる（show は画面の項目の順、filters は選択肢の順になる）
    expect(result.app.spec.views).toEqual([
      {
        name: "taskList",
        entity: "task",
        type: "list",
        show: ["title", "status", "assignee"],
        filters: ["assignee", "status"],
      },
    ]);
  });

  it("show と filters を書かなければ、欄そのものが無い（M1.1・M1.2 の宣言に欄を足さない）", async () => {
    const source = LIST_SOURCE.replace("    show: [title, status, assignee]\n", "").replace(
      "    filters: [assignee, status]\n",
      "",
    );
    const result = await normalized(source);
    expect(result.app.spec.views[0]).toEqual({ name: "taskList", entity: "task", type: "list" });
  });
});

// ── 表示名（label）の正規化（M1.3。Issue #176） ───────────────────────
//
// **publish で通り、正規化した JSON に残ること**が受入条件である。data-api と画面はこの JSON だけを
// 読むので、ここで落ちれば「静的チェックは通るのに画面が動かない」になる（#145 と同じ穴）。
// `label` を書かないものには欄そのものを足さない（M1.1・M1.2 の宣言を変えない）。

const LABEL_SOURCE = [
  "entities:",
  "  - name: task",
  "    fields:",
  "      title:",
  "        type: string",
  "        label: やること",
  "      due: date",
  "views:",
  "  - name: taskList",
  "    entity: task",
  "actions:",
  "  - name: addTask",
  "    entity: task",
  "validations: []",
  "computed:",
  "  - name: overdue",
  "    entity: task",
  "    type: boolean",
  "    label: 期限切れ",
  "    expression: due < today()",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
].join("\n");

describe("表示名（label）の正規化（M1.3）", () => {
  it("項目と計算の label が、正規化した JSON に残る（受入条件）", async () => {
    const result = await normalized(LABEL_SOURCE);
    const task = result.app.spec.entities.find((entity) => entity.name === "task");
    expect(task?.fields["title"]).toEqual({ type: "string", label: "やること" });
    // `label` を書かない項目は、識別子のまま（1 語のスカラ）
    expect(task?.fields["due"]).toBe("date");
    expect(result.app.spec.computed[0]).toEqual({
      name: "overdue",
      entity: "task",
      type: "boolean",
      label: "期限切れ",
      expression: "due < today()",
    });
    // 文字列の定数と同じく、表示名も JSON にそのまま残る
    expect(result.json).toContain("やること");
    expect(result.json).toContain("期限切れ");
  });

  it("label を書かなければ、欄そのものが無い（M1.1・M1.2 の宣言に欄を足さない）", async () => {
    const source = LABEL_SOURCE.replace("        label: やること\n", "").replace(
      "    label: 期限切れ\n",
      "",
    );
    const result = await normalized(source);
    expect(result.app.spec.entities[0]?.fields["title"]).toBe("string");
    expect(Object.keys(result.app.spec.computed[0] ?? {}).sort()).toEqual([
      "entity",
      "expression",
      "name",
      "type",
    ]);
  });
});

// ── ダッシュボード（`dashboard`）と数値の部品の正規化（M1.4。Issue #180） ──

describe("ダッシュボード（dashboard）と数値の部品の正規化（M1.4）", () => {
  const DASHBOARD_SOURCE = [
    "entities:",
    "  - name: activity",
    "    fields:",
    "      cost: number",
    "views:",
    "  - name: dashboard",
    "    type: dashboard",
    "    widgets:",
    "      - type: number",
    "        label: 今月の費用",
    "        value: costTotal",
    "        unit: 円",
    "  - name: activityList",
    "    entity: activity",
    "actions:",
    "  - name: addActivity",
    "    entity: activity",
    "validations: []",
    "computed:",
    "  - name: costTotal",
    "    scope: app",
    "    aggregate:",
    "      sum: activity.cost",
    "    type: number",
    "permissions:",
    "  - name: read",
    "    subject: minIdentity",
    "  - name: write",
    "    subject: minIdentity",
    "minIdentity:",
    "  mode: anonymous",
  ].join("\n");

  it("dashboard の一覧は、正規化した JSON でも `entity` を持たない（受入条件）", async () => {
    const result = await normalized(DASHBOARD_SOURCE);
    const dashboard = result.app.spec.views.find((view) => view.name === "dashboard");
    expect(dashboard).toEqual({
      name: "dashboard",
      type: "dashboard",
      widgets: [{ type: "number", label: "今月の費用", value: "costTotal", unit: "円" }],
    });
    // 正規化した JSON にも `entity` は現れない（行を並べない一覧である）
    expect(dashboard).not.toHaveProperty("entity");
    expect(result.json).toContain('"type": "dashboard"');
    expect(result.json).toContain('"unit": "円"');
  });

  it("部品の `label` と `unit` を書かなければ、欄そのものが無い", async () => {
    const source = DASHBOARD_SOURCE.replace("        label: 今月の費用\n", "").replace(
      "        unit: 円\n",
      "",
    );
    const result = await normalized(source);
    expect(result.app.spec.views[0]).toEqual({
      name: "dashboard",
      type: "dashboard",
      widgets: [{ type: "number", value: "costTotal" }],
    });
  });
});
