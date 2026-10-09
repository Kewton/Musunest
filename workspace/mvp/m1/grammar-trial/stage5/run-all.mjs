// #168 第 5 段：P1〜P10 × 5 回を流し、rubric v4 と申告の採点をまとめる。
// 使い方: OPENAI_API_KEY=... node run-all.mjs <repo> [--dry-run] [--budget-usd 1] [--runs 5] [--only P1,P3]
//   --dry-run   API を呼ばず、要件の取り出しと、既にある runs/ の採点だけを行う
//   --budget-usd 累計の費用（usage から計算）がこれを超えたら、次の試行を始めずに止める（停止条件 1）
//   API の誤りが 3 回続いたら止める（停止条件 2）
//   最初の 10 試行で、最後の静的チェックを通ったものが 5 本未満なら止める（停止条件 3。条件か資料が壊れている合図）
//   止まっても、それまでの結果は summary に残す
// 出力: runs/<P>-r<n>/（run.mjs が書く）・summary.json・summary.md
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { scoreClaims } from "./score-claims.mjs";

const args = process.argv.slice(2);
const repo = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dry = args.includes("--dry-run");
const budget = Number(opt("--budget-usd", "1"));
const RUNS = Number(opt("--runs", "5"));
const only = opt("--only", null)?.split(",");
const here = new URL(".", import.meta.url).pathname;
const engine = join(repo, "packages/spec-engine/dist/index.js");
const SUBJECT = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };
const STYLE = { P1: "S1", P2: "S2", P3: "S1", P4: "S2", P5: "S1", P6: "S2", P7: "S1", P8: "S2", P9: "S1", P10: "S2" };
// 単価（2026-10-09 時点の公開値。100 万トークンあたりの USD）
const PRICE = { input: 0.1, cache_write: 0.125, cached: 0.01, output: 0.5 };
const costOf = (u) => {
  const cached = u.input_tokens_details?.cached_tokens ?? 0, write = u.input_tokens_details?.cache_write_tokens ?? 0;
  return ((u.input_tokens - cached - write) * PRICE.input + write * PRICE.cache_write + cached * PRICE.cached + u.output_tokens * PRICE.output) / 1e6;
};

const rows = [];
let spent = 0, apiErrors = 0, stopped = null;
outer: for (const p of Object.keys(SUBJECT)) {
  if (only && !only.includes(p)) continue;
  for (let r = 1; r <= RUNS; r++) {
    const dir = join(here, "runs", `${p}-r${r}`);
    if (!dry && !existsSync(join(dir, "log.json"))) {
      if (spent >= budget) { stopped = `予算 ${budget} USD に達した（${spent.toFixed(4)} USD）`; break outer; }
      const res = spawnSync("node", [join(here, "run.mjs"), repo, p, String(r)], { encoding: "utf8", env: process.env });
      process.stdout.write(res.stdout);
      if (res.status !== 0) {
        apiErrors += 1;
        process.stderr.write(res.stderr.split("\n").slice(-4).join("\n"));
        if (apiErrors >= 3) { stopped = "API の誤りが 3 回続いた"; break outer; }
        continue;
      }
      apiErrors = 0;
    }
    if (!existsSync(join(dir, "log.json"))) continue;
    const log = JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
    const cost = log.attempts.reduce((s, a) => s + costOf(a.usage), 0);
    spent += dry ? 0 : cost;
    const final = existsSync(join(dir, "final.app.spec.yaml")) ? join(dir, "final.app.spec.yaml") : join(dir, `attempt-${log.attempts.length - 1}.app.spec.yaml`);
    const spec = JSON.parse(execFileSync("node", [join(here, "rubric-v4.mjs"), engine, SUBJECT[p], final, "--json"], { encoding: "utf8" }).trim());
    const claims = scoreClaims(log, SUBJECT[p], !!spec.written?.["少ない順"]);
    rows.push({
      pattern: p, subject: SUBJECT[p], style: STYLE[p], run: r,
      first_shot_static: log.attempts[0].static_exit, repairs: log.attempts.length - 1, final_static: log.attempts.at(-1).static_exit,
      spec_verdict: spec.verdict, failed: Object.entries(spec.checks).filter(([, ok]) => !ok).map(([k]) => k), note: spec.note,
      claims, cost_usd: Number(cost.toFixed(5)), seconds: Math.round(log.attempts.reduce((s, a) => s + a.ms, 0) / 1000),
    });
    if (!dry && rows.length === 10 && rows.filter((x) => x.final_static === 0).length < 5) { stopped = "最初の 10 試行で静的チェックの通過が 5 本未満"; break outer; }
  }
}

// 集計：要件充足率は「書ける 6 本（A・C・E）」と「一部書けない 4 本（B・D）」を分けて出す（第 1 段の決定 2）
const group = (f) => rows.filter(f);
const rate = (xs, f) => (xs.length ? `${xs.filter(f).length}/${xs.length}` : "-");
const writable = group((x) => ["A", "C", "E"].includes(x.subject)), partial = group((x) => ["B", "D"].includes(x.subject));
const summary = {
  frozen: { model: "gpt-6-luna", effort: "medium", max_repairs: 3, runs_per_pattern: RUNS, rubric: "v4", claims: "score-claims.mjs" },
  stopped, spent_usd: Number(spent.toFixed(4)),
  totals: {
    first_shot_static_pass: rate(rows, (x) => x.first_shot_static === 0),
    final_static_pass: rate(rows, (x) => x.final_static === 0),
    spec_pass_writable: rate(writable, (x) => x.spec_verdict === "PASS"),
    spec_pass_partial: rate(partial, (x) => x.spec_verdict === "PASS"),
    claims_ok: rate(rows, (x) => x.claims.verdict === "OK"),
    claims_missed: rows.reduce((s, x) => s + x.claims.missed, 0),
    false_claims: rows.reduce((s, x) => s + x.claims.false_claims.length, 0),
    invented_vocab: rows.filter((x) => x.final_static !== 0).length,
  },
  rows,
};
writeFileSync(join(here, "summary.json"), JSON.stringify(summary, null, 2));
const md = [
  `# 第 5 段の結果（${dry ? "dry-run" : "本番"}）`, "",
  `- 停止：${stopped ?? "なし"}／費用：${summary.spent_usd} USD`,
  ...Object.entries(summary.totals).map(([k, v]) => `- ${k}: ${v}`), "",
  "| P | 題材 | 書きっぷり | 回 | 一発 | 直し | 宣言 | 落ちた要件 | 申告 | 誤った申告 | 費用 USD | 秒 |", "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((x) => `| ${x.pattern} | ${x.subject} | ${x.style} | ${x.run} | ${x.first_shot_static === 0 ? "○" : "×"} | ${x.repairs} | ${x.spec_verdict} | ${x.failed.join("・")} | ${x.claims.verdict}（正 ${x.claims.correct}・漏れ ${x.claims.missed}） | ${x.claims.false_claims.length} | ${x.cost_usd} | ${x.seconds} |`),
].join("\n");
writeFileSync(join(here, "summary.md"), md + "\n");
console.log(md);
