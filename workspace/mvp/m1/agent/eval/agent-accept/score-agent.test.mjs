// score-agent.mjs の試験（node --test。#425・#426）。ネットワーク無し・API 無しで閉じる：
// 一時の出力先に固定の出力（要約・宣言・申告・条件のファイル・起動の記録）を置き、このリポジトリの凍結した採点表 v5
// （engine.mjs・subjects/）と spec-engine・appspec-schema の dist で採点する。宣言は cases/ の正例・負例を使う（題材の言葉をここに書かない）。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"（先に pnpm build で spec-engine の dist を作る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { PLAN_TABLE_OUTCOMES, planBuildTables, ABSENT_REASONS, ACCEPTANCE_STATUSES, CATALOG_FACET_IDS, CONDITIONS_SCHEMAS, DEFAULT_SET_PATH, EVAL_SET_SCHEMA, JUDGEMENTS, PLAN_SCRIPT_SCHEMA, PLAN_SPEC_SCHEMA, SCORING_FILES, SCRIPT_MODE, SCRIPT_RUN_STATUSES, UNVERIFIED_SOURCES, VERDICT_UNEVALUATED, WRONG_ACCEPTANCE_EVALUATION, acceptanceMatcher, anonymize, applyScript, fingerprintDir, judgeDisposition, loadEvalSet, loadPlan, loadScript, planTexts, questionFacets, readAcceptance, reconcile, scoringFingerprint, scriptSummary, scriptsFingerprint, sha256, validatePlanShape, validatePlanned, validateScript } from "./score-agent.mjs";
import { BUILD_RECORD_PATH, ENVELOPE_REASONS, checkPlanResult, EXIT_CLASSES, PLAN_ONLY_RESULT_SCHEMA, PLAN_RESULT_PATH, SCRIPT_MATCH_STATES, evaluationOf, frozenProblem, stat4 } from "./score-agent.mjs";
import { DEFAULT_ALLOWED, finalVerdict, scoreClaims } from "../score-claims.mjs";
import { loadDef, score } from "../engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scoreFile = join(here, "score-agent.mjs");
const ev = resolve(here, "..");
const repo = resolve(ev, "../../../../..");
assert.ok(existsSync(join(repo, "packages/spec-engine/dist/index.js")), "spec-engine の dist が無い（pnpm build を先に）");
assert.ok(existsSync(join(repo, "packages/appspec-schema/dist/index.js")), "appspec-schema の dist が無い（pnpm build を先に）");
// 確定した仕様の契約の検査と SHA（採点器が読むものと同じ dist）。試験の正例が契約に通ることの確認と、失効の負例の作成に使う
const { checkConfirmedPlan, planDigest } = await import(pathToFileURL(join(repo, "packages/appspec-schema/dist/index.js")).href);
const [V1, V2, V3] = CONDITIONS_SCHEMAS;
const SIG = sha256("sig");
const HEX64 = /^[0-9a-f]{64}$/;

// 固定の宣言（cases/ の正例・負例。期待の判定は cases.json）
const CASES = join(ev, "cases");
const PASS_A = readFileSync(join(CASES, "d1-pos-table-no-show.app.spec.yaml"));      // A の主の構造で全部満たす
const FAIL_A = readFileSync(join(CASES, "d1-neg-show-without-count.app.spec.yaml")); // A で 1 つ落とす
const NOROLE_A = readFileSync(join(CASES, "d3-pos-dashboard-first.app.spec.yaml"));  // C の宣言を A として採点 → 役割が見つからない
const STATIC_NG = "entities: 1\n";                                                    // 形の検査で落ちる
const PASS_D = readFileSync(join(CASES, "d2-pos-attendance-claimed.app.spec.yaml"));  // D の別の構造で全部満たし、書けない要件を申告
const dLog = JSON.parse(readFileSync(join(CASES, "d2-pos-attendance-claimed.log.json"), "utf8"));
// 工場の納品物の unwritable.json の形（{ text, quote, unwritable: [理由] }）に直す
const CLAIM_D = { unwritable: dLog.attempts.at(-1).unwritable.map((u) => ({ text: u.requirement, quote: "", unwritable: [u.reason] })) };
const defOf = (s) => JSON.parse(readFileSync(join(ev, "subjects", `${s}.json`), "utf8"));
/** 既定の組が参照する採点の定義の実体（採点の指紋に入る。fix-427） */
const DEFAULT_DEFINITIONS = loadEvalSet(join(repo, DEFAULT_SET_PATH)).definitions;
const definitionsOf = (evDir) => loadEvalSet(join(evDir, "sets/dev-p1-p10.json")).definitions;
const totalOf = (s) => defOf(s).structures[0].checks.length;
const reqsOf = (s) => defOf(s).structures.flatMap((st) => st.checks.map((c) => c.req));

const summaryLine = (generated, verdict) => JSON.stringify({ exit: generated ? 0 : 1, wall_s: 120, summary: { schema_version: "commandagent.headless-summary/v1", verdict: verdict ?? (generated ? "partial" : "none"), stop_reason: generated ? "completed" : "deadline", provider_cost_usd: 0.05, failure: null }, plan_cost: null, stderr_tail: "", resumed: false });
/** 本を 1 つ置く。spec が無ければ生成失敗（宣言が無い）。summary が false なら要約の無い途中の本。verdict で工場の要約の判定の値を差し替える */
function addRun(out, id, { spec = null, unwritable = null, summary = true, verdict } = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  if (summary) { writeFileSync(join(dir, "summary.line.json"), summaryLine(spec !== null, verdict)); writeFileSync(join(dir, "stdout.log"), ""); writeFileSync(join(dir, "stderr.log"), ""); }
  if (spec !== null) writeFileSync(join(dir, "bundle/artifacts/app.spec.yaml"), spec);
  if (unwritable !== null) writeFileSync(join(dir, "bundle/artifacts/unwritable.json"), JSON.stringify(unwritable));
}
/** 予定の一覧と整合する params（patterns は ID の出現順・runs は最大の回）を持つ v2 の条件のファイル */
const paramsFor = (ids) => ({ patterns: [...new Set(ids.map((id) => id.split("-")[0]))], runs: Math.max(0, ...ids.map((id) => Number(id.split("-r")[1]))) });
const conditions = (out, ids, extra = {}) => writeFileSync(join(out, "conditions.json"), JSON.stringify({ schema: V2, measurement_id: "t", params: paramsFor(ids), child_args: ids.map((id) => ({ id, argv: [] })), signature: SIG, ...extra }));
const rawConditions = (out, obj) => { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "conditions.json"), typeof obj === "string" ? obj : JSON.stringify(obj)); };
function scoreRun(out, extra = [], repoArg = repo) {
  const r = spawnSync(process.execPath, [scoreFile, repoArg, out, ...extra], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const readScore = (out, name = "score.json") => JSON.parse(readFileSync(join(out, name), "utf8"));
const rowOf = (full, id) => full.rows.find((r) => r.run === id);
const fileOf = (fp, path) => fp.files.find((f) => f.path === path);
const startsWith = (s, head) => assert.ok(s.startsWith(head), `${JSON.stringify(s)} は ${head} で始まらない`);
/** 別の checkout を装う偽物のリポジトリ：採点の定義とエンジンはこの checkout の写し。集計のコードは旧い版（1 行足す）か同じ版。spec-engine・appspec-schema の dist は実体へのリンク */
function makeCheckout(base, name, { sameAggregator = false } = {}) {
  const fake = join(base, name), fakeEv = join(fake, "workspace/mvp/m1/agent/eval");
  mkdirSync(join(fakeEv, "agent-accept"), { recursive: true });
  for (const f of SCORING_FILES) cpSync(join(ev, f), join(fakeEv, f));
  cpSync(join(ev, "subjects"), join(fakeEv, "subjects"), { recursive: true });
  // 既定の組（#427）も写す（採点の道具は <repo> の既定の定義ファイルを読む）
  cpSync(join(ev, "sets"), join(fakeEv, "sets"), { recursive: true });
  if (!sameAggregator) appendFileSync(join(fakeEv, "agent-accept/score-agent.mjs"), "\n// 旧い採点器\n");
  mkdirSync(join(fake, "packages/spec-engine"), { recursive: true });
  symlinkSync(join(repo, "packages/spec-engine/dist"), join(fake, "packages/spec-engine/dist"), "dir");
  mkdirSync(join(fake, "packages/appspec-schema"), { recursive: true });
  symlinkSync(join(repo, "packages/appspec-schema/dist"), join(fake, "packages/appspec-schema/dist"), "dir");
  return { repo: fake, ev: fakeEv };
}

async function withOut(fn) {
  const base = mkdtempSync(join(tmpdir(), "score-agent-test-"));
  try { await fn(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

test("生成に失敗した本を含む組：補正前（v1）は分母から落ち、補正後（v2）は題材の定義の判定の数を分母に残す", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    addRun(out, "P7-r2");
    conditions(out, ["P7-r1", "P7-r2"]);
    scoreRun(out);
    const full = readScore(out);
    const n = totalOf("D");
    startsWith(full.metrics.generated, "1/2（");
    startsWith(full.metrics.fulfillment_partial, `${n}/${n}（`);
    assert.equal(full.fulfillment.v1.partial, full.metrics.fulfillment_partial, "v1 は既存の欄と同じ値");
    startsWith(full.fulfillment.v2.partial, `${n}/${n * 2}（`);
    startsWith(full.fulfillment.v2.all, `${n}/${n * 2}（`);
    assert.equal(full.aggregation_versions.v1.startsWith("補正前"), true);
    assert.equal(full.aggregation_versions.v2.startsWith("補正後"), true);
    const ok = rowOf(full, "P7-r1"), failed = rowOf(full, "P7-r2");
    assert.equal(ok.verdict, "PASS");
    assert.equal(ok.claims.missed, 0);
    assert.deepEqual(ok.fulfillment_v2, { fulfilled: n, total: n, total_from: `structure:${ok.claims.structure}` });
    assert.equal(failed.generation_failed, true);
    assert.equal("fulfilled" in failed, false, "v1 の欄は生成失敗の本に足さない");
    assert.deepEqual(failed.fulfillment_v2, { fulfilled: 0, total: n, total_from: `definition:${defOf("D").structures[0].id}` });
  });
});

test("静的 NG・役割が見つからない・不合格の本を含む組：v1 と v2 の分母が別の版として並ぶ", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: STATIC_NG });
    addRun(out, "P1-r3", { spec: NOROLE_A });
    addRun(out, "P1-r4", { spec: FAIL_A });
    conditions(out, ["P1-r1", "P1-r2", "P1-r3", "P1-r4"]);
    scoreRun(out);
    const full = readScore(out);
    const n = totalOf("A");
    // v1：静的 NG は 0/0（分母に入らない）、役割なしは 0/n、不合格は (n-1)/n → (n + 0 + 0 + n-1) / (n + 0 + n + n)
    startsWith(full.fulfillment.v1.writable, `${2 * n - 1}/${3 * n}（`);
    startsWith(full.fulfillment.v2.writable, `${2 * n - 1}/${4 * n}（`);
    assert.equal(full.fulfillment.v1.all, full.fulfillment.v1.writable);
    assert.equal(full.fulfillment.v2.all, full.fulfillment.v2.writable);
    startsWith(full.metrics.final_static, "3/4（");
    startsWith(full.metrics.spec_pass_writable, "1/4（");
    const sng = rowOf(full, "P1-r2"), norole = rowOf(full, "P1-r3"), fail = rowOf(full, "P1-r4");
    assert.equal(sng.spec_verdict, "STATIC_NG");
    assert.equal(sng.final_static, 1);
    assert.equal(sng.writable_total, 0, "v1 の静的 NG の分母は 0 のまま");
    assert.deepEqual(sng.fulfillment_v2, { fulfilled: 0, total: n, total_from: "definition:main" });
    assert.equal(norole.verdict, "FAIL");
    assert.deepEqual(norole.failed, ["役割が見つかる"]);
    assert.deepEqual(norole.fulfillment_v2, { fulfilled: 0, total: n, total_from: "definition:main" });
    assert.deepEqual(fail.fulfillment_v2, { fulfilled: n - 1, total: n, total_from: "structure:main" });
    // 既存の指標の欄は名前も順序も変えない
    assert.deepEqual(Object.keys(full.metrics), ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd", "factory_verdicts"]);
    assert.deepEqual(Object.keys(full.bySubject), ["A", "B", "C", "D", "E"]);
    assert.equal(full.rubric, "v5");
  });
});

test("予定した本に未実行・途中の本が残る計測は「未完了」と出し、条件のファイルが無ければ「未照合」", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: PASS_A });
    conditions(out, ["P1-r1", "P1-r2", "P1-r3", "P1-r4"]);
    addRun(out, "P1-r4", { summary: false });
    writeFileSync(join(out, "run-1000.json"), JSON.stringify({ finished_at: "t", mode: "fresh", executed: ["P1-r1", "P1-r2"], pending: ["P1-r3"], stop: "予算 0.5 USD に達した", stop_code: "budget", budget_usd: 0.5 }));
    const r = scoreRun(out);
    const c = readScore(out).completion;
    assert.equal(c.status, "incomplete");
    assert.equal(c.label, "未完了");
    assert.deepEqual(c.reasons, ["未実行 1 本", "途中 1 本"]);
    assert.equal(c.planned, 4);
    assert.equal(c.executed, 2);
    assert.deepEqual(c.unexecuted, ["P1-r3"]);
    assert.deepEqual(c.incomplete, ["P1-r4"]);
    assert.deepEqual(c.extra, []);
    assert.deepEqual(c.latest_record, { file: "run-1000.json", stop: "予算 0.5 USD に達した", stop_code: "budget", pending: ["P1-r3"], budget_usd: 0.5 });
    assert.match(r.stdout, /照合: 未完了（予定 4・実行 2・採点 3・未実行 1・途中 1・採点できない 0・止まった理由: 予算 0\.5 USD に達した）/);
    assert.deepEqual([c.scored, c.unscored], [3, []], "採点した本数（途中の本も生成失敗として採点する）と、採点できない本");
    // 流し切った計測は完了。予定に無い本があれば未完了（予定外）
    const done = join(base, "done");
    addRun(done, "P1-r1", { spec: PASS_A });
    addRun(done, "P1-r2");
    conditions(done, ["P1-r1", "P1-r2"]);
    const c2 = reconcile(done);
    assert.equal(c2.status, "complete");
    assert.equal(c2.label, "完了");
    assert.deepEqual(c2.reasons, []);
    assert.equal(c2.latest_record, null);
    addRun(done, "P2-r1", { spec: PASS_A });
    assert.deepEqual(reconcile(done).reasons, ["予定外 1 本"]);
    // 条件のファイルの無い出力先（#401 より前）は照合できない
    const old = join(base, "old");
    addRun(old, "P1-r1", { spec: PASS_A });
    const r3 = scoreRun(old);
    const c3 = readScore(old).completion;
    assert.equal(c3.status, "unverified");
    assert.equal(c3.label, "未照合");
    assert.deepEqual(c3.reasons, ["条件のファイルが無い"]);
    assert.equal(c3.planned, null);
    assert.equal(c3.executed, 1);
    assert.match(r3.stdout, /照合: 未照合（予定 -・実行 1・採点 1・未実行 -・途中 0・採点できない 0・理由: 条件のファイルが無い）/);
  });
});

test("予定を検証できない条件のファイルは「完了」に丸めず「未照合」と理由を出す（欠落・重複・予定の短縮・未知の schema・params との不一致・0 本・読めない）", async () => {
  await withOut(async (base) => {
    const cases = [
      ["no-child-args", { schema: V2, params: { patterns: ["P1"], runs: 2 } }, "予定の一覧（child_args）が無いか配列でない"],
      ["duplicate", { schema: V2, child_args: [{ id: "P1-r1" }, { id: "P1-r1" }], params: { patterns: ["P1"], runs: 2 } }, "予定の ID が重複"],
      ["short", { schema: V2, child_args: [{ id: "P1-r1" }], params: { patterns: ["P1"], runs: 2 } }, "予定の一覧が params.patterns × runs と一致しない"],
      ["other-pattern", { schema: V2, child_args: [{ id: "P1-r1" }, { id: "P2-r1" }], params: { patterns: ["P1"], runs: 2 } }, "予定の一覧が params.patterns × runs と一致しない"],
      ["unknown-schema", { schema: "MARK_SCHEMA/v9", child_args: [{ id: "P1-r1" }], params: { patterns: ["P1"], runs: 1 } }, "schema が未知"],
      ["no-params", { schema: V2, child_args: [{ id: "P1-r1" }] }, "params.patterns・params.runs が無いか形が違う"],
      ["bad-id", { schema: V2, child_args: [{ id: 1 }], params: { patterns: ["P1"], runs: 1 } }, "予定の ID が文字列でないか P<n>-r<n> の形でない"],
      ["empty", { schema: V2, child_args: [], params: { patterns: [], runs: 1 } }, "予定が 0 本"],
      ["unreadable", "{ これは JSON でない", "条件のファイルを読めない"],
    ];
    for (const [name, cond, reason] of cases) {
      const out = join(base, name);
      addRun(out, "P1-r1", { spec: PASS_A });
      rawConditions(out, cond);
      const r = scoreRun(out);
      const c = readScore(out).completion;
      assert.equal(c.status, "unverified", name);
      assert.equal(c.label, "未照合", name);
      assert.ok(c.reasons.includes(reason), `${name}: ${JSON.stringify(c.reasons)}`);
      assert.ok(!c.reasons.join("").includes("MARK_"), `${name}: 理由に入力の値が出ている`);
      assert.equal(c.planned, null, name);
      assert.equal(c.unexecuted, null, name);
      assert.equal(c.extra, null, name);
      assert.equal(c.executed, 1, name);
      assert.match(r.stdout, /照合: 未照合（予定 -・実行 1・採点 1・未実行 -・途中 0・採点できない 0・理由: /);
      // 匿名の出し方でも未照合のまま（完了に丸めない）
      scoreRun(out, ["--anonymous"]);
      assert.equal(readScore(out, "score.anonymous.json").completion.status, "unverified", name);
    }
    // 検証だけを直接：正しい v1・v2 は空、params.runs が文字列でも落ちる
    assert.deepEqual(validatePlanned({ schema: V2, child_args: [{ id: "P1-r1" }, { id: "P1-r2" }], params: { patterns: ["P1"], runs: 2 } }), []);
    assert.deepEqual(validatePlanned({ schema: V1, child_args: [{ id: "P3-r1" }], params: { patterns: ["P3"], runs: 1 } }), []);
    assert.ok(validatePlanned({ schema: V2, child_args: [{ id: "P1-r1" }], params: { patterns: ["P1"], runs: "1" } }).length > 0);
  });
});

test("v1 の条件のファイル（#401）の計測はそのまま照合でき、採点と spec-engine の指紋は条件に無いので null", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: FAIL_A });
    rawConditions(out, { schema: V1, measurement_id: "t", params: { effort: "high", patterns: ["P1"], runs: 2, budget_usd: 15 }, child_args: [{ id: "P1-r1", argv: [] }, { id: "P1-r2", argv: [] }], signature: SIG });
    scoreRun(out);
    const full = readScore(out);
    assert.equal(full.completion.status, "complete");
    assert.equal(full.completion.planned, 2);
    assert.equal(full.fingerprints.conditions.schema, V1);
    assert.equal(full.fingerprints.scoring_matches_conditions, null);
    assert.equal(full.fingerprints.spec_engine_matches_conditions, null);
    startsWith(full.fulfillment.v2.writable, `${2 * totalOf("A") - 1}/${2 * totalOf("A")}（`);
    scoreRun(out, ["--anonymous"]);
    const a = readScore(out, "score.anonymous.json");
    assert.equal(a.fingerprints.conditions.schema, V1);
    assert.equal(a.completion.status, "complete");
  });
});

test("採点の定義か集計のコードを 1 文字変えると指紋が変わり、採点の出力は条件のファイルの指紋（採点・spec-engine）と照合する", async () => {
  await withOut(async (base) => {
    const copy = join(base, "eval");
    mkdirSync(join(copy, "agent-accept"), { recursive: true });
    for (const f of SCORING_FILES) cpSync(join(ev, f), join(copy, f));
    cpSync(join(ev, "subjects"), join(copy, "subjects"), { recursive: true });
    const first = scoringFingerprint(copy);
    assert.deepEqual(first, scoringFingerprint(ev), "同じ中身なら同じ指紋");
    assert.deepEqual(first.missing, []);
    // subjects/ の全部の定義（開発用 A〜E と回帰用 R1〜R5。#450）が指紋に入る
    assert.deepEqual(first.files.map((f) => f.path), [...SCORING_FILES, ...["A", "B", "C", "D", "E", "R1", "R2", "R3", "R4", "R5"].map((s) => `subjects/${s}.json`)]);
    appendFileSync(join(copy, "subjects/A.json"), " ");
    const defChanged = scoringFingerprint(copy);
    assert.notEqual(defChanged.fingerprint, first.fingerprint, "題材の定義の 1 文字");
    appendFileSync(join(copy, "agent-accept/score-agent.mjs"), " ");
    const codeChanged = scoringFingerprint(copy);
    assert.notEqual(codeChanged.fingerprint, defChanged.fingerprint, "集計のコードの 1 文字");
    rmSync(join(copy, "rubric-v5.mjs"));
    assert.deepEqual(scoringFingerprint(copy).missing, ["rubric-v5.mjs"]);
    // 組が参照する採点の定義の実体（definition:<題材>）は、subjects/<題材>.json と別に指紋に入る（fix-427）。採点の出力の指紋はこれを含む
    const withDefs = scoringFingerprint(ev, undefined, DEFAULT_DEFINITIONS);
    assert.deepEqual(withDefs.files.map((f) => f.path), [...first.files.map((f) => f.path), ...["A", "B", "C", "D", "E"].map((s) => `definition:${s}`)]);
    for (const s of ["A", "B", "C", "D", "E"]) assert.deepEqual(fileOf(withDefs, `definition:${s}`), { path: `definition:${s}`, source: `subjects/${s}.json`, sha256: fileOf(withDefs, `subjects/${s}.json`).sha256 }, s);
    assert.notEqual(withDefs.fingerprint, scoringFingerprint(ev).fingerprint);
    assert.deepEqual(withDefs.missing, []);
    // 採点の出力：条件のファイルの指紋と一致／不一致／無い
    const mine = withDefs.fingerprint;
    const seMine = fingerprintDir(join(repo, "packages/spec-engine/dist")).fingerprint;
    assert.match(seMine, HEX64);
    for (const [name, recorded, expected] of [["same", mine, true], ["diff", defChanged.fingerprint, false], ["none", undefined, null]]) {
      const out = join(base, name);
      addRun(out, "P1-r1", { spec: PASS_A });
      conditions(out, ["P1-r1"], recorded === undefined ? {} : { scoring: { fingerprint: recorded } });
      scoreRun(out);
      const fp = readScore(out).fingerprints;
      assert.equal(fp.scoring.fingerprint, mine, name);
      assert.equal(fp.scoring.dir, "workspace/mvp/m1/agent/eval");
      assert.deepEqual(fp.scoring.aggregator, { path: "workspace/mvp/m1/agent/eval/agent-accept/score-agent.mjs", sha256: sha256(readFileSync(scoreFile)) }, "集計のコードは実行中のファイル");
      assert.equal(fp.scoring_matches_conditions, expected, name);
      assert.equal(fp.spec_engine.fingerprint, seMine);
      assert.equal(fp.spec_engine_matches_conditions, null, "条件のファイルに spec-engine の指紋が無い");
    }
    // spec-engine の dist の指紋：条件のファイルの値と一致（true）・不一致（false）
    for (const [name, recorded, expected] of [["se-same", seMine, true], ["se-diff", sha256("other dist"), false]]) {
      const out = join(base, name);
      addRun(out, "P1-r1", { spec: PASS_A });
      conditions(out, ["P1-r1"], { scoring: { fingerprint: mine }, spec_engine: { fingerprint: recorded } });
      scoreRun(out);
      const fp = readScore(out).fingerprints;
      assert.equal(fp.spec_engine_matches_conditions, expected, name);
      assert.equal(fp.scoring_matches_conditions, true, name);
      assert.equal(fp.conditions.spec_engine, recorded);
    }
  });
});

test("別の checkout の旧い採点器を <repo> に渡しても、集計のコードの指紋は実行中のファイルから取り、定義とエンジンは読み込んだ先から取る", async () => {
  await withOut(async (base) => {
    const old = makeCheckout(base, "old-checkout");
    // 旧い checkout で計測したときに条件のファイルへ記録された値（旧い採点器の指紋）
    const recorded = scoringFingerprint(old.ev, undefined, definitionsOf(old.ev));
    const runningSha = sha256(readFileSync(scoreFile));
    assert.notEqual(fileOf(recorded, "agent-accept/score-agent.mjs").sha256, runningSha, "偽物の checkout の採点器は旧い版");
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: STATIC_NG });
    conditions(out, ["P1-r1", "P1-r2"], { scoring: { fingerprint: recorded.fingerprint } });
    scoreRun(out, [], old.repo);
    const full = readScore(out);
    const fp = full.fingerprints;
    assert.equal(fp.scoring_matches_conditions, false, "旧い採点器の指紋を一致と出さない");
    assert.notEqual(fp.scoring.fingerprint, recorded.fingerprint);
    assert.equal(fp.scoring.fingerprint, scoringFingerprint(old.ev, scoreFile, definitionsOf(old.ev)).fingerprint, "定義とエンジンは <repo>、集計は実行中のファイル");
    assert.equal(fileOf(fp.scoring, "agent-accept/score-agent.mjs").sha256, runningSha);
    assert.equal(fp.scoring.aggregator.sha256, runningSha);
    assert.ok(fp.scoring.aggregator.path.endsWith("agent-accept/score-agent.mjs"), fp.scoring.aggregator.path);
    assert.notEqual(fp.scoring.aggregator.path, "workspace/mvp/m1/agent/eval/agent-accept/score-agent.mjs", "別の checkout なので <repo> の中のパスにならない");
    for (const f of ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "subjects/A.json", "definition:A"]) assert.equal(fileOf(fp.scoring, f).sha256, fileOf(recorded, f).sha256, f);
    assert.equal(fp.scoring.dir, "workspace/mvp/m1/agent/eval");
    assert.equal(fp.spec_engine.dist_dir, "packages/spec-engine/dist");
    assert.equal(fp.spec_engine.fingerprint, fingerprintDir(join(repo, "packages/spec-engine/dist")).fingerprint, "リンク先の dist と同じ指紋");
    // 採点そのものは <repo> の定義とエンジンで通る（v2 の分母はこの採点器のもの）
    assert.equal(rowOf(full, "P1-r1").verdict, "PASS");
    assert.deepEqual(rowOf(full, "P1-r2").fulfillment_v2, { fulfilled: 0, total: totalOf("A"), total_from: "definition:main" });
    // 同じ版の採点器を持つ checkout なら一致する
    const same = makeCheckout(base, "same-checkout", { sameAggregator: true });
    const out2 = join(base, "out2");
    addRun(out2, "P1-r1", { spec: PASS_A });
    conditions(out2, ["P1-r1"], { scoring: { fingerprint: scoringFingerprint(same.ev, undefined, definitionsOf(same.ev)).fingerprint } });
    scoreRun(out2, [], same.repo);
    assert.equal(readScore(out2).fingerprints.scoring_matches_conditions, true);
  });
});

test("匿名の出し方は、行ごとの失敗の鍵・要件の文・題材 ID を出さず、指標の数と区間だけを出す", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: FAIL_A });
    addRun(out, "P1-r3", { spec: NOROLE_A });
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    conditions(out, ["P1-r1", "P1-r2", "P1-r3", "P7-r1", "P7-r2", "P7-r3"]);
    const r = scoreRun(out, ["--label", "t", "--anonymous"]);
    assert.equal(existsSync(join(out, "score-t.json")), false, "行つきのファイルは書かない");
    const text = readFileSync(join(out, "score-t.anonymous.json"), "utf8");
    const a = JSON.parse(text);
    assert.equal(a.anonymous, true);
    assert.equal(a.runs, 4);
    assert.equal("rows" in a, false);
    assert.equal("bySubject" in a, false);
    const forbidden = ["P1-r1", "P1-r2", "P1-r3", "P7-r1", "P7-r2", "P7-r3", "役割が見つかる", ...reqsOf("A"), ...reqsOf("D"), ...CLAIM_D.unwritable.flatMap((u) => [u.text, ...u.unwritable])];
    for (const word of forbidden) { assert.ok(!text.includes(word), `ファイルに ${word}`); assert.ok(!r.stdout.includes(word), `標準出力に ${word}`); }
    const keys = []; const walk = (v) => { if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(a);
    for (const s of ["A", "B", "C", "D", "E"]) assert.ok(!keys.includes(s), `題材 ID ${s} が鍵に出ている`);
    startsWith(a.metrics.generated, "4/4（");
    startsWith(a.metrics.spec_pass_writable, "1/3（");
    assert.deepEqual(a.metrics.factory_verdicts, { full: 0, partial: 4, none: 0, unknown: 0 });
    startsWith(a.fulfillment.v2.all, `${2 * totalOf("A") - 1 + totalOf("D")}/${3 * totalOf("A") + totalOf("D")}（`);
    assert.deepEqual(a.completion, { status: "incomplete", label: "未完了", planned: 6, executed: 4, scored: 4, unexecuted: 2, incomplete: 0, extra: 0, unscored: 0, stop_code: null });
    assert.match(a.fingerprints.scoring, HEX64);
    assert.match(a.fingerprints.spec_engine, HEX64);
    assert.deepEqual(a.fingerprints.conditions, { schema: V2, signature: SIG, factory: null, spec_engine: null, scoring: null, judge: null, set: null, scripts: null });
    assert.deepEqual(JSON.parse(r.stdout), a, "標準出力も匿名の集計そのもの");
    // 既定の出し方は今のまま：行つきのファイルを書き、行を標準出力に出す
    const full = scoreRun(out, ["--label", "t"]);
    assert.equal(readScore(out, "score-t.json").rows.length, 4);
    assert.match(full.stdout, /P1-r2\tpartial\tFAIL\t/);
    assert.deepEqual(anonymize(readScore(out, "score-t.json")), a);
  });
});

test("匿名の出し方は、判定の値・止まった理由・条件のファイルの署名と指紋と schema と判定の口の構成に入った自由な文字列を通さない", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A, verdict: "MARK_VERDICT" });
    addRun(out, "P1-r2", { spec: FAIL_A });
    conditions(out, ["P1-r1", "P1-r2"], { measurement_id: "MARK_ID", signature: "MARK_SIG", factory: { fingerprint: "MARK_FACTORY" }, spec_engine: { fingerprint: "MARK_SE" }, scoring: { fingerprint: "MARK_SCORING" }, judge: { configuration: "MARK_JUDGE", jev_key_env: "MARK_ENV" } });
    writeFileSync(join(out, "run-1000.json"), JSON.stringify({ finished_at: "t", mode: "fresh", executed: ["P1-r1", "P1-r2"], pending: [], stop: "MARK_STOP", budget_usd: 1 }));
    const r = scoreRun(out, ["--anonymous"]);
    const text = readFileSync(join(out, "score.anonymous.json"), "utf8");
    assert.ok(!text.includes("MARK_"), `ファイルに目印が残る: ${text}`);
    assert.ok(!r.stdout.includes("MARK_"), "標準出力に目印が残る");
    const a = JSON.parse(text);
    assert.deepEqual(a.metrics.factory_verdicts, { full: 0, partial: 1, none: 0, unknown: 1 }, "既知でない判定の値は unknown にまとめる");
    assert.deepEqual(Object.keys(a.metrics), ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd", "factory_verdicts"]);
    assert.deepEqual(a.completion, { status: "complete", label: "完了", planned: 2, executed: 2, scored: 2, unexecuted: 0, incomplete: 0, extra: 0, unscored: 0, stop_code: "other" });
    assert.deepEqual(a.fingerprints.conditions, { schema: V2, signature: null, factory: null, spec_engine: null, scoring: null, judge: "unknown", set: null, scripts: null }, "ハッシュの形でない指紋は null、既知でない構成は unknown");
    assert.equal(a.fingerprints.scoring_matches_conditions, false);
    assert.equal(a.fingerprints.spec_engine_matches_conditions, false);
    // 行つきの出力（匿名でない）には入力の値がそのまま残る。止まった理由のコードと有効だった目安の額も読める
    scoreRun(out);
    const full = readScore(out);
    assert.equal(rowOf(full, "P1-r1").factory_verdict, "MARK_VERDICT");
    assert.deepEqual(full.completion.latest_record, { file: "run-1000.json", stop: "MARK_STOP", stop_code: "other", pending: [], budget_usd: 1 });
    assert.equal(full.fingerprints.conditions.signature, "MARK_SIG");
    // 予算で止まった記録はコード budget（stop_code の無い旧い記録でも文から読む）。目安の額の無い記録は null
    writeFileSync(join(out, "run-2000.json"), JSON.stringify({ stop: "予算 1 USD に達した", pending: [] }));
    assert.deepEqual(reconcile(out).latest_record, { file: "run-2000.json", stop: "予算 1 USD に達した", stop_code: "budget", pending: [], budget_usd: null });
    // 未知の schema は未照合のまま匿名でも unknown（値は出ない）
    const out2 = join(base, "out2");
    addRun(out2, "P1-r1", { spec: PASS_A });
    rawConditions(out2, { schema: "MARK_SCHEMA", child_args: [{ id: "P1-r1" }], params: { patterns: ["P1"], runs: 1 } });
    const r2 = scoreRun(out2, ["--anonymous"]);
    assert.ok(!r2.stdout.includes("MARK_"));
    const a2 = JSON.parse(r2.stdout);
    assert.equal(a2.completion.status, "unverified");
    assert.equal(a2.completion.label, "未照合");
    assert.equal(a2.fingerprints.conditions.schema, "unknown");
  });
});

// ── 了承後の採点（#426。README §5.5）。了承の記録（plan.json）は作り物で、要件の文は目印（MARK_）か定義から読んだ ID を使う（題材の言葉をここに書かない）。
// 正例の仕様は契約の検査（appspec-schema の checkConfirmedPlan）に通る固定の形：原文 1 件・質問 1 問・答え 1 件・解決済みの事項 1 件を持ち、確認の SHA は planDigest で計算する
const PLAN_INPUTS = [
  { id: "S:1", kind: "source", text: "MARK_SOURCE" },
  { id: "Q:1", kind: "question", open_issue_id: "OI:1", text: "MARK_Q", choices: [{ id: "C:1", text: "MARK_C1" }, { id: "C:2", text: "MARK_C2" }], recommended: { choice_id: "C:1", reason: "r" } },
  { id: "A:1", kind: "answer", question_id: "Q:1", choice_id: "C:1" },
];
const PLAN_ISSUES = [{ id: "OI:1", text: "MARK_OI", critical: false, status: "resolved", resolution: { answer_id: "A:1" } }];
/** 契約に通る確定した仕様。tamper は確認（SHA の計算）のあとに中身を変える（失効の負例） */
async function planFixture({ requirements = [], accepted = [], decisions = [], revision = 1, schema = PLAN_SPEC_SCHEMA, tamper = null } = {}) {
  const plan = { schema_version: schema, plan_id: "plan-t", revision, vocabulary_version: "v", inputs: PLAN_INPUTS, requirements, open_issues: PLAN_ISSUES, decisions, accepted_unwritable: accepted, confirmation: { sha256: "0".repeat(64), confirmed_at: "t", confirmed_by: "u" } };
  plan.confirmation = { ...plan.confirmation, sha256: await planDigest(plan) };
  if (tamper !== null) tamper(plan);
  return plan;
}
const req = (id, text, extra = {}) => ({ id, text, kind: "constraining", origin: { input_id: "S:1", quote: text }, parts: [], ...extra });
/** 代替先の要件。今の工場が accepted_removal と一緒に作る形（packages/factory の run-plan.ts：kind は existence・部分なし・change なし。ID は R:alt:…） */
const altReq = (id, text) => req(id, text, { kind: "existence" });
const change = (kind, from) => ({ kind, ...(from === undefined ? {} : { from_requirement_id: from }), answer_id: "A:1" });
const part = (id, text, disposition = "accepted_removal", alternative_id) => ({ id, text, disposition, ...(alternative_id === undefined ? {} : { alternative_id }) });
const basis = { doc_version: "v", location: "l", constraint_id: "c" };
const accept = (part_id, alternative_id) => ({ part_id, alternative_id, basis });
/** 未検証の有効な要件の件数（出どころごと）と、未検証の無い本の評価の状態 */
const zeroUnverified = (over = {}) => ({ total: 0, accepted_unwritable: 0, part: 0, changed: 0, added: 0, ...over });
const EVALUATED = { status: "evaluated", unverified: [], counts: zeroUnverified() };
/** 本に Plan の記録を足す（plan ＝ bundle/artifacts/plan.json。Promise か写像か文字列。record ＝ bundle/plan-record.json） */
async function addPlan(out, id, { plan = null, record = null } = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  const p = await plan;
  if (p !== null) writeFileSync(join(dir, "bundle/artifacts/plan.json"), typeof p === "string" ? p : JSON.stringify(p));
  if (record !== null) writeFileSync(join(dir, "bundle/plan-record.json"), JSON.stringify({ schema_version: "musunest-factory/plan-cli-record/v1", plan_id: "plan-t", rounds: [], spent_usd: 0.01, ...record }));
}
/** Plan を通した計測の条件のファイル（params.plan） */
const planConditions = (out, ids, extra = {}) => conditions(out, ids, { params: { ...paramsFor(ids), plan: true }, ...extra });
const structureIds = (s) => defOf(s).structures.map((st) => st.id);
const unwritableIdOf = (s, structureId) => defOf(s).structures.find((st) => st.id === structureId).unwritable[0].id;
const zeroCounts = (over = {}) => ({ expected: 0, allowed: 0, wrong: 0, unevaluated: 0, unmatched: 0, ambiguous: 0, ...over });
const UNEVALUATED_METRIC = (over = {}) => ({ status: "unevaluated", label: WRONG_ACCEPTANCE_EVALUATION.label, evidence: 0, unmatched: 0, ambiguous: 0, unevaluated: 0, ...over });

