// 決定①〜③の正例と負例（cases/cases.json）を v5 にかけ、期待どおりの判定かを確かめる（#277）。
// 使い方: node run-cases.mjs <spec-engine の dist/index.js>
// 期待（expect）は PASS / FAIL / STATIC_NG。`A|B` は「どちらでもよい」。log があれば申告と合わせた最終の判定で比べる。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDef, score } from "./engine.mjs";
import { finalVerdict, scoreClaims } from "./score-claims.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(process.argv[2]);
const cases = JSON.parse(readFileSync(join(here, "cases", "cases.json"), "utf8"));
let bad = 0;
for (const c of cases) {
  const def = loadDef(join(here, "subjects", `${c.subject}.json`));
  const spec = await score(engine, join(here, "cases", c.file), def);
  const claims = c.log && existsSync(join(here, "cases", c.log)) ? scoreClaims(JSON.parse(readFileSync(join(here, "cases", c.log), "utf8")), def, spec.structure, spec.written) : null;
  const got = finalVerdict(spec, claims);
  const ok = c.expect.split("|").includes(got);
  if (!ok) bad += 1;
  const failed = Object.entries(spec.checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${ok ? "OK " : "NG "}\t${c.file}\texpect=${c.expect}\tgot=${got}\t[${spec.structure ?? "-"}]\t${spec.verdict === "STATIC_NG" ? spec.codes.join(",") : failed.join("・")}${claims ? `\tclaims=${claims.verdict}(漏れ ${claims.missed})` : ""}`);
}
console.log(`cases ${cases.length}, mismatches ${bad}`);
process.exit(bad === 0 ? 0 : 1);
