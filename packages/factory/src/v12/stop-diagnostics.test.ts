// C2・C3 の形の拒否の診断（v12/stop-diagnostics.ts）の試験（Issue #898）。偽物の LLM で閉じる（外部の API を呼ばない）。
//
// 固定したいこと：
//   1. 記録は既定のキーと固定の分類だけから組み、要件・依頼・応答・未知の ID・余分な欄・任意の問題文の sentinel を
//      1 つも写さない（直列化した本文で照らす）
//   2. 許可した ID・数値・分類・SHA だけが残る（キーの集合を固定する。許可外の欄をコピーする実装なら赤になる）
//   3. 診断の口の有無・例外で、送る要求・試行・予算・結果が変わらない（固定の偽物と時計で前後比較する）
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../pipeline.js";
import { serializeJson, type Problem } from "../stages/prompt.js";
import { makeGateway } from "../stages/__tests__/prompt.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse } from "../llm.js";
import {
  FIXTURE_DOCUMENTS,
  createCheckedRecordingClient,
  fixtureList,
  fixtureTable,
  idsResponsesOf,
  planOf as fixturePlanOf,
  recordedStructured,
  withCodeIds,
} from "../v11a/__tests__/fixtures.js";
import { runSemanticCheck, type SemanticCheckInput } from "../v11a/stages/semantic-check.js";
import { runMapping } from "./stages/mapping.js";
import {
  C2_PROBLEM_CLASSES,
  C2_PHASES,
  C3_PROBLEM_CLASSES,
  C3_STATUSES,
  STOP_DIAGNOSTICS_FILE,
  buildStopDiagnosticsFile,
  c2StopDiagnostic,
  serializeStopDiagnostics,
  type C2StopDiagnostic,
  type C3StopDiagnostic,
  type StopDiagnostic,
} from "./stop-diagnostics.js";

const SENTINEL = "SENTINEL_8a1b";
const REQ_SENTINEL = `要件本文_${SENTINEL}`;
const UNKNOWN_ID_SENTINEL = `UNKNOWN_ID_${SENTINEL}`;
const QUOTE_SENTINEL = `引用_${SENTINEL}`;
const EXTRA_KEY_SENTINEL = `EXTRA_KEY_${SENTINEL}`;
const PROBLEM_FIELD_SENTINEL = `問題の欄_${SENTINEL}`;
const PROBLEM_MESSAGE_SENTINEL = `問題の文_${SENTINEL}`;

const LIST: RequirementList = {
  requirements: [{ id: "R1", text: REQ_SENTINEL, quote: REQ_SENTINEL, position: { start: 0, end: REQ_SENTINEL.length } }],
  decisions: [],
  unresolved: [],
};
const PLAN: ConfirmedPlan = fixturePlanOf(LIST);

/** 診断を集める口（記録は呼び出し側で複製しない——診断は本文を持たない） */
function sink() {
  const records: StopDiagnostic[] = [];
  return { records, onStopDiagnostic: (record: StopDiagnostic) => records.push(record) };
}

function sentinelClient(output: unknown) {
  const requests: LlmStructuredRequest[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
      requests.push(request);
      return { output: output as T, usage: undefined };
    },
    async callWithTools() {
      throw new Error("道具の呼び出しは無い");
    },
  };
  return { client, requests };
}

const c3Input = (gateway: SemanticCheckInput["gateway"], extra: Partial<SemanticCheckInput> = {}): SemanticCheckInput => ({
  plan: PLAN,
  list: LIST,
  table: { ...fixtureTable(), rows: fixtureTable().rows, ownership: [{ requirementId: "R1", roles: [] }] },
  documents: FIXTURE_DOCUMENTS,
  gateway,
  ids: true,
  ...extra,
});

