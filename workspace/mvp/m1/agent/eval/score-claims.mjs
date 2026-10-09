// 採点表 v5 の申告の採点（#277）。「書けなかった要件」の申告（log.json の unwritable）を、宣言とは別の欄で採点する。
// v4 の score-claims.mjs との違い：書けない要件の正解を、**宣言が当てはまった構造ごと**に定義から読む（2026-10-09 決定②）。
//   例：D の主の構造（参照の並び）では「参加者 0 人で登録」が書けない。別の構造（出欠の entity）では「定員を超えたら断る」が書けない
// 使い方: node score-claims.mjs <log.json> <題材の id か定義のパス> <構造の id> [書けた要件の id をカンマ区切り]
// 出力（JSON 1 行）: { correct, missed, optional, allowed, false_claims: [...], verdict, expected }
//   allowed … 許される申告（DEFAULT_ALLOWED と定義の allowedClaims）に当たったもの（数えない）
//   optional … 定義で optionalIfWritten の要件を、書けたうえで申告したもの（数えない）
// 照合は要件の言葉の部分一致（定義の keys を正規表現として読む）。最後の試行（直しの後）の unwritable を見る。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDef } from "./engine.mjs";
import { defPath } from "./rubric-v5.mjs";

// 2026-10-09 所有者の決定：次の 2 つは**許される申告**（誤った申告にも、必須の申告にも数えない）。全題材に共通の既定。
// 題材の定義の `allowedClaims`（[{ id, keys }]）で足せる
export const DEFAULT_ALLOWED = [
  { id: "ボタンの表示名", keys: ["ボタン.{0,20}(表示名|名前|ラベル|文言)", "(表示名|ラベル|文言).{0,20}ボタン", "操作.{0,10}(表示名|ラベル)"] },
  { id: "最初に開く画面", keys: ["最初(に開く|に表示|の画面)", "初期(画面|表示)", "トップ(画面|ページ)", "開いたら(すぐ|最初)"] },
];

export function scoreClaims(log, def, structureId, written = {}) {
  const st = def.structures.find((s) => s.id === structureId) ?? def.structures[0];
  const last = log.attempts[log.attempts.length - 1];
  const claims = (last?.unwritable ?? []).map((u) => `${u.requirement} ${u.reason}`);
  const compile = (u) => ({ ...u, res: u.keys.map((k) => new RegExp(k)) });
  const expected = st.unwritable.map(compile);
  const allowed = [...DEFAULT_ALLOWED, ...(def.allowedClaims ?? [])].map(compile);
  const hit = (u, c) => u.res.some((re) => re.test(c));
  const result = { structure: st.id, expected: expected.map((u) => u.id), correct: 0, missed: 0, optional: 0, allowed: 0, false_claims: [] };
  for (const u of expected) {
    const claimed = claims.some((c) => hit(u, c));
    if (u.optionalIfWritten && written[u.optionalIfWritten]) result.optional += claimed ? 1 : 0;
    else if (claimed) result.correct += 1;
    else result.missed += 1;
  }
  for (const c of claims) {
    if (expected.some((u) => hit(u, c))) continue;
    if (allowed.some((u) => hit(u, c))) result.allowed += 1;
    else result.false_claims.push(c.slice(0, 160));
  }
  result.verdict = result.missed === 0 && result.false_claims.length === 0 ? "OK" : "NG";
  return result;
}

// 宣言の判定と申告から、最終の判定を決める（決定②：別の構造は、書けない要件を正しく申告したときだけ合格。
// 「正しく申告した」は挙げ漏れが 0 であること。誤った申告は宣言の合否に混ぜず、別の指標で数える）
export const finalVerdict = (spec, claims) => (spec.verdict === "PASS_NEEDS_CLAIM" ? (claims && claims.missed === 0 ? "PASS" : "FAIL") : spec.verdict);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , logPath, subject, structureId, written] = process.argv;
  const w = Object.fromEntries((written ?? "").split(",").filter(Boolean).map((k) => [k, true]));
  console.log(JSON.stringify(scoreClaims(JSON.parse(readFileSync(logPath, "utf8")), loadDef(defPath(subject)), structureId, w)));
}
