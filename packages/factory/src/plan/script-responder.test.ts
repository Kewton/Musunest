// 台本（`musunest-eval/plan-script/v1`）の答える役の unit テスト（04-plan-agent.md §2・§7・§9・Issue #444）。
//
// **実 API も本物の端末も触らない。** ここで固定したいのは 9 つ。
//   1. 台本の 1 件一致で、問いの選択肢を返す
//   2. 不明（当たらない）・2 件一致（重複）・主の事項と一緒に閉じる事項が別の項目に当たる・選択肢 0 件・
//      2 件・古い版では、答えを返さない
//   3. 観点が欠けた値（null）の事項には、観点を求める項目は当たらない（ID の字面で補わない）
//   4. 束の一部にだけ答えてよい（残りは返さない。`all-recommended` は返さない）
//   5. `recommended: true` は推奨の選択肢を返す（台本に無いのとは区別する）
//   6. 鍵は、事項の文と参照先の要件の文の両方に当たる
//   7. 照合の結果は、コードが振った質問 ID・往復の版・照合状態・項目の添字で残る
//   8. 確認の画面の答えは `build`（答えのファイルの形と同じ）
//   9. 形の不正は拒否する（版違い・JSON でない・鍵が正規表現でない・答えの形・観点の型）
import { describe, expect, it } from "vitest";
import type {
  PlanAnswerIssueContext,
  PlanAnswerOutcome,
  PlanAnswerQuestionContext,
  PlanAnswerRequest,
} from "./run-plan.js";
import type { PlanQuestion } from "./questions.js";
import {
  createScriptPlanResponder,
  parsePlanScript,
  PLAN_SCRIPT_SCHEMA,
  type PlanScript,
  type PlanScriptMatch,
  type PlanScriptMatchDiagnosis,
} from "./script-responder.js";

/** 診断の期待値（既定は「当たり無し・v1 は不明」） */
function diag(over: Partial<PlanScriptMatchDiagnosis> = {}): PlanScriptMatchDiagnosis {
  return {
    keysOnlyEntries: 0,
    facetRejectedEntries: 0,
    relaxed: false,
    requirementTextNeeded: 0,
    v1State: "unknown",
    ...over,
  };
}

/** 1 問（選択肢 2 つ・推奨・自由入力） */
function question(overrides: Partial<PlanQuestion> = {}): PlanQuestion {
  return {
    id: "Q1-1",
    openIssueId: "OI-1",
    revision: 1,
    text: "どうしますか",
    choices: [
      { id: "c1", text: "全員分を数える" },
      { id: "c2", text: "自分の分だけ数える" },
    ],
    recommended: { choiceId: "c1", reason: "依頼に沿う" },
    allowFreeText: true,
    alsoCloses: [],
    ...overrides,
  };
}

/** 事項 1 つの照合の文脈（既定は目録の事項。観点 `aggregation`・要件 R-1） */
function issue(overrides: Partial<PlanAnswerIssueContext> = {}): PlanAnswerIssueContext {
  return {
    id: "OI-1",
    text: "要件 R-1「タスクを記録できる」について：何を数え、どう出すか",
    facetId: "aggregation",
    requirement: { id: "R-1", text: "タスクを記録できる" },
    ...overrides,
  };
}

/** 答える役へ渡す要求（既定は 1 問・版 1・目録の事項） */
function request(
  input: {
    readonly questions?: readonly PlanQuestion[];
    readonly issues?: readonly PlanAnswerQuestionContext[];
    readonly revision?: number;
  } = {},
): PlanAnswerRequest {
  const questions = input.questions ?? [question()];
  const revision = input.revision ?? 1;
  const issues =
    input.issues ?? questions.map((q) => ({ question: q, main: issue({ id: q.openIssueId }), alsoCloses: [] }));
  return { questions, remaining: { questions: 5, roundTrips: 2 }, revision, issues };
}

/** 項目に `basis` が無ければ補う（当て方の試験の関心ではない。形の検査は別に試す） */
function withBasis(entry: unknown): unknown {
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    if (record["basis"] === undefined) return { ...record, basis: "basis" };
  }
  return entry;
}

