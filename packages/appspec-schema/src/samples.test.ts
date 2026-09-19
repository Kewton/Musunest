// 採点のシナリオと負例の一覧の読み取り。形が違えば例外になることを見る（黙って読み飛ばすと、採点しなかったことが緑に化ける）。
import { describe, expect, it } from "vitest";
import { sampleSpecFile, vocabularyFile } from "./files.js";
import { readLedgerYaml } from "./ledger-yaml.js";
import {
  readNegativeIndex,
  readScoringScenario,
  resolveScenarioIds,
  scenarioIds,
} from "./samples.js";

const step = (overrides: Record<string, unknown> = {}) => ({
  name: "夕食を入れる",
  action: "addExpense",
  input: { amount: 6000 },
  expect: { accepted: true },
  ...overrides,
});

const scenario = (overrides: Record<string, unknown> = {}) => ({
  $comment: "人向けの注記",
  sample: "expense-log",
  clock: "2026-09-16T12:00:00+09:00",
  steps: [step()],
  views: { expenseList: [{ amount: 6000 }] },
  ...overrides,
});

describe("readScoringScenario", () => {
  it("正しい形を読む", () => {
    const rejected = { rejected: { fields: [], validations: ["positiveAmount"] } };
    expect(readScoringScenario(scenario({ steps: [step(), step({ expect: rejected })] }))).toEqual({
      sample: "expense-log",
      clock: "2026-09-16T12:00:00+09:00",
      steps: [
        { name: "夕食を入れる", action: "addExpense", input: { amount: 6000 }, expect: { accepted: true } },
        { name: "夕食を入れる", action: "addExpense", input: { amount: 6000 }, expect: rejected },
      ],
      views: { expenseList: [{ amount: 6000 }] },
    });
  });

  it.each([
    ["オブジェクトでない", [], "scenario: オブジェクトではない"],
    ["知らないキー", scenario({ extra: 1 }), "知らないキー extra"],
    [
      "キーが足りない",
      { sample: "expense-log", clock: "2026-09-16T12:00:00+09:00", steps: [step()] },
      "キー views が無い",
    ],
    ["見本の名前の形", scenario({ sample: "ExpenseLog" }), "scenario.sample: ExpenseLog"],
    ["日本時間でない時計", scenario({ clock: "2026-09-16T12:00:00Z" }), "scenario.clock"],
    ["日時として読めない時計", scenario({ clock: "2026-13-45T12:00:00+09:00" }), "日時として読めない"],
    ["操作が無い", scenario({ steps: [] }), "scenario.steps: 空でない配列ではない"],
    ["操作の名前の形", scenario({ steps: [step({ action: "add-expense" })] }), "steps[0].action"],
    ["入力がオブジェクトでない", scenario({ steps: [step({ input: [6000] })] }), "steps[0].input"],
    ["accepted が true でない", scenario({ steps: [step({ expect: { accepted: false } })] }), "true ではない"],
    ["結果が無い", scenario({ steps: [step({ expect: {} })] }), "キー rejected が無い"],
    [
      "断る理由が無い",
      scenario({ steps: [step({ expect: { rejected: { fields: [], validations: [] } } })] }),
      "両方が空",
    ],
    [
      "型の検査で断ったのに検査の式も返している",
      scenario({
        steps: [step({ expect: { rejected: { fields: ["amount"], validations: ["positiveAmount"] } } })],
      }),
      "検査の式を評価しない",
    ],
    [
      "同じ名前が 2 回ある",
      scenario({ steps: [step({ expect: { rejected: { fields: ["amount", "amount"], validations: [] } } })] }),
      "同じ値が 2 回ある",
    ],
    ["一覧が無い", scenario({ views: {} }), "一覧が 1 つも無い"],
    ["一覧の行がオブジェクトでない", scenario({ views: { expenseList: [6000] } }), "expenseList[0]"],
  ])("%s なら例外にする", (_label, value, reason) => {
    expect(() => readScoringScenario(value)).toThrow(reason);
  });
});

const negative = (overrides: Record<string, unknown> = {}) => ({
  name: "computed-cycle",
  codes: ["LOGIC_COMPUTED_CYCLE"],
  why: "計算が互いを参照している",
  ...overrides,
});

// ── 動的に割り当てた ID（`bind` と `$名前`。M1.2） ────────────────────────
//
// 登録して得た ID は実行するまで決まらない。シナリオは「覚えた ID に名前を付ける（`bind`）」と
// 「その名前を指す（`$名前`）」の 2 つだけを書き、**実際の ID への置き換えは採点する側が行う**。

