// score-agent.mjs の試験（node --test。#425）。ネットワーク無し・API 無しで閉じる：
// 一時の出力先に固定の出力（要約・宣言・申告・条件のファイル・起動の記録）を置き、このリポジトリの凍結した採点表 v5
// （engine.mjs・subjects/）と spec-engine の dist で採点する。宣言は cases/ の正例・負例を使う（題材の言葉をここに書かない）。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"（先に pnpm build で spec-engine の dist を作る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SCORING_FILES, anonymize, reconcile, scoringFingerprint } from "./score-agent.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scoreFile = join(here, "score-agent.mjs");
const ev = resolve(here, "..");
const repo = resolve(ev, "../../../../..");
assert.ok(existsSync(join(repo, "packages/spec-engine/dist/index.js")), "spec-engine の dist が無い（pnpm build を先に）");

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

const summaryLine = (generated) => JSON.stringify({ exit: generated ? 0 : 1, wall_s: 120, summary: { schema_version: "commandagent.headless-summary/v1", verdict: generated ? "partial" : "none", stop_reason: generated ? "completed" : "deadline", provider_cost_usd: 0.05, failure: null }, plan_cost: null, stderr_tail: "", resumed: false });
/** 本を 1 つ置く。spec が無ければ生成失敗（宣言が無い）。summary が false なら要約の無い途中の本 */
function addRun(out, id, { spec = null, unwritable = null, summary = true } = {}) {
  const dir = join(out, id);
  mkdirSync(join(dir, "bundle/artifacts"), { recursive: true });
  if (summary) { writeFileSync(join(dir, "summary.line.json"), summaryLine(spec !== null)); writeFileSync(join(dir, "stdout.log"), ""); writeFileSync(join(dir, "stderr.log"), ""); }
  if (spec !== null) writeFileSync(join(dir, "bundle/artifacts/app.spec.yaml"), spec);
  if (unwritable !== null) writeFileSync(join(dir, "bundle/artifacts/unwritable.json"), JSON.stringify(unwritable));
}
const conditions = (out, ids, extra = {}) => writeFileSync(join(out, "conditions.json"), JSON.stringify({ schema: "musunest-factory/agent-accept-conditions/v2", measurement_id: "t", child_args: ids.map((id) => ({ id, argv: [] })), signature: "sig", ...extra }));
function scoreRun(out, extra = []) {
  const r = spawnSync(process.execPath, [scoreFile, repo, out, ...extra], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const readScore = (out, name = "score.json") => JSON.parse(readFileSync(join(out, name), "utf8"));
const rowOf = (full, id) => full.rows.find((r) => r.run === id);
const startsWith = (s, head) => assert.ok(s.startsWith(head), `${JSON.stringify(s)} は ${head} で始まらない`);

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
    writeFileSync(join(out, "run-1000.json"), JSON.stringify({ finished_at: "t", mode: "fresh", executed: ["P1-r1", "P1-r2"], pending: ["P1-r3"], stop: "予算 0.5 USD に達した" }));
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
    assert.deepEqual(c.latest_record, { file: "run-1000.json", stop: "予算 0.5 USD に達した", pending: ["P1-r3"] });
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
    scoreRun(old);
    const c3 = readScore(old).completion;
    assert.equal(c3.status, "unverified");
    assert.equal(c3.label, "未照合");
    assert.equal(c3.planned, null);
    assert.equal(c3.executed, 1);
  });
});

test("採点の定義か集計のコードを 1 文字変えると指紋が変わり、採点の出力は条件のファイルの指紋と照合する", async () => {
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
    for (const [name, recorded, expected] of [["same", mine, true], ["diff", defChanged.fingerprint, false], ["none", undefined, null]]) {
      const out = join(base, name);
      addRun(out, "P1-r1", { spec: PASS_A });
      conditions(out, ["P1-r1"], recorded === undefined ? {} : { scoring: { fingerprint: recorded } });
      scoreRun(out);
      const fp = readScore(out).fingerprints;
      assert.equal(fp.scoring.fingerprint, mine, name);
      assert.equal(fp.scoring.dir, "workspace/mvp/m1/agent/eval");
      assert.equal(fp.scoring_matches_conditions, expected, name);
      assert.match(fp.spec_engine.fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(fp.spec_engine_matches_conditions, null, "条件のファイルに spec-engine の指紋が無い");
    }
  });
});

test("匿名の出し方は、行ごとの失敗の鍵・要件の文・題材 ID を出さず、指標の数と区間だけを出す", async () => {
  await withOut(async (base) => {
    const out = join(base, "out");
    addRun(out, "P1-r1", { spec: PASS_A });
    addRun(out, "P1-r2", { spec: FAIL_A });
    addRun(out, "P1-r3", { spec: NOROLE_A });
    addRun(out, "P7-r1", { spec: PASS_D, unwritable: CLAIM_D });
    conditions(out, ["P1-r1", "P1-r2", "P1-r3", "P7-r1", "P7-r2"]);
    const r = scoreRun(out, ["--label", "t", "--anonymous"]);
    assert.equal(existsSync(join(out, "score-t.json")), false, "行つきのファイルは書かない");
    const text = readFileSync(join(out, "score-t.anonymous.json"), "utf8");
    const a = JSON.parse(text);
    assert.equal(a.anonymous, true);
    assert.equal(a.runs, 4);
    assert.equal("rows" in a, false);
    assert.equal("bySubject" in a, false);
    const forbidden = ["P1-r1", "P1-r2", "P1-r3", "P7-r1", "P7-r2", "役割が見つかる", ...reqsOf("A"), ...reqsOf("D"), ...CLAIM_D.unwritable.flatMap((u) => [u.text, ...u.unwritable])];
    for (const word of forbidden) { assert.ok(!text.includes(word), `ファイルに ${word}`); assert.ok(!r.stdout.includes(word), `標準出力に ${word}`); }
    const keys = []; const walk = (v) => { if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(a);
    for (const s of ["A", "B", "C", "D", "E"]) assert.ok(!keys.includes(s), `題材 ID ${s} が鍵に出ている`);
    startsWith(a.metrics.generated, "4/4（");
    startsWith(a.metrics.spec_pass_writable, "1/3（");
    startsWith(a.fulfillment.v2.all, `${2 * totalOf("A") - 1 + totalOf("D")}/${3 * totalOf("A") + totalOf("D")}（`);
    assert.deepEqual(a.completion, { status: "incomplete", label: "未完了", planned: 5, executed: 4, unexecuted: 1, incomplete: 0, extra: 0, stop: null });
    assert.equal(typeof a.fingerprints.scoring, "string");
    assert.equal(a.fingerprints.conditions.signature, "sig");
    assert.deepEqual(JSON.parse(r.stdout), a, "標準出力も匿名の集計そのもの");
    // 既定の出し方は今のまま：行つきのファイルを書き、行を標準出力に出す
    const full = scoreRun(out, ["--label", "t"]);
    assert.equal(readScore(out, "score-t.json").rows.length, 4);
    assert.match(full.stdout, /P1-r2\tpartial\tFAIL\t/);
    assert.deepEqual(anonymize(readScore(out, "score-t.json")), a);
  });
});
