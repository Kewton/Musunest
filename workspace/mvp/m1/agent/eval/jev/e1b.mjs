// E1b: 原子の問い（Noul 2 つ）に分けて、コードで組み合わせる
import { ask } from "./jev.mjs";
import fs from "node:fs";
const rows = JSON.parse(fs.readFileSync(new URL("./unwritable-rows.json", import.meta.url)));
const labels = JSON.parse(fs.readFileSync(new URL("./labels.json", import.meta.url)));
const lang = process.argv[2] || "en";
const Q = lang === "ja" ? {
  open: { type: "noul", instructions: "`note` は、`requirement` の中で決まっていないこと（2 つ以上の解釈のどれにするか・対象の期間・数える記録・整数か小数か など）を挙げているか？", criteria: { true: "未決の選択を挙げている", false: "未決の選択を挙げていない" } },
  gap: { type: "noul", instructions: "`note` は、宣言の言語（契約・語彙）にそれを表す手段が無い、と主張しているか？", criteria: { true: "表す欄・演算・設定が無いと主張している", false: "そうは主張していない" } },
} : {
  open: { type: "noul", instructions: "Does `note` point out something that `requirement` leaves undecided (which of two or more interpretations, which period, which records to count, integer or decimal, and so on)?", criteria: { true: "It names an undecided choice", false: "It does not name an undecided choice" } },
  gap: { type: "noul", instructions: "Does `note` claim that the declaration language (contract, vocabulary) has no way to express it?", criteria: { true: "It claims a missing field, operator or setting", false: "It makes no such claim" } },
};
let tok = 0; const out = [];
await Promise.all(rows.map(async (r, i) => {
  const j = await ask({ requirement: r.text, note: r.claim }, Q);
  tok += j.usage.input_tokens;
  out[i] = { i, label: labels[i], open: j.answers.open.noul, gap: j.answers.gap.noul };
}));
// 期待：A は open が真、G は gap が真、N は両方偽
const mixed = new Set([16, 28, 50]);
let ok = 0; const bad = [];
for (const o of out) {
  const o1 = o.open > 0.5, g1 = o.gap > 0.5;
  const want = mixed.has(o.i) ? [true, true] : o.label === "A" ? [true, false] : o.label === "G" ? [false, true] : [false, false];
  // A は gap を問わず open だけ、G は gap だけを見る（主の判定）
  const good = o.label === "A" ? o1 : o.label === "G" ? g1 : !o1 && !g1;
  if (good) ok++; else bad.push(o.i + ":" + o.label + " open=" + o.open + " gap=" + o.gap);
}
console.log(JSON.stringify({ lang, ok: ok + "/91", usd: (tok * 0.042e-6).toFixed(5) }));
console.log(bad.join("\n"));
fs.writeFileSync(new URL("./e1b-" + lang + ".json", import.meta.url), JSON.stringify(out));
