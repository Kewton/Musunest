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
import type { LlmClient, LlmStructuredRequest } from "../../llm.js";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects, type RejectedCandidate } from "../../stages/prompt.js";
import { createRecordingClient, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  draftOf,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureList,
  fixtureListWithRequestQuotes,
  fixtureTable,
} from "../__tests__/fixtures.js";
import { copyLengthFor, nameTableSha256, requirementCopy, type NameTableDraft } from "../names.js";
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
    // 写しの長さ（copyLength）は渡さず、コードが切った要件ごとの写しを渡す（#505・#507）
    const list = JSON.parse(blocks[1]!.text) as { requirements: Record<string, unknown>[] };
    expect(Object.keys(list)).toEqual(["requirements"]);
    expect(list.requirements.map((requirement) => Object.keys(requirement).sort())).toEqual(
      LIST.requirements.map(() => ["copy", "requestQuote", "text"]),
    );
    const length = copyLengthFor(LIST)!;
    expect(length).toBeGreaterThanOrEqual(8);
    expect(list.requirements.map((requirement) => requirement["copy"])).toEqual(
      LIST.requirements.map((requirement) => requirementCopy(requirement.text, length)),
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

// ── 観測と同じ形の応答（#505・#507）──────────────────────────────────────
//
// v1.1α の比較で、T1 のモデルは写しの文字数を数えられず要件の文の全文を写し、要件の一覧の引用（依頼文から
// の引用）を行の出典の引用に写した。ここでは**数えずに、データにある文字列をそのまま写す**偽物で、その形を
// 作る：一覧に要件ごとの写し（copy）があればそれを写し、無ければ全文を写す。出典の引用は一覧の依頼文の
// 引用（requestQuote。無ければ quote）か、要件の文の部分文字列（fixture の表の引用）を写す。

const QUOTED = fixtureListWithRequestQuotes();
const QUOTED_PLAN = planOf(QUOTED);

/** 要求の「要件の一覧」から、要件ごとに写す文字列（写しが無ければ全文）と依頼文の引用を読む */
function listedOf(request: LlmStructuredRequest): { readonly copies: string[]; readonly quotes: string[] } {
  const block = dataBlocks(request.input).find((candidate) => candidate.name === "要件の一覧");
  if (block === undefined) throw new Error("要件の一覧が無い");
  const parsed = JSON.parse(block.text) as { requirements: Record<string, unknown>[] };
  return {
    copies: parsed.requirements.map((entry) => (typeof entry["copy"] === "string" ? entry["copy"] : (entry["text"] as string))),
    quotes: parsed.requirements.map((entry) => (entry["requestQuote"] ?? entry["quote"]) as string),
  };
}

/** 数えずに写す偽物の LLM（要求ごとに応答を作る） */
function copyingClient(quoteFrom: "requirement-text" | "request-quote") {
  const structured: LlmStructuredRequest[] = [];
  const ids = QUOTED.requirements.map((requirement) => requirement.id);
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest) {
      structured.push(request);
      const { copies, quotes } = listedOf(request);
      const response = clone(responseOf(draftOf(QUOTED, fixtureTable())));
      const rows = response["rows"] as Record<string, Record<string, unknown>>[];
      fixtureTable().rows.forEach((row, index) => {
        const at = ids.indexOf(row.source.requirementId);
        rows[index]!["source"] = {
          copy: copies[at],
          quote: quoteFrom === "request-quote" ? quotes[at] : row.source.quote,
        };
      });
      (response["requirements"] as Record<string, unknown>[]).forEach((entry, index) => {
        entry["copy"] = copies[index];
      });
      return { output: response as T, usage: undefined };
    },
    async callWithTools() {
      throw new Error("道具は使わない");
    },
  };
  return { client, structured };
}

async function runQuoted(client: LlmClient) {
  return runNameTable({ plan: QUOTED_PLAN, list: QUOTED, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(client) });
}

