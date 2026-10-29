// run-agent.mjs の試験（node --test。#400・#425・#427）。ネットワーク無し・API 無しで閉じる：
// 一時の偽物のリポジトリに、偽物の工場の入口（dist/cli.js）と抽象的な依頼文（定義ファイル sets/dev-p1-p10.json と、その出どころの表）を置き、run-agent を子プロセスで回す。
// 本物の定義ファイルの依頼文が今の表（stage1-patterns.md）と一致することは、このリポジトリの実物を読んで確かめる（最後の試験）。
// #497：Plan だけ・台本・凍結した組から Build だけの口、終了の分類、記録の無害化、拒否の符号（README §5.7）。凍結の道具そのものは freeze-plan-set.test.mjs
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_SET_PATH, EVAL_SET_SCHEMA, PLAN_SCRIPT_SCHEMA, loadEvalSet, reconcile, scoringFingerprint, scriptsFingerprint } from "./score-agent.mjs";
import { OFFICIAL_COMPARE, compareProfile, launchAllowed } from "./score-agent.mjs";
import { conditionsSignature } from "./score-agent.mjs";

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
// #771：Ollama に対応した工場の dist（ollama.js の既定のモデルと、cli.js の OLLAMA_API_KEY_ENV）
// #776：既定の表は段 → 値の上書きの 3 段。表を省いた dist・形の違う dist は別に組む
const FAKE_OLLAMA_LIMITS = 'export const OLLAMA_STAGE_OUTPUT_LIMITS = { "semantic-check": 32768, "decl-check": 32768, repair: 65536 };\n';
const fakeOllama = `export const DEFAULT_OLLAMA_MODEL = "fake-ollama-model";\n${FAKE_OLLAMA_LIMITS}`;
const FAKE_OLLAMA_KEY_ENV_EXPORT = 'export const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";\n';
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

/** 一時の偽物のリポジトリを作る。dist は src より後に書くので「作り直した」根拠が立つ。ollama を真にすると Ollama に対応した dist になる（#771）。ollamaLimits を偽にすると ollama.js が既定のモデルだけになる（#776） */
function makeRepo(base, { ollama = false, ollamaLimits = true } = {}) {
  const repo = join(base, "repo");
  mkdirSync(join(repo, "packages/factory/dist"), { recursive: true });
  mkdirSync(join(repo, "packages/factory/src"), { recursive: true });
  mkdirSync(join(repo, "workspace/mvp/m1/grammar-trial"), { recursive: true });
  writeFileSync(join(repo, "packages/factory/package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(repo, "packages/factory/src/index.ts"), "export {};\n");
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeCli + (ollama ? FAKE_OLLAMA_KEY_ENV_EXPORT : ""));
  writeFileSync(join(repo, "packages/factory/dist/cli-plan.js"), fakeCliPlan);
  writeFileSync(join(repo, "packages/factory/dist/openai.js"), fakeOpenai);
  if (ollama) writeFileSync(join(repo, "packages/factory/dist/ollama.js"), ollamaLimits ? fakeOllama : 'export const DEFAULT_OLLAMA_MODEL = "fake-ollama-model";\n');
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

/** 再開の断り：exit 3・期待した符号・出力先の一覧とバイト列が断る前と同じ（子の本数は呼ぶ側が確かめる。#497） */
function assertResumeRefused(r, code, out, before, label = code) {
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.deepEqual(treeOf(out), before, `${label}: 出力先が変わった`);
}
/** 新しい計測の断り：exit 3・期待した符号・出力先を作らない */
function assertFreshRefused(r, code, out, label = code) {
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, `${label}: 出力先に書いた`);
}

async function withRepo(fn, options = {}) {
  const base = mkdtempSync(join(tmpdir(), "run-agent-test-"));
  try { await fn(base, makeRepo(base, options)); } finally { rmSync(base, { recursive: true, force: true }); }
}

test("--provider を省いた計測の条件に provider の欄が無い（#771。ccdfcd7 と同じ）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-no-provider");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"]).status, 0);
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.equal("provider" in cond.params, false);
    assert.equal("provider_api_key_env" in cond.params, false);
    const received = JSON.parse(readFileSync(join(out, "P1-r1", "received-argv.json"), "utf8"));
    assert.equal(received.includes("--provider"), false);
  });
});

test("旧の checkout（Ollama に対応していない dist）は --provider ollama を子を起こす前に固定の理由で断る（#771）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-ollama-old");
    const log = join(base, "spawn-ollama-old.log");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--provider", "ollama"], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 3);
    assert.ok(r.stderr.includes("[provider:ollama-unavailable]"), r.stderr);
    assert.equal(spawnCount(log), 0);
    assert.ok(!existsSync(out) || readdirSync(out).length === 0);
  });
});

test("--provider の値の誤りは子を起こす前に断る（#771）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-provider-unknown");
    const log = join(base, "spawn-provider-unknown.log");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--provider", "nope"], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 3);
    assert.ok(r.stderr.includes("[provider:unknown]"), r.stderr);
    assert.equal(spawnCount(log), 0);
  });
});

test("Ollama に対応した checkout は、argv に provider と dist の既定モデルを渡し、条件に provider と鍵の名前だけを残す（#771）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-ollama");
    const keyValue = "ol-SECRET-MARK";
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--provider", "ollama"], { OLLAMA_API_KEY: keyValue });
    assert.equal(r.status, 0, r.stderr);
    const received = JSON.parse(readFileSync(join(out, "P1-r1", "received-argv.json"), "utf8"));
    const at = received.indexOf("--provider");
    assert.ok(at >= 0, "argv に --provider が無い");
    assert.equal(received[at + 1], "ollama");
    assert.equal(received[received.indexOf("--model") + 1], "fake-ollama-model");
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.equal(cond.params.provider, "ollama");
    assert.equal(cond.params.provider_api_key_env, "OLLAMA_API_KEY");
    // run-agent と score-agent が同じ署名の式で一致する
    assert.equal(conditionsSignature(cond), cond.signature);
    // 鍵の値は記録にも出力にも残らない
    assert.equal(readFileSync(join(out, "conditions.json"), "utf8").includes(keyValue), false);
    assert.equal(r.stdout.includes(keyValue), false);
    assert.equal(r.stderr.includes(keyValue), false);
  }, { ollama: true });
});

test("--provider openai を明示しても、鍵の環境変数とモデルは今のままで、provider の欄を足さない（#771 再レビュー。省略と同じ形）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-provider-openai");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1", "--provider", "openai"]).status, 0);
    const cond = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    assert.equal("provider" in cond.params, false);
    assert.equal("provider_api_key_env" in cond.params, false);
    assert.equal(cond.params.model, "fake-model");
    const received = JSON.parse(readFileSync(join(out, "P1-r1", "received-argv.json"), "utf8"));
    assert.equal(received.includes("--provider"), false);
    assert.equal(received[received.indexOf("--model") + 1], "fake-model");
  });
});

/**
 * #771 再レビュー：出力先の条件・署名・子の argv を集める（同じ出力先で省略と明示 openai を比べる）。
 * 除くのは時刻（条件と比較の記録の started_at）と、started_at を含む比較の記録の署名だけ。群の条件の署名（conditions_signature）は残す
 */
function conditionBytesOf(out) {
  const got = {};
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) { walk(f); continue; }
    const rel = relative(out, f);
    if (n === "received-argv.json") got[rel] = readFileSync(f, "utf8");
    else if (n === "conditions.json") { const { started_at: _t, ...rest } = readJson(f); got[rel] = JSON.stringify(rest); }
    else if (n === "comparison.json") { const { started_at: _t, signature: _s, ...rest } = readJson(f); got[rel] = JSON.stringify(rest); } } };
  walk(out);
  return got;
}
/** 同じ出力先へ、省略と --provider openai の明示を順に流し、集めた条件・署名・argv のバイト列を返す（間で出力先を消す） */
function omittedAndExplicit(repo, out, args, env = {}) {
  const r0 = runAgent(repo, out, args, env);
  assert.equal(r0.status, 0, r0.stderr);
  const omitted = conditionBytesOf(out);
  rmSync(out, { recursive: true, force: true });
  const r1 = runAgent(repo, out, [...args, "--provider", "openai"], env);
  assert.equal(r1.status, 0, r1.stderr);
  return { omitted, explicit: conditionBytesOf(out) };
}

test("#771 再レビュー：--provider openai の明示と省略は、通常・Plan だけ・Plan→Build・plan-file の Build で、条件の JSON・署名・子の argv がバイト列で同じ", async () => {
  await withRepo(async (base, repo) => {
    const fz = writeFrozen(join(base, "fz-openai"), repo, { envelopes: { P1: envelopeOf("P1"), P3: envelopeOf("P3") }, missing: ["P2"] });
    for (const [label, flags] of [["build", ["--only", "P1"]], ["plan-only", ["--only", "P1", "--plan-only"]], ["e2e", ["--only", "P1", "--plan"]], ["build-from", ["--build-from", fz]]]) {
      const out = join(base, `out-openai-${label}`);
      const { omitted, explicit } = omittedAndExplicit(repo, out, [...flags, "--runs", "1"]);
      assert.ok(Object.keys(omitted).some((k) => k.endsWith("received-argv.json")), `${label}: 子の argv が無い`);
      assert.deepEqual(explicit, omitted, label);
      const cond = readJson(join(out, "conditions.json"));
      assert.equal(cond.params.mode, label);
      assert.equal(conditionsSignature(cond), cond.signature, label);
      assert.equal(JSON.stringify(cond).includes('"provider'), false, `${label}: provider の欄がある`);
    }
  });
});

test("#771 再レビュー：比較で --provider openai の明示と省略は、両群の条件の JSON・署名・子の argv と、比較の記録の defaults・shared.params がバイト列で同じ", async () => {
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "openai-c"));
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-openai-c.json"), 1);
    const out = join(base, "out-openai-c");
    const { omitted, explicit } = omittedAndExplicit(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "5"]));
    for (const g of ["v1", "v1.1a"]) {
      assert.ok(join(g, "conditions.json") in omitted, g);
      assert.ok(join(g, "P1-r1", "received-argv.json") in omitted, g);
    }
    assert.ok("comparison.json" in omitted);
    assert.deepEqual(explicit, omitted);
    const rec = readJson(join(out, "comparison.json"));
    for (const g of ["v1", "v1.1a"]) {
      assert.equal("provider" in rec.groups[g].defaults, false, g);
      assert.equal(rec.groups[g].defaults.api_key_env, "OPENAI_API_KEY", g);
      const cond = readJson(join(out, g, "conditions.json"));
      assert.equal(conditionsSignature(cond), cond.signature, g);
      assert.equal(rec.groups[g].conditions_signature, cond.signature, g);
    }
    assert.deepEqual(Object.keys(rec.shared.params), ["effort", "model", "factory_budget_usd", "factory_deadline_min", "mode"]);
  });
});

test("同じ Ollama の条件の再開は通り、provider の変更は断る（#771）", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-ollama-resume");
    const log = join(base, "spawn-ollama-resume.log");
    const args = ["--only", "P1", "--runs", "1", "--concurrency", "1", "--provider", "ollama"];
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 1);
    rmSync(join(out, "P1-r1"), { recursive: true, force: true });
    // 同じ provider の再開は通る
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(spawnLines(log), ["P1-r1", "P1-r1"]);
    // provider を変えた再開は断る（署名が変わる）
    const before = treeOf(out);
    const changed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--concurrency", "1", "--provider", "openai", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(changed.status, 3);
    assert.ok(changed.stderr.includes("[resume:signature]"), changed.stderr);
    assert.deepEqual(treeOf(out), before);
  }, { ollama: true });
});

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
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v5");
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
    const beforeDoc = treeOf(out);
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    assertResumeRefused(resumed, "resume:signature", out, beforeDoc, "vocabulary");
    // 判定の口の構成：LLM だけで始めた計測を、Jev ありで再開することはできない
    const out2 = join(base, "out-judge");
    assert.equal(runAgent(repo, out2, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out2, "P2-r1"), { recursive: true, force: true });
    const beforeJudge = treeOf(out2);
    const resumed2 = runAgent(repo, out2, [...args, "--resume"], { FAKE_SPAWN_LOG: log, JEV_API_KEY: "x" });
    assert.notEqual(resumed2.status, 0);
    assert.match(resumed2.stderr, /条件/);
    assert.equal(spawnCount(log), 4);
    assertResumeRefused(resumed2, "resume:signature", out2, beforeJudge, "judge");
    // spec-engine の dist・契約・語彙の意味のそれぞれの変更も、署名に残るので再開を断る（変更は積み上がるが、新しい計測は毎回その時点の条件で始める）
    let spawned = 4;
    for (const [name, file] of [["spec-engine", "packages/spec-engine/dist/index.js"], ["contract", "packages/appspec-schema/contract/rules.md"], ["semantics", "packages/appspec-schema/docs/semantics.md"]]) {
      const outN = join(base, `out-${name}`);
      assert.equal(runAgent(repo, outN, args, { FAKE_SPAWN_LOG: log }).status, 0, name);
      spawned += 2;
      rmSync(join(outN, "P2-r1"), { recursive: true, force: true });
      appendFileSync(join(repo, file), "\n");
      const beforeN = treeOf(outN);
      const resumedN = runAgent(repo, outN, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
      assert.notEqual(resumedN.status, 0, name);
      assert.match(resumedN.stderr, /条件/, name);
      assert.equal(spawnCount(log), spawned, name);
      assertResumeRefused(resumedN, "resume:signature", outN, beforeN, name);
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
    const beforeV1 = treeOf(out);
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    assertResumeRefused(resumed, "resume:signature", out, beforeV1, "v1");
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
    const beforeV2 = treeOf(out);
    const resumed = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /保存した条件と今の条件が一致しません/);
    assert.equal(spawnCount(log), 2);
    assertResumeRefused(resumed, "resume:signature", out, beforeV2, "v2");
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
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v5");
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
    const beforeSet = treeOf(out2);
    const resumed = runAgent(repo, out2, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /条件/);
    assert.equal(spawnCount(log), 2);
    assertResumeRefused(resumed, "resume:signature", out2, beforeSet, "set");
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
      assertFreshRefused(r, "set:invalid", join(base, `out-${name}`), name);
    }
    assert.equal(spawnCount(log), 0);
    const missing = runAgent(repo, join(base, "out-missing"), ["--only", "P1", "--runs", "1", "--set", join(setDir, "none.json")], { FAKE_SPAWN_LOG: log });
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /定義ファイルが無い/);
    assertFreshRefused(missing, "set:invalid", join(base, "out-missing"), "missing");
    const unknownOnly = runAgent(repo, join(base, "out-only"), ["--only", "P1,P99", "--runs", "1"], { FAKE_SPAWN_LOG: log });
    assert.equal(unknownOnly.status, 3);
    assert.match(unknownOnly.stderr, /--only に定義ファイル（dev-p1-p10）に無い ID があります: P99/);
    assertFreshRefused(unknownOnly, "only:unknown", join(base, "out-only"), "only");
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
      assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v5");
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
    assertNothingWritten(join(base, "out-g-none"), "frozen-missing");
    writeFileSync(join(base, "bad-fz.json"), JSON.stringify({ schema: "musunest-eval/frozen-plan-set/v1" }));
    assertRefused(runAgent(repo, join(base, "out-g-bad"), ["--runs", "1", "--build-from", join(base, "bad-fz.json")], { FAKE_SPAWN_LOG: log }), "build-from:frozen-invalid", log, 0);
    assertNothingWritten(join(base, "out-g-bad"), "frozen-invalid");
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
    assertNothingWritten(join(base, "out-g-noauthor"), "no-author");
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
    assertNothingWritten(join(base, "out-l-stale"), "stale");
    noMark("stale", rs.stdout, rs.stderr);
    // 読み取りの失敗：JSON でない包み（目印入り）
    const broken = writeFrozen(join(base, "fz-l-broken"), repo, { envelopes: { P1: Buffer.from(`{${MARK}`) } });
    const rb = runAgent(repo, join(base, "out-l-broken"), ["--runs", "1", "--build-from", broken], env([]));
    assertRefused(rb, "build-from:envelope-unreadable:plan-file-json", log, 2, "broken");
    assertNothingWritten(join(base, "out-l-broken"), "broken");
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
    assertNothingWritten(join(base, "out-s2-set"), "set");
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
    assertNothingWritten(join(base, "out-s3-fzdir"), "frozen-dir");
    oneLine(rd, "frozen-dir");
  });
});

// ── #513：v1.1α の経路（--pipeline）・対のファイル（--make-pairs）・対にした交互の計測（--compare）。README の v1.1α の節

