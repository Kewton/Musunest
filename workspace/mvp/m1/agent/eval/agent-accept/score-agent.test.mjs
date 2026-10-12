// score-agent.mjs の試験（node --test。#425・#426）。ネットワーク無し・API 無しで閉じる：
// 一時の出力先に固定の出力（要約・宣言・申告・条件のファイル・起動の記録）を置き、このリポジトリの凍結した採点表 v5
// （engine.mjs・subjects/）と spec-engine の dist で採点する。宣言は cases/ の正例・負例を使う（題材の言葉をここに書かない）。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"（先に pnpm build で spec-engine の dist を作る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ACCEPTANCE_STATUSES, CONDITIONS_SCHEMAS, PLAN_SPEC_SCHEMA, SCORING_FILES, acceptanceMatcher, anonymize, fingerprintDir, reconcile, scoringFingerprint, sha256, validatePlanShape, validatePlanned } from "./score-agent.mjs";
import { DEFAULT_ALLOWED } from "../score-claims.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scoreFile = join(here, "score-agent.mjs");
const ev = resolve(here, "..");
const repo = resolve(ev, "../../../../..");
assert.ok(existsSync(join(repo, "packages/spec-engine/dist/index.js")), "spec-engine の dist が無い（pnpm build を先に）");
const [V1, V2] = CONDITIONS_SCHEMAS;
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
/** 別の checkout を装う偽物のリポジトリ：採点の定義とエンジンはこの checkout の写し。集計のコードは旧い版（1 行足す）か同じ版。spec-engine の dist は実体へのリンク */
function makeCheckout(base, name, { sameAggregator = false } = {}) {
  const fake = join(base, name), fakeEv = join(fake, "workspace/mvp/m1/agent/eval");
  mkdirSync(join(fakeEv, "agent-accept"), { recursive: true });
  for (const f of SCORING_FILES) cpSync(join(ev, f), join(fakeEv, f));
  cpSync(join(ev, "subjects"), join(fakeEv, "subjects"), { recursive: true });
  if (!sameAggregator) appendFileSync(join(fakeEv, "agent-accept/score-agent.mjs"), "\n// 旧い採点器\n");
  mkdirSync(join(fake, "packages/spec-engine"), { recursive: true });
  symlinkSync(join(repo, "packages/spec-engine/dist"), join(fake, "packages/spec-engine/dist"), "dir");
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
    assert.match(r.stdout, /照合: 未完了（予定 4・実行 2・未実行 1・途中 1・止まった理由: 予算 0\.5 USD に達した）/);
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
    assert.match(r3.stdout, /照合: 未照合（予定 -・実行 1・未実行 -・途中 0・理由: 条件のファイルが無い）/);
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
      assert.match(r.stdout, /照合: 未照合（予定 -・実行 1・未実行 -・途中 0・理由: /);
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
    assert.deepEqual(first.files.map((f) => f.path), [...SCORING_FILES, ...["A", "B", "C", "D", "E"].map((s) => `subjects/${s}.json`)]);
    appendFileSync(join(copy, "subjects/A.json"), " ");
    const defChanged = scoringFingerprint(copy);
    assert.notEqual(defChanged.fingerprint, first.fingerprint, "題材の定義の 1 文字");
    appendFileSync(join(copy, "agent-accept/score-agent.mjs"), " ");
    const codeChanged = scoringFingerprint(copy);
    assert.notEqual(codeChanged.fingerprint, defChanged.fingerprint, "集計のコードの 1 文字");
    rmSync(join(copy, "rubric-v5.mjs"));
    assert.deepEqual(scoringFingerprint(copy).missing, ["rubric-v5.mjs"]);
    // 採点の出力：条件のファイルの指紋と一致／不一致／無い
    const mine = scoringFingerprint(ev).fingerprint;
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
    const recorded = scoringFingerprint(old.ev);
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
    assert.equal(fp.scoring.fingerprint, scoringFingerprint(old.ev, scoreFile).fingerprint, "定義とエンジンは <repo>、集計は実行中のファイル");
    assert.equal(fileOf(fp.scoring, "agent-accept/score-agent.mjs").sha256, runningSha);
    assert.equal(fp.scoring.aggregator.sha256, runningSha);
    assert.ok(fp.scoring.aggregator.path.endsWith("agent-accept/score-agent.mjs"), fp.scoring.aggregator.path);
    assert.notEqual(fp.scoring.aggregator.path, "workspace/mvp/m1/agent/eval/agent-accept/score-agent.mjs", "別の checkout なので <repo> の中のパスにならない");
    for (const f of ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "subjects/A.json"]) assert.equal(fileOf(fp.scoring, f).sha256, fileOf(recorded, f).sha256, f);
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
    conditions(out2, ["P1-r1"], { scoring: { fingerprint: scoringFingerprint(same.ev).fingerprint } });
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
    assert.deepEqual(a.completion, { status: "incomplete", label: "未完了", planned: 6, executed: 4, unexecuted: 2, incomplete: 0, extra: 0, stop_code: null });
    assert.match(a.fingerprints.scoring, HEX64);
    assert.match(a.fingerprints.spec_engine, HEX64);
    assert.deepEqual(a.fingerprints.conditions, { schema: V2, signature: SIG, factory: null, spec_engine: null, scoring: null, judge: null });
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
    assert.deepEqual(a.completion, { status: "complete", label: "完了", planned: 2, executed: 2, unexecuted: 0, incomplete: 0, extra: 0, stop_code: "other" });
    assert.deepEqual(a.fingerprints.conditions, { schema: V2, signature: null, factory: null, spec_engine: null, scoring: null, judge: "unknown" }, "ハッシュの形でない指紋は null、既知でない構成は unknown");
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

