// run-agent.mjs の試験（node --test。#400・#425・#427）。ネットワーク無し・API 無しで閉じる：
// 一時の偽物のリポジトリに、偽物の工場の入口（dist/cli.js）と抽象的な依頼文（定義ファイル sets/dev-p1-p10.json と、その出どころの表）を置き、run-agent を子プロセスで回す。
// 本物の定義ファイルの依頼文が今の表（stage1-patterns.md）と一致することは、このリポジトリの実物を読んで確かめる（最後の試験）。
// #497：Plan だけ・台本・凍結した組から Build だけの口、終了の分類、記録の無害化、拒否の符号（README §5.7）。凍結の道具そのものは freeze-plan-set.test.mjs
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_SET_PATH, EVAL_SET_SCHEMA, PLAN_SCRIPT_SCHEMA, loadEvalSet, reconcile, scoringFingerprint, scriptsFingerprint } from "./score-agent.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runAgentFile = join(here, "run-agent.mjs");
/** このリポジトリ（本物の定義ファイルと表の照合に使う） */
const realRepo = resolve(here, "../../../../../..");
const SUBJECT_OF = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };
const STYLE_OF = { P1: "S1", P2: "S2", P3: "S1", P4: "S2", P5: "S1", P6: "S2", P7: "S1", P8: "S2", P9: "S1", P10: "S2" };
const WRITABLE_OF = { A: true, B: false, C: true, D: false, E: true };

// 偽物の工場の入口。標準出力・標準エラーを制御し、自分の引数と起動を記録する。import されたときは main を動かさない。
// #497：--plan-only なら FAKE_PLAN（本の ID → confirmed／cannot-confirm／stopped／none）で Plan だけの結果を書き、FAKE_EXIT_MAP・FAKE_LINES・FAKE_DELAY で
// 本ごとの終了コード・標準出力の行・遅れを決める。FAKE_MARK は止まり方の符号・仕様の本体・標準エラーに入れる目印（漏えいの試験）
const fakeCli = String.raw`import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 600000;
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
const h = (t) => createHash("sha256").update(t).digest("hex");
const map = (k) => { try { return JSON.parse(process.env[k] ?? "{}"); } catch { return {}; } };
function main() {
  const startedMs = Date.now();
  const argv = process.argv.slice(1);
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : "";
  const runDir = dirname(outDir);
  const id = basename(runDir);
  if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, id + "\n");
  try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(runDir, "received-argv.json"), JSON.stringify(argv)); writeFileSync(join(runDir, "received-start.json"), String(startedMs)); } catch {}
  process.exitCode = Number(process.env.FAKE_EXIT ?? "0");
  const mark = process.env.FAKE_MARK ?? "";
  const val = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes("--plan-only")) {
    const outcome = map("FAKE_PLAN")[id] ?? "confirmed";
    const pid = id.split("-")[0];
    const plan = outcome === "confirmed" ? { plan_id: "plan-" + pid, vocabulary_version: "v1", body: ["spec " + pid, mark] } : null;
    const conditions = { model: val("--model"), effort: val("--effort"), budget_usd: Number(val("--budget")), deadline_ms: Number(val("--deadline")) * 60000, timeout_ms: null, vocabulary_version: "v1", prompt_version: "v1", contract_version: "v0.2", factory_version: "0.0.0", spec_engine_version: "0.0.0" };
    const stop = outcome === "confirmed" ? null : { kind: outcome === "stopped" ? "stopped" : "cannot-confirm", reason: outcome === "stopped" ? "deadline" : null, codes: [mark || "code-x"] };
    if (outcome !== "none") writeFileSync(join(outDir, "plan-result.json"), JSON.stringify({ schema_version: "musunest-factory/plan-only-result/v1", outcome, plan, plan_sha256: plan === null ? null : h(JSON.stringify(plan)), source_sha256: h(readFileSync(process.argv[2], "utf8")), conditions, stop }));
    if (outcome !== "confirmed") process.exitCode = 1;
  }
  const exitMap = map("FAKE_EXIT_MAP");
  if (exitMap[id] !== undefined) process.exitCode = exitMap[id];
  const lines = map("FAKE_LINES")[id];
  const delay = Number(map("FAKE_DELAY")[id] ?? 0);
  if (lines !== undefined) {
    setTimeout(() => { for (const l of lines) process.stdout.write(l + "\n"); if (mark) process.stderr.write("stderr " + mark + "\n"); }, delay);
    return;
  }
  if (delay > 0) { setTimeout(() => process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "full", provider_cost_usd: 0 }) + "\n"), delay); return; }
  if ((process.env.FAKE_MODE ?? "summary") === "bytes") {
    process.stdout.write(Buffer.from([0xe3]));
    process.stderr.write(Buffer.from([0xf0, 0x9f]));
    setTimeout(() => {
      process.stdout.write(Buffer.concat([Buffer.from([0x81, 0x82]), Buffer.from("x".repeat(600) + "\n")]));
      process.stderr.write(Buffer.concat([Buffer.from([0x8d, 0xa3]), Buffer.from("y".repeat(600) + "\n")]));
    }, 30);
  } else {
    const cost = Number(process.env.FAKE_COST ?? "0.25");
    process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "PASS", provider_cost_usd: cost }) + "\n");
  }
}
if (isEntry()) main();
`;

// 偽物の包みの読み取りと検査の関数（packages/factory/src/cli-plan.ts の parsePlanFile・validatePlanFile と同じ順と符号。仕様の検査は plan.stale で、
// 仕様の SHA は JSON の SHA-256 で代える）。断るときは検査の message に目印を入れる（記録に出ないことを確かめる）
const fakeCliPlan = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const COND = ["model", "effort", "budget_usd", "deadline_ms", "timeout_ms", "vocabulary_version", "prompt_version", "contract_version", "factory_version", "spec_engine_version"];
export const PLAN_ONLY_RESULT_SCHEMA = "musunest-factory/plan-only-result/v1";
export function parsePlanFile(text) {
  let v; try { v = JSON.parse(text); } catch { return { code: "plan-file-json" }; }
  if (!isRec(v)) return { code: "plan-file-envelope" };
  if (["schema_version", "outcome", "plan", "plan_sha256", "source_sha256", "conditions", "stop"].some((k) => v[k] === undefined)) return { code: "plan-file-required" };
  if (typeof v.schema_version !== "string" || typeof v.outcome !== "string" || !(v.plan === null || isRec(v.plan)) || !(v.plan_sha256 === null || typeof v.plan_sha256 === "string") || typeof v.source_sha256 !== "string" || !(v.conditions === null || isRec(v.conditions)) || !(v.stop === null || isRec(v.stop))) return { code: "plan-file-type" };
  if (isRec(v.conditions) && COND.some((k) => v.conditions[k] === undefined)) return { code: "plan-file-required" };
  if (isRec(v.stop) && ["kind", "reason", "codes"].some((k) => v.stop[k] === undefined)) return { code: "plan-file-required" };
  if (isRec(v.stop) && !Array.isArray(v.stop.codes)) return { code: "plan-file-type" };
  return { envelope: { schema_version: v.schema_version, outcome: v.outcome, plan: v.plan, plan_sha256: v.plan_sha256, source_sha256: v.source_sha256 } };
}
export async function validatePlanFile({ envelope, source, vocabularyVersion }) {
  const message = process.env.FAKE_MARK ?? "";
  if (envelope.schema_version !== PLAN_ONLY_RESULT_SCHEMA) return { kind: "rejected", check: "envelope-version", codes: ["mismatch"] };
  if (envelope.outcome !== "confirmed") return { kind: "rejected", check: "outcome", codes: ["not-confirmed"] };
  if (!isRec(envelope.plan) || envelope.plan.stale === true) return { kind: "rejected", check: "plan", codes: ["confirmation-stale"], message };
  const planSha256 = h(JSON.stringify(envelope.plan));
  if (planSha256 !== envelope.plan_sha256) return { kind: "rejected", check: "plan-sha256", codes: ["mismatch"] };
  const sourceSha256 = h(source);
  if (sourceSha256 !== envelope.source_sha256) return { kind: "rejected", check: "source-sha256", codes: ["mismatch"] };
  if (envelope.plan.vocabulary_version !== vocabularyVersion) return { kind: "rejected", check: "vocabulary", codes: ["mismatch"] };
  return { kind: "ok", plan: envelope.plan, planSha256, sourceSha256 };
}
`;

const fakeOpenai = 'export const DEFAULT_OPENAI_MODEL = "fake-model";\n';
const fakeLimits = 'export const DEFAULT_REASONING_EFFORT = "high";\nexport const STAGE_MAX_OUTPUT_TOKENS = { low: { requirements: 2048 }, medium: { requirements: 16384 }, high: { requirements: 16384 } };\n';
// 偽物の appspec-schema の files（工場の入口が生成に渡す文書の置き場所を引く口。packages/appspec-schema/src/files.ts と同じ形）
const fakeSchemaFiles = `export const CONTRACT_DIR = "contract";
export function packageFile(relativePath) { return new URL("../" + relativePath, import.meta.url); }
export const vocabularyFile = () => packageFile("vocabulary.yaml");
export const semanticsFile = () => packageFile("docs/semantics.md");
`;

const requestLines = (p) => [`依頼 ${p} の行 1`, `依頼 ${p} の行 2`];
function makeTable() {
  let text = "# 題材\n\n";
  for (let p = 1; p <= 10; p++) text += `**P${p}（S1 丁寧）**\n\n> ${requestLines(p).join("\n> ")}\n\n**判定：書ける。**\n\n`;
  return text;
}
/** 偽物の定義ファイル（今の組と同じ対応。採点の定義と台本は偽物の eval の中を相対で指す） */
function makeSet(over = {}) {
  const items = [];
  for (let p = 1; p <= 10; p++) { const id = `P${p}`, subject = SUBJECT_OF[id]; items.push({ id, subject, style: STYLE_OF[id], writable: WRITABLE_OF[subject], scoring: `../subjects/${subject}.json`, script: `scripts/${subject}.json`, request: requestLines(p) }); }
  return { schema: EVAL_SET_SCHEMA, id: "dev-p1-p10", version: 1, role: "development", title: "t", source: { document: "workspace/mvp/m1/grammar-trial/stage1-patterns.md" }, styles: { S1: "s1", S2: "s2" }, items, ...over };
}

/** 一時の偽物のリポジトリを作る。dist は src より後に書くので「作り直した」根拠が立つ */
function makeRepo(base) {
  const repo = join(base, "repo");
  mkdirSync(join(repo, "packages/factory/dist"), { recursive: true });
  mkdirSync(join(repo, "packages/factory/src"), { recursive: true });
  mkdirSync(join(repo, "workspace/mvp/m1/grammar-trial"), { recursive: true });
  writeFileSync(join(repo, "packages/factory/package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(repo, "packages/factory/src/index.ts"), "export {};\n");
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeCli);
  writeFileSync(join(repo, "packages/factory/dist/cli-plan.js"), fakeCliPlan);
  writeFileSync(join(repo, "packages/factory/dist/openai.js"), fakeOpenai);
  writeFileSync(join(repo, "packages/factory/dist/limits.js"), fakeLimits);
  writeFileSync(join(repo, "workspace/mvp/m1/grammar-trial/stage1-patterns.md"), makeTable());
  // #425：spec-engine の dist・生成に渡す文書・採点の定義と集計のコード（指紋を取るだけ。中身は動かさない）
  mkdirSync(join(repo, "packages/spec-engine/dist"), { recursive: true });
  writeFileSync(join(repo, "packages/spec-engine/dist/index.js"), "export const version = 1;\n");
  mkdirSync(join(repo, "packages/appspec-schema/dist"), { recursive: true });
  mkdirSync(join(repo, "packages/appspec-schema/contract"), { recursive: true });
  mkdirSync(join(repo, "packages/appspec-schema/docs"), { recursive: true });
  writeFileSync(join(repo, "packages/appspec-schema/dist/files.js"), fakeSchemaFiles);
  writeFileSync(join(repo, "packages/appspec-schema/contract/rules.md"), "# 契約 1\n");
  writeFileSync(join(repo, "packages/appspec-schema/contract/schema.json"), "{}\n");
  writeFileSync(join(repo, "packages/appspec-schema/docs/semantics.md"), "# 意味\n");
  writeFileSync(join(repo, "packages/appspec-schema/vocabulary.yaml"), "words: []\n");
  const ev = join(repo, "workspace/mvp/m1/agent/eval");
  mkdirSync(join(ev, "subjects"), { recursive: true });
  mkdirSync(join(ev, "agent-accept"), { recursive: true });
  mkdirSync(join(ev, "sets/scripts"), { recursive: true });
  for (const f of ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "agent-accept/score-agent.mjs"]) writeFileSync(join(ev, f), `// ${f}\n`);
  // #427：定義ファイル（既定の組）と、題材ごとの採点の定義・台本（指紋を取り、形を検証するだけ。中身は動かさない）
  for (const s of ["A", "B", "C", "D", "E"]) {
    writeFileSync(join(ev, `subjects/${s}.json`), JSON.stringify({ id: s, structures: [{ id: "main", checks: [{ req: "要件 1" }], unwritable: [] }] }));
    writeFileSync(join(ev, `sets/scripts/${s}.json`), JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: s, version: 1, entries: [] }));
  }
  writeFileSync(join(ev, "sets/dev-p1-p10.json"), JSON.stringify(makeSet()));
  return repo;
}

