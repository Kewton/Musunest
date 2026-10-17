// 変異の分類（v1.2 手 5a。#552）。mutate.mjs が作った変異を、原本の使えるか・外の採点との差・人の印から、優先順のある排他的な 7 分類のどれか 1 つに決める。
// 計測の道具であって工場の門ではない：工場の package を import せず、工場の段からも呼ばれない。API・LLM・通信・時計を使わない。
// spec-engine（build 済みの dist/index.js）と外の採点のエンジン（eval/engine.mjs。v5）は、ほかの評価の道具と同じく引数のパスで読む。
// 外の採点は工場の試験とは別の判定である。この道具は工場の判定（verdict）を読まない。
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MAX_PER_SPEC, MutationToolError, OPERATOR_IDS, generateMutants, sha256, specEqual } from "./mutate.mjs";

export const OUTPUT_SCHEMA = "musunest-eval/mutation-classification/v1";
export const MARKS_SCHEMA = "musunest-eval/mutation-marks/v1";

/** 7 分類（上から順に最初に当てはまる 1 つだけ）。id・優先順・意味・分母に入れてよいか */
export const CLASSES = [
  { id: "origin-unusable", priority: 1, in_denominator: false, meaning: "原本が使えない（静的チェックに落ちる・外の採点が PASS でない・原本の印がある）。その原本の変異は全部ここ" },
  { id: "static-fail", priority: 2, in_denominator: false, meaning: "変異が静的チェックに落ちる（門が断つ）" },
  { id: "discrepancy", priority: 3, in_denominator: false, meaning: "外の採点・正規化の結果・人の印が食い違う。どちらも勝たせない" },
  { id: "syntactic-equivalent", priority: 4, in_denominator: false, meaning: "正規化の結果の app.spec が原本と深く等しい（原文の SHA-256 は比べない）" },
  { id: "non-equivalent", priority: 5, in_denominator: true, meaning: "外の採点の check ごとの結果が原本と 1 つ以上違う、または変異の印が非同値（だけ）" },
  { id: "equivalent-marked", priority: 6, in_denominator: false, meaning: "変異の印が同値（だけ）で、外の採点に差が無い" },
  { id: "undecidable", priority: 7, in_denominator: false, meaning: "上のどれでもない（同値とも非同値とも推測しない）" },
];
export const CLASS_IDS = CLASSES.map((c) => c.id);

/** 出力の定義の欄に固定する文 */
export const DENOMINATOR_RULE = "手 5b の検出率の分母に入れてよいのは「非同値（確定）」（non-equivalent）だけである。原本不適・静的に落ちる・食い違い・構文の同値・同値（人の印）・判定不能は分母に入れず、別に数える。";

export const ORIGIN_REASONS = {
  "static-ng": "原本が静的チェックを通らない",
  "not-pass": "原本が外の採点で PASS でない",
  "marked-incorrect": "原本の印がある（原本は正しくない）",
};

export const DISCREPANCY_REASONS = {
  "scoring-vs-equivalent": "外の採点に差があるのに、変異の印は同値",
  "marks-conflict": "同じ変異に非同値と同値の印が両方ある",
  "spec-equal-vs-non-equivalent": "app.spec が原本と深く等しいのに、変異の印は非同値",
};

export const CLASS_REASONS = {
  "static-fail": "静的チェックに落ちる（門が断つ）",
  "syntactic-equivalent": "app.spec が原本と深く等しい（コメントなどだけ違う原文を含む）",
  "non-equivalent:scoring": "外の採点の check の結果が原本と違う",
  "non-equivalent:mark": "変異の印が非同値で、外の採点に差が無い",
  "equivalent-marked": "変異の印が同値で、外の採点に差が無い",
  undecidable: "外の採点に差が無く、印も無い（同値とも非同値とも推測しない）",
};