// ── 了承後の採点（#426。README §5.5）。了承の記録（plan.json）は作り物で、要件の文は目印（MARK_）か定義から読んだ ID を使う（題材の言葉をここに書かない）
const planFixture = ({ requirements = [], accepted = [], decisions = [], revision = 1, schema = PLAN_SPEC_SCHEMA } = {}) => ({ schema_version: schema, plan_id: "plan-t", revision, vocabulary_version: "v", inputs: [], requirements, open_issues: [], decisions, accepted_unwritable: accepted, confirmation: { sha256: "0".repeat(64), confirmed_at: "t", confirmed_by: "u" } });
const req = (id, text, extra = {}) => ({ id, text, kind: "constraining", origin: { input_id: "S:1", quote: text }, parts: [], ...extra });
const part = (id, text, disposition = "accepted_removal") => ({ id, text, disposition });
const basis = { doc_version: "v", location: "l", constraint_id: "c" };
/** 本に Plan の記録を足す（plan ＝ bundle/artifacts/plan.json。文字列ならそのまま書く。record ＝ bundle/plan-record.json） */
function addPlan(out, id, { plan = null, record = null } = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  if (plan !== null) writeFileSync(join(dir, "bundle/artifacts/plan.json"), typeof plan === "string" ? plan : JSON.stringify(plan));
  if (record !== null) writeFileSync(join(dir, "bundle/plan-record.json"), JSON.stringify({ schema_version: "musunest-factory/plan-cli-record/v1", plan_id: "plan-t", rounds: [], spent_usd: 0.01, ...record }));
}
/** Plan を通した計測の条件のファイル（params.plan） */
const planConditions = (out, ids, extra = {}) => conditions(out, ids, { params: { ...paramsFor(ids), plan: true }, ...extra });
const structureIds = (s) => defOf(s).structures.map((st) => st.id);
const unwritableIdOf = (s, structureId) => defOf(s).structures.find((st) => st.id === structureId).unwritable[0].id;

