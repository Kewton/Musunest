// ①' 逆照合（stages/reverse-check.ts）の unit テスト（02 §1・§1.2）。
//
// ここで固定したいのは 3 つ。
//   1. 原文に無い引用・位置のずれ・どの要件にも覆われない原文の文を、**コードが**見つける
//   2. 落ちがあれば ① をやり直し、やり直しても残る落ちを未達として返す
//   3. ①' が送る要求を観測する（規則とデータが別・原文と一覧だけ・JSON Schema が付く）
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { JobBudget } from "../budget.js";
import { CallGateway } from "../call.js";
import { AGENT_LIMITS } from "../limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
} from "../llm.js";
import type { RequirementList } from "../pipeline.js";
import {
  REVERSE_CHECK_CONDITION_KINDS,
  REVERSE_CHECK_CONDITION_LEDGER_KEY,
  REVERSE_CHECK_CONDITION_LEDGER_SCHEMA,
  REVERSE_CHECK_FINDING_DETAILS_KEY,
  REVERSE_CHECK_MEANING_RULE_DEFINITIONS,
  REVERSE_CHECK_RULES,
  REVERSE_CHECK_SCHEMA,
  REVERSE_CHECK_SCHEMA_NAME,
  checkRequirementCoverage,
  checkReverseCheckOutputWithConditionFindings,
  checkReverseCheckOutputWithConditionLedger,
  classifyConditionFindings,
  classifyConditionLedger,
  isBlankRange,
  isKnownConditionKind,
  overlappingSentences,
  parseConditionLedger,
  reverseCheckRulesOf,
  reverseCheckSchemaOf,
  restoreValidProvenance,
  runReverseCheck,
  runReverseCheckLoop,
  runReverseCheckLoopWithOperation,
  runReverseCheckWithDiagnosis,
  splitSourceSentences,
  summarizeConditionFindings,
  summarizeConditionLedger,
} from "./reverse-check.js";
import { ruleDefinitionDefects } from "./prompt.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";

/** 原文から引用の位置を求めて、要件 1 件を作る（Issue #925 の試験で使う） */
const meaningRequirementOf = (source: string, id: string, text: string, quote: string) => {
  const start = source.indexOf(quote);
  return { id, text, quote, position: { start, end: start + quote.length } };
};
/** P2 の要求か（schema の名前で見る。Issue #925 の試験で使う） */
const isReverseCheckRequest = (request: { readonly schemaName: string } | undefined): boolean =>
  request?.schemaName === REVERSE_CHECK_SCHEMA_NAME;
/** 要求の規則（無ければ空。Issue #925 の試験で使う） */
const rulesOfRequest = (request: { readonly rules?: readonly string[] } | undefined): readonly string[] =>
  request?.rules ?? [];

/** 引用が原文に無い一覧（①' の落ちを起こす） */
const BAD_LIST_OUTPUT = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を数える", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

const BAD_LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を数える", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

describe("コードが見つける落ち（02 §1・§1.2）", () => {
  it("原文を文に切り分ける（前後の空白を除く）", () => {
    expect(splitSourceSentences("タスクを記録する。件数を合計する。")).toEqual([
      { start: 0, end: 9 },
      { start: 9, end: 17 },
    ]);
  });

  it("引用が原文に無ければ quote-not-found", () => {
    const misses = checkRequirementCoverage(SOURCE_TEXT, BAD_LIST);
    expect(misses.map((miss) => miss.kind)).toContain("quote-not-found");
    const miss = misses.find((candidate) => candidate.kind === "quote-not-found");
    expect(miss?.requirementId).toBe("R-2");
  });

  it("引用はあるが位置がずれていれば position-mismatch", () => {
    const shifted: RequirementList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 1, end: 9 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const misses = checkRequirementCoverage(SOURCE_TEXT, shifted);
    expect(misses.some((miss) => miss.kind === "position-mismatch")).toBe(true);
  });

  it("どの要件にも覆われない原文の文を uncovered-source として見つける", () => {
    const partial: RequirementList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const misses = checkRequirementCoverage(SOURCE_TEXT, partial);
    const uncovered = misses.filter((miss) => miss.kind === "uncovered-source");
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]).toMatchObject({ kind: "uncovered-source", range: { start: 9, end: 17 } });
  });

  it("引用と位置が合い、原文の文が覆われていれば、落ちは無い", () => {
    expect(checkRequirementCoverage(SOURCE_TEXT, REQUIREMENT_LIST)).toEqual([]);
  });
});

// ── 位置と重なる文を、文の順にすべて返す（Issue #487）──────────────────────────

describe("位置と重なる文を、文の順にすべて返す（Issue #487）", () => {
  /** 3 文の原文（文の範囲は {0,9}・{9,17}・{17,22}） */
  const SOURCE = "タスクを記録する。件数を合計する。印を出す。";

  it("(a) 2 文・3 文にまたがる位置では、文の順の全部を返す", () => {
    expect(overlappingSentences(SOURCE, { start: 4, end: 12 })).toEqual([
      { start: 0, end: 9 },
      { start: 9, end: 17 },
    ]);
    expect(overlappingSentences(SOURCE, { start: 4, end: 19 })).toEqual([
      { start: 0, end: 9 },
      { start: 9, end: 17 },
      { start: 17, end: 22 },
    ]);
  });

  it("(a) 1 文の中の位置では、その 1 つだけを返す", () => {
    expect(overlappingSentences(SOURCE, { start: 4, end: 6 })).toEqual([{ start: 0, end: 9 }]);
    expect(overlappingSentences(SOURCE, { start: 12, end: 14 })).toEqual([{ start: 9, end: 17 }]);
  });

  it("(a) どの文とも重ならない位置では、空を返す", () => {
    expect(overlappingSentences(SOURCE, { start: 0, end: 0 })).toEqual([]);
    expect(overlappingSentences(SOURCE, { start: 9, end: 9 })).toEqual([]);
    expect(overlappingSentences(SOURCE, { start: 30, end: 40 })).toEqual([]);
  });

  it("(b) checkRequirementCoverage は、2 文にまたがる引用の要件で、両方の文を覆われていると数える（既存の期待を変えない）", () => {
    const spanning: RequirementList = {
      requirements: [
        {
          id: "R-1",
          text: "記録して合計できる",
          quote: "タスクを記録する。件数を合計する。",
          position: { start: 0, end: 17 },
        },
      ],
      decisions: [],
      unresolved: [],
    };
    // 引用が 2 文にまたがっても、重なる文をすべて覆われていると数えるので落ちは無い
    expect(checkRequirementCoverage(SOURCE_TEXT, spanning)).toEqual([]);
  });
});

describe("枠の文の覆い（Issue #372）", () => {
  /** 原文から引用の位置を求めて、要件 1 件を作る */
  function requirement(source: string, id: string, text: string, quote: string) {
    const start = source.indexOf(quote);
    return { id, text, quote, position: { start, end: start + quote.length } };
  }

  /** 原文から引用の位置を求めて、枠の文 1 件を作る */
  function framing(source: string, quote: string) {
    const start = source.indexOf(quote);
    return { quote, position: { start, end: start + quote.length } };
  }

  it("枠の文だけが要件に覆われていない原文で、覆いの検査の漏れが 0 件になる", () => {
    const source = "アプリを作ってください。タスクを記録する。";
    const list: RequirementList = {
      requirements: [requirement(source, "R-1", "タスクを記録できる", "タスクを記録する")],
      framing: [framing(source, "アプリを作ってください")],
      decisions: [],
      unresolved: [],
    };
    expect(checkRequirementCoverage(source, list)).toEqual([]);
  });

  it("枠でも要件でもない文が覆われていなければ、今までどおり漏れになる", () => {
    const source = "アプリを作ってください。タスクを記録する。件数を合計する。";
    const list: RequirementList = {
      requirements: [requirement(source, "R-1", "タスクを記録できる", "タスクを記録する")],
      framing: [framing(source, "アプリを作ってください")],
      decisions: [],
      unresolved: [],
    };
    const uncovered = checkRequirementCoverage(source, list).filter((miss) => miss.kind === "uncovered-source");
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]).toMatchObject({ range: { start: source.indexOf("件数を合計する。"), end: source.length } });
  });

  it("会話が挙げた範囲は、枠にすべて含まれるときだけ落ち、一部の重なりは差し引いた残りが残り、重ならないものはそのまま残る", async () => {
    const source = "ABCDEFGHIJ";
    const list: RequirementList = {
      requirements: [requirement(source, "R-1", "全部", "ABCDEFGHIJ")],
      framing: [framing(source, "CDE")],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 2, end: 5 }, { start: 1, end: 6 }, { start: 7, end: 9 }] }),
    ]);
    const outcome = await runReverseCheck({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    // 枠にすべて含まれる範囲は落ちる
    expect(ranges).not.toContain("2-5");
    // 一部だけ重なる範囲は、枠を差し引いた残りが残る
    expect(ranges).toContain("1-2");
    expect(ranges).toContain("5-6");
    // 重ならない範囲はそのまま残る
    expect(ranges).toContain("7-9");
  });

  it("枠の文に条件が混ざった原文で、条件の部分が覆われていなければ漏れになる", async () => {
    const source = "メモという名前のアプリを作ってください。タスクを記録する。";
    const framingPart = framing(source, "アプリを作ってください");
    const list: RequirementList = {
      requirements: [requirement(source, "R-1", "タスクを記録できる", "タスクを記録する")],
      framing: [framingPart],
      decisions: [],
      unresolved: [],
    };
    // コードは文ごとに見るので、枠に重なる文は覆われていると数える。条件は会話が挙げた範囲の差し引きで残す
    const firstSentence = splitSourceSentences(source)[0];
    expect(firstSentence).toBeDefined();
    if (firstSentence === undefined) return;
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: firstSentence.start, end: firstSentence.end }] }),
    ]);
    const outcome = await runReverseCheck({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 枠を差し引いた残り＝名前の条件の部分が、漏れとして残る
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    expect(ranges).toContain(`0-${framingPart.position.start}`);
  });
});

