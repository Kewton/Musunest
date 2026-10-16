// freeze-plan-set.mjs の試験（node --test。#497）。ネットワーク無し・API 無し・本物の工場無しで閉じる：
// 一時の偽物のリポジトリ（git で commit 済み）に偽物の工場の dist（--plan-only で Plan だけの結果を書く入口と、包みの読み取りと検査の関数）を置き、
// run-agent.mjs --plan-only で Plan 評価の出力を作ってから凍結の道具を子プロセスで回す。包みと組は合成したものだけ。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EVAL_SET_SCHEMA, PLAN_SCRIPT_SCHEMA } from "./score-agent.mjs";
import { FROZEN_SET_FILE, FROZEN_SET_SCHEMA, FREEZE_RULE } from "./freeze-plan-set.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runAgentFile = join(here, "run-agent.mjs"), freezeFile = join(here, "freeze-plan-set.mjs");
const SET_PATH = "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json";
const MARK = "leak-marker-text";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// 偽物の工場の入口（run-agent.test.mjs の偽物の Plan だけの部分と同じ振る舞い）：FAKE_PLAN（本の ID → confirmed／cannot-confirm／stopped／none）で
// plan-result.json を書き、FAKE_DELAY で終わる時刻をずらす。FAKE_MARK は仕様の本体・止まり方の符号・標準エラーに入れる目印
const fakeCli = String.raw`import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 600000;
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
const h = (t) => createHash("sha256").update(t).digest("hex");
const map = (k) => { try { return JSON.parse(process.env[k] ?? "{}"); } catch { return {}; } };
if (isEntry()) {
  const startedMs = Date.now();
  const val = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  const outDir = val("--out"), runDir = dirname(outDir), id = basename(runDir), pid = id.split("-")[0], mark = process.env.FAKE_MARK ?? "";
  if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, id + "\n");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(runDir, "received-start.json"), String(startedMs));
  const outcome = map("FAKE_PLAN")[id] ?? "confirmed";
  if (process.argv.includes("--plan-only") && outcome !== "none") {
    const plan = outcome === "confirmed" ? { plan_id: "plan-" + pid, vocabulary_version: "v1", body: ["spec " + pid, mark] } : null;
    const conditions = { model: val("--model"), effort: val("--effort"), budget_usd: Number(val("--budget")), deadline_ms: Number(val("--deadline")) * 60000, timeout_ms: null, vocabulary_version: "v1", prompt_version: "v1", contract_version: "v0.2", factory_version: "0.0.0", spec_engine_version: "0.0.0" };
    const stop = outcome === "confirmed" ? null : { kind: outcome === "stopped" ? "stopped" : "cannot-confirm", reason: null, codes: [mark || "code-x"] };
    writeFileSync(join(outDir, "plan-result.json"), JSON.stringify({ schema_version: "musunest-factory/plan-only-result/v1", outcome, plan, plan_sha256: plan === null ? null : h(JSON.stringify(plan)), source_sha256: h(readFileSync(process.argv[2], "utf8")), conditions, stop }));
  }
  process.exitCode = outcome === "confirmed" || !process.argv.includes("--plan-only") ? 0 : 1;
  setTimeout(() => { process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: mark || "full", provider_cost_usd: 0 }) + "\n"); if (mark) process.stderr.write(mark + "\n"); }, Number(map("FAKE_DELAY")[id] ?? 0));
}
`;
// 偽物の包みの読み取りと検査の関数（run-agent.test.mjs と同じ。仕様の検査は plan.stale、仕様の SHA は JSON の SHA-256）
const fakeCliPlan = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export function parsePlanFile(text) {
  let v; try { v = JSON.parse(text); } catch { return { code: "plan-file-json" }; }
  if (!isRec(v)) return { code: "plan-file-envelope" };
  if (["schema_version", "outcome", "plan", "plan_sha256", "source_sha256", "conditions", "stop"].some((k) => v[k] === undefined)) return { code: "plan-file-required" };
  if (typeof v.outcome !== "string" || typeof v.source_sha256 !== "string") return { code: "plan-file-type" };
  return { envelope: { schema_version: v.schema_version, outcome: v.outcome, plan: v.plan, plan_sha256: v.plan_sha256, source_sha256: v.source_sha256 } };
}
export async function validatePlanFile({ envelope, source, vocabularyVersion }) {
  if (envelope.schema_version !== "musunest-factory/plan-only-result/v1") return { kind: "rejected", check: "envelope-version", codes: ["mismatch"] };
  if (envelope.outcome !== "confirmed") return { kind: "rejected", check: "outcome", codes: ["not-confirmed"] };
  if (!isRec(envelope.plan) || envelope.plan.stale === true) return { kind: "rejected", check: "plan", codes: ["confirmation-stale"], message: process.env.FAKE_MARK ?? "" };
  const planSha256 = h(JSON.stringify(envelope.plan));
  if (planSha256 !== envelope.plan_sha256) return { kind: "rejected", check: "plan-sha256", codes: ["mismatch"] };
  if (h(source) !== envelope.source_sha256) return { kind: "rejected", check: "source-sha256", codes: ["mismatch"] };
  if (envelope.plan.vocabulary_version !== vocabularyVersion) return { kind: "rejected", check: "vocabulary", codes: ["mismatch"] };
  return { kind: "ok", plan: envelope.plan, planSha256, sourceSha256: h(source) };
}
`;

/** 一時の偽物のリポジトリ（P1〜P3 の組・題材 A〜C・git で commit 済み） */
function makeRepo(base, { requestOf = (p) => [`依頼 P${p} の行 1`] } = {}) {
  const repo = join(base, "repo");
  const w = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  w("packages/factory/package.json", JSON.stringify({ type: "module" }));
  w("packages/factory/src/index.ts", "export {};\n");
  w("packages/factory/dist/cli.js", fakeCli);
  w("packages/factory/dist/cli-plan.js", fakeCliPlan);
  w("packages/factory/dist/openai.js", 'export const DEFAULT_OPENAI_MODEL = "fake-model";\n');
  w("packages/factory/dist/limits.js", 'export const DEFAULT_REASONING_EFFORT = "high";\nexport const STAGE_MAX_OUTPUT_TOKENS = { high: { requirements: 16384 } };\n');
  w("packages/spec-engine/dist/index.js", "export const version = 1;\n");
  w("packages/appspec-schema/dist/files.js", `export const CONTRACT_DIR = "contract";\nexport function packageFile(p) { return new URL("../" + p, import.meta.url); }\nexport const vocabularyFile = () => packageFile("vocabulary.yaml");\nexport const semanticsFile = () => packageFile("docs/semantics.md");\n`);
  w("packages/appspec-schema/contract/rules.md", "# 契約\n");
  w("packages/appspec-schema/docs/semantics.md", "# 意味\n");
  w("packages/appspec-schema/vocabulary.yaml", "words: []\n");
  const ev = "workspace/mvp/m1/agent/eval";
  for (const f of ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "agent-accept/score-agent.mjs"]) w(`${ev}/${f}`, `// ${f}\n`);
  const subjects = { P1: "A", P2: "B", P3: "C" };
  for (const s of ["A", "B", "C"]) {
    w(`${ev}/subjects/${s}.json`, JSON.stringify({ id: s, structures: [{ id: "main", checks: [{ req: "要件 1" }], unwritable: [] }] }));
    w(`${ev}/sets/scripts/${s}.json`, JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: s, version: 1, entries: [] }));
  }
  const items = Object.entries(subjects).map(([id, subject]) => ({ id, subject, style: "S1", writable: true, scoring: `../subjects/${subject}.json`, script: `scripts/${subject}.json`, request: requestOf(Number(id.slice(1))) }));
  w(SET_PATH, JSON.stringify({ schema: EVAL_SET_SCHEMA, id: "dev-p1-p10", version: 1, role: "development", title: "t", styles: { S1: "s1" }, items }));
  const git = (...a) => { const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
  return repo;
}
const runNode = (file, argv, env = {}) => spawnSync(process.execPath, [file, ...argv], { encoding: "utf8", env: { ...process.env, JEV_API_KEY: "", ...env } });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));
const edit = (p, fn) => { const v = readJson(p); fn(v); writeJson(p, v); };
async function withBase(fn) {
  const base = mkdtempSync(join(tmpdir(), "freeze-test-"));
  try { await fn(base); } finally { rmSync(base, { recursive: true, force: true }); }
}
/** Plan 評価を流す（--plan-only）。exit 0 を確かめる */
function measure(repo, out, argv, env = {}) {
  const r = runNode(runAgentFile, [repo, out, "--plan-only", ...argv], env);
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const freeze = (repo, out, dest, extra = ["--id", "fz-1", "--version", "1"], env = {}) => runNode(freezeFile, [repo, out, dest, ...extra], env);
/** ディレクトリのファイルの一覧とバイト列（凍結の断りで、入力の出力先が変わらないことを確かめる） */
function treeOf(root) { const out = {}; if (!existsSync(root)) return out; const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(root, f)] = readFileSync(f).toString("base64"); } }; walk(root); return out; }
/** 凍結の断り：exit 3・期待した符号・標準エラー 1 行・子 0 本（偽物の工場の起動の記録が増えない）・入力の出力先は不変・組のディレクトリは作らないか元のまま */
function assertFreezeRefused(base, run, code, { input, dest, destBefore = null, label = code }) {
  const log = join(base, "spawn-freeze.log"), logBefore = existsSync(log) ? readFileSync(log, "utf8") : null;
  const before = treeOf(input);
  const r = run({ FAKE_SPAWN_LOG: log });
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: 標準エラーが 1 行でない`);
  assert.equal(existsSync(log) ? readFileSync(log, "utf8") : null, logBefore, `${label}: 子を起こした`);
  assert.deepEqual(treeOf(input), before, `${label}: 入力の出力先が変わった`);
  if (destBefore === null) assert.equal(existsSync(dest), false, `${label}: 組のディレクトリを作った`);
  else assert.deepEqual(treeOf(dest), destBefore, `${label}: 組のディレクトリが変わった`);
  return r;
}

test("(k) P ごとに開始の最も早い確定した本を採り（同じ時刻なら回の小さい本）、確定の無い P は missing に入る。Build の記録・納品物・verdict を足しても組はバイト列まで同じで、そのまま --build-from の事前の検査を通る", async () => {
  await withBase(async (base) => {
    const repo = makeRepo(base);
    const out = join(base, "plan-eval");
    const plan = { "P1-r1": "cannot-confirm", "P1-r2": "confirmed", "P1-r3": "confirmed", "P2-r1": "stopped", "P2-r2": "none", "P2-r3": "confirmed", "P3-r1": "cannot-confirm", "P3-r2": "stopped", "P3-r3": "none" };
    measure(repo, out, ["--runs", "3", "--concurrency", "1"], { FAKE_PLAN: JSON.stringify(plan) });
    const dest = join(base, "fz-a");
    const r = freeze(repo, out, dest);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /採用 2 P、外した 1 P/);
    const fz = readJson(join(dest, FROZEN_SET_FILE));
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(fz.schema, FROZEN_SET_SCHEMA);
    assert.deepEqual([fz.id, fz.version, fz.origin, fz.rule], ["fz-1", 1, "frozen-plan", FREEZE_RULE]);
    assert.deepEqual(fz.set, { path: SET_PATH, sha256: sha256(readFileSync(join(repo, SET_PATH))), id: "dev-p1-p10", version: 1 });
    assert.deepEqual(fz.source_measurement, { measurement_id: "plan-eval", signature: cond.signature, conditions_sha256: sha256(readFileSync(join(out, "conditions.json"))), commit: cond.source.commit, factory_fingerprint: cond.factory.fingerprint, model: "fake-model", effort: "high", factory_budget_usd: 0.3, factory_deadline_min: 10, answers_mode: "recommended", scripts: { mode: "post-hoc", fingerprint: cond.scripts.fingerprint } });
    assert.match(fz.source_measurement.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(fz.adopted.map((a) => a.run), ["P1-r2", "P2-r3"]);
    for (const a of fz.adopted) {
      const env = readFileSync(join(out, a.run, "bundle/plan-result.json"));
      assert.deepEqual(readFileSync(join(dest, a.envelope.path)), env, "包みの写しはバイト列のまま");
      assert.equal(a.envelope.sha256, sha256(env));
      assert.equal(a.started_at, readJson(join(out, a.run, "summary.line.json")).started_at);
      assert.equal(a.plan_sha256, JSON.parse(env).plan_sha256);
      assert.equal(a.source_sha256, JSON.parse(env).source_sha256);
    }
    assert.deepEqual(fz.missing, [{ pattern: "P3", runs: 3 }]);
    // Build の記録・納品物を足し、要約の verdict を変えても組は同じ（読まない）
    for (const run of ["P1-r2", "P1-r3", "P2-r3"]) {
      mkdirSync(join(out, run, "bundle/artifacts"), { recursive: true });
      writeFileSync(join(out, run, "bundle/build-record.json"), JSON.stringify({ return_to_plan: true }));
      writeFileSync(join(out, run, "bundle/artifacts/app.spec.yaml"), "x: 1\n");
      edit(join(out, run, "summary.line.json"), (sl) => { sl.summary = { verdict: "none" }; sl.exit = 1; sl.exit_class = "failed"; });
    }
    const dest2 = join(base, "fz-b");
    assert.equal(freeze(repo, out, dest2).status, 0);
    assert.deepEqual(readFileSync(join(dest2, FROZEN_SET_FILE)), readFileSync(join(dest, FROZEN_SET_FILE)));
    // 同じ時刻なら回の小さい本、より早ければその本
    const tie = join(base, "plan-eval-tie");
    cpSync(out, tie, { recursive: true });
    const t2 = readJson(join(out, "P1-r2", "summary.line.json")).started_at;
    edit(join(tie, "P1-r3", "summary.line.json"), (sl) => { sl.started_at = t2; });
    assert.equal(freeze(repo, tie, join(base, "fz-tie")).status, 0);
    assert.equal(readJson(join(base, "fz-tie", FROZEN_SET_FILE)).adopted[0].run, "P1-r2");
    edit(join(tie, "P1-r3", "summary.line.json"), (sl) => { sl.started_at = new Date(Date.parse(t2) - 1).toISOString(); });
    assert.equal(freeze(repo, tie, join(base, "fz-early")).status, 0);
    assert.equal(readJson(join(base, "fz-early", FROZEN_SET_FILE)).adopted[0].run, "P1-r3");
    // 書いた組は、そのまま --build-from の事前の検査を通る（採用の 2 P × 1 回）
    const log = join(base, "spawn-k.log");
    const b = runNode(runAgentFile, [repo, join(base, "build-eval"), "--runs", "1", "--build-from", join(dest, FROZEN_SET_FILE)], { FAKE_SPAWN_LOG: log });
    assert.equal(b.status, 0, b.stderr);
    // 子は並列（既定 3）で起き、ログに書く順は終わり方で変わる。見るのは起きた本の集合（順は問わない。#498 の再確認の指摘 N2）
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").sort(), ["P1-r1", "P2-r1"]);
    const bc = readJson(join(base, "build-eval", "conditions.json"));
    assert.deepEqual([bc.params.mode, bc.params.patterns, bc.frozen.missing], ["build-from", ["P1", "P2"], ["P3"]]);
    assert.deepEqual(readFileSync(join(base, "build-eval", "P1-r1", "plan-file.json")), readFileSync(join(dest, fz.adopted[0].envelope.path)));
  });
});

test("(h) 子の終わる順を逆にしても、started_at は起動の前の時刻で、凍結の選択は変わらない", async () => {
  await withBase(async (base) => {
    const repo = makeRepo(base);
    const out = join(base, "plan-eval");
    const r = measure(repo, out, ["--only", "P1", "--runs", "3", "--concurrency", "3"], { FAKE_DELAY: JSON.stringify({ "P1-r1": 900, "P1-r2": 450 }) });
    const order = r.stdout.split("\n").filter((l) => /^P1-r\d/.test(l)).map((l) => l.split(" ")[0]);
    assert.deepEqual(order, ["P1-r3", "P1-r2", "P1-r1"], "終わる順は逆");
    const started = [1, 2, 3].map((n) => Date.parse(readJson(join(out, `P1-r${n}`, "summary.line.json")).started_at));
    [1, 2, 3].forEach((n, i) => assert.ok(started[i] <= Number(readFileSync(join(out, `P1-r${n}`, "received-start.json"), "utf8")), `P1-r${n} の started_at は子の起動より前`));
    assert.ok(started[0] <= started[1] && started[1] <= started[2], "起動の順");
    const dest = join(base, "fz");
    assert.equal(freeze(repo, out, dest).status, 0);
    assert.equal(readJson(join(dest, FROZEN_SET_FILE)).adopted[0].run, "P1-r1");
  });
});

test("凍結の断る条件：それぞれ符号つきの exit 3 で、組を書かない", async () => {
  await withBase(async (base) => {
    const repo = makeRepo(base);
    const good = join(base, "plan-eval");
    measure(repo, good, ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"]);
    const cases = [
      ["conditions-missing", (o) => rmSync(join(o, "conditions.json")), "freeze:conditions-missing"],
      ["conditions-unreadable", (o) => writeFileSync(join(o, "conditions.json"), "{"), "freeze:conditions-unreadable"],
      ["schema", (o) => edit(join(o, "conditions.json"), (c) => { c.schema = "musunest-factory/agent-accept-conditions/v3"; }), "freeze:conditions-schema"],
      ["mode", (o) => edit(join(o, "conditions.json"), (c) => { c.params.mode = "e2e"; }), "freeze:mode"],
      ["planned", (o) => edit(join(o, "conditions.json"), (c) => { c.child_args = c.child_args.slice(1); }), "freeze:planned"],
      ["dirty", (o) => edit(join(o, "conditions.json"), (c) => { c.source.dirty = true; }), "freeze:dirty"],
      ["dirty-null", (o) => edit(join(o, "conditions.json"), (c) => { c.source.dirty = null; }), "freeze:dirty"],
      ["commit", (o) => edit(join(o, "conditions.json"), (c) => { c.source.commit = null; }), "freeze:commit"],
      ["set-sha", (o) => edit(join(o, "conditions.json"), (c) => { c.set.sha256 = "0".repeat(64); }), "freeze:set-sha256"],
      ["incomplete", (o) => rmSync(join(o, "P2-r1"), { recursive: true }), "freeze:incomplete"],
      ["envelope-rejected", (o) => edit(join(o, "P1-r1/bundle/plan-result.json"), (e) => { e.plan_sha256 = "0".repeat(64); }), "freeze:envelope-rejected:plan-sha256"],
      ["envelope-unreadable", (o) => writeFileSync(join(o, "P1-r1/bundle/plan-result.json"), "{"), "freeze:envelope-unreadable"],
      ["envelope-read", (o) => { rmSync(join(o, "P1-r1/bundle/plan-result.json")); mkdirSync(join(o, "P1-r1/bundle/plan-result.json")); }, "freeze:envelope-read"],
      ["envelope-parse", (o) => edit(join(o, "P1-r1/bundle/plan-result.json"), (e) => { delete e.stop; }), "freeze:envelope-unreadable:plan-file-required"],
      ["envelope-conditions", (o) => edit(join(o, "P1-r1/bundle/plan-result.json"), (e) => { e.conditions.model = "other-model"; }), "freeze:envelope-conditions"],
      ["started-at", (o) => edit(join(o, "P1-r1/summary.line.json"), (sl) => { delete sl.started_at; }), "freeze:started-at"],
    ];
    for (const [name, tweak, code] of cases) {
      const o = join(base, `case-${name}`);
      cpSync(good, o, { recursive: true });
      tweak(o);
      const dest = join(base, `fz-${name}`);
      const r = assertFreezeRefused(base, (env) => freeze(repo, o, dest, undefined, env), code, { input: o, dest, label: name });
      assert.ok(!r.stderr.includes(base), `${name}: パスを出した`);
    }
    // 全部の P に確定が無い
    const none = join(base, "plan-none");
    measure(repo, none, ["--only", "P1,P2", "--runs", "2", "--concurrency", "1"], { FAKE_PLAN: JSON.stringify({ "P1-r1": "cannot-confirm", "P1-r2": "stopped", "P2-r1": "none", "P2-r2": "cannot-confirm" }) });
    const rn = assertFreezeRefused(base, (env) => freeze(repo, none, join(base, "fz-none"), undefined, env), "freeze:none-confirmed", { input: none, dest: join(base, "fz-none") });
    assert.match(rn.stderr, /\[freeze:none-confirmed\] count=2/);
    // 出力先が空でない・引数が足りない
    mkdirSync(join(base, "fz-full"));
    writeFileSync(join(base, "fz-full", "x"), "");
    assertFreezeRefused(base, (env) => freeze(repo, good, join(base, "fz-full"), undefined, env), "freeze:out-not-empty", { input: good, dest: join(base, "fz-full"), destBefore: { x: "" } });
    assert.deepEqual(readdirSync(join(base, "fz-full")), ["x"]);
    for (const extra of [["--id", "fz-1"], ["--version", "1"], ["--id", "fz-1", "--version", "x"]]) {
      assertFreezeRefused(base, (env) => freeze(repo, good, join(base, "fz-args"), extra, env), "freeze:args", { input: good, dest: join(base, "fz-args"), label: extra.join(" ") });
    }
    // 元の出力は凍結で変わらない（写すだけ）
    assert.equal(freeze(repo, good, join(base, "fz-ok")).status, 0);
  });
});

test("(l) 漏えい：依頼文・仕様の本体・止まり方の符号・検査の message・子の出力の目印は、組のファイルと凍結の道具の出力に出ない（包みの写しには残る）", async () => {
  await withBase(async (base) => {
    const repo = makeRepo(base, { requestOf: (p) => [`依頼 P${p} ${MARK}`] });
    const out = join(base, "plan-eval");
    measure(repo, out, ["--only", "P1,P2", "--runs", "2", "--concurrency", "1"], { FAKE_MARK: MARK, FAKE_PLAN: JSON.stringify({ "P1-r1": "stopped", "P2-r2": "cannot-confirm" }) });
    const dest = join(base, "fz");
    const r = freeze(repo, out, dest, undefined, { FAKE_MARK: MARK });
    assert.equal(r.status, 0, r.stderr);
    for (const t of [r.stdout, r.stderr, readFileSync(join(dest, FROZEN_SET_FILE), "utf8")]) assert.ok(!t.includes(MARK), "目印が出た");
    assert.ok(readFileSync(join(dest, readJson(join(dest, FROZEN_SET_FILE)).adopted[0].envelope.path), "utf8").includes(MARK), "仕様の本体は包みの写しにだけ置く");
    // 拒否：仕様の検査が目印入りの message で断る
    const bad = join(base, "plan-eval-stale");
    cpSync(out, bad, { recursive: true });
    edit(join(bad, "P1-r2/bundle/plan-result.json"), (e) => { e.plan.stale = true; });
    const rs = assertFreezeRefused(base, (env) => freeze(repo, bad, join(base, "fz-stale"), undefined, { ...env, FAKE_MARK: MARK }), "freeze:envelope-rejected:plan", { input: bad, dest: join(base, "fz-stale") });
    assert.ok(rs.stderr.includes("[freeze:envelope-rejected:plan] ids=P1-r2 count=1"), rs.stderr);
    assert.ok(!rs.stdout.includes(MARK) && !rs.stderr.includes(MARK));
  });
});

test("#513 v5 の Plan 計測（今の run-agent.mjs が書く条件）から凍結でき、保存済みの v4 の条件（params.pipeline・v1.1α の上限の欄・comparison が無い）も今までどおり凍結できる。組に条件の schema を書き戻さない", async () => {
  await withBase(async (base) => {
    const repo = makeRepo(base);
    const out = join(base, "plan-eval-v5");
    measure(repo, out, ["--only", "P1,P2", "--runs", "2", "--concurrency", "1"], { FAKE_PLAN: JSON.stringify({ "P1-r1": "cannot-confirm", "P2-r2": "stopped" }) });
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v5");
    assert.deepEqual([cond.params.mode, cond.params.pipeline, cond.comparison], ["plan-only", "v1", null]);
    const d5 = join(base, "fz-v5");
    const r5 = freeze(repo, out, d5);
    assert.equal(r5.status, 0, r5.stderr);
    const f5 = readJson(join(d5, FROZEN_SET_FILE));
    assert.equal(f5.schema, FROZEN_SET_SCHEMA);
    assert.deepEqual(f5.adopted.map((a) => a.run), ["P1-r2", "P2-r1"]);
    assert.ok(!readFileSync(join(d5, FROZEN_SET_FILE), "utf8").includes("agent-accept-conditions"), "条件の schema を組に書き戻さない");
    // 保存済みの v4 の条件（#497 の形）に戻した出力先
    const v4 = join(base, "plan-eval-v4");
    cpSync(out, v4, { recursive: true });
    edit(join(v4, "conditions.json"), (c) => { c.schema = "musunest-factory/agent-accept-conditions/v4"; delete c.params.pipeline; delete c.params.stage_output_limits_v11a; delete c.comparison; });
    const d4 = join(base, "fz-v4");
    const r4 = freeze(repo, v4, d4);
    assert.equal(r4.status, 0, r4.stderr);
    const f4 = readJson(join(d4, FROZEN_SET_FILE));
    assert.deepEqual([f4.adopted, f4.missing, f4.set, f4.rule], [f5.adopted, f5.missing, f5.set, f5.rule], "採用・外した P・組の出どころは v5 と同じ");
    assert.equal(f4.source_measurement.conditions_sha256, sha256(readFileSync(join(v4, "conditions.json"))));
    for (const a of f4.adopted) assert.deepEqual(readFileSync(join(d4, a.envelope.path)), readFileSync(join(d5, a.envelope.path)));
    // v3 以前と知らない版は今までどおり断る
    const v6 = join(base, "plan-eval-v6");
    cpSync(out, v6, { recursive: true });
    edit(join(v6, "conditions.json"), (c) => { c.schema = "musunest-factory/agent-accept-conditions/v6"; });
    assertFreezeRefused(base, (env) => freeze(repo, v6, join(base, "fz-v6"), undefined, env), "freeze:conditions-schema", { input: v6, dest: join(base, "fz-v6") });
  });
});
