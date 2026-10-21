// freeze-stage-input.mjs の試験（node --test。#640）。ネットワーク無し・API 無し・本物の工場無しで閉じる：
// 一時の偽物のリポジトリに偽物の工場の dist（段の表と照合の関数・包みの検査・記録の名前・旗の組と台帳の指紋）を置き、合成の参照の計測（条件 v7・本ごとの
// Build だけの記録と checkpoint・起動の記録）と合成の表の採点の出力を作ってから、凍結の道具を子プロセスで回す。表の中身は目印だけ（正解の表の中身を入れない）。
// 実行: node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CONDITIONS_V7, EVAL_SET_SCHEMA, conditionsSignature } from "./score-agent.mjs";
import { FROZEN_SET_SCHEMA } from "./freeze-plan-set.mjs";
import { FROZEN_STAGE_SET_FILE, FROZEN_STAGE_SET_SCHEMA, STAGE_FREEZE_RULE, STAGE_REVIEW_SCHEMA, loadFrozenStageSet, stageSetSignature } from "./freeze-stage-input.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const freezeFile = join(here, "freeze-stage-input.mjs");
const SET_PATH = "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json";
const MARK = "leak-marker-text";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const FLAGS = { ledger: true, ids: true };
const LEDGER = "ledger-a";
const BUILD_RECORD_SCHEMA = "musunest-factory/build-cli-record/v1";

