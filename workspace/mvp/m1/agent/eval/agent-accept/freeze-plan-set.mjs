// (b) の凍結の道具（#497。README §5.7）：Plan 評価（run-agent.mjs --plan-only）の出力先から、P ごとに 1 本の確定した仕様を規則で選び、
// 凍結した組（frozen-plan-set/v1）と採用した本の包みの写しを組のディレクトリに置く。API は呼ばない（工場の dist の包みの検査の関数を当てるだけ）。
// 使い方: node freeze-plan-set.mjs <repo> <Plan 評価の出力先> <組のディレクトリ> --id <組の ID> --version <整数>
//   規則（earliest-confirmed v1）：P ごとに、包みの結果が確定した本のうち、起動の記録の started_at が最も早い本を採る。同じ時刻なら回の番号の小さい本。
//   Build の記録（要約の verdict・納品物・Build だけの記録）は読まない。本を選ばせる引数は作らない。確定した本の無い P は組から外して missing に残す
//   置き場所は計測の出力先と同じくリポジトリの外。道具は場所を引数で受け取るだけ。断るときは exit 3 と、符号・本の ID・件数だけの 1 行（値は出さない）
// run-agent.mjs は、ここから組の読み込みと包みの検査（工場の dist の関数を当てる）と断りの行を import する（--build-from の事前の検査。同じ検査を 2 か所に書かない）
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConditions, loadEvalSet, reconcile, sha256, validatePlanned } from "./score-agent.mjs";

/** 凍結した組の版。人が作る (a) も同じ形（origin が human、author が owner か scorer） */
export const FROZEN_SET_SCHEMA = "musunest-eval/frozen-plan-set/v1";
/** 組のディレクトリの中の組のファイルの名前と、包みの写しの置き場所 */
export const FROZEN_SET_FILE = "frozen-plan-set.json";
export const FROZEN_ENVELOPE_DIR = "envelopes";
export const FROZEN_ORIGINS = ["frozen-plan", "human"];
export const FROZEN_AUTHORS = ["owner", "scorer"];
/** 凍結の規則の名前と版（D4。2026-10-15 所有者の決定） */
export const FREEZE_RULE = { name: "earliest-confirmed", version: 1 };
/** 凍結の入力にできる条件の版（params.mode が plan-only の計測） */
export const CONDITIONS_V4 = "musunest-factory/agent-accept-conditions/v4";
/** 工場が --plan-only で --out の直下に書く Plan だけの結果（packages/factory の PLAN_ONLY_RESULT_FILE。本のディレクトリでは bundle/ の下） */
export const PLAN_RESULT_PATH = "bundle/plan-result.json";
// 工場の --plan-file の標準出力の行の版と、値を持たない符号・検査の名前（packages/factory/src/cli-plan.ts と同じ値。ここに無い値は unknown に写す）
export const PLAN_FILE_ERROR_SCHEMA = "musunest-factory/plan-file-error/v1";
export const PLAN_FILE_REJECT_SCHEMA = "musunest-factory/plan-file-reject/v1";
export const PLAN_FILE_ERROR_CODES = ["plan-file-read", "plan-file-json", "plan-file-envelope", "plan-file-required", "plan-file-type"];
export const PLAN_FILE_CHECKS = ["envelope-version", "outcome", "plan", "plan-sha256", "source-sha256", "vocabulary"];
const known = (list, x) => (list.includes(x) ? x : "unknown");
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const PID = /^P\d+$/;
const RUN_ID = /^P\d+(-r\d+)?$/;

/**
 * 断りの 1 行（標準エラー）：固定の符号と、本の ID（P<n> か P<n>-r<n> の形のものだけ）・件数だけ。入力の文字列は通さない。
 * extra は既存の断りの文（run-agent.mjs の #400〜#427 の断り。値を含まない固定の文か、今までどおりの文）を符号の前に置く
 */