/** v1 の台本を、項目から組み立てる（形の検査を通す） */
function script(entries: readonly unknown[]): PlanScript {
  const parsed = parsePlanScript(
    JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "X", version: 1, entries: entries.map(withBasis) }),
  );
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

/** 台本の答える役で 1 回答え、結果と照合の記録を返す */
async function answerWith(
  plan: PlanScript,
  req: PlanAnswerRequest,
): Promise<{ readonly outcome: PlanAnswerOutcome; readonly matches: PlanScriptMatch[] }> {
  const matches: PlanScriptMatch[] = [];
  const responder = createScriptPlanResponder(plan, {
    match: (match) => matches.push(match),
    confirmation: () => {},
  });
  const outcome = await responder.answer(req);
  return { outcome, matches };
}

// ── 形の検査（工場の入口）────────────────────────────────

describe("台本の形の検査（04 §9・Issue #444）", () => {
  it("v1 の台本（観点・鍵・choose・recommended）を読む", () => {
    const parsed = parsePlanScript(
      JSON.stringify({
        schema: PLAN_SCRIPT_SCHEMA,
        subject: "A",
        version: 1,
        entries: [
          { id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["件数"] }, basis: "b" },
          { id: "E2", facet: null, keys: ["担当"], answer: { recommended: true }, basis: "b" },
        ],
      }),
    );
    expect("entries" in parsed).toBe(true);
    if ("entries" in parsed) expect(parsed.entries).toHaveLength(2);
  });

  it("形の不正は、位置だけの誤りの文で拒否する（値を埋めない）", () => {
    /** 台本の外側（`schema`・`subject`・`version`・`entries`）を、指定した値で組む */
    const envelope = (over: Record<string, unknown> = {}): string =>
      JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "T", version: 1, entries: [], ...over });
    /** 妥当な項目 1 つを、指定した値で上書きして組む */
    const entry = (over: Record<string, unknown> = {}): string =>
      envelope({
        entries: [{ id: "E", facet: null, keys: ["a"], answer: { recommended: true }, basis: "b", ...over }],
      });

    expect(parsePlanScript("ない")).toEqual({ error: "台本が JSON として読めません" });
    expect(parsePlanScript("[]")).toEqual({ error: "台本は写像（object）であること" });
    expect(parsePlanScript(envelope({ schema: "x" }))).toEqual({
      error: `台本の版（schema）が ${PLAN_SCRIPT_SCHEMA} ではありません`,
    });
    // subject・version の型・欠落
    expect(parsePlanScript(envelope({ subject: 1 }))).toEqual({ error: "台本の subject は空でない文字列であること" });
    expect(parsePlanScript(envelope({ subject: "" }))).toEqual({ error: "台本の subject は空でない文字列であること" });
    expect(parsePlanScript(envelope({ version: 1.5 }))).toEqual({ error: "台本の version は整数であること" });
    expect(parsePlanScript(envelope({ version: "1" }))).toEqual({ error: "台本の version は整数であること" });
    // entries の型
    expect(parsePlanScript(envelope({ entries: "x" }))).toEqual({
      error: "台本の項目（entries）は並び（array）であること",
    });
    // 項目の形
    expect(parsePlanScript(envelope({ entries: [1] }))).toEqual({ error: "entries[0]: 項目は写像（object）であること" });
    expect(parsePlanScript(entry({ id: "" }))).toEqual({ error: "entries[0].id: 識別子は空でない文字列であること" });
    // id の重複
    expect(
      parsePlanScript(
        envelope({
          entries: [
            { id: "E", facet: null, keys: ["a"], answer: { recommended: true }, basis: "b" },
            { id: "E", facet: null, keys: ["a"], answer: { recommended: true }, basis: "b" },
          ],
        }),
      ),
    ).toEqual({ error: "entries[1].id: 識別子が重複している" });
    // facet: 欠落・目録に無い観点
    expect(parsePlanScript(entry({ facet: undefined }))).toEqual({
      error: "entries[0].facet: 目録の観点 ID か null であること",
    });
    expect(parsePlanScript(entry({ facet: "unknown-facet" }))).toEqual({
      error: "entries[0].facet: 目録の観点 ID か null であること",
    });
    // keys: 型違い・0 件・正規表現でない・空文字
    expect(parsePlanScript(entry({ keys: "a" }))).toEqual({ error: "entries[0].keys: 正規表現の並び（1 件以上）であること" });
    expect(parsePlanScript(entry({ keys: [] }))).toEqual({ error: "entries[0].keys: 正規表現の並び（1 件以上）であること" });
    expect(parsePlanScript(entry({ keys: ["("] }))).toEqual({ error: "entries[0].keys[0]: 正規表現として読めません" });
    expect(parsePlanScript(entry({ keys: [1] }))).toEqual({ error: "entries[0].keys[0]: 空でない文字列であること" });
    // answer: どちらも無い・両方・recommended が真でない・choose が正規表現の並びでない
    expect(parsePlanScript(entry({ answer: {} }))).toEqual({
      error: "entries[0].answer: choose（選択肢の鍵の並び）か recommended（真）のちょうど一方を書くこと",
    });
    expect(parsePlanScript(entry({ answer: { choose: ["a"], recommended: true } }))).toEqual({
      error: "entries[0].answer: choose と recommended のちょうど一方を書くこと（両方は不可）",
    });
    expect(parsePlanScript(entry({ answer: { recommended: false } }))).toEqual({
      error: "entries[0].answer.recommended: 真であること",
    });
    expect(parsePlanScript(entry({ answer: { choose: [] } }))).toEqual({
      error: "entries[0].answer.choose: 正規表現の並び（1 件以上）であること",
    });
    // basis: 欠落・空
    expect(parsePlanScript(entry({ basis: undefined }))).toEqual({
      error: "entries[0].basis: 根拠は空でない文字列であること",
    });
    expect(parsePlanScript(entry({ basis: "" }))).toEqual({ error: "entries[0].basis: 根拠は空でない文字列であること" });
  });
});

