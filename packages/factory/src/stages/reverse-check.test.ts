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
  REVERSE_CHECK_MEANING_RULE_DEFINITIONS,
  REVERSE_CHECK_RULES,
  REVERSE_CHECK_SCHEMA,
  REVERSE_CHECK_SCHEMA_NAME,
  checkRequirementCoverage,
  isBlankRange,
  overlappingSentences,
  reverseCheckRulesOf,
  runReverseCheck,
  runReverseCheckLoop,
  runReverseCheckLoopWithOperation,
  runReverseCheckWithDiagnosis,
  splitSourceSentences,
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
  /** 原文から引用の位置を求めて、要件 1 件を作る */
  const requirementOf = (source: string, id: string, text: string, quote: string) => {
    const start = source.indexOf(quote);
    return { id, text, quote, position: { start, end: start + quote.length } };
  };
  /** P2 の要求か（schema の名前で見る） */
  const isReverseCheck = (request: { readonly schemaName: string } | undefined): boolean =>
    request?.schemaName === REVERSE_CHECK_SCHEMA_NAME;
  /** 要求の規則（無ければ空） */
  const rulesOf = (request: { readonly rules?: readonly string[] } | undefined): readonly string[] =>
    request?.rules ?? [];

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
    expect(isReverseCheck(request)).toBe(true);
    expect(rulesOf(request).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOf(request).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("(b) 全体の作り直しの後の P2 の要求にも 4 文が入る", async () => {
    // 初回の P2 が覆いの落ちを申告して作り直しへ進む（覆いを含む落ちは修復へ行かない）
    const source = "タスクを記録する。件数を合計する。印を出す。";
    const first = {
      requirements: [
        requirementOf(source, "R-1", "タスクを記録できる", "タスクを記録する。"),
        requirementOf(source, "R-2", "件数を合計できる", "件数を合計する。"),
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const redone = {
      requirements: [
        ...first.requirements,
        requirementOf(source, "R-3", "印を出せる", "印を出す。"),
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
    expect(isReverseCheck(redoneRequest)).toBe(true);
    expect(rulesOf(redoneRequest).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOf(redoneRequest).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
  });

  it("(c) 引用の修復の後の P2 の要求にも 4 文が入る", async () => {
    // 初回の落ちが来歴だけ（引用が原文に無い）なので、修復へ進む
    const source = "記録する。合計する。";
    const list = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        { id: "R-2", text: "合計できる", quote: "原文に無い", position: { start: 5, end: 10 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const repaired = {
      requirements: [
        requirementOf(source, "R-1", "記録できる", "記録する。"),
        requirementOf(source, "R-2", "合計できる", "合計する。"),
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
    expect(isReverseCheck(afterRequest)).toBe(true);
    expect(rulesOf(afterRequest).slice(0, REVERSE_CHECK_RULES.length)).toEqual([...REVERSE_CHECK_RULES]);
    expect(rulesOf(afterRequest).slice(REVERSE_CHECK_RULES.length)).toEqual(MEANING_TEXTS);
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
    const reverseRequests = recording.structured.filter(isReverseCheck);
    expect(reverseRequests).toHaveLength(3);
    for (const request of reverseRequests) {
      expect(rulesOf(request)).toEqual([...REVERSE_CHECK_RULES]);
      expect(rulesOf(request).some((rule) => MEANING_TEXTS.includes(rule))).toBe(false);
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