test("了承で形が変わった要件（了承して除いた書けない要件）：原文系は挙げ漏れで落とし、了承後系は了承済みとして通す", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [, ALT] = structureIds("D");
    const accepted = unwritableIdOf("D", ALT);
    const n = defOf("D").structures[1].checks.length;
    // P7-r1：別の構造で全部満たすが申告が無い。Plan で了承して除いた（accepted_removal）
    addRun(out, "P7-r1", { spec: PASS_D });
    addPlan(out, "P7-r1", { plan: planFixture({ requirements: [req("R1", "MARK_REQ", { parts: [part("P:1", accepted)] }), req("R:alt:1", "MARK_ALT")], accepted: [{ part_id: "P:1", alternative_id: "R:alt:1", basis }], decisions: [{ id: "D1", subject: "s", value: "v", reason: "r" }] }), record: { outcome: "confirmed", confirmation: "build" } });
    // P8-r1：同じ宣言。代わりの案（alternative）で了承した
    addRun(out, "P8-r1", { spec: PASS_D });
    addPlan(out, "P8-r1", { plan: planFixture({ requirements: [req("R1", "MARK_REQ", { parts: [{ ...part("P:1", accepted, "alternative"), alternative_id: "R:alt:1" }] }), req("R:alt:1", "MARK_ALT")] }), record: { outcome: "confirmed" } });
    // P7-r2：同じ宣言を申告つきで（原文系も通る）。了承の記録に除外は無い
    addRun(out, "P7-r2", { spec: PASS_D, unwritable: CLAIM_D });
    addPlan(out, "P7-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2", "P8-r1"]);
    const r = scoreRun(out);
    const full = readScore(out);
    const a = rowOf(full, "P7-r1");
    assert.equal(a.verdict, "FAIL");
    assert.equal(a.claims.missed, 1);
    assert.equal(a.verdict_accepted, "PASS");
    assert.deepEqual(a.claims_accepted, { structure: ALT, expected: [accepted], correct: 0, accepted: 1, optional: 0, missed: 0, verdict: "OK" });
    assert.equal(a.acceptance.status, "confirmed");
    assert.equal(a.acceptance.structure, ALT);
    assert.equal(a.acceptance.plan_outcome, "confirmed");
    assert.equal(a.acceptance.plan_id, "plan-t");
    assert.deepEqual(a.acceptance.exclusions, [{ id: "P:1", kind: "accepted_removal", matched: { kind: "unwritable", id: accepted }, judged: "expected" }]);
    assert.deepEqual(a.acceptance.changed, []);
    assert.deepEqual(a.acceptance.accepted_unwritable_ids, [accepted]);
    assert.deepEqual(a.acceptance.changes, { added: 0, changed: 0, removed: 0 });
    assert.equal(a.acceptance.decisions, 1);
    assert.equal(a.acceptance.wrong_exclusions, 0);
    assert.equal(a.acceptance.wrong_acceptances, 0);
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n, total: n, total_from: `structure:${ALT}`, excluded_changed: 0 });
    assert.deepEqual(a.fulfillment_v2, { fulfilled: n, total: n, total_from: `structure:${ALT}` }, "原文系の欄は変わらない");
    const b = rowOf(full, "P8-r1");
    assert.equal(b.verdict, "FAIL");
    assert.equal(b.verdict_accepted, "PASS");
    assert.deepEqual(b.acceptance.changed, [{ id: "P:1", kind: "alternative", matched: { kind: "unwritable", id: accepted }, judged: "expected" }]);
    assert.deepEqual(b.acceptance.exclusions, []);
    assert.equal(b.claims_accepted.accepted, 1);
    const c = rowOf(full, "P7-r2");
    assert.equal(c.verdict, "PASS");
    assert.equal(c.verdict_accepted, "PASS");
    assert.equal(c.claims_accepted.correct, 1);
    assert.equal(c.claims_accepted.accepted, 0);
    // 集計：原文系の指標は従来どおり、了承後系は別の欄に並ぶ
    startsWith(full.metrics.missed_partial, "2/3（");
    startsWith(full.metrics.spec_pass_partial, "1/3（");
    startsWith(full.metrics_accepted.missed_partial, "0/3（");
    startsWith(full.metrics_accepted.spec_pass_partial, "3/3（");
    assert.equal(full.metrics_accepted.runs, 3);
    assert.equal(full.metrics_accepted.confirmed, 3);
    assert.equal(full.metrics_accepted.decisions, 1);
    startsWith(full.fulfillment.accepted.partial, `${3 * n}/${3 * n}（`);
    assert.equal(full.fulfillment.accepted.all, full.fulfillment.accepted.partial);
    assert.equal(full.fulfillment.v2.partial, full.fulfillment.accepted.partial);
    assert.deepEqual(Object.keys(full.fulfillment), ["v1", "v2", "accepted"]);
    assert.equal(full.scoring_systems.source.startsWith("原文系"), true);
    assert.equal(full.scoring_systems.accepted.startsWith("了承後系"), true);
    startsWith(full.bySubject.D.pass_accepted, "3/3（");
    startsWith(full.bySubject.D.pass, "1/3（");
    startsWith(full.bySubject.A.pass_accepted, "0/0（");
    assert.match(r.stdout, /了承後: 対象 3 本（確定 3・記録なし 0・読めない 0）・誤った除外 0 件・誤った了承 0 件・了承で変わった判定 0・充足 /);
    assert.match(r.stdout, /P7-r1\tpartial\tFAIL\t.*\t了承後=PASS$/m);
  });
});