function runAgent(repo, out, extra, env = {}) {
  return spawnSync(process.execPath, [runAgentFile, repo, out, ...extra], { encoding: "utf8", env: { ...process.env, JEV_API_KEY: "", ...env } });
}
const spawnCount = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
const spawnLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/** 出力先のファイルの一覧とバイト列（既存の断りの試験で、何も変わらないことを確かめる。#497） */
function treeOf(root) { const out = {}; const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(root, f)] = readFileSync(f).toString("base64"); } }; walk(root); return out; }

async function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), "run-agent-test-"));
  try { await fn(base, makeRepo(base)); } finally { rmSync(base, { recursive: true, force: true }); }
}

test("500 文字を超え分かれ UTF-8 の途中で切れた標準出力・標準エラーを、成功でも非 0 でもそのままのバイト列で残す", async () => {
  await withRepo(async (base, repo) => {
    const expectedOut = Buffer.concat([Buffer.from([0xe3, 0x81, 0x82]), Buffer.from("x".repeat(600) + "\n")]);
    const expectedErr = Buffer.concat([Buffer.from([0xf0, 0x9f, 0x8d, 0xa3]), Buffer.from("y".repeat(600) + "\n")]);
    for (const code of [0, 7]) {
      const out = join(base, `out-bytes-${code}`);
      const r = runAgent(repo, out, ["--only", "P1", "--runs", "2", "--concurrency", "1"], { FAKE_MODE: "bytes", FAKE_EXIT: String(code) });
      assert.equal(r.status, 0, r.stderr);
      for (const run of ["P1-r1", "P1-r2"]) {
        const dir = join(out, run);
        assert.deepEqual(readFileSync(join(dir, "stdout.log")), expectedOut, `${run} の標準出力`);
        assert.deepEqual(readFileSync(join(dir, "stderr.log")), expectedErr, `${run} の標準エラー`);
        assert.equal(JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")).exit, code);
      }
    }
  });
});

test("条件のファイルは、子プロセスへ渡した引数と一致する", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-conds");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--plan", "--effort", "medium"]);
    assert.equal(r.status, 0, r.stderr);
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    const entry = cond.child_args.find((c) => c.id === "P1-r1");
    const received = JSON.parse(readFileSync(join(out, "P1-r1", "received-argv.json"), "utf8"));
    assert.deepEqual(entry.argv, received);
    assert.equal(cond.params.effort, "medium");
    assert.equal(cond.params.plan, true);
    assert.equal(cond.params.answers_mode, "recommended");
    assert.ok(received.includes("--answers"));
  });
});

test("前の結果がある出力先では、既定で子プロセスを 1 本も起こさずに非 0 で終える", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-prior");
    const log = join(base, "spawn-prior.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 1);
    const before = treeOf(out);
    const again = runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(again.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(again.stderr, /断りました/);
    assert.equal(again.status, 3);
    assert.ok(again.stderr.includes("[resume:prior-output]"), again.stderr);
    assert.deepEqual(treeOf(out), before);
  });
});

test("再開で条件が一致しないと、子プロセスを起こさずに非 0 で終える", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-mismatch");
    const log = join(base, "spawn-mismatch.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1", "--effort", "high"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 1);
    const before = treeOf(out);
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--effort", "low", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /条件/);
    assert.equal(resumed.status, 3);
    assert.ok(resumed.stderr.includes("[resume:signature]"), resumed.stderr);
    assert.deepEqual(treeOf(out), before);
  });
});

test("再開で条件が一致すると、終わった本の費用を足してから残りだけを起こし、既存のファイルを上書きしない", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-resume");
    const log = join(base, "spawn-resume.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" }).status, 0);
    assert.equal(spawnCount(log), 2);
    const summaryBefore = readFileSync(join(out, "P1-r1", "summary.line.json"));
    const stdoutBefore = readFileSync(join(out, "P1-r1", "stdout.log"));
    const conditionsBefore = readFileSync(join(out, "conditions.json"));
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(spawnLines(log), ["P1-r1", "P2-r1", "P2-r1"]);
    assert.deepEqual(readFileSync(join(out, "P1-r1", "summary.line.json")), summaryBefore);
    assert.deepEqual(readFileSync(join(out, "P1-r1", "stdout.log")), stdoutBefore);
    assert.deepEqual(readFileSync(join(out, "conditions.json")), conditionsBefore);
    assert.match(resumed.stdout, /P2-r1 .*total=0\.500/);
    assert.match(resumed.stdout, /spent 0\.5000/);
    const record = readdirSync(out).filter((n) => /^resume-\d+\.json$/.test(n));
    assert.equal(record.length, 1);
    const rr = JSON.parse(readFileSync(join(out, record[0]), "utf8"));
    assert.deepEqual(rr.skipped, ["P1-r1"]);
    assert.deepEqual(rr.reopened, ["P2-r1"]);
    assert.deepEqual(rr.pending, []);
    assert.equal(rr.budget_usd, 15, "再開の記録にも、その起動で有効だった目安の額（既定 15）");
    assert.equal(rr.stop_code, null);
  });
});

test("条件のファイルが無い出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-nocond");
    const log = join(base, "spawn-nocond.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "conditions.json"));
    const before = treeOf(out);
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.equal(resumed.status, 3);
    assert.ok(resumed.stderr.includes("[resume:no-conditions]"), resumed.stderr);
    assert.deepEqual(treeOf(out), before);
  });
});

test("全文が欠けた古い出力の出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-nofull");
    const log = join(base, "spawn-nofull.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r1", "stdout.log"));
    const before = treeOf(out);
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /全文/);
    assert.equal(resumed.status, 3);
    assert.ok(resumed.stderr.includes("[resume:no-logs]"), resumed.stderr);
    assert.deepEqual(treeOf(out), before);
  });
});

test("要約の無い途中の本がある出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-partial");
    const log = join(base, "spawn-partial.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r1", "summary.line.json"));
    const before = treeOf(out);
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /要約/);
    assert.equal(resumed.status, 3);
    assert.ok(resumed.stderr.includes("[resume:partial]"), resumed.stderr);
    assert.deepEqual(treeOf(out), before);
  });
});

// ── #425：比較の条件の指紋と判定の口の構成

