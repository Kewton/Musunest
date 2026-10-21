// score-stage-tests.mjs の試験（node --test。#686）。API・通信・LLM・判定を使わない。
// 一時の偽物のリポジトリに合成の工場の dist（段の表・出力ダイジェスト・一覧と持ち越しの関数・包みの検査・台帳の見方・評価口）を置き、spec-engine と
// appspec-schema は build 済みの dist を symlink で見せる。合成の上流の組（境界 t1-t2）・参照の計測・U2 の計測（条件 v8）と架空の小さな宣言で閉じる。
// 置き場所は全部リポジトリの外（一時のディレクトリ）。実行（pnpm build のあと）: node --test workspace/mvp/m1/agent/eval/mutation/score-stage-tests.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITIONS_V8, EVAL_SET_SCHEMA, STAGE_COMPARISON_SCHEMA, STAGE_PAIRS_SCHEMA, conditionsSignature, fingerprintDir } from "../agent-accept/score-agent.mjs";
import { FROZEN_STAGE_SET_FILE, FROZEN_STAGE_SET_SCHEMA, stageSetBytes } from "../agent-accept/freeze-stage-input.mjs";
import { CONTEXT_SCHEMA } from "./score-mutants.mjs";
import { COMPARE_FILE, OUTPUT_FILE, REFERENCE_SET_FILE, REFERENCE_SET_SCHEMA, StageTestsError, aggregateGroup, anonymousFileOf, loadReferenceSet, makeReferenceSet, referenceBytes, referenceSignature, scoreStageTests, toAnonymous } from "./score-stage-tests.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../../..");
const tool = join(here, "score-stage-tests.mjs");
const sha256 = (d) => createHash("sha256").update(d).digest("hex");
const SET_PATH = "workspace/mvp/m1/agent/eval/sets/u2-test.json";
const FLAGS = { ledger: true, "search-repair": true, ids: true };
const TSHA = (pid) => sha256(`table-${pid}`);

// ── 合成の工場の dist（評価口は「試験の目印の文字列が宣言に無ければ不一致、目印の無い試験は未解決」。表の行・所属・一覧の形は工場の今の形に合わせる）
const FAKE_INDEX = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
export const STAGE_STARTS = ["name-table", "test-spec", "write"];
export const STAGE_RUN_RECORD_FILE = "stage-run.json";
export function boundaryBefore(start) { return start === "test-spec" ? "t1-t2" : start === "write" ? "t2-b1" : null; }
export const stageCheckpointFile = (b) => "stage-checkpoint-" + b + ".json";
export async function stageOutputDigest(cp) { return h(JSON.stringify(cp)); }
export function requirementsFromPlan(plan) { return { requirements: plan.requirements.map((r) => ({ id: r.id, text: r.text, quote: r.text, position: { start: 0, end: 0 } })) }; }
export function pruneForCarryOver(list, table, carry, suite) {
  const carried = new Set([...carry.entries.map((e) => e.requirementId), ...(carry.nonRequirements ?? [])]), excluded = new Set(carry.excludedRowIds);
  const ownership = table.ownership.filter((o) => !carried.has(o.requirementId)).map((o) => ({ requirementId: o.requirementId, roles: o.roles.filter((r) => !excluded.has(r.id)) }));
  return { list: { ...list, requirements: list.requirements.filter((r) => !carried.has(r.id)) }, table: { ...table, ownership }, conversion: { ownership: ownership.map((o) => ({ requirementId: o.requirementId, roles: o.roles.map((r) => r.id) })) }, suite: { tests: suite.tests.filter((t) => !carried.has(t.target.requirementId)) } };
}
export const PROPERTY_LEDGER_VIEW = { rows: ["fake-ledger-row"] };
export function ledgerViewOf(flags) { return flags.ledger ? PROPERTY_LEDGER_VIEW : undefined; }
export function createV11aEvaluator(input) {
  (globalThis.u2SeenEvaluators ??= []).push(input);
  return { evaluate: async (app, decl, context) => {
    const mismatches = [], unresolved = [];
    for (const t of context.suite.tests) { if (typeof t.needle !== "string") unresolved.push({ testId: t.id }); else if (!decl.source.includes(t.needle)) mismatches.push({ testId: t.id }); }
    return { correspondence: { misses: [] }, testRun: { mismatches, unresolved } };
  } };
}
`;
const FAKE_CLI = 'export const VOCABULARY_VERSION = "v1";\nexport const CONTRACT_VERSION = "v0.2";\n';
const FAKE_CLI_PLAN = String.raw`import { createHash } from "node:crypto";
const h = (t) => createHash("sha256").update(t).digest("hex");
const isRec = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export const BUILD_CLI_RECORD_FILE = "build-record.json";
export function parsePlanFile(text) { let v; try { v = JSON.parse(text); } catch { return { code: "plan-file-json" }; } return isRec(v) ? { envelope: v } : { code: "plan-file-envelope" }; }
export async function validatePlanFile({ envelope, source, vocabularyVersion }) {
  if (envelope.outcome !== "confirmed" || !isRec(envelope.plan)) return { kind: "rejected", check: "outcome", codes: [] };
  const planSha256 = h(JSON.stringify(envelope.plan));
  if (planSha256 !== envelope.plan_sha256 || h(source) !== envelope.source_sha256 || envelope.plan.vocabulary_version !== vocabularyVersion) return { kind: "rejected", check: "plan-sha256", codes: [] };
  return { kind: "ok", plan: envelope.plan, planSha256, sourceSha256: h(source) };
}
`;

// ── 架空の小さな宣言（中立な名前）と題材の定義
const SRC = `entities:
  - name: member
    fields:
      name:
        type: string
        label: Name
      note:
        type: string
        label: Note
  - name: item
    fields:
      title:
        type: string
        label: Title
      owner:
        type: ref
        to: member
        label: Owner
      quantity:
        type: number
        label: Quantity
      state:
        type: enum
        label: State
        options:
          open: Open
          doing: Doing
          done: Done
        default: open
computed:
  - name: itemCount
    entity: member
    aggregate:
      count: item
      where:
        owner: this
    type: number
    label: Items
views:
  - name: board
    type: board
    entity: item
    columns: state
  - name: items
    type: list
    entity: item
    show: [title, owner, quantity, state]
  - name: members
    type: table
    entity: member