test("誤った除外：書けない要件にも許される申告にも当たらない除外は数え、了承後系の分母から外さない。匿名の出力には件数だけ", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [MAIN, ALT] = structureIds("D");
    const otherStructureUnwritable = unwritableIdOf("D", MAIN); // 当てはまった構造（別の構造）では書ける
    const allowedText = DEFAULT_ALLOWED[1].id;
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    addPlan(out, "P7-r1", { plan: planFixture({
      requirements: [
        req("R1", "MARK_R1", { parts: [part("P:other", otherStructureUnwritable), part("P:none", "MARK_NONE"), part("P:allowed", allowedText), part("P:met", "MARK_MET", "met")] }),
        req("R2", "MARK_REMOVED", { change: { kind: "removed", from_requirement_id: "R9", answer_id: "A:1" } }),
        req("R3", "MARK_ADDED", { change: { kind: "added", answer_id: "A:1" } }),
      ],
      accepted: [{ part_id: "P:other", alternative_id: "R3", basis }, { part_id: "P:orphan", alternative_id: "R3", basis }],
    }), record: { outcome: "confirmed" } });
    addRun(out, "P7-r2", { spec: PASS_D, unwritable: CLAIM_D });
    addPlan(out, "P7-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2"]);
    const r = scoreRun(out);
    const full = readScore(out);
    const a = rowOf(full, "P7-r1");
    assert.equal(a.verdict, "PASS");
    assert.equal(a.verdict_accepted, "PASS", "誤った除外は判定を変えず、別に数える");
    assert.deepEqual(a.acceptance.exclusions, [
      { id: "P:other", kind: "accepted_removal", matched: { kind: "other_unwritable", id: `${MAIN}:${otherStructureUnwritable}` }, judged: "wrong" },
      { id: "P:none", kind: "accepted_removal", matched: null, judged: "wrong" },
      { id: "P:allowed", kind: "accepted_removal", matched: { kind: "allowed", id: allowedText }, judged: "allowed" },
      { id: "R2", kind: "removed", matched: null, judged: "wrong" },
      { id: "P:orphan", kind: "accepted_unwritable", matched: null, judged: "wrong" },
    ]);
    assert.deepEqual(a.acceptance.changed, []);
    assert.equal(a.acceptance.wrong_exclusions, 4);
    assert.equal(a.acceptance.allowed, 1);
    assert.equal(a.acceptance.wrong_acceptances, 0);
    assert.deepEqual(a.acceptance.changes, { added: 1, changed: 0, removed: 1 });
    assert.deepEqual(a.acceptance.accepted_unwritable_ids, []);
    assert.equal(a.claims_accepted.correct, 1);
    assert.equal(a.claims_accepted.accepted, 0);
    const n = defOf("D").structures[1].checks.length;
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n, total: n, total_from: `structure:${ALT}`, excluded_changed: 0 }, "誤った除外は分母から外さない");
    startsWith(full.metrics_accepted.wrong_exclusion_runs, "1/2（");
    assert.equal(full.metrics_accepted.wrong_exclusions, 4);
    startsWith(full.metrics_accepted.wrong_acceptance_runs, "0/2（");
    assert.deepEqual(full.metrics_accepted.changes, { added: 1, changed: 0, removed: 1 });
    assert.match(r.stdout, /誤った除外 4 件・誤った了承 0 件/);
    // 匿名の出し方：件数と区間だけ。部分の ID・要件の文・当たった先は出ない
    scoreRun(out, ["--anonymous"]);
    const text = readFileSync(join(out, "score.anonymous.json"), "utf8");
    for (const w of ["MARK_", "P:other", "P:none", "P:orphan", "plan-t", otherStructureUnwritable, allowedText]) assert.ok(!text.includes(w), `匿名の出力に ${w}`);
    const an = JSON.parse(text);
    assert.equal(an.metrics_accepted.wrong_exclusions, 4);
    assert.equal(an.metrics_accepted.runs, 2);
    startsWith(an.metrics_accepted.wrong_exclusion_runs, "1/2（");
    assert.deepEqual(an.metrics_accepted.changes, { added: 1, changed: 0, removed: 1 });
    assert.equal(an.fulfillment.accepted.all, full.fulfillment.accepted.all);
    assert.deepEqual(an, anonymize(full));
  });
});