// ── 当て方 v2 ───────────────────────────────────────────

describe("台本の答える役（当て方 v2。Issue #444・#893）", () => {
  it("台本の 1 件一致で、その選択肢を返す", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
    // 照合の記録は、コードが振った質問 ID・往復の版・状態・項目の添字と、値を持たない診断だけである
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "answered" }),
      },
    ]);
  });

  it("鍵は、事項の文と参照先の要件の文の両方に当たる", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["担当", "数え"], answer: { choose: ["全員"] } }]);
    const q = question();
    const main = issue({ text: "要件 R-1 について：何を数え、どう出すか", requirement: { id: "R-1", text: "担当している持ち物の数" } });
    const { outcome } = await answerWith(plan, request({ questions: [q], issues: [{ question: q, main, alsoCloses: [] }] }));

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
  });

  it("当たらない問いには答えない（不明）。all-recommended は返さない", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["該当しない語"], answer: { choose: ["全員"] } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      { questionId: "Q1-1", revision: 1, state: "unknown", entryIndex: null, diagnosis: diag() },
    ]);
  });

  it("2 件に当たる（重複）ときは答えない", async () => {
    const plan = script([
      { id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } },
      { id: "E2", facet: "aggregation", keys: ["数え", "タスク"], answer: { choose: ["自分の"] } },
    ]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "duplicate",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 2, v1State: "duplicate" }),
      },
    ]);
  });

  it("主の事項と一緒に閉じる事項が別の項目に当たるときは答えない（重複）", async () => {
    const plan = script([
      { id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } },
      { id: "E2", facet: "include-zero", keys: ["0 件"], answer: { choose: ["表示"] } },
    ]);
    const q = question({ openIssueId: "OI-1", alsoCloses: ["OI-2"] });
    const main = issue({ id: "OI-1", facetId: "aggregation", text: "何を数えるか" });
    const extra = issue({ id: "OI-2", facetId: "include-zero", text: "0 件も表示するか", requirement: null });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [extra] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "duplicate",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 2, v1State: "duplicate" }),
      },
    ]);
  });

  it("choose が選択肢 0 件にしか当たらないときは答えない（選択肢が決まらない）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["存在しない語"] } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "no-choice",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "no-choice" }),
      },
    ]);
  });

  it("choose が選択肢 2 件に当たるときは答えない（選択肢が決まらない）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["数える"] } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "no-choice",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "no-choice" }),
      },
    ]);
  });

  it("古い版の問いには答えない", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const { outcome, matches } = await answerWith(plan, request({ revision: 2 }));

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "stale-revision",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "stale-revision" }),
      },
    ]);
  });

  it("観点が null の事項には、事項の文だけで鍵が全部当たる観点つきの項目 1 件に答える（緩めた経路・v2）", async () => {
    // 事項 ID は目録の事項の形（`OI:catalog:…:aggregation`）だが、渡された観点は欠けた値（null）。
    // ID の字面で観点を補わない——緩めた経路は、渡された観点が null であることだけで決まる
    const stealth = issue({ id: "OI:catalog:R-1:aggregation", facetId: null, requirement: null });
    const q = question({ openIssueId: "OI:catalog:R-1:aggregation" });
    const withFacet = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const { outcome, matches } = await answerWith(
      withFacet,
      request({ questions: [q], issues: [{ question: q, main: stealth, alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, relaxed: true }),
      },
    ]);

    // 観点を求めない項目（facet: null）なら、今までどおり観点を照らさずに当たる
    const withoutFacet = script([{ id: "E1", facet: null, keys: ["数え"], answer: { choose: ["全員"] } }]);
    const ok = await answerWith(
      withoutFacet,
      request({ questions: [q], issues: [{ question: q, main: stealth, alsoCloses: [] }] }),
    );
    expect(ok.outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
    expect(ok.matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "answered" }),
      },
    ]);
  });

  it("束の一部にだけ答えてよい（残りは返さない）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const q1 = question({ id: "Q1-1", openIssueId: "OI-1" });
    const q2 = question({ id: "Q1-2", openIssueId: "OI-2" });
    const { outcome, matches } = await answerWith(
      plan,
      request({
        questions: [q1, q2],
        issues: [
          { question: q1, main: issue({ id: "OI-1", facetId: "aggregation" }), alsoCloses: [] },
          { question: q2, main: issue({ id: "OI-2", facetId: "include-zero", text: "0 件も出すか", requirement: null }), alsoCloses: [] },
        ],
      }),
    );

    expect(outcome.kind).toBe("answers");
    if (outcome.kind !== "answers") return;
    expect(outcome.answers.map((answer) => answer.questionId)).toEqual(["Q1-1"]);
    expect(matches.map((match) => match.state)).toEqual(["answered", "unknown"]);
  });

  it("recommended: true は推奨の選択肢を返す（台本に無いのとは区別する）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { recommended: true } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "answered" }),
      },
    ]);
  });

  it("recommended: true は、推奨が先頭でなくても推奨の選択肢を返す（最初の選択肢で代用しない）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { recommended: true } }]);
    const q = question({ recommended: { choiceId: "c2", reason: "r" } });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main: issue(), alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c2" }],
    });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "answered" }),
      },
    ]);
  });

  it("推奨が無い問いでは、recommended: true に答えない（no-choice）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { recommended: true } }]);
    // 推奨の欄を持たない問い
    const q: PlanQuestion = {
      id: "Q1-1",
      openIssueId: "OI-1",
      revision: 1,
      text: "どうしますか",
      choices: [
        { id: "c1", text: "全員分を数える" },
        { id: "c2", text: "自分の分だけ数える" },
      ],
      allowFreeText: true,
      alsoCloses: [],
    };
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main: issue(), alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "no-choice",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "no-choice" }),
      },
    ]);
  });

  it("推奨が問いの選択肢に無いときは、recommended: true に答えない（no-choice）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { recommended: true } }]);
    const q = question({ recommended: { choiceId: "cX", reason: "r" } });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main: issue(), alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "no-choice",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, v1State: "no-choice" }),
      },
    ]);
  });

  it("別の決めどころへの誤答の反例：要件の文だけが鍵を満たすなら答えない（requirement_text_needed）", async () => {
    // 事項の観点は null、台本の項目は観点つき。要件の文だけが鍵「数え」を満たす。選択肢の 1 つは
    // 台本の choose が指す語だが、要件の文を連結しないので当たらない（別の決めどころへの誤答を作らない）
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員分"] } }]);
    const q = question();
    const main = issue({
      facetId: null,
      text: "どのように記録するか",
      requirement: { id: "R-1", text: "タスクを数えられる" },
    });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "unknown",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 1, requirementTextNeeded: 1 }),
      },
    ]);
  });

  it("既知の観点どうしの不一致では答えない（facet_rejected_entries）", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const q = question();
    const main = issue({ facetId: "include-zero", text: "何を数えるか", requirement: null });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "unknown",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 1, facetRejectedEntries: 1 }),
      },
    ]);
  });

  it("観点が null の事項に別の 2 項目が当たるときは答えない（重複）", async () => {
    const plan = script([
      { id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } },
      { id: "E2", facet: "include-zero", keys: ["数え"], answer: { choose: ["自分の"] } },
    ]);
    const q = question();
    const main = issue({ facetId: null, text: "何を数えるか", requirement: null });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "duplicate",
        entryIndex: null,
        diagnosis: diag({ keysOnlyEntries: 2, relaxed: true }),
      },
    ]);
  });

  it("同じ項目が 2 つの事項に当たるのは 1 件に数える", async () => {
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え"], answer: { choose: ["全員"] } }]);
    const q = question({ alsoCloses: ["OI-2"] });
    const main = issue({ facetId: null, text: "数え方" });
    const extra = issue({ id: "OI-2", facetId: null, text: "数え方（もう一つ）", requirement: null });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [extra] }] }),
    );

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c1" }],
    });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "answered",
        entryIndex: 0,
        diagnosis: diag({ keysOnlyEntries: 1, relaxed: true }),
      },
    ]);
  });

  it("一方の事項の観点と別の事項の鍵を混ぜない（事項ごとに照合する）", async () => {
    // 鍵は主の事項の観点（aggregation）に合うが、主の事項の文には「丸め」が無い。一緒に閉じる事項には
    // 「丸め」があるが観点が違う。文を連結して当てる実装なら、ここで誤って当たる
    const plan = script([{ id: "E1", facet: "aggregation", keys: ["数え", "丸め"], answer: { choose: ["全員"] } }]);
    const q = question({ alsoCloses: ["OI-2"] });
    const main = issue({ facetId: "aggregation", text: "数え方", requirement: null });
    const extra = issue({ id: "OI-2", facetId: "include-zero", text: "丸め方", requirement: null });
    const { outcome, matches } = await answerWith(
      plan,
      request({ questions: [q], issues: [{ question: q, main, alsoCloses: [extra] }] }),
    );

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      {
        questionId: "Q1-1",
        revision: 1,
        state: "unknown",
        entryIndex: null,
        diagnosis: diag(),
      },
    ]);
  });

  it("鍵は問い・選択肢の文に当てない（選択肢の文にだけ鍵がある合成の入力で unknown）", async () => {
    // 鍵「自分の分だけ数える」は選択肢の文にだけある。問いの文にも事項の文にも無い
    const plan = script([{ id: "E1", facet: null, keys: ["自分の分だけ数える"], answer: { choose: ["全員"] } }]);
    const { outcome, matches } = await answerWith(plan, request());

    expect(outcome).toEqual({ kind: "answers", answers: [] });
    expect(matches).toEqual([
      { questionId: "Q1-1", revision: 1, state: "unknown", entryIndex: null, diagnosis: diag() },
    ]);
  });

  it("確認の画面の答えは build（答えのファイルの形と同じ）", async () => {
    const decisions: string[] = [];
    const responder = createScriptPlanResponder(script([]), {
      match: () => {},
      confirmation: (decision) => decisions.push(decision),
    });
    const decision = await responder.confirm({
      plan: {
        schema_version: "x",
        plan_id: "p",
        revision: 1,
        vocabulary_version: "v1",
        inputs: [],
        requirements: [],
        open_issues: [],
        decisions: [],
        accepted_unwritable: [],
      },
      diff: [],
      unwritable: [],
      closedByDefault: [],
    });
    expect(decision).toBe("build");
    expect(decisions).toEqual(["build"]);
  });
});