actions:
  - name: addMember
    entity: member
  - name: addItem
    entity: item
    kind: create
  - name: finish
    entity: item
    kind: update
    set:
      state: done
    when: state == "open"
validations:
  - name: positiveQuantity
    entity: item
    expression: quantity >= 1
    message: Quantity must be at least 1
permissions:
  - name: read
    subject: minIdentity
  - name: write
    subject: minIdentity
minIdentity:
  mode: anonymous
`;
const DEF = {
  id: "T",
  structures: [{
    id: "main",
    roles: { main: { entity: {} }, status: { field: { of: "main", type: "enum", labels: ["Open", "Doing", "Done"] } }, qty: { field: { of: "main", type: "number" } } },
    checks: [
      { req: "default-state", kind: "enumDefault", field: "status", label: "Open" },
      { req: "advance", kind: "advanceAction", field: "status", from: "Open", to: "Done" },
      { req: "board", kind: "boardColumns", field: "status" },
      { req: "creatable", kind: "creatable", entities: ["main"] },
      { req: "quantity-rule", kind: "validation", entity: "main", cases: [{ set: { qty: 0 }, valid: false }, { set: { qty: 1 }, valid: true }] },
    ],
  }],
};

// ── 表・持ち越し・試験（目印の文字列 needle）
const own = (id) => ({ id, basis: "stated", reason: null });
const ROWS = [
  { id: "e.item", kind: "entity", entity: null, name: "item" },
  { id: "f.item.state", kind: "field", entity: "e.item", name: "state" },
  { id: "f.item.quantity", kind: "field", entity: "e.item", name: "quantity" },
  { id: "o.finish", kind: "operation", entity: "e.item", name: "finish" },
  { id: "c.ghost", kind: "computation", entity: null, name: "ghost" },
];
const OWNERSHIP = [
  { requirementId: "R1", roles: [own("f.item.state")] },
  { requirementId: "R2", roles: [own("o.finish")] },
  { requirementId: "R3", roles: [own("f.item.quantity")] },
  { requirementId: "R4", roles: [own("c.ghost")] },
  { requirementId: "R5", roles: [] },
];
const t = (id, req, roleId, needle) => ({ id, kind: "normal", target: { requirementId: req, kind: "field", roleId }, ...(needle === null ? {} : { needle }) });
/** 試験の組：good（原本と合う）・weak（落とす力が弱い）・strong（when の目印も見る）・bad（原本に無い目印。試験と原本が合わない） */
const SUITES = {
  good: [t("t-default", "R1", "f.item.state", "default: open"), t("t-kind", "R2", "o.finish", "kind: update"), t("t-qty", "R3", "f.item.quantity", "quantity >= 1"), t("t-carried", "R4", "c.ghost", "itemCount")],
  weak: [t("t-kind", "R2", "o.finish", "kind: update"), t("t-carried", "R4", "c.ghost", "itemCount")],
  strong: [t("t-default", "R1", "f.item.state", "default: open"), t("t-kind", "R2", "o.finish", "kind: update"), t("t-when", "R2", "o.finish", 'when: state == "open"'), t("t-qty", "R3", "f.item.quantity", "quantity >= 1"), t("t-carried", "R4", "c.ghost", "itemCount")],
  bad: [t("t-default", "R1", "f.item.state", "default: never-written"), t("t-carried", "R4", "c.ghost", "itemCount")],
};
const observesOf = (suite) => suite.map((x) => ({ testId: x.id, observes: x.id === "t-kind" ? "existence" : "default-value" }));
const CARRY = { entries: [{ requirementId: "R4", reasons: [{ origin: "name-table", detail: "carried" }] }], excluded_row_ids: ["c.ghost"], remaining_requirement_ids: ["R1", "R2", "R3", "R5"], non_requirements: ["R5"] };
const REQS = ["R1", "R2", "R3", "R4", "R5"].map((id) => ({ id, text: `text ${id}` }));
const planOf = (pid) => ({ plan_id: `plan-${pid}`, vocabulary_version: "v1", requirements: REQS });
const reqText = (pid) => `request ${pid} line 1`;
const PSHA = (pid) => sha256(JSON.stringify(planOf(pid))), SSHA = (pid) => sha256(`${reqText(pid)}\n`);
const envelopeOf = (pid) => Buffer.from(JSON.stringify({ schema_version: "musunest-factory/plan-only-result/v1", outcome: "confirmed", plan: planOf(pid), plan_sha256: PSHA(pid), source_sha256: SSHA(pid) }));
const versions = { vocabulary: "v1", contract: "v0.2", prompt: "v1.2", factory: "0.0.0", ledger: "ledger-a", flags: FLAGS };
function checkpointOf(pid, boundary, suiteKey = "good", { table = TSHA(pid) } = {}) {
  const suite = SUITES[suiteKey];
  return {
    schema_version: "musunest.factory.v11a-stage-checkpoint/v1", boundary, versions, plan_sha256: PSHA(pid), source_sha256: SSHA(pid),
    name_table: { table_sha256: table, rows: ROWS, ownership: OWNERSHIP, verification: [], classification: [] },
    semantic_check: { table_sha256: table, targets: [], judgments: [] }, judge_advice: {}, carry_over: CARRY,
    ...(boundary === "t2-b1" ? { test_spec: { suite_sha256: sha256(JSON.stringify(suite)), suite: { tests: suite }, observes: observesOf(suite), coverage_units: [{ id: "u1" }, { id: "u2" }], natures: [] } } : {}),
  };
}
const digestOf = (cp) => sha256(JSON.stringify(cp));
const PIDS = ["P1", "P2", "P3"];

/** 偽物のリポジトリ（合成の工場の dist・spec-engine と appspec-schema の symlink・定義ファイル・題材の定義） */
function makeRepo(base) {
  const repo = join(base, "repo");
  const w = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
  w("packages/factory/package.json", JSON.stringify({ name: "fake-factory", type: "module" }));
  w("packages/factory/dist/index.js", FAKE_INDEX);
  w("packages/factory/dist/cli.js", FAKE_CLI);
  w("packages/factory/dist/cli-plan.js", FAKE_CLI_PLAN);
  for (const n of ["spec-engine", "appspec-schema"]) symlinkSync(join(root, "packages", n), join(repo, "packages", n));
  const ev = "workspace/mvp/m1/agent/eval";
  w(`${ev}/subjects/T.json`, JSON.stringify(DEF));
  const items = ["P1", "P2", "P3", "P4"].map((id) => ({ id, subject: "T", style: "S1", writable: true, scoring: "../subjects/T.json", script: null, request: [reqText(id)] }));
  w(SET_PATH, JSON.stringify({ schema: EVAL_SET_SCHEMA, id: "u2-test-set", version: 1, role: "development", title: "t", styles: { S1: "s1" }, items }));
  return repo;
}

/** 合成の参照の計測（受理済みの宣言と表）。decl ＝ P → { run, table（受理済みの表の SHA）, declaration（無ければ null）} */
function writeReferenceMeasurement(base, name, decl, { measurementId = "ref-686" } = {}) {
  const out = join(base, name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "conditions.json"), JSON.stringify({ schema: "musunest-factory/agent-accept-conditions/v7", measurement_id: measurementId, params: { pipeline: "v1.2" } }));
  for (const [pid, d] of Object.entries(decl)) {
    const art = join(out, d.run, "bundle/artifacts");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "name-table.json"), JSON.stringify({ table_sha256: d.table, rows: [] }));
    if (d.declaration !== null) writeFileSync(join(art, "app.spec.yaml"), d.declaration);
    void pid;
  }
  return out;
}
/** 合成の上流の組（境界 t1-t2。採用 adopted・外した missing）。review ＝ false なら人の採否が未反映 */
function writeUpstream(base, name, refOut, adopted, missing, { review = true } = {}) {
  const dir = join(base, name);
  const entries = adopted.map(({ pid, run }) => {
    const cp = checkpointOf(pid, "t1-t2"), cpBytes = Buffer.from(JSON.stringify(cp)), rec = Buffer.from(JSON.stringify({ schema_version: "musunest.factory.v11a-stage-run/v1", checkpoints: [{ boundary: "t1-t2", path: "stage-checkpoint-t1-t2.json", output_digest: digestOf(cp) }] }));
    mkdirSync(join(dir, "inputs", run), { recursive: true });
    writeFileSync(join(dir, "inputs", run, "stage-checkpoint-t1-t2.json"), cpBytes);
    writeFileSync(join(dir, "inputs", run, "stage-run.json"), rec);
    return { pattern: pid, run, started_at: "2026-10-20T00:00:00.000Z", checkpoint: { path: `inputs/${run}/stage-checkpoint-t1-t2.json`, sha256: sha256(cpBytes), output_digest: digestOf(cp) }, record: { path: `inputs/${run}/stage-run.json`, sha256: sha256(rec) }, table_sha256: TSHA(pid), score: { correct: 1, denominator: 1 } };
  });
  const set = {
    schema: FROZEN_STAGE_SET_SCHEMA, id: "u1-t", version: 1, boundary: "t1-t2", rule: { name: "best-scored-complete", version: 1 },
    plan_set: { id: "plan-set-t", version: 1, sha256: sha256("plan-set") },
    source: { conditions_sha256: sha256(readFileSync(join(refOut, "conditions.json"))), measurement_id: "ref-686", pipeline: "v1.2", v12_flags: FLAGS, score_sha256: sha256("score") },
    adopted: entries, missing: missing.map((pid) => ({ pattern: pid, reason: "no-checkpoint" })),
    ...(review ? { review: { sha256: sha256("review"), author: "owner", date: "2026-10-20" } } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FROZEN_STAGE_SET_FILE), stageSetBytes(set));
  return dir;
}

/**
 * 合成の U2 の計測（条件 v8・段の走り test-spec..test-spec）。spec ＝ 本 → { kind, suite }。kind：pass（T2' を通る）・stopped（T2 で止まる）・absent（入力なし）・
 * none（起こしたが記録が無い）・digest（checkpoint の中身が記録の出力ダイジェストと合わない）・table（checkpoint の表の SHA が参照の宣言と違う）
 */
function writeU2(base, name, repo, upstreamDir, spec, { edit = null, comparison = null } = {}) {
  const out = join(base, name);
  mkdirSync(out, { recursive: true });
  const upBytes = readFileSync(join(upstreamDir, FROZEN_STAGE_SET_FILE)), up = JSON.parse(upBytes.toString("utf8"));
  const ids = Object.keys(spec);
  const stageInputs = ids.map((id) => {
    const pid = id.split("-")[0];
    return spec[id].kind === "absent" ? { id, absent: true } : { id, checkpoint_sha256: sha256("cp"), record_sha256: sha256("rec"), output_digest: digestOf(checkpointOf(pid, "t1-t2")), record_file: "stage-run.json" };
  });
  const cond = {
    schema: CONDITIONS_V8, measurement_id: name, source: { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false },
    factory: { dist_dir: "packages/factory/dist", fingerprint: fingerprintDir(join(repo, "packages/factory/dist")).fingerprint },
    spec_engine: { dist_dir: "packages/spec-engine/dist", fingerprint: fingerprintDir(join(repo, "packages/spec-engine/dist")).fingerprint },
    set: { path: SET_PATH, sha256: sha256(readFileSync(join(repo, SET_PATH))), id: "u2-test-set", version: 1 },
    params: {
      mode: "stage-run", pipeline: "v1.2", v12_flags: FLAGS, patterns: [...new Set(ids.map((id) => id.split("-")[0]))], runs: 2,
      stage_start: "test-spec", stage_end: "test-spec", budget_scope: "stage-run", stage_from: { kind: "frozen-stage-input-set", id: up.id, version: up.version, sha256: sha256(upBytes) }, stage_inputs: stageInputs,
    },
    child_args: ids.map((id) => ({ id, argv: spec[id].kind === "absent" ? null : ["cli.js", id] })),
    frozen: { path: "plan-set.json", sha256: sha256("plan-set"), id: "plan-set-t", version: 1, adopted: PIDS.map((pid) => ({ pattern: pid, plan_sha256: PSHA(pid), source_sha256: SSHA(pid), envelope_sha256: sha256(envelopeOf(pid)) })), missing: [] },
    ...(comparison === null ? {} : { comparison }),
  };
  if (edit !== null) edit(cond);
  cond.signature = conditionsSignature(cond);
  writeFileSync(join(out, "conditions.json"), JSON.stringify(cond, null, 1));
  for (const id of ids) {
    const { kind, suite = "good" } = spec[id], pid = id.split("-")[0], dir = join(out, id), bundle = join(dir, "bundle");
    if (kind === "absent") continue;
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(dir, "plan-file.json"), envelopeOf(pid));
    if (kind === "none") continue;
    const cp = checkpointOf(pid, "t2-b1", suite, kind === "table" ? { table: sha256("other-table") } : {});
    const passed = kind !== "stopped";
    if (passed) writeFileSync(join(bundle, "stage-checkpoint-t2-b1.json"), JSON.stringify(kind === "digest" ? { ...cp, judge_advice: { edited: true } } : cp, null, 2));
    writeFileSync(join(bundle, "stage-run.json"), JSON.stringify({
      schema_version: "musunest.factory.v11a-stage-run/v1", range: { start: "test-spec", end: "test-spec" },
      input: { checkpoint: "stage-checkpoint-t1-t2.json", boundary: "t1-t2", output_digest: digestOf(checkpointOf(pid, "t1-t2")) },
      plan_sha256: PSHA(pid), source_sha256: SSHA(pid), checkpoints: passed ? [{ boundary: "t2-b1", path: "stage-checkpoint-t2-b1.json", output_digest: digestOf(cp) }] : [],
      stage_pass: passed, test_spec: passed ? { tests: SUITES[suite].length, dropped_tests: 1, coverage_units: 2 } : null,
    }));
  }
  return out;
}

const BASE_SPEC = {
  "P1-r1": { kind: "pass" }, "P1-r2": { kind: "stopped" },
  "P2-r1": { kind: "pass", suite: "bad" }, "P2-r2": { kind: "digest" },
  "P3-r1": { kind: "pass" }, "P3-r2": { kind: "absent" },
};
/** 世界：偽物のリポジトリ・参照の計測（P1・P2 は宣言あり、P3 は納品物の宣言が無い）・上流の組（P1〜P3 を採用）・参照の宣言の組・U2 の計測 */
function world() {
  const base = mkdtempSync(join(tmpdir(), "score-stage-tests-"));
  const repo = makeRepo(base);
  const refOut = writeReferenceMeasurement(base, "ref", { P1: { run: "P1-r2", table: TSHA("P1"), declaration: SRC }, P2: { run: "P2-r1", table: TSHA("P2"), declaration: SRC }, P3: { run: "P3-r1", table: TSHA("P3"), declaration: null } });
  const upstream = writeUpstream(base, "upstream", refOut, [{ pid: "P1", run: "P1-r2" }, { pid: "P2", run: "P2-r1" }, { pid: "P3", run: "P3-r1" }], []);
  const reference = join(base, "reference");
  const made = makeReferenceSet({ referenceOut: refOut, upstreamDir: upstream, id: "ref-set-t", version: 1 });
  for (const c of made.copies) { mkdirSync(dirname(join(reference, c.rel)), { recursive: true }); writeFileSync(join(reference, c.rel), c.bytes); }
  writeFileSync(join(reference, REFERENCE_SET_FILE), referenceBytes(made.set));
  const u2 = writeU2(base, "u2", repo, upstream, BASE_SPEC);
  return { base, repo, refOut, upstream, reference, u2, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const runNode = (argv) => spawnSync(process.execPath, [tool, ...argv], { encoding: "utf8" });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** 手で組んだ文脈（P の文脈は組・持ち越し・要件でない文を除いた一覧・所属。ledger は checkpoint の版の旗） */
function handContext(suiteKey) {
  const keep = ["R1", "R2", "R3"];
  return {
    schema: CONTEXT_SCHEMA,
    table: { rows: ROWS, ownership: OWNERSHIP, verification: [], classification: [] },
    list: { requirements: keep.map((id) => ({ id, text: `text ${id}`, quote: `text ${id}`, position: { start: 0, end: 0 } })) },
    suite: { tests: SUITES[suiteKey].filter((x) => x.target.requirementId !== "R4") },
    ownership: [{ requirementId: "R1", roles: ["f.item.state"] }, { requirementId: "R2", roles: ["o.finish"] }, { requirementId: "R3", roles: ["f.item.quantity"] }],
    excluded_row_ids: ["c.ghost"],
    observes: Object.fromEntries(observesOf(SUITES[suiteKey]).map((o) => [o.testId, o.observes])),
    carry_over: { entries: CARRY.entries },
    rejected_test_ids: [],
    non_requirements: ["R5"],
    ledger: { on: true },
  };
}
/** 手計算：手 5a の出力の非同値の変異に、目印の規則（目印が宣言に無ければ落ちる）を当てる。行は場所の頭で手で当てる */
function handRates(out5a, suiteKey) {
  const tests = SUITES[suiteKey].filter((x) => x.target.requirementId !== "R4");
  const rowOf = (place) => (place.startsWith("item.state") ? "f.item.state" : place.startsWith("actions.finish") ? "o.finish" : place.startsWith("item.quantity") ? "f.item.quantity" : null);
  const eligible = out5a.mutants.filter((m) => m.class === "non-equivalent");
  const killedBy = (m) => tests.filter((x) => !m.source.includes(x.needle)).map((x) => x.id);
  const fail = eligible.filter((m) => killedBy(m).length > 0).length;
  const per = tests.map((x) => { const hits = eligible.filter((m) => rowOf(m.place) === x.target.roleId); return { eligible: hits.length, killed: hits.filter((m) => killedBy(m).includes(x.id)).length }; });
  const targeted = per.filter((p) => p.eligible > 0);
  return { primary: [fail, eligible.length], uncatchable: [targeted.filter((p) => p.killed === 0).length, targeted.length] };
}

test("#686 U2 の採点：本ごとの文脈が手で組んだ文脈と深く等しく、検出率・落とせない試験の率・P の合算・群の件数（予定を分母）が手計算と一致し、台帳 on の評価口に dist の台帳の見方が渡る", async () => {
  const w = world();
  try {
    globalThis.u2SeenEvaluators = [];
    const outDir = join(w.base, "out");
    const out = await scoreStageTests({ repo: w.repo, measureDir: w.u2, referenceDir: w.reference, outDir });
    const row = (id) => out.rows.find((r) => r.run === id);
    assert.deepEqual(out.rows.map((r) => [r.run, r.state, r.reason]), [
      ["P1-r1", "evaluated", null], ["P1-r2", "stage-failed", null], ["P2-r1", "evaluated", null], ["P2-r2", "mismatch", "digest"], ["P3-r1", "no-reference", null], ["P3-r2", "input-absent", null],
    ]);
    // 文脈：手で組んだものと深く等しく、SHA を出力に残す
    for (const [id, suite] of [["P1-r1", "good"], ["P2-r1", "bad"]]) {
      const bytes = readFileSync(join(outDir, "contexts", `${id}.json`));
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), handContext(suite), id);
      assert.deepEqual(row(id).files.context, { path: `contexts/${id}.json`, sha256: sha256(bytes) });
    }
    // 手 5b の候補の状態と率（手計算）
    const out5a = readJson(join(outDir, "mutants", "P1.json"));
    const hand = handRates(out5a, "good");
    assert.ok(hand.primary[1] > 0 && hand.uncatchable[1] > 0, "前提：適格な変異と、それを対象に持つ試験がある");
    const c = row("P1-r1").candidate;
    assert.equal(c.status, "aligned");
    assert.deepEqual([c.detection.primary.k, c.detection.primary.n], hand.primary);
    assert.deepEqual([c.uncatchable.rate.k, c.uncatchable.rate.n], hand.uncatchable);
    assert.equal(row("P2-r1").candidate.status, "test-origin-mismatch");
    assert.equal(row("P2-r1").candidate.eligible, 0);
    assert.deepEqual(row("P1-r1").t2, { tests: 4, dropped_tests: 1, coverage_units: 2 });
    assert.equal(row("P1-r2").candidate, null);
    // P の合算と群の件数（分母は予定 6 本）
    const p1 = out.group.by_p.find((p) => p.pattern === "P1");
    assert.deepEqual([p1.planned, p1.scored, p1.primary.k, p1.primary.n], [2, 1, ...hand.primary]);
    const p2 = out.group.by_p.find((p) => p.pattern === "P2");
    assert.deepEqual([p2.scored, p2.primary.rate, p2.primary.reason_code], [0, null, "no-eligible-mutants"]);
    assert.deepEqual(out.group.runs, {
      planned: 6, input_absent: 1, missing: 0, mismatch: 1, mismatch_reasons: { range: 0, input: 0, plan: 0, checkpoint: 0, digest: 1, table: 0, context: 0 },
      observed: 4, stage_passed: 3, stage_failed: 1, no_reference: 1, origin_unusable: 0, test_origin_mismatch: 1, no_eligible: 0, scored: 1,
    });
    const r = out.group.runs;
    assert.equal(r.input_absent + r.missing + r.mismatch + r.stage_failed + r.no_reference + r.origin_unusable + r.test_origin_mismatch + r.no_eligible + r.scored, r.planned, "分母は予定（黙って落とさない）");
    assert.deepEqual([out.group.stage_pass.k, out.group.stage_pass.n], [3, 6]);
    assert.equal(out.group.by_p_mean.primary.p_with_rate, 1);
    assert.equal(out.group.by_p_mean.primary.mean_over_p, Math.round((hand.primary[0] / hand.primary[1]) * 1e6) / 1e6);
    assert.equal(out.group.by_p_mean.primary.interval.m, 1);
    assert.equal(out.group.by_p_mean.primary.interval.bootstrap.interval, null, "P が 1 つなら区間は null と理由");
    // 台帳 on：評価口を作る引数に、目録の工場の dist（合成）の台帳の見方が渡る
    assert.ok(globalThis.u2SeenEvaluators.length >= 2);
    for (const input of globalThis.u2SeenEvaluators) assert.deepEqual(input.ledger, { rows: ["fake-ledger-row"] });
    // 出力先の目録・手 5a の出力（SHA を出力に残す）。参照の宣言の組の missing
    assert.equal(out.fingerprints.files.mutants[0].sha256, sha256(readFileSync(join(outDir, "mutants", "P1.json"))));
    assert.equal(out.fingerprints.inventory.sha256, sha256(readFileSync(join(outDir, "inventory.json"))));
    assert.deepEqual(out.reference.missing, [{ pattern: "P3", reason: "no-declaration" }]);
    // 出力に宣言の原文・要件の文を写さない
    const text = JSON.stringify(out);
    for (const s of ["default: open", "text R1", "positiveQuantity", "kind: update"]) assert.ok(!text.includes(s), s);
  } finally { w.cleanup(); }
});

test("#686 P の合算と群：P ごとに K 本の分子の和 ÷ 分母の和、群は P を単位にした平均と bootstrap の区間（手計算）。分母 0 の P は null と理由で平均から外す", () => {
  const rate = (k, n) => ({ k, n, rate: n === 0 ? null : k / n });
  const cand = (pk, pn, uk, un) => ({ status: "aligned", eligible: pn, by_category: {}, detection: { primary: rate(pk, pn), secondary: rate(pk, pn) }, uncatchable: { tests: 3, with_eligible_mutants: un, rate: rate(uk, un) } });
  const rows = [
    { run: "P1-r1", pattern: "P1", state: "evaluated", stage_pass: true, candidate: cand(1, 4, 1, 2) },
    { run: "P1-r2", pattern: "P1", state: "evaluated", stage_pass: true, candidate: cand(3, 4, 0, 2) },
    { run: "P2-r1", pattern: "P2", state: "evaluated", stage_pass: true, candidate: cand(1, 1, 0, 1) },
    { run: "P2-r2", pattern: "P2", state: "mismatch", reason: "table", stage_pass: true, candidate: null },
    { run: "P3-r1", pattern: "P3", state: "evaluated", stage_pass: true, candidate: cand(0, 0, 0, 0) },
    { run: "P3-r2", pattern: "P3", state: "input-absent", stage_pass: null, candidate: null },
  ];
  const g = aggregateGroup(rows);
  const p = (pid) => g.by_p.find((x) => x.pattern === pid);
  assert.deepEqual([p("P1").primary.k, p("P1").primary.n, p("P1").primary.rate], [4, 8, 0.5], "P1：(1+3)/(4+4)");
  assert.deepEqual([p("P1").uncatchable.k, p("P1").uncatchable.n], [1, 4]);
  assert.deepEqual([p("P2").primary.k, p("P2").primary.n, p("P2").primary.rate], [1, 1, 1]);
  assert.deepEqual([p("P3").primary.rate, p("P3").primary.reason_code], [null, "no-eligible-mutants"]);
  assert.equal(g.by_p_mean.primary.mean_over_p, 0.75, "P を単位にした平均：(0.5 + 1) / 2");
  assert.equal(g.by_p_mean.primary.p_without_rate, 1);
  assert.equal(g.by_p_mean.primary.interval.m, 2);
  assert.ok(Array.isArray(g.by_p_mean.primary.interval.bootstrap.interval));
  assert.deepEqual([g.pooled_reference.primary.k, g.pooled_reference.primary.n], [5, 9]);
  assert.equal(g.pooled_reference.primary.wilson95_reference.name, "参考（独立を仮定）");
  assert.deepEqual([g.runs.planned, g.runs.scored, g.runs.no_eligible, g.runs.mismatch, g.runs.input_absent], [6, 3, 1, 1, 1]);
});

test("#686 本ごとの口 (b)：出力ダイジェスト・表の SHA・入力・確定した仕様の合わない本は mismatch に数えて予定に残り、評価されない（何も断らない）", async () => {
  const w = world();
  try {
    const spec = { "P1-r1": { kind: "table" }, "P1-r2": { kind: "pass" }, "P2-r1": { kind: "digest" }, "P2-r2": { kind: "pass" }, "P3-r1": { kind: "pass" }, "P3-r2": { kind: "pass" } };
    const u2 = writeU2(w.base, "u2-b", w.repo, w.upstream, spec);
    // P2-r2 は記録の入力の出力ダイジェストが条件と違う、P3-r2 は確定した仕様の写しが違う
    const rec = join(u2, "P2-r2", "bundle", "stage-run.json"), v = readJson(rec);
    v.input.output_digest = sha256("another-input");
    writeFileSync(rec, JSON.stringify(v));
    writeFileSync(join(u2, "P3-r2", "plan-file.json"), envelopeOf("P1"));
    const out = await scoreStageTests({ repo: w.repo, measureDir: u2, referenceDir: w.reference, outDir: join(w.base, "out-b") });
    assert.deepEqual(out.rows.map((r) => [r.run, r.state, r.reason]), [
      ["P1-r1", "mismatch", "table"], ["P1-r2", "evaluated", null], ["P2-r1", "mismatch", "digest"], ["P2-r2", "mismatch", "input"], ["P3-r1", "no-reference", null], ["P3-r2", "mismatch", "plan"],
    ]);
    for (const id of ["P1-r1", "P2-r1", "P2-r2", "P3-r2"]) assert.equal(out.rows.find((r) => r.run === id).candidate, null, id);
    assert.deepEqual([out.group.runs.planned, out.group.runs.mismatch, out.group.runs.scored + out.group.runs.no_eligible], [6, 4, 1]);
    assert.deepEqual(out.group.runs.mismatch_reasons, { range: 0, input: 1, plan: 1, checkpoint: 0, digest: 1, table: 1, context: 0 });
    assert.ok(!existsSync(join(w.base, "out-b", "contexts", "P1-r1.json")), "mismatch の本の文脈を書かない");
  } finally { w.cleanup(); }
});

test("#686 計測全体の口 (a)：組の SHA・条件の版・範囲・dist の指紋・参照の宣言の組の署名と写しの不一致は、何も書かず exit 3・固定の符号（値・パスを出さない）", async () => {
  const w = world();
  try {
    const cases = [
      ["frozen-set", writeU2(w.base, "a1", w.repo, w.upstream, BASE_SPEC, { edit: (c) => { c.params.stage_from.sha256 = sha256("another-set"); } }), w.reference, "stage-tests:frozen-set"],
      ["version", writeU2(w.base, "a2", w.repo, w.upstream, BASE_SPEC, { edit: (c) => { c.schema = "musunest-factory/agent-accept-conditions/v6"; } }), w.reference, "stage-tests:conditions-version"],
      ["range", writeU2(w.base, "a3", w.repo, w.upstream, BASE_SPEC, { edit: (c) => { c.params.stage_start = "write"; } }), w.reference, "stage-tests:range"],
      ["dist", writeU2(w.base, "a4", w.repo, w.upstream, BASE_SPEC, { edit: (c) => { c.factory.fingerprint = sha256("another-dist"); } }), w.reference, "stage-tests:dist"],
    ];
    const badSig = join(w.base, "ref-sig");
    cpSync(w.reference, badSig, { recursive: true });
    const s = readJson(join(badSig, REFERENCE_SET_FILE));
    s.id = "edited";
    writeFileSync(join(badSig, REFERENCE_SET_FILE), JSON.stringify(s));
    cases.push(["reference-signature", w.u2, badSig, "stage-tests:reference-signature"]);
    const badCopy = join(w.base, "ref-copy");
    cpSync(w.reference, badCopy, { recursive: true });
    writeFileSync(join(badCopy, "declarations", "P1", "app.spec.yaml"), `${SRC}# edited\n`);
    cases.push(["reference-sha256", w.u2, badCopy, "stage-tests:reference-sha256"]);
    for (const [label, u2, ref, code] of cases) {
      const outDir = join(w.base, `never-${label}`);
      const r = runNode([w.repo, u2, ref, outDir]);
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.equal(r.stderr.trim(), `断りました: [${code}]`, label);
      assert.equal(r.stdout, "");
      assert.equal(existsSync(outDir), false, `${label}: 出力先を作った`);
      await assert.rejects(scoreStageTests({ repo: w.repo, measureDir: u2, referenceDir: ref, outDir }), (e) => e instanceof StageTestsError && e.code === code);
      assert.equal(existsSync(outDir), false);
    }
  } finally { w.cleanup(); }
});