test("了承の記録が無い本：Plan を通した計測では充足 0 で分母に残り、Plan を通していない計測では対象外（null）", async () => {
  await withOut(async (base) => {
    const n = totalOf("A");
    // Plan を通した計測（params.plan）：確定しなかった本・記録の無い本・読めない本は充足 0・判定 null で分母に残る
    const out = join(base, "plan");
    addRun(out, "P1-r1", { spec: PASS_A });
    addPlan(out, "P1-r1", { record: { outcome: "stopped", confirmation: null } });
    addRun(out, "P1-r2", { spec: PASS_A });
    addRun(out, "P1-r3", { spec: PASS_A });
    addPlan(out, "P1-r3", { plan: "{ これは JSON でない" });
    addRun(out, "P1-r4", { spec: PASS_A });
    addPlan(out, "P1-r4", { plan: planFixture({ schema: "MARK_SCHEMA" }) });
    addRun(out, "P1-r5", { spec: PASS_A });
    addPlan(out, "P1-r5", { plan: planFixture(), record: { outcome: "confirmed" } });
    addRun(out, "P1-r6");
    addPlan(out, "P1-r6", { record: { outcome: "cannot-confirm" } });
    planConditions(out, ["P1-r1", "P1-r2", "P1-r3", "P1-r4", "P1-r5", "P1-r6"]);
    const r = scoreRun(out);
    const full = readScore(out);
    const a1 = rowOf(full, "P1-r1");
    assert.equal(a1.verdict, "PASS", "原文系は通る");
    assert.deepEqual(a1.acceptance, { status: "absent", reasons: [], plan_outcome: "stopped" });
    assert.equal(a1.verdict_accepted, null);
    assert.equal(a1.claims_accepted, null);
    assert.deepEqual(a1.fulfillment_accepted, { fulfilled: 0, total: n, total_from: "definition:main", excluded_changed: 0 });
    assert.deepEqual(rowOf(full, "P1-r2").acceptance, { status: "absent", reasons: [], plan_outcome: null });
    const a3 = rowOf(full, "P1-r3");
    assert.equal(a3.acceptance.status, "invalid");
    assert.deepEqual(a3.acceptance.reasons, ["plan.json を読めない"]);
    assert.deepEqual(a3.fulfillment_accepted, { fulfilled: 0, total: n, total_from: "definition:main", excluded_changed: 0 });
    const a4 = rowOf(full, "P1-r4");
    assert.equal(a4.acceptance.status, "invalid");
    assert.deepEqual(a4.acceptance.reasons, ["schema_version が未知"]);
    assert.ok(!JSON.stringify(a4.acceptance).includes("MARK_"), "理由に入力の値を出さない");
    const a5 = rowOf(full, "P1-r5");
    assert.equal(a5.acceptance.status, "confirmed");
    assert.equal(a5.verdict_accepted, "PASS");
    assert.deepEqual(a5.fulfillment_accepted, { fulfilled: n, total: n, total_from: "structure:main", excluded_changed: 0 });
    const a6 = rowOf(full, "P1-r6");
    assert.equal(a6.generation_failed, true);
    assert.deepEqual(a6.acceptance, { status: "absent", reasons: [], plan_outcome: "cannot-confirm" });
    assert.deepEqual(a6.fulfillment_accepted, { fulfilled: 0, total: n, total_from: "definition:main", excluded_changed: 0 });
    assert.deepEqual([full.metrics_accepted.runs, full.metrics_accepted.confirmed, full.metrics_accepted.absent, full.metrics_accepted.invalid], [6, 1, 3, 2]);
    startsWith(full.metrics_accepted.spec_pass_writable, "1/6（");
    startsWith(full.metrics.spec_pass_writable, "5/6（");
    startsWith(full.fulfillment.accepted.writable, `${n}/${6 * n}（`);
    startsWith(full.fulfillment.v2.writable, `${5 * n}/${6 * n}（`);
    assert.match(r.stdout, /了承後: 対象 6 本（確定 1・記録なし 3・読めない 2）/);
    // Plan を通していない計測：記録の無い本は対象外（null）。記録のある本だけが対象
    const out2 = join(base, "noplan");
    addRun(out2, "P1-r1", { spec: PASS_A });
    addRun(out2, "P1-r2", { spec: PASS_A });
    addPlan(out2, "P1-r2", { plan: planFixture(), record: { outcome: "confirmed" } });
    addRun(out2, "P1-r3", { spec: PASS_A });
    addPlan(out2, "P1-r3", { record: { outcome: "stopped" } });
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
    assert.deepEqual(ACCEPTANCE_STATUSES, ["confirmed", "invalid", "absent", "none"]);
    assert.deepEqual(validatePlanShape({ schema_version: PLAN_SPEC_SCHEMA, requirements: [{ id: "R", text: "t" }], accepted_unwritable: [], decisions: [] }), ["requirements の形が違う（id・text・parts）"]);
    assert.deepEqual(validatePlanShape({ schema_version: PLAN_SPEC_SCHEMA, requirements: [], accepted_unwritable: [], decisions: [] }), []);
    assert.deepEqual(validatePlanShape([]), ["plan.json が写像でない"]);
  });
});

