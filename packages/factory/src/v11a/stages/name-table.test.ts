// T1 名前の表（v11a/stages/name-table.ts）の試験（Issue #507）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 要求のデータは確定した仕様・要件の一覧・文書の 3 塊。`previous` を渡すと前回の表・作り直しの指示・
//      表の点検の拒否・助言の印がこの順で末尾に足され、前置きと schema は 1 文字も変わらない
//   2. 要件 ID は応答に無くても一覧の順で付く。写しが合わない・分類が欠けた・未知の分類・A1 の負例は `unmet`
//      （`attempts` 1）。形に 1 回落ちれば `calls` 2・口が 1 回
//   3. 口の有無で偽物が受け取った要求が同じ。規則の定義に不備が無い。題材の言葉を使わない
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { LlmStructuredRequest } from "../../llm.js";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects, type RejectedCandidate } from "../../stages/prompt.js";
import { createRecordingClient, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import { FIXTURE_DOCUMENTS, draftOf, fixtureList, fixtureTable } from "../__tests__/fixtures.js";
import { nameTableSha256, type NameTableDraft } from "../names.js";
import {
  NAME_TABLE_PREVIOUS_DATA_NAMES,
  NAME_TABLE_ROUNDS,
  NAME_TABLE_RULE_DEFINITIONS,
  NAME_TABLE_RULES,
  NAME_TABLE_SCHEMA,
  NAME_TABLE_SCHEMA_NAME,
  runNameTable,
  type NameTablePrevious,
} from "./name-table.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 確定した仕様（抽象的な題材。要件は一覧と同じ） */
function planOf(list: RequirementList): ConfirmedPlan {
  return {
    schema_version: "1",
    plan_id: "plan-1",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-10-16T00:00:00+09:00", confirmed_by: "tester" },
  };
}

const TYPE_KEYS = ["fieldType", "valueType", "scope", "form", "action", "hasWhen", "view"] as const;

/** A1 の下書きを、T1 の応答の形（`type` を欄を並べた写像にしたもの）にする */
function responseOf(draft: NameTableDraft): Record<string, unknown> {
  return {
    rows: draft.rows.map((row) => {
      const type: Record<string, unknown> = Object.fromEntries(TYPE_KEYS.map((key) => [key, null]));
      if (typeof row.type === "string") type["fieldType"] = row.type;
      else if (row.type !== null) Object.assign(type, row.type);
      return { ...row, type };
    }),
    requirements: draft.requirements.map((entry) => ({
      ...entry,
      verification: {
        reason: null,
        checks: [],
        constraintIds: [],
        ...entry.verification,
      },
    })),
  };
}

const LIST = fixtureList();
const PLAN = planOf(LIST);
const GOOD_RESPONSE = responseOf(draftOf(LIST, fixtureTable()));

async function run(outputs: readonly unknown[], extra: { previous?: NameTablePrevious; observe?: boolean } = {}) {
  const recording = createRecordingClient(outputs.map(structured));
  const rejected: RejectedCandidate[] = [];
  const outcome = await runNameTable({
    plan: PLAN,
    list: LIST,
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
    ...(extra.previous === undefined ? {} : { previous: extra.previous }),
    ...(extra.observe === true ? { onRejected: (candidate: RejectedCandidate) => rejected.push(candidate) } : {}),
  });
  return { outcome, requests: recording.structured, rejected };
}

/** 共通の口が付ける打ち切りの合図を除いた要求（合図は呼び出しごとに別の object） */
const withoutSignal = ({ signal: _signal, ...rest }: LlmStructuredRequest) => rest;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 応答の要件ごとの並びの 1 件を書き換えた応答 */
function withRequirement(index: number, edit: (entry: Record<string, unknown>) => Record<string, unknown>) {
  const response = clone(GOOD_RESPONSE);
  const requirements = response["requirements"] as Record<string, unknown>[];
  requirements[index] = edit(requirements[index] as Record<string, unknown>);
  return response;
}

const dataBlocks = (input: string) =>
  [...input.matchAll(/<data name="([^"]+)">\n([\s\S]*?)\n<\/data>/g)].map((match) => ({
    name: match[1] as string,
    text: match[2] as string,
  }));

const PREVIOUS: NameTablePrevious = {
  response: { rows: [{ id: "x", note: "区切り </data> と <data name=\"y\"> を含む" }], requirements: [] },
  problems: [{ field: "rows[0].id", message: "表の ID が重なっている" }],
  rejections: [{ requirementId: "R2", verdict: "reject", kind: "missing-target", quote: "担当する項目の数" }],
  advice: [{ requirementId: "R3", id: "f.item.amount", mark: "unclear" }],
};