const V10_LIMITS = { surface: 32768, questions: 32768, requirements: 16384, "reverse-check": 8192, design: 32768, "test-suite": 32768, write: 32768, correspondence: 16384, repair: 32768, arbitration: 16384 };
const V14_LIMITS = { ...V10_LIMITS, "name-table": 32768, "semantic-check": 16384, "test-spec": 32768, "decl-check": 16384 };
const limitsJs = (table) => `export const DEFAULT_REASONING_EFFORT = "high";\nexport const STAGE_MAX_OUTPUT_TOKENS = { low: ${JSON.stringify(table)}, medium: ${JSON.stringify(table)}, high: ${JSON.stringify(table)} };\n`;
// 比較の偽物の工場の入口：群（本のディレクトリの親の名前）と本の ID を合わせた名前で、開始と終わりの時刻を FAKE_SPAWN_LOG に 1 行ずつ書く。
// FAKE_DELAY は「群/本」ごとの遅れ、FAKE_COST は 1 本の費用、FAKE_MARK は標準出力・標準エラーに入れる目印。受け取った引数と cwd を本のディレクトリに残す
const fakeCompareCli = ({ budget = 0.3, deadlineMs = 600000 } = {}) => String.raw`import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = ${budget};
export const DEFAULT_DEADLINE_MS = ${deadlineMs};
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
const map = (k) => { try { return JSON.parse(process.env[k] ?? "{}"); } catch { return {}; } };
if (isEntry()) {
  const start = Date.now();
  const outDir = process.argv[process.argv.indexOf("--out") + 1], runDir = dirname(outDir), id = basename(dirname(runDir)) + "/" + basename(runDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(runDir, "received-argv.json"), JSON.stringify(process.argv.slice(1)));
  writeFileSync(join(runDir, "received-cwd.json"), JSON.stringify(process.cwd()));
  const mark = process.env.FAKE_MARK ?? "";
  setTimeout(() => {
    if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ id, start, end: Date.now() }) + "\n");
    process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "partial", stop_reason: "completed", provider_cost_usd: Number(process.env.FAKE_COST ?? "0.25"), stages: [{ stage: "write", duration_ms: 1 }] }) + "\n");
    if (mark) { process.stdout.write(mark + "\n"); process.stderr.write(mark + "\n"); }
  }, Number(map("FAKE_DELAY")[id] ?? 0));
}
`;
/** 比較の偽物：候補（<repo>）と比較元の checkout（別の偽物のリポジトリ）。上限の表は候補が 14 段・比較元が 10 段。凍結した組は P1・P3 を採用 */
function makeCompare(base, { baselineName = "baseline-co", baselineCli = {}, candidateLimits = V14_LIMITS, baselineLimits = V10_LIMITS } = {}) {
  const repo = makeRepo(base);
  const baseline = makeRepo(join(base, baselineName));
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeCompareCli());
  writeFileSync(join(baseline, "packages/factory/dist/cli.js"), fakeCompareCli(baselineCli));
  writeFileSync(join(repo, "packages/factory/dist/limits.js"), limitsJs(candidateLimits));
  writeFileSync(join(baseline, "packages/factory/dist/limits.js"), limitsJs(baselineLimits));
  const fz = writeFrozen(join(base, "fz-c"), repo, { envelopes: { P1: envelopeOf("P1"), P3: envelopeOf("P3") }, missing: ["P2"] });
  return { repo, baseline, fz };
}
const compareLog = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const compareArgs = (c, pairs, extra = []) => ["--compare", "--baseline", c.baseline, "--pairs", pairs, "--build-from", c.fz, ...extra];
const writePairs = (path, value) => { writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1) + "\n"); return path; };
const makePairsFile = (repo, c, path, runs = 3) => { const r = runAgent(repo, join(dirname(path), "unused-out"), ["--make-pairs", path, "--build-from", c.fz, "--runs", String(runs)]); assert.equal(r.status, 0, r.stderr); return path; };
/** 比較の断り：exit 3・固定の符号 1 行・子 0 本・出力先に何も書かない */
function assertCompareRefused(r, code, log, out, label = code) {
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: 標準エラーが 1 行でない`);
  assert.equal(compareLog(log).length + spawnCount(log + ".plain"), 0, `${label}: 子を起こした`);
  assertNothingWritten(out, label);
}

/** #771（レビュー R1）：比較の両 checkout を Ollama に対応させる。比較元の公開値（鍵の環境変数の名前・既定のモデル）は別に与えられる。baselineOllama を偽にすると比較元は未対応 */
function makeOllamaCompare(base, { baselineOllama = true, baselineKeyEnv = "OLLAMA_API_KEY", baselineModel = "fake-ollama-model" } = {}) {
  const c = makeCompare(base);
  const keyEnvExport = (name) => `export const OLLAMA_API_KEY_ENV = ${JSON.stringify(name)};\n`;
  writeFileSync(join(c.repo, "packages/factory/dist/cli.js"), fakeCompareCli() + keyEnvExport("OLLAMA_API_KEY"));
  writeFileSync(join(c.repo, "packages/factory/dist/ollama.js"), fakeOllama);
  if (baselineOllama) {
    writeFileSync(join(c.baseline, "packages/factory/dist/cli.js"), fakeCompareCli() + keyEnvExport(baselineKeyEnv));
    writeFileSync(join(c.baseline, "packages/factory/dist/ollama.js"), `export const DEFAULT_OLLAMA_MODEL = ${JSON.stringify(baselineModel)};\n`);
  }
  return c;
}

test("#771 R1 比較 × --provider ollama：比較元の鍵の環境変数の名前・既定のモデルが候補と違えば、比較元の値で照らして compare:defaults-differ で断る（子 0 本・何も書かない）", async () => {
  await withRepo(async (base) => {
    for (const [label, opts] of [["key", { baselineKeyEnv: "BASE_OLLAMA_API_KEY" }], ["model", { baselineModel: "base-ollama-model" }]]) {
      const c = makeOllamaCompare(join(base, `r1-${label}`), opts);
      const pairs = makePairsFile(c.repo, c, join(base, `pairs-r1-${label}.json`), 1);
      const log = join(base, `spawn-r1-${label}.log`), out = join(base, `out-r1-${label}`);
      assertCompareRefused(runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "5", "--provider", "ollama"]), { FAKE_SPAWN_LOG: log }), "compare:defaults-differ", log, out, label);
    }
  });
});

test("#771 R1 比較 × --provider ollama：比較元だけ Ollama に対応していなければ provider:ollama-unavailable で断る（exit 3・子 0 本・何も書かない）", async () => {
  await withRepo(async (base) => {
    const c = makeOllamaCompare(join(base, "r1-old"), { baselineOllama: false });
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-r1-old.json"), 1);
    const log = join(base, "spawn-r1-old.log"), out = join(base, "out-r1-old");
    assertCompareRefused(runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "5", "--provider", "ollama"]), { FAKE_SPAWN_LOG: log }), "provider:ollama-unavailable", log, out);
  });
});

test("#771 R1 比較 × --provider ollama：両方が対応し公開値が同じなら、両群の子に provider と dist の既定モデルが渡り、各群の条件・既定・shared.params の provider と鍵の名前が一致する", async () => {
  await withRepo(async (base) => {
    const c = makeOllamaCompare(join(base, "r1-ok"));
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-r1-ok.json"), 1);
    const log = join(base, "spawn-r1-ok.log"), out = join(base, "out-r1-ok");
    const r = runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "5", "--provider", "ollama"]), { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(compareLog(log).length, 4);
    for (const g of ["v1", "v1.1a"]) {
      const argv = readJson(join(out, g, "P1-r1", "received-argv.json"));
      assert.equal(argv[argv.indexOf("--provider") + 1], "ollama", g);
      assert.equal(argv[argv.indexOf("--model") + 1], "fake-ollama-model", g);
      const cond = readJson(join(out, g, "conditions.json"));
      assert.deepEqual([cond.params.provider, cond.params.provider_api_key_env, cond.params.model], ["ollama", "OLLAMA_API_KEY", "fake-ollama-model"], g);
      assert.equal(conditionsSignature(cond), cond.signature, g);
    }
    const rec = readJson(join(out, "comparison.json"));
    for (const g of ["v1", "v1.1a"]) assert.deepEqual([rec.groups[g].defaults.provider, rec.groups[g].defaults.api_key_env, rec.groups[g].defaults.model_ollama], ["ollama", "OLLAMA_API_KEY", "fake-ollama-model"], g);
    assert.deepEqual([rec.shared.params.provider, rec.shared.params.provider_api_key_env, rec.shared.params.model], ["ollama", "OLLAMA_API_KEY", "fake-ollama-model"]);
  });
});

test("#513 (a) --pipeline：--build-from と v1.1a で子の引数の末尾が --pipeline v1.1a・schema v5・署名が省略時と異なる。省略と v1 は子の引数が今までと同じで署名も同じ。知らない値・組めない組は flags:conflict で子を起こさない", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-p.log");
    const fz = writeFrozen(join(base, "fz-p"), repo, { envelopes: { P1: envelopeOf("P1") } });
    const run = (name, extra) => { const out = join(base, name); const r = runAgent(repo, out, ["--runs", "1", "--build-from", fz, ...extra], { FAKE_SPAWN_LOG: log }); assert.equal(r.status, 0, r.stderr); return { out, cond: readJson(join(out, "conditions.json")), argv: readJson(join(out, "P1-r1", "received-argv.json")) }; };
    const omitted = run("out-p-omit", []), v1 = run("out-p-v1", ["--pipeline", "v1"]), v11a = run("out-p-v11a", ["--pipeline", "v1.1a"]);
    const dirO = join(omitted.out, "P1-r1");
    assert.deepEqual(omitted.argv, [join(repo, "packages/factory/dist/cli.js"), join(dirO, "request.md"), "--out", join(dirO, "bundle"), "--effort", "high", "--model", "fake-model", "--budget", "0.3", "--deadline", "10", "--plan-file", join(dirO, "plan-file.json")], "省略は今までと同じ引数");
    assert.deepEqual(v1.argv.map((a) => a.replace(v1.out, omitted.out)), omitted.argv, "--pipeline v1 は省略と同じ引数");
    assert.deepEqual(v11a.argv.slice(-2), ["--pipeline", "v1.1a"]);
    assert.deepEqual(v11a.argv.slice(0, -2).map((a) => a.replace(v11a.out, omitted.out)), omitted.argv, "ほかの引数は同じ");
    for (const x of [omitted, v1, v11a]) assert.equal(x.cond.schema, "musunest-factory/agent-accept-conditions/v5");
    assert.deepEqual([omitted.cond.params.pipeline, v1.cond.params.pipeline, v11a.cond.params.pipeline], ["v1", "v1", "v1.1a"]);
    assert.notEqual(v11a.cond.signature, omitted.cond.signature, "v1.1a は署名が違う");
    // 署名：省略で始めた計測は --pipeline v1 で再開でき（同じ署名）、--pipeline v1.1a では resume:signature で断る
    const outS = join(base, "out-p-sig"), sigArgs = ["--runs", "2", "--concurrency", "1", "--build-from", fz];
    assert.equal(runAgent(repo, outS, sigArgs, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(outS, "P1-r2"), { recursive: true, force: true });
    const beforeS = treeOf(outS), n0 = spawnCount(log);
    assertRefused(runAgent(repo, outS, [...sigArgs, "--pipeline", "v1.1a", "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n0, "v1.1a の再開");
    assert.deepEqual(treeOf(outS), beforeS);
    const rv1 = runAgent(repo, outS, [...sigArgs, "--pipeline", "v1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(rv1.status, 0, rv1.stderr);
    assert.equal(spawnCount(log), n0 + 1, "省略と v1 は同じ署名なので再開できる");
    assert.deepEqual(v11a.cond.child_args[0].argv, v11a.argv, "条件の子の引数は渡した引数");
    // 上限の欄：偽物の dist（1 段だけ）では v1 の欄はそのままの値、v1.1α の欄は null
    assert.deepEqual(omitted.cond.params.stage_output_limits, { requirements: 16384 });
    assert.equal(omitted.cond.params.stage_output_limits_v11a, null);
    // 組めない組と知らない値
    let spawned = spawnCount(log);
    for (const [label, extra] of [["no-build-from", ["--runs", "1", "--pipeline", "v1.1a"]], ["unknown", ["--runs", "1", "--build-from", fz, "--pipeline", "v2"]], ["empty", ["--runs", "1", "--build-from", fz, "--pipeline"]], ["flag-value", ["--runs", "1", "--pipeline", "--build-from", fz]], ["plan", ["--runs", "1", "--plan", "--pipeline", "v1.1a"]]]) {
      const o = join(base, `out-p-${label}`);
      assertRefused(runAgent(repo, o, extra, { FAKE_SPAWN_LOG: log }), "flags:conflict", log, spawned, label);
      assertNothingWritten(o, label);
    }
  });
});

test("#513 上限の欄：14 段の表を読むと、比較でない計測でも stage_output_limits は v1 の 10 段（表の並び）だけで、v1.1α の 4 段は stage_output_limits_v11a に入る", async () => {
  await withRepo(async (base, repo) => {
    writeFileSync(join(repo, "packages/factory/dist/limits.js"), limitsJs(V14_LIMITS));
    const out = join(base, "out-lim");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"]).status, 0);
    const p = readJson(join(out, "conditions.json")).params;
    assert.deepEqual(p.stage_output_limits, V10_LIMITS);
    assert.deepEqual(Object.keys(p.stage_output_limits), Object.keys(V10_LIMITS));
    assert.deepEqual(p.stage_output_limits_v11a, { "name-table": 32768, "semantic-check": 16384, "test-spec": 32768, "decl-check": 16384 });
  });
});

test("#513 (b) --make-pairs：採用 2 P × runs 3 で 6 対を交互の先行順で書き、frozen_sha256 は組のファイルの SHA。2 回で同じバイト列、子を起こさない。出力が既にあれば上書きしない", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-mp.log");
    const c = makeCompare(join(base, "mp"));
    const a = join(base, "pairs-a.json"), b = join(base, "pairs-b.json");
    for (const p of [a, b]) assert.equal(runAgent(c.repo, join(base, "unused"), ["--make-pairs", p, "--build-from", c.fz, "--runs", "3"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.deepEqual(readFileSync(a), readFileSync(b));
    const v = readJson(a);
    assert.deepEqual(v, {
      schema: "musunest-eval/compare-pairs/v1", frozen_sha256: sha256(readFileSync(c.fz)), groups: ["v1", "v1.1a"], runs: 3,
      pairs: [["P1", 1], ["P1", 2], ["P1", 3], ["P3", 1], ["P3", 2], ["P3", 3]].map(([pid, r], i) => ({ pid, r, first: i % 2 === 0 ? "v1" : "v1.1a" })),
    });
    assert.equal(spawnCount(log), 0);
    assert.equal(existsSync(join(base, "unused")), false, "出力先を作らない");
    const again = runAgent(c.repo, join(base, "unused"), ["--make-pairs", a, "--build-from", c.fz, "--runs", "3"], { FAKE_SPAWN_LOG: log });
    assert.equal(again.status, 3);
    assert.ok(again.stderr.includes("[compare:pairs-exists]"));
    assert.deepEqual(readFileSync(a), readFileSync(b));
    for (const extra of [["--make-pairs", join(base, "x.json")], ["--make-pairs", join(base, "x.json"), "--build-from", c.fz, "--compare"], ["--make-pairs", join(base, "x.json"), "--build-from", c.fz, "--runs", "0"], ["--make-pairs"]]) {
      const r = runAgent(c.repo, join(base, "unused"), extra, { FAKE_SPAWN_LOG: log });
      assert.equal(r.status, 3, extra.join(" "));
      assert.ok(r.stderr.includes("[flags:conflict]"), r.stderr);
      assert.equal(existsSync(join(base, "x.json")), false);
    }
  });
});

test("#513 (c) 対 6・遅れを与えた偽物で、子を起こす時刻の順が対の順 × 先行順の平らな並びと一致し、同時に走った子が 3（両群の合計）を超えない", async () => {
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "c"));
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-c.json"));
    const flat = readJson(pairs).pairs.flatMap((p) => [p.first, p.first === "v1" ? "v1.1a" : "v1"].map((g) => `${g}/${p.pid}-r${p.r}`));
    const delay = Object.fromEntries(flat.map((id, i) => [id, 120 + ((i * 7) % 5) * 90]));
    const log = join(base, "spawn-c.log"), out = join(base, "out-c");
    const r = runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "10"]), { FAKE_SPAWN_LOG: log, FAKE_DELAY: JSON.stringify(delay), FAKE_COST: "0.01" });
    assert.equal(r.status, 0, r.stderr);
    const started = flat.map((id) => Date.parse(readJson(join(out, id, "summary.line.json")).started_at));
    for (let i = 1; i < started.length; i++) assert.ok(started[i - 1] <= started[i], `起動の順が平らな並びと違う: ${flat[i - 1]} と ${flat[i]}`);
    const iv = compareLog(log);
    assert.equal(iv.length, 12);
    const maxOverlap = Math.max(...iv.map((x) => iv.filter((y) => y.start <= x.start && x.start < y.end).length));
    assert.ok(maxOverlap <= 3, `同時に ${maxOverlap} 本`);
    assert.ok(maxOverlap >= 2, "並列で流れていない");
    const run = readJson(join(out, readdirSync(out).find((n) => n.startsWith("compare-run-"))));
    assert.deepEqual(run.pairs.map((p) => p.state), Array(6).fill("both"));
    assert.equal(run.stop_code, null);
  });
});

test("#513 (d) 比較の子：v1 は比較元の入口と cwd で --pipeline 無し、v1.1a は候補の入口で --pipeline v1.1a。ほかの引数と写しは同じ。両群の params は経路と上限の欄以外同じ。比較の記録に指紋と採点の費用 0 があり鍵の値が無い。上限の照合", async () => {
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "d"));
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-d.json"), 1);
    const out = join(base, "out-d"), secret = "fake-jev-key-value-that-must-not-be-recorded";
    const r = runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: join(base, "spawn-d.log"), JEV_API_KEY: secret });
    assert.equal(r.status, 0, r.stderr);
    for (const pid of ["P1", "P3"]) {
      const d1 = join(out, "v1", `${pid}-r1`), d2 = join(out, "v1.1a", `${pid}-r1`);
      const a1 = readJson(join(d1, "received-argv.json")), a2 = readJson(join(d2, "received-argv.json"));
      assert.equal(a1[0], join(c.baseline, "packages/factory/dist/cli.js"));
      assert.equal(a2[0], join(c.repo, "packages/factory/dist/cli.js"));
      assert.equal(readJson(join(d1, "received-cwd.json")), realpathOf(join(c.baseline, "packages/factory")));
      assert.equal(readJson(join(d2, "received-cwd.json")), realpathOf(join(c.repo, "packages/factory")));
      assert.ok(!a1.includes("--pipeline"));
      assert.deepEqual(a2.slice(-2), ["--pipeline", "v1.1a"]);
      assert.deepEqual(a2.slice(1, -2).map((x) => x.replace(d2, "<dir>")), a1.slice(1).map((x) => x.replace(d1, "<dir>")), "ほかの引数は同じ");
      for (const f of ["request.md", "plan-file.json"]) assert.deepEqual(readFileSync(join(d1, f)), readFileSync(join(d2, f)), `${f} の写しが同じ`);
    }
    const c1 = readJson(join(out, "v1", "conditions.json")), c2 = readJson(join(out, "v1.1a", "conditions.json"));
    const strip = (p) => { const { pipeline: _p, stage_output_limits_v11a: _l, ...rest } = p; return rest; };
    assert.deepEqual(strip(c1.params), strip(c2.params));
    assert.deepEqual([c1.params.pipeline, c2.params.pipeline], ["v1", "v1.1a"]);
    assert.deepEqual(c1.params.stage_output_limits, V10_LIMITS);
    assert.deepEqual(c2.params.stage_output_limits, V10_LIMITS);
    assert.equal(c1.params.stage_output_limits_v11a, null);
    assert.deepEqual(c2.params.stage_output_limits_v11a, { "name-table": 32768, "semantic-check": 16384, "test-spec": 32768, "decl-check": 16384 });
    assert.deepEqual([c1.schema, c2.schema], ["musunest-factory/agent-accept-conditions/v5", "musunest-factory/agent-accept-conditions/v5"]);
    const pairsSha = sha256(readFileSync(pairs));
    assert.deepEqual(c1.comparison, { pairs_sha256: pairsSha, group: "v1", role: "baseline", profile: "diagnostic" });
    assert.deepEqual(c2.comparison, { pairs_sha256: pairsSha, group: "v1.1a", role: "candidate", profile: "diagnostic" });
    assert.deepEqual(readFileSync(join(out, "pairs.json")), readFileSync(pairs), "対のファイルの写し");
    const recText = readFileSync(join(out, "comparison.json"), "utf8"), rec = JSON.parse(recText);
    assert.ok(!recText.includes(secret) && !readFileSync(join(out, "v1", "conditions.json"), "utf8").includes(secret), "鍵の値が記録に出た");
    assert.equal(rec.scoring_cost_usd, 0);
    assert.equal(rec.pairs.sha256, pairsSha);
    assert.equal(rec.groups.v1.factory.fingerprint, c1.factory.fingerprint);
    assert.equal(rec.groups["v1.1a"].factory.fingerprint, c2.factory.fingerprint);
    assert.notEqual(rec.groups.v1.factory.fingerprint, rec.groups["v1.1a"].factory.fingerprint, "工場の dist は意図した差");
    assert.equal(rec.groups.v1.spec_engine, rec.groups["v1.1a"].spec_engine);
    assert.deepEqual([rec.groups.v1.conditions_signature, rec.groups["v1.1a"].conditions_signature], [c1.signature, c2.signature]);
    assert.equal(rec.shared.judge, "jev-primary-llm-fallback");
    assert.equal(rec.shared.frozen.sha256, sha256(readFileSync(c.fz)));
    assert.deepEqual([rec.concurrency, rec.budget_usd, rec.reserve_per_run_usd], [3, 5, 0.3]);
    assert.equal(rec.profile, "diagnostic", "偽物の計測は diagnostic でも子を起こす");
    assert.ok(rec.profile_mismatches.includes("baseline_commit") && rec.profile_mismatches.includes("frozen_sha256"));
    assert.equal(rec.signature, sha256(JSON.stringify((({ signature: _s, ...x }) => x)(rec))));
    // 共通の段の値を変える → fingerprint-differs。新しい段の値を変える → limits-unapproved
    const log = join(base, "spawn-d2.log");
    const c3 = makeCompare(join(base, "d3"), { baselineLimits: { ...V10_LIMITS, design: 16384 } });
    assertCompareRefused(runAgent(c3.repo, join(base, "out-d3"), compareArgs(c3, makePairsFile(c3.repo, c3, join(base, "pairs-d3.json"), 1), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "compare:fingerprint-differs", log, join(base, "out-d3"));
    const c4 = makeCompare(join(base, "d4"), { candidateLimits: { ...V14_LIMITS, "decl-check": 8192 } });
    assertCompareRefused(runAgent(c4.repo, join(base, "out-d4"), compareArgs(c4, makePairsFile(c4.repo, c4, join(base, "pairs-d4.json"), 1), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "compare:limits-unapproved", log, join(base, "out-d4"));
    const c5 = makeCompare(join(base, "d5"), { candidateLimits: V10_LIMITS });
    assertCompareRefused(runAgent(c5.repo, join(base, "out-d5"), compareArgs(c5, makePairsFile(c5.repo, c5, join(base, "pairs-d5.json"), 1), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "compare:limits-unapproved", log, join(base, "out-d5"), "no-v11a");
  });
});
const realpathOf = (p) => realpathSync(p);

test("#513 (d) profile の判定は純粋な関数：正式な条件を全部満たせば official、締切だけ 10 分・凍結した組の SHA だけ違う（同じ id・版）なら diagnostic と項目名", () => {
  const official = { ...OFFICIAL_COMPARE };
  assert.deepEqual(compareProfile(official), { profile: "official", mismatches: [] });
  assert.deepEqual(OFFICIAL_COMPARE, {
    baseline_commit: "2cd1586f856fb1cdecf75ef035826cbffe539e69", baseline_dirty: false, frozen_sha256: "1bed5c0e8cadbc504f3378337b3ea7b8335229ebb135cc7f7760e80ddcd0c9d9",
    frozen_id: "dev-p1-p10-b-408b202", frozen_version: 1, frozen_adopted: 10, runs: 3, effort: "high", deadline_min: 20, factory_budget_usd: 0.3, concurrency: 3, budget_usd: 5, rubric: "v5",
  });
  assert.deepEqual(compareProfile({ ...official, deadline_min: 10 }), { profile: "diagnostic", mismatches: ["deadline_min"] });
  assert.deepEqual(compareProfile({ ...official, frozen_sha256: "0".repeat(64) }), { profile: "diagnostic", mismatches: ["frozen_sha256"] });
  assert.deepEqual(compareProfile({ ...official, baseline_dirty: null, concurrency: 6 }).mismatches, ["baseline_dirty", "concurrency"]);
  assert.equal(compareProfile(null).profile, "diagnostic");
});

test("#513 (e) 全体の予算の打ち切り：上限 0.6・1 本 0.30・費用 0.25・並列 2・1 本目だけ遅い偽物で、起こすのは 2 本（新しい 1 本の予約を式に入れなければ 3 本目が起きる）。境界 0.60 は 2 本、0.59 は 1 本。比較でない計測は同じ数で 3 本目を起こす", async () => {
  // 式そのもの：済み 0.25・走行中 1 本で、新しい 1 本の予約を入れると上限を超え、入れなければ超えない
  assert.equal(launchAllowed({ spentUsd: 0.25, runningCount: 1, reserveUsd: 0.3, budgetUsd: 0.6 }), false);
  assert.ok(0.25 + 1 * 0.3 <= 0.6, "新しい 1 本の予約を入れない式なら起こしてしまう");
  assert.equal(launchAllowed({ spentUsd: 0, runningCount: 1, reserveUsd: 0.3, budgetUsd: 0.6 }), true, "ちょうど上限なら起こす");
  assert.equal(launchAllowed({ spentUsd: 0, runningCount: 1, reserveUsd: 0.3, budgetUsd: 0.59 }), false);
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "e"));
    const pairs = makePairsFile(c.repo, c, join(base, "pairs-e.json"));
    const flat = readJson(pairs).pairs.flatMap((p) => [p.first, p.first === "v1" ? "v1.1a" : "v1"].map((g) => ({ group: g, run: `${p.pid}-r${p.r}` })));
    const env = (log) => ({ FAKE_SPAWN_LOG: log, FAKE_COST: "0.25", FAKE_DELAY: JSON.stringify({ "v1/P1-r1": 900 }) });
    for (const [limit, launched] of [["0.6", 2], ["0.60", 2], ["0.59", 1]]) {
      const out = join(base, `out-e-${limit}`), log = join(base, `spawn-e-${limit}.log`);
      const r = runAgent(c.repo, out, compareArgs(c, pairs, ["--budget-usd", limit, "--factory-budget-usd", "0.30", "--concurrency", "2"]), env(log));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(compareLog(log).length, launched, `${limit}: 起こした本の数`);
      const run = readJson(join(out, readdirSync(out).find((n) => n.startsWith("compare-run-"))));
      assert.equal(run.stop_code, "budget");
      assert.equal(run.launched, launched);
      assert.deepEqual(run.pairs.map((p) => p.state), launched === 2 ? ["both", ...Array(5).fill("unstarted")] : ["first-only", ...Array(5).fill("unstarted")]);
      assert.deepEqual(run.not_launched, flat.slice(launched));
      assert.equal(run.running_at_stop, 1);
      assert.equal(run.spent_usd, 0.25 * launched);
      for (const g of ["v1", "v1.1a"]) {
        const gr = readJson(join(out, g, readdirSync(join(out, g)).find((n) => /^run-\d+\.json$/.test(n))));
        assert.equal(gr.stop_code, "budget", g);
        assert.equal(reconcile(join(out, g)).status, "incomplete", `${g}: 予算で止めた群は未完了`);
      }
    }
    // 比較でない計測（--build-from）は今までどおり済みの額だけを見るので、同じ数で 3 本目を起こす
    const log = join(base, "spawn-e-single.log"), out = join(base, "out-e-single");
    const r = runAgent(c.repo, out, ["--runs", "3", "--build-from", c.fz, "--budget-usd", "0.6", "--factory-budget-usd", "0.30", "--concurrency", "2"], { FAKE_SPAWN_LOG: log, FAKE_COST: "0.25", FAKE_DELAY: JSON.stringify({ "out-e-single/P1-r1": 900 }) });
    assert.equal(r.status, 0, r.stderr);
    // 済み 0.25 で 3 本目、0.5 で 4 本目を起こし、0.75 で止まる（予約を数えない今までの判定。比較でない計測の判定は変えない）
    assert.ok(compareLog(log).length >= 3, "3 本目を起こす");
    assert.equal(compareLog(log).length, 4);
  });
});

test("#513 (f) 起動の前の断り：対のファイルの負例・組めない引数・--budget-usd 無し・既定の違う dist・spec-engine の dist が違う checkout・読めない比較元・前の結果のある出力先で、子を起こさず exit 3・固定の符号 1 行・何も書かない", async () => {
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "f"));
    const good = readJson(makePairsFile(c.repo, c, join(base, "pairs-f.json")));
    const log = join(base, "spawn-f.log");
    const pairCases = [
      ["unreadable", "{", "compare:pairs-unreadable"],
      ["schema", { ...good, schema: "musunest-eval/compare-pairs/v0" }, "compare:pairs-schema"],
      ["groups", { ...good, groups: ["v1.1a", "v1"] }, "compare:pairs-schema"],
      ["frozen", { ...good, frozen_sha256: "0".repeat(64) }, "compare:pairs-frozen"],
      ["runs-zero", { ...good, runs: 0 }, "compare:pairs-runs"],
      ["runs-text", { ...good, runs: "3" }, "compare:pairs-runs"],
      ["empty", { ...good, pairs: [] }, "compare:pairs-empty"],
      ["shape", { ...good, pairs: good.pairs.map((p, i) => (i === 2 ? { ...p, first: "v2" } : p)) }, "compare:pairs-shape"],
      ["duplicate", { ...good, pairs: [...good.pairs.slice(0, 5), { ...good.pairs[0], first: "v1.1a" }] }, "compare:pairs-duplicate"],
      ["missing", { ...good, pairs: good.pairs.slice(0, 5) }, "compare:pairs-missing"],
      ["extra", { ...good, pairs: [...good.pairs, { pid: "P1", r: 4, first: "v1" }] }, "compare:pairs-extra"],
      ["not-adopted", { ...good, pairs: [...good.pairs.slice(0, 5), { pid: "P2", r: 3, first: "v1.1a" }] }, "compare:pairs-missing"],
      ["alternation", { ...good, pairs: good.pairs.map((p, i) => (i === 1 ? { ...p, first: "v1" } : p)) }, "compare:pairs-alternation"],
    ];
    for (const [label, value, code] of pairCases) {
      const out = join(base, `out-f-${label}`);
      assertCompareRefused(runAgent(c.repo, out, compareArgs(c, writePairs(join(base, `pairs-f-${label}.json`), value), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), code, log, out, label);
    }
    const pairs = join(base, "pairs-f.json");
    const conflictCases = [
      ["only", [...compareArgs(c, pairs), "--budget-usd", "5", "--only", "P1"]], ["runs", [...compareArgs(c, pairs), "--budget-usd", "5", "--runs", "3"]],
      ["resume", [...compareArgs(c, pairs), "--budget-usd", "5", "--resume"]], ["plan", [...compareArgs(c, pairs), "--budget-usd", "5", "--plan"]],
      ["plan-only", [...compareArgs(c, pairs), "--budget-usd", "5", "--plan-only"]], ["script", [...compareArgs(c, pairs), "--budget-usd", "5", "--script"]],
      ["pipeline", [...compareArgs(c, pairs), "--budget-usd", "5", "--pipeline", "v1.1a"]], ["make-pairs", [...compareArgs(c, pairs), "--budget-usd", "5", "--make-pairs", join(base, "mp.json")]],
      ["no-baseline", ["--compare", "--pairs", pairs, "--build-from", c.fz, "--budget-usd", "5"]], ["no-pairs", ["--compare", "--baseline", c.baseline, "--build-from", c.fz, "--budget-usd", "5"]],
      ["no-build-from", ["--compare", "--baseline", c.baseline, "--pairs", pairs, "--budget-usd", "5"]], ["baseline-without-compare", ["--baseline", c.baseline, "--runs", "1", "--build-from", c.fz]],
      ["bad-budget", [...compareArgs(c, pairs), "--budget-usd", "x"]],
    ];
    for (const [label, extra] of conflictCases) {
      const out = join(base, `out-f-${label}`);
      assertCompareRefused(runAgent(c.repo, out, extra, { FAKE_SPAWN_LOG: log }), "flags:conflict", log, out, label);
    }
    assertCompareRefused(runAgent(c.repo, join(base, "out-f-nobudget"), compareArgs(c, pairs), { FAKE_SPAWN_LOG: log }), "compare:budget-required", log, join(base, "out-f-nobudget"));
    // 既定の違う dist（比較元の締切の既定が違う）
    const cd = makeCompare(join(base, "fd"), { baselineCli: { deadlineMs: 1200000 } });
    assertCompareRefused(runAgent(cd.repo, join(base, "out-f-defaults"), compareArgs(cd, makePairsFile(cd.repo, cd, join(base, "pairs-fd.json")), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "compare:defaults-differ", log, join(base, "out-f-defaults"));
    // spec-engine の dist が違う checkout
    const cs = makeCompare(join(base, "fs"));
    writeFileSync(join(cs.baseline, "packages/spec-engine/dist/index.js"), "export const version = 2;\n");
    const rs = runAgent(cs.repo, join(base, "out-f-spec"), compareArgs(cs, makePairsFile(cs.repo, cs, join(base, "pairs-fs.json")), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log });
    assertCompareRefused(rs, "compare:fingerprint-differs", log, join(base, "out-f-spec"));
    assert.match(rs.stderr, /spec_engine/);
    // 生成に渡す文書（比較元の契約）が違う checkout
    const cdoc = makeCompare(join(base, "fdoc"));
    writeFileSync(join(cdoc.baseline, "packages/appspec-schema/contract/rules.md"), "# 契約 2\n");
    assertCompareRefused(runAgent(cdoc.repo, join(base, "out-f-doc"), compareArgs(cdoc, makePairsFile(cdoc.repo, cdoc, join(base, "pairs-fdoc.json")), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "compare:fingerprint-differs", log, join(base, "out-f-doc"), "contract");
    // 読めない比較元（工場の dist が無い）
    mkdirSync(join(base, "empty-checkout"));
    assertCompareRefused(runAgent(c.repo, join(base, "out-f-nobase"), ["--compare", "--baseline", join(base, "empty-checkout"), "--pairs", pairs, "--build-from", c.fz, "--budget-usd", "5"], { FAKE_SPAWN_LOG: log }), "compare:baseline-unreadable", log, join(base, "out-f-nobase"));
    // 比較元の工場の検査が包みを断る（比較元の語彙の版が違う）
    const cv = makeCompare(join(base, "fv"));
    writeFileSync(join(cv.baseline, "packages/factory/dist/cli.js"), fakeCompareCli().replace('VOCABULARY_VERSION = "v1"', 'VOCABULARY_VERSION = "v0"'));
    assertCompareRefused(runAgent(cv.repo, join(base, "out-f-vocab"), compareArgs(cv, makePairsFile(cv.repo, cv, join(base, "pairs-fv.json")), ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log }), "build-from:envelope-rejected:vocabulary", log, join(base, "out-f-vocab"));
    // 前の結果のある出力先
    const prior = join(base, "out-f-prior");
    mkdirSync(prior);
    writeFileSync(join(prior, "x"), "");
    const rp = runAgent(c.repo, prior, compareArgs(c, pairs, ["--budget-usd", "5"]), { FAKE_SPAWN_LOG: log });
    assert.equal(rp.status, 3);
    assert.ok(rp.stderr.includes("[compare:prior-output]"));
    assert.deepEqual(readdirSync(prior), ["x"]);
    assert.equal(compareLog(log).length, 0);
  });
});

test("#513 (g) 漏えい：目印を対のファイル・比較元のパス・子の出力に入れても、比較の記録・群の条件と起動の記録・本の要約・標準出力に出ない（生のログと対の写しには残る）", async () => {
  await withRepo(async (base) => {
    const c = makeCompare(join(base, "g"), { baselineName: `co-${MARK}` });
    assert.ok(c.baseline.includes(MARK));
    const pairsPath = join(base, "pairs-g.json");
    makePairsFile(c.repo, c, pairsPath, 1);
    writePairs(pairsPath, { ...readJson(pairsPath), note: MARK });
    const out = join(base, "out-g");
    const r = runAgent(c.repo, out, compareArgs(c, pairsPath, ["--budget-usd", "5"]), { FAKE_MARK: MARK, FAKE_SPAWN_LOG: join(base, "spawn-g.log") });
    assert.equal(r.status, 0, r.stderr);
    const texts = [r.stdout, r.stderr, readFileSync(join(out, "comparison.json"), "utf8"), readFileSync(join(out, readdirSync(out).find((n) => n.startsWith("compare-run-"))), "utf8")];
    for (const g of ["v1", "v1.1a"]) {
      texts.push(readFileSync(join(out, g, "conditions.json"), "utf8"));
      for (const n of readdirSync(join(out, g))) {
        if (/^run-\d+\.json$/.test(n)) texts.push(readFileSync(join(out, g, n), "utf8"));
        if (/^P\d+-r\d+$/.test(n)) texts.push(readFileSync(join(out, g, n, "summary.line.json"), "utf8"));
      }
    }
    texts.forEach((t, i) => assert.ok(!t.includes(MARK), `記録 ${i} に目印が出た`));
    assert.ok(readFileSync(join(out, "v1", "P1-r1", "stdout.log"), "utf8").includes(MARK), "生の標準出力には残る");
    assert.ok(readFileSync(join(out, "pairs.json"), "utf8").includes(MARK), "対の写しは生のまま");
  });
});

// ── #545：段単位の走り（--stage-start・--stage-end・--stage-from）と段だけの対の比較。README §5.11
// 偽物の工場の dist に、段の表と照合の関数（packages/factory/src/v11a/bundle-v11a.ts の verifyStageInput と同じ順と符号。SHA は JSON の SHA-256 で代える）を置く。
// 偽物の工場の入口は段の旗を受け、FAKE_STAGE（本の ID → stop）の本は範囲の最初の段で早期停止して checkpoint を書かない。それ以外は範囲の中の境界の checkpoint を書く
const fakeStageLib = String.raw`import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
export const STAGE_STARTS = ["name-table", "test-spec", "write"];
export const STAGE_ENDS = ["semantic-check", "test-spec", "judge"];
export const STAGE_BOUNDARIES = ["t1-t2", "t2-b1"];
const POS = { "name-table": 0, "semantic-check": 1, "test-spec": 2, write: 3, judge: 4 };
export const STAGE_INPUT_CODES = ["stage-input:unreadable", "stage-input:boundary", "stage-input:version", "stage-input:digest", "stage-input:plan-sha256", "stage-input:source-sha256", "stage-input:table-sha256", "stage-input:semantic-sha256", "stage-input:targets", "stage-input:carry-over", "stage-input:suite-sha256"];
export const STAGE_CHECKPOINT_SCHEMA = "musunest.factory.v11a-stage-checkpoint/v1";
export const STAGE_RUN_RECORD_SCHEMA = "musunest.factory.v11a-stage-run/v1";
export const STAGE_RUN_RECORD_FILE = "stage-run.json";
export const STAGE_BUDGET_SCOPE = "stage-run";
export const stageCheckpointFile = (b) => "stage-checkpoint-" + b + ".json";
export function boundaryBefore(start) { return start === "test-spec" ? "t1-t2" : start === "write" ? "t2-b1" : null; }
export function resolveStageRange({ start = "name-table", end = "judge", hasInput }) {
  if (!STAGE_STARTS.includes(start) || !STAGE_ENDS.includes(end)) return { code: "stage-range:unknown" };
  if (POS[start] > POS[end]) return { code: "stage-range:order" };
  const needed = boundaryBefore(start);
  if (needed === null && hasInput) return { code: "stage-input:not-needed" };
  if (needed !== null && !hasInput) return { code: "stage-input:missing" };
  return { start, end };
}
const obj = (t) => { if (t === null) return null; try { const v = JSON.parse(t); return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const fail = (code) => ({ ok: false, code });
export async function verifyStageInput(input) {
  if (process.env.FAKE_VERIFY_LOG) appendFileSync(process.env.FAKE_VERIFY_LOG, import.meta.url + "\n");
  const needed = boundaryBefore(input.start);
  if (needed === null) return fail("stage-input:boundary");
  const cp = obj(input.checkpointText), rec = obj(input.recordText);
  if (cp === null || rec === null) return fail("stage-input:unreadable");
  if (cp.boundary !== needed) return fail("stage-input:boundary");
  const declared = Array.isArray(rec.checkpoints) ? rec.checkpoints.find((e) => e && e.boundary === needed && e.path === input.checkpointFile) : undefined;
  if (!declared || typeof declared.output_digest !== "string") return fail("stage-input:boundary");
  if (cp.schema_version !== STAGE_CHECKPOINT_SCHEMA || rec.schema_version !== STAGE_RUN_RECORD_SCHEMA || cp.versions?.vocabulary !== input.vocabularyVersion || cp.versions?.contract !== input.contractVersion) return fail("stage-input:version");
  if (h(JSON.stringify(cp)) !== declared.output_digest) return fail("stage-input:digest");
  if (cp.plan_sha256 !== input.planSha256) return fail("stage-input:plan-sha256");
  if (cp.source_sha256 !== input.sourceSha256) return fail("stage-input:source-sha256");
  if (input.plan === null || typeof input.plan !== "object") return fail("stage-input:targets");
  if (h(JSON.stringify(cp.name_table?.rows)) !== cp.name_table?.table_sha256) return fail("stage-input:table-sha256");
  if (cp.semantic_check?.table_sha256 !== cp.name_table.table_sha256) return fail("stage-input:semantic-sha256");
  if (input.start === "write" && h(JSON.stringify(cp.test_spec?.suite)) !== cp.test_spec?.suite_sha256) return fail("stage-input:suite-sha256");
  return { ok: true, resume: {}, input: { checkpoint: input.checkpointFile, boundary: needed, output_digest: declared.output_digest } };
}
`;
const fakeStageCli = String.raw`import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 600000;
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
export const CONTRACT_VERSION = "v0.2";
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
const h = (t) => createHash("sha256").update(t).digest("hex");
const map = (k) => { try { return JSON.parse(process.env[k] ?? "{}"); } catch { return {}; } };
const val = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
if (isEntry()) {
  const outDir = val("--out"), runDir = dirname(outDir), id = basename(runDir), tag = basename(dirname(runDir)) + "/" + id;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(runDir, "received-argv.json"), JSON.stringify(process.argv.slice(1)));
  writeFileSync(join(runDir, "received-cwd.json"), JSON.stringify(process.cwd()));
  if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, tag + "\n");
  const start = val("--stage-start"), end = val("--stage-end");
  if (start === undefined) {
    process.stdout.write(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "partial", provider_cost_usd: 0.01 }) + "\n");
  } else {
    const env = JSON.parse(readFileSync(val("--plan-file"), "utf8"));
    const stop = map("FAKE_STAGE")[id] === "stop";
    const rows = [{ id: "R1", name: "n-" + id.split("-")[0] }, { id: "R2", name: "m-" + id.split("-")[0] }];
    const table_sha256 = h(JSON.stringify(rows));
    const suite = { tests: [{ id: "T1", target: "R1" }] };
    const cpOf = (boundary) => ({ schema_version: "musunest.factory.v11a-stage-checkpoint/v1", boundary, versions: { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" }, plan_sha256: env.plan_sha256, source_sha256: env.source_sha256, name_table: { table_sha256, rows }, semantic_check: { table_sha256, targets: ["R1"], judgments: [{ requirementId: "R1", verdict: "accept" }] }, ...(boundary === "t2-b1" ? { test_spec: { suite_sha256: h(JSON.stringify(suite)), suite } } : {}) });
    const crossed = stop ? [] : [...(start === "name-table" ? ["t1-t2"] : []), ...(start !== "write" && end !== "semantic-check" ? ["t2-b1"] : [])];
    const checkpoints = crossed.map((b) => { const cp = cpOf(b), path = "stage-checkpoint-" + b + ".json"; writeFileSync(join(outDir, path), JSON.stringify(cp, null, 2) + "\n"); return { boundary: b, path, output_digest: h(JSON.stringify(cp)) }; });
    const record = { schema_version: "musunest.factory.v11a-stage-run/v1", range: { start, end }, input: null, plan_sha256: env.plan_sha256, source_sha256: env.source_sha256, checkpoints, reached_stage: stop ? start : end, budget_scope: "stage-run", provider_cost_usd: Number(process.env.FAKE_COST ?? "0.01"), duration_secs: 1, stages: [{ stage: start, status: stop ? "failed" : "ok", calls: 1, duration_ms: 1 }], stopped: stop ? { stage: start, kind: "unmet" } : null, stage_pass: !stop, return_to_plan: false, exit_code: stop ? 1 : 0 };
    writeFileSync(join(outDir, "stage-run.json"), JSON.stringify(record, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ stage_pass: record.stage_pass, reached_stage: record.reached_stage, budget_scope: "stage-run", exit_code: record.exit_code }) + "\n");
    process.exitCode = record.exit_code;
  }
}
`;
const PIDS545 = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const IDS545 = PIDS545.flatMap((p) => [1, 2, 3].map((r) => `${p}-r${r}`));
/** 上流で境界に届かない（範囲の最初の段で早期停止する）本：30 本のうち 15 本（P1〜P5 の全回） */
const STOPPED545 = IDS545.slice(0, 15);
/** 段単位の偽物のリポジトリ：段の表と照合の関数・段の旗を受ける入口・v1.1α の 4 段の上限（承認値）。凍結した組は P1〜P10 を採用 */
function makeStageRepo(base, name = "stage") {
  const repo = makeRepo(join(base, name));
  mkdirSync(join(repo, "packages/factory/dist/v11a"), { recursive: true });
  writeFileSync(join(repo, "packages/factory/dist/v11a/bundle-v11a.js"), fakeStageLib);
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeStageCli);
  writeFileSync(join(repo, "packages/factory/dist/limits.js"), limitsJs(V14_LIMITS));
  return repo;
}
const frozen545 = (base, repo) => writeFrozen(join(base, "fz-545"), repo, { envelopes: Object.fromEntries(PIDS545.map((p) => [p, envelopeOf(p)])) });
const stageArgs = (fz, extra) => ["--runs", "3", "--concurrency", "4", "--build-from", fz, "--pipeline", "v1.1a", ...extra];
/** 上流（開始 T1・終了 T2'）を流す。STOPPED545 の本は早期停止 */
function runUpstream(repo, out, fz, log) {
  const r = runAgent(repo, out, stageArgs(fz, ["--stage-start", "name-table", "--stage-end", "test-spec"]), { FAKE_SPAWN_LOG: log, FAKE_STAGE: JSON.stringify(Object.fromEntries(STOPPED545.map((id) => [id, "stop"]))) });
  assert.equal(r.status, 0, r.stderr);
  return out;
}
/** 段の入力の照合の断り：exit 4・期待した符号と本の ID の 1 行・子 0 本・出力先に何も書かない */
function assertStageRefused(r, code, ids, log, spawned, out, label = code) {
  assert.equal(r.status, 4, `${label}: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: 標準エラーが 1 行でない`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  if (ids !== null) assert.match(r.stderr, new RegExp(` ids=${ids.join(",")} count=${ids.length}$`, "m"), label);
  assert.equal(spawnCount(log), spawned, `${label}: 子を起こした`);
  assertNothingWritten(out, label);
}
/** 上流の出力を写して 1 本の記録を書き換える（edit(本のディレクトリ) を当てる） */
function tamperUpstream(up, dest, id, edit) {
  cpSync(up, dest, { recursive: true });
  edit(join(dest, id, "bundle"));
  return dest;
}

test("#545 子の引数と条件：開始 T1 は子に --stage-start・--stage-end だけを足し（--stage-input 無し）、条件は v6・stage-run・範囲・budget_scope・stage_from null。開始 B1 は上流の入力のある 15 本だけを起こし、子は本のディレクトリに写した上流の checkpoint を --stage-input で受け、条件に本ごとの入力の SHA と入力なし 15", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream(repo, join(base, "up"), fz, log);
    assert.equal(spawnCount(log), 30, "上流は 30 本");
    const upCond = readJson(join(up, "conditions.json"));
    assert.equal(upCond.schema, "musunest-factory/agent-accept-conditions/v6");
    assert.deepEqual([upCond.params.mode, upCond.params.stage_start, upCond.params.stage_end, upCond.params.budget_scope, upCond.params.stage_from], ["stage-run", "name-table", "test-spec", "stage-run", null]);
    assert.deepEqual(upCond.params.stage_inputs, []);
    assert.deepEqual(upCond.stage_input_absent, { count: 0, ids: [] });
    const upArgv = readJson(join(up, "P1-r1", "received-argv.json"));
    assert.deepEqual(upArgv.slice(-6), ["--pipeline", "v1.1a", "--stage-start", "name-table", "--stage-end", "test-spec"]);
    assert.equal(upCond.params.factory_budget_usd, 0.3, "予算と締切は段の走り 1 本ごとに工場へ渡す");
    assert.equal(upArgv[upArgv.indexOf("--budget") + 1], "0.3");
    // 開始 B1
    const out = join(base, "b1");
    const r = runAgent(repo, out, stageArgs(fz, ["--stage-start", "write", "--stage-from", up]), { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log), 45, "上流の入力のある 15 本だけを起こす");
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v6");
    assert.deepEqual([cond.params.mode, cond.params.stage_start, cond.params.stage_end, cond.params.budget_scope], ["stage-run", "write", "judge", "stage-run"]);
    assert.equal(cond.stage_input_absent.count, 15);
    assert.deepEqual(cond.stage_input_absent.ids, STOPPED545);
    assert.equal(cond.params.stage_from.conditions_sha256, sha256(readFileSync(join(up, "conditions.json"))), "上流の計測の条件の指紋");
    assert.deepEqual(cond.params.stage_from.range, { start: "name-table", end: "test-spec" });
    assert.equal(cond.child_args.length, 30, "予定の一覧は 30 本のまま");
    for (const id of IDS545) {
      const entry = cond.params.stage_inputs.find((x) => x.id === id), ca = cond.child_args.find((x) => x.id === id);
      const upRecord = readFileSync(join(up, id, "bundle", "stage-run.json"));
      assert.equal(entry.record_sha256, sha256(upRecord), id);
      if (STOPPED545.includes(id)) {
        assert.equal(entry.absent, true, id);
        assert.equal(ca.argv, null, `${id}: 入力なしの本の子の引数は null`);
        assert.ok(!existsSync(join(out, id)), `${id}: 起こさない`);
        continue;
      }
      const upCp = readFileSync(join(up, id, "bundle", "stage-checkpoint-t2-b1.json"));
      assert.equal(entry.checkpoint_sha256, sha256(upCp), id);
      const dir = join(out, id), argv = readJson(join(dir, "received-argv.json"));
      assert.deepEqual(argv.slice(-8), ["--pipeline", "v1.1a", "--stage-start", "write", "--stage-end", "judge", "--stage-input", join(dir, "stage-input", "stage-checkpoint-t2-b1.json")]);
      assert.ok(readFileSync(join(dir, "stage-input", "stage-checkpoint-t2-b1.json")).equals(upCp), `${id}: checkpoint の写し`);
      assert.ok(readFileSync(join(dir, "stage-input", "stage-run.json")).equals(upRecord), `${id}: 記録の写し`);
      const sl = readJson(join(dir, "summary.line.json"));
      assert.deepEqual(sl.stage_run, { stage_pass: true, reached_stage: "judge", stopped: null, provider_cost_usd: 0.01, exit_code: 0 });
      assert.equal(sl.summary, null);
    }
    assert.match(r.stdout, /P6-r1 effort=high build-from pipeline=v1\.1a stage=write\.\.judge exit=0 stage_pass=true cost=0\.0100/);
    assert.ok(!/verdict=/.test(r.stdout), "段の通過を verdict の名前で出さない");
    const run = readJson(join(out, runRecords(out).at(-1)));
    assert.equal(run.executed.length, 15);
    assert.deepEqual(run.pending, []);
  });
});

test("#545 範囲を変えた --resume は resume:signature で断り（子 0 本・何も変えない）、同じ範囲なら残りだけを起こす", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const out = join(base, "out"), common = ["--only", "P1", "--runs", "2", "--concurrency", "1", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "name-table"];
    assert.equal(runAgent(repo, out, [...common, "--stage-end", "semantic-check"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r2"), { recursive: true, force: true });
    const before = treeOf(out), n0 = spawnCount(log);
    assertResumeRefused(runAgent(repo, out, [...common, "--stage-end", "test-spec", "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", out, before, "範囲を変えた再開");
    assert.equal(spawnCount(log), n0);
    const ok = runAgent(repo, out, [...common, "--stage-end", "semantic-check", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(spawnCount(log), n0 + 1);
  });
});

test("#545 照合：上流の 1 本の表の記録を 1 バイト変えた（出力ダイジェストを書き直した）上流は exit 4・stage-from:stage-input:table-sha256 とその本の ID、書き直さなければ digest。届いたのに checkpoint を消した本・記録を壊した本は unreadable で、入力なしに数えない。どれも子 0 本・何も書かない", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream(repo, join(base, "up"), fz, log);
    const spawned = spawnCount(log), target = "P7-r2";
    const flipCp = (rewriteDigest) => (dir) => {
      const cpPath = join(dir, "stage-checkpoint-t2-b1.json"), cp = readJson(cpPath);
      const name = cp.name_table.rows[0].name;
      cp.name_table.rows[0].name = name.slice(0, -1) + (name.endsWith("x") ? "y" : "x");
      writeFileSync(cpPath, JSON.stringify(cp, null, 2) + "\n");
      if (rewriteDigest) {
        const recPath = join(dir, "stage-run.json"), rec = readJson(recPath);
        rec.checkpoints = rec.checkpoints.map((c) => (c.boundary === "t2-b1" ? { ...c, output_digest: sha256(JSON.stringify(cp)) } : c));
        writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
      }
    };
    const cases = [
      ["table-sha256", flipCp(true), "stage-from:stage-input:table-sha256"],
      ["digest", flipCp(false), "stage-from:stage-input:digest"],
      ["checkpoint-removed", (dir) => rmSync(join(dir, "stage-checkpoint-t2-b1.json")), "stage-from:stage-input:unreadable"],
      ["record-broken", (dir) => writeFileSync(join(dir, "stage-run.json"), "{"), "stage-from:stage-input:unreadable"],
    ];
    for (const [label, edit, code] of cases) {
      const tampered = tamperUpstream(up, join(base, `up-${label}`), target, edit);
      const out = join(base, `out-${label}`);
      assertStageRefused(runAgent(repo, out, stageArgs(fz, ["--stage-start", "write", "--stage-from", tampered]), { FAKE_SPAWN_LOG: log }), code, [target], log, spawned, out, label);
    }
    // 早期停止した本（入力なし）の記録を壊しても、入力なしにせず unreadable で断る
    const brokenAbsent = tamperUpstream(up, join(base, "up-absent-broken"), STOPPED545[0], (dir) => writeFileSync(join(dir, "stage-run.json"), "[]"));
    assertStageRefused(runAgent(repo, join(base, "out-ab"), stageArgs(fz, ["--stage-start", "write", "--stage-from", brokenAbsent]), { FAKE_SPAWN_LOG: log }), "stage-from:stage-input:unreadable", [STOPPED545[0]], log, spawned, join(base, "out-ab"), "absent-broken");
    // 上流の条件：無い・範囲が境界を通らない（終了 T1'' の上流から開始 B1）
    const noCond = tamperUpstream(up, join(base, "up-nocond"), target, () => {});
    rmSync(join(noCond, "conditions.json"));
    assertStageRefused(runAgent(repo, join(base, "out-nc"), stageArgs(fz, ["--stage-start", "write", "--stage-from", noCond]), { FAKE_SPAWN_LOG: log }), "stage-from:conditions-missing", null, log, spawned, join(base, "out-nc"), "conditions-missing");
    const short = join(base, "up-short");
    assert.equal(runAgent(repo, short, stageArgs(fz, ["--stage-start", "name-table", "--stage-end", "semantic-check"]), { FAKE_SPAWN_LOG: log }).status, 0);
    const n1 = spawnCount(log);
    assertStageRefused(runAgent(repo, join(base, "out-short"), stageArgs(fz, ["--stage-start", "write", "--stage-from", short]), { FAKE_SPAWN_LOG: log }), "stage-from:range", null, log, n1, join(base, "out-short"), "range");
    // 対照：同じ上流で開始 T2 は t1-t2 の checkpoint を受けて流れる（全 30 本が境界 t1-t2 に… 早期停止の 15 本は t1-t2 も無いので入力なし）
    const t2 = join(base, "out-t2");
    const ok = runAgent(repo, t2, stageArgs(fz, ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-from", up]), { FAKE_SPAWN_LOG: log });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(spawnCount(log), n1 + 15);
    assert.equal(readJson(join(t2, "conditions.json")).stage_input_absent.count, 15);
  });
});

test("#545 組めない指定は flags:conflict（子 0 本・何も書かない）：開始 T2 で --stage-from が無い・開始 T1 で付いた・v1.1α の経路の旗が無い・凍結した組が無い・表に無い段・開始が終了より後・値の無い旗", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream(repo, join(base, "up"), fz, log);
    const spawned = spawnCount(log);
    const cases = [
      ["t2-without-from", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "test-spec"]],
      ["b1-without-from", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write"]],
      ["t1-with-from", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "name-table", "--stage-from", up]],
      ["from-only", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-from", up]],
      ["no-pipeline", ["--runs", "3", "--build-from", fz, "--stage-start", "write", "--stage-from", up]],
      ["pipeline-v1", ["--runs", "3", "--build-from", fz, "--pipeline", "v1", "--stage-start", "write", "--stage-from", up]],
      ["no-build-from", ["--runs", "3", "--pipeline", "v1.1a", "--stage-start", "name-table"]],
      ["unknown-stage", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "design"]],
      ["order", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-end", "test-spec", "--stage-from", up]],
      ["empty", ["--runs", "3", "--build-from", fz, "--pipeline", "v1.1a", "--stage-end"]],
    ];
    for (const [label, extra] of cases) {
      const out = join(base, `out-${label}`);
      assertRefused(runAgent(repo, out, extra, { FAKE_SPAWN_LOG: log }), "flags:conflict", log, spawned, label);
      assertNothingWritten(out, label);
    }
  });
});

test("#545 旗を省けば今と同じ：段の dist がある checkout でも、段の旗の無い --build-from は条件 v5・段の欄なし・子の引数に段の旗なし・起動の記録に stage_run なし", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo);
    const out = join(base, "out");
    const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.1a"]);
    assert.equal(r.status, 0, r.stderr);
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v5");
    assert.equal(cond.params.mode, "build-from");
    for (const k of ["stage_start", "stage_end", "budget_scope", "stage_from", "stage_inputs"]) assert.ok(!(k in cond.params), k);
    assert.ok(!("stage_input_absent" in cond));
    const dir = join(out, "P1-r1");
    assert.deepEqual(readJson(join(dir, "received-argv.json")).slice(-2), ["--pipeline", "v1.1a"]);
    assert.ok(!("stage_run" in readJson(join(dir, "summary.line.json"))));
    assert.ok(!existsSync(join(dir, "stage-input")));
    assert.match(r.stdout, /P1-r1 effort=high build-from pipeline=v1\.1a exit=0 verdict=partial cost=/);
  });
});

test("#545 段だけの対の比較：--make-pairs と段の旗は上流の入力のある 15 本だけで対を書き（交互の順）、--compare の群は before（比較元の checkout）・after（<repo>）で両群とも v1.1α の経路。両群の子は同じ本に同じ上流の入力のバイト列を受け、両群の照合の関数を当てる", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base, "cand"), baseline = makeStageRepo(base, "base"), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream(repo, join(base, "up"), fz, log);
    const pairsPath = join(base, "pairs.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", up, "--runs", "3"]);
    assert.equal(mp.status, 0, mp.stderr);
    const pv = readJson(pairsPath);
    assert.equal(pv.schema, "musunest-eval/stage-compare-pairs/v1");
    assert.deepEqual(pv.groups, ["before", "after"]);
    assert.deepEqual(pv.pairs.map((p) => `${p.pid}-r${p.r}`), IDS545.filter((id) => !STOPPED545.includes(id)));
    assert.deepEqual(pv.pairs.map((p) => p.first), pv.pairs.map((_, i) => (i % 2 === 0 ? "before" : "after")));
    assert.deepEqual(pv.stage, { start: "write", end: "judge", stage_from_sha256: sha256(readFileSync(join(up, "conditions.json"))) });
    const out = join(base, "cmp"), verifyLog = join(base, "verify.log"), n0 = spawnCount(log);
    const r = runAgent(repo, out, ["--compare", "--baseline", baseline, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4"], { FAKE_SPAWN_LOG: log, FAKE_VERIFY_LOG: verifyLog });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log) - n0, 30, "両群 15 本ずつ");
    const verified = readFileSync(verifyLog, "utf8").trim().split("\n");
    assert.equal(verified.length, 30, "入力のある 15 本に両群の照合の関数を当てる");
    assert.equal(new Set(verified).size, 2);
    assert.deepEqual(readdirSync(out).filter((n) => !n.includes(".")).sort(), ["after", "before"]);
    const rec = readJson(join(out, "comparison.json"));
    assert.equal(rec.schema, "musunest-eval/stage-compare-record/v1");
    assert.deepEqual(Object.keys(rec.groups), ["before", "after"]);
    assert.deepEqual([rec.groups.before.role, rec.groups.after.role, rec.groups.before.pipeline, rec.groups.after.pipeline], ["baseline", "candidate", "v1.1a", "v1.1a"]);
    assert.deepEqual(rec.stage, { start: "write", end: "judge", stage_from_sha256: pv.stage.stage_from_sha256, input_absent: 15 });
    const cb = readJson(join(out, "before", "conditions.json")), ca = readJson(join(out, "after", "conditions.json"));
    assert.deepEqual(cb.params.stage_inputs, ca.params.stage_inputs, "同じ上流の入力");
    assert.deepEqual(cb.stage_input_absent, ca.stage_input_absent);
    assert.deepEqual([cb.comparison.group, ca.comparison.group], ["before", "after"]);
    for (const p of pv.pairs) {
      const id = `${p.pid}-r${p.r}`;
      const cpB = readFileSync(join(out, "before", id, "stage-input", "stage-checkpoint-t2-b1.json")), cpA = readFileSync(join(out, "after", id, "stage-input", "stage-checkpoint-t2-b1.json"));
      assert.ok(cpB.equals(cpA) && cpA.equals(readFileSync(join(up, id, "bundle", "stage-checkpoint-t2-b1.json"))), id);
      assert.equal(realpathSync(readJson(join(out, "before", id, "received-cwd.json"))), realpathSync(join(baseline, "packages/factory")));
      assert.equal(realpathSync(readJson(join(out, "after", id, "received-cwd.json"))), realpathSync(join(repo, "packages/factory")));
      for (const g of ["before", "after"]) assert.deepEqual(readJson(join(out, g, id, "received-argv.json")).slice(-6), ["--stage-start", "write", "--stage-end", "judge", "--stage-input", join(out, g, id, "stage-input", "stage-checkpoint-t2-b1.json")]);
    }
    // 対のファイルと上流が食い違えば断る（範囲の違う対・入力のある本と違う対）
    const bad = writePairs(join(base, "pairs-bad.json"), { ...pv, pairs: pv.pairs.slice(1).map((p, i) => ({ ...p, first: i % 2 === 0 ? "before" : "after" })) });
    const n1 = spawnCount(log);
    assertRefused(runAgent(repo, join(base, "cmp-bad"), ["--compare", "--baseline", baseline, "--pairs", bad, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10"], { FAKE_SPAWN_LOG: log }), "compare:pairs-missing", log, n1, "pairs-missing");
    const badStage = writePairs(join(base, "pairs-stage.json"), { ...pv, stage: { ...pv.stage, end: "test-spec" } });
    assertRefused(runAgent(repo, join(base, "cmp-stage"), ["--compare", "--baseline", baseline, "--pairs", badStage, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10"], { FAKE_SPAWN_LOG: log }), "compare:pairs-stage", log, n1, "pairs-stage");
  });
});

test("#545 直し：境界の checkpoint の宣言が無い記録は、範囲の中で境界へ未到達と確認できるときだけ入力なし。境界より後の段まで到達・停止した記録（宣言の欠け）・不正な形の停止・停止と段の履歴の矛盾は stage-from:record-inconsistent・exit 4・子 0 本・何も書かない（--make-pairs も対を書かない）", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = join(base, "up");
    const r0 = runAgent(repo, up, stageArgs(fz, ["--stage-start", "name-table", "--stage-end", "judge"]), { FAKE_SPAWN_LOG: log, FAKE_STAGE: JSON.stringify(Object.fromEntries(STOPPED545.map((id) => [id, "stop"]))) });
    assert.equal(r0.status, 0, r0.stderr);
    const editRecord = (id, edit) => (dir) => { const p = join(dir, "stage-run.json"), rec = readJson(p); edit(rec); writeFileSync(p, JSON.stringify(rec, null, 2) + "\n"); };
    const cases = [
      // 指摘の再現：write まで到達し write で停止・段の通過が偽・t2-b1 の宣言を除いた記録
      ["write-stop", "P7-r2", (rec) => {
        rec.checkpoints = rec.checkpoints.filter((c) => c.boundary !== "t2-b1");
        rec.stages = [...rec.stages, { stage: "test-spec", status: "ok", calls: 1, duration_ms: 1 }, { stage: "write", status: "failed", calls: 1, duration_ms: 1 }];
        rec.reached_stage = "write"; rec.stopped = { stage: "write", kind: "unmet" }; rec.stage_pass = false; rec.exit_code = 1;
      }],
      ["stopped-no-kind", STOPPED545[0], (rec) => { rec.stopped = { stage: "name-table" }; }],
      ["stopped-unknown-kind", STOPPED545[1], (rec) => { rec.stopped = { stage: "name-table", kind: "made-up" }; }],
      ["stopped-not-object", STOPPED545[2], (rec) => { rec.stopped = "unmet"; }],
      ["stopped-missing", STOPPED545[3], (rec) => { rec.stopped = null; }],
      ["history-after-boundary", STOPPED545[4], (rec) => { rec.stages = [...rec.stages, { stage: "write", status: "failed", calls: 1, duration_ms: 1 }]; }],
      ["reached-mismatch", STOPPED545[5], (rec) => { rec.reached_stage = "judge"; }],
      ["passed-flag", STOPPED545[6], (rec) => { rec.exit_code = 0; }],
    ];
    const spawned = spawnCount(log);
    for (const [label, id, edit] of cases) {
      const tampered = tamperUpstream(up, join(base, `up-${label}`), id, editRecord(id, edit));
      const out = join(base, `out-${label}`);
      assertStageRefused(runAgent(repo, out, stageArgs(fz, ["--stage-start", "write", "--stage-from", tampered]), { FAKE_SPAWN_LOG: log }), "stage-from:record-inconsistent", [id], log, spawned, out, label);
      const pairsPath = join(base, `pairs-${label}.json`);
      const mp = runAgent(repo, join(base, `unused-${label}`), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", tampered, "--runs", "3"]);
      assert.equal(mp.status, 4, `${label}: ${mp.stderr}`);
      assert.ok(mp.stderr.includes("[stage-from:record-inconsistent]"), label);
      assert.ok(!existsSync(pairsPath), `${label}: 対を書いた`);
    }
    // 対照：書き換えない上流なら 15 本が入力なしで 15 対
    const pairsOk = join(base, "pairs-ok.json");
    const ok = runAgent(repo, join(base, "unused-ok"), ["--make-pairs", pairsOk, "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "write", "--stage-from", up, "--runs", "3"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readJson(pairsOk).pairs.length, 15);
  });
});

// ── #557：経路 v1.2（--pipeline v1.2）と比較の群の組（--compare-pipelines）。README §5.13
// 偽物の工場の dist：package の入口（index.js）に V12_PIPELINE_FLAGS を置き、入口（cli.js）は --pipeline v1.2 のとき、その値（FAKE_V12 で本ごとに差し替え。
// "__absent__" は欄を書かない）を要約の行と条件の記録（bundle/build-record.json の conditions）の v12_flags に書く。起動を FAKE_SPAWN_LOG に 1 行ずつ数える
const fakeV12Cli = String.raw`import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 600000;
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
export const VOCABULARY_VERSION = "v1";
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
const map = (k) => { try { return JSON.parse(process.env[k] ?? "{}"); } catch { return {}; } };
if (isEntry()) {
  const outDir = process.argv[process.argv.indexOf("--out") + 1], runDir = dirname(outDir), id = basename(runDir), key = basename(dirname(runDir)) + "/" + id;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(runDir, "received-argv.json"), JSON.stringify(process.argv.slice(1)));
  if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, key + "\n");
  const i = process.argv.indexOf("--pipeline"), pl = i >= 0 ? process.argv[i + 1] : "v1";
  let flags;
  if (pl === "v1.2") { try { flags = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "index.js")).href)).V12_PIPELINE_FLAGS; } catch { flags = undefined; } }
  const over = map("FAKE_V12")[key] ?? map("FAKE_V12")[id] ?? {};
  const pick = (k) => (Object.hasOwn(over, k) ? over[k] : flags);
  const summary = { schema_version: "commandagent.headless-summary/v1", verdict: "partial", stop_reason: "completed", provider_cost_usd: 0.01, stages: [{ stage: "write", duration_ms: 1 }] };
  const conditions = { model: "fake-model", prompt_version: pl };
  if (pl === "v1.2") { const s = pick("summary"), r = pick("record"); if (s !== "__absent__") summary.v12_flags = s; if (r !== "__absent__") { conditions.pipeline = "v1.2"; conditions.v12_flags = r; } }
  if (over.noRecord !== true) writeFileSync(join(outDir, "build-record.json"), JSON.stringify({ conditions }));
  if (over.noSummary !== true) process.stdout.write(JSON.stringify(summary) + "\n");
}
`;
import { pathToFileURL } from "node:url";
const FLAGS557 = { ledger: true };
const v12Index = (flags) => `export const V12_PIPELINE_FLAGS = ${JSON.stringify(flags)};\n`;
/** 偽物の v1.2 のリポジトリ：入口・package の入口（旗の組）・14 段の上限（v1.1α の 4 段は A1 の承認値） */
function makeV12Repo(base, { index = v12Index(FLAGS557), limits = V14_LIMITS } = {}) {
  const repo = makeRepo(base);
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeV12Cli);
  if (index !== null) writeFileSync(join(repo, "packages/factory/dist/index.js"), index);
  writeFileSync(join(repo, "packages/factory/dist/limits.js"), limitsJs(limits));
  return repo;
}
const PIDS557 = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const frozen557 = (base, repo, name = "fz-557") => writeFrozen(join(base, name), repo, { envelopes: Object.fromEntries(PIDS557.map((p) => [p, envelopeOf(p)])) });
const lastRunRecord = (out) => readJson(join(out, runRecords(out).at(-1)));
const V7 = "musunest-factory/agent-accept-conditions/v7", V5 = "musunest-factory/agent-accept-conditions/v5";

test("#557 (a) --pipeline v1.2：子の引数の末尾が --pipeline v1.2・条件の params.pipeline が v1.2・v12_flags が偽物の dist の V12_PIPELINE_FLAGS と深く等しい・schema v7。本ごとの記録に報告と一致、標準出力の行に pipeline=v1.2。省略と v1.1a には新しい欄が無い", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "a")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const run = (name, extra) => {
      const out = join(base, name), r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, ...extra], { FAKE_SPAWN_LOG: log });
      assert.equal(r.status, 0, r.stderr);
      return { out, r, cond: readJson(join(out, "conditions.json")), argv: readJson(join(out, "P1-r1", "received-argv.json")), sl: readJson(join(out, "P1-r1", "summary.line.json")), run: lastRunRecord(out) };
    };
    const omitted = run("out-omit", []), v11a = run("out-v11a", ["--pipeline", "v1.1a"]), v12 = run("out-v12", ["--pipeline", "v1.2"]);
    assert.deepEqual(v12.argv.slice(-2), ["--pipeline", "v1.2"]);
    assert.deepEqual(v12.argv.slice(0, -2).map((a) => a.replace(v12.out, omitted.out)), omitted.argv, "ほかの引数は省略と同じ");
    assert.equal(v12.cond.schema, V7);
    assert.equal(v12.cond.params.pipeline, "v1.2");
    const dist = await import(pathToFileURL(join(repo, "packages/factory/dist/index.js")).href);
    assert.deepEqual(v12.cond.params.v12_flags, dist.V12_PIPELINE_FLAGS);
    assert.deepEqual(v12.cond.child_args[0].argv, v12.argv, "条件の子の引数は渡した引数");
    assert.deepEqual(v12.sl.v12_flags, { status: "match", summary: { state: "present", flags: FLAGS557 }, record: { state: "present", flags: FLAGS557 } });
    assert.deepEqual(v12.run.v12_flags, { flags: FLAGS557, counts: { match: 1, mismatch: 0, missing: 0, malformed: 0, inconsistent: 0 }, unverified: [] });
    assert.match(v12.r.stdout, /^P1-r1 effort=high build-from pipeline=v1\.2 exit=0 verdict=partial /m);
    assert.notEqual(v12.cond.signature, v11a.cond.signature);
    // 省略と v1.1a：今の版・新しい欄なし・行に pipeline=v1.2 なし
    for (const x of [omitted, v11a]) {
      assert.equal(x.cond.schema, V5);
      assert.ok(!("v12_flags" in x.cond.params) && !("v12_flags" in x.sl) && !("v12_flags" in x.run));
      assert.ok(!x.r.stdout.includes("pipeline=v1.2"));
    }
    assert.ok(!omitted.r.stdout.includes("pipeline="));
    assert.deepEqual(v11a.argv.slice(-2), ["--pipeline", "v1.1a"]);
    // 組めない組・知らない値・値の無い指定・段の旗との組（子 0・何も書かない）
    const spawned = spawnCount(log);
    for (const [label, extra] of [
      ["no-build-from", ["--only", "P1", "--runs", "1", "--pipeline", "v1.2"]],
      ["plan", ["--only", "P1", "--runs", "1", "--plan", "--pipeline", "v1.2"]],
      ["plan-only", ["--only", "P1", "--runs", "1", "--plan-only", "--pipeline", "v1.2"]],
      ["unknown", ["--runs", "1", "--build-from", fz, "--pipeline", "v1.3"]],
      ["empty", ["--runs", "1", "--build-from", fz, "--pipeline"]],
      ["flag-value", ["--runs", "1", "--pipeline", "--build-from", fz]],
    ]) {
      const o = join(base, `out-c-${label}`);
      assertRefused(runAgent(repo, o, extra, { FAKE_SPAWN_LOG: log }), "flags:conflict", log, spawned, label);
      assertNothingWritten(o, label);
    }
    // 段の旗との組（#638 で受けるようにした）：段の表の無いこの偽物の dist では stage:dist-unreadable で断る（子 0・何も書かない。受ける側は #638 の試験）
    for (const [label, extra] of [
      ["stage", ["--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "name-table"]],
      ["stage-end", ["--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-end", "judge"]],
    ]) {
      const o = join(base, `out-c-${label}`);
      assertRefused(runAgent(repo, o, extra, { FAKE_SPAWN_LOG: log }), "stage:dist-unreadable", log, spawned, label);
      assertNothingWritten(o, label);
    }
  });
});

test("#557 (b) 公開の値：export の無い dist・値が真偽でない・空・配列・入口が無い dist は pipeline:v1.2-unavailable（exit 3）で子の起動 0 回・何も書かない（比較でも同じ）。旗を 1 つ増やした dist では、道具を直さずに条件と記録にその旗が載る", async () => {
  await withRepo(async (base) => {
    const log = join(base, "spawn.log");
    const cases = [["no-export", "export const OTHER = { ledger: true };\n"], ["not-bool", v12Index({ ledger: "on" })], ["empty", v12Index({})], ["array", v12Index([true])], ["null", v12Index(null)], ["number", v12Index({ ledger: 1 })], ["no-index", null]];
    for (const [label, index] of cases) {
      const repo = makeV12Repo(join(base, label), { index }), fz = frozen557(join(base, label), repo);
      const o = join(base, `out-${label}`);
      const r = runAgent(repo, o, ["--runs", "1", "--build-from", fz, "--pipeline", "v1.2"], { FAKE_SPAWN_LOG: log });
      assertRefused(r, "pipeline:v1.2-unavailable", log, 0, label);
      assertNothingWritten(o, label);
      oneLine(r, label);
      // 比較（候補の群が v1.2）でも子を起こさない
      const pairs = join(base, `pairs-${label}.json`);
      assert.equal(runAgent(repo, join(base, "unused"), ["--make-pairs", pairs, "--build-from", fz, "--runs", "1", "--compare-pipelines", "v1.1a,v1.2"]).status, 0, "対のファイルは子を起こさないので書ける");
      const oc = join(base, `out-cmp-${label}`);
      assertRefused(runAgent(repo, oc, ["--compare", "--baseline", repo, "--pairs", pairs, "--build-from", fz, "--budget-usd", "5", "--compare-pipelines", "v1.1a,v1.2"], { FAKE_SPAWN_LOG: log }), "pipeline:v1.2-unavailable", log, 0, `cmp-${label}`);
      assertNothingWritten(oc, `cmp-${label}`);
    }
    // 旗を 1 つ増やした偽物の dist と記録：道具を直さずに条件と記録に載る
    const more = { ledger: true, "search-repair": false };
    const repo = makeV12Repo(join(base, "more"), { index: v12Index(more) }), fz = frozen557(join(base, "more"), repo);
    const out = join(base, "out-more");
    assert.equal(runAgent(repo, out, ["--only", "P2", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.deepEqual(readJson(join(out, "conditions.json")).params.v12_flags, more);
    assert.deepEqual(readJson(join(out, "P2-r1", "summary.line.json")).v12_flags.summary.flags, more);
    assert.deepEqual(lastRunRecord(out).v12_flags.flags, more);
    assert.ok(!readFileSync(runAgentFile, "utf8").includes("search-repair") && !readFileSync(runAgentFile, "utf8").includes('"ledger"'), "計測の道具に旗の名前を書かない");
  });
});

test("#557 (c) 旗の組を変えた --resume は resume:signature で断る（子 0・出力先は変わらない）。同じ組の再開は通り、起動の記録の照合は飛ばした前回の本を含む。条件の版を知らない値に書き換えた出力先の再開も断る", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "c")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const out = join(base, "out-r"), args = ["--only", "P1", "--runs", "3", "--concurrency", "1", "--build-from", fz, "--pipeline", "v1.2"];
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r3"), { recursive: true, force: true });
    writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index({ ledger: true, "search-repair": true }));
    const before = treeOf(out), n0 = spawnCount(log);
    assertRefused(runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n0, "旗の組を変えた再開");
    assert.deepEqual(treeOf(out), before);
    writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index({ ledger: false }));
    assertRefused(runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n0, "真偽を変えた再開");
    writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index(FLAGS557));
    const rr = runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(rr.status, 0, rr.stderr);
    assert.equal(spawnCount(log), n0 + 1);
    assert.deepEqual(lastRunRecord(out).v12_flags.counts, { match: 3, mismatch: 0, missing: 0, malformed: 0, inconsistent: 0 }, "飛ばした前回の 2 本も照合に入る");
    // 条件の版を知らない値に書き換えた出力先
    rmSync(join(out, "P1-r3"), { recursive: true, force: true });
    const p = join(out, "conditions.json"), cond = readJson(p);
    writeFileSync(p, JSON.stringify({ ...cond, schema: "musunest-factory/agent-accept-conditions/v99" }, null, 1));
    const n1 = spawnCount(log);
    assertRefused(runAgent(repo, out, [...args, "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n1, "知らない版");
  });
});

test("#557 (d) 報告の照合：再開の前に起動した 1 本の報告が条件と違う計測・完了した 1 本の報告が無い計測で、起動の記録のその本が不一致・欠測。キーの順だけ違う報告は一致、要約と条件の記録の食い違いと不正形も本ごとに残る", async () => {
  await withRepo(async (base) => {
    const two = { ledger: true, "search-repair": false };
    const repo = makeV12Repo(join(base, "d"), { index: v12Index(two) }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const args = ["--only", "P1", "--runs", "3", "--concurrency", "1", "--build-from", fz, "--pipeline", "v1.2"];
    const slOf = (out, id) => readJson(join(out, id, "summary.line.json")).v12_flags;
    // 再開の前に起動した 1 本の報告が条件と違う
    const om = join(base, "out-mismatch");
    assert.equal(runAgent(repo, om, args, { FAKE_SPAWN_LOG: log, FAKE_V12: JSON.stringify({ "P1-r1": { summary: { ledger: false, "search-repair": false }, record: { ledger: false, "search-repair": false } } }) }).status, 0);
    rmSync(join(om, "P1-r3"), { recursive: true, force: true });
    assert.equal(runAgent(repo, om, [...args, "--resume"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(slOf(om, "P1-r1").status, "mismatch");
    assert.deepEqual(lastRunRecord(om).v12_flags.unverified, [{ id: "P1-r1", status: "mismatch" }], "再開の起動の記録に前回の本の不一致が残る");
    // 完了した 1 本の報告が無い（要約の欄が無い・要約の行が無い・条件の記録が無い）
    const cases = [
      ["summary-absent", { summary: "__absent__" }, "missing"], ["no-summary-line", { noSummary: true }, "missing"], ["no-record", { noRecord: true }, "missing"],
      ["key-order", { summary: { "search-repair": false, ledger: true }, record: { "search-repair": false, ledger: true } }, "match"],
      ["inconsistent", { summary: two, record: { ledger: true, "search-repair": true } }, "inconsistent"],
      ["malformed", { summary: "on" }, "malformed"], ["malformed-record", { record: [true] }, "malformed"],
    ];
    for (const [label, over, status] of cases) {
      const o = join(base, `out-${label}`);
      const r = runAgent(repo, o, args, { FAKE_SPAWN_LOG: log, FAKE_V12: JSON.stringify({ "P1-r2": over }) });
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.equal(slOf(o, "P1-r2").status, status, label);
      assert.deepEqual(lastRunRecord(o).v12_flags.unverified, status === "match" ? [] : [{ id: "P1-r2", status }], label);
      assert.equal(slOf(o, "P1-r1").status, "match", label);
    }
    // 工場の verdict の写しは照合で変えない
    assert.equal(readJson(join(om, "P1-r1", "summary.line.json")).summary.verdict, "partial");
  });
});

test("#557 (e) 比較の群の選択 v1.1a,v1.2（30 対・同じ checkout を --baseline に渡す）：群のディレクトリが v1.1a・v1.2、役割が baseline・candidate、両群の子の引数の違いが経路だけ、profile が diagnostic で違った項目に pipelines。比較の記録と群の条件に経路と v12_flags", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "e")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const pairs = join(base, "pairs-e.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairs, "--build-from", fz, "--runs", "3", "--compare-pipelines", "v1.1a,v1.2"], { FAKE_SPAWN_LOG: log });
    assert.equal(mp.status, 0, mp.stderr);
    const pv = readJson(pairs);
    assert.equal(pv.pairs.length, 30);
    assert.deepEqual(pv.groups, ["v1.1a", "v1.2"]);
    assert.deepEqual(pv.pairs.slice(0, 4).map((p) => p.first), ["v1.1a", "v1.2", "v1.1a", "v1.2"], "先行の群は比較元から交互");
    assert.equal(spawnCount(log), 0);
    const out = join(base, "out-e");
    const r = runAgent(repo, out, ["--compare", "--baseline", repo, "--pairs", pairs, "--build-from", fz, "--budget-usd", "100", "--concurrency", "6", "--compare-pipelines", "v1.1a,v1.2"], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log), 60);
    assert.deepEqual(readdirSync(out).filter((n) => statSync(join(out, n)).isDirectory()).sort(), ["v1.1a", "v1.2"]);
    const c1 = readJson(join(out, "v1.1a", "conditions.json")), c2 = readJson(join(out, "v1.2", "conditions.json"));
    assert.deepEqual([c1.schema, c2.schema], [V5, V7]);
    assert.deepEqual([c1.comparison.group, c1.comparison.role, c2.comparison.group, c2.comparison.role], ["v1.1a", "baseline", "v1.2", "candidate"]);
    assert.deepEqual([c1.comparison.profile, c2.comparison.profile], ["diagnostic", "diagnostic"]);
    assert.ok(!("v12_flags" in c1.params));
    assert.deepEqual(c2.params.v12_flags, FLAGS557);
    for (const id of ["P1-r1", "P10-r3"]) {
      const a1 = readJson(join(out, "v1.1a", id, "received-argv.json")), a2 = readJson(join(out, "v1.2", id, "received-argv.json"));
      assert.deepEqual([a1.slice(-2), a2.slice(-2)], [["--pipeline", "v1.1a"], ["--pipeline", "v1.2"]]);
      assert.deepEqual(a2.slice(0, -1).map((x) => x.replace(join(out, "v1.2"), "<g>")), a1.slice(0, -1).map((x) => x.replace(join(out, "v1.1a"), "<g>")), "子の引数の違いは経路だけ");
      assert.equal(readJson(join(out, "v1.2", id, "summary.line.json")).v12_flags.status, "match");
      assert.ok(!("v12_flags" in readJson(join(out, "v1.1a", id, "summary.line.json"))));
    }
    const rec = readJson(join(out, "comparison.json"));
    assert.equal(rec.profile, "diagnostic");
    assert.ok(rec.profile_mismatches.includes("pipelines"), JSON.stringify(rec.profile_mismatches));
    assert.deepEqual(rec.pairs.groups, ["v1.1a", "v1.2"]);
    assert.deepEqual([rec.groups["v1.1a"].role, rec.groups["v1.1a"].pipeline, rec.groups["v1.2"].role, rec.groups["v1.2"].pipeline], ["baseline", "v1.1a", "candidate", "v1.2"]);
    assert.deepEqual(rec.groups["v1.2"].v12_flags, FLAGS557);
    assert.ok(!("v12_flags" in rec.groups["v1.1a"]));
    assert.equal(rec.groups["v1.1a"].factory.fingerprint, rec.groups["v1.2"].factory.fingerprint, "同じ checkout");
    assert.match(r.stdout, /profile diagnostic（違う項目: .*pipelines）/);
    assert.match(r.stdout, /^v1\.2\/P1-r1 effort=high build-from pipeline=v1\.2 /m);
    assert.deepEqual(readJson(join(out, "v1.2", runRecords(join(out, "v1.2"))[0])).v12_flags.counts.match, 30);
    const run = readJson(join(out, readdirSync(out).find((n) => n.startsWith("compare-run-"))));
    assert.deepEqual(run.pairs.map((p) => p.state), Array(30).fill("both"));
  });
});

test("#557 (f) v1,v1.2：比較元の群の子に --pipeline が無く、正式な条件は今の定数で判定（pipelines を足さない）。--compare-pipelines v1,v1.1a は省略と同じ子の引数・対のファイル・条件・比較の記録。群の違う対のファイルは compare:pairs-schema、上限が承認値でない v1.2 の群は compare:limits-unapproved（子 0）", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "f")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const baseline = makeRepo(join(base, "bl"));
    writeFileSync(join(baseline, "packages/factory/dist/cli.js"), fakeV12Cli);
    writeFileSync(join(baseline, "packages/factory/dist/limits.js"), limitsJs(V10_LIMITS));
    const mkPairs = (name, extra) => { const p = join(base, name); const r = runAgent(repo, join(base, "unused"), ["--make-pairs", p, "--build-from", fz, "--runs", "1", ...extra]); assert.equal(r.status, 0, r.stderr); return p; };
    const p12 = mkPairs("pairs-v1-v12.json", ["--compare-pipelines", "v1,v1.2"]);
    const cmp = (out, pairs, extra) => runAgent(repo, out, ["--compare", "--baseline", baseline, "--pairs", pairs, "--build-from", fz, "--budget-usd", "100", "--concurrency", "4", ...extra], { FAKE_SPAWN_LOG: log });
    const out = join(base, "out-f");
    const r = cmp(out, p12, ["--compare-pipelines", "v1,v1.2"]);
    assert.equal(r.status, 0, r.stderr);
    const a1 = readJson(join(out, "v1", "P1-r1", "received-argv.json")), a2 = readJson(join(out, "v1.2", "P1-r1", "received-argv.json"));
    assert.ok(!a1.includes("--pipeline"), "比較元の群の子に --pipeline が無い");
    assert.deepEqual(a2.slice(-2), ["--pipeline", "v1.2"]);
    assert.equal(a1[0], join(baseline, "packages/factory/dist/cli.js"));
    const rec = readJson(join(out, "comparison.json"));
    assert.ok(!rec.profile_mismatches.includes("pipelines"));
    assert.deepEqual([readJson(join(out, "v1", "conditions.json")).schema, readJson(join(out, "v1.2", "conditions.json")).schema], [V5, V7]);
    // v1,v1.1a の明示と省略：対のファイルのバイト列が同じ。比較の子の引数・群の条件・比較の記録は時刻と出力先を除いて同じ
    const pOmit = mkPairs("pairs-omit.json", []), pExp = mkPairs("pairs-exp.json", ["--compare-pipelines", "v1,v1.1a"]);
    assert.deepEqual(readFileSync(pOmit), readFileSync(pExp));
    const oOmit = join(base, "omit", "same"), oExp = join(base, "exp", "same");
    assert.equal(cmp(oOmit, pOmit, []).status, 0);
    assert.equal(cmp(oExp, pExp, ["--compare-pipelines", "v1,v1.1a"]).status, 0);
    const noTime = ({ started_at: _t, ...x }) => x;
    for (const g of ["v1", "v1.1a"]) {
      assert.deepEqual(noTime(readJson(join(oExp, g, "conditions.json"))), noTime(readJson(join(oOmit, g, "conditions.json"))), g);
      assert.deepEqual(readJson(join(oExp, g, "P1-r1", "received-argv.json")).map((x) => x.replace(oExp, "<o>")), readJson(join(oOmit, g, "P1-r1", "received-argv.json")).map((x) => x.replace(oOmit, "<o>")), g);
      assert.ok(!("v12_flags" in readJson(join(oExp, g, "P1-r1", "summary.line.json"))));
    }
    const recOf = (o) => { const { started_at: _t, signature: _s, ...x } = readJson(join(o, "comparison.json")); return x; };
    assert.deepEqual(recOf(oExp), recOf(oOmit));
    assert.equal(readJson(join(oExp, "comparison.json")).pairs.sha256, readJson(join(oOmit, "comparison.json")).pairs.sha256);
    // 群の違う対のファイル（省略の対のファイルを v1,v1.2 に渡す・v1,v1.2 の対のファイルを省略で渡す）
    const n0 = spawnCount(log);
    for (const [label, pairs, extra] of [["omit-pairs-to-v12", pOmit, ["--compare-pipelines", "v1,v1.2"]], ["v12-pairs-to-omit", p12, []], ["v12-pairs-to-v11a-v12", p12, ["--compare-pipelines", "v1.1a,v1.2"]]]) {
      const o = join(base, `out-schema-${label}`);
      assertRefused(cmp(o, pairs, extra), "compare:pairs-schema", log, n0, label);
      assertNothingWritten(o, label);
    }
    // 上限が承認値でない v1.2 の群（候補の checkout の decl-check が 8192）
    const bad = makeV12Repo(join(base, "bad"), { limits: { ...V14_LIMITS, "decl-check": 8192 } }), fzb = frozen557(join(base, "bad"), bad);
    const pb = join(base, "pairs-bad.json");
    assert.equal(runAgent(bad, join(base, "unused"), ["--make-pairs", pb, "--build-from", fzb, "--runs", "1", "--compare-pipelines", "v1,v1.2"]).status, 0);
    const ob = join(base, "out-bad");
    assertRefused(runAgent(bad, ob, ["--compare", "--baseline", baseline, "--pairs", pb, "--build-from", fzb, "--budget-usd", "100", "--compare-pipelines", "v1,v1.2"], { FAKE_SPAWN_LOG: log }), "compare:limits-unapproved", log, n0, "limits");
    assertNothingWritten(ob, "limits");
  });
});

test("#557 (g) 組めない指定：v1.2,v1.1a・v1.2,v1.2・v1,v1.3・3 つ以上・値の無い指定・--compare も --make-pairs も無い指定・--compare と --pipeline v1.2、3 つの組それぞれで --compare-pipelines と段の旗の併用（--compare・--make-pairs）は flags:conflict で子の起動 0 回", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "g")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const pairs = join(base, "pairs-g.json");
    assert.equal(runAgent(repo, join(base, "unused"), ["--make-pairs", pairs, "--build-from", fz, "--runs", "1"]).status, 0);
    const cmpArgs = (extra) => ["--compare", "--baseline", repo, "--pairs", pairs, "--build-from", fz, "--budget-usd", "5", ...extra];
    const cases = [
      ["reversed", cmpArgs(["--compare-pipelines", "v1.2,v1.1a"])], ["same", cmpArgs(["--compare-pipelines", "v1.2,v1.2"])], ["unknown", cmpArgs(["--compare-pipelines", "v1,v1.3"])],
      ["three", cmpArgs(["--compare-pipelines", "v1,v1.1a,v1.2"])], ["one", cmpArgs(["--compare-pipelines", "v1.2"])], ["empty", cmpArgs(["--compare-pipelines"])], ["flag-value", [...cmpArgs([]).slice(0, -2), "--compare-pipelines", "--budget-usd", "5"]],
      ["alone", ["--runs", "1", "--build-from", fz, "--compare-pipelines", "v1.1a,v1.2"]], ["alone-pipeline", ["--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--compare-pipelines", "v1.1a,v1.2"]],
      ["compare-pipeline", cmpArgs(["--pipeline", "v1.2"])], ["make-pairs-pipeline", ["--make-pairs", join(base, "x.json"), "--build-from", fz, "--pipeline", "v1.2"]],
    ];
    for (const groups of ["v1,v1.1a", "v1.1a,v1.2", "v1,v1.2"]) {
      cases.push([`stage-compare-${groups}`, cmpArgs(["--pipeline", "v1.1a", "--stage-start", "name-table", "--compare-pipelines", groups])]);
      cases.push([`stage-make-pairs-${groups}`, ["--make-pairs", join(base, "y.json"), "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "name-table", "--compare-pipelines", groups]]);
    }
    for (const [label, extra] of cases) {
      const o = join(base, `out-${label}`);
      const r = runAgent(repo, o, extra, { FAKE_SPAWN_LOG: log });
      assertRefused(r, "flags:conflict", log, 0, label);
      oneLine(r, label);
      assertNothingWritten(o, label);
    }
    assert.ok(!existsSync(join(base, "x.json")) && !existsSync(join(base, "y.json")), "対を書いた");
  });
});

// ── #618：経路 v1.2 の条件に呼び出しの上限（params.v12_call_limits）を書き、署名に入れる。再開は上限の違いを断る
const LIMITS618 = { logicalCalls: 7, realAttempts: 11, judgeBranch: 5 };
const FLAGS618 = { ledger: true, ids: true };
const v12IndexWithLimits = (flags, limits) => `${v12Index(flags)}export const V12_CALL_LIMITS = ${JSON.stringify(limits)};\n`;
const rewriteConditions618 = (out, edit) => {
  const p = join(out, "conditions.json"), c = readJson(p);
  edit(c);
  c.signature = conditionsSignature(c);
  writeFileSync(p, JSON.stringify(c, null, 1));
};

test("#618 (a) v1.2 の条件の params.v12_call_limits の 3 つの値は dist の V12_CALL_LIMITS と欄ごとに等しい。v1・v1.1a の条件には欄が無く、dist に上限が無い v1.2 にも欄を足さない", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "a"), { index: v12IndexWithLimits(FLAGS618, LIMITS618) }), fz = frozen557(base, repo);
    const run = (name, extra) => {
      const out = join(base, name);
      const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, ...extra]);
      assert.equal(r.status, 0, r.stderr);
      return readJson(join(out, "conditions.json"));
    };
    const v12 = run("o12", ["--pipeline", "v1.2"]);
    assert.deepEqual(v12.params.v12_call_limits, { logical_calls: 7, real_attempts: 11, judge_branch: 5 });
    assert.equal(v12.signature, conditionsSignature(v12));
    for (const [name, extra] of [["o1", []], ["o11", ["--pipeline", "v1.1a"]]]) assert.ok(!("v12_call_limits" in run(name, extra).params), name);
    // 上限の無い dist（前の版）
    const repo2 = makeV12Repo(join(base, "a2")), fz2 = frozen557(base, repo2, "fz-618-2"), out2 = join(base, "o12-none");
    assert.equal(runAgent(repo2, out2, ["--only", "P1", "--runs", "1", "--build-from", fz2, "--pipeline", "v1.2"]).status, 0);
    assert.ok(!("v12_call_limits" in readJson(join(out2, "conditions.json")).params));
  });
});

test("#618 (b) 再開：同じ上限は通り、記録の上限が今の dist の上限と違うと resume:signature で断る（子 0・出力先は変わらない）。上限の欄の無い前の版の条件は今までどおり通る", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "b"), { index: v12IndexWithLimits(FLAGS618, LIMITS618) }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const args = ["--only", "P1", "--runs", "2", "--concurrency", "1", "--build-from", fz, "--pipeline", "v1.2"];
    const fresh = (name) => { const o = join(base, name); assert.equal(runAgent(repo, o, args, { FAKE_SPAWN_LOG: log }).status, 0); rmSync(join(o, "P1-r2"), { recursive: true, force: true }); return o; };
    // 同じ上限
    const same = fresh("same");
    assert.equal(runAgent(repo, same, [...args, "--resume"], { FAKE_SPAWN_LOG: log }).status, 0);
    // 記録の上限が違う（署名は中身から計算し直してある）
    for (const field of ["logical_calls", "real_attempts", "judge_branch"]) {
      const o = fresh(`diff-${field}`);
      rewriteConditions618(o, (c) => { c.params.v12_call_limits[field] += 1; });
      const before = treeOf(o), n0 = spawnCount(log);
      assertRefused(runAgent(repo, o, [...args, "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n0, field);
      assert.deepEqual(treeOf(o), before);
    }
    // 前の版（欄なし）
    const legacy = fresh("legacy");
    rewriteConditions618(legacy, (c) => { delete c.params.v12_call_limits; });
    assert.equal(runAgent(repo, legacy, [...args, "--resume"], { FAKE_SPAWN_LOG: log }).status, 0, "欄の無い前の版の条件は今までどおり");
  });
});

test("#618 (c) fail-closed：旗 ids が on なのに V12_CALL_LIMITS が無い・欄が欠ける・有限の数でない dist は pipeline:v1.2-limits-unavailable（exit 3）で子 0・何も書かない。ids が off か旗に ids の無い dist は欄を足さずに通る", async () => {
  await withRepo(async (base) => {
    const log = join(base, "spawn.log");
    const bad = [["absent", v12Index(FLAGS618)], ["missing-field", v12IndexWithLimits(FLAGS618, { logicalCalls: 7, realAttempts: 11 })], ["nan", v12IndexWithLimits(FLAGS618, { logicalCalls: 7, realAttempts: "11", judgeBranch: 5 })], ["null", `${v12Index(FLAGS618)}export const V12_CALL_LIMITS = null;\n`], ["infinity", `${v12Index(FLAGS618)}export const V12_CALL_LIMITS = { logicalCalls: 7, realAttempts: Infinity, judgeBranch: 5 };\n`]];
    for (const [label, index] of bad) {
      const repo = makeV12Repo(join(base, label), { index }), fz = frozen557(join(base, label), repo), o = join(base, `out-${label}`);
      assertRefused(runAgent(repo, o, ["--runs", "1", "--build-from", fz, "--pipeline", "v1.2"], { FAKE_SPAWN_LOG: log }), "pipeline:v1.2-limits-unavailable", log, 0, label);
      assertNothingWritten(o, label);
    }
    for (const [label, index] of [["ids-off", v12IndexWithLimits({ ledger: true, ids: false }, LIMITS618)], ["ids-off-no-limits", v12Index({ ledger: true, ids: false })], ["no-ids-flag", v12Index(FLAGS557)]]) {
      const repo = makeV12Repo(join(base, label), { index }), fz = frozen557(join(base, label), repo), o = join(base, `out-${label}`);
      assert.equal(runAgent(repo, o, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2"]).status, 0, label);
      assert.ok(!("v12_call_limits" in readJson(join(o, "conditions.json")).params), label);
    }
  });
});

// ── #638：v1.2 の段の走り（段の旗 × --pipeline v1.2 --build-from。条件 v8）・上流の経路の照合・段だけの対の比較の v1.2 の群。README §10.8
// 偽物の工場の dist：#545 の段の表と照合の関数に、開始の別名の表（合成の名前）と v1.2 の照合（checkpoint の版の ledger・flags が渡した値と同じ）を足す。
// package の入口（index.js）は旗の組・呼び出しの上限・台帳の指紋の関数を出す。入口（cli.js）は --pipeline v1.2 のとき checkpoint の版に ledger・flags・call_limits を、
// 段の走りの記録に conditions（pipeline・v12_flags）を書く。--pipeline v1.1a の出力は #545 の偽物と同じ
const fakeStageLib638 = fakeStageLib
  .replace('export const STAGE_BUDGET_SCOPE = "stage-run";', 'export const STAGE_BUDGET_SCOPE = "stage-run";\nexport const STAGE_START_ALIASES_V12 = { "c1-alias": "name-table" };')
  .replace("  if (h(JSON.stringify(cp)) !== declared.output_digest)", '  if (process.env.FAKE_VERIFY_V12_LOG) appendFileSync(process.env.FAKE_VERIFY_V12_LOG, JSON.stringify(input.v12 ?? null) + "\\n");\n  if (input.v12 !== undefined && (cp.versions?.ledger !== input.v12.ledger || JSON.stringify(cp.versions?.flags) !== JSON.stringify(input.v12.flags))) return fail("stage-input:version");\n  if (h(JSON.stringify(cp)) !== declared.output_digest)');
const fakeStageCli638 = fakeStageCli
  .replace('import { fileURLToPath } from "node:url";', 'import { fileURLToPath, pathToFileURL } from "node:url";')
  .replace("if (isEntry()) {", 'const pl = val("--pipeline");\nconst idx = pl === "v1.2" ? await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "index.js")).href) : null;\nconst v12 = idx === null ? null : { ledger: await idx.propertyLedgerSha256(), flags: idx.V12_PIPELINE_FLAGS };\nif (isEntry()) {')
  .replace('versions: { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" }', 'versions: { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0", ...(v12 === null ? {} : { ledger: v12.ledger, flags: v12.flags, call_limits: null }) }')
  .replace("return_to_plan: false, exit_code: stop ? 1 : 0 };", "return_to_plan: false, exit_code: stop ? 1 : 0, ...(v12 === null ? {} : { conditions: { pipeline: \"v1.2\", v12_flags: v12.flags } }) };");
assert.ok(fakeStageLib638 !== fakeStageLib && fakeStageCli638.includes("call_limits") && fakeStageCli638.includes("v12_flags: v12.flags"), "偽物の差し替えが当たらない");
const FLAGS638 = { ledger: true, ids: true };
const LIMITS638 = { logicalCalls: 7, realAttempts: 11, judgeBranch: 5 };
const v12Index638 = ({ flags = FLAGS638, ledger = "ledger-a" } = {}) => `export const V12_PIPELINE_FLAGS = ${JSON.stringify(flags)};\nexport const V12_CALL_LIMITS = ${JSON.stringify(LIMITS638)};\nexport async function propertyLedgerSha256() { return ${JSON.stringify(ledger)}; }\n`;
function makeStageRepo638(base, name = "stage638", index = {}) {
  const repo = makeStageRepo(base, name);
  writeFileSync(join(repo, "packages/factory/dist/v11a/bundle-v11a.js"), fakeStageLib638);
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeStageCli638);
  writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index638(index));
  return repo;
}
const stageArgs638 = (fz, extra, pl = "v1.2") => ["--runs", "3", "--concurrency", "4", "--build-from", fz, "--pipeline", pl, ...extra];
const V8 = "musunest-factory/agent-accept-conditions/v8", V6 = "musunest-factory/agent-accept-conditions/v6";
/** v6 の params の鍵（#545 の段単位の走り。v1.1α の段単位はこの鍵だけで、#638 の欄を持たない） */
const V6_PARAM_KEYS = ["effort", "model", "plan", "answers_mode", "mode", "patterns", "runs", "concurrency", "budget_usd", "factory_budget_usd", "factory_deadline_min", "stage_output_limits", "pipeline", "stage_output_limits_v11a", "stage_start", "stage_end", "budget_scope", "stage_from", "stage_inputs"];
/** 上流（開始 T1・終了 T2'）を v1.2 で流す。STOPPED545 の本は早期停止 */
function runUpstream638(repo, out, fz, log, pl = "v1.2") {
  const r = runAgent(repo, out, stageArgs638(fz, ["--stage-start", "name-table", "--stage-end", "test-spec"], pl), { FAKE_SPAWN_LOG: log, FAKE_STAGE: JSON.stringify(Object.fromEntries(STOPPED545.map((id) => [id, "stop"]))) });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

test("#638 (a) 段の旗 × --pipeline v1.2 --build-from：条件は v8（v6 の段の欄＋pipeline v1.2・v12_flags・v12_call_limits。dist の値と深く等しい）、子の引数の末尾は --pipeline v1.2 と段の旗。開始の別名は dist の表で正本の名前に正規化され params が同じ。v1.1α の段単位は v6 の鍵だけで、別名を受けない", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const run = (name, extra, pl = "v1.2") => { const out = join(base, name); const r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", pl, ...extra], { FAKE_SPAWN_LOG: log }); assert.equal(r.status, 0, `${name}: ${r.stderr}`); return { out, r, cond: readJson(join(out, "conditions.json")), argv: readJson(join(out, "P1-r1", "received-argv.json")) }; };
    const v12 = run("o12", ["--stage-start", "name-table", "--stage-end", "test-spec"]);
    assert.equal(v12.cond.schema, V8);
    const dist = await import(pathToFileURL(join(repo, "packages/factory/dist/index.js")).href);
    assert.deepEqual([v12.cond.params.mode, v12.cond.params.pipeline, v12.cond.params.stage_start, v12.cond.params.stage_end, v12.cond.params.budget_scope, v12.cond.params.stage_from], ["stage-run", "v1.2", "name-table", "test-spec", "stage-run", null]);
    assert.deepEqual(v12.cond.params.v12_flags, dist.V12_PIPELINE_FLAGS);
    assert.deepEqual(v12.cond.params.v12_call_limits, { logical_calls: 7, real_attempts: 11, judge_branch: 5 });
    assert.deepEqual(Object.keys(v12.cond.params), [...V6_PARAM_KEYS.slice(0, 14), "v12_flags", "v12_call_limits", ...V6_PARAM_KEYS.slice(14)], "v6 の段の欄に v12_flags・v12_call_limits を足した形");
    assert.equal(v12.cond.signature, conditionsSignature(v12.cond));
    assert.deepEqual(v12.argv.slice(-6), ["--pipeline", "v1.2", "--stage-start", "name-table", "--stage-end", "test-spec"]);
    assert.match(v12.r.stdout, /^P1-r1 effort=high build-from pipeline=v1\.2 stage=name-table\.\.test-spec exit=0 stage_pass=true /m);
    assert.ok(!("v12_flags" in readJson(join(v12.out, "P1-r1", "summary.line.json"))), "段の走りの本の記録に一気通貫の報告を写さない");
    // 開始の別名（合成の名前。道具に書かない）
    const alias = run("o12-alias", ["--stage-start", "c1-alias", "--stage-end", "test-spec"]);
    assert.deepEqual(alias.cond.params, v12.cond.params, "別名と正本の名前で params が同じ");
    assert.deepEqual(alias.argv.slice(-6), v12.argv.slice(-6), "子には正本の名前を渡す");
    assert.ok(!readFileSync(runAgentFile, "utf8").includes("c1-alias") && !readFileSync(runAgentFile, "utf8").includes('"vocabulary"'), "道具に別名を書かない");
    // v1.1α の段単位：v6・#545 の鍵だけ・経路 v1.1a
    const v11 = run("o11", ["--stage-start", "name-table", "--stage-end", "test-spec"], "v1.1a");
    assert.equal(v11.cond.schema, V6);
    assert.deepEqual(Object.keys(v11.cond.params), V6_PARAM_KEYS);
    assert.equal(v11.cond.params.pipeline, "v1.1a");
    assert.deepEqual(v11.argv.slice(-6), ["--pipeline", "v1.1a", "--stage-start", "name-table", "--stage-end", "test-spec"]);
    const cp11 = readJson(join(v11.out, "P1-r1", "bundle", "stage-checkpoint-t1-t2.json"));
    assert.deepEqual(Object.keys(cp11.versions), ["vocabulary", "contract", "prompt", "factory"], "偽物の v1.1α の出力も #545 と同じ");
    const spawned = spawnCount(log), o = join(base, "o11-alias");
    assertRefused(runAgent(repo, o, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.1a", "--stage-start", "c1-alias"], { FAKE_SPAWN_LOG: log }), "flags:conflict", log, spawned, "v1.1a は別名を受けない");
    assertNothingWritten(o, "v1.1a の別名");
    // v1.2 でも凍結した組が無ければ組めない
    assertRefused(runAgent(repo, join(base, "o12-nofz"), ["--only", "P1", "--runs", "1", "--pipeline", "v1.2", "--stage-start", "name-table"], { FAKE_SPAWN_LOG: log }), "flags:conflict", log, spawned, "no-build-from");
    // 再開：同じ範囲は残りだけ、条件の版を v6 に書き換えた出力先は断る
    rmSync(join(v12.out, "P1-r1"), { recursive: true, force: true });
    const rr = runAgent(repo, v12.out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "name-table", "--stage-end", "test-spec", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(rr.status, 0, rr.stderr);
    assert.equal(spawnCount(log), spawned + 1);
    rmSync(join(v12.out, "P1-r1"), { recursive: true, force: true });
    const p = join(v12.out, "conditions.json"), c = readJson(p);
    c.schema = V6; c.signature = conditionsSignature(c);
    writeFileSync(p, JSON.stringify(c, null, 1));
    const before = treeOf(v12.out);
    assertResumeRefused(runAgent(repo, v12.out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "name-table", "--stage-end", "test-spec", "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", v12.out, before, "版を書き換えた再開");
  });
});

test("#638 (b) 上流の照合：v8 の上流から開始 B1 を v1.2 で流すと、照合の関数に dist の旗の組と台帳の指紋を渡し、入力のある 15 本だけを起こす。経路の違う上流（v6 → v1.2・v8 → v1.1a）は stage-from:conditions-pipeline、台帳の指紋か旗の組を変えた dist は stage-from:stage-input:version で、どれも exit 4・子 0 本・何も書かない", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up12 = runUpstream638(repo, join(base, "up12"), fz, log);
    assert.equal(readJson(join(up12, "conditions.json")).schema, V8);
    const out = join(base, "b1"), vlog = join(base, "v12.log");
    const r = runAgent(repo, out, stageArgs638(fz, ["--stage-start", "write", "--stage-from", up12]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlog });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log), 45);
    const seen = readFileSync(vlog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(seen.length, 15);
    for (const v of seen) assert.deepEqual(v, { ledger: "ledger-a", flags: FLAGS638 }, "dist の公開の値を渡す");
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(cond.schema, V8);
    assert.deepEqual([cond.params.stage_start, cond.params.stage_end, cond.params.pipeline, cond.stage_input_absent.count], ["write", "judge", "v1.2", 15]);
    assert.equal(cond.params.stage_from.conditions_sha256, sha256(readFileSync(join(up12, "conditions.json"))));
    // 経路の違う上流
    const up11 = runUpstream638(repo, join(base, "up11"), fz, log, "v1.1a");
    assert.equal(readJson(join(up11, "conditions.json")).schema, V6);
    const n0 = spawnCount(log);
    for (const [label, upDir, pl] of [["v6-to-v12", up11, "v1.2"], ["v8-to-v11", up12, "v1.1a"]]) {
      const o = join(base, `out-${label}`);
      assertStageRefused(runAgent(repo, o, stageArgs638(fz, ["--stage-start", "write", "--stage-from", upDir], pl), { FAKE_SPAWN_LOG: log }), "stage-from:conditions-pipeline", null, log, n0, o, label);
    }
    // 版と経路の合わない上流の条件（署名は中身から計算し直す）は壊れた条件
    const broken = join(base, "up-broken");
    cpSync(up12, broken, { recursive: true });
    const bc = readJson(join(broken, "conditions.json"));
    bc.params.pipeline = "v1.1a"; bc.signature = conditionsSignature(bc);
    writeFileSync(join(broken, "conditions.json"), JSON.stringify(bc, null, 1));
    assertStageRefused(runAgent(repo, join(base, "out-broken"), stageArgs638(fz, ["--stage-start", "write", "--stage-from", broken], "v1.1a"), { FAKE_SPAWN_LOG: log }), "stage-from:conditions-invalid", null, log, n0, join(base, "out-broken"), "broken");
    // 台帳の指紋・旗の組を変えた dist（上流の checkpoint の版と違う）
    for (const [label, index] of [["ledger", { ledger: "ledger-b" }], ["flags", { flags: { ledger: true, ids: false } }]]) {
      writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index638(index));
      const o = join(base, `out-${label}`);
      const rr = runAgent(repo, o, stageArgs638(fz, ["--stage-start", "write", "--stage-from", up12]), { FAKE_SPAWN_LOG: log });
      assertStageRefused(rr, "stage-from:stage-input:version", [IDS545[15]], log, n0, o, label);
    }
  });
});

test("#638 (c) 段だけの対の比較 × v1.2：--make-pairs は上流の入力のある 15 本で対を書き、--compare の群 before・after は両群とも v1.2（子の引数に --pipeline v1.2・条件 v8・比較の記録の経路と旗の組）。比較元の dist の旗の組が違えば compare:flags-mismatch（exit 3・子 0 本・何も書かない）", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base, "cand"), baseline = makeStageRepo638(base, "base"), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const pairsPath = join(base, "pairs.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--runs", "3"]);
    assert.equal(mp.status, 0, mp.stderr);
    const pv = readJson(pairsPath);
    assert.deepEqual([pv.schema, pv.groups, pv.pairs.length], ["musunest-eval/stage-compare-pairs/v1", ["before", "after"], 15]);
    assert.deepEqual(pv.stage, { start: "write", end: "judge", stage_from_sha256: sha256(readFileSync(join(up, "conditions.json"))) });
    const cmpArgs = (bl, extra = []) => ["--compare", "--baseline", bl, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4", ...extra];
    const out = join(base, "cmp"), n0 = spawnCount(log);
    const r = runAgent(repo, out, cmpArgs(baseline), { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log) - n0, 30);
    const rec = readJson(join(out, "comparison.json"));
    assert.equal(rec.schema, "musunest-eval/stage-compare-record/v1");
    assert.deepEqual([rec.groups.before.pipeline, rec.groups.after.pipeline], ["v1.2", "v1.2"]);
    assert.deepEqual([rec.groups.before.v12_flags, rec.groups.after.v12_flags], [FLAGS638, FLAGS638]);
    for (const g of ["before", "after"]) {
      const c = readJson(join(out, g, "conditions.json"));
      assert.equal(c.schema, V8, g);
      assert.deepEqual([c.params.pipeline, c.params.v12_flags], ["v1.2", FLAGS638], g);
      assert.ok(!("v12_call_limits" in c.params), `${g}: 比較の群には上限を足さない（#618 と同じ）`);
      const id = `${pv.pairs[0].pid}-r${pv.pairs[0].r}`;
      assert.deepEqual(readJson(join(out, g, id, "received-argv.json")).slice(-8, -6), ["--pipeline", "v1.2"], g);
    }
    // 比較元の dist の旗の組が違う
    const other = makeStageRepo638(base, "other", { flags: { ledger: true, ids: false } }), n1 = spawnCount(log), bad = join(base, "cmp-bad");
    const rb = runAgent(repo, bad, cmpArgs(other), { FAKE_SPAWN_LOG: log });
    assertRefused(rb, "compare:flags-mismatch", log, n1, "flags-mismatch");
    oneLine(rb, "flags-mismatch");
    assertNothingWritten(bad, "flags-mismatch");
  });
});

