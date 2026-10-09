// 採点表 v5 の入口（#277）。エンジンは engine.mjs、題材の定義は subjects/<id>.json。
// 使い方: node rubric-v5.mjs <spec-engine の dist/index.js> <題材の id（A..E）か定義の JSON のパス> <app.spec.yaml>... [--json]
// 出力（1 ファイル 1 行・タブ区切り）: <ファイル>\t<判定>\t<構造>\t<要件ごとの合否>\t<note>
//   判定: PASS / PASS_NEEDS_CLAIM（別の構造。申告が正しければ合格。score-claims.mjs と合わせて決める）/ FAIL / STATIC_NG
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDef, score } from "./engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const defPath = (subject) => (existsSync(subject) ? subject : join(here, "subjects", `${subject}.json`));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const [enginePath, subject, ...files] = args.filter((a) => a !== "--json");
  const engine = await import(enginePath);
  const def = loadDef(defPath(subject));
  for (const file of files) {
    const r = await score(engine, file, def);
    if (asJson) { console.log(JSON.stringify(r)); continue; }
    const detail = r.verdict === "STATIC_NG" ? r.codes.join(",") : Object.entries(r.checks).map(([k, ok]) => `${ok ? "○" : "×"}${k}`).join(" ");
    console.log(`${r.file}\t${r.verdict}\t${r.structure ?? "-"}\t${detail}\t${r.note}`);
  }
}
