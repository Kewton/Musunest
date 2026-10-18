// 受入の試験の採点：run-agent.mjs の出力を採点表 v5（凍結）で採点し、基準線と同じ指標を出す。API は呼ばない。
// 使い方: node score-agent.mjs <repo> <out> [--label high] [--anonymous] [--set <定義ファイル>]
//   --anonymous：行ごとの失敗の鍵・要件の文・題材 ID を出さず、指標の数と区間だけを書く（回帰用・保留用の組。#425）。
//                書くのは score[-label].anonymous.json だけで、行つきの score[-label].json は書かない
//   --set：評価セットの定義ファイル（#427）。省略すると条件のファイルに記録された定義ファイル、それも無ければ既定の sets/dev-p1-p10.json
// #425 で足したもの（既存の欄は消さず、意味も変えない）：
//   集計の版 … v1 ＝ 補正前（metrics の fulfillment_partial と rows の fulfilled／writable_total。生成失敗・静的 NG の本は
//              充足率の分母に入らない）。v2 ＝ 補正後（fulfillment.v2 と rows の fulfillment_v2。分母は題材の採点定義の判定の数。
//              生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す）。2 つの版は別の欄に並べ、混ぜない
//   本数の照合 … completion。条件のファイルの予定（child_args）を検証（schema・一覧の型・ID の形と一意性・params.patterns × runs との一致）
//              してから出力先の本と照合し、未実行・途中・予定外が 1 本でもあれば「未完了」。検証に落ちれば「未照合」と理由
//   指紋 … fingerprints。採点に使った定義とエンジン（<repo> から実際に読み込んだもの）と集計のコード（実行中のこのファイル）の指紋、
//          spec-engine の dist の指紋。条件のファイルの値と照合する（別の checkout を <repo> に渡しても、集計したコードの指紋が出る）
// #426 で足したもの（原文系の欄は変えない。README §5.5）：
//   了承後系 … Plan を通した本を、確定した仕様（bundle/artifacts/plan.json。契約の検査 checkConfirmedPlan を通ったものだけ）の了承の記録で読み替えて
//              別に数える。了承済みの書けない要件は申告が無くても挙げ漏れにせず（claims_accepted）、誤った除外・判定不能・未評価を別に数える
//              （rows[].acceptance・metrics_accepted・fulfillment.accepted）。原文の要件との対応は定義の keys（正規表現）で、処分した部分の文だけに当てる。
//              分母・分子は v2 と同じ（了承で変わった判定も誤った除外も外さない）。変更後を判定する手段（対応データ。別の Issue）が無い間、
//              誤った了承の指標は「未評価」で、変更が当たった本の了承後の判定は UNEVALUATED（PASS にしない）。
//              処分の照合（expected・allowed）とは別に、了承後の有効な要件の評価の状態（acceptance.effective）を持つ：判定の手段が無い有効な要件
//              （代替先・変更後・追加）が 1 つでもあれば、照合が expected でもその本は UNEVALUATED。件数は行・集計・匿名・標準出力に残す。
//              記録の無い本（理由の内訳つき）・読めない本は充足 0 で分母に残す。Plan を通していない計測の本は対象外（null）
// #427 で足したもの（README §5.6）：
//   評価セットの定義ファイル … 本の ID → 題材・書き方・書ける範囲・採点の定義・台本・依頼文を 1 つのファイル（sets/<組>.json）から読む。
//              P 番号と題材の対応をこの道具の中に持たない。条件のファイルの set.path（無ければ既定の組）を読み、指紋を条件と照合する
//   台本 … Plan の質問に、質問 ID ではなく点検済みの事項（文の鍵と目録の観点）で答える台本（sets/scripts/<題材>.json）を、往復の記録の
//              全部の問いに**事後に**当てる（工場の答えの口は質問 ID で Plan の前に 1 度だけ読むので、実行中には当てられない）。台本に無い問いは
//              「不明」、決められない問いは「決められない」として数え、推奨に丸めない（rows[].script・metrics_script）。判定と合格率は変えない
//   独立レビューの直し（fix-427）… 採点の指紋に、組が実際に参照する採点の定義の実体（definition:<題材>）を含める。予定の本が採点する組に無ければ
//              採点せずに断る。照合に採点した本数と採点できない本（組に無い ID）を足し、黙って分母から除かない。--anonymous は読み込みと診断の
//              前に伝え、標準エラーも件数だけにする
// #493 で足したもの（既存の行・metrics・匿名の口の欄は変えない）：
//   tables … 診断の読み方。Plan の表（全本 1 行と合計：結果・止まり方の分類・問数・往復・段ごとの時間・Plan の費用）と、Build の表（Plan が確定した本だけ：
//            工場の verdict・既存の採点の PASS・段ごとの時間・Build の費用。外した本の数と内訳を添える）。匿名の口には件数と率だけ
// #498 で足したもの（既存の欄の名前・意味・値は変えない。README §5.2・§5.3）：
//   evaluation … 評価の種類（mode・build_applicable）。metrics_plan … Plan の集計（e2e・plan-only）。metrics_build … Build だけの集計（build-from）。
//            分母は予定した本の全部（未実行・途中・記録なしも残す）。時間と費用は { observed, missing, total, median }。分類は既知の列挙へ写し、知らない値は unknown。
//            fingerprints.frozen・frozen_matches_conditions（組のファイルの SHA-256）。build-from で条件の frozen が無い・形が違えば断る。
//            無害化：診断の表の止まり方の分類・段の ID・工場の verdict と、その標準出力（行の verdict を含む）も既知の一覧へ写す
// #513 で足したもの（既存の欄の名前・意味・値は変えない。README の v1.1α の節）：
//   条件の版 v5（params.pipeline・params.stage_output_limits_v11a・comparison）。evaluation.pipeline は v5 のときだけ出す（v1〜v4 の出力の欄は変えない）。
//   BUILD_STAGE_IDS に v1.1α の 7 段。--compare … 対にした交互の計測（run-agent.mjs --compare）の出力先を、両群を今の関数で採点してから対で組み、
//   原文系 PASS の対の差（候補 v1.1a − 比較元 v1）・停止段と到達数・持ち越しの内訳・照合（未照合・未完了・完了）を score-compare[-label].json に書く
// #538 で足したもの（既存の欄の名前・意味・値は変えない。README §5.9。設計書 08 §7・§8.1・§8.4）：
//   funnel … 段ごとの到達・1 回目で通過（calls 0 の段は適用外 null）・通過・停止。件数の分母は予定した本、条件付き率の分母は到達した本。完走の内訳。
//   pass_k … P ごとに全反復（k ＝ 条件の runs）が原文系 PASS か。verdicts … 原文系・了承後系・工場の 4 値を別に数える（分母は予定した本、率は実行・納品の中）。
//   rows[].factory_verdict4（正本は要約の verdict と assurance。検証の記録の内訳から復元しない）・rows[].unverified_details（内訳の件数。欄が無ければ null）。
//   --compare は群ごとに同じ欄、匿名の口は件数と率だけ
// #539 で足したもの（既存の欄と #538 の欄の名前・意味・値は変えない。README §5.10。設計書 08 §8.2・§8.7）：
//   agreement … 本ごとの（工場の 4 値 × 原文系の判定）の件数の表と、了承後系の同じ形の表（分母は予定した本。未実行・途中は別の行）。
//   test_findings … 不一致・未解決の試験を評価器の固定文の形（FINDING_PATTERNS）で 5 つに分類する。正本は tests.json、verification.json の
//            unresolved_tests は写しとして試験 ID で突き合わせ、二重に数えない（理由の文が違えば inconsistent）。判定・PASS・分母には使わない。
//   --compare … stage_pairs（段の役割ごとの到達・1 回目で通過・通過の対の差）と pattern_clusters（P をまとまりにした符号反転の p・bootstrap の区間。
//            t 区間は参考）。匿名の口は件数・平均・区間・p だけ
// #545 で足したもの（段単位の条件の計測だけ。段単位でない条件の採点の欄・値・標準出力は変えない。README §5.11。設計書 08 §8.3）：
//   条件の版 v6（params.mode が stage-run）の計測では、本ごとに工場の段の走りの記録（bundle/stage-run.json）から段の通過・停止・⑦ の判定を読み、
//   stage_pass_rate（対象予定・入力なし・起動・観測・欠測・通過。率の分母は 予定 − 入力なし で起動前に決まる）を出す。原文系・了承後系の PASS と納品の欄は
//   計算しない（null と not_computed の理由 stage-run）。漏斗は範囲の中の段だけ。--compare は段だけの対の比較（before・after）で、段の通過の対の差と
//   P のまとまりの p・bootstrap の区間を今の関数で出す
// #557 で足したもの（経路 v1.2 の条件と --compare-pipelines の組の採点だけ。v1・v1.1a の条件と比較の欄・値・標準出力は変えない。README §5.13。設計書 08 §8.6・§8.7・§9）：
//   条件の版 v7（params.pipeline が v1.2 で params.v12_flags を足した。v1.2 のときだけ）。evaluation.pipeline に v1.2、evaluation.v12_flags に条件の旗の組と
//   照合の結果ごとの本の数。照合は計測が本ごとに残した報告（summary.line.json の v12_flags）を条件の組と名前 → 真偽の集合として照らし直す。起動した本の 1 本でも
//   一致しなければ照合は未照合（completion.unverified に v12-flags）。未起動の本は今の未実行・途中のまま。
//   --compare は比較の記録の群の組（v1,v1.1a・v1.1a,v1.2・v1,v1.2）を読み、v1.2 を含む組は群の条件を版ごとに検証してから共通の形で照らす。
//   差の向きの文は「候補（<候補>）− 比較元（<比較元>）」。段の役割の表は v1.2 を v1.1α の段の名前で引く。profile の違いの理由 pipelines を残す
// #631 で足したもの（--compare の出力の末尾の noise だけ。既存の欄・値・並びと採点の規則は変えない。README §8）：
//   対の差の P ごとの並び（原文系 PASS と、段の役割ごとの通過）から、予測の雑音（P 内の反復のぶれ）とデータの雑音（P の違い）・勝つ側・反復 K′ ごとに
//   検出できる差の目安を出す。判定・門には使わない。匿名の口は m・使った P の数・分散・勝つ側・δ の表だけ。標準出力に 1 行
// run-agent.mjs は、ここから指紋の関数と定義ファイルの読み込みを import して条件のファイルに書く（道具は 2 本で 1 組。入口として起動したときだけ採点する）
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGGREGATION_VERSIONS = {
  v1: "補正前：充足率の分母は当てはまった構造の判定の数。生成失敗・静的 NG の本は分母に入らない",
  v2: "補正後：充足率の分母は題材の採点定義の判定の数（当てはまった構造。無ければ主の構造）。生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す",
};
/** 採点の系（#426）。原文系 ＝ 凍結した v5 の判定のまま。了承後系 ＝ 確定した仕様の了承の記録で読み替える。2 つの系は別の欄に並べ、混ぜない */
export const SCORING_SYSTEMS = {
  source: "原文系：凍結した v5 の判定のまま（集計の版 v1・v2）。了承の記録は見ない",
  accepted: "了承後系：確定した仕様（plan.json。契約の検査を通ったもの）の了承の記録で読み替える。了承済みの書けない要件は申告が無くても挙げ漏れにせず、誤った除外・判定不能・未評価を別に数える。分母・分子は v2 と同じ（了承で変わった判定も誤った除外も外さない）。変更後を判定する手段が無い間、誤った了承は未評価、変更が当たった本の判定は UNEVALUATED。生成失敗・静的 NG・記録の無い本は充足 0 で分母に残す",
};
/** 条件のファイルの既知の schema（v1 ＝ #401、v2 ＝ #425、v3 ＝ #427、v4 ＝ #497、v5 ＝ #513。どれも child_args と params.patterns・params.runs を持つ） */
export const CONDITIONS_SCHEMAS = ["musunest-factory/agent-accept-conditions/v1", "musunest-factory/agent-accept-conditions/v2", "musunest-factory/agent-accept-conditions/v3", "musunest-factory/agent-accept-conditions/v4", "musunest-factory/agent-accept-conditions/v5"];
/** 工場の要約の verdict の既知の値（packages/factory の Verdict）。匿名の集計はこれ以外を unknown にまとめる */
export const FACTORY_VERDICTS = ["full", "partial", "none"];
/** 判定の口の構成の既知の値（run-agent.mjs が記録する） */
export const JUDGE_CONFIGURATIONS = ["jev-primary-llm-fallback", "llm-only"];
/** 起動の記録の止まった理由のコード（budget ＝ 計測全体の目安の額に達した。other ＝ それ以外の文） */
export const STOP_CODES = ["budget", "other"];
const COMPLETION_LABELS = { complete: "完了", incomplete: "未完了", unverified: "未照合" };

// ── 指紋（run-agent.mjs と共有）
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const walkFiles = (dir, base = dir) => readdirSync(dir).sort().flatMap((name) => { const full = join(dir, name); return statSync(full).isDirectory() ? walkFiles(full, base) : [relative(base, full)]; });
/** ディレクトリの指紋（相対パスと中身のハッシュ）と、いちばん新しい更新時刻 */
export const fingerprintDir = (dir) => {
  if (!existsSync(dir)) return { fingerprint: null, files: 0, mtime_ms: null };
  const files = walkFiles(dir);
  const h = createHash("sha256");
  let mtime = 0;
  for (const rel of files) { const full = join(dir, rel); h.update(rel); h.update("\0"); h.update(sha256(readFileSync(full))); h.update("\n"); mtime = Math.max(mtime, statSync(full).mtimeMs); }
  return { fingerprint: h.digest("hex"), files: files.length, mtime_ms: files.length ? mtime : null };
};
/** 採点の定義と集計のコード：エンジン・申告の採点・入口・この採点の道具と、題材の定義（subjects/*.json）全部。組が参照する採点の定義の実体は definitions で足す */
export const SCORING_FILES = ["engine.mjs", "score-claims.mjs", "rubric-v5.mjs", "agent-accept/score-agent.mjs"];
/** 集計のコード（この道具）。指紋の中では evDir からの相対名で数えるが、実体は aggregator で差し替えられる */
export const AGGREGATOR_FILE = "agent-accept/score-agent.mjs";
/**
 * evDir は定義とエンジンを実際に読み込む場所。aggregator は集計のコードの実体のパス（既定は evDir の中の score-agent.mjs。
 * 条件のファイルへ書く run-agent.mjs は既定のまま＝ <repo> の採点器。採点する scoreOutput は実行中のファイルを渡す）。
 * 別の checkout の採点器を起動して <repo> を渡したときに、<repo> の旧い採点器の指紋を「一致」と出さないため。
 * definitions は、組（定義ファイル）が実際に参照する採点の定義の実体（loadEvalSet の definitions。題材 → { path }）。subjects/ の外に置いた定義も
 * ここで指紋に入る（definition:<題材>。中身の SHA-256 で数え、パスに依らない）。組を変えずに参照先の中身だけを変えても、計測の条件と採点の指紋が食い違う
 */
export function scoringFingerprint(evDir, aggregator = join(evDir, AGGREGATOR_FILE), definitions = new Map()) {
  const subjectsDir = join(evDir, "subjects");
  const subjects = existsSync(subjectsDir) ? readdirSync(subjectsDir).filter((n) => n.endsWith(".json")).sort().map((n) => `subjects/${n}`) : [];
  const h = createHash("sha256");
  const files = [], missing = [];
  const add = (rel, full, extra = {}) => {
    if (!existsSync(full)) { missing.push(rel); return; }
    const digest = sha256(readFileSync(full));
    files.push({ path: rel, ...extra, sha256: digest });
    h.update(rel); h.update("\0"); h.update(digest); h.update("\n");
  };
  for (const rel of [...SCORING_FILES, ...subjects]) add(rel, rel === AGGREGATOR_FILE ? aggregator : join(evDir, rel));
  for (const subject of [...definitions.keys()].sort()) add(`definition:${subject}`, definitions.get(subject).path, { source: relative(evDir, definitions.get(subject).path) });
  return { fingerprint: h.digest("hex"), files, missing };
}

// ── 本数の照合
const RUN_DIR = /^P\d+-r\d+$/;
const PATTERN_ID = /^P\d+$/;
/** 本の名前（P<n>-r<n>）から本の ID（P<n>） */
const patternOf = (run) => run.split("-")[0];
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
/** 採点を止める記録の読み取りの失敗の種類（#498 の独立レビューの指摘 1）。入口は通常・匿名のどちらでも、固定の文とこの符号だけを出す（例外の文は入力の断片を含みうる） */
export const RECORD_KINDS = ["summary", "unwritable", "run-record"];
const recordUnreadable = (kind) => Object.assign(new Error(`記録を読めない [score:record-unreadable:${kind}]`), { recordUnreadable: kind });
/** 読めなければ採点を止める記録を読む（JSON でない・読めない → 固定の符号の誤り） */
const readRecord = (path, kind) => { try { return readJson(path); } catch { throw recordUnreadable(kind); } };
const runDirs = (outRoot) => readdirSync(outRoot).filter((x) => RUN_DIR.test(x)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
/** 条件のファイルを読む：無ければ missing、JSON として読めないか object でなければ unreadable */
export function loadConditions(outRoot) {
  const path = join(outRoot, "conditions.json");
  if (!existsSync(path)) return { status: "missing", cond: null };
  try { const c = readJson(path); return c !== null && typeof c === "object" && !Array.isArray(c) ? { status: "ok", cond: c } : { status: "unreadable", cond: null }; } catch { return { status: "unreadable", cond: null }; }
}
export const readConditions = (outRoot) => loadConditions(outRoot).cond;
/**
 * 条件のファイルの予定を検証する（照合できない理由の一覧。空なら照合できる）。理由に入力の値は含めない。
 * 見るもの：既知の schema・予定の一覧（child_args）が配列・各 ID が文字列で P<n>-r<n> の形・ID の一意性・params.patterns と params.runs の形・
 * 予定の一覧が params.patterns × runs と一致・予定が 1 本以上。欠落・旧形式・編集後の不整合を「完了」に丸めないための検証
 */
export function validatePlanned(cond) {
  const reasons = [];
  if (!CONDITIONS_SCHEMAS.includes(cond?.schema) && cond?.schema !== CONDITIONS_V6 && cond?.schema !== CONDITIONS_V7) reasons.push("schema が未知");
  const list = cond?.child_args;
  const isList = Array.isArray(list);
  if (!isList) reasons.push("予定の一覧（child_args）が無いか配列でない");
  const ids = isList ? list.map((c) => c?.id) : [];
  const idsOk = isList && ids.every((id) => typeof id === "string" && RUN_DIR.test(id));
  if (isList && !idsOk) reasons.push("予定の ID が文字列でないか P<n>-r<n> の形でない");
  if (idsOk && new Set(ids).size !== ids.length) reasons.push("予定の ID が重複");
  const p = cond?.params;
  const paramsOk = Array.isArray(p?.patterns) && p.patterns.every((x) => typeof x === "string" && PATTERN_ID.test(x)) && Number.isInteger(p?.runs) && p.runs >= 0;
  if (!paramsOk) reasons.push("params.patterns・params.runs が無いか形が違う");
  if (idsOk && paramsOk) {
    const expected = p.patterns.flatMap((pid) => Array.from({ length: p.runs }, (_, i) => `${pid}-r${i + 1}`)).sort();
    if (JSON.stringify(expected) !== JSON.stringify([...ids].sort())) reasons.push("予定の一覧が params.patterns × runs と一致しない");
  }
  if (isList && list.length === 0) reasons.push("予定が 0 本");
  return reasons;
}
const stopCodeOf = (r) => (STOP_CODES.includes(r.stop_code) ? r.stop_code : r.stop === null || r.stop === undefined ? null : /^予算 /.test(String(r.stop)) ? "budget" : "other");
/**
 * 予定した本（条件のファイルの child_args）・実行した本（要約のある本）・未実行の本（ディレクトリが無い）・途中の本（要約の無い本）・予定外の本（予定に無いディレクトリ）を照合する。
 * 未実行・途中・予定外が 1 本でもあれば「未完了」（正式な比較基準にしない、の機械の目印。方法論 01 §3）。
 * 条件のファイルが無い出力先（#401 より前の計測）・読めない条件・予定を検証できない条件（validatePlanned）は照合できないので「未照合」と理由。
 * set（採点する組。loadEvalSet の結果）を渡すと、採点した本数（scored）と採点できない本（unscored。組に無い ID の本。採点の道具は行に入れない）も照合し、
 * 採点できない本が 1 本でもあれば理由に残す（黙って分母から除かない）。渡さなければ scored・unscored は null
 */
export function reconcile(outRoot, set = null) {
  const dirs = runDirs(outRoot);
  const executed = dirs.filter((d) => existsSync(join(outRoot, d, "summary.line.json")));
  const incomplete = dirs.filter((d) => !executed.includes(d));
  const unscored = set === null ? null : dirs.filter((d) => !set.byId.has(patternOf(d)));
  const scored = unscored === null ? null : dirs.length - unscored.length;
  const unscoredReasons = unscored !== null && unscored.length > 0 ? [`採点できない ${unscored.length} 本（組に無い ID）`] : [];
  // 1 回の起動の記録（run-<時刻>.json。再開は resume-<時刻>.json も残す）。いちばん新しいものの止まった理由（文とコード）・残りの本・その起動で有効だった目安の額を添える
  const records = readdirSync(outRoot).filter((n) => /^(run|resume)-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const last = records.at(-1);
  const latest_record = last === undefined ? null : (() => { const r = readRecord(join(outRoot, last), "run-record"); return { file: last, stop: r.stop ?? null, stop_code: stopCodeOf(r), pending: r.pending ?? [], budget_usd: typeof r.budget_usd === "number" ? r.budget_usd : null }; })();
  const loaded = loadConditions(outRoot);
  const cond = loaded.cond;
  const unverified = (reasons) => ({ status: "unverified", label: COMPLETION_LABELS.unverified, reasons: [...reasons, ...unscoredReasons], measurement_id: typeof cond?.measurement_id === "string" ? cond.measurement_id : null, signature: typeof cond?.signature === "string" ? cond.signature : null, planned: null, executed: executed.length, executed_ids: executed, scored, unscored, unexecuted: null, incomplete, extra: null, latest_record });
  if (loaded.status === "missing") return unverified(["条件のファイルが無い"]);
  if (loaded.status === "unreadable") return unverified(["条件のファイルを読めない"]);
  const invalid = validatePlanned(cond);
  if (invalid.length > 0) return unverified(invalid);
  const planned = cond.child_args.map((c) => c.id);
  // 段単位の走り（#545）：入力なしの本（条件に固定した stage_input_absent）は起こさないので未実行に数えない（別の欄に件数。起動していれば理由に残す）
  const absentIds = isStageConditions(cond) ? stageAbsentOf(cond, planned) ?? [] : null;
  const unexecuted = planned.filter((id) => !dirs.includes(id) && !(absentIds?.includes(id) ?? false));
  const extra = dirs.filter((id) => !planned.includes(id));
  const reasons = [];
  if (unexecuted.length > 0) reasons.push(`未実行 ${unexecuted.length} 本`);
  if (incomplete.length > 0) reasons.push(`途中 ${incomplete.length} 本`);
  if (extra.length > 0) reasons.push(`予定外 ${extra.length} 本`);
  const absentLaunched = absentIds === null ? 0 : absentIds.filter((id) => dirs.includes(id)).length;
  if (absentLaunched > 0) reasons.push(`入力なしなのに起動 ${absentLaunched} 本`);
  reasons.push(...unscoredReasons);
  const status = reasons.length === 0 ? "complete" : "incomplete";
  return { status, label: COMPLETION_LABELS[status], reasons, measurement_id: cond.measurement_id ?? null, signature: cond.signature ?? null, planned: planned.length, executed: executed.length, executed_ids: executed, scored, unscored, unexecuted, incomplete, extra, latest_record, ...(absentIds === null ? {} : { stage_input_absent: absentIds.length }) };
}

// ── 評価セットの定義ファイルと台本（#427。README §5.6）
/** 定義ファイルの契約の版 */
export const EVAL_SET_SCHEMA = "musunest-eval/eval-set/v1";
/** 台本の契約の版 */
export const PLAN_SCRIPT_SCHEMA = "musunest-eval/plan-script/v1";
/** 組の役割（方法論 01 §1） */
export const EVAL_SET_ROLES = ["development", "regression", "holdout"];
/** 工場の目録の観点 ID（packages/factory の CATALOG_FACETS と同じ値。台本の facet に書けるもの） */
export const CATALOG_FACET_IDS = ["aggregation", "period", "current-period", "counted-state", "include-zero", "editable-by"];
/** 既定の組（<repo> からの相対。今の P1〜P10） */
export const DEFAULT_SET_PATH = "workspace/mvp/m1/agent/eval/sets/dev-p1-p10.json";
/** 台本の当て方。今は採点で事後に当てる（工場に事項で答える口が無い。README §5.6.3） */
export const SCRIPT_MODE = "post-hoc";
/** 問い 1 つの台本の照合の状態：台本で答えられた／台本に無い（不明）／決められない */
export const SCRIPT_QUESTION_STATUSES = ["scripted", "unknown", "unresolved"];
/** 決められない理由：台本の件が 2 つ以上当たる／当たる選択肢が無い／当たる選択肢が 2 つ以上 */
export const SCRIPT_UNRESOLVED_REASONS = ["entries", "no-choice", "many-choices"];
/** 本 1 つの台本の照合の状態：全部一致／台本と違う答えで進んだ／不明か決められない問いで進んだ／問いが無い／往復の記録が無い（対象外） */
export const SCRIPT_RUN_STATUSES = ["ok", "disagreed", "unanswered", "no-questions", "none"];
const CATALOG_ISSUE_ID = /^OI:catalog:(.+):([^:]+)$/;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const compiles = (k) => { if (typeof k !== "string" || k === "") return false; try { new RegExp(k); return true; } catch { return false; } };
const regexList = (xs) => Array.isArray(xs) && xs.length > 0 && xs.every(compiles);
/** 台本の形を検証する（落ちた理由の一覧。空なら読める。理由に入力の値は含めない） */
export function validateScript(script) {
  if (!isObj(script)) return ["台本が写像でない"];
  const reasons = [];
  if (script.schema !== PLAN_SCRIPT_SCHEMA) reasons.push("台本の schema が未知");
  if (typeof script.subject !== "string" || script.subject === "") reasons.push("台本の subject が文字列でない");
  if (!Number.isInteger(script.version)) reasons.push("台本の version が整数でない");
  if (!Array.isArray(script.entries)) { reasons.push("台本の entries が配列でない"); return reasons; }
  const ids = new Set();
  script.entries.forEach((e, i) => {
    if (!isObj(e)) { reasons.push(`entries[${i}] が写像でない`); return; }
    if (typeof e.id !== "string" || e.id === "" || ids.has(e.id)) reasons.push(`entries[${i}].id が文字列でないか重複`);
    ids.add(e.id);
    if (!(e.facet === null || CATALOG_FACET_IDS.includes(e.facet))) reasons.push(`entries[${i}].facet が未知`);
    if (!regexList(e.keys)) reasons.push(`entries[${i}].keys が正規表現の配列でないか 0 件`);
    const a = e.answer;
    const choose = isObj(a) && regexList(a.choose) && a.recommended === undefined;
    const recommended = isObj(a) && a.recommended === true && a.choose === undefined;
    if (!choose && !recommended) reasons.push(`entries[${i}].answer が choose（正規表現の配列）か recommended: true のちょうど一方でない`);
    if (typeof e.basis !== "string" || e.basis === "") reasons.push(`entries[${i}].basis が文字列でない`);
  });
  return reasons;
}
/** 台本を読む：無ければ missing、JSON として読めなければ unreadable、形が違えば invalid と理由、通れば ok */
export function loadScript(path) {
  if (!existsSync(path)) return { status: "missing", script: null, reasons: ["台本が無い"], sha256: null };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { status: "unreadable", script: null, reasons: ["台本を読めない"], sha256: null }; }
  let script;
  try { script = JSON.parse(text); } catch { return { status: "unreadable", script: null, reasons: ["台本を JSON として読めない"], sha256: sha256(text) }; }
  const reasons = validateScript(script);
  return reasons.length > 0 ? { status: "invalid", script: null, reasons, sha256: sha256(text) } : { status: "ok", script, reasons: [], sha256: sha256(text) };
}
const ITEM_ID = /^P\d+$/;
const resolveFrom = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));
/**
 * 評価セットの定義ファイルを読む（README §5.6.1）。無ければ missing、読めなければ unreadable、欠けた欄・形の違う欄があれば invalid と理由の一覧
 * （入力の値は書かない）、通れば ok。ok のときは本の一覧（items。依頼文は requestText に組み立て済み）・本の ID → 本（byId）・題材の順（subjects）・
 * 題材ごとの台本（scripts：読み込んだ台本と SHA-256。無い題材は入れない）・題材ごとの採点の定義の実体（definitions：パス・相対の書き方・SHA-256。
 * 採点の指紋 scoringFingerprint に渡す）・定義ファイルの SHA-256 を返す。パスは定義ファイルの場所からの相対（絶対も通す）
 */
export function loadEvalSet(path) {
  if (!existsSync(path)) return { status: "missing", reasons: ["定義ファイルが無い"], set: null };
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return { status: "unreadable", reasons: ["定義ファイルを読めない"], set: null }; }
  let set;
  try { set = JSON.parse(text); } catch { return { status: "unreadable", reasons: ["定義ファイルを JSON として読めない"], set: null }; }
  const reasons = [];
  if (!isObj(set)) return { status: "invalid", reasons: ["定義ファイルが写像でない"], set: null };
  if (set.schema !== EVAL_SET_SCHEMA) reasons.push("schema が未知");
  if (typeof set.id !== "string" || set.id === "") reasons.push("id が文字列でない");
  if (!Number.isInteger(set.version)) reasons.push("version が整数でない");
  if (!EVAL_SET_ROLES.includes(set.role)) reasons.push("role が未知");
  if (!isObj(set.styles)) reasons.push("styles が写像でない");
  if (set.source !== undefined && (!isObj(set.source) || (set.source.document !== undefined && typeof set.source.document !== "string"))) reasons.push("source の形が違う（document は文字列）");
  if (!Array.isArray(set.items) || set.items.length === 0) { reasons.push("items が配列でないか 0 件"); return { status: "invalid", reasons, set: null }; }
  const dir = dirname(path);
  const items = [], ids = new Set(), bySubject = new Map(), scripts = new Map(), definitions = new Map(), subjects = [];
  set.items.forEach((it, i) => {
    if (!isObj(it)) { reasons.push(`items[${i}] が写像でない`); return; }
    if (typeof it.id !== "string" || !ITEM_ID.test(it.id)) reasons.push(`items[${i}].id が P<n> の形でない`);
    else if (ids.has(it.id)) reasons.push("items の id が重複");
    ids.add(it.id);
    if (typeof it.subject !== "string" || it.subject === "") reasons.push(`items[${i}].subject が文字列でない`);
    if (!(isObj(set.styles) && typeof it.style === "string" && it.style in set.styles)) reasons.push(`items[${i}].style が styles に無い`);
    if (typeof it.writable !== "boolean") reasons.push(`items[${i}].writable が真偽値でない`);
    let scoringPath = null, scoringDef = null;
    if (typeof it.scoring !== "string" || it.scoring === "") reasons.push(`items[${i}].scoring が文字列でない`);
    else {
      scoringPath = resolveFrom(dir, it.scoring);
      let scoringText = null;
      try { scoringText = readFileSync(scoringPath, "utf8"); scoringDef = JSON.parse(scoringText); } catch { reasons.push(`items[${i}].scoring の定義が無いか読めない`); }
      if (scoringDef !== null && scoringDef?.id !== it.subject) reasons.push(`items[${i}].scoring の定義の id が subject と違う`);
      else if (scoringDef !== null && typeof it.subject === "string" && !definitions.has(it.subject)) definitions.set(it.subject, { path: scoringPath, rel: it.scoring, sha256: sha256(scoringText) });
    }
    let scriptPath = null;
    if (it.script !== null && (typeof it.script !== "string" || it.script === "")) reasons.push(`items[${i}].script が文字列でも null でもない`);
    else if (typeof it.script === "string") {
      scriptPath = resolveFrom(dir, it.script);
      const loaded = loadScript(scriptPath);
      if (loaded.status !== "ok") reasons.push(`items[${i}].script の台本が読めない: ${loaded.reasons.join("、")}`);
      else if (loaded.script.subject !== it.subject) reasons.push(`items[${i}].script の台本の subject が違う`);
      else if (typeof it.subject === "string" && !scripts.has(it.subject)) scripts.set(it.subject, { path: scriptPath, rel: it.script, sha256: loaded.sha256, script: loaded.script });
    }
    if (!Array.isArray(it.request) || it.request.length === 0 || !it.request.every((l) => typeof l === "string")) reasons.push(`items[${i}].request が文字列の配列でないか 0 行`);
    const prior = typeof it.subject === "string" ? bySubject.get(it.subject) : undefined;
    if (prior !== undefined) {
      if (prior.writable !== it.writable) reasons.push("同じ題材の items で writable が食い違う");
      if (prior.scoring !== it.scoring || prior.script !== it.script) reasons.push("同じ題材の items で scoring・script が食い違う");
    } else if (typeof it.subject === "string") { bySubject.set(it.subject, it); subjects.push(it.subject); }
    items.push({ id: it.id, subject: it.subject, style: it.style, writable: it.writable, scoring: it.scoring, scoringPath, script: it.script, scriptPath, requestText: Array.isArray(it.request) ? it.request.join("\n") : "" });
  });
  if (reasons.length > 0) return { status: "invalid", reasons: [...new Set(reasons)], set: null };
  return { status: "ok", reasons: [], set, path, dir, sha256: sha256(text), items, byId: new Map(items.map((it) => [it.id, it])), subjects, scripts, definitions };
}
/** 台本のまとめた指紋（題材と中身の SHA-256 だけ。パスに依らない）と一覧 */
export function scriptsFingerprint(scripts) {
  const h = createHash("sha256");
  const files = [];
  for (const subject of [...scripts.keys()].sort()) { const sc = scripts.get(subject); h.update(subject); h.update("\0"); h.update(sc.sha256); h.update("\n"); files.push({ subject, sha256: sc.sha256 }); }
  return { fingerprint: files.length === 0 ? null : h.digest("hex"), files };
}
/** 問いが持つ目録の観点（open_issue_id と also_closes の中の OI:catalog:<要件 ID>:<観点 ID>）と、指す要件 ID */
export function questionFacets(question) {
  const facets = [], requirementIds = [];
  for (const id of [question.open_issue_id, ...(Array.isArray(question.also_closes) ? question.also_closes : [])]) {
    const m = typeof id === "string" ? id.match(CATALOG_ISSUE_ID) : null;
    if (m === null) continue;
    if (!facets.includes(m[2])) facets.push(m[2]);
    if (!requirementIds.includes(m[1])) requirementIds.push(m[1]);
  }
  return { facets, requirementIds };
}
/** 確定した仕様（plan.json。無ければ null）から、事項 ID → 文・要件 ID → 文を引く */
export function planTexts(plan) {
  const issues = new Map(), requirements = new Map();
  for (const oi of Array.isArray(plan?.open_issues) ? plan.open_issues : []) if (typeof oi?.id === "string" && typeof oi.text === "string") issues.set(oi.id, oi.text);
  for (const r of Array.isArray(plan?.requirements) ? plan.requirements : []) if (typeof r?.id === "string" && typeof r.text === "string") requirements.set(r.id, r.text);
  return { issues, requirements };
}
/**
 * 問い 1 つに台本を当てる（README §5.6.2）。鍵は問いの文・選択肢の文・閉じる事項の文・目録の事項が指す要件の文（確定した仕様から）を連結した文に当てる。
 * 全部の鍵が当たり観点が食い違わない件が 1 つのとき、choose が全部当たる選択肢がちょうど 1 つならその選択肢（recommended: true なら推奨）。
 * 0 件なら unknown（不明）、2 件以上・選択肢が決まらないなら unresolved（決められない）。actual は工場が実際に採った選択肢 ID（無ければ null）
 */