test("了承で形が変わった要件（了承して除いた書けない要件）：原文系は挙げ漏れで落とし、了承後系は了承済みとして挙げ漏れにしない。ただし代替先・追加の要件（判定の手段が無い）が 1 つでもあれば本は未評価で、除外だけの本は PASS になりうる。正例の仕様は契約の検査に通る", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [, ALT] = structureIds("D");
    const accepted = unwritableIdOf("D", ALT);
    const n = defOf("D").structures[1].checks.length;
    // P7-r1：別の構造で全部満たすが申告が無い。Plan で了承して除いた（accepted_removal。部分の文がその書けない要件に当たる）。
    // 今の工場が作る形：代替先の要件 R:alt:… を requirements に足し、accepted_unwritable[].alternative_id で指す（部分には alternative_id を書かない）
    const fixture = await planFixture({ requirements: [req("R1", "MARK_REQ", { parts: [part("P:1", accepted)] }), altReq("R:alt:1", "MARK_ALT")], accepted: [accept("P:1", "R:alt:1")], decisions: [{ id: "D1", subject: "s", value: "v", reason: "r" }] });
    assert.deepEqual(await checkConfirmedPlan(fixture), [], "正例の仕様は契約の検査に通る");
    addRun(out, "P7-r1", { spec: PASS_D });
    await addPlan(out, "P7-r1", { plan: fixture, record: { outcome: "confirmed", confirmation: "build" } });
    // P8-r1：同じ宣言。代わりの案（alternative）で了承した（部分の文が当たる。代替先は部分の alternative_id が指す）
    addRun(out, "P8-r1", { spec: PASS_D });
    await addPlan(out, "P8-r1", { plan: planFixture({ requirements: [req("R1", "MARK_REQ", { parts: [part("P:1", accepted, "alternative", "R:alt:1")] }), altReq("R:alt:1", "MARK_ALT")] }), record: { outcome: "confirmed" } });
    // P7-r2：同じ宣言を申告つきで（原文系も通る）。了承の記録に除外は無い
    addRun(out, "P7-r2", { spec: PASS_D, unwritable: CLAIM_D });
    await addPlan(out, "P7-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    // P7-r3：申告なし。除外だけ（代替先も追加も無い）：了承して除いた部分（記録なし・alternative_id なし）と、元の文が書けない要件に当たる removed の要件
    const exclusionsOnly = await planFixture({ requirements: [req("R1", "MARK_REQ", { parts: [part("P:1", accepted)] }), req("R9", accepted), req("R2", "MARK_REMOVED", { change: change("removed", "R9") })] });
    assert.deepEqual(await checkConfirmedPlan(exclusionsOnly), [], "記録の無い accepted_removal の部分は契約の検査に通る");
    addRun(out, "P7-r3", { spec: PASS_D });
    await addPlan(out, "P7-r3", { plan: exclusionsOnly, record: { outcome: "confirmed" } });
    // P7-r4：申告つき（挙げ漏れは無い）。追加の要件（added）だけがある
    addRun(out, "P7-r4", { spec: PASS_D, unwritable: CLAIM_D });
    await addPlan(out, "P7-r4", { plan: planFixture({ requirements: [req("R:A:1", "MARK_ADDED", { change: change("added") })] }), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2", "P7-r3", "P7-r4", "P8-r1"]);
    const r = scoreRun(out);
    const full = readScore(out);
    const a = rowOf(full, "P7-r1");
    assert.equal(a.verdict, "FAIL");
    assert.equal(a.claims.missed, 1);
    assert.equal(a.verdict_accepted, VERDICT_UNEVALUATED, "照合は expected でも、代替先を満たしたかは判定できないので PASS にしない");
    assert.deepEqual(a.claims_accepted, { structure: ALT, expected: [accepted], correct: 0, accepted: 1, optional: 0, missed: 0, verdict: "OK" }, "挙げ漏れの免除はそのまま");
    assert.equal(a.acceptance.status, "confirmed");
    assert.deepEqual(a.acceptance.reasons, []);
    assert.equal(a.acceptance.structure, ALT);
    assert.equal(a.acceptance.plan_outcome, "confirmed");
    assert.equal(a.acceptance.plan_id, "plan-t");
    assert.deepEqual(a.acceptance.exclusions, [{ id: "P:1", kind: "accepted_removal", scope: "part", matched: [{ kind: "unwritable", id: accepted }], judged: "expected" }], "処分の照合の結果はそのまま");
    assert.deepEqual(a.acceptance.changed, []);
    assert.deepEqual(a.acceptance.counts, { exclusions: zeroCounts({ expected: 1 }), changes: zeroCounts() });
    assert.deepEqual(a.acceptance.accepted_unwritable_ids, [accepted]);
    assert.deepEqual(a.acceptance.unevaluated_checks, []);
    assert.deepEqual(a.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R:alt:1", via: ["accepted_unwritable"] }], counts: zeroUnverified({ total: 1, accepted_unwritable: 1 }) }, "有効な要件の評価の状態は照合とは別に持つ");
    assert.deepEqual(a.acceptance.changes, { added: 0, changed: 0, removed: 0 });
    assert.equal(a.acceptance.decisions, 1);
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n, total: n, total_from: `structure:${ALT}`, unevaluated: [] }, "分子・分母は引かない");
    assert.deepEqual(a.fulfillment_v2, { fulfilled: n, total: n, total_from: `structure:${ALT}` }, "原文系の欄は変わらない");
    const b = rowOf(full, "P8-r1");
    assert.equal(b.verdict, "FAIL");
    assert.equal(b.verdict_accepted, VERDICT_UNEVALUATED);
    assert.deepEqual(b.acceptance.changed, [{ id: "P:1", kind: "alternative", scope: "part", matched: [{ kind: "unwritable", id: accepted }], judged: "expected" }]);
    assert.deepEqual(b.acceptance.exclusions, []);
    assert.deepEqual(b.acceptance.counts.changes, zeroCounts({ expected: 1 }));
    assert.deepEqual(b.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R:alt:1", via: ["part"] }], counts: zeroUnverified({ total: 1, part: 1 }) });
    assert.equal(b.claims_accepted.accepted, 1);
    const c = rowOf(full, "P7-r2");
    assert.equal(c.verdict, "PASS");
    assert.equal(c.verdict_accepted, "PASS");
    assert.equal(c.claims_accepted.correct, 1);
    assert.equal(c.claims_accepted.accepted, 0);
    assert.deepEqual(c.acceptance.effective, EVALUATED);
    const d = rowOf(full, "P7-r3");
    assert.equal(d.verdict, "FAIL");
    assert.equal(d.verdict_accepted, "PASS", "代替先も追加も無い除外だけの本は PASS になりうる");
    assert.deepEqual(d.acceptance.exclusions.map((x) => [x.id, x.judged]), [["P:1", "expected"], ["R2", "expected"]]);
    assert.deepEqual(d.acceptance.accepted_unwritable_ids, [accepted]);
    assert.deepEqual(d.acceptance.effective, EVALUATED);
    assert.deepEqual(d.acceptance.changes, { added: 0, changed: 0, removed: 1 });
    assert.equal(d.claims_accepted.accepted, 1);
    const e = rowOf(full, "P7-r4");
    assert.equal(e.verdict, "PASS");
    assert.equal(e.verdict_accepted, VERDICT_UNEVALUATED, "追加の要件を満たしたかは判定できない");
    assert.deepEqual(e.acceptance.exclusions, []);
    assert.deepEqual(e.acceptance.changed, []);
    assert.deepEqual(e.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R:A:1", via: ["added"] }], counts: zeroUnverified({ total: 1, added: 1 }) });
    // 集計：原文系の指標は従来どおり、了承後系は別の欄に並ぶ。誤った了承は 0 件ではなく「未評価」。未検証の有効な要件は件数と出どころ
    startsWith(full.metrics.missed_partial, "3/5（");
    startsWith(full.metrics.spec_pass_partial, "2/5（");
    startsWith(full.metrics_accepted.missed_partial, "0/5（");
    startsWith(full.metrics_accepted.spec_pass_partial, "2/5（");
    startsWith(full.metrics_accepted.unevaluated_runs, "3/5（");
    assert.equal(full.metrics_accepted.unevaluated_checks, 0);
    assert.equal(full.metrics_accepted.unverified_requirements, 3);
    assert.deepEqual(full.metrics_accepted.unverified_sources, { accepted_unwritable: 1, part: 1, changed: 0, added: 1 });
    startsWith(full.metrics_accepted.unverified_runs, "3/5（");
    assert.deepEqual([full.metrics_accepted.runs, full.metrics_accepted.confirmed, full.metrics_accepted.absent, full.metrics_accepted.invalid], [5, 5, 0, 0]);
    assert.deepEqual(full.metrics_accepted.absent_reasons, { plan_not_confirmed: 0, confirmed_without_plan: 0, unknown: 0 });
    assert.equal(full.metrics_accepted.decisions, 1);
    assert.deepEqual(full.metrics_accepted.changes, { added: 1, changed: 0, removed: 1 });
    assert.deepEqual(full.metrics_accepted.wrong_acceptances, UNEVALUATED_METRIC());
    assert.equal(full.metrics_accepted.wrong_acceptance_runs.status, "unevaluated");
    startsWith(full.metrics_accepted.wrong_acceptance_runs.evidence, "0/5（");
    startsWith(full.metrics_accepted.wrong_acceptance_runs.undecided, "0/5（");
    startsWith(full.metrics_accepted.wrong_exclusion_runs, "0/5（");
    startsWith(full.fulfillment.accepted.partial, `${5 * n}/${5 * n}（`);
    assert.equal(full.fulfillment.accepted.all, full.fulfillment.accepted.partial);
    assert.equal(full.fulfillment.v2.partial, full.fulfillment.accepted.partial, "未検証の要件があっても v2 の分子・分母は引かない");
    assert.deepEqual(full.fulfillment.accepted.unevaluated, { checks: 0, runs: 3 });
    assert.deepEqual(Object.keys(full.fulfillment), ["v1", "v2", "accepted"]);
    assert.equal(full.scoring_systems.source.startsWith("原文系"), true);
    assert.equal(full.scoring_systems.accepted.startsWith("了承後系"), true);
    assert.match(full.fingerprints.appspec_schema.fingerprint, HEX64, "契約の検査に使った dist の指紋");
    startsWith(full.bySubject.D.pass_accepted, "2/5（");
    startsWith(full.bySubject.D.pass, "2/5（");
    startsWith(full.bySubject.A.pass_accepted, "0/0（");
    assert.match(r.stdout, /了承後: 対象 5 本（確定 5・記録なし 0［未確定 0・確定後に仕様なし 0・不明 0］・読めない 0）・未評価の本 3・未検証の有効な要件 3 件（代替先 2・変更後 0・追加 1）・誤った除外 0 件（判定不能 0 件）・誤った了承 未評価（証拠 0 件・判定不能 0 件・書ける要件の変更 0 件）・充足 .*（未評価の判定 0）$/m);
    assert.match(r.stdout, /P7-r1\tpartial\tFAIL\t.*\t了承後=UNEVALUATED$/m);
    assert.match(r.stdout, /P7-r3\tpartial\tFAIL\t.*\t了承後=PASS$/m);
    assert.deepEqual(UNVERIFIED_SOURCES, ["accepted_unwritable", "part", "changed", "added"]);
  });
});

test("誤った除外と判定不能：部分の文だけで照合し、当たらない・複数に当たる処分は判定不能として数え、免除にも誤りにも使わない。誤った除外は分母から外さない。匿名の出力には件数と状態だけ", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [MAIN, ALT] = structureIds("D");
    const accepted = unwritableIdOf("D", ALT);
    const otherStructureUnwritable = unwritableIdOf("D", MAIN); // 当てはまった構造（別の構造）では書ける
    const allowedText = DEFAULT_ALLOWED[1].id;
    const n = defOf("D").structures[1].checks.length;
    // P7-r1（申告つき）：他の構造の書けない要件に当たる部分（誤った除外）・何にも当たらない部分（判定不能）・許される申告・満たす部分、元の要件が何にも当たらない removed（判定不能）。
    // 代替先も追加も無い（記録なしの accepted_removal）ので、有効な要件は評価できる
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    await addPlan(out, "P7-r1", { plan: planFixture({
      requirements: [
        req("R1", "MARK_R1", { parts: [part("P:other", otherStructureUnwritable), part("P:none", "MARK_NONE"), part("P:allowed", allowedText), part("P:met", "MARK_MET", "met")] }),
        req("R9", "MARK_ORIGINAL"), req("R2", "MARK_REMOVED", { change: change("removed", "R9") }),
      ],
    }), record: { outcome: "confirmed" } });
    // P7-r2（申告なし）：同じ親に書けない部分（満たす）と書ける部分（除外）がある。親の文は書けない要件の語そのもの。部分の文だけで照合するので免除にならない
    addRun(out, "P7-r2", { spec: PASS_D });
    await addPlan(out, "P7-r2", { plan: planFixture({ requirements: [req("R1", accepted, { parts: [part("P:u", accepted, "met"), part("P:w", "MARK_W")] }), req("R:alt:w", "MARK_ALT_W")], accepted: [accept("P:w", "R:alt:w")] }), record: { outcome: "confirmed" } });
    // P7-r3（申告なし）：代替先の要件にだけ鍵がある alternative。部分の文は当たらないので判定不能（免除にならず、本は未評価）
    addRun(out, "P7-r3", { spec: PASS_D });
    await addPlan(out, "P7-r3", { plan: planFixture({ requirements: [req("R1", "MARK_R1", { parts: [part("P:a", "MARK_ALT_PART", "alternative", "R:alt")] }), req("R:alt", accepted)] }), record: { outcome: "confirmed" } });
    // P7-r4（申告つき）：2 つの対象に当たる部分（判定不能。代替先つき）、書けない要件と他の構造の書けない要件を含む要件の除外（誤った除外）、書けない要件だけを含む要件の除外（正しい了承）、added
    addRun(out, "P7-r4", { spec: PASS_D, unwritable: CLAIM_D });
    await addPlan(out, "P7-r4", { plan: planFixture({
      requirements: [
        req("R1", "MARK_R1", { parts: [part("P:amb", `${accepted} ${allowedText}`)] }), altReq("R:alt:amb", "MARK_ALT_AMB"),
        req("R5", `${accepted} ${otherStructureUnwritable}`), req("R6", "MARK_R6", { change: change("removed", "R5") }),
        req("R7", accepted), req("R8", "MARK_R8", { change: change("removed", "R7") }),
        req("R3", "MARK_ADDED", { change: change("added") }),
      ],
      accepted: [accept("P:amb", "R:alt:amb")],
    }), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2", "P7-r3", "P7-r4"]);
    const r = scoreRun(out);
    const full = readScore(out);
    const a = rowOf(full, "P7-r1");
    assert.equal(a.verdict, "PASS");
    assert.equal(a.verdict_accepted, "PASS", "誤った除外・判定不能の除外は判定を変えず、別に数える");
    assert.deepEqual(a.acceptance.exclusions, [
      { id: "P:other", kind: "accepted_removal", scope: "part", matched: [{ kind: "other_unwritable", id: `${MAIN}:${otherStructureUnwritable}` }], judged: "wrong" },
      { id: "P:none", kind: "accepted_removal", scope: "part", matched: [], judged: "unmatched" },
      { id: "P:allowed", kind: "accepted_removal", scope: "part", matched: [{ kind: "allowed", id: allowedText }], judged: "allowed" },
      { id: "R2", kind: "removed", scope: "requirement", matched: [], judged: "unmatched" },
    ]);
    assert.deepEqual(a.acceptance.changed, []);
    assert.deepEqual(a.acceptance.counts, { exclusions: zeroCounts({ allowed: 1, wrong: 1, unmatched: 2 }), changes: zeroCounts() });
    assert.equal(a.acceptance.allowed, 1);
    assert.deepEqual(a.acceptance.changes, { added: 0, changed: 0, removed: 1 });
    assert.deepEqual(a.acceptance.accepted_unwritable_ids, []);
    assert.deepEqual(a.acceptance.effective, EVALUATED);
    assert.equal(a.claims_accepted.correct, 1);
    assert.equal(a.claims_accepted.accepted, 0);
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n, total: n, total_from: `structure:${ALT}`, unevaluated: [] }, "誤った除外は分母から外さない");
    const b = rowOf(full, "P7-r2");
    assert.deepEqual(b.acceptance.exclusions, [{ id: "P:w", kind: "accepted_removal", scope: "part", matched: [], judged: "unmatched" }], "親の文の語では当てない");
    assert.deepEqual(b.acceptance.accepted_unwritable_ids, []);
    assert.deepEqual(b.acceptance.effective.unverified, [{ id: "R:alt:w", via: ["accepted_unwritable"] }]);
    assert.equal(b.claims_accepted.missed, 1, "判定不能の除外は挙げ漏れの免除の根拠にしない");
    assert.equal(b.verdict_accepted, "FAIL", "未検証の代替先があっても、挙げ漏れは隠さない");
    const c = rowOf(full, "P7-r3");
    assert.deepEqual(c.acceptance.changed, [{ id: "P:a", kind: "alternative", scope: "part", matched: [], judged: "unmatched" }], "代替先の文では当てない");
    assert.deepEqual(c.acceptance.accepted_unwritable_ids, []);
    assert.deepEqual(c.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R:alt", via: ["part"] }], counts: zeroUnverified({ total: 1, part: 1 }) });
    assert.equal(c.claims_accepted.missed, 1);
    assert.equal(c.verdict_accepted, VERDICT_UNEVALUATED, "判定不能の変更がある本は PASS にしない");
    assert.deepEqual(c.fulfillment_accepted, { fulfilled: n, total: n, total_from: `structure:${ALT}`, unevaluated: [] });
    const d = rowOf(full, "P7-r4");
    assert.deepEqual(d.acceptance.exclusions, [
      { id: "P:amb", kind: "accepted_removal", scope: "part", matched: [{ kind: "unwritable", id: accepted }, { kind: "allowed", id: allowedText }], judged: "ambiguous" },
      { id: "R6", kind: "removed", scope: "requirement", matched: [{ kind: "unwritable", id: accepted }, { kind: "other_unwritable", id: `${MAIN}:${otherStructureUnwritable}` }], judged: "wrong" },
      { id: "R8", kind: "removed", scope: "requirement", matched: [{ kind: "unwritable", id: accepted }], judged: "expected" },
    ]);
    assert.deepEqual(d.acceptance.counts.exclusions, zeroCounts({ expected: 1, wrong: 1, ambiguous: 1 }));
    assert.deepEqual(d.acceptance.accepted_unwritable_ids, [accepted], "要件全体の除外は含まれる対象を全部点検し、書けない要件だけなら正しい了承");
    assert.deepEqual(d.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R3", via: ["added"] }, { id: "R:alt:amb", via: ["accepted_unwritable"] }], counts: zeroUnverified({ total: 2, accepted_unwritable: 1, added: 1 }) });
    assert.equal(d.verdict_accepted, VERDICT_UNEVALUATED, "正しい了承があっても、代替先・追加の要件が未検証なら PASS にしない");
    // 集計
    const ma = full.metrics_accepted;
    assert.deepEqual([ma.runs, ma.confirmed], [4, 4]);
    startsWith(ma.wrong_exclusion_runs, "2/4（");
    startsWith(ma.undecided_exclusion_runs, "3/4（");
    assert.equal(ma.wrong_exclusions, 2);
    assert.equal(ma.undecided_exclusions, 4);
    assert.deepEqual(ma.wrong_acceptances, UNEVALUATED_METRIC({ unmatched: 1 }));
    startsWith(ma.wrong_acceptance_runs.evidence, "0/4（");
    startsWith(ma.wrong_acceptance_runs.undecided, "1/4（");
    assert.equal(ma.wrong_acceptance_runs.status, "unevaluated");
    startsWith(ma.unevaluated_runs, "2/4（");
    assert.equal(ma.unevaluated_checks, 0);
    assert.equal(ma.unverified_requirements, 4);
    assert.deepEqual(ma.unverified_sources, { accepted_unwritable: 2, part: 1, changed: 0, added: 1 });
    startsWith(ma.unverified_runs, "3/4（");
    assert.deepEqual(ma.changes, { added: 1, changed: 0, removed: 3 });
    startsWith(ma.spec_pass_partial, "1/4（");
    assert.deepEqual(full.fulfillment.accepted.unevaluated, { checks: 0, runs: 2 });
    assert.equal(full.fulfillment.accepted.partial, full.fulfillment.v2.partial);
    assert.match(r.stdout, /未評価の本 2・未検証の有効な要件 4 件（代替先 3・変更後 0・追加 1）・誤った除外 2 件（判定不能 4 件）・誤った了承 未評価（証拠 0 件・判定不能 1 件・書ける要件の変更 0 件）/);
    assert.match(r.stdout, /P7-r3\tpartial\tFAIL\t.*\t了承後=UNEVALUATED$/m);
    assert.match(r.stdout, /P7-r1\tpartial\tPASS\t.*\t了承後=PASS$/m);
    // 匿名の出し方：件数・区間・既知の状態だけ。部分の ID・要件の文・当たった先・代替先の ID・説明の文は出ない
    scoreRun(out, ["--anonymous"]);
    const text = readFileSync(join(out, "score.anonymous.json"), "utf8");
    for (const w of ["MARK_", "P:other", "P:none", "P:amb", "R:alt", "R3", "plan-t", otherStructureUnwritable, allowedText, accepted, "対応データ"]) assert.ok(!text.includes(w), `匿名の出力に ${w}`);
    const an = JSON.parse(text);
    assert.equal(an.metrics_accepted.wrong_exclusions, 2);
    assert.equal(an.metrics_accepted.undecided_exclusions, 4);
    assert.equal(an.metrics_accepted.runs, 4);
    startsWith(an.metrics_accepted.wrong_exclusion_runs, "2/4（");
    assert.deepEqual(an.metrics_accepted.wrong_acceptances, { status: "unevaluated", evidence: 0, unmatched: 1, ambiguous: 0, unevaluated: 0 }, "誤った了承は匿名でも未評価のまま（0 件に丸めない）");
    assert.deepEqual(an.metrics_accepted.wrong_acceptance_runs, { status: "unevaluated", evidence: ma.wrong_acceptance_runs.evidence, undecided: ma.wrong_acceptance_runs.undecided });
    assert.equal(an.metrics_accepted.unverified_requirements, 4, "未検証の有効な要件は匿名でも数だけ残る");
    assert.deepEqual(an.metrics_accepted.unverified_sources, { accepted_unwritable: 2, part: 1, changed: 0, added: 1 });
    assert.equal(an.metrics_accepted.unverified_runs, ma.unverified_runs);
    startsWith(an.metrics_accepted.unevaluated_runs, "2/4（");
    assert.deepEqual(an.metrics_accepted.changes, { added: 1, changed: 0, removed: 3 });
    assert.deepEqual(an.fulfillment.accepted.unevaluated, { checks: 0, runs: 2 });
    assert.equal(an.fulfillment.accepted.all, full.fulfillment.accepted.all);
    assert.match(an.fingerprints.appspec_schema, HEX64);
    assert.deepEqual(an, anonymize(full));
    // 判定の表（README §5.5.2）
    const U = { kind: "unwritable", id: "u" }, AL = { kind: "allowed", id: "a" }, CK = { kind: "check", id: "c" }, OU = { kind: "other_unwritable", id: "o" };
    assert.equal(judgeDisposition([], "part", "exclusion"), "unmatched");
    assert.equal(judgeDisposition([U, AL], "part", "exclusion"), "ambiguous");
    assert.equal(judgeDisposition([U, AL], "requirement", "exclusion"), "expected");
    assert.equal(judgeDisposition([U], "part", "change"), "expected");
    assert.equal(judgeDisposition([AL], "part", "change"), "allowed");
    assert.equal(judgeDisposition([CK], "part", "exclusion"), "wrong");
    assert.equal(judgeDisposition([CK], "part", "change"), "unevaluated");
    assert.equal(judgeDisposition([U, CK], "requirement", "change"), "unevaluated");
    assert.equal(judgeDisposition([OU], "part", "change"), "wrong");
    assert.equal(judgeDisposition([U, OU], "requirement", "change"), "wrong");
    assert.deepEqual(JUDGEMENTS, ["expected", "allowed", "wrong", "unevaluated", "unmatched", "ambiguous"]);
    // 部分の無い accepted_unwritable の記録は、契約の検査が落とすので確定した本には現れないが、readAcceptance 単体では誤った除外に数える
    const m = acceptanceMatcher(defOf("D"), ALT, DEFAULT_ALLOWED);
    const orphan = readAcceptance({ requirements: [], accepted_unwritable: [{ part_id: "P:x" }], decisions: [] }, m);
    assert.deepEqual(orphan.exclusions, [{ id: "P:x", kind: "accepted_unwritable", scope: "record", matched: [], judged: "wrong" }]);
    assert.equal(orphan.counts.exclusions.wrong, 1);
    assert.deepEqual(orphan.effective, EVALUATED, "代替先の ID が無ければ未検証の要件は無い");
    // 代替先が requirements に無い記録（契約の検査が落とす）・同じ要件を 2 つの出どころが指す・変更後の要件は、readAcceptance 単体では未検証として数える（要件 ID で 1 件）
    const dangling = readAcceptance({ requirements: [req("R1", "MARK_R1", { parts: [part("P:x", "MARK_X", "alternative", "R:missing")] }), req("R1b", "MARK_NEW", { change: change("changed", "R1") })], accepted_unwritable: [{ part_id: "P:x", alternative_id: "R:missing" }], decisions: [] }, m);
    assert.deepEqual(dangling.effective, { status: "unevaluated", unverified: [{ id: "R:missing", via: ["part", "accepted_unwritable"] }, { id: "R1b", via: ["changed"] }], counts: zeroUnverified({ total: 2, accepted_unwritable: 1, part: 1, changed: 1 }) });
  });
});

test("了承の記録が無い本・読めない本：Plan を通した計測では充足 0 で分母に残り（記録なしは理由の内訳つき。契約の検査に落ちる仕様は読めない）、Plan を通していない計測では対象外（null）", async () => {
  await withOut(async (base) => {
    const n = totalOf("A");
    const out = join(base, "plan");
    // 記録なし：Plan が確定しなかった（stopped・cannot-confirm）／往復の記録が無い・結果が未知／Plan は確定したが納品物に仕様が無い（宣言も無い。観測された組合せ）
    addRun(out, "P1-r1", { spec: PASS_A });
    await addPlan(out, "P1-r1", { record: { outcome: "stopped", confirmation: null } });
    addRun(out, "P1-r2", { spec: PASS_A });
    addRun(out, "P1-r6");
    await addPlan(out, "P1-r6", { record: { outcome: "cannot-confirm" } });
    addRun(out, "P1-r7");
    await addPlan(out, "P1-r7", { record: { outcome: "confirmed" } });
    addRun(out, "P1-r11", { spec: PASS_A });
    await addPlan(out, "P1-r11", { record: { outcome: "MARK_OUTCOME" } });
    // 読めない：JSON でない／版が未知／確認のあとに中身が変わった（失効）／参照の不整合／了承の範囲の外
    addRun(out, "P1-r3", { spec: PASS_A });
    await addPlan(out, "P1-r3", { plan: "{ これは JSON でない" });
    addRun(out, "P1-r4", { spec: PASS_A });
    await addPlan(out, "P1-r4", { plan: planFixture({ schema: "MARK_SCHEMA" }) });
    addRun(out, "P1-r8", { spec: PASS_A });
    await addPlan(out, "P1-r8", { plan: planFixture({ tamper: (p) => { p.revision += 1; } }), record: { outcome: "confirmed" } });
    addRun(out, "P1-r9", { spec: PASS_A });
    await addPlan(out, "P1-r9", { plan: planFixture({ requirements: [{ ...req("R1", "MARK_R1"), origin: { input_id: "MARK_MISSING", quote: "q" } }] }), record: { outcome: "confirmed" } });
    addRun(out, "P1-r10", { spec: PASS_A });
    await addPlan(out, "P1-r10", { plan: planFixture({ requirements: [req("R1", "MARK_R1")], accepted: [accept("P:orphan", "R1")] }), record: { outcome: "confirmed" } });
    // 確定した本
    addRun(out, "P1-r5", { spec: PASS_A });
    await addPlan(out, "P1-r5", { plan: planFixture(), record: { outcome: "confirmed" } });
    const ids = ["P1-r1", "P1-r2", "P1-r3", "P1-r4", "P1-r5", "P1-r6", "P1-r7", "P1-r8", "P1-r9", "P1-r10", "P1-r11"];
    planConditions(out, ids);
    const r = scoreRun(out);
    const full = readScore(out);
    const zero = { fulfilled: 0, total: n, total_from: "definition:main", unevaluated: [] };
    const a1 = rowOf(full, "P1-r1");
    assert.equal(a1.verdict, "PASS", "原文系は通る");
    assert.deepEqual(a1.acceptance, { status: "absent", reasons: [], plan_outcome: "stopped", absent_reason: "plan_not_confirmed" });
    assert.equal(a1.verdict_accepted, null);
    assert.equal(a1.claims_accepted, null);
    assert.deepEqual(a1.fulfillment_accepted, zero);
    assert.deepEqual(rowOf(full, "P1-r2").acceptance, { status: "absent", reasons: [], plan_outcome: null, absent_reason: "unknown" });
    const a6 = rowOf(full, "P1-r6");
    assert.equal(a6.generation_failed, true);
    assert.deepEqual(a6.acceptance, { status: "absent", reasons: [], plan_outcome: "cannot-confirm", absent_reason: "plan_not_confirmed" });
    assert.deepEqual(a6.fulfillment_accepted, zero);
    const a7 = rowOf(full, "P1-r7");
    assert.equal(a7.generation_failed, true);
    assert.deepEqual(a7.acceptance, { status: "absent", reasons: [], plan_outcome: "confirmed", absent_reason: "confirmed_without_plan" }, "Plan 確定・仕様なし・宣言なしは「確定後に仕様なし」（Build の段階は断定しない）");
    assert.deepEqual(a7.fulfillment_accepted, zero);
    assert.deepEqual(rowOf(full, "P1-r11").acceptance, { status: "absent", reasons: [], plan_outcome: "MARK_OUTCOME", absent_reason: "unknown" }, "未知の結果は不明");
    const a3 = rowOf(full, "P1-r3");
    assert.equal(a3.acceptance.status, "invalid");
    assert.deepEqual(a3.acceptance.reasons, ["plan.json を読めない"]);
    assert.deepEqual(a3.fulfillment_accepted, zero);
    const a4 = rowOf(full, "P1-r4");
    assert.equal(a4.acceptance.status, "invalid");
    assert.deepEqual(a4.acceptance.reasons, ["schema_version が未知"]);
    const a8 = rowOf(full, "P1-r8");
    assert.equal(a8.acceptance.status, "invalid");
    assert.deepEqual(a8.acceptance.reasons, ["契約の検査: confirmation_expired (confirmation.sha256)"], "確認のあとに中身が変わった仕様は失効");
    assert.equal(a8.verdict_accepted, null);
    assert.deepEqual(a8.fulfillment_accepted, zero);
    const a9 = rowOf(full, "P1-r9");
    assert.equal(a9.acceptance.status, "invalid");
    assert.deepEqual(a9.acceptance.reasons, ["契約の検査: unknown_reference (requirements[0].origin.input_id)"]);
    const a10 = rowOf(full, "P1-r10");
    assert.equal(a10.acceptance.status, "invalid");
    assert.deepEqual(a10.acceptance.reasons, ["契約の検査: accepted_outside_parts (accepted_unwritable[0].part_id)"]);
    for (const id of ["P1-r4", "P1-r9", "P1-r10"]) assert.ok(!JSON.stringify(rowOf(full, id).acceptance).includes("MARK_"), `${id}: 理由に入力の値を出さない`);
    const a5 = rowOf(full, "P1-r5");
    assert.equal(a5.acceptance.status, "confirmed");
    assert.equal(a5.verdict_accepted, "PASS");
    assert.deepEqual(a5.acceptance.effective, EVALUATED);
    assert.deepEqual(a5.fulfillment_accepted, { fulfilled: n, total: n, total_from: "structure:main", unevaluated: [] });
    const ma = full.metrics_accepted;
    assert.deepEqual([ma.runs, ma.confirmed, ma.absent, ma.invalid], [11, 1, 5, 5]);
    assert.deepEqual(ma.absent_reasons, { plan_not_confirmed: 2, confirmed_without_plan: 1, unknown: 2 });
    startsWith(ma.spec_pass_writable, "1/11（");
    startsWith(full.metrics.spec_pass_writable, "9/11（");
    startsWith(full.fulfillment.accepted.writable, `${n}/${11 * n}（`);
    startsWith(full.fulfillment.v2.writable, `${9 * n}/${11 * n}（`);
    assert.match(r.stdout, /了承後: 対象 11 本（確定 1・記録なし 5［未確定 2・確定後に仕様なし 1・不明 2］・読めない 5）/);
    // 匿名の集計でも理由の内訳は数だけ
    scoreRun(out, ["--anonymous"]);
    const an = readScore(out, "score.anonymous.json");
    assert.deepEqual(an.metrics_accepted.absent_reasons, { plan_not_confirmed: 2, confirmed_without_plan: 1, unknown: 2 });
    assert.ok(!JSON.stringify(an).includes("MARK_"));
    // Plan を通していない計測：記録の無い本は対象外（null）。記録のある本だけが対象
    const out2 = join(base, "noplan");
    addRun(out2, "P1-r1", { spec: PASS_A });
    addRun(out2, "P1-r2", { spec: PASS_A });
    await addPlan(out2, "P1-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    addRun(out2, "P1-r3", { spec: PASS_A });
    await addPlan(out2, "P1-r3", { record: { outcome: "stopped" } });
    conditions(out2, ["P1-r1", "P1-r2", "P1-r3"]);
    const r2 = scoreRun(out2);
    const full2 = readScore(out2);
    const b1 = rowOf(full2, "P1-r1");
    assert.deepEqual(b1.acceptance, { status: "none" });
    assert.equal(b1.fulfillment_accepted, null);
    assert.equal(b1.claims_accepted, null);
    assert.equal(b1.verdict_accepted, null);
    assert.equal(b1.verdict, "PASS");
    assert.equal(rowOf(full2, "P1-r2").acceptance.status, "confirmed");
    assert.equal(rowOf(full2, "P1-r3").acceptance.status, "absent");
    assert.deepEqual([full2.metrics_accepted.runs, full2.metrics_accepted.confirmed, full2.metrics_accepted.absent], [2, 1, 1]);
    startsWith(full2.fulfillment.accepted.all, `${n}/${2 * n}（`);
    startsWith(full2.fulfillment.v2.all, `${3 * n}/${3 * n}（`);
    startsWith(full2.bySubject.A.pass_accepted, "1/2（");
    assert.match(r2.stdout, /P1-r1\tpartial\tPASS\t.*\t了承後=-$/m);
    // 条件のファイルの無い出力先（#401 より前。Plan なし・記録なし）：対象 0 本。匿名でも 0/0
    const out3 = join(base, "old");
    addRun(out3, "P1-r1", { spec: PASS_A });
    scoreRun(out3, ["--anonymous"]);
    const a3n = readScore(out3, "score.anonymous.json");
    assert.equal(a3n.metrics_accepted.runs, 0);
    startsWith(a3n.fulfillment.accepted.all, "0/0（");
    assert.deepEqual(a3n.metrics_accepted.wrong_acceptances, { status: "unevaluated", evidence: 0, unmatched: 0, ambiguous: 0, unevaluated: 0 });
    assert.deepEqual(ACCEPTANCE_STATUSES, ["confirmed", "invalid", "absent", "none"]);
    assert.deepEqual(ABSENT_REASONS, ["plan_not_confirmed", "confirmed_without_plan", "unknown"]);
    assert.deepEqual(validatePlanShape({ schema_version: PLAN_SPEC_SCHEMA, requirements: [{ id: "R", text: "t" }], accepted_unwritable: [], decisions: [] }), ["requirements の形が違う（id・text・parts）"]);
    assert.deepEqual(validatePlanShape({ schema_version: PLAN_SPEC_SCHEMA, requirements: [], accepted_unwritable: [], decisions: [] }), []);
    assert.deepEqual(validatePlanShape([]), ["plan.json が写像でない"]);
    // loadPlan は契約の検査を渡したときだけ失効を落とす（形だけなら読める）
    assert.equal((await loadPlan(join(out, "P1-r8"))).status, "confirmed");
    assert.equal((await loadPlan(join(out, "P1-r8"), checkConfirmedPlan)).status, "invalid");
    assert.equal((await loadPlan(join(out, "P1-r2"), checkConfirmedPlan)).status, "absent");
  });
});

test("生成に失敗した本・静的 NG の本は、了承の記録があっても両系の分母に充足 0 で残る", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [MAIN, ALT] = structureIds("D");
    const n = totalOf("D"), nAlt = defOf("D").structures[1].checks.length;
    const accepted = unwritableIdOf("D", ALT);
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    await addPlan(out, "P7-r1", { plan: planFixture(), record: { outcome: "confirmed" } });
    // Plan は確定した（了承して除いた部分つき）が、生成に失敗した
    addRun(out, "P7-r2");
    await addPlan(out, "P7-r2", { plan: planFixture({ requirements: [req("R1", "MARK_R1", { parts: [part("P:1", accepted)] }), req("R:alt:1", "MARK_ALT")], accepted: [accept("P:1", "R:alt:1")] }), record: { outcome: "confirmed" } });
    addRun(out, "P7-r3", { spec: STATIC_NG });
    await addPlan(out, "P7-r3", { plan: planFixture(), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2", "P7-r3"]);
    scoreRun(out);
    const full = readScore(out);
    const f = rowOf(full, "P7-r2");
    assert.equal(f.generation_failed, true);
    assert.equal(f.acceptance.status, "confirmed", "生成に失敗しても了承の記録は読む");
    assert.equal(f.acceptance.structure, MAIN, "構造が当てはまらないので主の構造の鍵で照合する");
    assert.deepEqual(f.acceptance.exclusions[0].matched, [{ kind: "other_unwritable", id: `${ALT}:${accepted}` }]);
    assert.equal(f.acceptance.exclusions[0].judged, "wrong");
    assert.deepEqual(f.acceptance.effective.counts, zeroUnverified({ total: 1, accepted_unwritable: 1 }), "生成に失敗した本でも未検証の代替先は数える（判定は null のまま）");
    assert.deepEqual(f.fulfillment_accepted, { fulfilled: 0, total: n, total_from: `definition:${MAIN}`, unevaluated: [] });
    assert.deepEqual(f.fulfillment_v2, { fulfilled: 0, total: n, total_from: `definition:${MAIN}` });
    assert.equal(f.claims_accepted, null);
    assert.equal(f.verdict_accepted, null);
    const s = rowOf(full, "P7-r3");
    assert.equal(s.spec_verdict, "STATIC_NG");
    assert.equal(s.verdict_accepted, "STATIC_NG");
    assert.equal(s.claims_accepted.structure, MAIN);
    assert.deepEqual(s.fulfillment_accepted, { fulfilled: 0, total: n, total_from: `definition:${MAIN}`, unevaluated: [] });
    startsWith(full.fulfillment.v2.partial, `${nAlt}/${nAlt + 2 * n}（`);
    assert.equal(full.fulfillment.accepted.partial, full.fulfillment.v2.partial);
    startsWith(full.fulfillment.v1.partial, `${nAlt}/${nAlt}（`, "補正前は分母から落ちる（従来どおり）");
    startsWith(full.metrics.missed_partial, "2/3（");
    startsWith(full.metrics_accepted.missed_partial, "2/3（");
    startsWith(full.metrics_accepted.spec_pass_partial, "1/3（");
    assert.deepEqual([full.metrics_accepted.runs, full.metrics_accepted.confirmed], [3, 3]);
    assert.equal(full.metrics_accepted.wrong_exclusions, 1);
    startsWith(full.metrics_accepted.wrong_exclusion_runs, "1/3（");
    assert.equal(full.metrics_accepted.unverified_requirements, 1);
    startsWith(full.metrics_accepted.unverified_runs, "1/3（");
    startsWith(full.metrics_accepted.unevaluated_runs, "0/3（", "判定の無い本（生成失敗）は未評価の本に数えない");
  });
});