// ── #640：--stage-from に凍結した上流の組（組のディレクトリ）を渡す口。組は v1.2 の上流（開始 T1・終了 T2'）の出力の写しから、凍結の道具の公開の関数で合成する
// （凍結の規則そのものは freeze-stage-input.test.mjs）。P ごとの 1 本を全反復に同じバイト列で渡し、組の不一致は exit 4・stage-from:set-* で子 0 本
import { FROZEN_STAGE_SET_FILE, applyReview, stageSetBytes } from "./freeze-stage-input.mjs";

/**
 * 組のディレクトリを作る。採用した P は上流の pick(P) の本の checkpoint と記録の写し、missing は外した P。review が null なら人の採否を反映しない。
 * edit(組) で署名の前に組を書き換える
 */
function makeStageSet640(dir, up, fzPath, { boundary = "t2-b1", pick = (pid) => `${pid}-r2`, adopted = PIDS545.slice(5), missing = PIDS545.slice(0, 5), exclude = ["P7"], review = true, edit = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const cpName = `stage-checkpoint-${boundary}.json`;
  const entries = adopted.map((pid) => {
    const run = pick(pid), src = join(up, run, "bundle");
    const cp = readFileSync(join(src, cpName)), rec = readFileSync(join(src, "stage-run.json"));
    mkdirSync(join(dir, "inputs", run), { recursive: true });
    writeFileSync(join(dir, "inputs", run, cpName), cp);
    writeFileSync(join(dir, "inputs", run, "stage-run.json"), rec);
    const digest = JSON.parse(rec.toString("utf8")).checkpoints.find((c) => c.boundary === boundary).output_digest;
    return { pattern: pid, run, started_at: "2026-10-19T00:00:00.000Z", checkpoint: { path: `inputs/${run}/${cpName}`, sha256: sha256(cp), output_digest: digest }, record: { path: `inputs/${run}/stage-run.json`, sha256: sha256(rec) }, table_sha256: sha256(`table-${run}`), score: { correct: 1, denominator: 2 } };
  });
  let set = {
    schema: "musunest-eval/frozen-stage-input-set/v1", id: "stage-set-640", version: 1, boundary, rule: { name: "best-scored-complete", version: 1 },
    plan_set: { id: "fz-t", version: 1, sha256: sha256(readFileSync(fzPath)) },
    source: { conditions_sha256: sha256(readFileSync(join(up, "conditions.json"))), measurement_id: null, pipeline: "v1.2", v12_flags: FLAGS638, score_sha256: sha256("score-640") },
    adopted: entries, missing: missing.map((pattern) => ({ pattern, reason: "no-checkpoint" })),
  };
  if (review) {
    const decisions = adopted.map((pattern) => (exclude.includes(pattern) ? { pattern, decision: "exclude", reason: "human-check" } : { pattern, decision: "adopt" }));
    const r = applyReview(set, Buffer.from(JSON.stringify({ schema: "musunest-eval/frozen-stage-input-review/v1", set: { id: set.id, version: set.version }, author: "scorer", date: "2026-10-19", decisions })));
    assert.equal(r.code, undefined, r.code);
    set = r.set;
  }
  if (edit !== null) edit(set);
  writeFileSync(join(dir, FROZEN_STAGE_SET_FILE), stageSetBytes(set));
  return dir;
}

test("#640 (a) --stage-from <組のディレクトリ>：P ごとの 1 本をその P の全反復に同じバイト列で渡し、組が外した P（人が除外した P を含む）は入力なしに数える。条件の stage_from は組の種類・id・版・SHA、stage_inputs に組の出力ダイジェスト。--make-pairs の stage_from_sha256 は組の SHA", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const setDir = makeStageSet640(join(base, "set"), up, fz);
    const setSha = sha256(readFileSync(join(setDir, FROZEN_STAGE_SET_FILE)));
    const out = join(base, "b1"), n0 = spawnCount(log), vlog = join(base, "v12.log");
    const r = runAgent(repo, out, stageArgs638(fz, ["--stage-start", "write", "--stage-from", setDir]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlog });
    assert.equal(r.status, 0, r.stderr);
    const launched = ["P6", "P8", "P9", "P10"];
    assert.equal(spawnCount(log) - n0, 12, "採用 4 P × 3 回");
    assert.equal(readFileSync(vlog, "utf8").trim().split("\n").length, 4, "照合の関数は P ごとに 1 回（写しは P ごとに 1 本）");
    const cond = readJson(join(out, "conditions.json"));
    assert.equal(cond.schema, V8);
    assert.deepEqual(cond.params.stage_from, { kind: "frozen-stage-input-set", id: "stage-set-640", version: 1, sha256: setSha });
    const absent = IDS545.filter((id) => !launched.includes(id.split("-")[0]));
    assert.deepEqual(cond.stage_input_absent, { count: 18, ids: absent }, "P1〜P5（組の missing）と人が除外した P7");
    assert.deepEqual(cond.child_args.filter((a) => a.argv === null).map((a) => a.id), absent);
    for (const pid of launched) {
      const cpCopy = readFileSync(join(setDir, "inputs", `${pid}-r2`, "stage-checkpoint-t2-b1.json")), recCopy = readFileSync(join(setDir, "inputs", `${pid}-r2`, "stage-run.json"));
      const digest = JSON.parse(recCopy.toString("utf8")).checkpoints.find((c) => c.boundary === "t2-b1").output_digest;
      for (const rr of [1, 2, 3]) {
        const id = `${pid}-r${rr}`, dir = join(out, id);
        assert.deepEqual(readFileSync(join(dir, "stage-input", "stage-checkpoint-t2-b1.json")), cpCopy, `${id}: 全反復に同じ checkpoint`);
        assert.deepEqual(readFileSync(join(dir, "stage-input", "stage-run.json")), recCopy, `${id}: 全反復に同じ記録`);
        assert.deepEqual(readJson(join(dir, "received-argv.json")).slice(-2), ["--stage-input", join(dir, "stage-input", "stage-checkpoint-t2-b1.json")]);
        assert.deepEqual(cond.params.stage_inputs.find((x) => x.id === id), { id, checkpoint_sha256: sha256(cpCopy), record_sha256: sha256(recCopy), output_digest: digest, record_file: "stage-run.json" });
      }
    }
    for (const id of absent) assert.deepEqual(cond.params.stage_inputs.find((x) => x.id === id), { id, absent: true });
    assert.equal(cond.signature, conditionsSignature(cond));
    // 同じ組の再開は通り、組の SHA が条件の署名に入る
    rmSync(join(out, "P6-r1"), { recursive: true, force: true });
    const rr = runAgent(repo, out, [...stageArgs638(fz, ["--stage-start", "write", "--stage-from", setDir]), "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(rr.status, 0, rr.stderr);
    // --make-pairs：入力のある本だけの対と、組の SHA
    const pairsPath = join(base, "pairs.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", setDir, "--runs", "3"]);
    assert.equal(mp.status, 0, mp.stderr);
    const pv = readJson(pairsPath);
    assert.equal(pv.pairs.length, 12);
    assert.deepEqual(pv.stage, { start: "write", end: "judge", stage_from_sha256: setSha });
    // 上流の計測の出力先を渡す今の形はそのまま（条件の stage_from は上流の条件の SHA・署名・範囲）
    const o2 = join(base, "b1-up");
    const r2 = runAgent(repo, o2, stageArgs638(fz, ["--stage-start", "write", "--stage-from", up]), { FAKE_SPAWN_LOG: log });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(Object.keys(readJson(join(o2, "conditions.json")).params.stage_from), ["conditions_sha256", "signature", "range"]);
  });
});

