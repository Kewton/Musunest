// 採点表 v5：汎用の採点エンジン（#277）。題材ごとの定義（subjects/*.json）を読み、宣言 1 枚を採点する。
// v4（#168 第 5 段の rubric-v4.mjs）の判定を、すべて「判定の種類 ＋ 引数」で表せるようにした。名前は見ない。
// 振る舞いは spec-engine の評価器に値を入れて確かめる。時計は 2026-10-08T12:00:00+09:00 に固定（定義で変えられる）。
//
// 2026-10-09 所有者の決定（v4 からの変更）：
//   ① `show` を書かない table・list と、`type` の無い一覧は、項目と計算を全部並べるものとして読む
//   ② 別の構造：定義に複数の構造（structures）を書ける。2 つ目以降の構造（alt）は、書ける要件をすべて満たし、
//      **書けない要件を正しく申告したときだけ**合格（申告は score-claims.mjs が見る。宣言だけでは PASS_NEEDS_CLAIM）
//      要件が選択肢を固定している場合の enum の代わりの entity は、構造として定義しない（＝役割が見つからず不合格）
//   ③ 最初に開く画面は採点しない（判定の種類を持たない）
// 第 4 段の決定：負の数＋降順の ranking は「少ない順」として合格（rankingOrder）。ダッシュボードの部品も「見られる」に含める。
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const fieldsOf = (e) => Object.entries(e.fields).map(([name, f]) => (typeof f === "string" ? { name, type: f } : { name, ...f }));
const labelsOf = (f) => (f.type === "enum" ? Object.values(f.options) : []);
const keyByLabel = (f, label) => Object.entries(f.options ?? {}).find(([, l]) => l === label)?.[0];
const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));
const isCreate = (a) => a.kind === undefined || a.kind === "create";
const widgetsOf = (spec) => spec.views.filter((v) => v.type === "dashboard").flatMap((v) => v.widgets ?? []);
const targetOf = (f) => f.to ?? f.of; // ref は to、参照の並び（list）は of（正規化後）

// ── 決定①：「見られる」。entity の行の計算（または項目）が、どこかの画面に出ているか
export function shownForEntity(spec, entity, name) {
  for (const v of spec.views) {
    if (v.entity !== entity) continue;
    if (v.type === undefined) return true; // type の無い一覧：項目に続けて計算を全部並べる
    if ((v.type === "table" || v.type === "list") && (v.show === undefined || v.show.includes(name))) return true;
  }
  return widgetsOf(spec).some((w) => w.type === "ranking" && w.entity === entity && (w.by === name || (w.show ?? []).includes(name)));
}
const shownOnDashboard = (spec, name, types) => widgetsOf(spec).some((w) => types.includes(w.type) && w.value === name);

// ── 役割の結び付け：定義の roles を、宣言の entity と項目に当てはめる（バックトラック。全ての組を返す）
function bindRoles(spec, roles) {
  const names = Object.keys(roles);
  const out = [];
  const step = (i, b, usedE, usedF) => {
    if (out.length >= 200) return;
    if (i === names.length) { out.push({ ...b }); return; }
    const n = names[i], r = roles[n];
    if (r.entity) {
      for (const e of spec.entities) {
        if (usedE.has(e.name)) continue;
        const fs = fieldsOf(e);
        if ((r.entity.hasFieldTypes ?? []).some((t) => !fs.some((f) => f.type === t))) continue;
        b[n] = e; usedE.add(e.name);
        step(i + 1, b, usedE, usedF);
        usedE.delete(e.name); delete b[n];
      }
    } else {
      const spec_ = r.field, owner = b[spec_.of];
      for (const f of fieldsOf(owner)) {
        const key = `${owner.name}.${f.name}`;
        if (usedF.has(key) || f.type !== spec_.type) continue;
        if (spec_.labels && !sameSet(labelsOf(f), spec_.labels)) continue;
        if (spec_.to && targetOf(f) !== b[spec_.to].name) continue;
        b[n] = { ...f, entity: owner.name }; usedF.add(key);
        step(i + 1, b, usedE, usedF);
        usedF.delete(key); delete b[n];
      }
    }
  };
  step(0, {}, new Set(), new Set());
  return out;
}

// 定義の値（役割の名前をキーにした set）を、宣言の項目の名前に直す
const setFor = (B, set = {}) => Object.fromEntries(Object.entries(set).map(([role, v]) => [B[role].name, v]));

function recordFor(e, today, over = {}) {
  const r = {};
  for (const f of fieldsOf(e)) {
    if (f.type === "string") r[f.name] = "x";
    else if (f.type === "number") r[f.name] = 1;
    else if (f.type === "date") r[f.name] = today;
    else if (f.type === "enum") r[f.name] = f.default ?? Object.keys(f.options)[0];
    else if (f.type === "ref") r[f.name] = "m1";
    else if (f.type === "list") r[f.name] = ["m1"];
  }
  return { ...r, ...over };
}