test("了承で変わった書ける要件（checks に keys を持つ定義）：変更が当てた判定は未評価として分母からも分子からも外さず、本は PASS にしない。除外は誤った除外として分母に残す", async () => {
  await withOut(async (base) => {
    // v5 の定義には checks[].keys が無い。将来の定義を装って、写しの定義の判定 1 つに鍵（要件の名前そのもの）を足す
    const fake = makeCheckout(base, "keyed-checkout", { sameAggregator: true });
    const defPath = join(fake.ev, "subjects/A.json");
    const def = JSON.parse(readFileSync(defPath, "utf8"));
    const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const target = def.structures[0].checks[1];
    target.keys = [escape(target.req)];
    writeFileSync(defPath, JSON.stringify(def));
    const n = def.structures[0].checks.length;
    const m = acceptanceMatcher(def, "main", DEFAULT_ALLOWED);
    assert.deepEqual(m.match(`MARK ${target.req}`), [{ kind: "check", id: target.req }]);
    assert.deepEqual(m.match(DEFAULT_ALLOWED[0].id), [{ kind: "allowed", id: DEFAULT_ALLOWED[0].id }]);
    assert.deepEqual(m.match(`${target.req} ${DEFAULT_ALLOWED[0].id}`), [{ kind: "allowed", id: DEFAULT_ALLOWED[0].id }, { kind: "check", id: target.req }], "当たった先を全部返す");
    assert.deepEqual(m.match("MARK_NOTHING"), []);
    assert.equal(acceptanceMatcher(def, "MARK_UNKNOWN_STRUCTURE").structure, "main", "構造が無ければ主の構造");
    const out = join(base, "out");
    // P1-r1（全部満たす）：原文が固定していた要件を、答えで別の形に変えた（changed。元の要件の文が書ける要件に当たる）
    addRun(out, "P1-r1", { spec: PASS_A });
    await addPlan(out, "P1-r1", { plan: planFixture({ requirements: [req("R1", target.req), req("R1b", "MARK_NEW", { change: change("changed", "R1") })] }), record: { outcome: "confirmed" } });
    // P1-r2（1 つ落とす）：同じ要件を了承して除いた（誤った除外。分母から外さない）
    addRun(out, "P1-r2", { spec: FAIL_A });
    await addPlan(out, "P1-r2", { plan: planFixture({ requirements: [req("R1", "MARK_R1", { parts: [part("P:1", target.req)] }), req("R:alt", "MARK_ALT")], accepted: [accept("P:1", "R:alt")] }), record: { outcome: "confirmed" } });
    // P1-r3（1 つ落とす）：落ちたのとは別の判定を変更した。未評価の判定の外に落ちがあるので FAIL（落ちを隠さない）
    addRun(out, "P1-r3", { spec: FAIL_A });
    await addPlan(out, "P1-r3", { plan: planFixture({ requirements: [req("R1", target.req), req("R1b", "MARK_NEW", { change: change("changed", "R1") })] }), record: { outcome: "confirmed" } });
    // P1-r4（全部満たす）：変更後の文だけが書ける要件に当たる（元の要件は当たらない）→ 変更後の文は使わないので判定不能
    addRun(out, "P1-r4", { spec: PASS_A });
    await addPlan(out, "P1-r4", { plan: planFixture({ requirements: [req("R1", "MARK_OLD"), req("R1b", target.req, { change: change("changed", "R1") })] }), record: { outcome: "confirmed" } });
    planConditions(out, ["P1-r1", "P1-r2", "P1-r3", "P1-r4"]);
    scoreRun(out, [], fake.repo);
    const full = readScore(out);
    const a = rowOf(full, "P1-r1");
    assert.equal(a.verdict, "PASS");
    assert.deepEqual(a.acceptance.changed, [{ id: "R1b", kind: "changed", scope: "requirement", matched: [{ kind: "check", id: target.req }], judged: "unevaluated" }]);
    assert.deepEqual(a.acceptance.unevaluated_checks, [target.req]);
    assert.deepEqual(a.acceptance.counts.changes, zeroCounts({ unevaluated: 1 }));
    assert.deepEqual(a.acceptance.effective, { status: "unevaluated", unverified: [{ id: "R1b", via: ["changed"] }], counts: zeroUnverified({ total: 1, changed: 1 }) }, "変更後の要件は未検証");
    assert.deepEqual(a.acceptance.changes, { added: 0, changed: 1, removed: 0 });
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n, total: n, total_from: "structure:main", unevaluated: [target.req] }, "変更が当てた判定は分母からも分子からも外さない");
    assert.deepEqual(a.fulfillment_v2, { fulfilled: n, total: n, total_from: "structure:main" }, "原文系は従来どおり判定する");
    assert.equal(a.verdict_accepted, VERDICT_UNEVALUATED, "変更後を判定する手段が無いので PASS にしない");
    const b = rowOf(full, "P1-r2");
    assert.equal(b.verdict, "FAIL");
    assert.deepEqual(b.acceptance.exclusions, [{ id: "P:1", kind: "accepted_removal", scope: "part", matched: [{ kind: "check", id: target.req }], judged: "wrong" }]);
    assert.deepEqual(b.acceptance.counts.exclusions, zeroCounts({ wrong: 1 }));
    assert.deepEqual(b.acceptance.unevaluated_checks, []);
    assert.deepEqual(b.acceptance.effective.unverified, [{ id: "R:alt", via: ["accepted_unwritable"] }]);
    assert.deepEqual(b.fulfillment_accepted, { ...b.fulfillment_v2, unevaluated: [] }, "誤った除外は分母から外さない");
    assert.equal(b.verdict_accepted, "FAIL", "未検証の代替先があっても、判定の落ちは隠さない");
    const c = rowOf(full, "P1-r3");
    assert.deepEqual(c.fulfillment_accepted, { fulfilled: n - 1, total: n, total_from: "structure:main", unevaluated: [target.req] });
    assert.equal(c.verdict_accepted, "FAIL", "未評価の判定の外に落ちがあれば FAIL");
    const d = rowOf(full, "P1-r4");
    assert.deepEqual(d.acceptance.changed, [{ id: "R1b", kind: "changed", scope: "requirement", matched: [], judged: "unmatched" }], "変更後の文では当てない");
    assert.equal(d.verdict_accepted, VERDICT_UNEVALUATED);
    const ma = full.metrics_accepted;
    assert.equal(ma.unevaluated_checks, 2);
    startsWith(ma.unevaluated_runs, "2/4（");
    assert.equal(ma.unverified_requirements, 4);
    assert.deepEqual(ma.unverified_sources, { accepted_unwritable: 1, part: 0, changed: 3, added: 0 });
    startsWith(ma.unverified_runs, "4/4（");
    assert.deepEqual(ma.wrong_acceptances, UNEVALUATED_METRIC({ unmatched: 1, unevaluated: 2 }));
    startsWith(ma.wrong_acceptance_runs.undecided, "3/4（");
    startsWith(ma.wrong_acceptance_runs.evidence, "0/4（");
    startsWith(ma.wrong_exclusion_runs, "1/4（");
    startsWith(ma.spec_pass_writable, "0/4（");
    startsWith(full.metrics.spec_pass_writable, "2/4（");
    assert.deepEqual(full.fulfillment.accepted.unevaluated, { checks: 2, runs: 2 });
    assert.equal(full.fulfillment.accepted.writable, full.fulfillment.v2.writable, "了承後系の充足率の数は v2 と同じ");
    startsWith(full.fulfillment.v2.writable, `${4 * n - 2}/${4 * n}（`);
    // 負例：旧い判定が 2 件で片方が落ちている本で、落ちた方を変更扱いにしても率は上がらない（1/2 のまま。本は未評価）
    const two = makeCheckout(base, "two-check-checkout", { sameAggregator: true });
    const twoPath = join(two.ev, "subjects/A.json");
    const def2 = JSON.parse(readFileSync(twoPath, "utf8"));
    const failing = def2.structures[0].checks.find((c) => c.kind === "computedVisible");
    const passing = def2.structures[0].checks.find((c) => c.kind === "enumDefault");
    failing.keys = [escape(failing.req)];
    def2.structures[0].checks = [passing, failing];
    writeFileSync(twoPath, JSON.stringify(def2));
    const out2 = join(base, "two");
    addRun(out2, "P1-r1", { spec: FAIL_A });
    await addPlan(out2, "P1-r1", { plan: planFixture({ requirements: [req("R1", failing.req), req("R1b", "MARK_NEW", { change: change("changed", "R1") })] }), record: { outcome: "confirmed" } });
    addRun(out2, "P1-r2", { spec: FAIL_A });
    await addPlan(out2, "P1-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    planConditions(out2, ["P1-r1", "P1-r2"]);
    const r2 = scoreRun(out2, [], two.repo);
    const full2 = readScore(out2);
    const e = rowOf(full2, "P1-r1");
    assert.deepEqual(e.failed, [failing.req]);
    assert.deepEqual(e.fulfillment_v2, { fulfilled: 1, total: 2, total_from: "structure:main" });
    assert.deepEqual(e.fulfillment_accepted, { fulfilled: 1, total: 2, total_from: "structure:main", unevaluated: [failing.req] }, "落ちた判定を変更扱いにしても 1/2 のまま");
    assert.equal(e.verdict_accepted, VERDICT_UNEVALUATED);
    const g = rowOf(full2, "P1-r2");
    assert.deepEqual(g.fulfillment_accepted, { fulfilled: 1, total: 2, total_from: "structure:main", unevaluated: [] });
    assert.equal(g.verdict_accepted, "FAIL");
    startsWith(full2.fulfillment.accepted.writable, "2/4（");
    assert.equal(full2.fulfillment.accepted.writable, full2.fulfillment.v2.writable);
    assert.deepEqual(full2.fulfillment.accepted.unevaluated, { checks: 1, runs: 1 });
    assert.match(r2.stdout, /未評価の本 1・.*充足 2\/4（.*（未評価の判定 1）$/m);
  });
});

// ── 評価セットの定義ファイルと台本（#427。README §5.6）。定義ファイル・台本・往復の記録は作り物で、文は目印（MARK_）を使う（題材の言葉をここに書かない）
const SET_DEFAULTS = { schema: EVAL_SET_SCHEMA, id: "t-set", version: 1, role: "development", title: "t", styles: { S1: "s1", S2: "s2" } };
const realScoring = (s) => join(ev, "subjects", `${s}.json`);
/** 台本（entries は作り物） */
const scriptOf = (subject, entries, over = {}) => ({ schema: PLAN_SCRIPT_SCHEMA, subject, version: 1, entries, ...over });
const entry = (id, keys, answer, facet = null) => ({ id, facet, keys, answer, basis: "b" });
/** 定義ファイルの本（採点の定義は本物の subjects/<題材>.json を絶対パスで指す） */
const itemOf = (id, subject, over = {}) => ({ id, subject, style: "S1", writable: subject !== "D", scoring: realScoring(subject), script: null, request: [`MARK_REQ_${id}`, "MARK_LINE2"], ...over });
const writeJson = (path, obj) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj)); return path; };
/** 往復の記録の問い（記録の形。plan-record.json の rounds[].questions[]） */
const question = (id, text, choices, recommended, over = {}) => ({ id, open_issue_id: `OI:unresolved:${id}`, revision: 1, text, choices, recommended: recommended === null ? null : { choice_id: recommended, reason: "r" }, allow_free_text: true, also_closes: [], ...over });
const Q_HOW = (id = "Q1-1") => question(id, "MARK_REQ MARK_HOW?", [{ id: "c1", text: "MARK_C1 one" }, { id: "c2", text: "MARK_C2 two" }], "c1");
const answered = (q, choiceId) => ({ id: `A:${q.id}`, question_id: q.id, choice_id: choiceId, free_text: null });
const round = (questions, answers, all = false) => ({ questions, answers, all_recommended: all });
const SCRIPT_T = [entry("e1", ["MARK_REQ", "MARK_HOW"], { choose: ["MARK_C1"] }, "aggregation"), entry("e2", ["MARK_REQ", "MARK_STATE"], { choose: ["MARK_BOTH"] }, "counted-state"), entry("e3", ["MARK_TOPIC"], { recommended: true }), entry("e4", ["MARK_DUP"], { choose: ["MARK_X"] }), entry("e5", ["MARK_DUP"], { choose: ["MARK_Y"] })];

test("定義ファイルの読み込み：既定の組は読め、欠けた欄・形の違う欄は理由を挙げて断る（入力の値は書かない）。台本の形の検証も同じ", async () => {
  await withOut(async (base) => {
    const real = loadEvalSet(join(repo, DEFAULT_SET_PATH));
    assert.equal(real.status, "ok", real.reasons.join("、"));
    assert.equal(real.items.length, 10);
    assert.deepEqual(real.subjects, ["A", "B", "C", "D", "E"]);
    assert.deepEqual([...real.scripts.keys()], ["A", "B", "C", "D", "E"]);
    for (const it of real.items) { assert.ok(existsSync(it.scoringPath), it.id); assert.ok(it.requestText.length > 0, it.id); assert.equal(real.byId.get(it.id), it); }
    assert.match(real.sha256, HEX64);
    // 欠けた欄・形の違う欄（入力の値 MARK_ は理由に出ない）
    const scriptA = writeJson(join(base, "scripts/A.json"), scriptOf("A", []));
    const good = { ...SET_DEFAULTS, items: [itemOf("P1", "A", { script: scriptA }), itemOf("P2", "A", { script: scriptA, style: "S2" })] };
    assert.equal(loadEvalSet(writeJson(join(base, "good.json"), good)).status, "ok");
    const cases = [
      ["no-schema", { ...good, schema: "MARK_SCHEMA" }, "schema が未知"],
      ["no-id", { ...good, id: 1 }, "id が文字列でない"],
      ["no-version", { ...good, version: "1" }, "version が整数でない"],
      ["role", { ...good, role: "MARK_ROLE" }, "role が未知"],
      ["styles", { ...good, styles: [] }, "styles が写像でない"],
      ["source", { ...good, source: { document: 1 } }, "source の形が違う（document は文字列）"],
      ["no-items", { ...good, items: [] }, "items が配列でないか 0 件"],
      ["bad-id", { ...good, items: [itemOf("MARK_X1", "A", { script: scriptA })] }, "items[0].id が P<n> の形でない"],
      ["dup-id", { ...good, items: [itemOf("P1", "A", { script: scriptA }), itemOf("P1", "A", { script: scriptA })] }, "items の id が重複"],
      ["subject", { ...good, items: [itemOf("P1", 1, { script: scriptA })] }, "items[0].subject が文字列でない"],
      ["style", { ...good, items: [itemOf("P1", "A", { script: scriptA, style: "MARK_S9" })] }, "items[0].style が styles に無い"],
      ["writable", { ...good, items: [itemOf("P1", "A", { script: scriptA, writable: "yes" })] }, "items[0].writable が真偽値でない"],
      ["scoring-missing", { ...good, items: [itemOf("P1", "A", { script: scriptA, scoring: join(base, "MARK_NONE.json") })] }, "items[0].scoring の定義が無いか読めない"],
      ["scoring-id", { ...good, items: [itemOf("P1", "A", { script: scriptA, scoring: realScoring("B") })] }, "items[0].scoring の定義の id が subject と違う"],
      ["script-missing", { ...good, items: [itemOf("P1", "A", { script: join(base, "MARK_NONE.json") })] }, "items[0].script の台本が読めない: 台本が無い"],
      ["script-subject", { ...good, items: [itemOf("P1", "A", { script: writeJson(join(base, "scripts/B.json"), scriptOf("B", [])) })] }, "items[0].script の台本の subject が違う"],
      ["script-shape", { ...good, items: [itemOf("P1", "A", { script: writeJson(join(base, "scripts/bad.json"), scriptOf("A", [{ id: "x" }])) })] }, "items[0].script の台本が読めない: entries[0].facet が未知、entries[0].keys が正規表現の配列でないか 0 件、entries[0].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない、entries[0].basis が文字列でない"],
      ["script-type", { ...good, items: [itemOf("P1", "A", { script: 1 })] }, "items[0].script が文字列でも null でもない"],
      ["request", { ...good, items: [itemOf("P1", "A", { script: scriptA, request: [] })] }, "items[0].request が文字列の配列でないか 0 行"],
      ["request-type", { ...good, items: [itemOf("P1", "A", { script: scriptA, request: "MARK_TEXT" })] }, "items[0].request が文字列の配列でないか 0 行"],
      ["writable-conflict", { ...good, items: [itemOf("P1", "A", { script: scriptA }), itemOf("P2", "A", { script: scriptA, writable: false })] }, "同じ題材の items で writable が食い違う"],
      ["script-conflict", { ...good, items: [itemOf("P1", "A", { script: scriptA }), itemOf("P2", "A", { script: null })] }, "同じ題材の items で scoring・script が食い違う"],
      ["not-object", [], "定義ファイルが写像でない"],
    ];
    for (const [name, obj, reason] of cases) {
      const r = loadEvalSet(writeJson(join(base, `${name}.json`), obj));
      assert.equal(r.status, "invalid", name);
      assert.ok(r.reasons.includes(reason), `${name}: ${JSON.stringify(r.reasons)}`);
      assert.ok(!r.reasons.join("").includes("MARK_"), `${name}: 理由に入力の値が出ている`);
      assert.equal(r.set, null, name);
    }
    assert.equal(loadEvalSet(join(base, "MARK_MISSING.json")).status, "missing");
    assert.equal(loadEvalSet(writeJson(join(base, "broken.json"), "{ これは JSON でない")).status, "unreadable");
    // 台本の形：欠けた欄・正規表現でない鍵・答えの両方／どちらも無い・重複した ID
    assert.deepEqual(validateScript(scriptOf("A", [])), []);
    assert.deepEqual(validateScript(scriptOf("A", SCRIPT_T)), []);
    assert.deepEqual(validateScript([]), ["台本が写像でない"]);
    assert.deepEqual(validateScript({ subject: "A", version: 1 }), ["台本の schema が未知", "台本の entries が配列でない"]);
    assert.deepEqual(validateScript(scriptOf("", [], { version: "1" })), ["台本の subject が文字列でない", "台本の version が整数でない"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["("], { choose: ["x"] })])), ["entries[0].keys が正規表現の配列でないか 0 件"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["x"], { choose: ["x"], recommended: true })])), ["entries[0].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["x"], {})])), ["entries[0].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["x"], { recommended: false })])), ["entries[0].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["x"], { choose: ["x"] }, "MARK_FACET")])), ["entries[0].facet が未知"]);
    assert.deepEqual(validateScript(scriptOf("A", [entry("e", ["x"], { choose: ["x"] }), entry("e", ["y"], { choose: ["y"] })])), ["entries[1].id が文字列でないか重複"]);
    assert.equal(loadScript(join(base, "MARK_NONE.json")).status, "missing");
    assert.equal(loadScript(writeJson(join(base, "scripts/broken.json"), "{")).status, "unreadable");
    assert.equal(loadScript(writeJson(join(base, "scripts/invalid.json"), { schema: PLAN_SCRIPT_SCHEMA })).status, "invalid");
    assert.deepEqual(CATALOG_FACET_IDS, ["aggregation", "period", "current-period", "counted-state", "include-zero", "editable-by"]);
    // 工場の目録の観点と同じ値（packages/factory の dist から読む。ずれたらここで気づく）
    const catalog = await import(pathToFileURL(join(repo, "packages/factory/dist/plan/catalog.js")).href);
    assert.deepEqual(catalog.CATALOG_FACETS.map((f) => f.id), CATALOG_FACET_IDS);
  });
});

test("既定の組（dev-p1-p10）の台本は形が正しく、鍵と選択肢の正規表現は読め、観点は目録の値の中にある", () => {
  const real = loadEvalSet(join(repo, DEFAULT_SET_PATH));
  assert.equal(real.status, "ok");
  assert.equal(real.set.id, "dev-p1-p10");
  assert.equal(real.set.role, "development");
  for (const [subject, sc] of real.scripts) {
    assert.deepEqual(validateScript(sc.script), [], subject);
    assert.equal(sc.script.subject, subject);
    assert.ok(sc.script.entries.length > 0, `${subject} の台本に件が無い`);
    for (const e of sc.script.entries) {
      assert.ok(e.facet === null || CATALOG_FACET_IDS.includes(e.facet), e.id);
      assert.ok(e.id.startsWith(`${subject}:`), `${e.id} は題材の ID で始まる`);
      for (const k of e.keys) new RegExp(k);
      if (e.answer.choose) for (const k of e.answer.choose) new RegExp(k);
    }
  }
  const fp = scriptsFingerprint(real.scripts);
  assert.match(fp.fingerprint, HEX64);
  assert.deepEqual(fp.files.map((f) => f.subject), ["A", "B", "C", "D", "E"]);
  assert.equal(scriptsFingerprint(new Map()).fingerprint, null);
});

test("台本の当てはめ：鍵が全部当たり観点が食い違わない件が 1 つのときだけ答え、台本に無い問いは不明、2 件以上・選択肢が決まらない問いは決められない。確定した仕様の事項と要件の文も鍵の対象", () => {
  const script = scriptOf("T", SCRIPT_T);
  const q1 = Q_HOW();
  const a = applyScript(script, q1, "c1");
  assert.deepEqual(a, { question_id: "Q1-1", open_issue_id: "OI:unresolved:Q1-1", facets: [], actual_choice_id: "c1", status: "scripted", reason: null, entry_id: "e1", choice_id: "c1", agrees: true });
  assert.equal(applyScript(script, q1, "c2").agrees, false, "工場の答えが台本と違う");
  assert.equal(applyScript(script, q1, null).agrees, null, "工場の答えが無ければ null");
  // 観点：問いが目録の事項を閉じるなら、台本の facet と食い違う件は当てない（文は当たっても）
  const qState = Q_HOW("Q1-2");
  const withFacet = (q, ids) => ({ ...q, open_issue_id: ids[0], also_closes: ids.slice(1) });
  assert.equal(applyScript(script, withFacet(qState, ["OI:catalog:R-1:counted-state"]), "c1").status, "unknown", "観点が食い違えば不明");
  assert.equal(applyScript(script, withFacet(qState, ["OI:unresolved:1", "A-R1-x", "OI:catalog:R-1:aggregation"]), "c1").entry_id, "e1", "also_closes の観点でも当たる");
  assert.deepEqual(questionFacets(withFacet(qState, ["OI:catalog:R-1:period", "OI:catalog:R-2:period", "A-R1-x", "OI:catalog:R-3:include-zero"])), { facets: ["period", "include-zero"], requirementIds: ["R-1", "R-2", "R-3"] });
  assert.deepEqual(questionFacets({ open_issue_id: "OI:unresolved:1" }), { facets: [], requirementIds: [] });
  // 確定した仕様の文：問いの文だけでは当たらないが、閉じる事項の文と目録の事項が指す要件の文で当たる
  const qPlain = question("Q1-3", "MARK_Q?", [{ id: "c1", text: "MARK_C1" }, { id: "c2", text: "MARK_C2" }], "c1", { open_issue_id: "OI:catalog:R-7:aggregation" });
  assert.equal(applyScript(script, qPlain, "c1").status, "unknown");
  const texts = planTexts({ open_issues: [{ id: "OI:catalog:R-7:aggregation", text: "MARK_HOW について" }], requirements: [{ id: "R-7", text: "MARK_REQ" }] });
  assert.equal(applyScript(script, qPlain, "c1", texts).entry_id, "e1");
  assert.equal(applyScript(script, qPlain, "c1", planTexts({ open_issues: [{ id: "OI:catalog:R-7:aggregation", text: "MARK_HOW MARK_REQ" }] })).entry_id, "e1", "事項の文だけでも当たる");
  assert.deepEqual(planTexts(null), { issues: new Map(), requirements: new Map() });
  // 推奨でよいと点検済みの件は推奨の選択肢（台本に無いのとは別の状態）
  const qTopic = question("Q1-4", "MARK_TOPIC?", [{ id: "x", text: "MARK_X" }, { id: "y", text: "MARK_Y" }], "y");
  assert.deepEqual([applyScript(script, qTopic, "y").status, applyScript(script, qTopic, "y").choice_id, applyScript(script, qTopic, "y").agrees], ["scripted", "y", true]);
  assert.equal(applyScript(script, { ...qTopic, recommended: null }, "y").reason, "no-choice", "推奨の無い問いは決められない");
  // 決められない：台本の件が 2 つ以上当たる／当たる選択肢が無い／2 つ以上
  const dup = applyScript(script, question("Q1-5", "MARK_DUP?", [{ id: "x", text: "MARK_X" }], "x"), "x");
  assert.deepEqual([dup.status, dup.reason, dup.entry_id, dup.choice_id], ["unresolved", "entries", ["e4", "e5"], null]);
  const none = applyScript(script, question("Q1-6", "MARK_REQ MARK_HOW?", [{ id: "c2", text: "MARK_C2" }, { id: "c3", text: "MARK_C3" }], "c2"), "c2");
  assert.deepEqual([none.status, none.reason, none.entry_id], ["unresolved", "no-choice", "e1"]);
  const many = applyScript(script, question("Q1-7", "MARK_REQ MARK_HOW?", [{ id: "c1", text: "MARK_C1 a" }, { id: "c9", text: "MARK_C1 b" }], "c1"), "c1");
  assert.deepEqual([many.status, many.reason], ["unresolved", "many-choices"]);
  // 台本が無い題材は全部不明
  assert.equal(applyScript(null, q1, "c1").status, "unknown");
  // 本 1 つの照合：往復の記録の全部の問い（全部推奨で閉じた往復は推奨が工場の答え）
  const q5 = question("Q1-5", "MARK_DUP?", [{ id: "x", text: "MARK_X" }], "x");
  const pr = { rounds: [round([q1, q5], [answered(q1, "c2")]), round([qTopic], [], true)] };
  const sum = scriptSummary({ rel: "scripts/T.json", script }, pr, null);
  assert.deepEqual({ ...sum, details: undefined }, { file: "scripts/T.json", status: "disagreed", questions: 3, scripted: 2, agreed: 1, disagreed: 1, unknown: 0, unresolved: 1, details: undefined });
  assert.deepEqual(sum.details.map((d) => [d.question_id, d.status, d.agrees]), [["Q1-1", "scripted", false], ["Q1-5", "unresolved", null], ["Q1-4", "scripted", true]]);
  assert.equal(scriptSummary({ rel: "s", script }, null, null).status, "none");
  assert.equal(scriptSummary({ rel: "s", script }, { rounds: [] }, null).status, "no-questions");
  assert.equal(scriptSummary({ rel: "s", script }, { rounds: [round([q1], [answered(q1, "c1")])] }, null).status, "ok");
  assert.equal(scriptSummary({ rel: "s", script }, { rounds: [round([q1, qPlain], [answered(q1, "c1"), answered(qPlain, "c1")])] }, null).status, "unanswered", "不明な問いが 1 つでもあれば unanswered");
  assert.equal(scriptSummary({ rel: "s", script }, { rounds: [round([q1], [])] }, null).status, "unanswered", "工場の答えが記録に無ければ一致とは言えない");
  assert.deepEqual(scriptSummary(null, { rounds: [round([q1], [answered(q1, "c1")])] }, null), { file: null, status: "unanswered", questions: 1, scripted: 0, agreed: 0, disagreed: 0, unknown: 1, unresolved: 0, details: [applyScript(null, q1, "c1")] });
  assert.deepEqual(SCRIPT_RUN_STATUSES, ["ok", "disagreed", "unanswered", "no-questions", "none"]);
});

test("採点の道具は定義ファイルから題材・書き方・書ける範囲・採点の定義・台本を読み、台本を事後に当てた結果を行と集計と匿名の集計に足す。定義ファイルに無い ID の本は飛ばし、読めない定義ファイルは断る", async () => {
  await withOut(async (base) => {
    const scriptA = writeJson(join(base, "set/scripts/A.json"), scriptOf("A", [entry("A:e1", ["MARK_REQ", "MARK_HOW"], { choose: ["MARK_C1"] }, "aggregation")]));
    const setPath = writeJson(join(base, "set/t-set.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A", { script: "scripts/A.json" }), itemOf("P7", "D", { style: "S2" })] });
    const loaded = loadEvalSet(setPath);
    assert.equal(loaded.status, "ok", loaded.reasons.join("、"));
    assert.equal(loaded.scripts.get("A").path, scriptA);
    const out = join(base, "out");
    const q1 = Q_HOW(), qU = question("Q1-2", "MARK_UNKNOWN?", [{ id: "u1", text: "MARK_U1" }, { id: "u2", text: "MARK_U2" }], "u1");
    addRun(out, "P1-r1", { spec: PASS_A }); await addPlan(out, "P1-r1", { record: { outcome: "confirmed", rounds: [round([q1], [answered(q1, "c1")])] } });
    addRun(out, "P1-r2", { spec: PASS_A }); await addPlan(out, "P1-r2", { record: { outcome: "confirmed", rounds: [round([q1, qU], [answered(q1, "c1"), answered(qU, "u1")])] } });
    addRun(out, "P1-r3", { spec: PASS_A }); await addPlan(out, "P1-r3", { record: { outcome: "stopped", rounds: [round([q1], [answered(q1, "c2")])] } });
    addRun(out, "P1-r4", { spec: PASS_A });
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D }); await addPlan(out, "P7-r1", { record: { outcome: "confirmed", rounds: [round([qU], [answered(qU, "u1")])] } });
    for (const id of ["P7-r2", "P7-r3", "P7-r4"]) addRun(out, id);
    addRun(out, "P9-r1", { spec: PASS_A });
    const ids = ["P1-r1", "P1-r2", "P1-r3", "P1-r4", "P7-r1", "P7-r2", "P7-r3", "P7-r4"];
    const scriptsFp = scriptsFingerprint(loaded.scripts);
    planConditions(out, ids, { schema: V3, set: { path: setPath, sha256: loaded.sha256, id: "t-set", version: 1, role: "development" }, scripts: { mode: SCRIPT_MODE, fingerprint: scriptsFp.fingerprint } });
    const r = scoreRun(out);
    assert.match(r.stderr, /^飛ばしました: P9-r1（組 t-set に無い ID の本）$/m);
    const full = readScore(out);
    assert.deepEqual(full.set, { id: "t-set", version: 1, role: "development", path: full.set.path, sha256: loaded.sha256 });
    assert.ok(full.set.path.endsWith("set/t-set.json"));
    assert.deepEqual(full.rows.map((x) => x.run), ids, "定義ファイルに無い ID の本は行に入れない");
    assert.deepEqual(full.completion.extra, ["P9-r1"], "照合では予定外として数える");
    assert.deepEqual([full.completion.scored, full.completion.unscored, full.completion.reasons], [8, ["P9-r1"], ["予定外 1 本", "採点できない 1 本（組に無い ID）"]], "採点した本数と採点できない本も照合に残す（fix-427）");
    assert.match(r.stdout, /照合: 未完了（予定 8・実行 9・採点 8・未実行 0・途中 0・採点できない 1）/);
    assert.deepEqual(full.rows.map((x) => [x.subject, x.style, x.writable]), [["A", "S1", true], ["A", "S1", true], ["A", "S1", true], ["A", "S1", true], ["D", "S2", false], ["D", "S2", false], ["D", "S2", false], ["D", "S2", false]]);
    assert.deepEqual(Object.keys(full.bySubject), ["A", "D"], "題材の順は定義ファイル");
    startsWith(full.metrics.spec_pass_writable, "4/4（");
    startsWith(full.metrics.spec_pass_partial, "1/4（");
    assert.equal(rowOf(full, "P7-r2").script.status, "none", "往復の記録の無い本は対象外");
    assert.equal(rowOf(full, "P7-r1").verdict, "PASS", "採点の定義は定義ファイルが指す subjects/D.json");
    const sc = (id) => rowOf(full, id).script;
    assert.deepEqual({ ...sc("P1-r1"), details: undefined }, { file: "scripts/A.json", status: "ok", questions: 1, scripted: 1, agreed: 1, disagreed: 0, unknown: 0, unresolved: 0, details: undefined });
    assert.deepEqual(sc("P1-r1").details, [{ question_id: "Q1-1", open_issue_id: "OI:unresolved:Q1-1", facets: [], actual_choice_id: "c1", status: "scripted", reason: null, entry_id: "A:e1", choice_id: "c1", agrees: true }]);
    assert.deepEqual([sc("P1-r2").status, sc("P1-r2").unknown, sc("P1-r2").agreed], ["unanswered", 1, 1]);
    assert.deepEqual([sc("P1-r3").status, sc("P1-r3").disagreed], ["disagreed", 1]);
    assert.deepEqual(sc("P1-r4"), { file: "scripts/A.json", status: "none", questions: 0, scripted: 0, agreed: 0, disagreed: 0, unknown: 0, unresolved: 0, details: [] });
    assert.deepEqual([sc("P7-r1").file, sc("P7-r1").status, sc("P7-r1").unknown], [null, "unanswered", 1], "台本の無い題材は全部不明");
    assert.equal(rowOf(full, "P1-r3").verdict_accepted, null, "台本の照合は判定を変えない（Plan が確定しなかった本は null のまま）");
    assert.equal(rowOf(full, "P1-r1").verdict, "PASS");
    const ms = full.metrics_script;
    assert.deepEqual({ ...ms, label: undefined }, { mode: "post-hoc", label: undefined, runs: 4, questions: 5, scripted: 3, agreed: 2, disagreed: 1, unknown: 2, unresolved: 0, runs_ok: ms.runs_ok, runs_disagreed: ms.runs_disagreed, runs_unanswered: ms.runs_unanswered });
    startsWith(ms.runs_ok, "1/4（");
    startsWith(ms.runs_disagreed, "1/4（");
    startsWith(ms.runs_unanswered, "2/4（");
    assert.match(r.stdout, /^台本: 対象 4 本・問い 5（台本で答えられた 3［推奨と同じ 2・違う 1］・不明 2・決められない 0）・本の内訳（一致 1\/4（.*・不一致 1\/4（.*・不明あり 2\/4（.*）$/m);
    assert.match(r.stdout, /・組 t-set v1 [0-9a-f]{12}…（条件のファイルと一致）・台本 [0-9a-f]{12}…（条件のファイルと一致）$/m);
    const fp = full.fingerprints;
    assert.deepEqual(fp.set, { path: full.set.path, sha256: loaded.sha256 });
    assert.deepEqual(fp.scripts, scriptsFp);
    assert.equal(fp.set_matches_conditions, true);
    assert.equal(fp.scripts_matches_conditions, true);
    assert.equal(fp.conditions.set, loaded.sha256);
    assert.equal(fp.conditions.scripts, scriptsFp.fingerprint);
    // 匿名の集計：件数・区間・既知の値・ハッシュだけ（問いの文・事項の ID・台本の件の ID・組の ID は出ない）
    const ra = scoreRun(out, ["--anonymous"]);
    const text = readFileSync(join(out, "score.anonymous.json"), "utf8");
    for (const w of ["MARK_", "A:e1", "Q1-1", "OI:", "t-set", "scripts/A.json"]) { assert.ok(!text.includes(w), `匿名の出力に ${w}`); assert.ok(!ra.stdout.includes(w), `標準出力に ${w}`); }
    const an = JSON.parse(text);
    assert.deepEqual(an.metrics_script, { mode: "post-hoc", runs: 4, questions: 5, scripted: 3, agreed: 2, disagreed: 1, unknown: 2, unresolved: 0, runs_ok: ms.runs_ok, runs_disagreed: ms.runs_disagreed, runs_unanswered: ms.runs_unanswered });
    assert.deepEqual(an.set, { version: 1, role: "development", sha256: loaded.sha256 });
    assert.equal(an.fingerprints.set, loaded.sha256);
    assert.equal(an.fingerprints.scripts, scriptsFp.fingerprint);
    assert.equal(an.fingerprints.set_matches_conditions, true);
    assert.equal(an.fingerprints.conditions.set, loaded.sha256);
    assert.deepEqual(an, anonymize(full));
    // --set で別の定義ファイル（1 文字違う写し）を渡すと、組の指紋は条件と不一致。台本を変えれば台本の指紋も不一致
    const copy = writeJson(join(base, "set/copy.json"), readFileSync(setPath, "utf8") + "\n");
    scoreRun(out, ["--set", copy]);
    assert.equal(readScore(out).fingerprints.set_matches_conditions, false);
    appendFileSync(scriptA, "\n");
    scoreRun(out);
    assert.equal(readScore(out).fingerprints.scripts_matches_conditions, false);
    assert.equal(readScore(out).fingerprints.set_matches_conditions, true);
    // 条件のファイルに組が無い（v2 以前）計測は既定の組で採点し、一致は null
    const old = join(base, "old");
    addRun(old, "P1-r1", { spec: PASS_A });
    conditions(old, ["P1-r1"]);
    scoreRun(old);
    const fo = readScore(old);
    assert.equal(fo.set.id, "dev-p1-p10");
    assert.equal(fo.fingerprints.set_matches_conditions, null);
    assert.equal(fo.fingerprints.scripts_matches_conditions, null);
    assert.equal(rowOf(fo, "P1-r1").writable, true);
    assert.equal(rowOf(fo, "P1-r1").script.status, "none");
    assert.deepEqual(fo.metrics_script.runs, 0);
    // 読めない定義ファイル（条件の set.path が無い・--set が欠けた欄）は採点せずに断る
    const bad = join(base, "bad");
    addRun(bad, "P1-r1", { spec: PASS_A });
    conditions(bad, ["P1-r1"], { set: { path: join(base, "MARK_NONE.json") } });
    const rb = spawnSync(process.execPath, [scoreFile, repo, bad], { encoding: "utf8" });
    assert.equal(rb.status, 3);
    assert.match(rb.stderr, /断りました: 定義ファイルを読めません/);
    assert.equal(existsSync(join(bad, "score.json")), false);
    const rb2 = spawnSync(process.execPath, [scoreFile, repo, bad, "--set", writeJson(join(base, "set/no-items.json"), { ...SET_DEFAULTS, items: [] })], { encoding: "utf8" });
    assert.equal(rb2.status, 3);
    assert.match(rb2.stderr, /items が配列でないか 0 件/);
  });
});

