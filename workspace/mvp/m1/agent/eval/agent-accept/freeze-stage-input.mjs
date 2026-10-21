// 凍結した上流の組の道具（#640。README §10.8.1）：参照の計測（経路 v1.2 で境界の checkpoint を書いた計測）とそれを採点した表の採点の出力から、P ごとに 1 本の
// 境界の checkpoint と前の走りの記録を規則で選び、組（frozen-stage-input-set/v1）と写しを組のディレクトリに置く。API は呼ばない（工場の dist の照合の関数を当てるだけ）。
// 使い方: node freeze-stage-input.mjs <repo> <参照の計測の出力先> <表の採点の出力（JSON）> <組のディレクトリ> --id <組の ID> --version <整数> --boundary <境界>
//         node freeze-stage-input.mjs <組のディレクトリ> --adopt <採否のファイル>
//   規則（best-scored-complete v1）：P ごとに、境界の checkpoint を宣言し（Build だけの記録か段の走りの記録の checkpoints）、工場の dist の照合の関数が通り、
//   表の採点の出力にその本の行があり二値（正答・誤り）の要件が 1 件以上ある本を有効な候補とし、正答率が最も高い本を採る。同点は started_at が早い本、同じなら回の番号の小さい本。
//   分母 0・未採点の本は候補から外す（0 点に読み替えない）。本を選ばせる引数は作らない。有効な候補の無い P は組から外して missing に理由の符号を残す
//   --adopt：人の採否（P ごとの adopt／exclude）を組に反映し、除外の P を missing（human-excluded:<符号>）へ移して review を足し、署名し直す。写しと版は変えない
//   置き場所はリポジトリの外。道具は場所を引数で受け取るだけ。断るときは exit 3 と、符号・本の ID・件数だけの 1 行（値は出さない）。何も書かない
// run-agent.mjs は、ここから組の読み込み（--stage-from に組のディレクトリを渡す口）を import する
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONDITIONS_V7, CONDITIONS_V8, STAGE_FROM_SET_KIND, STAGE_RUN_MODE, V12_PIPELINE, conditionsSignature, isFlagMap, loadConditions, loadEvalSet, sameFlags, sha256 } from "./score-agent.mjs";
import { loadFrozenSet, loadPlanFileChecks, refuseWith } from "./freeze-plan-set.mjs";
import { BINARY_OUTCOMES, OUTPUT_SCHEMA as TABLE_SCORE_SCHEMA } from "../table/score-table.mjs";

/** 組の版・組のディレクトリの中の組のファイルの名前と写しの置き場所 */
export const FROZEN_STAGE_SET_SCHEMA = "musunest-eval/frozen-stage-input-set/v1";
export const FROZEN_STAGE_SET_FILE = "frozen-stage-input-set.json";
export const FROZEN_STAGE_INPUT_DIR = "inputs";
/** 条件の params.stage_from に書く組の種類（上流の計測の形 { conditions_sha256, signature, range } と見分ける） */
export const FROZEN_STAGE_SET_KIND = STAGE_FROM_SET_KIND;
/** 凍結の規則の名前と版（版 1 の組。所有者の決定 2026-10-18） */
export const STAGE_FREEZE_RULE = { name: "best-scored-complete", version: 1 };
/** 有効な候補の無い P の理由の符号（境界の checkpoint を宣言した本が無い・照合を通った本が無い・二値の要件のある採点の行が無い） */
export const MISSING_REASONS = ["no-checkpoint", "verify-failed", "no-scored-candidate"];
/** 人の採否のファイルの版・決定・担当と、人が外した P の理由の接頭辞 */
export const STAGE_REVIEW_SCHEMA = "musunest-eval/frozen-stage-input-review/v1";
export const REVIEW_DECISIONS = ["adopt", "exclude"];
export const REVIEW_AUTHORS = ["owner", "scorer"];
export const HUMAN_EXCLUDED = "human-excluded";
/** 凍結の入力にできる参照の計測の条件の版（経路 v1.2 の一気通貫 v7 と、v1.2 の段の走り v8） */
export const STAGE_FREEZABLE_CONDITIONS = [CONDITIONS_V7, CONDITIONS_V8];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const PID = /^P\d+$/;
const RUN_ID = /^(P\d+)-r(\d+)$/;
const CODE = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pidNumber = (pid) => Number(pid.slice(1));

