// run-agent.mjs の試験（node --test。#400・#425・#427）。ネットワーク無し・API 無しで閉じる：
// 一時の偽物のリポジトリに、偽物の工場の入口（dist/cli.js）と抽象的な依頼文（定義ファイル sets/dev-p1-p10.json と、その出どころの表）を置き、run-agent を子プロセスで回す。
// 本物の定義ファイルの依頼文が今の表（stage1-patterns.md）と一致することは、このリポジトリの実物を読んで確かめる（最後の試験）。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v3");
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
    assert.equal(cond.schema, "musunest-factory/agent-accept-conditions/v3");
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