// 偽物の段の表と照合の関数（段の走りの記録と Build だけの記録の両方を前の走りの記録として受ける。#636 の工場と同じ振る舞いの合成）
const fakeStageLib = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
export const STAGE_STARTS = ["name-table", "test-spec", "write"];
export const STAGE_ENDS = ["semantic-check", "test-spec", "judge"];
export const STAGE_BOUNDARIES = ["t1-t2", "t2-b1"];
export const STAGE_INPUT_CODES = ["stage-input:unreadable", "stage-input:boundary", "stage-input:version", "stage-input:digest", "stage-input:plan-sha256", "stage-input:source-sha256", "stage-input:table-sha256", "stage-input:suite-sha256"];
export const STAGE_RUN_RECORD_FILE = "stage-run.json";
const PREVIOUS = ["musunest.factory.v11a-stage-run/v1", "${BUILD_RECORD_SCHEMA}"];
export const stageCheckpointFile = (b) => "stage-checkpoint-" + b + ".json";
export function boundaryBefore(start) { return start === "test-spec" ? "t1-t2" : start === "write" ? "t2-b1" : null; }
const obj = (t) => { if (t === null) return null; try { const v = JSON.parse(t); return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const fail = (code) => ({ ok: false, code });
export async function verifyStageInput(input) {
  const needed = boundaryBefore(input.start);
  const cp = obj(input.checkpointText), rec = obj(input.recordText);
  if (cp === null || rec === null) return fail("stage-input:unreadable");
  if (cp.boundary !== needed) return fail("stage-input:boundary");
  const declared = Array.isArray(rec.checkpoints) ? rec.checkpoints.find((e) => e && e.boundary === needed && e.path === input.checkpointFile) : undefined;
  if (!declared) return fail("stage-input:boundary");
  if (!PREVIOUS.includes(rec.schema_version) || cp.versions?.vocabulary !== input.vocabularyVersion || cp.versions?.contract !== input.contractVersion) return fail("stage-input:version");
  if (cp.versions?.ledger !== input.v12?.ledger || JSON.stringify(cp.versions?.flags) !== JSON.stringify(input.v12?.flags)) return fail("stage-input:version");
  if (h(JSON.stringify(cp)) !== declared.output_digest) return fail("stage-input:digest");
  if (cp.plan_sha256 !== input.planSha256) return fail("stage-input:plan-sha256");
  if (cp.source_sha256 !== input.sourceSha256) return fail("stage-input:source-sha256");
  if (h(JSON.stringify(cp.name_table?.rows)) !== cp.name_table?.table_sha256) return fail("stage-input:table-sha256");
  if (input.start === "write" && h(JSON.stringify(cp.test_spec?.suite)) !== cp.test_spec?.suite_sha256) return fail("stage-input:suite-sha256");
  return { ok: true };
}
`;
const fakeCli = 'export const VOCABULARY_VERSION = "v1";\nexport const CONTRACT_VERSION = "v0.2";\n';
const fakeCliPlan = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export const BUILD_CLI_RECORD_FILE = "build-record.json";
export function parsePlanFile(text) {
  let v; try { v = JSON.parse(text); } catch { return { code: "plan-file-json" }; }
  if (!isRec(v)) return { code: "plan-file-envelope" };
  return { envelope: { schema_version: v.schema_version, outcome: v.outcome, plan: v.plan, plan_sha256: v.plan_sha256, source_sha256: v.source_sha256 } };
}
export async function validatePlanFile({ envelope, source, vocabularyVersion }) {
  if (envelope.outcome !== "confirmed" || !isRec(envelope.plan)) return { kind: "rejected", check: "outcome", codes: [] };
  const planSha256 = h(JSON.stringify(envelope.plan));
  if (planSha256 !== envelope.plan_sha256 || h(source) !== envelope.source_sha256 || envelope.plan.vocabulary_version !== vocabularyVersion) return { kind: "rejected", check: "plan-sha256", codes: [] };
  return { kind: "ok", plan: envelope.plan, planSha256, sourceSha256: h(source) };
}
`;
const fakeIndex = (flags = FLAGS) => `export const V12_PIPELINE_FLAGS = ${JSON.stringify(flags)};\nexport async function propertyLedgerSha256() { return ${JSON.stringify(LEDGER)}; }\n`;

const PIDS = ["P1", "P2", "P3", "P4"];
const RUNS = 3;
const IDS = PIDS.flatMap((p) => [1, 2, 3].map((r) => `${p}-r${r}`));
const reqText = (pid) => `依頼 ${pid} の行 1\n`;
const planOf = (pid) => ({ plan_id: `plan-${pid}`, vocabulary_version: "v1", body: [`spec ${pid}`] });
const PSHA = (pid) => sha256(JSON.stringify(planOf(pid))), SSHA = (pid) => sha256(reqText(pid));

/** 偽物のリポジトリ（P1〜P4 の定義ファイル・偽物の工場の dist） */
function makeRepo(base, { flags = FLAGS } = {}) {
  const repo = join(base, "repo");
  const w = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  w("packages/factory/dist/v11a/bundle-v11a.js", fakeStageLib);
  w("packages/factory/dist/cli.js", fakeCli);
  w("packages/factory/dist/cli-plan.js", fakeCliPlan);
  w("packages/factory/dist/index.js", fakeIndex(flags));
  const ev = "workspace/mvp/m1/agent/eval";
  w(`${ev}/subjects/A.json`, JSON.stringify({ id: "A", structures: [{ id: "main", checks: [{ req: "要件 1" }], unwritable: [] }] }));
  const items = PIDS.map((id) => ({ id, subject: "A", style: "S1", writable: true, scoring: "../subjects/A.json", script: null, request: [`依頼 ${id} の行 1`] }));
  w(SET_PATH, JSON.stringify({ schema: EVAL_SET_SCHEMA, id: "dev-p1-p10", version: 1, role: "development", title: "t", styles: { S1: "s1" }, items }));
  return repo;
}
/** 凍結した組 (b)（P1〜P4 の確定した包み） */
function writePlanSet(base, repo) {
  const dir = join(base, "plan-set");
  mkdirSync(join(dir, "envelopes"), { recursive: true });
  const adopted = PIDS.map((pid) => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: "musunest-factory/plan-only-result/v1", outcome: "confirmed", plan: planOf(pid), plan_sha256: PSHA(pid), source_sha256: SSHA(pid), conditions: null, stop: null }));
    writeFileSync(join(dir, "envelopes", `${pid}.json`), bytes);
    return { pattern: pid, run: null, started_at: null, envelope: { path: `envelopes/${pid}.json`, sha256: sha256(bytes) }, plan_sha256: PSHA(pid), source_sha256: SSHA(pid) };
  });
  const set = { schema: FROZEN_SET_SCHEMA, id: "plan-set-t", version: 1, origin: "frozen-plan", rule: null, set: { path: SET_PATH, sha256: sha256(readFileSync(join(repo, SET_PATH))), id: "dev-p1-p10", version: 1 }, source_measurement: null, adopted, missing: [] };
  const path = join(dir, "frozen-plan-set.json");
  writeFileSync(path, JSON.stringify(set, null, 1));
  return path;
}
/** 合成の checkpoint（表の行は目印だけ）。badTable なら表の SHA を合わせない（照合に落ちる本） */
function checkpointOf(id, boundary, { badTable = false } = {}) {
  const pid = id.split("-")[0];
  const rows = [{ id: "R1", name: `mark-${id}-a` }, { id: "R2", name: `mark-${id}-b` }];
  const suite = { tests: [{ id: "T1", target: "R1" }] };
  return {
    schema_version: "musunest.factory.v11a-stage-checkpoint/v1", boundary, versions: { vocabulary: "v1", contract: "v0.2", prompt: "v1.2", factory: "0.0.0", ledger: LEDGER, flags: FLAGS },
    plan_sha256: PSHA(pid), source_sha256: SSHA(pid), name_table: { table_sha256: badTable ? sha256("other") : sha256(JSON.stringify(rows)), rows },
    semantic_check: { table_sha256: sha256(JSON.stringify(rows)) }, ...(boundary === "t2-b1" ? { test_spec: { suite_sha256: sha256(JSON.stringify(suite)), suite } } : {}),
  };
}
const tableShaOf = (id) => checkpointOf(id, "t1-t2").name_table.table_sha256;
/**
 * 本ごとの振る舞い：kind ＝ "cp"（境界の checkpoint を宣言する）・"no-cp"（Build だけの記録に checkpoints が無い）・"bad"（照合に落ちる）・"none"（記録なし）。
 * score ＝ [正答, 誤り, 非二値] の数（null なら採点の行の requirements が null）。at ＝ 開始の時刻の秒
 */