test("条件のファイルに、spec-engine の dist・生成に渡す文書・採点の定義と集計・判定の口の構成の指紋が入り、鍵の値は入らない", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-fp");
    const secret = "fake-jev-key-value-that-must-not-be-recorded";
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1"], { JEV_API_KEY: secret });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(out, "conditions.json"), "utf8");
    assert.ok(!text.includes(secret), "鍵の値が条件のファイルに出ている");
    const cond = JSON.parse(text);
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v4");
    assert.equal(cond.spec_engine.dist_dir, "packages/spec-engine/dist");
    assert.match(cond.spec_engine.fingerprint, HEX64);
    assert.equal(cond.spec_engine.files, 1);
    assert.equal(cond.prompt_documents.contract.dir, "packages/appspec-schema/contract");
    assert.match(cond.prompt_documents.contract.fingerprint, HEX64);
    assert.equal(cond.prompt_documents.contract.files, 2);
    assert.equal(cond.prompt_documents.semantics.path, "packages/appspec-schema/docs/semantics.md");
    assert.equal(cond.prompt_documents.semantics.sha256, sha256(readFileSync(join(repo, "packages/appspec-schema/docs/semantics.md"))));
    assert.equal(cond.prompt_documents.vocabulary.path, "packages/appspec-schema/vocabulary.yaml");
    assert.equal(cond.prompt_documents.vocabulary.sha256, sha256(readFileSync(join(repo, "packages/appspec-schema/vocabulary.yaml"))));
    assert.equal(cond.scoring.dir, "workspace/mvp/m1/agent/eval");
    const fakeEv = join(repo, "workspace/mvp/m1/agent/eval");
    assert.deepEqual(cond.scoring, { dir: "workspace/mvp/m1/agent/eval", ...scoringFingerprint(fakeEv, undefined, loadEvalSet(join(fakeEv, "sets/dev-p1-p10.json")).definitions) });
    assert.deepEqual(cond.scoring.missing, []);
    // 組が参照する採点の定義の実体（definition:<題材>）も指紋に入る（fix-427）
    assert.deepEqual(cond.scoring.files.filter((f) => f.path.startsWith("definition:")), ["A", "B", "C", "D", "E"].map((s) => ({ path: `definition:${s}`, source: `subjects/${s}.json`, sha256: sha256(readFileSync(join(fakeEv, `subjects/${s}.json`))) })));
    assert.deepEqual(cond.judge, { configuration: "jev-primary-llm-fallback", jev_key_env: "JEV_API_KEY" });
    // Jev の鍵が無ければ LLM だけ（cli.ts の assembleJudge と同じ分かれ方）。空文字も「無い」
    const out2 = join(base, "out-fp-llm");
    assert.equal(runAgent(repo, out2, ["--only", "P1", "--runs", "1"], { JEV_API_KEY: "" }).status, 0);
    assert.equal(JSON.parse(readFileSync(join(out2, "conditions.json"), "utf8")).judge.configuration, "llm-only");
  });
});

test("生成に渡す文書か判定の口の構成が変わると条件が一致せず、再開を断る", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-doc.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-doc");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    appendFileSync(join(repo, "packages/appspec-schema/vocabulary.yaml"), "#\n");
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    // 判定の口の構成：LLM だけで始めた計測を、Jev ありで再開することはできない
    const out2 = join(base, "out-judge");
    assert.equal(runAgent(repo, out2, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out2, "P2-r1"), { recursive: true, force: true });
    const resumed2 = runAgent(repo, out2, [...args, "--resume"], { FAKE_SPAWN_LOG: log, JEV_API_KEY: "x" });
    assert.notEqual(resumed2.status, 0);
    assert.match(resumed2.stderr, /条件/);
    assert.equal(spawnCount(log), 4);
    // spec-engine の dist・契約・語彙の意味のそれぞれの変更も、署名に残るので再開を断る（変更は積み上がるが、新しい計測は毎回その時点の条件で始める）
    let spawned = 4;
    for (const [name, file] of [["spec-engine", "packages/spec-engine/dist/index.js"], ["contract", "packages/appspec-schema/contract/rules.md"], ["semantics", "packages/appspec-schema/docs/semantics.md"]]) {
      const outN = join(base, `out-${name}`);
      assert.equal(runAgent(repo, outN, args, { FAKE_SPAWN_LOG: log }).status, 0, name);
      spawned += 2;
      rmSync(join(outN, "P2-r1"), { recursive: true, force: true });
      appendFileSync(join(repo, file), "\n");
      const resumedN = runAgent(repo, outN, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
      assert.notEqual(resumedN.status, 0, name);
      assert.match(resumedN.stderr, /条件/, name);
      assert.equal(spawnCount(log), spawned, name);
    }
  });
});

test("v1 の条件のファイル（#401）の計測を、今の道具で再開することはできない（schema が署名に入る）", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-v1.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-v1");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    // v1 の形（#401）：spec_engine・prompt_documents・judge・scoring（#425）・set・scripts（#427）が無く、署名は全欄から取る
    const v2 = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    const { spec_engine: _se, prompt_documents: _pd, judge: _j, scoring: _s, set: _set, scripts: _sc, started_at: _t, signature: _sig, ...rest } = v2;
    const measured = { ...rest, schema: "musunest-factory/agent-accept-conditions/v1" };
    writeFileSync(join(out, "conditions.json"), JSON.stringify({ ...measured, started_at: v2.started_at, signature: sha256(JSON.stringify(measured)) }, null, 1));
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    // 採点の道具は v1 の条件のファイルをそのまま照合できる（score-agent.test.mjs の v1 の例と同じ）
    const c = reconcile(out);
    assert.equal(c.status, "incomplete");
    assert.deepEqual(c.unexecuted, ["P2-r1"]);
  });
});

test("v2 の条件のファイル（#425）の計測を、今の道具で再開することはできない（schema と set が署名に入る。安全側の拒否で、救済のために署名から外さない）", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-v2.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-v2");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    // v2 の形（#425）：set・scripts（#427）が無く schema は v2。署名は started_at・scoring・params.budget_usd を除いた全部（#425 の計算と同じ）
    const v3 = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    const { set: _set, scripts: _sc, started_at: _t, signature: _sig, scoring: _scoring, ...generation } = v3;
    const measured = { ...generation, schema: "musunest-factory/agent-accept-conditions/v2" };
    const { budget_usd: _b, ...params } = measured.params;
    writeFileSync(join(out, "conditions.json"), JSON.stringify({ ...measured, scoring: v3.scoring, started_at: v3.started_at, signature: sha256(JSON.stringify({ ...measured, params })) }, null, 1));
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /保存した条件と今の条件が一致しません/);
    assert.equal(spawnCount(log), 2);
    // 採点の道具は v2 の条件のファイルをそのまま照合できる（score-agent.test.mjs の v2 の例と同じ）
    const c = reconcile(out);
    assert.equal(c.status, "incomplete");
    assert.deepEqual(c.unexecuted, ["P2-r1"]);
  });
});

test("組が subjects/ の外の採点の定義を参照すると、その実体が条件の採点の指紋に入り、組を変えずに中身だけ変えると指紋が変わる（署名の外なので再開は妨げない）", async () => {
  await withRepo(async (base, repo) => {
    const fakeEv = join(repo, "workspace/mvp/m1/agent/eval");
    const defPath = join(base, "custom/defs/A.json");
    mkdirSync(dirname(defPath), { recursive: true });
    writeFileSync(defPath, readFileSync(join(fakeEv, "subjects/A.json")));
    const setPath = join(base, "custom/reg.json");
    writeFileSync(setPath, JSON.stringify({ schema: EVAL_SET_SCHEMA, id: "reg-t", version: 1, role: "regression", title: "t", styles: { S1: "s1" }, items: [{ id: "P1", subject: "A", style: "S1", writable: true, scoring: defPath, script: null, request: ["行 X"] }] }));
    const log = join(base, "spawn-def.log");
    const args = ["--runs", "2", "--concurrency", "1", "--set", setPath];
    const out = join(base, "out-def");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    assert.deepEqual(spawnLines(log), ["P1-r1", "P1-r2"]);
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.deepEqual(cond.scoring.files.filter((f) => f.path.startsWith("definition:")), [{ path: "definition:A", source: relative(fakeEv, defPath), sha256: sha256(readFileSync(defPath)) }]);
    assert.deepEqual(cond.scoring, { dir: "workspace/mvp/m1/agent/eval", ...scoringFingerprint(fakeEv, undefined, loadEvalSet(setPath).definitions) });
    // 組はそのまま、参照先の定義だけを変える：指紋は変わる（採点の出力が不一致と出す）。署名の外なので途中の計測の再開は断られない
    rmSync(join(out, "P1-r2"), { recursive: true, force: true });
    appendFileSync(defPath, "\n");
    const changed = scoringFingerprint(fakeEv, undefined, loadEvalSet(setPath).definitions);
    assert.notEqual(changed.fingerprint, cond.scoring.fingerprint);
    assert.equal(loadEvalSet(setPath).sha256, cond.set.sha256, "組の指紋は同じ");
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(spawnCount(log), 3);
    assert.equal(JSON.parse(readFileSync(join(out, "conditions.json"), "utf8")).scoring.fingerprint, cond.scoring.fingerprint, "条件のファイルは初回の値のまま");
  });
});

test("採点の定義の変更は署名の外で、source が変わらない限り再開を妨げない（採点は生成のあとに全本へ同じ版を当て、採点の出力が条件と照合する）", async () => {
  // 偽物のリポジトリは git の外（source.commit・source.dirty が null のまま）なので、source が変わらない場合の挙動だけを確かめる。
  // 本物の checkout では source.commit・source.dirty が署名に残るので、clean を編集したり採点だけの commit を積んだりすれば再開は断られる
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-scoring.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-scoring");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    const before = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    appendFileSync(join(repo, "workspace/mvp/m1/agent/eval/subjects/A.json"), "\n");
    const evDir = join(repo, "workspace/mvp/m1/agent/eval");
    assert.notEqual(scoringFingerprint(evDir, undefined, loadEvalSet(join(evDir, "sets/dev-p1-p10.json")).definitions).fingerprint, before.scoring.fingerprint);
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(spawnCount(log), 3);
  });
});