test("#640 (b) 組の照合：人の採否が未反映（review なし）・署名の不一致・写しの SHA の不一致・境界の違い・(b) の違い・経路の違い・旗の組の違い・対象の P が組に無い・写しが今の dist の照合に落ちる組は、exit 4 と固定の符号で子 0 本・何も書かない", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const n0 = spawnCount(log);
    const refused = (label, setDir, code, ids = null, pl = "v1.2") => {
      const o = join(base, `out-${label}`);
      assertStageRefused(runAgent(repo, o, stageArgs638(fz, ["--stage-start", "write", "--stage-from", setDir], pl), { FAKE_SPAWN_LOG: log }), code, ids, log, n0, o, label);
    };
    refused("review", makeStageSet640(join(base, "s-review"), up, fz, { review: false }), "stage-from:set-review");
    const sig = makeStageSet640(join(base, "s-sig"), up, fz);
    const t = readJson(join(sig, FROZEN_STAGE_SET_FILE));
    t.version = 2;
    writeFileSync(join(sig, FROZEN_STAGE_SET_FILE), JSON.stringify(t, null, 1));
    refused("signature", sig, "stage-from:set-signature");
    const copy = makeStageSet640(join(base, "s-copy"), up, fz);
    appendFileSync(join(copy, "inputs", "P8-r2", "stage-checkpoint-t2-b1.json"), " ");
    refused("sha256", copy, "stage-from:set-sha256", ["P8"]);
    refused("boundary", makeStageSet640(join(base, "s-boundary"), up, fz, { boundary: "t1-t2" }), "stage-from:set-boundary");
    refused("plan-set", makeStageSet640(join(base, "s-plan"), up, fz, { edit: (s) => { s.plan_set.sha256 = sha256("another-plan-set"); } }), "stage-from:set-plan-set");
    const good = makeStageSet640(join(base, "s-good"), up, fz);
    refused("pipeline", good, "stage-from:set-pipeline", null, "v1.1a");
    refused("flags", makeStageSet640(join(base, "s-flags"), up, fz, { edit: (s) => { s.source.v12_flags = { ledger: true, ids: false }; } }), "stage-from:set-pipeline");
    refused("pattern", makeStageSet640(join(base, "s-pattern"), up, fz, { adopted: PIDS545.slice(5, 9), exclude: [] }), "stage-from:set-pattern", ["P10"]);
    refused("digest", makeStageSet640(join(base, "s-digest"), up, fz, { edit: (s) => { s.adopted[0].checkpoint.output_digest = sha256("x"); } }), "stage-from:set-digest", ["P6"]);
    // 今の dist の旗の組が写しの checkpoint の版と違う（組の source も同じ旗にそろえて、照合の関数で落ちることを見る）
    writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index638({ ledger: "ledger-b" }));
    refused("verify", good, "stage-from:stage-input:version", ["P6"]);
  });
});