// ── 独立レビューの直し（fix-427）：採点の定義の実体の指紋・予定と採点の本数の照合・匿名の標準エラー

test("組を変えずに参照先の採点の定義だけを変えると、採点の指紋が条件と食い違う（組の指紋は一致のまま）。組が参照する定義は subjects/ の外でも指紋に入る", async () => {
  await withOut(async (base) => {
    // 組の採点の定義を subjects/ の外（写し）に置く。中身は凍結した A と同じ
    const defPath = writeJson(join(base, "defs/A.json"), readFileSync(realScoring("A"), "utf8"));
    const setPath = writeJson(join(base, "set/t-set.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A", { scoring: defPath })] });
    const loaded = loadEvalSet(setPath);
    assert.equal(loaded.status, "ok", loaded.reasons.join("、"));
    assert.deepEqual([...loaded.definitions.keys()], ["A"]);
    assert.deepEqual(loaded.definitions.get("A"), { path: defPath, rel: defPath, sha256: sha256(readFileSync(defPath)) });
    const recorded = scoringFingerprint(ev, undefined, loaded.definitions);
    const defEntry = fileOf(recorded, "definition:A");
    assert.deepEqual(defEntry, { path: "definition:A", source: relative(ev, defPath), sha256: sha256(readFileSync(defPath)) });
    assert.equal(defEntry.sha256, fileOf(recorded, "subjects/A.json").sha256, "写しなので中身の指紋は凍結した定義と同じ");
    assert.notEqual(recorded.fingerprint, scoringFingerprint(ev).fingerprint, "参照先の定義が指紋に入る");
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    conditions(out, ["P1-r1"], { schema: V3, set: { path: setPath, sha256: loaded.sha256 }, scoring: { fingerprint: recorded.fingerprint } });
    scoreRun(out);
    const before = readScore(out);
    const n = totalOf("A");
    assert.deepEqual([before.fingerprints.scoring_matches_conditions, before.fingerprints.set_matches_conditions], [true, true]);
    assert.deepEqual(fileOf(before.fingerprints.scoring, "definition:A"), defEntry);
    assert.deepEqual(rowOf(before, "P1-r1").fulfillment_v2, { fulfilled: n, total: n, total_from: "structure:main" });
    // 組（定義ファイル）はそのまま、参照先の定義に判定を 1 つ足す（分母が n → n+1）。組の指紋は一致のまま、採点の指紋が不一致になる
    const def = JSON.parse(readFileSync(defPath, "utf8"));
    def.structures[0].checks.push({ ...def.structures[0].checks[0], req: "MARK_EXTRA" });
    writeFileSync(defPath, JSON.stringify(def));
    scoreRun(out);
    const after = readScore(out);
    assert.equal(after.fingerprints.set_matches_conditions, true, "組は変えていない");
    assert.equal(after.fingerprints.scoring_matches_conditions, false, "参照先の定義の変更は採点の指紋の不一致として出る");
    assert.equal(rowOf(after, "P1-r1").fulfillment_v2.total, n + 1, "分母が動いた");
    assert.notEqual(fileOf(after.fingerprints.scoring, "definition:A").sha256, defEntry.sha256);
    assert.equal(fileOf(after.fingerprints.scoring, "subjects/A.json").sha256, defEntry.sha256, "凍結した subjects/ は触っていない");
    // 匿名の集計でも不一致は残る（指紋はハッシュだけ）
    scoreRun(out, ["--anonymous"]);
    const an = readScore(out, "score.anonymous.json");
    assert.deepEqual([an.fingerprints.scoring_matches_conditions, an.fingerprints.set_matches_conditions], [false, true]);
    assert.ok(!JSON.stringify(an).includes("MARK_"));
  });
});

test("予定の本が採点する組に無ければ採点せずに断る（v2・v3 とも）。予定した本を分母から黙って除かない。組に無い予定外の本は採点できない本として照合に残る", async () => {
  await withOut(async (base) => {
    const onlyP1 = writeJson(join(base, "set/only-p1.json"), { ...SET_DEFAULTS, id: "MARK_SET", items: [itemOf("P1", "A")] });
    // v2 の条件：予定 2 本（成功 1・生成失敗 1）。P1 だけの組で採点すると 1/2 が 1/1 になるので断る
    const v2 = join(base, "v2");
    addRun(v2, "P1-r1", { spec: PASS_A });
    addRun(v2, "P2-r1");
    conditions(v2, ["P1-r1", "P2-r1"]);
    scoreRun(v2);
    startsWith(readScore(v2).metrics.spec_pass_writable, "1/2（");
    assert.equal(readScore(v2).completion.status, "complete");
    const r = spawnSync(process.execPath, [scoreFile, repo, v2, "--set", onlyP1], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(r.stderr, "断りました: 予定の本が採点する組（MARK_SET）に無い（1 本: P2-r1）\n");
    assert.equal(r.stdout, "");
    startsWith(readScore(v2).metrics.spec_pass_writable, "1/2（", "前の結果を上書きしない");
    // v3 の条件（組 P1・P7 で計測）：P1 だけの組で採点しても断る
    const both = writeJson(join(base, "set/both.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A"), itemOf("P7", "D")] });
    const loadedBoth = loadEvalSet(both);
    const v3 = join(base, "v3");
    addRun(v3, "P1-r1", { spec: PASS_A });
    addRun(v3, "P1-r2");
    addRun(v3, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    addRun(v3, "P7-r2");
    conditions(v3, ["P1-r1", "P1-r2", "P7-r1", "P7-r2"], { schema: V3, set: { path: both, sha256: loadedBoth.sha256 } });
    const r3 = spawnSync(process.execPath, [scoreFile, repo, v3, "--set", onlyP1], { encoding: "utf8" });
    assert.equal(r3.status, 3);
    assert.equal(r3.stderr, "断りました: 予定の本が採点する組（MARK_SET）に無い（2 本: P7-r1,P7-r2）\n");
    assert.equal(existsSync(join(v3, "score.json")), false);
    // 条件の組で採点すれば、予定・実行・採点の本数がそろって完了
    const ok = scoreRun(v3);
    const full = readScore(v3);
    assert.deepEqual([full.completion.planned, full.completion.executed, full.completion.scored, full.completion.unscored, full.completion.status], [4, 4, 4, [], "complete"]);
    assert.match(ok.stdout, /照合: 完了（予定 4・実行 4・採点 4・未実行 0・途中 0・採点できない 0）/);
    assert.equal(ok.stderr, "");
    // 予定外で組にも無い本（P9-r1）：行に入れず、照合では予定外かつ採点できない本として理由に残り、完了にならない
    addRun(v3, "P9-r1", { spec: PASS_A });
    const r4 = scoreRun(v3);
    const full4 = readScore(v3);
    assert.equal(full4.rows.length, 4);
    assert.deepEqual(full4.completion.reasons, ["予定外 1 本", "採点できない 1 本（組に無い ID）"]);
    assert.deepEqual([full4.completion.scored, full4.completion.unscored, full4.completion.extra], [4, ["P9-r1"], ["P9-r1"]]);
    assert.equal(r4.stderr, "飛ばしました: P9-r1（組 t-set に無い ID の本）\n");
    assert.match(r4.stdout, /照合: 未完了（予定 4・実行 5・採点 4・未実行 0・途中 0・採点できない 1）/);
    assert.equal(full4.metrics.spec_pass_writable, full.metrics.spec_pass_writable, "予定外の本は指標に入らない");
    // 条件のファイルが無い（未照合）出力先でも、組に無い本は採点できない本として理由に残る
    const old = join(base, "old");
    addRun(old, "P1-r1", { spec: PASS_A });
    addRun(old, "P9-r1", { spec: PASS_A });
    scoreRun(old, ["--set", onlyP1]);
    const c = readScore(old).completion;
    assert.deepEqual([c.status, c.reasons, c.scored, c.unscored], ["unverified", ["条件のファイルが無い", "採点できない 1 本（組に無い ID）"], 1, ["P9-r1"]]);
    // 予定を検証できない条件（未照合）では予定の照合はできないので断らず、採点できない本だけを理由に残す
    rawConditions(old, { schema: V2, params: { patterns: ["P1"], runs: 1 } });
    scoreRun(old, ["--set", onlyP1]);
    assert.deepEqual(readScore(old).completion.reasons, ["予定の一覧（child_args）が無いか配列でない", "採点できない 1 本（組に無い ID）"]);
    // reconcile 単体：組を渡さなければ scored・unscored は null（従来の呼び方）
    assert.deepEqual([reconcile(old).scored, reconcile(old).unscored], [null, null]);
    assert.deepEqual([reconcile(old, loadEvalSet(onlyP1)).scored, reconcile(old, loadEvalSet(onlyP1)).unscored], [1, ["P9-r1"]]);
  });
});

test("--anonymous は読み込みと診断の前に伝わり、成功・断り・失敗のどの経路でも JSON・標準出力・標準エラーに本の ID・組の ID・パスが出ない", async () => {
  await withOut(async (base) => {
    const scriptA = writeJson(join(base, "MARK_DIR/scripts/A.json"), scriptOf("A", [entry("MARK_ENTRY", ["MARK_REQ"], { choose: ["MARK_C1"] })]));
    const setPath = writeJson(join(base, "MARK_DIR/MARK_SET.json"), { ...SET_DEFAULTS, id: "MARK_SET", items: [itemOf("P1", "A", { script: scriptA })] });
    const loaded = loadEvalSet(setPath);
    assert.equal(loaded.status, "ok");
    const out = join(base, "out");
    const q1 = Q_HOW();
    addRun(out, "P1-r1", { spec: PASS_A }); await addPlan(out, "P1-r1", { record: { outcome: "confirmed", rounds: [round([q1], [answered(q1, "c2")])] } });
    addRun(out, "P1-r2", { spec: FAIL_A });
    addRun(out, "P9-r1", { spec: PASS_A });
    planConditions(out, ["P1-r1", "P1-r2"], { schema: V3, measurement_id: "MARK_ID", set: { path: setPath, sha256: loaded.sha256, id: "MARK_SET" } });
    const forbidden = ["P1-r1", "P1-r2", "P9-r1", "MARK_", base];
    const clean = (r, name) => { for (const w of forbidden) { assert.ok(!r.stdout.includes(w), `${name}: 標準出力に ${w}`); assert.ok(!r.stderr.includes(w), `${name}: 標準エラーに ${w}`); } };
    // 成功の経路：飛ばした本は件数だけ
    const r = scoreRun(out, ["--anonymous"]);
    clean(r, "成功");
    assert.equal(r.stderr, "飛ばしました: 組に無い ID の本 1 本\n");
    const text = readFileSync(join(out, "score.anonymous.json"), "utf8");
    for (const w of forbidden) assert.ok(!text.includes(w), `JSON に ${w}`);
    const a = JSON.parse(text);
    assert.deepEqual(a.completion, { status: "incomplete", label: "未完了", planned: 2, executed: 3, scored: 2, unexecuted: 0, incomplete: 0, extra: 1, unscored: 1, stop_code: null });
    assert.equal(a.runs, 2);
    assert.equal(a.metrics_script.disagreed, 1);
    assert.equal(existsSync(join(out, "score.json")), false);
    // 断りの経路：予定の本が組に無い（本数だけ）・定義ファイルを読めない（パスを出さない）
    const onlyP2 = writeJson(join(base, "MARK_DIR/only-p2.json"), { ...SET_DEFAULTS, id: "MARK_SET2", items: [itemOf("P2", "A")] });
    const r2 = spawnSync(process.execPath, [scoreFile, repo, out, "--anonymous", "--set", onlyP2], { encoding: "utf8" });
    assert.equal(r2.status, 3);
    clean(r2, "予定の本が組に無い");
    assert.equal(r2.stderr, "断りました: 予定の本が採点する組に無い（2 本）\n");
    assert.equal(r2.stdout, "");
    assert.equal(existsSync(join(out, "score.anonymous.json")), true, "前の結果はそのまま");
    const r3 = spawnSync(process.execPath, [scoreFile, repo, out, "--anonymous", "--set", join(base, "MARK_DIR/MARK_NONE.json")], { encoding: "utf8" });
    assert.equal(r3.status, 3);
    clean(r3, "定義ファイルが無い");
    assert.equal(r3.stderr, "断りました: 定義ファイルを読めません: 定義ファイルが無い\n");
    const bad = writeJson(join(base, "MARK_DIR/bad.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A", { style: "MARK_S9" })] });
    const r4 = spawnSync(process.execPath, [scoreFile, repo, out, "--anonymous", "--set", bad], { encoding: "utf8" });
    assert.equal(r4.status, 3);
    clean(r4, "欠けた欄");
    assert.equal(r4.stderr, "断りました: 定義ファイルを読めません: items[0].style が styles に無い\n");
    // 失敗の経路（予期しない誤り。採点器の依存が無いリポジトリ）：詳細（パスを含む）を出さない
    const r5 = spawnSync(process.execPath, [scoreFile, join(base, "MARK_NOREPO"), out, "--anonymous"], { encoding: "utf8" });
    assert.equal(r5.status, 1);
    clean(r5, "失敗");
    assert.equal(r5.stderr, "失敗しました: 採点できなかった（匿名の実行では詳細を出さない。匿名でない実行で確かめる）\n");
    assert.equal(r5.stdout, "");
    // 匿名でない実行では、同じ経路で本の ID・組の ID・誤りの詳細を出す（調べられる）
    const r6 = spawnSync(process.execPath, [scoreFile, repo, out, "--set", onlyP2], { encoding: "utf8" });
    assert.equal(r6.status, 3);
    assert.equal(r6.stderr, "断りました: 予定の本が採点する組（MARK_SET2）に無い（2 本: P1-r1,P1-r2）\n");
    const r7 = spawnSync(process.execPath, [scoreFile, join(base, "MARK_NOREPO"), out], { encoding: "utf8" });
    assert.notEqual(r7.status, 0);
    assert.ok(r7.stderr.includes("MARK_NOREPO"), "匿名でなければ誤りの詳細はそのまま");
  });
});

test("--anonymous は結果の書き込みに失敗しても標準出力・標準エラーに本の ID・組の ID・パス・スタックを出さない（既知の理由コードだけ）。匿名でなければ誤りの詳細はそのまま", async () => {
  await withOut(async (base) => {
    const setPath = writeJson(join(base, "MARK_DIR/MARK_SET.json"), { ...SET_DEFAULTS, id: "MARK_SET", items: [itemOf("P1", "A")] });
    const loaded = loadEvalSet(setPath);
    assert.equal(loaded.status, "ok");
    const out = join(base, "MARK_OUT");
    addRun(out, "P1-r1", { spec: PASS_A });
    planConditions(out, ["P1-r1"], { schema: V3, measurement_id: "MARK_ID", set: { path: setPath, sha256: loaded.sha256, id: "MARK_SET" } });
    // 書き込みの関数を差し替え、出力先への書き込みだけを OS の権限エラーと同じ形（EACCES・文にパスを含む）で失敗させる（物理の権限は変えない）
    const preload = join(base, "MARK_DIR/fail-write.mjs");
    writeFileSync(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const orig = fs.writeFileSync, out = ${JSON.stringify(out)};
fs.writeFileSync = (p, ...rest) => { if (String(p).startsWith(out)) { const e = new Error(\`EACCES: permission denied, open '\${p}'\`); e.code = "EACCES"; e.errno = -13; e.syscall = "open"; e.path = String(p); throw e; } return orig(p, ...rest); };
syncBuiltinESMExports();
`);
    const forbidden = ["P1-r1", "MARK_", base, "score-agent.mjs", "    at "];
    const clean = (r, name) => { for (const w of forbidden) { assert.ok(!r.stdout.includes(w), `${name}: 標準出力に ${w}`); assert.ok(!r.stderr.includes(w), `${name}: 標準エラーに ${w}`); } };
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, scoreFile, repo, out, "--anonymous"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    clean(r, "EACCES");
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "失敗しました: 結果を書けなかった（理由: EACCES。匿名の実行では詳細を出さない。匿名でない実行で確かめる）\n");
    assert.equal(existsSync(join(out, "score.anonymous.json")), false);
    // 実際の OS の誤り：結果のパスにディレクトリがある（EISDIR。権限に依らず起きる）
    mkdirSync(join(out, "score.anonymous.json"));
    const r2 = spawnSync(process.execPath, [scoreFile, repo, out, "--anonymous"], { encoding: "utf8" });
    assert.equal(r2.status, 1);
    clean(r2, "EISDIR");
    assert.equal(r2.stdout, "");
    assert.equal(r2.stderr, "失敗しました: 結果を書けなかった（理由: EISDIR。匿名の実行では詳細を出さない。匿名でない実行で確かめる）\n");
    // 匿名でない実行では、同じ失敗で誤りの詳細（コード・パス・スタック）をそのまま出す（調べられる）
    const r3 = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, scoreFile, repo, out], { encoding: "utf8" });
    assert.notEqual(r3.status, 0);
    assert.ok(r3.stderr.includes("EACCES") && r3.stderr.includes(join(out, "score.json")) && r3.stderr.includes("    at "), "匿名でなければ誤りの詳細はそのまま");
  });
});

// ── 回帰用の組（regression-r1。#450。README §6）。題材の定義は subjects/R1〜R5.json、正例・負例は cases/regression/
const REG_SET = join(ev, "sets/regression-r1.json");
const REG_CASES = join(ev, "cases/regression");
/** 開発用の題材 → 対応する回帰用の題材（README §6.2 の対応表。判定の組が同じ） */
const MIRROR = { A: "R1", B: "R2", C: "R3", D: "R4", E: "R5" };

test("回帰用の組（regression-r1）は入口の検査を通り、役割は regression、5 題材 × 2 書き方の 10 本で台本を持たず、本の並びと対象範囲は開発用と同じ位置関係、題材の定義の実体が採点の指紋に入る", () => {
  const dev = loadEvalSet(join(repo, DEFAULT_SET_PATH));
  const reg = loadEvalSet(REG_SET);
  assert.equal(reg.status, "ok", reg.reasons.join("、"));
  assert.equal(reg.set.id, "regression-r1");
  assert.equal(reg.set.role, "regression");
  assert.equal(reg.set.version, 1);
  assert.deepEqual(Object.keys(reg.set.styles), Object.keys(dev.set.styles), "書き方の ID は開発用と同じ");
  assert.equal(reg.items.length, 10);
  assert.deepEqual(reg.subjects, Object.values(MIRROR));
  assert.equal(reg.scripts.size, 0, "台本は持たない（script: null）");
  assert.deepEqual(reg.items.map((it) => [it.id, it.style, it.writable]), dev.items.map((it) => [it.id, it.style, it.writable]), "本の ID・書き方・対象範囲の並びは開発用と同じ");
  assert.deepEqual(reg.items.map((it) => it.subject), dev.items.map((it) => MIRROR[it.subject]), "題材の対応は MIRROR のとおり");
  for (const it of reg.items) { assert.ok(it.requestText.length > 0, it.id); assert.equal(it.script, null, it.id); assert.ok(existsSync(it.scoringPath), it.id); assert.equal(reg.byId.get(it.id), it); }
  for (const s of reg.subjects) { const [a, b] = reg.items.filter((it) => it.subject === s); assert.notEqual(a.requestText, b.requestText, `${s}: S1 と S2 は別の文`); }
  const fp = scoringFingerprint(ev, undefined, reg.definitions);
  assert.deepEqual(fp.missing, []);
  for (const s of reg.subjects) assert.deepEqual(fileOf(fp, `definition:${s}`), { path: `definition:${s}`, source: `subjects/${s}.json`, sha256: fileOf(fp, `subjects/${s}.json`).sha256 }, s);
  assert.match(reg.sha256, HEX64);
  assert.notEqual(reg.sha256, dev.sha256);
});

test("回帰用の題材の採点の定義は、対応する開発用の題材と、構造の数・判定の種類と並び・集計の限定・書けない要件の数と鍵が同じ（README §6.2 の対応表を機械で固定する）", () => {
  for (const [devId, regId] of Object.entries(MIRROR)) {
    const a = defOf(devId), r = defOf(regId);
    assert.equal(r.id, regId);
    assert.deepEqual([r.clock, r.today], [a.clock, a.today], `${regId}: 時計`);
    assert.equal(r.structures.length, a.structures.length, `${regId}: 構造の数`);
    a.structures.forEach((sa, i) => {
      const sr = r.structures[i];
      assert.deepEqual(sr.checks.map((c) => c.kind), sa.checks.map((c) => c.kind), `${regId}/${sr.id}: 判定の種類と並び`);
      assert.deepEqual(sr.checks.map((c) => c.aggregateOnly ?? null), sa.checks.map((c) => c.aggregateOnly ?? null), `${regId}/${sr.id}: 集計の限定`);
      assert.deepEqual(sr.checks.map((c) => c.widgets ?? null), sa.checks.map((c) => c.widgets ?? null), `${regId}/${sr.id}: 部品の種類`);
      assert.equal(sr.unwritable.length, sa.unwritable.length, `${regId}/${sr.id}: 書けない要件の数`);
      assert.deepEqual(sr.unwritable.map((u) => u.keys), sa.unwritable.map((u) => u.keys), `${regId}/${sr.id}: 申告の鍵`);
      assert.deepEqual(sr.unwritable.map((u) => u.optionalIfWritten !== undefined), sa.unwritable.map((u) => u.optionalIfWritten !== undefined), `${regId}/${sr.id}: 書けたら数えない要件`);
    });
  }
});

test("回帰用の題材の定義・依頼文・正例負例に、開発用の題材の言葉（定義の題名の語）が入っていない", () => {
  // 開発用の題名（subjects/A〜E.json の title）を「の」「と」「・」で区切った語。言葉そのものは試験の文に書かず、データから引く
  const words = [...new Set(Object.keys(MIRROR).flatMap((s) => defOf(s).title.split(/[のと・]/)).filter((w) => w.length >= 2))];
  assert.ok(words.length >= 8, "題名の語が少なすぎる");
  const reg = loadEvalSet(REG_SET);
  const texts = reg.items.map((it) => [`request:${it.id}`, it.requestText]);
  for (const s of reg.subjects) texts.push([`subjects/${s}.json`, readFileSync(join(ev, "subjects", `${s}.json`), "utf8")]);
  texts.push(["sets/regression-r1.json", readFileSync(REG_SET, "utf8")]);
  for (const f of readdirSync(REG_CASES)) texts.push([`cases/regression/${f}`, readFileSync(join(REG_CASES, f), "utf8")]);
  for (const [name, text] of texts) for (const w of words) assert.ok(!text.includes(w), `${name} に開発用の題材の語（${words.indexOf(w) + 1} 番目）が入っている`);
});

test("回帰用の「1 以上」の検査（R1・R3・R4 の両方の構造）は、0 と 1 だけでなく 0 と 1 の間の値を拒否することまで求める（`> 0` の宣言を合格にしない。fix-450 指摘 1）", () => {
  let found = 0;
  for (const regId of Object.values(MIRROR)) {
    for (const st of defOf(regId).structures) {
      const numberRoles = Object.entries(st.roles).filter(([, r]) => r.field?.type === "number").map(([n]) => n);
      for (const c of st.checks.filter((c) => c.kind === "validation")) {
        for (const role of numberRoles) {
          if (!c.cases.some((k) => k.set[role] === 0 && k.valid === false)) continue; // 下限の検査ではない
          found += 1;
          assert.ok(c.cases.some((k) => k.set[role] === 1 && k.valid === true), `${regId}/${st.id}/${c.req}: 1 を通す`);
          assert.ok(c.cases.some((k) => k.set[role] > 0 && k.set[role] < 1 && k.valid === false), `${regId}/${st.id}/${c.req}: 0 と 1 の間の値を拒否する`);
        }
      }
    }
  }
  assert.equal(found, 4, "下限の検査は R1・R3・R4（主の構造と別の構造）の 4 つ");
});

test("回帰用の人ごとの集計（computedVisible の集計の限定）の sources は、件数と数の項目の合計が一致しない（件数を合計に、合計を件数に取り違えた宣言を落とせる。fix-450 指摘 3）", () => {
  let found = 0;
  for (const regId of Object.values(MIRROR)) {
    for (const st of defOf(regId).structures) {
      for (const c of st.checks.filter((c) => c.kind === "computedVisible" && c.aggregateOnly === true && c.sources)) {
        for (const [srcRole, rows] of Object.entries(c.sources)) {
          const numberRoles = Object.entries(st.roles).filter(([, r]) => r.field?.type === "number" && r.field.of === srcRole).map(([n]) => n);
          for (const role of numberRoles) for (const p of c.probes) {
            const hit = rows.filter((row) => Object.values(row.set).some((v) => v === p.recordId || (Array.isArray(v) && v.includes(p.recordId))));
            const count = hit.length, sum = hit.reduce((s, row) => s + (row.set[role] ?? 1), 0); // 未指定の数は 1（engine.mjs の recordFor と同じ）
            assert.ok(count > 0, `${regId}/${st.id}/${c.req}: ${p.recordId} に当たる行が無い`);
            assert.notEqual(count, sum, `${regId}/${st.id}/${c.req}: ${p.recordId} の件数 ${count} と ${role} の合計 ${sum} が同じ（取り違えを検出できない）`);
            found += 1;
          }
        }
      }
    }
  }
  assert.equal(found, 5, "数の項目を持つ主役の集計は R1（2 人）・R3（1 人）・R4 の主の構造（2 人）");
});

test("R1 の採点の定義は主役に名前用の string の項目を求める役割を持ち、名前を省いた宣言は役割が見つからず落ちる（fix-450 指摘 2）", () => {
  const st = defOf("R1").structures[0];
  const mainRole = Object.entries(st.roles).find(([, r]) => r.entity && !r.entity.hasFieldTypes)?.[0];
  assert.ok(mainRole, "制約の無い entity の役割（主役）");
  assert.ok(Object.values(st.roles).some((r) => r.field?.of === mainRole && r.field.type === "string"), "主役の string の項目の役割");
  const index = JSON.parse(readFileSync(join(REG_CASES, "cases.json"), "utf8"));
  const c = index.find((c) => c.subject === "R1" && c.structure === null);
  assert.ok(c, "R1 に役割が見つからない負例がある");
  assert.deepEqual([c.expect, c.failed], ["FAIL", ["役割が見つかる"]]);
});

test("回帰用の題材の正例・負例（cases/regression）は、凍結した v5 で索引どおりに採点される：最終の判定だけでなく、当てはまる構造・落ちる判定の集合・静的 NG の診断コード・written・申告の判定と挙げ漏れの数まで一致する。索引とファイルが一致し、どの題材にも正例と負例がある", async () => {
  const engine = await import(pathToFileURL(join(repo, "packages/spec-engine/dist/index.js")).href);
  const index = JSON.parse(readFileSync(join(REG_CASES, "cases.json"), "utf8"));
  assert.deepEqual(readdirSync(REG_CASES).filter((f) => f !== "cases.json").sort(), index.map((c) => c.file).sort(), "索引と置き場所のファイルが一致する");
  const reg = loadEvalSet(REG_SET);
  await withOut(async (base) => {
    const seen = new Map();
    let alternates = 0;
    for (const c of index) {
      assert.ok(reg.subjects.includes(c.subject), `${c.file}: 組に無い題材`);
      assert.ok(typeof c.why === "string" && c.why.length > 0, `${c.file}: why`);
      assert.ok(c.structure === null || typeof c.structure === "string", `${c.file}: structure は構造の id か null`);
      assert.ok(Array.isArray(c.failed) && c.failed.every((k) => typeof k === "string"), `${c.file}: failed は落ちる判定の名前の並び`);
      assert.ok(c.expect !== "STATIC_NG" || (Array.isArray(c.codes) && c.codes.length > 0), `${c.file}: 静的 NG は診断コードを期待する`);
      assert.ok(c.expect !== "FAIL" || c.failed.length > 0 || c.claims === "NG", `${c.file}: 負例は落ちる判定か申告 NG のどちらかを期待する`);
      const data = JSON.parse(readFileSync(join(REG_CASES, c.file), "utf8"));
      assert.ok(Array.isArray(data.spec) && data.spec.length > 0 && data.spec.every((l) => typeof l === "string"), `${c.file}: spec は宣言の行の配列`);
      const specPath = join(base, c.file.replace(/\.json$/, ".app.spec.yaml"));
      writeFileSync(specPath, `${data.spec.join("\n")}\n`);
      const def = loadDef(join(ev, "subjects", `${c.subject}.json`));
      const r = await score(engine, specPath, def);
      const claims = data.log ? scoreClaims(data.log, def, r.structure, r.written) : null;
      const got = finalVerdict(r, claims);
      const failed = Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k).sort();
      assert.equal(got, c.expect, `${c.file}: expect=${c.expect} got=${got} [${r.structure ?? "-"}] ${r.verdict === "STATIC_NG" ? r.codes.join(",") : failed.join("・")}`);
      assert.equal(r.structure, c.structure, `${c.file}: 当てはまる構造`);
      assert.deepEqual(failed, [...c.failed].sort(), `${c.file}: 落ちる判定の集合`);
      assert.deepEqual(r.codes, c.codes ?? [], `${c.file}: 診断コード`);
      if (c.written !== undefined) assert.deepEqual(r.written, c.written, `${c.file}: written`);
      if (c.claims !== undefined) { assert.ok(claims, `${c.file}: 申告の期待があるのに log が無い`); assert.equal(claims.verdict, c.claims, `${c.file}: 申告の判定`); }
      if (c.missed !== undefined) assert.equal(claims?.missed, c.missed, `${c.file}: 申告の挙げ漏れの数`);
      // 宣言の判定：落ちる判定が無ければ、主の構造は PASS・別の構造は PASS_NEEDS_CLAIM（申告で最終が決まる）
      if (r.structure !== null) assert.equal(r.verdict, failed.length > 0 ? "FAIL" : r.structure === def.structures[0].id ? "PASS" : "PASS_NEEDS_CLAIM", `${c.file}: 宣言の判定`);
      if (r.structure !== null && r.structure !== def.structures[0].id) {
        alternates += 1;
        assert.ok(r.requiresClaim, `${c.file}: 別の構造は申告が要る`);
        if (got === "PASS") assert.deepEqual([r.verdict, claims?.missed], ["PASS_NEEDS_CLAIM", 0], `${c.file}: 別の構造の合格は申告で決まる`);
      }
      if (!seen.has(c.subject)) seen.set(c.subject, new Set());
      seen.get(c.subject).add(got);
    }
    for (const s of reg.subjects) {
      assert.ok(seen.get(s)?.has("PASS"), `${s}: 正例が無い`);
      assert.ok(seen.get(s)?.has("FAIL") || seen.get(s)?.has("STATIC_NG"), `${s}: 負例が無い`);
    }
    assert.ok(alternates >= 3, "別の構造の正例と負例（申告なし・下限の誤り）が要る");
    assert.ok(index.some((c) => c.expect === "STATIC_NG"), "無い語彙を発明した負例が要る");
    assert.ok(index.some((c) => c.expect === "FAIL" && c.failed.length === 0 && c.claims === "NG" && c.missed === 1), "宣言は全部満たすが申告の挙げ漏れで落ちる負例が要る");
    assert.ok(index.some((c) => c.expect === "FAIL" && c.failed.length > 0 && c.claims === "OK" && c.written), "申告 OK のまま順位の判定だけが落ちる負例が要る");
  });
});

// ── Plan の表と Build の表（#493）
const stg = (stage, ms, status = "ok") => ({ stage, status, duration_ms: ms });
/** 診断の出力の本を置く：起動の記録（Build の段と plan_cost）・往復の記録（Plan の段・往復・結果）・宣言（あれば） */
function addDiagRun(out, id, { spec = null, build = null, planCost, record }) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  const summary = build === null ? null : { schema_version: "commandagent.headless-summary/v1", verdict: build.verdict, stop_reason: build.verdict === "none" ? "unmet" : "completed", provider_cost_usd: build.provider ?? 0, failure: null, stages: build.stages };
  writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: build?.verdict === "none" || build === null ? 1 : 0, wall_s: 100, summary, plan_cost: { schema_version: "musunest-factory/plan-build-cost/v1", ...planCost, total_usd: planCost.plan_usd + planCost.build_usd }, stderr_tail: "", resumed: false }));
  writeFileSync(join(dir, "stdout.log"), "");
  writeFileSync(join(dir, "stderr.log"), "");
  if (spec !== null) writeFileSync(join(dir, "bundle/artifacts/app.spec.yaml"), spec);
  writeFileSync(join(dir, "bundle/plan-record.json"), JSON.stringify({ schema_version: "musunest-factory/plan-cli-record/v1", plan_id: "plan-t", spent_usd: 0.5, ...record }));
}
const qRound = (n) => ({ questions: Array.from({ length: n }, (_, i) => ({ id: `Q-${i}`, text: "MARK_QUESTION_TEXT" })), answers: [] });