/** 組のファイルの署名：署名の欄を除いた組の JSON の SHA-256（欄の順は組を作った順のまま） */
export function stageSetSignature(set) {
  const { signature: _s, ...rest } = set;
  return sha256(JSON.stringify(rest));
}
/** 組のファイルのバイト列（署名を付けて書く形） */
export const stageSetBytes = (set) => Buffer.from(JSON.stringify({ ...set, signature: stageSetSignature(set) }, null, 1) + "\n");

/** 組の中の相対パス（inputs/<本>/<名前> の形で、.. を含まない） */
const safeRel = (p) => typeof p === "string" && p !== "" && !isAbsolute(p) && p.split("/").length === 3 && p.split("/")[0] === FROZEN_STAGE_INPUT_DIR && !p.split("/").includes("..") && !p.split("/").includes(".");
/** 組の形を確かめる（理由は返さない。値を書かない） */
function stageSetShapeOk(set) {
  if (!isObj(set) || set.schema !== FROZEN_STAGE_SET_SCHEMA || typeof set.id !== "string" || set.id === "" || !Number.isInteger(set.version) || typeof set.boundary !== "string") return false;
  if (!isObj(set.rule) || !isObj(set.plan_set) || typeof set.plan_set.id !== "string" || !Number.isInteger(set.plan_set.version) || !HEX64.test(set.plan_set.sha256 ?? "")) return false;
  if (!isObj(set.source) || typeof set.source.pipeline !== "string" || !isFlagMap(set.source.v12_flags) || !HEX64.test(set.source.conditions_sha256 ?? "") || !HEX64.test(set.source.score_sha256 ?? "")) return false;
  if (!Array.isArray(set.adopted) || !Array.isArray(set.missing) || typeof set.signature !== "string") return false;
  const seen = new Set();
  for (const a of set.adopted) {
    if (!isObj(a) || typeof a.pattern !== "string" || !PID.test(a.pattern) || seen.has(a.pattern)) return false;
    seen.add(a.pattern);
    const m = typeof a.run === "string" ? RUN_ID.exec(a.run) : null;
    if (m === null || m[1] !== a.pattern) return false;
    if (!isObj(a.checkpoint) || !safeRel(a.checkpoint.path) || a.checkpoint.path.split("/")[1] !== a.run || !HEX64.test(a.checkpoint.sha256 ?? "") || typeof a.checkpoint.output_digest !== "string") return false;
    if (!isObj(a.record) || !safeRel(a.record.path) || a.record.path.split("/")[1] !== a.run || !HEX64.test(a.record.sha256 ?? "")) return false;
  }
  for (const m of set.missing) {
    if (!isObj(m) || typeof m.pattern !== "string" || !PID.test(m.pattern) || seen.has(m.pattern) || typeof m.reason !== "string") return false;
    seen.add(m.pattern);
  }
  if ("review" in set && (!isObj(set.review) || !HEX64.test(set.review.sha256 ?? "") || !REVIEW_AUTHORS.includes(set.review.author) || typeof set.review.date !== "string" || !DATE.test(set.review.date))) return false;
  return true;
}

/**
 * 組のディレクトリを読む（run-agent.mjs --stage-from。組のファイルがあるディレクトリ）。無ければ missing、JSON でなければ unreadable、形が違えば invalid、
 * 署名が中身と合わなければ signature、写しが無い・読めない・SHA が組の値と違えば sha256（その P）。通れば組・組のファイルの SHA-256 と、採用した P ごとの写しのバイト列と名前
 */