export function refusalLine(code, { ids = null, count = null, text = null } = {}) {
  const shown = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && RUN_ID.test(id)) : [];
  const n = count ?? (Array.isArray(ids) ? ids.length : null);
  // 1 行に保つ（呼ぶ側は入力の文字列を text に入れない。それでも改行が混じれば空白に写す）
  const oneLine = text === null ? null : String(text).replace(/[\r\n\u2028\u2029]+/g, " ");
  return `断りました: ${oneLine === null ? "" : `${oneLine} `}[${code}]${shown.length > 0 ? ` ids=${shown.join(",")}` : ""}${n === null ? "" : ` count=${n}`}`;
}
export const refuseWith = (code, opts) => { console.error(refusalLine(code, opts)); process.exit(3); };

/** 工場の dist から、包みの読み取りと検査の関数（純粋な関数）と語彙の版を読む（--plan-file と同じ検査を当てるため） */
export async function loadPlanFileChecks(distDir) {
  const cliPlan = await import(pathToFileURL(join(distDir, "cli-plan.js")).href);
  const cli = await import(pathToFileURL(join(distDir, "cli.js")).href);
  if (typeof cliPlan.parsePlanFile !== "function" || typeof cliPlan.validatePlanFile !== "function" || typeof cli.VOCABULARY_VERSION !== "string") throw new Error("工場の dist が包みの検査の関数か語彙の版を公開していない");
  return { parsePlanFile: cliPlan.parsePlanFile, validatePlanFile: cliPlan.validatePlanFile, vocabularyVersion: cli.VOCABULARY_VERSION };
}

/**
 * 包みのバイト列に、工場が --plan-file で行う検査（必須欄・入れ子の型・結果の種類・checkConfirmedPlan・planDigest・包みの source_sha256・語彙の版）を当てる。
 * sourceText は今の依頼文（request.md と同じ文字列）。通れば 2 つの SHA と包み、断れば符号（envelope-unreadable か envelope-rejected）と既知の詳細だけ
 * （検査の message・入力の値は返さない）
 */
export async function checkEnvelope(checks, bytes, sourceText) {
  const text = Buffer.from(bytes).toString("utf8");
  const parsed = checks.parsePlanFile(text);
  if (!isObj(parsed) || "code" in parsed || !isObj(parsed.envelope)) return { ok: false, code: "envelope-unreadable", detail: known(PLAN_FILE_ERROR_CODES, parsed?.code) };
  const v = await checks.validatePlanFile({ envelope: parsed.envelope, source: sourceText, vocabularyVersion: checks.vocabularyVersion });
  if (v?.kind !== "ok") return { ok: false, code: "envelope-rejected", detail: known(PLAN_FILE_CHECKS, v?.check) };
  return { ok: true, planSha256: v.planSha256, sourceSha256: v.sourceSha256, envelope: JSON.parse(text) };
}

/**
 * 凍結した組のファイルを読む（run-agent.mjs --build-from）。無ければ missing、JSON でなければ unreadable、形が違えば invalid（理由は数だけ。値を書かない）。
 * 通れば組・SHA-256・置き場所と、採用した P ごとの包みの写しの絶対パス
 */