test("生成に失敗した本・静的 NG の本は、了承の記録があっても両系の分母に充足 0 で残る", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    const [MAIN, ALT] = structureIds("D");
    const n = totalOf("D"), nAlt = defOf("D").structures[1].checks.length;
    const accepted = unwritableIdOf("D", ALT);
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    addPlan(out, "P7-r1", { plan: planFixture(), record: { outcome: "confirmed" } });
    // Plan は確定した（了承して除いた部分つき）が、生成に失敗した
    addRun(out, "P7-r2");
    addPlan(out, "P7-r2", { plan: planFixture({ requirements: [req("R1", "MARK_R1", { parts: [part("P:1", accepted)] }), req("R:alt:1", "MARK_ALT")], accepted: [{ part_id: "P:1", alternative_id: "R:alt:1", basis }] }), record: { outcome: "confirmed" } });
    addRun(out, "P7-r3", { spec: STATIC_NG });
    addPlan(out, "P7-r3", { plan: planFixture(), record: { outcome: "confirmed" } });
    planConditions(out, ["P7-r1", "P7-r2", "P7-r3"]);
    scoreRun(out);
    const full = readScore(out);
    const f = rowOf(full, "P7-r2");
    assert.equal(f.generation_failed, true);
    assert.equal(f.acceptance.status, "confirmed", "生成に失敗しても了承の記録は読む");
    assert.equal(f.acceptance.structure, MAIN, "構造が当てはまらないので主の構造の鍵で照合する");
    assert.deepEqual(f.acceptance.exclusions[0].matched, { kind: "other_unwritable", id: `${ALT}:${accepted}` });
    assert.deepEqual(f.fulfillment_accepted, { fulfilled: 0, total: n, total_from: `definition:${MAIN}`, excluded_changed: 0 });
    assert.deepEqual(f.fulfillment_v2, { fulfilled: 0, total: n, total_from: `definition:${MAIN}` });
    assert.equal(f.claims_accepted, null);
    assert.equal(f.verdict_accepted, null);
    const s = rowOf(full, "P7-r3");
    assert.equal(s.spec_verdict, "STATIC_NG");
    assert.equal(s.verdict_accepted, "STATIC_NG");
    assert.equal(s.claims_accepted.structure, MAIN);
    assert.deepEqual(s.fulfillment_accepted, { fulfilled: 0, total: n, total_from: `definition:${MAIN}`, excluded_changed: 0 });
    startsWith(full.fulfillment.v2.partial, `${nAlt}/${nAlt + 2 * n}（`);
    assert.equal(full.fulfillment.accepted.partial, full.fulfillment.v2.partial);
    startsWith(full.fulfillment.v1.partial, `${nAlt}/${nAlt}（`, "補正前は分母から落ちる（従来どおり）");
    startsWith(full.metrics.missed_partial, "2/3（");
    startsWith(full.metrics_accepted.missed_partial, "2/3（");
    startsWith(full.metrics_accepted.spec_pass_partial, "1/3（");
    assert.deepEqual([full.metrics_accepted.runs, full.metrics_accepted.confirmed], [3, 3]);
  });
});

