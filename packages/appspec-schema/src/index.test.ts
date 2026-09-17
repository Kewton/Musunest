// appspec-schema の unit テスト。版の表記、語彙の台帳、見本・負例・採点のシナリオの突き合わせを見る。
//
// 台帳の検査の要は「欄が 1 つでも欠けた行があれば落ちる」ことである（04-spec-evolution.md §6.2）。
// 本物の vocabulary.yaml が通ることに加えて、欄を 1 つずつ抜いた行を入れると落ちることを、
// 行の検査（checkVocabularyLedger）と、YAML の本文から読む経路（readLedgerYaml）の両方で確かめる。
import { describe, expect, it } from "vitest";
import {
  negativeIndexFile,
  negativeSpecFile,
  negativesDir,
  packageFile,
  NEGATIVES_DIR_NAME,
  NEGATIVE_SPEC_SUFFIX,
  sampleScenarioFile,
  samplesDir,
  sampleSpecFile,
  semanticsFile,
  vocabularyFile,
} from "./files.js";
import {
  APPSPEC_SCHEMA_VERSION,
  APPSPEC_SCHEMA_VERSION_PATTERN,
  APPSPEC_SECTIONS,
  BUILTIN_FUNCTIONS,
  FIELD_TYPES,
  IDENTITY_MODES,
  LEDGER_FIELDS,
  LEDGER_LIST_FIELDS,
  PACKAGE_NAME,
  SECTION_LAYER,
  VOCABULARY,
  checkVocabularyLedger,
  isDraftSchemaVersion,
  readNegativeIndex,
  readScoringScenario,
  type AppSpecSection,
} from "./index.js";
import { readLedgerYaml, type LedgerYamlRow } from "./ledger-yaml.js";

// tsconfig の types は workers-types だけなので、node:fs の型が無い。
// このファイルは Node（vitest）で動くので、使う関数の形だけをここで宣言する（data-api のテストと同じやり方）。
interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): DirEntry[];
  existsSync(path: URL): boolean;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;

const readText = (url: URL) => fs.readFileSync(url, "utf8");
const readJson = (url: URL): unknown => JSON.parse(readText(url));
const listDir = (url: URL) => fs.readdirSync(url, { withFileTypes: true });

const ledgerText = readText(vocabularyFile());
const ledger = readLedgerYaml(ledgerText);
const negativeIndex = readNegativeIndex(readJson(negativeIndexFile()));
const codesOfNegative = new Map(negativeIndex.negatives.map((n) => [n.name, n.codes]));

const list = (row: LedgerYamlRow, field: string): readonly string[] => {
  const value = row[field];
  return Array.isArray(value) ? value : [];
};
const text = (row: LedgerYamlRow, field: string): string => {
  const value = row[field];
  return typeof value === "string" ? value : "";
};

describe("appspec-schema", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/appspec-schema");
  });

  it("スキーマの版は v0.2 の草案の表記である（Q9。README.md「版の表記」）", () => {
    expect(APPSPEC_SCHEMA_VERSION).toMatch(APPSPEC_SCHEMA_VERSION_PATTERN);
    expect(APPSPEC_SCHEMA_VERSION).toBe("community.app-spec/v0.2-draft");
    expect(isDraftSchemaVersion(APPSPEC_SCHEMA_VERSION)).toBe(true);
    expect(isDraftSchemaVersion("community.app-spec/v0.2")).toBe(false);
  });

  it("ピンには固めた版だけを書く。固めたあとはピンとこのパッケージの版が一致する", () => {
    // ピンの差し替えは M1.5 の作業（pins/ はこの Issue では変えない）。ここでは書いてはいけない形だけを止める
    const pin = readJson(packageFile("../../pins/commandagent.json")) as {
      appspec_schema: { version: string };
    };
    expect(pin.appspec_schema.version).toMatch(APPSPEC_SCHEMA_VERSION_PATTERN);
    expect(isDraftSchemaVersion(pin.appspec_schema.version)).toBe(false);
    if (!isDraftSchemaVersion(APPSPEC_SCHEMA_VERSION)) {
      expect(pin.appspec_schema.version).toBe(APPSPEC_SCHEMA_VERSION);
    }
  });

  it("ファイルの場所は、パッケージの直下を指す", () => {
    expect(fs.existsSync(packageFile("package.json"))).toBe(true);
    const pkg = readJson(packageFile("package.json")) as { name: string };
    expect(pkg.name).toBe(PACKAGE_NAME);
  });
});