export function loadFrozenStageSet(dir) {
  const path = join(dir, FROZEN_STAGE_SET_FILE);
  if (!existsSync(path)) return { status: "missing" };
  let bytes, set;
  try { bytes = readFileSync(path); set = JSON.parse(bytes.toString("utf8")); } catch { return { status: "unreadable" }; }
  if (!stageSetShapeOk(set)) return { status: "invalid" };
  if (stageSetSignature(set) !== set.signature) return { status: "signature" };
  const inputs = new Map();
  for (const a of set.adopted) {
    let checkpointBytes, recordBytes;
    try { checkpointBytes = readFileSync(join(dir, a.checkpoint.path)); recordBytes = readFileSync(join(dir, a.record.path)); } catch { return { status: "sha256", ids: [a.pattern] }; }
    if (sha256(checkpointBytes) !== a.checkpoint.sha256 || sha256(recordBytes) !== a.record.sha256) return { status: "sha256", ids: [a.pattern] };
    inputs.set(a.pattern, { checkpointBytes, recordBytes, checkpointFile: basename(a.checkpoint.path), recordFile: basename(a.record.path), outputDigest: a.checkpoint.output_digest });
  }
  return { status: "ok", set, bytes, sha256: sha256(bytes), inputs };
}

// ── 凍結
const readJsonOrNull = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

/** 工場の dist から、段の表・照合の関数・記録の置き場所・版・包みの検査の関数・旗の組と台帳の指紋を読む（名前を写さない） */
async function loadStageDist(distDir) {
  try {
    const lib = await import(pathToFileURL(join(distDir, "v11a/bundle-v11a.js")).href);
    const cli = await import(pathToFileURL(join(distDir, "cli.js")).href);
    const cliPlan = await import(pathToFileURL(join(distDir, "cli-plan.js")).href);
    const entry = await import(pathToFileURL(join(distDir, "index.js")).href);
    const checks = await loadPlanFileChecks(distDir);
    if (!Array.isArray(lib.STAGE_BOUNDARIES) || !Array.isArray(lib.STAGE_STARTS) || typeof lib.boundaryBefore !== "function" || typeof lib.stageCheckpointFile !== "function" || typeof lib.verifyStageInput !== "function" || typeof lib.STAGE_RUN_RECORD_FILE !== "string") return null;
    if (typeof cliPlan.BUILD_CLI_RECORD_FILE !== "string" || typeof cli.VOCABULARY_VERSION !== "string" || typeof cli.CONTRACT_VERSION !== "string") return null;
    if (!isFlagMap(entry.V12_PIPELINE_FLAGS) || typeof entry.propertyLedgerSha256 !== "function") return null;
    const ledger = await entry.propertyLedgerSha256();
    if (typeof ledger !== "string") return null;
    return { lib, cli, entry, checks, recordFiles: [lib.STAGE_RUN_RECORD_FILE, cliPlan.BUILD_CLI_RECORD_FILE], v12: { ledger, flags: JSON.parse(JSON.stringify(entry.V12_PIPELINE_FLAGS)) } };
  } catch { return null; }
}

/** 正答率の比較（a が b より高ければ負）。分母は 1 以上（有効な候補だけ） */
const byRate = (a, b) => b.correct * a.denominator - a.correct * b.denominator;

/**
 * 参照の計測の出力先と表の採点の出力から組を作る。断るときは { code, ids?, count? }、作れたら { set（署名なし）, copies: [{ rel, bytes }] } を返す（書き込みは呼び出し側）
 */