export function applyScript(script, question, actual, texts = planTexts(null)) {
  const { facets, requirementIds } = questionFacets(question);
  const ids = [question.open_issue_id, ...(Array.isArray(question.also_closes) ? question.also_closes : [])];
  const choices = Array.isArray(question.choices) ? question.choices.filter((c) => isObj(c) && typeof c.id === "string") : [];
  const hay = [question.text, ...choices.map((c) => c.text), ...ids.map((id) => texts.issues.get(id)), ...requirementIds.map((id) => texts.requirements.get(id))].filter((t) => typeof t === "string").join("\n");
  const base = { question_id: question.id ?? null, open_issue_id: question.open_issue_id ?? null, facets, actual_choice_id: actual };
  const entries = Array.isArray(script?.entries) ? script.entries : [];
  const hit = entries.filter((e) => e.keys.every((k) => new RegExp(k).test(hay)) && (e.facet === null || facets.length === 0 || facets.includes(e.facet)));
  if (hit.length === 0) return { ...base, status: "unknown", reason: null, entry_id: null, choice_id: null, agrees: null };
  if (hit.length > 1) return { ...base, status: "unresolved", reason: "entries", entry_id: hit.map((e) => e.id), choice_id: null, agrees: null };
  const [entry] = hit;
  let choiceId = null;
  if (entry.answer.recommended === true) choiceId = typeof question.recommended?.choice_id === "string" ? question.recommended.choice_id : null;
  else {
    const matched = choices.filter((c) => typeof c.text === "string" && entry.answer.choose.every((k) => new RegExp(k).test(c.text)));
    if (matched.length !== 1) return { ...base, status: "unresolved", reason: matched.length === 0 ? "no-choice" : "many-choices", entry_id: entry.id, choice_id: null, agrees: null };
    choiceId = matched[0].id;
  }
  if (choiceId === null) return { ...base, status: "unresolved", reason: "no-choice", entry_id: entry.id, choice_id: null, agrees: null };
  return { ...base, status: "scripted", reason: null, entry_id: entry.id, choice_id: choiceId, agrees: actual === null ? null : choiceId === actual };
}
/**
 * 本 1 つの台本の照合（README §5.6.4 の rows[].script）。往復の記録（plan-record.json）の全部の問いに当てる。工場の答えは記録の answers
 * （全部推奨で閉じた往復は推奨）から取る。記録の無い本は対象外（none）。台本の無い題材は全部の問いが不明
 */
export function scriptSummary(scriptEntry, pr, plan) {
  const file = scriptEntry?.rel ?? null;
  const empty = { file, questions: 0, scripted: 0, agreed: 0, disagreed: 0, unknown: 0, unresolved: 0, details: [] };
  if (pr === null) return { ...empty, status: "none" };
  const texts = planTexts(plan);
  const details = [];
  for (const round of Array.isArray(pr.rounds) ? pr.rounds : []) {
    const answers = Array.isArray(round?.answers) ? round.answers : [];
    for (const q of Array.isArray(round?.questions) ? round.questions : []) {
      if (!isObj(q)) continue;
      const a = answers.find((x) => isObj(x) && x.question_id === q.id);
      const actual = round.all_recommended === true ? (typeof q.recommended?.choice_id === "string" ? q.recommended.choice_id : null) : typeof a?.choice_id === "string" ? a.choice_id : null;
      details.push(applyScript(scriptEntry?.script ?? null, q, actual, texts));
    }
  }
  const count = (f) => details.filter(f).length;
  const summary = { ...empty, questions: details.length, scripted: count((d) => d.status === "scripted"), agreed: count((d) => d.agrees === true), disagreed: count((d) => d.agrees === false), unknown: count((d) => d.status === "unknown"), unresolved: count((d) => d.status === "unresolved"), details };
  const status = details.length === 0 ? "no-questions" : summary.disagreed > 0 ? "disagreed" : details.every((d) => d.agrees === true) ? "ok" : "unanswered";
  return { ...summary, status };
}

// ── 了承後の採点（#426。README §5.5）
/** 確定した仕様の契約の版（appspec-schema の PLAN_SPEC_SCHEMA_VERSION と同じ値。契約の版を上げたら、ここも上げる） */
export const PLAN_SPEC_SCHEMA = "musunest.plan-spec/v1";
/** 了承の記録の読みの状態（confirmed ＝ 読めて契約の検査を通った、invalid ＝ あるが読めない・形が違う・検査に落ちる、absent ＝ 無い、none ＝ Plan を通していない本＝対象外） */
export const ACCEPTANCE_STATUSES = ["confirmed", "invalid", "absent", "none"];
/** 記録の無い本（absent）の理由：Plan が確定しなかった／Plan は確定したが納品物に仕様が無い（Build の段階は断定しない）／Plan の結果も不明 */
export const ABSENT_REASONS = ["plan_not_confirmed", "confirmed_without_plan", "unknown"];
/** 往復の記録の outcome の既知の値（工場の PlanResult の kind） */
const PLAN_OUTCOMES = ["confirmed", "stopped", "cannot-confirm"];
/** 処分 1 つの判定（README §5.5.2）。判定不能 ＝ unmatched（何にも当たらない）・ambiguous（部分が 2 つ以上に当たる）。未評価 ＝ unevaluated（書ける要件の変更。変更後を判定する手段が無い） */
export const JUDGEMENTS = ["expected", "allowed", "wrong", "unevaluated", "unmatched", "ambiguous"];
const UNDECIDED = ["unmatched", "ambiguous"];
/** 了承後の最終の判定のうち、この道具が足した値（変更後を判定する手段が無い本。PASS にしない） */
export const VERDICT_UNEVALUATED = "UNEVALUATED";
/**
 * 誤った了承の指標の状態。変更後・代替・追加の要件を判定する対応データ（別の Issue）が無い間は未評価で、証拠（他の構造の書けない要件に当たった変更）と
 * 判定不能・未評価の件数を添える。0 件に丸めない。対応データが入ったら、ここを evaluated に変える
 */
export const WRONG_ACCEPTANCE_EVALUATION = { status: "unevaluated", label: "未評価：変更後の要件を判定する対応データが無い。evidence ＝ 他の構造の書けない要件に当たった変更、unmatched・ambiguous ＝ 照合できない・複数候補、unevaluated ＝ 書ける要件に当たった変更" };
const EVALUATION_STATUSES = ["unevaluated", "evaluated"];
/**
 * 了承後の有効な要件のうち、判定の手段が無いもの（未検証）の出どころ（README §5.5.3）：
 * accepted_unwritable ＝ 了承して除いた記録の代替先（accepted_unwritable[].alternative_id が指す要件）、part ＝ 部分の代替先（parts[].alternative_id が指す要件）、
 * changed ＝ 変更後の要件（changed の要件そのもの）、added ＝ 追加の要件（added の要件そのもの）。今の工場は accepted_unwritable と added を作る
 */
export const UNVERIFIED_SOURCES = ["accepted_unwritable", "part", "changed", "added"];
/** plan.json の形（この道具が読む欄だけ）を検証する。落ちた理由の一覧（空なら読める）。理由に入力の値は含めない */
export function validatePlanShape(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return ["plan.json が写像でない"];
  const reasons = [];
  if (plan.schema_version !== PLAN_SPEC_SCHEMA) reasons.push("schema_version が未知");
  for (const k of ["requirements", "accepted_unwritable", "decisions"]) if (!Array.isArray(plan[k])) reasons.push(`${k} が配列でない`);
  if (Array.isArray(plan.requirements) && !plan.requirements.every((r) => r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.text === "string" && Array.isArray(r.parts))) reasons.push("requirements の形が違う（id・text・parts）");
  return reasons;
}
/**
 * 了承の記録（bundle/artifacts/plan.json）を読む：無ければ absent、読めない・形が違えば invalid と理由、
 * 契約の検査（check ＝ appspec-schema の checkConfirmedPlan。形・参照・了承の範囲・未解決・確認の失効）に落ちれば invalid と理由（検査のコードと欄の場所。値は書かない）、
 * 通れば confirmed
 */
export async function loadPlan(dir, check = null) {
  const path = join(dir, "bundle/artifacts/plan.json");
  if (!existsSync(path)) return { status: "absent", plan: null, reasons: [] };
  let plan;
  try { plan = readJson(path); } catch { return { status: "invalid", plan: null, reasons: ["plan.json を読めない"] }; }
  const reasons = validatePlanShape(plan);
  if (reasons.length > 0) return { status: "invalid", plan: null, reasons };
  const problems = check === null ? [] : await check(plan);
  if (problems.length > 0) return { status: "invalid", plan: null, reasons: [...new Set(problems.map((p) => `契約の検査: ${p.code} (${p.path})`))] };
  return { status: "confirmed", plan, reasons: [] };
}
const compileKeys = (keys) => (Array.isArray(keys) ? keys : []).map((k) => new RegExp(k));
const hits = (res, text) => res.some((re) => re.test(text));
/**
 * 原文の要件との対応（README §5.5.2）。score-claims.mjs と同じ照合（定義の keys を正規表現として読み、文に当てる）。
 * 当たる先は：当てはまった構造（無ければ主の構造）の書けない要件（unwritable）／許される申告（allowed）／
 * 書ける要件（check。checks[].keys。v5 の定義には無い）／他の構造の書けない要件（other_unwritable。当てはまった構造では書ける、の目印）。
 * match は当たった先を**全部**返す（先頭の 1 件で決めない）
 */
export function acceptanceMatcher(def, structureId, allowedClaims = []) {
  const st = def.structures.find((x) => x.id === structureId) ?? def.structures[0];
  const table = (kind, list) => list.map((u) => ({ kind, id: u.id, res: compileKeys(u.keys) }));
  const candidates = [
    ...table("unwritable", st.unwritable ?? []),
    ...table("allowed", [...allowedClaims, ...(def.allowedClaims ?? [])]),
    ...table("check", (st.checks ?? []).filter((c) => Array.isArray(c.keys) && c.keys.length > 0).map((c) => ({ id: c.req, keys: c.keys }))),
    ...table("other_unwritable", def.structures.filter((x) => x.id !== st.id).flatMap((x) => (x.unwritable ?? []).map((u) => ({ id: `${x.id}:${u.id}`, keys: u.keys })))),
  ];
  const match = (text) => {
    const seen = new Set(), out = [];
    for (const c of candidates) {
      if (!hits(c.res, text) || seen.has(`${c.kind}\0${c.id}`)) continue;
      seen.add(`${c.kind}\0${c.id}`);
      out.push({ kind: c.kind, id: c.id });
    }
    return out;
  };
  return { structure: st.id, match };
}
/**
 * 処分 1 つの判定（README §5.5.2 の表）。targets ＝ 当たった先の全部、scope ＝ part（部分の文だけ）か requirement（要件全体。含まれる対象を全部点検する）、
 * op ＝ exclusion（除外）か change（変更）。何にも当たらなければ unmatched、部分が 2 つ以上に当たれば ambiguous（どちらも判定不能。免除にも誤りにも使わない）。
 * 他の構造の書けない要件 ＝ wrong。書ける要件 ＝ 除外なら wrong、変更なら unevaluated（変更後を判定する手段が無い）。書けない要件 ＝ expected。許される申告だけ ＝ allowed
 */
export function judgeDisposition(targets, scope, op) {
  if (targets.length === 0) return "unmatched";
  if (scope === "part" && targets.length > 1) return "ambiguous";
  const kinds = new Set(targets.map((t) => t.kind));
  if (kinds.has("other_unwritable")) return "wrong";
  if (kinds.has("check")) return op === "exclusion" ? "wrong" : "unevaluated";
  if (kinds.has("unwritable")) return "expected";
  return "allowed";
}
/**
 * 確定した仕様の了承の記録を、定義の鍵で読む（README §5.5.2〜§5.5.3）。
 * 除外 ＝ accepted_removal の部分・removed の要件（作らない、と了承した）。変更 ＝ alternative の部分・changed の要件（別の形で作る、と了承した）。added の要件は数えるだけ。
 * 照合する文は、部分ならその部分の文だけ（親の全文・変更後・代わりの案の文は使わない）。要件全体なら元の要件（from_requirement_id）の文（changed の元が自分自身なら元の文が無い）。
 * 判定不能・未評価は件数と状態で出し、誤った除外も未評価の判定も了承後の分母から外さない。
 * 処分の照合とは別に、了承後の有効な要件の評価の状態（effective）を持つ：照合が expected なのは「処分の対象が書けない要件に当たった」という判断で、
 * 代替先・変更後・追加の要件を Build が満たしたことの判定ではない。判定の手段が無いそれらの要件は未検証（effective.unverified）として数える
 */
export function readAcceptance(plan, matcher) {
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const changes = { added: 0, changed: 0, removed: 0 };
  const exclusions = [], changed = [];
  const entry = (id, kind, scope, text, op) => { const targets = matcher.match(text); return { id, kind, scope, matched: targets, judged: judgeDisposition(targets, scope, op) }; };
  const partIds = new Set();
  // 未検証の有効な要件（要件 ID ごとに 1 件。出どころは全部残す）。指す先が requirements に無くても数える（契約の検査が落とすので確定した本には現れない）
  const unverified = new Map();
  const note = (id, via) => { if (typeof id !== "string") return; const u = unverified.get(id) ?? { id, via: [] }; if (!u.via.includes(via)) u.via.push(via); unverified.set(id, u); };
  for (const r of plan.requirements) {
    const kind = r.change?.kind;
    if (typeof kind === "string" && kind in changes) changes[kind] += 1;
    const from = r.change?.from_requirement_id;
    const original = typeof from !== "string" ? "" : kind === "changed" && from === r.id ? "" : byId.get(from)?.text ?? "";
    if (kind === "removed") exclusions.push(entry(r.id, "removed", "requirement", original, "exclusion"));
    else if (kind === "changed") { changed.push(entry(r.id, "changed", "requirement", original, "change")); note(r.id, "changed"); }
    else if (kind === "added") note(r.id, "added");
    for (const part of r.parts) {
      if (part === null || typeof part !== "object") continue;
      partIds.add(part.id);
      if (part.disposition === "met") continue;
      note(part.alternative_id, "part");
      const text = typeof part.text === "string" ? part.text : "";
      if (part.disposition === "alternative") changed.push(entry(part.id, "alternative", "part", text, "change"));
      else exclusions.push(entry(part.id, typeof part.disposition === "string" ? part.disposition : "unknown", "part", text, "exclusion"));
    }
  }
  // 部分の無い accepted_unwritable の記録（契約の検査が落とすので確定した本には現れない）は、照合できない除外として誤った除外に数える
  for (const a of plan.accepted_unwritable) {
    if (!partIds.has(a?.part_id)) exclusions.push({ id: typeof a?.part_id === "string" ? a.part_id : null, kind: "accepted_unwritable", scope: "record", matched: [], judged: "wrong" });
    note(a?.alternative_id, "accepted_unwritable");
  }
  const all = [...exclusions, ...changed];
  const countBy = (xs) => Object.fromEntries(JUDGEMENTS.map((j) => [j, xs.filter((x) => x.judged === j).length]));
  const targetsOf = (xs, kind) => [...new Set(xs.flatMap((x) => x.matched.filter((t) => t.kind === kind).map((t) => t.id)))];
  const unverifiedList = [...unverified.values()];
  return {
    changes, decisions: plan.decisions.length, exclusions, changed,
    counts: { exclusions: countBy(exclusions), changes: countBy(changed) },
    accepted_unwritable_ids: targetsOf(all.filter((x) => x.judged === "expected"), "unwritable"),
    // 変更が当てた書ける要件の判定（判定のいかんにかかわらず、変更後は判定できない）
    unevaluated_checks: targetsOf(changed, "check"),
    allowed: all.filter((x) => x.judged === "allowed").length,
    // 了承後の有効な要件の評価の状態（README §5.5.3）：未検証の要件が 1 つでもあれば unevaluated（その本は PASS にしない）。counts は出どころごとの要件の数（total は要件 ID で数える）
    effective: {
      status: unverifiedList.length === 0 ? "evaluated" : "unevaluated",
      unverified: unverifiedList,
      counts: { total: unverifiedList.length, ...Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, unverifiedList.filter((u) => u.via.includes(s)).length])) },
    },
  };
}
/** 変更のうち、了承後の判定を PASS にできないもの（expected・allowed 以外）の数 */
export const unjudgedChanges = (a) => JUDGEMENTS.filter((j) => j !== "expected" && j !== "allowed").reduce((n, j) => n + a.counts.changes[j], 0);
/** 変更のうち判定不能（unmatched・ambiguous）の数 */
export const undecidedChanges = (a) => UNDECIDED.reduce((n, j) => n + a.counts.changes[j], 0);
/** 除外のうち判定不能（unmatched・ambiguous）の数 */
export const undecidedExclusions = (a) => UNDECIDED.reduce((n, j) => n + a.counts.exclusions[j], 0);
/**
 * 了承後の申告の採点：score-claims.mjs と同じ照合で、期待の書けない要件ごとに「申告あり（correct）／任意（optional）／了承済みで申告なし（accepted）／挙げ漏れ（missed）」に分ける。
 * 誤った申告は原文系の claims.false_claims と同じ（数だけ受け取り、verdict に使う）
 */
export function claimsAfterAcceptance(def, structureId, claimsList, written, acceptedIds, falseClaims = 0) {
  const st = def.structures.find((x) => x.id === structureId) ?? def.structures[0];
  const claims = claimsList.map((u) => `${u.requirement} ${u.reason}`);
  const result = { structure: st.id, expected: st.unwritable.map((u) => u.id), correct: 0, accepted: 0, optional: 0, missed: 0 };
  for (const u of st.unwritable) {
    const res = compileKeys(u.keys);
    const claimed = claims.some((c) => hits(res, c));
    if (u.optionalIfWritten && written?.[u.optionalIfWritten]) result.optional += claimed ? 1 : 0;
    else if (claimed) result.correct += 1;
    else if (acceptedIds.includes(u.id)) result.accepted += 1;
    else result.missed += 1;
  }
  result.verdict = result.missed === 0 && falseClaims === 0 ? "OK" : "NG";
  return result;
}
/**
 * 了承後の充足：分母・分子は原文の判定のまま（v2 と同じ。了承で変わった判定も誤った除外も外さない。落ちた判定を変更扱いにしても率は上がらない）。
 * 変更が当てた判定（unevaluated）は名前を添えるだけ。構造が当てはまらない本は呼ばない（充足 0・定義の判定の数）
 */
export function fulfillmentAfterAcceptance(r, unevaluatedChecks) {
  return { fulfilled: r.fulfilled ?? 0, total: r.writable_total ?? 0, total_from: `structure:${r.structure}`, unevaluated: unevaluatedChecks.filter((k) => k in r.checks) };
}
/**
 * 了承後の最終の判定（README §5.5.4）：静的 NG はそのまま。変更に expected・allowed 以外があるか、未検証の有効な要件（代替先・変更後・追加）が 1 つでもあれば
 * 原則 UNEVALUATED（PASS にしない。照合が expected・allowed でも同じ）。ただし変更が当てた判定が分かっていて（wrong・判定不能の変更が無い）、
 * 未評価の判定の外に落ちがあるか挙げ漏れがあれば FAIL（落ちは隠さない）。残りは finalVerdict を了承後の申告で取る
 */
export function verdictAfterAcceptance(r, acceptance, claimsAccepted, finalVerdict) {
  if (r.verdict === "STATIC_NG") return r.verdict;
  if (unjudgedChanges(acceptance) === 0 && acceptance.effective.counts.total === 0) return finalVerdict(r, claimsAccepted);
  const known = acceptance.counts.changes.wrong + undecidedChanges(acceptance) === 0;
  const failedOutside = Object.entries(r.checks).some(([k, ok]) => !ok && !acceptance.unevaluated_checks.includes(k));
  return known && (failedOutside || (claimsAccepted !== null && claimsAccepted.missed > 0)) ? "FAIL" : VERDICT_UNEVALUATED;
}

