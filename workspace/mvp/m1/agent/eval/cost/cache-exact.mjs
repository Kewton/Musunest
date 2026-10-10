import fs from "node:fs";
const root = process.argv[2];
const D = ["contract/rules.md", "contract/expression-grammar.md", "docs/semantics.md"].map((p) => fs.readFileSync(root + "/packages/appspec-schema/" + p, "utf8")).join("\n");
const key = "cache-probe2-" + Date.now();
async function call(instructions, data, extra = {}) {
  const input = [{ role: "user", content: [{ type: "input_text", text: D }] }, { role: "user", content: [{ type: "input_text", text: "<data>" + data + "</data>" }] }];
  const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-luna", store: false, max_output_tokens: 64, reasoning: { effort: "low" }, instructions, prompt_cache_key: key, input, ...extra }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 400));
  return JSON.stringify(j.usage.input_tokens_details);
}
const A = "You are stage A. Reply OK.", B = "You are stage B with other rules. Reply OK.";





const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
console.log("1 same", await call(A, "same"));
await sleep(5000);
console.log("2 same exact", await call(A, "same"));
console.log("3 store:true", await call(A, "same", { store: true }));
await sleep(5000);
console.log("4 store:true again", await call(A, "same2", { store: true }));
console.log("5 no key", await call(A, "same", { prompt_cache_key: undefined }));
