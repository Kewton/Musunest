// 変異の生成（v1.2 手 5a。#552）。凍結した宣言（app.spec.yaml の原文）から、意味の変わる小さな変異をコードで決定的に作る。
// 計測の道具であって工場の門ではない：工場・門・検証の定義を変えず、工場の package を import せず、工場の段からも呼ばれない。API・LLM・通信・時計を使わない。
// spec-engine は build 済みの物を、呼び出し側が引数（engine ＝ そのモジュール）で渡す（ほかの評価の道具と同じ）。
//
// 1 つの変異は 1 か所の 1 つの変更。原文のうち、その場所の行の範囲だけを書き換える（範囲はこの道具が決定的に求める）。
// 書き換えた原文を spec-engine の読み取りで読み直し、変えた場所の外の値が原本と深く等しいことを確かめる
// （キーの順・配列の順も含めて比べる。選択肢の順は意味を持つので、順だけの違いも「等しくない」）。
// 読めない・場所の外まで変わる・原文が変わらない書き換えは「作れなかった」に数えて捨てる（推測で直さない）。
import { createHash } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data, "utf8").digest("hex");

/** 変異の演算子（データ。1 演算子 1 行）。並びは同じ場所に複数の変異があるときの順にも使う */
export const OPERATORS = [
  { id: "remove-field", why: "entity の項目を 1 つ消す。その項目を前提にする要件を試験が落とせるか", since: "#552" },
  { id: "flip-comparison", why: "式の比較の演算子を 1 つ反転する（小さい と 以上、大きい と 以下、等しい と 等しくない）。境界・向きの誤りを試験が落とせるか", since: "#552" },
  { id: "remove-when", why: "操作の when を 1 つ消す。操作してよい条件の欠落を試験が落とせるか", since: "#552" },
  { id: "reorder-options", why: "選択肢の項目の options の隣り合う 2 つを入れ替える。順が意味を持つ（先頭・並び）ことを試験が落とせるか", since: "#552" },
  { id: "change-default", why: "選択肢の項目の default を options の別のキーに替える。登録時の状態の誤りを試験が落とせるか", since: "#552" },
  { id: "remove-validation", why: "検査を 1 つ消す。入力の制約の欠落を試験が落とせるか", since: "#552" },
  { id: "swap-aggregate", why: "集計の種類を 1 つ替える（sum と count）。集計の種類の取り違えを試験が落とせるか", since: "#552" },
];
export const OPERATOR_IDS = OPERATORS.map((o) => o.id);

/** 宣言 1 本あたりの変異の上限の既定 */
export const DEFAULT_MAX_PER_SPEC = 50;

/** 断る固定文（入力の値は文に入れない） */
export const MESSAGES = {
  unknownOperator: "未登録の変異の演算子は扱わない",
  invalidMax: "宣言 1 本あたりの上限は 1 以上の整数で指定する",
  invalidOperators: "演算子の指定は文字列の一覧で書く",
};

export class MutationToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MutationToolError";
    this.code = code;
  }
}

/** 作れなかった理由の固定文 */
export const NOT_BUILT_REASONS = {
  "reread-failed": "書き換えた原文を spec-engine が読めなかった",
  "outside-changed": "変えた場所の外の値が原本と等しくなかった",
  "no-change": "書き換えても原文が変わらなかった",
};