const PLAN = {
  // P1：checkpoint のある本・無い本・照合に落ちる本（r1 2/4、r2 checkpoint なし 4/4、r3 照合に落ちる 4/4）→ r1
  "P1-r1": { kind: "cp", score: [2, 2, 0], at: 3 }, "P1-r2": { kind: "no-cp", score: [4, 0, 0], at: 1 }, "P1-r3": { kind: "bad", score: [4, 0, 0], at: 2 },
  // P2：正答率の同点（r1 1/2 が遅い、r2 2/4 と r3 1/2 が同じ時刻）→ 時刻の早い本のうち回の小さい r2
  "P2-r1": { kind: "cp", score: [1, 1, 0], at: 1 }, "P2-r2": { kind: "cp", score: [2, 2, 1], at: 0 }, "P2-r3": { kind: "cp", score: [1, 1, 0], at: 0 },
  // P3：二値の要件が 0 の本だけ（非二値だけ・未採点）→ 外す（no-scored-candidate）
  "P3-r1": { kind: "cp", score: [0, 0, 3], at: 0 }, "P3-r2": { kind: "cp", score: null, at: 1 }, "P3-r3": { kind: "none", score: null, at: 2 },
  // P4：分母 0 の本（時刻が最も早い）と有効な本（0/3）が混ざる → 分母 0 を 0 点に読み替えず r2
  "P4-r1": { kind: "cp", score: [0, 0, 2], at: 0 }, "P4-r2": { kind: "cp", score: [0, 3, 0], at: 1 }, "P4-r3": { kind: "no-cp", score: [3, 0, 0], at: 2 },
};
const OUTCOMES = (score) => (score === null ? null : [...Array(score[0]).fill("correct"), ...Array(score[1]).fill("wrong"), ...Array(score[2]).fill("held")].map((outcome, i) => ({ requirement_id: `MARK_${i}`, outcome })));
/** 合成の参照の計測（条件 v7・経路 v1.2）の出力先。edit(cond) で条件を書き換え、署名は中身から計算し直す */
function writeMeasurement(base, repo, fzPath, { name = "ref", plan = PLAN, edit = null } = {}) {
  const out = join(base, name);
  mkdirSync(out, { recursive: true });
  const fz = JSON.parse(readFileSync(fzPath, "utf8"));
  const cond = {
    schema: CONDITIONS_V7, measurement_id: "m-640", source: { commit: null, dirty: null }, set: { path: SET_PATH, sha256: sha256(readFileSync(join(repo, SET_PATH))), id: "dev-p1-p10", version: 1 },
    params: { mode: "build-from", pipeline: "v1.2", v12_flags: FLAGS, patterns: PIDS, runs: RUNS },
    child_args: IDS.map((id) => ({ id, argv: ["cli.js", id] })),
    frozen: { path: fzPath, sha256: sha256(readFileSync(fzPath)), id: fz.id, version: fz.version, origin: "frozen-plan", author: null, adopted: fz.adopted.map((a) => ({ pattern: a.pattern, plan_sha256: a.plan_sha256, source_sha256: a.source_sha256, envelope_sha256: a.envelope.sha256 })), missing: [] },
  };
  if (edit !== null) edit(cond);
  cond.signature = conditionsSignature(cond);
  writeFileSync(join(out, "conditions.json"), JSON.stringify(cond, null, 1));
  for (const id of IDS) {
    const p = plan[id], bundle = join(out, id, "bundle"), pid = id.split("-")[0];
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(out, id, "summary.line.json"), JSON.stringify({ exit: 0, started_at: new Date(Date.UTC(2026, 9, 19, 0, 0, p.at)).toISOString() }));
    if (p.kind === "none") continue;
    const checkpoints = [];
    if (p.kind !== "no-cp") {
      for (const b of ["t1-t2", "t2-b1"]) {
        const cp = checkpointOf(id, b, { badTable: p.kind === "bad" }), path = `stage-checkpoint-${b}.json`;
        writeFileSync(join(bundle, path), JSON.stringify(cp, null, 2) + "\n");
        checkpoints.push({ boundary: b, path, output_digest: sha256(JSON.stringify(cp)) });
      }
    }
    writeFileSync(join(bundle, "build-record.json"), JSON.stringify({ schema_version: BUILD_RECORD_SCHEMA, conditions: { pipeline: "v1.2", v12_flags: FLAGS }, plan_sha256: PSHA(pid), source_sha256: SSHA(pid), return_to_plan: false, ...(p.kind === "no-cp" ? {} : { checkpoints }) }));
  }
  return out;
}
/** 合成の表の採点の出力（行は目印だけ）。edit(score) で書き換える */
function writeScore(base, out, { name = "table-score.json", plan = PLAN, edit = null } = {}) {
  const score = {
    schema: "musunest-eval/table-score/v1", definitions: {},
    scoring: { by_source: {}, rows: IDS.map((id) => ({ run: id, pattern: id.split("-")[0], source: plan[id].score === null ? null : "accepted", checkpoint_also: true, table_sha256: plan[id].score === null ? null : tableShaOf(id), requirements: OUTCOMES(plan[id].score) })) },
    fingerprint: { tool_sha256: sha256("tool"), conditions_sha256: sha256(readFileSync(join(out, "conditions.json"))), measurement_id: "m-640" },
  };
  if (edit !== null) edit(score);
  const path = join(base, name);
  writeFileSync(path, JSON.stringify(score, null, 2) + "\n");
  return path;
}
const runNode = (argv) => spawnSync(process.execPath, [freezeFile, ...argv], { encoding: "utf8" });
const freeze = (repo, out, score, dest, extra = []) => runNode([repo, out, score, dest, "--id", "stage-set-t", "--version", "1", "--boundary", "t2-b1", ...extra]);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
function treeOf(root) { const out = {}; if (!existsSync(root)) return out; const walk = (d) => { for (const n of readdirSync(d).sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(root, f)] = readFileSync(f).toString("base64"); } }; walk(root); return out; }
async function withWorld(fn) {
  const base = mkdtempSync(join(tmpdir(), "freeze-stage-test-"));
  try {
    const repo = makeRepo(base), fz = writePlanSet(base, repo), out = writeMeasurement(base, repo, fz), score = writeScore(base, out);
    await fn({ base, repo, fz, out, score });
  } finally { rmSync(base, { recursive: true, force: true }); }
}
/** 凍結の断り：exit 3・符号・標準エラー 1 行・入力は不変・組のディレクトリを作らない */
function assertRefused(r, code, { inputs = [], before = [], dest, label = code }) {
  assert.equal(r.status, 3, `${label}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`[${code}]`), `${label}: 符号が違う: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: 標準エラーが 1 行でない`);
  inputs.forEach((p, i) => assert.deepEqual(treeOf(p), before[i], `${label}: 入力が変わった`));
  assert.equal(existsSync(dest), false, `${label}: 組のディレクトリを作った`);
}

test("#640 規則 best-scored-complete：P ごとに有効な候補（checkpoint の宣言・照合・二値の要件 1 件以上）の正答率の最も高い本（同点は開始の早い本・回の小さい本）を採り、分母 0 の本は選ばれない。missing に理由の符号、組の署名と写しの SHA が中身と一致し、同じ入力からは同じバイト列", async () => {
  await withWorld(async ({ base, repo, out, score, fz }) => {
    const dest = join(base, "set");
    const r = freeze(repo, out, score, dest);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(join(dest, FROZEN_STAGE_SET_FILE)), set = JSON.parse(bytes.toString("utf8"));
    assert.ok(r.stdout.includes(sha256(bytes)), "組の SHA を標準出力に出す");
    assert.equal(set.schema, FROZEN_STAGE_SET_SCHEMA);
    assert.deepEqual([set.id, set.version, set.boundary, set.rule], ["stage-set-t", 1, "t2-b1", STAGE_FREEZE_RULE]);
    assert.deepEqual(set.rule, { name: "best-scored-complete", version: 1 });
    assert.deepEqual(set.plan_set, { id: "plan-set-t", version: 1, sha256: sha256(readFileSync(fz)) });
    assert.deepEqual(set.source, { conditions_sha256: sha256(readFileSync(join(out, "conditions.json"))), measurement_id: "m-640", pipeline: "v1.2", v12_flags: FLAGS, score_sha256: sha256(readFileSync(score)) });
    assert.deepEqual(set.adopted.map((a) => [a.pattern, a.run, a.score.correct, a.score.denominator]), [["P1", "P1-r1", 2, 4], ["P2", "P2-r2", 2, 4], ["P4", "P4-r2", 0, 3]]);
    assert.deepEqual(set.missing, [{ pattern: "P3", reason: "no-scored-candidate" }]);
    // 署名と写し：署名は署名の欄を除いた組の SHA、写しは原本とバイト列で同じで SHA が組の値
    assert.equal(set.signature, stageSetSignature(set));
    for (const a of set.adopted) {
      const cp = readFileSync(join(dest, a.checkpoint.path)), rec = readFileSync(join(dest, a.record.path));
      assert.deepEqual(cp, readFileSync(join(out, a.run, "bundle", "stage-checkpoint-t2-b1.json")), a.run);
      assert.deepEqual(rec, readFileSync(join(out, a.run, "bundle", "build-record.json")), a.run);
      assert.equal(a.checkpoint.sha256, sha256(cp));
      assert.equal(a.record.sha256, sha256(rec));
      assert.equal(a.checkpoint.output_digest, sha256(JSON.stringify(JSON.parse(cp.toString("utf8")))));
      assert.equal(a.table_sha256, tableShaOf(a.run));
      assert.deepEqual([a.checkpoint.path, a.record.path], [`inputs/${a.run}/stage-checkpoint-t2-b1.json`, `inputs/${a.run}/build-record.json`]);
    }
    const loaded = loadFrozenStageSet(dest);
    assert.equal(loaded.status, "ok");
    assert.equal(loaded.sha256, sha256(bytes));
    // 同じ入力からは同じバイト列（時刻・出力先のパスを書かない）。境界 t1-t2 でも同じ本を選ぶ
    const dest2 = join(base, "set2");
    assert.equal(freeze(repo, out, score, dest2).status, 0);
    assert.deepEqual(treeOf(dest2), treeOf(dest));
    const dest3 = join(base, "set3");
    const r3 = runNode([repo, out, score, dest3, "--id", "stage-set-t", "--version", "1", "--boundary", "t1-t2"]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.deepEqual(readJson(join(dest3, FROZEN_STAGE_SET_FILE)).adopted.map((a) => [a.run, a.checkpoint.path]), [["P1-r1", "inputs/P1-r1/stage-checkpoint-t1-t2.json"], ["P2-r2", "inputs/P2-r2/stage-checkpoint-t1-t2.json"], ["P4-r2", "inputs/P4-r2/stage-checkpoint-t1-t2.json"]]);
    // 組に正解の表の中身・要件の文を写さない（採点の行の要件 ID の目印が組に無い）
    assert.ok(!bytes.toString("utf8").includes("MARK_"), "要件 ID を写さない");
    // 出力先が空でなければ断る
    assertRefused(freeze(repo, out, score, dest), "freeze:out-not-empty", { dest: join(base, "never") });
  });
});

test("#640 missing の理由の符号：境界の checkpoint を宣言した本が無い P は no-checkpoint、宣言したが照合に落ちる本だけの P は verify-failed。有効な候補が全部の P に無ければ freeze:none-adopted", async () => {
  await withWorld(async ({ base, repo, fz }) => {
    const plan = { ...PLAN };
    for (const r of [1, 2, 3]) { plan[`P3-r${r}`] = { kind: "no-cp", score: [1, 0, 0], at: r }; plan[`P4-r${r}`] = { kind: "bad", score: [1, 0, 0], at: r }; }
    const out = writeMeasurement(base, repo, fz, { name: "ref-missing", plan }), score = writeScore(base, out, { name: "score-missing.json", plan });
    const dest = join(base, "set");
    const r = freeze(repo, out, score, dest);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(join(dest, FROZEN_STAGE_SET_FILE)).missing, [{ pattern: "P3", reason: "no-checkpoint" }, { pattern: "P4", reason: "verify-failed" }]);
    const none = {};
    for (const id of IDS) none[id] = { kind: "no-cp", score: [1, 0, 0], at: 0 };
    const outN = writeMeasurement(base, repo, fz, { name: "ref-none", plan: none }), scoreN = writeScore(base, outN, { name: "score-none.json", plan: none });
    const rn = freeze(repo, outN, scoreN, join(base, "set-none"));
    assertRefused(rn, "freeze:none-adopted", { dest: join(base, "set-none") });
    assert.match(rn.stderr, / count=4$/m);
  });
});

test("#640 出どころの照合：別の計測を採点した出力（conditions_sha256 が違う・採る本の表の SHA が違う）と、条件の不一致（経路・旗の組・(b) の SHA）は何も書かず exit 3", async () => {
  await withWorld(async ({ base, repo, fz, out, score }) => {
    const before = [treeOf(out), readFileSync(score).toString("base64")];
    const check = (r, code, label) => {
      assertRefused(r, code, { dest: join(base, "set"), label });
      assert.deepEqual(treeOf(out), before[0], `${label}: 計測が変わった`);
      assert.ok(!r.stderr.includes(MARK) && !r.stderr.includes(base), `${label}: 値・パスを出さない`);
    };
    // 別の計測の条件の SHA
    const other = writeScore(base, out, { name: "score-other.json", edit: (s) => { s.fingerprint.conditions_sha256 = sha256("another-measurement"); } });
    check(freeze(repo, out, other, join(base, "set")), "freeze:score-mismatch", "conditions_sha256");
    // 採る本（P2-r2）の表の SHA が採点の行と違う
    const table = writeScore(base, out, { name: "score-table.json", edit: (s) => { s.scoring.rows.find((x) => x.run === "P2-r2").table_sha256 = sha256("another-table"); } });
    const rt = freeze(repo, out, table, join(base, "set"));
    check(rt, "freeze:score-mismatch", "table_sha256");
    assert.match(rt.stderr, / ids=P2-r2 count=1$/m);
    // 計測の予定に無い本の行
    const extra = writeScore(base, out, { name: "score-extra.json", edit: (s) => { s.scoring.rows.push({ run: "P9-r1", pattern: "P9", requirements: [] }); } });
    check(freeze(repo, out, extra, join(base, "set")), "freeze:score-mismatch", "extra-row");
    // 表の採点の版でない出力
    const wrong = writeScore(base, out, { name: "score-wrong.json", edit: (s) => { s.schema = "musunest-eval/table-score-compare/v1"; } });
    check(freeze(repo, out, wrong, join(base, "set")), "freeze:score-unreadable", "schema");
    // 条件の不一致（署名は中身から計算し直す）。採点の出力はその計測の条件の SHA で作り直す（出どころの照合より前に断ることを確かめる）
    for (const [label, edit, code] of [
      ["pipeline", (c) => { c.params.pipeline = "v1.1a"; }, "freeze:conditions-pipeline"],
      ["flags", (c) => { c.params.v12_flags = { ledger: true, ids: false }; }, "freeze:conditions-flags"],
      ["plan-set", (c) => { c.frozen.sha256 = sha256("another-plan-set"); }, "freeze:conditions-frozen"],
    ]) {
      const o = writeMeasurement(base, repo, fz, { name: `ref-${label}`, edit }), s = writeScore(base, o, { name: `score-${label}.json` });
      assertRefused(freeze(repo, o, s, join(base, "set")), code, { dest: join(base, "set"), label });
    }
    // 署名が中身と合わない条件
    const bad = join(base, "ref-bad");
    cpSync(out, bad, { recursive: true });
    const c = readJson(join(bad, "conditions.json"));
    c.params.runs = 9;
    writeFileSync(join(bad, "conditions.json"), JSON.stringify(c));
    assertRefused(freeze(repo, bad, writeScore(base, bad, { name: "score-bad.json" }), join(base, "set")), "freeze:conditions-invalid", { dest: join(base, "set") });
    // 境界が dist の表に無い
    assertRefused(runNode([repo, out, score, join(base, "set"), "--id", "x", "--version", "1", "--boundary", "b1-b2"]), "freeze:boundary", { dest: join(base, "set") });
    assertRefused(runNode([repo, out, score, join(base, "set"), "--id", "x", "--boundary", "t2-b1"]), "freeze:args", { dest: join(base, "set") });
  });
});

/** 採否のファイル */
const writeReview = (base, name, decisions, over = {}) => { const p = join(base, name); writeFileSync(p, JSON.stringify({ schema: STAGE_REVIEW_SCHEMA, set: { id: "stage-set-t", version: 1 }, author: "owner", date: "2026-10-19", decisions, ...over }, null, 1)); return p; };
const adopt = (dest, review) => runNode([dest, "--adopt", review]);

test("#640 人の採否：P を 1 つ除外すると adopted が 1 減って missing に human-excluded の理由が付き、review が入って署名が変わり、写しは前とバイト列で同じで、採用後の組の SHA が出力に出る。採否のファイルに無い P・組に無い P・2 回指す P は断って何も変えない", async () => {
  await withWorld(async ({ base, repo, out, score }) => {
    const dest = join(base, "set");
    assert.equal(freeze(repo, out, score, dest).status, 0);
    const before = readJson(join(dest, FROZEN_STAGE_SET_FILE)), inputsBefore = treeOf(join(dest, "inputs"));
    const refusedBefore = treeOf(dest);
    for (const [label, decisions, code, ids] of [
      ["missing-p", [{ pattern: "P1", decision: "adopt" }, { pattern: "P2", decision: "adopt" }], "adopt:missing-p", ["P4"]],
      ["unknown-p", [{ pattern: "P1", decision: "adopt" }, { pattern: "P2", decision: "adopt" }, { pattern: "P4", decision: "adopt" }, { pattern: "P3", decision: "exclude", reason: "x" }], "adopt:unknown-p", ["P3"]],
      ["duplicate-p", [{ pattern: "P1", decision: "adopt" }, { pattern: "P1", decision: "exclude", reason: "x" }, { pattern: "P2", decision: "adopt" }, { pattern: "P4", decision: "adopt" }], "adopt:duplicate-p", ["P1"]],
      ["no-reason", [{ pattern: "P1", decision: "adopt" }, { pattern: "P2", decision: "exclude" }, { pattern: "P4", decision: "adopt" }], "adopt:invalid", null],
    ]) {
      const r = adopt(dest, writeReview(base, `review-${label}.json`, decisions));
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`[${code}]`), `${label}: ${r.stderr}`);
      if (ids !== null) assert.match(r.stderr, new RegExp(` ids=${ids.join(",")} count=${ids.length}$`, "m"), label);
      assert.deepEqual(treeOf(dest), refusedBefore, `${label}: 組が変わった`);
    }
    const rs = adopt(dest, writeReview(base, "review-set.json", [{ pattern: "P1", decision: "adopt" }, { pattern: "P2", decision: "adopt" }, { pattern: "P4", decision: "adopt" }], { set: { id: "stage-set-t", version: 2 } }));
    assert.equal(rs.status, 3);
    assert.ok(rs.stderr.includes("[adopt:set-mismatch]"), rs.stderr);
    // P2 を除外する
    const review = writeReview(base, "review.json", [{ pattern: "P1", decision: "adopt" }, { pattern: "P2", decision: "exclude", reason: "table-shape" }, { pattern: "P4", decision: "adopt", reason: null }]);
    const r = adopt(dest, review);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(join(dest, FROZEN_STAGE_SET_FILE)), after = JSON.parse(bytes.toString("utf8"));
    assert.ok(r.stdout.includes(sha256(bytes)), "採用後の組の SHA を出す");
    assert.equal(after.adopted.length, before.adopted.length - 1);
    assert.deepEqual(after.adopted.map((a) => a.pattern), ["P1", "P4"]);
    assert.deepEqual(after.missing, [{ pattern: "P2", reason: "human-excluded:table-shape" }, { pattern: "P3", reason: "no-scored-candidate" }]);
    assert.deepEqual(after.review, { sha256: sha256(readFileSync(review)), author: "owner", date: "2026-10-19" });
    assert.notEqual(after.signature, before.signature);
    assert.equal(after.signature, stageSetSignature(after));
    assert.deepEqual([after.id, after.version, after.boundary], [before.id, before.version, before.boundary], "版を変えない");
    assert.deepEqual(after.adopted, before.adopted.filter((a) => a.pattern !== "P2"), "残りの採用の欄は同じ");
    assert.deepEqual(treeOf(join(dest, "inputs")), inputsBefore, "写し（原本）は前とバイト列で同じ");
    assert.equal(loadFrozenStageSet(dest).status, "ok");
    // 反映済みの組には重ねない
    const again = adopt(dest, review);
    assert.equal(again.status, 3);
    assert.ok(again.stderr.includes("[adopt:already-reviewed]"), again.stderr);
    // 書き換えた組（署名が合わない）は読み込みで断る
    const tampered = join(base, "tampered");
    cpSync(dest, tampered, { recursive: true });
    const t = readJson(join(tampered, FROZEN_STAGE_SET_FILE));
    t.adopted[0].run = "P1-r3";
    writeFileSync(join(tampered, FROZEN_STAGE_SET_FILE), JSON.stringify(t, null, 1));
    assert.equal(loadFrozenStageSet(tampered).status, "invalid", "写しの場所と本が合わない");
    t.adopted[0].run = "P1-r1"; t.missing = [];
    writeFileSync(join(tampered, FROZEN_STAGE_SET_FILE), JSON.stringify(t, null, 1));
    assert.equal(loadFrozenStageSet(tampered).status, "signature");
  });
});

test("#640 道具に工場の名前（境界・記録の名前・旗の名前）と題材の言葉を書かない。工場の package を import しない", () => {
  const text = readFileSync(freezeFile, "utf8");
  for (const name of ['"t1-t2"', '"t2-b1"', '"stage-run.json"', '"build-record.json"', '"ids"', '"ledger"']) assert.ok(!text.includes(name), name);
  assert.ok(!/from "@musunest\//.test(text) && !/packages\/factory\/src/.test(text), "工場を import しない");
  // 語は符号の列で持つ（この試験のファイル自身に書かない）
  const words = [[0x6301, 0x3061, 0x5bc4, 0x308a], [0x5f53, 0x756a, 0x8868], [0x4f1a, 0x8cbb], [0x51fa, 0x6b20], [0x8cb8, 0x3057, 0x51fa, 0x3057]].map((cs) => String.fromCodePoint(...cs));
  const readme = readFileSync(join(here, "../README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n#### 10.8.1 "));
  for (const t of [text, readFileSync(fileURLToPath(import.meta.url), "utf8"), section]) for (const w of words) assert.ok(!t.includes(w), w);
});

test("#640 README：§10.8 の下の末尾の小節 §10.8.1 に定義の語があり、§7 の先頭より前と §7.11 の先頭より前のバイト列は変わらない", () => {
  const text = readFileSync(join(here, "../README.md"), "utf8");
  const at = text.indexOf("\n#### 10.8.1 ");
  assert.ok(at > text.indexOf("\n### 10.8 ") && text.indexOf("\n### 10.8 ") > 0, "§10.8.1 は §10.8 の後ろ");
  assert.ok(!/\n#{2,3} /.test(text.slice(at)), "§10.8.1 の後ろは #### の小節だけ（## と ### は無い。#686 で改めた）");
  const sec = text.slice(at);
  for (const w of ["best-scored-complete", "分母 0", "採否", "review", "版 1", "版 2", "リポジトリの外", "節目", "frozen-stage-input-set", "stage-from:set-review", "human-excluded", "no-checkpoint", "verify-failed", "no-scored-candidate", "freeze:score-mismatch"]) assert.ok(sec.includes(w), w);
  assert.equal(sha256(text.slice(0, text.indexOf("## 7. 表の採点（正解の表との照合）") - 1)), "662d41ded93107ecd130dfa090b09df1280ec78277509d131bf21b253e82cba4");
  assert.equal(sha256(text.slice(0, text.indexOf("### 7.11 断った候補の下書きの採点（読取元 (c)。#607）") - 1)), "1c21bdefca9e6e5373316f7ce143bdad580dea3d25ad5d1bbda1e8e64f9b2e1f");
});