export const MESSAGES = {
  marksSchema: "印のファイルの schema が知らない値である",
  marksShape: "印は sha256（64 桁の 16 進）・reviewer_role（空でない文字列）・verdict を持つ一覧で書く",
  marksVerdict: "印の verdict が知らない値である（原本の印は incorrect、変異の印は non-equivalent か equivalent）",
  originsShape: "原本は id・source・def を持つ一覧で書く",
  mutantSha: "変異の原文の SHA-256 が申告の値と一致しない（印を適用せずに断る）",
  outputCheck: "出力の検算（7 分類の件数の和・変異ごとの原文の SHA-256）が通らない",
  filePath: "spec-engine と採点のエンジンのパスは文字列で渡す",
};

const ORIGIN_VERDICTS = ["incorrect"];
const MUTANT_VERDICTS = ["non-equivalent", "equivalent"];
const HEX64 = /^[0-9a-f]{64}$/;

/** 印を検証して読む（オブジェクトか JSON の文字列）。知らない値は固定文で断る。null・省略は印なし */
export function loadMarks(input) {
  if (input === null || input === undefined) return { schema: MARKS_SCHEMA, origin_marks: [], mutant_marks: [] };
  const m = typeof input === "string" ? JSON.parse(input) : input;
  if (m === null || typeof m !== "object" || m.schema !== MARKS_SCHEMA) throw new MutationToolError("invalid_marks", MESSAGES.marksSchema);
  const check = (list, verdicts) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new MutationToolError("invalid_marks", MESSAGES.marksShape);
    return list.map((x) => {
      if (x === null || typeof x !== "object" || typeof x.sha256 !== "string" || !HEX64.test(x.sha256) || typeof x.reviewer_role !== "string" || x.reviewer_role.trim() === "") throw new MutationToolError("invalid_marks", MESSAGES.marksShape);
      if (!verdicts.includes(x.verdict)) throw new MutationToolError("invalid_marks", MESSAGES.marksVerdict);
      return { sha256: x.sha256, reviewer_role: x.reviewer_role, verdict: x.verdict };
    });
  };
  return { schema: MARKS_SCHEMA, origin_marks: check(m.origin_marks, ORIGIN_VERDICTS), mutant_marks: check(m.mutant_marks, MUTANT_VERDICTS) };
}

const load = (file) => {
  if (typeof file !== "string" || file === "") throw new MutationToolError("invalid_path", MESSAGES.filePath);
  return import(pathToFileURL(resolve(file)).href);
};

/** spec-engine の dist（入口の js と同じ階層の js。試験の js を除く）の指紋 */
export function fingerprintDir(entryFile) {
  const dir = dirname(resolve(entryFile));
  const names = readdirSync(dir).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js") && statSync(join(dir, n)).isFile()).sort();
  return sha256(names.map((n) => `${n}\n${sha256(readFileSync(join(dir, n), "utf8"))}\n`).join(""));
}

const here = dirname(fileURLToPath(import.meta.url));
const toolFingerprint = () => sha256(["mutate.mjs", "classify.mjs"].map((n) => `${n}\n${sha256(readFileSync(join(here, n), "utf8"))}\n`).join(""));

const sameChecks = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const differingChecks = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => (a ?? {})[k] !== (b ?? {})[k]).sort();

/**
 * 1 つの変異を分類する（優先順。最初に当てはまる 1 つだけ）。
 * 入力：originUsable（原本が使えるか）・原本の読み取りと採点・変異の読み取りと採点・変異の印（その SHA-256 に付いたもの）
 */
export function classifyOne({ originUsable, originReason, originSpec, originChecks, mutantNorm, mutantScore, marks }) {
  if (!originUsable) return { class: "origin-unusable", reason_code: originReason, reason: ORIGIN_REASONS[originReason] };
  if (!mutantNorm.ok) return { class: "static-fail", reason_code: "static-fail", reason: CLASS_REASONS["static-fail"] };
  const eq = marks.some((x) => x.verdict === "equivalent"), non = marks.some((x) => x.verdict === "non-equivalent");
  const checksDiffer = !sameChecks(originChecks, mutantScore.checks);
  const specSame = specEqual(mutantNorm.app.spec, originSpec);
  const discrepancy = checksDiffer && eq ? "scoring-vs-equivalent" : non && eq ? "marks-conflict" : specSame && non ? "spec-equal-vs-non-equivalent" : null;
  if (discrepancy) return { class: "discrepancy", reason_code: discrepancy, reason: DISCREPANCY_REASONS[discrepancy] };
  if (specSame) return { class: "syntactic-equivalent", reason_code: "syntactic-equivalent", reason: CLASS_REASONS["syntactic-equivalent"] };
  if (checksDiffer) return { class: "non-equivalent", reason_code: "non-equivalent:scoring", reason: CLASS_REASONS["non-equivalent:scoring"] };
  if (non) return { class: "non-equivalent", reason_code: "non-equivalent:mark", reason: CLASS_REASONS["non-equivalent:mark"] };
  if (eq) return { class: "equivalent-marked", reason_code: "equivalent-marked", reason: CLASS_REASONS["equivalent-marked"] };
  return { class: "undecidable", reason_code: "undecidable", reason: CLASS_REASONS.undecidable };
}