// ── #713：境界 t1-t2 の上流の入力は、台帳の全体の指紋でなく上流の台帳の部分の指紋で照らす。README §10.8
// 偽物の工場の dist：#638 の偽物の照合を、工場の #713 の規則に差し替える（入力の境界が t1-t2 なら checkpoint の版の ledger_upstream と渡した ledgerUpstream が
// どちらも 64 桁の 16 進で同じこと、t2-b1 なら今のまま ledger が同じこと。旗の組はどちらも同じこと）。入口（cli.js）は v1.2 のとき checkpoint の版に
// 境界ごとの ledger_upstream（t1-t2 は部分の指紋、t2-b1 は null）を足す。package の入口（index.js）は部分の指紋の関数を出す（出さない・例外・形の違う値も作れる）
const fakeStageLib713 = fakeStageLib
  .replace('export const STAGE_BUDGET_SCOPE = "stage-run";', 'export const STAGE_BUDGET_SCOPE = "stage-run";\nexport const STAGE_START_ALIASES_V12 = { "c1-alias": "name-table" };')
  .replace(
    "  if (h(JSON.stringify(cp)) !== declared.output_digest)",
    '  if (process.env.FAKE_VERIFY_V12_LOG) appendFileSync(process.env.FAKE_VERIFY_V12_LOG, JSON.stringify(input.v12 ?? null) + "\\n");\n' +
      '  const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);\n' +
      '  if (input.v12 !== undefined) {\n' +
      '    const ledgerOk = needed === "t1-t2" ? hex(cp.versions?.ledger_upstream) && hex(input.v12.ledgerUpstream) && cp.versions.ledger_upstream === input.v12.ledgerUpstream : cp.versions?.ledger === input.v12.ledger;\n' +
      '    if (!ledgerOk || JSON.stringify(cp.versions?.flags) !== JSON.stringify(input.v12.flags)) return fail("stage-input:version");\n' +
      "  }\n" +
      "  if (h(JSON.stringify(cp)) !== declared.output_digest)",
  );