test("Plan の表と Build の表：確定・確定できない・止まった・Build 失敗を混ぜた診断の出力で、1 本 1 行と合計が等しい。Build の表は確定した本だけで、外した本を数で示す。既存の行・指標は変えず、匿名の口には件数と率だけ", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    // 確定 → Build 合格
    addDiagRun(out, "P1-r1", { spec: PASS_A, build: { verdict: "partial", stages: [stg("design", 1000), stg("write", 300), stg("judge", 0)] }, planCost: { plan_usd: 0.02, build_usd: 0.05 },
      record: { outcome: "confirmed", rounds: [qRound(2)], stages: [stg("requirements", 4000), stg("questions", 500), stg("answers", 7000), stg("confirm", 10)] } });
    // 確定 → Build 失敗（宣言が無い）
    addDiagRun(out, "P1-r2", { build: { verdict: "none", stages: [stg("design", 2000, "failed")] }, planCost: { plan_usd: 0.03, build_usd: 0.01 },
      record: { outcome: "confirmed", rounds: [qRound(1), qRound(3)], stages: [stg("requirements", 3000), stg("questions", 200), stg("answers", 1000), stg("questions", 300), stg("answers", 2000), stg("confirm", 20)] } });
    // 確定 → Build は宣言を出したが採点で落ちる
    addDiagRun(out, "P1-r3", { spec: FAIL_A, build: { verdict: "partial", stages: [stg("design", 500), stg("write", 100)] }, planCost: { plan_usd: 0.01, build_usd: 0.04 },
      record: { outcome: "confirmed", rounds: [], stages: [stg("requirements", 1000), stg("confirm", 5)] } });
    // 確定できない（理由の分類は source:code。値でない分類は unknown にまとめる）
    addDiagRun(out, "P1-r4", { planCost: { plan_usd: 0.015, build_usd: 0 },
      record: { outcome: "cannot-confirm", rounds: [], stages: [stg("requirements", 2500), stg("surface", 600)], cannot_confirm: [{ source: "surface-check", code: "not-stated", path: "unwritable[0]" }, { source: "surface-check", code: "not-stated", path: "unwritable[1]" }, { source: "confirm", code: "MARK_CODE 原文", path: "x" }] } });
    // 止まった（失敗あり）・止まった（失敗なし ＝ declined）
    addDiagRun(out, "P1-r5", { planCost: { plan_usd: 0.005, build_usd: 0 }, record: { outcome: "stopped", rounds: [qRound(1)], stages: [stg("requirements", 900, "failed")], failure: { stage: "requirements", kind: "deadline" } } });
    addDiagRun(out, "P1-r6", { planCost: { plan_usd: 0.002, build_usd: 0 }, record: { outcome: "stopped", rounds: [], stages: [stg("requirements", 100)], failure: null } });
    const ids = ["P1-r1", "P1-r2", "P1-r3", "P1-r4", "P1-r5", "P1-r6"];
    planConditions(out, ids);
    const r = scoreRun(out);
    const full = readScore(out);
    // 既存の行と指標は今のまま（新しい欄は行に入らない。費用は Plan と Build の合計のまま）
    assert.equal(rowOf(full, "P1-r1").verdict, "PASS");
    assert.equal(rowOf(full, "P1-r2").generation_failed, true);
    assert.equal(rowOf(full, "P1-r3").verdict, "FAIL");
    assert.equal(rowOf(full, "P1-r1").cost_usd, 0.07);
    for (const row of full.rows) assert.equal("tables" in row, false);
    startsWith(full.metrics.generated, "2/6（");
    const { plan, build } = full.tables;
    // Plan の表：全本 1 行
    assert.deepEqual(plan.rows.map((x) => [x.run, x.outcome, x.confirmed, x.stop, x.questions, x.rounds, x.stages.total_ms, x.usd]), [
      ["P1-r1", "confirmed", true, null, 2, 1, 11510, 0.02],
      ["P1-r2", "confirmed", true, null, 4, 2, 6520, 0.03],
      ["P1-r3", "confirmed", true, null, 0, 0, 1005, 0.01],
      ["P1-r4", "cannot-confirm", false, { kind: "cannot-confirm", classes: ["confirm:unknown", "surface-check:not-stated"], reasons: 3 }, 0, 0, 3100, 0.015],
      ["P1-r5", "stopped", false, { kind: "stopped", classes: ["requirements:deadline"], reasons: 1 }, 1, 1, 900, 0.005],
      ["P1-r6", "stopped", false, { kind: "stopped", classes: ["declined"], reasons: 1 }, 0, 0, 100, 0.002],
    ]);
    // 往復ごとの待ち時間（answers）は段ごとの時間に入り、繰り返す段は回数と合計
    assert.deepEqual(plan.rows[1].stages.by_stage, { requirements: { count: 1, ms: 3000 }, questions: { count: 2, ms: 500 }, answers: { count: 2, ms: 3000 }, confirm: { count: 1, ms: 20 } });
    assert.deepEqual({ ...plan.total, confirmed: plan.total.confirmed.split("（")[0] }, {
      runs: 6, outcomes: { confirmed: 3, "cannot-confirm": 1, stopped: 2, unknown: 0, absent: 0 }, confirmed: "3/6",
      stop_classes: { "confirm:unknown": 1, "surface-check:not-stated": 1, "requirements:deadline": 1, declined: 1 },
      questions: 7, rounds: 4,
      stages: { by_stage: { requirements: { count: 6, ms: 11500 }, questions: { count: 3, ms: 1000 }, answers: { count: 3, ms: 10000 }, confirm: { count: 3, ms: 35 }, surface: { count: 1, ms: 600 } }, total_ms: 23135 },
      usd: "0.0820",
    });
    // Build の表：確定した本だけ。PASS は既存の採点の行のまま
    assert.deepEqual(build.rows.map((x) => [x.run, x.factory_verdict, x.verdict, x.pass, x.stages.total_ms, x.usd]), [
      ["P1-r1", "partial", "PASS", true, 1300, 0.05],
      ["P1-r2", "none", "GEN_FAIL", false, 2000, 0.01],
      ["P1-r3", "partial", "FAIL", false, 600, 0.04],
    ]);
    assert.deepEqual({ ...build.total, pass: build.total.pass.split("（")[0] }, {
      runs: 3, excluded: 3, excluded_outcomes: { "cannot-confirm": 1, stopped: 2, unknown: 0, absent: 0 },
      denominator: "Plan が確定した本 3 本（全 6 本から 3 本を外した）",
      factory_verdicts: { partial: 2, none: 1 }, pass: "1/3",
      stages: { by_stage: { design: { count: 3, ms: 3500 }, write: { count: 2, ms: 400 }, judge: { count: 1, ms: 0 } }, total_ms: 3900 },
      usd: "0.1000",
    });
    // 値（問いの文・分類でない文字列）は表に入らない。標準出力に表の合計が出る
    const text = JSON.stringify(full.tables);
    for (const word of ["MARK_QUESTION_TEXT", "MARK_CODE", "原文"]) assert.ok(!text.includes(word), `表に ${word}`);
    assert.match(r.stdout, /Plan の表: 6 本（確定 3\/6（/);
    assert.match(r.stdout, /Build の表: Plan が確定した本 3 本（全 6 本から 3 本を外した）・PASS 1\/3（/);
    // 匿名の口：件数と率だけ（行・分類のコード・時間・費用は出さない）
    const a = anonymize(full);
    assert.deepEqual(a.tables, {
      plan: { runs: 6, outcomes: { confirmed: 3, "cannot-confirm": 1, stopped: 2, unknown: 0, absent: 0 }, confirmed: plan.total.confirmed, questions: 7, rounds: 4 },
      build: { runs: 3, excluded: 3, excluded_outcomes: { "cannot-confirm": 1, stopped: 2, unknown: 0, absent: 0 }, factory_verdicts: { full: 0, partial: 2, none: 1, unknown: 0 }, pass: build.total.pass },
    });
    const at = JSON.stringify(a.tables);
    for (const word of [...ids, "deadline", "not-stated", "declined"]) assert.ok(!at.includes(word), `匿名の表に ${word}`);
    const ar = scoreRun(out, ["--anonymous"]);
    assert.deepEqual(JSON.parse(ar.stdout).tables, a.tables);
  });
});

test("Plan の表と Build の表：往復の記録の無い本は absent として Plan の表に残り、Build の表の分母から外す。結果が既知でない記録は unknown", () => {
  const t = planBuildTables([
    { run: "X-r1", pr: null, sl: { plan_cost: null, summary: { verdict: "full", provider_cost_usd: 0.1, stages: [stg("design", 10)] } }, row: { verdict: "PASS" } },
    { run: "X-r2", pr: { outcome: "MARK_OUTCOME", rounds: [qRound(1)], stages: [stg("requirements", 5)], spent_usd: 0.2 }, sl: null, row: null },
    { run: "X-r3", pr: { outcome: "confirmed", rounds: [], stages: [], spent_usd: 0.3 }, sl: { plan_cost: null, summary: { verdict: "full", provider_cost_usd: 0.1, stages: [stg("design", 10)] } }, row: { verdict: "PASS" } },
  ]);
  assert.deepEqual(t.plan.rows.map((x) => [x.run, x.outcome, x.stop, x.usd]), [["X-r1", "absent", null, 0], ["X-r2", "unknown", { kind: "unknown", classes: [], reasons: 0 }, 0.2], ["X-r3", "confirmed", null, 0.3]]);
  assert.deepEqual(t.plan.total.outcomes, Object.fromEntries(PLAN_TABLE_OUTCOMES.map((k) => [k, k === "absent" || k === "unknown" || k === "confirmed" ? 1 : 0])));
  startsWith(t.plan.total.confirmed, "1/2（");
  assert.equal(t.plan.total.questions, 1);
  assert.deepEqual(t.build.rows.map((x) => [x.run, x.verdict, x.pass, x.usd]), [["X-r3", "PASS", true, 0.1]]);
  assert.deepEqual([t.build.total.runs, t.build.total.excluded, t.build.total.excluded_outcomes], [1, 2, { "cannot-confirm": 0, stopped: 0, unknown: 1, absent: 1 }]);
  assert.ok(!JSON.stringify(t).includes("MARK_OUTCOME"));
});

// ── 評価の種類・Plan の集計・Build だけの集計（#498。README §5.2・§5.3）
const V4 = CONDITIONS_SCHEMAS[3];
const METRICS_KEYS = ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd", "factory_verdicts"];
const PLAN_RECORD_SCHEMA = "musunest-factory/plan-cli-record/v1";
/** 本を 1 つ置く（#498）。sl は起動の記録の欄（既定は exit 0・ok・要約なし）。record・envelope・buildRecord は往復の記録・包み・Build だけの記録（文字列ならそのまま書く） */
function addRun498(out, id, { sl = {}, record, envelope, buildRecord, stdout = "", spec = null, summary = true } = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  if (summary) {
    writeFileSync(join(dir, "summary.line.json"), JSON.stringify({ exit: 0, wall_s: 1, exit_class: "ok", summary: null, plan_cost: null, stderr_tail: { bytes: 0, known_lines: 0 }, resumed: false, ...sl }));
    writeFileSync(join(dir, "stdout.log"), stdout);
    writeFileSync(join(dir, "stderr.log"), "");
  }
  if (spec !== null) writeFileSync(join(dir, "bundle/artifacts/app.spec.yaml"), spec);
  const put = (rel, v, head = {}) => { if (v !== undefined) writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify({ ...head, ...v })); };
  put("bundle/plan-record.json", record, { schema_version: PLAN_RECORD_SCHEMA, plan_id: "plan-t" });
  put(PLAN_RESULT_PATH, envelope);
  put(BUILD_RECORD_PATH, buildRecord);
}
/** v4 の条件のファイル（params.mode。extra.params で params を差し替える） */
const cond4 = (out, ids, mode, extra = {}) => { mkdirSync(out, { recursive: true }); conditions(out, ids, { schema: V4, params: { ...paramsFor(ids), plan: mode === "e2e", mode }, scripts: { mode: "post-hoc", fingerprint: null, files: [] }, frozen: null, ...extra }); };
const PSHA = (p) => sha256(`plan-${p}`), SSHA = (p) => sha256(`source-${p}`);
/** 凍結した組のファイルを置き、run-agent.mjs が条件に書く frozen の形を返す */
function frozenOf(base, adopted, missing, name = "frozen-plan-set.json") {
  const path = writeJson(join(base, "frozen", name), { schema: "musunest-eval/frozen-plan-set/v1", id: "t-frozen", version: 1, adopted: adopted.map((p) => ({ pattern: p })), missing: missing.map((p) => ({ pattern: p })) });
  return { path, sha256: sha256(readFileSync(path)), id: "t-frozen", version: 1, origin: "frozen-plan", author: null, adopted: adopted.map((p) => ({ pattern: p, plan_sha256: PSHA(p), source_sha256: SSHA(p), envelope_sha256: sha256(`envelope-${p}`) })), missing };
}
const buildRec = (p, returnToPlan, over = {}) => ({ schema_version: "musunest-factory/build-cli-record/v1", conditions: null, plan_sha256: PSHA(p), source_sha256: SSHA(p), return_to_plan: returnToPlan, ...over });
const head = (rate) => rate.split("（")[0];
const runIds = (p, n) => Array.from({ length: n }, (_, i) => `${p}-r${i + 1}`);

test("評価の種類：v1〜v3 は params.plan から e2e か build、v4 は params.mode（既知でない値は unknown）、条件が無ければ null。build_applicable は plan-only だけ偽", async () => {
  const [V1x, V2x, V3x] = CONDITIONS_SCHEMAS;
  for (const schema of [V1x, V2x, V3x]) {
    assert.deepEqual(evaluationOf({ schema, params: { plan: true } }), { mode: "e2e", build_applicable: true });
    assert.deepEqual(evaluationOf({ schema, params: { plan: false } }), { mode: "build", build_applicable: true });
    assert.deepEqual(evaluationOf({ schema, params: { mode: "plan-only" } }), { mode: "build", build_applicable: true }, "v1〜v3 は params.mode を読まない");
  }
  for (const mode of ["build", "e2e", "plan-only", "build-from"]) assert.deepEqual(evaluationOf({ schema: V4, params: { mode, plan: true } }), { mode, build_applicable: mode !== "plan-only" });
  assert.deepEqual(evaluationOf({ schema: V4, params: { mode: "leak-marker-text" } }), { mode: "unknown", build_applicable: true });
  assert.deepEqual(evaluationOf(null), { mode: null, build_applicable: true });
  await withOut(async (base) => {
    // 条件の無い出力先：mode は null、新しい集計は null
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(full.evaluation, { mode: null, build_applicable: true });
    assert.equal(full.metrics_plan, null);
    assert.equal(full.metrics_build, null);
    assert.deepEqual(anonymize(full).evaluation, { mode: null, build_applicable: true });
    // v4 の build の出力先（新しい集計は null）・v2 の Plan を通した出力先（e2e）
    const out2 = join(base, "out2");
    addRun(out2, "P1-r1", { spec: PASS_A });
    cond4(out2, ["P1-r1"], "build");
    scoreRun(out2);
    assert.deepEqual([readScore(out2).evaluation.mode, readScore(out2).metrics_plan, readScore(out2).metrics_build], ["build", null, null]);
    const out3 = join(base, "out3");
    addRun(out3, "P1-r1", { spec: PASS_A });
    planConditions(out3, ["P1-r1"]);
    scoreRun(out3);
    assert.equal(readScore(out3).evaluation.mode, "e2e");
    assert.equal(readScore(out3).metrics_plan.runs, 1);
  });
});

test("時間と費用の集計：実測の 0 は observed に入り、欠測と区別する。偶数本の中央値は真ん中 2 つの平均。読めた本が 0 なら合計と中央値は null", () => {
  assert.deepEqual(stat4([0, null, 300, 1500, undefined, 2000, "x"]), { observed: 4, missing: 3, total: 3800, median: 900 });
  assert.deepEqual(stat4([5, 1, 3]), { observed: 3, missing: 0, total: 9, median: 3 });
  assert.deepEqual(stat4([null, Number.NaN]), { observed: 0, missing: 2, total: null, median: null });
  assert.deepEqual(stat4([0.1, 0.2]), { observed: 2, missing: 0, total: 0.3, median: 0.15 });
});

test("Plan の集計（e2e）：確定・確定できない・止まった・記録なし・途中・未実行を混ぜても、分母は予定した全本。内訳・確定の率・問数と往復の合計と平均・時間と費用の 4 つが期待値と等しく、既存の metrics・tables は変わらない", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun498(out, "P1-r1", { spec: PASS_A, sl: { plan_cost: { plan_usd: 0.02, build_usd: 0.05, total_usd: 0.07 } }, record: { outcome: "confirmed", rounds: [qRound(2)], stages: [stg("requirements", 1000), stg("confirm", 500)], spent_usd: 0.9 } });
    addRun498(out, "P1-r2", { sl: { exit: 1, exit_class: "failed" }, record: { outcome: "cannot-confirm", rounds: [qRound(1), qRound(3)], stages: [], spent_usd: 0.01, cannot_confirm: [{ source: "session", code: "question-limit", path: "open_issues" }] } });
    addRun498(out, "P1-r3", { sl: { exit: 1, exit_class: "failed", plan_cost: { plan_usd: 0, build_usd: 0, total_usd: 0 } }, record: { outcome: "stopped", rounds: [], stages: [stg("requirements", 300)], failure: { stage: "requirements", kind: "deadline" } } });
    addRun498(out, "P1-r4", { spec: FAIL_A }); // 起動の記録はあるが往復の記録が無い（記録なし）
    addRun498(out, "P1-r6", { summary: false, record: { outcome: "confirmed", rounds: [qRound(9)], stages: [stg("requirements", 9)] } }); // 途中の本（数えない）
    addRun498(out, "P1-r7", { spec: PASS_A, sl: { plan_cost: { plan_usd: 0.04, build_usd: 0.01, total_usd: 0.05 } }, record: { outcome: "confirmed", rounds: [qRound(1)], stages: [stg("requirements", 2000)] } });
    const ids = runIds("P1", 7); // P1-r5 は未実行
    cond4(out, ids, "e2e");
    const r = scoreRun(out);
    const full = readScore(out);
    const mp = full.metrics_plan;
    assert.deepEqual(full.evaluation, { mode: "e2e", build_applicable: true });
    assert.equal(full.metrics_build, null);
    assert.deepEqual([mp.runs, mp.unexecuted, mp.incomplete, mp.unrecorded], [7, 1, 1, 1]);
    assert.equal(mp.denominator, "予定した本 7 本（未実行 1・途中 1・記録なし 1 を含む）");
    assert.deepEqual(mp.outcomes, { confirmed: 2, "cannot-confirm": 1, stopped: 1, unknown: 0, absent: 3 });
    startsWith(mp.confirmed, "2/7（");
    assert.deepEqual(mp.stop_classes, { "session:question-limit": 1, "requirements:deadline": 1 });
    assert.deepEqual(mp.questions, { total: 7, mean: 1.75, runs: 4 });
    assert.deepEqual(mp.rounds, { total: 4, mean: 1, runs: 4 });
    // 時間：1500・0（実測の 0）・300・2000、欠測 3（記録なし・途中・未実行）。偶数本の中央値は (300 + 1500) / 2
    assert.deepEqual(mp.duration_ms, { observed: 4, missing: 3, total: 3800, median: 900 });
    // 費用：起動の記録の Plan の額（0.02・0（実測の 0）・0.04）、無ければ往復の記録の使った額（0.01）
    assert.deepEqual(mp.usd, { observed: 4, missing: 3, total: 0.07, median: 0.015 });
    assert.equal(mp.script, null);
    assert.equal(mp.envelope, null);
    // 既存の metrics・tables は、条件の無い採点（新しい分岐を通らない）と同じ。metrics の鍵の並びも同じ
    const plain = join(base, "plain");
    cpSync(out, plain, { recursive: true });
    rmSync(join(plain, "conditions.json"));
    scoreRun(plain);
    const before = readScore(plain);
    assert.deepEqual(full.metrics, before.metrics);
    assert.deepEqual(full.tables, before.tables);
    assert.deepEqual(full.rows.map((x) => [x.run, x.verdict ?? null, x.plan]), before.rows.map((x) => [x.run, x.verdict ?? null, x.plan]));
    assert.deepEqual(Object.keys(full.metrics), METRICS_KEYS);
    startsWith(full.metrics.generated, "3/6（");
    assert.equal(full.tables.build.total.denominator, "Plan が確定した本 3 本（全 6 本から 3 本を外した）", "表は今と同じ（途中の本も往復の記録があれば数える）");
    // 匿名の口：件数・率・4 つの集計だけ。止まり方の分類の符号は出さない。metrics の鍵の並びは今と同じ
    const a = anonymize(full);
    assert.deepEqual(Object.keys(a.metrics), METRICS_KEYS);
    assert.deepEqual(a.evaluation, { mode: "e2e", build_applicable: true });
    assert.equal(mp.record_unreadable, 0);
    assert.deepEqual(a.metrics_plan, { runs: 7, unexecuted: 1, incomplete: 1, unrecorded: 1, record_unreadable: 0, outcomes: mp.outcomes, confirmed: mp.confirmed, questions: mp.questions, rounds: mp.rounds, free_text: mp.free_text, duration_ms: mp.duration_ms, usd: mp.usd, script: null, envelope: null });
    assert.equal(a.metrics_build, null);
    for (const w of ["question-limit", "deadline", "P1-r"]) assert.ok(!JSON.stringify(a).includes(w), `匿名に ${w}`);
    assert.match(r.stdout, /Plan の集計（e2e）: 予定した本 7 本（未実行 1・途中 1・記録なし 1 を含む）・確定 2\/7（/);
    const ar = scoreRun(out, ["--anonymous"]);
    assert.deepEqual(JSON.parse(ar.stdout), a);
  });
});

test("Plan の集計の自由入力：文字列の答えだけを数え、null の答えは 0。記録の形（rounds・answers が配列）を読めない本は unreadable で、読めて 0 件の本と区別する", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const q = Q_HOW();
    addRun498(out, "P1-r1", { record: { outcome: "confirmed", rounds: [round([q, Q_HOW("Q1-2")], [{ id: "A:1", question_id: q.id, choice_id: null, free_text: "leak-marker-text" }, { id: "A:2", question_id: "Q1-2", choice_id: "c1", free_text: null }])] } });
    addRun498(out, "P1-r2", { record: { outcome: "confirmed", rounds: [round([q], [{ id: "A:1", question_id: q.id, choice_id: null, free_text: "leakmarkertext" }]), round([], [])] } });
    addRun498(out, "P1-r3", { record: { outcome: "confirmed", rounds: [round([q], [answered(q, "c1")])] } }); // 読めて 0 件
    addRun498(out, "P1-r4", { record: { outcome: "stopped", rounds: null } }); // rounds が配列でない
    addRun498(out, "P1-r5", { record: { outcome: "stopped", rounds: [{ questions: [], answers: "x" }] } }); // answers が配列でない
    addRun498(out, "P1-r6", { record: { outcome: "stopped", rounds: { leak: "leak-marker-text" } } }); // rounds が写像（既存の行の組み立てでも止まらない）
    addRun498(out, "P1-r7", { record: "{ leak-marker-text leakmarkertext" }); // JSON でない記録
    addRun498(out, "P1-r8", { record: { outcome: "stopped", rounds: ["leak-marker-text", null] } }); // 往復が写像でない
    cond4(out, runIds("P1", 8), "e2e");
    for (const extra of [[], ["--anonymous"]]) { const rx = scoreRun(out, extra); for (const w of ["leak-marker-text", "leakmarkertext"]) assert.ok(!rx.stdout.includes(w) && !rx.stderr.includes(w), `${extra.join("") || "通常"}の出力に ${w}`); }
    const r = scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(full.metrics_plan.free_text, { answers: 2, runs: 3, unreadable: 5 });
    assert.equal(full.metrics_plan.record_unreadable, 1);
    assert.deepEqual(anonymize(full).metrics_plan.free_text, { answers: 2, runs: 3, unreadable: 5 });
    assert.deepEqual([rowOf(full, "P1-r6").plan.questions, rowOf(full, "P1-r6").plan.rounds, rowOf(full, "P1-r7").plan], [0, 0, null], "既存の行は読めない形を 0・記録なしに写す");
    assert.deepEqual(full.metrics_plan.questions, { total: 4, mean: 0.8, runs: 5 }, "rounds が配列でない本は問数の平均の分母に入らない");
    for (const w of ["leak-marker-text", "leakmarkertext"]) {
      assert.ok(!JSON.stringify([full.metrics_plan, full.tables, full.evaluation]).includes(w), `新しい欄・表に ${w}`);
      assert.ok(!r.stdout.includes(w) && !r.stderr.includes(w), `標準出力・標準エラーに ${w}`);
    }
  });
});

test("実行中の台本（scripts.mode が live）：照合の状態ごとの件数（知らない状態は unknown-state）と、全問 answered の本の率。0 問の本と照合の記録の欠けた本は別に数え、分子に入れない", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    // 問いは質問 ID と版を持ち、照合の記録は同じ ID と版で 1 対 1 に対応させる
    const qs = (tag, n, rev = 1) => ({ questions: Array.from({ length: n }, (_, k) => ({ id: `${tag}-${k}`, revision: rev, text: "MARK_QUESTION_TEXT" })), answers: [] });
    const m = (tag, k, state, rev = 1) => ({ question_id: `${tag}-${k}`, revision: rev, state, entry_index: null });
    const rec = (outcome, rounds, matches) => ({ outcome, rounds, ...(matches === undefined ? {} : { script: { sha256: sha256("s"), matcher: "v1", matches } }) });
    addRun498(out, "P1-r1", { record: rec("confirmed", [qs("a", 1), qs("b", 1, 2)], [m("a", 0, "answered"), m("b", 0, "answered", 2)]) }); // 2 往復の全問が answered
    addRun498(out, "P1-r2", { record: rec("confirmed", [qs("c", 2)], [m("c", 0, "answered"), m("c", 1, "duplicate")]) });
    addRun498(out, "P1-r3", { record: rec("confirmed", [], []) }); // 0 問
    addRun498(out, "P1-r4", { record: rec("confirmed", [qs("d", 1)]) }); // 照合の記録が無い
    addRun498(out, "P1-r5", { record: rec("cannot-confirm", [qs("e", 3)], [m("e", 0, "no-choice"), m("e", 1, "stale-revision"), m("e", 2, "leak-marker-text")]) });
    addRun498(out, "P1-r6", { record: rec("cannot-confirm", [qs("f", 1)], [m("f", 0, "unknown")]) });
    addRun498(out, "P1-r7"); // 往復の記録の無い本（台本の分母に入らない）
    // 対応しない照合の記録（どれも unrecorded。answered の件数には入るが、率の分子に入れない）
    addRun498(out, "P1-r8", { record: rec("confirmed", [qs("g", 2)], [m("g", 0, "answered")]) }); // 2 問のうち 1 問だけ
    addRun498(out, "P1-r9", { record: rec("confirmed", [qs("h", 1)], []) }); // 空の照合の配列
    addRun498(out, "P1-r10", { record: rec("confirmed", [qs("i", 2)], [m("i", 0, "answered"), m("i", 0, "answered")]) }); // 同じ問いが重なり、1 問が欠ける
    addRun498(out, "P1-r11", { record: rec("confirmed", [qs("j", 1)], [m("j", 0, "answered", 2)]) }); // 版が違う
    addRun498(out, "P1-r12", { record: rec("confirmed", [qs("k", 1)], [m("k", 0, "answered"), m("k", 1, "answered")]) }); // 余る
    addRun498(out, "P1-r13", { record: rec("confirmed", [{ questions: [{ id: "l-0", text: "x" }], answers: [] }], [{ question_id: "l-0", state: "answered" }]) }); // 版が読めない
    cond4(out, runIds("P1", 13), "e2e", { scripts: { mode: "live", fingerprint: null, files: [] } });
    const r = scoreRun(out);
    const full = readScore(out);
    const sc = full.metrics_plan.script;
    assert.deepEqual({ ...sc, all_answered: head(sc.all_answered) }, { mode: "live", runs: 12, states: { answered: 10, unknown: 1, duplicate: 1, "no-choice": 1, "stale-revision": 1, "unknown-state": 1 }, all_answered: "1/12", no_questions: 1, unrecorded: 7 });
    assert.deepEqual(Object.keys(sc.states), [...SCRIPT_MATCH_STATES, "unknown-state"]);
    assert.deepEqual(anonymize(full).metrics_plan.script, sc);
    assert.ok(!JSON.stringify(full.metrics_plan).includes("leak-marker-text"));
    assert.ok(!r.stdout.includes("leak-marker-text"));
    // 事後の台本の集計（metrics_script）は今のまま（mode は post-hoc）。匿名の当て方の既知の値に live が入った
    assert.equal(full.metrics_script.mode, SCRIPT_MODE);
    assert.equal(anonymize({ ...full, metrics_script: { ...full.metrics_script, mode: "live" } }).metrics_script.mode, "live");
  });
});

/** Plan だけの計測の出力先（#498 の (e)）：台本を持つ組・6 本の包み（1 本は通り、5 本はそれぞれ 1 つの理由で落ちる） */
async function planOnlyFixture(base, { markers = false } = {}) {
  const mk = (x) => (markers ? x : "");
  const scriptA = writeJson(join(base, "set/scripts/A.json"), scriptOf("A", [entry("A:e1", ["MARK_OI"], { choose: ["MARK_C1"] })]));
  const setPath = writeJson(join(base, "set/t-set.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A", { script: "scripts/A.json", request: [`MARK_REQ_P1 ${mk("leak-marker-text")}`, `MARK_LINE2 ${mk("leakmarkertext")}`] })] });
  const loaded = loadEvalSet(setPath);
  assert.equal(loaded.status, "ok", loaded.reasons.join("、"));
  assert.ok(existsSync(scriptA));
  const source = sha256(loaded.byId.get("P1").requestText + "\n");
  const requirements = markers ? [req("R:1", "leak-marker-text leakmarkertext")] : [];
  const plan = await planFixture({ requirements });
  const tampered = await planFixture({ requirements, tamper: (p) => { p.revision += 1; } });
  const env = async (p, over = {}) => ({ schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "confirmed", plan: p, plan_sha256: await planDigest(p), source_sha256: source, conditions: null, stop: null, ...over });
  // 台本の鍵（MARK_OI）は問いの文に無く、確定した仕様の事項の文（OI:1）にだけある
  const q = question("Q1-1", "MARK_Q?", [{ id: "c1", text: "MARK_C1" }, { id: "c2", text: "MARK_C2" }], "c1", { open_issue_id: "OI:1" });
  const rec = (outcome) => ({ outcome, rounds: [round([q], [answered(q, "c1")])], stages: [stg("requirements", 10)] });
  const out = join(base, "out");
  addRun498(out, "P1-r1", { sl: { exit: 0, exit_class: "ok" }, record: rec("confirmed"), envelope: await env(plan) });
  addRun498(out, "P1-r2", { record: rec("confirmed"), envelope: await env(plan, { schema_version: markers ? "leak-marker-text" : "musunest-factory/plan-only-result/v0" }) });
  addRun498(out, "P1-r3", { record: rec("stopped"), envelope: await env(plan) }); // 往復の記録は止まった、包みは確定
  addRun498(out, "P1-r4", { record: rec("confirmed"), envelope: await env(plan, { plan_sha256: "0".repeat(64) }) });
  addRun498(out, "P1-r5", { record: rec("confirmed"), envelope: await env(plan, { source_sha256: sha256("other") }) });
  addRun498(out, "P1-r6", { record: rec("confirmed"), envelope: await env(tampered) }); // 契約の検査（確認の失効）だけで落ちる
  addRun498(out, "P1-r7", { record: rec("stopped") }); // 包みが無い
  addRun498(out, "P1-r8", { record: rec("stopped"), envelope: "{ leak-marker-text" }); // 包みが JSON でない
  const ids = runIds("P1", 8);
  cond4(out, ids, "plan-only", { set: { path: setPath, sha256: loaded.sha256, id: "t-set" } });
  return { out, ids };
}

test("Plan だけの出力：包みを本ごとに検査し、通らない数と理由ごとの数を出す。Build の指標は対象外（build_applicable が偽・Build の表は 0 本・通常の標準出力に 1 行）で、台本の事後の照合は包みの仕様の文で当たる。匿名の標準出力は JSON 1 個", async () => {
  await withOut(async (base) => {
    const { out } = await planOnlyFixture(base);
    const r = scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(full.evaluation, { mode: "plan-only", build_applicable: false });
    assert.equal(full.metrics_build, null);
    assert.deepEqual(full.metrics_plan.envelope, { runs: 8, checked: 6, passed: 1, failed: 5, absent: 1, unreadable: 1, reasons: Object.fromEntries(ENVELOPE_REASONS.map((k) => [k, 1])) });
    assert.equal(r.stdout.split("\n").filter((l) => l.includes("Build の指標は対象外")).length, 1, "通常の標準出力に対象外の 1 行");
    // 既存の行・metrics は今の定義のまま（宣言が無いので生成失敗）
    startsWith(full.metrics.generated, "0/8（");
    assert.deepEqual(Object.keys(full.metrics), METRICS_KEYS);
    // Build の表は 0 本で、分母の文は Plan 評価
    assert.deepEqual([full.tables.build.total.runs, full.tables.build.total.excluded, full.tables.build.rows], [0, 0, []]);
    assert.match(full.tables.build.total.denominator, /^Plan 評価（plan-only）/);
    assert.equal(full.tables.plan.total.runs, 8, "Plan の表は今と同じ（全本）");
    // 台本の事後の照合：鍵は確定した仕様（包み）の事項の文にだけある
    assert.equal(rowOf(full, "P1-r1").script.scripted, 1);
    assert.equal(rowOf(full, "P1-r1").script.status, "ok");
    assert.equal(rowOf(full, "P1-r7").script.scripted, 0, "包みが無い本は仕様の文が無く、台本に当たらない");
    // 匿名：JSON 1 個。包みの検査は数だけ（理由の符号は出さない）
    const ar = scoreRun(out, ["--anonymous"]);
    const a = JSON.parse(ar.stdout);
    assert.equal(a.evaluation.build_applicable, false);
    assert.equal(a.evaluation.mode, "plan-only");
    assert.deepEqual(a.metrics_plan.envelope, { runs: 8, checked: 6, passed: 1, failed: 5, absent: 1, unreadable: 1 });
    for (const w of ENVELOPE_REASONS) assert.ok(!ar.stdout.includes(w), `匿名に包みの理由の符号 ${w}`);
    assert.ok(!ar.stdout.includes("対象外"));
  });
});

test("Build だけの集計（build-from）の分母は予定した本の全部：採用 2 P × 3 回・外した P 1 つ・未実行 1 本なら 6 本で、分母の文に外した P の数。Build の表は予定した 6 本を外さずに含む。--only で 1 P なら 3 本。e2e の --only でも Plan の集計の分母は予定の本数", async () => {
  await withOut(async (base) => {
    const frozen = frozenOf(base, ["P1", "P2"], ["P3"]);
    const out = join(base, "out");
    const ids = [...runIds("P1", 3), ...runIds("P2", 3)];
    for (const id of ids.filter((x) => x !== "P2-r3")) addRun498(out, id, { sl: { summary: { verdict: "partial", stages: [stg("design", 10)], provider_cost_usd: 0.01 } }, buildRecord: buildRec(id.split("-")[0], false) });
    cond4(out, ids, "build-from", { frozen });
    const r = scoreRun(out);
    const full = readScore(out);
    const mb = full.metrics_build;
    assert.deepEqual(full.evaluation, { mode: "build-from", build_applicable: true });
    assert.equal(full.metrics_plan, null);
    assert.deepEqual([mb.runs, mb.frozen_missing, mb.unexecuted, mb.incomplete], [6, 1, 1, 0]);
    assert.equal(mb.denominator, "凍結した組の本 6 本（予定した本の全部。組が外した P 1 個は含まない）");
    assert.deepEqual(mb.rows.map((x) => [x.run, x.state]), ids.map((id) => [id, id === "P2-r3" ? "unexecuted" : "executed"]));
    // Build の表：Plan の記録が無くても外さず、予定した 6 本（未実行の本も）を含む
    assert.deepEqual(full.tables.build.rows.map((x) => x.run), ids);
    assert.deepEqual([full.tables.build.total.runs, full.tables.build.total.excluded], [6, 0]);
    assert.match(full.tables.build.total.denominator, /^凍結した組の本 6 本（.*組が外した P 1 個は含まない）$/);
    assert.match(r.stdout, /Build だけの集計: 凍結した組の本 6 本/);
    // --only で 1 P を流した計測（予定 3 本）
    const out2 = join(base, "out2");
    for (const id of runIds("P1", 3)) addRun498(out2, id, { sl: { summary: { verdict: "partial", stages: [] } }, buildRecord: buildRec("P1", false) });
    cond4(out2, runIds("P1", 3), "build-from", { frozen });
    scoreRun(out2);
    assert.equal(readScore(out2).metrics_build.runs, 3);
    assert.equal(readScore(out2).tables.build.total.runs, 3);
    // e2e の --only（組は P1〜P10。予定は P1 × 3 で、流したのは 2 本）
    const out3 = join(base, "out3");
    for (const id of ["P1-r1", "P1-r2"]) addRun498(out3, id, { record: { outcome: "confirmed", rounds: [] } });
    cond4(out3, runIds("P1", 3), "e2e");
    scoreRun(out3);
    assert.deepEqual([readScore(out3).metrics_plan.runs, readScore(out3).metrics_plan.unexecuted], [3, 1]);
    startsWith(readScore(out3).metrics_plan.confirmed, "2/3（");
  });
});

