import { ask } from "./jev.mjs";
let tok = 0;
const run = async (s, q) => { const j = await ask(s, q); tok += j.usage.input_tokens; return j.answers; };

// E3: 利用者役。構造化した隠した意図から、選択肢を選ぶだけ（文を作らないので意図が漏れない）
const intent = { 集計: "本の冊数は、読み終えた本だけを数える", 期間: "今年の分だけを見たい", 権限: "記録は本人だけが直せればよい", 締切: "（意図に書いていない）" };
const qs = [
  ["冊数はどの本を数えますか", { all: "登録した本をすべて数える", finished: "読み終えた本だけを数える", reading: "読んでいる途中の本だけを数える" }, "finished"],
  ["どの期間の冊数を見たいですか", { all_time: "これまでの全部", this_year: "今年の分", this_month: "今月の分" }, "this_year"],
  ["記録を直せるのは誰ですか", { anyone: "メンバーなら誰でも", owner: "記録した本人だけ", admin: "管理者だけ" }, "owner"],
  ["読み終える期限を設けますか", { none: "設けない", per_book: "本ごとに期限を設ける" }, "not_in_intent"],
  ["一覧の並び順はどうしますか", { newest: "新しい順", title: "書名の順" }, "not_in_intent"],
];
const res3 = [];
for (const rev of [false, true]) {
  const questions = {};
  qs.forEach(([q, o], i) => {
    const keys = Object.keys(o); if (rev) keys.reverse();
    const crit = Object.fromEntries(keys.map((k) => [k, o[k]]));
    crit.not_in_intent = "`intent` does not say anything that decides this question";
    questions["q" + i] = { type: "choice", instructions: { question: q, task: "Answer `question` as the user whose wishes are exactly `intent`. Choose only from what `intent` states." }, criteria: crit };
  });
  const a = await run({ intent }, questions);
  qs.forEach(([q, , want], i) => res3.push(`${rev ? "rev" : "fwd"} ${a["q" + i].choice === want ? "ok" : "NG"} want=${want} got=${a["q" + i].choice} conf=${a["q" + i].confidence} | ${q}`));
}
console.log("E3\n" + res3.join("\n"));

// E4: 洗い出し（P3）。要件 × 曖昧さの観点を、Noul の扇形で一度に聞く
const pairs = [
  ["メンバーごとに、担当している持ち物の数を見られる。", "Does the requirement say whether to count records or to add up a quantity?", false],
  ["メンバーごとに、担当している記録の件数を見られる。", "Does the requirement say whether to count records or to add up a quantity?", true],
  ["メンバーごとに、担当している数量の合計を見られる。", "Does the requirement say whether to count records or to add up a quantity?", true],
  ["直近 6 か月の月ごとの集金額をグラフで見られる。", "Does the requirement say whether the current month is included?", false],
  ["今月を含む直近 6 か月の月ごとの集金額をグラフで見られる。", "Does the requirement say whether the current month is included?", true],
  ["数は 1 以上でなければ登録できない。", "Does the requirement say whether the number must be a whole number?", false],
  ["数は 1 以上の整数でなければ登録できない。", "Does the requirement say whether the number must be a whole number?", true],
  ["一覧を種類と担当者で絞り込める。", "Does the requirement say how two filters combine when both are chosen (both must match, or either)?", false],
  ["一覧を種類と担当者で絞り込める。両方を選んだら、両方に合うものだけを出す。", "Does the requirement say how two filters combine when both are chosen (both must match, or either)?", true],
  ["メンバーごとの当番回数を見られる。", "Does the requirement say which duties are counted (only finished ones, or also planned ones)?", false],
  ["メンバーごとに、済みになった当番の回数を見られる。", "Does the requirement say which duties are counted (only finished ones, or also planned ones)?", true],
  ["返す日を過ぎた貸し出しには印を付ける。", "Does the requirement say whether already-returned items also get the mark?", false],
];
const qs4 = Object.fromEntries(pairs.map(([r, q], i) => ["p" + i, { type: "noul", instructions: { requirement: r, question: q.replace("the requirement", "`requirement`") } }]));
const a4 = await run({ note: "Each question carries its own requirement." }, qs4);
let ok4 = 0;
const r4 = pairs.map(([r, , truth], i) => { const v = a4["p" + i].noul; const good = (v > 0.5) === truth; if (good) ok4++; return `${good ? "ok" : "NG"} truth=${truth} noul=${v} | ${r}`; });
console.log("E4 " + ok4 + "/" + pairs.length + "\n" + r4.join("\n"));

// E5: 逆照合。原文の文ごとに、要件の一覧のどれかが覆うかを聞く（要件を 1 つ抜いておく）
const source = ["読書会のアプリを作りたい。", "メンバーと本を登録する。", "本には書名と著者を持たせる。", "誰がどの本を読み終えたかを記録する。", "メンバーごとに読み終えた冊数を見たい。", "最初の画面で今月の読了数を見たい。"];
const reqs = ["R-1 メンバーを登録できる。", "R-2 本を登録でき、書名と著者を持つ。", "R-3 読了の記録（メンバー・本）を登録できる。", "R-4 メンバーごとに、読了の記録の件数を見られる。"];
const truth5 = [true, true, true, true, true, false]; // 最後の文は落としてある。最初の文は目的で、覆われているとみなす
const qs5 = Object.fromEntries(source.map((s, i) => ["s" + i, { type: "noul", instructions: { sentence: s, question: "Is everything that `sentence` asks for covered by at least one item in `requirements`? A sentence that only states the purpose of the app counts as covered." } }]));
const a5 = await run({ requirements: reqs }, qs5);
let ok5 = 0;
const r5 = source.map((s, i) => { const v = a5["s" + i].noul; const good = (v > 0.5) === truth5[i]; if (good) ok5++; return `${good ? "ok" : "NG"} truth=${truth5[i]} noul=${v} | ${s}`; });
console.log("E5 " + ok5 + "/" + source.length + "\n" + r5.join("\n"));
console.log("usd", (tok * 0.042e-6).toFixed(5));