describe("①' → ① のやり直し（02 §1）", () => {
  it("落ちが無ければやり直さない", async () => {
    const recording = createRecordingClient([
      structured({
        requirements: REQUIREMENT_LIST.requirements,
        decisions: REQUIREMENT_LIST.decisions,
        unresolved: REQUIREMENT_LIST.unresolved,
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.unmet).toEqual([]);
  });

  it("落ちがあれば ① をやり直し、やり直しても残る落ちを未達として返す", async () => {
    const recording = createRecordingClient([
      structured(BAD_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(BAD_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.unmet.map((miss) => miss.kind)).toContain("quote-not-found");
    // ① → ①' → ①（やり直し） → ①' の 4 回が呼ばれる
    expect(recording.structured).toHaveLength(4);
  });
});

describe("①' が送る要求を観測する（02 §2.2・§1.2）", () => {
  it("原文と一覧だけをデータに置き、JSON Schema を付け、規則とデータを分ける", async () => {
    const recording = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    const outcome = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 原文と一覧の 2 つだけ
    expect(request.input.match(/<data name=/g)).toHaveLength(2);
    expect(request.input).toContain(SOURCE_TEXT);
    expect(request.input).toContain("要件の一覧");
    expect(request.instructions).not.toContain(SOURCE_TEXT);
    expect(request.schemaName).toBe(REVERSE_CHECK_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("原文に仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    await runReverseCheck({
      source: `${SOURCE_TEXT}${INJECTED_INSTRUCTION}`,
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("会話が挙げた覆われていない部分も、コードの落ちに足す（範囲外は捨てる）", async () => {
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 0, end: 3 }, { start: 90, end: 99 }] }),
    ]);
    const outcome = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    expect(ranges).toContain("0-3");
    expect(ranges).not.toContain("90-99");
    // 捨てた断片は無い（範囲外は元から落ちにしない）
    expect(outcome.value.droppedBlankMisses).toBe(0);
  });
});

// ── 対応の意味の基準（Issue #925）──────────────────────────────────────

describe("対応の意味の基準を、旗が有効なときだけ既存の 3 文の後ろに足す（Issue #925）", () => {
  /** 意味の基準の 4 文（定義の `text`） */
  const MEANING_TEXTS = REVERSE_CHECK_MEANING_RULE_DEFINITIONS.map((definition) => definition.text);

  it("定義は ID が `R-rcm-01`〜`04` の順で、why・since があり、ruleDefinitionDefects で不備 0", () => {
    expect(REVERSE_CHECK_MEANING_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "R-rcm-01",
      "R-rcm-02",
      "R-rcm-03",
      "R-rcm-04",
    ]);
    for (const definition of REVERSE_CHECK_MEANING_RULE_DEFINITIONS) {
      expect(definition.why.trim()).not.toBe("");
      expect(definition.since.trim()).not.toBe("");
    }
    expect(ruleDefinitionDefects(REVERSE_CHECK_MEANING_RULE_DEFINITIONS)).toEqual([]);
  });

  it("ID が規則の台帳の既存の ID と重ならない（台帳の行を読み、自分の 4 つの行を除いて照らす）", async () => {
    interface NodeFileSystem {
      readFileSync(path: URL, encoding: "utf8"): string;
    }
    const fs = (await import(/* @vite-ignore */ "node:fs")) as NodeFileSystem;
    const ledger = fs.readFileSync(
      new URL("../../../../workspace/mvp/m1/agent/methodology/ledger/rules.md", import.meta.url),
      "utf8",
    );
    const ours = new Set(REVERSE_CHECK_MEANING_RULE_DEFINITIONS.map((definition) => definition.id));
    const ledgerIds = ledger
      .split("\n")
      .flatMap((line) => {
        const match = /^\|\s*(R-[a-z0-9]+-\d+)\s*\|/.exec(line);
        const id = match?.[1];
        return id === undefined ? [] : [id];
      })
      // 自分の 4 つの行（窓口が後で足す）は除く——足した後も重なりを見ない
      .filter((id) => !ours.has(id));
    for (const id of ours) expect(ledgerIds, id).not.toContain(id);
    // 照らした台帳に既存の行があること（空の台帳を相手に緑にしない）
    expect(ledgerIds.length).toBeGreaterThan(0);
  });

  it("旗が無いときの規則は、既存の 3 文と同じ並び（バイト列を変えない）", () => {
    expect(reverseCheckRulesOf()).toEqual(REVERSE_CHECK_RULES);
    expect(reverseCheckRulesOf(false)).toEqual(REVERSE_CHECK_RULES);
    // 4 文は入らない
    expect(reverseCheckRulesOf().some((rule) => MEANING_TEXTS.includes(rule))).toBe(false);
  });

  it("旗が有効なときの規則は、既存の 3 文の後ろに `R-rcm-01`〜`04` の文が入る", () => {
    const rules = reverseCheckRulesOf(true);
    expect(rules.slice(0, REVERSE_CHECK_RULES.length)).toEqual(REVERSE_CHECK_RULES);
    expect(rules.slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("規則の文は、条件のすべてを本文が表すか・一部だけ・修飾は項目ごと・引用が覆っても本文が欠けば対応しない・迷うときは挙げる、を含む", () => {
    const joined = MEANING_TEXTS.join("\n");
    for (const phrase of [
      "条件のすべてを本文が表すとき対応",
      "一部だけなら挙げる",
      "修飾は項目ごとに確かめる",
      "引用が覆っても本文が欠けば対応しない",
      "迷うときは挙げる",
    ]) {
      expect(joined, phrase).toContain(phrase);
    }
  });

  it("規則の文に、題材の語・P 番号・要件 ID・観測の外の反例に挙げた種類の具体の語・観測した断片の語を含まない", () => {
    const joined = MEANING_TEXTS.join("\n").toLowerCase();
    // 題材の語（受入の題材）
    for (const word of ["タスク", "件数", "持ち寄り", "当番表", "会費", "出欠", "貸し出し"]) {
      expect(joined, word).not.toContain(word);
    }
    // 観測の外の反例に挙げた種類の、具体の語（隣の条件の例・評価や挨拶の語の例）
    for (const word of ["年齢", "人数", "画面", "使いやすい", "すばらしい", "ありがとう"]) {
      expect(joined, word).not.toContain(word);
    }
    // 観測した断片の語（題材の名前）
    for (const word of ["レシピ", "ログイン", "ボタン"]) {
      expect(joined, word).not.toContain(word);
    }
    // P 番号（P1・P2 など）と要件 ID。規則の ID（`R-rcm-`）も文には入れない
    expect(joined).not.toMatch(/(^|[^a-z])p[0-9]/);
    expect(joined).not.toMatch(/r-[a-z]+-[0-9]/);
    expect(joined).not.toContain("r-rcm-");
  });

  it("旗を渡すと P2 の 1 回の要求に 4 文が入り、渡さないと入らない（ループを通らない呼び出し）", async () => {
    const withRule = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(withRule.client, { maxAttempts: 1 }),
      meaningRule: true,
    });
    const withoutRule = createRecordingClient([structured(REVERSE_CHECK_OUTPUT)]);
    await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(withoutRule.client, { maxAttempts: 1 }),
    });
    const withRules = withRule.structured[0]?.rules ?? [];
    const withoutRules = withoutRule.structured[0]?.rules ?? [];
    expect(withRules.slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(withRules.slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
    expect(withoutRules).toEqual([...REVERSE_CHECK_RULES]);
    // 規則の文が違うだけで、データと schema は同じである
    expect(withRule.structured[0]?.input).toBe(withoutRule.structured[0]?.input);
    expect(withRule.structured[0]?.schema).toEqual(REVERSE_CHECK_SCHEMA);
    expect(withoutRule.structured[0]?.schema).toEqual(REVERSE_CHECK_SCHEMA);
  });

  it("旗を渡さないループの結果は、初回の落ちが無い組で前と変わらない（呼び出しの列も同じ）", async () => {
    const recording = createRecordingClient([
      structured({
        requirements: REQUIREMENT_LIST.requirements,
        decisions: REQUIREMENT_LIST.decisions,
        unresolved: REQUIREMENT_LIST.unresolved,
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.unmet).toEqual([]);
    expect(outcome.value.report.uncovered).toEqual([]);
    // P1 → P2 の 2 回だけ。P2 の要求の規則は 3 文のままである
    expect(recording.structured).toHaveLength(2);
    expect(recording.structured[1]?.rules).toEqual([...REVERSE_CHECK_RULES]);
  });
});

describe("ループの 3 つの P2 の要求に、旗が有効なときだけ意味の基準が入る（Issue #925）", () => {
  /** 意味の基準の 4 文（定義の `text`） */
  const MEANING_TEXTS = REVERSE_CHECK_MEANING_RULE_DEFINITIONS.map((definition) => definition.text);

  it("(a) 初回の P2 の要求に、既存の 3 文の後ろに 4 文が入る", async () => {
    const recording = createRecordingClient([
      structured({
        requirements: REQUIREMENT_LIST.requirements,
        decisions: REQUIREMENT_LIST.decisions,
        unresolved: REQUIREMENT_LIST.unresolved,
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      meaningRule: true,
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[1];
    expect(isReverseCheckRequest(request)).toBe(true);
    expect(rulesOfRequest(request).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOfRequest(request).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("(b) 全体の作り直しの後の P2 の要求にも 4 文が入る", async () => {
    // 初回の P2 が覆いの落ちを申告して作り直しへ進む（覆いを含む落ちは修復へ行かない）
    const source = "タスクを記録する。件数を合計する。印を出す。";
    const first = {
      requirements: [
        meaningRequirementOf(source, "R-1", "タスクを記録できる", "タスクを記録する。"),
        meaningRequirementOf(source, "R-2", "件数を合計できる", "件数を合計する。"),
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const redone = {
      requirements: [
        ...first.requirements,
        meaningRequirementOf(source, "R-3", "印を出せる", "印を出す。"),
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(first),
      structured({ uncovered: [{ start: 17, end: 22 }] }),
      structured(redone),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      meaningRule: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(true);
    expect(recording.structured).toHaveLength(4);
    // 2 回目の P2（添字 3）に 4 文が入る
    const redoneRequest = recording.structured[3];
    expect(isReverseCheckRequest(redoneRequest)).toBe(true);
    expect(rulesOfRequest(redoneRequest).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOfRequest(redoneRequest).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("(c) 引用の修復の後の P2 の要求にも 4 文が入る", async () => {
    // 初回の落ちが来歴だけ（引用が原文に無い）なので、修復へ進む
    const source = "記録する。合計する。";
    const list = {
      requirements: [
        meaningRequirementOf(source, "R-1", "記録できる", "記録する。"),
        { id: "R-2", text: "合計できる", quote: "原文に無い", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const repaired = {
      requirements: [
        meaningRequirementOf(source, "R-1", "記録できる", "記録する。"),
        meaningRequirementOf(source, "R-2", "合計できる", "合計する。"),
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured({ uncovered: [] }),
      structured({ repairs: [{ index: 1, quote: "合計する。", position: { start: 5, end: 10 } }] }),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
      meaningRule: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repaired).toBe(true);
    // 修復で当たった一覧は、前の一覧のうち指された候補だけを差し替えたもの
    expect(outcome.value.list.requirements[1]).toEqual(repaired.requirements[1]);
    expect(outcome.value.trace?.rounds.map((round) => round.fix)).toEqual(["initial", "quote-repair"]);
    expect(recording.structured).toHaveLength(4);
    // 修復の後の P2（添字 3）に 4 文が入る
    const afterRequest = recording.structured[3];
    expect(isReverseCheckRequest(afterRequest)).toBe(true);
    expect(rulesOfRequest(afterRequest).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOfRequest(afterRequest).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("(d) 旗を渡さないときの 3 つの P2 の要求は、どれも 3 文のままである（バイト列を変えない）", async () => {
    // 初回が来歴だけ（引用が 2 か所） → 修復 → 修復の後の P2 が覆いを含む → 作り直し → P2。3 つの往復がそろう
    const source = "印を出す。印を出す。件数を合計する。";
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const redone = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured({ uncovered: [] }),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      structured({ uncovered: [{ start: 0, end: 3 }] }),
      structured(redone),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    const reverseRequests = recording.structured.filter(isReverseCheckRequest);
    expect(reverseRequests).toHaveLength(3);
    for (const request of reverseRequests) {
      expect(rulesOfRequest(request)).toEqual([...REVERSE_CHECK_RULES]);
      expect(rulesOfRequest(request).some((rule) => MEANING_TEXTS.includes(rule))).toBe(false);
    }
  });
});

describe("①' の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ uncovered: "nope" }), structured({ uncovered: "nope" })]);
    const failed = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");

    const recovered = createRecordingClient([structured({ uncovered: "nope" }), structured(REVERSE_CHECK_OUTPUT)]);
    const retried = await runReverseCheck({
      source: SOURCE_TEXT,
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(recovered.client),
    });
    expect(retried.ok).toBe(true);
  });
});

describe("中身の無い落ちを捨てる（Issue #377）", () => {
  /** 原文から引用の位置を求めて、要件 1 件を作る */
  function requirement(source: string, id: string, text: string, quote: string) {
    const start = source.indexOf(quote);
    return { id, text, quote, position: { start, end: start + quote.length } };
  }

  /** 原文の一部を覆う要件 1 件だけの一覧 */
  function listCovering(source: string, quote: string): RequirementList {
    return { requirements: [requirement(source, "R-1", "記録できる", quote)], decisions: [], unresolved: [] };
  }

  it("中身の無い範囲の判定は、空白・改行と列挙した記号だけを中身が無いと見なす", () => {
    const source = " \t\n-*・•‐–—、。，．,.:：;；あ";
    expect(isBlankRange(source, { start: 0, end: source.length - 1 })).toBe(true);
    expect(isBlankRange(source, { start: 0, end: source.length })).toBe(false);
    expect(isBlankRange(source, { start: 3, end: 3 })).toBe(true);
  });

  it("改行だけ・空白だけ・記号だけの範囲は、会話が返しても落ちにならない", async () => {
    const source = "タスクを記録する。\n   \n・\n";
    const recording = createRecordingClient([
      structured({
        uncovered: [
          { start: 9, end: 10 },
          { start: 10, end: 13 },
          { start: 13, end: 14 },
          { start: 14, end: 15 },
          { start: 15, end: 16 },
        ],
      }),
    ]);
    const outcome = await runReverseCheck({
      source,
      list: listCovering(source, "タスクを記録する。"),
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.uncovered).toEqual([]);
    expect(outcome.value.droppedBlankMisses).toBe(5);
  });

  it("原文に記号だけの行があっても、覆いの検査で落ちにならず、やり直しが起きない", async () => {
    const source = "タスクを記録する。\n・\n件数を合計する。";
    expect(splitSourceSentences(source)).toEqual([
      { start: 0, end: 9 },
      { start: 12, end: 20 },
    ]);
    const recording = createRecordingClient([
      structured({
        requirements: [
          { id: "R-1", text: "記録できる", quote: "タスクを記録する。", position: { start: 0, end: 9 } },
          { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 12, end: 20 } },
        ],
        decisions: [],
        unresolved: [],
      }),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoop({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.report.misses).toEqual([]);
    expect(outcome.value.report.droppedBlankMisses).toBe(0);
    // ① と ①' の 2 回だけ（やり直しの 2 回は呼ばれない）
    expect(recording.structured).toHaveLength(2);
  });

  it("枠を差し引いた残りが句読点と空白だけなら捨て、中身のある断片は原文の上の位置のまま残す", async () => {
    const source = "a、frm、b";
    const list: RequirementList = {
      requirements: [requirement(source, "R-1", "全部", source)],
      framing: [{ quote: "frm", position: { start: 2, end: 5 } }],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 1, end: 7 }] }),
    ]);
    const outcome = await runReverseCheck({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    // 枠（2-5）を差し引くと 1-2（「、」だけ）と 5-7（「、b」）に分かれる。前者だけ捨てる
    expect(ranges).not.toContain("1-2");
    expect(ranges).toContain("5-7");
    expect(outcome.value.droppedBlankMisses).toBe(1);
  });

  it("前後に空白のついた、中身のある文の範囲は、落ちのまま残る", async () => {
    const source = "タスクを記録する。\n件数を合計する。\n";
    const list: RequirementList = {
      requirements: [
        requirement(source, "R-1", "記録できる", "タスクを記録する。"),
        requirement(source, "R-2", "合計できる", "件数を合計する。"),
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 9, end: 19 }] }),
    ]);
    const outcome = await runReverseCheck({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ranges = outcome.value.uncovered.map((range) => `${range.start}-${range.end}`);
    // 前後の空白を詰めた 10-18 が、落ちのまま残る
    expect(ranges).toContain("10-18");
    expect(outcome.value.droppedBlankMisses).toBe(0);
  });
});

describe("① の位置の正規化と逆照合（Issue #382）", () => {
  /** 原文から引用の位置を求め、1 文字後ろへずらした位置（引用は正しい） */
  function shiftedSpan(source: string, quote: string) {
    const start = source.indexOf(quote);
    return { start: start + 1, end: start + quote.length + 1 };
  }

  it("要件の段の応答の位置がずれていても（引用は正しい）、逆照合のループで要件の段の呼び出しは 1 回のままで、やり直しにならない", async () => {
    const shifted = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを記録する", position: shiftedSpan(SOURCE_TEXT, "タスクを記録する") },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: shiftedSpan(SOURCE_TEXT, "件数を合計する") },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([structured(shifted), structured({ uncovered: [] })]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // ① が位置を直すので、①' の落ちは無く、やり直しにならない（① と ①' の 2 回だけ）
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.report.misses).toEqual([]);
    expect(recording.structured).toHaveLength(2);
  });

  it("位置の食い違った要件の一覧を逆照合に直接渡したときは、今までどおり位置の食い違いの落ちになる", () => {
    const shifted: RequirementList = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 1, end: 9 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const misses = checkRequirementCoverage(SOURCE_TEXT, shifted);
    const mismatch = misses.find((miss) => miss.kind === "position-mismatch");
    expect(mismatch?.requirementId).toBe("R-1");
  });
});

// ── ① と ①' の停止に、どの呼び出しかを付ける（Issue #397）────────────────

describe("① と ①' の停止に、どの呼び出しかを付ける（Issue #397）", () => {
  /** `failAt` 回目の呼び出しでだけ要求の誤りを投げる偽物の呼び出し */
  function clientThrowingAt(failAt: number, recorded: readonly { kind: "structured"; output: unknown; usage: undefined }[]): LlmClient {
    const inner = createRecordingClient(recorded);
    let calls = 0;
    return {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        if (calls === failAt) {
          throw Object.assign(new Error("要求が不正です"), {
            kind: "invalidRequest",
            code: "invalid_json_schema",
          });
        }
        return inner.client.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
        return inner.client.callWithTools(request);
      },
    };
  }

  it("① で打ち切られると operation: requirements、①' で要求の誤りなら operation: reverse-check", async () => {
    const requirementsOutcome = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(clientThrowingAt(1, []), { maxAttempts: 1 }),
    });
    expect(requirementsOutcome.ok).toBe(false);
    if (requirementsOutcome.ok) return;
    expect(requirementsOutcome.operation).toBe("requirements");
    expect(requirementsOutcome.failure.kind).toBe("invalidRequest");

    const reverseCheckOutcome = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(clientThrowingAt(2, [structured(REQUIREMENT_LIST_OUTPUT)]), { maxAttempts: 1 }),
    });
    expect(reverseCheckOutcome.ok).toBe(false);
    if (reverseCheckOutcome.ok) return;
    expect(reverseCheckOutcome.operation).toBe("reverse-check");
    expect(reverseCheckOutcome.failure.kind).toBe("invalidRequest");
  });

  it("やり直しの ① で止まれば requirements-redo、①' で止まれば reverse-check-redo", async () => {
    const redo = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(
        clientThrowingAt(3, [structured(BAD_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT)]),
        { maxAttempts: 1 },
      ),
    });
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.operation).toBe("requirements-redo");

    const redoReverse = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(
        clientThrowingAt(4, [
          structured(BAD_LIST_OUTPUT),
          structured(REVERSE_CHECK_OUTPUT),
          structured(BAD_LIST_OUTPUT),
        ]),
        { maxAttempts: 1 },
      ),
    });
    expect(redoReverse.ok).toBe(false);
    if (redoReverse.ok) return;
    expect(redoReverse.operation).toBe("reverse-check-redo");
  });
});

// ── 往復ごとの落ちの件数の内訳（種類ごと・出どころごと。Issue #430）──────────────

describe("往復ごとの落ちの件数の内訳（種類ごと・出どころごと。Issue #430）", () => {
  /**
   * 引用が原文に無い要件（R-2）と、覆われない原文の文（2 文目）を作る一覧。R-2 の位置を {0,0} に
   * して、コードの覆いの検査で 2 文目が覆われないようにする（引用の落ちと覆いの落ちを同時に作る）。
   */
  const ROUND_LIST = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
      { id: "R-2", text: "合計できる", quote: "件数を数える", position: { start: 0, end: 0 } },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };
  /** 会話が挙げた、覆われていない部分（コードの落ちとは重ならない） */
  const ROUND_CONVERSATION = { uncovered: [{ start: 0, end: 3 }] };
  /** 往復 1 の期待する内訳（引用なし 1・覆われない原文はコード 1・会話 1） */
  const ROUND_COUNTS = {
    quoteNotFound: 1,
    positionMismatch: 0,
    uncoveredSource: { code: 1, conversation: 1 },
  };

  /** `failAt` 回目の呼び出しでだけ要求の誤りを投げる偽物の呼び出し */
  function clientThrowingAt(
    failAt: number,
    recorded: readonly { kind: "structured"; output: unknown; usage: undefined }[],
  ): LlmClient {
    const inner = createRecordingClient(recorded);
    let calls = 0;
    return {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        if (calls === failAt) {
          throw Object.assign(new Error("要求が不正です"), { kind: "invalidRequest", code: "invalid_json_schema" });
        }
        return inner.client.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
        return inner.client.callWithTools(request);
      },
    };
  }

  it("往復 1 の内訳が種類ごと・出どころごとに一致し、やり直し後の往復 2 の内訳と unmet の内訳が一致する", async () => {
    const recording = createRecordingClient([
      structured(ROUND_LIST),
      structured(ROUND_CONVERSATION),
      structured(ROUND_LIST),
      structured(ROUND_CONVERSATION),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 往復 2（初回 + やり直し）
    expect(outcome.value.diagnosis.rounds).toHaveLength(2);
    expect(outcome.value.diagnosis.redone).toBe(true);
    // 往復 1 の内訳が、種類ごと・出どころごとに一致する
    expect(outcome.value.diagnosis.rounds[0]?.misses).toEqual(ROUND_COUNTS);
    // やり直し後の往復 2 の内訳と、unmet の内訳が一致する
    expect(outcome.value.diagnosis.rounds[1]?.misses).toEqual(outcome.value.diagnosis.unmet);
    expect(outcome.value.diagnosis.unmet).toEqual(ROUND_COUNTS);
  });

  it("落ちが無ければ、往復 1 つだけで、種類ごと・出どころごとに全部 0 になる", async () => {
    const recording = createRecordingClient([
      structured({
        requirements: REQUIREMENT_LIST.requirements,
        decisions: REQUIREMENT_LIST.decisions,
        unresolved: REQUIREMENT_LIST.unresolved,
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const zero = { quoteNotFound: 0, positionMismatch: 0, uncoveredSource: { code: 0, conversation: 0 } };
    expect(outcome.value.diagnosis.rounds).toEqual([
      {
        misses: zero,
        droppedBlankMisses: 0,
        sentenceCount: 2,
        requirementCount: 2,
        sentences: [
          { sentence: 1, requirements: [1], framing: false },
          { sentence: 2, requirements: [2], framing: false },
        ],
        missEntries: [],
        fix: "initial",
      },
    ]);
    expect(outcome.value.diagnosis.redone).toBe(false);
    expect(outcome.value.diagnosis.unmet).toEqual(zero);
  });

  it("中身の無い断片を捨てた数が、往復ごとの内訳に入る", async () => {
    const source = "タスクを記録する。\n   \n・\n";
    const list = {
      requirements: [{ id: "R-1", text: "記録できる", quote: "タスクを記録する。", position: { start: 0, end: 9 } }],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured({
        uncovered: [
          { start: 9, end: 10 },
          { start: 10, end: 13 },
          { start: 13, end: 14 },
          { start: 14, end: 15 },
          { start: 15, end: 16 },
        ],
      }),
    ]);
    const outcome = await runReverseCheckLoop({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.diagnosis.rounds).toHaveLength(1);
    expect(outcome.value.diagnosis.rounds[0]?.droppedBlankMisses).toBe(5);
  });

  it("内訳には、引用・原文の断片・位置の値が入らない（件数だけ）", async () => {
    const mark = "MARK_RC_QUOTE";
    const source = `${mark}する。件数を合計する。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${mark}する`, position: spanOf(`${mark}する`) },
        { id: "R-2", text: "合計できる", quote: "件数を数える", position: { start: 0, end: 0 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured({ uncovered: [{ start: 0, end: 2 }] }),
      structured(list),
      structured({ uncovered: [{ start: 0, end: 2 }] }),
    ]);
    const outcome = await runReverseCheckLoop({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 内訳は件数だけである（引用の目印・原文の断片は入らない）
    const text = JSON.stringify(outcome.value.diagnosis);
    expect(text).not.toContain(mark);
    expect(text).not.toContain("件数を");
  });

  it("止まったときは、止まるまでに終えた往復の分だけの内訳を返す", async () => {
    // ①' の 1 回目で止まる → 往復は 0
    const atReverseCheck = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(clientThrowingAt(2, [structured(ROUND_LIST)]), { maxAttempts: 1 }),
    });
    expect(atReverseCheck.ok).toBe(false);
    if (atReverseCheck.ok) return;
    expect(atReverseCheck.operation).toBe("reverse-check");
    expect(atReverseCheck.diagnosis.rounds).toEqual([]);

    // ① のやり直しで止まる → 往復 1（初回の逆照合まで終えた）。① のやり直し自体が失敗したので `redone` は false
    const atRedo = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(
        clientThrowingAt(3, [structured(ROUND_LIST), structured(ROUND_CONVERSATION)]),
        { maxAttempts: 1 },
      ),
    });
    expect(atRedo.ok).toBe(false);
    if (atRedo.ok) return;
    expect(atRedo.operation).toBe("requirements-redo");
    expect(atRedo.diagnosis.rounds).toHaveLength(1);
    expect(atRedo.diagnosis.rounds[0]?.misses).toEqual(ROUND_COUNTS);
    expect(atRedo.diagnosis.redone).toBe(false);

    // ①' のやり直しで止まる → 往復 1。① のやり直しは成功しているので `redone` は true（Issue #430 の直し）
    const atRedoReverse = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(
        clientThrowingAt(4, [structured(ROUND_LIST), structured(ROUND_CONVERSATION), structured(ROUND_LIST)]),
        { maxAttempts: 1 },
      ),
    });
    expect(atRedoReverse.ok).toBe(false);
    if (atRedoReverse.ok) return;
    expect(atRedoReverse.operation).toBe("reverse-check-redo");
    expect(atRedoReverse.diagnosis.rounds).toHaveLength(1);
    expect(atRedoReverse.diagnosis.redone).toBe(true);
  });
});

// ── Plan の記録に、番号・有限の分類で対応を残す（Issue #488）────────────────────

describe("Plan の記録に、番号・有限の分類で対応を残す（Issue #488）", () => {
  /** 原文から引用の位置を求めて、候補要件 1 件を作る */
  function requirementOf(source: string, id: string, text: string, quote: string) {
    const start = source.indexOf(quote);
    return { id, text, quote, position: { start, end: start + quote.length } };
  }
  /** 原文から引用の位置を求める */
  function spanOf(source: string, quote: string): { readonly start: number; readonly end: number } {
    const start = source.indexOf(quote);
    return { start, end: start + quote.length };
  }
  /** 1 回の逆照合を回して、往復の診断を組む（やり直しは起こさない） */
  async function diagnoseOnce(source: string, list: RequirementList, uncovered: readonly { start: number; end: number }[]) {
    const recording = createRecordingClient([structured({ uncovered })]);
    const outcome = await runReverseCheckWithDiagnosis({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return undefined;
    return outcome.value.round;
  }

  it("(a) 3 文の原文で、2 文にまたがる候補要件と会話の指摘 1 件の文ごとの覆いと、指摘の行が番号で残る", async () => {
    const source = "記録する。合計する。印を出す。";
    const list: RequirementList = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        // 2 文目・3 文目にまたがる引用（位置も 2 文にまたがる）
        { id: "R-2", text: "合計して印を出せる", quote: "合計する。印を出す。", position: { start: 5, end: 15 } },
      ],
      framing: [{ quote: "印を出す。", position: spanOf(source, "印を出す。") }],
      decisions: [],
      unresolved: [],
    };
    // 構造上覆われた文（1 文目）への、会話の指摘
    const diagnosis = await diagnoseOnce(source, list, [{ start: 0, end: 2 }]);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    expect(diagnosis.sentenceCount).toBe(3);
    expect(diagnosis.requirementCount).toBe(2);
    expect(diagnosis.sentences).toEqual([
      { sentence: 1, requirements: [1], framing: false },
      { sentence: 2, requirements: [2], framing: false },
      { sentence: 3, requirements: [2], framing: true },
    ]);
    // 指摘の行は、種類 uncovered-source・見つけた側「会話」・文番号を持つ
    expect(diagnosis.missEntries).toEqual([
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: false },
    ]);
    // その文の構造上の覆いは、当該文番号（1 文目）の覆いの行で確かめる
    expect(diagnosis.sentences[0]?.requirements).toEqual([1]);
  });

  it("(b) 引用が原文に無い候補要件は、種類 quote-not-found・見つけた側「コード」・通し番号・空の文番号の行になる", async () => {
    const source = "記録する。合計する。";
    const list: RequirementList = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        // 引用が原文に無い（位置は 2 文目を覆うが、引用の実在の検査で落ちる）
        { id: "R-2", text: "何かできる", quote: "原文に無い", position: { start: 5, end: 10 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const diagnosis = await diagnoseOnce(source, list, []);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    expect(diagnosis.missEntries).toEqual([
      { kind: "quote-not-found", foundBy: "code", sentences: [], requirements: [2], framingOverlap: false },
    ]);
    // 位置が 2 文目を覆っていても、引用が無いので落ちの文番号は空である
    expect(diagnosis.sentences).toEqual([
      { sentence: 1, requirements: [1], framing: false },
      { sentence: 2, requirements: [2], framing: false },
    ]);
  });

  it("(c) やり直しのある組で、往復ごとの通し番号はその往復の一覧の順で数えられる", async () => {
    const source = "記録する。";
    // 往復 1 は R-1 が先、往復 2 は同じ要件が逆の順で来る
    const first = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        { id: "R-2", text: "何かできる", quote: "原文に無い", position: { start: 0, end: 0 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const second = {
      requirements: [
        { id: "R-2", text: "何かできる", quote: "原文に無い", position: { start: 0, end: 0 } },
        requirementOf(source, "R-1", "記録できる", "記録する。"),
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(first),
      structured({ uncovered: [] }),
      structured(second),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoop({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.diagnosis.rounds).toHaveLength(2);
    const ordinalOfQuoteMiss = (round: number) =>
      outcome.value.diagnosis.rounds[round]?.missEntries.find((entry) => entry.kind === "quote-not-found")?.requirements;
    // 往復 1 では 2 番目、往復 2 では 1 番目（通し番号は往復ごとの一覧の順で数える）
    expect(ordinalOfQuoteMiss(0)).toEqual([2]);
    expect(ordinalOfQuoteMiss(1)).toEqual([1]);
  });

  it("(c2) 位置の食い違い・覆われない文・コードと同じ範囲の会話の行全体が一致し、既存の件数とも合う", async () => {
    const source = "記録する。合計する。印を出す。";
    const list: RequirementList = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        requirementOf(source, "R-2", "合計できる", "合計する。"),
        // 引用は実在するが位置がずれる（R-3 の位置は 1 文目と 2 文目に重なる）
        { id: "R-3", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    // コードの落ち（3 文目）と同じ範囲を会話も挙げる（重複でコードを優先し、会話の行は作らない）
    const diagnosis = await diagnoseOnce(source, list, [{ start: 10, end: 15 }]);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    expect(diagnosis.sentences).toEqual([
      { sentence: 1, requirements: [1, 3], framing: false },
      { sentence: 2, requirements: [2, 3], framing: false },
      { sentence: 3, requirements: [], framing: false },
    ]);
    expect(diagnosis.missEntries).toEqual([
      { kind: "position-mismatch", foundBy: "code", sentences: [1, 2], requirements: [3], framingOverlap: false },
      { kind: "uncovered-source", foundBy: "code", sentences: [3], requirements: [], framingOverlap: false },
    ]);
    // 既存の種類別・検出側別の件数は、行の全体と合う
    expect(diagnosis.misses).toEqual({
      quoteNotFound: 0,
      positionMismatch: 1,
      uncoveredSource: { code: 1, conversation: 0 },
    });
  });

  it("(c2) 枠を差し引いて複数の断片になる会話の指摘は、断片ごとに文番号を持つ行になる", async () => {
    const source = "αβ。γδ。";
    const list: RequirementList = {
      requirements: [{ id: "R-1", text: "全部", quote: source, position: { start: 0, end: source.length } }],
      framing: [{ quote: "β", position: spanOf(source, "β") }],
      decisions: [],
      unresolved: [],
    };
    // 枠（β）を差し引くと {0,1} と {2,5} の 2 断片に分かれる。どちらも、元の範囲が枠と重なっていたことを引き継ぐ
    const diagnosis = await diagnoseOnce(source, list, [{ start: 0, end: 5 }]);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    expect(diagnosis.missEntries).toEqual([
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: true },
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1, 2], requirements: [1], framingOverlap: true },
    ]);
    expect(diagnosis.droppedBlankMisses).toBe(0);
  });

  it("(d) 診断を JSON にしても、原文の文・引用・文字の位置・候補要件の ID が出ない", async () => {
    const mark = "MARK_RC_488";
    const source = `${mark}する。合計する。`;
    const list: RequirementList = {
      requirements: [
        requirementOf(source, "R-1", "印を出せる", `${mark}する。`),
        { id: "R-2", text: "合計できる", quote: "原文に無い", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const diagnosis = await diagnoseOnce(source, list, [{ start: 0, end: 2 }]);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    const text = JSON.stringify(diagnosis);
    expect(text).not.toContain(mark);
    expect(text).not.toContain("合計する");
    expect(text).not.toContain("R-1");
    expect(text).not.toContain("R-2");
    // 文字の位置（start／end）は、番号に写しても残らない
    expect(text).not.toContain('"start"');
    expect(text).not.toContain('"end"');
    // 既存の件数の欄は変わらない（種類ごと・出どころごと）
    expect(diagnosis.misses).toEqual({
      quoteNotFound: 1,
      positionMismatch: 0,
      uncoveredSource: { code: 1, conversation: 1 },
    });
    expect(diagnosis.droppedBlankMisses).toBe(0);
  });

  it("(指摘1) 枠をまたぐ元の申告と、同じ断片を個別に申告した組を、枠の重なりの真偽で区別する", async () => {
    const source = "αXβ";
    const list: RequirementList = {
      requirements: [{ id: "R-1", text: "全部", quote: source, position: { start: 0, end: source.length } }],
      framing: [{ quote: "X", position: { start: 1, end: 2 } }],
      decisions: [],
      unresolved: [],
    };
    // 枠（X）をまたぐ 1 件の申告（差し引くと {0,1}・{2,3} の 2 断片）
    const spanning = await diagnoseOnce(source, list, [{ start: 0, end: 3 }]);
    // まったく同じ 2 断片を、枠と重ならない範囲として個別に申告する
    const separate = await diagnoseOnce(source, list, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    expect(spanning).toBeDefined();
    expect(separate).toBeDefined();
    if (spanning === undefined || separate === undefined) return;
    // 断片の番号は同じでも、元の申告が枠をまたいだかで行が変わる（元の範囲・位置は出さない）
    expect(spanning.missEntries).toEqual([
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: true },
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: true },
    ]);
    expect(separate.missEntries).toEqual([
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: false },
      { kind: "uncovered-source", foundBy: "conversation", sentences: [1], requirements: [1], framingOverlap: false },
    ]);
    // 件数（既存の欄）は同じである
    expect(spanning.misses).toEqual(separate.misses);
    expect(JSON.stringify({ spanning, separate })).not.toContain('"start"');
  });

  it("(指摘5) 候補要件の ID が重複しても、落ちは検出時の候補の通し番号に結ぶ", async () => {
    const source = "記録する。合計する。";
    const list: RequirementList = {
      requirements: [
        // 1 番目は正しい引用・位置
        { id: "R-dup", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
        // 2 番目は同じ ID で、引用が原文に無い（位置は 2 文目を覆う）
        { id: "R-dup", text: "無い", quote: "原文に無い", position: { start: 5, end: 10 } },
        // 3 番目も同じ ID で、位置がずれる（位置は 1・2 文目に重なる）
        { id: "R-dup", text: "合計できる", quote: "合計する。", position: { start: 1, end: 6 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const diagnosis = await diagnoseOnce(source, list, []);
    expect(diagnosis).toBeDefined();
    if (diagnosis === undefined) return;
    // ID で最初の候補へ寄せず、検出時の位置（2 番目・3 番目）の通し番号になる
    expect(diagnosis.missEntries).toEqual([
      { kind: "quote-not-found", foundBy: "code", sentences: [], requirements: [2], framingOverlap: false },
      { kind: "position-mismatch", foundBy: "code", sentences: [1, 2], requirements: [3], framingOverlap: false },
    ]);
    // 覆われない文は無い（どの落ちも、削除ではなく候補の番号の問題である）
    expect(diagnosis.misses).toEqual({
      quoteNotFound: 1,
      positionMismatch: 1,
      uncoveredSource: { code: 0, conversation: 0 },
    });
    // 既存の件数の欄も、ID の重複で変わらない
    expect(checkRequirementCoverage(source, list).map((miss) => miss.kind)).toEqual([
      "quote-not-found",
      "position-mismatch",
    ]);
  });
});

// ── 引用の修復と経路の表（Issue #917）──────────────────────────────────────
//
// 落ちが**来歴だけ**（引用の不在・位置の不一致だけ）のとき、全体を作り直す代わりに、落ちを指された候補の
// 引用と位置だけを出す。**Plan の経路が明示の選択（`quoteRepair: true`）で有効にしたときだけ**使う。

/** 同じ句が 2 か所ある原文（位置の不一致の修復の題材。受入の題材の言葉は使わない） */
const REPAIR_SOURCE = "印を出す。印を出す。件数を合計する。";
/** 原文の開始位置から引用の範囲を作る */
const REPAIR_SPAN = (quote: string, from = 0): { readonly start: number; readonly end: number } => {
  const start = REPAIR_SOURCE.indexOf(quote, from);
  return { start, end: start + quote.length };
};

describe("引用の修復：指された候補の引用と位置だけを直す（Issue #917）", () => {
  it("位置の不一致だけの落ち（引用が 2 か所）では、2 回目の呼び出しが引用の修復で、指されていない候補はバイト列で同じ", async () => {
    // R-1 の引用「印を出す。」は原文に 2 か所。位置 1-6 はどちらとも一致しない（P1 の正規化でも直らない）
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") },
      ],
      framing: [{ quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") }],
      decisions: ["記録の形は 1 行とした"],
      unresolved: ["未解決の事項"],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      // 修復の応答は、対象の番号（R-1 = 0）の引用と位置だけを返す（前後を含めて 1 か所に決まる引用）
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 12 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: REPAIR_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 2 回目の呼び出しは引用の修復で、要件の本文を出させる欄が無い
    const repairRequest = recording.structured[2];
    expect(repairRequest?.schemaName).toBe("requirement-quote-repair");
    const schema = repairRequest?.schema as {
      readonly properties: { readonly repairs: { readonly items: { readonly properties: Record<string, unknown> } } };
    };
    expect(new Set(Object.keys(schema.properties))).toEqual(new Set(["repairs"]));
    expect(new Set(Object.keys(schema.properties.repairs.items.properties))).toEqual(new Set(["index", "position", "quote"]));
    // 直した一覧で、指されていない候補の id・本文・引用・位置と、枠・decisions・unresolved が前と同じ
    expect(outcome.value.list.requirements.slice(1)).toEqual(list.requirements.slice(1));
    expect(outcome.value.list.framing).toEqual(list.framing);
    expect(outcome.value.list.decisions).toEqual(list.decisions);
    expect(outcome.value.list.unresolved).toEqual(list.unresolved);
    // 指された候補の id・本文も同じで、引用と位置だけが直っている
    expect(outcome.value.list.requirements[0]?.id).toBe("R-1");
    expect(outcome.value.list.requirements[0]?.text).toBe("印を出せる");
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。印を出す。");
    // 全体の作り直しはしていない（修復だけ）
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.unmet).toEqual([]);
    // 往復の診断に、直し方（有限の値）が載る。引用・位置の値は載らない
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial", "quote-repair"]);
    const text = JSON.stringify(outcome.value.diagnosis);
    expect(text).not.toContain("印を出す");
    expect(text).not.toContain("件数を");
  });

  it("引用の不在だけの落ちでも、同じく修復で直り、指されていない候補は変わらない", async () => {
    const list = {
      requirements: [
        // 引用は原文に無いが、位置は 1 文目・2 文目を覆っている（覆いの落ちを作らない）
        { id: "R-1", text: "印を出せる", quote: "原文に無い引用", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: REPAIR_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.list.requirements[1]).toEqual(list.requirements[1]);
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。印を出す。");
    expect(outcome.value.unmet).toEqual([]);
  });

  it("位置の不一致の修復で、元の引用を含まない新しい引用は当てず、落ちとして残る", async () => {
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") },
      ],
      decisions: [],
      unresolved: [],
    };
    // 位置の不一致の修復に、元の引用「印を出す。」を含まない引用を返す
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured({ repairs: [{ index: 0, quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: REPAIR_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 元の引用を含まない修復は当てない（引用は前のまま。位置の不一致の落ちが残る）
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。");
    expect(outcome.value.unmet.map((miss) => miss.kind)).toContain("position-mismatch");
    // 指されていない R-2 は変わらない
    expect(outcome.value.list.requirements[1]).toEqual(list.requirements[1]);
  });

  it("同じ id の候補が 2 つあり片方だけが落ちたとき、修復は位置（添字）で当たり、もう片方は変わらない", async () => {
    // R-1 が 2 つ。2 つ目の引用が原文に無い（1 つ目は正しい）
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
        // 2 つ目は引用が原文に無い（位置は 1 文目・2 文目を覆い、覆いの落ちを作らない）
        { id: "R-1", text: "数えられる", quote: "原文に無い引用", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured({ repairs: [{ index: 1, quote: "印を出す。", position: { start: 5, end: 10 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: REPAIR_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 1 つ目の R-1 は位置（添字 0）で指されていないので、そのまま
    expect(outcome.value.list.requirements[0]).toEqual(list.requirements[0]);
    // 2 つ目の R-1 だけが直る（id で最初の候補へ寄せない）
    expect(outcome.value.list.requirements[1]?.quote).toBe("印を出す。");
    expect(outcome.value.list.requirements[1]?.position).toEqual({ start: 5, end: 10 });
    expect(outcome.value.list.requirements[2]).toEqual(list.requirements[2]);
  });
});

describe("経路の表（Issue #917）：修復と作り直しは 1 回の流れで最大 1 回", () => {
  /** 引用が原文に無い一覧（来歴だけの落ち） */
  const ABSENT_LIST = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "タスクを登録する", position: { start: 0, end: 8 } },
      { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
    ],
    decisions: [],
    unresolved: [],
  };
  /** 覆いの落ちだけを作る一覧（3 文目の印を出す。を覆わない 3 文の原文と組む） */
  const THREE_SOURCE = "タスクを記録する。件数を合計する。印を出す。";
  const COVERAGE_LIST = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "タスクを記録する。", position: { start: 0, end: 9 } },
      { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 9, end: 17 } },
    ],
    decisions: [],
    unresolved: [],
  };

  it("(1) 落ちが無ければ、P1 → P2 の 2 回だけで止まらずに返る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recording.structured).toHaveLength(2);
    expect(outcome.value.repaired).toBe(false);
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial"]);
  });

  it("(2) 覆いを含む初回の落ちは、作り直し → P2 の 4 回", async () => {
    // 覆いだけを含む一覧 → 作り直しても覆いが残る（修復は呼ばない）
    const recording = createRecordingClient([
      structured(COVERAGE_LIST),
      structured(REVERSE_CHECK_OUTPUT),
      structured(COVERAGE_LIST),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: THREE_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recording.structured).toHaveLength(4);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.repaired).toBe(false);
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial", "whole-redo"]);
    expect(outcome.value.unmet.length).toBeGreaterThan(0);
  });

  it("(3) 来歴だけ → 修復 → 覆いの落ち、の本は全体の作り直しへ 1 回進む", async () => {
    const provenance = REPAIR_SOURCE;
    const recording = createRecordingClient([
      // 初回 P1: 来歴だけの落ち（引用「印を出す。」が原文に 2 か所あり、位置が 1 か所に決まらない）
      structured({
        requirements: [
          { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
          { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
        ],
        decisions: [],
        unresolved: [],
      }),
      structured(REVERSE_CHECK_OUTPUT),
      // 引用の修復（R-1 の引用を前後を含めて 1 か所に決まる形に直す）
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      // 修復の後の P2 が、覆われていない部分を申告する（覆いの落ち）
      structured({ uncovered: [{ start: 0, end: 3 }] }),
      // 全体の作り直し: 覆いの落ちも含めて直った一覧
      structured({
        requirements: [
          { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
          { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
        ],
        decisions: [],
        unresolved: [],
      }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: provenance,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 修復 1 回・作り直し 1 回で、どちらも 1 回以下
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual([
      "initial",
      "quote-repair",
      "whole-redo",
    ]);
    // P1・P2 の呼び出しは 6 回（形のやり直しを除く）
    expect(recording.structured).toHaveLength(6);
    expect(outcome.value.unmet).toEqual([]);
  });

  it("(4) 来歴だけで、修復を当てても落ちが残れば、問いの前に止まる（作り直しへは進まない）", async () => {
    const recording = createRecordingClient([
      structured(ABSENT_LIST),
      structured(REVERSE_CHECK_OUTPUT),
      // 直らない引用を返す（原文に無いまま）
      structured({ repairs: [{ index: 0, quote: "タスクを登録する", position: { start: 0, end: 8 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 修復は 1 回だけで、作り直しはしていない。落ちが残る
    expect(recording.structured).toHaveLength(4);
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(false);
    expect(outcome.value.unmet.map((miss) => miss.kind)).toContain("quote-not-found");
  });

  it("(5) 覆いを含む → 作り直し → 来歴だけが残る、の本は修復へ 1 回進む（6 回）", async () => {
    // 原文は「印を出す。」が 2 か所ある 3 文（5 + 5 + 8 = 18 文字）
    const repairSource = "印を出す。印を出す。件数を合計する。";
    const firstList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      decisions: [],
      unresolved: [],
    };
    // 作り直した一覧は覆いを直すが、R-2 の引用が 2 か所あるため位置が 1 か所に決まらない（来歴だけが残る）
    const secondList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "印を出せる（2 つ目）", quote: "印を出す。", position: { start: 5, end: 11 } },
        { id: "R-3", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      // 初回 P1: 2 文目を覆わない一覧（覆いの落ち）
      structured(firstList),
      structured(REVERSE_CHECK_OUTPUT),
      // 全体の作り直し: 覆いは直るが、R-2 の位置が 1 か所に決まらない（来歴だけが残る）
      structured(secondList),
      structured(REVERSE_CHECK_OUTPUT),
      // 引用の修復: R-2（添字 1）を前後を含めた 1 か所の引用へ直す
      structured({ repairs: [{ index: 1, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: repairSource,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 呼び出しの列は 6 回（形のやり直しを除く）
    expect(recording.structured.map((request) => request.schemaName)).toEqual([
      "requirement-list",
      "reverse-check",
      "requirement-list",
      "reverse-check",
      "requirement-quote-repair",
      "reverse-check",
    ]);
    // 往復の直し方は initial → whole-redo → quote-repair
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual([
      "initial",
      "whole-redo",
      "quote-repair",
    ]);
    // 修復 1 回・作り直し 1 回で、落ちは残らない
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.unmet).toEqual([]);
  });

  it("(5') 作り直しの後の修復でも落ちが残れば、作り直しへは戻らずに止まる", async () => {
    const repairSource = "印を出す。印を出す。件数を合計する。";
    const firstList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const secondList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "印を出せる（2 つ目）", quote: "印を出す。", position: { start: 5, end: 11 } },
        { id: "R-3", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(firstList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(secondList),
      structured(REVERSE_CHECK_OUTPUT),
      // 元の引用を含まない引用を返す（門に掛かり、当たらない → 落ちが残る）
      structured({ repairs: [{ index: 1, quote: "件数を合計する。", position: { start: 10, end: 18 } }] }),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: repairSource,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 作り直し 1 回・修復 1 回のまま、作り直しへ戻らない
    expect(recording.structured).toHaveLength(6);
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.unmet.map((miss) => miss.kind)).toContain("position-mismatch");
  });
});

describe("経路の表：修復を使わない（Build の既定。Issue #917）", () => {
  it("来歴だけの落ちでも、今までどおり全体の作り直しを使う（修復は呼ばない）", async () => {
    const list = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを登録する", position: { start: 0, end: 8 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      // 従来どおり、① のやり直しと ①' が呼ばれる（修復の schema は使わない）
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const outcome = await runReverseCheckLoop({
      source: SOURCE_TEXT,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recording.structured).toHaveLength(4);
    expect(recording.structured.map((request) => request.schemaName)).toEqual([
      "requirement-list",
      "reverse-check",
      "requirement-list",
      "reverse-check",
    ]);
    expect(outcome.value.repaired).toBe(false);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial", "whole-redo"]);
  });
});

describe("引用の修復の呼び出しの数の上限（Issue #917）", () => {
  it("修復まで進んだ本が呼び出しの数の上限に当たると、今までどおり止まる", async () => {
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: REPAIR_SPAN("件数を合計する。") },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
    ]);
    // 上限 2（P1・P2）に達しているので、修復の実試行は始められない
    const outcome = await runReverseCheckLoopWithOperation({
      source: REPAIR_SOURCE,
      documents: [],
      gateway: new CallGateway({
        client: recording.client,
        budget: new JobBudget(10),
        rates: { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 },
        now: () => 0,
        deadline: 60_000,
        limits: { ...AGENT_LIMITS, callCount: 2 },
      }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 停止は修復の呼び出しの番号で、種類は上限（今までどおり）
    expect(outcome.operation).toBe("quote-repair");
    expect(outcome.failure.kind).toBe("callLimit");
  });
});

// ── 逆照合の往復ごとの診断（Issue #919）──────────────────────────────────

describe("逆照合の往復ごとの診断を残す（Issue #919）", () => {
  /** 3 文をそれぞれの要件で覆い、3 文目を枠にもする一覧 */
  const TRACE_SOURCE = "記録する。合計する。印を出す。";
  const TRACE_LIST: RequirementList = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
      { id: "R-2", text: "合計できる", quote: "合計する。", position: { start: 5, end: 10 } },
      { id: "R-3", text: "印を出せる", quote: "印を出す。", position: { start: 10, end: 15 } },
    ],
    framing: [{ quote: "印を出す。", position: { start: 10, end: 15 } }],
    decisions: [],
    unresolved: [],
  };

  async function traceOnce(
    source: string,
    list: RequirementList,
    uncovered: readonly { readonly start: number; readonly end: number }[],
  ) {
    const recording = createRecordingClient([structured({ uncovered })]);
    const outcome = await runReverseCheckWithDiagnosis({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return undefined;
    return { trace: outcome.value.trace, recording };
  }

  it("会話の生の範囲の行き先 5 種（残った・重複・空白だけ・枠に全部含まれる・範囲の外か空）を 1 本ずつ残す", async () => {
    // 1: 枠 {10,15} の一部と重なり、{8,10} が残る／2: 1 と同じで重複／3: 「。」だけで空白／
    // 4: 枠に全部含まれる／5: 空の範囲
    const reported = [
      { start: 8, end: 12 },
      { start: 8, end: 12 },
      { start: 4, end: 5 },
      { start: 10, end: 15 },
      { start: 5, end: 5 },
    ];
    const result = await traceOnce(TRACE_SOURCE, TRACE_LIST, reported);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.trace.reported).toEqual([
      { range: { start: 8, end: 12 }, destination: "remaining", fragments: [{ start: 8, end: 10 }] },
      { range: { start: 8, end: 12 }, destination: "duplicate", fragments: [] },
      { range: { start: 4, end: 5 }, destination: "blank", fragments: [] },
      { range: { start: 10, end: 15 }, destination: "framing", fragments: [] },
      { range: { start: 5, end: 5 }, destination: "outside", fragments: [] },
    ]);
  });

  it("往復の一覧の SHA-256 は、P2 の要求の「要件の一覧」のデータの文の SHA-256 と一致する", async () => {
    const result = await traceOnce(TRACE_SOURCE, TRACE_LIST, []);
    expect(result).toBeDefined();
    if (result === undefined) return;
    // 実際に送った要求から「要件の一覧」のデータの文を取り出して照らす（要求のバイト列は変えない）
    const request = result.recording.structured[0];
    expect(request).toBeDefined();
    const input = request?.input ?? "";
    const marker = '<data name="要件の一覧">\n';
    const from = input.indexOf(marker) + marker.length;
    const to = input.indexOf("\n</data>", from);
    const dataText = input.slice(from, to);
    expect(result.trace.listSha256).toBe(await sha256Hex(dataText));
    // 一覧の全体（要件・枠・決定・未解決）を、生成役が出した値のまま持つ
    expect(result.trace.list).toEqual({
      requirements: TRACE_LIST.requirements,
      framing: TRACE_LIST.framing ?? [],
      decisions: TRACE_LIST.decisions,
      unresolved: TRACE_LIST.unresolved,
    });
  });

  it("コードが見つけた落ちは、種類・候補の添字・範囲（説明の文は無し）で残る", async () => {
    const source = "記録する。合計する。";
    const list: RequirementList = {
      requirements: [
        // 引用が原文に無い（候補の添字 1）
        { id: "R-1", text: "記録できる", quote: "原文に無い", position: { start: 0, end: 5 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const result = await traceOnce(source, list, []);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.trace.codeMisses).toEqual([
      { kind: "quote-not-found", requirement: 1, range: null },
      { kind: "uncovered-source", requirement: null, range: { start: 5, end: 10 } },
    ]);
  });

  it("原文は複写せず、SHA-256 と長さを持つ", async () => {
    // 原文に戻る単位（ループ）で組む。原文の全文は持たず、SHA-256 と長さだけを残す
    const recording = createRecordingClient([structured(TRACE_LIST), structured({ uncovered: [] })]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: TRACE_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.trace?.sourceSha256).toBe(await sha256Hex(TRACE_SOURCE));
    expect(outcome.value.trace?.sourceLength).toBe(TRACE_SOURCE.length);
    // 原文の全文・範囲を切り出した文字列は入らない
    const serialized = JSON.stringify(outcome.value.trace);
    expect(serialized).not.toContain(TRACE_SOURCE);
  });
});

describe("逆照合の診断を、止まるまでに終えた往復の分だけ返す（Issue #919）", () => {
  it("やり直しの逆照合で止まると、終えた往復（初回）の分だけを返す", async () => {
    const source = "記録する。合計する。印を出す。";
    // 3 文目が覆われない一覧（やり直しが走る）
    const list = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "合計する。", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    let calls = 0;
    const inner = createRecordingClient([structured(list), structured({ uncovered: [] }), structured(list)]);
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest) {
        calls += 1;
        if (calls === 4) throw new Error("止める");
        return inner.client.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest) {
        return inner.client.callWithTools(request);
      },
    };
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.operation).toBe("reverse-check-redo");
    expect(outcome.trace).toBeDefined();
    expect(outcome.trace?.sourceSha256).toBe(await sha256Hex(source));
    expect(outcome.trace?.sourceLength).toBe(source.length);
    expect(outcome.trace?.rounds.map((round) => round.fix)).toEqual(["initial"]);
  });

  it("修復のあとの逆照合まで終えると、往復の順（initial・quote-repair）で返す", async () => {
    const source = "記録する。合計する。";
    const list = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "原文に無い", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const repaired = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "合計する。", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured({ uncovered: [] }),
      structured({ repairs: [{ index: 1, quote: "合計する。", position: { start: 5, end: 10 } }] }),
      structured(repaired),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.trace?.rounds.map((round) => round.fix)).toEqual(["initial", "quote-repair"]);
  });
});

// ── 作り直しで、落ちていなかった要件の有効な引用と位置を戻す（Issue #942）──────────
//
// 全体の作り直しは、落ちていなかった要件の引用と位置まで出し直す。作り直しが有効だった引用を、
// 原文に 1 か所に決まらない短い語へ縮めたとき、**本文も ID も同じ**なら前の引用と位置に戻す。
// **Plan の経路だけ**が `keepValidProvenance` で有効にする。

/** 作り直しの前の一覧（R-1 の引用は前後を含めて 1 か所に決まる。4 文目は覆わない） */
const beforeList = (): RequirementList => ({
  requirements: [
    { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
    { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
});

/** 作り直しの後の一覧（R-1 の引用を 2 か所に決まらない短い語へ縮め、4 文目を覆う R-3 を足す） */
const shrunkList = (): RequirementList => ({
  requirements: [
    { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
    { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
    { id: "R-3", text: "数えられる", quote: "印を数える。", position: { start: 18, end: 24 } },
  ],
  framing: [{ quote: "印を数える。", position: { start: 18, end: 24 } }],
  decisions: ["記録の形は 1 行とした"],
  unresolved: ["残件の扱い"],
});

describe("作り直しで、落ちていなかった要件の有効な引用と位置を戻す（Issue #942）", () => {
  /**
   * 4 文の原文。1・2 文目が同じ句で、**前後を含めた引用だけが 1 か所に決まる**。
   *   1-2 文目「印を出す。印を出す。」（0-10）／3 文目「件数を合計する。」（10-18）／4 文目「印を数える。」（18-24）
   */
  const KEEP_SOURCE = "印を出す。印を出す。件数を合計する。印を数える。";

  it("4 条件を満たす要件だけ、引用と位置が前の値に戻り、本文・ID・部分・並び・ほかの要件は変わらない", () => {
    const before = beforeList();
    const shrunk = shrunkList();
    const kept = restoreValidProvenance(KEEP_SOURCE, before, shrunk);
    // R-1 だけが戻る（本文も ID も同じで、前が有効・後が落ち・後の引用が前の部分文字列）
    expect(kept.restored).toEqual([
      { id: "R-1", requirement: 1, quote: "印を出す。", position: { start: 1, end: 6 } },
    ]);
    expect(kept.list.requirements[0]).toEqual({
      id: "R-1",
      text: "印を出せる",
      quote: "印を出す。印を出す。",
      position: { start: 0, end: 10 },
    });
    // 戻さない要件・本文・ID・部分・並びは作り直しの値のまま（一覧のほかの欄もそのまま）
    expect(kept.list.requirements.slice(1)).toEqual(shrunk.requirements.slice(1));
    expect(kept.list.framing).toEqual(shrunk.framing);
    expect(kept.list.decisions).toEqual(shrunk.decisions);
    expect(kept.list.unresolved).toEqual(shrunk.unresolved);
    // 前の一覧は書き換えない（純粋な関数）
    expect(before.requirements[0]?.quote).toBe("印を出す。印を出す。");
  });

  it("(反例1) 本文が変わった要件は戻さない", () => {
    const shrunk = shrunkList();
    const changedText: RequirementList = {
      ...shrunk,
      requirements: shrunk.requirements.map((requirement) =>
        requirement.id === "R-1" ? { ...requirement, text: "印を二度出せる" } : requirement,
      ),
    };
    expect(restoreValidProvenance(KEEP_SOURCE, beforeList(), changedText).restored).toEqual([]);
  });

  it("(反例2) ID が重複する・前の一覧に無い要件は戻さない", () => {
    const before = beforeList();
    // 前の一覧の R-1 が 2 つ（どちらの本文か決まらない）
    const duplicatedBefore: RequirementList = {
      ...before,
      requirements: [...before.requirements, { ...before.requirements[0]!, text: "印を三度出せる" }],
    };
    expect(restoreValidProvenance(KEEP_SOURCE, duplicatedBefore, shrunkList()).restored).toEqual([]);
    // 作り直しの一覧の R-1 が 2 つ
    const shrunk = shrunkList();
    const duplicatedAfter: RequirementList = {
      ...shrunk,
      requirements: [...shrunk.requirements, { ...shrunk.requirements[0]! }],
    };
    expect(restoreValidProvenance(KEEP_SOURCE, beforeList(), duplicatedAfter).restored).toEqual([]);
    // 前の一覧に無い ID（R-9）
    const absentBefore: RequirementList = {
      ...shrunk,
      requirements: shrunk.requirements.map((requirement) =>
        requirement.id === "R-1" ? { ...requirement, id: "R-9" } : requirement,
      ),
    };
    expect(restoreValidProvenance(KEEP_SOURCE, beforeList(), absentBefore).restored).toEqual([]);
  });

  it("(反例3) 前の引用も落ちていた要件は戻さない（修復の経路に任せる）", () => {
    const before = beforeList();
    const brokenBefore: RequirementList = {
      ...before,
      requirements: before.requirements.map((requirement) =>
        requirement.id === "R-1" ? { ...requirement, quote: "印を出す。", position: { start: 1, end: 6 } } : requirement,
      ),
    };
    expect(restoreValidProvenance(KEEP_SOURCE, brokenBefore, shrunkList()).restored).toEqual([]);
  });

  it("(反例4) 後の引用が有効なら戻さない（作り直しが引用を良くした場合を壊さない）", () => {
    const shrunk = shrunkList();
    const validAfter: RequirementList = {
      ...shrunk,
      requirements: shrunk.requirements.map((requirement) =>
        requirement.id === "R-1" ? { ...requirement, quote: "印を出す。", position: { start: 5, end: 10 } } : requirement,
      ),
    };
    const kept = restoreValidProvenance(KEEP_SOURCE, beforeList(), validAfter);
    expect(kept.restored).toEqual([]);
    expect(kept.list.requirements[0]?.position).toEqual({ start: 5, end: 10 });
  });

  it("(反例5) 後の引用が前の引用の部分文字列でない（広げた・別の所）なら戻さない", () => {
    const shrunk = shrunkList();
    // 原文に無い（前後をまたいだ）引用へ広げようとして写し損ねた
    const widened: RequirementList = {
      ...shrunk,
      requirements: shrunk.requirements.map((requirement) =>
        requirement.id === "R-1"
          ? { ...requirement, quote: "印を出す。件数を合計する。", position: { start: 0, end: 18 } }
          : requirement,
      ),
    };
    expect(restoreValidProvenance(KEEP_SOURCE, beforeList(), widened).restored).toEqual([]);
    // 前の引用を部分文字列として持たない、別の所を指した引用
    const elsewhere: RequirementList = {
      ...shrunk,
      requirements: shrunk.requirements.map((requirement) =>
        requirement.id === "R-1"
          ? { ...requirement, quote: "数を合計する。", position: { start: 8, end: 16 } }
          : requirement,
      ),
    };
    expect(restoreValidProvenance(KEEP_SOURCE, beforeList(), elsewhere).restored).toEqual([]);
  });

  it("(反例6) 戻したことで覆いの落ちが出るときも、戻したうえで落ちとして点検する（門を強める側）", () => {
    // 3 文（S1 0-5「印を出す。」／S2 5-13「件数を合計する。」／S3 13-19「印を数える。」）。
    // 前の一覧は S1・S2 を覆い、作り直しは R-1 の位置を広げて全 3 文を覆った（引用は縮んで落ちている）
    const source = "印を出す。件数を合計する。印を数える。";
    const before: RequirementList = { requirements: [
      { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
      { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 5, end: 13 } },
    ], framing: [], decisions: [], unresolved: [] };
    const shrunk: RequirementList = { requirements: [
      // 「印を」は原文に 2 か所あり、位置 0-16 は引用と一致しない（落ち）。位置は全 3 文に重なる
      { id: "R-1", text: "印を出せる", quote: "印を", position: { start: 0, end: 16 } },
      { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 5, end: 13 } },
    ], framing: [], decisions: [], unresolved: [] };
    // 作り直しの一覧は覆いがそろっている
    expect(checkRequirementCoverage(source, shrunk).filter((miss) => miss.kind === "uncovered-source")).toEqual([]);
    const kept = restoreValidProvenance(source, before, shrunk);
    // 条件を満たすので戻す（覆いの落ちが出ても戻す）
    expect(kept.restored.map((entry) => entry.id)).toEqual(["R-1"]);
    // 戻した後の一覧を、コードの覆いの検査が落ちとして見つける（覆いの門は緩めない）
    const uncovered = checkRequirementCoverage(source, kept.list).filter(
      (miss) => miss.kind === "uncovered-source",
    );
    expect(uncovered).toEqual([{ kind: "uncovered-source", range: { start: 13, end: 19 }, detail: expect.any(String) }]);
  });

  it("作り直しが先の経路：呼び出しの列が P1 → P2 → P1（作り直し）→ P2 の 4 回になる", async () => {
    const recording = createRecordingClient([
      structured(beforeList()),
      structured({ uncovered: [] }),
      structured(shrunkList()),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: KEEP_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
      keepValidProvenance: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 修復は呼ばない（作り直しで戻したので、来歴の落ちが残らない）
    expect(recording.structured.map((request) => request.schemaName)).toEqual([
      "requirement-list",
      "reverse-check",
      "requirement-list",
      "reverse-check",
    ]);
    expect(outcome.value.repaired).toBe(false);
    expect(outcome.value.redone).toBe(true);
    expect(outcome.value.unmet).toEqual([]);
    // P2 に渡る一覧では、R-1 が前の引用と位置に戻っている
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。印を出す。");
    expect(outcome.value.list.requirements[0]?.position).toEqual({ start: 0, end: 10 });
    // 往復の診断には、戻した要件の通し番号と件数だけが載る（ID・引用・原文は載らない）
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial", "whole-redo"]);
    expect(outcome.value.diagnosis.rounds[1]?.restored).toEqual({ count: 1, requirements: [1] });
    expect(outcome.value.diagnosis.rounds[0]?.restored).toBeUndefined();
    const diagnosisText = JSON.stringify(outcome.value.diagnosis);
    expect(diagnosisText).not.toContain("印を出す");
    expect(diagnosisText).not.toContain("R-1");
    // trace には、戻した要件の ID と、戻す前（作り直しが出した）引用・位置が載る
    expect(outcome.value.trace?.rounds[1]?.restored).toEqual([
      { id: "R-1", requirement: 1, quote: "印を出す。", position: { start: 1, end: 6 } },
    ]);
    expect(outcome.value.trace?.rounds[0]?.restored).toBeUndefined();
  });

  it("修復が先に当たった経路（来歴だけ → 修復 → 覆いを含む → 作り直し）でも戻る", async () => {
    // 4 文すべてを覆い、R-1 だけが 1 か所に決まらない引用（来歴だけの落ち）の一覧
    const initial = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
        { id: "R-3", text: "数えられる", quote: "印を数える。", position: { start: 18, end: 24 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    // 修復で R-1 が 1 か所に決まる引用へ直る（この一覧が「前」になる）
    const repaired = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 18 } },
        { id: "R-3", text: "数えられる", quote: "印を数える。", position: { start: 18, end: 24 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(initial),
      structured({ uncovered: [] }),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      // 修復の後の P2 が 4 文目の覆いの落ちを挙げ、全体の作り直しへ進む
      structured({ uncovered: [{ start: 18, end: 24 }] }),
      structured(shrunkList()),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: KEEP_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
      keepValidProvenance: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 修復 1 回・作り直し 1 回のまま（呼び出しは 6 回）
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    expect(recording.structured).toHaveLength(6);
    // 前は修復した一覧である（R-1 の引用が修復の値に戻る）
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。印を出す。");
    expect(outcome.value.list.requirements[0]?.position).toEqual({ start: 0, end: 10 });
    expect(repaired.requirements[0]?.quote).toBe("印を出す。印を出す。");
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual([
      "initial",
      "quote-repair",
      "whole-redo",
    ]);
    expect(outcome.value.diagnosis.rounds[2]?.restored).toEqual({ count: 1, requirements: [1] });
  });

  it("選択を省いた呼び出し（Build の経路）では、呼び出しの列・結果・診断が今までどおり（欄が増えない）", async () => {
    const recording = createRecordingClient([
      structured(beforeList()),
      structured({ uncovered: [] }),
      structured(shrunkList()),
      structured({ uncovered: [] }),
      // 作り直しの後の来歴だけの落ちを、今までどおり引用の修復で直す
      structured({ repairs: [{ index: 0, quote: "印を出す。", position: { start: 5, end: 10 } }] }),
      structured({ uncovered: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: KEEP_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recording.structured.map((request) => request.schemaName)).toEqual([
      "requirement-list",
      "reverse-check",
      "requirement-list",
      "reverse-check",
      "requirement-quote-repair",
      "reverse-check",
    ]);
    // 戻していない（作り直しの値のまま）
    expect(outcome.value.list.requirements[0]?.quote).toBe("印を出す。");
    expect(outcome.value.repaired).toBe(true);
    expect(outcome.value.redone).toBe(true);
    // 往復の診断にも trace にも、`restored` の欄が増えない
    for (const round of outcome.value.diagnosis.rounds) expect(round.restored).toBeUndefined();
    for (const round of outcome.value.trace?.rounds ?? []) expect(round.restored).toBeUndefined();
  });
});

// ── Issue #948：Plan の逆照合に条件の指摘の契約と記録を足す（段 1・行き先は変えない）──

/** 3 文の原文。最初の 2 文だけを覆う一覧（3 文目が覆われず、作り直しが走る） */
const CONDITION_SOURCE = "記録する。合計する。印を出す。";
const CONDITION_LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
    { id: "R-2", text: "合計できる", quote: "合計する。", position: { start: 5, end: 10 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};
/** 作り直しの後の一覧（3 文すべてを覆う） */
const CONDITION_REDONE: RequirementList = {
  requirements: [
    ...CONDITION_LIST.requirements,
    { id: "R-3", text: "印を出せる", quote: "印を出す。", position: { start: 10, end: 15 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};

/** 条件の指摘の件数の集計の、種類の和（Issue #948 の試験で使う） */
const conditionKindSum = (value: { readonly kinds: Readonly<Record<string, number>> }): number =>
  Object.values(value.kinds).reduce((sum, count) => sum + count, 0);

/** 追加の記録を除いた、逆照合のループの結果（Issue #948 の前後比較に使う） */
const conditionCoreOf = (value: {
  readonly list: unknown;
  readonly report: unknown;
  readonly redone: boolean;
  readonly repaired: boolean;
  readonly unmet: unknown;
}) => ({
  list: value.list,
  report: value.report,
  redone: value.redone,
  repaired: value.repaired,
  unmet: value.unmet,
});

/** 条件の指摘の記録を試す 1 往復（派生 schema の選択を明示する） */
async function conditionOnce(
  list: RequirementList,
  uncovered: readonly { readonly start: number; readonly end: number }[],
  findingDetails: readonly unknown[] | undefined,
) {
  const output =
    findingDetails === undefined ? { uncovered } : { uncovered, findingDetails };
  const recording = createRecordingClient([structured(output)]);
  const outcome = await runReverseCheckWithDiagnosis({
    source: CONDITION_SOURCE,
    list,
    documents: [],
    gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    observeConditionFindings: true,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return undefined;
  return { ...outcome.value, recording };
}

/** 条件の指摘の記録を試すループ（初回 → 作り直し。詳細だけを差し替える） */
async function conditionLoop(
  initialUncovered: readonly { readonly start: number; readonly end: number }[],
  initialDetails: readonly unknown[],
  redoneUncovered: readonly { readonly start: number; readonly end: number }[] = [],
  redoneDetails: readonly unknown[] = [],
) {
  const recording = createRecordingClient([
    structured(CONDITION_LIST),
    structured({ uncovered: initialUncovered, findingDetails: initialDetails }),
    structured(CONDITION_REDONE),
    structured({ uncovered: redoneUncovered, findingDetails: redoneDetails }),
  ]);
  const outcome = await runReverseCheckLoopWithOperation({
    source: CONDITION_SOURCE,
    documents: [],
    gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    observeConditionFindings: true,
  });
  return { recording, outcome };
}

describe("T2条件指摘の記録", () => {
  it("種類と本文上の対象を、元の添字・範囲・行き先とともに trace へ残す（前は欄が無い）", async () => {
    const once = await conditionOnce(CONDITION_LIST, [{ start: 8, end: 12 }], [
      { uncoveredIndex: 0, missingKind: "negation", requirementIds: ["R-2"] },
    ]);
    expect(once).toBeDefined();
    if (once === undefined) return;
    // 元の範囲は会話ではなくコードが元の uncovered から取る（8-12 は枠が無いので 8-12 のまま残る）
    expect(once.trace.conditionFindings).toEqual({
      rows: [
        {
          index: 0,
          range: { start: 8, end: 12 },
          destination: "remaining",
          kind: "negation",
          requirementIds: ["R-2"],
          match: "matched",
          failure: null,
        },
      ],
      orphans: [],
    });
    // 行き先は 5 つのまま（照合状態とは別の軸）
    expect(once.trace.reported[0]?.destination).toBe("remaining");
  });

  it("通常診断は件数だけで、全体＝2 群の和・種類の和＝matched＋unbound になる", async () => {
    // 5 つの行き先を 1 往復に並べる（remaining・duplicate・blank・framing・outside）＋行き先の無い行
    const source = "記録する。合計する。印を出す。";
    const list: RequirementList = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "記録する。", position: { start: 0, end: 5 } },
        { id: "R-2", text: "合計できる", quote: "合計する。", position: { start: 5, end: 10 } },
      ],
      framing: [{ quote: "印を出す。", position: { start: 10, end: 15 } }],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({
        uncovered: [
          { start: 8, end: 12 },
          { start: 8, end: 12 },
          { start: 4, end: 5 },
          { start: 10, end: 15 },
          { start: 5, end: 5 },
        ],
        findingDetails: [
          { uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-1"] },
          { uncoveredIndex: 1, missingKind: "scope", requirementIds: [] },
          { uncoveredIndex: 2, missingKind: "deadline", requirementIds: ["R-2"] },
          { uncoveredIndex: 3, missingKind: "quantity", requirementIds: ["R-1", "R-2"] },
          { uncoveredIndex: 4, missingKind: "target", requirementIds: ["R-1"] },
          { uncoveredIndex: 9, missingKind: "other", requirementIds: [] },
        ],
      }),
    ]);
    const outcome = await runReverseCheckWithDiagnosis({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 5 つの行き先と照合状態を別々に検査する
    expect(outcome.value.trace.reported.map((entry) => entry.destination)).toEqual([
      "remaining",
      "duplicate",
      "blank",
      "framing",
      "outside",
    ]);
    expect(outcome.value.trace.conditionFindings?.rows.map((row) => row.match)).toEqual([
      "matched",
      "unbound",
      "matched",
      "matched",
      "invalid",
    ]);
    expect(outcome.value.trace.conditionFindings?.rows[4]?.failure).toBe("outside");
    expect(outcome.value.trace.conditionFindings?.orphans).toEqual([
      { uncoveredIndex: 9, kind: "other", requirementIds: [], failure: "index-out-of-range" },
    ]);

    const counts = outcome.value.round.conditionFindings;
    expect(counts).toBeDefined();
    if (counts === undefined) return;
    // 全体：raw 5 = matched 3 + unbound 1 + missing 0 + invalid 1
    expect(counts.whole.rawCount).toBe(5);
    expect(counts.whole).toMatchObject({ matched: 3, unbound: 1, missing: 0, invalid: 1 });
    // remaining 群（1）＋ 非 remaining 群（4）＝全体
    expect(counts.remaining.rawCount).toBe(1);
    expect(counts.other.rawCount).toBe(4);
    expect(counts.remaining.rawCount + counts.other.rawCount).toBe(counts.whole.rawCount);
    expect(counts.remaining.matched).toBe(1);
    expect(counts.other).toMatchObject({ matched: 2, unbound: 1, missing: 0, invalid: 1 });
    // framing・duplicate の matched と blank は非 remaining 群に入る
    expect(counts.other.matched).toBe(2);
    expect(counts.remaining.matched).toBe(1);
    // orphan は分母に入れない
    expect(counts.orphans).toBe(1);
    // 種類の和は matched＋unbound（既知の種類だけ）
    expect(conditionKindSum(counts.whole)).toBe(counts.whole.matched + counts.whole.unbound);
    expect(conditionKindSum(counts.remaining)).toBe(counts.remaining.matched + counts.remaining.unbound);
    expect(conditionKindSum(counts.other)).toBe(counts.other.matched + counts.other.unbound);
    expect(conditionKindSum(counts.whole)).toBe(
      conditionKindSum(counts.remaining) + conditionKindSum(counts.other),
    );
    // 通常診断に ID・原文範囲・本文・引用は出さない
    const text = JSON.stringify(counts);
    expect(text).not.toContain("R-1");
    expect(text).not.toContain("印を出す");
    expect(text).not.toContain("start");
  });

  it("元指摘 1 件から断片 2 件が残っても、分母は 1 である", async () => {
    const source = "ABCDEFGHIJ";
    const list: RequirementList = {
      requirements: [{ id: "R-1", text: "全体", quote: "ABCDEFGHIJ", position: { start: 0, end: 10 } }],
      // 2 か所を枠にすると、1 つの範囲が 2 つの断片になる
      framing: [{ quote: "CD", position: { start: 2, end: 4 } }],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({
        uncovered: [{ start: 1, end: 5 }],
        findingDetails: [{ uncoveredIndex: 0, missingKind: "wording", requirementIds: ["R-1"] }],
      }),
    ]);
    const outcome = await runReverseCheckWithDiagnosis({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.trace.reported[0]?.fragments).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ]);
    expect(outcome.value.round.conditionFindings?.whole.rawCount).toBe(1);
    expect(outcome.value.round.conditionFindings?.whole.matched).toBe(1);
  });

  it("Plan だけが派生 schema を選び、ほかの要求の欄は 1 つも変えない", async () => {
    const build = createRecordingClient([structured({ uncovered: [] })]);
    await runReverseCheckWithDiagnosis({
      source: CONDITION_SOURCE,
      list: CONDITION_LIST,
      documents: [],
      gateway: makeGateway(build.client, { maxAttempts: 1 }),
    });
    const plan = createRecordingClient([structured({ uncovered: [], findingDetails: [] })]);
    await runReverseCheckWithDiagnosis({
      source: CONDITION_SOURCE,
      list: CONDITION_LIST,
      documents: [],
      gateway: makeGateway(plan.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
    });
    const buildRequest = build.structured[0];
    const planRequest = plan.structured[0];
    const planProperties = (planRequest?.schema as { properties?: Record<string, unknown> } | undefined)?.properties;
    expect(buildRequest?.schema).toBe(REVERSE_CHECK_SCHEMA);
    expect(planProperties).toHaveProperty("findingDetails");
    // 派生 schema は既存の uncovered の定義を変えない
    expect(planProperties?.["uncovered"]).toBe(REVERSE_CHECK_SCHEMA.properties.uncovered);
    // instructions・documents・rules・input・schemaName・maxOutputTokens は同じで、schema だけが違う
    // （記録には共通の口が足す `signal` があるので、段が渡した欄だけを比べる）
    expect(planRequest?.instructions).toBe(buildRequest?.instructions);
    expect(planRequest?.documents).toEqual(buildRequest?.documents);
    expect(planRequest?.rules).toEqual(buildRequest?.rules);
    expect(planRequest?.input).toBe(buildRequest?.input);
    expect(planRequest?.schemaName).toBe(buildRequest?.schemaName);
    expect(planRequest?.maxOutputTokens).toBe(buildRequest?.maxOutputTokens);
  });

  it("詳細を欠落・全種類・未知値・空の対象・未知ID・重複ID・重複行・順序入替・orphan にしても、経路と結果は同じ", async () => {
    // 元の指摘は 2 件（1 件目は残りの断片、2 件目は重複）
    const initial = [{ start: 8, end: 12 }, { start: 8, end: 12 }];
    const variants: readonly (readonly unknown[])[] = [
      [],
      [{ uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] }],
      ...REVERSE_CHECK_CONDITION_KINDS.map((kind) => [
        { uncoveredIndex: 0, missingKind: kind, requirementIds: ["R-1"] },
        { uncoveredIndex: 1, missingKind: kind, requirementIds: [] },
      ]),
      [{ uncoveredIndex: 0, missingKind: "未知の種類", requirementIds: ["R-1"] }],
      [{ uncoveredIndex: 0, missingKind: "target", requirementIds: [] }],
      [{ uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-9"] }],
      [{ uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1", "R-1"] }],
      [
        { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
        { uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-2"] },
      ],
      [
        { uncoveredIndex: 1, missingKind: "time", requirementIds: ["R-2"] },
        { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
      ],
      [{ uncoveredIndex: 5, missingKind: "target", requirementIds: ["R-1"] }],
    ];
    const baseline = await conditionLoop(initial, []);
    expect(baseline.outcome.ok).toBe(true);
    if (!baseline.outcome.ok) return;
    const expected = conditionCoreOf(baseline.outcome.value);
    const expectedCalls = baseline.recording.structured.map((request) => JSON.stringify(request));
    for (const details of variants) {
      const variant = await conditionLoop(initial, details);
      expect(variant.outcome.ok).toBe(true);
      if (!variant.outcome.ok) return;
      expect(conditionCoreOf(variant.outcome.value)).toEqual(expected);
      expect(variant.recording.structured.map((request) => JSON.stringify(request))).toEqual(expectedCalls);
    }
  });

  it("合成例（否定・期限・共通修飾・同名の対象・未登録の参照元・新要件）でも、会話の不足指摘を保ち確定へ進めない", async () => {
    const source = "必ず記録する。3件まで合計する。印を出す。";
    const base: RequirementList = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "必ず記録する。", position: { start: 0, end: 7 } },
        { id: "R-2", text: "合計できる", quote: "3件まで合計する。", position: { start: 7, end: 16 } },
        { id: "R-3", text: "印を出せる", quote: "印を出す。", position: { start: 16, end: 21 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    /** 同名の 2 対象（同じ ID が 2 つ）を持つ一覧 */
    const duplicated: RequirementList = {
      ...base,
      requirements: [
        { ...base.requirements[0]!, quote: "必ず記録する。" },
        { ...base.requirements[0]!, quote: "記録する。" , position: { start: 2, end: 9 } },
        ...base.requirements.slice(1),
      ],
    };
    const cases: readonly {
      readonly label: string;
      readonly list: RequirementList;
      readonly range: { readonly start: number; readonly end: number };
      readonly detail: { readonly uncoveredIndex: number; readonly missingKind: string; readonly requirementIds: readonly string[] };
      readonly match: string;
    }[] = [
      { label: "引用内の本当の否定", list: base, range: { start: 0, end: 7 }, detail: { uncoveredIndex: 0, missingKind: "negation", requirementIds: ["R-1"] }, match: "matched" },
      { label: "期限の欠落", list: base, range: { start: 7, end: 16 }, detail: { uncoveredIndex: 0, missingKind: "deadline", requirementIds: ["R-2"] }, match: "matched" },
      { label: "共通修飾の一部欠落", list: base, range: { start: 0, end: 16 }, detail: { uncoveredIndex: 0, missingKind: "shared-modifier", requirementIds: ["R-1", "R-2"] }, match: "matched" },
      { label: "同名の 2 対象", list: duplicated, range: { start: 0, end: 7 }, detail: { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] }, match: "invalid" },
      { label: "未登録の参照元", list: base, range: { start: 0, end: 7 }, detail: { uncoveredIndex: 0, missingKind: "reference-source", requirementIds: ["R-9"] }, match: "invalid" },
      { label: "新要件で対象 ID なし", list: base, range: { start: 0, end: 7 }, detail: { uncoveredIndex: 0, missingKind: "target", requirementIds: [] }, match: "unbound" },
    ];
    for (const testCase of cases) {
      const withDetail = await conditionOnceFor(source, testCase.list, testCase.range, [testCase.detail]);
      const withoutDetail = await conditionOnceFor(source, testCase.list, testCase.range, []);
      expect(withDetail).toBeDefined();
      expect(withoutDetail).toBeDefined();
      if (withDetail === undefined || withoutDetail === undefined) return;
      // 会話の不足指摘は消えない（詳細の有無で結果が変わらない）
      expect(withDetail.result.misses).toEqual(withoutDetail.result.misses);
      expect(withDetail.result.misses.length).toBeGreaterThan(0);
      expect(withDetail.round.conditionFindings?.whole.rawCount).toBe(1);
      expect(withDetail.trace.conditionFindings?.rows[0]?.match).toBe(testCase.match);
    }
  });

  it("初回・引用の修復の後・全体の作り直し後の 3 つの往復に記録する", async () => {
    const source = "印を出す。印を出す。件数を合計する。";
    const initialList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 19 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const redone = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 19 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(initialList),
      structured({ uncovered: [], findingDetails: [] }),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      structured({
        uncovered: [{ start: 0, end: 3 }],
        findingDetails: [{ uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-1"] }],
      }),
      structured(redone),
      structured({ uncovered: [], findingDetails: [] }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
      observeConditionFindings: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual([
      "initial",
      "quote-repair",
      "whole-redo",
    ]);
    // 3 つの往復すべてに、件数の診断と trace の記録が付く
    for (const round of outcome.value.diagnosis.rounds) expect(round.conditionFindings).toBeDefined();
    for (const round of outcome.value.trace?.rounds ?? []) expect(round.conditionFindings).toBeDefined();
    // 修復の後の往復に、種類と対象が残る
    expect(outcome.value.trace?.rounds[1]?.conditionFindings?.rows[0]).toMatchObject({
      kind: "time",
      requirementIds: ["R-1"],
      match: "matched",
    });
    // 記録のない（指摘 0 件の）往復は 0 件であって、欄が無いのとは違う
    expect(outcome.value.diagnosis.rounds[0]?.conditionFindings?.whole.rawCount).toBe(0);
    expect(outcome.value.diagnosis.rounds[2]?.conditionFindings?.whole.rawCount).toBe(0);
  });

  it("途中で止まったときは、完了した往復の記録だけを残す", async () => {
    const recording = createRecordingClient([
      structured(CONDITION_LIST),
      structured({
        uncovered: [{ start: 8, end: 12 }],
        findingDetails: [{ uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] }],
      }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source: CONDITION_SOURCE,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnosis.rounds).toHaveLength(1);
    expect(outcome.trace?.rounds).toHaveLength(1);
    expect(outcome.diagnosis.rounds[0]?.conditionFindings?.whole.matched).toBe(1);
    expect(outcome.trace?.rounds[0]?.conditionFindings?.rows[0]?.match).toBe("matched");
  });

  it("記録のない旧形式（選択を省いた Build の経路）は、trace にも診断にも欄を足さない", async () => {
    const recording = createRecordingClient([
      structured({ uncovered: [{ start: 8, end: 12 }] }),
    ]);
    const outcome = await runReverseCheckWithDiagnosis({
      source: CONDITION_SOURCE,
      list: CONDITION_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.trace.conditionFindings).toBeUndefined();
    expect(outcome.value.round.conditionFindings).toBeUndefined();
  });
});

/** 合成例の 1 往復（原文と一覧をその場で与える） */
async function conditionOnceFor(
  source: string,
  list: RequirementList,
  range: { readonly start: number; readonly end: number },
  findingDetails: readonly unknown[],
) {
  const recording = createRecordingClient([structured({ uncovered: [range], findingDetails })]);
  const outcome = await runReverseCheckWithDiagnosis({
    source,
    list,
    documents: [],
    gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    observeConditionFindings: true,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return undefined;
  return outcome.value;
}

describe("T2条件指摘の記録（純粋な関数）", () => {
  it("matched・unbound・missing・invalid を参照の構造だけで決める", () => {
    const list: RequirementList = {
      requirements: [
        { id: "R-1", text: "a", quote: "a", position: { start: 0, end: 1 } },
        { id: "R-2", text: "b", quote: "b", position: { start: 1, end: 2 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const reported = [{ range: { start: 0, end: 1 }, destination: "remaining" as const, fragments: [] }];
    const noDetails = classifyConditionFindings("ab", list, reported, []);
    expect(noDetails.rows).toEqual([
      {
        index: 0,
        range: { start: 0, end: 1 },
        destination: "remaining",
        kind: null,
        requirementIds: [],
        match: "missing",
        failure: null,
      },
    ]);
    const matched = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
    ]);
    expect(matched.rows[0]).toMatchObject({ match: "matched", failure: null });
    const unbound = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: [] },
    ]);
    expect(unbound.rows[0]).toMatchObject({ match: "unbound", failure: null });
    const unknownKind = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "no-such-kind", requirementIds: ["R-1"] },
    ]);
    expect(unknownKind.rows[0]).toMatchObject({ match: "invalid", failure: "unknown-kind" });
    const unknownId = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-9"] },
    ]);
    expect(unknownId.rows[0]).toMatchObject({ match: "invalid", failure: "unknown-requirement" });
    const duplicateId = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1", "R-1"] },
    ]);
    expect(duplicateId.rows[0]).toMatchObject({ match: "invalid", failure: "duplicate-requirement" });
    // 同じ添字への複数行は、先頭を選ばずに両方を invalid として残す
    const duplicateIndex = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
      { uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-2"] },
    ]);
    expect(duplicateIndex.rows.map((row) => row.failure)).toEqual(["duplicate-index", "duplicate-index"]);
    // 不正な添字は、行き先を持たない orphan になる
    const orphan = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 3, missingKind: "target", requirementIds: ["R-1"] },
    ]);
    expect(orphan.rows).toHaveLength(1);
    expect(orphan.orphans).toEqual([
      { uncoveredIndex: 3, kind: "target", requirementIds: ["R-1"], failure: "index-out-of-range" },
    ]);
  });

  it("outside は詳細の有無によらず invalid を優先する", () => {
    const list: RequirementList = { requirements: [], decisions: [], unresolved: [] };
    const reported = [{ range: { start: 5, end: 5 }, destination: "outside" as const, fragments: [] }];
    // 詳細がある行
    const withDetail = classifyConditionFindings("ab", list, reported, [
      { uncoveredIndex: 0, missingKind: "target", requirementIds: [] },
    ]);
    expect(withDetail.rows[0]).toMatchObject({ match: "invalid", failure: "outside" });
    // 詳細の行が無い行も、missing ではなく invalid（outside を優先する）
    const withoutDetail = classifyConditionFindings("ab", list, reported, []);
    expect(withoutDetail.rows[0]).toMatchObject({
      destination: "outside",
      kind: null,
      requirementIds: [],
      match: "invalid",
      failure: "outside",
    });
    // 件数の集計でも missing ではなく invalid に数える
    expect(summarizeConditionFindings(withoutDetail).whole).toMatchObject({ missing: 0, invalid: 1 });
  });

  it("件数の集計は、元の添字ごとに 1 件で、全体＝2 群の和・種類の和＝matched＋unbound になる", () => {
    const findings = classifyConditionFindings(
      "abcd",
      {
        requirements: [{ id: "R-1", text: "a", quote: "a", position: { start: 0, end: 1 } }],
        decisions: [],
        unresolved: [],
      },
      [
        { range: { start: 0, end: 1 }, destination: "remaining", fragments: [] },
        { range: { start: 1, end: 2 }, destination: "framing", fragments: [] },
      ],
      [
        { uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-1"] },
        { uncoveredIndex: 1, missingKind: "scope", requirementIds: [] },
      ],
    );
    const summary = summarizeConditionFindings(findings);
    expect(summary.whole).toMatchObject({ rawCount: 2, matched: 1, unbound: 1, missing: 0, invalid: 0 });
    expect(summary.remaining).toMatchObject({ rawCount: 1, matched: 1 });
    expect(summary.other).toMatchObject({ rawCount: 1, unbound: 1 });
    expect(summary.whole.kinds["time"]).toBe(1);
    expect(summary.whole.kinds["scope"]).toBe(1);
    for (const counts of [summary.whole, summary.remaining, summary.other]) {
      expect(counts.rawCount).toBe(counts.matched + counts.unbound + counts.missing + counts.invalid);
      expect(Object.values(counts.kinds).reduce((sum, count) => sum + count, 0)).toBe(
        counts.matched + counts.unbound,
      );
    }
  });

  it("既知の種類と派生 schema は、既存の schema の実体を変えない", () => {
    expect(isKnownConditionKind("negation")).toBe(true);
    expect(isKnownConditionKind("no-such-kind")).toBe(false);
    expect(reverseCheckSchemaOf()).toBe(REVERSE_CHECK_SCHEMA);
    expect(reverseCheckSchemaOf(false)).toBe(REVERSE_CHECK_SCHEMA);
    const derived = reverseCheckSchemaOf(true) as { required: readonly string[]; properties: Record<string, unknown> };
    expect(derived.required).toEqual(["uncovered", REVERSE_CHECK_FINDING_DETAILS_KEY]);
    expect(derived.properties["uncovered"]).toBe(REVERSE_CHECK_SCHEMA.properties.uncovered);
    expect(REVERSE_CHECK_SCHEMA.required).toEqual(["uncovered"]);
    expect(REVERSE_CHECK_SCHEMA.properties).not.toHaveProperty("findingDetails");
  });

  it("派生 schema の応答は、既存の uncovered の検査をそのまま通し、詳細だけを読む", () => {
    const checked = checkReverseCheckOutputWithConditionFindings({
      uncovered: [{ start: 0, end: 1 }],
      findingDetails: [
        { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
        { uncoveredIndex: "x", missingKind: "target", requirementIds: [] },
      ],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.uncovered).toEqual([{ start: 0, end: 1 }]);
    expect(checked.value.findingDetails).toEqual([
      { uncoveredIndex: 0, missingKind: "target", requirementIds: ["R-1"] },
    ]);
  });
});

// ── Issue #951：Plan の逆照合に条件と適用先の台帳を記録する（段 1・行き先は変えない）──
//
// 受入の題材の語・値は使わない。**意味の正解**（条件の抽出・適用先の網羅）ではなく、参照の構造
// （範囲・ID・行の欠け・重複・孤立・証拠）だけを固定する。

/** 台帳を試す原文（3 文。適用先の範囲は文の範囲で与える） */
const LEDGER_SOURCE = "印を出す。件数を合計する。記録する。";
/** 台帳を試す一覧（R-1・R-2 の要件。本文は証拠の逐語を含む） */
const LEDGER_LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 0, end: 5 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を合計する。", position: { start: 5, end: 13 } },
    { id: "R-3", text: "記録できる", quote: "記録する。", position: { start: 13, end: 18 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};

/** 台帳の条件 1 つを作る補助（範囲は原文の添字で与える） */
const ledgerCondition = (
  conditionId: string,
  kind: string,
  start: number,
  end: number,
  targets: readonly { readonly targetId: string; readonly start: number; readonly end: number; readonly requirementIds: readonly string[] }[],
) => ({
  conditionId,
  range: { start, end },
  kind,
  targets: targets.map((target) => ({
    targetId: target.targetId,
    range: { start: target.start, end: target.end },
    requirementIds: target.requirementIds,
  })),
});

/** 台帳の行 1 つを作る補助 */
const ledgerRow = (
  conditionId: string,
  targetId: string,
  status: string,
  evidence: readonly { readonly requirementId: string; readonly text: string }[] = [],
) => ({ conditionId, targetId, status, evidence });

/** 追加診断（台帳の欄）を除いた、逆照合ループの結果（Issue #951 の試験で使う） */
const ledgerLoopCoreOf = (value: {
  readonly list: unknown;
  readonly report: unknown;
  readonly redone: boolean;
  readonly repaired: boolean;
  readonly unmet: unknown;
}) => ({
  list: value.list,
  report: value.report,
  redone: value.redone,
  repaired: value.repaired,
  unmet: value.unmet,
});

describe("T5条件台帳の記録（Issue #951）", () => {
  it("派生 schema は 4 つの組を区別し、既存の uncovered・findingDetails の定義と並びを変えない", () => {
    // どちらも省く＝既存の基本 schema（実体が同じ）
    expect(reverseCheckSchemaOf()).toBe(REVERSE_CHECK_SCHEMA);
    expect(reverseCheckSchemaOf(false, false)).toBe(REVERSE_CHECK_SCHEMA);
    // findings だけ＝既存の派生 schema（#948 と同じ並び）
    const findingsOnly = reverseCheckSchemaOf(true, false) as {
      readonly required: readonly string[];
      readonly properties: Record<string, unknown>;
    };
    expect(findingsOnly.required).toEqual(["uncovered", REVERSE_CHECK_FINDING_DETAILS_KEY]);
    // ledger だけ＝基本＋台帳
    const ledgerOnly = reverseCheckSchemaOf(false, true) as {
      readonly required: readonly string[];
      readonly properties: Record<string, unknown>;
    };
    expect(ledgerOnly.required).toEqual(["uncovered", REVERSE_CHECK_CONDITION_LEDGER_KEY]);
    expect(ledgerOnly.properties["uncovered"]).toBe(REVERSE_CHECK_SCHEMA.properties.uncovered);
    // 両方＝基本＋詳細＋台帳（**欄順を固定する**）
    const both = reverseCheckSchemaOf(true, true) as {
      readonly required: readonly string[];
      readonly properties: Record<string, unknown>;
    };
    expect(both.required).toEqual([
      "uncovered",
      REVERSE_CHECK_FINDING_DETAILS_KEY,
      REVERSE_CHECK_CONDITION_LEDGER_KEY,
    ]);
    expect(Object.keys(both.properties)).toEqual([
      "uncovered",
      REVERSE_CHECK_FINDING_DETAILS_KEY,
      REVERSE_CHECK_CONDITION_LEDGER_KEY,
    ]);
    // 既存の欄の定義は同じ実体（見た目も変えない）
    expect(both.properties["uncovered"]).toBe(REVERSE_CHECK_SCHEMA.properties.uncovered);
    expect(both.properties[REVERSE_CHECK_FINDING_DETAILS_KEY]).toBe(
      findingsOnly.properties[REVERSE_CHECK_FINDING_DETAILS_KEY],
    );
    // 台帳の欄の定義は、台帳だけの組と同じ実体
    expect(both.properties[REVERSE_CHECK_CONDITION_LEDGER_KEY]).toBe(
      ledgerOnly.properties[REVERSE_CHECK_CONDITION_LEDGER_KEY],
    );
    // 既存の schema は書き換えていない
    expect(REVERSE_CHECK_SCHEMA.required).toEqual(["uncovered"]);
    expect(REVERSE_CHECK_SCHEMA.properties).not.toHaveProperty(REVERSE_CHECK_CONDITION_LEDGER_KEY);
    // 台帳の欄は conditions・rows の 2 つだけ（scanned のような網羅の欄を置かない）
    expect(Object.keys(REVERSE_CHECK_CONDITION_LEDGER_SCHEMA.properties)).toEqual(["conditions", "rows"]);
    expect(REVERSE_CHECK_CONDITION_LEDGER_SCHEMA.required).toEqual(["conditions", "rows"]);
  });

  it("台帳の欄を送った往復だけが trace と診断に記録し、送らなければ欄が増えない", async () => {
    const withLedger = createRecordingClient([
      structured({
        uncovered: [],
        conditionLedger: {
          conditions: [
            ledgerCondition("C-1", "scope", 0, 13, [
              { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
              { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
            ]),
          ],
          rows: [
            ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]),
            ledgerRow("C-1", "T-2", "missing"),
          ],
        },
      }),
    ]);
    const on = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(withLedger.client, { maxAttempts: 1 }),
      observeConditionLedger: true,
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const ledger = on.value.trace.conditionLedger;
    expect(ledger).toBeDefined();
    if (ledger === undefined) return;
    expect(ledger.observation).toBe("observed");
    expect(ledger.conditions[0]?.targets.map((target) => target.failure)).toEqual([null, null]);
    expect(ledger.rows.map((row) => row.status)).toEqual(["retained", "missing"]);
    // 算出範囲はコードが要件の本文から求める（本文の添字）
    expect(ledger.rows[0]?.evidence[0]?.range).toEqual({ start: 0, end: 4 });
    // 通常の診断は件数だけ
    const diagnosis = on.value.round.conditionLedger;
    expect(diagnosis?.counts).toMatchObject({
      rawConditionRows: 1,
      consistentConditionRows: 1,
      unknownConditionRows: 0,
      rawCorrespondenceRows: 2,
      retained: 1,
      missing: 1,
      unknown: 0,
    });
    // 送らない往復（Build の経路）は、trace にも診断にも欄を持たない
    const offRecording = createRecordingClient([structured({ uncovered: [] })]);
    const off = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(offRecording.client, { maxAttempts: 1 }),
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.trace.conditionLedger).toBeUndefined();
    expect(off.value.round.conditionLedger).toBeUndefined();
    // 送る schema は台帳の欄を持つ（要求のバイト列の schema だけが違う）
    const offSchema = offRecording.structured[0]?.schema as { required?: readonly string[] } | undefined;
    const onSchema = withLedger.structured[0]?.schema as { required?: readonly string[] } | undefined;
    expect(offSchema?.required).toEqual(["uncovered"]);
    expect(onSchema?.required).toEqual(["uncovered", REVERSE_CHECK_CONDITION_LEDGER_KEY]);
    // 台帳以外の要求の欄は変えない
    expect(withLedger.structured[0]?.instructions).toBe(offRecording.structured[0]?.instructions);
    expect(withLedger.structured[0]?.input).toBe(offRecording.structured[0]?.input);
    expect(withLedger.structured[0]?.rules).toEqual(offRecording.structured[0]?.rules);
  });

  it("期限の3適用先・共有否定の2適用先・別要件の補完・対象要件なしを記録できる", () => {
    // 3 つの範囲に掛かる期限の条件
    const deadline = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "deadline", 0, 13, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
          { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
          { targetId: "T-3", start: 13, end: 18, requirementIds: ["R-3"] },
        ]),
      ],
      rows: [
        ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]),
        ledgerRow("C-1", "T-2", "retained", [{ requirementId: "R-2", text: "件数を合計できる" }]),
        ledgerRow("C-1", "T-3", "missing"),
      ],
    });
    expect(deadline.conditions[0]?.targets).toHaveLength(3);
    expect(deadline.observation).toBe("observed");
    // 共有否定を 2 つの適用先へ掛ける
    const negation = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "negation", 0, 13, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
          { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
        ]),
      ],
      rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]), ledgerRow("C-1", "T-2", "missing")],
    });
    expect(negation.conditions[0]?.targets).toHaveLength(2);
    // 別要件による補完（適用先が 2 つの要件 ID を持つ）
    const complemented = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "exception", 0, 13, [
          { targetId: "T-1", start: 0, end: 13, requirementIds: ["R-1", "R-2"] },
        ]),
      ],
      rows: [
        ledgerRow("C-1", "T-1", "retained", [
          { requirementId: "R-1", text: "印を出せ" },
          { requirementId: "R-2", text: "件数を合計できる" },
        ]),
      ],
    });
    expect(complemented.conditions[0]?.targets[0]?.requirementIds).toEqual(["R-1", "R-2"]);
    expect(complemented.rows[0]?.status).toBe("retained");
    // 対象要件なし（要件自体が無い。空の適用先を許す）
    const noTarget = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "target", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: [] }]),
      ],
      rows: [ledgerRow("C-1", "T-1", "missing")],
    });
    expect(noTarget.conditions[0]?.targets[0]?.failure).toBeNull();
    expect(noTarget.rows[0]?.status).toBe("missing");
    expect(summarizeConditionLedger(noTarget).observation).toBe("observed");
  });

  it("種類・範囲・ID 不正、行抜け・重複・孤立、retained 証拠なし、部分文字列の不存在・複数出現を unknown と理由へ分ける", () => {
    const broken = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        // 範囲が原文の外
        ledgerCondition("C-range", "target", 100, 120, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
        ]),
        // 未知の種類
        ledgerCondition("C-kind", "no-such-kind", 0, 5, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
        ]),
        // 未知の要件 ID
        ledgerCondition("C-req", "target", 0, 5, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-9"] },
        ]),
      ],
      rows: [
        // retained なのに証拠が空
        ledgerRow("C-kind", "T-1", "retained"),
        // 証拠の逐語が本文に無い
        ledgerRow("C-range", "T-1", "retained", [{ requirementId: "R-1", text: "本文に無い逐語" }]),
        // 証拠の逐語が本文に 2 か所以上（「件数」を 2 回含む本文を用意する）
        ledgerRow("C-req", "T-1", "missing"),
      ],
    });
    const failures = broken.conditions.map((condition) => condition.failure);
    expect(failures).toEqual(["range", "unknown-kind", "unknown-requirement"]);
    // 条件の不整合は、行の側でも理由を持つ（condition-invalid）
    expect(broken.rows.map((row) => row.failure)).toEqual(["condition-invalid", "condition-invalid", "condition-invalid"]);
    expect(broken.observation).toBe("indeterminate");

    // 逐語の複数出現は evidence-ambiguous、無い逐語は evidence-not-found
    const ambiguousList: RequirementList = {
      requirements: [{ id: "R-1", text: "印を印として出す", quote: "印を出す。", position: { start: 0, end: 5 } }],
      decisions: [],
      unresolved: [],
    };
    const evidence = classifyConditionLedger("印を出す。", ambiguousList, {
      conditions: [
        ledgerCondition("C-1", "target", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }]),
      ],
      rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印" }])],
    });
    expect(evidence.rows[0]?.failure).toBe("evidence-ambiguous");
    const notFound = classifyConditionLedger("印を出す。", ambiguousList, {
      conditions: [
        ledgerCondition("C-1", "target", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }]),
      ],
      rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "無い逐語" }])],
    });
    expect(notFound.rows[0]?.failure).toBe("evidence-not-found");

    // 行抜け（宣言した組に行が無い）と孤立（宣言していない組の行）を分ける
    const gaps = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "scope", 0, 13, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
          { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
        ]),
      ],
      rows: [
        // T-1 の行が無い（行抜け）
        ledgerRow("C-1", "T-9", "missing"),
      ],
    });
    expect(gaps.rowMissing).toEqual([
      { conditionId: "C-1", targetId: "T-1" },
      { conditionId: "C-1", targetId: "T-2" },
    ]);
    expect(gaps.rows[0]?.failure).toBe("orphan-target");
    expect(gaps.observation).toBe("indeterminate");
    // 宣言していない条件の行は orphan-row
    const orphan = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "scope", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }]),
      ],
      rows: [
        ledgerRow("C-1", "T-1", "missing"),
        ledgerRow("C-9", "T-1", "missing"),
      ],
    });
    expect(orphan.rows[1]?.failure).toBe("orphan-row");
    // 同じ組の重複行は両方 unknown（先頭を選ばない）
    const duplicated = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "scope", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }]),
      ],
      rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]), ledgerRow("C-1", "T-1", "missing")],
    });
    expect(duplicated.rows.map((row) => row.failure)).toEqual(["duplicate-row", "duplicate-row"]);
  });

  it("収支が一致する（条件＝整合＋不明・対応＝retained＋missing＋unknown・組＝1 行＋0 行＋複数行）", () => {
    const ledger = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [
        ledgerCondition("C-1", "scope", 0, 13, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
          { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
        ]),
        ledgerCondition("C-2", "time", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-9"] }]),
      ],
      rows: [
        ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]),
        ledgerRow("C-1", "T-2", "missing"),
        ledgerRow("C-1", "T-2", "missing"),
        ledgerRow("C-2", "T-1", "retained", [{ requirementId: "R-9", text: "何か" }]),
      ],
    });
    const diagnosis = summarizeConditionLedger(ledger);
    const counts = diagnosis.counts;
    expect(counts.rawConditionRows).toBe(2);
    expect(counts.consistentConditionRows! + counts.unknownConditionRows!).toBe(counts.rawConditionRows);
    expect(counts.rawCorrespondenceRows).toBe(counts.retained! + counts.missing! + counts.unknown!);
    expect(counts.declaredPairs).toBe(
      counts.singleRowPairs! + counts.noRowPairs! + counts.multipleRowPairs!,
    );
    // 理由の重複を分母に加算しない（行 1 つは理由 1 つ）
    const rowFailures = Object.values(counts.unknownRows).reduce((sum, value) => sum + value, 0);
    expect(rowFailures).toBe(counts.unknown);
    // 条件の不明は、条件の数以下
    const conditionFailures = Object.values(counts.unknownConditions).reduce((sum, value) => sum + value, 0);
    expect(conditionFailures).toBe(counts.unknownConditionRows);
  });

  it("算出範囲は本文に一致し、意味の正解とは扱わない", () => {
    // 本文の途中に逐語がある。範囲はコードが本文の添字で求める
    const list: RequirementList = {
      requirements: [{ id: "R-1", text: "前文・対象の印・後文", quote: "印を出す。", position: { start: 0, end: 5 } }],
      decisions: [],
      unresolved: [],
    };
    const ledger = classifyConditionLedger("印を出す。", list, {
      conditions: [
        ledgerCondition("C-1", "target", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }]),
      ],
      rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "対象の印" }])],
    });
    const evidence = ledger.rows[0]?.evidence[0];
    expect(evidence?.range).toEqual({ start: 3, end: 7 });
    // 申告された本文の添字は使わない（要求に添字の欄が無い）
    expect(new Set(Object.keys(ledger.rows[0]!))).toEqual(new Set(["conditionId", "evidence", "failure", "status", "targetId"]));
    expect(new Set(Object.keys(evidence!))).toEqual(new Set(["range", "requirementId", "text"]));
  });

  it("観測不明・未観測・0 件申告を区別する", () => {
    // 0 件申告（完了し、両配列が空）
    const empty = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, { conditions: [], rows: [] });
    expect(empty.observation).toBe("empty");
    const emptyCounts = summarizeConditionLedger(empty);
    expect(emptyCounts.observation).toBe("empty");
    expect(emptyCounts.counts.rawConditionRows).toBe(0);
    // 0 件を網羅済みと認定しない（欄が無い＝未観測とは別の値）
    // 構造不整合（観測不明）
    const broken = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [ledgerCondition("C-1", "no-such-kind", 0, 5, [{ targetId: "T-1", start: 0, end: 5, requirementIds: [] }])],
      rows: [],
    });
    expect(broken.observation).toBe("indeterminate");
    // 読めない値があれば、分母は null（0 にしない）
    const unreadable = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, {
      conditions: [],
      rows: [],
      dropped: [{ source: "conditions", index: 0, field: "kind" }],
    });
    const unreadableCounts = summarizeConditionLedger(unreadable);
    expect(unreadable.observation).toBe("indeterminate");
    expect(unreadableCounts.counts.rawConditionRows).toBeNull();
    expect(unreadableCounts.counts.retained).toBeNull();
    expect(unreadableCounts.counts.declaredPairs).toBeNull();
  });

  it("台帳を替えても、既存の指摘・redo 入力・呼び出し列は同じ（追加診断だけが変わる）", async () => {
    const variants: readonly unknown[] = [
      // 台帳の欄が無い
      undefined,
      // 0 件申告
      { conditions: [], rows: [] },
      // 保持（retained）
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }])],
      },
      // 不足（missing）
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [ledgerRow("C-1", "T-1", "missing")],
      },
      // 不明（unknown）
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [ledgerRow("C-1", "T-1", "unknown")],
      },
      // 行抜け
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [],
      },
      // 重複行
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [ledgerRow("C-1", "T-1", "missing"), ledgerRow("C-1", "T-1", "retained")],
      },
      // 順序入替
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }])],
      },
      // 不正な行（孤立）
      {
        conditions: [ledgerCondition("C-1", "scope", 0, 13, [{ targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] }])],
        rows: [
          ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]),
          ledgerRow("C-9", "T-9", "retained"),
        ],
      },
    ];
    /** 固定の 3 文の原文で、初回に覆いの落ちを 1 件出し、作り直しの P2 は落ちなしにする */
    const run = async (conditionLedger: unknown) => {
      const recording = createRecordingClient([
        structured(LEDGER_LIST),
        structured(conditionLedger === undefined ? { uncovered: [{ start: 13, end: 18 }] } : { uncovered: [{ start: 13, end: 18 }], conditionLedger }),
        structured(LEDGER_LIST),
        structured(conditionLedger === undefined ? { uncovered: [] } : { uncovered: [], conditionLedger }),
      ]);
      const outcome = await runReverseCheckLoopWithOperation({
        source: LEDGER_SOURCE,
        documents: [],
        gateway: makeGateway(recording.client, { maxAttempts: 1 }),
        observeConditionLedger: true,
      });
      return { recording, outcome };
    };
    const baseline = await run(undefined);
    expect(baseline.outcome.ok).toBe(true);
    if (!baseline.outcome.ok) return;
    const expectedCore = ledgerLoopCoreOf(baseline.outcome.value);
    const expectedCalls = baseline.recording.structured.map((request) => JSON.stringify(request));
    const expectedRounds = baseline.outcome.value.diagnosis.rounds.map((round) => {
      const { conditionLedger: _ledger, ...rest } = round;
      return rest;
    });
    for (const conditionLedger of variants) {
      const variant = await run(conditionLedger);
      expect(variant.outcome.ok).toBe(true);
      if (!variant.outcome.ok) return;
      // 結果・redo 入力・呼び出し列は同じ
      expect(ledgerLoopCoreOf(variant.outcome.value)).toEqual(expectedCore);
      expect(variant.recording.structured.map((request) => JSON.stringify(request))).toEqual(expectedCalls);
      // 追加診断（台帳の件数）以外の診断は同じ
      const rounds = variant.outcome.value.diagnosis.rounds.map((round) => {
        const { conditionLedger: _ledger, ...rest } = round;
        return rest;
      });
      expect(rounds).toEqual(expectedRounds);
    }
  });

  it("合成例（期限の3適用先・共有否定の2適用先・別要件の補完・対象要件なし）でも、会話の不足指摘を保ち確定へ進めない", async () => {
    // 初回の P2 が覆いの落ちを出し、台帳も返す。作り直しの P2 も覆いが残る（止まる）
    const cover = { uncovered: [{ start: 13, end: 18 }] };
    const ledger = {
      conditions: [
        ledgerCondition("C-1", "deadline", 0, 13, [
          { targetId: "T-1", start: 0, end: 5, requirementIds: ["R-1"] },
          { targetId: "T-2", start: 5, end: 13, requirementIds: ["R-2"] },
        ]),
      ],
      rows: [
        ledgerRow("C-1", "T-1", "retained", [{ requirementId: "R-1", text: "印を出せ" }]),
        ledgerRow("C-1", "T-2", "missing"),
      ],
    };
    const recording = createRecordingClient([
      structured(LEDGER_LIST),
      structured({ ...cover, conditionLedger: ledger }),
    ]);
    const outcome = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionLedger: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 会話の指摘（覆い）は消えない（台帳の有無で結果が変わらない）
    expect(outcome.value.result.misses.length).toBeGreaterThan(0);
    expect(outcome.value.trace.conditionLedger?.observation).toBe("observed");
    expect(outcome.value.trace.conditionLedger?.rows.map((row) => row.status)).toEqual(["retained", "missing"]);
  });

  it("既存の覆い・矛盾の拒否と、従来の条件指摘・来歴保存は前後とも緑", async () => {
    // 台帳の欄を足しても、既存の指摘の詳細は同じ（両方 on の組でも、findingDetails の記録は変わらない）
    const answer = {
      uncovered: [{ start: 13, end: 18 }],
      findingDetails: [{ uncoveredIndex: 0, missingKind: "time", requirementIds: ["R-3"] }],
      conditionLedger: {
        conditions: [ledgerCondition("C-1", "time", 13, 18, [{ targetId: "T-1", start: 13, end: 18, requirementIds: ["R-3"] }])],
        rows: [ledgerRow("C-1", "T-1", "missing")],
      },
    };
    const both = createRecordingClient([structured(answer)]);
    const withLedger = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(both.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
      observeConditionLedger: true,
    });
    const onlyFindings = createRecordingClient([structured({ uncovered: answer.uncovered, findingDetails: answer.findingDetails })]);
    const withoutLedger = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(onlyFindings.client, { maxAttempts: 1 }),
      observeConditionFindings: true,
    });
    expect(withLedger.ok).toBe(true);
    expect(withoutLedger.ok).toBe(true);
    if (!withLedger.ok || !withoutLedger.ok) return;
    // 条件の指摘の記録は同じ
    expect(withLedger.value.trace.conditionFindings).toEqual(withoutLedger.value.trace.conditionFindings);
    expect(withLedger.value.round.conditionFindings).toEqual(withoutLedger.value.round.conditionFindings);
    // 既存の結果も同じ（台帳は判定に効かない）
    expect(withLedger.value.result).toEqual(withoutLedger.value.result);
    // 台帳は追加の記録としてだけ載る
    expect(withoutLedger.value.trace.conditionLedger).toBeUndefined();
    expect(withLedger.value.trace.conditionLedger?.observation).toBe("observed");
  });

  it("wire の欄欠落・型違反は段の失敗にせず、読めた行だけを読み、読めない行は添字と欄だけを残す", () => {
    // 行の型が合うものだけを読む（parseConditionLedger）
    const parsed = parseConditionLedger({
      conditions: [
        { conditionId: "C-1", range: { start: 0, end: 5 }, kind: "target", targets: [] },
        { conditionId: "C-2", range: { start: 0, end: 5 }, kind: 7, targets: [] },
      ],
      rows: [
        { conditionId: "C-1", targetId: "T-1", status: "missing", evidence: [] },
        { conditionId: "C-2", targetId: "T-1", status: "missing" },
      ],
    });
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.dropped).toEqual([
      { source: "conditions", index: 1, field: "kind" },
      { source: "rows", index: 1, field: "evidence" },
    ]);
    // 読めない値は元の並びの添字と既知の欄だけ（余剰のデータを複写しない）
    const withExtras = parseConditionLedger({
      conditions: [{ conditionId: "C-1", range: "no", kind: "target", targets: [], secret: "MARK_LEAK" }],
      rows: [],
    });
    expect(withExtras.dropped).toEqual([{ source: "conditions", index: 0, field: "range" }]);
    expect(JSON.stringify(withExtras)).not.toContain("MARK_LEAK");
    // 台帳の欄を送った往復の形の検査は、既存の uncovered の検査をそのまま通す
    const checked = checkReverseCheckOutputWithConditionLedger(
      { uncovered: [{ start: 0, end: 1 }], conditionLedger: { conditions: [], rows: [] } },
      false,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.uncovered).toEqual([{ start: 0, end: 1 }]);
    expect(checked.value.conditionLedger).toEqual({ conditions: [], rows: [], dropped: [] });
  });

  it("通常記録の追加部分に ID・範囲・本文・引用・余剰データの目印文字列がなく、trace に許可した行・参照だけが残る", async () => {
    const source = "MARKSRCを印として出す。MARKTEXTを合計する。";
    const list: RequirementList = {
      requirements: [
        { id: "MARKID1", text: "MARKTEXT1を出せる", quote: "MARKSRCを印として出す。", position: { start: 0, end: 11 } },
        { id: "MARKID2", text: "MARKTEXT2を合計できる", quote: "MARKTEXTを合計する。", position: { start: 11, end: 22 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured({
        uncovered: [],
        conditionLedger: {
          conditions: [
            ledgerCondition("MARKC1", "scope", 0, 11, [
              { targetId: "MARKT1", start: 0, end: 11, requirementIds: ["MARKID1"] },
            ]),
          ],
          rows: [ledgerRow("MARKC1", "MARKT1", "retained", [{ requirementId: "MARKID1", text: "MARKTEXT1" }])],
        },
      }),
    ]);
    const outcome = await runReverseCheckWithDiagnosis({
      source,
      list,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionLedger: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 通常の診断（件数）には目印が出ない
    const counts = JSON.stringify(outcome.value.round.conditionLedger);
    for (const marker of ["MARKSRC", "MARKTEXT", "MARKID", "MARKC", "MARKT"]) expect(counts).not.toContain(marker);
    // trace には条件・適用先・申告判定・証拠・算出範囲が残る
    const trace = outcome.value.trace.conditionLedger;
    expect(trace?.conditions[0]?.conditionId).toBe("MARKC1");
    expect(trace?.conditions[0]?.targets[0]?.targetId).toBe("MARKT1");
    expect(trace?.conditions[0]?.targets[0]?.requirementIds).toEqual(["MARKID1"]);
    expect(trace?.rows[0]?.status).toBe("retained");
    expect(trace?.rows[0]?.evidence[0]?.range).toEqual({ start: 0, end: 9 });
    // trace に、許可していない欄（生の余剰データ）が無い
    expect(new Set(Object.keys(trace!))).toEqual(
      new Set(["conditions", "declaredPairs", "dropped", "observation", "rowMissing", "rows"]),
    );
    expect(new Set(Object.keys(trace!.rows[0]!))).toEqual(new Set(["conditionId", "evidence", "failure", "status", "targetId"]));
    // 原文・一覧の SHA は同じ往復の trace が持つ（台帳は持たない）
    expect(trace).not.toHaveProperty("sourceSha256");
    expect(trace).not.toHaveProperty("listSha256");
  });

  it("欄順と説明文の許可差分を固定する（台帳の有無は別の欄で、既存の欄の文は変えない）", () => {
    // 台帳だけの組の欄を、通しで固定する（説明は台帳の欄の意味だけ）
    const ledgerOnly = reverseCheckSchemaOf(false, true) as {
      readonly properties: Record<string, { readonly description: string; readonly required: readonly string[] }>;
    };
    const field = ledgerOnly.properties[REVERSE_CHECK_CONDITION_LEDGER_KEY];
    expect(field?.required).toEqual(["conditions", "rows"]);
    expect(field?.description).toBe(
      "原文が運ぶ条件と、その条件が掛かる適用先（対象）の台帳。条件ごとに、本文がその条件を保っているかを行で示す。",
    );
    // 台帳の欄の説明は、uncovered の意味・指摘の基準に触れない
    expect(field?.description).not.toContain("uncovered");
    expect(field?.description).not.toContain("指摘");
    // 既存の欄の説明は、#948 の派生 schema と同じ（1 文字も変えない）
    const findingsOnly = reverseCheckSchemaOf(true, false) as {
      readonly properties: Record<string, { readonly description: string }>;
    };
    const both = reverseCheckSchemaOf(true, true) as {
      readonly properties: Record<string, { readonly description: string }>;
    };
    expect(both.properties[REVERSE_CHECK_FINDING_DETAILS_KEY]?.description).toBe(
      findingsOnly.properties[REVERSE_CHECK_FINDING_DETAILS_KEY]?.description,
    );
    expect(both.properties["uncovered"]).toBe(REVERSE_CHECK_SCHEMA.properties.uncovered);
  });

  it("欄を持たない旧記録は読める（台帳の欄は任意で、無ければ台帳を足さない）", () => {
    // 台帳の欄を持たない旧形式の応答を、台帳つきの検査に通しても読める（台帳は 0 件申告になる）
    const checked = checkReverseCheckOutputWithConditionLedger({ uncovered: [{ start: 0, end: 1 }] }, true);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.uncovered).toEqual([{ start: 0, end: 1 }]);
    expect(checked.value.conditionLedger).toEqual({ conditions: [], rows: [], dropped: [] });
    // 旧形式のパース結果はそのまま（欠けている欄を捏造しない）
    expect(parseConditionLedger(undefined)).toEqual({ conditions: [], rows: [], dropped: [] });
    // 台帳の件数は、欄の無い往復で 0 件申告として扱える（未観測とは別の値）
    const empty = classifyConditionLedger(LEDGER_SOURCE, LEDGER_LIST, { conditions: [], rows: [] });
    expect(summarizeConditionLedger(empty).observation).toBe("empty");
  });

  it("台帳の構造不整合から再試行を起こさず、形の再試行の前回応答の中の台帳差分だけを許す", async () => {
    // 台帳の値が構造の照合で使えなくても、段の形は通り、再試行しない（1 回の呼び出しで終わる）
    const brokenLedger = {
      conditions: [{ conditionId: "C-1", range: { start: 0, end: 5 }, kind: "no-such-kind", targets: [] }],
      rows: [{ conditionId: "C-1", targetId: "T-9", status: "retained", evidence: [] }],
    };
    const recording = createRecordingClient([structured({ uncovered: [], conditionLedger: brokenLedger })]);
    const outcome = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      observeConditionLedger: true,
    });
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(1);
    if (!outcome.ok) return;
    // 段の結果は変わらない（台帳は判定に効かない）。ただし観測は indeterminate
    expect(outcome.value.result.misses).toEqual([]);
    expect(outcome.value.trace.conditionLedger?.observation).toBe("indeterminate");

    // 形の再試行（uncovered の型違い）では、2 回目の input に前回の応答の塊だけが足される。
    // その塊の中の台帳の差分は許すが、**要求の schema・rules・instructions は 1 文字も変えない**
    const retryRecording = createRecordingClient([
      structured({ uncovered: "no", conditionLedger: brokenLedger }),
      structured({ uncovered: [], conditionLedger: { conditions: [], rows: [] } }),
    ]);
    const retried = await runReverseCheckWithDiagnosis({
      source: LEDGER_SOURCE,
      list: LEDGER_LIST,
      documents: [],
      gateway: makeGateway(retryRecording.client, { maxAttempts: 1 }),
      observeConditionLedger: true,
    });
    expect(retried.ok).toBe(true);
    expect(retryRecording.structured).toHaveLength(2);
    const first = retryRecording.structured[0];
    const second = retryRecording.structured[1];
    // 前置き（schema・rules・instructions）は同じ
    expect(second?.schema).toBe(first?.schema);
    expect(second?.rules).toEqual(first?.rules);
    expect(second?.instructions).toBe(first?.instructions);
    expect(second?.schemaName).toBe(first?.schemaName);
    // 2 回目の input は、1 回目の input に前回の応答と問題の塊を足したもの（前回応答に台帳の差分が入る）
    expect(second?.input.startsWith(first?.input ?? "")).toBe(true);
    expect(second?.input).toContain("conditionLedger");
  });

  it("初回・作り直し後・引用修復後の保存の 3 つの往復に記録する", async () => {
    // 初回が来歴だけ → 修復 → 修復の後が覆いを含む → 作り直し → P2 も覆いを含む
    const source = "印を出す。印を出す。件数を合計する。";
    const initialList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。", position: { start: 1, end: 6 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 19 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const redone = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: "印を出す。印を出す。", position: { start: 0, end: 10 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: { start: 10, end: 19 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const ledgerFor = (kind: string) => ({
      conditions: [ledgerCondition("C-1", kind, 0, 10, [{ targetId: "T-1", start: 1, end: 6, requirementIds: ["R-1"] }])],
      rows: [ledgerRow("C-1", "T-1", "missing")],
    });
    const recording = createRecordingClient([
      structured(initialList),
      structured({ uncovered: [], conditionLedger: ledgerFor("initial-kind") }),
      structured({ repairs: [{ index: 0, quote: "印を出す。印を出す。", position: { start: 0, end: 10 } }] }),
      structured({ uncovered: [{ start: 0, end: 3 }], conditionLedger: ledgerFor("time") }),
      structured(redone),
      structured({ uncovered: [{ start: 0, end: 3 }], conditionLedger: ledgerFor("negation") }),
    ]);
    const outcome = await runReverseCheckLoopWithOperation({
      source,
      documents: [],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      quoteRepair: true,
      observeConditionLedger: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.diagnosis.rounds.map((round) => round.fix)).toEqual(["initial", "quote-repair", "whole-redo"]);
    // 3 つの往復すべてに、台帳の件数と trace の記録が付く
    for (const round of outcome.value.diagnosis.rounds) expect(round.conditionLedger).toBeDefined();
    for (const round of outcome.value.trace?.rounds ?? []) expect(round.conditionLedger).toBeDefined();
    // 修復の後・作り直しの後の往復に、種類が残る
    expect(outcome.value.trace?.rounds[1]?.conditionLedger?.conditions[0]?.kind).toBe("time");
    expect(outcome.value.trace?.rounds[2]?.conditionLedger?.conditions[0]?.kind).toBe("negation");
    // 記録のない往復（台帳の欄を返さない）は 0 件申告であって、欄が無いのとは違う
    expect(outcome.value.diagnosis.rounds[0]?.conditionLedger?.counts.rawConditionRows).toBe(1);
  });
});