test("Build だけの集計の終了の分類（予定 12 本 ＝ 6 P × 2 回）：exit_class ごとの本数・exit 2 の生の数・包みの拒否（構造化された行のある本だけ）・差し戻しの率と食い違い・記録なし・未実行・途中が期待値と等しい。組との照合と PASS の率は別の 2 本で確かめる", async () => {
  await withOut(async (base) => {
    const pids = ["P1", "P2", "P3", "P4", "P5", "P6"];
    const frozen = frozenOf(base, pids, []);
    const out = join(base, "out");
    const errLine = JSON.stringify({ schema_version: "musunest-factory/plan-file-error/v1", code: "plan-file-json" });
    const rejLine = JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "plan-sha256", codes: ["mismatch"] });
    const run = (id, exit, exitClass, extra = {}) => addRun498(out, id, { sl: { exit, exit_class: exitClass }, ...extra });
    run("P1-r1", 0, "ok", { buildRecord: buildRec("P1", false) });
    run("P1-r2", 1, "failed");
    run("P2-r1", 3, "return-to-plan", { buildRecord: buildRec("P2", true) });
    run("P2-r2", 3, "return-to-plan", { buildRecord: buildRec("P2", false) });
    run("P3-r1", 0, "ok", { buildRecord: buildRec("P3", true) });
    run("P3-r2", 3, "return-to-plan"); // Build だけの記録が無い
    run("P4-r1", 2, "envelope-unreadable", { stdout: `${errLine}\n` });
    run("P4-r2", 2, "envelope-rejected", { stdout: `noise\n${rejLine}\n` });
    run("P5-r1", 2, "usage-other", { stdout: "usage\n" });
    run("P5-r2", 5, "other");
    addRun498(out, "P6-r2", { summary: false }); // 要約の無い途中の本。P6-r1 は未実行
    const ids = pids.flatMap((p) => runIds(p, 2));
    cond4(out, ids, "build-from", { frozen });
    const r = scoreRun(out);
    const mb = readScore(out).metrics_build;
    assert.equal(mb.runs, 12);
    assert.deepEqual(mb.exit_classes, { ok: 2, failed: 1, "return-to-plan": 3, "envelope-unreadable": 1, "envelope-rejected": 1, "usage-other": 1, other: 1, unknown: 0 });
    assert.deepEqual(Object.keys(mb.exit_classes), [...EXIT_CLASSES, "unknown"]);
    assert.deepEqual([mb.exit_2, mb.envelope_refusals], [3, 2]);
    assert.deepEqual({ ...mb.return_to_plan, rate: head(mb.return_to_plan.rate) }, { count: 1, rate: "1/12", inconsistent: 2, unrecorded: 1 });
    assert.deepEqual([mb.unexecuted, mb.incomplete], [1, 1]);
    // 3 種類の exit 2 は本ごとに分類を確かめる
    const row = (id) => mb.rows.find((x) => x.run === id);
    assert.deepEqual([row("P4-r1").exit_class, row("P4-r1").envelope_refusal], ["envelope-unreadable", true]);
    assert.deepEqual([row("P4-r2").exit_class, row("P4-r2").envelope_refusal], ["envelope-rejected", true]);
    assert.deepEqual([row("P5-r1").exit_class, row("P5-r1").envelope_refusal], ["usage-other", false]);
    assert.deepEqual([row("P6-r1").state, row("P6-r2").state], ["unexecuted", "incomplete"]);
    assert.deepEqual([row("P2-r1").return_to_plan, row("P2-r2").return_to_plan, row("P3-r2").return_to_plan], [true, false, null]);
    const a = anonymize(readScore(out)).metrics_build;
    assert.deepEqual([a.exit_classes, a.exit_2, a.envelope_refusals, a.return_to_plan], [mb.exit_classes, 3, 2, mb.return_to_plan]);
    assert.equal("rows" in a, false, "匿名に本ごとの値は出さない");
    assert.match(r.stdout, /exit 2 3（包みの拒否 2）・差し戻し 1\/12（/);
    // 分類が拒否でも、構造化された行が無ければ包みの拒否に数えない（行が既知の版でも、検査名が既知でなければ数えない）
    const out1 = join(base, "out1");
    addRun498(out1, "P1-r1", { sl: { exit: 2, exit_class: "envelope-rejected" }, stdout: "x\n" });
    addRun498(out1, "P1-r2", { sl: { exit: 2, exit_class: "envelope-rejected" }, stdout: `${JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "leak-marker-text" })}\n` });
    cond4(out1, runIds("P1", 2), "build-from", { frozen });
    scoreRun(out1);
    assert.deepEqual([readScore(out1).metrics_build.exit_2, readScore(out1).metrics_build.envelope_refusals], [2, 0]);
    // 組との照合と PASS の率：2 本のうち 1 本は組と違う SHA、1 本は PASS
    const out2 = join(base, "out2");
    addRun498(out2, "P1-r1", { spec: PASS_A, sl: { summary: { verdict: "full", stages: [stg("design", 100), stg("write", 50)], provider_cost_usd: 0.02 }, plan_cost: { plan_usd: 0, build_usd: 0.03, total_usd: 0.03 } }, buildRecord: buildRec("P1", false) });
    addRun498(out2, "P1-r2", { spec: FAIL_A, sl: { summary: { verdict: "partial", stages: [stg("design", 300)], provider_cost_usd: 0.01 } }, buildRecord: buildRec("P1", false, { plan_sha256: sha256("other") }) });
    cond4(out2, runIds("P1", 2), "build-from", { frozen });
    scoreRun(out2);
    const m2 = readScore(out2).metrics_build;
    assert.deepEqual(m2.frozen_match, { checked: 2, mismatched: 1 });
    assert.deepEqual(m2.rows.map((x) => [x.frozen_match, x.pass, x.factory_verdict]), [[true, true, "full"], [false, false, "partial"]]);
    startsWith(m2.pass, "1/2（");
    assert.deepEqual(m2.factory_verdicts, { full: 1, partial: 1, none: 0, unknown: 0, absent: 0 });
    assert.deepEqual(m2.duration_ms, { observed: 2, missing: 0, total: 450, median: 225 });
    assert.deepEqual(m2.by_stage, { design: { observed: 2, missing: 0, total: 400, median: 200 }, write: { observed: 2, missing: 0, total: 50, median: 25 } });
    assert.deepEqual(m2.usd, { observed: 2, missing: 0, total: 0.04, median: 0.02 });
    assert.equal(readScore(out2).rows.find((x) => x.run === "P1-r1").verdict, "PASS", "PASS は既存の行の判定のまま");
  });
});

test("build-from の計測で条件の frozen が無い・形が違う出力は、exit 3 で採点の出力を書かない。匿名でも同じで、標準エラーは 1 行に固定の符号だけ（本の ID・パス・値を出さない）", async () => {
  await withOut(async (base) => {
    const good = frozenOf(base, ["P1"], []);
    const cases = [
      [null, "frozen-missing", "無い"],
      [{ ...good, sha256: "leak-marker-text" }, "frozen-invalid", "の形が違う"],
      [{ ...good, adopted: [{ pattern: "leak-marker-text", plan_sha256: PSHA("P1"), source_sha256: SSHA("P1") }] }, "frozen-invalid", "の形が違う"],
      [{ ...good, missing: ["leakmarkertext"] }, "frozen-invalid", "の形が違う"],
      [{ ...good, sha256: [good.sha256] }, "frozen-invalid", "の形が違う"],
      [{ ...good, adopted: [{ pattern: "P1", plan_sha256: [PSHA("P1")], source_sha256: SSHA("P1") }] }, "frozen-invalid", "の形が違う"],
      [{ ...good, adopted: [{ pattern: "P1", plan_sha256: PSHA("P1"), source_sha256: [SSHA("P1")] }] }, "frozen-invalid", "の形が違う"],
      [{ ...good, missing: ["P2", "P2"] }, "frozen-invalid", "の形が違う"],
      [{ ...good, path: ["leak-marker-text"] }, "frozen-invalid", "の形が違う"],
      ["leak-marker-text", "frozen-invalid", "の形が違う"],
    ];
    for (const [i, [frozen, code, word]] of cases.entries()) {
      const out = join(base, `out${i}`);
      addRun498(out, "P1-r1", { sl: { summary: { verdict: "leak-marker-text" } }, buildRecord: buildRec("P1", false) });
      cond4(out, ["P1-r1"], "build-from", { frozen });
      for (const extra of [[], ["--anonymous"]]) {
        const r = spawnSync(process.execPath, [scoreFile, repo, out, ...extra], { encoding: "utf8" });
        assert.equal(r.status, 3, r.stderr);
        assert.equal(r.stderr, `断りました: Build だけの計測（build-from）の条件の凍結した組（frozen）が${word} [score:${code}]\n`);
        assert.equal(r.stdout, "");
        for (const w of ["P1-r1", base, "leak-marker-text", "leakmarkertext"]) assert.ok(!r.stderr.includes(w), `標準エラーに ${w}`);
        assert.equal(existsSync(join(out, "score.json")), false);
        assert.equal(existsSync(join(out, "score.anonymous.json")), false);
      }
    }
    assert.equal(frozenProblem(good), null);
    assert.equal(frozenProblem(undefined), "missing");
  });
});

test("凍結した組の指紋：条件の frozen と組のファイルの SHA-256 を照合し、1 文字変えると不一致。v4 は fingerprints.conditions.frozen を持ち、v1〜v3 は鍵が無い（旧版の形のまま）", async () => {
  await withOut(async (base) => {
    const frozen = frozenOf(base, ["P1"], []);
    const out = join(base, "out");
    addRun498(out, "P1-r1", { sl: { summary: { verdict: "partial", stages: [] } }, buildRecord: buildRec("P1", false) });
    cond4(out, ["P1-r1"], "build-from", { frozen });
    scoreRun(out);
    let f = readScore(out).fingerprints;
    assert.deepEqual([f.frozen, f.frozen_matches_conditions, f.conditions.frozen], [frozen.sha256, true, frozen.sha256]);
    let a = anonymize(readScore(out)).fingerprints;
    assert.deepEqual([a.frozen, a.frozen_matches_conditions, a.conditions.frozen], [frozen.sha256, true, frozen.sha256]);
    // 組のファイルを 1 文字変える
    writeFileSync(frozen.path, readFileSync(frozen.path, "utf8").replace("t-frozen", "t-frozem"));
    const r = scoreRun(out);
    f = readScore(out).fingerprints;
    assert.deepEqual([f.frozen === frozen.sha256, f.frozen_matches_conditions], [false, false]);
    assert.match(f.frozen, HEX64);
    assert.match(r.stdout, /凍結した組 [0-9a-f]{12}…（条件のファイルと不一致）/);
    a = anonymize(readScore(out)).fingerprints;
    assert.equal(a.frozen_matches_conditions, false);
    // v4 の e2e（frozen は null）：鍵はあって null、照合は null
    const out2 = join(base, "out2");
    addRun498(out2, "P1-r1", { record: { outcome: "confirmed", rounds: [] } });
    cond4(out2, ["P1-r1"], "e2e");
    scoreRun(out2);
    f = readScore(out2).fingerprints;
    assert.deepEqual([f.frozen, f.frozen_matches_conditions, "frozen" in f.conditions, f.conditions.frozen], [null, null, true, null]);
    // v1〜v3：入れ子の conditions に frozen の鍵が無い（今の旧版の期待のまま）
    for (const schema of CONDITIONS_SCHEMAS.slice(0, 3)) {
      const o = join(base, `old-${CONDITIONS_SCHEMAS.indexOf(schema)}`);
      addRun(o, "P1-r1", { spec: PASS_A });
      conditions(o, ["P1-r1"], { schema });
      scoreRun(o);
      const full = readScore(o);
      assert.equal("frozen" in full.fingerprints.conditions, false, schema);
      assert.deepEqual(Object.keys(anonymize(full).fingerprints.conditions), ["schema", "signature", "factory", "spec_engine", "scoring", "judge", "set", "scripts"]);
      assert.deepEqual([full.fingerprints.frozen, full.fingerprints.frozen_matches_conditions], [null, null]);
    }
  });
});

test("漏えい：英小文字とハイフンの目印を止まり方の符号・包みの理由・契約の検査に落ちる仕様の文・自由入力・依頼文・未知の段の ID・失敗の種類・確定できない理由・工場の verdict・照合の状態・終了の分類に入れても、成功・断り・読み取りの失敗のどの経路でも匿名の JSON・標準出力・標準エラーに出ない。通常の出力の新しい欄・診断の表・標準出力の行は unknown になる", async () => {
  await withOut(async (base) => {
    const MARKS = ["leak-marker-text", "leakmarkertext"];
    const clean = (text, name) => { for (const w of MARKS) assert.ok(!text.includes(w), `${name} に ${w}`); };
    // Plan だけ（依頼文・仕様の文・包みの版に目印）に、止まり方・段・自由入力・照合の状態の目印を足す
    const { out } = await planOnlyFixture(base, { markers: true });
    const bad = { stage: "leak-marker-text", status: "leakmarkertext", duration_ms: 7 };
    addRun498(out, "P1-r7", {
      sl: { exit: 1, exit_class: "leak-marker-text", summary: { verdict: "leakmarkertext", stages: [bad], failure: { stage: "leak-marker-text", kind: "leakmarkertext" } }, plan_cost: { plan_usd: 0.01, build_usd: 0, total_usd: 0.01 } },
      record: { outcome: "cannot-confirm", rounds: [round([Q_HOW()], [{ id: "A:1", question_id: "Q1-1", choice_id: null, free_text: "leak-marker-text" }])], stages: [bad], cannot_confirm: [{ source: "leak-marker-text", code: "leakmarkertext", path: "x" }, { source: "confirm", code: "leak-marker-text", path: "x" }], script: { matches: [{ state: "leak-marker-text" }] } },
      envelope: { schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "leak-marker-text", plan: null, plan_sha256: null, source_sha256: "leakmarkertext", conditions: null, stop: { kind: "stopped", reason: "leak-marker-text", codes: ["leakmarkertext"] } },
      stdout: `${JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "leak-marker-text", codes: ["leakmarkertext"] })}\n`,
    });
    addRun498(out, "P1-r8", { sl: { summary: { verdict: "leak-marker-text", stages: [{ stage: "leakmarkertext", duration_ms: 1 }] } }, record: { outcome: "stopped", rounds: [], stages: [{ stage: "leakmarkertext", duration_ms: 1 }], failure: { stage: "leakmarkertext", kind: "leak-marker-text" } } });
    // 匿名の成功の経路
    const ar = scoreRun(out, ["--anonymous"]);
    clean(ar.stdout, "匿名の標準出力"); clean(ar.stderr, "匿名の標準エラー");
    clean(readFileSync(join(out, "score.anonymous.json"), "utf8"), "匿名の JSON");
    assert.equal(JSON.parse(ar.stdout).metrics_plan.runs, 8);
    // 通常の出力：新しい欄・診断の表・標準出力は unknown に写す
    const r = scoreRun(out);
    clean(r.stdout, "通常の標準出力"); clean(r.stderr, "通常の標準エラー");
    const full = readScore(out);
    clean(JSON.stringify([full.evaluation, full.metrics_plan, full.metrics_build, full.tables, full.fingerprints.frozen]), "新しい欄・表");
    assert.deepEqual(full.tables.plan.rows.find((x) => x.run === "P1-r7").stop.classes, ["confirm:unknown", "unknown:unknown"]);
    assert.deepEqual(full.tables.plan.rows.find((x) => x.run === "P1-r8").stop.classes, ["unknown:unknown"]);
    assert.equal(full.tables.plan.total.stop_classes["unknown:unknown"], 2);
    assert.ok("unknown" in full.tables.plan.rows.find((x) => x.run === "P1-r7").stages.by_stage);
    assert.equal(full.metrics_plan.stop_classes.unknown, 2);
    assert.equal(full.metrics_plan.script, null, "post-hoc の計測では実行中の台本を数えない");
    assert.equal(full.metrics_plan.envelope.reasons["envelope-version"], 1);
    assert.equal(full.metrics_plan.envelope.reasons["outcome-mismatch"], 2);
    assert.match(r.stdout, /^P1-r8\tunknown\t/m, "行の工場の verdict は unknown");
    // 生の記録から写す既存の欄は保証の外（README の限界）：行の工場の verdict はそのまま
    assert.equal(rowOf(full, "P1-r8").factory_verdict, "leak-marker-text");
    // live の台本と e2e の止まり方でも同じ（照合の状態の目印）
    const outL = join(base, "outL");
    cpSync(out, outL, { recursive: true });
    const condL = JSON.parse(readFileSync(join(outL, "conditions.json"), "utf8"));
    writeFileSync(join(outL, "conditions.json"), JSON.stringify({ ...condL, params: { ...condL.params, mode: "e2e", plan: true }, scripts: { mode: "live", fingerprint: null, files: [] } }));
    const rl = scoreRun(outL), arl = scoreRun(outL, ["--anonymous"]);
    for (const [t, n] of [[rl.stdout, "live の標準出力"], [arl.stdout, "live の匿名"], [JSON.stringify([readScore(outL).metrics_plan, readScore(outL).tables])]]) clean(t, n ?? "live の新しい欄");
    assert.equal(readScore(outL).metrics_plan.script.states["unknown-state"], 1);
    // Build だけ：終了の分類・verdict・段・拒否の行の目印
    const frozen = frozenOf(base, ["P1"], []);
    const outB = join(base, "outB");
    addRun498(outB, "P1-r1", { sl: { exit: 2, exit_class: "leak-marker-text", summary: { verdict: "leakmarkertext", stages: [{ stage: "leak-marker-text", duration_ms: 3 }] } }, stdout: `${JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "leak-marker-text" })}\n`, buildRecord: buildRec("P1", "leak-marker-text", { plan_sha256: "leakmarkertext" }) });
    addRun498(outB, "P1-r2", { spec: PASS_A, sl: { exit: 0, exit_class: "ok", summary: { verdict: "leak-marker-text", stages: [{ stage: "leakmarkertext", duration_ms: 3 }] } }, buildRecord: "{ leak-marker-text" });
    cond4(outB, runIds("P1", 2), "build-from", { frozen });
    const rb = scoreRun(outB), arb = scoreRun(outB, ["--anonymous"]);
    clean(rb.stdout, "Build の標準出力"); clean(rb.stderr, "Build の標準エラー"); clean(arb.stdout, "Build の匿名"); clean(arb.stderr, "Build の匿名の標準エラー");
    const fb = readScore(outB);
    clean(JSON.stringify([fb.metrics_build, fb.tables, fb.evaluation]), "Build の新しい欄・表");
    assert.deepEqual([fb.metrics_build.exit_classes.unknown, fb.metrics_build.factory_verdicts.unknown, fb.metrics_build.envelope_refusals], [1, 2, 0]);
    assert.ok("unknown" in fb.metrics_build.by_stage);
    assert.deepEqual(fb.tables.build.rows.map((x) => x.factory_verdict), ["unknown", "unknown"]);
    assert.deepEqual(fb.tables.build.total.factory_verdicts, { unknown: 2 });
    // 断りの経路（匿名）：上の build-from の frozen の試験と同じ 1 行
    const outR = join(base, "outR");
    cpSync(outB, outR, { recursive: true });
    writeFileSync(join(outR, "conditions.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(outB, "conditions.json"), "utf8")), frozen: { ...frozen, path: "leak-marker-text", sha256: "leakmarkertext" } }));
    const rr = spawnSync(process.execPath, [scoreFile, repo, outR, "--anonymous"], { encoding: "utf8" });
    assert.equal(rr.status, 3);
    clean(rr.stdout + rr.stderr, "断り");
    // 読み取りの失敗の経路：往復の記録が JSON でない（目印を含む）本は止めずに読めない記録として数える。通常・匿名のどちらでも目印は出ない
    const outF = join(base, "outF");
    cpSync(out, outF, { recursive: true });
    writeFileSync(join(outF, "P1-r1/bundle/plan-record.json"), "{ leak-marker-text leakmarkertext");
    for (const extra of [[], ["--anonymous"]]) {
      const rf = scoreRun(outF, extra);
      clean(rf.stdout + rf.stderr, `往復の記録が読めない（${extra.join("") || "通常"}）`);
    }
    { const fF = readScore(outF); clean(JSON.stringify([fF.evaluation, fF.metrics_plan, fF.metrics_build, fF.tables, rowOf(fF, "P1-r1")]), "往復の記録が読めない本の新しい欄・表・行"); }
    clean(readFileSync(join(outF, "score.anonymous.json"), "utf8"), "往復の記録が読めない本の匿名の JSON");
    assert.deepEqual([readScore(outF).metrics_plan.record_unreadable, readScore(outF).metrics_plan.free_text.unreadable >= 1], [1, true]);
    // 止める記録（起動の記録・申告・1 回の起動の記録）が JSON でない：通常・匿名のどちらでも exit 1・固定の文と既知の符号だけ・出力なし
    for (const [rel, kind] of [["P1-r2/summary.line.json", "summary"], ["P1-r2/bundle/artifacts/unwritable.json", "unwritable"], ["run-1000.json", "run-record"]]) {
      const outX = join(base, `outX-${kind}`);
      cpSync(out, outX, { recursive: true });
      for (const n of ["score.json", "score.anonymous.json"]) rmSync(join(outX, n), { force: true });
      if (kind === "unwritable") writeFileSync(join(outX, "P1-r2/bundle/artifacts/app.spec.yaml"), PASS_A);
      writeFileSync(join(outX, rel), "{ leak-marker-text leakmarkertext");
      for (const extra of [[], ["--anonymous"]]) {
        const rf = spawnSync(process.execPath, [scoreFile, repo, outX, ...extra], { encoding: "utf8" });
        assert.equal(rf.status, 1, `${kind}: ${rf.stderr}`);
        assert.equal(rf.stdout, "");
        assert.equal(rf.stderr, `失敗しました: 記録を読めなかった [score:record-unreadable:${kind}]\n`);
        assert.equal(existsSync(join(outX, "score.json")) || existsSync(join(outX, "score.anonymous.json")), false);
      }
    }
  });
});

test("包みの検査は不正な包みを通さない：結果は既知の 3 値だけ、確定でなければ仕様も plan_sha256 も厳密に null。未知の結果（往復の記録と同じ値でも）・型違い・欄の欠落は理由つきで落ちる", async () => {
  const plan = await planFixture();
  const source = "MARK_SRC\n";
  const deps = { sourceText: source, checkConfirmedPlan, planDigest };
  const env = async (over = {}) => ({ schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "confirmed", plan, plan_sha256: await planDigest(plan), source_sha256: sha256(source), conditions: null, stop: null, ...over });
  const stopped = { outcome: "stopped", plan: null, plan_sha256: null };
  const check = async (over, recordOutcome = null) => checkPlanResult(over === "raw" ? recordOutcome : await env(over), { ...deps, recordOutcome: over === "raw" ? null : recordOutcome });
  assert.deepEqual(await check({}, "confirmed"), { status: "checked", reasons: [] });
  assert.deepEqual(await check(stopped, "stopped"), { status: "checked", reasons: [] }, "確定でない正しい包みは通る");
  const cases = [
    [{ outcome: "leak-marker-text", plan: null, plan_sha256: null }, "leak-marker-text", ["outcome-mismatch"]], // 未知の結果が両方で同じ
    [{ ...stopped, plan: "synthetic" }, "stopped", ["outcome-mismatch"]],
    [{ ...stopped, plan }, "stopped", ["outcome-mismatch"]],
    [{ ...stopped, plan: undefined }, "stopped", ["outcome-mismatch"]], // 仕様の欄が欠ける
    [{ ...stopped, plan_sha256: undefined }, "stopped", ["plan-sha256"]], // plan_sha256 の欄が欠ける
    [{ ...stopped, plan_sha256: "" }, "stopped", ["plan-sha256"]],
    [{ outcome: "confirmed", plan: "synthetic" }, "confirmed", ["outcome-mismatch", "plan-sha256"]],
    [{ outcome: ["confirmed"] }, null, ["outcome-mismatch", "plan-sha256"]], // 型違いの結果
    [{ source_sha256: 1 }, "confirmed", ["source-sha256"]],
    [{ source_sha256: undefined }, "confirmed", ["source-sha256"]],
    [{ schema_version: undefined }, "confirmed", ["envelope-version"]],
    [{ plan_sha256: [await planDigest(plan)] }, "confirmed", ["plan-sha256"]],
  ];
  for (const [over, rec, reasons] of cases) assert.deepEqual(await check(over, rec), { status: "checked", reasons }, JSON.stringify(over));
  for (const raw of [null, [], "x", 1]) assert.deepEqual(await check("raw", raw), { status: "unreadable", reasons: [] });
  // CLI：未知の結果を往復の記録と包みの両方に置いた本は、通った数に入らない
  await withOut(async (base) => {
    const setPath = writeJson(join(base, "set/t-set.json"), { ...SET_DEFAULTS, items: [itemOf("P1", "A")] });
    const loaded = loadEvalSet(setPath);
    const src = sha256(loaded.byId.get("P1").requestText + "\n");
    const out = join(base, "out");
    addRun498(out, "P1-r1", { record: { outcome: "leak-marker-text", rounds: [] }, envelope: { schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "leak-marker-text", plan: null, plan_sha256: null, source_sha256: src, conditions: null, stop: null } });
    addRun498(out, "P1-r2", { record: { outcome: "stopped", rounds: [] }, envelope: { schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "stopped", plan: "synthetic", plan_sha256: null, source_sha256: src, conditions: null, stop: null } });
    addRun498(out, "P1-r3", { record: { outcome: "stopped", rounds: [] }, envelope: { schema_version: PLAN_ONLY_RESULT_SCHEMA, outcome: "stopped", plan: null, plan_sha256: null, source_sha256: src, conditions: null, stop: null } });
    cond4(out, runIds("P1", 3), "plan-only", { set: { path: setPath, sha256: loaded.sha256, id: "t-set" } });
    const r = scoreRun(out);
    const e = readScore(out).metrics_plan.envelope;
    assert.deepEqual([e.checked, e.passed, e.failed, e.reasons["outcome-mismatch"]], [3, 1, 2, 2]);
    assert.ok(!r.stdout.includes("leak-marker-text"));
  });
});

test("入れ子の fingerprints.conditions.frozen は 64 桁の 16 進の文字列だけを通し、それ以外は null（どの mode でも、通常・匿名の JSON に入力の文字列を残さない）", async () => {
  await withOut(async (base) => {
    for (const mode of ["build", "e2e", "plan-only"]) {
      for (const sha of ["leak-marker-text", ["leakmarkertext"], 1]) {
        const out = join(base, `out-${mode}-${typeof sha}`);
        addRun498(out, "P1-r1", { spec: PASS_A, record: { outcome: "confirmed", rounds: [] } });
        cond4(out, ["P1-r1"], mode, { frozen: { path: "leak-marker-text", sha256: sha } });
        const r = scoreRun(out);
        const full = readScore(out);
        assert.deepEqual([full.fingerprints.conditions.frozen, full.fingerprints.frozen, full.fingerprints.frozen_matches_conditions], [null, null, false], `${mode} ${JSON.stringify(sha)}`);
        const ar = scoreRun(out, ["--anonymous"]);
        for (const w of ["leak-marker-text", "leakmarkertext"]) {
          assert.ok(!JSON.stringify(full.fingerprints).includes(w), `${mode}: 通常の指紋に ${w}`);
          assert.ok(!readFileSync(join(out, "score.anonymous.json"), "utf8").includes(w), `${mode}: 匿名の JSON に ${w}`);
          assert.ok(!r.stdout.includes(w) && !ar.stdout.includes(w), `${mode}: 標準出力に ${w}`);
        }
        assert.equal(JSON.parse(ar.stdout).fingerprints.conditions.frozen, null);
      }
    }
  });
});

test("既存の行の問数・往復は、今まで値が出ていた入力では形が違っても今までの値のまま（今までの式が例外で止まった形だけを 0 に写して続ける）", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    // 今まで値が出ていた形：文字列の questions は長さ、questions の無い往復は 0、length を持つ写像は length
    addRun498(out, "P1-r1", { record: { outcome: "confirmed", rounds: [{ questions: "abc", answers: [] }] } });
    addRun498(out, "P1-r2", { record: { outcome: "confirmed", rounds: [{ questions: "abc", answers: [] }, { questions: [1, 2], answers: [] }] } });
    addRun498(out, "P1-r3", { record: { outcome: "stopped", rounds: [{}] } });
    addRun498(out, "P1-r4", { record: { outcome: "stopped", rounds: [{ questions: { length: 4 } }] } });
    // 今までの式が例外で止まった形：rounds が写像・文字列、往復が null
    addRun498(out, "P1-r5", { record: { outcome: "stopped", rounds: {} } });
    addRun498(out, "P1-r6", { record: { outcome: "stopped", rounds: "xy" } });
    addRun498(out, "P1-r7", { record: { outcome: "stopped", rounds: [null] } });
    cond4(out, runIds("P1", 7), "e2e");
    scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(full.rows.map((x) => [x.run, x.plan.questions, x.plan.rounds]), [["P1-r1", 3, 1], ["P1-r2", 5, 2], ["P1-r3", 0, 1], ["P1-r4", 4, 1], ["P1-r5", 0, 0], ["P1-r6", 0, 0], ["P1-r7", 0, 0]]);
  });
});

// ── #513：v1.1α の比較の採点（--compare）・条件の版 v5・停止段と到達数・持ち越し（README の v1.1α の節）
import { BUILD_STAGE_IDS, CONDITIONS_V5, EXPECTED_STOPS, V11A_STAGE_IDS, conditionsSignature, pairStats, stopValueOf } from "./score-agent.mjs";

const MARK513 = "leak-marker-513";
const APPROVED513 = { "name-table": 32768, "semantic-check": 16384, "test-spec": 32768, "decl-check": 16384 };
const PSHA513 = (p) => sha256(`plan-${p}`), SSHA513 = (p) => sha256(`source-${p}`);
/** 本 1 本の起動の記録（要約は工場の headless-summary の写し） */
const sl513 = (summary = {}) => JSON.stringify({ exit: 0, wall_s: 1, started_at: "2026-10-16T00:00:00.000Z", exit_class: "ok", summary: { schema_version: "commandagent.headless-summary/v1", verdict: "partial", stop_reason: "completed", provider_cost_usd: 0.05, failure: null, stages: [], ...summary }, plan_cost: null, stderr_tail: { bytes: 0, known_lines: 0 }, resumed: false });
/**
 * 比較の出力先を固定の記録で組む（run-agent.mjs --compare と同じ形）。runOf(群, 本の ID) が本ごとの中身：
 * { state（executed・incomplete・unexecuted）, spec, summary, carry（carry-over の記録。文字列ならそのまま）, verification, ver1（v1 の検証の記録 verification.json。#538）, stdout }。
 * 条件の指紋は repoDir の採点の定義・spec-engine の dist・組・台本から計算する（採点のときに一致する）
 */
function compareFixture(base, name, { pids = ["P1", "P2"], runs = 3, profile = "official", runOf = () => ({}), repoDir = repo, groupsExtra = {}, setFile = null } = {}) {
  const out = join(base, name), evDir = join(repoDir, "workspace/mvp/m1/agent/eval");
  mkdirSync(out, { recursive: true });
  const frozenPath = join(base, `${name}-frozen.json`);
  writeFileSync(frozenPath, JSON.stringify({ id: "t", adopted: pids }));
  const frozenSha = sha256(readFileSync(frozenPath));
  const pairs = pids.flatMap((pid) => Array.from({ length: runs }, (_, i) => ({ pid, r: i + 1 }))).map((p, i) => ({ ...p, first: i % 2 === 0 ? "v1" : "v1.1a" }));
  const pairsText = JSON.stringify({ schema: "musunest-eval/compare-pairs/v1", frozen_sha256: frozenSha, groups: ["v1", "v1.1a"], runs, pairs }, null, 1) + "\n";
  writeFileSync(join(out, "pairs.json"), pairsText);
  const pairsSha = sha256(pairsText);
  const recordGroups = {};
  const set = loadEvalSet(setFile ?? join(repoDir, DEFAULT_SET_PATH));
  const ids = pairs.map((p) => `${p.pid}-r${p.r}`);
  for (const g of ["v1", "v1.1a"]) {
    const dir = join(out, g);
    mkdirSync(dir, { recursive: true });
    const cond = {
      schema: CONDITIONS_V5, measurement_id: name, source: { commit: null, dirty: null }, factory: { fingerprint: sha256(g) }, spec_engine: { fingerprint: fingerprintDir(join(repoDir, "packages/spec-engine/dist")).fingerprint },
      set: { path: setFile ?? DEFAULT_SET_PATH, sha256: set.sha256 }, scripts: { mode: "post-hoc", fingerprint: scriptsFingerprint(set.scripts).fingerprint }, scoring: { fingerprint: scoringFingerprint(evDir, scoreFile, set.definitions).fingerprint }, judge: { configuration: "llm-only" },
      params: { ...paramsFor(ids), mode: "build-from", plan: false, effort: "high", pipeline: g, stage_output_limits_v11a: g === "v1" ? null : APPROVED513 },
      child_args: ids.map((id) => ({ id, argv: [] })),
      frozen: { path: frozenPath, sha256: frozenSha, id: "t", version: 1, origin: "frozen-plan", author: null, adopted: pids.map((p) => ({ pattern: p, plan_sha256: PSHA513(p), source_sha256: SSHA513(p), envelope_sha256: sha256(p) })), missing: [] },
      comparison: { pairs_sha256: pairsSha, group: g, role: g === "v1" ? "baseline" : "candidate", profile }, ...(groupsExtra[g] ?? {}),
    };
    // 条件の署名は run-agent.mjs と同じ式（conditionsSignature）。groupsExtra で signature を与えたときはその値（食い違いの負例）
    cond.signature = groupsExtra[g]?.signature ?? conditionsSignature(cond);
    recordGroups[g] = { role: g === "v1" ? "baseline" : "candidate", pipeline: g, factory: { fingerprint: cond.factory.fingerprint }, conditions_signature: cond.signature };
    writeFileSync(join(dir, "conditions.json"), JSON.stringify(cond));
    for (const id of ids) {
      const x = runOf(g, id);
      if (x.state === "unexecuted") continue;
      const rd = join(dir, id);
      mkdirSync(join(rd, "bundle/artifacts"), { recursive: true });
      if (x.state === "incomplete") continue;
      writeFileSync(join(rd, "summary.line.json"), sl513(x.summary));
      writeFileSync(join(rd, "stdout.log"), x.stdout ?? "");
      writeFileSync(join(rd, "stderr.log"), x.stdout ?? "");
      if (x.spec) writeFileSync(join(rd, "bundle/artifacts/app.spec.yaml"), x.spec);
      if (x.carry !== undefined) writeFileSync(join(rd, "bundle/artifacts/carry-over.json"), typeof x.carry === "string" ? x.carry : JSON.stringify(x.carry));
      if (x.verification !== undefined) writeFileSync(join(rd, "bundle/artifacts/verification-v11a.json"), JSON.stringify(x.verification));
      if (x.ver1 !== undefined) writeFileSync(join(rd, "bundle/artifacts/verification.json"), JSON.stringify(x.ver1));
    }
  }
  writeFileSync(join(out, "comparison.json"), JSON.stringify({ schema: "musunest-eval/compare-record/v1", pairs: { sha256: pairsSha }, groups: recordGroups, profile, profile_mismatches: profile === "official" ? [] : ["deadline_min"], scoring_cost_usd: 0 }));
  return { out, frozenPath, pairs };
}
const scoreCompareRun = (out, extra = [], repoArg = repo) => spawnSync(process.execPath, [scoreFile, repoArg, out, "--compare", ...extra], { encoding: "utf8" });
const readCompare = (out, name = "score-compare.json") => JSON.parse(readFileSync(join(out, name), "utf8"));

test("#513 (a) BUILD_STAGE_IDS は v1 の 12 段のあとに v1.1α の 7 段（A1 の順）で 19 個。run-agent.mjs は同じ一覧を記録の写像に使う（工場の dist の STAGE_IDS との一致の試験は #505 が入ってから足す）", () => {
  assert.equal(BUILD_STAGE_IDS.length, 19);
  assert.deepEqual(BUILD_STAGE_IDS.slice(0, 12), ["requirements", "reverse-check", "design", "test-suite", "write", "static-check", "correspondence", "run-tests", "repair", "arbitration", "judge", "bundle"]);
  assert.deepEqual(V11A_STAGE_IDS, ["name-table", "semantic-check", "test-spec", "name-check", "decl-check", "coverage", "carry-over"]);
  assert.deepEqual(BUILD_STAGE_IDS.slice(12), V11A_STAGE_IDS);
  assert.ok(readFileSync(join(here, "run-agent.mjs"), "utf8").includes("const STAGE_IDS = BUILD_STAGE_IDS;"));
});