export function loadFrozenSet(path) {
  if (!existsSync(path)) return { status: "missing" };
  let bytes, set;
  try { bytes = readFileSync(path); set = JSON.parse(bytes.toString("utf8")); } catch { return { status: "unreadable" }; }
  const bad = [];
  if (!isObj(set)) return { status: "invalid" };
  if (set.schema !== FROZEN_SET_SCHEMA) bad.push("schema");
  if (typeof set.id !== "string" || set.id === "") bad.push("id");
  if (!Number.isInteger(set.version)) bad.push("version");
  if (!FROZEN_ORIGINS.includes(set.origin)) bad.push("origin");
  if (set.origin === "human" && !FROZEN_AUTHORS.includes(set.author)) bad.push("author");
  if (!isObj(set.set) || typeof set.set.sha256 !== "string") bad.push("set");
  const adopted = Array.isArray(set.adopted) ? set.adopted : [];
  if (!Array.isArray(set.adopted) || adopted.length === 0) bad.push("adopted");
  const seen = new Set();
  for (const a of adopted) {
    if (!isObj(a) || typeof a.pattern !== "string" || !PID.test(a.pattern) || seen.has(a.pattern)) { bad.push("adopted.pattern"); continue; }
    seen.add(a.pattern);
    if (!isObj(a.envelope) || typeof a.envelope.path !== "string" || a.envelope.path === "" || isAbsolute(a.envelope.path) || typeof a.envelope.sha256 !== "string") bad.push("adopted.envelope");
    if (typeof a.plan_sha256 !== "string" || typeof a.source_sha256 !== "string") bad.push("adopted.sha256");
  }
  if (!Array.isArray(set.missing) || !set.missing.every((m) => isObj(m) && typeof m.pattern === "string" && PID.test(m.pattern) && !seen.has(m.pattern))) bad.push("missing");
  if (bad.length > 0) return { status: "invalid" };
  const dir = dirname(path);
  return { status: "ok", set, bytes, sha256: sha256(bytes), path, dir, envelopeOf: new Map(adopted.map((a) => [a.pattern, resolve(dir, a.envelope.path)])) };
}

// ── 凍結（入口として起動したときだけ動く）
const readJsonOrNull = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