export async function freezeStageInputSet({ repo, outRoot, scorePath, id, version, boundary }) {
  if (typeof id !== "string" || id === "" || !Number.isInteger(version) || typeof boundary !== "string") return { code: "freeze:args" };
  const dist = await loadStageDist(join(repo, "packages/factory/dist"));
  if (dist === null) return { code: "freeze:dist-unreadable" };
  const { lib } = dist;
  if (!lib.STAGE_BOUNDARIES.includes(boundary)) return { code: "freeze:boundary" };
  const start = lib.STAGE_STARTS.find((s) => lib.boundaryBefore(s) === boundary);
  if (start === undefined) return { code: "freeze:boundary" };
  // #713：境界が dist の境界の表の最初（上流の段だけが前にある境界）なら、照合の関数に上流の台帳の部分の指紋（upstreamLedgerSha256）の今の値も渡す。
  // 関数が無い・例外・返りの値が 64 桁の 16 進でなければ dist の読み取りの失敗。ほかの境界では部分の関数を取らず・呼ばない（今までの dist も受ける）
  let v12 = dist.v12;
  if (boundary === lib.STAGE_BOUNDARIES[0]) {
    if (typeof dist.entry.upstreamLedgerSha256 !== "function") return { code: "freeze:dist-unreadable" };
    let ledgerUpstream = null;
    try { ledgerUpstream = await dist.entry.upstreamLedgerSha256(); } catch { ledgerUpstream = null; }
    if (typeof ledgerUpstream !== "string" || !HEX64.test(ledgerUpstream)) return { code: "freeze:dist-unreadable" };
    v12 = { ledger: dist.v12.ledger, ledgerUpstream, flags: dist.v12.flags };
  }
  // 参照の計測の条件：経路 v1.2（v7 か v8）・署名が中身と合う・旗の組が今の dist と同じ・凍結した組 (b) の SHA が今の (b) と同じ
  const loaded = loadConditions(outRoot);
  if (loaded.status === "missing") return { code: "freeze:conditions-missing" };
  if (loaded.status !== "ok") return { code: "freeze:conditions-unreadable" };
  const cond = loaded.cond;
  if (!STAGE_FREEZABLE_CONDITIONS.includes(cond.schema) || !isObj(cond.params) || typeof cond.signature !== "string" || cond.signature !== conditionsSignature(cond)) return { code: "freeze:conditions-invalid" };
  if (cond.params.pipeline !== V12_PIPELINE || (cond.schema === CONDITIONS_V8 && cond.params.mode !== STAGE_RUN_MODE)) return { code: "freeze:conditions-pipeline" };
  if (!isFlagMap(cond.params.v12_flags) || !sameFlags(cond.params.v12_flags, dist.v12.flags)) return { code: "freeze:conditions-flags" };
  if (!isObj(cond.frozen) || typeof cond.frozen.path !== "string" || !HEX64.test(cond.frozen.sha256 ?? "")) return { code: "freeze:conditions-frozen" };
  const fz = loadFrozenSet(cond.frozen.path);
  if (fz.status !== "ok") return { code: "freeze:plan-set-unreadable" };
  if (fz.sha256 !== cond.frozen.sha256) return { code: "freeze:conditions-frozen" };
  const evalSet = typeof cond.set?.path === "string" ? loadEvalSet(resolve(repo, cond.set.path)) : { status: "missing" };
  if (evalSet.status !== "ok") return { code: "freeze:set-unreadable" };
  if (evalSet.sha256 !== cond.set.sha256 || fz.set.set.sha256 !== evalSet.sha256) return { code: "freeze:set-sha256" };
  const conditionsSha = sha256(readFileSync(join(outRoot, "conditions.json")));
  // 表の採点の出力：表の採点の版で、その計測の条件のファイルを採点したもの（出どころの契約。#639）。行の本は計測の予定の中だけ
  let scoreBytes, score;
  try { scoreBytes = readFileSync(scorePath); score = JSON.parse(scoreBytes.toString("utf8")); } catch { return { code: "freeze:score-unreadable" }; }
  if (!isObj(score) || score.schema !== TABLE_SCORE_SCHEMA || !isObj(score.scoring) || !Array.isArray(score.scoring.rows) || !isObj(score.fingerprint)) return { code: "freeze:score-unreadable" };
  if (score.fingerprint.conditions_sha256 !== conditionsSha) return { code: "freeze:score-mismatch" };
  const planned = Array.isArray(cond.child_args) ? cond.child_args.map((a) => a?.id) : [];
  if (planned.length === 0 || !planned.every((x) => typeof x === "string" && RUN_ID.test(x))) return { code: "freeze:conditions-invalid" };
  const launched = new Set(cond.child_args.filter((a) => a.argv !== null).map((a) => a.id));
  const rowOf = new Map();
  for (const r of score.scoring.rows) {
    if (!isObj(r) || typeof r.run !== "string" || !planned.includes(r.run) || rowOf.has(r.run)) return { code: "freeze:score-mismatch" };
    rowOf.set(r.run, r);
  }
  const checkpointFile = lib.stageCheckpointFile(boundary);
  const patterns = [...new Set(planned.map((x) => RUN_ID.exec(x)[1]))];
  const adopted = [], missing = [], copies = [];
  for (const pid of patterns) {
    const item = evalSet.byId.get(pid), entry = fz.set.adopted.find((a) => a.pattern === pid);
    if (item === undefined || entry === undefined) return { code: "freeze:plan-set-unreadable", ids: [pid] };
    // 照合の関数に渡す確定した仕様（(b) の包みの写しを検査の関数で読み直す）
    let envBytes;
    try { envBytes = readFileSync(fz.envelopeOf.get(pid)); } catch { return { code: "freeze:plan-set-unreadable", ids: [pid] }; }
    if (sha256(envBytes) !== entry.envelope.sha256) return { code: "freeze:plan-set-unreadable", ids: [pid] };
    const parsed = dist.checks.parsePlanFile(envBytes.toString("utf8"));
    const validated = isObj(parsed) && isObj(parsed.envelope) ? await dist.checks.validatePlanFile({ envelope: parsed.envelope, source: item.requestText + "\n", vocabularyVersion: dist.checks.vocabularyVersion }) : null;
    if (validated?.kind !== "ok") return { code: "freeze:plan-set-unreadable", ids: [pid] };
    let declaring = 0, verified = 0;
    const candidates = [];
    for (const run of planned.filter((x) => RUN_ID.exec(x)[1] === pid && launched.has(x))) {
      const bundle = join(outRoot, run, "bundle");
      // 前の走りの記録：段の走りの記録、無ければ checkpoint を宣言した Build だけの記録（工場が前の走りの記録として読む順と同じ）
      let recordFile = null, recordBytes = null, record = null;
      for (const name of dist.recordFiles) {
        const p = join(bundle, name);
        if (!existsSync(p)) continue;
        try { recordBytes = readFileSync(p); record = JSON.parse(recordBytes.toString("utf8")); } catch { return { code: "freeze:record-unreadable", ids: [run] }; }
        if (name === lib.STAGE_RUN_RECORD_FILE || (isObj(record) && Array.isArray(record.checkpoints) && record.checkpoints.length > 0)) { recordFile = name; break; }
        recordBytes = null; record = null;
      }
      const declared = isObj(record) && Array.isArray(record.checkpoints) ? record.checkpoints.find((c) => isObj(c) && c.boundary === boundary) : undefined;
      if (recordFile === null || declared === undefined) continue; // (i) 境界の checkpoint を宣言しない本
      declaring += 1;
      let checkpointBytes = null;
      try { checkpointBytes = readFileSync(join(bundle, checkpointFile)); } catch { checkpointBytes = null; }
      const v = await lib.verifyStageInput({
        start, checkpointText: checkpointBytes === null ? null : checkpointBytes.toString("utf8"), checkpointFile, recordText: recordBytes.toString("utf8"),
        plan: validated.plan, planSha256: entry.plan_sha256, sourceSha256: entry.source_sha256,
        vocabularyVersion: dist.cli.VOCABULARY_VERSION, contractVersion: dist.cli.CONTRACT_VERSION, v12,
      });
      if (v?.ok !== true) continue; // (ii) 照合の関数が通らない本
      verified += 1;
      // (iii) 表の採点の行があり、二値の要件が 1 件以上（分母 0・未採点の本は外す。0 点に読み替えない）
      const row = rowOf.get(run);
      const reqs = isObj(row) && Array.isArray(row.requirements) ? row.requirements.filter((q) => isObj(q) && BINARY_OUTCOMES.includes(q.outcome)) : [];
      if (reqs.length === 0) continue;
      const startedAt = readJsonOrNull(join(outRoot, run, "summary.line.json"))?.started_at;
      const ms = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
      if (!Number.isFinite(ms)) return { code: "freeze:started-at", ids: [run] };
      let cp;
      try { cp = JSON.parse(checkpointBytes.toString("utf8")); } catch { cp = null; }
      candidates.push({
        run, r: Number(RUN_ID.exec(run)[2]), ms, started_at: startedAt, recordFile, recordBytes, checkpointBytes,
        output_digest: declared.output_digest, row_table_sha256: row.table_sha256 ?? null, checkpoint_table_sha256: isObj(cp?.name_table) ? cp.name_table.table_sha256 ?? null : null,
        correct: reqs.filter((q) => q.outcome === "correct").length, denominator: reqs.length,
      });
    }
    if (candidates.length === 0) { missing.push({ pattern: pid, reason: declaring === 0 ? "no-checkpoint" : verified === 0 ? "verify-failed" : "no-scored-candidate" }); continue; }
    const pick = candidates.sort((a, b) => byRate(a, b) || a.ms - b.ms || a.r - b.r)[0];
    // 採る本の表の SHA：採点の行の table_sha256 と checkpoint の表の SHA の両方と一致（別の計測・別の表を採点した出力は断る）
    if (typeof pick.checkpoint_table_sha256 !== "string" || pick.row_table_sha256 !== pick.checkpoint_table_sha256) return { code: "freeze:score-mismatch", ids: [pick.run] };
    const cpRel = `${FROZEN_STAGE_INPUT_DIR}/${pick.run}/${checkpointFile}`, recRel = `${FROZEN_STAGE_INPUT_DIR}/${pick.run}/${pick.recordFile}`;
    copies.push({ rel: cpRel, bytes: pick.checkpointBytes }, { rel: recRel, bytes: pick.recordBytes });
    adopted.push({
      pattern: pid, run: pick.run, started_at: pick.started_at,
      checkpoint: { path: cpRel, sha256: sha256(pick.checkpointBytes), output_digest: pick.output_digest },
      record: { path: recRel, sha256: sha256(pick.recordBytes) },
      table_sha256: pick.checkpoint_table_sha256, score: { correct: pick.correct, denominator: pick.denominator },
    });
  }
  if (adopted.length === 0) return { code: "freeze:none-adopted", count: missing.length };
  const set = {
    schema: FROZEN_STAGE_SET_SCHEMA, id, version, boundary, rule: STAGE_FREEZE_RULE,
    plan_set: { id: fz.set.id, version: fz.set.version, sha256: fz.sha256 },
    source: { conditions_sha256: conditionsSha, measurement_id: cond.measurement_id ?? null, pipeline: cond.params.pipeline, v12_flags: cond.params.v12_flags, score_sha256: sha256(scoreBytes) },
    adopted, missing,
  };
  return { set, copies };
}