describe("語彙の台帳（vocabulary.yaml）", () => {
  it("すべての行が、欄を欠かさずに持っている", () => {
    expect(ledger.length).toBeGreaterThan(0);
    expect(checkVocabularyLedger(ledger)).toEqual([]);
  });

  it.each(LEDGER_FIELDS)("欄 %s が欠けた行を入れると落ちる", (field) => {
    const [first] = ledger;
    if (!first) throw new Error("台帳が空");
    // 名前が重なると別の問題も出るので、足す行の名前は変えておく
    const broken: Record<string, unknown> = { ...first, name: "brokenRow" };
    delete broken[field];
    const problems = checkVocabularyLedger([...ledger, broken]);
    expect(problems).toContainEqual({ row: ledger.length + 1, field, message: "欄が無い" });
  });

  it.each(LEDGER_FIELDS)("本文に、欄 %s が欠けた行を書き足すと落ちる", (field) => {
    // 読み取りの経路で欄が落ちたり補われたりしないことを、YAML の本文から確かめる
    const [first] = ledger;
    if (!first) throw new Error("台帳が空");
    const lines = LEDGER_FIELDS.filter((f) => f !== field).map((f) => {
      const value = f === "name" ? "brokenRow" : first[f];
      return `${f}: ${Array.isArray(value) ? `[${value.join(", ")}]` : String(value)}`;
    });
    const appended = `${ledgerText}\n- ${lines.join("\n  ")}\n`;
    const problems = checkVocabularyLedger(readLedgerYaml(appended));
    expect(problems).toContainEqual({ row: ledger.length + 1, field, message: "欄が無い" });
  });

  it.each([
    ["空の並び", { samples: [] }, "samples", "並びが空"],
    ["空の文字列", { semantics: "" }, "semantics", "値が空"],
    ["並びでない並びの欄", { negatives: "entity-duplicate-name" }, "negatives", "並び（[a, b]）で書く"],
    ["文字列でない欄", { layer: ["data"] }, "layer", "文字列で書く"],
  ] as const)("%s は欠けているのと同じく落ちる", (_label, patch, field, message) => {
    const [first] = ledger;
    if (!first) throw new Error("台帳が空");
    const problems = checkVocabularyLedger([{ ...first, name: "brokenRow", ...patch }]);
    expect(problems).toContainEqual({ row: 1, field, message });
  });

  it("欄の値の形が違えば落ちる", () => {
    const [first] = ledger;
    if (!first) throw new Error("台帳が空");
    const problems = checkVocabularyLedger([
      first,
      {
        ...first,
        memo: "知らない欄",
        layer: "database",
        since: "M1.1",
        check_rules: ["lowercase_code"],
        semantics: "docs/semantics.md",
        factory: "対応",
      },
    ]);
    expect(problems.map((p) => [p.row, p.field])).toEqual([
      [2, "*"],
      [2, "check_rules"],
      [2, "name"],
      [2, "layer"],
      [2, "since"],
      [2, "semantics"],
      [2, "factory"],
    ]);
  });

  it("固めた版では factory に工場の対応を書ける", () => {
    const [first] = ledger;
    if (!first) throw new Error("台帳が空");
    expect(checkVocabularyLedger([{ ...first, factory: "対応" }], "community.app-spec/v0.2")).toEqual([]);
  });

  it("台帳の形でないものは落ちる", () => {
    expect(checkVocabularyLedger({})).toHaveLength(1);
    expect(checkVocabularyLedger([])).toHaveLength(1);
    expect(checkVocabularyLedger(["entity"])).toEqual([
      { row: 1, field: "*", message: "行が「欄: 値」の組になっていない" },
    ]);
  });

  it("台帳の語彙と、型の側の語彙（VOCABULARY）が 1 対 1 で、層も一致する", () => {
    const fromLedger = Object.fromEntries(ledger.map((row) => [text(row, "name"), text(row, "layer")]));
    expect(fromLedger).toEqual(VOCABULARY);
  });

  it("項目の型・関数・本人確認の種類は、すべて台帳にある", () => {
    const names = Object.keys(VOCABULARY);
    for (const name of [...FIELD_TYPES, ...Object.keys(BUILTIN_FUNCTIONS), ...IDENTITY_MODES]) {
      expect(names).toContain(name);
    }
  });

  it("欄を表す語彙の層は、欄と層の対応（SECTION_LAYER）と一致する", () => {
    const sectionOf: Readonly<Record<string, AppSpecSection>> = {
      entity: "entities",
      view: "views",
      action: "actions",
      validation: "validations",
      computed: "computed",
      permission: "permissions",
      anonymous: "minIdentity",
    };
    for (const [name, section] of Object.entries(sectionOf)) {
      expect(VOCABULARY[name as keyof typeof VOCABULARY], name).toBe(SECTION_LAYER[section]);
    }
  });

  it("samples の見本が実在する", () => {
    for (const row of ledger) {
      for (const sample of list(row, "samples")) {
        expect(fs.existsSync(sampleSpecFile(sample)), `${text(row, "name")}: ${sample}`).toBe(true);
      }
    }
  });

  it("negatives の負例が、ファイルと負例の一覧の両方にある", () => {
    for (const row of ledger) {
      for (const negative of list(row, "negatives")) {
        const where = `${text(row, "name")}: ${negative}`;
        expect(fs.existsSync(negativeSpecFile(negative)), where).toBe(true);
        expect(codesOfNegative.has(negative), where).toBe(true);
      }
    }
  });

  it("check_rules は、その行の負例が出す誤りコードの集まりとちょうど一致する", () => {
    for (const row of ledger) {
      const expected = new Set(list(row, "negatives").flatMap((n) => codesOfNegative.get(n) ?? []));
      expect(new Set(list(row, "check_rules")), text(row, "name")).toEqual(expected);
    }
  });

  it("semantics の節が、意味の文書に見出しとしてある", () => {
    const headings = new Set(
      readText(semanticsFile())
        .split("\n")
        .filter((line) => line.startsWith("### "))
        .map((line) => line.slice(4).trim()),
    );
    for (const row of ledger) {
      const [file, section = ""] = text(row, "semantics").split("#");
      expect(packageFile(file ?? "").href, text(row, "name")).toBe(semanticsFile().href);
      expect(headings.has(section), `${text(row, "name")}: ### ${section}`).toBe(true);
    }
  });

  it("runtime の場所が、packages/ か apps/ の下のパッケージとして実在する", () => {
    for (const row of ledger) {
      for (const place of list(row, "runtime")) {
        const exists = ["../", "../../apps/"].some((dir) =>
          fs.existsSync(packageFile(`${dir}${place}/package.json`)),
        );
        expect(exists, `${text(row, "name")}: ${place}`).toBe(true);
      }
    }
  });

  it("並びの欄はすべて LEDGER_LIST_FIELDS で、ほかは文字列として読める", () => {
    for (const row of ledger) {
      for (const field of LEDGER_FIELDS) {
        const isList = (LEDGER_LIST_FIELDS as readonly string[]).includes(field);
        expect(Array.isArray(row[field]), `${text(row, "name")}.${field}`).toBe(isList);
      }
    }
  });
});