// ── 判定の種類
function makeKinds(engine, app, spec, B, clock, today) {
  const ent = (role) => B[role]; // entity の役割
  const ev = (entity, record, extra = {}) => engine.evaluateRecord({ app, entity, record, clock, ...extra });
  const rec = (role, set) => recordFor(ent(role), today, setFor(B, set));
  const sourcesFor = (sources = {}) =>
    Object.fromEntries(Object.entries(sources).map(([role, rows]) => [ent(role).name, rows.map((row, i) => ({ id: row.id ?? `${role}${i + 1}`, data: recordFor(ent(role), today, setFor(B, row.set)) }))]));
  const fails = (role, set) => ev(ent(role).name, rec(role, set)).validations.length > 0;
  const statusEnum = (fieldRole) => B[fieldRole];
  return {
    // 登録の操作（create）が、どの entity にもある
    creatable: (a) => a.entities.every((r) => spec.actions.some((x) => x.entity === ent(r).name && isCreate(x))),
    // その entity に、kinds のどの種類の操作もある（update・delete）
    actionExists: (a) => a.kinds.every((k) => spec.actions.some((x) => x.entity === ent(a.entity).name && x.kind === k)),
    // 選択肢の既定値が、表示名 label の鍵
    enumDefault: (a) => statusEnum(a.field).default === keyByLabel(statusEnum(a.field), a.label),
    // 状態を from から to へ進める update の操作があり、when が from の行で真・from 以外のすべての行で偽
    advanceAction: (a) => {
      const f = statusEnum(a.field), owner = f.entity, from = keyByLabel(f, a.from), to = keyByLabel(f, a.to);
      const act = spec.actions.find((x) => x.entity === owner && x.kind === "update" && x.set?.[f.name] === to);
      if (!act) return false;
      const ownerRole = Object.keys(B).find((k) => B[k].name === owner && B[k].fields);
      const allow = (v) => engine.allowsAction({ app, entity: owner, record: recordFor(ent(ownerRole), today, { [f.name]: v }), clock }, act.when ?? "true");
      // from の行でだけ真。from 以外の選択肢（to を含む）のどれでも偽（3 段以上の状態で、別の状態にもボタンが出るものを落とす）
      return allow(from) && Object.keys(f.options).filter((k) => k !== from).every((k) => !allow(k));
    },
    // その選択肢の項目で列を作るボード
    boardColumns: (a) => spec.views.some((v) => v.type === "board" && v.entity === B[a.field].entity && v.columns === B[a.field].name),
    // 一覧（list）の filters に、項目がすべてある
    listFilters: (a) => spec.views.some((v) => v.type === "list" && v.entity === ent(a.entity).name && a.fields.every((r) => (v.filters ?? []).includes(B[r].name))),
    // 検査：cases の各行で、検査に落ちる（valid: false）／通る（valid: true）
    validation: (a) => a.cases.every((c) => fails(a.entity, c.set) === !c.valid),
    // 計算（または項目）の値が probes のとおりで、その entity の画面から見える。aggregateOnly なら集計の計算だけ
    computedVisible: (a) => {
      const e = ent(a.entity), sources = sourcesFor(a.sources);
      const valueOf = (name, p) => {
        const r = ev(e.name, rec(a.entity, p.set), { recordId: p.recordId ?? "x1", sources });
        return name in r.computed ? r.computed[name] : r.record?.[name];
      };
      const cands = spec.computed.filter((c) => c.entity === e.name && (!a.aggregateOnly || c.aggregate));
      return cands.some((c) => a.probes.every((p) => valueOf(c.name, p) === p.expect) && shownForEntity(spec, e.name, c.name));
    },
    // アプリ全体の集計の値が expect で、ダッシュボードの部品（widgets の種類）に出ている
    scopeOnDashboard: (a) => {
      const scope = engine.evaluateScope({ app, clock, sources: sourcesFor(a.sources) });
      return Object.entries(scope).some(([n, v]) => v === a.expect && shownOnDashboard(spec, n, a.widgets));
    },
    // 見出しごとの集計（groupBy）がダッシュボードの部品に出ている
    groupChart: (a) => {
      const src = ent(a.source).name;
      return spec.computed.some((c) => {
        const g = c.aggregate;
        if (!g || g.groupBy === undefined || g.entity !== src || g.groupBy.field !== B[a.groupBy].name || g.groupBy.month !== a.month) return false;
        if (a.last !== undefined && g.last !== a.last) return false;
        if (a.aggKind !== undefined && g.kind !== a.aggKind) return false;
        if (a.value !== undefined && g.name !== B[a.value].name) return false;
        return shownOnDashboard(spec, c.name, a.widgets);
      });
    },
    // ボードの highlight が指す計算が、trueOn の日付で真・falseOn で偽（項目は field の役割）
    highlight: (a) => {
      const f = B[a.field], owner = f.entity;
      const ownerRole = Object.keys(B).find((k) => B[k].name === owner && B[k].fields);
      const boards = spec.views.filter((v) => v.type === "board" && v.entity === owner && v.highlight);
      return boards.some((bd) => {
        const hl = spec.computed.find((c) => c.entity === owner && c.name === bd.highlight);
        if (!hl?.expression) return false;
        const on = (d) => engine.holdsExpression({ app, entity: owner, record: recordFor(ent(ownerRole), today, { [f.name]: d, ...setFor(B, a.set) }), clock }, hl.expression);
        return a.trueOn.every(on) && !a.falseOn.some(on);
      });
    },
    // 順位の部品（target の entity）の by が、少ない（fewer）ほど上になっているか。逆向きが 1 つでもあれば偽。required なら部品が無いときも偽
    // 戻り値に written（向きの正しい順位の部品がある）と note（負の数で書いた）を足す
    rankingOrder: (a) => {
      const e = ent(a.target), sources = sourcesFor(a.sources);
      const by = (w, id) => ev(e.name, recordFor(e, today), { recordId: id, sources }).computed[w.by];
      const rankings = widgetsOf(spec).filter((w) => w.type === "ranking" && w.entity === e.name);
      const wrong = rankings.filter((w) => !(by(w, a.fewer) > by(w, a.more)));
      const written = rankings.length > 0 && wrong.length === 0;
      // required：要件が順位の部品そのものを求める（「多い順のランキング」）。部品が無ければ偽。書けない要件（B の「少ない順」）では付けない
      return { ok: wrong.length === 0 && (a.required !== true || rankings.length > 0), written, note: written && rankings.some((w) => by(w, a.more) < 0) ? "少ない順を負の数で書いた（画面に負の数の列が出る）" : "" };
    },
  };
}