test("予算で止まると、流した本・残りの本・止まった理由を run-<時刻>.json に残し、照合は未完了になる", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-budget");
    const log = join(base, "spawn-budget.log");
    const r = runAgent(repo, out, ["--only", "P1,P2,P3", "--runs", "1", "--concurrency", "1", "--budget-usd", "0.25"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawnLines(log), ["P1-r1"]);
    assert.match(r.stdout, /done 予算 0\.25 USD に達した/);
    const records = readdirSync(out).filter((n) => /^run-\d+\.json$/.test(n));
    assert.equal(records.length, 1);
    const rec = JSON.parse(readFileSync(join(out, records[0]), "utf8"));
    assert.equal(rec.mode, "fresh");
    assert.deepEqual(rec.executed, ["P1-r1"]);
    assert.deepEqual(rec.pending, ["P2-r1", "P3-r1"]);
    assert.match(rec.stop, /予算/);
    assert.equal(rec.stop_code, "budget");
    // その起動で有効だった計測全体の目安の額と、初回の条件との差
    assert.equal(rec.budget_usd, 0.25);
    assert.equal(rec.initial_budget_usd, 0.25);
    assert.equal(rec.budget_changed, false);
    assert.equal(rec.spent_usd, 0.25);
    const c = reconcile(out);
    assert.equal(c.status, "incomplete");
    assert.equal(c.label, "未完了");
    assert.equal(c.planned, 3);
    assert.equal(c.executed, 1);
    assert.deepEqual(c.unexecuted, ["P2-r1", "P3-r1"]);
    assert.deepEqual(c.incomplete, []);
    assert.deepEqual(c.extra, []);
    assert.match(c.latest_record.stop, /予算/);
    // 全体の目安の額は署名の外なので、上げて再開し、残りを流し切ると完了になる（再開の記録も run-<時刻>.json に残る）
    const resumed = runAgent(repo, out, ["--only", "P1,P2,P3", "--runs", "1", "--concurrency", "1", "--budget-usd", "1", "--resume"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(spawnLines(log), ["P1-r1", "P2-r1", "P3-r1"]);
    const records2 = readdirSync(out).filter((n) => /^run-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    assert.equal(records2.length, 2);
    const c2 = reconcile(out);
    assert.equal(c2.status, "complete");
    assert.equal(c2.label, "完了");
    assert.deepEqual(c2.unexecuted, []);
    assert.equal(c2.latest_record.stop, null);
    assert.equal(c2.latest_record.stop_code, null);
    // 完走した再開でも、変更後の目安の額が起動の記録に残る（条件のファイルは初回の値のまま。署名は管理の条件の一致を保証しない）
    const rec2 = JSON.parse(readFileSync(join(out, records2[1]), "utf8"));
    assert.equal(rec2.mode, "resume");
    assert.equal(rec2.stop, null);
    assert.equal(rec2.stop_code, null);
    assert.equal(rec2.budget_usd, 1);
    assert.equal(rec2.initial_budget_usd, 0.25);
    assert.equal(rec2.budget_changed, true);
    assert.equal(rec2.spent_usd, 0.75);
    assert.deepEqual(rec2.executed, ["P2-r1", "P3-r1"]);
    assert.equal(c2.latest_record.budget_usd, 1);
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.equal(cond.params.budget_usd, 0.25, "条件のファイルは初回の値のまま上書きしない");
    // 同じ額で再開した（変えていない）起動は budget_changed が false
    const out2 = join(base, "out-budget-same");
    assert.equal(runAgent(repo, out2, ["--only", "P1,P2", "--runs", "1", "--concurrency", "1", "--budget-usd", "0.25"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" }).status, 0);
    assert.equal(runAgent(repo, out2, ["--only", "P1,P2", "--runs", "1", "--concurrency", "1", "--budget-usd", "0.25", "--resume"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25" }).status, 0);
    const last = readdirSync(out2).filter((n) => /^run-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).at(-1);
    const rec3 = JSON.parse(readFileSync(join(out2, last), "utf8"));
    assert.equal(rec3.mode, "resume");
    assert.equal(rec3.budget_changed, false);
    assert.equal(rec3.budget_usd, 0.25);
    assert.equal(rec3.stop_code, "budget", "済みの額を足した時点で目安に達する（上げなければ流し切れない）");
    assert.deepEqual(rec3.executed, []);
  });
});

// ── #427：評価セットの定義ファイルと台本（README §5.6）

test("依頼文は定義ファイルの本から組み、条件のファイルに組（署名の内）・台本（署名の外）・出どころの文書を残す。答えのファイルは今までどおり空（すべて推奨）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-set");
    const r = runAgent(repo, out, ["--only", "P1,P2", "--runs", "1", "--concurrency", "1", "--plan"]);
    assert.equal(r.status, 0, r.stderr);
    for (const p of [1, 2]) assert.equal(readFileSync(join(out, `P${p}-r1`, "request.md"), "utf8"), requestLines(p).join("\n") + "\n", `P${p} の依頼文は行を改行でつなぎ、末尾に改行 1 つ`);
    assert.equal(readFileSync(join(out, "P1-r1", "answers.json"), "utf8"), "{}\n", "台本は実行中に当てない（答えは全部推奨）");
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v4");
    assert.equal(cond.params.answers_mode, "recommended");
    const setFile = join(repo, "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json");
    assert.deepEqual(cond.set, { path: "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json", sha256: sha256(readFileSync(setFile)), id: "dev-p1-p10", version: 1, role: "development", items: makeSet().items.map(({ id, subject, style, writable }) => ({ id, subject, style, writable })) });
    assert.deepEqual(cond.document, { path: "workspace/mvp/m1/grammar-trial/stage1-patterns.md", sha256: sha256(readFileSync(join(repo, "workspace/mvp/m1/grammar-trial/stage1-patterns.md"))) }, "出どころの文書は定義ファイルの source.document（v2 までの document と同じ値）");
    const loaded = loadEvalSet(setFile);
    assert.equal(loaded.status, "ok");
    assert.deepEqual(cond.scripts, { mode: "post-hoc", fingerprint: scriptsFingerprint(loaded.scripts).fingerprint, files: ["A", "B", "C", "D", "E"].map((s) => ({ subject: s, path: `workspace/mvp/m1/agent/eval/sets/scripts/${s}.json`, sha256: sha256(readFileSync(join(repo, `workspace/mvp/m1/agent/eval/sets/scripts/${s}.json`))) })) });
    assert.match(cond.scripts.fingerprint, HEX64);
    assert.deepEqual(cond.params.patterns, ["P1", "P2"]);
    // 署名：組は入る（定義ファイルを 1 文字変えると再開を断る）。台本は外（変えても再開でき、指紋だけ条件と違う）
    const log = join(base, "spawn-set.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out2 = join(base, "out-set-sig");
    assert.equal(runAgent(repo, out2, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out2, "P2-r1"), { recursive: true, force: true });
    appendFileSync(setFile, "\n");
    const resumed = runAgent(repo, out2, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    const out3 = join(base, "out-script-sig");
    assert.equal(runAgent(repo, out3, args, { FAKE_SPAWN_LOG: log }).status, 0);
    const before = JSON.parse(readFileSync(join(out3, "conditions.json"), "utf8"));
    rmSync(join(out3, "P2-r1"), { recursive: true, force: true });
    appendFileSync(join(repo, "workspace/mvp/m1/agent/eval/sets/scripts/A.json"), "\n");
    const resumed3 = runAgent(repo, out3, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumed3.status, 0, resumed3.stderr);
    assert.equal(spawnCount(log), 5);
    assert.notEqual(scriptsFingerprint(loadEvalSet(setFile).scripts).fingerprint, before.scripts.fingerprint, "台本の指紋は条件の値と違う（採点の出力が照合する）");
    assert.equal(JSON.parse(readFileSync(join(out3, "conditions.json"), "utf8")).scripts.fingerprint, before.scripts.fingerprint, "条件のファイルは初回の値のまま");
  });
});

test("欠けた欄のある定義ファイル・定義に無い ID の --only は、子プロセスを 1 本も起こさずに断る", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-bad.log");
    const setDir = join(repo, "workspace/mvp/m1/agent/eval/sets");
    const cases = [
      ["no-request", makeSet({ items: makeSet().items.map((it, i) => (i === 0 ? { ...it, request: [] } : it)) }), /items\[0\]\.request/],
      ["bad-id", makeSet({ items: makeSet().items.map((it, i) => (i === 0 ? { ...it, id: "X1" } : it)) }), /items\[0\]\.id/],
      ["no-writable", makeSet({ items: makeSet().items.map(({ writable: _w, ...it }) => it) }), /writable/],
      ["no-script-file", makeSet({ items: makeSet().items.map((it, i) => (i === 0 ? { ...it, script: "scripts/none.json" } : it)) }), /台本が無い/],
      ["no-scoring-file", makeSet({ items: makeSet().items.map((it, i) => (i === 0 ? { ...it, scoring: "../subjects/none.json" } : it)) }), /scoring の定義が無い/],
      ["no-items", makeSet({ items: [] }), /items/],
      ["bad-role", makeSet({ role: "MARK_ROLE" }), /role/],
    ];
    for (const [name, set, pattern] of cases) {
      const path = join(setDir, `${name}.json`);
      writeFileSync(path, JSON.stringify(set));
      const r = runAgent(repo, join(base, `out-${name}`), ["--only", "P1", "--runs", "1", "--set", path], { FAKE_SPAWN_LOG: log });
      assert.equal(r.status, 3, name);
      assert.match(r.stderr, /断りました: 定義ファイルを読めません/, name);
      assert.match(r.stderr, pattern, name);
      assert.ok(!r.stderr.includes("MARK_"), `${name}: 理由に入力の値が出ている`);
      assert.equal(existsSync(join(base, `out-${name}`, "conditions.json")), false, `${name}: 条件のファイルを書かない`);
    }
    assert.equal(spawnCount(log), 0);
    const missing = runAgent(repo, join(base, "out-missing"), ["--only", "P1", "--runs", "1", "--set", join(setDir, "none.json")], { FAKE_SPAWN_LOG: log });
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /定義ファイルが無い/);
    const unknownOnly = runAgent(repo, join(base, "out-only"), ["--only", "P1,P99", "--runs", "1"], { FAKE_SPAWN_LOG: log });
    assert.equal(unknownOnly.status, 3);
    assert.match(unknownOnly.stderr, /--only に定義ファイル（dev-p1-p10）に無い ID があります: P99/);
    assert.equal(spawnCount(log), 0);
  });
});

test("--set で別の定義ファイル（別の本・別の依頼文・台本なし・出どころなし）を流せる", async () => {
  await withRepo(async (base, repo) => {
    const setPath = join(base, "custom/reg.json");
    mkdirSync(join(base, "custom"), { recursive: true });
    const subjectsDir = join(repo, "workspace/mvp/m1/agent/eval/subjects");
    writeFileSync(setPath, JSON.stringify({ schema: EVAL_SET_SCHEMA, id: "reg-t", version: 2, role: "regression", title: "t", styles: { S1: "s1" }, items: [{ id: "P3", subject: "A", style: "S1", writable: true, scoring: join(subjectsDir, "A.json"), script: null, request: ["行 X", "行 Y"] }] }));
    const log = join(base, "spawn-custom.log");
    const out = join(base, "out-custom");
    const r = runAgent(repo, out, ["--runs", "1", "--set", setPath], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(spawnLines(log), ["P3-r1"], "定義ファイルの本だけを流す");
    assert.equal(readFileSync(join(out, "P3-r1", "request.md"), "utf8"), "行 X\n行 Y\n");
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.deepEqual([cond.set.id, cond.set.version, cond.set.role, cond.set.items], ["reg-t", 2, "regression", [{ id: "P3", subject: "A", style: "S1", writable: true }]]);
    assert.equal(cond.set.sha256, sha256(readFileSync(setPath)));
    assert.deepEqual(cond.params.patterns, ["P3"]);
    assert.deepEqual(cond.document, { path: null, sha256: null }, "出どころの文書が無ければ null");
    assert.deepEqual(cond.scripts, { mode: "post-hoc", fingerprint: null, files: [] }, "台本の無い組");
    assert.equal(cond.child_args.length, 1);
    assert.equal(cond.child_args[0].id, "P3-r1");
  });
});

test("本物の定義ファイル（sets/dev-p1-p10.json）から組み立てた P1〜P10 の依頼文の指紋は、今の表（stage1-patterns.md）の依頼文と一致し、題材・書き方・書ける範囲の対応も今までと同じ", () => {
  const table = readFileSync(join(realRepo, "workspace/mvp/m1/grammar-trial/stage1-patterns.md"), "utf8");
  // #427 より前の run-agent.mjs が表から依頼文を切り出していた読み方そのもの
  const reqOf = (pid) => { const m = table.match(new RegExp(`\\*\\*${pid}（[^）]*）\\*\\*\\n\\n((?:> .*\\n?)+)`)); if (!m) throw new Error(pid); return m[1].replace(/^> ?/gm, "").trim(); };
  const loaded = loadEvalSet(join(realRepo, DEFAULT_SET_PATH));
  assert.equal(loaded.status, "ok", loaded.reasons.join("、"));
  assert.equal(loaded.set.id, "dev-p1-p10");
  assert.equal(loaded.set.source.document, "workspace/mvp/m1/grammar-trial/stage1-patterns.md");
  assert.deepEqual(loaded.items.map((it) => it.id), Array.from({ length: 10 }, (_, i) => `P${i + 1}`));
  for (const it of loaded.items) {
    const expected = reqOf(it.id) + "\n";
    assert.equal(sha256(it.requestText + "\n"), sha256(expected), `${it.id} の依頼文の指紋`);
    assert.equal(it.subject, SUBJECT_OF[it.id], `${it.id} の題材`);
    assert.equal(it.style, STYLE_OF[it.id], `${it.id} の書き方`);
    assert.equal(it.writable, WRITABLE_OF[it.subject], `${it.id} の書ける範囲`);
    assert.equal(it.scoring, `../subjects/${it.subject}.json`);
    assert.equal(it.script, `scripts/${it.subject}.json`);
    const def = JSON.parse(readFileSync(it.scoringPath, "utf8"));
    assert.ok(def.patterns.includes(it.id), `${it.id} は採点の定義 ${it.subject} の patterns にある`);
  }
  assert.deepEqual(loaded.subjects, ["A", "B", "C", "D", "E"]);
});

// ── #497：Plan だけ・台本・凍結した組から Build だけ（README §5.7）

const MARK = "leak-marker-text";
const ENVELOPE_SCHEMA = "musunest-factory/plan-only-result/v1";
const reqText = (pid) => requestLines(Number(pid.slice(1))).join("\n") + "\n";
const ENV_CONDITIONS = { model: "fake-model", effort: "high", budget_usd: 0.3, deadline_ms: 600000, timeout_ms: null, vocabulary_version: "v1", prompt_version: "v1", contract_version: "v0.2", factory_version: "0.0.0", spec_engine_version: "0.0.0" };
/** 合成した確定の包み（偽物の検査と同じ SHA の取り方） */
function envelopeOf(pid, { plan = { plan_id: `plan-${pid}`, vocabulary_version: "v1", body: [`spec ${pid}`] }, source = reqText(pid), ...fields } = {}) {
  return { schema_version: ENVELOPE_SCHEMA, outcome: "confirmed", plan, plan_sha256: plan === null ? null : sha256(JSON.stringify(plan)), source_sha256: sha256(source), conditions: ENV_CONDITIONS, stop: null, ...fields };
}
/** 合成した凍結の組（envelopes：P → 包みの写像かバイト列。adopted：P → 採用の欄の上書き） */
function writeFrozen(dir, repo, { envelopes, missing = [], version = 1, origin = "frozen-plan", author, setSha, adopted = {} }) {
  mkdirSync(join(dir, "envelopes"), { recursive: true });
  const entries = Object.entries(envelopes).map(([pid, env]) => {
    const bytes = Buffer.isBuffer(env) ? env : Buffer.from(JSON.stringify(env));
    writeFileSync(join(dir, "envelopes", `${pid}.json`), bytes);
    return { pattern: pid, run: null, started_at: null, envelope: { path: `envelopes/${pid}.json`, sha256: sha256(bytes) }, plan_sha256: env.plan_sha256 ?? "x", source_sha256: env.source_sha256 ?? "x", ...(adopted[pid] ?? {}) };
  });
  const set = { schema: "musunest-eval/frozen-plan-set/v1", id: "fz-t", version, origin, ...(author ? { author } : {}), rule: null, set: { path: DEFAULT_SET_PATH, sha256: setSha ?? sha256(readFileSync(join(repo, DEFAULT_SET_PATH))), id: "dev-p1-p10", version: 1 }, source_measurement: null, adopted: entries, missing: missing.map((pattern) => ({ pattern, runs: 1 })) };
  const path = join(dir, "frozen-plan-set.json");
  writeFileSync(path, JSON.stringify(set, null, 1));
  return path;
}
/** 出力先のファイルの一覧とバイト列（再開の断りで、何も変わらず何も増えないことを確かめる） */
const snapshot = (root) => { const out = {}; const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(root, f)] = readFileSync(f).toString("base64"); } }; walk(root); return out; };
/** 拒否：exit 3・期待した符号・追加の子 0 本 */
function assertRefused(r, code, log, spawned, label = code) {
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.equal(spawnCount(log), spawned, `${label}: 子を起こした`);
}
/** 新しい計測の起動前の断り：条件のファイル・本のディレクトリ・起動の記録が無い */
const assertNothingWritten = (out, label) => assert.ok(!existsSync(out) || readdirSync(out).length === 0, `${label}: 出力先に書いた`);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const runRecords = (out) => readdirSync(out).filter((n) => /^run-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

test("(a) 指定なしと --plan：子の引数と答えのファイルは今までと同じ。条件は v4 で params.mode が build／e2e、frozen が null、scripts.mode が post-hoc。起動の記録に started_at と exit_class", async () => {
  await withRepo(async (base, repo) => {
    for (const [flags, mode] of [[[], "build"], [["--plan"], "e2e"]]) {
      const out = join(base, `out-a-${mode}`);
      const before = Date.now();
      const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", ...flags]);
      assert.equal(r.status, 0, r.stderr);
      const dir = join(out, "P1-r1");
      const expected = [join(repo, "packages/factory/dist/cli.js"), join(dir, "request.md"), "--out", join(dir, "bundle"), "--effort", "high", "--model", "fake-model", "--budget", "0.3", "--deadline", "10", ...(mode === "e2e" ? ["--plan", "--answers", join(dir, "answers.json")] : [])];
      assert.deepEqual(readJson(join(dir, "received-argv.json")), expected, mode);
      assert.equal(existsSync(join(dir, "answers.json")), mode === "e2e");
      if (mode === "e2e") assert.equal(readFileSync(join(dir, "answers.json"), "utf8"), "{}\n");
      const cond = readJson(join(out, "conditions.json"));
      assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v4");
      assert.equal(cond.params.mode, mode);
      assert.equal(cond.frozen, null);
      assert.equal(cond.scripts.mode, "post-hoc");
      assert.equal(cond.params.plan, mode === "e2e");
      assert.equal(cond.params.answers_mode, mode === "e2e" ? "recommended" : "none");
      assert.deepEqual([cond.params.effort, cond.params.model, cond.params.runs, cond.params.concurrency, cond.params.budget_usd, cond.params.factory_budget_usd, cond.params.factory_deadline_min], ["high", "fake-model", 1, 3, 15, 0.3, 10]);
      assert.deepEqual(cond.child_args, [{ id: "P1-r1", argv: expected }]);
      const sl = readJson(join(dir, "summary.line.json"));
      assert.equal(sl.exit_class, "ok");
      assert.match(sl.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(Date.parse(sl.started_at) >= before - 1 && Date.parse(sl.started_at) <= Number(readFileSync(join(dir, "received-start.json"), "utf8")), "子を起こす前の時刻");
      assert.deepEqual(Object.keys(sl.stderr_tail), ["bytes", "known_lines"]);
      assert.equal(sl.stdout_tail, undefined, "要約があれば今までどおり出さない");
      const rec = readJson(join(out, runRecords(out)[0]));
      assert.equal(rec.exit_classes.ok, 1);
      assert.equal(Object.values(rec.exit_classes).reduce((a, b) => a + b, 0), 1);
    }
  });
});

test("(b) v3 の条件のファイルの計測の --resume を resume:signature で断り、既存のファイルを変えず新しいファイルも作らない", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-b.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-b");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    // v3 の形（#427）：params.mode と frozen が無く schema は v3。署名は started_at・scoring・scripts・params.budget_usd を除いた全部
    const v4 = readJson(join(out, "conditions.json"));
    const { started_at: _t, signature: _sig, scoring, scripts, frozen: _f, ...generation } = v4;
    const { mode: _m, ...paramsV3 } = v4.params;
    const measured = { ...generation, schema: "musunest-factory/agent-accept-conditions/v3", params: paramsV3 };
    const { budget_usd: _b, ...params } = paramsV3;
    writeFileSync(join(out, "conditions.json"), JSON.stringify({ ...measured, scoring, scripts, started_at: v4.started_at, signature: sha256(JSON.stringify({ ...measured, params })) }, null, 1));
    const before = snapshot(out);
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assertRefused(resumed, "resume:signature", log, 2);
    assert.match(resumed.stderr, /保存した条件と今の条件が一致しません/);
    assert.deepEqual(snapshot(out), before);
  });
});

