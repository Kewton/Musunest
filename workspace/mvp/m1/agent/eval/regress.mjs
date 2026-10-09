// v4 と v5 の判定を並べる回帰（#277）。stage1-specs・stage2・stage5/mutants・stage4/runs・stage5/runs の宣言を両方で採点し、
// 食い違いを出す。食い違いのうち、2026-10-09 の決定（①show の省略・②別の構造）で説明できるものは「決定による」に分ける。
// 使い方: node regress.mjs <spec-engine の dist/index.js> [--md]
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDef, score } from "./engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [enginePath] = process.argv.slice(2);
const engine = await import(enginePath);
const SUBJECT = { P1: "A", P2: "A", P3: "B", P4: "B", P5: "C", P6: "C", P7: "D", P8: "D", P9: "E", P10: "E" };

const items = [];
const add = (set, file, subject) => items.push({ set, file, subject });
for (const f of readdirSync(join(root, "stage1-specs"))) add("stage1", join(root, "stage1-specs", f), f[0]);
for (const f of readdirSync(join(root, "stage2")).filter((x) => x.endsWith(".yaml"))) add("stage2", join(root, "stage2", f), f[0]);
for (const f of readdirSync(join(root, "stage5", "mutants"))) add("mutants", join(root, "stage5", "mutants", f), f[0]);
for (const [dir, set] of [[join(root, "stage4", "runs"), "stage4"], [join(root, "stage5", "runs"), "stage5"]]) {
  for (const d of readdirSync(dir)) {
    const p = d.split("-")[0];
    const final = join(dir, d, "final.app.spec.yaml");
    if (existsSync(final)) add(set, final, SUBJECT[p]);
  }
}
export { items };

// v4 は CLI で呼ぶ（モジュールの最上位で引数を読むため）
import { execFileSync } from "node:child_process";
const v4Of = (it) => JSON.parse(execFileSync("node", [join(root, "stage5", "rubric-v4.mjs"), enginePath, it.subject, it.file, "--json"], { encoding: "utf8" }).trim());

const rows = [];
for (const it of items) {
  const a = v4Of(it);
  const b = await score(engine, it.file, loadDef(join(here, "subjects", `${it.subject}.json`)));
  const label = it.set === "stage4" || it.set === "stage5" ? it.file.split("/").slice(-2, -1)[0] : it.file.split("/").pop().replace(".app.spec.yaml", "");
  const failedA = Object.entries(a.checks).filter(([, ok]) => !ok).map(([k]) => k);
  const failedB = Object.entries(b.checks).filter(([, ok]) => !ok).map(([k]) => k);
  rows.push({ set: it.set, label, subject: it.subject, v4: a.verdict, v5: b.verdict, structure: b.structure, failedA, failedB, same: a.verdict === b.verdict || (a.verdict === "PASS" && b.verdict === "PASS") });
}
const diff = rows.filter((r) => r.v4 !== r.v5);
console.log(`items ${rows.length}, v4≠v5 ${diff.length}`);
for (const r of diff) console.log(`${r.set}\t${r.label}\tv4=${r.v4}(${r.failedA.join("・")})\tv5=${r.v5}[${r.structure}](${r.failedB.join("・")})`);
if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