const fakeStageCli713 = fakeStageCli638
  .replace(
    "const v12 = idx === null ? null : { ledger: await idx.propertyLedgerSha256(), flags: idx.V12_PIPELINE_FLAGS };",
    "let upstream; try { upstream = typeof idx?.upstreamLedgerSha256 === \"function\" ? await idx.upstreamLedgerSha256() : undefined; } catch { upstream = undefined; }\nconst v12 = idx === null ? null : { ledger: await idx.propertyLedgerSha256(), upstream, flags: idx.V12_PIPELINE_FLAGS };",
  )
  .replace("{ ledger: v12.ledger, flags: v12.flags, call_limits: null }", "{ ledger: v12.ledger, ...(v12.upstream === undefined ? {} : { ledger_upstream: boundary === \"t1-t2\" ? v12.upstream : null }), flags: v12.flags, call_limits: null }");
assert.ok(fakeStageLib713.includes("ledgerUpstream") && fakeStageCli713.includes("ledger_upstream") && fakeStageCli713.includes("upstreamLedgerSha256"), "偽物の差し替えが当たらない");
const UP713 = "e".repeat(64);
/** package の入口：upstream が文字列なら部分の指紋の関数がそれを返し、null なら関数を出さず、"throw" なら例外、{ value } なら任意の値を返す */
const v12Index713 = ({ flags = FLAGS638, ledger = "ledger-a", upstream = UP713 } = {}) =>
  v12Index638({ flags, ledger }) +
  (upstream === null ? "" : upstream === "throw" ? 'export async function upstreamLedgerSha256() { throw new Error("x"); }\n' : `export async function upstreamLedgerSha256() { return ${JSON.stringify(typeof upstream === "object" ? upstream.value : upstream)}; }\n`);
