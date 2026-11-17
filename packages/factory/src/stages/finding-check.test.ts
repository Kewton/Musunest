// 指摘の確かめ（stages/finding-check.ts）の試験（Issue #967）。
//
// 固定するもの：規則 R-rfc-01〜05 の文・why・since・modes／要求に入るデータは原文・一覧・指摘の範囲と
// 含む文だけで、P2 の出力の種類・対象 ID・説明、ほかの指摘、コードの落ち、文書が入らない／同じ指摘の
// 3 回の要求が byte で同じ／carried の ID の確かめ。
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../pipeline.js";
import { ruleDefinitionDefects } from "./prompt.js";
import {
  FINDING_CHECK_RULE_DEFINITIONS,
  FINDING_CHECK_SCHEMA,
  FINDING_CHECK_SCHEMA_NAME,
  checkFindingCheckOutput,
  findingCheckRules,
  normalizeFindingCheckVerdict,
  runFindingCheck,
} from "./finding-check.js";
import { createRecordingClient, makeGateway } from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

const SOURCE = "MARK_Aを記録する。MARK_Bを合計する。MARK_Cを印字する。";
const span = (quote: string): { readonly start: number; readonly end: number } => {
  const start = SOURCE.indexOf(quote);
  return { start, end: start + quote.length };
};
const LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "MARK_Aを記録できる", quote: "MARK_Aを記録する。", position: span("MARK_Aを記録する。") },
    { id: "R-2", text: "MARK_Bを合計できる", quote: "MARK_Bを合計する。", position: span("MARK_Bを合計する。") },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};

describe("確かめ役の規則（Issue #967）", () => {
  it("R-rfc-01〜05 の定義に why・since・modes があり、ruleDefinitionDefects が空である", () => {
    expect(FINDING_CHECK_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "R-rfc-01",
      "R-rfc-02",
      "R-rfc-03",
      "R-rfc-04",
      "R-rfc-05",
    ]);
    expect(ruleDefinitionDefects(FINDING_CHECK_RULE_DEFINITIONS)).toEqual([]);
    for (const definition of FINDING_CHECK_RULE_DEFINITIONS) {
      expect(definition.since).toBe("Issue #967");
      expect(definition.modes).toEqual(["M-21"]);
    }
  });

  it("規則の文は、Issue 本文の全文と byte で同じ", () => {
    expect(findingCheckRules()).toEqual([
      "指摘された断片だけでなく、それを含む文の中での働きで決める。",
      "断片が運ぶ内容が、一覧のどれかの要件の本文に表されていれば（言い換えでもよい）、carried とする。引用は出典の目印にすぎず、本文に表されているかで決める。断片の修飾が文の中の複数の項目に掛かるときは、項目ごとに確かめ、掛かる項目のどれか 1 つの要件の本文にでも表されていなければ carried としない。",
      "利用者の事情・理由・背景・評価・感想・つなぎ・挨拶の語で、作るものの動作・対象・条件・制約を加えないものは、not-a-condition とする。",
      "断片が、作るものの動作・対象・時点・期限・数量・否定・例外・適用の範囲・指定の文言のいずれかを運び、それがどの要件の本文にも表されていなければ、missing とする。",
      "迷うときは missing とする。",
    ]);
  });
});