function scoreStructure(engine, app, spec, def, st, B) {
  const clock = engine.fixedClock(def.clock ?? "2026-10-08T12:00:00+09:00");
  const today = def.today ?? "2026-10-08";
  const kinds = makeKinds(engine, app, spec, B, clock, today);
  const checks = {}, written = {}, notes = [];
  for (const c of st.checks) {
    let r;
    try { r = kinds[c.kind](c); } catch (err) { r = false; notes.push(`${c.req}: 例外 ${String(err.message ?? err).slice(0, 80)}`); }
    if (typeof r === "object") { checks[c.req] = r.ok; if (c.writes) written[c.writes] = r.written; if (r.note) notes.push(r.note); }
    else checks[c.req] = r;
  }
  return { checks, written, note: notes.join(" / ") };
}

export async function score(engine, file, def) {
  const n = await engine.normalizeSpec(readFileSync(file, "utf8"));
  const base = { file: basename(file), subject: def.id };
  if (!n.ok) return { ...base, verdict: "STATIC_NG", codes: [...new Set(n.diagnostics.map((d) => d.code))], structure: null, checks: {}, written: {}, note: "", requiresClaim: false };
  const app = n.app, spec = app.spec;
  let best = null;
  for (const [i, st] of def.structures.entries()) {
    for (const B of bindRoles(spec, st.roles)) {
      const r = scoreStructure(engine, app, spec, def, st, B);
      const passed = Object.values(r.checks).filter(Boolean).length;
      // 主の構造（0 番目）を優先し、同じ構造の中では満たした要件の多い当てはめを採る
      if (!best || passed > best.passed || (passed === best.passed && i < best.index)) best = { ...r, passed, index: i, st };
    }
    if (best && best.index === 0 && best.passed === def.structures[0].checks.length) break;
  }
  if (!best) {
    const total = def.structures[0].checks.length;
    return { ...base, verdict: "FAIL", codes: [], structure: null, checks: { 役割が見つかる: false }, written: {}, note: "", requiresClaim: false, fulfilled: 0, writable_total: total };
  }
  const failed = Object.values(best.checks).filter((ok) => !ok).length;
  const requiresClaim = best.index > 0; // 決定②：別の構造は、書けない要件を正しく申告したときだけ合格
  const verdict = failed > 0 ? "FAIL" : requiresClaim ? "PASS_NEEDS_CLAIM" : "PASS";
  return { ...base, verdict, codes: [], structure: best.st.id, checks: best.checks, written: best.written, note: best.note, requiresClaim, fulfilled: best.passed, writable_total: best.st.checks.length };
}

export const loadDef = (path) => JSON.parse(readFileSync(path, "utf8"));