const ALLOWED_C2 = ["kind", "round", "phase", "attempt", "problems"];
const ALLOWED_C2_PROBLEM = ["class", "row_index", "ownership_index", "role_index"];
const ALLOWED_C3 = [
  "kind",
  "round",
  "bundle_index",
  "attempt",
  "targets",
  "missing",
  "problems",
  "response_sha256",
  "observed",
  "status",
];

describe("診断の記録は本文を写さない（Issue #898。H4-diagnostic-no-body）", () => {
  it("C3：応答の未知の ID・余分な欄・引用の sentinel は直列化に残らず、許可した ID・数値・分類・SHA だけが残る", async () => {
    const output = {
      judgments: [
        { requirementId: "R1", verdict: "reject", kind: "missing-target", quote: QUOTE_SENTINEL },
        { requirementId: UNKNOWN_ID_SENTINEL, verdict: "accept", kind: null, quote: null },
      ],
      [EXTRA_KEY_SENTINEL]: "余分な欄",
    };
    const { client } = sentinelClient(output);
    const collected = sink();
    const outcome = await runSemanticCheck(c3Input(makeGateway(client), { onStopDiagnostic: collected.onStopDiagnostic }));
    expect(outcome.ok).toBe(false);
    expect(collected.records.length).toBeGreaterThan(0);
    expect(collected.records.every((record) => record.kind === "c3")).toBe(true);
    const text = serializeStopDiagnostics(collected.records);
    for (const sentinel of [SENTINEL, REQ_SENTINEL, UNKNOWN_ID_SENTINEL, QUOTE_SENTINEL, EXTRA_KEY_SENTINEL]) {
      expect(text, sentinel).not.toContain(sentinel);
    }
    const parsed = JSON.parse(text) as { records: C3StopDiagnostic[] };
    for (const record of parsed.records) {
      expect(Object.keys(record).sort()).toEqual([...ALLOWED_C3].sort());
      expect(record.targets.every((id) => id === "R1")).toBe(true);
      expect(record.missing.every((id) => id === "R1")).toBe(true);
      expect(record.problems.every((classification) => C3_PROBLEM_CLASSES.includes(classification))).toBe(true);
      expect(C3_STATUSES).toContain(record.status);
      expect(typeof record.round).toBe("number");
      expect(typeof record.bundle_index).toBe("number");
      expect(typeof record.attempt).toBe("number");
      expect(typeof record.observed).toBe("boolean");
      if (record.response_sha256 !== null) expect(record.response_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // SHA は本文ではなく、形の検査に渡した output の直列化の SHA-256
    const [first] = parsed.records;
    expect(first?.response_sha256).toBe(await sha256Hex(serializeJson(output)));
  });

  it("C2：問題の field・message の sentinel は写さず、分類・位置・数値だけを残す", () => {
    const problems: readonly Problem[] = [
      { field: PROBLEM_FIELD_SENTINEL, message: PROBLEM_MESSAGE_SENTINEL },
      { field: PROBLEM_FIELD_SENTINEL, message: PROBLEM_MESSAGE_SENTINEL },
    ];
    const record = c2StopDiagnostic({
      round: 1,
      phase: "merged",
      attempt: null,
      problems,
      classifications: ["unknown-ownership-id", "unowned-row"],
      positions: [
        { row_index: null, ownership_index: 0, role_index: 2 },
        { row_index: 3, ownership_index: null, role_index: null },
      ],
    });
    const text = serializeStopDiagnostics([record]);
    for (const sentinel of [SENTINEL, PROBLEM_FIELD_SENTINEL, PROBLEM_MESSAGE_SENTINEL, UNKNOWN_ID_SENTINEL]) {
      expect(text, sentinel).not.toContain(sentinel);
    }
    const parsed = JSON.parse(text) as { records: C2StopDiagnostic[] };
    expect(parsed.records).toHaveLength(1);
    const [only] = parsed.records;
    expect(Object.keys(only!).sort()).toEqual([...ALLOWED_C2].sort());
    expect(C2_PHASES).toContain(only!.phase);
    expect(only!.attempt).toBeNull();
    expect(only!.problems).toEqual([
      { class: "unknown-ownership-id", row_index: null, ownership_index: 0, role_index: 2 },
      { class: "unowned-row", row_index: 3, ownership_index: null, role_index: null },
    ]);
    for (const entry of only!.problems) {
      expect(Object.keys(entry).sort()).toEqual([...ALLOWED_C2_PROBLEM].sort());
      expect(C2_PROBLEM_CLASSES).toContain(entry.class);
    }
  });

  it("ファイルの名前と直列化は 1 か所で決める：記録 0 件なら作らず、記録があれば同じ名前の 1 本になる", () => {
    expect(buildStopDiagnosticsFile([])).toEqual([]);
    const files = buildStopDiagnosticsFile([
      c2StopDiagnostic({ round: 1, phase: "initial", attempt: 1, problems: [] }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(STOP_DIAGNOSTICS_FILE);
    expect(files[0]?.text).toBe(serializeStopDiagnostics([c2StopDiagnostic({ round: 1, phase: "initial", attempt: 1, problems: [] })]));
  });
});

describe("診断の投影は制御を変えない（Issue #898。H4-diagnostic-control-invariant）", () => {
  const C3_OUTPUTS = [
    {
      judgments: [
        { requirementId: "R1", verdict: "accept", kind: null, quote: null },
        { requirementId: UNKNOWN_ID_SENTINEL, verdict: "accept", kind: null, quote: null },
      ],
    },
    { judgments: [{ requirementId: "R1", verdict: "accept", kind: null, quote: null }] },
  ];
  const runC3 = async (collect: boolean, throwing: boolean) => {
    const recording = createCheckedRecordingClient(C3_OUTPUTS.map(recordedStructured));
    const collected = sink();
    const shapeRetries = { limit: 2, used: [] as { round: number; bundle: number }[] };
    const outcome = await runSemanticCheck(
      c3Input(makeGateway(recording.client), {
        round: 1,
        shapeRetries,
        ...(collect ? { onStopDiagnostic: collected.onStopDiagnostic } : {}),
        ...(throwing
          ? {
              onStopDiagnostic: () => {
                throw new Error("診断の口の例外は制御に効かない");
              },
            }
          : {}),
      }),
    );
    return { outcome, requests: recording.structured, used: shapeRetries.used, records: collected.records };
  };

  it("C3：口の無し・受け取る・例外を投げるの 3 通りで、要求の列・試行・予算・結果が同じ", async () => {
    const none = await runC3(false, false);
    const collecting = await runC3(true, false);
    const throwing = await runC3(false, true);
    expect(JSON.stringify(collecting.requests)).toBe(JSON.stringify(none.requests));
    expect(JSON.stringify(throwing.requests)).toBe(JSON.stringify(none.requests));
    expect(collecting.outcome).toEqual(none.outcome);
    expect(throwing.outcome).toEqual(none.outcome);
    expect(collecting.used).toEqual(none.used);
    expect(throwing.used).toEqual(none.used);
    expect(none.records).toEqual([]);
    expect(throwing.records).toEqual([]);
    expect(collecting.records.length).toBeGreaterThan(0);
  });

  const MAP_LIST = fixtureList();
  const MAP_TABLE = withCodeIds(fixtureTable());
  const GOOD = idsResponsesOf(MAP_LIST, MAP_TABLE).mapping as { requirements: Record<string, unknown>[] };
  /** R1 に表に無い行を所属させた応答（書き直しで回復する） */
  const badOutput = () => ({
    requirements: GOOD.requirements.map((entry, index) =>
      index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), { id: "row-does-not-exist", basis: "stated", reason: null }] } : entry,
    ),
  });
  const rewriteOfR1 = () => ({ requirements: GOOD.requirements.filter((entry) => entry["requirementId"] === "R1") });
  const runC2 = async (collect: boolean, throwing: boolean) => {
    const outputs = [badOutput(), rewriteOfR1()];
    const recording = createCheckedRecordingClient(outputs.map(recordedStructured), { bundledC2: true });
    const collected = sink();
    const outcome = await runMapping({
      plan: fixturePlanOf(MAP_LIST),
      list: MAP_LIST,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      rows: MAP_TABLE.rows,
      ...(collect ? { onStopDiagnostic: collected.onStopDiagnostic } : {}),
      ...(throwing
        ? {
            onStopDiagnostic: () => {
              throw new Error("診断の口の例外は制御に効かない");
            },
          }
        : {}),
    });
    return { outcome, requests: recording.structured, records: collected.records };
  };

  it("C2：口の無し・受け取る・例外を投げるの 3 通りで、要求の列と結果（書き直し・採用する表）が同じ", async () => {
    const none = await runC2(false, false);
    const collecting = await runC2(true, false);
    const throwing = await runC2(false, true);
    expect(collecting.outcome.ok).toBe(true);
    expect(none.outcome.ok).toBe(true);
    expect(JSON.stringify(collecting.requests)).toBe(JSON.stringify(none.requests));
    expect(JSON.stringify(throwing.requests)).toBe(JSON.stringify(none.requests));
    expect(collecting.outcome).toEqual(none.outcome);
    expect(throwing.outcome).toEqual(none.outcome);
    expect(none.records).toEqual([]);
    expect(throwing.records).toEqual([]);
    expect(collecting.records.length).toBeGreaterThan(0);
  });

  it("C2 の作り直し：全体再試行の「前回の形の問題」の塊を含む要求が、診断の口の有無でバイト列同一", async () => {
    const base = MAP_TABLE.rows.find((row) => row.kind === "field");
    if (base === undefined) throw new Error("前提が壊れた：題材の表に項目の行が無い");
    const table = { ...MAP_TABLE, rows: [...MAP_TABLE.rows, { ...base, id: "f.item.unowned", name: "unownedItem" }] };
    const outputs = [{ requirements: GOOD.requirements }, { requirements: GOOD.requirements }];
    const runRebuild = async (collect: boolean) => {
      const recording = createCheckedRecordingClient(outputs.map(recordedStructured), { bundledC2: true });
      const collected = sink();
      const outcome = await runMapping({
        plan: fixturePlanOf(MAP_LIST),
        list: MAP_LIST,
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
        rows: table.rows,
        ...(collect ? { onStopDiagnostic: collected.onStopDiagnostic } : {}),
      });
      return { outcome, requests: recording.structured, records: collected.records };
    };
    const none = await runRebuild(false);
    const collecting = await runRebuild(true);
    expect(JSON.stringify(collecting.requests)).toBe(JSON.stringify(none.requests));
    expect(collecting.outcome).toEqual(none.outcome);
    // 2 本目の要求に「前回の形の問題」の塊が入る（診断を足しても塊は変わらない）
    expect(collecting.requests).toHaveLength(2);
    expect(none.requests[1]?.input).toContain("前回の形の問題");
    expect(none.records).toEqual([]);
    expect(collecting.records.map((record) => (record.kind === "c2" ? record.phase : null))).toEqual(["initial", "rebuild"]);
  });

  it("C2：診断を受け取っても、処理対象（応答・表）を診断側が変更できない（記録は複製で、参照を持たない）", async () => {
    const collecting = await runC2(true, false);
    const [record] = collecting.records;
    if (record?.kind !== "c2") throw new Error("C2 の記録が無い");
    // 記録を書き換えても、返した表・問題は変わらない（記録は値だけを持つ）
    const snapshot = JSON.stringify(collecting.outcome);
    (record.problems as unknown as unknown[]).push({ class: "other", row_index: 0, ownership_index: 0, role_index: 0 });
    expect(JSON.stringify(collecting.outcome)).toBe(snapshot);
  });
});