test("(c) --plan-only の子は --plan-only --answers を受け、--plan-only --script と --plan --script の子は --script <写し> を受ける（写しの SHA-256 は条件の台本の指紋の元）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-c-po");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1", "--plan-only"]).status, 0);
    const dir = join(out, "P1-r1");
    const got = readJson(join(dir, "received-argv.json"));
    assert.ok(got.includes("--plan-only") && !got.includes("--plan") && !got.includes("--script"));
    assert.deepEqual(got.slice(got.indexOf("--plan-only")), ["--plan-only", "--answers", join(dir, "answers.json")]);
    assert.equal(readFileSync(join(dir, "answers.json"), "utf8"), "{}\n");
    const cond = readJson(join(out, "conditions.json"));
    assert.deepEqual([cond.params.mode, cond.params.answers_mode, cond.params.plan, cond.scripts.mode, cond.frozen], ["plan-only", "recommended", false, "post-hoc", null]);
    for (const [flag, mode] of [["--plan-only", "plan-only"], ["--plan", "e2e"]]) {
      const outS = join(base, `out-c-${mode}`);
      const r = runAgent(repo, outS, ["--only", "P1,P3", "--runs", "1", flag, "--script"]);
      assert.equal(r.status, 0, r.stderr);
      const condS = readJson(join(outS, "conditions.json"));
      assert.deepEqual([condS.params.mode, condS.params.answers_mode, condS.scripts.mode], [mode, "script", "live"]);
      for (const [pid, subject] of [["P1", "A"], ["P3", "B"]]) {
        const d = join(outS, `${pid}-r1`);
        const argv = readJson(join(d, "received-argv.json"));
        assert.deepEqual(argv.slice(argv.indexOf(flag)), [flag, "--script", join(d, "script.json")], `${mode} ${pid}`);
        assert.ok(!argv.includes("--answers"));
        assert.equal(existsSync(join(d, "answers.json")), false);
        assert.equal(sha256(readFileSync(join(d, "script.json"))), condS.scripts.files.find((f) => f.subject === subject).sha256);
        assert.deepEqual(condS.child_args.find((c) => c.id === `${pid}-r1`).argv, argv);
      }
    }
  });
});

