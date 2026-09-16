// 採点のシナリオと負例の一覧の読み取り。形が違えば例外になることを見る（黙って読み飛ばすと、採点しなかったことが緑に化ける）。
import { describe, expect, it } from "vitest";
import { readNegativeIndex, readScoringScenario } from "./samples.js";

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