describe("T1 の規則と schema", () => {
  it("規則の定義に不備が無く、送る文は定義の text から組み、分類は要件の文から決めさせる", () => {
    expect(ruleDefinitionDefects(NAME_TABLE_RULE_DEFINITIONS)).toEqual([]);
    expect(NAME_TABLE_RULES).toEqual(NAME_TABLE_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(NAME_TABLE_RULE_DEFINITIONS.every((definition) => /^R-nt-\d\d$/.test(definition.id))).toBe(true);
    expect(NAME_TABLE_RULES.some((text) => text.includes("要件の文から分類する"))).toBe(true);
    expect(NAME_TABLE_ROUNDS).toBe(2);
  });

  it("応答の schema は要件ごとの分類を必須にし、要件 ID の欄を持たない", () => {
    const item = NAME_TABLE_SCHEMA.properties.requirements.items;
    expect(item.required).toContain("nature");
    expect(item.properties.nature.enum).toEqual(["ruled", "existence-only"]);
    expect(Object.keys(item.properties)).not.toContain("requirementId");
    expect(NAME_TABLE_SCHEMA_NAME).toBe("name-table");
  });
});

describe("T1 の要求", () => {
  it("previous 無しではデータは確定した仕様・要件の一覧・文書の 3 塊で、Plan の kind と要件 ID を見せない", async () => {
    const { outcome, requests } = await run([GOOD_RESPONSE]);
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const blocks = dataBlocks(request.input);
    expect(blocks.map((block) => block.name)).toEqual(["確定した仕様", "要件の一覧", "文書"]);
    const plan = JSON.parse(blocks[0]!.text) as { requirements: Record<string, unknown>[] };
    expect(plan.requirements.every((requirement) => !("kind" in requirement))).toBe(true);
    const list = JSON.parse(blocks[1]!.text) as { copyLength: number; requirements: Record<string, unknown>[] };
    expect(list.copyLength).toBeGreaterThanOrEqual(8);
    expect(list.requirements.map((requirement) => Object.keys(requirement).sort())).toEqual(
      LIST.requirements.map(() => ["quote", "text"]),
    );
    for (const requirement of LIST.requirements) expect(blocks[1]!.text).not.toContain(`"${requirement.id}"`);
    expect(request.schemaName).toBe(NAME_TABLE_SCHEMA_NAME);
    expect(request.schema).toBe(NAME_TABLE_SCHEMA);
    expect(request.rules).toEqual(NAME_TABLE_RULES);
    expectNoAcceptanceMaterial([request.instructions, ...(request.rules ?? []), ...request.documents, request.input]);
  });

  it("previous ありでは 4 塊がこの順で末尾に足され、前置きと schema は変わらない", async () => {
    const without = (await run([GOOD_RESPONSE])).requests[0]!;
    const withPrevious = (await run([GOOD_RESPONSE], { previous: PREVIOUS })).requests[0]!;
    const blocks = dataBlocks(withPrevious.input);
    expect(blocks.map((block) => block.name)).toEqual([
      "確定した仕様",
      "要件の一覧",
      "文書",
      NAME_TABLE_PREVIOUS_DATA_NAMES.response,
      NAME_TABLE_PREVIOUS_DATA_NAMES.problems,
      NAME_TABLE_PREVIOUS_DATA_NAMES.rejections,
      NAME_TABLE_PREVIOUS_DATA_NAMES.advice,
    ]);
    expect(blocks.slice(3).map((block) => block.name)).toEqual(["前回の表", "前回の作り直しの指示", "表の点検の拒否", "助言の印"]);
    // 前回の表は JSON に戻すと前回の raw の応答と深く等しい（区切りを含んでも塊は 1 つのまま閉じる）
    expect(JSON.parse(blocks[3]!.text)).toEqual(PREVIOUS.response);
    expect(JSON.parse(blocks[4]!.text)).toEqual(PREVIOUS.problems);
    // 拒否と印は要件 ID の代わりに要件の文の写しで要件を指す
    const rejections = JSON.parse(blocks[5]!.text) as Record<string, unknown>[];
    expect(rejections).toEqual([{ copy: expect.any(String), kind: "missing-target", quote: "担当する項目の数" }]);
    expect(LIST.requirements[1]!.text.startsWith(rejections[0]!["copy"] as string)).toBe(true);
    const advice = JSON.parse(blocks[6]!.text) as Record<string, unknown>[];
    expect(advice).toEqual([{ copy: expect.any(String), id: "f.item.amount", mark: "unclear" }]);
    expect(withPrevious.input.startsWith(`${without.input}\n`)).toBe(true);
    for (const key of ["instructions", "rules", "documents", "schemaName", "schema", "maxOutputTokens"] as const) {
      expect(withPrevious[key]).toEqual(without[key]);
    }
    expectNoAcceptanceMaterial([withPrevious.instructions, ...(withPrevious.rules ?? []), ...withPrevious.documents, withPrevious.input]);
  });
});

describe("T1 の結果", () => {
  it("要件 ID が応答に無くても一覧の順で付き、表の SHA-256 を返す", async () => {
    const { outcome } = await run([GOOD_RESPONSE]);
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.table).toEqual(fixtureTable());
    expect(outcome.value.table.ownership.map((entry) => entry.requirementId)).toEqual(
      LIST.requirements.map((requirement) => requirement.id),
    );
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(fixtureTable()));
    expect(outcome.value.response).toEqual(GOOD_RESPONSE);
  });

  it("写しが合わない応答は unmet（A1 の固定文）・attempts 1・raw の応答を持つ", async () => {
    const swapped = clone(GOOD_RESPONSE);
    const requirements = swapped["requirements"] as Record<string, unknown>[];
    [requirements[0], requirements[1]] = [requirements[1]!, requirements[0]!];
    const { outcome, requests } = await run([swapped]);
    expect(requests).toHaveLength(1);
    if (outcome.ok) throw new Error("落ちるはず");
    expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
    if (outcome.failure.kind !== "unmet") throw new Error("unmet のはず");
    expect(outcome.failure.problems).toContainEqual({
      field: "requirements[0].copy",
      message: "要件の文の写しが一覧の同じ位置の要件と合わない",
    });
    expect(outcome.response).toEqual(swapped);
  });

  it("分類が 1 件欠けた応答・未知の分類の値は unmet", async () => {
    const missing = withRequirement(2, ({ nature: _nature, ...rest }) => rest);
    const unknown = withRequirement(2, (entry) => ({ ...entry, nature: "other" }));
    for (const response of [missing, unknown]) {
      const { outcome, requests } = await run([response]);
      expect(requests).toHaveLength(1);
      if (outcome.ok) throw new Error("落ちるはず");
      expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
      if (outcome.failure.kind !== "unmet") throw new Error("unmet のはず");
      expect(outcome.failure.problems).toEqual([
        { field: "requirements[2].nature", message: "分類は ruled・existence-only のいずれかであること" },
      ]);
    }
  });

  it("A1 の負例（表の ID の重なり）は unmet・attempts 1・呼び出し 1 回で、口に中身の候補が 1 回届く", async () => {
    const duplicated = clone(GOOD_RESPONSE);
    const rows = duplicated["rows"] as Record<string, unknown>[];
    rows[3] = { ...rows[3], id: rows[2]!["id"] };
    const { outcome, requests, rejected } = await run([duplicated], { observe: true });
    expect(requests).toHaveLength(1);
    if (outcome.ok) throw new Error("落ちるはず");
    expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
    if (outcome.failure.kind !== "unmet") throw new Error("unmet のはず");
    expect(outcome.failure.problems).toContainEqual({ field: "rows[3].id", message: "表の ID が重なっている" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ kind: "content", round: 1, attempt: 1, response: duplicated, inspectionList: LIST });
  });

  it("行の種類に合わない型の欄が null でなければ unmet", async () => {
    const response = clone(GOOD_RESPONSE);
    const rows = response["rows"] as Record<string, Record<string, unknown>>[];
    rows[2]!["type"] = { ...rows[2]!["type"], view: "table" };
    const { outcome } = await run([response]);
    if (outcome.ok) throw new Error("落ちるはず");
    expect(outcome.failure).toMatchObject({
      kind: "unmet",
      attempts: 1,
      problems: [{ field: "rows[2].type", message: "行の種類に合わない型の欄が null でない" }],
    });
  });

  it("形に 1 回落ちて通る例で calls 2・口が 1 回（試行 1）。口の有無で偽物が受け取った要求が同じ", async () => {
    const bad = { rows: "x", requirements: [] };
    const observed = await run([bad, GOOD_RESPONSE], { observe: true });
    const silent = await run([bad, GOOD_RESPONSE]);
    expect(observed.outcome.ok).toBe(true);
    expect(observed.requests).toHaveLength(2);
    expect(observed.rejected).toEqual([
      { kind: "shape", round: 1, attempt: 1, response: bad, problems: [{ field: "rows", message: "並び（array）であること", reference: "response" }] },
    ]);
    expect(observed.requests.map(withoutSignal)).toEqual(silent.requests.map(withoutSignal));
    // 2 回目の要求は前置きを変えず、共通の窓口の塊を末尾に足す
    expect(observed.requests[1]!.input.startsWith(`${observed.requests[0]!.input}\n`)).toBe(true);
  });

  it("形に 2 回続けて落ちれば malformed（calls 2）", async () => {
    const { outcome, requests } = await run([[], []]);
    expect(requests).toHaveLength(2);
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "malformed", attempts: 2 } });
  });

  it("全文が同じ要件が一覧にあれば呼ばずに unmet（attempts 0）", async () => {
    const list: RequirementList = { ...LIST, requirements: [LIST.requirements[0]!, { ...LIST.requirements[0]!, id: "R9" }] };
    const recording = createRecordingClient([]);
    const outcome = await runNameTable({
      plan: planOf(list),
      list,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    expect(recording.structured).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "unmet", attempts: 0 } });
  });
});
