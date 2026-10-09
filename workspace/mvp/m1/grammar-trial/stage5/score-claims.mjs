// #168 第 5 段：「書けなかった要件」の申告（log.json の unwritable）を、宣言とは別の欄で採点する（2026-10-09 決定③）。
// 使い方: node score-claims.mjs <log.json> <A|B|C|D|E> [少ない順を書けたか true|false]
// 出力（JSON 1 行）: { correct, missed, false_claims: [...], optional, verdict }
//   correct      … 書けない要件を正しく申告した数
//   missed       … 書けない要件を申告しなかった数（挙げ漏れ）
//   false_claims … 書ける要件を「書けない」と申告したもの（誤った申告）。**第 1 段の判定が外れている可能性もあるので、人が確かめる**
//   optional     … 決定①で「書けても書けなくてもよい」要件への申告（B の「少ない順」を書けたうえで申告した場合）
//   verdict      … OK（挙げ漏れ 0・誤った申告 0）／NG
// 照合は要件の言葉の部分一致（下の KEYS）。最後の試行（直しの後）の unwritable を見る。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 題材ごとの「書けない要件」（第 1 段の判定）と、申告の文から見つける手がかり
export const UNWRITABLE = {
  A: [],
  B: [{ id: "少ない順", keys: [/少ない/, /昇順/, /並べ/] }],
  C: [],
  D: [{ id: "参加者 0 人で登録", keys: [/0\s*人/, /０\s*人/, /ゼロ/, /誰も(い|居)/, /いなくても/, /空/, /あとから/, /後から/, /任意/, /必須/] }],
  E: [],
};

export function scoreClaims(log, subject, writtenLessFirst = false) {
  const last = log.attempts[log.attempts.length - 1];
  const claims = (last?.unwritable ?? []).map((u) => `${u.requirement} ${u.reason}`);
  const expected = UNWRITABLE[subject];
  const hit = (k, c) => k.keys.some((re) => re.test(c));
  const result = { correct: 0, missed: 0, optional: 0, false_claims: [] };
  for (const k of expected) {
    const claimed = claims.some((c) => hit(k, c));
    const optional = subject === "B" && k.id === "少ない順" && writtenLessFirst;
    if (optional) result.optional += claimed ? 1 : 0;
    else if (claimed) result.correct += 1;
    else result.missed += 1;
  }
  for (const c of claims) if (!expected.some((k) => hit(k, c))) result.false_claims.push(c.slice(0, 160));
  result.verdict = result.missed === 0 && result.false_claims.length === 0 ? "OK" : "NG";
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , logPath, subject, written] = process.argv;
  console.log(JSON.stringify(scoreClaims(JSON.parse(readFileSync(logPath, "utf8")), subject, written === "true")));
}
