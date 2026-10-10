// E2: 「書けない」の申告が、文書の該当箇所に裏付けられるかを確かめる（citation check の型）
import { ask } from "./jev.mjs";
import fs from "node:fs";
const { ex, cases } = JSON.parse(fs.readFileSync(new URL("./e2-cases.json", import.meta.url)));
const rev = process.argv[2] === "rev";
const opts = { supported: "The excerpt says this cannot be written, so the claim is correct.", contradicted: "The excerpt shows a way to write it, so the claim is wrong.", not_addressed: "The excerpt does not say either way." };
const criteria = Object.fromEntries((rev ? Object.keys(opts).reverse() : Object.keys(opts)).map((k) => [k, opts[k]]));
let ok = 0, tok = 0;
const res = await Promise.all(cases.map(async ([k, claim, truth]) => {
  const j = await ask({ excerpt: ex[k], claim }, { v: { type: "choice", instructions: "`excerpt` is from the specification of a declaration language. Does `excerpt` support `claim`, which says something cannot be written in the language?", criteria } });
  tok += j.usage.input_tokens; const a = j.answers.v;
  const good = truth ? a.choice === "supported" : a.choice === "contradicted";
  if (good) ok++;
  return `${good ? "ok " : "NG "} truth=${truth} got=${a.choice} conf=${a.confidence} | ${claim}`;
}));
console.log(res.join("\n")); console.log(JSON.stringify({ rev, ok: ok + "/" + cases.length, usd: (tok * 0.042e-6).toFixed(5) }));