/** Plan 評価の出力先から組を作る。断るときは { code, ids }、作れたら { frozen, envelopes: [{ rel, bytes }] } を返す（書き込みは呼び出し側） */
export async function freezePlanSet({ repo, outRoot, id, version }) {
  if (typeof id !== "string" || id === "" || !Number.isInteger(version)) return { code: "freeze:args" };
  const loaded = loadConditions(outRoot);
  if (loaded.status === "missing") return { code: "freeze:conditions-missing" };
  if (loaded.status !== "ok") return { code: "freeze:conditions-unreadable" };
  const cond = loaded.cond;
  if (cond.schema !== CONDITIONS_V4) return { code: "freeze:conditions-schema" };
  if (cond.params?.mode !== "plan-only") return { code: "freeze:mode" };
  if (validatePlanned(cond).length > 0) return { code: "freeze:planned" };
  if (cond.source?.dirty !== false) return { code: "freeze:dirty" };
  if (typeof cond.source?.commit !== "string" || cond.source.commit === "") return { code: "freeze:commit" };
  const evalSet = typeof cond.set?.path === "string" ? loadEvalSet(resolve(repo, cond.set.path)) : { status: "missing" };
  if (evalSet.status !== "ok") return { code: "freeze:set-unreadable" };
  if (evalSet.sha256 !== cond.set.sha256) return { code: "freeze:set-sha256" };
  if (reconcile(outRoot, evalSet).status !== "complete") return { code: "freeze:incomplete" };
  const checks = await loadPlanFileChecks(join(repo, "packages/factory/dist"));
  const adopted = [], missing = [], envelopes = [];
  for (const pid of cond.params.patterns) {
    const item = evalSet.byId.get(pid);
    if (item === undefined) return { code: "freeze:set-sha256", ids: [pid] };
    const candidates = [];
    for (let r = 1; r <= cond.params.runs; r++) {
      const run = `${pid}-r${r}`, dir = join(outRoot, run), envPath = join(dir, PLAN_RESULT_PATH);
      if (!existsSync(envPath)) continue; // 包みの無い本（止まった・落ちた）は確定ではない
      // 在るが読めない包み（ディレクトリなど）は固定の符号で断る（#497 の独立レビューの指摘 3）
      let bytes;
      try { bytes = readFileSync(envPath); } catch { return { code: "freeze:envelope-read", ids: [run] }; }
      let raw;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { return { code: "freeze:envelope-unreadable", ids: [run] }; }
      if (!isObj(raw) || raw.outcome !== "confirmed") continue;
      const checked = await checkEnvelope(checks, bytes, item.requestText + "\n");
      if (!checked.ok) return { code: `freeze:${checked.code}:${checked.detail}`, ids: [run] };
      if (!isObj(raw.conditions) || raw.conditions.model !== cond.params.model || raw.conditions.effort !== cond.params.effort) return { code: "freeze:envelope-conditions", ids: [run] };
      // 起動の記録から読むのは開始の時刻だけ（要約の verdict・納品物は読まない）
      const startedAt = readJsonOrNull(join(dir, "summary.line.json"))?.started_at;
      const ms = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
      if (!Number.isFinite(ms)) return { code: "freeze:started-at", ids: [run] };
      candidates.push({ run, r, started_at: startedAt, ms, bytes, plan_sha256: checked.planSha256, source_sha256: checked.sourceSha256 });
    }
    if (candidates.length === 0) { missing.push({ pattern: pid, runs: cond.params.runs }); continue; }
    const pick = candidates.sort((a, b) => a.ms - b.ms || a.r - b.r)[0];
    const rel = `${FROZEN_ENVELOPE_DIR}/${pick.run}.plan-result.json`;
    envelopes.push({ rel, bytes: pick.bytes });
    adopted.push({ pattern: pid, run: pick.run, started_at: pick.started_at, envelope: { path: rel, sha256: sha256(pick.bytes) }, plan_sha256: pick.plan_sha256, source_sha256: pick.source_sha256 });
  }
  if (adopted.length === 0) return { code: "freeze:none-confirmed", count: missing.length };
  const p = cond.params;
  const frozen = {
    schema: FROZEN_SET_SCHEMA, id, version, origin: "frozen-plan", rule: FREEZE_RULE,
    set: { path: cond.set.path, sha256: cond.set.sha256, id: cond.set.id, version: cond.set.version },
    source_measurement: {
      measurement_id: cond.measurement_id ?? null, signature: cond.signature ?? null, conditions_sha256: sha256(readFileSync(join(outRoot, "conditions.json"))),
      commit: cond.source.commit, factory_fingerprint: cond.factory?.fingerprint ?? null, model: p.model ?? null, effort: p.effort ?? null,
      factory_budget_usd: p.factory_budget_usd ?? null, factory_deadline_min: p.factory_deadline_min ?? null, answers_mode: p.answers_mode ?? null,
      scripts: { mode: cond.scripts?.mode ?? null, fingerprint: cond.scripts?.fingerprint ?? null },
    },
    adopted, missing,
  };
  return { frozen, envelopes };
}

function isEntry() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) {
  const args = process.argv.slice(2);
  const [repo, outRoot, dest] = args;
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (repo === undefined || outRoot === undefined || dest === undefined || dest.startsWith("--")) refuseWith("freeze:args");
  const versionText = opt("--version");
  const version = versionText !== undefined && /^\d+$/.test(versionText) ? Number(versionText) : NaN;
  let destUsed = false;
  try { destUsed = existsSync(dest) && readdirSync(dest).length > 0; } catch { destUsed = true; } // ディレクトリでない出力先も空でない扱い
  if (destUsed) refuseWith("freeze:out-not-empty");
  const r = await freezePlanSet({ repo: resolve(repo), outRoot: resolve(outRoot), id: opt("--id"), version });
  if (r.code !== undefined) refuseWith(r.code, { ids: r.ids ?? null, count: r.count ?? null });
  mkdirSync(join(dest, FROZEN_ENVELOPE_DIR), { recursive: true });
  for (const e of r.envelopes) writeFileSync(join(dest, e.rel), e.bytes);
  writeFileSync(join(dest, FROZEN_SET_FILE), JSON.stringify(r.frozen, null, 1) + "\n");
  console.log(`凍結しました: 採用 ${r.frozen.adopted.length} P、外した ${r.frozen.missing.length} P`);
}