test("#686 --make-reference：採用した本の受理済みの宣言を写し、表の SHA の違う本・納品物の無い本・組が外した P が missing に理由つきで出て、署名が中身と一致する。負例は何も書かず exit 3", () => {
  const base = mkdtempSync(join(tmpdir(), "score-stage-tests-ref-"));
  try {
    const refOut = writeReferenceMeasurement(base, "ref", {
      P1: { run: "P1-r2", table: TSHA("P1"), declaration: SRC }, P2: { run: "P2-r1", table: sha256("rewritten-table"), declaration: SRC }, P3: { run: "P3-r1", table: TSHA("P3"), declaration: null },
    });
    const upstream = writeUpstream(base, "upstream", refOut, [{ pid: "P1", run: "P1-r2" }, { pid: "P2", run: "P2-r1" }, { pid: "P3", run: "P3-r1" }], ["P4"]);
    const dest = join(base, "reference");
    const r = runNode(["--make-reference", refOut, upstream, dest, "--id", "ref-set-t", "--version", "1"]);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(join(dest, REFERENCE_SET_FILE)), set = JSON.parse(bytes.toString("utf8"));
    assert.ok(r.stdout.includes(sha256(bytes)));
    assert.equal(set.schema, REFERENCE_SET_SCHEMA);
    assert.deepEqual(set.rule, { name: "adopted-run-declaration", version: 1 });
    assert.deepEqual(set.frozen_set, { id: "u1-t", version: 1, sha256: sha256(readFileSync(join(upstream, FROZEN_STAGE_SET_FILE))) });
    assert.deepEqual(set.source, { conditions_sha256: sha256(readFileSync(join(refOut, "conditions.json"))), measurement_id: "ref-686" });
    assert.deepEqual(set.declarations, [{ pattern: "P1", origin: "P1-r2", declaration: { path: "declarations/P1/app.spec.yaml", sha256: sha256(SRC) }, table_sha256: TSHA("P1"), marks: null }]);
    assert.deepEqual(set.missing, [{ pattern: "P2", reason: "table-mismatch" }, { pattern: "P3", reason: "no-declaration" }, { pattern: "P4", reason: "upstream-missing" }]);
    assert.equal(set.signature, referenceSignature(set));
    assert.equal(readFileSync(join(dest, "declarations", "P1", "app.spec.yaml"), "utf8"), SRC);
    assert.equal(loadReferenceSet(dest).status, "ok");
    // 負例：条件の SHA が組の source.conditions_sha256 と違う参照の計測（同じ本 ID・同じ表 SHA）・review の無い組・署名の合わない組
    const other = writeReferenceMeasurement(base, "ref-other", { P1: { run: "P1-r2", table: TSHA("P1"), declaration: SRC } }, { measurementId: "another" });
    const noReview = writeUpstream(base, "upstream-no-review", refOut, [{ pid: "P1", run: "P1-r2" }], [], { review: false });
    const badSig = join(base, "upstream-bad-sig");
    cpSync(upstream, badSig, { recursive: true });
    const s = readJson(join(badSig, FROZEN_STAGE_SET_FILE));
    s.id = "edited";
    writeFileSync(join(badSig, FROZEN_STAGE_SET_FILE), JSON.stringify(s));
    for (const [label, ro, up, code] of [["source", other, upstream, "make-reference:source-mismatch"], ["review", refOut, noReview, "make-reference:set-review"], ["signature", refOut, badSig, "make-reference:set-signature"]]) {
      const d = join(base, `never-${label}`);
      const x = runNode(["--make-reference", ro, up, d, "--id", "ref-set-t", "--version", "1"]);
      assert.equal(x.status, 3, `${label}: ${x.stderr}`);
      assert.equal(x.stderr.trim(), `断りました: [${code}]`, label);
      assert.equal(existsSync(d), false, `${label}: 書いた`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#686 --compare：同じ P・同じ回の本を対にした主の検出率と落とせない試験の率の差（after − before）と P のまとまり、片側が評価できない対は理由ごとに除く", async () => {
  const w = world();
  try {
    const cmp = join(w.base, "cmp");
    mkdirSync(cmp);
    const pairsValue = { schema: STAGE_PAIRS_SCHEMA, frozen_sha256: sha256("plan-set"), groups: ["before", "after"], runs: 2, stage: { start: "test-spec", end: "test-spec", stage_from_sha256: sha256("x") }, pairs: [{ pid: "P1", r: 1, first: "before" }, { pid: "P1", r: 2, first: "after" }, { pid: "P2", r: 1, first: "before" }, { pid: "P2", r: 2, first: "after" }] };
    const pairsBytes = Buffer.from(JSON.stringify(pairsValue));
    writeFileSync(join(cmp, "pairs.json"), pairsBytes);
    const comparisonOf = (g) => ({ group: g, role: g === "before" ? "baseline" : "candidate", pairs_sha256: sha256(pairsBytes) });
    writeU2(cmp, "before", w.repo, w.upstream, { "P1-r1": { kind: "pass", suite: "weak" }, "P1-r2": { kind: "stopped" }, "P2-r1": { kind: "pass", suite: "bad" }, "P2-r2": { kind: "pass" }, "P3-r1": { kind: "pass" }, "P3-r2": { kind: "absent" } }, { comparison: comparisonOf("before"), edit: (c) => { c.factory.fingerprint = sha256("before-checkout"); } });
    writeU2(cmp, "after", w.repo, w.upstream, { "P1-r1": { kind: "pass", suite: "strong" }, "P1-r2": { kind: "pass" }, "P2-r1": { kind: "pass" }, "P2-r2": { kind: "digest" }, "P3-r1": { kind: "pass" }, "P3-r2": { kind: "absent" } }, { comparison: comparisonOf("after") });
    const rec = { schema: STAGE_COMPARISON_SCHEMA, pairs: { sha256: sha256(pairsBytes), count: 4 }, groups: { before: {}, after: {} } };
    writeFileSync(join(cmp, "comparison.json"), JSON.stringify({ ...rec, signature: sha256(JSON.stringify(rec)) }));
    const outDir = join(w.base, "out-cmp");
    const r = runNode([w.repo, cmp, w.reference, outDir, "--compare", "--anonymous"]);
    assert.equal(r.status, 0, r.stderr);
    const out = readJson(join(outDir, COMPARE_FILE));
    const out5a = readJson(join(outDir, "mutants", "P1.json"));
    const [hb, ha] = [handRates(out5a, "weak"), handRates(out5a, "strong")];
    const rateOf = ([k, n]) => (n === 0 ? null : k / n);
    const d = out.pairs.primary;
    assert.equal(d.n, 1);
    assert.equal(d.rows.find((x) => x.run === "P1-r1").diff, Math.round((rateOf(ha.primary) - rateOf(hb.primary)) * 1e6) / 1e6);
    assert.deepEqual(d.excluded, { unlaunched: 0, missing: 0, mismatch: 1, "stage-failed": 1, "no-reference": 0, "not-aligned": 1, "no-eligible": 0 });
    assert.equal(d.clusters.m, 1);
    assert.equal(out.pairs.uncatchable.excluded.mismatch, 1);
    assert.deepEqual(Object.keys(out.groups), ["before", "after"]);
    assert.equal(out.groups.after.group.runs.planned, 6);
    // 匿名の口：P の番号・本の ID・宣言の名前・パス・SHA が無い
    const anonText = readFileSync(join(outDir, anonymousFileOf(COMPARE_FILE)), "utf8");
    assert.doesNotMatch(anonText, /[0-9a-f]{64}/);
    assert.doesNotMatch(anonText, /"P\d|P\d-r\d|\bP[1-4]\b/);
    for (const s of [w.base, "app.spec.yaml", "contexts/", "u1-t", "finish", "t-default", "f.item"]) assert.ok(!anonText.includes(s), s);
    const anon = JSON.parse(anonText);
    assert.equal(anon.anonymous, true);
    assert.equal(anon.groups.after.runs.planned, 6);
    assert.equal(anon.pairs.primary.n, 1);
    assert.ok(Object.keys(anon.groups.after.by_operator).every((k) => ["remove-field", "flip-comparison", "remove-when", "reorder-options", "change-default", "remove-validation", "swap-aggregate"].includes(k)));
    assert.match(r.stdout, /対の差（after − before）/);
    assert.doesNotMatch(r.stdout, /P\d/);
  } finally { w.cleanup(); }
});

test("#686 --anonymous（単独）：件数・率・区間・演算子の ID だけ。P の番号・本の ID・パス・SHA が無い", async () => {
  const w = world();
  try {
    const outDir = join(w.base, "out-anon");
    const r = runNode([w.repo, w.u2, w.reference, outDir, "--anonymous"]);
    assert.equal(r.status, 0, r.stderr);
    const full = readJson(join(outDir, OUTPUT_FILE));
    const text = readFileSync(join(outDir, anonymousFileOf(OUTPUT_FILE)), "utf8");
    assert.deepEqual(JSON.parse(text), toAnonymous(full));
    assert.doesNotMatch(text, /[0-9a-f]{64}/);
    assert.doesNotMatch(text, /P\d/);
    for (const s of [w.base, "app.spec.yaml", "contexts/", "u1-t", "ref-set-t"]) assert.ok(!text.includes(s), s);
    assert.equal(JSON.parse(text).group.runs.planned, 6);
    assert.match(r.stdout, /予定 6・入力なし 1/);
  } finally { w.cleanup(); }
});

test("#686 静的な走査：道具が工場の package を import しない・通信と LLM と判定の口が無い。工場の側はこの道具を参照しない", () => {
  const code = readFileSync(tool, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /from\s+["']@musunest\//);
  assert.doesNotMatch(code, /from\s+["'][^"']*packages\//);
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|node:(http|https|net|tls|dgram|child_process)|openai|anthropic|process\.env|\bjudge[A-Z(]/i);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|mjs|js|json)$/.test(e.name) ? [join(d, e.name)] : []));
  for (const f of walk(join(root, "packages"))) assert.ok(!readFileSync(f, "utf8").includes("score-stage-tests"), f);
});

test("#686 題材の言葉と価格：道具・試験・README の新しい節に無い", () => {
  // 語は符号の列で持つ（この試験のファイル自身に書かない）
  const words = [[0x6301, 0x3061, 0x5bc4, 0x308a], [0x5f53, 0x756a, 0x8868], [0x4f1a, 0x8cbb], [0x51fa, 0x6b20], [0x8cb8, 0x3057, 0x51fa, 0x3057]].map((cs) => String.fromCodePoint(...cs));
  const readme = readFileSync(join(here, "../README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n#### 10.8.2 "));
  for (const text of [readFileSync(tool, "utf8"), readFileSync(fileURLToPath(import.meta.url), "utf8"), section]) {
    for (const w of words) assert.ok(!text.includes(w), w);
    assert.doesNotMatch(text, /[\u00a5\uffe5]\s?\d|\d\s?\u5186|\$\d/);
  }
});

test("#686 README：§10.8.1 の後ろに §10.8.2 があり、定義の語があって、§7 の先頭より前と §7.11 の先頭より前のバイト列は変わらない", () => {
  const text = readFileSync(join(here, "../README.md"), "utf8");
  const at = text.indexOf("\n#### 10.8.2 ");
  assert.ok(at > text.indexOf("\n#### 10.8.1 ") && text.indexOf("\n#### 10.8.1 ") > 0, "§10.8.2 は §10.8.1 の後ろ");
  const sec = text.slice(at);
  assert.equal(sec.indexOf("\n#", 1), -1, "§10.8.2 が末尾");
  for (const w of ["U2", "参照の宣言", "条件付き", "分母は予定", "版 1", "納品の成功ではない", "mismatch", "--make-reference", "adopted-run-declaration", "table-mismatch", "no-declaration", "upstream-missing", "--compare", "--anonymous", "ledgerViewOf", "fingerprints.tool"]) assert.ok(sec.includes(w), w);
  assert.equal(sha256(text.slice(0, text.indexOf("## 7. 表の採点（正解の表との照合）") - 1)), "662d41ded93107ecd130dfa090b09df1280ec78277509d131bf21b253e82cba4");
  assert.equal(sha256(text.slice(0, text.indexOf("### 7.11 断った候補の下書きの採点（読取元 (c)。#607）") - 1)), "1c21bdefca9e6e5373316f7ce143bdad580dea3d25ad5d1bbda1e8e64f9b2e1f");
});