// ── 行の読み取り（ブロック形式の YAML の、字下げだけを見る最小の読み取り。読めない形は場所を作らない）
const indentOf = (line) => line.length - line.trimStart().length;
const skippable = (line) => line.trim() === "" || line.trimStart().startsWith("#");
const unquote = (s) => (/^(["']).*\1$/.test(s) && s.length >= 2 ? s.slice(1, -1) : s);

/** "key: value" の行（先頭の "- " は除いて渡す）から key と value を取る。読めなければ null */
function parseKeyLine(content) {
  const m = /^("[^"]*"|'[^']*'|[^\s:#"'][^:#]*?)\s*:(?:\s+(.*))?$/.exec(content.trimEnd());
  return m ? { key: unquote(m[1]), value: (m[2] ?? "").trim() } : null;
}

class Doc {
  constructor(lines) {
    this.lines = lines;
  }
  /** 行 i から始まるブロックの終わり（含まない）。字下げが limit 以下の次の意味のある行まで。末尾のコメント・空行は含めない */
  endOf(i, limit, allowDashAtLimit = false) {
    let last = i;
    for (let j = i + 1; j < this.lines.length; j++) {
      const l = this.lines[j];
      if (skippable(l)) continue;
      const ind = indentOf(l);
      if (ind < limit || (ind === limit && !(allowDashAtLimit && l.trimStart().startsWith("- ")))) break;
      last = j;
    }
    return last + 1;
  }
  /** 最上位の節（"name:"）の行番号。無ければ -1 */
  section(name) {
    return this.lines.findIndex((l) => indentOf(l) === 0 && new RegExp(`^${name}:\\s*(#.*)?$`).test(l.trimEnd()));
  }
  /** 節の列の要素（"- " で始まる行）：{ start, end, c }（c は要素の写像のキーの字下げ） */
  items(name) {
    const s = this.section(name);
    if (s < 0) return [];
    const end = this.endOf(s, 0, true);
    let first = -1;
    for (let j = s + 1; j < end; j++) if (!skippable(this.lines[j])) { first = j; break; }
    if (first < 0 || !this.lines[first].trimStart().startsWith("- ")) return [];
    const k = indentOf(this.lines[first]);
    const out = [];
    for (let j = s + 1; j < end; j++) {
      const l = this.lines[j];
      if (skippable(l) || indentOf(l) !== k || !l.trimStart().startsWith("- ")) continue;
      const rest = l.trimStart().slice(2);
      out.push({ start: j, end: this.endOf(j, k), c: k + 2 + (rest.length - rest.trimStart().length) });
    }
    return out;
  }
  /** 要素の中（字下げ c）のキーの行。最初の行は "- " の後ろを読む */
  keyIn(item, key, c = item.c) {
    for (let j = item.start; j < item.end; j++) {
      const l = this.lines[j];
      if (skippable(l)) continue;
      const ind = indentOf(l);
      const content = j === item.start ? l.trimStart().slice(2).trimStart() : l.trimStart();
      if ((j === item.start ? c : ind) !== c) continue;
      const kv = parseKeyLine(content);
      if (kv && kv.key === key) return { line: j, ...kv, ind: c };
    }
    return null;
  }
  /** キーの行 kl（字下げ ind）の子（写像の項目）の行：{ line, key, value, end }。子の字下げは最初の子で決める */
  children(kl) {
    const end = this.endOf(kl.line, kl.ind);
    let d = -1;
    for (let j = kl.line + 1; j < end; j++) if (!skippable(this.lines[j])) { d = indentOf(this.lines[j]); break; }
    if (d < 0) return { d, list: [] };
    const list = [];
    for (let j = kl.line + 1; j < end; j++) {
      const l = this.lines[j];
      if (skippable(l) || indentOf(l) !== d) continue;
      const kv = parseKeyLine(l.trimStart());
      if (kv) list.push({ line: j, ...kv, ind: d, end: this.endOf(j, d) });
    }
    return { d, list };
  }
}

// ── 式の比較の演算子（文字列の中は見ない）
const FLIP = { "<": ">=", ">=": "<", ">": "<=", "<=": ">", "==": "!=", "!=": "==" };

/** 式の文字列のうち、比較の演算子の出現（[start, end) と演算子）を原文の順に返す */
export function comparisonsIn(text) {
  const out = [];
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q === null) {
      if (c === "\\" && (n === '"' || n === "'")) { q = n; i++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      const two = c + (n ?? "");
      if (two in FLIP) { out.push({ start: i, end: i + 2, op: two }); i++; continue; }
      if (c === "<" || c === ">") out.push({ start: i, end: i + 1, op: c });
    } else if (c === "\\" && n === q) { q = null; i++; }
    else if (c === q) q = null;
  }
  return out;
}

/** 行の "key:" の後ろの値の範囲 [from, to)（外側の引用符の中・行末のコメントを除く）。1 行で書かれた値だけ */
function valueRegion(line, key) {
  const m = new RegExp(`^(\\s*(?:- )?\\s*${key}:\\s+)(\\S.*)$`).exec(line.replace(/\r$/, ""));
  if (!m) return null;
  let from = m[1].length, rest = m[2];
  if (/^[|>]/.test(rest)) return null;
  const quote = rest[0];
  if ((quote === '"' || quote === "'") && rest.length >= 2 && rest.trimEnd().endsWith(quote)) {
    const t = rest.trimEnd();
    return { from: from + 1, to: from + t.length - 1 };
  }
  const hash = rest.search(/\s#/);
  if (hash >= 0) rest = rest.slice(0, hash);
  return { from, to: from + rest.trimEnd().length };
}

// ── 場所の列挙：{ op, place, id, order（並び）, from, to（行の範囲。to は含まない）, replacement（行の列）, mask }
// mask は変えた場所の外を比べるときの、spec の中の場所（path）と方式（remove：原本から取り除く／replace：両方で null にする）
function sitesFor(doc, spec) {
  const sites = [];
  const add = (op, id, place, from, to, replacement, mask, occ = 0) => sites.push({ op, id, place, from, to, replacement, mask, occ });
  const L = doc.lines;
  const entityItems = doc.items("entities");

  entityItems.forEach((it, ei) => {
    const fieldsKey = doc.keyIn(it, "fields");
    if (!fieldsKey) return;
    const { list } = doc.children(fieldsKey);
    const ename = doc.keyIn(it, "name")?.value ?? String(ei);
    for (const f of list) {
      const fpath = ["entities", ei, "fields", f.key];
      add("remove-field", `remove-field@entities[${ei}].fields.${f.key}`, `${ename}.${f.key}`, f.line, f.end, [], { path: fpath, mode: "remove" });
      // 選択肢（options・default）。項目の子のキー
      const opts = { line: f.line, ind: f.ind };
      const fchildren = doc.children(opts);
      const optionsKey = fchildren.list.find((c) => c.key === "options");
      const defaultKey = fchildren.list.find((c) => c.key === "default");
      if (!optionsKey) continue;
      const options = doc.children(optionsKey).list;
      for (let k = 0; k + 1 < options.length; k++) {
        const a = options[k], b = options[k + 1];
        if (a.end !== a.line + 1 || b.end !== b.line + 1) continue;
        add("reorder-options", `reorder-options@entities[${ei}].fields.${f.key}.options#${k}`, `${ename}.${f.key}.options(${a.key},${b.key})`, a.line, b.end, [L[b.line], L[a.line]], { path: [...fpath, "options"], mode: "replace" }, k);
      }
      if (defaultKey && options.length >= 2) {
        const keys = options.map((o) => o.key);
        const at = keys.indexOf(unquote(defaultKey.value.replace(/\s+#.*$/, "")));
        const m = /^(\s*default:\s*)(?:"([^"]*)"|'([^']*)'|([^\s#]+))(\s*(?:#.*)?)$/.exec(L[defaultKey.line].replace(/\r$/, ""));
        if (at >= 0 && m) {
          const next = keys[(at + 1) % keys.length];
          const q = m[2] !== undefined ? '"' : m[3] !== undefined ? "'" : "";
          const cr = L[defaultKey.line].endsWith("\r") ? "\r" : "";
          add("change-default", `change-default@entities[${ei}].fields.${f.key}.default`, `${ename}.${f.key}.default(${keys[at]}→${next})`, defaultKey.line, defaultKey.line + 1, [`${m[1]}${q}${next}${q}${m[5]}${cr}`], { path: [...fpath, "default"], mode: "replace" });
        }
      }
    }
  });

  doc.items("validations").forEach((it, i) => {
    const name = doc.keyIn(it, "name")?.value ?? String(i);
    add("remove-validation", `remove-validation@validations[${i}]`, `validations.${name}`, it.start, it.end, [], { path: ["validations", i], mode: "remove" });
  });

  doc.items("actions").forEach((it, i) => {
    const name = doc.keyIn(it, "name")?.value ?? String(i);
    const w = doc.keyIn(it, "when");
    if (w && w.line !== it.start) add("remove-when", `remove-when@actions[${i}].when`, `actions.${name}.when`, w.line, doc.endOf(w.line, w.ind), [], { path: ["actions", i, "when"], mode: "remove" });
  });

  const flipSites = (section, key) => {
    doc.items(section).forEach((it, i) => {
      const kl = doc.keyIn(it, key);
      if (!kl) return;
      const line = L[kl.line], region = valueRegion(line, key);
      if (!region) return;
      const name = doc.keyIn(it, "name")?.value ?? String(i);
      const hits = comparisonsIn(line.slice(region.from, region.to));
      hits.forEach((h, n) => {
        const s = region.from + h.start, e = region.from + h.end;
        add("flip-comparison", `flip-comparison@${section}[${i}].${key}#${n}`, `${section}.${name}.${key}(${h.op}→${FLIP[h.op]})`, kl.line, kl.line + 1, [line.slice(0, s) + FLIP[h.op] + line.slice(e)], { path: [section, i, key], mode: "replace" }, n);
      });
    });
  };
  flipSites("validations", "expression");
  flipSites("actions", "when");
  flipSites("computed", "expression");

  doc.items("computed").forEach((it, i) => {
    const ak = doc.keyIn(it, "aggregate");
    if (!ak) return;
    const kind = doc.children(ak).list.find((c) => c.key === "sum" || c.key === "count");
    if (!kind || kind.end !== kind.line + 1 || kind.value === "") return;
    const name = doc.keyIn(it, "name")?.value ?? String(i);
    const pad = " ".repeat(kind.ind), cr = L[kind.line].endsWith("\r") ? "\r" : "";
    let swapped = null;
    if (kind.key === "sum") swapped = `${pad}count: ${kind.value.split(".")[0]}${cr}`;
    else {
      const entity = spec.entities?.find((e) => e.name === kind.value);
      const num = entity && Object.entries(entity.fields).find(([, f]) => f.type === "number")?.[0];
      if (num) swapped = `${pad}sum: ${kind.value}.${num}${cr}`;
    }
    if (swapped) add("swap-aggregate", `swap-aggregate@computed[${i}].aggregate`, `computed.${name}.aggregate(${kind.key}→${kind.key === "sum" ? "count" : "sum"})`, kind.line, kind.line + 1, [swapped], { path: ["computed", i, "aggregate"], mode: "replace" });
  });

  return sites;
}

// ── 場所の外の比較
const clone = (v) => JSON.parse(JSON.stringify(v));
function applyMask(spec, mask, side) {
  const s = clone(spec);
  const parent = mask.path.slice(0, -1).reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), s);
  const last = mask.path[mask.path.length - 1];
  if (parent === undefined || parent === null) return s;
  if (mask.mode === "remove") {
    if (side === "origin") { if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last]; }
  } else parent[last] = null;
  return s;
}

/** 深く等しい（キーの順・配列の順も含める。選択肢の順は意味を持つ） */
export const specEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 変異を作る。引数：engine（spec-engine のモジュール）・source（原文）・operators（省略すると全部）・max（上限。既定 50）。
 * 未登録の演算子・不正な上限は固定文で断る。原本が読めなければ変異は 0 件（原本の読み取りの失敗を origin_readable: false で返す）。
 */
export async function generateMutants({ engine, source, operators = OPERATOR_IDS, max = DEFAULT_MAX_PER_SPEC }) {
  if (!Array.isArray(operators) || operators.some((o) => typeof o !== "string")) throw new MutationToolError("invalid_operators", MESSAGES.invalidOperators);
  if (operators.some((o) => !OPERATOR_IDS.includes(o))) throw new MutationToolError("unknown_operator", MESSAGES.unknownOperator);
  if (!Number.isInteger(max) || max < 1) throw new MutationToolError("invalid_max", MESSAGES.invalidMax);
  const selected = new Set(operators);
  const base = { origin_sha256: sha256(source), operators: OPERATOR_IDS.filter((o) => selected.has(o)) };
  const orig = await engine.normalizeSpec(source);
  if (!orig.ok) return { ...base, origin_readable: false, mutants: [], not_built: [], counts: { candidates: 0, built: 0, kept: 0, truncated: 0, not_built: 0, by_operator: {} } };

  const lines = source.split("\n");
  const sites = sitesFor(new Doc(lines), orig.app.spec)
    .filter((s) => selected.has(s.op))
    .sort((a, b) => a.from - b.from || OPERATOR_IDS.indexOf(a.op) - OPERATOR_IDS.indexOf(b.op) || a.occ - b.occ);

  const built = [], notBuilt = [];
  for (const s of sites) {
    const text = [...lines.slice(0, s.from), ...s.replacement, ...lines.slice(s.to)].join("\n");
    const fail = (reason) => notBuilt.push({ id: s.id, operator: s.op, place: s.place, reason });
    if (text === source) { fail("no-change"); continue; }
    const r = await engine.normalizeSpec(text);
    if (!r.ok) { fail("reread-failed"); continue; }
    if (!specEqual(applyMask(orig.app.spec, s.mask, "origin"), applyMask(r.app.spec, s.mask, "mutant"))) { fail("outside-changed"); continue; }
    built.push({ id: s.id, operator: s.op, place: s.place, lines: { from: s.from + 1, to: Math.max(s.to, s.from + 1) }, source: text, sha256: sha256(text) });
  }
  const kept = built.slice(0, max);
  const byOperator = {};
  for (const m of kept) byOperator[m.operator] = (byOperator[m.operator] ?? 0) + 1;
  return {
    ...base,
    origin_readable: true,
    mutants: kept,
    not_built: notBuilt,
    counts: { candidates: sites.length, built: built.length, kept: kept.length, truncated: built.length - kept.length, not_built: notBuilt.length, by_operator: byOperator },
  };
}
