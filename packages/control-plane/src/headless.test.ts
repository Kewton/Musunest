// headless 契約 v1 の読み取りと、Q7 の受け入れの判定の unit（#246）。
//
// 見本は**手で書いた v1 の JSON の行**である（本物の工場を呼ばない）。stdout の全文（前の行は人向けの
// 出力）を渡し、最後の JSON の行を読むこと・版やスカラーのキーを断ること・受け入れの規則を固定する。
//
// 参照：`pins/commandagent.json`（revision 031ec74 の `headless_contract`）・
// `workspace/mvp/m1/00-open-questions.md` §Q7。
import { describe, expect, it } from "vitest";
import {
  ASSURANCE_FULL,
  ASSURANCE_PARTIAL,
  HEADLESS_SCHEMA_VERSION,
  STATUS_COMPLETED,
  VERDICT_FULL,
  judgeAcceptance,
  readHeadlessSummary,
} from "./headless.js";

// ── 手で書いた v1 の見本 ────────────────────────────────────────────

/** v1 の要約（写像）。既定は「L2 が受け入る」値。`overrides` で欄を差し替える。 */
const summaryObject = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: HEADLESS_SCHEMA_VERSION,
  run_id: "run-2026-09-26-001",
  verdict: VERDICT_FULL,
  assurance: ASSURANCE_PARTIAL,
  score: 0.98,
  acceptance_sheet_path: "acceptance/sheet.json",
  artifacts_dir: "artifacts",
  events_path: "events.jsonl",
  duration_secs: 12.5,
  provider_cost_usd: 0.42,
  provider_usage_by_role: { builder: { turns: 3 } },
  stop_class: "completed",
  directive_round: 1,
  status: STATUS_COMPLETED,
  gate: "S",
  stop_reason: null,
  next_action: null,
  changed_files: ["artifacts/app.spec.yaml"],
  verify_commands: ["pnpm test"],
  exit_code: 0,
  ...overrides,
});

const summaryLine = (overrides: Record<string, unknown> = {}): string => JSON.stringify(summaryObject(overrides));

/** キーを 1 つ落とした写像を返す（欠測の見本を作る）。 */
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...record };
  delete copy[key];
  return copy;
};

/** 読めるはずの stdout を読み、要約を返す（読めなければテストを落とす）。 */
const read = (stdout: string) => {
  const result = readHeadlessSummary(stdout);
  if (!result.ok) throw new Error(`読めるはずの要約を断った: ${result.code}`);
  return result.summary;
};

describe("readHeadlessSummary — 最後の JSON の行を読む", () => {
  it("最終行の v1 の要約を、型つきで返す", () => {
    const summary = read(summaryLine());
    expect(summary.schemaVersion).toBe(HEADLESS_SCHEMA_VERSION);
    expect(summary.runId).toBe("run-2026-09-26-001");
    expect(summary.verdict).toBe(VERDICT_FULL);
    expect(summary.assurance).toBe(ASSURANCE_PARTIAL);
    expect(summary.score).toBe(0.98);
    expect(summary.artifactsDir).toBe("artifacts");
    expect(summary.durationSecs).toBe(12.5);
    expect(summary.providerCostUsd).toBe(0.42);
    expect(summary.providerUsageByRole).toEqual({ builder: { turns: 3 } });
    expect(summary.directiveRound).toBe(1);
    expect(summary.status).toBe(STATUS_COMPLETED);
    expect(summary.exitCode).toBe(0);
    expect(summary.changedFiles).toEqual(["artifacts/app.spec.yaml"]);
    expect(summary.verifyCommands).toEqual(["pnpm test"]);
  });

  it("前の行（人向けの出力）を飛ばして、最後の JSON の行を読む", () => {
    const stdout = ["CommandAgent: 生成を開始します", "進捗 3/3", summaryLine(), ""].join("\n");
    expect(read(stdout).runId).toBe("run-2026-09-26-001");
  });

  it("人向けの出力が JSON の行の間や後ろにあっても、最後の JSON の行を読む", () => {
    const stdout = [summaryLine({ run_id: "first" }), "まだ続きます", summaryLine({ run_id: "last" }), ""].join("\n");
    expect(read(stdout).runId).toBe("last");
  });

  it("無い値は null として読む（欠測は JSON null で埋まる）", () => {
    const summary = read(summaryLine({ stop_reason: null, next_action: null, score: null }));
    expect(summary.stopReason).toBeNull();
    expect(summary.nextAction).toBeNull();
    expect(summary.score).toBeNull();
  });

  it("pack は無いことがある（無ければ null、あれば写像として読む）", () => {
    expect(read(summaryLine()).pack).toBeNull();
    expect(read(summaryLine({ pack: { name: "community" } })).pack).toEqual({ name: "community" });
  });
});