describe("T1 は要件ごとの写しをコードが渡し、依頼文の引用も出典として受ける（#505・#507）", () => {
  it("要件の一覧の写しは、コードが一意な長さで切った要件の文の先頭で、写しの長さの指示は無い", async () => {
    const { client, structured } = copyingClient("requirement-text");
    await runQuoted(client);
    const block = dataBlocks(structured[0]!.input).find((candidate) => candidate.name === "要件の一覧")!;
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["requirements"]);
    const length = copyLengthFor(QUOTED)!;
    expect(parsed["requirements"]).toEqual(
      QUOTED.requirements.map((requirement) => ({
        copy: requirementCopy(requirement.text, length),
        text: requirement.text,
        requestQuote: requirement.quote,
      })),
    );
    expect(NAME_TABLE_RULES.some((text) => text.includes("copyLength"))).toBe(false);
  });

  it("数えずに写す応答（要件の文の部分文字列を引用）は通る", async () => {
    const { client, structured } = copyingClient("requirement-text");
    const outcome = await runQuoted(client);
    expect(structured).toHaveLength(1);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
    expect(outcome.value.table).toEqual(fixtureTable());
  });

  it("数えずに写し、一覧の依頼文の引用を出典の引用に写した応答は通り、出典はその要件に結ぶ", async () => {
    const { client, structured } = copyingClient("request-quote");
    const outcome = await runQuoted(client);
    expect(structured).toHaveLength(1);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
    const quoteOf = new Map(QUOTED.requirements.map((requirement) => [requirement.id, requirement.quote] as const));
    expect(outcome.value.table.rows.map((row) => row.source)).toEqual(
      fixtureTable().rows.map((row) => ({
        requirementId: row.source.requirementId,
        quote: quoteOf.get(row.source.requirementId),
      })),
    );
  });

  it("負例：一覧の写しがあっても全文を写した応答は unmet（写しは今までどおり完全一致）", async () => {
    const response = clone(responseOf(draftOf(QUOTED, fixtureTable())));
    (response["requirements"] as Record<string, unknown>[]).forEach((entry, index) => {
      entry["copy"] = QUOTED.requirements[index]!.text;
    });
    const recording = createRecordingClient([structured(response)]);
    const outcome = await runQuoted(recording.client);
    if (outcome.ok) throw new Error("落ちるはず");
    expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
    if (outcome.failure.kind !== "unmet") throw new Error("unmet のはず");
    expect(outcome.failure.problems).toContainEqual({
      field: "requirements[0].copy",
      message: "要件の文の写しが指示した長さと合わない",
    });
  });

  it("負例：別の要件の依頼文の引用・言い換えた引用は unmet", async () => {
    const at = fixtureTable().rows.findIndex((row) => row.id === "f.item.owner");
    const own = QUOTED.requirements[0]!.quote;
    for (const quote of [QUOTED.requirements[1]!.quote, own.replace("登録", "記録")]) {
      const response = clone(responseOf(draftOf(QUOTED, fixtureTable())));
      const rows = response["rows"] as Record<string, Record<string, unknown>>[];
      rows[at]!["source"] = { ...rows[at]!["source"], quote };
      const recording = createRecordingClient([structured(response)]);
      const outcome = await runQuoted(recording.client);
      if (outcome.ok) throw new Error("落ちるはず");
      expect(outcome.failure).toMatchObject({
        kind: "unmet",
        attempts: 1,
        problems: [{ field: `rows[${at}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" }],
      });
    }
  });

  it("負例：要件ごとの並びの入れ替えは、写しをコードが渡しても unmet", async () => {
    const response = clone(responseOf(draftOf(QUOTED, fixtureTable())));
    const requirements = response["requirements"] as Record<string, unknown>[];
    [requirements[0], requirements[1]] = [requirements[1]!, requirements[0]!];
    const outcome = await runQuoted(createRecordingClient([structured(response)]).client);
    if (outcome.ok) throw new Error("落ちるはず");
    if (outcome.failure.kind !== "unmet") throw new Error("unmet のはず");
    expect(outcome.failure.problems).toContainEqual({
      field: "requirements[0].copy",
      message: "要件の文の写しが一覧の同じ位置の要件と合わない",
    });
  });
});

describe("T1 の確かめ方 default-value（Issue #533）", () => {
  it("schema の kind に default-value があり、value は string か null の必須の欄", () => {
    const verification = NAME_TABLE_SCHEMA.properties.requirements.items.properties.verification;
    expect(verification.properties.kind.enum).toEqual(["fixed-test", "structural", "unresolved", "default-value"]);
    expect(verification.properties.value.type).toEqual(["string", "null"]);
    expect(verification.required).toContain("value");
    expect(verification.additionalProperties).toBe(false);
    // 平らな形のまま（種類ごとの枝分けをしない）
    expect(Object.keys(verification.properties)).toEqual(["kind", "reason", "checks", "constraintIds", "value"]);
  });

  it("規則 R-nt-08 に既定値の 1 文があり、why・since が埋まっている", () => {
    const rule = NAME_TABLE_RULE_DEFINITIONS.find((definition) => definition.id === "R-nt-08");
    expect(rule?.text).toContain("kind を default-value にし、value にそのキー");
    expect(rule?.text).toContain("その項目だけを所属させる");
    expect(rule?.text).toContain("条件・計算・検査・操作後の状態を含む要件には default-value を使わない");
    expect(rule?.since).toContain("#533");
    expect(rule?.why).toContain("H2");
    expect(ruleDefinitionDefects(NAME_TABLE_RULE_DEFINITIONS)).toEqual([]);
    expectNoAcceptanceMaterial(NAME_TABLE_RULES);
  });

  it("strict の形の応答（ほかの種類は value null）で、default-value の要件の value が表に残る", async () => {
    const list = fixtureDefaultValueList();
    const response = responseOf(draftOf(list, fixtureDefaultValueTable()));
    for (const entry of response["requirements"] as { verification: Record<string, unknown> }[]) {
      entry.verification = { value: null, ...entry.verification };
    }
    const recording = createRecordingClient([structured(response)]);
    const outcome = await runNameTable({
      plan: planOf(list),
      list,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    if (!outcome.ok) throw new Error("通るはず");
    expect(outcome.value.table).toEqual(fixtureDefaultValueTable());
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(fixtureDefaultValueTable()));
  });

  it("負例：options の外の value は T1' で unmet（固定文）", async () => {
    const list = fixtureDefaultValueList();
    const recording = createRecordingClient([structured(responseOf(draftOf(list, fixtureDefaultValueTable("gamma"))))]);
    const outcome = await runNameTable({
      plan: planOf(list),
      list,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toEqual([
      { field: "verification[5].value", message: "既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い" },
    ]);
  });
});