describe("見本・負例・採点のシナリオ（samples/）", () => {
  // .DS_Store などの隠しファイルは、追跡されないので数えない
  const visible = (url: URL) => listDir(url).filter((e) => !e.name.startsWith("."));
  const entries = visible(samplesDir());
  const sampleNames = entries
    .filter((e) => e.isDirectory() && e.name !== NEGATIVES_DIR_NAME)
    .map((e) => e.name);

  it("samples/ の下は、見本のディレクトリと負例のディレクトリだけである", () => {
    expect(entries.filter((e) => !e.isDirectory()).map((e) => e.name)).toEqual([]);
    expect(sampleNames).toContain("expense-log");
  });

  it("どの見本も台帳から参照されている", () => {
    const referenced = new Set(ledger.flatMap((row) => list(row, "samples")));
    expect(sampleNames.filter((name) => !referenced.has(name))).toEqual([]);
  });

  it.each(sampleNames)("見本 %s は、宣言と採点のシナリオを持つ", (name) => {
    expect(fs.existsSync(sampleSpecFile(name))).toBe(true);
    const scenario = readScoringScenario(readJson(sampleScenarioFile(name)));
    expect(scenario.sample).toBe(name);
  });

  it.each(sampleNames)("見本 %s の採点のシナリオが参照する名前は、宣言に書いてある", (name) => {
    // YAML を読まずに本文の行で確かめる（名前の打ち間違いを拾うため。意味の検査は spec-engine が行う）
    const declared = new Set(
      readText(sampleSpecFile(name))
        .split("\n")
        .map((line) => /^ {2}- name: ([A-Za-z0-9]+)$/.exec(line)?.[1])
        .filter((found): found is string => found !== undefined),
    );
    // 項目の名前は「名前: 値」の行と、参照（ref・参照 list）の「名前:」で始まる入れ子の写像の行にある
    const fieldAndComputed = new Set(
      readText(sampleSpecFile(name))
        .split("\n")
        .map(
          (line) =>
            /^ {6}([A-Za-z0-9]+):(?: |$)/.exec(line)?.[1] ??
            /^ {2}- name: ([A-Za-z0-9]+)$/.exec(line)?.[1],
        )
        .filter((found): found is string => found !== undefined),
    );
    const scenario = readScoringScenario(readJson(sampleScenarioFile(name)));
    for (const step of scenario.steps) {
      expect(declared.has(step.action), `${step.name}: ${step.action}`).toBe(true);
      if ("rejected" in step.expect) {
        for (const validation of step.expect.rejected.validations) {
          expect(declared.has(validation), `${step.name}: ${validation}`).toBe(true);
        }
      }
    }
    for (const [view, rows] of Object.entries(scenario.views)) {
      expect(declared.has(view), view).toBe(true);
      for (const row of rows) {
        for (const key of Object.keys(row)) expect(fieldAndComputed.has(key), `${view}.${key}`).toBe(true);
      }
    }
  });

  it("支出の記録のシナリオは、有限でない数の入力をそのまま持っている", () => {
    // JSON を整形し直すと 1e400 が消えることがある。消えたら「有限の数だけを受け取る」を採点できない
    const scenario = readScoringScenario(readJson(sampleScenarioFile("expense-log")));
    const amounts = scenario.steps.map((step) => step.input.amount);
    expect(amounts).toContain(Number.POSITIVE_INFINITY);
  });

  it("負例の一覧とファイルが 1 対 1 に対応する", () => {
    const files = visible(negativesDir())
      .filter((e) => e.isFile() && e.name.endsWith(NEGATIVE_SPEC_SUFFIX))
      .map((e) => e.name.slice(0, -NEGATIVE_SPEC_SUFFIX.length));
    expect(files).toHaveLength(negativeIndex.negatives.length);
    expect(new Set(negativeIndex.negatives.map((n) => n.name))).toEqual(new Set(files));
    const others = visible(negativesDir())
      .filter((e) => !e.name.endsWith(NEGATIVE_SPEC_SUFFIX))
      .map((e) => e.name);
    expect(others).toEqual(["index.json"]);
  });

  it("どの負例も台帳から参照されている", () => {
    const referenced = new Set(ledger.flatMap((row) => list(row, "negatives")));
    expect(negativeIndex.negatives.map((n) => n.name).filter((name) => !referenced.has(name))).toEqual([]);
  });

  it("負例は、宣言の 7 欄をすべて書いた形である（1 か所だけを間違える）", () => {
    for (const negative of negativeIndex.negatives) {
      const sections = readText(negativeSpecFile(negative.name))
        .split("\n")
        .map((line) => /^([A-Za-z]+):/.exec(line)?.[1])
        .filter((found): found is string => found !== undefined);
      expect(sections, negative.name).toEqual([...APPSPEC_SECTIONS]);
    }
  });
});