test("(d) 署名：live の計測で台本の答えを 1 つ変えた --resume と、組の版を変えた --build-from の --resume を断る。post-hoc の計測で台本を変えた --resume は通る", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-d.log");
    const scriptA = join(repo, "workspace/mvp/m1/agent/eval/sets/scripts/A.json");
    const entry = (choose) => ({ id: "e1", facet: null, keys: ["件"], answer: { choose: [choose] }, basis: "b" });
    writeFileSync(scriptA, JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "A", version: 1, entries: [entry("一")] }));
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    let spawned = 0;
    // live：答えを 1 つ変える（形は正しいまま）と署名が変わる
    const out = join(base, "out-d-live");
    assert.equal(runAgent(repo, out, [...args, "--plan-only", "--script"], { FAKE_SPAWN_LOG: log }).status, 0);
    spawned += 2;
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    writeFileSync(scriptA, JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "A", version: 1, entries: [entry("二")] }));
    assert.equal(loadEvalSet(join(repo, DEFAULT_SET_PATH)).status, "ok");
    const before = snapshot(out);
    assertRefused(runAgent(repo, out, [...args, "--plan-only", "--script", "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, spawned, "live");
    assert.deepEqual(snapshot(out), before);
    // post-hoc：台本を変えても今までどおり再開できる
    const outP = join(base, "out-d-posthoc");
    assert.equal(runAgent(repo, outP, [...args, "--plan-only"], { FAKE_SPAWN_LOG: log }).status, 0);
    spawned += 2;
    rmSync(join(outP, "P2-r1"), { recursive: true, force: true });
    writeFileSync(scriptA, JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "A", version: 1, entries: [entry("三")] }));
    const resumedP = runAgent(repo, outP, [...args, "--plan-only", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumedP.status, 0, resumedP.stderr);
    spawned += 1;
    assert.equal(spawnCount(log), spawned);
    // --build-from：組の版の数だけを変える（事前の検査は通る）と署名が変わる
    const fzDir = join(base, "fz-d");
    const fzArgs = (path) => ["--runs", "1", "--concurrency", "1", "--build-from", path];
    const path = writeFrozen(fzDir, repo, { envelopes: { P1: envelopeOf("P1"), P2: envelopeOf("P2") }, version: 1 });
    const outB = join(base, "out-d-build");
    assert.equal(runAgent(repo, outB, fzArgs(path), { FAKE_SPAWN_LOG: log }).status, 0);
    spawned += 2;
    rmSync(join(outB, "P2-r1"), { recursive: true, force: true });
    rmSync(fzDir, { recursive: true, force: true });
    writeFrozen(fzDir, repo, { envelopes: { P1: envelopeOf("P1"), P2: envelopeOf("P2") }, version: 2 });
    const beforeB = snapshot(outB);
    assertRefused(runAgent(repo, outB, [...fzArgs(path), "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, spawned, "build-from");
    assert.deepEqual(snapshot(outB), beforeB);
    // 同じ組なら再開できる（事前の検査はもう一度行う）
    rmSync(fzDir, { recursive: true, force: true });
    writeFrozen(fzDir, repo, { envelopes: { P1: envelopeOf("P1"), P2: envelopeOf("P2") }, version: 1 });
    const again = runAgent(repo, outB, [...fzArgs(path), "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(spawnCount(log), spawned + 1);
  });
});

test("(e) 組めない指定の組を flags:conflict、台本の無い本の --script を script:missing で断り、出力先に何も書かない", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-e.log");
    const fz = writeFrozen(join(base, "fz-e"), repo, { envelopes: { P1: envelopeOf("P1") } });
    const cases = [["--plan", "--plan-only"], ["--build-from", fz, "--plan"], ["--build-from", fz, "--plan-only"], ["--build-from", fz, "--script"], ["--script"], ["--build-from"]];
    cases.forEach((flags, i) => {
      const out = join(base, `out-e-${i}`);
      assertRefused(runAgent(repo, out, ["--only", "P1", "--runs", "1", ...flags], { FAKE_SPAWN_LOG: log }), "flags:conflict", log, 0, flags.join(" "));
      assertNothingWritten(out, flags.join(" "));
    });
    const setPath = join(base, "custom/no-script.json");
    mkdirSync(dirname(setPath), { recursive: true });
    writeFileSync(setPath, JSON.stringify({ ...makeSet(), items: makeSet().items.map((it) => ({ ...it, scoring: join(repo, "workspace/mvp/m1/agent/eval", it.scoring.slice(3)), script: it.subject === "B" ? null : join(repo, "workspace/mvp/m1/agent/eval/sets", it.script) })) }));
    for (const flag of ["--plan", "--plan-only"]) {
      const out = join(base, `out-e-script${flag}`);
      const r = runAgent(repo, out, ["--only", "P1,P3", "--runs", "1", flag, "--script", "--set", setPath], { FAKE_SPAWN_LOG: log });
      assertRefused(r, "script:missing", log, 0, flag);
      assert.match(r.stderr, /ids=P3 count=1/);
      assertNothingWritten(out, flag);
    }
    // 台本のある本だけなら流せる
    assert.equal(runAgent(repo, join(base, "out-e-ok"), ["--only", "P1", "--runs", "1", "--plan", "--script", "--set", setPath], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 1);
  });
});

test("(f) --build-from の対象は採用した P × 回数（子 6 本・patterns と照合の予定もそろう）。--only は採用の部分集合だけ。外した P と、どこにも無い P は別の符号で断る", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-f.log");
    const envs = { P1: envelopeOf("P1"), P3: envelopeOf("P3") };
    const fz = writeFrozen(join(base, "fz-f"), repo, { envelopes: envs, missing: ["P2"] });
    const out = join(base, "out-f");
    const r = runAgent(repo, out, ["--runs", "3", "--build-from", fz], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log), 6);
    const cond = readJson(join(out, "conditions.json"));
    assert.deepEqual(cond.params.patterns, ["P1", "P3"]);
    assert.equal(cond.params.mode, "build-from");
    assert.equal(cond.params.answers_mode, "none");
    assert.deepEqual(cond.child_args.map((c) => c.id), ["P1-r1", "P1-r2", "P1-r3", "P3-r1", "P3-r2", "P3-r3"]);
    const c = reconcile(out);
    assert.equal(c.status, "complete");
    assert.equal(c.planned, 6);
    const fzBytes = readFileSync(fz);
    assert.deepEqual({ ...cond.frozen, path: null }, { path: null, sha256: sha256(fzBytes), id: "fz-t", version: 1, origin: "frozen-plan", author: null, adopted: ["P1", "P3"].map((p) => ({ pattern: p, plan_sha256: envs[p].plan_sha256, source_sha256: envs[p].source_sha256, envelope_sha256: sha256(Buffer.from(JSON.stringify(envs[p]))) })), missing: ["P2"] });
    assert.ok(!JSON.stringify(cond).includes("spec P1"), "仕様の本体を条件に写さない");
    for (const id of ["P1-r2", "P3-r3"]) {
      const d = join(out, id);
      const argv = readJson(join(d, "received-argv.json"));
      assert.deepEqual(argv.slice(argv.indexOf("--deadline") + 2), ["--plan-file", join(d, "plan-file.json")]);
      assert.ok(!argv.includes("--answers") && !argv.includes("--plan") && !argv.includes("--plan-only"));
      assert.deepEqual(readFileSync(join(d, "plan-file.json")), Buffer.from(JSON.stringify(envs[id.split("-")[0]])));
    }
    const outOnly = join(base, "out-f-only");
    assert.equal(runAgent(repo, outOnly, ["--runs", "3", "--only", "P3", "--build-from", fz], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 9);
    assert.deepEqual(readJson(join(outOnly, "conditions.json")).params.patterns, ["P3"]);
    for (const [only, code] of [["P2", "build-from:excluded-p"], ["P1,P2", "build-from:excluded-p"], ["P99", "build-from:unknown-p"], ["P4", "build-from:not-adopted"]]) {
      const o = join(base, `out-f-${only}`);
      assertRefused(runAgent(repo, o, ["--runs", "3", "--only", only, "--build-from", fz], { FAKE_SPAWN_LOG: log }), code, log, 9, only);
      assertNothingWritten(o, only);
    }
  });
});

