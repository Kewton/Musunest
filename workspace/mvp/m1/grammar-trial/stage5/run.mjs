// #168 第 5 段（本番）：stage4/run.mjs と同じ凍結条件（モデル・effort・依頼文・資料・出力の形・直しの回数）。違うのは出力先（stage5/runs/）だけ。
// 使い方: node run.mjs <repo> <pattern-id> <run-no>
// 1 回の試行 = 新しい会話（API はステートレス）。静的チェックの診断を返して最大 MAX_REPAIRS 回まで直させる。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const [, , repo, pid, runNo] = process.argv;
const MODEL = "gpt-6-luna";
const EFFORT = "medium";
const MAX_REPAIRS = 3;
const here = new URL(".", import.meta.url).pathname;
const out = join(here, "runs", `${pid}-r${runNo}`);
mkdirSync(out, { recursive: true });

const docs = [
  "packages/appspec-schema/contract/app-spec.schema.json",
  "packages/appspec-schema/contract/rules.md",
  "packages/appspec-schema/contract/expression-grammar.md",
  "packages/appspec-schema/docs/semantics.md",
  "packages/appspec-schema/vocabulary.yaml",
].map((p) => `<file path="${p}">\n${readFileSync(join(repo, p), "utf8")}\n</file>`).join("\n\n");

const table = readFileSync(join(here, "..", "stage1-patterns.md"), "utf8");
const m = table.match(new RegExp(`\\*\\*${pid}（[^）]*）\\*\\*\\n\\n((?:> .*\\n?)+)`));
if (!m) throw new Error(`requirement ${pid} not found`);
const requirement = m[1].replace(/^> ?/gm, "").trim();

const instructions = `あなたは MUSUNEST のアプリの宣言（app.spec.yaml）を書く担当です。
- 渡した文書（契約の正本・語彙の意味・語彙の台帳）だけを根拠に、要件のアプリの宣言を 1 つ書いてください。
- 文書に無い語彙・キー・関数を作らないでください。
- 要件のうち、文書の語彙では書けないものは、宣言から落とし、unwritable に要件の文と理由を書いてください。書けないものを近い別の意味で書き換えないでください。
- 選択肢（enum）の表示名は、要件の言葉をそのまま使ってください。
- 識別子（entity・項目・計算・一覧の名前）は自由に決めてかまいません。
- spec_yaml には YAML の本文だけを入れてください（コードフェンスを付けない）。`;

const schema = {
  type: "object", additionalProperties: false, required: ["spec_yaml", "unwritable", "notes"],
  properties: {
    spec_yaml: { type: "string" },
    unwritable: { type: "array", items: { type: "object", additionalProperties: false, required: ["requirement", "reason"], properties: { requirement: { type: "string" }, reason: { type: "string" } } } },
    notes: { type: "string" },
  },
};

async function call(input, previous) {
  const body = { model: MODEL, reasoning: { effort: EFFORT }, instructions, input, text: { format: { type: "json_schema", name: "app_spec_answer", schema, strict: true } } };
  if (previous) body.previous_response_id = previous;
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j.error)}`);
  const text = j.output.filter((o) => o.type === "message").flatMap((o) => o.content).filter((c) => c.type === "output_text").map((c) => c.text).join("");
  return { id: j.id, answer: JSON.parse(text), usage: j.usage, ms: Date.now() - t0 };
}

function check(file) {
  try {
    execFileSync("pnpm", ["-s", "--filter", "@musunest/spec-engine", "spec:check", "--", file], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    return { exit: 0, diag: "" };
  } catch (e) { return { exit: e.status, diag: `${e.stdout}${e.stderr}`.trim() }; }
}

const log = { pattern: pid, run: Number(runNo), model: MODEL, effort: EFFORT, max_repairs: MAX_REPAIRS, attempts: [] };
let prev, input = `## 要件\n\n${requirement}\n\n## 文書\n\n${docs}`;
for (let i = 0; i <= MAX_REPAIRS; i++) {
  const r = await call(input, prev);
  const file = join(out, `attempt-${i}.app.spec.yaml`);
  writeFileSync(file, r.answer.spec_yaml.endsWith("\n") ? r.answer.spec_yaml : r.answer.spec_yaml + "\n");
  const c = check(file);
  log.attempts.push({ attempt: i, response_id: r.id, ms: r.ms, usage: r.usage, unwritable: r.answer.unwritable, notes: r.answer.notes, static_exit: c.exit, diag: c.diag.replaceAll(out, ".") });
  console.log(`${pid} r${runNo} attempt ${i}: static=${c.exit} ${Math.round(r.ms / 1000)}s in=${r.usage.input_tokens} cached=${r.usage.input_tokens_details?.cached_tokens} out=${r.usage.output_tokens} reasoning=${r.usage.output_tokens_details?.reasoning_tokens}`);
  if (c.exit === 0) { writeFileSync(join(out, "final.app.spec.yaml"), readFileSync(file)); break; }
  prev = r.id;
  input = `静的チェックが次の誤りを返しました。直した宣言を返してください。\n\n${c.diag.replaceAll(out, ".")}`;
}
writeFileSync(join(out, "log.json"), JSON.stringify(log, null, 2));
