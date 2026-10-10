// 明示の breakpoint を文書の直後に置き、段ごとの指示とデータを後ろに置くと、別の段でも文書が当たるか
import fs from "node:fs";
const root = process.argv[2];
const D = ["contract/rules.md", "contract/expression-grammar.md", "docs/semantics.md"].map((p) => fs.readFileSync(root + "/packages/appspec-schema/" + p, "utf8")).join("\n");
async function call(stageInstr, data) {
  const input = [
    { role: "developer", content: [{ type: "input_text", text: "Common rules for every stage. Documents follow." }] },
    { role: "user", content: [{ type: "input_text", text: D, prompt_cache_breakpoint: { mode: "explicit" } }] },
    { role: "developer", content: [{ type: "input_text", text: stageInstr }] },
    { role: "user", content: [{ type: "input_text", text: "<data>" + data + "</data>" }] },
  ];
  const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-luna", store: false, max_output_tokens: 64, reasoning: { effort: "low" }, prompt_cache_options: { mode: "explicit" }, input,
      text: { format: { type: "json_schema", name: "o", strict: true, schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "string" } } } } } }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400));
  return JSON.stringify(j.usage.input_tokens_details) + " in=" + j.usage.input_tokens;
}
console.log("1 stage A", await call("Stage A: reply ok.", "one"));
await new Promise((s) => setTimeout(s, 4000));
console.log("2 stage B", await call("Stage B: different rules, reply ok.", "two"));
console.log("3 stage C", await call("Stage C.", "three"));