const emptyByClass = () => Object.fromEntries(CLASS_IDS.map((c) => [c, 0]));

/**
 * 変異を作って分類する。
 *   engineFile … spec-engine の dist/index.js のパス　scoringEngineFile … eval/engine.mjs のパス（外の採点。v5）
 *   origins … [{ id, source（原文）, def（題材の定義のオブジェクト）}]　marks … 印（省略可）
 *   operators・max … mutate.mjs へ渡す　mutants … { 原本の id: 変異の一覧 } を渡すと、作らずにその一覧を分類する（原文が違うだけの変異などの試験用）
 */
export async function classifyMutations({ engineFile, scoringEngineFile, origins, marks = null, operators = OPERATOR_IDS, max = DEFAULT_MAX_PER_SPEC, mutants: given = null }) {
  const engine = await load(engineFile), scoring = await load(scoringEngineFile);
  const markSet = loadMarks(marks);
  if (!Array.isArray(origins) || origins.some((o) => o === null || typeof o !== "object" || typeof o.id !== "string" || typeof o.source !== "string" || o.def === null || typeof o.def !== "object")) throw new MutationToolError("invalid_origins", MESSAGES.originsShape);

  // 外から渡された変異は、印を適用する前に原文の SHA-256 を計算して申告と照合する（計算し直して通さない）
  if (given !== null) for (const list of Object.values(given)) for (const m of list) if (m === null || typeof m !== "object" || typeof m.source !== "string" || sha256(m.source) !== m.sha256) throw new MutationToolError("mutant_sha_mismatch", MESSAGES.mutantSha);

  const tmp = mkdtempSync(join(tmpdir(), "mutation-classify-"));
  const scoreText = async (text, def) => {
    const file = join(tmp, "candidate.app.spec.yaml");
    writeFileSync(file, text);
    return scoring.score(engine, file, def);
  };
  try {
    const originOut = [], mutantOut = [];
    const byOperator = {};
    for (const o of origins) {
      const originSha = sha256(o.source);
      const norm = await engine.normalizeSpec(o.source);
      const scored = norm.ok ? await scoreText(o.source, o.def) : null;
      const marked = markSet.origin_marks.filter((x) => x.sha256 === originSha);
      const reason = !norm.ok ? "static-ng" : scored.verdict !== "PASS" ? "not-pass" : marked.length > 0 ? "marked-incorrect" : null;
      const usable = reason === null;
      const gen = given ? null : await generateMutants({ engine, source: o.source, operators, max });
      const list = given ? given[o.id] ?? [] : gen.mutants;
      const byClass = emptyByClass();
      for (const m of list) {
        const mNorm = norm.ok ? await engine.normalizeSpec(m.source) : { ok: false };
        const mScore = usable && mNorm.ok ? await scoreText(m.source, o.def) : null;
        const markOf = markSet.mutant_marks.filter((x) => x.sha256 === m.sha256);
        const c = classifyOne({ originUsable: usable, originReason: reason, originSpec: norm.ok ? norm.app.spec : null, originChecks: scored?.checks, mutantNorm: mNorm, mutantScore: mScore, marks: markOf });
        byClass[c.class] += 1;
        byOperator[m.operator] ??= { total: 0, ...emptyByClass() };
        byOperator[m.operator].total += 1;
        byOperator[m.operator][c.class] += 1;
        mutantOut.push({
          origin_id: o.id, id: m.id, operator: m.operator, place: m.place, lines: m.lines, source: m.source, sha256: m.sha256,
          class: c.class, reason_code: c.reason_code, reason: c.reason,
          differing_checks: mScore ? differingChecks(scored.checks, mScore.checks) : null,
          marks: markOf.map((x) => ({ reviewer_role: x.reviewer_role, verdict: x.verdict })),
        });
      }
      originOut.push({
        id: o.id, sha256: originSha, subject_id: o.def.id ?? null, subject_sha256: sha256(JSON.stringify(o.def)),
        usable, reason_code: reason, reason: reason === null ? null : ORIGIN_REASONS[reason],
        scoring_verdict: scored?.verdict ?? "STATIC_NG",
        marks: marked.map((x) => ({ reviewer_role: x.reviewer_role, verdict: x.verdict })),
        generation: gen ? { origin_readable: gen.origin_readable, ...gen.counts } : { origin_readable: norm.ok, provided: true, kept: list.length },
        counts: { mutants: list.length, by_class: byClass },
      });
    }
    // 一覧に無い SHA-256 の印は無視して数える
    const originShas = new Set(originOut.map((x) => x.sha256)), mutantShas = new Set(mutantOut.map((x) => x.sha256));
    const ignored = {
      origin: markSet.origin_marks.filter((x) => !originShas.has(x.sha256)).length,
      mutant: markSet.mutant_marks.filter((x) => !mutantShas.has(x.sha256)).length,
    };
    const byClass = emptyByClass();
    for (const m of mutantOut) byClass[m.class] += 1;
    const result = {
      schema: OUTPUT_SCHEMA,
      definitions: { classes: CLASSES, detection_denominator_rule: DENOMINATOR_RULE, priority_rule: "上から順に最初に当てはまる 1 つだけ。1 つの変異は 2 つの分類に入らない" },
      fingerprints: {
        tool: toolFingerprint(),
        spec_engine: fingerprintDir(engineFile),
        scoring_engine: sha256(readFileSync(resolve(scoringEngineFile), "utf8")),
        marks: sha256(JSON.stringify(markSet)),
        origins: Object.fromEntries(originOut.map((x) => [x.id, { source: x.sha256, subject_definition: x.subject_sha256 }])),
      },
      origins: originOut,
      mutants: mutantOut,
      counts: {
        mutants: mutantOut.length,
        by_class: byClass,
        by_operator: byOperator,
        detection_denominator: byClass["non-equivalent"],
        ignored_marks: ignored,
      },
    };
    if (!verifyOutput(result)) throw new MutationToolError("output_check_failed", MESSAGES.outputCheck);
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 出力の検算：7 分類の件数の和が作れた変異の数と等しく、変異ごとの原文の SHA-256 が出力の値と一致する */
export function verifyOutput(out) {
  const sum = Object.values(out.counts.by_class).reduce((a, b) => a + b, 0);
  return sum === out.counts.mutants && out.mutants.length === out.counts.mutants && out.mutants.every((m) => sha256(m.source) === m.sha256 && CLASS_IDS.includes(m.class));
}

// ── 利用の入口（node classify.mjs <入力の JSON のファイル> で直接起動されたときだけ動く。import したときは何も起きない）
// 入力の JSON：classifyMutations の引数（engineFile・scoringEngineFile・origins・marks・operators・max・mutants）。結果の JSON を標準出力へ。
// MutationToolError は「符号 固定文」の 1 行を標準エラーに出して exit 3（変異の SHA-256 の不一致・出力の検算の失敗を含む）
export const EXIT_REFUSED = 3;
const isEntry = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntry()) {
  try {
    const file = process.argv[2];
    if (!file) throw new MutationToolError("invalid_input", "使い方: node classify.mjs <入力の JSON のファイル>");
    const out = await classifyMutations(JSON.parse(readFileSync(file, "utf8")));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    if (!(e instanceof MutationToolError)) throw e;
    process.stderr.write(`${e.code} ${e.message}\n`);
    process.exitCode = EXIT_REFUSED;
  }
}
