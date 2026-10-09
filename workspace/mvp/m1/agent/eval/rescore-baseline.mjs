// 基準線（#168 第 5 段の一発生成・50 本）を採点表 v5 で採点し直す（#277）。API は呼ばない。
// 使い方: node rescore-baseline.mjs <spec-engine の dist/index.js> <stage5 の runs ディレクトリ>
// 出力: baseline-v5.json・baseline-v5.md（このディレクトリ）
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDef, score } from "./engine.mjs";
import { finalVerdict, scoreClaims } from "./score-claims.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [enginePath, runsDir] = process.argv.slice(2);
const engine = await import(enginePath);
const SUBJECT = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };
const STYLE = { P1: "S1", P2: "S2", P3: "S1", P4: "S2", P5: "S1", P6: "S2", P7: "S1", P8: "S2", P9: "S1", P10: "S2" };
const PRICE = { input: 0.1, cache_write: 0.125, cached: 0.01, output: 0.5 };
const costOf = (u) => {
  const cached = u.input_tokens_details?.cached_tokens ?? 0, write = u.input_tokens_details?.cache_write_tokens ?? 0;
  return ((u.input_tokens - cached - write) * PRICE.input + write * PRICE.cache_write + cached * PRICE.cached + u.output_tokens * PRICE.output) / 1e6;
};
// 参考の集計だけに使う：決定③（最初に開く画面は採点しない）と、人の確認（stage5-review.md §3）で「語彙の穴」とされた申告。
// **v5 の定義（凍結の対象）には入れない。** 誤った申告の数を、これらを除いた場合と並べて出すためだけに使う
const NEUTRAL = [{ id: "最初に開く画面（決定③）", re: /最初|開いたら|開くと|初期|トップ|一番目|1 ?番目|先頭/ }, { id: "ボタンの表示名（語彙の穴）", re: /ボタン.*(表示名|名前|ラベル|文言)|(表示名|ラベル|文言).*ボタン|label/ }];

const rows = [];
for (const d of readdirSync(runsDir).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
  const p = d.split("-")[0], subject = SUBJECT[p];
  const dir = join(runsDir, d);
  if (!existsSync(join(dir, "log.json"))) { rows.push({ run: d, pattern: p, subject, style: STYLE[p], generation_failed: true }); continue; }
  const log = JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
  const final = existsSync(join(dir, "final.app.spec.yaml")) ? join(dir, "final.app.spec.yaml") : join(dir, `attempt-${log.attempts.length - 1}.app.spec.yaml`);
  const def = loadDef(join(here, "subjects", `${subject}.json`));
  const spec = await score(engine, final, def);
  const claims = scoreClaims(log, def, spec.structure, spec.written);
  const neutral = claims.false_claims.filter((c) => NEUTRAL.some((n) => n.re.test(c)));
  rows.push({
    run: d, pattern: p, subject, style: STYLE[p],
    final_static: log.attempts.at(-1).static_exit, first_shot_static: log.attempts[0].static_exit, repairs: log.attempts.length - 1,
    spec_verdict: spec.verdict, verdict: finalVerdict(spec, claims), structure: spec.structure,
    failed: Object.entries(spec.checks).filter(([, ok]) => !ok).map(([k]) => k), fulfilled: spec.fulfilled ?? 0, writable_total: spec.writable_total ?? 0,
    claims, false_claims_excluding_neutral: claims.false_claims.length - neutral.length, note: spec.note,
    cost_usd: log.attempts.reduce((s, a) => s + costOf(a.usage), 0), seconds: log.attempts.reduce((s, a) => s + a.ms, 0) / 1000,
  });
}

// 95% の区間（Wilson）
const wilson = (k, n) => {
  if (n === 0) return [0, 0];
  const z = 1.96, ph = k / n, d = 1 + (z * z) / n;
  const c = ph + (z * z) / (2 * n), m = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n}（${n ? pct(k / n) : "-"}・95% 区間 ${pct(lo)}〜${pct(hi)}）`; };

const ok = rows.filter((r) => !r.generation_failed);
const W = rows.filter((r) => ["A", "C", "E"].includes(r.subject)), P = rows.filter((r) => ["B", "D"].includes(r.subject));
const pass = (r) => !r.generation_failed && r.verdict === "PASS";
// 挙げ漏れの分母：書けない要件（optionalIfWritten で書けたものを除く）を 1 つ以上含む本
const withUnwritable = P.filter((r) => r.generation_failed || r.claims.missed + r.claims.correct > 0);
const missedRuns = withUnwritable.filter((r) => r.generation_failed || r.claims.missed > 0);
const fulK = P.reduce((s, r) => s + (r.fulfilled ?? 0), 0), fulN = P.reduce((s, r) => s + (r.writable_total || 0), 0);
const falseRuns = rows.filter((r) => r.generation_failed || r.claims.false_claims.length > 0);
const falseRunsNeutral = rows.filter((r) => r.generation_failed || r.false_claims_excluding_neutral > 0);
const metrics = {
  final_static: fmt(ok.filter((r) => r.final_static === 0).length, rows.length),
  spec_pass_writable: fmt(W.filter(pass).length, W.length),
  missed_partial: fmt(missedRuns.length, withUnwritable.length),
  fulfillment_partial: fmt(fulK, fulN),
  spec_pass_partial: fmt(P.filter(pass).length, P.length),
  false_claim_runs: fmt(falseRuns.length, rows.length),
  false_claim_runs_excluding_neutral: fmt(falseRunsNeutral.length, rows.length),
  invented_vocab: ok.filter((r) => r.final_static !== 0).length,
  within_time_cost: `${ok.filter((r) => r.seconds <= 300 && r.cost_usd <= 0.1).length}/${rows.length}`,
};
const bySubject = Object.fromEntries(["A", "B", "C", "D", "E"].map((s) => {
  const xs = rows.filter((r) => r.subject === s);
  return [s, { pass: fmt(xs.filter(pass).length, xs.length), S1: `${xs.filter((r) => r.style === "S1" && pass(r)).length}/5`, S2: `${xs.filter((r) => r.style === "S2" && pass(r)).length}/5` }];
}));
writeFileSync(join(here, "baseline-v5.json"), JSON.stringify({ rubric: "v5", metrics, bySubject, rows }, null, 2));
console.log(JSON.stringify({ metrics, bySubject }, null, 2));
