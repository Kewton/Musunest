// run-agent.mjs の試験（node --test。#400・#425）。ネットワーク無し・API 無しで閉じる：
// 一時の偽物のリポジトリに、偽物の工場の入口（dist/cli.js）と抽象的な依頼文を置き、run-agent を子プロセスで回す。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { reconcile, scoringFingerprint } from "./score-agent.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runAgentFile = join(here, "run-agent.mjs");

// 偽物の工場の入口。標準出力・標準エラーを制御し、自分の引数と起動を記録する。import されたときは main を動かさない。
const fakeCli = String.raw`import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_BUDGET_USD = 0.3;
export const DEFAULT_DEADLINE_MS = 600000;
export const API_KEY_ENV = "OPENAI_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
function main() {
  const argv = process.argv.slice(1);
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : "";
  const runDir = dirname(outDir);
  const id = basename(runDir);
  if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, id + "\n");
  try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(runDir, "received-argv.json"), JSON.stringify(argv)); } catch {}
  process.exitCode = Number(process.env.FAKE_EXIT ?? "0");
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

const fakeOpenai = 'export const DEFAULT_OPENAI_MODEL = "fake-model";\n';
const fakeLimits = 'export const DEFAULT_REASONING_EFFORT = "high";\nexport const STAGE_MAX_OUTPUT_TOKENS = { low: { requirements: 2048 }, medium: { requirements: 16384 }, high: { requirements: 16384 } };\n';
// 偽物の appspec-schema の files（工場の入口が生成に渡す文書の置き場所を引く口。packages/appspec-schema/src/files.ts と同じ形）
const fakeSchemaFiles = `export const CONTRACT_DIR = "contract";
export function packageFile(relativePath) { return new URL("../" + relativePath, import.meta.url); }
export const vocabularyFile = () => packageFile("vocabulary.yaml");
export const semanticsFile = () => packageFile("docs/semantics.md");
`;

function makeTable() {
  let text = "# 題材\n\n";
  for (let p = 1; p <= 10; p++) text += `**P${p}（S1 丁寧）**\n\n> 依頼 ${p} の行 1\n> 依頼 ${p} の行 2\n\n**判定：書ける。**\n\n`;
  return text;
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
  for (const f of ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "agent-accept/score-agent.mjs"]) writeFileSync(join(ev, f), `// ${f}\n`);
  writeFileSync(join(ev, "subjects/A.json"), JSON.stringify({ id: "A", structures: [{ id: "main", checks: [{ req: "要件 1" }], unwritable: [] }] }));
  return repo;
}

function runAgent(repo, out, extra, env = {}) {
  return spawnSync(process.execPath, [runAgentFile, repo, out, ...extra], { encoding: "utf8", env: { ...process.env, JEV_API_KEY: "", ...env } });
}
const spawnCount = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
const spawnLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

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
    const again = runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(again.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(again.stderr, /断りました/);
  });
});

test("再開で条件が一致しないと、子プロセスを起こさずに非 0 で終える", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-mismatch");
    const log = join(base, "spawn-mismatch.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1", "--effort", "high"], { FAKE_SPAWN_LOG: log }).status, 0);
    assert.equal(spawnCount(log), 1);
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--effort", "low", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /条件/);
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
  });
});

test("条件のファイルが無い出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-nocond");
    const log = join(base, "spawn-nocond.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "conditions.json"));
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
  });
});

test("全文が欠けた古い出力の出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-nofull");
    const log = join(base, "spawn-nofull.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r1", "stdout.log"));
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /全文/);
  });
});

test("要約の無い途中の本がある出力先は断る", async () => {
  await withRepo(async (base, repo) => {
    const out = join(base, "out-partial");
    const log = join(base, "spawn-partial.log");
    assert.equal(runAgent(repo, out, ["--only", "P1", "--runs", "1"], { FAKE_SPAWN_LOG: log }).status, 0);
    rmSync(join(out, "P1-r1", "summary.line.json"));
    const resumed = runAgent(repo, out, ["--only", "P1", "--runs", "1", "--resume"], { FAKE_SPAWN_LOG: log });
    assert.notEqual(resumed.status, 0);
    assert.equal(spawnCount(log), 1);
    assert.match(resumed.stderr, /要約/);
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
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v2");
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
    assert.deepEqual(cond.scoring, { dir: "workspace/mvp/m1/agent/eval", ...scoringFingerprint(join(repo, "workspace/mvp/m1/agent/eval")) });
    assert.deepEqual(cond.scoring.missing, []);
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
  });
});

test("採点の定義の変更は署名の外で、再開を妨げない（採点は生成のあとに全本へ同じ版を当て、採点の出力が条件と照合する）", async () => {
  await withRepo(async (base, repo) => {
    const log = join(base, "spawn-scoring.log");
    const args = ["--only", "P1,P2", "--runs", "1", "--concurrency", "1"];
    const out = join(base, "out-scoring");
    assert.equal(runAgent(repo, out, args, { FAKE_SPAWN_LOG: log }).status, 0);
    const before = JSON.parse(readFileSync(join(out, "conditions.json"), "utf8"));
    rmSync(join(out, "P2-r1"), { recursive: true, force: true });
    appendFileSync(join(repo, "workspace/mvp/m1/agent/eval/subjects/A.json"), "\n");
    assert.notEqual(scoringFingerprint(join(repo, "workspace/mvp/m1/agent/eval")).fingerprint, before.scoring.fingerprint);
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
    assert.equal(readdirSync(out).filter((n) => /^run-\d+\.json$/.test(n)).length, 2);
    const c2 = reconcile(out);
    assert.equal(c2.status, "complete");
    assert.equal(c2.label, "完了");
    assert.deepEqual(c2.unexecuted, []);
    assert.equal(c2.latest_record.stop, null);
  });
});