/**
 * 人の採否を組に反映する。断るときは { code, ids? }、通れば署名し直した組（署名なしの値）を返す。採否のファイルは採用した P をちょうど 1 回ずつ指す
 * （無い P・組の採用に無い P・同じ P を 2 回指すのは断る）。人が本を選び直す口は無い（除外だけ）
 */
export function applyReview(set, reviewBytes) {
  if ("review" in set) return { code: "adopt:already-reviewed" };
  let rv;
  try { rv = JSON.parse(Buffer.from(reviewBytes).toString("utf8")); } catch { return { code: "adopt:unreadable" }; }
  if (!isObj(rv) || rv.schema !== STAGE_REVIEW_SCHEMA || !REVIEW_AUTHORS.includes(rv.author) || typeof rv.date !== "string" || !DATE.test(rv.date) || !Array.isArray(rv.decisions)) return { code: "adopt:invalid" };
  if (!isObj(rv.set) || rv.set.id !== set.id || rv.set.version !== set.version) return { code: "adopt:set-mismatch" };
  const adoptedIds = set.adopted.map((a) => a.pattern), seen = new Map(), dup = [], unknown = [];
  for (const d of rv.decisions) {
    if (!isObj(d) || typeof d.pattern !== "string" || !PID.test(d.pattern) || !REVIEW_DECISIONS.includes(d.decision)) return { code: "adopt:invalid" };
    if (d.decision === "exclude" ? typeof d.reason !== "string" || !CODE.test(d.reason) : d.reason !== undefined && d.reason !== null && (typeof d.reason !== "string" || !CODE.test(d.reason))) return { code: "adopt:invalid" };
    if (!adoptedIds.includes(d.pattern)) { unknown.push(d.pattern); continue; }
    if (seen.has(d.pattern)) dup.push(d.pattern); else seen.set(d.pattern, d);
  }
  if (unknown.length > 0) return { code: "adopt:unknown-p", ids: unknown };
  if (dup.length > 0) return { code: "adopt:duplicate-p", ids: [...new Set(dup)] };
  const absent = adoptedIds.filter((p) => !seen.has(p));
  if (absent.length > 0) return { code: "adopt:missing-p", ids: absent };
  const excluded = adoptedIds.filter((p) => seen.get(p).decision === "exclude");
  const missing = [...set.missing, ...excluded.map((p) => ({ pattern: p, reason: `${HUMAN_EXCLUDED}:${seen.get(p).reason}` }))].sort((a, b) => pidNumber(a.pattern) - pidNumber(b.pattern));
  const { signature: _s, ...rest } = set;
  return { set: { ...rest, adopted: set.adopted.filter((a) => !excluded.includes(a.pattern)), missing, review: { sha256: sha256(reviewBytes), author: rv.author, date: rv.date } } };
}