describe("bind と $名前（動的に割り当てた ID）", () => {
  const bound = (name: string, input: Record<string, unknown> = { name: "A" }) =>
    step({ action: "addMember", input, expect: { accepted: true, bind: name } });

  it("受理した手順の bind を読み、scenarioIds が宣言の順に返す", () => {
    const read = readScoringScenario(
      scenario({
        sample: "warikan",
        steps: [bound("A"), bound("B"), step({ input: { payer: "$A" } })],
      }),
    );
    expect(read.steps[0]?.expect).toEqual({ accepted: true, bind: "A" });
    expect(read.steps[2]?.expect).toEqual({ accepted: true });
    expect(scenarioIds(read)).toEqual(["A", "B"]);
  });

  it("bind の名前が 2 回あれば例外にする", () => {
    expect(() =>
      readScoringScenario(scenario({ steps: [bound("A"), bound("A")] })),
    ).toThrow("A が 2 回ある");
  });

  it("bind されていない $名前 を書けば例外にする（打ち間違いを黙って通さない）", () => {
    expect(() =>
      readScoringScenario(scenario({ steps: [bound("A"), step({ input: { payer: "$AA" } })] })),
    ).toThrow("$AA を指す手順が無い");
  });

  it("一覧の期待値の中の $名前 も、bind された名前でなければ例外にする", () => {
    expect(() =>
      readScoringScenario(
        scenario({ steps: [bound("A")], views: { expenseList: [{ payer: "$missing" }] } }),
      ),
    ).toThrow("$missing を指す手順が無い");
  });

  it("resolveScenarioIds は、入力と期待値の $名前 を実際の ID に置き換える", () => {
    const ids = { A: "id-a", B: "id-b" };
    // `$` で始まらない文字列と、数はそのまま残す（**名前は文字列全体が一致するときだけ**指す）
    expect(
      resolveScenarioIds({ payer: "$A", participants: ["$A", "$B"], amount: 6000, memo: "A" }, ids),
    ).toEqual({ payer: "id-a", participants: ["id-a", "id-b"], amount: 6000, memo: "A" });
  });

  it("まだ登録していない名前を置き換えようとすれば例外にする（ID をでっち上げない）", () => {
    expect(() => resolveScenarioIds("$B", { A: "id-a" })).toThrow("$B の ID がまだ登録されていない");
  });

  it("bind を書かないシナリオ（expense-log）も、そのまま読める", () => {
    const scenarioWithoutBind = readScoringScenario(scenario());
    expect(scenarioIds(scenarioWithoutBind)).toEqual([]);
    expect(scenarioWithoutBind.steps[0]?.expect).toEqual({ accepted: true });
  });
});

describe("readNegativeIndex", () => {
  it("正しい形を読む", () => {
    expect(readNegativeIndex({ $comment: "注記", negatives: [negative()] })).toEqual({
      negatives: [negative()],
    });
  });

  it.each([
    ["負例が無い", { negatives: [] }, "index.negatives: 空でない配列ではない"],
    ["知らないキー", { negatives: [negative({ file: "x.yaml" })] }, "知らないキー file"],
    ["名前の形", { negatives: [negative({ name: "computed_cycle" })] }, "negatives[0].name"],
    ["同じ名前が 2 回ある", { negatives: [negative(), negative()] }, "computed-cycle が 2 回ある"],
    ["誤りコードが無い", { negatives: [negative({ codes: [] })] }, "codes: 空の配列"],
    ["誤りコードの形", { negatives: [negative({ codes: ["COMPUTED_CYCLE"] })] }, "codes[0]: COMPUTED_CYCLE"],
    ["説明が空", { negatives: [negative({ why: "" })] }, "why: 空でない文字列ではない"],
  ])("%s なら例外にする", (_label, value, reason) => {
    expect(() => readNegativeIndex(value)).toThrow(reason);
  });
});

// ── 台帳の見本の欄（M1.3 の張り替え漏れ。Issue #159） ────────────────────
//
// M1.3 の語彙（enum・default・date・today・set・when・board・filters）の「見本」は、
// **その語彙を実際に使っている見本**でなければならない。形の検査（欄が埋まっているか）だけでは、
// 「使っていない見本を指したまま」でも通ってしまう（#159 より前は、8 語とも warikan を指していた）。
// ここで宣言の字面と突き合わせて、張り替え漏れがあれば落ちるようにする。

interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const nodeFs = (await importUntyped("node:fs")) as NodeFs;

/** M1.3 の語彙 → 見本の宣言にその語彙があることを示す字面 */
const M13_SAMPLE_TOKENS: Readonly<Record<string, RegExp>> = {
  enum: /type: enum/,
  default: /^\s*default:/m,
  date: /^\s*due: date/m,
  today: /today\(\)/,
  set: /^\s*set:/m,
  when: /^\s*when:/m,
  board: /type: board/,
  filters: /^\s*filters:/m,
};

describe("台帳の見本の欄（M1.3 の張り替え漏れ）", () => {
  const ledger = readLedgerYaml(nodeFs.readFileSync(vocabularyFile(), "utf8"));

  it.each(Object.entries(M13_SAMPLE_TOKENS))(
    "%s の見本は、その語彙を使っている見本を指す",
    (name, token) => {
      const row = ledger.find((entry) => entry["name"] === name);
      if (row === undefined) throw new Error(`${name} が台帳に無い`);
      const samples = row["samples"];
      if (!Array.isArray(samples)) throw new Error(`${name} の samples が並びでない`);
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples as readonly string[]) {
        expect(nodeFs.readFileSync(sampleSpecFile(sample), "utf8"), `${name} の見本 ${sample}`).toMatch(
          token,
        );
      }
    },
  );
});
