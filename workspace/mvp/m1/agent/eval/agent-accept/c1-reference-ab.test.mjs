import { test } from "node:test";
import assert from "node:assert/strict";
import { plannedJobs, runSchedule, summarize, parseArgs, runC1, loadNative } from "./c1-reference-ab.mjs";
import { fileURLToPath } from "node:url";
const jobs = plannedJobs(["P2", "P4", "P6"]); // synthetic identifiers; no subject branches.
const billing = { guard_spent_usd: .01, unsettled_reservations_usd: .02, budget_reached: false };
const row = { identity_valid: true, c1_pass: true, actual_cost_complete: false, cost_range_usd: { lower: .01, upper: .03 }, billing, bundles: [] };
test("six alternating jobs stop at C1; no duplicate patterns", () => {
  assert.deepEqual(jobs.map((j) => j.mode), ["off", "on", "off", "on", "off", "on"]);
  assert.throws(() => plannedJobs(["P2", "P2", "P4"]));
});
test("identity-valid timeout rows compare C1 while cost remains a range", async () => {
  const r = await runSchedule(jobs, async () => row);
  assert.equal(r.rows.length, 6); assert.equal(r.summary.valid_stage_pairs, 3);
  assert.equal(r.summary.actual_cost_complete, false);
  assert.ok(Math.abs(r.summary.cost_range_usd.upper - .18) < 1e-12);
});
test("mismatch or budget reached aborts immediately, leaves not-run jobs explicit", async () => {
  for (const changed of [{ identity_valid: false }, { billing: { ...billing, budget_reached: true } }]) {
    let calls = 0; const r = await runSchedule(jobs, async () => { calls++; return { ...row, ...changed }; });
    assert.equal(calls, 1); assert.equal(r.not_run.length, 5); assert.ok(r.abort);
  }
});
test("unknown-to-other failure transition and missing evidence are separate", () => {
  const bundles = [{ pass: false, bundle: "fields", reference_observation_complete: true, unknown_initial_occurrence: true,
    unknown_retry_occurrence: false, failure: { kind: "unmet" }, rejections: [{ attempt: 1, classes: { unknown: 1, other: 0 } }, { attempt: 2, classes: { unknown: 0, other: 1 } }] }];
  const rows = jobs.slice(0, 2).map((j) => ({ ...j, ...row, bundles }));
  const s = summarize(jobs, rows);
  assert.equal(s.valid_stage_pairs, 1); assert.equal(s.cost_range_usd.upper, null);
  assert.equal(s.pairs[0].on.unknown_initial_occurrences, 1);
  assert.equal(s.pairs[0].on.unknown_retry_occurrences, 0);
  assert.equal(s.pairs[0].on.failure_class_transitions[0].retry.other, 1);
  const incomplete = rows.map((r) => ({ ...r, bundles: r.bundles.map((b) => ({ ...b, reference_observation_complete: false })) }));
  const missing = summarize(jobs, incomplete);
  assert.equal(missing.valid_stage_pairs, 1); // stage evidence remains usable.
  assert.equal(missing.pairs[0].on.unknown_initial_occurrences, null);
  assert.equal(missing.pairs[0].on.unknown_retry_occurrences, null);
});
test("dry defaults safe; rejects conflicting mode, unknown flag, missing/hash args", () => {
  const args = ["--repo", "absent", "--out", "absent", "--build-from", "absent", "--source-pin", "absent", "--set", "absent", "--only", "P2,P4,P6",
    "--set-sha256", "a".repeat(64), "--frozen-sha256", "b".repeat(64)];
  assert.equal(parseArgs(args).execute, false);
  assert.throws(() => parseArgs([...args, "--execute", "--dry-run"]));
  assert.throws(() => parseArgs([...args, "--provider", "morph"]));
  assert.throws(() => parseArgs([]));
});
test("actual archive native C1 fake: unknown twice stops before behaviors and C2, preserves shape retry", async () => {
  const repo = fileURLToPath(new URL("../../../../../..", import.meta.url));
  const n = await loadNative(repo);
  const calls = [];
  const client = n.createOpenRouterLlmClient({ apiKey: "fake", arm: "open-inference/fp4", model: "synthetic/model", envelope: "v1.2",
    fetch: async (_url, init) => {
      assert.equal(init.method, "POST");
      const body = JSON.parse(String(init.body)); calls.push(body);
      const stage = body.text.format.schema.properties.result.properties.stage.enum[0];
      const output = stage === "vocabulary-entities" ? { entities: [{ name: "Records", role: "記録" }] }
        : { fields: [{ entity: "E999", name: "value", role: "値", fieldType: "string", options: null, refEntity: null }] };
      return new Response(JSON.stringify({ id: `gen-fake-${calls.length}`, model: "synthetic/model", status: "completed", usage: { input_tokens: 10, output_tokens: 10, cost: .001 },
        openrouter_metadata: { requested: "synthetic/model", endpoints: { available: [{ provider: "OpenInference", model: "synthetic/model", selected: true }] } },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ result: { stage, ...output } }) }] }] }));
    } });
  const plan = { requirements: [], decisions: [], accepted_unwritable: [], alternatives: [] };
  const result = await runC1({ native: n, plan, documents: [], mode: "on", client });
  assert.equal(result.c1_pass, false); assert.equal(calls.length, 3, JSON.stringify(result));
  assert.equal(result.identity_valid, true); assert.equal(result.actual_cost_complete, true);
  assert.equal(result.bundles[1].unknown_initial_occurrence, true);
  assert.equal(result.bundles[1].unknown_retry_occurrence, true);
  assert.equal(result.counts.retries.shape, 1);
  assert.equal(result.logical_calls, 3);
  assert.ok(calls.every((c) => c.text.format.strict === true));
});