function isEntry() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--adopt")) {
    // 人の採否の反映：組のディレクトリと採否のファイルだけ。組のファイルの写し（checkpoint と記録）には触らない
    const [dest] = args, reviewPath = opt("--adopt");
    if (dest === undefined || dest.startsWith("--") || reviewPath === undefined || reviewPath.startsWith("--") || args.length !== 3) refuseWith("adopt:args");
    const loaded = loadFrozenStageSet(resolve(dest));
    if (loaded.status !== "ok") refuseWith(`adopt:set-${loaded.status}`, { ids: loaded.ids ?? null });
    let reviewBytes;
    try { reviewBytes = readFileSync(resolve(reviewPath)); } catch { refuseWith("adopt:unreadable"); }
    const r = applyReview(loaded.set, reviewBytes);
    if (r.code !== undefined) refuseWith(r.code, { ids: r.ids ?? null });
    const bytes = stageSetBytes(r.set);
    writeFileSync(join(resolve(dest), FROZEN_STAGE_SET_FILE), bytes);
    console.log(`採否を反映しました: 採用 ${r.set.adopted.length} P、外した ${r.set.missing.length} P、組の SHA-256 ${sha256(bytes)}`);
  } else {
    const [repo, outRoot, scorePath, dest] = args;
    if ([repo, outRoot, scorePath, dest].some((x) => x === undefined || x.startsWith("--"))) refuseWith("freeze:args");
    const versionText = opt("--version");
    const version = versionText !== undefined && /^\d+$/.test(versionText) ? Number(versionText) : NaN;
    let destUsed = false;
    try { destUsed = existsSync(dest) && readdirSync(dest).length > 0; } catch { destUsed = true; } // ディレクトリでない出力先も空でない扱い
    if (destUsed) refuseWith("freeze:out-not-empty");
    const r = await freezeStageInputSet({ repo: resolve(repo), outRoot: resolve(outRoot), scorePath: resolve(scorePath), id: opt("--id"), version, boundary: opt("--boundary") });
    if (r.code !== undefined) refuseWith(r.code, { ids: r.ids ?? null, count: r.count ?? null });
    for (const c of r.copies) { mkdirSync(join(dest, c.rel, ".."), { recursive: true }); writeFileSync(join(dest, c.rel), c.bytes); }
    const bytes = stageSetBytes(r.set);
    writeFileSync(join(dest, FROZEN_STAGE_SET_FILE), bytes);
    console.log(`凍結しました: 採用 ${r.set.adopted.length} P、外した ${r.set.missing.length} P、組の SHA-256 ${sha256(bytes)}`);
  }
}