test("了承で変わった書ける要件（checks に keys を持つ定義）：変更は誤った了承として分母から外し、除外は誤った除外として分母に残す", async () => {
  await withOut(async (base) => {
    // v5 の定義には checks[].keys が無い。将来の定義を装って、写しの定義の判定 1 つに鍵（要件の名前そのもの）を足す
    const fake = makeCheckout(base, "keyed-checkout", { sameAggregator: true });
    const defPath = join(fake.ev, "subjects/A.json");
    const def = JSON.parse(readFileSync(defPath, "utf8"));
    const target = def.structures[0].checks[1];
    const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    target.keys = [escape(target.req)];
    writeFileSync(defPath, JSON.stringify(def));
    const n = def.structures[0].checks.length;
    const m = acceptanceMatcher(def, "main", DEFAULT_ALLOWED);
    assert.deepEqual(m.match(`MARK ${target.req}`), { kind: "check", id: target.req });
    assert.deepEqual(m.match(DEFAULT_ALLOWED[0].id), { kind: "allowed", id: DEFAULT_ALLOWED[0].id });
    assert.equal(m.match("MARK_NOTHING"), null);
    assert.equal(acceptanceMatcher(def, "MARK_UNKNOWN_STRUCTURE").structure, "main", "構造が無ければ主の構造");
    const out = join(base, "out");
    // P1-r1：原文が固定していた要件を、答えで別の形に変えた（changed）
    addRun(out, "P1-r1", { spec: PASS_A });
    addPlan(out, "P1-r1", { plan: planFixture({ requirements: [req("R1", "MARK_OLD"), req("R1b", target.req, { change: { kind: "changed", from_requirement_id: "R1", answer_id: "A:1" } })] }), record: { outcome: "confirmed" } });
    // P1-r2：同じ要件を了承して除いた（誤った除外。分母から外さない）
    addRun(out, "P1-r2", { spec: FAIL_A });
    addPlan(out, "P1-r2", { plan: planFixture({ requirements: [req("R1", "MARK_R1", { parts: [part("P:1", target.req)] })], accepted: [{ part_id: "P:1", alternative_id: "R1", basis }] }), record: { outcome: "confirmed" } });
    planConditions(out, ["P1-r1", "P1-r2"]);
    scoreRun(out, [], fake.repo);
    const full = readScore(out);
    const a = rowOf(full, "P1-r1");
    assert.equal(a.verdict, "PASS");
    assert.deepEqual(a.acceptance.changed, [{ id: "R1b", kind: "changed", matched: { kind: "check", id: target.req }, judged: "wrong" }]);
    assert.deepEqual(a.acceptance.changed_checks, [target.req]);
    assert.equal(a.acceptance.wrong_acceptances, 1);
    assert.equal(a.acceptance.wrong_exclusions, 0);
    assert.deepEqual(a.acceptance.changes, { added: 0, changed: 1, removed: 0 });
    assert.deepEqual(a.fulfillment_accepted, { fulfilled: n - 1, total: n - 1, total_from: "structure:main", excluded_changed: 1 }, "了承で変わった判定は分母（と分子）から外す");
    assert.deepEqual(a.fulfillment_v2, { fulfilled: n, total: n, total_from: "structure:main" }, "原文系は従来どおり判定する");
    assert.equal(a.verdict_accepted, "PASS");
    const b = rowOf(full, "P1-r2");
    assert.equal(b.verdict, "FAIL");
    assert.deepEqual(b.acceptance.exclusions, [{ id: "P:1", kind: "accepted_removal", matched: { kind: "check", id: target.req }, judged: "wrong" }]);
    assert.equal(b.acceptance.wrong_exclusions, 1);
    assert.deepEqual(b.acceptance.changed_checks, []);
    assert.deepEqual(b.fulfillment_accepted, { ...b.fulfillment_v2, excluded_changed: 0 }, "誤った除外は分母から外さない");
    assert.equal(b.verdict_accepted, "FAIL");
    assert.equal(full.metrics_accepted.changed_checks, 1);
    startsWith(full.metrics_accepted.wrong_acceptance_runs, "1/2（");
    startsWith(full.metrics_accepted.wrong_exclusion_runs, "1/2（");
    startsWith(full.fulfillment.accepted.writable, `${2 * n - 2}/${2 * n - 1}（`);
    startsWith(full.fulfillment.v2.writable, `${2 * n - 1}/${2 * n}（`);
  });
});