describe("readHeadlessSummary — 断る", () => {
  it("JSON が無い（人向けの出力だけ）を断る", () => {
    const result = readHeadlessSummary("生成を開始します\n完了しました\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("断るはず");
    expect(result.code).toBe("summary_not_found");
  });

  it("空の stdout を断る", () => {
    const result = readHeadlessSummary("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("断るはず");
    expect(result.code).toBe("summary_not_found");
  });

  it("版が違う要約を断る（実際の値を返す）", () => {
    const result = readHeadlessSummary(summaryLine({ schema_version: "commandagent.headless-summary/v2" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("断るはず");
    expect(result.code).toBe("schema_version_mismatch");
    expect(result.actualSchemaVersion).toBe("commandagent.headless-summary/v2");
  });

  it("スカラーのキーが欠ける要約を断る（どの欄かを返す）", () => {
    for (const key of ["run_id", "verdict", "assurance", "status", "exit_code"]) {
      const result = readHeadlessSummary(JSON.stringify(without(summaryObject(), key)));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`断るはず: ${key}`);
      expect(result.code).toBe("missing_keys");
      expect(result.missingKeys).toEqual([key]);
    }
  });
});

describe("judgeAcceptance — Q7 の規則", () => {
  const summaryWith = (overrides: Record<string, unknown> = {}) => read(summaryLine(overrides));

  it("L2：verdict full・assurance partial・status completed を受け入れる", () => {
    const decision = judgeAcceptance(summaryWith(), "L2");
    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.level).toBe("L2");
  });

  it("L2：assurance full も受け入れる", () => {
    expect(judgeAcceptance(summaryWith({ assurance: ASSURANCE_FULL }), "L2").accepted).toBe(true);
  });

  it("L3/L4：verdict と assurance がどちらも full で受け入れる", () => {
    expect(judgeAcceptance(summaryWith({ assurance: ASSURANCE_FULL }), "L3").accepted).toBe(true);
    expect(judgeAcceptance(summaryWith({ assurance: ASSURANCE_FULL }), "L4").accepted).toBe(true);
  });

  it("終了コードが 0 でも、verdict が full でなければ受け入れない", () => {
    const decision = judgeAcceptance(summaryWith({ verdict: "partial", exit_code: 0 }), "L2");
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual([
      { code: "verdict_not_full", field: "verdict", actual: "partial", expected: [VERDICT_FULL] },
    ]);
  });

  it("終了コードが 0 でも、status が completed でなければ受け入れない", () => {
    const decision = judgeAcceptance(summaryWith({ status: "failed", exit_code: 0 }), "L2");
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual([
      { code: "status_not_completed", field: "status", actual: "failed", expected: [STATUS_COMPLETED] },
    ]);
  });

  it("終了コードが 0 でも、assurance が null なら受け入れない", () => {
    const decision = judgeAcceptance(summaryWith({ assurance: null, exit_code: 0 }), "L2");
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual([
      {
        code: "assurance_insufficient",
        field: "assurance",
        actual: null,
        expected: [ASSURANCE_FULL, ASSURANCE_PARTIAL],
      },
    ]);
  });

  it("L3/L4 は assurance partial を受け入れない（L2 と規則が違う）", () => {
    const decision = judgeAcceptance(summaryWith({ assurance: ASSURANCE_PARTIAL }), "L4");
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual([
      { code: "assurance_insufficient", field: "assurance", actual: ASSURANCE_PARTIAL, expected: [ASSURANCE_FULL] },
    ]);
  });

  it("満たさない欄が複数あれば、そのすべてを理由に挙げる", () => {
    const decision = judgeAcceptance(
      summaryWith({ status: "failed", verdict: "none", assurance: null }),
      "L2",
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "status_not_completed",
      "verdict_not_full",
      "assurance_insufficient",
    ]);
  });
});