describe("確かめ役の要求（Issue #967）", () => {
  it("原文・その往復の一覧・指摘の範囲と含む文だけをデータに置き、文書を渡さない", async () => {
    const recording = createRecordingClient([structured({ verdict: "carried", requirement_ids: ["R-1"], reason: "表されている" })]);
    const range = span("MARK_Aを記録する。");
    const outcome = await runFindingCheck({
      source: SOURCE,
      list: LIST,
      range,
      sentences: ["MARK_Aを記録する。"],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.schemaName).toBe(FINDING_CHECK_SCHEMA_NAME);
    // 文書（契約など）は渡さない
    expect(request?.documents).toEqual([]);
    // 原文・要件の id・本文・引用・枠の引用・指摘の断片と範囲・含む文が入る
    expect(request?.input).toContain(SOURCE);
    expect(request?.input).toContain('"id": "R-1"');
    expect(request?.input).toContain('"text": "MARK_Aを記録できる"');
    expect(request?.input).toContain('"quote": "MARK_Aを記録する。"');
    expect(request?.input).toContain('"text": "MARK_Aを記録する。"');
    expect(request?.input).toContain(`"start": ${range.start}`);
    expect(request?.input).toContain(`"end": ${range.end}`);
    expect(request?.input).toContain('"sentences"');
    // P2 の出力の種類・対象 ID・説明、ほかの指摘、コードの落ちは入らない
    expect(request?.input).not.toContain("findingDetails");
    expect(request?.input).not.toContain("missingKind");
    expect(request?.input).not.toContain("MARK_OTHER_FINDING");
    expect(request?.input).not.toContain("MARK_CODE_MISS");
    // schema は strict（追加の欄を許さない）
    expect(FINDING_CHECK_SCHEMA).toMatchObject({ type: "object", additionalProperties: false });
    expect(FINDING_CHECK_SCHEMA.required).toEqual(["verdict", "requirement_ids", "reason"]);
  });

  it("同じ指摘の 3 回の要求は byte で同じ", async () => {
    const answer = { verdict: "carried", requirement_ids: ["R-1"], reason: "表されている" };
    const recording = createRecordingClient([structured(answer), structured(answer), structured(answer)]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    for (let round = 0; round < 3; round += 1) {
      const outcome = await runFindingCheck({
        source: SOURCE,
        list: LIST,
        range: span("MARK_Aを記録する。"),
        sentences: ["MARK_Aを記録する。"],
        gateway,
      });
      expect(outcome.ok).toBe(true);
    }
    expect(recording.structured).toHaveLength(3);
    const first = JSON.stringify(recording.structured[0]);
    for (const request of recording.structured) expect(JSON.stringify(request)).toBe(first);
  });

  it("複数の文にまたがる指摘では、またがる文をすべて渡す", async () => {
    const recording = createRecordingClient([structured({ verdict: "missing", requirement_ids: [], reason: "無い" })]);
    await runFindingCheck({
      source: SOURCE,
      list: LIST,
      range: { start: 0, end: span("MARK_Bを合計する。").end },
      sentences: ["MARK_Aを記録する。", "MARK_Bを合計する。"],
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(recording.structured[0]?.input).toContain('"sentences": [');
    expect(recording.structured[0]?.input).toContain("MARK_Aを記録する。");
    expect(recording.structured[0]?.input).toContain("MARK_Bを合計する。");
  });
});

describe("確かめ役の答えの形と ID の確かめ（Issue #967）", () => {
  it("形: 3 つの判定だけを受け、欄の型違いは形の誤りにする", () => {
    expect(checkFindingCheckOutput({ verdict: "carried", requirement_ids: ["R-1"], reason: "x" })).toMatchObject({
      ok: true,
      value: { verdict: "carried", requirementIds: ["R-1"], reason: "x" },
    });
    expect(checkFindingCheckOutput({ verdict: "other", requirement_ids: [], reason: "x" }).ok).toBe(false);
    expect(checkFindingCheckOutput({ verdict: "missing", requirement_ids: "R-1", reason: "x" }).ok).toBe(false);
    expect(checkFindingCheckOutput({ verdict: "missing", requirement_ids: [], reason: 1 }).ok).toBe(false);
    expect(checkFindingCheckOutput({}).ok).toBe(false);
  });

  it("ID の確かめ: carried で ID が空か一覧に無い回は missing と数える", () => {
    expect(normalizeFindingCheckVerdict(LIST, { verdict: "carried", requirementIds: [], reason: "x" })).toBe("missing");
    expect(
      normalizeFindingCheckVerdict(LIST, { verdict: "carried", requirementIds: ["R-9"], reason: "x" }),
    ).toBe("missing");
    expect(
      normalizeFindingCheckVerdict(LIST, { verdict: "carried", requirementIds: ["R-1"], reason: "x" }),
    ).toBe("carried");
    expect(
      normalizeFindingCheckVerdict(LIST, { verdict: "not-a-condition", requirementIds: [], reason: "x" }),
    ).toBe("not-a-condition");
    expect(normalizeFindingCheckVerdict(LIST, { verdict: "missing", requirementIds: [], reason: "x" })).toBe("missing");
  });
});
