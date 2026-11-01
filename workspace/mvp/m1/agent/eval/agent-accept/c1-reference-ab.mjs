// Native C1 only. No planner, C2, judge, scoring, repair or final factory verdict.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkEnvelope, loadFrozenSet, loadPlanFileChecks } from "./freeze-plan-set.mjs";
export const AB_POLICY = "native-c1-reference-ab/v1";
export const CONDITIONAL_AB_POLICY = "native-c1-conditional-ab/v1";
export function experimentFlags(experiment, mode) {
  if (!["references", "conditional-fields"].includes(experiment) || !["off", "on"].includes(mode)) throw new Error("ab:experiment");
  return { c1ReferenceEnum: experiment === "conditional-fields" || mode === "on",
    c1ConditionalFields: experiment === "conditional-fields" && mode === "on" };
}
const sha = (v) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest("hex");
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
export function plannedJobs(patterns) {
  if (patterns.length !== 3 || new Set(patterns).size !== 3 || patterns.some((p) => !/^P[1-9][0-9]*$/.test(p))) throw new Error("ab:patterns");
  return patterns.flatMap((pattern) => ["off", "on"].map((mode) => ({ pattern, mode, id: `${pattern}-${mode}` })));
}
export async function loadNative(repo) {
  const load = (p) => import(pathToFileURL(join(repo, "packages/factory/dist", p)).href);
  const [vocabulary, call, budget, pipeline, ledger, limits, cli, router, comparison, ids, conditional] = await Promise.all([
    "v12/stages/vocabulary.js", "call.js", "budget.js", "pipeline.js", "v12/ledger.js", "v12/limits.js", "cli.js", "openrouter.js", "provider-comparison.js", "v12/ids.js", "v12/c1-conditional-fields.js",
  ].map(load));
  return { ...vocabulary, ...call, ...budget, ...pipeline, ...ledger, ...limits, ...cli, ...router, ...comparison, ...ids, ...conditional };
}
/** Dependency injection is fake-only; execution supplies the archive's native modules. */
export async function runC1({ native: n, plan, documents, mode, client, experiment = "references", now = Date.now, budgetUsd = .30, deadlineMs = 1200000, callTimeoutMs, onProgress = async () => {} }) {
  const flags = experimentFlags(experiment, mode);
  const budget = new n.JobBudget(budgetUsd), deadline = now() + deadlineMs;
  const gate = n.createCallGate({ now, deadline, limit: n.V12_CALL_LIMITS.realAttempts });
  const gateway = new n.CallGateway({ client, budget, rates: client.billingPin.rates, now, deadline, effort: "low", gate,
    recordMalformedKinds: true, ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }) });
  const list = n.requirementsFromPlan(plan), ledger = n.ledgerViewOf(n.fromPublicV12Flags(n.V12_PIPELINE_FLAGS));
  const bundles = []; let rows = [];
  for (const bundle of n.VOCABULARY_BUNDLES) {
    const rejections = [], candidates = [];
    const attemptsBefore = budget.providerBilling?.attempts.length ?? 0;
    const start = now();
    const result = await n.runVocabularyBundle({ bundle, plan, list, documents, gateway: gateway.forStage("vocabulary"), rows, ledger,
      ...(flags.c1ReferenceEnum ? { c1ReferenceEnum: true } : {}),
      ...(flags.c1ConditionalFields ? { c1ConditionalFields: true } : {}),
      ...(experiment === "conditional-fields" ? { onCandidate: (output, attempt) => {
        candidates.push({ attempt, problems: n.conditionalFieldProblems(bundle, output) });
      } } : {}),
      onRejected: (r) => rejections.push({ attempt: r.attempt, problems: r.problems }) });
    const classify = (problems) => {
      const counts = { unknown: 0, wrong_kind: 0, cross_bundle: 0, other: 0 };
      for (const p of problems) {
        if (p.message === n.ID_MESSAGES.unknown) counts.unknown++;
        else if (p.message === n.ID_MESSAGES.wrongKind) counts.wrong_kind++;
        else if (p.message === n.ID_MESSAGES.crossBundle) counts.cross_bundle++;
        else counts.other++;
      }
      return counts;
    };
    const conditionalObservations = candidates.map((c) => ({ ...c, counts: Object.fromEntries(
      ["options", "refEntity", "entity", "aggregate", "groupBy"].map((key) => [key, c.problems.filter((p) => p.category === key).length])) }));
    const rejectionsWithClass = rejections.map((r) => ({ ...r, classes: classify(r.problems) }));
    bundles.push({ bundle, pass: result.ok, duration_ms: now() - start, references: result.references,
      rejections: rejectionsWithClass, failure: result.ok ? null : result.failure,
      ...(experiment === "conditional-fields" ? { conditional_observations: conditionalObservations } : {}),
      unknown_initial_occurrence: rejectionsWithClass.some((r) => r.attempt === 1 && r.classes.unknown > 0),
      unknown_retry_occurrence: rejectionsWithClass.some((r) => r.attempt === 2 && r.classes.unknown > 0),
      reference_observation_complete: (budget.providerBilling?.attempts.slice(attemptsBefore) ?? []).every((a) => a.state === "returned" && a.receipt !== null)
        && (result.ok || result.failure.kind === "unmet") });
    await onProgress({ bundles, billing: budget.providerBilling, counts: gateway.counts });
    if (!result.ok) break;
    rows = result.rows;
  }
  let billing = budget.providerBilling;
  if (client.finalizeProviderBilling !== undefined && billing !== undefined) {
    const confirmed = await client.finalizeProviderBilling([billing], { deadline: Date.now() + 90000,
      onProgress: async (snapshots) => onProgress({ bundles, billing: snapshots[0], counts: gateway.counts }) });
    billing = confirmed[0];
  }
  billing = n.assessProviderComparison(billing);
  return { c1_pass: bundles.length === 3 && bundles.every((b) => b.pass), bundles, billing,
    identity_valid: billing.identity_valid === true, actual_cost_complete: billing.actual_cost_complete,
    cost_range_usd: billing.cost_range_usd, counts: gateway.counts, real_attempts: gate.attempts(),
    logical_calls: bundles.length + gateway.retryCounts.shape, judge_calls: 0, stop: "C1",
    ...(experiment === "conditional-fields" ? { experiment, c1_reference_enum: "on", c1_conditional_fields: mode } : {}) };
}
export async function runSchedule(jobs, run, persist = async () => {}, experiment = "references") {
  const rows = []; let held = 0, abort = null;
  for (const job of jobs) {
    if (held + .30 > 1.80 + 1e-12) { abort = "batch-budget"; break; }
    const row = { ...job, ...await run(job) };
    rows.push(row); await persist(row);
    held += row.billing.guard_spent_usd + row.billing.unsettled_reservations_usd;
    if (row.identity_valid !== true || row.billing.budget_reached === true || !Number.isFinite(held) || held < 0 || held > 1.80) {
      abort = "identity-or-budget"; break;
    }
  }
  return { policy: experiment === "conditional-fields" ? CONDITIONAL_AB_POLICY : AB_POLICY, planned: jobs, rows, not_run: jobs.slice(rows.length), abort, guard_held_usd: held,
    summary: summarize(jobs, rows) };
}
export function summarize(jobs, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const validPairs = [];
  for (let i = 0; i < jobs.length; i += 2) {
    const off = byId.get(jobs[i].id), on = byId.get(jobs[i + 1].id);
    if (off?.identity_valid === true && on?.identity_valid === true) validPairs.push([off, on]);
  }
  const conditionalCounts = (row, attempt) => row.bundles.some((b) => !b.reference_observation_complete) ? null
    : Object.fromEntries(["options", "refEntity", "entity", "aggregate", "groupBy"].map((key) => [key,
      row.bundles.reduce((sum, b) => sum + (b.conditional_observations ?? []).filter((c) => c.attempt === attempt).reduce((s, c) => s + c.counts[key], 0), 0)]));
  const metric = (row) => ({ c1_pass: row.c1_pass, bundle_passes: row.bundles.filter((b) => b.pass).map((b) => b.bundle),
    unknown_initial_occurrences: row.bundles.some((b) => !b.reference_observation_complete) ? null : row.bundles.filter((b) => b.unknown_initial_occurrence).length,
    unknown_retry_occurrences: row.bundles.some((b) => !b.reference_observation_complete) ? null : row.bundles.filter((b) => b.unknown_retry_occurrence).length,
    failure_class_transitions: row.bundles.map((b) => ({ bundle: b.bundle, initial: b.rejections.find((r) => r.attempt === 1)?.classes ?? null,
      retry: b.rejections.find((r) => r.attempt === 2)?.classes ?? null, terminal: b.failure?.kind ?? "pass" })),
    ...(row.experiment === "conditional-fields" ? {
      conditional_initial_counts: conditionalCounts(row, 1), conditional_retry_counts: conditionalCounts(row, 2),
      conditional_transitions: row.bundles.map((b) => ({ bundle: b.bundle, observations: b.conditional_observations, terminal: b.failure?.kind ?? "pass" })) } : {}),
    actual_cost_complete: row.actual_cost_complete, cost_range_usd: row.cost_range_usd });
  const upperComplete = rows.length === jobs.length && rows.every((r) => Number.isFinite(r.cost_range_usd?.upper));
  return { planned: jobs.length, executed: rows.length, valid_stage_pairs: validPairs.length,
    excluded_or_missing_pairs: jobs.length / 2 - validPairs.length,
    pairs: validPairs.map(([off, on]) => ({ pattern: off.pattern, off: metric(off), on: metric(on) })),
    actual_cost_complete: rows.length === jobs.length && rows.every((r) => r.actual_cost_complete),
    cost_range_usd: { lower: rows.reduce((s, r) => s + (r.cost_range_usd?.lower ?? 0), 0),
      upper: upperComplete ? rows.reduce((s, r) => s + r.cost_range_usd.upper, 0) : null },
    interpretation: "C1 only; one pair per plan; no inference of model limit or final factory success" };
}
export function parseArgs(args) {
  const flags = new Set(["--dry-run", "--execute"]);
  const keys = new Set(["--repo", "--out", "--build-from", "--frozen-sha256", "--set", "--set-sha256", "--only", "--source-pin", "--experiment"]);
  const opts = {}; let execute = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) { if (opts[flag]) throw new Error("ab:duplicate"); opts[flag] = true; execute ||= flag === "--execute"; }
    else if (keys.has(flag) && args[i + 1] && !args[i + 1].startsWith("--") && opts[flag] === undefined) opts[flag] = args[++i];
    else throw new Error("ab:arguments");
  }
  if (execute && opts["--dry-run"]) throw new Error("ab:mode-conflict");
  for (const key of keys) if (key !== "--experiment" && !opts[key]) throw new Error("ab:missing-argument");
  for (const key of ["--frozen-sha256", "--set-sha256"]) if (!/^[a-f0-9]{64}$/.test(opts[key])) throw new Error("ab:hash");
  const experiment = opts["--experiment"] ?? "references";
  experimentFlags(experiment, "off");
  return { opts, execute, experiment, jobs: plannedJobs(opts["--only"].split(",")) };
}
export async function main(args) {
  const { opts: o, execute, jobs, experiment } = parseArgs(args);
  const preview = { policy: experiment === "conditional-fields" ? CONDITIONAL_AB_POLICY : AB_POLICY, execute, jobs,
    ...(experiment === "conditional-fields" ? { experiment, c1_reference_enum: "on", c1_conditional_fields: "off/on", schema_form: "union" } : {}), stop: "C1", provider: "openrouter", arm: "open-inference/fp4",
    model: "z-ai/glm-5.3-flash", effort: "low", budget_usd: 1.80, per_run_budget_usd: .30, deadline_ms: 1200000,
    call_limits: { logical_calls: 80, real_attempts: 144, judge_branch: 80 }, schema_only_difference: true };
  if (!execute) { console.log(JSON.stringify(preview, null, 2)); return; } // no data, env or output read in dry-run.
  const repo = resolve(o["--repo"]), out = resolve(o["--out"]);
  const pin = JSON.parse(readFileSync(o["--source-pin"], "utf8"));
  if (resolve(pin.archive) !== repo || pin.exit_code !== 0 || !pin.source_hashes_match) throw new Error("ab:archive-pin");
  for (const [p, hash] of Object.entries(pin.source_hashes ?? {})) if (sha(readFileSync(join(repo, p))) !== hash) throw new Error("ab:source-pin");
  if (Object.keys(pin.source_hashes ?? {}).length === 0 || Object.keys(pin.factory_dist_sha256 ?? {}).length === 0) throw new Error("ab:missing-source-pin");
  for (const [p, hash] of Object.entries(pin.factory_dist_sha256)) if (sha(readFileSync(join(repo, "packages/factory/dist", p))) !== hash) throw new Error("ab:dist-pin");
  if (sha(readFileSync(o["--build-from"])) !== o["--frozen-sha256"] || sha(readFileSync(o["--set"])) !== o["--set-sha256"]) throw new Error("ab:input-pin");
  const set = JSON.parse(readFileSync(o["--set"], "utf8"));
  if (set.role !== "development" || !Array.isArray(set.items)) throw new Error("ab:development-only");
  const frozen = loadFrozenSet(resolve(o["--build-from"]));
  if (frozen.status !== "ok" || frozen.set.set.sha256 !== o["--set-sha256"]) throw new Error("ab:frozen");
  const checks = await loadPlanFileChecks(join(repo, "packages/factory/dist"));
  const plans = new Map(), inputs = [];
  for (const pattern of new Set(jobs.map((j) => j.pattern))) {
    const item = set.items.filter((i) => i.id === pattern);
    const entry = frozen.set.adopted.find((a) => a.pattern === pattern);
    if (item.length !== 1 || !Array.isArray(item[0].request) || !item[0].request.every((v) => typeof v === "string") || !entry) throw new Error("ab:missing-plan");
    const path = frozen.envelopeOf.get(pattern);
    if (!path.startsWith(frozen.dir + "/")) throw new Error("ab:envelope-path");
    const bytes = readFileSync(path), source = item[0].request.join("\n") + "\n";
    const checked = await checkEnvelope(checks, bytes, source);
    if (sha(bytes) !== entry.envelope.sha256 || !checked.ok || checked.planSha256 !== entry.plan_sha256 || checked.sourceSha256 !== entry.source_sha256) throw new Error("ab:envelope-pin");
    plans.set(pattern, checked.envelope.plan);
    inputs.push({ pattern, envelope_sha256: sha(bytes), source_sha256: checked.sourceSha256, plan_sha256: checked.planSha256 });
  }
  if (existsSync(out)) throw new Error("ab:new-output-required");
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("ab:missing-key");
  const n = await loadNative(repo), documents = await n.loadDocumentsFromFiles();
  mkdirSync(out, { recursive: false });
  json(join(out, "conditions.json"), { ...preview, archive: repo, commit: pin.commit, tree: pin.tree, inputs,
    frozen_sha256: frozen.sha256, set_sha256: o["--set-sha256"], document_hashes: documents.map((d) => ({ name: d.name, sha256: sha(d.text) })),
    billing_pin: n.openRouterArmPin("open-inference/fp4", preview.model), enum_policy: "c1-kind-reference-enum/v1", identity_policy: n.IDENTITY_COMPARISON_POLICY,
    ...(experiment === "conditional-fields" ? { conditional_policy: n.C1_CONDITIONAL_FIELDS_POLICY,
      schema_support: "official-format+offline-fake; OI-keyword-enforcement-unprobed" } : {}) });
  const result = await runSchedule(jobs, async (job) => {
    const requestHashes = [];
    const client = n.createOpenRouterLlmClient({ apiKey: key, arm: preview.arm, model: preview.model, effort: preview.effort, envelope: "v1.2",
      fetch: async (url, init) => {
        if (init.method === "POST") {
          const body = JSON.parse(String(init.body));
          requestHashes.push({ body_sha256: sha(String(init.body)), input_sha256: sha(body.input), instructions_sha256: sha(body.instructions),
            schema_sha256: sha(body.text.format.schema), stage: body.text.format.schema.properties.result.properties.stage.enum[0] });
        }
        return globalThis.fetch(url, init);
      } });
    const row = await runC1({ native: n, plan: plans.get(job.pattern), documents, mode: job.mode, client, experiment,
      onProgress: async (value) => { writeFileSync(join(out, `${job.id}.pending.json`), JSON.stringify(value, null, 2) + "\n"); } });
    return { ...row, request_hashes: requestHashes, plan_pin: inputs.find((i) => i.pattern === job.pattern) };
  }, async (row) => json(join(out, `${row.id}.json`), row), experiment);
  json(join(out, "ab-summary.json"), { ...result, commit: pin.commit });
  console.log(JSON.stringify({ executed: result.rows.length, abort: result.abort, summary: result.summary }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error("ab:refused-or-interrupted; retain reservations and inspect evidence"); process.exitCode = 3; });
}