// ── 採点と集計
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n}（${n ? pct(k / n) : "-"}・95% 区間 ${pct(lo)}〜${pct(hi)}）`; };
const sum = (xs, f) => xs.reduce((s, r) => s + f(r), 0);
const pass = (r) => !r.generation_failed && r.verdict === "PASS";
const relReal = (from, to) => { try { return relative(realpathSync(from), realpathSync(to)); } catch { return relative(from, to); } };

// ── Plan の表と Build の表（#493）：診断の出力（plan-record.json・summary.line.json）を Plan と Build に分けて並べる。
// 正式な採点の定義・分母・PASS の判定は変えない（Build の表の PASS は既存の行の verdict をそのまま読む）。値（原文・引用・応答の全体）は入れない：
// 入れるのは結果の既知の値・分類のコード（既知の一覧の値だけ。それ以外は unknown。#498 で文字の形から一覧に変えた）・数・時間・費用だけ
/** Plan の表の結果の値。absent ＝ 往復の記録（plan-record.json）が無い本、unknown ＝ 記録はあるが結果が既知の値でない */
export const PLAN_TABLE_OUTCOMES = ["confirmed", "cannot-confirm", "stopped", "unknown", "absent"];
// 分類の既知の一覧（#498。工場の値を写して採点の道具に固定して持つ。ここに無い値は unknown に写す。工場が値を足せば、ここに足すまで unknown）
/** Plan の段（packages/factory の PLAN_STAGE_IDS） */
export const PLAN_STAGE_IDS = ["requirements", "catalog", "surface", "surface-check", "questions", "answers", "confirm"];
/** v1.1α の段（#505 が packages/factory の record.ts の STAGE_IDS の末尾に足す 7 つ。A1 の順） */
/** 旗 v12.ids の走りだけが記録に出す段（C1 の vocabulary・C2 の mapping。#589 で足し、#593 で工場の STAGE_IDS に入った）。出力の行は記録にこの段があるときだけ足す */
export const IDS_STAGE_IDS = ["vocabulary", "mapping"];
export const V11A_STAGE_IDS = ["name-table", "semantic-check", "test-spec", "name-check", "decl-check", "coverage", "carry-over", ...IDS_STAGE_IDS];
/** 生成の段（packages/factory の record.ts の STAGE_IDS。v1 の 12 段のあとに v1.1α の 7 段。run-agent.mjs はこの一覧を import する） */
export const BUILD_STAGE_IDS = ["requirements", "reverse-check", "design", "test-suite", "write", "static-check", "correspondence", "run-tests", "repair", "arbitration", "judge", "bundle", ...V11A_STAGE_IDS];
const STAGE_ID_LIST = [...new Set([...PLAN_STAGE_IDS, ...BUILD_STAGE_IDS])];
/** 要約の段の記録のどれかに新しい段（IDS_STAGE_IDS）があるか。出力する行の集合は、あるときだけ新しい段を足す（無い記録の出力を変えない） */
const hasPendingStage = (summaries) => summaries.some((s) => isObj(s) && Array.isArray(s.stages) && s.stages.some((st) => isObj(st) && IDS_STAGE_IDS.includes(st.stage)));
const rowStageIds = (withPending) => BUILD_STAGE_IDS.filter((id) => withPending || !IDS_STAGE_IDS.includes(id));
/** 失敗の種類（packages/factory の record.ts の FAILURE_KINDS） */
export const FAILURE_KINDS = ["limit", "deadline", "budget", "call-limit", "timeout", "network", "http", "balance", "malformed", "refused", "tool-arguments", "invalid-request", "unmet", "incomplete", "unknown"];
/** 確定できない理由の出どころ（packages/factory の CANNOT_CONFIRM_SOURCES） */
export const CANNOT_CONFIRM_SOURCES = ["confirm", "plan-check", "reverse-check", "surface-check", "session"];
/** 確定できない理由・段の失敗の問題の符号（packages/factory の PLAN_DIAGNOSIS_CODES） */
export const PLAN_DIAGNOSIS_CODES = [
  "shape", "quote-not-found", "position-mismatch", "uncovered-source", "constraint-id-missing", "constraint-id-unknown", "requirement-id-unknown", "issue-id-reused",
  "not-stated", "low-confidence", "unknown", "question-count", "choices-count", "recommendation", "free-text", "issue-mapping", "duplicate-issue", "duplicate-question-id",
  "also-closes", "source-closure", "source-closure-quote", "source-closure-quote-whitespace", "question-coverage", "unknown-question", "unknown-choice", "stale-revision",
  "free-text-length", "uncovered-answer", "origin-not-answer", "unknown_reference", "accepted_outside_parts", "accepted_not_removal", "resolution_without_basis", "open_issue",
  "open_critical", "confirmation_expired", "invalid_json_schema", "invalid_request_error", "max_output_tokens", "content_filter", "limit-request-text", "limit-declaration-bytes",
  "limit-call-count", "limit-tool-calls", "limit-plan-questions", "limit-plan-round-trips", "limit-other", "question-limit", "round-trip-limit", "critical-no-question",
  "duplicate-open-issue", "noncritical-without-default", "other",
];
const knownOr = (list, x) => (typeof x === "string" && list.includes(x) ? x : "unknown");
/** 段の ID（Plan の段と生成の段の和）を既知の値か unknown に写す */
const stageIdOf = (x) => knownOr(STAGE_ID_LIST, x);
/** 工場の verdict を既知の値か unknown に写す（null・undefined はそのまま） */
const verdictOf = (x) => (x === null || x === undefined ? x : knownOr(FACTORY_VERDICTS, x));
const nonNegative = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
const usdOf = (...xs) => { for (const x of xs) if (Number.isFinite(x)) return x; return 0; };
/** 段の記録（stages[]）の時間を段ごとに足す。同じ段が往復で繰り返すときは回数と合計の時間（ms）。段の ID は既知の値だけ通す（#498） */
export function stageTimes(stages) {
  const by = {};
  let total = 0;
  for (const st of Array.isArray(stages) ? stages : []) {
    const id = stageIdOf(st?.stage), ms = nonNegative(st?.duration_ms);
    by[id] = { count: (by[id]?.count ?? 0) + 1, ms: (by[id]?.ms ?? 0) + ms };
    total += ms;
  }
  return { by_stage: by, total_ms: total };
}
const mergeStages = (xs) => {
  const by = {};
  for (const x of xs) for (const [id, v] of Object.entries(x.by_stage)) by[id] = { count: (by[id]?.count ?? 0) + v.count, ms: (by[id]?.ms ?? 0) + v.ms };
  return { by_stage: by, total_ms: sum(xs, (x) => x.total_ms) };
};
/**
 * 止まり方の分類：cannot-confirm は理由の source:code（重複を除き並べる）、stopped は失敗の段:種類（失敗の無い停止は declined）。
 * それぞれの部分は既知の一覧（出どころ・符号・Plan の段・失敗の種類）に写し、知らない値は unknown（#498）
 */
const cannotConfirmClass = (r) => `${knownOr(CANNOT_CONFIRM_SOURCES, r?.source)}:${knownOr(PLAN_DIAGNOSIS_CODES, r?.code)}`;
const failureClass = (f) => `${knownOr(PLAN_STAGE_IDS, f?.stage)}:${knownOr(FAILURE_KINDS, f?.kind)}`;
function planStop(outcome, pr) {
  if (outcome === "cannot-confirm") {
    const reasons = Array.isArray(pr.cannot_confirm) ? pr.cannot_confirm : [];
    return { kind: outcome, classes: [...new Set(reasons.map(cannotConfirmClass))].sort(), reasons: reasons.length };
  }
  if (outcome === "stopped") {
    const f = pr.failure ?? null;
    return { kind: outcome, classes: [f === null ? "declined" : failureClass(f)], reasons: 1 };
  }
  if (outcome === "unknown") return { kind: outcome, classes: [], reasons: 0 };
  return null;
}
/** Plan の表の 1 行。費用は起動の記録の plan_cost.plan_usd（無ければ往復の記録の spent_usd） */
export function planTableRow(run, pr, sl) {
  if (pr === null || pr === undefined) return { run, outcome: "absent", confirmed: false, stop: null, questions: null, rounds: null, stages: null, usd: usdOf(sl?.plan_cost?.plan_usd) };
  const outcome = PLAN_OUTCOMES.includes(pr.outcome) ? pr.outcome : "unknown";
  const rounds = Array.isArray(pr.rounds) ? pr.rounds : [];
  return {
    run, outcome, confirmed: outcome === "confirmed", stop: planStop(outcome, pr),
    questions: sum(rounds, (round) => (Array.isArray(round?.questions) ? round.questions.length : 0)), rounds: rounds.length,
    stages: stageTimes(pr.stages), usd: usdOf(sl?.plan_cost?.plan_usd, pr.spent_usd),
  };
}
/** Build の表の 1 行（Plan が確定した本だけ）。verdict・pass は既存の採点の行のまま。費用は plan_cost.build_usd（無ければ要約の provider_cost_usd） */
export function buildTableRow(run, sl, row) {
  const s = sl?.summary ?? null;
  return { run, factory_verdict: verdictOf(s?.verdict ?? null), verdict: row?.verdict ?? (row?.generation_failed ? "GEN_FAIL" : null), pass: row ? pass(row) : false, stages: stageTimes(s?.stages), usd: usdOf(sl?.plan_cost?.build_usd, s?.provider_cost_usd) };
}
const usdTotal = (xs) => sum(xs, (x) => x.usd).toFixed(4);
/**
 * entries ＝ [{ run, pr（往復の記録か null）, sl（起動の記録か null）, row（既存の採点の行か null） }]。Plan の表は全本、Build の表は Plan が確定した本だけ。
 * opts.mode（#498）：plan-only なら Build の表は 0 本（Plan 評価）。build-from なら Build の表は opts.buildEntries（予定した本の全部。未実行の本も含む）で、
 * Plan の記録が無いことを理由に外さない（分母の文に組が外した P の数 opts.frozenMissing を添える）。それ以外（build・e2e・null）は今と同じ
 */
export function planBuildTables(entries, { mode = null, buildEntries = null, frozenMissing = null } = {}) {
  const plan = entries.map((e) => planTableRow(e.run, e.pr ?? null, e.sl ?? null));
  const recorded = plan.filter((r) => r.outcome !== "absent");
  const stopClasses = {};
  for (const r of plan) for (const c of r.stop?.classes ?? []) stopClasses[c] = (stopClasses[c] ?? 0) + 1;
  const planTotal = {
    runs: plan.length, outcomes: Object.fromEntries(PLAN_TABLE_OUTCOMES.map((k) => [k, plan.filter((r) => r.outcome === k).length])),
    // 確定の率の分母は往復の記録のある本（記録の無い本は outcomes.absent に数える）
    confirmed: fmt(recorded.filter((r) => r.confirmed).length, recorded.length), stop_classes: stopClasses,
    questions: sum(recorded, (r) => r.questions), rounds: sum(recorded, (r) => r.rounds), stages: mergeStages(recorded.map((r) => r.stages)), usd: usdTotal(plan),
  };
  const confirmedRuns = new Set(plan.filter((r) => r.confirmed).map((r) => r.run));
  const buildSource = mode === "plan-only" ? [] : mode === "build-from" ? (buildEntries ?? entries) : entries.filter((e) => confirmedRuns.has(e.run));
  const build = buildSource.map((e) => buildTableRow(e.run, e.sl ?? null, e.row ?? null));
  const verdicts = {};
  for (const r of build) { const k = r.factory_verdict ?? "none"; verdicts[k] = (verdicts[k] ?? 0) + 1; }
  const excluded = mode === "plan-only" || mode === "build-from" ? [] : plan.filter((r) => !r.confirmed);
  const denominator = mode === "plan-only" ? `Plan 評価（plan-only）：Build を流さない計測なので Build の表は 0 本（全 ${plan.length} 本は Plan の表で読む）`
    : mode === "build-from" ? `凍結した組の本 ${build.length} 本（予定した本の全部。Plan の記録の有無で外さない。組が外した P ${Number.isInteger(frozenMissing) ? frozenMissing : "-"} 個は含まない）`
    : `Plan が確定した本 ${build.length} 本（全 ${plan.length} 本から ${excluded.length} 本を外した）`;
  const buildTotal = {
    runs: build.length,
    // 分母から外した本（Plan が確定しなかった本と記録の無い本）の数と結果の内訳
    excluded: excluded.length, excluded_outcomes: Object.fromEntries(PLAN_TABLE_OUTCOMES.filter((k) => k !== "confirmed").map((k) => [k, excluded.filter((r) => r.outcome === k).length])),
    denominator,
    factory_verdicts: verdicts, pass: fmt(build.filter((r) => r.pass).length, build.length), stages: mergeStages(build.map((r) => r.stages)), usd: usdTotal(build),
  };
  return { plan: { rows: plan, total: planTotal }, build: { rows: build, total: buildTotal } };
}

// ── 評価の種類・Plan の集計・Build だけの集計（#498。README §5.2・§5.3）
// 分母は予定した本（条件の child_args）の全部。未実行・途中・記録の欠けた本も分母に残し、成功にも除外にも数えない。
// 時間と費用は { observed, missing, total, median }。分類は既知の列挙へ写し、知らない値は unknown。値（依頼文・引用・応答・答え・自由入力の文・仕様の本体・
// 契約の検査の message）は入れない
/** 評価の種類（v4 の params.mode。v1〜v3 は params.plan から e2e か build） */
export const EVALUATION_MODES = ["build", "e2e", "plan-only", "build-from", "stage-run"];
const CONDITIONS_V4 = CONDITIONS_SCHEMAS[3];
/** 条件の版 v5（#513）。params.mode の読み方は v4 と同じで、params.pipeline を足した */
export const CONDITIONS_V5 = CONDITIONS_SCHEMAS[4];
/** params.mode と frozen を持つ版（v4・v5 と、段単位の走りの v6。#545。経路 v1.2 の v7。#557） */
const hasMode = (schema) => schema === CONDITIONS_V4 || schema === CONDITIONS_V5 || schema === CONDITIONS_V6 || schema === CONDITIONS_V7;
/** 台本の当て方（post-hoc ＝ 採点で事後に当てる。live ＝ 実行中に当てた。v4 の scripts.mode） */
export const SCRIPT_MODES = [SCRIPT_MODE, "live"];
/** 実行中の台本の照合の状態（packages/factory の SCRIPT_MATCH_STATES）。それ以外は unknown-state */
export const SCRIPT_MATCH_STATES = ["answered", "unknown", "duplicate", "no-choice", "stale-revision"];
/** Plan だけの結果の包みの版（packages/factory の PLAN_ONLY_RESULT_SCHEMA）と、採点の道具が包みに当てる検査の符号 */
export const PLAN_ONLY_RESULT_SCHEMA = "musunest-factory/plan-only-result/v1";
export const ENVELOPE_REASONS = ["envelope-version", "outcome-mismatch", "plan-sha256", "source-sha256", "contract"];
/** 起動の記録の終了の分類（run-agent.mjs の EXIT_CLASSES）。それ以外は unknown */
export const EXIT_CLASSES = ["ok", "failed", "return-to-plan", "envelope-unreadable", "envelope-rejected", "usage-other", "other"];
// 工場の --plan-file の標準出力の行の版と検査の名前（packages/factory の cli-plan.ts・freeze-plan-set.mjs と同じ値。freeze-plan-set.mjs はこのファイルを import するので写して持つ）
const PLAN_FILE_ERROR_SCHEMA = "musunest-factory/plan-file-error/v1";
const PLAN_FILE_REJECT_SCHEMA = "musunest-factory/plan-file-reject/v1";
const PLAN_FILE_CHECKS = ["envelope-version", "outcome", "plan", "plan-sha256", "source-sha256", "vocabulary"];
/** 工場の Build だけの記録（--out の build-record.json）と Plan だけの結果（plan-result.json）の、本のディレクトリからの場所 */
export const BUILD_RECORD_PATH = "bundle/build-record.json";
export const PLAN_RESULT_PATH = "bundle/plan-result.json";
const HEX64_RE = /^[0-9a-f]{64}$/;
/** 文字列で、しかも 64 桁の小文字の 16 進か（正規表現に文字列でない値を渡して型を変換させない。#498 の独立レビューの指摘 3） */
const isHex64 = (x) => typeof x === "string" && HEX64_RE.test(x);

/**
 * 評価の種類：v4・v5 なら params.mode（既知の値か unknown）、v1〜v3 なら params.plan が真で e2e・偽で build、条件が無ければ null。build_applicable は plan-only のときだけ偽。
 * pipeline（#513）：v5 なら params.pipeline（既知の値か unknown）。v1〜v4・条件なしでは null だが、出力の既存の欄を変えないため列挙しない欄にする
 * （score.json と匿名の口の evaluation に出るのは v5 のときだけ）
 */
export function evaluationOf(cond) {
  const mode = !isObj(cond) ? null : hasMode(cond.schema) ? knownOr(EVALUATION_MODES, cond.params?.mode) : CONDITIONS_SCHEMAS.includes(cond.schema) ? (cond.params?.plan === true ? "e2e" : "build") : "unknown";
  // 段単位の走り（#545）は納品物を作らないので build_applicable は偽
  const out = { mode, build_applicable: mode !== "plan-only" && mode !== STAGE_RUN_MODE };
  if (isObj(cond) && (cond.schema === CONDITIONS_V5 || cond.schema === CONDITIONS_V6 || cond.schema === CONDITIONS_V7)) out.pipeline = knownOr(PIPELINES, cond.params?.pipeline);
  else Object.defineProperty(out, "pipeline", { value: null, enumerable: false });
  return out;
}
/** 条件の frozen の形の問題（missing ＝ 無い、invalid ＝ 形が違う、null ＝ 読める）。run-agent.mjs が書く形：path・sha256・adopted[]（pattern と 2 つの SHA）・missing[]（P の ID） */
export function frozenProblem(frozen) {
  if (frozen === null || frozen === undefined) return "missing";
  if (!isObj(frozen) || typeof frozen.path !== "string" || frozen.path === "" || !isHex64(frozen.sha256)) return "invalid";
  if (!Array.isArray(frozen.adopted) || frozen.adopted.length === 0 || !Array.isArray(frozen.missing)) return "invalid";
  const seen = new Set();
  for (const a of frozen.adopted) {
    if (!isObj(a) || typeof a.pattern !== "string" || !ITEM_ID.test(a.pattern) || seen.has(a.pattern) || !isHex64(a.plan_sha256) || !isHex64(a.source_sha256)) return "invalid";
    seen.add(a.pattern);
  }
  if (!frozen.missing.every((m) => typeof m === "string" && ITEM_ID.test(m) && !seen.has(m)) || new Set(frozen.missing).size !== frozen.missing.length) return "invalid";
  return null;
}
/** JSON のファイルを読む（無ければ absent、読めない・JSON でなければ unreadable。例外を外に出さない） */
const readJsonSafe = (path) => {
  if (!existsSync(path)) return { status: "absent", value: null };
  try { return { status: "ok", value: JSON.parse(readFileSync(path, "utf8")) }; } catch { return { status: "unreadable", value: null }; }
};
/** 標準出力の全文の JSON の行（写像の行だけ。読めなければ空） */
const jsonLines = (path) => { try { return readFileSync(path, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isObj); } catch { return []; } };
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
/** 時間と費用の集計：値を読めた本（実測の 0 を含む）の数・読めなかった本の数・合計・中央値（偶数本なら真ん中 2 つの平均）。読めた本が 0 なら合計と中央値は null */
export function stat4(values) {
  const xs = values.map(finite).filter((x) => x !== null).sort((a, b) => a - b);
  const observed = xs.length, missing = values.length - observed;
  if (observed === 0) return { observed, missing, total: null, median: null };
  const mid = Math.floor(observed / 2);
  return { observed, missing, total: round6(xs.reduce((s, x) => s + x, 0)), median: round6(observed % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2) };
}
/** 段の記録の時間の合計（ms）。配列でないか、有限で 0 以上でない値が 1 つでもあれば読めない（null）。空の配列は実測の 0 */
const stagesTotal = (stages) => (Array.isArray(stages) && stages.every((st) => isObj(st) && finite(st.duration_ms) !== null && st.duration_ms >= 0) ? stages.reduce((s, st) => s + st.duration_ms, 0) : null);
const mean = (total, n) => (n === 0 ? null : Math.round((total / n) * 1000) / 1000);
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

/**
 * Plan の集計（e2e・plan-only）。facts ＝ 予定した本ごとの [{ run, state（unexecuted・incomplete・executed）, pr（往復の記録か null）, prStatus, sl, envelope（plan-only のときだけ。{ status, reasons }） }]。
 * opts.live ＝ 実行中の台本（scripts.mode が live）、opts.planOnly ＝ 包みを検査した
 */
export function planMetrics(facts, { live = false, planOnly = false } = {}) {
  const n = facts.length;
  const executed = facts.filter((f) => f.state === "executed");
  const recorded = executed.filter((f) => f.prStatus === "ok");
  const outcomeOf = (f) => (!isObj(f.pr) ? "unknown" : PLAN_OUTCOMES.includes(f.pr.outcome) ? f.pr.outcome : "unknown");
  const outcomes = zeros(PLAN_TABLE_OUTCOMES);
  for (const f of recorded) outcomes[outcomeOf(f)] += 1;
  outcomes.absent = n - recorded.length;
  const unexecuted = facts.filter((f) => f.state === "unexecuted").length, incomplete = facts.filter((f) => f.state === "incomplete").length, unrecorded = executed.length - recorded.length;
  // 往復の記録はあるが JSON として読めない本（unrecorded の内数。自由入力では unreadable に数える）
  const recordUnreadableRuns = executed.filter((f) => f.prStatus === "unreadable").length;
  // 止まり方の分類ごとの本数（既知の分類だけ。ほかは unknown にまとめる）
  const stopClasses = {};
  const bump = (k) => { stopClasses[k] = (stopClasses[k] ?? 0) + 1; };
  for (const f of recorded) {
    const o = outcomeOf(f);
    if (o === "cannot-confirm") {
      const reasons = Array.isArray(f.pr.cannot_confirm) ? f.pr.cannot_confirm : [];
      const classes = new Set(reasons.map((r) => (CANNOT_CONFIRM_SOURCES.includes(r?.source) && PLAN_DIAGNOSIS_CODES.includes(r?.code) ? `${r.source}:${r.code}` : "unknown")));
      if (classes.size === 0) classes.add("unknown");
      for (const c of [...classes].sort()) bump(c);
    } else if (o === "stopped") {
      const fl = f.pr.failure ?? null;
      bump(fl === null ? "declined" : isObj(fl) && PLAN_STAGE_IDS.includes(fl.stage) && FAILURE_KINDS.includes(fl.kind) ? `${fl.stage}:${fl.kind}` : "unknown");
    }
  }
  // 問数と往復：往復の記録の rounds が配列の本だけを読めた本とし、平均の分母にする
  const roundsOk = recorded.filter((f) => isObj(f.pr) && Array.isArray(f.pr.rounds));
  const qOf = (f) => sum(f.pr.rounds, (r) => (isObj(r) && Array.isArray(r.questions) ? r.questions.length : 0));
  const qTotal = sum(roundsOk, qOf), rTotal = sum(roundsOk, (f) => f.pr.rounds.length);
  // 自由入力：rounds[].answers[].free_text が文字列の答えの数。記録の形（rounds と各往復の answers が配列）を読めない本は unreadable
  const freeOk = roundsOk.filter((f) => f.pr.rounds.every((r) => isObj(r) && Array.isArray(r.answers)));
  const freeAnswers = sum(freeOk, (f) => sum(f.pr.rounds, (r) => r.answers.filter((a) => isObj(a) && typeof a.free_text === "string").length));
  const prOf = (f) => (f.state === "executed" && f.prStatus === "ok" && isObj(f.pr) ? f.pr : null);
  const out = {
    runs: n, denominator: `予定した本 ${n} 本（未実行 ${unexecuted}・途中 ${incomplete}・記録なし ${unrecorded} を含む）`,
    unexecuted, incomplete, unrecorded, outcomes, confirmed: fmt(outcomes.confirmed, n), stop_classes: stopClasses,
    questions: { total: qTotal, mean: mean(qTotal, roundsOk.length), runs: roundsOk.length }, rounds: { total: rTotal, mean: mean(rTotal, roundsOk.length), runs: roundsOk.length },
    record_unreadable: recordUnreadableRuns,
    free_text: { answers: freeAnswers, runs: freeOk.length, unreadable: recorded.length - freeOk.length + recordUnreadableRuns },
    // 時間は往復の記録の stages[].duration_ms の合計、費用は起動の記録の Plan の額（無ければ往復の記録の使った額）
    duration_ms: stat4(facts.map((f) => { const pr = prOf(f); return pr === null ? null : stagesTotal(pr.stages); })),
    usd: stat4(facts.map((f) => (f.state !== "executed" ? null : finite(f.sl?.plan_cost?.plan_usd) ?? finite(prOf(f)?.spent_usd)))),
    script: null, envelope: null,
  };
  if (live) {
    // 実行中の台本：照合の状態ごとの件数。率は「問いが 1 つ以上あり、全部が answered の本」÷ 往復の記録のある本。0 問の本と照合の記録の欠けた本は別に数え、分子に入れない。
    // 照合の記録は問い（質問 ID と版）と 1 対 1 に対応させる（#498 の独立レビューの指摘 2）：問いの ID・版を読めない、照合の記録が足りない・余る・重なる本は unrecorded
    const states = zeros([...SCRIPT_MATCH_STATES, "unknown-state"]);
    let allAnswered = 0, noQuestions = 0, scriptUnrecorded = 0;
    const keyOf = (id, rev) => (typeof id === "string" && Number.isInteger(rev) ? `${id}\0${rev}` : null);
    for (const f of recorded) {
      const pr = isObj(f.pr) ? f.pr : {};
      if (Array.isArray(pr.rounds) && qOf(f) === 0) { noQuestions += 1; continue; }
      const matches = isObj(pr.script) && Array.isArray(pr.script.matches) ? pr.script.matches : null;
      if (matches === null) { scriptUnrecorded += 1; continue; }
      for (const m of matches) states[SCRIPT_MATCH_STATES.includes(m?.state) ? m.state : "unknown-state"] += 1;
      const questionKeys = Array.isArray(pr.rounds) ? pr.rounds.flatMap((r) => (isObj(r) && Array.isArray(r.questions) ? r.questions.map((q) => keyOf(q?.id, q?.revision)) : [null])) : [null];
      const matchKeys = matches.map((m) => keyOf(m?.question_id, m?.revision));
      const covered = !questionKeys.includes(null) && !matchKeys.includes(null) && new Set(questionKeys).size === questionKeys.length && new Set(matchKeys).size === matchKeys.length
        && matchKeys.length === questionKeys.length && questionKeys.every((k) => matchKeys.includes(k));
      if (!covered) { scriptUnrecorded += 1; continue; }
      if (matches.every((m) => m?.state === "answered")) allAnswered += 1;
    }
    out.script = { mode: "live", runs: recorded.length, states, all_answered: fmt(allAnswered, recorded.length), no_questions: noQuestions, unrecorded: scriptUnrecorded };
  }
  if (planOnly) {
    // 包みの検査（本ごと。値は入れず、通った・通らない本の数と理由の既知の符号ごとの数）
    const env = executed.map((f) => f.envelope ?? { status: "absent", reasons: [] });
    const checked = env.filter((e) => e.status === "checked");
    out.envelope = {
      runs: executed.length, checked: checked.length, passed: checked.filter((e) => e.reasons.length === 0).length, failed: checked.filter((e) => e.reasons.length > 0).length,
      absent: env.filter((e) => e.status === "absent").length, unreadable: env.filter((e) => e.status === "unreadable").length,
      reasons: Object.fromEntries(ENVELOPE_REASONS.map((k) => [k, checked.filter((e) => e.reasons.includes(k)).length])),
    };
  }
  return out;
}
/**
 * Plan だけの結果の包み（plan-result.json）1 つの検査。理由は既知の符号だけ：版（envelope-version）・結果の食い違い（往復の記録の outcome と違うか、
 * 確定なのに仕様が無い・確定でないのに仕様がある。outcome-mismatch）・仕様の SHA（planDigest と違うか、確定でないのに値がある。plan-sha256）・
 * 依頼文の SHA（source-sha256）・契約の検査（checkConfirmedPlan の問題がある。contract。message は読まない）。写像でない包みは unreadable
 */
export async function checkPlanResult(envelope, { recordOutcome = null, sourceText, checkConfirmedPlan, planDigest }) {
  if (!isObj(envelope)) return { status: "unreadable", reasons: [] };
  const reasons = [];
  if (envelope.schema_version !== PLAN_ONLY_RESULT_SCHEMA) reasons.push("envelope-version");
  // 結果は既知の 3 値だけ。確定なら仕様は写像、確定でなければ仕様も plan_sha256 も厳密に null（欄の欠落・型違いを成功にしない。#498 の独立レビューの指摘 4）
  const outcome = PLAN_OUTCOMES.includes(envelope.outcome) ? envelope.outcome : null;
  const confirmed = outcome === "confirmed", hasPlan = isObj(envelope.plan);
  if (outcome === null || (recordOutcome !== null && envelope.outcome !== recordOutcome) || (confirmed ? !hasPlan : envelope.plan !== null)) reasons.push("outcome-mismatch");
  if (confirmed && hasPlan) {
    let problems = 1, digest = null;
    try { problems = (await checkConfirmedPlan(envelope.plan)).length; } catch { problems = 1; }
    try { digest = await planDigest(envelope.plan); } catch { digest = null; }
    if (digest === null || digest !== envelope.plan_sha256) reasons.push("plan-sha256");
    if (problems > 0) reasons.push("contract");
  } else if (!confirmed && envelope.plan_sha256 !== null) reasons.push("plan-sha256");
  else if (confirmed) reasons.push("plan-sha256"); // 確定なのに仕様が写像でない：仕様の SHA を確かめられない
  if (envelope.source_sha256 !== sha256(sourceText)) reasons.push("source-sha256");
  return { status: "checked", reasons: ENVELOPE_REASONS.filter((k) => reasons.includes(k)) };
}
/**
 * Build だけの集計（build-from）。facts ＝ 予定した本ごとの [{ run, state, sl, br（Build だけの記録か null）, brStatus, lines（標準出力の JSON の行）, row }]。
 * frozen ＝ 条件の frozen（形は frozenProblem で検査済み）
 */
export function buildMetrics(facts, frozen) {
  const n = facts.length;
  const exitClasses = zeros([...EXIT_CLASSES, "unknown"]);
  const adoptedOf = new Map(frozen.adopted.map((a) => [a.pattern, a]));
  let exit2 = 0, refusals = 0, rtp = 0, inconsistent = 0, rtpUnrecorded = 0, mismatched = 0, matchChecked = 0;
  const verdicts = zeros([...FACTORY_VERDICTS, "unknown", "absent"]);
  const rows = facts.map((f) => {
    if (f.state !== "executed") return { run: f.run, state: f.state, exit: null, exit_class: null, envelope_refusal: false, return_to_plan: null, frozen_match: null, factory_verdict: null, pass: false };
    const exit = Number.isInteger(f.sl?.exit) ? f.sl.exit : null;
    const cls = knownOr(EXIT_CLASSES, f.sl?.exit_class);
    exitClasses[cls] += 1;
    if (exit === 2) exit2 += 1;
    // 包みの拒否：exit 2 で、起動の記録の分類が envelope-unreadable・envelope-rejected で、しかも標準出力にその構造化された行（既知の版。拒否は既知の検査名）がある本だけ
    const refusal = exit === 2 && ((cls === "envelope-unreadable" && f.lines.some((x) => x.schema_version === PLAN_FILE_ERROR_SCHEMA)) || (cls === "envelope-rejected" && f.lines.some((x) => x.schema_version === PLAN_FILE_REJECT_SCHEMA && PLAN_FILE_CHECKS.includes(x.check))));
    if (refusal) refusals += 1;
    const rec = f.brStatus === "ok" && isObj(f.br) && typeof f.br.return_to_plan === "boolean" ? f.br.return_to_plan : null;
    // 差し戻し：分子は exit 3 で記録が真の本だけ。exit 3 で記録が偽・exit 0 で記録が真は inconsistent、exit 3 で記録が無いか読めない本は unrecorded
    if (exit === 3 && rec === true) rtp += 1;
    else if ((exit === 3 && rec === false) || (exit === 0 && rec === true)) inconsistent += 1;
    else if (exit === 3 && rec === null) rtpUnrecorded += 1;
    // 組との照合：Build だけの記録の 2 つの SHA と、条件の frozen の採用した P の値
    let match = null;
    if (f.brStatus === "ok" && isObj(f.br)) {
      const a = adoptedOf.get(patternOf(f.run));
      match = a !== undefined && f.br.plan_sha256 === a.plan_sha256 && f.br.source_sha256 === a.source_sha256;
      matchChecked += 1;
      if (!match) mismatched += 1;
    }
    const s = isObj(f.sl?.summary) ? f.sl.summary : null;
    const v = s === null || s.verdict === null || s.verdict === undefined ? "absent" : knownOr(FACTORY_VERDICTS, s.verdict);
    verdicts[v] += 1;
    return { run: f.run, state: f.state, exit, exit_class: cls, envelope_refusal: refusal, return_to_plan: rec, frozen_match: match, factory_verdict: v, pass: f.row ? pass(f.row) : false };
  });
  const summaryOf = (f) => (f.state === "executed" && isObj(f.sl?.summary) ? f.sl.summary : null);
  // 段ごとの時間：段の記録を読めた本では、出てこない段は実測の 0。読めない本は欠測
  const stageIds = [...new Set(facts.flatMap((f) => (Array.isArray(summaryOf(f)?.stages) ? summaryOf(f).stages.map((st) => stageIdOf(st?.stage)) : [])))];
  const byStage = Object.fromEntries(stageIds.map((id) => [id, stat4(facts.map((f) => { const st = summaryOf(f)?.stages; return stagesTotal(st) === null ? null : sum(st.filter((x) => stageIdOf(x.stage) === id), (x) => x.duration_ms); }))]));
  const missingP = frozen.missing.length;
  return {
    runs: n, frozen_missing: missingP, denominator: `凍結した組の本 ${n} 本（予定した本の全部。組が外した P ${missingP} 個は含まない）`,
    unexecuted: facts.filter((f) => f.state === "unexecuted").length, incomplete: facts.filter((f) => f.state === "incomplete").length,
    exit_classes: exitClasses, exit_2: exit2, envelope_refusals: refusals,
    return_to_plan: { count: rtp, rate: fmt(rtp, n), inconsistent, unrecorded: rtpUnrecorded },
    frozen_match: { checked: matchChecked, mismatched },
    factory_verdicts: verdicts, pass: fmt(rows.filter((r) => r.pass).length, n),
    duration_ms: stat4(facts.map((f) => stagesTotal(summaryOf(f)?.stages))), by_stage: byStage,
    usd: stat4(facts.map((f) => (f.state !== "executed" ? null : finite(f.sl?.plan_cost?.build_usd) ?? finite(summaryOf(f)?.provider_cost_usd)))),
    rows,
  };
}

// ── 漏斗・pass^k・工場の判定の 4 値（#538。設計書 08 §7・§8.1・§8.4。README §5.9）
// 既存の欄は変えず、新しい欄を足すだけ。欄の無い記録（v1・v1.1α の今の形）からは出せるものだけを出し、出せないものは null か欠測。
// v1 と v1.1α の記録に同じ規則を当てる（段の名前が違うだけ）。値（宣言・依頼文・試験 ID）は入れない
/** 検証の記録（packages/factory の VERIFICATION_FILE。v1・v1.1α とも書く）の、本のディレクトリからの場所 */
export const VERIFICATION_PATH = "bundle/artifacts/verification.json";
/** 工場の判定の 4 値（設計書 08 §7・D1）と、知らない値（unknown）・要約が無いか verdict が無い本（absent） */
export const FACTORY_VERDICTS4 = ["full", "partial", "unverified", "none", "unknown", "absent"];
/** 原文系の判定（行の verdict。生成失敗は GEN_FAIL）。not_run ＝ 未実行・途中の本（予定の分母に残す） */
export const SOURCE_VERDICTS = ["PASS", "FAIL", "STATIC_NG", "GEN_FAIL", "unknown", "not_run"];
/** 了承後系の判定（行の verdict_accepted）。not_applicable ＝ 了承後の判定が無い本（Plan を通していない・了承の記録が無いか読めない・生成失敗）。not_run は原文系と同じ */
export const ACCEPTED_VERDICTS = ["PASS", "FAIL", "UNEVALUATED", "STATIC_NG", "not_applicable", "unknown", "not_run"];
/**
 * 工場の判定の 4 値（本ごと）。正本は D1 の明示的な欄：要約の verdict が partial で assurance が unverified のときだけ unverified。
 * それ以外は verdict のまま（知らない値は unknown、要約か verdict が無ければ absent）。検証の記録の unverified の内訳からは復元しない
 */
export function factoryVerdict4(summary) {
  if (!isObj(summary) || summary.verdict === null || summary.verdict === undefined) return "absent";
  if (!FACTORY_VERDICTS.includes(summary.verdict)) return "unknown";
  return summary.verdict === "partial" && summary.assurance === "unverified" ? "unverified" : summary.verdict;
}
/** 検証の記録の unverified の内訳の件数（配列なら要素の数、0 以上の整数ならその値）。記録か欄が無い・形が違えば null（0 と推測しない） */
export function unverifiedDetailsOf(verification) {
  if (!isObj(verification)) return null;
  const u = verification.unverified;
  return Array.isArray(u) ? u.length : Number.isInteger(u) && u >= 0 ? u : null;
}
/** 1 回目で通過：その段の最初の記録が status ok・calls 1・retries.shape 0・retries.content 0（retries が無ければ ok と calls 1） */
export function firstPassOf(records) {
  const r = records[0];
  if (!isObj(r) || r.status !== "ok" || r.calls !== 1) return false;
  if (r.retries === undefined || r.retries === null) return true;
  return isObj(r.retries) && r.retries.shape === 0 && r.retries.content === 0;
}
/** 全記録が 1 回目で通過（新しい段の集約。記録ごとに firstPassOf） */
export const allFirstPassOf = (records) => records.length > 0 && records.every((r) => firstPassOf([r]));
const unobservedLabel = (n) => `今回未観測（0/${n}）`;
/**
 * 漏斗（段ごとの条件付き通過率。設計書 08 §8.1）。entries ＝ 予定した本ごとの [{ state, summary（要約か null）, verification（検証の記録か null）, exhausted }]。
 * 段は BUILD_STAGE_IDS の順。到達 ＝ その段の記録が 1 つ以上ある本、1 回目で通過 ＝ firstPassOf、通過 ＝ どれかの記録が ok、停止 ＝ 要約の failure.stage がその段。
 * 到達した本の記録が全部 calls 0 の段（コードの段）は 1 回目で通過を適用外（件数も率も null）。件数の分母は予定した本（未実行・途中の本は到達 0）、
 * 条件付き率の分母は到達した本（数と Wilson の区間。到達 0 なら「今回未観測（0/予定）」）。
 * 完走の内訳：stop_class が completed の本を、検証の記録の test_mismatches と test_unresolved がともに 0（不一致なし）・それ以外・読めない（欠測）に分ける
 */
export function funnelOf(entries) {
  const n = entries.length;
  const ran = entries.filter((e) => e.state === "executed" && isObj(e.summary));
  const recordsOf = (e, id) => (Array.isArray(e.summary.stages) ? e.summary.stages.filter((st) => isObj(st) && st.stage === id) : []);
  const pending = hasPendingStage(ran.map((e) => e.summary));
  const stages = Object.fromEntries(rowStageIds(pending).map((id) => {
    const per = ran.map((e) => recordsOf(e, id)).filter((xs) => xs.length > 0);
    const reached = per.length;
    const codeStage = reached > 0 && per.every((xs) => xs.every((st) => st.calls === 0));
    // 新しい段は束ごとに複数の記録になるので、1 回目で通過は全記録で集約する（既存の段は最初の記録だけ）
    const firstPass = codeStage ? null : per.filter(IDS_STAGE_IDS.includes(id) ? allFirstPassOf : firstPassOf).length;
    const passed = per.filter((xs) => xs.some((st) => st.status === "ok")).length;
    const stopped = ran.filter((e) => isObj(e.summary.failure) && e.summary.failure.stage === id).length;
    const rate = (k) => (k === null ? null : reached === 0 ? unobservedLabel(n) : fmt(k, reached));
    return [id, { planned: n, reached, reached_label: reached === 0 ? unobservedLabel(n) : `${reached}/${n}`, code_stage: codeStage, first_pass: firstPass, passed, stopped, rates: { first_pass: rate(firstPass), passed: rate(passed), stopped: rate(stopped) } }];
  }));
  const done = ran.filter((e) => e.summary.stop_class === "completed");
  const cleanOf = (v) => (!isObj(v) || !Number.isInteger(v.test_mismatches) || !Number.isInteger(v.test_unresolved) ? null : v.test_mismatches === 0 && v.test_unresolved === 0);
  const stops = {};
  for (const e of ran) { const v = stopValueOf(e.summary, e.exhausted ?? null); stops[v] = (stops[v] ?? 0) + 1; }
  return {
    planned: n, executed: entries.filter((e) => e.state === "executed").length,
    denominator: `件数の分母は予定した本 ${n} 本（未実行・途中の本は到達 0）。条件付き率の分母は段ごとの到達本数`,
    stages,
    completed: { runs: done.length, no_mismatch: done.filter((e) => cleanOf(e.verification) === true).length, with_mismatch: done.filter((e) => cleanOf(e.verification) === false).length, missing: done.filter((e) => cleanOf(e.verification) === null).length },
    stops,
  };
}
/** pass^k（設計書 08 §8.4）：P ごとに 1〜k 回の全部が原文系 PASS なら 1。passOf(本の ID) は実行した本が PASS か（未実行・途中・締切で止まった本は 0）。P ごとの並びは反復の順 */
export function passKOf(patterns, k, passOf) {
  const byPattern = Object.fromEntries(patterns.map((p) => [p, Array.from({ length: k }, (_, i) => (passOf(`${p}-r${i + 1}`) ? 1 : 0))]));
  const count = patterns.filter((p) => k > 0 && byPattern[p].every((x) => x === 1)).length;
  return { k, patterns: patterns.length, count, rate: fmt(count, patterns.length), by_pattern: byPattern };
}
/**
 * 判定の 3 系統（原文系・了承後系・工場の 4 値）を別に数える。facts ＝ 予定した本ごとの [{ state, sl, row }]。件数の分母は予定した本、
 * 条件付き率は実行した本の中（executed）と納品のある本の中（delivered ＝ 宣言がある本）。値は既知の列挙に写し、知らない値は unknown
 */
// 本 1 つ（facts の 1 件）の 3 系統の値（verdictsOf と #539 の内外の表が同じ写し方を使う）
const sourceVerdictOf = (f) => (f.state !== "executed" ? "not_run" : !isObj(f.row) ? "unknown" : f.row.generation_failed === true ? "GEN_FAIL" : knownOr(["PASS", "FAIL", "STATIC_NG"], f.row.verdict));
const acceptedVerdictOf = (f) => (f.state !== "executed" ? "not_run" : !isObj(f.row) ? "unknown" : f.row.verdict_accepted === null || f.row.verdict_accepted === undefined ? "not_applicable" : knownOr(["PASS", "FAIL", "UNEVALUATED", "STATIC_NG"], f.row.verdict_accepted));
const factoryVerdict4Of = (f) => factoryVerdict4(f.state === "executed" ? f.sl?.summary : null);
export function verdictsOf(facts) {
  const executed = facts.filter((f) => f.state === "executed");
  const delivered = executed.filter((f) => isObj(f.row) && f.row.generation_failed !== true);
  const sourceOf = sourceVerdictOf, acceptedOf = acceptedVerdictOf, factoryOf = factoryVerdict4Of;
  const system = (list, of) => {
    const counts = zeros(list);
    for (const f of facts) counts[of(f)] += 1;
    const rates = (xs) => Object.fromEntries(list.filter((k) => k !== "not_run").map((k) => [k, fmt(xs.filter((f) => of(f) === k).length, xs.length)]));
    return { counts, executed: rates(executed), delivered: rates(delivered) };
  };
  return {
    planned: facts.length, executed: executed.length, delivered: delivered.length,
    denominator: `件数の分母は予定した本 ${facts.length} 本。条件付き率は実行した本 ${executed.length} 本・納品のある本 ${delivered.length} 本の中`,
    source: system(SOURCE_VERDICTS, sourceOf), accepted: system(ACCEPTED_VERDICTS, acceptedOf), factory: system(FACTORY_VERDICTS4, factoryOf),
  };
}
/** unverified の内訳の集計：実行した本のうち内訳を読めた本・欠測（記録か欄が無い）・件数の合計・1 件以上の本の数 */
export function unverifiedDetailsSummary(facts) {
  const executed = facts.filter((f) => f.state === "executed");
  const xs = executed.map((f) => unverifiedDetailsOf(f.verification)).filter((x) => x !== null);
  return { runs: executed.length, observed: xs.length, missing: executed.length - xs.length, total: xs.reduce((s, x) => s + x, 0), runs_with_unverified: xs.filter((x) => x > 0).length };
}
/** 標準出力の漏斗の 1 行（到達した段だけ。段：到達／1 回目／通過／停止。適用外は —） */
export function funnelText(fu) {
  // 段単位の走り（#545）の漏斗は範囲の中の段だけを持つ。持たない段は数えない（段単位でない漏斗は全段を持つので今までと同じ）
  const ids = BUILD_STAGE_IDS.filter((id) => fu.stages[id] !== undefined);
  const shown = ids.filter((id) => fu.stages[id].reached > 0 || fu.stages[id].stopped > 0);
  const parts = shown.map((id) => { const s = fu.stages[id]; return `${id} ${s.reached}／${s.first_pass ?? "—"}／${s.passed}／${s.stopped}`; });
  const c = fu.completed;
  return `漏斗（予定 ${fu.planned} 本・実行 ${fu.executed} 本。段：到達／1 回目／通過／停止。適用外は —）: ${parts.length === 0 ? "到達した段なし" : parts.join("・")}（未観測 ${ids.length - shown.length} 段）・完走 ${c.runs}（不一致なし ${c.no_mismatch}・あり ${c.with_mismatch}・欠測 ${c.missing}）`;
}
/** 標準出力の pass^k の 1 行 */
export const passKText = (pk) => `pass^${pk.k}: ${pk.rate}（${Object.entries(pk.by_pattern).map(([p, xs]) => `${p} ${xs.join(",")}`).join("・")}）`;

// ── 内外の表・不一致と未解決の試験の分類・段の役割ごとの対の差・P のまとまり（#539。設計書 08 §8.2・§8.7。README §5.10）
// 既存の欄と #538 の欄は変えず、新しい欄を足すだけ。分類は記録の読み方であり、採点の判定・PASS・分母には使わない。
// 固定文の表は工場の評価器の文字列を写す（工場のコード・dist は import しない）。匿名の口には件数・平均・区間・p だけを出す
/** 試験の結果の記録（packages/factory の TESTS_FILE。mismatches・unresolved の各要素は testId と detail）の、本のディレクトリからの場所 */
export const TESTS_PATH = "bundle/artifacts/tests.json";
/** 不一致・未解決の試験の分類（設計書 08 §8.2）。unknown ＝ 表のどの形にも当たらない（断らない。工場が固定文を変えたら増えて気づける） */
export const FINDING_CLASSES = ["binding-defect", "evaluator-coverage", "test-defect", "needs-human", "unknown"];
/**
 * 固定文の形の表（上から順に当て、最初に当たったもの）。form は評価器の全文（… は名前や数が入る位置）、re はその全文に当てる正規表現。
 * 写した先：binding-defect は packages/factory の stages/bind.ts・v11a/bind-by-id.ts・stages/run-tests.ts（参照データ・提出された対応）、
 * それ以外は stages/run-tests.ts の detail。どの文も 2 つの形に当たらない（試験で全組み合わせを確かめる）
 */
export const FINDING_PATTERNS = [
  { class: "binding-defect", form: "表の ID が指す場所が宣言に無い", re: /^表の ID が指す場所が宣言に無い$/s },
  { class: "binding-defect", form: "試験の対象の ID が名前の表に無い", re: /^試験の対象の ID が名前の表に無い$/s },
  { class: "binding-defect", form: "selector（…）の対応（…）に当たる … の場所が対応表の外にある", re: /^selector（.+）の対応（.+）に当たる .+ の場所が対応表の外にある$/s },
  { class: "binding-defect", form: "selector（…）に対応表の項目が無い", re: /^selector（.+）に対応表の項目が無い$/s },
  { class: "binding-defect", form: "selector（…）に提出された対応が無い（1 つに決まらない）", re: /^selector（.+）に提出された対応が無い（1 つに決まらない）$/s },
  { class: "binding-defect", form: "selector（…）に当たる … の場所が無い", re: /^selector（.+）に当たる .+ の場所が無い$/s },
  { class: "binding-defect", form: "… 個あり、1 つに決まらない", re: /^.+ 個あり、1 つに決まらない$/s },
  { class: "binding-defect", form: "参照データの対象（…）が実在の entity に結び付かない", re: /^参照データの対象（.+）が実在の entity に結び付かない$/s },
  { class: "binding-defect", form: "試験 … が結び付けの表に無い（1 つに決まらない）", re: /^試験 .+ が結び付けの表に無い（1 つに決まらない）$/s },
  { class: "binding-defect", form: "… に提出された対応が無い", re: /^.+ に提出された対応が無い$/s },
  { class: "evaluator-coverage", form: "評価の方法の表で未対応である（…）", re: /^評価の方法の表で未対応である（.+）$/s },
  { class: "evaluator-coverage", form: "操作 … に条件（when）が無く、実行は評価器で確かめられない", re: /^操作 .+ に条件（when）が無く、実行は評価器で確かめられない$/s },
  { class: "evaluator-coverage", form: "操作の実行（set を当てたあとの状態）は評価器で確かめられない", re: /^操作の実行（set を当てたあとの状態）は評価器で確かめられない$/s },
  { class: "test-defect", form: "… の期待は真偽（true / false）であること", re: /^.+ の期待は真偽（true \/ false）であること$/s },
  { class: "test-defect", form: "入力が写像（object）でない", re: /^入力が写像（object）でない$/s },
  { class: "test-defect", form: "構造の検査の中身（assertion）が無い", re: /^構造の検査の中身（assertion）が無い$/s },
  { class: "test-defect", form: "view-shows の表示を期待する役割 ID（role）が無い", re: /^view-shows の表示を期待する役割 ID（role）が無い$/s },
  { class: "needs-human", form: "… が期待と違う（期待 …、実際 …）", re: /^.+ が期待と違う（期待 .*、実際 .*）$/s },
  { class: "needs-human", form: "… が成り立った（期待は成り立たないこと）", re: /^.+ が成り立った（期待は成り立たないこと）$/s },
  { class: "needs-human", form: "… が値を返した（期待は求められないこと）", re: /^.+ が値を返した（期待は求められないこと）$/s },
  { class: "needs-human", form: "検査 … が落ちた（…）", re: /^検査 .+ が落ちた（.+）$/s },
  { class: "needs-human", form: "検査 … が落ちなかった（…）", re: /^検査 .+ が落ちなかった（.+）$/s },
  { class: "needs-human", form: "宣言に … が無い", re: /^宣言に.+ が無い$/s },
  { class: "needs-human", form: "entity … に項目 … が無い", re: /^entity .+ に項目 .+ が無い$/s },
  { class: "needs-human", form: "項目 … の種類が …（期待 …）", re: /^項目 .+ の種類が .+（期待 .+）$/s },
  { class: "needs-human", form: "項目 … の参照先が …（期待 …）", re: /^項目 .+ の参照先が .+（期待 .+）$/s },
  { class: "needs-human", form: "一覧 … は … を表示しない", re: /^一覧 .+ は .+ を表示しない$/s },
  { class: "needs-human", form: "項目 … は画面から辿れない（entity … の一覧か表に出ていない）", re: /^項目 .+ は画面から辿れない（entity .* の一覧か表に出ていない）$/s },
  { class: "needs-human", form: "… に create の操作も、一覧か表の表示も無い", re: /^.+ に create の操作も、一覧か表の表示も無い$/s },
];
/** 試験の detail（評価器の固定文）を分類する。文字列でなければ、どの形にも当たらなければ unknown */
export function classifyDetail(detail) {
  if (typeof detail !== "string") return "unknown";
  const hit = FINDING_PATTERNS.find((p) => p.re.test(detail));
  return hit === undefined ? "unknown" : hit.class;
}
/** 記録の読みの状態：両方読めた／試験の結果の記録だけ／検証の記録だけ／どちらも読めない（欠測） */
export const FINDING_SOURCES = ["both", "tests", "verification", "missing"];
/**
 * 本 1 つの不一致・未解決の試験（README §5.10.2）。正本は試験の結果の記録（tests の mismatches と unresolved。鍵 testId）。
 * 検証の記録の partial_reasons.unresolved_tests（鍵 test_id）は同じ最終結果の写しとして、未解決の試験 ID で突き合わせる：
 * 鍵は試験 ID だけ（種類をまたぐ）。同じ試験・同じ理由は 1 件、片側だけの試験はその側で補う、同じ試験 ID で理由の文が違えば 1 件（正本の種類と文）として数え、
 * その試験 ID ごとに inconsistent を 1 足す。tests の不一致と未解決に同じ試験 ID があるとき・同じ記録の中で重なったときも同じ規則（先に読んだ不一致を正本にする）。
 * 要素の形が違う（試験 ID か detail が文字列でない）ものは malformed に数え、分類しない
 */
export function testFindingsOf(tests, verification) {
  const testsOk = isObj(tests) && Array.isArray(tests.mismatches) && Array.isArray(tests.unresolved);
  const verOk = isObj(verification) && isObj(verification.partial_reasons) && Array.isArray(verification.partial_reasons.unresolved_tests);
  const status = testsOk && verOk ? "both" : testsOk ? "tests" : verOk ? "verification" : "missing";
  const findings = [];
  let malformed = 0;
  const byId = new Map(), differs = new Set();
  const add = (kind, list, idKey, source) => {
    for (const x of list) {
      if (!isObj(x) || typeof x[idKey] !== "string" || typeof x.detail !== "string") { malformed += 1; continue; }
      const prior = byId.get(x[idKey]);
      if (prior === undefined) { const f = { kind, test_id: x[idKey], detail: x.detail, class: classifyDetail(x.detail), source }; byId.set(x[idKey], f); findings.push(f); continue; }
      if (prior.source !== source && prior.source !== "both") prior.source = "both";
      if (prior.detail !== x.detail) differs.add(x[idKey]);
    }
  };
  if (testsOk) { add("mismatch", tests.mismatches, "testId", "tests"); add("unresolved", tests.unresolved, "testId", "tests"); }
  if (verOk) add("unresolved", verification.partial_reasons.unresolved_tests, "test_id", "verification");
  const classes = zeros(FINDING_CLASSES);
  for (const f of findings) classes[f.class] += 1;
  return { status, mismatches: findings.filter((f) => f.kind === "mismatch").length, unresolved: findings.filter((f) => f.kind === "unresolved").length, inconsistent: differs.size, malformed, classes, findings: status === "missing" ? [] : findings };
}
/** 実行した本ごとの分類と、合計（実行した本・読めた本・欠測・記録の読みの状態ごとの本数・件数・分類ごとの件数）。facts の tests・verification を読む */
export function testFindingsSummary(facts) {
  const runs = facts.filter((f) => f.state === "executed").map((f) => ({ run: f.run, ...testFindingsOf(f.tests ?? null, f.verification ?? null) }));
  const seen = runs.filter((r) => r.status !== "missing");
  const total = (k) => seen.reduce((s, r) => s + r[k], 0);
  const classes = zeros(FINDING_CLASSES);
  for (const r of seen) for (const c of FINDING_CLASSES) classes[c] += r.classes[c];
  return {
    label: "不一致・未解決の試験の分類（評価器の固定文から。記録の読み方であり、判定・PASS・分母には使わない）",
    runs: runs.length, observed: seen.length, missing: runs.length - seen.length, sources: Object.fromEntries(FINDING_SOURCES.map((s) => [s, runs.filter((r) => r.status === s).length])),
    findings: total("mismatches") + total("unresolved"), mismatches: total("mismatches"), unresolved: total("unresolved"), inconsistent: total("inconsistent"), malformed: total("malformed"), classes,
    by_run: runs,
  };
}
const SOURCE_COLUMNS = SOURCE_VERDICTS.filter((k) => k !== "not_run");
const ACCEPTED_COLUMNS = ACCEPTED_VERDICTS.filter((k) => k !== "not_run");
/**
 * 内外の表（設計書 08 §8.2）：実行した本ごとに（工場の 4 値 × 原文系の判定）の組を取り、組ごとの件数を数える。了承後系も同じ形で別の表。
 * 分母は予定した本で、未実行・途中の本は表に入れず別の行（not_run）に数える。cells は 0 でない組だけ（表の順。鍵は「工場×外」）
 */
export function agreementOf(facts) {
  const executed = facts.filter((f) => f.state === "executed");
  const tableOf = (columns, of) => {
    const table = Object.fromEntries(FACTORY_VERDICTS4.map((fv) => [fv, zeros(columns)]));
    for (const f of executed) table[factoryVerdict4Of(f)][of(f)] += 1;
    const cells = {};
    for (const fv of FACTORY_VERDICTS4) for (const c of columns) if (table[fv][c] > 0) cells[`${fv}×${c}`] = table[fv][c];
    return { table, cells };
  };
  return {
    planned: facts.length, executed: executed.length, not_run: facts.length - executed.length,
    denominator: `分母は予定した本 ${facts.length} 本。表は実行した本 ${executed.length} 本、未実行・途中の本 ${facts.length - executed.length} 本は別の行（not_run）`,
    source: tableOf(SOURCE_COLUMNS, sourceVerdictOf), accepted: tableOf(ACCEPTED_COLUMNS, acceptedVerdictOf),
  };
}
const cellsText = (cells) => (Object.keys(cells).length === 0 ? "なし" : Object.entries(cells).map(([k, n]) => `${k} ${n}`).join("・"));
/** 標準出力の内外の表と分類の 1 行 */
export function agreementText(ag, tf) {
  const c = tf.classes;
  return `内外の表（予定 ${ag.planned} 本・実行 ${ag.executed} 本・未実行と途中 ${ag.not_run} 本。工場×外）: 原文系 ${cellsText(ag.source.cells)}／了承後系 ${cellsText(ag.accepted.cells)}・試験の分類（読めた ${tf.observed} 本・欠測 ${tf.missing} 本・${tf.findings} 件）: ${FINDING_CLASSES.map((k) => `${k} ${c[k]}`).join("・")}（食い違い ${tf.inconsistent}）`;
}

/** 段の役割の対応表（比較元 v1 の段・候補 v1.1α の段。README §5.10.3） */
export const STAGE_ROLES = {
  design: { label: "設計", v1: "design", "v1.1a": "name-table" },
  test: { label: "試験", v1: "test-suite", "v1.1a": "test-spec" },
  write: { label: "書く", v1: "write", "v1.1a": "write" },
  check: { label: "点検", v1: "correspondence", "v1.1a": "decl-check" },
  run: { label: "実行", v1: "run-tests", "v1.1a": "run-tests" },
  judge: { label: "判定", v1: "judge", "v1.1a": "judge" },
};
/** 段の役割ごとに差を取る指標（#538 の漏斗の到達・1 回目で通過・通過） */
export const STAGE_METRICS = ["reached", "first_pass", "passed"];
/** 差が null の理由：片側だけの対（両方が実行されていない）・欠測（要約か段の記録が読めない）・適用外（その群でコードの段の 1 回目で通過） */
export const PAIR_NULL_REASONS = ["one_side", "missing", "not_applicable"];
/**
 * 本 1 つの段の値（0／1）。要約が無いか段の記録（stages）が配列でなければ欠測（null と missing）。
 * codeStage（その群の漏斗で code_stage 真）なら 1 回目で通過は適用外（null と not_applicable）。未到達の段は 0（測定値）
 */
export function stageValuesOf(summary, stage, codeStage) {
  if (!isObj(summary) || !Array.isArray(summary.stages)) return { missing: true, values: Object.fromEntries(STAGE_METRICS.map((k) => [k, null])) };
  const xs = summary.stages.filter((st) => isObj(st) && st.stage === stage);
  // 設計の役割（v1.1α の段の名前で引く群）：name-table が無く vocabulary が 1 つ以上ある本は C1・C2 の記録で読む。
  // 到達 ＝ vocabulary の記録、通過 ＝ semantic-check の記録（C3 に渡った印）、1 回目で通過 ＝ 通過かつ vocabulary・mapping の全記録が 1 回目で通過
  if (stage === "name-table" && xs.length === 0) {
    const of = (id) => summary.stages.filter((st) => isObj(st) && st.stage === id);
    const vocab = of("vocabulary");
    if (vocab.length > 0) {
      const passed = of("semantic-check").length > 0;
      return { missing: false, values: { reached: 1, first_pass: codeStage ? null : passed && allFirstPassOf([...vocab, ...of("mapping")]) ? 1 : 0, passed: passed ? 1 : 0 } };
    }
  }
  const reached = xs.length > 0;
  return { missing: false, values: { reached: reached ? 1 : 0, first_pass: codeStage ? null : reached && firstPassOf(xs) ? 1 : 0, passed: xs.some((st) => st.status === "ok") ? 1 : 0 } };
}
/** P を単位にした bootstrap の回数と乱数の種（同じ入力で同じ区間）と、符号反転を全部数える P の数の上限 */
export const BOOTSTRAP = { resamples: 10000, seed: 539 };
export const SIGN_FLIP_MAX_CLUSTERS = 12;
const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
// Student の t 分布の分位点（参考の t 区間だけに使う）。正則化された不完全ベータ関数（連分数）と二分法
const logGamma = (x) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, s = 1.000000000190015; const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5); for (const k of c) s += k / ++y; return -t + Math.log((2.5066282746310005 * s) / x); };
const betaCf = (a, b, x) => {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1); d = Math.abs(d) < 1e-300 ? 1e-300 : d; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; d = Math.abs(d) < 1e-300 ? 1e-300 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; d = Math.abs(d) < 1e-300 ? 1e-300 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
};
const betaReg = (x, a, b) => { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)); return x < (a + 1) / (a + b + 2) ? (bt * betaCf(a, b, x)) / a : 1 - (bt * betaCf(b, a, 1 - x)) / b; };
const tCdf = (t, df) => { const tail = 0.5 * betaReg(df / (df + t * t), df / 2, 0.5); return t >= 0 ? 1 - tail : tail; };
export function tQuantile(p, df) { let lo = 0, hi = 1e4; for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
const quantile7 = (sorted, q) => { const h = (sorted.length - 1) * q, i = Math.floor(h); return i + 1 < sorted.length ? sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]) : sorted[i]; };
/**
 * P をまとまりにした区間と検定（設計書 08 §8.7。README §5.10.4）。byPattern ＝ P → 対の差の並び（null は無効な対）。
 * P ごとに有効な対の差を平均し（丸めない）、m ＝ 有効な対のある P の数。主：(i) 符号反転の両側 p（P 平均の符号を 2^m 通り全部入れ替え、
 * 平均の絶対値が観測以上になる割合。m が SIGN_FLIP_MAX_CLUSTERS を超えれば null と理由）、(ii) P を単位にした bootstrap の区間（P 平均を復元抽出した平均の
 * 2.5・97.5 百分位。BOOTSTRAP の回数と種）。参考：t 区間（P 平均の平均 ± t(0.975, m−1) × 標本標準偏差 ÷ √m）。m < 2 なら区間と p は null
 */
export function clusterStats(byPattern) {
  const means = {};
  for (const [pid, diffs] of Object.entries(byPattern)) { const xs = diffs.filter((d) => d !== null); if (xs.length > 0) means[pid] = xs.reduce((s, d) => s + d, 0) / xs.length; }
  const vals = Object.values(means), m = vals.length;
  const mean = m === 0 ? null : vals.reduce((s, x) => s + x, 0) / m;
  const head = { unit: "P", m, mean: mean === null ? null : round6(mean), by_pattern: Object.fromEntries(Object.entries(means).map(([p, x]) => [p, round6(x)])) };
  const few = "まとまり（有効な対のある P）が 2 未満";
  if (m < 2) return { ...head, sign_flip: { p: null, permutations: null, reason: few }, bootstrap: { interval: null, ...BOOTSTRAP, reason: few }, t_reference: { sd: null, df: null, interval: null, reason: few } };
  let sign_flip;
  if (m > SIGN_FLIP_MAX_CLUSTERS) sign_flip = { p: null, permutations: null, reason: `P の数 ${m} が ${SIGN_FLIP_MAX_CLUSTERS} を超える（2^m 通りを数えない）` };
  else {
    const obs = Math.abs(vals.reduce((s, x) => s + x, 0)), total = 2 ** m;
    let hit = 0;
    for (let mask = 0; mask < total; mask++) { let s = 0; for (let i = 0; i < m; i++) s += mask & (1 << i) ? -vals[i] : vals[i]; if (Math.abs(s) >= obs - 1e-9) hit += 1; }
    sign_flip = { p: round6(hit / total), permutations: total, reason: null };
  }
  const rand = mulberry32(BOOTSTRAP.seed), boots = [];
  for (let b = 0; b < BOOTSTRAP.resamples; b++) { let s = 0; for (let i = 0; i < m; i++) s += vals[Math.floor(rand() * m)]; boots.push(s / m); }
  boots.sort((x, y) => x - y);
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (m - 1)), h = (tQuantile(0.975, m - 1) * sd) / Math.sqrt(m);
  return {
    ...head, sign_flip,
    bootstrap: { interval: [round6(quantile7(boots, 0.025)), round6(quantile7(boots, 0.975))], ...BOOTSTRAP, reason: null },
    t_reference: { sd: round6(sd), df: m - 1, interval: [round6(mean - h), round6(mean + h)], reason: null },
  };
}
const fixed3 = (x) => (x === null ? "-" : x.toFixed(3));
const rangeText = (x) => (x === null ? "-" : `${fixed3(x[0])}〜${fixed3(x[1])}`);
/** 標準出力の P のまとまりの 1 行：原文系 PASS の差と、段の役割ごとの「通過」の差（P 平均の平均・符号反転の p・bootstrap の区間。t 区間は参考） */
export function clusterText(sp, pc) {
  const one = (c) => `平均 ${fixed3(c.mean)}・p ${fixed3(c.sign_flip.p)}・bootstrap ${rangeText(c.bootstrap.interval)}（t ${rangeText(c.t_reference.interval)}）`;
  return `P のまとまり（m ${pc.pass.m}。主は符号反転の p と bootstrap の区間、t 区間は参考。非有意は「検出されず」）: PASS の差 ${one(pc.pass)}・不一致の対 ＋1 ${pc.discordant.improved}／−1 ${pc.discordant.regressed}（記述的な警報）・通過の差 ${Object.entries(sp.roles).map(([, r]) => `${r.label} ${r.metrics.passed.n === 0 ? "n 0" : one(r.metrics.passed.clusters)}`).join("・")}`;
}
/** P のまとまりの読み方（出力に添える文） */
export const CLUSTER_NOTE = "主は P を単位にした符号反転の両側 p と bootstrap の区間。t 区間は参考（前提：P 間の独立・P 平均の正規近似。まとまりが少ないと近似が粗い）。符号反転は帰無仮説の下で P 平均の符号が交換可能であることを前提にする。非有意は「差が無い」ではなく「検出されず」";

// ── 雑音の分解（#631。README §8。v1.2 評価 a）：対の差の雑音を予測の雑音（同じ P の反復のぶれ）とデータの雑音（P の違い）に分け、反復 K′ ごとに検出できる差の目安を出す。
// 判定・門・merge の可否には使わない（数を出すだけ。K を上げる判断は人）。出典：Miller 2024 arXiv 2411.00640 §3.1・§5／Wang 2025 arXiv 2512.21326
/** 検出できる差の係数（両側 5%・検出力 80% の正規近似：z0.975 ＋ z0.80） */
export const NOISE_Z = 2.8016;
/** 検出できる差の表の反復 K′（1〜10） */
export const NOISE_K_VALUES = Array.from({ length: 10 }, (_, i) => i + 1);
/** 勝つ側の値と、決めない・δ を出さない理由の符号 */
export const NOISE_WINNERS = ["prediction", "data", "tie", "undetermined"];
export const NOISE_REASONS = ["few-patterns", "few-within-patterns", "variance-unestimable"];
/** 雑音の分解の読み方（出力に添える文） */
export const NOISE_NOTE = "判定・門には使わない（数を出すだけ）。δ(K′) は P 平均の正規近似による検出できる差の目安で、m が少ないと粗い。主の読み方は P 単位の符号反転と bootstrap のまま。非有意は「差が無い」ではない。対の差の P 内分散は両群の反復のぶれの和に相当する（対にしても予測の雑音は減らない）";
const NOISE_TIE_EPS = 1e-12;
const r6OrNull = (x) => (x === null ? null : round6(x));
/**
 * 雑音の分解（README §8）。byPattern ＝ P → 対の差の並び（null は無効な対）、runs ＝ 条件の runs（いまの K）。
 * K_p ＝ P ごとの有効な対の数、m ＝ K_p ≥ 1 の P の数（K_p＝0 の P は excluded_patterns に数える）、d̄ ＝ P 平均の単純平均（clusterStats の mean と同じ）。
 * σ̂²_w ＝ K_p ≥ 2 の P の不偏分散の平均、s²_b ＝ P 平均の不偏分散、v̂_pred ＝ mean_p(σ̂²_w ÷ K_p)、ω̂² ＝ max(0, s²_b − v̂_pred)。
 * δ(K′) ＝ NOISE_Z × √((ω̂² ＋ σ̂²_w ÷ K′) ÷ m)、δ_∞ ＝ NOISE_Z × √(ω̂² ÷ m)。丸めずに計算し、出すときに 6 桁に丸める
 */
export function noiseStats(byPattern, runs = null) {
  const pats = [];
  let excluded = 0;
  for (const [pid, diffs] of Object.entries(byPattern)) {
    const xs = diffs.filter((d) => d !== null);
    if (xs.length === 0) { excluded += 1; continue; }
    const mean = xs.reduce((s, d) => s + d, 0) / xs.length;
    pats.push({ pid, k: xs.length, mean, variance: xs.length < 2 ? null : xs.reduce((s, d) => s + (d - mean) ** 2, 0) / (xs.length - 1) });
  }
  const m = pats.length, within = pats.filter((p) => p.variance !== null);
  const mean = m === 0 ? null : pats.reduce((s, p) => s + p.mean, 0) / m;
  const sw = within.length === 0 ? null : within.reduce((s, p) => s + p.variance, 0) / within.length;
  const sb = m < 2 ? null : pats.reduce((s, p) => s + (p.mean - mean) ** 2, 0) / (m - 1);
  const pred = sw === null ? null : pats.reduce((s, p) => s + sw / p.k, 0) / m;
  const raw = sb === null || pred === null ? null : sb - pred, omega = raw === null ? null : Math.max(0, raw);
  const winnerReason = m < 3 ? "few-patterns" : within.length < 2 ? "few-within-patterns" : null;
  const winner = winnerReason !== null ? "undetermined" : Math.abs(pred - omega) <= NOISE_TIE_EPS ? "tie" : pred > omega ? "prediction" : "data";
  const estimable = sw !== null && sb !== null;
  const delta = (k) => (estimable ? NOISE_Z * Math.sqrt((omega + sw / k) / m) : null);
  const current = Number.isInteger(runs) && runs >= 1 ? runs : null;
  return {
    unit: "P", m, excluded_patterns: excluded, mean: r6OrNull(mean),
    within: { variance: r6OrNull(sw), patterns: within.length },
    between: { variance: r6OrNull(sb) },
    prediction: r6OrNull(pred),
    data: { raw: r6OrNull(raw), variance: r6OrNull(omega), clipped: raw === null ? null : raw < 0 },
    winner, reason: winnerReason,
    detectable: {
      z: NOISE_Z, by_k: Object.fromEntries(NOISE_K_VALUES.map((k) => [String(k), r6OrNull(delta(k))])), infinity: estimable ? round6(NOISE_Z * Math.sqrt(omega / m)) : null,
      current: { k: current, delta: current === null ? null : r6OrNull(delta(current)) }, reason: estimable ? null : "variance-unestimable",
    },
    by_pattern: Object.fromEntries(pats.map((p) => [p.pid, { k: p.k, mean: round6(p.mean), variance: r6OrNull(p.variance) }])),
  };
}
/** 比較の雑音の分解：原文系 PASS の対の差と、段の役割ごとの「通過」の対の差（runs ＝ 条件の runs） */
export function compareNoise(passByPattern, passedByRole, runs) {
  return {
    note: NOISE_NOTE, runs: Number.isInteger(runs) ? runs : null,
    pass: noiseStats(passByPattern, runs),
    stage_pairs: { roles: Object.fromEntries(Object.entries(STAGE_ROLES).map(([role, def]) => [role, { label: def.label, passed: noiseStats(passedByRole[role] ?? {}, runs) }])) },
  };
}
/** 標準出力の雑音の分解の 1 行（原文系 PASS の差） */
export function noiseText(nz) {
  const p = nz.pass, d = p.detectable;
  return `雑音の分解（判定には使わない目安）: 予測 ${fixed3(p.prediction)}・データ ${fixed3(p.data.variance)}${p.data.clipped ? "（データの雑音は検出されず）" : ""}（${p.winner}${p.reason === null ? "" : `: ${p.reason}`}）・検出できる差 K=3 ${fixed3(d.by_k["3"])}・K=6 ${fixed3(d.by_k["6"])}・下限 ${fixed3(d.infinity)}${d.reason === null ? "" : `（${d.reason}）`}（m ${p.m}・P 内の分散を出せた P ${p.within.patterns}）`;
}

/** 採点せずに断る誤り（入口が「断りました」と exit 3 にする）。文は opts.anonymous のときパス・本の ID・組の ID を含めない */
const refusal = (message) => Object.assign(new Error(message), { refused: true });
/**
 * 採点する。opts.setPath（--set）があればその定義ファイル、無ければ条件のファイルの set.path（<repo> からの相対。絶対も通す）、それも無ければ既定の組。
 * 定義ファイルを読めなければ採点しない（断る）。予定の本（条件のファイルの child_args。検証できるとき）が採点する組に無ければ採点しない（断る。
 * 一部の本だけを含む組で採点して、予定した本を分母から黙って除かないため）。出力先に組に無い ID の本（予定外）があれば採点せず行に入れないが、
 * 照合（completion.unscored）に残して理由に出す。opts.anonymous は匿名の実行の印：断る文と照合の文に識別子を含めない
 */
export async function scoreOutput(repo, outRoot, opts = {}) {
  const anonymous = opts.anonymous === true;
  const ev = join(repo, "workspace/mvp/m1/agent/eval");
  const { loadDef, score } = await import(pathToFileURL(join(ev, "engine.mjs")).href);
  const { finalVerdict, scoreClaims, DEFAULT_ALLOWED } = await import(pathToFileURL(join(ev, "score-claims.mjs")).href);
  const specEngineDist = join(repo, "packages/spec-engine/dist");
  const engine = await import(pathToFileURL(join(specEngineDist, "index.js")).href);
  // 確定した仕様の契約の検査（#426）。工場が Plan を確定するときに呼ぶものと同じ関数を、契約の持ち主の dist から読む（工場の公開の面は再公開していない）
  const appspecDist = join(repo, "packages/appspec-schema/dist");
  const { checkConfirmedPlan, planDigest } = await import(pathToFileURL(join(appspecDist, "index.js")).href);
  const cond = readConditions(outRoot);
  // 評価の種類（#498）。Build だけの計測で、条件の frozen が無い・形が違えば採点しない（断る文に値・パス・本の ID を入れない）
  const evaluation = evaluationOf(cond);
  const mode = evaluation.mode;
  if (mode === "build-from") {
    const problem = frozenProblem(cond.frozen);
    if (problem !== null) throw refusal(`Build だけの計測（build-from）の条件の凍結した組（frozen）が${problem === "missing" ? "無い" : "の形が違う"} [score:frozen-${problem}]`);
  }
  // 評価セットの定義ファイル（#427）：--set ＞ 条件のファイルの set.path ＞ 既定の組
  const setPath = opts.setPath !== undefined ? resolve(opts.setPath) : typeof cond?.set?.path === "string" ? resolveFrom(repo, cond.set.path) : join(repo, DEFAULT_SET_PATH);
  const loadedSet = loadEvalSet(setPath);
  if (loadedSet.status !== "ok") throw refusal(`定義ファイルを読めません${anonymous ? "" : `（${relReal(repo, setPath)}）`}: ${loadedSet.reasons.join("、")}`);
  const evalSet = loadedSet;
  // 予定の本が採点する組に無ければ断る（fix-427）。匿名なら本数だけ
  const planned = cond !== null && validatePlanned(cond).length === 0 ? cond.child_args.map((c) => c.id) : [];
  const unscorable = planned.filter((id) => !evalSet.byId.has(patternOf(id)));
  if (unscorable.length > 0) throw refusal(`予定の本が採点する組${anonymous ? "" : `（${evalSet.set.id}）`}に無い（${unscorable.length} 本${anonymous ? "" : `: ${unscorable.join(",")}`}）`);
  // 段単位の走り（#545）：凍結した組と、条件に固定した入力なしの本（予定の部分集合・件数と一致）が読めなければ採点しない
  const stageAbsent = mode === STAGE_RUN_MODE ? stageAbsentOf(cond, planned) : null;
  if (mode === STAGE_RUN_MODE) {
    const problem = frozenProblem(cond.frozen);
    if (problem !== null) throw refusal(`段単位の計測（stage-run）の条件の凍結した組（frozen）が${problem === "missing" ? "無い" : "の形が違う"} [score:frozen-${problem}]`);
    if (stageAbsent === null || planned.length === 0) throw refusal("段単位の計測（stage-run）の条件の入力なしの本（stage_input_absent）か予定が読めない [score:stage-absent-invalid]");
  }
  // 了承後系の対象（#426）：計測が Plan を通した（条件のファイルの params.plan）なら全本。そうでなければ Plan の記録（plan-record.json か plan.json）のある本だけ
  const planScope = cond?.params?.plan === true;
  const rows = [];
  const tableInputs = []; // Plan の表と Build の表の入力（#493）
  for (const d of runDirs(outRoot)) {
    const p = patternOf(d), item = evalSet.byId.get(p), dir = join(outRoot, d);
    if (item === undefined) continue; // 組に無い ID の本（予定外）：照合の unscored に残り、入口が標準エラーに出す
    const subject = item.subject;
    const sl = existsSync(join(dir, "summary.line.json")) ? readRecord(join(dir, "summary.line.json"), "summary") : null;
    const s = sl?.summary ?? null;
    // 工場の判定の 4 値と unverified の内訳の件数（#538）。既存の行の鍵のあとに足す
    const verdict4 = { factory_verdict4: factoryVerdict4(s), unverified_details: unverifiedDetailsOf(readJsonSafe(join(dir, VERIFICATION_PATH)).value) };
    const spec = join(dir, "bundle/artifacts/app.spec.yaml");
    // --plan の本（#378）：費用は Plan と Build の合計。Plan の結果と質問の数も残す
    const planRecordPath = join(dir, "bundle/plan-record.json");
    // 往復の記録は止めずに読む（#498 の独立レビューの指摘 1）：JSON でない記録は既存の行・表では記録なし（null）とし、新しい集計では読めない記録として数える
    const prRead = readJsonSafe(planRecordPath);
    const pr = prRead.status === "ok" ? prRead.value : null;
    // 既存の行の問数・往復は今までの式のまま数える（今まで値が出ていた入力は、形が違っても同じ値。#498 の再確認の指摘 N1）。
    // 今までの式が例外で止まった形（rounds が写像・往復が null など）だけを 0 に写して続ける（読めない入力の扱い。分類の無害化とは別）
    const planCounts = (() => {
      try { return { questions: (pr.rounds ?? []).reduce((n, round) => n + (round.questions ?? []).length, 0), rounds: (pr.rounds ?? []).length }; } catch { return { questions: 0, rounds: 0 }; }
    })();
    tableInputs.push({ run: d, pr, sl });
    const plan = pr === null ? null : { outcome: pr.outcome ?? null, questions: planCounts.questions, rounds: planCounts.rounds, usd: sl?.plan_cost?.plan_usd ?? pr.spent_usd ?? 0 };
    const base = { run: d, pattern: p, subject, style: item.style, writable: item.writable, factory_verdict: s?.verdict ?? null, stop: s?.stop_reason ?? s?.stop_class ?? null, failure: s?.failure ?? null, cost_usd: sl?.plan_cost?.total_usd ?? s?.provider_cost_usd ?? 0, seconds: sl?.wall_s ?? s?.duration_secs ?? 0, plan };
    const def = loadDef(item.scoringPath);
    // 補正後（v2）の分母の既定：主の構造（0 番目）の判定の数。役割が見つからないときに engine.mjs が writable_total に使う値と同じ
    const main = def.structures[0], fromDefinition = { total: main.checks.length, total_from: `definition:${main.id}` };
    // 了承の記録（#426）：plan.json を読んで契約の検査を通し、当てはまった構造（無ければ主の構造）の定義の鍵で除外・変更を照合する。記録の無い本は absent と理由（Plan を通していない計測なら none ＝ 対象外）
    const loaded = await loadPlan(dir, checkConfirmedPlan);
    const status = loaded.status === "absent" && pr === null && !planScope ? "none" : loaded.status;
    const outcome = typeof pr?.outcome === "string" && PLAN_OUTCOMES.includes(pr.outcome) ? pr.outcome : null;
    const absentReason = pr === null || outcome === null ? "unknown" : outcome === "confirmed" ? "confirmed_without_plan" : "plan_not_confirmed";
    const acceptanceOf = (structureId) => {
      if (status === "none") return { status };
      const head = { status, reasons: loaded.reasons, plan_outcome: pr?.outcome ?? null };
      if (status === "absent") return { ...head, absent_reason: absentReason };
      if (status !== "confirmed") return head;
      const matcher = acceptanceMatcher(def, structureId, DEFAULT_ALLOWED);
      return { ...head, plan_id: loaded.plan.plan_id ?? null, revision: loaded.plan.revision ?? null, structure: matcher.structure, ...readAcceptance(loaded.plan, matcher) };
    };
    // 了承後の充足の既定：記録の無い本・読めない本・構造が当てはまらない本は充足 0 で、主の構造の判定の数が分母（v2 と同じ決まり）
    const zeroAccepted = status === "none" ? null : { fulfilled: 0, ...fromDefinition, unevaluated: [] };
    // 台本の照合（#427）：往復の記録の全部の問いに、題材の台本を事後に当てる（記録の無い本は none）
    // Plan だけの計測（#498）では、確定した仕様を包み（plan-result.json）から読む（納品物の plan.json が無い）
    const envelopePlan = mode === "plan-only" && loaded.plan === null ? readJsonSafe(join(dir, PLAN_RESULT_PATH)).value?.plan : null;
    const script = scriptSummary(evalSet.scripts.get(subject) ?? null, pr, isObj(envelopePlan) ? envelopePlan : loaded.plan);
    if (!existsSync(spec)) { rows.push({ ...base, generation_failed: true, fulfillment_v2: { fulfilled: 0, ...fromDefinition }, acceptance: acceptanceOf(null), claims_accepted: null, fulfillment_accepted: zeroAccepted, verdict_accepted: null, script, ...verdict4 }); continue; }
    const r = await score(engine, spec, def);
    const uw = existsSync(join(dir, "bundle/artifacts/unwritable.json")) ? readRecord(join(dir, "bundle/artifacts/unwritable.json"), "unwritable").unwritable ?? [] : [];
    const claimsList = uw.flatMap((u) => (u.unwritable ?? []).map((part) => ({ requirement: `${u.text}（${u.quote}）`, reason: part })));
    const claims = scoreClaims({ attempts: [{ unwritable: claimsList }] }, def, r.structure, r.written);
    // 構造が当てはまった本は、その構造の判定の数が分母。静的 NG・役割が見つからない本は充足 0 で、主の構造の判定の数が分母
    const fulfillment_v2 = r.structure ? { fulfilled: r.fulfilled ?? 0, total: r.writable_total, total_from: `structure:${r.structure}` } : { fulfilled: 0, ...fromDefinition };
    // 了承後系：確定した本だけ読み替える（了承済みの書けない要件は挙げ漏れにしない。変更が当てた判定は未評価の印を付け、分母からは外さない）。それ以外は充足 0・判定 null
    const acceptance = acceptanceOf(r.structure);
    const claims_accepted = status === "confirmed" ? claimsAfterAcceptance(def, r.structure, claimsList, r.written, acceptance.accepted_unwritable_ids, claims.false_claims.length) : null;
    const fulfillment_accepted = status === "confirmed" && r.structure ? fulfillmentAfterAcceptance(r, acceptance.unevaluated_checks) : zeroAccepted;
    const verdict_accepted = status === "confirmed" ? verdictAfterAcceptance(r, acceptance, claims_accepted, finalVerdict) : null;
    rows.push({ ...base, spec_verdict: r.verdict, verdict: finalVerdict(r, claims), failed: Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k), fulfilled: r.fulfilled ?? 0, writable_total: r.writable_total ?? 0, claims, final_static: r.verdict === "STATIC_NG" ? 1 : 0, fulfillment_v2, acceptance, claims_accepted, fulfillment_accepted, verdict_accepted, script, ...verdict4 });
  }
  // 書ける題材（writable）と一部書けない題材（partial）の分け方は定義ファイルの writable（#427。今の組では A・C・E と B・D）
  const W = rows.filter((r) => r.writable), P = rows.filter((r) => !r.writable);
  const withUnwritable = P.filter((r) => r.generation_failed || r.claims.missed + r.claims.correct > 0);
  // 既存の指標（v1 の数え方のまま）
  const metrics = {
    generated: fmt(rows.filter((r) => !r.generation_failed).length, rows.length),
    final_static: fmt(rows.filter((r) => !r.generation_failed && r.final_static === 0).length, rows.length),
    spec_pass_writable: fmt(W.filter(pass).length, W.length),
    missed_partial: fmt(withUnwritable.filter((r) => r.generation_failed || r.claims.missed > 0).length, withUnwritable.length),
    fulfillment_partial: fmt(P.reduce((s, r) => s + (r.fulfilled ?? 0), 0), P.reduce((s, r) => s + (r.writable_total || 0), 0)),
    spec_pass_partial: fmt(P.filter(pass).length, P.length),
    false_claim_runs: fmt(rows.filter((r) => r.generation_failed || r.claims.false_claims.length > 0).length, rows.length),
    within_time_cost: `${rows.filter((r) => !r.generation_failed && r.seconds <= 600 && r.cost_usd <= 0.3).length}/${rows.length}`,
    cost_total_usd: rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(4),
    factory_verdicts: rows.reduce((m, r) => ((m[r.factory_verdict ?? "none"] = (m[r.factory_verdict ?? "none"] ?? 0) + 1), m), {}),
  };
  // 充足率を集計の版ごとに並べる（partial ＝ 一部書けない題材 B・D、writable ＝ 書ける題材 A・C・E、all ＝ 全部）。v1.partial は metrics.fulfillment_partial と同じ値
  const v1 = (xs) => fmt(sum(xs, (r) => r.fulfilled ?? 0), sum(xs, (r) => r.writable_total || 0));
  const v2 = (xs) => fmt(sum(xs, (r) => r.fulfillment_v2.fulfilled), sum(xs, (r) => r.fulfillment_v2.total));
  // 了承後系（#426）：対象の本（fulfillment_accepted が null でない本）だけで数える。記録の無い本・読めない本は充足 0・判定 null で分母に残る
  const inScope = rows.filter((r) => r.fulfillment_accepted !== null);
  const confirmed = inScope.filter((r) => r.acceptance.status === "confirmed");
  const WA = inScope.filter((r) => r.writable), PA = inScope.filter((r) => !r.writable);
  const passAccepted = (r) => r.verdict_accepted === "PASS";
  const withUnwritableA = PA.filter((r) => r.claims_accepted === null || r.claims_accepted.missed + r.claims_accepted.correct + r.claims_accepted.accepted > 0);
  const countOf = (st) => inScope.filter((r) => r.acceptance.status === st).length;
  const sumA = (f) => sum(confirmed, (r) => f(r.acceptance));
  const runsA = (f) => fmt(confirmed.filter((r) => f(r.acceptance)).length, confirmed.length);
  const fa = (xs) => fmt(sum(xs, (r) => r.fulfillment_accepted.fulfilled), sum(xs, (r) => r.fulfillment_accepted.total));
  const unevaluatedRuns = confirmed.filter((r) => r.verdict_accepted === VERDICT_UNEVALUATED);
  const metrics_accepted = {
    runs: inScope.length, confirmed: confirmed.length, absent: countOf("absent"),
    absent_reasons: Object.fromEntries(ABSENT_REASONS.map((k) => [k, inScope.filter((r) => r.acceptance.status === "absent" && r.acceptance.absent_reason === k).length])), invalid: countOf("invalid"),
    spec_pass_writable: fmt(WA.filter(passAccepted).length, WA.length),
    missed_partial: fmt(withUnwritableA.filter((r) => r.claims_accepted === null || r.claims_accepted.missed > 0).length, withUnwritableA.length),
    spec_pass_partial: fmt(PA.filter(passAccepted).length, PA.length),
    // 未評価の本（変更後を判定する手段が無い）と、変更が当てた判定の数。分母からは外していない
    unevaluated_runs: fmt(unevaluatedRuns.length, confirmed.length), unevaluated_checks: sum(confirmed, (r) => r.fulfillment_accepted.unevaluated.length),
    // 未検証の有効な要件（代替先・変更後・追加。判定の手段が無い）の数と出どころの内訳、それを持つ本の数（分母は確定した本）。照合が expected・allowed でも、この本は PASS にしない
    unverified_requirements: sumA((a) => a.effective.counts.total), unverified_sources: Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, sumA((a) => a.effective.counts[s])])), unverified_runs: runsA((a) => a.effective.counts.total > 0),
    wrong_exclusion_runs: runsA((a) => a.counts.exclusions.wrong > 0), undecided_exclusion_runs: runsA((a) => undecidedExclusions(a) > 0),
    wrong_exclusions: sumA((a) => a.counts.exclusions.wrong), undecided_exclusions: sumA(undecidedExclusions),
    // 誤った了承は未評価（対応データが無い）。証拠と判定不能・未評価の件数を添え、0 件に丸めない
    wrong_acceptances: { ...WRONG_ACCEPTANCE_EVALUATION, evidence: sumA((a) => a.counts.changes.wrong), unmatched: sumA((a) => a.counts.changes.unmatched), ambiguous: sumA((a) => a.counts.changes.ambiguous), unevaluated: sumA((a) => a.counts.changes.unevaluated) },
    wrong_acceptance_runs: { status: WRONG_ACCEPTANCE_EVALUATION.status, evidence: runsA((a) => a.counts.changes.wrong > 0), undecided: runsA((a) => unjudgedChanges(a) - a.counts.changes.wrong > 0) },
    changes: { added: sumA((a) => a.changes.added), changed: sumA((a) => a.changes.changed), removed: sumA((a) => a.changes.removed) }, decisions: sumA((a) => a.decisions),
  };
  const fulfillment = {
    v1: { label: AGGREGATION_VERSIONS.v1, partial: v1(P), writable: v1(W), all: v1(rows) },
    v2: { label: AGGREGATION_VERSIONS.v2, partial: v2(P), writable: v2(W), all: v2(rows) },
    // 了承後系の分母・分子は v2 と同じ。未評価（変更が当てた判定の数と、その本の数）を添える
    accepted: { label: SCORING_SYSTEMS.accepted, partial: fa(PA), writable: fa(WA), all: fa(inScope), unevaluated: { checks: metrics_accepted.unevaluated_checks, runs: unevaluatedRuns.length } },
  };
  // 台本の照合の集計（#427）：対象は往復の記録のある本。runs_ok ＝ 問いが無いか、全部の問いが台本で答えられ工場の答えと同じ本
  const scripted = rows.filter((r) => r.script.status !== "none");
  const sumS = (k) => sum(scripted, (r) => r.script[k]);
  const runsS = (f) => fmt(scripted.filter((r) => f(r.script.status)).length, scripted.length);
  const metrics_script = {
    mode: SCRIPT_MODE, label: "台本は採点で事後に当てる（工場は全部推奨で進んだ）。不明・決められない・台本と違う答えで進んだ本の判定と合格率は変えず、ここで数える",
    runs: scripted.length, questions: sumS("questions"), scripted: sumS("scripted"), agreed: sumS("agreed"), disagreed: sumS("disagreed"), unknown: sumS("unknown"), unresolved: sumS("unresolved"),
    runs_ok: runsS((st) => st === "ok" || st === "no-questions"), runs_disagreed: runsS((st) => st === "disagreed"), runs_unanswered: runsS((st) => st === "unanswered"),
  };
  const bySubject = Object.fromEntries(evalSet.subjects.map((s) => { const xs = rows.filter((r) => r.subject === s), xa = xs.filter((r) => r.fulfillment_accepted !== null); return [s, { pass: fmt(xs.filter(pass).length, xs.length), S1: `${xs.filter((r) => r.style === "S1" && pass(r)).length}/${xs.filter((r) => r.style === "S1").length}`, S2: `${xs.filter((r) => r.style === "S2" && pass(r)).length}/${xs.filter((r) => r.style === "S2").length}`, pass_accepted: fmt(xa.filter(passAccepted).length, xa.length) }]; }));
  let completion = reconcile(outRoot, evalSet);
  // 採点に使った定義とエンジン（<repo> から読み込んだ ev）・組が参照する採点の定義の実体・集計のコード（実行中のこのファイル）・spec-engine の dist の指紋。
  // 条件のファイル（計測の始めに記録）の値と照合する
  const aggregator = fileURLToPath(import.meta.url);
  const scoring = { dir: relative(repo, ev), aggregator: { path: relReal(repo, aggregator), sha256: sha256(readFileSync(aggregator)) }, ...scoringFingerprint(ev, aggregator, evalSet.definitions) };
  const se = fingerprintDir(specEngineDist), as = fingerprintDir(appspecDist);
  const matches = (mine, theirs) => (theirs === undefined || theirs === null ? null : mine === theirs);
  // 読んだ定義ファイルと台本の指紋（#427）。条件のファイルの値（set.sha256・scripts.fingerprint）と照合する
  const scriptsFp = scriptsFingerprint(evalSet.scripts);
  const set = { id: evalSet.set.id, version: evalSet.set.version, role: evalSet.set.role, path: relReal(repo, evalSet.path), sha256: evalSet.sha256 };
  const fingerprints = {
    scoring,
    spec_engine: { dist_dir: relative(repo, specEngineDist), fingerprint: se.fingerprint, files: se.files },
    // 契約の検査に使った dist（#426）。条件のファイルには無いので照合しない
    appspec_schema: { dist_dir: relative(repo, appspecDist), fingerprint: as.fingerprint, files: as.files },
    set: { path: set.path, sha256: set.sha256 },
    scripts: scriptsFp,
    conditions: cond === null ? null : { schema: cond.schema ?? null, signature: cond.signature ?? null, factory: cond.factory?.fingerprint ?? null, spec_engine: cond.spec_engine?.fingerprint ?? null, scoring: cond.scoring?.fingerprint ?? null, judge: cond.judge?.configuration ?? null, set: cond.set?.sha256 ?? null, scripts: cond.scripts?.fingerprint ?? null },
    scoring_matches_conditions: matches(scoring.fingerprint, cond?.scoring?.fingerprint),
    spec_engine_matches_conditions: matches(se.fingerprint, cond?.spec_engine?.fingerprint),
    set_matches_conditions: matches(set.sha256, cond?.set?.sha256),
    scripts_matches_conditions: matches(scriptsFp.fingerprint, cond?.scripts?.fingerprint),
  };
  // 凍結した組のファイルの指紋（#498）：条件の frozen.path（<repo> からの相対。絶対も通す）を読み、条件の frozen.sha256 と照合する。読めなければ null
  let frozenSha = null;
  if (typeof cond?.frozen?.path === "string" && cond.frozen.path !== "") { try { frozenSha = sha256(readFileSync(resolveFrom(repo, cond.frozen.path))); } catch { frozenSha = null; } }
  fingerprints.frozen = frozenSha;
  fingerprints.frozen_matches_conditions = !isObj(cond?.frozen) ? null : isHex64(cond.frozen.sha256) ? frozenSha === cond.frozen.sha256 : false;
  // 入れ子の conditions.frozen は v4・v5 の条件のときだけ（v1〜v3 の旧版の形を変えない）
  if (fingerprints.conditions !== null && hasMode(cond.schema)) fingerprints.conditions.frozen = isObj(cond.frozen) && isHex64(cond.frozen.sha256) ? cond.frozen.sha256 : null; // 入力の文字列を通さない（指摘 5）
  // 予定した本ごとの記録（#498。分母は予定した本の全部。条件の予定を検証できなければ採点した本）。新しいファイルの読み込みは例外を外に出さない
  const absentRead = { status: "absent", value: null };
  const factIds = planned.length > 0 ? [...planned].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) : runDirs(outRoot).filter((d) => evalSet.byId.has(patternOf(d)));
  const facts = [];
  for (const run of factIds) {
    const dir = join(outRoot, run);
    const state = !existsSync(dir) ? "unexecuted" : !existsSync(join(dir, "summary.line.json")) ? "incomplete" : "executed";
    const sl = state === "executed" ? readJsonSafe(join(dir, "summary.line.json")) : absentRead;
    const pr = state === "executed" ? readJsonSafe(join(dir, "bundle/plan-record.json")) : absentRead;
    const fact = { run, state, sl: isObj(sl.value) ? sl.value : null, pr: pr.value, prStatus: pr.status, row: rows.find((r) => r.run === run) ?? null };
    // 漏斗の完走の内訳・unverified の内訳（検証の記録）と停止段の decl-check:limit（v1.1α の検証の記録の枯渇）。#538
    if (state === "executed") {
      const v11 = readJsonSafe(join(dir, V11A_RECORDS.verification)).value, counts = isObj(v11) ? v11[V11A_EXHAUSTED_PATH[0]] : null;
      Object.assign(fact, { verification: readJsonSafe(join(dir, VERIFICATION_PATH)).value, exhausted: isObj(counts) && Number.isInteger(counts[V11A_EXHAUSTED_PATH[1]]) ? counts[V11A_EXHAUSTED_PATH[1]] : null });
      // 試験の結果の記録（#539。不一致・未解決の試験の分類の正本）
      fact.tests = readJsonSafe(join(dir, TESTS_PATH)).value;
    }
    if (mode === "plan-only" && state === "executed") {
      const env = readJsonSafe(join(dir, PLAN_RESULT_PATH));
      fact.envelope = env.status !== "ok" ? { status: env.status, reasons: [] }
        : await checkPlanResult(env.value, { recordOutcome: isObj(pr.value) && typeof pr.value.outcome === "string" ? pr.value.outcome : null, sourceText: evalSet.byId.get(patternOf(run)).requestText + "\n", checkConfirmedPlan, planDigest });
    }
    if (mode === "build-from" && state === "executed") {
      const br = readJsonSafe(join(dir, BUILD_RECORD_PATH));
      Object.assign(fact, { br: br.value, brStatus: br.status, lines: jsonLines(join(dir, "stdout.log")) });
    }
    facts.push(fact);
  }
  // 経路 v1.2 の旗の組の照合（#557。v1.2 の条件のときだけ）：起動した本の報告を条件の組と照らし直し、1 本でも一致しなければ照合を未照合にする（完了に丸めない）
  if (cond?.schema === CONDITIONS_V7) {
    const v12 = v12FlagsOf(cond, facts);
    evaluation.v12_flags = v12;
    completion = v12.status === "verified" ? { ...completion, unverified: [] }
      : { ...completion, status: "unverified", label: COMPLETION_LABELS.unverified, reasons: [...completion.reasons, `旗の組の照合が通らない ${v12.launched - v12.counts.match} 本（v12-flags）`], unverified: [V12_UNVERIFIED_CHECK] };
  }
  const metrics_plan = mode === "e2e" || mode === "plan-only" ? planMetrics(facts, { live: cond?.scripts?.mode === "live", planOnly: mode === "plan-only" }) : null;
  const metrics_build = mode === "build-from" ? buildMetrics(facts, cond.frozen) : null;
  // Plan の表と Build の表（#493）。既存の行・指標とは別の欄に置く。plan-only は Build の表を 0 本、build-from は予定した本の全部（#498）
  const tables = planBuildTables(tableInputs.map((t) => ({ ...t, row: rows.find((r) => r.run === t.run) ?? null })), {
    mode, buildEntries: mode === "build-from" ? facts.map((f) => ({ run: f.run, sl: f.sl, row: f.row })) : null, frozenMissing: mode === "build-from" ? cond.frozen.missing.length : null,
  });
  // 漏斗・pass^k・判定の 3 系統・unverified の内訳（#538）。分母は予定した本（facts）。k と P は条件の params（予定を検証できなければ採点した本から）
  const funnel = funnelOf(facts.map((f) => ({ state: f.state, summary: isObj(f.sl?.summary) ? f.sl.summary : null, verification: f.verification ?? null, exhausted: f.exhausted ?? null })));
  const patterns = planned.length > 0 ? cond.params.patterns : [...new Set(factIds.map(patternOf))];
  const k = planned.length > 0 ? cond.params.runs : Math.max(0, ...factIds.map((id) => Number(id.split("-r")[1])));
  const pass_k = passKOf(patterns, k, (id) => { const f = facts.find((x) => x.run === id); return f !== undefined && f.state === "executed" && isObj(f.row) && pass(f.row); });
  const verdicts = verdictsOf(facts), unverified_details = unverifiedDetailsSummary(facts);
  // 内外の表と不一致・未解決の試験の分類（#539）。分母は予定した本（facts）
  const agreement = agreementOf(facts), test_findings = testFindingsSummary(facts);
  // 段単位の走り（#545）：段の通過率と範囲の中の漏斗だけを出す。原文系・了承後系の PASS と納品の欄は計算しない（null と理由 stage-run）
  if (mode === STAGE_RUN_MODE) return stageOutputOf({ outRoot, cond, planned, stageAbsent, set, evaluation, completion, fingerprints });
  return { rubric: "v5", aggregation_versions: AGGREGATION_VERSIONS, scoring_systems: SCORING_SYSTEMS, set, metrics, metrics_accepted, metrics_script, fulfillment, completion, fingerprints, bySubject, rows, tables, evaluation, metrics_plan, metrics_build, funnel, pass_k, verdicts, unverified_details, agreement, test_findings };
}

// ── 匿名の集計（回帰用・保留用の組）：許可した欄だけを組み立てる。入力の文字列をそのまま通さない
const HEX64 = /^[0-9a-f]{64}$/;
/** 匿名で出す指標（数と区間だけ。factory_verdicts は別に既知の値へまとめる） */
export const ANONYMOUS_METRICS = ["generated", "final_static", "spec_pass_writable", "missed_partial", "fulfillment_partial", "spec_pass_partial", "false_claim_runs", "within_time_cost", "cost_total_usd"];
/** 匿名で出す了承後系の指標（数と区間だけ。#426）。本数・件数は別に整数だけを、未評価の状態は既知の値だけを通す */
export const ANONYMOUS_ACCEPTED_METRICS = ["spec_pass_writable", "missed_partial", "spec_pass_partial", "unevaluated_runs", "unverified_runs", "wrong_exclusion_runs", "undecided_exclusion_runs"];
const hashOrNull = (x) => (typeof x === "string" && HEX64.test(x) ? x : null);
const enumOrUnknown = (allowed, x) => (x === null || x === undefined ? null : allowed.includes(x) ? x : "unknown");
const boolOrNull = (x) => (typeof x === "boolean" ? x : null);
const intOrNull = (x) => (Number.isInteger(x) ? x : null);
const countOrNull = (xs) => (Array.isArray(xs) ? xs.length : null);
/**
 * 行・題材ごとの表・ファイルの一覧を落とし、指標の数と区間・照合の本数・指紋だけにする。
 * 判定の値は既知の列挙（FACTORY_VERDICTS）か unknown にまとめ、止まった理由はコード（STOP_CODES）に、指紋は 64 桁の 16 進だけを通し、
 * schema と判定の口の構成は既知の値か unknown にする。測定 ID・署名以外の自由な文字列は出ない
 */
const anonymousTables = (t) => {
  if (t === undefined || t === null) return null;
  const p = t.plan?.total ?? {}, b = t.build?.total ?? {};
  const bv = Object.fromEntries([...FACTORY_VERDICTS, "unknown"].map((k) => [k, 0]));
  for (const [k, n] of Object.entries(b.factory_verdicts ?? {})) bv[FACTORY_VERDICTS.includes(k) ? k : "unknown"] += Number.isInteger(n) ? n : 0;
  return {
    plan: { runs: intOrNull(p.runs), outcomes: Object.fromEntries(PLAN_TABLE_OUTCOMES.map((k) => [k, intOrNull(p.outcomes?.[k])])), confirmed: p.confirmed ?? null, questions: intOrNull(p.questions), rounds: intOrNull(p.rounds) },
    build: { runs: intOrNull(b.runs), excluded: intOrNull(b.excluded), excluded_outcomes: Object.fromEntries(PLAN_TABLE_OUTCOMES.filter((k) => k !== "confirmed").map((k) => [k, intOrNull(b.excluded_outcomes?.[k])])), factory_verdicts: bv, pass: b.pass ?? null },
  };
};
// 匿名の Plan の集計と Build だけの集計（#498）：本数・件数（整数）・率（数と区間の形の文字列だけ）・既知の値・時間と費用の 4 つ。
// 止まり方の分類の符号・包みの理由の符号・本ごとの値・本の ID は出さない
const RATE = /^\d+\/\d+（(?:\d+\.\d%|-)・95% 区間 \d+\.\d%〜\d+\.\d%）$/;
const rateOrNull = (x) => (typeof x === "string" && RATE.test(x) ? x : null);
const numOrNull = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const anonStat = (x) => ({ observed: intOrNull(x?.observed), missing: intOrNull(x?.missing), total: numOrNull(x?.total), median: numOrNull(x?.median) });
const intsOf = (x, keys) => Object.fromEntries(keys.map((k) => [k, intOrNull(x?.[k])]));
const anonCountMean = (x) => ({ total: intOrNull(x?.total), mean: numOrNull(x?.mean), runs: intOrNull(x?.runs) });
const anonymousPlanMetrics = (m) => (!isObj(m) ? null : {
  ...intsOf(m, ["runs", "unexecuted", "incomplete", "unrecorded", "record_unreadable"]), outcomes: intsOf(m.outcomes, PLAN_TABLE_OUTCOMES), confirmed: rateOrNull(m.confirmed),
  questions: anonCountMean(m.questions), rounds: anonCountMean(m.rounds), free_text: intsOf(m.free_text, ["answers", "runs", "unreadable"]),
  duration_ms: anonStat(m.duration_ms), usd: anonStat(m.usd),
  script: !isObj(m.script) ? null : { mode: enumOrUnknown(SCRIPT_MODES, m.script.mode ?? null), runs: intOrNull(m.script.runs), states: intsOf(m.script.states, [...SCRIPT_MATCH_STATES, "unknown-state"]), all_answered: rateOrNull(m.script.all_answered), no_questions: intOrNull(m.script.no_questions), unrecorded: intOrNull(m.script.unrecorded) },
  envelope: !isObj(m.envelope) ? null : intsOf(m.envelope, ["runs", "checked", "passed", "failed", "absent", "unreadable"]),
});
const anonymousBuildMetrics = (m) => (!isObj(m) ? null : {
  ...intsOf(m, ["runs", "frozen_missing", "unexecuted", "incomplete"]), exit_classes: intsOf(m.exit_classes, [...EXIT_CLASSES, "unknown"]), exit_2: intOrNull(m.exit_2), envelope_refusals: intOrNull(m.envelope_refusals),
  return_to_plan: { count: intOrNull(m.return_to_plan?.count), rate: rateOrNull(m.return_to_plan?.rate), inconsistent: intOrNull(m.return_to_plan?.inconsistent), unrecorded: intOrNull(m.return_to_plan?.unrecorded) },
  frozen_match: intsOf(m.frozen_match, ["checked", "mismatched"]), factory_verdicts: intsOf(m.factory_verdicts, [...FACTORY_VERDICTS, "unknown", "absent"]), pass: rateOrNull(m.pass),
  duration_ms: anonStat(m.duration_ms), usd: anonStat(m.usd),
});
/** 匿名の照合（本数・件数・止まった理由のコードだけ）。段単位の走り（#545）は入力なしの件数を足す */
const anonymousCompletion = (c) => {
  const status = enumOrUnknown(Object.keys(COMPLETION_LABELS), c.status);
  return { status, label: COMPLETION_LABELS[status] ?? "unknown", planned: intOrNull(c.planned), executed: intOrNull(c.executed), scored: intOrNull(c.scored), unexecuted: countOrNull(c.unexecuted), incomplete: countOrNull(c.incomplete), extra: countOrNull(c.extra), unscored: countOrNull(c.unscored), stop_code: enumOrUnknown(STOP_CODES, c.latest_record?.stop_code ?? null), ...("stage_input_absent" in c ? { stage_input_absent: intOrNull(c.stage_input_absent) } : {}), ...("unverified" in c ? { unverified: (Array.isArray(c.unverified) ? c.unverified : []).filter((x) => x === V12_UNVERIFIED_CHECK) } : {}) };
};
/** 匿名の指紋（64 桁の 16 進と既知の値と一致だけ）。schemas は条件の版の既知の値（段単位の走りは v6 を足す。#545） */
const anonymousFingerprints = (f, schemas = CONDITIONS_SCHEMAS) => {
  const cond = f.conditions;
  return {
    scoring: hashOrNull(f.scoring.fingerprint), spec_engine: hashOrNull(f.spec_engine.fingerprint), appspec_schema: hashOrNull(f.appspec_schema?.fingerprint ?? null),
    set: hashOrNull(f.set?.sha256), scripts: hashOrNull(f.scripts?.fingerprint),
    conditions: cond === null ? null : { schema: enumOrUnknown(schemas, cond.schema), signature: hashOrNull(cond.signature), factory: hashOrNull(cond.factory), spec_engine: hashOrNull(cond.spec_engine), scoring: hashOrNull(cond.scoring), judge: enumOrUnknown(JUDGE_CONFIGURATIONS, cond.judge), set: hashOrNull(cond.set), scripts: hashOrNull(cond.scripts), ...("frozen" in cond ? { frozen: hashOrNull(cond.frozen) } : {}) },
    scoring_matches_conditions: boolOrNull(f.scoring_matches_conditions), spec_engine_matches_conditions: boolOrNull(f.spec_engine_matches_conditions),
    set_matches_conditions: boolOrNull(f.set_matches_conditions), scripts_matches_conditions: boolOrNull(f.scripts_matches_conditions),
    // 凍結した組（#498）：ハッシュと一致だけ
    frozen: hashOrNull(f.frozen ?? null), frozen_matches_conditions: boolOrNull(f.frozen_matches_conditions),
  };
};
export function anonymize(full) {
  const c = full.completion, f = full.fingerprints, m = full.metrics, ma = full.metrics_accepted ?? {}, ms = full.metrics_script ?? {};
  const verdicts = Object.fromEntries([...FACTORY_VERDICTS, "unknown"].map((k) => [k, 0]));
  for (const [k, n] of Object.entries(m.factory_verdicts ?? {})) verdicts[FACTORY_VERDICTS.includes(k) ? k : "unknown"] += Number.isInteger(n) ? n : 0;
  return {
    rubric: "v5", anonymous: true, aggregation_versions: AGGREGATION_VERSIONS, scoring_systems: SCORING_SYSTEMS, runs: full.rows.length,
    metrics: { ...Object.fromEntries(ANONYMOUS_METRICS.map((k) => [k, m[k]])), factory_verdicts: verdicts },
    // 了承後系（#426）：本数・件数は整数だけ、率は数と区間の文字列だけ、未評価の状態は既知の値だけ。要件の文・部分の ID・当たった先は出さない
    metrics_accepted: {
      runs: intOrNull(ma.runs), confirmed: intOrNull(ma.confirmed), absent: intOrNull(ma.absent),
      absent_reasons: Object.fromEntries(ABSENT_REASONS.map((k) => [k, intOrNull(ma.absent_reasons?.[k])])), invalid: intOrNull(ma.invalid),
      ...Object.fromEntries(ANONYMOUS_ACCEPTED_METRICS.map((k) => [k, ma[k] ?? null])),
      unevaluated_checks: intOrNull(ma.unevaluated_checks), wrong_exclusions: intOrNull(ma.wrong_exclusions), undecided_exclusions: intOrNull(ma.undecided_exclusions),
      // 未検証の有効な要件は数だけ（要件の ID・文は出さない）
      unverified_requirements: intOrNull(ma.unverified_requirements), unverified_sources: Object.fromEntries(UNVERIFIED_SOURCES.map((s) => [s, intOrNull(ma.unverified_sources?.[s])])),
      // 誤った了承は未評価のまま出す（状態と件数。0 件に丸めない）
      wrong_acceptances: { status: enumOrUnknown(EVALUATION_STATUSES, ma.wrong_acceptances?.status ?? null), ...Object.fromEntries(["evidence", "unmatched", "ambiguous", "unevaluated"].map((k) => [k, intOrNull(ma.wrong_acceptances?.[k])])) },
      wrong_acceptance_runs: { status: enumOrUnknown(EVALUATION_STATUSES, ma.wrong_acceptance_runs?.status ?? null), evidence: ma.wrong_acceptance_runs?.evidence ?? null, undecided: ma.wrong_acceptance_runs?.undecided ?? null },
      changes: Object.fromEntries(["added", "changed", "removed"].map((k) => [k, intOrNull(ma.changes?.[k])])), decisions: intOrNull(ma.decisions),
    },
    // 台本の照合（#427）：件数は整数だけ、率は数と区間の文字列だけ、当て方は既知の値だけ。問いの文・事項の ID・台本の件の ID は出さない
    metrics_script: { mode: enumOrUnknown(SCRIPT_MODES, ms.mode ?? null), ...Object.fromEntries(["runs", "questions", "scripted", "agreed", "disagreed", "unknown", "unresolved"].map((k) => [k, intOrNull(ms[k])])), ...Object.fromEntries(["runs_ok", "runs_disagreed", "runs_unanswered"].map((k) => [k, ms[k] ?? null])) },
    // Plan の表と Build の表（#493）：件数（整数）と率（数と区間の文字列）だけ。行・止まり方の分類のコード・時間・費用は出さない
    tables: anonymousTables(full.tables),
    // 組（#427）：版と役割と指紋だけ（ID・題名は出さない）
    set: { version: intOrNull(full.set?.version), role: enumOrUnknown(EVAL_SET_ROLES, full.set?.role ?? null), sha256: hashOrNull(full.set?.sha256) },
    fulfillment: Object.fromEntries(["v1", "v2", "accepted"].map((v) => [v, { label: v === "accepted" ? SCORING_SYSTEMS.accepted : AGGREGATION_VERSIONS[v], partial: full.fulfillment[v]?.partial ?? null, writable: full.fulfillment[v]?.writable ?? null, all: full.fulfillment[v]?.all ?? null, ...(v === "accepted" ? { unevaluated: { checks: intOrNull(full.fulfillment.accepted?.unevaluated?.checks), runs: intOrNull(full.fulfillment.accepted?.unevaluated?.runs) } } : {}) }])),
    completion: anonymousCompletion(c),
    // v1.2 の条件（#557）は版の既知の値に v7 を足す（それ以外の条件は今までの一覧）
    fingerprints: anonymousFingerprints(f, f.conditions?.schema === CONDITIONS_V7 ? [...CONDITIONS_SCHEMAS, CONDITIONS_V7] : CONDITIONS_SCHEMAS),
    // 評価の種類と、Plan の集計・Build だけの集計（#498）。v1.2 の旗の組（#557）は照合を通った旗の名前と真偽と件数だけ
    evaluation: { mode: enumOrUnknown(EVALUATION_MODES, full.evaluation?.mode ?? null), build_applicable: boolOrNull(full.evaluation?.build_applicable), ...(isObj(full.evaluation) && Object.keys(full.evaluation).includes("pipeline") ? { pipeline: enumOrUnknown(PIPELINES, full.evaluation.pipeline) } : {}), ...(isObj(full.evaluation?.v12_flags) ? { v12_flags: anonymousV12Flags(full.evaluation.v12_flags) } : {}) },
    metrics_plan: anonymousPlanMetrics(full.metrics_plan), metrics_build: anonymousBuildMetrics(full.metrics_build),
    // 漏斗・pass^k・判定の 3 系統・unverified の内訳（#538）：件数と率だけ。段の ID は既知の一覧、P の ID・本の ID は出さない
    ...anonymous538(full),
    // 内外の表と試験の分類（#539）：件数だけ。本の ID・試験 ID・detail は出さない
    ...anonymous539(full),
  };
}
// #538 の匿名の欄。率は数と区間の形の文字列か「今回未観測（0/予定）」だけを通す
const UNOBSERVED = /^今回未観測（0\/\d+）$/;
const rateOrLabel = (x) => rateOrNull(x) ?? (typeof x === "string" && UNOBSERVED.test(x) ? x : null);
const REACHED = /^\d+\/\d+$/;
const anonymousFunnel = (f, ids = rowStageIds(IDS_STAGE_IDS.some((id) => isObj(f?.stages?.[id])))) => (!isObj(f) ? null : {
  ...intsOf(f, ["planned", "executed"]),
  stages: Object.fromEntries(ids.map((id) => {
    const s = f.stages?.[id];
    return [id, { ...intsOf(s, ["planned", "reached", "first_pass", "passed", "stopped"]), reached_label: typeof s?.reached_label === "string" && (REACHED.test(s.reached_label) || UNOBSERVED.test(s.reached_label)) ? s.reached_label : null, code_stage: boolOrNull(s?.code_stage), rates: Object.fromEntries(["first_pass", "passed", "stopped"].map((k) => [k, rateOrLabel(s?.rates?.[k])])) }];
  })),
  completed: intsOf(f.completed, ["runs", "no_mismatch", "with_mismatch", "missing"]),
  stops: (() => { const vals = {}; for (const [k, n] of Object.entries(isObj(f.stops) ? f.stops : {})) { const key = knownStopValue(k) ? k : "unknown"; vals[key] = (vals[key] ?? 0) + (Number.isInteger(n) ? n : 0); } return vals; })(),
});
const anonymousPassK = (p) => (!isObj(p) ? null : { ...intsOf(p, ["k", "patterns", "count"]), rate: rateOrNull(p.rate) });
const anonymousVerdicts = (v) => {
  if (!isObj(v)) return null;
  const system = (x, list) => ({ counts: intsOf(x?.counts, list), ...Object.fromEntries(["executed", "delivered"].map((d) => [d, Object.fromEntries(list.filter((k) => k !== "not_run").map((k) => [k, rateOrNull(x?.[d]?.[k])]))])) });
  return { ...intsOf(v, ["planned", "executed", "delivered"]), source: system(v.source, SOURCE_VERDICTS), accepted: system(v.accepted, ACCEPTED_VERDICTS), factory: system(v.factory, FACTORY_VERDICTS4) };
};
// #539 の匿名の欄：内外の表の件数（既知の値の表）と、試験の分類の件数（本の ID・試験 ID・detail を出さない）
const anonymousAgreement = (a) => (!isObj(a) ? null : {
  ...intsOf(a, ["planned", "executed", "not_run"]),
  source: { table: Object.fromEntries(FACTORY_VERDICTS4.map((fv) => [fv, intsOf(a.source?.table?.[fv], SOURCE_COLUMNS)])) },
  accepted: { table: Object.fromEntries(FACTORY_VERDICTS4.map((fv) => [fv, intsOf(a.accepted?.table?.[fv], ACCEPTED_COLUMNS)])) },
});
const anonymousTestFindings = (t) => (!isObj(t) ? null : { ...intsOf(t, ["runs", "observed", "missing", "findings", "mismatches", "unresolved", "inconsistent", "malformed"]), sources: intsOf(t.sources, FINDING_SOURCES), classes: intsOf(t.classes, FINDING_CLASSES) });
const anonymous539 = (x) => ({ agreement: anonymousAgreement(x.agreement), test_findings: anonymousTestFindings(x.test_findings) });
const anonymous538 = (x) => ({ funnel: anonymousFunnel(x.funnel), pass_k: anonymousPassK(x.pass_k), verdicts: anonymousVerdicts(x.verdicts), unverified_details: !isObj(x.unverified_details) ? null : intsOf(x.unverified_details, ["runs", "observed", "missing", "total", "runs_with_unverified"]) });

// ── v1.1α の比較（#513。設計書 07 §4・D7・D17・追加判断 B。README の v1.1α の節）
// 計測（run-agent.mjs --compare・--make-pairs）と採点（--compare）が同じ定数と純粋な関数を使う（道具は 2 本で 1 組。定数を 2 か所に書かない）。
// 記録に写すのは既知の値・件数・SHA だけ。対のファイル・比較元のパス・子の出力の中身は写さない
/** 工場の経路（run-agent.mjs --pipeline。packages/factory の入口の --pipeline と同じ値。#511。v1.2 は #547・#557）。計測と採点が共有する一覧 */
export const PIPELINES = ["v1", "v1.1a", "v1.2"];
/** 比較の群（出力先の下のディレクトリの名前で、群の経路の名前と同じ）と役割。v1 ＝ 比較元の checkout（--pipeline 無し）、v1.1a ＝ 候補の checkout（--pipeline v1.1a） */
export const COMPARE_GROUPS = ["v1", "v1.1a"];
export const COMPARE_ROLES = { v1: "baseline", "v1.1a": "candidate" };
/** 対のファイルの版（--make-pairs が書き、--compare が起動の前に検査する） */
export const PAIRS_SCHEMA = "musunest-eval/compare-pairs/v1";
/** 比較の出力先の直下のファイル：比較の記録・比較の起動の記録（接頭辞＋時刻）・対のファイルの写し・採点の出力（接頭辞。--label で -<label> を足す） */
export const COMPARISON_FILE = "comparison.json";
export const COMPARISON_SCHEMA = "musunest-eval/compare-record/v1";
export const COMPARE_RUN_PREFIX = "compare-run-";
export const COMPARE_RUN_SCHEMA = "musunest-eval/compare-run/v1";
export const COMPARE_PAIRS_COPY = "pairs.json";
export const SCORE_COMPARE_FILE = "score-compare";
export const SCORE_COMPARE_SCHEMA = "musunest-eval/score-compare/v1";
/** 対ごとの起動の状態（両方・先行だけ・未起動） */
export const PAIR_STATES = ["both", "first-only", "unstarted"];
/** 比較の条件の種類：official ＝ 正式な比較の条件（OFFICIAL_COMPARE）を全部満たす、diagnostic ＝ どれかが違う（断らない。違った項目の名前を残す） */
export const COMPARE_PROFILES = ["official", "diagnostic"];
/** 正式な比較の条件（設計書 07 §4・D7・D17。2026-10-16 所有者の決定）。比較元の commit・凍結した組 v1 のファイル全体の SHA-256・反復・effort・締切・1 本の予算・合計の並列・全体の上限・採点 */
export const OFFICIAL_COMPARE = {
  baseline_commit: "2cd1586f856fb1cdecf75ef035826cbffe539e69", baseline_dirty: false,
  frozen_sha256: "1bed5c0e8cadbc504f3378337b3ea7b8335229ebb135cc7f7760e80ddcd0c9d9", frozen_id: "dev-p1-p10-b-408b202", frozen_version: 1, frozen_adopted: 10,
  runs: 3, effort: "high", deadline_min: 20, factory_budget_usd: 0.3, concurrency: 3, budget_usd: 5, rubric: "v5",
};
/** 採点は API を呼ばないので、全体の予算に数える採点の費用は 0（採点のコードに通信の import が無いことを試験で確かめる） */
export const SCORING_COST_USD = 0;
/** v1 の出力の 10 段（packages/factory の limits.ts の OUTPUT_STAGES の、#505 より前の並び）。条件の params.stage_output_limits にはこの段だけを写す */
export const V1_OUTPUT_STAGES = ["surface", "questions", "requirements", "reverse-check", "design", "test-suite", "write", "correspondence", "repair", "arbitration"];
/** v1.1α の出力の 4 段（#505 が OUTPUT_STAGES に足す）と、A1 で承認した上限（3 つの effort で同じ値） */
export const V11A_OUTPUT_STAGES = ["name-table", "semantic-check", "test-spec", "decl-check"];
export const V11A_APPROVED_LIMITS = { "name-table": 32768, "semantic-check": 16384, "test-spec": 32768, "decl-check": 16384 };
/** A5（#510）の停止の名前（段:種類）と、点検の枯渇で止まった本（stop_reason が limit で、verification の記録の枯渇が 1 以上） */
export const V11A_STOP_NAMES = ["name-table:unmet", "semantic-check:malformed", "test-spec:unmet", "decl-check:malformed", "carry-over:unmet"];
export const DECL_CHECK_LIMIT = "decl-check:limit";
export const EXPECTED_STOPS = [...V11A_STOP_NAMES, DECL_CHECK_LIMIT];
/** 新しい段の停止の名前。0 件の行は、新しい段の記録がある入力でだけ EXPECTED_STOPS の後ろに足す */
export const PENDING_STOP_NAMES = ["vocabulary:unmet", "mapping:unmet"];
/** 要約の stop_reason の既知の値（run-agent.mjs の STOP_VALUES と同じ） */
export const STOP_REASON_VALUES = ["completed", "stagnation", "limit", "unresolved", "deadline", ...FAILURE_KINDS];
/**
 * A5 の追加の記録（納品物の artifacts の下。packages/factory/src/v11a/bundle-v11a.ts の V11A_ARTIFACT_NAMES）の場所と、採点が読む欄：
 * verification-v11a.json の decl_check.exhausted（B3' の枯渇の件数。DeclCheckCounts）、carry-over.json の entries[]（要件ごと）の reasons[].origin（出どころ）
 */
export const V11A_RECORDS = { verification: "bundle/artifacts/verification-v11a.json", carry_over: "bundle/artifacts/carry-over.json" };
export const V11A_EXHAUSTED_PATH = ["decl_check", "exhausted"];
export const CARRY_OVER_ENTRIES_FIELD = "entries";
/** 持ち越しの出どころ（packages/factory/src/v11a/carry-over.ts の CARRY_OVER_ORIGINS。設計書 07 §1.2） */
export const CARRY_OVER_SOURCES = ["name-table", "semantic-check", "decl-check", "coverage"];

/** 工場の段ごとの出力の上限の表（effort の 1 行）から、v1 の 10 段（表の並びのまま）と v1.1α の 4 段（無ければ null）を分ける。表が写像でなければ v1 はそのまま */
export function outputLimitsOf(table) {
  if (!isObj(table)) return { v1: table, v11a: null };
  const v1 = Object.fromEntries(Object.entries(table).filter(([k]) => V1_OUTPUT_STAGES.includes(k)));
  const v11a = V11A_OUTPUT_STAGES.some((k) => k in table) ? Object.fromEntries(V11A_OUTPUT_STAGES.map((k) => [k, Number.isFinite(table[k]) ? table[k] : null])) : null;
  return { v1, v11a };
}
/** v1.1α の 4 段の上限が A1 の承認値と同じか */
export const limitsApproved = (v11a) => isObj(v11a) && V11A_OUTPUT_STAGES.every((k) => v11a[k] === V11A_APPROVED_LIMITS[k]) && Object.keys(v11a).length === V11A_OUTPUT_STAGES.length;
/** 正式な比較の条件の判定（純粋な関数）：facts の各項目が OFFICIAL_COMPARE と同じなら official、違えば diagnostic と違った項目の名前（定数の順） */
export function compareProfile(facts) {
  const mismatches = Object.keys(OFFICIAL_COMPARE).filter((k) => !isObj(facts) || facts[k] !== OFFICIAL_COMPARE[k]);
  return { profile: mismatches.length === 0 ? "official" : "diagnostic", mismatches };
}
const PAIR_PID = /^P\d+$/;
/** 対のファイルの中身（--make-pairs）：採用した P（組の順）× 1〜runs を、先行の群を比較元（groups の 0 番目。省略は v1）から交互に並べる */
export function makePairs(adopted, runs, frozenSha256, groups = COMPARE_GROUPS) {
  const pairs = alternatePairs(adopted.flatMap((pid) => Array.from({ length: runs }, (_, i) => ({ pid, r: i + 1 }))), groups);
  return { schema: PAIRS_SCHEMA, frozen_sha256: frozenSha256, groups: [...groups], runs, pairs };
}
/** 対の交互の順：並べた対ごとに、先行の群を groups の 0 番目から交互に置く（v1.1α の比較と段だけの対の比較で同じ関数。#545） */
export const alternatePairs = (keys, groups) => keys.map((p, i) => ({ ...p, first: groups[i % 2] }));
/** 対のファイルの形だけの検査（版・群・runs・各対の形・重複・交互）。落ちれば符号、通れば null */
export function pairsShapeProblem(v, { schema = PAIRS_SCHEMA, groups = COMPARE_GROUPS } = {}) {
  if (!isObj(v) || v.schema !== schema || !Array.isArray(v.groups) || JSON.stringify(v.groups) !== JSON.stringify(groups) || !Array.isArray(v.pairs)) return "compare:pairs-schema";
  if (!isHex64(v.frozen_sha256)) return "compare:pairs-frozen";
  if (!Number.isInteger(v.runs) || v.runs < 1) return "compare:pairs-runs";
  if (v.pairs.length === 0) return "compare:pairs-empty";
  if (!v.pairs.every((p) => isObj(p) && typeof p.pid === "string" && PAIR_PID.test(p.pid) && Number.isInteger(p.r) && p.r >= 1 && groups.includes(p.first))) return "compare:pairs-shape";
  const keys = v.pairs.map((p) => `${p.pid}-r${p.r}`);
  if (new Set(keys).size !== keys.length) return "compare:pairs-duplicate";
  if (v.pairs.some((p, i) => i > 0 && p.first === v.pairs[i - 1].first)) return "compare:pairs-alternation";
  return null;
}
/** 対のファイルの起動の前の検査：形・凍結した組のファイルの SHA-256・採用した P × 1〜runs の全体とちょうど一致（欠落・余り） */
export function pairsProblem(v, { frozenSha256, adopted, groups = COMPARE_GROUPS }) {
  const shape = pairsShapeProblem(v, { groups });
  if (shape !== null) return shape;
  if (v.frozen_sha256 !== frozenSha256) return "compare:pairs-frozen";
  const keys = new Set(v.pairs.map((p) => `${p.pid}-r${p.r}`));
  const expected = adopted.flatMap((pid) => Array.from({ length: v.runs }, (_, i) => `${pid}-r${i + 1}`));
  if (expected.some((k) => !keys.has(k))) return "compare:pairs-missing";
  if (keys.size !== expected.length) return "compare:pairs-extra";
  return null;
}
// ── 経路 v1.2 と比較の群の組（#557。設計書 08 §8.6・§8.7・§9。README §5.13）
// 旗の組の正本は工場の dist の package の入口の V12_PIPELINE_FLAGS（旗の名前 → 真偽）。計測がそれを読んで条件に写し、ここには旗の名前を書かない
/** 経路 v1.2 の名前と、v1.2 の条件の版（v5 に params.v12_flags を足した。v1.2 のときだけ書く。v6 は段単位の走り #545） */
export const V12_PIPELINE = "v1.2";
export const CONDITIONS_V7 = "musunest-factory/agent-accept-conditions/v7";
/** 比較の群の組（--compare-pipelines <比較元>,<候補>）。0 番目は省略と同じ組（COMPARE_GROUPS） */
export const COMPARE_PIPELINE_PAIRS = [["v1", "v1.1a"], ["v1.1a", "v1.2"], ["v1", "v1.2"]];
/** 群の組か（比較の記録・対のファイルの groups。順も見る） */
export const isComparePair = (groups) => Array.isArray(groups) && COMPARE_PIPELINE_PAIRS.some((p) => JSON.stringify(p) === JSON.stringify(groups));
/** --compare-pipelines の値（「比較元,候補」）を受ける組の写し。同じ値・知らない値・ほかの組・3 つ以上は null */
export const comparePipelinesOf = (text) => (typeof text === "string" && isComparePair(text.split(",")) ? text.split(",") : null);
/** 群の役割：比較元 baseline・候補 candidate */
export const compareRolesOf = (groups) => ({ [groups[0]]: "baseline", [groups[1]]: "candidate" });
/** 段の役割の対応表（STAGE_ROLES）の列：v1 は v1 の段、v1.1a と v1.2 は v1.1α の段の名前（段を手書きで足さない） */
export const stageColumnOf = (pipeline) => (pipeline === "v1" ? "v1" : "v1.1a");
/** 差の向きの文の頭（v1,v1.1a では今までの文と同じ文字列） */
export const diffDirectionOf = (groups) => `候補（${groups[1]}）− 比較元（${groups[0]}）`;
/** profile の違いの理由：v1.1a,v1.2 の組は正式な比較（比較元 v1）の組ではない */
export const PROFILE_PIPELINES_REASON = "pipelines";
/** 群の組ごとの正式な比較の条件の判定：比較元が v1 の組は今の定数（compareProfile）、それ以外（v1.1a,v1.2）は diagnostic で違った項目に pipelines を足す（断らない） */
export function compareProfileOf(facts, groups) {
  const base = compareProfile(facts);
  return groups[0] === "v1" ? base : { profile: "diagnostic", mismatches: [...base.mismatches, PROFILE_PIPELINES_REASON] };
}
/** 旗の組の形：写像で 1 つ以上、名前は小文字・数字・ハイフン（点で区切ってよい）、値は真偽（配列・空・真偽でない値は不正形） */
const FLAG_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
export const isFlagMap = (x) => isObj(x) && Object.keys(x).length > 0 && Object.entries(x).every(([k, v]) => FLAG_NAME.test(k) && typeof v === "boolean");
/** 旗の組を名前 → 真偽の集合として照らす（キーの順だけの違いは一致） */
export const sameFlags = (a, b) => isFlagMap(a) && isFlagMap(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
/** 工場の報告 1 つ（要約か条件の記録の v12_flags）の状態：present ＝ 旗の組の形、absent ＝ 欄が無い（undefined）、malformed ＝ それ以外 */
export const V12_REPORT_STATES = ["present", "absent", "malformed"];
/** 本ごとの照合の結果：一致・不一致（条件の組と違う）・欠測・不正形・食い違い（要約と条件の記録で違う） */
export const V12_FLAG_STATUSES = ["match", "mismatch", "missing", "malformed", "inconsistent"];
/** 採点の照合の未照合の理由の符号（completion.unverified） */
export const V12_UNVERIFIED_CHECK = "v12-flags";
/** 報告の値から、本ごとの記録に残す形（旗の組の形のときだけ写す） */
export const v12ReportOf = (raw) => (raw === undefined ? { state: "absent", flags: null } : isFlagMap(raw) ? { state: "present", flags: raw } : { state: "malformed", flags: null });
/** 照合：条件の組 expected と、要約・条件の記録の報告（v12ReportOf の形）。強い順に 不正形 ＞ 欠測 ＞ 食い違い ＞ 不一致 ＞ 一致 */
export function v12FlagsStatus(expected, summary, record) {
  const stateOf = (r) => (!isObj(r) ? "absent" : r.state === "present" ? (isFlagMap(r.flags) ? "present" : "malformed") : r.state === "malformed" ? "malformed" : "absent");
  const states = [stateOf(summary), stateOf(record)];
  if (!isFlagMap(expected) || states.includes("malformed")) return "malformed";
  if (states.includes("absent")) return "missing";
  if (!sameFlags(summary.flags, record.flags)) return "inconsistent";
  return sameFlags(summary.flags, expected) ? "match" : "mismatch";
}
/** 本 1 つの照合：計測が本ごとの記録（summary.line.json）に残した報告を、条件の組と照らし直す（記録に残した結果は信頼しない。報告の欄が無ければ欠測） */
export const v12RunStatusOf = (sl, expected) => (isObj(sl?.v12_flags) ? v12FlagsStatus(expected, sl.v12_flags.summary, sl.v12_flags.record) : isFlagMap(expected) ? "missing" : "malformed");
/**
 * 旗の組の照合の集計（v1.2 の条件。採点の evaluation.v12_flags）：条件の組・起動した本（要約のある本）の数・結果ごとの本の数・一致しない本の ID。
 * 起動した本が全部一致なら verified、1 本でも違えば unverified。未起動の本（未実行・途中）は数えない（照合の未実行・途中のまま）
 */
export function v12FlagsOf(cond, facts) {
  const expected = cond?.params?.v12_flags;
  const launched = facts.filter((f) => f.state === "executed");
  const counts = zeros(V12_FLAG_STATUSES), unverified = [];
  for (const f of launched) { const st = v12RunStatusOf(f.sl, expected); counts[st] += 1; if (st !== "match") unverified.push({ run: f.run, status: st }); }
  return { flags: isFlagMap(expected) ? expected : null, status: isFlagMap(expected) && unverified.length === 0 ? "verified" : "unverified", launched: launched.length, counts, unverified_runs: unverified };
}
/** 匿名の旗の組：照合を通った旗の名前と真偽（通らなければ null）・状態・件数だけ（本の ID は出さない） */
const anonymousV12Flags = (x) => {
  const status = enumOrUnknown(["verified", "unverified"], x?.status ?? null);
  return { status, flags: status === "verified" && isFlagMap(x.flags) ? { ...x.flags } : null, launched: intOrNull(x?.launched), counts: intsOf(x?.counts, V12_FLAG_STATUSES) };
};
/**
 * 群の条件を版ごとに検証する（v1.2 を含む組の照合の前。計測と採点で同じ関数）：v1.2 の群は v7・build-from・旗の組の形、v1・v1.1a の群は v5。
 * 段単位の走りの条件（v6）との混在は compare:conditions-stage、知らない版・群と合わない版は compare:conditions-version。通れば null
 */
export function groupConditionsProblem(cond, group) {
  if (!isObj(cond) || !isObj(cond.params)) return "compare:conditions-version";
  if (cond.schema === CONDITIONS_V6 || cond.params.mode === STAGE_RUN_MODE) return "compare:conditions-stage";
  if (group === V12_PIPELINE) return cond.schema === CONDITIONS_V7 && cond.params.mode === "build-from" && cond.params.pipeline === group && isFlagMap(cond.params.v12_flags) ? null : "compare:conditions-version";
  return cond.schema === CONDITIONS_V5 && cond.params.pipeline === group && !("v12_flags" in cond.params) ? null : "compare:conditions-version";
}
/** 群の params の共通の比較の形：経路・v1.1α の上限の欄・旗の組（意図した差）を除く */
export const comparableParams = (p) => { if (!isObj(p)) return null; const { pipeline: _p, stage_output_limits_v11a: _l, v12_flags: _f, ...rest } = p; return rest; };

/** 全体の予算の打ち切り（D17）：済みの額＋走行中の本の予約＋新しく起こす 1 本の予約 ≤ 上限のときだけ起こす（等しければ起こす）。小数の誤差を避けて 100 万分の 1 USD の整数で比べる */
const microUsd = (x) => Math.round(x * 1e6);
export const launchAllowed = ({ spentUsd, runningCount, reserveUsd, budgetUsd }) => microUsd(spentUsd) + (runningCount + 1) * microUsd(reserveUsd) <= microUsd(budgetUsd);

/** 停止段の値：failure があれば段:種類（既知の段と種類。どちらかが知らない値なら unknown）、無ければ stop_reason（既知の値か unknown）。
 * limit は A5 の verification の記録の枯渇が 1 以上なら decl-check:limit（0 か記録が無ければ今までどおり limit） */
export function stopValueOf(summary, exhausted = null) {
  if (!isObj(summary)) return null;
  const f = summary.failure;
  let v;
  if (isObj(f)) { const st = knownOr(BUILD_STAGE_IDS, f.stage), k = knownOr(FAILURE_KINDS, f.kind); v = st === "unknown" || k === "unknown" ? "unknown" : `${st}:${k}`; }
  else v = knownOr(STOP_REASON_VALUES, summary.stop_reason);
  return v === "limit" && Number.isInteger(exhausted) && exhausted >= 1 ? DECL_CHECK_LIMIT : v;
}
/** 停止段の値として出してよい形（既知の stop_reason・既知の段:既知の種類・decl-check:limit・unknown） */
const knownStopValue = (v) => typeof v === "string" && (v === "unknown" || STOP_REASON_VALUES.includes(v) || v === DECL_CHECK_LIMIT || (v.includes(":") && BUILD_STAGE_IDS.includes(v.split(":")[0]) && FAILURE_KINDS.includes(v.split(":").slice(1).join(":"))));
/** 対の差の集計：差（−1・0・＋1）の件数・n・平均・区間（平均 ± 1.96 × 標本標準偏差 ÷ √n。n < 2 は null）。区間は参考（設計書 07 §4） */
export function pairStats(diffs) {
  const n = diffs.length;
  const counts = { "+1": diffs.filter((d) => d === 1).length, 0: diffs.filter((d) => d === 0).length, "-1": diffs.filter((d) => d === -1).length };
  if (n === 0) return { n, counts, mean: null, sd: null, interval: null };
  const m = diffs.reduce((s, d) => s + d, 0) / n;
  if (n < 2) return { n, counts, mean: round6(m), sd: null, interval: null };
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1)), h = (1.96 * sd) / Math.sqrt(n);
  return { n, counts, mean: round6(m), sd: round6(sd), interval: [round6(m - h), round6(m + h)] };
}
const runStateOf = (dir, id) => (!existsSync(join(dir, id)) ? "unexecuted" : !existsSync(join(dir, id, "summary.line.json")) ? "incomplete" : "executed");
/** 群の本ごとの事実（予定した本の全部。読めない記録は null） */
function groupFacts(dir, plannedIds) {
  return plannedIds.map((id) => {
    const state = runStateOf(dir, id), runDir = join(dir, id);
    const sl = state === "executed" ? readJsonSafe(join(runDir, "summary.line.json")).value : null;
    const ver = state === "executed" ? readJsonSafe(join(runDir, V11A_RECORDS.verification)) : { status: "absent", value: null };
    const counts = isObj(ver.value) ? ver.value[V11A_EXHAUSTED_PATH[0]] : null;
    const exhausted = isObj(counts) && Number.isInteger(counts[V11A_EXHAUSTED_PATH[1]]) ? counts[V11A_EXHAUSTED_PATH[1]] : null;
    return { id, runDir, state, summary: isObj(sl?.summary) ? sl.summary : null, exhausted };
  });
}
/** 停止段の内訳（群ごと）：予定・未実行・途中・要約なしと、値ごとの本数。期待する値（A5 の 5 つと decl-check:limit）は 0 件も並べる */
export function stopsOf(facts) {
  const expectedNames = hasPendingStage(facts.filter((f) => f.state === "executed").map((f) => f.summary)) ? [...EXPECTED_STOPS, ...PENDING_STOP_NAMES] : EXPECTED_STOPS;
  const executed = facts.filter((f) => f.state === "executed");
  const values = {};
  for (const f of executed) { if (f.summary === null) continue; const v = stopValueOf(f.summary, f.exhausted); values[v] = (values[v] ?? 0) + 1; }
  return {
    planned: facts.length, unexecuted: facts.filter((f) => f.state === "unexecuted").length, incomplete: facts.filter((f) => f.state === "incomplete").length,
    no_summary: executed.filter((f) => f.summary === null).length, values, expected: Object.fromEntries(expectedNames.map((k) => [k, values[k] ?? 0])),
  };
}
/** 段ごとの到達数（段の記録に現れた本の数）と予定数。0 件は「今回未観測」と分母を併記 */
export function reachOf(facts) {
  const n = facts.length;
  return Object.fromEntries(rowStageIds(hasPendingStage(facts.filter((f) => f.state === "executed").map((f) => f.summary))).map((id) => {
    const reached = facts.filter((f) => f.state === "executed" && Array.isArray(f.summary?.stages) && f.summary.stages.some((st) => st?.stage === id)).length;
    return [id, { reached, planned: n, label: reached === 0 ? `今回未観測（0/${n}）` : `${reached}/${n}` }];
  }));
}
/**
 * 持ち越しの内訳（群ごと。v1 は null）：実行した本のうち carry-over の記録を読めた本・欠測（無い・読めない・形が違う。記録を書く前に止まった本も欠測）・
 * 持ち越しのある本の数と、出どころ 4 つの件数（要件ごとに、その要件の理由に現れた出どころを 1 回ずつ数える。知らない出どころは unknown）
 */
export function carryOverOf(facts, group) {
  if (group === "v1") return null;
  const sources = zeros([...CARRY_OVER_SOURCES, "unknown"]);
  let observed = 0, missing = 0, withCarry = 0;
  for (const f of facts.filter((x) => x.state === "executed")) {
    const r = readJsonSafe(join(f.runDir, V11A_RECORDS.carry_over));
    const entries = r.status === "ok" && isObj(r.value) && Array.isArray(r.value[CARRY_OVER_ENTRIES_FIELD]) ? r.value[CARRY_OVER_ENTRIES_FIELD] : null;
    if (entries === null) { missing += 1; continue; }
    observed += 1;
    if (entries.length > 0) withCarry += 1;
    for (const e of entries) for (const o of new Set((Array.isArray(e?.reasons) ? e.reasons : [null]).map((x) => knownOr(CARRY_OVER_SOURCES, x?.origin)))) sources[o] += 1;
  }
  return { runs: facts.filter((x) => x.state === "executed").length, observed, missing, runs_with_carry_over: withCarry, sources };
}
/**
 * 条件の署名（run-agent.mjs の conditionsFor と同じ式）：started_at・signature・scoring・post-hoc の scripts・params.budget_usd を除いた全部の SHA-256。
 * scripts.mode が live なら scripts を末尾に入れる。比較の採点が、群の条件が書き換えられていないことを確かめるのに使う
 */
export function conditionsSignature(cond) {
  const { scoring: _s, scripts, started_at: _t, signature: _g, ...generation } = cond;
  const { budget_usd: _b, ...params } = isObj(cond.params) ? cond.params : {};
  return sha256(JSON.stringify(scripts?.mode === "live" ? { ...generation, params, scripts } : { ...generation, params }));
}
/** 照合で見る採点のときの指紋の一致（どれかが false か null なら未照合） */
export const COMPARE_FINGERPRINT_CHECKS = ["scoring_matches_conditions", "spec_engine_matches_conditions", "set_matches_conditions", "scripts_matches_conditions", "frozen_matches_conditions"];
const COMPARE_LABELS = { complete: "完了", incomplete: "未完了", unverified: "未照合" };

/**
 * 対にした交互の計測の採点（--compare）。両群を今の関数（scoreOutput）で採点してから対を組む。
 * 断る（予定外・食い違い。compare:scoring-mismatch）：対のファイルの写しの SHA が比較の記録と両群の条件で一致しない・群の params が pipeline と
 * v1.1α の上限の欄以外で違う・どちらかの群に予定外の本。予定の内側の不足（予算・締切で止めた正常な計測の未実行・途中）は断らない
 */
export async function scoreCompare(repo, outRoot, opts = {}) {
  const rec = readJsonSafe(join(outRoot, COMPARISON_FILE));
  if (rec.status !== "ok" || !isObj(rec.value)) throw refusal("比較の記録が無いか読めない [compare:record-missing]");
  const comparison = rec.value;
  // 段だけの対の比較（#545）は別の版の記録で、別の関数で採点する
  if (comparison.schema === STAGE_COMPARISON_SCHEMA) return scoreStageCompare(repo, outRoot, comparison, opts);
  const mismatch = (what) => refusal(`比較の採点の前提が食い違う（${what}） [compare:scoring-mismatch]`);
  let pairsBytes;
  try { pairsBytes = readFileSync(join(outRoot, COMPARE_PAIRS_COPY)); } catch { throw mismatch("対のファイルの写しを読めない"); }
  const pairsSha = sha256(pairsBytes);
  let pv;
  try { pv = JSON.parse(pairsBytes.toString("utf8")); } catch { throw mismatch("対のファイルの写しが JSON でない"); }
  // 群の組（#557）：比較の記録の pairs.groups（無ければ今までの v1,v1.1a）。受ける 3 つの組のどれかで、対のファイルの群と同じ
  const GROUPS = comparison.pairs?.groups === undefined ? COMPARE_GROUPS : comparison.pairs.groups;
  if (!isComparePair(GROUPS)) throw mismatch("群の組");
  const ROLES = compareRolesOf(GROUPS), [baseGroup, candGroup] = GROUPS, withV12 = GROUPS.includes(V12_PIPELINE);
  if (pairsShapeProblem(pv, { groups: GROUPS }) !== null) throw mismatch("対のファイルの形");
  if (comparison.pairs?.sha256 !== pairsSha) throw mismatch("対のファイルと比較の記録");
  const groups = {};
  for (const g of GROUPS) {
    const dir = join(outRoot, g);
    if (!existsSync(dir)) throw refusal("群のディレクトリが無い [compare:record-missing]");
    const cond = loadConditions(dir).cond;
    if (!isObj(cond) || cond.comparison?.pairs_sha256 !== pairsSha) throw mismatch("対のファイルと群の条件");
    // 群の同定（#513 の独立レビューの指摘 3）：ディレクトリの群と、条件の群・役割・経路、比較の記録の群ごとの条件の署名を結び付ける。
    // 候補の群に比較元の条件を置いた・群を入れ替えた・群を複製した出力先を、対の SHA と指紋が一致しても比較として採点しない
    if (cond.comparison?.group !== g || cond.comparison?.role !== ROLES[g] || cond.params?.pipeline !== g) throw mismatch("群と条件の群・役割・経路");
    // v1.2 を含む組（#557）：群の条件を版ごとに検証してから共通の形で照らす（知らない版・段単位の走りの条件との混在は断る）
    if (withV12) { const problem = groupConditionsProblem(cond, g); if (problem !== null) throw refusal(`比較の群の条件の版が群と合わない [${problem}]`); }
    // 条件の署名を中身から計算し直し（run-agent.mjs と同じ式）、比較の記録の群ごとの署名と工場の dist の指紋に照らす（条件を書き換えた・別の群の条件に付け替えた出力先を断る）
    const recorded = comparison.groups?.[g];
    if (!isHex64(cond.signature) || conditionsSignature(cond) !== cond.signature) throw mismatch("群の条件の署名が中身と合わない");
    if (!isObj(recorded) || recorded.role !== ROLES[g] || recorded.pipeline !== g || recorded.conditions_signature !== cond.signature || !isHex64(recorded.factory?.fingerprint) || recorded.factory.fingerprint !== cond.factory?.fingerprint) throw mismatch("群の条件と比較の記録");
    groups[g] = { dir, cond };
  }
  if (groups[baseGroup].cond.signature === groups[candGroup].cond.signature) throw mismatch("両群の条件の署名が同じ");
  // 共通の比較の形（経路・v1.1α の上限の欄・旗の組を除く）
  const core = (p) => { const rest = comparableParams(p); return rest === null ? null : JSON.stringify(rest); };
  if (core(groups[baseGroup].cond.params) === null || core(groups[baseGroup].cond.params) !== core(groups[candGroup].cond.params)) throw mismatch("群の params");
  const plannedIds = pv.pairs.map((p) => `${p.pid}-r${p.r}`);
  for (const g of GROUPS) if (runDirs(groups[g].dir).some((d) => !plannedIds.includes(d))) throw mismatch("予定外の本");
  for (const g of GROUPS) groups[g].full = await scoreOutput(repo, groups[g].dir, { ...opts, anonymous: opts.anonymous === true });
  // 対：両方の本が終わった（要約がある）対だけ差を取る。締切・予算で止まった本も終わった本で、PASS でなければ 0
  const passOf = (g, id) => { const row = groups[g].full.rows.find((r) => r.run === id); return row !== undefined && pass(row) ? 1 : 0; };
  const rows = pv.pairs.map((p) => {
    const id = `${p.pid}-r${p.r}`, states = Object.fromEntries(GROUPS.map((g) => [g, runStateOf(groups[g].dir, id)]));
    const both = GROUPS.every((g) => states[g] === "executed");
    const passes = both ? Object.fromEntries(GROUPS.map((g) => [g, passOf(g, id)])) : null;
    return { run: id, pid: p.pid, r: p.r, first: p.first, states, pass: passes, diff: both ? passes[candGroup] - passes[baseGroup] : null };
  });
  const finished = rows.filter((r) => r.diff !== null);
  const oneSide = rows.filter((r) => r.diff === null && GROUPS.some((g) => r.states[g] === "executed")).length;
  const byPattern = {};
  for (const r of rows) { (byPattern[r.pid] ??= { diffs: [] }).diffs.push(r.diff); }
  for (const v of Object.values(byPattern)) { const xs = v.diffs.filter((d) => d !== null); v.n = xs.length; v.mean = xs.length === 0 ? null : round6(xs.reduce((s, d) => s + d, 0) / xs.length); }
  // 群ごと：率と Wilson は参考。了承後系の UNEVALUATED・FAIL と落ちた判定の鍵。停止段・到達数・持ち越し
  const groupOut = {}, factsOf = {};
  for (const g of GROUPS) {
    const full = groups[g].full, facts = groupFacts(groups[g].dir, plannedIds), c = full.completion;
    factsOf[g] = new Map(facts.map((f) => [f.id, f]));
    const inPlan = full.rows.filter((r) => plannedIds.includes(r.run)), executed = facts.filter((f) => f.state === "executed").map((f) => f.id);
    const doneRows = inPlan.filter((r) => executed.includes(r.run));
    const failRows = inPlan.filter((r) => r.verdict_accepted === "FAIL"), failKeys = {};
    for (const r of failRows) for (const k of r.failed ?? []) failKeys[k] = (failKeys[k] ?? 0) + 1;
    const verdicts = zeros([...FACTORY_VERDICTS, "unknown", "absent"]);
    for (const f of facts.filter((x) => x.state === "executed")) verdicts[f.summary === null || f.summary.verdict === null || f.summary.verdict === undefined ? "absent" : knownOr(FACTORY_VERDICTS, f.summary.verdict)] += 1;
    groupOut[g] = {
      role: ROLES[g], pipeline: g,
      completion: { status: c.status, label: c.label, planned: c.planned, executed: c.executed, unexecuted: c.unexecuted?.length ?? null, incomplete: c.incomplete.length, stop_code: c.latest_record?.stop_code ?? null },
      fingerprints: Object.fromEntries(COMPARE_FINGERPRINT_CHECKS.map((k) => [k, full.fingerprints[k] ?? null])),
      // 参考：終わった本の原文系 PASS の率（Wilson）と、予定した本を分母にした率。対の差の区間の代わりにならない
      pass_executed: fmt(doneRows.filter(pass).length, doneRows.length), pass_planned: fmt(doneRows.filter(pass).length, plannedIds.length), factory_verdicts: verdicts,
      accepted: { unevaluated: inPlan.filter((r) => r.verdict_accepted === VERDICT_UNEVALUATED).length, fail: failRows.length, fail_keys: failKeys },
      stops: stopsOf(facts), reach: reachOf(facts), carry_over: carryOverOf(facts, g),
      // 漏斗・pass^k・判定の 3 系統（#538。群ごとの採点の出力の欄そのまま。対の差は別の Issue）
      funnel: full.funnel, pass_k: full.pass_k, verdicts: full.verdicts,
      // 内外の表と試験の分類（#539。群ごとの採点の出力の欄そのまま）
      agreement: full.agreement, test_findings: full.test_findings,
      // 経路 v1.2 の群（#557）：旗の組の照合（群の採点の evaluation.v12_flags）
      ...(isObj(full.evaluation?.v12_flags) ? { v12_flags: full.evaluation.v12_flags } : {}),
    };
  }
  // 段の役割ごとの対の差（#539。README §5.10.3）：両側で指標が定義されている対だけを n に入れる。片側だけ・欠測・適用外は差 null で理由を残す
  const roleRows = rows.map((r) => {
    const diffs = {};
    for (const [role, def] of Object.entries(STAGE_ROLES)) {
      // 段の名前は群の経路の列（v1.2 は v1.1α の段の名前。#557）
      const stageOf = (g) => def[stageColumnOf(g)];
      const vals = Object.fromEntries(GROUPS.map((g) => [g, r.states[g] !== "executed" ? null : stageValuesOf(factsOf[g].get(r.run)?.summary ?? null, stageOf(g), groups[g].full.funnel.stages[stageOf(g)]?.code_stage === true)]));
      diffs[role] = Object.fromEntries(STAGE_METRICS.map((k) => {
        const reason = GROUPS.some((g) => vals[g] === null) ? "one_side" : GROUPS.some((g) => vals[g].missing) ? "missing" : GROUPS.some((g) => vals[g].values[k] === null) ? "not_applicable" : null;
        return [k, { diff: reason === null ? vals[candGroup].values[k] - vals[baseGroup].values[k] : null, reason }];
      }));
    }
    return { run: r.run, pid: r.pid, diffs };
  });
  const byPatternOf = (cellOf) => { const out = {}; for (const x of roleRows) (out[x.pid] ??= []).push(cellOf(x).diff); return out; };
  const stage_pairs = {
    direction: `${diffDirectionOf(GROUPS)}。対ごとに段の役割の値（到達・1 回目で通過・通過）を 0／1 にして差を取る。未到達は 0（測定値）、適用外・欠測・片側だけの対は null で n に入れない`,
    roles: Object.fromEntries(Object.entries(STAGE_ROLES).map(([role, def]) => [role, {
      label: def.label, stages: Object.fromEntries(GROUPS.map((g) => [g, def[stageColumnOf(g)]])),
      metrics: Object.fromEntries(STAGE_METRICS.map((k) => {
        const cells = roleRows.map((x) => x.diffs[role][k]);
        return [k, { ...pairStats(cells.filter((x) => x.diff !== null).map((x) => x.diff)), excluded: Object.fromEntries(PAIR_NULL_REASONS.map((why) => [why, cells.filter((x) => x.reason === why).length])), clusters: clusterStats(byPatternOf((x) => x.diffs[role][k])) }];
      })),
    }])),
    rows: roleRows,
  };
  // P をまとまりにした原文系 PASS の対の差（#539。README §5.10.4）。既存の対の差（pairs）は独立な対の参考として残す
  const passCounts = pairStats(finished.map((r) => r.diff)).counts;
  const pattern_clusters = {
    note: CLUSTER_NOTE,
    discordant: { improved: passCounts["+1"], regressed: passCounts["-1"], note: "不一致の対の件数（記述的な警報。確定の信号ではない。旗は置かない）" },
    independent_reference: "pairs の区間は独立な対の区間（参考）。対は P × 反復で独立ではないので、P を単位にした区間と検定を主にする",
    pass: clusterStats(Object.fromEntries(Object.entries(byPattern).map(([pid, v]) => [pid, v.diffs]))),
  };
  // 照合：(i) 未照合 ＞ (ii) 完了（全対が両方終わり・両群が完了・予算の停止の記録なし・official）＞ (iii) 未完了（diagnostic は「診断」も）
  const unverified = GROUPS.flatMap((g) => [
    ...(groups[g].full.completion.status === "unverified" ? [{ group: g, check: "reconcile", value: "unverified" }] : []),
    // 旗の組の照合（#557。v1.2 の群）
    ...(groups[g].full.evaluation?.v12_flags?.status === "unverified" ? [{ group: g, check: V12_UNVERIFIED_CHECK, value: "unverified" }] : []),
    ...COMPARE_FINGERPRINT_CHECKS.filter((k) => groups[g].full.fingerprints[k] !== true).map((k) => ({ group: g, check: k, value: groups[g].full.fingerprints[k] === false ? false : null })),
  ]);
  const runRecords = readdirSync(outRoot).filter((n) => n.startsWith(COMPARE_RUN_PREFIX) && /^\d+\.json$/.test(n.slice(COMPARE_RUN_PREFIX.length))).sort((a, b) => Number(a.slice(COMPARE_RUN_PREFIX.length, -5)) - Number(b.slice(COMPARE_RUN_PREFIX.length, -5)));
  const lastRun = runRecords.length === 0 ? null : readJsonSafe(join(outRoot, runRecords.at(-1))).value;
  const budgetStop = (isObj(lastRun) && lastRun.stop_code === "budget") || GROUPS.some((g) => groups[g].full.completion.latest_record?.stop_code === "budget");
  const profile = COMPARE_PROFILES.includes(comparison.profile) ? comparison.profile : "unknown";
  const reasons = [];
  if (finished.length !== rows.length) reasons.push("両方が終わっていない対がある");
  if (GROUPS.some((g) => groups[g].full.completion.status !== "complete")) reasons.push("群の照合が完了でない");
  if (budgetStop) reasons.push("全体の予算の停止の記録がある");
  if (profile !== "official") reasons.push("正式な比較の条件を満たさない（診断）");
  const status = unverified.length > 0 ? "unverified" : reasons.length === 0 ? "complete" : "incomplete";
  const label = status === "incomplete" && profile !== "official" ? `${COMPARE_LABELS.incomplete}・診断` : COMPARE_LABELS[status];
  return {
    schema: SCORE_COMPARE_SCHEMA, rubric: "v5", diff_direction: `${diffDirectionOf(GROUPS)}。対ごとに原文系 PASS を 0／1 にして差を取る`,
    completion: { status, label, reference_only: status !== "complete", reasons: status === "unverified" ? [] : reasons, unverified, budget_stop: budgetStop },
    profile, profile_mismatches: Array.isArray(comparison.profile_mismatches) ? comparison.profile_mismatches.filter((k) => k in OFFICIAL_COMPARE || k === PROFILE_PIPELINES_REASON) : [],
    pairs: { planned: rows.length, both: finished.length, one_side: oneSide, none: rows.length - finished.length - oneSide, ...pairStats(finished.map((r) => r.diff)), by_pattern: byPattern, rows },
    groups: groupOut, scoring_cost_usd: SCORING_COST_USD,
    stage_pairs, pattern_clusters,
    // 雑音の分解（#631。README §8）：既存の欄のあとに足す。判定・門には使わない
    noise: compareNoise(Object.fromEntries(Object.entries(byPattern).map(([pid, v]) => [pid, v.diffs])), Object.fromEntries(Object.keys(STAGE_ROLES).map((role) => [role, byPatternOf((x) => x.diffs[role].passed)])), groups[baseGroup].cond.params?.runs),
  };
}
/** 比較の採点の匿名の口：件数・率（数と区間の形の文字列）・区間の数・既知の値だけ。本の ID・P の ID・パス・落ちた判定の鍵は出さない */
export function anonymizeCompare(full) {
  const c = full.completion ?? {}, p = full.pairs ?? {};
  const status = enumOrUnknown(Object.keys(COMPARE_LABELS), c.status ?? null);
  // 群の組（#557）：採点の出力の群の並び（比較元・候補）が受ける組なら、それ。でなければ今までの v1,v1.1a
  const GROUPS = isObj(full.groups) && isComparePair(Object.keys(full.groups)) ? Object.keys(full.groups) : COMPARE_GROUPS, ROLES = compareRolesOf(GROUPS);
  const groups = {};
  for (const g of GROUPS) {
    const x = full.groups?.[g] ?? {};
    const vals = {};
    for (const [k, n] of Object.entries(x.stops?.values ?? {})) { const key = knownStopValue(k) ? k : "unknown"; vals[key] = (vals[key] ?? 0) + (Number.isInteger(n) ? n : 0); }
    groups[g] = {
      role: ROLES[g], pipeline: g,
      completion: { status: enumOrUnknown(Object.keys(COMPARE_LABELS), x.completion?.status ?? null), ...intsOf(x.completion, ["planned", "executed", "unexecuted", "incomplete"]), stop_code: enumOrUnknown(STOP_CODES, x.completion?.stop_code ?? null) },
      fingerprints: Object.fromEntries(COMPARE_FINGERPRINT_CHECKS.map((k) => [k, boolOrNull(x.fingerprints?.[k])])),
      pass_executed: rateOrNull(x.pass_executed), pass_planned: rateOrNull(x.pass_planned), factory_verdicts: intsOf(x.factory_verdicts, [...FACTORY_VERDICTS, "unknown", "absent"]),
      accepted: intsOf(x.accepted, ["unevaluated", "fail"]),
      stops: { ...intsOf(x.stops, ["planned", "unexecuted", "incomplete", "no_summary"]), values: vals, expected: intsOf(x.stops?.expected, [...EXPECTED_STOPS, ...PENDING_STOP_NAMES.filter((k) => isObj(x.stops?.expected) && k in x.stops.expected)]) },
      reach: Object.fromEntries(rowStageIds(IDS_STAGE_IDS.some((id) => isObj(x.reach?.[id]))).map((id) => { const r = x.reach?.[id]; const reached = intOrNull(r?.reached), planned = intOrNull(r?.planned); return [id, { reached, planned, label: reached === null || planned === null ? null : reached === 0 ? `今回未観測（0/${planned}）` : `${reached}/${planned}` }]; })),
      carry_over: !isObj(x.carry_over) ? null : { ...intsOf(x.carry_over, ["runs", "observed", "missing", "runs_with_carry_over"]), sources: intsOf(x.carry_over.sources, [...CARRY_OVER_SOURCES, "unknown"]) },
      funnel: anonymousFunnel(x.funnel), pass_k: anonymousPassK(x.pass_k), verdicts: anonymousVerdicts(x.verdicts),
      ...anonymous539(x),
      // 経路 v1.2 の群（#557）：照合を通った旗の名前と真偽と件数だけ
      ...(isObj(x.v12_flags) ? { v12_flags: anonymousV12Flags(x.v12_flags) } : {}),
    };
  }
  const interval = Array.isArray(p.interval) && p.interval.length === 2 && p.interval.every((v) => numOrNull(v) !== null) ? [p.interval[0], p.interval[1]] : null;
  return {
    schema: SCORE_COMPARE_SCHEMA, rubric: "v5", anonymous: true, diff_direction: full.diff_direction === undefined ? null : `${diffDirectionOf(GROUPS)}。対ごとに原文系 PASS を 0／1 にして差を取る`,
    completion: {
      status, label: status === "incomplete" && full.profile !== "official" ? `${COMPARE_LABELS.incomplete}・診断` : COMPARE_LABELS[status] ?? "unknown", reference_only: status !== "complete", budget_stop: boolOrNull(c.budget_stop),
      unverified: (Array.isArray(c.unverified) ? c.unverified : []).filter((u) => GROUPS.includes(u?.group) && (u.check === "reconcile" || u.check === V12_UNVERIFIED_CHECK || COMPARE_FINGERPRINT_CHECKS.includes(u.check))).map((u) => ({ group: u.group, check: u.check, value: u.check === "reconcile" || u.check === V12_UNVERIFIED_CHECK ? "unverified" : u.value === false ? false : null })),
    },
    profile: enumOrUnknown(COMPARE_PROFILES, full.profile ?? null), profile_mismatches: (Array.isArray(full.profile_mismatches) ? full.profile_mismatches : []).filter((k) => typeof k === "string" && (k in OFFICIAL_COMPARE || k === PROFILE_PIPELINES_REASON)),
    pairs: { ...intsOf(p, ["planned", "both", "one_side", "none", "n"]), counts: intsOf(p.counts, ["+1", "0", "-1"]), mean: numOrNull(p.mean), sd: numOrNull(p.sd), interval },
    groups, scoring_cost_usd: SCORING_COST_USD,
    // 段の役割ごとの対の差と P のまとまり（#539）：件数・n・平均・区間・p だけ（本の ID・P の ID・P ごとの平均は出さない）
    stage_pairs: !isObj(full.stage_pairs) ? null : { roles: Object.fromEntries(Object.keys(STAGE_ROLES).map((role) => [role, { metrics: Object.fromEntries(STAGE_METRICS.map((k) => { const x = full.stage_pairs.roles?.[role]?.metrics?.[k]; return [k, { ...anonPairStats(x), excluded: intsOf(x?.excluded, PAIR_NULL_REASONS), clusters: anonCluster(x?.clusters) }]; })) }])) },
    pattern_clusters: !isObj(full.pattern_clusters) ? null : { discordant: intsOf(full.pattern_clusters.discordant, ["improved", "regressed"]), pass: anonCluster(full.pattern_clusters.pass) },
    // 雑音の分解（#631）：m・使った P の数・分散・勝つ側・δ の表だけ（P の ID・P ごとの値・平均は出さない）
    ...("noise" in full ? { noise: !isObj(full.noise) ? null : { runs: intOrNull(full.noise.runs), pass: anonNoise(full.noise.pass), stage_pairs: { roles: Object.fromEntries(Object.keys(STAGE_ROLES).map((role) => [role, { passed: anonNoise(full.noise.stage_pairs?.roles?.[role]?.passed) }])) } } } : {}),
  };
}
const numPair = (x) => (Array.isArray(x) && x.length === 2 && x.every((v) => numOrNull(v) !== null) ? [x[0], x[1]] : null);
const anonPairStats = (x) => ({ n: intOrNull(x?.n), counts: intsOf(x?.counts, ["+1", "0", "-1"]), mean: numOrNull(x?.mean), sd: numOrNull(x?.sd), interval: numPair(x?.interval) });
const anonNoise = (x) => (!isObj(x) ? null : {
  m: intOrNull(x.m), within: { variance: numOrNull(x.within?.variance), patterns: intOrNull(x.within?.patterns) }, between: { variance: numOrNull(x.between?.variance) }, prediction: numOrNull(x.prediction),
  data: { raw: numOrNull(x.data?.raw), variance: numOrNull(x.data?.variance), clipped: boolOrNull(x.data?.clipped) }, winner: enumOrUnknown(NOISE_WINNERS, x.winner ?? null), reason: enumOrUnknown(NOISE_REASONS, x.reason ?? null),
  detectable: { z: numOrNull(x.detectable?.z), by_k: Object.fromEntries(NOISE_K_VALUES.map((k) => [String(k), numOrNull(x.detectable?.by_k?.[String(k)])])), infinity: numOrNull(x.detectable?.infinity), current: { k: intOrNull(x.detectable?.current?.k), delta: numOrNull(x.detectable?.current?.delta) }, reason: enumOrUnknown(NOISE_REASONS, x.detectable?.reason ?? null) },
});
const anonCluster = (c) => (!isObj(c) ? null : {
  m: intOrNull(c.m), mean: numOrNull(c.mean), sign_flip: { p: numOrNull(c.sign_flip?.p), permutations: intOrNull(c.sign_flip?.permutations) },
  bootstrap: { interval: numPair(c.bootstrap?.interval), resamples: intOrNull(c.bootstrap?.resamples), seed: intOrNull(c.bootstrap?.seed) },
  t_reference: { sd: numOrNull(c.t_reference?.sd), df: intOrNull(c.t_reference?.df), interval: numPair(c.t_reference?.interval) },
});

// ── 段単位の走り（#545。設計書 08 §8.3。README §5.11）
// 計測（run-agent.mjs --stage-start・--stage-end・--stage-from）と採点が同じ定数と純粋な関数を使う。段の表（開始・終了・境界）と再開の入力の照合の関数は、
// 計測が工場の dist から読む。採点は工場の段の走りの記録（stage-run.json）を読むだけで、工場のコード・dist は import しない（記録の置き場所と版は写して持ち、試験で dist と照らす）。
// 段の通過は納品の成功ではない：原文系・了承後系の PASS と納品の欄は計算せず、段の通過を PASS・納品の成功・verdict の名前で出さない
/** 段単位の走りの条件の版（v5 に params.stage_start・stage_end・budget_scope・stage_from・stage_inputs と stage_input_absent を足した。段単位の走りのときだけ書く） */
export const CONDITIONS_V6 = "musunest-factory/agent-accept-conditions/v6";
/** 段単位の走りの params.mode。予算と締切の適用の単位（params.budget_scope。packages/factory の STAGE_BUDGET_SCOPE）も同じ値 */
export const STAGE_RUN_MODE = "stage-run";
/** 工場の段の走りの記録の、本のディレクトリからの場所（packages/factory の STAGE_RUN_RECORD_FILE を --out の下に）と記録の形の版（STAGE_RUN_RECORD_SCHEMA） */
export const STAGE_RUN_PATH = "bundle/stage-run.json";
/** 本のディレクトリの中の、上流の入力の写しの置き場所（run-agent.mjs が checkpoint と段の走りの記録をここに写す。工場は checkpoint の隣の記録を読む） */
export const STAGE_INPUT_DIR = "stage-input";
/** 段の走りの記録と条件の食い違いの理由（range ＝ 範囲、plan-source ＝ 確定した仕様と依頼文の SHA、input ＝ 入力の対応） */
export const STAGE_RECORD_MISMATCHES = ["range", "plan-source", "input", "stages"];
/**
 * 段単位の走りの区間（packages/factory の STAGE_STARTS・STAGE_ENDS の i 番目の組。採点は工場の dist を import しないので写して持ち、試験で dist と照らす）と、
 * 区間の中で記録に出うる段（packages/factory/src/v11a/run.ts の段の記録の名前。区間 0 の carry-over は持ち越しの導出、区間 2 は B の段と ⑦、
 * B3'・B6 で全件持ち越し等になったときの carry-over（停止 carry-over・unmet）。工場の dist は区間の端の段しか公開しないので、区間の内側の段は手で写して持つ）。
 * 範囲 開始 i 〜 終了 k の記録に出てよい段は区間 i〜k の段だけ（"stages" の照合と、漏斗の段の範囲）
 */
export const STAGE_SEGMENTS = [
  { start: "name-table", end: "semantic-check", stages: ["name-table", "semantic-check", "carry-over", ...IDS_STAGE_IDS] },
  { start: "test-spec", end: "test-spec", stages: ["test-spec"] },
  { start: "write", end: "judge", stages: ["write", "static-check", "name-check", "decl-check", "run-tests", "repair", "arbitration", "coverage", "carry-over", "judge"] },
];
/** 範囲の中の段（開始・終了が区間の表に無いか、開始が終了より後なら空） */
export function stagesInRange(start, end) {
  const i = STAGE_SEGMENTS.findIndex((x) => x.start === start), k = STAGE_SEGMENTS.findIndex((x) => x.end === end);
  return i < 0 || k < i ? [] : STAGE_SEGMENTS.slice(i, k + 1).flatMap((x) => x.stages);
}
export const STAGE_RUN_RECORD_SCHEMA = "musunest.factory.v11a-stage-run/v1";
/** 段単位の採点で計算しない欄（null にし、not_computed に理由 stage-run を添える） */
export const STAGE_NOT_COMPUTED = ["metrics", "metrics_accepted", "metrics_script", "fulfillment", "bySubject", "tables", "metrics_plan", "metrics_build", "pass_k", "verdicts", "unverified_details", "agreement", "test_findings"];
/** 段だけの対の比較の群（before ＝ 凍結した前の候補の checkout、after ＝ 今の候補）と役割。v1／v1.1α の比較の群（COMPARE_GROUPS）とは別の定数 */
export const STAGE_COMPARE_GROUPS = ["before", "after"];
export const STAGE_COMPARE_ROLES = { before: "baseline", after: "candidate" };
/** 段だけの対の比較の対のファイル・比較の記録・採点の出力の版（v1／v1.1α の比較の版とは別） */
export const STAGE_PAIRS_SCHEMA = "musunest-eval/stage-compare-pairs/v1";
export const STAGE_COMPARISON_SCHEMA = "musunest-eval/stage-compare-record/v1";
export const STAGE_SCORE_COMPARE_SCHEMA = "musunest-eval/score-stage-compare/v1";
/**
 * 本の状態：absent ＝ 入力なし（起こさない）、unlaunched ＝ 起こさなかった（予算の停止など）、missing ＝ 起こしたが段の走りの記録が読めない、
 * mismatch ＝ 記録は読めたが条件（範囲・仕様と依頼文の SHA・入力の対応・段の履歴と範囲の整合）と食い違う（通過に数えず、照合は未照合）、observed ＝ 記録が読めて条件と合う
 */
export const STAGE_RUN_STATES = ["absent", "unlaunched", "missing", "mismatch", "observed"];
/** 段だけの対の差が null の理由（未起動 ＝ どちらかの群で起こさなかった、欠測 ＝ 起こしたが記録が読めないか条件と食い違う） */
export const STAGE_PAIR_NULL_REASONS = ["unlaunched", "missing"];
/** 段単位の走りの条件（v6 で params.mode が stage-run） */
export const isStageConditions = (cond) => isObj(cond) && cond.schema === CONDITIONS_V6 && cond.params?.mode === STAGE_RUN_MODE;
/** 条件に固定した入力なしの本（stage_input_absent）：予定の部分集合で、重複が無く、件数が一覧の長さと一致するときだけ一覧を返す（それ以外は null） */
export function stageAbsentOf(cond, planned) {
  const a = cond?.stage_input_absent;
  if (!isObj(a) || !Array.isArray(a.ids) || !Number.isInteger(a.count) || a.count !== a.ids.length) return null;
  if (!a.ids.every((id) => typeof id === "string" && planned.includes(id)) || new Set(a.ids).size !== a.ids.length) return null;
  return a.ids;
}
/** 段の走りの記録として読めるか（形の版が既知で、段の通過が真偽）。読めなければ null */
export const stageRecordOf = (value) => (isObj(value) && value.schema_version === STAGE_RUN_RECORD_SCHEMA && typeof value.stage_pass === "boolean" ? value : null);
/** 停止の名前（段:種類。どちらかが知らない値なら unknown）。停止が無ければ null */
const stageStopOf = (stopped) => {
  if (!isObj(stopped)) return null;
  const st = knownOr(BUILD_STAGE_IDS, stopped.stage), k = knownOr(FAILURE_KINDS, stopped.kind);
  return st === "unknown" || k === "unknown" ? "unknown" : `${st}:${k}`;
};
const readBytesOrNull = (path) => { try { return readFileSync(path); } catch { return null; } };
/**
 * 段の走りの記録を条件に結ぶ（食い違いの理由の一覧。空なら合う）：範囲が条件の stage_start・stage_end と同じ（range）・確定した仕様と依頼文の SHA が
 * 凍結した組のその P の値と同じ（plan-source）・入力の対応（input）。開始 T1（stage_from が null）なら記録の入力は null で、本ごとの入力の欄も無い。
 * それ以外は、本ごとの入力の欄（stage_inputs。入力なしでない）があり、記録の入力（checkpoint のファイル名と境界）が指す写し（<本>/stage-input/）の
 * checkpoint と段の走りの記録の SHA-256 が欄の値と同じで、checkpoint の境界が記録の入力の境界と同じ
 */
export function stageRecordMismatches(record, run, cond, dir) {
  const p = isObj(cond?.params) ? cond.params : {}, reasons = [];
  if (!isObj(record.range) || record.range.start !== p.stage_start || record.range.end !== p.stage_end) reasons.push("range");
  const a = Array.isArray(cond?.frozen?.adopted) ? cond.frozen.adopted.find((x) => isObj(x) && x.pattern === patternOf(run)) : undefined;
  if (!isObj(a) || !isHex64(record.plan_sha256) || record.plan_sha256 !== a.plan_sha256 || record.source_sha256 !== a.source_sha256) reasons.push("plan-source");
  const entry = Array.isArray(p.stage_inputs) ? p.stage_inputs.find((x) => isObj(x) && x.id === run) : undefined;
  const inputOk = (() => {
    const inp = record.input;
    if (p.stage_from === null || p.stage_from === undefined) return inp === null && entry === undefined;
    if (!isObj(entry) || entry.absent === true || !isObj(inp) || typeof inp.checkpoint !== "string" || !/^stage-checkpoint-[a-z0-9-]+\.json$/.test(inp.checkpoint) || typeof inp.boundary !== "string") return false;
    const cp = readBytesOrNull(join(dir, STAGE_INPUT_DIR, inp.checkpoint)), rec = readBytesOrNull(join(dir, STAGE_INPUT_DIR, basename(STAGE_RUN_PATH)));
    if (cp === null || rec === null || sha256(cp) !== entry.checkpoint_sha256 || sha256(rec) !== entry.record_sha256) return false;
    // checkpoint の境界が記録の入力の境界と同じで、記録の入力の出力ダイジェストが、写した上流の記録のその checkpoint の宣言（境界とファイル名）の値と同じ
    try {
      const v = JSON.parse(cp.toString("utf8")), upRecord = JSON.parse(rec.toString("utf8"));
      const declared = isObj(upRecord) && Array.isArray(upRecord.checkpoints) ? upRecord.checkpoints.filter((c) => isObj(c) && c.boundary === inp.boundary && c.path === inp.checkpoint) : [];
      return isObj(v) && v.boundary === inp.boundary && declared.length === 1 && isHex64(inp.output_digest) && declared[0].output_digest === inp.output_digest;
    } catch { return false; }
  })();
  if (!inputOk) reasons.push("input");
  // 段の履歴・到達の段・停止の段が範囲の中で、段の通過が停止と終了の段の最後の記録に合う（範囲が条件と合うときに見る。範囲違いは range で足りる）
  if (!reasons.includes("range")) {
    const inRange = stagesInRange(p.stage_start, p.stage_end), stages = record.stages;
    const lastEnd = Array.isArray(stages) ? stages.filter((x) => isObj(x) && x.stage === p.stage_end).at(-1) : undefined;
    const stagesOk = Array.isArray(stages) && stages.every((x) => isObj(x) && inRange.includes(x.stage))
      && record.reached_stage === (stages.length === 0 ? null : stages.at(-1).stage)
      && (record.stopped === null || (isObj(record.stopped) && inRange.includes(record.stopped.stage)))
      && record.stage_pass === (record.stopped === null && isObj(lastEnd) && lastEnd.status === "ok");
    if (!stagesOk) reasons.push("stages");
  }
  return reasons;
}
/** 予定した本ごとの事実（状態と段の走りの記録）。入力なしの本は記録を読まない。記録は条件と結べたときだけ観測（observed）に数える */
export function stageFactsOf(outRoot, planned, absentIds, cond) {
  return planned.map((run) => {
    if (absentIds.includes(run)) return { run, state: "absent", record: null };
    const dir = join(outRoot, run);
    if (!existsSync(dir)) return { run, state: "unlaunched", record: null };
    const record = stageRecordOf(readJsonSafe(join(dir, STAGE_RUN_PATH)).value);
    if (record === null) return { run, state: "missing", record: null };
    const mismatches = stageRecordMismatches(record, run, cond, dir);
    return mismatches.length > 0 ? { run, state: "mismatch", record: null, mismatches } : { run, state: "observed", record };
  });
}
/**
 * 段の通過率（設計書 08 §8.3。納品の成功と別の指標）。facts ＝ 予定した本ごとの { run, state, record }。件数は別々に出す：対象予定・入力なし・起動・観測・
 * 欠測（予定 − 入力なし − 観測。未起動と記録なしの内訳。予算の停止で起こさなかった本は未起動のまま数え、別に件数を出す）・通過。
 * 率の分母は 予定 − 入力なし（起動の前に決まる。未起動の本を分母から消さない）。率と Wilson の区間は同じ分母で、分母が 0 なら null。
 * 停止は 段:種類 の件数、⑦ まで流した範囲だけ ⑦ の判定（stage_judge_verdict）の件数
 */
export function stagePassRateOf(facts, { range = null, budgetPending = [] } = {}) {
  const count = (st) => facts.filter((f) => f.state === st).length;
  const planned = facts.length, inputAbsent = count("absent"), unlaunched = count("unlaunched"), unreadable = count("missing"), mismatched = count("mismatch"), observed = count("observed");
  const denominator = planned - inputAbsent;
  const passed = facts.filter((f) => f.state === "observed" && f.record.stage_pass === true).length;
  const [lo, hi] = wilson(passed, denominator);
  const stops = {};
  for (const f of facts) { if (f.state !== "observed") continue; const v = stageStopOf(f.record.stopped); if (v !== null) stops[v] = (stops[v] ?? 0) + 1; }
  let judge = null;
  if (range?.end === "judge") {
    judge = zeros([...FACTORY_VERDICTS, "unknown", "absent"]);
    for (const f of facts) if (f.state === "observed") judge[f.record.stage_judge_verdict === null || f.record.stage_judge_verdict === undefined ? "absent" : knownOr(FACTORY_VERDICTS, f.record.stage_judge_verdict)] += 1;
  }
  return {
    label: "段の通過率（範囲の中に早期停止が無く、終了の段の最後の記録が ok。納品の成功ではない）",
    range, planned, input_absent: inputAbsent, launched: unreadable + mismatched + observed, observed, missing: denominator - observed,
    // 欠測の内訳：未起動・記録なし・条件と食い違う記録（通過に数えない）
    missing_breakdown: { unlaunched, unreadable, mismatched, budget_pending: facts.filter((f) => f.state === "unlaunched" && budgetPending.includes(f.run)).length },
    passed, denominator, denominator_label: `予定 ${planned} − 入力なし ${inputAbsent}（起動の前に決まる）`,
    rate: denominator === 0 ? null : round6(passed / denominator), interval: denominator === 0 ? null : [round6(lo), round6(hi)], text: denominator === 0 ? null : fmt(passed, denominator),
    stops, stage_judge_verdicts: judge,
  };
}
/** 標準出力の段の通過の 1 行（範囲・通過／予定・入力なし） */
export function stagePassText(sp) {
  const r = sp.range ?? {}, m = sp.missing_breakdown;
  return `段の通過（範囲 ${r.start ?? "-"}..${r.end ?? "-"}。納品の成功ではない）: 通過 ${sp.passed}／予定 ${sp.planned}・入力なし ${sp.input_absent}・起動 ${sp.launched}・観測 ${sp.observed}・欠測 ${sp.missing}（未起動 ${m.unlaunched}［うち予算の停止 ${m.budget_pending}］・記録なし ${m.unreadable}・条件と食い違う ${m.mismatched}）・率 ${sp.text ?? "-（分母 0）"}（分母 ${sp.denominator_label}）`;
}
/** 範囲の中の漏斗（#538 の funnelOf を、入力なしを除いた本に当てる。段は段の走りの記録に現れた段だけ） */
export function stageFunnelOf(facts, range) {
  const ran = facts.filter((f) => f.state !== "absent");
  const fu = funnelOf(ran.map((f) => ({
    state: f.state === "observed" ? "executed" : "unexecuted",
    summary: f.state !== "observed" ? null : { stages: Array.isArray(f.record.stages) ? f.record.stages : [], failure: f.record.stopped ?? null, ...(f.record.stopped === null ? { stop_class: "completed", stop_reason: "completed" } : {}) },
    verification: null, exhausted: null,
  })));
  const seen = new Set(facts.filter((f) => f.state === "observed" && Array.isArray(f.record.stages)).flatMap((f) => f.record.stages.map((st) => (isObj(st) ? st.stage : null))));
  return {
    ...fu, range, denominator: `件数の分母は予定から入力なしを除いた本 ${ran.length} 本（未起動・記録なしの本は到達 0）。条件付き率の分母は段ごとの到達本数。段は確かめた範囲の中（条件と結べた段の走りの記録に現れ、範囲の区間に入る段）だけ`,
    stages: Object.fromEntries(BUILD_STAGE_IDS.filter((id) => seen.has(id) && stagesInRange(range?.start, range?.end).includes(id)).map((id) => [id, fu.stages[id]])),
  };
}
/** 段単位の採点の行（本ごと。段の通過・到達した段・停止・⑦ の判定・費用） */
const stageRowOf = (f) => {
  const rec = f.state === "observed" ? f.record : null;
  return {
    mismatches: f.state === "mismatch" ? f.mismatches.filter((m) => STAGE_RECORD_MISMATCHES.includes(m)) : [],
    run: f.run, pattern: patternOf(f.run), state: f.state, stage_pass: rec === null ? null : rec.stage_pass,
    reached_stage: rec === null || rec.reached_stage === null || rec.reached_stage === undefined ? null : knownOr(BUILD_STAGE_IDS, rec.reached_stage),
    stopped: rec === null ? null : stageStopOf(rec.stopped),
    stage_judge_verdict: rec === null || rec.stage_judge_verdict === undefined || rec.stage_judge_verdict === null ? null : knownOr(FACTORY_VERDICTS, rec.stage_judge_verdict),
    cost_usd: rec === null ? null : finite(rec.provider_cost_usd),
  };
};
/** 条件の範囲（params.stage_start・stage_end。既知の段の ID か unknown） */
const stageRangeOf = (cond) => ({ start: knownOr(BUILD_STAGE_IDS, cond?.params?.stage_start), end: knownOr(BUILD_STAGE_IDS, cond?.params?.stage_end) });
/** 段単位の採点の出力（scoreOutput の段単位の道）。計算しない欄は null で、理由を not_computed に置く */
function stageOutputOf({ outRoot, cond, planned, stageAbsent, set, evaluation, completion: reconciled, fingerprints }) {
  let completion = reconciled;
  const range = stageRangeOf(cond);
  const facts = stageFactsOf(outRoot, planned, stageAbsent, cond);
  // 条件と食い違う記録が 1 本でもあれば照合は未照合（理由に件数と食い違いの種類。本の ID は行の mismatches に）
  const mismatched = facts.filter((f) => f.state === "mismatch");
  if (mismatched.length > 0) {
    const kinds = STAGE_RECORD_MISMATCHES.filter((k) => mismatched.some((f) => f.mismatches.includes(k)));
    completion = { ...completion, status: "unverified", label: COMPLETION_LABELS.unverified, reasons: [...completion.reasons, `段の走りの記録が条件と食い違う ${mismatched.length} 本（${kinds.join("・")}）`] };
  }
  const last = completion.latest_record;
  const budgetPending = last?.stop_code === "budget" && Array.isArray(last.pending) ? last.pending : [];
  const sf = cond.params?.stage_from;
  return {
    rubric: "v5", set, evaluation,
    stage_run: { range, budget_scope: knownOr([STAGE_RUN_MODE], cond.params?.budget_scope), stage_from: isObj(sf) ? { conditions_sha256: isHex64(sf.conditions_sha256) ? sf.conditions_sha256 : null } : null },
    not_computed: { reason: STAGE_RUN_MODE, label: "段単位の計測は納品物を作らないので、原文系・了承後系の PASS と納品の欄を計算しない", fields: [...STAGE_NOT_COMPUTED] },
    ...Object.fromEntries(STAGE_NOT_COMPUTED.map((k) => [k, null])),
    completion, fingerprints,
    stage_pass_rate: stagePassRateOf(facts, { range, budgetPending }), funnel: stageFunnelOf(facts, range),
    rows: facts.map(stageRowOf),
  };
}
/** 匿名の段の通過率：件数・率・区間・既知の値だけ（本の ID・P の ID・上流の SHA は出さない） */
const anonymousStagePassRate = (s) => (!isObj(s) ? null : {
  range: { start: enumOrUnknown(BUILD_STAGE_IDS, s.range?.start ?? null), end: enumOrUnknown(BUILD_STAGE_IDS, s.range?.end ?? null) },
  ...intsOf(s, ["planned", "input_absent", "launched", "observed", "missing", "passed", "denominator"]), missing_breakdown: intsOf(s.missing_breakdown, ["unlaunched", "unreadable", "mismatched", "budget_pending"]),
  rate: numOrNull(s.rate), interval: numPair(s.interval), text: rateOrNull(s.text),
  stops: (() => { const vals = {}; for (const [k, n] of Object.entries(isObj(s.stops) ? s.stops : {})) { const key = knownStopValue(k) ? k : "unknown"; vals[key] = (vals[key] ?? 0) + (Number.isInteger(n) ? n : 0); } return vals; })(),
  stage_judge_verdicts: isObj(s.stage_judge_verdicts) ? intsOf(s.stage_judge_verdicts, [...FACTORY_VERDICTS, "unknown", "absent"]) : null,
});
/** 段単位の採点の匿名の口：照合・指紋・評価の種類・計算しない欄の理由・段の通過率・範囲の中の漏斗だけ */
export function anonymizeStage(full) {
  const sr = full.stage_run ?? {};
  return {
    rubric: "v5", anonymous: true, runs: Array.isArray(full.rows) ? full.rows.length : null,
    set: { version: intOrNull(full.set?.version), role: enumOrUnknown(EVAL_SET_ROLES, full.set?.role ?? null), sha256: hashOrNull(full.set?.sha256) },
    evaluation: { mode: enumOrUnknown(EVALUATION_MODES, full.evaluation?.mode ?? null), build_applicable: boolOrNull(full.evaluation?.build_applicable), pipeline: enumOrUnknown(PIPELINES, full.evaluation?.pipeline ?? null) },
    stage_run: { range: { start: enumOrUnknown(BUILD_STAGE_IDS, sr.range?.start ?? null), end: enumOrUnknown(BUILD_STAGE_IDS, sr.range?.end ?? null) }, budget_scope: enumOrUnknown([STAGE_RUN_MODE], sr.budget_scope ?? null) },
    not_computed: { reason: STAGE_RUN_MODE, fields: [...STAGE_NOT_COMPUTED] },
    completion: anonymousCompletion(full.completion), fingerprints: anonymousFingerprints(full.fingerprints, [...CONDITIONS_SCHEMAS, CONDITIONS_V6]),
    stage_pass_rate: anonymousStagePassRate(full.stage_pass_rate),
    funnel: anonymousFunnel(full.funnel, BUILD_STAGE_IDS.filter((id) => isObj(full.funnel?.stages?.[id]))),
  };
}
/** 段だけの対の比較の対のファイル（--make-pairs と段の旗）：上流の入力のある本（採用した P の順 × 回数）だけを、今の比較と同じ交互の順で並べる */
export function makeStagePairs(keys, runs, frozenSha256, stage) {
  return { schema: STAGE_PAIRS_SCHEMA, frozen_sha256: frozenSha256, groups: [...STAGE_COMPARE_GROUPS], runs, stage, pairs: alternatePairs(keys, STAGE_COMPARE_GROUPS) };
}
/** 段だけの対の比較の対のファイルの検査：形（今の比較と同じ関数を段の版と群で）・凍結した組の SHA・範囲と上流の条件の指紋・上流の入力のある本とちょうど一致 */
export function stagePairsProblem(v, { frozenSha256, expected, stage }) {
  const shape = pairsShapeProblem(v, { schema: STAGE_PAIRS_SCHEMA, groups: STAGE_COMPARE_GROUPS });
  if (shape !== null) return shape;
  if (v.frozen_sha256 !== frozenSha256) return "compare:pairs-frozen";
  if (JSON.stringify(v.stage) !== JSON.stringify(stage)) return "compare:pairs-stage";
  const keys = new Set(v.pairs.map((p) => `${p.pid}-r${p.r}`));
  if (expected.some((k) => !keys.has(k))) return "compare:pairs-missing";
  if (keys.size !== expected.length) return "compare:pairs-extra";
  return null;
}
/**
 * 段だけの対の比較の採点（--compare。記録の版が STAGE_COMPARISON_SCHEMA）。両群を段単位の採点（scoreOutput）で採点してから対を組み、
 * 対ごとに段の通過の差（after − before）を取る。件数・n・平均・区間は今の対の差と同じ関数（pairStats）、P のまとまりの符号反転の p と bootstrap の区間は
 * 手 0b の関数（clusterStats）。片側が未起動・欠測の対は差 null で n に入れず、理由ごとの件数を出す。入力なしの本は対に入らず、件数を別に出す
 */
async function scoreStageCompare(repo, outRoot, comparison, opts) {
  const mismatch = (what) => refusal(`比較の採点の前提が食い違う（${what}） [compare:scoring-mismatch]`);
  let pairsBytes;
  try { pairsBytes = readFileSync(join(outRoot, COMPARE_PAIRS_COPY)); } catch { throw mismatch("対のファイルの写しを読めない"); }
  const pairsSha = sha256(pairsBytes);
  let pv;
  try { pv = JSON.parse(pairsBytes.toString("utf8")); } catch { throw mismatch("対のファイルの写しが JSON でない"); }
  if (pairsShapeProblem(pv, { schema: STAGE_PAIRS_SCHEMA, groups: STAGE_COMPARE_GROUPS }) !== null) throw mismatch("対のファイルの形");
  if (comparison.pairs?.sha256 !== pairsSha) throw mismatch("対のファイルと比較の記録");
  const groups = {};
  for (const g of STAGE_COMPARE_GROUPS) {
    const dir = join(outRoot, g);
    if (!existsSync(dir)) throw refusal("群のディレクトリが無い [compare:record-missing]");
    const cond = loadConditions(dir).cond;
    if (!isStageConditions(cond) || cond.comparison?.pairs_sha256 !== pairsSha) throw mismatch("対のファイルと群の条件");
    if (cond.comparison?.group !== g || cond.comparison?.role !== STAGE_COMPARE_ROLES[g] || cond.params?.pipeline !== "v1.1a") throw mismatch("群と条件の群・役割・経路");
    const recorded = comparison.groups?.[g];
    if (!isHex64(cond.signature) || conditionsSignature(cond) !== cond.signature) throw mismatch("群の条件の署名が中身と合わない");
    if (!isObj(recorded) || recorded.role !== STAGE_COMPARE_ROLES[g] || recorded.conditions_signature !== cond.signature || !isHex64(recorded.factory?.fingerprint) || recorded.factory.fingerprint !== cond.factory?.fingerprint) throw mismatch("群の条件と比較の記録");
    groups[g] = { dir, cond };
  }
  const [before, after] = STAGE_COMPARE_GROUPS;
  if (groups[before].cond.signature === groups[after].cond.signature) throw mismatch("両群の条件の署名が同じ");
  // 両群の params（範囲・上流の条件の指紋・本ごとの上流の入力の SHA を含む）と入力なしの本が同じ（上流を固定して効果を局所化する前提）
  const core = (p) => { if (!isObj(p)) return null; const { stage_output_limits_v11a: _l, ...rest } = p; return JSON.stringify(rest); };
  if (core(groups[before].cond.params) === null || core(groups[before].cond.params) !== core(groups[after].cond.params)) throw mismatch("群の params");
  if (JSON.stringify(groups[before].cond.stage_input_absent) !== JSON.stringify(groups[after].cond.stage_input_absent)) throw mismatch("群の入力なしの本");
  const plannedIds = pv.pairs.map((p) => `${p.pid}-r${p.r}`);
  for (const g of STAGE_COMPARE_GROUPS) if (runDirs(groups[g].dir).some((d) => !plannedIds.includes(d))) throw mismatch("予定外の本");
  for (const g of STAGE_COMPARE_GROUPS) groups[g].full = await scoreOutput(repo, groups[g].dir, { ...opts, anonymous: opts.anonymous === true });
  const rowOf = (g, id) => groups[g].full.rows.find((r) => r.run === id) ?? null;
  const rows = pv.pairs.map((p) => {
    const id = `${p.pid}-r${p.r}`, states = Object.fromEntries(STAGE_COMPARE_GROUPS.map((g) => [g, rowOf(g, id)?.state ?? "unlaunched"]));
    const both = STAGE_COMPARE_GROUPS.every((g) => states[g] === "observed");
    const values = both ? Object.fromEntries(STAGE_COMPARE_GROUPS.map((g) => [g, rowOf(g, id).stage_pass ? 1 : 0])) : null;
    // 条件と食い違う記録（mismatch）は観測でないので欠測に数える
    const reason = both ? null : STAGE_COMPARE_GROUPS.some((g) => !["observed", "missing", "mismatch"].includes(states[g])) ? "unlaunched" : "missing";
    return { run: id, pid: p.pid, r: p.r, first: p.first, states, stage_pass: values, diff: both ? values[after] - values[before] : null, reason };
  });
  const diffs = rows.filter((r) => r.diff !== null).map((r) => r.diff);
  const byPattern = {};
  for (const r of rows) (byPattern[r.pid] ??= []).push(r.diff);
  const groupOut = Object.fromEntries(STAGE_COMPARE_GROUPS.map((g) => {
    const full = groups[g].full, c = full.completion;
    return [g, {
      role: STAGE_COMPARE_ROLES[g],
      completion: { status: c.status, label: c.label, planned: c.planned, executed: c.executed, unexecuted: c.unexecuted?.length ?? null, incomplete: c.incomplete.length, stage_input_absent: c.stage_input_absent ?? null, stop_code: c.latest_record?.stop_code ?? null },
      fingerprints: Object.fromEntries(COMPARE_FINGERPRINT_CHECKS.map((k) => [k, full.fingerprints[k] ?? null])),
      stage_pass_rate: full.stage_pass_rate, funnel: full.funnel,
    }];
  }));
  // 照合：(i) 未照合（群の照合・指紋）＞ (ii) 完了（全対が両方観測・両群が完了・予算の停止の記録なし）＞ (iii) 未完了
  const unverified = STAGE_COMPARE_GROUPS.flatMap((g) => [
    ...(groups[g].full.completion.status === "unverified" ? [{ group: g, check: "reconcile", value: "unverified" }] : []),
    ...COMPARE_FINGERPRINT_CHECKS.filter((k) => groups[g].full.fingerprints[k] !== true).map((k) => ({ group: g, check: k, value: groups[g].full.fingerprints[k] === false ? false : null })),
  ]);
  const runRecords = readdirSync(outRoot).filter((n) => n.startsWith(COMPARE_RUN_PREFIX) && /^\d+\.json$/.test(n.slice(COMPARE_RUN_PREFIX.length))).sort((a, b) => Number(a.slice(COMPARE_RUN_PREFIX.length, -5)) - Number(b.slice(COMPARE_RUN_PREFIX.length, -5)));
  const lastRun = runRecords.length === 0 ? null : readJsonSafe(join(outRoot, runRecords.at(-1))).value;
  const budgetStop = (isObj(lastRun) && lastRun.stop_code === "budget") || STAGE_COMPARE_GROUPS.some((g) => groups[g].full.completion.latest_record?.stop_code === "budget");
  const reasons = [];
  if (diffs.length !== rows.length) reasons.push("両方が観測されていない対がある");
  if (STAGE_COMPARE_GROUPS.some((g) => groups[g].full.completion.status !== "complete")) reasons.push("群の照合が完了でない");
  if (budgetStop) reasons.push("全体の予算の停止の記録がある");
  const status = unverified.length > 0 ? "unverified" : reasons.length === 0 ? "complete" : "incomplete";
  const absent = groups[before].full.stage_pass_rate.input_absent;
  return {
    schema: STAGE_SCORE_COMPARE_SCHEMA, diff_direction: "今の候補（after）− 凍結した前の候補（before）。対ごとに段の通過を 0／1 にして差を取る（納品の成功・PASS の差ではない）",
    range: stageRangeOf(groups[after].cond),
    completion: { status, label: COMPARE_LABELS[status], reference_only: status !== "complete", reasons: status === "unverified" ? [] : reasons, unverified, budget_stop: budgetStop },
    pairs: {
      planned: rows.length, both: diffs.length, input_absent: absent, excluded: Object.fromEntries(STAGE_PAIR_NULL_REASONS.map((why) => [why, rows.filter((r) => r.reason === why).length])),
      ...pairStats(diffs), rows,
    },
    clusters: { note: CLUSTER_NOTE, ...clusterStats(byPattern) },
    groups: groupOut, scoring_cost_usd: SCORING_COST_USD,
  };
}
/** 段だけの対の比較の匿名の口：件数・n・平均・区間・p だけ（本の ID・P の ID・上流の SHA は出さない） */
export function anonymizeStageCompare(full) {
  const c = full.completion ?? {}, p = full.pairs ?? {};
  const status = enumOrUnknown(Object.keys(COMPARE_LABELS), c.status ?? null);
  return {
    schema: STAGE_SCORE_COMPARE_SCHEMA, anonymous: true,
    range: { start: enumOrUnknown(BUILD_STAGE_IDS, full.range?.start ?? null), end: enumOrUnknown(BUILD_STAGE_IDS, full.range?.end ?? null) },
    completion: {
      status, label: COMPARE_LABELS[status] ?? "unknown", reference_only: status !== "complete", budget_stop: boolOrNull(c.budget_stop),
      unverified: (Array.isArray(c.unverified) ? c.unverified : []).filter((u) => STAGE_COMPARE_GROUPS.includes(u?.group) && (u.check === "reconcile" || COMPARE_FINGERPRINT_CHECKS.includes(u.check))).map((u) => ({ group: u.group, check: u.check, value: u.check === "reconcile" ? "unverified" : u.value === false ? false : null })),
    },
    pairs: { ...intsOf(p, ["planned", "both", "input_absent"]), excluded: intsOf(p.excluded, STAGE_PAIR_NULL_REASONS), ...anonPairStats(p) },
    clusters: anonCluster(full.clusters),
    groups: Object.fromEntries(STAGE_COMPARE_GROUPS.map((g) => {
      const x = full.groups?.[g] ?? {};
      return [g, {
        role: STAGE_COMPARE_ROLES[g],
        completion: { status: enumOrUnknown(Object.keys(COMPARE_LABELS), x.completion?.status ?? null), ...intsOf(x.completion, ["planned", "executed", "unexecuted", "incomplete", "stage_input_absent"]), stop_code: enumOrUnknown(STOP_CODES, x.completion?.stop_code ?? null) },
        fingerprints: Object.fromEntries(COMPARE_FINGERPRINT_CHECKS.map((k) => [k, boolOrNull(x.fingerprints?.[k])])),
        stage_pass_rate: anonymousStagePassRate(x.stage_pass_rate),
      }];
    })),
    scoring_cost_usd: SCORING_COST_USD,
  };
}
/** 標準出力の段だけの対の比較の 1 行 */
export function stageCompareText(full) {
  const p = full.pairs, c = full.completion, cl = full.clusters;
  return `段だけの対の比較（範囲 ${full.range.start}..${full.range.end}。${full.diff_direction}）: ${c.label}${c.reference_only ? "（参考値）" : ""}・対 ${p.planned}（両方観測 ${p.both}・未起動 ${p.excluded.unlaunched}・欠測 ${p.excluded.missing}・入力なしで対に入れない ${p.input_absent}）・差 ＋1 ${p.counts["+1"]}・0 ${p.counts["0"]}・−1 ${p.counts["-1"]}・平均 ${p.mean ?? "-"}（n ${p.n}）・P のまとまり（m ${cl.m}）p ${fixed3(cl.sign_flip.p)}・bootstrap ${rangeText(cl.bootstrap.interval)}（t ${rangeText(cl.t_reference.interval)}。参考）。非有意は「検出されず」`;
}

/** 匿名の失敗で標準エラーに出してよい理由（OS のファイル操作の既知のコードだけ。誤りの文・パス・スタックは出さない） */
const KNOWN_FS_CODES = ["EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR", "ENOENT", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EBUSY", "EEXIST", "ENAMETOOLONG", "ELOOP", "EIO"];

async function main() {
  const [repo, outRoot] = process.argv.slice(2);
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "";
  const anonymous = process.argv.includes("--anonymous");
  const setPath = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : undefined;
  const name = `score${label ? "-" + label : ""}`;
  // 対にした交互の計測の採点（#513）。断り・記録の読み取りの失敗・匿名の失敗の扱いは下の通常の採点と同じ
  if (process.argv.includes("--compare")) return mainCompare(repo, outRoot, { label, anonymous, setPath });
  // 匿名の実行では、採点から匿名化・JSON 化・結果の書き込みまでを 1 つの範囲で守る
  // （予期しない誤りの文・スタックは出力先のパス＝本・組の ID を含みうる。書き込みの失敗が外にあった：fix-427b B1）
  let full, stage = "採点できなかった";
  try {
    full = await scoreOutput(repo, outRoot, { ...(setPath === undefined ? {} : { setPath }), anonymous });
    // 組に無い ID の本（採点せず飛ばした。照合の unscored に残る）。匿名なら件数だけ
    const unscored = full.completion.unscored ?? [];
    if (unscored.length > 0) console.error(anonymous ? `飛ばしました: 組に無い ID の本 ${unscored.length} 本` : `飛ばしました: ${unscored.join(",")}（組 ${full.set.id} に無い ID の本）`);
    if (anonymous) {
      stage = "結果を書けなかった";
      const text = JSON.stringify((full.evaluation?.mode === STAGE_RUN_MODE ? anonymizeStage : anonymize)(full), null, 1);
      writeFileSync(join(outRoot, `${name}.anonymous.json`), text);
      console.log(text);
      return;
    }
  } catch (e) {
    if (e?.refused === true) { console.error(`断りました: ${e.message}`); process.exit(3); }
    // 記録を JSON として読めない（#498 の独立レビューの指摘 1）：通常・匿名のどちらでも、固定の文と既知の符号だけ（例外の文は記録の断片を含みうる）
    if (RECORD_KINDS.includes(e?.recordUnreadable)) { console.error(`失敗しました: 記録を読めなかった [score:record-unreadable:${e.recordUnreadable}]`); process.exit(1); }
    // 匿名の実行では、どの段の予期しない誤りでも文・スタックを標準エラーに出さない。出すのは段と OS の既知のコードだけ
    if (anonymous) { console.error(`失敗しました: ${stage}（${KNOWN_FS_CODES.includes(e?.code) ? `理由: ${e.code}。` : ""}匿名の実行では詳細を出さない。匿名でない実行で確かめる）`); process.exit(1); }
    throw e;
  }
  writeFileSync(join(outRoot, `${name}.json`), JSON.stringify(full, null, 1));
  // 段単位の採点（#545）：計算しない欄の行は出さず、照合・段の通過・範囲の中の漏斗・指紋の行を出す
  if (full.evaluation?.mode === STAGE_RUN_MODE) return printStage(full);
  const { set, metrics, metrics_accepted, metrics_script, fulfillment, completion, fingerprints, bySubject, rows } = full;
  // 標準出力の工場の verdict は既知の値か unknown に写す（#498 の無害化。score.json の metrics・rows の値は変えない）
  const shownVerdicts = {};
  for (const [k, n] of Object.entries(metrics.factory_verdicts)) { const key = k === "none" ? k : verdictOf(k); shownVerdicts[key] = (shownVerdicts[key] ?? 0) + n; }
  console.log(JSON.stringify({ set, metrics: { ...metrics, factory_verdicts: shownVerdicts }, metrics_accepted, metrics_script, fulfillment, completion, bySubject }, null, 1));
  for (const r of rows) console.log([r.run, verdictOf(r.factory_verdict), r.verdict ?? "GEN_FAIL", (r.failed ?? []).join("・"), r.claims ? `claims ok=${r.claims.correct} miss=${r.claims.missed} false=${r.claims.false_claims.length}` : "", r.cost_usd?.toFixed(3), Math.round(r.seconds), `了承後=${r.verdict_accepted ?? "-"}`].join("\t"));
  console.log(completionText(completion));
  // 経路 v1.2 の旗の組の照合（#557。v1.2 の条件のときだけ 1 行）
  if (isObj(full.evaluation?.v12_flags)) console.log(v12FlagsText(full.evaluation.v12_flags));
  const ma = metrics_accepted, ar = ma.absent_reasons, wa = ma.wrong_acceptances, us = ma.unverified_sources;
  console.log(`了承後: 対象 ${ma.runs} 本（確定 ${ma.confirmed}・記録なし ${ma.absent}［未確定 ${ar.plan_not_confirmed}・確定後に仕様なし ${ar.confirmed_without_plan}・不明 ${ar.unknown}］・読めない ${ma.invalid}）・未評価の本 ${fulfillment.accepted.unevaluated.runs}・未検証の有効な要件 ${ma.unverified_requirements} 件（代替先 ${us.accepted_unwritable + us.part}・変更後 ${us.changed}・追加 ${us.added}）・誤った除外 ${ma.wrong_exclusions} 件（判定不能 ${ma.undecided_exclusions} 件）・誤った了承 未評価（証拠 ${wa.evidence} 件・判定不能 ${wa.unmatched + wa.ambiguous} 件・書ける要件の変更 ${wa.unevaluated} 件）・充足 ${fulfillment.accepted.all}（未評価の判定 ${fulfillment.accepted.unevaluated.checks}）`);
  const ms = metrics_script;
  console.log(`台本: 対象 ${ms.runs} 本・問い ${ms.questions}（台本で答えられた ${ms.scripted}［推奨と同じ ${ms.agreed}・違う ${ms.disagreed}］・不明 ${ms.unknown}・決められない ${ms.unresolved}）・本の内訳（一致 ${ms.runs_ok}・不一致 ${ms.runs_disagreed}・不明あり ${ms.runs_unanswered}）`);
  // Plan の表と Build の表（#493）：1 本 1 行と合計
  const tp = full.tables.plan, tb = full.tables.build, sec = (ms) => (ms / 1000).toFixed(1);
  for (const r of tp.rows) console.log(["plan", r.run, r.outcome, r.stop?.classes.join("・") ?? "", `問 ${r.questions ?? "-"}`, `往復 ${r.rounds ?? "-"}`, `${r.stages ? sec(r.stages.total_ms) : "-"}s`, r.usd.toFixed(4)].join("\t"));
  console.log(`Plan の表: ${tp.total.runs} 本（確定 ${tp.total.confirmed}・確定できない ${tp.total.outcomes["cannot-confirm"]}・止まった ${tp.total.outcomes.stopped}・不明 ${tp.total.outcomes.unknown}・記録なし ${tp.total.outcomes.absent}）・問 ${tp.total.questions}・往復 ${tp.total.rounds}・時間 ${sec(tp.total.stages.total_ms)}s・費用 ${tp.total.usd}`);
  for (const r of tb.rows) console.log(["build", r.run, r.factory_verdict ?? "-", r.verdict ?? "-", r.pass ? "PASS" : "-", `${sec(r.stages.total_ms)}s`, r.usd.toFixed(4)].join("\t"));
  console.log(`Build の表: ${tb.total.denominator}・PASS ${tb.total.pass}・工場 ${Object.entries(tb.total.factory_verdicts).map(([k, n]) => `${k} ${n}`).join("・")}・時間 ${sec(tb.total.stages.total_ms)}s・費用 ${tb.total.usd}`);
  // 評価の種類と、Plan の集計・Build だけの集計（#498）。値は件数・率・既知の値・時間と費用の集計だけ
  const { evaluation, metrics_plan: mp, metrics_build: mb } = full;
  const st4 = (x, unit) => (x.observed === 0 ? `-（読めた 0・欠測 ${x.missing}）` : `合計 ${x.total}${unit}・中央値 ${x.median}${unit}（読めた ${x.observed}・欠測 ${x.missing}）`);
  if (mp !== null) {
    const o = mp.outcomes;
    console.log(`Plan の集計（${evaluation.mode}）: ${mp.denominator}・確定 ${mp.confirmed}・確定できない ${o["cannot-confirm"]}・止まった ${o.stopped}・不明 ${o.unknown}・記録なし ${o.absent}・問 ${mp.questions.total}（平均 ${mp.questions.mean ?? "-"}）・往復 ${mp.rounds.total}（平均 ${mp.rounds.mean ?? "-"}）・自由入力 ${mp.free_text.answers}（読めない記録 ${mp.free_text.unreadable}）・時間 ${st4(mp.duration_ms, "ms")}・費用 ${st4(mp.usd, " USD")}${mp.script === null ? "" : `・台本（live）の全問 answered ${mp.script.all_answered}（0 問 ${mp.script.no_questions}・照合の記録なし ${mp.script.unrecorded}）`}${mp.envelope === null ? "" : `・包みの検査 通った ${mp.envelope.passed}・通らない ${mp.envelope.failed}・無い ${mp.envelope.absent}・読めない ${mp.envelope.unreadable}`}`);
  }
  // Plan だけの計測：Build の指標は対象外（既存の行・metrics は今の定義のまま）
  if (evaluation.mode === "plan-only") console.log("Build の指標は対象外（Plan 評価：plan-only の計測は Build を流さない。既存の行と metrics は今の定義のまま出している）");
  if (mb !== null) {
    const ec = mb.exit_classes, rtp = mb.return_to_plan;
    console.log(`Build だけの集計: ${mb.denominator}・終了 ${EXIT_CLASSES.map((k) => `${k} ${ec[k]}`).join("・")}・unknown ${ec.unknown}・exit 2 ${mb.exit_2}（包みの拒否 ${mb.envelope_refusals}）・差し戻し ${rtp.rate}（食い違い ${rtp.inconsistent}・記録なし ${rtp.unrecorded}）・組との照合の食い違い ${mb.frozen_match.mismatched}/${mb.frozen_match.checked}・PASS ${mb.pass}・時間 ${st4(mb.duration_ms, "ms")}・費用 ${st4(mb.usd, " USD")}`);
  }
  // 内外の表と試験の分類（#539）。既存の行は変えず、指紋・漏斗・pass^k の行の前に 1 行
  console.log(agreementText(full.agreement, full.test_findings));
  console.log(fingerprintText(fingerprints, set));
  // 漏斗と pass^k（#538）。既存の行のあとに 1 行ずつ
  console.log(funnelText(full.funnel));
  console.log(passKText(full.pass_k));
}
/** 標準出力の照合の 1 行 */
const completionText = (completion) => `照合: ${completion.label}（予定 ${completion.planned ?? "-"}・実行 ${completion.executed}・採点 ${completion.scored}・未実行 ${completion.unexecuted?.length ?? "-"}・途中 ${completion.incomplete.length}・採点できない ${completion.unscored.length}${completion.latest_record?.stop ? `・止まった理由: ${completion.latest_record.stop}` : ""}${completion.status === "unverified" ? `・理由: ${completion.reasons.join("、")}` : ""}）`;
/** 標準出力の旗の組の照合の 1 行（#557）：照合・起動した本・結果ごとの本の数・条件の旗の名前と真偽 */
const v12FlagsText = (x) => `旗の組（v1.2）: ${x.status === "verified" ? "照合 一致" : "未照合（v12-flags）"}・起動 ${x.launched} 本（${V12_FLAG_STATUSES.map((k) => `${k} ${x.counts[k]}`).join("・")}）・条件の組 ${x.flags === null ? "-" : Object.entries(x.flags).map(([k, v]) => `${k}=${v}`).join(",")}`;
/** 標準出力の指紋の 1 行 */
function fingerprintText(fingerprints, set) {
  const judge = (m) => (m === null ? "条件のファイルに無い" : m ? "条件のファイルと一致" : "条件のファイルと不一致");
  return `指紋: 採点 ${fingerprints.scoring.fingerprint.slice(0, 12)}…（${judge(fingerprints.scoring_matches_conditions)}）・spec-engine ${fingerprints.spec_engine.fingerprint?.slice(0, 12) ?? "-"}…（${judge(fingerprints.spec_engine_matches_conditions)}）・組 ${set.id} v${set.version} ${set.sha256.slice(0, 12)}…（${judge(fingerprints.set_matches_conditions)}）・台本 ${fingerprints.scripts.fingerprint?.slice(0, 12) ?? "-"}…（${judge(fingerprints.scripts_matches_conditions)}）${fingerprints.frozen_matches_conditions === null ? "" : `・凍結した組 ${fingerprints.frozen?.slice(0, 12) ?? "-"}…（${judge(fingerprints.frozen_matches_conditions)}）`}`;
}
/** 段単位の採点の標準出力（#545）：要約の JSON・本ごとの行・照合・段の通過・範囲の中の漏斗・指紋 */
function printStage(full) {
  const { set, evaluation, stage_run, not_computed, completion, rows } = full;
  console.log(JSON.stringify({ set, evaluation, stage_run, not_computed, completion }, null, 1));
  for (const r of rows) console.log(["stage", r.run, r.state, `stage_pass=${r.stage_pass ?? "-"}`, r.reached_stage ?? "-", r.stopped ?? "-", r.stage_judge_verdict ?? "-", r.cost_usd === null ? "-" : r.cost_usd.toFixed(3)].join("\t"));
  console.log(completionText(completion));
  console.log(stagePassText(full.stage_pass_rate));
  console.log(funnelText(full.funnel));
  console.log(fingerprintText(full.fingerprints, set));
}

/** --compare の入口：score-compare[-label].json（匿名なら .anonymous.json だけ）と標準出力。通常の採点と同じく断りは exit 3、記録を読めなければ exit 1 */
async function mainCompare(repo, outRoot, { label, anonymous, setPath }) {
  const name = `${SCORE_COMPARE_FILE}${label ? "-" + label : ""}`;
  let full, stage = "採点できなかった";
  try {
    full = await scoreCompare(repo, outRoot, { ...(setPath === undefined ? {} : { setPath }), anonymous });
    if (anonymous) {
      stage = "結果を書けなかった";
      const text = JSON.stringify((full.schema === STAGE_SCORE_COMPARE_SCHEMA ? anonymizeStageCompare : anonymizeCompare)(full), null, 1);
      writeFileSync(join(outRoot, `${name}.anonymous.json`), text);
      console.log(text);
      return;
    }
  } catch (e) {
    if (e?.refused === true) { console.error(`断りました: ${e.message}`); process.exit(3); }
    if (RECORD_KINDS.includes(e?.recordUnreadable)) { console.error(`失敗しました: 記録を読めなかった [score:record-unreadable:${e.recordUnreadable}]`); process.exit(1); }
    if (anonymous) { console.error(`失敗しました: ${stage}（${KNOWN_FS_CODES.includes(e?.code) ? `理由: ${e.code}。` : ""}匿名の実行では詳細を出さない。匿名でない実行で確かめる）`); process.exit(1); }
    throw e;
  }
  writeFileSync(join(outRoot, `${name}.json`), JSON.stringify(full, null, 1));
  // 段だけの対の比較（#545）：要約の JSON（対の行を除く）・対ごとの行・群ごとの段の通過・比較の 1 行
  if (full.schema === STAGE_SCORE_COMPARE_SCHEMA) {
    const { pairs: { rows: pairRows, ...pairsHead }, groups: stageGroups, ...head } = full;
    console.log(JSON.stringify({ ...head, pairs: pairsHead, groups: Object.fromEntries(Object.entries(stageGroups).map(([g, { funnel: _f, ...x }]) => [g, x])) }, null, 1));
    for (const r of pairRows) console.log(["pair", r.run, `先行 ${r.first}`, ...STAGE_COMPARE_GROUPS.map((g) => `${g} ${r.states[g]}${r.stage_pass === null ? "" : ` stage_pass=${r.stage_pass[g]}`}`), `差 ${r.diff === null ? `-（${r.reason}）` : r.diff > 0 ? `+${r.diff}` : r.diff}`].join("\t"));
    for (const g of STAGE_COMPARE_GROUPS) console.log(`${g} ${stagePassText(stageGroups[g].stage_pass_rate)}`);
    console.log(stageCompareText(full));
    return;
  }
  // 既存の JSON の行は #539 の欄を除いて今までの形のまま
  const { pairs: { rows, by_pattern: byPattern, ...pairs }, stage_pairs, pattern_clusters, noise, ...rest } = full;
  const groups538 = Object.fromEntries(Object.entries(rest.groups).map(([g, { agreement: _a, test_findings: _t, ...x }]) => [g, x]));
  console.log(JSON.stringify({ ...rest, groups: groups538, pairs }, null, 1));
  const GROUPS = Object.keys(rest.groups);
  for (const r of rows) console.log(["pair", r.run, `先行 ${r.first}`, ...GROUPS.map((g) => `${g} ${r.states[g]}${r.pass === null ? "" : ` PASS=${r.pass[g]}`}`), `差 ${r.diff === null ? "-" : r.diff > 0 ? `+${r.diff}` : r.diff}`].join("\t"));
  for (const [pid, v] of Object.entries(byPattern)) console.log(["pattern", pid, `差 ${v.diffs.map((d) => (d === null ? "-" : d)).join(",")}`, `平均 ${v.mean ?? "-"}（n ${v.n}）`].join("\t"));
  const c = full.completion;
  console.log(`比較: ${c.label}${c.reference_only ? "（参考値。正式な比較基準にしない）" : ""}・対 ${pairs.planned}（両方 ${pairs.both}・片側 ${pairs.one_side}・未起動 ${pairs.none}）・差（${full.diff_direction}）＋1 ${pairs.counts["+1"]}・0 ${pairs.counts["0"]}・−1 ${pairs.counts["-1"]}・平均 ${pairs.mean ?? "-"}・区間 ${pairs.interval === null ? "-" : `${pairs.interval[0]}〜${pairs.interval[1]}`}（n ${pairs.n}。参考）${c.status === "unverified" ? `・未照合の項目: ${c.unverified.map((u) => `${u.group}:${u.check}=${u.value}`).join("、")}` : c.reasons.length > 0 ? `・理由: ${c.reasons.join("、")}` : ""}`);
  // 群ごとの漏斗と pass^k（#538）
  for (const g of GROUPS) { console.log(`${g} ${funnelText(full.groups[g].funnel)}`); console.log(`${g} ${passKText(full.groups[g].pass_k)}`); }
  // 群ごとの内外の表と、P のまとまりの 1 行（#539）
  for (const g of GROUPS) console.log(`${g} ${agreementText(full.groups[g].agreement, full.groups[g].test_findings)}`);
  // 経路 v1.2 の群の旗の組の照合（#557。v1.2 の群だけ）
  for (const g of GROUPS) if (isObj(full.groups[g].v12_flags)) console.log(`${g} ${v12FlagsText(full.groups[g].v12_flags)}`);
  console.log(clusterText(stage_pairs, pattern_clusters));
  // 雑音の分解の 1 行（#631。既存の行の後ろ）
  console.log(noiseText(noise));
}

const isEntry = () => { if (process.argv[1] === undefined) return false; try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) await main();