function makeStageRepo713(base, name = "stage713", index = {}) {
  const repo = makeStageRepo638(base, name);
  writeFileSync(join(repo, "packages/factory/dist/v11a/bundle-v11a.js"), fakeStageLib713);
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeStageCli713);
  writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index713(index));
  return repo;
}
const setIndex713 = (repo, index) => writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index713(index));
const readLog = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("#713 (a) 開始 T2（境界 t1-t2）：両方の形（上流の計測・凍結した組）で、照合の関数に dist の部分の指紋の今の値を渡し、上流の checkpoint の ledger_upstream で照らす。全体の指紋だけが違う dist は受け、部分の指紋が違う dist は stage-from:stage-input:version。上流の checkpoint は t1-t2 に部分の指紋、t2-b1 に null を持つ", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo713(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const upCp = (b) => readJson(join(up, "P6-r1", "bundle", `stage-checkpoint-${b}.json`));
    assert.equal(upCp("t1-t2").versions.ledger_upstream, UP713);
    assert.equal(upCp("t2-b1").versions.ledger_upstream, null);
    const setDir = makeStageSet640(join(base, "set"), up, fz, { boundary: "t1-t2" });
    for (const [form, from, verifies] of [["up", up, 15], ["set", setDir, 4]]) {
      const vlog = join(base, `v12-${form}.log`), n0 = spawnCount(log);
      const r = runAgent(repo, join(base, `t2-${form}`), stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", from]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlog });
      assert.equal(r.status, 0, `${form}: ${r.stderr}`);
      assert.ok(spawnCount(log) > n0, form);
      const seen = readLog(vlog);
      assert.equal(seen.length, verifies, form);
      for (const v of seen) assert.deepEqual(v, { ledger: "ledger-a", ledgerUpstream: UP713, flags: FLAGS638 }, `${form}: dist の公開の値を渡す`);
      // 全体の指紋だけが違う dist（T2 から後ろだけを変えた台帳）：受ける
      setIndex713(repo, { ledger: "ledger-b" });
      const rb = runAgent(repo, join(base, `t2-${form}-ledger-b`), stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", from]), { FAKE_SPAWN_LOG: log });
      assert.equal(rb.status, 0, `${form}: ${rb.stderr}`);
      // 部分の指紋が違う dist：断る（子 0 本・何も書かない）
      setIndex713(repo, { upstream: "f".repeat(64) });
      const n1 = spawnCount(log), o = join(base, `t2-${form}-up-f`);
      assertStageRefused(runAgent(repo, o, stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", from]), { FAKE_SPAWN_LOG: log }), "stage-from:stage-input:version", [form === "up" ? IDS545[15] : "P6"], log, n1, o, `${form}-mismatch`);
      setIndex713(repo, {});
    }
  });
});

test("#713 (b) 開始 T2：部分の指紋の関数が無い・例外・返りの値の形の異常（64 桁の 16 進でない）の dist は、両方の形・比較元の群でも stage:dist-unreadable（exit 3・子 0 本・何も書かない）。上流の checkpoint の ledger_upstream の欠け・null・形の違いは stage-from:stage-input:version", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo713(base), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const setDir = makeStageSet640(join(base, "set"), up, fz, { boundary: "t1-t2" });
    const n0 = spawnCount(log);
    for (const [label, upstream] of [["absent", null], ["throw", "throw"], ["upper", UP713.toUpperCase()], ["short", "e".repeat(63)], ["number", { value: 1 }], ["null", { value: null }]]) {
      setIndex713(repo, { upstream });
      for (const [form, from] of [["up", up], ["set", setDir]]) {
        const o = join(base, `out-${label}-${form}`);
        const r = runAgent(repo, o, stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", from]), { FAKE_SPAWN_LOG: log });
        assertRefused(r, "stage:dist-unreadable", log, n0, `${label}-${form}`);
        oneLine(r, `${label}-${form}`);
        assertNothingWritten(o, `${label}-${form}`);
      }
    }
    setIndex713(repo, {});
    // 比較元の群の dist に部分の関数が無い：子を起こす前に断る
    const baseline = makeStageRepo713(base, "base-old", { upstream: null });
    const pairsPath = join(base, "pairs.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "test-spec", "--stage-from", up, "--runs", "3"]);
    assert.equal(mp.status, 0, mp.stderr);
    const cmp = join(base, "cmp");
    const rc = runAgent(repo, cmp, ["--compare", "--baseline", baseline, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "test-spec", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4"], { FAKE_SPAWN_LOG: log });
    assertRefused(rc, "stage:dist-unreadable", log, n0, "baseline");
    assertNothingWritten(cmp, "baseline");
    // 両群に部分の関数があれば同じ比較は通る
    const both = makeStageRepo713(base, "base-new");
    const ok = runAgent(repo, join(base, "cmp-ok"), ["--compare", "--baseline", both, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "test-spec", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4"], { FAKE_SPAWN_LOG: log });
    assert.equal(ok.status, 0, ok.stderr);
    // 上流の checkpoint の新しい欄の欠け・null・形の違い（出力ダイジェストは書き直す）：両方の形で断る
    const n1 = spawnCount(log);
    for (const [label, edit] of [["missing", (v) => { delete v.ledger_upstream; }], ["null", (v) => { v.ledger_upstream = null; }], ["upper", (v) => { v.ledger_upstream = UP713.toUpperCase(); }]]) {
      const bad = tamperUpstream(up, join(base, `up-${label}`), IDS545[15], (dir) => {
        const p = join(dir, "stage-checkpoint-t1-t2.json"), cp = readJson(p);
        edit(cp.versions);
        writeFileSync(p, JSON.stringify(cp, null, 2) + "\n");
        const rp = join(dir, "stage-run.json"), rec = readJson(rp);
        rec.checkpoints.find((c) => c.boundary === "t1-t2").output_digest = sha256(JSON.stringify(cp));
        writeFileSync(rp, JSON.stringify(rec, null, 2) + "\n");
      });
      const o = join(base, `out-cp-${label}`);
      assertStageRefused(runAgent(repo, o, stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", bad]), { FAKE_SPAWN_LOG: log }), "stage-from:stage-input:version", [IDS545[15]], log, n1, o, label);
      const s = makeStageSet640(join(base, `set-${label}`), bad, fz, { boundary: "t1-t2", pick: (pid) => (pid === "P6" ? IDS545[15] : `${pid}-r2`) });
      const os = join(base, `out-set-${label}`);
      assertStageRefused(runAgent(repo, os, stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", s]), { FAKE_SPAWN_LOG: log }), "stage-from:stage-input:version", ["P6"], log, n1, os, `set-${label}`);
    }
  });
});

test("#713 (c) 開始 B1（境界 t2-b1）は今のまま：部分の指紋の関数を取らず・呼ばない（無い・例外の dist も受ける）、照合の関数に部分の値を渡さない。新しい欄の無い今までの上流の入力も受け、全体の指紋の違う dist は新しい欄が null でも stage-from:stage-input:version", async () => {
  await withRepo(async (base) => {
    // 今までの上流の入力（新しい欄の無い t2-b1。#638 の偽物の入口が書いたもの）
    const old = makeStageRepo638(base, "old"), fzOld = frozen545(base, old), log = join(base, "spawn.log");
    const upOld = runUpstream638(old, join(base, "up-old"), fzOld, log);
    assert.ok(!("ledger_upstream" in readJson(join(upOld, "P6-r1", "bundle", "stage-checkpoint-t2-b1.json")).versions));
    const repo = makeStageRepo713(base), fz = frozen545(base, repo);
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    for (const [label, upstream] of [["absent", null], ["throw", "throw"], ["bad", { value: "x" }]]) {
      setIndex713(repo, { upstream });
      for (const [form, from] of [["up-old", upOld], ["up", up], ["set", makeStageSet640(join(base, `set-${label}`), up, fz)], ["set-old", makeStageSet640(join(base, `set-old-${label}`), upOld, fzOld)]]) {
        const vlog = join(base, `v12-${label}-${form}.log`);
        const r = runAgent(repo, join(base, `b1-${label}-${form}`), stageArgs638(form.endsWith("old") ? fzOld : fz, ["--stage-start", "write", "--stage-from", from]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlog });
        assert.equal(r.status, 0, `${label}-${form}: ${r.stderr}`);
        for (const v of readLog(vlog)) assert.deepEqual(v, { ledger: "ledger-a", flags: FLAGS638 }, `${label}-${form}: 部分の値を渡さない`);
      }
    }
    // 全体の指紋が違う dist：新しい欄が null の入力も、欄の無い今までの入力も断る（子 0 本・何も書かない）
    setIndex713(repo, { ledger: "ledger-b" });
    const n0 = spawnCount(log);
    for (const [form, from, f] of [["up", up, fz], ["up-old", upOld, fzOld]]) {
      const o = join(base, `out-ledger-${form}`);
      assertStageRefused(runAgent(repo, o, stageArgs638(f, ["--stage-start", "write", "--stage-from", from]), { FAKE_SPAWN_LOG: log }), "stage-from:stage-input:version", [IDS545[15]], log, n0, o, form);
    }
  });
});

test("#713 (d) 実の工場の dist の値の受け渡し：package の入口を実の dist（pnpm build の出力）にすると、開始 T2 の照合の関数に実の部分の指紋（64 桁の 16 進・全体の指紋と別の値）を渡し、上流が書いた ledger_upstream と同じ値で受ける。開始 B1 には部分の値を渡さない", async () => {
  const realIndex = resolve(here, "../../../../../../packages/factory/dist/index.js");
  assert.ok(existsSync(realIndex), "実の工場の dist が無い（先に pnpm build）");
  const real = await import(pathToFileURL(realIndex).href);
  const realUpstream = await real.upstreamLedgerSha256(), realLedger = await real.propertyLedgerSha256();
  assert.match(realUpstream, /^[0-9a-f]{64}$/);
  assert.notEqual(realUpstream, realLedger);
  await withRepo(async (base) => {
    const repo = makeStageRepo713(base, "real");
    writeFileSync(join(repo, "packages/factory/dist/index.js"), `export * from ${JSON.stringify(pathToFileURL(realIndex).href)};\n`);
    const fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    assert.equal(readJson(join(up, "P6-r1", "bundle", "stage-checkpoint-t1-t2.json")).versions.ledger_upstream, realUpstream);
    const flags = JSON.parse(JSON.stringify(real.V12_PIPELINE_FLAGS));
    const vlog = join(base, "v12-t2.log");
    const r = runAgent(repo, join(base, "t2"), stageArgs638(fz, ["--stage-start", "test-spec", "--stage-from", up]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlog });
    assert.equal(r.status, 0, r.stderr);
    const seen = readLog(vlog);
    assert.equal(seen.length, 15);
    for (const v of seen) assert.deepEqual(v, { ledger: realLedger, ledgerUpstream: realUpstream, flags });
    const vlogB = join(base, "v12-b1.log");
    const rb = runAgent(repo, join(base, "b1"), stageArgs638(fz, ["--stage-start", "write", "--stage-from", up]), { FAKE_SPAWN_LOG: log, FAKE_VERIFY_V12_LOG: vlogB });
    assert.equal(rb.status, 0, rb.stderr);
    for (const v of readLog(vlogB)) assert.deepEqual(v, { ledger: realLedger, flags });
  });
});

// ── #664：段ごとの effort の口（--stage-effort <段>=<値>。繰り返し可）。段と値の集合は工場の dist の package の入口の parseStageEfforts が持つ。
// 偽物の dist は合成の段・値（s-one・s-two・s-three と lo・hi）で、道具がその名前を知らなくても通ることを確かめる
const fakeParse664 = String.raw`export function parseStageEfforts(values) {
  const S = ["s-one", "s-two", "s-three"], V = ["lo", "hi"], out = {};
  for (const v of values) {
    const i = v.indexOf("=");
    if (i <= 0) return { code: "stage-effort:format" };
    const s = v.slice(0, i), e = v.slice(i + 1);
    if (!S.includes(s)) return { code: "stage-effort:stage" };
    if (!V.includes(e)) return { code: "stage-effort:value" };
    if (s in out) return { code: "stage-effort:duplicate" };
    out[s] = e;
  }
  return { stageEfforts: out };
}
`;
const EFFORT_ARGS664 = ["--stage-effort", "s-two=lo", "--stage-effort", "s-one=hi"];
/** 子の引数から段ごとの effort の旗の組を除く（群・計測の違いの照合用） */
const withoutEffortArgs = (argv) => argv.filter((a, i, all) => !(a === "--stage-effort" || all[i - 1] === "--stage-effort"));

test("#664 (7) v1.2 の一気通貫：--stage-effort を 2 つ付けると子の引数の末尾に同じ順で渡り、条件の params.stage_efforts が段 → 値（付けた順）で署名に入る。付けなければ欄が無く、欄と旗を除けば条件と子の引数は同じ", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "a"), { index: v12Index(FLAGS557) + fakeParse664 }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const run = (name, extra) => {
      const out = join(base, name), r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", ...extra], { FAKE_SPAWN_LOG: log });
      assert.equal(r.status, 0, r.stderr);
      return { out, cond: readJson(join(out, "conditions.json")), argv: readJson(join(out, "P1-r1", "received-argv.json")) };
    };
    const plain = run("out-plain", []), tuned = run("out-tuned", EFFORT_ARGS664);
    assert.deepEqual(tuned.argv.slice(-6), ["--pipeline", "v1.2", ...EFFORT_ARGS664]);
    assert.deepEqual(withoutEffortArgs(tuned.argv).map((a) => a.replace(tuned.out, plain.out)), plain.argv, "ほかの引数は付けない走りと同じ");
    assert.equal(tuned.cond.schema, V7);
    assert.deepEqual(tuned.cond.params.stage_efforts, { "s-two": "lo", "s-one": "hi" });
    assert.deepEqual(Object.keys(tuned.cond.params.stage_efforts), ["s-two", "s-one"], "付けた順");
    assert.ok(!("stage_efforts" in plain.cond.params), "付けなければ欄が無い");
    assert.equal(tuned.cond.signature, conditionsSignature(tuned.cond));
    const { stage_efforts: _e, ...tunedParams } = tuned.cond.params;
    assert.deepEqual(tunedParams, plain.cond.params, "欄を除けば params は同じ");
    assert.deepEqual(Object.keys(plain.cond.params), Object.keys(tunedParams));
    const unsigned = { ...tuned.cond, params: tunedParams, measurement_id: plain.cond.measurement_id, child_args: tuned.cond.child_args.map((x) => ({ ...x, argv: withoutEffortArgs(x.argv).map((a) => a.replace(tuned.out, plain.out)) })) };
    assert.equal(conditionsSignature(unsigned), plain.cond.signature, "欄と旗を除けば署名は付けない走りと同じ（付けない条件のバイト列は今のまま）");
    assert.ok(!readFileSync(runAgentFile, "utf8").includes("s-one"), "道具に段の名前を書かない");
  });
});

test("#664 (7) 組めない指定と断り：v1・v1.1α・経路の省略との組と値の無い旗は flags:conflict、工場の関数が断った段・値・重複・形は工場の符号、関数の無い dist は stage-effort:unavailable。どれも exit 3・子 0 本・何も書かない", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "b"), { index: v12Index(FLAGS557) + fakeParse664 }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const bare = makeV12Repo(join(base, "b-bare")), fzBare = frozen557(base, bare, "fz-bare");
    const cases = [
      [repo, fz, ["--pipeline", "v1.1a", "--stage-effort", "s-one=lo"], "flags:conflict", "v1.1a"],
      [repo, fz, ["--pipeline", "v1", "--stage-effort", "s-one=lo"], "flags:conflict", "v1"],
      [repo, fz, ["--stage-effort", "s-one=lo"], "flags:conflict", "経路の省略"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort"], "flags:conflict", "値の無い旗"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort", "--runs"], "flags:conflict", "値が旗"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort", "s-nine=lo"], "stage-effort:stage", "知らない段"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort", "s-one=mid"], "stage-effort:value", "知らない値"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort", "s-one=lo", "--stage-effort", "s-one=hi"], "stage-effort:duplicate", "重複"],
      [repo, fz, ["--pipeline", "v1.2", "--stage-effort", "s-one"], "stage-effort:format", "形"],
      [bare, fzBare, ["--pipeline", "v1.2", "--stage-effort", "s-one=lo"], "stage-effort:unavailable", "関数の無い dist"],
    ];
    for (const [r0, f, extra, code, label] of cases) {
      const out = join(base, `out-${label}`), n0 = spawnCount(log);
      const r = runAgent(r0, out, ["--only", "P1", "--runs", "1", "--build-from", f, ...extra], { FAKE_SPAWN_LOG: log });
      assertRefused(r, code, log, n0, label);
      assertNothingWritten(out, label);
    }
    // 段の旗との組でも v1.1α は組めない
    const stage = makeStageRepo638(base, "stage-b");
    writeFileSync(join(stage, "packages/factory/dist/index.js"), v12Index638() + fakeParse664);
    const fzs = frozen545(base, stage), n1 = spawnCount(log), o = join(base, "out-stage-v11a");
    assertRefused(runAgent(stage, o, stageArgs638(fzs, ["--stage-start", "name-table", "--stage-end", "test-spec", "--stage-effort", "s-one=lo"], "v1.1a"), { FAKE_SPAWN_LOG: log }), "flags:conflict", log, n1, "v1.1α の段の走り");
    assertNothingWritten(o, "v1.1α の段の走り");
  });
});