test("(g) --build-from の事前の検査：写し・包み・組・定義ファイルの食い違いを 1 つずつ断り、人の包み（conditions が null・出どころ human）は通す", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-g.log");
    const otherSource = "別の依頼文\n";
    const { conditions: _c, ...noConditions } = envelopeOf("P1");
    const { stop: _s, ...noStop } = envelopeOf("P1");
    const cases = [
      ["copy-sha", { envelopes: { P1: envelopeOf("P1") }, adopted: { P1: { envelope: { path: "envelopes/P1.json", sha256: "0".repeat(64) } } } }, "build-from:envelope-sha256"],
      ["version", { envelopes: { P1: envelopeOf("P1", { schema_version: "musunest-factory/plan-only-result/v0" }) } }, "build-from:envelope-rejected:envelope-version"],
      ["not-confirmed", { envelopes: { P1: envelopeOf("P1", { outcome: "cannot-confirm", plan: null, stop: { kind: "cannot-confirm", reason: null, codes: ["c"] } }) } }, "build-from:envelope-rejected:outcome"],
      ["plan-sha", { envelopes: { P1: envelopeOf("P1", { plan_sha256: "0".repeat(64) }) } }, "build-from:envelope-rejected:plan-sha256"],
      ["stale", { envelopes: { P1: envelopeOf("P1", { plan: { plan_id: "p", vocabulary_version: "v1", stale: true } }) } }, "build-from:envelope-rejected:plan"],
      ["vocabulary", { envelopes: { P1: envelopeOf("P1", { plan: { plan_id: "p", vocabulary_version: "v0" } }) } }, "build-from:envelope-rejected:vocabulary"],
      ["own-source", { envelopes: { P1: envelopeOf("P1", { source: otherSource }) } }, "build-from:envelope-rejected:source-sha256"],
      ["set-source", { envelopes: { P1: envelopeOf("P1") }, adopted: { P1: { source_sha256: sha256(otherSource) } } }, "build-from:source-sha256"],
      ["set-plan", { envelopes: { P1: envelopeOf("P1") }, adopted: { P1: { plan_sha256: "0".repeat(64) } } }, "build-from:plan-sha256"],
      ["set-file", { envelopes: { P1: envelopeOf("P1") }, setSha: "0".repeat(64) }, "build-from:set-sha256"],
      ["no-conditions", { envelopes: { P1: noConditions } }, "build-from:envelope-unreadable:plan-file-required"],
      ["bad-conditions", { envelopes: { P1: envelopeOf("P1", { conditions: "high" }) } }, "build-from:envelope-unreadable:plan-file-type"],
      ["no-stop", { envelopes: { P1: noStop } }, "build-from:envelope-unreadable:plan-file-required"],
      ["bad-stop", { envelopes: { P1: envelopeOf("P1", { stop: 1 }) } }, "build-from:envelope-unreadable:plan-file-type"],
      ["nested-stop", { envelopes: { P1: envelopeOf("P1", { stop: { kind: "stopped", reason: null } }) } }, "build-from:envelope-unreadable:plan-file-required"],
    ];
    for (const [name, spec, code] of cases) {
      const fz = writeFrozen(join(base, `fz-g-${name}`), repo, spec);
      const out = join(base, `out-g-${name}`);
      const r = runAgent(repo, out, ["--runs", "1", "--build-from", fz], { FAKE_SPAWN_LOG: log });
      assertRefused(r, code, log, 0, name);
      assert.match(r.stderr, new RegExp(`\\[${code}\\]( ids=P1 count=1)?$`, "m"), name);
      assertNothingWritten(out, name);
    }
    // 組のファイルが無い・形が違う
    assertRefused(runAgent(repo, join(base, "out-g-none"), ["--runs", "1", "--build-from", join(base, "none.json")], { FAKE_SPAWN_LOG: log }), "build-from:frozen-missing", log, 0);
    writeFileSync(join(base, "bad-fz.json"), JSON.stringify({ schema: "musunest-eval/frozen-plan-set/v1" }));
    assertRefused(runAgent(repo, join(base, "out-g-bad"), ["--runs", "1", "--build-from", join(base, "bad-fz.json")], { FAKE_SPAWN_LOG: log }), "build-from:frozen-invalid", log, 0);
    // 人の包み：conditions が null、出どころ human・作った人の印 owner
    const human = writeFrozen(join(base, "fz-g-human"), repo, { envelopes: { P1: envelopeOf("P1", { conditions: null }) }, origin: "human", author: "owner" });
    const outH = join(base, "out-g-human");
    const rh = runAgent(repo, outH, ["--runs", "1", "--build-from", human], { FAKE_SPAWN_LOG: log });
    assert.equal(rh.status, 0, rh.stderr);
    assert.equal(spawnCount(log), 1);
    assert.deepEqual([readJson(join(outH, "conditions.json")).frozen.origin, readJson(join(outH, "conditions.json")).frozen.author], ["human", "owner"]);
    // 作った人の印の無い人の組は形が違う
    const noAuthor = writeFrozen(join(base, "fz-g-noauthor"), repo, { envelopes: { P1: envelopeOf("P1", { conditions: null }) }, origin: "human" });
    assertRefused(runAgent(repo, join(base, "out-g-noauthor"), ["--runs", "1", "--build-from", noAuthor], { FAKE_SPAWN_LOG: log }), "build-from:frozen-invalid", log, 1);
  });
});

test("(i) exit 2 は標準出力の行で envelope-unreadable・envelope-rejected・usage-other に分かれ、計測は最後まで流れて起動の記録の件数が合う", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-i.log");
    const fz = writeFrozen(join(base, "fz-i"), repo, { envelopes: { P1: envelopeOf("P1"), P2: envelopeOf("P2"), P3: envelopeOf("P3"), P4: envelopeOf("P4"), P5: envelopeOf("P5") } });
    const lines = {
      "P1-r1": [JSON.stringify({ schema_version: "musunest-factory/plan-file-error/v1", code: "plan-file-json" })],
      "P2-r1": [JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "plan", codes: ["x"] })],
      "P3-r1": ["使い方の誤り: 何か", JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: "unknown-check", codes: [] })],
      "P4-r1": [JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "full", provider_cost_usd: 0.1 })],
      "P5-r1": [JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "partial", provider_cost_usd: 0.1 })],
    };
    const exits = { "P1-r1": 2, "P2-r1": 2, "P3-r1": 2, "P4-r1": 3, "P5-r1": 0 };
    const out = join(base, "out-i");
    const r = runAgent(repo, out, ["--runs", "1", "--concurrency", "1", "--build-from", fz], { FAKE_SPAWN_LOG: log, FAKE_LINES: JSON.stringify(lines), FAKE_EXIT_MAP: JSON.stringify(exits) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log), 5);
    const classes = Object.fromEntries(["P1", "P2", "P3", "P4", "P5"].map((p) => [p, readJson(join(out, `${p}-r1`, "summary.line.json")).exit_class]));
    assert.deepEqual(classes, { P1: "envelope-unreadable", P2: "envelope-rejected", P3: "usage-other", P4: "return-to-plan", P5: "ok" });
    const sl1 = readJson(join(out, "P1-r1", "summary.line.json"));
    assert.deepEqual(sl1.stdout_tail, { bytes: Buffer.byteLength(lines["P1-r1"][0] + "\n"), known_lines: 1 });
    const rec = readJson(join(out, runRecords(out)[0]));
    assert.deepEqual(rec.exit_classes, { ok: 1, failed: 0, "return-to-plan": 1, "envelope-unreadable": 1, "envelope-rejected": 1, "usage-other": 1, other: 0 });
    assert.deepEqual(rec.executed, ["P1-r1", "P2-r1", "P3-r1", "P4-r1", "P5-r1"]);
    assert.equal(reconcile(out).status, "complete");
  });
});

test("(j) 基準の値（--effort high --deadline-min 20 --factory-budget-usd 0.30）を渡すと、子の引数と条件の params がその値に一致する", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-j");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--plan-only", "--effort", "high", "--deadline-min", "20", "--factory-budget-usd", "0.30"]);
    assert.equal(r.status, 0, r.stderr);
    const argv = readJson(join(out, "P1-r1", "received-argv.json"));
    const val = (f) => argv[argv.indexOf(f) + 1];
    assert.deepEqual([val("--effort"), val("--deadline"), val("--budget")], ["high", "20", "0.3"]);
    const p = readJson(join(out, "conditions.json")).params;
    assert.deepEqual([p.effort, p.factory_deadline_min, p.factory_budget_usd], ["high", 20, 0.3]);
  });
});

test("(l) 漏えい：目印を依頼文・答え（台本）・包みの止まり方の符号と仕様・検査の message・子の出力に入れても、成功・拒否・読み取りの失敗のどれでも記録と道具の出力に出ない（生のログには残る）", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-l.log");
    const ev = join(repo, "workspace/mvp/m1/agent/eval");
    writeFileSync(join(ev, "sets/scripts/A.json"), JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "A", version: 1, entries: [{ id: "e1", facet: null, keys: [MARK], answer: { choose: [MARK] }, basis: MARK }] }));
    const markedLines = (p) => [`依頼 P${p} の行 1 ${MARK}`, `依頼 P${p} の行 2`];
    writeFileSync(join(repo, DEFAULT_SET_PATH), JSON.stringify(makeSet({ items: makeSet().items.map((it) => ({ ...it, request: markedLines(Number(it.id.slice(1))) })) })));
    const childLines = (id) => [JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: MARK, provider_cost_usd: 0 }), JSON.stringify({ schema_version: "musunest-factory/plan-file-reject/v1", check: MARK, codes: [MARK] }), `${MARK} ${id}`];
    const env = (ids) => ({ FAKE_SPAWN_LOG: log, FAKE_MARK: MARK, FAKE_LINES: JSON.stringify(Object.fromEntries(ids.map((id) => [id, childLines(id)]))) });
    const noMark = (label, ...texts) => texts.forEach((t, i) => assert.ok(!String(t).includes(MARK), `${label}[${i}] に目印が出た`));
    const recordsOf = (out) => [readFileSync(join(out, "conditions.json"), "utf8"), ...readdirSync(out).filter((n) => /^(run|resume)-\d+\.json$/.test(n)).map((n) => readFileSync(join(out, n), "utf8")), ...readdirSync(out).filter((n) => /^P\d+-r\d+$/.test(n)).map((n) => readFileSync(join(out, n, "summary.line.json"), "utf8"))];
    // 成功（Plan だけ・台本・止まった本と確定した本を混ぜる。子は未知の verdict と未知の検査名の行を出し、exit 2 も混ぜる）
    const out = join(base, "out-l");
    const r = runAgent(repo, out, ["--only", "P1,P2", "--runs", "1", "--plan-only", "--script"], { ...env(["P1-r1", "P2-r1"]), FAKE_PLAN: JSON.stringify({ "P2-r1": "stopped" }), FAKE_EXIT_MAP: JSON.stringify({ "P1-r1": 2 }) });
    assert.equal(r.status, 0, r.stderr);
    noMark("success", r.stdout, r.stderr, ...recordsOf(out));
    assert.match(r.stdout, /verdict=unknown/);
    assert.equal(readJson(join(out, "P1-r1", "summary.line.json")).exit_class, "usage-other", "未知の検査名の行は envelope-rejected にしない");
    assert.ok(readFileSync(join(out, "P1-r1", "stdout.log"), "utf8").includes(MARK), "生の標準出力には残る");
    assert.ok(readFileSync(join(out, "P1-r1", "stderr.log"), "utf8").includes(MARK), "生の標準エラーには残る");
    assert.ok(readFileSync(join(out, "P2-r1", "bundle/plan-result.json"), "utf8").includes(MARK), "包みの止まり方の符号は生のまま");
    // 拒否：仕様の検査の message に目印（偽物の validatePlanFile が返す）
    const reqP1 = markedLines(1).join("\n") + "\n";
    const stale = writeFrozen(join(base, "fz-l-stale"), repo, { envelopes: { P1: envelopeOf("P1", { source: reqP1, plan: { plan_id: MARK, vocabulary_version: "v1", stale: true, body: [MARK] } }) } });
    const rs = runAgent(repo, join(base, "out-l-stale"), ["--runs", "1", "--build-from", stale], env([]));
    assertRefused(rs, "build-from:envelope-rejected:plan", log, 2, "stale");
    noMark("stale", rs.stdout, rs.stderr);
    // 読み取りの失敗：JSON でない包み（目印入り）
    const broken = writeFrozen(join(base, "fz-l-broken"), repo, { envelopes: { P1: Buffer.from(`{${MARK}`) } });
    const rb = runAgent(repo, join(base, "out-l-broken"), ["--runs", "1", "--build-from", broken], env([]));
    assertRefused(rb, "build-from:envelope-unreadable:plan-file-json", log, 2, "broken");
    noMark("broken", rb.stdout, rb.stderr);
    // 成功の --build-from（仕様の本体に目印。子は exit 2 と未知の行）：条件・記録に出ない。包みの写しには残る
    const okFz = writeFrozen(join(base, "fz-l-ok"), repo, { envelopes: { P1: envelopeOf("P1", { source: reqP1, plan: { plan_id: "p", vocabulary_version: "v1", body: [MARK] } }) } });
    const outB = join(base, "out-l-build");
    const rk = runAgent(repo, outB, ["--runs", "1", "--build-from", okFz], { ...env(["P1-r1"]), FAKE_EXIT_MAP: JSON.stringify({ "P1-r1": 2 }) });
    assert.equal(rk.status, 0, rk.stderr);
    noMark("build-from", rk.stdout, rk.stderr, ...recordsOf(outB));
    assert.ok(readFileSync(join(outB, "P1-r1", "plan-file.json"), "utf8").includes(MARK));
    assert.ok(readFileSync(join(outB, "P1-r1", "stdout.log"), "utf8").includes(MARK));
  });
});

