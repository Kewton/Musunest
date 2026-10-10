// E1: 設計の段の「書けない」の申告を、曖昧さ／語彙の穴／問題ではない に分ける
import { ask } from "./jev.mjs";
import fs from "node:fs";
const rows = JSON.parse(fs.readFileSync(new URL("./unwritable-rows.json", import.meta.url)));
const labels = JSON.parse(fs.readFileSync(new URL("./labels.json", import.meta.url)));
const OPTS = {
  ambiguity: "The note says the requirement leaves something undecided (for example which of two interpretations, which period, which records to count, integer or decimal). Choosing one answer would make it buildable.",
  vocabulary_gap: "The note says the declaration language has no way to express something (no field, no operator, fixed order or limit, empty list not allowed, no app name, date has no time, and so on).",
  not_an_issue: "The note only restates the requirement, says something is out of scope or not requested, or is a subjective quality that no app could guarantee.",
};
const order = process.argv[2] === "rev" ? Object.keys(OPTS).reverse() : Object.keys(OPTS);
const criteria = Object.fromEntries(order.map((k) => [k, OPTS[k]]));
const map = { ambiguity: "A", vocabulary_gap: "G", not_an_issue: "N" };
let tok = 0, ok = 0, out = [];
const t = Date.now();
await Promise.all(rows.map(async (r, i) => {
  const j = await ask({ requirement: r.text, note: r.claim }, {
    kind: { type: "choice", instructions: "A design step wrote `note` about why part of `requirement` cannot be written. What kind of note is it?", criteria },
  });
  tok += j.usage.input_tokens;
  const a = j.answers.kind;
  out[i] = { i, label: labels[i], got: map[a.choice], conf: a.confidence };
}));
for (const o of out) if (o.label === o.got) ok++;
const cm = {};
for (const o of out) cm[o.label + "->" + o.got] = (cm[o.label + "->" + o.got] || 0) + 1;
const hi = out.filter((o) => o.conf >= 0.6);
console.log(JSON.stringify({ order: process.argv[2] || "fwd", acc: ok + "/" + out.length, cm, hiConf: hi.length, hiAcc: hi.filter((o) => o.label === o.got).length, input_tokens: tok, usd: (tok * 0.042e-6).toFixed(5), ms: Date.now() - t }));
fs.writeFileSync(new URL("./e1-" + (process.argv[2] || "fwd") + ".json", import.meta.url), JSON.stringify(out));