test("#664 (7'') 再開：同じ stage_efforts の --resume は残りだけを起こし、値・順・有無を変えた --resume は resume:signature で断る（子 0・出力先は変わらない）", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "c"), { index: v12Index(FLAGS557) + fakeParse664 }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const out = join(base, "out-r"), args = ["--only", "P1", "--runs", "3", "--concurrency", "1", "--build-from", fz, "--pipeline", "v1.2"];
    assert.equal(runAgent(repo, out, [...args, ...EFFORT_ARGS664], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r3"), { recursive: true, force: true });
    const before = treeOf(out), n0 = spawnCount(log);
    for (const [extra, label] of [[["--stage-effort", "s-two=hi", "--stage-effort", "s-one=hi"], "値"], [["--stage-effort", "s-one=hi", "--stage-effort", "s-two=lo"], "順"], [[], "有無"]]) {
      assertRefused(runAgent(repo, out, [...args, ...extra, "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n0, label);
      assert.deepEqual(treeOf(out), before, label);
    }
    const rr = runAgent(repo, out, [...args, ...EFFORT_ARGS664, "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(rr.status, 0, rr.stderr);
    assert.equal(spawnCount(log), n0 + 1);
    assert.deepEqual(readJson(join(out, "P1-r3", "received-argv.json")).slice(-4), EFFORT_ARGS664);
  });
});

test("#664 (7') v1.2 の段の旗との組：子の引数の末尾は段の旗のあとに --stage-effort（付けた順）、条件 v8 の params.stage_efforts に載る。--compare の段だけの対の比較では after（候補）の子にだけ渡し、両群の条件の照合は通り、比較の記録の群に両群の値（before は null）を並べる", async () => {
  await withRepo(async (base) => {
    const repo = makeStageRepo638(base, "cand"), baseline = makeStageRepo638(base, "base"), fz = frozen545(base, repo), log = join(base, "spawn.log");
    writeFileSync(join(repo, "packages/factory/dist/index.js"), v12Index638() + fakeParse664);
    const out1 = join(base, "o1"), r1 = runAgent(repo, out1, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "name-table", "--stage-end", "test-spec", ...EFFORT_ARGS664], { FAKE_SPAWN_LOG: log });
    assert.equal(r1.status, 0, r1.stderr);
    const c1 = readJson(join(out1, "conditions.json"));
    assert.equal(c1.schema, V8);
    assert.deepEqual(c1.params.stage_efforts, { "s-two": "lo", "s-one": "hi" });
    assert.equal(c1.signature, conditionsSignature(c1));
    assert.deepEqual(readJson(join(out1, "P1-r1", "received-argv.json")).slice(-10), ["--pipeline", "v1.2", "--stage-start", "name-table", "--stage-end", "test-spec", ...EFFORT_ARGS664]);
    // 段だけの対の比較（開始 B1）：対のファイルは付けても付けなくても同じバイト列
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const pairsPath = join(base, "pairs.json"), pairsTuned = join(base, "pairs-tuned.json");
    const mpArgs = (p, extra) => ["--make-pairs", p, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--runs", "3", ...extra];
    assert.equal(runAgent(repo, join(base, "unused"), mpArgs(pairsPath, [])).status, 0);
    assert.equal(runAgent(repo, join(base, "unused2"), mpArgs(pairsTuned, EFFORT_ARGS664)).status, 0);
    assert.equal(readFileSync(pairsTuned, "utf8"), readFileSync(pairsPath, "utf8"));
    const cmpArgs = (extra) => ["--compare", "--baseline", baseline, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4", ...extra];
    const out = join(base, "cmp"), n0 = spawnCount(log);
    const r = runAgent(repo, out, cmpArgs(EFFORT_ARGS664), { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log) - n0, 30);
    const pv = readJson(pairsPath), id = `${pv.pairs[0].pid}-r${pv.pairs[0].r}`;
    const before = readJson(join(out, "before", id, "received-argv.json")), after = readJson(join(out, "after", id, "received-argv.json"));
    assert.deepEqual(after.slice(-4), EFFORT_ARGS664);
    assert.ok(!before.includes("--stage-effort"), "比較元の群の子には付けない");
    assert.deepEqual(withoutEffortArgs(after).slice(1).map((a) => a.replace(join(out, "after"), "<g>")), before.slice(1).map((a) => a.replace(join(out, "before"), "<g>")), "群の子の引数の違いは入口（群の checkout）と段ごとの effort だけ");
    const cb = readJson(join(out, "before", "conditions.json")), ca = readJson(join(out, "after", "conditions.json"));
    assert.ok(!("stage_efforts" in cb.params));
    assert.deepEqual(ca.params.stage_efforts, { "s-two": "lo", "s-one": "hi" });
    for (const c of [cb, ca]) assert.equal(c.signature, conditionsSignature(c));
    const rec = readJson(join(out, "comparison.json"));
    assert.deepEqual([rec.groups.before.stage_efforts, rec.groups.after.stage_efforts], [null, { "s-two": "lo", "s-one": "hi" }]);
    // 付けない比較の記録の群には欄が無い（今のまま）
    const outPlain = join(base, "cmp-plain");
    assert.equal(runAgent(repo, outPlain, cmpArgs([]), { FAKE_SPAWN_LOG: log }).status, 0);
    const recPlain = readJson(join(outPlain, "comparison.json"));
    for (const g of ["before", "after"]) assert.ok(!("stage_efforts" in recPlain.groups[g]), g);
  });
});

test("#664 (7'') 群の組 v1.1a,v1.2 の比較：--stage-effort は候補の群（v1.2）の子にだけ渡り、比較元（v1.1a）の子と条件には無い。比較の記録の群に両群の値（v1.1a は null）。候補が v1.2 でない組（省略の v1,v1.1a）は flags:conflict", async () => {
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "e"), { index: v12Index(FLAGS557) + fakeParse664 }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const pairs = join(base, "pairs-e.json");
    assert.equal(runAgent(repo, join(base, "unused"), ["--make-pairs", pairs, "--build-from", fz, "--runs", "1", "--compare-pipelines", "v1.1a,v1.2", ...EFFORT_ARGS664]).status, 0);
    const out = join(base, "out-e");
    const r = runAgent(repo, out, ["--compare", "--baseline", repo, "--pairs", pairs, "--build-from", fz, "--budget-usd", "100", "--concurrency", "4", "--compare-pipelines", "v1.1a,v1.2", ...EFFORT_ARGS664], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    const a1 = readJson(join(out, "v1.1a", "P1-r1", "received-argv.json")), a2 = readJson(join(out, "v1.2", "P1-r1", "received-argv.json"));
    assert.deepEqual(a2.slice(-6), ["--pipeline", "v1.2", ...EFFORT_ARGS664]);
    assert.deepEqual(a1.slice(-2), ["--pipeline", "v1.1a"]);
    const c1 = readJson(join(out, "v1.1a", "conditions.json")), c2 = readJson(join(out, "v1.2", "conditions.json"));
    assert.ok(!("stage_efforts" in c1.params));
    assert.deepEqual(c2.params.stage_efforts, { "s-two": "lo", "s-one": "hi" });
    const rec = readJson(join(out, "comparison.json"));
    assert.deepEqual([rec.groups["v1.1a"].stage_efforts, rec.groups["v1.2"].stage_efforts], [null, { "s-two": "lo", "s-one": "hi" }]);
    const n0 = spawnCount(log), o = join(base, "out-v1");
    const p1 = join(base, "pairs-v1.json");
    assert.equal(runAgent(repo, join(base, "unused-v1"), ["--make-pairs", p1, "--build-from", fz, "--runs", "1"]).status, 0);
    assertRefused(runAgent(repo, o, ["--compare", "--baseline", repo, "--pairs", p1, "--build-from", fz, "--budget-usd", "100", ...EFFORT_ARGS664], { FAKE_SPAWN_LOG: log }), "flags:conflict", log, n0, "候補が v1.1a");
    assertNothingWritten(o, "候補が v1.1a");
  });
});

test("#664 実の工場の dist の段と値：package の入口を実の dist（pnpm build の出力）にすると、実の段の名前と値の --stage-effort を受けて条件に写し、配線していない段は工場の符号で断る（子 0 本）", async () => {
  const realIndex = resolve(here, "../../../../../../packages/factory/dist/index.js");
  assert.ok(existsSync(realIndex), "実の工場の dist が無い（先に pnpm build）");
  const real = await import(pathToFileURL(realIndex).href);
  assert.equal(typeof real.parseStageEfforts, "function");
  const [stage] = real.STAGE_EFFORT_STAGES, [value] = real.REASONING_EFFORTS;
  await withRepo(async (base) => {
    const repo = makeV12Repo(join(base, "real"), { index: `export * from ${JSON.stringify(pathToFileURL(realIndex).href)};\n` }), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const out = join(base, "out"), r = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-effort", `${stage}=${value}`], { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(join(out, "conditions.json")).params.stage_efforts, { [stage]: value });
    const n0 = spawnCount(log), o = join(base, "out-bad");
    assertRefused(runAgent(repo, o, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--stage-effort", `repair=${value}`], { FAKE_SPAWN_LOG: log }), "stage-effort:stage", log, n0, "配線していない段");
    assertNothingWritten(o, "配線していない段");
  });
});

// ── #776：Ollama の段の出力の上限の表（`--provider ollama` の v1.2 の走り。README §5.1）
// dist の `ollama.js` が公開する表（段 → 値）を対象の各 checkout から独立に読み、条件の params.ollama_stage_output_limits に写して
// 署名に入れる。表が無い・形が違えば provider:ollama-limits-unavailable（子 0 本）。同じ表どうしの比較と再開は通り、表の違う群は compare:ollama-limits-differ
const FAKE_OLLAMA_LIMITS_TABLE = { "semantic-check": 32768, "decl-check": 32768, repair: 65536 };
const keyEnvExportOf = (name) => `export const OLLAMA_API_KEY_ENV = ${JSON.stringify(name)};\n`;
const ollamaJsOf = (limits) => `export const DEFAULT_OLLAMA_MODEL = "fake-ollama-model";\n${limits ?? ""}`;

/** #776：Ollama に対応した v1.2 のリポジトリ（旗の組・OLLAMA_API_KEY_ENV・上限の表） */
function makeV12OllamaRepo(base, { limits = FAKE_OLLAMA_LIMITS, index = v12Index(FLAGS557), keyEnv = "OLLAMA_API_KEY" } = {}) {
  const repo = makeV12Repo(base, { index });
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeV12Cli + keyEnvExportOf(keyEnv));
  writeFileSync(join(repo, "packages/factory/dist/ollama.js"), ollamaJsOf(limits));
  return repo;
}

/** #776：Ollama に対応した段の走り（v1.2）のリポジトリ */
function makeStageOllamaRepo(base, name, { limits = FAKE_OLLAMA_LIMITS, index = {} } = {}) {
  const repo = makeStageRepo638(base, name, index);
  writeFileSync(join(repo, "packages/factory/dist/cli.js"), fakeStageCli638 + keyEnvExportOf("OLLAMA_API_KEY"));
  writeFileSync(join(repo, "packages/factory/dist/ollama.js"), ollamaJsOf(limits));
  return repo;
}

test("#776 --provider ollama の v1.2 の計測：条件に params.ollama_stage_output_limits（dist の表）が入り署名が変わる。省略・明示 openai と Ollama の v1.1a には欄が無い", async () => {
  await withRepo(async (base) => {
    const repo = makeV12OllamaRepo(join(base, "a")), fz = frozen557(base, repo), log = join(base, "spawn.log");
    const runs = ["--only", "P1", "--runs", "1", "--build-from", fz];
    // 省略と明示 openai は同じ出力先で比べる（署名は measurement_id を含むので、バイト列で比べるには同じ出力先が要る）
    const outPair = join(base, "out-openai-pair");
    const { omitted, explicit } = omittedAndExplicit(repo, outPair, [...runs, "--pipeline", "v1.2"]);
    assert.deepEqual(explicit, omitted, "省略と明示 openai は同じ条件・署名・argv");
    const openai = readJson(join(outPair, "conditions.json"));
    assert.ok(!("ollama_stage_output_limits" in openai.params) && !("provider" in openai.params));
    assert.equal(conditionsSignature(openai), openai.signature);
    // Ollama の v1.2：条件に provider と表が載り、署名が中身と合う
    const outOllama = join(base, "out-ollama");
    const ro = runAgent(repo, outOllama, [...runs, "--pipeline", "v1.2", "--provider", "ollama"], { FAKE_SPAWN_LOG: log });
    assert.equal(ro.status, 0, ro.stderr);
    const ollama = readJson(join(outOllama, "conditions.json"));
    assert.equal(ollama.params.provider, "ollama");
    assert.deepEqual(ollama.params.ollama_stage_output_limits, FAKE_OLLAMA_LIMITS_TABLE);
    assert.equal(conditionsSignature(ollama), ollama.signature);
    // 条件の差は provider の 2 欄・表・既定モデル（provider ごとの既定）だけ（ほかの params は同じ）
    const strip = (p) => { const { provider: _p, provider_api_key_env: _k, ollama_stage_output_limits: _l, model: _m, ...rest } = p; return rest; };
    assert.deepEqual(strip(ollama.params), strip(openai.params));
    assert.equal(ollama.params.model, "fake-ollama-model");
    assert.equal(openai.params.model, "fake-model");
    // 表の欄そのものが署名に入る（同じ条件に欄を足すだけで署名が変わる）
    const withField = { ...openai, params: { ...openai.params, provider: "ollama", provider_api_key_env: "OLLAMA_API_KEY", ollama_stage_output_limits: FAKE_OLLAMA_LIMITS_TABLE } };
    assert.notEqual(conditionsSignature(withField), openai.signature);
    // Ollama の v1.1a には欄が無い（表は v1.2 の走りだけ）
    const outV11a = join(base, "out-ollama-v11a");
    assert.equal(runAgent(repo, outV11a, [...runs, "--pipeline", "v1.1a", "--provider", "ollama"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.ok(!("ollama_stage_output_limits" in readJson(join(outV11a, "conditions.json")).params));
    // 同じ表の再開は通り、表を変えた再開は resume:signature で断る
    const resumed = runAgent(repo, outOllama, [...runs, "--pipeline", "v1.2", "--provider", "ollama", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.equal(resumed.status, 0, resumed.stderr);
    writeFileSync(join(repo, "packages/factory/dist/ollama.js"), ollamaJsOf('export const OLLAMA_STAGE_OUTPUT_LIMITS = { "semantic-check": 32768, "decl-check": 32768, repair: 65537 };\n'));
    const n = spawnCount(log), before = snapshot(outOllama);
    assertRefused(runAgent(repo, outOllama, [...runs, "--pipeline", "v1.2", "--provider", "ollama", "--resume"], { FAKE_SPAWN_LOG: log }), "resume:signature", log, n, "表を変えた再開");
    assert.deepEqual(snapshot(outOllama), before);
  });
});

test("#776 --provider ollama の v1.2 で dist の表が無い・形が違えば provider:ollama-limits-unavailable（exit 3・子 0 本・何も書かない）", async () => {
  await withRepo(async (base) => {
    for (const [label, limits] of [
      ["absent", null],
      ["not-object", 'export const OLLAMA_STAGE_OUTPUT_LIMITS = "nope";\n'],
      ["bad-value", 'export const OLLAMA_STAGE_OUTPUT_LIMITS = { repair: 0 };\n'],
      ["empty", 'export const OLLAMA_STAGE_OUTPUT_LIMITS = {};\n'],
    ]) {
      const repo = makeV12OllamaRepo(join(base, `t-${label}`), { limits }), fz = frozen557(join(base, `fz-${label}`), repo);
      const log = join(base, `spawn-${label}.log`), out = join(base, `out-${label}`);
      assertRefused(runAgent(repo, out, ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.2", "--provider", "ollama"], { FAKE_SPAWN_LOG: log }), "provider:ollama-limits-unavailable", log, 0, label);
      assertNothingWritten(out, label);
    }
    // 表が無くても v1.1a の Ollama の走りは今までどおり通る（表は v1.2 の走りでだけ要る）
    const repo = makeV12OllamaRepo(join(base, "t-v11a"), { limits: null }), fz = frozen557(join(base, "fz-v11a"), repo), log = join(base, "spawn-v11a.log");
    assert.equal(runAgent(repo, join(base, "out-v11a"), ["--only", "P1", "--runs", "1", "--build-from", fz, "--pipeline", "v1.1a", "--provider", "ollama"], { FAKE_SPAWN_LOG: log }).status, 0);
  });
});

test("#776 段だけの対の比較 × Ollama の v1.2：同じ表どうしは通って両群の条件に表が載り、表の違う群は compare:ollama-limits-differ で断る（exit 3・子 0 本・何も書かない）", async () => {
  await withRepo(async (base) => {
    const repo = makeStageOllamaRepo(base, "cand"), baseline = makeStageOllamaRepo(base, "base"), fz = frozen545(base, repo), log = join(base, "spawn.log");
    const up = runUpstream638(repo, join(base, "up"), fz, log);
    const pairsPath = join(base, "pairs.json");
    const mp = runAgent(repo, join(base, "unused"), ["--make-pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--runs", "3"]);
    assert.equal(mp.status, 0, mp.stderr);
    const cmpArgs = (bl) => ["--compare", "--baseline", bl, "--pairs", pairsPath, "--build-from", fz, "--pipeline", "v1.2", "--stage-start", "write", "--stage-from", up, "--budget-usd", "10", "--concurrency", "4", "--provider", "ollama"];
    const out = join(base, "cmp"), n0 = spawnCount(log);
    const r = runAgent(repo, out, cmpArgs(baseline), { FAKE_SPAWN_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(spawnCount(log) - n0, 30);
    for (const g of ["before", "after"]) {
      const c = readJson(join(out, g, "conditions.json"));
      assert.equal(c.schema, V8, g);
      assert.equal(c.params.provider, "ollama", g);
      assert.deepEqual(c.params.ollama_stage_output_limits, FAKE_OLLAMA_LIMITS_TABLE, g);
      assert.equal(conditionsSignature(c), c.signature, g);
    }
    // 比較元の表だけを変えた群
    const other = makeStageOllamaRepo(base, "other", { limits: 'export const OLLAMA_STAGE_OUTPUT_LIMITS = { "semantic-check": 32768, "decl-check": 32768, repair: 65537 };\n' });
    const n1 = spawnCount(log), bad = join(base, "cmp-bad");
    assertRefused(runAgent(repo, bad, cmpArgs(other), { FAKE_SPAWN_LOG: log }), "compare:ollama-limits-differ", log, n1, "limits-differ");
    assertNothingWritten(bad, "limits-differ");
  });
});
