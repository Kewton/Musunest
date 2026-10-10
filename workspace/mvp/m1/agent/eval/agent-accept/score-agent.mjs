// 受入の試験の採点：run-agent.mjs の出力を採点表 v5（凍結）で採点し、基準線と同じ指標を出す。API は呼ばない。
// 使い方: node score-agent.mjs <repo> <out> [--label high]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [repo, outRoot] = process.argv.slice(2);
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";
const ev = join(repo, "workspace/mvp/m1/agent/eval");
const { loadDef, score } = await import(join(ev, "engine.mjs"));
const { finalVerdict, scoreClaims } = await import(join(ev, "score-claims.mjs"));
const engine = await import(join(repo, "packages/spec-engine/dist/index.js"));
const SUBJECT = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };
const STYLE = { P1: "S1", P2: "S2", P3: "S1", P4: "S2", P5: "S1", P6: "S2", P7: "S1", P8: "S2", P9: "S1", P10: "S2" };
const rows = [];
for (const d of readdirSync(outRoot).filter((x) => /^P\d+-r\d+$/.test(x)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
  const p = d.split("-")[0], subject = SUBJECT[p], dir = join(outRoot, d);
  const sl = existsSync(join(dir, "summary.line.json")) ? JSON.parse(readFileSync(join(dir, "summary.line.json"), "utf8")) : null;
  const s = sl?.summary ?? null;
  const spec = join(dir, "bundle/artifacts/app.spec.yaml");
  const base = { run: d, pattern: p, subject, style: STYLE[p], factory_verdict: s?.verdict ?? null, stop: s?.stop_reason ?? s?.stop_class ?? null, failure: s?.failure ?? null, cost_usd: s?.provider_cost_usd ?? 0, seconds: s?.duration_secs ?? sl?.wall_s ?? 0 };
  if (!existsSync(spec)) { rows.push({ ...base, generation_failed: true }); continue; }
  const def = loadDef(join(ev, "subjects", `${subject}.json`));
  const r = await score(engine, spec, def);
  const uw = existsSync(join(dir, "bundle/artifacts/unwritable.json")) ? JSON.parse(readFileSync(join(dir, "bundle/artifacts/unwritable.json"), "utf8")).unwritable ?? [] : [];
  const claimsList = uw.flatMap((u) => (u.unwritable ?? []).map((part) => ({ requirement: `${u.text}（${u.quote}）`, reason: part })));
  const claims = scoreClaims({ attempts: [{ unwritable: claimsList }] }, def, r.structure, r.written);
  rows.push({ ...base, spec_verdict: r.verdict, verdict: finalVerdict(r, claims), failed: Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k), fulfilled: r.fulfilled ?? 0, writable_total: r.writable_total ?? 0, claims, final_static: r.verdict === "STATIC_NG" ? 1 : 0 });
}
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n}（${n ? pct(k / n) : "-"}・95% 区間 ${pct(lo)}〜${pct(hi)}）`; };
const pass = (r) => !r.generation_failed && r.verdict === "PASS";
const W = rows.filter((r) => ["A", "C", "E"].includes(r.subject)), P = rows.filter((r) => ["B", "D"].includes(r.subject));
const withUnwritable = P.filter((r) => r.generation_failed || r.claims.missed + r.claims.correct > 0);
const metrics = {
  generated: fmt(rows.filter((r) => !r.generation_failed).length, rows.length),
  final_static: fmt(rows.filter((r) => !r.generation_failed && r.final_static === 0).length, rows.length),
  spec_pass_writable: fmt(W.filter(pass).length, W.length),
  missed_partial: fmt(withUnwritable.filter((r) => r.generation_failed || r.claims.missed > 0).length, withUnwritable.length),
  fulfillment_partial: fmt(P.reduce((s, r) => s + (r.fulfilled ?? 0), 0), P.reduce((s, r) => s + (r.writable_total || 0), 0)),
  spec_pass_partial: fmt(P.filter(pass).length, P.length),
  false_claim_runs: fmt(rows.filter((r) => r.generation_failed || r.claims.false_claims.length > 0).length, rows.length),
  within_time_cost: `${rows.filter((r) => !r.generation_failed && r.seconds <= 600 && r.cost_usd <= 0.3).length}/${rows.length}`,
  cost_total_usd: rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(4),
  factory_verdicts: rows.reduce((m, r) => ((m[r.factory_verdict ?? "none"] = (m[r.factory_verdict ?? "none"] ?? 0) + 1), m), {}),
};
const bySubject = Object.fromEntries(["A", "B", "C", "D", "E"].map((s) => { const xs = rows.filter((r) => r.subject === s); return [s, { pass: fmt(xs.filter(pass).length, xs.length), S1: `${xs.filter((r) => r.style === "S1" && pass(r)).length}/${xs.filter((r) => r.style === "S1").length}`, S2: `${xs.filter((r) => r.style === "S2" && pass(r)).length}/${xs.filter((r) => r.style === "S2").length}` }]; }));
writeFileSync(join(outRoot, `score${label ? "-" + label : ""}.json`), JSON.stringify({ rubric: "v5", metrics, bySubject, rows }, null, 1));
console.log(JSON.stringify({ metrics, bySubject }, null, 1));
for (const r of rows) console.log([r.run, r.factory_verdict, r.verdict ?? "GEN_FAIL", (r.failed ?? []).join("・"), r.claims ? `claims ok=${r.claims.correct} miss=${r.claims.missed} false=${r.claims.false_claims.length}` : "", r.cost_usd?.toFixed(3), Math.round(r.seconds)].join("\t"));