// ── #497 の独立レビューの指摘 1〜3

const oneLine = (r, label) => assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: 標準エラーが 1 行でない: ${r.stderr}`);

test("指摘 1：既知の版の要約と費用の行でも、列挙した欄と型だけを記録に写す（問題の message・未知の分類・追加の欄の目印は出ない）", async () => {
  await withRepo(async (base, repo) => {
    const summaryLine = {
      schema_version: "commandagent.headless-summary/v1", verdict: "partial", stop_reason: MARK, stop_class: "unmet", provider_cost_usd: 0.12, duration_secs: 3, exit_code: 0, run_id: MARK, next_action: MARK, extra_field: MARK,
      failure: { stage: "write", kind: "unmet", code: MARK, problems: [{ field: MARK, message: MARK }, { field: "f", message: MARK }] },
      stages: [{ stage: "write", status: "failed", duration_ms: 5, calls: 1, failure_kind: "unmet", attempts: { started: 1, note: MARK, leakmarkertext: 1, not_started: { budget: 0, [MARK]: 1, leakmarkertext: 2 } }, retries: { shape: 2, leakmarkertext: 3 }, extra: MARK }, { stage: MARK, status: MARK, duration_ms: MARK }],
      arbitration: { upheld: 1, note: MARK, leakmarkertext: 4 },
    };
    const costLine = { schema_version: "musunest-factory/plan-build-cost/v1", plan_usd: 0.02, build_usd: 0.1, total_usd: 0.12, note: MARK };
    const out = join(base, "out-s1");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_LINES: JSON.stringify({ "P1-r1": [JSON.stringify(summaryLine), JSON.stringify(costLine)] }) });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(out, "P1-r1", "summary.line.json"), "utf8");
    assert.ok(!text.includes(MARK), "要約の記録に目印が出た");
    assert.ok(!text.includes("leakmarkertext"), "形の正しい未知の鍵が要約の記録に出た");
    assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK));
    const sl = JSON.parse(text);
    assert.deepEqual([sl.summary.verdict, sl.summary.stop_reason, sl.summary.stop_class, sl.summary.provider_cost_usd, sl.summary.duration_secs], ["partial", "unknown", "unmet", 0.12, 3]);
    assert.deepEqual(sl.summary.failure, { stage: "write", kind: "unmet", code: "present", problems: 2 });
    assert.deepEqual(sl.summary.stages[0], { stage: "write", operation: null, status: "failed", duration_ms: 5, calls: 1, missing_usage_calls: null, input_tokens: null, cached_input_tokens: null, cache_write_tokens: null, output_tokens: null, reasoning_tokens: null, attempts: { started: 1, responded: null, errors: null, cancelled_deadline: null, cancelled_timeout: null, not_started: { deadline: null, budget: 0, limit: null, timeout: null } }, retries: { communication: null, shape: 2, content: null }, failure_kind: "unmet" });
    assert.deepEqual([sl.summary.stages[1].stage, sl.summary.stages[1].status, sl.summary.stages[1].duration_ms], ["unknown", "unknown", null]);
    assert.deepEqual(sl.summary.arbitration, { upheld: 1, overturned: null, undecidable: null });
    assert.equal(sl.summary.run_id, undefined);
    assert.deepEqual(sl.plan_cost, { schema_version: "musunest-factory/plan-build-cost/v1", plan_usd: 0.02, build_usd: 0.1, total_usd: 0.12 });
    assert.match(r.stdout, /P1-r1 .*verdict=partial cost=0\.1200/);
    assert.ok(readFileSync(join(out, "P1-r1", "stdout.log"), "utf8").includes(MARK), "生のログには残る");
  });
});

test("指摘 2：既存の断り（--only・定義ファイル）は、改行と目印を含む入力の文字列・パス・組の ID を通さず、標準エラー 1 行で断る", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-s2.log");
    const out1 = join(base, "out-s2-only");
    const r1 = runAgent(repo, out1, ["--only", `P1,${MARK}\nX,P99`, "--runs", "1"], { FAKE_SPAWN_LOG: log });
    assertRefused(r1, "only:unknown", log, 0, "only");
    oneLine(r1, "only");
    assert.ok(!r1.stderr.includes(MARK));
    assert.match(r1.stderr, /--only に定義ファイル（dev-p1-p10）に無い ID があります: P99,形の違う ID 1 件/);
    assertNothingWritten(out1, "only");
    const markDir = join(base, `${MARK}`);
    const r2 = runAgent(repo, join(base, "out-s2-set"), ["--only", "P1", "--runs", "1", "--set", join(markDir, "none.json")], { FAKE_SPAWN_LOG: log });
    assertRefused(r2, "set:invalid", log, 0, "set");
    oneLine(r2, "set");
    assert.ok(!r2.stderr.includes(MARK) && !r2.stderr.includes(base), "パスを出さない");
    assert.match(r2.stderr, /定義ファイルが無い/);
    const setPath = join(base, "custom/marked-id.json");
    mkdirSync(dirname(setPath), { recursive: true });
    const ev = join(repo, "workspace/mvp/m1/agent/eval");
    // 組の ID は既知の値（sets/ の組）と一致するときだけ出す：改行入りも、形の正しい目印（leak-marker-text）も出さない
    for (const [i, id] of [`${MARK}\nx`, MARK].entries()) {
      writeFileSync(setPath, JSON.stringify({ schema: EVAL_SET_SCHEMA, id, version: 1, role: "regression", title: "t", styles: { S1: "s1" }, items: [{ id: "P1", subject: "A", style: "S1", writable: true, scoring: join(ev, "subjects/A.json"), script: null, request: ["行"] }] }));
      const outId = join(base, `out-s2-id-${i}`);
      const r3 = runAgent(repo, outId, ["--only", "P99", "--runs", "1", "--set", setPath], { FAKE_SPAWN_LOG: log });
      assertRefused(r3, "only:unknown", log, 0, `set-id-${i}`);
      oneLine(r3, `set-id-${i}`);
      assert.ok(!r3.stderr.includes(MARK), `set-id-${i}: 組の ID が出た`);
      assert.match(r3.stderr, /--only に定義ファイル（既知でない組）に無い ID があります: P99/);
      assertNothingWritten(outId, `set-id-${i}`);
    }
  });
});

test("指摘 3：在るが読めない包み（ディレクトリ）を、新しい計測でも再開でも build-from:envelope-read で断り、何も作らず既存のファイルも変えない", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-s3.log");
    const fzDir = join(base, "fz-s3");
    const fz = writeFrozen(fzDir, repo, { envelopes: { P1: envelopeOf("P1"), P2: envelopeOf("P2") } });
    const envPath = join(fzDir, "envelopes/P2.json");
    const asDir = () => { rmSync(envPath); mkdirSync(envPath); };
    const asFile = () => { rmSync(envPath, { recursive: true }); writeFileSync(envPath, JSON.stringify(envelopeOf("P2"))); };
    asDir();
    const fresh = join(base, "out-s3-fresh");
    const r = runAgent(repo, fresh, ["--runs", "1", "--build-from", fz], { FAKE_SPAWN_LOG: log });
    assertRefused(r, "build-from:envelope-read", log, 0, "fresh");
    oneLine(r, "fresh");
    assert.ok(!r.stderr.includes(base) && !/EISDIR/.test(r.stderr), "パスと例外を出さない");
    assert.match(r.stderr, /ids=P2 count=1$/m);
    assertNothingWritten(fresh, "fresh");
    asFile();
    const out = join(base, "out-s3-resume");
    assert.equal(runAgent(repo, out, ["--runs", "1", "--concurrency", "1", "--build-from", fz], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    asDir();
    const before = snapshot(out);
    const rr = runAgent(repo, out, ["--runs", "1", "--concurrency", "1", "--build-from", fz, "--resume"], { FAKE_SPAWN_LOG: log });
    assertRefused(rr, "build-from:envelope-read", log, 2, "resume");
    oneLine(rr, "resume");
    assert.deepEqual(snapshot(out), before);
    // 組のファイルそのものがディレクトリ：形が違う扱い
    const rd = runAgent(repo, join(base, "out-s3-fzdir"), ["--runs", "1", "--build-from", fzDir], { FAKE_SPAWN_LOG: log });
    assertRefused(rd, "build-from:frozen-invalid", log, 2, "frozen-dir");
    oneLine(rd, "frozen-dir");
  });
});