test("#513 (b) 条件の版 v5：evaluationOf が pipeline を返し、v1〜v4 では null（出力の evaluation の欄は今までの形のまま）。v5 の採点の出力の evaluation に pipeline が載る", async () => {
  assert.equal(CONDITIONS_V5, "musunest-factory/agent-accept-conditions/v5");
  assert.equal(CONDITIONS_SCHEMAS.at(-1), CONDITIONS_V5);
  assert.deepEqual(evaluationOf({ schema: CONDITIONS_V5, params: { mode: "build-from", pipeline: "v1.1a" } }), { mode: "build-from", build_applicable: true, pipeline: "v1.1a" });
  assert.deepEqual(evaluationOf({ schema: CONDITIONS_V5, params: { mode: "build", pipeline: "v1" } }), { mode: "build", build_applicable: true, pipeline: "v1" });
  assert.deepEqual(evaluationOf({ schema: CONDITIONS_V5, params: { mode: "plan-only", pipeline: MARK513 } }), { mode: "plan-only", build_applicable: false, pipeline: "unknown" });
  for (const schema of CONDITIONS_SCHEMAS.slice(0, 4)) {
    const e = evaluationOf({ schema, params: { mode: "build", plan: false, pipeline: "v1.1a" } });
    assert.equal(e.pipeline, null, schema);
    assert.deepEqual(Object.keys(e), ["mode", "build_applicable"], `${schema}: 出力の欄は今までの形`);
  }
  assert.equal(evaluationOf(null).pipeline, null);
  await withOut(async (base) => {
    const f = compareFixture(base, "b", { pids: ["P1"], runs: 1, runOf: () => ({ spec: PASS_A }) });
    scoreRun(join(f.out, "v1.1a"));
    const full = readScore(join(f.out, "v1.1a"));
    assert.deepEqual(full.evaluation, { mode: "build-from", build_applicable: true, pipeline: "v1.1a" });
    assert.equal(full.fingerprints.conditions.frozen, sha256(readFileSync(f.frozenPath)), "v5 の入れ子の frozen も v4 と同じく出す");
    assert.deepEqual(anonymize(full).evaluation, { mode: "build-from", build_applicable: true, pipeline: "v1.1a" });
    // v4 の build-from の出力先：evaluation に pipeline の欄が出ない
    const o4 = join(base, "b4");
    cpSync(join(f.out, "v1.1a"), o4, { recursive: true });
    const c4 = JSON.parse(readFileSync(join(o4, "conditions.json"), "utf8"));
    c4.schema = CONDITIONS_SCHEMAS[3];
    delete c4.params.pipeline; delete c4.params.stage_output_limits_v11a; delete c4.comparison;
    writeFileSync(join(o4, "conditions.json"), JSON.stringify(c4));
    rmSync(join(o4, "score.json"));
    scoreRun(o4);
    assert.deepEqual(readScore(o4).evaluation, { mode: "build-from", build_applicable: true });
    assert.deepEqual(anonymize(readScore(o4)).evaluation, { mode: "build-from", build_applicable: true });
  });
});

test("#513 (c) 停止段：A5 の 5 つと decl-check:limit が別に数えられ、limit は枯渇 1 以上で decl-check:limit・0 で今までどおり、知らない値は unknown。到達数は段の記録と一致し、到達 0 の段は「今回未観測」と分母つき。持ち越しの 4 つの件数と本の数が合い、読めない本は欠測、v1 は null", async () => {
  // 純粋な関数
  assert.equal(stopValueOf({ failure: { stage: "name-table", kind: "unmet" }, stop_reason: "unmet" }), "name-table:unmet");
  assert.equal(stopValueOf({ failure: null, stop_reason: "limit" }, 1), "decl-check:limit");
  assert.equal(stopValueOf({ failure: null, stop_reason: "limit" }, 0), "limit");
  assert.equal(stopValueOf({ failure: null, stop_reason: "limit" }, null), "limit");
  assert.equal(stopValueOf({ failure: null, stop_reason: MARK513 }), "unknown");
  assert.equal(stopValueOf({ failure: { stage: MARK513, kind: "unmet" } }), "unknown");
  assert.deepEqual(EXPECTED_STOPS, ["name-table:unmet", "semantic-check:malformed", "test-spec:unmet", "decl-check:malformed", "carry-over:unmet", "decl-check:limit"]);
  const plan11 = {
    "P1-r1": { summary: { failure: { stage: "name-table", kind: "unmet" }, stop_reason: "unmet", stages: [{ stage: "name-table" }, { stage: "name-table" }] } },
    "P1-r2": { summary: { failure: { stage: "semantic-check", kind: "malformed" }, stop_reason: "malformed", stages: [{ stage: "name-table" }, { stage: "semantic-check" }] }, carry: { entries: [], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } },
    "P1-r3": { summary: { failure: { stage: "test-spec", kind: "unmet" }, stop_reason: "unmet", stages: [{ stage: "name-table" }, { stage: "semantic-check" }, { stage: "test-spec" }] }, carry: { entries: [{ requirementId: "R1", reasons: [{ origin: "name-table", reason: "r" }] }, { requirementId: "R2", reasons: [{ origin: "semantic-check", reason: "r" }, { origin: "semantic-check", reason: "r" }] }], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } },
    "P1-r4": { summary: { failure: { stage: "decl-check", kind: "malformed" }, stop_reason: "malformed", stages: [{ stage: "name-table" }, { stage: "decl-check" }] }, carry: "{" },
    "P1-r5": { summary: { failure: { stage: "carry-over", kind: "unmet" }, stop_reason: "unmet", stages: [{ stage: "name-table" }, { stage: "carry-over" }] }, carry: { entries: [{ requirementId: "R1", reasons: [{ origin: "name-table", reason: "r" }] }, { requirementId: "R2", reasons: [{ origin: "decl-check", reason: "r" }, { origin: "coverage", reason: "r" }] }, { requirementId: "R3", reasons: [{ origin: MARK513, reason: "r" }] }], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } },
    "P1-r6": { summary: { stop_reason: "limit", stages: [{ stage: "name-table" }, { stage: "decl-check" }] }, verification: { table_sha256: "t", test_suite_sha256: "s", declaration_sha256: "d", checked_declaration_sha256s: ["d"], decl_check: { exhausted: 1, malformed: 0, rejected: 2 } }, carry: { entries: [{ requirementId: "R1", reasons: [{ origin: "decl-check", reason: "r" }] }], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } },
    "P1-r7": { summary: { stop_reason: "limit", stages: [{ stage: "name-table" }] }, verification: { table_sha256: "t", test_suite_sha256: "s", declaration_sha256: "d", checked_declaration_sha256s: ["d"], decl_check: { exhausted: 0, malformed: 0, rejected: 0 } }, carry: { requirements: [] } },
    "P1-r8": { summary: { stop_reason: MARK513, stages: [{ stage: MARK513 }] } },
    "P1-r9": { summary: { stop_reason: "completed", stages: [{ stage: "name-table" }, { stage: "bundle" }] }, carry: { entries: [], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } },
  };
  await withOut(async (base) => {
    const f = compareFixture(base, "c", { pids: ["P1"], runs: 9, runOf: (g, id) => (g === "v1" ? { summary: { stages: [{ stage: "design" }, { stage: "write" }] } } : plan11[id]) });
    const r = scoreCompareRun(f.out);
    assert.equal(r.status, 0, r.stderr);
    const g = readCompare(f.out).groups["v1.1a"], g1 = readCompare(f.out).groups.v1;
    assert.deepEqual(g.stops.expected, { "name-table:unmet": 1, "semantic-check:malformed": 1, "test-spec:unmet": 1, "decl-check:malformed": 1, "carry-over:unmet": 1, "decl-check:limit": 1 });
    assert.deepEqual(g.stops.values, { "name-table:unmet": 1, "semantic-check:malformed": 1, "test-spec:unmet": 1, "decl-check:malformed": 1, "carry-over:unmet": 1, "decl-check:limit": 1, limit: 1, unknown: 1, completed: 1 });
    assert.deepEqual([g.stops.planned, g.stops.unexecuted, g.stops.incomplete, g.stops.no_summary], [9, 0, 0, 0]);
    assert.deepEqual(g1.stops.values, { completed: 9 });
    // 到達数：段の記録に現れた本の数（同じ本で繰り返しても 1）
    assert.deepEqual(g.reach["name-table"], { reached: 8, planned: 9, label: "8/9" });
    assert.deepEqual([g.reach["semantic-check"].reached, g.reach["test-spec"].reached, g.reach["decl-check"].reached, g.reach["carry-over"].reached, g.reach.bundle.reached], [2, 1, 2, 1, 1]);
    assert.deepEqual(g.reach.coverage, { reached: 0, planned: 9, label: "今回未観測（0/9）" });
    assert.deepEqual(g1.reach["name-table"], { reached: 0, planned: 9, label: "今回未観測（0/9）" });
    assert.deepEqual(g1.reach.design, { reached: 9, planned: 9, label: "9/9" });
    assert.deepEqual(Object.keys(g.reach), BUILD_STAGE_IDS);
    // 持ち越し：読めた本 5（r2・r3・r5・r6・r9）、欠測 4（記録なし r1・r8、JSON でない r4、欄の形が違う r7）
    assert.deepEqual(g.carry_over, { runs: 9, observed: 5, missing: 4, runs_with_carry_over: 3, sources: { "name-table": 2, "semantic-check": 1, "decl-check": 2, coverage: 1, unknown: 1 } });
    assert.equal(g1.carry_over, null);
    assert.ok(!r.stdout.includes(MARK513) && !readFileSync(join(f.out, "score-compare.json"), "utf8").includes(MARK513), "知らない値をそのまま出さない");
  });
});

test("#513 (d) 対の差：対 6（＋1 が 2・0 が 3・−1 が 1）で件数・n・平均・区間が手計算と一致し、候補だけ PASS の対が ＋1。P 別の一覧と平均。締切で止まった本は PASS 0 で分母に残る。n が 1 なら区間 null", async () => {
  // 手計算：差 [1, 1, 0, 0, 0, -1]、平均 1/6、標本分散 (2·(5/6)² + 3·(1/6)² + (7/6)²) / 5 = 102/180
  const m = 1 / 6, sd = Math.sqrt(102 / 180), h = (1.96 * sd) / Math.sqrt(6), r6 = (x) => Math.round(x * 1e6) / 1e6;
  assert.deepEqual(pairStats([1, 1, 0, 0, 0, -1]), { n: 6, counts: { "+1": 2, 0: 3, "-1": 1 }, mean: r6(m), sd: r6(sd), interval: [r6(m - h), r6(m + h)] });
  assert.deepEqual(pairStats([1]), { n: 1, counts: { "+1": 1, 0: 0, "-1": 0 }, mean: 1, sd: null, interval: null });
  assert.deepEqual(pairStats([]), { n: 0, counts: { "+1": 0, 0: 0, "-1": 0 }, mean: null, sd: null, interval: null });
  // 対ごとの宣言：P1-r1・P1-r2 は候補だけ PASS（＋1）、P1-r3 は両方 PASS、P2-r1 は両方 FAIL、P2-r2 は候補が締切で止まり宣言なし・比較元も FAIL（0）、P2-r3 は比較元だけ PASS（−1）
  const plan = { "P1-r1": [FAIL_A, PASS_A], "P1-r2": [FAIL_A, PASS_A], "P1-r3": [PASS_A, PASS_A], "P2-r1": [FAIL_A, FAIL_A], "P2-r2": [FAIL_A, null], "P2-r3": [PASS_A, FAIL_A] };
  await withOut(async (base) => {
    const f = compareFixture(base, "d", { runOf: (g, id) => { const spec = plan[id][g === "v1" ? 0 : 1]; return spec === null ? { summary: { verdict: "none", stop_reason: "deadline", failure: { stage: "write", kind: "deadline" } } } : { spec }; } });
    const r = scoreCompareRun(f.out);
    assert.equal(r.status, 0, r.stderr);
    const p = readCompare(f.out).pairs;
    assert.deepEqual([p.planned, p.both, p.one_side, p.none, p.n], [6, 6, 0, 0, 6]);
    assert.deepEqual(p.counts, { "+1": 2, 0: 3, "-1": 1 });
    assert.deepEqual([p.mean, p.sd, p.interval], [r6(m), r6(sd), [r6(m - h), r6(m + h)]]);
    assert.deepEqual(p.rows.map((x) => x.diff), [1, 1, 0, 0, 0, -1]);
    assert.deepEqual(p.rows[0].pass, { v1: 0, "v1.1a": 1 }, "候補だけ PASS の対が ＋1");
    assert.deepEqual(p.rows[4].pass, { v1: 0, "v1.1a": 0 }, "締切で止まった本は PASS 0 で分母に残る");
    assert.deepEqual(p.by_pattern, { P1: { diffs: [1, 1, 0], n: 3, mean: r6(2 / 3) }, P2: { diffs: [0, 0, -1], n: 3, mean: r6(-1 / 3) } });
    const c = readCompare(f.out);
    assert.equal(c.diff_direction.startsWith("候補（v1.1a）− 比較元（v1）"), true);
    startsWith(c.groups.v1.pass_executed, "2/6（");
    startsWith(c.groups["v1.1a"].pass_executed, "3/6（");
    assert.equal(c.groups["v1.1a"].stops.values["write:deadline"], 1);
    assert.equal(c.completion.status, "complete");
    assert.match(r.stdout, /pair\tP1-r1\t先行 v1\tv1 executed PASS=0\tv1\.1a executed PASS=1\t差 \+1/);
    // n が 1（両方終わった対が 1 つ）なら区間は null
    const f1 = compareFixture(base, "d1", { pids: ["P1"], runs: 2, runOf: (g, id) => (id === "P1-r2" && g === "v1.1a" ? { state: "unexecuted" } : { spec: PASS_A }) });
    assert.equal(scoreCompareRun(f1.out).status, 0);
    const p1 = readCompare(f1.out).pairs;
    assert.deepEqual([p1.n, p1.one_side, p1.interval, p1.mean], [1, 1, null, 0]);
    assert.equal(p1.rows[1].diff, null, "片側だけの対は差 null で n に入れない");
  });
});

test("#513 (e) 照合：全条件を満たせば complete。片側の対・予算の符号・diagnostic のそれぞれで incomplete・「未完了」・reference_only 真（diagnostic は「診断」も）", async () => {
  await withOut(async (base) => {
    const all = () => ({ spec: PASS_A });
    const ok = compareFixture(base, "e-ok", { runOf: all });
    assert.equal(scoreCompareRun(ok.out).status, 0);
    assert.deepEqual((({ status, label, reference_only, reasons }) => ({ status, label, reference_only, reasons }))(readCompare(ok.out).completion), { status: "complete", label: "完了", reference_only: false, reasons: [] });
    const cases = [
      ["e-one-side", { runOf: (g, id) => (g === "v1.1a" && id === "P2-r3" ? { state: "unexecuted" } : all()) }, null, "未完了", ["両方が終わっていない対がある", "群の照合が完了でない"]],
      ["e-incomplete-run", { runOf: (g, id) => (g === "v1" && id === "P1-r1" ? { state: "incomplete" } : all()) }, null, "未完了", ["両方が終わっていない対がある", "群の照合が完了でない"]],
      ["e-budget", { runOf: all }, (out) => writeFileSync(join(out, "compare-run-1.json"), JSON.stringify({ stop_code: "budget" })), "未完了", ["全体の予算の停止の記録がある"]],
      ["e-diagnostic", { runOf: all, profile: "diagnostic" }, null, "未完了・診断", ["正式な比較の条件を満たさない（診断）"]],
    ];
    for (const [name, opts, tweak, label, reasons] of cases) {
      const f = compareFixture(base, name, opts);
      if (tweak) tweak(f.out);
      const r = scoreCompareRun(f.out);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      const c = readCompare(f.out).completion;
      assert.deepEqual([c.status, c.label, c.reference_only, c.reasons], ["incomplete", label, true, reasons], name);
      assert.match(r.stdout, new RegExp(`比較: ${label}（参考値。正式な比較基準にしない）`), name);
    }
  });
});

// 計測 → 予算の停止 → 採点：run-agent.mjs --compare を偽物の工場で流して止めた出力先を、そのまま採点する（採点の定義・spec-engine の dist は本物の写しとリンク）
const fakeFactoryCli513 = String.raw`import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 1200000;
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) {
  const outDir = process.argv[process.argv.indexOf("--out") + 1], runDir = dirname(outDir), id = basename(dirname(runDir)) + "/" + basename(runDir);
  mkdirSync(outDir, { recursive: true });
  const delay = JSON.parse(process.env.FAKE_DELAY ?? "{}")[id] ?? 0;
  setTimeout(() => { if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, id + "\n"); process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "partial", stop_reason: "completed", provider_cost_usd: 0.25 }) + "\n"); }, delay);
}
`;
const fakeCliPlan513 = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
export function parsePlanFile(text) { let v; try { v = JSON.parse(text); } catch { return { code: "plan-file-json" }; } return { envelope: { schema_version: v.schema_version, outcome: v.outcome, plan: v.plan, plan_sha256: v.plan_sha256, source_sha256: v.source_sha256 } }; }
export async function validatePlanFile({ envelope, source }) {
  if (envelope.outcome !== "confirmed") return { kind: "rejected", check: "outcome", codes: [] };
  const planSha256 = h(JSON.stringify(envelope.plan)), sourceSha256 = h(source);
  if (planSha256 !== envelope.plan_sha256) return { kind: "rejected", check: "plan-sha256", codes: [] };
  if (sourceSha256 !== envelope.source_sha256) return { kind: "rejected", check: "source-sha256", codes: [] };
  return { kind: "ok", plan: envelope.plan, planSha256, sourceSha256 };
}
`;
const limits513 = (table) => `export const DEFAULT_REASONING_EFFORT = "high";\nexport const STAGE_MAX_OUTPUT_TOKENS = { high: ${JSON.stringify(table)} };\n`;
function measureCheckout(base, name, table) {
  const co = makeCheckout(base, name, { sameAggregator: true }).repo;
  mkdirSync(join(co, "packages/factory/dist"), { recursive: true });
  writeFileSync(join(co, "packages/factory/package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(co, "packages/factory/dist/cli.js"), fakeFactoryCli513);
  writeFileSync(join(co, "packages/factory/dist/cli-plan.js"), fakeCliPlan513);
  writeFileSync(join(co, "packages/factory/dist/openai.js"), 'export const DEFAULT_OPENAI_MODEL = "fake-model";\n');
  writeFileSync(join(co, "packages/factory/dist/limits.js"), limits513(table));
  return co;
}

test("#513 (e) 計測 → 予算の停止 → 採点：上限 0.60 は n=1・片側 0 対、0.59 は n=0・片側 1 対・差 null で、どちらも断らず incomplete・reference_only 真", async () => {
  await withOut(async (base) => {
    const v10 = { surface: 32768, questions: 32768, requirements: 16384, "reverse-check": 8192, design: 32768, "test-suite": 32768, write: 32768, correspondence: 16384, repair: 32768, arbitration: 16384 };
    const cand = measureCheckout(base, "cand", { ...v10, ...APPROVED513 }), baseCo = measureCheckout(base, "base", v10);
    // 凍結した組（P1・P2 を採用）：包みは偽物の検査と同じ SHA の取り方
    const set = loadEvalSet(join(cand, DEFAULT_SET_PATH));
    const fzDir = join(base, "fz");
    mkdirSync(join(fzDir, "envelopes"), { recursive: true });
    const adopted = ["P1", "P2"].map((pid) => {
      const planBody = { plan_id: `plan-${pid}`, vocabulary_version: "v1" };
      const env = { schema_version: "musunest-factory/plan-only-result/v1", outcome: "confirmed", plan: planBody, plan_sha256: sha256(JSON.stringify(planBody)), source_sha256: sha256(set.byId.get(pid).requestText + "\n"), conditions: null, stop: null };
      const bytes = Buffer.from(JSON.stringify(env));
      writeFileSync(join(fzDir, "envelopes", `${pid}.json`), bytes);
      return { pattern: pid, envelope: { path: `envelopes/${pid}.json`, sha256: sha256(bytes) }, plan_sha256: env.plan_sha256, source_sha256: env.source_sha256 };
    });
    const fz = join(fzDir, "frozen-plan-set.json");
    writeFileSync(fz, JSON.stringify({ schema: "musunest-eval/frozen-plan-set/v1", id: "t", version: 1, origin: "frozen-plan", rule: null, set: { path: DEFAULT_SET_PATH, sha256: set.sha256, id: set.set.id, version: set.set.version }, adopted, missing: [] }));
    const runAgentFile = join(here, "run-agent.mjs");
    const pairs = join(base, "pairs.json");
    const mp = spawnSync(process.execPath, [runAgentFile, cand, join(base, "unused"), "--make-pairs", pairs, "--build-from", fz, "--runs", "3"], { encoding: "utf8", env: { ...process.env, JEV_API_KEY: "" } });
    assert.equal(mp.status, 0, mp.stderr);
    for (const [limit, n, oneSide] of [["0.60", 1, 0], ["0.59", 0, 1]]) {
      const out = join(base, `out-${limit}`);
      const m = spawnSync(process.execPath, [runAgentFile, cand, out, "--compare", "--baseline", baseCo, "--pairs", pairs, "--build-from", fz, "--budget-usd", limit, "--factory-budget-usd", "0.30", "--concurrency", "2"], { encoding: "utf8", env: { ...process.env, JEV_API_KEY: "", FAKE_DELAY: JSON.stringify({ "v1/P1-r1": 700 }) } });
      assert.equal(m.status, 0, m.stderr);
      for (const g of ["v1", "v1.1a"]) { const cg = JSON.parse(readFileSync(join(out, g, "conditions.json"), "utf8")); assert.equal(conditionsSignature(cg), cg.signature, `${g}: 採点の署名の式が計測の道具と同じ`); }
      const r = scoreCompareRun(out, [], cand);
      assert.equal(r.status, 0, `${limit}: ${r.stderr}`);
      const c = readCompare(out);
      assert.deepEqual([c.pairs.n, c.pairs.one_side, c.pairs.planned], [n, oneSide, 6], limit);
      if (n === 0) assert.equal(c.pairs.mean, null);
      if (oneSide === 1) assert.equal(c.pairs.rows[0].diff, null);
      assert.deepEqual([c.completion.status, c.completion.reference_only, c.completion.budget_stop], ["incomplete", true, true], limit);
      assert.ok(c.completion.label.startsWith("未完了"), limit);
      assert.deepEqual(c.completion.unverified, [], `${limit}: 指紋は一致する`);
      assert.equal(c.profile, "diagnostic");
    }
  });
});

test("#513 (f) 予定外・食い違いは compare:scoring-mismatch で断る：対のファイルを 1 行変えた・群の params が pipeline と上限の欄以外で違う・片群に予定外の本。pipeline と上限の欄だけの違いは断らない", async () => {
  await withOut(async (base) => {
    const all = () => ({ spec: PASS_A });
    const cases = [
      ["f-pairs", {}, (out) => { const t = readFileSync(join(out, "pairs.json"), "utf8").split("\n"); t[1] = t[1] + " "; writeFileSync(join(out, "pairs.json"), t.join("\n")); }],
      ["f-params", { groupsExtra: { v1: { params: { ...paramsFor(["P1-r1", "P1-r2", "P1-r3", "P2-r1", "P2-r2", "P2-r3"]), mode: "build-from", plan: false, effort: "medium", pipeline: "v1", stage_output_limits_v11a: null } } } }, null],
      ["f-extra", {}, (out) => { mkdirSync(join(out, "v1.1a", "P5-r1"), { recursive: true }); writeFileSync(join(out, "v1.1a", "P5-r1", "summary.line.json"), sl513()); }],
      ["f-group-pairs", {}, (out) => { const p = join(out, "v1", "conditions.json"), c = JSON.parse(readFileSync(p, "utf8")); c.comparison.pairs_sha256 = "0".repeat(64); writeFileSync(p, JSON.stringify(c)); }],
      ["f-record", {}, (out) => writeFileSync(join(out, "comparison.json"), JSON.stringify({ pairs: { sha256: "0".repeat(64) }, profile: "official" }))],
      // 群の同定（独立レビューの指摘 3）：候補の群の条件を比較元の群のもので置き換えた（両方 pipeline=v1）・群の入れ替え・群の複製・比較の記録の署名との食い違い
      ["f-replaced", {}, (out) => cpSync(join(out, "v1", "conditions.json"), join(out, "v1.1a", "conditions.json"))],
      ["f-swapped", {}, (out) => { const a = readFileSync(join(out, "v1", "conditions.json")), b = readFileSync(join(out, "v1.1a", "conditions.json")); writeFileSync(join(out, "v1", "conditions.json"), b); writeFileSync(join(out, "v1.1a", "conditions.json"), a); }],
      ["f-duplicated", {}, (out) => { rmSync(join(out, "v1.1a"), { recursive: true }); cpSync(join(out, "v1"), join(out, "v1.1a"), { recursive: true }); }],
      ["f-relabeled", {}, (out) => { const p = join(out, "v1.1a", "conditions.json"), c = JSON.parse(readFileSync(p, "utf8")); const v1 = JSON.parse(readFileSync(join(out, "v1", "conditions.json"), "utf8")); writeFileSync(p, JSON.stringify({ ...v1, comparison: { ...v1.comparison, group: "v1.1a", role: "candidate" }, params: { ...v1.params, pipeline: "v1.1a" }, signature: c.signature })); }],
      ["f-record-signature", {}, (out) => { const p = join(out, "comparison.json"), c = JSON.parse(readFileSync(p, "utf8")); c.groups["v1.1a"].conditions_signature = "0".repeat(64); writeFileSync(p, JSON.stringify(c)); }],
      ["f-same-signature", { groupsExtra: { v1: { signature: SIG }, "v1.1a": { signature: SIG } } }, null],
    ];
    for (const [name, opts, tweak] of cases) {
      const f = compareFixture(base, name, { runOf: all, ...opts });
      if (tweak) tweak(f.out);
      const r = scoreCompareRun(f.out);
      assert.equal(r.status, 3, `${name}: ${r.stderr}`);
      assert.match(r.stderr, /\[compare:scoring-mismatch\]/, name);
      assert.equal(existsSync(join(f.out, "score-compare.json")), false, `${name}: 書いた`);
    }
    // 経路と v1.1α の上限の欄だけが違う（今の形）なら断らない
    const ok = compareFixture(base, "f-ok", { runOf: all, groupsExtra: { "v1.1a": { params: { ...paramsFor(["P1-r1", "P1-r2", "P1-r3", "P2-r1", "P2-r2", "P2-r3"]), mode: "build-from", plan: false, effort: "high", pipeline: "v1.1a", stage_output_limits_v11a: { ...APPROVED513, "decl-check": 1 } } } } });
    assert.equal(scoreCompareRun(ok.out).status, 0);
    // 比較の記録が無い
    rmSync(join(ok.out, "comparison.json"));
    const rm = scoreCompareRun(ok.out);
    assert.equal(rm.status, 3);
    assert.match(rm.stderr, /\[compare:record-missing\]/);
  });
});

test("#513 (g) 記録のあとに採点の定義の中身を変えた・凍結した組のファイルを変えた・片群の条件の schema が知らない値、のそれぞれで断らずに unverified・「未照合」・reference_only 真。どの照合が false か null かが出る", async () => {
  await withOut(async (base) => {
    const all = () => ({ spec: PASS_A });
    // 採点の定義：別の checkout（採点器は同じ版）で記録し、そのあと題材の定義を変える
    const co = makeCheckout(base, "co-g", { sameAggregator: true }).repo;
    const fs = compareFixture(base, "g-scoring", { runOf: all, repoDir: co });
    appendFileSync(join(co, "workspace/mvp/m1/agent/eval/subjects/A.json"), "\n");
    const fz = compareFixture(base, "g-frozen", { runOf: all });
    appendFileSync(fz.frozenPath, "\n");
    const fu = compareFixture(base, "g-schema", { runOf: all, groupsExtra: { v1: { schema: `musunest-factory/agent-accept-conditions/${MARK513}` } } });
    const expected = [
      [fs.out, co, [{ group: "v1", check: "scoring_matches_conditions", value: false }, { group: "v1.1a", check: "scoring_matches_conditions", value: false }]],
      [fz.out, repo, [{ group: "v1", check: "frozen_matches_conditions", value: false }, { group: "v1.1a", check: "frozen_matches_conditions", value: false }]],
      [fu.out, repo, [{ group: "v1", check: "reconcile", value: "unverified" }]],
    ];
    for (const [out, repoArg, unverified] of expected) {
      const r = scoreCompareRun(out, [], repoArg);
      assert.equal(r.status, 0, r.stderr);
      const c = readCompare(out).completion;
      assert.deepEqual([c.status, c.label, c.reference_only], ["unverified", "未照合", true], out);
      for (const u of unverified) assert.ok(c.unverified.some((x) => x.group === u.group && x.check === u.check && x.value === u.value), `${JSON.stringify(u)} が無い: ${JSON.stringify(c.unverified)}`);
      assert.match(r.stdout, /比較: 未照合（参考値。正式な比較基準にしない）.*未照合の項目: /);
      assert.ok(!r.stdout.includes(MARK513), "知らない schema の値を出さない");
    }
    // 照合の null（条件に指紋が無い）も未照合
    const fn = compareFixture(base, "g-null", { runOf: all, groupsExtra: { "v1.1a": { scripts: { mode: "post-hoc" } } } });
    assert.equal(scoreCompareRun(fn.out).status, 0);
    assert.ok(readCompare(fn.out).completion.unverified.some((x) => x.group === "v1.1a" && x.check === "scripts_matches_conditions" && x.value === null));
  });
});

test("#513 (h) --compare --anonymous の JSON・標準出力・標準エラーに本の ID・パス・目印が出ず、件数・率・区間・既知の値だけ", async () => {
  await withOut(async (base) => {
    const f = compareFixture(base, `h-${MARK513}`, { runOf: (g, id) => (id === "P2-r3" && g === "v1.1a" ? { state: "unexecuted" } : { spec: id.startsWith("P1") ? PASS_A : FAIL_A, stdout: `${MARK513} ${id}\n`, summary: { stop_reason: MARK513, stages: [{ stage: "write" }] }, carry: { entries: [{ requirementId: "R1", reasons: [{ origin: MARK513, reason: "r" }] }], excluded_row_ids: [], remaining_requirement_ids: ["R9"] } }) });
    const r = scoreCompareRun(f.out, ["--anonymous", "--label", "h"]);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(f.out, "score-compare-h.anonymous.json"), "utf8");
    assert.equal(existsSync(join(f.out, "score-compare-h.json")), false, "行つきの出力を書かない");
    for (const t of [text, r.stdout, r.stderr]) {
      assert.ok(!t.includes(MARK513), "目印が出た");
      assert.ok(!t.includes(base) && !t.includes("frozen.json"), "パスが出た");
      assert.ok(!/P\d+-r\d+/.test(t) && !/"P\d+"/.test(t), "本の ID・P の ID が出た");
    }
    const a = JSON.parse(text);
    assert.equal(a.anonymous, true);
    assert.deepEqual([a.pairs.planned, a.pairs.both, a.pairs.one_side, a.pairs.n], [6, 5, 1, 5]);
    assert.deepEqual(a.pairs.counts, { "+1": 0, 0: 5, "-1": 0 });
    assert.deepEqual(a.groups["v1.1a"].stops.values, { unknown: 5 });
    assert.deepEqual(a.groups["v1.1a"].carry_over.sources, { "name-table": 0, "semantic-check": 0, "decl-check": 0, coverage: 0, unknown: 5 });
    startsWith(a.groups.v1.pass_executed, "3/6（");
    assert.equal(a.completion.status, "incomplete");
    assert.equal(a.completion.reference_only, true);
    assert.equal("rows" in a.pairs || "by_pattern" in a.pairs, false);
    assert.equal("fail_keys" in a.groups.v1.accepted, false);
  });
});

test("#513 (i) 採点のコードに通信の import（http・https・net・fetch）が無い（採点の費用は 0 と記録する根拠）", () => {
  const text = readFileSync(scoreFile, "utf8");
  assert.ok(!/from\s+["'](node:)?(http|https|net|http2|dgram|tls)["']/.test(text), "通信の import がある");
  assert.ok(!/import\(\s*["'](node:)?(http|https|net|http2|dgram|tls)["']/.test(text), "通信の動的 import がある");
  assert.ok(!/\bfetch\s*\(/.test(text), "fetch を呼んでいる");
});

// ── #513 の後段：工場の dist（#505〜#510。先に pnpm build）と採点の道具の定数・記録の形・規則の台帳が一致すること
import { CARRY_OVER_SOURCES, DECL_CHECK_LIMIT, V11A_APPROVED_LIMITS, V11A_OUTPUT_STAGES, V11A_RECORDS, V1_OUTPUT_STAGES } from "./score-agent.mjs";
const factoryDist = join(repo, "packages/factory/dist");
assert.ok(existsSync(join(factoryDist, "record.js")), "工場の dist が無い（pnpm build を先に）");
const distModule = (rel) => import(pathToFileURL(join(factoryDist, rel)).href);

test("#513 (a) BUILD_STAGE_IDS が工場の dist の STAGE_IDS と同じ並びで 19 個。出力の段・上限・持ち越しの出どころ・記録の場所も dist と同じ", async () => {
  const record = await distModule("record.js"), limits = await distModule("limits.js");
  assert.deepEqual(BUILD_STAGE_IDS, [...record.STAGE_IDS]);
  assert.equal(record.STAGE_IDS.length, 19);
  assert.deepEqual([...V1_OUTPUT_STAGES, ...V11A_OUTPUT_STAGES], [...limits.OUTPUT_STAGES]);
  for (const effort of Object.keys(limits.STAGE_MAX_OUTPUT_TOKENS)) for (const k of V11A_OUTPUT_STAGES) assert.equal(limits.STAGE_MAX_OUTPUT_TOKENS[effort][k], V11A_APPROVED_LIMITS[k], `${effort} ${k}`);
  const carry = await distModule("v11a/carry-over.js"), bundle = await distModule("v11a/bundle-v11a.js");
  assert.deepEqual(CARRY_OVER_SOURCES, [...carry.CARRY_OVER_ORIGINS]);
  assert.equal(V11A_RECORDS.verification, `bundle/${bundle.V11A_ARTIFACT_NAMES.verification}`);
  assert.equal(V11A_RECORDS.carry_over, `bundle/${bundle.V11A_ARTIFACT_NAMES.carryOver}`);
});

test("#513 (c) 工場の dist が組む実物の記録（verification-v11a.json・carry-over.json）で、decl-check:limit と持ち越しの出どころを数える", async () => {
  const { buildV11aArtifacts } = await distModule("v11a/bundle-v11a.js");
  const artifactsOf = ({ exhausted, entries }) => buildV11aArtifacts({
    nameTable: { table: { rows: [], ownership: [], verification: [], classification: [] }, sha256: "t" }, semanticCheck: [], judgeAdvice: [],
    testSpec: { suite: { tests: [] }, sha256: "s", observes: new Map(), coverage: [], overturnedTestIds: [], coverageChecks: [] },
    declCheck: { limit: 6, versions: [] }, carryOver: { entries, excludedRowIds: [], remainingRequirementIds: ["R9"] },
    verification: { tableSha256: "t", testSuiteSha256: "s", declarationSha256: "d", checkedDeclarationSha256s: ["d"], declCheck: { exhausted, malformed: 0, rejected: 1 } },
  });
  const reasons = (...origins) => origins.map((origin) => ({ origin, reason: "r" }));
  const plan = {
    "P1-r1": { summary: { stop_reason: "limit" }, art: artifactsOf({ exhausted: 1, entries: [{ requirementId: "R1", reasons: reasons("decl-check") }] }) },
    "P1-r2": { summary: { stop_reason: "limit" }, art: artifactsOf({ exhausted: 0, entries: [] }) },
    "P1-r3": { summary: { stop_reason: "completed" }, art: artifactsOf({ exhausted: 0, entries: [{ requirementId: "R1", reasons: reasons("name-table", "semantic-check") }, { requirementId: "R2", reasons: reasons("coverage", "coverage") }] }) },
  };
  await withOut(async (base) => {
    const f = compareFixture(base, "c-dist", { pids: ["P1"], runs: 3, runOf: (g, id) => (g === "v1" ? {} : { summary: plan[id].summary }) });
    for (const [id, x] of Object.entries(plan)) for (const a of x.art) { const p = join(f.out, "v1.1a", id, "bundle", a.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, a.text); }
    const r = scoreCompareRun(f.out);
    assert.equal(r.status, 0, r.stderr);
    const g = readCompare(f.out).groups["v1.1a"];
    assert.deepEqual(g.stops.values, { [DECL_CHECK_LIMIT]: 1, limit: 1, completed: 1 });
    assert.deepEqual(g.carry_over, { runs: 3, observed: 3, missing: 0, runs_with_carry_over: 2, sources: { "name-table": 1, "semantic-check": 1, "decl-check": 1, coverage: 1, unknown: 0 } });
  });
});

test("#513 規則の台帳：rules.md §5 の 5 つの接頭辞の行の数と ID の集合が工場の dist の RuleDefinition[] と一致し、各行に なぜ（Issue 番号）と契約の根拠がある", async () => {
  const text = readFileSync(join(repo, "workspace/mvp/m1/agent/methodology/ledger/rules.md"), "utf8");
  const v11a = text.slice(text.indexOf("## 5. v1.1α の規則"));
  assert.ok(v11a.length > 0 && text.indexOf("## 5. v1.1α の規則") > 0, "§5 が無い");
  const rows = v11a.split("\n").filter((l) => /^\| R-(nt|sc|tsp|dc|w11)-\d+ \|/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const arrays = [["R-nt", "name-table", "NAME_TABLE"], ["R-sc", "semantic-check", "SEMANTIC_CHECK"], ["R-tsp", "test-spec", "TEST_SPEC"], ["R-dc", "decl-check", "DECL_CHECK"], ["R-w11", "write", "WRITE_V11A"]];
  let total = 0;
  for (const [prefix, file, name] of arrays) {
    const defs = (await distModule(`v11a/stages/${file}.js`))[`${name}_RULE_DEFINITIONS`];
    const mine = rows.filter((r) => r[0].startsWith(`${prefix}-`));
    assert.equal(mine.length, defs.length, `${prefix} の行の数`);
    assert.deepEqual(mine.map((r) => r[0]).sort(), defs.map((d) => d.id).sort(), `${prefix} の ID の集合`);
    for (const r of mine) {
      const d = defs.find((x) => x.id === r[0]);
      assert.ok(r[2].includes(d.since.replace("Issue ", "")), `${r[0]}: なぜに Issue 番号が無い`);
      assert.match(r[3], /^設計書 07 /, `${r[0]}: 契約の根拠が無い`);
    }
    total += defs.length;
  }
  assert.equal(rows.length, total, "5 つの接頭辞の外の行がある");
  assert.ok(text.includes(`v1.1α（比較用の別の経路。設計書 \`../../07-architecture-v1.1a.md\`）の配列の要素は **${total}**`), "§1 の v1.1α の数が配列と合わない");
});

