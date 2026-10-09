// 納品物（bundle の manifest と headless の要約）の wire の正本の unit（Issue #283）。
//
// ここで固定するもの：
//   1. 2 つの版の文字列（manifest と要約）
//   2. 要約の必須の欄の一覧（snake_case）と、任意の欄（`pack` だけ）
//   3. 要約の wire の schema が、次の 4 つの形を受け付けること（完了条件 4。読み取りは control-plane に残す）：
//      欠測の null・`pack` が無い要約・知らない欄が足された要約・知らない値の文字列
//
// 見本は**手で書いた v1 の写像**である（本物の工場は呼ばない。外部の LLM の API も呼ばない）。
import { describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  HEADLESS_OPTIONAL_KEYS,
  HEADLESS_REQUIRED_KEYS,
  HEADLESS_SCHEMA_VERSION,
  acceptsHeadlessSummaryWire,
  type HeadlessSummaryWire,
} from "./delivery.js";

// ── 手で書いた v1 の要約（wire。snake_case）────────────────────────

/** v1 の要約。既定は必須の欄をすべて持ち、無い値は JSON の null。`overrides` で欄を差し替える。 */
const wireSummary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: HEADLESS_SCHEMA_VERSION,
  run_id: "run-1",
  verdict: "full",
  assurance: "full",
  score: 1,
  acceptance_sheet_path: "acceptance/sheet.json",
  artifacts_dir: "artifacts",
  events_path: "events.jsonl",
  duration_secs: 1.5,
  provider_cost_usd: 0,
  provider_usage_by_role: {},
  stop_class: "completed",
  directive_round: 1,
  status: "completed",
  gate: "S",
  stop_reason: null,
  next_action: null,
  changed_files: [],
  verify_commands: [],
  exit_code: 0,
  ...overrides,
});

/** キーを 1 つ落とした写像を返す（欠測の見本を作る）。 */
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...record };
  delete copy[key];
  return copy;
};

// ── 1. 2 つの版の文字列 ────────────────────────────────────────────

describe("納品物の版（Issue #283）", () => {
  it("manifest の版は、正本の文字列である", () => {
    expect(BUNDLE_MANIFEST_SCHEMA_VERSION).toBe("commandagent.community-delivery-bundle/v1");
  });

  it("要約の版は、正本の文字列である", () => {
    expect(HEADLESS_SCHEMA_VERSION).toBe("commandagent.headless-summary/v1");
    expect(wireSummary()["schema_version"]).toBe(HEADLESS_SCHEMA_VERSION);
  });
});

// ── 2. 要約の必須の欄（snake_case）と任意の欄 ──────────────────────

describe("要約の必須の欄（snake_case。Issue #283）", () => {
  it("必須の欄の一覧を固定する", () => {
    expect(HEADLESS_REQUIRED_KEYS).toEqual([
      "run_id",
      "verdict",
      "assurance",
      "score",
      "acceptance_sheet_path",
      "artifacts_dir",
      "events_path",
      "duration_secs",
      "provider_cost_usd",
      "provider_usage_by_role",
      "stop_class",
      "directive_round",
      "status",
      "gate",
      "stop_reason",
      "next_action",
      "changed_files",
      "verify_commands",
      "exit_code",
    ]);
  });

  it("任意の欄は `pack` だけである", () => {
    expect(HEADLESS_OPTIONAL_KEYS).toEqual(["pack"]);
    expect(HEADLESS_REQUIRED_KEYS).not.toContain("pack");
  });
});

// ── 3. wire の schema が受け付ける形（完了条件 4）──────────────────

describe("要約の wire の schema が受け付ける形（Issue #283）", () => {
  it("wire の型（snake_case）は、必須の欄と null を表せる", () => {
    const wire: HeadlessSummaryWire = {
      schema_version: HEADLESS_SCHEMA_VERSION,
      run_id: null,
      verdict: null,
      assurance: null,
      score: null,
      acceptance_sheet_path: null,
      artifacts_dir: null,
      events_path: null,
      duration_secs: null,
      provider_cost_usd: null,
      provider_usage_by_role: {},
      stop_class: null,
      directive_round: null,
      status: null,
      gate: null,
      stop_reason: null,
      next_action: null,
      changed_files: [],
      verify_commands: [],
      exit_code: null,
    };
    expect(acceptsHeadlessSummaryWire(wire)).toBe(true);
  });

  it("欠測の null（無い値は JSON null で埋まる）を受け付ける", () => {
    expect(acceptsHeadlessSummaryWire(wireSummary({ stop_reason: null, next_action: null, score: null }))).toBe(true);
  });

  it("`pack` が無い要約を受け付ける（あるときも受け付ける）", () => {
    const withoutPack = wireSummary();
    expect("pack" in withoutPack).toBe(false);
    expect(acceptsHeadlessSummaryWire(withoutPack)).toBe(true);
    expect(acceptsHeadlessSummaryWire(wireSummary({ pack: { name: "example" } }))).toBe(true);
  });

  it("知らない欄が足された要約を受け付ける", () => {
    expect(acceptsHeadlessSummaryWire(wireSummary({ unknown_field: "知らない欄", another_unknown: 42 }))).toBe(true);
  });

  it("値の文字列が知らない値でも受け付ける", () => {
    expect(acceptsHeadlessSummaryWire(wireSummary({ verdict: "unknown-verdict", status: "unknown-status" }))).toBe(
      true,
    );
  });

  it("必須の欄が欠けていれば受け付けない", () => {
    expect(acceptsHeadlessSummaryWire(without(wireSummary(), "run_id"))).toBe(false);
  });

  it("版が違えば受け付けない", () => {
    expect(acceptsHeadlessSummaryWire(wireSummary({ schema_version: "commandagent.headless-summary/v2" }))).toBe(
      false,
    );
  });

  it("写像でなければ受け付けない", () => {
    for (const value of [null, undefined, 1, "x", [], [wireSummary()]]) {
      expect(acceptsHeadlessSummaryWire(value), String(value)).toBe(false);
    }
  });
});