test("#513 停止の台帳：failure-modes.md に N1〜N8 の 8 行があり、観測の列が「今回未観測」で、主因が「未確定（設計の推定）」", () => {
  const text = readFileSync(join(repo, "workspace/mvp/m1/agent/methodology/ledger/failure-modes.md"), "utf8");
  const rows = text.split("\n").filter((l) => /^\| N\d+ \|/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  assert.deepEqual(rows.map((r) => r[0]), ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"]);
  for (const r of rows) {
    assert.equal(r.length, 9, `${r[0]} の列の数`);
    assert.equal(r[6], "今回未観測（計測前）", r[0]);
    assert.match(r[5], /^未確定（設計の推定/, r[0]);
    assert.ok(!/R\d|P\d|role|\bf\.|\be\./.test(r.join("")), `${r[0]} に値（要件 ID・P・役割 ID）がある`);
  }
});

// ── #538：漏斗（段ごとの条件付き通過率）・pass^k・工場の判定の 4 値（unverified の口）。設計書 08 §7・§8.1・§8.4。README §5.9
import { ACCEPTED_VERDICTS, FACTORY_VERDICTS4, SOURCE_VERDICTS, factoryVerdict4, firstPassOf, funnelOf, passKOf, unverifiedDetailsOf } from "./score-agent.mjs";

const MARK538 = "leak-marker-538";
const RETRY0 = { communication: 0, shape: 0, content: 0 };
/** 段の記録 1 つ（工場の StageRecord の形のうち、漏斗が読む欄と失敗の種類だけ） */
const rec538 = (stage, status, calls, retries = RETRY0, failureKind = null) => ({ stage, operation: null, status, duration_ms: 1, calls, retries, failure_kind: status === "ok" ? null : failureKind ?? "unmet" });
/**
 * 段の並びの書き方（"段:記号" を空白で並べる）。1 ＝ 1 回目で通過（ok・calls 1・retries 0）、r ＝ failed のあと ok、c ＝ ok・calls 2（1 回目ではない）、
 * 0 ＝ コードの段（ok・calls 0）、x ＝ failed を 2 回（その段で止まる）、f ＝ failed を 1 回（その段で止まる）。止まる段の失敗の種類は kind
 */
const stages538 = (line, kind = "unmet") => line.split(" ").flatMap((t) => {
  const [stage, k] = t.split(":");
  return { 1: [rec538(stage, "ok", 1)], r: [rec538(stage, "failed", 1, RETRY0, kind), rec538(stage, "ok", 1)], c: [rec538(stage, "ok", 2)], 0: [rec538(stage, "ok", 0)], x: [rec538(stage, "failed", 1, RETRY0, kind), rec538(stage, "failed", 1, RETRY0, kind)], f: [rec538(stage, "failed", 1, RETRY0, kind)] }[k];
});
/** 止まった本の要約（failure がその段・その種類）と、納品した本の要約（failure なし・stop_class は completed） */
const stopped538 = (line, stage, kind) => ({ verdict: "none", assurance: "none", stop_reason: kind, stop_class: kind, failure: { stage, kind }, stages: stages538(line, kind) });
const delivered538 = (line, stopReason, over = {}) => ({ verdict: "partial", assurance: "partial", stop_reason: stopReason, stop_class: "completed", failure: null, stages: stages538(line), ...over });
/** 試験用の組：P1〜P10 の 10 P が同じ採点の定義（A）を参照する（PASS は cases の正例・負例の宣言で作る） */
const set538 = (base) => {
  // 台本は照合の指紋（scripts_matches_conditions）を持たせるためだけに置く（Plan の記録が無いので当てる問いは無い）
  writeJson(join(base, "set538/scripts/A.json"), scriptOf("A", [entry("A:e1", ["MARK_REQ"], { recommended: true })]));
  return writeJson(join(base, "set538/t-set.json"), { ...SET_DEFAULTS, items: Array.from({ length: 10 }, (_, i) => itemOf(`P${i + 1}`, "A", { style: i % 2 === 0 ? "S1" : "S2", script: "scripts/A.json" })) });
};
const ids538 = Array.from({ length: 10 }, (_, i) => [1, 2, 3].map((r) => `P${i + 1}-r${r}`)).flat().sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
/** 本を 1 つ置く（要約は sl513 の形。ver1 ＝ verification.json、v11 ＝ verification-v11a.json。summary が null なら要約の無い途中の本） */
function addRun538(out, id, { summary = {}, spec = null, ver1, v11 } = {}) {
  const rd = join(out, id);
  mkdirSync(join(rd, "bundle/artifacts"), { recursive: true });
  if (summary !== null) { writeFileSync(join(rd, "summary.line.json"), sl513(summary)); writeFileSync(join(rd, "stdout.log"), ""); writeFileSync(join(rd, "stderr.log"), ""); }
  if (spec !== null) writeFileSync(join(rd, "bundle/artifacts/app.spec.yaml"), spec);
  if (ver1 !== undefined) writeFileSync(join(rd, "bundle/artifacts/verification.json"), JSON.stringify(ver1));
  if (v11 !== undefined) writeFileSync(join(rd, "bundle/artifacts/verification-v11a.json"), JSON.stringify(v11));
}
const entry538 = (summary, over = {}) => ({ state: "executed", summary, verification: null, exhausted: null, ...over });
/** 直す前の採点の出力の欄の並び（新しい欄はこのあとに足す） */
const KEYS_BEFORE_538 = ["rubric", "aggregation_versions", "scoring_systems", "set", "metrics", "metrics_accepted", "metrics_script", "fulfillment", "completion", "fingerprints", "bySubject", "rows", "tables", "evaluation", "metrics_plan", "metrics_build"];
const ANON_KEYS_BEFORE_538 = ["rubric", "anonymous", "aggregation_versions", "scoring_systems", "runs", "metrics", "metrics_accepted", "metrics_script", "tables", "set", "fulfillment", "completion", "fingerprints", "evaluation", "metrics_plan", "metrics_build"];
const KEYS_538 = ["funnel", "pass_k", "verdicts", "unverified_details"];

test("#538 漏斗の規則 (a)〜(e)・(g)：1 回目で通過は最初の記録が ok・calls 1・retries 0（retries が無ければ ok と calls 1）。failed のあと ok は通過だが 1 回目ではない。calls 2 は 1 回目ではない。failed だけで failure.stage がその段なら停止。calls 0 の段は 1 回目が null。到達 0 の段は「今回未観測（0/予定）」", () => {
  // 純粋な規則
  assert.equal(firstPassOf([rec538("design", "ok", 1)]), true, "(a)");
  assert.equal(firstPassOf([{ stage: "design", status: "ok", calls: 1 }]), true, "(a) retries が無ければ ok と calls 1");
  assert.equal(firstPassOf([rec538("design", "ok", 1, { communication: 1, shape: 0, content: 0 })]), true, "通信の再試行は 1 回目の判定に数えない");
  assert.equal(firstPassOf([rec538("design", "ok", 1, { communication: 0, shape: 1, content: 0 })]), false, "形のやり直し");
  assert.equal(firstPassOf([rec538("design", "ok", 1, { communication: 0, shape: 0, content: 1 })]), false, "中身のやり直し");
  assert.equal(firstPassOf([rec538("design", "failed", 1), rec538("design", "ok", 1)]), false, "(b)");
  assert.equal(firstPassOf([rec538("design", "ok", 2)]), false, "(c)");
  // 5 本（予定）：
  //   1 本目 design 1 回目で通過、2 本目 failed のあと ok、3 本目 ok・calls 2、4 本目 failed だけで design で停止、5 本目 未実行。static-check は全部 calls 0
  const entries = [
    entry538(delivered538("design:1 static-check:0", "completed")),
    entry538(delivered538("design:r static-check:0", "completed")),
    entry538(delivered538("design:c static-check:0", "stagnation")),
    entry538(stopped538("design:x", "design", "unmet")),
    { state: "unexecuted", summary: null, verification: null, exhausted: null },
  ];
  const fu = funnelOf(entries);
  assert.deepEqual([fu.planned, fu.executed], [5, 4]);
  const d = fu.stages.design;
  assert.deepEqual([d.planned, d.reached, d.first_pass, d.passed, d.stopped, d.code_stage], [5, 4, 1, 3, 1, false], "(a)〜(d)");
  assert.equal(d.reached_label, "4/5");
  startsWith(d.rates.first_pass, "1/4（");
  startsWith(d.rates.passed, "3/4（");
  startsWith(d.rates.stopped, "1/4（");
  // (e) calls 0 の段：1 回目は件数も率も null（未到達の 0 と区別する）
  const sc = fu.stages["static-check"];
  assert.deepEqual([sc.reached, sc.first_pass, sc.rates.first_pass, sc.passed, sc.code_stage], [3, null, null, 3, true], "(e)");
  // (g) 到達 0 の段：件数は 0、率は「今回未観測（0/予定）」（1 回目も null ではなく 0）
  const cv = fu.stages.coverage;
  assert.deepEqual([cv.reached, cv.first_pass, cv.passed, cv.stopped, cv.code_stage], [0, 0, 0, 0, false], "(g)");
  assert.deepEqual([cv.reached_label, cv.rates.first_pass, cv.rates.passed, cv.rates.stopped], ["今回未観測（0/5）", "今回未観測（0/5）", "今回未観測（0/5）", "今回未観測（0/5）"], "(g)");
  assert.deepEqual(Object.keys(fu.stages), BUILD_STAGE_IDS, "段は BUILD_STAGE_IDS の順");
  // 完走の内訳：stop_class が completed の本を、検証の記録の不一致・未解決の件数で分ける。読めない本は欠測（0 と推測しない）
  const done = funnelOf([
    entry538(delivered538("design:1", "completed"), { verification: { test_mismatches: 0, test_unresolved: 0 } }),
    entry538(delivered538("design:1", "stagnation"), { verification: { test_mismatches: 1, test_unresolved: 0 } }),
    entry538(delivered538("design:1", "stagnation"), { verification: { test_mismatches: 0, test_unresolved: 2 } }),
    entry538(delivered538("design:1", "completed")),
    entry538(delivered538("design:1", "completed"), { verification: { test_mismatches: "0", test_unresolved: 0 } }),
    entry538(stopped538("design:x", "design", "unmet"), { verification: { test_mismatches: 0, test_unresolved: 0 } }),
  ]);
  assert.deepEqual(done.completed, { runs: 5, no_mismatch: 1, with_mismatch: 2, missing: 2 });
  assert.deepEqual(done.stops, { completed: 3, stagnation: 2, "design:unmet": 1 });
});

test("#538 漏斗の規則 (f)：未実行・途中の本は到達 0 で予定の分母に残る。採点の出力の funnel は予定した本（条件の child_args）を分母にし、標準出力に漏斗と pass^k の 1 行ずつ（既存の行は変えない）", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun538(out, "P1-r1", { summary: delivered538("design:1 test-suite:1 write:1 static-check:0 judge:0", "completed"), spec: PASS_A, ver1: { test_mismatches: 0, test_unresolved: 0 } });
    addRun538(out, "P1-r2", { summary: stopped538("design:1 test-suite:x", "test-suite", "unmet") });
    addRun538(out, "P1-r3", { summary: null, spec: PASS_A }); // 途中（要約が無い。宣言があっても到達 0・PASS 0）
    // P1-r4 は未実行（ディレクトリが無い）
    conditions(out, ["P1-r1", "P1-r2", "P1-r3", "P1-r4"]);
    const r = scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(Object.keys(full), [...KEYS_BEFORE_538, ...KEYS_538], "既存の欄の並びはそのままで、新しい欄をあとに足す");
    const fu = full.funnel;
    assert.deepEqual([fu.planned, fu.executed], [4, 2], "(f) 予定 4 本（未実行・途中を含む）");
    assert.deepEqual([fu.stages.design.reached, fu.stages.design.first_pass, fu.stages.design.passed, fu.stages.design.reached_label], [2, 2, 2, "2/4"]);
    assert.deepEqual([fu.stages["test-suite"].reached, fu.stages["test-suite"].first_pass, fu.stages["test-suite"].passed, fu.stages["test-suite"].stopped], [2, 1, 1, 1]);
    assert.deepEqual([fu.stages.judge.reached, fu.stages.judge.first_pass], [1, null]);
    assert.deepEqual(fu.completed, { runs: 1, no_mismatch: 1, with_mismatch: 0, missing: 0 });
    // pass^k：k は条件の runs（4）。途中・未実行の本は PASS 0
    assert.deepEqual(full.pass_k, { k: 4, patterns: 1, count: 0, rate: full.pass_k.rate, by_pattern: { P1: [1, 0, 0, 0] } });
    startsWith(full.pass_k.rate, "0/1（");
    // 標準出力：既存の行のあとに 1 行ずつ
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines.at(-2), /^漏斗（予定 4 本・実行 2 本。段：到達／1 回目／通過／停止。適用外は —）: design 2／2／2／0・test-suite 2／1／1／1・write 1／1／1／0・static-check 1／—／1／0・judge 1／—／1／0（未観測 14 段）・完走 1（不一致なし 1・あり 0・欠測 0）$/);
    assert.match(lines.at(-1), /^pass\^4: 0\/1（.*）（P1 1,0,0,0）$/);
    assert.match(lines.at(-3), /^指紋: 採点 /, "既存の指紋の行は漏斗の前のまま");
  });
});

test("#538 v11a-cmp2 と同じ形の fixture（30 本 × 2 群）で、設計書 08 §8.1・§8.4 の数が出る（漏斗・停止・完走の内訳・pass^3）。比較の照合は完了のまま", async () => {
  // fixture の作り方（記録から形だけを写す。段の名前・status・calls・retries・停止・判定の値。宣言は cases の正例 PASS_A・負例 FAIL_A、組は 10 P が A を参照する試験用の組）
  // v1.1α（30 本）：
  //   納品 11 本（stop_class completed）＝ 名前の表を 1 回目で通過 7 本・やり直しで通過 4 本。どれも 意味の点検 1・試験の仕様 1・書く 1・静的 0・宣言の点検 1・判定 0・束ね 0。
  //     うち 3 本が completed（不一致 0・未解決 0）、8 本が stagnation（不一致 1）。PASS 10 本（P1-r1・P2-r2・P3-r1・P3-r3・P5-r1〜r3・P6-r3・P7-r1・P7-r3）と FAIL 1 本（P4-r1）
  //   残り 19 本を ID の順に：repair:call-limit 4 本（名前の表 r・意味の点検 1・試験の仕様 c・書く 1・静的 0・修復 f。先頭の 1 本だけ宣言の点検 1 を通る）、
  //     test-spec:unmet 8 本（名前の表 r・意味の点検 1・試験の仕様 x）、name-table:unmet 7 本（名前の表 x）。宣言なし（GEN_FAIL）
  // v1（30 本）：
  //   納品 9 本（全部 PASS：P4-r3・P5-r3・P6-r1・P7-r2・P7-r3・P8-r1・P9-r1・P9-r3・P10-r3）＝ limit 4 本（設計 1・試験 1）と stagnation 5 本（設計 1・試験 r）。
  //     どれも 書く 1・静的 0・対応 1・実行 0・修復 1・判定 0。不一致 1（不一致なし 0）
  //   残り 21 本を ID の順に：correspondence:deadline 4 本（設計 1・試験 r・書く 1・静的 0・対応 f）、test-suite:unmet 3 本（設計 1・試験 x）と 7 本（設計 r・試験 x）、
  //     test-suite:malformed 1 本（設計 r・試験 x）、design:unmet 4 本（設計 x）、design:network 2 本（設計 x）。宣言なし
  const v11aPass = ["P1-r1", "P2-r2", "P3-r1", "P3-r3", "P5-r1", "P5-r2", "P5-r3", "P6-r3", "P7-r1", "P7-r3"];
  const v1Pass = ["P4-r3", "P5-r3", "P6-r1", "P7-r2", "P7-r3", "P8-r1", "P9-r1", "P9-r3", "P10-r3"];
  const plan = { v1: new Map(), "v1.1a": new Map() };
  const DONE11 = (nt) => `name-table:${nt} semantic-check:1 test-spec:1 write:1 static-check:0 decl-check:1 judge:0 bundle:0`;
  [...v11aPass, "P4-r1"].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).forEach((id, i) => plan["v1.1a"].set(id, { summary: delivered538(DONE11(i < 7 ? "1" : "r"), i < 3 ? "completed" : "stagnation"), spec: v11aPass.includes(id) ? PASS_A : FAIL_A, ver1: { test_mismatches: i < 3 ? 0 : 1, test_unresolved: 0 } }));
  const rest11 = [
    ...Array.from({ length: 4 }, (_, i) => ({ summary: stopped538(`name-table:r semantic-check:1 test-spec:c write:1 static-check:0${i === 0 ? " decl-check:1" : ""} repair:f`, "repair", "call-limit") })),
    ...Array.from({ length: 8 }, () => ({ summary: stopped538("name-table:r semantic-check:1 test-spec:x", "test-spec", "unmet") })),
    ...Array.from({ length: 7 }, () => ({ summary: stopped538("name-table:x", "name-table", "unmet") })),
  ];
  ids538.filter((id) => !plan["v1.1a"].has(id)).forEach((id, i) => plan["v1.1a"].set(id, rest11[i]));
  const DONE1 = (ts) => `design:1 test-suite:${ts} write:1 static-check:0 correspondence:1 run-tests:0 repair:1 judge:0`;
  [...v1Pass].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).forEach((id, i) => plan.v1.set(id, { summary: i < 4 ? delivered538(DONE1("1"), "limit") : delivered538(DONE1("r"), "stagnation"), spec: PASS_A, ver1: { test_mismatches: 1, test_unresolved: 0 } }));
  const rest1 = [
    ...Array.from({ length: 4 }, () => ({ summary: stopped538("design:1 test-suite:r write:1 static-check:0 correspondence:f", "correspondence", "deadline") })),
    ...Array.from({ length: 3 }, () => ({ summary: stopped538("design:1 test-suite:x", "test-suite", "unmet") })),
    ...Array.from({ length: 7 }, () => ({ summary: stopped538("design:r test-suite:x", "test-suite", "unmet") })),
    { summary: stopped538("design:r test-suite:x", "test-suite", "malformed") },
    ...Array.from({ length: 4 }, () => ({ summary: stopped538("design:x", "design", "unmet") })),
    ...Array.from({ length: 2 }, () => ({ summary: stopped538("design:x", "design", "network") })),
  ];
  ids538.filter((id) => !plan.v1.has(id)).forEach((id, i) => plan.v1.set(id, rest1[i]));
  assert.deepEqual([plan.v1.size, plan["v1.1a"].size], [30, 30]);
  await withOut(async (base) => {
    const f = compareFixture(base, "cmp538", { pids: Array.from({ length: 10 }, (_, i) => `P${i + 1}`), runs: 3, setFile: set538(base), runOf: (g, id) => plan[g].get(id) });
    const r = scoreCompareRun(f.out);
    assert.equal(r.status, 0, r.stderr);
    const c = readCompare(f.out);
    assert.equal(c.completion.status, "complete", `指紋を今の採点で記録した fixture は完了（照合は直す前と同じ）: ${JSON.stringify(c.completion)}`);
    assert.deepEqual(c.completion.unverified, []);
    const row = (g, id) => { const s = c.groups[g].funnel.stages[id]; return [s.reached, s.first_pass, s.passed, s.stopped]; };
    // v1.1α：名前の表 到達 30・1 回目 7・通過 23／意味の点検 23・23・23／試験の仕様 到達 23・1 回目 11・通過 15／書く 15／宣言の点検 到達 12／判定 11／完走 11 のうち不一致なし 3
    const a = "v1.1a";
    assert.deepEqual(row(a, "name-table"), [30, 7, 23, 7]);
    assert.deepEqual(row(a, "semantic-check"), [23, 23, 23, 0]);
    assert.deepEqual(row(a, "test-spec"), [23, 11, 15, 8]);
    assert.equal(c.groups[a].funnel.stages.write.reached, 15);
    assert.equal(c.groups[a].funnel.stages["decl-check"].reached, 12);
    assert.deepEqual(row(a, "judge"), [11, null, 11, 0], "判定はコードの段（1 回目は適用外）");
    assert.deepEqual(c.groups[a].funnel.completed, { runs: 11, no_mismatch: 3, with_mismatch: 8, missing: 0 });
    assert.deepEqual(c.groups[a].funnel.stops, { completed: 3, stagnation: 8, "repair:call-limit": 4, "test-spec:unmet": 8, "name-table:unmet": 7 });
    startsWith(c.groups[a].funnel.stages["name-table"].rates.passed, "23/30（76.7%");
    startsWith(c.groups[a].funnel.stages["test-spec"].rates.passed, "15/23（65.2%");
    // pass^3 1/10（P5 だけ）
    assert.deepEqual([c.groups[a].pass_k.k, c.groups[a].pass_k.patterns, c.groups[a].pass_k.count], [3, 10, 1]);
    startsWith(c.groups[a].pass_k.rate, "1/10（");
    assert.deepEqual(c.groups[a].pass_k.by_pattern, { P1: [1, 0, 0], P2: [0, 1, 0], P3: [1, 0, 1], P4: [0, 0, 0], P5: [1, 1, 1], P6: [0, 0, 1], P7: [1, 0, 1], P8: [0, 0, 0], P9: [0, 0, 0], P10: [0, 0, 0] });
    // v1：設計 到達 30・1 回目 16・通過 24／試験 到達 24・1 回目 4・通過 13／書く 13／判定 9／完走 9 のうち不一致なし 0
    assert.deepEqual(row("v1", "design"), [30, 16, 24, 6]);
    assert.deepEqual(row("v1", "test-suite"), [24, 4, 13, 11]);
    assert.equal(c.groups.v1.funnel.stages.write.reached, 13);
    assert.deepEqual(row("v1", "judge"), [9, null, 9, 0]);
    assert.deepEqual(c.groups.v1.funnel.completed, { runs: 9, no_mismatch: 0, with_mismatch: 9, missing: 0 });
    assert.deepEqual(c.groups.v1.funnel.stops, { limit: 4, stagnation: 5, "correspondence:deadline": 4, "test-suite:unmet": 10, "test-suite:malformed": 1, "design:unmet": 4, "design:network": 2 });
    assert.deepEqual([c.groups.v1.pass_k.count, c.groups.v1.pass_k.patterns], [0, 10], "pass^3 0/10");
    assert.deepEqual(c.groups.v1.pass_k.by_pattern, { P1: [0, 0, 0], P2: [0, 0, 0], P3: [0, 0, 0], P4: [0, 0, 1], P5: [0, 0, 1], P6: [1, 0, 0], P7: [0, 1, 1], P8: [1, 0, 0], P9: [1, 0, 1], P10: [0, 0, 1] });
    // 判定の 3 系統（群ごと）：分母は予定 30
    assert.deepEqual(c.groups[a].verdicts.source.counts, { PASS: 10, FAIL: 1, STATIC_NG: 0, GEN_FAIL: 19, unknown: 0, not_run: 0 });
    assert.deepEqual(c.groups[a].verdicts.factory.counts, { full: 0, partial: 11, unverified: 0, none: 19, unknown: 0, absent: 0 });
    startsWith(c.groups[a].verdicts.source.delivered.PASS, "10/11（");
    assert.deepEqual(c.groups.v1.verdicts.source.counts, { PASS: 9, FAIL: 0, STATIC_NG: 0, GEN_FAIL: 21, unknown: 0, not_run: 0 });
    // 既存の比較の欄はそのまま：停止段の内訳（stops.values）と漏斗の停止は同じ値、到達数（reach）と漏斗の到達は同じ値
    assert.deepEqual(c.groups[a].stops.values, c.groups[a].funnel.stops);
    assert.deepEqual(c.groups.v1.stops.values, c.groups.v1.funnel.stops);
    for (const g of ["v1", a]) for (const id of BUILD_STAGE_IDS) assert.equal(c.groups[g].reach[id].reached, c.groups[g].funnel.stages[id].reached, `${g} ${id}`);
    assert.deepEqual(Object.keys(c.groups[a]), ["role", "pipeline", "completion", "fingerprints", "pass_executed", "pass_planned", "factory_verdicts", "accepted", "stops", "reach", "carry_over", "funnel", "pass_k", "verdicts"], "既存の群の欄のあとに足す");
    assert.match(r.stdout, /^v1\.1a 漏斗（予定 30 本・実行 30 本。.*: write 15／15／15／0・.*name-table 30／7／23／7・semantic-check 23／23／23／0・test-spec 23／11／15／8・decl-check 12／12／12／0（未観測 \d+ 段）・完走 11（不一致なし 3・あり 8・欠測 0）$/m);
    assert.match(r.stdout, /^v1\.1a pass\^3: 1\/10（.*P5 1,1,1・/m);
    assert.match(r.stdout, /^v1 pass\^3: 0\/10（/m);
  });
});

test("#538 工場の判定の 4 値：正本は要約の verdict と assurance（unverified は partial かつ assurance unverified のときだけ）。検証の記録の unverified の内訳からは復元せず、内訳は unverified_details に件数だけ（欠測は null）。既存の factory_verdict・factory_verdicts は変えない。verdicts は 3 系統を別に、予定を分母に数える", async () => {
  // 純粋な規則 (a)〜(f)
  assert.equal(factoryVerdict4({ verdict: "partial", assurance: "unverified" }), "unverified", "(a)");
  assert.equal(factoryVerdict4({ verdict: "partial", assurance: "partial" }), "partial", "(b)〜(d)");
  assert.equal(factoryVerdict4({ verdict: "full", assurance: "full" }), "full", "(f)");
  assert.equal(factoryVerdict4({ verdict: "full", assurance: "unverified" }), "full", "unverified は partial の運び方だけ");
  assert.equal(factoryVerdict4({ verdict: "none", assurance: "none" }), "none");
  assert.equal(factoryVerdict4({ verdict: MARK538, assurance: "unverified" }), "unknown");
  assert.equal(factoryVerdict4({ assurance: "unverified" }), "absent");
  assert.equal(factoryVerdict4(null), "absent");
  assert.equal(unverifiedDetailsOf({ unverified: [{}, {}] }), 2);
  assert.equal(unverifiedDetailsOf({ unverified: 2 }), 2);
  assert.equal(unverifiedDetailsOf({ test_mismatches: 0 }), null, "(e) 欄が無ければ null（0 と推測しない）");
  assert.equal(unverifiedDetailsOf({ unverified: -1 }), null);
  assert.equal(unverifiedDetailsOf(null), null);
  assert.deepEqual(FACTORY_VERDICTS4, ["full", "partial", "unverified", "none", "unknown", "absent"]);
  await withOut(async (base) => {
    const out = join(base, "out");
    const partial = (assurance) => ({ verdict: "partial", assurance });
    addRun538(out, "P1-r1", { summary: partial("unverified"), spec: PASS_A });                                                                          // (a)
    addRun538(out, "P1-r2", { summary: partial("partial"), spec: FAIL_A, ver1: { test_mismatches: 0, test_unresolved: 0, unverified: [{ id: "u1" }, { id: "u2" }] } }); // (b)
    addRun538(out, "P1-r3", { summary: partial("partial"), spec: STATIC_NG, ver1: { test_mismatches: 1, test_unresolved: 0, unverified: 2 } });          // (c) 不一致 1・未検証 2
    addRun538(out, "P1-r4", { summary: partial("partial"), ver1: { test_mismatches: 0, test_unresolved: 0, unverified: [{ id: "u1" }] }, v11: { decl_check: { exhausted: 0, malformed: 0, rejected: 1 } } }); // (d) 意味の点検の拒否が残り未検証もある
    addRun538(out, "P1-r5", { summary: partial("unverified"), spec: PASS_A });                                                                          // (e) 内訳の記録なし
    addRun538(out, "P1-r6", { summary: { verdict: "full", assurance: "full" }, spec: PASS_A });
    addRun538(out, "P1-r7", { summary: { verdict: "none", assurance: "none", stop_reason: "deadline", failure: { stage: "write", kind: "deadline" } } });
    addRun538(out, "P1-r8", { summary: { verdict: MARK538, assurance: MARK538 }, spec: FAIL_A });
    addRun538(out, "P1-r9", { summary: null });                                                                                                       // 途中（要約なし）
    // P1-r10 は未実行
    const ids = Array.from({ length: 10 }, (_, i) => `P1-r${i + 1}`);
    conditions(out, ids);
    scoreRun(out);
    const full = readScore(out);
    assert.deepEqual(full.rows.map((x) => [x.run, x.factory_verdict4, x.unverified_details]), [
      ["P1-r1", "unverified", null], ["P1-r2", "partial", 2], ["P1-r3", "partial", 2], ["P1-r4", "partial", 1], ["P1-r5", "unverified", null],
      ["P1-r6", "full", null], ["P1-r7", "none", null], ["P1-r8", "unknown", null], ["P1-r9", "absent", null],
    ]);
    // (g) 既存の欄は (a) でも partial のまま
    assert.equal(rowOf(full, "P1-r1").factory_verdict, "partial");
    assert.deepEqual(full.metrics.factory_verdicts, { partial: 5, full: 1, none: 2, [MARK538]: 1 }, "(g) 既存の factory_verdicts に unverified は出ない（要約の無い本は今までどおり none）");
    assert.deepEqual(Object.keys(rowOf(full, "P1-r1")).slice(-2), ["factory_verdict4", "unverified_details"], "行の新しい鍵は既存の鍵のあと");
    // (h) 3 系統を別に数える。件数の分母は予定 10（未実行 1・途中 1 は not_run・absent）、率は実行 8・納品 6 の中
    const v = full.verdicts;
    assert.deepEqual([v.planned, v.executed, v.delivered], [10, 8, 6]);
    assert.deepEqual(v.source.counts, { PASS: 3, FAIL: 2, STATIC_NG: 1, GEN_FAIL: 2, unknown: 0, not_run: 2 });
    assert.deepEqual(v.accepted.counts, { PASS: 0, FAIL: 0, UNEVALUATED: 0, STATIC_NG: 0, not_applicable: 8, unknown: 0, not_run: 2 });
    assert.deepEqual(v.factory.counts, { full: 1, partial: 3, unverified: 2, none: 1, unknown: 1, absent: 2 });
    startsWith(v.source.executed.PASS, "3/8（");
    startsWith(v.source.delivered.PASS, "3/6（");
    startsWith(v.factory.executed.unverified, "2/8（");
    assert.deepEqual(Object.keys(v.source.executed), SOURCE_VERDICTS.filter((k) => k !== "not_run"));
    assert.deepEqual(Object.keys(v.accepted.counts), ACCEPTED_VERDICTS);
    assert.deepEqual(full.unverified_details, { runs: 8, observed: 3, missing: 5, total: 5, runs_with_unverified: 3 });
    assert.ok(!JSON.stringify({ funnel: full.funnel, verdicts: full.verdicts, v4: full.rows.map((x) => x.factory_verdict4) }).includes(MARK538), "知らない値をそのまま通さない");
    // 匿名の口：新しい欄は件数と率と段の ID・列挙の値だけ（本の ID・P の ID・目印・パスが無い）
    const anon = anonymize(full);
    assert.deepEqual(Object.keys(anon), [...ANON_KEYS_BEFORE_538, ...KEYS_538]);
    const text = JSON.stringify(KEYS_538.map((k) => anon[k]));
    assert.ok(!/P\d+/.test(text) && !text.includes(MARK538) && !text.includes(base), text.slice(0, 200));
    assert.deepEqual(anon.verdicts.factory.counts, v.factory.counts);
    assert.equal(anon.verdicts.source.executed.PASS, v.source.executed.PASS);
    assert.deepEqual(anon.pass_k, { k: 10, patterns: 1, count: 0, rate: full.pass_k.rate });
    assert.deepEqual(anon.unverified_details, full.unverified_details);
    assert.deepEqual(Object.keys(anon.funnel.stages), BUILD_STAGE_IDS);
    assert.equal(anon.funnel.stages.coverage.rates.passed, "今回未観測（0/10）");
    for (const s of Object.values(anon.funnel.stages)) for (const x of Object.values(s.rates)) assert.ok(x === null || /^(\d+\/\d+（.*95% 区間.*）|今回未観測（0\/\d+）)$/.test(x), x);
  });
});

test("#538 匿名の口：--anonymous の JSON に funnel・pass_k・verdicts・unverified_details が件数と率だけで載り、--compare --anonymous でも群ごとに載る（本の ID・P の ID・パス・目印が出ない）", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun538(out, "P1-r1", { summary: delivered538("design:1 static-check:0", "completed", { stop_reason: MARK538 }), spec: PASS_A });
    addRun538(out, "P1-r2", { summary: { ...stopped538("design:x", "design", "unmet"), failure: { stage: MARK538, kind: "unmet" } } });
    conditions(out, ["P1-r1", "P1-r2"]);
    const r = scoreRun(out, ["--anonymous"]);
    const anon = JSON.parse(readFileSync(join(out, "score.anonymous.json"), "utf8"));
    assert.deepEqual(KEYS_538.map((k) => k in anon), [true, true, true, true]);
    const all = r.stdout + r.stderr + readFileSync(join(out, "score.anonymous.json"), "utf8");
    assert.ok(!/P\d+-r\d+/.test(all) && !all.includes(MARK538) && !all.includes(base), "本の ID・目印・パスが出ない");
    assert.deepEqual(anon.funnel.stops, { unknown: 2 }, "知らない停止段の値は unknown");
    assert.deepEqual([anon.funnel.stages.design.reached, anon.funnel.stages.design.first_pass, anon.funnel.stages["static-check"].first_pass], [2, 1, null]);
    // 比較
    const f = compareFixture(base, "anon538", { pids: ["P1"], runs: 2, runOf: (g, id) => (id === "P1-r1" ? { summary: delivered538("design:1", "completed"), spec: PASS_A } : { summary: stopped538(`design:${g === "v1" ? "x" : "r"} test-suite:f`, "test-suite", "unmet") }) });
    const rc = scoreCompareRun(f.out, ["--anonymous"]);
    assert.equal(rc.status, 0, rc.stderr);
    const ac = JSON.parse(readFileSync(join(f.out, "score-compare.anonymous.json"), "utf8"));
    for (const g of ["v1", "v1.1a"]) {
      assert.deepEqual([ac.groups[g].pass_k.k, ac.groups[g].pass_k.count], [2, 0]);
      assert.equal(ac.groups[g].funnel.planned, 2);
      assert.equal(ac.groups[g].verdicts.planned, 2);
    }
    assert.deepEqual([ac.groups.v1.funnel.stages.design.passed, ac.groups["v1.1a"].funnel.stages.design.passed], [1, 2]);
    const allc = rc.stdout + rc.stderr + readFileSync(join(f.out, "score-compare.anonymous.json"), "utf8");
    assert.ok(!/P\d+/.test(allc) && !allc.includes(base), "P の ID・パスが出ない");
  });
});

test("#538 指紋：(a) 今の採点の指紋を記録した条件は一致・照合は完了のまま。(b) 旧い採点の指紋（集計のコードが違う）を記録した条件は不一致で、比較は未照合になり、理由に scoring_matches_conditions が出る（黙って一致にしない）", async () => {
  await withOut(async (base) => {
    // (a)
    const out = join(base, "out");
    addRun538(out, "P1-r1", { summary: delivered538("design:1", "completed"), spec: PASS_A });
    const now = scoringFingerprint(ev, scoreFile, DEFAULT_DEFINITIONS).fingerprint;
    conditions(out, ["P1-r1"], { scoring: { fingerprint: now } });
    scoreRun(out);
    const full = readScore(out);
    assert.equal(full.fingerprints.scoring_matches_conditions, true);
    assert.equal(full.completion.status, "complete");
    // 旧い採点器（集計のコードが 1 行違う）の指紋
    const old = join(base, "old-score-agent.mjs");
    writeFileSync(old, readFileSync(scoreFile, "utf8").replace("// ── 漏斗・pass^k・工場の判定の 4 値（#538。", "// ── （旧い採点器）#538。"));
    const before = scoringFingerprint(ev, old, DEFAULT_DEFINITIONS).fingerprint;
    assert.notEqual(before, now, "集計のコードの SHA が変われば採点の総合の指紋も変わる");
    // (b)
    const out2 = join(base, "out2");
    addRun538(out2, "P1-r1", { summary: delivered538("design:1", "completed"), spec: PASS_A });
    conditions(out2, ["P1-r1"], { scoring: { fingerprint: before } });
    const r2 = scoreRun(out2);
    assert.equal(readScore(out2).fingerprints.scoring_matches_conditions, false);
    assert.match(r2.stdout, /指紋: 採点 [0-9a-f]{12}…（条件のファイルと不一致）/);
    const f = compareFixture(base, "fp538", { pids: ["P1"], runs: 1, runOf: () => ({ spec: PASS_A }), groupsExtra: { "v1.1a": { scoring: { fingerprint: before } } } });
    const rc = scoreCompareRun(f.out);
    assert.equal(rc.status, 0, rc.stderr);
    const c = readCompare(f.out).completion;
    assert.equal(c.status, "unverified");
    assert.deepEqual(c.unverified, [{ group: "v1.1a", check: "scoring_matches_conditions", value: false }]);
    assert.match(rc.stdout, /未照合の項目: v1\.1a:scoring_matches_conditions=false/);
  });
});
